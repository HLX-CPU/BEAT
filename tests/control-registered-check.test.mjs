import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DesktopAssistant, resetLeaseForTests, leaseStatus } from '../workspaces/shared/desktop-assistant/core/assistant.mjs';
import { HumanConfirmationChannel } from '../workspaces/shared/desktop-assistant/core/human-confirm.mjs';
import { runBounded } from '../workspaces/shared/desktop-assistant/core/exec.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

function fixture() {
  resetLeaseForTests();
  const base=artifactsRoot();fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'registered-check-')),cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd,'package-lock.json'),'{}');
  const human=new HumanConfirmationChannel({generate:()=> '654321',notify:()=>({delivery:'test'})});
  const a=new DesktopAssistant({config:{workspace:cwd,allowedRoots:[cwd],dock:[]},dataDir:path.join(root,'data'),userFolders:{},humanChannel:human,chat:async()=>{throw Error('automatic check must not call any model');},bridgeFactory:()=>{throw Error('automatic check must not operate desktop');}});
  return {a,cwd,root};
}
const waitPending=async a=>{for(let i=0;i<100;i++){const t=[...a.tasks.values()].find(t=>t.status==='waiting_confirmation');if(t)return t;await new Promise(r=>setTimeout(r,5));}throw Error('no confirmation task');};
async function approve(a,t){const p=t.pendingConfirmation;const args={taskId:t.taskId,callId:p.callId,argsHash:p.argsHash,fingerprint:p.fingerprint};const ch=await a.invoke('desktop_confirm',args,'user',{trustedUser:true});return a.invoke('desktop_confirm',{...args,challengeId:ch.challengeId,code:'654321'},'user',{trustedUser:true});}

test('registered syntax check runs through real Node without a model, approval, or desktop lease',async context=>{
 const f=fixture();fs.writeFileSync(path.join(f.cwd,'valid.mjs'),'export const answer=42;');
 const result=await f.a.runRegisteredCheck({check:'node_syntax',files:['valid.mjs']},{cwd:f.cwd});
 assert.equal(result.ok,true);assert.equal(result.exitCode,0);assert.equal(result.evidence.sideEffects,'none');assert.equal(leaseStatus().holder,null);
 assert.equal(f.a.get(result.taskId).status,'succeeded');assert.equal(f.a.get(result.taskId).approvals.length,0);
 const evidence=path.join(f.root,'registered-syntax-evidence.json');fs.writeFileSync(evidence,JSON.stringify({evidenceType:'real-node-registered-command-no-model',input:path.join(f.cwd,'valid.mjs'),taskFile:path.join(f.root,'data',result.taskId+'.json'),result},null,2));context.diagnostic('registered syntax evidence: '+evidence);
});

test('project test remains pending until existing human short-code approval then runs registered command',async context=>{
 const f=fixture();fs.writeFileSync(path.join(f.cwd,'ok.test.mjs'),'import test from "node:test"; test("ok",()=>{});');
 const pending=f.a.runRegisteredCheck({check:'project_tests',files:['ok.test.mjs']},{cwd:f.cwd});
 const t=await waitPending(f.a);assert.equal(t.calls[0].status,'waiting_confirmation');assert.equal(leaseStatus().holder,null);
 const p=t.pendingConfirmation;await assert.rejects(f.a.invoke('desktop_confirm',{taskId:t.taskId,callId:p.callId,argsHash:p.argsHash,fingerprint:p.fingerprint},'dock:model',{trustedUser:true}),/CONFIRM_REQUIRES_HUMAN/);
 await approve(f.a,t);const result=await pending;
 assert.equal(result.ok,true);assert.equal(result.exitCode,0);assert.equal(result.evidence.sideEffects,'project-execution');assert.equal(t.approvals.length,1);
 assert.match(result.output,/pass 1/);assert.equal(leaseStatus().holder,null);
 const evidence=path.join(f.root,'registered-project-evidence.json');fs.writeFileSync(evidence,JSON.stringify({evidenceType:'real-node-registered-command-with-test-human-channel',realHumanPageValidated:false,waitedBeforeApproval:true,input:path.join(f.cwd,'ok.test.mjs'),taskFile:path.join(f.root,'data',result.taskId+'.json'),result},null,2));context.diagnostic('registered project evidence: '+evidence);
});

