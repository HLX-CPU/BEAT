// 恢复（看板「继续执行」）一个失败的并行任务时：只因预算/路由被停止、从未产出的小任务应当重新排队，
// 并按客户当前设置重新分配一次执行预算；其他隔离原因（未知副作用、未确认退出）必须人工核对，不自动恢复。
// 真实背景：R77 的 task-1 因执行会话被沙箱拒绝而两次尝试烧掉 120440/128000 预算后隔离，
// 旧控制器点「继续执行」也不会再碰它——失败没有出口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { TaskQueue } from '../src/task-queue.mjs';
import { ControlBudget } from '../src/control-budget.mjs';
import { runQueuedTasks } from '../src/queue-runner.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

const plan = () => ({ tasks: [{ id: 'A', owner: 'deepseek', type: 'workspace', title: '创建结果文件', detail: '写入 out.txt', files: ['out.txt'], acceptance: ['out.txt 内容为 done'], difficulty: 'easy', tokenBudget: 20000 }], acceptance: ['out.txt 内容为 done'], checks: [] });

function fixture(t) {
  const parent = artifactsRoot(); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'resume-requeue-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'fixture-token' }, flow: { ...defaults(root).flow, tokenBudgetEnforced: true, taskTokenBudget: 20000 } };
  fs.mkdirSync(config.workspace, { recursive: true });
  config.codex.defaultModel = 'fixture-codex'; config.deepseek.defaultModel = 'fixture-deepseek';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  const calls = [];
  const native = o => o.nativeId || (o.role === 'write' ? 'ds-write' : 'ds-read');
  const agents = {
    deepseek: async o => { calls.push({ seat: 'deepseek', role: o.role, access: o.access }); const file = path.join(o.cwd, 'out.txt'); fs.writeFileSync(file, 'done'); const id = native(o); o.onNative?.(id); return { text: JSON.stringify({ summary: '已创建 out.txt', artifacts: [{ path: file, summary: 'done' }] }), nativeId: id, usage: { totalTokens: 120, source: 'fixture' } }; },
    codex: async o => { calls.push({ seat: 'codex', role: o.role, access: o.access }); const id = native(o); o.onNative?.(id); return { text: '{"pass":true,"issues":[]}', nativeId: id, usage: { totalTokens: 80, source: 'fixture' } }; },
  };
  const orch = new Orchestrator({ config, store, agents });
  const run = store.createRun({ kind: 'parallel', goal: '创建 out.txt，内容是 done', cwd: config.workspace, initiator: 'codex', max_rounds: 2, max_turns: 4 });
  const queue = () => new TaskQueue({ store, runId: run.id, cwd: run.cwd, workers: ['codex', 'deepseek'], strongAgent: 'codex', leaseMs: 120000 });
  return { config, store, orch, run, calls, root, queue };
}

test('只有预算/路由停止的任务可以自动恢复排队，未知副作用等隔离必须人工核对', async t => {
  const f = fixture(t), q = f.queue();
  q.enqueue(plan().tasks);
  q.block('A', ['轻量搭档与升级搭档均不满足当前预算，保留任务等待处理'], { reason: 'token-budget-routing' });
  assert.equal(q.get('A').state, 'blocked');
  const back = q.requeueBlocked('A', { reason: 'resume:failed' });
  assert.equal(back.state, 'queued'); assert.equal(back.quarantineReason, null); assert.equal(back.retries, 0);
  assert.ok((q.get('A', { withHistory: true }).history || []).some(entry => entry.outcome === 'resume-requeue'), '恢复入队要留下审计记录');
  q.block('A', ['电脑输入结果尚未核验，已隔离此任务'], { reason: 'unconfirmed-exit+unknown-side-effects' });
  assert.throws(() => q.requeueBlocked('A'), e => e.code === 'NOT_REQUEUEABLE', '未知副作用隔离不能自动恢复');
});

test('恢复时按当前设置重新分配任务预算，历史用量原样保留', async t => {
  const f = fixture(t);
  const ledger = new ControlBudget(f.store, f.run, f.config.flow);
  const reserve = ledger.reserve({ phase: 'execution', taskId: 'A', inputTokens: 100, maxOutputTokens: 500 });
  ledger.finish(reserve.id, { usage: { totalTokens: 60000, source: 'fixture' } });
  assert.equal(ledger.state().tasks.A.usedTokens, 60000);
  const granted = ledger.grantTaskBudget('A', 20000, { reason: 'resume:failed' });
  assert.equal(granted.granted, 20000);
  const task = ledger.state().tasks.A;
  assert.equal(task.budget, 80000, '恢复后保证“再有一次完整尝试”的余量（已用 60000 + 设置 20000），不累加');
  assert.equal(task.usedTokens, 60000, '历史用量不被抹掉，仍然计入审计');
  assert.equal(task.grants.length, 1); assert.equal(task.grants[0].reason, 'resume:failed');
});

