// 看板问答面板：会话号要能选出历史会话、连续提问不改会话号、右侧显示同一会话的问答记录。
// 这里既做源码契约断言（容易漏的地方都在源码里），也在最小 DOM 上跑一遍渲染函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

// 客户要求：讨论/并行任务也要能追问，且**留在本任务里**继续（2026-10-10 改版：不再新开 ask 任务）。
test('讨论/并行任务详情里有「追问」入口，走 beat_followup 且留在本任务内', () => {
  assert.match(html, /r\.finished && r\.kind !== 'ask' \? `<div class="phase">在本任务里继续追问<\/div>/, '只对已结束的讨论/并行任务显示追问');
  assert.match(html, /id="followQ"/, '要有追问输入框');
  assert.match(html, /id="followAccess"[^>]*>[\s\S]{0,120}只问不改[\s\S]{0,120}要它动手改/, '要能选只问不改 / 要它动手改');
  assert.match(html, /id="followBtn"[^>]*title="留在本任务内继续：沿用原会话，问答与动手都由 BEAT 判断走哪条路"/, '按钮要说明留在本任务内、由 BEAT 判断');
  assert.match(html, /const next = await api\('beat_followup', \{ id: r\.id, question, access: \$\('followAccess'\)\.value, \.\.\.\(files\.length \? \{ attachments: files \} : \{\}\) \}\);/, '提交要走 beat_followup，且能带附件');
  assert.match(html, /const next = await api\('beat_followup'[\s\S]{0,200}clearAttachments\('follow'\)/, '提交成功后要清空追问附件');
  assert.match(html, /id="followDrop"[^>]*data-target="follow"[\s\S]{0,400}选择文件夹/, '追问区要能拖入文件/文件夹（发起任务有的能力，追问也要有）');
  assert.match(html, /function bindAttachmentPanel\(t\)/, '追问区的上传控件要注册进上传逻辑');
  // 粘贴截图改成事件委托：看板是动态重绘的，追问输入框只在任务结束时存在。
  // 客户实测：原来在页面加载时就 $(x).addEventListener，元素不存在 → TypeError → 整段脚本中止、看板白屏。
  assert.match(html, /document\.addEventListener\('paste'/, '粘贴要用事件委托，不能给可能不存在的元素直接挂监听');
  for (const box of ['goal', 'askQ', 'followQ']) {
    assert.match(html, new RegExp(`id="${box}"[^>]*data-paste=`), `${box} 要带 data-paste 标记（委托靠它分发）`);
  }
  // 契约：$() 拿不到元素时返回无害替身，任何 $(x).onclick=… 都不会再让看板崩掉
  assert.match(html, /const \$ = id => document\.getElementById\(id\) \|\| NOOP_ELEMENT;/, '$() 必须对空元素兜底（否则某个面板没打开就整页白屏）');
  assert.match(html, /const NOOP_ELEMENT = new Proxy/, '兜底元素要是 Proxy：挂事件、设属性都不报错');
  assert.match(html, /selected = next\.id; lastKey = ''; toast\(`追问已留在 \$\{next\.id\} 里继续（沿用原会话，不开新任务/, '追问后仍停在原任务，不切走');
  assert.match(html, /追问\*\*留在这条任务里\*\*：不必开会的直接答（不开会）/, '给客户一句人话说明');
  assert.match(html, /本任务的追问记录/, '追问记录要显示在原任务里');
});

