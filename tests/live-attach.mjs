// 实机：上传一张截图，分别问 Codex（low 强度）和 DeepSeek（high 强度）图里写了什么。
// 用法：node tests/live-attach.mjs <图片路径>
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

const config = loadConfig();
const base = `http://127.0.0.1:${config.port}`;
const auth = { Authorization: 'Bearer ' + config.secrets.token };
const img = process.argv[2];
if (!img) { console.log('用法：node tests/live-attach.mjs <图片路径>'); process.exit(1); }

const up = await (await fetch(base + '/api/upload', { method: 'POST', headers: { ...auth, 'X-File-Name': encodeURIComponent(path.basename(img)) }, body: fs.readFileSync(img) })).json();
console.log('upload:', up.ok ? `${up.result.id} ${up.result.name} ${up.result.size}B image=${up.result.image}` : up.error);
if (!up.ok) process.exit(1);

const call = async (name, args) => (await (await fetch(base + '/api/call', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args }) })).json());
for (const [to, effort] of [['codex', 'low'], ['deepseek', 'high']]) {
  const r = await call('beat_ask', { to, effort, attachments: [up.result.id], question: '附件是一张界面截图。请只回答：截图里显示的模型名称和推理强度分别是什么？', wait_seconds: 240 });
  if (!r.ok) { console.log(to, 'ERROR', r.error); continue; }
  const s = r.result.steps?.[0] || {};
  console.log(`${to} [${r.result.id}] state=${r.result.state} effort=${s.effort} model=${s.actualModel || s.requestedModel}\n  → ${(r.result.result || r.result.error || '').replace(/\n/g, ' ').slice(0, 200)}`);
}
// 设置：非法强度应被拒绝
const bad = await call('beat_ask', { to: 'deepseek', effort: 'ultra', question: 'x' });
console.log('非法强度 deepseek/ultra →', bad.ok ? '未拒绝！' : bad.error);
process.exit(0);
