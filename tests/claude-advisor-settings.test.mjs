// 顾问连接（Claude 顾问）的设置选项：与拓展坞接入模型保持一致——预置服务商、名称、模型列表、
// 推理强度、推理协议、图片输入和启用，且每一项都必须真的生效，不能只是界面上摆着。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { loadConfig, saveSettings } from '../src/config.mjs';
import { TOOLS } from '../src/tools.mjs';
import { claudeReady, claudeReasoning, askClaude, advisorEndpointCandidates } from '../src/claude.mjs';
import { Roster } from '../src/roster.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

function fixture(t, extra = {}) {
  const root = cleanup(t, tempDir('advisor'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ workspace: root, ...extra }));
  fs.writeFileSync(path.join(root, 'secrets.local.json'), JSON.stringify({ token: 'test-token', claudeApiKey: 'sk-advisor-test-key' }));
  return loadConfig(root);
}

// 本地假站点：既能列模型，也能流式回一句，并把收到的请求体原样记下来。
async function fakeSite() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-4-5' }] })); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ model: JSON.parse(body).model, choices: [{ delta: { content: 'OK' } }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { seen, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

function toolsFixture(t, extra = {}) {
  const o = { config: fixture(t, extra), models: { validate: async () => {}, validateEffort: async () => {} }, roster: { markUp() {}, markDown() {} }, store: { event() {} } };
  const svc = { reload(c) { o.config = c; } };
  return { o, svc };
}

test('顾问的每个选项都能保存并读回，非法值被拒且不写盘', async t => {
  const { o, svc } = toolsFixture(t);
  const first = await TOOLS.settings_set.run(o, { claude: { name: '小顾', baseUrl: 'https://relay.example/v1', model: 'claude-opus-5-5', protocol: 'openai', enabled: false, vision: false,
    reasoningConfig: { protocol: 'reasoning-effort', models: ['claude-opus-5-5'], levels: ['low', 'high'] }, defaultEffort: 'high' } }, 'user', svc);
  assert.equal(first.ok, undefined);   // settings_set 直接返回 settingsView
  const view = await TOOLS.settings_get.run(o, {});
  assert.equal(view.claude.name, '小顾');
  assert.equal(view.claude.enabled, false);
  assert.equal(view.claude.vision, false);
  assert.equal(view.claude.defaultEffort, 'high');
  assert.equal(view.claude.reasoningConfig.protocol, 'reasoning-effort');
  assert.deepEqual(view.claude.reasoningConfig.models, ['claude-opus-5-5']);
  assert.equal(view.claude.protocol, 'openai');
  assert.equal(claudeReady(o.config), false, '停用后就不再是"可用顾问"');
  assert.equal(claudeReasoning(o.config).status, 'supported');

  const before = fs.readFileSync(o.config.configFile, 'utf8');
  const rejected = [
    { name: '' },
    { name: 'x'.repeat(41) },
    { baseUrl: 'relay.example/v1' },
    { model: 'x'.repeat(201) },
    { protocol: 'grpc' },
    { enabled: 'yes' },
    { defaultEffort: 'max' },
    { reasoningConfig: { protocol: 'thinking', models: ['claude-opus-5-5'], levels: ['ultra'] } },
  ];
  for (const claude of rejected) {
    await assert.rejects(() => TOOLS.settings_set.run(o, { claude }, 'user', svc), undefined, JSON.stringify(claude));
    assert.equal(fs.readFileSync(o.config.configFile, 'utf8'), before, '非法顾问设置不能落盘：' + JSON.stringify(claude));
  }

  // 中转站的模型名可能带空格（客户线上就是「Gemini 4」）：不能因为多了空格就保存不了。
  // 换模型会让原来声明过的强度失效，所以这条用一个没有强度声明的配置来验。
  const plain = toolsFixture(t).o;
  const spaced = await TOOLS.settings_set.run(plain, { claude: { model: 'Gemini 4' } }, 'user', { reload() {} });
  assert.equal(spaced.claude.model, 'Gemini 4');
  // 声明过的强度绑在模型上：换到不匹配的模型时必须明确报错，不能悄悄按旧强度发出去。
  await assert.rejects(() => TOOLS.settings_set.run(o, { claude: { model: 'Gemini 4' } }, 'user', svc), /重选|不支持|未知/);
});

