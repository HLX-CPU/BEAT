// R181 回归：方案作者连改 3 次都没过时，**不能直接判死整轮**，要交顾问裁决并继续。
//
// R181 实测：DeepSeek 三次修订都被"章节越界/没处理被指出的问题"判定无效 → 直接 fail 整轮，
// 27 步、约 25 分钟、0 产出，顾问 Claude 全程没被叫。同样的目标换个说法一次就谈成。
// 同一轮讨论里"两轮评审仍有意见"本来就会交顾问裁决（reviewAdjudication），这里补上对称的一条。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { negotiateCompact } from '../src/compact-discussion.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

const seats = ['codex', 'deepseek', 'dock:a', 'dock:b'];
const decision = id => ({ id, option: 'A', reason: '简单可靠', category: 'ordinary', serious: false });
const outline = () => ({ core: '按接口处理', steps: ['实现', '检查'], risks: ['异常中断'], decisions: [decision('route'), decision('sequence'), decision('risk')] });
const decisions = { route: 'A', sequence: 'A', risk: 'A' };
const plan = {
  tasks: [{ id: 'task-1', owner: 'codex', type: 'workspace', title: '实现控制逻辑', detail: '用接口实现并检查', files: ['src/new.mjs'], dependsOn: [], inputRefs: [], outputRefs: ['src/new.mjs'], acceptance: ['通过脚本校验'], checks: [], difficulty: 'simple', tokenBudget: 4000, maxRetries: 2 }],
  acceptance: ['无需修改配置'], checks: [],
};

function fixture(handler, flow = {}, roster = seats) {
  const store = new Store(':memory:');
  const base = artifactsRoot();
  fs.mkdirSync(base, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(base, 'compact-repair-'));
  const run = store.createRun({ kind: 'parallel', goal: '通过接口完成操作，无需修改设置', cwd, initiator: 'codex', max_turns: 12 });
  const calls = [];
  const orch = {
    config: { flow: { outlineMergeFallback: false, ...flow } }, store,
    participants: () => roster,
    guard: (_id, signal) => { if (signal.aborted) throw signal.reason || Error('已取消'); },
    validatePlan: (_run, value) => { assert.ok(value.tasks.length); return value; },
    setStep: (id, note, data) => {
      const old = store.steps(run.id).find(x => x.id === id);
      store.updateStep(id, { note, data: { ...old?.data, ...data } });
    },
    async controlCall(r, opts, budget) {
      const prompt = opts.build(opts.seat);
      const stage = /阶段=([a-z]+)/.exec(prompt)[1];
      calls.push({ stage, seat: opts.seat, budget, prompt });
      const id = store.addStep({ run_id: r.id, role: opts.role, seat: opts.seat, agent: opts.seat, round: opts.round });
      opts.onStart?.(id);
      let answer;
      try { answer = await handler({ stage, seat: opts.seat, prompt, calls, budget, store, id }); }
      catch (e) { store.updateStep(id, { state: 'failed', error: e.message }); throw e; }
      const response = answer?.response || answer;
      const by = answer?.by || opts.seat;
      const text = typeof response === 'string' ? response : JSON.stringify(response);
      store.updateStep(id, { state: 'done', agent: by, prompt, output: text, data: { actualAgent: by } });
      return { by, text, stepId: id, label: by };
    },
  };
  orch.step = orch.controlCall;
  return { store, run, orch, calls, signal: new AbortController().signal };
}

const ASSERTED = {};   // 记录"顾问是否被叫到"，供断言

const standard = ({ stage, prompt }) => {
  if (stage === 'outline') return outline();
  if (stage === 'expand') return { summary: '完整方案', decisions, plan };
  if (stage === 'review') return { verdict: 'pass', planHash: /hash=([a-f0-9]{64})/.exec(prompt)[1], issues: [] };
  if (stage === 'vote') return { votes: [decision('route')] };
  throw Error('unexpected ' + stage);
};

