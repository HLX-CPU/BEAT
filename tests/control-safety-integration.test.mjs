import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { TaskQueue } from '../src/task-queue.mjs';
import { ControlBudget } from '../src/control-budget.mjs';
import { runQueuedTasks } from '../src/queue-runner.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

function fixture(t, handler, flow = {}) {
  const parent=artifactsRoot();fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'control-safety-'));
  const config={...defaults(root),root,dataDir:path.join(root,'data'),secrets:{token:'fixture-token'},flow:{...defaults(root).flow,...flow}};
  fs.mkdirSync(config.workspace,{recursive:true});config.codex.defaultModel='fixture-codex';config.deepseek.defaultModel='fixture-deepseek';
  const store=new Store(path.join(config.dataDir,'beat.sqlite')),calls=[];
  const agents=Object.fromEntries(['codex','deepseek'].map(seat=>[seat,async opts=>{
    calls.push({seat,role:opts.role,access:opts.access,nativeId:opts.nativeId||null,prompt:opts.prompt});
    opts.onNative?.(opts.nativeId||'native-fixture-'+seat);
    const answer=await handler({seat,opts,store,config,calls});
    return {text:'ok',nativeId:opts.nativeId||'native-fixture-'+seat,usage:{totalTokens:120,source:'fixture'},...answer};
  }]));
  const orch=new Orchestrator({config,store,agents});
  const run=store.createRun({kind:'parallel',goal:'用真实文件证据核验安全控制',cwd:config.workspace,initiator:'codex',max_rounds:3,max_turns:6});
  const sessions={};
  t.after(()=>store.close());
  const evidence=(name,data)=>{const file=path.join(root,name+'.json');fs.writeFileSync(file,JSON.stringify({evidenceType:'dummy-provider-real-controller-sqlite',realProviderValidated:false,...data},null,2));return file;};
  return {config,store,orch,run,sessions,calls,root,agents,evidence};
}
const options=(f,extra={})=>({role:'discuss',seat:'codex',slot:'codex:safety',call:'think',signal:new AbortController().signal,sessions:f.sessions,build:()=> '返回简短结果',...extra});
const plan=()=>({tasks:[{id:'A',owner:'codex',type:'workspace',title:'结果文件',detail:'创建out.txt',files:['out.txt'],acceptance:['文件内容正确'],difficulty:'hard',tokenBudget:5000}],acceptance:['文件内容正确'],checks:[]});

test('controller gives discussion/reviewer read-only access and execution full access (客户指定默认管理员权限), retaining one native conversation',async t=>{
  const f=fixture(t,async()=>({}));
  await f.orch.controlCall(f.run,options(f),{phase:'discussion',maxOutputTokens:500});
  await f.orch.controlCall(f.run,options(f,{role:'execute',call:'write'}),{phase:'execution',taskId:'A',budget:2000,maxOutputTokens:500});
  await f.orch.controlCall(f.run,options(f,{role:'evaluate'}),{phase:'execution',taskId:'A',budget:2000,maxOutputTokens:500});
  assert.deepEqual(f.calls.map(c=>c.access),['read-only','danger-full-access','read-only']);
  assert.equal(f.calls[1].nativeId,'native-fixture-codex');assert.equal(f.calls[2].nativeId,'native-fixture-codex');
  const metrics=f.store.get('controlMetrics:'+f.run.id);assert.equal(metrics.phases.discussion.calls,1);assert.equal(metrics.phases.execution.calls,2);assert.equal(metrics.tasks.A.usedTokens,240);
  t.diagnostic('scope evidence: '+f.evidence('access',{calls:f.calls,metrics}));
});

