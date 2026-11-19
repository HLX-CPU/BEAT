import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeepseekParser } from '../src/deepseek.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { onLines } from '../src/proc.mjs';
import { startServer } from '../src/server.mjs';
import { loadConfig, VERSION } from '../src/config.mjs';
import {ensureService}from '../src/client.mjs';
import { Models } from '../src/models.mjs';
import { MCP_TOOLS } from '../src/tools.mjs';
import http from 'node:http';

process.env.BEAT_SETUP_IMPORT_ONLY = '1';
const { rewriteCodexToml, rewriteDeepseekPatch } = await import('../src/setup.mjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('MCP：initialize 与 tools/list（不需要服务）', async () => {
  const child = spawn(process.execPath, [path.join(root, 'src', 'mcp.mjs'), '--as', 'deepseek'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  exited.catch(() => {});
  child.stdin.on('error', () => {});
  onLines(child.stdout, l => lines.push(JSON.parse(l)));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  for (let i = 0; i < 100 && lines.length < 2; i++) await new Promise(r => setTimeout(r, 30));
  child.stdin.end();
  assert.equal(await exited, 0, 'MCP process must finish successfully');
  assert.equal(lines[0].result.serverInfo.name, 'beat');
  const names = lines[1].result.tools.map(t => t.name);
  for (const n of ['beat_discuss','beat_parallel','beat_ask','beat_get','beat_list','beat_cancel','beat_resume','beat_agents','beat_status','model_list','session_set_model','beat_sessions','dock_list']) assert.ok(names.includes(n), 'MCP 原工具不得缺失：' + n);
  for (const n of ['desktop_start','desktop_get','desktop_list','desktop_cancel','desktop_confirm','desktop_emergency_stop']) {
    assert.ok(MCP_TOOLS.some(t => t.name === n), 'MCP desktop 工具必须注册：' + n);
    // 2026-10-09 用户确认的分工：原生搭档（Codex/DeepSeek）用自己的桌面端工具，
    // BEAT 电脑助手只给拓展坞/看板通道，因此不出现在原生 actor 的 tools/list 里。
    assert.ok(!names.includes(n), '原生搭档的 MCP 列表不得出现电脑助手工具：' + n);
  }
  assert.ok(names.includes('beat_parallel') && names.includes('beat_ask'), '原生搭档的协同工具保留');
});

test('model/session interfaces are exposed with the agreed schemas', () => {
  const tools = Object.fromEntries(MCP_TOOLS.map(t => [t.name, t]));
  assert.equal(tools.beat_ask.inputSchema.properties.model.type, 'string');
  assert.deepEqual(tools.model_list.inputSchema.required, ['provider']);
  assert.deepEqual(tools.session_set_model.inputSchema.required, ['session_id', 'model']);
  assert.equal(tools.beat_sessions.inputSchema.properties.limit.type, 'number');
});

test('HTTP fixed module route, MIME, no-store, CSP, Host/Origin, file whitelist and snapshot API', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-interface-'));
  fs.mkdirSync(path.join(dir, 'web')); fs.mkdirSync(path.join(dir, 'workspaces/shared'), { recursive: true });
  // Route fixture only: actual UI mounting is tested by DeepSeek's UI suite.
  fs.writeFileSync(path.join(dir, 'web/index.html'), '<html><script type="module" src="/sessions-panel.mjs"></script></html>');
  fs.writeFileSync(path.join(dir, 'web/sessions-panel.mjs'), 'export const fixture = true;');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ codex: { defaultModel: 'mock-codex' }, deepseek: { defaultModel: 'mock-deepseek' } }));
  fs.writeFileSync(path.join(dir, 'secrets.local.json'), JSON.stringify({ token: 'fixture' }));
  const config = loadConfig(dir);
  const models = new Models(config, { capabilities: {}, catalog: async p => ({ source: 'mock', models: [{ id: 'mock-' + p, name: p, availability: 'configured' }] }) });
  const svc = await startServer({ config, models, agents: {}, port: 0 });
  t.after(async () => { await new Promise(r => svc.server.close(r)); svc.store.close(); });
  const base = 'http://127.0.0.1:' + svc.port;
  const health=await(await fetch(base+'/health')).json();
  // /health 的三个版本字段各司其职，不要再混用（买家实测指出过三处版本号互不一致）：
  //   version                —— 产品版本，给人看的
  //   apiCompatibilityVersion —— 已连上的旧版 MCP 所依赖的线上契约版本
  //   actualVersion          —— 兼容判据；客户端用 actualVersion || version 判断是否需要升级
  assert.equal(health.version,VERSION,'version reports the product version');
  assert.equal(health.apiCompatibilityVersion,'2.1.0','legacy wire contract is reported by apiCompatibilityVersion');
  assert.equal(health.actualVersion,VERSION);
  assert.equal(await ensureService({...config,port:svc.port}),base,'modern client reads actualVersion and retains the live compatible service');
  const module = await fetch(base + '/sessions-panel.mjs'); assert.equal(module.status, 200);
  assert.equal(module.headers.get('content-type'), 'text/javascript; charset=utf-8'); assert.equal(module.headers.get('cache-control'), 'no-store');
  assert.equal(await module.text(), 'export const fixture = true;');
  const index = await fetch(base); assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
  for (const name of ['/config.json', '/src/store.mjs', '/sessions-panel.mjs?file=config.json', '/web/sessions-panel.mjs', '/%2e%2e/config.json']) assert.equal((await fetch(base + name)).status, 404);
  assert.equal((await fetch(base + '/sessions-panel.mjs', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = http.get(base + '/sessions-panel.mjs', { headers: { Host: 'foreign.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
  });
  assert.equal(badHost, 403);
  const call = async (name, args = {}) => (await (await fetch(base + '/api/call', { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args }) })).json());
  assert.equal((await call('model_list', { provider: 'codex' })).result.models[0].id, 'mock-codex');
  const list = (await call('beat_sessions')).result; assert.deepEqual(list.items, []);
  assert.equal((await call('overview')).result.sessionsRevision, list.revision);
  assert.equal((await fetch(base + '/api/call', { method: 'POST', body: '{}' })).status, 401);
});

