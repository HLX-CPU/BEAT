import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { mergeOutlines, negotiateCompact, parseCompact, majorityThreshold, repairBrackets, isAnswerOnlyGoal, pickAnswerSeat, failureText, RESULT_DETAIL_MARK } from '../src/compact-discussion.mjs';
import { artifactsRoot } from './helpers/temp.mjs';
import { createGoalContract } from '../src/goal-contract.mjs';
import { planStructureIssues } from '../src/plan-structure.mjs';

// 用例结束后清掉本文件在 artifactsRoot() 下创建的 compact-* 临时目录：
// 以前跑一次留一批（2026-10-24 清理时产品目录里已积了 139 个历史残留），不能继续累积。
after(() => {
  const base = artifactsRoot();
  let names = [];
  try { names = fs.readdirSync(base); } catch { return; }
  for (const name of names) {
    if (!name.startsWith('compact-')) continue;
    try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); } catch { /* 被占用则留给下次清理 */ }
  }
});

const seats = ['codex', 'deepseek', 'dock:a', 'dock:b'];
const decision = (id, option = 'A', serious = false) => ({ id, option, reason: serious ? '不可逆操作缺少确认' : '简单可靠', category: serious ? 'irreversible' : 'ordinary', serious });
const outline = (route = 'A', veto = false) => ({ core: '按接口处理', steps: ['实现', '检查'], risks: ['异常中断'], decisions: [decision('route', route, veto), decision('sequence'), decision('risk')] });
const decisions = { route: 'A', sequence: 'A', risk: 'A' };
const plan = { tasks: [{ id: 'task-1', owner: 'codex', type: 'workspace', title: '实现控制逻辑', detail: '用接口实现并检查', files: ['src/new.mjs'], dependsOn: [], inputRefs: [], outputRefs: ['src/new.mjs'], acceptance: ['通过脚本校验'], checks: [], difficulty: 'simple', tokenBudget: 4000, maxRetries: 2 }], acceptance: ['无需修改配置'], checks: [] };

function fixture(handler, flow = {}, roster = seats) {
  const store = new Store(':memory:');
  const base = artifactsRoot();
  fs.mkdirSync(base, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(base, 'compact-'));
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
      // Simulate actual step's data replacement to exercise prompt-marker recovery.
      store.updateStep(id, { state: 'done', agent: by, prompt, output: text, data: { actualAgent: by } });
      return { by, text, stepId: id, label: by };
    },
  };
  orch.step = orch.controlCall;
  return { store, run, orch, calls, signal: new AbortController().signal };
}
function standard({ stage, seat, prompt }) {
  if (stage === 'outline') return outline();
  if (stage === 'expand') return { summary: '完整方案', decisions, plan };
  if (stage === 'review') return { verdict: 'pass', planHash: /hash=([a-f0-9]{64})/.exec(prompt)[1], issues: [] };
  if (stage === 'vote') return { votes: [decision('route')] };
  if (stage === 'adjudicate') return { decisions: [{ id: 'route', option: 'A', reason: '接口更可靠', resolution: '取消不可逆动作，改为预览并由客户按钮确认' }] };
  if (stage === 'safety') return { resolved: true, reason: '已取消直接执行不可逆操作' };
  throw Error('unexpected ' + stage + ' ' + seat);
}
const execute = f => negotiateCompact(f.orch, f.run, f.signal, {}, 'parallel');

test('a single-option extra decision still needs real votes, but never spends a call on impossible semantic aliases', async () => {
  const f = fixture(args => {
    if (args.stage === 'outline') { const answer = outline(); if (args.seat === 'deepseek') answer.decisions.push(decision('assignment', 'different-workers')); return answer; }
    if (args.stage === 'merge') throw new Error('单个选项没有可归并的等义项');
    if (args.stage === 'vote') return { votes: [decision('assignment', 'different-workers')] };
    if (args.stage === 'expand') return { ...standard(args), decisions: { ...decisions, assignment: 'different-workers' } };
    return standard(args);
  }, { outlineMergeFallback: true });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.equal(f.calls.filter(call => call.stage === 'merge').length, 0);
    assert.equal(f.calls.filter(call => call.stage === 'vote').length, seats.length, '不为省调用伪造其他搭档的票');
    assert.equal(f.calls.filter(call => call.stage === 'review').length, seats.length - 1);
  } finally { f.store.close(); }
});
test('R211 用户不需要测试时，提纲新增浏览器检查必须由原搭档自纠后才能展开',async()=>{
 let attempts=0;
 const f=fixture(args=>{
   if(args.stage==='outline'){
     attempts++;assert.match(args.prompt,/用户明确不需要测试/);
     return {...outline(),steps:attempts===1?['绘制SVG','浏览器打开自检动画']:['绘制SVG及CSS动画','保存HTML并读取内容']};
   }
   if(args.stage==='expand')return {summary:'交付HTML',decisions,plan:{...plan,tasks:[{...plan.tasks[0],detail:'绘制SVG并保存index.html',files:['index.html'],outputRefs:['index.html'],acceptance:['读回HTML包含SVG及动画关键帧']}],acceptance:['文件内容满足用户需求']}};
   return standard(args);
 },{},['codex','deepseek']);
 f.run.goal='创建SVG鹈鹕骑自行车HTML。你不需要测试';f.store.updateRun(f.run.id,{goal:f.run.goal});
 const r=await execute(f);assert.equal(r.consensus,true,JSON.stringify(r));assert.equal(attempts,3);assert.equal(f.store.steps(f.run.id).filter(s=>s.state==='failed').length,1);assert.equal(r.plan.tasks[0].files[0],'index.html');
});
function boundAnswer(args, run) {
  const c = createGoalContract(run);
  const answer = standard(args);
  if (['outline', 'expand', 'repair'].includes(args.stage)) answer.goalBinding = { goalHash: c.goalHash, subjectQuote: c.subject || '统计附件发票金额', attachmentRole: 'material' };
  if (args.stage === 'outline' && c.subject) answer.core = '评价' + c.subject + '的任务完成体验';
  if (args.stage === 'expand' && c.subject) answer.plan = { ...plan, tasks: [{ ...plan.tasks[0], detail: '实际处理BEAT任务并记录交付结果，不评测附件商品' }] };
  return answer;
}

test('new attachment task corrects a drifting outline before merging, without repeating valid peers', async () => {
  let f, first = true;
  f = fixture(args => {
    const answer = boundAnswer(args, f.run);
    if (args.stage === 'outline' && args.seat === 'deepseek' && first) {
      first = false; answer.core = '评测赤狐雷达硬件'; answer.goalBinding.subjectQuote = '赤狐雷达';
    }
    return answer;
  });
  f.run.goal = '请评价BEAT的任务完成体验，附件只是测试材料。';
  f.run.attachments = [{ name: '赤狐雷达发票.txt' }];
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.equal(f.calls.filter(c => c.stage === 'outline' && c.seat === 'deepseek').length, 2);
    assert.equal(f.calls.filter(c => c.stage === 'outline' && c.seat === 'codex').length, 1);
    assert.match(f.calls.find(c => c.stage === 'expand').prompt, /goalBinding/);
    assert.ok(f.store.steps(f.run.id).some(s => s.state === 'failed' && /原话/.test(s.error)));
    assert.equal(f.store.get('goalContract:' + f.run.id).subject, 'BEAT');
  } finally { f.store.db.close(); }
});

test('fresh ambiguous attachment task asks a specific question before any model call', async () => {
  const f = fixture(standard);
  f.run.goal = '请体验这款产品并写报告。'; f.run.attachments = [{ name: '赤狐雷达发票.txt' }];
  try {
    const result = await execute(f);
    assert.equal(result.consensus, false); assert.match(result.summaryText, /产品叫什么/);
    assert.equal(f.calls.length, 0);
  } finally { f.store.db.close(); }
});

test('correcting a drifting subject cannot erase an original serious safety objection', async () => {
  let f, first = true;
  f = fixture(args => {
    const answer = boundAnswer(args, f.run);
    if (args.stage === 'outline' && args.seat === 'deepseek' && first) {
      first = false; answer.core = '评测赤狐雷达'; answer.goalBinding.subjectQuote = '赤狐雷达';
      answer.decisions[2] = decision('risk', 'A', true);
    }
    return answer;
  });
  f.run.goal = '请评价BEAT服务。'; f.run.attachments = [{ name: '赤狐雷达发票.txt' }];
  try {
    await assert.rejects(execute(f), /不能删除或改写先前的严重反对/);
    assert.ok(!f.calls.some(c => c.stage === 'expand'));
  } finally { f.store.db.close(); }
});

test('fresh invoice task completes the existing protocol with no extra model calls', async () => {
  let f;
  f = fixture(args => boundAnswer(args, f.run));
  f.run.goal = '统计附件发票金额，输出合计。'; f.run.attachments = [{ name: '赤狐雷达发票.txt' }];
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true); assert.equal(f.calls.length, 8);
    assert.equal(f.calls.filter(c => c.stage === 'expand').length, 1);
  } finally { f.store.db.close(); }
});

test('valid goal metadata cannot send an unrelated expanded plan to review or execution', async () => {
  let f;
  f = fixture(args => {
    const answer = boundAnswer(args, f.run);
    if (args.stage === 'expand') answer.plan = { ...plan, tasks: [{ ...plan.tasks[0], title: 'BEAT报告', detail: '只评测赤狐雷达硬件' }] };
    return answer;
  });
  f.run.goal = '请评价BEAT服务。'; f.run.attachments = [{ name: '赤狐雷达发票.txt' }];
  try {
    await assert.rejects(execute(f), /主要工作没有处理/);
    assert.ok(!f.calls.some(c => c.stage === 'review'));
  } finally { f.store.db.close(); }
});
function selection(args, verdict, choose = candidates => candidates.filter(candidate => candidate.eligible).at(-1)) {
  const candidates = JSON.parse(args.prompt.split('候选=')[1].split('。锁定决策=')[0]);
  const candidate = choose(candidates);
  return { candidateId: candidate.candidateId, planHash: candidate.planHash, ...verdict };
}

function unresolvedPlanReview(args) {
  if (args.stage === 'review') return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'tasks.task-1', problem: '细节存在不同偏好，目标和验收可完成' }] };
  if (args.stage === 'repair') return { decisions, summary: '修订后的方案', patches: [{ section: 'tasks.task-1', value: { detail: '修订后的执行步骤' } }] };
  return standard(args);
}

test('两轮评审未通过后顾问可从真实候选选择原展开方案，既有fail保留且结果标裁决', async () => {
  const f = fixture(args => args.stage === 'adjudicate' ? selection(args, { proceed: true, reason: '原方案更直接且满足全部验收', notes: [] }, rows => rows[0]) : unresolvedPlanReview(args));
  f.orch.roster = { state: () => ({ status: 'online' }) };
  f.orch.preflightPlan = () => [];
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true); assert.equal(result.adjudicated, true); assert.equal(result.advisorUsed, true);
    assert.equal(result.plan.tasks[0].detail, plan.tasks[0].detail);
    assert.equal(result.metrics.candidateSelection.candidateId, 'candidate-1');
    assert.equal(result.metrics.candidateSelection.planHash, result.planHash);
    assert.equal(result.metrics.candidateSelection.candidateCount, 2);
    assert.equal(f.calls.filter(row => row.stage === 'review').length, 6);
    assert.equal(f.calls.filter(row => row.stage === 'repair').length, 1);
    assert.equal(f.calls.filter(row => row.stage === 'expand').length, 1);
    const checkpoint = negotiationCheckpoint(f).state;
    assert.equal(checkpoint.selectionHistory.length, 1);
    assert.equal(checkpoint.candidates.length, 2);
    assert.ok(checkpoint.candidates.every(row => row.author === 'codex' && row.reviews.every(review => review.verdict === 'fail')));
    const artifact = JSON.parse(fs.readFileSync(result.metrics.artifactPath, 'utf8'));
    assert.equal(artifact.candidates[0].planHash, result.planHash);
    assert.ok(f.store.events().some(row => row.message?.includes('裁决而非全体评审通过') || row.text?.includes('裁决而非全体评审通过')));
  } finally { f.store.close(); }
});

test('最佳候选选择的错误编号、hash和代答不能批准执行', async () => {
  for (const invalid of ['id', 'hash', 'delegate']) {
    const f = fixture(args => {
      if (args.stage !== 'adjudicate') return unresolvedPlanReview(args);
      const answer = selection(args, { proceed: true, reason: '选择满足验收的方案' });
      if (invalid === 'id') answer.candidateId = 'candidate-999';
      if (invalid === 'hash') answer.planHash = '0'.repeat(64);
      return invalid === 'delegate' ? { by: 'deepseek', response: answer } : answer;
    });
    try { const result = await execute(f); assert.equal(result.consensus, false); assert.equal(result.metrics.candidateSelection, undefined); }
    finally { f.store.close(); }
  }
});

test('新顾问仅给旧proceed格式必须自纠出明确选择，不能假称已选最佳方案', async () => {
  const f = fixture(args => args.stage === 'adjudicate' ? { proceed: true, reason: '可以执行', notes: [] } : unresolvedPlanReview(args));
  try {
    await assert.rejects(execute(f), /连续 3 次.*candidateId/);
    assert.equal(f.calls.filter(row => row.stage === 'adjudicate').length, 3);
    assert.equal(negotiationCheckpoint(f).state.metrics.candidateSelection, undefined);
    assert.equal(negotiationCheckpoint(f).state.consensus, undefined);
  } finally { f.store.close(); }
});

