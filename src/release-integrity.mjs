import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const releaseJobs = [
  ['src', []], ['web', []], ['tests', []], ['scripts', []],
  ['workspaces/shared/desktop-assistant/core', []],
  ['workspaces/shared/desktop-assistant/integration', ['staged','applications']],
  ['workspaces/shared/desktop-assistant/worker', ['data','data-probe']],
  ['workspaces/shared/desktop-assistant/web', []],
  ['workspaces/shared/desktop-assistant/contracts', []],
  ['workspaces/shared/deepseek-sessions-panel', ['tests','tools']],
];
const skip = new Set(['node_modules','.git','__pycache__','.pytest_cache','.beat-control','.beat-attachments','secrets.local.json']);
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export function sourceInventory(root) {
  const files = ['package.json'];
  for (const [dir, exclusions] of releaseJobs) {
    const walk = relative => {
      if (!fs.existsSync(path.join(root,relative))) throw new Error(`发布缺少产品目录：${relative}`);
      for (const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})) {
        if (skip.has(entry.name) || exclusions.includes(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new Error(`发布遇到未核验链接：${relative}/${entry.name}`);
        const file = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(file); else if (entry.isFile()) files.push(file);
      }
    };
    walk(dir);
  }
  return files.sort().map(file=>({path:file,sha256:sha256(fs.readFileSync(path.join(root,file)))}));
}
export function productVersion(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  const code = fs.readFileSync(path.join(root,'src/config.mjs'),'utf8');
  const runtime = code.match(/export const VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (!version || runtime !== version) throw new Error(`发布停止：产品声明 ${version} 与服务代码 ${runtime} 不一致`);
  return version;
}
export function verifyRelease(root, app, {health, manifest} = {}) {
  const version = productVersion(root);
  if (productVersion(app) !== version) throw new Error('发布停止：便携版版本与产品源码不一致');
  if (health && (health.service !== 'beat' || health.version !== version || path.resolve(health.root).toLowerCase() !== path.resolve(root).toLowerCase())) throw new Error('发布停止：当前服务没有运行本次产品源码，先完成后台更新再发布');
  const inventory = sourceInventory(root);
  for (const file of inventory) {
    const target = path.join(app,file.path);
    if (!fs.existsSync(target) || sha256(fs.readFileSync(target)) !== file.sha256) throw new Error(`发布停止：交付文件不一致 ${file.path}`);
  }
  if (manifest && (manifest.version !== version || JSON.stringify(manifest.files) !== JSON.stringify(inventory))) throw new Error('发布停止：发布清单已过期，源码在打包期间发生变化');
  return {version,files:inventory,sourceVerified:true,runtimeVerified:!!health};
}

/** 安装目录仅交换产品代码；数据原位保留，旧代码移入本次发布档案，不删除。 */
export function promotePortable(root, prepared, installed, archive) {
  for (const dir of [prepared,installed,archive]) {
    if (!fs.statSync(dir).isDirectory() || path.resolve(dir).toLowerCase() !== fs.realpathSync(dir).toLowerCase()) throw new Error('发布目录不是已核验的真实目录，未更新便携版');
  }
  verifyRelease(root,path.join(prepared,'app'));
  const staging=path.join(installed,'.release-stage-'+Date.now());
  fs.cpSync(path.join(prepared,'app'),staging,{recursive:true,errorOnExist:true,force:false});
  verifyRelease(root,staging);
  const app=path.join(installed,'app'),backup=path.join(archive,'previous-portable-app');
  if(fs.existsSync(backup))throw new Error('本次发布档案已有旧代码，拒绝覆盖');
  fs.renameSync(app,backup);
  try {fs.renameSync(staging,app);} catch(error) {fs.renameSync(backup,app);throw error;}
  for (const name of ['portable-relocate.mjs','release-manifest.json','BEAT.exe']) {
    const target=path.join(installed,name);
    if(fs.existsSync(target))fs.renameSync(target,path.join(archive,'previous-'+name));
    fs.copyFileSync(path.join(prepared,name),target,fs.constants.COPYFILE_EXCL);
  }
  verifyRelease(root,app);
  return {app,backup,userData:'kept-in-place'};
}

export function mirrorRelease(files, directories, archive) {
  const receipts=[];
  for (const [index,directory] of directories.entries()) {
    fs.mkdirSync(directory,{recursive:true});
    if(path.resolve(directory).toLowerCase()!==fs.realpathSync(directory).toLowerCase())throw new Error('交付目录通过链接指向其他位置，未交换文件');
    const backup=path.join(archive,'previous-delivery-'+index);fs.mkdirSync(backup);
    for (const source of files) {
      const target=path.join(directory,path.basename(source));
      if(fs.existsSync(target))fs.renameSync(target,path.join(backup,path.basename(source)));
      fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
      const hash=sha256(fs.readFileSync(target));
      if(hash!==sha256(fs.readFileSync(source)))throw new Error('交付目录同步内容校验失败');
      receipts.push({path:target,sha256:hash});
    }
  }
  return receipts;
}
