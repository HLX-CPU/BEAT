// Bounded, reference-based discussion. Only a participant's own response is a vote.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parsePlan } from './prompts.mjs';
import { createGoalContract, goalContractPrompt, assertGoalBinding, assertGoalPlan, goalPlanIssues, assertRequestedTesting, requestedTestingPrompt } from './goal-contract.mjs';
import { decideTermination, TERMINATION_REASONS } from './collaboration-policy.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => String(value).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const CORE = ['route', 'sequence', 'risk'];
// Shared wording is a proposal vocabulary, never an automatic vote or alias.
// Participants can disagree and every existing hash/review/veto gate remains.
export function fileOutlineVocabulary(goal) {
  if (!/(?:新建|创建)/.test(String(goal)) || !/\.(?:txt|md|csv|json)\b/i.test(String(goal))) return '';
  return '\n这是普通文本文件创建时可复用的选项词汇；仅在你本人同意且适合本次目标时使用原文，避免为同一选择换说法：route="文件接口或受控命令创建，独立读回验收"；sequence="检查目标，分文件创建，独立核验，交付路径"；risk="保留已有文件，不覆盖不删除，未验证不报完成"。这些不是预设投票：有实质分歧或严重反对必须如实写不同选项和原因，用户已经明确要求的分工、数量、编码等是固定约束，放入步骤和验收，不为是否遵守它另建assignment等选择；只有确有待选方案或反对时才另列，严重反对必须保留。步骤最多4条、风险最多3条，写清必要内容即可。仅共享父目录不等于数据依赖；目标内容已经给定、文件互不依赖时，各执行者可幂等创建父目录再独占创建自己的文件，无需等待另一文件通过验收。对于限定8个以内、任务目录内的纯新建txt/md/csv/json文件计划，控制器会在任何执行者开工前统一只读检查全部目标均不存在；任一目标已存在则整轮不派发文件写入。执行者仍需排他创建自己的文件，不再把同轮另一搭档新建文件误当成旧冲突。最终客户答复由控制器补全真实绝对路径：计划文件范围使用相对路径，交付验收仍要求完整路径。';
}
const safeId = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/i.test(value);
const short = (value, max = 600) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const list = (value, max = 12) => Array.isArray(value) && value.length <= max;
// 提纲的自由文本上限：提示词里要求更短（180），这里留到 240 并有界截断，
// 不因为"写得长"就把一条有效提纲判成"缺少内容"并终止整轮（token 已经花掉了）。
const OUTLINE_ITEM_MAX = 240, OUTLINE_ITEM_REQUEST = 180, OUTLINE_ITEMS_MAX = 8;
const clipped = (value, max) => String(value).trim().slice(0, max);
// 顶层 goalBinding 是"方案回复"的契约字段；parallel 分支此前用 parsePlan 解析后把它丢掉，
// 评审每轮都判"方案顶层缺少 goalBinding"，而修订只能改章节、永远补不回来（R542 实测：
// 两轮自动接续都卡在这条意见上，最终整单判死，客户点"继续"也无解）。这里统一带回。
const withGoalBinding = (plan, binding) => (plan && binding && typeof binding === 'object' && !Array.isArray(binding) && !plan.goalBinding ? { ...plan, goalBinding: binding } : plan);
const failure = message => Object.assign(new Error(message), { code: 'COMPACT_INVALID_RESPONSE', nonRetryable: true });
// 模型常省略可选字段：没写 serious 就是没有严重反对；写了严重反对却没写类别，保守按安全类处理。
const BOOL = { true: true, false: false };
function normalizeFlags(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return d;
  const serious = d.serious === undefined || d.serious === null ? false : typeof d.serious === 'string' ? BOOL[d.serious.trim().toLowerCase()] ?? d.serious : d.serious;
  const category = typeof d.category === 'string' && d.category.trim() ? d.category.trim().toLowerCase() : serious === true ? 'safety' : 'ordinary';
  return { ...d, serious, category };
}

// 只修多余或错位的右括号（模型常见笔误），字符串内容不动；缺右括号说明答复被截断，不补全，
// 以免吞掉被截断的严重反对。修完仍要过全部内容校验。
export function repairBrackets(text) {
  const stack = [], pairs = { '}': '{', ']': '[' };
  let out = '', inString = false, escaped = false;
  for (const ch of text) {
    if (inString) { out += ch; if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); out += ch; continue; }
    if (ch === '}' || ch === ']') { if (stack.at(-1) === pairs[ch]) { stack.pop(); out += ch; } continue; }
    out += ch;
  }
  if (inString || stack.length) return null;
  return out;
}

export function parseCompact(text, kind) {
  let raw = String(text).trim();
  if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(raw); }
  catch (error) {
    const repaired = repairBrackets(raw);
    try { if (repaired === null) throw error; value = JSON.parse(repaired); }
    catch {
      const at = /position (\d+)/.exec(error.message)?.[1];
      throw failure(`答复不是有效 JSON${at ? `：第 ${at} 个字符附近括号或逗号不匹配（…${raw.slice(Math.max(0, at - 40), Number(at) + 20)}…）` : ''}`);
    }
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw failure('讨论答复必须是结构化对象');
  if (kind === 'outline') {
    // 缺内容 / 结构错 → 明确失败；自由文本偏长 → 有界截断后继续（上限同时写在提示词里）。
    if (typeof value.core !== 'string' || !value.core.trim()) throw failure('提纲缺少核心思路 core');
    if (!Array.isArray(value.steps) || !value.steps.length || !value.steps.every(x => typeof x === 'string' && x.trim())) throw failure('提纲缺少关键步骤：steps 必须是非空文字数组');
    if (!Array.isArray(value.risks) || !value.risks.every(x => typeof x === 'string' && x.trim())) throw failure('主要风险必须是文字数组 risks');
    if (!Array.isArray(value.decisions) || !value.decisions.length) throw failure('提纲缺少决策 decisions');
    value = { ...value, decisions: value.decisions.map(normalizeFlags) };
    const clippedLong = value.core.length > 600 || value.steps.length > 12 || value.risks.length > 12
      || value.steps.some(x => x.trim().length > OUTLINE_ITEM_MAX) || value.risks.some(x => x.trim().length > OUTLINE_ITEM_MAX);
    value = { ...value, core: clipped(value.core, 600), steps: value.steps.slice(0, 12).map(x => clipped(x, OUTLINE_ITEM_MAX)), risks: value.risks.slice(0, 12).map(x => clipped(x, OUTLINE_ITEM_MAX)) };
    // 只做非枚举标记：不影响产物哈希与决策比对，调用方据此在看板留一条说明。
    if (clippedLong) Object.defineProperty(value, 'truncated', { value: true, enumerable: false });
    const ids = new Set();
    for (const [index, d] of value.decisions.entries()) {
      const at = '第 ' + (index + 1) + ' 项决策';
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw failure(at + '必须是对象');
      if (!safeId(d.id)) throw failure(at + '的 id 无效：需字母开头、不超过 64 字符');
      if (ids.has(d.id)) throw failure(at + '的 id 与前面重复：' + d.id);
      if (typeof d.option !== 'string' || !d.option.trim()) throw failure(at + '缺少选项名称 option');
      if (d.option.length > 300) throw failure(at + '的 option 超过 300 字（' + d.option.length + ' 字）：请压缩成短而稳定的选项名');
      if (typeof d.reason !== 'string' || !d.reason.trim()) throw failure(at + '缺少理由 reason');
      if (d.reason.length > 240) throw failure(at + '的 reason 超过 240 字（' + d.reason.length + ' 字）');
      if (typeof d.serious !== 'boolean') throw failure(at + '缺少 serious 布尔值');
      if (!['ordinary', 'safety', 'money', 'irreversible'].includes(d.category)) throw failure(at + '的 category 不合法：' + String(d.category));
      ids.add(d.id);
      if (d.serious && d.category === 'ordinary') throw failure(at + '标了严重反对，category 必须写安全、资金或不可逆');
    }
    if (!CORE.every(id => ids.has(id))) throw failure('提纲未按统一关键决策编号给出选择：必须包含 route、sequence、risk');
  } else if (kind === 'votes') {
    if (!list(value.votes, 24)) throw failure('分歧投票格式错误');
    value = { ...value, votes: value.votes.map(normalizeFlags) };
    const ids = new Set();
    for (const v of value.votes) {
      if (!safeId(v.id) || ids.has(v.id) || !short(v.option, 300) || !short(v.reason, 240) || typeof v.serious !== 'boolean' || !['ordinary', 'safety', 'money', 'irreversible'].includes(v.category)) throw failure('分歧投票必须包含唯一编号、选择和一句理由');
      if (v.serious && v.category === 'ordinary') throw failure('严重反对类别不完整');
      ids.add(v.id);
    }
  } else if (kind === 'review') {
    if (!['pass', 'fail'].includes(value.verdict) || !short(value.planHash, 80) || !list(value.issues, 20) || !value.issues.every(x => x && short(x.section, 160) && short(x.problem, 500) && (x.criterion===undefined||Number.isInteger(x.criterion)&&x.criterion>=0&&x.criterion<64))) throw failure('评审须返回 pass/fail、同一版本哈希和具体章节问题');
    // 评审允许三种意思，而不是两种：
    //   ① fail + 有问题       → 打回修订（问题必须具体，一条都没有反而无法执行）
    //   ② pass + 没问题       → 直接通过
    //   ③ pass + 全是非严重备注 → 通过，但把备注单独记下来（不阻塞、不进返工）
    // 只有"pass 却带着 serious=true 的问题"才算真矛盾：那是既说通过又指出严重问题，必须由人/模型自己解决。
    // 实测（R171 #1179 等 5 次）：模型写 pass + "属执行注意事项，不影响方案结构" + serious:false，
    // 旧规则一律判"矛盾"，把一条正确意见当成坏答复，白烧一轮重问。
    const notes = value.verdict === 'pass' ? value.issues : [];
    const contradictory = value.verdict === 'fail' ? value.issues.length === 0 : notes.some(x => x.serious === true);
    if (contradictory) throw failure(value.verdict === 'fail'
      ? '评审给了 fail 却一条问题都没写：请写出具体问题，或把结论改成 pass（非严重意见请设 serious=false）'
      : '评审给了 pass 却带着 serious=true 的问题：要么把结论改成 fail，要么把这些意见降为非严重备注（serious=false）');
    if (notes.length) value.notes = notes;
  } else if (kind === 'selection') {
    if (typeof value.proceed !== 'boolean' || !short(value.reason, 1000) || !safeId(value.candidateId) || !/^[a-f0-9]{64}$/.test(value.planHash || '')) throw failure('顾问选择须明确 candidateId、真实 planHash、proceed 和理由，旧版只给 proceed 的裁决不能代替方案选择');
  } else if (kind === 'expand' && value.sections !== undefined) {
    validateSections(value.sections);
  }
  return value;
}

// 通过门槛：四人及以上 3/4；三人 2 票（2:1 已是明确多数，不必每次都请顾问）；两人须一致。
export const majorityThreshold = n => n <= 1 ? 1 : n <= 3 ? Math.floor(n / 2) + 1 : Math.ceil(n * 0.75);

// 评估/评审轮的有效席位判定：某位掉线、超时或答复不完整时，按"缺席"记，不让整轮作废；
// 只有本人有效答复低于门槛时才不成立（代答只作参考、不计本人票，沿用既有规则）。
// 门槛复用 majorityThreshold，安全/严重反对规则一概不动。
export function reviewQuorum({ participants = [], records = [], missing = [] } = {}) {
  const absent = [...missing];
  const self = [];
  for (const record of records || []) {
    if (!record) continue;
    if (record.by !== record.seat) { if (!absent.some(x => x.seat === record.seat)) absent.push({ seat: record.seat, reason: '只能由别的搭档代答（代答不计本人票）' }); continue; }
    if (record.partial) { if (!absent.some(x => x.seat === record.seat)) absent.push({ seat: record.seat, reason: '预算中断，只有部分答复' }); continue; }
    self.push(record);
  }
  const need = majorityThreshold((participants || []).length);
  const absentSeats = absent.map(x => x.seat);
  const detail = absent.length ? `（缺席：${absent.map(x => `${x.seat} ${x.reason}`).join('；')}）` : '';
  return {
    self,
    absent,
    need,
    ok: self.length >= need && self.length > 0,
    note: `本轮有效票 ${self.length}/${(participants || []).length}，需 ${need} 票${detail}`,
    failureMessage: !self.length
      ? '评审没有任何本人有效答复，尚未批准执行'
      : `评审本人有效答复不足门槛（有效 ${self.length} 票，需 ${need} 票${absentSeats.length ? '，缺席 ' + absentSeats.join('、') : ''}），尚未批准执行`,
  };
}

// 把模型确认的等义选项并到同一名称下，再按原有投票和门槛重算；严重反对照旧阻止锁定。
export function applyAliases(disputes, threshold) {
  const locked = {};
  for (const d of disputes) {
    const map = new Map((d.aliases || []).map(a => [canonical(a.from), a.to]));
    if (!map.size) continue;
    const to = option => map.get(canonical(option)) ?? option;
    d.options = d.options.filter(option => !map.has(canonical(option)));
    d.votes = Object.fromEntries(Object.entries(d.votes || {}).map(([seat, option]) => [seat, to(option)]));
    const winner = d.options.find(option => Object.values(d.votes).filter(x => canonical(x) === canonical(option)).length >= threshold);
    if (winner && !d.vetoes.length) locked[d.id] = { option: winner, source: 'merge', votes: d.votes, aliases: d.aliases };
  }
  return locked;
}

