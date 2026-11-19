// 看板"白屏 / 点了没反应"回归：客户实测 2026-10-10
//   ① Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')  → 整段脚本中止、任务列表不渲染
//   ② Cannot read properties of undefined (reading 'some')                              → 追问提交失败，错误显示在追问框下
//   ③ 点「选择文件」页面跳到顶部（href="#" 且事件没绑上）
// 这里用最小 DOM 桩跑真实看板脚本，条件就是"追问面板还不存在"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const code = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

// 极简 DOM：只实现看板启动路径真正用到的那点 API。
function makeDom({ ids }) {
  const listeners = [];
  const classList = () => ({ add() {}, remove() {}, toggle() {}, contains: () => false });
  const make = id => ({
    id, value: '', innerHTML: '', textContent: '', hidden: false, dataset: {}, style: {}, classList: classList(),
    addEventListener(type, fn) { listeners.push([id, type, fn]); },
    removeEventListener() {},
    setAttribute() {}, getAttribute: () => null, appendChild() {}, focus() {}, click() {},
  });
  const elements = new Map([...ids].map(id => [id, make(id)]));
  const $doc = {
    getElementById: id => elements.get(id) || null,
    // 真实 DOM 里 querySelector 命中子节点就返回元素；桩里让它返回一个普通桩元素，
    // 这样测出来的就是"drop 不存在"这类真问题，而不是桩自己太穷。
    querySelector: () => make('q'),
    querySelectorAll: () => [],
    createElement: () => make('created'),
    addEventListener(type, fn) { listeners.push(['document', type, fn]); },
    body: make('body'),
  };
  return { doc: $doc, elements, listeners, make };
}

function run({ ids }) {
  const { doc, elements, listeners, make } = makeDom({ ids });
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, location: { href: '' }, open() {} },
    __BEAT_TOKEN__: 'stub-token',
    // 永不 resolve：不联网、也不产生 rejection（挂起点在 Promise 上最安静），
    // 否则失败会在测试结束后冒泡，被 node:test 记成 "asynchronous activity after the test ended"。
    fetch: () => new Promise(() => {}),
    XMLHttpRequest: function () { this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { clipboard: null, userAgent: 'stub' },
    console,
    // 看板脚本会挂 setInterval 轮询：全部 unref，否则 node --test 跑完不退出（会拖死全量测试）。
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
    clearTimeout, clearInterval,
    Promise, JSON, Date, Math, Number, String, Boolean, Array, Object, RegExp, Error, TypeError, Map, Set, URL, URLSearchParams,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(code).runInContext(sandbox);   // 抛错就是白屏
  return { sandbox, elements, listeners, make };
}

test('看板脚本在"追问面板元素不存在"时不能再抛错（客户白屏回归）', () => {
  // 页面初始状态：没有任何 follow* 元素
  try { run({ ids: ['agents', 'runs', 'askChips', 'launchChips', 'goal', 'askQ'] }); }
  catch (e) {
    const line = (e.stack || '').split('\n').slice(0, 6).join('\n');
    assert.fail('缺 #followQ/#followDrop 时脚本必须照常跑完，否则任务列表整块不渲染：\n' + line);
  }
});

test('更极端：所有元素都取不到时，脚本仍然不能崩（兜底契约）', () => {
  assert.doesNotThrow(() => run({ ids: [] }), '$() 拿不到元素要给无害替身，不能因为某个面板没打开就白屏');
});

test('兜底元素必须是"半空"的：能挂事件，但 DOM 查询返回 null（不能返回万能对象）', () => {
  // 内联脚本里的 $ NOOP_ELEMENT 是闭包内的，测试拿不到，所以按源码复刻一份等价实现来验行为。
  const src = code.match(/const NULL_LIKE = new Set\(\[[\s\S]*?\]\);/)[0];
  const proxySrc = code.match(/const NOOP_ELEMENT = new Proxy\(\{\}, \{[\s\S]*?\n\}\);/)[0];
  const factory = new Function('NULL_LIKE', proxySrc.replace('const NOOP_ELEMENT = ', 'return ') + '\n');
  const NULL_LIKE = eval(src.replace('const NULL_LIKE = ', ''));   // eslint-disable-line no-eval
  const fake = factory(NULL_LIKE);
  fake.onclick = () => {};                       // 挂事件静默成功
  fake.textContent = 'x';                        // 设文本静默成功
  fake.hidden = true;
  assert.equal(fake.querySelector('a'), null, 'querySelector 必须返回 null，否则 .onclick 会设到 undefined 上继续抛');
  assert.equal(fake.closest('.x'), null);
  assert.deepEqual(fake.dataset, {});
  assert.equal(fake.value, '');
});

