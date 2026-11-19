// 回归：任务缺文件范围必须在开工前发现并自纠，而不是花完讨论钱后死在执行入口（R2 实测）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { defaults } from '../src/config.mjs';
import { inferTaskFiles, inferPlanFiles, normalizeTaskFiles, planStructureIssues } from '../src/plan-structure.mjs';
import { prepareQueuedTasks } from '../src/queue-runner.mjs';
import { customerIssue, runCustomerIssue } from '../src/customer-issue.mjs';
import { customerPresentation } from '../src/customer-presentation.mjs';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-structure-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 't', claudeApiKey: 'sk-test-key-123456' } };
  config.claude = { ...config.claude, baseUrl: 'https://example.invalid', model: 'claude-fixture' };
  config.codex = { ...config.codex, defaultModel: 'codex-fixture' };
  config.deepseek = { ...config.deepseek, defaultModel: 'deepseek-fixture' };
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  const orch = new Orchestrator({ config, store, agents: {} });
  return { root, config, store, orch };
}
const runOf = (store, config, plan) => {
  const run = store.createRun({ kind: 'parallel', goal: '在桌面创建一个能运行的简单的计算机软件', cwd: config.root, initiator: 'codex' });
  if (plan !== undefined) store.updateRun(run.id, { plan });
  return store.run(run.id);
};

test('文件范围归一：字符串、{path}、数组都能用，重复项去掉', () => {
  assert.deepEqual(normalizeTaskFiles('a.py'), ['a.py']);
  assert.deepEqual(normalizeTaskFiles({ path: 'src/b.js' }), ['src/b.js']);
  assert.deepEqual(normalizeTaskFiles(['a.md', 'a.md', { file: 'b.md' }]), ['a.md', 'b.md']);
  assert.deepEqual(normalizeTaskFiles(undefined), []);
});

test('能推断的由代码补：产出引用和任务说明里点名的文件', () => {
  assert.deepEqual(inferTaskFiles({ outputRefs: [{ path: 'src/app.py' }] }), ['src/app.py']);
  assert.deepEqual(inferTaskFiles({ detail: '请创建 index.html 和 README.md' }), ['index.html', 'README.md']);
  assert.deepEqual(inferTaskFiles({ detail: '写入 a.py、b.py，并生成 tests/test_a.py' }), ['a.py', 'b.py', 'tests/test_a.py']);
  assert.deepEqual(inferTaskFiles({ detail: '打开 https://example.com/a.py 看看' }), [], '网址不是产出文件');
  assert.deepEqual(inferTaskFiles({ type: 'desktop', detail: '创建 a.py' }), [], '电脑操作任务不要求文件范围');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-files-'));
  assert.deepEqual(inferTaskFiles({ detail: '写入 ' + path.join(root, 'inside.py') }, { cwd: root }), [path.join(root, 'inside.py').replaceAll('\\', '/')]);
  assert.deepEqual(inferTaskFiles({ detail: '写入 ' + path.join(os.tmpdir(), 'outside-xyz.py') }, { cwd: root }), [], '任务目录外的绝对路径不猜');
  assert.equal(inferPlanFiles({ tasks: [{ id: 'task-1', detail: '实现并写入 calculator.py' }, { id: 'task-2', title: '整理说明' }] }).changes.length, 1);
});

test('方案预检在开工前报告缺文件范围（带任务编号和可执行修法）', () => {
  const { root } = setup();
  const issues = planStructureIssues({ acceptance: ['整体完成'], tasks: [{ id: 'task-1', title: '实现一个计算器' }] }, { cwd: root });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].section, 'tasks.task-1');
  assert.equal(issues[0].kind, 'files');
  assert.match(issues[0].problem, /文件范围/);
  assert.match(issues[0].problem, /调研/);
  assert.deepEqual(planStructureIssues({ acceptance: ['整体完成'], tasks: [{ id: 'task-1', files: ['app.py'] }] }, { cwd: root }), []);
  assert.deepEqual(planStructureIssues({ acceptance: ['打开即可'], tasks: [{ id: 'open', type: 'desktop', title: '打开计算器' }] }, { cwd: root }), []);
  const withoutAcceptance = planStructureIssues({ tasks: [{ id: 'task-1', files: ['app.py'] }] }, { cwd: root });
  assert.ok(withoutAcceptance.some(issue => issue.kind === 'acceptance'));
  const badDeps = planStructureIssues({ acceptance: ['完成'], tasks: [{ id: 'task-1', files: ['app.py'], dependsOn: ['task-9'] }] }, { cwd: root });
  assert.ok(badDeps.some(issue => issue.kind === 'dependencies'));
});

test('编排器预检接入结构规则：缺文件范围时作者能拿到问题，执行入口不再先跑到', () => {
  const { config, store, orch } = setup();
  try {
    const run = runOf(store, config);
    const issues = orch.preflightPlan(run, { acceptance: ['整体完成'], tasks: [{ id: 'task-1', title: '实现一个计算器' }] });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'files');
    assert.deepEqual(orch.preflightPlan(run, { acceptance: ['整体完成'], tasks: [{ id: 'task-1', files: ['calculator.py'], title: '实现' }] }), []);
  } finally { store.close(); }
});

