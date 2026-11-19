import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { parseVerdict, parseTurn, registerAgentNames, AGENT } from '../src/prompts.mjs';
import { classifyFailure } from '../src/roster.mjs';
import { defaults } from '../src/config.mjs';

function setup(agents, { claudeKey = 'sk-test-key-123456', flow = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 't', claudeApiKey: claudeKey } };
  config.claude = { ...config.claude, baseUrl: 'https://example.invalid', model: 'claude-fixture' }; // Tests must not depend on personal provider defaults.
  config.codex = { ...config.codex, defaultModel: 'codex-fixture' };
  config.deepseek = { ...config.deepseek, defaultModel: 'deepseek-fixture' };
  // Keep coverage for persisted legacy runs and independently disabled new stages.
  config.flow = { ...config.flow, compactDiscussion:false, pullQueue:false, skipFailedDiscussion:false, discussionRetryDelays: [], ...flow };
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  const wrap = Object.fromEntries(['codex', 'deepseek', 'claude'].map(a => [a, async o => {
    let r = await (agents[a] || (() => { throw new Error('不应调用 ' + a); }))(o, kind(o.prompt));
    if(kind(o.prompt)==='turn'&&!o.prompt.includes('本轮共同提案')){const t=parseTurn(r.text);if(t.stance==='open'&&!t.issues.length)r=turn('agree',{plan:t.plan});}
    return a === 'claude' ? { history: [...(o.history || []), { role: 'user', content: o.prompt }, { role: 'assistant', content: r.text }], ...r } : r;
  }]));
  return { config, store, orch: new Orchestrator({ config, store, agents: { ...wrap, ...Object.fromEntries(Object.entries(agents).filter(([k]) => !['codex', 'deepseek', 'claude'].includes(k))) } }) };
}
// 根据提示词判断这是哪一步
function kind(p) {
  if (p.includes('对等讨论')) return 'turn';
  if (p.includes('所以请你加入')) return 'advisor';
  if (p.includes('请写出最终结论')) return 'summary';
  if (p.includes('定下最终的分工方案')) return 'decide';
  if (p.includes('现在评估第')) return 'evaluate';
  if (p.includes('第二意见')) return 'consult';
  if (p.includes('长时间没有进展')) return 'help';
  if (p.includes('你是本次任务的诊断者')) return 'diagnose';
  if (p.includes('你刚刚替')) return 'notice';
  if (p.includes('## 交付报告')) return 'execute';
  return 'ask';
}
const json = o => '意见……\n```json\n' + JSON.stringify(o) + '\n```';
const turn = (stance, extra = {}) => ({ text: json({ stance, summary: stance, open_issues: [], need_advisor: false, ...extra }) });
const PLAN = { tasks: [{ owner: 'codex', title: '后端', detail: '写 api.mjs', files: ['api.mjs'] }, { owner: 'deepseek', title: '前端', detail: '写 ui.mjs', files: ['ui.mjs'] }], acceptance: ['两个文件都存在'] };
const pass = { text: json({ verdict: 'pass', summary: '全部满足', issues: [], fixes: [] }) };
const failV = owner => ({ text: json({ verdict: 'fail', summary: '接口不一致', issues: ['ui 调用名不对'], fixes: [{ owner, title: '改调用名', detail: '改成 getData' }] }) });
async function finished(orch, id) { for (let i = 0; i < 300; i++) { const r = orch.store.run(id); if (orch.isFinal(r.state)) return r; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout'); }
const roles = (store, id) => store.steps(id).map(s => `${s.role}:${s.seat}:${s.agent}`);

test('plan preflight identifies exact check sections and criteria before planned files exist', () => {
  const { orch, store, config } = setup({});
  try {
    const plan = { checks: ['node -e "process.exit(0)"'], tasks: [{ id: 'create', files: ['future/app.mjs'], checks: ['node --check future/app.mjs'], acceptance: [{ text: '原标准', check: 'node -e "process.exit(0)"' }] }] };
    const issues = orch.preflightPlan({ cwd: config.root }, plan);
    assert.equal(issues.length, 2); assert.equal(issues[0].section, 'checks');
    assert.equal(issues[1].section, 'tasks.create'); assert.equal(issues[1].criterion, 0);
    assert.match(issues[1].problem, /未执行/);
  } finally { store.close(); }
});

test('compact discussion without consensus stays usable (done + not-approved) and supports continue', async () => {
  for (const historical of [false, true]) {
    const { orch, store, config } = setup({});
    try {
      const run = store.createRun({ kind: 'discuss', goal: '讨论未通过可继续', cwd: config.root, initiator: 'codex' });
      orch.compactFor = () => true;
      orch.negotiate = async () => ({ compact: true, consensus: false, plan: null, summaryText: '仍需修订' });
      await orch.runDiscuss(run.id, new AbortController().signal);
      // 没凑齐全票但结论可用：按“已完成但有分歧”收尾，不再判 failed（R533 实测：可用结论被判成没完成）
      assert.equal(store.run(run.id).state, 'done');
      assert.equal(store.run(run.id).verdict, 'not-approved');
      assert.match(store.run(run.id).result, /未获得全体一致/);
      if (historical) store.updateRun(run.id, { state: 'done' });
      let launched = false; orch.launch = () => { launched = true; };
      orch.resume(run.id); assert.equal(launched, true); assert.equal(store.run(run.id).state, 'queued');
      assert.ok(store.get('resumeDiscussion:' + run.id));
    } finally { store.close(); }
  }
});

test('讨论正常跑完但没结论时也不再判失败：如实标未获一致', async () => {
  const { orch, store, config } = setup({});
  try {
    const run = store.createRun({ kind: 'discuss', goal: '空讨论', cwd: config.root, initiator: 'codex' });
    orch.compactFor = () => true;
    orch.negotiate = async () => ({ compact: true, consensus: false, plan: null, summaryText: '' });
    await orch.runDiscuss(run.id, new AbortController().signal);
    // 流程没崩：状态是 done（跑了但没一致），失败留给真正的异常；客户仍能从 verdict 和提示看到分歧。
    assert.equal(store.run(run.id).state, 'done');
    assert.equal(store.run(run.id).verdict, 'not-approved');
    assert.match(store.run(run.id).result, /未获得全体一致/);
  } finally { store.close(); }
});

test('讨论结果：结论在前（≤300 字），方案全文折进详情；直接问答不被折叠', async () => {
  const { orch, store, config } = setup({});
  try {
    const run = store.createRun({ kind: 'discuss', goal: '长方案讨论', cwd: config.root, initiator: 'codex' });
    const full = '技术路线：先做 A，再做 B。\n' + '实施步骤：检查、执行、验收。'.repeat(300);
    orch.negotiate = async () => ({ compact: true, consensus: true, adjudicated: false, summaryText: full,
      plan: { summary: '结论：分三步实施，先做 A 再做 B。', sections: [{ id: 's1', title: '技术路线', content: full }] }, metrics: {} });
    await orch.runDiscuss(run.id, new AbortController().signal);
    const result = store.run(run.id).result;
    assert.equal(store.run(run.id).state, 'done');
    assert.match(result, /^结论：分三步实施/);
    assert.match(result, /多方讨论 · 参与/);
    assert.match(result, /以下为详细过程记录/);
    assert.ok(result.length > 1000, '方案全文仍然保留');
    assert.ok(result.indexOf('结论：分三步实施') < result.indexOf('以下为详细过程记录'));
  } finally { store.close(); }
});


// 客户反馈：简单问题被一个人直接答完，却仍显示“一致/共识”，看起来像五个模型都开过会（R476）。
test('讨论直答：单人直答标注“直接答复（未开会）”，不再冒充 consensus', async () => {
  const { orch, store, config } = setup({});
  try {
    const run = store.createRun({ kind: 'discuss', goal: '什么是闭包', cwd: config.root, initiator: 'codex' });
    orch.negotiate = async () => ({ compact: true, consensus: true, adjudicated: false, summaryText: '闭包是带着环境的函数。', plan: null,
      metrics: { directAnswer: { seat: 'deepseek', at: new Date().toISOString() } } });
    store.set('discussionMetrics:' + run.id, { directAnswer: { seat: 'deepseek' }, mode: 'direct', participantCount: 1, candidates: [] });
    await orch.runDiscuss(run.id, new AbortController().signal);
    const r = store.run(run.id);
    assert.equal(r.verdict, 'direct', '单人直答不能记成 consensus');
    assert.match(r.result, /^直接答复（未开会）· 参与：DeepSeek/);
    assert.equal(orch.view(run.id).discussionMetrics.mode, 'direct');
  } finally { store.close(); }
});

// 客户在讨论未通过后只能重试；现在可以直接采纳某个真实候选，标注未全票并保留评审记录（PDF P1）。
test('讨论未通过后可采纳候选：不重跑、不执行文件操作，并如实标注未全票', async () => {
  const { orch, store, config } = setup({});
  try {
    const run = store.createRun({ kind: 'discuss', goal: '失败时是否自动换模型', cwd: config.root, initiator: 'codex' });
    store.updateRun(run.id, { state: 'failed', verdict: 'not-approved', result: '讨论未通过' });
    const plan = { summary: '方案甲：默认报告失败，仅幂等只读可切换', sections: [{ id: 's1', title: '方案', content: '默认报告失败' }] };
    const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    const artifactPath = path.join(config.root, 'discussion-candidates.json');
    fs.writeFileSync(artifactPath, JSON.stringify({ candidates: [{ candidateId: 'candidate-1', planHash, plan, author: 'deepseek', origin: 'repair', summary: '方案甲', reviews: [{ verdict: 'pass' }, { verdict: 'fail' }] }] }));
    store.set('discussionMetrics:' + run.id, { artifactPath, candidates: [{ candidateId: 'candidate-1', planHash, passed: 1, reviews: 2, summary: '方案甲' }] });
    assert.equal(orch.view(run.id).discussionCandidates.length, 1, '未通过的讨论要把候选暴露给看板');
    assert.throws(() => orch.adoptDiscussionCandidate(run.id, 'candidate-9'), /找不到候选/);
    const view = orch.adoptDiscussionCandidate(run.id, 'candidate-1');
    assert.equal(view.state, 'done');
    assert.equal(view.verdict, 'adopted');
    assert.match(view.result, /已采纳 candidate-1/);
    assert.match(view.result, /评审 1\/2/);
    assert.match(view.result, /没有执行文件操作/);
    assert.equal(view.discussionAdoption.candidateId, 'candidate-1');
    assert.equal(store.run(run.id).state, 'done');
  } finally { store.close(); }
});

// 并行任务：结果要回显真实交付目录，并把执行者多写的、未在计划声明的产物标出来（R478）。
test('并行结果回显实际交付目录，并标出未在计划声明的额外产物', () => {
  const { orch, store, config } = setup({});
  try {
    const run = store.createRun({ kind: 'parallel', goal: '建两个文件', cwd: config.root, initiator: 'codex' });
    store.updateRun(run.id, { state: 'running', rounds: 1, plan: { tasks: [{ id: 't1', title: '写文件', owner: 'deepseek', files: ['beat-eval/a.txt', 'beat-eval/b.txt'] }], acceptance: [] } });
    const reports = [{ label: 'DeepSeek', text: '完成', artifacts: [path.join(config.root, 'beat-eval/a.txt'), path.join(config.root, 'beat-eval/b.txt'), path.join(config.root, 'a.txt')] }];
    orch.finishParallel(run.id, 'passed', { verdict: 'pass', summary: 'ok', issues: [] }, reports);
    const result = store.run(run.id).result;
    assert.match(result, /交付位置：/);
    assert.match(result, /额外产物（未在计划中声明/);
    assert.match(result, /a\.txt/);
  } finally { store.close(); }
});

test('controller allocates customer task limits before approval, preserving plan content and model suggestions as audit evidence', () => {
  const {orch,store,config}=setup({});
  try {
    const run=store.createRun({kind:'parallel',goal:'预算由控制器分配',cwd:config.root,initiator:'codex'});
    const proposed={tasks:[{id:'create',owner:'deepseek',title:'创建产物',tokenBudget:16000,acceptance:['内容正确']},{id:'report',owner:'codex',tokenBudget:999999,dependsOn:['create']}],acceptance:['不覆盖已有文件']};
    const original=structuredClone(proposed);
    const compiled=orch.compileControlledPlan(run,proposed);
    assert.deepEqual(compiled.tasks.map(task=>task.tokenBudget),[config.flow.taskTokenBudget,config.flow.taskTokenBudget]);
    assert.deepEqual(proposed,original,'模型原始记录保留');
    assert.deepEqual(compiled.acceptance,original.acceptance);
    assert.deepEqual(compiled.tasks[1].dependsOn,['create']);
    assert.deepEqual(store.get('planBudgetEvidence:'+run.id)[0].tasks.map(task=>task.proposed),[16000,999999]);
    config.flow.taskTokenBudget=4000;
    assert.deepEqual(orch.compileControlledPlan(run,proposed).tasks.map(task=>task.tokenBudget),[4000,4000],'不自动增加客户的低预算上限');
  } finally {store.close();}
});

test('queue delivery and budget failure reports show task title, errors and artifact paths without undefined values', () => {
  const {orch,store,config}=setup({});
  try {
    const run=store.createRun({kind:'parallel',goal:'结果报告',cwd:config.root,initiator:'codex'});
    store.set('controlMode:'+run.id,{pullQueue:true});
    store.updateRun(run.id,{plan:{tasks:[{id:'create',title:'创建产物'}]}});
    orch.finishParallel(run.id,'failed',{verdict:'fail',summary:'预算不足',issues:['预算不足']},[{taskId:'create',executor:'deepseek',error:'任务预算不足，尚未执行'},{taskId:'evidence',executor:'codex',summary:'保留已完成产物',artifacts:[{path:'E:\\beat\\产物.txt'}]}]);
    const result=store.run(run.id).result;
    assert.match(result,/创建产物 交付报告/);assert.match(result,/任务预算不足，尚未执行/);assert.match(result,/E:\\beat\\产物.txt/);assert.doesNotMatch(result,/undefined/);
  } finally {store.close();}
});

for (const legacy of [false, true]) test(`讨论恢复：第二轮失败只补失败方，服务重启保留会话（旧任务=${legacy}）`, async () => {
  let cxTurns=0,dsTurns=0,fail=true,executions=0;
  const ids=[];
  const {orch,store,config}=setup({
    codex:async(o,k)=>{
      if(k==='turn'){cxTurns++;if(cxTurns===2)await new Promise(r=>setTimeout(r,50));return {...turn(cxTurns===1?'open':'agree',{plan:cxTurns===1?PLAN:null}),nativeId:'cx-discussion'};}
      if(k==='execute'){executions++;return {text:'## 交付报告',nativeId:'cx-discussion'};}
      return {...pass,nativeId:'cx-discussion'};
    },
    deepseek:(o,k)=>{
      ids.push({kind:k,nativeId:o.nativeId||null});
      if(k==='turn'){dsTurns++;if(dsTurns===2&&fail){const e=new Error('HTTP 502');e.noFallback=true;throw e;}return {...turn('agree'),nativeId:'ds-discussion'};}
      return {text:'## 交付报告',nativeId:'ds-discussion'};
    },
  });
  const id=orch.startParallel({goal:'恢复讨论'}).id;
  let r=await finished(orch,id);
  assert.equal(r.state,'error');assert.match(r.error,/HTTP 502/);
  assert.equal(executions,0,'未经全体批准不能执行');
  assert.equal(store.steps(id).filter(s=>s.seat==='codex'&&s.round===2&&s.state==='done').length,1,'等待本轮其他方完成才结束');
  while(orch.active.has(id))await new Promise(r=>setTimeout(r,5));
  if(legacy)store.db.prepare("DELETE FROM kv WHERE k LIKE ?").run('negotiation:'+id+':%');
  fail=false;
  const restarted=new Orchestrator({config,store,agents:orch.agents});
  if(legacy)restarted.recoverDiscussions();else restarted.resume(id);
  r=await finished(restarted,id);
  assert.equal(r.state,'passed');assert.equal(cxTurns,2,'完成方不重复发言');assert.equal(dsTurns,3,'只补第二轮失败方');
  const turns=ids.filter(x=>x.kind==='turn');
  assert.equal(turns.at(-1).nativeId,'ds-discussion','讨论恢复续接在固定的只读会话上，不新建空会话');
  assert.equal(ids.at(-1).kind,'execute');
  assert.equal(ids.at(-1).nativeId,null,'执行不能复用只读建起来的会话，另行使用创建时就可写的固定会话');
  assert.equal(executions,1);
});

test('独立讨论中断后可继续，保留已完成方答复',async()=>{
  let cx=0,ds=0,fail=true;
  const {orch,store}=setup({
    codex:(o,k)=>k==='turn'?(cx++,turn('agree')):{text:'最终结论'},
    deepseek:()=>{ds++;if(fail){const e=new Error('读取中断（整体超时）');e.noFallback=true;throw e;}return turn('agree');},
  });
  const id=orch.startDiscuss({question:'只读讨论'}).id;
  assert.equal((await finished(orch,id)).state,'error');
  while(orch.active.has(id))await new Promise(r=>setTimeout(r,5));
  fail=false;orch.resume(id);
  assert.equal((await finished(orch,id)).state,'done');assert.equal(cx,2);assert.equal(ds,3);
  assert.equal(store.steps(id).filter(s=>s.role==='discuss'&&s.seat==='codex'&&s.round===1).length,1);
});

test('讨论自动恢复：持续超时重试有上限，401 不自动重试',async()=>{
  for(const errorText of ['整体超时','HTTP 401']){
    let cx=0,ds=0;
    const {orch}=setup({codex:()=>{cx++;return turn('agree');},deepseek:()=>{ds++;const e=Error(errorText);e.noFallback=true;throw e;}},{flow:{discussionRetryDelays:[1,1,1]}});
    const r=await finished(orch,orch.startDiscuss({question:'故障实验'}).id);
    assert.equal(r.state,'error');assert.equal(cx,1);assert.equal(ds,errorText==='HTTP 401'?1:4);assert.match(r.error,new RegExp(errorText));
  }
});

test('自动讨论退避期间用户取消，停止重试',async()=>{
  let calls=0;
  const {orch,store}=setup({codex:()=>turn('agree'),deepseek:()=>{calls++;const e=Error('HTTP 502');e.noFallback=true;throw e;}},{flow:{discussionRetryDelays:[5000]}});
  const id=orch.startDiscuss({question:'取消退避'}).id;
  for(let n=0;n<100&&!store.events(100).some(e=>e.text.includes('自动续接'));n++)await new Promise(r=>setTimeout(r,5));
  orch.cancel(id);
  for(let n=0;n<100&&orch.active.has(id);n++)await new Promise(r=>setTimeout(r,5));
  assert.equal(store.run(id).state,'cancelled');assert.equal(calls,1);assert.equal(orch.active.has(id),false);
  orch.recoverDiscussions();assert.equal(orch.active.has(id),false,'服务启动也不能恢复用户主动取消的任务');
});

test('讨论：发起方提出，对方无保留同意 → 达成一致，发起方写结论', async () => {
  const { orch, store } = setup({
    codex: (o, k) => (k === 'turn' ? turn('open') : { text: '最终结论：用方案 A' }),
    deepseek: (o, k) => turn('agree'),
  });
  const r = await finished(orch, orch.startDiscuss({ question: '用 A 还是 B？', source: 'codex' }).id);
  assert.equal(r.state, 'done');
  assert.equal(r.verdict, 'consensus');
  assert.deepEqual(roles(store, r.id), ['discuss:codex:codex', 'discuss:deepseek:deepseek', 'discuss:codex:codex', 'discuss:deepseek:deepseek', 'summary:codex:codex']);
  assert.match(r.result, /方案 A/);
});

test('讨论：僵持到上限不请 Claude，DeepSeek 发起时由它先说并写结论', async () => {
  const { orch, store } = setup({
    codex: (o, k) => (o.prompt.includes('顾问已给出意见') ? turn('agree') : turn('disagree', { open_issues: ['不同意'] })),
    deepseek: (o, k) => (k === 'summary' ? { text: '结论' } : o.prompt.includes('顾问已给出意见') ? turn('agree') : o.prompt.includes('本轮共同提案') ? turn('open') : turn('disagree', { open_issues: ['不同意'] })),
    claude: () => ({ text: json({ summary: '建议折中' }) }),
  });
  const r = await finished(orch, orch.startDiscuss({ question: 'x', initiator: 'deepseek', max_turns: 4 }).id);
  assert.equal(r.verdict, 'no-consensus');
  assert.deepEqual(roles(store, r.id), ['discuss:deepseek:deepseek', 'discuss:codex:codex', 'discuss:deepseek:deepseek', 'discuss:codex:codex',
    'summary:deepseek:deepseek']);
});

test('讨论：有人要求顾问，仍由搭档继续讨论；不一致由发起方给结论', async () => {
  const { orch, store } = setup({
    codex: (o, k) => (k === 'summary' ? { text: '裁定' } : turn('open')),
    deepseek: () => turn('disagree', { open_issues: ['信息不够'], need_advisor: true }),
    claude: () => ({ text: json({ summary: '我的看法' }) }),
  });
  const r = await finished(orch, orch.startDiscuss({ question: 'x' }).id);
  assert.equal(r.verdict, 'no-consensus');
  assert.deepEqual(roles(store, r.id).map(x => x.split(':')[0]), ['discuss', 'discuss', 'discuss', 'discuss', 'discuss', 'discuss', 'summary']);
});

test('并行：商定分工 → 双方同时执行 → 发起方评估通过', async () => {
  let running = 0, peak = 0;
  const exec = file => async o => { running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 30)); fs.writeFileSync(path.join(o.cwd, file), 'x'); running--; return { text: '## 交付报告 完成' }; };
  const codexExec = exec('api.mjs'), dsExec = exec('ui.mjs');
  const { orch, store } = setup({
    codex: (o, k) => (k === 'turn' ? turn('open', { plan: PLAN }) : k === 'execute' ? codexExec(o) : pass),
    deepseek: (o, k) => (k === 'turn' ? turn('agree', { plan: null }) : dsExec(o)),
  });
  const r = await finished(orch, orch.startParallel({ goal: '写前后端', source: 'codex' }).id);
  assert.equal(r.state, 'passed');
  assert.equal(peak, 2, '两边应同时执行');
  assert.deepEqual(r.plan.tasks.map(t => t.owner), ['codex', 'deepseek']);
  assert.deepEqual(roles(store, r.id), ['discuss:codex:codex', 'discuss:deepseek:deepseek', 'discuss:codex:codex', 'discuss:deepseek:deepseek', 'execute:codex:codex', 'execute:deepseek:deepseek', 'evaluate:codex:codex']);
  const ev = store.steps(r.id).at(-1);
  assert.match(ev.prompt, /新增 api\.mjs/); assert.match(ev.prompt, /新增 ui\.mjs/);
  const ex = store.steps(r.id).find(s => s.seat === 'deepseek' && s.role === 'execute');
  assert.match(ex.prompt, /写 ui\.mjs/); assert.match(ex.prompt, /不要修改它负责的文件/);
});

