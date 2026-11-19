// 网络出口守卫：BEAT 在启动服务时把「系统代理」写进进程环境（Node 只在启动时读取代理设置）。
// 客户中途关掉 Clash/换端口时，所有外网调用会瞬间 ECONNREFUSED，看起来像“所有模型全挂了”，
// 还会被当成一次普通失败继续重试、烧掉大量 token。这里统一探测并按人话报错。
import net from 'node:net';

export function configuredProxy(env = process.env) {
  if (env.NODE_USE_ENV_PROXY !== '1') return null;
  return String(env.HTTPS_PROXY || env.HTTP_PROXY || '').trim() || null;
}

export function probeTcp(url, timeoutMs = 600) {
  let parsed;
  try { parsed = new URL(url); } catch { return Promise.resolve(false); }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return new Promise(resolve => {
    const socket = net.connect({ host, port: Number(parsed.port) || 80, timeout: timeoutMs });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

let cache = { at: 0, key: '', value: null };
export function resetNetworkGuardCache() { cache = { at: 0, key: '', value: null }; }

export async function proxyStatus({ env = process.env, probe = probeTcp, cacheMs = 3000, now = Date.now } = {}) {
  const url = configuredProxy(env);
  if (!url) return { configured: false, alive: null, url: null };
  let parsed;
  try { parsed = new URL(url); } catch { return { configured: true, alive: false, url }; }
  const key = url + '|' + Math.floor(now() / Math.max(500, cacheMs));
  if (cache.key === key) return cache.value;
  const alive = await probe(url);
  const value = { configured: true, alive, url };
  cache = { at: now(), key, value };
  return value;
}

export function proxyDownMessage(url) {
  const where = url ? '（' + url + '）' : '';
  return '网络代理暂时不可用' + where + '。请确认代理软件已连接；BEAT 会在当前任务结束后自动重新检测系统代理，下一次请求使用新的出口，无需重启。已完成的文件和任务记录保留。';
}

export async function assertNetworkReady(options) {
  const status = await proxyStatus(options);
  if (status.configured && status.alive === false) {
    const error = new Error(proxyDownMessage(status.url));
    error.code = 'NETWORK_PROXY_DOWN';
    error.nonRetryable = true;
    throw error;
  }
  return status;
}
