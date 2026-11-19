import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { previewTask } from '../src/task-intent.mjs';
import { literalFileScope } from '../src/literal-files.mjs';
import { openedTarget, assessNativeAction } from '../src/quick-work.mjs';
import { customerPresentation } from '../src/customer-presentation.mjs';
import { runCustomerIssue } from '../src/customer-issue.mjs';
import { refreshSystemProxy } from '../src/system-proxy.mjs';
import { TOOLS } from '../src/tools.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import http from 'node:http';
import net from 'node:net';

test('统一入口预览不把普通文件任务开成会议，显式只读和原会话优先', () => {
  assert.equal(previewTask({question:'新建 alpha.txt 和 beta.txt，内容分别为 A 和 B'}).route,'ask');
  assert.equal(previewTask({question:'帮我开发一个项目管理系统'}).route,'parallel');
  assert.equal(previewTask({question:'请多位搭档共同讨论：怎样安排项目？'}).route,'discuss');
  assert.equal(previewTask({question:'开发项目管理系统',mode:'read-only'}).access,'read-only');
  assert.equal(previewTask({question:'开发项目管理系统',session_id:'S5'}).route,'ask');
  assert.equal(previewTask({question:'开发项目管理系统',mode:'workspace-write'}).route,'ask');
  assert.equal(previewTask({question:'修复整个项目',mode:'parallel',to:'dock:test'}).needsInitiator,true);
  assert.equal(previewTask({question:'怎样新建文件？'}).access,'read-only');
  assert.equal(previewTask({question:'新建 a.txt',to:'deepseek'}).partner,'deepseek');
});

test('多文本直执行覆盖全部文件，已有文件、绝对路径和指定不同执行者不走此路径', t => {
  const root=cleanup(t,tempDir('literal-files'));
  const goal='创建 alpha.txt，内容为 A；创建 beta.txt，内容为 B；读回 alpha.txt';
  assert.deepEqual(literalFileScope(goal,root),['alpha.txt','beta.txt']);
  assert.deepEqual(literalFileScope('不要创建 a.txt，内容为 A',root),[]);
  assert.deepEqual(literalFileScope('创建 E:\\target\\a.txt，内容为 A',root),[]);
  assert.deepEqual(literalFileScope('分别由 Codex 和 DeepSeek 创建 a.txt，内容为 A',root),[]);
  fs.writeFileSync(path.join(root,'alpha.txt'),'OLD');
  assert.deepEqual(literalFileScope(goal,root),[]);
});

test('R385 回归：两个明确文本文件构造一个执行任务，两个逐文件验收标准均保留', t => {
  const root=cleanup(t,tempDir('two-files-plan'));
  const config={...defaults(root),root,dataDir:path.join(root,'data'),skipAcl:true,secrets:{token:'fixture'}};
  config.codex.defaultModel='fixture-codex';config.deepseek.defaultModel='fixture-deepseek';
  const store=new Store(path.join(config.dataDir,'beat.sqlite'));t.after(()=>store.close());
  const orch=new Orchestrator({config,store,agents:{}});orch.pump=()=>{};
  const run=store.createRun({kind:'parallel',initiator:'codex',cwd:root,goal:'创建 alpha.txt，内容为 A；创建 beta.txt，内容为 B。读回核验并由非执行搭档复核。'});
  const candidate=orch.fastPathPlan(run);
  assert.equal(candidate.eligible,true,JSON.stringify(candidate.reasons));assert.equal(candidate.plan.tasks.length,1);
  assert.deepEqual(candidate.plan.tasks[0].files,['alpha.txt','beta.txt']);
  assert.equal(candidate.plan.acceptance.length,2);assert.equal(candidate.plan.requiresModelReview,true);
});

