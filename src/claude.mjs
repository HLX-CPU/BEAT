// Claude 顾问 / 备用大脑：第三方号池（OpenAI 兼容或 Anthropic 协议）。
// 注意：该类网关只对 stream:true 正常返回，非流式会挂到超时，所以这里固定走 SSE。
import { redact } from './config.mjs';
import { abortError } from './proc.mjs';
import { reasoningChoices, effortParameters } from './dock-reasoning.mjs';
import { listDockModels } from './dock.mjs';

const detected = new Map(); // baseUrl → 已探明的协议

// 顾问是只读角色：第三方模型默认会把自己当“通用编码助手”，会在自我介绍或建议里
// 声称能写代码、执行操作（R471 实测）。每次请求都显式注入角色边界。
export const ADVISOR_ROLE = '你是 BEAT 的只读顾问 Claude：只提供分析、建议和核验意见；不领取执行任务、不修改文件、不操作电脑，也不要声称自己能执行或已经执行过任何操作。';
export function advisorSystem(system) { return [ADVISOR_ROLE, system].filter(Boolean).join('\n\n'); }

function explain(status, body) {
  const b = String(body || '');
  if (/API_KEY_DISABLED/.test(b)) return '密钥被站点禁用，请到站点后台启用';
  if (/invalid api key|API_KEY_INVALID|unauthorized/i.test(b) || status === 401) return '密钥无效或与站点不匹配';
  if (/555420|deployment request could not be completed/i.test(b)) return '上游拒绝该部署：号池分组未开通或额度不足';
  if (status === 404) return '接口路径不存在（协议可能不对）';
  if (status === 429) return '限流或额度用尽';
  if (status >= 500) return `站点/上游故障（HTTP ${status}）`;
  return `HTTP ${status}：${b.replace(/\s+/g, ' ').slice(0, 200)}`;
}

// 「未配置」与「设置里关掉了」是两件事：停用的顾问既不参与讨论，也不该被当成坏账号冷却，
// 所以 roster 会把 enabled=false 显示成已暂停（与拓展坞的「启用」一致）。
export function claudeEnabled(config) { return config?.claude?.enabled !== false; }
export function claudeReady(config) { return claudeEnabled(config) && !!(config?.secrets?.claudeApiKey && config.claude?.baseUrl && config.claude?.model); }

// 顾问推理能力：与拓展坞共用同一套判定；未声明协议时只能选「由接口决定」。
export function claudeReasoning(config, { baseUrl, model, reasoning } = {}) {
  const c = config?.claude || {};
  return reasoningChoices({ baseUrl: baseUrl || c.baseUrl, model: model || c.model,
    reasoningConfig: reasoning === undefined ? (c.reasoningConfig ?? null) : reasoning, defaultEffort: c.defaultEffort ?? null });
}
// 本次请求实际要带的推理参数：默认 run 用 config.claude.defaultEffort，也可以按会话临时指定。
function advisorEffort(config, model, effort) {
  const capability = claudeReasoning(config, { model });
  return effortParameters(capability, effort ?? config.claude.defaultEffort ?? null);
}

// 顾问站点地址的两种常见写法都必须能用：填站点根（https://host）或按拓展坞的提示填到 /v1
// （https://host/v1），也允许把完整接口地址直接粘进来。以前这里无条件拼 '/v1/…'，
// 客户照提示填了 /v1 就变成 /v1/v1/…，测试直接回 404（实测 2026-10-17 客户配置）。
export function advisorEndpointCandidates(baseUrl, protocol = 'openai') {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/(chat\/completions|messages|models)$/i, '');
  if (!/^https?:\/\//i.test(raw)) return [];
  const suffix = protocol === 'anthropic' ? '/messages' : '/chat/completions';
  const versioned = /\/v\d+[a-z0-9]*$/i.test(raw) || /\/(?:api\/paas|compatible-mode)\/v\d+[a-z0-9]*$/i.test(raw);
  const candidates = [versioned ? raw + suffix : raw + '/v1' + suffix, raw + suffix];
  if (!versioned) candidates.push(raw + '/v1' + suffix);
  return [...new Set(candidates)];
}

