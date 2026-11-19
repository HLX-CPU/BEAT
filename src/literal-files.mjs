import fs from 'node:fs';
import path from 'node:path';

// Bounded new text deliverables can share one executor and one read-only review.
// This only narrows the declared scope; it never writes files or assumes content.
//
// R469 实测：目标写的是 “在 E:\...\beat-review\ 目录中新建 hello.md”，
// 旧实现只抓到文件名 hello.md，把目录丢了，于是执行者按用户原话写到子目录，
// 验收却拿工作目录根去比对，正确产物被判成“范围外”。这里保留用户写出的
// 目录/相对路径；绝对路径只有落在当前工作目录内才允许走直执行快路径。
const EXT = '(?:txt|md|json|csv)';
const NAME = '[A-Za-z0-9_\\u4e00-\\u9fff-]+\\.' + EXT;
const WINDOWS_ABS = '[A-Za-z]:[\\\\/](?:[^\\\\/:*?"<>|\\r\\n，。；;、]+[\\\\/])*[^\\\\/:*?"<>|\\r\\n，。；;、]+\\.' + EXT;
const RELATIVE = '(?:[^\\\\/:*?"<>|\\r\\n，。；;、\\s]+[\\\\/])+[^\\\\/:*?"<>|\\r\\n，。；;、\\s]+\\.' + EXT;
const PATH_TOKEN = new RegExp('(?:' + WINDOWS_ABS + '|' + RELATIVE + '|' + NAME + ')', 'g');
// “在 <目录> 目录中新建 <文件>”：目录和文件被“目录”二字隔开，必须成对解析。
const DIRECTORY_NEW = new RegExp('(?:在|到|往|放进|放到)\\s*([^\\s，。；;、\\n]+?)\\s*(?:目录|文件夹)(?:中|里|内|下)?\\s*(?:新建|创建|写入|写|生成|放)\\s*(' + NAME + ')', 'g');
// “在 <目录> 下创建文件 <文件>”：R482/R483 的写法里没有“目录/文件夹”二字，
// 旧实现只抓到裸文件名，机器核验会拿任务目录根去比对，正确产物被判范围外。
const DIRECTORY_UNDER = new RegExp('(?:在|到|往|放进|放到)\\s*([^\\s，。；;、\\n]+?)\\s*(?:下面|下|中|里|内)\\s*(?:新建|创建|写入|写|生成|放)\\s*(?:一个|一份|个)?\\s*(?:文件|文档)?\\s*(' + NAME + ')', 'g');
// “当前/这个/桌面/文档…”不是子目录名，工作目录已经由 BEAT 解析到真实位置；
// 若把它们当目录会生成“当前/通知.txt”这类错误范围（R425 回归）。
const PLACEHOLDER_DIRS = new Set(['当前', '这个', '该', '同一', '工作', '根', '本', '上述', '指定', '用户', '任务', '项目', '新建', '临时', '目标', '本地', '默认', '桌面', '文档', '下载', '图片', '音乐', '视频']);
const BANNED = /(?:不要|禁止|不得|不用|无需|不需要)\s*(?:新建|创建)|分别由|不同.{0,5}(?:搭档|执行者)|两位.{0,8}执行/;

function resolveInside(cwd, raw, directory) {
  const cleaned = String(raw || '').trim();
  if (!cleaned || cleaned.split(/[\\\\/]/).includes('..')) return null;
  const full = directory ? path.resolve(cwd, directory, cleaned) : path.resolve(cwd, cleaned);
  const rel = path.relative(path.resolve(cwd), full);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return { full, relative: rel.split(path.sep).join('/') };
}

