// 「搭档掉线怎么办」的两条产品规则：
//   1) 讨论里某位掉线 → 先让在线搭档代答；一个都接不上就跳过它，其余继续（不再把整轮讨论判死）。
//   2) 并行任务里点名的执行搭档掉线 → 跳过它并由 BEAT 改派给在线搭档（queue-runner 的 taskRouting 已验证）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { Roster } from '../src/roster.mjs';
import { defaults } from '../src/config.mjs';
import { registerAgentNames } from '../src/prompts.mjs';

const DOCK = 'dock:tail';
function fixture(agents, extraDocks = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-offline-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 't', claudeApiKey: 'sk-test-key-123456', dockKeys: { [DOCK]: 'k' } } };
  config.codex = { ...config.codex, defaultModel: 'codex-fixture' };
  config.deepseek = { ...config.deepseek, defaultModel: 'deepseek-fixture' };
  config.dock = [{ id: DOCK, name: '掉落拓展坞', enabled: true, model: 'tail-model', baseUrl: 'https://example.invalid/v1' }, ...extraDocks];
  config.flow = { ...config.flow, compactDiscussion: false, pullQueue: false, discussionRetryDelays: [], skipFailedDiscussion: true };
  registerAgentNames(config.dock);
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  // 拓展坞在 BEAT 里是一个派发函数（agents.dock(id, opts)），不是一个以 id 命名的键。
  const dock = agents?.dock;
  const wired = dock ? { ...agents, dock: (id, opts) => dock(id, opts) } : agents;
  return { config, store, orch: new Orchestrator({ config, store, agents: wired }) };
}
async function finished(orch, id) {
  for (let i = 0; i < 400; i++) { const run = orch.store.run(id); if (orch.isFinal(run.state) && !orch.active.has(id)) return run; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('fixture run timed out');
}

test('固定搭档不可用时不给含糊报错：NO_SUCCESSOR 要带原因和状态', async () => {
  const { config, store, orch } = fixture({});
  const roster = new Roster({ config, store, agents: { codex: async () => ({ text: 'ok' }), deepseek: async () => ({ text: 'ok' }) } });
  roster.saveHealth({ [DOCK]: { paused: true } });
  let caught;
  try { await roster.call({ runId: 'R1', seat: DOCK, role: 'think', onlyAgent: true, build: () => 'x', sessions: {} }); } catch (e) { caught = e; }
  assert.equal(caught?.code, 'NO_SUCCESSOR', '要带机器可判的代码，上层才能"跳过它、继续跑"');
  assert.equal(caught?.seat, DOCK);
  assert.match(caught.message, /掉落拓展坞( · tail-model)? 当前不可用（已暂停）/, '要说清是哪一位、什么状态');
  assert.doesNotMatch(caught.message, /其余各方均已暂停或未配置/, '自己不可用就不要甩锅给"其余各方"');
  // 允许接替时（onlyAgent=false）由在线搭档代答，不再报错
  const r = await roster.call({ runId: 'R1', seat: DOCK, role: 'think', onlyAgent: false, build: () => 'x', sessions: {}, models: { codex: 'codex-fixture', deepseek: 'deepseek-fixture' } });
  assert.ok(r.text, '有在线搭档时应该代答成功');
});

test('讨论里搭档掉线：要么在线搭档代答、要么跳过它，绝不把整轮讨论卡死', async () => {
  let dockCalls = 0;
  const agree = () => ({ text: JSON.stringify({ stance: 'agree', summary: '同意', open_issues: [], plan: null }) });
  const { config, store, orch } = fixture({
    codex: agree, deepseek: agree,
    dock: async id => { dockCalls++; throw new Error(`${id}：服务端故障（HTTP 502）`); },
  });
  const run = orch.startDiscuss({ goal: '讨论一件简单的事' });
  const done = await finished(orch, run.id);
  assert.ok(dockCalls >= 1, '掉线的那位确实被调用过并失败');
  const events = store.events(200).map(e => String(e.text)).join('\n');
  const skipped = (store.get('discussionSkipped:' + run.id) || []).some(s => s.agent === DOCK);
  const substituted = /改由 .*（代 /.test(events);
  assert.ok(substituted || skipped, '掉线的搭档要么由在线搭档代答、要么被跳过，不能原地卡死');
  assert.match(events, /代 |自动跳过失败搭档/, '看板动态里要能看出"谁顶上了它"或"已跳过它"');
  assert.notEqual(done.state, 'error', '不能因为一位掉线就整轮报错：' + done.error);
  assert.doesNotMatch(events, /这一步没有可用的接替者/, '不该再出现"没有可用的接替者"这种死胡同话术');
});

test('顾问不以讨论参与者身份出现，但裁决时仍然要能叫到它本人', async () => {
  const { config, store, orch } = fixture({});
  const roster = orch.roster;
  // R150 的参与者里没有 claude（顾问只在失败/受阻时才加入），旧逻辑会把 claude 过滤掉 → 由别人代答 → 裁决作废
  const list = roster.candidates('claude', 'think', [], ['codex', 'deepseek', DOCK]);
  assert.equal(list[0], 'claude', '裁决席位必须能叫到顾问本人：' + JSON.stringify(list));
  assert.ok(list.includes('claude'));
  const advisor = roster.candidates('advisor', 'think', [], ['codex', 'deepseek']);
  assert.ok(advisor.includes('claude'), '顾问席位同理');
  // 参与者过滤对普通座位仍然有效：执行座位不会把没参与的一方拉进来
  const exec = roster.candidates('codex', 'write', [], ['codex', 'deepseek']);
  assert.ok(!exec.includes(DOCK), '没参与的拓展坞不能被当成执行接替者');
});

test('讨论循环里 NO_SUCCESSOR 被当成"可跳过"而不是"致命错误"（防回归）', () => {
  const source = fs.readFileSync(new URL('../src/orchestrator.mjs', import.meta.url), 'utf8');
  assert.match(source, /error\?\.code==='NO_SUCCESSOR'\|\|/, 'NO_SUCCESSOR 必须进 removable：否则掉线会直接判死整轮');
  assert.match(source, /掉线或不可用，这一步没有可接替的搭档，已跳过它/, '跳过原因要写成人话');
  const rosterSource = fs.readFileSync(new URL('../src/roster.mjs', import.meta.url), 'utf8');
  assert.match(rosterSource, /error\.code = 'NO_SUCCESSOR'/, 'roster 要给出可判定的错误码');
});
