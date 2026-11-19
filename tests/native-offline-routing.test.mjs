// 用户确认的产品逻辑：没有桌面端的一方显示离线，不能算可用执行搭档；
// 有桌面端的一方用自己桌面端的原生工具，BEAT 电脑助手只给拓展坞。
// 这里的"安装"由测试自己造出来的真实文件 + 注入的安装探针组成，不代表本机真实安装。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeAvailability } from '../src/native-runtime.mjs';

test('an installation probe failure stays unknown rather than claiming the desktop is missing', () => {
  const result = nativeAvailability({}, 'codex', { codexDesktopInstalled: () => { throw new Error('probe timeout'); } });
  assert.equal(result.installed, null);
  assert.equal(result.available, false);
  assert.match(result.reason, /probe timeout/);
});
import { Roster } from '../src/roster.mjs';
import { defaults } from '../src/config.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { Store } from '../src/store.mjs';

const MISSING = path.join(os.tmpdir(), 'beat-not-installed-' + Math.random().toString(36).slice(2), 'missing.exe');
function installedRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-native-' + label + '-'));
  const executable = path.join(dir, 'DeepSeek Harness.exe'); fs.writeFileSync(executable, 'fixture');
  const cli = path.join(dir, 'cli.js'); fs.writeFileSync(cli, 'fixture');
  const profile = path.join(dir, 'cordis.patch.yml'); fs.writeFileSync(profile, '- id: agent-default-model\n');
  return { executable, cli, profile };
}
// 四个场景：只有 Codex / 只有 DeepSeek / 都有 / 都没有。
function scenario({ codex, deepseek }) {
  const files = deepseek ? installedRoot('ds') : null;
  const codexExe = codex ? path.join(installedRoot('cx').executable.replace('DeepSeek Harness.exe', 'codex.exe')) : MISSING;
  if (codex) fs.writeFileSync(codexExe, 'fixture');
  return {
    config: { codex: { executable: codexExe, home: MISSING }, deepseek: files
      ? { executable: files.executable, cli: files.cli, profileFile: files.profile }
      : { executable: MISSING, cli: MISSING, profileFile: MISSING } },
    // 注入 DeepSeek 发现结果：否则本机真实装了桌面端会把"离线"场景变成在线（测试不能依赖开发机）。
    probe: {
      codexDesktopInstalled: () => codex,
      deepseekRuntime: () => files
        ? { executable: files.executable, cli: files.cli, profileFile: files.profile }
        : { executable: '', cli: '', profileFile: '' },
    },
  };
}

test('只有 Codex 桌面端：Codex 在线，DeepSeek 离线', () => {
  const { config, probe } = scenario({ codex: true, deepseek: false });
  const codex = nativeAvailability(config, 'codex', probe);
  assert.equal(codex.installed, true); assert.equal(codex.available, true);
  const deepseek = nativeAvailability(config, 'deepseek', probe);
  assert.equal(deepseek.installed, false);
  assert.equal(deepseek.available, false);
  assert.match(deepseek.reason, /未检测到 DeepSeek Harness 桌面端/);
  assert.match(deepseek.reason, /安装后打开一次/);
});

test('只有 DeepSeek 桌面端：DeepSeek 在线，Codex 离线', () => {
  const { config, probe } = scenario({ codex: false, deepseek: true });
  const codex = nativeAvailability(config, 'codex', probe);
  assert.equal(codex.installed, false);
  assert.equal(codex.available, false);
  assert.match(codex.reason, /未检测到 Codex 桌面端/);
  const deepseek = nativeAvailability(config, 'deepseek', probe);
  assert.equal(deepseek.installed, true); assert.equal(deepseek.available, true);
});

test('两者都没有：两个原生搭档都离线，且不说成"未配置"', () => {
  const { config, probe } = scenario({ codex: false, deepseek: false });
  assert.equal(nativeAvailability(config, 'codex', probe).available, false);
  assert.equal(nativeAvailability(config, 'deepseek', probe).available, false);
});

test('两者都有：两个原生搭档都在线，工具来源仍是各自桌面端', () => {
  const { config, probe } = scenario({ codex: true, deepseek: true });
  for (const agent of ['codex', 'deepseek']) {
    const r = nativeAvailability(config, agent, probe);
    assert.equal(r.available, true, agent + ' 应在线');
    assert.equal(r.toolSource, 'native-desktop'); assert.equal(r.toolsVerified, false, '安装/能力检测不等于工具已验证');
  }
});

test('名册按安装结果显示离线，离线搭档不进入可用候选', () => {
  const { config: nativeConfig, probe } = scenario({ codex: false, deepseek: true });
  const config = { ...defaults(path.join(os.tmpdir(), 'beat-offline-' + Math.random().toString(36).slice(2))), dock: [] };
  const kv = new Map(), events = [];
  const store = { get: k => kv.get(k), set: (k, v) => kv.set(k, v), event: (...a) => events.push(a) };
  const roster = new Roster({ config, store, agents: { nativeAvailability: agent => nativeAvailability(nativeConfig, agent, probe), codex: async () => ({}), deepseek: async () => ({}) } });
  assert.equal(roster.state('codex').status, 'offline');
  assert.match(roster.state('codex').reason, /未检测到 Codex 桌面端/);
  assert.equal(roster.state('deepseek').status, 'online');
  assert.deepEqual(roster.candidates('codex', 'desktop'), ['deepseek'], '离线的 Codex 不能被选来执行');
  assert.deepEqual(roster.candidates('deepseek', 'think'), ['deepseek']);
});

test('指定离线的原生搭档提问时给人话错误，不静默换人', () => {
  const { config: nativeConfig, probe } = scenario({ codex: false, deepseek: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-offline-ask-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 'fixture' }, dock: [] };
  config.codex.defaultModel = 'codex-fixture'; config.deepseek.defaultModel = 'deepseek-fixture';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  const called = [];
  const orch = new Orchestrator({ config, store, agents: {
    nativeAvailability: agent => nativeAvailability(nativeConfig, agent, probe),
    codex: async () => { called.push('codex'); return { text: '不应被调用' }; },
    deepseek: async () => { called.push('deepseek'); return { text: '不应被调用' }; },
  } });
  try {
    assert.throws(() => orch.startAsk({ to: 'codex', question: '打开记事本' }), /未检测到 Codex 桌面端/);
    assert.deepEqual(called, [], '离线搭档不能接到任务，也不能偷偷交给别的模型');
  } finally { store.close(); }
});
