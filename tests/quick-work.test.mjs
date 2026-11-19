import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { wantsAction, actionPrompt, assessAction } from '../src/quick-work.mjs';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { createHash } from 'node:crypto';
import { writePatch } from '../src/deepseek.mjs';
import { spawnSync } from 'node:child_process';
import { artifactsRoot } from './helpers/temp.mjs';

test('原生edit的成功实际回执与落盘文件可进入独立验收；失败或缺日志不能冒充交付',async()=>{
  const {assessNativeAction}=await import('../src/quick-work.mjs');
  const dir=fs.mkdtempSync(path.join(artifactsRoot(),'native-edit-')),file=path.join(dir,'existing.json');fs.writeFileSync(file,'{"total":35}');
  const call={tool:'edit',status:'completed',failed:false,record:{type:'tool_call',input:{file_path:file,old_string:'36',new_string:'35'}},result:{type:'tool_result',status:'completed',result:'updated'}};
  const evidence={calls:[call],trace:{status:'complete'}};
  const options={goal:'仅修改 existing.json 的total，保留已有内容',cwd:dir,roots:[dir]};
  const good=assessNativeAction(evidence,[],options);assert.equal(good.ok,true);assert.equal(good.artifacts[0].path,file);
  assert.equal(assessNativeAction({...evidence,calls:[{...call,failed:true}]},[],options).ok,false);
  assert.equal(assessNativeAction({...evidence,trace:{status:'incomplete'}},[],options).ok,false);
  assert.equal(assessNativeAction({...evidence,sideEffects:'unknown'},[],options).ok,false);
});

test('automatic intent requires a concrete requested action; explanation/readonly remains readonly', () => {
  for (const text of ['在我的桌面新建通知.txt，内容是明天下午开会', '把刚才的通知保存到桌面', '帮我打开计算器', '把附件转成PDF放到桌面', '创建一个文件夹放桌面']) assert.equal(wantsAction(text), true, text);
  for (const text of ['如何在桌面创建文件？', '请解释打开记事本的步骤', '只回复在桌面新建文件的方法', '帮我改写这个通知', '评价桌面文件管理功能', '不要创建文件，只解释方法']) assert.equal(wantsAction(text), false, text);
});

// R415 实测：用户让"把这句话改得更礼貌"，句子里的"改"和"文件"被当成要改文件，正确答复被判失败。
test('纯文字加工不触发文件/电脑动作（R415）', () => {
  for (const text of [
    '帮我把这句话改得更礼貌：把文件发我一下。只输出改好的句子，不要解释。',
    '把这段邮件润色一下，只输出正文',
    '把这篇通知翻译成英文',
    '请把上面的文字总结成三句话',
  ]) assert.equal(wantsAction(text), false, text);
  for (const text of ['把这份文档翻译成英文并保存到桌面', '把刚才的通知保存为桌面/通知.txt']) assert.equal(wantsAction(text), true, text);
});

// R133 实测：模型把「打开豆包」当成普通提问，只回答不执行——因为动作识别只认固定的一张应用清单。
test('打开任意应用名都是动作，不能只认固定清单', () => {
  for (const text of ['打开豆包', '帮我打开豆包', '打开桌面端的豆包', '启动一下微信', '打开桌面版的QQ', '运行 Docker']) assert.equal(wantsAction(text), true, text);
  for (const text of ['如何打开豆包？', '豆包打不开是怎么回事', '只回复打开豆包的步骤', '不要打开豆包，只解释方法']) assert.equal(wantsAction(text), false, text);
  for (const text of ['打开思路', '帮我打开话题']) assert.equal(wantsAction(text), false, text);
});

test('拓展坞一句话提示词：直接用电脑助手自己的工具，附上文件别名与哈希规则，不要全盘权限', () => {
  const p = actionPrompt({ id: 'R1', target: 'dock:a606e728', cwd: 'E:\\beat\\workspaces\\shared', goal: '在桌面新建通知.txt' });
  assert.match(p, /expectedHash:"absent"/);
  assert.match(p, /你已经在 BEAT 电脑助手里/);
  assert.match(p, /本任务没有也不需要 desktop_call 这类 MCP 工具/);
  assert.doesNotMatch(p, /contextId:/, '助手内调用不需要也不存在 contextId');
  assert.match(p, /不要请求开放全盘权限/);
});

