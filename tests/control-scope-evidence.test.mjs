// 大工作区（>2 万个文件）会让快照截断：截断点漂移会把没动过的老文件当成"新增"，任务被误判越界隔离。
// 修复后：快照固定排序并标记 truncated；越界判定只采信 mtime 晚于本次尝试的改动；
// 显式恢复时若能用 mtime 证明被判越界的文件都早于那次尝试，就按证据重新排队，否则保持隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { TaskQueue } from '../src/task-queue.mjs';
import { runQueuedTasks } from '../src/queue-runner.mjs';
import { snapshot, diffSnapshots } from '../src/workspace.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

const plan = () => ({ tasks: [{ id: 'A', owner: 'deepseek', type: 'workspace', title: '创建结果文件', detail: '写入 out.txt', files: ['out.txt'], acceptance: ['out.txt 内容为 done'], difficulty: 'easy', tokenBudget: 20000 }], acceptance: ['out.txt 内容为 done'], checks: [] });

function fixture(t) {
  const parent = artifactsRoot(); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'scope-evidence-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'fixture-token' }, flow: { ...defaults(root).flow, taskTokenBudget: 20000 } };
  fs.mkdirSync(config.workspace, { recursive: true });
  config.codex.defaultModel = 'fixture-codex'; config.deepseek.defaultModel = 'fixture-deepseek';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  const agents = {
    deepseek: async o => { const file = path.join(o.cwd, 'out.txt'); fs.writeFileSync(file, 'done'); const id = o.nativeId || 'ds-write'; o.onNative?.(id); return { text: JSON.stringify({ summary: '已创建 out.txt', artifacts: [{ path: file, summary: 'done' }] }), nativeId: id, usage: { totalTokens: 120, source: 'fixture' } }; },
    codex: async o => { const id = o.nativeId || 'cx-1'; o.onNative?.(id); return { text: '{"pass":true,"issues":[]}', nativeId: id, usage: { totalTokens: 80, source: 'fixture' } }; },
  };
  const orch = new Orchestrator({ config, store, agents });
  const run = store.createRun({ kind: 'parallel', goal: '创建 out.txt，内容是 done', cwd: config.workspace, initiator: 'codex', max_rounds: 2, max_turns: 4 });
  const queue = () => new TaskQueue({ store, runId: run.id, cwd: run.cwd, workers: ['codex', 'deepseek'], strongAgent: 'codex', leaseMs: 120000 });
  return { config, store, orch, run, root, queue };
}

test('大工作区的快照按固定顺序截断并标记 truncated', () => {
  const dir = fs.mkdtempSync(path.join(artifactsRoot(), 'snap-'));
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, 'f' + String(i).padStart(3, '0') + '.txt'), 'x');
  const first = snapshot(dir, 10), second = snapshot(dir, 10);
  assert.equal(first.truncated, true);
  assert.deepEqual([...first.keys()], [...second.keys()], '同样的目录必须截断在同一批文件上');
  const whole = snapshot(dir, 1000);
  assert.equal(whole.truncated, false);
  assert.equal(diffSnapshots(first, second).truncated, true);
  assert.equal(diffSnapshots(whole, whole).truncated, false);
});

test('越界隔离被 mtime 证据推翻时，显式恢复可以重新排队并跑完', async t => {
  const f = fixture(t), q = f.queue();
  q.enqueue(plan().tasks);
  const oldFile = path.join(f.config.workspace, 'old-artifact.txt');
  fs.writeFileSync(oldFile, 'old');
  const oldTime = new Date(Date.now() - 86400000); fs.utimesSync(oldFile, oldTime, oldTime);
  const lease = q.claim('deepseek', { pid: process.pid });
  q.recordScopeEvidence('A', lease.leaseToken, { files: ['old-artifact.txt'], attemptStartedAt: Date.now() - 1000 });
  q.fail('A', lease.leaseToken, ['检测到本任务文件范围外的改动：old-artifact.txt'], { unknownSideEffects: true, attempt: 1 });
  assert.equal(q.get('A').state, 'blocked');
  assert.equal(q.get('A').quarantineReason, 'unconfirmed-exit+unknown-side-effects');
  const notResumed = await runQueuedTasks(f.orch, f.run, plan(), new AbortController().signal, {});
  assert.equal(notResumed.verdict.verdict, 'fail');
  assert.equal(q.get('A').state, 'blocked', '没有明确恢复就一直隔离');
  const resumed = await runQueuedTasks(f.orch, f.run, plan(), new AbortController().signal, {}, { resume: { from: 'failed' } });
  assert.equal(resumed.verdict.verdict, 'pass', JSON.stringify(resumed.verdict.issues));
  assert.equal(q.get('A').state, 'passed');
});