test('DeepSeek 事件解析', () => {
  const p = createDeepseekParser();
  for (const e of [{ type: 'session', sessionId: 'session-abc' }, { type: 'text', text: '你' }, { type: 'text', text: '好' }, { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }]) p.push(JSON.stringify(e));
  assert.deepEqual([p.result().sessionId, p.result().text, p.result().errors.length], ['session-abc', '你好', 0]);
  const q = createDeepseekParser();
  q.push(JSON.stringify({ type: 'final', text: '最终' })); q.push('not json');
  assert.equal(q.result().text, '最终');
});

test('Codex 配置改写：移除旧 beat/bridge，追加新 beat，可重复执行', () => {
  const before = `model = "gpt-6.1-sol"\n\n[mcp_servers.node_repl]\ncommand = 'x'\n\n[mcp_servers.node_repl.env]\nA = "1"\n\n[mcp_servers.bridge]\ncommand = 'node'\nargs = ['E:\\\\beat\\\\bridge\\\\bin\\\\mcp.cjs']\n\n[mcp_servers.beat]\ncommand = "node"\n\n[mcp_servers.beat.env]\nX = "1"\n`;
  const once = rewriteCodexToml(before);
  assert.doesNotMatch(once, /bridge/);
  assert.equal(once.match(/\[mcp_servers\.beat\]/g).length, 1);
  assert.match(once, /\[mcp_servers\.node_repl\.env\]\nA = "1"/);
  assert.match(once, /tool_timeout_sec = 600/);
  assert.equal(rewriteCodexToml(once), once);
});

test('DeepSeek 桌面补丁改写：旧 beat 条目换成新的（MCP + 会话实时登记插件），其余保留', () => {
  const before = `# 头部注释\n- id: ui-settings\n  config:\n    enabled: true\n- insert:\n    - id: mcp-beat\n      config:\n        args: [ "E:/beat/src/mcp.mjs" ]\n\n# Native sidebar registration\n- insert:\n    - id: beat-desktop-history\n      name: "file:///E:/beat/src/deepseek-sidebar-plugin.mjs"\n- id: mcp-beat\n  disabled: false\n\n# BEAT history source reload\n- id: hmr\n  config:\n    root:\n      [\n        "E:/beat/src/deepseek-sidebar-core.mjs"\n      ]\n- id: llm-deepseek-account\n  config:\n    models:\n      - id: deepseek-flash\n        description: 多行\n          续行\n`;
  const once = rewriteDeepseekPatch(before);
  assert.match(once, /^# 头部注释\n- id: ui-settings/);
  assert.doesNotMatch(once, /sidebar-core|disabled: false|BEAT history source reload/);
  assert.equal(once.match(/id: beat-desktop-history/g).length, 1);
  assert.match(once, /deepseek-sidebar-plugin\.mjs\?v=[0-9a-f]{12}/);
  assert.equal(once.match(/^- id: hmr$/gm).length, 1);
  assert.match(once, /- id: llm-deepseek-account[\s\S]*续行/);
  assert.equal(once.match(/id: mcp-beat/g).length, 1);
  assert.match(once, /"--as", "deepseek"/);
  assert.equal(rewriteDeepseekPatch(once), once);
});

// Staged desktop registration regression.
test('desktop MCP entrypoints preserve existing tools', async()=>{ const {MCP_TOOLS}=await import('../src/tools.mjs'); for(const name of ['desktop_start','desktop_get','desktop_list','desktop_cancel','desktop_confirm','desktop_emergency_stop']) assert.ok(MCP_TOOLS.some(t=>t.name===name), name); for(const name of ['beat_ask','dock_list','beat_discuss','model_list','session_set_model']) assert.ok(MCP_TOOLS.some(t=>t.name===name), name); });
