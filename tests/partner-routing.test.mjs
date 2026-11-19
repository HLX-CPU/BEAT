import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { defaults, saveSettings, loadConfig } from '../src/config.mjs';
import { parsePlan } from '../src/prompts.mjs';

const ID = 'dock:glm-fixture';
const json = value => ({ text: '```json\n' + JSON.stringify(value) + '\n```' });
const turn = (stance, plan = null) => json({ stance, summary: stance, open_issues: [], plan });
const pass = json({ verdict: 'pass', summary: '满足', issues: [], fixes: [] });
const plan = { tasks: [{ owner: ID, type: 'desktop', title: '打开豆包', detail: '打开并确认前台，不发送聊天消息', files: [] }], acceptance: ['豆包在前台'], checks: [] };
// 原生搭档走自己的桌面端工具：desktop 角色的结果必须带 nativeToolEvidence（原生工具日志回执）。
const nativeReceipt = { source: 'fixture-native-tool-log',
  calls: [{ id: 'n1', tool: 'window_focus', status: 'completed', failed: false, record: { result: { calls: [{ tool: 'window_focus', status: 'verified', evidence: { sideEffects: 'focus', verification: { status: 'verified', checks: [{ pass: true }] } } }] } } }],
  verifiedActions: [{ tool: 'window_focus', nativeCallId: 'n1', evidence: { sideEffects: 'focus', verification: { status: 'verified', checks: [{ pass: true }] } } }],
  verification: { status: 'verified' } };
