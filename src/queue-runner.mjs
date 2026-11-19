// Pull-based execution: one live conversation per worker, reference-only handoffs,
// immediate automatic checks followed by an independent, criterion-only review.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inferTaskFiles, normalizeTaskFiles } from './plan-structure.mjs';
import { runChecks, describeChecks, registeredCheckFor, classifyCheckFailure } from './checks.mjs';
import { snapshot, diffSnapshots } from './workspace.mjs';
import { lastJson } from './prompts.mjs';
import { normalizeUsage, estimateTokens } from './control-budget.mjs';
import { quietLimitMs, rememberQuietGap } from './stall.mjs';
import { nativeToolPrompt, requestedDestination } from './quick-work.mjs';
import { defaultUserFolders } from '../workspaces/shared/desktop-assistant/core/security.mjs';
import { captureExecutionCandidate, selectBestExecutionCandidate } from './advisor-execution-selection.mjs';
import { renderHtmlEvidence, describeRenderGaps } from './html-render-verification.mjs';
import { goalReviewInstructions, verifyGoalReadback, sameArtifactPath } from './delivery-verification.mjs';
import { forbidsBeatAssistant } from './goal-contract.mjs';
import { sealNativeToolTrace } from './native-evidence.mjs';
import { insideDirectory } from './path-containment.mjs';
import { compactEvidence } from './evidence-compact.mjs';
import { executionAttemptKey } from './execution-key.mjs';
import { visualAttachments, imageReadFailure, verificationWaitMessage } from './visual-evidence.mjs';
import { buildExecutionAudit, formatExecutionAudit } from './execution-audit.mjs';
import { executionGuardrail, outputGuardrail, formatGuardrails } from './guardrails.mjs';

