import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { openWithDefaultApp } from '../src/reveal.mjs';
function transport(receipt, {code=0,error=false,hang=false}={}) {
 const calls=[];
 const spawnProcess=(command,args,options)=>{
  calls.push({command,args,options});
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  if(!hang) queueMicrotask(()=>{if(error) child.emit('error',new Error('denied'));else {child.stdout.end(JSON.stringify(receipt));child.emit('close',code);}});
  return child;
 };
 return {calls,spawnProcess};
}
test('打开请求通过独立系统接口传原始路径；清除 Electron 变量，等待可见回执',async()=>{
 const previous=process.env.ELECTRON_RUN_AS_NODE;process.env.ELECTRON_RUN_AS_NODE='1';
 try {
  const t=transport({status:'verified',window:{visible:true,hwnd:42}});
  const file='E:\\beat\\中文 & 空格\\a.svg';
  const result=await openWithDefaultApp(file,{reveal:true,spawnProcess:t.spawnProcess});
  assert.equal(result.verified,true);assert.equal(result.via,'explorer-select');
  assert.equal(t.calls[0].options.env.BEAT_OPEN_PATH,file);
  assert.equal(t.calls[0].options.env.BEAT_OPEN_MODE,'reveal');
  assert.equal(t.calls[0].options.env.ELECTRON_RUN_AS_NODE,undefined);
  assert.ok(!t.calls[0].args.includes(file));assert.equal(t.calls[0].command,'powershell.exe');
 }finally{if(previous===undefined)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=previous;}
});
test('文件夹打开模式和文件定位模式区分',async()=>{
 const t=transport({status:'verified',window:{visible:true}});
 assert.equal((await openWithDefaultApp('E:\\beat',{isDirectory:true,reveal:true,spawnProcess:t.spawnProcess})).via,'explorer-open');
 assert.equal(t.calls[0].options.env.BEAT_OPEN_MODE,'folder');
});
test('系统接受请求不等于窗口显示',async()=>{
 const t=transport({status:'requested'});
 assert.equal((await openWithDefaultApp('E:\\beat\\a.svg',{spawnProcess:t.spawnProcess})).verified,false);
});
test('启动错误、退出失败、伪造隐藏回执和超时不能报告成功',async()=>{
 for(const options of [{error:true},{code:1}]) {
  const t=transport({},options);await assert.rejects(openWithDefaultApp('E:\\beat\\a.svg',{reveal:true,spawnProcess:t.spawnProcess}),/系统未能/);
 }
 const invalid=transport({status:'verified',window:{visible:false}});
 await assert.rejects(openWithDefaultApp('E:\\beat\\a.svg',{reveal:true,spawnProcess:invalid.spawnProcess}),/可靠/);
 const hanging=transport(null,{hang:true});
 await assert.rejects(openWithDefaultApp('E:\\beat\\a.svg',{reveal:true,spawnProcess:hanging.spawnProcess,timeoutMs:10}),/超时/);
});
