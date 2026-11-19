import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { ControlBudget, estimateTokens } from '../src/control-budget.mjs';
import { prepareQueuedTasks, workerMinimumTokens } from '../src/queue-runner.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

// Production runParallel builds the dynamic estimator; production TaskQueue and
// ControlBudget persist it. Provider replies/check results below are fixtures.
function fixture(t, { explicit = false, unavailable = false, growReviewer = false, pauseCheap = false } = {}) {
  const parent = artifactsRoot(); fs.mkdirSync(parent, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(parent, 'dynamic-routing-'));
  const store = new Store(path.join(cwd, 'data', 'audit.sqlite'));
  const flow = { tokenBudgetEnforced: true, taskTokenBudget: 12000, executionTokenBudget: 50000, taskMaxRetries: 2, maxParallelTasks: 1, cheapAgents: ['deepseek'], strongAgent: 'codex' };
  const plan = { tasks: [{ id: 'a', owner: 'deepseek', title: 'a', detail: 'short', type: 'workspace', files: ['a.txt'], difficulty: 'simple', acceptance: ['文件内容正确'] },
    { id: 'b', owner: 'deepseek', title: 'b', detail: pauseCheap ? 'short enough for either worker' : 'x'.repeat(6000), type: 'workspace', files: ['b.txt'], difficulty: 'simple', dependsOn: ['a'], checks: ['fixture-format-b'], acceptance: [{ text: '文件格式正确', check: 'fixture-format-b' }], ...(explicit ? { eligibleWorkers: ['deepseek'] } : {}) }], checks: [], acceptance: [] };
  const run = store.createRun({ kind: 'parallel', goal: 'two ordered files', cwd, initiator: 'codex' });
  store.updateRun(run.id, { plan }); store.set('resume:' + run.id, { from: 'execute' }); store.set('controlMode:' + run.id, { pullQueue: true });
  const ledger = new ControlBudget(store, run, flow), dispatched = [], estimates = [], status = new Map();
  const orch = { store, config: { root: cwd, workspace: cwd, dataDir: path.join(cwd, 'data'), skipAcl: true, flow },
    agents: { nativeContextTokens: { deepseek: unavailable ? 13000 : 512, codex: unavailable ? 13000 : 512 } },
    participants: () => ['deepseek', 'codex'], roster: { state: id => ({ status: status.get(id) || 'online' }) },
    validatePlan: (_run, value) => value, guard: (_run, signal) => { if (signal.aborted) throw signal.reason; },
    runChecks: async (_cwd, commands) => commands.map(command => ({ command, ok: true, exitCode: 0, output: 'adapter fixture check', ms: 0 })),
    finishParallel: (_id, state, verdict, reports) => ({ state, verdict, reports }),
    async controlCall(currentRun, options, limits) {
      const prompt = options.build(options.seat), work = options.role === 'execute';
      const previous = ledger.state().records.filter(item => item.seat === options.seat && item.usage).at(-1)?.usage;
      const context = Math.max(orch.agents.nativeContextTokens[options.seat], (previous?.totalTokens || 0) - (previous?.outputTokens || 0));
      const inputTokens = estimateTokens(prompt) + context;
      estimates.push({ id: limits.taskId, seat: options.seat, inputTokens, context });
      const reservation = ledger.reserve({ ...limits, phase: 'execution', seat: options.seat, inputTokens, maxOutputTokens: work ? Math.max(1000, 12000 - inputTokens) : 600 });
      dispatched.push({ id: limits.taskId, seat: options.seat, role: options.role });
      let text;
      if (work) { const file = path.join(cwd, limits.taskId + '.txt'); fs.writeFileSync(file, 'ok'); text = JSON.stringify({ summary: '完成', artifacts: [{ path: file }] }); }
      else text = '{"pass":true,"issues":[]}';
      const total = work ? limits.taskId === 'a' ? pauseCheap ? 1000 : growReviewer ? 3000 : 9000 : 1000 : 500;
      const usage = { totalTokens: total, inputTokens: total - 100, outputTokens: 100, source: 'dummy-provider' };
      ledger.finish(reservation.id, { usage, text });
      if (pauseCheap && work && limits.taskId === 'a') status.set('deepseek', 'paused');
      if (growReviewer && work) {
        const extra = ledger.reserve({ phase: 'execution', taskId: 'other-native-call', seat: 'codex', inputTokens: 0, maxOutputTokens: 12000 });
        ledger.finish(extra.id, { usage: { totalTokens: 9000, inputTokens: 8900, outputTokens: 100, source: 'dummy-concurrent-context' } });
      }
      return { by: options.seat, text, usage, scopeWriteEvidence: { source: 'native-tool-log', complete: true, paths: work ? [path.join(cwd, limits.taskId + '.txt')] : [] } };
    } };
  t.after(() => store.close());
  return { store, orch, run, ledger, dispatched, estimates, plan, execute: () => Orchestrator.prototype.runParallel.call(orch, run.id, AbortSignal.timeout(4000)) };
}

