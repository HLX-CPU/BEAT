// 本地存储生命周期：报告、日志、临时文件、浏览器缓存和旧上传附件会越积越多。
// 这里只清理"可以重新生成的缓存"和"超过保留期的上传副本"；任务成果、数据库、配置永远不动。
// 所有判断都基于真实文件 mtime；清理前可 dryRun 预览，返回实际释放字节数。
import fs from 'node:fs';
import path from 'node:path';

export const MB = 1024 * 1024;
export const STORAGE_AREAS = Object.freeze([
  { id: 'uploads', label: '上传附件', dirs: ['uploads'], days: 90, keep: [], note: '任务工作目录里的附件副本会保留；这里只删上传缓存。' },
  { id: 'logs', label: '运行日志', dirs: ['logs'], days: 30, keep: ['service.log'], note: '当前服务日志始终保留。' },
  { id: 'reports', label: '交付报告缓存', dirs: ['reports'], days: 30, keep: [], note: '任务详情和成果文件不受影响。' },
  { id: 'tmp', label: '临时文件', dirs: ['tmp'], days: 7, keep: [], note: '临时目录可随时重新生成。' },
  { id: 'browserProfiles', label: '浏览器缓存', dirs: ['browser-profiles'], days: 7, keep: [], note: '下次用到时会重新建立。' },
  { id: 'checkpoints', label: '任务文件检查点', dirs: ['checkpoints'], days: 30, keep: [], note: '超过 30 天的撤销记录会清理；任务成果文件不受影响。' },
]);
export const STORAGE_PROTECTED = Object.freeze(['beat.sqlite', 'beat.sqlite-wal', 'beat.sqlite-shm', 'workspaces', 'config.json', 'secrets.local.json']);

const cutoffFor = (days, now = Date.now()) => now - Math.max(1, Number(days) || 1) * 86400000;

function walkFiles(root, visit, budget = { left: 20000, deadline: Infinity }) {
  if (budget.left <= 0 || Date.now() > budget.deadline) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (budget.left <= 0 || Date.now() > budget.deadline) return;
    budget.left -= 1;
    const file = path.join(root, entry.name);
    let stat;
    try { stat = fs.lstatSync(file); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walkFiles(file, visit, budget);
    else if (stat.isFile()) visit(file, stat);
  }
}

function areaDir(config, area) { return path.join(config.dataDir || config.dataRoot || config.root, ...area.dirs); }

export function scanStorage(config, { now = Date.now(), maxFilesPerArea = 20000, timeBudgetMs = 2000 } = {}) {
  const areas = {};
  let totalBytes = 0, totalFiles = 0, cleanableBytes = 0, cleanableFiles = 0, truncated = false;
  for (const area of STORAGE_AREAS) {
    const scanBudget = { left: maxFilesPerArea, deadline: now + timeBudgetMs };
    const dir = areaDir(config, area);
    const cutoff = cutoffFor(area.days, now);
    const row = { id: area.id, label: area.label, dir, exists: fs.existsSync(dir), days: area.days, note: area.note,
      bytes: 0, files: 0, cleanableBytes: 0, cleanableFiles: 0, oldestDays: null };
    walkFiles(dir, (file, stat) => {
      row.bytes += stat.size; row.files += 1; totalBytes += stat.size; totalFiles += 1;
      const ageDays = Math.floor((now - stat.mtimeMs) / 86400000);
      if (row.oldestDays === null || ageDays > row.oldestDays) row.oldestDays = ageDays;
      if (!area.keep.includes(path.basename(file))) {
        if (stat.mtimeMs < cutoff) { row.cleanableBytes += stat.size; row.cleanableFiles += 1; cleanableBytes += stat.size; cleanableFiles += 1; }
      }
    }, scanBudget);
    if (scanBudget.left <= 0 || Date.now() > scanBudget.deadline) truncated = true;
    areas[area.id] = row;
  }
  let databaseBytes = 0;
  const base = config.dataDir || config.dataRoot || config.root;
  for (const name of ['beat.sqlite', 'beat.sqlite-wal', 'beat.sqlite-shm']) { try { databaseBytes += fs.statSync(path.join(base, name)).size; } catch {} }
  totalBytes += databaseBytes;
  return { dataDir: base, databaseBytes, totalBytes, totalFiles, cleanableBytes, cleanableFiles, truncated,
    areas, protected: [...STORAGE_PROTECTED], cleanupDays: { uploads: 90, logs: 30, reports: 30, tmp: 7, browserProfiles: 7, checkpoints: 30 },
    note: '任务成果、数据库、保存的设置和最近的数据不会自动删除；实际释放多少以清理结果为准。' };
}

function removeEmptyDirs(root, keepRoot = true) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    removed += removeEmptyDirs(dir, false);
  }
  try {
    if (!keepRoot && fs.readdirSync(root).length === 0) { fs.rmdirSync(root); removed += 1; }
  } catch { /* 非空或权限变化就保留 */ }
  return removed;
}

export function cleanupStorage(config, { dryRun = false, now = Date.now(), includeCheckpoints = false, maxFilesPerArea = 20000, timeBudgetMs = 5000 } = {}) {
  const perArea = {};
  let freedBytes = 0, deletedFiles = 0, skipped = 0, truncated = false;
  for (const area of STORAGE_AREAS) {
    const budget = { left: maxFilesPerArea, deadline: now + timeBudgetMs };
    const dir = areaDir(config, area);
    const cutoff = cutoffFor(area.days, now);
    const row = { id: area.id, label: area.label, dir, days: area.days, files: 0, bytes: 0, skipped: 0 };
    if (area.id === 'checkpoints' && !includeCheckpoints) { perArea[area.id] = row; continue; }
    // 检查点按“整个任务目录”保留/清理：不能只删备份保留 meta，否则界面会承诺一个永远失败的撤销。
    if (area.id === 'checkpoints') {
      let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runDir = path.join(dir, entry.name);
        let stat; try { stat = fs.statSync(path.join(runDir, 'meta.json')); } catch { try { stat = fs.statSync(runDir); } catch { continue; } }
        if (stat.mtimeMs >= cutoff) { row.skipped += 1; skipped += 1; continue; }
        const files = []; walkFiles(runDir, (file, fileStat) => files.push({ file, size: fileStat.size }), budget);
        if (budget.left <= 0 || Date.now() > budget.deadline) { truncated = true; break; }
        const bytes = files.reduce((sum, item) => sum + item.size, 0);
        row.files += files.length; row.bytes += bytes;
        if (!dryRun) { try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { row.failed = (row.failed || 0) + 1; row.files -= files.length; row.bytes -= bytes; continue; } }
        freedBytes += bytes; deletedFiles += files.length;
      }
      perArea[area.id] = row;
      continue;
    }
    walkFiles(dir, (file, stat) => {
      if (area.keep.includes(path.basename(file))) { row.skipped += 1; skipped += 1; return; }
      if (stat.mtimeMs >= cutoff) return;
      row.files += 1; row.bytes += stat.size;
      if (!dryRun) { try { fs.unlinkSync(file); } catch { row.failed = (row.failed || 0) + 1; row.files -= 1; row.bytes -= stat.size; return; } }
      freedBytes += stat.size; deletedFiles += 1;
    }, budget);
    if (!dryRun && row.files) removeEmptyDirs(dir, true);
    if (budget.left <= 0 || Date.now() > budget.deadline) truncated = true;
    perArea[area.id] = row;
  }
  return { dryRun, now: new Date(now).toISOString(), freedBytes, deletedFiles, skipped, truncated, perArea,
    areas: Object.values(perArea) };
}
