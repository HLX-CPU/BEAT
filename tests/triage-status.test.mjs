import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveWorkflow, deliveryTriage, TRIAGE_STATUS } from '../src/state-machine.mjs';

test('三态：已完成并核验 / 待核对 / 未通过', () => {
  const passed = deliveryTriage({ kind: 'parallel', state: 'passed' });
  assert.equal(passed.status, TRIAGE_STATUS.VERIFIED);
  assert.equal(passed.label, '已完成并核验');

  const failed = deliveryTriage({ kind: 'parallel', state: 'failed', error: '未通过' });
  assert.equal(failed.status, TRIAGE_STATUS.FAILED);
  assert.equal(failed.label, '未通过');
  assert.ok(failed.actions.some(a => a.id === 'resume'), '未通过必须给下一步动作');

  const pending = deliveryTriage({ kind: 'parallel', state: 'failed', quickWorkEvidence: { verificationOnly: true, artifacts: [{ path: 'E:\\out.txt' }] } });
  assert.equal(pending.status, TRIAGE_STATUS.PENDING);
  assert.equal(pending.label, '成果已保留，待核对');
  assert.ok(pending.actions.some(a => a.id === 'inspect'), '待核对要能查看已有文件');
  assert.equal(pending.next, '只核验已有成果，不重复执行');
});

test('未知电脑操作不显示成通过或失败，而是待人工核对且不给自动重放按钮', () => {
  const view = { kind: 'ask', state: 'failed', quickWorkEvidence: { evidence: { sideEffects: 'unknown' } } };
  const triage = deliveryTriage(view);
  assert.equal(triage.status, TRIAGE_STATUS.PENDING);
  assert.equal(triage.label, '待人工核对');
  assert.match(triage.note, /不能自动重放/);
  assert.ok(!triage.actions.some(a => a.action === 'manual' || a.action === 'resume'), '未知副作用不能被一个按钮自动重放');
});

test('直接问答的三态是"已答复"，讨论完成是"已完成"，不冒充文件核验', () => {
  assert.equal(deliveryTriage({ kind: 'ask', state: 'done', access: 'read-only' }).label, '已答复');
  assert.equal(deliveryTriage({ kind: 'discuss', state: 'done' }).label, '已完成');
});

test('已判通过但独立核验明确失败：降为待核对，不显示已验证', () => {
  const triage = deliveryTriage({ kind: 'parallel', state: 'passed', deliveryVerification: { pass: false } });
  assert.equal(triage.status, TRIAGE_STATUS.PENDING);
  assert.equal(triage.label, '待核对');
});

test('动作标签直接复用状态机的恢复点（继续执行 / 只核验 / 重试）', () => {
  const rework = deliveryTriage({ state: 'failed', taskQueue: [{ id: 'T1', state: 'blocked' }] });
  assert.equal(rework.next, '从未完成的小任务继续（T1）');
  assert.equal(rework.actions.find(a => a.id === 'resume').label, '从未完成的小任务继续（T1）');
  const interrupted = deliveryTriage({ state: 'interrupted' });
  assert.equal(interrupted.status, TRIAGE_STATUS.PENDING);
  assert.equal(interrupted.actions[0].label, '从最近检查点继续');
});

test('客户撤回文件改动后，状态显示已撤销而不是已完成并核验', () => {
  const triage = deliveryTriage({ kind: 'ask', state: 'passed', checkpoint: { rolledBackAt: '2026-10-19T01:00:00Z' } });
  assert.equal(triage.status, TRIAGE_STATUS.PENDING);
  assert.equal(triage.label, '文件改动已撤销');
  assert.match(triage.note, /恢复到执行前/);
});

test('部分撤销只声明部分文件已恢复，不把跳过的文件说成已撤销', () => {
  const triage = deliveryTriage({ kind: 'ask', state: 'passed', checkpoint: { rolledBackAt: '2026-10-19T01:00:00Z', partial: true, rolledBackPaths: ['E:\\a.txt'] } });
  assert.equal(triage.status, TRIAGE_STATUS.PENDING);
  assert.equal(triage.label, '部分文件已撤销');
  assert.match(triage.note, /还有文件/);
});
