import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

const assignments = (owner1, owner2, owner3) => ({
  schemaVersion: 1,
  assignments: [
    { taskId: 'task-1', owner: owner1, reason: '文件任务适合它' },
    { taskId: 'task-2', owner: owner2, reason: '页面任务适合它' },
    { taskId: 'task-3', owner: owner3, reason: '桌面任务适合它' },
  ],
  confidence: 0.93,
  reasons: ['按能力分配'],
});

const entry = () => ({ status: 'applied', mode: 'full', model: 'deepseek-r1:14b', backend: 'custom', decision: { taskId: 'x', requiresHuman: false, risk: { level: 'low', irreversible: false, money: false, computerInput: false } } });

const plan = () => ({
  tasks: [
    { id: 'task-1', title: '写文件', detail: '写 a.txt', files: ['a.txt'], acceptance: ['文件存在'], type: 'workspace' },
    { id: 'task-2', title: '写页面', detail: '写 page.html', files: ['page.html'], owner: 'deepseek', acceptance: ['页面存在'], type: 'workspace' },
    { id: 'task-3', title: '桌面操作', detail: '打开应用', files: [], owner: 'codex', acceptance: ['应用打开'], type: 'desktop', eligibleWorkers: ['codex'] },
  ],
  acceptance: ['全部完成'],
  checks: [],
});

function fixture(t, controller, mode = 'full') {
  const root = cleanup(t, tempDir('local-dispatch-integration'));
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  const config = defaults(root);
  config.root = root; config.dataDir = path.join(root, 'data');
  config.workspace = path.join(root, 'workspaces'); config.allowedRoots = [root]; config.skipAcl = true;
  config.localController = { ...config.localController, enabled: true, mode };
  const store = new Store(path.join(root, 'data', 'beat.sqlite')); t.after(() => store.close());
  const agents = { codex: async () => ({ text: '' }), deepseek: async () => ({ text: '' }) };
  const orch = new Orchestrator({ config, store, agents, localController: controller });
  orch.launch = () => {}; orch.pump = () => {};
  return { root, config, store, orch };
}

test('并行任务在方案批准后让控制器真正定人：补空、改派、硬限制拒绝', async t => {
  let asked = null;
  const fake = {
    health: async () => ({ online: true, modelReady: true }),
    dispatch: async input => { asked = input; return { proposal: assignments('codex', 'codex', 'deepseek'), requestedModel: 'deepseek-r1:14b', actualModel: 'deepseek-r1:14b', modelVerified: true, endpoint: 'http://127.0.0.1:11434', durationMs: 12, usage: { promptTokens: 100, outputTokens: 30 }, raw: JSON.stringify(assignments('codex', 'codex', 'deepseek')) }; },
  };
  const f = fixture(t, fake);
  const run = f.orch.startParallel({ goal: '做三件事并验收', cwd: f.config.workspace });
  f.store.set('localController:' + run.id, entry());
  const p = plan();
  const result = await f.orch.runLocalDispatch(run, p, new AbortController().signal);
  assert.equal(result.status, 'applied');
  assert.ok(asked, '必须把任务列表交给控制器');
  assert.deepEqual(asked.tasks.map(task => task.taskId), ['task-1', 'task-2', 'task-3']);
  assert.equal(p.tasks[0].owner, 'codex', '空 owner 由控制器补位');
  assert.equal(p.tasks[0].ownerSource, 'controller');
  assert.equal(p.tasks[1].owner, 'codex', 'full 模式允许改派');
  assert.equal(p.tasks[2].owner, 'codex', 'eligibleWorkers 硬限制必须守住');
  assert.equal(result.policy.summary.assigned, 1);
  assert.equal(result.policy.summary.reassigned, 1);
  assert.equal(result.policy.summary.rejected, 1);
  const saved = f.store.get('localControllerDispatch:' + run.id);
  assert.equal(saved.status, 'applied');
  assert.equal(saved.evidence.requestedModel, 'deepseek-r1:14b');
  assert.equal(saved.policy.rows.length, 3);
  assert.equal(f.store.run(run.id).plan.tasks[1].owner, 'codex', '应用后的分工必须写进任务记录');
});

