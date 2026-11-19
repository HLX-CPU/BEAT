import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Roster } from '../src/roster.mjs';

function setup(desktopDock) {
  const id = 'dock:rework', kv = new Map(), sessions = {};
  const config = { flow: { cooldownMin: 30 }, dock: [{ id, name: '桌面测试搭档', model: 'glm-5.3', baseUrl: 'https://example.invalid/v1', enabled: true }], secrets: { dockKeys: { [id]: 'fixture' } } };
  const store = { get: key => kv.get(key), set: (key, value) => kv.set(key, value), event: () => {} };
  const roster = new Roster({ config, store, agents: { desktopDock } });
  const call = (executionKey, build = () => '桌面指令') => roster.call({ runId: 'R-fixture', seat: id, role: 'desktop', slot: id + ':exec', sessions, executionKey, build, persist: () => {} });
  return { call, sessions, id };
}

test('相同 semantic executionKey 复用 succeeded 证据；不同返工 key 才调用新桌面任务', async () => {
  let launches = 0;
  const { call } = setup(async (_id, opts) => { launches++; return { status: 'succeeded', desktopTaskId: 'D-' + launches, text: '已验证', history: [], promptHash: 'hash-' + launches }; });
  const first = await call('same-operation');
  const resumed = await call('same-operation', () => '增加恢复说明但操作不变');
  assert.equal(launches, 1); assert.equal(resumed.desktopTaskId, first.desktopTaskId);
  const rework = await call('changed-operation', () => '只补新的焦点恢复动作');
  assert.equal(launches, 2); assert.equal(rework.desktopTaskId, 'D-2');
});

test('桌面未知副作用错误保留 evidence，不换其他搭档重放', async () => {
  let attempts = 0;
  const { call, sessions, id } = setup(async () => { attempts++; const e = new Error('DESKTOP_REPLAY_REQUIRES_REVIEW'); e.code = 'DESKTOP_REPLAY_REQUIRES_REVIEW'; e.desktopTaskId = 'D-uncertain'; e.desktopEvidence = { status: 'unverified', calls: [{ evidence: { sideEffects: 'unknown' } }] }; throw e; });
  await assert.rejects(call('input'), e => e.desktopTaskId === 'D-uncertain' && e.desktopEvidence.calls[0].evidence.sideEffects === 'unknown');
  assert.equal(attempts, 1);
  assert.equal(sessions[id + ':exec:' + id].desktopTaskId, 'D-uncertain');
  assert.equal(sessions[id + ':exec:' + id].desktop.status, 'unverified');
});
