// 交付物「点击打开」：只允许打开 BEAT 允许范围内的真实文件/文件夹，用系统默认程序打开（不执行、不改动）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { defaultUserFolders } from '../workspaces/shared/desktop-assistant/core/security.mjs';

const inside = (root, file) => { try { const rel = path.relative(root, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); } catch { return false; } };

/** 允许打开的范围：项目的 allowedRoots、工作目录，以及本机真实的桌面/文档/下载。 */
export function openableRoots(config, userFolders = defaultUserFolders()) {
  const roots = [config.workspace, ...(config.allowedRoots || [])].filter(Boolean);
  for (const folder of Object.values(userFolders || {})) if (folder) roots.push(folder);
  return [...new Set(roots.map(root => { try { return fs.realpathSync(root); } catch { return null; } }).filter(Boolean))];
}

/** 校验并解析要打开的交付物；不在允许范围、不存在、是链接逃逸的一律拒绝。 */
export function resolveOpenable(config, target, { userFolders, allow = true } = {}) {
  const raw = String(target || '').trim();
  if (!raw) throw new Error('要打开哪个文件？请给一个完整路径');
  if (!path.isAbsolute(raw)) throw new Error('请给完整路径（例如 E:\\beat\\workspaces\\shared\\xxx.html）');
  let real;
  try { real = fs.realpathSync(raw); } catch { throw new Error('这个文件不存在（可能已被移动或删除）：' + raw); }
  const stat = fs.lstatSync(real);
  if (stat.isSymbolicLink()) throw new Error('这是快捷方式/链接，不能直接打开；请打开它的真实目标');
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('只能打开普通文件或文件夹');
  const roots = openableRoots(config, userFolders);
  if (allow && !roots.some(root => inside(root, real))) throw new Error('这个位置不在 BEAT 允许打开的范围内（只允许工作目录、已配置目录和桌面/文档/下载）');
  return { path: real, isDirectory: stat.isDirectory() };
}

// ── 有没有"默认程序"可开？（客户实测：点 .mjs 没反应，还提示"已用默认程序打开"）──
// .mjs/.md/.json/.py 这类扩展名在 Windows 上常常**没有文件关联**（assoc 直接报 not found），
// 此时 `cmd /c start` 什么都不发生、也不报错，产品却报告成功——客户看到的就是"点了没打开"。
let associationCache;
export function associatedProgram(ext) {
  if (!ext) return null;
  associationCache ||= new Map();
  if (associationCache.has(ext)) return associationCache.get(ext);
  let via = null;
  try {
    // 查 HKCR 的 <ext> → ProgId（与 assoc 等价），一次问一个扩展名，超时保护。
    const script = `$ErrorActionPreference='SilentlyContinue'; (Get-ItemProperty ('Registry::HKEY_CLASSES_ROOT\\' + $env:BEAT_EXT)).'(default)'`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 8000, windowsHide: true, env: { ...process.env, BEAT_EXT: ext },
    });
    const out = String(r.stdout || '').trim();
    if (r.status === 0 && out) via = out;
  } catch { /* 查不到就当没有关联 */ }
  associationCache.set(ext, via);
  return via;
}

/** 找一个能打开文本/代码文件的编辑器（VS Code 优先，其次记事本）。
 *  注意：不能直接 spawn `code.cmd`（批处理需要 shell，Node 在 Windows 上会抛 spawn EINVAL，实测）。
 *  所以要从 code.cmd 反推出同目录的 Code.exe，或直接查常见安装位置。 */
