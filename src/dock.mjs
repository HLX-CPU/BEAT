// 拓展坞：通过 API 端点接入其他大模型（国产模型为主，OpenAI 兼容协议）。
// 接入的模型在 BEAT 里充当「顶替」：Codex / DeepSeek / Claude 下线时按顺序接上（只读、不执行写文件的步骤）。
// 底层 chatDock() 是通用客户端：流式、图片输入、工具调用（function calling）都支持——
// 以后的「操控电脑助手」直接用它做“模型 → 调工具 → 把结果喂回模型”的循环。
//
// 配置存 config.json 的 dock 数组；密钥存 secrets.local.json 的 dockKeys（不进 config.json）。
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { abortError } from './proc.mjs';
import { dockReasoning, normalizeDockReasoning, validateDockEffort } from './dock-reasoning.mjs';
export { dockReasoning, reasoningChoices, validateDockEffort } from './dock-reasoning.mjs';

// 预置端点（都是 OpenAI 兼容协议；地址可在接入时修改，接入后用「获取模型列表」「测试」确认）
export const DOCK_PRESETS = [
  { id: 'deepseek-api', name: 'DeepSeek 官方 API', baseUrl: 'https://api.deepseek.com/v1', hint: 'platform.deepseek.com 创建密钥' },
  { id: 'qwen', name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hint: '百炼控制台 API-KEY' },
  { id: 'kimi', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', hint: 'platform.moonshot.cn' },
  { id: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', hint: 'bigmodel.cn 开放平台' },
  { id: 'doubao', name: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', hint: '方舟控制台；模型可能要填接入点 ID（ep-…）' },
  { id: 'hunyuan', name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', hint: '混元控制台 API Key' },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', hint: 'minimaxi.com 开放平台' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', hint: '一个密钥可用多家开源模型' },
  { id: 'lingyi', name: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1', hint: 'platform.lingyiwanwu.com' },
  { id: 'baichuan', name: '百川智能', baseUrl: 'https://api.baichuan-ai.com/v1', hint: 'platform.baichuan-ai.com' },
  { id: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '', hint: '填到 /v1 这一级，例如 https://example.com/v1' },
];

export const isDock = id => typeof id === 'string' && id.startsWith('dock:');
export const dockList = config => (Array.isArray(config.dock) ? config.dock : []);
export const dockEntry = (config, id) => dockList(config).find(d => d.id === id) || null;
export const dockKey = (config, id) => config.secrets?.dockKeys?.[id] || '';
export const dockReady = (config, id) => { const d = dockEntry(config, id); return !!(d && d.enabled !== false && d.baseUrl && d.model && dockKey(config, id)); };
export const dockLabel = d => `${d.name}${d.model ? ' · ' + d.model : ''}`;

const trimUrl = u => String(u || '').trim().replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '');
const hasVersion = base => /\/v\d+[a-z0-9]*(\/|$)/i.test(new URL(base).pathname) || /\/(api\/paas|compatible-mode)\//.test(base);
const isHtml = r => /text\/html/i.test(r.headers.get('content-type') || '');
const headers = key => ({ authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });

export function dockHttpFailure(status, body) {
  let code = '';
  try { const j = JSON.parse(body); code = String(j.code || j.error?.code || j.error?.type || ''); } catch { /* non-JSON gateway error */ }
  const text = `${code} ${String(body || '')}`;
  if (/only (?:allows?|allowing) Claude Code clients|restricted to Claude Code clients/i.test(text)) return { failureKind: 'client-restricted', requiresAction: true, message: '服务商将此密钥分组限制为 Claude Code 专用。请联系服务商开放普通 API 调用权限后点击测试；更换模型名称或等待冷却不能解除限制。' };
  if (/INSUFFICIENT_BALANCE|insufficient (?:account )?balance|余额不足|欠费|out of credits/i.test(text)) return { failureKind: 'balance', requiresAction: true, message: '服务商账户余额不足。请充值后点击测试，BEAT 会保留现有任务与设置。' };
  if (/all available accounts exhausted|no available accounts|账号池.*(?:耗尽|无可用)/i.test(text)) return { failureKind: 'account-pool', requiresAction: false, message: '服务商的上游账号池暂时没有可用账号。接口未说明是额度耗尽还是暂时占满；可稍后重新测试，或联系服务商恢复账号池。' };
  if (status === 401) return { failureKind: 'auth', requiresAction: true, message: '密钥无效或已失效。请在此模型设置中更新密钥后点击测试。' };
  if (status === 403) return { failureKind: 'permission', requiresAction: true, message: '服务商拒绝此账号访问该接口或模型。请联系服务商开通权限后点击测试。' };
  if (status === 429) return { failureKind: 'rate-limit', requiresAction: false, message: '服务商限流或额度用尽，稍后自动再试。' };
  if (status >= 500) return { failureKind: 'server', requiresAction: false, message: `服务端故障（HTTP ${status}），稍后自动再试。` };
  return { failureKind: 'http', requiresAction: false, message: explain(status, body) };
}

function explain(status, body) {
  const b = String(body || '').replace(/\s+/g, ' ');
  if (status === 401 || /invalid.{0,20}(api.?key|token)|unauthori[sz]ed|authentication/i.test(b)) return '密钥无效或已失效';
  if (status === 403) return '没有权限（账号未开通该模型或额度不足）';
  if (status === 404) return '地址不对（找不到接口）。基础地址一般要填到 /v1 这一级';
  if (status === 429) return '限流或额度用尽';
  if (/insufficient|balance|quota|欠费|余额/i.test(b)) return '额度不足或欠费';
  if (/model.{0,30}(not.?exist|not.?found|does not exist)|模型不存在/i.test(b)) return '模型不存在或当前账号不可用';
  if (status >= 500) return `服务端故障（HTTP ${status}）`;
  return `HTTP ${status}：${b.slice(0, 200)}`;
}

// ---------- 模型列表 ----------
// 返回 { baseUrl, models:[{id, owned_by}] }。
// 体验（客户实测 2026-10-17“这获取模型也太慢了吧”）：以前根地址要先试 /v1 再试根路径，
// 串行两次超时最坏能等 40 秒。现在两个候选地址**并行**发、每次 10 秒封顶、成功结果缓存 3 分钟，
// 并且“连不上”会带主机名和下一步，客户不用盯着一动不动地等。
const MODEL_LIST_TIMEOUT_MS = 10000;
const MODEL_LIST_CACHE_MS = 3 * 60 * 1000;
const modelListCache = new Map(); // base + 换行 + key -> { at, value }
export function clearModelListCache() { modelListCache.clear(); }
export async function listDockModels({ baseUrl, key, signal }) {
  const base = trimUrl(baseUrl);
  if (!/^https?:\/\//.test(base)) throw new Error('基础地址要以 http:// 或 https:// 开头');
  if (!key) throw new Error('请先填写密钥');
  const cacheKey = base + '\n' + key;
  const hit = modelListCache.get(cacheKey);
  if (hit && Date.now() - hit.at < MODEL_LIST_CACHE_MS) return hit.value;
  let host = base; try { host = new URL(base).host; } catch { /* 地址解析失败时用原文提示 */ }
  const tryList = async (b, cancel) => {
    const timeout = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
    const signals = [timeout, ...(cancel ? [cancel] : []), ...(signal ? [signal] : [])];
    let r;
    try { r = await fetch(b + '/models', { headers: headers(key), signal: signals.length > 1 ? AbortSignal.any(signals) : timeout }); }
    catch (e) {
      // 说人话：客户看到的是“域名解析失败／连接被拒绝／连接超时”，不是 UND_ERR_* 这种内部码。
      const cause = e.cause;
      const rawCode = cause?.code || (Array.isArray(cause?.errors) ? cause.errors.map(x => x?.code).filter(Boolean).join('/') : '') || '';
      const human = /ECONNREFUSED/.test(rawCode) ? '连接被拒绝（端口没开或地址不对）'
        : /ENOTFOUND|EAI_AGAIN/.test(rawCode) ? '域名解析失败'
        : /ETIMEDOUT|TIMEOUT|CONNECT_TIMEOUT/i.test(rawCode) ? '连接超时'
        : /CERT|TLS|SSL/i.test(rawCode) ? '证书或 TLS 握手失败'
        : '';
      const why = e.name === 'TimeoutError' || /timeout/i.test(rawCode) ? '超过 ' + (MODEL_LIST_TIMEOUT_MS / 1000) + ' 秒没有响应' : (human || cause?.message || e.message);
      throw Object.assign(new Error('端点连不上（' + host + '）：' + why + '。请检查基础地址与网络，也可以先手动填写模型 ID'), { code: 'CONNECT', failureKind: 'connect', requiresAction: false });
    }
    const text = await r.text();
    if (!r.ok) { const failure = dockHttpFailure(r.status, text); throw Object.assign(new Error(failure.message), { status: r.status, failureKind: failure.failureKind, requiresAction: failure.requiresAction }); }
    let j; try { j = JSON.parse(text); } catch { const e = new Error('模型列表不是 JSON（地址可能不对，一般要填到 /v1 这一级）'); e.notJson = true; throw e; }
    const raw = Array.isArray(j) ? j : j.data || j.models || j.result?.models || [];
    const models = raw.map(m => (typeof m === 'string' ? { id: m } : { id: m.id || m.model || m.name, owned_by: m.owned_by || m.owner || undefined }))
      .filter(m => m.id).sort((a, b) => a.id.localeCompare(b.id));
    return { baseUrl: b, models };
  };
  // 没写版本号的地址：/v1 和根路径并行试（对话接口几乎都在 /v1，但有的中转站根路径也给列表）。
  // 先把赢的那个用起来，另一个立刻取消——客户点下去不用等慢的那条路。
  const candidates = hasVersion(base) ? [base] : [base + '/v1', base];
  const controllers = candidates.map(() => new AbortController());
  const attempts = candidates.map((b, i) => tryList(b, controllers[i].signal).then(value => {
    controllers.forEach((controller, j) => { if (j !== i) { try { controller.abort(new Error('cancel')); } catch { /* 另一条路已经不需要了 */ } } });
    return value;
  }));
  let value;
  try { value = await Promise.any(attempts); }
  catch (agg) {
    const fails = (agg && agg.errors) || [];
    // 端点回了话（401/403/404…）比“连不上”更能指导客户改哪里，优先报它
    throw fails.find(e => e?.status === 401 || e?.status === 403) || fails.find(e => e?.status) || fails[0] || new Error('模型列表获取失败');
  }
  modelListCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

// ---------- 通用对话客户端 ----------
// messages：OpenAI 格式（可含 tool 消息、assistant.tool_calls、多模态 content）。tools：OpenAI function 定义。
// 返回 { text, toolCalls:[{id,name,arguments(字符串)}], finishReason, usage, model, message(可直接追加进 messages 的 assistant 消息) }
export async function chatDock(config, id, { messages, tools, toolChoice, signal, maxTokens, temperature, model, effort, onDelta, firstTokenSec, timeoutSec, stallSec } = {}) {
  const d = dockEntry(config, id);
  if (!d) throw new Error('拓展坞里没有这个模型：' + id);
  const key = dockKey(config, id);
  if (!key) throw new Error(`${d.name} 没有配置密钥`);
  const reasoning = validateDockEffort(config, id, effort, model);
  const body = { model: model || d.model, messages, stream: true, max_tokens: maxTokens || d.maxTokens || 8192, ...reasoning.parameters,
    ...(temperature != null ? { temperature } : {}), ...(tools?.length ? { tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) } : {}) };
  const ac = new AbortController();
  const relay = () => ac.abort(new Error('cancel'));
  signal?.addEventListener('abort', relay, { once: true });
  const firstMs = (firstTokenSec || d.firstTokenSec || 120) * 1000;
  // 超时来自（优先级）：本次调用参数 → 该模型的单独设置 → 全局设置（设置面板里的「拓展坞单次超时 / 卡住多久算卡住」）
  const flowStall = Number(config?.flow?.dockStallSec);
  const flowTimeoutMin = Number(config?.flow?.dockTimeoutMin);
  const stallMs = Math.max(1000, Number(stallSec ?? d.stallSec ?? (Number.isFinite(flowStall) && flowStall > 0 ? flowStall : 90)) * 1000);
  // 0 = 不限：不设整体超时，只靠「卡住看门狗」兜底
  const totalSec = Number(timeoutSec ?? d.timeoutSec ?? (Number.isFinite(flowTimeoutMin) && flowTimeoutMin > 0 ? flowTimeoutMin * 60 : 0));
  const total = totalSec > 0 ? setTimeout(() => ac.abort(new Error('total')), totalSec * 1000) : null;
  let first = setTimeout(() => ac.abort(new Error('first')), firstMs);
  // 卡住看门狗：只要还在持续产出就让它继续想；连续 stallMs 没有任何数据才中止。
  let stall = setTimeout(() => ac.abort(new Error('stall')), stallMs);
  const gotFirst = () => { if (first) { clearTimeout(first); first = null; } };
  const keepAlive = () => { if (stall) { clearTimeout(stall); stall = setTimeout(() => ac.abort(new Error('stall')), stallMs); } };
  let sawReasoning = 0, sawText = 0, usageSeen = null;
  const why = e => {
    const r = String(ac.signal.reason?.message || e.message);
    if (r === 'cancel') throw abortError(signal);
    return r === 'first' ? `首字超时（${firstMs / 1000} 秒内没有任何输出）` : r === 'stall' ? `卡住（连续 ${stallMs / 1000} 秒没有任何输出）` : r === 'total' ? '整体超时' : '连不上：' + (e.cause?.code || e.message);
  };
  try {
    const post = async base => {
      try { return await fetch(base + '/chat/completions', { method: 'POST', headers: headers(key), body: JSON.stringify(body), signal: ac.signal }); }
      catch (e) {
        const err = new Error(`${d.name}：${why(e)}`);
        // 没连上/首字超时属于传输层问题：没花输出预算，可以重试。
        Object.assign(err, { code: 'CONNECT_OR_FIRST_TOKEN', nonRetryable: false, usage: null });
        throw err;
      }
    };
    let base = trimUrl(d.baseUrl);
    let r = await post(base);
    // 中转站常见情况：基础地址少了 /v1，根路径下的 /chat/completions 返回的是网站页面（HTML，状态 200 或 404）。
    // 这时自动补 /v1 再试一次，成功就把地址改正保存下来。
    if ((isHtml(r) || r.status === 404) && !hasVersion(base)) {
      await r.body?.cancel().catch(() => {});
      const fixed = base + '/v1', r2 = await post(fixed);
      if (r2.ok && !isHtml(r2)) { r = r2; base = fixed; d.baseUrl = fixed; try { setDockField(config, id, { baseUrl: fixed }); } catch { /* 改正保存失败不影响本次 */ } }
      else { await r2.body?.cancel().catch(() => {}); throw new Error(`${d.name}：地址返回的是网页而不是接口——基础地址一般要填到 /v1 这一级（例如 ${fixed}）`); }
    }
    if (isHtml(r)) { await r.body?.cancel().catch(() => {}); throw new Error(`${d.name}：地址返回的是网页而不是接口——请检查基础地址（一般要填到 /v1 这一级）`); }
    if (!r.ok) {
      const failure = dockHttpFailure(r.status, await r.text().catch(() => ''));
      throw Object.assign(new Error(`${d.name}：${failure.message}`), { status: r.status, failureKind: failure.failureKind, requiresAction: failure.requiresAction, nonRetryable: failure.requiresAction, usage: null });
    }
    // 有的网关忽略 stream，直接回整段 JSON
    if (!/event-stream/.test(r.headers.get('content-type') || '')) {
      const raw = await r.text().catch(() => '');
      let j = null; try { j = JSON.parse(raw); } catch { /* 下面报错 */ }
      gotFirst();
      const c = j?.choices?.[0];
      if (!c) throw new Error(`${d.name}：返回格式无法识别（${r.headers.get('content-type') || '无类型'}：${raw.replace(/\s+/g, ' ').slice(0, 120)}）`);
      const toolCalls = (c.message?.tool_calls || []).map(t => ({ id: t.id, name: t.function?.name, arguments: t.function?.arguments || '' }));
      return finish(c.message?.content || '', toolCalls, c.finish_reason, j.usage, j.model || null, c.message?.reasoning_content || '', c.message?.encrypted_content);
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', text = '', reasoningContent = '', encryptedContent, usage = null, seenModel = null, finishReason = null;
    const calls = new Map(); // index → {id,name,arguments}
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          if (ev.error) throw new Error(`${d.name}：流内错误 ${JSON.stringify(ev.error).slice(0, 200)}`);
          if (ev.model) { assertRequestedModel(ev.model); seenModel = ev.model; }
          if (ev.usage) { usage = ev.usage; usageSeen = ev.usage; }
          const c = ev.choices?.[0]; if (!c) continue;
          if (c.finish_reason) finishReason = c.finish_reason;
          const delta = c.delta || {};
          if (delta.content) { gotFirst(); keepAlive(); text += delta.content; sawText += delta.content.length; onDelta?.(delta.content); }
          if (delta.reasoning_content) { gotFirst(); keepAlive(); reasoningContent += delta.reasoning_content; sawReasoning += delta.reasoning_content.length; }
          if (delta.encrypted_content) encryptedContent = delta.encrypted_content;
          for (const t of delta.tool_calls || []) {
            gotFirst(); keepAlive();
            const k = t.index ?? calls.size;
            const cur = calls.get(k) || { id: '', name: '', arguments: '' };
            if (t.id) cur.id = t.id;
            if (t.function?.name) cur.name += t.function.name;
            if (t.function?.arguments) cur.arguments += t.function.arguments;
            calls.set(k, cur);
          }
        }
      }
    } catch (e) {
      if (e.message?.startsWith(d.name)) throw e;
      if (!text && !calls.size) {
        const spent = sawReasoning + sawText;
        const detail = spent
          ? `读取中断（${why(e)}；期间已收到 ${sawReasoning} 字符推理内容 / ${sawText} 字符正文，但一直没有最终答案）`
          : `读取中断（${why(e)}）`;
        const err = new Error(`${d.name}：${detail}`);
        // 已经花掉输出预算却没拿到答案：重试几乎必然再花一遍钱，不值得自动重试。
        Object.assign(err, {
          code: spent ? 'ABORTED_AFTER_OUTPUT' : 'ABORTED_NO_OUTPUT',
          nonRetryable: spent > 0,
          spentReasoningChars: sawReasoning, spentTextChars: sawText,
          usage: usageSeen, maxTokens: body.max_tokens,
          apiResponseEvidence: { model: seenModel, finishReason: finishReason || null, usage: usageSeen || null, reasoningOutputSeen: sawReasoning > 0, reasoningContentLength: sawReasoning, contentLength: sawText, maxTokens: body.max_tokens },
        });
        throw err;
      }
    }
    return finish(text, [...calls.values()].map(c => ({ ...c, id: c.id || 'call_' + randomUUID().slice(0, 8) })), finishReason, usage, seenModel, reasoningContent, encryptedContent);
  } finally {
    clearTimeout(total); if (first) clearTimeout(first); if (stall) clearTimeout(stall);
    signal?.removeEventListener('abort', relay);
  }
  function assertRequestedModel(seen) {
    const actualModel = typeof seen === 'string' && seen.trim() ? seen : null;
    if (actualModel && actualModel !== body.model) {
      const e = new Error(`${d.name}：模型不匹配：请求 ${body.model}，实际 ${actualModel}；未接受该结果或派发工具`);
      Object.assign(e, { modelError: true, requestedModel: body.model, actualModel, modelVerified: 'unknown', modelEvidence: { source: 'api-response', status: 'mismatch' } });
      ac.abort(e);
      throw e;
    }
    return actualModel;
  }
  function finish(text, toolCalls, finishReason, usage, seen, reasoningContent = '', encryptedContent) {
    if (!text.trim() && !toolCalls.length) {
      const reasoningLength = typeof reasoningContent === 'string' ? reasoningContent.length : 0;
      const detail = finishReason === 'length'
        ? reasoningLength ? '输出 token 预算耗尽；只返回了推理内容，没有最终答案或工具调用' : '输出 token 预算耗尽；没有最终答案或工具调用'
        : reasoningLength ? '只返回了推理内容，没有最终答案或工具调用' : '接口返回空答，没有最终答案或工具调用';
      const e = new Error(`${d.name}：${detail}${finishReason ? '（finish_reason=' + finishReason + '）' : ''}`);
      Object.assign(e, { code: finishReason === 'length' ? 'OUTPUT_BUDGET_EXHAUSTED' : 'EMPTY_API_RESPONSE',
        // 输出预算已经花完却没答案：原样重试必然再花一遍钱，标记为不可重试。
        nonRetryable: true, usage: usage || null, maxTokens: body.max_tokens, requestedModel: body.model,
        actualModel: typeof seen === 'string' && seen.trim() ? seen : null,
        apiResponseEvidence: { model: typeof seen === 'string' && seen.trim() ? seen : null, finishReason: finishReason || null, usage: usage || null,
          contentLength: text.length, toolCallsCount: toolCalls.length, reasoningOutputSeen: reasoningLength > 0, reasoningContentLength: reasoningLength, maxTokens: body.max_tokens } });
      throw e;
    }
    const message = { role: 'assistant', content: text || null,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}), ...(encryptedContent ? { encrypted_content: encryptedContent } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) } : {}) };
    const actualModel = assertRequestedModel(seen);
    return { text: text.trim(), toolCalls, finishReason, usage: usage || null, model: actualModel, requestedModel: body.model, actualModel,
      modelVerified: actualModel === body.model ? 'verified' : 'unknown', modelEvidence: { source: 'api-response', status: !actualModel ? 'missing' : 'matched' },
      effort: reasoning.effort, reasoning: { requestedEffort: reasoning.effort, status: reasoning.effort === 'auto' ? 'provider-default' : 'sent',
        capabilityStatus: reasoning.capability.status, evidenceStatus: reasoning.capability.evidenceStatus, parameterAccepted: reasoning.effort !== 'auto', effectVerified: false,
        parameters: reasoning.parameters }, message };
  }
}