test('live provider usage event aborts an over-budget native task, separately records measured evidence and never falls back',async t=>{
  let sawAbort=false;
  const f=fixture(t,async({opts})=>{
    opts.onUsage?.({totalTokens:700,source:'fixture-live-event'});sawAbort=opts.signal.aborted;
    const error=new Error('native stops after actual usage event');error.cancelled=opts.signal.aborted;throw error;
  },{tokenBudgetEnforced:true,taskTokenBudget:500,executionTokenBudget:2000});
  await assert.rejects(()=>f.orch.controlCall(f.run,options(f,{role:'execute',call:'write'}),{phase:'execution',taskId:'A',budget:500,maxOutputTokens:200}),e=>e.code==='CONTROL_BUDGET_EXCEEDED');
  assert.equal(sawAbort,true);assert.equal(f.calls.length,1);
  const metrics=f.store.get('controlMetrics:'+f.run.id);assert.equal(metrics.tasks.A.measuredTokens,700);assert.equal(metrics.phases.execution.unknownCalls,0);assert.deepEqual(metrics.reservations,{});
  const steps=f.store.steps(f.run.id);assert.equal(steps.length,1);assert.ok(['failed','cancelled'].includes(steps[0].state));
  t.diagnostic('live-usage evidence: '+f.evidence('usage-abort',{calls:f.calls,metrics,stepState:steps[0].state}));
});

const desktopReceipt = (over = {}) => ({
  source: 'fixture-native-tool-log',
  calls: [{ id: 'n1', tool: 'window_focus', status: 'completed', failed: false, record: { result: { calls: [{ tool: 'window_focus', status: 'verified', evidence: { sideEffects: 'focus', verification: { status: 'verified', checks: [{ pass: true }] } } }] } } }],
  verifiedActions: [{ tool: 'window_focus', nativeCallId: 'n1', evidence: { sideEffects: 'focus', verification: { status: 'verified', checks: [{ pass: true }] } } }],
  verification: { status: 'verified' }, ...over,
});

test('未核验的原生电脑动作保留未知副作用证据并禁止继续；已核验的完成仍按预算拒绝并保留桌面证据',async t=>{
  // (1) 原生电脑动作返回但没有可核验回执：保留 unknown 副作用证据、标记不可换人/不重放。
  const unverified=fixture(t,async()=>({usage:{totalTokens:700},nativeToolEvidence:{source:'fixture-native-tool-log',calls:[{id:'n1',tool:'window_focus',status:'completed',failed:false}],verification:{status:'unverified'}}}),{tokenBudgetEnforced:true,taskTokenBudget:500,executionTokenBudget:2000});
  await assert.rejects(()=>unverified.orch.controlCall(unverified.run,options(unverified,{role:'execute',call:'desktop',executionKey:'desktop-input-nonce'}),{phase:'execution',taskId:'A',budget:500,maxOutputTokens:200}),e=>{
    assert.equal(e.noFallback,true);assert.equal(e.desktopEvidence?.sideEffects,'unknown');assert.match(e.message,/尚未独立核验/);return true;
  });
  assert.equal(unverified.calls.length,1);
  // (2) 已核验回执 + 实际用量超过预算：仍然按预算停止，并把桌面证据带在错误上。
  const verified=fixture(t,async()=>({usage:{totalTokens:700},nativeToolEvidence:desktopReceipt()}),{tokenBudgetEnforced:true,taskTokenBudget:500,executionTokenBudget:2000});
  await assert.rejects(()=>verified.orch.controlCall(verified.run,options(verified,{role:'execute',call:'desktop',executionKey:'desktop-over-budget'}),{phase:'execution',taskId:'A',budget:500,maxOutputTokens:200}),e=>{
    assert.equal(e.code,'CONTROL_BUDGET_EXCEEDED');assert.equal(e.desktopEvidence?.verification?.status,'verified');return true;
  });
  assert.equal(verified.calls.length,1);
});

