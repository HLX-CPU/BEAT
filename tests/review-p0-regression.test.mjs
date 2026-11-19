// 测评问题清单 P0 回归：路径、重试幂等、简单问题直答、自动恢复上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { literalFileScope, alignPlanToUserPaths } from '../src/literal-files.mjs';
import { isAnswerOnlyGoal } from '../src/compact-discussion.mjs';
import { autoRecoveryDecision } from '../src/orchestrator.mjs';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { runQueuedTasks } from '../src/queue-runner.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

const R468_GOAL = '一个面向个人用户的 AI 多方协作服务，最影响用户口碑的 3 条体验标准是什么？各给一条可验收的检查方法。要求具体、可执行，总字数不超过 300 字。';

test('R469 回归：用户在目标里写出的子目录必须保留在文件范围里', t => {
  const root = cleanup(t, tempDir('p0-path'));
  const goal = '在 ' + path.join(root, 'beat-review') + '\\ 目录中新建 hello.md，正文为不超过 40 个汉字的一句话。';
  assert.deepEqual(literalFileScope(goal, root), ['beat-review/hello.md']);
  assert.deepEqual(literalFileScope('新建 docs/notes/a.md，正文为 hi', root), ['docs/notes/a.md']);
  assert.deepEqual(literalFileScope('创建 alpha.txt，内容为 A；创建 beta.txt，内容为 B；读回 alpha.txt', root), ['alpha.txt', 'beta.txt']);
  // 绝对路径在 cwd 之外不走直执行快路径；已存在的文件也不走。
  assert.deepEqual(literalFileScope('在 ' + path.join(root, '..') + '\\ 目录中新建 x.md，正文为 x', root), []);
  fs.writeFileSync(path.join(root, 'exists.md'), 'OLD');
  assert.deepEqual(literalFileScope('创建 exists.md，内容为 NEW', root), []);
});

test('R469 回归：协商方案里丢掉目录的文件名，按用户原话补回目录', t => {
  const root = cleanup(t, tempDir('p0-align'));
  const goal = '在 ' + path.join(root, 'beat-review') + '\\ 目录中新建 hello.md，正文为 hi';
  const plan = { tasks: [{ id: 'task-1', files: ['hello.md', 'other.md'], acceptance: [{ text: '读取 hello.md，内容符合用户原话', machine: false }] }], acceptance: [{ text: '读取 hello.md，内容符合用户原话' }] };
  const aligned = alignPlanToUserPaths(plan, goal, root);
  assert.deepEqual(aligned.tasks[0].files, ['beat-review/hello.md', 'other.md']);
  assert.match(aligned.tasks[0].acceptance[0].text, /beat-review\/hello\.md/);
  assert.match(aligned.acceptance[0].text, /beat-review\/hello\.md/);
  assert.deepEqual(plan.tasks[0].files, ['hello.md', 'other.md'], '不能改写原方案对象');
});

test('R469 回归：快路径任务的文件范围与验收都按用户路径，重试语义写清楚', t => {
  const root = cleanup(t, tempDir('p0-plan'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 'fixture' } };
  config.codex.defaultModel = 'fixture-codex'; config.deepseek.defaultModel = 'fixture-deepseek';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  const orch = new Orchestrator({ config, store, agents: {} }); orch.pump = () => {};
  const goal = '在 ' + path.join(root, 'beat-review') + '\\ 目录中新建 hello.md，正文为不超过 40 个汉字的一句话：BEAT 并联协作测评占位文件，仅用于验收。';
  const run = store.createRun({ kind: 'parallel', initiator: 'codex', cwd: root, goal });
  const candidate = orch.fastPathPlan(run);
  assert.equal(candidate.eligible, true, JSON.stringify(candidate.reasons));
  assert.deepEqual(candidate.plan.tasks[0].files, ['beat-review/hello.md']);
  const acceptance = candidate.plan.acceptance.map(item => item.text).join('\n');
  assert.match(acceptance, /任务开始前已存在的同名文件不得覆盖/);
  assert.match(acceptance, /重试.*允许覆盖或重建/);
});

test('R468 回归：有明确字数上限的文本答案走直答，不进入方案评审', () => {
  assert.equal(isAnswerOnlyGoal(R468_GOAL), true, '300 字以内的三条标准是答案，不是工程方案');
  assert.equal(isAnswerOnlyGoal('帮我写一份 300 字以内的产品介绍'), true);
  assert.equal(isAnswerOnlyGoal('创建 report.md，正文不超过 300 字'), false, '有文件动作仍走执行流程');
  assert.equal(isAnswerOnlyGoal('打开豆包'), false);
});

