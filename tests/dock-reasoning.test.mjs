import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dockReasoning, reasoningChoices, validateDockEffort, chatDock, askDock, saveDockEntry, dockView } from '../src/dock.mjs';
import { loadConfig } from '../src/config.mjs';
import { Roster } from '../src/roster.mjs';

let server, base;
const requests = [];
before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    if (['reasoning only length', 'empty json stop', 'empty json length'].includes(body.messages.at(-1).content)) {
      const content = body.messages.at(-1).content, stream = content === 'reasoning only length';
      res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
      const payload = { model: body.model, usage: { completion_tokens: 32, completion_tokens_details: { reasoning_tokens: stream ? 32 : 0 } },
        choices: [{ ...(stream ? { delta: { reasoning_content: 'do-not-leak-private-reasoning' } } : { message: { content: '' } }), finish_reason: content === 'empty json stop' ? 'stop' : 'length' }] };
      return res.end(stream ? 'data: '+JSON.stringify(payload)+'\n\ndata: [DONE]\n\n' : JSON.stringify(payload));
    }
    if (body.messages.at(-1).content === 'stream missing') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
    if (body.messages.at(-1).content === 'stream reasoning') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: '+JSON.stringify({ model: body.model, choices: [{ delta: { reasoning_content: 'opaque-block', tool_calls: [{ index: 0, id: 'c1', function: { name: 'check', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })+'\n\ndata: [DONE]\n\n');
    }
    if (['stream wrong', 'stream switched'].includes(body.messages.at(-1).content)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: '+JSON.stringify({ model: 'other-model', choices: [{ delta: { tool_calls: [{ index: 0, id: 'wrong', function: { name: 'key_press', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })+'\n\n'+(body.messages.at(-1).content === 'stream switched' ? 'data: '+JSON.stringify({ model: body.model, choices: [{ delta: {}, finish_reason: 'tool_calls' }] })+'\n\n' : '')+'data: [DONE]\n\n');
    }
    const content = body.messages.at(-1).content;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...(content === 'missing model' ? {} : { model: content === 'wrong model' ? 'other-model' : body.model }),
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => server.close());

const configFor = (extra = {}) => ({ dock: [{ id: 'dock:test', name: 'Test', model: 'glm-5.3', baseUrl: base, ...extra }], secrets: { dockKeys: { 'dock:test': 'fixture-key' } } });
const send = (config, effort, content = 'ping') => chatDock(config, 'dock:test', { messages: [{ role: 'user', content }], effort });

