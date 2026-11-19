import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { askCodex, codexTransportProgress } from '../src/codex-engine.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { defaults } from '../src/config.mjs';
import { runCustomerIssue } from '../src/customer-issue.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

// Same app-server protocol shape observed in R211; no real model or service.
const disconnect = attempt => ({ method:'error', params:{ threadId:'native-original', turnId:'turn-original', willRetry:true,
  error:{ message:`Reconnecting... ${attempt}/5`, additionalDetails:'request timed out', codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}} } } });
const reply = { method:'item/completed', params:{threadId:'native-original',turnId:'turn-original',item:{id:'answer',type:'agentMessage',text:'Recovered reply'}} };
function fakeProcess(requests, notifications) {
  return () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString()); requests.push(message);
      queueMicrotask(() => {
        if (message.id === undefined) return;
        const result = ['thread/start','thread/resume'].includes(message.method) ? {thread:{id:'native-original'},model:'fixture-model'}
          : message.method === 'turn/start' ? {turn:{id:'turn-original'}} : {};
        child.stdout.write(JSON.stringify({id:message.id,result})+'\n');
        if (message.method === 'turn/start') for (const notification of notifications) child.stdout.write(JSON.stringify(notification)+'\n');
      }); done();
    }}); return child;
  };
}
function fixture(t, access = 'read-only') {
  const root = path.join(artifactsRoot(), 'native-connection-progress', randomUUID()); fs.mkdirSync(root,{recursive:true});
  const config = defaults(root); config.root=root; config.dataDir = path.join(root,'data'); config.skipAcl = true; config.secrets = {token:'fixture-secret'};
  config.codex.home = root; config.codex.executable = path.join(root,'fixture-codex'); fs.writeFileSync(config.codex.executable,'fixture');
  config.codex.defaultModel='fixture-model'; config.flow.stepTimeoutMin = 0;
  const store = new Store(path.join(root,'audit.sqlite')); t.after(()=>store.close());
  const orch = new Orchestrator({config,store,agents:{}});
  const run = store.createRun({kind:'ask',goal:'Evaluate without modifying files',cwd:root,target:'codex',access});
  store.updateRun(run.id,{state:'running'});
  orch.roster.pick = ()=>'codex';
  return {root,config,store,orch,run,options:{role:'ask',seat:'codex',call:'think',build:()=>run.goal,signal:new AbortController().signal,sessions:{}}};
}

test('real protocol errors expose retry details immediately; usage alone never proves recovery', () => {
  const progress = codexTransportProgress(disconnect(2));
  assert.equal(progress.status,'reconnecting'); assert.equal(progress.attempt,2); assert.equal(progress.maxAttempts,5);
  assert.equal(progress.diagnostic.additionalDetails,'request timed out');
  assert.equal(progress.threadId,'native-original');
  assert.equal(codexTransportProgress({method:'thread/tokenUsage/updated',params:{}},progress),null);
  assert.equal(codexTransportProgress({method:'thread/status/changed',params:{}},progress),null);
  assert.equal(codexTransportProgress({method:'item/started',params:{item:{type:'commandExecution',id:'local-tool'}}},progress),null);
  assert.equal(codexTransportProgress({method:'item/commandExecution/outputDelta',params:{delta:'local command output'}},progress),null);
  assert.equal(codexTransportProgress({method:'item/agentMessage/delta',params:{delta:''}},progress),null);
  assert.equal(codexTransportProgress(reply,progress).status,'recovered');
  const exhausted = disconnect(5); exhausted.params.willRetry = false;
  assert.equal(codexTransportProgress(exhausted,progress).status,'interrupted');
});

