// 整合回归：多智能桌面助手（拓展坞＋助手工具管线）要能在新控制器里真正被执行，而不是只能发言。
// 关键链路：方案里写 eligibleWorkers（明确指定搭档）→ parsePlan 保留 → validatePlan 校验必须是本次参与者
// → 拉取队列只让指定搭档领取 → roster 走 desktopDock（助手工具管线）→ 证据/归因 → 非执行者核验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePlan } from '../src/prompts.mjs';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { TaskQueue } from '../src/task-queue.mjs';
import { runQueuedTasks, taskRouting } from '../src/queue-runner.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

const DOCK = 'dock:assistant';
const baseConfig = root => ({
  ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 'fixture-token', dockKeys: { [DOCK]: 'test' } },
  dock: [{ id: DOCK, name: 'fixture助手', enabled: true, model: 'fixture-model', baseUrl: 'https://example.invalid/v1' }],
});

test('R166 回归：owner 留空不算无效分派，方案照常成立并由控制器按难度路由', () => {
  // 实测：模型产出 4 个任务（都有验收与检查）但 owner 留空，旧逻辑把整份方案判为无效、
  // 直接报"完整方案缺少有效的小任务和验收标准"——方案是好的，只是没指定负责人。
  const raw = { tasks: [
    { id: 'task-1', owner: '', title: '解析求值', detail: '写 function_parser.py', type: 'workspace', files: ['function_parser.py'], acceptance: ['合法表达式求值正确'] },
    { id: 'task-2', owner: undefined, title: '绘图', detail: '写 plotter.py', type: 'workspace', files: ['plotter.py'], dependsOn: ['task-1'], acceptance: ['1/x 不崩溃'] },
  ], acceptance: ['整体可用'], checks: [] };
  const plan = parsePlan(raw);
  assert.ok(plan, 'owner 留空不得把整份方案判死');
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks.map(t => t.owner), ['', ''], '空 owner 原样保留为空串，交给 taskRouting 路由');
  // 下游：空 owner 也能算出可领取的搭档，而不是没人能干
  const routed = taskRouting({ ...plan.tasks[0], tokenBudget: 200000 }, ['codex', 'deepseek'], { difficultyRouting: true, cheapAgents: ['deepseek'] });
  assert.ok(routed.eligibleWorkers.length, '空 owner 的任务必须能路由到在线搭档：' + JSON.stringify(routed));
  // 真正无法识别的写法仍然拒绝（不能被这次放宽带过去）
  assert.equal(parsePlan({ tasks: [{ id: 'A', owner: 'not-a-partner', title: 'x', files: ['a.txt'] }] }), null);
  assert.equal(parsePlan({ tasks: [{ id: 'A', owner: 'codex' }] }), null, '缺标题/说明仍然无效');
});

test('方案里的 eligibleWorkers 被保留；无效项剔除，不填就没有这个字段', () => {
  const raw = { tasks: [{ id: 'A', owner: 'codex', title: '看图任务', files: ['out.txt'], eligibleWorkers: ['dock:assistant', 'codex', 'not-a-partner', 'dock:assistant'], difficulty: 'easy' },
    { id: 'B', owner: 'deepseek', title: '普通任务', files: ['b.txt'] }], acceptance: ['都完成'], checks: [] };
  const plan = parsePlan(raw);
  assert.deepEqual(plan.tasks[0].eligibleWorkers, ['dock:assistant', 'codex'], '去掉无效项和重复项，保留顺序');
  assert.equal('eligibleWorkers' in plan.tasks[1], false, '没填就不生造这个限制');
});