test('并行：一方完成后另一方卡住 → 自动接手，接手告知写进备注（不再单独开会话通知）', async () => {
  const plan = { tasks: [PLAN.tasks[0], PLAN.tasks[1]], acceptance: ['ok'], checks: [] };
  const { orch, store } = setup({
    codex: (o, k) => (k === 'turn' ? turn('open', { plan }) : k === 'evaluate' ? pass : { text: '## 交付报告 完成' }),
    deepseek: (o, k) => {
      if (k === 'turn') return turn('agree');
      if (k === 'help') return { text: '## 交付报告 我替它做完了' };
      if (k === 'notice') return { text: '不应该有这一步' };
      // 执行席位：很慢才返回，期间没有任何输出（模拟卡住）
      return new Promise(r => setTimeout(() => r({ text: '## 交付报告 慢但完成' }), 2500));
    },
    claude: async () => ({ text: '顾问' }),
  }, { flow: { stallOverrideMinutes: 0.01, stallCheckMs: 200, maxRounds: 1 } });
  const id = orch.startParallel({ goal: 'x', initiator: 'codex' }).id;
  for (let i = 0; i < 400 && !store.steps(id).some(s => s.role === 'help'); i++) await new Promise(r => setTimeout(r, 25));
  const roles = store.steps(id).map(s => s.role + ':' + s.agent);
  // 两个执行方不同（Codex 与 DeepSeek），所以允许接手：帮忙由「已完成的一方」（Codex）执行
  assert.ok(roles.includes('help:codex'), '应触发接手：' + roles.join(','));
  assert.ok(!roles.includes('notice:codex'), '不再单独开会话做通知：' + roles.join(','));
  const stuckStep = store.steps(id).find(s => s.role === 'execute' && s.seat === 'deepseek');
  assert.match(stuckStep.error || '', /已被 Codex 接手/, '被帮忙的一方应在备注里看到通知');
  // 等它收尾（用更长的上限，因为这一轮的“执行”本来就是慢的）
  for (let i = 0; i < 600 && !orch.isFinal(store.run(id).state); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(orch.isFinal(store.run(id).state), '任务应结束：' + store.run(id).state);
});

test('并行：只剩一个模型能执行时，同一个模型不向自己接手（不重复开会话）', async () => {
  const plan = { tasks: [PLAN.tasks[0], PLAN.tasks[1]], acceptance: ['ok'], checks: [] };
  const { orch, store } = setup({
    deepseek: (o, k) => (k === 'turn' ? turn(o.prompt.includes('本轮共同提案') ? 'open' : 'agree', { plan }) : k === 'evaluate' ? pass
      // 执行：很慢才返回，期间没有任何输出（模拟卡住），但它就是唯一能干活的模型
      : new Promise(r => setTimeout(() => r({ text: '## 交付报告 慢但完成' }), 1200))),
    claude: (o, k) => (k === 'turn' ? turn('agree') : pass),   // Codex 位下线时由它顶上讨论
  }, { flow: { stallOverrideMinutes: 0.01, stallCheckMs: 200, maxRounds: 1 } });
  orch.roster.setPaused('codex', true);       // Codex 下线 → 两个执行座位都落到 DeepSeek
  // Resume an already-approved plan. A brand-new single-partner negotiation is blocked.
  const run = store.createRun({ kind: 'parallel', goal: 'x', cwd: orch.config.workspace, initiator: 'deepseek', max_rounds: 1 });
  store.updateRun(run.id, { plan }); store.set('resume:' + run.id, { from: 'execute' });
  orch.launch(store.run(run.id), signal => orch.runParallel(run.id, signal));
  const id = run.id;
  for (let i = 0; i < 60; i++) await new Promise(r => setTimeout(r, 25));
  const steps = store.steps(id);
  const roles = steps.map(s => s.role + ':' + s.seat + ':' + s.agent);
  assert.ok(!steps.some(s => s.role === 'help'), '同一个模型不应向自己接手：' + roles.join(','));
  assert.ok(!steps.some(s => s.role === 'diagnose'), '同一个模型不应触发诊断：' + roles.join(','));
  const exec = steps.filter(s => s.role === 'execute');
  assert.equal(exec.length, 1, '两个座位应合并成一个执行会话：' + roles.join(','));
  assert.equal(exec[0].agent, 'deepseek');
  for (let i = 0; i < 400 && !orch.isFinal(store.run(id).state); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(orch.isFinal(store.run(id).state), '任务应结束：' + store.run(id).state);
});

test('并行：异议没解决就不分工，继续伙伴讨论直到全体同意', async () => {
  let codexTurns = 0;
  const { orch, store } = setup({
    codex: (o, k) => {
      if (k !== 'turn') return k === 'evaluate' ? pass : { text: '## 交付报告' };
      codexTurns++;
      if (codexTurns === 1) return turn('open', { plan: PLAN });
      // 前 5 次都有异议，第 6 次才无保留同意
      return codexTurns >= 6 ? turn('agree') : turn('disagree', { open_issues: ['接口还没定'] });
    },
    deepseek: (o, k) => (k === 'turn' ? turn(codexTurns >= 5 ? 'agree' : 'disagree', { open_issues: codexTurns >= 5 ? [] : ['不同意'] }) : { text: '## 交付报告' }),
    claude: () => ({ text: json({ summary: '建议先统一接口' }) }),
  });
  const r = await finished(orch, orch.startParallel({ goal: 'x', max_turns: 12 }).id);
  assert.equal(r.state, 'passed', r.error || r.result || '');
  const roles = store.steps(r.id).map(s => s.role);
  assert.ok(!roles.includes('decide'), '达成一致后应直接分工，不应由发起方强行定稿：' + roles.join(','));
  assert.ok(roles.filter(x => x === 'discuss').length > 4, '顾问之后应继续讨论，而不是 2 次就停');
  assert.equal(roles.filter(x => x === 'advisor').length, 0, '常规讨论不请顾问');
  const execIndex = roles.indexOf('execute'), lastDiscuss = roles.lastIndexOf('discuss');
  assert.ok(execIndex > lastDiscuss, '执行必须在讨论结束之后');
});

test('并行：一直有异议 → 到安全上限停止，不执行未获批准的计划', async () => {
  const { orch, store } = setup({
    codex: (o, k) => (k === 'turn' ? turn('open', { plan: PLAN }) : k === 'decide' ? { text: json({ summary: '我来定', plan: PLAN }) } : k === 'evaluate' ? pass : { text: '## 交付报告' }),
    deepseek: (o, k) => (k === 'turn' ? turn('disagree', { open_issues: ['还是不同意'] }) : { text: '## 交付报告' }),
    claude: () => ({ text: json({ summary: '顾问' }) }),
  }, { flow: { negotiateCap: 10 } });
  const r = await finished(orch, orch.startParallel({ goal: 'x', max_turns: 10 }).id);
  const roles = store.steps(r.id).map(s => s.role);
  assert.equal(roles.filter(x => x === 'discuss').length, 10);
  assert.equal(r.state, 'failed');
  assert.ok(!roles.includes('decide') && !roles.includes('execute'));
  assert.ok(store.events(80).some(e => /触到安全上限/.test(e.text)));
});

test('附件：复制进工作目录，提示词带路径；Codex 拿到图片输入（每个会话只发一次），Claude 拿到图片内容', async () => {
  const seen = { codex: [], claude: [] };
  const { orch, store, config } = setup({
    codex: o => { seen.codex.push({ images: o.images, prompt: o.prompt, effort: o.effort }); return { text: '看到了', nativeId: 'th-1' }; },
    deepseek: o => ({ text: 'ok' }),
    claude: o => { seen.claude.push(o.images); return { text: '图里是一只猫' }; },
  });
  const src = path.join(config.root, 'cat.png'); fs.writeFileSync(src, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const note = path.join(config.root, 'note.txt'); fs.writeFileSync(note, '需求：只要红色');
  const a = await finished(orch, orch.startAsk({ to: 'codex', question: '这是什么', attachments: [src, note], effort: 'high' }).id);
  const run = store.run(a.id);
  assert.equal(run.attachments.length, 2);
  assert.ok(run.attachments.every(x => fs.existsSync(x.path) && x.path.includes('.beat-attachments')));
  assert.equal(seen.codex[0].images.length, 1, '图片应作为原生图片输入');
  assert.match(seen.codex[0].prompt, /note\.txt/);
  assert.equal(seen.codex[0].effort, 'high');
  // 续问：同一会话不再重复发同一张图；强度沿用会话
  await finished(orch, orch.startAsk({ to: 'codex', question: '再说说', session_id: a.session_id }).id);
  assert.equal(seen.codex[1].images.length, 0);
  assert.equal(seen.codex[1].effort, 'high');
  const c = await finished(orch, orch.startAsk({ to: 'claude', question: '这是什么', attachments: [src, note] }).id);
  assert.equal(seen.claude[0].length, 1);
  assert.equal(seen.claude[0][0].mime, 'image/png');
  assert.match(store.steps(c.id)[0].prompt, /需求：只要红色/, 'Claude 无法读盘，文本附件应内联');
  assert.throws(() => orch.startAsk({ to: 'codex', question: 'x', attachments: ['relative.png'] }), /绝对路径/);
});

test('推理强度：并行任务按各方分别生效，并记到每一步', async () => {
  const efforts = [];
  const { orch, store } = setup({
    codex: (o, k) => { efforts.push(['codex', o.effort]); return k === 'turn' ? turn('open', { plan: PLAN }) : k === 'evaluate' ? pass : { text: '## 交付报告', effort: o.effort }; },
    deepseek: (o, k) => { efforts.push(['deepseek', o.effort]); return k === 'turn' ? turn('agree') : { text: '## 交付报告', effort: o.effort }; },
  });
  const r = await finished(orch, orch.startParallel({ goal: 'x', efforts: { codex: 'xhigh', deepseek: 'max' } }).id);
  assert.equal(r.state, 'passed');
  assert.ok(efforts.every(([p, e]) => e === (p === 'codex' ? 'xhigh' : 'max')), JSON.stringify(efforts));
  assert.deepEqual(store.run(r.id).efforts, { codex: 'xhigh', deepseek: 'max' });
  assert.ok(store.steps(r.id).filter(s => s.role === 'execute').every(s => s.effort));
});

test('原生会话被占用 → 原地重试而不是换人；不当成“这一方下线”', async () => {
  let calls = 0;
  const { orch, store } = setup({
    codex: (o, k) => {
      if (k !== 'turn') return { text: '结论' };
      calls++;
      if (calls === 1) throw new Error('thread abc already has an active writer');
      return turn('open');
    },
    deepseek: (o, k) => turn('agree'),
    claude: async () => ({ text: '顾问' }),
  });
  const r = await finished(orch, orch.startDiscuss({ question: 'x', initiator: 'codex' }).id);
  assert.equal(calls, 3, '同一方重试后仍需共同审议下一轮');
  assert.equal(store.steps(r.id)[0].agent, 'codex', '不应换人');
  assert.equal(orch.roster.state('codex').status, 'online', '占用不能把 Codex 判为下线');
  assert.equal(r.verdict, 'consensus');
  assert.ok(store.events(50).some(e => /被另一个进程写入/.test(e.text)), '应记录重试事件');
});

test('并行：商定的验收命令由 BEAT 在沙箱外实际运行，结果交给评估方', async () => {
  const plan = { ...PLAN, tasks: [PLAN.tasks[1]], checks: ['node -e "console.log(6*7)"', 'node -e "process.exit(3)"'] };
  const { orch, store } = setup({
    codex: (o, k) => (k === 'turn' ? turn('open', { plan }) : pass),
    deepseek: (o, k) => (k === 'turn' ? turn('agree') : { text: '## 交付报告' }),
  });
  const r = await finished(orch, orch.startParallel({ goal: 'x' }).id);
  assert.equal(r.state, 'passed', r.error || undefined);
  const check = store.steps(r.id).find(s => s.role === 'check');
  assert.equal(check.note, '1/2 通过');
  const ev = store.steps(r.id).find(s => s.role === 'evaluate');
  assert.match(ev.prompt, /42/); assert.match(ev.prompt, /退出码 3/);
});

test('并行：改方案需再确认；评估首次失败就请顾问，只让原负责方返工', async () => {
  let evals = 0;
  const NEW = { ...PLAN, acceptance: ['两个文件都存在', '接口一致'] };
  const { orch, store } = setup({
    deepseek: (o, k) => (k === 'turn' ? (o.prompt.includes('你是发起方') ? turn('open', { plan: PLAN }) : turn('agree')) : k === 'evaluate' ? (++evals >= 3 ? pass : failV('codex')) : { text: '## 交付报告' }),
    codex: (o, k) => (k === 'turn' ? turn('agree', { plan: o.prompt.includes('BEAT 返工任务') ? null : NEW }) : { text: '## 交付报告 改好了' }),
    claude: () => ({ text: '顾问：先统一接口' }),
  }, { flow: { maxRounds: 3 } });
  const r = await finished(orch, orch.startParallel({ goal: 'x', initiator: 'deepseek' }).id);
  assert.equal(r.state, 'passed');
  assert.deepEqual(r.plan.acceptance, NEW.acceptance, '应采用对方修改并经发起方确认的方案');
  const s = roles(store, r.id);
  assert.equal(s.filter(x=>x.startsWith('evaluate:')).length,3);
  assert.equal(s.filter(x=>x.startsWith('consult:')).length,1);
  assert.equal(s.filter(x=>x.startsWith('execute:')).length,4);
  assert.ok(store.steps(r.id).filter(x=>x.role==='discuss').every(x=>x.data.discussionCycle>=1));
  const last = store.steps(r.id).filter(x => x.role === 'execute').at(-1);
  assert.match(last.prompt, /改成 getData/); assert.match(last.prompt, /顾问：先统一接口/);
});

test('并行：讨论不出分工 → failed，不强行分派也不请执行顾问', async () => {
  const { orch, store } = setup({
    codex: (o, k) => (k === 'turn' ? turn('open') : k === 'decide' ? { text: json({ summary: '我来定', plan: PLAN }) } : k === 'evaluate' ? failV('deepseek') : { text: '## 交付报告' }),
    deepseek: (o, k) => (k === 'turn' ? turn('disagree', { open_issues: ['x'] }) : { text: '## 交付报告' }),
  }, { claudeKey: '' });
  const r = await finished(orch, orch.startParallel({ goal: 'x', max_turns: 2, max_rounds: 2 }).id);
  assert.equal(r.state, 'failed');
  const s = roles(store, r.id);
  assert.ok(!s.some(v => v.startsWith('decide:') || v.startsWith('execute:') || v.startsWith('advisor:')));
});

test('顶替：讨论中 Codex 限额，代答不能冒充批准；冷却后成功即恢复', async () => {
  let codexOk = false;
  const { orch, store } = setup({
    codex: (o, k) => { if (!codexOk) throw new Error('You have hit your usage limit'); return k === 'turn' ? turn('open', { plan: PLAN }) : k === 'execute' ? { text: '## 交付报告' } : pass; },
    deepseek: (o, k) => (k === 'turn' ? turn(o.prompt.includes('本轮共同提案') ? 'open' : 'agree', { plan: PLAN }) : k === 'evaluate' ? pass : { text: '## 交付报告' }),
    claude: (o, k) => (k === 'turn' ? turn('open', { plan: PLAN }) : pass),
  });
  const r = await finished(orch, orch.startParallel({ goal: 'x', initiator: 'codex' }).id);
  assert.equal(r.state, 'failed');
  // Codex 限额 → 讨论席位由 Claude 顶上；执行两个座位都落到 DeepSeek，合并成一个会话
  assert.ok(roles(store, r.id).includes('discuss:codex:deepseek'));
  assert.ok(!store.steps(r.id).some(s => s.role === 'execute'), '中途掉线不能用代答批准开工');
  assert.equal(orch.roster.state('codex').status, 'cooldown');
  assert.match(store.steps(r.id)[0].error, /usage limit/);
  assert.equal(store.steps(r.id)[0].data.ownVote, false);

  const h = store.get('health'); h.codex.until = new Date(Date.now() - 1000).toISOString(); store.set('health', h);
  codexOk = true;
  const r2 = await finished(orch, orch.startDiscuss({ question: 'y' }).id);
  assert.equal(store.steps(r2.id)[0].agent, 'codex');
  assert.equal(orch.roster.state('codex').status, 'online');
});

test('初始只剩Codex：不让单人讨论和自评冒充独立核验，顾问不进入常规讨论', async () => {
  const { orch, store } = setup({
    codex: (o, k) => (k === 'turn' ? turn(o.prompt.includes('本轮共同提案') ? 'open' : 'agree', { plan: PLAN }) : k === 'execute' ? { text: '## 交付报告' } : pass),
    claude: () => turn('agree'),
  });
  orch.roster.setPaused('deepseek', true);
  const r = await finished(orch, orch.startParallel({ goal: 'x' }).id);
  assert.equal(r.state, 'error');
  assert.deepEqual(roles(store, r.id), []);
  assert.match(r.error, /至少需要两位搭档/);
  assert.deepEqual(store.get('participant:' + r.id), ['codex']);
  assert.equal(orch.view(r.id).excludedParticipants[0].agent, 'deepseek');
  orch.roster.setPaused('deepseek', false);
  assert.equal(orch.roster.state('deepseek').status, 'online');
});

test('问答：续问沿用同一原生会话；对方下线时由其他方顶上', async () => {
  const seen = [];
  const { orch, store } = setup({
    deepseek: o => { seen.push(o.nativeId); return { text: '答' + seen.length, nativeId: 'session-9' }; },
    codex: () => { throw new Error('spawn ENOENT 无法启动 Codex'); },
    claude: o => ({ text: '我来答，历史 ' + o.history.length }),
  });
  const a = orch.startAsk({ to: 'deepseek', question: '一' });
  await finished(orch, a.id);
  const b = await finished(orch, orch.startAsk({ to: 'deepseek', question: '二', session_id: a.session_id }).id);
  assert.deepEqual(seen, [undefined, 'session-9']);
  assert.equal(b.result, '答2');
  assert.throws(() => orch.startAsk({ to: 'codex', question: 'x', session_id: a.session_id }), /是问 DeepSeek 的/);
  const c = await finished(orch, orch.startAsk({ to: 'codex', question: 'q' }).id);
  assert.equal(c.state, 'done');
  assert.equal(store.steps(c.id)[0].agent, 'deepseek');
});

// 用户实测场景：在拓展坞模型的会话里续问，但下拉选着 Codex。会话固定属于一个搭档，
// 必须明确拒绝（指名道姓，不能出现 undefined），而且不许真的跑起来、不许烧 token。
// 客户要求：讨论/并行任务也要能"追问"——沿用原任务的固定会话，并把原目标与原结果带过去。
test('就已完成的任务追问：留在原任务里继续，沿用它的固定会话，并带上原目标与原结果', async () => {
  const seen = [];
  const { config, store, orch } = setup({ codex: o => { seen.push(o); return { text: '交付在 E:\\work\\pelican-bike.html', nativeId: o.nativeId }; } });
  const parent = store.createRun({ kind: 'parallel', goal: '做一个鹈鹕动画', cwd: config.workspace, initiator: 'codex', max_turns: 12 });
  store.updateRun(parent.id, { state: 'passed', result: '交付：pelican-bike.html' });
  store.updateRun(parent.id, { natives: { 'conversation:codex': { id: parent.id + ':codex', cwd: config.workspace, native: 'native-136', model: 'codex-fixture', history: [] } } });
  const before = store.runs(50).length;
  const run = orch.startFollowup({ id: parent.id, question: '这份交付在哪？', access: 'read-only' });
  // 新契约：不新建任务，仍返回原任务
  assert.equal(run.id, parent.id, '追问必须留在原任务里，不能另起一个任务');
  assert.equal(store.runs(50).length, before, '不得因此多出一个任务');
  const done = await finished(orch, parent.id);
  assert.equal(done.state, 'passed');
  // 追问记录与答复都写进原任务
  const list = store.get('followups:' + parent.id) || [];
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'question', '读-only 的追问按提问处理，不开会');
  assert.equal(list[0].state, 'answered');
  assert.match(list[0].answer, /pelican-bike\.html/, '答复要留在追问记录里');
  assert.match(done.result, /pelican-bike\.html/, '答复要出现在原任务结果里');
  assert.equal(list[0].question, '这份交付在哪？', '原问题要留痕');
  // 结论要说实话：追问没有评估轮，不能印"发起方评估通过（第 0 轮）"
  assert.match(done.result, /本任务追问：已直接答复（未开会）/, '结论头必须按追问实情写');
  assert.doesNotMatch(done.result, /评估通过（第 \d+ 轮）/, '不得套用评估轮话术');
  assert.equal(seen[0].nativeId, 'native-136', '必须沿用原任务的固定会话（原生线程继续）');
  assert.match(String(seen[0].prompt || ''), /做一个鹈鹕动画/, '提示里要带原目标');
  assert.match(String(seen[0].prompt || ''), /交付：pelican-bike\.html/, '提示里要带原结果');
  // 追问也能带附件（客户要求：追问区要能上传文件/文件夹）：附件要落进任务目录、并随提示词一起送给模型
  const uploadDir = path.join(config.dataDir, 'uploads', 'F-11111111-1111-1111-1111-111111111111');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'note.txt'), '附件暗号=OK\n');
  fs.writeFileSync(path.join(uploadDir, 'meta.json'), JSON.stringify({ id: 'F-11111111-1111-1111-1111-111111111111', name: 'note.txt', size: 15, mime: 'text/plain', image: false }));
  const withFile = orch.startFollowup({ id: parent.id, question: '读我上传的附件', access: 'read-only', attachments: ['F-11111111-1111-1111-1111-111111111111'] });
  await finished(orch, withFile.id);
  const listWithFile = store.get('followups:' + parent.id) || [];
  const entry = listWithFile.at(-1);
  assert.equal(entry.attachments?.length, 1, '追问记录要记住这次带了附件');
  assert.ok(fs.existsSync(entry.attachments[0].path), '附件要真的复制进任务工作目录：' + entry.attachments[0].path);
  assert.match(entry.attachments[0].path, /\.beat-attachments/, '附件放在 .beat-attachments 下，不混进交付物');
  const filePrompt = String(seen.at(-1).prompt || '');
  assert.match(filePrompt, /note\.txt/, '附件的名字要出现在送给模型的提示词里');
  assert.throws(() => orch.startFollowup({ id: 'R999', question: 'x' }), /找不到任务/);
  const running = store.createRun({ kind: 'parallel', goal: '在跑', cwd: config.workspace, initiator: 'codex' });
  store.updateRun(running.id, { state: 'running' });
  assert.throws(() => orch.startFollowup({ id: running.id, question: 'x' }), /还在跑/);
  assert.throws(() => orch.startFollowup({ id: parent.id, question: '  ' }), /先写要追问什么/);
});

