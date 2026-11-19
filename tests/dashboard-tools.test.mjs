import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const between = (a, b) => script.slice(script.indexOf(a), script.indexOf(b, script.indexOf(a)));
const ACTIVE = ['queued','running','discussing','planning','executing','evaluating','verifying'];

test('完成/待补充只在状态从进行中变化时提醒一次，首次加载不刷屏', () => {
  const ctx = vm.createContext({ ACTIVE_RUN_STATES: ACTIVE });
  vm.runInContext(between('function transitionNotices(', 'function handleRunTransitions'), ctx);
  const first = ctx.transitionNotices(null, [{ id: 'R1', state: 'running' }]);
  assert.equal(first.first, true); assert.equal(first.out.length, 0);
  const done = ctx.transitionNotices(first.next, [{ id: 'R1', state: 'passed' }]);
  assert.equal(done.out.length, 1); assert.equal(done.out[0].id, 'R1');
  const same = ctx.transitionNotices(done.next, [{ id: 'R1', state: 'passed' }]);
  assert.equal(same.out.length, 0, '重复刷新不能重复提醒');
  const input = ctx.transitionNotices(same.next, [{ id: 'R1', state: 'waiting_input' }]);
  assert.equal(input.out.length, 1);
  const silent = ctx.transitionNotices({ R2: 'passed' }, [{ id: 'R2', state: 'passed' }]);
  assert.equal(silent.out.length, 0);
});

test('任务/问答搜索与筛选按任务号、目标、状态工作', () => {
  const ctx = vm.createContext({});
  vm.runInContext(between('const runNeedsAttention', 'function filteredRows'), ctx);
  const rows = [ { id:'R1', goal:'整理桌面通知', target:'deepseek', state:'passed', resultSnippet:'结论文本' }, { id:'R2', goal:'修复网页排版', target:'codex', state:'failed' }, { id:'R3', goal:'讨论预算', state:'waiting_input' } ];
  assert.equal(rows.filter(r => ctx.runMatchesFilter(r, 'r2', 'all')).length, 1);
  assert.equal(rows.filter(r => ctx.runMatchesFilter(r, '网页', 'all')).length, 1);
  assert.equal(rows.filter(r => ctx.runMatchesFilter(r, '', 'attention')).length, 2);
  assert.equal(rows.filter(r => ctx.runMatchesFilter(r, '', 'failed')).length, 1);
  assert.equal(rows.filter(r => ctx.runMatchesFilter(r, '', 'passed')).length, 1);
  assert.equal(rows.filter(r => ctx.runMatchesFilter(r, '结论文本', 'all')).length, 1, '结果片段也能搜到');
});

