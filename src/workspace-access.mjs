import fs from 'node:fs';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
const context = new AsyncLocalStorage();
const canon = p => {
  const resolved = fs.realpathSync(path.resolve(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const within = (a,b) => { const r=path.relative(a,b);return r==='' || (!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r)); };
const readFile = config => path.join(config.dataDir,'workspace-access.json');
export function workspaceGrantAllows(config, folder, access) {
  let requested;try{requested=canon(folder);}catch(e){if(e.code==='ENOENT')return false;throw e;}const grant=context.getStore();
  if(grant && (grant.access==='workspace-write'||access==='read-only') && within(grant.path,requested))return true;
  let saved=[];try{saved=JSON.parse(fs.readFileSync(readFile(config),'utf8'));}catch{}
  return Array.isArray(saved) && saved.some(g=>{
    if(!g || (g.access!=='workspace-write' && access!=='read-only'))return false;
    try{return canon(g.path)===g.canonical && within(g.canonical,requested);}catch{return false;}
  });
}
export function withWorkspaceGrant(grant, run) {return context.run(grant,run);}
export class WorkspaceAccessRequests {
  constructor(config){this.config=config;this.pending=new Map();}
  list(){for(const [id,r] of this.pending)if(r.expires<Date.now())this.pending.delete(id);return [...this.pending.values()].map(r=>({requestId:r.id,path:r.displayPath,access:r.access}));}
  request({folder,access,operation,args,actor,child}) {
    this.list();
    if(!fs.statSync(folder).isDirectory())throw new Error('没有找到这个文件夹，请重新选择文件夹。');
    const real=canon(folder),id=randomUUID();
    this.pending.set(id,{id,path:real,displayPath:path.resolve(folder),access,operation,args:structuredClone(args),actor,child,expires:Date.now()+10*60*1000});
    return {requestId:id,path:path.resolve(folder),access};
  }
  consume(id,decision){
    const req=this.pending.get(id);
    if(!req || req.expires<Date.now())throw new Error('这次文件夹授权已过期或已经处理，请重新提交任务。');
    if(!['once','always','cancel'].includes(decision))throw new Error('请选择本次允许、以后允许或取消。');
    if(canon(req.displayPath)!==req.path)throw new Error('文件夹位置发生变化，未授权，请重新选择。');
    this.pending.delete(id); // Remove before any await: one request cannot dispatch twice.
    if(decision==='cancel')return null;
    if(decision==='always'){
      const file=readFile(this.config);let entries=[];
      try{entries=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('已有授权记录无法读取，未覆盖，请稍后重试。');}
      if(!Array.isArray(entries))throw new Error('已有授权记录格式不正确，未覆盖。');
      const row={path:req.displayPath,canonical:req.path,access:req.access,grantedAt:new Date().toISOString()};
      entries.push(row);fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.pending';fs.writeFileSync(temp,JSON.stringify(entries,null,2)+'\n',{flag:'wx'});fs.renameSync(temp,file);
    }
    return req;
  }
}

// 命令行授权（人执行的命令，不是模型自行授权）：与看板“以后允许”写同一份记录。
export function listWorkspaceGrants(config) {
  try {
    const entries = JSON.parse(fs.readFileSync(readFile(config), 'utf8'));
    return Array.isArray(entries) ? entries.map(entry => ({ path: entry.path, access: entry.access, grantedAt: entry.grantedAt || null })) : [];
  } catch (error) { if (error.code === 'ENOENT') return []; throw new Error('授权记录无法读取：' + error.message); }
}
export function addWorkspaceGrant(config, folder, access = 'workspace-write') {
  if (!folder || typeof folder !== 'string') throw new Error('请写要授权的文件夹路径');
  if (access !== 'workspace-write' && access !== 'read-only') throw new Error('授权方式只能是 workspace-write 或 read-only');
  let real, stat;
  try { stat = fs.statSync(folder); real = canon(folder); } catch (error) { throw new Error('没有找到这个文件夹：' + folder); }
  if (!stat.isDirectory()) throw new Error('这不是文件夹：' + folder);
  const file = readFile(config);
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('已有授权记录无法读取，未覆盖：' + error.message); }
  if (!Array.isArray(entries)) throw new Error('已有授权记录格式不正确，未覆盖');
  const exists = entries.some(entry => entry && entry.canonical === real);
  if (!exists) {
    entries.push({ path: path.resolve(folder), canonical: real, access, grantedAt: new Date().toISOString(), source: 'cli' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID() + '.pending';
    fs.writeFileSync(temp, JSON.stringify(entries, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temp, file);
  }
  return { path: path.resolve(folder), canonical: real, access, added: !exists };
}
export function removeWorkspaceGrant(config, folder) {
  if (!folder || typeof folder !== 'string') throw new Error('请写要取消授权的文件夹路径');
  const file = readFile(config);
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { removed: 0 }; throw new Error('授权记录无法读取：' + error.message); }
  if (!Array.isArray(entries)) throw new Error('授权记录格式不正确，未修改');
  let real = null;
  try { real = canon(folder); } catch { /* 文件夹已经不存在时按保存的路径匹配 */ }
  const before = entries.length;
  const kept = entries.filter(entry => !(entry && (entry.canonical === real || (() => { try { return canon(entry.path) === real; } catch { return path.resolve(entry.path) === path.resolve(folder); } })())));
  if (kept.length !== before) {
    const temp = file + '.' + randomUUID() + '.pending';
    fs.writeFileSync(temp, JSON.stringify(kept, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temp, file);
  }
  return { removed: before - kept.length };
}
