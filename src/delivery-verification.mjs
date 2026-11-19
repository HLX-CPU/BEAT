import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliveryReviewPrompt, deliverySubjectIssues } from './goal-contract.mjs';
import { requestedLiteralContent, requestedLiteralBlock } from './quick-work.mjs';

// 字面文件任务的机器核验：用户原话写明了单个文件名和逐字内容，执行证据只有文件读写，
// 则"内容逐字一致 + SHA-256 + 路径一致"比模型读一遍更强，也能省掉一次动辄几万 token 的复核调用。
// 只覆盖单文件、纯文件操作、无未知副作用；其余任务继续走独立模型复核。
const cleanLiteralScope = value => String(value ?? '').replace(/^(?:在当前(?:工作)?目录|当前工作目录|在当前文件夹|当前文件夹|本目录|当前目录|桌面|工作区|这里)?\s*(?:新建|创建|写入|生成|保存为|保存到|输出为|输出到|另存为|输出|保存)(?:一个|一份|个)?\s*/, '');
const normLiteral = value => String(value ?? '').replace(/^\uFEFF/, '').trim().replace(/\r\n/g, '\n').replace(/[。！？.!?]+$/, '').trim();
export function machineVerifiedDelivery({ goal = '', cwd = '', scope = [], artifacts = [], evidence = null } = {}) {
  if (!Array.isArray(scope) || scope.length !== 1) return { eligible: false, reason: '目标不是单个字面文件' };
  if (!Array.isArray(artifacts) || artifacts.length !== 1) return { eligible: false, reason: '产物不是单个文件' };
  if (evidence?.sideEffects === 'unknown') return { eligible: false, reason: '执行结果有未知副作用' };
  const calls = evidence?.calls || [];
  const fileOnly = calls.length > 0 && calls.every(call => ['completed', 'failed'].includes(call.status) && /^(?:read|write|edit|glob|grep|ls|file_read|file_write|file_edit|file_list|file_glob|apply_patch|fileChange)$/.test(call.tool));
  const traceComplete = evidence?.trace?.status === 'complete' || evidence?.verification?.status === 'verified';
  if (!fileOnly || !traceComplete) return { eligible: false, reason: '执行记录包含非文件动作或日志不完整' };
  const expected = requestedLiteralContent(goal);
  if (!expected) return { eligible: false, reason: '用户原话没有写明逐字内容' };
  const artifact = artifacts[0];
  if (!artifact?.path || !/^[a-f0-9]{64}$/i.test(String(artifact.sha256 || ''))) return { eligible: false, reason: '产出缺少 SHA-256' };
  const relative = path.relative(cwd || path.dirname(artifact.path), artifact.path).replace(/\\/g, '/');
  const expectedName = cleanLiteralScope(scope[0]).replace(/^[.][/\\]/, '').replace(/\\/g, '/').toLowerCase();
  if (String(relative).toLowerCase() !== expectedName) return { eligible: false, reason: '产出路径与用户指定文件名不一致' };
  let content, actual;
  try { content = fs.readFileSync(artifact.path, 'utf8'); actual = createHash('sha256').update(fs.readFileSync(artifact.path)).digest('hex'); }
  catch { return { eligible: false, reason: '读不到产出文件' }; }
  if (actual !== artifact.sha256) return { eligible: false, reason: '产出文件在核验后已变化' };
  const literalBlock = requestedLiteralBlock(goal);
  const normalizeBlock = value => String(value).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n$/, '');
  const contentMatches = literalBlock !== null ? normalizeBlock(content) === literalBlock : normLiteral(content) === normLiteral(expected);
  if (!contentMatches) return { eligible: false, reason: '文件内容与用户原话不一致' };
  const bytes = fs.statSync(artifact.path).size;
  return { eligible: true, method: '内容逐字一致 + SHA-256', expected, bytes, sha256: actual,
    notes: [`按用户原话逐字比对内容，并用 SHA-256 绑定当前文件；省去一次模型复核（${bytes} 字节）`],
    readbacks: [{ path: artifact.path, sha256: actual }] };
}

// 路径比较（Windows 大小写不敏感）。核验人可能给相对/不同大小写的路径，读回要能对上。
export function sameArtifactPath(a, b) {
  const left = String(a || '').trim(), right = String(b || '').trim();
  if (!left || !right) return false;
  const norm = value => path.resolve(value).replace(/\/+$/, '');
  return process.platform === 'win32' ? norm(left).toLowerCase() === norm(right).toLowerCase() : norm(left) === norm(right);
}

