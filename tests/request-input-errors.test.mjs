import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '../src/config.mjs';
import { startServer } from '../src/server.mjs';
import { TOOLS } from '../src/tools.mjs';
import { customerIssue } from '../src/customer-issue.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

test('HTTP invalid requests never dispatch a tool, call a model, or modify task files', async t => {
  const root = fs.mkdtempSync(path.join(artifactsRoot(), 'request-input-'));
  const config = {...defaults(root), root, dataDir:path.join(root,'data'), skipAcl:true, secrets:{token:'local-test-token',claudeApiKey:''}};
  fs.mkdirSync(config.workspace, {recursive:true});
  const existing = path.join(config.workspace,'existing.txt');
  fs.writeFileSync(existing,'keep this file');
  let calls = 0;
  const service = await startServer({config, agents:{codex:async()=>{calls++;throw new Error('unexpected model call');}}, port:0});
  t.after(async()=>{await new Promise(resolve=>service.server.close(resolve));service.store.close();});
  const post = async body => (await fetch(`http://127.0.0.1:${service.port}/api/call`, {
    method:'POST',headers:{authorization:'Bearer local-test-token','content-type':'application/json'},body,
  })).json();
  const invalid = ['{', '', 'null', '[]', '5', '"hello"', '{}',
    ...[
      {name:'missing-tool'}, {name:'constructor'}, {name:'toString'}, {name:55},
      {name:'beat_ask',args:null}, {name:'beat_ask',args:[]},
      {name:'beat_ask',args:{to:'codex'}}, {name:'beat_ask',args:{to:'codex',question:' '}},
      {name:'beat_ask',args:{to:'codex',question:42}},
      {name:'beat_ask',args:{to:'codex',question:'do work'},child:'false'},
      {name:'beat_ask',args:{to:'codex',question:'do work'},actor:null},
      {name:'beat_ask',args:{to:'codex',question:'do work',access:'invalid'}},
    ].map(value=>JSON.stringify(value)),
  ];
  for (const body of invalid) {
    const reply = await post(body);
    assert.equal(reply.ok,false,body);
    assert.equal(reply.customerIssue.title,'操作尚未开始',body);
    assert.match(reply.customerIssue.fileStatus,/没有派发执行，未修改文件/);
    assert.match(reply.customerIssue.costStatus,/尚未调用模型/);
    assert.doesNotMatch(reply.customerIssue.message,/搭档|点「继续」|SyntaxError|Unexpected/);
    // 接口/MCP 调用没有看板按钮：UI 专用的“关闭提示”不再混进接口返回（P3 文案清理）。
    assert.deepEqual(reply.customerIssue.actions,[]);
    assert.doesNotMatch(JSON.stringify(reply.customerIssue),/关闭提示/);
  }
  assert.equal(calls,0);
  assert.equal(service.store.runs().length,0);
  assert.deepEqual(fs.readdirSync(config.workspace),['existing.txt']);
  assert.equal(fs.readFileSync(existing,'utf8'),'keep this file');
  // 目标在派发前被拒绝：标题要说“操作尚未开始”，而不是笼统的“任务没有完成”。
  const badPartner = await post(JSON.stringify({name:'beat_ask',args:{to:'nobody',question:'x'}}));
  assert.equal(badPartner.ok,false);
  assert.equal(badPartner.customerIssue.title,'操作尚未开始');
  assert.match(badPartner.customerIssue.message,/搭档列表/);
  assert.doesNotMatch(badPartner.customerIssue.message,/to 只能是/);
  assert.match(badPartner.customerIssue.fileStatus,/没有派发执行/);
  assert.deepEqual(badPartner.customerIssue.actions,[]);
  assert.equal((await post(JSON.stringify({name:'beat_list'}))).ok,true);
  assert.equal((await post(JSON.stringify({name:'beat_list',args:{limit:null}}))).ok,true);

  // A real dispatched handler writes first, then fails. The HTTP catch must
  // never mislabel this as a rejected request or promise safe replay.
  TOOLS.request_failure_fixture = {schema:{type:'object'},run:()=>{
    fs.writeFileSync(existing,'tool already changed file');
    throw new SyntaxError('Unexpected token after tool execution');
  }};
  t.after(()=>{delete TOOLS.request_failure_fixture;});
  const dispatched = await post(JSON.stringify({name:'request_failure_fixture'}));
  assert.equal(dispatched.ok,false);
  assert.match(dispatched.customerIssue.fileStatus,/尚未核实/);
  assert.match(dispatched.customerIssue.costStatus,/不能确认/);
  assert.doesNotMatch(dispatched.customerIssue.message,/搭档|点「继续」/);
  assert.equal(fs.readFileSync(existing,'utf8'),'tool already changed file');
});

test('unbound errors do not advertise a continue button or imply safe replay',()=>{
  for (const error of ['Unexpected token','HTTP 502 Bad Gateway','maximum context length','usage limit','{"kind":"error"}']) {
    const issue = customerIssue(error);
    assert.deepEqual(issue.actions,[{id:'dismiss',label:'关闭提示'}]);
    assert.doesNotMatch(issue.message,/点「|不会重做|只补没完成/);
    assert.match(issue.fileStatus,/尚未核实/);
    assert.match(issue.costStatus,/不能确认/);
  }
  const runIssue = customerIssue('Unexpected token',{run:{kind:'parallel',state:'failed'}});
  assert.equal(runIssue.actions.some(action=>action.id==='resume'),true);
  assert.match(runIssue.message,/点「核对后继续原任务」/);
  const runningIssue = customerIssue('HTTP 502',{run:{kind:'parallel',state:'running'}});
  assert.match(runningIssue.message,/点「继续等待」/);
  assert.doesNotMatch(runningIssue.message,/点「核对后继续原任务」/);
  for (const raw of ['SyntaxError: Unexpected token','PATH_NOT_FOUND','INTERNAL_ERROR']) {
    const issue = customerIssue(raw,{beforeDispatch:true});
    assert.doesNotMatch(issue.message,/SyntaxError|Unexpected|PATH_NOT_FOUND|INTERNAL_ERROR|搭档/);
    assert.match(issue.costStatus,/尚未调用模型/);
  }
});