// 评审始终不通过；作者的每次修订都"越界"，于是被 applyPatches 拒绝（R181 的真实形态）
const alwaysRejected = args => {
  if (args.stage === 'review') return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'tasks.task-1', problem: '细节存在不同偏好', serious: false }] };
  if (args.stage === 'repair') return { decisions, summary: '修订', patches: [{ section: 'tasks.task-999', value: { detail: '不存在的任务 → 越界' } }] };
  return standard(args);
};

// 顾问提示词里的候选列表 → 取第一个 eligible
function pickCandidate(prompt) {
  const raw = prompt.split('候选=')[1].split('。锁定决策=')[0];
  const rows = JSON.parse(raw);
  const chosen = rows.filter(r => r.eligible)[0];
  return { candidateId: chosen.candidateId, planHash: chosen.planHash };
}

test('R181 回归：作者三次修订都被拒时，交顾问裁决并继续（不再判死整轮）', async () => {
  const f = fixture(args => {
    // 顾问被叫到有两种情形，按提示词区分：
    //   1) 修订僵局（本次新增的路径）：提示里含"连续修订"
    //   2) 两轮评审仍有意见（既有路径）：提示里含"两轮计划评审仍未通过"
    if (args.stage === 'adjudicate' && /连续修订/.test(args.prompt)) {
      ASSERTED.rulingCalled = true;
      assert.match(args.prompt, /不能新写方案|不能降低或删除任何验收标准/, '裁决提示里必须写明不许降低验收');
      return { ...pickCandidate(args.prompt), proceed: true, reason: '现有候选已满足验收，按此执行', notes: ['执行时注意接口参数'] };
    }
    if (args.stage === 'adjudicate' && /两轮计划评审仍未通过/.test(args.prompt)) {
      ASSERTED.selectionCalled = true;
      return { ...pickCandidate(args.prompt), proceed: true, reason: '既有候选满足验收', notes: [] };
    }
    if (args.stage === 'adjudicate') return { decisions: [{ id: 'route', option: 'A', reason: 'ok', resolution: '' }] };
    return alwaysRejected(args);
  });
  f.orch.roster = { state: () => ({ status: 'online' }) };
  f.orch.preflightPlan = () => [];

  const result = await negotiateCompact(f.orch, f.run, f.signal, {}, 'parallel');

  assert.ok(ASSERTED.rulingCalled, '三次修订被拒后必须请顾问裁决（R181 就是没请、直接判死）');
  assert.equal(result.consensus, true, '要能继续，而不是整轮失败');
  assert.ok(result.metrics.repairRuling, '裁决要记录在 metrics 里');
  assert.equal(result.metrics.repairRuling.judge, 'claude');
  assert.equal(result.metrics.repairRuling.proceed, true);
  assert.ok(result.plan, '要有可执行的方案');
  const timeline = f.store.events(200).map(e => String(e.text ?? '')).join('\n');
  assert.match(timeline, /记录为裁决而非全体评审通过/, '时间线要如实说明这是裁决而不是全体通过');
});

test('严格模式（repairAdjudication=false）仍然按原样失败，不会偷偷叫顾问', async () => {
  let adjudicated = false;
  const f = fixture(args => {
    if (args.stage === 'adjudicate' && /连续修订/.test(args.prompt)) { adjudicated = true; return { candidateId: 'x', planHash: 'y', proceed: true, reason: 'never' }; }
    if (args.stage === 'adjudicate') return { decisions: [{ id: 'route', option: 'A', reason: 'ok', resolution: '' }] };
    return alwaysRejected(args);
  }, { repairAdjudication: false });
  f.orch.roster = { state: () => ({ status: 'online' }) };
  f.orch.preflightPlan = () => [];

  const result = await negotiateCompact(f.orch, f.run, f.signal, {}, 'parallel');
  assert.equal(adjudicated, false, '关掉开关就不该请顾问');
  assert.equal(result.consensus, false, '严格模式下僵局仍然不批准执行');
});