function collect(goal, cwd, { requireContent = true, rejectExisting = true } = {}) {
  const text = String(goal || '');
  if (BANNED.test(text)) return [];
  if (requireContent && (!/(?:新建|创建)/.test(text) || !/(?:内容|正文|写入|写上)/.test(text))) return [];
  const root = path.resolve(cwd || process.cwd());
  const candidates = [];
  const consumed = [];
  for (const match of text.matchAll(DIRECTORY_NEW)) {
    const fileStart = match.index + match[0].lastIndexOf(match[2]);
    consumed.push([match.index, match.index + match[0].length]);
    const directory = String(match[1] || '').replace(/[\\\\/]+$/, '').trim();
    candidates.push({ raw: match[2], directory: PLACEHOLDER_DIRS.has(directory) ? null : match[1], start: fileStart });
  }
  for (const match of text.matchAll(DIRECTORY_UNDER)) {
    if (consumed.some(([from, to]) => match.index < to && match.index + match[0].length > from)) continue;
    const fileStart = match.index + match[0].lastIndexOf(match[2]);
    consumed.push([match.index, match.index + match[0].length]);
    const directory = String(match[1] || '').replace(/[\\/]+$/, '').trim();
    candidates.push({ raw: match[2], directory: PLACEHOLDER_DIRS.has(directory) ? null : match[1], start: fileStart });
  }
  for (const match of text.matchAll(PATH_TOKEN)) {
    const start = match.index, end = start + match[0].length;
    if (consumed.some(([from, to]) => start < to && end > from)) continue;
    candidates.push({ raw: match[0], directory: null, start });
  }
  const files = [], seen = new Set();
  for (const candidate of candidates.sort((a, b) => a.start - b.start)) {
    const resolved = resolveInside(root, candidate.raw, candidate.directory);
    if (!resolved) return [];
    const key = process.platform === 'win32' ? resolved.full.toLowerCase() : resolved.full;
    if (seen.has(key)) continue;
    seen.add(key);
    if (rejectExisting && fs.existsSync(resolved.full)) return [];
    files.push(resolved.relative);
  }
  if (!files.length || files.length > 8) return [];
  return files;
}

export function literalFileScope(goal, cwd) {
  return collect(goal, cwd);
}

// 方案归一：模型/讨论可能把用户点名的目录丢掉（只写 hello.md）。这里按用户原话
// 把裸文件名补回目录；已经带目录的路径不动。用于协商流程，不止免协商快路径。
export function userNamedFileScopes(goal, cwd) {
  return collect(goal, cwd, { requireContent: false, rejectExisting: false });
}

export function alignPlanToUserPaths(plan, goal, cwd) {
  if (!plan || !Array.isArray(plan.tasks)) return plan;
  const named = userNamedFileScopes(goal, cwd);
  if (!named.length) return plan;
  const byBase = new Map();
  for (const item of named) byBase.set(path.basename(item).toLowerCase(), item);
  const fix = file => {
    const text = String(file ?? '');
    if (!text || text.includes('/') || text.includes('\\') || path.isAbsolute(text)) return file;
    return byBase.get(path.basename(text).toLowerCase()) || file;
  };
  const fixText = value => {
    let out = String(value ?? '');
    for (const [base, target] of byBase) {
      if (!out.includes(base) || out.includes('/' + base) || out.includes('\\' + base) || out.includes(target)) continue;
      out = out.split(base).join(target);
    }
    return out;
  };
  const fixAcceptance = item => {
    if (typeof item === 'string') return fixText(item);
    if (item && typeof item === 'object' && typeof item.text === 'string') return { ...item, text: fixText(item.text) };
    return item;
  };
  const tasks = plan.tasks.map(task => ({
    ...task,
    ...(Array.isArray(task.files) ? { files: task.files.map(fix) } : {}),
    ...(Array.isArray(task.inputRefs) ? { inputRefs: task.inputRefs.map(fix) } : {}),
    ...(Array.isArray(task.outputRefs) ? { outputRefs: task.outputRefs.map(fix) } : {}),
    ...(Array.isArray(task.acceptance) ? { acceptance: task.acceptance.map(fixAcceptance) } : {}),
  }));
  return { ...plan, tasks, ...(Array.isArray(plan.acceptance) ? { acceptance: plan.acceptance.map(fixAcceptance) } : {}) };
}