test('导出记录是完整 Markdown：目标/结果/成果/步骤，不出现 undefined', () => {
  const ctx = vm.createContext({ KIND: { ask:'问答', parallel:'并行' }, runStateLabel: r => r.state === 'passed' ? '已完成并核验' : r.state, customerResultText: r => r.result || '' });
  vm.runInContext(between('function runExportMarkdown(', 'window.addEventListener'), ctx);
  const md = ctx.runExportMarkdown({ id:'R9', kind:'parallel', state:'passed', goal:'做一个 demo', result:'完成', cwd:'E:\\\\work', initiator:'codex', target:'deepseek', created_at:'2026-10-19', customer:{artifacts:[{path:'E:\\\\work\\\\a.txt', verified:true}]}, steps:[{role:'执行', by:'DeepSeek', state:'done', output:'写入 a.txt'}] });
  assert.match(md, /# R9 做一个 demo/); assert.match(md, /## 目标/); assert.match(md, /## 结果/); assert.match(md, /## 成果/); assert.match(md, /a\.txt（已核验）/); assert.match(md, /### 1\. 执行/);
  assert.doesNotMatch(md, /undefined/);
  const withCp = ctx.runExportMarkdown({ id:'R9', kind:'ask', state:'passed', goal:'改文件', result:'完成', checkpoint:{ changes:[{path:'E:\\\\a.txt',kind:'modified',addedLines:1,removedLines:1}] }, customer:{artifacts:[]}, steps:[] });
  assert.match(withCp, /## 文件改动/); assert.match(withCp, /修改 E:\\\\a\.txt/);
});

test('看板有搜索/筛选、完成提醒入口、导出按钮，并在刷新后记住选中任务', () => {
  for (const id of ['runsSearch','runsFilter','askSearch','askFilter','notifyBtn']) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(script, /exportRunBtn/);
  assert.match(script, /localStorage\.setItem\('beat\.selected'/);
  assert.match(script, /localStorage\.getItem\('beat\.selected'\)/);
  assert.match(script, /checkpointRolledBack/);
  assert.match(script, /checkpointPartial/);
  assert.match(script, /文件改动部分撤销/);
  assert.match(script, /文件改动已撤销/);
  assert.match(script, /Notification\.requestPermission/);
  assert.match(script, /event\.key !== 'Escape'/);
});
test('任务文件夹、数据文件夹和待处理查看全部入口可用', () => {
  assert.match(html, /id="taskFolderBtn"/);
  assert.match(html, /chip-file filelink/);
  assert.match(html, /id="reuseGoalBtn"/);
  assert.match(html, /id="reaskBtn"/);
  assert.match(script, /会新增一次模型调用/);
  assert.match(script, /用这个目标再来一次/);
  assert.match(html, /id="storageOpenBtn"/);
  assert.match(html, /id="attentionAllBtn"/);
  assert.match(script, /api\('inspect_run_files'/);
  assert.match(script, /api\('open_data_folder'/);
  assert.match(script, /function bindAttachmentPanel\(t\)/);
  assert.match(html, /id="deepSearchModal"/);
  assert.match(script, /openDeepSearch\(/);
  assert.match(script, /deep-result" role="button"/);
  assert.match(script, /api\('run_search'/);
  assert.match(html, /aria-label="需求或问题"/);
  assert.match(html, /aria-label="在本任务里继续追问"/);
  assert.match(script, /bindAttachmentPanel\('follow'\)/);
  assert.match(script, /\$\('runsFilter'\)\.value = 'attention'/);
});
test('服务断开时显示可重试的横幅，不把页面留成静默旧状态', () => {
  assert.match(html, /id="serviceBanner"/);
  assert.match(html, /id="serviceRetryBtn"/);
  assert.match(script, /\$\('serviceBanner'\)\.hidden = false/);
  assert.match(script, /正在重新连接 BEAT 服务/);
});
test('长时间任务完成：页面隐藏时发系统通知并改标题；页面可见时只弹 toast', () => {
  const notifications = [], toasts = [];
  const doc = { hidden: true, title: 'BEAT 多方协同', hasFocus: () => true };
  class FakeNotification { constructor(title, opts) { this.title = title; this.opts = opts; notifications.push(this); } static permission = 'granted'; }
  const ctx = vm.createContext({ ACTIVE_RUN_STATES: ACTIVE, document: doc, window: { Notification: FakeNotification, focus() {} }, toast: t => toasts.push(t), runStateLabel: r => r.state === 'passed' ? '已完成并核验' : r.state, selectRunById() {}, BASE_TITLE: 'BEAT 多方协同' });
  vm.runInContext(between('function transitionNotices(', 'function syncNotifyBtn()'), ctx);
  let state = null;
  state = ctx.transitionNotices(state, [{ id:'R1', state:'running', goal:'做一个网页' }]);
  ctx.lastRunStates = state.next; ctx.unseenDone = 0;
  ctx.lastRunStates = state.next;
  ctx.handleRunTransitions([{ id:'R1', state:'passed', goal:'做一个网页' }]);
  assert.equal(notifications.length, 1); assert.match(notifications[0].title, /R1/); assert.match(doc.title, /^\(1\)/);
  doc.hidden = false;
  ctx.handleRunTransitions([{ id:'R1', state:'passed' }, { id:'R2', state:'running', goal:'另一个任务' }]);
  ctx.handleRunTransitions([{ id:'R1', state:'passed' }, { id:'R2', state:'failed', goal:'另一个任务' }]);
  assert.ok(toasts.some(t => /另一个任务/.test(t) || /R2/.test(t)));
});
test('手机点任务/问答后自动滚到详情，不用手动往下找', () => {
  assert.match(script, /function revealDetailOnMobile/);
  assert.match(script, /max-width: 900px/);
  assert.match(script, /revealDetailOnMobile\(\)/);
  assert.match(script, /revealDetailPending/);
  assert.match(script, /scrollIntoView/);
});

test('任务清单可以整体导出为 Markdown 表格', () => {
  const ctx = vm.createContext({ KIND: { ask:'问答', parallel:'并行' }, runStateLabel: r => r.state, Date });
  vm.runInContext(between('function exportRunsMarkdown(', 'function runExportMarkdown'), ctx);
  const md = ctx.exportRunsMarkdown([{ id:'R1', kind:'ask', state:'passed', target:'deepseek', tokens:1234, goal:'做 | 一件事' }, { id:'R2', kind:'parallel', state:'failed', initiator:'codex', goal:'另一个' }]);
  assert.match(md, /# BEAT 任务清单/); assert.match(md, /\| R1 \| 问答 \| passed/); assert.match(md, /\| R2 \| 并行 \| failed/);
  assert.doesNotMatch(md, /undefined/); assert.match(html, /id="exportRunsBtn"/);
});

test('Ctrl+Enter 和 Escape 是顶层监听，不依赖是否点过通知按钮', () => {
  const notify = script.indexOf("$('notifyBtn').onclick");
  const ctrl = script.indexOf("event.ctrlKey || event.metaKey");
  const esc = script.indexOf("event.key !== 'Escape'");
  assert.ok(ctrl >= 0 && esc >= 0);
  assert.ok(ctrl < notify && esc < notify, '键盘监听必须在通知按钮 onclick 之外');
  assert.match(script, /const ACTIVE_RUN_STATES = \[[^\]]*'waiting_input'/);
});
