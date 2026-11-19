import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, CONTROL_FLOW_DEFAULTS, loadConfig, saveSettings } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { negotiateCompact } from '../src/compact-discussion.mjs';

import { tempDir } from './helpers/temp.mjs';

function fixture(extra = {}) {
  // 临时目录走系统 temp，不再往生产的 data/ 里堆 control-settings-test-* 垃圾。
  const root = tempDir('settings');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ workspace: root, ...extra }));
  return loadConfig(root);
}

function snapshotFixture(t) {
  // 讨论预算要留足余量：每次答复的准入预估包含"提示词里的绝对路径"，路径变长（深目录/自检副本）
  // 会让第二位搭档的预留被压缩到 <128 token 而失败（实测：5000 预算在长路径下会直接报预算到限）。
  // 这里测的是"快照是否固定"，把数值放大到 20000/30000 不影响断言含义，却能稳定通过任意路径长度。
  let cfg = fixture({ flow: { taskTokenBudget: 4000, discussionTokenBudget: 20000, executionTokenBudget: 12000 } });
  cfg = saveSettings(cfg, { allowedRoots: [cfg.root] }); cfg.skipAcl = true;
  const store = new Store(path.join(cfg.dataDir, 'snapshot.sqlite')), calls = [];
  const choices = { route: 'A', sequence: 'A', risk: 'A' };
  const agents = Object.fromEntries(['codex', 'deepseek'].map(seat => [seat, async options => {
    const stage = /阶段=([a-z]+)/.exec(options.prompt)?.[1] || 'budget'; calls.push({ seat, stage });
    const nativeId = options.nativeId || `settings-fixture-${seat}-${calls.length}`; options.onNative?.(nativeId);
    let answer;
    if (stage === 'outline') answer = { core: '接口处理', steps: ['实现'], risks: ['检查异常'], decisions: Object.keys(choices).map(id => ({ id, option: 'A', reason: '可靠', category: 'ordinary', serious: false })) };
    else if (stage === 'expand') answer = { summary: '方案概览', decisions: choices, plan: null, sections: Object.keys(choices).map(id => ({ id, title: id, content: '完整具体方案' })) };
    else if (stage === 'review') answer = { verdict: 'pass', issues: [], planHash: /hash=([a-f\d]{64})/.exec(options.prompt)[1] };
    else if (stage === 'budget') answer = 'fixture budget evidence';
    else throw new Error('unexpected fixture stage: ' + stage);
    return { nativeId, text: typeof answer === 'string' ? answer : JSON.stringify(answer), usage: { totalTokens: 100, inputTokens: 50, outputTokens: 50, source: 'dummy-provider' } };
  }]));
  const orch = new Orchestrator({ config: cfg, store, agents });
  // Exercise real start methods without their asynchronous automatic execution.
  orch.launch = () => {}; orch.pump = () => {};
  t.after(() => store.close());
  return { cfg, store, orch, calls };
}

