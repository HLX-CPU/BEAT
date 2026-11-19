import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { Models, resolveDefault } from '../src/models.mjs';
import { defaults, loadConfig, saveSettings } from '../src/config.mjs';
import { writePatch, deepseekModels, deepseekProfile, askDeepseek } from '../src/deepseek.mjs';
import { askCodex, listCodexModels } from '../src/codex.mjs';
import { TOOLS } from '../src/tools.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import { decodeFrames, nativeModelEvidence } from '../src/deepseek-evidence.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
const verified = (o, extra = {}) => ({ text: 'ok', nativeId: o.nativeId || 'native-' + Math.random(), actualModel: o.model, modelVerified: 'verified', modelEvidence: { source: 'mock response' }, ...extra });
function fixture(t, agents = {}, capabilities = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-models-'));
  fs.mkdirSync(path.join(root, 'workspaces/shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ codex: { defaultModel: 'codex-a' }, deepseek: { defaultModel: 'deepseek-a' } }));
  fs.writeFileSync(path.join(root, 'secrets.local.json'), JSON.stringify({ token: 'fixture-only' }));
  const config = { ...loadConfig(root), skipAcl: true };
  config.deepseek.home = path.join(root, 'mock-dsh');
  // writePatch 会从桌面 profile 继承已安装的 MCP/技能条目：模拟桌面端已完成首次设置。
  const desktopProfile = path.join(config.deepseek.home, 'profiles', 'desktop', 'cordis.patch.yml');
  fs.mkdirSync(path.dirname(desktopProfile), { recursive: true });
  fs.writeFileSync(desktopProfile, '- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n');
  // All catalogs and adapters are mocks; never open desktop settings or launch models.
  const models = new Models(config, { capabilities, catalog: async p => ({ source: 'mock', models: ['a', 'b'].map(s => ({ id: p + '-' + s, name: s, availability: 'configured' })) }) });
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  const orch = new Orchestrator({ config, store, models, agents: { codex: async o => verified(o), deepseek: async o => verified(o), claude: async () => { throw new Error('unexpected Claude'); }, ...agents } });
  t.after(() => store.close()); return { root, config, models, store, orch };
}
async function finish(orch, id) {
  for (let i = 0; i < 300; i++) { const r = orch.store.run(id); if (orch.isFinal(r.state)) return r; await delay(5); }
  throw new Error('fixture run timed out');
}

test('run_index：两类任务各自全量统计（从建平台到现在），并给出总数', async t => {
  const { orch } = fixture(t, { codex: async o => verified(o), deepseek: async o => verified(o) });
  const a1 = await TOOLS.beat_ask.run(orch, { to: 'codex', question: '问一', wait_seconds: 0 }, 'user'); await finish(orch, a1.id);
  const a2 = await TOOLS.beat_ask.run(orch, { to: 'codex', question: '问二', wait_seconds: 0 }, 'user'); await finish(orch, a2.id);
  const d1 = orch.startDiscuss({ goal: '讨论一件事' }); await finish(orch, d1.id);
  const all = TOOLS.run_index.run(orch, {});
  assert.equal(all.total, 3, '全部任务都要算进来');
  assert.deepEqual(all.items.map(r => r.id).sort(), [a1.id, a2.id, d1.id].sort());
  assert.equal(all.truncated, false);
  const asks = TOOLS.run_index.run(orch, { kind: 'ask' });
  assert.equal(asks.total, 2); assert.ok(asks.items.every(r => r.kind === 'ask'));
  const talks = TOOLS.run_index.run(orch, { kind: 'discuss' });
  assert.equal(talks.total, 1); assert.equal(talks.items[0].id, d1.id);
  assert.ok(Number.isFinite(talks.items[0].tokens), '每条都要带用量');
  assert.ok(talks.items[0].created_at);
});

test('two providers: explicit selection passes tools → orchestrator → roster → adapter; evidence/revision persisted', async t => {
  const seen = [];
  const { orch, store } = fixture(t, { codex: async o => { seen.push(o.model); return verified(o); }, deepseek: async o => { seen.push(o.model); return verified(o); } });
  for (const p of ['codex', 'deepseek']) {
    const r = await TOOLS.beat_ask.run(orch, { to: p, question: 'test', model: p + '-b', wait_seconds: 0 }, 'user');
    assert.equal((await finish(orch, r.id)).state, 'done');
    const s = store.session(r.session_id); assert.equal(s.model, p + '-b'); assert.equal(s.model_source, 'explicit');
    const step = store.steps(r.id)[0]; assert.equal(step.requested_model, p + '-b'); assert.equal(step.data.actualModel, p + '-b');
  }
  assert.deepEqual(seen, ['codex-b', 'deepseek-b']);
  const list = TOOLS.beat_sessions.run(orch, {}); assert.equal(list.items.length, 2); assert(list.revision >= 2);
  assert.equal(TOOLS.overview.run(orch).sessionsRevision, list.revision);
});

// 看板的「会话号」下拉和右侧「会话记录」都读这个工具：一条会话的问答按时间正序，别的会话不许混进来。
test('session_history：一条会话的问答按时间正序，只含本会话', async t => {
  const { orch, store } = fixture(t, { codex: async o => verified(o), deepseek: async o => verified(o) });
  const a1 = await TOOLS.beat_ask.run(orch, { to: 'codex', question: '会话A第一问', wait_seconds: 0 }, 'user');
  await finish(orch, a1.id);
  const a2 = await TOOLS.beat_ask.run(orch, { to: 'codex', question: '会话A第二问', session_id: a1.session_id, wait_seconds: 0 }, 'user');
  await finish(orch, a2.id);
  const b1 = await TOOLS.beat_ask.run(orch, { to: 'deepseek', question: '会话B的问题', wait_seconds: 0 }, 'user');
  await finish(orch, b1.id);
  assert.notEqual(a1.session_id, b1.session_id, '两条任务默认是两条会话');

  const a = TOOLS.session_history.run(orch, { session_id: a1.session_id });
  assert.equal(a.session.id, a1.session_id);
  assert.deepEqual(a.runs.map(r => r.goal), ['会话A第一问', '会话A第二问'], '同一会话的问答按时间正序');
  assert.deepEqual(a.runs.map(r => r.id), [a1.id, a2.id]);
  assert.ok(a.runs.every(r => typeof r.result === 'string'), '每条都带答复正文');
  assert.ok(a.runs.every(r => Number.isFinite(r.tokens)), '每条都带用量');
  assert.ok(!JSON.stringify(a.runs).includes('会话B'), '别的会话不许混进来');
  const b = TOOLS.session_history.run(orch, { session_id: b1.session_id });
  assert.deepEqual(b.runs.map(r => r.goal), ['会话B的问题']);
  assert.equal(TOOLS.session_history.run(orch, { session_id: a1.session_id, limit: 1 }).runs.length, 1, 'limit 生效（取最近一条）');
  assert.throws(() => TOOLS.session_history.run(orch, { session_id: 'S404' }), /找不到会话/);
  assert.equal(store.session(a1.session_id).natives !== undefined, true);
});

test('settings save independently, restart retains values, existing session keeps default snapshot', async t => {
  const { orch, store, config, root } = fixture(t);
  const r = orch.startAsk({ to: 'codex', question: 'one' }); await finish(orch, r.id);
  const result = await TOOLS.settings_set.run(orch, { codex: { defaultModel: 'codex-b' }, deepseek: { defaultModel: 'deepseek-b' } }, 'user', { reload: c => orch.setConfig(c) });
  assert.equal(result.codex.defaultModel, 'codex-b'); assert.equal(result.deepseek.defaultModel, 'deepseek-b');
  assert.equal(loadConfig(root).codex.defaultModel, 'codex-b'); assert.equal(loadConfig(root).deepseek.defaultModel, 'deepseek-b');
  assert.equal(store.session(r.session_id).model, 'codex-a');
  assert.equal(fs.readFileSync(config.secretFile, 'utf8'), JSON.stringify({ token: 'fixture-only' }));
  const next = orch.startAsk({ to: 'codex', question: 'two' }); await finish(orch, next.id);
  assert.equal(store.session(next.session_id).model, 'codex-b');
});

test('unverified switching refuses without any write or revision change; unsupported same behavior', async t => {
  const { orch, store } = fixture(t);
  const r = orch.startAsk({ to: 'deepseek', question: 'one' }); await finish(orch, r.id);
  const before = store.sessions();
  await assert.rejects(TOOLS.session_set_model.run(orch, { session_id: r.session_id, model: 'deepseek-b' }), /未验证或不支持/);
  assert.deepEqual(store.sessions(), before);
  orch.models.capabilities.deepseek = 'unsupported';
  assert.throws(() => orch.startAsk({ to: 'deepseek', session_id: r.session_id, model: 'deepseek-b', question: 'two' }), /未验证或不支持/);
  assert.deepEqual(store.sessions(), before);
});

test('supported switching retains native context and starts on next request; running request holds snapshot', async t => {
  const seen = []; let release; const gate = new Promise(r => { release = r; });
  const { orch, store } = fixture(t, { codex: async o => { seen.push({ model: o.model, native: o.nativeId }); if (seen.length === 1) await gate; return verified(o, { nativeId: 'context-1' }); } }, { codex: 'supported' });
  const one = orch.startAsk({ to: 'codex', question: 'remember' });
  while (!seen.length) await delay(1);
  await TOOLS.session_set_model.run(orch, { session_id: one.session_id, model: 'codex-b' });
  release(); await finish(orch, one.id);
  assert.equal(store.session(one.session_id).model, 'codex-b');
  const two = orch.startAsk({ to: 'codex', session_id: one.session_id, question: 'recall' }); await finish(orch, two.id);
  assert.deepEqual(seen, [{ model: 'codex-a', native: undefined }, { model: 'codex-b', native: 'context-1' }]);
});

test('concurrent asks of same session before native creation serialize and reload current native', async t => {
  const seen = []; let active = 0, peak = 0;
  const { orch } = fixture(t, { codex: async o => { active++; peak = Math.max(peak, active); seen.push(o.nativeId); await delay(25); active--; return verified(o, { nativeId: 'same-native' }); } });
  const one = orch.startAsk({ to: 'codex', question: 'one' });
  const two = orch.startAsk({ to: 'codex', session_id: one.session_id, question: 'two' });
  await Promise.all([finish(orch, one.id), finish(orch, two.id)]);
  assert.deepEqual(seen, [undefined, 'same-native']); assert.equal(peak, 1);
  assert.equal(orch.sessionLocks.tails.size, 0);
});

test('different sessions and agents remain parallel', async t => {
  let active = 0, peak = 0;
  const ask = async o => { active++; peak = Math.max(peak, active); await delay(25); active--; return verified(o); };
  const { orch } = fixture(t, { codex: ask, deepseek: ask });
  const a = orch.startAsk({ to: 'codex', question: 'a' }); const b = orch.startAsk({ to: 'deepseek', question: 'b' });
  await Promise.all([finish(orch, a.id), finish(orch, b.id)]); assert.equal(peak, 2);
});

test('native ID lock spans run/slot aliases', async t => {
  let active = 0, peak = 0;
  const { orch } = fixture(t, { codex: async o => { active++; peak = Math.max(peak, active); await delay(20); active--; return verified(o); } });
  const call = (runId, slot) => orch.roster.call({ runId, slot, seat: 'codex', build: () => 'p', models: { codex: 'codex-a' }, sessions: { [slot + ':codex']: { native: 'alias' } } });
  await Promise.all([call('run-a', 'a'), call('run-b', 'b')]); assert.equal(peak, 1);
});

test('fallback uses actual provider default snapshot, reports actual agent, never passes foreign model', async t => {
  let got;
  const { orch, store } = fixture(t, { codex: async () => { throw new Error('usage limit'); }, deepseek: async o => { got = o.model; return verified(o); } });
  const r = orch.startAsk({ to: 'codex', question: 'fallback' }); await finish(orch, r.id);
  assert.equal(got, 'deepseek-a'); const s = store.session(r.session_id);
  assert.equal(s.model, 'codex-a'); assert.equal(s.actual_agent, 'deepseek'); assert.equal(s.actual_model, 'deepseek-a');
  const step = store.steps(r.id)[0]; assert.equal(step.data.selectedModel, 'codex-a'); assert.equal(step.data.requestedModel, 'deepseek-a');
});

test('explicit model selection stops on rate limit and never silently switches provider', async t => {
  let fallback = 0;
  const { orch, store } = fixture(t, { codex: async () => { throw new Error('usage limit'); }, deepseek: async o => { fallback++; return verified(o); } });
  const r = orch.startAsk({ to: 'codex', question: 'explicit fallback forbidden', model: 'codex-b' });
  assert.equal((await finish(orch, r.id)).state, 'error'); assert.equal(fallback, 0);
  assert.equal(store.session(r.session_id).model, 'codex-b');
});

test('explicit invalid-model errors do not silently substitute, even when error also says 403', async t => {
  let fallback = 0;
  const { orch } = fixture(t, { codex: async () => { const e = new Error('403 model not supported'); e.modelError = true; throw e; }, deepseek: async () => { fallback++; return { text: 'wrong' }; } });
  const r = orch.startAsk({ to: 'codex', question: 'test', model: 'codex-b' }); assert.equal((await finish(orch, r.id)).state, 'error'); assert.equal(fallback, 0);
  await assert.rejects(TOOLS.beat_ask.run(orch, { to: 'codex', question: 'x', model: 'deepseek-b', wait_seconds: 0 }), /没有配置或列出/);
  assert.throws(() => orch.startAsk({ to: 'codex', question: 'x', model: 'bad\npatch: yes' }), /无效/);
});

test('unreliable model echo never becomes actualModel', async t => {
  const { orch, store } = fixture(t, { deepseek: async () => ({ text: 'ok', model: 'deepseek-b', nativeId: 'n' }) });
  const r = orch.startAsk({ to: 'deepseek', question: 'test' }); await finish(orch, r.id);
  assert.equal(store.session(r.session_id).actual_model, null); assert.equal(store.session(r.session_id).model_verified, 'unknown');
});

test('save failure leaves default settings and existing model unchanged', async t => {
  const { orch, config, store } = fixture(t);
  const r = orch.startAsk({ to: 'codex', question: 'p' }); await finish(orch, r.id);
  const before = fs.readFileSync(config.configFile, 'utf8'); const revision = store.sessionsRevision();
  await assert.rejects(TOOLS.settings_set.run(orch, { codex: { defaultModel: 'missing' } }, 'user', { reload: () => assert.fail('must not reload') }), /没有配置或列出/);
  assert.equal(fs.readFileSync(config.configFile, 'utf8'), before); assert.equal(store.sessionsRevision(), revision);
  assert.throws(() => saveSettings(config, { deepseek: { defaultModel: '' } }), /无效/);
});

test('native ID persists even if an adapter fails after creating it', async t => {
  const seen = []; let i = 0;
  const { orch, store } = fixture(t, { codex: async o => {
    seen.push(o.nativeId); if (!i++) { o.onNative('durable-native'); throw new Error('intentional request failure'); } return verified(o);
  } });
  orch.roster.setPaused('deepseek', true);
  const a = orch.startAsk({ to: 'codex', question: 'a' }); assert.equal((await finish(orch, a.id)).state, 'error');
  assert.equal(store.session(a.session_id).natives['codex:codex'].native, 'durable-native');
  const b = orch.startAsk({ to: 'codex', session_id: a.session_id, question: 'b' }); await finish(orch, b.id);
  assert.deepEqual(seen, [undefined, 'durable-native']);
});

test('fallback defaults are snapshotted before running configuration changes', async t => {
  let release; const gate = new Promise(r => { release = r; }); let entered = false, used;
  const { orch } = fixture(t, { codex: async () => { entered = true; await gate; throw new Error('usage limit'); }, deepseek: async o => { used = o.model; return verified(o); } });
  const r = orch.startAsk({ to: 'codex', question: 'p' }); while (!entered) await delay(1);
  orch.config.deepseek.defaultModel = 'deepseek-b'; release(); await finish(orch, r.id);
  assert.equal(used, 'deepseek-a');
});

test('adapter verified mismatch is reported and cannot trigger substitution', async t => {
  let fallback = 0;
  const { orch } = fixture(t, { codex: async o => verified(o, { actualModel: 'codex-b' }), deepseek: async () => { fallback++; return { text: 'x' }; } });
  const r = orch.startAsk({ to: 'codex', question: 'p' }); assert.equal((await finish(orch, r.id)).state, 'error'); assert.equal(fallback, 0);
});

test('native ID becomes locked immediately when allocated; continuation cannot replace it', async t => {
  let allocated, release; const seen = new Promise(r => { allocated = r; }); const gate = new Promise(r => { release = r; }); let active = 0, peak = 0, calls = 0;
  const { orch } = fixture(t, { codex: async o => {
    active++; peak = Math.max(peak, active);
    if (!calls++) { o.onNative('new-id'); allocated(); await gate; }
    active--; return verified(o, { nativeId: 'new-id' });
  } });
  const a = orch.startAsk({ to: 'codex', question: 'a' }); await seen;
  const b = orch.roster.call({ runId: 'alias-run', seat: 'codex', slot: 'alias', build: () => 'b', models: { codex: 'codex-a' }, sessions: { 'alias:codex': { native: 'new-id' } } });
  await delay(10); assert.equal(calls, 1); release(); await Promise.all([finish(orch, a.id), b]); assert.equal(peak, 1);
  orch.agents.codex = async o => verified(o, { nativeId: 'replacement' });
  await assert.rejects(orch.roster.call({ runId: 'next', seat: 'codex', build: () => 'p', models: { codex: 'codex-a' }, sessions: { 'codex:codex': { native: 'new-id' } } }), /拒绝用新空会话/);
});

test('legacy migration has consistent backup, one-time defaults and unknown evidence, revision atomic', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-migrate-')); const file = path.join(root, 'old.sqlite');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,n INTEGER,seat TEXT,cwd TEXT,access TEXT,natives TEXT,created_at TEXT,updated_at TEXT); INSERT INTO sessions VALUES('S1',1,'codex','fixture','read-only',NULL,'a','a')"); db.close();
  const store = new Store(file); t.after(() => store.close());
  assert(fs.existsSync(store.backupFile));
  const copy = new DatabaseSync(store.backupFile, { readOnly: true }); assert.equal(copy.prepare('SELECT seat FROM sessions').get().seat, 'codex'); copy.close();
  store.migrateModels(() => 'codex-before');
  const s = store.sessions(); assert.equal(s.items[0].model, 'codex-before'); assert.equal(s.items[0].modelSource, 'migrated'); assert.equal(s.items[0].actualModel, null); assert.equal(s.items[0].modelVerified, 'unknown');
  store.migrateModels(() => 'codex-after'); assert.deepEqual(store.sessions(), s);
});

test('unresolved historical defaults fail before updating any row', t => {
  const { store } = fixture(t);
  store.createSession({ seat: 'codex', cwd: 'fixture' }); store.createSession({ seat: 'deepseek', cwd: 'fixture' });
  const before = store.sessions();
  assert.throws(() => store.migrateModels(p => { if (p === 'deepseek') throw new Error('unresolved'); return 'codex-a'; }), /unresolved/);
  assert.deepEqual(store.sessions(), before);
});

test('session write and revision roll back together on failure; invalid IDs do not advance', t => {
  const { store } = fixture(t); const before = store.sessions();
  const original = store.bumpSessions; store.bumpSessions = () => { throw new Error('revision failure'); };
  assert.throws(() => store.createSession({ seat: 'codex', cwd: 'fixture', model: 'codex-a' }), /revision failure/);
  store.bumpSessions = original; assert.deepEqual(store.sessions(), before);
  assert.throws(() => store.updateSession('S999', { model: 'codex-a' }), /找不到/); assert.deepEqual(store.sessions(), before);
  assert.throws(() => store.sessions(-1), /limit/);
});

function profileFile(root) {
  const f = path.join(root, 'profile.yml');
  fs.writeFileSync(f, '- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n    reasoningEffort: high\n- id: llm-deepseek-account\n  config:\n    models:\n      - id: deepseek-flash\n      - id: deepseek-v4-pro\n'); return f;
}
test('defaults are parsed without guessing and DeepSeek catalog is scoped to active provider', t => {
  const { config, root } = fixture(t); config.codex.defaultModel = null; config.codex.home = root;
  fs.writeFileSync(path.join(root, 'config.toml'), 'model = "codex-a"\n[project]\nmodel = "other"\n'); assert.equal(resolveDefault(config, 'codex'), 'codex-a');
  const f = profileFile(root); config.deepseek.defaultModel = null; config.deepseek.profileFile = f;
  assert.equal(resolveDefault(config, 'deepseek'), 'deepseek-flash'); assert.equal(deepseekProfile(f).provider, 'deepseek-account');
  assert.deepEqual(deepseekModels(f).map(m => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
  fs.writeFileSync(path.join(root, 'config.toml'), '[project]\nmodel="other"'); assert.throws(() => resolveDefault(config, 'codex'), /没有全局/);
  // 读不到登录配置时给的是「下一步怎么做」，不是内部路径/悬空冒号。
  assert.throws(() => deepseekProfile(path.join(root, 'missing')), /登录/);
});

test('DeepSeek UUID patches are unique, retained and cannot overwrite concurrent selections', t => {
  const { config } = fixture(t); const paths = new Set();
  for (let i = 0; i < 20; i++) paths.add(writePatch(config, { provider: 'deepseek-account', model: i % 2 ? 'deepseek-flash' : 'deepseek-v4-pro', effort: 'high' }));
  assert.equal(paths.size, 20); for (const file of paths) assert(fs.existsSync(file));
});

test('DeepSeek durable evidence requires current completed turn, committed response and one model route', t => {
  const { config, root } = fixture(t); const id = 'session-fixture';
  const dir = path.join(config.deepseek.home, 'sessions/workspace', id); fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { type: 'session', version: 4, id, cwd: root },
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'request/header', seq: 2, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const bytes = Buffer.concat(rows.map(x => zstdCompressSync(Buffer.from(JSON.stringify(x) + '\n'))));
  assert.equal(decodeFrames(bytes).split('\n').filter(Boolean).length, rows.length);
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), bytes);
  const evidence = nativeModelEvidence(config, { nativeId: id, cwd: root, startedAt: 1000 });
  assert.equal(evidence.actualModel, 'deepseek-flash'); assert.equal(evidence.modelVerified, 'verified');
  assert.equal(nativeModelEvidence(config, { nativeId: id, cwd: root, afterSeq: 4 }).actualModel, null);
  assert.equal(nativeModelEvidence(config, { nativeId: id, cwd: root, startedAt: 5000 }).actualModel, null);
  assert.equal(nativeModelEvidence(config, { nativeId: '../escape', cwd: root }).actualModel, null);
  assert.throws(() => decodeFrames(bytes.subarray(0, bytes.length - 1)), /不完整/);
});

function fakeCodex(handler, requests) {
  return () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const m = JSON.parse(chunk.toString()); requests.push(m);
      queueMicrotask(() => {
        if (m.id !== undefined) child.stdout.write(JSON.stringify({ id: m.id, result: handler(m) }) + '\n');
        if (m.method === 'turn/start') {
          child.stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId: 'native', turnId: 'turn', item: { type: 'agentMessage', text: 'remembered' } } }) + '\n');
          child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'turn', status: 'completed' } } }) + '\n');
        }
      }); done();
    } }); return child;
  };
}
test('Codex wire parameters send model on start/resume/turn and use same native ID, catalog not entitlement', async t => {
  const { config, root } = fixture(t); config.codex.executable = path.join(root, 'fake-codex'); fs.writeFileSync(config.codex.executable, 'fixture');
  const requests = []; const handler = m => {
    if (m.method === 'thread/start' || m.method === 'thread/resume') return { thread: { id: 'native' }, model: m.params.model };
    if (m.method === 'turn/start') return { turn: { id: 'turn' } };
    if (m.method === 'model/list') return { data: [{ id: 'catalog-id', model: 'codex-a', displayName: 'A' }], nextCursor: null };
    return {};
  };
  const options = { spawnProcess: fakeCodex(handler, requests) };
  const first = await askCodex(config, { prompt: 'remember', model: 'codex-a', timeoutMs: 500 }, options);
  const next = await askCodex(config, { prompt: 'recall', model: 'codex-b', nativeId: first.nativeId, timeoutMs: 500 }, options);
  assert.equal(next.actualModel, 'codex-b'); assert.equal(next.modelVerified, 'verified');
  assert.equal(requests.find(m => m.method === 'thread/resume').params.threadId, 'native');
  assert.deepEqual(requests.filter(m => m.method === 'turn/start').map(m => m.params.model), ['codex-a', 'codex-b']);
  assert.deepEqual(await listCodexModels(config, options), [{ id: 'codex-a', name: 'A', availability: 'configured', efforts: [], defaultEffort: null, images: false }]);
  // 推理强度与图片：随 turn/start 发出
  await askCodex(config, { prompt: 'look', model: 'codex-a', effort: 'high', images: ['C:/x/a.png'], nativeId: first.nativeId, timeoutMs: 500 }, options);
  const last = requests.filter(m => m.method === 'turn/start').at(-1).params;
  assert.equal(last.effort, 'high');
  assert.deepEqual(last.input, [{ type: 'text', text: 'look' }, { type: 'localImage', path: 'C:/x/a.png' }]);
});