test('恢复旧版review-ruling缓存必须重新选方案且不重复提纲、展开或修订', async () => {
  let interrupted = true;
  const f = fixture(args => {
    if (args.stage !== 'adjudicate') return unresolvedPlanReview(args);
    if (interrupted) throw Error('顾问临时断线');
    return selection(args, { proceed: true, reason: '明确选择原方案' }, rows => rows[0]);
  });
  try {
    await assert.rejects(execute(f), /顾问临时断线/);
    const saved = negotiationCheckpoint(f);
    saved.state.calls['review-ruling'] = { seat: 'codex', by: 'codex', value: { proceed: true, reason: '旧答复并未选择方案' } };
    delete saved.state.candidates;
    f.store.set(saved.key, saved.state);
    const before = f.calls.length; interrupted = false;
    const result = await execute(f);
    assert.equal(result.consensus, true); assert.equal(result.metrics.candidateSelection.candidateId, 'candidate-1');
    assert.equal(f.calls.length, before + 1); assert.equal(f.calls.at(-1).stage, 'adjudicate');
    assert.equal(f.calls.filter(row => row.stage === 'expand').length, 1);
    assert.equal(f.calls.filter(row => row.stage === 'repair').length, 1);
    assert.equal(negotiationCheckpoint(f).state.calls['review-ruling'].value.candidateId, undefined, '旧裁决记录保留，不能补造选择证据');
  } finally { f.store.close(); }
});

test('较旧候选不能遗漏修订后明确的验收标准，即使顾问选它也不能执行', async () => {
  const f = fixture(args => {
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'tasks.task-1', value: { acceptance: [...plan.tasks[0].acceptance, '失败必须保留检查点'] } }] };
    if (args.stage === 'adjudicate') return selection(args, { proceed: true, reason: '原方案较短' }, rows => { assert.equal(rows[0].eligible, false); assert.match(rows[0].blockedReasons.join('；'), /验收要求/); return rows[0]; });
    return unresolvedPlanReview(args);
  });
  try { const result = await execute(f); assert.equal(result.consensus, false); assert.ok(result.plan.tasks[0].acceptance.includes('失败必须保留检查点')); }
  finally { f.store.close(); }
});

test('原候选有严重评审反对，即使后续修订解决也不能选回危险版本', async () => {
  const f = fixture(args => {
    if (args.stage === 'review') return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'tasks.task-1', problem: args.calls.some(row => row.stage === 'repair') ? '措辞可以简化' : '不可逆动作没有确认', serious: !args.calls.some(row => row.stage === 'repair') }] };
    if (args.stage === 'adjudicate') return selection(args, { proceed: true, reason: '旧版本简单' }, rows => { assert.equal(rows[0].eligible, false); assert.match(rows[0].blockedReasons.join('；'), /严重/); return rows[0]; });
    return unresolvedPlanReview(args);
  });
  try { const result = await execute(f); assert.equal(result.consensus, false); assert.match(result.summaryText, /安全验收边界无效/); }
  finally { f.store.close(); }
});

test('候选在选择前重新走注册检查预检，被拒候选不能靠顾问执行', async () => {
  const f = fixture(args => args.stage === 'adjudicate' ? selection(args, { proceed: true, reason: '选择注册检查可验收的版本' }) : unresolvedPlanReview(args));
  let calls = 0;
  f.orch.preflightPlan = (_run, candidate) => { calls++; return f.calls.filter(row => row.stage === 'review').length >= 6 && candidate.tasks[0].detail === plan.tasks[0].detail ? [{ section: 'checks', problem: '旧检查入口现不可安全执行' }] : []; };
  try {
    const result = await execute(f); assert.equal(result.consensus, true); assert.equal(result.metrics.candidateSelection.candidateId, 'candidate-2');
    assert.ok(calls >= 4); assert.equal(result.plan.tasks[0].detail, '修订后的执行步骤');
  } finally { f.store.close(); }
});

test('检查命令预检拒绝只交原作者修检查章节，全体评审修后同一hash，提纲与展开不重跑', async () => {
  const original = { ...plan, checks: ['node -e "unsafe"'] };
  const f = fixture(args => {
    if (args.stage === 'expand') return { summary: '完整方案', decisions, plan: original };
    if (args.stage === 'repair') { assert.equal(args.seat, 'codex'); assert.match(args.prompt, /独立测试脚本/); return { decisions, patches: [{ section: 'checks', value: ['node --test src/new.mjs'] }] }; }
    return standard(args);
  });
  f.orch.preflightPlan = (_run, candidate) => candidate.checks.some(command => command.includes('-e ')) ? [{ section: 'checks', problem: '包含未注册的内联程序' }] : [];
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true); assert.equal(result.metrics.preflightRepairs, 1);
    assert.deepEqual(result.plan.acceptance, original.acceptance); assert.deepEqual(result.plan.tasks, original.tasks);
    assert.deepEqual(result.plan.checks, ['node --test src/new.mjs']);
    assert.equal(f.calls.filter(call => call.stage === 'outline').length, 4);
    assert.equal(f.calls.filter(call => call.stage === 'expand').length, 1);
    assert.equal(f.calls.filter(call => call.stage === 'repair').length, 1);
    const reviews = f.calls.filter(call => call.stage === 'review');
    assert.equal(reviews.length, 3); assert.ok(reviews.every(call => call.prompt.includes('hash=' + result.planHash)));
  } finally { f.store.close(); }
});

test('验收对象的非法check预检允许纠正入口，但原text和全部其他标准必须保留', async () => {
  const acceptance = [{ text: '必须验证实际内容', check: 'node -e "unsafe"' }, '不能覆盖原文件'];
  const original = { ...plan, tasks: [{ ...plan.tasks[0], acceptance }] };
  const f = fixture(args => {
    if (args.stage === 'expand') return { summary: '完整方案', decisions, plan: original };
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'tasks.task-1', value: { acceptance: [{ ...acceptance[0], check: 'node --test src/new.mjs' }, acceptance[1]] } }] };
    return standard(args);
  });
  f.orch.preflightPlan = (_run, candidate) => candidate.tasks[0].acceptance[0].check.includes('-e ') ? [{ section: 'tasks.task-1', problem: '必须改成注册测试入口并保留text', criterion: 0 }] : [];
  try {
    const result = await execute(f); assert.equal(result.consensus, true);
    assert.deepEqual(result.plan.tasks[0].acceptance, [{ ...acceptance[0], check: 'node --test src/new.mjs' }, acceptance[1]]);
  } finally { f.store.close(); }
});

test('预检自纠不能删检查或改变验收文字以绕过拒绝', async () => {
  for (const remove of [true, false]) {
    const acceptance = [{ text: '必须验证实际内容', check: 'node -e "unsafe"' }];
    const original = { ...plan, tasks: [{ ...plan.tasks[0], acceptance }], checks: ['node -e "unsafe"'] };
    const f = fixture(args => {
      if (args.stage === 'expand') return { summary: '完整方案', decisions, plan: original };
      if (args.stage === 'repair') return { decisions, patches: remove ? [{ section: 'checks', value: [] }] : [{ section: 'tasks.task-1', value: { acceptance: [{ text: '语法通过即可', check: 'node --check src/new.mjs' }] } }] };
      return standard(args);
    });
    f.orch.preflightPlan = () => [{ section: remove ? 'checks' : 'tasks.task-1', problem: '非法检查', ...(remove ? {} : { criterion: 0 }) }];
    try { const result = await execute(f); assert.equal(result.consensus, false); assert.equal(f.calls.some(call => call.stage === 'review'), false); assert.deepEqual(result.plan.tasks[0].acceptance, acceptance); assert.deepEqual(result.plan.checks, original.checks); }
    finally { f.store.close(); }
  }
});

test('预检两次合法补丁仍被拒绝就停止；点继续只多给一次修订，不会原样复放', async () => {
  const f = fixture(args => args.stage === 'repair' ? { decisions, patches: [{ section: 'checks', value: ['node --test src/new.mjs'] }] } : standard(args));
  f.orch.preflightPlan = () => [{ section: 'checks', problem: '检查入口仍然未注册' }];
  try {
    const first = await execute(f); assert.equal(first.consensus, false); assert.equal(first.metrics.preflightRepairs, 2);
    const count = f.calls.length;
    f.store.set('resumeDiscussion:' + f.run.id, 'manual-resume');
    const resumed = await execute(f); assert.equal(resumed.consensus, false);
    assert.ok(f.calls.length > count, '手动继续必须真的重新问模型，而不是命中缓存');
    assert.equal(f.calls.filter(call => call.stage === 'repair').length, 3, '继续后只多给一次预检修订');
    assert.deepEqual(f.calls.slice(count).map(call => call.stage), ['repair'], '继续只补这次预检修订，不重做提纲');
  } finally { f.store.close(); }
});

test('顾问拒绝非安全评审问题后自动补对应章节并全体复审，最多两次且不重做提纲', async () => {
  const f = fixture(args => {
    const repairs = args.calls.filter(call => call.stage === 'repair').length;
    if (args.stage === 'review' && repairs < 2) return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'tasks.task-1', problem: '缺少明确恢复步骤' }] };
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'tasks.task-1', value: { detail: repairs >= 2 ? '从真实检查点只补未完成步骤' : '遇到失败保留产物' } }] };
    if (args.stage === 'adjudicate') return selection(args, { proceed: false, reason: '必须明确如何恢复而非只保留产物', notes: [] });
    return standard(args);
  });
  try {
    const result = await execute(f); assert.equal(result.consensus, true); assert.equal(result.metrics.autoContinuations, 1);
    assert.equal(result.planVersion, 3); assert.equal(f.calls.filter(call => call.stage === 'outline').length, 4); assert.equal(f.calls.filter(call => call.stage === 'expand').length, 1);
    assert.equal(f.calls.filter(call => call.stage === 'repair').length, 2);
    const lastReviews = f.calls.filter(call => call.stage === 'review').slice(-3); assert.ok(lastReviews.every(call => call.prompt.includes('hash=' + result.planHash)));
    assert.deepEqual(result.plan.tasks[0].acceptance, plan.tasks[0].acceptance);
  } finally { f.store.close(); }
});

test('顾问持续拒绝时自动接续有上限；客户手动继续会重新评审并多给一次修订（R542 回归）', async () => {
  const f = fixture(args => {
    if (args.stage === 'review') return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'tasks.task-1', problem: '始终缺少必要步骤' }] };
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'tasks.task-1', value: { detail: '步骤版本' + args.calls.filter(call => call.stage === 'repair').length } }] };
    if (args.stage === 'adjudicate') return selection(args, { proceed: false, reason: '步骤仍不可执行', notes: [] });
    return standard(args);
  });
  try {
    const first = await execute(f); assert.equal(first.consensus, false); assert.equal(first.metrics.autoContinuations, 2);
    assert.match(first.summaryText, /两次自动接续/);
    const count = f.calls.length; f.store.set('resumeDiscussion:' + f.run.id, 'manual-resume');
    const resumed = await execute(f);
    assert.equal(resumed.consensus, false);
    assert.ok(f.calls.length > count, '手动继续必须真的重新调用模型，不能 0.1 秒复放旧结论');
    assert.ok(f.calls.slice(count).some(call => call.stage === 'review'));
    assert.ok(f.calls.slice(count).some(call => call.stage === 'repair'), '继续要先按上次未解决的意见修订');
  } finally { f.store.close(); }
});

test('自动接续作者调用中断后只继续该修订，旧hash答复不能审批新计划', async () => {
  let interrupted = false;
  const f = fixture(args => {
    const repairs = args.calls.filter(call => call.stage === 'repair').length;
    if (args.stage === 'review' && repairs < 3) return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'tasks.task-1', problem: '缺少恢复步骤' }] };
    if (args.stage === 'repair') {
      if (repairs === 2 && !interrupted) { interrupted = true; throw Error('暂时掉线'); }
      return { decisions, patches: [{ section: 'tasks.task-1', value: { detail: repairs >= 3 ? '从真实检查点恢复' : '保留产物' } }] };
    }
    if (args.stage === 'adjudicate') return selection(args, { proceed: false, reason: '恢复步骤不足', notes: [] });
    return standard(args);
  });
  try {
    await assert.rejects(execute(f), /暂时掉线/);
    const before = f.calls.length; const result = await execute(f);
    assert.equal(result.consensus, true); assert.equal(result.metrics.autoContinuations, 1);
    assert.deepEqual(f.calls.slice(before).map(call => call.stage), ['repair', 'review', 'review', 'review']);
    assert.ok(f.calls.slice(-3).every(call => call.prompt.includes('hash=' + result.planHash)));
  } finally { f.store.close(); }
});

test('评审补丁引入非法命令先预检纠正，再让全体重审最终hash', async () => {
  const f = fixture(args => {
    if (args.stage === 'review' && !args.calls.some(call => call.stage === 'repair')) return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'checks', problem: '缺少内容测试' }] };
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'checks', value: [args.calls.filter(call => call.stage === 'repair').length === 1 ? 'node -e "unsafe"' : 'node --test src/new.mjs'] }] };
    return standard(args);
  });
  f.orch.preflightPlan = (_run, candidate) => candidate.checks.some(command => command.includes('-e ')) ? [{ section: 'checks', problem: '内联程序不受支持' }] : [];
  try {
    const result = await execute(f); assert.equal(result.consensus, true); assert.equal(result.metrics.preflightRepairs, 1);
    assert.deepEqual(result.plan.checks, ['node --test src/new.mjs']);
    assert.equal(f.calls.filter(call => call.stage === 'review').length, 6);
    assert.ok(f.calls.filter(call => call.stage === 'review').slice(-3).every(call => call.prompt.includes('hash=' + result.planHash) && !call.prompt.includes('node -e')));
  } finally { f.store.close(); }
});

