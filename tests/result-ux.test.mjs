import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const between = (start, end) => script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start)));
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const FENCE = String.fromCharCode(96).repeat(3);

test('回答里的围栏代码块渲染成代码区，不把 ** 和反引号当格式', () => {
  const context = vm.createContext({ String });
  vm.runInContext(between('function mdLite(', 'async function openDelivered'), context);
  const source = '先看这段：\n' + FENCE + 'js\nconst a = "**x**";\nconsole.log(1);\n' + FENCE + '\n然后 **继续**。';
  const out = context.mdLite(source);
  assert.match(out, /<pre class="codeblock"><code>/);
  assert.match(out, /复制代码/);
  assert.match(out, /const a = \"\*\*x\*\*\";/);
  assert.match(out, /console\.log\(1\);/);
  assert.match(out, /<b>继续<\/b>/);
  assert.equal(out.includes(FENCE), false);
});

test('http(s) 链接可点开；非 http 的括号内容保持原样', () => {
  const context = vm.createContext({ String });
  vm.runInContext(between('function mdLite(', 'async function openDelivered'), context);
  const out = context.mdLite('参考 [文档](https://example.com/a) 和 [不要](javascript:alert(1))');
  assert.match(out, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">文档<\/a>/);
  assert.doesNotMatch(out, /href="javascript:/);
  assert.match(out, /\[不要\]\(javascript:alert\(1\)\)/);
});

test('结果区给复制结论/复制全文，并保留明确的摘要与折叠详情', () => {
  const mdCtx = vm.createContext({ String });
  vm.runInContext(between('function mdLite(', 'async function openDelivered'), mdCtx);
  const context = vm.createContext({ esc, mdLite: mdCtx.mdLite, linkify: value => esc(value), customerResult: r => r.result, RESULT_DETAIL_MARK: '\n（以下为详细过程记录，看板上可折叠）' });
  vm.runInContext(between('function resultPanel(r) {', 'const runStateClass'), context);
  const panel = context.resultPanel({ result: '结论：采用方案 B。\n（以下为详细过程记录，看板上可折叠）\n技术路线正文。' });
  assert.match(panel, /复制结论/); assert.match(panel, /复制全文/);
  assert.match(panel, /data-copy-text="结论：采用方案 B。"/);
  assert.match(panel, /result-summary/); assert.match(panel, /result-detail/);
  assert.match(panel, /技术路线正文/);
});

test('复制按钮走委托，且追问/会话记录也有复制入口；问答可以接着问', () => {
  assert.match(script, /data-copy-text/);
  assert.match(script, /navigator\.clipboard\.writeText/);
  assert.match(script, /id="askAgainBtn"/);
  assert.match(script, /已接上这条会话/);
  assert.match(script, /复制回答/);
});
test('纯文本 http(s) 地址也会自动变成可点链接，且不重复包 Markdown 链接', () => {
  const context = vm.createContext({ String });
  vm.runInContext(between('function mdLite(', 'async function openDelivered'), context);
  const out = context.mdLite('见 https://developer.mozilla.org/zh-CN。和 [MDN](https://example.com/a)');
  assert.equal(out.includes('href="https://developer.mozilla.org/zh-CN。"'), false, '中文句号不能进链接');
  assert.ok(out.includes('href="https://developer.mozilla.org/zh-CN"'), out);
  assert.equal((out.match(/href=/g) || []).length, 2, '两个地址各一个链接，不能把 href 再包一层');
});

test('Markdown 表格渲染成可读表格，表格里的 HTML 不复活', () => {
  const context = vm.createContext({ String });
  vm.runInContext(between('function mdLite(', 'async function openDelivered'), context);
  const out = context.mdLite('| 方案 | 成本 |\n| --- | --- |\n| A | 低 |\n| **B** | 高 |');
  assert.match(out, /<table class="md-table">/); assert.match(out, /<th>方案<\/th>/);
  assert.match(out, /<td><b>B<\/b><\/td>/);
  assert.doesNotMatch(out, /\| --- \|/);
});

test('生产链路 mdLite(linkify(...)) 不会把 http(s) URL 拆成盘符链接', () => {
  const context = vm.createContext({ String });
  vm.runInContext("const esc = s => String(s ?? '').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));\n" + between('const FILE_PATH_RE', 'async function openDelivered'), context);
  const out = context.mdLite(context.linkify('见 https://example.com/a 和 [MDN](https://example.com/b)，文件 E:\\beat\\demo.txt'));
  assert.equal(out.includes('data-path="s://'), false);
  assert.match(out, /href=\"https:\/\/example\.com\/a\"/);
  assert.match(out, /href=\"https:\/\/example\.com\/b\"/);
  assert.ok(out.includes('data-path="E:'), out);
});

test('围栏代码里的 Markdown 表格保持代码，不注入表格 HTML', () => {
  const context = vm.createContext({ String });
  vm.runInContext("const esc = s => String(s ?? '').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));\n" + between('const FILE_PATH_RE', 'async function openDelivered'), context);
  const fence = String.fromCharCode(96).repeat(3);
  const out = context.mdLite('先看示例：\n' + fence + 'md\n| a | b |\n| --- | --- |\n| 1 | 2 |\n' + fence);
  assert.doesNotMatch(out, /md-table-wrap/);
  assert.match(out, /<pre class="codeblock"><code>\| a \| b \|/);
  assert.match(out, /data-copy-text="\| a \| b \|/);
});

test('围栏代码里出现 Windows 路径时，路径不会被塞进复制按钮 HTML', () => {
  const context = vm.createContext({ String });
  vm.runInContext("const esc = s => String(s ?? '').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));\n" + between('const FILE_PATH_RE', 'async function openDelivered'), context);
  const fence = String.fromCharCode(96).repeat(3);
  const out = context.mdLite(context.linkify('看这个\n' + fence + 'text\nE:\\beat\\code.js\n| x | y |\n| --- | --- |\n' + fence));
  assert.equal(out.includes('data-copy-text="<span'), false);
  assert.match(out, /data-copy-text="E:\\beat\\code\.js/);
  assert.equal(out.includes('filelink'), false);
});

test('行内代码里的 Windows 路径不再破坏代码标签和后续行内代码', () => {
  const context = vm.createContext({ String });
  vm.runInContext("const esc = s => String(s ?? '').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));\n" + between('const FILE_PATH_RE', 'async function openDelivered'), context);
  const out = context.mdLite(context.linkify('参数 `E:\\beat\\a.js` 里的 **x** 和 `node --check`'));
  assert.equal(out.includes('filelink'), false);
  assert.equal((out.match(/<code>/g) || []).length, 2);
  assert.match(out, /<code>E:\\beat\\a\.js<\/code>/);
  assert.match(out, /<code>node --check<\/code>/);
});
