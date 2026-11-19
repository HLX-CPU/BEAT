import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecutionRisk, buildExecutionAudit, formatExecutionAudit, AUDIT_RISK } from '../src/execution-audit.mjs';

test('危险动作分类：不可逆 / 删除 / 凭据 / 网络 / 写 / 读 / 未分类', () => {
  assert.equal(classifyExecutionRisk({ tool: 'pwsh', command: 'Remove-Item -Recurse C:\\tmp\\x' }).risk, AUDIT_RISK.IRREVERSIBLE);
  assert.equal(classifyExecutionRisk({ tool: 'pwsh', command: 'rm -rf /tmp/x' }).risk, AUDIT_RISK.IRREVERSIBLE);
  assert.equal(classifyExecutionRisk({ tool: 'pwsh', command: 'del C:\\tmp\\a.txt' }).risk, AUDIT_RISK.DELETE);
  assert.equal(classifyExecutionRisk({ tool: 'read', args: { path: 'secrets.local' } }).risk, AUDIT_RISK.CREDENTIAL);
  assert.equal(classifyExecutionRisk({ tool: 'pwsh', command: 'curl https://example.invalid' }).risk, AUDIT_RISK.NETWORK);
  assert.equal(classifyExecutionRisk({ tool: 'file_write', args: { file_path: 'C:\\a.txt' } }).risk, AUDIT_RISK.WRITE);
  assert.equal(classifyExecutionRisk({ tool: 'file_read' }).risk, AUDIT_RISK.READ);
  // 只读探测命令不能记成“未分类动作”：R482 实测 Test-Path 被标 unknown，审计看起来比实际危险。
  assert.equal(classifyExecutionRisk({ tool: 'pwsh', command: "Test-Path 'E:\\beat\\x.txt'" }).risk, AUDIT_RISK.READ);
  assert.equal(classifyExecutionRisk({ tool: 'pwsh', command: "Resolve-Path 'E:\\beat'" }).risk, AUDIT_RISK.READ);
  assert.equal(classifyExecutionRisk({ tool: 'pwsh', command: "Get-ChildItem 'E:\\beat'" }).risk, AUDIT_RISK.READ);
  assert.equal(classifyExecutionRisk({ tool: 'mystery_tool' }).risk, AUDIT_RISK.UNKNOWN);
});

test('执行审计：事件序列、高危项、文件触碰、可回放判定', () => {
  const evidence = {
    source: 'fixture-native-tool-log', trace: { status: 'complete' }, sideEffects: 'file-write',
    calls: [
      { tool: 'file_write', status: 'completed', record: { input: { file_path: 'C:\\out\\a.txt' } }, evidence: { after: { resolvedPath: 'C:\\out\\a.txt', bytes: 3, sha256: 'abc' }, sideEffects: 'file-write' } },
      { tool: 'pwsh', status: 'completed', record: { input: { command: 'Remove-Item -Recurse C:\\out' } } },
      { tool: 'file_read', status: 'completed', record: { input: { file_path: 'C:\\out\\a.txt' } } },
    ],
  };
  const audit = buildExecutionAudit(evidence, { runId: 'R1', cwd: 'C:\\out' });
  assert.equal(audit.count, 3);
  assert.deepEqual(audit.events.map(event => event.seq), [1, 2, 3]);
  assert.equal(audit.highRisk.length, 1);
  assert.equal(audit.highRisk[0].risk, AUDIT_RISK.IRREVERSIBLE);
  assert.ok(audit.filesTouched.some(file => file.endsWith('a.txt')));
  assert.equal(audit.replayable, true);
  assert.match(formatExecutionAudit(audit), /3 个动作/);
  assert.match(formatExecutionAudit(audit), /高危 1 项/);
});

test('未知副作用或轨迹不完整时不可回放；嵌套子回执也能展开', () => {
  const nested = {
    trace: { status: 'complete' },
    calls: [{ tool: 'file_write', status: 'completed', record: { result: { calls: [{ tool: 'file_write', status: 'verified', record: { input: { file_path: 'C:\\a.txt' } } }] } } }],
  };
  const audit = buildExecutionAudit(nested);
  assert.equal(audit.count, 1);
  assert.equal(audit.events[0].tool, 'file_write');
  assert.equal(audit.replayable, true);
  const uncertain = buildExecutionAudit({ ...nested, sideEffects: 'unknown' });
  assert.equal(uncertain.replayable, false);
  assert.match(uncertain.note, /人工核对/);
  const incomplete = buildExecutionAudit({ ...nested, trace: { status: 'incomplete' } });
  assert.equal(incomplete.replayable, false);
});