function setup(overrides = {}, additional = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-partners-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true,
    secrets: { token: 't', claudeApiKey: 'test', dockKeys: { [ID]: 'test', 'dock:later': 'test' } },
    dock: [{ id: ID, name: 'GLM 测试替身', enabled: true, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3', defaultEffort: 'high' }, ...additional] };
  config.codex.defaultModel = 'codex-fixture'; config.deepseek.defaultModel = 'deepseek-fixture';
  config.flow.discussionRetryDelays=[];
  config.flow.compactDiscussion=false; config.flow.pullQueue=false; // legacy consensus/seat routing coverage
  config.flow.skipFailedDiscussion=false;
  const seen = { native: [], think: [], desktop: [], advisor: [] };
  const agents = {
    codex: async opts => { seen.native.push(['codex', opts]); return opts.prompt.includes('对等讨论') ? turn(opts.prompt.includes('本轮共同提案') ? 'open' : 'agree', opts.prompt.includes('本轮共同提案') ? plan : null) : pass; },
    deepseek: async opts => { seen.native.push(['deepseek', opts]); return turn('agree'); },
    dock: async (id, opts) => { seen.think.push([id, opts]); return { ...turn('agree'), history: [] }; },
    desktopDock: async (id, opts) => { seen.desktop.push([id, opts]); opts.onProgress?.({ desktopTaskId: 'D-fixture', status: 'running', calls: [] }); return { text: '## 交付报告 豆包前台', status: 'succeeded', desktopTaskId: 'D-fixture', history: [], actualModel: 'glm-5.3', modelVerified: 'verified', modelEvidence: { response: 'fixture' } }; },
    claude: async opts => { seen.advisor.push(opts); return { text: '第二意见：先核对真实状态，未知输入不可重放', history: [] }; },
    ...overrides,
  };
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  return { config, store, seen, orch: new Orchestrator({ config, store, agents }) };
}
async function finish(orch, id) {
  for (let i = 0; i < 500; i++) { const run = orch.store.run(id); if (orch.isFinal(run.state) && !orch.active.has(id)) return run; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('fixture did not finish');
}

for(const automatic of [false,true])test(`四方讨论：GLM 超时和另一拓展坞 502 后只补两家（自动=${automatic}）`,async()=>{
  const counts=new Map(),histories=new Map();let broken=true;
  const {orch,store,config,seen}=setup({dock:async(id,o)=>{
    const n=(counts.get(id)||0)+1;counts.set(id,n);
    if(n===2&&broken){const e=Error(id===ID?'读取中断（整体超时）':'HTTP 502');e.noFallback=true;throw e;}
    if(n===3)assert.deepEqual(o.history,histories.get(id),'恢复沿用已有 API 历史');
    const r={...turn('agree'),history:[...(o.history||[]),{role:'user',content:o.prompt},{role:'assistant',content:turn('agree').text}]};
    histories.set(id,r.history);return r;
  }},[{id:'dock:later',name:'第二拓展坞',enabled:true,baseUrl:'https://example.test/v1',model:'fixture'}]);
  config.flow.discussionRetryDelays=automatic?[1,1,1]:[];
  const id=orch.startParallel({goal:'验证双 API 讨论中断'}).id;
  const failed=await finish(orch,id);
  if(automatic){
    assert.equal(failed.state,'passed');assert.equal(counts.get(ID),3);assert.equal(counts.get('dock:later'),3);
    assert.equal(store.steps(id).filter(s=>s.role==='discuss'&&['codex','deepseek'].includes(s.seat)).length,4);
    assert.ok(store.events(100).some(e=>e.text.includes('自动续接')));return;
  }
  assert.equal(failed.state,'error');assert.match(failed.error,/HTTP 502/);assert.match(failed.error,/整体超时/);
  assert.equal(seen.native.length,4);assert.equal(seen.desktop.length,0);
  broken=false;
  const restarted=new Orchestrator({config,store,agents:orch.agents});
  restarted.resume(id);
  assert.equal((await finish(restarted,id)).state,'passed');
  assert.equal(store.steps(id).filter(s=>s.role==='discuss'&&['codex','deepseek'].includes(s.seat)).length,4);
  assert.equal(counts.get(ID),3);assert.equal(counts.get('dock:later'),3);
});

test('ready 拓展坞共同讨论后经 desktopDock 执行，模型/推理强度/任务证据保留', async () => {
  const { orch, store, seen } = setup();
  const run = await finish(orch, orch.startParallel({ goal: '让 GLM 打开豆包' }).id);
  assert.equal(run.state, 'passed');
  assert.deepEqual(store.get('participant:' + run.id), ['codex', 'deepseek', ID]);
  assert.deepEqual(store.steps(run.id).filter(s => s.role === 'discuss').map(s => s.seat), ['codex', 'deepseek', ID, 'codex', 'deepseek', ID]);
  assert.equal(seen.desktop.length, 1); assert.equal(seen.think[0][1].effort, 'high'); assert.equal(seen.desktop[0][1].effort, 'high');
  assert.equal(seen.advisor.length, 0);
  const step = store.steps(run.id).find(s => s.role === 'execute');
  assert.equal(step.data.desktopTaskId, 'D-fixture'); assert.equal(step.model_verified, 'verified');
  assert.equal(store.run(run.id).natives[ID + ':exec:' + ID].desktopTaskId, 'D-fixture');
  assert.equal(orch.view(run.id).participants.length, 3);
});

test('失败方达到设置轮数后本任务跳过，其余搭档重新分配并执行；新任务仍包含该搭档',async()=>{
  let failures=0,skipTurns=0;
  const replacement={...plan,tasks:[{...plan.tasks[0],owner:'codex',type:'workspace'}]};
  const {orch,store,config}=setup({
    codex:async o=>o.prompt.includes('对等讨论')?(o.prompt.includes('以下失败搭档')?(++skipTurns===1?turn('open',replacement):turn('agree')):turn('agree',plan)):pass,
    dock:async()=>{failures++;const e=Error('HTTP 502');e.noFallback=true;throw e;},
  });
  config.flow.skipFailedDiscussion=true;config.flow.discussionSkipAfterRetries=2;config.flow.discussionRetryDelays=[1];
  const id=orch.startParallel({goal:'失败后重新分配工作'}).id;
  const r=await finish(orch,id);
  assert.equal(r.state,'passed');assert.equal(failures,3,'首次失败加两轮重试');
  assert.deepEqual(orch.participants(r),['codex','deepseek']);assert.equal(r.plan.tasks[0].owner,'codex');
  assert.equal(store.steps(id).filter(s=>s.role==='execute'&&s.seat===ID).length,0,'不派发给跳过方');
  assert.equal(orch.view(id).excludedParticipants.find(x=>x.agent===ID).status,'skipped');
  const newRun=store.createRun({kind:'discuss',goal:'新任务',cwd:r.cwd,initiator:'codex'});
  assert.ok(orch.participants(newRun).includes(ID),'仅本任务跳过，不全局停用');
});

test('全部搭档失败被跳过时真实报错，不空批准、不执行',async()=>{
  const fail=async()=>{const e=Error('HTTP 502');e.noFallback=true;throw e;};
  const {orch,config}=setup({codex:fail,deepseek:fail,dock:fail});
  config.flow.skipFailedDiscussion=true;config.flow.discussionSkipAfterRetries=0;
  const id=orch.startParallel({goal:'全部故障'}).id;
  const r=await finish(orch,id);
  assert.equal(r.state,'error');assert.match(r.error,/全部讨论搭档均失败/);assert.equal(r.plan,null);
  assert.equal(orch.store.steps(id).filter(s=>s.role==='execute').length,0);
});

test('重试轮数设置保存后可读回，非法值拒绝且不改原配置',()=>{
  const {config}=setup();config.configFile=path.join(config.root,'config.json');config.secretFile=path.join(config.root,'secrets.local.json');
  fs.writeFileSync(config.secretFile,JSON.stringify(config.secrets));
  saveSettings(config,{flow:{discussionSkipAfterRetries:5}});
  assert.equal(loadConfig(config.root).flow.discussionSkipAfterRetries,5);
  for(const value of [-1,21,1.5,'3'])assert.throws(()=>saveSettings(config,{flow:{discussionSkipAfterRetries:value}}),/整数/);
  assert.equal(loadConfig(config.root).flow.discussionSkipAfterRetries,5);
});

test('返工讨论失败方跳过后可共同批准新负责人，保留原验收要求',async()=>{
  let evaluations=0,skipTurns=0;
  const replacement={...plan,tasks:[{...plan.tasks[0],owner:'codex',type:'workspace'}]};
  const {orch,config,store}=setup({
    codex:async o=>{
      if(o.prompt.includes('对等讨论'))return o.prompt.includes('以下失败搭档')?(++skipTurns===1?turn('open',replacement):turn('agree')):turn('agree',plan);
      if(o.prompt.includes('现在评估第'))return ++evaluations===1?json({verdict:'fail',summary:'需要补充工作',issues:['补充验证'],fixes:plan.tasks}):pass;
      return {text:'## 交付报告 完成'};
    },
    dock:async(id,o)=>{if(o.prompt.includes('本轮是 BEAT 返工')){const e=Error('HTTP 502');e.noFallback=true;throw e;}return turn('agree');},
  });
  config.flow.skipFailedDiscussion=true;config.flow.discussionSkipAfterRetries=1;config.flow.discussionRetryDelays=[1];
  const r=await finish(orch,orch.startParallel({goal:'返工时自动跳过故障搭档'}).id);
  assert.equal(r.state,'passed');assert.equal(r.rounds,2);
  const approved=store.get('approvedWork:'+r.id+':2');assert.equal(approved.plan.tasks[0].owner,'codex');
  assert.deepEqual(approved.plan.acceptance,plan.acceptance);assert.deepEqual(approved.plan.checks,plan.checks);
});

test('一方修改计划会清空旧批准，所有搭档必须批准新 hash，单个 agree 不能结束', async () => {
  const revised = { ...plan, acceptance: ['豆包在前台', '不发送消息'] };
  let dockTurns = 0;
  const { orch, store } = setup({ dock: async () => ({ ...(++dockTurns === 1 ? turn('agree', revised) : turn('agree')), history: [] }) });
  const run = await finish(orch, orch.startParallel({ goal: '共同审批桌面计划' }).id);
  assert.equal(run.state, 'passed');
  const steps = store.steps(run.id).filter(s => s.role === 'discuss');
  assert.equal(steps.length, 6);
  assert.deepEqual(steps[2].data.approvedParticipants, []);
  assert.equal(steps[0].data.reviewedPlanHash,null);
  assert.equal(steps[5].data.reviewedPlanHash,steps[5].data.planHash);
  assert.deepEqual(steps[5].data.approvedParticipants.sort(), [ID, 'codex', 'deepseek'].sort());
});

test('新加入或未 ready 拓展坞不改变已冻结的参与名单', async () => {
  const { orch, config, store } = setup({}, [{ id: 'dock:empty', enabled: true, name: '未配置' }]);
  const run = orch.startParallel({ goal: '冻结参与方' });
  config.dock.push({ id: 'dock:later', enabled: true, baseUrl: 'https://example.invalid/v1', model: 'fixture', name: '后来加入' });
  const result = await finish(orch, run.id);
  assert.equal(result.state, 'passed');
  assert.deepEqual(store.get('participant:' + run.id), ['codex', 'deepseek', ID]);
  assert.ok(!store.steps(run.id).some(s => s.agent === 'dock:later'));
});

test('桌面失败即使评估误报 pass 仍判 fail，首轮请 Claude，证据进入顾问', async () => {
  const evidence = { status: 'unverified', desktopTaskId: 'D-unknown', calls: [{ evidence: { sideEffects: 'unknown' } }] };
  const { orch, store, seen } = setup({ desktopDock: async () => ({ ...evidence, text: '输入结果未知', history: [] }) });
  orch.config.flow.consultAfterFails=1;
  const run = await finish(orch, orch.startParallel({ goal: '失败需顾问', max_rounds: 1 }).id);
  assert.equal(run.state, 'failed'); assert.equal(seen.advisor.length, 1);
  assert.match(seen.advisor[0].prompt, /D-unknown/); assert.match(seen.advisor[0].prompt, /unknown/);
  const steps = store.steps(run.id);
  assert.equal(steps.find(s => s.role === 'execute').data.desktopTaskId, 'D-unknown');
  assert.equal(steps.find(s => s.role === 'consult').agent, 'claude');
  assert.ok(run.result.includes(steps.find(s => s.role === 'consult').output));
  assert.match(run.result, /已完成的顾问建议/);
});

test('resume 相同已成功桌面操作复用真实证据，不因恢复说明变化重放', async () => {
  const { orch, store, seen } = setup({ codex: async opts => opts.prompt.includes('对等讨论') ? turn(opts.prompt.includes('本轮共同提案') ? 'open' : 'agree', opts.prompt.includes('本轮共同提案') ? plan : null)
    : new Promise((_, reject) => opts.signal.addEventListener('abort', () => { const e = new Error('已取消'); e.cancelled = true; reject(e); }, { once: true })) });
  const id = orch.startParallel({ goal: '中断后恢复已有豆包操作' }).id;
  for (let i = 0; i < 200 && !store.steps(id).some(s => s.role === 'evaluate'); i++) await new Promise(r => setTimeout(r, 10));
  orch.cancel(id); await finish(orch, id);
  orch.agents.codex = async () => pass;
  orch.resume(id); const run = await finish(orch, id);
  assert.equal(run.state, 'passed'); assert.equal(seen.desktop.length, 1);
  assert.equal(store.steps(id).filter(s => s.role === 'execute').length, 2);
});

test('dock 可以领取仓库任务，Claude 不能领取任务；API搭档不能自行发起', () => {
  assert.deepEqual(parsePlan({ ...plan, tasks: [{ ...plan.tasks[0], type: 'workspace', files: ['src/code.mjs'] }] }).tasks[0].files,['src/code.mjs']);
  assert.equal(parsePlan({ ...plan, tasks: [...plan.tasks, { owner: 'claude', title: '改代码' }] }), null);
  const { orch } = setup();
  assert.throws(() => orch.startDiscuss({ question: 'x', source: ID }), /发起提问只能/);
  assert.throws(() => orch.startParallel({ goal: 'x', initiator: ID }), /发起方只能/);
});

test('各方可接替同类任务，Claude 只担任顾问', () => {
  const { orch } = setup();
  orch.roster.setPaused('deepseek', true);
  assert.deepEqual(new Set(orch.roster.candidates('deepseek', 'write')),new Set(['codex',ID]));
  assert.deepEqual(new Set(orch.roster.candidates('deepseek', 'desktop')),new Set(['codex',ID]));
  assert.ok(!orch.roster.candidates('deepseek', 'think').includes('claude'));
  assert.equal(orch.roster.candidates('advisor', 'think')[0], 'claude');
});

test('返工细节改变后必须重新全体批准；有反对意见时禁止第二轮桌面输入', async () => {
  let executions = 0;
  const { orch, store, seen } = setup({
    codex: async opts => opts.prompt.includes('对等讨论') ? turn(opts.prompt.includes('本轮共同提案') ? 'open' : 'agree', opts.prompt.includes('本轮共同提案') ? plan : null)
      : json({ verdict: 'fail', summary: '窗口未在前台', issues: ['须恢复焦点'], fixes: [{ owner: ID, type: 'desktop', title: '恢复豆包', detail: '仅恢复已存在窗口，不重新启动' }] }),
    dock: async (_id, opts) => ({ ...(opts.prompt.includes('BEAT 返工任务') ? json({ stance: 'disagree', summary: '需用户核对', open_issues: ['状态不清楚'], plan: null }) : turn('agree')), history: [] }),
    desktopDock: async () => { executions++; return { text: '豆包已启动', status: 'succeeded', desktopTaskId: 'D-started', history: [] }; },
  });
  orch.config.flow.consultAfterFails=1;
  const run = await finish(orch, orch.startParallel({ goal: '返工也要共同批准', max_rounds: 2, max_turns: 6 }).id);
  assert.equal(run.state, 'failed'); assert.equal(executions, 1);
  assert.equal(seen.advisor.length, 1);
  assert.ok(store.steps(run.id).some(s => s.role === 'discuss' && s.prompt.includes('BEAT 返工任务')));
  assert.match(run.result, /返工方案未获全体搭档认可/);
});

test('GLM 空答后 Codex 代答不计 GLM 本人批准，不派发任何桌面任务', async () => {
  const { orch, store, seen } = setup({ dock: async () => { const e = new Error('GLM 返回空答'); e.apiResponseEvidence = { finishReason: 'length', toolCalls: 0, textLength: 0 }; throw e; } });
  const run = await finish(orch, orch.startParallel({ goal: 'GLM 本人必须审核打开豆包', max_turns: 3 }).id);
  assert.equal(run.state, 'failed'); assert.equal(seen.desktop.length, 0);
  assert.deepEqual(store.get('participant:' + run.id), ['codex', 'deepseek', ID], '中途失败不能偷偷删除 GLM');
  const substitutes = store.steps(run.id).filter(s => s.seat === ID);
  assert.ok(substitutes.length > 0 && substitutes.every(s => ['codex','deepseek'].includes(s.agent) && s.data.ownVote === false));
  assert.ok(substitutes.every(s => !s.data.approvedParticipants.includes(ID)));
  assert.equal(substitutes[0].data.apiResponseFailures[0].apiResponseEvidence.finishReason, 'length');
  assert.ok(!store.steps(run.id).some(s => s.role === 'execute'));
});

test('精简固定搭档空答保留原错误类型、实际用量和失败请求，不伪装为零费用或静默换人',async()=>{
 const {orch,store,config,seen}=setup({dock:async()=>{
  const e=new Error('接口返回空答');Object.assign(e,{code:'EMPTY_API_RESPONSE',nonRetryable:true,requestedModel:'glm-5.3',actualModel:'glm-5.3',usage:{prompt_tokens:500,completion_tokens:1,total_tokens:501},apiResponseEvidence:{model:'glm-5.3',finishReason:'stop',contentLength:0}});throw e;
 }});
 const run=store.createRun({kind:'discuss',goal:'固定搭档短评审',cwd:config.workspace,initiator:'codex'});store.updateRun(run.id,{state:'running'});
 await assert.rejects(orch.controlCall(run,{role:'discuss',seat:ID,call:'think',onlyAgent:true,signal:new AbortController().signal,sessions:{},build:()=> '只评审同一计划，不执行任务'},{phase:'discussion',maxOutputTokens:900}),e=>e.code==='EMPTY_API_RESPONSE'&&e.nonRetryable===true&&e.usage.total_tokens===501);
 const audit=store.get('controlMetrics:'+run.id);
 assert.equal(audit.phases.discussion.measuredTokens,501);assert.equal(audit.phases.discussion.estimatedTokens,0);assert.equal(audit.phases.discussion.unknownCalls,0);
 assert.equal(store.steps(run.id)[0].prompt,'只评审同一计划，不执行任务');
 assert.equal(store.steps(run.id)[0].state,'failed');assert.equal(seen.native.length,0);
});

test('初始暂停成员被明确记录并排除审批；没有 online 原生搭档不能由 dock 发起', () => {
  const { orch, store } = setup();
  orch.roster.setPaused('deepseek', true);
  const run = store.createRun({ kind: 'parallel', goal: '检查冻结名单', cwd: orch.config.workspace, initiator: 'codex', max_turns: 3, max_rounds: 1 });
  assert.deepEqual(orch.participants(run), ['codex', ID]);
  assert.equal(store.get('participantExcluded:' + run.id)[0].reason, '初始手动暂停');
  orch.roster.setPaused('codex', true);
  assert.throws(() => orch.startParallel({ goal: 'dock 不得独立发起' }), /至少需要一位在线/);
});

for (const mixed of [false, true]) {
 test(`原生${mixed?'混合':'desktop'}任务用自己的桌面端工具执行，不按身份拒绝`,async()=>{
  const nativePlan={...plan,tasks:[{owner:'codex',type:'desktop',title:'操作',detail:'操作',files:[]},...(mixed?[{owner:'codex',type:'workspace',title:'写文件',detail:'写文件',files:['fixture.mjs']}]:[])]};
  const {orch,store,seen}=setup({codex:async opts=>opts.prompt.includes('对等讨论')?turn(opts.prompt.includes('本轮共同提案')?'open':'agree',opts.prompt.includes('本轮共同提案')?nativePlan:null):opts.prompt.includes('现在评估第')?pass:{text:'## 交付报告 完成',nativeToolEvidence:nativeReceipt}});
  const run=await finish(orch,orch.startParallel({goal:'平等执行'}).id);assert.equal(run.state,'passed');
  const exec=store.steps(run.id).find(s=>s.role==='execute');assert.equal(exec.agent,'codex');
  assert.match(exec.prompt,/使用自己桌面端的原生工具/);
  assert.doesNotMatch(exec.prompt,/contextId:/,'原生搭档不拿电脑助手的 contextId 绑定');
  assert.equal(seen.desktop.length,0,'BEAT 电脑助手只给拓展坞用');
 });
}

test('原生 workspace 与拓展坞 desktop 仍可并行，桌面动作只派给统一助手', async () => {
  let active = 0, peak = 0;
  const together = async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 25)); active--; };
  const combined = { ...plan, tasks: [{ owner: 'codex', type: 'workspace', title: '后台仓库工作', detail: '后台文件检查，不进行键鼠输入', files: ['fixture.mjs'] }, ...plan.tasks] };
  const { orch, store, seen } = setup({
    codex: async opts => opts.prompt.includes('对等讨论') ? turn(opts.prompt.includes('本轮共同提案') ? 'open' : 'agree', opts.prompt.includes('本轮共同提案') ? combined : null)
      : opts.prompt.includes('现在评估第') ? pass : (await together(), { text: '## 交付报告 仓库工作完成' }),
    desktopDock: async (_id, opts) => { seen.desktop.push([_id, opts]); await together(); return { status: 'succeeded', text: '豆包前台已核验', desktopTaskId: 'D-parallel', history: [] }; },
  });
  const run = await finish(orch, orch.startParallel({ goal: '仓库与受限电脑操作分别执行' }).id);
  assert.equal(run.state, 'passed'); assert.equal(peak, 2);
  assert.deepEqual(store.steps(run.id).filter(s => s.role === 'execute').map(s => s.agent), ['codex', ID]);
  assert.equal(seen.desktop.length, 1);
});