test('预检修订后进程中断保留已修方案，不重复展开或支付作者费用', async () => {
  let crash = true;
  const f = fixture(args => {
    if (args.stage === 'expand') return { summary: '完整方案', decisions, plan: { ...plan, checks: ['node -e "unsafe"'] } };
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'checks', value: ['node --test src/new.mjs'] }] };
    return standard(args);
  });
  f.orch.preflightPlan = (_run, candidate) => {
    if (candidate.checks[0].includes('-e ')) return [{ section: 'checks', problem: '非法检查' }];
    if (crash) { crash = false; throw Error('进程中断'); }
    return [];
  };
  try {
    await assert.rejects(execute(f), /进程中断/);
    const before = f.calls.length; const result = await execute(f);
    assert.equal(result.consensus, true); assert.deepEqual(f.calls.slice(before).map(call => call.stage), ['review', 'review', 'review']);
    assert.equal(f.calls.filter(call => call.stage === 'expand').length, 1); assert.equal(f.calls.filter(call => call.stage === 'repair').length, 1);
  } finally { f.store.close(); }
});

test('预检报错、未知预检结果或严重问题都不能当作检查通过', async () => {
  for (const [preflight, serious] of [[() => { throw Error('检查注册器不可用'); }, false], [() => null, false], [() => [{ section: 'checks', problem: '会扩大文件权限', serious: true }], true]]) {
    const f = fixture(standard); f.orch.preflightPlan = preflight;
    try {
      if (serious) assert.equal((await execute(f)).consensus, false);
      else await assert.rejects(execute(f));
      assert.equal(f.calls.some(call => call.stage === 'review' || call.stage === 'repair'), false);
    } finally { f.store.close(); }
  }
});

test('分歧裁决交给顾问 Claude；顾问不是讨论参与者，也不计投票', async () => {
  const f = fixture(args => args.stage === 'outline' ? outline(seats.indexOf(args.seat) < 2 ? 'A' : 'B') : standard(args), { disputeVoting: false });
  f.orch.roster = { state: () => ({ status: 'online' }) };
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.equal(result.metrics.adjudication.actualJudge, 'claude');
    assert.equal(f.calls.find(call => call.stage === 'adjudicate').seat, 'claude');
    assert.ok(!f.calls.some(call => call.stage === 'outline' && call.seat === 'claude'));
  } finally { f.store.close(); }
});

test('顾问连不上时由裁决搭档代为裁决，看板如实显示原因', async () => {
  const f = fixture(args => args.stage === 'outline' ? outline(seats.indexOf(args.seat) < 2 ? 'A' : 'B') : standard(args), { strongAgent: 'dock:unavailable', disputeVoting: false });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.equal(result.metrics.adjudication.requestedJudge, 'claude');
    assert.equal(result.metrics.adjudication.actualJudge, 'codex');
    assert.match(result.metrics.adjudication.reason, /顾问/);
    assert.equal(f.calls.find(call => call.stage === 'adjudicate').seat, 'codex');
    assert.ok(f.store.events().some(event => /顾问/.test(event.text || '') && /codex/.test(event.text || '') && /改由/.test(event.text || '')));
    const savedMetrics = f.store.get('discussionMetrics:' + f.run.id);
    assert.deepEqual(savedMetrics.adjudication, result.metrics.adjudication);
    // 看板/接口要能看出参与人数与候选数，而不是只看到一个 consensus（PDF P1）。
    assert.equal(savedMetrics.mode, 'multi');
    assert.ok(savedMetrics.participantCount >= 2);
    assert.ok(Array.isArray(savedMetrics.candidates));
  } finally { f.store.close(); }
});

// R150 实测：顾问状态是 online（密钥在、也没冷却），但它不是讨论参与者，
// 候选过滤把它排掉 → 别人代答 → "裁决未由指定搭档本人完成"，整轮停在没批准。
test('指定的裁决者没能本人回答：改由裁决搭档裁决，而不是停在"尚未批准执行"', async () => {
  const f = fixture(args => {
    if (args.stage === 'outline') return outline(seats.indexOf(args.seat) < 2 ? 'A' : 'B');
    if (args.stage === 'adjudicate' && args.seat === 'claude') return { response: standard(args), by: 'codex' };   // 顾问被代答
    return standard(args);
  }, { disputeVoting: false });
  f.orch.roster = { state: () => ({ status: 'online' }) };
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true, '不能再停在"裁决未由指定搭档本人完成"');
    assert.equal(result.metrics.adjudication.requestedJudge, 'claude');
    assert.notEqual(result.metrics.adjudication.actualJudge, 'claude', '本人没答，就如实记成别人裁决');
    assert.match(result.metrics.adjudication.reason, /没能本人裁决/);
    const calls = f.calls.filter(call => call.stage === 'adjudicate');
    assert.equal(calls.length, 2, '先问指定裁决者，没本人回答再问裁决搭档');
    assert.equal(calls[0].seat, 'claude');
    assert.equal(calls[1].seat, result.metrics.adjudication.actualJudge);
    assert.ok(f.store.events().some(event => /没能本人给出裁决/.test(event.text || '')));
  } finally { f.store.close(); }
});

test('code merge locks 3/4, ties remain disputed, substitutions do not count', () => {
  const rows = seats.map((seat, i) => ({ seat, by: seat, value: outline(i < 3 ? 'A' : 'B') }));
  const merged = mergeOutlines(rows, seats);
  assert.equal(merged.locked.route.option, 'A');
  rows[2].value = outline('B');
  assert.equal(mergeOutlines(rows, seats).disputes[0].id, 'route');
  rows[2].value = outline('A'); rows[2].by = 'codex';
  assert.equal(mergeOutlines(rows, seats).locked.route, undefined);
});

test('one serious veto prevents a 3/4 majority from locking', () => {
  const rows = seats.map((seat, i) => ({ seat, by: seat, value: outline('A', i === 3) }));
  const merged = mergeOutlines(rows, seats);
  assert.equal(merged.locked.route, undefined);
  assert.equal(merged.disputes[0].vetoes[0].agent, 'dock:b');
});

test('invalid, prose, duplicate, and contradictory responses fail closed', () => {
  assert.throws(() => parseCompact('looks good', 'review'));
  const value = outline(); value.decisions.push(decision('route'));
  assert.throws(() => parseCompact(JSON.stringify(value), 'outline'));

  const hash = 'a'.repeat(64);
  const issue = (serious = false) => ({ section: 'tasks.task-1', problem: '建议执行前确认 pytest 可用', serious });
  // ① 通过 + 非严重备注：允许，并把备注单独记下来（不阻塞、不进返工）
  const withNote = parseCompact(JSON.stringify({ verdict: 'pass', planHash: hash, issues: [issue(false)] }), 'review');
  assert.equal(withNote.verdict, 'pass');
  assert.equal(withNote.notes.length, 1, '非严重意见要作为备注保留');
  assert.equal(withNote.issues.length, 1, '原 issues 不丢，但下游只吃 fail 的 issues');
  // ② 通过 + 没问题：允许
  assert.equal(parseCompact(JSON.stringify({ verdict: 'pass', planHash: hash, issues: [] }), 'review').notes, undefined);
  // ③ 打回 + 有问题：允许
  assert.equal(parseCompact(JSON.stringify({ verdict: 'fail', planHash: hash, issues: [issue()] }), 'review').verdict, 'fail');
  // ④ 真矛盾一：说通过却带着严重问题
  assert.throws(() => parseCompact(JSON.stringify({ verdict: 'pass', planHash: hash, issues: [issue(true)] }), 'review'), /serious=true/);
  // ⑤ 真矛盾二：打回却一条问题都不写（无法执行）
  assert.throws(() => parseCompact(JSON.stringify({ verdict: 'fail', planHash: hash, issues: [] }), 'review'), /fail 却一条问题都没写/);
});

test('default flow needs no configuration: parallel outlines, one expansion, three reviews', async () => {
  const f = fixture(standard);
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.equal(result.compact, true);
    assert.equal(result.metrics.debates, 0);
    assert.deepEqual(f.calls.map(x => x.stage), ['outline', 'outline', 'outline', 'outline', 'expand', 'review', 'review', 'review']);
    assert.ok(fs.existsSync(result.metrics.artifactPath));
    const count = f.calls.length;
    assert.equal((await execute(f)).planHash, result.planHash);
    assert.equal(f.calls.length, count);
  } finally { f.store.db.close(); }
});

test('a tied non-shrinking round stops immediately and adjudicates once', async () => {
  const f = fixture(args => {
    if (args.stage === 'outline') return outline(['codex', 'deepseek'].includes(args.seat) ? 'A' : 'B');
    if (args.stage === 'vote') return { votes: [decision('route', ['codex', 'deepseek'].includes(args.seat) ? 'A' : 'B')] };
    return standard(args);
  });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.equal(result.metrics.debates, 1);
    assert.equal(f.calls.filter(x => x.stage === 'adjudicate').length, 1);
    const votePrompt = f.calls.find(x => x.stage === 'vote').prompt;
    assert.ok(!votePrompt.includes('"id":"sequence"'));
  } finally { f.store.db.close(); }
});

test('veto requires original objector confirmation, a delegate cannot waive it', async () => {
  const f = fixture(args => {
    if (args.stage === 'outline') return outline('A', args.seat === 'dock:b');
    if (args.stage === 'safety') return { by: 'codex', response: { resolved: true, reason: '代答认为可以' } };
    return standard(args);
  });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, false);
    assert.match(result.summaryText, /本人确认/);
    assert.equal(f.calls.some(x => x.stage === 'expand'), false);
  } finally { f.store.db.close(); }
});

test('safety objection individually resolved before expansion', async () => {
  const f = fixture(args => args.stage === 'outline' ? outline('A', args.seat === 'dock:b') : standard(args));
  try {
    assert.equal((await execute(f)).consensus, true);
    assert.ok(f.calls.findIndex(x => x.stage === 'safety') < f.calls.findIndex(x => x.stage === 'expand'));
  } finally { f.store.db.close(); }
});

test('completed individual outlines survive an interrupted round', async () => {
  let interrupted = true;
  const f = fixture(args => {
    if (args.stage === 'outline' && args.seat === 'dock:b' && interrupted) throw Error('network interrupted');
    return standard(args);
  });
  try {
    await assert.rejects(execute(f), /network interrupted/);
    interrupted = false;
    assert.equal((await execute(f)).consensus, true);
    assert.equal(f.calls.filter(x => x.stage === 'outline' && x.seat === 'codex').length, 1);
    assert.equal(f.calls.filter(x => x.stage === 'outline' && x.seat === 'dock:b').length, 2);
  } finally { f.store.db.close(); }
});

test('done step survives loss of phase checkpoint without a repeated API call', async () => {
  const f = fixture(standard);
  try {
    const original = f.orch.setStep;
    let killed = false;
    f.orch.setStep = (id, note, data) => {
      if (data?.ownVote !== undefined && !killed) { killed = true; throw Error('process died after done'); }
      return original(id, note, data);
    };
    await assert.rejects(execute(f), /process died/);
    f.orch.setStep = original;
    assert.equal((await execute(f)).consensus, true);
    assert.equal(f.calls.filter(x => x.stage === 'outline' && x.seat === 'codex').length, 1);
  } finally { f.store.db.close(); }
});

test('independent switches skip voting, aliasing, and review', async () => {
  const f = fixture(args => args.stage === 'outline' ? outline(args.seat === 'codex' ? 'A' : 'B') : standard(args), { disputeVoting: false, planReview: false });
  try {
    // Three B votes lock B, adjust the author response to honor its winning decision.
    const original = f.orch.controlCall;
    f.orch.controlCall = (run, options, budget) => original(run, options, budget);
    const result = await execute(f);
    assert.equal(result.consensus, false); // mismatched expansion must never pass, even with review off.
    assert.equal(f.calls.some(x => x.stage === 'review' || x.stage === 'vote' || x.stage === 'merge'), false);
  } finally { f.store.db.close(); }
});

test('budget exhaustion stops ballots and uses reserved adjudication calls', async () => {
  const f = fixture(args => {
    if (args.stage === 'outline') return outline(['codex', 'deepseek'].includes(args.seat) ? 'A' : 'B');
    if (args.stage === 'vote') throw Object.assign(Error('budget'), { code: 'CONTROL_BUDGET_EXCEEDED' });
    return standard(args);
  });
  try {
    assert.equal((await execute(f)).consensus, true);
    assert.equal(f.calls.filter(x => x.stage === 'adjudicate').length, 1);
    assert.equal(f.calls.find(x => x.stage === 'adjudicate').budget.adjudication, true);
  } finally { f.store.db.close(); }
});