test('R389：禁止运行浏览器、运行脚本、抓取URL均不要求GUI打开证据，真正打开仍核验', t => {
  for(const goal of ['生成视频。不要运行浏览器','用 cv2 运行 video/make_video.py','抓取 https://example.com 并写入 result.json','不要打开浏览器，只生成文件']) assert.deepEqual(openedTarget(goal),{url:null,word:null},goal);
  assert.equal(openedTarget('不要运行浏览器；打开计算器').word,'计算器');
  const root=cleanup(t,tempDir('r389-regression')),file=path.join(root,'make_video.py');
  fs.writeFileSync(file,'# video producer');
  const evidence={trace:{status:'complete'},calls:[{tool:'edit',status:'completed',record:{type:'tool_call',input:{file_path:file}},result:{type:'tool_result',status:'completed'}}]};
  assert.equal(assessNativeAction(evidence,[],{goal:'生成视频；运行脚本；不要运行浏览器',cwd:root,roots:[root]}).ok,true);
  assert.equal(assessNativeAction(evidence,[],{goal:'生成视频，并打开计算器',cwd:root,roots:[root]}).ok,false);
  assert.equal(assessNativeAction({...evidence,sideEffects:'unknown'},[],{goal:'生成视频',cwd:root,roots:[root]}).ok,false);
});

test('成果只来自真实文件证据：过滤内部文件、伪造路径，核验后变更不能继续显示通过', t => {
  const root=cleanup(t,tempDir('delivery-summary')),file=path.join(root,'通知.txt'),control=path.join(root,'.beat-control','checkpoint.json');
  fs.mkdirSync(path.dirname(control),{recursive:true});fs.writeFileSync(control,'{}');fs.writeFileSync(file,'NOTICE');
  const hash=createHash('sha256').update('NOTICE').digest('hex');
  const view={cwd:root,state:'passed',deliveryVerification:{pass:true,readbacks:[{path:file,sha256:hash},{path:control}]},taskQueue:[{state:'passed',outputs:[{path:path.join(root,'missing.txt')}]}]};
  const first=customerPresentation(view);
  assert.equal(first.artifacts.length,1);assert.equal(first.artifacts[0].verified,true);
  fs.writeFileSync(file,'CHANGED');
  const changed=customerPresentation(view).artifacts[0];assert.equal(changed.verified,false);assert.equal(changed.changed,true);
});

test('已生成但尚待独立核验的任务给精准恢复动作，保留失败而不假装通过', () => {
  const view={kind:'ask',access:'workspace-write',state:'failed',error:'最终目标尚未通过独立核验',quickWorkEvidence:{verificationOnly:true,artifacts:[{path:'E:\\result.txt'}]}};
  const issue=runCustomerIssue(view);
  assert.ok(issue.actions.some(a=>a.id==='resume'));assert.match(issue.fileStatus,/1 个文件产物/);
  assert.equal(customerPresentation(view).label,'成果已保留，待核验');
});

test('代理开关与换端口不需要重启，流式任务运行中不切换，子进程继承新出口', async () => {
  const env={BEAT_PROXY_SOURCE:'system',HTTPS_PROXY:'http://127.0.0.1:1',NODE_USE_ENV_PROXY:'1'},seen=[];
  assert.equal((await refreshSystemProxy({env,isIdle:()=>false,detect:()=>{throw Error('不能探测');},apply:()=>{throw Error('不能切换');}})).deferred,true);
  const detect=async()=>({source:'system',http:'http://127.0.0.1:2',https:'http://127.0.0.1:2'});
  await refreshSystemProxy({env,detect,apply:value=>seen.push(value)});
  assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:2');assert.match(seen[0].no_proxy,/127.0.0.1/);
  await refreshSystemProxy({env,detect:async()=>null,apply:value=>seen.push(value)});
  assert.equal(env.HTTPS_PROXY,undefined);assert.equal(env.NODE_USE_ENV_PROXY,undefined);assert.equal(seen[1].https_proxy,'');
});

test('文本与HTML预览返回数据，不执行HTML；越界文件不能预览', t => {
  const root=cleanup(t,tempDir('preview-safe')),file=path.join(root,'page.html');
  fs.writeFileSync(file,'<script>throw Error("must not execute")</script>');
  const o={config:{workspace:root,allowedRoots:[root]}};
  assert.equal(TOOLS.preview_delivered.run(o,{path:file}).kind,'text');
  assert.match(TOOLS.preview_delivered.run(o,{path:file}).text,/<script>/);
  assert.throws(()=>TOOLS.preview_delivered.run(o,{path:path.resolve('package.json')}),/允许打开/);
});