test('清除推理强度与推理声明写回 null，不再强制发参数', async t => {
  const { o, svc } = toolsFixture(t);
  await TOOLS.settings_set.run(o, { claude: { reasoningConfig: { protocol: 'reasoning-effort', models: ['claude-opus-5-5'], levels: ['high'] }, defaultEffort: 'high' } }, 'user', svc);
  assert.equal(o.config.claude.defaultEffort, 'high');
  const view = await TOOLS.settings_set.run(o, { claude: { reasoningConfig: null, defaultEffort: null } }, 'user', svc);
  assert.equal(view.claude.defaultEffort, null);
  assert.equal(view.claude.reasoningConfig, null);
  assert.equal(claudeReasoning(o.config).status, 'unknown');
});

test('顾问停用后名册显示已暂停，并且不再被选为顾问', () => {
  const store = { get: () => ({}), set() {}, event() {} };
  const base = { secrets: { claudeApiKey: 'sk-x' }, dock: [], claude: { enabled: true, baseUrl: 'https://relay.example/v1', model: 'claude-opus-5-5' } };
  const on = new Roster({ config: base, store, agents: {} });
  assert.equal(on.state('claude').status, 'online');
  assert.equal(on.candidates('advisor', 'think')[0], 'claude');
  const off = new Roster({ config: { ...base, claude: { ...base.claude, enabled: false } }, store, agents: {} });
  assert.equal(off.state('claude').status, 'paused');
  assert.equal(off.state('claude').paused, true);
  assert.ok(!off.candidates('advisor', 'think').includes('claude'), '停用的顾问不能被叫去裁决');
});

function healthStore(initial) {
  let health = initial;
  return { get: key => (key === 'health' ? health : {}), set(key, value) { if (key === 'health') health = value; }, event() {} };
}
const advisorConfig = { secrets: { claudeApiKey: 'sk-x' }, dock: [], claude: { enabled: true, baseUrl: 'https://relay.example/v1', model: 'claude-opus-5-5' } };

test('顾问连接一改，旧配置的失败记录就不再压着它（和拓展坞同一条规则）', () => {
  const store = healthStore({ claude: { requiresAction: true, reason: '接口测试失败', detail: 'HTTP 403', configKey: 'old-config' } });
  const roster = new Roster({ config: advisorConfig, store, agents: {} });
  assert.equal(roster.state('claude').status, 'online', '换了连接就不该继续按旧失败判定离线');
});

test('升级前留下的顾问失败记录会被清掉，客户手动暂停保留', () => {
  const failing = healthStore({ claude: { requiresAction: true, reason: '接口测试失败', detail: 'HTTP 403' } });
  const roster = new Roster({ config: advisorConfig, store: failing, agents: {} });
  assert.equal(roster.state('claude').status, 'online');
  assert.equal(failing.get('health').claude, undefined);

  const paused = healthStore({ claude: { paused: true } });
  const second = new Roster({ config: advisorConfig, store: paused, agents: {} });
  assert.equal(second.state('claude').status, 'paused');
  assert.equal(paused.get('health').claude.paused, true);
});

test('顾问上次被记成离线后，一次成功的联通测试就能恢复（客户有出口）', () => {
  const health = { claude: { requiresAction: true, reason: '接口测试失败', detail: 'HTTP 403' } };
  const store = { get: key => (key === 'health' ? health : {}), set() {}, event() {} };
  const roster = new Roster({ config: { secrets: { claudeApiKey: 'sk-x' }, dock: [], claude: { enabled: true, baseUrl: 'https://relay.example/v1', model: 'claude-opus-5-5' } }, store, agents: {} });
  assert.equal(roster.state('claude').status, 'offline');
  roster.markUp('claude', null);            // claude_test 成功后走的就是这一步
  assert.equal(roster.state('claude').status, 'online');
  assert.equal(roster.candidates('advisor', 'think')[0], 'claude');
});