test('代答的评审席按掉线跳过，方案版本对不上的评审仍然 fail closed', async () => {
  // ① 自己没答、由别人代答的评审席：按"掉线就跳过"处理，剩下本人答复的评审说了算
  const delegated = fixture(args => args.stage === 'review' && args.seat === 'deepseek' ? { by: 'codex', response: standard(args) } : standard(args));
  try {
    const result = await execute(delegated);
    assert.equal(result.consensus, true, '一位掉线不该把整轮评审卡死');
    const skipped = delegated.store.get('discussionSkipped:' + delegated.run.id) || [];
    assert.ok(skipped.some(row => row.agent === 'deepseek'), '代答的席位要记进跳过名单');
    assert.match(String(skipped.find(row => row.agent === 'deepseek').reason), /代答/);
  } finally { delegated.store.db.close(); }
  // ② 方案版本对不上：仍然不许通过
  const wrongHash = fixture(args => args.stage === 'review' ? { verdict: 'pass', planHash: 'f'.repeat(64), issues: [] } : standard(args));
  try { assert.equal((await execute(wrongHash)).consensus, false); }
  finally { wrongHash.store.db.close(); }
});

test('one section repair keeps other tasks; remaining review issues go to the advisor instead of deadlocking', async () => {
  for (const proceed of [true, false]) {
    const f = fixture(args => {
      if (args.stage === 'review') return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'tasks.0', problem: '细节缺少异常恢复' }] };
      if (args.stage === 'repair') return { decisions, summary: '已补充恢复步骤', patches: [{ section: 'tasks.0', value: { detail: '用接口实现、遇到失败保留产物并给重试按钮' } }] };
      if (args.stage === 'adjudicate') { assert.equal(args.seat, 'claude'); return selection(args, { proceed, reason: proceed ? '执行中可处理' : '会导致交付错误', notes: ['注意异常恢复'] }); }
      return standard(args);
    });
    f.orch.roster = { state: () => ({ status: 'online' }) };
    try {
      const result = await execute(f);
      assert.equal(result.consensus, proceed);
      assert.equal(result.planVersion, proceed ? 2 : 4);
      assert.equal(f.calls.filter(x => x.stage === 'repair').length, proceed ? 1 : 3);
      assert.equal(f.calls.filter(x => x.stage === 'adjudicate').length, proceed ? 1 : 3);
      if (!proceed) assert.match(result.summaryText, /顾问裁定/);
    } finally { f.store.db.close(); }
  }
  const serious = fixture(args => {
    if (args.stage === 'review') return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'tasks.0', problem: '会直接删除用户文件', serious: true }] };
    if (args.stage === 'repair') return { decisions, summary: '改了措辞', patches: [{ section: 'tasks.0', value: { detail: '改了措辞' } }] };
    return standard(args);
  });
  try {
    const result = await execute(serious);
    assert.equal(result.consensus, false); assert.match(result.summaryText, /严重/);
    assert.equal(serious.calls.some(x => x.stage === 'adjudicate'), false, '严重问题不交裁决，不能被裁过');
  } finally { serious.store.db.close(); }
});
test('legacy: review adjudication can be switched off and then stops after one repair', async () => {
  const f = fixture(args => {
    if (args.stage === 'review') return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'tasks.0', problem: '细节缺少异常恢复' }] };
    if (args.stage === 'repair') return { decisions, summary: '已补充恢复步骤', patches: [{ section: 'tasks.0', value: { detail: '用接口实现、遇到失败保留产物并给重试按钮' } }] };
    return standard(args);
  }, { reviewAdjudication: false });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, false);
    assert.equal(result.planVersion, 2);
    assert.equal(f.calls.filter(x => x.stage === 'repair').length, 1);
    assert.match(result.summaryText, /一次章节修订/);
  } finally { f.store.db.close(); }
});

test('successful discussion section repair delivers the corrected final summary', async () => {
  const f = fixture(args => {
    if (args.stage === 'review' && !args.calls.some(x => x.stage === 'repair')) return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'summary', problem: '缺少异常恢复步骤' }] };
    if (args.stage === 'repair') return { decisions, summary: '有检查点的完整方案', patches: [{ section: 'summary', value: '最终方案：失败后从检查点继续' }] };
    return standard(args);
  });
  try {
    const result = await negotiateCompact(f.orch, f.run, f.signal, {}, 'discuss');
    assert.equal(result.consensus, true);
    assert.equal(result.summaryText, '最终方案：失败后从检查点继续');
    assert.equal(result.plan.summary, result.summaryText);
  } finally { f.store.db.close(); }
});

function twoVetoResponse(args, resolutions) {
  if (args.stage === 'outline') {
    const value = outline();
    if (args.seat === 'dock:b') for (const item of value.decisions.filter(x => ['route', 'risk'].includes(x.id))) {
      item.serious = true; item.category = 'irreversible'; item.reason = item.id + ' 的不可逆动作缺少确认';
    }
    return value;
  }
  if (args.stage === 'vote') return { votes: [decision('route'), decision('risk')] };
  if (args.stage === 'adjudicate') return { decisions: ['route', 'risk'].map(id => ({ id, option: 'A', reason: '优先保留预览方案', resolution: id + ' 改为只生成预览，待客户确认后执行' })) };
  if (args.stage === 'safety') return { resolutions };
  return standard(args);
}

test('two severe objections from the same author use one safety call with independent confirmations', async () => {
  const f = fixture(args => twoVetoResponse(args, [{ id: 'route', resolved: true, reason: '路线已移除自动不可逆操作' }, { id: 'risk', resolved: true, reason: '风险控制已加入单独人工确认' }]));
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    const safety = f.calls.filter(x => x.stage === 'safety');
    assert.equal(safety.length, 1); assert.equal(safety[0].seat, 'dock:b');
    assert.match(safety[0].prompt, /"id":"route"/); assert.match(safety[0].prompt, /"id":"risk"/);
    const artifact = JSON.parse(fs.readFileSync(result.metrics.artifactPath, 'utf8'));
    assert.equal(artifact.locked.route.source, 'adjudication'); assert.equal(artifact.locked.risk.source, 'adjudication');
    assert.ok(f.calls.indexOf(safety[0]) < f.calls.findIndex(x => x.stage === 'expand'));
  } finally { f.store.db.close(); }
});

test('missing or unresolved items in a batched safety answer block expansion and atomic locking', async () => {
  const answers = [
    [{ id: 'route', resolved: true, reason: '路线已移除自动不可逆操作' }],
    [{ id: 'route', resolved: true, reason: '路线已解决' }, { id: 'risk', resolved: false, reason: '风险措施仍不足' }],
  ];
  for (const answer of answers) {
    const f = fixture(args => twoVetoResponse(args, answer));
    try {
      const result = await execute(f);
      assert.equal(result.consensus, false);
      assert.equal(f.calls.filter(x => x.stage === 'safety').length, 1);
      assert.equal(f.calls.some(x => x.stage === 'expand'), false);
      const artifact = JSON.parse(fs.readFileSync(result.metrics.artifactPath, 'utf8'));
      assert.equal(artifact.locked.route, undefined); assert.equal(artifact.locked.risk, undefined);
      assert.equal(artifact.locked.sequence.option, 'A');
    } finally { f.store.db.close(); }
  }
});

test('resuming a budget-interrupted merged outline collects the missing original author and rechecks its veto', async () => {
  let interrupted = true;
  const f = fixture(args => {
    if (interrupted && (args.stage === 'expand' || args.stage === 'outline' && args.seat === 'dock:b')) throw Object.assign(Error('budget interrupted'), { code: 'CONTROL_BUDGET_EXCEEDED' });
    if (args.stage === 'outline' && args.seat === 'dock:b') return outline('A', true);
    return standard(args);
  });
  try {
    await assert.rejects(execute(f), e => e.code === 'CONTROL_BUDGET_EXCEEDED');
    const checkpointKey = f.store.db.prepare("SELECT k FROM kv WHERE k LIKE 'compactNegotiation:%'").get().k;
    const checkpoint = f.store.get(checkpointKey);
    assert.equal(checkpoint.merged, true); assert.equal(checkpoint.budgetStopped, true);
    assert.equal(checkpoint.calls['outline:dock:b'], undefined);
    assert.equal(checkpoint.locked.route.source, 'majority');
    interrupted = false;
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.equal(f.calls.filter(x => x.stage === 'outline' && x.seat === 'codex').length, 1);
    assert.equal(f.calls.filter(x => x.stage === 'outline' && x.seat === 'dock:b').length, 2);
    assert.equal(f.calls.filter(x => x.stage === 'safety' && x.seat === 'dock:b').length, 1);
    const restored = f.store.get(checkpointKey);
    assert.equal(restored.locked.route.source, 'adjudication');
    assert.equal(restored.calls['outline:dock:b'].value.decisions[0].serious, true);
  } finally { f.store.db.close(); }
});

function oneReviewIssue(args, issues) {
  if (args.stage === 'review' && !args.calls.some(call => call.stage === 'repair')) return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues };
  return standard(args);
}
const sections = [
  { id: 'route', title: '接口方案', content: '优先调用已有接口完成任务。' },
  { id: 'sequence', title: '执行顺序', content: '先创建文件，再独立检查内容。' },
  { id: 'risk', title: '异常处理', content: '失败时结束任务。' },
];

test('reviewed checks and acceptance chapters can be repaired without rewriting tasks or weakening original acceptance', async () => {
  const original = structuredClone(plan);
  original.tasks.push({ ...structuredClone(plan.tasks[0]), id: 'task-2', owner: 'deepseek', title: '独立核验', detail: '读取产出并核对内容', files: ['reports/check.json'], dependsOn: ['task-1'] });
  original.checks = ['node --chek src/new.mjs'];
  const f = fixture(args => {
    if (args.stage === 'expand') return { summary: '执行原始任务分工', decisions, plan: original };
    if (args.stage === 'repair') return { decisions, summary: '已修正检查入口并补充明确验收', patches: [{ section: 'checks', value: ['node --check src/new.mjs'] }, { section: 'acceptance', value: [...original.acceptance, '中断后从检查点继续，不重复已完成操作'] }] };
    return oneReviewIssue(args, [{ section: 'checks', problem: '检查参数拼写错误' }, { section: 'acceptance', problem: '需要补充中断续接的具体标准' }]);
  });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true); assert.equal(result.planVersion, 2);
    assert.deepEqual(result.plan.tasks, original.tasks);
    assert.deepEqual(result.plan.checks, ['node --check src/new.mjs']);
    assert.deepEqual(result.plan.acceptance, [...original.acceptance, '中断后从检查点继续，不重复已完成操作']);
    assert.equal(f.calls.filter(call => call.stage === 'expand').length, 1);
    assert.equal(f.calls.filter(call => call.stage === 'repair').length, 1);
  } finally { f.store.db.close(); }
});

test('acceptance deletion or rewrite never drops original standards; rewrites are appended and re-reviewed', async () => {
  for (const lowered of [[], ['客户先修改配置才能运行']]) {
    const original = { ...structuredClone(plan), checks: ['node --check src/new.mjs'] };
    const f = fixture(args => {
      if (args.stage === 'expand') return { summary: '保留原验收', decisions, plan: original };
      if (args.stage === 'repair') return { decisions, patches: [{ section: 'checks', value: ['node --version'] }, { section: 'acceptance', value: lowered }] };
      return oneReviewIssue(args, [{ section: 'acceptance', problem: '补充具体失败恢复标准' }, { section: 'checks', problem: '需要明确检查入口' }]);
    });
    try {
      const result = await execute(f);
      // 原有标准逐字保留在原位置，改写内容只追加；修订后的整份方案由全体评审重新审同一哈希。
      assert.deepEqual(result.plan.acceptance.slice(0, original.acceptance.length), original.acceptance);
      assert.deepEqual(result.plan.acceptance.slice(original.acceptance.length), lowered);
      assert.deepEqual(result.plan.tasks, original.tasks);
      assert.equal(result.planVersion, 2);
      const reviewed = f.calls.filter(call => call.stage === 'review').at(-1).prompt;
      for (const item of result.plan.acceptance) assert.ok(reviewed.includes(item), '复审看到合并后的全部标准');
    } finally { f.store.db.close(); }
  }
});

test('only the reviewed discussion section changes and all reviewers approve the resulting section hash', async () => {
  const repairedContent = '失败时保留检查点，显示继续按钮，只补未完成步骤。';
  const f = fixture(args => {
    if (args.stage === 'expand') return { summary: '接口执行、独立验收', decisions, sections: structuredClone(sections), plan: null };
    if (args.stage === 'repair') return { decisions, summary: '不得用这个摘要替换全部章节', patches: [{ section: 'sections.risk', value: { content: repairedContent } }] };
    return oneReviewIssue(args, [{ section: 'sections.risk', problem: '缺少可直接继续的失败出口' }]);
  });
  try {
    const result = await negotiateCompact(f.orch, f.run, f.signal, {}, 'discuss');
    assert.equal(result.consensus, true); assert.equal(result.planVersion, 2);
    assert.deepEqual(result.plan.sections[0], sections[0]); assert.deepEqual(result.plan.sections[1], sections[1]);
    assert.deepEqual(result.plan.sections[2], { ...sections[2], content: repairedContent });
    assert.equal(result.plan.summary, '接口执行、独立验收'); assert.deepEqual(result.plan.decisions, decisions);
    assert.match(result.summaryText, /接口执行、独立验收/); assert.ok(result.summaryText.includes(repairedContent));
    assert.ok(!result.summaryText.includes('失败时结束任务。')); assert.ok(!result.summaryText.includes('不得用这个摘要替换全部章节'));
    const reviews = f.calls.filter(call => call.stage === 'review');
    assert.equal(reviews.length, 6);
    const originalHash = /hash=([a-f0-9]{64})/.exec(reviews[0].prompt)[1];
    assert.notEqual(originalHash, result.planHash);
    assert.ok(reviews.slice(3).every(call => call.prompt.includes('hash=' + result.planHash)));
  } finally { f.store.db.close(); }
});

