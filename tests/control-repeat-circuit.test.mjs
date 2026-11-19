// 买家评审 P2：同一个目标「创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画」在 parallel 里被重发 11 次
// （R59/R60/R79/R86-R91/R136/R152），R152 单轮烧掉 829,070 token 后仍判 fail，产品没有任何刹车。
// 这里验证两级熔断：
//   ① 连续失败 2 次（task-2）：拒绝新建，错误里要有失败任务号、失败原因摘要和 allowRepeat:true 提示；
//   ② 滚动窗口失败预算（task-3，默认 24h / 3 次）：中间夹一次通过也不能重置刹车——R152 就是这样烧起来的；
// 另外验证：显式 allowRepeat:true 放行并留痕、只失败 1 次 / 目标或目录不同 / 已通过 / 已取消 / 已中断一律放行、
// beat_resume 完全不受影响，以及用真实库（E:\beat\data\beat.sqlite，只读）回放 R152 证明它现在会被拦。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults, ROOT } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator, repeatFailureStreak, repeatFailureWindow, repeatBudgetError, repeatTokenSummary, repeatTokenText } from '../src/orchestrator.mjs';
import { TOOLS } from '../src/tools.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

const GOAL = '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画';
const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString();
const idRe = id => new RegExp('\\b' + id + '\\b');

function fixture(t) {
  const parent = artifactsRoot(); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'repeat-circuit-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'fixture-token' } };
  fs.mkdirSync(config.workspace, { recursive: true });
  config.codex.defaultModel = 'fixture-codex'; config.deepseek.defaultModel = 'fixture-deepseek';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  const orch = new Orchestrator({ config, store, agents: { codex: async () => ({ text: '{}' }), deepseek: async () => ({ text: '{}' }) } });
  orch.pump = () => {};   // 只验「建不建」，不真的跑流程
  const workspace = fs.realpathSync(config.workspace);
  const elsewhere = path.join(root, 'workspaces', 'elsewhere'); fs.mkdirSync(elsewhere, { recursive: true });
  const record = ({ kind = 'parallel', state = 'failed', goal = GOAL, cwd = workspace, error = null, ended_at = undefined, result = '❌ 仍有小任务或整体结果未通过验收\n结论：动画没有交付' } = {}) => {
    const run = store.createRun({ kind, goal, cwd, initiator: 'codex', max_rounds: 2, max_turns: 4 });
    store.updateRun(run.id, { state, error, result, ...(ended_at ? { ended_at } : {}) });
    return store.run(run.id);
  };
  const start = extra => orch.startParallel({ goal: GOAL, cwd: workspace, source: 'codex', ...extra });
  return { config, store, orch, workspace, other: fs.realpathSync(elsewhere), record, start };
}

test('同 goal+cwd 连续失败 2 次后拒绝第 3 次新建，错误含任务号、失败原因与 allowRepeat 提示', t => {
  const f = fixture(t);
  const first = f.record({ result: '❌ 仍有小任务或整体结果未通过验收\n结论：SVG 动画没有交付' });
  const second = f.record({ state: 'error', error: '各方都没能完成这一步：Codex：原生会话被占用' });
  let error = null;
  try { f.start(); } catch (e) { error = e; }
  assert.ok(error, '连续失败 2 次后必须拒绝新建并行任务');
  assert.equal(error.code, 'REPEAT_CIRCUIT_OPEN');
  assert.match(error.message, new RegExp(first.id), '错误里要有已失败任务号');
  assert.match(error.message, new RegExp(second.id), '错误里要有已失败任务号');
  assert.match(error.message, /连续 2 次/);
  assert.match(error.message, /未通过验收/, '要带上各自最后的失败原因摘要');
  assert.match(error.message, /原生会话被占用/, 'error 状态的最后原因也要带上');
  assert.match(error.message, /确要继续请显式传 allowRepeat:true/);
  assert.deepEqual(error.failedRuns, [second.id, first.id], '最近失败在前');
  assert.equal(f.store.runs(50).length, 2, '被拒绝时不得创建新任务');
  let explicit = null; try { f.start({ allowRepeat: false }); } catch (e) { explicit = e; }
  assert.ok(explicit, 'allowRepeat:false 与默认一样要拒绝');
  let stringy = null; try { f.start({ allowRepeat: 'false' }); } catch (e) { stringy = e; }
  assert.ok(stringy, "只有字面量 true 才算显式要求，'false' 这类真值字符串不能误放行");
  assert.equal(f.store.runs(50).length, 2, '拒绝时不留下空任务');
});

