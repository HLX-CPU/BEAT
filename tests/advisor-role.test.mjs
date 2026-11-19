// 顾问的定位体检（客户口径）：顾问不是"上帝豁免"，而是**综合四家答案、整理一份综合参考交给下一步执行**。
// 这份体检盯三件事：
//   ① 顾问的综合参考确实随交付内容进到下一步（执行）能看到的地方，并留痕；
//   ② 顾问的话不能绕过控制器的硬校验（选项必须在候选里、候选编号/哈希必须真实、严重反对仍要本人确认）；
//   ③ 顾问本人答不上来时的"可用性兜底"仍然有效（改由裁决搭档本人裁决；掉线的搭档会被跳过）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { negotiateCompact } from '../src/compact-discussion.mjs';

const seats = ['codex', 'deepseek', 'a606', 'f9cc'];
const decisions = { route: 'A', sequence: 'B', risk: 'C' };
const sections = [
  { id: 'route', title: '技术路线', content: '走接口 A' },
  { id: 'sequence', title: '步骤', content: '先 B 再 C' },
  { id: 'risk', title: '风险', content: '失败保留现场' },
];
const planShape = {
  summary: '接口方案', decisions, sections, eligibleWorkers: ['a606', 'codex'],
  tasks: [{ id: 'task-1', owner: 'codex', title: '做接口', detail: '实现 A', files: ['out.txt'], dependsOn: [], inputRefs: [], outputRefs: ['out.txt'], acceptance: ['产出 out.txt'], checks: [], difficulty: 'simple', tokenBudget: 12000, maxRetries: 2 }],
  acceptance: ['产出文件并通过独立核验'], checks: [],
};
const outline = (option = 'A') => ({ core: '走接口', steps: ['实现', '验收'], risks: ['失败保留产物'], decisions: Object.entries(decisions).map(([id, chosen]) => ({ id, option: chosen === 'A' ? option : chosen, reason: '可测量', serious: false, category: 'ordinary' })) });
// 2:2 平票：4 人门槛 3，必然走顾问裁决
const SPLIT = { codex: 'A', deepseek: 'A', a606: 'B', f9cc: 'B' };
const ballots = seat => ({ votes: Object.keys(decisions).map(id => ({ id, option: SPLIT[seat], reason: '我选这个', category: 'ordinary', serious: false })) });
const takeJson = (text, marker) => {
  const at = text.indexOf(marker); if (at < 0) return null;
  const start = text.indexOf('{', at);
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) { if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) return JSON.parse(text.slice(start, i + 1)); }
  }
  return null;
};
const expandEcho = prompt => {
  const lockedMap = takeJson(prompt, '锁定决策=') || {};
  const choices = Object.fromEntries(Object.entries(lockedMap).map(([id, value]) => [id, typeof value === 'string' ? value : value?.option]).filter(([, value]) => typeof value === 'string'));
  return { summary: planShape.summary, sections: planShape.sections, eligibleWorkers: planShape.eligibleWorkers, tasks: planShape.tasks, acceptance: planShape.acceptance, checks: planShape.checks, decisions: Object.keys(choices).length ? choices : decisions, plan: null };
};
// 评审一直不通过（用来把流程逼到顾问那一步）
const unresolvedReview = ({ stage, prompt }) => {
  if (stage === 'outline') return outline();
  if (stage === 'expand') return { ...planShape, plan: null };
  if (stage === 'repair') return { decisions, patches: [{ section: 'sections.risk', value: { content: '失败时保留检查点' } }] };
  if (stage === 'review') return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(prompt)[1], issues: [{ section: 'sections.risk', problem: '还不行' }] };
  throw Error('unexpected ' + stage);
};

