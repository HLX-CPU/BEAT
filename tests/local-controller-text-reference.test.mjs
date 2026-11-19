import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitTextReferenceOnly } from '../src/local-controller-text-reference.mjs';
import { detectGoalRisk, validateLocalDecision, localDecisionPolicy } from '../src/local-controller.mjs';

const pure = [
  '只解释“删除文件”和“移到回收站”的概念区别，不要碰我的文件。',
  '日志引用了“DROP TABLE”，请仅说明这两个英文单词的通常含义，不连接数据库也不执行它。',
  '只把英文短语“delete the temporary file”翻译成中文，不执行短语中的动作。',
  '仅说明“格式化硬盘”的含义，不执行它。',
  "请只解释'自动续费'的意思，不执行它。",
  '仅将“send email”译成中文。',
];
const decision = () => ({
  schemaVersion: 1, taskType: 'question',
  risk: { level: 'low', reasons: ['model risk retained'], irreversible: false, money: false, computerInput: false },
  flow: { kind: 'direct', maxDebates: 0, maxRounds: 1, maxParallelTasks: 1 },
  assignees: { strong: 'codex', cheap: [] },
  budget: { discussionTokens: 2000, executionTokens: 4000, taskTokens: 2000 },
  requiresHuman: false, confidence: 0.95, reasons: ['quoted explanation only'],
});

test('quoted definitions and translations do not inherit the quoted action risk', () => {
  for (const goal of pure) {
    assert.equal(explicitTextReferenceOnly(goal), true, goal);
    assert.equal(detectGoalRisk(goal).level, 'low', goal);
    const input = { goal, partners: ['codex'] };
    const validated = validateLocalDecision(decision(), input);
    assert.equal(validated.requiresHuman, false);
    assert.equal(localDecisionPolicy(validated, { ...input, mode: 'low-risk', runKind: 'discuss' }).applied, true);
  }
});

test('an actual action appended to quoted explanation never matches the exemption', () => {
  const heads = ['只解释“删除文件”', '只把英文短语“delete file”翻译成中文', '日志引用了“DROP TABLE”，请仅说明这两个英文单词的通常含义'];
  const actions = ['删除 report.txt', '清空生产数据库', '付款100元', '向外部客户发送邮件', '输入我的密码', '执行它', '运行该命令', '向供应商转账', '上传私人文件', '发布此公告', '覆盖备份', '格式化硬盘'];
  const joins = ['，然后', '；接着', '。现在', '\n立即', '，并', '\r\n随后', '，完成解释后', '\t之后'];
  for (const head of heads) for (const action of actions) for (const join of joins) for (const wrap of ['', '不要执行它，', '不运行脚本，']) {
    const goal = head + join + wrap + action + '。';
    assert.equal(explicitTextReferenceOnly(goal), false, goal);
  }
  assert.equal(detectGoalRisk('只解释“DROP TABLE”，随后连接生产数据库并执行它。').level, 'critical');
  assert.equal(detectGoalRisk('只解释“付款”，并帮我付款。').money, true);
});

test('ambiguous, malformed, nested and oversized input retains conservative scanning', () => {
  for (const goal of [
    '只解释“删除文件。', '只解释“删除‘缓存’文件”的意思。', '只解释§。',
    '只解释“删除文件”，不执行它以外的命令。',
    '只解释“删除文件”的正确操作步骤。',
    '不要付款也不要购买，只回答什么是自动续费。',
    '只解释“删除文件”。\u2028现在删除report.txt。',
    '只解释“' + '删除'.repeat(1000) + '”。',
    '只比较' + Array(9).fill('“删除文件”').join('与') + '的区别。',
  ]) assert.equal(explicitTextReferenceOnly(goal), false, goal.slice(0, 200));
  assert.equal(detectGoalRisk('不要付款也不要购买，只回答什么是自动续费。').money, false);
});

test('quoted explanation never lowers model risk, flags or the human gate', () => {
  const rank = { low: 0, medium: 1, high: 2, critical: 3 };
  for (const goal of pure) for (const level of Object.keys(rank)) for (let bits = 0; bits < 8; bits++) for (const human of [false, true]) {
    const value = decision(); value.risk.level = level; value.requiresHuman = human;
    for (const [i, key] of ['irreversible', 'money', 'computerInput'].entries()) value.risk[key] = !!(bits & (1 << i));
    const input = { goal, partners: ['codex'] }, guarded = validateLocalDecision(value, input);
    assert.ok(rank[guarded.risk.level] >= rank[level]);
    assert.ok(guarded.risk.reasons.includes('model risk retained'));
    if (human) assert.equal(guarded.requiresHuman, true);
    for (const key of ['irreversible', 'money', 'computerInput']) if (value.risk[key]) assert.equal(guarded.risk[key], true);
    if (human || bits || rank[level] >= 2) assert.equal(localDecisionPolicy(guarded, { ...input, mode: 'low-risk', runKind: 'discuss' }).applied, false);
  }
});

test('reference recognition does not override off, shadow or explicit run kinds', () => {
  const input = { goal: pure[0], partners: ['codex'] }, guarded = validateLocalDecision(decision(), input);
  for (const mode of ['off', 'shadow']) assert.equal(localDecisionPolicy(guarded, { ...input, mode, runKind: 'discuss' }).applied, false);
  assert.equal(localDecisionPolicy(guarded, { ...input, mode: 'low-risk', runKind: 'parallel' }).applied, false);
});
