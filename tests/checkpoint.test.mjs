import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beginRunCheckpoint, finishRunCheckpoint, rollbackRunCheckpoint, readCheckpoint, checkpointSummary } from '../src/checkpoint.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';
import { allFileMentions } from '../src/quick-work.mjs';

function fixture(t) {
  const root = cleanup(t, tempDir('checkpoint'));
  const cwd = path.join(root, 'work'), outside = path.join(root, 'desk');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  const config = { root, dataDir: path.join(root, 'data'), workspace: cwd, allowedRoots: [root] };
  const target = path.join(cwd, 'a.txt'), keep = path.join(cwd, 'b.txt'), outsideFile = path.join(outside, 'c.txt');
  fs.writeFileSync(target, 'one\ntwo\n'); fs.writeFileSync(keep, 'keep'); fs.writeFileSync(outsideFile, 'before');
  return { root, cwd, outside, config, target, keep, outsideFile };
}

test('检查点：执行后列出新增/修改/删除；有备份的可撤销，没备份的如实说不能撤销', t => {
  const f = fixture(t);
  const newFile = path.join(f.cwd, 'new.txt');
  beginRunCheckpoint({ config: f.config, runId: 'R1', cwd: f.cwd, files: [f.target, newFile, f.outsideFile] });
  fs.writeFileSync(f.target, 'one\nTWO\n'); fs.writeFileSync(newFile, 'new'); fs.unlinkSync(f.keep); fs.writeFileSync(f.outsideFile, 'after');
  const meta = finishRunCheckpoint({ config: f.config, runId: 'R1', cwd: f.cwd, extraFiles: [newFile] });
  assert.equal(meta.status, 'ready');
  const by = Object.fromEntries(meta.changes.map(c => [path.basename(c.path), c]));
  assert.equal(by['new.txt'].kind, 'added'); assert.equal(by['new.txt'].restorable, true);
  assert.equal(by['a.txt'].kind, 'modified'); assert.equal(by['a.txt'].restorable, true);
  assert.match(by['a.txt'].diff, /\+TWO/); assert.match(by['a.txt'].diff, /-two/);
  assert.equal(by['c.txt'].kind, 'modified'); assert.equal(by['c.txt'].restorable, true);
  assert.equal(by['b.txt'].kind, 'deleted'); assert.equal(by['b.txt'].restorable, false);
  const summary = checkpointSummary(meta);
  assert.equal(summary.total, 4); assert.equal(summary.changes.length, 4);
});

test('撤销：恢复修改/删除有备份的文件、删除新增文件；任务后又被改过的文件不覆盖', t => {
  const f = fixture(t);
  beginRunCheckpoint({ config: f.config, runId: 'R2', cwd: f.cwd, files: [f.target] });
  fs.writeFileSync(f.target, 'changed'); fs.writeFileSync(path.join(f.cwd, 'new.txt'), 'new');
  finishRunCheckpoint({ config: f.config, runId: 'R2', cwd: f.cwd });
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'changed');
  const dry = rollbackRunCheckpoint({ config: f.config, runId: 'R2', dryRun: true });
  assert.equal(dry.restored.length, 2); assert.equal(fs.readFileSync(f.target, 'utf8'), 'changed', 'dryRun 不写');
  const done = rollbackRunCheckpoint({ config: f.config, runId: 'R2' });
  assert.equal(done.restored.length, 2);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'one\ntwo\n');
  assert.equal(fs.existsSync(path.join(f.cwd, 'new.txt')), false);
  assert.equal(readCheckpoint(f.config, 'R2').status, 'rolled-back');

  const g = fixture(t);
  beginRunCheckpoint({ config: g.config, runId: 'R3', cwd: g.cwd, files: [g.target] });
  fs.writeFileSync(g.target, 'first change');
  finishRunCheckpoint({ config: g.config, runId: 'R3', cwd: g.cwd });
  fs.writeFileSync(g.target, 'user edited after task');
  const refused = rollbackRunCheckpoint({ config: g.config, runId: 'R3' });
  assert.equal(refused.restored.length, 0); assert.equal(refused.skipped.length, 1);
  assert.match(refused.skipped[0].reason, /又被改过/);
  assert.equal(fs.readFileSync(g.target, 'utf8'), 'user edited after task');
});

