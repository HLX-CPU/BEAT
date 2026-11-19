// One-sentence tasks use the same audited tool pipeline as parallel partners.
// Explicit read-only requests always win; mentioning an action is not permission.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function requestedFiles(goal) {
  // Chinese corner quotes delimit names just like curly quotes; they are not
  // part of the on-disk filename (first-time delivery previously failed here).
  goal = String(goal || '').replace(/[「『]/g, '“').replace(/[」』]/g, '”');
  const ext = '(?:txt|md|html|csv|json|pdf|docx|xlsx|pptx|py|mjs)';
  const quoted = [...String(goal).matchAll(new RegExp('[“"‘\\\']([^”"’\\\'\\n]+\\.' + ext + ')[”"’\\\']', 'gi'))].filter(m => /(?:新建|创建|保存(?:到|在|为|成)?|另存为|命名为|名为|叫|输出(?:为|到)?|导出(?:为|到)?|放到|放在|交付(?:到)?|写入|写到|(?:复制|移动)到)\s*(?:一个|一份|个)?\s*(?:文件|文档)?$/.test(String(goal).slice(0, m.index))).map(m => m[1]);
  const named = [...String(goal).matchAll(new RegExp('(?:新建|创建|保存(?:到|在|为|成)?|写入|写到|输出(?:到|为)?|导出(?:为|到)?|放到|放在|存到|交付(?:到)?|名为|叫|文件名(?:是|为)?)(?:一个|一份|个)?\\s*(?:文件|文档)?\\s*[“"‘\\\']?([^\\s“"”‘’\\\\/:：，。；、？！()（）]+\\.' + ext + ')', 'gi'))].map(m => m[1]);
  return [...new Set([...quoted, ...named].map(s => path.basename(s.replaceAll('\\', '/')).toLowerCase()))];
}
// 一句话里可能点名多个文件；评估只认本次交付，但检查点应覆盖所有点名文件，避免只备份第一个。
export function allFileMentions(goal) {
  const ext = '(?:txt|md|html|csv|json|pdf|docx|xlsx|pptx|py|mjs)';
  const found = [...String(goal || '').matchAll(new RegExp('[\\w\\u4e00-\\u9fff.-]+\\.' + ext, 'gi'))]
    .map(match => path.basename(match[0].replaceAll('\\', '/')).toLowerCase());
  return [...new Set(found)];
}
export function wantsAction(question) {
  const text = String(question || '').trim();
  const first = text.split(/[。；;\n]/)[0];
  // 纯文字加工（改写 / 润色 / 翻译 / 总结 / 只输出句子）不是文件或电脑操作：
  // R415 实测：用户说"把这句话改得更礼貌：把文件发我一下"，旧规则把句子里的"改"和"文件"
  // 当成"要改文件"，于是走了文件核验，正确答复被判"任务没有完成"。
  const textWork = /(?:改写|润色|翻译|总结|摘要|缩写|扩写|改写成|翻译成|调整措辞|改得更|改得更加|改为更|改一下措辞|回复得)/.test(first)
    || /(?:把|将)?\s*(?:这|那|本|上|下|刚才|上面|下面)?\s*(?:一)?(?:句|段|话|文字|内容|邮件|通知|文案|措辞|语气|开头|消息|回复|文本).{0,30}(?:改成|改为|改得|改写|润色|翻译|总结|缩写|扩写|优化|调整)/.test(first);
  // 只有同时明确要求落成文件/保存/导出/新建等，才仍然是动作。
  const saveOrCreate = /(?:新建|创建|保存(?:到|在|为|成)?|存到|写到|写入|导出|另存|放到|放在|输出(?:到|为)|复制到|移动到|删除|重命名)/.test(first)
    && /(?:文件|桌面|文件夹|目录|文档|附件|工作目录|\.(?:txt|md|csv|json|html|pdf|docx|xlsx|pptx|py|mjs)\b)/i.test(first);
  if (textWork && !saveOrCreate) return false;
  if (/^(?:请|帮我|麻烦)?\s*(?:解释|介绍|讲解|分析|评价|讨论|如何|怎么|为什么|是否|能否)/i.test(first)
      || /(?:只(?:需|要)?(?:回复|回答|讨论|解释)|只读|不要(?:操作|执行|改动|修改文件|创建)|不(?:改文件|操作电脑))/.test(first)) return false;
  // 「打开/启动/运行 X」是动作，X 可以是任意应用名（豆包/微信/QQ/抖音…），不能只认一张固定清单。
  // R133 实测：只认桌面/记事本/计算器/浏览器/GitHub 的旧清单把「打开豆包」当成了普通提问，模型于是只回答不执行。
  const launch = /(?:请|帮我|麻烦|替我|我要|需要)?\s*(?:打开|启动|运行)\s*(?:一下|一个|我的|我)?\s*([^\s，。；、？！]{1,30})/.exec(first);
  if (launch && !/^(?:思路|话题|话匣子|局面|市场|眼界|格局|大门|新篇章)/.test(launch[1])) return true;
  const command = /(?:请|帮我|麻烦|替我|我要|需要)?\s*(?:新建|创建|建一个|建个|做一个|做个|写一个|写个|生成|制作|保存|存到|存成|写到|放到|放在|打开|启动|复制|拷贝|备份|移动|转换|转成|转为|导出|另存|修改|改成|改为|改一下|编辑|更新|追加|整理)/;
  const target = /(?:桌面|文档文件夹|下载文件夹|文件|文件夹|目录|附件|记事本|计算器|浏览器|资源管理器|GitHub|https?:\/\/|www\.|[\w\u4e00-\u9fff-]+\.(?:txt|md|html|csv|json|pdf|docx|xlsx|pptx|py|mjs)\b)/i;
  return command.test(first) && target.test(first);
}

