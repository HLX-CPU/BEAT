// 方案结构规则：每个文件任务必须写清"要创建/修改哪些文件"。
// 规则同时用于两处：
//   ① 开工前的方案预检（parallel 讨论结束后、批准前）：发现问题交作者自纠，最多两次；
//   ② 执行队列入口：最后一道保险，防止旧任务、快路径或返工绕过。
// 能推断的先由代码补：产出引用（outputRefs）和任务说明里点名的文件就是真实产出，
// 不必麻烦客户或模型；推断不出才交给作者补，仍然补不出才拒绝开工并给出人话出口。
import path from 'node:path';

const EXT = 'txt|md|markdown|json|csv|tsv|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|go|rs|java|kt|cs|cpp|cc|c|h|hpp|sh|ps1|bat|cmd|ya?ml|toml|ini|cfg|conf|log|sql|xml|svg|png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?|zip|exe|dll|bin';
const ACTION_PREFIX = '(?:创建|新建|写入|写出|编写|写|生成|保存(?:为|成|到|在)?|输出(?:到|为)?|记录(?:在|到|为)?|交付|产出|修改|编辑|更新|实现|补充|写成|做个|做一个|写个|建个|放到|放在|文件名(?:是|为)?)';
// 引号字符用码点拼，避免在源码里混用三种引号导致转义出错：中文双引号、英文双引号、单引号、反引号。
const QUOTES = String.fromCharCode(0x201c, 0x201d, 0x22, 0x27, 0x60);
const QUOTED_FILE = new RegExp('[' + QUOTES + ']([^' + QUOTES + '\\n]{1,160}?\\.(?:' + EXT + '))[' + QUOTES + ']', 'gi');
const FILE_TOKEN = '(?:[a-zA-Z]:[\\\\/])?(?:[\\w.\\-]+[\\\\/])*[\\w.\\-]+\\.(?:' + EXT + ')';
const FILE_LIST = FILE_TOKEN + '(?:\\s*(?:、|,|，|和|及|以及|与)\\s*' + FILE_TOKEN + ')*';
const ACTION_FILE = new RegExp(ACTION_PREFIX + '\\s*[：:]?\\s*[' + QUOTES + ']?(' + FILE_LIST + ')', 'gi');
const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;
const MAX_FILES = 12;
// 验收里出现这些词，意味着"要有人看画面/看渲染结果"；BEAT 目前只能独立渲染 HTML/SVG/图片，
// 不能渲染 PDF 页面。PDF 任务若把这类验收写成自动标准，执行者只能自证，评审也不会接受（R408 实测）。
const VISUAL_ACCEPTANCE = /逐页|目视|方框|乱码|排版|版面|版式|可选中|可复制|清晰|可辨|截图|视觉|外观|对齐|截断|渲染/i;
const acceptanceText = item => typeof item === 'string' ? item : item && typeof item === 'object' ? String(item.text ?? item.description ?? item.criterion ?? '') : '';
const hasMachineCheck = item => !!(item && typeof item === 'object' && typeof item.check === 'string' && item.check.trim());
export const isVisualAcceptance = item => VISUAL_ACCEPTANCE.test(acceptanceText(item));

/** 一个值可能是字符串、{path} 或数组：统一成干净的路径列表。 */
export function normalizeTaskFiles(value) {
  const rows = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const row of rows) {
    const raw = typeof row === 'string' ? row : row && typeof row === 'object' ? row.path ?? row.file ?? row.name : null;
    if (typeof raw !== 'string') continue;
    const file = raw.trim().replace(/\s+/g, ' ');
    if (file) out.push(file);
  }
  return [...new Set(out)];
}

function inside(root, target) {
  try {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
  } catch { return false; }
}

/** 只接受"像真实产物"的路径：不猜网址、上跳、通配符、纯扩展名。 */
function usableFile(raw, { cwd } = {}) {
  let value = String(raw || '').trim();
  while (value && (QUOTES + '（(【[，,。;；、 ').includes(value[0])) value = value.slice(1);
  while (value && (QUOTES + '）)】]，,。;；、 ').includes(value[value.length - 1])) value = value.slice(0, -1);
  if (!value || value.includes('..')) return null;
  if (/^(?:https?:|mailto:|www\.)/i.test(value)) return null;
  if (/[*?<>|]/.test(value)) return null;
  if (ABSOLUTE.test(value)) {
    // 绝对路径只有在任务目录内才当产出；目录外不猜，避免把本机路径写进文件范围。
    if (!cwd || !inside(cwd, value)) return null;
  }
  const base = path.basename(value);
  if (!base || base === '.' || base === '..' || !base.includes('.')) return null;
  return value.replaceAll('\\', '/');
}

function splitList(text) {
  return String(text || '').split(/\s*(?:、|,|，|和|及|以及|与)\s*/).map(part => part.trim()).filter(Boolean);
}

function filesInText(text) {
  const source = String(text || '');
  const found = [];
  for (const match of source.matchAll(QUOTED_FILE)) found.push(...splitList(match[1]));
  for (const match of source.matchAll(ACTION_FILE)) found.push(...splitList(match[1]));
  return found;
}

/**
 * 推断一个任务要写哪些文件：先看明确的产出引用，再看任务说明里点名的文件。
 * 只在任务自己没写 files 时使用；产物一定是文件，读起来像文件名的才收。
 */
