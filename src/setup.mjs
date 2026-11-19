// 接入：把 beat MCP 注册到 Codex（D:/Codex/config.toml）和 DeepSeek 桌面端（~/.dsh/profiles/desktop/cordis.patch.yml）。
// 同时清掉旧的 beat / bridge 接入项。改之前都会备份到 data/backups/。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';

// 配置惰性加载。以前这里是模块顶层直接 `const config = loadConfig()`，于是**只要 import 这个模块**
// 就会触发生成并写入 secrets.local.json（实测：interfaces 测试 import 它之后，产品目录里多出一个
// 令牌文件）。导入模块不该有写文件的副作用——改成用到时才加载。
let _config = null;
const ensureConfig = () => (_config ||= loadConfig());
const config = new Proxy({}, { get: (_t, key) => ensureConfig()[key] });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const node = process.execPath.replaceAll('\\', '/');

// 这两个路径同样依赖配置：原来在顶层求值（同样会触发加载），改成用到时才求值。
let _backups = null, _mcp = null, _plugin = null;
const backups = () => (_backups ||= path.join(config.dataDir, 'backups'));
const mcp = () => (_mcp ||= path.join(config.root, 'src', 'mcp.mjs').replaceAll('\\', '/'));
const plugin = () => (_plugin ||= path.join(config.root, 'src', 'deepseek-sidebar-plugin.mjs'));

// ---- Codex：删除 [mcp_servers.beat*] 与 [mcp_servers.bridge*] 表，追加新表 ----
export function rewriteCodexToml(text) {
  const out = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/);
    if (header) skipping = /^mcp_servers\.(beat|bridge)(\.|$)/.test(header[1]);
    if (!skipping) out.push(line);
  }
  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return `${body}\n\n[mcp_servers.beat]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(mcp())}, "--as", "codex"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 600\ndefault_tools_approval_mode = "approve"\n`;
}

// ---- DeepSeek：按顶层条目切分，删掉引用旧 beat/bridge 的条目（含旧的侧栏插件与 hmr），追加新条目 ----
const OLD = /mcp-beat|mcp-bridge|beat-desktop-history|deepseek-sidebar|beat\/src\/mcp\.mjs|bridge\/bin\/mcp|BEAT history source reload|^- id: hmr\b[\s\S]*beat\/src\//m;
function pluginUrl() {
  let hash = 'missing';
  try { hash = createHash('sha256').update(fs.readFileSync(plugin())).digest('hex').slice(0, 12); } catch { /* 文件缺失时仍生成条目 */ }
  return pathToFileURL(plugin()).href + '?v=' + hash;
}
export function rewriteDeepseekPatch(text) {
  const preamble = [], entries = [];
  let pending = [], current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^- /.test(line)) { current = [...pending, line]; pending = []; entries.push(current); }
    else if (!current) preamble.push(line);                                  // 文件头注释
    else if (/^(#.*)?\s*$/.test(line)) pending.push(line);                     // 顶格注释/空行：归属下一个条目
    else { current.push(...pending, line); pending = []; }                     // 条目内容
  }
  const tail = pending.join('\n').trim();
  const kept = entries.map(e => e.join('\n').trim()).filter(e => !OLD.test(e));
  const entry = [
    '# BEAT 三方协同（Codex 指挥 / DeepSeek 执行 / Claude 顾问）',
    '- insert:', '    - id: mcp-beat', "      name: '@deepseek-ai/dsh-mcp-client'", '      config:',
    '        serverName: beat', '        transport: stdio', `        command: ${JSON.stringify(node)}`,
    `        args: [${JSON.stringify(mcp())}, "--as", "deepseek"]`, `        cwd: ${JSON.stringify(config.root.replaceAll('\\', '/'))}`,
    '        toolCallTimeoutMs: 600000',
    // 会话列表实时刷新：桌面端加载 BEAT 插件，BEAT 每次后台跑完就通知它登记会话（URL 带内容哈希，插件更新后自动换新）
    '# BEAT：后台会话实时出现在桌面端会话列表',
    '- insert:', '    - id: beat-desktop-history', `      name: ${JSON.stringify(pluginUrl())}`, '      config:',
    `        allowedRoots: ${JSON.stringify(config.allowedRoots)}`,
    '- id: hmr', '  config:', '    root:', `      - ${JSON.stringify(plugin().replaceAll('\\', '/'))}`,
  ].join('\n');
  return [preamble.join('\n').trimEnd(), ...kept, tail && !OLD.test(tail) ? tail : '', entry].filter(Boolean).join('\n') + '\n';
}

function patchFile(file, label, rewrite) {
  if (!fs.existsSync(file)) { console.log(`跳过 ${label}：找不到 ${file}`); return; }
  const before = fs.readFileSync(file, 'utf8');
  const after = rewrite(before);
  if (after === before) { console.log(`${label}：已是最新`); return; }
  const backup = path.join(backups(), `${label}-${stamp}${path.extname(file)}`);
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, after);
  console.log(`${label}：已注册 beat（原文件备份：${backup}）`);
}

if (process.argv.includes('--dry-run')) {
  // 不落盘，只打印改写结果，便于检查。
  const dsh = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop', 'cordis.patch.yml');
  console.log(rewriteDeepseekPatch(fs.readFileSync(dsh, 'utf8')));
} else if (!process.env.BEAT_SETUP_IMPORT_ONLY) {
  fs.mkdirSync(backups(), { recursive: true });
  fs.mkdirSync(config.workspace, { recursive: true });
  patchFile(path.join(config.codex.home, 'config.toml'), 'codex-config', rewriteCodexToml);
  patchFile(path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop', 'cordis.patch.yml'), 'deepseek-desktop-patch', rewriteDeepseekPatch);
  console.log('完成。已经打开的 Codex / DeepSeek 桌面端需要重启（或重新加载 MCP）才能看到 beat 工具。');
}
