import { randomUUID } from 'node:crypto';

// Estimates are admission-control evidence, never provider billing evidence.
export const estimateTokens = value => Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value || ''), 'utf8') / 2);
export function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  if(value.verified === false || value.estimated === true) return null;
  const v = value.last || value.lastTokenUsage || value.usage || value;
  const input = v.input_tokens ?? v.prompt_tokens ?? v.inputTokens;
  const output = v.output_tokens ?? v.completion_tokens ?? v.outputTokens;
  const cache = v.cacheReadTokens ?? v.cache_read_input_tokens ?? v.cachedInputTokens;
  const total = v.total_tokens ?? v.totalTokens ?? (Number.isFinite(input) && Number.isFinite(output) ? input + output : null);
  if (!Number.isFinite(total) || total < 0) return null;
  return { totalTokens: Math.ceil(total), inputTokens: Number.isFinite(input) ? input : null,
    ...(Number.isFinite(value.contextInputTokens) && value.contextInputTokens >= 0 ? { contextInputTokens: value.contextInputTokens } : {}),
    ...(Number.isFinite(cache) && cache >= 0 ? { cacheReadTokens: cache } : {}),
    ...(Number.isFinite(value.providerTotalTokens) && value.providerTotalTokens >= 0 ? { providerTotalTokens: value.providerTotalTokens } : {}),
    outputTokens: Number.isFinite(output) ? output : null, source: value.source || 'provider', verified: true };
}
export function budgetError(message = '本任务的用量预算已到上限，已停止追加调用；请查看已完成结果或提高预算后继续') {
  return Object.assign(new Error(message), { code: 'CONTROL_BUDGET_EXCEEDED', noFallback: true });
}
// 一次 BEAT 任务的 token 消耗汇总（看板与 beat_get 显示用）。实测与估算分开，不把估算说成实测。
export function usageSummary(metrics) {
  if (!metrics?.records?.length) return null;
  const sum = { totalTokens: 0, measuredTokens: 0, estimatedTokens: 0, calls: 0, unknownCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, providerTotalTokens: 0, byPhase: {}, byAgent: {} };
  for (const r of metrics.records) {
    if (r.measurement === 'reused') continue;
    const tokens = Number(r.tokens) || 0, measured = r.measurement === 'provider' || r.measurement === 'not-dispatched';
    sum.totalTokens += tokens; sum.calls++;
    if (measured) sum.measuredTokens += tokens; else { sum.estimatedTokens += tokens; sum.unknownCalls++; }
    // 明细只来自提供方 usage；估算调用没有可信拆分，保持 0 并在界面标“估算”。
    const u = r.usage;
    if (u) {
      sum.inputTokens += Number(u.inputTokens) || 0;
      sum.outputTokens += Number(u.outputTokens) || 0;
      sum.cacheReadTokens += Number(u.cacheReadTokens) || 0;
      sum.providerTotalTokens += Number(u.providerTotalTokens) || 0;
    }
    sum.byPhase[r.phase] = (sum.byPhase[r.phase] || 0) + tokens;
    if (r.seat) sum.byAgent[r.seat] = (sum.byAgent[r.seat] || 0) + tokens;
  }
  return sum;
}