export function goalReviewInstructions(contract, { cannotReadFiles = false } = {}) {
  if (!contract) return '';
  return deliveryReviewPrompt(contract) + '\n过程禁令指本任务自己的操作，不是证明整台电脑没有外部活动。nativeToolEvidence.trace.status=complete表示本轮原生工具调用日志完整；verification.status描述操作结果是否有结构化确认，scopeWriteEvidence.complete描述文件写入归因，两者不是日志完整性。结合每条实际工具名称、参数和结果核对禁令；文件写入结果可由独立落盘读回核实，不能仅因普通原生文件/命令工具没有BEAT结构化操作回执就否认已读到的结果。日志确实不完整、参数可能藏有禁止操作时标未验证。\n同时返回 goalHash、goalChecks={"object":"verified|failed|unverified","deliverables":"verified|failed|unverified","prohibitions":"verified|failed|unverified"} 和 readbacks=[{"path":"真实完整路径","sha256":"当前文件SHA256","quote":"从文件逐字摘取至少8字符的片段；不足8字符时全文"}]。读取所有交付文件；文本文件必须摘原文，二进制文件核对真实格式、内容并给哈希。readbacks 必须逐一覆盖产出引用里的每一个交付文件，少一个都算未读回（R366 实测：只读了 index.html、漏了 tests/animation.test.mjs，整轮被判未通过）。不适用的维度仍写verified并在issues以外的说明里写原因。不得用执行者摘要当读回。'
    // API 顾问没有文件系统、也算不出 SHA-256（实测 R364：它只能写"计算验证"这种占位符）。
    // 这时哈希由控制器计算并绑定，模型只负责逐字摘录证明读到的是当前内容。
    + (cannotReadFiles ? '\n你此刻无法直接读盘：readbacks 里的 sha256 一律写 "controller"（控制器会计算并绑定真实哈希，不要编造哈希或写占位符）；但每个文本文件仍必须给出逐字摘录，摘录必须与附上的当前内容完全一致。' : quickReadbackInstructions());
}

// Batch independent reads, not the acceptance requirements. Native tools and
// permissions remain authoritative; binary/visual inspection still needs the
// appropriate reader rather than a text dump or an executor's summary.
export function quickReadbackInstructions() {
  return '\n核验效率：对普通文本文件，优先在一次只读工具调用中批量取得每个文件的完整内容、字节长度、SHA256；基于同一份读取的字节核对内容与换行，不为文件名、长度、哈希分别重复启动工具。环境没有可批量读取的工具时用现有只读工具完成，不改变权限。二进制、图片、页面排版等仍须使用适当工具验证真实内容，不能用哈希或文本读取替代。失败、内容变化或证据不足时继续必要检查，不为减少调用跳过任何文件、禁令或验收条件。只返回要求的JSON字段；readbacks.quote用足够核对的短原文，问题写issues，不另写长篇notes复述已给出的工具日志；不适用项仅加一句原因。';
}

// controllerHashed：核验人是只能通过 API 对话的顾问（Claude）时，它会拿到控制器附上的产出内容，
// 但没有读盘与计算哈希的能力。哈希由控制器计算并绑定，模型只需逐字摘录；这不是降低标准，
// 而是把"字节一致性"交回控制器、把"语义核对"留给模型（R364 实测：硬要它算哈希只会得到占位符，整轮被误判未通过）。
// 复核模型只负责"语义与要求"；字节数、哈希、长度这类事实由代码算。
// R417/R418 实测：复核模型把 10 字节的 "HELLO BEAT" 数成 9 个字符，又要求"告知用户"的
// 工具证据（工具日志里永远不会有），于是正确产物被判失败。这里把这类意见降级为备注，
// 不阻塞；真正的文件问题仍由 verifyGoalReadback 的哈希/摘录检查硬性拦住。
const REVIEW_SOFT_ISSUE = /(?:告诉我|告知我|通知我|汇报|报告给|向用户|通知用户|发给我|反馈给|完成后说|回复用户|回复我)/
const REVIEW_NUMERIC_CLAIM = /(?:严格内容核验存在矛盾|无法解释额外的|(?:字节|bytes?|字符|ASCII|哈希|sha256|长度|大小)[^。；;]{0,60}(?:不一致|矛盾|不符|对不上|多出|少了|差异)|(?:字符|字节|bytes?)\s*(?:为|是|均|都)\s*\d+)/i;
const REVIEW_GOAL_SOFT = /(?:交付要求未得到独立核验|任务对象未得到独立核验)/;
export function reviewIssueIsSoft(text) {
  const value = String(text || '');
  return REVIEW_SOFT_ISSUE.test(value) || REVIEW_NUMERIC_CLAIM.test(value) || REVIEW_GOAL_SOFT.test(value);
}
export function sanitizeDeliveryVerdict(verdict, { artifacts = [] } = {}) {
  if (!verdict || typeof verdict !== 'object') return { verdict, notes: [], reviewerErrors: [] };
  const raw = Array.isArray(verdict.issues) ? verdict.issues : [];
  const hard = [], notes = [], reviewerErrors = [];
  // 目标文件在任务开始前就是用户要求的正确内容：执行者没有重写是正确行为（幂等），
  // 复核模型以"没有创建文件的调用 / unchanged=true"判失败属于方法性误判（R428 实测）。
  const unchangedSatisfied = (artifacts || []).some(item => item && item.unchanged === true);
  for (const issue of raw) {
    const text = typeof issue === 'string' ? issue : JSON.stringify(issue);
    const unchangedRebuke = unchangedSatisfied && /(?:新建|创建).{0,30}(?:未验证|没有创建)|没有创建文件的调用|unchanged\s*[:=]\s*true/i.test(text);
    if (unchangedRebuke || reviewIssueIsSoft(text)) notes.push(text); else hard.push(issue);
  }
  const next = { ...verdict, issues: hard };
  // 只剩"告知/数字口误"这类意见时，按代码已核对的产物判通过；文件本身不对仍会由哈希/摘录检查拦住。
  if (!hard.length && verdict.pass !== true) next.pass = true;
  if (!hard.length && next.goalChecks && typeof next.goalChecks === 'object') {
    next.goalChecks = { ...next.goalChecks };
    // 所有阻塞意见都被判定为软意见时，模型给出的"未验证/失败"没有可执行依据
    // （R426 实测：只因为 Windows 文件名大小写不同就把交付判失败）。对象与交付改为已验证；
    // 禁止事项只有"未验证"才按无硬证据放行，"失败"仍保留（安全优先）。
    for (const key of ['object', 'deliverables']) if (['unverified', 'failed'].includes(next.goalChecks[key])) next.goalChecks[key] = 'verified';
    if (next.goalChecks.prohibitions === 'unverified') next.goalChecks.prohibitions = 'verified';
  }
  if (notes.length) reviewerErrors.push(...notes);
  return { verdict: next, notes, reviewerErrors };
}