test('allowRepeat:true 显式放行，并在任务事件里记录此前连续失败了几次', t => {
  const f = fixture(t);
  const first = f.record(); const second = f.record();
  const run = f.start({ allowRepeat: true });
  assert.equal(run.kind, 'parallel'); assert.equal(run.state, 'queued');
  assert.equal(run.goal, GOAL, '目标文本原样保留，不静默改写');
  const events = f.store.events(50).filter(e => e.run_id === run.id).map(e => e.text);
  assert.ok(events.some(text => text.includes('用户显式要求重复同一目标（此前已连续失败 2 次）')), events.join('\n'));
  assert.ok(events.some(text => text.includes(first.id) && text.includes(second.id)), '事件里要留下此前失败的任务号');
});

test('只失败 1 次不拦', t => {
  const f = fixture(t);
  f.record();
  assert.equal(f.start().state, 'queued');
});

test('目标或工作目录不同不拦（相似目标也算不同）', t => {
  const f = fixture(t);
  f.record(); f.record();
  assert.equal(f.start({ goal: GOAL + '，再加背景音乐' }).state, 'queued', '目标不同要放行');
  assert.equal(f.start({ cwd: f.other }).state, 'queued', '工作目录不同要放行');
});

test('放行边界：成功/取消/中断会断链，ask 不算实质执行轮，resume 不受熔断影响', t => {
  const passed = fixture(t);
  passed.record(); passed.record(); passed.record({ state: 'passed', result: '✅ 通过' });
  assert.equal(passed.start().state, 'queued', '最近一条已通过就断链');

  const cancelled = fixture(t);
  cancelled.record(); cancelled.record(); cancelled.record({ state: 'cancelled', result: '用户取消' });
  assert.equal(cancelled.start().state, 'queued', '取消/中断不是 failed/error，拿不准就放行');

  const withAsk = fixture(t);
  withAsk.record(); withAsk.record({ kind: 'ask', state: 'done', result: '已答复' }); withAsk.record();
  let blocked = null; try { withAsk.start(); } catch (e) { blocked = e; }
  assert.ok(blocked, 'ask 夹在中间不算数，两次实质执行轮仍然连续');

  const resume = fixture(t);
  const first = resume.record(); resume.record();
  assert.equal(resume.orch.resume(first.id).state, 'queued', 'beat_resume 续跑旧任务不受熔断影响');
});

test('归一化：空白与大小写视为同一目标/同一目录；历史里没有同目标记录则不拦', () => {
  const runs = [
    { id: 'R3', kind: 'ask', goal: 'Fix  BUG', cwd: 'C:\\work', state: 'done' },
    { id: 'R2', kind: 'parallel', goal: 'fix bug', cwd: 'C:\\work\\', state: 'failed' },
    { id: 'R1', kind: 'parallel', goal: 'FIX  bug', cwd: 'c:\\WORK', state: 'error' },
  ];
  assert.deepEqual(repeatFailureStreak(runs, ' fix   bug ', 'C:\\work').map(r => r.id), ['R2', 'R1']);
  assert.deepEqual(repeatFailureStreak([], GOAL, 'C:\\work'), [], '历史窗口里看不见的记录一律放行');
  assert.deepEqual(repeatFailureStreak(runs, '', 'C:\\work'), [], '空目标不熔断');
  assert.deepEqual(repeatFailureStreak(runs, 'fix bug', 'C:\\other'), [], '目录不同不误伤');
});

test('beat_parallel 暴露 allowRepeat 可选参数并透传给控制器', async () => {
  const schema = TOOLS.beat_parallel.schema;
  assert.equal(schema.properties.allowRepeat.type, 'boolean');
  assert.equal(schema.additionalProperties, false);
  assert.ok(!(schema.required || []).includes('allowRepeat'), 'allowRepeat 必须是可选参数（默认 false）');
  const seen = [];
  const fake = { startParallel: args => { seen.push(args); return { id: 'R99' }; } };
  assert.deepEqual(await TOOLS.beat_parallel.run(fake, { goal: GOAL, allowRepeat: true }, 'codex'), { id: 'R99' });
  assert.equal(seen[0].allowRepeat, true);
  assert.equal(seen[0].source, 'codex');
});

// ---------- task-3：滚动窗口失败预算（默认 24 小时 / 3 次） ----------

