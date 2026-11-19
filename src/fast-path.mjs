// 免协商快路径（用户裁决第 3 条）：判据**不是"任务小"**，而是"这份工作的验收能不能被机器证据完全证明"。
// 能证明 → 直接"一人执行 + BEAT 在沙箱外跑验收"，跳过四家提纲/投票/定稿/多轮评审；
// 不能证明（需要语义判断、有接口协商、跨任务依赖）→ 老实走原流程。
// 本模块只做纯判定与方案构造，不碰存储、不调模型，便于单测。
//
// 注意：快路径省的是"意见交换"，**不是验收**——任务照样进队列、照样跑自动检查、照样由非执行方复核，
// 该判 fail 一样判 fail。这条纪律不允许因为"快"而放松。

// 命令是否"被产品明确支持"，而不是靠猜：测试输出里带真实退出码才算证据。
// 必须有词边界，否则"验收："里的 "收:" 之类会被误当成 node（实测踩过：命令被切成 "：node --check x.mjs"）。
// 也认 `node 某脚本.js …`（用户常写"跑一下看输出"），它同样会过 preflight 与 bounded 路径边界。
export const FAST_PATH_COMMAND_HINT = /\b(?:node\s+--test|node\s+--check|node\s+[\w./\\-]+\.(?:mjs|cjs|js)|python3?\s+-m\s+(?:unittest|py_compile|pytest)|pytest\b|npm\s+test\b)/i;

/** 看起来像"文件路径"吗：带扩展名或落在 tests/test 目录下。用来挡住把中文说明当文件名。 */
export function looksLikePath(text) {
  const value = String(text || '').trim().replaceAll('\\', '/');
  if (!value || /\s/.test(value)) return false;
  if (/\.(?:mjs|cjs|js|ts|json|md|txt|py|html|css)$/i.test(value)) return true;
  return /^(?:tests?|__tests__)\//i.test(value);
}

