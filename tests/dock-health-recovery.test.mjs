import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chatDock, dockHttpFailure, saveDockEntry } from '../src/dock.mjs';
import { Roster, classifyFailure } from '../src/roster.mjs';
import { TOOLS } from '../src/tools.mjs';
import { loadConfig } from '../src/config.mjs';

const cases = [
  [403, { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient account balance' }, 'balance', true, /充值/],
  [403, { error: { message: 'This group is restricted to Claude Code clients (/v1/messages only)' } }, 'client-restricted', true, /开放普通 API/],
  [503, { error: { message: 'No available accounts: this group only allows Claude Code clients' } }, 'client-restricted', true, /开放普通 API/],
  [503, { error: { message: 'All available accounts exhausted' } }, 'account-pool', false, /未说明/],
  [401, { error: { message: 'invalid token' } }, 'auth', true, /更新密钥/],
  [403, { error: { message: 'not authorized' } }, 'permission', true, /开通权限/],
  [429, { error: { message: 'rate limit' } }, 'rate-limit', false, /限流/],
  [503, { error: { message: 'temporarily unavailable' } }, 'server', false, /服务端故障/],
];

function rosterFor(config) {
  const values = new Map();
  return new Roster({ config, agents: {}, store: { get: k => values.get(k), set: (k, v) => values.set(k, structuredClone(v)), event() {} } });
}

test('真实上游错误正文优先于HTTP状态，错误输出不泄露原文中的密钥', () => {
  for (const [status, body, kind, requiresAction, message] of cases) {
    const f = dockHttpFailure(status, JSON.stringify({ ...body, debug: 'sk-secret-probe' }));
    assert.equal(f.failureKind, kind);
    assert.equal(f.requiresAction, requiresAction);
    assert.match(f.message, message);
    assert.doesNotMatch(f.message, /sk-secret-probe/);
    const c = classifyFailure({ message: f.message, failureKind: kind });
    assert.equal(c.down, true);
    assert.equal(c.requiresAction === true, requiresAction);
    if (kind === 'client-restricted') assert.notEqual(c.reason, '触发限额');
    if (requiresAction) assert.equal(classifyFailure(new Error(f.message)).requiresAction, true, '工具包装丢失结构化字段时仍不能误判为限流');
  }
});

test('HTTP错误经chatDock保留结构化类别且未知usage不编造为0', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(cases[0][1]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = { dock: [{ id: 'dock:test', name: 'GLM', model: 'glm', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }], secrets: { dockKeys: { 'dock:test': 'fixture' } } };
    await assert.rejects(chatDock(config, 'dock:test', { messages: [{ role: 'user', content: 'probe' }] }), error => {
      assert.equal(error.failureKind, 'balance');
      assert.equal(error.status, 403);
      assert.equal(error.nonRetryable, true);
      assert.equal(error.usage, null);
      return true;
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('永久账户失败退出可用候选，成功测试恢复且保留手动暂停；配置变更不继承旧失败', () => {
  const id = 'dock:test';
  const config = { flow: { cooldownMin: 10 }, dock: [{ id, enabled: true, baseUrl: 'https://fixture.invalid/v1', model: 'fixture' }], secrets: { dockKeys: { [id]: 'fixture-key' } } };
  const roster = rosterFor(config);
  roster.recordDockTest(id, { ok: false, failureKind: 'client-restricted', error: '请联系服务商开放普通 API' });
  assert.equal(roster.state(id).status, 'offline');
  assert.equal(roster.state(id).requiresAction, true);
  assert.equal(roster.candidates(id, 'think').includes(id), false);
  config.dock[0].model = 'corrected';
  assert.equal(roster.state(id).status, 'online');
  roster.recordDockTest(id, { ok: false, failureKind: 'balance', error: '余额不足，请充值' });
  roster.setPaused(id, true);
  roster.recordDockTest(id, { ok: true, tools: 'supported' });
  assert.equal(roster.state(id).status, 'paused');
  assert.equal(roster.state(id).healthCheck.ok, true);
  roster.setPaused(id, false);
  assert.equal(roster.state(id).status, 'online');
});

test('看板dock_test失败会更新健康状态，处理权限后点击测试即恢复，无需重启改配置', async () => {
  let restricted = true;
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
    }
    calls++;
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    if (restricted) { res.statusCode = 403; return res.end(JSON.stringify(cases[1][1])); }
    const message = request.tools ? { content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'get_time', arguments: '{"tz":"Asia/Shanghai"}' } }] } : { content: 'OK' };
    res.end(JSON.stringify({ model: 'fixture', choices: [{ message, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const parent = path.resolve('workspaces/shared');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'dock-health-fixture-'));
  try {
    let config = loadConfig(root);
    const entry = saveDockEntry(config, { name: 'fixture', model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key' });
    config = loadConfig(root);
    const roster = rosterFor(config);
    const o = { config, roster };
    const svc = { reload: c => { o.config = c; roster.config = c; } };
    const failed = await TOOLS.dock_test.run(o, { id: entry.id }, 'user', svc);
    assert.equal(failed.ok, false);
    assert.equal(failed.failureKind, 'client-restricted');
    assert.equal(failed.customerIssue.title, '服务商限制客户端');
    assert.match(failed.customerIssue.message, /开放普通 API/);
    assert.doesNotMatch(failed.customerIssue.message, /请检查服务地址|稍后重试/);
    assert.equal(roster.state(entry.id).status, 'offline');
    assert.equal(calls, 1, '账户拒绝后不继续派发工具探针');
    restricted = false;
    const passed = await TOOLS.dock_test.run(o, { id: entry.id }, 'user', svc);
    assert.equal(passed.ok, true);
    assert.equal(passed.tools, 'supported');
    assert.equal(passed.modelVerified, 'verified');
    assert.equal(roster.state(entry.id).status, 'online');
    assert.equal(roster.state(entry.id).healthCheck.ok, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
