// 15 元用户实测（2026-10-19）P1/P2/P3 修复回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { inferPlanFiles } from '../src/plan-structure.mjs';
import { reportedExecutionPaths } from '../src/queue-runner.mjs';
import { validateCallInput } from '../src/server.mjs';
import { TOOLS } from '../src/tools.mjs';
import { customerIssue } from '../src/customer-issue.mjs';
import { addWorkspaceGrant, listWorkspaceGrants, removeWorkspaceGrant } from '../src/workspace-access.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

function fixture(t, tag = 'review15') {
  const root = cleanup(t, tempDir(tag));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 'fixture' } };
  config.codex.defaultModel = 'codex-fixture';
  config.deepseek.defaultModel = 'deepseek-fixture';
  fs.mkdirSync(config.workspace, { recursive: true });
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  t.after(() => store.close());
  const orch = new Orchestrator({ config, store, agents: {} });
  return { root, config, store, orch };
}

test('P1-1：方案已写部分文件时，仍补全目标里点名的 check.py（R499 假阴性根因）', () => {
  const plan = { tasks: [{
    id: 'task-1', owner: 'codex', type: 'workspace', title: '新建指定文本文件并逐个读回',
    detail: '1) 创建 hello.txt，内容恰好是 BEAT-EVAL-OK；2) 创建 check.py，读取 hello.txt 并打印 SHA-256；3) 把输出记录在 result.txt 中。',
    files: ['hello.txt', 'result.txt'], acceptance: ['三个文件正确'],
  }] };
  const before = JSON.stringify(plan);
  const { plan: next, changes } = inferPlanFiles(plan, { cwd: 'E:\beat\workspaces\eval' });
  assert.deepEqual(next.tasks[0].files, ['hello.txt', 'result.txt', 'check.py']);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].id, 'task-1');
  assert.deepEqual(changes[0].files, ['check.py']);
  assert.equal(changes[0].merged, true);
  assert.equal(JSON.stringify(plan), before, '原始方案不能被改写');
});

test('P1-1：不抢别的任务已声明的文件', () => {
  const plan = { tasks: [
    { id: 'a', type: 'workspace', detail: '创建 a.txt 和 b.txt', files: ['a.txt'], acceptance: ['x'] },
    { id: 'b', type: 'workspace', detail: '修改 b.txt', files: ['b.txt'], acceptance: ['x'] },
  ] };
  const { plan: next, changes } = inferPlanFiles(plan, { cwd: 'E:\beat\workspaces\eval' });
  assert.deepEqual(next.tasks[0].files, ['a.txt']);
  assert.equal(changes.length, 0);
});

test('P1-1：执行者交付报告里的产物路径是可归因写入，不会被当成来源不明', () => {
  const paths = reportedExecutionPaths({ artifacts: [
    { path: 'E:\\work\\check.py' }, 'hello.txt', { summary: '没有路径' }, { path: '  ' },
  ] });
  assert.deepEqual(paths, ['E:\\work\\check.py', 'hello.txt']);
});

test('P1-2：未知副作用的继续提示给出命令行解除入口', (t) => {
  const { store, orch } = fixture(t);
  const run = store.createRun({ kind: 'parallel', goal: '交付', cwd: store.get('x') ? '' : orch.config.workspace, initiator: 'codex' });
  store.updateRun(run.id, { state: 'failed', ended_at: new Date().toISOString() });
  store.set('taskQueue:' + run.id, [{ id: 'task-1', state: 'blocked', sideEffects: 'unknown' }]);
  assert.throws(() => orch.assertResumeEvidence(store.run(run.id)), /src[\\/]cli\.mjs release/);
});

test('P2-2：轮数参数被调整时，立即返回请求值与实际值', async () => {
  const fake = {
    config: { flow: {} },
    roster: { status: () => ({}) },
    startParallel: () => ({ id: 'R900', state: 'queued' }),
    store: { get: key => key === 'maxRoundsAdjustment:R900' ? { requested: 2, applied: 1, reason: 'start-clamp' } : null },
  };
  const result = await TOOLS.beat_parallel.run(fake, { goal: '写一个文件' });
  assert.equal(result.id, 'R900');
  assert.equal(result.maxRoundsAdjustment.requested, 2);
  assert.equal(result.maxRoundsAdjustment.applied, 1);
});

test('P2-3：暂停的搭档不能被直接提问，提示先恢复', (t) => {
  const { orch } = fixture(t);
  orch.roster.state = () => ({ status: 'online', paused: true });
  const run = orch.startAsk({ to: 'codex', question: '现在几点', access: 'read-only' });
  assert.equal(run.state, 'error');
  assert.match(run.error, /已手动暂停/);
});