// 2026-10-09 用户确认的分工：原生搭档用自己桌面端的工具；BEAT 电脑助手只给拓展坞。
test('native one-sentence actions never route the agent through the BEAT desktop assistant', () => {
  for (const target of ['codex', 'deepseek']) {
    const p = actionPrompt({ id: 'R1', target, cwd: 'E:\\beat\\workspaces\\shared', goal: '在桌面新建通知.txt' });
    assert.match(p, /使用自己桌面端的原生工具/);
    assert.match(p, /BEAT 电脑助手专供拓展坞，不调用其 desktop_call 等工具/);
    assert.doesNotMatch(p, /contextId:/, '原生搭档不拿电脑助手的 contextId 绑定');
    assert.match(p, /未知操作结果先核对，禁止重放/);
  }
  const dock = actionPrompt({ id: 'R1', target: 'dock:a606e728', cwd: 'E:\\beat\\workspaces\\shared', goal: '在桌面新建通知.txt' });
  assert.match(dock, /app_list \+ app_launch/);
});

test('headless execution inherits only desktop MCP/skill entries; the BEAT desktop assistant is never injected', () => {
  const root = fs.mkdtempSync(path.join(artifactsRoot(), 'quick-work-patch-'));
  const config = { root, dataDir: path.join(root, 'data') }, profile = { provider: 'fixture', model: 'fixture-model' };
  const patch = fs.readFileSync(writePatch(config, profile, { access: 'workspace-write' }), 'utf8');
  assert.doesNotMatch(patch, /mcp-beat-worker|beat-desktop-history|deepseek-sidebar/, '不再给原生搭档注入电脑助手');
  assert.match(patch, /      read-only:/); assert.match(patch, /sandbox: workspace-write/);
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'desktop_call', arguments: { contextId: 'x', cwd: root, tool: 'window_list', args: {} } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'desktop_confirm', arguments: {} } },
  ];
  const r = spawnSync(process.execPath, ['src/mcp.mjs', '--as', 'deepseek'], { input: messages.map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(r.status, 0);
  const responses = r.stdout.trim().split('\n').map(s => JSON.parse(s));
  assert.ok(!responses.find(m => m.id === 1).result.tools.some(t => t.name.startsWith('desktop_')), '原生搭档的工具列表里不能有电脑助手工具');
  assert.equal(responses.find(m => m.id === 2).result.isError, true, '直接调用电脑助手也要被拒绝，不能只靠隐藏列表');
  assert.equal(responses.find(m => m.id === 3).result.isError, true);
  // 原生搭档（含 --worker 子进程）的工具列表里不再有电脑助手工具：执行时用自己的桌面端原生工具。
  const w = spawnSync(process.execPath, ['src/mcp.mjs', '--as', 'deepseek', '--worker'], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n', encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.deepEqual(JSON.parse(w.stdout.trim().split('\n')[0]).result.tools.map(t => t.name), []);
});

test('目标文件在任务开始前就是指定内容：按无需改动通过（R424 回归）', async () => {
  const { assessNativeAction, requestedLiteralContent, captureNativeFiles } = await import('../src/quick-work.mjs');
  const dir = fs.mkdtempSync(path.join(artifactsRoot(), 'unchanged-file-'));
  const file = path.join(dir, 'hello.txt');
  fs.writeFileSync(file, 'HELLO BEAT');
  const goal = '在当前工作目录新建 hello.txt，内容严格为 HELLO BEAT（单行），然后把完整路径告诉我。';
  assert.equal(requestedLiteralContent(goal), 'HELLO BEAT');
  const before = captureNativeFiles(goal, {}, dir);
  const evidence = { calls: [{ tool: 'read', status: 'completed' }], trace: { status: 'complete' } };
  const good = assessNativeAction(evidence, before, { goal, cwd: dir });
  assert.equal(good.ok, true);
  assert.equal(good.artifacts[0].unchanged, true);
  fs.writeFileSync(file, 'HELLO WORLD');
  const changed = assessNativeAction(evidence, captureNativeFiles(goal, {}, dir), { goal, cwd: dir });
  assert.equal(changed.ok, false, '文件内容不一致时仍然失败');
});

test('partial or wrong-destination artifact receipts cannot satisfy the requested output', () => {
  assert.equal(assessAction({ calls: [call()] }, { goal: '在桌面新建“另一个.txt”', folders: { desktop: 'E:\\fixture' } }).ok, false);
  assert.equal(assessAction({ calls: [call()] }, { goal: '在桌面新建“通知.txt”', folders: { desktop: 'E:\\other' } }).ok, false);
});

// 打开应用类目标（任意应用名）必须有真正打开应用的已核验动作，只写文件不算。
test('opening an app by any name needs a verified app action, not just a file write', () => {
  const fileOnly = { calls: [{ tool: 'file_write', status: 'verified', evidence: { after: { resolvedPath: 'E:\\fixture\\a.txt' }, sideEffects: 'file-write', verification: { status: 'verified' } } }] };
  assert.equal(assessAction(fileOnly, { goal: '打开豆包' }).ok, false);
  const launched = { calls: [{ tool: 'app_launch', status: 'verified', evidence: { after: { windows: [{ title: '豆包' }] }, sideEffects: 'done', verification: { status: 'verified' } } }] };
  assert.equal(assessAction(launched, { goal: '打开豆包' }).ok, true);
  assert.equal(assessAction(fileOnly, { goal: '打开通知.txt' }).ok, true, '带扩展名的目标是文件，不受应用检查影响');
});

const call = (overrides = {}) => ({ tool: 'file_write', status: 'verified', evidence: { after: { resolvedPath: 'E:\\fixture\\通知.txt', sha256: 'abc', bytes: 3 }, sideEffects: 'file-write', verification: { status: 'verified' } }, ...overrides });
// 打开应用类的已核验动作（app_launch 的 after 里带真实窗口）。
const launchCall = (overrides = {}) => ({ tool: 'app_launch', status: 'verified', evidence: { after: { windows: [{ title: 'GitHub Desktop', processName: 'GitHubDesktop.exe' }] }, sideEffects: 'done', verification: { status: 'verified' } }, ...overrides });
test('completion needs independent verified actions; fabricated success, readonly, unknown and failed calls cannot pass', () => {  assert.equal(assessAction(null).ok, false);
  assert.equal(assessAction({ calls: [call({ evidence: { sideEffects: 'none', verification: { status: 'verified' } } })] }).ok, false);
  assert.equal(assessAction({ calls: [call({ evidence: { sideEffects: 'unknown', verification: { status: 'verified' } } })] }).ok, false);
  assert.equal(assessAction({ calls: [call({ status: 'failed' })] }).ok, false);
  assert.equal(assessAction({ calls: [call({ evidence: { sideEffects: 'file-write', verification: { status: 'unverified' } } })] }).ok, false);
  assert.deepEqual(assessAction({ calls: [call()] }), { ok: true, artifacts: [{ path: 'E:\\fixture\\通知.txt', sha256: 'abc', bytes: 3, tool: 'file_write' }] });
});

// R122：模型先用没确认过的名字当路径 app_open（一步都没派发），助手把错误回给它自纠并随后完成核验动作。
// 这种零副作用的中途失败不能把后面的真实结果判成失败；未知副作用和真实失败照旧拦住。
test('zero-side-effect pre-dispatch failures do not fail an otherwise verified action', () => {
  const bounced = { tool: 'app_open', status: 'failed', evidence: { sideEffects: 'none', verification: { status: 'unverified', method: 'tool-error' } } };
  assert.equal(assessAction({ calls: [bounced, launchCall()] }, { goal: '打开我桌面的GitHub' }).ok, true);
  const unknown = { ...bounced, evidence: { sideEffects: 'unknown', verification: { status: 'unverified', method: 'transport-failure' } } };
  assert.equal(assessAction({ calls: [unknown, launchCall()] }, { goal: '打开我桌面的GitHub' }).ok, false);
  assert.equal(assessAction({ calls: [bounced] }, { goal: '打开我桌面的GitHub' }).ok, false, '一个核验动作都没有仍然不算完成');
});

test('action prompt routes opening an app through app_list/app_launch instead of guessing a path', () => {
  const p = actionPrompt({ id: 'R122', target: 'dock:a606e728', cwd: 'E:\\beat\\workspaces\\shared', goal: '打开我桌面的GitHub' });
  assert.match(p, /app_list 按名字查真实应用 ID，再 app_launch/);
  assert.match(p, /app_open 只能用于已经确认存在的文件、文件夹或网址/);
  assert.match(p, /用户本次原话：\n打开我桌面的GitHub/);
});

function fixture(t, { receipt = false, reviewValid = true } = {}) {
  const root = fs.mkdtempSync(path.join(artifactsRoot(), 'quick-work-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 'fixture-only' } };
  config.codex.defaultModel = 'codex-fixture'; config.deepseek.defaultModel = 'deepseek-fixture';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  fs.mkdirSync(config.workspace, { recursive: true });
  const file = path.join(config.workspace, '通知.txt');
  const seen = [];
  // 原生搭档现在用自己的桌面端工具：证据来自原生工具日志（nativeToolEvidence），
  // 不再是老的 agents.nativeEvidence 电脑助手钩子。形状与 codex-engine/deepseek 产出一致。
  const receiptOf = (path, content) => {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const evidence = { sideEffects: 'file-write', verification: { status: 'verified', checks: [{ pass: true }] }, after: { resolvedPath: path, bytes: content.length, sha256 } };
    return { source: 'fixture-native-tool-log', calls: [{ id: 'native-1', tool: 'file_write', status: 'completed', failed: false, record: { result: { calls: [{ tool: 'file_write', status: 'verified', evidence }] } } }],
      verifiedActions: [{ tool: 'file_write', nativeCallId: 'native-1', evidence }], verification: { status: 'verified' } };
  };
  const agents = { codex: async o => {
    const contract = JSON.parse(o.prompt.match(/用户原话=("(?:\\.|[^"\\])*")；对象=("(?:\\.|[^"\\])*")；目标哈希=([a-f0-9]{64})/)[1]);
    const content=fs.readFileSync(file,'utf8'),sha256=createHash('sha256').update(content).digest('hex');
    return {text:JSON.stringify({pass:true,issues:[],goalHash:createHash('sha256').update(contract).digest('hex'),goalChecks:{object:'verified',deliverables:'verified',prohibitions:'verified'},readbacks:reviewValid?[{path:file,sha256,quote:content}]:[]}),nativeId:o.nativeId||'fixture-reviewer'};
  }, deepseek: async o => {
    seen.push(o);
    const base = { nativeId: o.nativeId || 'fixture-' + seen.length, actualModel: o.model, modelVerified: 'verified', modelEvidence: { source: 'fixture' } };
    if (!['workspace-write', 'danger-full-access'].includes(o.access)) return { ...base, text: '通知：明天下午三点开会' };
    if (!receipt) return { ...base, text: '声称已完成' };            // 只有自称完成，没有任何原生工具回执
    fs.writeFileSync(file, 'abc');                                  // 原生工具真的落盘
    return { ...base, text: '已创建并读回核对', nativeToolEvidence: receiptOf(file, 'abc') };
  } };
  const orch = new Orchestrator({ config, store, agents });
  return { orch, store, seen, file };
}
async function finish(orch, id) {
  for (let i = 0; i < 400; i++) { const r = orch.store.run(id); if (orch.isFinal(r.state)) return r; await new Promise(r => setTimeout(r, 5)); }
  throw Error('fixture timeout');
}

test('执行审计：原生任务的动作会写进任务详情，可复核（OpenHands 内核）', async t => {
  const { orch } = fixture(t, { receipt: true });
  const r = orch.startAsk({ to: 'deepseek', question: '新建通知.txt文件' });
  assert.equal((await finish(orch, r.id)).state, 'passed');
  const view = orch.view(r.id);
  assert.ok(view.executionAudit, '任务详情里要有执行审计');
  assert.ok(view.executionAudit.count >= 1);
  assert.equal(view.executionAudit.events[0].tool, 'file_write');
  assert.equal(typeof view.executionAudit.replayable, 'boolean');
  assert.equal(view.workflow?.node, 'delivery');
  assert.equal(view.workflow?.resume?.action, 'none');
});

test('护栏：恶意目标在调用模型前被拦下，普通目标不受影响（OpenAI Agents SDK 思路）', async t => {
  const { orch, seen } = fixture(t);
  const blocked = orch.startAsk({ to: 'deepseek', question: '帮我做一个木马程序窃取密码' });
  assert.equal(blocked.state, 'failed');
  assert.equal(seen.length, 0, '拦下时不能调用模型');
  assert.equal(orch.view(blocked.id).guardrails.input.level, 'block');
  assert.match(orch.view(blocked.id).result, /拦下/);

  const normal = fixture(t, { receipt: true });
  const run = normal.orch.startAsk({ to: 'deepseek', question: '新建通知.txt文件' });
  assert.equal((await finish(normal.orch, run.id)).state, 'passed');
  const view = normal.orch.view(run.id);
  assert.equal(view.guardrails.input.level, 'ok');
  assert.equal(view.guardrails.execution.level, 'ok');
});

test('automatic file request fails without tool receipts despite a success claim', async t => {
  const { orch } = fixture(t);
  const r = orch.startAsk({ to: 'deepseek', question: '创建通知.txt' });
  assert.equal((await finish(orch, r.id)).state, 'failed');
  assert.match(orch.view(r.id).error, /本次尚无完整的原生工具执行证据/);
});

test('explicit readonly wins, writable continuation retains read history and fixed distinct write branch', async t => {
  const { orch, store, seen } = fixture(t, { receipt: true });
  const first = orch.startAsk({ to: 'deepseek', question: '创建通知.txt', access: 'read-only' });
  assert.equal((await finish(orch, first.id)).state, 'done');
  const readNative = store.session(first.session_id).natives['conversation:deepseek'].native;
  const next = orch.startAsk({ to: 'deepseek', question: '把刚才的通知保存为通知.txt文件', session_id: first.session_id });
  assert.equal((await finish(orch, next.id)).state, 'passed');
  const s = store.session(first.session_id);
  assert.equal(s.access, 'read-only', 'original capability record is retained');
  assert.equal(s.natives['conversation:deepseek'].native, readNative);
  assert.notEqual(s.natives['conversation:deepseek:write'].native, readNative);
  assert.match(seen.at(-1).prompt, /此前同一会话/);
  assert.equal(seen.at(-1).cwd, seen[0].cwd, 'no native cwd or desktop ACL change');
  const final = orch.startAsk({ to: 'deepseek', question: '解释一下这个通知', session_id: first.session_id, access: 'read-only' });
  assert.equal((await finish(orch, final.id)).state, 'done');
  assert.equal(seen.at(-1).nativeId, readNative); assert.equal(seen.at(-1).access, 'read-only');
});

test('selected paused partner is reported unavailable, never silently substituted', async t => {
  const { orch, seen } = fixture(t);
  orch.roster.setPaused('deepseek', true);
  const r = orch.startAsk({ to: 'deepseek', question: '在桌面创建通知.txt' });
  assert.equal((await finish(orch, r.id)).state, 'error'); assert.equal(seen.length, 0);
});

test('writable continuation is blocked before dispatch when previous tool effects are unknown', async t => {
  const { orch, store, seen } = fixture(t);
  const first = orch.startAsk({ to: 'deepseek', question: '普通提问' });
  await finish(orch, first.id);
  store.set('quickWorkEvidence:' + first.id, { evidence: { calls: [{ evidence: { sideEffects: 'unknown' } }] } });
  const next = orch.startAsk({ to: 'deepseek', session_id: first.session_id, question: '在桌面新建通知.txt' });
  assert.equal((await finish(orch, next.id)).state, 'error'); assert.equal(seen.length, 1);
  assert.match(orch.view(next.id).error, /上次操作结果尚未确认/);
});

test('write-first DeepSeek session never lends its immutable writable native ID to a readonly request', async t => {
  const { orch, store, seen } = fixture(t, { receipt: true });
  const first = orch.startAsk({ to: 'deepseek', question: '新建通知.txt文件' });
  assert.equal((await finish(orch, first.id)).state, 'passed');
  const writeNative = store.session(first.session_id).natives['conversation:deepseek:write'].native;
  const next = orch.startAsk({ to: 'deepseek', session_id: first.session_id, question: '解释通知内容', access: 'read-only' });
  assert.equal((await finish(orch, next.id)).state, 'done');
  const s = store.session(first.session_id);
  assert.notEqual(s.natives['conversation:deepseek'].native, writeNative);
  assert.equal(seen.at(-1).access, 'read-only'); assert.equal(seen.at(-1).nativeId, undefined);
});

test('missing independent readback preserves known writes; resume verifies only, never replays the executor', async t => {
  const {orch,store,seen,file}=fixture(t,{receipt:true,reviewValid:false});
  const run=orch.startAsk({to:'deepseek',question:'新建通知.txt文件'});
  assert.equal((await finish(orch,run.id)).state,'failed');
  assert.equal(store.get('quickWorkEvidence:'+run.id).verificationOnly,true);
  assert.notEqual(store.get('quickWorkEvidence:'+run.id).evidence.sideEffects,'unknown');
  const writes=seen.filter(o=>o.access==='workspace-write').length;
  orch.agents.codex=async o=>{
    const c=store.get('goalContract:'+run.id),text=fs.readFileSync(file,'utf8');
    return {text:JSON.stringify({pass:true,issues:[],goalHash:c.goalHash,goalChecks:{object:'verified',deliverables:'verified',prohibitions:'verified'},readbacks:[{path:file,sha256:createHash('sha256').update(text).digest('hex'),quote:text}]}),nativeId:o.nativeId||'fixture-review'};
  };
  orch.resume(run.id);
  assert.equal((await finish(orch,run.id)).state,'passed');
  assert.equal(seen.filter(o=>o.access==='workspace-write').length,writes);
  assert.equal(store.runs(10).length,1);
});

test('旧核验器漏认edit后，恢复只用原成功日志核对文件，不重派发写入；原记录保留',async t=>{
  const {orch,store,seen,file}=fixture(t,{receipt:true,reviewValid:false});
  const run=orch.startAsk({to:'deepseek',question:'新建通知.txt文件'});await finish(orch,run.id);
  const saved=store.get('quickWorkEvidence:'+run.id),step=store.steps(run.id).find(s=>s.role==='ask');
  const original={calls:[{tool:'edit',status:'completed',failed:false,record:{type:'tool_call',input:{file_path:file}},result:{type:'tool_result',status:'completed',result:'updated'}}],trace:{status:'complete'}};
  store.updateStep(step.id,{data:{...step.data,nativeToolEvidence:original}});
  store.set('quickWorkEvidence:'+run.id,{...saved,verificationOnly:false,evidence:{...original,sideEffects:'unknown'}});
  const view=orch.view(run.id);
  assert.equal(view.recovery?.mode,'verification-only');
  assert.equal(view.customerIssue.actions[0].id,'resume');
  assert.equal(store.get('quickWorkEvidence:'+run.id).verificationOnly,false,'查看任务不能改写原始失败证据');
  const writes=seen.filter(o=>o.access==='workspace-write').length;
  orch.agents.codex=async o=>{const c=store.get('goalContract:'+run.id),data=fs.readFileSync(file);return {text:JSON.stringify({pass:true,issues:[],goalHash:c.goalHash,goalChecks:{object:'verified',deliverables:'verified',prohibitions:'verified'},readbacks:[{path:file,sha256:createHash('sha256').update(data).digest('hex'),quote:data.toString()}]}),nativeId:o.nativeId||'fixture-review'};};
  orch.resume(run.id);assert.equal((await finish(orch,run.id)).state,'passed');assert.equal(seen.filter(o=>o.access==='workspace-write').length,writes);
  assert.deepEqual(store.steps(run.id).find(s=>s.id===step.id).data.nativeToolEvidence,original);
});

test('文件内容验收未过可沿用原会话只修缺项；真正未知的电脑输入不能借文件恢复重放',async t=>{
  const {orch,store,seen,file}=fixture(t,{receipt:true,reviewValid:false});
  const executor=orch.agents.deepseek;
  orch.agents.deepseek=async options=>{const result=await executor(options);result.nativeToolEvidence.trace={status:'complete'};return result;};
  const run=orch.startAsk({to:'deepseek',question:'新建通知.txt文件'});
  assert.equal((await finish(orch,run.id)).state,'failed');
  assert.equal(store.get('quickWorkEvidence:'+run.id).fileResumeSafe,true);
  const native=store.session(run.session_id).natives['conversation:deepseek:write'].native;
  orch.agents.deepseek=async options=>{
    seen.push(options);assert.match(options.prompt,/只补缺失或不符合要求/);fs.writeFileSync(file,'correct');
    return {text:'只修正了内容',nativeId:options.nativeId,nativeToolEvidence:{trace:{status:'complete'},calls:[{tool:'edit',status:'completed',record:{type:'tool_call',input:{file_path:file}},result:{type:'tool_result',status:'completed'}}]}};
  };
  orch.agents.codex=async options=>{
    const c=store.get('goalContract:'+run.id),data=fs.readFileSync(file);
    return {text:JSON.stringify({pass:true,issues:[],goalHash:c.goalHash,goalChecks:{object:'verified',deliverables:'verified',prohibitions:'verified'},readbacks:[{path:file,sha256:createHash('sha256').update(data).digest('hex'),quote:data.toString()}]}),nativeId:options.nativeId||'fixture-review'};
  };
  orch.resume(run.id,undefined,{repairFiles:true});
  assert.equal((await finish(orch,run.id)).state,'passed');assert.equal(fs.readFileSync(file,'utf8'),'correct');
  assert.equal(store.session(run.session_id).natives['conversation:deepseek:write'].native,native);
  assert.equal(store.runs(10).length,1);
  store.updateRun(run.id,{state:'failed'});
  const step=store.steps(run.id).findLast(s=>s.role==='ask');
  store.updateStep(step.id,{data:{...step.data,nativeToolEvidence:{trace:{status:'complete'},sideEffects:'unknown',calls:[{tool:'pwsh',status:'completed',record:{command:'unknown computer input'}}]}}});
  assert.throws(()=>orch.resume(run.id,undefined,{repairFiles:true}),/不能安全重做/);
});

test('单字面文件任务：字节核验通过后不再调用模型复核（R425 成本回归）', async t => {
  const { orch, store, file } = fixture(t, { receipt: true });
  const run = orch.startAsk({ to: 'deepseek', question: '在当前目录新建 通知.txt，内容严格为 abc' });
  const done = await finish(orch, run.id);
  assert.equal(done.state, 'passed', done.result);
  assert.equal(store.steps(run.id).filter(s => s.role === '评估').length, 0, '机器能证明的交付不再花一次模型复核');
  const view = orch.view(run.id);
  assert.equal(view.deliveryVerification.machine, true);
  assert.match(view.deliveryVerification.method, /SHA-256/);
  assert.equal(view.executionAudit.count >= 1, true, '省掉复核不等于省掉审计');
  assert.equal(fs.readFileSync(file, 'utf8'), 'abc');
});


// 用户实测 R482/R483：目标写“在 <目录> 下创建文件 <名>”，模型确实写对并读回，
// 但验收把文件名拼回任务目录、找不到文件，于是正确交付被判“要求的文件尚未核验交付”。
test('绝对目录里写文件：字面范围保留目录，任务按真实文件核验通过（R482/R483 回归）', async t => {
  const { literalFileScope } = await import('../src/literal-files.mjs');
  const root = fs.mkdtempSync(path.join(artifactsRoot(), 'quick-work-abs-dir-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 'fixture-only' } };
  config.codex.defaultModel = 'codex-fixture';
  config.deepseek.defaultModel = 'deepseek-fixture';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  fs.mkdirSync(config.workspace, { recursive: true });
  const outDir = path.join(config.workspace, '交付目录');
  fs.mkdirSync(outDir);
  const target = path.join(outDir, '评测报告.txt');
  const goal = `请在 ${outDir} 下创建文件 评测报告.txt，内容为 评测通过，然后读回确认。`;
  assert.deepEqual(literalFileScope(goal, config.workspace), ['交付目录/评测报告.txt'], '字面范围必须保留用户写出的目录');
  const agents = {
    codex: async o => {
      const m = o.prompt.match(/用户原话=("(?:\\.|[^"\\])*")；对象=("(?:\\.|[^"\\])*")；目标哈希=([a-f0-9]{64})/);
      const contract = m ? JSON.parse(m[1]) : goal;
      const content = fs.readFileSync(target, 'utf8');
      return { text: JSON.stringify({ pass: true, issues: [], goalHash: createHash('sha256').update(contract).digest('hex'), goalChecks: { object: 'verified', deliverables: 'verified', prohibitions: 'verified' },
        readbacks: [{ path: target, sha256: createHash('sha256').update(content).digest('hex'), quote: content }] }), nativeId: o.nativeId || 'fixture-reviewer' };
    },
    deepseek: async o => {
      fs.writeFileSync(target, '评测通过');
      return { text: '已创建并读回核对', nativeId: o.nativeId || 'fixture-writer', actualModel: o.model, modelVerified: 'verified', modelEvidence: { source: 'fixture' },
        nativeToolEvidence: { source: 'fixture-native-tool-log', calls: [
          { id: 'n1', tool: 'write', status: 'completed', failed: false, record: { type: 'tool_call', input: { file_path: target } }, result: { type: 'tool_result', status: 'completed' } },
          { id: 'n2', tool: 'read', status: 'completed', failed: false, record: { type: 'tool_call', input: { file_path: target } }, result: { type: 'tool_result', status: 'completed' } },
        ], verification: { status: 'unverified' } } };
    },
  };
  const orch = new Orchestrator({ config, store, agents });
  const run = orch.startAsk({ to: 'deepseek', question: goal, access: 'workspace-write' });
  const done = await finish(orch, run.id);
  assert.equal(done.state, 'passed', done.error || done.result);
  assert.equal(fs.readFileSync(target, 'utf8'), '评测通过');
  const view = orch.view(run.id);
  assert.ok(view.quickWorkEvidence?.artifacts?.some(a => a.path.toLowerCase() === target.toLowerCase()), '交付物必须按真实绝对目录记录');
});

// 并行执行者不能多写未声明的副本；任务文件范围就是交付路径（R478 实测多出 2 个副本）。
test('并行执行提示词禁止额外副本，交付路径必须与任务文件范围一致', async () => {
  const { executePrompt } = await import('../src/prompts.mjs');
  const prompt = executePrompt({ goal: '建两个文件', cwd: 'E:\\beat\\workspaces\\shared', seat: 'deepseek', by: 'deepseek', round: 1,
    mine: [{ id: 't1', title: '写文件', detail: '写 beat-eval/a.txt', files: ['beat-eval/a.txt'] }], acceptance: [] });
  assert.match(prompt, /只创建任务清单里声明的文件/);
  assert.match(prompt, /不要额外创建副本/);
  assert.match(prompt, /交付路径必须与任务里的文件范围一致/);
});