test('方案 owner 与 hard limit 冲突时先按硬限制纠正，再交给控制器分工', async t => {
  const fake = {
    health: async () => ({ online: true, modelReady: true }),
    dispatch: async () => ({ proposal: assignments('codex', 'deepseek', 'codex'), requestedModel: 'deepseek-r1:14b', actualModel: 'deepseek-r1:14b', modelVerified: true, endpoint: 'x', durationMs: 1, usage: {}, raw: '{}' }),
  };
  const f = fixture(t, fake);
  const run = f.orch.startParallel({ goal: '做三件事并验收', cwd: f.config.workspace });
  f.store.set('localController:' + run.id, entry());
  const p = plan();
  p.tasks[2] = { ...p.tasks[2], owner: 'deepseek', eligibleWorkers: ['codex'] };
  const result = await f.orch.runLocalDispatch(run, p, new AbortController().signal);
  assert.equal(result.status, 'applied', result.error);
  assert.equal(p.tasks[2].owner, 'codex', '硬限制名单优先于矛盾的原 owner');
  assert.equal(p.tasks[2].ownerSource, 'capability-limit');
  assert.equal(result.policy.rows[2].action, 'confirmed');
  assert.ok(f.store.events(100).some(event => event.run_id === run.id && /硬限制冲突/.test(event.text)), '纠正必须留事件');
});

test('影子模式只记录分工建议，不改方案', async t => {
  const fake = {
    health: async () => ({ online: true, modelReady: true }),
    dispatch: async () => ({ proposal: assignments('codex', 'deepseek', 'codex'), requestedModel: 'deepseek-r1:14b', actualModel: 'deepseek-r1:14b', modelVerified: true, endpoint: 'x', durationMs: 1, usage: {}, raw: '{}' }),
  };
  const f = fixture(t, fake, 'shadow');
  const run = f.orch.startParallel({ goal: '做三件事并验收', cwd: f.config.workspace });
  f.store.set('localController:' + run.id, { ...entry(), mode: 'shadow', status: 'shadow' });
  const p = plan();
  const result = await f.orch.runLocalDispatch(run, p, new AbortController().signal);
  assert.equal(result.status, 'shadow');
  assert.equal(result.policy.applied, false);
  assert.equal(p.tasks[0].owner ?? '', '', '影子模式不能改 owner');
  assert.equal(result.policy.rows[0].action, 'assigned', '影子建议仍要留下逐任务证据');
});

test('控制器分工失败时沿用方案原分工，不阻塞任务', async t => {
  const fake = {
    health: async () => ({ online: true, modelReady: true }),
    dispatch: async () => { throw new Error('控制器超时'); },
  };
  const f = fixture(t, fake);
  const run = f.orch.startParallel({ goal: '做三件事并验收', cwd: f.config.workspace });
  f.store.set('localController:' + run.id, entry());
  const p = plan();
  const result = await f.orch.runLocalDispatch(run, p, new AbortController().signal);
  assert.equal(result.status, 'fallback');
  assert.equal(result.fallback, 'plan-owner');
  assert.equal(p.tasks[1].owner, 'deepseek');
  assert.match(result.error, /超时/);
});

test('中转站 API 模型同样能在分工阶段真正定人（真实 HTTP 路径）', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'gpt-6-sol' }] }));
    if (req.url === '/v1/chat/completions') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model: 'gpt-6-sol', choices: [{ message: { content: JSON.stringify(assignments('deepseek', 'codex', 'codex')) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
    res.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = cleanup(t, tempDir('local-dispatch-api'));
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  const config = defaults(root);
  config.root = root; config.dataDir = path.join(root, 'data');
  config.workspace = path.join(root, 'workspaces'); config.allowedRoots = [root]; config.skipAcl = true;
  config.secrets = { controllerApiKey: 'test-key' };
  config.localController = { ...config.localController, enabled: true, mode: 'full', provider: 'api', apiBaseUrl: 'http://127.0.0.1:' + server.address().port, apiModel: 'gpt-6-sol' };
  const store = new Store(path.join(root, 'data', 'beat.sqlite')); t.after(() => store.close());
  const orch = new Orchestrator({ config, store, agents: { codex: async () => ({ text: '' }), deepseek: async () => ({ text: '' }) } });
  orch.launch = () => {}; orch.pump = () => {};
  const run = orch.startParallel({ goal: '做三件事并验收', cwd: config.workspace });
  store.set('localController:' + run.id, { status: 'applied', mode: 'full', backend: 'api', decision: { requiresHuman: false, risk: { level: 'low', irreversible: false, money: false, computerInput: false } } });
  const p = plan();
  const result = await orch.runLocalDispatch(run, p, new AbortController().signal);
  assert.equal(result.status, 'applied');
  assert.equal(result.backend, 'api');
  assert.equal(result.model, 'gpt-6-sol');
  assert.equal(p.tasks[0].owner, 'deepseek');
  assert.equal(p.tasks[1].owner, 'codex');
  assert.equal(result.evidence.modelVerified, true);
});
