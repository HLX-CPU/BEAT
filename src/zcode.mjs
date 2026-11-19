// ZCode 桌面端搭档适配器：通过 `zcode app-server`（ZCode Protocol，行式 JSON 帧）驱动。
//
// 协议证据（2026-10-24 实测，tests/probe-zcode-server.mjs → output/zcode-server-probe.json）：
//  - 请求帧 {id, method, params}（没有 jsonrpc 键）；响应 {id, result|error}；
//    服务端→客户端请求也带 id（"server-N"），客户端必须应答 {id, result}。
//  - session/requestRuntimePreferences（scope=runtime-materialization）必须应答，否则会话建不起来；
//    interaction/* 是权限/用户输入请求——BEAT 绝不代批，显式拒绝并让本轮如实失败。
//  - session/create {workspace:{workspaceKey, workspacePath}} → result.session.sessionId（默认 mode=build）。
//  - session/setModel {sessionId, model:{providerId, modelId}}；模型注册表来自 `zcode login zai`
//    的一次性浏览器授权（未登录时报 ModelNotFound，见 zcodeProviderMissing）。
//  - session/send {sessionId, content} → 事件流；v4/telemetry/event kind=turn.terminal 表示本轮终结。
//  - session/read 取最终消息，session/usage 取累计用量（本轮 = 末值 − 基线），session/close 收尾。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LOG_NOISE = /startup\/storageState|process\/resourceSample|process\/mcpTelemetry|v4\/telemetry\/event/;

function isFile(file) { try { return !!file && fs.statSync(file).isFile(); } catch { return false; } }

/** ZCode CLI 发现：显式配置优先，其次按本机常见安装位置探测。 */
export function detectZcodeRuntime(config) {
  const installDir = process.env.ZCODE_WINDOWS_APP_INSTALL_DIR || '';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    config?.zcode?.cliPath,
    installDir && path.join(installDir, 'resources', 'glm', 'zcode.cjs'),
    path.join(local, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs',
    'D:\\ZCODE\\resources\\glm\\zcode.cjs',
  ];
  const cli = candidates.find(isFile);
  if (!cli) {
    return { available: false, reason: '未检测到 ZCode 桌面端。安装并打开一次完成登录即可（之后不用保持运行，BEAT 会在后台调用）。' };
  }
  const dataBaseDir = config?.zcode?.dataDir || process.env.ZCODE_DATA_BASE_DIR || '';
  const personalConfigFile = (isFile(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) ? process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE : null)
    || (dataBaseDir ? path.join(dataBaseDir, '.zcode', 'v2', 'provider_config.json') : '')
    || path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
  return { available: true, cli, dataBaseDir, personalConfigFile };
}

/** 读取 ZCode 自己登录后写入的默认模型选择（provider_config.json 的 config.defaultModelSelection）。
 *  客户没在 BEAT 里显式指定模型时，用它推断——登录了就能直接用，不需要客户再填 providerId/modelId。 */
export function readMachineModelSelection(runtime) {
  for (const key of ['defaultModelSelection', 'config']) {
    try {
      const j = JSON.parse(fs.readFileSync(runtime.personalConfigFile, 'utf8'));
      const sel = key === 'config' ? j?.config?.defaultModelSelection : j?.defaultModelSelection;
      if (sel && typeof sel.providerId === 'string' && typeof sel.modelId === 'string') {
        return { providerId: sel.providerId, modelId: sel.modelId };
      }
    } catch { /* 文件不存在或未登录：返回 undefined，由调用方给登录指引 */ }
  }
  return undefined;
}

/** 'providerId/modelId' → {providerId, modelId}（providerId 可含冒号，如 'account:zai-individual-coding-plan'）。
 *  解析失败返回 null（调用方给出可操作报错）。 */
export function parseModelSelection(model) {
  const text = String(model || '').trim();
  const m = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(text);
  return m ? { providerId: m[1], modelId: m[2] } : null;
}

function fail(message, extra = {}) {
  const e = new Error(message);
  Object.assign(e, extra);
  return e;
}

/** access（BEAT 权限档）→ ZCode 会话 mode。执行档用 yolo：无头运行没有人审批，
 *  BEAT 自己的文件范围核验/检查点/快照在 CLI 外层兜底（与 Codex approval_policy=never 同理）。 */
function modeFor(access) {
  return access === 'read-only' ? 'plan' : 'yolo';
}