test('推理强度按声明真的发出去，未开启图片输入就不发图', async t => {
  const site = await fakeSite(); t.after(() => site.close());
  const { o } = toolsFixture(t);
  const cfg = saveSettings(o.config, { claude: { baseUrl: 'http://127.0.0.1:' + site.port, model: 'claude-opus-5-5', protocol: 'openai', vision: false,
    reasoningConfig: { protocol: 'reasoning-effort', models: ['claude-opus-5-5'], levels: ['low', 'high'] }, defaultEffort: 'high' } });
  const answer = await askClaude(cfg, { prompt: '你好', images: [{ mime: 'image/png', data: 'AAAA', name: 'a.png' }] });
  const call = site.seen.find(s => s.url === '/v1/chat/completions');
  assert.equal(call.body.reasoning_effort, 'high');
  assert.equal(typeof call.body.messages.at(-1).content, 'string', '未开启图片输入时不能偷偷发图');
  assert.match(call.body.messages.at(-1).content, /未开启图片输入/);
  assert.equal(answer.effort, 'high');
  assert.equal(answer.reasoning.parameterAccepted, true);

  // 开启图片输入（默认）时按多模态发送
  const withVision = saveSettings(o.config, { claude: { vision: true } });
  await askClaude(withVision, { prompt: '看图', images: [{ mime: 'image/png', data: 'AAAA', name: 'a.png' }] });
  const second = site.seen.filter(s => s.url === '/v1/chat/completions').at(-1);
  assert.ok(Array.isArray(second.body.messages.at(-1).content), '开启后图片要按多模态内容发送');
});

test('站点地址写根、写 /v1、或把完整接口地址粘进来，都连同一个端点（不会变成 /v1/v1）', async t => {
  // 客户实测 2026-10-17：按拓展坞的提示把地址填成 https://host/v1，旧代码拼出 /v1/v1/chat/completions → 404。
  assert.deepEqual(advisorEndpointCandidates('https://host'), ['https://host/v1/chat/completions', 'https://host/chat/completions']);
  assert.deepEqual(advisorEndpointCandidates('https://host/v1'), ['https://host/v1/chat/completions']);
  assert.deepEqual(advisorEndpointCandidates('https://host/v1/'), ['https://host/v1/chat/completions']);
  assert.deepEqual(advisorEndpointCandidates('https://host/v1/chat/completions'), ['https://host/v1/chat/completions']);
  assert.deepEqual(advisorEndpointCandidates('https://host/api/paas/v4'), ['https://host/api/paas/v4/chat/completions']);
  assert.deepEqual(advisorEndpointCandidates('https://host', 'anthropic'), ['https://host/v1/messages', 'https://host/messages']);
  assert.deepEqual(advisorEndpointCandidates('not-a-url'), []);

  const site = await fakeSite(); t.after(() => site.close());
  const { o } = toolsFixture(t);
  const answer = [];
  for (const suffix of ['', '/v1', '/v1/chat/completions']) {
    const cfg = saveSettings(o.config, { claude: { baseUrl: 'http://127.0.0.1:' + site.port + suffix, model: 'claude-opus-5-5', protocol: 'openai' } });
    answer.push((await askClaude(cfg, { prompt: '你好' })).text);
  }
  assert.deepEqual(answer, ['OK', 'OK', 'OK']);
  const paths = new Set(site.seen.map(s => s.url));
  assert.ok([...paths].every(p => p === '/v1/chat/completions'), '每种写法都必须落到 /v1/chat/completions：' + [...paths].join(', '));
});

test('联通测试也能识别模型列表的正确地址（带 /v1 的写法不再 404）', async t => {
  const site = await fakeSite(); t.after(() => site.close());
  const { o } = toolsFixture(t);
  const cfg = saveSettings(o.config, { claude: { baseUrl: 'http://127.0.0.1:' + site.port + '/v1', model: 'claude-opus-5-5', protocol: 'openai' } });
  const { testClaude } = await import('../src/claude.mjs');
  const r = await testClaude(cfg);
  assert.equal(r.ok, true, r.error);
  assert.ok((r.models || []).includes('claude-opus-5-5'));
});

