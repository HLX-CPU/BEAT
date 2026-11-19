import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';

function fixture(t) {
  const parent = 'E:/beat/workspaces/control-native-budget-tests';
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'ask-resend-'));
  const config = defaults(root);
  config.root = root;
  config.dataDir = path.join(root, 'data');
  config.codex.defaultModel = 'fixture-codex';
  config.deepseek.defaultModel = 'fixture-deepseek';
  const store = new Store(':memory:');
  t.after(() => store.close());
  const orch = new Orchestrator({config, store, agents: {}});
  orch.roster.state = () => ({status: 'online'});
  orch.prepareGoalRun = () => true;
  const old = store.createSession({seat: 'codex', model: 'selected-model', model_source: 'explicit', cwd: config.workspace});
  store.updateSession(old.id, {effort: 'max'});
  const ask = args => orch.startAsk({to: 'codex', question: 'Review this batch only', access: 'read-only', session_id: old.id, ...args});
  return {store, orch, old: store.session(old.id), ask};
}

test('explicit resend starts cold, retains model/workspace/history and lowers inherited max to high', t => {
  const f = fixture(t);
  const first = f.ask();
  const before = f.store.session(f.old.id);
  assert.throws(() => f.ask(), {code: 'ASK_REPEAT_DUPLICATE'});
  f.orch.setSessionModel = () => assert.fail('Rejected duplicate must not mutate model selection');
  assert.throws(() => f.ask({model: 'another-model'}), {code: 'ASK_REPEAT_DUPLICATE'});
  assert.equal(f.store.runs(20).length, 1);
  const resent = f.ask({allowRepeat: true});
  assert.notEqual(resent.session_id, first.session_id);
  const fresh = f.store.session(resent.session_id);
  assert.equal(fresh.model, 'selected-model');
  assert.equal(fresh.effort, 'high');
  assert.equal(fresh.cwd, before.cwd);
  assert.ok(!fresh.native_id);
  assert.deepEqual(f.store.session(f.old.id), before);
  assert.match(f.store.events(20).find(x => x.run_id === resent.id).text, /全新会话/);
});

test('explicit resend with a different model leaves the previous session unchanged', t => {
  const f = fixture(t);
  const before = f.store.session(f.old.id);
  f.orch.setSessionModel = () => assert.fail('Cold resend must not switch an existing native session');
  const run = f.ask({allowRepeat: true, model: 'gpt-6-luna', effort: 'max'});
  assert.equal(f.store.session(run.session_id).model, 'gpt-6-luna');
  assert.equal(f.store.session(run.session_id).effort, 'max', 'Explicit requested MAX must remain MAX');
  assert.deepEqual(f.store.session(f.old.id), before);
});

test('API resend rejects changed configured model instead of recording a false inherited model', t => {
  const f = fixture(t);
  f.orch.config.claude.model = 'current-advisor';
  const old = f.store.createSession({seat: 'claude', model: 'previous-advisor', cwd: f.old.cwd});
  const before = f.store.session(old.id);
  assert.throws(() => f.orch.startAsk({to: 'claude', question: 'Review current evidence', access: 'read-only', session_id: old.id, allowRepeat: true}), /型号已变更/);
  assert.equal(f.store.runs(10).length, 0);
  assert.deepEqual(f.store.session(old.id), before);
  const retried = f.orch.startAsk({to: 'claude', question: 'Review current evidence', access: 'read-only', session_id: old.id, allowRepeat: true, model: 'current-advisor'});
  assert.notEqual(retried.session_id, old.id);
  assert.equal(f.store.session(retried.session_id).model, 'current-advisor');
  assert.deepEqual(f.store.session(old.id), before);
});

test('explicit resend cannot bypass exhausted rolling budget or create another session/run', t => {
  const f = fixture(t);
  f.ask();
  f.orch.config.flow.askTokenBudget = 1;
  // Provider usage is injected at the same public ledger boundary as production.
  const previous = f.store.runs(10)[0];
  f.store.set('controlMetrics:' + previous.id, {records: [{tokens: 2, measurement: 'provider', phase: 'discussion', seat: 'codex'}]});
  const before = f.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  assert.throws(() => f.ask({allowRepeat: true}), {code: 'ASK_TOKEN_BUDGET'});
  assert.equal(f.store.runs(20).length, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, before);
});
