import {explicitTextReferenceOnly} from './local-controller-text-reference.mjs';
import {wantsAction} from './quick-work.mjs';
import { LOCAL_DISPATCH_SCHEMA_VERSION, LOCAL_DISPATCH_JSON_SCHEMA, localDispatchPrompt, validateLocalDispatch, localDispatchPolicy, dispatchTaskId } from './local-controller-dispatch.mjs';
export { LOCAL_DISPATCH_SCHEMA_VERSION, LOCAL_DISPATCH_JSON_SCHEMA, localDispatchPrompt, validateLocalDispatch, localDispatchPolicy, dispatchTaskId };
// 本地 DeepSeek 控制器的传输层。
// 这里只负责连接本机 Ollama、生成控制建议并保留原始证据；
// 严格决策格式、安全裁决和真正接管调度由后续阶段实现。

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const LOCAL_CONTROLLER_DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'off',
  // auto：优先用本机 Ollama 上的本地 DS；本机没有（或没跑）时，自动改用客户接入的中转站 API 模型。
  // local / api：客户显式指定来源，不做自动切换。
  provider: 'auto',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'deepseek-r1:14b',
  // 中转站（任意 OpenAI 兼容接口）作为控制器：地址与模型存 config，密钥只存 secrets。
  apiBaseUrl: '',
  apiModel: '',
  apiProtocol: 'openai',
  timeoutSec: 180,
  keepAlive: '10m',
});

export const LOCAL_DECISION_SCHEMA_VERSION = 1;
export const LOCAL_DECISION_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'taskType', 'risk', 'flow', 'assignees', 'budget', 'requiresHuman', 'confidence', 'reasons'],
  properties: {
    schemaVersion: { type: 'integer', const: LOCAL_DECISION_SCHEMA_VERSION },
    taskType: { type: 'string', enum: ['question', 'discussion', 'execution'] },
    risk: {
      type: 'object', additionalProperties: false,
      required: ['level', 'reasons', 'irreversible', 'money', 'computerInput'],
      properties: {
        level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        reasons: { type: 'array', maxItems: 8, items: { type: 'string' } },
        irreversible: { type: 'boolean' }, money: { type: 'boolean' }, computerInput: { type: 'boolean' },
      },
    },
    flow: {
      type: 'object', additionalProperties: false,
      required: ['kind', 'maxDebates', 'maxRounds', 'maxParallelTasks'],
      properties: {
        kind: { type: 'string', enum: ['direct', 'compact-discussion', 'parallel'] },
        maxDebates: { type: 'integer', minimum: 0, maximum: 3 },
        maxRounds: { type: 'integer', minimum: 1, maximum: 8 },
        maxParallelTasks: { type: 'integer', minimum: 1, maximum: 8 },
      },
    },
    assignees: {
      type: 'object', additionalProperties: false,
      required: ['strong', 'cheap'],
      properties: { strong: { type: ['string', 'null'] }, cheap: { type: 'array', maxItems: 16, items: { type: 'string' } } },
    },
    budget: {
      type: 'object', additionalProperties: false,
      required: ['discussionTokens', 'executionTokens', 'taskTokens'],
      properties: {
        discussionTokens: { type: 'integer', minimum: 256, maximum: 10000000 },
        executionTokens: { type: 'integer', minimum: 256, maximum: 10000000 },
        taskTokens: { type: 'integer', minimum: 256, maximum: 10000000 },
      },
    },
    requiresHuman: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasons: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
  },
});

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);

export function normalizeLocalControllerConfig(value = {}) {
  const input = plainObject(value) ? value : {};
  const out = { ...LOCAL_CONTROLLER_DEFAULTS, ...input };
  let url;
  try { url = new URL(out.baseUrl); } catch { throw new Error('本地控制器地址无效'); }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('本地控制器只允许连接这台电脑上的 Ollama');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('本地控制器地址不能包含账号、密码或查询参数');
  out.baseUrl = url.origin;
  if (typeof out.enabled !== 'boolean') throw new Error('本地控制器开关必须为开启或关闭');
  if (!['off', 'shadow', 'low-risk', 'full'].includes(out.mode)) throw new Error('本地控制器模式必须为关闭、影子、低风险或完整控制');
  if (typeof out.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(out.model)) throw new Error('本地控制器模型名称无效');
  if (!Number.isFinite(out.timeoutSec) || out.timeoutSec < 10 || out.timeoutSec > 900) throw new Error('本地控制器等待时间必须为 10 到 900 秒');
  if (typeof out.keepAlive !== 'string' || !/^\d+(?:ms|s|m|h)$/.test(out.keepAlive)) throw new Error('本地控制器驻留时间无效');
  // ---- 控制器来源：本机 Ollama 或中转站 API（OpenAI 兼容）----
  if (!['auto', 'local', 'api'].includes(out.provider)) throw new Error('控制器来源必须是自动、本机 Ollama 或中转站 API');
  out.apiProtocol = String(out.apiProtocol || 'openai').toLowerCase();
  if (out.apiProtocol !== 'openai') throw new Error('中转站 API 目前只支持 OpenAI 兼容协议');
  out.apiBaseUrl = String(out.apiBaseUrl || '').trim().replace(/\/+$/, '');
  if (out.apiBaseUrl) {
    let apiUrl;
    try { apiUrl = new URL(out.apiBaseUrl); } catch { throw new Error('中转站 API 地址无效'); }
    if (!['http:', 'https:'].includes(apiUrl.protocol)) throw new Error('中转站 API 地址必须以 http:// 或 https:// 开头');
    if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) throw new Error('中转站 API 地址不能包含账号、密码或查询参数');
    out.apiBaseUrl = (apiUrl.origin + apiUrl.pathname).replace(/\/+$/, '');
  }
  out.apiModel = String(out.apiModel || '').trim();
  if (out.apiModel && out.apiModel.length > 200) throw new Error('中转站模型 ID 过长');
  if (out.provider === 'api') {
    if (!out.apiBaseUrl) throw new Error('请填写中转站 API 站点地址');
    if (!out.apiModel) throw new Error('请选择或填写中转站模型 ID');
  }
  return out;
}