test('粘贴/选择文件的委托遇到畸形事件（target 不是元素）不能抛错', () => {
  // 粘贴处理器整段抽出来在 Node 里真跑（它必须用 document 级委托，动态面板才绑得上）。
  const fnSrc = code.match(/function closestData\([\s\S]*?\n\}/)[0];
  const pasteSrc = code.match(/document\.addEventListener\('paste',[\s\S]*?\n\}\);/)[0];
  const registered = [];
  const sandbox = { document: { addEventListener: (t, fn) => registered.push([t, fn]), getElementById: () => null }, console, Object, Array, Number, String, Boolean, Error, TypeError, JSON };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script([fnSrc, pasteSrc].join('\n')).runInContext(sandbox);
  const paste = registered.find(([t]) => t === 'paste')[1];
  assert.equal(typeof paste, 'function', '粘贴要用 document 级委托（动态面板才绑得上）');
  // 客户实测 "Cannot read properties of undefined (reading 'some')"：
  // target 可能是 undefined，也可能拿不到 closest / dataset
  const weirdTargets = [undefined, null, {}, { closest: undefined }, { closest: () => null }, { closest: () => ({}), dataset: undefined }];
  // 覆盖"看起来像元素但内容不全"的 target：处理器可能走到 openDelivered 这类后续逻辑
  weirdTargets.push({ closest: () => ({ dataset: { path: '' }, classList: { add() {}, remove() {} }, textContent: '' }), dataset: {} });
  for (const target of weirdTargets) {
    const label = JSON.stringify(target);
    assert.doesNotThrow(() => paste({ target, clipboardData: null, preventDefault() {} }), '粘贴处理器不接受畸形 target 崩溃：' + label);
  }
  // 粘贴文字（没有 files）必须放行，不能 preventDefault —— 否则输入框里粘不进去
  let prevented = false;
  paste({ target: { closest: () => ({ dataset: { paste: 'follow' } }) }, clipboardData: { files: [] }, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, '粘贴文字不能被拦（拦了输入框就粘不进去）');

  // 「选择文件/选择文件夹」：源码级契约（这部分以前有 6 处 href="#" 导致点击跳页，客户实测）
  // 注意 index.html 是 CRLF，匹配换行要用 /\r?\n/ 或只匹配同一段里的关键字。
  const pickAt = code.search(/addEventListener\('click',\s*e\s*=>\s*\{\s*\r?\n\s*const pick = closestData\(e\.target, 'data-pick'\)/);
  assert.ok(pickAt > -1, '选择文件必须用 document 级委托 + data-pick 判定（动态面板才绑得上）');
  const clickBlock = code.slice(pickAt, pickAt + 700);
  assert.match(clickBlock, /closestData\(e\.target, 'data-pick-dir'\)/, '选择文件夹同理走委托');
  assert.match(clickBlock, /pick\.pick \? document\.getElementById\(pick\.pick \+ 'Files'\)/, '用 dataset 值拼出对应面板的文件输入框（并判空）');
});

test('上传区的三个函数对"没登记的区域"也要容错（追问白屏的真正原因）', () => {
  // 客户实测：新加追问上传区后忘了在 PENDING 里登记 follow →
  // takeAttachments('follow') 里 PENDING['follow'].some(...) 抛
  // "Cannot read properties of undefined (reading 'some')"，追问直接发不出去。
  const start = code.indexOf('const PENDING =');
  const end = code.indexOf('async function api(');
  assert.ok(start > -1 && end > start, '要能找到 PENDING 与上传相关函数那一段');
  const slice = code.slice(start, end);
  assert.match(code, /const PENDING = \{[^}]*follow:/, 'PENDING 必须登记 follow（追问区）');
  const rendered = [];
  const sandbox = {
    URL: { revokeObjectURL() {}, createObjectURL: () => 'blob:x' },
    document: { getElementById: () => ({ innerHTML: '', addEventListener() {}, querySelector: () => null }), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener() {} },
    renderChips: t => rendered.push(t),
    $: () => ({ innerHTML: '', addEventListener() {} }),
    MAX_FILES: 20, console, Object, Array, Number, String, Boolean, Error, JSON, Math, RegExp, Promise, Map, Set,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(slice + '\nglobalThis.__api = { takeAttachments, clearAttachments, renderChips };').runInContext(sandbox);
  // 故意把 follow 删掉，模拟"忘了登记"的旧状态
  sandbox.PENDING && delete sandbox.PENDING.follow;
  for (const target of ['launch', 'ask', 'follow', '没登记过的新区域']) {
    assert.doesNotThrow(() => sandbox.__api.takeAttachments(target), `${target}：取附件不能因为没登记就抛错`);
    assert.doesNotThrow(() => sandbox.__api.clearAttachments(target), `${target}：清空附件不能抛错`);
  }
  assert.equal(sandbox.__api.takeAttachments('follow').length, 0, '没上传过就是空数组');
});
test('上传区的「选择文件/选择文件夹」不能带 href="#"（点了会跳到页面顶部，客户实测）', () => {
  assert.doesNotMatch(html, /<a href="#"[^>]*data-pick/, '这些链接必须去掉 href="#"');
  assert.match(html, /data-pick="follow"[^>]*>选择文件</, '追问区要有选择文件入口');
  assert.match(html, /data-pick-dir="follow"[^>]*>选择文件夹</, '追问区要有选择文件夹入口');
});
