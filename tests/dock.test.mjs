import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDockModels, chatDock, askDock, saveDockEntry, removeDockEntry, moveDockEntry, dockView, testDock } from '../src/dock.mjs';
import { loadConfig, redact, defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { registerAgentNames } from '../src/prompts.mjs';

// ---- 假的 OpenAI 兼容端点：/v1/models、/v1/chat/completions（流式文本 / 流式工具调用 / 整段 JSON） ----
let server, base; const seen = [];
before(async () => {
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    if (req.headers.authorization !== 'Bearer sk-good-key-123456') { res.writeHead(401); return res.end('{"error":{"message":"invalid api key"}}'); }
    if (req.url === '/v1/models' || req.url === '/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'qwen-max' }, { id: 'qwen-vl-plus' }] })); }
    // 模拟中转站：根路径的对话地址返回网站页面
    if (req.url === '/chat/completions') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><html>中转站首页</html>'); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end('not found'); }
    const j = JSON.parse(body); seen.push(j);
    if (j.model === 'json-only') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ model: 'json-only', choices: [{ message: { content: '整段返回' }, finish_reason: 'stop' }] })); }
    if (j.model === 'broke') { res.writeHead(429); return res.end('{"error":"rate limit"}'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    if (j.tools?.length) {
      send({ model: j.model, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_', arguments: '{"tz":' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'time', arguments: '"Asia/Shanghai"}' } }] }, finish_reason: 'tool_calls' }] });
    } else {
      const last = j.messages.at(-1);
      const hasImage = Array.isArray(last.content) && last.content.some(p => p.type === 'image_url');
      for (const piece of ['你好', hasImage ? '，看到图了' : '，没有图']) send({ model: j.model, choices: [{ delta: { content: piece } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 9 } });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function tmpConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-dock-'));
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  return loadConfig(root);
}

test('模型列表：读 data[]；基础地址缺 /v1 时自动补；密钥错误给出人话', async () => {
  const a = await listDockModels({ baseUrl: base + '/v1', key: 'sk-good-key-123456' });
  assert.deepEqual(a.models.map(m => m.id), ['qwen-max', 'qwen-vl-plus']);
  const b = await listDockModels({ baseUrl: base, key: 'sk-good-key-123456' });
  assert.equal(b.baseUrl, base + '/v1', '没写 /v1 也能找到');
  await assert.rejects(listDockModels({ baseUrl: base + '/v1', key: 'sk-bad' }), /密钥无效/);
});

test('接入可以无限追加；密钥只进 secrets 不进 config；可排序、可移除', async () => {
  let config = tmpConfig();
  const a = saveDockEntry(config, { name: '通义千问', preset: 'qwen', baseUrl: base + '/v1', apiKey: 'sk-good-key-123456', model: 'qwen-max' });
  config = loadConfig(config.root);
  const b = saveDockEntry(config, { name: '通义千问-视觉', preset: 'qwen', baseUrl: base + '/v1', apiKey: 'sk-good-key-123456', model: 'qwen-vl-plus' });
  config = loadConfig(config.root);
  const c = saveDockEntry(config, { name: 'Kimi', preset: 'kimi', baseUrl: base + '/v1', apiKey: 'sk-good-key-123456', model: 'qwen-max' });
  config = loadConfig(config.root);
  assert.deepEqual(config.dock.map(d => d.id), [a.id, b.id, c.id]);
  assert.equal(b.vision, true, '名字带 vl 的默认开启图片');
  assert.doesNotMatch(fs.readFileSync(config.configFile, 'utf8'), /sk-good/);
  assert.match(dockView(config)[0].apiKey, /^sk-go…3456$/);
  assert.equal(redact('key=sk-good-key-123456', config), 'key=[已隐去]');
  // 编辑时不填密钥 = 保留原密钥
  saveDockEntry(config, { id: a.id, name: '通义千问 Max', baseUrl: base + '/v1', model: 'qwen-max' });
  config = loadConfig(config.root);
  assert.equal(config.secrets.dockKeys[a.id], 'sk-good-key-123456');
  moveDockEntry(config, c.id, -1); config = loadConfig(config.root);
  assert.deepEqual(config.dock.map(d => d.id), [a.id, c.id, b.id]);
  removeDockEntry(config, c.id); config = loadConfig(config.root);
  assert.deepEqual(config.dock.map(d => d.id), [a.id, b.id]);
  assert.equal(config.secrets.dockKeys[c.id], undefined);
});

test('对话客户端：流式文本、图片、工具调用（拼接分片）、整段 JSON、限流报错', async () => {
  let config = tmpConfig();
  const e = saveDockEntry(config, { name: 'Q', baseUrl: base + '/v1', apiKey: 'sk-good-key-123456', model: 'qwen-vl-plus' });
  config = loadConfig(config.root);
  const r1 = await askDock(config, e.id, { prompt: '这是什么', images: [{ mime: 'image/png', data: 'AAAA', name: 'a.png' }] });
  assert.equal(r1.text, '你好，看到图了');
  assert.equal(typeof r1.history.at(-2).content, 'string', '历史里只存文字');
  const tool = { type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: {} } } };
  const r2 = await chatDock(config, e.id, { messages: [{ role: 'user', content: '几点' }], tools: [tool] });
  assert.deepEqual(r2.toolCalls, [{ id: 'call_1', name: 'get_time', arguments: '{"tz":"Asia/Shanghai"}' }]);
  assert.equal(r2.message.tool_calls[0].function.name, 'get_time', '返回的 message 可直接接回对话（给以后的电脑助手用）');
  const r3 = await chatDock(config, e.id, { messages: [{ role: 'user', content: 'x' }], model: 'json-only' });
  assert.equal(r3.text, '整段返回');
  await assert.rejects(chatDock(config, e.id, { messages: [{ role: 'user', content: 'x' }], model: 'broke' }), /限流/);
});

test('中转站地址少了 /v1：列表直接给出 /v1 地址；对话自动补 /v1 并改正保存', async () => {
  const l = await listDockModels({ baseUrl: base, key: 'sk-good-key-123456' });
  assert.equal(l.baseUrl, base + '/v1');
  let config = tmpConfig();
  const e = saveDockEntry(config, { name: '中转', baseUrl: base, apiKey: 'sk-good-key-123456', model: 'qwen-max' });
  config = loadConfig(config.root);
  const r = await chatDock(config, e.id, { messages: [{ role: 'user', content: 'hi' }] });
  assert.match(r.text, /你好/);
  assert.equal(loadConfig(config.root).dock[0].baseUrl, base + '/v1', '改正后的地址已保存');
});

test('联通测试：列模型 + 实发一句 + 工具调用能力', async () => {
  let config = tmpConfig();
  const e = saveDockEntry(config, { name: 'Q', baseUrl: base + '/v1', apiKey: 'sk-good-key-123456', model: 'qwen-max' });
  config = loadConfig(config.root);
  const r = await testDock(config, e.id);
  assert.equal(r.ok, true); assert.equal(r.modelCount, 2); assert.equal(r.tools, 'supported');
});

test('搭档不可用时由其他可用搭档代答，卡片排列不决定执行等级', async () => {
  let config = tmpConfig();
  const a = saveDockEntry(config, { name: '甲', baseUrl: base + '/v1', apiKey: 'sk-good-key-123456', model: 'qwen-max' });
  config = loadConfig(config.root);
  const b = saveDockEntry(config, { name: '乙', baseUrl: base + '/v1', apiKey: 'sk-good-key-123456', model: 'qwen-max' });
  config = { ...loadConfig(config.root), skipAcl: true };
  config.secrets.claudeApiKey = '';                          // Claude 未配置
  registerAgentNames(config.dock);
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  const calls = [];
  const turn = s => ({ text: '```json\n' + JSON.stringify({ stance: s, summary: s, open_issues: [] }) + '\n```' });
  const agents = {
    codex: async () => { throw new Error('You have hit your usage limit'); },
    deepseek: async () => turn('agree'),
    claude: async () => { throw new Error('不应调用'); },
    dock: async (id, o) => { calls.push(id); if (id === a.id) throw new Error('甲：限流或额度用尽'); return o.prompt.includes('最终结论') ? { text: '结论', history: [] } : { ...turn('open'), history: [] }; },
  };
  config.flow.compactDiscussion=false; config.flow.pullQueue=false; // persisted legacy fallback coverage
  const orch = new Orchestrator({ config, store, agents, models: { default: p => ({ codex: 'gpt', deepseek: 'ds' }[p] || null), defaultEffort: () => null, store: null } });
  const run = orch.startDiscuss({ question: '用 A 还是 B' });
  for (let i = 0; i < 200 && !orch.isFinal(store.run(run.id).state); i++) await new Promise(r => setTimeout(r, 20));
  const steps = store.steps(run.id);
  assert.equal(store.run(run.id).state, 'done', store.run(run.id).error || '');
  assert.ok([b.id,'deepseek'].includes(steps[0].agent));
  assert.equal(steps[0].data.ownVote,false,'代答不能冒充 Codex 批准');
  assert.ok(calls.includes(a.id)&&calls.includes(b.id),'两位拓展坞都有独立讨论席位');
  assert.equal(orch.roster.state(a.id).status, 'cooldown');
  assert.ok(orch.roster.status()[b.id]?.dock, '状态里能看到拓展坞成员');
  store.close();
});
