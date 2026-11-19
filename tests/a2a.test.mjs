import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beatAgentCard, partnerCard, partnerCards, toA2ATask, a2aRpc, A2A_TASK_STATES, A2A_PROTOCOL_VERSION } from '../src/a2a.mjs';
import { startServer } from '../src/server.mjs';
import { defaults } from '../src/config.mjs';
import { tempDir } from './helpers/temp.mjs';

test('A2A Agent Card：可发现、协议版本、技能与能力齐全', () => {
  const card = beatAgentCard({ baseUrl: 'http://127.0.0.1:8765' });
  assert.equal(card.protocolVersion, A2A_PROTOCOL_VERSION);
  assert.equal(card.name, 'BEAT 多方协同');
  assert.ok(card.skills.some(skill => skill.id === 'beat-ask'));
  assert.ok(card.skills.some(skill => skill.id === 'beat-deliver'));
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.url, 'http://127.0.0.1:8765');
});

test('搭档卡：Codex/DeepSeek/Claude/拓展坞的 kind 与技能不同', () => {
  const codex = partnerCard('codex', { status: 'online', model: 'gpt-6.1-sol' });
  const deepseek = partnerCard('deepseek', { status: 'online' });
  const claude = partnerCard('claude', { status: 'online' });
  const dock = partnerCard('dock:f2fbcc9d', { name: 'wawa-gpt', status: 'online', model: 'gpt-6-astra' });
  assert.equal(codex.kind, 'native');
  assert.ok(codex.skills.some(skill => skill.id.endsWith(':desktop')));
  assert.equal(claude.kind, 'advisor');
  assert.ok(!claude.skills.some(skill => /desktop/.test(skill.id)));
  assert.equal(dock.kind, 'dock');
  assert.match(dock.url, /dock%3Af2fbcc9d/);
  assert.equal(partnerCards({ partners: [{ id: 'codex', status: 'online' }] }).length, 1);
});

test('A2A Task：BEAT 状态映射 + 交付文件 + 消息历史', () => {
  const view = {
    id: 'R1', goal: '在桌面新建通知.txt', state: 'passed', result: '已创建并核验',
    customer: { artifacts: [{ path: 'E:\\beat\\workspaces\\shared\\通知.txt', bytes: 12, verified: true }] },
  };
  view.executionAudit = { count: 2, highRisk: [{ seq: 2 }], replayable: true };
  const task = toA2ATask(view);
  assert.equal(task.id, 'R1');
  assert.deepEqual(task.metadata.executionAudit, { count: 2, highRisk: 1, replayable: true });
  view.workflow = { node: 'delivery', terminal: true, resumable: false, resume: { action: 'none', label: '已完成' } };
  const withWorkflow = toA2ATask(view);
  assert.equal(withWorkflow.metadata.workflow.node, 'delivery');
  assert.equal(withWorkflow.metadata.workflow.resumeAction, 'none');
  view.guardrails = { input: { level: 'ok', reasons: [] }, execution: { level: 'warn', reasons: ['执行层提醒'] }, output: { level: 'ok', reasons: [] } };
  const withGuard = toA2ATask(view);
  assert.equal(withGuard.metadata.guardrails.input, 'ok');
  assert.deepEqual(withGuard.metadata.guardrails.reasons, ['执行层提醒']);
  assert.equal(task.status.state, A2A_TASK_STATES.COMPLETED);
  assert.equal(task.artifacts.length, 1);
  assert.equal(task.artifacts[0].parts[0].kind, 'file');
  assert.match(task.artifacts[0].parts[0].file.uri, /^file:\/\//);
  assert.equal(task.history[0].role, 'user');
  assert.equal(task.history.at(-1).role, 'agent');
  for (const [state, expected] of [['queued','submitted'],['running','working'],['waiting_input','input-required'],['failed','failed'],['cancelled','canceled'],['error','failed']]) {
    assert.equal(toA2ATask({ id: 'R2', state }).status.state, expected, state);
  }
});

test('A2A JSON-RPC：tasks/get 可查，message/send 明确只读', () => {
  const task = { id: 'R1', status: { state: 'completed' } };
  const got = a2aRpc({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'R1' } }, { taskFor: id => id === 'R1' ? task : null });
  assert.equal(got.result.id, 'R1');
  const missing = a2aRpc({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: 'R404' } }, { taskFor: () => null });
  assert.equal(missing.error.code, -32001);
  const send = a2aRpc({ jsonrpc: '2.0', id: 3, method: 'message/send', params: {} }, {});
  assert.equal(send.error.code, -32601);
  assert.match(send.error.message, /只读/);
  const unknown = a2aRpc({ jsonrpc: '2.0', id: 4, method: 'nope' }, {});
  assert.equal(unknown.error.code, -32601);
});

test('A2A HTTP：Agent Card 公开；搭档/任务需要令牌；POST 只读查询', async t => {
  const root = tempDir('a2a-http');
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'fixture-token' }, skipAcl: true };
  fs.mkdirSync(config.dataDir, { recursive: true });
  const svc = await startServer({ config, port: 0, agents: { codex: async () => ({ text: 'ok' }), deepseek: async () => ({ text: 'ok' }) } });
  t.after(async () => { await new Promise(resolve => svc.server.close(resolve)); svc.store.close(); });
  const base = 'http://127.0.0.1:' + svc.port;
  const auth = { Authorization: 'Bearer fixture-token' };
  const card = await (await fetch(base + '/.well-known/agent.json')).json();
  assert.equal(card.protocolVersion, A2A_PROTOCOL_VERSION);
  assert.equal((await fetch(base + '/a2a/partners')).status, 401);
  const partners = await (await fetch(base + '/a2a/partners', { headers: auth })).json();
  assert.equal(partners.kind, 'partners');
  assert.ok(Array.isArray(partners.partners) && partners.partners.length >= 2);
  assert.equal((await fetch(base + '/a2a/tasks/R404', { headers: auth })).status, 404);
  const rpc = await (await fetch(base + '/a2a', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'R404' } }) })).json();
  assert.equal(rpc.error.code, -32001);
});