test('空数组/字符串/空值都按"不限制"处理，只有识别不出来的写法才拒（并给出可改的报错）', () => {
  const plan = parsePlan({ tasks: [
    { id: 'A', owner: 'codex', title: 'a', files: ['a.txt'], eligibleWorkers: [] },
    { id: 'B', owner: 'codex', title: 'b', files: ['b.txt'], eligibleWorkers: 'deepseek' },
    { id: 'C', owner: 'codex', title: 'c', files: ['c.txt'], eligibleWorkers: null },
    { id: 'D', owner: 'codex', title: 'd', files: ['d.txt'], eligibleWorkers: ['  DOCK:ASSISTANT '] },
    { id: 'E', owner: 'codex', title: 'e', files: ['e.txt'], eligibleWorkers: ['由执行搭档完成'] },
  ], acceptance: ['ok'], checks: [] });
  assert.equal('eligibleWorkers' in plan.tasks[0], false, '空数组 = 不限制，不能变成"必须非空"的硬错误（R86 就是这么挂的）');
  assert.deepEqual(plan.tasks[1].eligibleWorkers, ['deepseek'], '写成字符串按一项处理，这是明确的意图');
  assert.equal('eligibleWorkers' in plan.tasks[2], false, 'null 等同不填');
  assert.deepEqual(plan.tasks[3].eligibleWorkers, ['DOCK:ASSISTANT'], '去除首尾空格并保留 dock 原样 ID');
  assert.deepEqual(plan.tasks[4].eligibleWorkersRaw, ['由执行搭档完成'], '识别不出来的写法保留原文，交给校验报错，不静默改派');
});

test('validatePlan 只接受本次参与的指定搭档；空数组不拦，识别不出来的给可改的报错', () => {
  const root = fs.mkdtempSync(path.join(artifactsRoot(), 'pin-'));
  const config = baseConfig(root);
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  try {
    const orch = new Orchestrator({ config, store, agents: {} });
    const run = store.createRun({ kind: 'parallel', goal: '指定搭档', cwd: config.workspace, initiator: 'codex', max_rounds: 2, max_turns: 4 });
    const task = extra => ({ id: 'A', owner: 'codex', type: 'workspace', title: 't', detail: 'd', files: ['a.txt'], acceptance: ['ok'], ...extra });
    assert.doesNotThrow(() => orch.validatePlan(run, { tasks: [task({ eligibleWorkers: [DOCK] })] }), '拓展坞是本次参与者');
    assert.throws(() => orch.validatePlan(run, { tasks: [task({ eligibleWorkers: ['dock:ghost'] })] }), /未参与/, '没参与的一方不能被指定');
    assert.doesNotThrow(() => orch.validatePlan(run, { tasks: [task({ eligibleWorkers: [] })] }), '空数组表示不限制');
    assert.throws(() => orch.validatePlan(run, { tasks: [task({ eligibleWorkersRaw: ['由执行搭档完成'] })] }), /无法识别/, '识别不出来的写法必须报错，且报错里带原文');
    assert.doesNotThrow(() => orch.validatePlan(run, { tasks: [task({})] }), '不填就是不限制');
  } finally { store.close(); }
});

test('指定给拓展坞的简单任务不会被轻量/强搭档抢走', async t => {
  const root = fs.mkdtempSync(path.join(artifactsRoot(), 'pin-route-'));
  const config = baseConfig(root); fs.mkdirSync(config.workspace, { recursive: true });
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  const run = store.createRun({ kind: 'parallel', goal: '指定拓展坞', cwd: config.workspace, initiator: 'codex', max_rounds: 2, max_turns: 4 });
  const workers = ['codex', 'deepseek', DOCK];
  const control = { cheapAgents: ['deepseek'], strongAgent: 'codex' };
  const pinned = { id: 'A', title: '看图并写文件', difficulty: 'easy', eligibleWorkers: [DOCK], tokenBudget: 20000 };
  assert.deepEqual(taskRouting(pinned, workers, control).eligibleWorkers, [DOCK], '明确指定优先于难度路由');
  assert.deepEqual(taskRouting({ ...pinned, eligibleWorkers: undefined }, workers, control).eligibleWorkers, ['deepseek'], '不填就还是按难度走轻量搭档');
  const q = new TaskQueue({ store, runId: run.id, cwd: run.cwd, workers, strongAgent: 'codex', leaseMs: 120000 });
  q.enqueue([{ id: 'A', owner: 'codex', type: 'workspace', title: '看图并写文件', detail: '用助手写 out.txt', files: ['out.txt'], acceptance: ['out.txt 内容正确'], difficulty: 'easy', eligibleWorkers: [DOCK], tokenBudget: 20000 }]);
  assert.equal(q.claim('codex', { pid: process.pid }), null, '轻量/强搭档都不能领');
  assert.equal(q.claim('deepseek', { pid: process.pid }), null);
  const claimed = q.claim(DOCK, { pid: process.pid });
  assert.equal(claimed?.executor, DOCK);
});

