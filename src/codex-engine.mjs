import { redact } from './config.mjs';
import { abortError } from './proc.mjs';
import { codexRPC } from './codex-rpc.mjs';
import { syncCodexThread } from './desktop-sync.mjs';
import { buildNativeToolEvidence, sealNativeToolTrace } from './native-evidence.mjs';
import { createCodexUsageAccumulator } from './codex-usage.mjs';

// Interpret app-server transport notifications without creating another turn.
// Only real response activity clears a reconnect notice; usage/heartbeat
// notifications can arrive while the response stream is still disconnected.
export function codexTransportProgress(notification, previous) {
  const p = notification.params || {}, error = p.error || {};
  const at = new Date(Number.isFinite(notification.emittedAtMs) ? notification.emittedAtMs : Date.now()).toISOString();
  if (notification.method === 'error' && (typeof p.willRetry === 'boolean' || error.codexErrorInfo?.responseStreamDisconnected)) {
    const retry = String(error.message || '').match(/Reconnecting\s*\.*\s*(\d+)\s*\/\s*(\d+)/i);
    return { status:p.willRetry === true ? 'reconnecting' : 'interrupted', at, source:'codex', threadId:p.threadId || null, turnId:p.turnId || null,
      willRetry:p.willRetry === true, attempt:retry ? Number(retry[1]) : null, maxAttempts:retry ? Number(retry[2]) : null,
      diagnostic:{ message:error.message || null, additionalDetails:error.additionalDetails || null, codexErrorInfo:error.codexErrorInfo || null } };
  }
  const responseActivity = ['item/agentMessage/delta','item/reasoning/textDelta','item/reasoning/summaryTextDelta'].includes(notification.method) && typeof p.delta === 'string' && p.delta.length > 0
    || notification.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string' && p.item.text.trim().length > 0
    || notification.method === 'turn/completed' && p.turn?.status === 'completed';
  if (previous?.status === 'reconnecting' && responseActivity) return { ...previous, status:'recovered', at, recoveredBy:notification.method, willRetry:false };
  return null;
}

export async function listCodexModels(config, options = {}) {
  const rpc = await codexRPC(config, options);
  try {
    const models = []; let cursor; const seen = new Set();
    do {
      const result = await rpc.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const m of result.data || []) if (m.model || m.id) models.push({ id: m.model || m.id, name: m.displayName || m.model || m.id, availability: 'configured',
        efforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort || e).filter(Boolean), defaultEffort: m.defaultReasoningEffort || null,
        images: (m.inputModalities || []).includes('image') });
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('model/list 分页游标重复');
      seen.add(cursor);
    } while (cursor);
    if (!models.length) throw new Error('model/list 返回空列表');
    return models;
  } finally { await rpc.close(); }
}

