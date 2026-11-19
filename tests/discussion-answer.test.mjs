import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiscussionAnswer, composeDiscussionResult, pickDiscussionAnswer, RESULT_DETAIL_MARK } from '../src/compact-discussion.mjs';

// R431 实测：讨论答复直接是"技术路线/实施步骤/分工"，客户要自己从 1.9 万字里找结论。
// 现在：结论在前（≤300 字），方案全文折进详情；直接问答保持原文。

test('短结论 + 长方案：结论放前面，方案全文进折叠详情', () => {
  const full = '### 技术路线\n' + '很长的方案正文。'.repeat(200);
  const split = splitDiscussionAnswer({ summary: '建议采用本地优先的分阶段改造。', full });
  assert.equal(split.answer, '建议采用本地优先的分阶段改造。');
  assert.equal(split.detail, full);
  const text = composeDiscussionResult({ base: full, summary: split.answer });
  assert.ok(text.startsWith('建议采用本地优先的分阶段改造。'));
  assert.ok(text.includes(RESULT_DETAIL_MARK));
  assert.ok(text.length > 1000, '方案全文仍然保留，只是折进详情');
});

test('结论超过 300 字：在句号/分号/换行处截断，不把一句话切一半', () => {
  const sentence = '第一步先确认目标，第二步再拆分任务，第三步补上验收标准。';
  const summary = sentence.repeat(30);
  const split = splitDiscussionAnswer({ summary, full: summary });
  assert.ok(split.answer.length <= 301, '答复长度必须 ≤300 字左右，实际 ' + split.answer.length);
  assert.ok(/[。；！？]$/.test(split.answer), '优先在完整句子处停：' + split.answer.slice(-20));
  assert.equal(split.detail, summary, '完整方案不能丢');
});

test('没有摘要时用第一段；没有全文时摘要就是全文', () => {
  const full = '先给结论：这个方案可行。\n\n下面是实施细节，可以稍后再看。';
  const split = splitDiscussionAnswer({ full });
  assert.equal(split.answer, '先给结论：这个方案可行。');
  assert.equal(split.detail, full);
  assert.deepEqual(splitDiscussionAnswer({ summary: '只有一句结论。' }), { answer: '只有一句结论。', detail: null });
  assert.deepEqual(splitDiscussionAnswer({}), { answer: '', detail: null });
});

test('直接要答案的问题不折叠：即使超过 300 字也保留完整答复', () => {
  const answer = '结论：' + '依据说明。'.repeat(120);
  const text = composeDiscussionResult({ base: answer, direct: true });
  assert.equal(text, answer);
  assert.ok(!text.includes(RESULT_DETAIL_MARK));
});

test('裁决结果如实标注，并且说明在结论之前', () => {
  const text = composeDiscussionResult({ base: '采用方案 B。', summary: '采用方案 B。', consensus: true, adjudicated: true, advisorUsed: true });
  assert.ok(text.startsWith('⚖ 部分分歧由顾问 Claude 裁定'));
  assert.ok(text.includes('采用方案 B。'));
});

test('讨论的 plan.summary 是内部计划时，优先把顾问综合参考里的核心结论给客户', () => {
  const full = '以简短结论回答小团队选工具最应关注的三点。\n\n技术路线\n围绕三点组织讨论……\n\n顾问综合参考（四家答案合并）：核心结论：先看流程匹配、易用性和总体成本。执行约束：不推荐具体产品。';
  const picked = pickDiscussionAnswer({ summary: '以简短结论回答小团队选工具最应关注的三点。', full });
  assert.match(picked, /^先看流程匹配/);
  const text = composeDiscussionResult({ base: full, summary: '以简短结论回答小团队选工具最应关注的三点。' });
  assert.match(text, /^先看流程匹配/);
  assert.match(text, /以下为详细过程记录/);
});