test('Codex original-turn reconnects are visible in compact SQLite view before 2 minutes and clear on response', async t => {
  const f = fixture(t), requests=[], observed=[];
  const retryWithSecret=disconnect(3); retryWithSecret.params.error.additionalDetails='request timed out fixture-secret';
  const notifications = [disconnect(2), {method:'thread/tokenUsage/updated',params:{threadId:'native-original',turnId:'turn-original',tokenUsage:{last:{totalTokens:123}}}}, retryWithSecret, reply,
    {method:'turn/completed',params:{threadId:'native-original',turn:{id:'turn-original',status:'completed'}}}];
  f.orch.roster.call = async options => {
    const result = await askCodex(f.config,{prompt:options.build('codex'),cwd:f.root,nativeId:'native-original',model:'fixture-model',timeoutMs:500,
      onProgress:progress=>{
        options.onProgress(progress);
        if (progress.transport) observed.push(f.orch.view(f.run.id,{full:false}));
      }}, {spawnProcess:fakeProcess(requests,notifications),desktopFlags:false});
    return {...result,by:'codex',errors:[],requestedModel:'fixture-model',prompt:f.run.goal};
  };
  await f.orch.step(f.run,f.options);
  assert.equal(observed[0].steps[0].data,undefined);
  assert.equal(observed[0].steps[0].transport.status,'reconnecting');
  assert.ok(Date.now()-Date.parse(observed[0].steps[0].started_at)<120000);
  assert.match(observed[0].customerIssue.message,/原会话内重新连接/);
  assert.match(observed[0].customerIssue.fileStatus,/只读权限/);
  assert.match(observed[0].customerIssue.costStatus,/尚未取得/);
  assert.deepEqual(observed[0].customerIssue.actions.map(a=>a.id),['wait','stop']);
  assert.equal(observed.at(-1).steps[0].transport.status,'recovered');
  assert.equal(observed.at(-1).customerIssue,null);
  const persisted = f.store.steps(f.run.id)[0];
  assert.equal(persisted.state,'done'); assert.equal(persisted.data.transport.status,'recovered');
  assert.deepEqual(persisted.data.transportHistory.map(p=>p.status),['reconnecting','reconnecting','recovered']);
  assert.equal(persisted.data.transportHistory[0].diagnostic.additionalDetails,'request timed out');
  assert.equal(persisted.data.transportHistory[1].diagnostic.additionalDetails,'request timed out [已隐去]');
  assert.ok(!JSON.stringify(persisted.data).includes('fixture-secret'));
  const reopened = new Store(f.store.file); try { assert.deepEqual(reopened.steps(f.run.id)[0].data.transportHistory,persisted.data.transportHistory); } finally {reopened.close();}
  assert.equal(f.store.events().filter(e=>e.type==='connection').length,3);
  assert.equal(requests.filter(r=>r.method==='thread/start').length,0);
  assert.equal(requests.filter(r=>r.method==='thread/resume').length,1);
  assert.equal(requests.filter(r=>r.method==='turn/start').length,1);
  assert.equal(requests.find(r=>r.method==='turn/start').params.model,'fixture-model');
});

test('cancelled write task retains disconnect audit, reports unknown side effects and never becomes active again', async t => {
  const f=fixture(t,'workspace-write'); let calls=0;
  f.orch.roster.call=async options=>{
    calls++; options.onProgress({source:'codex',event:'error',transport:codexTransportProgress(disconnect(4))});
    const view=f.orch.view(f.run.id);
    assert.match(view.customerIssue.fileStatus,/尚未核实/);
    assert.match(view.customerIssue.costStatus,/不能确认是否产生费用/);
    f.store.updateRun(f.run.id,{state:'cancelled'});
    throw Object.assign(new Error('User stopped task'),{cancelled:true,actualAgent:'codex'});
  };
  await assert.rejects(f.orch.step(f.run,f.options),e=>e.cancelled===true);
  const final=f.orch.view(f.run.id,{full:true});
  assert.equal(final.state,'cancelled'); assert.equal(final.steps[0].state,'cancelled'); assert.equal(calls,1);
  assert.equal(final.steps[0].data.transportHistory[0].attempt,4);
  assert.notEqual(final.customerIssue?.title,'Codex 正在重新连接');
});

test('finished and recovered tasks never show a stale reconnect card',()=>{
  const step={state:'running',started_at:new Date().toISOString(),transport:codexTransportProgress(disconnect(2))};
  assert.equal(runCustomerIssue({state:'cancelled',kind:'ask',steps:[step]}),null);
  assert.equal(runCustomerIssue({state:'running',kind:'ask',steps:[{...step,transport:{status:'recovered'}}]}),null);
  assert.equal(runCustomerIssue({state:'running',kind:'ask',steps:[{...step,started_at:new Date(Date.now()-180000).toISOString(),transport:{status:'recovered',at:new Date().toISOString()}}]}),null);
});