test('两块任务分开：右边只放讨论/执行任务，一句话问答归问答模块自己的历史', () => {
  assert.match(html, /最近任务 <span class="meta" style="font-weight:400">讨论 \/ 执行<\/span> <span class="meta" style="font-weight:400" id="runsTitle"><\/span>/, '右边标题要写清只放讨论/执行，并留出总数位');
  assert.match(html, /\/\/ 两块分开：右边「最近任务」只放讨论\/执行任务；一句话问答归左边问答模块自己的历史。/);
  assert.match(html, /const discussRuns = runs\.filter\(r => r\.kind !== 'ask'\);/, '右边要过滤掉问答任务');
  assert.match(html, /const askRuns = runs\.filter\(r => r\.kind === 'ask'\);/, '问答单独取一份');
  assert.match(html, /function renderRunRows\(rows\)/, '右边有独立渲染函数');
  assert.match(html, /box\.innerHTML = visible\.length \? visible\.map/, '右边只渲染过滤后的讨论/执行任务');
  assert.match(html, /还没有讨论或执行任务/, '右边空态文案要分开');
  assert.match(html, /id="askHistory"/, '问答模块里要有自己的历史容器');
  assert.match(html, /function renderAskHistory\(rows\)/, '问答历史要有独立渲染');
  assert.match(html, /renderAskHistory\(askRuns\)/, '刷新时把问答历史喂给它');
  assert.match(html, /还没有问答记录；在上面问一句就会出现在这里。/, '问答空态文案');
  assert.match(html, /\$\('askHistory'\)\.onclick = e => \{\r?\n  const el = e\.target\.closest\('\.row-item'\); if \(!el\) return;\r?\n  selected = el\.dataset\.id;/, '点一条问答能打开它的记录');
  // 客户要求：点一条问答 = 选中那条会话，并把上面的模型切到对应模型（和切换会话号一致）
  assert.match(html, /data-session="\$\{esc\(r\.session_id \|\| ''\)\}" data-seat="\$\{esc\(r\.target \|\| ''\)\}"/, '问答每条要带会话号与问的是谁');
  assert.match(html, /const sessionId = el\.dataset\.session \|\| run\.session_id \|\| '';/, '点击时取出会话号');
  assert.match(html, /const seat = el\.dataset\.seat \|\| run\.target \|\| seatOfSession\(sessionId\);/, '点击时取出对应的模型');
  assert.match(html, /if \(sessionId\) \$\('askSession'\)\.value = sessionId;/, '点击就把会话号接上');
  assert.match(html, /const aligned = alignAskTo\(seat\);/, '点击就把上面的模型切过去（同一个对齐函数）');
  assert.match(html, /已切成 ' \+ aligned \+ \(sessionId \? '，并接上会话 ' \+ sessionId : ''\)/, '要告诉客户切了哪个模型、接上了哪条会话');
});

// 客户要求"从搭建平台开始到现在的都统计了"：两块都取全量历史并把总数写在标题上。
test('任务列表取全量历史并给出总数（不是只看最近 40 条）', () => {
  assert.match(html, /const all = await api\('run_index', \{\}\);/, '任务列表走全量接口');
  assert.match(html, /let ALL_RUNS = \[\], RUNS_FETCHED_AT = 0, RUNS_TRUNCATED = false;/, '全量任务有缓存位');
  assert.match(html, /\$\('runsTitle'\)\.textContent = `（显示 \$\{visible\.length\} \/ 共 \$\{total\} 个/, '讨论/执行那块要显示筛选后/总数');
  assert.match(html, /\$\('askHistoryTitle'\)\.textContent = `（显示 \$\{visible\.length\} \/ 共 \$\{total\} 条/, '问答那块要显示筛选后/总数');
  assert.match(html, /id="askHistoryTitle"/, '问答标题要有总数位');
});

// 把会话号那一段逻辑放进假 DOM 里真跑一遍：user 报的 bug 就是"选过一条之后再点打不开"。
function sessionHarness() {
  const els = new Map();
  const make = (id, tag = 'div') => {
    const e = { id, tagName: tag, value: '', hidden: false, innerHTML: '', onclick: null, attrs: {}, classes: new Set(), listeners: {}, dataset: {},
      classList: { toggle: (c, on) => { on ? e.classes.add(c) : e.classes.delete(c); }, add: c => e.classes.add(c), remove: c => e.classes.delete(c), contains: c => e.classes.has(c) },
      setAttribute: (k, v) => { e.attrs[k] = String(v); }, getAttribute: k => (k in e.attrs ? e.attrs[k] : null),
      addEventListener: (t, fn) => { (e.listeners[t] ||= []).push(fn); }, contains: t => t && t.__inside === true };
    els.set(id, e); return e;
  };
  const input = make('askSession', 'input'), toggle = make('askSessionToggle', 'button'), list = make('askSessionList'), wrap = make('askSessionWrap');
  const askTo = make('askTo', 'select');
  askTo.value = 'codex';
  askTo.options = [{ value: 'codex', textContent: 'Codex' }, { value: 'deepseek', textContent: 'DeepSeek' }, { value: 'claude', textContent: 'Claude' }, { value: 'dock:a606e728', textContent: 'GLM（拓展坞）' }];
  toggle.attrs['aria-expanded'] = 'false';
  for (const e of [input, toggle, list, wrap]) e.__inside = true;
  return { els, input, toggle, list, wrap, askTo };
}
async function runSessionSnippet() {
  const start = html.indexOf('// 会话号下拉：点右边的小三角展开/收起');
  const code = html.slice(start, html.indexOf("$('askTo').onchange", start));
  assert.ok(start > 0 && code.length > 200, '要能取到会话号那一段代码');
  const h = sessionHarness();
  const document = { listeners: {}, addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); } };
  const context = vm.createContext({ document, $: id => h.els.get(id), esc: v => String(v ?? ''), nameOf: v => String(v),
    fillAskEffort() {}, refresh() {}, toast() {},
    LAST_RUNS: [{ id: 'R147', session_id: 'S62', goal: '问题一', tokens: 542, target: 'dock:a606e728' }, { id: 'R99', session_id: 'S99', goal: '老会话', tokens: 100, target: 'deepseek' }],
    SESSIONS: [{ id: 'S62', seat: 'dock:a606e728', model: 'glm-5.3' }, { id: 'S61', seat: 'codex', model: 'codex-x' }],
    api: async () => ({ items: [{ id: 'S62', model: 'glm-5.3', seat: 'dock:a606e728' }, { id: 'S61', model: 'codex-x', seat: 'codex' }] }) });
  vm.runInContext(code, context);
  const tick = () => new Promise(r => setTimeout(r, 0));
  const clickToggle = () => h.toggle.onclick({ stopPropagation() {} });
  const pick = (id, seat = '') => { const item = { dataset: { session: id, seat }, closest: () => item }; for (const fn of h.list.listeners.mousedown || []) fn({ target: item, preventDefault() {} }); };
  return { h, context, ctx: context, document, tick, clickToggle, pick };
}

