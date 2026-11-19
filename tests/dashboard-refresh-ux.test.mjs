import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function harness() {
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, hidden: true, innerHTML: '', contains: () => false });
    return elements.get(id);
  };
  const requests = [];
  const context = vm.createContext({ $, selected: 'R1', esc: String,
    api: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) });
  // Run the production request/selection guard, before the unrelated rendering code.
  const start = script.indexOf('let detailRequestSequence = 0;');
  const end = script.indexOf('  if (!r.customerIssue', start);
  vm.runInContext(script.slice(start, end) + 'return r; }', context);
  return { context, $, requests };
}
test('inline dashboard script parses', () => { new vm.Script(script); });
test('switching tasks ignores a delayed result from the previous task', async () => {
  const { context, requests } = harness();
  const old = context.loadDetail('R1');
  context.selected = 'R2';
  const current = context.loadDetail('R2');
  requests[1].resolve({ id: 'R2' });
  assert.equal((await current).id, 'R2');
  requests[0].resolve({ id: 'R1' });
  assert.equal(await old, undefined);
});
test('same-task older responses cannot overwrite a newer response', async () => {
  const { context, requests } = harness();
  const old = context.loadDetail('R1'), current = context.loadDetail('R1');
  requests[1].resolve({ id: 'R1', state: 'passed' });
  assert.equal((await current).state, 'passed');
  requests[0].resolve({ id: 'R1', state: 'running' });
  assert.equal(await old, undefined);
});
test('read failure persists with a read-only retry and clears on recovery', async () => {
  const { context, $, requests } = harness();
  const failed = context.loadDetail('R1');
  requests[0].reject(new Error('network unavailable'));
  await failed;
  assert.equal($('detailNotice').hidden, false);
  assert.match($('detailNotice').innerHTML, /不会重新执行任务/);
  const retry = $('retryDetailBtn').onclick();
  requests[1].resolve({ id: 'R1' });
  await retry;
  assert.equal($('detailNotice').hidden, true);
});
test('a delayed error from a previous task does not overwrite current status', async () => {
  const { context, $, requests } = harness();
  const old = context.loadDetail('R1');
  context.selected = 'R2';
  const current = context.loadDetail('R2');
  requests[1].resolve({ id: 'R2' });
  await current;
  requests[0].reject(new Error('late failure'));
  await old;
  assert.equal($('detailNotice').hidden, true);
});

test('处理中的"已用时"每秒自己走，不用等轮询重画（客户反馈）', () => {
  const start = script.indexOf('function customerOverview(r) {');
  const end = script.indexOf('function installArtifactActions', start);
  assert.ok(start > 0 && end > start, '看板里必须能找到 customerOverview 渲染逻辑');
  const context = vm.createContext({ esc: v => String(v ?? ''), kb: () => '1 KB' });
  const render = vm.runInContext(script.slice(start, end) + '\ncustomerOverview;', context);
  const active = render({ customer: { active: true, label: '正在制作', who: 'DeepSeek', phase: '执行', totalTasks: 1, completedTasks: 0, elapsedSeconds: 65, artifacts: [], usage: { calls: 2, tokens: 100, estimated: 0, budgetEnforced: false, notice: '' } } });
  assert.match(active, /已用时 <span data-since="[^"]+">/);
  assert.match(active, /progress-bar/); assert.match(active, /width:0%/);
  const finished = render({ customer: { active: false, label: '已完成并核验', elapsedSeconds: 65, artifacts: [], usage: { calls: 2, tokens: 100, estimated: 0, budgetEnforced: false, notice: '' } } });
  assert.doesNotMatch(finished, /data-since/, '结束的任务用时固定，不再每秒重算');
  const high = render({ customer: { active: false, label: '已完成并核验', elapsedSeconds: 60, artifacts: [], usage: { calls: 3, tokens: 200000, estimated: 0, budgetEnforced: false, notice: '' } } });
  assert.match(high, /用量较高/);
});

test('刷新串行化：轮询不会和按钮把同一轮刷新重复派发，避免请求互相作废', () => {
  assert.match(script, /let refreshRunning = false, refreshQueued = false;/);
  const start = script.indexOf('async function refresh()');
  const end = script.indexOf('async function refreshOnce()', start);
  const wrapper = script.slice(start, end);
  assert.match(wrapper, /if \(refreshRunning\) \{ refreshQueued = true; return; \}/);
  assert.match(wrapper, /await refreshOnce\(\)/);
  assert.match(script, /if \(selected\) await loadDetail\(selected\);/);
});
