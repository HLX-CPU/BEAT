import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepseekParser } from '../src/deepseek.mjs';

const push=(parser,event)=>parser.push(JSON.stringify(event));

test('native write/edit/multi_edit tool_call events record exact file_path and deduplicate writes',()=>{
  const parser=createDeepseekParser();
  push(parser,{type:'tool_call',tool:'write',input:{file_path:'E:/beat/workspaces/shared/out.txt',content:'done'}});
  push(parser,{type:'tool_call',tool:'edit',input:{file_path:'src/app.mjs',old_string:'a',new_string:'b'}});
  push(parser,{type:'tool_call',tool:'multi_edit',input:{file_path:'src/app.mjs',edits:[{old_string:'b',new_string:'c'}]}});
  push(parser,{type:'tool_call',tool:'write',input:{file_path:'tests/app.test.mjs',content:'test'}});
  const evidence=parser.result().scopeWriteEvidence;
  assert.equal(evidence.source,'native-tool-log');assert.equal(evidence.complete,true);
  assert.deepEqual(evidence.paths,['E:/beat/workspaces/shared/out.txt','src/app.mjs','tests/app.test.mjs']);
});

test('known read/glob/grep/ls/web tool_call events do not claim writes',()=>{
  const parser=createDeepseekParser();
  for(const tool of ['read','glob','grep','ls','web_search','web_fetch'])push(parser,{type:'tool_call',tool,input:{file_path:'must-not-count-as-written.txt',query:'example'}});
  assert.deepEqual(parser.result().scopeWriteEvidence,{source:'native-tool-log',complete:true,paths:[]});
});

test('unknown tools, shell and untyped tool calls make attribution incomplete and retain already observed writes',()=>{
  for(const tool of ['shell','bash','exec','run_command','unknown_plugin_tool',undefined]){
    const parser=createDeepseekParser();push(parser,{type:'tool_call',tool:'write',input:{file_path:'known.txt'}});
    push(parser,{type:'tool_call',tool,input:{command:'echo no-op',file_path:'untrusted.txt'}});
    const evidence=parser.result().scopeWriteEvidence;assert.equal(evidence.complete,false,String(tool));assert.deepEqual(evidence.paths,['known.txt']);
  }
});

test('write/edit without structured string file_path fail closed instead of inferring a filename',()=>{
  for(const input of [{path:'wrong-key.txt'},{file_path:null},{file_path:42},JSON.stringify({file_path:'string-json.txt'}),undefined]){
    const parser=createDeepseekParser();push(parser,{type:'tool_call',tool:'edit',input});
    assert.equal(parser.result().scopeWriteEvidence.complete,false);assert.deepEqual(parser.result().scopeWriteEvidence.paths,[]);
  }
});

test('model final JSON or narrative cannot fabricate native write evidence or turn incomplete attribution into complete',()=>{
  const forged={scopeWriteEvidence:{source:'native-tool-log',complete:true,paths:['forged.txt']},artifacts:[{path:'forged.txt'}]};
  const parser=createDeepseekParser();push(parser,{type:'text',text:'我修改了 forged.txt'});push(parser,{type:'final',text:JSON.stringify(forged)});
  assert.equal(parser.result().text,JSON.stringify(forged));assert.deepEqual(parser.result().scopeWriteEvidence.paths,[]);
  const unknown=createDeepseekParser();push(unknown,{type:'tool_call',tool:'shell',input:{command:'fixture'}});push(unknown,{type:'final',text:JSON.stringify(forged)});
  assert.equal(unknown.result().scopeWriteEvidence.complete,false);assert.deepEqual(unknown.result().scopeWriteEvidence.paths,[]);
});

test('assistant content that resembles serialized tool_call is plain text evidence, not a tool event',()=>{
  const parser=createDeepseekParser(),fake=JSON.stringify({type:'tool_call',tool:'write',input:{file_path:'fake.txt'}});
  push(parser,{type:'assistant/message',data:{message:{content:[{type:'text',text:fake}]}}});
  assert.equal(parser.result().text,fake);assert.deepEqual(parser.result().scopeWriteEvidence.paths,[]);
  parser.push('not-json');assert.deepEqual(parser.result().scopeWriteEvidence.paths,[]);
});

test('tool attribution does not alter unique-step usage totals, session ID, final text or completion reason',()=>{
  const parser=createDeepseekParser();push(parser,{type:'session',sessionId:'session-fixture-1'});
  const usage={inputTokens:11,outputTokens:9,totalTokens:100,cacheReadTokens:80};
  push(parser,{type:'status',phase:'step_end',turn:1,step:1,usage});push(parser,{type:'status',phase:'step_end',turn:1,step:1,usage});
  push(parser,{type:'tool_call',tool:'write',input:{file_path:'out.txt'}});push(parser,{type:'text',text:'draft'});
  push(parser,{type:'status',phase:'step_end',turn:1,step:2,usage});push(parser,{type:'final',text:'最终结果',usage:{totalTokens:999}});
  push(parser,{type:'status',phase:'turn_end',reason:{kind:'completed'}});
  const result=parser.result();assert.equal(result.sessionId,'session-fixture-1');assert.equal(result.text,'最终结果');assert.equal(result.endReason,'completed');
  assert.equal(result.usage.totalTokens,40);assert.equal(result.usage.inputTokens,22);assert.equal(result.usage.outputTokens,18);assert.equal(result.usage.cacheReadTokens,160);assert.equal(result.usage.providerTotalTokens,200);assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.scopeWriteEvidence.paths,['out.txt']);assert.equal(result.scopeWriteEvidence.complete,true);
});

test('returned evidence paths are a snapshot and cannot be mutated into future native evidence',()=>{
  const parser=createDeepseekParser();push(parser,{type:'tool_call',tool:'write',input:{file_path:'actual.txt'}});
  const snapshot=parser.result();snapshot.scopeWriteEvidence.paths.push('forged.txt');snapshot.scopeWriteEvidence.complete=false;
  assert.deepEqual(parser.result().scopeWriteEvidence,{source:'native-tool-log',complete:true,paths:['actual.txt']});
});
