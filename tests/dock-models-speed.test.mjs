// 「获取这个端点的模型列表」不能慢：客户实测 2026-10-17 “这获取模型也太慢了吧”。
// 旧实现串行先试 /v1 再试根路径，两个都超时最坏 40 秒；现在两个候选并行、先赢先用、10 秒封顶、成功缓存。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { listDockModels, testDock, clearModelListCache } from '../src/dock.mjs';
import { testClaude } from '../src/claude.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

// 一个"慢半拍"的端点：/v1/models 永远不回，/models 立刻给列表。
async function slowV1Site() {
  const hits = { v1: 0, root: 0 };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') { hits.v1++; return; }
    if (req.url === '/models') {
      hits.root++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fast-model' }] }));
    }
    res.writeHead(404); res.end('not found');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { hits, port: server.address().port, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}

test('两个候选地址并行：一个挂着不回，另一个立刻返回，客户不用陪着等', async t => {
  const site = await slowV1Site(); t.after(() => site.close());
  clearModelListCache();
  const t0 = Date.now();
  const listed = await listDockModels({ baseUrl: 'http://127.0.0.1:' + site.port, key: 'k' });
  const elapsed = Date.now() - t0;
  assert.deepEqual(listed.models.map(m => m.id), ['fast-model']);
  assert.ok(elapsed < 3000, '不能等挂着的 /v1：' + elapsed + 'ms');
  assert.equal(site.hits.root, 1);
});

test('同一个端点再点一次直接用缓存，不再撞慢地址', async t => {
  const site = await slowV1Site(); t.after(() => site.close());
  clearModelListCache();
  const tip = 'http://127.0.0.1:' + site.port;
  await listDockModels({ baseUrl: tip, key: 'cache-key' });
  const before = site.hits.root + site.hits.v1;
  const t0 = Date.now();
  const again = await listDockModels({ baseUrl: tip, key: 'cache-key' });
  const elapsed = Date.now() - t0;
  assert.deepEqual(again.models.map(m => m.id), ['fast-model']);
  assert.equal(site.hits.root + site.hits.v1, before, '缓存命中时不该再发请求');
  assert.ok(elapsed < 200, '缓存命中要立刻返回：' + elapsed + 'ms');
});

test('连不上时快速失败，并说清楚是哪台地址、下一步能做什么', async () => {
  clearModelListCache();
  const t0 = Date.now();
  await assert.rejects(() => listDockModels({ baseUrl: 'http://127.0.0.1:1', key: 'k' }), error => {
    assert.equal(error.code, 'CONNECT');
    assert.match(error.message, /端点连不上（127\.0\.0\.1:1）/);
    assert.match(error.message, /手动填写模型 ID/);
    assert.doesNotMatch(error.message, /UND_ERR|ECONNREFUSED|fetch failed/);
    return true;
  });
  assert.ok(Date.now() - t0 < 3000, '连接被拒要立刻失败');
});

test('连不上时不做无谓的对话/工具测试，保存并测试也快速给结论', async t => {
  const root = cleanup(t, tempDir('dock-speed'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ workspace: root }));
  const { loadConfig } = await import('../src/config.mjs');
  const cfg = loadConfig(root);
  cfg.secrets = { ...cfg.secrets, dockKeys: { 'dock:dead': 'sk-k' } };
  cfg.dock = [{ id: 'dock:dead', name: '死端点', baseUrl: 'http://127.0.0.1:1', model: 'm', enabled: true }];
  const t0 = Date.now();
  const result = await testDock(cfg, 'dock:dead');
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'connect');
  assert.match(result.error, /端点连不上/);
  assert.ok(Date.now() - t0 < 5000, '不能先等二十秒再去试对话：' + (Date.now() - t0) + 'ms');
});

test('顾问联通测试同样快速失败，不再等对话超时', async t => {
  const root = cleanup(t, tempDir('claude-speed'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ workspace: root }));
  const { loadConfig } = await import('../src/config.mjs');
  const cfg = loadConfig(root);
  cfg.claude = { ...cfg.claude, baseUrl: 'http://127.0.0.1:1', model: 'claude-opus-5-5', enabled: true };
  cfg.secrets = { ...cfg.secrets, claudeApiKey: 'sk-k' };
  const t0 = Date.now();
  const result = await testClaude(cfg);
  assert.equal(result.ok, false);
  assert.match(result.error, /端点连不上/);
  assert.ok(Date.now() - t0 < 5000, '不能先等对话超时：' + (Date.now() - t0) + 'ms');
});

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
test('按钮上有等待秒数，超过 5 秒给出"也可以手动填"的出口', () => {
  assert.match(html, /function fetchProgress\(button, box, label\)/, '需要统一的进度反馈');
  assert.match(html, /'… ' \+ secs \+ ' 秒'/, '按钮上要走秒数');
  assert.match(html, /端点响应慢，仍在等；也可以先手动填写模型 ID/, '超过 5 秒要给出逃路');
  const dockFetch = html.slice(html.indexOf("$('dFetch').onclick"), html.indexOf("$('dSave').onclick"));
  const advisorFetch = html.slice(html.indexOf("$('aFetch').onclick"), html.indexOf('// 卡片右上角'));
  assert.match(dockFetch, /fetchProgress\(/, '拓展坞的获取模型按钮要有进度');
  assert.match(advisorFetch, /fetchProgress\(/, '顾问的获取模型按钮要有进度');
});
