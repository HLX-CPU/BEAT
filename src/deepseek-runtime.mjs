// 本机 DeepSeek Harness 桌面端的发现与运行路径解析。
//
// 目的：不把开发机的绝对路径写死到默认配置里。客户可能装在任何目录
// （默认用户目录、Program Files、D:\deepseek、自定义盘符），也可能已经从
// 桌面端登录过。这里统一做发现：安装位置（含注册表卸载项 / App Paths /
// 开始菜单快捷方式 / 正在运行的进程 / PATH）与登录配置（profiles/*/cordis.patch.yml）。
//
// 说明：桌面端不需要一直开着——BEAT 用无窗口方式自行拉起；但账号登录必须在
// 桌面端完成一次（登录态保存在本机）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEEPSEEK_EXE = 'DeepSeek Harness.exe';
export const DEEPSEEK_CLI_REL = ['resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'];
const FOLDER_NAMES = ['DeepSeek Harness', 'deepseek', 'DeepSeek'];
const PROFILE_REL = ['profiles', 'desktop', 'cordis.patch.yml'];

// 只做存在性判断，便于测试注入（不用真实文件系统）。
const lookup = (file, exists) => { try { return !!file && exists(file); } catch { return false; } };
const realFile = file => { try { return !!file && fs.statSync(file).isFile(); } catch { return false; } };
// CLI 可能位于 app.asar 内部：asar 是单个文件，只能检查 .asar 本身是否存在。
const hasCli = (file, exists) => { if (!file) return false; try { const asar = /^(.*?\.asar)(?:[\\/]|$)/i.exec(String(file))?.[1] || file; return !!exists(asar); } catch { return false; } };
const norm = p => String(p || '').replace(/\\/g, '/').toLowerCase();

const PS_DISCOVER = String.raw`
$out = New-Object System.Collections.ArrayList
function Add-Exe($p) {
  if ($p) {
    $x = ([string]$p).Trim().Trim([char]34)
    if ($x -match '\.exe$') { [void]$out.Add($x) }
  }
}
$keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
foreach ($k in $keys) {
  Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'DeepSeek' } | ForEach-Object {
    if ($_.InstallLocation) { Add-Exe (Join-Path $_.InstallLocation 'DeepSeek Harness.exe') }
    if ($_.DisplayIcon) { Add-Exe ($_.DisplayIcon -replace ',\d+$','') }
  }
}
foreach ($k in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\DeepSeek Harness.exe','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\DeepSeek Harness.exe')) {
  try { $v = (Get-ItemProperty $k -ErrorAction Stop).'(default)'; if ($v) { Add-Exe $v } } catch { }
}
$ws = New-Object -ComObject WScript.Shell -ErrorAction SilentlyContinue
if ($ws) {
  foreach ($dir in @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'), (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'))) {
    Get-ChildItem $dir -Recurse -Filter '*DeepSeek*.lnk' -ErrorAction SilentlyContinue | ForEach-Object { try { Add-Exe ($ws.CreateShortcut($_.FullName).TargetPath) } catch { } }
  }
}
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue | ForEach-Object { if ($_.ExecutablePath) { Add-Exe $_.ExecutablePath } }
$c = Get-Command 'DeepSeek Harness.exe' -ErrorAction SilentlyContinue
if ($c) { Add-Exe $c.Source }
$out | Where-Object { $_ } | Select-Object -Unique | ConvertTo-Json -Compress
`;

// 系统级发现（注册表/快捷方式/进程/PATH）走一次 PowerShell，结果缓存 60 秒：
// roster.state() 每次刷新都会调用，不能每次都起进程。
let systemCache = { at: 0, paths: [] };
export function resetDeepseekDiscovery() { systemCache = { at: 0, paths: [] }; }

export function systemDeepseekInstalls({ platform = process.platform, spawn = spawnSync, useCache = true } = {}) {
  if (platform !== 'win32') return [];
  if (useCache && Date.now() - systemCache.at < 60_000) return systemCache.paths;
  let paths = [];
  try {
    const probe = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_DISCOVER], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const text = String(probe.stdout || '').trim();
    if (text) { const parsed = JSON.parse(text); paths = (Array.isArray(parsed) ? parsed : [parsed]).filter(p => typeof p === 'string' && p); }
  } catch { paths = []; }
  if (useCache) systemCache = { at: Date.now(), paths };
  return paths;
}

