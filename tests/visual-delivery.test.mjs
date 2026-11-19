import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tempDir } from './helpers/temp.mjs';
import { Roster } from '../src/roster.mjs';
import { renderHtmlEvidence, browserCandidates } from '../src/html-render-verification.mjs';
import { visualAttachments, verificationWaitMessage, imageReadFailure } from '../src/visual-evidence.mjs';
import { failureRecord } from '../src/failure-record.mjs';
import { runCustomerIssue } from '../src/customer-issue.mjs';
import { DesktopAssistant } from '../workspaces/shared/desktop-assistant/core/assistant.mjs';
import { executeDesktopPartner } from '../workspaces/shared/desktop-assistant/integration/partner.mjs';
import { resolveAttachments } from '../src/attachments.mjs';

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');

test('真实SVG和PNG均生成图片输入，覆盖整幅画面并绑定当前源文件哈希', async t => {
  if (!browserCandidates().length) { t.skip('没有浏览器，真实渲染未验证'); return; }
  const cwd = tempDir('visual-delivery');
  const svg = path.join(cwd, 'portrait.svg');
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600"><rect width="1200" height="1600" fill="red"/><circle cx="600" cy="1500" r="80" fill="blue"/></svg>');
  const png = path.join(cwd, 'source.png'); fs.writeFileSync(png, pixel);
  const root = path.join(cwd, 'evidence');
  const evidence = await renderHtmlEvidence({ cwd, task:{acceptance:['图像完整']}, artifacts:[{path:svg},{path:png}], evidenceRoot:root, signal:AbortSignal.timeout(60000) });
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every(item => item.status === 'rendered'), JSON.stringify(evidence));
  const attachments = visualAttachments(evidence, root);
  assert.equal(attachments.length, 2, '每个源文件都必须获得图片，不能被第一份动画的帧挤掉');
  const shot = fs.readFileSync(attachments[0].path);
  assert.equal(shot.readUInt32BE(16), 1200); assert.equal(shot.readUInt32BE(20), 1600);
  fs.appendFileSync(svg, '\n');
  assert.equal(visualAttachments(evidence, root).length, 1, '变化的源文件不能继续用旧图核验');
});

test('Roster到只读适配器到实际模型请求全链传图；同会话重新核验仍发当前图片', async () => {
  const cwd = tempDir('visual-api'), image = path.join(cwd, 'current.png');fs.writeFileSync(image, pixel);
  const config = { workspace:cwd, allowedRoots:[cwd], flow:{}, dock:[{id:'dock:visual',name:'fixture',enabled:true,tools:'supported',vision:true,model:'fixture',baseUrl:'https://example.invalid/v1'}], secrets:{dockKeys:{'dock:visual':'test'}} };
  const seen=[];
  const assistant=new DesktopAssistant({config,dataDir:path.join(cwd,'assistant'),userFolders:{},resolveAttachments:items=>resolveAttachments(config,items),chat:async(_id,args)=>{
    const parts=args.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(part=>part.type==='image_url'):[]);
    assert.ok(parts.length>0,'实际模型消息里必须存在图片本体');
    seen.push(parts.map(part=>part.image_url.url));
    return {text:'{"pass":true,"issues":[]}',actualModel:'fixture',modelVerified:'verified',modelEvidence:{source:'fixture'},usage:{total_tokens:50},toolCalls:[]};
  }});
  const kv=new Map(),store={get:key=>kv.get(key),set:(key,value)=>kv.set(key,value),event:()=>{}};
  const roster=new Roster({config,store,agents:{dockRead:(id,args)=>executeDesktopPartner({config},id,{...args,mode:'observe',executionScope:'workspace',parallelPartner:true},{assistant})}});
  const sessions={};
  for(let round=0;round<2;round++) {
    const result=await roster.call({runId:'visual-test',sessions,seat:'dock:visual',slot:'review',role:'think',cwd,models:{},onlyAgent:true,build:()=> '只读判断本次附图',attachments:[{path:image,name:'current.png',image:true,mime:'image/png'}]});
    const record=result.modelUsage.records.at(-1);
    assert.equal(record.imageInputStatus,'accepted');
    assert.ok(record.imageInputs.some(item=>item.sha256===hash(image)));
    if(round===0)fs.writeFileSync(image,Buffer.concat([pixel,Buffer.from('changed')]));
  }
  assert.equal(seen.length,2);
  assert.ok(seen[1].some(url=>url.endsWith(fs.readFileSync(image).toString('base64'))),'同路径的新内容必须发送');
});

test('图片问题、缺搭档、真实画面不合格分别呈现，不能套同一原因', () => {
  const reason='核验图片尚未准备完整：后台浏览器启动失败';
  assert.match(verificationWaitMessage({issues:[reason]}),/图片尚未准备完整/);
  const issue=runCustomerIssue({kind:'parallel',state:'failed',taskQueue:[{id:'a',state:'verifying',issues:[reason]}]});
  assert.match(issue.message,/后台浏览器启动失败/);assert.doesNotMatch(issue.message,/没有能看图/);
  assert.equal(failureRecord({state:'failed',result:reason}).category,'image_input');
  assert.equal(imageReadFailure({pass:false,issues:['当前可用工具不能读取PNG为可视图像']}),true);
  assert.equal(imageReadFailure({pass:false,issues:['图片中车轮数量为两个，不符合要求']}),false);
});

test('接口明确拒图保留原诊断，并给出拒图原因而不是搭档离线', async () => {
  const cwd=tempDir('image-rejected'), image=path.join(cwd,'input.png');fs.writeFileSync(image,pixel);
  const config={flow:{},dock:[{id:'dock:v',enabled:true,vision:true,model:'fixture',baseUrl:'https://example.invalid/v1'}],secrets:{dockKeys:{'dock:v':'test'}}};
  const kv=new Map(),events=[],store={get:k=>kv.get(k),set:(k,v)=>kv.set(k,v),event:(...args)=>events.push(args)};
  const roster=new Roster({config,store,agents:{dockRead:async()=>{throw Error('HTTP 400 unsupported image_url');}}});
  await assert.rejects(roster.call({runId:'rejected',sessions:{},seat:'dock:v',slot:'review',role:'think',cwd,onlyAgent:true,models:{},build:()=> '核验图片',attachments:[{path:image,image:true,mime:'image/png'}]}),error=>{
    assert.equal(error.code,'IMAGE_INPUT_REJECTED');assert.match(error.message,/接口拒绝/);assert.equal(error.imageInputDiagnostic,'HTTP 400 unsupported image_url');return true;
  });
  assert.doesNotMatch(events.flat().join(' '),/冷却|下线/);
});

test('伪装图片和工作区外的图像不能成为视觉证据', async () => {
  const cwd=tempDir('invalid-image'), file=path.join(cwd,'bad.png');fs.writeFileSync(file,'<html><img src="file:///private.png"></html>');
  const evidence=await renderHtmlEvidence({cwd,task:{acceptance:['图片']},artifacts:[{path:file}],evidenceRoot:path.join(cwd,'evidence'),findBrowsers:()=>[]});
  assert.equal(evidence[0].status,'unverified');assert.match(evidence[0].issue,/内容与图片格式不符/);
  const other=tempDir('outside-image'), frame=path.join(other,'frame.png');fs.writeFileSync(frame,pixel);
  assert.deepEqual(visualAttachments([{file,sha256:hash(file),status:'rendered',imageHashes:[{path:frame,sha256:hash(frame)}]}],cwd),[]);
});