// 用户实测 R474：对 DeepSeek 的问答任务追问，旧代码按 parent.initiator||'codex' 落到 Codex 席位，
// 却仍按原任务 requestedModel=deepseek-flash 请求模型，上游直接 400；任务失败、token 白烧。
test('问答追问：默认沿用原任务的搭档席位与模型，不能派给 Codex 却请求 DeepSeek 模型（R474 回归）', async () => {
  const seen = [];
  const { orch, store } = setup({
    deepseek: o => { seen.push({ model: o.model, nativeId: o.nativeId, prompt: o.prompt }); return { text: '答复' + seen.length, nativeId: 'ds-native-1' }; },
    codex: () => { throw new Error('不应把 DeepSeek 任务的追问派给 Codex'); },
  });
  try {
    const ask = await finished(orch, orch.startAsk({ to: 'deepseek', question: '第一问：只回复一个字' }).id);
    assert.equal(ask.state, 'done');
    const run = orch.startFollowup({ id: ask.id, question: '再解释一下刚才的答案', access: 'read-only' });
    const done = await finished(orch, run.id);
    assert.equal(done.state, 'done', '纯问答追问只表示答复完成，不能冒充交付已独立核验');
    assert.equal(seen.length, 2, '追问必须由原搭档回答');
    assert.equal(seen[1].nativeId, 'ds-native-1', '追问沿用原会话，不新建空会话');
    assert.equal(seen[1].model, 'deepseek-fixture', '请求模型必须是原搭档自己的模型');
    const list = store.get('followups:' + ask.id) || [];
    assert.equal(list.at(-1).seat, 'deepseek', '追问席位记录必须是原搭档');
    // 显式换搭档不能带着原任务的模型硬派给另一个席位
    assert.throws(() => orch.startFollowup({ id: ask.id, question: '换个人回答', to: 'codex' }), /问答任务|原搭档|另发/);
  } finally { store.close(); }
});

