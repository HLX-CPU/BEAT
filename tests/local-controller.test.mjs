import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalDeepSeekController, LOCAL_CONTROLLER_DEFAULTS, LOCAL_DECISION_JSON_SCHEMA, detectGoalRisk, localControllerPrompt, localDecisionPolicy, normalizeLocalControllerConfig, validateLocalDecision } from '../src/local-controller.mjs';

const decision = (extra = {}) => ({
  schemaVersion: 1, taskType: 'execution',
  risk: { level: 'low', reasons: ['only creates a text file'], irreversible: false, money: false, computerInput: false },
  flow: { kind: 'parallel', maxDebates: 1, maxRounds: 2, maxParallelTasks: 2 },
  assignees: { strong: 'codex', cheap: ['deepseek'] },
  budget: { discussionTokens: 2000, executionTokens: 4000, taskTokens: 3000 },
  requiresHuman: false, confidence: 0.9, reasons: ['bounded local change'], ...extra,
});

test('local controller defaults to the requested 9GB DeepSeek 14B model and stays disabled', () => {
  const cfg = normalizeLocalControllerConfig();
  assert.deepEqual(cfg, LOCAL_CONTROLLER_DEFAULTS);
  assert.equal(cfg.model, 'deepseek-r1:14b');
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.mode, 'off');
});

test('local controller rejects non-loopback endpoints', () => {
  assert.throws(() => normalizeLocalControllerConfig({ baseUrl: 'https://example.com' }), /只允许连接这台电脑/);
  assert.throws(() => normalizeLocalControllerConfig({ baseUrl: 'http://192.168.1.2:11434' }), /只允许连接这台电脑/);
});

test('health reports whether the configured model is actually installed', async () => {
  const fetchImpl = async url => {
    assert.equal(url, 'http://127.0.0.1:11434/api/tags');
    return new Response(JSON.stringify({ models: [{ name: 'deepseek-r1:14b' }] }), { status: 200 });
  };
  const ctl = new LocalDeepSeekController({}, { fetchImpl, now: () => 20 });
  assert.deepEqual(await ctl.health(), { online: true, modelReady: true, model: 'deepseek-r1:14b', models: ['deepseek-r1:14b'], latencyMs: 0 });
});

test('decide sends a non-executing local advisory request and keeps model evidence', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: 'deepseek-r1:14b', message: { content: '<think>internal</think>\n' + JSON.stringify(decision()) }, prompt_eval_count: 40, eval_count: 12 }), { status: 200 });
  };
  const ctl = new LocalDeepSeekController({}, { fetchImpl, now: () => 100 });
  const out = await ctl.decide({ goal: '修复一个按钮', cwd: 'E:/beat', availablePartners: ['codex', 'deepseek'], limits: { taskTokenBudget: 1000 } });
  assert.equal(sent.model, 'deepseek-r1:14b');
  assert.equal(sent.stream, false);
  assert.equal(sent.think, false);
  assert.deepEqual(sent.format, LOCAL_DECISION_JSON_SCHEMA);
  assert.match(sent.messages[0].content, /输出计划期间不要调用工具或执行动作/);
  assert.deepEqual(out.proposal, decision());
  assert.equal(out.validationError, null);
  assert.equal(out.modelVerified, true);
  assert.deepEqual(out.usage, { promptTokens: 40, outputTokens: 12 });
});

test('prompt carries the five control concerns and requires strict validation', () => {
  const prompt = localControllerPrompt({ goal: '做任务' });
  for (const word of ['任务类型', '风险', '流程', '执行者', '预算']) assert.match(prompt, new RegExp(word));
  assert.match(prompt, /严格按照提供的 JSON Schema/);
});

test('strict decisions reject extra fields, unknown partners and unsafe shapes', () => {
  assert.throws(() => validateLocalDecision({ ...decision(), shell: 'rm -rf' }, { partners: ['codex', 'deepseek'] }), /不允许的字段/);
  assert.throws(() => validateLocalDecision(decision({ assignees: { strong: 'unknown', cheap: [] } }), { partners: ['codex'] }), /不在当前可用搭档/);
  assert.throws(() => validateLocalDecision(decision({ confidence: 2 }), { partners: ['codex', 'deepseek'] }), /0 到 1/);
  assert.throws(() => validateLocalDecision(decision({ taskType: 'question' }), { partners: ['codex', 'deepseek'] }), /纯问答只能使用 direct/);
});

test('shadow records only; low-risk mode applies only bounded suggestions', () => {
  const context = { runKind: 'parallel', partners: ['codex', 'deepseek'], currentFlow: { discussionMaxDebates: 3, maxRounds: 5, maxParallelTasks: 3, discussionTokenBudget: 10000, executionTokenBudget: 20000, taskTokenBudget: 10000 } };
  assert.equal(localDecisionPolicy(decision(), { ...context, mode: 'shadow' }).applied, false);
  const applied = localDecisionPolicy(decision(), { ...context, mode: 'low-risk' });
  assert.equal(applied.applied, true);
  assert.equal(applied.patch.maxParallelTasks, 2);
  assert.equal(applied.patch.executionTokenBudget, 20000);
  assert.equal(applied.maxRounds, 2);
});

