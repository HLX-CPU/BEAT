import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { askCodex } from '../src/codex-engine.mjs';
import { codexRPC } from '../src/codex-rpc.mjs';
import { Roster } from '../src/roster.mjs';
import { normalizeUsage } from '../src/control-budget.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

function fixture() {
  const cwd = path.join(artifactsRoot(), 'native-session-busy-tests', randomUUID()); fs.mkdirSync(cwd, { recursive: true });
  const executable = path.join(cwd, 'fixture-codex'); fs.writeFileSync(executable, 'mock executable');
  return { cwd, config: { workspace: cwd, codex: { executable, home: cwd }, flow: {}, dock: [], secrets: {} } };
}

function fakeRPC(requests, handler) {
  return () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString()); requests.push(message);
      queueMicrotask(() => {
        if (message.id === undefined) return;
        const answer = handler(message);
        child.stdout.write(JSON.stringify({ id: message.id, ...answer }) + '\n');
        if (message.method === 'turn/start' && !answer.error) {
          child.stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId: 'native-busy', turnId: 'turn', item: { type: 'agentMessage', text: 'resumed successfully' } } }) + '\n');
          child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'native-busy', turn: { id: 'turn', status: 'completed' } } }) + '\n');
        }
      }); done();
    } }); return child;
  };
}

const busy = { code: -32600, message: 'Thread native-busy already has an active writer' };
const success = message => ({ result: message.method === 'thread/resume' || message.method === 'thread/start'
  ? { thread: { id: 'native-busy' }, model: 'fixture-model' } : message.method === 'turn/start' ? { turn: { id: 'turn' } } : {} });

test('JSON-RPC rejection preserves code and exact originating method', async () => {
  const f = fixture(), requests = [], rpc = await codexRPC(f.config, { spawnProcess: fakeRPC(requests, message => message.method === 'thread/resume' ? { error: busy } : success(message)) });
  try { await assert.rejects(rpc.request('thread/resume', { threadId: 'native-busy' }), error => error.rpcCode === -32600 && error.rpcMethod === 'thread/resume'); }
  finally { await rpc.close(); }
});

test('rejected native resume has no submitted turn, no model token estimate and retains original identity', async () => {
  const f = fixture(), requests = [], usage = [], natives = [];
  await assert.rejects(askCodex(f.config, { prompt: 'must not reach model', nativeId: 'native-busy', cwd: f.cwd, model: 'fixture-model', timeoutMs: 500,
    onUsage: value => usage.push(value), onNative: value => natives.push(value) }, {
    spawnProcess: fakeRPC(requests, message => message.method === 'thread/resume' ? { error: busy } : success(message)),
  }), error => {
    assert.equal(error.code, 'NATIVE_SESSION_BUSY'); assert.equal(error.notDispatched, true); assert.equal(error.busy, true); assert.equal(error.noFallback, true);
    assert.equal(error.nativeId, 'native-busy'); assert.equal(error.rpcCode, -32600); assert.equal(error.rpcMethod, 'thread/resume');
    assert.equal(error.nativeBusyEvidence.nativeId, 'native-busy'); assert.equal(error.nativeBusyEvidence.rpcMethod, 'thread/resume');
    assert.equal(error.nativeBusyEvidence.rpcCode, -32600); assert.equal(error.nativeBusyEvidence.turnStarted, false);
    assert.equal(normalizeUsage(error.usage).totalTokens, 0); return true;
  });
  assert.equal(requests.some(message => message.method === 'turn/start'), false);
  assert.equal(requests.some(message => message.method === 'thread/start'), false);
  assert.equal(usage.length, 1); assert.equal(natives.length, 0);
});

