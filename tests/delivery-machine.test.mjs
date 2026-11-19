import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { machineVerifiedDelivery } from '../src/delivery-verification.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

function fixture(t, content = 'HELLO BEAT\n', name = 'hello.txt') {
  const root = cleanup(t, tempDir('machine-delivery'));
  const file = path.join(root, name);
  fs.writeFileSync(file, content);
  const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const evidence = { sideEffects: 'file-write', trace: { status: 'complete' },
    calls: [{ tool: 'file_write', status: 'completed', failed: false, record: { input: { file_path: file } } }] };
  return { root, file, sha256, evidence, goal: '在当前目录新建 hello.txt，内容严格为 HELLO BEAT' };
}

test('单字面文件：内容逐字一致 + SHA-256 + 路径一致 → 可以机器核验，省掉模型复核', t => {
  const f = fixture(t);
  const result = machineVerifiedDelivery({ goal: f.goal, cwd: f.root, scope: ['hello.txt'],
    artifacts: [{ path: f.file, bytes: fs.statSync(f.file).size, sha256: f.sha256 }], evidence: f.evidence });
  assert.equal(result.eligible, true, result.reason);
  assert.equal(result.sha256, f.sha256);
  assert.equal(result.readbacks.length, 1);
  assert.match(result.method, /SHA-256/);
});

test('中文文件名前没有空格（“新建通知.txt”）：去掉动作词后仍能走机器核验', t => {
  const f = fixture(t, 'HELLO BEAT\n', '通知.txt');
  const result = machineVerifiedDelivery({ goal: '新建通知.txt，内容严格为 HELLO BEAT', cwd: f.root, scope: ['新建通知.txt'],
    artifacts: [{ path: f.file, bytes: fs.statSync(f.file).size, sha256: f.sha256 }], evidence: f.evidence });
  assert.equal(result.eligible, true, result.reason);
  assert.equal(result.sha256, f.sha256);
});

test('内容不一致 / 多文件 / 有非文件动作 / 哈希变化：都不能走机器核验', t => {
  const f = fixture(t);
  const artifact = { path: f.file, bytes: 10, sha256: f.sha256 };
  assert.equal(machineVerifiedDelivery({ goal: f.goal, cwd: f.root, scope: ['hello.txt'], artifacts: [artifact], evidence: f.evidence }).eligible, true);

  const mismatch = fixture(t, 'WRONG');
  mismatch.artifacts = [{ path: mismatch.file, bytes: 5, sha256: mismatch.sha256 }];
  assert.equal(machineVerifiedDelivery({ goal: mismatch.goal, cwd: mismatch.root, scope: ['hello.txt'], artifacts: mismatch.artifacts, evidence: mismatch.evidence }).eligible, false);
  assert.match(machineVerifiedDelivery({ goal: mismatch.goal, cwd: mismatch.root, scope: ['hello.txt'], artifacts: mismatch.artifacts, evidence: mismatch.evidence }).reason, /内容/);

  assert.equal(machineVerifiedDelivery({ goal: f.goal, cwd: f.root, scope: ['hello.txt', 'b.txt'], artifacts: [artifact], evidence: f.evidence }).eligible, false);
  const shell = { ...f.evidence, calls: [...f.evidence.calls, { tool: 'shell', status: 'completed' }] };
  assert.equal(machineVerifiedDelivery({ goal: f.goal, cwd: f.root, scope: ['hello.txt'], artifacts: [artifact], evidence: shell }).eligible, false);
  fs.writeFileSync(f.file, 'changed after verification');
  assert.equal(machineVerifiedDelivery({ goal: f.goal, cwd: f.root, scope: ['hello.txt'], artifacts: [artifact], evidence: f.evidence }).eligible, false);
});
