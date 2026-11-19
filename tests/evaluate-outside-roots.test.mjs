// 客户要求：文件写在 BEAT 默认目录之外，只要能拿到真实文件和哈希，就必须能展示与独立评估。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { absoluteFilesInGoal, captureNativeFiles, nativeWrittenFiles, assessNativeAction } from '../src/quick-work.mjs';
import { customerPresentation } from '../src/customer-presentation.mjs';

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('目标里写绝对路径：直接在那个真实位置核对交付', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-cwd-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-outside-'));
  const file = path.join(outDir, '报告.md');
  fs.writeFileSync(file, '# 报告\n内容');
  const goal = '把总结保存到 ' + file + '，内容是三点结论';
  assert.deepEqual(absoluteFilesInGoal(goal), [file]);
  const captured = captureNativeFiles(goal, {}, cwd);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].path, file);
  assert.equal(captured[0].existed, true);
  assert.equal(captured[0].sha256, hash(file));
});

test('原生日志写在默认目录之外：文件存在就算真实交付，可以评估', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-cwd2-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-outside2-'));
  const file = path.join(outDir, 'result.html');
  const since = Date.now() - 1000;
  fs.writeFileSync(file, '<html>ok</html>');
  const evidence = {
    calls: [{ id: 'c1', tool: 'fileChange', status: 'completed', failed: false, record: { changes: [{ path: file, kind: { type: 'add' } }] } }],
    verifiedActions: [], verification: { status: 'unverified' },
  };
  assert.deepEqual(nativeWrittenFiles(evidence, { cwd, roots: [cwd] }), [{ path: file, kind: 'add' }]);
  const assessed = assessNativeAction(evidence, [], { goal: '创建一个HTML', cwd, roots: [cwd], since });
  assert.equal(assessed.ok, true);
  assert.deepEqual(assessed.artifacts.map(a => a.path), [file]);
});

test('看板展示：带真实哈希的目录外产物照样出现在成果里；无哈希的随口路径仍被挡住', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-cwd3-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-outside3-'));
  const trusted = path.join(outDir, 'report.md');
  const claimed = path.join(outDir, 'ghost.md');
  fs.writeFileSync(trusted, '交付内容');
  const view = {
    cwd, state: 'passed', quickWorkEvidence: { artifacts: [
      { path: trusted, sha256: hash(trusted) },
      { path: claimed },
    ] },
    taskQueue: [], steps: [], created_at: new Date().toISOString(), ended_at: new Date().toISOString(),
  };
  const shown = customerPresentation(view, { roots: [cwd] });
  assert.deepEqual(shown.artifacts.map(a => a.path), [trusted]);
  assert.equal(shown.artifacts[0].verified, true);
});

test('目标写“绝对目录 + 文件名”：交付按目录里的真实文件核验，不落到任务目录（R482/R483 假失败回归）', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-cwd-dir-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-out-dir-'));
  const target = path.join(outDir, 'report.txt');
  const goal = '请在 ' + outDir + ' 下创建文件 report.txt，内容为 WRITE-OK，然后读回确认。';
  // 执行前：目录存在，文件还没建
  const before = captureNativeFiles(goal, {}, cwd);
  assert.equal(before.length, 1);
  assert.equal(before[0].path, target, '必须按绝对目录拼出真实目标，不能落到任务工作目录');
  assert.equal(before[0].existed, false);
  fs.writeFileSync(target, 'WRITE-OK');
  const calls = [
    { id: 'w1', tool: 'write', status: 'completed', failed: false, record: { type: 'tool_call', input: { file_path: target } }, result: { type: 'tool_result', status: 'completed' } },
    { id: 'r1', tool: 'read', status: 'completed', failed: false, record: { type: 'tool_call', input: { file_path: target } }, result: { type: 'tool_result', status: 'completed' } },
  ];
  const evidence = { calls, trace: { status: 'complete' } };
  const assessed = assessNativeAction(evidence, before, { goal, cwd, since: Date.now() - 1000 });
  assert.equal(assessed.ok, true, assessed.message);
  assert.deepEqual(assessed.artifacts.map(a => a.path), [target]);
});
