// 显式状态/恢复点内核（借鉴 LangGraph 的状态图与 checkpoint 思路）：
// 不重写 BEAT 的执行引擎；把「当前在哪个节点、下一步是继续/返工/换人/等人」从
// 各处散落的 if 里收敛成一个可枚举、可测试、可从持久记录重建的纯函数。
// 状态来源：run 状态、steps、taskQueue、quickWorkEvidence、deliveryVerification——都是已落盘记录。

export const WORKFLOW_NODES = Object.freeze({
  INTAKE: 'intake',
  DISCUSSION: 'discussion',
  PLANNING: 'planning',
  EXECUTION: 'execution',
  VERIFICATION: 'verification',
  DELIVERY: 'delivery',
  AWAITING_INPUT: 'awaiting_input',
  BLOCKED: 'blocked',
});

export const WORKFLOW_EDGES = Object.freeze({
  intake: ['discussion', 'planning', 'execution', 'awaiting_input'],
  discussion: ['planning', 'delivery', 'blocked', 'awaiting_input'],
  planning: ['execution', 'blocked'],
  execution: ['verification', 'blocked', 'awaiting_input'],
  verification: ['delivery', 'blocked'],
  delivery: [],
  awaiting_input: ['discussion', 'planning', 'execution'],
  blocked: ['execution', 'verification', 'delivery'],
});

export const RESUME_ACTIONS = Object.freeze({
  WAIT: 'wait', ANSWER: 'answer', RESUME: 'resume', REVIEW_ONLY: 'review-only',
  REWORK: 'rework', REPLAN: 'replan', RETRY: 'retry', RESTART: 'restart', MANUAL: 'manual', NONE: 'none',
});

const stateNode = state => {
  if (state === 'queued') return WORKFLOW_NODES.INTAKE;
  if (state === 'waiting_input') return WORKFLOW_NODES.AWAITING_INPUT;
  if (state === 'discussing') return WORKFLOW_NODES.DISCUSSION;
  if (state === 'planning') return WORKFLOW_NODES.PLANNING;
  if (state === 'executing') return WORKFLOW_NODES.EXECUTION;
  if (state === 'evaluating' || state === 'verifying') return WORKFLOW_NODES.VERIFICATION;
  if (state === 'passed' || state === 'done') return WORKFLOW_NODES.DELIVERY;
  if (['failed', 'error', 'interrupted', 'cancelled'].includes(state)) return WORKFLOW_NODES.BLOCKED;
  return WORKFLOW_NODES.INTAKE;
};

const hasUnknownSideEffects = view => {
  const evidence = view.quickWorkEvidence?.evidence;
  if (evidence?.sideEffects === 'unknown') return true;
  if ((view.steps || []).some(step => step?.data?.nativeToolEvidence?.sideEffects === 'unknown' || step?.data?.desktopEvidence?.sideEffects === 'unknown')) return true;
  try { return JSON.parse(JSON.stringify(view.taskQueue || [])).some(task => task?.sideEffects === 'unknown' || /unknown-side-effects/.test(String(task?.quarantineReason || ''))); }
  catch { return false; }
};

