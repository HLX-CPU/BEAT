// A2A（Agent2Agent）兼容层内核：借鉴 a2aproject/A2A 的 Agent Card / Task / Message 关系。
// 只做"可被发现、可被查询"的只读协议层；不在这里创建任务，消息投递仍走 BEAT 现有看板/接口。
import path from 'node:path';
import { VERSION } from './config.mjs';

export const A2A_PROTOCOL_VERSION = '0.2.0';
export const A2A_TASK_STATES = Object.freeze({
  SUBMITTED: 'submitted', WORKING: 'working', INPUT_REQUIRED: 'input-required',
  COMPLETED: 'completed', FAILED: 'failed', CANCELED: 'canceled',
});

const textPart = text => ({ kind: 'text', text: String(text ?? '') });
const agentMessage = text => ({ role: 'agent', parts: [textPart(text)] });
const userMessage = text => ({ role: 'user', parts: [textPart(text)] });

export function beatAgentCard({ baseUrl = 'http://127.0.0.1:8765', version = VERSION } = {}) {
  return {
    name: 'BEAT 多方协同',
    description: '本机多方协作中心：一句话任务、多搭档讨论、独立核验、产物证据。',
    url: baseUrl,
    version,
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      { id: 'beat-ask', name: '一句话问答', description: '向指定在线搭档提问，可续问', tags: ['ask', 'qa'], examples: ['帮我把这句话改得更礼貌'] },
      { id: 'beat-consult', name: '多搭档讨论', description: '多位搭档讨论并给出可核验结论', tags: ['discuss', 'multi-agent'] },
      { id: 'beat-deliver', name: '文件/桌面任务', description: '执行文件与桌面操作，返回已核验产物', tags: ['files', 'desktop'] },
    ],
    provider: { organization: 'BEAT', url: baseUrl },
  };
}

const PARTNER_META = {
  codex: { name: 'Codex', kind: 'native', description: 'Codex 桌面端搭档（文件 + 电脑操作）', skills: ['files', 'desktop', 'vision'] },
  deepseek: { name: 'DeepSeek', kind: 'native', description: 'DeepSeek 桌面端搭档（文件 + 电脑操作）', skills: ['files', 'desktop'] },
  zcode: { name: 'ZCode', kind: 'native', description: 'ZCode 桌面端搭档（文件 + 电脑操作）', skills: ['files', 'desktop', 'vision'] },
  claude: { name: 'Claude', kind: 'advisor', description: '只读顾问：执行失败或受阻时给建议', skills: ['advisor'] },
};

export function partnerCard(id, { name, model = '', status = 'unknown', baseUrl = 'http://127.0.0.1:8765' } = {}) {
  const dock = String(id || '').startsWith('dock:');
  const meta = PARTNER_META[id] || (dock
    ? { name: name || id, kind: 'dock', description: '拓展坞搭档（通过 BEAT 电脑助手执行）', skills: ['files', 'desktop'] }
    : { name: name || id, kind: 'unknown', description: 'BEAT 搭档', skills: [] });
  return {
    id, name: meta.name, description: meta.description, status,
    model: model || null, kind: meta.kind,
    url: baseUrl + '/a2a/partners/' + encodeURIComponent(id),
    protocolVersion: A2A_PROTOCOL_VERSION,
    skills: meta.skills.map(skill => ({ id: id + ':' + skill, name: skill, tags: [skill] })),
    capabilities: { streaming: false, pushNotifications: false },
  };
}

export function partnerCards({ baseUrl = 'http://127.0.0.1:8765', partners = [] } = {}) {
  return (partners || []).map(item => partnerCard(item.id, { ...item, baseUrl }));
}

const STATE_MAP = Object.freeze({
  queued: A2A_TASK_STATES.SUBMITTED,
  running: A2A_TASK_STATES.WORKING,
  waiting_input: A2A_TASK_STATES.INPUT_REQUIRED,
  done: A2A_TASK_STATES.COMPLETED,
  passed: A2A_TASK_STATES.COMPLETED,
  failed: A2A_TASK_STATES.FAILED,
  error: A2A_TASK_STATES.FAILED,
  interrupted: A2A_TASK_STATES.FAILED,
  cancelled: A2A_TASK_STATES.CANCELED,
});

