// 浏览器核验的契约测试。
//
// 历史教训（不要改回去）：旧版本把含 <script> 的页面整体排除在渲染核验之外，
// 且排除得没有任何记录。于是"2D 动画"这类最典型的交付物永远拿不到渲染证据，
// 执行者只能手搓浏览器、撞上 GPU 崩溃，最后一轮烧掉 82.9 万 token 判失败。
// 旧测试把这个缺陷当成了规格（assert.equal(eligible, false)），所以 543 条全绿也盖不住。
// 现在这里断言的是：能验的必须真验，不能验的必须留下带原因的记录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { classifyHtml, inlineHtmlEligible, browserCandidates, browserPathCandidates, browserProfileBase, describeRenderEvidence, describeRenderGaps, renderHtmlEvidence, visualAcceptance, wantsHtmlRender } from '../src/html-render-verification.mjs';
import { tempDir } from './helpers/temp.mjs';

test('无脚本的内联 SVG 页面：可自动渲染，不开脚本', () => {
  const c = classifyHtml('<svg><path fill="url(#g)"/></svg><style>@keyframes a{to{transform:rotate(360deg)}}</style>');
  assert.equal(c.eligible, true); assert.equal(c.scripted, false); assert.equal(c.reason, null);
  assert.equal(inlineHtmlEligible('<svg></svg>'), true, '旧布尔接口语义不变');
});

test('含 <script> / 内联事件 / javascript: URL 的页面：仍然要真渲染，只是标记为需要开脚本', () => {
  for (const content of ['<script>alert(1)</script>', '<svg onload="x()"></svg>', '<a href="javascript:void 0">x</a>']) {
    const c = classifyHtml('<svg></svg>' + content);
    assert.equal(c.eligible, true, content + ' 不能再被静默排除');
    assert.equal(c.scripted, true, content);
    assert.equal(c.reason, null);
  }
});

test('确实不能自动渲染的页面：一律带原因，绝不静默跳过', () => {
  const blocked = {
    '<iframe srcdoc="x"></iframe>': /iframe/,
    '<img src="a.png">': /外部/,
    '<style>@import "https://a";</style>': /@import/,
    '<style>x{background:url(file:///private.txt)}</style>': /@import/,
    '<image href="file:///private.png"/>': /外部/,
    '<body background="file:///private.png">': /外部/,
    '<meta http-equiv="refresh" content="0;url=https://a">': /meta/,
    '<video poster="file:///private.png"></video>': /外部/,
  };
  for (const [content, pattern] of Object.entries(blocked)) {
    const c = classifyHtml('<svg></svg>' + content);
    assert.equal(c.eligible, false, content);
    assert.ok(c.reason && pattern.test(c.reason), `${content} 必须给出可读原因，实际：${c.reason}`);
  }
  const noSvg = classifyHtml('<div>hello</div>');
  assert.equal(noSvg.eligible, false);
  assert.ok(noSvg.reason, '不是可视化交付物也要有原因');
});

test('含查询选择器的脚本不会被误判成外链', () => {
  const c = classifyHtml('<svg><g id="a"/></svg><script>document.querySelector("#a").setAttribute("x","1");</script>');
  assert.equal(c.eligible, true); assert.equal(c.scripted, true);
});

test('否定式验收（"无外链图片"）不算视觉要求，不触发自动渲染（R408 回归）', async () => {
  // R408 的 A4 打印页：验收里一句"无外链字体或图片"曾被当成"要看图"，
  // 页面没有内联 <svg> 就永远拿不到核验图片，整条交付链卡死。
  assert.equal(wantsHtmlRender({ acceptance: ['HTML只本地引用report.css，无外链字体或图片', '@page设为A4并设置合理页边距，含封面与页码', '评分表结构完整，正文全部落入页面'] }), false);
  assert.equal(wantsHtmlRender({ acceptance: ['不要出现截图，不含图片'] }), false);
  assert.equal(visualAcceptance(['无外链字体或图片']), '');
  const dir = tempDir();
  const html = path.join(dir, 'report.html');
  fs.writeFileSync(html, '<!doctype html><html><head><link rel="stylesheet" href="report.css"></head><body><p>打印页</p></body></html>');
  let looked = 0;
  const results = await renderHtmlEvidence({ cwd: dir, task: { acceptance: ['HTML只本地引用report.css，无外链字体或图片', '评分表结构完整，正文全部落入页面'] },
    artifacts: [{ path: html }], evidenceRoot: path.join(dir, 'evidence'), profileRoot: path.join(dir, 'profile'),
    findBrowsers: () => { looked++; return []; } });
  assert.deepEqual(results, []);
  assert.equal(looked, 0, '没有视觉要求时不该探测浏览器');
});