export function mergeOutlines(outlines, participants) {
  const threshold = majorityThreshold(participants.length);
  const decisions = new Map();
  for (const record of outlines) {
    if (record.by !== record.seat || !participants.includes(record.seat)) continue;
    for (const item of record.value.decisions) {
      const row = decisions.get(item.id) || { id: item.id, options: [], votes: {}, vetoes: [] };
      if(!record.partial)row.votes[record.seat] = item.option;
      if (!row.options.some(x => canonical(x) === canonical(item.option))) row.options.push(item.option);
      if (item.serious) row.vetoes.push({ agent: record.seat, category: item.category, reason: item.reason });
      decisions.set(item.id, row);
    }
  }
  const locked = {}, disputes = [];
  for (const row of decisions.values()) {
    const winner = row.options.find(option => Object.values(row.votes).filter(x => canonical(x) === canonical(option)).length >= threshold);
    if (winner && !row.vetoes.length) locked[row.id] = { option: winner, source: 'majority', votes: row.votes };
    else disputes.push(row);
  }
  return { locked, disputes, threshold };
}

// ── 直接要答案的问题：不展开方案、不评审，直接回答 ──────────────────────────
// 实测 R369：一句"请直接给我答案"走了 22 步 / 5 分 17 秒 / 4 个候选方案评审，
// 最后卡在内部字段（goalBinding）死循环上，0 答案。这类请求和"问答"一样，应该一次答复。
const ANSWER_INTENT = /(?:直接|只要|只需|仅需|就想|就想要?)\s*(?:给|告诉|回答|答复)?\s*(?:我)?\s*(?:一个|一下|个)?\s*(?:答案|结果)|(?:给|告诉|回答|答复)\s*(?:我|一下|一个|个)\s*(?:答案|结果)|(?:只|仅)(?:需|要)?\s*(?:回答|回复|给出|输出|告诉|给)\s*(?:我)?\s*(?:一个|一下|个)?\s*(?:答案|结果|数字|选项|结论)|不要(?:展开|解释|分析|说明|写过程)|答案(?:是)?(?:什么|多少|哪个)|正确(?:的)?(?:是|选项|答案)|选择题|判断题|第\s*\d+\s*[题道]|选(?:什么|哪个|哪一项)|对不对/;
// 带这些动作词就不是"只要答案"，仍然走完整讨论流程（避免把任务型请求误当问答）。
const ANSWER_BLOCKERS = /(?:创建|新建|删除|移动|复制|保存|导出|生成|制作|修改|改成|重写|打开|启动|运行|安装|部署|提交|发送|发布|登录|注册|交付|开发|实现|修复|重构|测试|评审|讨论|分析|思路|原理|方案|计划|排期|报告|文件|文件夹|代码|脚本|项目|程序|网页|文档)/;
// 短小的纯问题（"什么是闭包""这个报错什么意思？"）也按问答处理：
// 客户在讨论框里打字时，不会先想"这是讨论还是提问"，产品应该自己判断。
const QUESTION_FORM = /(?:是什么|什么意思|为什么|怎么办|怎么样|怎么(?:才能|回事)|如何|多少|哪个|哪一个|是否|能不能|可不可以|谁|什么时候)[？?]?\s*$|^\s*(?:如何|怎么|为什么|什么是)/;
// “给几条标准/结论，总字数不超过 N 字”是文本答案，不是方案或执行计划。
// R468 实测：这类问题旧分类器返回 false，被当成工程方案审了 4 分 48 秒、146k token。
const BOUNDED_ANSWER = /(?:总字数|字数|全文|正文)[^。；\n]{0,12}(?:不超过|少于|≤|<=)\s*\d+\s*(?:个)?(?:字|汉字)|\d+\s*(?:个)?(?:字|汉字)\s*(?:以内|以下|之内|左右)/;
const ACTION_VERBS = /(?:帮我|请)?(?:写|做|创建|新建|打开|运行|执行|修改|删除|安装|部署|发送|提交|导出|转换|生成|下载|上传|打包|登录|注册|截图|录制|画|设计|实现|开发)/;
export function isAnswerOnlyGoal(goal) {
  const text = String(goal || '').trim();
  if (!text || text.length > 200 || text.includes('\n')) return false;
  if (ANSWER_BLOCKERS.test(text)) return false;
  if (ANSWER_INTENT.test(text) || BOUNDED_ANSWER.test(text)) return true;
  // 更宽一档：短问题 + 没有"动手"动词 + 以问号/吗/呢结尾，或明确的提问格式。
  if (text.length > 80 || ACTION_VERBS.test(text)) return false;
  return QUESTION_FORM.test(text) || /[？?]\s*$/.test(text) || /(?:吗|呢)\s*$/.test(text);
}
/** 直接回答的搭档：带附件优先用能自己看图的 Codex，其次 DeepSeek，最后才轮到拓展坞。 */
// 客户显式传的 max_turns 是辩论轮数的上限：max_turns=2 最多 1 轮辩论。
// 本地控制器可以在上限内再调低；最终值写进 metrics，避免“传 2 却显示 0 轮”无法解释。
export function debateLimitFor(flow = {}, maxTurns = null) {
  const configured = Math.max(0, Math.min(3, Number.isInteger(flow?.discussionMaxDebates) ? flow.discussionMaxDebates : 3));
  const requested = Number.isInteger(maxTurns) ? Math.max(1, maxTurns) : null;
  const effective = requested ? Math.max(0, Math.min(configured, requested - 1)) : configured;
  return { configuredMaxDebates: configured, requestedMaxTurns: requested, effectiveMaxDebates: effective };
}

export function pickAnswerSeat(participants = [], attachments = []) {
  const hasFiles = Array.isArray(attachments) && attachments.length > 0;
  // 带附件优先给能原生读图的 codex；纯文本按 deepseek → codex → zcode 的顺序挑先在线的。
  const order = hasFiles ? ['codex', 'deepseek', 'zcode'] : ['deepseek', 'codex', 'zcode'];
  return order.find(seat => participants.includes(seat)) || participants[0] || null;
}

// 失败结果也分"给人看的一句话"和"留给排查的过程记录"：看板只铺摘要，长理由折进详情。
// 以前失败文案是代码模板 + 顾问 reason 直接拼成一段，400 字 0 换行，客户读起来像机器日志。
export const RESULT_DETAIL_MARK = '\n（以下为详细过程记录，看板上可折叠）';
// 讨论给客户的答复只留结论（≤300 字），方案全文/评审过程折进详情。
// R431 实测：一次讨论的答复直接是"技术路线/实施步骤/分工"内部方案，客户要自己找结论。
export function splitDiscussionAnswer({ summary = '', full = '', limit = 300 } = {}) {
  const flatten = value => String(value ?? '').replace(/\r\n/g, '\n').trim();
  const whole = flatten(full || summary);
  if (!whole) return { answer: '', detail: null };
  const brief = flatten(summary);
  let answer = brief || whole.split(/\n\s*\n/)[0] || whole;
  if (answer.length > limit) {
    const windowText = answer.slice(0, limit + 1);
    const cut = Math.max(...['。', '！', '？', '；', '\n'].map(mark => windowText.lastIndexOf(mark)));
    answer = cut >= Math.floor(limit / 2) ? windowText.slice(0, cut + 1)
      : windowText.slice(0, limit).replace(/\s+$/, '') + '…';
  }
  answer = answer.trim();
  if (!answer) return { answer: whole.slice(0, limit), detail: whole.length > limit ? whole : null };
  return { answer, detail: whole !== answer ? whole : null };
}

// 讨论的 plan.summary 常常是"实施步骤/技术路线"这种内部计划，不是给客户的答案。
// 优先从顾问综合参考/核心结论里取一句人话；没有时再用原摘要。
const DISCUSSION_META = /(?:技术路线|实施步骤|风险处理|验收标准|职责分工|任务拆分|执行约束|请围绕|以简短结论回答|方案摘要|核心思路)/;
const cutAnswer = (text, limit = 300) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const windowText = clean.slice(0, limit + 1);
  const cut = Math.max(...['。', '！', '？', '；', '\n'].map(mark => windowText.lastIndexOf(mark)));
  return cut >= Math.floor(limit / 2) ? windowText.slice(0, cut + 1) : windowText.slice(0, limit).replace(/\s+$/, '') + '…';
};
export function pickDiscussionAnswer({ summary = '', full = '' } = {}) {
  const brief = String(summary || '').trim(), whole = String(full || '');
  const reference = whole.lastIndexOf('顾问综合参考（四家答案合并）：');
  if (reference >= 0) {
    const tail = whole.slice(reference + '顾问综合参考（四家答案合并）：'.length).trim();
    if (tail) return cutAnswer(tail.replace(/^核心结论[：:]\s*/, ''));
  }
  const core = whole.match(/(?:^|\n)(?:核心结论|结论)[：:]\s*([^\n]{8,600})/);
  if (core) return cutAnswer(core[1]);
  if (brief && !DISCUSSION_META.test(brief)) return cutAnswer(brief);
  const advice = whole.match(/\n(?:结论|建议|答案)[^\n]*\n+([^\n]{8,600})/);
  if (advice) return cutAnswer(advice[1]);
  return cutAnswer(brief || whole.split(/\n\s*\n/)[0]);
}

// 讨论结果拼装：给客户的答复在前，方案全文折进详情；裁决只加一句如实说明。
export function composeDiscussionResult({ base = '', summary = '', direct = false, consensus = false, adjudicated = false, advisorUsed = false } = {}) {
  const split = direct ? { answer: String(base || ''), detail: null } : splitDiscussionAnswer({ summary: pickDiscussionAnswer({ summary, full: base }), full: base });
  let text = split.answer + (split.detail ? RESULT_DETAIL_MARK + '\n' + split.detail : '');
  if (consensus && adjudicated) text = `⚖ 部分分歧由${advisorUsed ? '顾问 Claude ' : '裁决搭档'}裁定，严重反对已由提出者本人确认\n\n` + text;
  return text;
}

export function failureText({ title, reason = '', next = '', detail = [] } = {}) {
  const head = [title, reason ? '原因：' + reason : '', next ? '下一步：' + next : ''].filter(Boolean).join('\n');
  const body = (Array.isArray(detail) ? detail : [detail]).filter(Boolean).join('\n\n');
  return body ? head + RESULT_DETAIL_MARK + '\n' + body : head;
}

