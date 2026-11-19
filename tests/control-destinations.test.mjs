import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveGoalWorkspace } from '../src/workspace.mjs';
import { artifactsRoot } from './helpers/temp.mjs';
const base=artifactsRoot();fs.mkdirSync(base,{recursive:true});
test('natural destination selects a verified user folder without writing configuration',()=>{
 const root=fs.mkdtempSync(path.join(base,'destination-')),workspace=path.join(root,'workspace'),desktop=path.join(root,'actual-desktop');fs.mkdirSync(workspace);fs.mkdirSync(desktop);
 const config={workspace,allowedRoots:[workspace]};
 assert.equal(resolveGoalWorkspace(config,undefined,'把动画放桌面',{desktop}),fs.realpathSync(desktop));
 // R419 实测：用户说"在我的电脑桌面上新建"，旧规则只认"桌面/我的桌面"，任务目录留在共享目录导致写入失败。
 assert.equal(resolveGoalWorkspace(config,undefined,'在我的电脑桌面上新建一个文本文件',{desktop}),fs.realpathSync(desktop));
 assert.equal(resolveGoalWorkspace(config,undefined,'保存到我的电脑桌面',{desktop}),fs.realpathSync(desktop));
 assert.deepEqual(config.allowedRoots,[workspace]);
 assert.equal(resolveGoalWorkspace(config,undefined,'验证 desktop 操作逻辑，不操作电脑',{desktop}),fs.realpathSync(workspace));
 assert.equal(resolveGoalWorkspace(config,workspace,'保存到桌面',{desktop}),fs.realpathSync(workspace));
 assert.throws(()=>resolveGoalWorkspace(config,undefined,'写到桌面',{}),/无法确认真实桌面/);
 assert.throws(()=>resolveGoalWorkspace(config,path.join(root,'unapproved'),'x',{desktop}),/还没有访问这个文件夹的权限/);
});
