// 测评问题清单 P1 回归：控制文件误判、状态机、Claude 角色、在线≠可用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripControlEvidence } from '../src/queue-runner.mjs';
import { resumeGate } from '../src/orchestrator.mjs';
import { TERMINATION_REASONS, terminationNotice } from '../src/collaboration-policy.mjs';
import { ADVISOR_ROLE, advisorSystem } from '../src/claude.mjs';
import { debateLimitFor } from '../src/compact-discussion.mjs';
import { availabilityOf } from '../src/availability.mjs';

test('P1-1：核验前剔除控制器 .beat-control 自身写入，业务写入保留', () => {
  const evidence = {
    trace: { status: 'complete' },
    calls: [
      { tool: 'write', path: 'E:\\work\\out.md', result: { ok: true } },
      { tool: 'write', path: 'E:\\work\\.beat-control\\R470\\task-1\\report-1.json', result: { ok: true } },
      { tool: 'edit', args: { file_path: 'E:\\work\\.beat-control\\R470\\checkpoint.json' } },
    ],
    blobs: ['keep'],
  };
  const filtered = stripControlEvidence(evidence);
  const text = JSON.stringify(filtered);
  assert.match(text, /out\.md/);
  assert.doesNotMatch(text, /\.beat-control/);
  assert.deepEqual(filtered.blobs, ['keep']);
  assert.equal(evidence.calls.length, 3, '原始证据不能被改写');
});

test('P1-2：有未知副作用的失败任务不可 resume；普通失败任务仍可继续', () => {
  const blocked = resumeGate({ state: 'failed', taskQueue: [{ id: 'task-1', state: 'blocked', sideEffects: 'unknown' }] }, [{ id: 'task-1', state: 'blocked', sideEffects: 'unknown' }]);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /未知|核对|继续/);
  const normal = resumeGate({ state: 'failed' }, [{ id: 'task-1', state: 'blocked', sideEffects: 'none' }]);
  assert.equal(normal.allowed, true, JSON.stringify(normal));
  const cancelled = resumeGate({ state: 'cancelled' }, []);
  assert.equal(cancelled.allowed, true);
});

test('P1-2：失败收口时终止说明改成“讨论未通过”，不再保留 consensus', () => {
  assert.equal(TERMINATION_REASONS.FAILED, 'failed');
  assert.match(terminationNotice({ reason: TERMINATION_REASONS.FAILED, note: '评审仍未接受' }), /讨论未通过/);
  assert.doesNotMatch(terminationNotice({ reason: TERMINATION_REASONS.FAILED }), /一致/);
});

test('P1-2：max_turns=2 时辩论上限为 1，不再出现“传 2 却 0 轮”的无法解释状态', () => {
  assert.deepEqual(debateLimitFor({ discussionMaxDebates: 3 }, 2), { configuredMaxDebates: 3, requestedMaxTurns: 2, effectiveMaxDebates: 1 });
  assert.equal(debateLimitFor({ discussionMaxDebates: 3 }, 12).effectiveMaxDebates, 3);
  assert.equal(debateLimitFor({ discussionMaxDebates: 3 }, null).effectiveMaxDebates, 3);
  assert.equal(debateLimitFor({ discussionMaxDebates: 0 }, 2).effectiveMaxDebates, 0, '本地控制器可以在上限内再调低');
});

test('P1-3：Claude 每次请求都带只读顾问角色，不能自称能执行', () => {
  assert.match(ADVISOR_ROLE, /只读顾问/);
  assert.match(ADVISOR_ROLE, /不领取执行任务/);
  const system = advisorSystem('普通系统提示');
  assert.match(system, /只读顾问/);
  assert.match(system, /普通系统提示/);
  assert.match(advisorSystem(undefined), /只读顾问/);
});

test('P1-4：在线 ≠ 可用；未验证工具与上游故障都要显式说出来', () => {
  const codex = { status: 'online', paused: false, native: { available: true, toolsVerified: false } };
  const c = availabilityOf(codex);
  assert.equal(c.usable, true, '能回答仍算可用');
  assert.match(c.warnings.join('；'), /工具尚未验证/);
  const dock = { status: 'online', paused: false, dock: true, reason: '上游账号池暂无可用账号', failureReason: '上游账号池暂无可用账号' };
  const d = availabilityOf(dock);
  assert.equal(d.usable, false);
  assert.match(d.warnings.join('；'), /账号池/);
  const paused = availabilityOf({ status: 'online', paused: true });
  assert.equal(paused.usable, false);
  assert.match(paused.warnings.join('；'), /暂停/);
  const offline = availabilityOf({ status: 'offline', reason: '未安装桌面端' });
  assert.equal(offline.usable, false);
  assert.match(offline.warnings.join('；'), /未安装/);
});