test('同目标 24 小时内失败 3 次后第 4 次被拦：中间夹一次通过不再重置刹车（R152 场景）', t => {
  const f = fixture(t);
  const a = f.record();
  const b = f.record({ state: 'error', error: '各方都没能完成这一步：Codex：原生会话被占用' });
  const c = f.record();
  const pass = f.record({ state: 'passed', result: '✅ 通过' });
  assert.equal(f.orch.repeatedFailures(GOAL, f.workspace).length, 0, '最近一条是通过：连续失败计数确实被重置了');
  let error = null; try { f.start(); } catch (e) { error = e; }
  assert.ok(error, '24h 内 3 次失败后必须拦住第 4 次新建');
  assert.equal(error.code, 'REPEAT_BUDGET_EXHAUSTED');
  for (const id of [a.id, b.id, c.id]) assert.match(error.message, idRe(id), '窗口内失败任务号都要列出');
  assert.doesNotMatch(error.message, idRe(pass.id), '通过的任务不当作失败任务');
  assert.match(error.message, /最近 24 小时内已经失败 3 次（/);
  assert.match(error.message, /确要继续请显式传 allowRepeat:true/);
  assert.match(error.message, /^消耗未记录$/m, '取不到用量就如实写“消耗未记录”');
  assert.equal(f.store.runs(50).length, 4, '被拒绝时不得创建新任务');
});

test('窗口预算触发时 allowRepeat:true 仍然一键放行，并在事件里记录窗口内失败次数与任务号', t => {
  const f = fixture(t);
  const a = f.record(); const b = f.record(); const c = f.record();
  f.record({ state: 'passed', result: '✅ 通过' });
  let blocked = null; try { f.start(); } catch (e) { blocked = e; }
  assert.ok(blocked, '先确认默认会被拦住');
  const run = f.start({ allowRepeat: true });
  assert.equal(run.kind, 'parallel'); assert.equal(run.state, 'queued');
  const events = f.store.events(50).filter(e => e.run_id === run.id).map(e => e.text);
  assert.ok(events.some(text => text.includes('用户显式要求重复同一目标（此前已连续失败 0 次）')), events.join('\n'));
  assert.ok(events.some(text => text.includes('最近 24 小时同目标失败 3 次')), events.join('\n'));
  for (const id of [a.id, b.id, c.id]) assert.ok(events.some(text => text.includes(id)), '事件里要留下窗口内失败任务号');
});

test('窗口外的失败不计入；窗口与阈值都能在 flow 里配置，非法值回落默认', t => {
  const aged = () => {
    const f = fixture(t);
    for (const h of [30, 29, 28]) f.record({ ended_at: hoursAgo(h) });
    f.record({ state: 'passed', result: '✅ 通过' });
    return f;
  };
  const inside = aged();
  assert.equal(inside.config.flow.repeatFailWindowHours, 24, '默认窗口 24 小时');
  assert.equal(inside.config.flow.repeatFailLimit, 3, '默认阈值 3 次');
  assert.equal(inside.start().state, 'queued', '30/29/28 小时前的失败都在 24h 窗口外 → 放行');

  const wide = aged(); wide.config.flow.repeatFailWindowHours = 100;
  let error = null; try { wide.start(); } catch (e) { error = e; }
  assert.ok(error, '窗口放到 100 小时，这 3 次失败就要算');
  assert.equal(error.code, 'REPEAT_BUDGET_EXHAUSTED');
  assert.match(error.message, /最近 100 小时内已经失败 3 次（/);

  const relaxed = aged(); relaxed.config.flow.repeatFailWindowHours = 100; relaxed.config.flow.repeatFailLimit = 5;
  assert.equal(relaxed.start().state, 'queued', '上限提到 5 次就放行');

  const fallback = aged(); fallback.config.flow.repeatFailWindowHours = 0;   // 非法（下限 1）
  assert.equal(fallback.start().state, 'queued', '窗口配成非法值 0 时回落默认 24h，不会当成“不限时间”一刀切');
});

test('不同目标或不同目录的失败不计入窗口预算', t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) f.record({ goal: GOAL + '（另一版）' });
  for (let i = 0; i < 3; i++) f.record({ cwd: f.other });
  assert.equal(f.start().state, 'queued');
});

test('工具层链路：窗口预算触发时 beat_parallel 返回同一拒绝，allowRepeat:true 透传放行', async t => {
  const f = fixture(t);
  f.record(); f.record(); f.record(); f.record({ state: 'passed', result: '✅ 通过' });
  await assert.rejects(() => TOOLS.beat_parallel.run(f.orch, { goal: GOAL, cwd: f.workspace }, 'codex'),
    e => e.code === 'REPEAT_BUDGET_EXHAUSTED' && /确要继续请显式传 allowRepeat:true/.test(e.message));
  const run = await TOOLS.beat_parallel.run(f.orch, { goal: GOAL, cwd: f.workspace, allowRepeat: true }, 'codex');
  assert.equal(run.state, 'queued');
});

