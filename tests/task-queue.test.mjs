// TaskQueue 真实 SQLite 单测：node --test
// 覆盖：双实例领取互斥、依赖、路径重叠/越界、活 pid 超时不可重领、死 pid 可收回、
//       unknown 隔离、fence token、checkpoint、retry、非执行者 review、token 止损、取消证据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TaskQueue, LeaseLostError, QueueError } from '../src/task-queue.mjs';
import { tempDir } from './helpers/temp.mjs';

const STAGE = path.dirname(fileURLToPath(import.meta.url));
// Stage 目录在 E:\beat 深层，套进仓库后 tests/ 的直接上级才是 E:\beat。
const BEAT_ROOT = path.resolve(STAGE, '..', '..', '..', '..'); // E:\beat（Stage 比仓库多一层）

// Store 只作为“含 db(DatabaseSync) 的宿主”使用；此处按存在性挑一个可用的 src/store.mjs。
function resolveStoreFile() {
  const candidates = [
    path.resolve(STAGE, '..', 'src', 'store.mjs'),      // 套进仓库后的正常布局
    path.join(BEAT_ROOT, 'src', 'store.mjs'),           // Stage 布局：回退到 E:\beat
    path.resolve(STAGE, '..', '..', 'src', 'store.mjs'),
  ];
  for (const file of candidates) if (fs.existsSync(file)) return file;
  throw new Error(`找不到 src/store.mjs（候选：${candidates.join(', ')}）`);
}
const Store = (await import(new URL(`file:///${resolveStoreFile().replaceAll('\\', '/')}`).href)).Store;

function tmpRoot(tag) {
  // 走系统 temp：生产 data/ 里不再出现 task-queue-tests 残留。
  return tempDir(`tq-${tag}`);
}

function fixture(t, { workers = ['w1'], leaseMs = 1000, root, cwd } = {}) {
  const dir = root ?? tmpRoot('fx');
  fs.mkdirSync(path.join(dir, 'workspaces', 'shared'), { recursive: true });
  const file = path.join(dir, 'data', 'beat.sqlite');
  const stores = [new Store(file)];
  const cwdResolved = cwd ?? dir;
  const clock = { t: 1_000_000 };
  const io = {
    dir,
    file,
    store: stores[0],
    clock,
    advance: (ms) => { clock.t += ms; return clock.t; },
    q: (opts = {}) => new TaskQueue({ store: stores[0], runId: opts.runId ?? 'run1', cwd: cwdResolved, leaseMs, workers: opts.workers ?? workers, now: () => clock.t, ...opts }),
    // 第二个独立 DatabaseSync 连接（模拟另一个进程/实例）
    q2: (opts = {}) => {
      const second = new Store(file);
      stores.push(second);
      return new TaskQueue({ store: second, runId: opts.runId ?? 'run1', cwd: cwdResolved, leaseMs, workers: opts.workers ?? workers, now: () => clock.t, ...opts });
    },
    reopen: () => new TaskQueue({ store: stores[0], runId: 'run1', cwd: cwdResolved, leaseMs, workers, now: () => clock.t }),
  };
  t.after(() => { for (const s of stores) { try { s.close(); } catch { /* 已关闭 */ } } });
  return io;
}

/** 起一个立刻退出的子进程并返回其已死亡的 pid。 */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
    setTimeout(resolve, 5000).unref?.();
  });
  return pid;
}

/** 走完一次“领取 → 完成 → 非执行者验证通过”。 */
function passTask(q, t, id, { worker = 'w1', reviewer = 'r1' } = {}) {
  const claimed = q.claim(worker);
  assert.ok(claimed, `应能领取 ${id}`);
  assert.equal(claimed.id, id);
  q.complete(id, claimed.leaseToken, { ok: true });
  q.verify(id, reviewer, { pass: true });
  return claimed;
}

function verificationConflictFixture(t, opts = {}) {
  const io = fixture(t);
  const oldRun = io.store.createRun({ kind: 'parallel', goal: '交付同一只鹈鹕骑车动画', cwd: io.dir });
  const old = io.q({ runId: oldRun.id, isProcessAlive: opts.isProcessAlive });
  old.enqueue([{ id: 'artifact', title: '原动画', files: ['pelican.html'] }]);
  const claimed = old.claim('w1');
  fs.writeFileSync(path.join(io.dir, 'pelican.html'), 'original artifact');
  old.checkpoint('artifact', claimed.leaseToken, { path: 'checkpoint.json', summary: '已完成动画', filesDone: ['pelican.html'], sideEffects: 'none' });
  old.recordUsage('artifact', claimed.leaseToken, { totalTokens: 42, verified: true });
  const report = { taskId: 'artifact', executor: 'w1', artifacts: ['pelican.html'], summary: '完成，待浏览器验收', checks: [] };
  old.complete('artifact', claimed.leaseToken, report);
  io.store.updateRun(oldRun.id, { state: 'failed', ended_at: new Date().toISOString() });
  const currentRun = io.store.createRun({ kind: 'parallel', goal: oldRun.goal, cwd: io.dir });
  io.store.updateRun(currentRun.id, { state: 'running', started_at: new Date().toISOString() });
  const current = io.q({ runId: currentRun.id, isProcessAlive: opts.isProcessAlive });
  current.enqueue([{ id: 'latest', title: '继续动画', files: ['pelican.html'] }, { id: 'other', title: '独立文件', files: ['other.txt'] }]);
  const inactive = () => false;
  return { ...io, oldRun, currentRun, old, current, claimed, report, inactive };
}

test('显式恢复最新同目标任务原子退役旧失败verifying锁，历史产物和费用保留', t => {
  const s = verificationConflictFixture(t);
  const observer = s.q2({ runId: s.currentRun.id });
  const before = s.old.get('artifact', { withHistory: true });
  assert.equal(s.current.list().find(task => task.id === 'latest').ready, false);
  assert.deepEqual(s.current.releaseTerminalVerificationConflicts({ isRunActive: s.inactive }).released, []);
  assert.deepEqual(s.current.releaseTerminalVerificationConflicts({ explicitResume: true }).released, []);
  const result = observer.releaseTerminalVerificationConflicts({ explicitResume: true, isRunActive: s.inactive });
  assert.deepEqual(result.released, [{ runId: s.oldRun.id, taskId: 'artifact', currentTaskIds: ['latest'] }]);
  const after = s.old.get('artifact', { withHistory: true });
  assert.equal(after.status, 'blocked'); assert.equal(after.quarantineReason, 'superseded-verification');
  assert.equal(after.inputRefsInvalid, true); assert.equal(after.supersededVerification.runId, s.currentRun.id);
  for (const field of ['result', 'checkpoint', 'tokensUsed', 'usage', 'attempts', 'retries', 'history']) assert.deepEqual(after[field], before[field], field);
  assert.equal(s.current.list().find(task => task.id === 'latest').ready, true);
  assert.deepEqual(s.current.releaseTerminalVerificationConflicts({ explicitResume: true, isRunActive: s.inactive }).released, []);
  const claimed = s.current.claim('w1'); assert.equal(claimed.id, 'latest'); assert.equal(claimed.attempts, 1);
  assert.throws(() => s.old.verify('artifact', 'r1', { pass: true, attempt: 1, result: s.report }), { code: 'BAD_STATE' });
});

test('失败verify锁只有严格同目标同目录且较新最新任务显式恢复才能释放', async t => {
  const cases = [
    ['旧控制器仍active', s => {}, () => true],
    ['旧控制器活跃情况未知', s => {}, () => undefined],
    ['旧run running', s => s.store.updateRun(s.oldRun.id, { state: 'running' })],
    ['旧run interrupted', s => s.store.updateRun(s.oldRun.id, { state: 'interrupted' })],
    ['旧run done', s => s.store.updateRun(s.oldRun.id, { state: 'done' })],
    ['新run尚未running', s => s.store.updateRun(s.currentRun.id, { state: 'queued' })],
    ['不同目标', s => s.store.updateRun(s.currentRun.id, { goal: '另一个动画任务' })],
    ['不同目录', s => { const other = path.join(s.dir, 'workspaces', 'shared'); s.store.updateRun(s.currentRun.id, { cwd: other }); }],
    ['旧队列目录证据不一致', s => s.store.db.prepare("UPDATE tq_meta SET v=? WHERE scope=? AND k='cwd'").run(path.join(s.dir, 'workspaces', 'shared'), s.oldRun.id)],
    ['未知副作用', s => s.store.db.prepare("UPDATE tq_tasks SET side_effects='unknown' WHERE scope=?").run(s.oldRun.id)],
    ['报告中未知工具输入', s => s.store.db.prepare('UPDATE tq_tasks SET result=? WHERE scope=?').run(JSON.stringify({ ...s.report, unknownSideEffects: true }), s.oldRun.id)],
    ['检查证据未知', s => s.store.db.prepare('UPDATE tq_tasks SET result=? WHERE scope=?').run(JSON.stringify({ ...s.report, checks: [{ unknownSideEffects: true }] }), s.oldRun.id)],
    ['未核对副作用', s => s.store.db.prepare('UPDATE tq_tasks SET side_effects_verified=0 WHERE scope=?').run(s.oldRun.id)],
    ['未完成执行', s => s.store.db.prepare('UPDATE tq_tasks SET completed=0 WHERE scope=?').run(s.oldRun.id)],
    ['仍持有租约', s => s.store.db.prepare('UPDATE tq_tasks SET lease_token=?,lease_expires_at=? WHERE scope=?').run('still-held', s.clock.t - 1, s.oldRun.id)],
    ['执行PID仍存活', s => s.store.db.prepare('UPDATE tq_tasks SET executor_pid=? WHERE scope=?').run(process.pid, s.oldRun.id)],
    ['旧scope另一个执行仍持租约', s => { s.old.enqueue([{ id: 'still-running', title: '尚未退出的旧执行', files: ['elsewhere.txt'] }]); s.old.claim('w2'); }],
    ['无same-attempt完成记录', s => s.store.db.prepare("UPDATE tq_attempts SET attempt=7 WHERE scope=? AND outcome='completed'").run(s.oldRun.id)],
    ['还有更新同目标任务', s => s.store.createRun({ kind: 'parallel', goal: s.oldRun.goal, cwd: s.dir })],
    ['目标文件无交集', s => s.store.db.prepare('UPDATE tq_files SET path=? WHERE scope=? AND task_id=?').run(path.join(s.dir, 'non-overlap.txt').replaceAll('\\', '/').toLowerCase(), s.oldRun.id, 'artifact')],
  ];
  for (const [name, prepare, callback] of cases) await t.test(name, child => {
    const s = verificationConflictFixture(child); prepare(s);
    const result = s.current.releaseTerminalVerificationConflicts({ explicitResume: true, isRunActive: callback || s.inactive });
    assert.deepEqual(result.released, []); assert.equal(s.old.get('artifact').status, 'verifying');
  });
});

