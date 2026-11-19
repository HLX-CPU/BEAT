// 排列顺序（买家指定）：本地模型端在前、顾问居中、拓展坞始终最后。
// 同时锁死「本机智能体」这条线已按买家要求回退：名册里不再有 local:*，工具表里不再有 local_agents。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults, ROOT } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Roster, partnerGroup } from '../src/roster.mjs';
import { TOOLS } from '../src/tools.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

function fixture(t) {
  const root = tempDir('partner-order');
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'fixture' },
    dock: [
      { id: 'dock:aaa', name: '某模型A', enabled: true, model: 'ma' },
      { id: 'dock:bbb', name: '某模型B', enabled: true, model: 'mb' },
    ] };
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  t.after(() => store.close());
  cleanup(t, root);
  return { config, store, roster: new Roster({ config, store, agents: {} }) };
}

test('名册排列：本地端(codex, deepseek, zcode) → 顾问(claude) → 拓展坞（拓展坞之间保持配置顺序）', t => {
  const { roster } = fixture(t);
  assert.deepEqual(Object.keys(roster.status()), ['codex', 'deepseek', 'zcode', 'claude', 'dock:aaa', 'dock:bbb']);
  assert.equal(partnerGroup('codex'), 0);
  assert.equal(partnerGroup('deepseek'), 0);
  assert.equal(partnerGroup('zcode'), 0);
  assert.equal(partnerGroup('claude'), 1);
  assert.equal(partnerGroup('dock:aaa'), 2);
});

test('拓展坞很多时依旧排在最后，顾问永远在中间', t => {
  const { config, store } = fixture(t);
  config.dock = [...config.dock, { id: 'dock:ccc', name: '某模型C', enabled: true, model: 'mc' }];
  const roster = new Roster({ config, store, agents: {} });
  const keys = Object.keys(roster.status());
  assert.deepEqual(keys, ['codex', 'deepseek', 'zcode', 'claude', 'dock:aaa', 'dock:bbb', 'dock:ccc']);
  assert.ok(keys.indexOf('claude') < keys.findIndex(k => k.startsWith('dock:')));
});

test('本机智能体这条线已回退：名册没有 local:*、没有 localAgents 接口、工具表没有 local_agents', t => {
  const { roster } = fixture(t);
  assert.deepEqual(Object.keys(roster.status()).filter(k => k.startsWith('local:')), []);
  assert.equal(typeof roster.localAgents, 'undefined', 'roster 不该再有本机智能体接口');
  assert.equal(TOOLS.local_agents, undefined, 'local_agents 工具应该已经删掉');
  // 2026-10-19：拓展坞也要能通过接口暂停/恢复（15 元用户实测 P3），agent 改为开放字符串。
  assert.equal(TOOLS.beat_agents.schema.properties.agent.enum, undefined, 'agent 允许 codex / deepseek / claude / dock:id');
  assert.match(TOOLS.beat_agents.description, /拓展坞/);
  assert.equal(/本机智能体/.test(TOOLS.beat_agents.description), false);
});

test('看板：排列函数还在，本机智能体分支已彻底移除', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /const partnerRank = a => a\.agent === 'claude' \? 1 : isDockId\(a\.agent\) \? 2 : 0;/);
  assert.match(html, /function orderPartners\(list\)/);
  assert.match(html, /ordered\.map\(card\)/);
  assert.equal(/const local = a\.local === true;/.test(html), false);
  assert.equal(/LOCAL_PARTNERS|LOCAL_NAMES|localHue|\.agent\.local/.test(html), false);
});

test('旧库里的 local:* 会话不会再顶掉服务（迁移必须显式跳过它们）', t => {
  const root = tempDir('legacy-local');
  const store = new Store(path.join(root, 'beat.sqlite'));
  t.after(() => store.close());
  cleanup(t, root);
  store.createSession({ seat: 'codex', cwd: root, access: 'read-only', model: null });
  store.createSession({ seat: 'local:doubao', cwd: root, access: 'read-only', model: null });
  assert.doesNotThrow(() => store.migrateModels(p => ({ codex: 'codex-a' })[p], { skip: p => /^local:/.test(String(p ?? '')) }));
});

test('迁移遇到真正解析不出的席位时仍然拒绝（保护原有语义没被改松）', t => {
  const root = tempDir('legacy-unknown');
  const store = new Store(path.join(root, 'beat.sqlite'));
  t.after(() => store.close());
  cleanup(t, root);
  store.createSession({ seat: 'mystery', cwd: root, access: 'read-only', model: null });
  assert.throws(() => store.migrateModels(() => null, {}), /历史会话默认模型无法解析/);
});
