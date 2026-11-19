import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveWorkflow, formatWorkflow, WORKFLOW_NODES, RESUME_ACTIONS, WORKFLOW_EDGES } from '../src/state-machine.mjs';

test('状态节点：交付 / 等待输入 / 执行 / 阻塞', () => {
  assert.equal(deriveWorkflow({ state: 'passed' }).node, WORKFLOW_NODES.DELIVERY);
  assert.equal(deriveWorkflow({ state: 'done' }).terminal, true);
  const waiting = deriveWorkflow({ state: 'waiting_input' });
  assert.equal(waiting.node, WORKFLOW_NODES.AWAITING_INPUT);
  assert.equal(waiting.resume.action, RESUME_ACTIONS.ANSWER);
  assert.equal(deriveWorkflow({ state: 'executing' }).node, WORKFLOW_NODES.EXECUTION);
  assert.equal(deriveWorkflow({ state: 'verifying' }).node, WORKFLOW_NODES.VERIFICATION);
  assert.equal(deriveWorkflow({ state: 'queued' }).node, WORKFLOW_NODES.INTAKE);
});

test('恢复点：只核验 / 队列返工 / 重规划 / 未知副作用 / 中断 / 取消', () => {
  const review = deriveWorkflow({ state: 'failed', quickWorkEvidence: { verificationOnly: true } });
  assert.equal(review.resume.action, RESUME_ACTIONS.REVIEW_ONLY);
  assert.equal(review.resumable, true);

  const rework = deriveWorkflow({ state: 'failed', taskQueue: [{ id: 'task-2', state: 'blocked' }] });
  assert.equal(rework.resume.action, RESUME_ACTIONS.REWORK);
  assert.equal(rework.resume.taskId, 'task-2');

  const replan = deriveWorkflow({ state: 'failed', failureCode: 'PLAN_STRUCTURE' });
  assert.equal(replan.resume.action, RESUME_ACTIONS.REPLAN);

  const manual = deriveWorkflow({ state: 'failed', quickWorkEvidence: { evidence: { sideEffects: 'unknown' } } });
  assert.equal(manual.resume.action, RESUME_ACTIONS.MANUAL);
  assert.equal(manual.resumable, false);

  const interrupted = deriveWorkflow({ state: 'interrupted' });
  assert.equal(interrupted.resume.action, RESUME_ACTIONS.RESUME);

  const cancelled = deriveWorkflow({ state: 'cancelled' });
  assert.equal(cancelled.resume.action, RESUME_ACTIONS.RESTART);
  assert.equal(cancelled.terminal, true);
});

test('状态图边与买家说明', () => {
  assert.deepEqual(WORKFLOW_EDGES.execution, ['verification', 'blocked', 'awaiting_input']);
  assert.match(formatWorkflow(deriveWorkflow({ state: 'waiting_input' })), /当前节点：awaiting_input；下一步：补充信息后继续/);
  assert.match(formatWorkflow(deriveWorkflow({ state: 'passed' })), /已结束|已完成/);
});