test('没有检查点的任务不能撤销；检查点只接受授权目录内的文件', t => {
  const f = fixture(t);
  assert.throws(() => rollbackRunCheckpoint({ config: f.config, runId: 'R404' }), /没有可撤销/);
  const outsideRoot = cleanup(t, tempDir('checkpoint-outside'));
  const outside = path.join(outsideRoot, 'x.txt'); fs.writeFileSync(outside, 'x');
  beginRunCheckpoint({ config: f.config, runId: 'R5', cwd: f.cwd, files: [outside] });
  const meta = readCheckpoint(f.config, 'R5');
  assert.equal(meta.files.length, 0, '授权目录外的文件不能进入检查点');
});

test('内部 .beat-control 文件不进入客户可撤销列表', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.cwd, '.beat-control', 'R9'), { recursive: true });
  const internal = path.join(f.cwd, '.beat-control', 'R9', 'report.json');
  fs.writeFileSync(internal, '{"x":1}');
  beginRunCheckpoint({ config: f.config, runId: 'R9', cwd: f.cwd, files: [] });
  fs.writeFileSync(internal, '{"x":2}');
  fs.writeFileSync(path.join(f.cwd, 'visible.txt'), 'v');
  const meta = finishRunCheckpoint({ config: f.config, runId: 'R9', cwd: f.cwd });
  assert.equal(meta.changes.some(change => change.path.includes('.beat-control')), false, '内部记录文件不能出现在撤销列表');
  assert.equal(meta.changes.some(change => change.path.endsWith('visible.txt')), true);
});

test('桌面/文档等 cwd 外的目标文件也能撤销', t => {
  const f = fixture(t);
  beginRunCheckpoint({ config: f.config, runId: 'R10', cwd: f.cwd, files: [f.outsideFile] });
  fs.writeFileSync(f.outsideFile, 'changed outside');
  finishRunCheckpoint({ config: f.config, runId: 'R10', cwd: f.cwd });
  const done = rollbackRunCheckpoint({ config: f.config, runId: 'R10' });
  assert.equal(done.restored.length, 1);
  assert.equal(fs.readFileSync(f.outsideFile, 'utf8'), 'before');
});

test('任务还在执行时不能撤销；已经撤销过的任务重复点不会重复写', t => {
  const f = fixture(t);
  beginRunCheckpoint({ config: f.config, runId: 'R11', cwd: f.cwd, files: [f.target] });
  assert.throws(() => rollbackRunCheckpoint({ config: f.config, runId: 'R11' }), /还在进行/);
  fs.writeFileSync(f.target, 'changed');
  finishRunCheckpoint({ config: f.config, runId: 'R11', cwd: f.cwd });
  rollbackRunCheckpoint({ config: f.config, runId: 'R11' });
  const again = rollbackRunCheckpoint({ config: f.config, runId: 'R11' });
  assert.equal(again.alreadyRolledBack, true);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'one\ntwo\n');
});

test('检查点摘要过滤内部文件，老记录也不会把 .beat-control 显示给客户', () => {
  const summary = checkpointSummary({ changes: [
    { path: 'E:\\work\\.beat-control\\R1\\report.json', kind: 'added' },
    { path: 'E:\\work\\a.txt', kind: 'modified' },
  ] });
  assert.equal(summary.total, 1);
  assert.equal(summary.changes[0].path, 'E:\\work\\a.txt');
});