test('问答：拓展坞的会话不能被别的模型续问，拒绝信息要指名道姓', async () => {
  const dockId = 'dock:glm';
  const { orch, store, config } = setup({ dock: async () => ({ text: '拓展坞答复', history: [] }) });
  config.dock = [{ id: dockId, name: 'GLM', enabled: true, model: 'glm-5.3', baseUrl: 'https://example.invalid/v1' }];
  config.secrets = { ...config.secrets, dockKeys: { [dockId]: 'fixture-key' } };
  registerAgentNames(config.dock);
  const a = orch.startAsk({ to: dockId, question: '拓展坞的第一问' });
  const first = await finished(orch, a.id);
  assert.equal(first.state, 'done');
  const before = store.runs(50).length;
  let message = '';
  try { orch.startAsk({ to: 'codex', question: '想用 Codex 续问', session_id: a.session_id }); } catch (e) { message = e.message; }
  assert.match(message, /是问 GLM · glm-5\.3 的/, '要说清这条会话是问谁的');
  assert.match(message, /不能用来问 Codex/, '要说清不能拿谁来续问');
  assert.doesNotMatch(message, /undefined/, '拓展坞的名字不能漏成 undefined');
  // 名字里已经带模型名时不能再挂一遍（实测见过 "glm-5.3 · glm-5.3" 这种重复）
  registerAgentNames([{ id: 'dock:dup', name: 'glm-5.3', model: 'glm-5.3' }]);
  assert.equal(AGENT['dock:dup'], 'glm-5.3', '名字已含模型名时不重复拼接');
  registerAgentNames(config.dock);
  assert.equal(store.runs(50).length, before, '被拒的续问不许建任务（不烧 token）');
});

