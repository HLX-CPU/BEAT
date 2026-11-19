import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 客户不需要读 JSON：三态、下一步、审计/护栏必须在看板上直接可见。
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const kb = n => Math.max(1, Math.round(Number(n || 0) / 1024)) + ' KB';
// 分别取两个函数，避免依赖函数声明顺序。
function load(name, nextName) {
  const start = script.indexOf('function ' + name + '(r) {');
  const end = script.indexOf('function ' + nextName, start);
  assert.ok(start > 0 && end > start, '找不到渲染函数：' + name);
  const context = vm.createContext({ esc, kb, Date, Math, Number, String, Array, Object, JSON, Set, Boolean, RegExp, Error });
  vm.runInContext(script.slice(start, end), context);
  return context;
}
const customer = extra => ({ active: false, label: '已完成', elapsedSeconds: 65, artifacts: [], usage: { calls: 2, tokens: 100, estimated: 0, budgetEnforced: false, notice: '' }, ...extra });

test('看板三态：已核验绿色、待核对黄色、未通过红色，并给出下一步按钮', () => {
  const { customerOverview } = load('customerOverview', 'executionEvidencePanel');
  const verified = customerOverview({ triage: { status: 'verified', label: '已完成并核验', next: '已完成', actions: [{ id: 'inspect', label: '查看现有文件' }] }, customer: customer() });
  assert.match(verified, /triage-verified/); assert.match(verified, /已完成并核验/);
  assert.match(verified, /data-triage="inspect"/); assert.match(verified, /查看现有文件/);

  const pending = customerOverview({ triage: { status: 'pending', label: '成果已保留，待核对', next: '只核验已有成果，不重复执行', note: '不会重做原操作', actions: [{ id: 'resume', label: '只核验已有成果' }] }, customer: customer() });
  assert.match(pending, /triage-pending/); assert.match(pending, /只核验已有成果/); assert.match(pending, /不会重做原操作/);

  const failed = customerOverview({ triage: { status: 'failed', label: '未通过', next: '检查原因后重试未完成的部分', actions: [{ id: 'resume', label: '检查原因后重试' }] }, customer: customer() });
  assert.match(failed, /triage-failed/); assert.match(failed, /检查原因后重试/);
});

test('没有三态数据的旧任务仍然显示原来的状态，不白屏', () => {
  const { customerOverview } = load('customerOverview', 'executionEvidencePanel');
  const htmlText = customerOverview({ customer: customer({ active: true, label: '正在制作', who: 'DeepSeek', phase: '执行' }) });
  assert.match(htmlText, /正在制作/); assert.match(htmlText, /已用时 <span data-since=/);
  assert.doesNotMatch(htmlText, /triage-/);
});

test('执行审计与护栏：数量、高危、可复核性一眼可见，原始记录折叠且转义', () => {
  const { executionEvidencePanel } = load('executionEvidencePanel', 'installArtifactActions');
  const panel = executionEvidencePanel({
    executionAudit: { count: 3, highRisk: [{ tool: 'shell', label: '删除或覆盖文件' }], filesTouched: ['a.txt'], replayable: true },
    executionAudits: { T1: { count: 2, highRisk: [], filesTouched: ['b.txt'], replayable: false } },
    guardrails: { input: { level: 'ok', reasons: [] }, execution: { level: 'warn', reasons: ['执行层提醒 <b>'] }, output: { level: 'ok', reasons: [] } },
  });
  assert.match(panel, /5 个动作/); assert.match(panel, /写入 2 个文件/); assert.match(panel, /高危 1 项/);
  assert.match(panel, /有未确认动作，不能自动重放/);
  assert.match(panel, /执行层提醒 &lt;b&gt;/); assert.doesNotMatch(panel, /<b>/);
  assert.match(panel, /高危动作（需要人工核对）/); assert.match(panel, /审计与护栏原始记录/);
  assert.equal(executionEvidencePanel({}), '');
});

test('预览在点开始前就告诉客户预计档位和 token 量级', () => {
  assert.match(html, /p\.costSummary/);
  assert.match(html, /#askRoutePreview \{ min-height:44px; white-space:pre-wrap; \}/);
});

test('讨论结果在看板上先显示结论，方案全文折进"详细交付报告"', () => {
  const start = script.indexOf('function resultPanel(r) {');
  const end = script.indexOf('const runStateClass', start);
  assert.ok(start > 0 && end > start);
  const MARK = '\n（以下为详细过程记录，看板上可折叠）';
  const context = vm.createContext({
    esc, kb, customerResult: r => r.result, mdLite: value => String(value),
    linkify: value => String(value), RESULT_DETAIL_MARK: MARK,
  });
  vm.runInContext(script.slice(start, end), context);
  const result = context.resultPanel({ result: '结论：分三步实施。' + MARK + '\n技术路线正文……' });
  assert.match(result, /result-summary/);
  assert.match(result, /结论：分三步实施。/);
  assert.match(result, /result-detail/);
  assert.match(result, /技术路线正文/);
  assert.ok(result.indexOf('结论：分三步实施。') < result.indexOf('result-detail'));
});