test('章节返工：可以连带改相关章节（客户决定放宽），但不能重命名稳定编号', async () => {
  // ① 重命名稳定编号仍然禁止
  const rename = fixture(args => {
    if (args.stage === 'expand') return { summary: '原方案概览', decisions, sections: structuredClone(sections), plan: null };
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'sections.risk', value: { id: 'route', content: '重命名来覆盖路线' } }] };
    return oneReviewIssue(args, [{ section: 'sections.risk', problem: '缺少恢复步骤' }]);
  });
  try {
    const result = await negotiateCompact(rename.orch, rename.run, rename.signal, {}, 'discuss');
    assert.equal(result.consensus, false); assert.equal(result.planVersion, 1);
    assert.deepEqual(result.plan.sections, sections);
  } finally { rename.store.db.close(); }
  // ② 连带改"没被点名"的章节：放宽后允许（被点名的仍必须改到，验收标准仍逐字保留）
  const extra = fixture(args => {
    if (args.stage === 'expand') return { summary: '原方案概览', decisions, sections: structuredClone(sections), plan: null };
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'sections.risk', value: { content: '改为检查点恢复' } }, { section: 'sections.route', value: { content: '换一整套更稳的路线' } }] };
    return oneReviewIssue(args, [{ section: 'sections.risk', problem: '缺少恢复步骤' }]);
  });
  try {
    const result = await negotiateCompact(extra.orch, extra.run, extra.signal, {}, 'discuss');
    assert.equal(result.planVersion, 2, '放宽后应当接受这次修订');
    assert.equal(result.plan.sections.find(s => s.id === 'route').content, '换一整套更稳的路线', '连带修改被允许');
    assert.equal(result.plan.sections.find(s => s.id === 'risk').content, '改为检查点恢复', '被点名的问题必须真的改到');
  } finally { extra.store.db.close(); }
  // ③ 被点名的问题没改到 → 仍然拒绝
  const missed = fixture(args => {
    if (args.stage === 'expand') return { summary: '原方案概览', decisions, sections: structuredClone(sections), plan: null };
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'sections.route', value: { content: '只改了别的地方' } }] };
    return oneReviewIssue(args, [{ section: 'sections.risk', problem: '缺少恢复步骤' }]);
  });
  try {
    const result = await negotiateCompact(missed.orch, missed.run, missed.signal, {}, 'discuss');
    assert.equal(result.planVersion, 1, '点名的问题没处理时不能算修订成功');
  } finally { missed.store.db.close(); }
});

test('章节补丁直接写整章正文（字符串）也接受：按"只替换这一章正文"落地', async () => {
  const f = fixture(args => {
    if (args.stage === 'expand') return { summary: '原方案概览', decisions, sections: structuredClone(sections), plan: null };
    // 真实模型常这么写：section 对了，但 value 直接给整章正文
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'sections.risk', value: '失败时保留检查点并给继续入口' }] };
    return oneReviewIssue(args, [{ section: 'sections.risk', problem: '缺少恢复步骤' }]);
  });
  try {
    const result = await negotiateCompact(f.orch, f.run, f.signal, {}, 'discuss');
    assert.equal(result.planVersion, 2, '字符串补丁要能被接受');
    const risk = result.plan.sections.find(s => s.id === 'risk');
    assert.equal(risk.content, '失败时保留检查点并给继续入口', '整章正文按补丁替换');
    assert.equal(risk.title, sections.find(s => s.id === 'risk').title, '标题和编号不动');
  } finally { f.store.db.close(); }
});

test('stable task section repair changes only its detail while preserving peer tasks and all acceptance chapters', async () => {
  const original = structuredClone(plan);
  original.tasks.push({ ...structuredClone(plan.tasks[0]), id: 'task-2', owner: 'deepseek', title: '后续任务', detail: '独立检查阶段', files: ['result/check.txt'] });
  const f = fixture(args => {
    if (args.stage === 'expand') return { summary: '分步执行方案', decisions, plan: original };
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'tasks.task-1', value: { detail: '用接口实现，遇到失败保存真实检查点并给出继续按钮' } }] };
    return oneReviewIssue(args, [{ section: 'tasks.task-1', problem: '任务执行步骤没有说明错误恢复' }]);
  });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.deepEqual(result.plan.tasks[1], original.tasks[1]);
    assert.deepEqual(result.plan.tasks[0], { ...original.tasks[0], detail: '用接口实现，遇到失败保存真实检查点并给出继续按钮' });
    assert.deepEqual(result.plan.acceptance, original.acceptance); assert.deepEqual(result.plan.checks, original.checks);
  } finally { f.store.db.close(); }
});

test('invalid duplicate discussion section IDs fail closed; task acceptance rewrites keep every original standard', async () => {
  const duplicate = fixture(args => args.stage === 'expand' ? { summary: '无效章节', decisions, sections: [sections[0], sections[0]], plan: null } : standard(args));
  try {
    await assert.rejects(negotiateCompact(duplicate.orch, duplicate.run, duplicate.signal, {}, 'discuss'), /编号重复/);
    assert.equal(duplicate.calls.some(call => call.stage === 'review'), false);
  } finally { duplicate.store.db.close(); }
  const lowered = fixture(args => {
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'tasks.task-1', value: { acceptance: ['无需检查即可通过'] } }] };
    return oneReviewIssue(args, [{ section: 'tasks.task-1', problem: '验收应增加具体检查步骤' }]);
  });
  try {
    const result = await execute(lowered);
    assert.deepEqual(result.plan.tasks[0].acceptance, [...plan.tasks[0].acceptance, '无需检查即可通过'], '原有任务验收不能被替换掉');
  } finally { lowered.store.db.close(); }
});

const partialBudgetError = (value, { seat, id }) => Object.assign(Error('budget interrupted after a complete answer'), { code: 'CONTROL_BUDGET_EXCEEDED', actualAgent: seat, stepId: id, partialText: typeof value === 'string' ? value : JSON.stringify(value) });

test('complete budget-interrupted outline keeps its full safety objection but never gains an approval vote', async () => {
  const partialOutline = outline('A', true);
  partialOutline.risks = ['不得自动执行不可逆动作，必须预览并单独确认'];
  const f = fixture(args => {
    if (args.stage === 'outline' && args.seat === 'dock:b') throw partialBudgetError(partialOutline, args);
    return standard(args);
  });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.equal(f.calls.filter(call => call.stage === 'safety').length, 1);
    assert.equal(f.calls.find(call => call.stage === 'safety').seat, 'dock:b');
    const artifact = JSON.parse(fs.readFileSync(result.metrics.artifactPath, 'utf8'));
    const partial = artifact.calls['outline:dock:b'];
    assert.equal(partial.partial, true);
    assert.deepEqual(partial.value, partialOutline);
    assert.equal(artifact.locked.sequence.votes['dock:b'], undefined);
    assert.equal(Object.keys(artifact.locked.sequence.votes).length, 3);
    const step = f.store.steps(f.run.id).find(item => item.seat === 'dock:b' && item.data?.compactStage === 'outline');
    assert.equal(step.state, 'failed'); assert.equal(step.data.ownVote, false);
  } finally { f.store.db.close(); }
});

test('two complete A votes and a partial A outline cannot masquerade as a three-of-four majority', async () => {
  const f = fixture(args => {
    if (args.stage === 'outline' && args.seat === 'dock:b') throw partialBudgetError(outline('A'), args);
    if (args.stage === 'outline') return outline(args.seat === 'dock:a' ? 'B' : 'A');
    return standard(args);
  });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.equal(f.calls.filter(call => call.stage === 'adjudicate').length, 1);
    const judge = f.calls.find(call => call.stage === 'adjudicate');
    assert.ok(!judge.prompt.includes('"dock:b":"A"'));
    const artifact = JSON.parse(fs.readFileSync(result.metrics.artifactPath, 'utf8'));
    assert.equal(artifact.calls['outline:dock:b'].partial, true);
    assert.equal(artifact.locked.route.source, 'adjudication');
    assert.equal(artifact.locked.sequence.source, 'majority');
    assert.equal(artifact.locked.sequence.votes['dock:b'], undefined);
  } finally { f.store.db.close(); }
});

test('partial vote with an unlisted serious option remains a veto and needs the original objector confirmation', async () => {
  for (const resolved of [true, false]) {
    const partialBallot = { votes: [decision('route', 'C-unlisted-unsafe', true)] };
    const f = fixture(args => {
      if (args.stage === 'outline') return outline(['codex', 'deepseek'].includes(args.seat) ? 'A' : 'B');
      if (args.stage === 'vote' && args.seat === 'dock:b') throw partialBudgetError(partialBallot, args);
      if (args.stage === 'vote') return { votes: [decision('route', args.seat === 'dock:a' ? 'B' : 'A')] };
      if (args.stage === 'safety') return { resolved, reason: resolved ? '已确认取消该项不可逆操作' : '具体措施仍未解决这项严重反对' };
      return standard(args);
    });
    try {
      const result = await execute(f);
      assert.equal(result.consensus, resolved);
      const safety = f.calls.filter(call => call.stage === 'safety');
      assert.equal(safety.length, 1); assert.equal(safety[0].seat, 'dock:b');
      assert.ok(safety[0].prompt.includes('不可逆操作缺少确认'));
      const artifact = JSON.parse(fs.readFileSync(result.metrics.artifactPath, 'utf8'));
      assert.equal(artifact.calls['vote:1:dock:b'].partial, true);
      assert.deepEqual(artifact.calls['vote:1:dock:b'].value, partialBallot);
      if (!resolved) {
        assert.equal(f.calls.some(call => call.stage === 'expand'), false);
        assert.equal(artifact.locked.route, undefined);
        assert.ok(artifact.disputes.find(item => item.id === 'route').vetoes.some(veto => veto.agent === 'dock:b'));
        assert.equal(artifact.disputes.find(item => item.id === 'route').votes['dock:b'], undefined);
      } else assert.equal(artifact.locked.route.source, 'adjudication');
    } finally { f.store.db.close(); }
  }
});

test('a third partial ballot cannot lock a three-of-four option even when its complete JSON agrees', async () => {
  const f = fixture(args => {
    if (args.stage === 'outline') return outline(['codex', 'deepseek'].includes(args.seat) ? 'A' : 'B');
    if (args.stage === 'vote' && args.seat === 'dock:b') throw partialBudgetError({ votes: [decision('route', 'A')] }, args);
    if (args.stage === 'vote') return { votes: [decision('route', args.seat === 'dock:a' ? 'B' : 'A')] };
    return standard(args);
  });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.equal(f.calls.filter(call => call.stage === 'adjudicate').length, 1);
    const artifact = JSON.parse(fs.readFileSync(result.metrics.artifactPath, 'utf8'));
    assert.equal(artifact.locked.route.source, 'adjudication');
    const step = f.store.steps(f.run.id).find(item => item.seat === 'dock:b' && item.data?.compactStage === 'vote');
    assert.equal(step.data.ownVote, false);
    assert.equal(artifact.calls['vote:1:dock:b'].partial, true);
  } finally { f.store.db.close(); }
});

test('an unlisted serious option from a complete ballot vetoes three otherwise valid majority votes', async () => {
  const f = fixture(args => {
    if (args.stage === 'outline') return outline(['codex', 'deepseek'].includes(args.seat) ? 'A' : 'B');
    if (args.stage === 'vote') return { votes: [decision('route', args.seat === 'dock:b' ? 'C-unlisted-unsafe' : 'A', args.seat === 'dock:b')] };
    if (args.stage === 'safety') return { resolved: false, reason: '严重反对尚未解决，禁止直接执行' };
    return standard(args);
  });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, false);
    assert.equal(f.calls.some(call => call.stage === 'expand'), false);
    const safety = f.calls.filter(call => call.stage === 'safety');
    assert.equal(safety.length, 1); assert.equal(safety[0].seat, 'dock:b');
    const artifact = JSON.parse(fs.readFileSync(result.metrics.artifactPath, 'utf8'));
    const disputed = artifact.disputes.find(item => item.id === 'route');
    assert.equal(Object.values(disputed.votes).filter(value => value === 'A').length, 3);
    assert.equal(disputed.votes['dock:b'], undefined);
    assert.ok(disputed.vetoes.some(veto => veto.agent === 'dock:b'));
    assert.equal(artifact.locked.route, undefined);
  } finally { f.store.db.close(); }
});

test('invalid budget partial outlines or ballots fail closed before any adjudication or expansion', async () => {
  for (const phase of ['outline', 'vote']) {
    const f = fixture(args => {
      if (args.stage === phase && args.seat === 'dock:b') throw partialBudgetError('{"votes":[{"id":"route","serious":true', args);
      if (args.stage === 'outline') return outline(['codex', 'deepseek'].includes(args.seat) ? 'A' : 'B');
      if (args.stage === 'vote') return { votes: [decision('route', 'A')] };
      return standard(args);
    });
    try {
      await assert.rejects(execute(f), error => error.code === 'COMPACT_INVALID_RESPONSE' && /预算中断后的答复不完整/.test(error.message));
      assert.equal(f.calls.some(call => call.stage === 'adjudicate' || call.stage === 'expand'), false);
      const key = f.store.db.prepare("SELECT k FROM kv WHERE k LIKE 'compactNegotiation:%'").get().k;
      const state = f.store.get(key);
      assert.equal(state.consensus, undefined);
      assert.equal(state.calls[phase === 'outline' ? 'outline:dock:b' : 'vote:1:dock:b'], undefined);
    } finally { f.store.db.close(); }
  }
});