test('取消正在执行的并行任务', async () => {
  const hang = o => new Promise((_, reject) => o.signal.addEventListener('abort', () => { const e = new Error('已取消'); e.cancelled = true; reject(e); }));
  const { orch, store } = setup({
    codex: (o, k) => (k === 'turn' ? turn('open', { plan: PLAN }) : hang(o)),
    deepseek: (o, k) => (k === 'turn' ? turn('agree') : hang(o)),
  });
  const run = orch.startParallel({ goal: 'x' });
  for (let i = 0; i < 200 && store.steps(run.id).filter(s => s.role === 'execute').length < 2; i++) await new Promise(r => setTimeout(r, 10));
  orch.cancel(run.id);
  assert.equal((await finished(orch, run.id)).state, 'cancelled');
  await new Promise(r => setTimeout(r, 50));
  assert.ok(store.steps(run.id).filter(s => s.role === 'execute').every(s => s.state === 'cancelled'));
  assert.equal(orch.active.size, 0);
});

test('并行任务排队：同一时间只跑一条', async () => {
  let running = 0, peak = 0;
  const { orch } = setup({
    codex: (o, k) => (k === 'turn' ? turn('open', { plan: { ...PLAN, tasks: [PLAN.tasks[1]] } }) : pass),
    deepseek: async (o, k) => { if (k === 'turn') return turn('agree'); running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 30)); running--; return { text: '## 交付报告' }; },
  });
  const ids = [orch.startParallel({ goal: '1' }).id, orch.startParallel({ goal: '2' }).id];
  for (const id of ids) assert.equal((await finished(orch, id)).state, 'passed');
  assert.equal(peak, 1);
});