test('busy text from a different method or a different RPC failure is never zero-cost resume proof', async () => {
  for (const [method, code, nativeId] of [['initialize', -32600, 'native-busy'], ['turn/start', -32600, 'native-busy'], ['thread/resume', -32000, 'native-busy'], ['thread/start', -32600, undefined]]) {
    const f = fixture(), requests = [];
    await assert.rejects(askCodex(f.config, { prompt: 'input', nativeId, cwd: f.cwd, model: 'fixture-model', timeoutMs: 500 }, {
      spawnProcess: fakeRPC(requests, message => message.method === method ? { error: { ...busy, code } } : success(message)),
    }), error => {
      assert.equal(error.rpcMethod, method); assert.equal(error.rpcCode, code);
      // 别的方法或别的错误码上的 busy 文本不是"零成本复述证据"：不能算 NATIVE_SESSION_BUSY，也不能伪造用量。
      assert.notEqual(error.code, 'NATIVE_SESSION_BUSY'); assert.notEqual(error.busy, true); assert.equal(error.usage, undefined);
      return true;
    });
  }
});

function rosterFixture(native, waits = []) {
  const f = fixture(), data = new Map(), events = [], calls = { codex: 0, deepseek: 0, evidence: 0 }, sessions = { 'conversation:codex': { native: 'native-busy', model: 'fixture-model', cwd: f.cwd } };
  const store = { get: key => data.get(key), set: (key, value) => data.set(key, value), event: (...args) => events.push(args) };
  const roster = new Roster({ config: f.config, store, agents: {
    codex: async options => { calls.codex++; return native(options, f); },
    deepseek: async () => { calls.deepseek++; return { text: 'should not replace the original model' }; },
    nativeEvidence: async () => { calls.evidence++; return { calls: [], sideEffects: 'unknown' }; },
  } });
  const originalRetry = roster.withBusyRetry.bind(roster);
  roster.withBusyRetry = (fn, options) => originalRetry(fn, { ...options, waits });
  const call = role => roster.call({ runId: 'R-native-busy', seat: 'codex', slot: 'codex:exec', role, sessions, cwd: f.cwd,
    models: { codex: 'fixture-model', deepseek: 'deepseek-fixture' }, build: () => 'continue original task' });
  return { ...f, roster, sessions, calls, events, call };
}

for (const role of ['think', 'write', 'desktop']) {
  test(`native busy preserves identity and health without stale side effects in ${role}`, async () => {
    const requests = [], f = rosterFixture((options, { config }) => askCodex(config, options, {
      spawnProcess: fakeRPC(requests, message => message.method === 'thread/resume' ? { error: busy } : success(message)),
    }));
    await assert.rejects(f.call(role), error => error.code === 'NATIVE_SESSION_BUSY' && error.actualAgent === 'codex' && error.notDispatched === true && error.noFallback === true);
    assert.deepEqual(f.calls, { codex: 1, deepseek: 0, evidence: 0 });
    assert.equal(f.roster.state('codex').status, 'online'); assert.equal(f.sessions['conversation:codex'].native, 'native-busy');
    assert.equal(f.sessions['codex:exec:codex'].nativeDesktop, undefined);
  });
}

test('busy backoff resumes original native thread when its writer becomes free', async () => {
  let resumes = 0; const requests = [], f = rosterFixture((options, { config }) => askCodex(config, options, {
    spawnProcess: fakeRPC(requests, message => message.method === 'thread/resume' && ++resumes === 1 ? { error: busy } : success(message)),
  }), [0]);
  // Use a read-only request: this test concerns ownership, not workspace tool evidence.
  const result = await f.call('think');
  assert.equal(result.by, 'codex'); assert.equal(result.nativeId, 'native-busy'); assert.equal(f.calls.codex, 2); assert.equal(f.calls.deepseek, 0);
  assert.deepEqual(requests.filter(message => message.method === 'thread/resume').map(message => message.params.threadId), ['native-busy', 'native-busy']);
  assert.equal(requests.filter(message => message.method === 'turn/start').length, 1); assert.equal(f.roster.state('codex').status, 'online');
});

test('legacy busy retry exhaustion cannot fallback or mark original agent offline', async () => {
  const f = rosterFixture(async () => { throw new Error('already has an active writer'); });
  await assert.rejects(f.call('write'), error => error.busy === true && error.noFallback === true && error.actualAgent === 'codex' && error.notDispatched !== true);
  assert.equal(f.calls.deepseek, 0); assert.equal(f.roster.state('codex').status, 'online');
});
