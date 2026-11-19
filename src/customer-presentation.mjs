import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const internal = file => /(?:^|[\\/])(?:\.beat-control|\.beat-attachments)(?:[\\/]|$)/i.test(file);
const states = { queued:'正在排队', waiting_input:'需要你补充信息', discussing:'正在商量方案', planning:'正在准备方案', executing:'正在制作', evaluating:'正在检查结果', verifying:'正在检查结果', passed:'已完成并核验', done:'已答复', failed:'尚未完成', error:'暂时受阻', interrupted:'进度已保留', cancelled:'已停止' };
const fingerprintCache = new Map();
function currentHash(file, stat) {
  const key = file + ':' + stat.size + ':' + stat.mtimeMs + ':' + stat.ctimeMs;
  if (fingerprintCache.has(key)) return fingerprintCache.get(key);
  // Avoid hashing large media on every dashboard poll. A fresh independent
  // review still hashes the actual file before accepting it.
  if (stat.size > 16 * 1024 * 1024) return null;
  const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (fingerprintCache.size > 256) fingerprintCache.clear();
  fingerprintCache.set(key, hash); return hash;
}
export function customerPresentation(view, { roots = [] } = {}) {
  const candidates = [
    ...(view.quickWorkEvidence?.artifacts || []),
    ...(view.recovery?.artifacts || []),
    ...(view.deliveryVerification?.readbacks || []),
    ...(view.taskQueue || []).flatMap(t => t.outputs || t.artifacts || t.result?.artifacts || []),
  ];
  const artifacts = new Map();
  for (const item of candidates) {
    const file = typeof item === 'string' ? item : item?.path;
    if (!file || !path.isAbsolute(file) || internal(file)) continue;
    try {
      const real = fs.realpathSync(file), allowed = [view.cwd, ...roots].filter(Boolean);
      const insideAllowed = allowed.some(root => { try { const rel = path.relative(fs.realpathSync(root), real); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); } catch { return false; } });
      // 已绑定 sha256 的真实文件写在哪里都要能展示和评估（客户明确要求不限制默认目录）；
      // 只有模型随口给出、没有哈希归属的路径才要求落在工作区内。
      const trusted = typeof item === 'object' && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(item.sha256);
      if (!insideAllowed && !trusted) continue;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const expected = typeof item === 'object' ? item.sha256 : null;
      const actual = expected ? currentHash(real, stat) : null;
      const verified = !!expected && actual === expected && (view.deliveryVerification?.pass === true || view.state === 'passed');
      const changed = !!expected && !!actual && actual !== expected;
      // 老记录/二次汇总可能没有 rolledBackPaths：完整撤销时按 changes 兜底；部分撤销只认已记录的路径。
      const recorded = view.checkpoint?.rolledBackPaths || [];
      const rolledBackPaths = new Set((recorded.length ? recorded : (view.checkpoint?.rolledBackAt && view.checkpoint?.partial !== true ? (view.checkpoint?.changes || []).map(item => item.path) : [])).map(item => { try { return path.resolve(String(item)).toLowerCase(); } catch { return ''; } }));
      const rolledBack = rolledBackPaths.has(real.toLowerCase());
      const previous=artifacts.get(real.toLowerCase());
      if(previous && !expected)continue;
      artifacts.set(real.toLowerCase(), { path: real, name: path.basename(real), bytes: stat.size, verified: rolledBack ? false : verified, changed,
        status: rolledBack ? '文件改动已撤销，已恢复到执行前' : changed ? '核验后文件已变化，请重新检查' : verified ? '已核验' : expected&&!actual&&view.deliveryVerification?.pass ? '曾通过核验（大文件现状未重查）' : '文件已生成，待核验' });
    } catch { /* No model-claimed or missing path is promoted to a deliverable. */ }
  }
  const active = !['done','passed','failed','error','interrupted','cancelled'].includes(view.state);
  const running = [...(view.steps || [])].reverse().find(s => s.state === 'running');
  const phase = running?.role || '';
  const who = running?.by || running?.agent || null;
  const checking = /评估|验收|evaluate|check/.test(phase);
  const knownOutputs = artifacts.size > 0;
  const verifyOnly = view.quickWorkEvidence?.verificationOnly === true || view.recovery?.mode === 'verification-only';
  const planStructureFailure = view.failureCode === 'PLAN_STRUCTURE'
    || /每个文件任务必须划定文件范围|每个小任务必须写清验收标准|任务依赖引用无效/.test(String(view.error || ''));
  const label = active ? checking ? '正在检查结果' : states[view.state] || '正在处理'
    : verifyOnly && !['passed','done','cancelled'].includes(view.state) ? '成果已保留，待核验'
    : planStructureFailure ? '方案缺文件，没有开工' : states[view.state] || '正在处理';
  // 已用时按任务创建时间算：执行阶段会重置 started_at，只按它算会把讨论花的十几分钟显示成 0 秒。
  const start = Date.parse(view.created_at || view.started_at), end = Date.parse(view.ended_at);
  const elapsedSeconds = Number.isFinite(start) ? Math.max(0, Math.floor(((Number.isFinite(end) ? end : Date.now()) - start) / 1000)) : null;
  return { label, active, who, phase: checking ? '核对文件和原始要求' : phase || (active ? '准备任务' : null), elapsedSeconds,
    completedTasks: (view.taskQueue || []).filter(t => t.state === 'passed').length, totalTasks: view.taskQueue?.length || 0,
    artifacts: [...artifacts.values()], verifyOnly,
    next: view.needsInput ? '补充下面的信息后继续。' : active&&knownOutputs ? '已有成果正在继续检查，无需重复提交。' : verifyOnly && view.state !== 'passed' ? '继续检查已有成果，不重复执行原操作。' : knownOutputs && view.state === 'passed' ? '打开成果查看，或继续提出修改要求。' : view.workflow?.resume?.label || null,
    usage: { calls: view.tokenUsage?.calls ?? 0, tokens: view.tokenUsage?.totalTokens ?? null, measured: view.tokenUsage?.measuredTokens ?? null,
      estimated: view.tokenUsage?.estimatedTokens ?? null, cache: view.tokenUsage?.cacheReadTokens ?? null, budgetEnforced: view.tokenBudgetEnforced === true,
      cost: null, notice: '模型额度由账号或 API 提供方另行计费；token 不是金额，实际费用以提供方账单为准。' } };
}
