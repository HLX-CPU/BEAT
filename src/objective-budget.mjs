import path from 'node:path';
import { usageSummary } from './control-budget.mjs';

export const OBJECTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const OBJECTIVE_TOKEN_LIMIT = 500000;
// Only explicit bookkeeping tags are removed. Semantic numbers, paths, criteria
// and unlabelled batch descriptions stay intact; different evidence is never reused.
export const objectiveKey = goal => String(goal || '').normalize('NFKC')
  .replace(/[\[【](?:批次|分片|batch|shard)\s*[:：#]?\s*\d+(?:\s*\/\s*\d+)?[\]】]/gi, '')
  .replace(/\s+/g, ' ').trim().toLowerCase();
export function objectiveWorkspace(cwd) {
  const root = path.resolve(String(cwd || '.')).replace(/[\\/]beat-runs[\\/]\d{4}-\d{2}-\d{2}[\\/]R\d+(?:-\d+)?$/i, '');
  return process.platform === 'win32' ? root.toLowerCase() : root;
}
export function objectiveUsage(runs, { goal, cwd, metricsFor, now = Date.now() }) {
  const key = objectiveKey(goal), root = objectiveWorkspace(cwd);
  const matching = (runs || []).filter(run => objectiveKey(run.goal) === key && objectiveWorkspace(run.cwd) === root
    && Date.parse(run.created_at) <= now && Date.parse(run.created_at) >= now - OBJECTIVE_WINDOW_MS);
  let tokens = 0, unknown = 0;
  for (const run of matching) {
    const ledger = metricsFor(run.id), usage = usageSummary(ledger);
    if (usage) tokens += usage.totalTokens; else unknown++;
    tokens += Object.values(ledger?.reservations || {}).reduce((sum, r) => sum + (Number(r.tokens) || 0), 0);
  }
  return { runs: matching, tokens, unknown };
}
export function objectiveBudgetError(usage) {
  const previous = usage.runs.map(r => ({ id: r.id, state: r.state, summary: String(r.result || r.error || '尚无结论').slice(0, 800) }));
  return Object.assign(new Error(`同一件事在最近24小时内已记录或预留 ${usage.tokens} token，达到 ${OBJECTIVE_TOKEN_LIMIT} token 的重发保护线，已停止新建任务。请先查看已有记录及已产出的结论；要补未完成部分，请打开原任务继续，避免重新读完所有材料。${usage.unknown ? `另有 ${usage.unknown} 个任务用量未知，未计入数字。` : ''}\n${previous.map(r => `${r.id}（${r.state}）：${r.summary}`).join('\n')}`),
    { code: 'OBJECTIVE_TOKEN_BUDGET', previousRuns: previous, tokens: usage.tokens, noFallback: true });
}