test('新任务完整设置快照固定预算和各开关，保存只影响后续任务且数组不共享', t => {
  const f = snapshotFixture(t);
  const original = f.orch.startParallel({ goal: '原任务', cwd: f.cfg.root });
  const switches = Object.keys(CONTROL_FLOW_DEFAULTS).filter(key => CONTROL_FLOW_DEFAULTS[key] === true && key !== 'quarantineUnknown');
  const changed = saveSettings(f.cfg, { flow: { ...Object.fromEntries(switches.map(key => [key, false])), taskTokenBudget: 8000, discussionTokenBudget: 30000, executionTokenBudget: 20000, cheapAgents: ['codex'] } });
  f.orch.setConfig(changed);
  const newer = f.orch.startDiscuss({ question: '新任务', cwd: changed.root });
  for (const key of switches) {
    assert.equal(f.orch.flowFor(original)[key], true, key + ' remains enabled on the original task');
    assert.equal(f.orch.flowFor(newer)[key], false, key + ' uses newly saved settings');
  }
  assert.equal(f.orch.flowFor(newer).quarantineUnknown, true, '未知输入保护不是可关闭的流程开关');
  const proposed = { tasks: [{ id: 'one', title: 'one', tokenBudget: 999999 }], acceptance: ['明确结果'] };
  assert.equal(f.orch.compileControlledPlan(original, proposed).tasks[0].tokenBudget, 4000);
  assert.equal(f.orch.compileControlledPlan(newer, proposed).tasks[0].tokenBudget, 8000);
  assert.equal(f.orch.flowFor(original).discussionTokenBudget, 20000);
  assert.equal(f.orch.flowFor(original).executionTokenBudget, 12000);
  assert.deepEqual(f.orch.flowFor(original).cheapAgents, ['deepseek']);
  assert.deepEqual(f.orch.flowFor(newer).cheapAgents, ['codex']);
  changed.flow.cheapAgents.push('deepseek'); f.cfg.flow.cheapAgents.push('codex');
  assert.deepEqual(f.orch.flowFor(original).cheapAgents, ['deepseek']);
  assert.deepEqual(f.orch.flowFor(newer).cheapAgents, ['codex']);
  const returned = f.orch.flowFor(original); returned.cheapAgents.push('mutated-return');
  assert.deepEqual(f.orch.flowFor(original).cheapAgents, ['deepseek']);
  const legacy = f.store.createRun({ kind: 'parallel', goal: '旧格式无快照', cwd: changed.root, initiator: 'codex' });
  assert.equal(f.orch.flowFor(legacy).taskTokenBudget, 8000, 'pre-snapshot tasks preserve documented live-config fallback');
  assert.equal(f.calls.length, 0, 'starting/saving these fixtures dispatches no model calls');
});

test('真实控制器预算账本和精简评审使用任务快照，后保存开关不改变原任务流程', async t => {
  const f = snapshotFixture(t);
  const original = f.orch.startDiscuss({ question: '原讨论', cwd: f.cfg.root });
  const changed = saveSettings(f.cfg, { flow: { taskTokenBudget: 8000, discussionTokenBudget: 30000, executionTokenBudget: 20000, planReview: false, disputeVoting: false } });
  f.orch.setConfig(changed);
  const newer = f.orch.startDiscuss({ question: '新讨论', cwd: changed.root });
  const signal = new AbortController().signal;
  await f.orch.controlCall(original, { role: 'evaluate', seat: 'codex', call: 'think', signal, sessions: {}, build: () => '预算验证' }, { phase: 'execution', taskId: 'evidence', budget: 999999, maxOutputTokens: 300 });
  const oldLedger = f.store.get('controlMetrics:' + original.id);
  assert.equal(oldLedger.phases.execution.budget, 12000); assert.equal(oldLedger.tasks.evidence.budget, 4000);
  await f.orch.controlCall(newer, { role: 'evaluate', seat: 'codex', call: 'think', signal, sessions: {}, build: () => '预算验证' }, { phase: 'execution', taskId: 'evidence', budget: 999999, maxOutputTokens: 300 });
  const newLedger = f.store.get('controlMetrics:' + newer.id);
  assert.equal(newLedger.phases.execution.budget, 20000); assert.equal(newLedger.tasks.evidence.budget, 8000);
  const first = f.calls.length;
  const oldResult = await negotiateCompact(f.orch, original, signal, {}, 'discuss');
  assert.equal(oldResult.consensus, true);
  assert.equal(f.calls.slice(first).filter(call => call.stage === 'review').length, 1, 'old planReview remains enabled');
  assert.equal(f.store.get('controlMetrics:' + original.id).phases.discussion.budget, 20000);
  const second = f.calls.length;
  const newResult = await negotiateCompact(f.orch, newer, signal, {}, 'discuss');
  assert.equal(newResult.consensus, true);
  assert.equal(f.calls.slice(second).filter(call => call.stage === 'review').length, 0, 'new task uses the newly disabled stage');
  assert.equal(f.store.get('controlMetrics:' + newer.id).phases.discussion.budget, 30000);
});

test('old settings acquire safe independent control defaults without overwriting existing settings', () => {
  const cfg = fixture({ flow: { cooldownMin: 7, runChecks: false }, custom: { preserved: true } });
  for (const [key, value] of Object.entries(CONTROL_FLOW_DEFAULTS)) assert.deepEqual(cfg.flow[key], value);
  assert.equal(cfg.flow.cooldownMin, 7); assert.equal(cfg.flow.runChecks, false);
  assert.equal(cfg.custom.preserved, true);
});