export async function negotiateCompact(orch, run, signal, sessions, mode, proposal = null, context = '') {
  const participants = orch.participants(run);
  if (!participants.length) throw failure('没有可参与讨论的搭档');
  const flow = orch.flowFor ? orch.flowFor(run) : orch.config.flow || {};
  const key = 'compactNegotiation:' + run.id + ':' + hash({ mode, proposal, round: proposal ? run.rounds : 0 });
  const state = orch.store.get(key) || { calls: {}, transcript: [], locked: {}, disputes: [], metrics: { calls: 0, debates: 0, mergeFallback: 0 }, planVersion: 0 };
  // Enable the new binding only for fresh attachment tasks, never retrofit old votes.
  if (!state.goalContract && !Object.keys(state.calls).length) {
    const contract = orch.store.get('goalContract:' + run.id) || (run.attachments?.length ? createGoalContract(run) : null);
    // Explicit product/attachment discussions bind each proposal. Generic tasks
    // keep the sealed original goal for final acceptance without redundant JSON.
    if (contract?.subject || run.attachments?.length) state.goalContract = contract;
  }
  const goalContract = state.goalContract || null;
  const directory = path.join(run.cwd, '.beat-control', String(run.id).replace(/[^a-z0-9_-]/gi, '_'));
  fs.mkdirSync(directory, { recursive: true });
  const artifactPath = path.join(directory, 'discussion-' + hash(key).slice(0, 12) + '.json');
  const save = () => {
    orch.store.set(key, state);
    if (goalContract) orch.store.set('goalContract:' + run.id, goalContract);
    // 客户要能一眼看出这次到底是"几个人在讨论"还是"一个人直接答"：
    // 旧实现把单人直答也记成 consensus，看板和接口都像"多方一致"（评测 R476 实测）。
    const candidateRows = (state.candidates || []).map(candidate => ({
      candidateId: candidate.candidateId, planHash: candidate.planHash, author: candidate.author, origin: candidate.origin,
      summary: String(candidate.summary || candidate.plan?.summary || '').slice(0, 400),
      passed: (candidate.reviews || []).filter(row => row.verdict === 'pass').length,
      reviews: (candidate.reviews || []).length,
    }));
    orch.store.set('discussionMetrics:' + run.id, { ...state.metrics, artifactPath, lockedCount: Object.keys(state.locked).length, disputeCount: state.disputes.length, planHash: state.planHash || null,
      mode: state.metrics.directAnswer ? 'direct' : 'multi',
      participantCount: state.metrics.directAnswer ? 1 : participants.length,
      answeredBy: state.metrics.directAnswer?.seat || null,
      selector: state.metrics.candidateSelection ? { candidateId: state.metrics.candidateSelection.candidateId, passCount: state.metrics.candidateSelection.passCount, reviewers: state.metrics.candidateSelection.reviewers, candidateCount: state.metrics.candidateSelection.candidateCount } : null,
      candidates: candidateRows });
    fs.writeFileSync(artifactPath, JSON.stringify({ participants, goalContract, locked: state.locked, disputes: state.disputes, plan: state.plan, planHash: state.planHash, candidates: state.candidates || [], calls: Object.fromEntries(Object.entries(state.calls).map(([k, v]) => [k, { seat: v.seat, by: v.by, value: v.value, partial: !!v.partial }])), metrics: state.metrics }, null, 2));
  };
  const result = () => ({ transcript: state.transcript, consensus: !!state.consensus, plan: state.plan || null, planVersion: state.planVersion, planHash: state.planHash || null, advisorUsed: state.metrics.adjudication?.actualJudge === 'claude' || state.metrics.candidateSelection?.judge === 'claude', adjudicated: !!state.metrics.adjudication, compact: true, summaryText: state.summaryText, metrics: { ...state.metrics, artifactPath } });
  // 客户点「继续」时，未通过的讨论要真的能接着走：保留所有已完成答复，只重做失败的那一步。
  // 已通过的方案不重开；严重反对未解决等保护在重走时照样生效。
  const resumeMark = orch.store.get?.('resumeDiscussion:' + run.id);
  if (state.finished && !state.consensus && resumeMark && state.resumedAt !== resumeMark) {
    // 修订换一代编号重新请求，不复用上次没被采用的答复。
    Object.assign(state, { finished: false, resumedAt: resumeMark, summaryText: undefined, repairGeneration: (state.repairGeneration || 0) + 1 });
    // 客户点「继续」必须真的重新问模型：上一轮的评审/裁决答复是"旧方案"的结论，
    // 不能当成新方案的答案直接复放。R542 实测：12 次点击都在 0.1 秒内命中缓存，
    // 连一次模型调用都没有，客户只看到同一句失败。
    for (const id of Object.keys(state.calls || {})) {
      if (/^(review:|review-selection:|repair-ruling:|adjudicate$)/.test(id)) delete state.calls[id];
    }
    // 手动继续额外给一次修订额度：自动接续上限是为了防止无人值守时反复烧钱，
    // 但不该让"客户亲自点的继续"也立即撞上终态。
    state.autoContinuations = Math.max(0, Number(state.autoContinuations || 0) - 1);
    if (state.preflightRepairs) state.preflightRepairs = Math.max(0, Number(state.preflightRepairs) - 1);
    if (state.metrics) {
      state.metrics.autoContinuations = state.autoContinuations;
      if (state.preflightRepairs !== undefined) state.metrics.preflightRepairs = state.preflightRepairs;
    }
    // 老方案缺顶层 goalBinding 的（作者每次答复都给了，是代码把它丢掉了）在继续时补回，
    // 否则评审会永远判"缺少 goalBinding"，点多少次都一样。
    if (mode === 'parallel' && state.plan && !state.plan.goalBinding) {
      const binding = state.lastGoalBinding
        || state.calls?.expand?.value?.goalBinding
        || Object.values(state.calls || {}).map(record => record?.value?.goalBinding).find(item => item && typeof item === 'object');
      if (binding) { state.plan = withGoalBinding(state.plan, binding); state.planHash = hash(state.plan); }
    }
    // 把上次未解决的具体意见接着修，而不是原样重放旧方案。
    const lastIssues = Array.isArray(state.lastIssues) && state.lastIssues.length
      ? state.lastIssues
      : (state.candidates || []).flatMap(candidate => candidate.reviewIssues || []);
    if (lastIssues.length && (state.reviewRevision || 0) > 0) {
      state.pendingReviewChange = { issues: structuredClone(lastIssues), id: 'resume', nextRevision: state.reviewRevision };
    }
    if (state.reviewRevision === 1 && !Object.keys(state.calls).some(id => id.startsWith('review:1:'))) state.reviewRevision = 0;
    save();
  }
  if (state.finished) return result();
  // 只问答案的问题：一次直接回答，不展开方案、不评审、不裁决。
  // R369 实测：这类请求走完整方案流程要 22 步 / 5 分多钟，最后还可能因内部字段卡死、0 答案。
  if (mode === 'discuss' && !proposal && !state.planHash && !Object.keys(state.calls || {}).length && isAnswerOnlyGoal(run.goal)) {
    const seat = pickAnswerSeat(participants, run.attachments || []);
    if (seat) {
      orch.store.event?.(run.id, 'negotiate', `这是直接要答案的问题：跳过方案展开、评审和裁决，由 ${seat} 直接回答`);
      const directOptions = { role: 'discuss', seat, round: 1, signal, sessions,
        build: () => `用户只想要一个直接答案，不是方案、评审或执行计划。\n直接回答下面的问题：能确定就给结论和一两句依据；需要联网或查资料才能核实的，说明你核实到什么程度，不确定就直说，不能编造。不要输出 JSON，不要写方案，不要反问，除非缺少关键信息确实无法作答。\n用户原话：${run.goal}` };
      // 快路径也必须走进预算/用量账本：旧实现直接 orch.step，R370/R371 详情里 token 是 null。
      const answer = orch.controlCall
        ? await orch.controlCall(run, directOptions, { phase: 'discussion', taskId: null, maxOutputTokens: 1200 })
        : await orch.step(run, directOptions);
      const text = String(answer?.text || '').trim();
      if (text) {
        state.summaryText = text;
        state.consensus = true; state.finished = true;
        state.metrics.directAnswer = { seat: answer.by || seat, at: new Date().toISOString() };
        save();
        return result();
      }
      orch.store.event?.(run.id, 'negotiate', '直接回答没有返回内容，已回落到完整讨论流程');
    }
  }
  // A budget interruption before approval must collect missing original participants
  // on explicit resume before recomputing consensus, keeping every completed outline.
  if(state.budgetStopped&&!state.planHash&&participants.some(seat=>!state.calls['outline:'+seat])){
    state.merged=false;state.stalled=false;state.budgetStopped=false;state.locked={};state.disputes=[];save();
  }
  const call = async (id, seat, stage, prompt, kind, adjudication = false, limit = 1000) => {
    orch.guard(run.id, signal);
    if (state.calls[id]) { assertGoalBinding(state.calls[id].value, goalContract, kind); return state.calls[id]; }
    // A done Store step is evidence of a completed call even if the process died before its checkpoint.
    const marker = 'COMPACT_CALL_ID=' + key + ':' + id + '\n';
    let prior = orch.store.steps?.(run.id)?.find(x => x.state === 'done' && (x.data?.compactCallId === key + ':' + id || x.prompt?.includes(marker)));
    const rejectMalformed = (stepId, error) => {
      orch.store.updateStep?.(stepId, { state: 'failed', error: error.message });
      orch.setStep(stepId, '答复不完整，保留原文；继续时仅重试此项', { compactCallId: key + ':' + id, compactStage: stage, ownVote: false });
    };
    if (prior) {
      try { assertGoalBinding(parseCompact(prior.output, kind), goalContract, kind); }
      catch (error) { rejectMalformed(prior.id, error); prior = null; }
    }
    const opts = { role: stage === 'review' ? 'evaluate' : stage === 'expand' || stage === 'repair' ? 'decide' : 'discuss', seat, round: state.metrics.debates + 1, signal, sessions,
      // 允许接替：某位搭档掉线/冷却时由在线搭档代答（代答只作参考、不计本人投票），
      // 一位都接不上时由上层把这一位跳过继续，而不是把整轮讨论判死。
      onlyAgent: false,
      onStart: stepId => orch.setStep(stepId, '精简讨论：' + stage, { compactCallId: key + ':' + id, compactStage: stage }),
      // 讨论/规划只输出方案，不执行：明确告诉模型"文件路径写相对任务工作目录的相对路径"。
      // 实测（R166）：提示词里从不出现任务工作目录，模型只能照"共享产物"那个路径去编，
      // 编出 <共享目录>\R166\funcplot\… 这种越界目录，检查命令随之全被拒。
      build: () => marker + `你是 BEAT 的 ${seat} 搭档。阶段=${stage}。只返回一个 JSON 对象，不写 Markdown、不执行任务、不修改文件。目标：${run.goal}\n本次参与者：${participants.join(', ')}。共享产物：${artifactPath}。只读取与你本次请求有关的部分，不读其他模型的完整对话。\n规划口径：所有文件路径一律写"相对任务工作目录"的相对路径（如 tasks/a.test.mjs、src/x.py），不要写盘符或绝对路径；任务工作目录（执行时把文件写在这里）：${run.cwd}。\n${prompt}` };
    const originalBuild = opts.build;
    opts.build = () => originalBuild() + '\n' + goalContractPrompt(goalContract) + requestedTestingPrompt(run.goal);
    const started = Date.now();
    let response;
    try{response = prior ? { by: prior.agent, text: prior.output, stepId: prior.id, label: prior.agent } : orch.controlCall ? await orch.controlCall(run, opts, { phase: 'discussion', taskId: null, maxOutputTokens: limit, adjudication }) : await orch.step(run, opts);}
    catch(error){
      if(error.code!=='CONTROL_BUDGET_EXCEEDED'||!['outline','votes'].includes(kind)||!error.partialText)throw Object.assign(error, { compactStage: stage });
      if(error.actualAgent!==seat||!error.stepId)throw failure('预算中断答复的作者或步骤无法核实，严重反对尚未排除；已保留证据，禁止执行');
      try{parseCompact(error.partialText,kind);}catch{throw failure('预算中断后的答复不完整，无法排除未核验的严重反对；已保留记录，禁止执行');}
      response={by:seat,text:error.partialText,stepId:error.stepId,label:seat,partial:true};
      state.stalled=true;state.budgetStopped=true;
    }
    let value;
    state.goalVetoes ||= {};
    const retainedVetoes = state.goalVetoes[id] ||= [];
    // 格式错误回给同一位搭档自纠（最多 2 次），不因一次漏字段让整个任务出错。
    for (let fix = 0; ; fix++) {
      try {
        value = parseCompact(response.text, kind);
        assertRequestedTesting(value, run.goal);
        assertGoalBinding(value, goalContract, kind);
        // 作者每次答复里的顶层绑定都记下来：老方案被代码丢掉时，继续/恢复可以补回，
        // 不用再反复重开整轮讨论（R542 实测两轮自动接续都卡在这条）。
        if (value.goalBinding && typeof value.goalBinding === 'object') state.lastGoalBinding = value.goalBinding;
        if (retainedVetoes.some(veto => !value.decisions?.some(d => d.id === veto.id && d.serious === true && d.category === veto.category && d.reason === veto.reason))) throw failure('纠正任务对象不能删除或改写先前的严重反对，请保留原项并逐项解决');
        break;
      }
      catch (error) {
        if (error.goalBindingMismatch) {
          for (const d of Array.isArray(value?.decisions) ? value.decisions : []) if (d.serious === true && !retainedVetoes.some(v => JSON.stringify(v) === JSON.stringify(d))) retainedVetoes.push(d);
          save();
        }
        rejectMalformed(response.stepId, error);
        if (error.code !== 'COMPACT_INVALID_RESPONSE' || response.partial || fix >= 2) {
          throw Object.assign(new Error(`${seat} 连续 ${fix + 1} 次没有按要求的格式答复（${error.message}），已保留它的原文。点「继续」会只重问这一位搭档；也可以先在看板暂停它再继续`), { code: error.code, nonRetryable: true });
        }
        orch.store.event?.(run.id, 'negotiate', `${seat} 的答复格式有误（${error.message}），已把问题告诉它重新答复`);
        const retryOpts = { ...opts, build: by => opts.build(by) + `\n\n你上一次的答复格式有误或目标未通过校验：${error.message}。请只修正这一处，重新返回完整 JSON，其余内容保持不变。${retainedVetoes.length ? '以下严重反对必须原样保留，不能借目标纠正删除：' + JSON.stringify(retainedVetoes) : ''}上一次答复：${String(response.text).slice(0, 4000)}` };
        response = orch.controlCall ? await orch.controlCall(run, retryOpts, { phase: 'discussion', taskId: null, maxOutputTokens: limit, adjudication }) : await orch.step(run, retryOpts);
      }
    }
    const record = { seat, by: response.by, value, stepId: response.stepId,...(response.partial?{partial:true}:{}),...(value.truncated?{truncated:true}:{}) };
    state.calls[id] = record;
    if (!prior) {
      state.metrics.calls++;
      state.metrics.stages ||= {};
      const measured = state.metrics.stages[stage] ||= { calls: 0, elapsedMs: 0, outputCharacters: 0 };
      measured.calls++; measured.elapsedMs += Date.now() - started; measured.outputCharacters += response.text.length;
    }
    orch.setStep(response.stepId, (response.partial?'预算到限，完整文字仅供裁决，严重反对保留':response.by === seat ? '精简讨论答复已记录' : '代答只作参考，不计本人投票') + (value.truncated?'；本次答复超出建议长度，已按上限截断（原文在本步骤记录里）':''), { compactCallId: key + ':' + id, compactStage: stage, ownVote: response.by === seat&&!response.partial, ...(value.truncated?{compactTruncated:true}:{}) });
    state.transcript.push({ label: response.label || response.by, text: `${stage}；产物 ${artifactPath}#${id}；${JSON.stringify(value).slice(0, 400)}` });
    save();
    return record;
  };
  const parallel = async (ids, fn) => {
    const settled = await Promise.allSettled(ids.map(fn));
    orch.guard(run.id, signal);
    const errors = settled.filter(x => x.status === 'rejected').map(x => x.reason);
    if (errors.length) {
      // 把"哪几位没答复"带出去：调用方要能按缺席席位判定，而不是只知道"有错"。
      const missing = settled.map((x, i) => ({ seat: ids[i], reason: String(x.reason?.message || x.reason || '没有答复').slice(0, 160) })).filter((_, i) => settled[i].status === 'rejected');
      throw Object.assign(errors[0], { seatFailures: missing });
    }
    return settled.map(x => x.value);
  };
  // 评估/评审轮专用：某位失败不丢整轮，把失败记成"缺席"交回调用方按有效席位判定。
  // 安全性不变：缺席不会被当成赞成，严重反对照旧一票否决；只有本人有效票达到门槛才成立。
  const settleSeats = async (ids, fn) => {
    const settled = await Promise.allSettled(ids.map(fn));
    orch.guard(run.id, signal);
    const records = [], failures = [];
    settled.forEach((x, i) => {
      if (x.status === 'fulfilled') records.push(x.value);
      else failures.push({ seat: ids[i], error: x.reason, reason: String(x.reason?.message || x.reason || '没有答复').slice(0, 160) });
    });
    return { records, failures, missing: failures.map(x => ({ seat: x.seat, reason: x.reason })) };
  };
  // 掉线/冷却的席位记进跳过名单（后续轮次不再问它、也不再算它的本人票）。
  // 与评审阶段原来那套记录完全一致：同一份 discussionSkipped / participantExcluded。
  const skipSeat = (seat, reason) => {
    const rows = orch.store.get('discussionSkipped:' + run.id) || [];
    if (rows.some(row => row.agent === seat)) return false;
    const row = { agent: seat, status: 'skipped', reason, at: new Date().toISOString() };
    orch.store.set('discussionSkipped:' + run.id, [...rows, row]);
    orch.store.set('participantExcluded:' + run.id, [...(orch.store.get('participantExcluded:' + run.id) || []), row]);
    orch.store.event?.(run.id, 'negotiate', `${seat} 掉线或不可用（${reason}），已跳过它；其余搭档继续，未完成任务重新分配`);
    return true;
  };
  // 只有"这位席位不可用且还能再试"才降级成缺席（掉线、超时、冷却、预算中断）。
  // 答复格式错误、身份/版本不符、以及任何标记 nonRetryable 的错误都是契约问题：
  // 照样停下并给人话出口，绝不因为降级而放过去。
  const seatUnavailable = error => {
    if (!error) return false;
    // 预算中断只允许出现在本来就设计了"半截答复"处理的阶段（提纲/投票）；安全确认、评审、展开
    // 一旦被预算打断就必须硬停——已有契约：不能用"部分观点"或"没答完"通过任何一轮。
    if (error.code === 'CONTROL_BUDGET_EXCEEDED') return error.compactStage === 'outline' || error.compactStage === 'votes';
    if (error.nativeBusy === true || error.code === 'NATIVE_SESSION_BUSY') return true;
    // 只认"这位席位确实联系不上"这一类（掉线/超时/连接失败）；其余一律硬停。
    // 宁可停下来给人话出口，也不把未知错误当成"缺席"混过去。
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error.code)) return true;
    if (error.code === 'COMPACT_INVALID_RESPONSE' || error.code === 'COMPACT_REQUIRED_FIELD' || error.code === 'COMPACT_INVALID_JSON') return false;
    if (error.nonRetryable === true) return false;
    return /offline|unavailable|timed?\s?out|timeout|ECONNREFUSED|ECONNRESET|socket|network|掉线|超时|不可用|冷却/i.test(String(error.message || ''));
  };
  const fail = message => {
    state.consensus = false; state.finished = true; state.summaryText = message;
    // 失败时不能保留上一阶段“已达成一致/达到辩论上限”的终止说明：
    // R468 实测出现 termination=consensus、最终却 not-approved 的自相矛盾。
    state.metrics.termination = { stop: true, reason: TERMINATION_REASONS.FAILED, note: String(message || '').split('\n')[0].slice(0, 200), at: new Date().toISOString() };
    orch.store.event(run.id, 'negotiate', message); save(); return result();
  };
  if (goalContract?.clarification) return fail(goalContract.clarification);
  if (goalContract && goalContract.originalGoal !== String(run.goal || '')) return fail('本次目标已变更，原方案不能沿用；请按新的目标发起任务');
  const prefix = (proposal ? `待返工方案=${JSON.stringify(proposal)}。仅解决返工问题：${context}\n` : '');
  const outlineVocabulary = mode === 'parallel' ? fileOutlineVocabulary(run.goal) : '';
  const outlineSchema = '{"core":"一句核心思路","steps":["关键步骤"],"risks":["主要风险"],"decisions":[{"id":"route","option":"清楚、短、稳定的选项名称","reason":"一句理由","category":"ordinary|safety|money|irreversible","serious":false}]}';
  if (!state.merged) {
    let outlines;
    try { outlines = await parallel(participants, seat => call('outline:' + seat, seat, 'outline', prefix + `只出提纲，不写完整方案。必须给 route（技术路线）、sequence（步骤顺序）、risk（风险处理）三个决策。只有无法包含在这三项中的目标特有选择才增加独立决策，最多9项；简单单文件任务通常三项已足够，不把每条验收或编码细节拆成新决策。相同含义用相同选项名称。serious=true 表示对当前目标或方案有严重安全/资金/不可逆反对，写明原因，后续必须单独解决。长度硬要求：core 不超过 300 字；每条 step/risk 不超过 180 字、各最多 8 条；每项决策的 option 不超过 120 字、reason 不超过 180 字；决策最多 9 项；总输出不超过 900 tokens（超过建议长度会被截断，缺内容才会被拒绝）。格式：${outlineSchema}${outlineVocabulary}`, 'outline')); }
    catch (error) {
      if (error.code !== 'CONTROL_BUDGET_EXCEEDED') throw error;
      outlines = participants.map(x => state.calls['outline:' + x]).filter(Boolean);
      state.stalled = true; state.budgetStopped = true;
      if (!outlines.length) return fail('讨论预算已用尽且没有有效提纲，尚未批准执行');
    }
    const merged = mergeOutlines(outlines, participants);
    Object.assign(state, merged, { merged: true }); save();
  }
  // Optional one-shot semantic aliasing. Model proposes aliases; code preserves every original vote and veto.
  if (flow.outlineMergeFallback !== false && !state.budgetStopped && state.disputes.some(dispute => dispute.options.length > 1) && !state.aliasAttempted) {
    // 轻量搭档不在场时由其他在场搭档做这一次归并，而不是跳过、多辩论一轮。
    const cheap = (flow.cheapAgents || []).find(x => participants.includes(x)) || [flow.strongAgent, run.initiator, ...participants].find(x => participants.includes(x));
    state.aliasAttempted = true; save();
    if (cheap) {
      let mapping;
      try { mapping = await call('aliases', cheap, 'merge', `只对齐同一决策中语义完全相同的选项，不选赢家，不修改严重反对。候选=${JSON.stringify(state.disputes)}。返回 {"aliases":[{"id":"决策编号","from":"已有选项原文","to":"已有等义选项原文"}]}。无等义项返回空数组。`, 'aliases'); }
      catch (error) { if (error.code !== 'CONTROL_BUDGET_EXCEEDED') throw error; state.stalled = true; state.budgetStopped = true; save(); }
      if (mapping?.by === cheap && list(mapping.value.aliases, 24)) {
        for (const a of mapping.value.aliases) {
          const d = state.disputes.find(x => x.id === a.id);
          if (!d || !d.options.includes(a.from) || !d.options.includes(a.to) || a.from === a.to) continue;
          d.aliases = [...(d.aliases || []), { from: a.from, to: a.to }];
        }
        // 等义选项合并后按各搭档本人的原始投票重算；有严重反对的仍不锁定。
        const mergedLocks = applyAliases(state.disputes, state.threshold);
        Object.assign(state.locked, mergedLocks);
        state.disputes = state.disputes.filter(d => !state.locked[d.id]);
        state.metrics.mergeFallback++; save();
      }
    }
  }
  const debateLimit = debateLimitFor(flow, run.max_turns);
  const maxDebates = debateLimit.effective;
  state.metrics.debateLimit = debateLimit;
  const debateBudget = Number(flow.discussionTokenBudget) > 0 ? Number(flow.discussionTokenBudget) : null;
  if (flow.disputeVoting !== false) {
    // 借鉴 AutoGen GroupChat 的终止条件：辩论不能在"模型觉得聊完了"时继续烧 token。
    // 预算接近上限、上一轮没有推进、分歧数量没有下降、达到轮数上限都算可判定的终止。
    for (;;) {
      const usedTokens = Number(orch.store.get?.('controlMetrics:' + run.id)?.phases?.discussion?.usedTokens) || 0;
      const termination = decideTermination({ consensus: !state.disputes.length, disputes: state.disputes, debates: state.metrics.debates,
        maxDebates, stalled: state.stalled, lastDisputeCount: state.metrics.lastDisputeCount ?? null, tokensUsed: usedTokens, tokenBudget: debateBudget });
      if (termination.stop) {
        state.metrics.termination = { ...termination, at: new Date().toISOString() };
        save();
        if (termination.reason !== TERMINATION_REASONS.CONSENSUS) orch.store.event?.(run.id, 'negotiate', `讨论终止（${termination.reason}）：${termination.note}`);
        break;
      }
      const round = state.metrics.debates + 1, disputes = structuredClone(state.disputes), before = disputes.length;
      let ballots, voteSeats = participants;
      const settleBallots = seats => settleSeats(seats, seat => call(`vote:${round}:${seat}`, seat, 'vote', `只回答以下未锁定分歧，不重复共识，不改完整方案：${JSON.stringify(disputes)}。每项选一个已列出的 option，一句理由；有严重安全/资金/不可逆反对设 serious=true。返回 {"votes":[{"id":"route","option":"已列选项","reason":"一句理由","category":"ordinary|safety|money|irreversible","serious":false}]}。每项最多 50 字。`, 'votes'));
      let voteSettled;
      try {
        for (let attempt = 0; ; attempt++) {
          voteSettled = await settleBallots(voteSeats);
          // 席位不可用（掉线/超时/冷却）→ 记缺席并跳过；答复格式错误 → 照旧硬停。
          const hard = voteSettled.failures.filter(x => !seatUnavailable(x.error));
          if (hard.length) throw hard[0].error;
          if (!voteSettled.missing.length || attempt >= 2 || !voteSeats.length) break;
          for (const row of voteSettled.missing) skipSeat(row.seat, `本轮投票没有本人答复（${row.reason}）`);
          const missingSeats = new Set(voteSettled.missing.map(x => x.seat));
          voteSeats = voteSeats.filter(x => !missingSeats.has(x));
          orch.store.event?.(run.id, 'negotiate', `分歧投票第 ${round} 轮：${[...missingSeats].join('、')} 没有答复，按缺席继续；在场 ${voteSeats.join('、') || '（无）'}`);
          if (!voteSeats.length) break;
        }
      } catch (error) {
        if (error.code !== 'CONTROL_BUDGET_EXCEEDED') throw error;
        state.stalled = true; save(); break;
      }
      ballots = voteSettled ? voteSettled.records : [];
      // 有人缺席时按实际在场席位调整门槛；严重反对照旧一票否决，不受影响。
      if (voteSeats.length && voteSeats.length !== participants.length) state.threshold = majorityThreshold(voteSeats.length);
      for (const d of disputes) {
        const votes = {}, vetoes = [...d.vetoes];
        for (const record of ballots) {
          if (record.by !== record.seat) continue;
          const v = record.value.votes.find(x => x.id === d.id);
          if (!v) continue;
          if (v.serious && !vetoes.some(x => x.agent === record.seat && x.reason === v.reason)) vetoes.push({ agent: record.seat, category: v.category, reason: v.reason });
          if(record.partial||!d.options.some(x=>canonical(x)===canonical(v.option)))continue;
          votes[record.seat] = v.option;
        }
        const winner = d.options.find(option => Object.values(votes).filter(x => canonical(x) === canonical(option)).length >= state.threshold);
        if (winner && !vetoes.length) state.locked[d.id] = { option: winner, source: 'vote', votes };
        else Object.assign(d, { votes, vetoes });
      }
      state.disputes = disputes.filter(x => !state.locked[x.id]);
      state.metrics.debates = round; state.metrics.lastDisputeCount = state.disputes.length; state.stalled = state.budgetStopped||state.disputes.length >= before; save();
    }
  }
  if (state.disputes.length) {
    // 裁决由顾问（Claude）做；顾问暂不可用时不让任务卡住，改由裁决搭档裁决并如实记录。
    const advisorOnline = orch.roster?.state?.('claude')?.status === 'online';
    const fallbackJudge = participants.includes(flow.strongAgent) ? flow.strongAgent : participants.includes(run.initiator) ? run.initiator : participants[0];
    const judge = state.metrics.adjudication?.actualJudge || (advisorOnline ? 'claude' : fallbackJudge);
    const requestedJudge='claude';
    state.metrics.adjudication={requestedJudge,actualJudge:judge,reason:judge==='claude'?'advisor':'顾问暂不可用，由裁决搭档裁决'};
    if(judge!=='claude')orch.store.event(run.id,'negotiate',`顾问暂时连不上，本次分歧改由 ${judge} 裁决；严重反对仍须提出者本人逐项确认`);
    save();
    const adjudicatePrompt = `分歧拉锯结束，需要一位顾问把四家的答案**综合整理成一份可直接执行的综合参考**（不是另起一套方案）。对每个分歧只选一项，且 option 必须**逐字复制**该分歧 options 里已有的一项：不能自造新选项、不能把多个选项合并（要综合只写进 reference）；严重安全反对必须单独提出具体防护/取消危险动作的解决措施，不能多数覆盖。分歧=${JSON.stringify(state.disputes)}。四家已给出的答案与投票都在上面的分歧里，请合并它们的共同点、保留更严格的约束。返回 {"decisions":[{"id":"编号","option":"已列选项","reason":"裁决理由","resolution":"有严重反对时具体解决办法，否则空字符串"}],"reference":"200字以内、给下一步执行用的综合参考（关键结论 + 必须保留的约束 + 执行注意）"}。`;
    let judged = await call('adjudicate', judge, 'adjudicate', adjudicatePrompt, 'adjudicate', true, 1500);
    // 指定的裁决者（通常是顾问 Claude）自己没答上来、由在线搭档代答时，不让整轮停在这里：
    // 改由裁决搭档本人裁决并如实记录——和"顾问离线"用的是同一套兜底，代答依旧不算本人裁决。
    if (judged.by !== judge) {
      const retryJudge = fallbackJudge === judge ? participants.find(seat => seat !== judge) : fallbackJudge;
      if (retryJudge && retryJudge !== judge && orch.roster?.state?.(retryJudge)?.status === 'online') {
        state.metrics.adjudication = { requestedJudge, actualJudge: retryJudge, reason: `${judge} 没能本人裁决，改由 ${retryJudge} 裁决` };
        orch.store.event?.(run.id, 'negotiate', `${judge} 本次没能本人给出裁决，改由 ${retryJudge} 裁决；严重反对仍须提出者本人逐项确认`);
        save();
        judged = await call('adjudicate-2', retryJudge, 'adjudicate', adjudicatePrompt, 'adjudicate', true, 1500);
      }
    }
    const actualJudge = () => state.metrics.adjudication?.actualJudge || judge;
    if (judged.by !== (state.metrics.adjudication?.actualJudge || judge) || !list(judged.value.decisions, 24)) return fail('裁决未由指定搭档本人完成，尚未批准执行');
    // 模型偶尔会把多个候选“合并”成一个新选项（R368 实测：Claude 自造综合选项，整轮直接判死）。
    // 安全要求仍只接受已有候选；但先把合法选项原样回给裁决者重判一次，避免整轮白跑。
    const adjudicationIssues = value => {
      const issues = [];
      for (const d of state.disputes) {
        const rows = (Array.isArray(value?.decisions) ? value.decisions : []).filter(x => x && typeof x === 'object' && x.id === d.id);
        if (rows.length !== 1) { issues.push(`分歧 ${d.id} 必须且只能给一项（收到 ${rows.length} 项）`); continue; }
        const pick = rows[0];
        if (!short(pick.option, 300)) issues.push(`分歧 ${d.id} 缺少 option`);
        else if (!d.options.some(x => canonical(x) === canonical(pick.option))) issues.push(`分歧 ${d.id} 的选项“${String(pick.option).slice(0, 120)}”不在候选里，只能原样复制：${d.options.map(x => '「' + x + '」').join('、')}`);
        if (!short(pick.reason)) issues.push(`分歧 ${d.id} 缺少 reason`);
        if (d.vetoes.length && !short(pick.resolution, 1000)) issues.push(`分歧 ${d.id} 有严重反对，缺少 resolution`);
      }
      return issues;
    };
    let adjudicationProblems = list(judged.value.decisions, 24) ? adjudicationIssues(judged.value) : ['decisions 必须是数组'];
    if (adjudicationProblems.length) {
      const retrySeat = actualJudge();
      state.adjudicationRepairs = (state.adjudicationRepairs || 0) + 1;
      const repairPrompt = `你上一次的分歧裁决不能直接执行：\n- ${adjudicationProblems.join('\n- ')}\n请重新给出完整的 decisions。硬性要求：每个分歧只选一项；option 必须**逐字复制**该分歧 options 里已有的一项，不得自造新选项，也不得把多个选项合并；reason 一句话；有严重反对时 resolution 写具体解决办法。分歧与合法选项=${JSON.stringify(state.disputes.map(d => ({ id: d.id, options: d.options })))}。返回与之前相同的 JSON 结构。`;
      orch.store.event?.(run.id, 'negotiate', `裁决没有按候选原样选择（${adjudicationProblems[0].slice(0, 120)}），已把合法选项回给 ${retrySeat} 重判一次`);
      try { judged = await call('adjudicate-fix:' + state.adjudicationRepairs, retrySeat, 'adjudicate', repairPrompt, 'adjudicate', true, 1500); }
      catch (error) { if (error.code === 'CONTROL_BUDGET_EXCEEDED') throw error; return fail('裁决选项不在候选里，重判时没有拿到答复：' + error.message + '；尚未批准执行'); }
      if (judged.by !== actualJudge()) return fail('裁决未由指定搭档本人完成，尚未批准执行');
      adjudicationProblems = list(judged.value.decisions, 24) ? adjudicationIssues(judged.value) : ['decisions 必须是数组'];
      if (adjudicationProblems.length) return fail('裁决没有按候选原样选择：' + adjudicationProblems.slice(0, 3).join('；') + '；尚未批准执行（各搭档原始意见已保留，点「继续」会只重做裁决）');
      state.metrics.adjudication = { ...(state.metrics.adjudication || {}), repairs: state.adjudicationRepairs };
    }
    // 顾问的综合参考（可缺省）：它综合四家答案整理出的执行参考，原样交给下一步，不改任何已锁定决策。
    const advisorReference = short(judged.value.reference, 2000) ? String(judged.value.reference).trim() : '';
    if (advisorReference) {
      state.metrics.adjudication = { ...(state.metrics.adjudication || { requestedJudge, actualJudge: judge, reason: judge === 'claude' ? 'advisor' : '裁决搭档' }), reference: advisorReference };
      orch.store.event?.(run.id, 'negotiate', `${judge} 综合四家答案给出的执行参考：${advisorReference.slice(0, 300)}`);
    }
    const resolvedDecisions=[];const safetyByAgent=new Map();
    for (const d of state.disputes) {
      const choices = judged.value.decisions.filter(x => x.id === d.id);
      const decision = choices[0];
      if (choices.length !== 1 || !decision || !short(decision.option, 300) || !short(decision.reason) || !d.options.some(x => canonical(x) === canonical(decision.option))) return fail('裁决缺少有效选择，尚未批准执行');
      if (d.vetoes.length) {
        if (!short(decision.resolution, 1000)) return fail('严重安全、资金或不可逆反对尚未得到单独解决');
        for (const agent of [...new Set(d.vetoes.map(x => x.agent))]) {
          safetyByAgent.set(agent,[...(safetyByAgent.get(agent)||[]),{id:d.id,decision:d,resolution:decision}]);
        }
      }
      resolvedDecisions.push({d,decision});
    }
    for(const [agent,points]of safetyByAgent){
      const single=points.length===1;
      const check=await call(single?'veto:'+points[0].id+':'+agent:'veto-batch:'+agent,agent,'safety',`你的每项严重反对必须逐项单独核对，不能用多数票覆盖。待核对决策及措施=${JSON.stringify(points)}。仅在该项措施确实解决反对时写resolved=true，否则false。返回 ${single?'{"resolved":true,"reason":"具体理由"}':'{"resolutions":[{"id":"逐项决策编号","resolved":true,"reason":"该项具体理由"}]}'}。不得漏项或把未解决项写通过。`,'safety',true,Math.min(1600,points.length*400));
      const answers=single?[{id:points[0].id,...check.value}]:check.value.resolutions;
      if(check.by!==agent||!Array.isArray(answers)||points.some(p=>{const rows=answers.filter(r=>r.id===p.id);return rows.length!==1||rows[0].resolved!==true||!short(rows[0].reason);}))return fail('严重反对仍未逐项由提出者本人确认解决，禁止执行');
    }
    for(const {d,decision}of resolvedDecisions){
      state.locked[d.id] = { option: decision.option, source: 'adjudication', reason: decision.reason, resolution: decision.resolution || null };
    }
    state.disputes = []; save();
  }
  if (!CORE.every(id => state.locked[id])) return fail('关键决策未完整锁定，尚未批准执行');
  // Select the author whose original outline won most decisions; stable roster order breaks ties.
  const ranked = participants.map(agent => ({ agent, score: (state.calls['outline:' + agent]?.by === agent&&!state.calls['outline:'+agent]?.partial ? state.calls['outline:' + agent].value.decisions : []).filter(x => state.locked[x.id] && canonical(x.option) === canonical(state.locked[x.id].option)).length })).sort((a, b) => b.score - a.score);
  const author = ranked[0].agent;
  const lockedChoices = Object.fromEntries(Object.entries(state.locked).map(([id, value]) => [id, value.option]));
  // Only completed expansion/repair outputs become candidates. Keep snapshots before
  // the next repair so recovery and adjudication never invent an alternative plan.
  const rememberCandidate = (candidatePlan, origin, summary = state.summaryText) => {
    const planHash = hash(candidatePlan);
    state.candidates ||= [];
    let candidate = state.candidates.find(row => row.planHash === planHash);
    if (!candidate) {
      candidate = { candidateId: `candidate-${state.candidates.length + 1}`, planHash, plan: structuredClone(candidatePlan), author, origin, summary, goalHash: hash(run.goal), lockedHash: hash(state.locked), reviews: [], reviewIssues: [] };
      state.candidates.push(candidate);
    }
    // Upgrade existing 2.2.15 checkpoints from real, completed reviews, never from
    // an advisor's claim that a plan passed.
    for (const [id, review] of Object.entries(state.calls)) if (id.startsWith('review:') && review.by === review.seat && review.value.planHash === planHash && !candidate.reviews.some(row => row.callId === id)) {
      candidate.reviews.push({ callId: id, reviewer: review.seat, verdict: review.value.verdict, issues: structuredClone(review.value.issues) });
    }
    candidate.reviewIssues = candidate.reviews.filter(row => row.verdict === 'fail').flatMap(row => row.issues);
    save(); return candidate;
  };
  if (!state.candidates?.length && state.planHash && state.calls.expand?.by === author && sameDecisions(state.calls.expand.value.decisions, state.locked)) {
    // Old runs have no snapshots. Reconstruct only the actual expanded plan and
    // the persisted final plan; do not pretend unavailable intermediate versions exist.
    const expanded = state.calls.expand.value;
    let original = mode === 'parallel' ? withGoalBinding(parsePlan(expanded.plan), expanded.goalBinding) : { ...(expanded.goalBinding ? { goalBinding: expanded.goalBinding } : {}), summary: expanded.summary, decisions: expanded.decisions, ...(expanded.sections ? { sections: expanded.sections } : {}) };
    if (original) {
      try { if (mode === 'parallel') { if (orch.compileControlledPlan) original = orch.compileControlledPlan(run, original); orch.validatePlan(run, original); } rememberCandidate(original, 'expand', expanded.summary); }
      catch (error) { orch.store.event(run.id, 'negotiate', '旧展开方案无法重新核对，只保留当前真实方案候选：' + error.message); }
    }
  }
  const candidateIssues = candidate => {
    if (hash(candidate.plan) !== candidate.planHash || candidate.author !== author || candidate.goalHash !== hash(run.goal) || candidate.lockedHash !== hash(state.locked)) return ['候选身份、目标、内容哈希或锁定决策不一致'];
    const targetIssues = goalPlanIssues(candidate.plan, goalContract);
    if (targetIssues.length) return targetIssues.map(issue => issue.problem);
    if (candidate.reviewIssues.some(issue => issue.serious === true)) return ['该候选存在未解决的严重评审反对'];
    if (mode !== 'parallel') return sameDecisions(candidate.plan.decisions, state.locked) ? [] : ['候选偏离锁定决策'];
    const problems = [];
    const hasAll = (before, after) => (before || []).every(item => (after || []).some(row => JSON.stringify(row) === JSON.stringify(item)));
    if (!hasAll(state.plan.acceptance, candidate.plan.acceptance)) problems.push('候选未保留现有整体验收要求');
    if (candidate.plan.tasks.length !== state.plan.tasks.length) problems.push('候选更改了既有任务数量');
    for (const task of state.plan.tasks) {
      const selected = candidate.plan.tasks.find(row => row.id === task.id);
      if (!selected || selected.owner !== task.owner || !hasAll(task.acceptance, selected.acceptance) || JSON.stringify(selected.files) !== JSON.stringify(task.files)) problems.push('候选未保留任务身份、文件范围或验收要求：' + task.id);
    }
    return problems;
  };
  const planSchema = { tasks: [{ id: 'task-1', owner: '参与者ID', title: '小任务', detail: '明确步骤', type: 'workspace', files: ['文件范围'], dependsOn: [], inputRefs: [], outputRefs: ['产出路径'], acceptance: ['怎么算完成'], checks: [], difficulty: 'simple|hard', eligibleWorkers: ['只在该任务必须由特定搭档执行时填（例如电脑操作、看图必须用有桌面或视觉能力的那一方），值是搭档 ID 数组；不需要限制就整段省略这个字段，填空数组也等同不限制'], tokenBudget: Number.isInteger(flow.taskTokenBudget) ? flow.taskTokenBudget : 12000, maxRetries: 2 }], acceptance: ['整体验收标准'], checks: [] };
  const planContract=mode==='parallel'?'重要接口约定：tasks 里每个任务必须写非空 files（逐条列出要创建/修改的相对路径，不能写“相关文件”这类说明）；只是调研、确认信息、不产生文件的步骤不要单独建任务，请并入真正产出文件的任务，或给这一步一个明确产出文件。inputRefs/outputRefs必须是真实文件路径，不能填任务编号、说明文字或内存中的结论；依赖的输出路径可作为输入。checks只放可运行的已注册检查命令，人话检查标准放acceptance。可用的验收命令通道：node --version、node --check 文件、node --test 明确测试文件、npm test/lint/check/format:check，以及 python -m py_compile 文件、pytest 测试文件、go test、cargo test、dotnet test（看板设置里可再注册其它程序）。**用户目标里已经写明可执行的验收命令时，必须至少有一条进入 checks，不得只写成人话留在 acceptance**——否则这次交付将没有机器验收，只剩模型自评；不需要命令就checks=[]，目标禁止命令时所有checks必须为空。控制器会自动安排非执行者逐项独立核验，不要再把这层核验拆成第二个修改同一文件的执行任务；如果需要另交付报告，明确报告文件范围和路径。控制器自己的检查点和证据是框架记录，不算额外用户产物。文件只在不存在时创建可使用BEAT desktop_call的file_write（expectedHash="absent"，原子wx），精确字节读取可用file_read（含text/totalBytes/sha256）；不需要运行命令或操作界面。':'';
  const discussionSections = [{ id: 'route', title: '技术路线', content: '展开已锁定的技术路线' }, { id: 'sequence', title: '实施步骤', content: '展开已锁定的步骤和验收方法' }, { id: 'risk', title: '风险处理', content: '展开已锁定的风险措施' }];
  const automaticCriteria = mode==='parallel'?'可完全由已注册命令证明的任务验收项用 {"text":"明确标准","check":"精确检查命令"}，该命令通过后不再用模型重复核验该项；代码检查不能证明的行为、内容或风险标准保持文字，由独立搭档核验。不要把语义标准错误挂到只能查语法的命令上。验收必须忠于用户目标，不自行增加目标未要求的内容长度或哈希值；未经代码计算，不编造字节数。':'';
  const sectionNames = () => mode === 'parallel' ? 'tasks.<稳定任务id或下标>、checks、acceptance、goalBinding' : state.plan.sections ? 'goalBinding（目标绑定）、sections.<稳定章节id> 或 summary（概览）' : 'goalBinding（目标绑定）或 summary（旧版完整正文）';
  /**
   * 修订三次都没被采纳时的升级路径：交顾问裁决，而不是把整轮判死。
   *
   * 为什么要有这一步（实测 R181）：同一轮讨论里，"两轮评审仍有意见"会交顾问裁决并继续执行，
   * 但"作者修订三次不通过"却直接 fail 整轮——27 步、约 25 分钟、0 产出。同样的目标换个说法
   * 一次就谈成。开会没谈拢 ≠ 这事做不了，所以这里也交顾问。
   *
   * 边界一条都不放宽：
   *   · 顾问只能在**已有真实候选**之间选（不能新写方案），且候选必须仍满足验收与安全边界；
   *   · 不许降低任何验收标准、不许覆盖严重安全/资金/不可逆反对；
   *   · 顾问离线时退给裁决搭档，并如实记录"谁裁的"；
   *   · 顾问说"作者还能修"时，只给具体修正清单，作者再改（最多 2 次），之后重新评审。
   */
  const adjudicateRepairFailure = async (issues, attempts, lastProblem) => {
    const advisorOnline = orch.roster?.state?.('claude')?.status === 'online';
    const judge = advisorOnline ? 'claude'
      : participants.includes(flow.strongAgent) ? flow.strongAgent
      : participants.includes(run.initiator) ? run.initiator : participants[0];
    if (judge !== 'claude') orch.store.event?.(run.id, 'negotiate', `顾问暂时连不上，本次修订僵局由 ${judge} 裁决，按真实候选哈希记录`);

    // 只把"仍满足验收与安全边界"的真实候选交给顾问，和候选选择那条路用同一套判定。
    const candidates = [];
    for (const candidate of state.candidates || []) {
      const blockedReasons = candidateIssues(candidate);
      if (!blockedReasons.length && mode === 'parallel') {
        orch.validatePlan(run, candidate.plan);
        if (orch.preflightPlan) {
          const preflight = await orch.preflightPlan(run, candidate.plan);
          if (!Array.isArray(preflight)) throw failure('候选检查预检未返回有效结果，禁止选择执行');
          blockedReasons.push(...preflight.map(issue => issue.problem));
        }
      }
      candidates.push({ candidateId: candidate.candidateId, planHash: candidate.planHash, eligible: !blockedReasons.length, blockedReasons, summary: candidate.summary, origin: candidate.origin, plan: candidate.plan });
    }
    if (!candidates.some(candidate => candidate.eligible)) {
      // 连一个能交付的候选都没有：按原契约失败，但把原因写清楚（这是真实的全线不可交付）。
      return { ok: false, reason: `修订 ${attempts} 次未通过，且现有候选均不满足验收与安全边界` };
    }
    const rulingId = `repair-ruling:${hash(candidates.map(row => [row.candidateId, row.planHash, row.eligible])).slice(0, 12)}`;
    const ruling = await call(rulingId, judge, 'adjudicate', `方案作者连续修订 ${attempts} 次都没有被采纳，需要你裁决这份方案能否交付、以及接下来怎么做。请把评审意见**综合成一份执行参考**，并从以下真实候选中选择（不再要求作者反复重写、也不要求所有评审投票一致）。候选=${JSON.stringify(candidates.map(row => ({ candidateId: row.candidateId, planHash: row.planHash, eligible: row.eligible, blockedReasons: row.blockedReasons, origin: row.origin, summary: row.summary })))}。锁定决策=${JSON.stringify(state.locked)}。剩余意见=${JSON.stringify(issues)}。上次被拒原因=${JSON.stringify(String(attempts?.lastProblem || '').slice(0, 500))}。只能选择 eligible=true 的真实候选；不能新写方案、不能降低或删除任何验收标准、不能覆盖严重安全/资金/不可逆反对。若你认为作者能在不改验收标准的前提下解决，返回 proceed=false 并给出**逐条可执行的修正清单**（fixes），作者会据此再改。返回 {"candidateId":"真实候选编号","planHash":"该候选真实哈希","proceed":true或false,"reason":"具体理由","fixes":["proceed=false 时：作者应按此逐条修正"],"notes":["执行时必须注意的事项"]}。`, 'adjudicate', true, 1500);
    if (ruling.by !== judge || typeof ruling.value.proceed !== 'boolean' || !short(ruling.value.reason, 1000)) {
      return { ok: false, reason: `修订僵局的裁决没有有效答复（应由 ${judge} 本人完成）` };
    }
    const notes = Array.isArray(ruling.value.notes) ? ruling.value.notes.filter(x => short(x, 500)).slice(0, 10) : [];
    state.metrics.repairRuling = { judge, candidateId: ruling.value.candidateId || null, planHash: ruling.value.planHash || null, proceed: ruling.value.proceed, reason: ruling.value.reason, fixes: Array.isArray(ruling.value.fixes) ? ruling.value.fixes.filter(x => short(x, 800)).slice(0, 10) : [], notes, attempts };
    state.metrics.adjudication ||= { requestedJudge: 'claude', actualJudge: judge, reason: judge === 'claude' ? 'advisor' : '顾问暂不可用，由裁决搭档裁决' };

    if (!ruling.value.proceed) {
      const fixes = state.metrics.repairRuling.fixes;
      if (!fixes.length) return { ok: false, reason: `裁决要求继续修订，但没有给出可执行的修正清单：${ruling.value.reason}` };
      save();
      orch.store.event?.(run.id, 'negotiate', `${judge === 'claude' ? '顾问' : judge + ' '}裁定作者可以修好，给出 ${fixes.length} 条具体修正，交 ${author} 继续改（不再新增反复）：${fixes.join('；').slice(0, 300)}`);
      return { ok: true, proceed: false, reason: ruling.value.reason, fixes, judge };
    }

    const selected = candidates.find(candidate => candidate.candidateId === ruling.value.candidateId);
    if (!selected || selected.planHash !== ruling.value.planHash || !selected.eligible || hash(selected.plan) !== selected.planHash) {
      return { ok: false, reason: '顾问选择的方案编号、哈希或安全验收边界无效，尚未批准执行' };
    }
    save();
    return { ok: true, proceed: true, selected, reason: ruling.value.reason, notes, judge };
  };
  const repairPlan = async (issues, id, preflight = false) => {
    const appliedKey = id + (state.repairGeneration ? `:g${state.repairGeneration}` : '');
    if (state.appliedRepairs?.[appliedKey] === hash(state.plan)) return true;
    const prompt = `${planContract}只改有问题的章节=${JSON.stringify(issues)}。原方案=${JSON.stringify(state.plan)}。其余章节和验收标准不得删除或降低，锁定决策=${JSON.stringify(state.locked)}。返回 {"decisions":${JSON.stringify(lockedChoices)},"patches":[{"section":"被指出的精确章节名","value":"该章节的补丁"}],"summary":"方案摘要"}。只返回对应问题章节的补丁，不能新增任务、静默换负责人或更换章节编号。可改章节：${sectionNames()}。未被criterion明确点名的验收逐字保留；被点名的错误项只在原下标纠正，不能删除或降低用户要求。${preflight ? '这些问题在开工前的方案预检就被拒绝了（还没有派发执行、没有跑任何验收）。按问题逐条修：任务缺文件范围就补上它要创建/修改的相对路径（files），只是调研/确认的步骤并入产出任务；检查命令必须能被安全管线运行，改用任务文件范围内的独立测试脚本与注册 node --test 或 node --check；必须真正证明原验收要求，不得删检查、改成只查语法却声称证明行为，或扩大文件权限。原验收text必须原文保留，criterion仅允许更换非法check入口。' : ''}修订后全体重新评审同一哈希，不沿用旧批准。`;
    let lastProblem = '';
    let advisorFixes = null;      // 顾问裁定"作者能修"时给出的逐条修正
    let advisorFixAttempts = 0;   // 依顾问清单再改的次数（上限 2，避免无限往返）
    for (let fix = 0; fix <= 2 + 2; fix++) {
      const generation = state.repairGeneration ? `:g${state.repairGeneration}` : '';
      const extra = advisorFixes ? `\n\n顾问裁定这些必须解决（逐条照办，不得降低验收标准）：${advisorFixes.join('；')}` : '';
      const repaired = await call(id + (fix ? `:fix${fix}` : '') + generation, author, 'repair', prompt + (fix ? `\n\n你上一次的补丁没有被采用：${lastProblem}。请按此修正重新返回完整补丁JSON。` : '') + extra, 'repair', true, 2500);
      try {
        if (repaired.by !== author || !sameDecisions(repaired.value.decisions, state.locked)) throw failure('章节修订偏离锁定决策');
        const next = withGoalBinding(applyPatches(state.plan, repaired.value.patches, issues, mode), repaired.value.goalBinding);
        if (preflight) for (const task of state.plan.tasks) {
          const after = next.tasks.find(row => row.id === task.id);
          if (task.checks?.length && !after?.checks?.length) throw failure('检查命令自纠不能删除原任务的检查');
          for (const item of task.acceptance || []) {
            const text = typeof item === 'string' ? item : item.text;
            if (!after?.acceptance?.some(row => (typeof row === 'string' ? row : row.text) === text)) throw failure('检查命令自纠不能更改或删除原验收文字：' + text);
            if (typeof item === 'object' && item.check && !after.acceptance.some(row => typeof row === 'object' && row.text === text && short(row.check, 300))) throw failure('检查命令自纠必须保留原验收的有效检查入口：' + text);
          }
        }
        if (preflight && state.plan.checks?.length && !next.checks?.length) throw failure('检查命令自纠不能删除原计划的检查');
        const compiled = mode === 'parallel' && orch.compileControlledPlan ? orch.compileControlledPlan(run, next) : next;
        if (mode === 'parallel') orch.validatePlan(run, compiled);
        assertGoalPlan(compiled, goalContract || createGoalContract(run));
        state.plan = compiled;
        if (mode !== 'parallel') state.summaryText = discussionText(state.plan);
        else if (short(repaired.value.summary, 20000)) state.summaryText = repaired.value.summary;
        state.appliedRepairs ||= {}; state.appliedRepairs[appliedKey] = hash(state.plan);
        save(); return true;
      } catch (error) {
        if (repaired.by !== author) { fail(error.message); return false; }
        lastProblem = error.message;
        orch.store.event(run.id, 'negotiate', `${author} 的章节修订没有被采用（${error.message.slice(0, 120)}），已把问题告诉它重改`);
      }

      // ── 三次都改不过：不再判死，交顾问裁决（实测 R181 就是死在这里，25 分钟 0 产出）──
      if (fix >= 2 && !advisorFixes) {
        if (flow.repairAdjudication === false) {
          fail(`${author} 三次修订都没能在保留原有验收标准的前提下解决问题（严格模式 repairAdjudication=false，未请顾问）：${lastProblem}`);
          return false;
        }
        let ruling;
        try {
          ruling = await adjudicateRepairFailure(issues, fix + 1, lastProblem);
        } catch (error) {
          // 顾问这条线自己出错（网络/预算/格式）也要如实失败，不能假装通过。
          fail(`修订僵局交顾问裁决失败：${error.message.slice(0, 200)}`);
          return false;
        }
        if (!ruling.ok) { fail(ruling.reason + `：${lastProblem}`); return false; }
        if (ruling.proceed) {
          // 顾问选定了一个真实候选：按"裁决而非全体通过"继续，照常执行。
          state.plan = structuredClone(ruling.selected.plan);
          state.planHash = ruling.selected.planHash;
          state.summaryText = mode === 'parallel' ? (ruling.selected.summary || state.summaryText) : discussionText(state.plan);
          state.appliedRepairs ||= {}; state.appliedRepairs[appliedKey] = hash(state.plan);
          // 与另一条候选选择路径一致：把最终采用的方案记为候选，恢复/审计时有据可查。
          rememberCandidate(state.plan, ruling.selected.origin || 'repair-ruling', state.summaryText);
          if (mode === 'parallel' && ruling.notes?.length) {
            state.summaryText = `${state.summaryText || ''}\n执行注意（裁决记录）：${ruling.notes.join('；')}`;
          }
          save();
          orch.store.event(run.id, 'negotiate', `修订 ${fix + 1} 次未通过，${ruling.judge === 'claude' ? '顾问' : ruling.judge + ' '}选择 ${ruling.selected.candidateId}（${ruling.selected.planHash.slice(0, 12)}）执行，记录为裁决而非全体评审通过：${ruling.reason.slice(0, 200)}`);
          return true;
        }
        // 顾问说"作者还能修"：拿到逐条清单，继续让它改（最多 2 次）
        advisorFixes = ruling.fixes;
        continue;
      }
      if (advisorFixes && ++advisorFixAttempts >= 2) {
        fail(failureText({
          title: '讨论没有通过，未执行任何任务。',
          reason: `按顾问清单又修改了 ${advisorFixAttempts} 次，评审仍未接受。`,
          next: '把要求写得更具体后重新发起；修改记录和最后一次问题都保留在任务详情里。',
          detail: [`最后一次问题：${lastProblem}`]
        }));
        return false;
      }
    }
    fail(failureText({
      title: '讨论没有通过，未执行任何任务。',
      reason: '方案多次修订后仍未通过评审。',
      next: '把要求写得更具体后重新发起；最后一次评审问题已保留。',
      detail: [`最后一次问题：${lastProblem}`]
    })); return false;
  };
  const finishPendingReview = async () => {
    const pending = state.pendingReviewChange;
    if (!await repairPlan(pending.issues, pending.id)) return false;
    if (pending.autoAttempt) { state.autoContinuations = pending.autoAttempt; state.metrics.autoContinuations = pending.autoAttempt; }
    if (!await preflightPlan()) return false;
    state.planHash = hash(state.plan); state.planVersion++; state.reviewRevision = pending.nextRevision;
    state.pendingReviewChange = null; save(); return true;
  };
  const preflightPlan = async () => {
    assertGoalPlan(state.plan, goalContract || createGoalContract(run));
    if (mode !== 'parallel' || !orch.preflightPlan) return true;
    for (;;) {
      const issues = await orch.preflightPlan(run, state.plan);
      if (!Array.isArray(issues)) throw failure('检查命令预检未返回有效结果，尚未批准执行');
      if (issues.length) { try { orch.store.set('preflightEvidence:' + run.id, { at: new Date().toISOString(), cwd: run.cwd, issues: issues.slice(0, 8), plan: state.plan }); } catch {} }
      if (!issues.length) return true;
      // PDF 的视觉验收无法由 BEAT 独立核验：直接停在开工前，并说清怎么改，而不是让执行者自证两轮后再判死（R408）。
      const renderIssue = issues.find(issue => issue.kind === 'render');
      if (renderIssue) {
        fail(failureText({
          title: '方案里有 BEAT 无法独立核验的 PDF 视觉验收，还没有开工。',
          reason: renderIssue.problem,
          next: '请把验收改成可机器检查的条件后重新发起（例如页数、%PDF- 头、文件大小、sha256 与元数据一致、用测试脚本抽取文本层并确认无替换符）；需要人眼的目视请写在任务说明里由客户人工确认，不要写成自动验收标准。',
        }));
        return false;
      }
      if (issues.some(issue => issue.serious === true)) { fail('计划预检存在严重安全问题，禁止执行'); return false; }
      if ((state.preflightRepairs || 0) >= 2) { fail('方案预检（文件范围或检查命令）两次自动修正后仍有问题，尚未开工；已保留方案与记录。请确认下面的具体问题后继续：' + issues.map(x => `${x.section}：${x.problem}`).join('；')); return false; }
      const attempt = (state.preflightRepairs || 0) + 1;
      orch.store.event(run.id, 'negotiate', `方案预检发现问题（文件范围/检查命令），交 ${author} 只修对应章节（${attempt}/2），不执行或重做任务`);
      if (!await repairPlan(issues, `preflight:${attempt}`, true)) return false;
      state.preflightRepairs = attempt; state.metrics.preflightRepairs = attempt; save();
    }
  };
  if (state.pendingReviewChange && !await finishPendingReview()) return result();
  if (!state.planHash) {
    const expanded = await call('expand', author, 'expand', prefix + `只展开一份完整方案，不改变锁定决策=${JSON.stringify(state.locked)}。decisions 必须包含每一个锁定编号及选项原文（包含额外决策），不得遗漏。返回 {"summary":"${mode === 'parallel' ? '完整方案摘要' : '简短方案概览'}","decisions":${JSON.stringify(lockedChoices)},${mode !== 'parallel' ? '"sections":' + JSON.stringify(discussionSections) + ',' : ''}"plan":${mode === 'parallel' ? JSON.stringify(planSchema) : 'null'}}。${mode !== 'parallel' ? '完整讨论方案必须按 sections 分章节展开；每章给稳定、唯一的英文 id、中文 title 和完整 content，不把所有正文塞进 summary。可增加必要章节，之后保持编号不变。' : planContract}${automaticCriteria}任务有真实数据依赖就排队；仅共享父目录不构成数据依赖，可各自幂等创建目录再独占创建文件。仅互不依赖且文件范围不冲突才并行，不为核验凭空增设生产任务；按路径和摘要传递产物。eligibleWorkers 只在“必须是某位搭档”时填（例如电脑操作或看图必须用有桌面/视觉能力的那一方），ID 必须来自本次参与搭档；不填就由控制器按难度和当前成本路由，客户设置的轻量/强搭档限制优先。`, 'expand', true, mode === 'parallel' ? 4000 : 2200);
    if (expanded.by !== author || !short(expanded.value.summary, 20000) || !sameDecisions(expanded.value.decisions, state.locked)) return fail('展开方案偏离锁定决策，尚未批准执行');
    // 顶层 goalBinding 是评审契约的一部分（goalContractPrompt 要求），必须原样保留：
    // R369 实测只取 summary/decisions/sections，把作者答复里的 goalBinding 丢掉，评审每轮都判"缺少 goalBinding"，
    // 而返工只能改章节，永远补不回来 → 同一意见连续三轮、2 次自动接续后失败，0 答案。
    state.plan ||= mode === 'parallel' ? withGoalBinding(parsePlan(expanded.value.plan), expanded.value.goalBinding) : { ...(expanded.value.goalBinding ? { goalBinding: expanded.value.goalBinding } : {}), summary: expanded.value.summary, decisions: expanded.value.decisions, ...(expanded.value.sections !== undefined ? { sections: expanded.value.sections.map(({ id, title, content }) => ({ id, title, content })) } : {}) };
    if (mode === 'parallel') { if (!state.plan) return fail('完整方案缺少有效的小任务和验收标准'); if (orch.compileControlledPlan) state.plan = orch.compileControlledPlan(run, state.plan); orch.validatePlan(run, state.plan); }
    state.summaryText ||= mode === 'parallel' ? expanded.value.summary : discussionText(state.plan);
    if (mode === 'parallel') { try { orch.store.set('planChecks:' + run.id, { planChecks: state.plan.checks || [], tasks: (state.plan.tasks || []).map(t => ({ id: t.id, owner: t.owner, checks: t.checks || [] })), at: new Date().toISOString() }); } catch {} }
    if (!await preflightPlan()) return result();
    state.planHash = hash(state.plan); state.planVersion++; save();
  }
  // 评审是否真的批准了方案：循环因轮次上限退出时必须据此失败，不能把"没批准"当成通过。
  let approved = false;
  if (flow.planReview !== false) {
    // 自己不可用、只能由别人代答的搭档：按"掉线就跳过"处理，不再等它的本人答复，
    // 也不让它把整轮评审卡在"缺少本人答复"（用户规则；与讨论循环里的跳过同一套记录）。
    const skippedSeats = () => (orch.store.get('discussionSkipped:' + run.id) || []).map(row => row.agent);
    const markSeatSkipped = skipSeat;
    const reviewers = participants.filter(x => x !== author && !skippedSeats().includes(x));
    // 手动「继续」会给一次新的修订额度；因此评审轮次不能再用固定的 3 轮硬截断，
    // 但必须有硬上限，防止模型/缓存异常时无限往返烧钱。
    for (let revision = state.reviewRevision || 0; revision <= 8; revision++) {
      const reviewedHash = state.planHash;
      const currentCandidate = rememberCandidate(state.plan, revision ? `repair:${revision}` : 'expand');
      const sectionNames = mode === 'parallel' ? 'tasks.<稳定任务id或下标>、checks、acceptance、goalBinding' : state.plan.sections ? 'goalBinding（目标绑定）、sections.<稳定章节id> 或 summary（概览）' : 'goalBinding（目标绑定）或 summary（旧版完整正文）';
      const reviewContract=mode==='parallel'?'本阶段只评审计划，不运行实际验收。执行阶段由控制器先运行已注册的检查，再调度非执行搭档只读核对剩余语义验收；这项框架保证无需在tasks内重复建核验任务。请核对任务本身的输入输出路径、依赖、文件范围和验收标准是否充分且明确；不能用语法通过替代内容或行为通过。还要检查验收与产出的可核验性：需要看图/渲染/逐页目视的验收，必须由产出该页面的任务自己提供可渲染文件（HTML/SVG/图片）或机器检查，不能把渲染检查留给依赖它的任务（R408 实测：task-2 验收要看页面、渲染却在依赖它的 task-3，形成死锁卡住整轮）。如果某条验收标准本身有错误或违背目标，issues必须附criterion（该章节acceptance数组从0开始的错误项下标），才能纠正该项；不得借此删除或降低用户要求。':'';
      const reviewersNow = participants.filter(x => x !== author && !skippedSeats().includes(x));
      // 评审 id 带上修订代次：手动继续/返工后必须重新问模型，不能命中上一代方案的旧评审答复。
      const reviewGeneration = state.repairGeneration || 0;
      const settledReviews = await settleSeats(reviewersNow, seat => call(`review:${revision}:g${reviewGeneration}:${seat}`, seat, 'review', `只短评审同一方案 hash=${reviewedHash}。${reviewContract}方案=${JSON.stringify(state.plan)}。锁定决策=${JSON.stringify(state.locked)}。只返回 {"planHash":"${reviewedHash}","verdict":"pass|fail","issues":[{"section":"具体章节/任务ID","problem":"具体问题","serious":false}]}。serious=true 仅用于严重安全、资金或不可逆问题。验收里原有标准与其后追加的更明确版本并存是有意保留（原文不可删），不要当作重复问题。section 必须精确写 ${sectionNames}。通过时 issues=[]。不得重写方案。`, 'review', true, 900));
      // 预算中断这类"钱没了"必须大声失败，不能降级成缺席（既有契约）；
      // 只有"这位席位确实联系不上"（掉线/超时/连接失败）才按缺席继续。
      const budgetStopped = settledReviews.failures.find(x => x.error?.code === 'CONTROL_BUDGET_EXCEEDED');
      if (budgetStopped) throw budgetStopped.error;
      const hardReviewFailures = settledReviews.failures.filter(x => !seatUnavailable(x.error));
      if (hardReviewFailures.length) throw hardReviewFailures[0].error;
      // 掉线/超时的席位按缺席处理：先把它记进跳过名单（后续轮次不再问它），再按有效席位判定，
      // 而不是因为一位没答复就把整轮评审作废。
      for (const row of settledReviews.missing) markSeatSkipped(row.seat, `本轮评审没有本人答复（${row.reason}）`);
      const reviews = settledReviews.records;
      // 掉线那位的席位由别人代答：跳过它（记进跳过名单，后续轮次不再问它），其余本人答复才是批准依据。
      const substituted = reviews.filter(x => x.by !== x.seat);
      for (const row of substituted) markSeatSkipped(row.seat, '评审阶段只能由别的搭档代答');
      // R413 实测：有席位只能由别人代答时，旧代码把它记进"跳过"，却仍按原人数算门槛，
      // 得到"有效 1 票，需 2 票"直接把整轮判死。门槛必须按"还能本人答复的席位"重算。
      const remainingReviewers = reviewersNow.filter(seat => !skippedSeats().includes(seat));
      const quorum = reviewQuorum({ participants: remainingReviewers, records: reviews, missing: settledReviews.missing.filter(row => remainingReviewers.includes(row.seat)) });
      const selfReviews = quorum.self;
      // 有效席位与缺席情况写进时间线：买家要能看见"谁没到、为什么这一轮还算数"。
      orch.store.event?.(run.id, 'negotiate', `${quorum.note}；本轮评审对象=${reviewersNow.join('、')}；收到答复=${reviews.map(x => x.seat).join('、') || '（无）'}`);
      if (selfReviews.some(x => x.value.planHash !== reviewedHash)) return fail('评审版本不一致（方案在同一轮内被改动），尚未批准执行');
      if (!quorum.ok) return fail(quorum.failureMessage);
      rememberCandidate(state.plan, currentCandidate.origin);
      const issues = selfReviews.filter(x => x.value.verdict === 'fail').flatMap(x => x.value.issues);
      // pass + 非严重备注：记进时间线让买家看得见，但不阻塞、不触发返工（issues 只收 fail 的）。
      // 注意：这里是模块级函数，this 是 undefined —— 用注入的 orch，别用 this.store（R179 实测崩过）。
      const reviewNotes = selfReviews.flatMap(x => (x.value.notes || []).map(note => ({ reviewer: x.seat, ...note })));
      if (reviewNotes.length) {
        const key = 'reviewNotes:' + run.id;
        orch.store.set(key, [...(orch.store.get(key) || []), { revision, at: new Date().toISOString(), notes: reviewNotes }]);
        orch.store.event?.(run.id, 'negotiate', `评审备注 ${reviewNotes.length} 条（不阻塞）：${reviewNotes.map(n => `${n.section}：${n.problem}`).join('；').slice(0, 400)}`);
      }
      if (!issues.length) { approved = true; break; }
      if (revision >= 1) {
        // 再审一轮后仍有意见：不继续拉锯，交顾问裁决这些意见是否挡住执行。严重安全/资金/不可逆问题不能被裁过。
        const serious = issues.filter(x => x.serious === true);
        if (serious.length) return fail(failureText({
          title: '讨论没有通过，未执行任何任务。',
          reason: '评审提出了严重安全、资金或不可逆问题，修订后仍未解决；按规则这类问题不能被自动修订或多数票覆盖。',
          next: '先解决这些风险再重新发起；严重问题原文已保留在任务详情里。',
          detail: ['严重问题：\n' + serious.map(x => `- ${x.section}：${x.problem}`).join('\n')]
        }));
        if (flow.reviewAdjudication === false) return fail('一次章节修订后仍有评审问题，已停止自动返工');
        const passCount = selfReviews.filter(x => x.value.verdict === 'pass').length;
        const advisorOnline = orch.roster?.state?.('claude')?.status === 'online';
        const judge = advisorOnline ? 'claude' : participants.includes(flow.strongAgent) ? flow.strongAgent : participants.includes(run.initiator) ? run.initiator : participants[0];
        if (judge !== 'claude') orch.store.event(run.id, 'negotiate', `顾问暂时连不上，本次最佳方案选择由 ${judge} 裁决，按真实候选哈希记录`);
        const candidates = [];
        for (const candidate of state.candidates) {
          const blockedReasons = candidateIssues(candidate);
          if (!blockedReasons.length && mode === 'parallel') {
            orch.validatePlan(run, candidate.plan);
            if (orch.preflightPlan) {
              const preflight = await orch.preflightPlan(run, candidate.plan);
              if (!Array.isArray(preflight)) throw failure('候选检查预检未返回有效结果，禁止选择执行');
              blockedReasons.push(...preflight.map(issue => issue.problem));
            }
          }
          candidates.push({ ...candidate, eligible: !blockedReasons.length, blockedReasons });
        }
        if (!candidates.some(candidate => candidate.eligible)) return fail(failureText({
          title: '讨论没有通过，未执行任何任务。',
          reason: '现有候选方案都不满足验收或安全边界。',
          next: '补充必要信息，或调整确实无法满足的边界后重新发起。',
          detail: candidates.map(candidate => `${candidate.candidateId}：${(candidate.blockedReasons || []).join('；') || '未知原因'}`)
        }));
        // A new call identity deliberately bypasses cached pre-2.2.16 rulings that
        // contained only proceed. Such rulings never prove which plan was chosen.
        const rulingId = `review-selection:${revision}:${hash(candidates.map(row => [row.candidateId, row.planHash, row.eligible])).slice(0, 12)}`;
        const ruling = await call(rulingId, judge, 'adjudicate', `两轮计划评审仍未通过（当前 ${passCount}/${selfReviews.length} 位评审通过）。请把四家的评审意见**综合成一份执行参考**，并从以下真实已展开/修订候选中选出最适合交付的方案，不再要求所有评审投票一致。候选=${JSON.stringify(candidates)}。锁定决策=${JSON.stringify(state.locked)}。当前方案=${JSON.stringify(state.plan)}。剩余意见=${JSON.stringify(issues)}。必须明确选择一个 eligible=true 的 candidateId 和对应 planHash；不能写新方案、不能降低验收、不能覆盖严重安全/资金/不可逆反对。只阻止会导致交付错误、违背用户目标或无法验收的问题；措辞、冗余、可移植性可作为执行注意事项。若所有可选方案仍不能交付，选择其中最佳但 proceed=false，并说明必须局部修正的问题。返回 {"candidateId":"真实候选编号","planHash":"该候选真实哈希","proceed":true或false,"reason":"选择此方案及是否可执行的具体理由","notes":["综合四家意见后，执行时必须注意的事项，可为空"]}。顾问只选择，不修改文件；实际执行交给执行搭档。`, 'selection', true, 1500);
        if (ruling.by !== judge || typeof ruling.value.proceed !== 'boolean' || !short(ruling.value.reason, 1000)) return fail('评审意见的裁决没有有效答复，尚未批准执行');
        const selected = candidates.find(candidate => candidate.candidateId === ruling.value.candidateId);
        if (!selected || selected.planHash !== ruling.value.planHash || !selected.eligible || hash(selected.plan) !== selected.planHash) return fail('顾问选择的方案编号、哈希或安全验收边界无效，尚未批准执行');
        state.metrics.reviewRuling = { judge, candidateId: selected.candidateId, planHash: selected.planHash, proceed: ruling.value.proceed, reason: ruling.value.reason, notes: Array.isArray(ruling.value.notes) ? ruling.value.notes.filter(x => short(x, 500)).slice(0, 10) : [], passCount, reviewers: selfReviews.length };
        state.selectionHistory ||= [];
        if (!state.selectionHistory.some(row => row.callId === rulingId)) state.selectionHistory.push({ callId: rulingId, ...state.metrics.reviewRuling });
        state.metrics.candidateSelection = { ...state.metrics.reviewRuling, candidateCount: candidates.length, selectionCount: state.selectionHistory.length };
        state.metrics.adjudication ||= { requestedJudge: 'claude', actualJudge: judge, reason: judge === 'claude' ? 'advisor' : '顾问暂不可用，由裁决搭档裁决' };
        save();
        if (!ruling.value.proceed) {
          if ((state.autoContinuations || 0) >= 2) {
            // 记下这次未解决的意见：客户下次点「继续」时据此只重做这一步，
            // 而不是原样复放旧方案（R542 实测客户连点 12 次都没动过文件）。
            state.lastIssues = structuredClone(issues || []);
            state.lastReviewRevision = state.reviewRevision || revision;
            save();
            const candidateRows = (state.candidates || []).map(candidate => {
              const total = (candidate.reviews || []).length;
              const passed = (candidate.reviews || []).filter(row => row.verdict === 'pass').length;
              return total ? `${candidate.candidateId}：评审 ${passed}/${total} 通过` : `${candidate.candidateId}：尚未完成评审`;
            });
            const issueRows = (issues || []).map(issue => `- ${issue.section}：${issue.problem}`);
            return fail(failureText({
              title: '讨论没有通过，未得出可执行结论，也没有改动任何文件。',
              reason: `方案经过自动修订后仍有 ${issues.length} 条评审意见没有解决；继续自动重试不会改变结果，系统已停止。`,
              next: '把要解决的问题和验收标准写得更具体后重新发起；本轮候选方案和全部评审记录都保留在任务详情里，可直接查看。',
              detail: [
                '系统记录：两次自动接续后仍未通过，已停止追加调用。',
                candidateRows.length ? '候选方案：\n' + candidateRows.join('\n') : '',
                issueRows.length ? '未解决意见：\n' + issueRows.join('\n') : '',
                `顾问裁定原话：\n${ruling.value.reason}`
              ]
            }));
          }
          const attempt = (state.autoContinuations || 0) + 1;
          state.pendingReviewChange = { autoAttempt: attempt, nextRevision: revision + 1, issues: issues.map(issue => ({ ...issue, problem: issue.problem + '；裁决说明：' + ruling.value.reason })), id: `continue:${attempt}` }; save();
          orch.store.event(run.id, 'negotiate', `复审未通过，交 ${author} 按具体问题自动接续修订（${attempt}/2）；已完成的提纲与投票保留`);
          if (!await finishPendingReview()) return result();
          continue;
        }
        approved = true;
        state.plan = structuredClone(selected.plan); state.planHash = selected.planHash;
        state.summaryText = mode === 'parallel' ? selected.summary || state.summaryText : discussionText(state.plan);
        if (selected.planHash !== reviewedHash) state.planVersion++;
        orch.store.event(run.id, 'negotiate', `两轮评审仍有意见，${judge === 'claude' ? '顾问' : judge + ' '}选择最佳候选 ${selected.candidateId}（${selected.planHash}）执行，记录为裁决而非全体评审通过：${ruling.value.reason}`);
        if (mode === 'parallel' && state.metrics.reviewRuling.notes.length) state.summaryText = `${state.summaryText || ''}\n执行注意（裁决记录）：${state.metrics.reviewRuling.notes.join('；')}`;
        break;
      }
      state.pendingReviewChange = { issues, id: 'repair', nextRevision: 1 }; save();
      if (!await finishPendingReview()) return result();
    }
  }
  // 顾问综合四家答案整理出的执行参考：随交付内容一起交给下一步（执行）。只加参考，不动任何已锁定决策。
  const advisorReference = state.metrics.adjudication?.reference;
  if (advisorReference && !String(state.summaryText || '').includes(advisorReference)) {
    state.summaryText = `${state.summaryText || ''}\n\n顾问综合参考（四家答案合并）：${advisorReference}`;
    orch.store.event?.(run.id, 'negotiate', '顾问综合参考已随交付内容一起交给执行步骤');
  }
  // 走到这里还没有 approved，说明评审轮次超过硬上限；不能把"没批准"当成通过。
  if (flow.planReview !== false && !approved) return fail(failureText({
    title: '讨论没有通过，未执行任何任务。',
    reason: '方案修改轮次超过上限仍未通过评审（可能是评审意见互相冲突或方案结构性问题）。',
    next: '把要解决的问题写具体后重新发起；本轮全部候选、评审意见和修改记录都保留在任务详情里。',
    detail: [(state.lastIssues || []).length ? '最后未解决意见：\n' + state.lastIssues.map(issue => '- ' + issue.section + '：' + issue.problem).join('\n') : ''],
  }));
  assertGoalPlan(state.plan, goalContract || createGoalContract(run));
  state.consensus = true; state.finished = true;
  save(); return result();
}