test('DeepSeek adapter sets patch model and resume ID; partial answer plus failure is failure, actual stays unknown', async t => {
  const { config, root } = fixture(t); config.deepseek.profileFile = profileFile(root); let args;
  const spawnProcess = (exe, argv) => {
    args = argv; const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, enc, done) { done(); } });
    child.stdin.on('finish', () => queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-native' }) + '\n');
      child.stdout.write(JSON.stringify({ type: 'final', text: 'ok' }) + '\n'); child.emit('close', 0);
    })); return child;
  };
  const r = await askDeepseek(config, { prompt: 'p', model: 'deepseek-v4-pro', nativeId: 'session-native', timeoutMs: 500 }, { spawnProcess });
  assert.equal(args[args.indexOf('--session-id') + 1], 'session-native');
  assert.match(fs.readFileSync(args[args.indexOf('--patch') + 1], 'utf8'), /model: deepseek-v4-pro/);
  assert.equal(r.actualModel, null); assert.equal(r.modelVerified, 'unknown');
  const failing = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, enc, done) { done(); } });
    child.stdin.on('finish', () => queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: 'final', text: 'partial' }) + '\n');
      child.stdout.write(JSON.stringify({ type: 'error', message: 'model unsupported' }) + '\n'); child.emit('close', 0);
    })); return child;
  };
  await assert.rejects(askDeepseek(config, { prompt: 'p', model: 'deepseek-flash', timeoutMs: 500 }, { spawnProcess: failing }), /model unsupported/);
});

