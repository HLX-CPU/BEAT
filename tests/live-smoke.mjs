// 实机冒烟：三方各问一句（只读、极短），不经过服务端口。
import { loadConfig } from '../src/config.mjs';
import { askCodex } from '../src/codex.mjs';
import { askDeepseek } from '../src/deepseek.mjs';
import { testClaude } from '../src/claude.mjs';
import { resolveWorkspace } from '../src/workspace.mjs';

const config = loadConfig();
const cwd = resolveWorkspace(config);
const timed = async (name, fn) => {
  const t0 = Date.now();
  try { const r = await fn(); console.log(`✔ ${name} ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(r).slice(0, 300)); }
  catch (e) { console.log(`✖ ${name} ${Math.round((Date.now() - t0) / 1000)}s`, e.message.slice(0, 400)); }
};
await Promise.all([
  timed('Claude', () => testClaude(config)),
  timed('DeepSeek', () => askDeepseek(config, { prompt: '只回复：DS_OK', cwd, timeoutMs: 300000 })),
  timed('Codex', () => askCodex(config, { prompt: '只回复：CODEX_OK', cwd, timeoutMs: 300000, title: 'BEAT · 冒烟测试' })),
]);