function sameDecisions(value, locked) {
  return value && Object.entries(locked).every(([id, d]) => typeof value[id] === 'string' && canonical(value[id]) === canonical(d.option));
}

function validateSections(sections) {
  if (!list(sections, 24) || !sections.length) throw failure('完整方案章节必须是非空列表');
  const ids = new Set(); let characters = 0;
  for (const section of sections) {
    if (!section || !safeId(section.id) || ids.has(section.id) || !short(section.title, 200) || !short(section.content, 20000)) throw failure('完整方案章节缺少稳定编号、标题或正文，或编号重复');
    ids.add(section.id); characters += section.title.length + section.content.length;
  }
  if (characters > 30000) throw failure('完整方案章节过长，请保持单份方案简洁');
}

function discussionText(plan) {
  return plan.sections?.length ? [plan.summary, ...plan.sections.map(section => section.title + '\n' + section.content)].filter(Boolean).join('\n\n') : plan.summary;
}

function preserveAcceptance(original, replacement, corrected=[]) {
  if (!list(replacement, 64) || !replacement.every(item => short(item, 2000) || item && typeof item === 'object' && !Array.isArray(item) && short(item.text, 2000))) throw failure('验收章节必须给出明确的标准列表');
  if(corrected.length&&replacement.length<(original||[]).length)throw failure('被指出的错误验收项必须在原位置纠正，不能删除标准');
  if(corrected.length&&(original||[]).some((item,index)=>!corrected.includes(index)&&JSON.stringify(item)!==JSON.stringify(replacement[index])))throw failure('纠正验收项时未被点名的标准必须保持原位置和原内容');
  const dropped = (original || []).filter((item,index) => !replacement.some(next => JSON.stringify(next) === JSON.stringify(item)) && !(corrected.includes(index)&&replacement[index]!==undefined));
  if (dropped.length) throw failure('章节修订不能删除、替换或降低未被评审明确指出错误的验收标准；以下原有标准必须逐字保留：' + JSON.stringify(dropped));
}

