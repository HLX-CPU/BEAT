import { createHash } from 'node:crypto';

// 分层护栏内核（借鉴 OpenAI Agents SDK 的 guardrails：输入 / 执行 / 输出三层）。
// 只做纯函数判定：输入层在调用模型前拦明显恶意目标；执行/输出层只产出警告与确认建议，
// 不改变已有执行结果、不替代严重安全/未知副作用/人工确认规则。

export const GUARDRAIL_LAYERS = Object.freeze({ INPUT: 'input', EXECUTION: 'execution', OUTPUT: 'output' });
export const GUARDRAIL_LEVELS = Object.freeze({ OK: 'ok', WARN: 'warn', CONFIRM: 'confirm', BLOCK: 'block' });
const ORDER = { ok: 0, warn: 1, confirm: 2, block: 3 };
const worse = (a, b) => ORDER[b] > ORDER[a] ? b : a;

const RULES = [
  { id: 'malware', layer: 'input', level: 'block', category: 'safety',
    pattern: /(?:木马|病毒|后门|勒索软件|钓鱼页面|撞库|爆破|绕过(?:授权|登录|验证码|风控)|窃取(?:密码|账号|数据)|未授权访问|ddos|拒绝服务)/i,
    label: '疑似恶意/入侵行为，BEAT 不执行' },
  // R462 实测：问题里写“花 15 元购买 BEAT 的普通用户”被当成资金操作，只因为出现“购买”。
  // 只有“动词 + 动作/金额”才算要花钱，纯描述价格不能拦。
  { id: 'money', layer: 'input', level: 'confirm', category: 'money',
    pattern: /(?:请|帮我|帮忙|替我|给我|去|要|需要|现在|立刻|马上|先)\s*(?:(?:给|向|到)[^，。；;\s]{0,12}\s*)?(?:转账|付款|支付|下单|购买|充值|汇款|投资|理财|合约交易|资金划转|扫码付款)|(?:转账|付款|支付|下单|充值|汇款|投资|理财|合约交易|资金划转|扫码付款)\s*(?:给|到|¥|￥|\d|一|两|三|几)/i,
    label: '涉及资金操作，需要你确认后才能继续' },
  { id: 'irreversible', layer: 'input', level: 'confirm', category: 'irreversible',
    pattern: /(?:格式化|清空磁盘|删除全部|全部删除|不可恢复|覆盖原文件|rm\s+-rf|移除整个目录|重装系统)/i,
    label: '不可逆操作，需要你确认后才能继续' },
  { id: 'secret', layer: 'input', level: 'confirm', category: 'secret',
    pattern: /(?:密码|密钥|api[_-]?key|token|身份证|银行卡|社保号)/i,
    label: '涉及凭据/隐私信息，需要确认用途与范围' },
  { id: 'external', layer: 'input', level: 'confirm', category: 'external',
    pattern: /(?:发送给|上传到|发布到|发给|提交到|同步到).{0,30}(?:客户|外部|网站|服务器|群|邮箱|微信|钉钉)/i,
    label: '涉及把内容发到外部，需要确认接收方' },
];

const findingsFor = (goal, layer = 'input') => RULES
  .filter(rule => rule.layer === layer && rule.pattern.test(String(goal || '')))
  .map(rule => ({ id: rule.id, layer: rule.layer, level: rule.level, category: rule.category, label: rule.label }));

const summarize = (findings, goal = '') => {
  let level = GUARDRAIL_LEVELS.OK;
  for (const finding of findings) level = worse(level, finding.level);
  const requiresConfirmation = level === GUARDRAIL_LEVELS.CONFIRM;
  const block = level === GUARDRAIL_LEVELS.BLOCK;
  const confirmation = requiresConfirmation ? {
    required: true,
    token: createHash('sha256').update(String(goal) + '|' + findings.map(finding => finding.id).join(',')).digest('hex').slice(0, 16),
    tool: 'beat_confirm',
    note: '未确认前不会执行；确认时把任务号和 token 传给 beat_confirm。',
  } : null;
  return {
    layer: GUARDRAIL_LAYERS.INPUT, level, block, requiresConfirmation, confirmation,
    findings,
    reasons: findings.map(finding => finding.label),
    note: block ? '目标涉及明显恶意/入侵行为，已在调用模型前拦下，没有执行任何操作。'
      : requiresConfirmation ? '目标包含需要确认的高风险项；BEAT 不会自动批准资金/不可逆/外部发送。'
      : '没有命中输入护栏。',
  };
};

export function inputGuardrail({ goal = '' } = {}) {
  return summarize(findingsFor(goal), goal);
}

export function executionGuardrail({ audit = null, unknownSideEffects = false } = {}) {
  const findings = [];
  if (unknownSideEffects || audit?.uncertain) findings.push({ id: 'unknown-side-effects', level: 'confirm', category: 'unknown', label: '执行结果有未确认的副作用，回放前需要人工核对' });
  for (const item of audit?.highRisk || []) {
    if (['irreversible', 'credential'].includes(item.risk)) findings.push({ id: 'high-risk-action', level: 'confirm', category: item.risk, label: `执行中发现高危动作：${item.label || item.risk}（${item.tool || ''}）` });
  }
  let level = GUARDRAIL_LEVELS.OK;
  for (const finding of findings) level = worse(level, finding.level);
  return { layer: GUARDRAIL_LAYERS.EXECUTION, level, block: false, requiresConfirmation: level === GUARDRAIL_LEVELS.CONFIRM, findings,
    reasons: findings.map(finding => finding.label), note: findings.length ? '执行层护栏有提醒，交付结果保留，需人工核对。' : '执行层没有命中护栏。' };
}

export function outputGuardrail({ goal = '', audit = null, verification = null } = {}) {
  const findings = executionGuardrail({ audit, unknownSideEffects: audit?.uncertain }).findings;
  if (verification && verification.pass === false && verification.unverified) findings.push({ id: 'unverified-delivery', level: 'warn', category: 'verification', label: '最终核验尚未完成，产物保留' });
  let level = GUARDRAIL_LEVELS.OK;
  for (const finding of findings) level = worse(level, finding.level);
  return { layer: GUARDRAIL_LAYERS.OUTPUT, level, block: false, requiresConfirmation: level === GUARDRAIL_LEVELS.CONFIRM, findings,
    reasons: findings.map(finding => finding.label), note: findings.length ? '输出层护栏有提醒，不改变交付判定。' : '输出层没有命中护栏。' };
}

export function formatGuardrails(result = {}) {
  if (!result || result.level === GUARDRAIL_LEVELS.OK) return '护栏：无命中';
  return '护栏：' + (result.reasons || []).slice(0, 3).join('；');
}