test('新控制器把拓展坞任务交给助手管线执行，并由非执行者核验通过', async t => {
  const root = fs.mkdtempSync(path.join(artifactsRoot(), 'pin-e2e-'));
  const config = baseConfig(root); fs.mkdirSync(config.workspace, { recursive: true });
  config.codex.defaultModel = 'fixture-codex'; config.deepseek.defaultModel = 'fixture-deepseek';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  const seen = [];
  const agents = {
    codex: async o => { seen.push({ seat: 'codex', role: o.role, access: o.access }); const id = o.nativeId || 'cx-1'; o.onNative?.(id); return { text: '{"pass":true,"issues":[]}', nativeId: id, usage: { totalTokens: 80, source: 'fixture' } }; },
    deepseek: async () => { throw new Error('这个任务指定了拓展坞，不应调用 DeepSeek'); },
    // 助手管线（真实实现是 executeDesktopPartner）：模型直调 file_write，返回已验证副作用证据。
    desktopDock: async (id, args) => {
      seen.push({ seat: id, role: args.role, executionScope: args.executionScope, parallelPartner: args.parallelPartner, prompt: String(args.prompt || '').slice(0, 60), cwd: args.cwd });
      const file = path.join(args.cwd, 'out.txt'); fs.writeFileSync(file, 'done');
      const sha = 'fixture-sha';
      return { text: JSON.stringify({ summary: '助手已写 out.txt' }), desktopTaskId: 'D-fixture', status: 'succeeded', model: 'fixture-model', modelVerified: 'unknown', actualModel: null,
        calls: [{ callId: 'c1', tool: 'file_write', args: { path: file, content: 'done' }, status: 'verified', evidence: { sideEffects: 'file-write', verification: { status: 'verified' } } },
          { callId: 'c2', tool: 'window_list', args: {}, status: 'verified', evidence: { sideEffects: 'none', verification: { status: 'verified' } } }],
        history: [], usage: { totalTokens: 300, source: 'fixture-assistant', verified: true } };
    },
  };
  const orch = new Orchestrator({ config, store, agents });
  const run = store.createRun({ kind: 'parallel', goal: '拓展坞用助手写文件', cwd: config.workspace, initiator: 'codex', max_rounds: 2, max_turns: 4 });
  const plan = parsePlan({ tasks: [{ id: 'A', owner: 'codex', title: '助手写 out.txt', detail: '用助手文件工具写 out.txt', type: 'workspace', files: ['out.txt'], acceptance: ['out.txt 内容为 done'], difficulty: 'easy', eligibleWorkers: [DOCK] }], acceptance: ['out.txt 内容为 done'], checks: [] });
  const result = await runQueuedTasks(orch, run, plan, new AbortController().signal, {});
  assert.equal(result.verdict.verdict, 'pass', JSON.stringify(result.verdict.issues));
  assert.equal(fs.readFileSync(path.join(config.workspace, 'out.txt'), 'utf8'), 'done');
  const dockCall = seen.find(x => x.seat === DOCK);
  assert.ok(dockCall, '执行必须走拓展坞的助手管线');
  assert.ok(dockCall.prompt.length > 0, '交给助手的是本任务的提示词');
  assert.equal(dockCall.executionScope, 'workspace', '助手有完整的文件/命令/桌面工具');
  assert.equal(dockCall.parallelPartner, true);
  assert.ok(seen.some(x => x.seat === 'codex'), '非执行者核验由别的搭档完成');
  const task = store.get('taskQueue:' + run.id)[0];
  assert.equal(task.executor, DOCK);
  assert.equal(task.state, 'passed');
  assert.equal(task.reviewer, 'codex');
});