export function deriveWorkflow(view = {}) {
  const state = String(view.state || 'queued');
  const node = stateNode(state);
  const planStructureIssue = view.failureCode === 'PLAN_STRUCTURE'
    || /每个文件任务必须划定文件范围|每个小任务必须写清验收标准|任务依赖引用无效/.test(String(view.error || ''));
  const queue = Array.isArray(view.taskQueue) ? view.taskQueue : [];
  const blockedTask = queue.find(task => ['blocked', 'queued', 'running', 'verifying'].includes(String(task?.state)));
  const verificationOnly = view.quickWorkEvidence?.verificationOnly === true || view.recovery?.mode === 'verification-only';
  const unknown = hasUnknownSideEffects(view);
  let resume = { action: RESUME_ACTIONS.NONE, label: null, from: node, taskId: null };
  let terminal = node === WORKFLOW_NODES.DELIVERY;
  let resumable = false;
  if (state === 'done' || state === 'passed') {
    resume = { action: RESUME_ACTIONS.NONE, label: '已完成', from: node, taskId: null };
  } else if (state === 'waiting_input') {
    resumable = true;
    resume = { action: RESUME_ACTIONS.ANSWER, label: '补充信息后继续', from: node, taskId: null };
  } else if (['queued', 'running', 'discussing', 'planning', 'executing', 'evaluating', 'verifying'].includes(state)) {
    resume = { action: RESUME_ACTIONS.WAIT, label: '正在处理，等待当前步骤结束', from: node, taskId: null };
  } else if (state === 'cancelled') {
    terminal = true; resumable = true;
    resume = { action: RESUME_ACTIONS.RESTART, label: '已取消，需要重新发起', from: node, taskId: null };
  } else if (unknown) {
    terminal = true; resumable = false;
    resume = { action: RESUME_ACTIONS.MANUAL, label: '先核对未知操作结果，再决定是否继续', from: node, taskId: null };
  } else if (view.newFilePreflight?.pass === false) {
    terminal = true; resumable = false;
    resume = { action: RESUME_ACTIONS.NONE, label: '原文件已保留，请给新文件起一个不同名称后再次提交', from: node, taskId: null };
  } else if (verificationOnly) {
    terminal = false; resumable = true;
    resume = { action: RESUME_ACTIONS.REVIEW_ONLY, label: '只核验已有成果，不重复执行', from: node, taskId: null };
  } else if (planStructureIssue) {
    terminal = true; resumable = true;
    resume = { action: RESUME_ACTIONS.REPLAN, label: '先修方案的文件范围/验收，再重新开工', from: node, taskId: null };
  } else if (blockedTask) {
    terminal = false; resumable = true;
    resume = { action: RESUME_ACTIONS.REWORK, label: '从未完成的小任务继续（' + blockedTask.id + '）', from: node, taskId: blockedTask.id };
  } else if (state === 'interrupted') {
    terminal = false; resumable = true;
    resume = { action: RESUME_ACTIONS.RESUME, label: '从最近检查点继续', from: node, taskId: null };
  } else if (state === 'failed' || state === 'error') {
    terminal = true; resumable = true;
    resume = { action: RESUME_ACTIONS.RETRY, label: '检查原因后重试未完成的部分', from: node, taskId: null };
  }
  return {
    node, phase: node, state, terminal, resumable, resume,
    edges: WORKFLOW_EDGES[node] || [],
    evidence: { unknownSideEffects: unknown, verificationOnly, planStructureIssue, blockedTaskId: blockedTask?.id || null, artifacts: (view.customer?.artifacts || view.artifacts || []).length },
  };
}

// 买家能看懂的三态：已完成并核验 / 待核对 / 未通过（另有进行中）。
// 只根据已落盘的状态与证据推导，不改执行结果；动作标签复用状态机的恢复点。
export const TRIAGE_STATUS = Object.freeze({ VERIFIED: 'verified', PENDING: 'pending', FAILED: 'failed', ACTIVE: 'active' });