test('P0-4：服务启动的自动恢复每个任务最多一次，失败任务不自动重放', () => {
  const memory = new Map(), store = { get: key => memory.get(key), set: (key, value) => memory.set(key, value) };
  const interrupted = { id: 'R-fix-1', kind: 'discuss', state: 'interrupted' };
  assert.equal(autoRecoveryDecision(interrupted, store).allowed, true);
  assert.equal(autoRecoveryDecision({ ...interrupted, id: 'R-fix-1b', state: 'failed', ended_at: '2026-10-19T00:00:00.000Z' }, store).allowed, false, '失败任务不自动重放');
  memory.set('autoRecovery:R-fix-1', { count: 1 });
  const second = autoRecoveryDecision(interrupted, store);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'limit-reached');
  assert.equal(autoRecoveryDecision({ id: 'R-fix-2', kind: 'parallel', state: 'failed' }, store).allowed, false);
  assert.equal(autoRecoveryDecision({ id: 'R-fix-3', kind: 'ask', state: 'error' }, store).allowed, false);
});

test('R470 回归：第一次尝试写坏、重试修复同一个文件可以通过验收', async t => {
  const parent = tempDir('p0-retry');
  const root = cleanup(t, parent);
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'fixture' },
    flow: { ...defaults(root).flow, taskTokenBudget: 20000, tokenBudgetEnforced: false, allowAnyWrite: false } };
  config.workspace = path.join(root, 'workspace');
  config.codex.defaultModel = 'fixture-codex'; config.deepseek.defaultModel = 'fixture-deepseek';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  let executes = 0, reviews = 0, retryPrompt = '';
  const agents = {
    deepseek: async o => {
      if (o.role !== 'write') return { text: '{}' };
      executes++;
      const file = path.join(o.cwd, 'out.md');
      fs.writeFileSync(file, executes === 1 ? 'wrong' : 'done.');
      const nativeId = 'ds-fixed'; o.onNative?.(nativeId);
      return { text: JSON.stringify({ summary: '写入 out.md', artifacts: [{ path: file, summary: 'out.md' }] }), nativeId, usage: { totalTokens: 100, source: 'fixture' } };
    },
    codex: async o => {
      if (o.role !== 'think') return { text: '{}' };
      reviews++;
      const prompt = String(o.prompt || '');
      if (reviews === 1) return { text: JSON.stringify({ pass: false, issues: ['内容缺少句号'] }), usage: { totalTokens: 50, source: 'fixture' } };
      retryPrompt = prompt;
      return { text: JSON.stringify({ pass: true, issues: [] }), usage: { totalTokens: 50, source: 'fixture' } };
    },
  };
  const orch = new Orchestrator({ config, store, agents });
  const run = store.createRun({ kind: 'parallel', goal: '新建 out.md，正文为 done.', cwd: config.workspace, initiator: 'codex', max_rounds: 2, max_turns: 4 });
  const acceptance = [{ text: '读取 out.md，内容符合用户原话；任务开始前已存在的同名文件不得覆盖（本任务此前尝试创建的产物在重试时允许覆盖或重建并修复）', machine: false }];
  const plan = { summary: '新建文本文件', checks: [], acceptance, requiresModelReview: true,
    tasks: [{ id: 'task-1', owner: 'deepseek', type: 'workspace', title: '新建 out.md', detail: run.goal, files: ['out.md'], dependsOn: [], inputRefs: [], outputRefs: [], checks: [], acceptance, difficulty: 'simple', maxRetries: 2, tokenBudget: 20000 }] };
  const result = await runQueuedTasks(orch, run, plan, new AbortController().signal, {}, {});
  assert.equal(executes, 2, '第一次写坏后要重试一次：' + JSON.stringify(result.queue));
  assert.equal(result.verdict.verdict, 'pass', JSON.stringify(result.verdict));
  assert.equal(fs.readFileSync(path.join(config.workspace, 'out.md'), 'utf8'), 'done.');
  assert.match(retryPrompt, /createdDuringTask/);
  assert.match(retryPrompt, /重试允许覆盖\/重建并修复/);
  assert.match(retryPrompt, /\.beat-control 下的检查点\/报告\/日志是产品自身写入/);
});
