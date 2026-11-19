import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenAICompatibleController, LOCAL_CONTROLLER_DEFAULTS, apiEndpoint, controllerCandidates, modelMatches, normalizeLocalControllerConfig, resolveController } from '../src/local-controller.mjs';
import { TOOLS } from '../src/tools.mjs';
import { loadConfig } from '../src/config.mjs';

const decision = (extra = {}) => ({
  schemaVersion: 1, taskType: 'execution',
  risk: { level: 'low', reasons: ['bounded file task'], irreversible: false, money: false, computerInput: false },
  flow: { kind: 'parallel', maxDebates: 1, maxRounds: 2, maxParallelTasks: 2 },
  assignees: { strong: 'codex', cheap: ['deepseek'] },
  budget: { discussionTokens: 2000, executionTokens: 4000, taskTokens: 3000 },
  requiresHuman: false, confidence: 0.9, reasons: ['small and reversible'], ...extra,
});

test('默认来源是本地 DS；中转站 API 必须同时给地址和模型', () => {
  const cfg = normalizeLocalControllerConfig();
  assert.equal(cfg.provider, 'auto');
  assert.equal(cfg.apiBaseUrl, '');
  assert.equal(cfg.apiModel, '');
  assert.throws(() => normalizeLocalControllerConfig({ provider: 'api' }), /站点地址/);
  assert.throws(() => normalizeLocalControllerConfig({ provider: 'api', apiBaseUrl: 'https://relay.example.com/v1' }), /模型 ID/);
  assert.throws(() => normalizeLocalControllerConfig({ provider: 'api', apiBaseUrl: 'ftp://relay', apiModel: 'm' }), /http/);
  assert.throws(() => normalizeLocalControllerConfig({ provider: 'other' }), /来源/);
});

test('端点拼接：站点根自动补 /v1，已带版本段不重复', () => {
  assert.equal(apiEndpoint('https://relay.example.com', '/chat/completions'), 'https://relay.example.com/v1/chat/completions');
  assert.equal(apiEndpoint('https://relay.example.com/v1', '/models'), 'https://relay.example.com/v1/models');
  assert.equal(apiEndpoint('https://relay.example.com/api/v1/', '/models'), 'https://relay.example.com/api/v1/models');
});

test('模型名容错：日期后缀/厂商前缀算同一模型，陌生模型仍能发现', () => {
  assert.equal(modelMatches('gpt-4o-mini-2024-07-18', 'gpt-4o-mini'), true);
  assert.equal(modelMatches('openai/gpt-4o-mini', 'gpt-4o-mini'), true);
  assert.equal(modelMatches('deepseek-chat', 'gpt-4o-mini'), false);
});

test('显式选「本地 DS」时绝不静默切到中转站（即使已经配好 API）', async () => {
  const cfg = normalizeLocalControllerConfig({ provider: 'local', apiBaseUrl: 'https://relay.example.com/v1', apiModel: 'gpt-4o-mini' });
  let apiTouched = false;
  const fetchImpl = async url => { if (String(url).includes('relay.example.com')) apiTouched = true; throw new Error('local down'); };
  const r = await resolveController(cfg, { secrets: { controllerApiKey: 'k' }, fetchImpl });
  assert.equal(r.backend, 'local', '客户选了本地就必须用本地，失败也只报本地不可用');
  const health = await r.controller.health();
  assert.equal(health.online, false);
  assert.equal(apiTouched, false, '不能偷偷请求中转站');
});

test('显式选「中转站 API」时只访问 API，不探测本机 Ollama', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { status: 200 });
  };
  const cfg = normalizeLocalControllerConfig({ provider: 'api', apiBaseUrl: 'https://relay.example.com', apiModel: 'gpt-4o-mini' });
  const r = await resolveController(cfg, { secrets: { controllerApiKey: 'k' }, fetchImpl });
  assert.equal(r.backend, 'api');
  const health = await r.controller.health();
  assert.equal(health.online, true);
  assert.equal(health.modelReady, true);
  assert.ok(urls.every(u => u.startsWith('https://relay.example.com/v1/')), '不应访问本机 Ollama：' + urls.join(','));
});

