// 判定实验：
//  A) 关闭「在桌面端打开」→ 并发写同一线程                    （是不是 BEAT 自己的并发问题）
//  B) 开启「在桌面端打开」→ 等桌面端加载后再写同一线程          （是不是桌面端占了写句柄）
//  C) B 失败的话，隔一段时间重试能否自愈
import { loadConfig } from '../src/config.mjs';
import { askCodex } from '../src/codex-engine.mjs';
import { resolveWorkspace } from '../src/workspace.mjs';

const base = loadConfig();
const cwd = resolveWorkspace(base);
const withOpen = open => ({ ...base, flow: { ...base.flow, codexOpenInDesktop: open } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tryAsk = async (cfg, label, prompt, nativeId) => {
  const r = await askCodex(cfg, { prompt, cwd, nativeId, timeoutMs: 300000, title: 'BEAT · writer 判定' })
    .then(v => ({ ok: true, v }), e => ({ ok: false, e: e.message.slice(0, 120) }));
  console.log(`  ${label}: ${r.ok ? '✔ ' + JSON.stringify(r.v.text.slice(0, 20)) : '✖ ' + r.e}`);
  return r;
};

console.log('A) 关闭桌面打开，并发两次写同一线程');
const a = await tryAsk(withOpen(false), 'A0 建线程', '只回复 A0');
await Promise.all([tryAsk(withOpen(false), 'A1', '只回复 A1', a.v.nativeId), tryAsk(withOpen(false), 'A2', '只回复 A2', a.v.nativeId)]);

console.log('B) 开启桌面打开，建线程后等 12 秒再写');
const b = await tryAsk(withOpen(true), 'B0 建线程', '只回复 B0');
for (let i = 1; i <= 3; i++) { await sleep(12000); const r = await tryAsk(withOpen(true), `B${i} (等${i * 12}s)`, '只回复 B' + i, b.v.nativeId); if (r.ok) break; }
process.exit(0);