function fixture(handler, { flow = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-advisor2-'));
  const store = new Store(path.join(root, 'beat.sqlite'));
  const run = store.createRun({ kind: 'discuss', goal: '通过接口完成操作', cwd: root, initiator: 'codex', max_turns: 12 });
  const calls = [];
  const orch = {
    config: { flow: { outlineMergeFallback: false, disputeVoting: false, ...flow } }, store,
    participants: () => seats,
    guard: (_id, signal) => { if (signal.aborted) throw signal.reason || Error('已取消'); },
    validatePlan: (_run, value) => value,
    setStep: (id, note, data) => { const old = store.steps(run.id).find(x => x.id === id); store.updateStep(id, { note, data: { ...old?.data, ...data } }); },
    async controlCall(r, opts, budget) {
      const prompt = opts.build(opts.seat);
      const stage = /阶段=([a-z]+)/.exec(prompt)[1];
      calls.push({ stage, seat: opts.seat, budget, prompt });
      const id = store.addStep({ run_id: r.id, role: opts.role, seat: opts.seat, agent: opts.seat, round: opts.round });
      opts.onStart?.(id);
      let answer;
      try { answer = await handler({ stage, seat: opts.seat, prompt, calls, store, id, budget }); }
      catch (e) { store.updateStep(id, { state: 'failed', error: e.message }); if (process.env.DBG) console.error('STAGE FAIL', stage, opts.seat, String(e.message).slice(0, 100)); throw e; }
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

// 顾问有两类调用：分歧裁决（要 decisions 列表）与方案选择（要 candidateId/真实 planHash/proceed）。提示词能区分。
const isSelection = prompt => /candidateId/.test(prompt);
const selectionRuling = prompt => {
  // 提示词里带着真实候选（候选=[{candidateId, planHash, eligible...}]）：取第一份的编号与哈希
  const row = takeJson(prompt, '候选=[') || takeJson(prompt, '候选=') || {};
  return { candidateId: row.candidateId, planHash: row.planHash, proceed: false, reason: '还得改', notes: [] };
};

test('顾问的综合参考随交付内容交给下一步（执行），并留下记录', async () => {
  const reference = '四家一致：先核对表格；执行时保留整数加减的证明链；数据歧义处并列候选答案。';
  const f = fixture(args => {
    if (args.stage === 'outline') return outline(SPLIT[args.seat]);
    if (args.stage === 'vote') return ballots(args.seat);
    if (args.stage === 'merge') return { aliases: [] };
    if (args.stage === 'expand') return expandEcho(args.prompt);
    if (args.stage === 'review') return { verdict: 'pass', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [] };
    if (args.stage === 'adjudicate') return isSelection(args.prompt) ? selectionRuling(args.prompt) : { decisions: Object.keys(decisions).map(id => ({ id, option: 'A', reason: '两家支持，另两家可接受', resolution: '' })), reference };
    throw Error('unexpected ' + args.stage);
  });
  const result = await negotiateCompact(f.orch, f.run, f.signal, {}, 'discuss');
  assert.equal(result.consensus, true);
  assert.match(String(result.summaryText), /顾问综合参考（四家答案合并）/);
  assert.match(String(result.summaryText), /数据歧义处并列候选答案/, '参考内容原样交给下一步');
  assert.match(f.store.events().map(e => e.text || '').join('\n'), /综合四家答案给出的执行参考/, '要留痕');
  assert.equal(result.plan.decisions.route, 'A', '参考不改已锁定的决策');
  f.store.close();
});

test('顾问的话不能绕过硬校验：选项必须在候选里、候选编号与哈希必须真实', async () => {
  // ① 顾问写了一个不在候选里的选项 → 仍然判不通过
  const invented = fixture(args => {
    if (args.stage === 'outline') return outline(SPLIT[args.seat]);
    if (args.stage === 'vote') return ballots(args.seat);
    if (args.stage === 'merge') return { aliases: [] };
    if (args.stage === 'adjudicate') return isSelection(args.prompt) ? selectionRuling(args.prompt) : { decisions: Object.keys(decisions).map(id => ({ id, option: '顾问自创：走 C 路线', reason: '我说了算' })) };
    throw Error('unexpected ' + args.stage);
  });
  try {
    const result = await negotiateCompact(invented.orch, invented.run, invented.signal, {}, 'discuss');
    assert.equal(result.consensus, false, '顾问不能自创选项绕过投票共识');
  } finally { invented.store.db.close(); }
  // ② 顾问选的候选编号/哈希对不上 → 仍然判不通过
  const bogus = fixture(args => {
    if (args.stage !== 'adjudicate') return unresolvedReview(args);
    return { candidateId: 'candidate-999', planHash: '0'.repeat(64), proceed: true, reason: '选它', notes: [] };
  });
  try {
    const result = await negotiateCompact(bogus.orch, bogus.run, bogus.signal, {}, 'discuss');
    assert.equal(result.consensus, false, '顾问指到不存在的候选不能执行');
  } finally { bogus.store.db.close(); }
});

test('终止性：顾问一直说"不能执行"也只自动接续有限次，不会无限拉锯', async () => {
  const f = fixture(args => args.stage === 'adjudicate' ? (isSelection(args.prompt) ? selectionRuling(args.prompt) : { decisions: Object.keys(decisions).map(id => ({ id, option: 'A', reason: '同意', resolution: '' })) }) : unresolvedReview(args));
  const result = await negotiateCompact(f.orch, f.run, f.signal, {}, 'discuss');
  assert.equal(result.consensus, false);
  assert.ok(f.calls.length < 40, '调用次数必须有界，实际 ' + f.calls.length);
  assert.ok(f.calls.filter(c => c.stage === 'adjudicate').length <= 4, '裁决调用也要有界');
  f.store.close();
});

test('结构校验不被绕过：非法方案不许进入执行', async () => {
  const f = fixture(args => {
    if (args.stage === 'outline') return outline();
    if (args.stage === 'expand') return { summary: '坏方案', decisions, sections: [{ id: 'route', title: '重复编号', content: 'a' }, { id: 'route', title: '重复编号', content: 'b' }], plan: null };
    if (args.stage === 'review') return { verdict: 'pass', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [] };
    throw Error('unexpected ' + args.stage);
  });
  let result = null, error = null;
  try { result = await negotiateCompact(f.orch, f.run, f.signal, {}, 'discuss'); } catch (e) { error = e; }
  assert.ok(error || result.consensus === false, '结构非法不许通过');
  f.store.close();
});

test('体检：顾问相关的硬约束与可用性兜底都还在', () => {
  const src = fs.readFileSync(new URL('../src/compact-discussion.mjs', import.meta.url), 'utf8');
  // ① 裁决必须本人做；答不上来时改由裁决搭档，且如实记录
  assert.match(src, /judged\.by !== \(state\.metrics\.adjudication\?\.actualJudge \|\| judge\)/, '代答不能冒充裁决者');
  assert.match(src, /没能本人裁决，改由 /, '裁决者本人答不上来要有兜底并留痕');
  // ② 选项与候选必须真实有效
  assert.match(src, /d\.options\.some\(x => canonical\(x\) === canonical\(decision\.option\)\)/, '顾问的选项必须在候选里');
  assert.match(src, /candidateId === ruling\.value\.candidateId\);\r?\n\s*if \(!selected \|\| selected\.planHash !== ruling\.value\.planHash/, '候选编号与哈希必须真实');
  // ③ 严重反对仍须提出者本人逐项确认
  assert.match(src, /return fail\('严重反对仍未逐项由提出者本人确认解决，禁止执行'\)/, '严重反对不能被代答豁免');
  // ④ 综合参考是"加参考"，不是"改决策"
  assert.match(src, /顾问综合参考（四家答案合并）/, '综合参考要随交付内容交给下一步');
  assert.match(src, /参考不改任何已锁定决策|只加参考，不动任何已锁定决策/, '参考不许改决策');
  // ⑤ 掉线的搭档按"跳过"处理，不阻塞批准
  assert.match(src, /评审阶段只能由别的搭档代答/, '掉线的评审席记入跳过名单');
});

test('顾问把多个候选合并成新选项时：先把合法选项回给它重判一次，重判正确就继续（不整轮判死）', async () => {
  let adjudicateCalls = 0;
  const f = fixture(args => {
    if (args.stage === 'outline') return outline(SPLIT[args.seat]);
    if (args.stage === 'vote') return ballots(args.seat);
    if (args.stage === 'merge') return { aliases: [] };
    if (args.stage === 'expand') return expandEcho(args.prompt);
    if (args.stage === 'review') return { verdict: 'pass', planHash: /hash=([a-f0-9]{64})/.exec(args.prompt)[1], issues: [] };
    if (args.stage === 'adjudicate') {
      adjudicateCalls++;
      // 第一次自造“综合选项”；收到修复说明后按候选原样重判
      if (/不能直接执行/.test(args.prompt)) return { decisions: Object.keys(decisions).map(id => ({ id, option: 'A', reason: '按候选重判', resolution: '' })), reference: '重判后的综合参考' };
      return { decisions: Object.keys(decisions).map(id => ({ id, option: '顾问自创：综合三家', reason: '我说了算' })) };
    }
    throw Error('unexpected ' + args.stage);
  });
  const result = await negotiateCompact(f.orch, f.run, f.signal, {}, 'discuss');
  assert.equal(adjudicateCalls, 2, '只重判一次');
  assert.equal(result.consensus, true, '重判给出合法选项后应当继续');
  assert.match(String(result.summaryText), /重判后的综合参考/);
  assert.ok(f.store.events().some(e => /重判一次/.test(String(e.text || ''))), '重判要留痕');
  f.store.close();
});
