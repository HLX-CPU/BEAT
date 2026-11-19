import { createHash } from 'node:crypto';
const KEYS = ['discussionTokenBudget', 'executionTokenBudget', 'taskTokenBudget'];
const CAP = 10000000;
export function budgetContinuationOffer(run, flow, metrics, failure) {
  if (!['failed', 'error', 'interrupted'].includes(run.state)) return null;
  const reason = [run.error, run.result, ...(metrics?.records || []).map(r => r.error)].filter(Boolean).join('\n');
  if (failure?.category !== 'budget' && !/预算|预留用量|CONTROL_BUDGET/.test(reason)) return null;
  const used = { discussionTokenBudget: metrics?.phases?.discussion?.usedTokens || 0, executionTokenBudget: metrics?.phases?.execution?.usedTokens || 0,
    taskTokenBudget: Math.max(0, ...Object.values(metrics?.tasks || {}).map(t => Number(t.usedTokens) || 0)) };
  const defaults = { discussionTokenBudget: 256000, executionTokenBudget: 384000, taskTokenBudget: 128000 };
  if (KEYS.some(key => used[key] >= CAP)) return null; // Never quote a ceiling already below recorded spend.
  const limits = Object.fromEntries(KEYS.map(key => [key, Math.min(CAP, Math.max(defaults[key], Number(flow[key]) * 2 || defaults[key], used[key] + (Number(flow[key]) || defaults[key])))]));
  if (!KEYS.some(key => limits[key] > (Number(flow[key]) || 0))) return null;
  const hash = createHash('sha256').update(JSON.stringify({ id: run.id, state: run.state, limits, used, records: metrics?.records?.length || 0 })).digest('hex');
  return { hash, limits, used, explanation: `保留历史用量及已完成结果。继续后，本任务讨论上限 ${limits.discussionTokenBudget.toLocaleString('zh-CN')}、执行上限 ${limits.executionTokenBudget.toLocaleString('zh-CN')}、单项上限 ${limits.taskTokenBudget.toLocaleString('zh-CN')} token；可能增加费用，以提供方账单为准。` };
}