export function localControllerPrompt({ goal, cwd, availablePartners = [], limits = {}, context = '' }) {
  return [
    '你是 BEAT 的本地任务控制顾问，负责为用户目标选择执行计划，返回 JSON 决策。',
    'taskType 描述的是用户要求 BEAT 完成的目标，不是你当前输出 JSON 的行为。你只输出计划，并不意味着用户任务是 question。',
    '例如用户要求新建或修改文件、运行命令时，即使这些动作稍后由执行搭档完成，也必须选择 taskType=execution；不能改成只回答或指导用户。',
    '请根据用户目标判断任务类型、风险、推荐流程、执行者和预算。输出计划期间不要调用工具或执行动作。',
    '必须严格按照提供的 JSON Schema 返回一个对象，不得添加字段或输出解释文字。',
    'taskType=question 仅限纯回答且不改文件、不运行命令；taskType=discussion 仅限多方讨论且不执行；只要要写文件、运行命令或操作电脑，taskType 必须为 execution。',
    'flow.kind=direct 用于纯问答或单人可验证的小任务；compact-discussion 用于只读讨论；parallel 用于需要分工执行的任务。',
    '字段必须一致：taskType=question 时 flow.kind 只能为 direct；taskType=discussion 时只能为 compact-discussion，即使多人讨论也不能填 parallel。',
    `用户目标：${String(goal || '').trim()}`,
    `工作目录：${String(cwd || '').trim() || '未知'}`,
    `当前可用搭档：${availablePartners.length ? availablePartners.join('、') : '未知'}`,
    'assignees.strong 只能是上面列出的一个搭档 ID 或 null，assignees.cheap 也只能从该列表选择；不得填写 current_user、user 或未列出的名字。',
    'requiresHuman 只在资金、不可逆、未知电脑输入或现有安全规则确实要求确认时为 true；工作区内新建普通文件、只读检查和已注册检查不需要人工确认。',
    'confidence 必须是 0 到 1 的小数，例如 0.95，绝不能填写百分数 95 或 100。reasons 最多 3 条，每条不超过 40 字。',
    'computerInput 表示敏感或未知结果的电脑输入，例如凭据输入、付款、对外发送及无回执的点击。通过文件接口新建工作区普通文件不属于 computerInput，应该为 false。',
    '把报告发给客户邮箱属于执行和对外发送，必须保留 computerInput=true 和人工确认；不能把实际发送改写为仅指导用户。',
    `预算边界：${JSON.stringify(limits || {})}`,
    context ? `补充上下文：${String(context).slice(0, 12000)}` : '',
    '不得把高风险、资金、不可逆或未知电脑输入判断成可自动执行。',
  ].filter(Boolean).join('\n');
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new Error(`${label}必须为对象`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`${label}包含不允许的字段：${extra.join('、')}`);
  for (const key of allowed) if (!(key in value)) throw new Error(`${label}缺少字段：${key}`);
}

function stringArray(value, label, { min = 0, max = 16 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 500)) throw new Error(`${label}必须为 ${min} 到 ${max} 条短文本`);
  return value.map(item => item.trim());
}

function boundedInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}必须为 ${min} 到 ${max} 的整数`);
  return value;
}

const PROFESSIONAL_ADVICE_RISK = '涉及个人医疗或法律决策，内容风险不能按只读操作降级';

// Remove only a contiguous declared non-action, not the rest of a sentence.
// A later positive request is still scanned, and double negation stays guarded.
function operationalIntent(text) {
  const nonAction = /(?:不要|不必|无需|禁止|别|不)(?:再)?(?:帮我|替我)?(?:付款|购买|付费|订阅|扣款|充值|转账|开通|续费|覆盖|删除|清空|抹掉)(?:任何)?(?:原文件|现有文件|源文件|原数据)?|\b(?:do not|don't|never|no need to)\s+(?:help me\s+)?(?:buy|purchase|pay|transfer|charge|top[ -]?up|overwrite|delete|erase|truncate)\b/g;
  let result = '', cursor = 0;
  for (const item of text.matchAll(nonAction)) {
    const prefix = result + text.slice(cursor, item.index);
    const clause = prefix.split(/[，,。.;；!！?？\n]/).at(-1).replace(/\s/g, '');
    // Only complete, clause-leading non-actions are understood. Unknown
    // prefixes (including every form of double negation) remain unmodified.
    const declaration = /^(?:(?:请|也|并|并且|同时|以及|且|但|另外))*$/.test(clause);
    result = prefix + (declaration ? '' : item[0]);
    cursor = item.index + item[0].length;
  }
  return result + text.slice(cursor);
}

export function detectGoalRisk(goal = '') {
  if(explicitTextReferenceOnly(goal))return {level:'low',money:false,computerInput:false,irreversible:false,reasons:[]};
  const text = String(goal).toLowerCase();
  const actionText = operationalIntent(text);
  const hits = [];
  const match = (pattern, reason) => { if (pattern.test(actionText)) hits.push(reason); };
  match(/\b(purchase|buy|paid|payment|subscribe)\b|购买|付费|付款|订阅/, '涉及资金或付费承诺');
  // New financial synonyms need an action request, not a bare reference such
  // as "不转账，只解释转账失败提示". Keep existing conservative rules intact.
  const fundsIntent = actionText;
  const fundsAction = /(?:帮我|替我|请|现在|发起|执行|进行|再次|继续|接着).{0,8}(?:扣款|充值|转账)|(?:扣款|充值|转账).{0,12}(?:重试|接着|继续)|(?:不要|不能|禁止|不许)不(?:扣款|充值|转账)|转账(?:给|到|至)|\bcharge\s+(?:my|the)\b|\btop[ -]?up\s+(?:my|the)\b|\b(?:make|send|repeat)\s+(?:a\s+)?bank\s+transfer\b/;
  const directFunds = /\b(?:pay|transfer)\s+(?:[$€£¥]\s*\d[\d,.]*|\d[\d,.]*\s*(?:usd|cny|eur|gbp|dollars?|yuan)\b)|\btransfer\s+(?:(?:the|my|these|those|some|all)\s+)?(?:money|funds|balance)\b|\bpay\s+(?:the|my|this|that|an?)\s+(?:[a-z-]+\s+){0,5}(?:bill|invoice|fee|deposit|balance)\b/;
  if (fundsAction.test(fundsIntent) || directFunds.test(fundsIntent)) hits.push('涉及资金或付费承诺');
  // Unparsed negated financial verbs are ambiguous, so retain their gate.
  match(/(?:不要|不必|无需|禁止|别|不)(?:再)?(?:帮我|替我)?(?:扣款|充值|转账)/, '涉及资金或付费承诺');
  const paidActivation = /(?:开通|订购|办理|激活|续订|续费).{0,40}(?:[1-9]\d*(?:\.\d+)?\s*(?:元|块|人民币|美元)|0\.\d*[1-9]\d*\s*元|付费|收费|订阅)|\b(?:activate|renew|enroll)\b.{0,40}(?:[$€£¥]\s*[1-9]|paid|subscription)/.test(actionText);
  if (paidActivation && !hits.includes('涉及资金或付费承诺')) hits.push('涉及资金或付费承诺');
  match(/\b(password|passcode|credential|secret)\b|密码|口令|凭据|密钥/, '涉及敏感输入或凭据');
  match(/\b(send|email|message|publish|post)\b.{0,30}\b(external|customer|public|recipient)\b|对外发送|发送邮件|发给客户|公开发布/, '涉及对外发送或发布');
  match(/\b(delete|remove|erase|overwrite|truncate|drop)\b|删除|清空|覆盖|抹掉/, '涉及删除、清空或覆盖');
  match(/\b(production|prod)\b.{0,30}\b(database|db)\b|生产数据库|线上数据库/, '涉及生产数据库');
  match(/\b(refactor)\b.{0,40}\b(several|multiple|modules?)\b|多模块重构|重构多个/, '涉及多模块重构');
  match(/\b(install|add|upgrade)\b.{0,30}\b(dependency|package)\b|\blockfile\b|安装依赖|更新锁文件/, '涉及依赖或锁文件变更');
  const uncertain = /不确定|不知道|不清楚|无法确认|未能确认|不能确认|结果未知|结果不明|没有回执|无回执|无响应|没有响应|没反应|未返回|没收到.{0,8}(?:成功|确认)|没有结果|卡住|卡死|断网|中断|超时|\b(unknown|uncertain|unsure|disconnected|unresponsive)\b|no\s+(?:response|confirmation|receipt)|not\s+sure|timed?\s*out/i.test(text);
  const priorInput = /提交|订单|下单|发布|按钮|点击|发送|付款|支付|扣款|充值|转账|授权|\b(submit\w*|orders?|publish\w*|buttons?|click\w*|send|sent|payments?|authoriz\w*|charged?)\b|bank\s+transfer|top[ -]?up/i.test(text);
  const resumeInput = /继续|接着|重试|再试|重来|补做|完成|(?:重新|再|补).{0,5}(?:点|点击|提交|发|操作|下单)|\b(continue|resume|retry|again|finish|complete|proceed|repeat|resubmit|resend)\b/i.test(text);
  if (uncertain && priorInput && resumeInput) hits.push('既有电脑输入结果未核验，继续前必须先核对，禁止直接重放');
  const medical = /化验|心电图|胸痛|抗凝|胰岛素|药(?!妆)|剂量|治疗|诊断|\b(medical|medication|medicine|pills?|dosage|diagnosis|treatment|anticoagulant|insulin)\b|chest\s+pain/i.test(text);
  // Remove only an explicitly negated advice phrase, never the surrounding
  // request: an appended disclaimer cannot erase a separate dosing decision.
  const decisionText = text.replace(/不(?:作|做|提供)(?:任何)?(?:医疗|医学|法律)?(?:判断|建议|诊断|决策)/g, '');
  const medicalDecision = /判断|能否|是否|可以|应该|要不要|该不该|需不需要|建议|停掉|停药|增减|调整|在家|自行|\b(should|can|stop|change|diagnose|decide|assess)\b/i.test(decisionText);
  const legal = /竞业|协议|合同|法律|律师|传票|催告|诉讼|离职|赔偿|仲裁|\b(legal|contract|agreement|lawsuit|noncompete|lawyer|attorney|summons)\b/i.test(text);
  // Generic "whether the dates match" is document checking, not legal advice.
  const legalDecision = /(?:有|无)效(?!期)|合法|违法|签|胜诉|承担|责任|(?:不|无需|不用)回应|(?:要不要|该不该|需不需要).{0,12}(?:回应|回函|答复|起诉)|(?:是否|能否|可否|要不要|该不该).{0,16}(?:接受|同意|履行|解除|终止|解约|拒付)|\b(valid|invalid|enforceable|sign|liable|sue|guaranteed|ignore)\b/i.test(decisionText);
  if ((medical && medicalDecision) || (legal && legalDecision)) hits.push(PROFESSIONAL_ADVICE_RISK);
  const money = hits.includes('涉及资金或付费承诺');
  const computerInput = paidActivation || hits.some(item => ['涉及敏感输入或凭据', '涉及对外发送或发布', '既有电脑输入结果未核验，继续前必须先核对，禁止直接重放'].includes(item));
  const irreversible = hits.some(item => ['涉及删除、清空或覆盖', '涉及生产数据库'].includes(item));
  const critical = hits.includes('涉及生产数据库') && irreversible;
  const medium = hits.some(item => ['涉及多模块重构', '涉及依赖或锁文件变更'].includes(item));
  return { level: critical ? 'critical' : money || computerInput || irreversible || hits.includes(PROFESSIONAL_ADVICE_RISK) ? 'high' : medium ? 'medium' : 'low', money, computerInput, irreversible, reasons: hits };
}

/** CX-12：识别“让搭档/多方一起讨论”的明确请求（只做识别，是否抬升由 validateLocalDecision 决定）。 */
export function explicitDiscussionRequest(goal = '') {
  const text = String(goal || '');
  if (/(?:让|请|叫|找|要求|需要)[^。；;\n]{0,10}(?:搭档|各方|多方|几位|大家|队友)[^。；;\n]{0,10}(?:讨论|商量|评审|评议|议一议|一起看|共同看|过一遍)/.test(text)) return true;
  if (/(?:搭档|各方|多方)[^。；;\n]{0,6}(?:讨论|商量|评审|评议)/.test(text)) return true;
  if (/(?:讨论|商量|评审)(?:一下|一遍|一轮)?[^。；;\n]{0,6}(?:这个|该|本|此)[^。；;\n]{0,8}(?:方案|取舍|设计|做法|风险|实现|思路)/.test(text)) return true;
  if (/(?:让|请|叫|找|要求|需要)[^。；;\n]{0,12}(?:搭档|各方|多方|几位|大家|队友)[^。；;\n]{0,12}(?:讨论|商量|评审|评议)/.test(text)) return true;
  return false;
}
/** CX-17：目标要求“读取/统计/核对工作区文件后回报”（即使只读、不写文件）——这是要做工，不是纯问答。 */
export function requiresWorkspaceWork(goal = '') {
  const text = String(goal || '');
  const reads = /(?:读取|读一下|读一下|查看|核对|统计|汇总|数一数|计算|提取|比对|比较|检查|列出)/.test(text);
  const fromFiles = /(?:工作区|工作目录|文件|日志|表格|清单|报告|数据|附件|csv|json|log|txt)/i.test(text);
  return reads && fromFiles;
}
export function validateLocalDecision(value, { partners = [], goal = '' } = {}) {
  const top = ['schemaVersion', 'taskType', 'risk', 'flow', 'assignees', 'budget', 'requiresHuman', 'confidence', 'reasons'];
  exactKeys(value, top, '本地控制决策');
  if (value.schemaVersion !== LOCAL_DECISION_SCHEMA_VERSION) throw new Error('本地控制决策版本不受支持');
  if (!['question', 'discussion', 'execution'].includes(value.taskType)) throw new Error('本地控制决策的任务类型无效');
  exactKeys(value.risk, ['level', 'reasons', 'irreversible', 'money', 'computerInput'], '风险判断');
  if (!['low', 'medium', 'high', 'critical'].includes(value.risk.level)) throw new Error('风险等级无效');
  const riskReasons = stringArray(value.risk.reasons, '风险原因', { max: 8 });
  for (const key of ['irreversible', 'money', 'computerInput']) if (typeof value.risk[key] !== 'boolean') throw new Error(`风险字段 ${key} 必须为布尔值`);
  const detected = detectGoalRisk(goal);
  const riskFlags = { irreversible: value.risk.irreversible || detected.irreversible, money: value.risk.money || detected.money, computerInput: value.risk.computerInput || detected.computerInput };
  for (const reason of detected.reasons) if (!riskReasons.includes(reason) && riskReasons.length < 8) riskReasons.push(reason);
  const rank = { low: 0, medium: 1, high: 2, critical: 3 };
  const flagFloor = riskFlags.irreversible && (riskFlags.money || riskFlags.computerInput) ? 'critical'
    : riskFlags.irreversible || riskFlags.money || riskFlags.computerInput ? 'high' : 'low';
  const safetyFloor = [value.risk.level, detected.level, flagFloor].sort((a, b) => rank[b] - rank[a])[0];
  const riskLevel = rank[safetyFloor] > rank[value.risk.level] ? safetyFloor : value.risk.level;
  if (riskLevel !== value.risk.level) {
    const note = `BEAT 风险规则根据任务目标和安全标志将风险提高到 ${riskLevel}`;
    if (riskReasons.length < 8) riskReasons.push(note); else riskReasons[7] = note;
  }
  exactKeys(value.flow, ['kind', 'maxDebates', 'maxRounds', 'maxParallelTasks'], '流程判断');
  if (!['direct', 'compact-discussion', 'parallel'].includes(value.flow.kind)) throw new Error('流程类型无效');
  const flow = { kind: value.flow.kind, maxDebates: boundedInteger(value.flow.maxDebates, 0, 3, '分歧轮数'), maxRounds: boundedInteger(value.flow.maxRounds, 1, 8, '执行轮数'), maxParallelTasks: boundedInteger(value.flow.maxParallelTasks, 1, 8, '并行任务数') };
  // CX-12：用户明确要求“让搭档只读讨论”时，入口不能降级成单人问答（direct）。只在模型没有选择执行/并行流程时抬升；
  // 是否属于“要动手”由 wantsAction 判定，绝不把要动手的目标变成只讨论。
  const discussionFloorApplied = explicitDiscussionRequest(goal) && !wantsAction(goal) && value.taskType !== 'execution' && flow.kind !== 'parallel';
  if (discussionFloorApplied) {
    if (value.taskType === 'question') value.taskType = 'discussion';
    if (flow.kind === 'direct') flow.kind = 'compact-discussion';
    const entryNote = 'BEAT 入口规则：目标明确要求搭档只读讨论，按 compact-discussion 入口执行，不降级为单人问答';
    if (riskReasons.length < 8) riskReasons.push(entryNote); else riskReasons[7] = entryNote;
  }
  // CX-17：读工作区文件并回报（例如“读取日志统计 ERROR 次数”）是做工具活，不能降级成纯问答；
  // 只在模型判为低风险纯问答、没有任何安全标志、且没有讨论诉求时抬升，绝不覆盖高风险或人工确认。
  if (!discussionFloorApplied && value.taskType === 'question' && flow.kind === 'direct' && requiresWorkspaceWork(goal)
      && riskLevel === 'low' && !value.requiresHuman && !riskFlags.money && !riskFlags.irreversible && !riskFlags.computerInput) {
    value.taskType = 'execution';
    const workNote = 'BEAT 入口规则：目标要求读取工作区文件并回报结果，按只读执行任务处理，不降级成纯问答';
    if (riskReasons.length < 8) riskReasons.push(workNote); else riskReasons[7] = workNote;
  }
  if (value.taskType === 'question' && flow.kind !== 'direct') throw new Error('纯问答只能使用 direct 流程');
  if (value.taskType === 'discussion' && flow.kind !== 'compact-discussion') throw new Error('只读讨论必须使用 compact-discussion 流程');
  exactKeys(value.assignees, ['strong', 'cheap'], '执行者判断');
  const allowed = new Set(partners);
  if (value.assignees.strong !== null && (typeof value.assignees.strong !== 'string' || (allowed.size && !allowed.has(value.assignees.strong)))) throw new Error('强执行者不在当前可用搭档中');
  const cheap = stringArray(value.assignees.cheap, '轻量执行者');
  if (new Set(cheap).size !== cheap.length || (allowed.size && cheap.some(id => !allowed.has(id)))) throw new Error('轻量执行者必须是不重复的当前可用搭档');
  exactKeys(value.budget, ['discussionTokens', 'executionTokens', 'taskTokens'], '预算判断');
  const budget = {
    discussionTokens: boundedInteger(value.budget.discussionTokens, 256, 10000000, '讨论预算'),
    executionTokens: boundedInteger(value.budget.executionTokens, 256, 10000000, '执行预算'),
    taskTokens: boundedInteger(value.budget.taskTokens, 256, 10000000, '单任务预算'),
  };
  if (typeof value.requiresHuman !== 'boolean') throw new Error('requiresHuman 必须为布尔值');
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error('confidence 必须为 0 到 1');
  // High-stakes advice must leave local automatic routing, but a read-only
  // answer is not itself a privileged computer action. Never clear a model's
  // explicit human gate or any existing operational safety flag.
  const adviceOnly = detected.reasons.includes(PROFESSIONAL_ADVICE_RISK) && value.taskType !== 'execution' && !Object.values(riskFlags).some(Boolean);
  const requiresHuman = value.requiresHuman || riskFlags.money || riskFlags.irreversible || riskFlags.computerInput || (!adviceOnly && (riskLevel === 'high' || riskLevel === 'critical'));
  return { schemaVersion: LOCAL_DECISION_SCHEMA_VERSION, taskType: value.taskType, risk: { ...riskFlags, level: riskLevel, reasons: riskReasons }, flow, assignees: { strong: value.assignees.strong, cheap }, budget, requiresHuman, confidence: value.confidence, reasons: stringArray(value.reasons, '决策原因', { min: 1, max: 8 }) };
}

const lowerBound = (proposed, current) => Number.isFinite(current) ? Math.min(proposed, current) : proposed;

export function localDecisionPolicy(decision, { mode = 'shadow', runKind, partners = [], currentFlow = {}, goal = '' } = {}) {
  const checked = validateLocalDecision(decision, { partners, goal });
  const stop = reason => ({ applied: false, reason, patch: {}, maxRounds: null, decision: checked });
  if (mode === 'off') return stop('本地控制器已关闭');
  if (mode === 'shadow') return stop('影子模式只记录建议，不改变流程');
  if (checked.requiresHuman || checked.risk.level === 'high' || checked.risk.level === 'critical' || checked.risk.irreversible || checked.risk.money || checked.risk.computerInput) return stop('高风险、资金、不可逆或电脑输入继续由原 BEAT 安全流程处理');
  if (mode === 'low-risk' && (checked.risk.level !== 'low' || checked.confidence < 0.8)) return stop('低风险模式只采纳低风险且置信度不低于 0.8 的建议');
  if (runKind === 'discuss' && checked.taskType === 'execution') return stop('用户明确发起讨论，本地模型不能改成执行');
  if (runKind === 'parallel' && checked.taskType === 'question') return stop('用户明确发起执行，本地模型不能改成只回答');
  const patch = {
    discussionMaxDebates: lowerBound(checked.flow.maxDebates, currentFlow.discussionMaxDebates),
    maxParallelTasks: lowerBound(checked.flow.maxParallelTasks, currentFlow.maxParallelTasks),
    // Routing suggestions may not silently cut the customer's funded work envelope.
    discussionTokenBudget: currentFlow.discussionTokenBudget,
    executionTokenBudget: currentFlow.executionTokenBudget,
    taskTokenBudget: currentFlow.taskTokenBudget,
    difficultyRouting: true,
  };
  if (checked.flow.kind !== 'direct') patch.fastPath = false;
  if (checked.assignees.strong) patch.strongAgent = checked.assignees.strong;
  if (checked.assignees.cheap.length) patch.cheapAgents = checked.assignees.cheap;
  return { applied: true, reason: mode === 'low-risk' ? '已采纳低风险建议' : '已采纳安全范围内的控制建议', patch, maxRounds: lowerBound(checked.flow.maxRounds, currentFlow.maxRounds), decision: checked };
}

function cleanJsonText(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function readJson(response) {
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`本地 DeepSeek 返回了无法识别的内容（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(value?.error || `本地 DeepSeek 请求失败（HTTP ${response.status}）`);
  return value;
}

