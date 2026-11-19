import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { ControlBudget, normalizeUsage, usageSummary } from '../src/control-budget.mjs';
import { createDeepseekParser } from '../src/deepseek.mjs';

const setup=()=>{const store=new Store(':memory:');return {store,ledger:new ControlBudget(store,{id:'R1'},{tokenBudgetEnforced:true,discussionTokenBudget:4000,executionTokenBudget:6000,taskTokenBudget:2000})};};
test('execution reservations distinguish temporary busy admission from actual exhausted budgets',()=>{
 const store=new Store(':memory:');
 try {
  const ledger=new ControlBudget(store,{id:'busy-budget'},{tokenBudgetEnforced:true,executionTokenBudget:3000,taskTokenBudget:1000});
  const held=['a','b','c'].map(taskId=>ledger.reserve({phase:'execution',taskId,inputTokens:0,maxOutputTokens:1000}));
  assert.throws(()=>ledger.reserve({phase:'execution',taskId:'d',inputTokens:0,maxOutputTokens:1000}),error=>error.code==='CONTROL_BUDGET_BUSY'&&error.notDispatched===true);
  assert.equal(Object.keys(ledger.state().reservations).length,3,'rejected admission creates no phantom call');
  ledger.finish(held[0].id,{usage:{totalTokens:50,inputTokens:25,outputTokens:25}});
  const next=ledger.reserve({phase:'execution',taskId:'d',inputTokens:0,maxOutputTokens:1000});
  assert.equal(next.tokens,950,'release admits waiting work using only available concurrent budget');
  ledger.finish(next.id,{usage:{totalTokens:950,inputTokens:475,outputTokens:475}});
  assert.throws(()=>ledger.reserve({phase:'execution',taskId:'d',inputTokens:0,maxOutputTokens:128}),error=>error.code==='CONTROL_BUDGET_EXCEEDED'&&!error.notDispatched,'real task exhaustion is terminal even with other reservations');
 }finally{store.close();}
});
test('concurrent reservations cannot overspend the shared discussion budget; adjudication retains a reserve',()=>{
 const {store,ledger}=setup();
 const a=ledger.reserve({inputTokens:900,maxOutputTokens:900});
 const b=ledger.reserve({inputTokens:700,maxOutputTokens:900});
 assert.equal(a.tokens+b.tokens,2800);
 assert.throws(()=>ledger.reserve({inputTokens:100,maxOutputTokens:200}),{code:'CONTROL_BUDGET_EXCEEDED'});
 assert.equal(ledger.reserve({adjudication:true,inputTokens:200,maxOutputTokens:900}).tokens,1100);store.close();
});
test('real provider usage, estimates, interrupted calls and per-task limits remain separately auditable',()=>{
 const {store,ledger}=setup();
 const a=ledger.reserve({phase:'execution',taskId:'one',inputTokens:300,maxOutputTokens:800});
 ledger.finish(a.id,{usage:{prompt_tokens:200,completion_tokens:100,total_tokens:300},text:'done'});
 const b=ledger.reserve({phase:'execution',taskId:'one',inputTokens:400,maxOutputTokens:800});
 ledger.finish(b.id,{error:new Error('network')});
 const state=ledger.state();
 assert.equal(state.phases.execution.measuredTokens,300);assert.equal(state.phases.execution.estimatedTokens,1200);
 assert.equal(state.phases.execution.unknownCalls,1);assert.equal(state.tasks.one.usedTokens,1500);
 assert.throws(()=>ledger.reserve({phase:'execution',taskId:'one',inputTokens:490,maxOutputTokens:100}),{code:'CONTROL_BUDGET_EXCEEDED'});store.close();
});
test('estimated tool-loop costs are included without claiming they are provider measurement',()=>{
 const {store,ledger}=setup(),r=ledger.reserve({inputTokens:100,maxOutputTokens:900});
 ledger.finish(r.id,{usage:{totalTokens:800,estimated:true},text:'done',budgetSpentTokens:800});
 assert.equal(ledger.state().phases.discussion.measuredTokens,0);assert.equal(ledger.state().phases.discussion.estimatedTokens,800);
 assert.equal(normalizeUsage({totalTokens:10,verified:false}),null);store.close();
});
test('resume retains billed usage; live-process reservations are not silently recycled',()=>{
 const {store,ledger}=setup(),r=ledger.reserve({inputTokens:100,maxOutputTokens:500});
 ledger.finish(r.id,{usage:{inputTokens:100,outputTokens:100,totalTokens:200}});
 const live=ledger.reserve({inputTokens:100,maxOutputTokens:500});
 const resumed=new ControlBudget(store,{id:'R1'},{discussionTokenBudget:4000});resumed.recover();
 assert.equal(resumed.state().phases.discussion.usedTokens,200);assert.ok(resumed.state().reservations[live.id]);store.close();
});
test('DeepSeek 多步用量只把新增输入+输出计入计量，缓存读入单列，不再把缓存当费用',()=>{
 const parser=createDeepseekParser();
 const event=step=>JSON.stringify({type:'status',phase:'step_end',turn:1,step,usage:{inputTokens:10,outputTokens:20,cacheReadTokens:100,totalTokens:130}});
 parser.push(event(1));parser.push(event(1));parser.push(event(2));
 const usage=parser.result().usage;
 assert.equal(usage.totalTokens,60);assert.equal(usage.inputTokens,20);assert.equal(usage.outputTokens,40);
 assert.equal(usage.cacheReadTokens,200);assert.equal(usage.providerTotalTokens,260);
 parser.push(JSON.stringify({type:'final',text:'ok'}));assert.equal(parser.result().text,'ok');
});