test('超过备份上限的大文件不假装可撤销，如实告诉客户没有备份', t => {
  const f = fixture(t);
  const big = path.join(f.cwd, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 1));
  beginRunCheckpoint({ config: f.config, runId: 'R12', cwd: f.cwd, files: [big] });
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 2));
  const meta = finishRunCheckpoint({ config: f.config, runId: 'R12', cwd: f.cwd });
  const row = meta.changes.find(x => x.path.endsWith('big.bin'));
  assert.equal(row.restorable, false);
  assert.match(row.reason, /file-too-large/);
  const done = rollbackRunCheckpoint({ config: f.config, runId: 'R12' });
  assert.equal(done.restored.some(x => x.path.endsWith('big.bin')), false);
});

test('超大/损坏的检查点 meta 直接视为过期，不拖垮服务', t => {
  const f = fixture(t);
  const dir = path.join(f.config.dataDir, 'checkpoints', 'R13');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), Buffer.alloc(17 * 1024 * 1024, 1));
  assert.equal(readCheckpoint(f.config, 'R13'), null);
});

test('撤销时不跟随符号链接，不覆盖链接目标', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.txt'); fs.writeFileSync(outside, 'outside-safe');
  beginRunCheckpoint({ config: f.config, runId: 'R14', cwd: f.cwd, files: [f.target] });
  fs.writeFileSync(f.target, 'changed');
  finishRunCheckpoint({ config: f.config, runId: 'R14', cwd: f.cwd });
  fs.unlinkSync(f.target);
  try { fs.symlinkSync(outside, f.target, 'file'); } catch { return; }
  const done = rollbackRunCheckpoint({ config: f.config, runId: 'R14' });
  assert.equal(done.restored.length, 0);
  assert.ok(done.skipped.some(row => /不是普通文件/.test(row.reason)));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-safe');
});

test('同一任务重试时沿用最初的执行前快照，第二轮改动仍可撤回第一次执行前', t => {
  const f = fixture(t);
  beginRunCheckpoint({ config: f.config, runId: 'R15', cwd: f.cwd, files: [f.target] });
  fs.writeFileSync(f.target, 'first attempt');
  finishRunCheckpoint({ config: f.config, runId: 'R15', cwd: f.cwd });
  beginRunCheckpoint({ config: f.config, runId: 'R15', cwd: f.cwd, files: [f.target] });
  fs.writeFileSync(f.target, 'second attempt');
  const meta = finishRunCheckpoint({ config: f.config, runId: 'R15', cwd: f.cwd });
  const row = meta.changes.find(x => x.path === f.target);
  assert.equal(row.kind, 'modified');
  assert.match(row.diff, /-one/);
  assert.match(row.diff, /\+second attempt/);
  rollbackRunCheckpoint({ config: f.config, runId: 'R15' });
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'one\ntwo\n', '第二轮撤销仍回到第一次执行前');
});

test('只核验已有成果的续跑不覆盖原检查点', t => {
  const f = fixture(t);
  beginRunCheckpoint({ config: f.config, runId: 'R16', cwd: f.cwd, files: [f.target] });
  fs.writeFileSync(f.target, 'changed');
  finishRunCheckpoint({ config: f.config, runId: 'R16', cwd: f.cwd });
  const kept = beginRunCheckpoint({ config: f.config, runId: 'R16', cwd: f.cwd, files: [f.target], keepExisting: true });
  assert.equal(kept.status, 'ready');
  assert.equal(kept.changes.length, 1);
});

test('目录快照被截断时，不把窗口外没动过的文件当新增删掉', t => {
  const f = fixture(t);
  for (let i = 0; i < 3005; i++) fs.writeFileSync(path.join(f.cwd, 'b' + String(i).padStart(4, '0') + '.txt'), 'x');
  beginRunCheckpoint({ config: f.config, runId: 'R17', cwd: f.cwd, files: [f.target] });
  for (let i = 0; i < 10; i++) fs.unlinkSync(path.join(f.cwd, 'b' + String(i).padStart(4, '0') + '.txt'));
  const late = path.join(f.cwd, 'b3004.txt');
  const meta = finishRunCheckpoint({ config: f.config, runId: 'R17', cwd: f.cwd });
  const lateChange = (meta.changes || []).find(row => row.path === late);
  assert.ok(!lateChange || lateChange.restorable === false, '窗口外的文件不能被当成可删除的新增');
  rollbackRunCheckpoint({ config: f.config, runId: 'R17' });
  assert.equal(fs.existsSync(late), true, '没动过的窗口外文件必须保留');
});

