import test from 'node:test';
import assert from 'node:assert/strict';
import { quietLimitMs, rememberQuietGap } from '../src/stall.mjs';

const memory = () => { const m = new Map(); return { get: k => m.get(k), set: (k, v) => m.set(k, v) }; };
const MIN = 60000;

test('卡住判断由 BEAT 自己决定：按搭档类型和推理强度起步', () => {
  const s = memory();
  assert.equal(quietLimitMs(s, 'codex'), 10 * MIN);
  assert.equal(quietLimitMs(s, 'dock:qwen'), 5 * MIN);
  assert.equal(quietLimitMs(s, 'codex', 'xhigh'), 25 * MIN, '高推理强度允许更长的思考静默');
});

test('成功完成过的长静默会自动放宽判断，且有上限，不会无限等', () => {
  const s = memory();
  rememberQuietGap(s, 'codex', 14 * MIN);
  assert.equal(quietLimitMs(s, 'codex'), 28 * MIN, '曾静默 14 分钟后正常完成 → 下次放宽到 28 分钟');
  assert.equal(quietLimitMs(s, 'deepseek'), 10 * MIN, '只影响这位搭档');
  rememberQuietGap(s, 'codex', 50 * MIN);
  assert.equal(quietLimitMs(s, 'codex'), 60 * MIN);
  for (let i = 0; i < 25; i++) rememberQuietGap(s, 'codex', MIN);
  assert.equal(quietLimitMs(s, 'codex'), 10 * MIN, '只保留最近 20 次，老的极端值会淡出');
});
