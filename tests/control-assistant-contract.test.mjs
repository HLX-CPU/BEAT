// 助手管线与新控制器的第二个接口契约：
// 1) 幂等/只读任务（"已存在且一致 → 保持不动"）在助手里是 unverified（没有副作用），
//    不能因此直接判失败——否则正确的"无需改动"被反复重跑，最后烧光预算变成假失败（R82 实测）。
// 2) 推理型拓展坞做核验时，600 字输出上限会在出答案前被推理吃光（finish_reason=length），
//    核验要拿到和执行同等的输出余量。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Roster } from '../src/roster.mjs';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { runQueuedTasks } from '../src/queue-runner.mjs';

const DOCK = 'dock:assistant';
const dockConfig = root => ({
  ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 'fixture-token', dockKeys: { [DOCK]: 'test' } },
  dock: [{ id: DOCK, name: 'fixture助手', enabled: true, model: 'fixture-model', baseUrl: 'https://example.invalid/v1' }],
});

function rosterFixture(state, desktopDock) {
  const kv = new Map();
  const store = { get: k => kv.get(k), set: (k, v) => kv.set(k, v), event: (runId, kind, text) => (state.events ||= []).push({ runId, kind, text }) };
  return new Roster({ config: { flow: {}, dock: [{ id: DOCK, enabled: true, model: 'fixture-model', baseUrl: 'https://example.invalid/v1' }], secrets: { dockKeys: { [DOCK]: 'test' } } }, store, agents: { desktopDock } });
}

const benignCalls = [{ tool: 'file_read', status: 'verified', evidence: { sideEffects: 'none', verification: { status: 'verified' } } }];

test('助手报 unverified 但没有任何未知副作用：交给控制器核验，不直接判失败', async () => {
  const state = { events: [] };
  const roster = rosterFixture(state, async () => ({ text: '文件已存在且内容一致，保持不动', desktopTaskId: 'D-readonly', status: 'unverified', calls: benignCalls, history: [], usage: { totalTokens: 100, source: 'fixture' } }));
  const sessions = {};
  const out = await roster.call({ runId: 'R1', sessions, seat: DOCK, slot: DOCK + ':queue', role: 'write', cwd: 'E:/fixture', models: {}, build: () => '任务' });
  assert.equal(out.status, 'unverified');
  assert.match(String(out.assistantUnverified || ''), /只读完成|无需改动/, '要带一条明确说明给审计');
});

test('助手报 unverified 且存在未知副作用 / 状态是 failed：仍然判失败，不放过', async () => {
  const unknown = [{ tool: 'click', status: 'unverified', evidence: { sideEffects: 'unknown' } }];
  const roster1 = rosterFixture({ events: [] }, async () => ({ text: '不确定', desktopTaskId: 'D-x', status: 'unverified', calls: unknown, history: [] }));
  await assert.rejects(() => roster1.call({ runId: 'R1', sessions: {}, seat: DOCK, slot: DOCK + ':queue', role: 'write', cwd: 'E:/fixture', models: {}, build: () => '任务' }), /桌面搭档未完成/);
  const roster2 = rosterFixture({ events: [] }, async () => ({ text: '挂了', desktopTaskId: 'D-y', status: 'failed', calls: benignCalls, history: [] }));
  await assert.rejects(() => roster2.call({ runId: 'R1', sessions: {}, seat: DOCK, slot: DOCK + ':queue', role: 'write', cwd: 'E:/fixture', models: {}, build: () => '任务' }), /桌面搭档未完成/);
});

test('拓展坞做核验时拿到足够的输出余量（推理型模型的答案不会被 600 字上限截断）', async t => {
  const root = fs.mkdtempSync(path.join(artifactsRoot(), 'assistant-contract-'));
  const config = dockConfig(root); fs.mkdirSync(config.workspace, { recursive: true });
  config.codex.defaultModel = 'fixture-codex'; config.deepseek.defaultModel = 'fixture-deepseek';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  const seen = [];
  const agents = {
    codex: async o => { const file = path.join(o.cwd, 'out.txt'); fs.writeFileSync(file, 'done'); const id = o.nativeId || 'cx-1'; o.onNative?.(id); return { text: JSON.stringify({ summary: '已写 out.txt', artifacts: [{ path: file, summary: 'done' }] }), nativeId: id, usage: { totalTokens: 120, source: 'fixture' } }; },
    deepseek: async () => { throw new Error('不该调用 DeepSeek'); },
    dockRead: async (id, args) => { seen.push({ id, maxTokens: args.maxTokens, mode: args.mode, role: args.role }); return { text: '{"pass":true,"issues":[]}', model: 'fixture-model', history: [] }; },
  };
  const orch = new Orchestrator({ config, store, agents });
  const run = store.createRun({ kind: 'parallel', goal: '核验由拓展坞做', cwd: config.workspace, initiator: 'codex', max_rounds: 2, max_turns: 4 });
  // 让拓展坞成为排序第一的核验者
  run.control = { workerMinTokens: id => String(id).startsWith('dock:') ? 100 : 5000 };
  const plan = { tasks: [{ id: 'A', owner: 'codex', type: 'workspace', title: '写 out.txt', detail: '写 out.txt', files: ['out.txt'], acceptance: ['out.txt 内容为 done'], difficulty: 'hard', eligibleWorkers: ['codex'], tokenBudget: 20000 }], acceptance: ['out.txt 内容为 done'], checks: [] };
  const result = await runQueuedTasks(orch, run, plan, new AbortController().signal, {});
  assert.equal(result.verdict.verdict, 'pass', JSON.stringify(result.verdict.issues));
  const review = seen.find(x => x.id === DOCK);
  assert.ok(review, '核验确实由拓展坞执行');
  // 默认 token 只计量不限额：不下发输出上限，拓展坞用自己配置的 maxTokens。
  assert.ok(review.maxTokens === undefined || review.maxTokens >= 1600, '拓展坞核验的输出上限不能是 600，实际=' + review.maxTokens);
  assert.equal(review.role, 'think', '走的是只读角色 think（server.mjs 会给 dockRead 注入 mode=observe）');
});
// 真正的接缝在助手适配器里：executeDesktopPartner 会把 status!=='succeeded' 转成异常。
// 幂等/只读完成必须在这里放行，且只放行“没有任何未知副作用”的那种。
import { executeDesktopPartner } from '../workspaces/shared/desktop-assistant/integration/partner.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

