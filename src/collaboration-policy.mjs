// 开源协作内核（按收益排序逐个引入）：
// 1) AutoGen：群聊式协作必须有可判定的终止条件，不能靠模型"感觉聊完了"。
// 2) OpenAI Agents SDK：handoff 是显式动作（keep / substitute / advisor / stop），不能静默换人。
// 3) CrewAI：角色与任务有生命周期，失败/缺席必须留下可审计的记录。
// 4) LangGraph：状态应可恢复——本模块只做纯函数判定，状态仍由调用方持久化。
//
// 设计原则：只提供"可判定、可测试、不依赖模型"的决策函数；不引入外部运行时。

export const TERMINATION_REASONS = Object.freeze({
  CONSENSUS: 'consensus',
  MAX_DEBATES: 'max_debates',
  MAX_ROUNDS: 'max_rounds',
  NO_PROGRESS: 'no_progress',
  STALLED: 'stalled',
  BUDGET: 'budget_exhausted',
  REVIEW_QUORUM: 'review_quorum',
  NEEDS_HUMAN: 'needs_human',
  FAILED: 'failed',
});

export const HANDOFF_ACTIONS = Object.freeze({
  KEEP: 'keep',
  SUBSTITUTE: 'substitute',
  ADVISOR: 'advisor',
  STOP: 'stop',
});

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const list = value => (Array.isArray(value) ? value : []);

/**
 * 判断一轮讨论是否应该停止。
 * @param {object} input
 * @param {boolean} input.consensus 是否已达成一致
 * @param {Array} input.disputes 未决分歧
 * @param {number} input.debates 已进行的辩论轮数
 * @param {number} input.maxDebates 最大辩论轮数
 * @param {boolean} input.stalled 上一轮是否没有推进
 * @param {number|null} input.lastDisputeCount 上一轮结束时的分歧数
 * @param {number} input.rounds 当前整体轮数
 * @param {number|null} input.maxRounds 整体最大轮数
 * @param {number} input.tokensUsed 讨论阶段已用 token
 * @param {number|null} input.tokenBudget 讨论阶段预算
 */
export function decideTermination({
  consensus = false, disputes = [], debates = 0, maxDebates = 3,
  stalled = false, lastDisputeCount = null, rounds = 0, maxRounds = null,
  tokensUsed = 0, tokenBudget = null,
} = {}) {
  const pending = list(disputes).length;
  const used = num(tokensUsed), budget = num(tokenBudget);
  if (consensus || pending === 0) {
    return { stop: true, reason: TERMINATION_REASONS.CONSENSUS, note: '没有未决分歧，讨论可以收口' };
  }
  if (budget > 0 && used / budget >= 0.9) {
    return { stop: true, reason: TERMINATION_REASONS.BUDGET, note: `讨论预算已用 ${Math.min(100, Math.round(used / budget * 100))}%，停止追加辩论并交裁决` };
  }
  if (stalled) {
    return { stop: true, reason: TERMINATION_REASONS.STALLED, note: '上一轮讨论没有推进，停止重复辩论' };
  }
  if (lastDisputeCount != null && num(debates) >= 1 && pending >= num(lastDisputeCount)) {
    return { stop: true, reason: TERMINATION_REASONS.NO_PROGRESS, note: `分歧数量没有下降（仍为 ${pending} 项），停止重复辩论` };
  }
  if (maxRounds != null && num(rounds) >= num(maxRounds)) {
    return { stop: true, reason: TERMINATION_REASONS.MAX_ROUNDS, note: '已达到整体轮数上限' };
  }
  if (num(debates) >= num(maxDebates)) {
    return { stop: true, reason: TERMINATION_REASONS.MAX_DEBATES, note: `已达到最多 ${maxDebates} 轮辩论` };
  }
  return { stop: false, reason: null, note: '' };
}

/**
 * 判断一次"座位不可用/冲突"时该怎么交接。
 * @param {object} input
 * @param {string} input.seat 当前座位
 * @param {'online'|'failed'|'offline'|'paused'|'cooldown'} input.status
 * @param {string[]} input.candidates 可接替的在线座位
 * @param {boolean} input.advisorOnline 顾问是否在线
 * @param {boolean} input.conflict 是否与执行者/评审对象冲突，不能继续由本人处理
 * @param {string} input.reason 失败原因（写入事件，不丢证据）
 */
export function decideHandoff({ seat = '', status = 'online', candidates = [], advisorOnline = false, conflict = false, reason = '' } = {}) {
  const choices = [...new Set(list(candidates).filter(candidate => candidate && candidate !== seat))];
  if (status === 'online' && !conflict) return { action: HANDOFF_ACTIONS.KEEP, to: seat, note: '座位在线，继续由本人处理' };
  if (conflict && advisorOnline) return { action: HANDOFF_ACTIONS.ADVISOR, to: 'claude', note: '本人与本次结论存在冲突，改由顾问只读裁决' };
  if (choices.length) return { action: HANDOFF_ACTIONS.SUBSTITUTE, to: choices[0], note: `${seat} 不可用，改由 ${choices[0]} 接替（代答只作参考，不计本人票）` };
  if (advisorOnline) return { action: HANDOFF_ACTIONS.ADVISOR, to: 'claude', note: '没有可接替的在线搭档，改由顾问只读裁决' };
  return { action: HANDOFF_ACTIONS.STOP, to: null, note: `${seat} 不可用且没有可接替的在线搭档，保留现状等待恢复${reason ? '：' + reason : ''}` };
}

export function terminationNotice(termination = {}) {
  const reason = termination.reason || TERMINATION_REASONS.NEEDS_HUMAN;
  const label = {
    [TERMINATION_REASONS.CONSENSUS]: '已达成一致',
    [TERMINATION_REASONS.MAX_DEBATES]: '达到辩论上限',
    [TERMINATION_REASONS.MAX_ROUNDS]: '达到轮数上限',
    [TERMINATION_REASONS.NO_PROGRESS]: '没有新进展',
    [TERMINATION_REASONS.STALLED]: '讨论停滞',
    [TERMINATION_REASONS.BUDGET]: '预算到限',
    [TERMINATION_REASONS.REVIEW_QUORUM]: '评审票数不足',
    [TERMINATION_REASONS.NEEDS_HUMAN]: '需要人工确认',
    [TERMINATION_REASONS.FAILED]: '讨论未通过',
  }[reason] || reason;
  return termination.note ? `${label}：${termination.note}` : label;
}
