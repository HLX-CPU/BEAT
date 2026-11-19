// 在 DeepSeek 自带的 Electron Node 里运行（需要它内置的凭据模块）：用本机桌面端的登录授权，
// 调用桌面端插件的 /api/beat/register-history。桌面端没开就直接返回 offline（下次启动时它自己会列出会话）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, createHmac } from 'node:crypto';

async function main(input) {
  const runtime = path.resolve(path.dirname(input.deepseekCli), '../../../..');
  const native = (name, file = 'lib/index.js') => import(pathToFileURL(path.join(runtime, 'node_modules', '@deepseek-ai', name, file)).href);
  const origin = 'http://127.0.0.1:' + (input.desktopPort || 19387);
  try { await fetch(origin + '/', { method: 'HEAD', signal: AbortSignal.timeout(1500) }); }
  catch (e) { if (e.cause?.code === 'ECONNREFUSED') return { mode: 'offline' }; throw new Error('无法判断 DeepSeek 桌面端是否在线'); }
  // 只在内存里使用本机桌面端的 localhost 授权，不导出任何登录数据。
  const { resolveDshHome } = await native('dsh-home-paths');
  const { parseCredentialsDocument } = await native('dsh-credentials-local');
  const { credentialKey } = await native('dsh-credentials');
  const file = path.join(resolveDshHome(), '.credentials.yaml');
  const record = parseCredentialsDocument(await fs.readFile(file, 'utf8'), file).records.get(credentialKey('client-connection', 'browser-session'));
  if (record?.kind !== 'grant' || record.payload?.version !== 1) throw new Error('DeepSeek 本地登录授权格式不兼容');
  const secret = Buffer.from(record.payload.secret, 'base64url');
  const authority = new URL(origin).host, now = Date.now();
  const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 60000 })).toString('base64url');
  const cookie = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url') + '=v1.' + body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
  const r = await fetch(origin + '/api/beat/register-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ sessions: input.sessions }), signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) return { mode: 'plugin-missing' };
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return { mode: 'live', receipts: data.receipts };
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try { console.log(JSON.stringify({ ok: true, ...(await main(JSON.parse(raw))) })); process.exit(0); }
catch (e) { console.log(JSON.stringify({ ok: false, error: String(e.message).replace(/token=[^\s]+/g, 'token=[已隐去]') })); process.exit(1); }