/** 目标里是否点名了"可运行的测试文件"（用于推断自证契约）。 */
export function namedTestFiles(goal) {
  const out = [];
  for (const match of String(goal || '').matchAll(/[A-Za-z0-9_][A-Za-z0-9_./\\-]*\.(?:test|spec)\.(?:mjs|cjs|js|ts)/gi)) {
    const value = match[0].replaceAll('\\', '/');
    if (!value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.includes('..') && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * 用真实解析器把"抽出来的文字"变成"可执行的规范命令"——本模块最关键的一步：
 * 抠出来的字符串不算数；只有 registeredCheckFor 能解析、且解析出的文件参数**看起来像路径**的才留下。
 * 这一条堵住两个实测假阳性：①"node --test 测试，测试"被当成命令；②"… util.mjs 验证语法" 这种尾巴。
 */
export function canonicalizeChecks(candidates, { cwd, parse }) {
  const kept = [], dropped = [];
  for (const candidate of candidates || []) {
    let parsed = null;
    try { parsed = parse(cwd, candidate, 0, { allowMissing: true }); }
    catch (error) { dropped.push({ candidate, reason: String(error.message || error).slice(0, 120) }); continue; }
    const files = [
      ...(parsed?.files || []),
      ...(parsed?.file ? [parsed.file] : []),
      ...((parsed?.args || []).filter(a => /[./\\]/.test(String(a)) && !String(a).startsWith('-'))),
    ];
    const suspicious = files.filter(file => !looksLikePath(file));
    if (suspicious.length) { dropped.push({ candidate, reason: '解析出的文件参数不像路径：' + suspicious.join('、') }); continue; }
    kept.push({ command: candidate, parsed });
  }
  return { kept, dropped };
}

/** 从命令与目标文本里推断"这次要产出的文件"——队列要求每个文件任务必须划定范围。 */

export function inferFileScope(commands = [], goal = '') {
  const files = [];
  const add = raw => {
    const value = String(raw || '').trim().replace(/^["']|["']$/g, '').replaceAll('\\', '/');
    if (!value || value.length > 120) return;
    if (/[;&|<>`$%*?{}\[\]()]/.test(value)) return;      // 通配符/拼接/危险字符不进范围
    if (value.includes('..')) return;                     // 上跳不进范围（文件范围只写工作目录内相对路径）
    if (/^(?:[A-Za-z]:|\/)/.test(value)) return;          // 绝对路径不进范围
    if (!/\.(?:mjs|cjs|js|ts|json|md|txt|py|html|css)$/i.test(value)) return;
    if (/^(?:node|python3?|pytest|npm)$/i.test(value)) return;
    if (!files.includes(value)) files.push(value);
  };
  // ① 验收命令里出现的文件
  for (const command of commands) {
    for (const token of String(command).split(/\s+/).slice(1)) add(token);
  }
  // ② 目标文本里带扩展名的产出文件名（"交付 wordstat.mjs 与 tests/wordstat.test.mjs、README.md"）
  //    注意必须把 .py 等常见源码后缀也算进来：R172 实测目标写了 beautify.py，但这里漏了 py，
  //    文件范围只剩 tests/test_beautify.py → 执行者写主脚本反而被判"越界"，白跑三轮。
  for (const match of String(goal || '').matchAll(/[A-Za-z0-9_][A-Za-z0-9_./\\-]*\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|txt|py|html|css|yml|yaml|ps1|sh|bat|cfg|ini|toml)/g)) add(match[0]);
  // ③ 工具自己的产物目录：装依赖/跑测试/打包会写 .venv、__pycache__、.pytest_cache、.cache、
  //    dist、build、.build、node_modules 等。这些不是"乱写"，是正常副作用——R171 的 PyInstaller
  //    把 .build\cache\… 写出来后被判"范围外改动"整轮隔离，就死在这里。显式纳入范围。
  const toolDirs = ['.venv', 'venv', '__pycache__', '.pytest_cache', '.cache', '.mypy_cache', '.ruff_cache', 'node_modules', 'dist', 'build', '.build', 'out', 'target', 'coverage'];
  for (const dir of toolDirs) {
    if (new RegExp('(?:^|[\\\\/])' + dir.replace('.', '\\.') + '(?:[\\\\/]|$)', 'i').test(String(goal || ''))) { if (!files.includes(dir + '/**')) files.push(dir + '/**'); }
  }
  // 只要目标里出现"打包/构建/安装依赖"这类动作，就把常见产物目录一并放开，避免产物把任务锁死。
  if (/(pyinstaller|打包|构建|编译|install|build|pip|npm|yarn|pnpm)/i.test(String(goal || ''))) {
    for (const dir of ['dist/**', 'build/**', '.build/**', '__pycache__/**', '.cache/**', '.venv/**', 'node_modules/**']) if (!files.includes(dir)) files.push(dir);
  }
  return files;
}

/** 候选命令里出现非 ASCII（中文说明）的，一律不当命令——"pytest 写）"这种是句子，不是命令。 */
function looksLikeProse(command) {
  return /[^\x00-\x7F]/.test(String(command || ''));
}

export function extractCheckCommands(goal) {
  const text = String(goal || '');
  // 命令可能和说明写在同一行（"交付 ok.mjs。验收：node --check ok.mjs"）：取**第一个已支持程序**出现的位置起算。
  // 用户还常在命令后面接一句验收要求（"… 退出码 0"），这些不是命令的一部分。
  const TRAILING_PROSE = /[\s，,。；;:：]*[（(]?\s*(?:退出码|返回码|exit\s*code|结果|输出|要求|期望|必须|应当|应为|全绿|通过|成功)[^）)]*[）)]?\s*$/i;
  const commands = [];
  // 中文分号/句号是"句子分隔"，不是命令拼接（用户的写法差异，不是要跑串联命令）。
  // 英文 ; 仍然留在片段里交给下面的拼接拦截处理（那也是真的 shell 串联）。
  const segments = String(text).split(/\r?\n/).flatMap(line => String(line).split(/[；。]/));
  for (const segment of segments) {
    const at = segment.search(FAST_PATH_COMMAND_HINT);
    if (at < 0) continue;
    if (/(?:不要|禁止|不用|不执行|不运行)\s*(?:执行|运行|使用)?\s*$/.test(segment.slice(0, at))) continue;
    const candidate = segment.slice(at)
      .replace(/[，,]+$/, '')
      .replace(TRAILING_PROSE, '')
      .replace(/[，,\s、]+$/, '')
      .trim();
    if (!candidate || candidate.length > 200) continue;
    if (!FAST_PATH_COMMAND_HINT.test(candidate)) continue;
    if (looksLikeProse(candidate)) continue;         // 中文说明不是命令（"pytest 写）"这种）
    if (/[;&|<>`$%]/.test(candidate)) continue;      // 拼接一律不进快路径（交给原流程与检查通道拦）
    if (!commands.includes(candidate)) commands.push(candidate);
  }
  return commands;
}

/** 把目标文本里"没有明确命令"的验收项摘出来；摘不出就返回空（表示该项由机器证据覆盖不了）。 */
export function acceptanceFromCommands(commands, goal) {
  return (commands || []).map(command => ({ text: `按验收命令核验：${command}`, check: command }));
}

// 目标里"机器证不了"的交付要求：使用说明、注释、示例、命名规范…
// 这些以前会被快路径整条丢掉（R177 实测：要求"交付一份简短的使用说明"，最终没交，BEAT 还判 pass）。
// 现在把它们补成**文字验收项**：机器检查覆盖不到，就由非执行者在核验阶段逐条复核（queue-runner 本来就有这条路）。
const TEXT_REQUIREMENTS = [
  { re: /使用说明|使用文档|说明书|使用手册|使用指南|readme/i, file: 'README.md', text: '交付一份简短的使用说明（写明每个命令/接口的用法）' },
  { re: /文档（?注释|说明）|注释说明|代码注释|\/\/\s*注释/, file: null, text: '代码里要有必要的注释/文档说明' },
  { re: /示例|样例|用例示范/, file: null, text: '给出可直接照抄的使用示例' },
  { re: /目录结构|文件布局|项目结构/, file: null, text: '说明目录结构与各文件职责' },
  { re: /配置(说明|文件|项)/, file: null, text: '说明配置项与默认值' },
];

/** 从目标里摘出"机器证不了"的交付要求（去重、限量），并给出它们通常对应的产物文件。 */
export function goalTextRequirements(goal) {
  const text = String(goal || '').split(/[。；;，,\n]/).filter(clause => !/^\s*(?:请)?(?:不要|禁止|不用|不需要)/.test(clause)).join('。');
  const out = [];
  for (const item of TEXT_REQUIREMENTS) {
    if (!item.re.test(text)) continue;
    if (out.some(row => row.text === item.text)) continue;
    // 用例示范/目录结构这类如果已经被"使用说明"覆盖，不再重复列
    if (out.some(row => row.file && item.file && row.file === item.file)) continue;
    out.push(item);
  }
  return out.slice(0, 4);
}

/**
 * 能不能走快路径。**全部条件都必须是"客观可核对"的**：
 *  - 有 ≥1 条机器可验的检查命令（由上游用 preflight/registeredCheckFor 判定，这里只数数）；
 *  - 验收项**全部**挂到了检查命令上（只要有一条靠人/模型判断，就不算"机器可全证"）；
 *  - 任务数量 = 1 且只有一个执行方（不需要跨任务接口协商）；
 *  - 检查命令全部预检通过（由上游传入的结果决定）。
 * @param {{tasks?:Array, acceptance?:Array, checks?:Array}} plan
 * @param {{registered?:boolean, preflightIssues?:string[]}} evidence
 */
export function fastPathEligible(plan, evidence = {}) {
  const tasks = plan?.tasks || [];
  const checks = (plan?.checks || []).filter(command => typeof command === 'string' && command.trim());
  const acceptance = plan?.acceptance || [];
  const reasons = [];
  if (evidence.registered !== true) reasons.push('没有可执行的验收命令，无法由机器证据闭环');
  if (!checks.length) reasons.push('方案里没有任何验收命令');
  if (evidence.preflightIssues?.length) reasons.push('验收命令预检未通过：' + evidence.preflightIssues.join('；'));
  if (tasks.length !== 1) reasons.push(`需要协商的工作单元有 ${tasks.length} 个（快路径只接单执行方、无跨任务接口的工作）`);
  if (tasks.length === 1) {
    const owners = new Set((tasks[0].eligibleWorkers?.length ? tasks[0].eligibleWorkers : [tasks[0].owner]).filter(Boolean));
    if (owners.size !== 1) reasons.push('执行方不唯一（需要分工协商）');
  }
  // 验收项必须全部有着落：要么挂到检查命令（机器证），要么是明确标出的文字要求（由非执行者核验）。
  const covered = new Set(acceptance.map(item => (typeof item === 'object' ? item?.check : null)).filter(Boolean));
  for (const command of checks) if (!covered.has(command)) reasons.push(`验收命令没有对应的验收项：${command}`);
  if (!acceptance.length) reasons.push('没有任何验收项，无法证明完成');
  // 只有"挂不到命令、又没说清是谁来判"的验收项才算落空；带 machine:false 的文字项有专门的核验通道。
  if (acceptance.some(item => typeof item !== 'object' || (!item?.check && item?.machine !== false))) reasons.push('存在只能靠人/模型判断的验收项');
  return { eligible: reasons.length === 0, reasons };
}

/**
 * 用目标文本构造"单人自证"方案。只在 fastPathEligible 通过后使用。
 * 该方案会照常经过 validatePlan / compileControlledPlan / preflightPlan 与队列验收，不跳任何安全检查。
 * 目标里的文字要求（使用说明等）会作为**文字验收项**保留下来，由非执行者在核验阶段逐条复核——
 * 不再像 R177 那样整条丢掉。
 */
export function buildFastPathPlan(goal, checks, { owner, title = '按目标交付并自证', taskId = 'task-1' } = {}) {
  if (!owner) throw new Error('快路径需要一个执行方');
  const commands = (checks || []).filter(command => typeof command === 'string' && command.trim());
  if (!commands.length) throw new Error('快路径需要至少一条验收命令');
  const requirements = goalTextRequirements(goal);
  const files = inferFileScope(commands, goal);
  for (const row of requirements) if (row.file && !files.includes(row.file)) files.push(row.file);
  if (!files.length) throw new Error('快路径需要至少一个明确的产出文件（队列要求文件任务划定范围）');
  const acceptance = [
    ...acceptanceFromCommands(commands, goal),
    ...requirements.map(row => ({ text: row.text, machine: false })),
  ];
  return {
    summary: `单人自证：${String(goal).replace(/\s+/g, ' ').slice(0, 200)}`,
    checks: commands,
    acceptance,
    ...(requirements.length ? { requiresModelReview: true } : {}),
    tasks: [{
      id: taskId,
      owner,
      type: 'workspace',
      title: String(title).slice(0, 80),
      detail: `按用户目标完成交付，并用给定的验收命令自证。目标：${goal}`,
      files,
      dependsOn: [],
      inputRefs: [],
      outputRefs: [],
      acceptance,
      checks: commands,
      difficulty: 'simple',
      maxRetries: 2,
    }],
  };
}
