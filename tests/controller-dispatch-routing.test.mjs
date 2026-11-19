import test from 'node:test';
import assert from 'node:assert/strict';
import { taskRouting, prepareQueuedTasks } from '../src/queue-runner.mjs';

const workers = ['codex', 'deepseek'];
const control = { strongAgent: 'codex', cheapAgents: ['deepseek'], difficultyRouting: true, tokenBudgetEnforced: false };

test('分工指定的 owner 优先于难度路由，避免“写了谁做却发给别人”', () => {
  const hard = taskRouting({ difficulty: 'hard', owner: 'deepseek' }, workers, control);
  assert.equal(hard.eligibleWorkers[0], 'deepseek', '明确指定的执行人必须排在最前');
  assert.ok(hard.eligibleWorkers.includes('codex'), '其他合格搭档仍可接单（掉线时由 BEAT 改派）');
  assert.match(hard.routingReason, /方案指定 deepseek 优先/);

  const simple = taskRouting({ difficulty: 'simple', owner: 'codex' }, workers, control);
  assert.equal(simple.eligibleWorkers[0], 'codex', '简单任务也不能无视明确指定');
});

test('明确的 eligibleWorkers 硬限制优先于 owner，控制器不能越过能力限制', () => {
  const pinned = taskRouting({ difficulty: 'hard', owner: 'deepseek', eligibleWorkers: ['codex'] }, workers, control);
  assert.deepEqual(pinned.eligibleWorkers, ['codex'], '任务写了 eligibleWorkers 时只能从该名单选');
});

test('owner 在线但接口预算不够时不硬塞，保留可执行的强搭档', () => {
  const routed = taskRouting({ difficulty: 'hard', owner: 'deepseek', tokenBudget: 100 }, workers, {
    ...control, tokenBudgetEnforced: true, workerMinTokens: { deepseek: { work: 5000 }, codex: { work: 100 } },
  });
  assert.deepEqual(routed.eligibleWorkers, ['codex'], '预算不够的 owner 不能接单，应保留其他合格搭档');
  assert.ok(routed.excluded.some(item => item.worker === 'deepseek'));
});

test('prepareQueuedTasks 把方案/控制器的 owner 保留到队列路由证据里', () => {
  const tasks = prepareQueuedTasks({
    tasks: [{ id: 'task-1', title: '写文件', detail: '写 a.txt', owner: 'deepseek', type: 'workspace', files: ['a.txt'], acceptance: ['文件存在'], difficulty: 'hard' }],
    acceptance: ['完成'],
  }, workers, control);
  assert.equal(tasks[0].owner, 'deepseek');
  assert.equal(tasks[0].routingEvidence.eligibleWorkers[0], 'deepseek');
});