test('真实HTTP传输：同一进程代理端口切换后使用新出口，关闭代理后本机仍可直连', async t => {
  const servers=[],sockets=new Set();
  const proxy=async label=>{
    const server=http.createServer((_req,res)=>res.end(label));servers.push(server);
    server.on('connect',(_req,socket)=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');let data='';socket.on('data',chunk=>{data+=chunk;if(data.includes('\r\n\r\n')){socket.end('HTTP/1.1 200 OK\r\nContent-Length: '+label.length+'\r\nConnection: close\r\n\r\n'+label);}});});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;
  };
  const first=await proxy('FIRST'),second=await proxy('SECOND');
  const originalRestore=http.setGlobalProxyFromEnv({});
  t.after(async()=>{originalRestore();for(const socket of sockets)socket.destroy();await Promise.all(servers.map(server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})));});
  const env={BEAT_PROXY_SOURCE:'system'};
  const detect=address=>async()=>({source:'system',http:address,https:address});
  await refreshSystemProxy({env,detect:detect(first)});
  assert.equal(await(await fetch('http://beat-proxy-check.invalid/',{signal:AbortSignal.timeout(3000)})).text(),'FIRST');
  await refreshSystemProxy({env,detect:detect(second)});
  assert.equal(await(await fetch('http://beat-proxy-check.invalid/',{signal:AbortSignal.timeout(3000)})).text(),'SECOND');
  await refreshSystemProxy({env,detect:async()=>null});
  assert.equal(await(await fetch(first,{signal:AbortSignal.timeout(3000)})).text(),'FIRST');
});

test('预览在开始前给出成本档位，并说明 token 不是金额', () => {
  const ask = previewTask({ question: '什么是闭包？' });
  assert.equal(ask.costEstimate.tier, '轻');
  assert.match(ask.costSummary, /预计档位：轻/);
  assert.match(ask.costNotice, /不是金额|不能换算/);
  const discuss = previewTask({ question: '请多位搭档共同讨论：怎样设计一个便于使用的任务管理工具？' });
  assert.equal(discuss.route, 'discuss');
  assert.equal(discuss.costEstimate.tier, '中');
  assert.match(discuss.costNotice, /8–16 次/);
  const work = previewTask({ question: '在桌面新建通知.txt，内容是明天下午三点开会' });
  assert.equal(work.route, 'ask');
  assert.equal(work.costEstimate.tier, '中');
  assert.match(work.costNotice, /2–9 万/);
  const parallel = previewTask({ question: '帮我开发一个项目管理系统' });
  assert.equal(parallel.route, 'parallel');
  assert.equal(parallel.costEstimate.tier, '重');
});

test('撤回文件改动后，成果状态明确写已恢复，不继续显示已核验', t => {
  const root=cleanup(t,tempDir('rolled-back-artifact')),file=path.join(root,'x.txt');
  fs.writeFileSync(file,'before');
  const hash=createHash('sha256').update('after').digest('hex');
  const presentation=customerPresentation({cwd:root,state:'passed',deliveryVerification:{pass:true,readbacks:[{path:file,sha256:hash}]},checkpoint:{rolledBackAt:'2026-10-19T01:00:00Z',changes:[{path:file}]}},{roots:[root]});
  assert.equal(presentation.artifacts.length,1);
  assert.equal(presentation.artifacts[0].verified,false);
  assert.match(presentation.artifacts[0].status,/已撤销.*恢复到执行前/);
});

test('部分撤销只把真正恢复的文件标为已撤销，跳过的文件保持原状态', t => {
  const root=cleanup(t,tempDir('partial-artifact')),a=path.join(root,'a.txt'),b=path.join(root,'b.txt');
  fs.writeFileSync(a,'a'); fs.writeFileSync(b,'b');
  const ha=createHash('sha256').update('a').digest('hex'), hb=createHash('sha256').update('b').digest('hex');
  const presentation=customerPresentation({cwd:root,state:'passed',deliveryVerification:{pass:true,readbacks:[{path:a,sha256:ha},{path:b,sha256:hb}]},checkpoint:{rolledBackAt:'2026-10-19T01:00:00Z',partial:true,rolledBackPaths:[a],changes:[{path:a},{path:b}]}},{roots:[root]});
  const byStatus=Object.fromEntries(presentation.artifacts.map(x=>[x.path,x.status]));
  assert.match(byStatus[a],/已撤销/);
  assert.doesNotMatch(byStatus[b],/已撤销/);
});
