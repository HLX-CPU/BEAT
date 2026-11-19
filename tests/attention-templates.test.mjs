import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const between = (a, b) => script.slice(script.indexOf(a), script.indexOf(b, script.indexOf(a)));
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const cls = r => r.state === 'failed' ? 'failed' : 'ok';
const label = r => r.state === 'failed' ? '未通过' : r.state === 'waiting_input' ? '等待补充信息' : '进行中';

test('需要你处理：聚合失败/等待补充的任务，空时隐藏，并给出处理按钮', () => {
  const box = { hidden: true, innerHTML: '' }, card = { hidden: true, innerHTML: '' }, count = { textContent: '' };
  const $ = id => ({ attentionCard: card, attentionList: box, attentionCount: count }[id] || null);
  const ctx = vm.createContext({ $, esc, nameOf: v => v || '搭档', runStateClass: cls, runStateLabel: label, window: { matchMedia: () => ({ matches: false }), addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
    runNeedsAttention: r => ['failed','error','waiting_input','interrupted'].includes(r.state) });
  vm.runInContext(between('const ATTENTION_DISMISS_KEY', 'function renderRunRows('), ctx);
  ctx.renderAttention([
    { id:'R1', state:'failed', goal:'修复网页 <script>', target:'deepseek', created_at:'2026-10-19T01:00:00Z' },
    { id:'R2', state:'waiting_input', goal:'补充产品名', target:'codex', created_at:'2026-10-19T02:00:00Z' },
    { id:'R3', state:'passed', goal:'完成', target:'codex', created_at:'2026-10-19T03:00:00Z' },
  ]);
  assert.equal(card.hidden, false); assert.match(count.textContent, /2 个/);
  assert.match(box.innerHTML, /R1/); assert.match(box.innerHTML, /R2/); assert.doesNotMatch(box.innerHTML, /R3/);
  assert.match(box.innerHTML, /data-attention="R1"/); assert.match(box.innerHTML, /&lt;script&gt;/);
  ctx.renderAttention([{ id:'R3', state:'passed' }]); assert.equal(card.hidden, true);
});

test('任务模板：有常用场景，点一个就填进输入框并切到对应操作方式', () => {
  assert.match(html, /id="templateLibrary"/);
  assert.match(html, /id="templateList"/);
  for (const text of ['写一份通知', '整理桌面', '做一个网页', '读附件写总结', '修一个 bug', '一起想方案']) assert.match(html, new RegExp(text));
  assert.match(script, /const TEMPLATES = \[/);
  assert.ok(script.includes('data-template="${index}"'));
  assert.ok(script.includes("$('askQ').value = template.goal"));
  assert.ok(script.includes("$('askAccess').value = template.access"));
});

test('待处理可以一键全部忽略，但任务和记录不删除', () => {
  assert.match(html, /id="attentionDismissAllBtn"/);
  assert.match(script, /全部忽略待处理/);
  assert.match(script, /不会删除任何任务或文件/);
  assert.match(script, /dismissAttention\(row\.id\)/);
});

test('忽略全部不是死路：可以恢复忽略的待处理任务', () => {
  assert.match(html, /id="attentionRestoreBtn"/);
  assert.match(script, /attentionResizeTimer/);
  assert.match(script, /已忽略 \$\{dismissed\.size\} 个/);
  assert.match(script, /clearIgnoredAttention/);
  assert.match(script, /localStorage\.removeItem\(ATTENTION_DISMISS_KEY\)/);
});
