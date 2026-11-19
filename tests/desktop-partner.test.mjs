import test from 'node:test';
import assert from 'node:assert/strict';
import {executeDesktopPartner} from '../workspaces/shared/desktop-assistant/integration/partner.mjs';

function fake(status='succeeded',calls=[]) {
 const a={starts:0,cancels:0,t:{taskId:'D-test',dockId:'dock:test',status,calls},start:async(args)=>{a.starts++;a.args=args;return a.t;},get:()=>a.t,cancel:async()=>{a.cancels++;a.t.status='cancelled';}};return a;
}
test('partner adapter uses desktop-only scope and preserves operation evidence',async()=>{
 const a=fake('succeeded',[{callId:'c1',tool:'window_focus',status:'verified',evidence:{sideEffects:'done'}}]);
 const r=await executeDesktopPartner({},'dock:test',{prompt:'打开应用',cwd:'E:/test',effort:'high'},{assistant:a});
 assert.equal(a.args.executionScope,'desktop');assert.equal(a.args.effort,'high');
 assert.equal(r.status,'succeeded');assert.equal(JSON.parse(r.text).calls[0].tool,'window_focus');
});
test('unverified desktop result must fail parent execution',async()=>{
 const a=fake('unverified');
 await assert.rejects(()=>executeDesktopPartner({},'dock:test',{prompt:'操作'},{assistant:a}),e=>e.desktopTaskId==='D-test'&&e.desktopEvidence.status==='unverified');
});
test('uncertain previous input cannot be replayed even after new advice',async()=>{
 const a=fake('failed',[{status:'failed',evidence:{sideEffects:'unknown'}}]);
 await assert.rejects(()=>executeDesktopPartner({},'dock:test',{prompt:'继续',previous:{desktopTaskId:'D-test'}},{assistant:a}),/DESKTOP_REPLAY_REQUIRES_REVIEW/);
 assert.equal(a.starts,0);
});
test('missing action evidence after a bridge error also blocks replay',async()=>{
 const a=fake('failed',[{tool:'key_press',status:'failed',error:{code:'TIMEOUT'}}]);
 await assert.rejects(()=>executeDesktopPartner({},'dock:test',{prompt:'继续',previous:{desktopTaskId:'D-test'}},{assistant:a}),/DESKTOP_REPLAY_REQUIRES_REVIEW/);
 assert.equal(a.starts,0);
});
test('中断后继续：之前的桌面任务隔离但没有任何派发动作时可以接着做',async()=>{
 const a={starts:0,args:null,t:{taskId:'D-old',dockId:'dock:test',status:'unverified',isolated:true,stopConfirmed:false,calls:[]},
  start:async(args)=>{a.starts++;a.args=args;a.t={taskId:'D-new',dockId:'dock:test',status:'succeeded',calls:[{callId:'c1',tool:'window_list',status:'verified',evidence:{sideEffects:'none'}}]};return a.t;},
  get:()=>a.t};
 const r=await executeDesktopPartner({},'dock:test',{prompt:'继续完成任务',previous:{desktopTaskId:'D-old'}},{assistant:a});
 assert.equal(a.starts,1,'没有派发过动作的中断任务必须能继续，而不是要求人工核对');
 assert.match(a.args.goal,/上次任务记录（先重新观察，只补未完成部分，不重复已完成输入）/);
 assert.equal(r.status,'succeeded');
});
test('中断的桌面任务里还有未核验的输入动作时，仍然要求先人工核对',async()=>{
 const a={starts:0,t:{taskId:'D-old',dockId:'dock:test',status:'unverified',isolated:true,calls:[{callId:'c1',tool:'key_press',status:'running'}]},start:async()=>{a.starts++;return a.t;},get:()=>a.t};
 await assert.rejects(()=>executeDesktopPartner({},'dock:test',{prompt:'继续',previous:{desktopTaskId:'D-old'}},{assistant:a}),/DESKTOP_REPLAY_REQUIRES_REVIEW/);
 assert.equal(a.starts,0);
});

test('parent cancellation reaches queued/running desktop task',async()=>{
 const a=fake('running'),ac=new AbortController();
 await assert.rejects(()=>executeDesktopPartner({},'dock:test',{prompt:'操作',signal:ac.signal,onProgress:()=>ac.abort()},{assistant:a}),e=>e.cancelled===true);
 assert.equal(a.cancels,1);
});
test('desktop timeout requests stop and reports evidence',async()=>{
 const a=fake('running');
 await assert.rejects(()=>executeDesktopPartner({},'dock:test',{prompt:'操作',timeoutMs:-1},{assistant:a}),e=>e.desktopTaskId==='D-test'&&/超时/.test(e.message));
 assert.equal(a.cancels,1);
});