// 评审没点名具体错误项时，作者改写的标准不替换原文：原有标准逐字保留，改写后的更明确版本追加在后，
// 只会更严、不会降低；这样不再因“改写了一条”卡死整个任务。点名纠正的仍走严格校验。
function mergeAcceptance(original, replacement, corrected = []) {
  if (corrected.length) { preserveAcceptance(original, replacement, corrected); return [...replacement]; }
  if (!list(replacement, 64) || !replacement.every(item => short(item, 2000) || item && typeof item === 'object' && !Array.isArray(item) && short(item.text, 2000))) throw failure('验收章节必须给出明确的标准列表');
  const merged = [...(original || [])];
  for (const item of replacement) if (!merged.some(old => JSON.stringify(old) === JSON.stringify(item))) merged.push(item);
  if (merged.length > 64) throw failure('验收标准过多，请合并重复要求');
  return merged;
}

function applyPatches(plan, patches, issues, mode) {
  if (!list(patches, 20) || !patches.length) throw failure('章节修订未返回有效补丁');
  const flagged = new Set(issues.map(x => x.section));
  const next = structuredClone(plan), touched = new Set();
  for (const patch of patches) {
    // 返工范围放宽（客户决定）：允许连带修改相关章节，只要被指出的问题都改到了。
    // 验收标准仍然逐字保留、不许降低——那由 preserveAcceptance / mergeAcceptance 把关。
    if (!patch || !patch.section || touched.has(patch.section)) throw failure('章节补丁重复修改同一章节或缺少章节名');
    touched.add(patch.section);
    if (mode !== 'parallel' && patch.section === 'summary' && short(patch.value, 20000)) next.summary = patch.value;
    // 顶层目标绑定也允许在返工里补/改一次：否则评审一旦指出它，作者没有任何补丁路径能修好（R369 死循环）。
    else if (patch.section === 'goalBinding' && patch.value && typeof patch.value === 'object' && !Array.isArray(patch.value)) next.goalBinding = patch.value;
    else if (mode !== 'parallel' && /^sections\.[a-z][a-z0-9_-]{0,63}$/i.test(patch.section)) {
      const id = patch.section.slice(9), index = next.sections?.findIndex(section => section.id === id);
      if (index === undefined || index < 0) throw failure('章节补丁找不到对应的稳定章节编号');
      const old = next.sections[index];
      // 模型常把整章正文直接当字符串给（而不是 {content:...}）：按"只替换这一章正文"接受，编号和标题不动。
      const value = typeof patch.value === 'string' ? { content: patch.value } : patch.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('章节补丁找不到对应的稳定章节编号');
      const keys = Object.keys(value);
      if (!keys.length || keys.some(key => !['id', 'title', 'content'].includes(key)) || Object.hasOwn(value, 'id') && value.id !== old.id) throw failure('章节修订只能改该章节的标题和正文，不能更换编号或其他章节');
      next.sections[index] = { ...old, ...value };
      validateSections(next.sections);
    }
    else if (mode === 'parallel' && patch.section === 'checks') {
      if (!list(patch.value, 5) || !patch.value.every(command => short(command, 300))) throw failure('检查章节必须是最多5条有效检查命令的列表');
      next.checks = [...patch.value];
    }
    else if (mode === 'parallel' && patch.section === 'acceptance') {
      if (!patch.value.every(item => typeof item === 'string')) throw failure('整体验收章节必须逐条保留明确的文字标准');
      next.acceptance = mergeAcceptance(next.acceptance, patch.value, issues.filter(x=>x.section===patch.section&&Number.isInteger(x.criterion)).map(x=>x.criterion));
    }
    else if (mode === 'parallel' && /^tasks\.[\w-]+$/.test(patch.section)) {
      const id = patch.section.slice(6), index = next.tasks.findIndex((x, i) => x.id === id || String(i) === id);
      // 同上一章的宽容：任务补丁直接给字符串时按"改这个任务的说明"处理。
      const raw = typeof patch.value === 'string' ? { detail: patch.value } : patch.value;
      if (index < 0 || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('章节补丁找不到对应任务');
      const old = next.tasks[index];
      if (raw.owner && raw.owner !== old.owner || raw.id && raw.id !== old.id) throw failure('章节修订不能静默更换任务负责人或编号');
      const value = Object.hasOwn(raw, 'acceptance') ? { ...raw, acceptance: mergeAcceptance(old.acceptance, raw.acceptance, issues.filter(x=>x.section===patch.section&&Number.isInteger(x.criterion)).map(x=>x.criterion)) } : raw;
      next.tasks[index] = { ...old, ...value };
    } else throw failure('章节修订只能修改被指出的任务、检查、验收或具体方案章节，已停止越界修改');
  }
  // 放宽范围不等于可以不改被指出的地方：点名的问题必须都被处理。
  const missed = [...flagged].filter(section => !touched.has(section));
  if (missed.length) throw failure('章节修订没有处理被指出的问题：' + missed.join('、'));
  if (mode === 'parallel') { const normalized = parsePlan(next); if (!normalized) throw failure('章节修订产生无效任务方案'); return withGoalBinding(normalized, next.goalBinding); }
  return next;
}