test('旧配置（auto）两个来源都有时：本机不可用才用 API，且不需要训练即可接管', async () => {
  const cfg = normalizeLocalControllerConfig({ provider: 'auto', apiBaseUrl: 'https://relay.example.com/v1', apiModel: 'gpt-4o-mini' });
  const r = await resolveController(cfg, { secrets: { controllerApiKey: 'k' }, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(r.backend, 'api');
  // 完整接管模式：低风险决策直接采纳（安全门由代码做），没有训练门槛
  const { localDecisionPolicy } = await import('../src/local-controller.mjs');
  const policy = localDecisionPolicy(decision(), { mode: 'full', runKind: 'parallel', partners: ['codex', 'deepseek'], currentFlow: { discussionTokenBudget: 1000, executionTokenBudget: 2000, taskTokenBudget: 1000, discussionMaxDebates: 3, maxRounds: 5, maxParallelTasks: 3 } });
  assert.equal(policy.applied, true);
});

test('API 控制器：POST /v1/chat/completions，带密钥，返回严格 JSON 决策并容忍模型别名', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization };
    return new Response(JSON.stringify({ model: 'gpt-4o-mini-2024-07-18', choices: [{ message: { content: JSON.stringify(decision()) }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 22 } }), { status: 200 });
  };
  const ctl = new OpenAICompatibleController({ apiBaseUrl: 'https://relay.example.com/v1', apiModel: 'gpt-4o-mini', timeoutSec: 30, apiKey: 'k' }, { fetchImpl, now: () => 10 });
  const out = await ctl.decide({ goal: '做一个验证过的文件', availablePartners: ['codex', 'deepseek'] });
  assert.equal(sent.url, 'https://relay.example.com/v1/chat/completions');
  assert.equal(sent.auth, 'Bearer k');
  assert.equal(sent.body.model, 'gpt-4o-mini');
  assert.equal(sent.body.response_format.type, 'json_object');
  assert.equal(out.proposal.taskType, 'execution');
  assert.equal(out.modelVerified, true);
  assert.deepEqual(out.usage, { promptTokens: 11, outputTokens: 22 });
});

test('接口返回的实际模型与所选不一致：这次建议不采纳并说明原因', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ model: 'other-model', choices: [{ message: { content: JSON.stringify(decision()) } }] }), { status: 200 });
  const ctl = new OpenAICompatibleController({ apiBaseUrl: 'https://relay.example.com/v1', apiModel: 'gpt-4o-mini', timeoutSec: 30 }, { fetchImpl });
  const out = await ctl.decide({ goal: '做一个文件', availablePartners: ['codex', 'deepseek'] });
  assert.equal(out.modelVerified, false);
  assert.equal(out.proposal, null);
  assert.match(out.validationError, /不一致/);
});

test('中转站不支持 response_format 时自动去掉重试，不把客户挡在外面', async () => {
  let calls = 0, secondBody = null;
  const fetchImpl = async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (calls === 1) {
      assert.equal(body.response_format.type, 'json_object');
      return new Response(JSON.stringify({ error: { message: 'response_format unsupported' } }), { status: 400 });
    }
    secondBody = body;
    return new Response(JSON.stringify({ model: 'gpt-4o-mini', choices: [{ message: { content: JSON.stringify(decision()) } }] }), { status: 200 });
  };
  const ctl = new OpenAICompatibleController({ apiBaseUrl: 'https://relay.example.com/v1', apiModel: 'gpt-4o-mini', timeoutSec: 30 }, { fetchImpl });
  const out = await ctl.decide({ goal: '做一个文件', availablePartners: ['codex', 'deepseek'] });
  assert.equal(calls, 2);
  assert.equal(secondBody.response_format, undefined);
  assert.equal(out.proposal.taskType, 'execution');
});