export function actionPrompt(run, context = []) {
  if (['codex', 'deepseek', 'zcode'].includes(run.target)) return nativeActionPrompt(run, context);
  return `你正在直接执行用户的一句话任务，不是写操作教程。用户已授权本条请求的操作。
你已经在 BEAT 电脑助手里：直接用助手提供给你的工具干活（file_read / file_write / file_edit / file_look / file_list / file_glob / file_convert / file_copy / file_move / file_mkdir、app_list + app_launch、window_list / window_info / window_focus、uia_query / uia_get / uia_invoke、desktop_observe / screenshot、shell_run、check）。**本任务没有也不需要 desktop_call 这类 MCP 工具**：不要去找 MCP 名字、端点、contextId，也不要自己写命令行/键鼠脚本去绕。
先观察再动手：看文件用 file_look/file_read，找应用用 app_list（拿真实 appId）再 app_launch。不要猜绝对路径，不要让用户填写工作目录，不要请求开放全盘权限。
用户说桌面/文档/下载时直接用对应工具路径别名，例如“桌面/通知.txt”。
新建文件使用 file_write(path,content,expectedHash:"absent")；新建文件夹使用 file_mkdir。修改已有文件先 file_read 获取 sha256，再用 file_edit/file_write 绑定该哈希；不可擅自覆盖同名文件。输出格式必须与扩展名一致，不能把纯文本假装成 docx/xlsx/pptx/pdf。
复制/转换/查询优先文件接口。打开软件：先用 app_list 按名字查真实应用 ID，再 app_launch，最后用窗口接口核验；打开桌面上已有的文件或图标：先用 file_look path=桌面 pattern=名字* 看真实文件名。app_open 只能用于已经确认存在的文件、文件夹或网址，不要拿猜的名字当路径。必须操作界面时才观察真实控件，再通过共用工具操作并核验。
删除、受控命令和项目代码运行继续遵守原确认机制；不可代用户批准。工具返回未知副作用时停止，不重放；明确未执行的错误可修正参数后继续。
完成后读回文件核对内容。只报告工具已核验的结果，并给真实交付路径。未完成就说清具体缺什么，不声称成功。
客户答复控制在两三句话：说已完成什么、交付完整路径或一个具体下一步。不要展示沙箱、原始工具JSON等内部概念，审计证据由后台保存。
${context.length ? '此前同一会话的最近内容（仅作续问上下文，不重放旧操作）：\n' + context.map(s => s.role + ': ' + s.text).join('\n') + '\n' : ''}
用户本次原话：\n${run.goal}`;
}

export function nativeToolPrompt(agent) {
  const who = agent === 'codex' ? 'Codex' : agent === 'zcode' ? 'ZCode' : 'DeepSeek';
  return `${who} 使用自己桌面端的原生工具执行：文件优先文件接口与自己的 MCP/技能；需要开软件、操作本机或走界面时，用你这一端自己就能调用的手段（自己的命令行/shell 工具、已安装的技能脚本、自己的 MCP），接口/命令优先，只有确实做不到才操作可见界面并说明原因。BEAT 电脑助手专供拓展坞，不调用其 desktop_call 等工具，也不另起助手或协作任务。本步骤需要的权限已经按任务设置好：不要拿“沙箱/权限/没有接口”当作拒绝执行的理由，也不要自己去改权限、关沙箱或绕过审批；真的缺工具就先核对自己环境里实际列出的工具与技能，再说清楚缺哪一项。未知操作结果先核对，禁止重放。列文件/读文本优先用只读文件工具（read/glob/ls），不要用 PowerShell 渲染中文文件名；同一条命令连续失败两次就换工具或如实说明卡点，不要反复重试。`;
}