test('every control switch and budget saves independently, and settings patch preserves unrelated fields', () => {
  let cfg = fixture({ flow: { cooldownMin: 7, custom: 'preserved' }, codex: { executable: 'keep' }, custom: ['keep'] });
  for (const [key, value] of Object.entries(CONTROL_FLOW_DEFAULTS)) {
    if (typeof value !== 'boolean') continue;
    cfg = saveSettings(cfg, { flow: { [key]: false } });
    assert.equal(cfg.flow[key], false); assert.equal(cfg.flow.cooldownMin, 7);
    cfg = saveSettings(cfg, { flow: { [key]: true } }); assert.equal(cfg.flow[key], true);
  }
  cfg = saveSettings(cfg, { flow: { discussionTokenBudget: 15000, executionTokenBudget: 40000, taskTokenBudget: 6000, discussionMaxDebates: 0, taskMaxRetries: 0, taskLeaseSec: 60, unknownFlag: true } });
  assert.equal(cfg.flow.discussionMaxDebates, 0); assert.equal(cfg.flow.taskMaxRetries, 0);
  assert.equal(cfg.flow.discussionTokenBudget, 15000); assert.equal(cfg.flow.executionTokenBudget, 40000); assert.equal(cfg.flow.taskTokenBudget, 6000);
  assert.equal(cfg.flow.taskLeaseSec, 60); assert.equal(cfg.flow.custom, 'preserved');
  assert.equal(cfg.codex.executable, 'keep'); assert.deepEqual(cfg.custom, ['keep']);
  assert.equal(cfg.flow.unknownFlag, undefined);
});

test('invalid switches, budgets, hard debate/retry limits and leases are rejected before writing', () => {
  const cfg = fixture();
  const before = fs.readFileSync(cfg.configFile, 'utf8');
  const invalid = [
    { compactDiscussion: 'true' }, { pullQueue: 1 }, { taskAutoChecks: null },
    { discussionTokenBudget: 0 }, { executionTokenBudget: -1 }, { taskTokenBudget: 1.5 }, { taskTokenBudget: '12000' },
    { discussionMaxDebates: 4 }, { discussionMaxDebates: -1 }, { taskMaxRetries: 3 }, { taskMaxRetries: -1 },
    { taskLeaseSec: 0 }, { taskLeaseSec: 3601 }, { strongAgent: 'claude' }, { cheapAgents: ['codex', 'codex'] },
    { cheapAgents: 'deepseek' }, { strongAgent: 'dock:unknown' }, { cheapAgents: ['dock:unknown'] },
  ];
  for (const flow of invalid) {
    assert.throws(() => saveSettings(cfg, { flow }), undefined, JSON.stringify(flow));
    assert.equal(fs.readFileSync(cfg.configFile, 'utf8'), before, 'invalid settings must never modify disk');
  }
  assert.throws(() => saveSettings(cfg, { flow: null }), /必须为对象/);
});

test('explicit partner roles support configured dock members and empty lightweight pool, without changing model IDs', () => {
  let cfg = fixture({ dock: [{ id: 'dock:member-1', model: 'exact-model', enabled: true }], codex: { defaultModel: 'exact-native' } });
  cfg = saveSettings(cfg, { flow: { strongAgent: 'dock:member-1', cheapAgents: ['deepseek', 'dock:member-1'] } });
  assert.equal(cfg.flow.strongAgent, 'dock:member-1'); assert.deepEqual(cfg.flow.cheapAgents, ['deepseek', 'dock:member-1']);
  assert.equal(cfg.dock[0].model, 'exact-model'); assert.equal(cfg.codex.defaultModel, 'exact-native');
  cfg = saveSettings(cfg, { flow: { cheapAgents: [] } }); assert.deepEqual(cfg.flow.cheapAgents, []);
});

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function uiFixture() {
  const fields = new Map();
  const $ = id => { if (!fields.has(id)) fields.set(id, { value: '', innerHTML: '', selectedOptions: [], querySelectorAll() { return this.selectedOptions; } }); return fields.get(id); };
  const context = vm.createContext({ $, esc, nameOf: id => id, READY_PARTNERS: ['codex', 'deepseek', 'dock:ready'] });
  vm.runInContext(script.slice(script.indexOf('const CONTROL_FIELDS = ['), script.indexOf("$('toggleSettings').onclick")), context);
  context.renderControlSettings({ ...CONTROL_FLOW_DEFAULTS });
  $('sCheapAgents').selectedOptions = [{ value: 'deepseek' }];
  return { context, $, fields };
}

