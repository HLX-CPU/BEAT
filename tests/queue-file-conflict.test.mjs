// R152 实测的坑：同一个目标重新跑（客户最常见的重试方式），会被上一次任务遗留的
// "副作用未知"隔离锁永久挡住：任务一直排在那里，整轮 0 次领取、直接判未通过，而且跳过是静默的。
// 规则（与既有"退役旧核验锁"同一套设计）：
//   ① 只有"更新且同目标、同工作目录、已结束且没有活跃租约"的旧任务，才退役它的锁；
//   ② 退役只针对同一个文件被这次任务接手的情况，全程留痕（事件 + 旧行标记）；
//   ③ 真在跑的（租约有效）和其它目标留下的锁仍然封锁，安全语义不放松。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { TaskQueue } from '../src/task-queue.mjs';

const GOAL = '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画';
const task = (id, file) => ({ id, title: id, detail: '写 ' + path.basename(file), files: [file], acceptance: ['文件存在'] });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-release-'));
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd, { recursive: true });
  const store = new Store(path.join(root, 'beat.sqlite'));
  const file = path.join(cwd, 'pelican-bicycle.html');
  const makeRun = (id, n, goal, state = 'failed') => store.db.prepare("INSERT INTO runs (id,n,kind,goal,cwd,state,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, n, 'parallel', goal, cwd, state, new Date(Date.now() - (100 - n) * 60000).toISOString());
  return { root, cwd, store, file, makeRun };
}
const hold = (store, scope, reason = 'unconfirmed-exit+unknown-side-effects', side = 'unknown') =>
  store.db.prepare("UPDATE tq_tasks SET status='blocked', quarantine_reason=?, side_effects=? WHERE scope=?").run(reason, side, scope);

test('同目标的新任务接手同一个文件：旧任务"副作用未知"的锁会退役，任务立刻能领到', () => {
  const { store, cwd, file, makeRun } = fixture();
  makeRun('R91', 91, GOAL);
  const old = new TaskQueue({ store, runId: 'R91', cwd, workers: ['codex'] });
  old.enqueue([task('task-2', file)]);
  hold(store, 'R91');
  makeRun('R152', 152, GOAL, 'running');
  const fresh = new TaskQueue({ store, runId: 'R152', cwd, workers: ['codex'] });
  fresh.enqueue([task('task-1', file)]);
  assert.equal(fresh.claim('codex'), null, '退役之前必须是封锁的（安全问题要复现）');
  const released = fresh.releaseTerminalVerificationConflicts({ explicitStart: true, isRunActive: () => false });
  assert.deepEqual(released.released.map(r => `${r.runId}/${r.taskId}:${r.kind}`), ['R91/task-2:unknown-side-effects']);
  const claimed = fresh.claim('codex');
  assert.ok(claimed, '退役之后必须能领到，不能永久堵着');
  assert.equal(claimed.id, 'task-1');
  // 留痕：旧行标记 + 事件
  const oldRow = store.db.prepare("SELECT quarantine_reason FROM tq_tasks WHERE scope='R91'").get();
  assert.equal(oldRow.quarantine_reason, 'file-lock-superseded', '旧行要标成已退役，不能再次封锁');
  const events = store.db.prepare("SELECT type,text FROM tq_events WHERE scope='R91'").all();
  assert.ok(events.some(e => e.type === 'unknown-hold-superseded' && /副作用未知/.test(e.text)), '要留一条退役事件');
  store.close();
});

test('真在跑的旧任务（租约有效）不退役；不同目标的锁也不退役', () => {
  const { store, cwd, file, makeRun } = fixture();
  // ① 旧任务正在跑（有租约）
  makeRun('R_LIVE', 100, GOAL);
  const live = new TaskQueue({ store, runId: 'R_LIVE', cwd, workers: ['codex'], leaseMs: 60000 });
  live.enqueue([task('task-1', file)]);
  assert.ok(live.claim('codex'));
  makeRun('R_NEW', 152, GOAL, 'running');
  const fresh = new TaskQueue({ store, runId: 'R_NEW', cwd, workers: ['codex'] });
  fresh.enqueue([task('task-1', file)]);
  assert.deepEqual(fresh.releaseTerminalVerificationConflicts({ explicitAccess: true, explicitStart: true, isRunActive: () => true }).released, [], '正在跑的不能退役');
  assert.equal(fresh.claim('codex'), null, '租约有效时仍然互斥');
  // ② 不同目标留下的锁
  const other = fixture();
  other.makeRun('R_OTHER', 100, '另一个完全不同的目标');
  const otherQueue = new TaskQueue({ store: other.store, runId: 'R_OTHER', cwd: other.cwd, workers: ['codex'] });
  otherQueue.enqueue([task('task-1', other.file)]);
  hold(other.store, 'R_OTHER');
  other.makeRun('R_OTHER2', 152, '又一个新的目标', 'running');
  const otherFresh = new TaskQueue({ store: other.store, runId: 'R_OTHER2', cwd: other.cwd, workers: ['codex'] });
  otherFresh.enqueue([task('task-1', other.file)]);
  assert.deepEqual(otherFresh.releaseTerminalVerificationConflicts({ explicitStart: true, isRunActive: () => false }).released, [], '不同目标的锁不能退役（安全问题要保留）');
  assert.equal(otherFresh.claim('codex'), null);
  store.close(); other.store.close();
});

test('没有明确重新发起时不退役（避免后台顺手把安全锁放掉）', () => {
  const { store, cwd, file, makeRun } = fixture();
  makeRun('R91', 91, GOAL);
  const old = new TaskQueue({ store, runId: 'R91', cwd, workers: ['codex'] });
  old.enqueue([task('task-2', file)]);
  hold(store, 'R91');
  makeRun('R152', 152, GOAL, 'running');
  const fresh = new TaskQueue({ store, runId: 'R152', cwd, workers: ['codex'] });
  fresh.enqueue([task('task-1', file)]);
  assert.deepEqual(fresh.releaseTerminalVerificationConflicts({ isRunActive: () => false }).released, []);
  assert.equal(fresh.claim('codex'), null, '默认不动安全锁');
  store.close();
});