function nativeActionPrompt(run, context) {
  return `直接执行用户授权的一句话任务，不写操作教程。\n${nativeToolPrompt(run.target)}\n使用当前环境实际列出的工具，不猜工具名。用户说桌面/文档/下载时由现有文件接口或技能解析真实用户文件夹，不让用户填写路径。只操作本条请求的目标，不擅自覆盖同名文件；改已有文件前先读取并保留冲突检查。删除、发送、运行项目代码等仍遵守既有确认机制。完成后用原生工具读回文件或观察实际目标，区分已完成与未核验。客户答复用两三句话，给实际交付路径或缺失能力。\n${context.length ? '此前同一会话的最近内容（仅用于续问，不重放旧操作）：\n' + context.map(s => s.role + ': ' + s.text).join('\n') + '\n' : ''}用户本次原话：\n${run.goal}`;
}

/**
 * 「打开/启动 X」里的 X：只取用户点名的目标词，用于独立核验。
 * 旧实现把含 github 的目标一律当成 github.com，导致「打开我桌面的GitHub（Desktop）」永远核验不过。
 */
export function openedTarget(goal) {
  // A prohibition or running a script is not a request to open a GUI. Fetching
  // a URL is not opening a browser either. R389 previously hit all three.
  const clauses = String(goal || '').split(/[\n，,。；;！？]/);
  let m;
  for (const clause of clauses) {
    const candidate = /(?:打开|启动|运行)\s*([^\n，。；、]{1,160})/.exec(clause);
    if (!candidate) continue;
    const prefix = clause.slice(0, candidate.index);
    if (/(?:不要|禁止|不得|不用|无需|不需要|不能|不必|未要求|不允许|不执行|不使用).{0,16}$/.test(prefix)) continue;
    if (/只(?:回答|解释|讨论)|如何|怎么/.test(prefix)) continue;
    if (candidate[0].startsWith('运行') && /脚本|命令|测试|程序代码|项目代码|python|\bnode\b|\bnpm\b|\bcv2\b|\.(?:py|mjs|cjs|js|ps1|sh|bat)\b/i.test(candidate[1])) continue;
    m = candidate; break;
  }
  if (!m) return { url: null, word: null };
  const url = m[1].match(/https?:\/\/[^\s，。；、]+/i)?.[0];
  if (url) return { url, word: null };
  const word = m[1]
    .replace(/一下|一个|我的|我|自己的|电脑上的|本机的|桌面上的|桌面端|桌面的|桌面|端|应用|程序|软件|图标|快捷方式|文件夹|文件|吧|呢|啊|呀|了/g, '')
    .replace(/^的+/, '').trim();
  return { url: null, word: word || null };
}

