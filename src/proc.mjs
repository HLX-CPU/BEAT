// 子进程收尾：Windows 上按进程树结束，避免残留后台进程。
import { spawn } from 'node:child_process';

export function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise(resolve => {
    const done = setTimeout(resolve, 8000);
    child.once('close', () => { clearTimeout(done); resolve(); });
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
      else child.kill('SIGTERM');
    } catch { try { child.kill(); } catch { /* 已退出 */ } }
  });
}

// 按行读取 stdout（JSON 行协议）。
export function onLines(stream, fn) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0;) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) fn(line); }
    if (buf.length > 8_000_000) buf = '';
  });
  stream.on('end', () => { if (buf.trim()) fn(buf.trim()); });
}

export function abortError(signal) {
  const e = new Error(signal?.reason?.message || '已取消');
  e.cancelled = true;
  return e;
}