export async function askZcode(config, options = {}, overrides = {}) {
  const {
    prompt, model, nativeId, cwd, access = 'read-only', signal, timeoutMs,
    logFile, maxTokens, onUsage, onProgress, onNative,
  } = options;
  const spawnProcess = overrides.spawnProcess || spawn;
  const runtime = overrides.runtime || detectZcodeRuntime(config);
  if (!runtime.available) throw fail(runtime.reason, { notDispatched: true });

  const env = { ...process.env };
  if (runtime.dataBaseDir) env.ZCODE_DATA_BASE_DIR = runtime.dataBaseDir;
  const child = spawnProcess(process.execPath, [runtime.cli, 'app-server'], { cwd: cwd || process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
  const write = obj => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* 进程已退出：由 close 处理 */ } };
  if (logFile) { try { fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), kind: 'spawn', cli: runtime.cli, cwd }) + '\n'); } catch { /* 日志失败不影响调用 */ } }

  const transcript = [];
  const pending = new Map();
  const interactionBlocks = [];
  let nextId = 1;
  let buffer = '';
  let exited = null;
  let sawModel = null;
  child.stdout.on('data', d => {
    buffer += d.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (!line) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      transcript.push(obj);
      if (logFile) { try { fs.appendFileSync(logFile, JSON.stringify(obj) + '\n'); } catch { /* 同上 */ } }
      if (obj.id !== undefined && pending.has(obj.id)) {
        const { resolve } = pending.get(obj.id);
        pending.delete(obj.id);
        resolve(obj);
        continue;
      }
      // 服务端→客户端请求：必须应答，否则会话会卡在 15 秒超时上。
      // interaction/* 分两类：requestPermission / requestUserInput 是真的人工批准——BEAT 绝不代批，
      // 显式拒绝并让本轮如实失败；requestOfficialMcpAuthHeaders / requestProviderRuntimeHeaders 是
      // 鉴权头握手（桌面端由客户端提供 JWT），协议允许优雅拒绝（official_auth_unavailable），照实回绝即可。
      if (obj.method && obj.id !== undefined) {
        if (obj.method === 'interaction/requestOfficialMcpAuthHeaders' || obj.method === 'interaction/requestProviderRuntimeHeaders') {
          write({ id: obj.id, result: { ok: false, reason: 'official_auth_unavailable' } });
        } else if (String(obj.method).startsWith('interaction/')) {
          interactionBlocks.push(String(obj.method) + (obj.params?.kind ? `(${obj.params.kind})` : ''));
          write({ id: obj.id, error: { code: -32000, message: 'BEAT 不代批：' + obj.method } });
        } else if (obj.method === 'session/requestRuntimePreferences') {
          write({ id: obj.id, result: { nativeSearchEnhancementsEnabled: false, toolSearchMode: 'off', memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1', additionalDirectories: [] } });
        } else {
          write({ id: obj.id, result: {} });
        }
      }
    }
  });
  child.stderr.on('data', d => { const text = d.toString().slice(0, 400); transcript.push({ stderr: text }); });
  const closeP = new Promise(resolve => child.on('close', code => { exited = code; resolve(code); }));
  child.on('error', e => { exited = -1; });

  const call = (method, params, perCallTimeoutMs = 30_000) => new Promise(resolve => {
    const id = nextId++;
    pending.set(id, { resolve });
    write({ id, method, params });
    const t = setTimeout(() => { if (pending.delete(id)) resolve({ timeout: true }); }, perCallTimeoutMs);
    if (t.unref) t.unref();
  });
  const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  const aborted = () => signal?.aborted;

  const deadline = timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  const remaining = () => (deadline ? Math.max(1000, deadline - Date.now()) : 600_000);

  let sessionId = null;
  const cleanup = () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } };

  try {
    if (aborted()) throw Object.assign(new Error('已取消'), { cancelled: true });
    // 1) 建会话或续接原生会话
    const workspaceKey = 'beat-' + Buffer.from(String(cwd || 'beat')).toString('base64url').slice(0, 40);
    if (nativeId) {
      const resumed = await call('session/resume', { workspace: { workspaceKey, workspacePath: cwd || process.cwd() }, sessionId: nativeId }, 30_000);
      if (resumed.timeout || resumed.error) {
        throw fail(`原生会话无法续接（${resumed.error?.message || '超时'}），需要丢弃旧会话重新开始`, { code: 'NATIVE_SESSION_MISSING', notDispatched: true, nativeId });
      }
      sessionId = resumed.result?.session?.sessionId || nativeId;
      onNative?.(sessionId);
    } else {
      const created = await call('session/create', { workspace: { workspaceKey, workspacePath: cwd || process.cwd() } }, 45_000);
      if (created.timeout || created.error) throw fail('ZCode 会话创建失败：' + (created.error?.message || '超时'), { notDispatched: true });
      sessionId = created.result?.session?.sessionId;
      if (!sessionId) throw fail('ZCode 会话创建返回缺少 sessionId', { notDispatched: true });
      onNative?.(sessionId);
    }
    const usageAt = async () => {
      const u = await call('session/usage', { sessionId }, 20_000);
      return u.result || null;
    };
    const usageBaseline = await usageAt();

    // 2) 会话模式：讨论只读 plan；执行 yolo（无头无审批人；BEAT 外层有文件范围核验兜底）
    await call('session/setMode', { sessionId, mode: modeFor(access) }, 20_000);

    // 3) 模型选择：优先客户在 BEAT 里显式指定的（providerId/modelId），否则推断 ZCode 登录时
    //    写入的本机默认（provider_config.json 的 config.defaultModelSelection）。两者都没有时跳过
    //    setModel 靠会话默认；发送阶段如果连默认都没有，终结事件会带 "Select a model"，
    //    映射成一次性登录指引。
    const selection = parseModelSelection(model) || readMachineModelSelection(runtime);
    if (selection) {
      const set = await call('session/setModel', { sessionId, model: selection }, 30_000);
      if (set.error || set.timeout) {
        const detail = set.error?.message || '超时';
        if (/not-found|不存在|ModelNotFound/i.test(detail)) {
          // 会话默认模型接管（zcode login 之后必然存在）；这里不硬失败。
          sawModel = null;
        } else {
          throw fail('ZCode 模型选择失败：' + detail, { notDispatched: true });
        }
      } else {
        sawModel = set.result?.model || model;
      }
    }

    // 4) 发送本轮
    const sent = await call('session/send', { sessionId, content: prompt }, 30_000);
    if (sent.error || sent.timeout) throw fail('ZCode 本轮派发失败：' + (sent.error?.message || '超时'), { notDispatched: true });
    onProgress?.({ source: 'zcode', event: 'turn-started', sessionId });

    // 5) 等本轮终结（v4/telemetry/event kind=turn.terminal）
    let terminal = null;
    const startedAt = Date.now();
    while (Date.now() - startedAt < remaining() && !aborted() && exited === null) {
      await sleep(300);
      const hit = transcript.find(o => o.method === 'v4/telemetry/event' && o.params?.kind === 'turn.terminal' && (!o.params?.sessionId || o.params.sessionId === sessionId));
      if (hit) { terminal = hit.params; break; }
    }
    if (aborted()) {
      await call('session/stop', { sessionId }, 10_000).catch(() => {});
      const read = await readMessages(sessionId);
      throw fail('已取消', { cancelled: true, partialText: read.text || '', usage: read.usage });
    }
    if (!terminal) {
      const read = await readMessages(sessionId);
      cleanup();
      throw fail(`ZCode 在 ${Math.round(remaining() / 60000)} 分钟内没有完成本轮（无输出进展）${read.text ? '，已保留部分输出' : ''}`,
        { partialText: read.text || '', usage: read.usage, ...(read.text ? {} : { notDispatched: false }) });
    }

    // 6) 取最终消息与用量
    const read = await readMessages(sessionId);
    const usageNow = read.usage;
    const status = String(terminal.status || '');
    const failed = status && status !== 'complete' && status !== 'completed';
    const errorMessage = String(terminal.errorMessage || '');
    const turnError = interactionBlocks.length
      ? `ZCode 请求了需要人工批准的操作（${interactionBlocks.join('、')}），BEAT 不会代批；请改用执行搭档或调整任务。`
        : /select a model/i.test(errorMessage)
          ? 'ZCode CLI 独立运行时暂时无法加载模型注册表（当前 CLI 版本的限制，桌面端内不受影响）。已保留本搭档的全部接入，等 ZCode CLI 更新支持独立调用后自动上线；期间请由其他搭档执行。'
        : errorMessage && failed ? `ZCode 本轮失败：${errorMessage}` : '';
    if (!read.text) throw fail(turnError || `ZCode 本轮没有产出文本回复${failed ? `（状态 ${status}）` : ''}`, { usage: usageNow, ...(turnError ? { notDispatched: true } : {}) });

    return {
      text: read.text,
      usage: usageNow || undefined,
      nativeId: sessionId,
      model: model || null,
      actualModel: sawModel || model || null,
      effort: null,
      modelVerified: 'unknown',
      modelEvidence: { source: 'zcode app-server session/setModel 回执', requested: model, applied: sawModel || null },
    };

    async function readMessages(id) {
      const r = await call('session/read', { sessionId: id }, 30_000);
      const messages = r.result?.messages || [];
      const texts = [];
      for (const m of Array.isArray(messages) ? messages : []) {
        const role = m.role || m.kind || '';
        if (!/assistant/i.test(String(role))) continue;
        const c = m.content ?? m.text ?? m.delta;
        if (typeof c === 'string' && c.trim()) texts.push(c);
        else if (Array.isArray(c)) texts.push(c.filter(x => x?.type === 'text' || typeof x?.text === 'string').map(x => x.text).join(''));
      }
      const now = await usageAt();
      const usage = usageDiff(usageBaseline, now);
      if (usage) onUsage?.(usage);
      return { text: texts.join('\n').trim(), usage };
    }
  } finally {
    if (sessionId) await call('session/close', { sessionId }, 5_000).catch(() => {});
    cleanup();
  }
}

/** 本轮用量 = 末值 − 基线（session/usage 是会话累计值）。取不到就返回 undefined，如实不记账。 */
function usageDiff(baseline, now) {
  if (!now) return undefined;
  const num = (o, k) => Math.max(0, Number(o?.[k]) || 0);
  const base = baseline || {};
  const total = num(now, 'totalTokens') - num(base, 'totalTokens');
  const input = num(now, 'inputTokens') - num(base, 'inputTokens');
  const output = num(now, 'outputTokens') - num(base, 'outputTokens');
  const cacheRead = num(now, 'cacheReadTokens') - num(base, 'cacheReadTokens');
  if (!total && !input && !output) return undefined;
  return { totalTokens: total || (input + output), inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead > 0 ? cacheRead : 0, source: 'zcode app-server session/usage', verified: true };
}