test('complete partial expansion, safety confirmation, or review cannot be promoted into a successful phase', async () => {
  for (const phase of ['expand', 'safety', 'review']) {
    const f = fixture(args => {
      if (args.stage === phase) throw partialBudgetError(standard(args), args);
      if (phase === 'safety' && args.stage === 'outline') return outline('A', args.seat === 'dock:b');
      return standard(args);
    });
    try {
      await assert.rejects(execute(f), error => error.code === 'CONTROL_BUDGET_EXCEEDED');
      const key = f.store.db.prepare("SELECT k FROM kv WHERE k LIKE 'compactNegotiation:%'").get().k;
      const state = f.store.get(key);
      assert.notEqual(state.consensus, true);
      assert.equal(Object.values(state.calls).some(call => call.partial), false);
      assert.equal(f.calls.filter(call => call.stage === phase).length, phase === 'review' ? 3 : 1);
    } finally { f.store.db.close(); }
  }
});

test('explicit reviewed criterion corrects a mistaken length from 14 to 16 at its original index and gets fresh same-hash approval', async () => {
  for (const section of ['acceptance', 'tasks.task-1']) {
    const wrong = ['结果标识长度必须为14个字符', '无需修改配置即可完成任务'];
    const corrected = ['结果标识长度必须为16个字符', wrong[1]];
    const original = structuredClone(plan);
    original.tasks.push({ ...structuredClone(plan.tasks[0]), id: 'task-2', owner: 'deepseek', title: '后续任务', detail: '保持既定独立核验', files: ['reports/review.txt'] });
    original.checks = ['node --check src/new.mjs'];
    if (section === 'acceptance') original.acceptance = wrong;
    else original.tasks[0].acceptance = wrong;
    const f = fixture(args => {
      if (args.stage === 'expand') return { summary: '按用户要求生成16字符结果，其他方案保持不变', decisions, plan: original };
      if (args.stage === 'repair') return { decisions, patches: [{ section, value: section === 'acceptance' ? corrected : { acceptance: corrected } }] };
      return oneReviewIssue(args, [{ section, criterion: 0, problem: '用户要求16字符，该项错误写成14，应在原下标纠正' }]);
    });
    try {
      const result = await execute(f);
      assert.equal(result.consensus, true); assert.equal(result.planVersion, 2);
      assert.equal(result.summaryText, '按用户要求生成16字符结果，其他方案保持不变');
      const expected = structuredClone(original);
      if (section === 'acceptance') expected.acceptance = corrected;
      else expected.tasks[0].acceptance = corrected;
      assert.deepEqual(result.plan, expected);
      assert.equal(f.calls.filter(call => call.stage === 'repair').length, 1);
      const reviews = f.calls.filter(call => call.stage === 'review');
      assert.equal(reviews.length, 6);
      const beforeHash = /hash=([a-f0-9]{64})/.exec(reviews[0].prompt)[1];
      assert.notEqual(beforeHash, result.planHash);
      assert.ok(reviews.slice(0, 3).every(call => call.prompt.includes('hash=' + beforeHash)));
      assert.ok(reviews.slice(3).every(call => call.prompt.includes('hash=' + result.planHash)));
    } finally { f.store.db.close(); }
  }
});

test('criterion correction cannot delete standards or alter another unreviewed acceptance item', async () => {
  const originalCriteria = ['结果标识长度必须为14个字符', '必须保留源文件且不得覆盖'];
  const invalidReplacements = [
    ['结果标识长度必须为16个字符'],
    [originalCriteria[1]],
    ['结果标识长度必须为16个字符', '可以覆盖源文件'],
  ];
  for (const section of ['acceptance', 'tasks.task-1']) for (const replacement of invalidReplacements) {
    const original = structuredClone(plan);
    if (section === 'acceptance') original.acceptance = originalCriteria;
    else original.tasks[0].acceptance = originalCriteria;
    const f = fixture(args => {
      if (args.stage === 'expand') return { summary: '原验收方案', decisions, plan: original };
      if (args.stage === 'repair') return { decisions, patches: [{ section, value: section === 'acceptance' ? replacement : { acceptance: replacement } }] };
      return oneReviewIssue(args, [{ section, criterion: 0, problem: '只纠正长度错误的第0项，其他标准未指出问题' }]);
    });
    try {
      const result = await execute(f);
      assert.equal(result.consensus, false); assert.equal(result.planVersion, 1);
      assert.deepEqual(result.plan, original);
      assert.equal(f.calls.filter(call => call.stage === 'review').length, 3);
      assert.equal(f.calls.filter(call => call.stage === 'repair').length, 3, '违规补丁先告诉作者重改 2 次，仍违规才停止');
    } finally { f.store.db.close(); }
  }
});

test('correcting a criterion cannot move an unreviewed standard into the approved index', async () => {
  const wrong = ['结果标识长度必须为14个字符', '无需修改配置即可运行'];
  const original = { ...structuredClone(plan), acceptance: wrong };
  const f = fixture(args => {
    if (args.stage === 'expand') return { summary: '保留验收下标', decisions, plan: original };
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'acceptance', value: [wrong[1], '结果标识长度必须为16个字符'] }] };
    return oneReviewIssue(args, [{ section: 'acceptance', criterion: 0, problem: '第0项应从14字符纠正为16字符，不能修改其他下标' }]);
  });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, false);
    assert.deepEqual(result.plan.acceptance, wrong);
    assert.equal(result.planVersion, 1);
  } finally { f.store.db.close(); }
});

test('review parser rejects noninteger, negative, or nonnumeric criterion indices', () => {
  for (const criterion of [-1, 0.25, '0', null, false, 64]) {
    const value = { verdict: 'fail', planHash: 'a'.repeat(64), issues: [{ section: 'acceptance', criterion, problem: '指出错误验收项' }] };
    assert.throws(() => parseCompact(JSON.stringify(value), 'review'), error => error.code === 'COMPACT_INVALID_RESPONSE');
  }
  const valid = { verdict: 'fail', planHash: 'a'.repeat(64), issues: [{ section: 'acceptance', criterion: 0, problem: '第0项长度要求写错' }] };
  assert.equal(parseCompact(JSON.stringify(valid), 'review').issues[0].criterion, 0);
});

test('预算中断答复的未知作者或缺失步骤不能吞掉潜在严重反对后继续裁决',async()=>{
 for(const missing of ['author','step']){
  const f=fixture(args=>{
   if(args.stage==='outline'&&args.seat==='dock:b'){
    const error=partialBudgetError(outline('A',true),args);
    if(missing==='author')error.actualAgent='dock:unknown';else delete error.stepId;
    throw error;
   }
   return standard(args);
  });
  try{
   await assert.rejects(execute(f),error=>error.code==='COMPACT_INVALID_RESPONSE'&&/作者或步骤无法核实/.test(error.message));
   assert.equal(f.calls.some(call=>call.stage==='adjudicate'||call.stage==='expand'),false);
  }finally{f.store.db.close();}
 }
});

// This compiler fixture exercises negotiation ordering; it does not stand in for
// provider usage measurement or the production controller's own budget tests.
function injectBudgetCompiler(f) {
  const invocations = [];
  f.orch.compileControlledPlan = (run, candidate) => {
    assert.equal(run.id, f.run.id);
    const configured = f.orch.config.flow.taskTokenBudget;
    const evidence = {
      configured,
      tasks: candidate.tasks.map(task => ({ id: task.id, proposed: task.tokenBudget, assigned: configured })),
    };
    invocations.push({ ...evidence, reviewsBefore: f.calls.filter(call => call.stage === 'review').length });
    const history = f.store.get('planBudgetEvidence:' + run.id) || [];
    f.store.set('planBudgetEvidence:' + run.id, [...history, evidence]);
    return { ...structuredClone(candidate), tasks: candidate.tasks.map(task => ({ ...structuredClone(task), tokenBudget: configured })) };
  };
  f.orch.validatePlan = (_run, candidate) => {
    assert.ok(invocations.length, 'compile must precede validation');
    assert.ok(candidate.tasks.every(task => task.tokenBudget === 128000));
    return candidate;
  };
  return invocations;
}

function budgetProposal() {
  const candidate = structuredClone(plan);
  candidate.tasks[0].tokenBudget = 16000;
  candidate.tasks.push({ ...structuredClone(plan.tasks[0]), id: 'task-2', owner: 'deepseek', title: '独立产出', files: ['reports/result.txt'], outputRefs: ['reports/result.txt'], tokenBudget: 48000 });
  return candidate;
}

function reviewedPlan(call) {
  return JSON.parse(call.prompt.split('方案=')[1].split('。锁定决策=')[0]);
}

test('controller compiles all proposed task budgets before initial validation, hash and every review', async () => {
  const candidate = budgetProposal();
  const f = fixture(args => args.stage === 'expand' ? { summary: '两个独立任务', decisions, plan: candidate } : standard(args), { taskTokenBudget: 128000 });
  const invocations = injectBudgetCompiler(f);
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    const expected = { ...structuredClone(candidate), tasks: candidate.tasks.map(task => ({ ...structuredClone(task), tokenBudget: 128000 })) };
    assert.deepEqual(result.plan, expected);
    assert.equal(result.planHash, createHash('sha256').update(JSON.stringify(result.plan)).digest('hex'), 'hash must cover compiled budgets');
    const uncompiled = structuredClone(result.plan);
    uncompiled.tasks.forEach((task, index) => { task.tokenBudget = candidate.tasks[index].tokenBudget; });
    assert.notEqual(result.planHash, createHash('sha256').update(JSON.stringify(uncompiled)).digest('hex'));
    assert.deepEqual(candidate.tasks.map(task => task.tokenBudget), [16000, 48000], 'compiler must not mutate the author proposal');
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].reviewsBefore, 0);
    assert.deepEqual(invocations[0].tasks, [
      { id: 'task-1', proposed: 16000, assigned: 128000 },
      { id: 'task-2', proposed: 48000, assigned: 128000 },
    ]);
    const reviews = f.calls.filter(call => call.stage === 'review');
    assert.equal(reviews.length, 3);
    assert.deepEqual(new Set(reviews.map(call => call.seat)), new Set(seats.filter(seat => seat !== 'codex')));
    for (const call of reviews) {
      assert.deepEqual(reviewedPlan(call), expected);
      assert.equal(/hash=([a-f0-9]{64})/.exec(call.prompt)[1], result.planHash);
    }
    assert.deepEqual(f.store.get('planBudgetEvidence:' + f.run.id), [{ configured: 128000, tasks: invocations[0].tasks }]);
  } finally { f.store.db.close(); }
});

test('local repair proposing another budget is recompiled before fresh unanimous same-hash review', async () => {
  const candidate = budgetProposal();
  const correctedDetail = '用接口实现并检查，每步写共享检查点且从检查点继续';
  const f = fixture(args => {
    if (args.stage === 'expand') return { summary: '两个独立任务', decisions, plan: candidate };
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'tasks.task-1', value: { detail: correctedDetail, tokenBudget: 32000 } }] };
    return oneReviewIssue(args, [{ section: 'tasks.task-1', problem: '执行步骤缺少明确的检查点和恢复说明' }]);
  }, { taskTokenBudget: 128000 });
  const invocations = injectBudgetCompiler(f);
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.equal(result.planVersion, 2);
    assert.equal(invocations.length, 2);
    assert.deepEqual(invocations.map(item => item.reviewsBefore), [0, 3]);
    assert.deepEqual(invocations.map(item => item.tasks.map(task => task.proposed)), [[16000, 48000], [32000, 128000]]);
    const initial = { ...structuredClone(candidate), tasks: candidate.tasks.map(task => ({ ...structuredClone(task), tokenBudget: 128000 })) };
    const expected = structuredClone(initial);
    expected.tasks[0].detail = correctedDetail;
    assert.deepEqual(result.plan, expected, 'only reviewed task detail may change; all acceptance, checks and other task fields remain');
    const reviews = f.calls.filter(call => call.stage === 'review');
    assert.equal(reviews.length, 6);
    const oldHash = /hash=([a-f0-9]{64})/.exec(reviews[0].prompt)[1];
    assert.equal(oldHash, createHash('sha256').update(JSON.stringify(reviewedPlan(reviews[0]))).digest('hex'));
    assert.equal(result.planHash, createHash('sha256').update(JSON.stringify(result.plan)).digest('hex'));
    assert.notEqual(oldHash, result.planHash);
    for (const [round, expectedPlan, expectedHash] of [[reviews.slice(0, 3), initial, oldHash], [reviews.slice(3), expected, result.planHash]]) {
      assert.deepEqual(new Set(round.map(call => call.seat)), new Set(seats.filter(seat => seat !== 'codex')));
      for (const call of round) {
        assert.deepEqual(reviewedPlan(call), expectedPlan);
        assert.equal(/hash=([a-f0-9]{64})/.exec(call.prompt)[1], expectedHash);
      }
    }
    assert.deepEqual(f.store.get('planBudgetEvidence:' + f.run.id), invocations.map(({ configured, tasks }) => ({ configured, tasks })));
  } finally { f.store.db.close(); }
});