test('dashboard script parses and exposes every independent stage and its constraints', () => {
  new vm.Script(script);
  const { $ } = uiFixture();
  // 流程开关常驻；数值上限与 token 硬限制收在「高级设置」里，两处合起来必须覆盖全部设置。
  const all = $('controlFields').innerHTML + $('controlFieldsAdvanced').innerHTML;
  for (const key of Object.keys(CONTROL_FLOW_DEFAULTS).filter(key => !['strongAgent', 'cheapAgents', 'quarantineUnknown'].includes(key))) assert.match(all, new RegExp('cf_' + key));
  assert.doesNotMatch(all, /cf_quarantineUnknown/, '不提供关闭未知输入保护的开关');
  assert.doesNotMatch($('controlFields').innerHTML, /type="number"|cf_tokenBudgetEnforced/, '日常区域不出现需要调参的数值');
  assert.match($('controlFieldsAdvanced').innerHTML, /min="0" max="3"/);
  assert.match($('controlFieldsAdvanced').innerHTML, /min="0" max="2"/);
  assert.match($('sCheapAgents').innerHTML, /type="checkbox"/);
});

test('dashboard submits only changed control fields and rejects empty/out-of-bounds values', () => {
  const { context, $ } = uiFixture();
  assert.deepEqual(JSON.parse(JSON.stringify(context.readControlSettings())), {});
  $('cf_planReview').value = 'false'; $('cf_discussionTokenBudget').value = '8000';
  assert.deepEqual(JSON.parse(JSON.stringify(context.readControlSettings())), { planReview: false, discussionTokenBudget: 8000 });
  $('cf_discussionMaxDebates').value = '4'; assert.throws(() => context.readControlSettings(), /0 到 3/);
  $('cf_discussionMaxDebates').value = '3'; $('cf_taskLeaseSec').value = ''; assert.throws(() => context.readControlSettings(), /整数/);
});

test('dashboard member selectors list ready partners, preserve unavailable selected role and forbid silently replacing it', () => {
  const { context, $ } = uiFixture();
  context.renderControlSettings({ ...CONTROL_FLOW_DEFAULTS, strongAgent: 'dock:offline', cheapAgents: ['deepseek'] });
  assert.match($('sStrongAgent').innerHTML, /dock:ready/); assert.doesNotMatch($('sStrongAgent').innerHTML, /claude/);
  assert.match($('sStrongAgent').innerHTML, /value="dock:offline" selected disabled/);
  assert.equal($('sStrongAgent').value, 'dock:offline');
  assert.deepEqual(JSON.parse(JSON.stringify(context.readControlSettings())), {});
  $('sStrongAgent').value = 'dock:ready'; assert.equal(context.readControlSettings().strongAgent, 'dock:ready');
  $('sStrongAgent').value = 'dock:unknown'; assert.throws(() => context.readControlSettings(), /暂不可用/);
});

test('metrics distinguish measured and estimated usage, render unknown usage and escape task evidence', () => {
  const context = vm.createContext({ esc, nameOf: value => value });
  vm.runInContext(script.slice(script.indexOf('function controlMetricsPanel('), script.indexOf('async function loadDetail(')), context);
  const result = context.controlMetricsPanel({ controlMetrics: { phases: { discussion: { budget: 24000, measuredTokens: 0, estimatedTokens: 650, unknownCalls: 2, calls: 2, ms: 100 } } }, discussionMetrics: {lockedCount:3,disputeCount:1,debates:1,stages:{outline:{calls:4,elapsedMs:6000,outputCharacters:1600}}}, taskQueue: [{ id: 'T1', title: '<img onerror="bad">', state: 'failed', acceptance: ['file exists'], issues: ['needs repair'] }] });
  assert.match(result, /记录用量 token/); assert.match(result, /估算 token/); assert.match(result, /未知/); assert.match(result, /650/);
  assert.match(result, /&lt;img/); assert.doesNotMatch(result, /<img onerror/); assert.match(result, /needs repair/);
  assert.match(result, /并行提纲/); assert.match(result, /已锁定共识 3 项/); assert.match(result, /剩余分歧 1 项/); assert.match(result, /输出字符/);
  assert.equal(context.controlMetricsPanel({}), '');
});

