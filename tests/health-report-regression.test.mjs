import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults, CONTROL_FLOW_DEFAULTS } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator, askRepeatWindow } from '../src/orchestrator.mjs';
import { ControlBudget, normalizeUsage } from '../src/control-budget.mjs';
import { createCodexUsageAccumulator } from '../src/codex-usage.mjs';
import { createDeepseekParser } from '../src/deepseek.mjs';
import { objectiveUsage, objectiveKey, OBJECTIVE_TOKEN_LIMIT } from '../src/objective-budget.mjs';
import { failureRecord } from '../src/failure-record.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';
import { startServer } from '../src/server.mjs';
import { askCodex } from '../src/codex-engine.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

function fixture(t) {
  const root = tempDir('health-report');
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'health-test' }, skipAcl: true };
  config.codex.defaultModel = 'codex-fixture'; config.deepseek.defaultModel = 'deepseek-fixture';
  config.localController.enabled = false;
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  t.after(() => store.close()); cleanup(t, root);
  const orch = new Orchestrator({ config, store, agents: {} });
  orch.pump = () => {};
  return { root, config, store, orch };
}

const usageFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/health-report-usage.json', import.meta.url), 'utf8'));
test('R313 real usage replay: count all five inferences, not just the last 25772 tokens', () => {
  const tracker = createCodexUsageAccumulator(), events = usageFixture['R313-1647.jsonl'].events;
  for (const event of events) { tracker.push(event); tracker.push(event); }
  assert.equal(tracker.result().totalTokens, 116927);
  assert.equal(tracker.result().inputTokens, 111733);
  assert.equal(tracker.result().contextInputTokens, 24924);
  assert.equal(normalizeUsage(tracker.result()).contextInputTokens, 24924);
  const resumed = createCodexUsageAccumulator();
  resumed.seed({ totalTokens: 900000, inputTokens: 800000, outputTokens: 100000 });
  resumed.push({ total: { totalTokens: 910000, inputTokens: 809000, outputTokens: 101000 }, last: { totalTokens: 10000, inputTokens: 9000, outputTokens: 1000 } });
  assert.equal(resumed.result().totalTokens, 10000, 'old native history must not be charged again');
});
test('native Codex wire emits cumulative whole-call usage with the real five-event trace', async t => {
  const { config, root } = fixture(t);
  config.codex.executable = path.join(root, 'fake-codex'); fs.writeFileSync(config.codex.executable, 'fixture');
  const events = usageFixture['R313-1647.jsonl'].events, seen = [];
  const spawnProcess = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const request = JSON.parse(chunk.toString());
      const send = event => child.stdout.write(JSON.stringify(event) + '\n');
      queueMicrotask(() => {
        if (request.id === undefined) return;
        const result = request.method === 'thread/start' ? { thread: { id: 'usage-native' }, model: 'codex-fixture' }
          : request.method === 'turn/start' ? { turn: { id: 'usage-turn' } } : {};
        send({ id: request.id, result });
        if (request.method === 'turn/start') {
          // A previous turn's notification may arrive before turn/start resolves.
          send({ method: 'thread/tokenUsage/updated', params: { threadId: 'usage-native', turnId: 'previous-turn', tokenUsage: { total: { totalTokens: 999999 }, last: { totalTokens: 999999 } } } });
          for (const tokenUsage of events) send({ method: 'thread/tokenUsage/updated', params: { threadId: 'usage-native', turnId: 'usage-turn', tokenUsage } });
          send({ method: 'item/completed', params: { threadId: 'usage-native', turnId: 'usage-turn', item: { type: 'agentMessage', text: 'done' } } });
          send({ method: 'turn/completed', params: { threadId: 'usage-native', turn: { id: 'usage-turn', status: 'completed' } } });
        }
      }); done();
    } }); return child;
  };
  const result = await askCodex(config, { prompt: 'usage replay', model: 'codex-fixture', cwd: root, signal: AbortSignal.timeout(2000), onUsage: usage => seen.push(usage.totalTokens) }, { spawnProcess, desktopFlags: false });
  assert.deepEqual(seen, [20766, 42845, 66552, 91155, 116927]);
  assert.equal(result.usage.totalTokens, 116927);
});
test('new native thread counts early inferences even when its first usage notification is missing', () => {
  const tracker = createCodexUsageAccumulator();
  tracker.seed({ totalTokens: 0, inputTokens: 0, outputTokens: 0 });
  for (const event of usageFixture['R313-1647.jsonl'].events.slice(2)) tracker.push(event);
  assert.equal(tracker.result().totalTokens, 116927);
});
test('native read-only ask reserves tool-loop budget separately from its short answer cap', async t => {
  const { orch, store, config } = fixture(t);
  config.flow.taskTokenBudget = 64000; config.flow.executionTokenBudget = 128000;
  orch.agents.nativeContextTokens = { deepseek: 12288 };
  const run = store.createRun({ kind: 'ask', target: 'deepseek', goal: '有界只读代码复核', cwd: config.workspace });
  store.updateRun(run.id, { state: 'running' });
  orch.step = async (_run, options) => {
    assert.equal(options.maxTotalTokens, 128000); assert.equal(options.maxTokens, 2000);
    const usage = { totalTokens: 42970, inputTokens: 41000, outputTokens: 1970 };
    options.onUsage(usage); assert.equal(options.signal.aborted, false);
    return { usage, text: '有界复核结果', by: 'deepseek', stepId: store.addStep({ run_id: run.id, role: 'ask', seat: 'deepseek', agent: 'deepseek' }) };
  };
  await orch.controlCall(run, { role: 'ask', seat: 'deepseek', call: 'think', signal: new AbortController().signal, sessions: {}, build: () => '只读复核' }, { phase: 'execution' });
  assert.equal(store.get('controlMetrics:' + run.id).records[0].tokens, 42970);
});
test('R203 real 55-step usage replay: dispatch stops at the first exceeded reservation and retains measured usage', async t => {
  const { orch, store, config } = fixture(t);
  config.flow.taskTokenBudget = 128000; config.flow.executionTokenBudget = 384000;
  const run = store.createRun({ kind: 'ask', target: 'deepseek', goal: '重放已保存用量，不调用模型', cwd: config.workspace });
  store.updateRun(run.id, { state: 'running' });
  const events = usageFixture['R203-1443.jsonl'].events, parser = createDeepseekParser();
  let consumed = 0, last;
  orch.step = async (_run, options) => {
    for (const event of events) {
      parser.push(JSON.stringify(event)); consumed++;
      last = parser.result().usage; options.onUsage(last);
      if (options.signal.aborted) throw Object.assign(new Error('budget stopped replay'), { usage: last, partialText: '保留已有产物' });
    }
    assert.fail('55 costly model steps must not all be replayed');
  };
  await assert.rejects(orch.controlCall(run, { seat: 'deepseek', role: 'execute', call: 'write', signal: new AbortController().signal, sessions: {}, build: () => 'bounded execution' },
    { phase: 'execution', taskId: 'one', budget: 128000 }), error => error.code === 'CONTROL_BUDGET_EXCEEDED' && error.partialText === '保留已有产物');
  assert.ok(consumed < events.length); assert.ok(last.totalTokens > 128000);
  assert.equal(store.get('controlMetrics:' + run.id).records[0].tokens, last.totalTokens);
  assert.equal(Object.keys(store.get('controlMetrics:' + run.id).reservations).length, 0);
});