test('显式继续执行后预算按客户当前设置刷新，只增不减（错误提示的"提高预算后继续"必须真的可用）', async t => {
  const f = fixture(t);
  f.store.set('controlConfig:' + f.run.id, { tokenBudgetEnforced: true, discussionTokenBudget: 256000, executionTokenBudget: 384000, taskTokenBudget: 20000 });
  assert.equal(f.orch.flowFor(f.run).discussionTokenBudget, 256000, '没点继续就沿用任务快照');
  f.config.flow.discussionTokenBudget = 384000;
  assert.equal(f.orch.flowFor(f.run).discussionTokenBudget, 256000, '改设置不影响已在跑的任务（设置只影响新任务）');
  f.store.set('resumeBudget:' + f.run.id, { at: new Date().toISOString(), discussionTokenBudget: 384000 });
  assert.equal(f.orch.flowFor(f.run).discussionTokenBudget, 384000, '点继续后按当前设置提高');
  const ledger = new ControlBudget(f.store, f.run, f.orch.flowFor(f.run));
  assert.equal(ledger.limits.discussion, 384000, '账本上限跟着刷新');
  f.config.flow.discussionTokenBudget = 100000;
  assert.equal(f.orch.flowFor(f.run).discussionTokenBudget, 384000, '只增不减，不会把已在跑的任务砍回去');
});

test('未点继续时保持隔离；点继续后仅重排被预算停止的任务并真正跑完', async t => {
  const f = fixture(t), q = f.queue();
  f.config.flow.executionTokenBudget = 20000;
  q.enqueue(plan().tasks);
  // 复现真实场景：上一次失败的执行已经吃掉大部分任务预算，准入因此把任务停下（R77：120440/128000）。
  const ledger0 = new ControlBudget(f.store, f.run, f.config.flow);
  const spent = ledger0.reserve({ phase: 'execution', taskId: 'A', inputTokens: 100, maxOutputTokens: 500 });
  ledger0.finish(spent.id, { usage: { totalTokens: 19000, source: 'fixture' } });
  f.run.control = { workerMinTokens: () => 6000 };
  q.block('A', ['轻量搭档与升级搭档均不满足当前预算，保留任务等待处理'], { reason: 'token-budget-routing' });
  const first = await runQueuedTasks(f.orch, f.run, plan(), new AbortController().signal, {});
  assert.equal(first.verdict.verdict, 'fail');
  assert.equal(q.get('A').state, 'blocked', '没有明确恢复就不自动重排');
  assert.equal(fs.existsSync(path.join(f.config.workspace, 'out.txt')), false);
  // R313: the saved phase still has only 1k left. Resume admission must use
  // the explicitly refreshed limit before the first new reservation exists.
  f.config.flow.executionTokenBudget = 50000;
  const second = await runQueuedTasks(f.orch, f.run, plan(), new AbortController().signal, {}, { resume: { from: 'failed', at: new Date().toISOString() } });
  assert.equal(second.verdict.verdict, 'pass', JSON.stringify(second.verdict.issues));
  assert.equal(fs.readFileSync(path.join(f.config.workspace, 'out.txt'), 'utf8'), 'done');
  const ledger = f.store.get('controlMetrics:' + f.run.id);
  assert.ok(ledger.tasks.A.budget > 20000, '恢复时按当前设置追加了任务预算');
  assert.equal(ledger.tasks.A.grants.length, 1);
  assert.ok(ledger.tasks.A.usedTokens >= 19000, '历史用量保留（含本次执行的真实用量）');
  assert.ok(q.get('A').tokenBudget > 20000, '任务行自身的预算上限也要提高，否则准入仍然只看到剩余 1000');
  assert.equal(q.get('A').state, 'passed');
  const exec = f.calls.find(c => c.seat === 'deepseek' && c.role === 'write');
  assert.ok(exec, '真正由执行角色完成'); // 客户 2026-10-18 指定执行者默认完全访问
  assert.equal(exec.access, 'danger-full-access');
});
test('任务预算用尽（token-budget-exhausted）也能在显式继续后重新排队', async t => {
  const f = fixture(t), q = f.queue();
  q.enqueue(plan().tasks);
  const lease = q.claim('deepseek', { pid: process.pid });
  const error = Object.assign(new Error('本任务的用量预算已到上限，已停止追加调用'), { code: 'CONTROL_BUDGET_EXCEEDED' });
  q.fail('A', lease.leaseToken, ['本任务的用量预算已到上限'], { terminal: true, budgetExceeded: true, attempt: 1 });
  assert.equal(q.get('A').state, 'blocked');
  assert.equal(q.get('A').quarantineReason, 'token-budget-exhausted');
  const resumed = await runQueuedTasks(f.orch, f.run, plan(), new AbortController().signal, {}, { resume: { from: 'failed' } });
  assert.equal(resumed.verdict.verdict, 'pass', JSON.stringify(resumed.verdict.issues));
  assert.equal(q.get('A').state, 'passed');
});