test('小三角真的能反复开合：选过一条之后再点仍然能展开（用户实测的 bug）', async () => {
  const { h, document, tick, clickToggle, pick } = await runSessionSnippet();
  clickToggle(); await tick();
  assert.equal(h.list.hidden, false, '第一次点小三角要展开');
  assert.equal(h.toggle.attrs['aria-expanded'], 'true', '展开状态要写进 aria');
  assert.equal(h.toggle.classes.has('open'), true, '三角要转过来');
  assert.match(h.list.innerHTML, /S62/, '要列出历史会话');
  clickToggle();
  assert.equal(h.list.hidden, true, '再点一次收起');
  clickToggle(); await tick();
  assert.equal(h.list.hidden, false, '第三次还能再展开——这就是之前"选过一次就打不开"的地方');
  pick('S62');
  assert.equal(h.input.value, 'S62', '点一条会话就把它填进会话号');
  assert.equal(h.list.hidden, true, '选完收起');
  clickToggle(); await tick();
  assert.equal(h.list.hidden, false, '选过之后还能再点开');
  // 用户实测：选完 S62 之后输入框里就是 "S62"，再展开只剩 S62 自己，换不了别的会话——必须仍然列全部。
  assert.match(h.list.innerHTML, /S61/, '选过一条之后再展开，别的会话仍然要列出来');
  assert.match(h.list.innerHTML, /S62/);
  assert.equal((h.list.innerHTML.match(/data-session=/g) || []).length, 2, '两条会话都要在列表里');
  pick('S61');
  assert.equal(h.input.value, 'S61', '换成另一条会话也行');
  clickToggle(); await tick();
  for (const fn of document.listeners.mousedown || []) fn({ target: {} });
  assert.equal(h.list.hidden, true, '点别处收起');
  for (const fn of h.input.listeners.mousedown || []) fn({ target: h.input });
  await tick();
  assert.equal(h.list.hidden, false, '收起后点输入框也能再展开');
});