test('new customers have active budget protection without changing settings', t => {
  const { store } = fixture(t);
  assert.equal(CONTROL_FLOW_DEFAULTS.tokenBudgetEnforced, true);
  const ledger = new ControlBudget(store, { id: 'default-protection' }, { discussionTokenBudget: 1000 });
  assert.throws(() => ledger.reserve({ inputTokens: 999, maxOutputTokens: 900 }), { code: 'CONTROL_BUDGET_EXCEEDED' });
  assert.equal(ledger.state().records.length, 0);
});

for (const compact of [true, false]) test(`R271 replay: single partner stops before local controller or model calls (compact=${compact})`, async t => {
  const { store, orch, config } = fixture(t);
  config.flow.compactDiscussion = compact;
  let calls = 0;
  orch.runLocalControl = async () => { calls++; };
  orch.step = async () => { calls++; throw Error('must never dispatch'); };
  orch.roster.saveHealth({ deepseek: { paused: true } });
  const run = store.createRun({ kind: 'discuss', goal: '讨论下一步实施方案', cwd: config.workspace, initiator: 'codex', max_turns: 4 });
  store.set('controlMode:' + run.id, { compactDiscussion: compact });
  await assert.rejects(orch.runDiscuss(run.id, new AbortController().signal), { code: 'REVIEW_PARTNER_REQUIRED' });
  assert.equal(calls, 0); assert.equal(store.steps(run.id).length, 0);
  assert.equal(store.get('participantGate:' + run.id).blocked, true);
  // Restore a partner; the original unpaid task can proceed with the new roster.
  orch.roster.saveHealth({});
  assert.equal(orch.requireReviewPartner(run).blocked, false);
  assert.deepEqual(orch.participants(run), ['codex', 'deepseek']);
  assert.equal(store.runs(10).length, 1);
});