const fakeAssistant = task => ({ start: async () => ({ taskId: task.taskId }), get: () => task, cancel: async () => {}, finishSharedContext: async () => {} });
const assistantTask = extra => ({ taskId: 'D-1', dockId: 'dock:x', status: 'unverified', result: '文件已存在且内容一致，保持不动', error: '', calls: [{ tool: 'file_read', status: 'verified', evidence: { sideEffects: 'none', verification: { status: 'verified' } } }], usage: { totalTokens: 10 }, budgetSpentTokens: 10, ...extra });

test('适配器：只读完成（unverified、无未知副作用）不再直接判失败，交给控制器核验', async () => {
  const out = await executeDesktopPartner({}, 'dock:x', { prompt: 'p', cwd: 'E:/x', mode: 'work' }, { assistant: fakeAssistant(assistantTask({})) });
  assert.equal(out.status, 'unverified');
  assert.match(String(out.assistantUnverified || ''), /只读完成|无需改动/);
});

test('适配器：未知副作用或 failed 仍然抛错，不放过', async () => {
  const unknown = assistantTask({ calls: [{ tool: 'click', status: 'unverified', evidence: { sideEffects: 'unknown' } }] });
  await assert.rejects(() => executeDesktopPartner({}, 'dock:x', { prompt: 'p', cwd: 'E:/x' }, { assistant: fakeAssistant(unknown) }), /桌面搭档未完成/);
  const failed = assistantTask({ status: 'failed', error: '本次模型调用预算已用尽' });
  await assert.rejects(() => executeDesktopPartner({}, 'dock:x', { prompt: 'p', cwd: 'E:/x' }, { assistant: fakeAssistant(failed) }), /桌面搭档未完成/);
});
test('拓展坞先建检查点目录再写检查点，不算越界改动（模型按提示做的是预期行为）', async t => {
  const root = fs.mkdtempSync(path.join(artifactsRoot(), 'checkpoint-scope-'));
  const config = dockConfig(root); fs.mkdirSync(config.workspace, { recursive: true });
  config.codex.defaultModel = 'fixture-codex'; config.deepseek.defaultModel = 'fixture-deepseek';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  const agents = {
    codex: async o => { const id = o.nativeId || 'cx-1'; o.onNative?.(id); return { text: '{"pass":true,"issues":[]}', nativeId: id, usage: { totalTokens: 80, source: 'fixture' } }; },
    deepseek: async () => { throw new Error('不该调用 DeepSeek'); },
    desktopDock: async (id, args) => {
      const file = path.join(args.cwd, 'out.txt'); fs.writeFileSync(file, 'done');
      const checkpoint = /写到\s*(\S+checkpoint\.json)/.exec(String(args.prompt || ''))?.[1];
      const dir = checkpoint ? path.dirname(checkpoint) : null;
      if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(checkpoint, JSON.stringify({ summary: 'done', completed: ['写 out.txt'], next: [], artifacts: [{ path: file, summary: 'done' }] })); }
      return { text: JSON.stringify({ summary: '已写 out.txt', artifacts: [{ path: file, summary: 'done' }] }), desktopTaskId: 'D-cp', status: 'succeeded', model: 'fixture-model', modelVerified: 'unknown',
        calls: [ { tool: 'file_mkdir', args: { path: dir }, status: 'verified', evidence: { sideEffects: 'file-write', verification: { status: 'verified' } } },
                 { tool: 'file_write', args: { path: checkpoint }, status: 'verified', evidence: { sideEffects: 'file-write', verification: { status: 'verified' } } },
                 { tool: 'file_write', args: { path: file }, status: 'verified', evidence: { sideEffects: 'file-write', verification: { status: 'verified' } } } ],
        history: [], usage: { totalTokens: 300, source: 'fixture-assistant', verified: true } };
    },
  };
  const orch = new Orchestrator({ config, store, agents });
  const run = store.createRun({ kind: 'parallel', goal: '拓展坞写文件并留检查点', cwd: config.workspace, initiator: 'codex', max_rounds: 2, max_turns: 4 });
  const plan = { tasks: [{ id: 'task-1', owner: 'codex', type: 'workspace', title: '写 out.txt', detail: '用助手写 out.txt', files: ['out.txt'], acceptance: ['out.txt 内容为 done'], difficulty: 'easy', eligibleWorkers: [DOCK], tokenBudget: 20000 }], acceptance: ['out.txt 内容为 done'], checks: [] };
  const result = await runQueuedTasks(orch, run, plan, new AbortController().signal, {});
  assert.equal(result.verdict.verdict, 'pass', JSON.stringify(result.verdict.issues));
  assert.ok(fs.existsSync(path.join(config.workspace, '.beat-control', run.id, 'task-1', 'checkpoint.json')), '检查点确实写了，而且没有被当成越界');
});