test('窗口预算触发时，beat_resume 接着做旧任务不受影响', t => {
  const f = fixture(t);
  const first = f.record(); f.record(); f.record(); f.record({ state: 'passed', result: '✅ 通过' });
  let blocked = null; try { f.start(); } catch (e) { blocked = e; }
  assert.ok(blocked, '全新重发确实被拦');
  assert.equal(f.orch.resume(first.id).state, 'queued', '继续执行旧任务不受熔断影响');
});

test('窗口函数：只数窗口内的 failed/error；ask、通过、取消、时间读不出、未来时间戳都不算', () => {
  const now = Date.now();
  const runs = [
    { id: 'R6', kind: 'parallel', goal: 'g', cwd: 'C:/w', state: 'failed', ended_at: new Date(now + 3600000).toISOString() },
    { id: 'R5', kind: 'parallel', goal: 'g', cwd: 'C:/w', state: 'failed' },
    { id: 'R4', kind: 'ask', goal: 'g', cwd: 'C:/w', state: 'failed', ended_at: hoursAgo(1) },
    { id: 'R3', kind: 'parallel', goal: 'g', cwd: 'C:/w', state: 'cancelled', ended_at: hoursAgo(1) },
    { id: 'R2', kind: 'parallel', goal: 'g', cwd: 'C:/w', state: 'failed', ended_at: hoursAgo(30) },
    { id: 'R1', kind: 'parallel', goal: 'g', cwd: 'C:/w', state: 'error', ended_at: hoursAgo(2) },
  ];
  assert.deepEqual(repeatFailureWindow(runs, 'g', 'C:/w', { hours: 24, now }).map(r => r.id), ['R1']);
  assert.deepEqual(repeatFailureWindow(runs, 'g', 'C:/w', { hours: 100, now }).map(r => r.id), ['R2', 'R1']);
  assert.deepEqual(repeatFailureWindow(runs, '', 'C:/w', { hours: 24, now }), [], '空目标不熔断');
  assert.deepEqual(repeatFailureWindow(runs, 'g', 'C:/other', { hours: 24, now }), [], '目录不同不误伤');
});

test('真实库回放：R152 会被 24h 失败预算拦住（R136 的通过不再重置刹车）', async t => {
  const file = path.join(ROOT, 'data', 'beat.sqlite');
  if (!fs.existsSync(file)) return t.skip('未找到真实库 data/beat.sqlite，跳过回放');
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return t.skip('当前 Node 没有 node:sqlite'); }
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch (e) { return t.skip('真实库打不开（可能被独占）：' + e.message); }
  let runs, metrics;
  try {
    runs = db.prepare('SELECT * FROM runs ORDER BY n DESC').all();
    metrics = id => { const row = db.prepare('SELECT v FROM kv WHERE k=?').get('controlMetrics:' + id); try { return JSON.parse(row?.v); } catch { return null; } };
  } catch (e) { db.close(); return t.skip('真实库读取失败：' + e.message); }
  t.after(() => db.close());
  const target = runs.find(r => r.id === 'R152');
  if (!target) return t.skip('真实库里没有 R152，无法回放');
  const history = runs.filter(r => r.n < target.n);
  const now = Date.parse(target.created_at);
  // 关键：按“R152 创建时刻的历史”看，连续失败规则是 0 次（R136 通过了），只有窗口预算能拦住。
  assert.equal(repeatFailureStreak(history, target.goal, target.cwd).length, 0, 'R152 前面隔着通过的 R136：task-2 的连续规则看不到');
  const window = repeatFailureWindow(history, target.goal, target.cwd, { hours: 24, now });
  assert.ok(window.length >= 3, `R152 之前 24h 内同目标失败 ${window.length} 次，应触发默认阈值 3 次`);
  assert.ok(!window.some(r => r.id === 'R136'), '通过的任务不进失败列表');
  const tokenText = repeatTokenText(repeatTokenSummary(metrics, window));
  assert.ok(/^累计消耗 \d+ token/.test(tokenText) || tokenText === '消耗未记录', 'token 行要么给出累计消耗，要么如实写“消耗未记录”：' + tokenText);
  const error = repeatBudgetError(target.goal, target.cwd, window, { hours: 24, limit: 3, tokenText });
  assert.match(error.message, /最近 24 小时内已经失败 \d+ 次（/);
  assert.match(error.message, /鹈鹕骑自行车/, '错误里要带上目标原文');
  for (const run of window) assert.match(error.message, idRe(run.id), '窗口内失败任务号都要在错误里');
  assert.match(error.message, /确要继续请显式传 allowRepeat:true/);
  assert.ok(window.length >= 3, '真实结论：R152 创建前就已达 3 次上限 → 现在会被拦');
});