let editorCache;
export function textEditor() {
  if (editorCache !== undefined) return editorCache;
  editorCache = null;
  const found = [];
  const where = spawnSync('where', ['code.cmd'], { encoding: 'utf8', timeout: 6000, windowsHide: true });
  const cmd = String(where.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  if (cmd) {
    // D:\Microsoft VS Code\bin\code.cmd → D:\Microsoft VS Code\Code.exe
    const root = path.dirname(path.dirname(cmd));
    for (const exe of ['Code.exe', 'code.exe']) { const p = path.join(root, exe); if (fs.existsSync(p)) { found.push([p, []]); break; } }
  }
  for (const p of [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft VS Code', 'Code.exe'),
    'D:\\Microsoft VS Code\\Code.exe',
  ]) if (p && fs.existsSync(p) && !found.some(f => f[0] === p)) found.push([p, []]);
  const notepad = path.join(process.env.SystemRoot || 'C:\\Windows', 'system32', 'notepad.exe');
  if (fs.existsSync(notepad)) found.push([notepad, []]);
  editorCache = found[0] || null;
  return editorCache;
}

/** 启动外部 GUI 程序时要清掉的环境变量。
 *  BEAT 的服务进程继承自 Electron 启动器，环境里有 ELECTRON_RUN_AS_NODE=1；
 *  任何 Electron 程序（VS Code 就是）拿到它都会**退化成 Node 进程**：不显示界面、秒退、还不报错。
 *  客户实测：点交付物提示"已打开"但什么都没出现——根因就在这。 */
function guiEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * 用系统默认程序打开；reveal=true 时在资源管理器里定位这个文件。
 * 返回里带 via / associated，调用方据此如实告诉客户——绝不谎报"已打开"。
 *   default-app：系统有默认程序，已交给它
 *   editor-fallback：该扩展名没有默认程序，已用编辑器（VS Code/记事本）打开
 *   explorer-select：在资源管理器里选中了它
 *   explorer-open：没有默认程序也没有编辑器，退回"在资源管理器里打开"
 */
export async function openWithDefaultApp(file, { isDirectory = false, reveal = false, spawnProcess = spawn, timeoutMs = 20000 } = {}) {
  if (process.platform !== 'win32') {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawnProcess(command, [file], { detached: true, stdio: 'ignore', env: guiEnv() });
    child.on?.('error', () => {});
    child.unref?.();
    return { opened: file, via: command, associated: true, verified: false, status: 'requested' };
  }
  const ext = path.extname(file);
  const associated = isDirectory || reveal || !!associatedProgram(ext);
  const editor = associated ? null : textEditor();
  const mode = isDirectory ? 'folder' : reveal || (!associated && !editor) ? 'reveal' : 'file';
  const via = mode === 'folder' ? 'explorer-open' : mode === 'reveal' ? 'explorer-select' : editor ? 'editor-fallback' : 'default-app';
  let documentTitle = '';
  if (/^\.(html?|svg)$/i.test(ext)) {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(65536);
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        documentTitle = /<title\b[^>]*>([^<]{4,300})<\/title\s*>/i.exec(buffer.toString('utf8', 0, length))?.[1]?.trim() || '';
      } finally { fs.closeSync(fd); }
    } catch { /* Window verification can still use the filename or process. */ }
  }
  const env = { ...guiEnv(), BEAT_OPEN_PATH: file, BEAT_OPEN_MODE: mode, BEAT_OPEN_EDITOR: editor?.[0] || '', BEAT_OPEN_TITLE: documentTitle };
  const receipt = await new Promise((resolve, reject) => {
    let stdout = '', settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (err) reject(err); else resolve(result);
    };
    const timer = setTimeout(() => { child.kill?.(); finish(new Error('打开操作超时，请点“预览”查看内容，或再试一次打开所在文件夹')); }, timeoutMs);
    let child;
    try {
      child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./open-delivered.ps1', import.meta.url))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.resume();
      child.once('error', () => finish(new Error('系统未能启动打开操作，请点“预览”查看内容')));
      child.once('close', code => {
        if (code !== 0) { finish(new Error('系统未能显示目标窗口，请点“预览”查看内容，或重试打开所在文件夹')); return; }
        try {
          const result = JSON.parse(stdout.trim());
          if (!['verified', 'requested'].includes(result.status) || (result.status === 'verified' && result.window?.visible !== true)) throw new Error('invalid receipt');
          finish(null, result);
        } catch { finish(new Error('没有收到可靠的打开回执，请点“预览”查看内容')); }
      });
    } catch { finish(new Error('系统未能启动打开操作，请点“预览”查看内容')); }
  });
  return { opened: file, via, associated, extension: ext, ...(editor ? { editor: path.basename(editor[0]) } : {}), ...receipt, verified: receipt.status === 'verified' };
}
