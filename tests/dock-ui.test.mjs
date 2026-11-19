import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const inlineScript = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
const between = (start, end) => inlineScript.slice(inlineScript.indexOf(start), inlineScript.indexOf(end, inlineScript.indexOf(start)));

test('连接失败主提示直接呈现后端分类与处理办法，并刷新状态，不只藏在详细诊断', async () => {
 const fields={dResult:{innerHTML:''},dBase:{focus(){}}};let shown;let refreshed=0;
 const context=vm.createContext({$:id=>fields[id],api:async()=>({ok:false,requiresAction:true,error:'raw diagnostic',customerIssue:{title:'服务商限制客户端',message:'请联系服务商开放普通 API 调用权限。'}}),localIssue:(_id,issue,actions)=>{shown={issue,actions};},refresh:async()=>{refreshed++;}});
 vm.runInContext(between('async function testDockConnection(', 'async function continueWithBudget('),context);
 await context.testDockConnection('dock:wawa');
 assert.equal(shown.issue.title,'服务商限制客户端');
 assert.match(shown.issue.message,/开放普通 API/);
 assert.ok(shown.actions.some(a=>a.label==='处理后重新测试'));
 assert.equal(refreshed,1);
});

test('拓展坞卡片常驻显示具体失败原因且转义服务商消息',()=>{
 const fields={agents:{innerHTML:''},askTo:{dataset:{initialized:'true'}}};
 const context=vm.createContext({$:id=>fields[id],syncAskOptions(){},orderPartners:a=>a,DOCK:[{id:'dock:wawa',name:'wawa-Claude',model:'claude-opus-5-5'}],isDockId:id=>id.startsWith('dock:'),STATUS:{offline:'离线'},AG:{},esc:value=>String(value??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),time:()=>'',ROLE_OF:{},READY_PARTNERS:[]});
 vm.runInContext(between('function renderAgents(', "$('agents').onclick"),context);
 context.renderAgents({'dock:wawa':{agent:'dock:wawa',status:'offline',failureReason:'服务商限制客户端',reason:'请联系服务商开放权限 <script>'}});
 assert.match(fields.agents.innerHTML,/服务商限制客户端/);
 assert.match(fields.agents.innerHTML,/请联系服务商开放权限/);
 assert.match(fields.agents.innerHTML,/&lt;script&gt;/);
 assert.doesNotMatch(fields.agents.innerHTML,/<script>/);
});

function fixture(overrides = {}) {
  const fields = Object.fromEntries(['dReasoningProtocol', 'dModel', 'dBase', 'dPreset', 'dEffort', 'dEffortHint', 'dockModal', 'dSave', 'dResult', 'askTo', 'askEffort', 'askEffortHint', 'askSession'].map(id => [id, { value: '', innerHTML: '', textContent: '', disabled: false, hidden: false, querySelectorAll: () => [], focus() {} }]));
  fields.dBase.value = 'https://gateway.example/v1'; fields.dModel.value = 'glm-5.3'; fields.dPreset.value = 'custom';
  const context = vm.createContext({
    $: id => fields[id], fields,
    EFFORT: { low: '轻度', high: '高', off: '关闭' },
    esc: value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
    effortLabel: value => value, nameOf: value => value,
    isDockId: value => String(value).startsWith('dock:'),
    DOCK: [], SETTINGS: {}, MODELS: {}, clearTimeout, setTimeout,
    api: async () => ({ status: 'unknown', supported: false, options: [] }),
    fillEffort: () => {}, ...overrides,
  });
  vm.runInContext(between('function issueBody(', '// Permission decisions'), context);
  vm.runInContext(between('function localIssue(', 'function renderWorkspaceRequests('), context);
  vm.runInContext(between('function dockReasoningOptions(', 'const toolsCap ='), context);
  vm.runInContext(between('function fillAskEffort()', '// ---------- 附件 ----------'), context);
  vm.runInContext(between('let PRESETS = []', 'async function openDock('), context);
  return { context, fields };
}