const TERMINAL = new Set(['passed', 'blocked', 'failed', 'cancelled']);
// 词法包含判断的唯一实现在 ./path-containment.mjs（与 checkpoint/task-queue/orchestrator 共用）。
const inside = insideDirectory;
const safeId = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
const strings = values => [...new Set((values || []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
// Retain the exact controller-owned checkpoint as audit evidence. It is a
// customer deliverable only when explicitly declared, never merely because an
// executor included it in its artifact list. Other files named checkpoint.json
// continue through normal delivery verification.
export function partitionExecutionArtifacts(cwd, task, artifacts, checkpointPath) {
  const fold = file => { const resolved = path.resolve(cwd, file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
  const checkpoint = fold(checkpointPath);
  const declared = [...(task.files || []), ...(task.outputRefs || []).map(item => typeof item === 'string' ? item : item?.path)].filter(item => typeof item === 'string').some(file => fold(file) === checkpoint);
  const internalArtifacts = declared ? [] : artifacts.filter(item => fold(item.path) === checkpoint);
  return { artifacts: artifacts.filter(item => !internalArtifacts.includes(item)), internalArtifacts };
}
// 控制器自己的 .beat-control 检查点/报告不是执行者的业务写入。核验模型看到这些路径
// 会误判“修改了其他文件”（R470 实测），送给它之前先剔除；完整证据仍留在产出报告里。
const isControlCall = item => {
  if (!item || typeof item !== 'object') return false;
  const text = JSON.stringify(item);
  if (!/\.beat-control[\\/]/i.test(text)) return false;
  return Boolean(item.tool || item.path || item.args || item.result || item.record || item.file);
};
export function stripControlEvidence(value, depth = 0) {
  if (value == null || depth > 8) return value;
  if (Array.isArray(value)) return value.filter(item => !isControlCall(item)).map(item => stripControlEvidence(item, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = stripControlEvidence(item, depth + 1);
  return out;
}
// 执行者交付报告里点名的产物路径：这是它自己写过的可归因证据，不能当成“来源不明的其他改动”。
export function reportedExecutionPaths(parsed) {
  return (parsed?.artifacts || []).map(item => typeof item === 'string' ? item : item?.path).filter(file => typeof file === 'string' && file.trim());
}

// 客户看到的失败原因：解析类错误说人话（原始英文 SyntaxError 只留在日志/证据里）。
const PARSE_ERROR = /Expected .* after property value|Unexpected token|is not valid JSON|JSON at position|Unexpected end of JSON/i;
// 核验搭档“没答上来”（空答、卡住、超时、上游 5xx）不是产出有问题：重问/换人/挂起核验，不能重跑执行。
const REVIEWER_UNAVAILABLE = /桌面搭档未完成|接口返回空答|返回空答|没有最终答案或工具调用|连续\s*\d+\s*秒没有任何输出|首字超时|整体超时|卡住|ECONNRESET|ECONNREFUSED|ETIMEDOUT|HTTP\s*5\d\d/i;
const issueText = error => {
  const raw = String(error?.message || error || '未通过').slice(0, 2000);
  if (PARSE_ERROR.test(raw)) return '这一轮搭档返回的内容格式不对（JSON 解析失败），已保留产出；点「继续」只会重新核验，不重做已经完成的工作';
  return raw;
};
// 环境/权限类失败的真实原因：沙箱不允许启动子进程（spawn EPERM）、外部工具不存在（ENOENT）、
// 命令超时等。这份规则只负责从原文里提取"真实原因"；是不是环境类优先由 checks.mjs 的
// classifyCheckFailure 判定（同一份真相，避免两处说法不一致）。取消/超时用结构化标志判定，
// 不靠文本里的 "cancelled"——node --test 的汇总行本身就会打印 "cancelled 0"。
const ENVIRONMENT_FAILURE = [
  /spawn\s+EPERM/i, /\bEPERM\b/, /\bEACCES\b/, /\bENOENT\b/, /\bEPIPE\b/, /\bEAGAIN\b/, /\bEBUSY\b/,
  /\bETIMEDOUT\b/, /\bETIMEOUT\b/, /\bECONNREFUSED\b/, /\bECONNRESET\b/, /\bENOTFOUND\b/,
  /operation not permitted/i, /permission denied/i, /access is denied/i, /拒绝访问/, /沙箱/,
  // Windows 上"沙箱不允许创建进程"的失败：Codex 的检查工具实测报
  // "CreateProcessAsUserW 错误 -1073283067"（0xC0000142 DLL 初始化失败）。这跟 EPERM 是一类，
  // 不是执行者的错——R179 里因为没认出来，把读不到文件的核验当成"执行者要修"，白烧一轮返工。
  /CreateProcessAsUser/i, /0xC0000142/i, /-1073283067/i,
];
export function environmentFailure(...texts) {
  const raw = texts.filter(value => typeof value === 'string' && value.trim()).join(' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const matched = ENVIRONMENT_FAILURE.map(pattern => raw.match(pattern)).find(Boolean);
  return matched ? { matched: matched[0], raw: raw.slice(0, 300), class: 'environment-permission' } : null;
}
const DEFAULT_RECOVERY = '环境恢复后点「继续」只重新核验已有产物，不重做已完成的工作';
const environmentNote = (hit, recovery) => `[环境/权限限制] 真实原因：${hit.raw}。这类失败来自运行环境或权限设置（例如沙箱不允许启动子进程、外部工具缺失或命令超时），不等于执行者失职，BEAT 不把它当作执行者违规。${recovery || DEFAULT_RECOVERY}`;
/** 失败收敛出口统一走这里：环境类失败必须连原因原文和分类一起写进 verdict。 */
export function failureIssues(error, { checkpointPath } = {}) {
  const issues = [issueText(error)];
  const hit = error?.scopeGrading === true ? null : environmentFailure(String(error?.code || ''), String(error?.message || error || ''));
  const recovery = checkpointPath ? `检查点已保留：${checkpointPath}；环境恢复后点「继续」可从检查点接着做` : undefined;
  return hit ? { issues: [...issues, environmentNote(hit, recovery)], environment: hit } : { issues, environment: null };
}
/** 单条检查结果是不是环境/权限受限：优先用 checks.mjs 的同一套归类，其次看结构化标志。 */
function checkEnvironmentHit(check) {
  if (!check || check.ok === true || check.exitCode === 0) return null;
  let classified = null;
  try { classified = typeof classifyCheckFailure === 'function' ? classifyCheckFailure(check) : null; } catch { classified = null; }
  const environment = classified ? classified.kind === 'environment' : (check.notDispatched === true || check.timedOut === true || check.cancelled === true);
  if (!environment) return null;
  const text = `${check.command || ''}\n${check.output || ''}`;
  return environmentFailure(text) || { matched: classified?.reason ? String(classified.reason).slice(0, 120) : '检查未派发/超时/被取消（结构化标志）', raw: String(check.output || check.command || '环境限制导致检查没有取得可判定的结果').replace(/\s+/g, ' ').trim().slice(0, 300), class: 'environment-permission' };
}
/** 检查结果里的环境类真实原因：同样要写进 verdict，不能只报"检查失败"。 */
function checkFailureIssues(issues, checks, recovery) {
  const hit = (checks || []).map(checkEnvironmentHit).find(Boolean);
  return hit ? { issues: [...issues, environmentNote(hit, recovery)], environment: hit } : { issues, environment: null };
}
/**
 * 范围外改动必须分级叙述：只有能归因到执行者工具日志的越界写入，才可以说"执行者写到了任务文件范围外"；
 * 归因不完整的窗口内改动是来源不明的，单独成段并明确"无法归因给执行者"，不得与其并列成执行者违规。
 */
export function scopeFailureText(executor, observed, unattributed) {
  const paragraphs = [];
  if (observed?.length) paragraphs.push(`执行者${executor ? `（${executor}）` : ''}写到了本任务文件范围外（来自执行者工具日志的可归因写入）。文件范围外的改动：${observed.join('、')}`);
  if (unattributed?.length) paragraphs.push(`本任务窗口内检测到来源不明的其他改动（可能是你自己、编辑器或其他程序写的），无法归因给执行者；这些改动位于本任务文件范围外，但归因证据不完整，不认定为执行者越界，只按未知副作用隔离、需人工确认：${unattributed.join('、')}`);
  return paragraphs.join('\n\n');
}
// 核验只需要一小段 JSON，但推理型拓展坞会先花掉大量输出 token：给它们和执行同等的余量，
// 否则 finish_reason=length、没有最终答案，核验被误判成失败（R82 实测 claude-fable-5-1）。
// 契约要求逐件读回（path+sha256+quote），产物越多输出越长；上限不足会被截断成无法解析的 JSON
// （R335 实测：拓展坞核验的完整答复被切到 772 字符，lastJson 返回 null，7 项交付核验全判未通过）。
const reviewOutputCap = (worker, artifacts = 0) => (String(worker || '').startsWith('dock:') || worker === 'claude' ? 1600 : 600) + Math.max(0, Math.floor(Number(artifacts) || 0)) * 320;
// 给不能读盘的顾问附上产出文件内容（有上限，二进制只给名字）。
const inlineArtifacts = (artifacts, budget = 60000) => {
  let out = '';
  for (const item of artifacts || []) {
    if (out.length >= budget) { out += '\n…（其余文件内容已省略）'; break; }
    let text; try { const buf = fs.readFileSync(item.path); text = buf.includes(0) ? '（二进制文件，未附内容）' : buf.toString('utf8'); } catch { text = '（读取失败）'; }
    out += `\n--- ${item.path}\n${text.slice(0, Math.max(2000, budget - out.length))}\n`;
  }
  return out;
};
// 核验人漏读某个交付文件时补问一次：只补 readbacks，不重新评价、不改 pass/issues。
// 为什么需要（R366 实测）：任务与 4 条验收全过，Claude 的 readbacks 只给了 index.html、漏了
// tests/animation.test.mjs，控制器按"未独立读回"判整轮失败——产物其实没问题。
// 只对不能读盘的顾问用（控制器已经把内容附给它了，补问只是让它把漏的文件摘录补齐）。
export async function fillMissingReadbacks({ artifacts = [], verdict, ask } = {}) {
  const files = (artifacts || []).map(item => (typeof item === 'string' ? item : item?.path)).filter(Boolean);
  const receipts = Array.isArray(verdict?.readbacks) ? verdict.readbacks : [];
  const missing = files.filter(file => !receipts.some(receipt => sameArtifactPath(String(receipt?.path || ''), file)));
  if (!missing.length) return { verdict, missing: [], filled: [] };
  if (typeof ask !== 'function') return { verdict, missing, filled: [] };
  const text = await ask(missing);
  const patch = lastJson(text);
  const got = Array.isArray(patch?.readbacks) ? patch.readbacks : [];
  const merged = [...receipts];
  const filled = [];
  for (const file of missing) {
    const receipt = got.find(item => sameArtifactPath(String(item?.path || ''), file));
    if (!receipt) continue;
    merged.push(receipt);
    filled.push(file);
  }
  return { verdict: { ...(verdict || {}), readbacks: merged }, missing, filled };
}
const unknownInput = evidence => evidence?.unknownSideEffects === true || evidence?.sideEffects === 'unknown'
  || evidence?.desktopEvidence?.sideEffects === 'unknown' || evidence?.nativeToolEvidence?.sideEffects === 'unknown'
  || evidence?.calls?.some(call => call.unknownSideEffects === true || call.evidence?.sideEffects === 'unknown');
const stateOf = task => task.state || task.status;
const usageOf = result => normalizeUsage(result.usage) || { totalTokens: estimateTokens(result.prompt || '') + estimateTokens(result.text || ''), estimated: true, verified: false, source: 'estimate' };

export function workerMinimumTokens(worker, mode, control = {}, task) {
  if (typeof control.workerMinTokens === 'function') {
    const value = control.workerMinTokens(worker, mode, task);
    return Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.ceil(Number(value)) : Infinity;
  }
  const entry = control.workerMinTokens?.[worker];
  const value = typeof entry === 'number' ? entry : entry?.[mode];
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.ceil(Number(value)) : 0;
}

/** Minimum assistant context is admission-control evidence, never billed usage. */
export function taskRouting(task, workers, control = {}) {
  // 预算默认只显示不拦截：未开启硬限制时不按 token 排除搭档。
  const available = strings(workers), limit = Number(task.tokenBudget ?? control.taskTokenBudget ?? 12000);
  const budget = control.tokenBudgetEnforced !== true ? Infinity : Number.isFinite(limit) ? Math.max(0, limit) : 0, excluded = [];
  const filter = candidates => strings(candidates).filter(worker => {
    const minimumTokens = workerMinimumTokens(worker, 'work', control, task);
    const reason = !available.includes(worker) ? '搭档当前不可用' : minimumTokens > budget ? `接口上下文估算至少 ${minimumTokens} token，任务可用预算 ${budget}` : null;
    if (reason) { if (!excluded.some(item => item.worker === worker && item.reason === reason)) excluded.push({ worker, minimumTokens, reason, measurement: 'estimate' }); return false; }
    return true;
  });
  let eligibleWorkers, routingReason = '';
  if (Array.isArray(task.eligibleWorkers)) {
    eligibleWorkers = filter(task.eligibleWorkers);
    // 方案点名的那位搭档掉线/暂停（不是预算问题）时，BEAT 直接改派给在线搭档，不让客户干等。
    const offline = excluded.filter(item => item.reason === '搭档当前不可用').map(item => item.worker);
    if (!eligibleWorkers.length && offline.length) {
      eligibleWorkers = filter(available);
      if (eligibleWorkers.length) routingReason = `指定执行搭档（${offline.join('、')}）当前不可用，已由 BEAT 改派给 ${eligibleWorkers.join('、')}；仍有独立核验把关`;
    }
  }
  else if (control.difficultyRouting === false) eligibleWorkers = filter(available);
  else if (task.escalated || ['hard', 'complex', 'high', 'difficult'].includes(String(task.difficulty).toLowerCase())) {
    eligibleWorkers = filter(control.strongAgent ? [control.strongAgent] : available);
    // 首次执行的难题：强搭档掉线时先交给在线搭档做，不让客户干等；重试升级后的任务仍只给强搭档。
    if (!eligibleWorkers.length && !task.escalated && control.strongAgent && !available.includes(control.strongAgent)) {
      eligibleWorkers = filter(available);
      if (eligibleWorkers.length) routingReason = `强搭档暂时不在线，先由 ${eligibleWorkers.join('、')} 执行；仍有独立核验把关`;
    }
    if (!eligibleWorkers.length) routingReason = `强搭档（${control.strongAgent || '未设置'}）当前不可用或接口上下文超出剩余预算：任务会保留；恢复额度后点「继续」，或在看板设置里更换强搭档`;
  } else if (['easy', 'simple', 'low'].includes(String(task.difficulty).toLowerCase()) && control.cheapAgents?.length) {
    eligibleWorkers = filter(control.cheapAgents);
    if (!eligibleWorkers.length) {
      eligibleWorkers = filter(control.strongAgent ? [control.strongAgent] : available);
      routingReason = eligibleWorkers.length ? `轻量搭档不可用或接口上下文超出预算，已显式升级到 ${eligibleWorkers.join('、')}` : '轻量搭档与升级搭档均不满足当前预算：任务会保留；可提高单任务预算后点「继续」，或稍后重试';
    }
  } else eligibleWorkers = filter(available);
  // 方案或控制器点名的 owner 必须真正有资格接单：难度/成本路由只决定候选池，
  // 不能把明确指定的执行人排除掉，否则“分工”只是写给人看的。
  // 只在没有 eligibleWorkers 硬限制、且不是重试升级时生效；升级仍按强搭档规则走。
  const designated = task.owner ? String(task.owner).trim().toLowerCase() : '';
  if (!Array.isArray(task.eligibleWorkers) && designated && !task.escalated) {
    const ownerEligible = filter([designated]);
    if (ownerEligible.length && !eligibleWorkers.includes(designated)) {
      eligibleWorkers = [designated, ...eligibleWorkers.filter(id => id !== designated)];
      routingReason = routingReason ? routingReason + '；方案指定 ' + designated + ' 优先' : '方案指定 ' + designated + ' 优先';
    }
  }
  if (!eligibleWorkers.length && !routingReason) routingReason = '没有满足当前接口上下文预算的可用执行搭档，保留任务等待处理';
  if (excluded.length && !routingReason) routingReason = '已按接口上下文估算排除预算不足或不可用的搭档';
  return { eligibleWorkers, excluded, routingReason, availableTokens: budget, measurement: 'estimate' };
}

export function routeTask(task, workers, control = {}) {
  return taskRouting(task, workers, control).eligibleWorkers;
}

// 仅客户显式授权才放宽文件范围。
function allowAnyWrite(control) {
  return control?.allowAnyWrite === true;
}

function allowedFile(cwd, file, scopes) {
  const fold=value=>process.platform==='win32'?value.toLowerCase():value;
  const target = fold(path.resolve(cwd, file).replaceAll('\\', '/'));
  // 客户要求不限制默认目录：方案里显式声明的任务目录外绝对路径同样可以作为本任务文件范围。
  return scopes.some(scope => {
    const normalized = fold(path.resolve(cwd, scope).replaceAll('\\', '/').replace(/\/$/, ''));
    if (normalized === '') return true;
    if (normalized.includes('*')) {
      const pattern = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*');
      return new RegExp('^' + pattern + '$').test(target);
    }
    return target === normalized || target.startsWith(normalized + '/');
  });
}

// 文件任务必然要建父目录：执行者工具日志只报了目录本身时，只要它是某个允许文件的祖先目录，
// 就不能当成“写到了文件范围外”（R408 实测：写 src/review.html 时 file_mkdir src 被误判越界，白重试一次）。
function allowedAncestorDir(cwd, file, scopes) {
  let stat; try { stat = fs.statSync(path.resolve(cwd, file)); } catch { return false; }
  if (!stat.isDirectory()) return false;
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const target = fold(path.resolve(cwd, file).replaceAll('\\', '/').replace(/\/+$/, ''));
  if (!target) return false;
  return scopes.some(scope => {
    const normalized = fold(path.resolve(cwd, scope).replaceAll('\\', '/').replace(/\/+$/, ''));
    if (!normalized || normalized.includes('*')) return false;
    return normalized.startsWith(target + '/');
  });
}

// 模型偶尔把"装证据的目录"直接写进 artifacts（R408 实测：preview/ 目录里是 8 张页面图）。
// 目录不是产物，但也不该让整次执行判死：只展开目录内的真实文件，按本任务范围过滤，并留一条事件说明。
const MAX_DIRECTORY_ARTIFACTS = 40;
const DIRECTORY_SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.pytest_cache', '.next', '.cache']);
function directoryArtifactFiles(dir, limit = MAX_DIRECTORY_ARTIFACTS) {
  const out = [];
  const walk = current => {
    if (out.length >= limit) return;
    let entries; try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { if (!DIRECTORY_SKIP.has(entry.name)) walk(full); }
      else if (entry.isFile()) { try { if (fs.lstatSync(full).isFile()) out.push(full); } catch { /* vanished */ } }
    }
  };
  walk(dir);
  return out;
}

// 目录不是产物：展开目录内的真实文件（按本任务范围过滤，acceptAll=客户显式放开范围），
// 一个目录条目不能把整次执行判死（R408 实测：8 张页面图放在 preview/ 目录里，目录被写进 artifacts）。
function expandDirectoryArtifactItems(cwd, items, scopes, { acceptAll = false } = {}) {
  const output = [], notes = [];
  let rootReal; try { rootReal = fs.realpathSync(cwd); } catch { rootReal = path.resolve(cwd); }
  for (const item of (items || [])) {
    const raw = typeof item === 'string' ? item : item?.path;
    if (!raw) { output.push(item); continue; }
    const absolute = path.resolve(cwd, raw);
    let stat, real; try { stat = fs.statSync(absolute); real = fs.realpathSync(absolute); } catch { stat = null; }
    if (!stat?.isDirectory() || !inside(rootReal, real)) { output.push(item); continue; }
    const files = directoryArtifactFiles(real);
    const allowed = acceptAll ? files : files.filter(file => allowedFile(cwd, file, scopes));
    for (const file of allowed) output.push({ path: file, summary: (typeof item === 'object' && item?.summary) || ('目录 ' + raw + ' 中的文件') });
    notes.push({ raw, total: files.length, allowed: allowed.length });
  }
  return { items: output, notes };
}
function directoryExpansionNote(taskId, note) {
  return `${taskId}：产物引用写的是目录 ${note.raw}，已展开为 ${note.allowed} 个文件核验（目录本身不算产物${note.total > note.allowed ? '；' + (note.total - note.allowed) + ' 个文件不在本任务范围，已忽略' : ''}）`;
}

function reference(cwd, value, scopes, restrict = false) {
  const input = typeof value === 'string' ? { path: value, summary: '' } : value;
  if (!input?.path) throw new Error('产出引用缺少完整文件路径');
  const absolute = path.resolve(cwd, input.path);
  let stat = null;
  try { stat = fs.statSync(absolute); } catch { /* 下面统一给可操作报错 */ }
  const insideCwd = inside(cwd, absolute);
  if (!stat || !stat.isFile()) {
    const hint = insideCwd
      ? `这个位置在本次任务的工作目录里，但文件不存在或不是普通文件。`
      : `你给的是工作目录之外的路径。如果客户/方案明确要求交付到这里，请在任务文件范围里写这个绝对路径；否则请把产出写在工作目录内（用相对路径），不要自己复制到未声明的目录。`;
    throw new Error(
      `产出引用不是真实文件：${input.path}\n` +
      `  工作目录：${cwd}\n` +
      `  ${hint}\n` +
      `  写在工作目录内时用相对路径，例如 "src/launcher.cs"、"dist/BEAT.exe"。`,
    );
  }
  try { if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error('symlink'); } catch { throw new Error(`产出引用不能是符号链接：${input.path}`); }
  if (restrict && !allowedFile(cwd, absolute, scopes)) {
    throw new Error(
      `产出超出本任务文件范围：${input.path}\n` +
      `  本任务允许的文件：${(scopes || []).join('、') || '(未限定)'}\n` +
      `  工作目录：${cwd}\n` +
      `  正确写法：写在工作目录内（相对路径），或在方案文件范围里明确声明这个任务目录外的绝对路径；不要自己复制到未声明的目录。`,
    );
  }
  return { path: absolute, summary: String(input.summary || '').slice(0, 1200) };
}

// 规则判断：电脑操作、文件多、依赖多或验收项多的算难，其余算简单。
export function inferDifficulty(task) {
  if ((task.type || 'workspace') !== 'workspace') return 'hard';
  const files = (task.files || []).length, deps = (task.dependsOn || []).length, criteria = (task.acceptance || []).length;
  return files > 3 || deps > 1 || criteria > 4 || (task.files || []).some(file => String(file).includes('*')) ? 'hard' : 'simple';
}

export function prepareQueuedTasks(plan, workers, control = {}) {
  if (!Array.isArray(plan?.tasks) || !plan.tasks.length) throw new Error('执行计划没有小任务');
  const ids = plan.tasks.map((task, index) => String(task.id || 'task-' + (index + 1)));
  if (new Set(ids).size !== ids.length) throw new Error('小任务编号重复');
  // 结构错误统一带错误码：编排层据此给客户人话出口，不再把内部术语直接甩给买家。
  const structureError = (message, structureKind, taskId) => Object.assign(new Error(message), { code: 'PLAN_STRUCTURE', structureKind, taskId });
  return plan.tasks.map((task, index) => {
    const acceptance = task.acceptance?.length ? task.acceptance : plan.acceptance || [];
    if (!acceptance.length) throw structureError('每个小任务必须写清验收标准：' + ids[index], 'acceptance', ids[index]);
    const declaredFiles = normalizeTaskFiles(task.files);
    // 与方案预检同一套推断：产出引用/任务说明里点名的文件就是真实产出，能补就不判死。
    const files = declaredFiles.length || (task.type || 'workspace') === 'desktop' ? declaredFiles : inferTaskFiles(task);
    if ((task.type || 'workspace') !== 'desktop' && !files.length) throw structureError('每个文件任务必须划定文件范围：' + ids[index], 'files', ids[index]);
    const dependsOn = strings(task.dependsOn || task.dependencies);
    if (dependsOn.some(id => !ids.includes(id) || id === ids[index])) throw structureError('任务依赖引用无效：' + ids[index], 'dependencies', ids[index]);
    // 未开启硬限制时队列不设单任务刹车（0 = 不限），消耗仍逐次记账显示。
    const tokenBudget = control.tokenBudgetEnforced !== true ? 0 : Math.max(1, Math.min(Number(task.tokenBudget || control.taskTokenBudget || 12000), Number(control.taskTokenBudget || 12000)));
    // 方案漏写难度时按规则判断，不让模型随手一填决定路由。
    const known = ['easy', 'simple', 'low', 'normal', 'medium', 'hard', 'complex', 'high', 'difficult'];
    const difficulty = known.includes(String(task.difficulty ?? '').toLowerCase()) ? task.difficulty : inferDifficulty({ ...task, dependsOn, acceptance });
    const routing = taskRouting({ ...task, difficulty, tokenBudget }, workers, control);
    // 方案漏写输入/产出时自动补说明，不因此拒绝方案：产出落在本任务文件范围，输入是依赖任务的产出（运行时按引用传入）。
    // 只补提示文字，不当成必须存在的产出引用，避免范围里没生成的文件被误判失败。
    const input = task.input ?? (task.inputRefs?.length ? null : dependsOn.length ? '依赖任务 ' + dependsOn.join('、') + ' 的产出（按引用读取）' : null);
    const output = task.output ?? (task.outputRefs?.length ? null : files.length ? '写入本任务文件范围：' + files.join('、') : null);
    // 区分"方案/客户点名"和"路由算出来的名单"：
    //   显式给了名单（含空数组 = 明确不给任何人）→ 硬限制，升级也不许绕过；
    //   没给 → 路由算出来的，允许升级换强搭档。
    const planPinned = Array.isArray(task.eligibleWorkers);
    return { ...task, id: ids[index], files, ...(files.length && !declaredFiles.length ? { inferredFiles: files } : {}), dependsOn, acceptance, difficulty, input, output, checks: strings(task.checks), eligibleWorkers: typeof control.workerMinTokens === 'function' && !planPinned ? null : routing.eligibleWorkers, planPinned, routingReason: routing.routingReason, routingEvidence: routing,
      maxRetries: Math.min(2, Math.max(0, Number(task.maxRetries ?? control.taskMaxRetries ?? 2))), tokenBudget };
  });
}

function unresolvedAcceptance(task, checks) {
  return task.acceptance.filter(criterion => typeof criterion !== 'object' || !criterion.check || !checks.some(check => check.command === criterion.check && check.ok));
}

function executePrompt(run, task, dependencies, checkpointPath, worker, deliveryScopes = []) {
  const preflightHint = run.newFilePreflight?.pass === true ? `控制器在派发任何文件任务前已统一只读预检全部目标，预检记录=${JSON.stringify(run.newFilePreflight)}。执行时对自己的文件做排他创建，仍禁止覆盖；另一搭档本轮刚创建的文件不是预存冲突，不因它中止本任务。不要重复进行与搭档竞争的“两个文件任一存在就停”全局检查；自己的目标若已被外部创建仍立即停止。\n` : '';
  const checkpointHint = checkpointPath ? `在完成有实质产出的阶段后，将真实检查点写到 ${checkpointPath}，JSON包含 summary、completed、next、artifacts（文件路径和摘要）。短文件任务可只在交付时写一次检查点，不为预检逐步写检查点。若已有检查点，先核对文件和已完成动作，从 next 继续，不重做已完成操作。` : '本次不采集检查点；仍需核对已有文件和真实动作，未知副作用禁止重放。';
  const deliveryHint = preflightHint + (deliveryScopes.length ? '客户要求交付到：' + deliveryScopes.join('、') + '；最终文件可以直接写在那里（属于本任务的交付范围），不要为了避免越界只写任务目录，也不要把已经写好的文件搬走。' : '');
  const toolHint = String(worker).startsWith('dock:') ? `拓展坞通过 BEAT 电脑助手执行，desktop_call 使用 contextId=${run.id}:${worker}:queue，cwd=${run.cwd}，保留人工确认与租约。` : nativeToolPrompt(worker);
  return `执行一个小任务，接口优先。仅修改本任务文件范围；不删除无关文件，不写密钥，不发起新的协作。任务文件范围是相对路径就写任务工作目录内的对应位置（不要用 ..；客户附件在任务目录的 .beat-attachments 下）；如果方案的文件范围明确给了任务目录外的绝对路径（客户要求交付到那个位置），就按那个绝对路径写，不要自行改到别处；输入路径已经明确时直接访问该路径，不全树搜索或读取无关上下文；独立短任务无需重复探测工作目录和工具配置；多个互不依赖的写入或回读要在同一条回复里一次发出多个工具调用（例如一次写完 a.csv、b.csv 再统一回读），同一个文件不要反复来回读，能用一轮做完的不要拆成多轮。${toolHint}\n临时脚本和中间文件只能写在本任务工作目录内（建议放在 .beat-control/${run.id}/${task.id}/ 下并说明用途）；不要写到系统临时目录或任务目录外，工具日志里可归因的越界写入会让整次执行被判失败。\n${deliveryHint}工作目录：${run.cwd}\n任务：${JSON.stringify({ id: task.id, title: task.title, detail: task.detail, input: task.input, inputRefs: task.inputRefs || [], output: task.output, outputRefs: task.outputRefs || [], files: task.files, acceptance: task.acceptance, checks: task.checks, tokenBudget: task.tokenBudget || undefined, issues: task.issues || task.lastIssues || [], ...(checkpointPath ? { checkpoint: task.checkpoint || null } : {}) })}\n依赖产出（只按引用读取需要的文件）：${JSON.stringify(dependencies)}\n${task.advisorSelection ? '顾问在两次验收未通过的真实候选中选中了以下版本。先读取对应只读快照，核对当前文件，再仅在原文件范围修正具体问题；不能恢复未知电脑动作，不能把选中视为验收通过：' + JSON.stringify(task.advisorSelection) + '\n' : ''}${task.repairScope ? '这是局部返工：先读取现有产物和检查点，只修 issues 列出的具体问题；保留已经正确的内容，不重做其他任务、不重新讨论已通过的方案。交付摘要说明改了什么以及重新跑了哪些原有检查。返工范围：' + JSON.stringify(task.repairScope) + '\n' : ''}${checkpointHint}\n完成后只给简短摘要和 JSON：{"summary":"结果摘要","artifacts":[{"path":"真实产出完整路径","summary":"内容摘要"}],"completed":["完成项"],"next":[]}。缺少证据的项目明确未验证。`;
}

/** run.control/config.flow.control expose routing/budgets; all model calls use controlCall. */
export async function runQueuedTasks(orch, run, plan, signal, sessions = {}, options = {}) {
  const flow = orch.flowFor ? orch.flowFor(run) : orch.config?.flow || {};
  const control = { ...flow, ...(flow.control || {}), ...(run.control || {}) };
  // 客户在目标里点名“桌面/文档/下载”时，把真实用户文件夹加入交付范围：
  // 执行者把最终文件写在那里是对的，不能在验收时判成“任务目录外”。
  try {
    const destination = requestedDestination(run.goal);
    const folder = destination ? defaultUserFolders()[destination] : null;
    if (folder) control.deliveryScopes = [folder];
  } catch { /* 文件夹探测失败不影响原流程 */ }
  const nativeOnly = forbidsBeatAssistant(run.goal);
  const workers = strings(orch.participants(run)).filter(worker => (!nativeOnly || !worker.startsWith('dock:')) && (!orch.roster?.state || orch.roster.state(worker).status === 'online'));
  if (nativeOnly) orch.store.event?.(run.id, 'queue', '用户禁用 BEAT 电脑助手：文件执行与独立核验只使用原生搭档工具，拓展坞仍可参与无工具的方案讨论');
  const onlineWorkers = () => workers.filter(worker => !orch.roster?.state || orch.roster.state(worker).status === 'online');
  const remainingTokens = (taskId, budget, includeReservations=true) => {
    if (control.tokenBudgetEnforced !== true) return Infinity;
    const ledger = orch.store.get?.('controlMetrics:' + run.id) || {}, item = ledger.tasks?.[taskId], phase = ledger.phases?.execution;
    const reservations = includeReservations ? Object.values(ledger.reservations || {}) : [];
    const taskReserved = reservations.filter(entry => entry.taskId === taskId).reduce((sum, entry) => sum + (Number(entry.tokens) || 0), 0);
    const phaseReserved = reservations.filter(entry => entry.phase === 'execution').reduce((sum, entry) => sum + (Number(entry.tokens) || 0), 0);
    const taskRemaining = Math.min(Number(budget || control.taskTokenBudget || 12000), Number(item?.budget ?? control.taskTokenBudget ?? 12000)) - Number(item?.usedTokens || 0) - taskReserved;
    // Match ControlBudget.reserve: explicit resume refreshes the effective
    // limit before dispatch. Saved phase usage/reservations still count.
    const phaseRemaining = Number(control.executionTokenBudget ?? phase?.budget ?? 64000) - Number(phase?.usedTokens || 0) - phaseReserved;
    return Math.max(0, Math.min(taskRemaining, phaseRemaining));
  };
  const Queue = orch.TaskQueue || (await import('./task-queue.mjs')).TaskQueue;
  const queue = new Queue({ store: orch.store, runId: run.id, cwd: run.cwd, leaseMs: control.leaseMs || Number(control.taskLeaseSec || 120) * 1000, workers,
    strongAgent: control.strongAgent, maxRetries: Math.min(2, Math.max(0, Number(control.taskMaxRetries ?? 2))), now: Date.now, enforceTokenBudget: control.tokenBudgetEnforced === true,
    canClaim: (worker, task) => taskRouting({ ...task, tokenBudget: remainingTokens(task.id, task.tokenBudget) }, onlineWorkers(), control).eligibleWorkers.includes(worker),
    // 方案点名了 owner 时，先由它接单；只有它不在这批可用搭档里，才允许别人顶上。
    workerAvailable: worker => onlineWorkers().includes(worker),
    isProcessAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } } });
  const tasks = prepareQueuedTasks(plan, workers, control), reports = [];
  for (const task of tasks) if (task.inferredFiles?.length) orch.store.event?.(run.id, 'queue', `${task.id}：方案没写文件范围，已按产出引用/任务说明补上 ${task.inferredFiles.join('、')}`);
  // 环境/权限类失败的结构化记录：除了写进 issues 文案，也在最终 result 里单独列出，买家不用翻日志。
  const environmentIssues = new Map();
  const rememberEnvironment = (taskId, hit) => { if (hit) environmentIssues.set(`${taskId || ''}|${hit.matched}`, { taskId: taskId || null, class: hit.class, matched: hit.matched, raw: hit.raw }); };
  // 排障用：设置 BEAT_QUEUE_TRACE=<文件> 才会写（谁在什么时候领取/为什么领不到）。
  // 这次 R152「任务一直排队没人领」就是靠它定位到 claim 被跨任务文件锁静默挡住的。
  const trace = payload => { try { if (process.env.BEAT_QUEUE_TRACE) fs.appendFileSync(process.env.BEAT_QUEUE_TRACE, JSON.stringify({ at: new Date().toISOString(), runId: run.id, ...payload }) + '\n'); } catch {} };
  trace({ event: 'start', participants: orch.participants(run), workers, prepared: tasks.length });
  for (const task of tasks) if (task.routingReason) orch.store.event?.(run.id, 'queue', `${task.id}：${task.routingReason}`);
  const savedTasks = queue.list();
  if (!savedTasks.length) queue.enqueue(tasks);
  else {
    const normalizedFiles = task => strings(task.files).map(file => path.resolve(run.cwd, file)).map(file => process.platform === 'win32' ? file.toLowerCase() : file).sort();
    if (savedTasks.length !== tasks.length || savedTasks.some(saved => {
      const planned = tasks.find(task => task.id === saved.id);
      return !planned || JSON.stringify(saved.acceptance) !== JSON.stringify(planned.acceptance) || JSON.stringify(saved.checks || []) !== JSON.stringify(planned.checks || [])
        || JSON.stringify(normalizedFiles(saved)) !== JSON.stringify(normalizedFiles(planned)) || JSON.stringify(strings(saved.dependsOn).sort()) !== JSON.stringify(strings(planned.dependsOn).sort());
    })) throw new Error('恢复任务的队列与计划范围、依赖或验收标准不一致，请核对已有产出后继续');
  }
  queue.recover?.();
  const artifactRoot = path.join(run.cwd, '.beat-control', safeId(run.id));
  fs.mkdirSync(artifactRoot, { recursive: true });
  const supportsVisualReview = worker => worker === 'codex' || worker === 'claude' || (Array.isArray(orch.config?.dock) && orch.config.dock.some(dock => 'dock:' + dock.id === worker && dock.vision === true));
  const hashMatches = item => { try { return !!item && typeof item.path === 'string' && fs.existsSync(item.path) && createHash('sha256').update(fs.readFileSync(item.path)).digest('hex') === item.sha256; } catch { return false; } };
  const renderAttachments = evidence => visualAttachments(evidence, artifactRoot);
  const routingPath = path.join(artifactRoot, 'routing-evidence.json'), routingRecords = tasks.map(task => ({ taskId: task.id, ...task.routingEvidence }));
  const metrics = () => ({ ...queue.metrics(), routing: { path: routingPath, measurement: 'estimate', records: routingRecords } });
  const publish = () => {
    fs.writeFileSync(routingPath, JSON.stringify({ measurement: 'estimate', records: routingRecords }, null, 2));
    orch.store.set('taskQueue:' + run.id, queue.list().map(task => ({ ...task, state: stateOf(task), routingReason: tasks.find(planned => planned.id === task.id)?.routingReason || '' })));
    orch.store.set('queueMetrics:' + run.id, metrics());
  };
  publish();
  // 显式恢复（看板「继续执行」）一个失败的并行任务时：把只因预算/路由被停止、从未产出的小任务重新入队，
  // 并按客户当前设置重新分配它的执行预算。这是"失败必须有出口、队列卡住自动继续"的落地：
  // 只处理路由类隔离原因，历史用量留在台账里，阶段总预算与预留仍然封顶，不自动重试未知副作用。
  const resumeFrom = options?.resume?.from ? String(options.resume.from) : null;
  const isRunActive = id => !!(orch.active?.has(id) || orch.queue?.includes(id));
  // 无论是"继续"还是客户重新发起同一个目标，都要先退役旧任务遗留的核验锁/未知副作用锁，
  // 否则同一个文件的旧锁会把新任务永久挡住（R152 实测）。条件在 release 内部严格校验：更新的同目标任务、无活跃租约、旧运行已结束。
  if (typeof queue.releaseTerminalVerificationConflicts === 'function') {
    const released = queue.releaseTerminalVerificationConflicts({ explicitResume: !!resumeFrom, explicitStart: true, isRunActive });
    for (const item of released.released) {
      orch.store.event?.(run.id, 'queue', item.kind === 'unknown-side-effects'
        ? `已核对 ${item.runId} 的执行进程确实已结束；它留下的"副作用未知"隔离锁已退役（旧产出与费用保留），由 ${run.id} 重写并重新核验同一个文件`
        : `已核对 ${item.runId} 的执行已结束、没有未核验副作用；保留旧产物和费用记录，由 ${run.id} 接续同一文件，不再被旧验收阻塞`);
    }
    for (const oldId of new Set(released.released.map(item => item.runId))) {
      const oldQueue = new Queue({ store: orch.store, runId: oldId, cwd: run.cwd, workers });
      orch.store.set('taskQueue:' + oldId, oldQueue.list());
      orch.store.set('queueMetrics:' + oldId, oldQueue.metrics());
    }
    for (const task of queue.list()) if (task.supersededVerification && ['blocked', 'verifying'].includes(stateOf(task))) {
      try { queue.restoreSupersededVerification(task.id, { attempt: task.attempts, isRunActive }); }
      catch (error) { orch.store.event?.(run.id, 'queue', `已有文件正在被新任务接续，保留旧验收等待安全核对：${issueText(error)}`); }
    }
    publish();
  }
  if (resumeFrom && typeof queue.restoreBlockedVerification === 'function') {
    for (const task of queue.list()) {
      if (stateOf(task) !== 'blocked' || task.quarantineReason !== 'retries-exhausted') continue;
      // Historical releases discarded failed verification results. Rebuild only
      // from the current attempt's completed record, never model-authored JSON.
      const history = queue.get(task.id, { withHistory: true }).history || [];
      const completed = history.filter(entry => entry.outcome === 'completed' && Number(entry.attempt) === Number(task.attempts)).at(-1);
      const rejection = history.filter(entry => entry.outcome === 'rejected' && Number(entry.attempt) === Number(task.attempts)).at(-1);
      const report = completed?.detail?.result;
      const commands = strings([...(task.checks || []), ...task.acceptance.filter(item => typeof item === 'object').map(item => item.check)]);
      if (!report || !commands.length || rejection?.worker !== 'beat') continue;
      const rejected = [];
      for (const command of commands) {
        try { registeredCheckFor(run.cwd, command); }
        catch (error) { rejected.push({ command, ok: false, exitCode: null, notDispatched: true, unknownSideEffects: false, output: error.message, ms: 0 }); }
      }
      // A valid command might have actually run and failed previously. Without
      // saved evidence we cannot safely turn that failure into non-execution.
      if (rejected.length !== commands.length || rejected.some(check => !(rejection.issues || []).includes(`${check.command} 失败：${check.output}`))) continue;
      try {
        queue.restoreBlockedVerification(task.id, { attempt: task.attempts, result: { ...report, checks: rejected } });
        orch.store.event?.(run.id, 'queue', `${task.id}：严格检查确认原命令没有执行，已保留产物并恢复验收，不重复派发执行`);
      } catch (error) { orch.store.event?.(run.id, 'queue', `${task.id} 保留隔离，无法证明可安全恢复验收：${issueText(error)}`); }
    }
    publish();
  }
  if (resumeFrom && typeof queue.restoreBlockedSemanticVerification === 'function') {
    for (const task of queue.list()) {
      if (stateOf(task) !== 'blocked' || task.quarantineReason !== 'retries-exhausted') continue;
      try {
        queue.restoreBlockedSemanticVerification(task.id, { attempt: task.attempts });
        orch.store.event?.(run.id, 'queue', `${task.id}：已核对当前产物与上次完成报告一致，继续只核验已有结果；返工次数和失败记录保留`);
      } catch {} // Unknown effects, real failed checks or changed artifacts remain isolated.
    }
    publish();
  }
  if (resumeFrom && typeof queue.restoreBlockedNativeBusy === 'function' && orch.store.db && orch.config?.dataDir) {
    for (const task of queue.list()) {
      if (stateOf(task) !== 'blocked' || task.quarantineReason !== 'retries-exhausted' || task.completed) continue;
      try {
        const steps = orch.store.db.prepare("SELECT id,round,error FROM steps WHERE run_id=? AND role='execute' AND agent='codex' AND state='failed' ORDER BY id").all(run.id);
        const nativeId = steps.map(step => /thread ([a-zA-Z0-9-]+) already has an active writer/.exec(step.error || '')?.[1]).find(Boolean);
        if (!nativeId) continue;
        const trustedLogRoot = path.join(orch.config.dataDir, 'logs');
        const proofs = steps.filter(step => step.round >= 1 && step.round <= task.attempts).map(step => {
          const logFile = path.join(trustedLogRoot, `${run.id}-${step.id}.jsonl`);
          return { attempt: step.round, stepId: step.id, logFile, sha256: createHash('sha256').update(fs.readFileSync(logFile)).digest('hex') };
        });
        queue.restoreBlockedNativeBusy(task.id, { attempt: task.attempts, nativeId, proofs, trustedLogRoot });
        orch.store.event?.(run.id, 'queue', `${task.id}：真实RPC记录确认之前各次都未启动执行，已纠正占用造成的返工计数，继续原会话；原失败日志和费用记录保留`);
      } catch {} // Partial logs or any accepted turn preserve isolation.
    }
    publish();
  }
  if (resumeFrom && typeof queue.requeueBlocked === 'function') {
    const grant = Math.max(0, Math.floor(Number(control.taskTokenBudget || 12000)));
    for (const task of queue.list()) {
      if (stateOf(task) !== 'blocked') continue;
      const quarantineReason = String(task.quarantineReason || '');
      let allowReasons = null;
      // 路由类停止 + 任务预算用尽：产品提示写着“提高预算后继续”，这些都必须能被显式恢复重新排队。
      if (!['token-budget-routing', 'admission-blocked', 'no-eligible-worker', 'token-budget-exhausted'].includes(quarantineReason)) {
        // 越界隔离的复核：如果用 mtime 能证明被判越界的文件全部早于那次尝试，就不可能是它写的
        // （大工作区快照截断会造成这种误判）。证据推不翻就保持隔离，交人工核对。
        // 结构化证据（新版本记录）；老版本只在 issues 文本里留下文件名，用该次尝试的领取时间做参照。
        const legacy = () => {
          const marker = '文件范围外的改动：';
          const text = (task.issues || []).filter(v => typeof v === 'string').join('；');
          const at = text.indexOf(marker);
          if (at < 0) return null;
          const names = [...new Set(text.slice(at + marker.length).split(/[、；;\n]/).map(v => v.trim()).filter(Boolean))];
          if (!names.length) return null;
          const rows = (queue.get?.(task.id, { withHistory: true })?.history || []).filter(h => Number(h.attempt) === Number(task.attempts));
          const started = rows.map(h => Date.parse(h.at)).filter(Number.isFinite);
          if (!started.length) return null;
          return { files: names, attemptStartedAt: Math.min(...started) };
        };
        const evidence = task.scopeEvidence?.files?.length ? task.scopeEvidence : legacy();
        const files = Array.isArray(evidence?.files) ? evidence.files : [];
        const attemptStartedAt = Number(evidence?.attemptStartedAt);
        if (!files.length || !Number.isFinite(attemptStartedAt)) continue;
        // Windows timestamp precision/rounding cannot distinguish a file written
        // within the claim window from an old file. Only clearly older files
        // can disprove this scope finding; desktop inputs are never cleared here.
        if (task.type === 'desktop' || task.type === 'mixed') continue;
        const stale = files.every(file => { try { return fs.statSync(path.resolve(run.cwd, file)).mtimeMs < attemptStartedAt - 2000; } catch { return false; } });
        if (!stale) continue;
        allowReasons = [quarantineReason];
        orch.store.event?.(run.id, 'queue', `${task.id} 上次被判「文件范围外改动」：复核证据显示被判越界的文件都早于那次尝试，属误判，允许恢复；证据保留在任务里`);
      }
      try {
        const granted = control.tokenBudgetEnforced === true ? orch.grantTaskBudget?.(run, task.id, grant, `恢复 ${run.id}（之前：${resumeFrom}）：任务从未产出，按当前客户设置重新分配执行预算`) : null;
        // 任务自身的预算上限也要同步提高：准入用的是 min(任务行预算, 账本预算) - 已用。
        if (granted?.budget) queue.setTaskBudget?.(task.id, granted.budget);
        queue.requeueBlocked(task.id, { reason: 'resume:' + resumeFrom, allowReasons });
        orch.store.event?.(run.id, 'queue', control.tokenBudgetEnforced === true ? `${task.id} 因预算/路由被停止且从未产出：恢复时重新排队，并按当前设置重新分配 ${grant} token 执行预算` : `${task.id} 之前被停止且从未产出：恢复时重新排队（token 只计量不限额）`);
      } catch (error) {
        orch.store.event?.(run.id, 'queue', `${task.id} 未能自动恢复：${issueText(error)}`);
      }
    }
    // 续跑还可能撞上另一种死结：任务"重试用尽但仍留在 queued"，谁都领不走（R171 task-4 实测）。
    // 既然是显式恢复，就把它一起放回可领取状态，别让整轮卡在一个没人能接的任务上。
    if (typeof queue.resetRetries === 'function') {
      for (const task of queue.list()) {
        if (stateOf(task) !== 'queued' || Number(task.retries) < Number(task.maxRetries)) continue;
        try {
          queue.resetRetries(task.id, { worker: 'controller', note: 'resume:' + resumeFrom });
          orch.store.event?.(run.id, 'queue', `${task.id} 重试用尽但仍留在队列里（谁都领不走）：恢复时重置重试计数，重新可领取`);
        } catch (error) {
          orch.store.event?.(run.id, 'queue', `${task.id} 重试计数未能重置：${issueText(error)}`);
        }
      }
    }
    publish();
  }
  const aborted = () => signal?.aborted;
  const mutex = new Map();
  const waitBudget=()=>new Promise(resolve=>{const timer=setTimeout(done,100);function done(){clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();}signal?.addEventListener('abort',done,{once:true});});
  function eligibleReviewers(taskId, budget, avoid = []) {
    const availableTokens = remainingTokens(taskId, budget, false);
    const task = queue.list().find(item => item.id === taskId);
    const available = workers.filter(worker => !avoid.includes(worker) && (!orch.roster?.state || orch.roster.state(worker).status === 'online'));
    const excluded = available.filter(worker => workerMinimumTokens(worker, 'review', control, task) > availableTokens).map(worker => ({ worker, minimumTokens: workerMinimumTokens(worker, 'review', control, task), reason: '核验接口上下文估算超出任务剩余预算', measurement: 'estimate' }));
    if (excluded.length) { routingRecords.push({ taskId, mode: 'review', availableTokens, excluded, measurement: 'estimate' }); publish(); }
    return available.filter(worker => workerMinimumTokens(worker, 'review', control, task) <= availableTokens)
      .sort((a, b) => Number(mutex.has(a)) - Number(mutex.has(b)) || workerMinimumTokens(a, 'review', control, task) - workerMinimumTokens(b, 'review', control, task));
  }
  async function callBy(worker, options, limits) {
    const previous = mutex.get(worker);
    let release; const gate = new Promise(resolve => { release = resolve; });
    const current = previous ? previous.catch(() => {}).then(() => gate) : gate; mutex.set(worker, current);
    if(previous)await previous.catch(() => {});
    try {
      for(;;){
      if (aborted()) { const error = new Error('已取消'); error.cancelled = true; throw error; }
      const mode = options.call === 'write' || options.call === 'desktop' ? 'work' : 'review';
      const task = queue.list().find(item => item.id === limits.taskId);
      if (workerMinimumTokens(worker, mode, control, task) > remainingTokens(limits.taskId, limits.budget)) {
        const ledger=orch.store.get?.('controlMetrics:'+run.id)||{};
        const free=remainingTokens(limits.taskId,limits.budget,false);
        if(Object.values(ledger.reservations||{}).some(r=>r.phase==='execution')&&free>=workerMinimumTokens(worker,mode,control,task)){
          if(mode==='review'){await waitBudget();continue;}
          const error=new Error('其他调用正在使用预留额度，本任务尚未派发，等待额度释放');error.code='CONTROL_BUDGET_BUSY';error.notDispatched=true;throw error;
        }
        const error = new Error('当前接口上下文估算超出任务剩余预算，已停止追加调用并保留现有产出'); error.code = 'CONTROL_BUDGET_EXCEEDED'; throw error;
      }
      try{return await orch.controlCall(run, { ...options, seat: worker, onlyAgent: true, signal: options.signal || signal, sessions }, { phase: 'execution', ...limits });}
      catch(error){if(mode==='review'&&error.code==='CONTROL_BUDGET_BUSY'&&error.notDispatched===true){await waitBudget();continue;}throw error;}
      }
    } finally { release(); if (mutex.get(worker) === current) mutex.delete(worker); }
  }
  const cancel = () => { queue.cancel(); publish(); };
  signal?.addEventListener('abort', cancel, { once: true });
  const allScopes = tasks.flatMap(task => task.files || []);
  // 检查点目录本身也要放行：模型按提示写 .beat-control/<run>/<task>/checkpoint.json 时，
  // 往往会先建目录（file_mkdir），只放行 checkpoint.json 会把预期行为误判成越界改动。
  const artifactScopes=task=>[...(task.files||[]),...(control.deliveryScopes||[]),...(control.checkpoints!==false?[path.join(artifactRoot,safeId(task.id)), path.join(artifactRoot,safeId(task.id),'checkpoint.json')]:[])];
  async function verifyReport(task, report, token) {
    const originalContract = orch.store.get('goalContract:' + run.id);
    const contract = task.acceptance.some(item => item?.goalHash === originalContract?.goalHash) ? originalContract : null;
    const actualExecutor = report.executor || task.executor;
    if (report.nativeToolEvidence && !report.nativeToolEvidence.trace && orch.store.steps?.(run.id).some(step => step.role === 'execute' && step.state === 'done' && step.agent === actualExecutor && JSON.stringify(step.data?.nativeToolEvidence) === JSON.stringify(report.nativeToolEvidence))) {
      // An older report can gain trace metadata only from its exact completed
      // execution receipt; action verification and original records stay intact.
      report.nativeToolEvidence = sealNativeToolTrace(report.nativeToolEvidence);
      if (report.reportPath && inside(artifactRoot, report.reportPath)) fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2));
    }
    const taskScopes = artifactScopes(task);
    const expanded = expandDirectoryArtifactItems(run.cwd, report.artifacts || [], taskScopes, { acceptAll: allowAnyWrite(control) });
    for (const note of expanded.notes) orch.store.event?.(run.id, 'queue', directoryExpansionNote(task.id, note));
    report.artifacts = expanded.items.map(item => reference(run.cwd, item, taskScopes, !allowAnyWrite(control)));
    const partition = partitionExecutionArtifacts(run.cwd, task, report.artifacts, path.join(artifactRoot, safeId(task.id), 'checkpoint.json'));
    report.deliveryArtifacts = partition.artifacts;
    if (partition.internalArtifacts.length) {
      report.internalArtifacts = [...new Map([...(report.internalArtifacts || []), ...partition.internalArtifacts].map(item => [item.path, item])).values()];
      orch.store.event?.(run.id, 'queue', `${task.id}：自己的检查点已保留为内部证据，按原客户交付清单继续核验已有产物`);
    }
    report.artifactHashes = report.artifacts.map(item => ({ path: item.path, sha256: createHash('sha256').update(fs.readFileSync(item.path)).digest('hex') }));
    report.artifactVerifiedAt = new Date().toISOString();
    // 借鉴 OpenHands 的动作-观察流：并行任务也要有逐任务的执行审计（不阻断交付）。
    if (report.nativeToolEvidence || report.desktopEvidence) {
      try {
        const audit = buildExecutionAudit(report.nativeToolEvidence || report.desktopEvidence, { runId: run.id, cwd: run.cwd });
        orch.store.set('executionAudit:' + run.id + ':' + task.id, audit);
        if (audit.highRisk.length) orch.store.event?.(run.id, 'queue', `${task.id} ${formatExecutionAudit(audit)}`);
        const evidenceUnknown = report.nativeToolEvidence?.sideEffects === 'unknown' || report.desktopEvidence?.sideEffects === 'unknown';
        const execution = executionGuardrail({ audit, unknownSideEffects: evidenceUnknown });
        const output = outputGuardrail({ goal: run.goal, audit });
        orch.store.set('guardrails:' + run.id + ':' + task.id, { execution, output });
        if (execution.findings.length || output.findings.length) orch.store.event?.(run.id, 'queue', `${task.id} ${formatGuardrails(execution)}`);
      } catch { /* 审计与护栏是旁路，不影响交付 */ }
    }
    const dependencyRefs = queue.list().filter(other => task.dependsOn.includes(other.id)).map(other => ({ id: other.id, artifacts: other.result?.artifacts || [], summary: other.result?.summary || '' }));
    const commands = strings([...(task.checks || []), ...task.acceptance.filter(item => typeof item === 'object').map(item => item.check)]);
    const checksEnabled = flow.runChecks !== false && control.taskAutoChecks !== false;
    const checkResults = checksEnabled ? await (orch.runChecks || runChecks)(run.cwd, commands, { signal,strict:true }) : [];
    if (aborted()) return;
    report.checks = checkResults;
    if(checkResults.some(check=>check.unknownSideEffects||unknownInput(check.evidence))){report.verdict={pass:false,issues:['验收检查的副作用尚未核验，已隔离任务并保留检查证据']};queue.fail(task.id,token,report.verdict.issues,{unknownSideEffects:true,terminal:true,attempt:task.attempts});publish();reports.push(report);return;}
    const failedChecks = checkResults.filter(check => !check.ok && check.notDispatched !== true);
    const blockedChecks = checkResults.filter(check => !check.ok && check.notDispatched === true);
    const missingChecks = checksEnabled ? commands.filter(command => !checkResults.some(check => check.command === command)) : (originalContract?.requiredChecks || []);
    const commit = (reviewer, verdict) => {
      const changed = report.artifactHashes.some(item => !hashMatches(item)) || (report.htmlRenderEvidence || []).filter(item => item.status === 'rendered').some(item => !hashMatches({ path: item.file, sha256: item.sha256 }) || item.imageHashes?.some(hash => !hashMatches(hash)));
      if (changed) {
        report.verdict = { pass: false, unverified: true, issues: ['产物在验收过程中发生变化，旧核验不能用于新文件；已有产物保留，下一次只重新核验'] };
        queue.holdVerification(task.id, report.verdict.issues, { attempt: task.attempts, result: report }); awaitingChecks.add(task.id);
      } else { report.verdict = verdict; queue.verify(task.id, reviewer, { ...verdict, attempt: task.attempts, result: report }); }
      publish();
    };
    if (blockedChecks.length || missingChecks.length) {
      const described = checkFailureIssues([...failedChecks.map(check => `${check.command} 执行失败：${check.output || check.exitCode}`), ...blockedChecks.map(check => `检查尚未执行，产物已保留：${check.output || check.command}`), ...missingChecks.map(command => `${command} 未验证`)], [...failedChecks, ...blockedChecks]);
      report.verdict = { pass: false, unverified: true, issues: described.issues, ...(described.environment ? { environment: described.environment } : {}) };
      if (described.environment) { rememberEnvironment(task.id, described.environment); orch.store.event?.(run.id, 'queue', `${task.id}：验收检查被环境/权限挡住（真实原因：${described.environment.matched}），不等于执行者失职`); }
      // Refused checks are verification problems. Re-executing a completed
      // deliverable cannot repair an unsupported command or grant permission.
      queue.holdVerification(task.id, report.verdict.issues, { attempt: task.attempts, result: report });
      awaitingChecks.add(task.id); publish();
    } else if (failedChecks.length) {
      const described = checkFailureIssues(failedChecks.map(check => `${check.command} 失败：${check.output || check.exitCode}`), failedChecks, '环境修好后点「继续」会重新执行本任务；已有产物与检查点保留');
      if (described.environment) { rememberEnvironment(task.id, described.environment); orch.store.event?.(run.id, 'queue', `${task.id}：验收检查被环境/权限挡住（真实原因：${described.environment.matched}），不等于执行者失职`); }
      // 全部失败都来自环境/权限限制（沙箱不允许起子进程、工具没装、超时）时，重做交付物不能修好环境：
      // 按"只继续核验、不重做"处理，避免白烧一次返工（R156 的 567,776 token 就是这么烧的）。
      const allEnvironmental = failedChecks.length > 0 && failedChecks.every(check => checkEnvironmentHit(check));
      if (allEnvironmental) {
        report.verdict = { pass: false, unverified: true, issues: described.issues, ...(described.environment ? { environment: described.environment } : {}) };
        queue.holdVerification(task.id, report.verdict.issues, { attempt: task.attempts, result: report });
        awaitingChecks.add(task.id); publish();
      } else commit('beat', { pass: false, issues: described.issues, ...(described.environment ? { environment: described.environment } : {}) });
    } else {
      const remaining = unresolvedAcceptance(task, checkResults);
      if (!remaining.length && commands.length) commit('beat', { pass: true, issues: [], automatic: true });
      else {
        report.htmlRenderEvidence = checksEnabled ? await (orch.renderHtmlEvidence || renderHtmlEvidence)({ cwd: run.cwd, task, artifacts: report.artifacts, evidenceRoot: path.join(artifactRoot, 'verification'), profileRoot: path.join(orch.config?.dataDir || artifactRoot, 'browser-profiles'), signal }) : [];
        if (aborted()) return;
        // 用了哪些证据、缺了哪些证据，必须写进任务时间线。
        // 早先"含脚本的页面被静默排除"没有任何记录，买家只看到"真实检查：[]"，
        // 只能让模型自己手搓浏览器，最后一轮烧掉几十万 token 判失败。
        for (const gap of describeRenderGaps(report.htmlRenderEvidence)) orch.store.event?.(run.id, 'queue', `${task.id}：${gap}`);
        const rendered = (report.htmlRenderEvidence || []).filter(item => item.status === 'rendered');
        if (rendered.length) orch.store.event?.(run.id, 'queue', `${task.id}：BEAT 已用后台浏览器独立渲染 ${rendered.length} 个交付页面并采到 ${rendered.reduce((sum, item) => sum + (item.screenshots?.length || 0), 0)} 张截图作为证据（执行者自述不再覆盖它）`);
        const verificationAttachments = renderAttachments(report.htmlRenderEvidence);
        report.verificationImages = verificationAttachments.map(({ path, sha256 }) => ({ path, sha256 }));
        // "明确不属于可视化交付物"的跳过不是缺证据：打印页/普通网页按源码和结构交给独立核验，
        // 不能因为页面没有内联 <svg> 就永久挂起（R408：A4 打印页卡在验收中，PDF 任务永远等不到依赖）。
        // 只有"本该渲染却没渲染出来"（没浏览器、启动失败、渲染未完成）或图片类交付缺图时才继续挂起。
        const renderGaps = (report.htmlRenderEvidence || []).filter(item => item.status !== 'rendered');
        const retryableGaps = renderGaps.filter(item => ['browser-missing', 'launch-failed', 'unverified'].includes(item.status));
        const rasterMissing = report.artifacts.some(item => /\.(svg|png|jpe?g|webp|gif|bmp)$/i.test(item.path)) && !verificationAttachments.length;
        if (retryableGaps.length || rasterMissing) {
          const gapText = describeRenderGaps(retryableGaps.length ? retryableGaps : renderGaps).join('；') || '没有生成与当前文件哈希匹配的核验图片';
          report.verdict = { pass: false, unverified: true, issues: ['核验图片尚未准备完整：' + gapText + '；已有成果保留，继续时重新准备图片，不重画成果'] };
          queue.holdVerification(task.id, report.verdict.issues, { attempt: task.attempts, result: report });
          awaitingChecks.add(task.id); publish(); reports.push(report); return;
        }
        const needsVisualReview = verificationAttachments.length > 0;
        const eligible = control.taskModelReview === false ? [] : eligibleReviewers(task.id, task.tokenBudget, [actualExecutor]);
        // 优先找能看图的核验人；确实没有支持看图的搭档时，退而用不看图的搭档核验非视觉项，
        // 而不是让整项验收直接失败（R363 实测：唯一能看图的顾问欠费、两个看图扩展坞掉线，
        // 剩下在线的 DeepSeek 不看图，11 条验收被一次全灭）。
        let reviewer = needsVisualReview ? eligible.find(supportsVisualReview) : eligible[0];
        let blindToVisuals = false;
        // 除执行者外没有在线搭档时，请顾问（Claude）只读核验；它不能读盘，产出内容直接附上。
        const nobodyElse = !workers.some(worker => worker !== actualExecutor && (!orch.roster?.state || orch.roster.state(worker).status === 'online'));
        const advisorReview = !reviewer && control.taskModelReview !== false && (nobodyElse || needsVisualReview) && actualExecutor !== 'claude' && orch.roster?.state?.('claude')?.status === 'online';
        if (advisorReview) reviewer = 'claude';
        // 能看图的顾问也请不到时，才退而用不看图的搭档核验非视觉项（别为了没人看图就让整项验收失败）。
        if (!reviewer && needsVisualReview && eligible.length) { reviewer = eligible[0]; blindToVisuals = true; }
        if (!reviewer && control.taskModelReview !== false && nobodyElse) {
          // 产出保留在“验收中”，客户点「继续」时只做核验，不重做任务。
          awaitingReviewer.add(task.id);
          report.verdict = { pass: false, unverified: true, issues: ['只有一位搭档在线，顾问也暂时连不上，没人能独立核验这项结果。产出已保留；恢复另一位搭档或顾问后点「继续」，只核验不重做'] };
          queue.holdVerification(task.id, report.verdict.issues, { attempt: task.attempts, result: report });
          orch.store.event?.(run.id, 'queue', `${task.id}：${report.verdict.issues[0]}`); publish();
        } else if (!reviewer) {
          if (control.taskModelReview === false) {
            report.verdict = { pass: false, issues: ['模型核验已关闭，剩余验收标准未验证'] };
            queue.fail(task.id, token, report.verdict.issues, { terminal: true, attempt: task.attempts }); publish();
          } else {
            // 核验人暂时缺席（欠费、掉线、不看图）不是产出有问题：按“持产等待”处理，
            // 恢复搭档后点「继续」只核验不重做，不要把它判死（R363 实测：产出哈希一致却整任务报废）。
            awaitingReviewer.add(task.id);
            report.verdict = { pass: false, unverified: true, issues: ['暂时没有能独立核验这项结果的在线搭档（欠费、掉线或不支持看图）；产出已保留，恢复搭档后点「继续」只核验、不重做'] };
            queue.holdVerification(task.id, report.verdict.issues, { attempt: task.attempts, result: report });
            orch.store.event?.(run.id, 'queue', `${task.id}：${report.verdict.issues[0]}`); publish();
          }
        } else {
          // 核验搭档这次返回的流/JSON 坏了，或根本没答上来（空答/卡住/上游错误）：
          // 先让同一位重发一次；仍不行就换另一位在线核验人；再不行挂起核验（产出保留），绝不重跑执行。
          // R379 实测：wawa-Claude 空答/卡住三次，旧逻辑每次都把执行重做一遍，烧了 76 万 token 仍判失败。
          const callReview = async () => {
            const tried = new Set();
            let attemptsOnCurrent = 0;
            for (;;) {
              tried.add(reviewer);
              try { return await callBy(reviewer, { role: 'evaluate', slot: `${reviewer}:queue-review`, call: 'think', avoid: [actualExecutor], verificationAttachments: blindToVisuals ? [] : verificationAttachments,
              build: () => `只读核验一个小任务，不能修改文件，不要重新设计方案，不读取其他模型完整聊天。读取产出引用，严格对照未被代码覆盖的验收标准。仅返回 JSON {"pass":true或false,"issues":["具体问题"]}；未验证不能通过。${blindToVisuals ? '本次核验不支持看图：截图和视觉相关的验收（外观、部件对齐、观感）你无法判断，不要对它们下结论，也不要因为它们判失败；只核验结构、命名契约、依赖与文本可判定的标准。' : ''}${goalReviewInstructions(contract, { cannotReadFiles: reviewer === 'claude' })}\n任务：${task.title}\n验收：${JSON.stringify(remaining)}\n产出引用：${JSON.stringify({ summary: report.summary, artifacts: report.artifacts, reportPath: report.reportPath })}\n输入和依赖引用：${JSON.stringify({ inputRefs: task.inputRefs || [], dependencies: dependencyRefs, invalidatedDependencies: task.invalidatedDependencies || [] })}\n真实检查：${describeChecks(checkResults)}\n后台真实浏览器渲染（含当前文件哈希，附图供你独立判断部件对齐；执行者此前未验证不覆盖控制器的新证据）：${JSON.stringify(compactEvidence(report.htmlRenderEvidence))}\n执行前文件状态（控制器在本次尝试执行前读取；createdDuringTask 以任务创建时间为准）：${JSON.stringify(compactEvidence(report.fileBaseline))}\n文件基线判定规则：createdDuringTask=true 表示该文件是本任务此前尝试创建的产物，本次重试允许覆盖/重建并修复，不算“覆盖任务开始前已有的文件”；只有 createdDuringTask=false 才按“未覆盖已有文件”判失败。控制器在 .beat-control 下的检查点/报告/日志是产品自身写入，不算执行者修改其他文件，不要据此判失败。\n原生工具实际回执（已剔除控制器 .beat-control 自身写入；图片/超长输出已省略，完整回执在产出报告文件）：${JSON.stringify(compactEvidence(report.nativeToolEvidenceReview || report.nativeToolEvidence))}\n电脑证据：${JSON.stringify(compactEvidence(report.desktopEvidence))}${advisorReview ? '\n你无法读盘，产出文件内容如下：' + inlineArtifacts(report.artifacts) : ''}` }, { taskId: task.id, maxOutputTokens: reviewOutputCap(reviewer, (report.deliveryArtifacts || task.outputRefs || []).length), budget: task.tokenBudget }); }
              catch (error) {
                if (error?.cancelled || error?.unknownSideEffects) throw error;
                if (/^IMAGE_INPUT_/.test(error.code || '')) return { unavailable: true, issues: [error.message] };
                const message = String(error?.message || '');
                const unavailable = REVIEWER_UNAVAILABLE.test(message);
                const retryable = PARSE_ERROR.test(message) || unavailable;
                if (!retryable) throw error;
                attemptsOnCurrent++;
                if (attemptsOnCurrent < 2) {
                  orch.store.event?.(run.id, 'queue', `${task.id}：核验搭档这次没有返回有效答复（${unavailable ? '空答/卡住' : '格式不对'}），已让同一位重发一次（产出不动）`);
                  continue;
                }
                if (unavailable) {
                  const alternative = eligible.find(worker => !tried.has(worker) && worker !== actualExecutor && (!needsVisualReview || supportsVisualReview(worker)));
                  if (alternative) {
                    reviewer = alternative; attemptsOnCurrent = 0;
                    orch.store.event?.(run.id, 'queue', `${task.id}：上一位核验搭档没有返回有效答复，已换另一位在线搭档核验（产出不动）`);
                    continue;
                  }
                  return { unavailable: true, issues: [`核验搭档 ${reviewer} 暂时没有返回有效答复，产出已保留；恢复在线后点「继续」只核验、不重做`] };
                }
                throw error;
              }
            }
          };
          const review = await callReview();
          if (review?.unavailable) {
            report.verdict = { pass: false, unverified: true, issues: review.issues };
            queue.holdVerification(task.id, review.issues, { attempt: task.attempts, result: report });
            awaitingReviewer.add(task.id);
            orch.store.event?.(run.id, 'queue', `${task.id}：${review.issues[0]}`);
            publish(); reports.push(report); return;
          }
          const verdict = lastJson(review.text);
          report.imageDelivery = review.modelUsage?.records?.filter(record => record.imageInputs?.length).map(record => ({ status: record.imageInputStatus, images: record.imageInputs })) || [];
          report.reviewer = review.by || reviewer;
          queue.recordUsage?.(task.id, null, usageOf(review));
          if (needsVisualReview && imageReadFailure(verdict)) {
            report.verdict = { pass: false, unverified: true, issues: ['本次核验搭档未能读取图片：BEAT 已准备图片附件，但模型报告无法查看，接口是否正确处理图片尚未确认；不能判为缺少看图搭档，也不能当作画面不合格。已有成果保留，继续时只重试核验。'] };
            queue.holdVerification(task.id, report.verdict.issues, { attempt: task.attempts, result: report });
            awaitingChecks.add(task.id); publish(); reports.push(report); return;
          }
          const finalVerdict = { pass: report.reviewer !== actualExecutor && verdict?.pass === true && Array.isArray(verdict.issues) && verdict.issues.length === 0,
            issues: Array.isArray(verdict?.issues) && (verdict.issues.length || verdict?.pass === true) ? verdict.issues : ['核验没有返回有效 pass/fail 及问题数组'] };
          if (blindToVisuals && finalVerdict.pass) {
            // 不看图的核验人无法证明视觉项：既不能算通过，也不该按失败去返工（返工会白烧一轮）。
            // 保留产出，等一个能看图的搭档回来只核验、不重做（R363 实测）。
            report.verdict = { pass: false, unverified: true, issues: ['视觉相关验收未验证：本次核验搭档不支持看图，产出已保留；有能看图的搭档后点「继续」只核验、不重做'] };
            queue.holdVerification(task.id, report.verdict.issues, { attempt: task.attempts, result: report });
            awaitingReviewer.add(task.id); publish(); reports.push(report); return;
          }
          if (contract) {
            // 核验顾问漏读某个交付文件时补问一次：只补 readbacks、不重新评价（R366 实测）。
            let goalVerdict = verdict;
            if (reviewer === 'claude' && (report.deliveryArtifacts || []).length) {
              const completed = await fillMissingReadbacks({ artifacts: report.deliveryArtifacts, verdict: goalVerdict, ask: async missing => {
                const response = await callBy(reviewer, { role: 'evaluate', slot: reviewer + ':queue-goal-readback', call: 'think',
                  build: () => '你上次的读回漏了这些交付文件：' + JSON.stringify(missing) + '。只补 readbacks：对每个文件返回 {"path":"完整路径","sha256":"controller","quote":"从附上的当前内容逐字摘取至少8字符的片段"}；不要重新评价、不要改 pass/issues、不要输出其他字段。\n产出内容（你无法读盘，控制器附上）：' + inlineArtifacts(missing.map(file => ({ path: file }))) },
                  { taskId: task.id, maxOutputTokens: 1600, budget: task.tokenBudget });
                queue.recordUsage?.(task.id, null, usageOf(response));
                return response.text || '';
              } });
              if (completed.filled.length) {
                goalVerdict = completed.verdict;
                orch.store.event?.(run.id, 'queue', task.id + '：核验顾问漏读了 ' + completed.filled.length + ' 个交付文件，已补读回（不重新评价）');
              }
            }
            const goalReview = verifyGoalReadback(goalVerdict, report.deliveryArtifacts, contract, { evidence: report.nativeToolEvidence || report.desktopEvidence, controllerHashed: reviewer === 'claude' });
            orch.store.set('deliveryVerification:' + run.id, { ...goalReview, reviewer: report.reviewer, at: new Date().toISOString() });
            if (!goalReview.pass && (!goalReview.evidenceComplete || verdict?.pass === true || Object.values(verdict?.goalChecks || {}).includes('unverified'))) {
              report.verdict = { pass: false, unverified: true, issues: goalReview.issues };
              queue.holdVerification(task.id, goalReview.issues, { attempt: task.attempts, result: report });
              awaitingReviewer.add(task.id); publish(); reports.push(report); return;
            }
            if (!goalReview.pass) { finalVerdict.pass = false; finalVerdict.issues.push(...goalReview.issues); }
          }
          let waiting = false;
          if (verdict?.pass === false && report.reviewer !== actualExecutor && Array.isArray(verdict.issues) && verdict.issues.length) {
            captureExecutionCandidate({ store: orch.store, run, task, report, artifactRoot, verification: { kind: 'semantic', pass: false, reviewer: report.reviewer, issues: verdict.issues } });
            const choice = await selectBestExecutionCandidate(orch, run, task, { signal, sessions, call: callBy, retry: !!resumeFrom });
            if (choice.response) queue.recordUsage?.(task.id, null, usageOf(choice.response));
            if (choice.status === 'selected') report.advisorSelection = choice.selection;
            if (choice.status === 'waiting') {
              report.verdict = { pass: false, unverified: true, issues: choice.issues };
              queue.holdVerification(task.id, report.verdict.issues, { attempt: task.attempts, result: report }); awaitingChecks.add(task.id); publish(); waiting = true;
            }
          }
          if (!waiting) commit(report.reviewer, finalVerdict);
        }
      }
    }
    if (report.reportPath && inside(artifactRoot, path.resolve(report.reportPath))) fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2));
    reports.push(report);
  }
  const budgetDeferred=new Map(), nativeBusyDeferred=new Map(), awaitingReviewer=new Set(), awaitingChecks=new Set();
  const budgetSignature=()=>JSON.stringify(orch.store.get?.('controlMetrics:'+run.id)||{});
  async function perform(worker, task) {
    task.advisorSelection = orch.store.get?.(`executionCandidates:${run.id}:${task.id}`)?.selection || null;
    const token = task.leaseToken, directory = path.join(artifactRoot, safeId(task.id)); fs.mkdirSync(directory, { recursive: true });
    const checkpointPath = path.join(directory, 'checkpoint.json'), reportPath = path.join(directory, `report-${Number(task.attempts || task.attempt || 1)}.json`);
    const dependencies = queue.list().filter(other => task.dependsOn.includes(other.id)).map(other => {
      const result = other.result || other.report || {};
      return { id: other.id, summary: result.summary || '', artifacts: result.artifacts || [], reportPath: result.reportPath || null };
    });
    let logFile, observedLogSize = 0, observedCheckpointTime = 0, lastProgressAt = Date.now(), longestQuiet = 0, stalled = false;
    // 看门狗：控制器自己续租不算进展；长时间没有任何真实输出就停止本次尝试，带问题重新排队，不让任务永远挂着。
    // 多久算卡住由 BEAT 按搭档、推理强度和历史表现自己判断（stall.mjs），客户不用设置。
    const stallMs = quietLimitMs(orch.store, worker, run.efforts?.[worker], control.stallOverrideMinutes);
    const attempt = new AbortController(), attemptSignal = signal ? AbortSignal.any([signal, attempt.signal]) : attempt.signal;
    const progressed = () => { const now = Date.now(); longestQuiet = Math.max(longestQuiet, now - lastProgressAt); lastProgressAt = now; };
    const observe = () => {
      if (aborted()) return;
      if (!stalled && Date.now() - lastProgressAt > stallMs) { stalled = true; attempt.abort(new Error('stalled')); return; }
      try {
        if (logFile && fs.existsSync(logFile)) {
          const size = fs.statSync(logFile).size;
          if (size > observedLogSize) { observedLogSize = size; progressed(); queue.heartbeat(task.id, token); publish(); }
        }
        if (control.checkpoints !== false && fs.existsSync(checkpointPath)) {
          const time = fs.statSync(checkpointPath).mtimeMs;
          if (time > observedCheckpointTime) {
            const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
            checkpoint.artifacts = (checkpoint.artifacts || []).map(item => reference(run.cwd, item, artifactScopes(task), true));
            // Model-authored progress is data, never authority to clear unknown
            // desktop side effects, change process ownership or reclaim a lease.
            observedCheckpointTime = time; progressed(); queue.checkpoint(task.id, token, { summary: checkpoint.summary, filesDone: checkpoint.filesDone || checkpoint.completed || [], next: checkpoint.next, artifacts: checkpoint.artifacts, path: checkpointPath }); queue.heartbeat(task.id, token); publish();
          }
        }
      } catch (error) { orch.store.event?.(run.id, 'queue', `检查点未采用：${issueText(error)}`); }
    };
    const leaseMs = Number(queue.leaseMs) || Number(control.leaseMs) || Number(control.taskLeaseSec || 120) * 1000;
    let ownershipStopped = false;
    const keepOwnership = () => {
      if (ownershipStopped || aborted() || !queue.get) return;
      const held = queue.get(task.id), lease = held.lease;
      if (stateOf(held) !== 'running' || lease?.pid !== process.pid) return;
      // 电脑睡眠或卡顿让自己的租约过期：令牌未被轮换就续上，不让做了一半的活被当成无主任务。
      if (lease?.expired || lease?.stale) { if (queue.renewOwnLease?.(task.id, token)) publish(); return; }
      if (lease.expiresAt - Date.now() > leaseMs / 2) return;
      // The controller is still awaiting this exact execution attempt. This
      // is ownership renewal, not model progress or a fabricated checkpoint.
      queue.heartbeat(task.id, token); publish();
    };
    const monitor = setInterval(() => { try { keepOwnership(); } catch (error) { ownershipStopped = true; orch.store.event?.(run.id, 'queue', `执行租约未续期：${issueText(error)}`); } observe(); }, Math.max(10, Math.min(Number(control.progressPollMs) || 2500, leaseMs / 3))); monitor.unref?.();
    const attemptStartedAt = Date.now();
    const before = snapshot(run.cwd);
    // R470 实测：fileBaseline 原来按“每次尝试”取快照，重试时第一次尝试创建的文件
    // 变成 existedBefore=true，“新建且未覆盖”就永远无法满足。createdDuringTask 用
    // 任务创建时间区分“任务开始前就有”与“本任务此前尝试创建”，重试据此允许修复。
    const taskCreatedAt = Date.parse(task.createdAt || task.created_at || '');
    const fileBaseline = (task.files || []).filter(file => !String(file).includes('*')).map(file => {
      const full = path.resolve(run.cwd, file);
      const createdDuringTask = stat => Number.isFinite(taskCreatedAt) && stat.mtimeMs >= taskCreatedAt - 2000;
      try { const stat = fs.statSync(full); return { path: full, existedBefore: true, size: stat.size, mtimeMs: stat.mtimeMs, createdDuringTask: createdDuringTask(stat) }; }
      catch (error) { return { path: full, existedBefore: error.code === 'ENOENT' ? false : null, createdDuringTask: false, ...(error.code !== 'ENOENT' ? { error: error.code } : {}) }; }
    });
    try {
      task.inputRefs = (task.inputRefs || []).map(item => reference(run.cwd, item, [], false));
      // 执行者沙箱档位：默认 workspace-write（沙箱禁止起子进程，装不了依赖、跑不了测试）。
      // 客户要求"环境问题就放开权限，别让模型干不了活"：flow.executorAccess='danger-full-access' 时
      // 执行者会话按完全访问建立，它自己的工具就能装依赖、跑命令。这是一次显式的权限放宽，
      // 事件里留痕可审计；默认不变，由客户自己在设置里开。
      const executorAccess = control.executorAccess === 'danger-full-access' ? 'danger-full-access' : undefined;
      if (executorAccess) orch.store.event?.(run.id, 'queue', `${task.id}：执行者按「完全访问」建立会话（可装依赖、可跑命令）；这是客户显式放开的环境权限`);
      const result = await callBy(worker, { role: 'execute', slot: `${worker}:queue`, round: Number(task.attempts || 1), call: task.type === 'desktop' || task.type === 'mixed' ? 'desktop' : 'write',
        nativeAccess: executorAccess,
        executionKey: executionAttemptKey(run.id, task),
        signal: attemptSignal,
        onStart: (_id, file) => { logFile = file; }, onProgress: progress => { if (progress?.event || progress?.tool || progress?.toolCall || progress?.completedActions || progress?.calls?.length || progress?.logBytes) { progressed(); queue.heartbeat(task.id, token, progress?.pid ? { executorPid: progress.pid } : undefined); publish(); } },
        build: actualWorker => executePrompt(run, task, dependencies, control.checkpoints === false ? null : checkpointPath, actualWorker, control.deliveryScopes || []) }, { taskId: task.id, maxOutputTokens: Math.min(1600, task.tokenBudget || 1600), budget: task.tokenBudget });
      clearInterval(monitor); observe();
      if (aborted()) return;
      const actualExecutor = result.by || worker;
      rememberQuietGap(orch.store, actualExecutor, Math.max(longestQuiet, Date.now() - lastProgressAt));
      queue.renewOwnLease?.(task.id, token);
      queue.recordUsage?.(task.id, token, usageOf(result));
      if (actualExecutor !== worker) throw new Error('执行者与显式任务路由不符，已停止自动换人');
      if (unknownInput(result.desktopEvidence || result)) { const error = new Error('电脑输入结果尚未核验，已隔离此任务'); error.unknownSideEffects = true; throw error; }
      const parsed = lastJson(result.text) || {};
      const changes = diffSnapshots(before, snapshot(run.cwd));
      const auditId=result.desktopTaskId||result.desktopEvidence?.taskId;
      const auditFiles=typeof auditId==='string'&&/^[\w-]+$/.test(auditId)?['.json','.json.tmp'].map(ext=>path.resolve(orch.config?.workspace||run.cwd,'desktop-assistant','data',auditId+ext).toLowerCase()):[];
      // 只认本次尝试真正写过的文件：快照有上限，大工作区里截断点不同会把老文件当成"新增"。
      // mtime 早于本次尝试开始的 added/modified 不可能是这次写的；被截断时连删除也不能证明。
      const touchedThisAttempt = file => { try { return fs.statSync(path.resolve(run.cwd, file)).mtimeMs >= attemptStartedAt - 2000; } catch { return false; } };
      const diffChanged = [...changes.added, ...changes.modified].filter(touchedThisAttempt).concat(changes.truncated ? [] : changes.deleted);
      const changed = diffChanged.filter(file => !file.replaceAll('\\', '/').startsWith('.beat-control/')&&!auditFiles.includes(path.resolve(run.cwd,file).toLowerCase()));
      const attributable=result.scopeWriteEvidence?.source==='native-tool-log'&&result.scopeWriteEvidence.complete===true;
      const helperWrites=(result.desktopEvidence?.calls||result.calls||[]).filter(c=>['file_write','file_edit','file_delete','file_mkdir','file_copy','file_move'].includes(c.tool)).flatMap(c=>c.tool==='file_copy'?[c.args?.to]:c.tool==='file_move'?[c.args?.path,c.args?.to]:[c.args?.path]).filter(p=>typeof p==='string');
      // 执行者自己交付报告里点名的产物属于它自己的写入：即使方案范围漏登记，
      // 也只能算“范围外写入”（可审计、可继续），不能算“来源不明”（未知副作用会锁死任务，R499 实测）。
      // 只把“真实存在于本任务目录内、且不属于 BEAT 控制目录”的报告产物当成可归因写入；
      // 伪造路径或别的任务的 .beat-control 检查点仍走原来的验收/授权校验，不能被当成执行者证据。
      const reportedWrites=reportedExecutionPaths(parsed).filter(file=>{
        const text=String(file||'');
        if(/(^|[\\/])\.beat-control([\\/]|$)/i.test(text))return false;
        try{const full=path.resolve(run.cwd,text);return inside(run.cwd,full)&&fs.existsSync(full);}catch{return false;}
      });
      const observedWrites=[...(result.scopeWriteEvidence?.paths||[]),...helperWrites,...reportedWrites];
      const foldPath=file=>path.resolve(run.cwd,file).toLowerCase();
      // BEAT 自己的控制目录（.beat-control/<run>/<task>/...）不是业务文件：
      // 拓展坞/原生工具写检查点时可能只报告父目录，不能当成“执行者写到范围外”。
      const isControlPath=file=>{const normalized=String(file||'').replaceAll('\\','/').replace(/^\.\//,'');return normalized==='.beat-control'||normalized.startsWith('.beat-control/')};
      const observedWritesForScope=observedWrites.filter(file=>!isControlPath(file));
      const observedSet=new Set(observedWritesForScope.map(foldPath));
      // 分级：能归因到执行者工具日志的越界写入，才可以说"执行者写到了任务文件范围外"。
      // 客户明确要求"权限与文件范围这类限制统统解除"：allowAnyWrite（默认开）时不再把范围外写入当失败，
      // 只在时间线里记一条"范围外写入"供审计；关掉这个开关才回到原来的严格强制。
      const strictScope = !allowAnyWrite(control);
      // 同一方案里其他小任务声明的文件属于本队列范围：依赖链上后面的任务在同一条原生会话里
      // 重读/重写前面的产物，不能算“写到本任务文件范围外”（R514 实测：check.py、hello.txt 被算到 result.txt 任务头上）。
      const dependsOn= (from,target)=>{const stack=[from],seen=new Set();while(stack.length){const id=stack.pop();if(id===target)return true;if(seen.has(id))continue;seen.add(id);const node=tasks.find(item=>item.id===id);stack.push(...(node?.dependsOn||[]));}return false;};
      const declaredByConcurrentSibling=file=>tasks.some(other=>other.id!==task.id&&!dependsOn(other.id,task.id)&&(other.files||[]).some(scope=>allowedFile(run.cwd,file,[scope])));
      const observedOutsideScope=[...new Set(observedWritesForScope.filter(file=>!allowedFile(run.cwd,file,artifactScopes(task))&&!allowedAncestorDir(run.cwd,file,artifactScopes(task))&&!declaredByConcurrentSibling(file)))];
      // 归因不完整时窗口内 cwd 的其他变更来源不明（买家自己的轮询日志、编辑器、其他程序都可能）：
      // 单独归入 unattributed，绝不和执行者越界并列成一条纪律问题。
      // 并行任务同时写各自声明的文件时，另一个任务的文件也会出现在本任务窗口里；
      // 它属于 allScopes（本队列里有人声明过），不能当成来源不明的越界改动，否则每个并行任务都会互相撞死。
      const unattributedOutsideScope=attributable?[]:changed.filter(file=>!isControlPath(file)&&!allowedFile(run.cwd,file,artifactScopes(task))&&!declaredByConcurrentSibling(file)&&!observedSet.has(foldPath(file)));
      if (strictScope && (observedOutsideScope.length||unattributedOutsideScope.length)) {
        const error=new Error(scopeFailureText(actualExecutor,observedOutsideScope,unattributedOutsideScope));
        error.scopeGrading=true;
        error.outOfScope={observed:observedOutsideScope,unattributed:unattributedOutsideScope};
        error.scopeAttribution={attributable,source:result.scopeWriteEvidence?.source||null,complete:result.scopeWriteEvidence?.complete===true};
        // 留下机器可复核的证据：被判越界的文件 + 本次尝试开始时间；恢复时只有证据被推翻才重新排队。
        try { queue.recordScopeEvidence?.(task.id, token, { files: [...observedOutsideScope,...unattributedOutsideScope], attemptStartedAt, attributed: attributable }); } catch { /* 证据写入失败不影响隔离 */ }
        // Incomplete tool attribution cannot prove who changed another task's
        // files, nor that replaying the interrupted actions would be harmless.
        if(unattributedOutsideScope.length)error.unknownSideEffects=true;
        throw error;
      }
      if (!strictScope && (observedOutsideScope.length || unattributedOutsideScope.length)) {
        orch.store.event?.(run.id, 'queue', `${task.id}：范围内未声明的写入 ${observedOutsideScope.length + unattributedOutsideScope.length} 个（已按客户设置放行，仅留痕）：${[...observedOutsideScope, ...unattributedOutsideScope].slice(0, 6).join('、')}`);
      }
      const ownedChanges = changed.filter(file => allowAnyWrite(control) || allowedFile(run.cwd, file, task.files || []));
      const strictArtifacts = !allowAnyWrite(control);
      const parsedItems = parsed.artifacts || ownedChanges.filter(file => fs.existsSync(path.resolve(run.cwd, file))).map(file => ({ path: file, summary: '本任务修改文件' }));
      const expandedParsed = expandDirectoryArtifactItems(run.cwd, parsedItems, artifactScopes(task), { acceptAll: !strictArtifacts });
      for (const note of expandedParsed.notes) orch.store.event?.(run.id, 'queue', directoryExpansionNote(task.id, note));
      const allArtifacts = expandedParsed.items.map(item => reference(run.cwd, item, artifactScopes(task), strictArtifacts));
      const artifacts = allArtifacts;
      const { internalArtifacts } = partitionExecutionArtifacts(run.cwd, task, allArtifacts, checkpointPath);
      for (const item of task.outputRefs || []) {
        const output = reference(run.cwd, item, task.files || [], strictArtifacts);
        const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
        if (!artifacts.some(artifact => samePath(artifact.path,output.path))) artifacts.push(output);
      }
      if ((task.type || 'workspace') !== 'desktop' && !artifacts.length) throw new Error('执行没有提供可核验的文件产出');
      const report = { taskId: task.id, executor: actualExecutor, summary: String(parsed.summary || '执行产物已落盘，按引用核验').slice(0, 1500), artifacts, internalArtifacts, changes: ownedChanges,
        fileBaseline, nativeToolEvidence: result.nativeToolEvidence || null,
        nativeToolEvidenceReview: stripControlEvidence(result.nativeToolEvidence || null),
        desktopEvidence: result.desktopEvidence || null, scopeWriteEvidence:result.scopeWriteEvidence||null,concurrentUnattributedChanges:attributable?changed.filter(file=>!allowedFile(run.cwd,file,allScopes)&&!observedWrites.some(p=>path.resolve(run.cwd,p).toLowerCase()===path.resolve(run.cwd,file).toLowerCase())):[],reportPath };
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); queue.renewOwnLease?.(task.id, token); queue.complete(task.id, token, report); publish();
      await verifyReport(task, report, token);
    } catch (caught) {
      clearInterval(monitor);
      let error = caught;
      if (stalled && !aborted()) {
        error = Object.assign(new Error(`${worker} 连续 ${Math.round(stallMs / 60000)} 分钟没有任何进展，已停止这次尝试并重新排队；已写入的文件和检查点保留，下次从检查点继续`),
          { usage: caught?.usage, desktopEvidence: caught?.desktopEvidence, unknownSideEffects: task.type === 'desktop' || task.type === 'mixed' || caught?.unknownSideEffects });
      }
      // Unknown input is an invariant, not a configurable retry policy.
      // Keep the evidence and block even for old tasks whose snapshot disabled quarantine.
      if (!aborted()) {
        if (error.code === 'NATIVE_SESSION_BUSY' && error.notDispatched === true && error.nativeBusyEvidence && !error.desktopEvidence && !error.unknownSideEffects && typeof queue.deferNativeBusy === 'function') {
          try {
            if (error.usage) queue.recordUsage?.(task.id, token, usageOf({ usage: error.usage }));
            queue.deferNativeBusy(task.id, token, { notDispatched: true, nativeBusyEvidence: error.nativeBusyEvidence });
            nativeBusyDeferred.set(task.id, { worker, nextAt: Date.now() + Math.max(10, Number(control.nativeBusyRetryMs) || 60000) });
            orch.store.event?.(run.id, 'queue', `${task.id}：原会话暂被占用，尚未开始执行；保留原搭档并自动等待，不消耗返工次数`);
            publish(); return;
          } catch (unsafe) { error = Object.assign(unsafe, { unknownSideEffects: true }); }
        }
        if(error.code==='CONTROL_BUDGET_BUSY'&&error.notDispatched===true&&!error.usage&&!error.desktopEvidence&&typeof queue.defer==='function'){
          // defer 内部走 #assertLease：租约过期会抛 LeaseLostError。与上面 deferNativeBusy 同样保护，
          // 否则这次异常会击穿 perform → Promise.race → 整轮 runQueuedTasks，把其他在飞任务一起抛弃。
          try {
            queue.defer(task.id,token,{notDispatched:true,reason:issueText(error)});budgetDeferred.set(worker,budgetSignature());publish();return;
          } catch (unsafe) { error = Object.assign(unsafe, { unknownSideEffects: true }); }
        }
        if(error.usage){try{queue.recordUsage?.(task.id,token,usageOf({usage:error.usage}));}catch{/* A late fenced result stays in the controller ledger. */}}
        // 租约已被回收（例如机器卡顿超过租约）时，这次结果由队列的恢复流程处理；不能让一次写入失败拖垮整个任务。
        const failure = failureIssues(error, { checkpointPath: control.checkpoints === false ? null : checkpointPath });
        if (failure.environment) { rememberEnvironment(task.id, failure.environment); orch.store.event?.(run.id, 'queue', `${task.id}：[环境/权限限制] 真实原因：${failure.environment.matched}；这类失败不等于执行者失职${control.checkpoints === false ? '' : `，检查点保留在 ${checkpointPath}`}`); }
        try {
          queue.renewOwnLease?.(task.id, token);
          queue.fail(task.id, token, failure.issues, { unknownSideEffects: unknownInput(error) || unknownInput(error.desktopEvidence),
            terminal: error.code === 'CONTROL_BUDGET_EXCEEDED', budgetExceeded: error.code === 'CONTROL_BUDGET_EXCEEDED', attempt: task.attempts });
        } catch (lost) {
          if (lost?.code !== 'LEASE_LOST') throw lost;
          orch.store.event?.(run.id, 'queue', `${task.id} 本次尝试的租约已过期，结果交给队列恢复流程核对，不重复记录：${issueText(error)}`);
        }
        publish();
        reports.push({ taskId: task.id, executor: worker, error: failure.issues[0], environment: failure.environment, outOfScope: error.outOfScope || null, scopeAttribution: error.scopeAttribution || null, verdict: { pass: false, issues: failure.issues } });
      }
    } finally { clearInterval(monitor); }
  }
  async function verifyGlobal() {
    const contract = orch.store.get('goalContract:' + run.id);
    const declared = Array.isArray(plan.acceptance) ? plan.acceptance : [];
    const criterionKey = criterion => String(typeof criterion === 'string' ? criterion : criterion.text).trim();
    const covered = new Set(tasks.flatMap(task => task.acceptance).map(criterionKey));
    const remaining = declared.filter(criterion => !covered.has(criterionKey(criterion)));
    const commands = strings([...(plan.checks || []), ...declared.filter(item => typeof item === 'object').map(item => item.check)]);
    if (!remaining.length && !commands.length) return { pass: true, issues: [] };
    const enabled = flow.runChecks !== false && control.taskAutoChecks !== false;
    const checks = enabled ? await (orch.runChecks || runChecks)(run.cwd, commands, { signal,strict:true }) : [];
    if (aborted()) return { pass: false, issues: ['已取消'] };
    const failed = checks.filter(check => !check.ok && check.notDispatched !== true), blocked = checks.filter(check => !check.ok && check.notDispatched === true), missing = enabled ? commands.filter(command => !checks.some(check => check.command === command)) : commands;
    const criteria = remaining.filter(criterion => typeof criterion !== 'object' || !criterion.check || !checks.some(check => check.command === criterion.check && check.ok));
    const rows = queue.list(), refs = rows.map(task => ({ id: task.id, summary: task.result?.summary || '', artifacts: partitionExecutionArtifacts(run.cwd, task, task.result?.artifacts || [], path.join(artifactRoot, safeId(task.id), 'checkpoint.json')).artifacts, reportPath: task.result?.reportPath || null, toolEvidenceInReport: true, fileBaseline:task.result?.fileBaseline || [], htmlRenderEvidence: task.result?.htmlRenderEvidence || [] }));
    const evidencePath = path.join(artifactRoot, 'global-checks.json'); fs.writeFileSync(evidencePath, JSON.stringify({ checks, criteria, automaticChecksDisabled: !enabled, newFilePreflight: run.newFilePreflight || null }, null, 2));
    orch.store.set('globalChecks:' + run.id, { path: evidencePath, results: checks, unverified: missing, criteria });
    if(checks.some(check=>check.unknownSideEffects||unknownInput(check.evidence)))return {pass:false,issues:['整体验收检查的副作用尚未核验，已保留证据并停止自动重放'],unknownSideEffects:true};
    if (blocked.length || missing.length && (enabled || contract?.requiredChecks?.length)) return { pass: false, unverified: true, issues: [...blocked.map(check => `整体验收检查尚未执行，已有产物保留，不自动返工：${check.output || check.command}`), ...missing.map(command => `${command} 未验证`)] };
    if (!criteria.length && !failed.length && !missing.length) return { pass: true, issues: [] };
    if (control.taskModelReview === false) return { pass: false, issues: ['整体验收仍有未验证或失败项目，模型核验已关闭'] };
    const reviewers = eligibleReviewers('__global__', control.taskTokenBudget || 12000).sort((a, b) => workerMinimumTokens(a, 'review', control) - workerMinimumTokens(b, 'review', control) || rows.filter(task => task.executor === a).length - rows.filter(task => task.executor === b).length);
    const verificationAttachments = renderAttachments(rows.flatMap(task => task.result?.htmlRenderEvidence || []));
    const visual = verificationAttachments.length > 0;
    const eligibleForGlobal = worker => (!contract || !rows.some(task => task.executor === worker));
    const independentOfAll = worker => !rows.some(task => task.executor === worker);
    // 优先能看图的核验人；请不到时先问能看图的顾问，最后才退到不看图的搭档核验非视觉项（别因为没人看图就判整体不通过）。
    let reviewer = reviewers.find(worker => eligibleForGlobal(worker) && (!visual || (supportsVisualReview(worker) && independentOfAll(worker))));
    if (!reviewer && (visual || contract) && orch.roster?.state?.('claude')?.status === 'online' && independentOfAll('claude')) reviewer = 'claude';
    let blindToVisuals = false;
    if (!reviewer && visual) { reviewer = reviewers.find(worker => eligibleForGlobal(worker) && independentOfAll(worker)); if (reviewer) blindToVisuals = true; }
    if (!reviewer) return { pass: false, issues: [visual ? '没有能看图的在线搭档核验整体视觉结果，且没有其他可独立核验的搭档' : '没有接口上下文成本满足剩余预算的在线搭档核验整体验收'] };
    const globalArtifacts = [...new Map(refs.flatMap(ref => ref.artifacts).map(item => [item.path, item])).values()];
    const globalArtifactCount = globalArtifacts.length;
    const allowedCheckpoints = control.checkpoints === false ? [] : rows.map(task => path.join(artifactRoot, safeId(task.id), 'checkpoint.json'));
    const controllerReviewContext = `控制器已授权的精确内部检查点=${JSON.stringify(allowedCheckpoints)}。这些路径由框架要求执行者写入，已保留为内部审计证据，不是客户额外交付物；不因这些精确路径的创建判违反“只交付指定文件”。其他 .beat-control 文件不因此获得写权限，仍按真实工具记录核对范围。开工前统一只读预检记录=${JSON.stringify(run.newFilePreflight || null)}；同一记录也保存在整体检查证据文件。当前是交付前验收，控制器会在本阶段通过后补全客户答复中的真实绝对路径；请核对产物路径实际可读取，不索要尚未生成的最终回复记录。\n`;
    let result = await callBy(reviewer, { role: 'evaluate', slot: `${reviewer}:queue-global-review`, call: 'think', verificationAttachments: blindToVisuals ? [] : verificationAttachments,
      build: () => `只读核验整体组合结果，只对照下列验收和真实检查，不新增标准，不改文件，不读取搭档完整聊天。局部任务均已独立验收通过。只返回 JSON {"pass":true或false,"issues":[{"taskId":"已有任务编号","problem":"对应验收的具体问题"}]}；每个 problem 都必须带上它所属的已有任务编号 taskId，能定位到任务就写该任务编号，确实无法归属时才留空。真实检查失败不能写pass；未运行的检查必须亲自读取证据核验，否则不通过。附图为后台真实浏览器对当前文件的采样帧。${blindToVisuals ? '本次核验不支持看图：截图与视觉相关的验收（外观、部件对齐、观感）你无法判断，不要对它们下结论，也不要因为它们判失败；只核验结构、命名、依赖与文本可判定的标准。' : ''}${goalReviewInstructions(contract, { cannotReadFiles: reviewer === 'claude' })}${controllerReviewContext}\n整体剩余验收：${JSON.stringify(criteria)}\n产出引用：${JSON.stringify(compactEvidence(refs))}\n真实检查：${JSON.stringify(compactEvidence(describeChecks(checks)))}\n未运行命令：${JSON.stringify(missing)}\n完整检查证据文件：${evidencePath}${reviewer === 'claude' ? '\n你无法读盘，产出内容：' + inlineArtifacts([...new Map(refs.flatMap(ref => ref.artifacts).map(item => [item.path, item])).values()]) : ''}` }, { taskId: '__global__', maxOutputTokens: reviewOutputCap(reviewer, globalArtifactCount), budget: control.taskTokenBudget || 12000 });
    let verdict = lastJson(result.text);
    if (visual && imageReadFailure(verdict)) return { pass:false, unverified:true, issues:['整体核验搭档未能读取图片；图片处理结果尚未确认，已有成果保留，继续时只重试核验，不按画面不合格返工。'] };
    if (!verdict) {
      orch.store.event?.(run.id, 'queue', '整体核验这次返回的不是完整 JSON（可能被输出上限截断），已让同一位重发一次，产出不动');
      try {
        result = await callBy(reviewer, { role: 'evaluate', slot: `${reviewer}:queue-global-review`, call: 'think', verificationAttachments: blindToVisuals ? [] : verificationAttachments,
          build: () => `上次答复被截断或不是完整 JSON。这次只返回完整 JSON，不要任何解释或前后缀。只读核验整体组合结果，只对照下列验收和真实检查，不新增标准，不改文件。真实检查失败不能写pass；未运行的检查必须亲自读取证据核验，否则不通过。${blindToVisuals ? '本次核验不支持看图：视觉相关验收你无法判断，不要对它们下结论，也不要因为它们判失败。' : ''}${goalReviewInstructions(contract, { cannotReadFiles: reviewer === 'claude' })}${controllerReviewContext}\n整体剩余验收：${JSON.stringify(criteria)}\n产出引用：${JSON.stringify(refs)}\n真实检查：${describeChecks(checks)}\n未运行命令：${JSON.stringify(missing)}\n完整检查证据文件：${evidencePath}` },
          { taskId: '__global__', maxOutputTokens: Math.max(reviewOutputCap(reviewer, globalArtifactCount), 4000), budget: control.taskTokenBudget || 12000 });
        verdict = lastJson(result.text);
        if (visual && imageReadFailure(verdict)) return { pass:false, unverified:true, issues:['整体核验搭档未能读取图片；图片处理结果尚未确认，已有成果保留，继续时只重试核验，不按画面不合格返工。'] };
      } catch { /* 重发失败时保留首次判定 */ }
    }
    if (contract) {
      const goalArtifacts = [...new Map(refs.flatMap(ref => ref.artifacts).map(item => [item.path, item])).values()];
      // 整体核验同样可能漏读某个交付文件（R366 实测）：补问一次 readbacks，然后才判读回完整性。
      let goalVerdict = verdict;
      if (reviewer === 'claude' && goalArtifacts.length) {
        const completed = await fillMissingReadbacks({ artifacts: goalArtifacts, verdict: goalVerdict, ask: async missing => {
          const response = await callBy(reviewer, { role: 'evaluate', slot: reviewer + ':queue-global-readback', call: 'think',
            build: () => '你上次的整体读回漏了这些交付文件：' + JSON.stringify(missing) + '。只补 readbacks：对每个文件返回 {"path":"完整路径","sha256":"controller","quote":"从附上的当前内容逐字摘取至少8字符的片段"}；不要重新评价、不要改 pass/issues、不要输出其他字段。\n产出内容（你无法读盘，控制器附上）：' + inlineArtifacts(missing.map(file => ({ path: file }))) },
            { taskId: '__global__', maxOutputTokens: 1600, budget: control.taskTokenBudget || 12000 });
          queue.recordUsage?.('__global__', null, usageOf(response));
          return response.text || '';
        } });
        if (completed.filled.length) {
          goalVerdict = completed.verdict;
          orch.store.event?.(run.id, 'queue', '整体核验顾问漏读了 ' + completed.filled.length + ' 个交付文件，已补读回（不重新评价）');
        }
      }
      const goalReview = verifyGoalReadback(goalVerdict, goalArtifacts, contract, {evidence:{calls:rows.flatMap(task=>task.result?.nativeToolEvidence?.calls || task.result?.desktopEvidence?.calls || [])}, controllerHashed: reviewer === 'claude'});
      orch.store.set('deliveryVerification:' + run.id, { ...goalReview, reviewer: result.by || reviewer, at: new Date().toISOString() });
      // 缺读回/目标绑定/禁令证据只继续核验；真实失败且证据齐全才进入任务定位。
      if (!goalReview.evidenceComplete) return { pass: false, unverified: true, issues: goalReview.issues };
      if (!goalReview.pass && verdict?.pass !== false) return { pass: false, unverified: true, issues: goalReview.issues };
    }
    if (blindToVisuals && verdict?.pass === true && !failed.length) return { pass: false, unverified: true, issues: ['视觉相关验收未验证：本次整体核验搭档不支持看图，已有产物保留；有能看图的搭档后点「继续」只核验、不重做'] };
    if (verdict?.pass === true && Array.isArray(verdict.issues) && verdict.issues.length === 0 && !failed.length) return { pass: true, issues: [] };
    const problems = Array.isArray(verdict?.issues) ? verdict.issues : [];
    const realProblems = problems.filter(issue => issue && typeof issue.problem === 'string');
    const attributed = realProblems.filter(issue => rows.some(task => task.id === issue.taskId));
    // 没有任何真实检查结果时，模型拿不出可归属的问题，不足以判死整轮：
    // 这种情况以前会直接把整轮 fail，造成"产物全对却报失败"。改为保留产出、
    // 把未能归属的意见记录在案，让每个已独立通过的小任务维持通过。
    if (!failed.length && !attributed.length) {
      const notes = realProblems.map(issue => String(issue.problem)).slice(0, 5);
      if (contract) return { pass: false, unverified: true, issues: ['整体问题未可靠定位到具体任务，已有产物保留，只继续核验', ...notes] };
      if (!checks.length) return { pass: true, issues: [], unattributedReview: notes };
      if (verdict?.pass !== false) return { pass: true, issues: [], unattributedReview: notes };
      return { pass: false, unverified: true, issues: ['整体验收仍有未验证项目，保留产出等待核对', ...notes] };
    }
    if (!attributed.length) {
      return { pass: false, issues: [...failed.map(check => `整体检查 ${check.command} 失败：${check.output || check.exitCode}`), '整体验收未通过，问题尚未可靠定位到具体任务，保留产出等待核对'] };
    }
    if (typeof queue.reopen !== 'function') return { pass: false, issues: attributed.map(issue => `${issue.taskId}：${issue.problem}`) };
    const grouped = new Map(); for (const issue of attributed) grouped.set(issue.taskId, [...(grouped.get(issue.taskId) || []), issue.problem]);
    let reopened = false;
    for (const [taskId, issues] of grouped) {
      const task = rows.find(item => item.id === taskId); let independent = result.by || reviewer;
      if (independent === task.executor) {
        independent = eligibleReviewers(taskId, task.tokenBudget, [task.executor])[0];
        if (!independent) return { pass: false, issues: [`${taskId} 整体问题缺少非执行者核验，未自动返工`] };
        const confirmation = await callBy(independent, { role: 'evaluate', slot: `${independent}:queue-review`, call: 'think', avoid: [task.executor],
          build: () => `只读核验此任务的整体组合问题是否成立，不修改文件。只返回JSON {"pass":true或false,"issues":["确认存在的具体问题"]}。pass=true只表示此任务原有验收仍通过；有问题返回false和具体问题。\n验收：${JSON.stringify(task.acceptance)}\n整体验收：${JSON.stringify(criteria)}\n待核问题：${JSON.stringify(issues)}\n产出引用：${JSON.stringify(refs)}\n真实检查：${describeChecks(checks)}` }, { taskId, maxOutputTokens: reviewOutputCap(independent), budget: task.tokenBudget });
        const check = lastJson(confirmation.text);
        if (check?.pass !== false || !Array.isArray(check.issues) || !check.issues.length) return { pass: false, issues: [`${taskId} 整体问题尚未被独立核验确认，未自动返工`] };
        issues.splice(0, issues.length, ...check.issues);
      }
      captureExecutionCandidate({ store: orch.store, run, task, report: task.result, artifactRoot, verification: { kind: 'semantic', pass: false, reviewer: independent, issues } });
      const choice = await selectBestExecutionCandidate(orch, run, task, { signal, sessions, call:callBy, retry:!!resumeFrom });
      if (choice.response) queue.recordUsage?.(task.id,null,usageOf(choice.response));
      if (choice.status === 'waiting') return {pass:false,unverified:true,issues:choice.issues};
      const updated = queue.reopen(taskId, independent, issues, { attempt: task.attempts });
      reopened ||= stateOf(updated) === 'queued'; publish();
    }
    return { pass: false, retry: reopened, issues: problems.map(issue => `${issue.taskId}：${issue.problem}`) };
  }
  trace({ event: 'rounds-enter', saved: savedTasks.length, queued: queue.list().filter(t => stateOf(t) === 'queued').map(t => t.id) });
  // inFlight 提到 try 外：外层 catch 要等在飞执行者落地后才能收尾。
  const inFlight = new Map();
  const stateNames={queued:'等待执行',running:'执行中',verifying:'验收中',blocked:'暂时受阻',failed:'未通过',cancelled:'已取消'};
  try {
    let globalVerdict = { pass: true, issues: [] };
    for (let globalRound = 0; globalRound < 4; globalRound++) {
      for (const task of queue.list().filter(item => stateOf(item) === 'verifying')) {
        if (aborted()) break;
        // Reopened prerequisites must pass before their consumers are reverified.
        if (task.dependsOn.some(id => stateOf(queue.list().find(other => other.id === id)) !== 'passed')) continue;
        try { await verifyReport(task, task.result || {}, null); }
        catch (error) { if (!aborted()) { const failure = failureIssues(error); rememberEnvironment(task.id, failure.environment); queue.fail(task.id, null, failure.issues, { attempt: task.attempts, terminal: error.code === 'CONTROL_BUDGET_EXCEEDED', budgetExceeded: error.code === 'CONTROL_BUDGET_EXCEEDED' }); publish(); } }
      }
      const concurrency=Math.max(1,Math.min(workers.length,Number(control.maxParallelTasks)||workers.length));
      inFlight.clear();
      try { if (process.env.BEAT_QUEUE_TRACE) trace({ event: 'round', round: globalRound, participants: orch.participants(run), workers, online: onlineWorkers(), queued: queue.list().filter(t => stateOf(t) === 'queued').map(t => t.id), control: { strongAgent: control.strongAgent, difficultyRouting: control.difficultyRouting, tokenBudgetEnforced: control.tokenBudgetEnforced, hasWorkerMinTokens: typeof control.workerMinTokens } }); } catch {}
      for (;;) {
        if (aborted()) { cancel(); break; }
        let claimed = false;
        for (const worker of workers) {
          if(inFlight.size>=concurrency)break;
          if(budgetDeferred.get(worker)===budgetSignature())continue;
          if (inFlight.has(worker) || mutex.has(worker) || orch.roster?.state && orch.roster.state(worker).status !== 'online') continue;
          const ready = queue.list().filter(task => stateOf(task) === 'queued' && task.dependsOn.every(id => stateOf(queue.list().find(other => other.id === id)) === 'passed'));
          const taskIds = ready.filter(task => (!task.nativeBusyWorker || task.nativeBusyWorker === worker) && (!nativeBusyDeferred.has(task.id) || nativeBusyDeferred.get(task.id).worker === worker && Date.now() >= nativeBusyDeferred.get(task.id).nextAt) && taskRouting({ ...task, tokenBudget: remainingTokens(task.id, task.tokenBudget) }, onlineWorkers(), control).eligibleWorkers.includes(worker)).map(task => task.id);
          try { if (process.env.BEAT_QUEUE_TRACE) trace({ event: 'try-claim', worker, ready: ready.map(t => t.id), taskIds, deferred: [...nativeBusyDeferred.keys()], budgetDeferred: [...budgetDeferred.keys()], routing: ready.map(t => { const r = taskRouting({ ...t, tokenBudget: remainingTokens(t.id, t.tokenBudget) }, onlineWorkers(), control); return { id: t.id, eligible: r.eligibleWorkers, reason: r.routingReason, excluded: r.excluded }; }) }); } catch {}
          if (!taskIds.length) continue;
          const task = queue.claim(worker, { pid: process.pid, taskIds });
          try { if (process.env.BEAT_QUEUE_TRACE) trace({ event: 'claim', worker, claimed: task ? task.id : null }); } catch {}
          if (!task) continue;
          nativeBusyDeferred.delete(task.id);
          if (typeof control.workerMinTokens === 'function') {
            const routing = taskRouting({ ...task, tokenBudget: remainingTokens(task.id, task.tokenBudget) }, onlineWorkers(), control);
            routingRecords.push({ taskId: task.id, mode: 'work-admission', selectedWorker: worker, ...routing });
            const planned = tasks.find(item => item.id === task.id); if (planned) planned.routingReason = routing.routingReason;
            if (routing.routingReason) orch.store.event?.(run.id, 'queue', `${task.id}：${routing.routingReason}`);
          }
          claimed = true; publish();
          const pending = perform(worker, task).finally(() => inFlight.delete(worker));
          inFlight.set(worker, pending);
        }
        if (inFlight.size) { await Promise.race(inFlight.values()); continue; }
        if ([...nativeBusyDeferred.keys()].some(id => queue.list().some(task => task.id === id && stateOf(task) === 'queued'))) { await waitBudget(); continue; }
        if(budgetDeferred.size&&Object.values(orch.store.get?.('controlMetrics:'+run.id)?.reservations||{}).some(r=>r.phase==='execution')){
          await waitBudget();continue;
        }
        for (const task of queue.list().filter(item => stateOf(item) === 'queued')) {
          const routing = taskRouting({ ...task, ...(task.escalated && control.strongAgent ? {eligibleWorkers:[control.strongAgent]} : {}), tokenBudget: remainingTokens(task.id, task.tokenBudget) }, onlineWorkers(), control);
          if (routing.eligibleWorkers.length) continue;
          routingRecords.push({ taskId: task.id, mode: 'work-resume', ...routing });
          const planned = tasks.find(item => item.id === task.id); if (planned) planned.routingReason = routing.routingReason;
          queue.block(task.id, [routing.routingReason], { attempt: task.attempts, reason: routing.excluded.some(item => item.minimumTokens > routing.availableTokens) ? 'token-budget-routing' : 'no-eligible-worker' }); publish();
        }
        const awaiting = queue.list().filter(task => stateOf(task) === 'verifying' && !awaitingReviewer.has(task.id) && !awaitingChecks.has(task.id) && task.dependsOn.every(id => stateOf(queue.list().find(other => other.id === id)) === 'passed'));
        if (awaiting.length) { for (const task of awaiting) await verifyReport(task, task.result || {}, null); continue; }
        if (!claimed) break;
      }
      if (aborted() || !queue.list().every(task => stateOf(task) === 'passed')) break;
      try { globalVerdict = await verifyGlobal(); }
      catch (error) { const failure = failureIssues(error); rememberEnvironment('__global__', failure.environment); globalVerdict = { pass: false, issues: failure.issues }; }
      if (!globalVerdict.retry) break;
    }
    publish();
    const state = queue.list().map(task => ({ ...task, state: stateOf(task) })), passed = globalVerdict.pass && state.length > 0 && state.every(task => task.state === 'passed');
    // 被隔离的任务只保留最后一次失败原因时，客户会以为失败只有这一个原因；
    // R408 实测：先因执行搭档上游账号池不可用失败三次，最后升级时又会话丢失，
    // 结果只显示最后一条原始 CLI 报错。这里把本次尝试过的不同原因一并写进摘要。
    const attemptReasons = task => {
      let rows = [];
      if (typeof queue.get === 'function') { try { rows = queue.get(task.id, { withHistory: true })?.history || []; } catch { rows = []; } }
      if (!rows.length && Array.isArray(task.history)) rows = task.history;
      if (!rows.length) return [];
      // tq_attempts 按 id 倒序（有 outcome）；task.history 是正序（有 event）。统一成发生顺序。
      const chronological = rows[0]?.outcome !== undefined ? [...rows].reverse() : rows;
      const groups = [];
      for (const row of chronological) {
        const issues = Array.isArray(row?.issues) ? row.issues : (typeof row?.issues === 'string' ? [row.issues] : []);
        if (issues.length) groups.push(issues);
      }
      // 最后一条是本次失败：优先保留最近一次评审/执行的全部问题，再看上一次尝试；
      // 旧实现把全部历史压平后只取最后两条，会漏掉同一次评审里的第一条（R408 的“逐页目视未验证”就是这样丢的）。
      const prior = groups.slice(0, -1).slice(-2);
      const seen = new Set(), out = [];
      for (const group of prior) for (const issue of group) {
        const key = String(issue || '').trim();
        if (key && !seen.has(key)) { seen.add(key); out.push(key); }
      }
      return out.slice(0, 6);
    };
    const issues = [...state.filter(task => task.state !== 'passed').map(task => {
      if (awaitingReviewer.has(task.id)) return `${task.title||task.id}：等待独立核验——${verificationWaitMessage(task)}`;
      const current = task.issues?.length ? task.issues.join('；') : '';
      let text = `${task.title||task.id}：${stateNames[task.state]||'尚未完成'}${current ? '，' + current : TERMINAL.has(task.state) ? '' : '，依赖或执行搭档未就绪'}`;
      if (task.state === 'blocked') {
        const earlier = attemptReasons(task).filter(reason => !current.includes(reason)).slice(-2);
        if (earlier.length) text += `（此前尝试：${earlier.join('；')}）`;
      }
      return text;
    }), ...(globalVerdict.pass ? [] : globalVerdict.issues)];
    // 结算账目：除非开了硬限制，token 预算不拦（照常继续），但"花了多少、有没有超出、
    // 为什么没被拦住"必须写在时间线上。买家上一轮就是只能自己翻数据库才发现烧了多少。
    try {
      const phases = (orch.store.get?.('controlMetrics:' + run.id) || {}).phases || {};
      const spent = Object.values(phases).reduce((sum, phase) => sum + Number(phase?.usedTokens || 0), 0);
      const budget = Number(control.executionTokenBudget || 0) + Number(control.discussionTokenBudget || 0);
      if (spent > 0) {
        const overBudget = budget > 0 && spent > budget;
        orch.store.event?.(run.id, 'cost', overBudget
          ? `本轮共消耗 ${spent} token，超出讨论+执行预算 ${budget}（tokenBudgetEnforced=${control.tokenBudgetEnforced === true ? '开启' : '关闭'}，关闭时按设计不拦截）。可在看板设置里开启硬限制，或把预算调高到与用量匹配`
          : `本轮共消耗 ${spent} token（讨论+执行预算 ${budget || '未设置'}）`);
      }
    } catch (error) { orch.store.event?.(run.id, 'cost', `用量结算未能记录：${issueText(error)}`); }
    if (aborted()) { const error = new Error('已取消'); error.cancelled = true; throw error; }
    trace({ event: 'verdict', state: state.map(t => ({ id: t.id, state: t.state })), passed });
    return { reports, verdict: { verdict: passed ? 'pass' : 'fail', pass: passed, summary: passed ? '所有小任务逐项通过验收' : '仍有小任务未通过验收', issues }, environmentIssues: [...environmentIssues.values()], queue: state, metrics: metrics() };
  } catch (error) {
    if (error?.cancelled) throw error;
    // 单个任务的意外异常不得击穿整轮：先把在飞执行者等落地（它们自己会 complete/fail），
    // 再把仍停在 running 的本进程孤儿安全收摊，按队列现状如实收尾——不静默、不谎报通过。
    await Promise.allSettled([...inFlight.values()]);
    inFlight.clear();
    try { queue.reclaimOrphans?.({ reason: issueText(error), loopExited: true }); } catch { /* 收摊失败时保留现状，由 recover() 兜底 */ }
    orch.store.event?.(run.id, 'queue', `执行循环意外中断：${issueText(error)}；已等待在飞执行者落地并按现状收尾，未通过项保留问题与产物`);
    const state = queue.list().map(task => ({ ...task, state: stateOf(task) }));
    const passed = state.length > 0 && state.every(task => task.state === 'passed');
    const issues = [...state.filter(task => task.state !== 'passed').map(task => `${task.title || task.id}：${stateNames[task.state] || '尚未完成'}`), `执行循环意外中断：${issueText(error)}`];
    trace({ event: 'verdict', state: state.map(t => ({ id: t.id, state: t.state })), passed, interrupted: true });
    return { reports, verdict: { verdict: passed ? 'pass' : 'fail', pass: passed, summary: passed ? '所有小任务逐项通过验收' : '执行循环意外中断，仍有小任务未通过验收', issues }, environmentIssues: [...environmentIssues.values()], queue: state, metrics: metrics() };
  } finally { signal?.removeEventListener('abort', cancel); }
}
