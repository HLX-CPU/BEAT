import { dispatchDesktopCall, isAuthenticatedPageSession } from '../workspaces/shared/desktop-assistant/core/page-session.mjs';
import { hash as desktopHash } from '../workspaces/shared/desktop-assistant/core/security.mjs';
// BEAT 服务：本机 HTTP（127.0.0.1），提供看板页面和 /api/call。由看板启动器或 MCP 按需自动拉起。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig, redact, VERSION } from './config.mjs';
import { Store } from './store.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { TOOLS, SPAWNING } from './tools.mjs';
import { askCodex } from './codex.mjs';
import { askDeepseek } from './deepseek.mjs';
import { askZcode, detectZcodeRuntime } from './zcode.mjs';
import { nativeAvailability } from './native-runtime.mjs';

import { askClaude } from './claude.mjs';
import { saveUpload, saveFolderUpload, maxUploadBytes } from './attachments.mjs';
import { askDock, chatDock } from './dock.mjs';
import { executeDesktopPartner } from '../workspaces/shared/desktop-assistant/integration/partner.mjs';
import { getDesktopAssistant } from '../workspaces/shared/desktop-assistant/integration/runtime.mjs';
import { registerAgentNames } from './prompts.mjs';
import { runChecks } from './checks.mjs';
import { resolveWorkspace } from './workspace.mjs';
import { WorkspaceAccessRequests, withWorkspaceGrant } from './workspace-access.mjs';
import { customerIssue } from './customer-issue.mjs';
import { wantsAction } from './quick-work.mjs';
import { watchSystemProxy } from './system-proxy.mjs';
import { beatAgentCard, partnerCards, partnerCard, toA2ATask, a2aRpc, A2A_PROTOCOL_VERSION } from './a2a.mjs';
import { cleanupStorage } from './storage-lifecycle.mjs';

// Only transport/input validation carries this marker. Errors from a tool may
// happen after model calls or writes and must retain an unknown-effects status.
class RequestInputError extends Error {}
export function validateCallInput(payload) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(payload)) throw new RequestInputError('请求内容不完整，请重新提交操作。');
  const { name, args = {}, actor = 'user', child = false } = payload;
  if (typeof name !== 'string' || !name.trim()) throw new RequestInputError('请求缺少要执行的操作，请重新提交。');
  if (!Object.hasOwn(TOOLS, name)) throw new RequestInputError('这个操作暂不支持，请回到看板选择可用的操作。');
  if (!object(args) || typeof actor !== 'string' || !actor.trim() || typeof child !== 'boolean') throw new RequestInputError('请求内容格式不正确，请重新提交操作。');
  const validate = (value, schema, label, key) => {
    if (!schema) return;
    const matches = type => type === 'object' ? object(value) : type === 'array' ? Array.isArray(value)
      : type === 'null' ? value === null : type === 'integer' ? Number.isInteger(value) : !type || typeof value === type;
    const valid = Array.isArray(schema.type) ? schema.type.some(matches) : matches(schema.type);
    if (!valid) throw new RequestInputError(`${label}填写不正确，请检查后重新提交。`);
    const fieldName = key || label;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new RequestInputError(`参数 ${fieldName} 的取值不正确；只能填 ${schema.enum.join(' / ')}。请修改后重新提交。`);
    if (typeof value === 'number') {
      if (Number.isFinite(schema.minimum) && value < schema.minimum) throw new RequestInputError(`参数 ${fieldName} 不能小于 ${schema.minimum}，请修改后重新提交。`);
      if (Number.isFinite(schema.maximum) && value > schema.maximum) throw new RequestInputError(`参数 ${fieldName} 不能大于 ${schema.maximum}，请修改后重新提交。`);
    }
    if (object(value)) {
      for (const key of schema.required || []) if (value[key] === undefined || value[key] === null || (typeof value[key] === 'string' && !value[key].trim())) throw new RequestInputError(`请求缺少必填内容（${schema.properties?.[key]?.description || key}），请补全后重新提交。`);
      // Existing callers use null for unset optional values; retain that
      // contract while rejecting null for required values above.
      for (const [key, field] of Object.entries(schema.properties || {})) if (value[key] !== undefined && value[key] !== null) validate(value[key], field, field.description || key, key);
    }
    if (schema.type === 'array' && schema.items) for (const item of value) validate(item, schema.items, label, key);
  };
  validate(args, TOOLS[name].schema, '请求内容');
  return { name, args, actor, child };
}