test('mixed native usage preserves recorded totals without calling cached Codex input new input', () => {
  const context = vm.createContext({ esc, nameOf: value => value });
  vm.runInContext(script.slice(script.indexOf('function controlMetricsPanel('), script.indexOf('async function loadDetail(')), context);
  // Actual R400 counters: Codex's 45,696 cache is already in 66,522;
  // DeepSeek's 52,608 cache is outside its 7,692. Neither sum nor subtraction
  // of the aggregate cache is valid, and historical budget evidence stays put.
  const result = context.controlMetricsPanel({controlMetrics:{phases:{}},tokenUsage:{totalTokens:74214,measuredTokens:74214,calls:2,inputTokens:70797,outputTokens:3417,cacheReadTokens:98304,byAgent:{codex:66522,deepseek:7692}}});
  assert.match(result,/74,214/);
  assert.match(result,/98,304/);
  assert.match(result,/Codex 的计量已包含缓存/);
  assert.match(result,/DeepSeek 原生计量排除缓存/);
  assert.doesNotMatch(result,/新增输入 70,797|不计入上面的计量|不计入计量/);
});

test('HTTP dashboard settings work immediately with default configuration; each stage saves and reads independently', async t => {
  const { startServer } = await import('../src/server.mjs');
  const cfg = fixture({ customerSetting: 'preserve', flow: { cooldownMin: 11 } });
  fs.mkdirSync(path.join(cfg.root, 'web'));
  fs.writeFileSync(path.join(cfg.root, 'web', 'index.html'), html);
  const svc = await startServer({ config: cfg, agents: {}, port: 0 });
  t.after(async () => { await new Promise(resolve => svc.server.close(resolve)); svc.store.close(); });
  const base = 'http://127.0.0.1:' + svc.port;
  const evidence = { kind: 'HTTP fixture, no paid API calls or visible-browser validation', defaultConfig: cfg.configFile, calls: [] };
  const call = async (name, args = {}) => {
    const result = await (await fetch(base + '/api/call', { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.secrets.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args }) })).json();
    evidence.calls.push({ name, args, ok: result.ok, error: result.error || null }); return result;
  };
  const page = await fetch(base); assert.equal(page.status, 200);
  assert.match(await page.text(), /提纲、收敛与任务队列/);
  const initial = await call('settings_get'); assert.equal(initial.ok, true);
  for (const [key, value] of Object.entries(CONTROL_FLOW_DEFAULTS)) assert.deepEqual(initial.result.flow[key], value);
  const online = await call('overview'); assert.equal(online.result.agents.codex.status, 'online');
  for (const [key, value] of Object.entries(CONTROL_FLOW_DEFAULTS)) {
    if (typeof value !== 'boolean') continue;
    const saved = await call('settings_set', { flow: { [key]: false } }); assert.equal(saved.ok, true, saved.error);
    const read = await call('settings_get'); assert.equal(read.result.flow[key], false); assert.equal(read.result.flow.cooldownMin, 11);
    assert.equal(JSON.parse(fs.readFileSync(cfg.configFile, 'utf8')).customerSetting, 'preserve');
    const restored = await call('settings_set', { flow: { [key]: true } }); assert.equal(restored.ok, true, restored.error);
  }
  const before = fs.readFileSync(cfg.configFile, 'utf8');
  for (const flow of [{ discussionMaxDebates: 4 }, { taskMaxRetries: 3 }, { compactDiscussion: 'false' }, { strongAgent: 'claude' }]) {
    const rejected = await call('settings_set', { flow }); assert.equal(rejected.ok, false);
    assert.equal(fs.readFileSync(cfg.configFile, 'utf8'), before);
  }
  evidence.result = 'pass'; evidence.defaultWorkspace = cfg.workspace;
  fs.writeFileSync(path.join(cfg.root, 'http-settings-evidence.json'), JSON.stringify(evidence, null, 2));
});