export class LocalDeepSeekController {
  constructor(config = {}, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.config = normalizeLocalControllerConfig(config);
    if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 缺少 fetch，无法连接本地 DeepSeek');
    this.fetch = fetchImpl;
    this.now = now;
  }

  async health() {
    const startedAt = this.now();
    try {
      const response = await this.fetch(`${this.config.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const body = await readJson(response);
      const models = Array.isArray(body.models) ? body.models.map(item => item?.name).filter(Boolean) : [];
      return { online: true, modelReady: models.includes(this.config.model), model: this.config.model, models, latencyMs: this.now() - startedAt };
    } catch (error) {
      return { online: false, modelReady: false, model: this.config.model, models: [], latencyMs: this.now() - startedAt, error: error.message };
    }
  }

  async decide(input = {}) {
    const first = await this.decideOnce(input);
    const attempts = [first];
    // Pure judgement has no computer-input side effect. Repair only schema errors,
    // using the actual validator message, never evaluation labels or expected answers.
    if (!first.proposal && first.validationError && first.modelVerified && !input.signal?.aborted && !first.truncated) {
      attempts.push(await this.decideOnce({ ...input, context: [input.context, `上一份判断未通过格式核验：${first.validationError}。请依据同一用户目标修正；安全保护不能降低。上一份原始判断：${first.raw.slice(0, 4000)}`].filter(Boolean).join('\n') }));
    }
    const last = attempts.at(-1);
    return { ...last, attempts: attempts.map(({ attempts: _unused, ...evidence }) => evidence), durationMs: attempts.reduce((sum, x) => sum + x.durationMs, 0), usage: { promptTokens: attempts.every(x => Number.isFinite(x.usage.promptTokens)) ? attempts.reduce((sum, x) => sum + x.usage.promptTokens, 0) : null, outputTokens: attempts.every(x => Number.isFinite(x.usage.outputTokens)) ? attempts.reduce((sum, x) => sum + x.usage.outputTokens, 0) : null } };
  }

  async dispatch(input = {}) {
    const first = await this.dispatchOnce(input);
    const attempts = [first];
    // 纯分工判断没有电脑输入副作用；模型偶尔漏掉任务，按实际校验错误最多修两次。
    while (attempts.length < 3 && !attempts.at(-1).proposal && attempts.at(-1).validationError && attempts.at(-1).modelVerified && !input.signal?.aborted && !attempts.at(-1).truncated) {
      const prior = attempts.at(-1);
      attempts.push(await this.dispatchOnce({ ...input, context: [input.context, '上一份分工判断未通过格式核验：' + prior.validationError + '。请依据同一任务列表补齐每一个任务；不能改任务内容、文件范围或验收标准。上一份原始判断：' + String(prior.raw).slice(0, 4000)].filter(Boolean).join('\n') }));
    }
    const last = attempts.at(-1);
    return { ...last, attempts: attempts.map(({ attempts: _unused, ...evidence }) => evidence), durationMs: attempts.reduce((sum, item) => sum + item.durationMs, 0), usage: {
      promptTokens: attempts.every(item => Number.isFinite(item.usage.promptTokens)) ? attempts.reduce((sum, item) => sum + item.usage.promptTokens, 0) : null,
      outputTokens: attempts.every(item => Number.isFinite(item.usage.outputTokens)) ? attempts.reduce((sum, item) => sum + item.usage.outputTokens, 0) : null,
    } };
  }

  async dispatchOnce(input = {}) {
    if (!Array.isArray(input.tasks) || !input.tasks.length) throw new Error('本地控制器缺少分工任务');
    const startedAt = this.now();
    const signalFor = () => input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(Math.round(this.config.timeoutSec * 1000))]) : AbortSignal.timeout(Math.round(this.config.timeoutSec * 1000));
    const send = think => this.fetch(this.config.baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        think,
        format: LOCAL_DISPATCH_JSON_SCHEMA,
        keep_alive: this.config.keepAlive,
        options: { temperature: 0, num_predict: 2048, num_ctx: 4096 },
        messages: [{ role: 'user', content: localDispatchPrompt(input) }],
      }),
      signal: signalFor(),
    });
    let thinking = this.config.mode === 'full';
    let response = await send(thinking);
    if (!response.ok && thinking) {
      const text = await response.text().catch(() => '');
      if (/does not support (?:thinking|reasoning)|thinking is not supported|不支持思考/i.test(text)) {
        thinking = false;
        response = await send(thinking);
      } else {
        let detail = text.trim();
        try { detail = JSON.parse(text)?.error || detail; } catch { /* keep raw text */ }
        throw new Error(detail || ('本地 DeepSeek 分工请求失败（HTTP ' + response.status + '）'));
      }
    }
    const body = await readJson(response);
    const raw = cleanJsonText(body?.message?.content);
    let modelProposal = null, proposal = null, validationError = null;
    try {
      modelProposal = JSON.parse(raw);
      if (body?.model !== this.config.model) throw new Error('本地模型回执与所选模型不一致，本次分工未采纳');
      if (body?.done_reason === 'length') throw new Error('本地模型分工输出未完成，本次分工未采纳');
      proposal = validateLocalDispatch(modelProposal, { tasks: input.tasks, partners: input.availablePartners || [] });
    } catch (error) { validationError = error.message; }
    return {
      provider: 'ollama-local', endpoint: this.config.baseUrl, requestedModel: this.config.model,
      actualModel: body?.model || null, modelVerified: body?.model === this.config.model,
      durationMs: this.now() - startedAt, raw, modelProposal, proposal, validationError,
      truncated: body?.done_reason === 'length', thinking,
      usage: { promptTokens: body?.prompt_eval_count ?? null, outputTokens: body?.eval_count ?? null },
    };
  }

  async decideOnce(input = {}) {
    if (!String(input.goal || '').trim()) throw new Error('本地控制器缺少用户目标');
    const startedAt = this.now();
    const signalFor = () => input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(Math.round(this.config.timeoutSec * 1000))]) : AbortSignal.timeout(Math.round(this.config.timeoutSec * 1000));
    const send = think => this.fetch(`${this.config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        think,
        format: LOCAL_DECISION_JSON_SCHEMA,
        keep_alive: this.config.keepAlive,
        options: { temperature: 0, num_predict: 1536, num_ctx: 4096 },
        messages: [{ role: 'user', content: localControllerPrompt(input) }],
      }),
      signal: signalFor(),
    });
    // 「完全接管」默认要求模型先思考；但有些本地 GGUF/微调模型不支持 thinking 参数，
    // Ollama 会直接 400。思考只是提高判断质量，不是安全门：不支持就自动退回普通请求，
    // 绝不能让控制器因此整场缺席。
    let thinking = this.config.mode === 'full';
    let response = await send(thinking);
    if (!response.ok && thinking) {
      const text = await response.text().catch(() => '');
      if (/does not support (?:thinking|reasoning)|thinking is not supported|不支持思考/i.test(text)) {
        thinking = false;
        response = await send(thinking);
      } else {
        let detail = text.trim();
        try { detail = JSON.parse(text)?.error || detail; } catch { /* keep raw text */ }
        throw new Error(detail || `本地 DeepSeek 请求失败（HTTP ${response.status}）`);
      }
    }
    const body = await readJson(response);
    const raw = cleanJsonText(body?.message?.content);
    let modelProposal = null, proposal = null, validationError = null;
    try {
      modelProposal = JSON.parse(raw);
      if (body?.model !== this.config.model) throw new Error('本地模型回执与所选模型不一致，本次建议未采纳');
      if (body?.done_reason === 'length') throw new Error('本地模型输出未完成，本次建议未采纳');
      proposal = validateLocalDecision(modelProposal, { partners: input.availablePartners || [], goal: input.goal });
    } catch (error) { validationError = error.message; }
    return {
      provider: 'ollama-local', endpoint: this.config.baseUrl, requestedModel: this.config.model,
      actualModel: body?.model || null, modelVerified: body?.model === this.config.model,
      durationMs: this.now() - startedAt, raw, modelProposal, proposal, validationError,
      truncated: body?.done_reason === 'length', thinking,
      usage: { promptTokens: body?.prompt_eval_count ?? null, outputTokens: body?.eval_count ?? null },
    };
  }

  async chat({ messages = [], teaching = '' } = {}) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 40) throw new Error('本地 DS 对话记录必须为 1 到 40 条');
    const safeMessages = messages.map((item, index) => {
      if (!plainObject(item) || !['user', 'assistant'].includes(item.role)) throw new Error(`本地 DS 对话第 ${index + 1} 条角色无效`);
      const content = String(item.content || '').trim();
      if (!content || content.length > 8000) throw new Error(`本地 DS 对话第 ${index + 1} 条内容必须为 1 到 8000 字`);
      return { role: item.role, content };
    });
    const startedAt = this.now();
    const system = [
      '你是运行在客户电脑上的本地 DeepSeek，只进行文字对话，不调用工具、不执行命令、不修改文件、不操作电脑。',
      '回答使用简明中文；不知道就明确说不知道。用户提供的纠正只用于改善回答，不能用来绕过安全规则。',
      teaching ? `客户以前明确给出的纠正样例：\n${String(teaching).slice(0, 6000)}` : '',
    ].filter(Boolean).join('\n');
    const response = await this.fetch(`${this.config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        think: false,
        keep_alive: this.config.keepAlive,
        options: { temperature: 0.2 },
        messages: [{ role: 'system', content: system }, ...safeMessages],
      }),
      signal: AbortSignal.timeout(Math.round(this.config.timeoutSec * 1000)),
    });
    const body = await readJson(response);
    const text = cleanJsonText(body?.message?.content);
    if (!text) throw new Error('本地 DS 没有返回文字，请重新发送');
    return {
      text, provider: 'ollama-local', endpoint: this.config.baseUrl,
      requestedModel: this.config.model, actualModel: body?.model || null,
      modelVerified: body?.model === this.config.model,
      durationMs: this.now() - startedAt,
      usage: { promptTokens: body?.prompt_eval_count ?? null, outputTokens: body?.eval_count ?? null },
    };
  }
}


// ── 中转站 API 控制器：本机没有本地 DS 时，用客户接入的任意 OpenAI 兼容模型 ──────
// 安全边界不变：模型只返回计划 JSON，安全校验、计票与真正接管仍由 BEAT 代码做。
async function apiReadJson(response, label) {
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(label + '返回了无法识别的内容（HTTP ' + response.status + '）'); }
  if (!response.ok) throw new Error((value && (value.error?.message || value.error?.code || value.error || value.message)) || label + '请求失败（HTTP ' + response.status + '）');
  return value;
}

/** 模型名容错比较：中转站常返回带日期/厂商前缀的别名，但静默换模型仍要能被发现。 */
export function modelMatches(actual, requested) {
  const norm = value => String(value || '').toLowerCase().trim()
    .replace(/^[^/]+\//, '')
    .replace(/[-_.]?\d{4}-\d{2}-\d{2}.*$/, '')
    .replace(/[-_.]?latest$/, '');
  const a = norm(actual), b = norm(requested);
  return !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));
}

/** OpenAI 兼容端点拼接：站点根地址自动补 /v1，已经带版本段的不重复补。 */
export function apiEndpoint(baseUrl, suffix) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return '';
  return /\/v\d+$/i.test(base) ? base + suffix : base + '/v1' + suffix;
}

export function controllerLabel(backend) {
  return backend === 'api' ? '中转站 API' : backend === 'local' ? '本机 Ollama' : '未配置';
}

/** 当前配置下可尝试的控制器来源（按优先级）。 */
export function controllerCandidates(config = {}) {
  const cfg = normalizeLocalControllerConfig(config);
  const order = cfg.provider === 'local' ? ['local'] : cfg.provider === 'api' ? ['api'] : ['local', 'api'];
  return order.filter(backend => backend === 'local' ? !!cfg.model : !!(cfg.apiBaseUrl && cfg.apiModel));
}

export class OpenAICompatibleController {
  constructor(config = {}, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    const cfg = normalizeLocalControllerConfig({ ...LOCAL_CONTROLLER_DEFAULTS, ...config, provider: 'api' });
    if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 缺少 fetch，无法连接中转站 API');
    this.config = cfg;
    this.baseUrl = cfg.apiBaseUrl;
    this.model = cfg.apiModel;
    this.apiKey = String(config.apiKey ?? '').trim();
    this.fetch = fetchImpl;
    this.now = now;
  }

  headers() {
    return { 'Content-Type': 'application/json', ...(this.apiKey ? { authorization: 'Bearer ' + this.apiKey } : {}) };
  }

  signal(extra) {
    const timeout = AbortSignal.timeout(Math.round(this.config.timeoutSec * 1000));
    return extra ? AbortSignal.any([extra, timeout]) : timeout;
  }

  async health() {
    const startedAt = this.now();
    try {
      const response = await this.fetch(apiEndpoint(this.baseUrl, '/models'), { headers: this.headers(), signal: AbortSignal.timeout(8000) });
      if ([404, 405].includes(response.status)) {
        // 有些中转站不开放模型列表；能连通就算在线，是否真的可用由「保存并测试」的真实调用确认。
        return { online: true, modelReady: true, model: this.model, models: [], modelListUnavailable: true, provider: 'api', endpoint: this.baseUrl, latencyMs: this.now() - startedAt };
      }
      const body = await apiReadJson(response, '中转站 API ');
      const models = (body.data || body.models || []).map(item => item?.id || item?.name).filter(Boolean);
      return { online: true, modelReady: models.length ? models.some(name => modelMatches(name, this.model)) : true, model: this.model, models, provider: 'api', endpoint: this.baseUrl, latencyMs: this.now() - startedAt };
    } catch (error) {
      return { online: false, modelReady: false, model: this.model, models: [], provider: 'api', endpoint: this.baseUrl, latencyMs: this.now() - startedAt, error: error.message };
    }
  }

  async decide(input = {}) {
    const first = await this.decideOnce(input);
    const attempts = [first];
    // 纯判断没有电脑输入副作用；只对格式错误修一次，绝不用评测标签或期望答案。
    if (!first.proposal && first.validationError && first.modelVerified && !input.signal?.aborted && !first.truncated) {
      attempts.push(await this.decideOnce({ ...input, context: [input.context, '上一份判断未通过格式核验：' + first.validationError + '。请依据同一用户目标修正；安全保护不能降低。上一份原始判断：' + String(first.raw).slice(0, 4000)].filter(Boolean).join('\n') }));
    }
    const last = attempts.at(-1);
    return { ...last, attempts: attempts.map(({ attempts: _unused, ...evidence }) => evidence), durationMs: attempts.reduce((sum, item) => sum + item.durationMs, 0), usage: {
      promptTokens: attempts.every(item => Number.isFinite(item.usage.promptTokens)) ? attempts.reduce((sum, item) => sum + item.usage.promptTokens, 0) : null,
      outputTokens: attempts.every(item => Number.isFinite(item.usage.outputTokens)) ? attempts.reduce((sum, item) => sum + item.usage.outputTokens, 0) : null,
    } };
  }

  async decideOnce(input = {}) {
    if (!String(input.goal || '').trim()) throw new Error('控制器缺少用户目标');
    const startedAt = this.now();
    // 本地 Ollama 用 format=JSON Schema 约束输出；中转站只能靠提示词，所以把 Schema 原文和"只输出 JSON"一起写进请求，
    // 否则很多模型会返回缺字段的近似 JSON（实测：只给 response_format 时缺 schemaVersion，判断无法采纳）。
    const schemaText = '必须严格按下面的 JSON Schema 返回一个 JSON 对象：字段名、类型、枚举必须完全一致；不得添加字段，不得输出解释文字或 Markdown 代码块。\nSchema：' + JSON.stringify(LOCAL_DECISION_JSON_SCHEMA);
    const payload = { model: this.model, messages: [{ role: 'user', content: localControllerPrompt(input) + '\n\n' + schemaText }], temperature: 0, max_tokens: 2048, response_format: { type: 'json_object' } };
    const url = apiEndpoint(this.baseUrl, '/chat/completions');
    let response = await this.fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal: this.signal(input.signal) });
    if (!response.ok) {
      // 部分中转站不认 response_format / max_tokens：按返回的错误逐项降级重试，而不是把客户直接挡在外面。
      const text = await response.text().catch(() => '');
      let changed = false;
      if (/max_tokens|max_completion_tokens/i.test(text) && payload.max_tokens !== undefined) { delete payload.max_tokens; payload.max_completion_tokens = 2048; changed = true; }
      if (/response_format|json_object|unsupported|unknown/i.test(text) && payload.response_format) { delete payload.response_format; changed = true; }
      if (changed) response = await this.fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal: this.signal(input.signal) });
      else {
        // 响应体已经读过，不能再交给解析器（否则客户只会看到 “Body is unusable”）。把服务商的原话翻译出来。
        let detail = text.trim();
        try { const parsed = JSON.parse(text); detail = parsed?.error?.message || parsed?.error || parsed?.message || detail; } catch { /* keep raw text */ }
        throw new Error('中转站 API 请求失败' + (detail ? '：' + String(detail).slice(0, 300) : '（HTTP ' + response.status + '）'));
      }
    }
    const body = await apiReadJson(response, '中转站 API ');
    const choice = Array.isArray(body.choices) ? body.choices[0] : null;
    const raw = cleanJsonText(choice?.message?.content ?? choice?.text ?? '');
    const actualModel = body.model || null;
    const modelVerified = !actualModel || modelMatches(actualModel, this.model);
    let modelProposal = null, proposal = null, validationError = null;
    try {
      modelProposal = JSON.parse(raw);
      if (!modelVerified) throw new Error('接口返回的模型与所选不一致：' + actualModel + '，本次建议未采纳');
      if (choice?.finish_reason === 'length') throw new Error('模型输出未完成，本次建议未采纳');
      proposal = validateLocalDecision(modelProposal, { partners: input.availablePartners || [], goal: input.goal });
    } catch (error) { validationError = error.message; }
    return {
      provider: 'openai-compatible', endpoint: this.baseUrl, requestedModel: this.model,
      actualModel, modelVerified,
      durationMs: this.now() - startedAt, raw, modelProposal, proposal, validationError,
      truncated: choice?.finish_reason === 'length',
      usage: { promptTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null },
    };
  }

  async dispatch(input = {}) {
    const first = await this.dispatchOnce(input);
    const attempts = [first];
    // 模型偶尔漏掉任务，按实际校验错误最多修两次；每次都用真实错误，不喂期望答案。
    while (attempts.length < 3 && !attempts.at(-1).proposal && attempts.at(-1).validationError && attempts.at(-1).modelVerified && !input.signal?.aborted && !attempts.at(-1).truncated) {
      const prior = attempts.at(-1);
      attempts.push(await this.dispatchOnce({ ...input, context: [input.context, '上一份分工判断未通过格式核验：' + prior.validationError + '。请依据同一任务列表补齐每一个任务；不能改任务内容、文件范围或验收标准。上一份原始判断：' + String(prior.raw).slice(0, 4000)].filter(Boolean).join('\n') }));
    }
    const last = attempts.at(-1);
    return { ...last, attempts: attempts.map(({ attempts: _unused, ...evidence }) => evidence), durationMs: attempts.reduce((sum, item) => sum + item.durationMs, 0), usage: {
      promptTokens: attempts.every(item => Number.isFinite(item.usage.promptTokens)) ? attempts.reduce((sum, item) => sum + item.usage.promptTokens, 0) : null,
      outputTokens: attempts.every(item => Number.isFinite(item.usage.outputTokens)) ? attempts.reduce((sum, item) => sum + item.usage.outputTokens, 0) : null,
    } };
  }

  async dispatchOnce(input = {}) {
    if (!Array.isArray(input.tasks) || !input.tasks.length) throw new Error('中转站 API 控制器缺少分工任务');
    const startedAt = this.now();
    const schemaText = '必须严格按下面的 JSON Schema 返回一个 JSON 对象：字段名、类型、枚举必须完全一致；不得添加字段，不得输出解释文字或 Markdown 代码块。\nSchema：' + JSON.stringify(LOCAL_DISPATCH_JSON_SCHEMA);
    const payload = { model: this.model, messages: [{ role: 'user', content: localDispatchPrompt(input) + '\n\n' + schemaText }], temperature: 0, max_tokens: 2048, response_format: { type: 'json_object' } };
    const url = apiEndpoint(this.baseUrl, '/chat/completions');
    let response = await this.fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal: this.signal(input.signal) });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let changed = false;
      if (/max_tokens|max_completion_tokens/i.test(text) && payload.max_tokens !== undefined) { delete payload.max_tokens; payload.max_completion_tokens = 2048; changed = true; }
      if (/response_format|json_object|unsupported|unknown/i.test(text) && payload.response_format) { delete payload.response_format; changed = true; }
      if (changed) response = await this.fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal: this.signal(input.signal) });
      else {
        let detail = text.trim();
        try { const parsed = JSON.parse(text); detail = parsed?.error?.message || parsed?.error || parsed?.message || detail; } catch { /* keep raw text */ }
        throw new Error('中转站 API 分工请求失败' + (detail ? '：' + String(detail).slice(0, 300) : '（HTTP ' + response.status + '）'));
      }
    }
    const body = await apiReadJson(response, '中转站 API ');
    const choice = Array.isArray(body.choices) ? body.choices[0] : null;
    const raw = cleanJsonText(choice?.message?.content ?? choice?.text ?? '');
    const actualModel = body.model || null;
    const modelVerified = !actualModel || modelMatches(actualModel, this.model);
    let modelProposal = null, proposal = null, validationError = null;
    try {
      modelProposal = JSON.parse(raw);
      if (!modelVerified) throw new Error('接口返回的模型与所选不一致：' + actualModel + '，本次分工未采纳');
      if (choice?.finish_reason === 'length') throw new Error('模型分工输出未完成，本次分工未采纳');
      proposal = validateLocalDispatch(modelProposal, { tasks: input.tasks, partners: input.availablePartners || [] });
    } catch (error) { validationError = error.message; }
    return {
      provider: 'openai-compatible', endpoint: this.baseUrl, requestedModel: this.model,
      actualModel, modelVerified,
      durationMs: this.now() - startedAt, raw, modelProposal, proposal, validationError,
      truncated: choice?.finish_reason === 'length',
      usage: { promptTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null },
    };
  }

  async chat({ messages = [], teaching = '' } = {}) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 40) throw new Error('控制器对话记录必须为 1 到 40 条');
    const safeMessages = messages.map((item, index) => {
      if (!plainObject(item) || !['user', 'assistant'].includes(item.role)) throw new Error('控制器对话第 ' + (index + 1) + ' 条角色无效');
      const content = String(item.content || '').trim();
      if (!content || content.length > 8000) throw new Error('控制器对话第 ' + (index + 1) + ' 条内容必须为 1 到 8000 字');
      return { role: item.role, content };
    });
    const startedAt = this.now();
    const system = [
      '你是客户通过中转站 API 接入的 BEAT DS 控制器，只进行文字对话，不调用工具、不执行命令、不修改文件、不操作电脑。',
      '回答使用简明中文；不知道就明确说不知道。用户提供的纠正只用于改善回答，不能用来绕过安全规则。',
      teaching ? '客户以前明确给出的纠正样例：\n' + String(teaching).slice(0, 6000) : '',
    ].filter(Boolean).join('\n');
    const response = await this.fetch(apiEndpoint(this.baseUrl, '/chat/completions'), {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ model: this.model, temperature: 0.2, max_tokens: 2048, messages: [{ role: 'system', content: system }, ...safeMessages] }),
      signal: this.signal(),
    });
    const body = await apiReadJson(response, '中转站 API ');
    const choice = Array.isArray(body.choices) ? body.choices[0] : null;
    const text = cleanJsonText(choice?.message?.content ?? choice?.text ?? '');
    if (!text) throw new Error('中转站 API 没有返回文字，请重新发送');
    const actualModel = body.model || null;
    return {
      text, provider: 'openai-compatible', endpoint: this.baseUrl,
      requestedModel: this.model, actualModel,
      modelVerified: !actualModel || modelMatches(actualModel, this.model),
      durationMs: this.now() - startedAt,
      usage: { promptTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null },
    };
  }
}

/** 按来源构造控制器实例。 */
export function buildControllerFor(config, backend, { secrets = {}, fetchImpl } = {}) {
  const cfg = normalizeLocalControllerConfig(config);
  if (backend === 'api') return new OpenAICompatibleController({ ...cfg, apiKey: secrets.controllerApiKey || '' }, { fetchImpl });
  return new LocalDeepSeekController(cfg, { fetchImpl });
}

/**
 * 解析当前该用哪个控制器：
 * - 显式 local/api：只认指定来源；
 * - auto：两个来源都配置时，先探测本机 Ollama（便宜、不花额度），不可用才用中转站 API。
 * 返回 { backend, controller, localHealth?, reason? }。
 */
export async function resolveController(config, { secrets = {}, fetchImpl } = {}) {
  const cfg = normalizeLocalControllerConfig(config);
  const candidates = controllerCandidates(cfg);
  if (!candidates.length) return { backend: null, controller: null, reason: '还没有可用的控制器来源：本机没有本地 DS，也还没有接入中转站 API。' };
  if (candidates.length === 1) return { backend: candidates[0], controller: buildControllerFor(cfg, candidates[0], { secrets, fetchImpl }) };
  const local = buildControllerFor(cfg, 'local', { secrets, fetchImpl });
  const localHealth = await local.health();
  if (localHealth.online && localHealth.modelReady) return { backend: 'local', controller: local, localHealth };
  return { backend: 'api', controller: buildControllerFor(cfg, 'api', { secrets, fetchImpl }), localHealth };
}