test('方案编译时推断文件范围并留痕，客户不需要重新描述目标', () => {
  const { config, store, orch } = setup();
  try {
    const run = runOf(store, config);
    const compiled = orch.compileControlledPlan(run, { tasks: [{ id: 'task-1', title: '实现计算器', detail: '实现并写入 calculator.py' }] });
    assert.deepEqual(compiled.tasks[0].files, ['calculator.py']);
    assert.ok(store.events(10).some(row => row.run_id === run.id && /补上/.test(row.text)), '补文件范围要留痕');
  } finally { store.close(); }
});

test('执行入口守底线：补不出文件范围时报结构错误（人话出口），能补的不拦', () => {
  assert.throws(() => prepareQueuedTasks({ tasks: [{ id: 'task-1', title: '实现一个软件', acceptance: ['能运行'] }] }, ['codex'], {}),
    error => error.code === 'PLAN_STRUCTURE' && error.structureKind === 'files' && /文件范围/.test(error.message));
  const tasks = prepareQueuedTasks({ tasks: [{ id: 'task-1', title: '实现', detail: '写入 a.py', acceptance: ['能运行'] }] }, ['codex'], {});
  assert.deepEqual(tasks[0].files, ['a.py']);
  assert.deepEqual(tasks[0].inferredFiles, ['a.py']);
});

test('续跑旧任务：能按说明补文件范围就补；补不上改为重新拟方案，不原样重放', () => {
  const { config, store, orch } = setup();
  try {
    const run = runOf(store, config, { acceptance: ['能运行'], tasks: [{ id: 'task-1', title: '实现计算器', detail: '实现并写入 calculator.py' }] });
    const plan = orch.prepareResumedPlan(run);
    assert.ok(plan);
    assert.deepEqual(plan.tasks[0].files, ['calculator.py']);

    const blocked = runOf(store, config, { acceptance: ['能运行'], tasks: [{ id: 'task-1', title: '做一个简单软件' }] });
    assert.equal(orch.prepareResumedPlan(blocked), null);
    assert.equal(store.run(blocked.id).plan, null, '旧方案清掉，交回讨论重新出方案');
    assert.ok(store.events(10).some(row => row.run_id === blocked.id && /重新拟定方案/.test(row.text)));
  } finally { store.close(); }
});

test('客户文案：方案缺文件时说明没开工、没改文件，并给“重新拟方案并继续”', () => {
  const view = {
    id: 'R2', kind: 'parallel', state: 'error', goal: '在桌面创建一个能运行的简单的计算机软件',
    error: '方案里的任务没有写清要交付哪些文件，BEAT 没有开工，也没有修改任何文件。',
    failureCode: 'PLAN_STRUCTURE', failureStructureKind: 'files', tokenUsage: { totalTokens: 98005 }, steps: [],
  };
  const issue = runCustomerIssue(view);
  assert.equal(issue.title, '方案缺了要交付的文件，还没开工');
  assert.match(issue.message, /没有派发执行/);
  assert.equal(issue.fileStatus, '本次没有派发执行，未修改任务文件。');
  assert.deepEqual(issue.actions.map(a => a.id), ['resume', 'inspect']);
  assert.equal(issue.actions[0].label, '重新拟方案并继续');

  const legacy = customerIssue('每个文件任务必须划定文件范围：task-1', { run: { kind: 'parallel', state: 'error' }, tokens: 98005 });
  assert.equal(legacy.title, '方案缺了要交付的文件，还没开工');
  assert.equal(legacy.fileStatus, '本次没有派发执行，未修改文件。');
  assert.deepEqual(legacy.actions.map(a => a.id), ['resume', 'inspect']);
});

test('已用时按任务创建时间算，不会因为执行阶段重置而显示 0 分 0 秒', () => {
  const presentation = customerPresentation({
    state: 'error', created_at: '2026-10-18T02:00:00.000Z', ended_at: '2026-10-18T02:12:00.000Z',
    error: '每个文件任务必须划定文件范围：task-1', steps: [],
  });
  assert.equal(presentation.elapsedSeconds, 720);
  assert.equal(presentation.label, '方案缺文件，没有开工');
});

test('PDF 任务的视觉验收在开工前被指出：可改机器检查，不能靠执行者自证（R408 回归）', () => {
  const { root } = setup();
  const base = { tasks: [{ id: 'task-1', title: '生成 PDF', files: ['out/report.pdf'], acceptance: ['PDF 文件存在且大于 20KB', '逐页目视中文无乱码，文字可选中'] }] };
  const issues = planStructureIssues(base, { cwd: root });
  const render = issues.find(issue => issue.kind === 'render');
  assert.ok(render, 'PDF 视觉验收必须被指出');
  assert.equal(render.section, 'tasks.task-1');
  assert.match(render.problem, /不会渲染 PDF/);
  assert.match(render.problem, /机器检查/);
  // 换成带机器检查对象的验收就放行；非 PDF 任务不受影响。
  const machine = { tasks: [{ id: 'task-1', title: '生成 PDF', files: ['out/report.pdf'], acceptance: [{ text: '逐页目视中文无乱码', check: 'node --test tests/pdf.test.mjs' }] }] };
  assert.equal(planStructureIssues(machine, { cwd: root }).filter(issue => issue.kind === 'render').length, 0);
  const html = { tasks: [{ id: 'task-1', title: '页面', files: ['index.html'], acceptance: ['画面清晰，无裁切'] }] };
  assert.equal(planStructureIssues(html, { cwd: root }).filter(issue => issue.kind === 'render').length, 0);
});