test('DeepSeek 固定会话带回创建时的 DSH home；会话丢失标记为未派发（R408 回归）', async t => {
  const { root, config } = fixture(t);
  const pinned = path.join(root, 'pinned-dsh');
  const pinnedProfile = path.join(pinned, 'profiles', 'desktop', 'cordis.patch.yml');
  fs.mkdirSync(path.dirname(pinnedProfile), { recursive: true });
  fs.writeFileSync(pinnedProfile, '- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n');
  const calls = [];
  const spawnWith = lines => (exe, argv, opts) => {
    calls.push({ argv, env: { ...opts.env } });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _enc, done) { done(); } });
    child.stdin.on('finish', () => queueMicrotask(() => {
      for (const line of lines) child.stdout.write(line + '\n');
      child.emit('close', 0);
    }));
    return child;
  };
  const ok = await askDeepseek(config, { prompt: 'p', model: 'deepseek-flash', nativeId: 'session-old', nativeHome: pinned, timeoutMs: 500 },
    { spawnProcess: spawnWith([JSON.stringify({ type: 'session', sessionId: 'session-old' }), JSON.stringify({ type: 'final', text: 'ok' })]) });
  assert.equal(ok.nativeHome, pinned, '结果要带回实际使用的 home，供上层记录');
  assert.equal(calls[0].env.DSH_HOME, pinned, '续用会话必须把 DSH_HOME 指回创建它的目录');
  await assert.rejects(
    askDeepseek(config, { prompt: 'p', model: 'deepseek-flash', nativeId: 'session-lost', nativeHome: pinned, timeoutMs: 500 },
      { spawnProcess: spawnWith([JSON.stringify({ type: 'error', message: 'session "session-lost" does not exist; omit --session-id to start a new Session' })]) }),
    error => error.code === 'NATIVE_SESSION_MISSING' && error.notDispatched === true && error.sessionMissing === 'session-lost'
      && /原会话已不存在/.test(error.message) && /没有开始执行/.test(error.message)
  );
});
