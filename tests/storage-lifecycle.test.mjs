import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { scanStorage, cleanupStorage, STORAGE_PROTECTED } from '../src/storage-lifecycle.mjs';
import { TOOLS } from '../src/tools.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

const DAY = 86400000;
function age(file, days) { const t = Date.now() - days * DAY; fs.utimesSync(file, t / 1000, t / 1000); }
function write(file, text, days) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); if (days !== undefined) age(file, days); }
function fixture(t) {
  const root = cleanup(t, tempDir('storage-lifecycle'));
  const config = { root, dataDir: path.join(root, 'data') };
  write(path.join(config.dataDir, 'uploads', 'old.bin'), 'x'.repeat(4000), 200);
  write(path.join(config.dataDir, 'uploads', 'new.bin'), 'y'.repeat(200));
  write(path.join(config.dataDir, 'logs', 'old.log'), 'z'.repeat(3000), 40);
  write(path.join(config.dataDir, 'logs', 'new.log'), 'n'.repeat(100));
  write(path.join(config.dataDir, 'logs', 'service.log'), 's'.repeat(2000), 90);
  write(path.join(config.dataDir, 'reports', 'old-report.md'), 'r'.repeat(1500), 45);
  write(path.join(config.dataDir, 'tmp', 'old.tmp'), 't'.repeat(500), 10);
  write(path.join(config.dataDir, 'browser-profiles', 'cache.bin'), 'b'.repeat(700), 10);
  write(path.join(config.dataDir, 'beat.sqlite'), 'database', 400);
  write(path.join(root, 'workspaces', 'task', 'out.txt'), 'keep me', 400);
  return { root, config };
}

test('存储扫描：分区域统计大小和可清理量，数据库/工作区列入保护', t => {
  const { config } = fixture(t);
  const report = scanStorage(config);
  assert.ok(report.totalBytes > 10000, '总占用要统计所有区域');
  assert.ok(report.cleanableBytes > 9000, '超过保留期的旧数据要单独算出来');
  assert.equal(report.areas.logs.exists, true);
  assert.ok(report.databaseBytes > 0, '任务数据库单独统计，但不自动清理');
  assert.ok(report.areas.logs.cleanableBytes >= 3000);
  assert.deepEqual(report.protected, [...STORAGE_PROTECTED]);
  assert.match(report.note, /不会自动删除/);
});

test('清理：只删超过保留期的旧缓存；service.log、数据库、任务成果和最近数据都保留', t => {
  const { root, config } = fixture(t);
  const before = scanStorage(config).totalBytes;
  const dry = cleanupStorage(config, { dryRun: true });
  assert.ok(dry.freedBytes > 9000);
  assert.equal(scanStorage(config).totalBytes, before, 'dryRun 不能删任何文件');

  const result = cleanupStorage(config);
  assert.equal(result.dryRun, false);
  assert.equal(result.freedBytes, dry.freedBytes);
  assert.equal(result.deletedFiles, dry.deletedFiles);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'uploads', 'old.bin')), false);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'uploads', 'new.bin')), true);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'logs', 'old.log')), false);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'logs', 'service.log')), true, '当前服务日志必须保留');
  assert.equal(fs.existsSync(path.join(config.dataDir, 'reports', 'old-report.md')), false);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'tmp', 'old.tmp')), false);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'browser-profiles', 'cache.bin')), false);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'beat.sqlite')), true, '数据库不能删');
  assert.equal(fs.existsSync(path.join(root, 'workspaces', 'task', 'out.txt')), true, '任务成果不能删');
  assert.equal(scanStorage(config).cleanableBytes, 0, '清理后没有可清理的旧数据');
});

test('目录不存在时扫描和清理都不报错（新装/刚清理过的机器）', t => {
  const root = cleanup(t, tempDir('storage-empty'));
  const config = { root, dataDir: path.join(root, 'data') };
  const report = scanStorage(config);
  assert.equal(report.totalBytes, 0);
  assert.equal(report.cleanableBytes, 0);
  const dry = cleanupStorage(config, { dryRun: true }), done = cleanupStorage(config);
  assert.equal(dry.freedBytes, 0); assert.equal(done.freedBytes, 0); assert.equal(done.deletedFiles, 0);
});

