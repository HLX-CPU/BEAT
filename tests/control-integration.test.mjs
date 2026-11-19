import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { defaults } from '../src/config.mjs';
import { startServer } from '../src/server.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

const roster = ['codex', 'deepseek', 'dock:small-a', 'dock:small-b'];
const choices = { route: 'api', sequence: 'serial-then-parallel', risk: 'checkpoint' };
const outline = () => ({ core: '接口优先并保存检查点', steps: ['拆小任务', '按依赖执行', '逐项验收'], risks: ['中断保留证据'], decisions: Object.entries(choices).map(([id, option]) => ({ id, option, reason: '可测量并能恢复', serious: false, category: 'ordinary' })) });

async function service(t, handler) {
  const parent = artifactsRoot(); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'control-integration-'));
  fs.mkdirSync(path.join(root, 'workspaces', 'shared'), { recursive: true });
  // Identity/transport fixtures only. Flow settings stay exactly at product defaults.
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'local-test-token', dockKeys: { 'dock:small-a': 'test-a', 'dock:small-b': 'test-b' } } };
  config.codex.defaultModel = 'fixture-codex'; config.deepseek.defaultModel = 'fixture-deepseek';
  config.dock = roster.slice(2).map(id => ({ id, name: id, enabled: true, model: 'fixture-dock', baseUrl: 'http://127.0.0.1/fixture' }));
  const calls = [];
  // 只有「真的成功产出过」的搭档才有上文可带（失败重试的那次是无历史的，不能强求）。
  const answered = new Map();
  const respond = async (seat, opts) => {
    // 一问一答（beat_ask）走的是同一套 API 搭档通道：提示词就是问题本身。
    const ask = /本次仅回答问题，不修改文件、不操作电脑。$/.test(opts.prompt);
    const stage = ask ? 'ask' : /阶段=([a-z]+)/.exec(opts.prompt)?.[1] || (opts.prompt.startsWith('执行一个小任务') ? 'queue-execute' : opts.prompt.startsWith('只读核验整体组合结果') ? 'global-review' : opts.prompt.startsWith('只读核验一个小任务') ? 'queue-review' : null);
    assert.ok(stage, 'legacy full-transcript flow must not be called by default');
    if (seat.startsWith('dock:')) {
      // 拓展坞没有原生会话：同一会话里的上文要真的发给它（默认开），但只带自己这条会话的、且有上限。
      // 断言按「会话」而不是按「搭档」记：换一个任务就是另一条会话，必须从零开始（不能把上个任务的上下文带过来）。
      const seenKey = seat + '|' + (opts.conversationId || '');
      assert.ok(opts.history.every(m => ['user', 'assistant'].includes(m.role)), '上文只能是对话消息');
      assert.ok(opts.history.length <= 12, '上文条数要有上限');
      assert.ok(opts.history.reduce((n, m) => n + String(m.content).length, 0) <= 8000, '上文体积要有上限');
      if (!(answered.get(seenKey) > 0)) assert.deepEqual(opts.history, [], '新任务的新会话必须从零开始，不带别的任务的上文');
      else assert.ok(opts.history.length > 0, '同一条会话的后续调用必须带上自己的上文');
      if (opts.history.length && !ask) assert.match(String(opts.history.find(m => m.role === 'user')?.content || ''), new RegExp(seat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '上文必须来自这位搭档自己的会话');
    }
    calls.push({ seat, stage, nativeId: opts.nativeId || null, conversationId: opts.conversationId || null, history: (opts.history || []).map(m => m.content), maxTokens: opts.maxTokens });
    const extra = handler ? await handler({ seat, stage, opts, calls }) : null;
    let value = extra;
    if (!value) {
      if (stage === 'outline') value = outline();
      else if (stage === 'expand') value = { summary: '执行方案：接口优先，分依赖小任务，保存产物引用并逐项验收。', decisions: choices, plan: null };
      else if (stage === 'review') value = { verdict: 'pass', planHash: /hash=([a-f0-9]{64})/.exec(opts.prompt)[1], issues: [] };
      else if (stage === 'ask') value = { 答复: 'fixture 收到：' + opts.prompt.split('\n')[0] };
      else if (stage === 'global-review') value = { pass: true, issues: [] };
      else throw Error('unexpected stage ' + stage);
    }
    if (['queue-review','global-review'].includes(stage) && opts.prompt.includes('最终目标核验：')) {
      const goalHash = /目标哈希=([a-f0-9]{64})/.exec(opts.prompt)[1];
      const readbacks = fs.readdirSync(opts.cwd,{withFileTypes:true}).filter(f=>f.isFile()).map(f=>{
        const file=path.join(opts.cwd,f.name),data=fs.readFileSync(file);
        return {path:file,sha256:createHash('sha256').update(data).digest('hex'),quote:data.toString('utf8').slice(0,40)};
      });
      value={...value,goalHash,goalChecks:{object:'verified',deliverables:'verified',prohibitions:'verified'},readbacks};
    }
    const usage = { input_tokens: 120, output_tokens: 80, total_tokens: 200, source: 'local-fixture' };
    opts.onUsage?.(usage);
    if (!seat.startsWith('dock:') && !opts.nativeId) opts.onNative?.('fixture-native-' + seat);
    answered.set(seat + '|' + (opts.conversationId || ''), (answered.get(seat + '|' + (opts.conversationId || '')) || 0) + 1);
    return { text: stage === 'ask' ? 'fixture 收到：' + opts.prompt.split('\n')[0] : JSON.stringify(value), usage, nativeId: seat.startsWith('dock:') ? undefined : 'fixture-native-' + seat };
  };
  const svc = await startServer({ config, agents: { codex: o => respond('codex', o), deepseek: o => respond('deepseek', o), dock: (id, o) => respond(id, o), claude: async () => { throw Error('advisor is not needed'); } }, port: 0 });
  t.after(async () => { await new Promise(resolve => svc.server.close(resolve)); svc.store.close(); });
  const call = async (name, args = {}) => {
    const response = await fetch('http://127.0.0.1:' + svc.port + '/api/call', { method: 'POST', headers: { authorization: 'Bearer local-test-token', 'content-type': 'application/json' }, body: JSON.stringify({ name, args }) });
    assert.equal(response.status, 200);
    const json = await response.json(); assert.equal(json.ok, true, JSON.stringify(json)); return json.result;
  };
  const finish = async id => {
    for (let n = 0; n < 200; n++) { const result = await call('beat_get', { id }); if (result.finished) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw Error('task did not finish within fixture deadline');
  };
  const evidence = (name, data) => { const file = path.join(root, name + '.json'); fs.writeFileSync(file, JSON.stringify({ evidenceType: 'local-provider-fixture-real-http-store-controller', realProviderValidated: false, root, ...data }, null, 2)); return file; };
  return { svc, config, calls, call, finish, evidence };
}

test('显式拓展坞型号失败时保留错误，不改用原生模型代答', async t => {
  const f=await service(t,async ({seat,stage})=>{
    if(stage==='ask'&&seat==='dock:small-a')throw new Error('fixture output length exhausted without final answer');
    return null;
  });
  const run=await f.call('beat_ask',{to:'dock:small-a',model:'fixture-dock',question:'请给一份纯文字核验建议',access:'read-only',wait_seconds:0});
  const result=await f.finish(run.id);
  assert.notEqual(result.state,'done');
  assert.equal(f.calls.filter(c=>c.stage==='ask').length,1);
  assert.equal(f.calls.find(c=>c.stage==='ask').seat,'dock:small-a');
  assert.equal(result.requested_model,'fixture-dock');
});

test('一个任务一条会话：新任务开新会话（零上文），同一任务/会话里的每条消息都在这条会话里传递', async t => {
  const f = await service(t);
  // 任务 A：新问题（没给会话号）→ 新会话，第一条消息当然没有上文
  const a = await f.call('beat_ask', { to: 'dock:small-a', question: '任务A的问题：一加一等于几？', access: 'read-only' });
  const ran = await f.finish(a.id);
  assert.equal(ran.state, 'done');
  // 任务 B：另起一个问题，同样没给会话号 → 必须是另一条会话，且不能带上任务 A 的上文（否则越用越烧 token）
  const b = await f.call('beat_ask', { to: 'dock:small-a', question: '任务B的问题：二加二等于几？', access: 'read-only' });
  const rbn = await f.finish(b.id);
  assert.equal(rbn.state, 'done');
  assert.notEqual(ran.session_id, rbn.session_id, '新任务必须是新会话');
  const askCalls = f.calls.filter(c => c.stage === 'ask');
  assert.equal(askCalls.length, 2);
  assert.notEqual(askCalls[0].conversationId, askCalls[1].conversationId, '两条任务的会话不能是同一条');
  assert.deepEqual(askCalls[0].history, [], '任务 A 的第一步没有上文');
  assert.deepEqual(askCalls[1].history, [], '任务 B 不许带任务 A 的上下文');
  // 任务 A 的续问（显式给会话号）：同一条会话，且任务 A 的上一条问答在这条会话里传递
  const a2 = await f.call('beat_ask', { to: 'dock:small-a', question: '任务A的续问：刚才问的是什么？', access: 'read-only', session_id: ran.session_id });
  const ra2 = await f.finish(a2.id);
  assert.equal(ra2.session_id, ran.session_id, '续问沿用任务 A 的会话');
  const last = f.calls.filter(c => c.stage === 'ask').at(-1);
  assert.equal(last.conversationId, askCalls[0].conversationId, '续问和任务 A 是同一条会话');
  assert.equal(last.history.length, 2, '同一会话里上一条问答（问 + 答）要传下去');
  assert.match(String(last.history[0]), /任务A的问题/, '传下去的确实是任务 A 的那条消息');
  assert.doesNotMatch(JSON.stringify(last.history), /任务B的问题/, '不能把别的任务的内容混进来');
});

test('HTTP plain user question uses default compact flow and measured budget without settings changes', async t => {
  const f = await service(t);
  const baseline = JSON.stringify(f.config.flow);
  const run = await f.call('beat_discuss', { question: '请帮我规划一个能自动保存进度、失败后直接继续的小任务流程。' });
  const result = await f.finish(run.id);
  assert.equal(result.state, 'done'); assert.equal(result.verdict, 'consensus');
  assert.equal(JSON.stringify(f.config.flow), baseline);
  assert.deepEqual(result.participants, roster);
  assert.deepEqual(f.calls.map(x => x.stage), ['outline', 'outline', 'outline', 'outline', 'expand', 'review', 'review', 'review']);
  assert.equal(result.controlMetrics.phases.discussion.measuredTokens, 1600);
  assert.equal(result.controlMetrics.phases.discussion.unknownCalls, 0);
  assert.equal(result.controlMetrics.phases.discussion.calls, 8);
  assert.equal(result.discussionMetrics.stages.outline.calls, 4);
  assert.equal(result.discussionMetrics.stages.review.calls, 3);
  assert.ok(fs.existsSync(result.discussionMetrics.artifactPath));
  const count = f.calls.length;
  const fresh = f.svc.store.run(run.id);
  const repeated = await f.svc.orch.negotiate(fresh, new AbortController().signal, fresh.natives || {}, 'discuss');
  assert.equal(repeated.consensus, true); assert.equal(f.calls.length, count);
  assert.equal(f.svc.store.get('controlMetrics:' + run.id).phases.discussion.calls, 8);
  const file = f.evidence('default-http-discussion', { runId: run.id, verdict: result.verdict, goal: run.goal, noSettingsChanges: true, suppliedPaths: false, calls: f.calls, metrics: result.controlMetrics, discussionMetrics: result.discussionMetrics });
  t.diagnostic('default-flow evidence: ' + file);
});

test('HTTP resume keeps successful outlines and native conversations after a single failed participant', async t => {
  let failed = false;
  const f = await service(t, ({ seat, stage }) => {
    if (!failed && seat === 'dock:small-b' && stage === 'outline') { failed = true; throw Object.assign(Error('fixture interruption'), { noFallback: true }); }
    return null;
  });
  const run = await f.call('beat_discuss', { question: '请规划能保存检查点并继续执行的处理流程。' });
  const stopped = await f.finish(run.id);
  assert.equal(stopped.state, 'error');
  await f.call('beat_resume', { id: run.id });
  const resumed = await f.finish(run.id);
  assert.equal(resumed.verdict, 'consensus');
  assert.equal(f.calls.filter(x => x.stage === 'outline' && x.seat === 'codex').length, 1);
  assert.equal(f.calls.filter(x => x.stage === 'outline' && x.seat === 'dock:small-b').length, 2);
  assert.equal(resumed.conversations.length, 4);
  assert.equal(new Set(resumed.conversations.map(x => x.conversationId)).size, 4);
  assert.equal(resumed.controlMetrics.phases.discussion.reservations, undefined);
  assert.deepEqual(resumed.controlMetrics.reservations, {});
  const file = f.evidence('resume-http-discussion', { runId: run.id, firstState: stopped.state, finalVerdict: resumed.verdict, calls: f.calls, conversations: resumed.conversations, metrics: resumed.controlMetrics });
  t.diagnostic('resume evidence: ' + file);
});

test('HTTP plain parallel goal enters pull queue and independently verifies a real file with default settings', async t => {
  const f = await service(t, ({ stage, opts }) => {
    if (stage === 'expand') return { summary: '创建可验收文件', decisions: choices, plan: { tasks: [{ id: 'make-file', owner: 'codex', type: 'workspace', title: '创建结果文件', detail: '创建 out.txt，内容为任务完成', files: ['out.txt'], dependsOn: [], inputRefs: [], outputRefs: ['out.txt'], acceptance: ['文件内容为任务完成'], checks: [], difficulty: 'hard', tokenBudget: 4000, maxRetries: 2 }], acceptance: ['产出文件通过独立核验'], checks: [] } };
    if (stage === 'queue-execute') {
      const file = path.join(opts.cwd, 'out.txt'); fs.writeFileSync(file, '任务完成\n');
      return { summary: '已创建结果文件', artifacts: [{ path: file, summary: 'UTF8 文本：任务完成' }], completed: ['创建文件'], next: [] };
    }
    if (stage === 'queue-review' || stage === 'global-review') {
      const file = path.join(opts.cwd, 'out.txt');
      return { pass: fs.readFileSync(file, 'utf8') === '任务完成\n', issues: [] };
    }
    return null;
  });
  const run = await f.call('beat_parallel', { goal: '请创建一个写着任务完成的结果文件，完成后检查内容是否正确。' });
  const result = await f.finish(run.id);
  assert.equal(result.state, 'passed', result.error || result.result);
  const executed = f.calls.find(x => x.stage === 'queue-execute'), reviewed = f.calls.find(x => x.stage === 'queue-review');
  assert.ok(executed); assert.ok(reviewed); assert.notEqual(executed.seat, reviewed.seat);
  assert.equal(result.taskQueue[0].state, 'passed');
  // 新契约：任务有自己的工作目录（BEAT 按日期/任务编号创建），产出落在那里而不是用户目录的根。
  const runCwd = result.cwd;
  assert.ok(runCwd.startsWith(f.config.workspace), '任务工作目录必须在用户指定目录之内：' + runCwd);
  assert.notEqual(runCwd, f.config.workspace, '任务应当有自己的文件夹，不再直接写在用户目录根');
  const file = path.join(runCwd, 'out.txt');
  assert.equal(fs.readFileSync(file, 'utf8'), '任务完成\n');
  assert.equal(fs.existsSync(path.join(f.config.workspace, 'out.txt')), false, '不得把产出散落在用户目录根');
  const evidence = f.evidence('default-http-parallel', { runId: run.id, goal: run.goal, finalState: result.state, noSettingsChanges: true, suppliedPaths: false, output: file, executor: executed.seat, reviewer: reviewed.seat, queue: result.taskQueue, metrics: result.controlMetrics });
  t.diagnostic('parallel evidence: ' + evidence);
});

test('HTTP默认设置：普通讨论被裁决拒绝后自动局部修订，全体复审通过，无需点击继续', async t => {
  let repairs = 0;
  const f = await service(t, ({ stage, opts }) => {
    if (stage === 'review' && repairs < 2) return { verdict: 'fail', planHash: /hash=([a-f0-9]{64})/.exec(opts.prompt)[1], issues: [{ section: 'summary', problem: '需要补齐恢复后的核验步骤', serious: false }] };
    if (stage === 'repair') { repairs++; return { decisions: choices, summary: '补齐检查点和恢复后核验', patches: [{ section: 'summary', value: '先保存真实检查点，恢复时核对已完成产物，再由非执行者逐项核验。' }] }; }
    if (stage === 'adjudicate') {
      const candidates = JSON.parse(opts.prompt.slice(opts.prompt.indexOf('候选=') + 3, opts.prompt.indexOf('。锁定决策=')));
      const selected = candidates.at(-1);
      return { candidateId: selected.candidateId, planHash: selected.planHash, proceed: false, reason: '核验步骤需先补齐', notes: [] };
    }
    return null;
  });
  const baseline = JSON.stringify(f.config.flow);
  const run = await f.call('beat_discuss', { question: '请规划能中断恢复并独立核验的文件处理流程。' });
  const result = await f.finish(run.id);
  assert.equal(result.state, 'done'); assert.equal(result.discussionMetrics.autoContinuations, 1);
  assert.equal(repairs, 2); assert.equal(f.calls.filter(call => call.stage === 'outline').length, 4);
  assert.equal(f.calls.filter(call => call.stage === 'expand').length, 1);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 9);
  assert.equal(JSON.stringify(f.config.flow), baseline);
  const file = f.evidence('automatic-discussion-recovery', { runId: run.id, finalState: result.state, noSettingsChanges: true, suppliedPaths: false, manualResume: false, calls: f.calls, metrics: result.discussionMetrics });
  t.diagnostic('automatic-recovery evidence: ' + file);
});

