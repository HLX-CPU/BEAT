// 拓展坞流式调用的失败分类：区分「卡住」「有输出但被截断」「只给推理没有答案」。
// 目的：推理型模型（如 glm-5.3 开高推理强度）把钱花在推理上却没给出答案时，BEAT 不能自动重试，
// 否则每次都重新发一遍完整请求，白烧额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chatDock } from '../src/dock.mjs';

const startServer = handler => new Promise(resolve => {
  const srv = http.createServer(handler);
  srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }));
});
const sse = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
// flushHeaders：Node 默认会缓冲响应头，不刷出去客户端会以为「连不上」而不是「连上了但没数据」。
const sseHeaders = res => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders?.(); };
const configFor = base => ({ dock: [{ id: 'dock:t', name: '测试模型', model: 'test-model', baseUrl: base, maxTokens: 128, enabled: true }], secrets: { dockKeys: { 'dock:t': 'k' } } });

test('持续只有推理输出、随后卡住：报「已收到推理内容」，且标记不可重试', async () => {
  const { srv, base } = await startServer((req, res) => {
    sseHeaders(res);
    sse(res, { model: 'test-model', choices: [{ delta: { reasoning_content: '嗯…'.repeat(200) } }] });
    // 之后不再发任何数据，模拟推理中卡死
  });
  try {
    await assert.rejects(
      () => chatDock(configFor(base), 'dock:t', { messages: [{ role: 'user', content: 'hi' }], stallSec: 1, firstTokenSec: 5, timeoutSec: 30 }),
      e => {
        assert.equal(e.code, 'ABORTED_AFTER_OUTPUT', '要区分「有输出被截断」');
        assert.equal(e.nonRetryable, true, '已经花掉输出预算 → 不能自动重试');
        assert.match(e.message, /卡住|整体超时/, '要说清楚是卡住还是超时');
        assert.ok(e.spentReasoningChars > 0, '要报告已收到的推理内容长度');
        return true;
      });
  } finally { srv.close(); }
});

test('一个字都没收到：算可重试的传输故障', async () => {
  const { srv, base } = await startServer((req, res) => { sseHeaders(res); /* 什么都不发 */ });
  try {
    await assert.rejects(
      () => chatDock(configFor(base), 'dock:t', { messages: [{ role: 'user', content: 'hi' }], firstTokenSec: 1, stallSec: 30, timeoutSec: 30 }),
      e => {
        assert.equal(e.code, 'ABORTED_NO_OUTPUT');
        assert.equal(e.nonRetryable, false, '没花钱的失败可以重试');
        assert.match(e.message, /首字超时|卡住/);
        return true;
      });
  } finally { srv.close(); }
});

test('只返回推理内容、正常结束：报空答且不可重试', async () => {
  const { srv, base } = await startServer((req, res) => {
    sseHeaders(res);
    sse(res, { model: 'test-model', choices: [{ delta: { reasoning_content: '想了很久' } }] });
    sse(res, { model: 'test-model', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 500, total_tokens: 510 } });
    res.write('data: [DONE]\n\n'); res.end();
  });
  try {
    await assert.rejects(
      () => chatDock(configFor(base), 'dock:t', { messages: [{ role: 'user', content: 'hi' }], stallSec: 5, firstTokenSec: 5, timeoutSec: 30 }),
      e => {
        assert.equal(e.code, 'EMPTY_API_RESPONSE');
        assert.equal(e.nonRetryable, true, '输出预算已经花完 → 不能自动重试');
        assert.match(e.message, /只返回了推理内容/);
        assert.equal(e.usage.total_tokens, 510, '要把用量带出来，方便统计花了多少钱');
        return true;
      });
  } finally { srv.close(); }
});