test('未声明能力的端点不能悄悄挑强度，Anthropic 协议下也不静默丢弃声明', async t => {
  const site = await fakeSite(); t.after(() => site.close());
  const { o } = toolsFixture(t);
  const unknown = saveSettings(o.config, { claude: { baseUrl: 'http://127.0.0.1:' + site.port, model: 'claude-opus-5-5', protocol: 'openai' } });
  assert.equal(claudeReasoning(unknown).status, 'unknown');
  await assert.rejects(() => askClaude(unknown, { prompt: '你好', effort: 'high' }), /推理强度支持未知/);

  const anthropic = saveSettings(o.config, { claude: { protocol: 'anthropic', reasoningConfig: { protocol: 'reasoning-effort', models: ['claude-opus-5-5'], levels: ['high'] }, defaultEffort: 'high' } });
  await assert.rejects(() => askClaude(anthropic, { prompt: '你好' }), /只适用于 OpenAI 兼容协议/);
});

test('顾问连接也能像拓展坞一样列模型，并且默认用已保存的密钥', async t => {
  const site = await fakeSite(); t.after(() => site.close());
  const { o } = toolsFixture(t);
  const listed = await TOOLS.claude_models.run(o, { baseUrl: 'http://127.0.0.1:' + site.port });
  assert.deepEqual(listed.models.map(m => m.id), ['claude-opus-5-5', 'claude-sonnet-4-5']);
  assert.equal(listed.baseUrl, 'http://127.0.0.1:' + site.port + '/v1');
  assert.throws(() => TOOLS.claude_models.run({ config: { claude: { baseUrl: '' }, secrets: {} } }, {}), /请先填写顾问站点地址/);
  await assert.rejects(() => TOOLS.claude_models.run({ config: { claude: { baseUrl: 'https://relay.example/v1' }, secrets: {} } }, {}), /请先填写密钥/);
});

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const between = (start, end) => inline.slice(inline.indexOf(start), inline.indexOf(end, inline.indexOf(start)));

