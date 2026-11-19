// Uses the browser's DOM/CDP interface; never reads or controls the user's desktop.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaults, loadConfig } from '../src/config.mjs';
import { call, ensureService } from '../src/client.mjs';
import { startServer } from '../src/server.mjs';
import { Models } from '../src/models.mjs';
import { createHash } from 'node:crypto';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const live=process.argv.includes('--live');
const twoFiles=process.argv.includes('--two-files');
const reuseId=process.argv.find(arg=>arg.startsWith('--inspect='))?.slice('--inspect='.length);
const reused=live&&reuseId?await call('beat_get',{id:reuseId}):null;
const output=path.join(root,'data/reports/BEAT体验修复-20261018');
const verificationRoot=path.join(output,'browser-run-'+Date.now());
let workspace=path.join(verificationRoot,'workspace');fs.mkdirSync(workspace,{recursive:true});
const fileName=reused?path.basename(reused.customer.artifacts[0].path):live?'BEAT体验验证_'+Date.now()+'.txt':'notice.txt';
const checks=[],errors=[];
const record=(name,ok,detail)=>{checks.push({name,ok,detail});if(!ok)throw Error(name+': '+JSON.stringify(detail));};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn)=>{for(let i=0;i<(live?600:160);i++){const value=await fn();if(value)return value;if(live&&i%30===0)console.log(JSON.stringify({waiting:true,seconds:i/2}));await sleep(live?500:100);}throw Error('等待浏览器状态超时');};
const config=live?loadConfig(root):{...defaults(root),root,dataDir:path.join(verificationRoot,'data'),workspace,allowedRoots:[workspace],skipAcl:true,secrets:{token:'isolated-browser-verification'},dock:[]};
if(live)workspace=config.workspace;
else {config.localController={...config.localController,enabled:false};config.claude.enabled=false;config.codex.defaultModel='fixture-codex';config.deepseek.defaultModel='fixture-deepseek';}
const models=new Models(config,{capabilities:{},catalog:async provider=>({source:'fixture',models:[{id:'fixture-'+provider,name:provider,availability:'configured'}]})});
let svc,browser,ws,seq=0;
const pending=new Map();
const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result?.value;};
try {
  const executor=async options=>{
    const file=path.join(workspace,'notice.txt');
    fs.writeFileSync(file,'MEETING AT THREE');
    return {text:'通知已生成。\n'+file,nativeId:'fixture-write',actualModel:'fixture-codex',modelVerified:'verified',usage:{totalTokens:120},nativeToolEvidence:{calls:[{tool:'write',status:'completed',record:{type:'tool_call',input:{file_path:file}},result:{type:'tool_result',status:'completed'}}],trace:{status:'complete'}}};
  };
  const reviewer=async options=>{
    const run=svc.store.runs(1)[0],contract=svc.store.get('goalContract:'+run.id),file=path.join(workspace,'notice.txt'),data=fs.readFileSync(file);
    return {text:JSON.stringify({pass:true,issues:[],goalHash:contract.goalHash,goalChecks:{object:'verified',deliverables:'verified',prohibitions:'verified'},readbacks:[{path:file,sha256:createHash('sha256').update(data).digest('hex'),quote:data.toString()}]}),nativeId:'fixture-review',actualModel:'fixture-deepseek',modelVerified:'verified',usage:{totalTokens:80}};
  };
  if(live){await ensureService(config);svc={port:config.port};}
  else svc=await startServer({config,models,agents:{codex:executor,deepseek:reviewer,nativeAvailability:()=>({installed:true,available:true,toolsVerified:false})},port:0});
  const port=svc.port,profile=path.join(output,'edge-profile-'+Date.now());
  const exe=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(file=>fs.existsSync(file));
  if(!exe)throw Error('未找到可用于无界面验证的浏览器');
  browser=spawn(exe,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>errors.push(error.message));
  const devPort=await until(()=>{try{return Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);}catch{return null;}});
  const targets=await(await fetch('http://127.0.0.1:'+devPort+'/json/list')).json();
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){const promise=pending.get(message.id);if(!promise)return;pending.delete(message.id);message.error?promise.reject(Error(message.error.message)):promise.resolve(message.result);}else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);});
  await cdp('Runtime.enable');await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:'http://127.0.0.1:'+port});
  await until(()=>evaluate("!!document.getElementById('askBtn') && document.getElementById('askTo').options.length > 0 && document.querySelectorAll('#agents .agent').length > 0"));
  record('首页单一主要入口，所有高级输入默认收起',await evaluate("!document.getElementById('taskOptions').open && !document.getElementById('collaborationAdvanced').open && !document.getElementById('localDsCard').open && !!document.querySelector('#askQ')"));
  record('原生连接与工具待验证分开显示',await evaluate("/工具能力待验证|电脑操作待验证/.test(document.getElementById('agents').textContent)"),{text:await evaluate("document.getElementById('agents').textContent"),errors});
  if(!reused) {
  const question='新建 '+fileName+'，内容精确为 MEETING AT THREE，不含换行。'+(twoFiles?'另外创建 second_'+fileName+'，内容精确为 SECOND FILE，不含换行。':'')+'不要打开浏览器，不要运行项目代码。完成后读回核验。';
  await evaluate("document.getElementById('askQ').value="+JSON.stringify(question)+";document.getElementById('askQ').dispatchEvent(new Event('input',{bubbles:true}));");
  await until(()=>evaluate("document.getElementById('askRoutePreview').textContent.includes('一位搭档')"));
  record('提交前展示不收费的处理方式预览',true);
  await evaluate("document.getElementById('askBtn').click()");
  await until(()=>evaluate("document.getElementById('detail').textContent.includes('已完成并核验')"));
  } else {await evaluate("selected="+JSON.stringify(reuseId)+";lastKey='';loadDetail(selected)");await until(()=>evaluate("document.getElementById('detail').textContent.includes('已完成并核验')"));}
  const runId=await evaluate('selected');
  if(live)fs.writeFileSync(path.join(output,'live-task.json'),JSON.stringify(await call('beat_get',{id:runId}),null,2));
  record('只输入需求，不设置路径或参数，得到真实文件及成果按钮',fs.readFileSync(path.join(workspace,fileName),'utf8')==='MEETING AT THREE' && (!twoFiles || fs.readFileSync(path.join(workspace,'second_'+fileName),'utf8')==='SECOND FILE') && await evaluate("document.querySelectorAll('#detail .deliverable').length==="+(twoFiles?2:1)+" && document.getElementById('detail').textContent.includes('打开所在文件夹')"),{runId,path:path.join(workspace,fileName)});
  record('过程默认收起，结果与成果显示在前',await evaluate("!document.getElementById('processDetails').open && document.getElementById('detail').textContent.indexOf('成果') < document.getElementById('detail').textContent.indexOf('完整过程')"));
  await evaluate("document.querySelector('[data-preview-path]').click()");
  await until(()=>evaluate("document.getElementById('artifactPreview')?.textContent.includes('MEETING AT THREE')"));
  record('真实文件内容可预览',true);
  fs.writeFileSync(path.join(output,(live?'live-':'')+'dashboard-desktop.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
  await evaluate("document.getElementById('newTaskBtn').click()");
  record('开始新需求不要求手工清空会话号',await evaluate("document.getElementById('askSession').value==='' && document.getElementById('askQ').value===''"));
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await sleep(200);
  const layout=await evaluate("({viewport:innerWidth,width:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>395 && e.getBoundingClientRect().width>0).slice(0,12).map(e=>({tag:e.tagName,id:e.id,class:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right}))})");
  record('窄屏页面没有横向溢出',layout.width<=390 && layout.viewport<=390,layout);
  fs.writeFileSync(path.join(output,(live?'live-':'')+'dashboard-mobile.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
  if(!live){
    await evaluate("(async()=>{await api('beat_agents',{agent:'codex',action:'pause'});await api('beat_agents',{agent:'deepseek',action:'pause'});await refresh();})()");
    record('没有可用搭档时显示连接出口，无需寻找设置文件',await evaluate("!document.getElementById('partnerOnboarding').hidden && !!document.getElementById('connectPartner')"));
  }
  record('页面无未处理脚本异常',errors.length===0,errors);
} catch(error){checks.push({name:'验证中断',ok:false,detail:error.stack});process.exitCode=1;}
finally {
  if(live && ws?.readyState===1) {try{const id=await evaluate('selected');if(id)fs.writeFileSync(path.join(output,'live-task-latest.json'),JSON.stringify(await call('beat_get',{id}),null,2));}catch{}}
  fs.writeFileSync(path.join(output,(live?'live-':'')+'browser-verification.json'),JSON.stringify({mode:live?'live service + actual model accounts + real headless Edge DOM/CDP':'isolated HTTP + real headless Edge DOM/CDP; model adapters are fixtures, not live model proof',checks,errors},null,2));
  if(ws?.readyState===1){try{await cdp('Browser.close');}catch{}ws.close();}
  if(svc && !live){await new Promise(resolve=>svc.server.close(resolve));svc.store.close();}
  console.log(JSON.stringify({checks,errors}));
}