test('source or lockfile mutation invalidates pending approval and project code never runs',async()=>{
 const f=fixture();fs.writeFileSync(path.join(f.cwd,'changed.test.mjs'),'import fs from "node:fs"; fs.writeFileSync("sentinel.txt","unsafe");');
 const signal=new AbortController(),pending=f.a.runRegisteredCheck({check:'project_tests',files:['changed.test.mjs']},{cwd:f.cwd,signal:signal.signal});
 const t=await waitPending(f.a);fs.writeFileSync(path.join(f.cwd,'package-lock.json'),'{"changed":true}');
 await assert.rejects(approve(f.a,t),/CONFIRMATION_INVALIDATED/);
 signal.abort();await assert.rejects(pending,/已取消检查/);
 assert.equal(fs.existsSync(path.join(f.cwd,'sentinel.txt')),false);assert.equal(t.status,'cancelled');
});

test('cancelling pending approval resolves without execution and preserves the task and evidence',async()=>{
 const f=fixture();fs.writeFileSync(path.join(f.cwd,'cancel.test.mjs'),'import fs from "node:fs"; fs.writeFileSync("sentinel.txt","unsafe");');
 const pending=f.a.runRegisteredCheck({check:'project_tests',files:['cancel.test.mjs']},{cwd:f.cwd});
 const t=await waitPending(f.a);await f.a.cancel(t.taskId);await assert.rejects(pending,/已取消检查/);
 assert.equal(fs.existsSync(path.join(f.cwd,'sentinel.txt')),false);assert.equal(t.calls[0].evidence.sideEffects,'none');
 assert.ok(fs.existsSync(path.join(f.root,'data',t.taskId+'.json')));assert.equal(t.status,'cancelled');
});

test('unknown check and shell-shaped paths fail closed without any model',async()=>{
 const f=fixture();fs.writeFileSync(path.join(f.cwd,'a.test.mjs'),'export {};');
 await assert.rejects(f.a.runRegisteredCheck({check:'anything',files:[]},{cwd:f.cwd}),/尚未注册/);
 await assert.rejects(f.a.runRegisteredCheck({check:'project_tests',files:['a.test.mjs; calc.exe']},{cwd:f.cwd}));
 assert.equal(f.a.tasks.size,0);
});

test('无锁文件时明确文件走人工确认后真实执行，但绝不自动发现其他测试',async()=>{
 // 用户裁决：解除"无 lockfile 就不能跑测试"的环境限制——明确列出的文件允许执行（仍要人工短码确认），
 // 但不得因此扩大成"枚举整个项目"。
 const f=fixture();
 const other=path.join(f.root,'without-lock');fs.mkdirSync(other);
 fs.writeFileSync(path.join(other,'a.test.mjs'),'import test from "node:test"; test("a",()=>{});');
 fs.writeFileSync(path.join(other,'decoy.test.mjs'),'import fs from "node:fs"; fs.writeFileSync("decoy.txt","不该被执行");');
 f.a.config.allowedRoots.push(other);
 const pending=f.a.runRegisteredCheck({check:'project_tests',files:['a.test.mjs']},{cwd:other});
 const t=await waitPending(f.a);
 assert.equal(JSON.stringify(t.calls[0].evidence||{}).includes('SCOPE_UNDETERMINED'),false,'无锁文件+明确文件不再直接拒绝');
 await approve(f.a,t);
 const result=await pending;
 assert.equal(result.ok,true);assert.equal(result.exitCode,0);
 assert.equal(fs.existsSync(path.join(other,'decoy.txt')),false,'不得自动发现并执行未列出的测试文件');
});

test('abort of running registered process waits for actual process-tree exit confirmation',async()=>{
 const f=fixture(),controller=new AbortController();
 const running=runBounded({command:process.execPath,args:['-e','setTimeout(()=>{},60000)'],cwd:f.cwd,tmpDir:path.join(f.root,'exec'),signal:controller.signal,timeoutMs:60000});
 setTimeout(()=>controller.abort(),50);
 const result=await running;assert.equal(result.aborted,true);assert.equal(result.exitConfirmed,true);assert.equal(result.treeStopConfirmed,true);
});