test('page script parses and only native partners can initiate', () => {
  new vm.Script(inlineScript.replace('__BEAT_TOKEN__', '"test-token"'));
  const initiator = html.match(/<select id="initiator">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...initiator.matchAll(/value="([^"]+)"/g)].map(m => m[1]), ['codex', 'deepseek', 'zcode']);
  assert.match(html, /拓展坞＋助手地位相同，同轮讨论分工/);
  assert.doesNotMatch(html, /启用（参与顶替）|顶替（只读：讨论、评估、顾问）/);
});

test('unknown and unsupported reasoning capabilities remain distinct', () => {
  const { context, fields } = fixture();
  context.fillDockEffort(fields.dEffort, { status: 'unknown', supported: false, options: [{ value: 'high' }] }, 'high');
  assert.equal(fields.dEffort.disabled, true);
  assert.equal(fields.dEffort.value, '');
  assert.match(fields.dEffort.innerHTML, /能力未知，默认由接口决定/);
  context.fillDockEffort(fields.dEffort, { status: 'unsupported', supported: false, options: [] });
  assert.match(fields.dEffort.innerHTML, /不提供推理强度选择/);
  assert.doesNotMatch(context.reasoningHint({ status: 'unknown' }), /不提供/);
});

test('selector only exposes backend capability options and preserves a supported selection', () => {
  const { context, fields } = fixture();
  const cap = { status: 'supported', supported: true, options: [{ value: 'off', label: '关闭' }, { value: 'high', label: '高' }] };
  context.fillDockEffort(fields.dEffort, cap, 'high');
  assert.equal(fields.dEffort.disabled, false);
  assert.equal(fields.dEffort.value, 'high');
  assert.match(fields.dEffort.innerHTML, /value="off"/);
  assert.doesNotMatch(fields.dEffort.innerHTML, /value="low"|value="max"/);
  context.fillDockEffort(fields.dEffort, cap, 'max');
  assert.equal(fields.dEffort.value, '');
});

test('quick ask honors dock capabilities, dock default and session continuation', () => {
  const dock = { id: 'dock:glm', defaultEffort: 'high', reasoning: { status: 'supported', supported: true, evidenceStatus: 'declared', options: [{ value: 'high', label: '高' }] } };
  const { context, fields } = fixture({ DOCK: [dock] });
  fields.askTo.value = dock.id; fields.askEffort.value = 'high'; fields.askSession.value = 'S-1';
  context.fillAskEffort();
  assert.equal(fields.askEffort.disabled, false);
  assert.equal(fields.askEffort.value, 'high');
  assert.match(fields.askEffort.innerHTML, /沿用会话/);
  assert.match(fields.askEffort.innerHTML, /high/);
  assert.match(fields.askEffortHint.textContent, /接口声明，参数生效未验证/);
  dock.reasoning = { status: 'unknown', supported: false, options: [] };
  context.fillAskEffort();
  assert.equal(fields.askEffort.disabled, true);
  assert.equal(fields.askEffort.value, '');
  assert.match(fields.askEffortHint.textContent, /能力未知/);
});

test('declared protocol is bound to the selected model and capability is queried before selecting', async () => {
  const calls = [];
  const { context, fields } = fixture({ api: async (name, args) => { calls.push({ name, args }); return { status: 'supported', supported: true, evidenceStatus: 'declared', options: [{ value: 'off', label: '关闭' }, { value: 'high', label: '高' }] }; } });
  fields.dReasoningProtocol.value = 'glm';
  assert.equal(await context.refreshDockReasoning('high'), true);
  assert.equal(calls[0].name, 'dock_reasoning');
  assert.equal(calls[0].args.reasoning.protocol, 'glm');
  assert.deepEqual(Array.from(calls[0].args.reasoning.models), ['glm-5.3']);
  assert.equal(fields.dEffort.value, 'high');
  assert.match(fields.dEffortHint.textContent, /参数生效未验证/);
  fields.dReasoningProtocol.value = '';
  assert.equal(context.dockReasoningConfig(), null);
});

