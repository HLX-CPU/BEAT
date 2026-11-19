import test from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../src/orchestrator.mjs';
import { assertNetworkReady, configuredProxy, proxyDownMessage, proxyStatus, resetNetworkGuardCache } from '../src/network-guard.mjs';
import { customerIssue } from '../src/customer-issue.mjs';

const ENV_KEYS = ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy'];
function withProxyEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  resetNetworkGuardCache();
  return Promise.resolve().then(fn).finally(() => {
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    resetNetworkGuardCache();
  });
}

test('没有代理环境变量时不干预（直连）', async () => {
  await withProxyEnv({}, async () => {
    assert.equal(configuredProxy(process.env), null);
    const status = await proxyStatus();
    assert.equal(status.configured, false);
    await assertNetworkReady();
  });
});

test('代理没在监听：报「网络代理没开」并给下一步，而不是 ECONNREFUSED', async () => {
  await withProxyEnv({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' }, async () => {
    const status = await proxyStatus({ probe: async () => false });
    assert.deepEqual({ configured: status.configured, alive: status.alive }, { configured: true, alive: false });
    await assert.rejects(assertNetworkReady({ probe: async () => false }), (error) => {
      assert.equal(error.code, 'NETWORK_PROXY_DOWN');
      assert.match(error.message, /网络代理暂时不可用/);
      assert.match(error.message, /系统代理/);
      assert.match(error.message, /无需重启/);
      assert.doesNotMatch(error.message, /请关闭 BEAT|重新启动一次/);
      return true;
    });
  });
});

test('代理正常时放行；人话提示带出代理地址', async () => {
  await withProxyEnv({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:7877' }, async () => {
    const status = await assertNetworkReady({ probe: async () => true });
    assert.equal(status.alive, true);
    assert.match(proxyDownMessage('http://127.0.0.1:7877'), /127\.0\.0\.1:7877/);
  });
});

test('模型调用前先查网络出口：代理中途被关掉时不再把调用当普通失败重试', async () => {
  await withProxyEnv({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' }, async () => {
    const orch = { guard() {} };
    await assert.rejects(
      () => Orchestrator.prototype.controlCall.call(orch, { id: 'R1' }, { seat: 'codex', signal: new AbortController().signal }),
      (error) => error.code === 'NETWORK_PROXY_DOWN' && /网络代理暂时不可用/.test(error.message),
    );
  });
});

test('任务失败提示：网络代理没开单独成标题，消息保留可执行的下一步', () => {
  const issue = customerIssue('网络代理没开：BEAT 启动时读取到系统代理（http://127.0.0.1:7877），但它现在没有在监听。请打开系统代理后再试。');
  assert.equal(issue.title, '网络代理没开');
  assert.match(issue.message, /打开系统代理/);
  assert.doesNotMatch(issue.message, /ECONNREFUSED|fetch failed/);
});
