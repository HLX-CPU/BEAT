// 回归：客户要求交付到任务目录外（截图 R5：在桌面创建 word 文件）时，
// 队列不能把“桌面绝对路径”判成 PATH_ESCAPE 卡死；相对路径越界仍然拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { TaskQueue } from '../src/task-queue.mjs';

test('声明在任务目录外的绝对路径可以入队、写检查点；相对路径越界仍拒绝', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-tq-outside-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const cwd = path.join(root, 'task');
  fs.mkdirSync(cwd);
  const store = new Store(path.join(root, 'data', 'beat.sqlite'));
  const outside = path.join(root, 'desktop', '狼人杀方案.docx');
  fs.mkdirSync(path.dirname(outside));
  fs.writeFileSync(outside, 'word content');
  try {
    const q = () => new TaskQueue({ store, runId: 'run1', cwd, leaseMs: 1000, workers: ['w1'], now: () => Date.now() });
    q().enqueue([{ id: 'T1', title: '桌面交付', files: [outside], acceptance: ['文件存在'] }]);
    const claimed = q().claim('w1');
    assert.ok(claimed, '目录外绝对路径的任务可以领取');
    q().checkpoint('T1', claimed.leaseToken, { summary: '已生成 word', artifacts: [{ path: outside, summary: '方案' }] });
    const view = q().get('T1', { withHistory: true });
    assert.ok(view.checkpoint, '检查点保存成功');
    assert.equal(view.checkpoint.artifacts[0].path, outside);

    assert.throws(() => q().enqueue([{ id: 'T2', title: '越界', files: ['..\\escape.txt'] }]),
      error => error.code === 'PATH_ESCAPE', '相对路径越界仍然拒绝');
  } finally { store.close(); }
});