test('控制器对话：系统提示包含纠正样例，返回文字与模型证据', async () => {
  let system = '';
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    system = body.messages[0].content;
    return new Response(JSON.stringify({ model: 'gpt-4o-mini', choices: [{ message: { content: '按照纠正回答' } }], usage: { prompt_tokens: 5, completion_tokens: 6 } }), { status: 200 });
  };
  const ctl = new OpenAICompatibleController({ apiBaseUrl: 'https://relay.example.com/v1', apiModel: 'gpt-4o-mini', timeoutSec: 30 }, { fetchImpl });
  const reply = await ctl.chat({ messages: [{ role: 'user', content: '怎么判断？' }], teaching: '客户纠正：先确认是否删除' });
  assert.match(system, /客户纠正：先确认是否删除/);
  assert.equal(reply.text, '按照纠正回答');
  assert.equal(reply.modelVerified, true);
});

test('保存来源/控制方式：写入 config，密钥只进 secrets，不留明文', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-ctl-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig(dir);
  const reloaded = [];
  const o = { config, store: { event() {} } };
  const svc = { reload: cfg => reloaded.push(cfg) };
  const result = await TOOLS.local_controller_save.run(o, { provider: 'api', mode: 'full', enabled: true, apiBaseUrl: 'https://relay.example.com/v1', apiModel: 'gpt-4o-mini', apiKey: 'sk-test-key-123456' }, 'user', svc);
  assert.equal(result.saved, true);
  assert.equal(result.localController.provider, 'api');
  assert.equal(result.localController.mode, 'full');
  assert.equal(result.localController.hasApiKey, true);
  const cfgText = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.match(cfgText, /"provider": "api"/);
  assert.doesNotMatch(cfgText, /sk-test-key-123456/, '密钥不能写进 config.json');
  const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.local.json'), 'utf8'));
  assert.equal(secrets.controllerApiKey, 'sk-test-key-123456');
});

test('看板提供明确二选一：本地 DS / 中转站 API，并允许直接完全接管', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '').replace(/\//g, path.sep)), '..');
  const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  for (const id of ['localDsConfig', 'dsCtlModal', 'cProviderLocal', 'cProviderApi', 'cMode', 'cSave', 'cFetch', 'cApiBase', 'cApiModel']) assert.match(html, new RegExp('id=["\']' + id + '["\']'), id);
  assert.match(html, /本地 DS（本机 Ollama）/);
  assert.match(html, /中转站 API 模型/);
  assert.match(html, /完全接管/);
  assert.match(html, /不需要训练/);
});

test('对话区文案随来源切换：中转站时不再写“和本地 DS 说话”', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '').replace(/\//g, path.sep)), '..');
  const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  assert.match(html, /和 DS 控制器说话/);
  assert.match(html, /和中转站模型对话/);
  assert.match(html, /可以直接问中转站模型/);
  assert.match(html, /发送给 API 控制器/);
  assert.match(html, /发送给控制器/);
  assert.doesNotMatch(html, /placeholder="和本地 DS 说话/);
});
test('纠正反馈提示不再写死“本地 DS 对话会参考”', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '').replace(/\//g, path.sep)), '..');
  const tools = fs.readFileSync(path.join(root, 'src', 'tools.mjs'), 'utf8');
  assert.match(tools, /后续 DS 控制器对话会参考/);
  assert.doesNotMatch(tools, /后续本地 DS 对话会参考/);
});

test('任务卡片按实际来源显示控制方：中转站 API 时不再写“本地 DeepSeek 控制”', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '').replace(/\//g, path.sep)), '..');
  const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  assert.match(html, /中转站 API 控制/);
  assert.match(html, /本地 DeepSeek 控制/);
  assert.match(html, /value\.backend === 'api'/);
});
