// 每任务文件检查点：执行前备份客户点名的文件，执行后列出新增/修改/删除，可一键撤销。
// 借鉴 Aider 的自动可回滚改动与 Cline 的 Checkpoint/Restore；不依赖 git，不改变执行结果。
// 安全边界：只处理普通文件；撤销前核对当前哈希，任务结束后又被改过的文件不覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { snapshot, diffSnapshots } from './workspace.mjs';

export const CHECKPOINT_LIMIT = Object.freeze({
  files: 80,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 24 * 1024 * 1024,
  diffChars: 12000,
  maxChanges: 200,
  diffBudget: 2 * 1024 * 1024,
  readBytes: 8 * 1024 * 1024,
});
const MAX_META_BYTES = 12 * 1024 * 1024;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_ID_GUARD = /^[A-Za-z0-9_-]{1,64}$/;

const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const nowIso = () => new Date().toISOString();
const pathKey = file => process.platform === 'win32' ? String(file).toLowerCase() : String(file);
const dirFor = config => path.join(config.dataDir || config.dataRoot || config.root, 'checkpoints');
function checkpointDir(config, runId) {
  const safe = String(runId || 'run').replace(/[^\w.-]/g, '_');
  return path.join(dirFor(config), safe);
}
function metaFile(config, runId) { return path.join(checkpointDir(config, runId), 'meta.json'); }

// 真实路径包含判断的唯一实现在 ./path-containment.mjs：拒绝经 junction/symlink
// 绕过允许目录；文件尚不存在时校验父目录。
import { realPathSafe, insideAnyReal as insideAny } from './path-containment.mjs';