export function inferTaskFiles(task, { cwd } = {}) {
  if (!task || (task.type || 'workspace') === 'desktop') return [];
  const found = [];
  const push = value => {
    const file = usableFile(value, { cwd });
    if (file) found.push(file);
  };
  for (const value of normalizeTaskFiles(task.outputRefs)) push(value);
  for (const value of [...filesInText(task.detail), ...filesInText(task.title)]) push(value);
  const seen = new Set();
  return found.filter(file => {
    const key = file.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_FILES);
}

/**
 * 返回补过文件范围的方案副本；没有可补的任务时原样返回（changes 为空）。
 * 任务写了 files 但漏掉目标里点名的文件时（R499 实测：目标要求 hello.txt / check.py / result.txt，
 * 方案只登记了前两个，执行者写对的 check.py 在验收时被当成“来源不明”），也要按任务说明补全；
 * 只有别的任务已经声明过的文件不抢（避免共享目录里互相覆盖）。
 */
export function inferPlanFiles(plan, { cwd } = {}) {
  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) return { plan, changes: [] };
  const declared = plan.tasks.map(task => normalizeTaskFiles(task?.files));
  const keyOf = file => String(file || '').replaceAll('\\', '/').toLowerCase();
  const changes = [];
  const tasks = plan.tasks.map((task, index) => {
    const current = declared[index];
    if (!task || typeof task !== 'object' || (task.type || 'workspace') === 'desktop') return { ...task, files: current };
    const inferred = inferTaskFiles(task, { cwd });
    if (!inferred.length) return { ...task, files: current };
    const siblingFiles = new Set(declared.flatMap((files, i) => i === index ? [] : files).map(keyOf));
    const additions = inferred.filter(file => !current.some(own => keyOf(own) === keyOf(file)) && !siblingFiles.has(keyOf(file)));
    if (!additions.length) return { ...task, files: current };
    changes.push({ id: String(task.id || 'task-' + (index + 1)), files: additions, ...(current.length ? { merged: true } : {}) });
    return { ...task, files: [...current, ...additions], inferredFiles: additions };
  });
  if (!changes.length) return { plan, changes };
  return { plan: { ...plan, tasks }, changes };
}

/**
 * 方案结构问题（开工前可由作者自纠，不应留到执行入口才爆）。
 * 每条都带 section / kind / problem：section 对应任务编号，problem 是给模型看的可执行修法。
 */
export function planStructureIssues(plan, { cwd } = {}) {
  const issues = [];
  if (!plan || !Array.isArray(plan.tasks)) return issues;
  const ids = plan.tasks.map((task, index) => String(task?.id || 'task-' + (index + 1)));
  const planAcceptance = Array.isArray(plan.acceptance) ? plan.acceptance : [];
  plan.tasks.forEach((task, index) => {
    if (!task || typeof task !== 'object') return;
    const id = ids[index];
    const section = 'tasks.' + id;
    const acceptance = Array.isArray(task.acceptance) && task.acceptance.length ? task.acceptance : planAcceptance;
    if (!acceptance.length) {
      issues.push({ section, kind: 'acceptance', problem: '任务没有验收标准：' + id + '。请给这个任务补至少一条可核对的“怎么算完成”，或写进整体 acceptance。' });
    }
    const dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn : Array.isArray(task.dependencies) ? task.dependencies : [];
    const badDeps = dependsOn.map(String).filter(dep => dep === id || !ids.includes(dep));
    if (badDeps.length) {
      issues.push({ section, kind: 'dependencies', problem: '任务依赖写错了：' + id + ' 引用了不存在或自指的任务（' + badDeps.join('、') + '）。请改成同一方案里真实存在且不循环的任务编号。' });
    }
    if ((task.type || 'workspace') === 'desktop') return;
    const files = normalizeTaskFiles(task.files);
    if (!files.length) {
      issues.push({ section, kind: 'files', problem: '任务没有写文件范围：' + id + '。每个文件任务必须写清它要创建/修改的相对路径（例如 app.py、src/index.js）。只是调研、确认或设计步骤不要单独建任务，请并入真正产出文件的任务，或给这一步一个明确产出文件。' });
      return;
    }
    // 客户明确要求写到任务目录外时，方案里声明绝对路径是允许的（不再限制目录）；这里只要求写清楚。
    // PDF 的"逐页目视/文字可选中/中文无乱码"这类验收 BEAT 无法独立核验：执行者自己看过不算独立证据，
    // 后台渲染器又不会渲染 PDF。这样的方案必须在开工前退回，不能等执行两轮后才判死（R408 实测）。
    const pdfFiles = files.filter(file => /\.pdf$/i.test(file));
    if (pdfFiles.length) {
      const visual = acceptance.filter(item => isVisualAcceptance(item) && !hasMachineCheck(item));
      if (visual.length) {
        issues.push({ section, kind: 'render', problem: '这个任务交付 PDF，但验收要求人眼看画面（' + visual.map(acceptanceText).join('；').slice(0, 120) + '）。BEAT 不会渲染 PDF 页面，执行者自己的目视结论不能当独立验收。请把这些验收改成可机器检查的条件（例如 %PDF- 头、文件大小、页数、sha256 与元数据一致、用测试脚本抽取文本层并确认无替换符），或把需要人眼的目视写进任务说明由客户人工确认，不要写成自动验收标准；其他验收保留。' });
      }
    }
  });
  return issues;
}