test('工作目录必须在允许范围内；发起方只能是 codex/deepseek', () => {
  const { orch } = setup({});
  assert.throws(() => orch.startParallel({ goal: 'x', cwd: os.tmpdir() }), /还没有访问这个文件夹的权限/);
  assert.throws(() => orch.startDiscuss({ question: 'x', initiator: 'claude' }), /发起方只能是/);
});

test('解析发言与评估', () => {
  assert.equal(parseTurn(turn('agree').text).stance, 'agree');
  assert.equal(parseTurn('没有 JSON').stance, 'disagree');
  assert.deepEqual(parseTurn(turn('open', { plan: PLAN }).text).plan.tasks.map(t => t.owner), ['codex', 'deepseek']);
  assert.equal(parseTurn(turn('open', { plan: { tasks: [{ owner: 'claude', title: 'x' }] } }).text).plan, null, 'Claude 不能领任务');
  assert.equal(parseVerdict(pass.text).verdict, 'pass');
  assert.deepEqual(parseVerdict(failV('codex').text).fixes.map(f => f.owner), ['codex']);
  assert.equal(parseVerdict('看起来不错').verdict, 'fail');
});

test('失败原因分类', () => {
  assert.deepEqual(classifyFailure('You have hit your usage limit'), { reason: '触发限额', down: true });
  assert.equal(classifyFailure('Claude 调用失败：密钥无效或与站点不匹配').down, true);
  assert.equal(classifyFailure('无法启动 Codex：spawn ENOENT').reason, '无法启动');
  assert.equal(classifyFailure('DeepSeek 没有返回任何答复').down, false);
});

