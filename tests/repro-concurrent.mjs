// 复现 R11 的现象：两个执行席位并发，其中一个席位的原生会话被另一个席位/进程占用时，
// provider 会报 "already has an active writer" / "already owned by an active write handle"。
// 这里直接用同一个原生 ID 并发发起两次写，看是否必然出这个错。
import { loadConfig } from '../src/config.mjs';
import { askCodex } from '../src/codex-engine.mjs';
import { askDeepseek } from '../src/deepseek.mjs';
import { resolveWorkspace } from '../src/workspace.mjs';

const config = loadConfig();
const cwd = resolveWorkspace(config);

const first = await askCodex(config, { prompt: '只回复 SEED', cwd, timeoutMs: 300000, title: 'BEAT · 并发诊断' });
console.log('seed native =', first.nativeId);
const id = first.nativeId;

const both = await Promise.allSettled([
  askCodex(config, { prompt: '只回复 P1', cwd, nativeId: id, timeoutMs: 300000 }),
  askCodex(config, { prompt: '只回复 P2', cwd, nativeId: id, timeoutMs: 300000 }),
]);
for (const [i, r] of both.entries()) console.log('P' + (i + 1), r.status, r.status === 'fulfilled' ? JSON.stringify(r.value.text.slice(0, 30)) : r.reason.message.slice(0, 200));

const ds = await askDeepseek(config, { prompt: '只回复 DSEED', cwd, timeoutMs: 300000 });
console.log('ds native =', ds.nativeId);
const dsBoth = await Promise.allSettled([
  askDeepseek(config, { prompt: '只回复 Q1', cwd, nativeId: ds.nativeId, timeoutMs: 300000 }),
  askDeepseek(config, { prompt: '只回复 Q2', cwd, nativeId: ds.nativeId, timeoutMs: 300000 }),
]);
for (const [i, r] of dsBoth.entries()) console.log('Q' + (i + 1), r.status, r.status === 'fulfilled' ? JSON.stringify(r.value.text.slice(0, 30)) : r.reason.message.slice(0, 200));
process.exit(0);
