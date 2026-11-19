// A consultant chooses among real failed deliveries; it never approves or restores them.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
const safeId = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
const keyFor = (run, task) => `executionCandidates:${run.id}:${task.id}`;
const readState = (store, run, task) => store.get(keyFor(run, task)) || { version: 1, candidates: [], captureFailures: [], selection: null };
const issues = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim());
const attemptOf = task => Number(task.attempts ?? task.attempt);
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_CHARS = 120000;
const bindingFor = (run, task) => ({ goalHash: digest(String(run.goal || '')), acceptanceHash: digest(JSON.stringify(task.acceptance || [])),
  contractHash: digest(JSON.stringify({ title: task.title, detail: task.detail, type: task.type, input: task.input, inputRefs: task.inputRefs || [],
    output: task.output, outputRefs: task.outputRefs || [], files: task.files || [], checks: task.checks || [], acceptance: task.acceptance || [] })) });

function unsafe(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.unknownSideEffects === true || value.sideEffects === 'unknown' || value.serious === true || value.severity === 'serious') return true;
  return Object.values(value).some(item => item && typeof item === 'object' && unsafe(item));
}

function bounded(cwd, value, requireExists = true) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('候选产物缺少完整文件路径');
  const absolute = path.resolve(cwd, value);
  if (!inside(cwd, absolute)) throw new Error('候选产物超出任务工作目录');
  let existing = absolute;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  if (!inside(fs.realpathSync(cwd), fs.realpathSync(existing))) throw new Error('候选产物通过链接超出任务工作目录');
  if (requireExists && !fs.statSync(absolute).isFile()) throw new Error('候选产物不是可核验文件');
  return absolute;
}

function allowed(cwd, file, scopes) {
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = fold(path.relative(cwd, file).replaceAll('\\', '/'));
  return Array.isArray(scopes) && scopes.some(scope => {
    const root = bounded(cwd, scope, false);
    const normalized = fold(path.relative(cwd, root).replaceAll('\\', '/').replace(/\/$/, ''));
    if (normalized === '') return true;
    if (normalized.includes('*')) {
      const pattern = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*');
      return new RegExp('^' + pattern + '$').test(relative);
    }
    return relative === normalized || relative.startsWith(normalized + '/');
  });
}

function captureProblem(task, report, verification) {
  if (verification?.kind !== 'semantic' || verification.pass !== false || !issues(verification.issues)) return '只有真实语义验收未通过才计入候选轮次';
  if (!report?.executor || !verification.reviewer || String(report.executor).toLowerCase() === String(verification.reviewer).toLowerCase()) return '候选必须由非执行者独立核验';
  if (!Number.isInteger(attemptOf(task)) || attemptOf(task) < 1 || report.taskId !== task.id) return '候选任务或执行轮次不匹配';
  if (unsafe(report) || unsafe(verification)) return '候选包含未核验副作用或严重安全、资金、不可逆问题，不能自动选择';
  const checks = report.checks || [];
  if (!Array.isArray(checks) || checks.some(check => check.ok !== true || check.notDispatched === true)) return '检查未执行或失败不能计作独立语义验收失败';
  const commands = [...(task.checks || []), ...(task.acceptance || []).filter(item => item && typeof item === 'object').map(item => item.check)].filter(item => typeof item === 'string' && item.trim());
  if (commands.some(command => !checks.some(check => check.command === command && check.ok === true && check.notDispatched !== true))) return '候选缺少配置检查的实际执行证据';
  return null;
}