export async function askCodex(config, { prompt, cwd, access = 'read-only', nativeId, model, effort, images = [], title, signal, timeoutMs, logFile, onNative, onUsage, onProgress, maxTokens }, options = {}) {
  if (signal?.aborted) throw abortError(signal);
  let threadId, turnId, acceptedModel, reroutedModel, usage = null, outputBytes = 0, transport = null;
  const usageAccumulator = createCodexUsageAccumulator();
  let collectingUsage = false;
  const pendingUsage = [];
  const partials = new Map();
  const nativeCalls = new Map();
  const nativeEvidence = () => buildNativeToolEvidence([...nativeCalls.values()], 'codex app-server tool events');
  const completed = new Map(), texts = new Map(); let resolve, reject;
  const finished = new Promise((a, b) => { resolve = a; reject = b; }); finished.catch(() => {});
  const check = () => { if (turnId && completed.has(turnId)) resolve({ turn: completed.get(turnId), text: texts.get(turnId) || '' }); };
  const rpc = await codexRPC(config, { ...options, cwd, logFile, onNotification: m => {
    if (m.method === 'beat/closed') return reject(m.error);
    const p = m.params || {}; if (p.threadId && threadId && p.threadId !== threadId) return;
    if (p.turnId && turnId && p.turnId !== turnId) return;
    const connection = codexTransportProgress(m, transport);
    if (connection) transport = JSON.parse(redact(JSON.stringify(connection), config));
    onProgress?.({ source:'codex',event:m.method,turnId:p.turnId || null,
      ...(m.method === 'error' ? { error:JSON.parse(redact(JSON.stringify(p.error || {}), config)), willRetry:p.willRetry === true } : {}),
      ...(connection ? { transport } : {}) });
    if (['item/started', 'item/completed'].includes(m.method) && p.item?.id && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'computerToolCall'].includes(p.item.type)) {
      const item = p.item;
      nativeCalls.set(item.id, { id: item.id, tool: item.type === 'mcpToolCall' ? `${item.server || ''}.${item.tool || ''}` : item.type,
        status: m.method === 'item/completed' ? 'completed' : 'started',
        failed: ['failed', 'declined'].includes(item.status) || !!item.error || item.result?.isError === true || item.success === false || typeof item.exitCode === 'number' && item.exitCode !== 0,
        record: JSON.parse(redact(JSON.stringify(item), config)) });
    }
    if (m.method === 'thread/tokenUsage/updated') {
      if (!collectingUsage) usageAccumulator.seed(p.tokenUsage?.total);
      else if (!turnId) pendingUsage.push(p);
      else { usage = usageAccumulator.push(p.tokenUsage); if (usage) onUsage?.(usage); }
    }
    if (m.method === 'item/agentMessage/delta' && typeof p.delta === 'string') { partials.set(p.turnId, (partials.get(p.turnId) || '') + p.delta); outputBytes+=Buffer.byteLength(p.delta,'utf8');if(maxTokens && outputBytes>maxTokens*4)reject(Object.assign(new Error('本次答复达到输出长度上限，已停止并保留已有结果'),{code:'CONTROL_BUDGET_EXCEEDED',noFallback:true,usage})); }
    if (m.method === 'item/completed' && p.item?.type === 'agentMessage') texts.set(p.turnId, p.item.text || '');
    if (m.method === 'model/rerouted') reroutedModel = p.toModel;
    if (m.method === 'turn/completed' && p.turn?.id) { completed.set(p.turn.id, p.turn); check(); }
  } });
  const stop = e => { reject(e); rpc.close().catch(() => {}); };
  onProgress?.({source:'codex',event:'process-start',pid:rpc.pid});
  const onAbort = () => stop(Object.assign(abortError(signal),{partialText:redact(texts.get(turnId)||partials.get(turnId)||'',config),usage}));
  signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
  const timer = timeoutMs > 0 ? setTimeout(() => stop(new Error('Codex 请求超时，已停止')), timeoutMs) : null;
  try {
    const params = { cwd, approvalPolicy: 'never', sandbox: access, ...(model ? { model } : {}) };
    const started = nativeId ? await rpc.request('thread/resume', { ...params, threadId: nativeId, excludeTurns: true })
      : await rpc.request('thread/start', { ...params, ephemeral: false });
    threadId = started.thread.id; onNative?.(threadId);
    if (!nativeId) usageAccumulator.seed({ totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    acceptedModel = started.model || started.thread.model || null;
    if (model && acceptedModel && acceptedModel !== model) { const e = new Error(`Codex 模型不匹配：请求 ${model}，回显 ${acceptedModel}`); e.modelError = true; throw e; }
    if (!nativeId && title) await rpc.request('thread/name/set', { threadId, name: title.slice(0, 80) }).catch(() => {});
    // 图片作为原生图片输入发给模型（模型看得到图），推理强度按本轮指定
    const input = [{ type: 'text', text: prompt }, ...images.map(p => ({ type: 'localImage', path: p }))];
    collectingUsage = true;
    const turn = await rpc.request('turn/start', { threadId, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    turnId = turn.turn.id;
    // Notifications can share the response's stream chunk. Drain only the
    // returned turn; a late previous-turn notification must never be charged.
    for (const p of pendingUsage) if ((!p.threadId || p.threadId === threadId) && (!p.turnId || p.turnId === turnId)) {
      usage = usageAccumulator.push(p.tokenUsage); if (usage) onUsage?.(usage);
    }
    check();
    if (!nativeId && !options.spawnProcess) syncCodexThread(config, threadId).catch(() => {});
    const result = await finished;
    if (result.turn.status !== 'completed') { const e = new Error('Codex 本轮失败：' + (result.turn.error?.message || result.turn.status)); e.modelError = /model.*(invalid|unknown|unsupported|not supported)/i.test(e.message); throw e; }
    if (!result.text.trim()) throw new Error('Codex 没有返回任何答复');
    const actualModel = reroutedModel || acceptedModel;
    if (model && actualModel && actualModel !== model) { const e = new Error(`Codex 模型被改路由：请求 ${model}，实际 ${actualModel}`); e.modelError = true; e.actualModel = actualModel; throw e; }
    return { text: redact(result.text, config), usage, nativeToolEvidence: sealNativeToolTrace(nativeEvidence()), nativeId: threadId, model: actualModel, actualModel, effort: result.turn.effort || effort || started.reasoningEffort || null,
      modelVerified: actualModel ? 'verified' : 'unknown', modelEvidence: actualModel ? { source: 'app-server response + completed turn', acceptedModel, reroutedModel: reroutedModel || null } : null };
  } catch (error) {
    if (usage && !error.usage) error.usage = usage;
    const partialText = texts.get(turnId) || partials.get(turnId);
    if (partialText && !error.partialText) error.partialText = redact(partialText, config);
    error.nativeToolEvidence = { ...nativeEvidence(), ...(turnId ? { sideEffects: 'unknown' } : { sideEffects: 'none' }) };
    if (!turnId) error.notDispatched = true;
    // A rejected resume has not submitted a model turn. Do not spend a retry,
    // estimate inference tokens, or replace the fixed native conversation.
    if (nativeId && !turnId && error.rpcMethod === 'thread/resume' && error.rpcCode === -32600 && /already has an active writer|already owned by an active write handle/i.test(error.message || '')) {
      const cause = error.message;
      Object.assign(error, { code: 'NATIVE_SESSION_BUSY', notDispatched: true, busy: true, noFallback: true,
        nativeId, nativeBusyEvidence: { nativeId, rpcMethod: error.rpcMethod, rpcCode: error.rpcCode, message: cause, turnStarted: false },
        usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, verified: true, source: 'codex app-server rejected thread/resume before turn/start' } });
      error.message = 'Codex 正在另一个窗口处理这条任务，已保留进度并等待原会话空闲';
      onUsage?.(error.usage);
    }
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); await rpc.close(); }
}