test('restarted controller resumes verifying task by reviewing its existing report; passed queue does not execute again',async t=>{
  const f=fixture(t,async({opts})=>{
    assert.equal(opts.access,'read-only','restart must only verify');assert.match(opts.prompt,/只读核验一个小任务/);
    assert.equal(fs.readFileSync(path.join(opts.cwd,'out.txt'),'utf8'),'done');return {text:'{"pass":true,"issues":[]}'};
  });
  const file=path.join(f.run.cwd,'out.txt');fs.writeFileSync(file,'done');
  const q=new TaskQueue({store:f.store,runId:f.run.id,cwd:f.run.cwd,workers:['codex','deepseek'],strongAgent:'codex'});q.enqueue(plan().tasks);
  const a=q.claim('codex');q.complete('A',a.leaseToken,{executor:'codex',summary:'done',artifacts:[{path:file,summary:'done'}]});
  const result=await runQueuedTasks(f.orch,f.run,plan(),new AbortController().signal,f.sessions);assert.equal(result.verdict.verdict,'pass');assert.equal(f.calls.length,1);assert.equal(f.calls[0].seat,'deepseek');
  const restarted=new Orchestrator({config:f.config,store:f.store,agents:f.agents});
  const repeated=await runQueuedTasks(restarted,f.run,plan(),new AbortController().signal,f.store.run(f.run.id).natives||{});
  assert.equal(repeated.verdict.verdict,'pass');assert.equal(f.calls.length,1);assert.equal(q.get('A').attempts,1);
  t.diagnostic('restart evidence: '+f.evidence('resume-verification',{calls:f.calls,queue:q.list()}));
});

test('cancellation aborts current native execution and retains queued task, partial file and action evidence',async t=>{
  const ac=new AbortController();let started;
  const began=new Promise(resolve=>{started=resolve;});
  const f=fixture(t,async({opts})=>{
    assert.equal(opts.access,'danger-full-access');fs.writeFileSync(path.join(opts.cwd,'out.txt'),'partial');opts.onProgress?.({event:'file-write',pid:process.pid});started();
    await new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{cancelled:true})),{once:true}));
    return {text:'unreachable'};
  });
  const running=runQueuedTasks(f.orch,f.run,plan(),ac.signal,f.sessions);await began;ac.abort(Error('fixture user cancel'));
  await assert.rejects(()=>running,e=>e.cancelled===true);assert.equal(fs.readFileSync(path.join(f.run.cwd,'out.txt'),'utf8'),'partial');
  const queue=f.store.get('taskQueue:'+f.run.id);assert.equal(queue.length,1);assert.equal(queue[0].cancelled,true);assert.equal(queue[0].state,'blocked');assert.equal(queue[0].attempts,1);assert.equal(f.calls.length,1);
  t.diagnostic('cancel evidence: '+f.evidence('cancel',{queue,calls:f.calls,partialFile:path.join(f.run.cwd,'out.txt')}));
});

test('controller recovers dead-owner pending token reservation conservatively before admitting a new call',async t=>{
  const f=fixture(t,async()=>({}));const child=spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'}),pid=child.pid;
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  const ledger=new ControlBudget(f.store,f.run,f.config.flow),reserved=ledger.reserve({phase:'execution',taskId:'old',inputTokens:100,maxOutputTokens:500});
  const state=ledger.state();state.reservations[reserved.id].pid=pid;ledger.save(state);
  await f.orch.controlCall(f.run,options(f),{phase:'execution',taskId:'new',maxOutputTokens:500,budget:2000});
  const final=ledger.state();assert.equal(final.reservations[reserved.id],undefined);assert.equal(final.tasks.old.estimatedTokens,600);assert.equal(final.phases.execution.unknownCalls,1);assert.equal(final.tasks.new.measuredTokens,120);
});

test('same desktop execution nonce reuses verified result without charging provider usage twice',async t=>{
  const f=fixture(t,async()=>({nativeToolEvidence:desktopReceipt(),usage:{totalTokens:120,source:'fixture'}}));
  const opts=options(f,{role:'execute',call:'desktop',executionKey:'same-input-nonce'}),limits={phase:'execution',taskId:'A',budget:3000,maxOutputTokens:500};
  await f.orch.controlCall(f.run,opts,limits);await f.orch.controlCall(f.run,opts,limits);
  assert.equal(f.calls.length,1,'same native input must not be dispatched again');
  const metrics=f.store.get('controlMetrics:'+f.run.id);assert.equal(metrics.tasks.A.measuredTokens,120,'cached provider usage is past evidence, not a new charge');
  assert.equal(metrics.phases.execution.calls,1);assert.equal(metrics.phases.execution.reusedCalls,1);assert.equal(metrics.phases.execution.estimatedTokens,0);
});