test('P2-3：暂停的搭档不能被追问', (t) => {
  const { store, orch } = fixture(t);
  const run = store.createRun({ kind: 'ask', goal: '旧任务', cwd: orch.config.workspace, target: 'codex', access: 'read-only' });
  store.updateRun(run.id, { state: 'done', ended_at: new Date().toISOString() });
  orch.roster.state = () => ({ status: 'online', paused: true });
  assert.throws(() => orch.startFollowup({ id: run.id, question: '继续说说' }), /已手动暂停/);
});

test('P2-4：已说明“没有派发/没有产生费用”的错误文案，费用与文件状态保持一致', () => {
  const issue = customerIssue('Codex 已手动暂停，本次没有派发，也没有产生模型费用；请先恢复', { run: { state: 'error', kind: 'ask', access: 'read-only' }, steps: [] });
  assert.match(issue.costStatus, /没有产生模型费用/);
  assert.doesNotMatch(issue.costStatus, /尚未取得/);
  assert.match(issue.fileStatus, /未修改文件/);
});

test('P2-4：取消发生在调用模型之前，明确说没有产生费用', () => {
  const issue = customerIssue('用户取消', { run: { state: 'cancelled', kind: 'discuss', access: 'read-only' }, steps: [] });
  assert.match(issue.costStatus, /取消发生在调用模型之前，未产生模型费用/);
  const billed = customerIssue('用户取消', { run: { state: 'cancelled', kind: 'discuss', access: 'read-only' }, steps: [{}], tokens: 120 });
  assert.match(billed.costStatus, /120/);
});

test('P3-1：非法枚举报错给出可填值，而不是拼接文本', () => {
  assert.throws(() => validateCallInput({ name: 'model_list', args: { provider: 'gemini' } }), error => {
    assert.match(error.message, /参数 provider 的取值不正确/);
    assert.match(error.message, /codex \/ deepseek/);
    return true;
  });
});

test('P3-2：负数或超上限的 wait_seconds 在派发前被拒', () => {
  assert.throws(() => validateCallInput({ name: 'beat_get', args: { id: 'R1', wait_seconds: -5 } }), /不能小于 0/);
  assert.throws(() => validateCallInput({ name: 'beat_get', args: { id: 'R1', wait_seconds: 300 } }), /不能大于 280/);
  assert.doesNotThrow(() => validateCallInput({ name: 'beat_get', args: { id: 'R1', wait_seconds: 0 } }));
});

test('P3-3：beat_get 的 fields 只返回请求字段，id/finished 始终保留', async () => {
  const view = { id: 'R1', finished: true, state: 'passed', result: 'ok', steps: [{ id: 1 }], customerIssue: null };
  const fake = { waitFor: async () => view };
  const picked = await TOOLS.beat_get.run(fake, { id: 'R1', fields: ['state', 'result'] });
  assert.deepEqual(Object.keys(picked).sort(), ['finished', 'id', 'result', 'state']);
  assert.equal(picked.steps, undefined);
});

test('P3-4：拓展坞也能暂停/恢复，非法搭档给人话', () => {
  assert.equal(TOOLS.beat_agents.schema.properties.agent.enum, undefined, 'agent 不能再限定三席');
  const calls = [];
  const fake = { roster: { allAgents: () => ['codex', 'deepseek', 'claude', 'dock:x'], setPaused: (agent, paused) => { calls.push([agent, paused]); return { ok: true }; } } };
  const paused = TOOLS.beat_agents.run(fake, { agent: 'dock:x', action: 'pause' });
  assert.deepEqual(paused, { ok: true });
  assert.deepEqual(calls, [['dock:x', true]]);
  assert.throws(() => TOOLS.beat_agents.run(fake, { agent: 'gpt', action: 'pause' }), /没有找到你指定的搭档/);
});

test('P1-3：命令行可以授权文件夹，写的是与看板相同的授权记录', (t) => {
  const root = cleanup(t, tempDir('folders'));
  const config = { dataDir: path.join(root, 'data') };
  const folder = path.join(root, '项目目录');
  fs.mkdirSync(folder, { recursive: true });
  const added = addWorkspaceGrant(config, folder, 'workspace-write');
  assert.equal(added.added, true);
  const duplicate = addWorkspaceGrant(config, folder, 'workspace-write');
  assert.equal(duplicate.added, false);
  const list = listWorkspaceGrants(config);
  assert.equal(list.length, 1);
  assert.equal(list[0].access, 'workspace-write');
  assert.equal(removeWorkspaceGrant(config, folder).removed, 1);
  assert.deepEqual(listWorkspaceGrants(config), []);
  assert.throws(() => addWorkspaceGrant(config, path.join(root, 'not-exists')), /没有找到这个文件夹/);
});
