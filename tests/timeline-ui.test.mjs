import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const between = (a, b) => script.slice(script.indexOf(a), script.indexOf(b, script.indexOf(a)));
const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
test('步骤耗时面板显示每一步用了多久，单步任务不占地方', () => {
  const ctx = vm.createContext({ esc });
  vm.runInContext(between('function stepTimelinePanel(', 'function installArtifactActions'), ctx);
  const panel = ctx.stepTimelinePanel({ steps: [
    { role:'执行', by:'DeepSeek', started_at:'2026-10-19T00:00:00Z', ended_at:'2026-10-19T00:00:09Z', data:{ usage:{ totalTokens: 1234 } } },
    { role:'评估', by:'Codex', started_at:'2026-10-19T00:00:09Z', ended_at:'2026-10-19T00:00:15Z' },
  ]});
  assert.match(panel, /步骤耗时/); assert.match(panel, /执行/); assert.match(panel, /9 秒/); assert.match(panel, /6 秒/);
  assert.match(panel, /timeline-row/); assert.match(panel, /bar/); assert.match(panel, /1,234 token/);
  assert.equal(ctx.stepTimelinePanel({ steps: [{ role:'执行', started_at:'2026-10-19T00:00:00Z' }] }), '');
});
test('Ctrl+Enter 可以快速开始，界面有提示', () => {
  assert.match(html, /Ctrl\+Enter 快速开始/);
  assert.match(script, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(script, /active\.id === 'askQ'/);
  assert.match(script, /active\.id === 'goal'/);
});