export function checkpointExists(config, runId) {
  try {
    if (!config || !RUN_ID_GUARD.test(String(runId || ''))) return false;
    const stat = fs.statSync(metaFile(config, runId));
    return stat.isFile() && stat.size <= 16 * 1024 * 1024;
  } catch { return false; }
}
export function readCheckpoint(config, runId) {
  try {
    if (!config || !RUN_ID_GUARD.test(String(runId || ''))) return null;
    const file = metaFile(config, runId);
    // 防御历史/异常检查点：超大 meta 直接视为过期，避免 JSON.parse 拖垮服务。
    if (fs.statSync(file).size > 16 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
function writeMeta(config, runId, meta) {
  const dir = checkpointDir(config, runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = metaFile(config, runId);
  let json = JSON.stringify(meta, null, 2);
  // 防御性上限：极端工作区不能把检查点写成几百 MB 拖垮看板，也不能超过读取上限。
  if (json.length > 8 * 1024 * 1024) {
    for (const change of meta.changes || []) change.diff = null;
    meta.changesTruncated = true;
    json = JSON.stringify(meta, null, 2);
  }
  if (json.length > 8 * 1024 * 1024 && (meta.changes || []).length > 50) {
    meta.changes = meta.changes.slice(0, 50);
    meta.changesTruncated = true;
    json = JSON.stringify(meta, null, 2);
  }
  if (json.length > 8 * 1024 * 1024 && meta.beforeSnapshot) {
    meta.beforeSnapshot = Object.fromEntries(Object.entries(meta.beforeSnapshot).slice(0, 1500));
    meta.truncated = true;
    meta.beforeComplete = false;
    json = JSON.stringify(meta, null, 2);
  }
  if (json.length > MAX_META_BYTES) {
    meta.changes = [];
    meta.beforeSnapshot = {};
    meta.changesTruncated = true;
    meta.truncated = true;
    json = JSON.stringify(meta, null, 2);
  }
  fs.writeFileSync(file + '.tmp', json);
  fs.renameSync(file + '.tmp', file);
}
function allowedRoots(config) {
  return [...new Set([config.root, config.workspace, ...(config.allowedRoots || []), ...Object.values(config.userFolders || {})]
    .filter(Boolean).map(p => realPathSafe(p)))];
}
const INTERNAL_PATH = /(?:^|[\\/]).beat-(?:control|attachments)(?:[\\/]|$)/i;
const statSafe = file => { try { const s = fs.lstatSync(file); return s.isFile() && !s.isSymbolicLink() ? s : null; } catch { return null; } };
const lstatSafe = file => { try { return fs.lstatSync(file); } catch { return null; } };
const readSafe = file => { try { return fs.readFileSync(file); } catch { return null; } };
const readCapped = file => {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { stat, notFile: true };
    if (stat.size > CHECKPOINT_LIMIT.readBytes) return { stat, tooLarge: true };
    return { stat, buffer: fs.readFileSync(file) };
  } catch { return { missing: true }; }
};
function backupName(index) { return 'file-' + String(index).padStart(3, '0') + '.bin'; }

export function beginRunCheckpoint({ config, runId, cwd, files = [], keepExisting = false } = {}) {
  if (!config?.dataDir || !runId) return null;
  const safeId = String(runId);
  if (!RUN_ID.test(safeId)) return null;
  const existing = readCheckpoint(config, safeId);
  if (existing && (existing.status === 'open' || keepExisting)) return existing;
  // 同一任务重试/续跑：不丢掉上一轮的撤销记录，沿用最初的执行前快照和备份重新打开检查点。
  // 这样第二次执行后的撤销仍然回到“第一次执行前”，而不是把第一轮改动当成不可撤销的既成事实。
  if (existing) {
    existing.status = 'open';
    existing.finishedAt = null;
    existing.rolledBackAt = null;
    existing.rolledBack = [];
    existing.partial = false;
    existing.changes = [];
    writeMeta(config, safeId, existing);
    return existing;
  }
  const root = path.resolve(cwd || config.workspace || config.root);
  let rootReadable = true;
  try { fs.readdirSync(root); } catch { rootReadable = false; }
  const roots = [...allowedRoots(config), root].map(realPathSafe);
  const unique = [...new Set((files || []).filter(Boolean).map(file => path.resolve(String(file))))]
    .filter(file => insideAny(roots, file)).slice(0, CHECKPOINT_LIMIT.files);
  const beforeMap = root && rootReadable ? snapshot(root, 3000) : new Map();
  const meta = {
    version: 2, runId: safeId, cwd: root, createdAt: nowIso(), startedAt: nowIso(), status: 'open',
    beforeComplete: rootReadable && beforeMap.truncated !== true && beforeMap.incomplete !== true,
    roots,
    beforeSnapshot: Object.fromEntries(beforeMap),
    candidates: unique.map(file => ({ path: file })),
    files: [], changes: [],
  };
  let total = 0;
  for (const candidate of meta.candidates) {
    let lstat = null, lstatError = null;
    try { lstat = fs.lstatSync(candidate.path); } catch (error) { lstatError = error.code; }
    const stat = lstat && lstat.isFile() && !lstat.isSymbolicLink() ? lstat : null;
    if (!stat) {
      // 只有明确 ENOENT 才算“执行前不存在”；EPERM/EBUSY/符号链接/目录一律保守处理，绝不据此删除。
      const relative = path.relative(root, candidate.path);
      const inSnapshot = relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)
        && Object.prototype.hasOwnProperty.call(meta.beforeSnapshot || {}, relative);
      const absent = !lstat && lstatError === 'ENOENT' && !inSnapshot;
      meta.files.push({ path: candidate.path, existed: !absent, knownAbsent: absent, bytes: 0, sha256: null, backup: null, ...(absent ? {} : { skipped: 'not-regular-or-unreadable' }) });
      continue;
    }
    if (stat.size > CHECKPOINT_LIMIT.fileBytes) { meta.files.push({ path: candidate.path, existed: true, bytes: stat.size, sha256: null, backup: null, skipped: 'file-too-large' }); continue; }
    if (total + stat.size > CHECKPOINT_LIMIT.totalBytes) { meta.files.push({ path: candidate.path, existed: true, bytes: stat.size, sha256: null, backup: null, skipped: 'checkpoint-budget' }); continue; }
    const buffer = readSafe(candidate.path);
    if (!buffer) continue;
    const index = meta.files.length;
    const dir = checkpointDir(config, safeId), backup = path.join(dir, backupName(index));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(backup, buffer);
    total += buffer.length;
    meta.files.push({ path: candidate.path, existed: true, bytes: stat.size, sha256: hash(buffer), backup: backupName(index) });
  }
  writeMeta(config, safeId, meta);
  return meta;
}

function textDiff(before, after) {
  if (before === null || after === null) return { diff: '', addedLines: 0, removedLines: 0, binary: true };
  if (before.length > CHECKPOINT_LIMIT.fileBytes || after.length > CHECKPOINT_LIMIT.fileBytes) {
    return { diff: '（文件较大，已保存备份；请打开文件对比）', addedLines: 0, removedLines: 0, binary: false, large: true };
  }
  const oldText = before.toString('utf8'), newText = after.toString('utf8');
  if (oldText.includes('\u0000') || newText.includes('\u0000')) return { diff: '（二进制文件，不做文本差异）', addedLines: 0, removedLines: 0, binary: true };
  const a = oldText.split('\n'), b = newText.split('\n');
  if (a.length > 1500 || b.length > 1500) {
    return { diff: `文件较大（${a.length} → ${b.length} 行），已保存原文件备份；请打开文件对比。`, addedLines: 0, removedLines: 0, binary: false, large: true };
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0, addedLines = 0, removedLines = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { ops.push(['+', b[j]]); j++; addedLines++; }
    else { ops.push(['-', a[i]]); i++; removedLines++; }
  }
  const lines = [];
  for (const [kind, value] of ops) lines.push(kind + value);
  let diff = lines.join('\n');
  if (diff.length > CHECKPOINT_LIMIT.diffChars) diff = diff.slice(0, CHECKPOINT_LIMIT.diffChars) + '\n…（差异过长，已截断）';
  return { diff, addedLines, removedLines, binary: false };
}

export function finishRunCheckpoint({ config, runId, cwd, extraFiles = [] } = {}) {
  const meta = readCheckpoint(config, runId);
  if (!meta || meta.status !== 'open') return meta;
  const root = path.resolve(meta.cwd || cwd || config.workspace || config.root);
  const before = new Map(Object.entries(meta.beforeSnapshot || {}));
  const after = snapshot(root, 3000);
  const afterIncomplete = after.incomplete === true;
  const complete = meta.beforeComplete === true && after.truncated !== true && !afterIncomplete;
  const c = diffSnapshots(before, after);
  const filesByKey = new Map((meta.files || []).map(row => [pathKey(row.path), row]));
  const byPath = new Map();
  const add = (file, kind, knownAbsent = false) => {
    const resolved = path.resolve(file);
    if (INTERNAL_PATH.test(resolved)) return;
    const key = pathKey(resolved);
    const prior = byPath.get(key);
    if (!prior) {
      byPath.set(key, { path: resolved, kind, knownAbsent: kind === 'added' && knownAbsent === true });
      return;
    }
    if (kind === 'modified' && prior.kind === 'added') { prior.kind = 'modified'; prior.knownAbsent = false; }
    if (kind === 'added' && knownAbsent) prior.knownAbsent = true;
  };
  // 快照被截断/根目录不可读时，无法证明“执行前不存在”，因此只采信能双向证实的修改；
  // 新增和删除只在前快照完整时才进入可回滚列表，避免把没动过的文件当成新增删掉。
  if (complete) {
    for (const rel of c.added) add(path.join(root, rel), 'added', true);
    for (const rel of c.deleted) add(path.join(root, rel), 'deleted');
  }
  for (const rel of c.modified) add(path.join(root, rel), 'modified');

  const roots = (meta.roots && meta.roots.length ? meta.roots : allowedRoots(config)).map(realPathSafe);
  // 目标在 cwd 之外（桌面/文档）时按执行前备份逐个比较；先按候选行判断，不能一律当新增。
  for (const file of extraFiles || []) {
    const resolved = path.resolve(String(file));
    if (!insideAny(roots, resolved)) continue;
    const key = pathKey(resolved);
    if (byPath.has(key)) continue;
    const row = filesByKey.get(key);
    const stat = statSafe(resolved);
    if (!stat) { if (row?.existed) add(resolved, 'deleted'); continue; }
    if (row?.existed) {
      const current = readCapped(resolved);
      if (current.buffer && row.sha256 && hash(current.buffer) !== row.sha256) add(resolved, 'modified');
      continue;
    }
    // 有候选行且明确不存在 → 安全新增；完全没有执行前记录 → 只展示，不提供删除。
    add(resolved, 'added', row?.existed === false && row?.knownAbsent === true);
  }
  for (const row of meta.files || []) {
    const resolved = path.resolve(row.path);
    const key = pathKey(resolved);
    if (byPath.has(key)) continue;
    const stat = statSafe(resolved);
    if (row.existed && !stat) { if (afterIncomplete) continue; add(resolved, 'deleted'); }
    else if (!row.existed && stat) add(resolved, 'added', row.knownAbsent === true);
    else if (row.existed && stat && row.sha256) {
      const current = readCapped(resolved);
      if (current.buffer && hash(current.buffer) !== row.sha256) add(resolved, 'modified');
    }
  }

  let diffBudget = CHECKPOINT_LIMIT.diffBudget;
  const changes = [];
  for (const change of byPath.values()) {
    const key = pathKey(change.path);
    const row = filesByKey.get(key);
    const current = readCapped(change.path);
    const afterBuffer = current.buffer || null;
    let backup = null;
    if (row?.backup) {
      const backupPath = path.join(checkpointDir(config, runId), row.backup);
      const read = readCapped(backupPath);
      backup = read.buffer || null;
    }
    const beforeBuffer = row?.existed ? backup : null;
    let diff = null, addedLines = 0, removedLines = 0;
    if (change.kind === 'added') {
      if (afterBuffer && afterBuffer.length <= CHECKPOINT_LIMIT.fileBytes) {
        const text = afterBuffer.toString('utf8');
        addedLines = text.split('\n').length;
        if (afterBuffer.includes(0)) diff = '（二进制文件，不做文本差异）';
        else if (diffBudget > 0) {
          const candidate = text.split('\n').map(line => '+' + line).join('\n');
          diff = candidate.slice(0, Math.min(CHECKPOINT_LIMIT.diffChars, diffBudget));
          diffBudget -= diff.length;
        }
      } else if (current.tooLarge) diff = '（文件较大，未读取内容做差异）';
    } else if (change.kind === 'deleted') {
      if (beforeBuffer && beforeBuffer.length <= CHECKPOINT_LIMIT.fileBytes) {
        const text = beforeBuffer.toString('utf8');
        removedLines = text.split('\n').length;
        if (beforeBuffer.includes(0)) diff = '（二进制文件，不做文本差异）';
        else if (diffBudget > 0) {
          const candidate = text.split('\n').map(line => '-' + line).join('\n');
          diff = candidate.slice(0, Math.min(CHECKPOINT_LIMIT.diffChars, diffBudget));
          diffBudget -= diff.length;
        }
      }
    } else {
      const result = textDiff(beforeBuffer, afterBuffer);
      addedLines = result.addedLines; removedLines = result.removedLines;
      if (result.diff && diffBudget > 0) {
        diff = result.diff.slice(0, Math.min(CHECKPOINT_LIMIT.diffChars, diffBudget));
        diffBudget -= diff.length;
      }
    }
    let restorable = false, reason = null;
    if (change.kind === 'added') {
      if (change.knownAbsent !== true) reason = '执行前快照不完整，无法确认是新增，未提供撤销';
      else if (current.tooLarge || current.notFile) reason = '当前文件较大或不是普通文件，不能安全删除';
      else restorable = true;
    } else if (row?.existed && backup) {
      if (current.tooLarge) reason = '当前文件较大，无法安全核对，未提供撤销';
      else restorable = true;
    } else {
      reason = row?.skipped || (row ? '文件未在检查点预算内备份' : '执行前没有备份这个文件');
    }
    changes.push({
      path: change.path, kind: change.kind, restorable, reason,
      existedBefore: !!row?.existed, knownAbsent: change.kind === 'added' && change.knownAbsent === true,
      backup: row?.backup || null, beforeSha256: row?.sha256 || null,
      afterSha256: afterBuffer ? hash(afterBuffer) : null,
      bytes: current.stat?.size || (afterBuffer?.length || 0),
      addedLines, removedLines, diff,
    });
  }
  let changesTruncated = false;
  if (changes.length > CHECKPOINT_LIMIT.maxChanges) {
    changesTruncated = true;
    changes.length = CHECKPOINT_LIMIT.maxChanges;
  }
  meta.changes = changes;
  meta.status = meta.changes.length ? 'ready' : 'clean';
  meta.finishedAt = nowIso();
  meta.truncated = c.truncated === true || !complete || changesTruncated;
  meta.changesTruncated = changesTruncated;
  writeMeta(config, runId, meta);
  return meta;
}

export function rollbackRunCheckpoint({ config, runId, paths = null, dryRun = false } = {}) {
  const meta = readCheckpoint(config, runId);
  if (!meta) throw new Error('这个任务没有可撤销的文件检查点。');
  if (meta.status === 'rolled-back') return { restored: [], skipped: [], alreadyRolledBack: true };
  if (!['ready', 'clean', 'partial'].includes(meta.status)) throw new Error('任务还在进行或检查点未完成，现在不能撤销。');
  const roots = (meta.roots && meta.roots.length ? meta.roots : allowedRoots(config)).map(realPathSafe);
  const wanted = Array.isArray(paths) && paths.length ? new Set(paths.map(p => pathKey(path.resolve(String(p))))) : null;
  const restored = [], skipped = [];
  const already = new Set((meta.rolledBack || []).map(pathKey));
  for (const change of meta.changes || []) {
    const key = pathKey(change.path);
    if (wanted && !wanted.has(key)) continue;
    if (already.has(key)) { restored.push({ path: change.path, kind: change.kind, action: '已撤销过' }); continue; }
    // 撤销时重新校验真实路径：父目录 junction 被换目标、文件被替换成链接都不能写到允许范围外。
    if (!insideAny(roots, change.path)) { skipped.push({ path: change.path, reason: '路径已不在允许范围，未撤销' }); continue; }
    const lstat = lstatSafe(change.path);
    if (lstat && !lstat.isFile()) { skipped.push({ path: change.path, reason: '当前路径不是普通文件，未撤销' }); continue; }
    const current = readCapped(change.path);
    if (current.tooLarge) { skipped.push({ path: change.path, reason: '当前文件较大，无法安全核对，未撤销' }); continue; }
    if (change.kind === 'added') {
      if (change.knownAbsent !== true) { skipped.push({ path: change.path, reason: '执行前是否已存在无法确认，未删除' }); continue; }
      if (current.stat && hash(current.buffer) !== change.afterSha256) { skipped.push({ path: change.path, reason: '任务结束后文件又被改过，未删除' }); continue; }
      if (!dryRun && current.stat) fs.unlinkSync(change.path);
      restored.push({ path: change.path, kind: 'added', action: dryRun ? '会删除' : '已删除' });
      continue;
    }
    const backup = change.backup ? readSafe(path.join(checkpointDir(config, runId), change.backup)) : null;
    if (!backup) { skipped.push({ path: change.path, reason: '执行前没有备份，无法恢复' }); continue; }
    if (change.kind === 'deleted' && current.stat) { skipped.push({ path: change.path, reason: '文件目录恢复可读后又出现了，未覆盖' }); continue; }
    if (current.stat && change.afterSha256 && hash(current.buffer) !== change.afterSha256) { skipped.push({ path: change.path, reason: '任务结束后文件又被改过，未覆盖' }); continue; }
    if (!dryRun) { fs.mkdirSync(path.dirname(change.path), { recursive: true }); fs.writeFileSync(change.path, backup); }
    restored.push({ path: change.path, kind: change.kind, action: dryRun ? '会恢复' : '已恢复' });
  }
  if (!dryRun && restored.length) {
    meta.rolledBack = [...new Set([...(meta.rolledBack || []), ...restored.map(row => row.path)])];
    // 只撤销了一部分（选了单个文件、或还有跳过的文件）时不能标“全部已撤销”，否则剩余文件会被永久锁住。
    const done = new Set(meta.rolledBack.map(pathKey));
    const allDone = (meta.changes || []).every(change => done.has(pathKey(change.path)));
    meta.status = allDone ? 'rolled-back' : 'partial';
    meta.rolledBackAt = nowIso();
    writeMeta(config, runId, meta);
  }
  return { restored, skipped, dryRun, total: (meta.changes || []).length };
}

export function checkpointSummary(meta, { maxChanges = 30, maxDiff = 6000 } = {}) {
  if (!meta) return null;
  const visible = (meta.changes || []).filter(change => !INTERNAL_PATH.test(change.path || ''));
  const changes = visible.slice(0, maxChanges).map(change => ({
    path: change.path, kind: change.kind, restorable: change.restorable === true, reason: change.reason || null,
    existedBefore: change.existedBefore === true, knownAbsent: change.knownAbsent === true,
    bytes: change.bytes || 0, addedLines: change.addedLines || 0, removedLines: change.removedLines || 0,
    diff: change.diff ? String(change.diff).slice(0, maxDiff) : null,
  }));
  // 这个函数也可能收到已经汇总过的 summary（orchestrator 二次汇总），必须幂等保留撤销进度和总数。
  const total = Number.isFinite(meta.total) ? Math.max(Number(meta.total), visible.length) : visible.length;
  return { runId: meta.runId, status: meta.status, createdAt: meta.createdAt, startedAt: meta.startedAt || null,
    finishedAt: meta.finishedAt || null, total, changes,
    rolledBackPaths: meta.rolledBackPaths || meta.rolledBack || [], partial: meta.partial === true || meta.status === 'partial',
    truncated: meta.truncated === true, changesTruncated: meta.changesTruncated === true,
    beforeComplete: meta.beforeComplete === true, rolledBackAt: meta.rolledBackAt || null };
}
