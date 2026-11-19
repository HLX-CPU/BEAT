// 把模型写的路径归一成"相对工作目录"的写法：落在工作目录内的绝对路径 → 相对路径（验收命令否则会越界被拒）。
// 返回 {value, changed, outside}；outside 表示这条绝对路径落在工作目录之外（调用方据此给出可改的报错）。
export function normalizeWorkspacePath(cwd, value) {
  const raw = String(value ?? '').trim();
  if (!raw || !path.isAbsolute(raw)) return { value: raw, changed: false, outside: false };
  const abs = path.resolve(raw);
  if (!within(path.resolve(cwd), abs)) return { value: raw, changed: false, outside: true };
  const rel = path.relative(path.resolve(cwd), abs).replaceAll('\\', '/');
  return { value: rel || '.', changed: rel !== raw, outside: false };
}

// 把任务方案里的文件范围、引用与检查命令里的路径统一归一（不改写命令的其余部分）。
export function normalizePlanPaths(plan, cwd) {
  if (!plan || !Array.isArray(plan.tasks)) return plan;
  const fixOne = value => normalizeWorkspacePath(cwd, value).value;
  const fixCommand = command => {
    const text = String(command ?? '');
    return text.split(/(\s+)/).map(token => {
      if (!token || /^\s+$/.test(token)) return token;
      if (/^["'].*["']$/.test(token)) { const inner = token.slice(1, -1); const fixed = normalizeWorkspacePath(cwd, inner); return fixed.changed ? JSON.stringify(fixed.value) : token; }
      const fixed = normalizeWorkspacePath(cwd, token);
      return fixed.changed ? fixed.value : token;
    }).join('');
  };
  const tasks = plan.tasks.map(task => ({
    ...task,
    ...(Array.isArray(task.files) ? { files: task.files.map(fixOne) } : {}),
    ...(Array.isArray(task.inputRefs) ? { inputRefs: task.inputRefs.map(row => (typeof row === 'string' ? fixOne(row) : row)) } : {}),
    ...(Array.isArray(task.outputRefs) ? { outputRefs: task.outputRefs.map(fixOne) } : {}),
    ...(Array.isArray(task.checks) ? { checks: task.checks.map(fixCommand) } : {}),
    ...(Array.isArray(task.acceptance) ? { acceptance: task.acceptance.map(item => (item && typeof item === 'object' && item.check ? { ...item, check: fixCommand(item.check) } : item)) } : {}),
  }));
  return { ...plan, tasks,
    ...(Array.isArray(plan.checks) ? { checks: plan.checks.map(fixCommand) } : {}),
    ...(Array.isArray(plan.acceptance) ? { acceptance: plan.acceptance.map(item => (item && typeof item === 'object' && item.check ? { ...item, check: fixCommand(item.check) } : item)) } : {}) };
}

// 每个任务由 BEAT 自己建一个工作目录（像客户要求的"按日期/任务分文件夹"），模型把文件写进去。
// 为什么不让模型自己编路径：R166 实测模型会写 <共享目录>\R166\funcplot\…（落到任务目录之外），
// 检查命令随之越界被拒，产物对却拿不到证据。目录由 BEAT 建，执行者可写、验收命令也指得准。
export function createRunFolder(config, runId, { at = new Date(), root = config.workspace } = {}) {
  const day = new Date(at).toISOString().slice(0, 10);
  const base = path.join(resolveWorkspace(config, root), 'beat-runs', day);
  fs.mkdirSync(base, { recursive: true });
  const safe = String(runId || 'task').replace(/[^\w.-]/g, '_');
  let dir = path.join(base, safe);
  for (let n = 2; fs.existsSync(dir) && fs.readdirSync(dir).length; n++) dir = path.join(base, `${safe}-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

// 工作目录校验：只允许 allowedRoots 之内（含链接穿越检查）；DeepSeek 写入前补齐它的 Windows 沙箱需要的目录权限。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultUserFolders } from '../workspaces/shared/desktop-assistant/core/security.mjs';
import { workspaceGrantAllows } from './workspace-access.mjs';

const within = (root, p) => { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
let knownFolders, knownAt=0;
const userRoots=()=>{if(!knownFolders||Date.now()-knownAt>60000){knownFolders=Object.values(defaultUserFolders()).filter(Boolean);knownAt=Date.now();}return knownFolders;};
function canonical(p) {
  let a = path.resolve(p);
  while (!fs.existsSync(a)) a = path.dirname(a);
  return path.resolve(fs.realpathSync(a), path.relative(a, path.resolve(p)));
}

export function resolveWorkspace(config, input, { access = 'workspace-write', checkOnly = false } = {}) {
  const p = path.resolve(input || config.workspace);
  const roots = [...(config.allowedRoots || []), ...userRoots()];
  const configured = roots.some(r => within(path.resolve(r), p));
  if (!configured && !workspaceGrantAllows(config, p, access)) {
    throw Object.assign(new Error(`BEAT 还没有访问这个文件夹的权限：${p}`), { permissionFolder: p, permissionAccess: access });
  }
  if (configured && !roots.some(r => within(canonical(r), canonical(p)))) throw new Error('这个文件夹链接指向了尚未授权的位置，请直接选择真实文件夹。');
  if (checkOnly) return canonical(p);
  if (access !== 'read-only') fs.mkdirSync(p, { recursive: true });
  return fs.realpathSync(p);
}

// Natural destination requests are resolved before planning, with the existing
// known-folder boundary. This never adds an arbitrary model-supplied root.
export function resolveGoalWorkspace(config, input, goal, folders = defaultUserFolders()) {
  if(input)return resolveWorkspace(config,input);
  const text=String(goal||'');
  const destinations=[['desktop','桌面|desktop'],['documents','文档(?:文件夹)?|documents'],['downloads','下载(?:文件夹|目录)?|downloads']];
  for(const [key,names] of destinations){
    if(!new RegExp('(?:放(?:到|在)?|保存(?:到|在)?|输出(?:到|在)?|生成(?:到|在)|存到|写到|在)\\s*(?:我的|用户的)?\\s*(?:电脑(?:的)?)?\\s*(?:'+names+')','i').test(text))continue;
    const root=folders[key];
    if(!root)throw new Error('暂时无法确认真实'+({desktop:'桌面',documents:'文档文件夹',downloads:'下载文件夹'})[key]+'位置，未写入其他目录；请在看板选择目标位置后继续');
    return resolveWorkspace({...config,allowedRoots:[...(config.allowedRoots||[]),root]},root);
  }
  return resolveWorkspace(config);
}

// DeepSeek Harness 的 ACL 沙箱需要目录所有者具备 WRITE_OWNER；只给“本人拥有的目录”补本人 FullControl，原规则保留，改前备份 SDDL。
const prepared = new Set();
export function ensureWritableForDeepseek(config, dir) {
  if (process.platform !== 'win32' || prepared.has(dir) || config.skipAcl) return;
  const backupDir = path.join(config.dataDir, 'acl-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$ErrorActionPreference='Stop'
$p=$env:BEAT_ACL_PATH; $acl=Get-Acl -LiteralPath $p
$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $has=$false
foreach($r in $acl.Access){ try{$sid=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])}catch{continue}
  if($sid -eq $me -and $r.AccessControlType -eq 'Allow' -and ($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl){$has=$true} }
if(-not $has){
  $owner=([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier])
  if($owner -ne $me){ throw '该目录不归当前用户所有，未修改权限；请换一个自己的工作目录' }
  $rec=@{path=$p;owner=$acl.Owner;sddl=$acl.Sddl;time=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $env:BEAT_ACL_BACKUP ([Guid]::NewGuid().ToString()+'.json')),$rec)
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  Set-Acl -LiteralPath $p -AclObject $acl }`;
  // 从 PowerShell 7 里启动时会继承它的模块路径，Windows PowerShell 5.1 就找不到 Get-Acl，所以显式指回系统模块目录。
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'), BEAT_ACL_PATH: dir, BEAT_ACL_BACKUP: backupDir },
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  if (r.status !== 0) throw new Error('工作目录权限准备失败：' + (r.error?.message || r.stderr).trim());
  prepared.add(dir);
}

// 快照目录（跳过依赖/版本库目录），用来告诉审核方“这一轮到底改了哪些文件”。
// 目录很大时会截断：截断的快照不能证明“文件曾经不存在”，所以标记 truncated，由调用方只采信能用 mtime 佐证的改动。
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.pytest_cache', '.next', '.cache', '.beat-attachments']);
export function snapshot(dir, limit = 20000) {
  const files = new Map();
  let truncated = false, incomplete = false;
  const walk = d => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { incomplete = true; return; }
    // 固定排序：两次快照必须按同一顺序截断，否则截断点漂移会把没动过的文件当成新增/删除。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (files.size >= limit) { truncated = true; return; }
      const full = path.join(d, e.name);
      // 符号链接/目录联接不跟随：历史测试目录里出现过自引用的 junction，跟随会把快照撑到几百 MB。
      if (e.isSymbolicLink()) continue;
      const relative = path.relative(dir, full);
      if (relative.length > 1024) { truncated = true; continue; }
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); }
      else if (e.isFile()) { try { const s = fs.statSync(full); files.set(relative, `${s.size}:${s.mtimeMs}`); } catch { incomplete = true; } }
    }
  };
  walk(dir);
  Object.defineProperty(files, 'truncated', { value: truncated, enumerable: false });
  Object.defineProperty(files, 'incomplete', { value: incomplete, enumerable: false });
  return files;
}
export function diffSnapshots(before, after) {
  const added = [], modified = [], deleted = [];
  for (const [f, sig] of after) { if (!before.has(f)) added.push(f); else if (before.get(f) !== sig) modified.push(f); }
  for (const f of before.keys()) if (!after.has(f)) deleted.push(f);
  return { added, modified, deleted, truncated: before?.truncated === true || after?.truncated === true, incomplete: before?.incomplete === true || after?.incomplete === true };
}
export function describeChanges(c) {
  const lines = [...c.added.map(f => '新增 ' + f), ...c.modified.map(f => '修改 ' + f), ...c.deleted.map(f => '删除 ' + f)];
  return lines.length ? lines.slice(0, 200).join('\n') + (lines.length > 200 ? `\n…共 ${lines.length} 项` : '') : '（未检测到文件变化）';
}
// 给无法读盘的审核方（Claude API）附上变化文件内容，限量并跳过二进制。
export function changedContents(dir, c, budget = 80000) {
  let out = '';
  for (const f of [...c.added, ...c.modified]) {
    if (out.length >= budget) { out += '\n…（其余文件内容已省略）'; break; }
    let buf; try { buf = fs.readFileSync(path.join(dir, f)); } catch { continue; }
    if (buf.includes(0)) { out += `\n--- ${f}（二进制，${buf.length} 字节）\n`; continue; }
    out += `\n--- ${f}\n${buf.toString('utf8').slice(0, Math.max(2000, budget - out.length))}\n`;
  }
  return out || '（无文本内容）';
}