test('registered syntax checks continue during desktop isolation while project code remains blocked',async()=>{
 const f=fixture();fs.writeFileSync(path.join(f.cwd,'pure.mjs'),'export const x=1;');
 globalThis[Symbol.for('beat.desktop.lease')].isolated=true;
 try{
  const result=await f.a.runRegisteredCheck({check:'node_syntax',files:['pure.mjs']},{cwd:f.cwd});assert.equal(result.ok,true);
  await assert.rejects(f.a.runRegisteredCheck({check:'project_tests',files:['pure.mjs']},{cwd:f.cwd}),/尚未核验/);
  assert.equal(leaseStatus().isolated,true);
 }finally{resetLeaseForTests();}
});

test('native context automatically accepts actual user desktop folder without global config changes',async()=>{
 const f=fixture(),desktop=path.join(f.root,'actual-desktop'),outside=path.join(f.root,'unlisted');fs.mkdirSync(desktop);fs.mkdirSync(outside);
 f.a.userFolders.desktop=desktop;
 const baseline=JSON.stringify(f.a.config.allowedRoots);
 const result=await f.a.callContextTool({contextId:'native-desktop-goal',cwd:desktop,tool:'file_write',args:{path:'ready.txt',content:'本机桌面产物',expectedHash:'absent'}});
 assert.equal(result.ok,true);assert.equal(fs.readFileSync(path.join(desktop,'ready.txt'),'utf8'),'本机桌面产物');
 assert.equal(JSON.stringify(f.a.config.allowedRoots),baseline);
 await assert.rejects(f.a.callContextTool({contextId:'native-unlisted-goal',cwd:outside,tool:'file_write',args:{path:'no.txt',content:'禁止',expectedHash:'absent'}}),/CWD_NOT_ALLOWED/);
 assert.equal(fs.existsSync(path.join(outside,'no.txt')),false);
});

test('registered project transport failure preserves unknown side effects without claiming non-dispatch',async()=>{
 const f=fixture();fs.writeFileSync(path.join(f.cwd,'entry.test.mjs'),'export {};');
 f.a.dispatch=async()=>{const e=Error('fixture transport failed after launch');e.evidence={sideEffects:'unknown',observed:{dispatched:true},verification:{status:'unverified',method:'fixture-transport',checks:[]}};throw e;};
 const pending=f.a.runRegisteredCheck({check:'project_tests',files:['entry.test.mjs']},{cwd:f.cwd});
 const checked=assert.rejects(pending,e=>e.evidence.sideEffects==='unknown'&&e.evidence.observed.dispatched===true);
 const t=await waitPending(f.a);await approve(f.a,t);await checked;
 assert.equal(t.status,'unverified');assert.equal(t.calls[0].evidence.sideEffects,'unknown');assert.equal(leaseStatus().holder,null);
});

test('cancelling an approved running project check waits for exit and preserves earlier file effects',async()=>{
 const f=fixture();fs.writeFileSync(path.join(f.cwd,'running.test.mjs'),'import fs from "node:fs"; fs.writeFileSync("started.txt","started"); await new Promise(resolve=>setTimeout(resolve,60000));');
 const pending=f.a.runRegisteredCheck({check:'project_tests',files:['running.test.mjs']},{cwd:f.cwd});
 const t=await waitPending(f.a);await approve(f.a,t);
 for(let i=0;i<300&&!fs.existsSync(path.join(f.cwd,'started.txt'));i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(fs.existsSync(path.join(f.cwd,'started.txt')),true);
 const cancelling=await f.a.cancel(t.taskId);assert.equal(cancelling.status,'cancelling');
 const result=await pending;assert.equal(result.cancelled,true);assert.equal(result.ok,false);assert.equal(result.exitConfirmed,true);
 assert.equal(t.status,'cancelled');assert.equal(t.stopConfirmed,true);assert.equal(fs.readFileSync(path.join(f.cwd,'started.txt'),'utf8'),'started');assert.equal(leaseStatus().holder,null);
});
