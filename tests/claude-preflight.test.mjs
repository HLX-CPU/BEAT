import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { defaults } from '../src/config.mjs';
import { claudePreflight, resetClaudePreflight } from '../src/claude.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

// R363 实测：顾问号池欠费（HTTP 403 insufficient balance）直到核验那一刻才暴露，
// 那时整轮已经烧掉 57 万 token，而且唯一能看图的核验人缺席让 11 条验收全废。
// 这里验证「开工前预检」：早说、只探一次、探到欠费就把顾问下线。

function configFixture() {
  const root = path.join(artifactsRoot(), 'claude-preflight-tests', Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
  const config = defaults(root);
  Object.assign(config, { root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { ...config.secrets, token: 'fixture', claudeApiKey: 'fixture-key' } });
  config.claude = { ...config.claude, baseUrl: 'https://pool.example.test', model: 'claude-fable-5-1', protocol: 'openai' };
  return config;
}

function fakeFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).endsWith('/v1/models')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'claude-fable-5-1' }] }) };
    return { ok: false, status: 403, text: async () => JSON.stringify({ error: { message: 'insufficient balance', type: 'billing_error' } }) };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('开工前预检：号池欠费给出明确原因，TTL 内不重复探测，点「测试」后可重探', async () => {
  const config = configFixture();
  resetClaudePreflight();
  const fake = fakeFetch();
  try {
    const first = await claudePreflight(config);
    assert.equal(first.ok, false);
    assert.match(first.error, /insufficient balance/);
    const probes = fake.calls.length;
    const second = await claudePreflight(config);
    assert.equal(second.cached, true);
    assert.equal(fake.calls.length, probes, 'TTL 内不再打扰号池');
    resetClaudePreflight();
    await claudePreflight(config);
    assert.ok(fake.calls.length > probes, '清除预检缓存后可以重新探测');
  } finally { fake.restore(); }
});

test('开工前预检探到欠费就把顾问下线，本轮选人自动跳过它', async () => {
  const config = configFixture();
  resetClaudePreflight();
  const fake = fakeFetch();
  const store = new Store(':memory:');
  try {
    const orch = new Orchestrator({ config, store, agents: { nativeContextTokens: { codex: 24576, deepseek: 8192 } } });
    const run = store.createRun({ kind: 'parallel', goal: '顾问预检回归', cwd: config.root, initiator: 'codex' });
    assert.equal(orch.roster.state('claude').status, 'online');
    orch.preflightClaude(run);
    for (let i = 0; i < 120 && orch.roster.state('claude').status === 'online'; i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(orch.roster.state('claude').status, 'offline', '欠费的顾问在开工时就被排除');
    assert.equal(orch.roster.health.claude.reason, '账户余额不足');
    assert.match(orch.roster.health.claude.detail, /开工前预检失败/);
    assert.equal(orch.roster.health.claude.requiresAction, true, '欠费要带可处理的离线状态，看板据此给「测试」入口');
    const recorded = store.get('claudePreflight:' + run.id);
    assert.equal(recorded.state, 'failed');
    assert.equal(recorded.reason, '账户余额不足');
    assert.ok(!orch.roster.candidates('codex', 'think').includes('claude'), '选人时不再把欠费的顾问排进来');
  } finally { fake.restore(); store.close(); }
});
