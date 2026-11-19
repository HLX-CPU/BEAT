import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { startServer } from '../src/server.mjs';
import { budgetContinuationOffer } from '../src/budget-continuation.mjs';
import { tempDir } from './helpers/temp.mjs';
import { TaskQueue } from '../src/task-queue.mjs';
import { executionAttemptKey } from '../src/execution-key.mjs';

function config() {
  const root = tempDir('screenshot-followup');
  const cfg = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'test-budget' }, skipAcl: true };
  cfg.codex.defaultModel = 'cx-fixture'; cfg.deepseek.defaultModel = 'ds-fixture'; cfg.localController.enabled = false;
  return cfg;
}
test('current safety revocation overrides old permissive task snapshots and keeps historical evidence', t => {
  const cfg = config(), store = new Store(':memory:'); t.after(() => store.close());
  cfg.flow.executorAccess = 'workspace-write';   // 模拟"当前设置更严格"，用于证明旧快照不能反向放宽
  const orch = new Orchestrator({ config: cfg, store, agents: {} });
  const run = store.createRun({ kind: 'parallel', goal: '安全继续', cwd: cfg.workspace });
  const old = { executorAccess: 'danger-full-access', allowAnyWrite: true, quarantineUnknown: false };
  store.set('controlConfig:' + run.id, old);
  const flow = orch.flowFor(run);
  assert.equal(flow.executorAccess, 'workspace-write'); assert.equal(flow.allowAnyWrite, false); assert.equal(flow.quarantineUnknown, true);
  assert.deepEqual(store.get('controlConfig:' + run.id), old, 'old audit record is retained');
});
test('budget suggestion preserves spend, expires when the ledger changes and has a bounded ceiling', () => {
  const cfg = config(), run = { id: 'R-budget', state: 'error', error: '用量预算不足，已有结果已保存' };
  const ledger = { phases: { execution: { usedTokens: 800000 } }, records: [{ tokens: 800000 }] };
  const first = budgetContinuationOffer(run, cfg.flow, ledger);
  assert.ok(first.limits.executionTokenBudget > 800000); assert.ok(first.limits.executionTokenBudget <= 10000000);
  assert.equal(ledger.phases.execution.usedTokens, 800000);
  const second = budgetContinuationOffer(run, cfg.flow, { ...ledger, records: [...ledger.records, { tokens: 1 }] });
  assert.notEqual(first.hash, second.hash);
  assert.equal(budgetContinuationOffer({ ...run, state: 'running' }, cfg.flow, ledger), null);
  assert.equal(budgetContinuationOffer(run, cfg.flow, { phases: { execution: { usedTokens: 10000001 } }, records: [] }), null, 'cannot offer a limit below already spent tokens');
});
test('real HTTP budget continuation: customer approval only, same task and native session, no repeat or global setting change', async t => {
  const cfg = config(), seen = [];
  const svc = await startServer({ config: cfg, port: 0, agents: { codex: async options => {
    seen.push(options); options.onNative?.('cx-budget-native');
    const usage = { totalTokens: seen.length === 1 ? 500000 : 100, inputTokens: seen.length === 1 ? 499900 : 80, outputTokens: seen.length === 1 ? 100 : 20 };
    options.onUsage?.(usage);
    return { text: seen.length === 1 ? '上次已完成的只读核验部分' : '只补了剩余结论，原结果保留', usage, nativeId: 'cx-budget-native', actualModel: options.model, modelVerified: 'verified' };
  } } });
  t.after(async () => { await new Promise(resolve => svc.server.close(resolve)); svc.store.close(); });
  const base = `http://127.0.0.1:${svc.port}`;
  const api = async (name, args, { page = false, actor = 'user', child = false } = {}) => (await fetch(base + '/api/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.secrets.token, ...(page ? { Origin: base } : {}) }, body: JSON.stringify({ name, args, actor, child }),
  })).json();
  const opened = await api('beat_ask', { to: 'codex', question: '只读核验剩余结论', access: 'read-only', wait_seconds: 0 });
  assert.equal(opened.ok, true);
  const stopped = await svc.orch.waitFor(opened.result.id, 3);
  assert.equal(stopped.state, 'error'); assert.ok(stopped.budgetOffer);
  const settings = structuredClone(cfg.flow), previous = svc.store.get('controlMetrics:' + stopped.id);
  const args = { id: stopped.id, offerHash: stopped.budgetOffer.hash };
  assert.equal((await api('beat_budget_continue', args)).ok, false, 'API clients cannot approve money use');
  assert.equal((await api('beat_budget_continue', args, { page: true, actor: 'codex' })).ok, false);
  assert.equal((await api('beat_budget_continue', args, { page: true, child: true })).ok, false);
  assert.equal((await api('beat_budget_continue', { ...args, offerHash: 'stale' }, { page: true })).ok, false);
  assert.equal(seen.length, 1); assert.equal(svc.store.get('resumeBudget:' + stopped.id), null);
  assert.equal((await api('beat_budget_continue', args, { page: true })).ok, true);
  const done = await svc.orch.waitFor(stopped.id, 3);
  assert.equal(done.state, 'done'); assert.equal(seen.length, 2);
  assert.equal(seen[1].nativeId, 'cx-budget-native'); assert.equal(seen[1].access, 'read-only');
  assert.match(seen[1].prompt, /只补上次未完成/);
  assert.equal(svc.store.runs(20).length, 1); assert.equal(done.session_id, stopped.session_id);
  assert.deepEqual(cfg.flow, settings, 'no global configuration edits');
  const current = svc.store.get('controlMetrics:' + stopped.id);
  assert.equal(current.records.length, previous.records.length + 1); assert.equal(current.phases.execution.usedTokens, 500100);
  assert.equal((await api('beat_budget_continue', args, { page: true })).ok, false, 'double click cannot grant again');
});
test('dashboard confirmation cancels without dispatch and approves only the displayed task/offer', async () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('async function continueWithBudget('), html.indexOf('async function customerRunAction('));
  const requests = [], r = { id: 'R-button', budgetOffer: { hash: 'displayed-hash', explanation: '可能增加费用；只继续原任务' } };
  let choice = 'dismiss';
  const ctx = vm.createContext({ customerDialog: async () => choice, api: async (...args) => requests.push(args), refresh: async () => {}, lastKey: 'old' });
  vm.runInContext(source, ctx); ctx.run = r;
  await vm.runInContext('continueWithBudget(run)', ctx); assert.equal(requests.length, 0);
  choice = 'grant'; await vm.runInContext('continueWithBudget(run)', ctx);
  assert.equal(requests.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), ['beat_budget_continue', { id: r.id, offerHash: r.budgetOffer.hash }]);
});

