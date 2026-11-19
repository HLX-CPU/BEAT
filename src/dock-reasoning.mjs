// API 推理控制按端点与型号判断；模型名不证明中转网关会转发参数。
// 自定义端点可显式声明协议。声明和 HTTP 200 都不代表已验证实际推理强度。
const LABELS = { auto: '服务商默认', off: '关闭思考', on: '开启思考', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最大', minimal: '最小', none: '关闭思考', ultra: '极高' };
const PROTOCOLS = new Set(['glm', 'deepseek', 'thinking', 'enable-thinking', 'reasoning-effort']);
const AUTO = { value: 'auto', label: LABELS.auto };
const optionsFor = levels => [AUTO, ...levels.map(value => ({ value, label: LABELS[value] || value }))];
const SOURCES = {
  glm: 'https://docs.z.ai/api-reference/llm/chat-completion',
  deepseek: 'https://api-docs.deepseek.com/api/create-chat-completion/',
  kimi: 'https://github.com/MoonshotAI/Kimi-K3/blob/main/README.md',
  kimi25: 'https://huggingface.co/moonshotai/Kimi-K2.5',
  qwen: 'https://help.aliyun.com/zh/model-studio/deep-thinking',
};

function modelProfile(model) {
  const m = String(model || '').toLowerCase();
  if (/^glm-5\.3(?:-flash)?$/.test(m)) return { provider: 'glm', protocol: 'glm', levels: ['low', 'high', 'max'], providerDefault: 'max', source: SOURCES.glm };
  if (m === 'glm-5.2') return { provider: 'glm', protocol: 'glm', levels: ['off', 'high', 'max'], providerDefault: 'max', source: SOURCES.glm };
  if (/^(?:glm-5(?:\.1)?|glm-4\.(?:5(?:-(?:air|x|airx|flash))?|6|7(?:-flash|x)?))$/.test(m)) return { provider: 'glm', protocol: 'thinking', levels: ['off', 'on'], source: SOURCES.glm };
  if (['deepseek-flash', 'deepseek-v4-pro'].includes(m)) return { provider: 'deepseek', protocol: 'deepseek', levels: ['off', 'low', 'high', 'max'], providerDefault: 'high', source: SOURCES.deepseek };
  if (m === 'kimi-k3') return { provider: 'kimi', protocol: 'reasoning-effort', levels: ['low', 'high', 'max'], providerDefault: 'max', source: SOURCES.kimi };
  if (m === 'kimi-k2.5') return { provider: 'kimi', protocol: 'thinking', levels: ['off', 'on'], source: SOURCES.kimi25 };
  if (['qwen-plus', 'qwen-plus-latest', 'qwen-flash', 'qwen-turbo', 'qwen3-max', 'qwen3-max-2026-01-23', 'qwen3-max-preview', 'qwen3-235b-a22b', 'qwen3-32b', 'qwen3-30b-a3b', 'qwen3-14b', 'qwen3-8b'].includes(m)) return { provider: 'qwen', protocol: 'enable-thinking', levels: ['off', 'on'], source: SOURCES.qwen };
  return null;
}

function officialProvider(baseUrl) {
  let host; try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return null; }
  if (['open.bigmodel.cn', 'api.z.ai'].includes(host)) return 'glm';
  if (host === 'api.deepseek.com') return 'deepseek';
  if (['api.moonshot.cn', 'api.moonshot.ai', 'api.kimi.ai'].includes(host)) return 'kimi';
  if (['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(host)) return 'qwen';
  return null;
}

function protocolLevels(protocol, model) {
  if (protocol === 'thinking' || protocol === 'enable-thinking') return ['off', 'on'];
  if (protocol === 'deepseek') return ['off', 'low', 'high', 'max'];
  if (protocol === 'glm') return modelProfile(model)?.protocol === 'glm' ? modelProfile(model).levels : ['low', 'high', 'max'];
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
}

export function normalizeDockReasoning(value, model) {
  if (value == null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('推理能力声明应为对象');
  const protocol = String(value.protocol || '');
  if (!PROTOCOLS.has(protocol)) throw new Error('不支持的推理控制协议：' + protocol);
  const models = value.models == null ? [String(model || '')] : value.models;
  if (!Array.isArray(models) || !models.length || models.length > 100 || models.some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) throw new Error('推理能力声明需要明确的适用模型列表');
  const allowed = models.map(m => protocolLevels(protocol, m)).reduce((levels, next) => levels.filter(level => next.includes(level)));
  const levels = value.levels == null ? allowed : value.levels;
  if (!Array.isArray(levels) || !levels.length || levels.length > 12 || levels.some(v => typeof v !== 'string' || !allowed.includes(v))) throw new Error('推理强度列表不符合所选协议或型号');
  const source = String(value.source || '').trim();
  if (source && !/^https?:\/\//.test(source)) throw new Error('推理能力来源应为 http(s) 地址');
  return { protocol, levels: [...new Set(levels)], models: [...new Set(models)], ...(source ? { source: source.slice(0, 2000) } : {}) };
}

// 用于编辑页未保存时的能力预览；不联网、不把猜测当支持。
export function reasoningChoices(input = {}) {
  const model = String(input.model || '');
  const candidate = modelProfile(model);
  const declared = input.reasoningConfig ?? input.reasoning;
  let spec = null, evidenceStatus = 'unknown';
  if (declared) {
    const normalized = normalizeDockReasoning(declared, model);
    if (normalized.models.includes(model)) { spec = normalized; evidenceStatus = 'declared'; }
  } else if (candidate && officialProvider(input.baseUrl) === candidate.provider) {
    spec = candidate; evidenceStatus = 'documented';
  }
  const knownNonReasoning = officialProvider(input.baseUrl) === 'glm' && /^glm-4(?:-(?:flash|air|plus|long|0520|9b-chat))?$/.test(model.toLowerCase());
  const status = spec ? 'supported' : knownNonReasoning ? 'unsupported' : 'unknown';
  const defaultEffort = String(input.defaultEffort || 'auto');
  const levels = spec?.levels || [];
  return {
    status, supported: spec ? true : knownNonReasoning ? false : null, evidenceStatus,
    protocol: spec?.protocol || null, levels, options: optionsFor(levels), defaultEffort,
    defaultValid: defaultEffort === 'auto' || levels.includes(defaultEffort),
    source: spec?.source || null, providerDefault: spec?.providerDefault || null,
    effectVerified: false,
    note: evidenceStatus === 'documented' ? '官方端点文档支持；本次实际推理强度仍以服务商执行为准' : evidenceStatus === 'declared' ? '配置声明，未验证服务商实际采用该推理强度' : knownNonReasoning ? '该型号未提供推理控制' : '未确认端点是否转发推理控制参数；使用服务商默认',
    ...(candidate ? { candidate: { ...candidate, options: optionsFor(candidate.levels) } } : {}),
  };
}

export function dockReasoning(config, id, model) {
  const d = (config.dock || []).find(v => v.id === id);
  if (!d) throw new Error('拓展坞里没有这个模型：' + id);
  const declaration = d.reasoningConfig ?? d.reasoning;
  return reasoningChoices({ ...d, model: model || d.model, reasoningConfig: normalizeDockReasoning(declaration, d.model) });
}

// 把「已确认能力 + 选中的强度」翻译成请求参数。拓展坞与 Claude 顾问共用同一条判定，
// 避免一边允许的强度在另一边被静默忽略（AGENTS：不得静默忽略设置或替换模型）。
export function effortParameters(capability, effort) {
  const selected = effort == null || effort === '' ? capability.defaultEffort : String(effort);
  if (selected === 'auto') return { effort: selected, capability, parameters: {} };
  if (capability.status !== 'supported') throw new Error(capability.status === 'unknown' ? '推理强度支持未知：该端点需先声明已支持的推理协议，不能静默忽略设置' : '该模型不支持推理强度设置');
  if (!capability.levels.includes(selected)) throw new Error(`该模型不支持推理强度 ${selected}；可选：${capability.levels.join(' / ')}`);
  const off = selected === 'off';
  let parameters;
  switch (capability.protocol) {
    case 'glm': parameters = off ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: selected }; break;
    case 'deepseek': parameters = off ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: selected }; break;
    case 'thinking': parameters = { thinking: { type: off ? 'disabled' : 'enabled' } }; break;
    case 'enable-thinking': parameters = { enable_thinking: !off }; break;
    case 'reasoning-effort': parameters = { reasoning_effort: selected }; break;
    default: throw new Error('不支持的推理控制协议');
  }
  return { effort: selected, capability, parameters };
}

export function validateDockEffort(config, id, effort, model) {
  return effortParameters(dockReasoning(config, id, model), effort);
}
