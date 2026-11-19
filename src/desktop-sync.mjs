// 让桌面端会话列表实时出现 BEAT 后台创建的会话。失败只记日志，不影响任务本身。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveDeepseekRuntime } from './deepseek-runtime.mjs';

const pending = new Map(); // nativeId → 定时器（合并短时间内的多次通知）

function log(config, text) {
  try { fs.appendFileSync(path.join(config.dataDir, 'logs', 'desktop-sync.log'), `${new Date().toISOString()} ${text}\n`); } catch { /* 日志目录不可写时忽略 */ }
}

function registerDeepseek(config, sessions) {
  return new Promise(resolve => {
    const runtime = resolveDeepseekRuntime(config);
    const executable = runtime.executable || config.deepseek.executable;
    if (!executable) { resolve({ ok: false, error: '未找到 DeepSeek Harness 桌面端' }); return; }
    const child = spawn(executable, ['--expose-internals', path.join(config.root, 'src', 'deepseek-notify-child.mjs')], {
      cwd: config.root, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, ...(runtime.home || config.deepseek.home ? { DSH_HOME: runtime.home || config.deepseek.home } : {}), ELECTRON_RUN_AS_NODE: '1' },
    });
    let out = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop();
      try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: '无输出' }); }
    });
    child.stdin.end(JSON.stringify({ deepseekCli: runtime.cli || config.deepseek.cli, desktopPort: config.deepseek.desktopPort || 19387, sessions }));
  });
}

// Codex 桌面端没有对外的刷新接口，只能用 codex:// 链接让它打开新会话，列表随之出现（窗口会跳到该会话）。
// 只在桌面端正在运行时打开；每个会话只打开一次。看板「设置」里可关闭。
const openedCodex = new Set();
function codexDesktopRunning() {
  return new Promise(resolve => {
    const p = spawn('tasklist', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
    let out = ''; p.stdout.on('data', d => { out += d; });
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(/ChatGPT\.exe/i.test(out)));
  });
}
export async function syncCodexThread(config, threadId) {
  if (!threadId || config.flow?.codexOpenInDesktop === false || process.platform !== 'win32' || openedCodex.has(threadId)) return;
  openedCodex.add(threadId);
  if (!await codexDesktopRunning()) return log(config, `Codex 桌面端未运行，跳过打开 ${threadId}（下次启动时会出现在列表里）`);
  const url = 'codex://threads/' + encodeURIComponent(threadId);
  const p = spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' });
  p.on('error', e => log(config, `Codex 打开 ${threadId} 失败：${e.message}`));
  p.on('close', code => log(config, code === 0 ? `Codex 桌面端已打开 ${threadId}` : `Codex 打开 ${threadId} 退出码 ${code}`));
}

// 拿到会话号时、每轮结束时都会调用；1.5 秒内的重复通知合并成一次。
// 桌面端侧栏没有时钟，行上的时间只在该行收到事件时才重画，所以会话运行期间要持续发 activity。
const live = new Map(); // nativeId → { cwd, timer }

function beat(config, nativeId, cwd, { running, delayMs = 0 }) {
  const fire = async () => {
    const r = await registerDeepseek(config, [{ native_id: nativeId, cwd, running }]);
    if (!r.ok) log(config, `DeepSeek ${nativeId} 登记失败：${r.error}`);
    else if (r.mode === 'plugin-missing') log(config, `DeepSeek 桌面端未加载 BEAT 插件（先运行 setup 并重启一次 DeepSeek）`);
    else if (r.mode === 'live') log(config, `DeepSeek ${nativeId} 已同步到桌面端${running === true ? '（运行中，每分钟推进一次时间）' : running === false ? '（已结束）' : ''}`);
    else if (r.mode === 'offline') log(config, `DeepSeek 桌面端未运行，跳过 ${nativeId}`);
    return r;
  };
  if (delayMs > 0) setTimeout(fire, delayMs);
  else return fire();
}

export function syncDeepseekSession(config, nativeId, cwd, { delayMs = 1500, running } = {}) {
  if (!nativeId || config.desktopSync === false) return;
  // 会话结束（或这一轮结束）时停掉心跳，并把状态置回“不在运行”
  if (running === false) {
    const entry = live.get(nativeId);
    if (entry) { clearInterval(entry.timer); live.delete(nativeId); }
  }
  clearTimeout(pending.get(nativeId));
  pending.set(nativeId, setTimeout(async () => {
    pending.delete(nativeId);
    const r = await beat(config, nativeId, cwd, { running, delayMs: 0 });
    if (r?.mode === 'live' && running === true && !live.has(nativeId)) {
      // 运行期间每分钟推进一次时间，让列表里的“刚刚 / N 分钟”跟着走
      const timer = setInterval(() => { beat(config, nativeId, cwd, { running: true }); }, 60000);
      timer.unref?.();
      live.set(nativeId, { cwd, timer });
    }
  }, delayMs));
}

// 服务退出时收尾，避免留下“进行中”的行
export function stopDeepseekHeartbeats() {
  for (const [, entry] of live) clearInterval(entry.timer);
  live.clear();
}