/** 可能安装 DeepSeek Harness 的位置（不检查存在性，便于测试与展示）。 */
export function deepseekInstallCandidates(config = {}, env = process.env, { systemInstalls = systemDeepseekInstalls } = {}) {
  const list = [];
  const add = p => { if (p && !list.some(x => norm(x) === norm(p))) list.push(p); };
  add(config.deepseek?.executable);
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  for (const base of [path.join(local, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA, env.ProgramData].filter(Boolean)) {
    for (const folder of FOLDER_NAMES) add(path.join(base, folder, DEEPSEEK_EXE));
  }
  for (const p of systemInstalls() || []) add(p);
  return list;
}

/** 可能存放桌面端登录配置的位置（按优先级，first existing wins）。 */
export function deepseekProfileCandidates(config = {}, env = process.env, executable = '') {
  const out = [];
  const add = p => { if (p && !out.some(x => norm(x) === norm(p))) out.push(p); };
  if (config.deepseek?.profileFile) add(config.deepseek.profileFile);
  const roots = [];
  const exeDir = executable ? path.dirname(executable) : '';
  for (const root of [config.deepseek?.home, env.DSH_HOME, path.join(os.homedir(), '.dsh'), exeDir ? path.join(exeDir, 'dsh-data') : '']) {
    if (root && !roots.some(x => norm(x) === norm(root))) roots.push(root);
  }
  for (const root of roots) {
    add(path.join(root, ...PROFILE_REL));
    try {
      for (const sub of fs.readdirSync(path.join(root, 'profiles'))) {
        add(path.join(root, 'profiles', sub, 'cordis.patch.yml'));
      }
    } catch { /* 没有 profiles 目录就跳过 */ }
  }
  return out;
}

/** 解析本机 DeepSeek 运行时：安装位置、后台执行组件、登录配置。 */
/**
 * 查找原生会话时使用的 DSH 根目录候选。客户可能换启动方式/重启服务，让 DSH_HOME 变了；
 * 会话实际存在哪个 home 要以文件为准，不能只信当前进程环境。优先显式配置和当前登录目录，再用户默认目录。
 */
export function deepseekHomeCandidates(config = {}, env = process.env) {
  const out = [];
  const add = p => { if (p && !out.some(x => norm(x) === norm(p))) out.push(p); };
  add(config.deepseek?.home);
  add(env.DSH_HOME);
  add(path.join(os.homedir(), '.dsh'));
  return out;
}

/**
 * 找到某个原生会话真正所在的 DSH 根目录。DeepSeek 的会话目录形如
 * <home>/sessions/<编码后的工作目录>/<session-id>/session.v4.jsonl.zstd。
 * 只读文件系统、不联网、不执行模型；找不到返回 null，绝不猜。
 */
export function findDeepseekSessionHome(nativeId, { config = {}, env = process.env } = {}) {
  const id = String(nativeId || '');
  if (!/^[\w.-]+$/.test(id)) return null;
  for (const home of deepseekHomeCandidates(config, env)) {
    let dirs;
    try { dirs = fs.readdirSync(path.join(home, 'sessions'), { withFileTypes: true }).filter(entry => entry.isDirectory()); } catch { continue; }
    for (const dir of dirs) {
      try { if (fs.existsSync(path.join(home, 'sessions', dir.name, id))) return home; } catch { /* keep scanning */ }
    }
  }
  return null;
}

export function detectDeepseekRuntime(config = {}, env = process.env, deps = {}) {
  const { exists = fs.existsSync, systemInstalls = systemDeepseekInstalls } = deps;
  const candidates = deepseekInstallCandidates(config, env, { systemInstalls });
  const executable = candidates.find(p => lookup(p, exists)) || '';
  const cliCandidates = [];
  if (config.deepseek?.cli) cliCandidates.push(config.deepseek.cli);
  if (executable) cliCandidates.push(path.join(path.dirname(executable), ...DEEPSEEK_CLI_REL));
  const cli = cliCandidates.find(p => hasCli(p, exists)) || '';
  const profileCandidates = deepseekProfileCandidates(config, env, executable);
  const profileFile = profileCandidates.find(p => { try { return exists(p); } catch { return false; } }) || '';
  // 登录配置在 <home>/profiles/<配置名>/cordis.patch.yml；把 home 一并带回去，
  // 调起无窗口执行时 DSH_HOME 才能指向同一个登录目录。
  let home = config.deepseek?.home || env.DSH_HOME || '';
  const marker = profileFile ? profileFile.replace(/\\/g, '/').lastIndexOf('/profiles/') : -1;
  if (marker > 0) home = profileFile.replace(/\\/g, '/').slice(0, marker).replace(/\//g, path.sep);
  return { executable, cli, home, profileCandidates, profileFile, cliCandidates, installCandidates: candidates };
}

/** 生成可直接合并进 config.deepseek 的运行时字段（调用方用来无窗口拉起桌面端）。 */
export function resolveDeepseekRuntime(config) {
  const runtime = detectDeepseekRuntime(config);
  return { executable: runtime.executable, cli: runtime.cli, home: runtime.home, profileFile: runtime.profileFile, profileCandidates: runtime.profileCandidates };
}

/** 把发现结果补进配置（只填空的/失效项，客户显式配置优先），供实际调用使用。 */
export function applyDeepseekRuntime(config, env = process.env, deps = {}) {
  if (!config || !config.deepseek) return false;
  const runtime = detectDeepseekRuntime(config, env, deps);
  let changed = false;
  if (runtime.executable && (!config.deepseek.executable || !realFile(config.deepseek.executable))) { config.deepseek.executable = runtime.executable; changed = true; }
  if (runtime.cli && !hasCli(config.deepseek.cli, fs.existsSync)) { config.deepseek.cli = runtime.cli; changed = true; }
  if (runtime.profileFile && !config.deepseek.profileFile) { config.deepseek.profileFile = runtime.profileFile; changed = true; }
  if (runtime.home && !config.deepseek.home) { config.deepseek.home = runtime.home; changed = true; }
  return changed;
}
