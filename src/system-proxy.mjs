// 系统代理：客户机器上开着代理（Clash / V2Ray 之类）时，浏览器能访问中转站，而 Node 直连会被墙。
// 实测 2026-10-17：客户的 modcon.top 直连 12 秒连不上，走系统代理 127.0.0.1:7877 一秒就回了 401。
// 这里只负责"读出系统代理 + 生成服务进程需要的环境变量"：
//   · Node 24 的 env proxy（NODE_USE_ENV_PROXY）只在进程启动时读取，所以必须在 spawn 时带上；
//   · 代理没在监听就返回 null → 服务照旧直连，绝不让探测失败把原本能用的直连搞坏。
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';

const LOCAL_BYPASS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];

// ProxyServer 可能是 "127.0.0.1:7877"，也可能是 "http=host:port;https=host:port;socks=..."。
// 只接受 HTTP 代理（Node 内建代理不吃 socks）；只有 socks 时按"没有可用代理"处理。
export function parseProxyServer(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const asUrl = address => {
    const [host, port] = String(address).trim().split(':');
    return host && /^\d+$/.test(port || '') ? 'http://' + host + ':' + port : null;
  };
  if (!text.includes('=')) {
    const url = asUrl(text);
    return url ? { http: url, https: url } : null;
  }
  const map = {};
  for (const part of text.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    if (!['http', 'https'].includes(key)) continue;   // socks 不支持
    const url = asUrl(part.slice(index + 1));
    if (url) map[key] = url;
  }
  return map.http || map.https ? { http: map.http || map.https, https: map.https || map.http } : null;
}

// ProxyOverride 里的 <local> / *.corp 转成 NO_PROXY；本地地址永远不走代理。
export function parseProxyOverride(value) {
  const out = new Set(LOCAL_BYPASS);
  for (const raw of String(value || '').split(';')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '<local>') { LOCAL_BYPASS.forEach(v => out.add(v)); continue; }
    if (entry.startsWith('*.')) out.add(entry.slice(1));
    else if (/^[a-z0-9*.-]+$/.test(entry)) out.add(entry);
  }
  return [...out].join(',');
}

function readWindowsRegistry({ execFileSync: exec = execFileSync } = {}) {
  try {
    const output = exec('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const value = name => new RegExp(name + '\\s+REG_\\w+\\s+(.*)').exec(String(output || ''))?.[1]?.trim() ?? '';
    return { enabled: value('ProxyEnable') === '0x1', server: value('ProxyServer'), override: value('ProxyOverride') };
  } catch { return null; }
}

export function probeHttpProxy(url, timeoutMs = 800) {
  let parsed; try { parsed = new URL(url); } catch { return Promise.resolve(false); }
  return new Promise(resolve => {
    const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port) || 80, timeout: timeoutMs });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

let cachedProxy;
export function resetProxyCache() { cachedProxy = undefined; }

// 返回 { source:'env'|'system', http, https, noProxy } 或 null（直连）。
export async function outboundProxy({ env = process.env, platform = process.platform, ttlMs = 5 * 60 * 1000,
  readRegistry = () => readWindowsRegistry(), probe = probeHttpProxy, cache = true } = {}) {
  // 运维/客户自己设了代理环境变量就照用（同样需要进程启动时带上）
  const envHttps = String(env.HTTPS_PROXY || env.https_proxy || '').trim();
  const envHttp = String(env.HTTP_PROXY || env.http_proxy || '').trim();
  if (envHttps || envHttp) {
    return { source: 'env', http: envHttp || envHttps, https: envHttps || envHttp, noProxy: String(env.NO_PROXY || env.no_proxy || LOCAL_BYPASS.join(',')) };
  }
  if (platform !== 'win32') return null;
  if (cache && cachedProxy && Date.now() - cachedProxy.at < ttlMs) return cachedProxy.value;
  let value = null;
  const registry = readRegistry();
  if (registry?.enabled) {
    const parsed = parseProxyServer(registry.server);
    if (parsed && await probe(parsed.https)) {
      value = { source: 'system', http: parsed.http, https: parsed.https, noProxy: parseProxyOverride(registry.override) };
    }
  }
  if (cache) cachedProxy = { at: Date.now(), value };
  return value;
}

// 服务进程的环境变量：Node 24 的 env proxy 只在进程启动时读取，所以必须在 spawn 时带上。
export function proxyProcessEnv(proxy, base = process.env) {
  const env = { ...base };
  if (!proxy) return env;
  env.NODE_USE_ENV_PROXY = '1';
  env.HTTP_PROXY = proxy.http;
  env.HTTPS_PROXY = proxy.https;
  env.NO_PROXY = proxy.noProxy || LOCAL_BYPASS.join(',');
  env.BEAT_PROXY_SOURCE = proxy.source || 'env';
  return env;
}

// 服务进程自己看到的网络出口（给看板显示用，不暴露代理认证信息）。
export function currentProxyStatus(env = process.env) {
  if (env.NODE_USE_ENV_PROXY !== '1') return null;
  const url = String(env.HTTPS_PROXY || env.HTTP_PROXY || '').trim();
  if (!url) return null;
  try { const parsed = new URL(url); return { url: parsed.protocol + '//' + parsed.host, noProxy: env.NO_PROXY || '' }; }
  catch { return { url, noProxy: env.NO_PROXY || '' }; }
}

let liveProxyKey;
// Reconfigure only at an idle boundary, before dispatching another task. This
// avoids replacing a dispatcher underneath a streaming model response.
export async function refreshSystemProxy({ env = process.env, isIdle = () => true,
  detect = outboundProxy, apply = value => http.setGlobalProxyFromEnv(value) } = {}) {
  if (!isIdle()) return { deferred:true };
  const inherited = { ...env };
  const explicit = env.BEAT_PROXY_SOURCE !== 'system' && !!(env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy);
  if (!explicit) for (const key of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy']) delete inherited[key];
  const proxy = await detect({env:inherited,cache:false});
  if (!isIdle()) return {deferred:true};
  const key = JSON.stringify(proxy || null);
  if (key === liveProxyKey) return {changed:false,proxy};
  if (typeof http.setGlobalProxyFromEnv !== 'function') throw new Error('当前运行环境暂不支持自动更新网络出口，已保留连接设置。');
  const noProxy = [...new Set([...LOCAL_BYPASS,...String(proxy?.noProxy || '').split(',')])].filter(Boolean).join(',');
  apply({http_proxy:proxy?.http || '',https_proxy:proxy?.https || '',no_proxy:noProxy});
  // Child native sessions inherit the current network, not a stale startup URL.
  if (!explicit) {
    for (const name of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy']) delete env[name];
    env.BEAT_PROXY_SOURCE = 'system';
    if (proxy) {env.HTTP_PROXY=proxy.http;env.HTTPS_PROXY=proxy.https;env.NO_PROXY=noProxy;env.NODE_USE_ENV_PROXY='1';}
    else delete env.NODE_USE_ENV_PROXY;
  }
  liveProxyKey=key;
  return {changed:true,proxy};
}

export function watchSystemProxy({isIdle,onError=()=>{},intervalMs=5000}={}) {
  let pending=null;
  const refresh=()=>{if(pending)return pending;pending=refreshSystemProxy({isIdle}).catch(onError).finally(()=>{pending=null;});return pending;};
  const timer=setInterval(refresh,intervalMs);timer.unref();
  return {refresh,stop:()=>clearInterval(timer)};
}