test('三方同轮发言、同轮执行：原生电脑与 dock 仓库任务没有资格或顺序差异',async()=>{
 let thinking=0,thinkPeak=0,executing=0,execPeak=0;
 const pause=()=>new Promise(r=>setTimeout(r,25));
 const unified={...plan,tasks:[{owner:'codex',type:'desktop',title:'电脑动作',detail:'通过统一管线核验',files:[]},{owner:'deepseek',type:'workspace',title:'文件A',detail:'文件A',files:['a.mjs']},{owner:ID,type:'workspace',title:'文件B',detail:'文件B',files:['b.mjs']}]};
 const discuss=async proposal=>{thinking++;thinkPeak=Math.max(thinkPeak,thinking);await pause();thinking--;return turn(proposal?'open':'agree',proposal?unified:null);};
 const execute=async()=>{executing++;execPeak=Math.max(execPeak,executing);await pause();executing--;return {text:'## 交付报告 完成',nativeToolEvidence:nativeReceipt};};
 const {orch,store}=setup({codex:async opts=>opts.prompt.includes('对等讨论')?discuss(opts.prompt.includes('本轮共同提案')):opts.prompt.includes('现在评估第')?pass:execute(),deepseek:async opts=>opts.prompt.includes('对等讨论')?discuss(false):execute(),dock:async()=>({...await discuss(false),history:[]}),desktopDock:async(_id,opts)=>{assert.equal(opts.executionScope,'workspace');assert.equal(opts.parallelPartner,true);return {...await execute(),status:'succeeded',desktopTaskId:'D-workspace',history:[]};}});
 const run=await finish(orch,orch.startParallel({goal:'三方平等执行'}).id);assert.equal(run.state,'passed');assert.equal(thinkPeak,3);assert.equal(execPeak,3);
 const steps=store.steps(run.id).filter(s=>s.role==='discuss');
 assert.ok(steps.slice(0,3).every(s=>s.prompt.includes('（尚无）')),'同轮不能读取早返回者的意见');
 assert.equal(new Set(steps.slice(3,6).map(s=>s.data.reviewedPlanHash)).size,1);
 assert.deepEqual(new Set(store.steps(run.id).filter(s=>s.role==='execute').map(s=>s.agent)),new Set(['codex','deepseek',ID]));
});

test('第二轮一方改动会撤销全体旧批准，必须第三轮审议同一新版本',async()=>{
 let rounds=0;const revised={...plan,acceptance:['前台已确认','没有重复启动']};
 const {orch,store}=setup({dock:async()=>({...turn(++rounds===2?'disagree':'agree',rounds===2?revised:null),history:[]})});
 const run=await finish(orch,orch.startParallel({goal:'新版本重新审批'}).id);assert.equal(run.state,'passed');
 const steps=store.steps(run.id).filter(s=>s.role==='discuss');assert.equal(steps.length,9);
 assert.ok(steps.slice(3,6).every(s=>s.data.approvedParticipants.length===0));
 assert.ok(steps.slice(6).every(s=>s.data.planVersion===2&&s.data.reviewedPlanHash===s.data.planHash&&s.data.approvedParticipants.length===3));
});
