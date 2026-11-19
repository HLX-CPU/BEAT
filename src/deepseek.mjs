// DeepSeek 执行端：以 ELECTRON_RUN_AS_NODE 拉起 DeepSeek Harness 的 headless（无窗口，答完即退）。
// 模型/推理强度读取桌面端当前选择；续问用 --session-id 落在同一个原生会话里。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { redact } from './config.mjs';
import { killTree, onLines, abortError } from './proc.mjs';
import { readNativeRows, nativeModelEvidence } from './deepseek-evidence.mjs';
import { syncDeepseekSession } from './desktop-sync.mjs';
import { resolveDeepseekRuntime } from './native-runtime.mjs';
import { buildNativeToolEvidence, sealNativeToolTrace } from './native-evidence.mjs';

export function deepseekProfileFile() { return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop', 'cordis.patch.yml'); }
export function configuredDeepseekProfileFile(config) { return config.deepseek?.profileFile || (config.deepseek?.home ? path.join(config.deepseek.home, 'profiles', 'desktop', 'cordis.patch.yml') : deepseekProfileFile()); }

// 客户看到的永远是「下一步怎么做」，不出现 profile/路径这类内部说法；路径只留在 detail 里给支持排查。
function deepseekNotReady(detail, action) {
  const e = new Error('DeepSeek 桌面端还没有准备好：' + action);
  e.deepseekNotReady = true;
  e.detail = detail;
  return e;
}
export function deepseekProfile(file = deepseekProfileFile()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { throw deepseekNotReady('读取不到 DeepSeek 登录配置：' + file, '先打开 DeepSeek Harness 登录一次（之后不用保持运行），再重新开始；也可以改用「拓展坞」接入 DeepSeek API 当搭档。'); }
  const section = text.match(/- id: agent-default-model\s*\n([\s\S]*?)(?=\n- |\n#|$)/)?.[1] || '';
  const value = (k, d) => section.match(new RegExp('^\\s*' + k + ':\\s*([^\\s#]+)', 'm'))?.[1]?.replace(/["']/g, '') || d;
  const profile = { provider: value('provider', ''), model: value('model', ''), effort: value('reasoningEffort', '') };
  if (!profile.provider || !profile.model) throw deepseekNotReady('DeepSeek 登录配置里没有默认模型：' + file, '打开 DeepSeek Harness 选一个模型并确认已登录，然后再试一次。');
  if (Object.values(profile).some(v => v && !/^[\w.-]+$/.test(v))) throw deepseekNotReady('DeepSeek 登录配置里的模型名格式异常：' + JSON.stringify(profile), '打开 DeepSeek Harness 重新选一次模型后再试。');
  return profile;
}

// 统一入口：先按本机发现补全安装/登录位置，再读桌面端当前模型。
// 客户不需要在 BEAT 里填任何路径；显式配置优先，自动发现只填空的/失效的项。
export function deepseekProfileFor(config = {}, { runtime } = {}) {
  let rt = runtime;
  if (!rt) { try { rt = resolveDeepseekRuntime(config); } catch { rt = {}; } }
  const ds = { ...(config.deepseek || {}) };
  if (rt && typeof rt === 'object') {
    if (rt.executable) ds.executable = rt.executable;
    if (rt.cli) ds.cli = rt.cli;
    if (rt.home && !ds.home) ds.home = rt.home;
    if (rt.profileFile && !(ds.profileFile && fs.existsSync(ds.profileFile))) ds.profileFile = rt.profileFile;
  }
  const effective = { ...config, deepseek: ds };
  const file = configuredDeepseekProfileFile(effective);
  return { profile: deepseekProfile(file), file, runtime: rt || {} };
}

// DeepSeek 账号模型支持的推理强度（来自 dsh-llm-deepseek 适配器的校验列表）
export const DEEPSEEK_EFFORTS = ['off', 'low', 'high', 'max'];

export function deepseekModels(file = deepseekProfileFile()) {
  const profile = deepseekProfile(file);
  const text = fs.readFileSync(file, 'utf8');
  const id = 'llm-' + profile.provider;
  const section = text.split(/\r?\n(?=- )/).find(s => new RegExp('^- id: ' + id + '\\s*$', 'm').test(s)) || '';
  const extra = { efforts: DEEPSEEK_EFFORTS, defaultEffort: profile.effort || 'high', images: true };
  const models = [...section.matchAll(/^\s{4,}- id:\s*["']?([\w.-]+)["']?\s*$/gm)].map(m => ({ id: m[1], name: m[1], availability: 'configured', ...extra }));
  if (!models.some(m => m.id === profile.model)) models.push({ id: profile.model, name: profile.model, availability: 'configured', ...extra });
  return models;
}

export function writePatch(config, profile, { access = 'read-only' } = {}) {
  const dir = path.join(config.dataDir, 'runtime'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'deepseek-worker-' + randomUUID() + '.patch.yml');
  // Keep headless lifecycle, but inherit the desktop's installed MCP/skill
  // entries. Do not boot its UI host or copy model credential configuration.
  const desktopFile = configuredDeepseekProfileFile(config);
  const desktopText = fs.readFileSync(desktopFile, 'utf8');
  const inherited = desktopText.split(/\r?\n(?=- )/).filter(entry => /^- /m.test(entry)
    && /(?:@deepseek-ai\/dsh-(?:mcp-client|mcp-resources|skill(?:-[\w-]+)?|tool-skill)\b|^\s*-?\s*id:\s*(?:skill|skills|skill-filesystem)\s*$)/m.test(entry)
    && !/mcp-beat-worker|beat-desktop-history|deepseek-sidebar/.test(entry));
  fs.writeFileSync(file, [
    '# 由 BEAT 生成：沿用桌面端模型，后台无人值守',
    '- id: agent-default-model', "  name: '@deepseek-ai/dsh-agent-default-model'", '  config:',
    `    provider: ${profile.provider}`, `    model: ${profile.model}`, ...(profile.effort ? [`    reasoningEffort: ${profile.effort}`] : []),
    '- id: approval', '  config:', '    policy: never',
    '- id: permission', '  config:', '    presets:',
    '      read-only:', '        sandbox: read-only', '        approval: never',
    '      workspace-write:', '        sandbox: workspace-write', '        approval: never',
    // 打开/操作桌面软件要能让目标程序写自己的数据目录、起自己的进程；
    // workspace-write 会挡住（实测：豆包启动器秒退、app\Doubao.exe 以 0x80000003 崩溃、日志零写入）。
    '      danger-full-access:', '        sandbox: danger-full-access', '        approval: never',
    ...inherited, '',
  ].join('\n'));
  return file;
}

export function createDeepseekParser() {
  const s = { sessionId: null, chunks: [], final: null, message: null, errors: [], endReason: null, usage:null };
  const calls = [];
  const seenUsage=new Set();let stepsUsage=null;
  const writes=new Set();let attributed=true;
  return {
    push(line) {
      let e; try { e = JSON.parse(line); } catch { return; }
      if(e.type==='tool_call'){
        calls.push({ id: e.callId || e.id || e.toolCallId || null, tool: e.tool, status: 'started', failed: false, record: e });
        if(['write','edit','multi_edit'].includes(e.tool)&&typeof e.input?.file_path==='string')writes.add(e.input.file_path);
        else if(!['read','glob','grep','ls','web_search','web_fetch'].includes(e.tool))attributed=false;
      }
      if (e.type === 'tool_result' || e.type === 'tool_error') {
        const id = e.callId || e.id || e.toolCallId;
        const call = [...calls].reverse().find(c => c.status === 'started' && (id ? c.id === id : !e.tool || c.tool === e.tool));
        if (call) { call.status = 'completed'; call.failed = e.type === 'tool_error' || e.status === 'error' || !!e.error || e.isError === true || e.result?.isError === true; call.result = e; }
      }
      const usage=e.usage||e.tokenUsage?.last||e.data?.usage;
      if(usage&&typeof usage==='object') {
        if(e.type==='status'&&e.phase==='step_end'&&e.step!==undefined){
          const key=String(e.turn)+':'+e.step;
          if(!seenUsage.has(key)){
            seenUsage.add(key);
            stepsUsage||={inputTokens:0,outputTokens:0,cacheReadTokens:0,totalTokens:0,providerTotalTokens:0,contextInputTokens:0,source:'deepseek headless summed steps'};
            const input=Number(usage.inputTokens)||0, output=Number(usage.outputTokens)||0, cache=Number(usage.cacheReadTokens)||0;
            stepsUsage.inputTokens+=input;
            stepsUsage.outputTokens+=output;
            stepsUsage.cacheReadTokens+=cache;
            // 计费口径只算“新增输入 + 输出”；缓存读入单列。
            // 旧实现把每步 totalTokens（含 cacheReadTokens）相加，读一个 24 行 JSON 也能显示 52 万 token（R372 实测），
            // 既吓到买家，也会让默认预算被廉价缓存撑爆。缓存仍保留在 providerTotalTokens 里供审计。
            stepsUsage.totalTokens=stepsUsage.inputTokens+stepsUsage.outputTokens;
            stepsUsage.providerTotalTokens+=Number(usage.totalTokens)||input+output+cache;
            stepsUsage.contextInputTokens=input+cache;
            s.usage={...stepsUsage};
          }
        }
        else if(!stepsUsage)s.usage={...usage,source:'deepseek headless event'};
      }
      if (e.type === 'session' && /^[\w-]+$/.test(e.sessionId || '')) s.sessionId = e.sessionId;
      else if (e.type === 'text' && e.text) s.chunks.push(e.text);
      else if (e.type === 'final' || e.type === 'result') s.final = e.text ?? e.result ?? e.message ?? s.final;
      else if (e.type === 'assistant/message' && Array.isArray(e.data?.message?.content)) s.message = e.data.message.content.filter(x => x.type === 'text').map(x => x.text).join('');
      else if (e.type === 'error' || e.type === 'turn.failed') s.errors.push(String(e.message || e.error?.message || JSON.stringify(e)).slice(0, 500));
      else if (e.type === 'status' && e.phase === 'turn_end' && e.reason?.kind) {
        s.endReason = e.reason.kind;
        if (!['completed', 'complete', 'stop'].includes(e.reason.kind)) s.errors.push('DeepSeek 本轮结束原因：' + JSON.stringify(e.reason).slice(0, 300));
      }
    },
    result() { return { ...s, nativeToolEvidence: buildNativeToolEvidence(structuredClone(calls), 'deepseek headless tool events'), scopeWriteEvidence:{source:'native-tool-log',complete:attributed,paths:[...writes]},text: (s.final || s.message || s.chunks.join('') || '').trim() }; },
  };
}

export async function askDeepseek(config, { prompt, cwd, access = 'read-only', nativeId, nativeHome, model, effort, signal, timeoutMs, logFile, onNative, onUsage, onProgress, maxTokens }, { spawnProcess = spawn } = {}) {
  if (signal?.aborted) throw abortError(signal);
  if (spawnProcess === spawn) config = { ...config, deepseek: { ...config.deepseek, ...resolveDeepseekRuntime(config) } };
  // 原生会话在哪个 DSH 根目录下创建，就固定在哪个目录续用：服务重启/换启动方式可能改变
  // DSH_HOME，只按当前环境找会话会出现“会话明明存在却报 does not exist”（R408 实测）。
  if (nativeHome) {
    const home = path.resolve(String(nativeHome));
    const profileFile = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');
    config = { ...config, deepseek: { ...config.deepseek, home, ...(fs.existsSync(profileFile) ? { profileFile } : {}) } };
  }
  const profileFile = configuredDeepseekProfileFile(config);
  const profile = deepseekProfile(profileFile);
  if (model) {
    if (!deepseekModels(profileFile).some(m => m.id === model)) { const e = new Error('DeepSeek 模型未配置：' + model); e.modelError = true; throw e; }
    profile.model = model;
  }
  if (effort) {
    if (!DEEPSEEK_EFFORTS.includes(effort)) { const e = new Error('DeepSeek 不支持推理强度：' + effort + '（可选 ' + DEEPSEEK_EFFORTS.join(' / ') + '）'); e.modelError = true; throw e; }
    profile.effort = effort;
  }
  let afterSeq = 0;
  if (nativeId) try { afterSeq = Math.max(0, ...readNativeRows(config, nativeId, cwd).rows.map(x => x.seq || 0)); } catch { /* evidence remains unknown if unavailable */ }
  const startedAt = Date.now();
  const args = ['--expose-internals', config.deepseek.cli, 'headless', '--patch', writePatch(config, profile, { access })];
  if (nativeId) args.push('--session-id', nativeId);
  args.push('--json', '-');
  const child = spawnProcess(config.deepseek.executable, args, {
    cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(config.deepseek.home ? { DSH_HOME: config.deepseek.home } : {}), ELECTRON_RUN_AS_NODE: '1', DSH_PERMISSION_MODE: access, NO_COLOR: '1', BEAT_CHILD: '1' },
  });
  onProgress?.({source:'deepseek',pid:child.pid,event:'process-start'});
  const log = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
  const parser = createDeepseekParser();
  let stderr = '', timedOut = false, spawnError = null, nativeError = null, announced = null;
  onLines(child.stdout, line => {
    log?.write(redact(line, config) + '\n'); parser.push(line); const id = parser.result().sessionId;
    onProgress?.({source:'deepseek',pid:child.pid,event:'output'});onUsage?.(parser.result().usage);
    if(maxTokens&&Buffer.byteLength(parser.result().text,'utf8')>maxTokens*4){nativeError=Object.assign(new Error('本次答复达到输出长度上限，已停止并保留已有结果'),{code:'CONTROL_BUDGET_EXCEEDED',noFallback:true,usage:parser.result().usage});killTree(child);}
    if (id && !nativeError) try { onNative?.(id); } catch (e) { nativeError = e; killTree(child); }
    // 一拿到会话号就让桌面端列表出现它（执行可能很久）
    if (id && announced !== id && spawnProcess === spawn) { announced = id; syncDeepseekSession(config, id, cwd, { delayMs: 3000, running: true }); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', s => { stderr = (stderr + s).slice(-8000); });
  child.stdin.on('error', () => {});
  child.on('error', e => { spawnError = e; });
  child.stdin.end(prompt);

  const onAbort = () => killTree(child);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  log?.end();
  // 本轮结束（成功、失败或取消）都刷新一次桌面端里的会话内容
  if (spawnProcess === spawn && (parser.result().sessionId || nativeId)) syncDeepseekSession(config, parser.result().sessionId || nativeId, cwd, { delayMs: 500, running: false });

  if (signal?.aborted) throw Object.assign(abortError(signal),{partialText:redact(parser.result().text,config),usage:parser.result().usage});
  if (nativeError) throw Object.assign(nativeError,{partialText:redact(parser.result().text,config)});
  if (spawnError) throw Object.assign(new Error('无法启动 DeepSeek：' + spawnError.message), { notDispatched: true });
  const r = parser.result();
  if (timedOut) throw new Error(`DeepSeek 超过 ${Math.round(timeoutMs / 60000)} 分钟未完成，已停止（已写的文件保留）`);
  if (code !== 0 || r.errors.length || r.endReason && !['completed', 'complete', 'stop'].includes(r.endReason)) {
    const raw = redact(`DeepSeek 执行失败（退出码 ${code}）：${r.errors.join(' | ') || stderr.slice(-1500)}`, config);
    // 会话在本机找不到（换了登录目录或被清理）：CLI 在查找阶段就退出，没有执行任何工具。
    // 明确标成“未派发”，让上层的固定会话自动改用新会话继续，而不是当成未知副作用隔离。
    const sessionMissing = /session\s+["']?[\w.-]+["']?\s+does not exist|omit --session-id to start a new Session/i.test(`${r.errors.join(' | ')} ${stderr}`);
    if (sessionMissing && nativeId && !(r.nativeToolEvidence?.calls || []).length) {
      const e = new Error('DeepSeek 原会话已不存在（可能换了登录目录或会话被清理），本次没有开始执行。已保留任务和已有产物，将用新会话继续。');
      e.detail = raw;
      e.code = 'NATIVE_SESSION_MISSING'; e.sessionMissing = nativeId; e.notDispatched = true; e.noFallback = true;
      throw e;
    }
    const e = new Error(raw);
    e.modelError = /model.*(invalid|unknown|unsupported|not supported)|模型.*(无效|不存在)/i.test(e.message); throw e;
  }
  if (!r.text) throw new Error('DeepSeek 没有返回任何答复');
  const id = r.sessionId || nativeId || null;
  const evidence = nativeModelEvidence(config, { nativeId: id, cwd, afterSeq, startedAt });
  if (evidence.modelVerified === 'verified' && (evidence.actualModel !== profile.model || evidence.actualProvider !== profile.provider)) {
    const e = new Error(`DeepSeek 模型不匹配：请求 ${profile.provider}/${profile.model}，原生 ${evidence.actualProvider}/${evidence.actualModel}`);
    e.modelError = true; e.actualModel = evidence.actualModel; throw e;
  }
  return { text: redact(r.text, config), usage:r.usage, nativeToolEvidence: JSON.parse(redact(JSON.stringify(sealNativeToolTrace(r.nativeToolEvidence)), config)), scopeWriteEvidence:r.scopeWriteEvidence, nativeId: id, nativeHome: config.deepseek.home || null, model: profile.model, effort: profile.effort || null, ...evidence };
}