test('a slow previous endpoint query cannot overwrite the current model capability', async () => {
  const pending = [];
  const { context, fields } = fixture({ api: (name, args) => new Promise(resolve => pending.push({ args, resolve })) });
  const oldRequest = context.refreshDockReasoning('high');
  fields.dModel.value = 'another-model';
  const newRequest = context.refreshDockReasoning();
  pending[1].resolve({ status: 'unsupported', supported: false, options: [] });
  assert.equal(await newRequest, true);
  pending[0].resolve({ status: 'supported', supported: true, options: [{ value: 'high', label: '高' }] });
  assert.equal(await oldRequest, false);
  assert.equal(fields.dEffort.disabled, true);
  assert.match(fields.dEffort.innerHTML, /不提供推理强度选择/);
});

test('API failure shows human language, preserves diagnostic evidence and never invents capability support', async () => {
  const { context, fields } = fixture({ api: async () => { throw new Error('HTTP 400: unsupported reasoning_effort'); } });
  assert.equal(await context.refreshDockReasoning('high'), false);
  assert.equal(fields.dEffort.disabled, true);
  assert.equal(fields.dEffort.value, '');
  assert.match(fields.dEffortHint.textContent, /模型能力暂时无法查询/);
  assert.doesNotMatch(fields.dEffortHint.textContent, /HTTP 400|reasoning_effort/);
  assert.match(fields.dEffortHint.textContent, /能力未知/);
  assert.equal(vm.runInContext('dockReasoning.error', context), 'HTTP 400: unsupported reasoning_effort');
});

test('saving after a failed capability query preserves the previous high default and does not call dock_save', async () => {
  const calls = [], stored = { defaultEffort: 'high' };
  const { context, fields } = fixture({ api: async (name, args) => {
    calls.push({ name, args });
    if (name === 'dock_reasoning') throw new Error('HTTP 503: reasoning capability unavailable');
    if (name === 'dock_save') stored.defaultEffort = args.defaultEffort;
    return {};
  } });
  vm.runInContext("editing = { id: 'dock:glm', defaultEffort: 'high' };", context);
  assert.equal(await context.refreshDockReasoning('high'), false);
  assert.equal(fields.dEffort.value, '');
  vm.runInContext(between("$('dSave').onclick =", "$('dRemove').onclick ="), context);
  await fields.dSave.onclick();
  assert.equal(stored.defaultEffort, 'high');
  assert.equal(calls.filter(call => call.name === 'dock_save').length, 0);
  assert.match(fields.dResult.innerHTML, /推理能力暂时无法查询/);
  assert.match(fields.dResult.innerHTML, /本次没有保存新设置，既有配置保留/);
  assert.match(fields.dResult.innerHTML, /费用/);
  assert.match(fields.dResult.innerHTML, /检查设置/);
  assert.doesNotMatch(fields.dResult.innerHTML, /HTTP 503|reasoning capability unavailable/);
  assert.equal(vm.runInContext('dockReasoning.error', context), 'HTTP 503: reasoning capability unavailable');
  assert.equal(fields.dSave.disabled, false);
});

test('local issue hides raw connection failures in optional detailed diagnostics', () => {
  const { context, fields } = fixture();
  context.localIssue('dResult', { title:'连接测试没有完成', message:'请检查连接设置后再试。' }, [{ id:'check', label:'检查设置', run:() => {} }], 'HTTP 503: upstream unavailable');
  const output = fields.dResult.innerHTML;
  assert.match(output, /连接测试没有完成/);
  assert.match(output, /文件：/);
  assert.match(output, /费用：/);
  assert.match(output, /检查设置/);
  const diagnosticAt = output.indexOf('<details>');
  assert.ok(diagnosticAt >= 0);
  assert.doesNotMatch(output.slice(0, diagnosticAt), /HTTP 503|upstream unavailable/);
  assert.match(output.slice(diagnosticAt), /详细诊断[\s\S]*HTTP 503: upstream unavailable/);
});