test('legacy orchestrator without optional compiler preserves authored budgets even with a controller setting', async () => {
  const candidate = budgetProposal();
  const f = fixture(args => args.stage === 'expand' ? { summary: '兼容原调用者', decisions, plan: candidate } : standard(args), { taskTokenBudget: 128000 });
  try {
    assert.equal(f.orch.compileControlledPlan, undefined);
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.deepEqual(result.plan, candidate);
    const reviews = f.calls.filter(call => call.stage === 'review');
    assert.equal(reviews.length, 3);
    for (const call of reviews) {
      assert.deepEqual(reviewedPlan(call), candidate);
      assert.equal(/hash=([a-f0-9]{64})/.exec(call.prompt)[1], result.planHash);
    }
    assert.equal(f.store.get('planBudgetEvidence:' + f.run.id), null);
  } finally { f.store.db.close(); }
});

test('budget recompilation keeps every original task acceptance standard when a repair rewrites it', async () => {
  const candidate = budgetProposal();
  const f = fixture(args => {
    if (args.stage === 'expand') return { summary: '保留验收标准', decisions, plan: candidate };
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'tasks.task-1', value: { detail: '增加检查点', tokenBudget: 32000, acceptance: ['无需校验即可完成'] } }] };
    return oneReviewIssue(args, [{ section: 'tasks.task-1', problem: '增加执行检查点，不改变验收标准' }]);
  }, { taskTokenBudget: 128000 });
  const invocations = injectBudgetCompiler(f);
  try {
    const result = await execute(f);
    assert.equal(result.planVersion, 2);
    assert.deepEqual(result.plan.tasks[0].acceptance, [...candidate.tasks[0].acceptance, '无需校验即可完成']);
    assert.equal(result.plan.tasks[0].tokenBudget, 128000, '预算仍由控制器按客户设置分配，补丁改不了');
    assert.equal(f.calls.filter(call => call.stage === 'repair').length, 1);
    assert.equal(invocations.length, 2);
  } finally { f.store.db.close(); }
});

const truncatedBallot = '{"votes":[{"id":"route","option":"A","reason":"截断答复不得自动补全","category":"ordinary","serious":false}';

function negotiationCheckpoint(f) {
  const key = f.store.db.prepare("SELECT k FROM kv WHERE k LIKE 'compactNegotiation:%'").get().k;
  return { key, state: f.store.get(key) };
}

test('invalid fresh done ballot retains failed evidence and resume retries only that seat after three valid checkpoints', async () => {
  let bad = true;
  const f = fixture(args => {
    if (args.stage === 'outline') return outline(['codex', 'deepseek'].includes(args.seat) ? 'A' : 'B');
    if (args.stage === 'vote' && args.seat === 'dock:b' && bad) return truncatedBallot;
    return standard(args);
  });
  try {
    await assert.rejects(execute(f), error => error.code === 'COMPACT_INVALID_RESPONSE');
    const { state } = negotiationCheckpoint(f);
    assert.equal(state.calls['vote:1:dock:b'], undefined);
    for (const seat of seats.filter(seat => seat !== 'dock:b')) {
      assert.deepEqual(state.calls['vote:1:' + seat].value, { votes: [decision('route')] });
    }
    assert.equal(state.locked.route, undefined, 'three valid peer votes cannot hide a malformed fourth response');
    assert.notEqual(state.consensus, true);
    assert.equal(f.calls.some(call => ['adjudicate', 'expand', 'review'].includes(call.stage)), false);
    const invalidStep = f.store.steps(f.run.id).find(step => step.seat === 'dock:b' && step.output === truncatedBallot);
    assert.equal(invalidStep.state, 'failed');
    assert.equal(invalidStep.data.ownVote, false);
    assert.equal(invalidStep.output, truncatedBallot, 'retain exact incomplete provider text for diagnosis');
    bad = false;
    const result = await execute(f);
    assert.equal(result.consensus, true);
    for (const seat of seats) {
      assert.equal(f.calls.filter(call => call.stage === 'outline' && call.seat === seat).length, 1);
      assert.equal(f.calls.filter(call => call.stage === 'vote' && call.seat === seat).length, seat === 'dock:b' ? 4 : 1, '格式错误先自纠 2 次，继续后再问 1 次');
    }
    assert.equal(f.calls.filter(call => call.stage === 'merge').length, 0);
    assert.equal(f.calls.filter(call => call.stage === 'adjudicate').length, 0);
    assert.equal(f.calls.filter(call => call.stage === 'expand').length, 1);
    const resumed = negotiationCheckpoint(f).state;
    assert.deepEqual(resumed.calls['vote:1:dock:b'].value, { votes: [decision('route')] });
    assert.notEqual(resumed.calls['vote:1:dock:b'].stepId, invalidStep.id);
    assert.equal(f.store.steps(f.run.id).find(step => step.id === invalidStep.id).state, 'failed');
  } finally { f.store.db.close(); }
});

test('legacy malformed done ballot is invalidated on recovery and replaced without replaying completed peers', async () => {
  let bad = true;
  const f = fixture(args => {
    if (args.stage === 'outline') return outline(['codex', 'deepseek'].includes(args.seat) ? 'A' : 'B');
    if (args.stage === 'vote' && args.seat === 'dock:b' && bad) return truncatedBallot;
    return standard(args);
  });
  try {
    await assert.rejects(execute(f), error => error.code === 'COMPACT_INVALID_RESPONSE');
    const invalidStep = f.store.steps(f.run.id).find(step => step.output === truncatedBallot);
    // Emulate an older version/process crash that persisted done before parsing.
    f.store.updateStep(invalidStep.id, { state: 'done', error: null });
    bad = false;
    const result = await execute(f);
    assert.equal(result.consensus, true);
    const invalidEvidence = f.store.steps(f.run.id).find(step => step.id === invalidStep.id);
    assert.equal(invalidEvidence.state, 'failed');
    assert.equal(invalidEvidence.data.ownVote, false);
    assert.equal(invalidEvidence.output, truncatedBallot);
    assert.equal(f.calls.filter(call => call.stage === 'outline').length, 4);
    assert.equal(f.calls.filter(call => call.stage === 'vote').length, 7, '首次 3 次（含 2 次自纠）+ 继续后 1 次 + 其余 3 位');
    for (const seat of seats.filter(seat => seat !== 'dock:b')) assert.equal(f.calls.filter(call => call.stage === 'vote' && call.seat === seat).length, 1);
    assert.equal(f.calls.filter(call => call.stage === 'vote' && call.seat === 'dock:b').length, 4);
    assert.equal(f.calls.some(call => call.stage === 'adjudicate' || call.stage === 'merge'), false);
    assert.notEqual(negotiationCheckpoint(f).state.calls['vote:1:dock:b'].stepId, invalidStep.id);
  } finally { f.store.db.close(); }
});

test('a valid orphaned done ballot is recovered without a second call while the absent peer is recorded as missing', async () => {
  let interrupted = true;
  const f = fixture(args => {
    if (args.stage === 'outline') return outline(['codex', 'deepseek'].includes(args.seat) ? 'A' : 'B');
    if (args.stage === 'vote' && args.seat === 'dock:b' && interrupted) throw Error('network interrupted ballot');
    return standard(args);
  });
  try {
    // 新契约（用户裁决）：一位席位投票不可用 → 记为缺席继续本轮，不再把整轮讨论作废。
    const result = await execute(f);
    assert.equal(result.consensus, true);
    const { key, state } = negotiationCheckpoint(f);
    const done = state.calls['vote:1:codex'];
    assert.ok(done);
    assert.equal(f.store.steps(f.run.id).find(step => step.id === done.stepId).state, 'done');
    // 缺席被记进跳过名单，事件里写明，后续轮次不再问它。
    const skipped = f.store.get('discussionSkipped:' + f.run.id) || [];
    assert.ok(skipped.some(row => row.agent === 'dock:b'), '缺席席位必须留痕');
    // 恢复场景：只丢协商检查点、保留真实 done 步骤时，重跑必须复用那次真实答复、不再重问。
    delete state.calls['vote:1:codex'];
    f.store.set(key, state);
    const beforeCalls = f.calls.filter(call => call.stage === 'vote').length;
    const again = await execute(f);
    assert.equal(again.consensus, true);
    const recovered = f.calls.filter(call => call.stage === 'vote').length;
    assert.equal(recovered, beforeCalls, '复用 done 步骤时不应再发一次投票调用');
    assert.equal(f.calls.filter(call => call.stage === 'vote' && call.seat === 'dock:b').length, 1);
    assert.equal(f.calls.filter(call => call.stage === 'outline').length, 4);
    assert.equal(f.calls.some(call => call.stage === 'merge' || call.stage === 'adjudicate'), false);
  } finally { f.store.db.close(); }
});

test('多数门槛：四人 3 票、三人 2 票、两人须一致', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(majorityThreshold), [1, 2, 2, 3, 4]);
  const three = seats.slice(0, 3), rows = three.map((seat, i) => ({ seat, by: seat, value: outline(i < 2 ? 'A' : 'B') }));
  assert.equal(mergeOutlines(rows, three).locked.route.option, 'A', '三人 2:1 直接锁定，不必请顾问');
  rows[0].value = outline('A', true);
  assert.equal(mergeOutlines(rows, three).locked.route, undefined, '严重反对仍不能被多数覆盖');
});

test('一次模型归并真正生效：等义选项合并后按本人原始投票锁定，省掉一轮辩论', async () => {
  const names = { codex: 'A', deepseek: 'A', 'dock:a': '方案A', 'dock:b': 'B' };
  const f = fixture(args => {
    if (args.stage === 'outline') return outline(names[args.seat]);
    if (args.stage === 'merge') return { aliases: [{ id: 'route', from: '方案A', to: 'A' }] };
    if (args.stage === 'vote') throw Error('归并后已锁定，不该再投票');
    return standard(args);
  }, { outlineMergeFallback: true, cheapAgents: ['deepseek'] });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    const merge = f.calls.filter(call => call.stage === 'merge');
    assert.equal(merge.length, 1); assert.equal(merge[0].seat, 'deepseek');
    assert.ok(!f.calls.some(call => call.stage === 'adjudicate'));
  } finally { f.store.close(); }
});

test('R90 回归：提纲漏写 serious/category 视为没有严重反对，不再让整个任务出错', () => {
  const raw = { core: 'x', steps: ['a'], risks: [], decisions: [{ id: 'route', option: 'A', reason: 'r' }, { id: 'sequence', option: 'A', reason: 'r', serious: 'false' }, { id: 'risk', option: 'A', reason: 'r', serious: true }] };
  const value = parseCompact(JSON.stringify(raw), 'outline');
  assert.deepEqual(value.decisions.map(d => [d.serious, d.category]), [[false, 'ordinary'], [false, 'ordinary'], [true, 'safety']], '写了严重反对却没写类别，按安全类保守处理');
  const votes = parseCompact(JSON.stringify({ votes: [{ id: 'route', option: 'A', reason: 'r' }] }), 'votes');
  assert.equal(votes.votes[0].serious, false);
});

test('答复格式有误时把问题告诉同一位搭档重答，不让整个任务出错', async () => {
  let bad = 0;
  const f = fixture(args => {
    if (args.stage === 'outline' && args.seat === 'dock:a' && bad++ === 0) return { core: 'x', steps: ['a'], risks: [], decisions: [] };
    if (args.stage === 'outline' && args.seat === 'dock:a') { assert.match(args.prompt, /上一次的答复格式有误/); return outline(); }
    return standard(args);
  });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.equal(f.calls.filter(call => call.stage === 'outline' && call.seat === 'dock:a').length, 2);
  } finally { f.store.close(); }
});

test('同一位搭档连续答错格式：停下并给出人话出口，只重问这一位', async () => {
  const f = fixture(args => args.stage === 'outline' && args.seat === 'dock:a' ? { core: 'x', steps: ['a'], risks: [], decisions: [] } : standard(args));
  try {
    await assert.rejects(execute(f), error => /dock:a 连续 3 次/.test(error.message) && /继续/.test(error.message));
    assert.equal(f.calls.filter(call => call.stage === 'outline' && call.seat === 'dock:a').length, 3);
  } finally { f.store.close(); }
});

test('R90 回归：多一个右括号的答复自动修正；被截断的答复仍拒绝，不吞掉严重反对', () => {
  const extra = '{"patches":[{"section":"acceptance","value":["a","b"]}}],"summary":"s"}';
  assert.deepEqual(JSON.parse(repairBrackets(extra)), { patches: [{ section: 'acceptance', value: ['a', 'b'] }], summary: 's' });
  assert.equal(repairBrackets('{"text":"含 } 和 ] 的字符串"}'), '{"text":"含 } 和 ] 的字符串"}', '字符串里的括号不动');
  const truncated = '{"votes":[{"id":"route","option":"A","reason":"r","serious":false},{"id":"risk","option":"B","reason":"不可逆","serious":true,"category":"irreversible"}';
  assert.equal(repairBrackets(truncated), null);
  assert.throws(() => parseCompact(truncated, 'votes'), error => error.code === 'COMPACT_INVALID_RESPONSE' && /字符附近/.test(error.message));
});