test('目录junction别名仍共享核验锁，最新同真实目录任务能有证据退役旧锁', t => {
  const s = verificationConflictFixture(t);
  const alias = path.join(path.dirname(s.dir), path.basename(s.dir) + '-workspace-alias');
  fs.symlinkSync(s.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  s.store.updateRun(s.currentRun.id, { cwd: alias });
  const aliased = s.q({ runId: s.currentRun.id, cwd: alias });
  assert.equal(aliased.list().find(task => task.id === 'latest').ready, false);
  const result = aliased.releaseTerminalVerificationConflicts({ explicitResume: true, isRunActive: s.inactive });
  assert.equal(result.released.length, 1);
  assert.equal(aliased.list().find(task => task.id === 'latest').ready, true);
  const claimed = aliased.claim('w1');
  s.store.updateRun(s.currentRun.id, { state: 'done' });
  assert.throws(() => s.old.restoreSupersededVerification('artifact', { attempt: 1, isRunActive: s.inactive }), { code: 'VERIFICATION_WRITER_ACTIVE' });
  assert.equal(claimed.id, 'latest');
});

test('被取代的旧任务等新writer结束后只恢复核验，拒绝旧批准及变更文件hash', t => {
  const s = verificationConflictFixture(t);
  s.current.releaseTerminalVerificationConflicts({ explicitResume: true, isRunActive: s.inactive });
  assert.throws(() => s.old.restoreSupersededVerification('artifact', { attempt: 1, isRunActive: s.inactive }), { code: 'VERIFICATION_WRITER_ACTIVE' });
  s.store.updateRun(s.currentRun.id, { state: 'done' });
  assert.throws(() => s.old.restoreSupersededVerification('artifact', { attempt: 1, isRunActive: () => true }), { code: 'VERIFICATION_WRITER_ACTIVE' });
  const newer = s.current.claim('w1');
  assert.throws(() => s.old.restoreSupersededVerification('artifact', { attempt: 1, isRunActive: s.inactive }), { code: 'VERIFICATION_WRITER_ACTIVE' });
  s.current.complete(newer.id, newer.leaseToken, {});
  assert.throws(() => s.old.restoreSupersededVerification('artifact', { attempt: 1, isRunActive: s.inactive }), { code: 'VERIFICATION_WRITER_ACTIVE' });
  s.current.verify(newer.id, 'r1', { pass: true });
  const restored = s.old.restoreSupersededVerification('artifact', { attempt: 1, isRunActive: s.inactive });
  assert.equal(restored.status, 'verifying'); assert.equal(restored.inputRefsInvalid, true);
  assert.equal(restored.attempts, 1); assert.equal(restored.retries, 0); assert.equal(restored.tokensUsed, 42);
  assert.throws(() => s.old.verify('artifact', 'r1', { pass: true, attempt: 1, result: s.report }), { code: 'VERIFICATION_EVIDENCE_REQUIRED' });
  const file = path.join(s.dir, 'pelican.html');
  const refreshed = { ...s.report, artifactVerifiedAt: restored.supersededVerification.restoredAt, artifactHashes: [{ path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }] };
  fs.writeFileSync(file, 'new artifact after independent review');
  assert.throws(() => s.old.verify('artifact', 'r1', { pass: true, attempt: 1, result: refreshed }), { code: 'VERIFICATION_EVIDENCE_REQUIRED' });
  const second = s.q2({ runId: s.oldRun.id });
  second.restoreSupersededVerification('artifact', { attempt: 1, isRunActive: s.inactive });
  refreshed.artifactHashes[0].sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const passed = second.verify('artifact', 'r1', { pass: true, attempt: 1, result: refreshed });
  assert.equal(passed.status, 'passed'); assert.equal(passed.inputRefsInvalid, false);
  assert.equal(passed.attempts, 1); assert.equal(passed.tokensUsed, 42);
});

test('方案点名的 owner 优先接单：别人不抢，只有它不可用时才顶上', (t) => {
  const s = fixture(t);
  const queue = s.q({ workers: ['codex', 'deepseek'], workerAvailable: worker => worker !== 'deepseek' });
  queue.enqueue([{ id: 'core', title: '核心模块', owner: 'deepseek', files: ['src/core.py'] }]);
  // deepseek 不可用（离线）→ codex 顶上，不能让任务干等
  const taken = queue.claim('codex');
  assert.equal(taken?.id, 'core', '指定者不在场时必须有别的搭档顶上');
  assert.equal(taken.actualExecutor, 'codex');
});

test('方案点名的 owner 在场时，其他搭档不抢它的活', (t) => {
  const s = fixture(t);
  const queue = s.q({ workers: ['codex', 'deepseek'], workerAvailable: () => true });
  queue.enqueue([{ id: 'core', title: '核心模块', owner: 'deepseek', files: ['src/core.py'] }]);
  assert.equal(queue.claim('codex'), null, 'codex 不该抢 deepseek 的指定任务');
  const mine = queue.claim('deepseek');
  assert.equal(mine?.id, 'core', '指定者本人可以接单');
  assert.equal(mine.actualExecutor, 'deepseek');
});

test('R171 死锁回归：升过级 + 点名拓展坞的任务，原生搭档不能抢、点名者能接', (t) => {
  const s = fixture(t);
  // 真实死锁：task-4 escalated=1 且 eligibleWorkers=[dock…] → 强搭档没资格、dock 也不算 strong，
  // 谁都领不走，连"继续"都救不回来（R171 实测）。
  // 这里让 owner（dock:f9cc73b3）暂时不可用，才能用另一个被点名的 dock 造出"连续失败 → escalated"。
  const queue = s.q({ workers: ['codex', 'deepseek', 'dock:a606e728', 'dock:f9cc73b3'], strongAgent: 'codex', workerAvailable: w => w !== 'dock:f9cc73b3' });
  queue.enqueue([{ id: 'desk', title: '桌面快捷方式实测', owner: 'dock:f9cc73b3', type: 'desktop', files: ['docs/verification.md'], acceptance: ['双击可用'], eligibleWorkers: ['dock:a606e728', 'dock:f9cc73b3'], planPinned: true }]);
  const first = queue.claim('dock:a606e728');
  assert.equal(first?.id, 'desk', '点名者不在场时由另一个被点名的拓展坞顶上');
  queue.fail('desk', first.leaseToken, ['执行超时'], { attempt: 1 });
  const second = queue.claim('dock:a606e728');
  assert.equal(second?.id, 'desk', '第二次仍应由被点名的拓展坞接单');
  queue.fail('desk', second.leaseToken, ['执行超时'], { attempt: 2 });
  const third = queue.claim('dock:a606e728');
  assert.equal(third?.id, 'desk', '第三次（重试用尽后升级）仍应可领');
  queue.fail('desk', third.leaseToken, ['执行超时'], { attempt: 3 });
  assert.equal(queue.get('desk').escalated, true, '连续失败后应标记升级');
  assert.equal(queue.claim('codex'), null, '升级也不能把拓展坞的点名绕过去（否则原生搭档必然失败）');
  assert.equal(queue.claim('deepseek'), null);
  assert.equal(queue.claim('dock:a606e728')?.id, 'desk', '被点名的拓展坞必须仍能接单，不能死锁');
});

test('双实例（两个 DatabaseSync 连接）领取互斥：同一任务不会被领两次', (t) => {
  const { q, q2 } = fixture(t);
  q().enqueue([{ id: 'T1', title: '唯一任务', files: ['src/a.mjs'] }]);

  const a = q();
  const b = q2();
  assert.notEqual(a.db, b.db, '两个实例必须是不同的连接');

  const first = a.claim('w1');
  assert.ok(first, '实例 A 应领取成功');
  assert.equal(first.id, 'T1');
  assert.equal(first.status, 'running');
  assert.ok(first.leaseToken, 'claim 必须返回 leaseToken');
  assert.equal(first.actualExecutor, 'w1');

  const second = b.claim('w2');
  assert.equal(second, null, '实例 B 不得领取已被 A 领取的任务');
  assert.equal(a.get('T1').attempts, 1, 'attempts 只应递增 1 次');
  assert.equal(b.list()[0].status, 'running', '状态跨连接可见');

  // 释放后另一连接才能领取（原子性没有把任务永久锁死）
  a.complete('T1', first.leaseToken, {});
  assert.equal(b.claim('w2'), null, 'verifying 状态不可被领取');
  a.verify('T1', 'r1', { pass: true });
  assert.equal(b.get('T1').status, 'passed');
});

test('未派发预算等待defer不花attempt或retry，拒绝错token、无可信声明和已启动PID', (t) => {
  const { q, q2 } = fixture(t, { workers: ['w1', 'w2'] });
  const queue = q(), observer = q2();
  queue.enqueue([{ id: 'wait', title: '等待预留额度', files: ['a.txt'], maxRetries: 2 }]);
  const first = queue.claim('w1');
  assert.throws(() => observer.defer('wait', 'wrong-token', { notDispatched: true }), LeaseLostError);
  assert.throws(() => queue.defer('wait', first.leaseToken), { code: 'DISPATCH_UNCERTAIN' });
  const deferred = queue.defer('wait', first.leaseToken, { notDispatched: true, reason: '预算暂被其他请求预留' });
  assert.equal(deferred.state, 'queued'); assert.equal(deferred.attempts, 0); assert.equal(deferred.retries, 0);
  assert.ok(observer.get('wait', { withHistory: true }).history.some(item => item.outcome === 'not-dispatched'));
  assert.throws(() => observer.defer('wait', first.leaseToken, { notDispatched: true }), LeaseLostError);
  const second = observer.claim('w2');
  assert.equal(second.attempts, 1); assert.notEqual(second.leaseToken, first.leaseToken);
  observer.heartbeat('wait', second.leaseToken, { executorPid: 12345 });
  assert.throws(() => observer.defer('wait', second.leaseToken, { notDispatched: true }), { code: 'DISPATCH_UNCERTAIN' });
  assert.equal(queue.get('wait').state, 'running'); assert.equal(queue.get('wait').attempts, 1);
});

test('多任务多 worker：每个任务只被领取一次，不重复执行', (t) => {
  const { q } = fixture(t, { workers: ['w1', 'w2'] });
  const queue = q();
  queue.enqueue([
    { id: 'T1', title: '一', files: ['src/a.mjs'] },
    { id: 'T2', title: '二', files: ['src/b.mjs'] },
    { id: 'T3', title: '三', files: ['src/c.mjs'] },
  ]);
  const claimed = new Map();
  for (let i = 0; i < 10; i++) {
    const task = queue.claim(i % 2 ? 'w1' : 'w2');
    if (!task) break;
    assert.ok(!claimed.has(task.id), `任务 ${task.id} 被重复领取`);
    claimed.set(task.id, task.leaseToken);
  }
  assert.deepEqual([...claimed.keys()].sort(), ['T1', 'T2']);
  assert.equal(queue.claim('w1'), null, '同一个搭档不能同时执行两个小任务');
  assert.equal(queue.metrics().depth.running, 2);
  queue.complete('T1', claimed.get('T1'), {}); queue.verify('T1', 'r1', { pass: true });
  const third = queue.claim('w2'); assert.equal(third.id, 'T3');
  assert.equal(third.attempts, 1, '后续空闲领取不重复执行已完成任务');
});

test('依赖只由 passed 释放；缺依赖 / 重复 id / cycle 一律 fail closed', (t) => {
  const { q } = fixture(t);
  const queue = q();
  queue.enqueue([
    { id: 'A', title: '前置', files: ['src/a.mjs'] },
    { id: 'B', title: '后继', files: ['src/b.mjs'], dependsOn: ['A'] },
  ]);

  // 依赖未 passed：B 不可领取。
  const a = queue.claim('w1');
  assert.equal(a.id, 'A');
  assert.equal(queue.claim('w1'), null, 'A 未 passed 时 B 不得领取');

  queue.complete('A', a.leaseToken, { ok: true });
  assert.equal(queue.claim('w1'), null, 'A 只在 verifying 时 B 仍不得领取');

  queue.verify('A', 'r1', { pass: true });
  const b = queue.claim('w1');
  assert.equal(b?.id, 'B', 'A passed 后 B 才可领取');

  // fail closed：缺依赖
  assert.throws(() => queue.enqueue([{ id: 'C', title: 'x', dependsOn: ['NOPE'] }]), (e) => e instanceof QueueError && e.code === 'MISSING_DEP');
  // fail closed：同批重复 id
  assert.throws(() => queue.enqueue([{ id: 'D', title: 'x' }, { id: 'D', title: 'y' }]), (e) => e.code === 'DUPLICATE_ID');
  // fail closed：cycle
  assert.throws(() => queue.enqueue([
    { id: 'E', title: 'e', dependsOn: ['F'] },
    { id: 'F', title: 'f', dependsOn: ['E'] },
  ]), (e) => e.code === 'DEP_CYCLE');
  // 已存在 id 幂等，不重复插入
  assert.deepEqual(queue.enqueue([{ id: 'A', title: '前置' }]), ['A']);
  assert.equal(queue.list().filter(x => x.id === 'A').length, 1);
});

test('文件范围互斥：父子路径 / 大小写 / 无 files 独占；越界路径拒绝', (t) => {
  const { q } = fixture(t);
  const queue = q();
  queue.enqueue([
    { id: 'P', title: '父目录', files: ['src'] },
    { id: 'C', title: '子文件', files: ['src/a.mjs'] },
    { id: 'S', title: '兄弟', files: ['src/b.mjs'] },
  ]);

  const first = queue.claim('w1');
  assert.equal(first.id, 'C', '同批按 id 升序领取');
  assert.equal(queue.claim('w1'), null, '子文件与父目录 src 重叠，不得并行');

  queue.complete('C', first.leaseToken, {});
  queue.verify('C', 'r1', { pass: true });
  const p = queue.claim('w1');
  assert.equal(p.id, 'P', 'P 与 S(b.mjs) 不重叠，但 P 覆盖 C 已完成，故仍可领');
  assert.equal(queue.claim('w1'), null, 'P 覆盖 S 的目录，不得并行');
  queue.complete('P', p.leaseToken, {});
  queue.verify('P', 'r1', { pass: true });
  const s = queue.claim('w1');
  assert.equal(s.id, 'S', '不重叠的兄弟路径可领取');
  queue.complete('S', s.leaseToken, {});
  queue.verify('S', 'r1', { pass: true });
  assert.equal(queue.claim('w1'), null, '全部完成后无任务可领');

  const caseless = q();
  caseless.enqueue([{ id: 'U1', title: '大写', files: ['SRC/AA.mjs'] }]);
  const u1 = caseless.claim('w1');
  assert.equal(u1.id, 'U1');
  assert.equal(caseless.claim('w1'), null, '同一路径（大小写）不得重复领取自身');
  caseless.enqueue([{ id: 'U2', title: '小写', files: ['src/aa.mjs'] }]);
  const u2 = caseless.claim('w2');
  if (caseless.metrics().caseInsensitive) {
    assert.equal(u2, null, '大小写不敏感文件系统上，SRC/AA.mjs 与 src/aa.mjs 视为重叠');
  } else {
    assert.equal(u2?.id, 'U2', '大小写敏感文件系统上，两者是不同路径');
    caseless.complete('U2', u2.leaseToken, {}); caseless.verify('U2', 'r1', { pass: true });
  }
  caseless.complete('U1', u1.leaseToken, {}); caseless.verify('U1', 'r1', { pass: true });
  if (!u2) { const later=caseless.claim('w2'); assert.equal(later.id,'U2'); caseless.complete('U2',later.leaseToken,{}); caseless.verify('U2','r1',{pass:true}); }

  // 无 files：独占，不得与任何任务并行
  const solo = q();
  solo.enqueue([
    { id: 'N', title: '无 files' },
    { id: 'X', title: '普通', files: ['other/z.mjs'] },
  ]);
  const n = solo.claim('w1');
  assert.equal(n.id, 'N');
  assert.equal(solo.claim('w1'), null, '无 files 任务必须独占 workspace');

  // 越界路径：fail closed
  assert.throws(() => queue.enqueue([{ id: 'ESC', title: 'x', files: ['../outside.mjs'] }]), (e) => e.code === 'PATH_ESCAPE');
  // 客户显式声明的任务目录外绝对路径可以入队（不再限制默认目录）；相对路径越界仍拒绝。
  assert.doesNotThrow(() => queue.enqueue([{ id: 'ESC2', title: 'x', files: [path.resolve(BEAT_ROOT, 'src/store.mjs')] }]));
});

test('活 pid 租约超时：不可重领、不可回写，但可被标记 stale', (t) => {
  const { q, advance } = fixture(t, { leaseMs: 1000 });
  const queue = q();
  queue.enqueue([{ id: 'T1', title: '活 pid', files: ['src/a.mjs'] }]);

  const claimed = queue.claim('w1', { pid: process.pid });
  assert.ok(claimed.leaseToken);
  advance(5000); // 租约过期，但 pid 仍存活

  assert.equal(queue.claim('w2'), null, '活 pid 超时不得被他人重领');

  const rec = queue.recover();
  assert.deepEqual(rec.requeued, [], '活 pid 不得重新入队');
  assert.deepEqual(rec.quarantined, [], '活 pid 不应被隔离');
  assert.deepEqual(rec.stale, ['T1'], '活 pid 超时应标记 stale');
  const after = queue.get('T1');
  assert.equal(after.status, 'running');
  assert.equal(after.stale, true);
  assert.equal(after.attempts, 1, 'attempts 不应因超时增加');

  assert.throws(() => queue.complete('T1', claimed.leaseToken, {}), (e) => e instanceof LeaseLostError && e.code === 'LEASE_LOST');
  assert.throws(() => queue.heartbeat('T1', claimed.leaseToken), (e) => e instanceof LeaseLostError);
});

test('确认持有 pid 已退出：租约超时后回收重领；活 pid / 无法确认死亡则不回收', async (t) => {
  const { q, advance } = fixture(t, { leaseMs: 1000 });
  const queue = q();
  const pid = await deadPid();
  queue.enqueue([{ id: 'T1', title: '死 pid', files: ['src/a.mjs'] }]);

  const claimed = queue.claim('w1', { pid });
  assert.equal(queue.get('T1').lease.pid, pid);
  queue.checkpoint('T1', claimed.leaseToken, { summary: '适配器核实无副作用', sideEffects: 'none' });
  advance(5000);

  const rec = queue.recover();
  assert.deepEqual(rec.requeued, ['T1'], '确认持有 pid 已退出且无未知副作用：应重新入队');
  assert.deepEqual(rec.quarantined, [], '无副作用证据时不应隔离');
  const requeued = queue.get('T1');
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.retries, 0, '回收不消耗 retry');
  assert.equal(requeued.lease, null);
  assert.ok(queue.attempts('T1').some(a => a.outcome === 'recovered'), '回收必须留证据');

  const again = queue.claim('w2');
  assert.equal(again?.id, 'T1', '回收后可被重新领取');
  assert.equal(again.attempts, 2, '重新领取应递增 attempts');
  assert.notEqual(again.leaseToken, claimed.leaseToken, '新一轮必须是新 fencing token');
});

