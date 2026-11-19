// ZCode 搭档真实冒烟：真的调用本机 ZCode CLI（消耗少量额度）。不进 npm test。
// 前置：config.json 里 zcode.enabled=true，且已完成一次 `zcode login zai` 浏览器授权。
// 用法：node tests/live-zcode.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askZcode, detectZcodeRuntime } from '../src/zcode.mjs';
import { loadConfig } from '../src/config.mjs';

const config = loadConfig('E:/beat');
if (config.zcode?.enabled !== true) {
  console.log('未启用：config.json 里设置 zcode.enabled=true 后再跑本冒烟。');
  process.exit(1);
}
const runtime = detectZcodeRuntime(config);
console.log('CLI:', runtime.available ? runtime.cli : runtime.reason);
if (!runtime.available) process.exit(1);

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-live-'));
console.log('工作目录:', workdir);
const t0 = Date.now();
const result = await askZcode(config, {
  prompt: '只回复两个字母：OK',
  model: config.zcode.defaultModel || 'zai/glm-5.3',
  cwd: workdir,
  access: 'read-only',
  timeoutMs: 240_000,
  onNative: id => console.log('sessionId:', id),
  onUsage: u => console.log('usage(流式):', JSON.stringify(u)),
});
console.log('\n=== 结果 ===');
console.log('text:', result.text);
console.log('model:', result.actualModel, '| verified:', result.modelVerified);
console.log('usage:', JSON.stringify(result.usage));
console.log('nativeId:', result.nativeId);
console.log('耗时:', Math.round((Date.now() - t0) / 1000) + 's');
if (!/OK/i.test(result.text)) { console.log('\n冒烟失败：回复不含 OK'); process.exit(1); }
console.log('\n冒烟通过 ✅');