/** 全量进程/窗口快照（pid、进程名、窗口标题、是否前台），用于"操作前后"独立核验。 */
export function snapshotProcesses({ spawnSync: run = spawnSync } = {}) {
  const script = `$ErrorActionPreference='SilentlyContinue';
$sig='[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);';
try { Add-Type -Namespace BeatProbe -Name Win -MemberDefinition $sig -ErrorAction Stop } catch {}
$fgpid = 0
try { $h=[BeatProbe.Win]::GetForegroundWindow(); [void][BeatProbe.Win]::GetWindowThreadProcessId($h,[ref]$fgpid) } catch { $fgpid = 0 }
$out=@(); Get-Process | ForEach-Object { $out += [pscustomobject]@{ pid=$_.Id; process=$_.ProcessName; title=$_.MainWindowTitle; foreground=([int]$_.Id -eq [int]$fgpid) } }; ConvertTo-Json -Compress -InputObject $out`;
  try {
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
    if (!r || !r.stdout) return [];
    const parsed = JSON.parse(String(r.stdout).trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(p => ({ pid: p.pid, process: p.process, title: p.title || '', foreground: p.foreground === true }));
  } catch { return []; }
}

// 模型自己执行过的命令里出现过的可执行文件名：作为"它到底开了什么"的候选，
// 由 BEAT 去真实进程表里核对（中文应用名和 exe 名对不上时也能核准，例如 豆包 → Doubao.exe）。
const TOOL_HOSTS = new Set(['pwsh', 'powershell', 'cmd', 'conhost', 'wt', 'node', 'python', 'python3', 'tasklist', 'taskkill', 'wmic', 'where', 'findstr', 'reg', 'net', 'sc', 'msiexec', 'svchost', 'csrss', 'winlogon', 'services', 'dllhost', 'werfault', 'openconsole']);
export function launchCandidates(evidence) {
  const text = JSON.stringify(evidence?.calls || []);
  const names = new Set();
  for (const m of text.matchAll(/([A-Za-z0-9_.\-]+)\.exe/gi)) {
    const name = m[1].toLowerCase();
    if (!TOOL_HOSTS.has(name) && !/^[0-9.]+$/.test(name)) names.add(name);
  }
  return [...names];
}

/** 独立核验：本机真实在跑的进程/窗口里有没有这个词，以及它现在是不是前台（不采信模型自述）。 */
export function probeDesktopApps(words, { spawnSync: run = spawnSync } = {}) {
  if (!words) return [];
  const list = (Array.isArray(words) ? words : [words]).filter(Boolean);
  if (!list.length) return [];
  const match = list.map(w => `($n -match ${JSON.stringify(w)} -or $t -match ${JSON.stringify(w)})`).join(' -or ');
  const script = `$ErrorActionPreference='SilentlyContinue';
$sig='[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);';
try { Add-Type -Namespace BeatProbe -Name Win -MemberDefinition $sig -ErrorAction Stop } catch {}
$fgpid = 0
try { $h=[BeatProbe.Win]::GetForegroundWindow(); [void][BeatProbe.Win]::GetWindowThreadProcessId($h,[ref]$fgpid) } catch { $fgpid = 0 }
$out=@(); Get-Process | Where-Object { $n=$_.ProcessName; $t=$_.MainWindowTitle; ${match} } | ForEach-Object { $out += [pscustomobject]@{ pid=$_.Id; process=$_.ProcessName; title=$_.MainWindowTitle; foreground=([int]$_.Id -eq [int]$fgpid) } }; ConvertTo-Json -Compress -InputObject $out`;
  try {
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (!r || !r.stdout) return [];
    const parsed = JSON.parse(String(r.stdout).trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(p => ({ pid: p.pid, process: p.process, title: p.title || '', foreground: p.foreground === true }));
  } catch { return []; }
}

export function newDesktopApps(before = [], after = []) {
  return (after || []).filter(a => !(before || []).some(b => String(b.pid) === String(a.pid)));
}

/** 目标应用现在在前台、而任务开始前不在前台 → 这就是「打开」的可观察结果（在跑的应用再次打开只会被切到前台）。 */
export function broughtToFront(before = [], after = [], matches = () => true) {
  const wasFront = (before || []).some(b => matches(b) && b.foreground === true);
  const isFront = (after || []).some(a => matches(a) && a.foreground === true);
  return isFront && !wasFront;
}

// Native receipts are independent of the dock assistant's task database.
// Only a specifically requested, changed regular file — or an opening target that
// BEAT itself saw appear on the real desktop — can pass this verifier.
export function captureNativeFiles(goal, folders, cwd) {
  const names = requestedFiles(goal);
  const destination = requestedDestination(goal);
  const folder = destination ? folders[destination] : cwd;
  // 客户在目标里直接写了绝对路径（例如保存到 D:\out\报告.md）时，就在那个真实位置核对交付，
  // 不能只认任务目录/用户文件夹——文件写在哪里，评估就该看哪里。
  const absolute = absoluteFilesInGoal(goal);
  // 目标里写的是“在 <绝对目录> 下创建 <文件>”时，目录本身没有结尾反斜杠、也不是文件名。
  // 旧实现只认以分隔符结尾的目录，于是把文件名拼回任务目录，执行者明明写对了也被判“尚未核验交付”
  // （R482/R483 实测）。这里按磁盘真实类型/“无扩展名”识别目录，再与文件名称拼接。
  const absoluteDirs = absolute.filter(file => {
    try { return fs.statSync(file).isDirectory(); } catch { return /[\\/]$/.test(file) || !path.extname(file); }
  });
  const locate = name => {
    const hit = absolute.find(file => path.basename(file).toLowerCase() === name.toLowerCase());
    if (hit) return hit;
    const dir = absoluteDirs[0];
    return dir ? path.join(dir, name) : path.resolve(folder || cwd, name);
  };
  // 目标只写了绝对路径、没被 requestedFiles 认出来时，也按那个真实路径核对（客户要求不限制目录）。
  const targets = names.length ? names.map(locate) : absolute.slice(0, 10);
  return targets.map(file => {
    try {
      const stat = fs.lstatSync(file);
      return { path: file, existed: true, regular: stat.isFile() && !stat.isSymbolicLink(), sha256: stat.isFile() && !stat.isSymbolicLink() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null };
    } catch (e) { return { path: file, existed: e.code !== 'ENOENT', regular: false, sha256: null }; }
  });
}

// 目标里直接写出的绝对路径（客户要求保存到某个真实位置时，评估必须去那里核对）。
// 用 path.win32.isAbsolute 判断，避免手写反斜杠正则。
export function absoluteFilesInGoal(goal) {
  const out = [];
  for (const raw of String(goal || '').split(/[\s"'<>|，。；;、]+/)) {
    const token = raw.replace(/[)）】]+$/, '').trim();
    if (!token) continue;
    if (path.win32.isAbsolute(token)) out.push(path.resolve(token));
  }
  return [...new Set(out)];
}

// Mentioning a forbidden desktop tool is not a request to deliver to Desktop.
export function requestedDestination(goal) {
  const clauses = String(goal || '').split(/[。；;，,\n]/).filter(clause => !/(?:不要|禁止|不得|不能|不用|不应)\s*(?:把.{0,30})?(?:在|放|保存|存到|写到|交付|输出)/.test(clause));
  for (const [key, names] of [['desktop', '桌面|desktop\\b'], ['documents', '文档文件夹|documents\\b'], ['downloads', '下载文件夹|downloads\\b']]) {
    const placed = new RegExp('(?:在|放(?:到|在)?|保存(?:到|在)?|存到|写到|交付到|输出到|to\\s+|on\\s+)\\s*(?:我的|my\\s+)?\\s*(?:电脑(?:的)?)?\\s*(?:' + names + ')', 'i');
    const leading = new RegExp('^\\s*(?:我的)?(?:电脑的?)?(?:' + names + ')(?:上)?\\s*(?:新建|创建|保存)', 'i');
    if (clauses.some(clause => placed.test(clause) || leading.test(clause))) return key;
  }
  return null;
}

/**
 * 原生工具日志里它自己写过的文件（Codex 的 fileChange/apply_patch 会带真实路径）。
 * 「创建一个HTML」这种目标没点名文件名，只能靠日志里的真实写入动作找交付物——不是靠模型嘴上说的链接。
 */
export function nativeWrittenFiles(evidence, { cwd, roots = [], since = 0, limit = 5 } = {}) {
  const found = new Map();
  for (const call of evidence?.calls || []) {
    if (call.status !== 'completed' || call.failed === true) continue;
    const fileTool = ['edit','write'].includes(call.tool) && call.record?.type === 'tool_call' && call.result?.type === 'tool_result' && call.result?.status === 'completed' && evidence?.trace?.status === 'complete';
    const changes = call?.record?.changes || call?.record?.result?.changes || (fileTool && typeof call.record?.input?.file_path === 'string' ? [{path:call.record.input.file_path,kind:'update'}] : []);
    if (!changes.length) continue;
    for (const change of changes) {
      const raw = change?.path || change?.file || change?.filename;
      if (!raw || typeof raw !== 'string') continue;
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd || '.', raw);
      // 交付文件写在任务目录/用户文件夹之外也必须能被评估（客户要求：不要给限制）。
      // 这里只认原生工具日志里真实写过的路径，磁盘存在性、普通文件和任务时间窗由调用方继续核对；
      // roots 仅保留为旧调用兼容参数，不再过滤真实写入。
      found.set(abs.toLowerCase(), { path: abs, kind: change?.kind?.type || change?.kind || change?.type || 'update' });
      if (found.size >= limit) return [...found.values()];
    }
  }
  return [...found.values()];
}

// 用户在原话里写明的字面内容（"内容严格为 HELLO BEAT"）。文件在任务开始前就已经是这份内容时，
// 本次没有产生新改动也能按"无需改动"通过——买家重跑同一个任务很常见（R424 实测被误判失败）。
export function requestedLiteralContent(goal) {
  const text = String(goal || '');
  const block = requestedLiteralBlock(text);
  if (block !== null) return block;
  const patterns = [
    /内容(?:严格)?(?:为|是|=|：|:)\s*[“"'\u0060《]?([^"”'\u0060》\n]+?)[”"'\u0060》]?\s*(?:[（(]|$|[。；;，,])/,
    /(?:写入|写到|填入|文本)(?:内容)?(?:为|是|：|:)\s*[“"'\u0060《]?([^"”'\u0060》\n]+?)[”"'\u0060》]?\s*(?:[（(]|$|[。；;，,])/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = match[1].trim().replace(/^[“"'\u0060《]+|[”"'\u0060》]+$/g, '').trim();
    if (value) return value;
  }
  return null;
}
// Only an explicit line count and a newline delimit a multiline literal.
// Prose following the N lines remains in the original goal for safety review.
export function requestedLiteralBlock(goal) {
  const match = /(?:内容|正文)(?:严格)?(?:为|是)[^\n]{0,8}以下\s*([1-8一二两三四五六七八])\s*行\s*[：:]\s*\r?\n/.exec(String(goal || ''));
  if (!match) return null;
  const count = Number(match[1]) || ({一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8})[match[1]];
  const lines = String(goal).slice(match.index + match[0].length).split(/\r?\n/).slice(0, count);
  return lines.length === count && lines.every(line => line.length > 0) ? lines.join('\n') : null;
}
const sameLiteral = (a, b) => {
  const norm = value => String(value ?? '').replace(/^\uFEFF/, '').trim().replace(/\r\n/g, '\n').replace(/[。！？.!?]+$/, '').trim();
  return norm(a) === norm(b);
};

export function nativeFileOnlyTrace(evidence) {
  if (evidence?.sideEffects === 'unknown' || evidence?.trace?.status !== 'complete' || !evidence.calls?.length) return false;
  return evidence.calls.every(call => ['completed','failed'].includes(call.status) &&
    /^(?:read|write|edit|glob|grep|ls|file_read|file_write|file_edit|file_list|file_glob|apply_patch|fileChange)$/.test(call.tool));
}

export function assessNativeAction(evidence, before = [], { goal = '', beforeApps = null, afterApps = null, cwd = '', roots = [], since = 0 } = {}) {
  if (evidence?.sideEffects === 'unknown') return { ok: false, message: '原生工具操作结果尚未确认，请先核对实际结果，避免重复操作。', artifacts: [] };
  const calls = evidence?.calls || [];
  const completed = calls.filter(c => c.status === 'completed' && c.failed !== true);
  // 只要求"至少有一件完成的动作"。个别探索性命令非零退出（例如 rg 没搜到、沙箱拒绝某个探测）
  // 不能把后面的真实交付判死——R135 实测：一条 rg 没匹配就把已创建并读回的 HTML 判成失败。
  const failedProbes = calls.filter(c => c.failed === true || c.status !== 'completed').map(c => String(c.record?.command || c.tool || '').slice(0, 120));
  if (!completed.length) return { ok: false, message: '本次尚无完整的原生工具执行证据，已保留答复和操作记录。', artifacts: [] };
  const warnings = failedProbes.length ? [`有 ${failedProbes.length} 个命令以非零退出码结束（已记录，不影响本次交付核验）：${failedProbes.slice(0, 2).join('；')}`] : [];
  const artifacts = [];
  const { url, word } = openedTarget(goal);
  const opening = !!(url || word);
  const target = url || word || (/github/i.test(goal) ? 'github.com' : goal.match(/(?:打开|启动)\s*(?:一下|我的)?\s*(计算器|记事本|浏览器)/)?.[1]);
  const targetPattern = target === '计算器' ? /计算器|calculator/i : target === '记事本' ? /记事本|notepad/i : target === '浏览器' ? /浏览器|browser|chrome|edge|firefox/i : null;
  // 打开类目标：原生工具回执里出现目标，或 BEAT 自己在操作前后看到真实进程/窗口出现（或目标被切到前台）。
  // 进程名匹配优先；只有进程名都没命中时才退而看窗口标题（避免把挂着目标标题别的进程当成目标）。
  const procMatch = app => { const p = String(app.process || ''); if (!target) return true; return targetPattern ? targetPattern.test(p) : p.toLowerCase().includes(String(target).toLowerCase()); };
  const titleMatch = app => { const t = String(app.title || ''); if (!target || !t) return false; return targetPattern ? targetPattern.test(t) : t.toLowerCase().includes(String(target).toLowerCase()); };
  const matchSet = apps => { const list = apps || []; const byProcess = list.filter(procMatch); return byProcess.length ? byProcess : list.filter(titleMatch); };
  // 中文名和 exe 名对不上时（豆包 → Doubao.exe），用模型自己执行过的命令里出现过的可执行名当候选。
  const candidates = opening ? launchCandidates(evidence).map(n => n.toLowerCase()) : [];
  const candMatch = app => candidates.some(n => String(app.process || '').toLowerCase().includes(n));
  const windowed = app => !!(app.title && String(app.title).trim()) || app.foreground === true;
  const fresh = beforeApps || afterApps ? newDesktopApps(beforeApps || [], afterApps || []).filter(a => procMatch(a) || candMatch(a)) : [];
  const front = broughtToFront(beforeApps, afterApps, procMatch);
  const freshHit = fresh.length > 0 || front;
  // 目标在任务开始前就已经开着且有窗口：请求的最终状态本来就成立（单实例应用再次打开只会切前台，
  // 锁屏等环境下系统会拒绝跨进程抢前台）。这种情况按「已满足」记，但必须由 BEAT 自己前后都看到真实窗口。
  const alreadyOpen = matchSet(beforeApps).some(windowed);
  const stillOpen = matchSet(afterApps).some(windowed);
  const receiptHit = !target || !opening ? true : (evidence.verifiedActions || []).some(action => {
    const actual = JSON.stringify(action.evidence?.after || {});
    return targetPattern ? targetPattern.test(actual) : actual.toLowerCase().includes(String(target).toLowerCase());
  });
  if (opening && !freshHit && !(alreadyOpen && stillOpen) && !(evidence?.verification?.status === 'verified' && receiptHit)) return { ok: false, message: '打开目标的实际结果尚未核验，已保留原生工具记录，不能标记完成。', artifacts: [] };
  for (const old of before) {
    try {
      const stat = fs.lstatSync(old.path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('not a regular file');
      const sha256 = createHash('sha256').update(fs.readFileSync(old.path)).digest('hex');
      if (old.existed && (!old.regular || !old.sha256 || old.sha256 === sha256)) {
        // 文件在任务开始前就存在且内容没变：如果用户原话写明了字面内容且当前内容一致，
        // 按"已经满足、无需改动"通过；其他情况仍视为没有可归因的改动。
        const expected = requestedLiteralContent(goal);
        const current = fs.readFileSync(old.path, 'utf8');
        if (expected && sameLiteral(expected, current)) { artifacts.push({ path: old.path, bytes: stat.size, sha256, tool: 'native-desktop', unchanged: true }); continue; }
        throw Error('no attributable change');
      }
      artifacts.push({ path: old.path, bytes: stat.size, sha256, tool: 'native-desktop' });
    } catch { return { ok: false, message: '要求的文件尚未核验交付，已保留原生工具记录和完成部分。', artifacts }; }
  }
  // 目标里没点名文件（例如「创建一个HTML…」）：按原生工具日志里它自己写过的真实路径核对磁盘上的文件。
  if (!artifacts.length && !opening) {
    for (const written of nativeWrittenFiles(evidence, { cwd, roots, since })) {
      try {
        const stat = fs.lstatSync(written.path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (since && stat.mtimeMs < since - 2000) continue;                                  // 不是本次写的
        const sha256 = createHash('sha256').update(fs.readFileSync(written.path)).digest('hex');
        artifacts.push({ path: written.path, bytes: stat.size, sha256, tool: 'native-desktop', change: written.kind });
      } catch { /* 日志里提过但磁盘上不在了：不算交付 */ }
    }
    if (artifacts.length) return { ok: true, artifacts, source: 'native file-change log + real file on disk', ...(warnings.length ? { warnings } : {}) };
  }
  // Tool completion alone cannot establish that a browser/window reached its target.
  if (artifacts.length) return { ok: true, artifacts, source: 'native-tool-log + requested-file-before-after', ...(warnings.length ? { warnings } : {}) };
  if (evidence?.verification?.status === 'verified') return { ok: true, artifacts: [], source: 'native structured tool receipts', ...(warnings.length ? { warnings } : {}) };
  if (freshHit) return { ok: true, artifacts: [], source: 'independent os process/window check before-after', opened: fresh.length ? fresh : matchSet(afterApps), ...(warnings.length ? { warnings } : {}) };
  if (alreadyOpen && stillOpen) return { ok: true, artifacts: [], source: 'os pre-existing open window (already satisfied)', note: 'BEAT 独立核对：这个目标在任务开始前就已经开着并可见，本次确认它仍在运行（没有重复启动）。', ...(warnings.length ? { warnings } : {}) };
  return { ok: false, message: '原生工具已返回，电脑操作的实际结果尚未独立核验，不能标记完成。', artifacts: [] };
}

export function assessAction(evidence, { goal = '', folders = {}, verifyFiles = false } = {}) {
  const calls = evidence?.calls || [];
  if (calls.some(c => c.evidence?.sideEffects === 'unknown')) return { ok: false, message: '操作结果尚未确认，已保留记录。请先核对实际结果，避免重复操作。', artifacts: [] };
  const effective = calls.filter(c => !c.recoveredBy);
  // 参数/路径校验类失败一步都没有派发（sideEffects=none + tool-error），助手已经把它回给模型并完成自纠。
  // 这种零副作用的中途失败不能把后面已经核验的动作判成失败；真实失败和未知副作用照旧拦住。
  const noDispatch = c => c.status === 'failed' && c.evidence?.sideEffects === 'none' && ['tool-error', 'abort', 'argument-validation'].includes(c.evidence?.verification?.method);
  if (effective.some(c => c.status !== 'verified' && !noDispatch(c))) return { ok: false, message: '这次操作尚未全部核验通过，已保留已完成的结果。请补充答复中指出的信息后继续。', artifacts: [] };
  const acted = effective.filter(c => c.status === 'verified' && c.evidence?.verification?.status === 'verified' && c.evidence.sideEffects && c.evidence.sideEffects !== 'none');
  if (!acted.length) return { ok: false, message: '本次尚未产生已核验的交付或操作结果。已保留现有文件，请按下面的说明补充需求后继续。', artifacts: [] };
  // 「打开/启动 X」且 X 不是文件名时，X 就是应用名（豆包/微信/QQ…）：必须有真正打开应用类的已核验动作，
  // 只写了个文件不算把应用打开了。
  const openedWord = openedTarget(goal).word;
  const app = openedWord && !/\.[a-z0-9]{1,5}$/i.test(openedWord) && !/[\\/]/.test(openedWord) ? openedWord : null;
  if (app && !acted.some(c => ['app_launch', 'app_open', 'window_focus'].includes(c.tool))) return { ok: false, message: '应用打开尚未核验完成，已保留其他已完成的结果。', artifacts: [] };
  const artifacts = acted.flatMap(c => {
    const a = c.evidence.after;
    const p = a?.resolvedPath || a?.to || a?.path;
    return typeof p === 'string' ? [{ path: p, bytes: a?.bytes ?? null, sha256: a?.sha256 ?? null, tool: c.tool }] : [];
  });
  for (const a of artifacts) {
    const readback = [...effective].reverse().find(c => c.tool === 'file_read' && c.status === 'verified' && String(c.evidence?.after?.resolvedPath || '').toLowerCase() === a.path.toLowerCase());
    if (readback?.evidence?.after?.sha256) a.sha256 = readback.evidence.after.sha256;
  }
  const wanted = requestedFiles(goal);
  if (wanted.some(name => !artifacts.some(a => path.basename(a.path).toLowerCase() === name))) return { ok: false, message: '用户要求的文件尚未全部交付，已保留完成部分。请补充答复中指出的信息后继续。', artifacts };
  const destination = [['desktop', '桌面|desktop'], ['documents', '文档文件夹|documents'], ['downloads', '下载文件夹|downloads']].find(([, names]) => new RegExp('(?:在|放(?:到|在)?|保存(?:到|在)?|存到|写到)\\s*(?:我的)?\\s*(?:' + names + ')', 'i').test(goal));
  if (destination && artifacts.length) {
    const root = folders[destination[0]];
    if (!root || artifacts.some(a => { const rel = path.relative(root, a.path); return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel); })) return { ok: false, message: '文件尚未交付到你指定的位置，已保留现有结果，不能标记完成。', artifacts };
  }
  if (verifyFiles) {
    for (const a of artifacts) {
      try {
        if (!path.isAbsolute(a.path) || fs.lstatSync(a.path).isSymbolicLink()) throw Error('invalid artifact');
        const stat = fs.statSync(a.path);
        if (stat.isFile() && a.sha256 && createHash('sha256').update(fs.readFileSync(a.path)).digest('hex') !== a.sha256) throw Error('changed');
        if (stat.isFile() && a.bytes != null && stat.size !== a.bytes) throw Error('changed');
      } catch { return { ok: false, message: '交付物在最终复查时不存在或内容已变化，已保留操作记录，请核对后继续。', artifacts }; }
    }
  }
  return { ok: true, artifacts };
}