test('single-partner parallel fast path also stops before any execution', async t => {
  const { orch, store, config } = fixture(t);
  orch.roster.saveHealth({ deepseek: { paused: true } });
  const run = store.createRun({ kind: 'parallel', goal: '新建 a.txt，内容为 done', cwd: config.workspace, initiator: 'codex' });
  orch.fastPathPlan = () => assert.fail('execution routing must not start');
  await assert.rejects(orch.runParallel(run.id, new AbortController().signal), { code: 'REVIEW_PARTNER_REQUIRED' });
  assert.equal(store.steps(run.id).length, 0);
});

test('semantic verdict issues and failed attempts survive resume and reopening the database', t => {
  const { store, root } = fixture(t);
  const run = store.createRun({ kind: 'parallel', goal: '交付文件', cwd: root });
  store.set('verdict:' + run.id, { issues: ['文件缺少一行', '没有独立读回'] });
  store.updateRun(run.id, { state: 'failed', result: '验收未通过' });
  store.updateRun(run.id, { state: 'running', result: null, error: null });
  store.updateRun(run.id, { state: 'error', error: 'getConfig is not defined' });
  const copy = new Store(store.file);
  try {
    assert.equal(copy.get('failure:' + run.id).category, 'internal');
    const history = copy.get('failureHistory:' + run.id);
    assert.equal(history.length, 2);
    assert.deepEqual(history[0].issues, ['文件缺少一行', '没有独立读回']);
    assert.equal(history[1].automaticReplayAllowed, false);
  } finally { copy.close(); }
});

for (const [text, category] of [
  ['HTTP 503', 'transient'], ['HTTP 500', 'transient'], ['timeout', 'transient'],
  ['HTTP 429', 'rate_limit'], ['HTTP 401', 'authentication'],
  ['already has an active writer', 'session_busy'], ['isLocalAgentId is not defined', 'internal'],
]) test(`failure category retains diagnosis without authorizing replay: ${text}`, () => {
  const failure = failureRecord({ state: 'error', error: text });
  assert.equal(failure.category, category); assert.equal(failure.automaticReplayAllowed, false);
});
test('legacy bare fail remains explicitly unknown, never invented', () => {
  assert.equal(failureRecord({ state: 'failed', result: 'fail' }).reasonKnown, false);
});

