// 「卡住」由 BEAT 自己判断，不让客户调参数：
// 按搭档类型和推理强度给一个起点，再按这位搭档过去成功完成时出现过的最长静默时间自动放宽。
// 判错的代价只是多一次带检查点的重试；判得太松的代价是任务一直挂着，所以设上限。
const MIN = 60000;
const BASE = { native: 10 * MIN, dock: 5 * MIN };
const EFFORT = { high: 1.5, xhigh: 2.5, max: 2.5, ultra: 3 };
const CEILING = 60 * MIN, KEEP = 20;
const key = agent => 'quietGaps:' + agent;

export function quietLimitMs(store, agent, effort, override) {
  if (Number(override) > 0) return Number(override) * MIN;
  const base = (String(agent).startsWith('dock:') ? BASE.dock : BASE.native) * (EFFORT[String(effort || '').toLowerCase()] || 1);
  const seen = store?.get?.(key(agent)) || [];
  const longest = seen.length ? Math.max(...seen) : 0;
  return Math.min(CEILING, Math.max(base, Math.ceil(longest * 2)));
}

// 只记录最终成功的尝试：那次的长静默被证明是“在想”，不是“卡死”。
export function rememberQuietGap(store, agent, gapMs) {
  if (!store?.set || !(gapMs > 0)) return;
  const seen = (store.get?.(key(agent)) || []).concat(Math.round(gapMs)).slice(-KEEP);
  store.set(key(agent), seen);
}