export class ControlBudget {
  constructor(store, run, flow = {}) {
    this.store = store; this.runId = run.id; this.key = 'controlMetrics:' + run.id;
    this.limits = { discussion: flow.discussionTokenBudget ?? 24000, execution: flow.executionTokenBudget ?? 64000 };
    this.taskLimit = flow.taskTokenBudget ?? 12000;
    this.closingReserveTokens = Math.max(0,Number(flow.closingReserveTokens)||0);
    // 缺省启用；仅客户显式关闭时只计量。上游迟到的用量不能作为精确扣费硬限。
    this.enforced = flow.tokenBudgetEnforced !== false;
  }
  state() { return this.store.get(this.key) || { phases: {}, tasks: {}, reservations: {}, records: [] }; }
  save(s) { this.store.set(this.key, s); return s; }
  phase(s, phase) { return s.phases[phase] ||= { budget: this.limits[phase], usedTokens: 0, measuredTokens: 0, estimatedTokens: 0, unknownCalls: 0, calls: 0, ms: 0 }; }
  reserve({ phase = 'discussion', taskId, budget, inputTokens = 0, maxOutputTokens = 900, adjudication = false, seat }) {
    const s = this.state(), p = this.phase(s, phase);
    // Explicitly refreshed settings can grant more budget on resume; recorded usage is retained.
    // 只在预留真的成立时才把这个数字写进台账：失败的尝试也刷新，会让审计记录同时出现
    // “讨论预算 512,000”和“预算已到上限”这种自相矛盾（R363 实测）。
    const phaseBudget = this.limits[phase];
    const reserved = Object.values(s.reservations).filter(r => r.phase === phase).reduce((a,r) => a+r.tokens, 0);
    const ceiling = phase === 'discussion' && !adjudication ? Math.min(Math.floor(phaseBudget * .70),Math.max(0,phaseBudget-this.closingReserveTokens)) : phaseBudget;
    const remaining = ceiling - p.usedTokens - reserved;
    const task = taskId ? (s.tasks[taskId] ||= { budget: Math.min(budget ?? this.taskLimit, this.taskLimit), usedTokens: 0, measuredTokens: 0, estimatedTokens: 0, calls: 0 }) : null;
    const taskReserved = taskId ? Object.values(s.reservations).filter(r => r.taskId === taskId).reduce((a,r) => a+r.tokens,0) : 0;
    const allowed = Math.min(remaining, task ? task.budget - task.usedTokens - taskReserved : Infinity);
    const requested = Math.max(1, Math.floor(maxOutputTokens) || 1);
    const output = this.enforced ? Math.min(requested, Math.floor(allowed - inputTokens)) : requested;
    if (output < 128 && this.enforced) {
      const unreserved=Math.min(ceiling-p.usedTokens,task?task.budget-task.usedTokens:Infinity);
      if(phase==='execution'&&(reserved||taskReserved)&&unreserved-inputTokens>=128)
        throw Object.assign(budgetError('其他调用正在使用预留额度，本任务尚未派发，等额度释放后自动继续'),{code:'CONTROL_BUDGET_BUSY',notDispatched:true});
      throw budgetError();
    }
    p.budget = phaseBudget;
    const id = randomUUID();
    s.reservations[id] = { id, phase, taskId: taskId || null, seat, inputTokens, maxOutputTokens: output, tokens: inputTokens + output, adjudication: adjudication === true, startedAt: Date.now(), pid: process.pid };
    this.save(s); return s.reservations[id];
  }
  finish(id, { usage, prompt, text, error, budgetSpentTokens, reused=false } = {}) {
    const s = this.state(), r = s.reservations[id]; if (!r) return null;
    const measured = normalizeUsage(usage);
    // 估算只用于准入与审计：单次输出不可能超过这次预留的输出上限，回包文本再长也要按预留封顶。
    // 否则一次异常回包会写出几百万 token 的假账（R531 实测：一次调用记 3,656,260，提供方回执 0）。
    const textEstimate = estimateTokens(text || '');
    const outputCap = Math.max(0, Number(r.maxOutputTokens) || 0);
    const estimated = (Number(r.inputTokens) || 0) + (outputCap ? Math.min(textEstimate, outputCap) : textEstimate);
    // An interrupted request without usage may have spent its entire reservation.
    const reportedSpend = Number(budgetSpentTokens) || 0;
    // 派发自报的累计用量优先于「出错就整笔计入预留」：否则一次真实 117,071 的派发会被记成
    // 128,000 的预留（R318 实测），既高估成本，也让台账无法解释。只有完全不知道用量时才整笔计入。
    const charged = reused ? 0 : measured?.totalTokens ?? Math.max(estimated, reportedSpend, error && !reportedSpend ? r.tokens : 0);
    const p = this.phase(s,r.phase); p.usedTokens += charged; p.ms += Date.now()-r.startedAt;
    if(reused)p.reusedCalls=(p.reusedCalls||0)+1;else{p.calls++;if (measured) p.measuredTokens += charged; else { p.estimatedTokens += charged; p.unknownCalls++; }}
    if (r.taskId && !reused) { const t=s.tasks[r.taskId]; t.usedTokens+=charged;t.calls++;t[measured?'measuredTokens':'estimatedTokens']+=charged; }
    const entry = { phase:r.phase,taskId:r.taskId,seat:r.seat,tokens:charged,measurement:reused?'reused':measured?(measured.source==='controller-no-dispatch'?'not-dispatched':'provider'):'estimate',usage:reused?null:measured,ms:Date.now()-r.startedAt,error:error?.message||null };
    s.records.push(entry); delete s.reservations[id]; this.save(s); return entry;
  }
  remaining(r) { if(!this.enforced)return Infinity; const s=this.state(),p=this.phase(s,r.phase);return Math.min(p.budget-p.usedTokens,r.taskId?s.tasks[r.taskId].budget-s.tasks[r.taskId].usedTokens:Infinity); }
  // 一次调用还没结束就报出超过预留的用量时，先用阶段（及任务）剩余额度把这次预留补足，让它跑完；
  // 真的补不上才停。直接中止会把“这一次估少了”说成“整任务预算已到上限”，客户照提示加大预算也不可能修好
  // ——加预算改的是阶段/任务预算，跟“单次调用超预留”无关（R363 实测：连续 4 轮“加预算→继续→又封限”，
  // 阶段预算其实还剩 35 万，每次都是同一席位预估 4,639、实际 7,471~9,200）。
  // 返回 false 表示剩余额度不够，调用方应按真实原因停止。
  extend(id, neededTokens) {
    if (!this.enforced) return true;
    const s = this.state(), r = s.reservations[id]; if (!r) return false;
    const target = Math.ceil(Number(neededTokens) || 0);
    const extra = target - r.tokens;
    if (extra <= 0) return true;
    const p = this.phase(s, r.phase);
    const others = Object.values(s.reservations).filter(x => x.phase === r.phase && x.id !== r.id).reduce((a, x) => a + x.tokens, 0);
    const ceiling = r.adjudication || r.phase !== 'discussion' ? p.budget
      : Math.min(Math.floor(p.budget * .70), Math.max(0, p.budget - this.closingReserveTokens));
    let room = ceiling - p.usedTokens - others - r.tokens;
    if (r.taskId) {
      const t = s.tasks[r.taskId];
      if (t) {
        const taskOthers = Object.values(s.reservations).filter(x => x.taskId === r.taskId && x.id !== r.id).reduce((a, x) => a + x.tokens, 0);
        room = Math.min(room, t.budget - t.usedTokens - taskOthers - r.tokens);
      }
    }
    if (room < extra) return false;
    r.tokens += extra; r.extendedTokens = (r.extendedTokens || 0) + extra; this.save(s);
    return true;
  }
  // 显式恢复一个被中断的任务（看板「继续执行」）时，控制器按客户当前设置重新分配该任务的一次执行预算。
  // 历史用量留在台账里作为审计，不抹掉、不改写成估算；执行阶段总预算与每次预留上限仍然生效。
  grantTaskBudget(taskId, tokens, { reason = 'resume-reallocation' } = {}) {
    const grant = Math.max(0, Math.floor(Number(tokens) || 0));
    const s = this.state(), t = (s.tasks[taskId] ||= { budget: this.taskLimit, usedTokens: 0, measuredTokens: 0, estimatedTokens: 0, calls: 0 });
    const previousBudget = Number(t.budget) || 0, used = Number(t.usedTokens) || 0;
    // 只保证“再有一次完整尝试”的余量，多次恢复不会累加出越来越大的预留。
    t.budget = Math.max(previousBudget, used + grant);
    (t.grants ||= []).push({ at: new Date().toISOString(), tokens: grant, reason, previousBudget, previousUsage: Number(t.usedTokens) || 0 });
    this.save(s);
    return { taskId, granted: grant, budget: t.budget, usedTokens: Number(t.usedTokens) || 0, reason };
  }
  recover() {
    const s=this.state();
    for (const r of Object.values(s.reservations)) {
      let alive=true;try{process.kill(r.pid,0);}catch(e){alive=e.code!=='ESRCH';}
      if(!alive)this.finish(r.id,{error:budgetError('上次调用中断，用量未知，保守计入预留预算')});
    }
  }
}
