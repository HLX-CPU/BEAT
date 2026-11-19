import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { codexExecutable, redact, VERSION } from './config.mjs';
import { killTree, onLines } from './proc.mjs';

// Codex 桌面端（ChatGPT/Codex 应用）自己启动 app-server 时会带上它自己的工具环境：
// code mode host、prefer_mxc，以及内置插件 MCP（codex_app / code-review）。
// 只跑 `app-server` 会让原生搭档缺少这些桌面端自带的工具（R123 实测：模型找不到任何"打开本机应用"的手段，
// 只能如实说缺少接口）。这里优先沿用正在运行的桌面端 app-server 的参数（跟随版本自动更新），
// 运行中取不到时用本机实测过的默认值。不会覆盖 BEAT 自己设置的 approval_policy / sandbox。
export const DESKTOP_LAUNCH_DEFAULTS = [
  'features.code_mode_host=true',
  'features.prefer_mxc=true',
  'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true',
  'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true',
];

const desktopLaunchCache = { at: 0, flags: null };

export function desktopAppLaunchFlags({ spawnSync: run = spawnSync, cache = desktopLaunchCache, now = Date.now } = {}) {
  if (cache.flags && now() - cache.at < 60000) return cache.flags;
  let flags = null;
  if (process.platform === 'win32') {
    try {
      const script = `Get-CimInstance Win32_Process -Filter "Name='codex.exe'" | Where-Object { $_.CommandLine -match 'app-server' } | ForEach-Object { $_.CommandLine }`;
      const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const lines = String(r?.stdout || '').split(/\r?\n/).filter(Boolean);
      const found = [];
      for (const line of lines) {
        for (const m of line.matchAll(/(?:^|\s)-c\s+("[^"]+"|\S+)/g)) {
          const value = m[1].replace(/^"|"$/g, '');
          // 只继承桌面端自己的功能/插件开关；BEAT 的审批与沙箱由自己下发。
          if (/^(?:features|plugins)\./.test(value) && !found.includes(value)) found.push(value);
        }
      }
      if (found.length) flags = found;
    } catch { flags = null; }
  }
  cache.at = now(); cache.flags = flags || DESKTOP_LAUNCH_DEFAULTS;
  return cache.flags;
}

export async function codexRPC(config, { cwd = config.workspace, logFile, onNotification = () => {}, spawnProcess = spawn, desktopFlags = null } = {}) {
  const home = config.codex.home;
  const args = ['app-server', '--listen', 'stdio://', '-c', 'approval_policy="never"'];
  // 沿用桌面端自己的工具环境（插件 MCP、code mode host）。desktopFlags=false 可显式关掉（测试用）。
  const inherited = Array.isArray(desktopFlags) ? desktopFlags : desktopFlags === false ? [] : desktopAppLaunchFlags();
  for (const flag of inherited) args.push('-c', flag);
  // Inherit the desktop's MCP and skills. BEAT filters its assistant tools
  // for native actors; disabling the entire MCP also hid collaboration tools.
  if (process.platform === 'win32') args.push('-c', `windows.sandbox=${JSON.stringify(config.codex.windowsSandbox || 'unelevated')}`);
  const env = { ...process.env, ...(home ? { CODEX_HOME: home } : {}), BEAT_CHILD: '1' };
  for (const k of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI']) delete env[k];
  const child = spawnProcess(codexExecutable(config), args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const log = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
  const pending = new Map(); let seq = 0, closed = false, fatal = null, stderr = '';
  const send = m => { if (!closed) child.stdin.write(JSON.stringify(m) + '\n'); };
  const fail = e => { fatal = e; for (const p of pending.values()) p.reject(e); pending.clear(); };
  const request = (method, params, ms = 60000) => new Promise((resolve, reject) => {
    if (fatal || closed) return reject(fatal || new Error('Codex 连接已关闭'));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('Codex 响应超时：' + method), { rpcMethod: method })); }, ms);
    pending.set(id, { method, resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } });
    send({ id, method, params });
  });
  onLines(child.stdout, line => {
    log?.write(redact(line, config) + '\n');
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && !m.method) {
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
      if (m.error) { const e = new Error(m.error.message || JSON.stringify(m.error)); e.rpcCode = m.error.code; e.rpcMethod = p.method; e.modelError = /model.*(invalid|unknown|not found|unsupported|not supported)|invalid.*model/i.test(e.message); p.reject(e); }
      else p.resolve(m.result);
    } else if (m.id !== undefined) send({ id: m.id, error: { code: -32000, message: '后台任务不提供人工确认' } });
    else onNotification(m);
  });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', s => { stderr = (stderr + s).slice(-8000); });
  child.stdin.on('error', () => {});
  child.on('error', e => fail(new Error('无法启动 Codex：' + e.message)));
  child.on('close', code => { closed = true; fail(new Error(`Codex 后台提前退出（${code}）：${redact(stderr.slice(-1500), config)}`)); onNotification({ method: 'beat/closed', error: fatal }); });
  const close = async () => { closed = true; fail(new Error('Codex 连接已关闭')); try { child.stdin.end(); } catch {} await killTree(child); log?.end(); };
  try {
    await request('initialize', { clientInfo: { name: 'beat', title: 'BEAT 三方协同', version: VERSION }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    return { request, close, pid:child.pid };
  } catch (e) { await close(); throw e; }
}
