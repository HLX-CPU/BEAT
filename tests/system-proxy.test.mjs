// 系统代理：客户开着 Clash/V2Ray 时，浏览器能访问被墙的中转站，Node 直连不能。
// 服务进程启动时把系统代理写进环境（Node 的 env proxy 只在进程启动时读取），代理没开就直连。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseProxyServer, parseProxyOverride, outboundProxy, proxyProcessEnv, currentProxyStatus } from '../src/system-proxy.mjs';
import { loadConfig } from '../src/config.mjs';
import { TOOLS } from '../src/tools.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

test('ProxyServer 两种写法都能解析；只有 socks 时按没有可用代理处理', () => {
  assert.deepEqual(parseProxyServer('127.0.0.1:7877'), { http: 'http://127.0.0.1:7877', https: 'http://127.0.0.1:7877' });
  assert.deepEqual(parseProxyServer('http=127.0.0.1:7877;https=127.0.0.1:7878;socks=127.0.0.1:7891'), { http: 'http://127.0.0.1:7877', https: 'http://127.0.0.1:7878' });
  assert.equal(parseProxyServer('socks=127.0.0.1:7891'), null);
  assert.equal(parseProxyServer(''), null);
  assert.equal(parseProxyServer('bad'), null);
});

test('ProxyOverride 转 NO_PROXY：本地地址永远直连，<local> 与通配都保留', () => {
  const noProxy = parseProxyOverride('<local>;*.corp.example').split(',');
  for (const host of ['localhost', '127.0.0.1', '::1', '0.0.0.0', '.corp.example']) assert.ok(noProxy.includes(host), host);
});

test('Windows 系统代理：开着且端口在监听才用；没开/代理没监听就直连', async () => {
  const base = { platform: 'win32', env: {}, cache: false };
  const on = await outboundProxy({ ...base, readRegistry: () => ({ enabled: true, server: '127.0.0.1:7877', override: '<local>' }), probe: async () => true });
  assert.equal(on.source, 'system');
  assert.equal(on.https, 'http://127.0.0.1:7877');
  assert.match(on.noProxy, /127\.0\.0\.1/);
  const off = await outboundProxy({ ...base, readRegistry: () => ({ enabled: false, server: '127.0.0.1:7877', override: '' }), probe: async () => true });
  assert.equal(off, null);
  const dead = await outboundProxy({ ...base, readRegistry: () => ({ enabled: true, server: '127.0.0.1:7877', override: '' }), probe: async () => false });
  assert.equal(dead, null, '代理没在监听时必须保持直连，不能把原本能用的直连搞坏');
  const nonWindows = await outboundProxy({ platform: 'linux', env: {}, cache: false, readRegistry: () => ({ enabled: true, server: '127.0.0.1:7877' }), probe: async () => true });
  assert.equal(nonWindows, null);
});

test('运维自己设的代理环境变量优先于系统代理', async () => {
  const proxy = await outboundProxy({ platform: 'win32', env: { HTTPS_PROXY: 'http://10.0.0.9:3128' }, cache: false, readRegistry: () => null, probe: async () => false });
  assert.equal(proxy.source, 'env');
  assert.equal(proxy.https, 'http://10.0.0.9:3128');
});

test('服务进程环境：有代理才开 NODE_USE_ENV_PROXY，没有就原样直连', () => {
  const withProxy = proxyProcessEnv({ http: 'http://127.0.0.1:7877', https: 'http://127.0.0.1:7877', noProxy: 'localhost,127.0.0.1' }, { PATH: 'x' });
  assert.equal(withProxy.NODE_USE_ENV_PROXY, '1');
  assert.equal(withProxy.HTTPS_PROXY, 'http://127.0.0.1:7877');
  assert.equal(withProxy.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(withProxy.PATH, 'x');
  const direct = proxyProcessEnv(null, { PATH: 'x' });
  assert.equal(direct.NODE_USE_ENV_PROXY, undefined);
  assert.equal(direct.HTTP_PROXY, undefined);
});

test('看板显示当前出口时隐藏代理账号密码', () => {
  assert.equal(currentProxyStatus({}), null);
  assert.deepEqual(currentProxyStatus({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://user:pass@127.0.0.1:7877', NO_PROXY: 'localhost' }), { url: 'http://127.0.0.1:7877', noProxy: 'localhost' });
});

test('设置接口把当前网络出口告诉看板（测试进程没有代理时为直连）', async t => {
  const root = cleanup(t, tempDir('proxy-settings'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ workspace: root }));
  const view = await TOOLS.settings_get.run({ config: loadConfig(root) }, {});
  assert.equal(view.network.proxy, null);
});