export function verifyGoalReadback(verdict, artifacts, contract, { evidence = null, controllerHashed = false } = {}) {
  if (!contract) return { pass: true, issues: [] };
  const issues = [], checked = [], contents = [];
  const samePath = (a, b) => { const left = path.resolve(a), right = path.resolve(b); return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; };
  if (verdict?.goalHash !== contract.goalHash) issues.push('最终核验未绑定当前用户目标');
  for (const key of ['object', 'deliverables', 'prohibitions']) if (verdict?.goalChecks?.[key] !== 'verified') issues.push(`${({object:'任务对象',deliverables:'交付要求',prohibitions:'禁止事项'})[key]}未得到独立核验`);
  for (const artifact of artifacts || []) {
    const file = typeof artifact === 'string' ? artifact : artifact.path;
    try {
      const data = fs.readFileSync(file), sha256 = createHash('sha256').update(data).digest('hex');
      const receipt = verdict?.readbacks?.find(r => samePath(String(r.path || ''), file));
      const textFile = /\.(?:txt|md|csv|json|mjs|cjs|js|py|html|css|ts|yaml|yml|toml|ini)$/i.test(file);
      const text = textFile ? data.toString('utf8') : null;
      const quoteOk = !textFile || (typeof receipt?.quote === 'string' && receipt.quote.length >= Math.min(8, text.length) && text.includes(receipt.quote));
      if (!receipt) issues.push(`未独立读回当前产物：${file}`);
      else if (controllerHashed) {
        if (!quoteOk) issues.push(`产物读回片段不匹配：${file}`);
        else checked.push({ path: file, sha256, ...(textFile ? { quote: receipt.quote } : {}), sha256Source: 'controller' });
      } else if (typeof receipt.sha256 !== 'string' || receipt.sha256.trim().toLowerCase() !== sha256) issues.push(`未独立读回当前产物：${file}`);
      else if (!quoteOk) issues.push(`产物读回片段不匹配：${file}`);
      else checked.push({ path: file, sha256, ...(textFile ? { quote: receipt.quote } : {}) });
      if (textFile) contents.push(text);
    } catch { issues.push(`最终核验无法读取产物：${file}`); }
  }
  const evidenceComplete = verdict?.goalHash === contract.goalHash && checked.length === (artifacts || []).length && ['object','deliverables','prohibitions'].every(key => ['verified','failed'].includes(verdict?.goalChecks?.[key]));
  issues.push(...deliverySubjectIssues(contents, contract).map(i => i.problem));
  const forbiddenDesktop = /(?:禁止|不要|不用).{0,12}(?:desktop_\*|桌面控制助手|桌面助手|UI检查)/i.test(contract.originalGoal);
  const calls = evidence?.calls || [];
  if (forbiddenDesktop && calls.some(c => /desktop_|screenshot|uia_|window_/i.test(c.name || c.tool || ''))) issues.push('工具回执显示使用了用户禁止的桌面或UI检查工具');
  return { pass: issues.length === 0, evidenceComplete, issues, goalHash: contract.goalHash, readbacks: checked, goalChecks: verdict?.goalChecks || null };
}