export function a2aTaskState(state) {
  return STATE_MAP[state] || A2A_TASK_STATES.WORKING;
}

export function toA2ATask(view = {}, { baseUrl = 'http://127.0.0.1:8765' } = {}) {
  const statusState = a2aTaskState(view.state);
  const text = String(view.error || view.result || '').trim();
  const message = text ? agentMessage(text.slice(0, 2000)) : undefined;
  const artifacts = [];
  const rows = view.customer?.artifacts || view.artifacts || [];
  for (const [index, item] of rows.entries()) {
    const filePath = typeof item === 'string' ? item : item.path;
    if (!filePath) continue;
    const name = path.basename(filePath);
    artifacts.push({
      artifactId: String(view.id || 'task') + '-artifact-' + (index + 1),
      name,
      description: (item && item.status) || '交付文件',
      parts: [{ kind: 'file', file: { name, uri: 'file:///' + String(filePath).replaceAll('\\', '/') } }],
      metadata: { path: filePath, bytes: item?.bytes ?? null, sha256: item?.sha256 ?? null, verified: item?.verified ?? null },
    });
  }
  return {
    kind: 'task',
    id: view.id,
    contextId: view.session_id || view.id,
    status: { state: statusState, timestamp: view.ended_at || view.started_at || view.created_at || undefined, ...(message ? { message } : {}) },
    artifacts,
    history: [
      ...(view.goal ? [userMessage(view.goal)] : []),
      ...(message ? [message] : []),
    ],
    metadata: { kind: view.kind || 'ask', state: view.state || null, cwd: view.cwd || null, url: baseUrl,
      executionAudit: view.executionAudit ? { count: view.executionAudit.count, highRisk: view.executionAudit.highRisk?.length || 0, replayable: view.executionAudit.replayable === true } : null,
      workflow: view.workflow ? { node: view.workflow.node, terminal: view.workflow.terminal === true, resumable: view.workflow.resumable === true, resumeAction: view.workflow.resume?.action || null, resumeLabel: view.workflow.resume?.label || null } : null,
      guardrails: view.guardrails ? { input: view.guardrails.input?.level || null, execution: view.guardrails.execution?.level || null, output: view.guardrails.output?.level || null, reasons: [...(view.guardrails.input?.reasons || []), ...(view.guardrails.execution?.reasons || []), ...(view.guardrails.output?.reasons || [])].slice(0, 6) } : null,
      executionGuardrails: view.executionGuardrails && Object.keys(view.executionGuardrails).length ? { levels: Object.fromEntries(Object.entries(view.executionGuardrails).map(([taskId, value]) => [taskId, value.execution?.level || null])), reasons: Object.values(view.executionGuardrails).flatMap(value => value.execution?.reasons || []).slice(0, 6) } : null,
      executionAudits: view.executionAudits && Object.keys(view.executionAudits).length ? {
        count: Object.values(view.executionAudits).reduce((sum, audit) => sum + (audit.count || 0), 0),
        highRisk: Object.values(view.executionAudits).reduce((sum, audit) => sum + (audit.highRisk?.length || 0), 0),
        replayable: Object.values(view.executionAudits).every(audit => audit.replayable === true),
      } : null },
  };
}

export function a2aRpc(body = {}, { card, taskFor } = {}) {
  const id = body.id ?? null;
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (body.jsonrpc && body.jsonrpc !== '2.0') return fail(-32600, '只支持 JSON-RPC 2.0');
  const method = body.method;
  if (!method) return fail(-32600, '缺少 method');
  if (['agent/getCard', 'agent/getAuthenticatedExtendedCard'].includes(method)) return { jsonrpc: '2.0', id, result: card || null };
  if (method === 'tasks/get') {
    const task = taskFor?.(body.params?.id);
    if (!task) return fail(-32001, '找不到任务：' + String(body.params?.id || ''));
    return { jsonrpc: '2.0', id, result: task };
  }
  if (method === 'message/send') return fail(-32601, '当前 A2A 兼容层为只读：message/send 尚未启用，请通过看板/MCP 创建任务');
  return fail(-32601, '不支持的方法：' + method);
}