test('unknown 隔离：未确认退出 + 未知副作用一律不重领', async (t) => {
  const { q, advance } = fixture(t, { leaseMs: 1000 });
  const queue = q();
  const pid = await deadPid();

  // (1) 显式声明 sideEffects:'unknown' 的检查点 → 死 pid 回收时隔离
  queue.enqueue([{ id: 'T1', title: '未知副作用', files: ['src/a.mjs'] }, { id: 'T3', title: '普通', files: ['src/c.mjs'] }]);
  const claimed = queue.claim('w1', { pid });
  assert.equal(claimed.id, 'T1');
  queue.checkpoint('T1', claimed.leaseToken, { path: 'src/a.mjs', summary: '改了外部环境', sideEffects: 'unknown' });
  advance(5000);
  const rec = queue.recover();
  assert.deepEqual(rec.quarantined, ['T1'], '未确认退出 + 未知副作用必须隔离');
  assert.deepEqual(rec.requeued, [], '隔离任务不得重入队');

  const q1 = queue.get('T1');
  assert.equal(q1.status, 'blocked');
  assert.equal(q1.quarantineReason, 'unconfirmed-exit+unknown-side-effects');
  assert.match(q1.issues.join(' '), /未确认退出|人工确认/);
  const c3 = queue.claim('w2'); assert.equal(c3?.id, 'T3', '隔离任务不得重领，只能领别的');
  assert.equal(queue.claim('w1'), null, '隔离任务永远不得被重新领取');

  // (2) 显式 fail({unknownSideEffects:true}) 同样隔离
  assert.equal(c3.id, 'T3');
  queue.fail('T3', c3.leaseToken, ['产生了未知副作用'], { unknownSideEffects: true });
  const t3 = queue.get('T3');
  assert.equal(t3.status, 'blocked');
  assert.equal(t3.quarantineReason, 'unconfirmed-exit+unknown-side-effects');
  assert.equal(queue.claim('w1'), null, '隔离任务不得被重新领取');
  assert.ok(queue.metrics().quarantined.includes('T1'));
  assert.ok(queue.events({ taskId: 'T1' }).some(e => e.type === 'quarantined'), '隔离必须留事件证据');
});

test('已确认退出（complete / sideEffects:none）才可回收重领', async (t) => {
  // complete 已确认 → 死 pid 回收重入队
  const { q, advance } = fixture(t, { leaseMs: 1000 });
  const queue = q();
  const pid = await deadPid();
  queue.enqueue([{ id: 'T2', title: '确认退出', files: ['src/b.mjs'] }]);
  const c = queue.claim('w1', { pid });
  queue.complete('T2', c.leaseToken, { ok: true });
  assert.equal(queue.get('T2').status, 'verifying');
  advance(5000);
  assert.deepEqual(queue.recover().requeued, [], 'complete 后已离开 running，回收不动它');
  assert.equal(queue.get('T2').status, 'verifying');

  // 检查点显式声明 sideEffects:'none' → 死 pid 回收可安全重领
  const io = fixture(t, { leaseMs: 1000 });
  const queue2 = io.q();
  const dead = await deadPid();
  queue2.enqueue([{ id: 'T4', title: '只读任务', files: ['src/d.mjs'] }]);
  const c4 = queue2.claim('w1', { pid: dead });
  queue2.checkpoint('T4', c4.leaseToken, { path: 'src/d.mjs', summary: '只读分析完成', sideEffects: 'none' });
  io.advance(5000);
  assert.deepEqual(queue2.recover().requeued, ['T4'], 'sideEffects:none 的死 pid 可安全回收');
  assert.equal(queue2.claim('w2')?.id, 'T4');
});

test('fence token：所有写入都必须持有有效 token，过期/伪造一律拒绝', (t) => {
  const { q, advance } = fixture(t, { leaseMs: 1000 });
  const queue = q();
  queue.enqueue([{ id: 'T1', title: 'fence', files: ['src/a.mjs'] }]);
  const claimed = queue.claim('w1');
  const token = claimed.leaseToken;

  assert.throws(() => queue.complete('T1', 'bogus-token', {}), (e) => e instanceof LeaseLostError);
  assert.throws(() => queue.heartbeat('T1', 'bogus-token'), (e) => e instanceof LeaseLostError);
  assert.throws(() => queue.checkpoint('T1', 'bogus-token', { path: 'src/a.mjs' }), (e) => e instanceof LeaseLostError);
  assert.throws(() => queue.fail('T1', 'bogus-token', ['x']), (e) => e instanceof LeaseLostError);
  assert.equal(queue.get('T1').status, 'running', '伪造 token 不得改变状态');

  // 合法 token 可以续租并写入
  queue.heartbeat('T1', token);
  queue.checkpoint('T1', token, { path: 'src/a.mjs', summary: 'ok', filesDone: ['src/a.mjs'] });

  // 换一轮后旧 token 失效（fencing）
  queue.fail('T1', token, ['需要重做']);
  assert.equal(queue.get('T1').status, 'queued');
  const again = queue.claim('w1');
  assert.notEqual(again.leaseToken, token);
  assert.throws(() => queue.complete('T1', token, {}), (e) => e instanceof LeaseLostError, '旧执行者不得用旧 token 回写');
  assert.equal(queue.get('T1').status, 'running', '旧 token 回写不得影响新一轮');
});

