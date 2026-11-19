import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {defaults} from '../src/config.mjs';
import {startServer} from '../src/server.mjs';
import {resolveWorkspace} from '../src/workspace.mjs';
import {WorkspaceAccessRequests,withWorkspaceGrant} from '../src/workspace-access.mjs';
import {customerIssue} from '../src/customer-issue.mjs';
import {artifactsRoot} from './helpers/temp.mjs';

function fixture(){const root=fs.mkdtempSync(path.join(artifactsRoot(),'customer-access-'));const outside=path.join(root,'private');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'existing.txt'),'unchanged');const config={...defaults(root),root,dataDir:path.join(root,'data'),skipAcl:true,secrets:{token:'local-test-token',claudeApiKey:''}};config.codex.defaultModel='codex-fixture';config.deepseek.defaultModel='deepseek-fixture';return {root,outside,config};}
test('看板授权绑定原只读请求：未批准零调用、禁止模型自行授权、一次放行、取消不执行',async t=>{
 const {outside,config}=fixture();let calls=0;const svc=await startServer({config,agents:{codex:async()=>{calls++;return {text:'read-only answer'};}},port:0});
 t.after(async()=>{await new Promise(r=>svc.server.close(r));svc.store.close();});
 const base='http://127.0.0.1:'+svc.port;
 const call=async(name,args={},page=false,actor='user')=>(await fetch(base+'/api/call',{method:'POST',headers:{authorization:'Bearer local-test-token','content-type':'application/json',...(page?{origin:base,'sec-fetch-site':'same-origin'}:{})},body:JSON.stringify({name,args,actor})})).json();
 const args={to:'codex',question:'只读评价文件',cwd:outside,access:'read-only',wait_seconds:2};
 const first=await call('beat_ask',args);assert.equal(first.ok,false);assert.equal(calls,0);assert.equal(svc.store.runs().length,0);assert.equal(first.customerIssue.permission.access,'read-only');
 const requestId=first.customerIssue.permission.requestId;
 const pending=await call('overview');assert.equal(pending.result.workspaceAccessRequests[0].requestId,requestId);
 assert.equal((await call('workspace_access_grant',{requestId,decision:'once'})).ok,false);
 assert.equal((await call('workspace_access_grant',{requestId,decision:'once'},true,'codex')).ok,false);
 const allowed=await call('workspace_access_grant',{requestId,decision:'once'},true);assert.equal(allowed.ok,true,JSON.stringify(allowed));assert.ok(allowed.result.result.id);assert.equal(calls,1);assert.equal(svc.store.runs().length,1);
 assert.equal((await call('workspace_access_grant',{requestId,decision:'once'},true)).ok,false);assert.equal(calls,1);
 assert.deepEqual(fs.readdirSync(outside),['existing.txt']);assert.equal(fs.readFileSync(path.join(outside,'existing.txt'),'utf8'),'unchanged');
 const next=await call('beat_ask',args);assert.equal(next.ok,false,'本次授权不能用于新请求');
 assert.equal((await call('workspace_access_grant',{requestId:next.customerIssue.permission.requestId,decision:'cancel'},true)).result.cancelled,true);assert.equal(calls,1);
});
test('永久只读不能提升为写入；并发本次授权不能泄漏至其他任务；目录链接更换时拒绝',async()=>{
 const {root,outside,config}=fixture();const requests=new WorkspaceAccessRequests(config);const args={cwd:outside};const permission=requests.request({folder:outside,access:'read-only',operation:'beat_ask',args,actor:'user'});args.cwd=root;
 const grant=requests.consume(permission.requestId,'always');assert.equal(grant.args.cwd,outside);
 assert.equal(resolveWorkspace(config,outside,{access:'read-only'}),fs.realpathSync(outside));
 assert.throws(()=>resolveWorkspace(config,outside),/还没有访问/);assert.deepEqual(config.allowedRoots,defaults(root).allowedRoots);
 const other=path.join(root,'other');fs.mkdirSync(other);const p=requests.request({folder:other,access:'read-only',operation:'beat_ask',args:{}});const once=requests.consume(p.requestId,'once');
 await Promise.all([withWorkspaceGrant(once,async()=>{await new Promise(r=>setTimeout(r,15));assert.equal(resolveWorkspace(config,other,{access:'read-only'}),fs.realpathSync(other));}), (async()=>{await new Promise(r=>setTimeout(r,5));assert.throws(()=>resolveWorkspace(config,other,{access:'read-only'}),/还没有访问/);})()]);
 const link=path.join(root,'link');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');const request=requests.request({folder:link,access:'read-only',operation:'beat_ask',args:{}});
 fs.renameSync(link,path.join(root,'old-link'));fs.symlinkSync(other,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>requests.consume(request.requestId,'once'),/位置发生变化/);
});
test('客户错误保留未知事实，不把超时编成未修改或零费用',()=>{
 const i=customerIssue('workspace routing discovery timed out');assert.match(i.message,/Codex 暂时没有响应/);assert.match(i.fileStatus,/尚未核实/);assert.match(i.costStatus,/不能确认/);
 const t=customerIssue('DeepSeek timeout',{run:{kind:'ask',state:'running'},tokens:44882});assert.match(t.costStatus,/44,882/);assert.deepEqual(t.actions.map(a=>a.id),['wait','stop']);
 assert.equal(customerIssue('LEASE_STALE',{run:{kind:'parallel',state:'failed'}}).actions.some(a=>a.id==='resume'),false);
 assert.match(customerIssue('modelVerified: unknown').message,/无法确认/);
});