test('会话号是一个可选历史会话的下拉：列出会话、点一条就选中并打开它的记录', () => {
  assert.match(html, /id="askSessionList"/, '要有历史会话下拉容器');
  assert.match(html, /class="sess-list"/, '下拉要有样式');
  assert.match(html, /api\('beat_sessions'/, '下拉内容来自会话列表接口');
  assert.match(html, /openSessionList\(/, '要有一个函数负责列出历史会话');
  assert.match(html, /data-session="\$\{esc\(s\.id\)\}"/, '每条会话都要能点');
  assert.match(html, /const id = item\.dataset\.session;[\s\S]{0,200}\$\('askSession'\)\.value = id;/, '点了就把会话号填进去');
  assert.match(html, /sessionStats\(\)/, '下拉里要显示每条会话的问答条数/用量');
  assert.match(html, /还没有历史会话；直接提问就会开一条新的。/, '没有历史会话时给人话提示');
});

// 上一版只在 focus 时打开：用鼠标选完一条后输入框一直是焦点，第二次点就再也打不开（用户实测）。
test('小三角点一下展开、再点一下收起——选过之后还能再点开', () => {
  assert.match(html, /id="askSessionToggle"[^>]*class="sess-toggle"[^>]*aria-expanded="false"/, '要有独立的小三角按钮和展开状态');
  assert.match(html, /\.sess-toggle\.open \{ transform:translateY\(-50%\) rotate\(180deg\); \}/, '展开时三角要转过来，看得出开合');
  assert.match(html, /\$\('askSessionToggle'\)\.onclick = e => \{ e\.stopPropagation\(\); if \(SESS_OPEN\) showSessionList\(false\); else openSessionList\(''\); \}/, '点小三角明确开/合，且列出全部会话（不受输入框内容过滤）');
  assert.match(html, /const needle = SESSIONS\.some\(s => String\(s\.id\)\.toLowerCase\(\) === typed\) \? '' : typed;/, '输入框里正好是一个完整会话号时不当作过滤条件');
  assert.match(html, /let SESS_OPEN = false/, '开合状态由自己记，不靠读 DOM');
  assert.match(html, /SESS_OPEN = show === undefined \? !SESS_OPEN : show === true;/, 'showSessionList 没有参数时就是切换');
  assert.match(html, /box\.hidden = !SESS_OPEN; btn\.classList\.toggle\('open', SESS_OPEN\); btn\.setAttribute\('aria-expanded', String\(SESS_OPEN\)\);/, '开合要同时改列表、三角和 aria 状态');
  assert.match(html, /\$\('askSession'\)\.addEventListener\('mousedown', \(\) => \{ if \(!SESS_OPEN\) openSessionList\(/, '点输入框也能展开（选过一条之后仍然有效）');
  assert.doesNotMatch(html, /addEventListener\('blur'[\s\S]{0,120}askSessionList/, '不许再用 blur 收起：它会在点列表项时打断选择，而且焦点一直在输入框里就再也点不开');
  assert.match(html, /document\.addEventListener\('mousedown', e => \{ if \(SESS_OPEN && !\$\('askSessionWrap'\)\.contains\(e\.target\)\) showSessionList\(false\); \}\)/, '点别处才收起');
  assert.match(html, /\$\('askSession'\)\.value = id;\r?\n  showSessionList\(false\);[\s\S]{0,300}fillAskEffort\(\);/, '选中一条就把列表收起来');
  assert.match(html, /if \(SESS_OPEN\) openSessionList\(\$\('askSession'\)\.value\);/, '打字过滤只在展开时做');
  assert.match(html, /SESS_FETCHED_AT > 5000/, '会话列表短时间缓存，打字时不反复请求');
});

test('连续提问不自动清空、也不改会话号（想开新任务由客户清空）', () => {
  const submit = html.slice(html.indexOf("$('askBtn').onclick"), html.indexOf('// 会话号下拉'));
  assert.match(submit, /if \(r\.session_id\) \$\('askSession'\)\.value = r\.session_id;/, '提交后要把会话号留在输入框里');
  assert.doesNotMatch(submit, /\$\('askSession'\)\.value = '';/, '提交路径里不许把会话号清掉');
  assert.match(submit, /开始新需求/, '客户用按钮开始新需求，无需手工处理会话号');
  assert.match(submit, /session_id:\s*askedSession \|\| undefined/, '会话号照旧传给 beat_ask，连续提问接在同一条会话上');
});

// 用户问：在 glm 的会话里续问、但模型选着 Codex，会发生什么？后端会拒绝（会话固定属于一个搭档），
// 但看板不该让客户白填一遍——选中会话就自动把「问谁」切成它的主人。
test('续问自动对齐「问谁」：glm 的会话不会被 Codex 接走', async () => {
  assert.match(html, /function seatOfSession\(/, '要能从会话号查出它的主人');
  assert.match(html, /function alignAskTo\(/, '要有把「问谁」对齐到会话主人的函数');
  assert.match(html, /data-seat="\$\{esc\(s\.seat \|\| s\.target \|\| ''\)\}"/, '下拉每条要带会话的主人');
  assert.match(html, /const aligned = alignAskTo\(item\.dataset\.seat\);/, '点会话就顺手对齐模型');
  assert.match(html, /const seat = seatOfSession\(askedSession\);/, '提交前也要按会话号对齐一次');
  assert.match(html, /会话 ' \+ askedSession \+ ' 是问 ' \+ nameOf\(seat\) \+ ' 的；它现在不在上面的可选列表里/, '搭档不在可选列表里时给人话，而不是让后端拒');

  const { ctx, tick } = await runSessionSnippet();
  assert.equal(ctx.seatOfSession('S62'), 'dock:a606e728', '从会话列表拿到主人');
  assert.equal(ctx.seatOfSession('s62'), 'dock:a606e728', '大小写不敏感');
  assert.equal(ctx.seatOfSession('S99'), 'deepseek', '会话列表里没有时用最近任务推');
  assert.equal(ctx.seatOfSession('S404'), null, '不认识的会话返回 null');
  assert.equal(ctx.seatOfSession(''), null, '空值不下结论');
  // 下拉选项：codex / deepseek / claude / glm
  const sel = ctx.$('askTo');
  sel.value = 'codex';
  assert.equal(ctx.alignAskTo('dock:a606e728'), 'GLM（拓展坞）', '对齐成功时返回下拉里的显示名');
  assert.equal(sel.value, 'dock:a606e728', '下拉真的切过去了');
  assert.equal(ctx.alignAskTo('dock:a606e728'), true, '已经对齐就不动它');
  assert.equal(ctx.alignAskTo('dock:missing'), false, '搭档不在列表里返回 false，交给调用方提示');
  assert.equal(sel.value, 'dock:a606e728', '失败时不许把选择弄乱');
  await tick();
});

test('右侧会话记录：同一条会话的问答按顺序显示，当前这条高亮', () => {  assert.match(html, /api\('session_history', \{ session_id: sessionId, limit: 30 \}\)/, '记录来自会话历史接口');
  assert.match(html, /function renderSessionStream\(/, '要有渲染会话记录的函数');
  assert.match(html, /r\.kind === 'ask' && r\.session_id \? `<div class="phase">会话记录/, '问答类任务才显示会话记录');
  assert.match(html, /renderSessionStream\(r\.session_id, r\.id\)/, '打开详情时要把这条会话的记录画出来');
  assert.match(html, /<div class="ask">你：\$\{esc\(x\.goal\)\}<\/div>/, '每条要显示问题');
  assert.match(html, /<div class="ans">\$\{x\.result \? mdLite\(linkify\(x\.result\)\)/, '每条要显示答复（路径仍可点开，Markdown 符号不直接露出）');
  assert.match(html, /x\.id === currentRunId \? 'cur' : ''/, '当前这条要高亮');
  assert.match(html, /\.stream \.qa\.cur \{/, '高亮要有样式');
  assert.match(html, /data-run="\$\{esc\(x\.id\)\}"[\s\S]{0,600}selected = el\.dataset\.run;/, '点记录里的一条能切到那条任务');
});
