// Only structured tool receipts count as verification. A completed model turn,
// exit code, or prose saying "done" cannot verify a computer operation.
export function sealNativeToolTrace(evidence) {
  const calls = evidence?.calls || [];
  const complete = calls.every(call => call.record && ['completed', 'failed'].includes(call.status));
  return { ...evidence, trace: { status: complete ? 'complete' : 'incomplete', coverage: 'this native turn only', method: 'successful native turn with terminal tool event records' } };
}

export function buildNativeToolEvidence(calls, source) {
  const verifiedActions = [];
  let uncertain = false;
  for (const call of calls) {
    if (call.status !== 'completed' || call.failed) continue;
    const result = call.record?.result || call.result?.result;
    const candidates = [result?.structuredContent, result];
    for (const block of result?.content || []) if (block.type === 'text') candidates.push(block.text);
    for (let value of candidates) {
      if (typeof value === 'string') { try { value = JSON.parse(value); } catch { continue; } }
      if (!value || typeof value !== 'object') continue;
      const receipts = Array.isArray(value.calls) ? value.calls : [{ tool: call.tool, evidence: value.evidence || value }];
      for (const receipt of receipts) {
        const evidence = receipt.evidence;
        if (evidence?.sideEffects === 'unknown' || receipt.status === 'failed' || receipt.status === 'unverified') uncertain = true;
        if (evidence?.verification?.status === 'verified' && evidence.sideEffects && !['none', 'unknown'].includes(evidence.sideEffects)) verifiedActions.push({ ...receipt, nativeCallId: call.id });
      }
    }
  }
  // Every possibly mutating native call must have its own receipt. Read-only
  // MCP observation calls may be listed separately; no unreceipted shell input.
  const mutating = calls.filter(c => !/(?:^|[._/])(?:read|list|query|observe|snapshot|screenshot|search|fetch|glob|grep)(?:$|[._/])/i.test(c.tool));
  const verified = !uncertain && mutating.length > 0 && mutating.every(c => c.status === 'completed' && !c.failed && verifiedActions.some(a => a.nativeCallId === c.id));
  return { source, calls, verifiedActions, ...(uncertain ? { sideEffects: 'unknown' } : {}), verification: { status: verified ? 'verified' : 'unverified' } };
}
