// 客户端：确保服务在跑（没跑就后台拉起），再调用工具。MCP 与命令行共用。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, VERSION } from './config.mjs';
import { outboundProxy, proxyProcessEnv } from './system-proxy.mjs';

export async function ensureService(config = loadConfig()) {
  let expectedVersion=VERSION;
  try{expectedVersion=/export const VERSION\s*=\s*['"]([^'"]+)['"]/.exec(fs.readFileSync(path.join(config.root,'src','config.mjs'),'utf8'))?.[1]||VERSION;}catch{/* packaged clients use their bundled release */}
  const url = `http://127.0.0.1:${config.port}`;
  const check = async () => {
    let h;
    try { h = await (await fetch(url + '/health', { signal: AbortSignal.timeout(1000) })).json(); } catch { return false; }
    if (h.service !== 'beat') throw new Error(`端口 ${config.port} 被其他程序占用：请关闭占用它的程序，或双击 BEAT 启动器（会自动改用空闲端口）。`);
    // 同一个 BEAT 可能由不同启动路径进入：root 或数据目录一致都算本实例；两者都不一致才是别的实例。
    const sameRoot = path.resolve(h.root || '') === path.resolve(config.root);
    const sameData = h.dataRoot && config.dataRoot && path.resolve(h.dataRoot) === path.resolve(config.dataRoot);
    if (!sameRoot && !sameData) throw new Error(`端口 ${config.port} 已被另一个 BEAT 实例占用：请先关闭它，或双击 BEAT 启动器（会自动改用空闲端口）。`);
    if ((h.actualVersion||h.version) !== expectedVersion) {
      // Upgrade idle services automatically; an active writer is never interrupted.
      const invoke=async name=>{const r=await fetch(url+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.secrets.token},body:JSON.stringify({name,args:{},actor:'user',child:false}),signal:AbortSignal.timeout(35000)});const j=await r.json();if(!j.ok)throw new Error(j.error||'服务更新暂未完成');return j.result;};
      const status=await invoke('beat_status');
      if(status.running?.length||status.queued?.length)throw new Error('BEAT 正在完成已有任务，已保留进度；任务结束后再次提交会自动载入新版本，请稍后继续');
      await invoke('shutdown');
      for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));try{await fetch(url+'/health',{signal:AbortSignal.timeout(300)});}catch{return false;}}
      throw new Error('BEAT 正在完成后台更新，已保留任务和文件，请稍后继续');
    }
    return true;
  };
  if (await check()) return url;
  const logs = path.join(config.dataDir, 'logs'); fs.mkdirSync(logs, { recursive: true });
  const fd = fs.openSync(path.join(logs, 'service.log'), 'a');
  // 客户开着系统代理时（Clash/V2Ray…），模型端点也必须走代理：浏览器能访问、Node 直连会被墙。
  // 代理没在监听时为 null，服务照旧直连。Node 的 env proxy 只在进程启动时读，所以必须在 spawn 时带上。
  const proxy = await outboundProxy();
  const child = spawn(process.execPath, [path.join(config.root, 'src', 'service.mjs')], { cwd: config.root, detached: true, windowsHide: true, env: proxyProcessEnv(proxy), stdio: ['ignore', fd, fd] });
  let spawnError; child.on('error', e => { spawnError = e; }); child.unref(); fs.closeSync(fd);
  for (let i = 0; i < 50; i++) {
    if (spawnError) throw spawnError;
    await new Promise(r => setTimeout(r, 200));
    if (await check()) return url;
  }
  throw new Error('BEAT 服务没能启动，请看 data/logs/service.log');
}

// 接口错误只给客户能执行的动作；dismiss 是看板按钮，不是接口动作。
export function customerIssueText(issue) {
  const actuatorLabels = [...(issue?.actions || [])].filter(action => action && action.id !== 'dismiss').map(action => action.label).join(' / ');
  const details = [issue?.title, issue?.message, issue?.fileStatus, issue?.costStatus,
    issue?.permission ? `请打开 BEAT 看板点击文件夹授权，或运行 node src/cli.mjs folders add "${issue.permission.path || '<目录>'}" 后继续。` : actuatorLabels].filter(Boolean);
  return details.join('\n');
}

export async function call(name, args = {}, { config = loadConfig(), actor = 'user', child = !!process.env.BEAT_CHILD, url } = {}) {
  url ||= await ensureService(config);
  const wait = Math.min(Number(args.wait_seconds ?? (name === 'beat_ask' ? 240 : 0)) || 0, 280);
  const r = await fetch(url + '/api/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.secrets.token },
    body: JSON.stringify({ name, args, actor, child }), signal: AbortSignal.timeout((wait + (name === 'claude_test' ? 200 : 60)) * 1000),
  });
  const data = await r.json();
  if (!data.ok) {
    const issue=data.customerIssue;
    const message=issue?customerIssueText(issue):(data.error||`HTTP ${r.status}`);
    throw Object.assign(new Error(message),{customerIssue:issue,diagnostic:data.error});
  }
  return data.result;
}
