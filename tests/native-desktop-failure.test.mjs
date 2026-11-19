import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Roster } from '../src/roster.mjs';

function setup(native, { deepseekReceipt = null } = {}) {
  const id = 'dock:native-fallback', kv = new Map(), sessions = {}, calls = { native: 0, dock: 0, deepseek: 0 };
  // 这一组测的是"未知桌面副作用不许自动换人重放"的严格行为——客户默认已放开，
  // 所以这里显式打开严格模式，守住机制本身。
  const config = { flow: { cooldownMin: 30, quarantineUnknown: true }, dock: [{ id, name: 'GLM 测试替身', enabled: true, model: 'glm-5.3', baseUrl: 'https://example.invalid/v1' }], secrets: { dockKeys: { [id]: 'fixture' } } };
  const store = { get: key => kv.get(key), set: (key, value) => kv.set(key, value), event: () => {} };
  const roster = new Roster({ config, store, agents: {
    codex: async opts => { calls.native++; return native(opts); },
    deepseek: async opts => { calls.deepseek++; return { text: '原生仓库接手', ...(deepseekReceipt && opts.role === 'desktop' ? { nativeToolEvidence: deepseekReceipt() } : {}) }; },
    desktopDock: async () => { calls.dock++; return { status: 'succeeded', desktopTaskId: 'D-fallback', text: '桌面已验证', history: [] }; },
  } });
  const call = (role = 'desktop') => roster.call({ runId: 'R-native', seat: 'codex', slot: 'codex:exec', role, sessions,
    executionKey: 'desktop-op', models: { codex: 'codex-fixture', deepseek: 'deepseek-fixture' }, build: () => '操作桌面', persist: () => {} });
  return { roster, calls, sessions, call, id };
}

for (const message of ['429 quota exceeded after input', 'timeout after sending input']) {
  test('原生 desktop 出错不能换 GLM 重放：' + message, async () => {
    const { call, calls, sessions, roster } = setup(async opts => { opts.onNative('native-fixture'); throw new Error(message); });
    await assert.rejects(call(), e => e.noFallback && e.desktopEvidence?.sideEffects === 'unknown');
    assert.deepEqual(calls, { native: 1, dock: 0, deepseek: 0 });
    assert.equal(sessions['codex:exec:codex'].nativeDesktop.status, 'unverified');
    assert.equal(roster.state('codex').status, 'cooldown');
    await assert.rejects(call(), e => e.code === 'DESKTOP_REPLAY_REQUIRES_REVIEW');
    assert.deepEqual(calls, { native: 1, dock: 0, deepseek: 0 }, '恢复不能重做不确定输入');
    roster.markUp('codex', 'R-native');
    await assert.rejects(call(), e => e.code === 'DESKTOP_REPLAY_REQUIRES_REVIEW');
  });
}

test('旧设置quarantineUnknown=false仍禁止重新派发未知原生电脑输入', async () => {
  const { call, calls, roster } = setup(async opts => { opts.onNative('native-unsafe'); throw Error('timeout after input'); });
  roster.config.flow.quarantineUnknown = false;
  await assert.rejects(call(), e => e.noFallback && e.desktopEvidence?.sideEffects === 'unknown');
  roster.markUp('codex', 'R-native');
  await assert.rejects(call(), e => e.code === 'DESKTOP_REPLAY_REQUIRES_REVIEW');
  assert.equal(calls.native, 1); assert.equal(calls.dock + calls.deepseek, 0);
});

test('明确 spawn ENOENT 未启动可以接替 desktop：原生搭档自带回执或由 dock 接手', async () => {
  // 接替顺序是中性抽签，两种接替者都可能被选中：另一位原生搭档必须带自己的原生工具回执，dock 走电脑助手。
  const { call, calls } = setup(async () => { throw new Error('无法启动 Codex：spawn codex ENOENT'); }, { deepseekReceipt: () => nativeReceipt() });
  const r=await call();assert.ok(['deepseek','dock:native-fallback'].includes(r.by));
  assert.equal(calls.native,1);assert.equal(calls.dock+calls.deepseek,1);
});

test('结构化输入未派发可以换桌面搭档；预先暂停 native 直接选择 dock', async () => {
  const first = setup(async () => { const e = new Error('没有派发输入'); e.evidence = { sideEffects: 'none' }; throw e; });
  first.roster.setPaused('deepseek',true);
  assert.equal((await first.call()).desktopTaskId, 'D-fallback');
  const paused = setup(async () => { throw new Error('不应调用已暂停 native'); });
  paused.roster.setPaused('codex', true);
  paused.roster.setPaused('deepseek', true);
  assert.equal((await paused.call()).desktopTaskId, 'D-fallback');
  assert.deepEqual(paused.calls, { native: 0, dock: 1, deepseek: 0 });
});

test('原生可写失败保守记录未知副作用，不自动换人重放', async () => {
  const { call, calls, sessions } = setup(async () => { throw new Error('429 quota exceeded'); });
  await assert.rejects(call('write'), e => e.noFallback && e.desktopEvidence?.sideEffects === 'unknown');
  assert.deepEqual(calls, { native: 1, dock: 0, deepseek: 0 }, '可写调用出错后不能把它交给另一个模型重放');
  // 文件写入的未知副作用记在 nativeWrite（审计证据）；桌面输入的未知副作用才挡自动重放。
  assert.equal(sessions['codex:exec:codex'].nativeWrite.status, 'unverified');
  assert.equal(sessions['codex:exec:codex'].nativeDesktop, undefined);
  assert.equal(sessions['codex:exec:codex'].nativeWrite.source, 'native-workspace');
});

// 原生搭档用自己的桌面端工具，证据来自 nativeToolEvidence（原生工具日志），不再是旧的 agents.nativeEvidence 钩子。
const nativeReceipt = over => ({
  source: 'fixture-native-tool-log',
  calls: [{ id: 'n1', tool: 'window_focus', status: 'completed', failed: false, record: { result: { calls: [{ tool: 'window_focus', status: 'verified', evidence: { sideEffects: 'focus', verification: { status: 'verified', checks: [{ pass: true }] } } }] } } }],
  verifiedActions: [{ tool: 'window_focus', nativeCallId: 'n1', evidence: { sideEffects: 'focus', verification: { status: 'verified', checks: [{ pass: true }] } } }],
  verification: { status: 'verified' }, ...over,
});

test('已验证原生电脑任务在相同执行 key 恢复时复用证据，不再次输入',async()=>{
 const {call,calls}=setup(async()=>({text:'## 交付报告 已完成',nativeToolEvidence:nativeReceipt()}));
 const first=await call(),resumed=await call();
 assert.equal(first.desktopEvidence.verification.status,'verified');
 assert.equal(first.executionReused,undefined);
 assert.equal(resumed.executionReused,true);assert.equal(calls.native,1,'相同执行 key 复用真实证据，不重复输入');
});

test('原生 desktop 仅声称成功或没有可核验回执均不得通过',async()=>{
 for(const receipt of [undefined,nativeReceipt({calls:[{id:'n1',tool:'window_focus',status:'completed',failed:false,record:{result:{calls:[{tool:'window_focus',status:'completed',evidence:{sideEffects:'unknown',verification:{status:'unverified',checks:[]}}}]}}}],verifiedActions:[],verification:{status:'unverified'}})]){
  const {call,calls}=setup(async()=>({text:'## 交付报告 打开成功',...(receipt?{nativeToolEvidence:receipt}:{})}));
  await assert.rejects(call(),e=>e.noFallback&&/尚未独立核验/.test(e.message));assert.equal(calls.dock+calls.deepseek,0);
 }
});