test('cwd 外的原有文件被覆盖时，撤销是恢复而不是删除', t => {
  const f = fixture(t);
  const desk = path.join(f.root, 'desk'); fs.mkdirSync(desk, { recursive: true });
  const report = path.join(desk, 'report.md'); fs.writeFileSync(report, '原内容');
  beginRunCheckpoint({ config: f.config, runId: 'R18', cwd: f.cwd, files: [report] });
  fs.writeFileSync(report, '新内容');
  const meta = finishRunCheckpoint({ config: f.config, runId: 'R18', cwd: f.cwd, extraFiles: [report] });
  const row = meta.changes.find(item => item.path === report);
  assert.equal(row.kind, 'modified');
  rollbackRunCheckpoint({ config: f.config, runId: 'R18' });
  assert.equal(fs.readFileSync(report, 'utf8'), '原内容');
});

test('没有执行前记录的 cwd 外新文件只展示，不提供删除', t => {
  const f = fixture(t);
  const desk = path.join(f.root, 'desk2'); fs.mkdirSync(desk, { recursive: true });
  const created = path.join(desk, 'created.md'); fs.writeFileSync(created, 'new');
  beginRunCheckpoint({ config: f.config, runId: 'R19', cwd: f.cwd, files: [] });
  const meta = finishRunCheckpoint({ config: f.config, runId: 'R19', cwd: f.cwd, extraFiles: [created] });
  const row = meta.changes.find(item => item.path === created);
  assert.equal(row.restorable, false);
  const done = rollbackRunCheckpoint({ config: f.config, runId: 'R19' });
  assert.equal(done.restored.some(item => item.path === created), false);
  assert.equal(fs.existsSync(created), true);
});

test('部分撤销保留已撤销路径，摘要二次汇总不丢进度，剩余文件还能再撤', t => {
  const f = fixture(t);
  const a = path.join(f.cwd, 'a.txt'), b = path.join(f.cwd, 'b.txt');
  fs.writeFileSync(a, 'a-old'); fs.writeFileSync(b, 'b-old');
  beginRunCheckpoint({ config: f.config, runId: 'R20', cwd: f.cwd, files: [a, b] });
  fs.writeFileSync(a, 'a-new'); fs.writeFileSync(b, 'b-new');
  const meta = finishRunCheckpoint({ config: f.config, runId: 'R20', cwd: f.cwd });
  const aAfter = meta.changes.find(row => row.path === a).afterSha256;
  fs.writeFileSync(a, 'externally changed');
  const first = rollbackRunCheckpoint({ config: f.config, runId: 'R20' });
  assert.equal(first.restored.some(row => row.path === b), true);
  assert.equal(first.skipped.some(row => row.path === a), true);
  const partial = readCheckpoint(f.config, 'R20');
  assert.equal(partial.status, 'partial');
  const summary = checkpointSummary(partial);
  const again = checkpointSummary(summary);
  assert.equal(again.partial, true);
  assert.ok(again.rolledBackPaths.includes(b), '二次汇总不能丢掉已撤销路径');
  assert.equal(again.total, 2);
  // 客户把 a 自己改回任务结束时的内容，再点一次，只撤剩下的 a
  fs.writeFileSync(a, 'a-new');
  const second = rollbackRunCheckpoint({ config: f.config, runId: 'R20', paths: [a] });
  assert.equal(second.restored.some(row => row.path === a), true);
  assert.equal(fs.readFileSync(a, 'utf8'), 'a-old');
});

