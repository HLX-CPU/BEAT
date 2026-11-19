import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const inlineScript = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
const between = (start, end) => inlineScript.slice(inlineScript.indexOf(start), inlineScript.indexOf(end, inlineScript.indexOf(start)));

test('答案里的 Markdown 不再直接露出符号：加粗/行内代码/标题渲染成格式', () => {
  const context = vm.createContext({ String });
  vm.runInContext(between('function mdLite(', 'async function openDelivered('), context);
  const out = context.mdLite('**不等于。** 用 `node --check` 检查\n### 小标题');
  assert.match(out, /<b>不等于。<\/b>/);
  assert.match(out, /<code>node --check<\/code>/);
  assert.match(out, /<b>小标题<\/b>/);
  assert.doesNotMatch(out, /\*\*|###|`/);
});

test('mdLite 不复活被转义的 HTML（只处理格式，不解析标签）', () => {
  const context = vm.createContext({ String });
  vm.runInContext(between('function mdLite(', 'async function openDelivered('), context);
  const escaped = '&lt;script&gt;alert(1)&lt;/script&gt; **提示**';
  const out = context.mdLite(escaped);
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /<b>提示<\/b>/);
});
