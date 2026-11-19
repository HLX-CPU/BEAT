// 执行审计内核（借鉴 OpenHands 的事件/动作-观察流）：
// 默认执行者已经是完全访问权限，所以每次执行都要留下"做了什么、危险到什么程度、能不能复核"的事件记录。
// 这里只做只读审计：不执行、不回放、不改变执行结果；回放只用于事后只读核对。
import path from 'node:path';

export const AUDIT_RISK = Object.freeze({
  READ: 'read', WRITE: 'write', NETWORK: 'network', CREDENTIAL: 'credential', DELETE: 'delete', IRREVERSIBLE: 'irreversible', UNKNOWN: 'unknown',
});
const HIGH_RISK = new Set([AUDIT_RISK.CREDENTIAL, AUDIT_RISK.DELETE, AUDIT_RISK.IRREVERSIBLE]);

const RULES = [
  { risk: AUDIT_RISK.IRREVERSIBLE, label: '不可逆/系统级命令', pattern: /(?:^|[\s;&|])(?:rm\s+-rf|rm\s+-r|remove-item[^\n]{0,80}-recurse|del\s+\/s|format\s+[a-z]:|shutdown|restart-computer|stop-computer|diskpart|reg\s+delete|bcdedit|vssadmin|mkfs|dd\s+if=)/i },
  { risk: AUDIT_RISK.DELETE, label: '删除或覆盖文件', pattern: /(?:^|[\s;&|])(?:rm\s|del\s|erase\s|remove-item|rmdir|rd\s|clear-content|set-content[^\n]{0,40}-force|truncate)\b/i },
  { risk: AUDIT_RISK.CREDENTIAL, label: '读取凭据/密钥', pattern: /(?:secrets?\.local|\.env\b|api[_-]?key|password|passwd|credential|id_rsa|token\s*=)/i },
  { risk: AUDIT_RISK.NETWORK, label: '网络访问', pattern: /(?:^|[\s;&|])(?:curl|wget|invoke-webrequest|invoke-restmethod|nc|netcat|ssh|scp|ftp|https?:\/\/)/i },
  { risk: AUDIT_RISK.WRITE, label: '写文件', pattern: /(?:^|[\s;&|])(?:write|edit|apply_patch|file_write|file_edit|file_copy|file_move|file_mkdir|new-item|set-content|out-file|copy-item|move-item|mkdir|rename-item)/i },
  { risk: AUDIT_RISK.READ, label: '只读查看', pattern: /(?:^|[\s;&|])(?:read|glob|grep|ls\b|get-content|select-string|get-childitem|test-path|resolve-path|get-item|get-location|get-process|get-ciminstance|get-date|select-object|measure-object|file_read|file_list|file_look|file_glob)\b/i },
];

export function classifyExecutionRisk({ tool = '', command = '', args = {} } = {}) {
  const text = [tool, command, typeof args === 'object' ? JSON.stringify(args) : String(args || '')].filter(Boolean).join(' ');
  for (const rule of RULES) if (rule.pattern.test(text)) return { risk: rule.risk, label: rule.label };
  return { risk: AUDIT_RISK.UNKNOWN, label: '未分类动作' };
}

const first = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
const truncate = (value, max = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function flattenCalls(evidence = {}) {
  const out = [];
  for (const call of evidence.calls || []) {
    // 原生适配器有两种形状：直接 call，或 call.record.result.calls 里逐工具的子回执。
    const nested = call?.record?.result?.calls;
    if (Array.isArray(nested) && nested.length) for (const item of nested) out.push({ ...item, parent: call });
    else out.push(call);
  }
  for (const item of evidence.verifiedActions || []) out.push({ tool: item.tool, evidence: item.evidence, status: 'completed' });
  return out;
}

function eventPath(call = {}) {
  const input = call.record?.input || call.input || {};
  return first(input.file_path || input.path || input.to || input.target || call.evidence?.after?.resolvedPath || call.evidence?.after?.path || '');
}

export function buildExecutionAudit(evidence = {}, { runId = null, cwd = null, now = new Date() } = {}) {
  const events = [];
  for (const call of flattenCalls(evidence)) {
    const command = first(call.record?.input?.command || call.input?.command || call.record?.command || '');
    const risk = classifyExecutionRisk({ tool: call.tool || call.name || '', command, args: call.record?.input || call.input || {} });
    const artifact = call.evidence?.after || {};
    events.push({
      seq: events.length + 1,
      tool: first(call.tool || call.name || 'unknown'),
      status: first(call.status, 'unknown'),
      failed: call.failed === true,
      risk: risk.risk,
      riskLabel: risk.label,
      path: eventPath(call) || null,
      command: command ? truncate(command) : null,
      summary: truncate([call.tool || call.name, eventPath(call) || (command ? truncate(command, 80) : '')].filter(Boolean).join(' '), 240),
      sideEffects: call.evidence?.sideEffects || call.sideEffects || null,
      sha256: artifact.sha256 || null,
      bytes: Number.isFinite(Number(artifact.bytes)) ? Number(artifact.bytes) : null,
    });
  }
  const byRisk = {};
  for (const event of events) byRisk[event.risk] = (byRisk[event.risk] || 0) + 1;
  const highRisk = events.filter(event => HIGH_RISK.has(event.risk));
  const writes = [...new Set(events.filter(event => [AUDIT_RISK.WRITE, AUDIT_RISK.DELETE, AUDIT_RISK.IRREVERSIBLE].includes(event.risk) && event.path).map(event => event.path))];
  const traceComplete = evidence?.trace?.status === 'complete';
  const uncertain = evidence?.sideEffects === 'unknown' || events.some(event => event.sideEffects === 'unknown');
  const replayable = traceComplete && !uncertain;
  return {
    version: 1, runId, cwd: cwd ? path.resolve(cwd) : null, builtAt: now.toISOString(),
    source: evidence?.source || null,
    events, count: events.length, byRisk, filesTouched: writes,
    highRisk: highRisk.map(event => ({ seq: event.seq, tool: event.tool, risk: event.risk, label: event.riskLabel, path: event.path, command: event.command })),
    traceComplete, uncertain, replayable,
    note: replayable ? '动作轨迹完整，可只读复核' : '存在未确认或未完成动作，回放前必须人工核对',
  };
}

export function formatExecutionAudit(audit = {}) {
  if (!audit || !audit.count) return '执行审计：没有可记录的动作';
  const parts = [`执行审计：${audit.count} 个动作`];
  const riskText = Object.entries(audit.byRisk || {}).map(([risk, count]) => `${risk} ${count}`).join('、');
  if (riskText) parts.push(riskText);
  if (audit.highRisk?.length) parts.push(`高危 ${audit.highRisk.length} 项需核对`);
  parts.push(audit.replayable ? '轨迹完整，可只读复核' : '轨迹不完整，回放前需人工核对');
  return parts.join('；');
}
