// 拓展坞超时设置：能存能读、非法值拒绝、而且真的驱动 dock 的超时行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig, saveSettings } from '../src/config.mjs';
import { chatDock } from '../src/dock.mjs';

const tmpRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ workspace: dir, flow: {} }));
  return dir;
};

test('拓展坞超时设置：保存后能读回，0 表示不限', () => {
  const root = tmpRoot();
  const cfg = loadConfig(root);
  assert.equal(cfg.flow.dockTimeoutMin, 30, '默认 30 分钟');
  assert.equal(cfg.flow.dockStallSec, 90, '默认 90 秒');
  saveSettings(cfg, { flow: { dockTimeoutMin: 45, dockStallSec: 120 } });
  const cfg2 = loadConfig(root);
  assert.equal(cfg2.flow.dockTimeoutMin, 45);
  assert.equal(cfg2.flow.dockStallSec, 120);
  saveSettings(cfg2, { flow: { dockTimeoutMin: 0 } });
  assert.equal(loadConfig(root).flow.dockTimeoutMin, 0, '0 = 不限也要能存下来');
});

test('拓展坞超时设置：非法值拒绝且不改原配置', () => {
  const root = tmpRoot();
  const cfg = loadConfig(root);
  saveSettings(cfg, { flow: { dockTimeoutMin: 20, dockStallSec: 60 } });
  const before = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
  for (const bad of [{ dockTimeoutMin: -1 }, { dockStallSec: 0 }, { dockStallSec: -5 }, { dockTimeoutMin: 'abc' }]) {
    assert.throws(() => saveSettings(loadConfig(root), { flow: bad }), /必须/, JSON.stringify(bad) + ' 应被拒绝');
    assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), before, '非法值不能写进配置');
  }
});

test('设置真的驱动 dock：卡住阈值来自设置，且整体超时可为不限', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders?.(); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const config = { flow: { dockStallSec: 1, dockTimeoutMin: 0 }, dock: [{ id: 'dock:t', name: '测试模型', model: 'm', baseUrl: base, enabled: true }], secrets: { dockKeys: { 'dock:t': 'k' } } };
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => chatDock(config, 'dock:t', { messages: [{ role: 'user', content: 'hi' }], firstTokenSec: 30 }),
      e => { assert.match(e.message, /卡住/); assert.equal(e.nonRetryable, false); return true; });
    const spent = Date.now() - t0;
    assert.ok(spent < 5000, '要按设置的 1 秒判定卡住，而不是默认 90 秒（实际 ' + spent + 'ms）');
  } finally { srv.close(); }
});
