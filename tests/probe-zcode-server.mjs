// 诊断：真实 CLI 全流程逐条打印（create/setModel/send/terminal）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { detectZcodeRuntime, readMachineModelSelection } from '../src/zcode.mjs';
import { loadConfig } from '../src/config.mjs';

const config = loadConfig('E:/beat');
const runtime = detectZcodeRuntime(config);
console.log('runtime:', JSON.stringify({ cli: runtime.cli, personalConfigFile: runtime.personalConfigFile }));
console.log('machine selection:', JSON.stringify(readMachineModelSelection(runtime)));

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-diag-'));
const child = spawn(process.execPath, [runtime.cli, 'app-server'], { cwd: workdir, env: { ...process.env, ...(runtime.dataBaseDir ? { ZCODE_DATA_BASE_DIR: runtime.dataBaseDir } : {}) } });
let buf = '';
const transcript = [];
child.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { transcript.push(JSON.parse(line)); } catch {}
  }
  for (const r of transcript.filter(x => x.method && x.id !== undefined && !x.answered)) {
    r.answered = true;
    if (r.method === 'session/requestRuntimePreferences') child.stdin.write(JSON.stringify({ id: r.id, result: { nativeSearchEnhancementsEnabled: false, toolSearchMode: 'off', memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1', additionalDirectories: [] } }) + '\n');
    else if (r.method === 'interaction/requestOfficialMcpAuthHeaders' || r.method === 'interaction/requestProviderRuntimeHeaders') child.stdin.write(JSON.stringify({ id: r.id, result: { ok: false, reason: 'official_auth_unavailable' } }) + '\n');
    else child.stdin.write(JSON.stringify({ id: r.id, result: {} }) + '\n');
  }
});
const call = (method, params, timeoutMs = 30_000) => new Promise(resolve => {
  const id = 'diag-' + Math.random().toString(36).slice(2);
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  const t0 = Date.now();
  const timer = setInterval(() => {
    const hit = transcript.find(t => t.id === id);
    if (hit) { clearInterval(timer); resolve(hit); }
    else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); resolve({ timeout: true, method }); }
  }, 40);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

await sleep(1500);
const refreshed = await call('provider/refreshRegistry', { reason: 'diag' });
console.log('refreshRegistry:', JSON.stringify(refreshed).slice(0, 400));
const created = await call('session/create', { workspace: { workspaceKey: 'diag', workspacePath: workdir } });
const sid = created.result?.session?.sessionId;
console.log('create:', sid ? 'ok ' + sid : JSON.stringify(created).slice(0, 400));
console.log('model.available after refresh:', JSON.stringify(created.result?.settings?.model));

const sel = readMachineModelSelection(runtime);
const set = await call('session/setModel', { sessionId: sid, model: sel });
console.log('setModel:', JSON.stringify(set).slice(0, 700));

const read1 = await call('session/read', { sessionId: sid });
console.log('read after setModel — settings:', JSON.stringify(read1.result?.settings || read1.result?.session?.settings || null).slice(0, 500));

const sent = await call('session/send', { sessionId: sid, content: '只回复两个字母：OK' });
console.log('send:', JSON.stringify(sent).slice(0, 300));

const t0 = Date.now();
let terminal = null;
while (Date.now() - t0 < 120_000) {
  await sleep(300);
  terminal = transcript.find(x => x.method === 'v4/telemetry/event' && x.params?.kind === 'turn.terminal');
  if (terminal) break;
}
console.log('terminal:', terminal ? JSON.stringify(terminal.params).slice(0, 500) : '无');

const read2 = await call('session/read', { sessionId: sid });
const msgs = read2.result?.messages || [];
console.log('messages:', JSON.stringify(msgs.slice(-3)).slice(0, 1200));
const usage = await call('session/usage', { sessionId: sid });
console.log('usage:', JSON.stringify(usage.result).slice(0, 400));
child.kill('SIGKILL');
await sleep(300);
process.exit(0);
