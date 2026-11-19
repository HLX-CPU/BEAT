// 真实失败回归（R77）：原生会话的沙箱策略在“创建会话”那一刻固定。
// DeepSeek Harness 恢复已有会话时不会改用新的权限预设，所以讨论阶段用只读建起来的会话，
// 执行阶段的 write 会被 [sandbox: file access denied under read-only mode] 直接拒绝：
// R77 因此烧掉 120440/128000 任务预算后受阻，没有产出。
// 控制器必须给需要写权限的角色一条“创建时就是 workspace-write”的固定会话，且仍然只复用、不反复新建。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Roster } from '../src/roster.mjs';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { runQueuedTasks } from '../src/queue-runner.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

// 与 DSH 相同的语义：nativeId 第一次被创建时的 access 就是这条会话的沙箱模式；之后不能升级。
function pinnedAgent(seat, state, work) {
  return async opts => {
    const id = opts.nativeId || seat + '-native-' + (++state.created);
    if (!state.policy.has(id)) state.policy.set(id, opts.access);
    const pinned = state.policy.get(id);
    state.calls.push({ seat, nativeId: opts.nativeId || null, native: id, access: opts.access, pinned, role: opts.role, prompt: opts.prompt });
    opts.onNative?.(id);
    if (opts.access === 'workspace-write' && pinned !== 'workspace-write') {
      // 真实 DSH 的拒绝：模型调用本身成功，但工具被沙箱拦下，执行者只能报告受阻。
      return { text: '结果：受阻。当前会话文件策略为 read-only，两次写操作均被沙箱拒绝。', nativeId: id, usage: { totalTokens: 100, source: 'fixture' } };
    }
    return { ...(await work(opts, id)), nativeId: id };
  };
}
function kvStore(state) {
  const kv = new Map();
  return { get: k => kv.get(k), set: (k, v) => kv.set(k, v), event: (runId, kind, text) => { (state.events ||= []).push({ runId, kind, text }); } };
}
const rosterFixture = (state, agents) => new Roster({ config: { flow: {}, dock: [], secrets: {} }, store: kvStore(state), agents });
const callOf = (roster, sessions) => (seat, role, prompt) => roster.call({ runId: 'R1', sessions, seat, slot: seat + ':' + role, role, cwd: 'E:/fixture', models: { codex: 'c', deepseek: 'd' }, build: () => prompt });

test('DeepSeek 讨论用只读会话、执行用新建的可写会话，两条都在任务内固定复用', async () => {
  const state = { created: 0, policy: new Map(), calls: [] };
  const roster = rosterFixture(state, { deepseek: pinnedAgent('deepseek', state, async () => ({ text: 'reply' })) });
  const sessions = {}, call = callOf(roster, sessions);
  await call('deepseek', 'think', '讨论提纲');
  await call('deepseek', 'write', '执行任务');
  await call('deepseek', 'think', '只读核验');
  await call('deepseek', 'write', '返工');

  assert.deepEqual(state.calls.map(c => c.access), ['read-only', 'workspace-write', 'read-only', 'workspace-write']);
  assert.deepEqual(state.calls.map(c => c.nativeId), [null, null, 'deepseek-native-1', 'deepseek-native-2'], '执行必须新建可写会话，核验回到只读会话，返工复用可写会话');
  assert.equal(state.created, 2, '整个任务只新建两条会话：一条只读、一条可写');
  assert.equal(state.policy.get('deepseek-native-1'), 'read-only');
  assert.equal(state.policy.get('deepseek-native-2'), 'workspace-write');
  assert.ok(sessions['conversation:deepseek']?.native, '只读会话保留');
  assert.equal(sessions['conversation:deepseek:write']?.native, 'deepseek-native-2');
  assert.ok((state.events || []).some(e => /可写沙箱/.test(e.text)), '新建可写会话必须在看板留事件，不静默');
});

test('同一个队列槽位复用：只读调用留下的原生会话不会被可写调用接管', async () => {
  const state = { created: 0, policy: new Map(), calls: [] };
  const roster = rosterFixture(state, { deepseek: pinnedAgent('deepseek', state, async () => ({ text: 'reply' })) });
  const sessions = {};
  const call = role => roster.call({ runId: 'R1', sessions, seat: 'deepseek', slot: 'deepseek:queue', role, cwd: 'E:/fixture', models: { deepseek: 'd' }, build: () => '任务' });
  await call('think');
  assert.equal(sessions['deepseek:queue:deepseek'].native, 'deepseek-native-1', '只读会话记在槽位上');
  await call('write');
  assert.deepEqual(state.calls.map(c => c.nativeId), [null, null], '执行必须另起一条会话，不能复用只读会话 ID');
  assert.equal(state.calls[1].access, 'workspace-write');
  assert.equal(state.policy.get(state.calls[1].native), 'workspace-write');
  assert.notEqual(state.calls[1].native, state.calls[0].native);
});