export function realAgents(getConfig) {
  return {
    nativeAvailability: agent => nativeAvailability(getConfig(), agent),
    // Conservative native-prefix estimates, including tools and cached input.
    // Admission estimates stay separate from measured provider billing.
    // ZCode 会话上下文窗口 200k，前缀地板给得更宽。
    nativeContextTokens: {codex:32768,deepseek:12288,zcode:65536},
    codex: o => askCodex(getConfig(), o),
    deepseek: o => askDeepseek(getConfig(), o),
    zcode: o => askZcode(getConfig(), o),
    claude: o => askClaude(getConfig(), o),
    dock: (id, o) => askDock(getConfig(), id, o),
  };
}

export async function startServer({ config = loadConfig(), agents, models, port = config.port } = {}) {
  let cfg = config;
  let desktopEntryHash = null;
  try { desktopEntryHash = desktopHash(fs.readFileSync(path.join(cfg.root, 'src', 'tools.mjs'))); } catch { desktopEntryHash = null; }
  registerAgentNames(cfg.dock, cfg.claude?.name);
  const store = new Store(path.join(cfg.dataDir, 'beat.sqlite'));
  let orch;
  try { orch = new Orchestrator({ config: cfg, store, agents: agents || realAgents(() => cfg), models }); }
  catch (e) { store.close(); throw e; }
  if(!agents)orch.agents.desktopDock=(id,args)=>executeDesktopPartner(orch,id,args,{chatDock});
  if(!agents)orch.agents.dockRead=(id,args)=>executeDesktopPartner(orch,id,{...args,mode:'observe',executionScope:'workspace',parallelPartner:true},{chatDock});
  if(!agents)orch.agents.nativeEvidence=async contextId=>{const a=getDesktopAssistant(orch,chatDock),t=[...a.tasks.values()].find(t=>t.contextId===contextId);if(t)await a.finishSharedContext(t);return t?a.view(t):null;};
  if(!agents)orch.runChecks=(cwd,checks,options)=>runChecks(cwd,checks,{...options,strict:true,registeredCheck:(args,context)=>getDesktopAssistant(orch,chatDock).runRegisteredCheck(args,context)});
  const accessRequests = new WorkspaceAccessRequests(cfg);
  let network=null;
  const svc = {
    workspaceAccessRequests:()=>accessRequests.list(),
    reload(c) { cfg = c; accessRequests.config=c; registerAgentNames(c.dock, c.claude?.name); orch.setConfig(c); },
    exit() { server.close(); store.close(); process.exit(0); },
  };
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const authorized = h => { const a = Buffer.from(h || ''), b = Buffer.from('Bearer ' + cfg.secrets.token); return a.length === b.length && timingSafeEqual(a, b); };
  const stripUiOnlyActions = issue => {
    if (issue?.actions) issue.actions = issue.actions.filter(action => action && action.id !== 'dismiss');
    return issue;
  };
  const invoke = async ({name,args,actor,child,pageSession}) => {
    if(network && (SPAWNING.has(name) || ['dock_test','claude_test','beat_resume','beat_followup','repair_run_files','beat_budget_continue'].includes(name))) await network.refresh();
    const tool=TOOLS[name];
    if(!tool)throw new Error('未知工具：'+name);
    if(child && SPAWNING.has(name))throw new Error('子任务不能再派发任务，请完成当前工作。');
    if(name==='beat_budget_continue' && (!pageSession || actor!=='user' || child)) throw new Error('增加预算需要客户在看板确认，模型不能自行增加用量');
    if(name==='beat_release' && (child || !((pageSession && actor==='user') || (actor==='user' && args.cli===true)))) throw new Error('解除隔离需要客户本人确认（看板按钮或命令行 node src/cli.mjs release <任务号>），模型不能自行放行未知操作');
    if(name==='storage_cleanup' && (!pageSession || actor!=='user' || child)) throw new Error('清理本地数据需要客户在看板确认，模型不能自行删除。');
    if(name==='run_rollback' && (!pageSession || actor!=='user' || child)) throw new Error('撤销文件改动需要客户在看板确认，模型不能自行回滚。');
    if(name==='open_data_folder' && (!pageSession || actor!=='user' || child)) throw new Error('请在看板中点击打开数据文件夹。');
    for(const k of tool.schema.required||[])if(args[k]===undefined||args[k]==='')throw new Error('缺少参数 '+k);
    if(name==='workspace_access_grant'){
      if(!pageSession||actor!=='user'||child)throw new Error('请在 BEAT 看板中点击文件夹授权按钮，模型不能自行授权。');
      const grant=accessRequests.consume(args.requestId,args.decision);
      if(!grant)return {ok:true,result:{cancelled:true}};
      const reply=await withWorkspaceGrant(grant,()=>invoke({name:grant.operation,args:grant.args,actor:grant.actor,child:grant.child,pageSession:false}));
      if(!reply.ok)return reply;
      return {ok:true,result:{result:reply.result}};
    }
    let folder,access;
    const work = a=>a.access==='workspace-write'||(a.access!=='read-only'&&wantsAction(a.question||''));
    if(name==='beat_discuss'){folder=args.cwd||cfg.workspace;access='read-only';}
    if(name==='beat_parallel'){folder=args.cwd||cfg.workspace;access='workspace-write';}
    if(name==='beat_ask'){folder=args.session_id?orch.store.session(args.session_id)?.cwd:(args.cwd||cfg.workspace);access=work(args)?'workspace-write':'read-only';}
    if(name==='beat_followup'||name==='beat_resume'||name==='beat_budget_continue'||name==='repair_run_files'){
      const r=orch.store.run(args.id);folder=r?.cwd;
      access=name==='beat_followup'?(work(args)?'workspace-write':'read-only'):(r?.kind==='discuss'||r?.access==='read-only'?'read-only':'workspace-write');
    }
    if(folder)try{resolveWorkspace(cfg,folder,{access,checkOnly:true});}catch(e){
      if(!e.permissionFolder)throw e;
      const permission=accessRequests.request({folder:e.permissionFolder,access,operation:name,args,actor,child});
      return {ok:false,error:e.message,customerIssue:{...customerIssue(e,{beforeDispatch:true}),title:'需要文件夹访问权限',message:e.message+'。可以看板授权，或运行 node src/cli.mjs folders add "'+e.permissionFolder+'"',permission,actions:[]}};
    }
    if(name==='inspect_run_files'&&(!pageSession||actor!=='user'||child))throw new Error('请在看板中点击查看现有文件。');
    return dispatchDesktopCall({name,args,actor,svc,pageSession,run:(a,act,s2)=>tool.run(orch,a,act,{...s2,workspaceHuman:pageSession&&actor==='user'&&!child})});
  };

  const server = http.createServer(async (req, res) => {
    const actualPort = server.address()?.port || port;
    const local = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (!local.includes(req.headers.host)) return json(res, 403, { error: 'Host rejected' });
    if (req.headers.origin && !local.map(h => 'http://' + h).includes(req.headers.origin)) return json(res, 403, { error: 'Origin rejected' });
    // version 是产品版本，跟随 src/config.mjs 的 VERSION（package.json 也按它同步）。
    // apiCompatibilityVersion 是 HTTP/MCP 线上接口的兼容级别，不等于产品版本：已运行的 2.1 客户端
    // 可以直接复用同一个服务，所以它不随产品版本变动；actualVersion 保留给老客户端读取发布版本。
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { service: 'beat', version: VERSION, apiCompatibilityVersion:'2.1.0',actualVersion:VERSION,root: cfg.root, dataRoot: cfg.dataRoot,
    // 启动器用 root/dataRoot 判断"端口上是不是本实例"：同一数据目录就是同一个 BEAT（junction/短路径也不会误判成别人）。
    desktopEntry: 'desktop-assistant-v1', desktopEntryHash, desktopTools: Object.keys(TOOLS).filter(n=>n.startsWith('desktop_')) });
    const pathname = String(req.url || '').split('?')[0];   // 允许 ?v=… 版本参数（浏览器换模块靠它强制刷新）
    // A2A 兼容层（借鉴 a2aproject/A2A）：先暴露"可被发现"的 Agent Card 与只读任务查询。
    // 这是只读协议入口，不在这里创建任务；创建仍走看板/MCP，避免绕过审核与权限。
    const a2aBase = 'http://127.0.0.1:' + actualPort;
    if (req.method === 'GET' && (pathname === '/.well-known/agent.json' || pathname === '/a2a/agent-card')) {
      return json(res, 200, beatAgentCard({ baseUrl: a2aBase }));
    }
    if (req.method === 'GET' && pathname === '/a2a/partners') {
      if (!authorized(req.headers.authorization)) return json(res, 401, { error: '需要本地访问令牌' });
      const ids = ['codex','deepseek','zcode','claude', ...(cfg.dock || []).map(item => item.id)];
      const partners = ids.map(id => {
        const dock = (cfg.dock || []).find(item => item.id === id);
        const model = id === 'codex' ? cfg.codex?.defaultModel : id === 'deepseek' ? cfg.deepseek?.defaultModel : id === 'zcode' ? cfg.zcode?.defaultModel : id === 'claude' ? cfg.claude?.model : dock?.model;
        const name = id === 'codex' ? 'Codex' : id === 'deepseek' ? 'DeepSeek' : id === 'zcode' ? 'ZCode' : id === 'claude' ? (cfg.claude?.name || 'Claude') : dock?.name;
        return { id, name, model, status: orch.roster.state(id)?.status || 'unknown' };
      });
      return json(res, 200, { kind: 'partners', protocolVersion: A2A_PROTOCOL_VERSION, partners: partnerCards({ baseUrl: a2aBase, partners }) });
    }
    if (req.method === 'GET' && pathname.startsWith('/a2a/partners/')) {
      if (!authorized(req.headers.authorization)) return json(res, 401, { error: '需要本地访问令牌' });
      let id = ''; try { id = decodeURIComponent(pathname.slice('/a2a/partners/'.length)); } catch { id = ''; }
      const dock = (cfg.dock || []).find(item => item.id === id);
      const known = ['codex','deepseek','zcode','claude'].includes(id) || Boolean(dock);
      if (!known) return json(res, 404, { error: '未知搭档' });
      const model = id === 'codex' ? cfg.codex?.defaultModel : id === 'deepseek' ? cfg.deepseek?.defaultModel : id === 'zcode' ? cfg.zcode?.defaultModel : id === 'claude' ? cfg.claude?.model : dock?.model;
      const name = id === 'codex' ? 'Codex' : id === 'deepseek' ? 'DeepSeek' : id === 'zcode' ? 'ZCode' : id === 'claude' ? (cfg.claude?.name || 'Claude') : dock?.name;
      return json(res, 200, partnerCard(id, { name, model, status: orch.roster.state(id)?.status || 'unknown', baseUrl: a2aBase }));
    }
    if (req.method === 'GET' && pathname.startsWith('/a2a/tasks/')) {
      if (!authorized(req.headers.authorization)) return json(res, 401, { error: '需要本地访问令牌' });
      let id = ''; try { id = decodeURIComponent(pathname.slice('/a2a/tasks/'.length)); } catch { id = ''; }
      let view; try { view = orch.view(id); } catch { view = null; }
      if (!view) return json(res, 404, { error: '找不到任务：' + id });
      return json(res, 200, toA2ATask(view, { baseUrl: a2aBase }));
    }
    if (req.method === 'POST' && pathname === '/a2a') {
      if (!authorized(req.headers.authorization)) return json(res, 401, { error: '需要本地访问令牌' });
      try {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 200000) throw new Error('A2A 请求太长'); }
        let payload = {}; try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
        const taskFor = id => { try { return toA2ATask(orch.view(id), { baseUrl: a2aBase }); } catch { return null; } };
        return json(res, 200, a2aRpc(payload, { card: beatAgentCard({ baseUrl: a2aBase }), taskFor }));
      } catch (error) { return json(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: redact(error.message, cfg) } }); }
    }
    if (req.method === 'GET' && ['/desktop-assistant.mjs','/desktop-state.mjs'].includes(pathname)) {
      try { const script=fs.readFileSync(path.join(cfg.root,'workspaces/shared/desktop-assistant/web',pathname.slice(1))); res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); return res.end(script); } catch { return json(res,404,{error:'Desktop module unavailable'}); }
    }
    if (req.method === 'GET' && req.url === '/sessions-panel.mjs') {
      try {
        const script = fs.readFileSync(path.join(cfg.root, 'web', 'sessions-panel.mjs'));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(script);
      } catch (e) { return json(res, 404, { error: 'sessions-panel.mjs 未就绪：' + e.code }); }
    }
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      const html = fs.readFileSync(path.join(cfg.root, 'web', 'index.html'), 'utf8').replace('__BEAT_TOKEN__', JSON.stringify(cfg.secrets.token));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'" });
      return res.end(html);
    }
    // 上传附件：原始字节流，文件名放在 X-File-Name（encodeURIComponent 编码）。返回上传号 F-…，再作为 attachments 传给任务。
    if (req.method === 'POST' && req.url === '/api/upload') {
      if (!authorized(req.headers.authorization)) return json(res, 401, { error: '需要本地访问令牌' });
      const declared = Number(req.headers['content-length'] || 0);
      const cap = maxUploadBytes(cfg);
      if (declared > cap) return json(res, 200, { ok: false, error: `文件超过 ${Math.round(cap / 1048576)} MB 上限（要更大就改 config.json 的 maxUploadMb）` });
      try {
        let name; try { name = decodeURIComponent(req.headers['x-file-name'] || 'file'); } catch { name = 'file'; }
        return json(res, 200, { ok: true, result: await saveUpload(cfg, name, req) });
      } catch (e) { req.resume(); return json(res, 200, { ok: false, error: redact(e.message, cfg) }); }
    }
    // 上传文件夹：保留目录结构，落成一个"文件夹附件"（客户要求：拖文件夹不能被拆成一堆文件）。
    // 请求体=原始字节流（浏览器打包的 tar），相对路径清单放在 X-Folder-Manifest（和 tar 条目顺序一致）。
    // 浏览器沙箱拿不到本机绝对路径，所以只能传内容；服务端按清单还原目录树。
    if (req.method === 'POST' && req.url === '/api/upload-folder') {
      if (!authorized(req.headers.authorization)) return json(res, 401, { error: '需要本地访问令牌' });
      try {
        let name = 'folder', manifest = [];
        // 两个头都是 encodeURIComponent 过来的（文件名与相对路径里可能有中文/空格/斜杠），必须解码。
        // 这里曾经漏掉解码 → JSON.parse 直接吃 %5B…，拖文件夹永远报"文件夹是空的（没有可上传的文件）"。
        try { name = decodeURIComponent(req.headers['x-folder-name'] || 'folder'); } catch { name = 'folder'; }
        try {
          const rawManifest = String(req.headers['x-folder-manifest'] || '[]');
          let decoded = rawManifest;
          try { decoded = decodeURIComponent(rawManifest); } catch { decoded = rawManifest; }   // 已解码的也兼容
          manifest = JSON.parse(decoded);
        } catch { manifest = []; }
        const declared = Number(req.headers['content-length'] || 0);
        const cap = maxUploadBytes(cfg) * 20;   // 文件夹按"单个文件上限 ×20"给总量，避免一个文件夹塞爆磁盘
        if (declared > cap) return json(res, 200, { ok: false, error: `文件夹超过 ${Math.round(cap / 1048576)} MB 上限` });
        return json(res, 200, { ok: true, result: await saveFolderUpload(cfg, name, manifest, req) });
      } catch (e) { req.resume(); return json(res, 200, { ok: false, error: redact(e.message, cfg) }); }
    }
    if (req.method !== 'POST' || req.url !== '/api/call') return json(res, 404, { error: '未知路径' });
    if (!authorized(req.headers.authorization)) return json(res, 401, { error: '需要本地访问令牌' });
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 500000) throw new RequestInputError('提交的内容太长，请减少内容后重新提交。'); }
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch { throw new RequestInputError('请求内容没能正确读取，请重新提交操作。'); }
      const { name, args, actor, child } = validateCallInput(payload);
      const pageSession = isAuthenticatedPageSession(req,{port:actualPort});
      const reply=await invoke({name,args,actor,child,pageSession});
      if(reply.ok===false&&!reply.customerIssue)reply.customerIssue=customerIssue(reply.error);
      // 接口/MCP 调用没有看板按钮：不要把“关闭提示”这类 UI 动作混进返回。
      if(!pageSession)stripUiOnlyActions(reply.customerIssue);
      json(res, 200, reply);
    } catch (e) { const issue=customerIssue(Object.assign(new Error(redact(e.message,cfg)),{code:e.code,notDispatched:e.notDispatched,previousRuns:e.previousRuns}),{beforeDispatch:e instanceof RequestInputError}); if(!isAuthenticatedPageSession(req,{port:actualPort}))stripUiOnlyActions(issue); json(res, 200, { ok: false, error: redact(e.message, cfg),customerIssue:issue }); }
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { store.close(); throw error; }
  // A duplicate startup must never mark the live service's tasks interrupted.
  // Recover only after this process owns the listening port.
  store.recover();
  // 存储生命周期：启动后自动清掉超过保留期的报告/日志/临时文件/浏览器缓存和旧上传副本；
  // 只删可重新生成的缓存，任务成果、数据库、设置和最近数据不动。
  setTimeout(() => { try { const cleaned = cleanupStorage(cfg); if (cleaned.freedBytes > 0) store.event(null, 'storage', `已自动清理 ${(cleaned.freedBytes / 1048576).toFixed(1)} MB 旧数据（${cleaned.deletedFiles} 个文件）；任务成果和数据库保留`); } catch { /* 清理失败不影响服务 */ } }, 1000).unref?.();
  if(!agents) {
    network=watchSystemProxy({isIdle:()=>orch.active.size===0&&orch.queue.length===0,onError:error=>store.event(null,'network',error.message)});
    await network.refresh();
    server.once('close',()=>network.stop());
    queueMicrotask(()=>orch.recoverDiscussions());
  }
  return { server, store, orch, port: server.address().port };
}
