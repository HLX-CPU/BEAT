import test from 'node:test';
import assert from 'node:assert/strict';
import { customerIssue, runCustomerIssue } from '../src/customer-issue.mjs';
import { failureRecord } from '../src/failure-record.mjs';

const contextRaw = 'DeepSeek 执行失败（退出码 1）：DeepSeek 本轮结束原因：{"kind":"error","error":{"message":"This model\'s maximum context length is 1048576 tokens. However, you requested 1330538 tokens (1074538 in the messages, 256000 in the completion).","code":"CO"}}';

test('R368 回归：上下文超限不把提供方英文 JSON 甩给客户', () => {
  const issue = customerIssue(contextRaw);
  assert.equal(issue.title, '任务内容超过模型上限');
  assert.match(issue.message, /上下文/);
  assert.match(issue.message, /拆小|减少附件/);
  assert.doesNotMatch(issue.message, /maximum context length|request_id|\{"kind"/);
});

test('提供方 5xx / 站点故障翻成人话，并给下一步', () => {
  const issue = customerIssue('Claude 调用失败：站点/上游故障（HTTP 522）');
  assert.equal(issue.title, '对方服务暂时故障');
  assert.match(issue.message, /HTTP 522/);
  // An unbound API error has no resumable task or continue button.
  assert.match(issue.message, /关闭提示.*任务列表.*核对进度和成果/);
  assert.deepEqual(issue.actions, [{id:'dismiss',label:'关闭提示'}]);
  assert.doesNotMatch(issue.message, /余额|密钥|充值/);
});

test('未映射的原始接口错误也不直接展示英文 JSON', () => {
  const issue = customerIssue('执行失败：{"kind":"error","error":{"message":"boom"}} request_id=x');
  assert.equal(issue.title, '搭档接口返回错误');
  assert.doesNotMatch(issue.message, /\{"kind"|request_id/);
  assert.match(issue.message, /关闭提示.*任务列表.*核对进度和成果/);
  assert.doesNotMatch(issue.message, /点「继续」/);
});

test('验收失败不再被误判成“独立核验搭档不足”', () => {
  const result = '❌ 仍有小任务或整体结果未通过验收\n结论：仍有小任务未通过验收\n验收逐项：\n❌ 交付单文件｜由独立搭档复核（未通过）';
  assert.equal(failureRecord({ state: 'failed', result, steps: [] }).category, 'acceptance');
  assert.equal(failureRecord({ state: 'failed', error: '没有足够的独立核验搭档，至少需要两位在线搭档' }).category, 'participants');
  assert.equal(failureRecord({ state: 'failed', error: 'maximum context length is 1048576 tokens' }).category, 'context');
});

test('验收失败给客户“还差几项 + 下一步”，而不是笼统的“任务没有完成”', () => {
  const view = {
    state: 'failed', kind: 'parallel', error: null, steps: [], tokenUsage: { totalTokens: 1000 },
    result: '❌ 仍有小任务或整体结果未通过验收\n结论：仍有小任务未通过验收\n验收逐项：\n❌ 动画不循环｜由独立搭档复核（未通过）\n❌ 帧率不足｜由独立搭档复核（未通过）',
  };
  const issue = runCustomerIssue(view);
  assert.equal(issue.title, '任务没有通过验收（已有产物保留）');
  assert.match(issue.message, /2 项验收没有通过/);
  assert.match(issue.message, /动画不循环/);
  assert.match(issue.message, /核对后继续原任务/);
  assert.ok(!/^❌/m.test(issue.message));
});


test('失败原因取当前验收结论，不被早已重试成功的早期步骤错误盖住（R408 回归）', () => {
  const issue = 'A4排版网页制作：验收中，核验图片尚未准备完整：文件里没有内联 <svg>，不属于可视化交付物，未做渲染核验';
  const failure = failureRecord({
    state: 'failed',
    issues: [issue],
    steps: [{ id: 1, agent: 'deepseek', role: 'discuss', error: '提纲未按统一关键决策编号给出选择：必须包含 route、sequence、risk' }],
  });
  assert.match(failure.message, /核验图片尚未准备完整/);
  assert.doesNotMatch(failure.message, /route、sequence、risk/);
  assert.equal(failure.category, 'image_input');
  assert.deepEqual(failure.issues, [issue]);
});

test('原生会话丢失：失败分类与客户提示是人话，不再把原始 CLI 报错甩给客户（R408 回归）', () => {
  const raw = '渲染PDF并校验：暂时受阻，DeepSeek 执行失败（退出码 1）：session "session-f66e1872-88e8-41f9-a8b0-135c56d4c70c" does not exist; omit --session-id to start a new Session';
  const failure = failureRecord({ state: 'failed', issues: [raw], steps: [] });
  assert.equal(failure.category, 'session');
  const issue = customerIssue(raw, { run: { kind: 'parallel', state: 'failed' }, steps: [] });
  assert.equal(issue.title, '搭档原会话已不可用');
  assert.match(issue.message, /会话.*找不到了|换了登录目录/);
  assert.doesNotMatch(issue.message, /omit --session-id|session-f66e/);
});