test('确实要求看画面时仍然真渲染；浏览器缺失要留下可读原因', async () => {
  assert.equal(wantsHtmlRender({ acceptance: ['画面清晰，没有裁切'] }), true);
  const dir = tempDir();
  const svg = path.join(dir, 'scene.svg');
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const results = await renderHtmlEvidence({ cwd: dir, task: { acceptance: ['画面清晰'] }, artifacts: [{ path: svg }],
    evidenceRoot: path.join(dir, 'evidence'), profileRoot: path.join(dir, 'profile'), findBrowsers: () => [] });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'browser-missing');
  assert.match(describeRenderGaps(results)[0] || '', /浏览器/);
});

test('浏览器发现覆盖多厂商与用户级安装位置，不只认两个硬编码路径', () => {
  const fakeEnv = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
  };
  const win = browserPathCandidates(fakeEnv, 'win32');
  const norm = win.map(p => p.replaceAll('\\', '/').toLowerCase());
  // 三家的系统级位置都要探测；旧实现只认 Chrome+Edge 且只认 Program Files。
  for (const expected of [
    'c:/program files/google/chrome/application/chrome.exe',
    'c:/program files/microsoft/edge/application/msedge.exe',
    'c:/program files/bravesoftware/brave-browser/application/brave.exe',
  ]) assert.ok(norm.includes(expected), `缺少候选：${expected}`);
  // 用户级安装（LocalAppData）与 32 位目录也要覆盖。
  assert.ok(norm.some(p => p.startsWith('c:/users/x/appdata/local/')), '缺少用户级安装位置');
  assert.ok(norm.some(p => p.startsWith('c:/program files (x86)/')), '缺少 32 位安装位置');
  // 非 Windows 平台也要有候选，而不是直接落空。
  assert.ok(browserPathCandidates({}, 'linux').length > 0);
  assert.ok(browserPathCandidates({}, 'darwin').length > 0);
  // 真实可用清单只保留确实存在的文件。
  for (const file of browserCandidates()) assert.ok(fs.existsSync(file));
});

test('真实后台浏览器：无脚本页面照旧，脚本驱动的动画也要能拿到帧证据', async t => {
  if (!browserCandidates().length) { t.skip('本机无已安装浏览器，真实渲染未验证'); return; }
  const cwd = tempDir('render'), file = path.join(cwd, 'sample.html');
  fs.writeFileSync(file, '<!doctype html><style>.wheel{transform-origin:50px 50px;animation:spin 2s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><svg viewBox="0 0 100 100" width="100" height="100"><g id="wheel" class="wheel"><circle cx="50" cy="50" r="30" fill="#ffe" stroke="#123"/><path d="M50 50L70 50" stroke="#123"/></g></svg>');
  const results = await renderHtmlEvidence({ cwd, task: { acceptance: ['浏览器动画'] }, artifacts: [{ path: file }], evidenceRoot: path.join(cwd, 'evidence'), signal: AbortSignal.timeout(60000) });
  assert.equal(results.length, 1); const result = results[0]; assert.equal(result.status, 'rendered', result.issue);
  // 这个页面没有脚本、只有 CSS 动画，所以脚本执行是关闭的，采样走 CSS 时间线。
  assert.equal(result.scriptExecution, 'disabled');
  assert.equal(result.samplingMode, 'css-timeline');
  const evidence = JSON.parse(fs.readFileSync(result.evidencePath));
  assert.equal(evidence.pageScriptsDisabled, true);
  assert.equal(evidence.networkBlocked, true);
  assert.equal(evidence.cycleMilliseconds, 2000);
  assert.equal(evidence.exactLoopFramesEqual, true, '几何真值判定：整周期首尾应一致');
  assert.ok(evidence.distinctGeometry > 1, '几何应随旋转变化');
  assert.deepEqual(evidence.externalRequests, []); assert.deepEqual(evidence.errors, []);
  assert.notEqual(evidence.samples[0].sha256, evidence.samples[1].sha256, '实际采样帧存在旋转');
  // 几何必须是真数值，而且必须能反映 CSS 动画的旋转。
  // 旧实现只取 getScreenCTM()，CSS 动画旋转在它眼里六帧完全一样——那种证据证明不了轮子在转；
  // 更早还把 SVGMatrix 直接 toString()，得到 "[object SVGMatrix]"。
  const cssMatrixAt = (geometry, id) => (geometry.animated || []).find(item => item.id === id)?.cssMatrix;
  const angleAt = t => { const m = cssMatrixAt(evidence.samples.find(s => s.milliseconds === t).geometry, 'wheel'); return m ? Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI) : null; };
  const first = cssMatrixAt(evidence.samples[0].geometry, 'wheel');
  assert.ok(Array.isArray(first) && first.length === 6, 'CSS 动画元素必须有 6 个数值的合成矩阵');
  for (const value of first) assert.equal(typeof value, 'number', '矩阵不允许是 "[object SVGMatrix]" 字符串');
  assert.notEqual(angleAt(0), angleAt(1500), 'CSS 动画旋转必须在几何证据里体现出来');
  const svgItems = evidence.samples[0].geometry.svg || [];
  assert.ok(svgItems.length > 0, 'SVG 属性变换的几何也要保留');
  for (const item of svgItems) assert.ok(Array.isArray(item.screenCTM) && item.screenCTM.length === 6);
  for (const sample of evidence.samples) assert.equal(createHash('sha256').update(fs.readFileSync(sample.screenshot)).digest('hex'), sample.sha256);
});

