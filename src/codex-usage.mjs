// App-server `last` is the last inference, not the whole native tool loop.
// Difference cumulative counters against the pre-turn baseline; repeated updates
// and old thread history must never be charged again.
export function createCodexUsageAccumulator() {
  let baseline = null, current = null;
  const fields = ['totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens'];
  const valid = value => Number.isFinite(value) && value >= 0;
  return {
    seed(total) { if (valid(total?.totalTokens)) baseline = { ...total }; },
    push(tokenUsage) {
      const { total, last } = tokenUsage || {};
      if (!valid(total?.totalTokens) || !valid(last?.totalTokens)) {
        return current; // Incomplete events are not verified whole-call billing.
      }
      if (!baseline) baseline = Object.fromEntries(fields.map(key => [key,
        valid(total[key]) && valid(last[key]) ? total[key] - last[key] : null]));
      const spent = total.totalTokens - baseline.totalTokens;
      if (spent < 0 || current && spent <= current.totalTokens) return current;
      current = { totalTokens: spent, source: 'codex app-server cumulative turn delta',
        ...(valid(last.inputTokens) ? { contextInputTokens: last.inputTokens } : {}) };
      for (const key of fields.slice(1)) if (valid(total[key]) && valid(baseline[key]) && total[key] >= baseline[key]) current[key] = total[key] - baseline[key];
      return { ...current };
    },
    result() { return current && { ...current }; },
  };
}