async function streamOnce(config, { url, protocol, messages, system, model, maxTokens, signal, onDelta, reasoningParameters = {} }) {
  const c = config.claude, key = config.secrets.claudeApiKey;
  // 推理强度只按客户声明的协议注入 OpenAI 兼容请求；Anthropic 原生协议不接受这些参数，
  // 调用方会在那之前明确报错，绝不静默丢掉客户选的强度。
  const body = protocol === 'anthropic'
    ? { model, max_tokens: maxTokens, stream: true, ...(system ? { system } : {}), messages }
    : { model, max_tokens: maxTokens, stream: true, ...reasoningParameters, messages: system ? [{ role: 'system', content: system }, ...messages] : messages };
  const ac = new AbortController();
  const relay = () => ac.abort(new Error('cancel'));
  signal?.addEventListener('abort', relay, { once: true });
  const total = setTimeout(() => ac.abort(new Error('total')), (c.timeoutSec || 900) * 1000);
  let first = setTimeout(() => ac.abort(new Error('first')), (c.firstTokenSec || 90) * 1000);
  const t0 = Date.now();
  let text = '', seenModel = model;
  const why = e => {
    const r = String(ac.signal.reason?.message || e.message);
    if (r === 'cancel') throw abortError(signal);
    return r === 'first' ? `首字超时（${c.firstTokenSec || 90} 秒内上游没有任何输出，多为号池排队）` : r === 'total' ? `整体超时（${c.timeoutSec || 900} 秒）` : '站点不可达：' + e.message;
  };
  try {
    let r;
    try {
      r = await fetch(url, { method: 'POST', signal: ac.signal, body: JSON.stringify(body),
        headers: { authorization: 'Bearer ' + key, 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: 'text/event-stream' } });
    } catch (e) { return { ok: false, error: why(e) }; }
    if (!r.ok) return { ok: false, status: r.status, error: explain(r.status, redact(await r.text().catch(() => ''), config)) };
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
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
          if (ev.type === 'error' || ev.error) return { ok: false, error: '流内错误：' + JSON.stringify(ev.error || ev).slice(0, 300) };
          const delta = protocol === 'anthropic' ? (ev.type === 'content_block_delta' ? ev.delta?.text : null) : ev.choices?.[0]?.delta?.content;
          if (protocol === 'anthropic' && ev.type === 'message_start') seenModel = ev.message?.model || seenModel;
          if (protocol !== 'anthropic' && ev.model) seenModel = ev.model;
          if (delta) { if (first) { clearTimeout(first); first = null; } text += delta; onDelta?.(delta); }
        }
      }
    } catch (e) { if (!text) return { ok: false, error: '读取中断：' + why(e) }; }
    if (!text.trim()) return { ok: false, error: '流结束但没有任何文本' };
    return { ok: true, text: text.trim(), model: seenModel, latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(total); if (first) clearTimeout(first);
    signal?.removeEventListener('abort', relay);
  }
}

// 本条消息带图片时按协议转成多模态内容；历史里只保留文字（避免每轮重发大图）。
function withImages(protocol, text, images) {
  if (!images?.length) return text;
  const parts = images.map(img => (protocol === 'anthropic'
    ? { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } }
    : { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } }));
  return [...parts, { type: 'text', text }];
}