export function deliveryTriage(view = {}, workflow = view.workflow) {
  const wf = workflow || deriveWorkflow(view);
  const state = String(view.state || 'queued');
  const kind = String(view.kind || '');
  const artifacts = [
    ...(view.customer?.artifacts || []),
    ...(view.quickWorkEvidence?.artifacts || []),
    ...(view.recovery?.artifacts || []),
  ];
  const hasArtifacts = artifacts.length > 0;
  const verificationOnly = view.quickWorkEvidence?.verificationOnly === true || view.recovery?.mode === 'verification-only';
  const verification = view.deliveryVerification;
  let status = TRIAGE_STATUS.PENDING, label = '待核对', note = '';
  if (state === 'passed' || state === 'done') {
    status = TRIAGE_STATUS.VERIFIED;
    label = kind === 'ask' && view.access !== 'workspace-write' ? '已答复'
      : kind === 'discuss' ? '已完成' : '已完成并核验';
  } else if (wf.evidence?.unknownSideEffects || wf.resume?.action === 'manual') {
    // 未知电脑操作不能自动重放：既不是"通过"，也不是"做坏了"，而是等人核对。
    status = TRIAGE_STATUS.PENDING; label = '待人工核对';
    note = '有未确认的电脑操作结果，不能自动重放；请先核对现有文件和时间线，再决定是否继续。';
  } else if (verificationOnly) {
    status = TRIAGE_STATUS.PENDING; label = '成果已保留，待核对';
    note = '已有产物，只差独立核验；点继续只会重新检查，不会重做原操作。';
  } else if (state === 'failed' || state === 'error') {
    status = TRIAGE_STATUS.FAILED; label = '未通过';
  } else if (state === 'cancelled') {
    status = TRIAGE_STATUS.FAILED; label = '已停止';
  } else if (['queued', 'running', 'discussing', 'planning', 'executing', 'evaluating', 'verifying'].includes(state)) {
    status = TRIAGE_STATUS.ACTIVE; label = view.customer?.label || '进行中';
  } else if (state === 'interrupted') {
    status = TRIAGE_STATUS.PENDING; label = '进度已保留';
  }
  // 任务完成后客户撤回了文件改动：结果记录保留，但状态不能再说"已完成并核验"。
  const rolledBack = !!view.checkpoint?.rolledBackAt;
  if (rolledBack && status === TRIAGE_STATUS.VERIFIED) {
    status = TRIAGE_STATUS.PENDING;
    if (view.checkpoint?.partial === true) { label = '部分文件已撤销'; note = '任务结果和记录保留；还有文件因为任务后又被改过或没有备份，未撤销。'; }
    else { label = '文件改动已撤销'; note = '任务结果和记录保留；文件已恢复到执行前的状态。'; }
  }
  if (status === TRIAGE_STATUS.VERIFIED && verification && verification.pass === false) {
    status = TRIAGE_STATUS.PENDING; label = '待核对'; note = '最终核验没有通过，成果保留待核对。';
  }
  const actions = [];
  // manual = 未知副作用，必须人工核对；不给一个按钮让它自动重放。
  if (wf.resume?.action && !['none', 'wait', 'manual'].includes(wf.resume.action)) actions.push({ id: 'resume', label: wf.resume.label || '继续', action: wf.resume.action });
  if (hasArtifacts) actions.push({ id: 'inspect', label: '查看现有文件' });
  return { status, label, note, next: wf.resume?.label || null, actions, resumable: !!wf.resumable,
    evidence: { hasArtifacts, artifactCount: artifacts.length, verificationOnly, unknownSideEffects: !!wf.evidence?.unknownSideEffects } };
}

// 任务隔离原因的内部代码（unconfirmed-exit+unknown-side-effects 之类）不能直接给客户看。
export function quarantineText(reason) {
  const code = String(reason || '').trim();
  if (!code) return null;
  if (/unknown-side-effects/.test(code)) return '上次操作结果尚未确认，需要先核对现有文件和记录';
  if (/retries-exhausted/.test(code)) return '重试次数已用完，产物保留等待核对';
  if (/cancelled/.test(code)) return '任务已停止，已写入的文件保留';
  if (/token-budget|budget/.test(code)) return '预算已用完，产物保留';
  if (/no-eligible-worker|admission-blocked/.test(code)) return '暂时没有可用执行搭档，等待恢复';
  return '任务已被隔离，需要核对原因后再继续';
}

export function formatWorkflow(workflow = {}) {
  const label = workflow.resume?.label || '';
  return workflow.resumable ? `当前节点：${workflow.node}；下一步：${label}` : `当前节点：${workflow.node}${workflow.terminal ? '（已结束）' : ''}`;
}