test('未标记策略的老会话不会被可写角色复用，只读角色仍沿用同一条', async () => {
  const state = { created: 0, policy: new Map(), calls: [] };
  const roster = rosterFixture(state, { deepseek: pinnedAgent('deepseek', state, async () => ({ text: 'reply' })) });
  const sessions = { 'deepseek:deepseek': { native: 'legacy-native', history: [{ role: 'user', content: '旧上下文' }] } };
  const call = callOf(roster, sessions);
  await call('deepseek', 'write', '执行任务');
  assert.equal(state.calls[0].nativeId, null, '可能是只读建起来的老会话不能拿来执行');
  assert.notEqual(sessions['conversation:deepseek:write'].native, 'legacy-native');
  await call('deepseek', 'think', '讨论');
  assert.equal(sessions['conversation:deepseek'].native, 'legacy-native', '只读角色继续沿用老会话，不新建空会话');
  assert.equal(state.created, 1);
});

test('Codex 保持一条固定会话（thread/resume 会重新下发 sandbox），但每次仍按角色声明权限', async () => {
  const state = { created: 0, policy: new Map(), calls: [] };
  const roster = rosterFixture(state, { codex: pinnedAgent('codex', state, async () => ({ text: 'reply' })) });
  const sessions = {}, call = callOf(roster, sessions);
  await call('codex', 'think', '讨论');
  await call('codex', 'write', '执行');
  assert.deepEqual(state.calls.map(c => c.nativeId), [null, 'codex-native-1'], 'Codex 不拆会话');
  assert.deepEqual(state.calls.map(c => c.access), ['read-only', 'workspace-write']);
  assert.equal(state.created, 1);
  assert.equal(sessions['conversation:codex:write'], undefined);
});

test('真实队列：执行角色在可写会话里落盘，非执行搭档独立核验后通过', async t => {
  const parent = artifactsRoot(); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'session-policy-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'fixture-token' }, flow: { ...defaults(root).flow, taskTokenBudget: 20000 } };
  fs.mkdirSync(config.workspace, { recursive: true });
  config.codex.defaultModel = 'fixture-codex'; config.deepseek.defaultModel = 'fixture-deepseek';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  t.after(() => store.close());
  const state = { created: 0, policy: new Map(), calls: [] };
  const agents = {
    deepseek: pinnedAgent('deepseek', state, async (opts, id) => {
      const file = path.join(opts.cwd, 'out.txt'); fs.writeFileSync(file, 'done');
      return { text: JSON.stringify({ summary: '已创建 out.txt', artifacts: [{ path: file, summary: 'done' }], completed: ['写文件'], next: [] }), nativeId: id, usage: { totalTokens: 120, source: 'fixture' } };
    }),
    codex: pinnedAgent('codex', state, async () => ({ text: '{"pass":true,"issues":[]}' })),
  };
  const orch = new Orchestrator({ config, store, agents });
  const run = store.createRun({ kind: 'parallel', goal: '创建 out.txt，内容是 done', cwd: config.workspace, initiator: 'codex', max_rounds: 2, max_turns: 4 });
  const plan = () => ({ tasks: [{ id: 'A', owner: 'deepseek', type: 'workspace', title: '创建结果文件', detail: '写入 out.txt', files: ['out.txt'], acceptance: ['out.txt 内容为 done'], difficulty: 'easy', tokenBudget: 20000 }], acceptance: ['out.txt 内容为 done'], checks: [] });
  // 先走一次真实默认流程里的只读讨论：DSH 因此生成一条只读会话，执行阶段不能复用它。
  const sessions = {};
  await orch.controlCall(run, { role: 'discuss', seat: 'deepseek', slot: 'deepseek:safety', call: 'think', signal: new AbortController().signal, sessions, build: () => '返回简短结果', onlyAgent: true }, { phase: 'discussion', maxOutputTokens: 200 });
  assert.equal(sessions['conversation:deepseek']?.policy, 'read', '讨论建的是只读会话');
  const result = await runQueuedTasks(orch, run, plan(), new AbortController().signal, sessions);
  assert.equal(result.verdict.verdict, 'pass', JSON.stringify(result.verdict));
  assert.equal(fs.readFileSync(path.join(config.workspace, 'out.txt'), 'utf8'), 'done');
  const exec = state.calls.find(c => c.seat === 'deepseek' && c.role === 'write');
  assert.equal(exec.seat, 'deepseek');
  // 客户 2026-10-18 指定：执行者默认管理员权限（完全访问），不再默认 workspace-write。
  assert.equal(exec.access, 'danger-full-access');
  assert.equal(exec.pinned, 'danger-full-access', '执行会话必须是创建时就带完全访问权限的会话');
  assert.notEqual(exec.native, sessions['conversation:deepseek'].native, '执行不能复用只读建起来的会话');
  const review = state.calls.find(c => c.role === 'think' && c.seat === 'codex');
  assert.ok(review, '必须有非执行搭档核验');
  assert.equal(review.access, 'read-only');
  assert.notEqual(review.native, exec.native, '核验者与执行者不是同一条会话');
});