test('checkpoint：持久化路径+摘要+已完成项，下一执行者只续未完成项', async (t) => {
  const { q, advance } = fixture(t, { leaseMs: 1000 });
  const queue = q();
  const pid = await deadPid();
  queue.enqueue([{ id: 'T1', title: '断点续做', files: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'] }]);

  const first = queue.claim('w1', { pid });
  queue.checkpoint('T1', first.leaseToken, { path: 'src/a.mjs', summary: 'a 已完成', filesDone: ['src/a.mjs'] });
  queue.checkpoint('T1', first.leaseToken, { path: 'src/b.mjs', summary: 'b 已完成，适配器已核实可安全续做', filesDone: ['src/a.mjs', 'src/b.mjs'], sideEffects: 'none' });

  const cp = queue.get('T1');
  assert.equal(cp.checkpointPath, 'src/b.mjs');
  assert.deepEqual(cp.completedItems, ['src/a.mjs', 'src/b.mjs']);
  assert.equal(queue.checkpoints('T1').length, 2, '检查点必须持久化');

  advance(5000);
  assert.deepEqual(queue.recover().requeued, ['T1']);

  const second = queue.claim('w2', { pid: process.pid });
  assert.equal(second.attempts, 2);
  const plan = queue.resumePlan('T1');
  assert.equal(plan.status, 'running');
  assert.deepEqual(plan.completedItems, ['src/a.mjs', 'src/b.mjs']);
  assert.deepEqual(plan.remainingFiles.map(f => path.basename(f)), ['c.mjs'], '下一执行者只应续未完成项');
  assert.equal(plan.startFrom.path, 'src/b.mjs');
  assert.match(plan.note, /检查点/);
});

test('失败携 issues 重入队，最多 maxRetries=2 次后停止返工（blocked）', (t) => {
  const { q } = fixture(t, { workers: ['w1'] }); // 无 strong worker：重试耗尽直接 blocked
  const queue = q();
  queue.enqueue([{ id: 'T1', title: '会失败', files: ['src/a.mjs'], maxRetries: 2 }]);

  for (let i = 1; i <= 3; i++) {
    const c = queue.claim('w1');
    assert.ok(c, `第 ${i} 次应可领取`);
    const out = queue.fail('T1', c.leaseToken, [`第 ${i} 次失败：断言 X 不成立`]);
    assert.equal(out.retries, Math.min(i, 2));
    assert.deepEqual(out.issues, [`第 ${i} 次失败：断言 X 不成立`]);
    assert.equal(out.executor, null);
    if (i < 3) assert.equal(out.status, 'queued', `第 ${i} 次失败后应重入队`);
    else {
      assert.equal(out.status, 'blocked', '无 strong worker 时重试耗尽立即停止返工');
      assert.equal(out.quarantineReason, 'retries-exhausted');
    }
  }

  assert.equal(queue.claim('w1'), null, 'blocked 后不得再被领取（不无限返工）');
  assert.equal(queue.attempts('T1').filter(a => a.outcome === 'claimed').length, 3, '初次执行 + 最多 2 次重试都留证据');

  assert.throws(() => queue.enqueue([{ id: 'BAD', title: 'x', maxRetries: 3 }]), (e) => e.code === 'BAD_RETRIES');
  // 无 issues 的 fail 拒绝：不允许无证据返工
  const c2 = q().enqueue([{ id: 'T2', title: 'y', files: ['src/y.mjs'] }]);
  assert.deepEqual(c2, ['T2']);
  const claim2 = q().claim('w1', { pid: process.pid });
  assert.throws(() => q().fail('T2', claim2.leaseToken, []), (e) => e.code === 'ISSUES_REQUIRED');
});

test('验证只能由非执行者进行；pass→passed，fail→queued 且次数+1', (t) => {
  const { q } = fixture(t, { workers: ['w1', 'w2'] });
  const queue = q();
  queue.enqueue([
    { id: 'T1', title: '甲', files: ['src/a.mjs'] },
    { id: 'T2', title: '乙', files: ['src/b.mjs'] },
  ]);

  const c1 = queue.claim('w1');
  assert.equal(c1.executor, 'w1');
  queue.complete('T1', c1.leaseToken, { ok: true });
  assert.equal(queue.get('T1').status, 'verifying', 'complete 后必须进入 verifying');

  assert.throws(() => queue.verify('T1', 'w1', { pass: true }), (e) => e.code === 'REVIEWER_IS_EXECUTOR');
  assert.equal(queue.get('T1').status, 'verifying', '自审不得改变状态');

  const rejected = queue.verify('T1', 'w2', { pass: false, issues: ['缺少单元测试'] });
  assert.equal(rejected.status, 'queued');
  assert.equal(rejected.retries, 1, '验证失败应使次数 +1');
  assert.deepEqual(rejected.issues, ['缺少单元测试']);

  // 非执行者（且非上一次执行者）验证通过
  const c1b = queue.claim('w1');
  queue.complete('T1', c1b.leaseToken, { ok: true });
  const passed = queue.verify('T1', 'w2', { pass: true });
  assert.equal(passed.status, 'passed');
  assert.equal(passed.reviewer, 'w2');
  assert.equal(passed.executor, 'w1', '执行者记录保留为证据');
  assert.throws(() => queue.verify('T2', 'r1', { pass: true }), (e) => e.code === 'BAD_STATE', '未 complete 的任务不可验证');
  assert.throws(() => queue.verify('T1', 'w2', {}) , (e) => e.code === 'BAD_VERDICT');
  assert.throws(() => queue.verify('T1', 'w2', { pass: false }), (e) => e.code === 'BAD_STATE');
});

test('重试耗尽后升级 strong worker；strong 也失败才 blocked', (t) => {
  const { q } = fixture(t, { workers: ['w1', { id: 'w2', strong: true }] });
  const queue = q();
  queue.enqueue([{ id: 'T1', title: '难题', files: ['src/a.mjs'], maxRetries: 2, difficulty: 'hard' }]);

  // 前两次失败留在普通池
  for (let i = 1; i <= 2; i++) {
    const c = queue.claim('w1');
    assert.ok(c, `第 ${i} 次 w1 应能领取`);
    assert.equal(c.escalated, false);
    queue.fail('T1', c.leaseToken, [`失败 ${i}`]);
  }

  // 第 3 次失败 → 升级 strong worker
  const third = queue.claim('w1');
  assert.ok(third, '第 3 次仍由原池领取');
  const escalated = queue.fail('T1', third.leaseToken, ['第三次失败']);
  assert.equal(escalated.status, 'queued');
  assert.equal(escalated.escalated, true, '重试耗尽后应升级 strong worker');

  assert.equal(queue.claim('w1'), null, '升级任务不应再交给普通 worker');
  const strong = queue.claim('w2');
  assert.equal(strong?.id, 'T1', 'strong worker 应能领取升级任务');
  const done = queue.fail('T1', strong.leaseToken, ['strong 也失败']);
  assert.equal(done.status, 'blocked');
  assert.equal(done.quarantineReason, 'retries-exhausted');
  assert.equal(queue.claim('w2'), null);
});

test('token 记账与预算止损：预算用尽后停止领取', (t) => {
  const { q } = fixture(t);
  const queue = q();
  queue.enqueue([
    { id: 'T1', title: '预算 100', files: ['src/a.mjs'], tokenBudget: 100 },
    { id: 'T2', title: '无限预算', files: ['src/b.mjs'] },
  ]);

  const c1 = queue.claim('w1');
  assert.equal(c1.id, 'T1');
  queue.recordUsage('T1', c1.leaseToken, { tokens: 60, promptTokens: 40, completionTokens: 20 });
  assert.equal(queue.get('T1').tokensUsed, 60);
  queue.recordUsage('T1', c1.leaseToken, { totalTokens: 50 });
  assert.equal(queue.get('T1').tokensUsed, 110, 'token 记账应累加');

  assert.equal(queue.claim('w1'), null, '预算用尽的运行中任务不得重领');
  queue.complete('T1', c1.leaseToken, {});
  queue.verify('T1', 'r1', { pass: true });
  const c2=queue.claim('w1'); assert.equal(c2?.id, 'T2', 'T1 预算用尽，只能领 T2');
  queue.complete('T2',c2.leaseToken,{});queue.verify('T2','r1',{pass:true});
  assert.equal(queue.metrics().tokens.used, 110);
  assert.ok(queue.events({ taskId: 'T1' }).some(e => e.type === 'token-brake'), '预算止损必须有事件证据');

  // run 级 cap
  const capEx = q({runId:'cap-run'});
  capEx.tokenBudgetCap(10);
  assert.equal(capEx.tokenBudgetCap(), 10);
  capEx.enqueue([{ id: 'X1', title: 'x', files: ['src/x.mjs'] }]);
  const cx = capEx.claim('w1');
  capEx.recordUsage('X1', cx.leaseToken, { tokens: 10 });
  capEx.complete('X1', cx.leaseToken, {});
  capEx.verify('X1', 'r1', { pass: true });
  capEx.enqueue([{ id: 'X2', title: 'y', files: ['src/y.mjs'] }]);
  assert.equal(capEx.claim('w1'), null, 'run 级 token cap 用尽后应止损');
  assert.equal(capEx.metrics().tokens.exhausted, true);
});

test('cancel 保留证据（任务/尝试/检查点/事件都不删除）', async (t) => {
  const { q } = fixture(t);
  const queue = q();
  const pid = await deadPid();
  queue.enqueue([
    { id: 'T1', title: '跑着的', files: ['src/a.mjs'] },
    { id: 'T2', title: '排队的', files: ['src/b.mjs'] },
  ]);
  const c1 = queue.claim('w1', { pid });
  queue.checkpoint('T1', c1.leaseToken, { path: 'src/a.mjs', summary: '做了一半', filesDone: ['src/a.mjs'] });

  const cancelled = queue.cancel(undefined, { reason: '用户叫停' });
  assert.deepEqual(cancelled.map(x => x.id).sort(), ['T1', 'T2']);

  const t1 = queue.get('T1');
  assert.equal(t1.status, 'blocked');
  assert.equal(t1.cancelled, true);
  assert.equal(t1.quarantineReason, 'cancelled:用户叫停');
  assert.equal(t1.lease, null);
  assert.deepEqual(t1.completedItems, ['src/a.mjs'], '检查点作为证据保留');
  assert.equal(queue.checkpoints('T1').length, 1);
  assert.equal(queue.attempts('T1').length, 3, 'enqueued + claimed + cancelled 证据保留');
  assert.ok(queue.events({ taskId: 'T1' }).some(e => e.type === 'cancelled'));
  assert.equal(queue.claim('w1'), null, '取消后不得再领取');
  assert.equal(queue.list().length, 2, '取消不删除任务');
});

test('metrics 汇总排队深度、隔离、token 与超时证据', (t) => {
  const { q, advance } = fixture(t, { leaseMs: 1000 });
  const queue = q();
  queue.enqueue([
    { id: 'T1', title: '一', files: ['src/a.mjs'] },
    { id: 'T2', title: '二', files: ['src/b.mjs'] },
    { id: 'T3', title: '三', files: ['src/c.mjs'] },
  ]);
  const c1 = queue.claim('w1');
  queue.recordUsage('T1', c1.leaseToken, { tokens: 7 });
  queue.complete('T1', c1.leaseToken, {});
  queue.verify('T1', 'r1', { pass: true });
  const c2 = queue.claim('w1');
  queue.fail('T2', c2.leaseToken, ['x']);
  advance(5000);
  queue.recover(); // T3 不在 running，无影响

  const m = queue.metrics();
  assert.equal(m.runId, 'run1');
  assert.equal(m.depth.queued, 2);
  assert.equal(m.depth.passed, 1);
  assert.equal(m.total, 3);
  assert.equal(m.tokens.used, 7);
  assert.deepEqual(m.workers, {});
  assert.equal(typeof m.caseInsensitive, 'boolean');
  assert.ok(Array.isArray(m.quarantined));
});

test('重新打开同一 Store（进程重启）后队列状态与租约语义保持', async (t) => {
  const io = fixture(t, { leaseMs: 1000 });
  const q1 = io.q();
  const pid = await deadPid();
  q1.enqueue([{ id: 'T1', title: '持久化', files: ['src/a.mjs'] }]);
  const c1 = q1.claim('w1', { pid });
  q1.checkpoint('T1', c1.leaseToken, { sideEffects:'none', summary:'已核实可安全恢复' });
  io.advance(5000);

  // 新的 TaskQueue 实例（模拟重启后重新接入同一 SQLite 文件）
  const q2 = io.reopen();
  assert.equal(q2.get('T1').status, 'running');
  assert.equal(q2.get('T1').lease.pid, pid);
  assert.equal(q2.claim('w2'), null, '活/死 pid 未确认前不得重领');
  const rec = q2.recover();
  assert.deepEqual(rec.requeued, ['T1'], '重启后应能回收确认已退出的任务');
  const c2 = q2.claim('w2', { pid: process.pid });
  assert.equal(c2.attempts, 2);
  assert.notEqual(c2.leaseToken, c1.leaseToken);
  q2.complete('T1', c2.leaseToken, { ok: true });
  q2.verify('T1', 'r1', { pass: true });
  assert.equal(io.q().get('T1').status, 'passed', '状态跨实例可见');
});

test('configured eligibility, reference-only context, difficulty aliases and strong role are preserved', t => {
  const io=fixture(t,{workers:['cheap','strong']}), queue=io.q({strongAgent:'strong',maxRetries:0});
  queue.enqueue([{id:'A',title:'小任务',files:['a.txt'],eligibleWorkers:['cheap'],difficulty:'simple',maxRetries:2,inputRefs:[{path:'input.txt',summary:'input'}],outputRefs:['a.txt']}]);
  assert.equal(queue.get('A').difficulty,'easy'); assert.equal(queue.get('A').maxRetries,0);
  assert.equal(queue.get('A').inputRefs[0].summary,'input'); assert.deepEqual(queue.get('A').outputRefs,['a.txt']);
  assert.equal(queue.claim('strong'),null); const first=queue.claim('cheap');assert.equal(first.id,'A');
  queue.fail('A',first.leaseToken,['升级处理']); assert.equal(queue.get('A').escalated,true);
  assert.equal(queue.claim('cheap'),null); const upgrade=queue.claim('strong');assert.equal(upgrade.id,'A');
  queue.fail('A',upgrade.leaseToken,['停止返工']);assert.equal(queue.get('A').status,'blocked');
  queue.enqueue([{id:'B',title:'无可用负责人',files:['b.txt'],eligibleWorkers:[]}]);
  assert.equal(queue.get('B').status,'blocked');assert.match(queue.get('B').issues.join(' '),/不可用/);
});

test('stale reviewer cannot approve or reject a newer attempt across independent connections', t => {
  const io=fixture(t),queue=io.q(),other=io.q2();
  queue.enqueue([{id:'A',title:'审核轮次',files:['a.txt']}]); const a=queue.claim('w1');queue.complete('A',a.leaseToken,{});
  other.verify('A','r1',{pass:false,issues:['修复'],attempt:a.attempts});
  const b=other.claim('w1');other.complete('A',b.leaseToken,{});
  assert.throws(()=>queue.verify('A','r1',{pass:true,attempt:a.attempts}),LeaseLostError);
  assert.throws(()=>queue.fail('A',null,['旧问题'],{terminal:true,attempt:a.attempts}),LeaseLostError);
  assert.equal(queue.get('A').status,'verifying');
  queue.verify('A','r1',{pass:true,attempt:b.attempts});assert.equal(other.get('A').status,'passed');
});

test('budget or terminal failure stops without spending retries, including during independent verification', t => {
  const queue=fixture(t).q();queue.enqueue([{id:'A',title:'预算',files:['a.txt']}]);let a=queue.claim('w1');
  queue.fail('A',a.leaseToken,['预算到限'],{budgetExceeded:true,attempt:a.attempts});assert.equal(queue.get('A').status,'blocked');assert.equal(queue.get('A').retries,0);
  queue.enqueue([{id:'B',title:'核验失败',files:['b.txt']}]);a=queue.claim('w1');queue.complete('B',a.leaseToken,{});
  queue.fail('B',null,['没有独立核验者'],{terminal:true,attempt:a.attempts});assert.equal(queue.get('B').status,'blocked');assert.equal(queue.get('B').retries,0);
});

test('dead coordinator cannot release lease while native executor PID is still alive', t => {
  const io=fixture(t),queue=io.q({isProcessAlive:pid=>pid===222});queue.enqueue([{id:'A',title:'native alive',files:['a.txt']}]);
  const a=queue.claim('w1',{pid:111});queue.heartbeat('A',a.leaseToken,{executorPid:222});queue.checkpoint('A',a.leaseToken,{sideEffects:'none'});
  io.advance(2000);assert.deepEqual(queue.recover().stale,['A']);assert.equal(queue.claim('w2'),null);assert.equal(queue.get('A').lease.executorPid,222);
  const after=io.q({isProcessAlive:()=>false});assert.deepEqual(after.recover().requeued,['A']);
});

test('task usage separates provider evidence from estimates and rejects negative usage', t => {
  const queue=fixture(t).q();queue.enqueue([{id:'A',title:'usage',files:['a.txt']}]);const a=queue.claim('w1');
  queue.recordUsage('A',a.leaseToken,{totalTokens:12,verified:true});queue.recordUsage('A',a.leaseToken,{tokens:20,verified:false});
  const usage=queue.get('A').usage;assert.equal(usage.measuredTokens,12);assert.equal(usage.estimatedTokens,20);assert.equal(usage.unknownCalls,1);
  assert.equal(queue.metrics().tokens.measuredTokens,12);assert.equal(queue.metrics().tokens.estimatedTokens,20);
  assert.throws(()=>queue.recordUsage('A',a.leaseToken,{tokens:-5}),/不能为负/);assert.equal(queue.get('A').tokensUsed,32);
});

test('checkpoint refuses path or junction escapes and retains resume fields', t => {
  const io=fixture(t),queue=io.q();queue.enqueue([{id:'A',title:'checkpoint',files:['a.txt']}]);const a=queue.claim('w1');
  assert.throws(()=>queue.checkpoint('A',a.leaseToken,{path:'../outside.json'}),e=>e.code==='PATH_ESCAPE');
  const outside=tmpRoot('outside');fs.symlinkSync(outside,path.join(io.dir,'out'),'junction');
  assert.throws(()=>queue.checkpoint('A',a.leaseToken,{path:'out/checkpoint.json'}),e=>e.code==='PATH_ESCAPE');
  queue.checkpoint('A',a.leaseToken,{summary:'done one',completed:['step1'],next:['step2'],artifacts:[{path:'a.txt',summary:'draft'}]});
  assert.deepEqual(queue.get('A').completedItems,['step1']);assert.deepEqual(queue.get('A').checkpoint.next,['step2']);
});

test('global rework only reopens named task; passed consumers invalidate input and wait for dependency', t => {
  const queue=fixture(t).q();queue.enqueue([{id:'A',title:'producer',files:['a.txt']},{id:'B',title:'consumer',files:['b.txt'],dependsOn:['A']},{id:'C',title:'independent',files:['c.txt']}]);
  const a=passTask(queue,t,'A');const b=passTask(queue,t,'B');passTask(queue,t,'C');
  assert.throws(()=>queue.reopen('A','w1',['problem'],{attempt:a.attempts}),e=>e.code==='REVIEWER_IS_EXECUTOR');
  assert.throws(()=>queue.reopen('A','r1',['problem'],{attempt:99}),LeaseLostError);
  queue.reopen('A','r1',['wrong output'],{attempt:a.attempts});assert.equal(queue.get('A').status,'queued');assert.equal(queue.get('B').status,'verifying');assert.equal(queue.get('B').inputRefsInvalid,true);assert.equal(queue.get('C').status,'passed');
  assert.throws(()=>queue.verify('B','r1',{pass:true,attempt:b.attempts}),e=>e.code==='DEPENDENCY_NOT_PASSED');
  passTask(queue,t,'A');queue.verify('B','r1',{pass:true,attempt:b.attempts});assert.equal(queue.get('B').attempts,1);assert.equal(queue.get('B').inputRefsInvalid,false);
});

test('file locks cover parallel runs and persist during verification or unknown-side-effect isolation', t => {
  const io=fixture(t),a=io.q({runId:'a'}),b=io.q2({runId:'b'});
  a.enqueue([{id:'T',title:'first',files:['shared.txt']}]);b.enqueue([{id:'T',title:'second',files:['shared.txt']}]);
  const claimed=a.claim('w1');assert.equal(b.claim('w2'),null);
  a.complete('T',claimed.leaseToken,{});assert.equal(b.claim('w2'),null);a.verify('T','r1',{pass:true});
  const second=b.claim('w2');assert.equal(second.id,'T');b.fail('T',second.leaseToken,['unknown'],{unknownSideEffects:true});
  a.enqueue([{id:'T2',title:'third',files:['shared.txt']}]);assert.equal(a.claim('w1'),null);
});

test('claim admission callback skips unaffordable tasks and fails closed without changing leases', t => {
  const io=fixture(t),queue=io.q({canClaim:(worker,task)=>worker==='w1'&&task.id==='B'});
  queue.enqueue([{id:'A',title:'skip',files:['a.txt']},{id:'B',title:'allowed',files:['b.txt']}]);
  assert.equal(queue.claim('w2'),null);assert.equal(queue.get('A').attempts,0);assert.equal(queue.get('B').attempts,0);
  const admitted=queue.claim('w1');assert.equal(admitted.id,'B');assert.equal(queue.get('A').status,'queued');
  queue.complete('B',admitted.leaseToken,{});queue.verify('B','r1',{pass:true});
  const throwing=io.q({canClaim:()=>{throw Error('admission unavailable');}});
  assert.throws(()=>throwing.claim('w1'),/admission unavailable/);assert.equal(queue.get('A').status,'queued');assert.equal(queue.get('A').attempts,0);
  const wrong=io.q({canClaim:()=>Promise.resolve(true)});assert.equal(wrong.claim('w1'),null);assert.equal(queue.get('A').attempts,0);
});

test('route block only changes queued task with matching attempt, retains evidence and never fakes cancellation', t => {
  const queue=fixture(t).q();queue.enqueue([{id:'A',title:'insufficient',files:['a.txt']}]);
  assert.throws(()=>queue.block('A',['budget'],{attempt:2}),LeaseLostError);
  assert.equal(queue.get('A').status,'queued');
  const blocked=queue.block('A',['预算不足，尚未执行'],{attempt:0,reason:'insufficient-budget'});
  assert.equal(blocked.status,'blocked');assert.equal(blocked.cancelled,false);assert.equal(blocked.attempts,0);
  assert.equal(blocked.quarantineReason,'insufficient-budget');assert.equal(queue.attempts('A').length,2);
  queue.enqueue([{id:'B',title:'running',files:['b.txt']}]);const b=queue.claim('w1');
  assert.throws(()=>queue.block('B',['bad block'],{attempt:b.attempts}),e=>e.code==='BAD_STATE');
  assert.equal(queue.get('B').status,'running');assert.equal(queue.get('B').lease.owner,'w1');
});

test('glob lock is conservatively exclusive while public task file permission retains declared pattern', t => {
  const io=fixture(t),queue=io.q();
  queue.enqueue([{id:'A',title:'glob',files:['src/**']},{id:'B',title:'concrete',files:['src/a.mjs']},{id:'C',title:'disjoint',files:['other/*.mjs']}]);
  const a=queue.claim('w1');assert.equal(a.id,'A');assert.match(a.files[0],/src\/\*\*$/);
  const c=queue.claim('w2');assert.equal(c.id,'C','overlapping concrete scope must be skipped, disjoint directory can run');
  queue.complete('C',c.leaseToken,{});queue.verify('C','r1',{pass:true});assert.equal(queue.claim('w2'),null);
  queue.complete('A',a.leaseToken,{});queue.verify('A','r1',{pass:true});assert.equal(queue.claim('w2').id,'B');
});

test('internal junction aliases share file lock and declarations through external junction are rejected', t => {
  const io=fixture(t),queue=io.q();fs.mkdirSync(path.join(io.dir,'real'));
  fs.symlinkSync(path.join(io.dir,'real'),path.join(io.dir,'alias'),'junction');
  queue.enqueue([{id:'A',title:'real path',files:['real/a.txt']},{id:'B',title:'alias path',files:['alias/a.txt']}]);
  const a=queue.claim('w1');assert.equal(a.id,'A');assert.equal(queue.claim('w2'),null);
  assert.match(queue.get('B').files[0],/alias\/a\.txt$/,'permission declaration must not be widened or rewritten to real path');
  const outside=tmpRoot('declared-outside');fs.symlinkSync(outside,path.join(io.dir,'outside'),'junction');
  assert.throws(()=>queue.enqueue([{id:'C',title:'outside',files:['outside/a.txt']}]),e=>e.code==='PATH_ESCAPE');
});

test('电脑睡眠导致本进程租约过期：令牌未轮换时续期保存结果；被别人接手过则拒绝', async () => {
  const { Store } = await import('../src/store.mjs');
  const { TaskQueue } = await import('../src/task-queue.mjs');
  const store = new Store(':memory:'); let clock = 1000;
  try {
    const q = new TaskQueue({ store, runId: 'sleep', cwd: process.cwd(), leaseMs: 100, workers: ['codex', 'deepseek'], now: () => clock, caseInsensitive: false });
    q.enqueue([{ id: 'a', title: 'a', files: ['a.txt'], acceptance: ['x'] }]);
    const t = q.claim('codex', { pid: process.pid });
    clock += 10 * 60 * 1000;
    assert.equal(q.renewOwnLease('a', t.leaseToken), true);
    q.complete('a', t.leaseToken, { summary: 'done', artifacts: [] });
    assert.equal(q.list()[0].state || q.list()[0].status, 'verifying');
    assert.equal(q.renewOwnLease('a', 'someone-else'), false);
  } finally { store.close(); }
});

function blockedCheckReport(dir, id = 'T1') {
  return { taskId: id, executor: 'w1', summary: '真实执行产物', artifacts: [{ path: path.join(dir, 'result.txt') }],
    checks: [{ command: 'node --test test.mjs', ok: false, notDispatched: true, unknownSideEffects: false, output: '等待客户确认检查范围' }] };
}

test('检查未派发时保留 verifying：跨实例保存结果和问题，不重做、不消耗重试或费用', (t) => {
  const io = fixture(t, { workers: ['w1', 'w2'] }), queue = io.q();
  queue.enqueue([{ id: 'T1', title: '已有产物', files: ['result.txt'] }, { id: 'T2', title: '相同文件', files: ['result.txt'] }]);
  const claimed = queue.claim('w1');
  fs.writeFileSync(path.join(io.dir, 'result.txt'), '真实产物');
  queue.recordUsage('T1', claimed.leaseToken, { tokens: 41, verified: true });
  const original = blockedCheckReport(io.dir); delete original.checks;
  queue.complete('T1', claimed.leaseToken, original);
  const before = queue.get('T1', { withHistory: true });
  const report = { ...original, checks: blockedCheckReport(io.dir).checks };
  const held = queue.holdVerification('T1', ['检查尚未执行，等待确认'], { attempt: claimed.attempts, result: report });
  assert.equal(held.status, 'verifying'); assert.equal(held.executor, 'w1');
  assert.equal(held.attempts, before.attempts); assert.equal(held.retries, before.retries); assert.equal(held.tokensUsed, 41);
  assert.deepEqual(held.usage, before.usage); assert.deepEqual(held.result.checks, report.checks);
  assert.deepEqual(held.issues, ['检查尚未执行，等待确认']);
  const other = io.q2(); assert.equal(other.claim('w2'), null, '产物范围仍锁定，不能被重新领取或覆盖');
  assert.deepEqual(other.get('T1').result, held.result);
  assert.ok(other.events({ taskId: 'T1' }).some(event => event.type === 'verification-held'));
  assert.throws(() => other.holdVerification('T1', ['旧核验'], { attempt: claimed.attempts - 1, result: report }), LeaseLostError);
  assert.throws(() => other.holdVerification('T1', ['缺轮次'], { result: report }), LeaseLostError);
  assert.throws(() => other.holdVerification('T1', [], { attempt: claimed.attempts, result: report }), error => error.code === 'ISSUES_REQUIRED');
  assert.throws(() => other.holdVerification('T1', ['假执行者'], { attempt: claimed.attempts, result: { ...report, executor: 'w2' } }), error => error.code === 'VERIFICATION_EVIDENCE_REQUIRED');
  assert.throws(() => other.holdVerification('T1', ['假产物'], { attempt: claimed.attempts, result: { ...report, artifacts: [{ path: 'other.txt' }] } }), error => error.code === 'VERIFICATION_EVIDENCE_REQUIRED');
  queue.verify('T1', 'r1', { pass: true, attempt: claimed.attempts });
  assert.equal(queue.get('T1').status, 'passed'); assert.equal(queue.claim('w2')?.id, 'T2');
});

test('旧检查拒绝导致 retries-exhausted 时仅恢复验收：真实身份和费用、重试历史全部保留', (t) => {
  const io = fixture(t), queue = io.q();
  queue.enqueue([{ id: 'T1', title: '恢复旧结果', files: ['result.txt'], maxRetries: 0 }]);
  const claimed = queue.claim('w1'), report = blockedCheckReport(io.dir);
  queue.recordUsage('T1', claimed.leaseToken, { tokens: 123, verified: true });
  queue.complete('T1', claimed.leaseToken, report);
  const blocked = queue.verify('T1', 'r1', { pass: false, issues: ['检查被拒绝'], attempt: claimed.attempts, result: report });
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.executor, null);
  assert.equal(blocked.quarantineReason, 'retries-exhausted');
  const beforeHistory = queue.get('T1', { withHistory: true }).history.length;
  const resumed = io.q2().restoreBlockedVerification('T1', { attempt: claimed.attempts });
  assert.equal(resumed.status, 'verifying'); assert.equal(resumed.executor, 'w1'); assert.equal(resumed.quarantineReason, null);
  assert.equal(resumed.attempts, blocked.attempts); assert.equal(resumed.retries, blocked.retries);
  assert.equal(resumed.tokensUsed, 123); assert.deepEqual(resumed.usage, blocked.usage); assert.deepEqual(resumed.result, report);
  assert.ok(queue.get('T1', { withHistory: true }).history.length > beforeHistory);
  assert.equal(queue.claim('w1'), null, '恢复只核验，绝不重新执行');
  assert.throws(() => queue.verify('T1', 'w1', { pass: true, attempt: claimed.attempts }), error => error.code === 'REVIEWER_IS_EXECUTOR');
  queue.verify('T1', 'r1', { pass: true, attempt: claimed.attempts }); assert.equal(queue.get('T1').attempts, 1);
});

test('恢复旧验收严格拒绝缺证据、已运行失败、未知副作用、取消、活租约及过期身份', (t) => {
  const cases = [
    ['缺检查', report => { delete report.checks; }],
    ['无失败项', report => { report.checks[0].ok = true; }],
    ['检查结果缺 ok', report => { delete report.checks[0].ok; }],
    ['派发未知', report => { delete report.checks[0].notDispatched; }],
    ['曾运行失败', report => { report.checks[0].notDispatched = false; }],
    ['副作用缺证据', report => { delete report.checks[0].unknownSideEffects; }],
    ['检查副作用未知', report => { report.checks[0].unknownSideEffects = true; }],
    ['工具实际派发', report => { report.checks[0].evidence = { observed: { dispatched: true } }; }],
    ['工具动作副作用未知', report => { report.checks[0].evidence = { calls: [{ evidence: { sideEffects: 'unknown' } }] }; }],
    ['检查命令缺失', report => { delete report.checks[0].command; }],
    ['检查取消', report => { report.checks[0].cancelled = true; }],
    ['电脑副作用未知', report => { report.desktopEvidence = { sideEffects: 'unknown' }; }],
    ['不同执行者', report => { report.executor = 'w2'; }],
    ['不同任务', report => { report.taskId = 'OTHER'; }],
    ['无产物', report => { report.artifacts = []; }],
  ];
  for (const [label, mutate] of cases) {
    const io = fixture(t), queue = io.q();
    queue.enqueue([{ id: 'T1', title: label, files: ['result.txt'], maxRetries: 0 }]);
    const claimed = queue.claim('w1'), report = blockedCheckReport(io.dir);
    queue.complete('T1', claimed.leaseToken, report); queue.verify('T1', 'r1', { pass: false, issues: ['检查被拒绝'], attempt: claimed.attempts });
    const bad = JSON.parse(JSON.stringify(report)); mutate(bad);
    io.store.db.prepare('UPDATE tq_tasks SET result=? WHERE scope=? AND id=?').run(JSON.stringify(bad), 'run1', 'T1');
    assert.throws(() => queue.restoreBlockedVerification('T1', { attempt: claimed.attempts }), error => error.code === 'VERIFICATION_EVIDENCE_REQUIRED', label);
    assert.equal(queue.get('T1').status, 'blocked', label + '不改变状态');
  }
  for (const [column, value] of [['cancelled', 1], ['completed', 0], ['side_effects_verified', 0], ['side_effects', 'unknown'], ['lease_token', 'live'], ['lease_pid', process.pid], ['lease_expires_at', 2_000_000]]) {
    const io = fixture(t), queue = io.q(); queue.enqueue([{ id: 'T1', title: column, files: ['result.txt'], maxRetries: 0 }]);
    const claimed = queue.claim('w1'); queue.complete('T1', claimed.leaseToken, blockedCheckReport(io.dir));
    queue.verify('T1', 'r1', { pass: false, issues: ['拒绝'], attempt: claimed.attempts });
    io.store.db.prepare(`UPDATE tq_tasks SET ${column}=? WHERE scope=? AND id=?`).run(value, 'run1', 'T1');
    assert.throws(() => queue.restoreBlockedVerification('T1', { attempt: claimed.attempts }), error => error.code === 'VERIFICATION_UNSAFE', column);
  }
  const io = fixture(t), queue = io.q(); queue.enqueue([{ id: 'T1', title: '轮次', files: ['result.txt'], maxRetries: 0 }]);
  const claimed = queue.claim('w1'); queue.complete('T1', claimed.leaseToken, blockedCheckReport(io.dir));
  assert.throws(() => queue.restoreBlockedVerification('T1', { attempt: claimed.attempts }), error => error.code === 'BAD_STATE');
  queue.verify('T1', 'r1', { pass: false, issues: ['拒绝'], attempt: claimed.attempts });
  assert.throws(() => queue.restoreBlockedVerification('T1', { attempt: claimed.attempts - 1 }), LeaseLostError);
  assert.throws(() => queue.restoreBlockedVerification('T1', {}), LeaseLostError);
});

test('控制器新鲜检查记录可补齐旧完成报告，但不能改身份、产物或覆盖曾运行失败的历史', (t) => {
  const io = fixture(t), queue = io.q();
  queue.enqueue([{ id: 'T1', title: '旧完成报告无检查', files: ['result.txt'], maxRetries: 0 }]);
  const claimed = queue.claim('w1'), original = blockedCheckReport(io.dir); delete original.checks;
  original.reportPath = path.join(io.dir, '.beat-control', 'run1', 'T1', 'report-1.json');
  queue.complete('T1', claimed.leaseToken, original);
  queue.verify('T1', 'r1', { pass: false, issues: ['旧检查拒绝，原控制器未保存检查结果'], attempt: claimed.attempts });
  const fresh = { ...original, checks: blockedCheckReport(io.dir).checks };
  assert.throws(() => queue.restoreBlockedVerification('T1', { attempt: claimed.attempts }), error => error.code === 'VERIFICATION_EVIDENCE_REQUIRED');
  assert.throws(() => queue.restoreBlockedVerification('T1', { attempt: claimed.attempts, result: { ...fresh, reportPath: 'another.json' } }), error => error.code === 'VERIFICATION_EVIDENCE_REQUIRED');
  assert.throws(() => queue.restoreBlockedVerification('T1', { attempt: claimed.attempts, result: { ...fresh, artifacts: [...fresh.artifacts, { path: '' }] } }), error => error.code === 'VERIFICATION_EVIDENCE_REQUIRED');
  const restored = io.q2().restoreBlockedVerification('T1', { attempt: claimed.attempts, result: fresh });
  assert.equal(restored.status, 'verifying'); assert.deepEqual(restored.result, fresh);
  assert.equal(restored.attempts, 1); assert.equal(restored.retries, 0); assert.equal(restored.executor, 'w1');

  for (const historicalFailure of [{ notDispatched: false, unknownSideEffects: false }, { notDispatched: true, unknownSideEffects: true }, { notDispatched: true }]) {
    const badIo = fixture(t), badQueue = badIo.q(); badQueue.enqueue([{ id: 'T1', title: '真实历史失败', files: ['result.txt'], maxRetries: 0 }]);
    const execution = badQueue.claim('w1'), initial = blockedCheckReport(badIo.dir); delete initial.checks;
    badQueue.complete('T1', execution.leaseToken, initial);
    const failed = { ...initial, checks: [{ command: 'node --test test.mjs', ok: false, ...historicalFailure }] };
    badQueue.verify('T1', 'r1', { pass: false, issues: ['真实检查失败'], attempt: execution.attempts, result: failed });
    assert.deepEqual(badQueue.get('T1').result.checks, failed.checks, 'verify(false) 保留真实失败检查');
    const replacement = { ...initial, checks: blockedCheckReport(badIo.dir).checks };
    assert.throws(() => badQueue.restoreBlockedVerification('T1', { attempt: execution.attempts, result: replacement }), error => error.code === 'VERIFICATION_EVIDENCE_REQUIRED');
    assert.equal(badQueue.get('T1').status, 'blocked'); assert.deepEqual(badQueue.get('T1').result, failed);
  }
});

test('纯电脑任务没有文件产出仍可保留验收，未知电脑输入必须继续隔离', (t) => {
  const io = fixture(t), queue = io.q();
  queue.enqueue([{ id: 'D', title: '电脑动作', type: 'desktop', files: [] }]);
  const claimed = queue.claim('w1');
  const report = { taskId: 'D', executor: 'w1', summary: '动作完成', artifacts: [], desktopEvidence: { sideEffects: 'known' } };
  queue.complete('D', claimed.leaseToken, report);
  const held = queue.holdVerification('D', ['独立审核者暂时离线'], { attempt: claimed.attempts, result: report });
  assert.equal(held.status, 'verifying'); assert.equal(held.retries, 0);
  assert.throws(() => queue.holdVerification('D', ['未知动作'], { attempt: claimed.attempts, result: { ...report, desktopEvidence: { calls: [{ evidence: { sideEffects: 'unknown' } }] } } }), error => error.code === 'VERIFICATION_EVIDENCE_REQUIRED');
  assert.deepEqual(queue.get('D').result, report);
});

test('语义失败停止后显式继续仅恢复验收，保持实际产物、执行次数、重试及费用', t => {
  const io = fixture(t), queue = io.q();
  queue.enqueue([{ id: 'T1', title: '浏览器证据缺失', files: ['result.txt'], maxRetries: 0 }]);
  const claimed = queue.claim('w1'), file = path.join(io.dir, 'result.txt'); fs.writeFileSync(file, 'real result');
  const report = { taskId: 'T1', executor: 'w1', artifacts: [{ path: file }], checks: [], reviewer: 'r1', verdict: { pass: false, issues: ['缺渲染证据'] }, artifactHashes: [{ path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }] };
  queue.recordUsage('T1', claimed.leaseToken, { tokens: 81, verified: true }); queue.complete('T1', claimed.leaseToken, report);
  const blocked = queue.verify('T1', 'r1', { pass: false, issues: report.verdict.issues, result: report, attempt: 1 }); assert.equal(blocked.status, 'blocked');
  const restored = io.q2().restoreBlockedSemanticVerification('T1', { attempt: 1 });
  assert.equal(restored.status, 'verifying'); assert.equal(restored.executor, 'w1'); assert.equal(restored.attempts, blocked.attempts); assert.equal(restored.retries, blocked.retries); assert.equal(restored.tokensUsed, 81);
  assert.deepEqual(restored.result, report); assert.equal(queue.claim('w1'), null);
  assert.throws(() => queue.verify('T1', 'w1', { pass: true, attempt: 1 }), error => error.code === 'REVIEWER_IS_EXECUTOR');
  queue.verify('T1', 'r1', { pass: true, attempt: 1 }); assert.equal(queue.get('T1').status, 'passed');
});

test('语义恢复拒绝改变的文件、未知动作、失败或缺失代码检查、伪造审核身份及并发写者', t => {
  for (const kind of ['changed', 'unknown', 'failed-check', 'missing-check', 'missing-hash', 'reviewer', 'concurrent', 'stale']) {
    const io = fixture(t), queue = io.q();
    queue.enqueue([{ id: 'T1', title: kind, files: ['result.txt'], maxRetries: 0, checks: kind === 'missing-check' ? ['node --check result.txt'] : [] }]);
    const claimed = queue.claim('w1'), file = path.join(io.dir, 'result.txt'); fs.writeFileSync(file, 'real result');
    const report = { taskId: 'T1', executor: 'w1', artifacts: [{ path: file }], checks: [], reviewer: 'r1', verdict: { pass: false, issues: ['缺证据'] }, artifactHashes: [{ path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }] };
    if (kind === 'unknown') report.desktopEvidence = { sideEffects: 'unknown' };
    if (kind === 'failed-check') report.checks = [{ command: 'node --check result.txt', ok: false, notDispatched: false }];
    if (kind === 'missing-hash') delete report.artifactHashes;
    if (kind === 'reviewer') report.reviewer = 'w1';
    queue.complete('T1', claimed.leaseToken, report); queue.verify('T1', 'r1', { pass: false, issues: ['缺证据'], attempt: 1, result: report });
    if (kind === 'changed') fs.writeFileSync(file, 'external replacement');
    if (kind === 'concurrent') { const other = io.q({ runId: 'other' }); other.enqueue([{ id: 'other', title: '其他写者', files: ['result.txt'] }]); assert.ok(other.claim('w1')); }
    assert.throws(() => queue.restoreBlockedSemanticVerification('T1', { attempt: kind === 'stale' ? 0 : 1 }), undefined, kind);
    assert.equal(queue.get('T1').status, 'blocked', kind);
  }
});

test('语义恢复兼容相对路径及字符串产物，拒绝缺失重复额外哈希、真实路径越界与活PID', t => {
  for (const kind of ['relative-string', 'duplicates', 'extra', 'wrong-file', 'outside-link', 'alive-pid', 'unknown-pid']) {
    const io = fixture(t), queue = io.q({ isProcessAlive: kind === 'unknown-pid' ? () => undefined : undefined });
    queue.enqueue([{ id: 'T1', title: kind, files: ['result.txt'], maxRetries: 0 }]);
    const relative = kind === 'outside-link' ? 'link/result.txt' : 'result.txt';
    const claim = queue.claim('w1'), file = path.join(io.dir, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'actual artifact');
    const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const report = { taskId: 'T1', executor: 'w1', artifacts: [relative], checks: [], reviewer: 'r1', verdict: { pass: false, issues: ['补核验'] }, artifactHashes: [{ path: relative, sha256: digest }] };
    if (kind === 'duplicates') report.artifactHashes.push({ ...report.artifactHashes[0] });
    if (kind === 'extra') { fs.writeFileSync(path.join(io.dir, 'extra.txt'), 'actual artifact'); report.artifactHashes.push({ path: 'extra.txt', sha256: digest }); }
    if (kind === 'wrong-file') { fs.writeFileSync(path.join(io.dir, 'else.txt'), 'actual artifact'); report.artifactHashes[0].path = 'else.txt'; }
    queue.complete('T1', claim.leaseToken, report); queue.verify('T1', 'r1', { pass: false, issues: ['补核验'], result: report, attempt: 1 });
    if (kind === 'outside-link') {
      const outside = fs.mkdtempSync(path.join(path.dirname(io.dir), 'semantic-outside-'));
      fs.writeFileSync(path.join(outside, 'result.txt'), 'actual artifact');
      fs.renameSync(path.join(io.dir, 'link'), path.join(io.dir, 'preserved-link'));
      fs.symlinkSync(outside, path.join(io.dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (kind === 'alive-pid' || kind === 'unknown-pid') queue.db.prepare('UPDATE tq_tasks SET executor_pid=? WHERE scope=?').run(process.pid, queue.runId);
    if (kind === 'relative-string') {
      const restored = queue.restoreBlockedSemanticVerification('T1', { attempt: 1 }); assert.equal(restored.status, 'verifying');
    } else { assert.throws(() => queue.restoreBlockedSemanticVerification('T1', { attempt: 1 }), undefined, kind); assert.equal(queue.get('T1').status, 'blocked'); }
  }
});

const BUSY_NATIVE_ID = 'native-fixed-session';
const nativeBusyProof = { nativeId: BUSY_NATIVE_ID, rpcMethod: 'thread/resume', rpcCode: -32600, message: `thread ${BUSY_NATIVE_ID} already has an active writer`, turnStarted: false };

test('原生启动前busy只退回queued并固定原worker/native，审计保留且执行返工费用均不增加', t => {
  const io = fixture(t, { workers: ['w1', 'w2'] }), queue = io.q({ isProcessAlive: () => false });
  queue.enqueue([{ id: 'T1', title: '会话占用', files: ['result.txt'] }]);
  const claim = queue.claim('w1'); queue.heartbeat('T1', claim.leaseToken, { executorPid: 7654321 });
  const deferred = queue.deferNativeBusy('T1', claim.leaseToken, { notDispatched: true, nativeBusyEvidence: nativeBusyProof });
  assert.equal(deferred.status, 'queued'); assert.equal(deferred.attempts, 0); assert.equal(deferred.retries, 0); assert.equal(deferred.tokensUsed, 0);
  assert.equal(deferred.nativeBusyWorker, 'w1'); assert.equal(deferred.expectedNativeId, BUSY_NATIVE_ID);
  assert.equal(queue.claim('w2'), null);
  assert.ok(queue.get('T1', { withHistory: true }).history.some(entry => entry.outcome === 'not-dispatched' && entry.detail.source === 'native-rpc-rejection'));
  assert.throws(() => queue.deferNativeBusy('T1', claim.leaseToken, { notDispatched: true, nativeBusyEvidence: nativeBusyProof }), LeaseLostError);
  const next = queue.claim('w1'); assert.equal(next.attempts, 1);
  queue.complete('T1', next.leaseToken, {}); assert.equal(queue.get('T1').nativeBusyWorker, null); assert.equal(queue.get('T1').expectedNativeId, null);
});

test('原生busy退回拒绝错token、无RPC证明、活或未知PID以及当前检查点或动作证据', t => {
  for (const kind of ['token', 'untrusted', 'missing-proof', 'wrong-code', 'turn-start', 'turn-started', 'native-mismatch', 'alive', 'unknown', 'no-pid', 'checkpoint', 'effects', 'known-effect', 'scope', 'completed']) {
    const io = fixture(t), queue = io.q({ isProcessAlive: kind === 'alive' ? () => true : kind === 'unknown' ? () => undefined : () => false });
    queue.enqueue([{ id: 'T1', title: kind, files: ['result.txt'] }]);
    const claim = queue.claim('w1');
    if (kind !== 'no-pid') queue.heartbeat('T1', claim.leaseToken, { executorPid: 7654321 });
    if (kind === 'checkpoint') queue.checkpoint('T1', claim.leaseToken, { summary: '已有动作', filesDone: ['result.txt'] });
    if (kind === 'effects') queue.db.prepare("UPDATE tq_tasks SET side_effects='unknown' WHERE scope=?").run(queue.runId);
    if (kind === 'known-effect') queue.db.prepare("UPDATE tq_tasks SET side_effects='changed' WHERE scope=?").run(queue.runId);
    if (kind === 'scope') queue.recordScopeEvidence('T1', claim.leaseToken, { files: ['result.txt'], attributed: true });
    if (kind === 'completed') queue.complete('T1', claim.leaseToken, {});
    const proof = { ...nativeBusyProof };
    if (kind === 'wrong-code') proof.rpcCode = -1;
    if (kind === 'turn-start') proof.rpcMethod = 'turn/start';
    if (kind === 'turn-started') proof.turnStarted = true;
    if (kind === 'native-mismatch') proof.nativeId = 'other-id';
    assert.throws(() => queue.deferNativeBusy('T1', kind === 'token' ? 'wrong' : claim.leaseToken, { notDispatched: kind !== 'untrusted', nativeBusyEvidence: kind === 'missing-proof' ? undefined : proof }), undefined, kind);
    assert.equal(queue.get('T1').attempts, 1); assert.equal(queue.get('T1').retries, 0);
  }
});

function legacyNativeBusyFixture(t, count = 3) {
  const io = fixture(t, { workers: ['codex'] });
  const run = io.store.createRun({ kind: 'parallel', goal: '同会话继续', cwd: io.dir });
  // Queue scope must match the real runs/steps controller records.
  const scoped = io.q({ runId: run.id, workers: ['codex'], isProcessAlive: () => false });
  scoped.enqueue([{ id: 'T1', title: '旧原生busy', files: ['result.txt'] }]);
  const trustedLogRoot = path.join(io.dir, 'controller-logs'); fs.mkdirSync(trustedLogRoot);
  const proofs = [];
  for (let number = 1; number <= count; number++) {
    const claim = scoped.claim('codex'); scoped.heartbeat('T1', claim.leaseToken, { executorPid: 7654321 });
    io.advance(1);
    const stepId = io.store.addStep({ run_id: run.id, role: 'execute', seat: 'codex', agent: 'codex', round: number });
    io.store.updateStep(stepId, { state: 'failed', error: nativeBusyProof.message, started_at: new Date(io.clock.t).toISOString(), ended_at: new Date(io.clock.t).toISOString() });
    const messages = [
      { id: 1, result: { userAgent: 'beat/0.162.0 dumb (beat; 2.2.17)' } },
      { method: 'remoteControl/status/changed', params: { status: 'disabled' } },
      { id: 2, error: { code: -32600, message: nativeBusyProof.message } },
    ];
    const text = [...messages, ...messages].map(message => JSON.stringify(message)).join('\n') + '\n';
    const logFile = path.join(trustedLogRoot, `${run.id}-${stepId}.jsonl`); fs.writeFileSync(logFile, text);
    proofs.push({ attempt: number, stepId, logFile, sha256: createHash('sha256').update(text).digest('hex') });
    io.advance(1); scoped.fail('T1', claim.leaseToken, [nativeBusyProof.message]);
  }
  return { ...io, queue: scoped, run, proofs, trustedLogRoot, nativeId: BUSY_NATIVE_ID };
}

test('旧纯原生busy依据实际步骤与逐段RPC日志恢复，纠正未启动计数但费用和全部失败历史保留', t => {
  const s = legacyNativeBusyFixture(t), before = s.queue.get('T1', { withHistory: true });
  assert.equal(before.status, 'blocked'); assert.equal(before.attempts, 3); assert.equal(before.retries, 2);
  const restored = s.queue.restoreBlockedNativeBusy('T1', { attempt: 3, nativeId: s.nativeId, proofs: s.proofs, trustedLogRoot: s.trustedLogRoot });
  assert.equal(restored.status, 'queued'); assert.equal(restored.attempts, 0); assert.equal(restored.retries, 0); assert.equal(restored.escalated, false);
  assert.equal(restored.tokensUsed, before.tokensUsed); assert.deepEqual(restored.usage, before.usage);
  assert.equal(restored.nativeBusyWorker, 'codex'); assert.equal(restored.expectedNativeId, BUSY_NATIVE_ID);
  const history = s.queue.get('T1', { withHistory: true }).history;
  assert.equal(history.filter(entry => entry.outcome === 'failed').length, 3);
  assert.deepEqual(history.find(entry => entry.outcome === 'native-busy-restored').detail.previous, { attempts: 3, retries: 2, escalated: false });
  assert.equal(s.queue.claim('other-worker'), null); assert.equal(s.queue.claim('codex').attempts, 1);
});

test('旧busy恢复拒绝模型自称、日志缺段/变化/工具动作、不同步骤身份、真实失败及未知副作用', t => {
  for (const kind of ['no-proofs', 'digest', 'outside', 'step', 'timing', 'native-id', 'issue', 'completed', 'effects', 'known-effect', 'checkpoint', 'alive', 'turn', 'notification', 'truncated']) {
    const s = legacyNativeBusyFixture(t);
    const options = { attempt: 3, nativeId: s.nativeId, proofs: s.proofs, trustedLogRoot: s.trustedLogRoot };
    if (kind === 'no-proofs') options.proofs = [];
    if (kind === 'digest') s.proofs[0].sha256 = 'a'.repeat(64);
    if (kind === 'outside') options.trustedLogRoot = path.join(s.dir, 'workspaces', 'shared');
    if (kind === 'step') s.store.updateStep(s.proofs[0].stepId, { role: 'evaluate' });
    if (kind === 'timing') s.store.updateStep(s.proofs[0].stepId, { started_at: new Date(s.clock.t + 1).toISOString() });
    if (kind === 'native-id') options.nativeId = 'new-empty-session';
    if (kind === 'issue') s.queue.db.prepare("UPDATE tq_attempts SET issues=? WHERE scope=? AND outcome='failed' AND attempt=1").run(JSON.stringify(['test execution failed']), s.run.id);
    if (kind === 'completed') s.queue.db.prepare("UPDATE tq_attempts SET outcome='completed' WHERE scope=? AND outcome='failed' AND attempt=1").run(s.run.id);
    if (kind === 'effects') s.queue.db.prepare("UPDATE tq_tasks SET side_effects='unknown' WHERE scope=?").run(s.run.id);
    if (kind === 'known-effect') s.queue.db.prepare("UPDATE tq_tasks SET side_effects='changed' WHERE scope=?").run(s.run.id);
    if (kind === 'checkpoint') s.queue.db.prepare('UPDATE tq_tasks SET last_checkpoint=? WHERE scope=?').run(JSON.stringify({ summary: 'already did work' }), s.run.id);
    if (kind === 'alive') s.queue.isProcessAlive = () => true;
    if (kind === 'turn' || kind === 'notification' || kind === 'truncated') {
      let text = fs.readFileSync(s.proofs[0].logFile, 'utf8');
      if (kind === 'turn') text += JSON.stringify({ id: 3, result: { turn: { id: 'started' } } }) + '\n';
      if (kind === 'notification') text += JSON.stringify({ method: 'item/started', params: {} }) + '\n';
      if (kind === 'truncated') text += JSON.stringify({ id: 1, result: { userAgent: 'beat/0.162.0 dumb (beat; 2.2.17)' } }) + '\n';
      fs.writeFileSync(s.proofs[0].logFile, text); s.proofs[0].sha256 = createHash('sha256').update(text).digest('hex');
    }
    assert.throws(() => s.queue.restoreBlockedNativeBusy('T1', options), undefined, kind);
    assert.equal(s.queue.get('T1').status, 'blocked', kind); assert.equal(s.queue.get('T1').attempts, 3, kind); assert.equal(s.queue.get('T1').retries, 2, kind);
  }
});

// ───────────── 2026-10-24 代码审查回归：claim 名单 / cancel TOCTOU / 孤儿回收 ─────────────

test('claim 必须尊重 runner 传入的 taskIds 名单：名单外任务即使 escalated 排在前面也不能领走', t => {
  // 审查发现：queue-runner 精心过滤的 taskIds 被 claim 静默忽略（签名里没有这个参数），
  // 已升级任务按 ORDER BY escalated DESC 排在最前，会绕过“原生会话忙 60 秒退避”等
  // 上游过滤被抢走，同 worker 的其他就绪任务被饿住。
  const s = fixture(t);
  s.q().enqueue([
    { id: 'backoff', title: '会话忙退避中', files: ['a.txt'] },
    { id: 'ready', title: '可立即执行', files: ['b.txt'] },
    { id: 'other', title: '另一个就绪任务', files: ['c.txt'] },
  ]);
  s.store.db.prepare('UPDATE tq_tasks SET escalated=1 WHERE id=?').run('backoff');
  // 核心：升级任务按 ORDER BY escalated DESC 排在最前，但名单只放行 ready 时绝不能领走 backoff
  const claimed = s.q().claim('w1', { taskIds: ['ready'] });
  assert.ok(claimed, '名单内的任务应能领取');
  assert.equal(claimed.id, 'ready');
  assert.equal(s.q().claim('w2', { taskIds: [] }), null, '空名单不能领取任何任务');
  assert.equal(s.q().claim('w2', { taskIds: ['nonexistent'] }), null, '名单外的任务不能领取');
  assert.equal(s.q().claim('w3', { taskIds: ['other'] }).id, 'other', '名单内的其他任务可领');
  assert.equal(s.q().claim('w4', { taskIds: ['backoff'] }).id, 'backoff', '明确点名时升级任务可领');
  // 不传名单保持原排序行为：升级任务优先
  const s2 = fixture(t);
  s2.q().enqueue([{ id: 'first', title: '升级任务', files: ['a.txt'] }, { id: 'second', title: '普通任务', files: ['b.txt'] }]);
  s2.store.db.prepare('UPDATE tq_tasks SET escalated=1 WHERE id=?').run('first');
  assert.equal(s2.q().claim('w1').id, 'first', '不传名单保持原排序行为（escalated 优先）');
});

test('cancel 在事务内重读状态：SELECT 之后已被另一连接隔离的任务，不能被旧快照覆盖成取消', t => {
  // 审查发现：cancel 先在事务外 SELECT 待取消行，事务内用陈旧 status 判定且 UPDATE 无状态前置条件。
  // 另一连接在 SELECT 与 BEGIN IMMEDIATE 之间把任务置为 passed/blocked 时，结果会被覆盖。
  const s = fixture(t);
  const q = s.q();
  q.enqueue([{ id: 't1', title: '任务', files: ['a.txt'] }]);
  const claim = q.claim('w1');
  const q2 = s.q2();
  const originalTx = q.tx.bind(q);
  let raced = false;
  q.tx = (fn) => {
    // 模拟竞态：cancel() 的 SELECT 已完成（看到 running），事务真正开始前，
    // 另一个连接先提交了 unknownSideEffects 隔离。
    if (!raced) { raced = true; q2.fail('t1', claim.leaseToken, ['未知副作用'], { unknownSideEffects: true }); }
    return originalTx(fn);
  };
  const cancelled = q.cancel();
  assert.deepEqual(cancelled, [], '重读后发现已隔离，不能取消');
  const raw = s.store.db.prepare('SELECT status, cancelled, quarantine_reason FROM tq_tasks WHERE id=?').get('t1');
  assert.equal(raw.status, 'blocked');
  assert.equal(raw.quarantine_reason, 'unconfirmed-exit+unknown-side-effects', '隔离原因不能被 cancelled: 覆盖');
  assert.equal(raw.cancelled, 0, 'cancelled 标记不能落在被隔离的任务上');
  assert.equal(q.events({ taskId: 't1' }).some(e => e.type === 'cancelled'), false, '不应留下取消事件');
});

test('cancel 正常路径不受影响：queued/running 任务仍可取消且证据保留', t => {
  const s = fixture(t);
  const q = s.q();
  q.enqueue([{ id: 't1', title: '排队中', files: ['a.txt'] }, { id: 't2', title: '执行中', files: ['b.txt'] }]);
  q.claim('w1', { taskIds: ['t2'] });
  const cancelled = q.cancel({ reason: 'customer-requested' });
  assert.deepEqual(cancelled.map(c => c.id).sort(), ['t1', 't2']);
  const raw = s.store.db.prepare('SELECT id, status, cancelled, quarantine_reason FROM tq_tasks WHERE id IN (?,?) ORDER BY id').all('t1', 't2');
  for (const row of raw) { assert.equal(row.status, 'blocked'); assert.equal(row.cancelled, 1); assert.match(row.quarantine_reason, /cancelled:customer-requested/); }
});

test('reclaimOrphans 只收摊本进程仍停在 running 的孤儿：跨进程租约不碰，收摊后可人工放行', t => {
  // 审查发现：执行循环异常退出后，running 行的 lease_pid 是控制器自身（恒活），
  // recover() 的死分支永远走不到，文件锁被永久占用且常规恢复路径够不着。
  const s = fixture(t);
  const q = s.q();
  q.enqueue([
    { id: 'orphan', title: '本进程孤儿', files: ['a.txt'] },
    { id: 'foreign', title: '另一进程持有', files: ['b.txt'] },
  ]);
  const c1 = q.claim('w1', { taskIds: ['orphan'] });
  const c2 = q.claim('w2', { pid: 999999, taskIds: ['foreign'] });
  assert.ok(c1 && c2, '两个任务都应被领取');
  assert.throws(() => q.reclaimOrphans({ reason: '循环还在跑' }), /只能在执行循环退出后调用/, '循环未退出时必须拒绝调用，防止误收摊合法执行中的任务');
  const reclaimed = q.reclaimOrphans({ reason: '执行循环已退出（测试注入）', loopExited: true });
  assert.deepEqual(reclaimed.map(r => r.id), ['orphan'], '只回收本进程名下的孤儿');
  const raw = s.store.db.prepare('SELECT id, status, quarantine_reason, lease_token, lease_pid FROM tq_tasks ORDER BY id').all();
  const orphan = raw.find(r => r.id === 'orphan');
  assert.equal(orphan.status, 'blocked');
  assert.equal(orphan.quarantine_reason, 'orphan-loop-exited');
  assert.equal(orphan.lease_token, null, '孤儿租约必须释放，否则文件锁一直被占');
  const foreign = raw.find(r => r.id === 'foreign');
  assert.equal(foreign.status, 'running', '另一进程的租约绝不能越界回收');
  assert.equal(foreign.lease_token, c2.leaseToken);
  // 失败有出口：人工放行后重新可领取
  q.release('orphan', { worker: 'customer', note: '确认已知改动' });
  assert.equal(q.get('orphan').status, 'queued');
  assert.equal(q.get('orphan').quarantineReason ?? null, null);
});