test('真实SQLite按最新原生上下文升级后续任务，无DS误派发或重试且角色变化有证据', async t => {
  const f = fixture(t), outcome = await f.execute(), rows = f.store.get('taskQueue:' + f.run.id);
  assert.equal(outcome.state, 'passed'); assert.equal(outcome.verdict.pass, true);
  assert.deepEqual(f.dispatched.map(item => [item.id, item.role, item.seat]), [['a', 'execute', 'deepseek'], ['a', 'evaluate', 'codex'], ['b', 'execute', 'codex']]);
  assert.ok(rows.every(item => item.state === 'passed' && item.attempts === 1 && item.retries === 0 && item.tokenBudget === 12000));
  assert.equal(rows.find(item => item.id === 'b').executor, 'codex');
  assert.ok(rows.every(item => item.eligibleWorkers === null), 'computed candidates are not persisted as explicit user restrictions');
  assert.equal(f.ledger.state().phases.execution.measuredTokens, 10500, 'no extra fee for an undispatched DS b attempt');
  const routing = f.store.get('queueMetrics:' + f.run.id).routing.records;
  assert.ok(routing.some(item => item.taskId === 'b' && item.eligibleWorkers?.includes('codex') && /升级/.test(item.routingReason || '')), 'latest route and reason must be visible');
  assert.ok(f.store.events(1000).some(item => /b/.test(item.text || '') && /升级/.test(item.text || '') && /codex/.test(item.text || '')));
  assert.ok(f.estimates.find(item => item.id === 'b').inputTokens < 12000);
});

test('用户explicit eligibleWorkers不会因上下文成本变化被偷偷升级到未授权搭档', async t => {
  const f = fixture(t, { explicit: true }), outcome = await f.execute(), rows = f.store.get('taskQueue:' + f.run.id);
  assert.equal(outcome.state, 'failed');
  const blocked = rows.find(item => item.id === 'b');
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.attempts, 0); assert.equal(blocked.retries, 0);
  assert.deepEqual(blocked.eligibleWorkers, ['deepseek']);
  assert.equal(f.dispatched.some(item => item.id === 'b'), false);
  assert.equal(f.ledger.state().tasks.b, undefined, 'no provider reservation or charge for excluded explicit worker');
  assert.ok(blocked.issues.length);
});

test('轻量搭档在先行任务完成后暂停，后续任务按当前在线状态显式升级且无重试', async t => {
  const f = fixture(t, { pauseCheap: true }), outcome = await f.execute(), rows = f.store.get('taskQueue:' + f.run.id);
  assert.equal(outcome.state, 'passed'); assert.equal(f.orch.roster.state('deepseek').status, 'paused');
  assert.deepEqual(f.dispatched.map(item => [item.id, item.role, item.seat]), [['a', 'execute', 'deepseek'], ['a', 'evaluate', 'codex'], ['b', 'execute', 'codex']]);
  assert.ok(rows.every(item => item.state === 'passed' && item.attempts === 1 && item.retries === 0));
  const routes = f.store.get('queueMetrics:' + f.run.id).routing.records;
  assert.ok(routes.some(item => item.taskId === 'b' && item.mode === 'work-admission' && item.selectedWorker === 'codex' && /升级/.test(item.routingReason || '') && item.excluded?.some(entry => entry.worker === 'deepseek' && /不可用/.test(entry.reason))));
  assert.ok(f.store.events(1000).some(item => /b/.test(item.text || '') && /升级到 codex/.test(item.text || '')));
  assert.equal(f.ledger.state().phases.execution.measuredTokens, 2500);
});

test('动态候选均不满足客户预算时保留任务并阻止所有模型派发', async t => {
  const f = fixture(t, { unavailable: true }), outcome = await f.execute(), rows = f.store.get('taskQueue:' + f.run.id);
  assert.equal(outcome.state, 'failed'); assert.equal(f.dispatched.length, 0);
  assert.ok(rows.every(item => item.state === 'blocked' && item.attempts === 0 && item.retries === 0));
  assert.equal(f.ledger.state().records.length, 0);
  assert.ok(rows.every(item => item.issues.length > 0));
});

test('执行期间原生审核者上下文增长，独立核验重新检查成本且未验证不通过', async t => {
  const f = fixture(t, { growReviewer: true }), outcome = await f.execute(), rows = f.store.get('taskQueue:' + f.run.id);
  // R363 实测：核验成本超出剩余预算时不再判死整任务——产出保留在验收中，恢复搭档后只核验、不重做。
  assert.equal(outcome.state, 'failed'); assert.equal(rows.find(item => item.id === 'a').state, 'verifying');
  assert.deepEqual(f.dispatched.map(item => [item.id, item.role]), [['a', 'execute']]);
  const records = f.store.get('queueMetrics:' + f.run.id).routing.records;
  assert.ok(records.some(item => item.taskId === 'a' && item.mode === 'review' && item.excluded?.some(entry => entry.worker === 'codex' && entry.minimumTokens > item.availableTokens)));
  assert.match(rows.find(item => item.id === 'a').issues.join(' '), /独立|未验证/);
});

test('动态估算无有效数字时拒绝候选，用户显式空名单保留为拒绝权限', () => {
  const task = { id: 'a', title: 'a', files: ['a.txt'], acceptance: ['done'], eligibleWorkers: [] };
  const control = { workerMinTokens: () => undefined };
  assert.equal(workerMinimumTokens('codex', 'work', control, task), Infinity);
  assert.deepEqual(prepareQueuedTasks({ tasks: [task] }, ['codex'], control)[0].eligibleWorkers, []);
});