test('R90 回归：章节修订改写了原有验收时，原标准逐字保留、改写版追加，不再卡死', async () => {
  const f = fixture(args => {
    if (args.stage === 'review' && !args.calls.some(x => x.stage === 'repair')) return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'acceptance', problem: '缺少离线可用要求' }] };
    if (args.stage === 'repair' && !/没有被采用/.test(args.prompt)) return { decisions, summary: '改写验收', patches: [{ section: 'acceptance', value: ['离线可用'] }] };
    if (args.stage === 'repair') { assert.match(args.prompt, /无需修改配置/); return { decisions, summary: '保留原标准并补充', patches: [{ section: 'acceptance', value: ['无需修改配置', '离线可用'] }] }; }
    return standard(args);
  });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true);
    assert.deepEqual(result.plan.acceptance, ['无需修改配置', '离线可用']);
    assert.equal(f.calls.filter(x => x.stage === 'repair').length, 1);
  } finally { f.store.db.close(); }
});

test('R90 回归：方案修订没通过后点「继续」，只重做修订这一步，已完成的提纲和评审不重来', async () => {
  let fixed = false;
  const f = fixture(args => {
    if (args.stage === 'review' && !args.calls.some(x => x.stage === 'repair' && x.ok)) return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'acceptance', problem: '缺少离线可用要求' }] };
    if (args.stage === 'repair' && !fixed) return { decisions: { ...decisions, route: '偏离锁定' }, summary: '偏离了锁定决策', patches: [{ section: 'acceptance', value: ['离线可用'] }] };
    if (args.stage === 'repair') { args.calls.at(-1).ok = true; return { decisions, summary: '保留并补充', patches: [{ section: 'acceptance', value: ['无需修改配置', '离线可用'] }] }; }
    return standard(args);
  });
  try {
    const first = await execute(f);
    assert.equal(first.consensus, false);
    const before = f.calls.length;
    fixed = true; f.store.set('resumeDiscussion:' + f.run.id, new Date().toISOString());
    const second = await execute(f);
    assert.equal(second.consensus, true);
    const after = f.calls.slice(before);
    assert.ok(after.every(call => ['repair', 'review'].includes(call.stage)), '继续时不重做提纲、投票或展开：' + after.map(c => c.stage).join(','));
    assert.equal(after.filter(call => call.stage === 'repair').length, 1);
    const third = await execute(f);
    assert.equal(third.consensus, true); assert.equal(f.calls.length, before + after.length, '同一次继续不会重复重开');
  } finally { f.store.db.close(); }
});

test('一位评审席位掉线：其余席位按有效票直接成立，不重开整轮，且缺席留痕', async () => {
  const f = fixture(args => {
    if (args.stage === 'outline') return outline(['codex', 'deepseek'].includes(args.seat) ? 'A' : 'B');
    if (args.stage === 'review' && args.seat === 'dock:b') throw Error('ECONNRESET 席位掉线');
    return standard(args);
  });
  try {
    const first = await execute(f);
    // 一位评审缺席后，剩余在场评审（deepseek、dock:a）达到门槛即可批准，不再让整轮作废。
    assert.equal(first.consensus, true);
    const reviews = f.calls.filter(call => call.stage === 'review');
    assert.deepEqual([...new Set(reviews.map(call => call.seat))].sort(), ['deepseek', 'dock:a', 'dock:b']);
    assert.equal(reviews.filter(call => call.seat === 'dock:b').length, 1, '掉线席位只被问一次，不重开整轮');
    // 缺席必须在跳过名单和事件里留痕，买家能看见谁没到。
    const skipped = f.store.get('discussionSkipped:' + f.run.id) || [];
    assert.ok(skipped.some(row => row.agent === 'dock:b'), '缺席评审必须留痕');
    const events = f.store.db.prepare("SELECT text FROM events WHERE run_id=? AND type='negotiate'").all(f.run.id).map(row => row.text).join('\n');
    assert.match(events, /本轮有效票 2\/\d+，需 2 票/);
    assert.match(events, /dock:b/);
    // 已成立轮次不再重开：再执行一次不追加任何评审调用。
    const before = f.calls.length;
    const again = await execute(f);
    assert.equal(again.consensus, true);
    assert.equal(f.calls.length, before, '已批准的一轮不重开');
  } finally { f.store.db.close(); }
});

test('R369 体验：直接要答案的问题只回答一次，不展开方案也不评审，并走进用量账本', async () => {
  const f = fixture(() => { throw Error('不应发起讨论/评审调用'); });
  f.run.goal = '请直接给我答案';
  f.store.updateRun(f.run.id, { goal: f.run.goal });
  let prompt = '', control = null;
  // 关键回归：R370/R371 详情里 token 是 null——直接回答绕过了 controlCall。这里锁住必须走账本。
  f.orch.controlCall = async (run, opts, budget) => {
    prompt = opts.build(opts.seat); control = budget;
    const id = f.store.addStep({ run_id: run.id, role: 'discuss', seat: opts.seat, agent: opts.seat, round: opts.round });
    f.store.updateStep(id, { state: 'done', output: '第4题选C；第5题选B' });
    return { by: opts.seat, text: '第4题选C；第5题选B', stepId: id, label: opts.seat };
  };
  try {
    const result = await negotiateCompact(f.orch, f.run, f.signal, {}, 'discuss');
    assert.equal(result.consensus, true);
    assert.equal(result.summaryText, '第4题选C；第5题选B');
    assert.match(prompt, /直接回答/);
    assert.equal(f.calls.length, 0, '不应发起提纲/展开/评审调用');
    assert.equal(f.store.steps(f.run.id).filter(step => step.role === 'discuss').length, 1);
    assert.equal(result.metrics.directAnswer.seat, 'deepseek');
    assert.equal(control?.phase, 'discussion', '直接回答必须记入讨论阶段用量');
    assert.equal(control?.taskId, null);
  } finally { f.store.db.close(); }
});

test('答案型问题的判定与座位选择有边界：任务型请求不会被当成问答', () => {
  assert.equal(isAnswerOnlyGoal('请直接给我答案'), true);
  assert.equal(isAnswerOnlyGoal('看这张截图，第4题选什么？'), true);
  assert.equal(isAnswerOnlyGoal('帮我回答这两道选择题'), true);
  assert.equal(isAnswerOnlyGoal('新建一个 index.html 并写入动画'), false);
  assert.equal(isAnswerOnlyGoal('打开豆包'), false);
  assert.equal(isAnswerOnlyGoal('请评价这款产品并写报告'), false);
  assert.equal(isAnswerOnlyGoal('帮我讨论一下方案'), false);
  assert.equal(isAnswerOnlyGoal('什么是闭包'), true);
  assert.equal(isAnswerOnlyGoal('这个报错什么意思？'), true);
  assert.equal(isAnswerOnlyGoal('如何优化 SQL 查询'), true);
  assert.equal(isAnswerOnlyGoal('2+3等于几？只回答答案，不要展开。'), true);
  assert.equal(isAnswerOnlyGoal('只回答数字'), true);
  assert.equal(isAnswerOnlyGoal('帮我写一个函数吗'), false);
  assert.equal(isAnswerOnlyGoal('打开豆包问一下'), false);
  assert.equal(pickAnswerSeat(['codex', 'deepseek'], [{ name: '题目.png' }]), 'codex');
  assert.equal(pickAnswerSeat(['dock:a', 'deepseek'], []), 'deepseek');
});

test('失败结果先给结论/原因/下一步，过程记录折进详情', () => {
  const text = failureText({ title: '讨论没有通过，未执行任何任务。', reason: '还有 2 条意见没解决。', next: '补充信息后重新发起。', detail: ['候选方案：candidate-1', '顾问裁定原话：……'] });
  const at = text.indexOf(RESULT_DETAIL_MARK);
  assert.ok(at > 0, '必须带折叠标记');
  const summary = text.slice(0, at);
  assert.match(summary, /讨论没有通过/);
  assert.match(summary, /原因：/);
  assert.match(summary, /下一步：/);
  assert.ok(!summary.includes('candidate-1'), '内部候选编号不能出现在摘要里');
  assert.match(text.slice(at), /顾问裁定原话/);
});

test('R369 回归：作者答复里的顶层 goalBinding 必须进入方案，评审才看得到', async () => {
  let f;
  f = fixture(args => {
    const contract = createGoalContract(f.run);
    const binding = { goalHash: contract.goalHash, subjectQuote: contract.subject || 'BEAT', attachmentRole: 'material' };
    if (args.stage === 'outline') return { core: '评价' + (contract.subject || 'BEAT') + '的任务完成体验', steps: ['实施'], risks: ['偏离目标'], decisions: [decision('route'), decision('sequence'), decision('risk')], goalBinding: binding };
    if (args.stage === 'expand') return { goalBinding: binding, summary: '方案概览', decisions, sections: [
      { id: 'route', title: '技术路线', content: '围绕' + (contract.subject || 'BEAT') + '闭环' },
      { id: 'sequence', title: '实施步骤', content: '分步实施并记录证据' },
      { id: 'risk', title: '风险处理', content: '失败保留产物并回滚' }
    ] };
    if (args.stage === 'review') {
      const planHash = /hash=([a-f0-9]{64})/.exec(args.prompt)[1];
      // R369 里评审就是按契约要求检查方案顶层 goalBinding，方案被代码丢掉字段后每轮都判 fail。
      return args.prompt.includes('"goalBinding"')
        ? { verdict: 'pass', planHash, issues: [] }
        : { verdict: 'fail', planHash, issues: [{ section: 'summary', problem: '方案顶层缺少 goalBinding' }] };
    }
    return standard(args);
  }, {}, ['codex', 'deepseek']);
  f.run.goal = '请评价BEAT的任务完成体验，附件只是测试材料。';
  f.run.attachments = [{ name: '说明.txt', role: 'material' }];
  try {
    const result = await negotiateCompact(f.orch, f.run, f.signal, {}, 'discuss');
    assert.equal(result.consensus, true, JSON.stringify(result.summaryText));
    assert.equal(result.plan.goalBinding.goalHash, createGoalContract(f.run).goalHash);
    assert.equal(f.calls.filter(call => call.stage === 'review').length, 1, '评审应一次通过，不再出现同一意见反复打回');
  } finally { f.store.db.close(); }
});


test('PDF 视觉验收在计划预检就被拒绝，不让执行者自证两轮（R408 回归）', async () => {
  const f = fixture(args => {
    if (args.stage === 'outline') return outline();
    if (args.stage === 'expand') return { summary: '生成 PDF', decisions, plan: {
      tasks: [{ id: 'task-1', owner: 'codex', type: 'workspace', title: '生成 PDF', detail: '用脚本生成 PDF 报告', files: ['out/report.pdf'], dependsOn: [], acceptance: ['PDF 文件存在且大于 20KB', '逐页目视中文无乱码，文字可选中'], checks: [] }],
      acceptance: ['交付 PDF 报告'],
    } };
    return standard(args);
  }, {}, ['codex', 'deepseek']);
  f.orch.preflightPlan = (_run, value) => planStructureIssues(value, { cwd: f.run.cwd });
  f.run.goal = '生成一份 PDF 报告并交付'; f.store.updateRun(f.run.id, { goal: f.run.goal });
  const r = await execute(f);
  assert.equal(r.consensus, false);
  assert.match(r.summaryText, /PDF 视觉验收|无法独立核验/);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 0, '这种方案在开工前就拒绝，不进入评审');
});

test('R542 回归：并行方案必须保留作者答复里的顶层 goalBinding，评审不能再每轮判缺少绑定', async () => {
  let f;
  f = fixture(args => {
    const contract = createGoalContract(f.run);
    const binding = { goalHash: contract.goalHash, subjectQuote: '整理课堂笔记', attachmentRole: 'material' };
    if (args.stage === 'outline') return { ...outline(), goalBinding: binding };
    if (args.stage === 'expand') return { goalBinding: binding, summary: '完整方案', decisions, plan };
    if (args.stage === 'review') {
      const planHash = /hash=([a-f0-9]{64})/.exec(args.prompt)[1];
      return args.prompt.includes('"goalBinding":{"goalHash"')
        ? { verdict: 'pass', planHash, issues: [] }
        : { verdict: 'fail', planHash, issues: [{ section: 'goalBinding', problem: '方案顶层缺少 goalBinding' }] };
    }
    return standard(args);
  });
  f.run.goal = '给附件整理课堂笔记，尽量详细';
  f.run.attachments = [{ name: '教材.pdf', role: 'material' }];
  f.store.updateRun(f.run.id, { goal: f.run.goal, attachments: f.run.attachments });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true, JSON.stringify(result.summaryText));
    assert.equal(result.plan.goalBinding.subjectQuote, '整理课堂笔记');
    assert.equal(f.calls.filter(call => call.stage === 'review').length, 3, '评审看得到绑定后一次通过，不再反复打回');
  } finally { f.store.close(); }
});

test('并行方案评审指出缺少顶层绑定时，返工可以补 goalBinding 而不是被判越界', async () => {
  const f = fixture(args => {
    if (args.stage === 'expand') return { summary: '完整方案', decisions, plan };
    if (args.stage === 'review' && !args.calls.some(call => call.stage === 'repair')) {
      return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [{ section: 'goalBinding', problem: '缺少目标绑定' }] };
    }
    if (args.stage === 'repair') return { decisions, patches: [{ section: 'goalBinding', value: { goalHash: 'a'.repeat(64), subjectQuote: '整理课堂笔记', attachmentRole: 'material' } }] };
    return standard(args);
  });
  try {
    const result = await execute(f);
    assert.equal(result.consensus, true, JSON.stringify(result.summaryText));
    assert.equal(result.plan.goalBinding.subjectQuote, '整理课堂笔记');
  } finally { f.store.close(); }
});
