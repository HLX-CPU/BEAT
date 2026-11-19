// 真实缺陷回归：提示词原本没写长度上限，校验却按 240 字硬拒并终止整轮讨论
// （R82 里 Codex 的提纲 JSON 完整合法，只是每条写得长，就被判"缺少核心思路、步骤、风险或决策"）。
// 现在：提示词写明建议长度；自由文本超出只做有界截断并标记；确实缺内容才拒绝，且错误信息精确到字段。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCompact } from '../src/compact-discussion.mjs';

const decision = (id, extra = {}) => ({ id, option: 'A', reason: '简单可靠', category: 'ordinary', serious: false, ...extra });
const base = extra => ({ core: '按接口处理', steps: ['实现'], risks: ['异常中断'], decisions: [decision('route'), decision('sequence'), decision('risk')], ...extra });

test('提纲自由文本偏长只做有界截断，不再判成缺少内容', () => {
  const long = 'x'.repeat(300);
  const value = parseCompact(JSON.stringify(base({ core: 'y'.repeat(700), steps: [long, '正常'], risks: [long] })), 'outline');
  assert.equal(value.core.length, 600);
  assert.deepEqual(value.steps, ['x'.repeat(240), '正常']);
  assert.equal(value.risks[0].length, 240);
  assert.equal(value.truncated, true, '截断要留下标记，便于看板说明');
  assert.deepEqual(value.decisions.map(d => d.id), ['route', 'sequence', 'risk'], '决策结构不受影响，仍是有效投票依据');
});

test('确实缺内容仍然拒绝，错误信息指出具体字段', () => {
  assert.throws(() => parseCompact(JSON.stringify(base({ steps: [] })), 'outline'), /缺少关键步骤/);
  assert.throws(() => parseCompact(JSON.stringify(base({ steps: [''] })), 'outline'), /缺少关键步骤/);
  assert.throws(() => parseCompact(JSON.stringify(base({ risks: '不是数组' })), 'outline'), /风险必须是文字数组/);
  assert.throws(() => parseCompact(JSON.stringify(base({ core: '' })), 'outline'), /缺少核心思路/);
  assert.throws(() => parseCompact(JSON.stringify(base({ decisions: [] })), 'outline'), /缺少决策/);
});

test('决策字段的问题精确到第几项，不再统一报"决策不完整"', () => {
  assert.throws(() => parseCompact(JSON.stringify(base({ decisions: [decision('route'), { ...decision('sequence'), reason: 'z'.repeat(300) }, decision('risk')] })), 'outline'), /第 2 项决策的 reason 超过 240 字/);
  assert.throws(() => parseCompact(JSON.stringify(base({ decisions: [decision('route'), 'sequence', decision('risk')] })), 'outline'), /第 2 项决策必须是对象/);
  assert.throws(() => parseCompact(JSON.stringify(base({ decisions: [decision('route'), decision('sequence')] })), 'outline'), /必须包含 route、sequence、risk/);
  assert.throws(() => parseCompact(JSON.stringify(base({ decisions: [decision('route', { serious: true }), decision('sequence'), decision('risk')] })), 'outline'), /严重反对/);
});