test('大量改动时 meta 不会超过自己的读取上限', t => {
  const f = fixture(t);
  const dir = path.join(f.cwd, 'many'); fs.mkdirSync(dir);
  for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(dir, 'f' + String(i).padStart(3, '0') + '.txt'), 'line\n'.repeat(200));
  beginRunCheckpoint({ config: f.config, runId: 'R21', cwd: f.cwd, files: [] });
  for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(dir, 'f' + String(i).padStart(3, '0') + '.txt'), 'changed\n'.repeat(200));
  finishRunCheckpoint({ config: f.config, runId: 'R21', cwd: f.cwd });
  const file = path.join(f.config.dataDir, 'checkpoints', 'R21', 'meta.json');
  assert.ok(fs.statSync(file).size < 16 * 1024 * 1024, 'meta 必须可读');
  assert.ok(readCheckpoint(f.config, 'R21'));
});

test('父目录 junction 指向工作区外时，不把外部文件当候选备份', t => {
  const f = fixture(t);
  const outside = path.join(path.dirname(f.root), 'outside-junction-' + path.basename(f.root)); fs.mkdirSync(outside, { recursive: true }); t.after(() => { try { fs.rmSync(outside, { recursive: true, force: true }); } catch {} });
  const secret = path.join(outside, 'secret.txt'); fs.writeFileSync(secret, 'secret');
  const link = path.join(f.cwd, 'link');
  try { fs.symlinkSync(outside, link, 'junction'); } catch { return; }
  const meta = beginRunCheckpoint({ config: f.config, runId: 'R22', cwd: f.cwd, files: [path.join(link, 'secret.txt')] });
  assert.equal(meta.files.some(row => row.path.toLowerCase().includes('secret.txt')), false, '外部文件不能进候选备份');
});

test('执行前目录不存在/不可读时，不把后来创建的文件当成可删除新增', t => {
  const f = fixture(t);
  const missing = path.join(f.root, 'not-yet');
  beginRunCheckpoint({ config: f.config, runId: 'R23', cwd: missing, files: [] });
  fs.mkdirSync(missing, { recursive: true }); fs.writeFileSync(path.join(missing, 'new.txt'), 'new');
  const meta = finishRunCheckpoint({ config: f.config, runId: 'R23', cwd: missing });
  assert.equal(meta.beforeComplete, false);
  assert.equal((meta.changes || []).some(row => row.path.endsWith('new.txt') && row.restorable), false);
  rollbackRunCheckpoint({ config: f.config, runId: 'R23' });
  assert.equal(fs.existsSync(path.join(missing, 'new.txt')), true);
});

test('超大当前文件不整块读入，也不提供不安全撤销', t => {
  const f = fixture(t);
  const big = path.join(f.cwd, 'big-current.bin'); fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024, 1));
  beginRunCheckpoint({ config: f.config, runId: 'R24', cwd: f.cwd, files: [big] });
  fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024, 2));
  const meta = finishRunCheckpoint({ config: f.config, runId: 'R24', cwd: f.cwd });
  const row = (meta.changes || []).find(item => item.path === big);
  if (row) assert.equal(row.restorable, false);
  const done = rollbackRunCheckpoint({ config: f.config, runId: 'R24' });
  assert.equal(done.restored.some(item => item.path === big), false);
});

test('只撤销一个文件不会把整个检查点标成已撤销，剩余文件还能撤', t => {
  const f = fixture(t);
  const a = path.join(f.cwd, 'a.txt'), b = path.join(f.cwd, 'b.txt');
  fs.writeFileSync(a, 'a-old'); fs.writeFileSync(b, 'b-old');
  beginRunCheckpoint({ config: f.config, runId: 'R25', cwd: f.cwd, files: [a, b] });
  fs.writeFileSync(a, 'a-new'); fs.writeFileSync(b, 'b-new');
  finishRunCheckpoint({ config: f.config, runId: 'R25', cwd: f.cwd });
  const first = rollbackRunCheckpoint({ config: f.config, runId: 'R25', paths: [a] });
  assert.equal(first.restored.some(row => row.path === a), true);
  const mid = readCheckpoint(f.config, 'R25');
  assert.equal(mid.status, 'partial');
  assert.equal(fs.readFileSync(b, 'utf8'), 'b-new');
  const second = rollbackRunCheckpoint({ config: f.config, runId: 'R25', paths: [b] });
  assert.equal(second.restored.some(row => row.path === b), true);
  assert.equal(fs.readFileSync(a, 'utf8'), 'a-old');
  assert.equal(fs.readFileSync(b, 'utf8'), 'b-old');
  assert.equal(readCheckpoint(f.config, 'R25').status, 'rolled-back');
});