test('继续执行：中断的并行任务沿用分工和原生会话，从中断那一轮接着做，不重新讨论', async () => {
  let execs = 0; const natives = [];
  const { orch, store } = setup({
    codex: (o, k) => (k === 'turn' ? turn('open', { plan: PLAN }) : k === 'evaluate' ? pass : (natives.push(o.nativeId || null), { text: '## 交付报告', nativeId: 'cx-1' })),
    deepseek: (o, k) => { if (k === 'turn') return turn('agree'); execs++; if (execs === 1) return new Promise((_, rej) => o.signal?.addEventListener('abort', () => { const e = new Error('已取消'); e.cancelled = true; rej(e); })); return { text: '## 交付报告' }; },
  });
  const id = orch.startParallel({ goal: 'x' }).id;
  for (let i = 0; i < 200 && !natives.length; i++) await new Promise(r => setTimeout(r, 10));
  orch.cancel(id);                                   // 模拟中断
  await new Promise(r => setTimeout(r, 30));
  for (let i = 0; i < 200 && orch.active.has(id); i++) await new Promise(r => setTimeout(r, 10));
  assert.throws(() => orch.resume('R999'));
  const discussBefore = store.steps(id).filter(s => s.role === 'discuss').length;
  orch.resume(id);
  const r = await finished(orch, id);
  assert.equal(r.state, 'passed');
  assert.equal(store.steps(id).filter(s => s.role === 'discuss').length, discussBefore, '不应重新讨论');
  assert.equal(natives.at(-1), 'cx-1', '应沿用原生会话');
  const last = store.steps(id).filter(s => s.role === 'execute').at(-1);
  assert.match(last.prompt, /任务曾中断/);
  assert.throws(() => orch.resume(id), /不需要继续/);
});