test('closing reserve protects native-context adjudication after normal pool is exhausted',()=>{
 const store=new Store(':memory:');
 try {
  const ledger=new ControlBudget(store,{id:'closing-fixture'},{tokenBudgetEnforced:true,discussionTokenBudget:100000,closingReserveTokens:45000});
  // 55k normal pool is smaller than the usual 70k cap; the remaining 45k
  // must still accommodate a real native prefix when a dispute needs closure.
  const first=ledger.reserve({inputTokens:21000,maxOutputTokens:4000,seat:'codex'});
  const second=ledger.reserve({inputTokens:21000,maxOutputTokens:4000,seat:'deepseek'});
  const third=ledger.reserve({inputTokens:4000,maxOutputTokens:1000,seat:'dock:fixture'});
  assert.equal(first.tokens+second.tokens+third.tokens,55000);
  assert.throws(()=>ledger.reserve({inputTokens:1,maxOutputTokens:128}),{code:'CONTROL_BUDGET_EXCEEDED'});
  ledger.finish(first.id,{usage:{inputTokens:21000,outputTokens:4000,totalTokens:25000}});
  ledger.finish(second.id,{usage:{inputTokens:21000,outputTokens:4000,totalTokens:25000}});
  ledger.finish(third.id,{usage:{inputTokens:4000,outputTokens:1000,totalTokens:5000}});
  assert.throws(()=>ledger.reserve({inputTokens:1,maxOutputTokens:128}),{code:'CONTROL_BUDGET_EXCEEDED'});
  const closure=ledger.reserve({adjudication:true,inputTokens:24576,maxOutputTokens:4000,seat:'codex'});
  assert.equal(closure.tokens,28576);
  assert.ok(ledger.state().phases.discussion.usedTokens+closure.tokens<=100000);
  assert.throws(()=>ledger.reserve({adjudication:true,inputTokens:16500,maxOutputTokens:128}),{code:'CONTROL_BUDGET_EXCEEDED'});
 } finally {store.close();}
});

test('explicit opt-out: budgets are display-only and every call stays in the per-task total',()=>{
 const store=new Store(':memory:');
 try {
  const ledger=new ControlBudget(store,{id:'display-only'},{tokenBudgetEnforced:false,discussionTokenBudget:1000,executionTokenBudget:1000,taskTokenBudget:500});
  for(let i=0;i<3;i++){const r=ledger.reserve({phase:'execution',taskId:'t1',inputTokens:900,maxOutputTokens:900,seat:'codex'});ledger.finish(r.id,{usage:{inputTokens:900,outputTokens:600,totalTokens:1500}});}
  const d=ledger.reserve({inputTokens:5000,maxOutputTokens:900,seat:'deepseek'});ledger.finish(d.id,{text:'估算'});
  assert.equal(ledger.remaining(d),Infinity);
  const s=ledger.state();assert.equal(s.tasks.t1.usedTokens,4500);assert.equal(s.phases.execution.usedTokens,4500);
  const sum=usageSummary(s);
  assert.equal(sum.measuredTokens,4500);assert.ok(sum.estimatedTokens>=5000);assert.equal(sum.totalTokens,sum.measuredTokens+sum.estimatedTokens);
  assert.equal(sum.calls,4);assert.equal(sum.byAgent.codex,4500);assert.equal(sum.byPhase.execution,4500);
 } finally {store.close();}
});

// R363 实测：讨论阶段已用 148,253 / 预算 512,000（还剩 35 万），却连续 4 轮报“预算已到上限”，
// 因为每次调用都只预留 4,639、实际 7,471~9,200；客户照提示加大预算改的是阶段/任务预算，对这条判定无效。
test('单次调用超出预留时先用剩余额度补足预留；补不上才停止，不虚增台账',()=>{
 const store=new Store(':memory:');
 try{
  const ledger=new ControlBudget(store,{id:'extend-fixture'},{tokenBudgetEnforced:true,discussionTokenBudget:100000,closingReserveTokens:30000});
  const r=ledger.reserve({inputTokens:2000,maxOutputTokens:900,seat:'dock:fixture'});
  assert.equal(r.tokens,2900);
  assert.equal(ledger.extend(r.id,9000),true,'阶段还有余量时必须补足预留而不是中止调用');
  assert.equal(ledger.state().reservations[r.id].tokens,9000);
  ledger.finish(r.id,{usage:{inputTokens:8000,outputTokens:1000,totalTokens:9000}});
  assert.equal(ledger.state().phases.discussion.usedTokens,9000);
  const big=ledger.reserve({inputTokens:60000,maxOutputTokens:900,seat:'dock:fixture'});
  assert.equal(ledger.extend(big.id,200000),false,'余量不足时不得虚增预留');
  assert.equal(ledger.state().reservations[big.id].tokens,60900);
 } finally {store.close();}
});

test('预留失败不刷新阶段预算：台账不再出现“预算 512,000”与“预算已到上限”并存',()=>{
 const store=new Store(':memory:');
 try{
  const first=new ControlBudget(store,{id:'polluted'},{tokenBudgetEnforced:true,discussionTokenBudget:4000});
  first.reserve({inputTokens:500,maxOutputTokens:200});
  const raised=new ControlBudget(store,{id:'polluted'},{tokenBudgetEnforced:true,discussionTokenBudget:8000,closingReserveTokens:7900});
  assert.throws(()=>raised.reserve({inputTokens:500,maxOutputTokens:200}),error=>error.code==='CONTROL_BUDGET_EXCEEDED');
  assert.equal(raised.state().phases.discussion.budget,4000,'失败的预留不能把预算数字改成 8,000');
  assert.equal(raised.state().records.length,0);
 } finally {store.close();}
});