test('真实后台浏览器：脚本驱动（requestAnimationFrame）的动画同样产出渲染证据且网络仍全拦', async t => {
  if (!browserCandidates().length) { t.skip('本机无已安装浏览器，真实渲染未验证'); return; }
  const cwd = tempDir('render'), file = path.join(cwd, 'scripted.html');
  // 这正是 R152 那类交付物：SVG + JS 驱动动画 + 暂停/调速按钮。
  fs.writeFileSync(file, `<!doctype html><title>scripted</title><svg viewBox="0 0 100 100" width="100" height="100"><g id="arm"><rect x="48" y="40" width="40" height="6" fill="#123"/></g></svg>
<button id="pause">暂停</button>
<script>
  const arm = document.getElementById('arm');
  let playing = true;
  document.getElementById('pause').onclick = () => { playing = !playing; };
  const start = performance.now();
  function frame(now) { const t = (now - start) / 1000; if (playing) arm.setAttribute('transform', 'rotate(' + (t * 90 % 360) + ' 50 45)'); requestAnimationFrame(frame); }
  requestAnimationFrame(frame);
</script>`);
  const results = await renderHtmlEvidence({ cwd, task: { acceptance: ['浏览器动画视觉'] }, artifacts: [{ path: file }], evidenceRoot: path.join(cwd, 'evidence'), signal: AbortSignal.timeout(60000) });
  assert.equal(results.length, 1);
  const result = results[0];
  assert.equal(result.status, 'rendered', result.issue);
  assert.equal(result.scriptExecution, 'enabled-network-blocked');
  assert.equal(result.scripted, true);
  const evidence = JSON.parse(fs.readFileSync(result.evidencePath));
  assert.equal(evidence.networkBlocked, true, '开脚本不等于开网络');
  assert.deepEqual(evidence.externalRequests, [], '脚本没能发出任何外部请求');
  assert.equal(evidence.scriptExecution, 'enabled-network-blocked');
  // JS 驱动的动画不受暂停控制，控制器不能声称"首尾闭合/不闭合"——必须诚实地不表态。
  assert.equal(evidence.exactLoopFramesEqual, null, '脚本页首尾闭合不下结论，而不是编造"未闭合"');
  assert.ok(evidence.loopClosureNote, '不给结论时要说清原因');
  assert.match(evidence.loopClosureNote, /脚本/);
  // JS 驱动的动画不进 document.getAnimations()，必须走真实时间采样才采得到帧。
  assert.equal(evidence.samplingMode, 'real-time');
  const distinct = new Set(evidence.samples.map(s => s.sha256)).size;
  assert.ok(distinct > 1, `脚本动画应产生不同帧，实际 ${distinct} 种`);
  assert.equal(evidence.distinctFrames, distinct);
  // 几何真值也要跟着动。
  const moved = new Set(evidence.samples.map(s => JSON.stringify(s.geometry))).size;
  assert.ok(moved > 1, `脚本动画应让几何发生变化，实际 ${moved} 种`);
  assert.ok(describeRenderEvidence([result]).includes('真实时间采样'), '给客户的说明要讲清是真实时间采样');
});

test('不含脚本的页面不引入脚本执行标记', async t => {
  if (!browserCandidates().length) { t.skip('本机无已安装浏览器，真实渲染未验证'); return; }
  const cwd = tempDir('render'), file = path.join(cwd, 'plain.html');
  fs.writeFileSync(file, '<!doctype html><svg viewBox="0 0 10 10"><rect id="r" width="4" height="4"/></svg>');
  const results = await renderHtmlEvidence({ cwd, task: { acceptance: ['画面视觉'] }, artifacts: [{ path: file }], evidenceRoot: path.join(cwd, 'evidence'), signal: AbortSignal.timeout(60000) });
  assert.equal(results[0].status, 'rendered', results[0].issue);
  assert.equal(results[0].scriptExecution, 'disabled');
});