test('顾问设置搬到卡片 ⚙ 弹窗里，选项与拓展坞一致，保存并测试一次完成', () => {
  // 设置面板里不再有顾问输入框（避免两套表单打架），只留一句指路。
  for (const id of ['sPreset', 'sName', 'sBase', 'sKey', 'sFetch', 'sFilter', 'sModels', 'sModel', 'sEffort', 'sReasoningProtocol', 'sProto', 'sVision', 'sEnabled'])
    assert.doesNotMatch(html, new RegExp('id="' + id + '"'), '「设置」里不该再有顾问输入框：' + id);
  assert.match(html, /id="advisorModal"/, '顾问设置要有和拓展坞一样的弹窗');
  for (const id of ['aPreset', 'aName', 'aBase', 'aKey', 'aFetch', 'aFilter', 'aModels', 'aModel', 'aEffort', 'aReasoningProtocol', 'aProto', 'aVision', 'aEnabled'])
    assert.match(html, new RegExp('id="' + id + '"'), '顾问弹窗缺少选项：' + id);
  assert.match(html, /data-advisor="edit"/, 'Claude 卡片要有 ⚙ 入口（和拓展坞卡片一致）');
  assert.match(html, /button\[data-advisor\][\s\S]*openAdvisor\(\)/, '点卡片 ⚙ 要打开顾问设置弹窗');
  assert.match(html, /api\('claude_models'/, '顾问要有「获取这个端点的模型列表」');
  assert.match(html, /api\('claude_reasoning'/, '顾问的推理强度要按端点能力查询');
  assert.match(html, /api\('dock_presets'\)/, '顾问与拓展坞共用同一份预置服务商');
  const save = between('function advisorPayload()', 'async function saveAllSettings');
  for (const field of ['name:', 'baseUrl:', 'model:', 'protocol:', 'enabled:', 'vision:', 'defaultEffort:', 'reasoningConfig:'])
    assert.match(save, new RegExp(field), '保存载荷缺少顾问字段：' + field);
  // 弹窗的「保存并测试」= 先只保存顾问设置，再测联通（和拓展坞同一个按钮语义）。
  const handler = between("$('aSave').onclick =", 'async function testClaudeConnection');
  assert.match(html, /\$\('aSave'\)\.onclick = async/, '弹窗要有「保存并测试」');
  assert.match(html, /api\('settings_set', \{ claude: advisorPayload\(\) \}\)/, '保存只写顾问连接，不覆盖其它设置');
  assert.match(html, /await testAdvisorConnection\(\)/, '保存后自动测试联通');
});

test('Claude 卡片像拓展坞卡片一样下发型号/看图/强度/启用与 ⚙ 入口', () => {
  const store = healthStore({});
  const roster = new Roster({ config: { ...advisorConfig, claude: { ...advisorConfig.claude, name: '小顾', vision: true, defaultEffort: null } }, store, agents: {} });
  const advisor = roster.state('claude').advisor;
  assert.equal(advisor.model, 'claude-opus-5-5');
  assert.equal(advisor.baseUrl, 'https://relay.example/v1');
  assert.equal(advisor.enabled, true);
  assert.equal(advisor.vision, true);
  assert.equal(advisor.name, '小顾');
  const off = new Roster({ config: { ...advisorConfig, claude: { ...advisorConfig.claude, enabled: false } }, store: healthStore({}), agents: {} });
  assert.equal(off.state('claude').advisor.enabled, false);
});

function advisorFixture(overrides = {}) {
  const ids = ['aPreset', 'aHint', 'aBase', 'aName', 'aModel', 'aProto', 'aReasoningProtocol', 'aKey', 'aVision', 'aEnabled', 'aEffort', 'aEffortHint', 'aFilter', 'aModelsBox', 'aCount', 'aModels', 'aFetch', 'aFetchOut', 'aResult', 'aSave', 'aCancel', 'advisorModal'];
  const fields = Object.fromEntries(ids.map(id => [id, { value: '', innerHTML: '', textContent: '', checked: false, disabled: false, hidden: false, placeholder: '', querySelectorAll: () => [], focus() {} }]));
  const context = vm.createContext({ $: id => fields[id] || { value: '', innerHTML: '', textContent: '', checked: false, hidden: false, placeholder: '' }, fields,
    esc: value => String(value ?? ''), clearTimeout, setTimeout, toast() {}, AG: { codex: 'Codex', deepseek: 'DeepSeek', claude: 'Claude' },
    EFFORT: { low: '低', high: '高' }, effortLabel: value => value,
    api: async () => ({ status: 'unknown', supported: false, options: [] }), ...overrides });
  vm.runInContext(between('function dockReasoningOptions(', 'const toolsCap ='), context);
  vm.runInContext(between('// ---------- 顾问连接：和拓展坞接入模型同一套选项 ----------', '// 卡片右上角 ⚙：打开顾问设置'), context);
  vm.runInContext(between('function advisorPayload()', 'async function saveAllSettings'), context);
  return { context, fields };
}

test('顾问显示名保存后，看板卡片立即用新名字', async () => {
  const context0 = advisorFixture({ api: async name => name === 'dock_presets' ? [] : { status: 'unknown', supported: false, options: [] } });
  await context0.context.loadAdvisor({ claude: { name: '小顾', baseUrl: 'https://relay.example/v1', model: 'claude-opus-5-5', protocol: 'auto', defaultEffort: null, apiKey: 'sk-a…b' } });
  assert.equal(context0.context.AG.claude, '小顾');
  assert.equal(context0.fields.aName.value, '小顾');
});

test('顾问强度选项只列后端给的能力，查询失败时保留原来的强度不静默清空', async () => {
  const supported = { status: 'supported', supported: true, options: [{ value: 'auto', label: '服务商默认' }, { value: 'high', label: '高' }] };
  const { context, fields } = advisorFixture({ api: async name => { assert.equal(name, 'claude_reasoning'); return supported; }, SETTINGS: { claude: { defaultEffort: 'high' } } });
  fields.aBase.value = 'https://relay.example/v1'; fields.aModel.value = 'claude-opus-5-5';
  assert.equal(await context.refreshAdvisorReasoning('high'), true);
  assert.equal(fields.aEffort.disabled, false);
  assert.equal(fields.aEffort.value, 'high');

  const failing = advisorFixture({ api: async () => { throw new Error('HTTP 503: capability unavailable'); }, SETTINGS: { claude: { defaultEffort: 'high' } } });
  failing.fields.aBase.value = 'https://relay.example/v1'; failing.fields.aModel.value = 'claude-opus-5-5';
  assert.equal(await failing.context.refreshAdvisorReasoning('high'), false);
  assert.equal(failing.fields.aEffort.value, '');
  assert.equal(failing.context.advisorEffortValue(), 'high', '能力查询失败时必须保留原来的强度，不能静默改成"由接口决定"');
  assert.doesNotMatch(failing.fields.aEffortHint.textContent, /HTTP 503|capability unavailable/);
});