test('看板工具：storage_report 返回真实统计，storage_cleanup 支持 dryRun', t => {
  const { config } = fixture(t);
  const report = TOOLS.storage_report.run({ config });
  assert.ok(report.totalBytes > 0);
  const dry = TOOLS.storage_cleanup.run({ config }, { dryRun: true });
  assert.ok(dry.freedBytes > 0);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'uploads', 'old.bin')), true);
  const done = TOOLS.storage_cleanup.run({ config }, {});
  assert.ok(done.freedBytes > 0);
});

test('看板首页显示占用和清理按钮，没有数据时隐藏而不是报错', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const bar = { hidden: true, innerHTML: '' };
  const context = vm.createContext({ $: id => id === 'storageBar' ? bar : null, esc: value => String(value ?? ''), fmtBytes: n => Math.round(Number(n || 0)) + ' B' });
  const start = script.indexOf('function renderStorage(report) {');
  const end = script.indexOf('async function loadStorage()', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(script.slice(start, end), context);
  context.renderStorage({ totalBytes: 5000, cleanableBytes: 1200, areas: { uploads: { bytes: 3000 }, logs: { bytes: 1000 }, reports: { bytes: 0 }, tmp: { bytes: 400 }, browserProfiles: { bytes: 0 } } });
  assert.equal(bar.hidden, false);
  assert.match(bar.innerHTML, /本地数据占用/);
  assert.match(bar.innerHTML, /可清理/);
  assert.match(bar.innerHTML, /清理旧数据/);
  context.renderStorage(null);
  assert.equal(bar.hidden, true);
});

test('清理不跟随符号链接，链接目标不会被误删', t => {
  const root = cleanup(t, tempDir('storage-link'));
  const config = { root, dataDir: path.join(root, 'data') };
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside, { recursive: true });
  const target = path.join(outside, 'keep.txt'); fs.writeFileSync(target, 'keep');
  const uploads = path.join(config.dataDir, 'uploads'); fs.mkdirSync(uploads, { recursive: true });
  let linked = false;
  try { fs.symlinkSync(outside, path.join(uploads, 'link'), 'junction'); linked = true; } catch {}
  if (!linked) return;
  cleanupStorage(config);
  assert.equal(fs.existsSync(target), true, '符号链接目标不能被存储清理误删');
});

test('检查点按整个任务目录清理，绝不只删备份留下一个假的撤销入口', t => {
  const { config } = fixture(t);
  const runDir = path.join(config.dataDir, 'checkpoints', 'R1'); fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), '{}'); fs.writeFileSync(path.join(runDir, 'file-000.bin'), 'backup');
  age(path.join(runDir, 'meta.json'), 40); age(path.join(runDir, 'file-000.bin'), 40);
  const fresh = path.join(config.dataDir, 'checkpoints', 'R2'); fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(fresh, 'meta.json'), '{}'); fs.writeFileSync(path.join(fresh, 'file-000.bin'), 'backup');
  const kept = cleanupStorage(config); // 默认不自动清理检查点
  assert.equal(fs.existsSync(runDir), true);
  const result = cleanupStorage(config, { includeCheckpoints: true });
  assert.equal(fs.existsSync(runDir), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.ok(result.areas.find(area => area.id === 'checkpoints').files > 0);
});

test('超大目录分次清理：单次有文件预算，返回 truncated，下一次继续', t => {
  const root = cleanup(t, tempDir('storage-budget'));
  const config = { root, dataDir: path.join(root, 'data') };
  for (let i = 0; i < 6; i++) write(path.join(config.dataDir, 'uploads', 'old-' + i + '.bin'), 'x'.repeat(100), 200);
  const first = cleanupStorage(config, { maxFilesPerArea: 2, timeBudgetMs: 5000 });
  assert.equal(first.truncated, true);
  assert.ok(first.deletedFiles <= 2);
  assert.ok(fs.readdirSync(path.join(config.dataDir, 'uploads')).length >= 4);
  const second = cleanupStorage(config, { maxFilesPerArea: 10, timeBudgetMs: 5000 });
  assert.equal(second.truncated, false);
  assert.ok(fs.readdirSync(path.join(config.dataDir, 'uploads')).length <= 1);
});