test('background metadata failures never announce a task failure or open the global dialog', async () => {
  const {context,fields}=fixture();
  let dialogs=0;
  vm.runInContext(between('const metadataApiCalls =', 'function issueBody('),context);
  vm.runInContext(between('async function api(name', 'function customerIssuePanel('),context);
  context.apiRaw=async()=>({ok:false,error:'workspace routing discovery timed out',customerIssue:{title:'任务没有完成',message:'Codex 暂时没有响应。',actions:[{id:'dismiss',label:'关闭'}]}});
  context.customerDialog=async()=>{dialogs++;return 'dismiss';};
  for(const name of ['model_list','dock_reasoning','settings_get','dock_list']){
    await assert.rejects(context.api(name),error=>{
      assert.equal(error.customerIssue.title,'功能信息暂时无法查询');
      assert.match(error.message,/没有启动用户任务/);
      return true;
    });
  }
  assert.equal(dialogs,0);
  context.MODELS.codex={error:'query failed'};fields.askTo.value='codex';
  context.fillAskEffort();assert.match(fields.askEffortHint.textContent,/模型能力未知/);
  assert.match(fields.askEffortHint.textContent,/不会启动任务/);
});

test('user task errors and permissions still open the global actionable dialog', async()=>{
  const {context}=fixture();let dialogs=0;
  vm.runInContext(between('const metadataApiCalls =', 'function issueBody('),context);
  vm.runInContext(between('async function api(name', 'function customerIssuePanel('),context);
  context.apiRaw=async()=>({ok:false,error:'PATH_NOT_FOUND'});
  context.customerDialog=async issue=>{dialogs++;assert.equal(issue.title,'任务没有完成');return 'dismiss';};
  await assert.rejects(context.api('beat_ask'),/BEAT 暂时无法完成/);
  assert.equal(dialogs,1);
  context.apiRaw=async name=>name==='workspace_access_grant'?{ok:true,result:{cancelled:true}}:{ok:false,customerIssue:{permission:{requestId:'permission-original',path:'E:\\beat',access:'read-only'}}};
  context.customerDialog=async(issue,choices)=>{dialogs++;assert.match(issue.title,/允许 BEAT/);assert.equal(choices[0].label,'仅允许本次读取');return 'cancel';};
  await assert.rejects(context.api('beat_ask'),/已取消文件夹授权/);
  assert.equal(dialogs,2);
});

test('parallel task detail never requests history for a missing session or absent real stream node', async()=>{
  const {context}=fixture();let calls=0;
  context.api=async()=>{calls++;return {runs:[]};};
  context.document={getElementById:()=>null};
  vm.runInContext(between('async function renderSessionStream(', "$('runs').onclick"),context);
  await context.renderSessionStream(null,'R211');
  await context.renderSessionStream('S-real','R211');
  assert.equal(calls,0);
  context.document.getElementById=()=>({innerHTML:'',querySelectorAll:()=>[]});
  await context.renderSessionStream(null,'R211');assert.equal(calls,0);
  await context.renderSessionStream('S-real','R211');assert.equal(calls,1);
});

test('save transmits explicit default and declaration without silently removing a supported selection', () => {
  const saveHandler = between("$('dSave').onclick =", "$('dRemove').onclick =");
  assert.match(saveHandler, /defaultEffort, reasoning: dockReasoningConfig\(\)/);
  assert.match(saveHandler, /dockReasoningOptions\(dockReasoning\)/);
  assert.match(saveHandler, /!dockReasoning \|\| dockReasoningKey !== currentDockReasoningKey\(\)/);
  assert.match(inlineScript, /nameOf\(t.owner\)/);
  assert.match(inlineScript, /nameOf\(f.owner\)/);
});
