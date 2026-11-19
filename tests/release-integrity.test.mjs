import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tempDir} from './helpers/temp.mjs';
import {sourceInventory,productVersion,verifyRelease,releaseJobs,promotePortable,mirrorRelease} from '../src/release-integrity.mjs';

function fixture() {
  const root=tempDir('release-gate'),source=path.join(root,'source'),app=path.join(root,'app');
  for(const [dir] of releaseJobs)fs.mkdirSync(path.join(source,dir),{recursive:true});
  fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({version:'2.3.0'}));
  fs.writeFileSync(path.join(source,'src/config.mjs'),"export const VERSION = '2.3.0';\n");
  fs.writeFileSync(path.join(source,'web/example.html'),'CURRENT_PRODUCT');
  fs.cpSync(source,app,{recursive:true});
  return {source,app,health:{service:'beat',version:'2.3.0',root:source}};
}
test('发布必须绑定同版本源码、服务和交付文件；同版本内容漂移也拒绝',()=>{
  const f=fixture();const manifest=verifyRelease(f.source,f.app,{health:f.health});assert.equal(manifest.runtimeVerified,true);
  assert.throws(()=>verifyRelease(f.source,f.app,{health:{...f.health,version:'2.2.61'}}),/当前服务/);
  assert.throws(()=>verifyRelease(f.source,f.app,{health:{...f.health,root:f.app}}),/当前服务/);
  fs.writeFileSync(path.join(f.app,'web/example.html'),'STALE_PRODUCT');assert.throws(()=>verifyRelease(f.source,f.app,{health:f.health}),/交付文件不一致/);
  fs.writeFileSync(path.join(f.app,'web/example.html'),'CURRENT_PRODUCT');
  fs.writeFileSync(path.join(f.source,'src/added.mjs'),'new source');fs.writeFileSync(path.join(f.app,'src/added.mjs'),'new source');
  assert.throws(()=>verifyRelease(f.source,f.app,{health:f.health,manifest}),/清单已过期/);
});
test('声明版本不能遮盖服务代码版本；密钥不进入交付清单',()=>{
  const f=fixture();fs.writeFileSync(path.join(f.source,'src/secrets.local.json'),'fixture-private');
  assert.equal(sourceInventory(f.source).some(x=>x.path.includes('secrets.local')),false);
  fs.writeFileSync(path.join(f.source,'src/config.mjs'),"export const VERSION = '2.2.61';");assert.throws(()=>productVersion(f.source),/不一致/);
});

test('更新便携版保存旧代码和用户数据；新代码与源码逐文件一致',()=>{
  const f=fixture(),base=path.dirname(f.source),prepared=path.join(base,'prepared'),installed=path.join(base,'installed'),archive=path.join(base,'archive');
  fs.mkdirSync(prepared);fs.mkdirSync(installed);fs.mkdirSync(archive);fs.cpSync(f.app,path.join(prepared,'app'),{recursive:true});fs.cpSync(f.app,path.join(installed,'app'),{recursive:true});
  fs.writeFileSync(path.join(installed,'app/web/example.html'),'OLD_PRODUCT');
  fs.mkdirSync(path.join(installed,'portable-data'));const data=path.join(installed,'portable-data/customer.json');fs.writeFileSync(data,'CUSTOMER_DATA');
  fs.writeFileSync(path.join(installed,'portable-relocate.mjs'),'OLD_RELOCATE');fs.writeFileSync(path.join(prepared,'portable-relocate.mjs'),'NEW_RELOCATE');fs.writeFileSync(path.join(prepared,'release-manifest.json'),'{}');
  fs.writeFileSync(path.join(installed,'BEAT.exe'),'OLD_EXE');fs.writeFileSync(path.join(prepared,'BEAT.exe'),'NEW_EXE');
  const result=promotePortable(f.source,prepared,installed,archive);
  assert.equal(fs.readFileSync(data,'utf8'),'CUSTOMER_DATA');assert.equal(fs.readFileSync(path.join(result.backup,'web/example.html'),'utf8'),'OLD_PRODUCT');
  assert.equal(fs.readFileSync(path.join(installed,'app/web/example.html'),'utf8'),'CURRENT_PRODUCT');assert.equal(fs.readFileSync(path.join(archive,'previous-portable-relocate.mjs'),'utf8'),'OLD_RELOCATE');
  assert.equal(fs.readFileSync(path.join(installed,'BEAT.exe'),'utf8'),'NEW_EXE');assert.equal(fs.readFileSync(path.join(archive,'previous-BEAT.exe'),'utf8'),'OLD_EXE');
});

test('便携包和EXE交付入口同时同步，旧文件归档保留',()=>{
  const base=tempDir('release-mirrors'),output=path.join(base,'new'),archive=path.join(base,'archive'),directories=[path.join(base,'setup'),path.join(base,'delivery')];fs.mkdirSync(output);fs.mkdirSync(archive);
  const files=['BEAT-Portable.zip','BEAT-Setup-x64.exe'].map(name=>{const file=path.join(output,name);fs.writeFileSync(file,'CURRENT_'+name);return file;});
  for(const dir of directories){fs.mkdirSync(dir);for(const file of files)fs.writeFileSync(path.join(dir,path.basename(file)),'OLD_PRODUCT');}
  const result=mirrorRelease(files,directories,archive);assert.equal(result.length,4);
  for(const [i,dir] of directories.entries())for(const file of files){assert.equal(fs.readFileSync(path.join(dir,path.basename(file)),'utf8'),'CURRENT_'+path.basename(file));assert.equal(fs.readFileSync(path.join(archive,'previous-delivery-'+i,path.basename(file)),'utf8'),'OLD_PRODUCT');}
});