// history: [{role:'user'|'assistant', content}]，用于续问。返回新的 history。images: [{mime, data(base64), name}]
export async function askClaude(config, { prompt, system, history = [], model, signal, maxTokens, images = [], effort }) {
  if (!claudeReady(config)) throw new Error(!claudeEnabled(config) ? 'Claude 顾问已在设置里关闭：需要时先在「设置 → Claude 顾问连接」里开启' : 'Claude 未配置：请在看板「设置」里填写站点、密钥和模型');
  const c = config.claude;
  const reasoning = advisorEffort(config, model, effort);
  const useImages = images.length > 0 && c.vision !== false;
  const textOnly = [...history, { role: 'user', content: prompt + (images.length ? `\n（附图 ${images.length} 张：${images.map(i => i.name).join('、')}）` : '') }];
  const imageNote = images.length && !useImages ? `\n（用户附了 ${images.length} 张图片，但顾问未开启图片输入）` : '';
  const protocols = c.protocol && c.protocol !== 'auto' ? [c.protocol] : [detected.get(c.baseUrl) || 'openai', detected.get(c.baseUrl) === 'anthropic' ? 'openai' : 'anthropic'];
  // 已声明的推理协议都是 OpenAI 兼容协议族的参数，Anthropic 原生 /v1/messages 不收；
  // 遇到这种情况明确报错（不静默忽略客户选的强度），并让 OpenAI 兼容路径先试。
  const parameters = reasoning.parameters || {};
  const hasParameters = Object.keys(parameters).length > 0;
  const usable = hasParameters ? protocols.filter(p => p === 'openai') : protocols;
  if (!usable.length) throw new Error('顾问的推理协议声明（' + (reasoning.capability?.protocol || '') + '）只适用于 OpenAI 兼容协议：请把接口协议改成 openai，或清除「推理协议」声明后再试');
  // 每个协议按"候选地址写法"依次试：根站点、已带 /v1、直接粘完整接口地址都能用。
  let last;
  for (const protocol of usable) {
    const messages = [...history, { role: 'user', content: useImages ? withImages(protocol, prompt, images) : prompt + imageNote }];
    const urls = advisorEndpointCandidates(c.baseUrl, protocol);
    if (!urls.length) throw new Error('顾问站点地址无效：要以 http:// 或 https:// 开头');
    for (const url of urls) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        last = await streamOnce(config, { url, protocol, messages, system: advisorSystem(system), model: model || c.model, maxTokens: maxTokens || c.maxTokens || 8192, signal, reasoningParameters: parameters });
        if (last.ok) {
          detected.set(c.baseUrl, protocol);
          return { text: last.text, model: last.model, effort: reasoning.effort,
            reasoning: { requestedEffort: reasoning.effort, status: reasoning.effort === 'auto' ? 'provider-default' : 'sent',
              capabilityStatus: reasoning.capability?.status || null, evidenceStatus: reasoning.capability?.evidenceStatus || null,
              parameterAccepted: reasoning.effort !== 'auto', effectVerified: false, parameters },
            history: [...textOnly, { role: 'assistant', content: last.text }].slice(-24) };
        }
        if (last.status === 404) break;   // 这个写法在这台网关上不存在：换下一个候选地址（再换协议）
        const transient = !last.status || last.status >= 500 || last.status === 429 || /上游|超时|中断/.test(last.error);
        if (!transient) throw new Error('Claude 调用失败：' + last.error);
        if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  if (last?.status === 404) throw new Error('Claude 调用失败：接口路径不存在。站点地址可能多了或少了 /v1（两种写法都支持），也可能是协议不对——可在「自定义端点」里把接口协议改成 openai 或 anthropic 再试');
  throw new Error('Claude 调用失败：' + (last?.error || '站点没有返回可用结果'));
}

export async function testClaude(config) {
  const out = { baseUrl: config.claude.baseUrl, model: config.claude.model, name: config.claude.name || 'Claude',
    vision: config.claude.vision !== false, protocol: config.claude.protocol || 'auto', ...(() => { try { const r = claudeReasoning(config); return { effort: r.defaultEffort, reasoning: r }; } catch (e) { return { reasoningError: e.message }; } })() };
  if (!claudeEnabled(config)) return { ...out, ok: false, enabled: false, error: '顾问已在设置里关闭；开启后再测试' };
  if (!claudeReady(config)) return { ...out, ok: false, error: '未配置密钥' };
  try {
    // 与拓展坞同一个模型列表实现：自动处理"根地址 / 带 /v1 / 完整接口地址"三种写法。
    const listed = await listDockModels({ baseUrl: config.claude.baseUrl, key: config.secrets.claudeApiKey });
    out.models = listed.models.map(m => m.id).filter(id => /claude|opus|sonnet|haiku|fable/i.test(id));
    if (listed.baseUrl && listed.baseUrl !== config.claude.baseUrl) out.detectedBaseUrl = listed.baseUrl;
  } catch (e) {
    out.modelsError = '模型列表获取失败：' + e.message;
    // 网络/DNS 层面就连不上：别再等对话请求超时，直接把原因和下一步给客户。
    if (e.code === 'CONNECT') return { ...out, ok: false, failureKind: 'connect', error: e.message, elapsedMs: 0 };
  }
  const t0 = Date.now();
  try {
    const a = await askClaude({ ...config, claude: { ...config.claude, firstTokenSec: 60, timeoutSec: 120 } }, { prompt: '只回复 OK', maxTokens: 16 });
    return { ...out, ok: true, answer: a.text, usedModel: a.model, wireProtocol: detected.get(config.claude.baseUrl) || null,
      sentEffort: a.effort, reasoning: a.reasoning || out.reasoning, elapsedMs: Date.now() - t0 };
  } catch (e) { return { ...out, ok: false, error: e.message, elapsedMs: Date.now() - t0 }; }
}

// 开工前的顾问预检：同一个站点在 TTL 内只探一次。
// 目的：不要等到跑到核验那一刻才发现顾问号池欠费——R363 实测那一轮在 403 之前已经烧掉 57 万 token，
// 而且核验人一缺席整项验收就废了。探到永久性问题（欠费/密钥）就交给名册按现有冷却机制下线，后续选人自动跳过它。
// 预检只回答“能不能用”，不做任何任务动作；探不通不阻塞开工。
const preflightCache = new Map(); // baseUrl → { at, ok, error }
export function resetClaudePreflight() { preflightCache.clear(); }
export async function claudePreflight(config, { ttlMs = 10 * 60 * 1000 } = {}) {
  if (!claudeEnabled(config)) return { ok: false, skipped: true, disabled: true, error: '顾问已在设置里关闭' };
  if (!claudeReady(config)) return { ok: false, skipped: true, error: '未配置密钥' };
  const key = config.claude.baseUrl;
  const hit = preflightCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return { ...hit, cached: true };
  let result;
  try {
    const r = await testClaude(config);
    result = r.ok ? { ok: true } : { ok: false, error: r.error || r.modelsError || '预检失败但未给出原因' };
  } catch (e) { result = { ok: false, error: e.message } }
  preflightCache.set(key, { ...result, at: Date.now() });
  return result;
}
