import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const between = (a, b) => script.slice(script.indexOf(a), script.indexOf(b, script.indexOf(a)));
function draftHarness(initial = {}) {
  const store = new Map(Object.entries(initial));
  const els = { askQ: { value: '' }, continuationNotice: { textContent: '' }, askSession: { value: '' }, askAccess: { value: 'auto' }, askTo: { value: '', options: [{ value: 'codex' }, { value: 'deepseek' }], dataset: {} } };
  const ctx = vm.createContext({ $: id => els[id] || null, localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) } });
  vm.runInContext(between('const ASK_DRAFT_KEY', 'let previewTimer'), ctx);
  return { ctx, els, store };
}
test('未发送的输入会保存为草稿，刷新后恢复；已有输入不被覆盖', () => {
  const h = draftHarness();
  h.els.askQ.value = '帮我整理桌面'; h.ctx.saveAskDraft();
  assert.equal(h.store.get('beat.draft.ask'), '帮我整理桌面');
  h.els.askQ.value = ''; assert.equal(h.ctx.restoreAskDraft(), true);
  assert.equal(h.els.askQ.value, '帮我整理桌面'); assert.match(h.els.continuationNotice.textContent, /草稿/);
  h.els.askQ.value = '不要覆盖'; assert.equal(h.ctx.restoreAskDraft(), false); assert.equal(h.els.askQ.value, '不要覆盖');
  h.els.askQ.value = '   '; h.ctx.saveAskDraft(); assert.equal(h.store.has('beat.draft.ask'), false);
});
test('提交或点新需求会清掉草稿；取消任务用带后果说明的看板对话框，不再用原生 confirm', () => {
  assert.match(script, /localStorage\.removeItem\(ASK_DRAFT_KEY\)/);
  assert.match(script, /确认取消任务/);
  assert.match(script, /已经生成的文件不会删除/);
  assert.doesNotMatch(script, /confirm\('确定取消/);
});

test('草稿同时保存会话/操作方式/搭档，刷新后不会把续问当成新会话发出', () => {
  const h = draftHarness();
  h.els.askQ.value = '继续改文件'; h.els.askSession.value = 'S7'; h.els.askAccess.value = 'workspace-write'; h.els.askTo.value = 'deepseek';
  h.ctx.saveAskDraft();
  h.els.askQ.value = ''; h.els.askSession.value = '';
  assert.equal(h.ctx.restoreAskDraft(), true);
  assert.equal(h.els.askSession.value, 'S7');
  assert.equal(h.els.askAccess.value, 'workspace-write');
  assert.equal(h.els.askTo.value, 'deepseek');
  assert.match(h.els.continuationNotice.textContent, /会话上下文/);
});

test('没有会话号时也恢复操作方式和搭档', () => {
  const h = draftHarness();
  h.els.askQ.value = '只回答'; h.els.askSession.value = ''; h.els.askAccess.value = 'workspace-write'; h.els.askTo.value = 'deepseek';
  h.ctx.saveAskDraft();
  h.els.askQ.value = ''; h.els.askAccess.value = 'auto'; h.els.askTo.value = 'codex';
  assert.equal(h.ctx.restoreAskDraft(), true);
  assert.equal(h.els.askAccess.value, 'workspace-write');
  assert.equal(h.els.askTo.value, 'deepseek');
  assert.equal(h.els.askTo.dataset.initialized, 'true');
  assert.match(h.els.continuationNotice.textContent, /操作方式|搭档/);
});
