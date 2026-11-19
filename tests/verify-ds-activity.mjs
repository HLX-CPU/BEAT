// 直接调用桌面端登记通道，确认 activity / status 事件真的被接受。
import { loadConfig } from '../src/config.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const config = loadConfig();
const run = (sessions) => new Promise(resolve => {
  const child = spawn(config.deepseek.executable, ['--expose-internals', path.join(config.root, 'src', 'deepseek-notify-child.mjs')], {
    cwd: config.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  child.on('close', () => { try { resolve({ ...JSON.parse(out.trim().split('\n').pop()), stderr: err.slice(-300) }); } catch { resolve({ ok: false, error: 'no output', out, err: err.slice(-500) }); } });
  child.stdin.end(JSON.stringify({ deepseekCli: config.deepseek.cli, desktopPort: 19387, sessions }));
});
const sid = process.argv[2];
if (!sid) { console.log('用法: node tests/verify-ds-activity.mjs <session-xxx> [cwd]'); process.exit(1); }
const cwd = process.argv[3] || config.workspace;
console.log('running=true :', JSON.stringify(await run([{ native_id: sid, cwd, running: true }])));
await new Promise(r => setTimeout(r, 1000));
console.log('running=false:', JSON.stringify(await run([{ native_id: sid, cwd, running: false }])));
process.exit(0);