// 给 BEAT 协作用的简单问答（与 askClaude 同形）：history 只存文字，图片只随当前这条发送。
export async function askDock(config, id, { prompt, system, history = [], images = [], signal, maxTokens, model, effort, onUsage }) {
  const d = dockEntry(config, id);
  const content = images.length && d?.vision !== false
    ? [...images.map(img => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })), { type: 'text', text: prompt }]
    : prompt + (images.length ? `\n（用户附了 ${images.length} 张图片，但 ${d?.name || '该模型'} 未开启图片输入）` : '');
  const messages = [...(system ? [{ role: 'system', content: system }] : []), ...history, { role: 'user', content }];
  const r = await chatDock(config, id, { messages, signal, maxTokens, model, effort });
  onUsage?.(r.usage);
  const textOnly = [...history, { role: 'user', content: prompt + (images.length ? `\n（附图 ${images.length} 张）` : '') }, { role: 'assistant', content: r.text }];
  return { text: r.text, model: r.model, requestedModel: r.requestedModel, actualModel: r.actualModel, modelVerified: r.modelVerified, modelEvidence: r.modelEvidence,
    usage:r.usage, effort: r.effort, reasoning: r.reasoning, history: textOnly.slice(-24) };
}

// 联通测试：列模型、实发一句、再试一次工具调用（操控电脑助手需要它）。
export async function testDock(config, id) {
  const d = dockEntry(config, id);
  if (!d) return { ok: false, error: '没有这个模型' };
  const out = { id, name: d.name, baseUrl: d.baseUrl, model: d.model };
  const t0 = Date.now();
  try { out.modelCount = (await listDockModels({ baseUrl: d.baseUrl, key: dockKey(config, id) })).models.length; }
  catch (e) {
    out.modelsError = e.message;
    // 连端点都连不上（网络/DNS/地址写错）：别再花二十秒去试对话和工具调用，直接如实报。
    if (e.code === 'CONNECT') return { ...out, ok: false, error: e.message, failureKind: 'connect', requiresAction: false, elapsedMs: Date.now() - t0 };
  }
  try {
    const r = await chatDock(config, id, { messages: [{ role: 'user', content: '只回复 OK' }], maxTokens: 32, firstTokenSec: 60, timeoutSec: 120 });
    Object.assign(out, { ok: true, answer: r.text.slice(0, 80), usedModel: r.model, requestedModel: r.requestedModel, actualModel: r.actualModel, modelVerified: r.modelVerified,
      modelEvidence: r.modelEvidence, reasoning: r.reasoning, elapsedMs: Date.now() - t0 });
  } catch (e) { return { ...out, ok: false, error: e.message, failureKind: e.failureKind, requiresAction: e.requiresAction === true, status: e.status, elapsedMs: Date.now() - t0 }; }
  try {
    const tool = { type: 'function', function: { name: 'get_time', description: '获取当前时间', parameters: { type: 'object', properties: { tz: { type: 'string', description: '时区' } }, required: ['tz'] } } };
    const r = await chatDock(config, id, { messages: [{ role: 'user', content: '调用 get_time 工具查询 Asia/Shanghai 的时间。' }], tools: [tool], maxTokens: 200, firstTokenSec: 60, timeoutSec: 120 });
    out.tools = r.toolCalls.some(c => c.name === 'get_time') ? 'supported' : 'no-call';
  } catch (e) { out.tools = 'error'; out.toolsError = e.message.slice(0, 160); }
  return out;
}

