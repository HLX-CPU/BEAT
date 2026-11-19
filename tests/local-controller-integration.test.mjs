import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

const decision = () => ({
  schemaVersion: 1, taskType: 'execution',
  risk: { level: 'low', reasons: ['bounded file task'], irreversible: false, money: false, computerInput: false },
  flow: { kind: 'parallel', maxDebates: 1, maxRounds: 2, maxParallelTasks: 2 },
  assignees: { strong: 'codex', cheap: ['deepseek'] },
  budget: { discussionTokens: 2000, executionTokens: 4000, taskTokens: 3000 },
  requiresHuman: false, confidence: 0.92, reasons: ['small and reversible'],
});

function fixture(t, controller, mode = 'low-risk') {
  const root = cleanup(t, tempDir('local-controller-integration'));
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  const config = defaults(root);
  config.root = root; config.dataDir = path.join(root, 'data');
  config.workspace = path.join(root, 'workspaces'); config.allowedRoots = [root]; config.skipAcl = true;
  config.localController = { ...config.localController, enabled: true, mode };
  config.flow.discussionTokenBudget = 10000; config.flow.executionTokenBudget = 20000; config.flow.taskTokenBudget = 10000; config.flow.maxParallelTasks = 3;
  const store = new Store(path.join(root, 'data', 'beat.sqlite')); t.after(() => store.close());
  const agents = { codex: async () => ({ text: '' }), deepseek: async () => ({ text: '' }) };
  const orch = new Orchestrator({ config, store, agents, localController: controller });
  orch.launch = () => {}; orch.pump = () => {};
  return { root, config, store, orch };
}

test('low-risk controller applies only a bounded per-run patch and exposes evidence', async t => {
  const fake = { health: async () => ({ online: true, modelReady: true }), decide: async () => ({ proposal: decision(), endpoint: 'http://127.0.0.1:11434', requestedModel: 'deepseek-r1:14b', actualModel: 'deepseek-r1:14b', modelVerified: true, durationMs: 12, usage: { promptTokens: 10, outputTokens: 20 } }) };
  const f = fixture(t, fake);
  const run = f.orch.startParallel({ goal: 'Create one verified text file', cwd: f.config.workspace });
  const result = await f.orch.runLocalControl(run, new AbortController().signal);
  assert.equal(result.status, 'applied');
  assert.equal(f.orch.flowFor(run).taskTokenBudget, 10000, '本地控制建议不得静默压低客户预算');
  assert.equal(f.orch.flowFor(run).maxParallelTasks, 2);
  assert.equal(f.store.run(run.id).max_rounds, 2);
  assert.equal(f.orch.view(run.id).localController.evidence.modelVerified, true);
});

test('controller outage falls back to the unchanged existing BEAT flow', async t => {
  const fake = { health: async () => ({ online: false, modelReady: false, error: 'offline' }), decide: async () => { throw new Error('must not dispatch'); } };
  const f = fixture(t, fake, 'full');
  const run = f.orch.startParallel({ goal: 'Keep working even if local advice is unavailable', cwd: f.config.workspace });
  const before = f.orch.flowFor(run).taskTokenBudget;
  const result = await f.orch.runLocalControl(run, new AbortController().signal);
  assert.equal(result.status, 'fallback');
  assert.equal(result.fallback, 'existing-beat-flow');
  assert.equal(f.orch.flowFor(run).taskTokenBudget, before);
});

test('evaluation sample catalog keeps risky actions out of automatic control', () => {
  const rows = JSON.parse(fs.readFileSync(new URL('./fixtures/local-controller-eval.json', import.meta.url), 'utf8'));
  assert.ok(rows.length >= 10);
  assert.ok(rows.some(row => row.expectedRisk === 'critical'));
  for (const row of rows.filter(row => ['high', 'critical'].includes(row.expectedRisk))) assert.equal(row.mayAutoApply, false, row.id);
});

test('orchestrator retains existing flow when model identity is unverified', async t => {
  const fake = { health: async () => ({ online: true, modelReady: true }), decide: async () => ({ proposal: decision(), requestedModel: 'deepseek-r1:14b', actualModel: 'unexpected', modelVerified: false }) };
  const f = fixture(t, fake);
  const run = f.orch.startParallel({ goal: 'Create one verified text file', cwd: f.config.workspace });
  const before = f.orch.flowFor(run).taskTokenBudget;
  const result = await f.orch.runLocalControl(run, new AbortController().signal);
  assert.equal(result.status, 'fallback');
  assert.equal(f.orch.flowFor(run).taskTokenBudget, before);
  assert.equal(f.store.get('controlConfig:' + run.id).strongAgent, f.config.flow.strongAgent);
});

test('生产默认按客户选的来源解析控制器：中转站 API 真正接管（不再被“永远本地”的默认工厂顶掉）', async t => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'gpt-6-sol' }] }));
    if (req.url === '/v1/chat/completions') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      model: 'gpt-6-sol', choices: [{ message: { content: JSON.stringify(decision()) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 },
    }));
    res.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const f = fixture(t, undefined, 'low-risk');
  assert.equal(f.orch.localControllerFactory, null, '生产默认不能塞一个永远用本地模型的工厂');
  f.config.secrets = { controllerApiKey: 'test-key' };
  f.config.localController = { ...f.config.localController, enabled: true, mode: 'low-risk', provider: 'api', apiBaseUrl: `http://127.0.0.1:${port}`, apiModel: 'gpt-6-sol' };
  const run = f.orch.startParallel({ goal: 'Create one verified text file', cwd: f.config.workspace });
  const result = await f.orch.runLocalControl(run, new AbortController().signal);
  assert.equal(result.status, 'applied');
  assert.equal(result.backend, 'api');
  assert.equal(result.model, 'gpt-6-sol');
  assert.equal(result.providerLabel, '中转站 API');
  assert.equal(result.evidence.requestedModel, 'gpt-6-sol');
});

test('控制器失败时记录本来要用的来源：看板不会把中转站失败误报成本地模型', async t => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'gpt-6-sol' }] }));
    if (req.url === '/v1/chat/completions') return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'relay down' }));
    res.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const f = fixture(t, undefined, 'full');
  f.config.secrets = { controllerApiKey: 'test-key' };
  f.config.localController = { ...f.config.localController, enabled: true, mode: 'full', provider: 'api', apiBaseUrl: `http://127.0.0.1:${port}`, apiModel: 'gpt-6-sol' };
  const run = f.orch.startParallel({ goal: 'Create one verified text file', cwd: f.config.workspace });
  const result = await f.orch.runLocalControl(run, new AbortController().signal);
  assert.equal(result.status, 'fallback');
  assert.equal(result.backend, 'api');
  assert.equal(result.model, 'gpt-6-sol');
  assert.equal(result.providerLabel, '中转站 API');
  assert.match(result.error, /relay down/);
});
