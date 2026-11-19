import {createHash} from 'node:crypto';

// 原生会话的沙箱策略在“创建会话”那一刻固定：DeepSeek Harness（DSH）沿用已有会话时
// 只补充缺失的持久事实，不会改用最新的权限预设（设置变更不影响现有会话）。
// 所以“讨论只读、执行可写”不可能靠同一条原生会话切换：一条只读建起来的会话，执行阶段的
// 写操作会被沙箱直接拒绝（真实证据 R77：write 返回 [sandbox: file access denied under read-only mode]）。
// 因此固定会话按策略分开——只读会话沿用老 key，可写会话用 conversation:<agent>:write，
// 两条都在任务内固定复用：讨论/核验走只读，执行/返工走可写。这不是“静默新建空会话替代旧会话”：
// 只读会话连同它的历史与证据全部保留。
// Codex app-server 在 thread/resume 时重新下发 sandbox（thread/settings/updated），
// dock/API 搭档没有系统沙箱，都继续只用一条会话。
export const conversationKey=(agent,policy)=>'conversation:'+agent+(policy==='write'?':write':'');
export const conversationPolicy=key=>String(key).endsWith(':write')?'write':'read';
export const conversationAgent=key=>String(key).slice('conversation:'.length).replace(/:write$/,'');
function legacySlots(sessions,agent){
  const direct=sessions[agent+':'+agent];
  const rest=Object.entries(sessions).filter(([k,v])=>!k.startsWith('conversation:')&&k.endsWith(':'+agent)&&(v.native||v.history?.length));
  return direct&&(direct.native||direct.history?.length)?[[agent+':'+agent,direct],...rest]:rest;
}
export function fixedConversation(sessions,agent,{id,cwd,policy}={}){
 const key=conversationKey(agent,policy);
 if(!sessions[key]){
  // 老任务恢复：保留旧槽位及证据，选择已有原生会话继续，不创建空替代会话。
  // 但可写角色不能复用一条“没标记策略”的老会话——它可能是只读建起来的，复用等于让执行必被沙箱拒绝；
  // 只有明确记录为可写的老会话才复用，否则新建一条创建时就可写的会话。
  const slots=legacySlots(sessions,agent);
  const writableNative=sessions[conversationKey(agent,'write')]?.native;
  const previous=(policy==='write'?slots.filter(([,v])=>v.policy==='write'||v.access==='workspace-write'):slots.filter(([,v])=>v.policy!=='write'&&v.access!=='workspace-write'&&(!writableNative||v.native!==writableNative)))[0]?.[1]||{};
  sessions[key]={id:(id||'task')+':'+agent+(policy==='write'?':write':''),cwd,native:previous.native||null,history:previous.history||[],seenImages:previous.seenImages||[],model:previous.model||null,recordHashes:[],policy:policy==='write'?'write':'read'};
 }
 const c=sessions[key];if(c.cwd&&cwd&&c.cwd!==cwd)throw Error('固定会话工作目录不一致，不能静默新建会话');
 return c;
}
const recordHash=r=>createHash('sha256').update(JSON.stringify([r.label,r.text])).digest('hex');
export function unseenRecords(records,sessions,agent,policy){
 const seen=new Set(sessions[conversationKey(agent,policy)]?.recordHashes||[]);
 return records.filter(r=>!seen.has(recordHash(r)));
}
export function rememberRecords(records,conversation){
 conversation.recordHashes=[...new Set([...(conversation.recordHashes||[]),...records.map(recordHash)])];
}