test('models cannot clear unknown-input isolation through the old beat_release endpoint', async t => {
  const cfg = config(), svc = await startServer({ config: cfg, port: 0, agents: {} });
  t.after(async () => { await new Promise(resolve => svc.server.close(resolve)); svc.store.close(); });
  svc.orch.pump = () => {};
  const run = svc.store.createRun({ kind: 'parallel', goal: '核对已有操作', cwd: cfg.workspace, initiator: 'codex' });
  svc.store.updateRun(run.id, { state: 'failed', result: '等待核对实际结果' });
  const queue = new TaskQueue({ store: svc.store, runId: run.id, cwd: cfg.workspace, workers: ['codex'], strongAgent: 'codex' });
  queue.enqueue([{ id: 'one', title: '已有操作', files: ['out.txt'], acceptance: ['已有产物经核对'], tokenBudget: 1000 }]);
  const lease = queue.claim('codex', { pid: process.pid });
  const executionKey = executionAttemptKey(run.id, queue.get('one'));
  svc.store.updateRun(run.id, { natives: { 'codex:queue:codex': { nativeDesktop: { executionKey, sideEffects: 'unknown', status: 'unverified' } } } });
  const step = svc.store.addStep({ run_id: run.id, role: 'execute', seat: 'codex', agent: 'codex' });
  svc.store.updateStep(step, { state: 'failed', data: { desktopEvidence: { executionKey, sideEffects: 'unknown' } } });
  queue.fail('one', lease.leaseToken, ['输入结果未核对'], { unknownSideEffects: true, attempt: 1 });
  const base = `http://127.0.0.1:${svc.port}`;
  const release = async (actor, page, child = false) => (await fetch(base + '/api/call', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.secrets.token, ...(page ? { Origin: base } : {}) },
    body: JSON.stringify({ name: 'beat_release', args: { id: run.id, task: 'one', note: 'fixture confirmation' }, actor, child }),
  })).json();
  for (const [actor, page, child] of [['codex', false, false], ['codex', true, false], ['user', false, false], ['user', true, true]]) {
    assert.equal((await release(actor, page, child)).ok, false);
    assert.equal(queue.get('one').status, 'blocked');
  }
  assert.equal((await release('user', true)).ok, true);
  assert.equal(queue.get('one').status, 'queued');
  const receipt = svc.store.run(run.id).natives['codex:queue:codex'];
  assert.equal(receipt.nativeDesktop.sideEffects, 'customer-confirmed');
  assert.equal(receipt.nativeDesktopConfirmations[0].original.sideEffects, 'unknown');
  assert.equal(svc.store.steps(run.id)[0].data.desktopEvidence.sideEffects, 'unknown', 'original receipt is immutable');
  assert.doesNotThrow(() => svc.orch.assertResumeEvidence(svc.store.run(run.id)), 'explicit confirmation exits isolation without erasing history');
});

test('budget confirmation never overrides unknown-input isolation or records a grant before checking it', t => {
  const cfg = config(), store = new Store(':memory:'); t.after(() => store.close());
  const orch = new Orchestrator({ config: cfg, store, agents: {} });
  const run = store.createRun({ kind: 'parallel', goal: '保留未知操作', cwd: cfg.workspace });
  store.updateRun(run.id, { state: 'error', error: '用量预算已用完' });
  store.set('taskQueue:' + run.id, [{ id: 'one', sideEffects: 'unknown', quarantineReason: 'unconfirmed-exit+unknown-side-effects' }]);
  const offer = orch.view(run.id).budgetOffer;
  assert.throws(() => orch.resumeWithBudget(run.id, offer.hash), /尚未核对/);
  assert.equal(store.get('resumeBudget:' + run.id), null);
});