/** Called before a failed semantic verdict requeues the task. Never reads model chat. */
export function captureExecutionCandidate({ store, run, task, report, artifactRoot, verification }) {
  const state = readState(store, run, task), attempt = attemptOf(task);
  const binding = bindingFor(run, task);
  const problem = captureProblem(task, report, verification);
  if (problem) return { status: 'ineligible', issues: [problem] };
  const existing = state.candidates.find(candidate => candidate.attempt === attempt);
  if (existing) return Object.entries(binding).every(([key, value]) => existing[key] === value) ? { status: 'existing', candidate: existing } : { status: 'ineligible', issues: ['任务目标或验收已变更，不能复用旧执行候选'] };
  try {
    const cwd = path.resolve(run.cwd), root = bounded(cwd, artifactRoot, false);
    if (!Array.isArray(report.artifacts) || !report.artifacts.length) throw new Error('候选没有真实文件产物；纯电脑操作不能从文件候选自动选择');
    const directory = path.join(root, safeId(task.id), 'candidates', `attempt-${attempt}-${randomUUID()}`);
    bounded(cwd, directory, false);
    const artifacts = [], contents = []; let total = 0;
    for (const artifact of report.artifacts) {
      const file = bounded(cwd, typeof artifact === 'string' ? artifact : artifact.path);
      // Framework checkpoints are evidence, not a second customer delivery.
      // Retain them in the original report snapshot; filter only these exact names.
      const frameworkDirectory = path.join(root, safeId(task.id));
      const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
      const frameworkName = process.platform === 'win32' ? path.basename(file).toLowerCase() : path.basename(file);
      if (samePath(path.dirname(file), frameworkDirectory) && /^(?:checkpoint\.json|report-\d+\.json)$/.test(frameworkName)) continue;
      if (!allowed(cwd, file, task.files)) throw new Error('候选产物超出该任务文件范围');
      const content = fs.readFileSync(file); total += content.length;
      if (total > MAX_CAPTURE_BYTES) throw new Error('候选文件过大，不能完整保存为自动选择证据');
      const snapshotPath = path.join(directory, `artifact-${artifacts.length}.snapshot`);
      artifacts.push({ path: file, snapshotPath, sha256: digest(content), bytes: content.length, summary: String(artifact.summary || '') });
      contents.push(content);
    }
    if (!artifacts.length) throw new Error('候选只有框架检查点，没有可比较的客户产物');
    const reportText = JSON.stringify(report, null, 2);
    const candidate = { candidateId: `${task.id}:attempt-${attempt}`, attempt, taskId: task.id, ...binding, executor: report.executor,
      reviewer: verification.reviewer, issues: verification.issues, reportPath: report.reportPath || null,
      reportSnapshotPath: path.join(directory, 'report.json'), reportHash: digest(reportText), artifacts };
    candidate.candidateHash = digest(JSON.stringify(candidate));
    fs.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < artifacts.length; index++) fs.writeFileSync(artifacts[index].snapshotPath, contents[index], { flag: 'wx' });
    fs.writeFileSync(candidate.reportSnapshotPath, reportText, { flag: 'wx' });
    state.candidates.push(candidate); store.set(keyFor(run, task), state);
    store.event?.(run.id, 'queue', `${task.id}：保留第 ${attempt} 次真实产物快照，供两轮未通过后的顾问选择`);
    return { status: 'captured', candidate };
  } catch (error) {
    const failureIssues = [String(error.message || error)];
    state.captureFailures ||= [];
    if (!state.captureFailures.some(failure => failure.attempt === attempt)) state.captureFailures.push({ attempt, ...binding, issues: failureIssues });
    store.set(keyFor(run, task), state);
    return { status: 'ineligible', issues: failureIssues };
  }
}

function verifiedCandidate(run, task, candidate) {
  const { candidateHash, ...manifest } = candidate;
  if (digest(JSON.stringify(manifest)) !== candidateHash || candidate.taskId !== task.id) throw new Error('候选记录的任务身份或哈希不一致');
  if (!Object.entries(bindingFor(run, task)).every(([key, value]) => candidate[key] === value)) throw new Error('任务目标、文件范围或验收已变更，旧候选不能换基复用');
  const report = fs.readFileSync(bounded(run.cwd, candidate.reportSnapshotPath));
  if (digest(report) !== candidate.reportHash) throw new Error('候选执行报告快照已被修改');
  const texts = candidate.artifacts.map(artifact => {
    const content = fs.readFileSync(bounded(run.cwd, artifact.snapshotPath));
    if (!allowed(run.cwd, artifact.path, task.files) || content.length !== artifact.bytes || digest(content) !== artifact.sha256) throw new Error('候选产物快照或文件范围不一致');
    if (content.includes(0)) throw new Error('候选包含顾问无法完整核验的二进制产物，需保留待核验');
    return { ...artifact, content: content.toString('utf8') };
  });
  return { ...candidate, artifacts: texts };
}

function parseSelection(response) {
  const text = String(response.text || '').trim();
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(match ? match[1] : text);
}

/**
 * Selection is guidance for one subsequent normal execution, never pass or approval.
 * Failed/unknown consultant calls keep the current deliverable in verification.
 * retry=true explicitly resumes the same bounded, read-only selection identity.
 */