// ---------- 增删改（写 config.json / secrets.local.json） ----------
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
function writeJson(file, obj) {
  const tmp = file + '.tmp-' + randomUUID().slice(0, 8);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
const guessVision = m => /vl|vision|omni|4o|4v|qvq|-v\b|glm-4v|image|多模态/i.test(String(m || ''));

export function saveDockEntry(config, input) {
  const name = String(input.name || '').trim();
  const baseUrl = trimUrl(input.baseUrl);
  const model = String(input.model || '').trim();
  if (!name) throw new Error('请填写名称');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('基础地址要以 http:// 或 https:// 开头');
  if (!model || model.length > 200) throw new Error('请选择或填写模型');
  const cfg = readJson(config.configFile);
  const list = Array.isArray(cfg.dock) ? cfg.dock : [];
  const id = input.id && list.some(d => d.id === input.id) ? input.id : 'dock:' + randomUUID().slice(0, 8);
  const prev = list.find(d => d.id === id) || {};
  const declarationInput = Object.hasOwn(input, 'reasoningConfig') ? input.reasoningConfig : Object.hasOwn(input, 'reasoning') ? input.reasoning : prev.reasoningConfig ?? prev.reasoning;
  const reasoningConfig = normalizeDockReasoning(declarationInput, model);
  const defaultEffort = Object.hasOwn(input, 'defaultEffort') ? String(input.defaultEffort || 'auto') : prev.defaultEffort || 'auto';
  const entry = { id, name: name.slice(0, 40), preset: input.preset || prev.preset || 'custom', baseUrl, model,
    enabled: input.enabled !== false, vision: input.vision ?? prev.vision ?? guessVision(model),
    maxTokens: Number(input.maxTokens) || prev.maxTokens || 8192, models: Array.isArray(input.models) ? input.models.slice(0, 500) : prev.models || [],
    tools: prev.tools || null, reasoningConfig, defaultEffort, added_at: prev.added_at || new Date().toISOString() };
  validateDockEffort({ dock: [entry] }, id, defaultEffort);
  cfg.dock = prev.id ? list.map(d => (d.id === id ? entry : d)) : [...list, entry];
  writeJson(config.configFile, cfg);
  const key = String(input.apiKey || '').trim();
  if (key || !dockKey(config, id)) {
    if (!key) throw new Error('请填写密钥');
    const sec = readJson(config.secretFile);
    sec.dockKeys = { ...(sec.dockKeys || {}), [id]: key };
    writeJson(config.secretFile, sec);
  }
  return entry;
}

export function setDockField(config, id, fields) {
  const cfg = readJson(config.configFile);
  cfg.dock = (cfg.dock || []).map(d => (d.id === id ? { ...d, ...fields } : d));
  writeJson(config.configFile, cfg);
}

export function removeDockEntry(config, id) {
  const cfg = readJson(config.configFile);
  if (!(cfg.dock || []).some(d => d.id === id)) throw new Error('没有这个模型');
  cfg.dock = cfg.dock.filter(d => d.id !== id);
  writeJson(config.configFile, cfg);
  const sec = readJson(config.secretFile);
  if (sec.dockKeys) { delete sec.dockKeys[id]; writeJson(config.secretFile, sec); }
}

export function moveDockEntry(config, id, delta) {
  const cfg = readJson(config.configFile);
  const list = cfg.dock || [], i = list.findIndex(d => d.id === id), j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  writeJson(config.configFile, cfg);
}

// 看板用：不带密钥，只给掩码
export function dockView(config) {
  return dockList(config).map(d => {
    const k = dockKey(config, d.id);
    return { ...d, reasoningConfig: d.reasoningConfig ?? d.reasoning ?? null, reasoning: dockReasoning(config, d.id),
      defaultEffort: d.defaultEffort || 'auto', apiKey: k ? k.slice(0, 5) + '…' + k.slice(-4) : '', ready: dockReady(config, d.id) };
  });
}