test('R289-R293 pattern: changed attachments, partner and kind share objective spend protection', t => {
  const { store, orch, config } = fixture(t);
  const previous = store.createRun({ kind: 'parallel', goal: '复核目标【分片1/4】', cwd: path.join(config.workspace, 'beat-runs', '2026-10-16', 'R12'), target: 'deepseek' });
  store.updateRun(previous.id, { state: 'failed', result: '先修正评测口径，已有成果保留' });
  store.set('controlMetrics:' + previous.id, { records: [{ tokens: OBJECTIVE_TOKEN_LIMIT, measurement: 'provider', phase: 'execution' }], reservations: {} });
  assert.throws(() => orch.startAsk({ to: 'codex', question: '复核目标【分片2/4】', access: 'read-only' }), error => error.code === 'OBJECTIVE_TOKEN_BUDGET' && error.message.includes(previous.id) && error.message.includes('先修正评测口径'));
  assert.throws(() => orch.startAsk({ to: 'codex', question: '复核目标【分片2/4】', allowRepeat: true }), { code: 'OBJECTIVE_TOKEN_BUDGET' });
  assert.equal(store.runs(10).length, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
});
test('objective accounting includes reservations, excludes reused calls, future/old records and other workspaces', () => {
  const now = Date.now(), at = new Date(now).toISOString();
  const runs = [{ id: 'R1', kind: 'ask', goal: '评测【批次1】', cwd: '/a', created_at: at },
    { id: 'R2', goal: '评测【批次2】', cwd: '/b', created_at: at },
    { id: 'R3', goal: '评测', cwd: '/a', created_at: new Date(now - 86400001).toISOString() },
    { id: 'R4', goal: '评测', cwd: '/a', created_at: new Date(now + 1).toISOString() }];
  const usage = objectiveUsage(runs, { goal: '评测', cwd: '/a', now, metricsFor: () => ({ records: [{ tokens: 900, measurement: 'reused' }, { tokens: 100, measurement: 'provider' }], reservations: { a: { tokens: 50 } } }) });
  assert.equal(usage.tokens, 150); assert.deepEqual(usage.runs.map(x => x.id), ['R1']);
  assert.notEqual(objectiveKey('成功率提高到90%'), objectiveKey('成功率提高到95%'));
});
test('attachment deduplication catches renamed identical bytes but permits changed same-size evidence', t => {
  const { root } = fixture(t), first = path.join(root, 'first.txt'), renamed = path.join(root, 'second.txt');
  fs.writeFileSync(first, 'abc'); fs.writeFileSync(renamed, 'abc');
  const previous = { kind: 'ask', goal: '复核', target: 'codex', attachments: [{ name: 'first.txt', size: 3, path: first }], created_at: new Date().toISOString() };
  const args = { goal: '复核', target: 'codex', files: [{ name: 'second.txt', size: 3, source: renamed }] };
  assert.equal(askRepeatWindow([previous], args).length, 1);
  fs.writeFileSync(renamed, 'xyz');
  assert.equal(askRepeatWindow([previous], args).length, 0);
});

test('customer API with defaults: offline peer is explained before paid calls, task id and resume action remain visible', async t => {
  const { config } = fixture(t);
  let calls = 0;
  const svc = await startServer({ config, port: 0, agents: {
    nativeAvailability: id => ({ available: id === 'codex', reason: id === 'deepseek' ? '未安装 DeepSeek 桌面端' : null }),
    codex: async () => { calls++; throw Error('must not call model'); },
  } });
  t.after(async () => { await new Promise(resolve => svc.server.close(resolve)); svc.store.close(); });
  const response = await fetch(`http://127.0.0.1:${svc.port}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.secrets.token },
    body: JSON.stringify({ name: 'beat_discuss', args: { question: '比较两种方案' }, actor: 'user', child: false }) });
  const body = await response.json(); assert.equal(body.ok, true);
  const view = await svc.orch.waitFor(body.result.id, 3);
  assert.equal(view.state, 'error'); assert.equal(calls, 0);
  assert.equal(view.failure.category, 'participants');
  assert.match(view.customerIssue.message, /至少需要两位搭档/);
  assert.ok(view.customerIssue.actions.some(a => a.id === 'resume'));
});

test('stall monitor records the real round when the same executor cannot take over its own work', async t => {
  const { orch, store, config } = fixture(t);
  config.flow.stallCheckMs = 1; config.flow.stallOverrideMinutes = 0.00001;
  const run = store.createRun({ kind: 'parallel', goal: '保留原执行', cwd: config.workspace });
  store.updateRun(run.id, { state: 'running' });
  const signal = AbortSignal.timeout(50);
  const handedOff = new Set();
  // Keep one timer referenced while the production monitor uses unref timers.
  const keepAlive = setTimeout(() => {}, 80);
  try {
    await orch.watchForStuck(run, { round: 7, signal, handedOff,
      progress: new Map([['codex', { at: Date.now() - 10000 }]]), tasks: [
        { state: { done: true, ok: true, seat: 'deepseek', executor: 'codex' } },
        { state: { done: false, seat: 'codex', executor: 'codex' } },
      ] });
  } finally { clearTimeout(keepAlive); }
  assert.ok(store.events(10).some(e => e.text.includes('第7轮') && e.text.includes('不重复开会话')));
  assert.equal(handedOff.size, 1);
});