export async function selectBestExecutionCandidate(orch, run, task, { signal, sessions, call, retry = false } = {}) {
  const store = orch.store, state = readState(store, run, task);
  if (state.selection?.status === 'selected') {
    try {
      const candidate = state.candidates.find(item => item.candidateId === state.selection.candidateId);
      if (!candidate || candidate.candidateHash !== state.selection.candidateHash) throw new Error('已选候选的身份或哈希不一致');
      verifiedCandidate(run, task, candidate);
      return { status: 'selected', selection: state.selection };
    } catch (error) { return { status: 'waiting', issues: [String(error.message || error)] }; }
  }
  if (state.candidates.length < 2) {
    const failures = (state.captureFailures || []).filter(failure => Object.entries(bindingFor(run, task)).every(([key, value]) => failure[key] === value));
    if (new Set([...state.candidates.map(candidate => candidate.attempt), ...failures.map(failure => failure.attempt)]).size >= 2) return { status: 'waiting', issues: ['两次语义验收未通过，但没有两份可完整比较的产物快照；保留产物待核验', ...failures.flatMap(failure => failure.issues)] };
    return { status: 'not-needed' };
  }
  if (state.selection && (!retry || state.selection.attempts >= 2)) return { status: 'waiting', issues: state.selection.issues || ['顾问选择尚未完成；现有产物和评估证据已保留'] };
  if (signal?.aborted) return { status: 'waiting', issues: ['任务已取消，未追加顾问调用'] };
  let candidates;
  try {
    // Include complete content; truncated or binary previews are never selection proof.
    candidates = state.candidates.map(candidate => verifiedCandidate(run, task, candidate));
    if (new Set(candidates.map(item => item.attempt)).size !== candidates.length) throw new Error('候选执行轮次重复');
    if (JSON.stringify(candidates).length > MAX_INLINE_CHARS) throw new Error('候选内容超过顾问可完整读取的范围，已保留待核验');
  } catch (error) { return { status: 'waiting', issues: [String(error.message || error)] }; }
  const pending = { ...(state.selection || {}), status: 'pending', selectionId: state.selection?.selectionId || `${task.id}:execution-selection:${randomUUID()}`,
    attempts: (state.selection?.attempts || 0) + 1, candidateIds: candidates.map(item => item.candidateId) };
  const reserve = () => {
    const latest = readState(store, run, task);
    // Fenced by the exact persisted prefix, including the previous call attempt.
    // Two processes cannot both reserve the same pending selection.
    if (JSON.stringify(latest) !== JSON.stringify(state)) return false;
    store.set(keyFor(run, task), { ...state, selection: pending }); return true;
  };
  if (!(store.transaction ? store.transaction(reserve) : reserve())) return { status: 'waiting', issues: ['顾问选择已由另一实例继续，保留当前产物等待结果'] };
  state.selection = pending;
  const ownsReservation = () => {
    const latest = readState(store, run, task);
    return latest.selection?.status === 'pending' && latest.selection.selectionId === pending.selectionId && latest.selection.attempts === pending.attempts;
  };
  const prompt = `同一小任务已有两次真实执行产物经非执行者独立语义验收未通过。你是只读顾问，只从真实候选选择最佳起点，给执行搭档具体局部修正意见，不改文件、不降低验收、不宣称验收通过、不覆盖严重安全、资金或不可逆反对。候选文件为执行当时的完整哈希快照，不能以当前同名文件冒充旧候选。选择后仍须正常执行、代码检查和独立核验。只返回 JSON {"candidateId":"真实候选编号","candidateHash":"真实候选哈希","reason":"具体选择理由","fixes":["对应现有验收的具体修正"]}。\n任务=${JSON.stringify({ id: task.id, title: task.title, acceptance: task.acceptance, files: task.files })}\n候选=${JSON.stringify(candidates)}\n选择身份=${pending.selectionId}`;
  const options = { role: 'consult', call: 'think', seat: 'claude', onlyAgent: true, slot: pending.selectionId, signal, sessions, build: () => prompt };
  const limits = { phase: 'execution', taskId: task.id, budget: task.tokenBudget, maxOutputTokens: 1600 };
  let response;
  try {
    response = call ? await call('claude', options, limits) : await orch.controlCall(run, options, limits);
    if (signal?.aborted) throw new Error('任务已取消，顾问结果未用于继续执行');
    if (response.by !== 'claude' || response.unknownSideEffects === true) throw new Error('顾问身份或调用副作用未确认，尚未选择执行候选');
    const value = parseSelection(response), selected = state.candidates.find(candidate => candidate.candidateId === value.candidateId);
    if (!selected || value.candidateHash !== selected.candidateHash || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000 || !Array.isArray(value.fixes) || !value.fixes.every(item => typeof item === 'string' && item.trim() && item.length <= 2000) || unsafe(value)) throw new Error('顾问未返回有效候选编号、哈希及具体理由；选择不等于验收通过');
    verifiedCandidate(run, task, selected);
    const selection = { ...pending, status: 'selected', candidateId: selected.candidateId, candidateHash: selected.candidateHash,
      reason: value.reason, fixes: value.fixes, artifacts: selected.artifacts, reportSnapshotPath: selected.reportSnapshotPath };
    const commit = () => { if (!ownsReservation()) return false; state.selection = selection; store.set(keyFor(run, task), state); return true; };
    if (!(store.transaction ? store.transaction(commit) : commit())) throw new Error('顾问选择已被新的恢复调用接续，旧答复不覆盖新状态');
    store.event?.(run.id, 'queue', `${task.id}：顾问选择 ${selected.candidateId} 为下一次执行起点，仍需正常验收`);
    return { status: 'selected', selection: state.selection, response };
  } catch (error) {
    const failureIssues = [String(error.message || error)];
    const hold = () => { if (ownsReservation()) { state.selection = { ...pending, status: 'error', issues: failureIssues }; store.set(keyFor(run, task), state); } };
    if (store.transaction) store.transaction(hold); else hold();
    return { status: 'waiting', issues: failureIssues, ...(response ? { response } : error.usage ? { response: { usage: error.usage } } : {}) };
  }
}