test('证据路径过长时浏览器 profile 改用短临时目录（避免 Chrome 因路径过长启动失败）', t => {
  // 实测：profile 约 246 字符时 Chrome 退出码 21，报 Lock file can not be created。
  const longRoot = 'C:\\' + 'very-deep-folder\\'.repeat(14) + 'profile';
  const picked = browserProfileBase(longRoot);
  assert.equal(picked.temporary, true, '超长根目录必须切到短临时目录');
  assert.ok(picked.base.length < 160, '短目录要足够短：' + picked.base);
  const normal = browserProfileBase(path.join(tempDir('prof'), 'profile'));
  assert.equal(normal.temporary, false, '正常路径保持原样，不动证据目录结构');
});

test('不能渲染的文件会带着原因进入结果，而不是从数组里消失', async () => {
  const cwd = tempDir('render-skip');
  const file = path.join(cwd, 'external.html');
  fs.writeFileSync(file, '<!doctype html><svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg><img src="https://example.com/a.png">');
  const results = await renderHtmlEvidence({ cwd, task: { acceptance: ['画面视觉'] }, artifacts: [{ path: file }], evidenceRoot: path.join(cwd, 'evidence'), findBrowsers: () => [], signal: AbortSignal.timeout(10000) });
  assert.equal(results.length, 1, '被跳过的交付物必须出现在结果里');
  assert.equal(results[0].status, 'skipped');
  assert.ok(results[0].issue, '必须写明跳过原因');
  const gaps = describeRenderGaps(results);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /external\.html/); assert.match(gaps[0], /未做自动渲染核验/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('本机没有浏览器时要显式告警，不能静默无证据', async () => {
  const cwd = tempDir('render-nobrowser');
  const file = path.join(cwd, 'ok.html');
  fs.writeFileSync(file, '<!doctype html><svg viewBox="0 0 10 10"><rect id="r" width="4" height="4"/></svg>');
  const results = await renderHtmlEvidence({ cwd, task: { acceptance: ['画面视觉'] }, artifacts: [{ path: file }], evidenceRoot: path.join(cwd, 'evidence'), findBrowsers: () => [], signal: AbortSignal.timeout(10000) });
  assert.equal(results[0].status, 'browser-missing');
  assert.match(results[0].issue, /浏览器/);
  assert.match(describeRenderGaps(results)[0], /没有可用于核验的浏览器/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('三次启动尝试都失败时，错误里带上每一组参数的原因', async () => {
  const cwd = tempDir('render-launchfail');
  const file = path.join(cwd, 'ok.html');
  fs.writeFileSync(file, '<!doctype html><svg viewBox="0 0 10 10"><rect id="r" width="4" height="4"/></svg>');
  const fakeLaunch = async () => { const error = Error('后台浏览器三次启动尝试都失败（默认: GPU 子进程不可用；软件渲染: GPU 子进程不可用；最小参数: GPU 子进程不可用）'); error.attempts = [{ attempt: 1, args: '默认', error: 'GPU 子进程不可用' }, { attempt: 2, args: '软件渲染', error: 'GPU 子进程不可用' }, { attempt: 3, args: '最小参数', error: 'GPU 子进程不可用' }]; throw error; };
  const results = await renderHtmlEvidence({ cwd, task: { acceptance: ['画面视觉'] }, artifacts: [{ path: file }], evidenceRoot: path.join(cwd, 'evidence'), findBrowsers: () => ['C:/fake/chrome.exe'], launch: fakeLaunch, signal: AbortSignal.timeout(10000) });
  assert.equal(results[0].status, 'launch-failed');
  assert.match(results[0].issue, /三次启动尝试都失败/);
  assert.equal(results[0].launchAttempts.length, 3);
  assert.match(describeRenderGaps(results)[0], /后台浏览器启动失败/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('describeRenderEvidence 对成功与失败都给客户看得懂的话', () => {
  const rendered = describeRenderEvidence([{ file: 'a.html', status: 'rendered', browser: 'Chrome/154', structure: { svg: 1, animations: [{}, {}] }, cycleMilliseconds: 2400, exactLoopFramesEqual: true, screenshots: ['1', '2'], scriptExecution: 'enabled-network-blocked', evidencePath: 'E:/e.json' }]);
  assert.match(rendered, /Chrome\/154/);
  assert.match(rendered, /动画 2 个/);
  assert.match(rendered, /循环 2400ms/);
  assert.match(rendered, /页面脚本已执行/);
  assert.equal(describeRenderEvidence([]), '', '没有核验记录时不塞噪音');
  assert.match(describeRenderEvidence([{ file: 'x.html', status: 'unverified', issue: '后台浏览器暂不可用' }]), /BEAT 浏览器核验未完成：x\.html（unverified：后台浏览器暂不可用）/);
  assert.deepEqual(describeRenderGaps([{ status: 'rendered' }]), [], '成功的记录不进缺口清单');
});