test('money, irreversible, computer input and high risk can never auto-apply', () => {
  const base = { mode: 'full', runKind: 'parallel', partners: ['codex', 'deepseek'], currentFlow: {} };
  for (const risk of [
    { level: 'high' }, { irreversible: true }, { money: true }, { computerInput: true },
  ]) {
    const value = decision({ risk: { ...decision().risk, ...risk } });
    assert.equal(localDecisionPolicy(value, base).applied, false);
  }
});

test('code safety floor upgrades dangerous flags even when the model understates risk', () => {
  const money = validateLocalDecision(decision({ risk: { ...decision().risk, level: 'medium', money: true } }), { partners: ['codex', 'deepseek'] });
  assert.equal(money.risk.level, 'high');
  const critical = validateLocalDecision(decision({ risk: { ...decision().risk, level: 'high', irreversible: true, computerInput: true } }), { partners: ['codex', 'deepseek'] });
  assert.equal(critical.risk.level, 'critical');
});

test('goal scanner independently catches money, credentials, external sends, destructive production work and complex changes', () => {
  assert.equal(detectGoalRisk('Purchase a paid API plan').level, 'high');
  assert.equal(detectGoalRisk('Type a password into a desktop application').computerInput, true);
  assert.equal(detectGoalRisk('Overwrite the production database').level, 'critical');
  assert.equal(detectGoalRisk('Send an email to an external customer').level, 'high');
  assert.equal(detectGoalRisk('Refactor several modules').level, 'medium');
  const guarded = validateLocalDecision(decision(), { partners: ['codex', 'deepseek'], goal: 'Purchase a paid API plan' });
  assert.equal(guarded.risk.level, 'high'); assert.equal(guarded.requiresHuman, true);
});

test('a valid JSON decision from another model or a truncated reply cannot be adopted', async () => {
  for (const fields of [{ model: 'another-model', done_reason: 'stop' }, { model: 'deepseek-r1:14b', done_reason: 'length' }]) {
    const controller = new LocalDeepSeekController({}, { fetchImpl: async () => new Response(JSON.stringify({ ...fields, message: { content: JSON.stringify(decision()) } }), { status: 200 }) });
    const reply = await controller.decide({ goal: 'Create a text file', availablePartners: ['codex', 'deepseek'] });
    assert.equal(reply.proposal, null);
    assert.ok(reply.modelProposal);
    assert.match(reply.validationError, /未采纳/);
  }
});

test('cancelling a controller judgement aborts the actual local request', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const controller = new LocalDeepSeekController({}, { fetchImpl: async (_url, options) => { options.signal.throwIfAborted(); throw new Error('should not dispatch'); } });
  await assert.rejects(controller.decide({ goal: 'Create a text file', signal: cancelled.signal }), { name: 'AbortError' });
});

test('format repair is bounded, keeps the first failure, and charges both actual calls', async () => {
  let calls = 0;
  const controller = new LocalDeepSeekController({}, { fetchImpl: async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    if (calls === 2) assert.match(request.messages[0].content, /confidence 必须为 0 到 1/);
    return new Response(JSON.stringify({ model: 'deepseek-r1:14b', done_reason: 'stop', prompt_eval_count: 20, eval_count: 30, message: { content: JSON.stringify(decision(calls === 1 ? { confidence: 100 } : {})) } }), { status: 200 });
  } });
  const reply = await controller.decide({ goal: 'Create a text file', availablePartners: ['codex', 'deepseek'] });
  assert.equal(calls, 2);
  assert.equal(reply.attempts[0].proposal, null);
  assert.equal(reply.proposal.confidence, 0.9);
  assert.deepEqual(reply.usage, { promptTokens: 40, outputTokens: 60 });
});

test('完全接管遇到不支持 thinking 的本地模型：自动改用普通请求，不让控制器缺席', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body.think);
    if (body.think) return new Response(JSON.stringify({ error: '\"m\" does not support thinking' }), { status: 400 });
    return new Response(JSON.stringify({ model: 'deepseek-r1:14b', message: { content: JSON.stringify(decision()) } }), { status: 200 });
  };
  const controller = new LocalDeepSeekController({ mode: 'full', model: 'deepseek-r1:14b' }, { fetchImpl, now: () => 7 });
  const reply = await controller.decide({ goal: 'Create a text file', availablePartners: ['codex', 'deepseek'] });
  assert.deepEqual(calls, [true, false]);
  assert.equal(reply.thinking, false);
  assert.ok(reply.proposal, '不支持 thinking 不能把整次判断变成失败');
  assert.equal(reply.validationError, null);
});

test('其它本地模型错误照旧原样报告，不伪装成成功', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'model not found' }), { status: 404 });
  const controller = new LocalDeepSeekController({ mode: 'full' }, { fetchImpl });
  await assert.rejects(controller.decide({ goal: 'Create a text file' }), /model not found/);
});