test('老版本只留下文本证据的隔离，也能在恢复时按证据复核（文件都早于那次领取）', async t => {
  const f = fixture(t), q = f.queue();
  q.enqueue(plan().tasks);
  const oldFile = path.join(f.config.workspace, 'legacy-artifact.txt');
  fs.writeFileSync(oldFile, 'old');
  const oldTime = new Date(Date.now() - 86400000); fs.utimesSync(oldFile, oldTime, oldTime);
  const lease = q.claim('deepseek', { pid: process.pid });
  q.fail('A', lease.leaseToken, ['检测到本任务文件范围外的改动：legacy-artifact.txt'], { unknownSideEffects: true, attempt: 1 });
  assert.equal(q.get('A').state, 'blocked');
  assert.equal(q.get('A').scopeEvidence, null, '老任务没有结构化证据，只能从 issues 文本复核');
  const resumed = await runQueuedTasks(f.orch, f.run, plan(), new AbortController().signal, {}, { resume: { from: 'failed' } });
  assert.equal(resumed.verdict.verdict, 'pass', JSON.stringify(resumed.verdict.issues));
  assert.equal(q.get('A').state, 'passed');
});

test('老版本文本证据里若包含本次真的写过的文件，恢复时仍保持隔离', async t => {
  const f = fixture(t), q = f.queue();
  q.enqueue(plan().tasks);
  const lease = q.claim('deepseek', { pid: process.pid });
  // 关键：文件必须在“本次领取之后”才写，才代表它可能真是这次尝试写的（早于领取就是老文件）。
  const freshFile = path.join(f.config.workspace, 'legacy-fresh.txt');
  fs.writeFileSync(freshFile, 'fresh');
  await new Promise(r => setTimeout(r, 5));
  q.fail('A', lease.leaseToken, ['检测到本任务文件范围外的改动：legacy-fresh.txt'], { unknownSideEffects: true, attempt: 1 });
  const resumed = await runQueuedTasks(f.orch, f.run, plan(), new AbortController().signal, {}, { resume: { from: 'failed' } });
  assert.equal(resumed.verdict.verdict, 'fail');
  assert.equal(q.get('A').state, 'blocked', '文件是本次领取之后写的，必须人工核对');
});

test('证据推不翻时（被判越界的文件确实是这次写的）保持隔离，不自动重排', async t => {
  const f = fixture(t), q = f.queue();
  q.enqueue(plan().tasks);
  const freshFile = path.join(f.config.workspace, 'fresh-artifact.txt');
  fs.writeFileSync(freshFile, 'fresh');
  const lease = q.claim('deepseek', { pid: process.pid });
  q.recordScopeEvidence('A', lease.leaseToken, { files: ['fresh-artifact.txt'], attemptStartedAt: Date.now() - 60000 });
  q.fail('A', lease.leaseToken, ['检测到本任务文件范围外的改动：fresh-artifact.txt'], { unknownSideEffects: true, attempt: 1 });
  assert.equal(q.get('A').state, 'blocked');
  const resumed = await runQueuedTasks(f.orch, f.run, plan(), new AbortController().signal, {}, { resume: { from: 'failed' } });
  assert.equal(resumed.verdict.verdict, 'fail');
  assert.equal(q.get('A').state, 'blocked', '文件确实是本次写的，必须人工核对');
  assert.equal(fs.existsSync(path.join(f.config.workspace, 'out.txt')), false);
});
