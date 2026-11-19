// 发起前检查：视觉类交付必须有一个"能看图"的独立核验人，否则先提示（R365：三个能看图的都被暂停，
// 跑完才发现没人能核验，产出全对却被显示为未通过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { looksVisualGoal, visualReviewPartners, visualReviewReadiness } from '../src/visual-reviewer.mjs';
import { TOOLS } from '../src/tools.mjs';

const config = {
  claude: { name: 'Claude', enabled: true, vision: true },
  dock: [
    { id: 'dock:glm', name: 'glm-5.3', enabled: true, vision: true },
    { id: 'dock:nv', name: '纯文本模型', enabled: true, vision: false },
    { id: 'dock:off', name: '停用的看图模型', enabled: false, vision: true },
  ],
};

test('只对视觉类目标做这项检查', () => {
  for (const goal of ['创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画', '做一个网页海报', '页面配色调整', '生成动画截图', '把 UI 改一下']) {
    assert.equal(looksVisualGoal(goal), true, goal);
  }
  for (const goal of ['把这份 CSV 转成 JSON', '总结一下日志里的报错', '回答一个问题：1=0.999…吗', '整理会议纪要']) {
    assert.equal(looksVisualGoal(goal), false, goal);
  }
});

test('能看图且可独立核验的只算 Claude 与勾了图片输入的拓展坞', () => {
  const parties = visualReviewPartners(config, {});
  assert.deepEqual(parties.map(item => item.agent), ['claude', 'dock:glm']);
});

test('视觉任务：一个能看图的独立搭档都不在线 → 发起前就给出后果和下一步', () => {
  const readiness = visualReviewReadiness({ config, agents: { claude: { status: 'paused' }, 'dock:glm': { status: 'paused' } }, goal: '创建一个HTML动画' });
  assert.equal(readiness.visual, true);
  assert.equal(readiness.ok, false);
  assert.match(readiness.reason, /没有能看图的独立搭档在线/);
  assert.match(readiness.reason, /待核验/);
  assert.match(readiness.reason, /「继续」/);
  assert.deepEqual(readiness.paused, ['claude', 'dock:glm']);
});

test('Claude 或任一能看图的拓展坞在线就放行；不看图的在线不算数', () => {
  assert.equal(visualReviewReadiness({ config, agents: { claude: { status: 'online' } }, goal: '做个SVG动画' }).ok, true);
  assert.equal(visualReviewReadiness({ config, agents: { 'dock:glm': { status: 'online' } }, goal: '做个SVG动画' }).ok, true);
  const blind = visualReviewReadiness({ config, agents: { codex: { status: 'online' }, deepseek: { status: 'online' }, 'dock:nv': { status: 'online' } }, goal: '做个SVG动画' });
  assert.equal(blind.ok, false, 'Codex/DeepSeek/不看图的拓展坞都不能核验画面');
});

test('非视觉目标不做这项检查，也不打扰客户', () => {
  const readiness = visualReviewReadiness({ config, agents: {}, goal: '把日志整理成一段总结' });
  assert.deepEqual({ visual: readiness.visual, ok: readiness.ok, reason: readiness.reason }, { visual: false, ok: true, reason: null });
});

test('发起并行任务时，后端把这次检查写进任务时间线，且不改变原有返回形状', async () => {
  const events = [];
  const o = {
    config, roster: { status: () => ({ claude: { status: 'paused' }, 'dock:glm': { status: 'paused' } }) },
    startParallel: () => ({ id: 'R-fixture', state: 'queued' }), store: { event: (runId, type, text) => events.push({ runId, type, text }) },
    models: { validate: async () => {}, validateEffort: async () => {} }, waitFor: async () => ({ id: 'R-fixture', state: 'queued' }),
  };
  assert.deepEqual(await TOOLS.beat_parallel.run(o, { goal: '创建一个HTML，内容是SVG绘制动画' }, 'user'), { id: 'R-fixture', state: 'queued' });
  assert.ok(events.some(item => item.runId === 'R-fixture' && /发起前提示/.test(item.text) && /待核验/.test(item.text)), '时间线里要留下发起前提示');

  const okEvents = [];
  const ok = await TOOLS.beat_parallel.run({ ...o, roster: { status: () => ({ claude: { status: 'online' } }) }, store: { event: (runId, type, text) => okEvents.push({ runId, type, text }) } }, { goal: '创建一个HTML，内容是SVG绘制动画' }, 'user');
  assert.deepEqual(ok, { id: 'R-fixture', state: 'queued' });
  assert.equal(okEvents.length, 0, '有能看图的搭档时不打扰');

  const calm = [];
  await TOOLS.beat_parallel.run({ ...o, store: { event: (runId, type, text) => calm.push({ runId, type, text }) } }, { goal: '把日志总结成一段话' }, 'user');
  assert.equal(calm.length, 0, '非视觉目标不提示');
});

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const between = (start, end) => inline.slice(inline.indexOf(start), inline.indexOf(end, inline.indexOf(start)));

test('看板在派发前先问，并可一键启用 Claude 后继续', () => {
  assert.match(inline, /function localVisualReadiness\(goal\)/);
  const launch = between('async function submitLaunch(', 'catch (e) {');
  assert.match(launch, /confirmVisualReviewer\(text\)/, '发起前必须做视觉核验检查');
  const confirm = between('async function confirmVisualReviewer(', '// 同目标重复熔断');
  assert.match(confirm, /先启用 Claude 并继续/);
  assert.match(confirm, /beat_agents.*action: 'resume'/, '可以一键恢复 Claude');
  assert.match(confirm, /仍然发起/, '客户仍可选择发起，不强行拦');
  assert.match(confirm, /还没有调用模型，不产生费用/, '要如实说明没有花钱');
});

test('看板本地检查：Claude 手动暂停可一键恢复；被设置停用则不给假按钮', () => {
  const fields = {};
  const context = vm.createContext({ AGENT_STATE: { claude: { status: 'paused', advisor: { enabled: true, vision: true, name: 'Claude' } } },
    DOCK: [{ id: 'dock:glm', name: 'glm-5.3', enabled: true, vision: true }], nameOf: id => id, api: async () => ({}), refresh: async () => {}, toast() {}, customerDialog: async () => 'cancel' });
  vm.runInContext(between('// ---------- 发起前检查：视觉类交付有没有', '// 同目标重复熔断'), context);
  const off = context.localVisualReadiness('创建一个HTML动画');
  assert.equal(off.visual, true); assert.equal(off.ok, false); assert.equal(off.canResumeClaude, true);
  context.AGENT_STATE['dock:glm'] = { status: 'online' };
  const on = context.localVisualReadiness('创建一个HTML动画');
  assert.equal(on.ok, true);
  context.AGENT_STATE['dock:glm'] = { status: 'paused' };
  context.AGENT_STATE.claude = { status: 'paused', advisor: { enabled: false, vision: true } };
  assert.equal(context.localVisualReadiness('创建一个HTML动画').canResumeClaude, false, '设置里停用的顾问不能靠"恢复"糊弄客户');
  assert.equal(context.localVisualReadiness('把日志总结一下').visual, false);
});