test('HTTP默认设置：先自纠非法检查再执行一次，实际语法检查与非执行者内容核验均通过', async t => {
  const f = await service(t, ({ stage, opts }) => {
    if (stage === 'expand') return { summary: '创建能语法检查的结果文件', decisions: choices, plan: { tasks: [{ id: 'make-file', owner: 'codex', title: '创建结果文件', detail: '创建 out.mjs，标记任务完成', files: ['out.mjs'], outputRefs: ['out.mjs'], acceptance: ['文件包含completed=true声明'], checks: ['node -e "new Function(1)"'] }], acceptance: ['文件包含completed=true声明'], checks: [] } };
    if (stage === 'repair') return { decisions: choices, summary: '使用注册语法入口，内容由独立搭档读取核验', patches: [{ section: 'tasks.make-file', value: { checks: ['node --check out.mjs'] } }] };
    if (stage === 'queue-execute') { const file = path.join(opts.cwd, 'out.mjs'); fs.writeFileSync(file, 'const completed=true;\n'); return { summary: '已创建结果文件', artifacts: [{ path: file, summary: '任务完成声明' }] }; }
    if (stage === 'queue-review') return { pass: fs.readFileSync(path.join(opts.cwd, 'out.mjs'), 'utf8') === 'const completed=true;\n', issues: [] };
    return null;
  });
  const baseline = JSON.stringify(f.config.flow);
  const run = await f.call('beat_parallel', { goal: '创建一个标记任务已完成的JavaScript文件，并分别检查语法和文件内容。' });
  const result = await f.finish(run.id);
  assert.equal(result.state, 'passed', result.error || result.result);
  assert.equal(result.discussionMetrics.preflightRepairs, 1);
  assert.equal(f.calls.filter(call => call.stage === 'queue-execute').length, 1);
  assert.equal(result.taskQueue[0].attempts, 1); assert.equal(result.taskQueue[0].retries, 0);
  const executor = f.calls.find(call => call.stage === 'queue-execute'), reviewer = f.calls.find(call => call.stage === 'queue-review');
  assert.notEqual(executor.seat, reviewer.seat); assert.equal(JSON.stringify(f.config.flow), baseline);
  const file = f.evidence('preflight-before-execution', { runId: run.id, finalState: result.state, output: path.join(f.config.workspace, 'out.mjs'), noSettingsChanges: true, suppliedPaths: false, calls: f.calls, queue: result.taskQueue, metrics: result.discussionMetrics });
  t.diagnostic('preflight evidence: ' + file);
});