test('GLM 官方文档能力按真实端点和精确型号生效，中转网关只给候选', () => {
  const official = reasoningChoices({ model: 'glm-5.3', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' });
  assert.equal(official.status, 'supported'); assert.equal(official.evidenceStatus, 'documented');
  assert.deepEqual(official.options.map(o => o.value), ['auto', 'low', 'high', 'max']);
  assert.equal(official.providerDefault, 'max'); assert.equal(official.effectVerified, false);
  const gateway = reasoningChoices({ model: 'glm-5.3', preset: 'glm', baseUrl: 'https://gateway.example/v1' });
  assert.equal(gateway.status, 'unknown'); assert.equal(gateway.supported, null);
  assert.deepEqual(gateway.options.map(o => o.value), ['auto']);
  assert.deepEqual(gateway.candidate.levels, ['low', 'high', 'max']);
});

test('未知端点与不支持型号拒绝强度而不发送请求，auto明确保留服务商默认', async () => {
  const config = configFor(), count = requests.length;
  await assert.rejects(send(config, 'max'), /支持未知/);
  assert.equal(requests.length, count);
  await send(config, 'auto');
  assert.equal(requests.at(-1).reasoning_effort, undefined); assert.equal(requests.at(-1).thinking, undefined);
  const unsupported = configFor({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' });
  assert.equal(dockReasoning(unsupported, 'dock:test').status, 'unsupported');
  assert.throws(() => validateDockEffort(unsupported, 'dock:test', 'high'), /不支持/);
});

test('GLM 指定强度写入真实body，本次设置覆盖默认，auto不发参数', async () => {
  const config = configFor({ defaultEffort: 'high', reasoningConfig: { protocol: 'glm', models: ['glm-5.3'] } });
  await send(config, undefined);
  assert.equal(requests.at(-1).reasoning_effort, 'high'); assert.deepEqual(requests.at(-1).thinking, { type: 'enabled' });
  const result = await askDock(config, 'dock:test', { prompt: 'ping', effort: 'low' });
  assert.equal(requests.at(-1).reasoning_effort, 'low'); assert.equal(result.effort, 'low');
  assert.equal(result.reasoning.parameterAccepted, true); assert.equal(result.reasoning.effectVerified, false);
  assert.equal(result.reasoning.evidenceStatus, 'declared');
  await send(config, 'auto'); assert.equal(requests.at(-1).reasoning_effort, undefined);
  const count = requests.length;
  await assert.rejects(send(config, 'off'), /不支持推理强度/);
  await assert.rejects(send(config, 'ultra'), /不支持推理强度/);
  assert.equal(requests.length, count);
});

test('DeepSeek、开关型与兼容effort协议分别映射，不把强度当开关', async () => {
  let config = configFor({ model: 'deepseek-v4-pro', reasoningConfig: { protocol: 'deepseek' } });
  await send(config, 'off'); assert.deepEqual(requests.at(-1).thinking, { type: 'disabled' }); assert.equal(requests.at(-1).reasoning_effort, undefined);
  await send(config, 'max'); assert.deepEqual(requests.at(-1).thinking, { type: 'enabled' }); assert.equal(requests.at(-1).reasoning_effort, 'max');
  config = configFor({ model: 'kimi-k2.5', reasoningConfig: { protocol: 'thinking' } });
  await send(config, 'on'); assert.deepEqual(requests.at(-1).thinking, { type: 'enabled' }); assert.equal(requests.at(-1).reasoning_effort, undefined);
  await assert.rejects(send(config, 'high'), /不支持推理强度/);
  config = configFor({ model: 'qwen-plus', reasoningConfig: { protocol: 'enable-thinking' } });
  await send(config, 'off'); assert.equal(requests.at(-1).enable_thinking, false); assert.equal(requests.at(-1).thinking, undefined);
  config = configFor({ model: 'kimi-k3', reasoningConfig: { protocol: 'reasoning-effort', levels: ['low', 'high', 'max'] } });
  await send(config, 'high'); assert.equal(requests.at(-1).reasoning_effort, 'high'); assert.equal(requests.at(-1).thinking, undefined);
});

test('能力声明只适用明确型号，未知协议与非法levels拒绝', () => {
  const input = { baseUrl: base, model: 'glm-5.3', reasoningConfig: { protocol: 'glm', models: ['glm-5.2'], levels: ['high', 'max'] } };
  assert.equal(reasoningChoices(input).status, 'unknown');
  assert.throws(() => reasoningChoices({ ...input, reasoningConfig: { protocol: 'made-up' } }), /不支持的推理控制协议/);
  assert.throws(() => reasoningChoices({ ...input, reasoningConfig: { protocol: 'thinking', levels: ['high'] } }), /不符合/);
  const config = configFor({ reasoningConfig: { protocol: 'glm' } });
  assert.throws(() => validateDockEffort(config, 'dock:test', 'high', 'glm-future'), /支持未知/);
  const oldModel = configFor({ model: 'glm-5.2', reasoningConfig: { protocol: 'glm', models: ['glm-5.2'], levels: ['off', 'high', 'max'] } });
  assert.equal(dockReasoning(oldModel, 'dock:test', 'glm-5.3').status, 'unknown', '旧型号关闭选项不能应用到新型号');
  assert.throws(() => reasoningChoices({ ...input, reasoningConfig: { protocol: 'glm', models: ['glm-5.2', 'glm-5.3'], levels: ['off'] } }), /不符合/);
});

test('回报缺模型或换模型都不拿请求型号冒充已验证，JSON与流式一致', async () => {
  const config = configFor();
  for (const content of ['missing model', 'stream missing']) {
    const result = await send(config, 'auto', content);
    assert.equal(result.requestedModel, 'glm-5.3'); assert.equal(result.actualModel, null); assert.equal(result.model, null);
    assert.equal(result.modelVerified, 'unknown'); assert.equal(result.modelEvidence.status, 'missing');
  }
  for (const content of ['wrong model', 'stream wrong', 'stream switched']) await assert.rejects(send(config, 'auto', content), e => {
    assert.equal(e.actualModel, 'other-model'); assert.equal(e.requestedModel, 'glm-5.3'); assert.equal(e.modelError, true); assert.equal(e.modelEvidence.status, 'mismatch');
    return /模型不匹配/.test(e.message);
  });
  const matched = await send(config, 'auto'); assert.equal(matched.modelVerified, 'verified'); assert.equal(matched.modelEvidence.status, 'matched');
});

test('API 型号证据进入既有 Roster 合约后仍保留 verified 和 actualModel', async () => {
  const config = { ...configFor(), flow: { cooldownMin: 30 } };
  const values = new Map(); const store = { get: k => values.get(k), set: (k, v) => values.set(k, v), event: () => {} };
  const roster = new Roster({ config, store, agents: { dock: (id, args) => askDock(config, id, args) } });
  const result = await roster.call({ runId: 'fixture', seat: 'dock:test', sessions: {}, build: () => 'ping' });
  assert.equal(result.modelVerified, 'verified'); assert.equal(result.actualModel, 'glm-5.3'); assert.equal(result.modelEvidence.status, 'matched');
});

test('流式工具调用保留服务商返回的推理字段供下一轮原样回传', async () => {
  const result = await send(configFor(), 'auto', 'stream reasoning');
  assert.equal(result.message.reasoning_content, 'opaque-block'); assert.equal(result.message.tool_calls[0].function.name, 'check');
  assert.equal(result.text, '');
});

test('仅推理预算耗尽和 JSON 空答保留结构化诊断，不泄露推理内容或自动重试', async () => {
  const config = configFor(), before = requests.length;
  for (const content of ['reasoning only length', 'empty json stop', 'empty json length']) await assert.rejects(send(config, 'auto', content), e => {
    const ev = e.apiResponseEvidence;
    assert.equal(ev.model, 'glm-5.3'); assert.equal(ev.contentLength, 0); assert.equal(ev.toolCallsCount, 0); assert.equal(ev.maxTokens, 8192);
    assert.equal(ev.usage.completion_tokens, 32); assert.equal(ev.finishReason, content === 'empty json stop' ? 'stop' : 'length');
    assert.equal(e.code, content === 'empty json stop' ? 'EMPTY_API_RESPONSE' : 'OUTPUT_BUDGET_EXHAUSTED');
    assert.equal(ev.reasoningOutputSeen, content === 'reasoning only length');
    if (content === 'reasoning only length') { assert.match(e.message, /预算耗尽.*只返回了推理内容/); assert.ok(ev.reasoningContentLength > 0); }
    else assert.match(e.message, content === 'empty json stop' ? /接口返回空答/ : /预算耗尽/);
    assert.doesNotMatch(JSON.stringify(ev)+e.message, /do-not-leak-private-reasoning|fixture-key|authorization/);
    return true;
  });
  assert.equal(requests.length - before, 3, '每个失败请求恰好一次，不自动降强度或重试');
});

test('保存与回读保留能力声明和默认强度，密钥不进入普通配置或能力view', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-dock-reasoning-'));
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  let config = loadConfig(root);
  const entry = saveDockEntry(config, { name: 'Gateway', model: 'glm-5.3', baseUrl: base, apiKey: 'fixture-private-key',
    defaultEffort: 'low', reasoningConfig: { protocol: 'glm', models: ['glm-5.3'], source: 'https://docs.z.ai/api-reference/llm/chat-completion' } });
  config = loadConfig(root);
  const view = dockView(config)[0];
  assert.equal(view.defaultEffort, 'low'); assert.equal(view.reasoning.status, 'supported'); assert.equal(view.reasoning.evidenceStatus, 'declared');
  assert.deepEqual(view.reasoningConfig.levels, ['low', 'high', 'max']);
  assert.doesNotMatch(fs.readFileSync(config.configFile, 'utf8'), /fixture-private-key/);
  assert.doesNotMatch(JSON.stringify(view.reasoning), /fixture-private-key/);
  saveDockEntry(config, { id: entry.id, name: 'Edited', model: 'glm-5.3', baseUrl: base }); config = loadConfig(root);
  assert.equal(config.dock[0].defaultEffort, 'low'); assert.equal(config.secrets.dockKeys[entry.id], 'fixture-private-key');
  assert.throws(() => saveDockEntry(config, { id: entry.id, name: 'Invalid', model: 'glm-5.3', baseUrl: base, defaultEffort: 'off' }), /不支持推理强度/);
  assert.equal(loadConfig(root).dock[0].name, 'Edited', '非法修改不应写入配置');
  saveDockEntry(config, { id: entry.id, name: 'Auto', model: 'glm-5.3', baseUrl: base, defaultEffort: 'auto', reasoningConfig: null });
  assert.equal(dockView(loadConfig(root))[0].reasoning.status, 'unknown');
});
