import test from 'node:test';
import assert from 'node:assert/strict';
import { decideTermination, decideHandoff, terminationNotice, TERMINATION_REASONS, HANDOFF_ACTIONS } from '../src/collaboration-policy.mjs';

test('终止条件：一致 / 无分歧 / 轮数 / 预算 / 停滞 / 无进展 / 继续', () => {
  assert.equal(decideTermination({ consensus: true }).reason, TERMINATION_REASONS.CONSENSUS);
  assert.equal(decideTermination({ disputes: [] }).reason, TERMINATION_REASONS.CONSENSUS);
  assert.equal(decideTermination({ disputes: [{}], debates: 3, maxDebates: 3 }).reason, TERMINATION_REASONS.MAX_DEBATES);
  assert.equal(decideTermination({ disputes: [{}], rounds: 5, maxRounds: 5 }).reason, TERMINATION_REASONS.MAX_ROUNDS);
  assert.equal(decideTermination({ disputes: [{}], tokensUsed: 95, tokenBudget: 100 }).reason, TERMINATION_REASONS.BUDGET);
  assert.equal(decideTermination({ disputes: [{}], stalled: true }).reason, TERMINATION_REASONS.STALLED);
  assert.equal(decideTermination({ disputes: [{}, {}], debates: 1, lastDisputeCount: 2 }).reason, TERMINATION_REASONS.NO_PROGRESS);
  const keep = decideTermination({ disputes: [{}, {}], debates: 0, tokensUsed: 10, tokenBudget: 100 });
  assert.equal(keep.stop, false);
  assert.equal(keep.reason, null);
});

test('交接：在线继续 / 换人 / 顾问 / 停止，且不会把座位交给自己', () => {
  assert.equal(decideHandoff({ seat: 'deepseek', status: 'online' }).action, HANDOFF_ACTIONS.KEEP);
  const substitute = decideHandoff({ seat: 'codex', status: 'failed', candidates: ['codex', 'dock:a', 'dock:b'] });
  assert.equal(substitute.action, HANDOFF_ACTIONS.SUBSTITUTE);
  assert.equal(substitute.to, 'dock:a');
  const advisor = decideHandoff({ seat: 'codex', status: 'failed', candidates: [], advisorOnline: true });
  assert.equal(advisor.action, HANDOFF_ACTIONS.ADVISOR);
  assert.equal(advisor.to, 'claude');
  const stop = decideHandoff({ seat: 'codex', status: 'failed', candidates: [], advisorOnline: false, reason: '额度用尽' });
  assert.equal(stop.action, HANDOFF_ACTIONS.STOP);
  assert.match(stop.note, /额度用尽/);
  const conflict = decideHandoff({ seat: 'codex', status: 'online', conflict: true, advisorOnline: true });
  assert.equal(conflict.action, HANDOFF_ACTIONS.ADVISOR);
});

test('终止原因有给买家看的中文说明', () => {
  assert.match(terminationNotice({ reason: TERMINATION_REASONS.BUDGET, note: '预算已用 95%' }), /预算到限/);
  assert.match(terminationNotice({ reason: TERMINATION_REASONS.NO_PROGRESS }), /没有新进展/);
});