test('执行前子目录扫描报错时，不把可读后出现的旧文件当成新增删除', t => {
  const f = fixture(t);
  const locked = path.join(f.cwd, 'locked'); fs.mkdirSync(locked, { recursive: true });
  const secret = path.join(locked, 'secret.txt'); fs.writeFileSync(secret, 'secret');
  const original = fs.readdirSync;
  try {
    fs.readdirSync = function (dir, ...args) { if (String(dir).endsWith('locked')) throw new Error('EPERM'); return original.call(fs, dir, ...args); };
    const meta = beginRunCheckpoint({ config: f.config, runId: 'R26', cwd: f.cwd, files: [] });
    assert.equal(meta.beforeComplete, false);
  } finally { fs.readdirSync = original; }
  const finished = finishRunCheckpoint({ config: f.config, runId: 'R26', cwd: f.cwd });
  assert.equal((finished.changes || []).some(row => row.path.endsWith('secret.txt') && row.restorable), false);
  rollbackRunCheckpoint({ config: f.config, runId: 'R26' });
  assert.equal(fs.existsSync(secret), true);
});

test('目录快照截断不妨碍客户点名的新文件撤销', t => {
  const f = fixture(t);
  for (let i = 0; i < 3005; i++) fs.writeFileSync(path.join(f.cwd, 'b' + String(i).padStart(4, '0') + '.txt'), 'x');
  const created = path.join(f.cwd, 'new-pointed.txt');
  beginRunCheckpoint({ config: f.config, runId: 'R27', cwd: f.cwd, files: [created] });
  fs.writeFileSync(created, 'new');
  const meta = finishRunCheckpoint({ config: f.config, runId: 'R27', cwd: f.cwd });
  const row = (meta.changes || []).find(item => item.path === created);
  assert.equal(row?.restorable, true);
  rollbackRunCheckpoint({ config: f.config, runId: 'R27' });
  assert.equal(fs.existsSync(created), false);
  assert.equal(fs.existsSync(path.join(f.cwd, 'b3004.txt')), true);
});

test('一句话点名多个文件时，检查点候选能覆盖全部', () => {
  assert.deepEqual(allFileMentions('依次新建 restart-a.txt 内容 A，restart-b.txt 内容 B，restart-c.txt 内容 C'), ['restart-a.txt', 'restart-b.txt', 'restart-c.txt']);
});

test('候选文件 lstat 瞬时失败时不当成不存在，任务没改也不删除', t => {
  const f = fixture(t);
  const customer = path.join(f.cwd, 'customer.txt'); fs.writeFileSync(customer, 'customer data');
  const original = fs.lstatSync;
  try {
    fs.lstatSync = function (file, ...args) { if (String(file) === customer) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return original.call(fs, file, ...args); };
    beginRunCheckpoint({ config: f.config, runId: 'R28', cwd: f.cwd, files: [customer] });
  } finally { fs.lstatSync = original; }
  const meta = finishRunCheckpoint({ config: f.config, runId: 'R28', cwd: f.cwd });
  assert.equal((meta.changes || []).some(row => row.path === customer), false);
  rollbackRunCheckpoint({ config: f.config, runId: 'R28' });
  assert.equal(fs.readFileSync(customer, 'utf8'), 'customer data');
});
