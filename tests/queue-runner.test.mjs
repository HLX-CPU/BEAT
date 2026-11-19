import { test, after } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactsRoot } from './helpers/temp.mjs';
import { runQueuedTasks, routeTask, taskRouting, prepareQueuedTasks, inferDifficulty } from '../src/queue-runner.mjs';
import { Store } from '../src/store.mjs';
import { TaskQueue } from '../src/task-queue.mjs';
import { ControlBudget } from '../src/control-budget.mjs';
import { createGoalContract, deliveryGoalCriterion } from '../src/goal-contract.mjs';

// The controller contract is exercised separately from TaskQueue persistence.
// TaskQueue's own suite verifies atomic leases, dependency/conflict checks and recovery.
class FixtureQueue {
  constructor({ store, runId, workers }) { this.items = []; this.workers = workers; this.store = store; this.runId = runId; this.beats = 0; store.queue = this; }
  enqueue(tasks) { this.items = tasks.map(task => ({ ...task, state: 'queued', attempts: 0 })); }
  list() { return this.items.map(item => ({ ...item })); }
  claim(worker) {
    const item = this.items.find(task => task.state === 'queued' && task.eligibleWorkers.includes(worker) && task.dependsOn.every(id => this.items.find(other => other.id === id).state === 'passed'));
    if (!item) return null;
    Object.assign(item, { state: 'running', worker, executor: worker, leaseToken: 'lease-' + item.id + '-' + (++item.attempts) }); return { ...item };
  }
  heartbeat() { this.beats++; }
  checkpoint(id, _token, value) { this.items.find(item => item.id === id).checkpoint = value; }
  complete(id, _token, result) { Object.assign(this.items.find(item => item.id === id), { state: 'verifying', result }); }
  holdVerification(id, issues, { result }) { Object.assign(this.items.find(item => item.id === id), { state: 'verifying', result, issues }); }
  verify(id, reviewer, verdict) { const item = this.items.find(item => item.id === id); if (verdict.pass) Object.assign(item, { state: 'passed', reviewer }); else this.fail(id, null, verdict.issues); }
  fail(id, _token, issues, options = {}) { const item = this.items.find(item => item.id === id); Object.assign(item, { issues, state: options.terminal || options.unknownSideEffects ? 'blocked' : item.attempts >= 3 ? 'failed' : 'queued' }); }
  recover() {}
  block(id, issues) { Object.assign(this.items.find(item => item.id === id), { issues, state: 'blocked' }); }
  cancel() { for (const item of this.items) if (item.state !== 'passed') item.state = 'cancelled'; }
  recordUsage() {}
  metrics() { return { heartbeats: this.beats, total: this.items.length }; }
}

// 测试工作区放系统临时目录：以前写在 ../workspaces/queue-runner-tests（产品目录里），
// 每跑一次就留一堆带时间戳的目录——提取纯净版时实测把副本弄脏。
const root = path.join(artifactsRoot(), 'queue-runner-tests');
// 用例结束后清掉本文件积累的带时间戳目录：以前每跑一次留一批，无限累积。
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 被占用则留给下次清理 */ } });
function setup(handler, workers = ['codex', 'deepseek'], extra = {}) {
  const cwd = path.join(root, Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)); fs.mkdirSync(cwd, { recursive: true });
  const data = new Map(), calls = [], events = [], active = new Map(); let maxActive = 0;
  const store = { set: (key, value) => data.set(key, value), get: key => data.get(key), event: (...args) => events.push(args) };
  const orch = { store, TaskQueue: FixtureQueue, config: { flow: { runChecks: true, control: { progressPollMs: 50, tokenBudgetEnforced: true, allowAnyWrite: false, quarantineUnknown: true, ...extra } } }, participants: () => workers,
    roster: { state: () => ({ status: 'online' }) },
    async controlCall(run, options, limits) {
      calls.push({ options, limits, prompt: options.build(options.seat) });
      const count = (active.get(options.seat) || 0) + 1; active.set(options.seat, count); maxActive = Math.max(maxActive, count);
      assert.equal(options.onlyAgent, true);
      try { return { by: options.seat, ...(await handler({ run, options, limits, prompt: options.build(options.seat), calls, store })) }; }
      finally { active.set(options.seat, count - 1); }
    }, runChecks: async (_cwd, commands) => commands.map(command => ({ command, ok: true, exitCode: 0, output: 'ok', ms: 1 })) };
  return { orch, run: { id: 'fixture-run', cwd, goal: 'fixture objective' }, calls, store, events, get maxActive() { return maxActive; } };
}

function output(run, filename, summary = '完成') {
  const file = path.join(run.cwd, filename); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, summary);
  return { text: JSON.stringify({ summary, artifacts: [{ path: file, summary }] }) };
}
const task = (id, extra = {}) => ({ id, title: id, detail: '创建 ' + id, files: [id + '.txt'], acceptance: ['内容符合要求'], ...extra });
const pass = { text: '{"pass":true,"issues":[]}' };

test('global review and its truncated-response retry receive exact checkpoint authority and the persisted shared preflight', async () => {
  let globalReviews = 0, writes = 0;
  const s = setup(async ({ run, options, prompt }) => {
    if (options.role === 'execute') { writes++; return output(run, 'a.txt', 'verified text'); }
    if (!options.slot.endsWith(':queue-global-review')) return pass;
    globalReviews++;
    const checkpoint = path.join(run.cwd, '.beat-control', run.id, 'a', 'checkpoint.json');
    assert.ok(prompt.includes(JSON.stringify([checkpoint])));
    assert.match(prompt, /其他 \.beat-control 文件不因此获得写权限/);
    assert.match(prompt, /不索要尚未生成的最终回复记录/);
    const actual = JSON.parse(fs.readFileSync(path.join(run.cwd, '.beat-control', run.id, 'global-checks.json'), 'utf8'));
    assert.deepEqual(actual.newFilePreflight, run.newFilePreflight);
    return globalReviews === 1 ? { text: '{"pass":true' } : pass;
  }, ['codex','deepseek'], { tokenBudgetEnforced: false, difficultyRouting: false });
  s.run.newFilePreflight = { pass: true, at: new Date().toISOString(), files: [{ path: path.join(s.run.cwd, 'a.txt'), existedBefore: false }] };
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { owner: 'codex' })], acceptance: ['组合结果正确'] }, AbortSignal.timeout(5000));
  assert.equal(result.verdict.verdict, 'pass'); assert.equal(writes, 1); assert.equal(globalReviews, 2);
});

test('图片准备失败时保留核验，不能误报没有视觉搭档或重画成果', async () => {
  let executions=0, reviews=0;
  const s=setup(async({run,options})=>{if(options.role==='execute'){executions++;return output(run,'scene.svg','<svg/>');}reviews++;return pass;},['codex','dock:vision'],{tokenBudgetEnforced:false,difficultyRouting:false});
  s.orch.config.dock=[{id:'vision',vision:true}];s.orch.renderHtmlEvidence=async()=>[];
  const result=await runQueuedTasks(s.orch,s.run,{tasks:[task('scene',{owner:'codex',files:['scene.svg'],acceptance:['画面清晰']})]},AbortSignal.timeout(3000));
  assert.equal(executions,1);assert.equal(reviews,0);assert.equal(result.queue[0].state,'verifying');
  assert.match(result.queue[0].issues.join('；'),/核验图片尚未准备完整/);
  assert.doesNotMatch(result.verdict.issues.join('；'),/没有能看图/);
});

test('打印/普通 HTML 没有内联 SVG 时不再永久挂起，依赖任务能继续（R408 回归）', async () => {
  // R408 实况：A4 打印页的自动渲染被跳过（没有内联 <svg>），旧逻辑把"跳过"
  // 当成"缺少核验图片"永久挂起，task-3（生成 PDF）永远等不到依赖，整任务判失败。
  let executions = 0, reviews = 0;
  const s = setup(async ({ run, options, limits }) => {
    if (options.role === 'execute') {
      executions++;
      return limits.taskId === 'print' ? output(run, 'review.html', '<html><body><table>打印页</table></body></html>') : output(run, 'out.txt', 'pdf placeholder');
    }
    reviews++;
    return pass;
  }, ['codex', 'deepseek'], { tokenBudgetEnforced: false, difficultyRouting: false });
  s.orch.renderHtmlEvidence = async ({ artifacts }) => [{ file: artifacts[0].path, status: 'skipped', issue: '文件里没有内联 <svg>，不属于可视化交付物，未做渲染核验' }];
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [
    task('print', { owner: 'codex', files: ['review.html'], acceptance: ['HTML只本地引用本地样式，无外链字体或图片', '评分表结构完整，正文全部落入页面'] }),
    task('pdf', { owner: 'codex', files: ['out.txt'], dependsOn: ['print'], acceptance: ['文件内容符合要求'] }),
  ] }, AbortSignal.timeout(5000));
  assert.equal(executions, 2, '依赖任务必须能开始执行，不能被核验图片卡住');
  assert.ok(reviews >= 2, '跳过渲染的 HTML 仍要交给独立搭档按源码核验');
  const states = Object.fromEntries(result.queue.map(item => [item.id, item.state]));
  assert.equal(states.print, 'passed');
  assert.equal(states.pdf, 'passed');
});

test('接口拒图或模型没有读到图片只暂停核验，不消耗执行返工和顾问候选', async () => {
  for(const rejected of [true,false]) {
    let executions=0,reviews=0;
    const s=setup(async({run,options})=>{
      if(options.role==='execute'){executions++;return output(run,'scene.svg','<svg/>');}
      reviews++;
      if(rejected)throw Object.assign(Error('接口拒绝了本次图片输入'),{code:'IMAGE_INPUT_REJECTED'});
      return {text:'{"pass":false,"issues":["当前可用工具不能读取PNG为可视图像"]}'};
    },['codex','dock:vision'],{tokenBudgetEnforced:false,difficultyRouting:false});
    s.orch.config.dock=[{id:'vision',vision:true}];
    s.orch.renderHtmlEvidence=async({artifacts,evidenceRoot})=>{
      fs.mkdirSync(evidenceRoot,{recursive:true});const file=path.join(evidenceRoot,'frame.png');fs.writeFileSync(file,'image');
      const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      return [{file:artifacts[0].path,sha256:sha(artifacts[0].path),status:'rendered',imageHashes:[{path:file,sha256:sha(file)}]}];
    };
    const result=await runQueuedTasks(s.orch,s.run,{tasks:[task('scene',{owner:'codex',files:['scene.svg'],acceptance:['画面清晰']})]},AbortSignal.timeout(3000));
    assert.equal(executions,1);assert.equal(reviews,1);assert.equal(result.queue[0].state,'verifying');
    assert.match(result.queue[0].issues.join('；'),rejected?/接口拒绝/:/未能读取图片/);
    assert.equal(s.store.get('executionCandidates:'+s.run.id+':scene'),undefined);
  }
});

test('final goal evidence includes pre-write state and native receipts; unverified rejection never re-executes', async () => {
  let executions=0, sawEvidence=false;
  const s=setup(async ({run,options,prompt})=>{
    if(options.role==='execute') { executions++; return {...output(run,'proof.txt','真实文件内容'),nativeToolEvidence:{source:'fixture-real-fs-write',calls:[{tool:'write',status:'completed',path:path.join(run.cwd,'proof.txt')}]}}; }
    assert.match(prompt,/执行前文件状态/); assert.match(prompt,/"existedBefore":false/); assert.match(prompt,/fixture-real-fs-write/); sawEvidence=true;
    return {text:JSON.stringify({pass:false,issues:['核验者尚未完成禁令核对'],goalHash:s.contract.goalHash,goalChecks:{object:'verified',deliverables:'verified',prohibitions:'unverified'},readbacks:[]})};
  });
  s.contract=createGoalContract({goal:'新建 proof.txt，内容为真实文件内容。禁止桌面助手'});s.run.goal=s.contract.originalGoal;
  s.store.set('goalContract:'+s.run.id,s.contract);
  const criterion=deliveryGoalCriterion(s.contract);
  const result=await runQueuedTasks(s.orch,s.run,{tasks:[task('proof',{owner:'codex',files:['proof.txt'],acceptance:[criterion]})],acceptance:[criterion]},new AbortController().signal);
  assert.equal(result.verdict.pass,false);assert.equal(sawEvidence,true);assert.equal(executions,1);assert.equal(result.queue[0].state,'verifying');
  assert.equal(fs.readFileSync(path.join(s.run.cwd,'proof.txt'),'utf8'),'真实文件内容');
});

test('产出引用了工作目录外的绝对路径时：拒绝，且报错要告诉模型工作目录在哪、该怎么写（R182 实测连续被拒 26 次、白烧 400 万 token）', async () => {
  const s = setup(async ({ run, options, limits }) => {
    if (options.role !== 'execute') return pass;
    // 模型把产出复制到"窗口目录"（工作目录之外）后用绝对路径引用 —— R182 的真实形态
    const outside = path.join(path.dirname(run.cwd), 'BEAT.exe');
    fs.writeFileSync(outside, 'fake exe');
    // 检查点由执行者自己写（真实运行时是搭档写文件），这里照同一条路径写一份
    const checkpointPath = path.join(run.cwd, '.beat-control', run.id, limits.taskId, 'checkpoint.json');
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    fs.writeFileSync(checkpointPath, JSON.stringify({
      summary: '编译完成', completed: ['src/launcher.cs'], next: [],
      artifacts: [{ path: outside, summary: '编译完成' }],
    }));
    await new Promise(resolve => setTimeout(resolve, 400)); // 给观察循环一点时间去读检查点
    return output(run, limits.taskId + '.txt');
  }, ['codex', 'deepseek'], { difficultyRouting: false, taskModelReview: false, tokenBudgetEnforced: false });

  await runQueuedTasks(s.orch, s.run, {
    tasks: [task('task-1', { owner: 'codex' })],
    acceptance: ['产出可用'],
  }, AbortSignal.timeout(8000));

  // 拒绝信息要写进时间线，且必须可操作：含工作目录、含"相对路径/写在工作目录内"的指引、含"不要自己复制"
  // 事件是 [runId, type, text] 三元组
  const texts = s.events.map(e => Array.isArray(e) ? String(e[2] || '') : String(e));
  const rejected = texts.filter(t => t.includes('检查点未采用'));
  assert.ok(rejected.length > 0, '要有拒绝记录：' + JSON.stringify(texts.slice(-6)));
  const text = rejected.join('\n');
  assert.match(text, /工作目录/, '报错要点明工作目录：' + text.slice(0, 400));
  assert.match(text, /相对路径|写在工作目录内/, '报错要给出正确写法：' + text.slice(0, 400));
  assert.match(text, /不要自己复制|不要.*复制/, '要明确禁止把产出复制到工作目录外');
});

test('控制器把当前HTML的后台截图交给支持视觉的非执行者，截图本身不构成通过', async () => {
  let reviews = 0;
  const s = setup(async ({ run, options, prompt }) => {
    if (options.role === 'execute') return output(run, 'scene.html', '<svg></svg>');
    assert.equal(options.seat, 'claude'); assert.equal(options.verificationAttachments.length, 1);
    assert.match(prompt, /后台真实浏览器渲染|后台真实浏览器对当前文件/);
    reviews++; return pass;
  }, ['codex', 'deepseek'], { difficultyRouting: false, tokenBudgetEnforced: false });
  s.orch.renderHtmlEvidence = async ({ artifacts, evidenceRoot }) => {
    fs.mkdirSync(evidenceRoot, { recursive: true }); const file = path.join(evidenceRoot, 'fixture.png'); fs.writeFileSync(file, 'fixture image');
    const { createHash } = await import('node:crypto');
    return [{ file: artifacts[0].path, sha256: createHash('sha256').update(fs.readFileSync(artifacts[0].path)).digest('hex'), status: 'rendered', screenshots: [file], imageHashes: [{ path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }] }];
  };
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('scene', { owner: 'codex', files: ['scene.html'], acceptance: ['浏览器画面完整'] })], acceptance: ['最终动画无外链'] }, AbortSignal.timeout(3000));
  assert.equal(result.verdict.pass, true); assert.equal(reviews, 2, '局部与整体验收分别调用非执行者');
});

test('实际渲染成功仍不能替代独立验收，关闭模型核验保留未验证状态', async () => {
  const s = setup(async ({ run, options }) => {
    assert.equal(options.role, 'execute'); return output(run, 'scene.html', '<svg></svg>');
  }, ['codex', 'deepseek'], { difficultyRouting: false, taskModelReview: false, tokenBudgetEnforced: false });
  s.orch.renderHtmlEvidence = async () => [{ status: 'rendered', screenshots: [] }];
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('scene', { owner: 'codex', files: ['scene.html'], acceptance: ['浏览器画面完整'] })] }, AbortSignal.timeout(3000));
  assert.equal(result.verdict.pass, false); assert.equal(result.queue[0].state, 'blocked');
  assert.ok(result.verdict.issues.some(issue => /未验证/.test(issue)));
});

test('两次独立语义验收失败后顾问选真实旧快照，第三次按选择执行仍需独立通过', async () => {
  let attempts = 0, advisorCalls = 0;
  const s = setup(async ({ run, options, prompt }) => {
    if (options.role === 'execute') {
      attempts++;
      if (attempts === 3) {
        assert.match(prompt, /顾问在两次验收未通过/);
        const selected = s.orch.store.get(`executionCandidates:${run.id}:a`).selection;
        assert.equal(fs.readFileSync(selected.artifacts[0].snapshotPath, 'utf8'), '旧候选1');
      }
      return output(run, 'a.txt', attempts < 3 ? '旧候选' + attempts : '通过的新产物');
    }
    if (options.role === 'consult') {
      advisorCalls++; assert.equal(options.seat, 'claude');
      const candidates = JSON.parse(prompt.slice(prompt.indexOf('候选=') + 3, prompt.indexOf('\n选择身份=')));
      assert.deepEqual(candidates.map(candidate => candidate.artifacts[0].content), ['旧候选1', '旧候选2']);
      return { text: JSON.stringify({ candidateId: candidates[0].candidateId, candidateHash: candidates[0].candidateHash, reason: '第一版结构较好', fixes: ['修正内容以满足原验收'] }), usage: { totalTokens: 50 } };
    }
    assert.equal(options.role, 'evaluate');
    return attempts < 3 ? { text: '{"pass":false,"issues":["内容不符合原验收"]}' } : pass;
  });
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, AbortSignal.timeout(3000));
    assert.equal(result.verdict.pass, true); assert.equal(attempts, 3); assert.equal(advisorCalls, 1);
    assert.equal(result.queue[0].attempts, 3); assert.equal(result.queue[0].retries, 2);
    assert.equal(db.get(`executionCandidates:${s.run.id}:a`).selection.status, 'selected');
  } finally { db.close(); }
});

test('两轮语义失败后顾问暂不可用保留验收，继续只恢复同一选择而不重做当前产物', async () => {
  let executions = 0, available = false;
  const s = setup(async ({ run, options, prompt }) => {
    if (options.role === 'execute') { executions++; return output(run, 'a.txt', '候选' + executions); }
    if (options.role === 'consult') {
      if (!available) throw Error('顾问暂不可用');
      const candidates = JSON.parse(prompt.slice(prompt.indexOf('候选=') + 3, prompt.indexOf('\n选择身份=')));
      return { text: JSON.stringify({ candidateId: candidates[0].candidateId, candidateHash: candidates[0].candidateHash, reason: '结构更好', fixes: ['修正原验收问题'] }) };
    }
    return executions < 3 ? { text: '{"pass":false,"issues":["需要修正内容"]}' } : pass;
  });
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  const plan = { tasks: [task('a')] };
  try {
    const first = await runQueuedTasks(s.orch, s.run, plan, AbortSignal.timeout(3000));
    assert.equal(first.queue[0].state, 'verifying'); assert.equal(executions, 2);
    assert.equal(first.queue[0].retries, 1);
    available = true;
    const second = await runQueuedTasks(s.orch, s.run, plan, AbortSignal.timeout(3000), {}, { resume: { from: 'failed' } });
    assert.equal(second.verdict.pass, true); assert.equal(executions, 3);
    assert.equal(s.calls.filter(call => call.options.role === 'consult').length, 2);
  } finally { db.close(); }
});

test('真实SQLite：被拒或缺失的验收检查只保留验收，不重复生成产物；继续也只验收', async () => {
  for (const mode of ['unsupported', 'confirmation', 'missing']) {
    const s = setup(async ({ run, options }) => {
      assert.equal(options.role, 'execute', '无法执行的检查不得用模型伪装为已通过');
      return output(run, 'a.txt', '完成的产物');
    });
    const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
    // R156 修复后，明确文件（node --test tests/a.test.mjs）由 BEAT 在沙箱外直接执行，不再要求看板确认；
    // 这条用例守的是"glob/项目级范围仍需确认 → 只保留验收、不重复生成产物"的契约，
    // 所以 confirmation 模式改用 glob 形式（展开后仍是同一个 fixture 文件）。
    const command = mode === 'unsupported' ? 'node -e "process.exit(0)"' : mode === 'confirmation' ? 'node --test "tests/*.test.mjs"' : 'node --test tests/a.test.mjs';
    if (mode === 'confirmation') { fs.mkdirSync(path.join(s.run.cwd, 'tests')); fs.writeFileSync(path.join(s.run.cwd, 'tests/a.test.mjs'), 'throw Error("must not execute");'); }
    s.orch.runChecks = mode === 'missing' ? async () => [] : (await import('../src/checks.mjs')).runChecks;
    const plan = { tasks: [task('a', { checks: [command] })] };
    try {
      const first = await runQueuedTasks(s.orch, s.run, plan, AbortSignal.timeout(3000));
      assert.equal(first.verdict.pass, false); assert.equal(first.queue[0].state, 'verifying');
      assert.equal(first.queue[0].attempts, 1); assert.equal(first.queue[0].retries, 0);
      assert.equal(first.queue[0].result.verdict.unverified, true);
      const second = await runQueuedTasks(s.orch, s.run, plan, AbortSignal.timeout(3000), {}, { resume: { from: 'failed' } });
      assert.equal(second.verdict.pass, false); assert.equal(second.queue[0].state, 'verifying');
      assert.equal(second.queue[0].attempts, 1); assert.equal(second.queue[0].retries, 0);
      assert.equal(s.calls.length, 1); assert.equal(fs.readFileSync(path.join(s.run.cwd, 'a.txt'), 'utf8'), '完成的产物');
    } finally { db.close(); }
  }
});

test('真实SQLite：旧版本仅因拒绝检查耗尽重试，继续时恢复验收而非执行', async () => {
  const s = setup(async () => { throw Error('已有产物不能重新派发或假装模型验收通过'); });
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  s.orch.config.flow.control.taskMaxRetries = 0;
  const command = 'node -e "process.exit(0)"';
  const plan = { tasks: [task('a', { checks: [command], maxRetries: 0 })] };
  const queue = new TaskQueue({ store: db, runId: s.run.id, cwd: s.run.cwd, workers: ['codex', 'deepseek'], maxRetries: 0 });
  queue.enqueue(prepareQueuedTasks(plan, ['codex', 'deepseek'], s.orch.config.flow.control));
  const { registeredCheckFor, runChecks } = await import('../src/checks.mjs');
  let rejection; try { registeredCheckFor(s.run.cwd, command); } catch (error) { rejection = `${command} 失败：${error.message}`; }
  s.orch.runChecks = runChecks;
  try {
    for (let attempt = 0; attempt < 1; attempt++) {
      const claimed = queue.claim('codex'); const produced = JSON.parse(output(s.run, 'a.txt').text);
      queue.complete('a', claimed.leaseToken, { taskId: 'a', executor: 'codex', artifacts: produced.artifacts, summary: '原产物' });
      queue.verify('a', 'beat', { pass: false, attempt: claimed.attempts, issues: [rejection] });
    }
    assert.equal(queue.get('a').status, 'blocked');
    const result = await runQueuedTasks(s.orch, s.run, plan, AbortSignal.timeout(3000), {}, { resume: { from: 'failed' } });
    assert.equal(result.queue[0].state, 'verifying'); assert.equal(result.queue[0].executor, 'codex');
    assert.equal(result.queue[0].attempts, 1); assert.equal(result.queue[0].retries, 0); assert.equal(s.calls.length, 0);
    assert.equal(result.queue[0].result.checks[0].notDispatched, true);
  } finally { db.close(); }
});

test('实际检查执行失败仍要求返工，未知检查副作用隔离，整体命令拒绝不重开已验收小任务', async () => {
  for (const mode of ['executed-failure', 'unknown', 'global-refusal']) {
    const s = setup(async ({ run, options }) => options.role === 'execute' ? output(run, 'a.txt') : pass);
    const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
    s.orch.runChecks = async (_cwd, commands) => commands.map(command => ({ command, ok: false, exitCode: mode === 'executed-failure' ? 1 : null, output: '实际证据', notDispatched: mode !== 'executed-failure', unknownSideEffects: mode === 'unknown', ms: 1 }));
    const plan = { tasks: [task('a', { checks: mode === 'global-refusal' ? [] : ['check'] })], checks: mode === 'global-refusal' ? ['check'] : [] };
    try {
      const result = await runQueuedTasks(s.orch, s.run, plan, AbortSignal.timeout(3000));
      assert.equal(result.verdict.pass, false);
      assert.equal(s.calls.filter(call => call.options.role === 'execute').length, mode === 'executed-failure' ? 3 : 1);
      assert.equal(result.queue[0].state, mode === 'global-refusal' ? 'passed' : 'blocked');
      if (mode === 'unknown') assert.match(result.queue[0].quarantineReason, /unknown-side-effects/);
    } finally { db.close(); }
  }
});

test('真实SQLite四任务竞争临时预算会等待释放，全通过且不花重试', { timeout: 6000 }, async () => {
  const workers = ['codex', 'deepseek', 'dock:c', 'dock:d'];
  const s = setup(async () => { throw new Error('replaced by budget-backed fixture'); }, workers);
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  s.orch.config.flow = { tokenBudgetEnforced: true, taskTokenBudget: 1000, executionTokenBudget: 3000, taskMaxRetries: 2, maxParallelTasks: 4 };
  const ledger = new ControlBudget(db, s.run, s.orch.config.flow), nativeExecutions = [], admissionErrors = [];
  s.orch.controlCall = async (run, options, limits) => {
    const work = options.role === 'execute'; let reservation;
    try { reservation = ledger.reserve({ ...limits, phase: 'execution', seat: options.seat, inputTokens: 0, maxOutputTokens: work ? 1000 : 128 }); }
    catch (error) { admissionErrors.push(error.code); throw error; }
    if (work) nativeExecutions.push(limits.taskId);
    await new Promise(resolve => setTimeout(resolve, 30));
    const result = work ? output(run, limits.taskId + '.txt') : pass;
    const usage = { totalTokens: 50, inputTokens: 25, outputTokens: 25 };
    ledger.finish(reservation.id, { usage, text: result.text });
    return { by: options.seat, ...result, usage, scopeWriteEvidence: { source: 'native-tool-log', complete: true, paths: work ? [path.join(run.cwd, limits.taskId + '.txt')] : [] } };
  };
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: ['a', 'b', 'c', 'd'].map(id => task(id)) }, AbortSignal.timeout(4000));
    assert.equal(result.verdict.pass, true);
    assert.deepEqual([...nativeExecutions].sort(), ['a', 'b', 'c', 'd']);
    assert.ok(admissionErrors.includes('CONTROL_BUDGET_BUSY'), 'fixture actually exercises a deferred, not-dispatched request');
    assert.ok(result.queue.every(item => item.state === 'passed' && item.attempts === 1 && item.retries === 0));
    assert.ok(ledger.state().phases.execution.usedTokens < 3000);
    assert.equal(ledger.state().phases.execution.measuredTokens, 400);
    const q = new TaskQueue({ store: db, runId: s.run.id, cwd: s.run.cwd, workers, caseInsensitive: false });
    assert.ok(q.list().some(item => q.get(item.id, { withHistory: true }).history.some(entry => entry.outcome === 'not-dispatched')));
    assert.equal(Object.keys(ledger.state().reservations).length, 0);
  } finally { db.close(); }
});

test('设置最大并发1时多个可用搭档仍按小任务串行完成', async () => {
  let active = 0, peak = 0;
  const s = setup(async ({ run, options, limits }) => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 15)); return options.role === 'evaluate' ? pass : output(run, limits.taskId + '.txt'); }
    finally { active--; }
  }, ['codex', 'deepseek', 'dock:c'], { maxParallelTasks: 1 });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: ['a', 'b', 'c'].map(id => task(id)) }, new AbortController().signal);
  assert.equal(result.verdict.pass, true); assert.equal(peak, 1);
  assert.ok(result.queue.every(item => item.attempts === 1));
});

test('helper自身可验证审计文件不误当产物越界，额外记录不能从模型JSON冒充',async()=>{
 for(const trusted of [true,false]){
 const s=setup(async({run,options})=>{
  if(options.role==='evaluate')return pass;
  const r=output(run,'a.txt');const audit=path.join(run.cwd,'desktop-assistant','data','D-fixture.json');
  fs.mkdirSync(path.dirname(audit),{recursive:true});fs.writeFileSync(audit,'controller audit');
  if(trusted)return {...r,desktopTaskId:'D-fixture',desktopEvidence:{taskId:'D-fixture',calls:[{tool:'file_write',args:{path:'a.txt'},evidence:{sideEffects:'file-write'}}]}};
  const parsed=JSON.parse(r.text);parsed.desktopTaskId='D-fixture';return {text:JSON.stringify(parsed)};
 });
 const r=await runQueuedTasks(s.orch,s.run,{tasks:[task('a')]},new AbortController().signal);
 assert.equal(r.verdict.pass,trusted);if(!trusted)assert.match(r.reports[0].error,/范围外/);
 }
});

test('真实helper写入证据不能借另一队列任务的files范围越界',async()=>{
 const s=setup(async({run,options})=>{
 if(options.role==='evaluate')return pass;
 const r=output(run,'a.txt');return {...r,desktopEvidence:{calls:[{tool:'file_write',args:{path:'b.txt'},evidence:{sideEffects:'file-write'}}]}};
 });
 const r=await runQueuedTasks(s.orch,s.run,{tasks:[task('a'),task('b',{dependsOn:['a']})]},new AbortController().signal);
 assert.equal(r.verdict.pass,false);assert.match(r.reports[0].error,/范围外.*b\.txt/);
});

test('helper复制只读取输入范围，移动会修改输入而必须具有源路径写入授权',async()=>{
 for(const tool of ['file_copy','file_move']){
  const s=setup(async({run,options})=>{
   if(options.role==='evaluate')return pass;
   const r=output(run,'a.txt');
   return {...r,desktopEvidence:{calls:[{tool,args:{path:'input.txt',to:'a.txt'}}]}};
  });
  fs.writeFileSync(path.join(s.run.cwd,'input.txt'),'source kept');
  const r=await runQueuedTasks(s.orch,s.run,{tasks:[task('a',{inputRefs:['input.txt']})]},new AbortController().signal);
  assert.equal(r.verdict.pass,tool==='file_copy');
  if(tool==='file_move')assert.match(r.reports[0].error,/范围外.*input\.txt/);
  assert.equal(fs.readFileSync(path.join(s.run.cwd,'input.txt'),'utf8'),'source kept');
 }
});

test('Windows native mixed-case file artifact matches normalized queue scope and survives real SQLite verification', {skip:process.platform!=='win32'},async()=>{
 const s=setup(async({run,options})=>options.role==='evaluate'?pass:output(run,'Mixed_CASE_Output.txt'),['deepseek','dock:review']);
 const store=new Store(':memory:');s.orch.store=store;delete s.orch.TaskQueue;
 s.orch.config.flow={tokenBudgetEnforced:true,runChecks:true,difficultyRouting:true,cheapAgents:['deepseek'],taskTokenBudget:10000,executionTokenBudget:20000};
 try{const result=await runQueuedTasks(s.orch,s.run,{tasks:[task('mixed',{files:['Mixed_CASE_Output.txt'],outputRefs:['Mixed_CASE_Output.txt']})]},new AbortController().signal);
 assert.equal(result.verdict.pass,true);assert.equal(result.queue[0].reviewer,'dock:review');assert.match(result.reports[0].artifacts[0].path,/Mixed_CASE_Output/);
 }finally{store.close();}
});

test('并行任务只写各自声明的文件时，不把另一位任务的文件当成来源不明的越界改动', async () => {
  const s = setup(async ({ run, options, limits }) => {
    if (options.role === 'execute') {
      // 模拟并行窗口：另一个独立任务的执行者在本任务执行期间写了它自己声明的文件。
      if (limits.taskId === 'a') fs.writeFileSync(path.join(run.cwd, 'b.txt'), 'sibling task wrote this');
      return output(run, limits.taskId + '.txt', 'done-' + limits.taskId);
    }
    return pass;
  }, ['codex', 'deepseek'], { allowAnyWrite: false });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a'), task('b')], acceptance: ['两个文件都完成'] }, new AbortController().signal);
  assert.equal(result.verdict.pass, true, JSON.stringify(result.verdict.issues));
  assert.equal(fs.readFileSync(path.join(s.run.cwd, 'a.txt'), 'utf8'), 'done-a');
  assert.equal(fs.readFileSync(path.join(s.run.cwd, 'b.txt'), 'utf8'), 'done-b');
});

test('规则路由：简单便宜、难任务强模型、指定可用集合、其余负载均衡', () => {
  const workers = ['codex', 'deepseek', 'dock:cheap'];
  const config = { cheapAgents: ['dock:cheap'], strongAgent: 'codex' };
  assert.deepEqual(routeTask({ difficulty: 'simple' }, workers, config), ['dock:cheap']);
  assert.deepEqual(routeTask({ difficulty: 'hard' }, workers, config), ['codex']);
  assert.deepEqual(routeTask({}, workers, config), workers);
  // 方案点名的执行搭档掉线/暂停：BEAT 直接改派给在线搭档，不让客户干等（用户要求：跳过他并重新分配任务）。
  const reassigned = taskRouting({ eligibleWorkers: ['missing'] }, workers, config);
  assert.deepEqual(reassigned.eligibleWorkers, workers, '点名搭档不可用时改派给在线搭档');
  assert.match(reassigned.routingReason, /已由 BEAT 改派/, '改派要留痕，客户看得到');
  assert.ok(reassigned.excluded.some(item => item.worker === 'missing' && item.reason === '搭档当前不可用'), '被跳过的搭档要记进证据');
  // 但"在线、只是接口上下文超出预算"不算掉线：这时仍然保留任务，绝不静默降级去跑一个装不下的模型。
  const tooBig = taskRouting({ eligibleWorkers: ['codex'], tokenBudget: 100 }, workers, { ...config, tokenBudgetEnforced: true, workerMinTokens: { codex: { work: 5000 } } });
  assert.deepEqual(tooBig.eligibleWorkers, [], '在线但超预算的点名搭档不许被改派');
  assert.throws(() => prepareQueuedTasks({ tasks: [task('a', { dependsOn: ['b'] })] }, workers), /依赖/);
  assert.throws(() => prepareQueuedTasks({ tasks: [task('a', { acceptance: [] })] }, workers), /验收/);
});

test('依赖仅在先行任务独立验收通过后领取；交接仅传文件路径摘要', async () => {
  const s = setup(async ({ run, options, limits, prompt }) => {
    if (options.role === 'evaluate') return pass;
    if (limits.taskId === 'b') {
      assert.match(prompt, /a\.txt/); assert.match(prompt, /产出/); assert.doesNotMatch(prompt, /先行执行完整对话秘密/);
    }
    return output(run, limits.taskId + '.txt', '先行执行完整对话秘密');
  });
  // Artifacts convey a bounded summary, not the executor's raw conversation.
  s.orch.controlCall = async function(run, options, limits) {
    s.calls.push({ options, limits, prompt: options.build(options.seat) });
    if (options.role === 'evaluate') return { by: options.seat, ...pass };
    if (limits.taskId === 'b') {
      const prompt = options.build(options.seat); assert.match(prompt, /a\.txt/); assert.doesNotMatch(prompt, /完整对话秘密/);
    }
    const result = output(run, limits.taskId + '.txt'); result.text = '完整对话秘密\n' + result.text;
    return { by: options.seat, ...result };
  };
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a'), task('b', { dependsOn: ['a'] })] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'pass');
  assert.deepEqual(s.calls.map(call => [call.options.role, call.limits.taskId]), [['execute', 'a'], ['evaluate', 'a'], ['execute', 'b'], ['evaluate', 'b']]);
  assert.notEqual(result.reports[0].executor, result.reports[0].reviewer);
  assert.ok(fs.existsSync(result.reports[0].reportPath));
  assert.ok(s.store.get('taskQueue:fixture-run').every(item => item.state === 'passed'));
});

test('检查明确覆盖每条验收时由代码直接验证；语义验收不能被绿灯替代', async () => {
  const s = setup(async ({ run, options, limits }) => options.role === 'evaluate' ? pass : {
    ...output(run, limits.taskId + '.txt'),
    scopeWriteEvidence: { source: 'native-tool-log', complete: true, paths: [path.join(run.cwd, limits.taskId + '.txt')] },
  });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { checks: ['check-a'], acceptance: [{ text: '文件符合格式', check: 'check-a' }] }), task('b', { checks: ['check-b'] })] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'pass');
  assert.equal(s.calls.filter(call => call.options.role === 'evaluate').length, 1);
  assert.equal(s.calls.find(call => call.options.role === 'evaluate').limits.taskId, 'b');
  assert.equal(s.maxActive, 1, '同一真实模型执行和核验不会并发写同一会话');
});

test('检查失败立即返工且最多两次重试，模型不能把失败检查改成成功', async () => {
  const s = setup(async ({ run, options, limits }) => { assert.equal(options.role, 'execute'); return output(run, limits.taskId + '.txt'); });
  s.orch.runChecks = async (_cwd, commands) => commands.map(command => ({ command, ok: false, exitCode: 1, output: 'real failure' }));
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { checks: ['failing-check'] })] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'fail'); assert.equal(s.calls.length, 3); assert.equal(result.queue[0].state, 'failed');
  assert.match(s.calls[1].prompt, /real failure/);
});

test('只有一个搭档时未覆盖的语义验收不允许自己批准：请顾问只读核验，并附上产出内容', async () => {
  const s = setup(async ({ run, options, limits, prompt }) => {
    if (options.role === 'evaluate') { assert.equal(options.seat, 'claude'); assert.match(prompt, /产出文件内容如下[\s\S]*完成/); return pass; }
    return output(run, limits.taskId + '.txt');
  }, ['codex']);
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'pass'); assert.equal(result.reports[0].reviewer, 'claude'); assert.equal(result.reports[0].executor, 'codex');
});

test('只有一个搭档且顾问也连不上：产出保留在验收中，不判失败、不重做，点继续只核验', async () => {
  const s = setup(async ({ run, options, limits }) => { assert.equal(options.role, 'execute'); return output(run, limits.taskId + '.txt'); }, ['codex']);
  s.orch.roster = { state: agent => ({ status: agent === 'claude' ? 'offline' : 'online' }) };
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'fail'); assert.equal(result.queue[0].state, 'verifying'); assert.equal(s.calls.length, 1);
  assert.ok(result.verdict.issues.some(issue => /继续/.test(issue) && /只核验不重做/.test(issue)));
});

test('执行长时间没有任何进展：看门狗停止这次尝试并带问题重新排队，第二次成功', async () => {
  let attempts = 0;
  const s = setup(async ({ run, options, limits }) => {
    if (options.role === 'evaluate') return pass;
    if (++attempts === 1) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('已取消'), { cancelled: true })), { once: true }));
    return output(run, limits.taskId + '.txt');
  }, ['codex', 'deepseek'], { stallOverrideMinutes: 0.002 });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'pass'); assert.equal(attempts, 2);
  assert.ok(result.reports.some(report => /没有任何进展/.test(report.error || '')));
});

test('预算超出立即隔离，不再发起模型调用', async () => {
  const s = setup(async () => { const error = new Error('任务预算已用完'); error.code = 'CONTROL_BUDGET_EXCEEDED'; throw error; });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { tokenBudget: 42 })] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'fail'); assert.equal(result.queue[0].state, 'blocked'); assert.equal(s.calls.length, 1); assert.equal(s.calls[0].limits.budget, 42);
});

test('取消传播给执行调用并保留任务证据，不继续核验或重试', async () => {
  const controller = new AbortController();
  const s = setup(async ({ options }) => { assert.equal(options.signal.aborted, false); controller.abort(); assert.equal(options.signal.aborted, true, '取消传到本次执行'); const error = new Error('已取消'); error.cancelled = true; throw error; });
  await assert.rejects(runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, controller.signal), error => error.cancelled === true);
  assert.equal(s.calls.length, 1); assert.equal(s.store.queue.list()[0].state, 'cancelled');
});

test('未知电脑输入结果隔离，不自动重放', async () => {
  const s = setup(async () => { const error = new Error('desktop timed out'); error.desktopEvidence = { sideEffects: 'unknown' }; throw error; });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { type: 'desktop' })] }, new AbortController().signal);
  assert.equal(result.queue[0].state, 'blocked'); assert.equal(s.calls.length, 1);
});

test('没有真实日志或检查点变化时不制造心跳', async () => {
  const s = setup(async ({ run, options, limits }) => { if (options.role === 'evaluate') return pass; await new Promise(resolve => setTimeout(resolve, 110)); return output(run, limits.taskId + '.txt'); });
  await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
  assert.equal(s.store.queue.beats, 0);
});

test('模型检查点不能伪造无副作用或进程归属，真实SQLite假死恢复保持隔离', async () => {
  const controller = new AbortController(), db = new Store(':memory:');
  let queue, clock = Date.now(), dead = false, forwarded;
  class ObservedQueue extends TaskQueue {
    constructor(options) {
      super({ ...options, now: () => clock, isProcessAlive: () => !dead, caseInsensitive: false });
      queue = this;
    }
    checkpoint(id, token, value) { forwarded = value; return super.checkpoint(id, token, value); }
  }
  const s = setup(async ({ run, options, limits }) => {
    assert.equal(options.role, 'execute');
    const produced = JSON.parse(output(run, limits.taskId + '.txt').text);
    const checkpointPath = path.join(run.cwd, '.beat-control', run.id, limits.taskId, 'checkpoint.json');
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    fs.writeFileSync(checkpointPath, JSON.stringify({ summary: '真实进度', completed: ['a.txt'], next: ['核对桌面输入'], artifacts: produced.artifacts,
      sideEffects: 'none', sideEffectsVerified: true, executorPid: 99999999, data: { sideEffects: 'none', fakeAuthority: true } }));
    const deadline = Date.now() + 1000;
    while (!queue.list()[0].checkpoint && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const observed = queue.list()[0];
    assert.equal(observed.checkpoint.summary, '真实进度');
    assert.deepEqual(observed.checkpoint.filesDone, ['a.txt']);
    for (const key of ['sideEffects', 'sideEffectsVerified', 'executorPid', 'data']) assert.equal(Object.hasOwn(forwarded, key), false, key + ' is not trusted model authority');
    assert.notEqual(observed.sideEffects, 'none');
    assert.equal(observed.sideEffectsVerified, false);
    assert.notEqual(observed.executorPid, 99999999);
    assert.equal(observed.checkpoint.data.fakeAuthority, undefined);
    dead = true; clock += queue.leaseMs + 1;
    const recovered = queue.recover();
    assert.deepEqual(recovered.requeued, []);
    assert.deepEqual(recovered.quarantined, ['a']);
    assert.equal(queue.list()[0].state, 'blocked');
    assert.equal(queue.claim('deepseek'), null, 'unknown input is never replayed by another worker');
    controller.abort();
    const error = new Error('fixture cancellation after recovery evidence'); error.cancelled = true; throw error;
  });
  s.orch.store = db; s.orch.TaskQueue = ObservedQueue;
  try {
    await assert.rejects(runQueuedTasks(s.orch, s.run, { tasks: [task('a', { type: 'desktop' })] }, controller.signal), error => error.cancelled === true);
    assert.equal(s.calls.length, 1, 'only one controlled executor fixture ran');
    assert.equal(fs.existsSync(path.join(s.run.cwd, 'a.txt')), true);
  } finally { controller.abort(); db.close(); }
});

test('伪造或越界的产出路径拒绝通过验收', async () => {
  const s = setup(async () => ({ text: '{"summary":"完成","artifacts":[{"path":"../fake.txt"}]}' }));
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'fail'); assert.ok(result.reports.every(report => /真实文件/.test(report.error)));
});

test('真实持久化TaskQueue集成：逐task执行核验、依赖、恢复不重复执行', async () => {
  const s = setup(async ({ run, options, limits }) => options.role === 'evaluate' ? pass : output(run, limits.taskId + '.txt'));
  const db = new Store(path.join(root, 'sqlite-' + Date.now() + '-' + Math.random().toString(36).slice(2), 'test.sqlite'));
  s.orch.store = db; delete s.orch.TaskQueue;
  try {
    const plan = { tasks: [task('a', { acceptance: [{ text: '文件存在', check: 'check-a' }] }), task('b', { dependsOn: ['a'] })] };
    const first = await runQueuedTasks(s.orch, s.run, plan, new AbortController().signal);
    assert.equal(first.verdict.verdict, 'pass'); assert.ok(first.queue.every(item => item.state === 'passed'));
    const calls = s.calls.length;
    const restored = await runQueuedTasks(s.orch, s.run, plan, new AbortController().signal);
    assert.equal(restored.verdict.verdict, 'pass'); assert.equal(s.calls.length, calls);
  } finally { db.close(); }
});

test('独立开关：关闭检查交独立核验，关闭模型核验保留未验证，关闭checkpoint不要求落盘', async () => {
  const s = setup(async ({ run, options, limits, prompt }) => {
    if (options.role === 'evaluate') return pass;
    assert.doesNotMatch(prompt, /checkpoint\.json/); return output(run, limits.taskId + '.txt');
  }, ['codex', 'deepseek'], { checkpoints: false, taskAutoChecks: false });
  let checks = 0; s.orch.runChecks = async () => { checks++; return []; };
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { acceptance: [{ text: '文件存在', check: 'check-a' }] })] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'pass'); assert.equal(checks, 0); assert.equal(s.calls.filter(call => call.options.role === 'evaluate').length, 1);
  const blocked = setup(async ({ run, limits }) => output(run, limits.taskId + '.txt'), ['codex', 'deepseek'], { taskModelReview: false });
  const failed = await runQueuedTasks(blocked.orch, blocked.run, { tasks: [task('a')] }, new AbortController().signal);
  assert.equal(failed.verdict.verdict, 'fail'); assert.equal(failed.queue[0].state, 'blocked'); assert.equal(blocked.calls.length, 1);
});

test('真实队列恢复verifying：只核验既有产物，不重新执行', async () => {
  const s = setup(async ({ options }) => { assert.equal(options.role, 'evaluate'); return pass; });
  const db = new Store(path.join(root, 'resume-db-' + Date.now() + '-' + Math.random().toString(36).slice(2), 'test.sqlite'));
  s.orch.store = db; delete s.orch.TaskQueue;
  try {
    const plan = { tasks: [task('a')] }, queue = new TaskQueue({ store: db, runId: s.run.id, cwd: s.run.cwd, workers: ['codex', 'deepseek'] });
    queue.enqueue(prepareQueuedTasks(plan, ['codex', 'deepseek'])); const claimed = queue.claim('codex');
    const parsed = JSON.parse(output(s.run, 'a.txt').text);
    queue.complete('a', claimed.leaseToken, { executor: 'codex', artifacts: parsed.artifacts, summary: '已有产出' });
    const result = await runQueuedTasks(s.orch, s.run, plan, new AbortController().signal);
    assert.equal(result.verdict.verdict, 'pass'); assert.equal(s.calls.length, 1); assert.equal(s.calls[0].options.seat, 'deepseek');
  } finally { db.close(); }
});

test('整体验收失败只将明确问题任务返工，依赖消费者只重核且不重做', async () => {
  let aExecutions = 0, bExecutions = 0, globalReviews = 0;
  const s = setup(async ({ run, options, limits }) => {
    if (options.role === 'evaluate') {
      if (options.slot.endsWith(':queue-global-review')) {
        globalReviews++;
        return { text: JSON.stringify(globalReviews === 1 ? { pass: false, issues: [{ taskId: 'a', problem: 'a.txt 内容需要修复以符合组合验收' }] } : { pass: true, issues: [] }) };
      }
      return pass;
    }
    if (limits.taskId === 'a') aExecutions++; else bExecutions++;
    return output(run, limits.taskId + '.txt', limits.taskId === 'a' && aExecutions === 1 ? 'bad' : 'good');
  }, ['codex', 'deepseek', 'dock:reviewer']);
  const db = new Store(path.join(root, 'global-db-' + Date.now() + '-' + Math.random().toString(36).slice(2), 'test.sqlite'));
  s.orch.store = db; delete s.orch.TaskQueue;
  s.orch.runChecks = async (_cwd, commands) => commands.map(command => ({ command, ok: command !== 'global-check' || fs.readFileSync(path.join(s.run.cwd, 'a.txt'), 'utf8') === 'good', output: 'a.txt needs repair', exitCode: 0 }));
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { eligibleWorkers: ['codex'] }), task('b', { eligibleWorkers: ['deepseek'], dependsOn: ['a'] })], acceptance: ['组合输出符合要求'], checks: ['global-check'] }, new AbortController().signal);
    assert.equal(result.verdict.verdict, 'pass'); assert.equal(aExecutions, 2); assert.equal(bExecutions, 1); assert.equal(globalReviews, 2);
    assert.equal(result.queue.find(item => item.id === 'b').attempts, 1);
  } finally { db.close(); }
});

test('当前目标合同的真实组合失败只返工问题文件，消费者重核，无关任务和候选保留', async () => {
  const {createHash}=await import('node:crypto');
  for (const failures of [1,2]) {
  const count={a:0,b:0,c:0};let globalReviews=0,repairPrompt=false;
  const s=setup(async ({run,options,limits,prompt})=>{
    if(options.role==='consult') {
      const candidates=s.orch.store.get('executionCandidates:'+s.run.id+':a').candidates;
      assert.equal(candidates.length,2);assert.equal(count.a,2);
      return {text:JSON.stringify({candidateId:candidates[1].candidateId,candidateHash:candidates[1].candidateHash,reason:'第二份真实候选保留更多正确内容',fixes:['只修a.txt的组合内容']})};
    }
    if(options.role==='execute') {
      count[limits.taskId]++;
      if(limits.taskId==='a' && count.a===2){assert.match(prompt,/这是局部返工/);assert.match(prompt,/repair-only-listed-issues/);repairPrompt=true;}
      return output(run,limits.taskId+'.txt',limits.taskId==='a' && count.a<=failures?'BAD_COMPOSITION':'GOOD_COMPOSITION');
    }
    const global=options.slot.endsWith(':queue-global-review');if(global)globalReviews++;
    const failed=global && globalReviews<=failures;
    const files=global?['a','b','c']:[limits.taskId];
    return {text:JSON.stringify({pass:!failed,issues:failed?[{taskId:'a',problem:'组合验收要求a.txt为GOOD_COMPOSITION，当前为BAD_COMPOSITION'}]:[],goalHash:contract.goalHash,
      goalChecks:{object:'verified',deliverables:failed?'failed':'verified',prohibitions:'verified'},readbacks:files.map(id=>{
        const file=path.join(run.cwd,id+'.txt'),data=fs.readFileSync(file);return {path:file,sha256:createHash('sha256').update(data).digest('hex'),quote:data.toString()};
      })})};
  },['codex','deepseek','dock:reviewer'],{maxParallelTasks:1});
  const contract=createGoalContract({goal:'组合交付a.txt、b.txt、c.txt，a.txt最终必须为GOOD_COMPOSITION；保留其余已有产物。'});
  s.run.goal=contract.originalGoal;
  const db=new Store(path.join(root,'repair-db-'+Date.now()+'-'+Math.random().toString(36).slice(2),'queue.sqlite'));s.orch.store=db;delete s.orch.TaskQueue;db.set('goalContract:'+s.run.id,contract);
  try {
    const result=await runQueuedTasks(s.orch,s.run,{tasks:[task('a',{eligibleWorkers:['codex'],acceptance:['文件存在']}),task('b',{eligibleWorkers:['deepseek'],dependsOn:['a'],acceptance:['文件存在']}),task('c',{eligibleWorkers:['deepseek'],acceptance:['文件存在']})],acceptance:[deliveryGoalCriterion(contract)]},new AbortController().signal);
    assert.equal(result.verdict.pass,true,JSON.stringify({verdict:result.verdict,queue:result.queue.map(t=>({id:t.id,state:t.state,issues:t.issues})),count,globalReviews}));assert.deepEqual(count,{a:failures+1,b:1,c:1});assert.equal(globalReviews,failures+1);assert.equal(repairPrompt,true);
    if(failures===2)assert.equal(db.get('executionCandidates:'+s.run.id+':a').selection.status,'selected');
    assert.equal(result.queue.find(t=>t.id==='b').attempts,1);assert.equal(result.queue.find(t=>t.id==='c').attempts,1);
    const candidate=db.get('executionCandidates:'+s.run.id+':a').candidates[0];assert.equal(fs.readFileSync(candidate.artifacts[0].snapshotPath,'utf8'),'BAD_COMPOSITION');
    assert.equal(fs.readFileSync(path.join(s.run.cwd,'a.txt'),'utf8'),'GOOD_COMPOSITION');
  } finally {db.close();}
  }
});

test('整体失败缺少当前文件读回时保留产物，不能凭任务编号触发返工', async () => {
  let executions=0;
  const s=setup(async ({run,options,limits})=>{
    if(options.role==='execute'){executions++;return output(run,'a.txt','CORRECT_OUTPUT');}
    const global=options.slot.endsWith(':queue-global-review');
    return {text:JSON.stringify({pass:!global,issues:global?[{taskId:'a',problem:'尚未读到文件'}]:[],goalHash:contract.goalHash,goalChecks:{object:'verified',deliverables:global?'unverified':'verified',prohibitions:'verified'},readbacks:global?[]:[{path:path.join(run.cwd,'a.txt'),sha256:(await import('node:crypto')).createHash('sha256').update('CORRECT_OUTPUT').digest('hex'),quote:'CORRECT_OUTPUT'}]})};
  },['codex','deepseek']);
  const contract=createGoalContract({goal:'新建a.txt并完成组合核验'});s.run.goal=contract.originalGoal;s.store.set('goalContract:'+s.run.id,contract);
  const result=await runQueuedTasks(s.orch,s.run,{tasks:[task('a',{eligibleWorkers:['codex']})],acceptance:[deliveryGoalCriterion(contract)]},new AbortController().signal);
  assert.equal(result.verdict.pass,false);assert.equal(executions,1);assert.equal(result.queue[0].state,'passed');assert.equal(fs.readFileSync(path.join(s.run.cwd,'a.txt'),'utf8'),'CORRECT_OUTPUT');
});

test('成本路由只按接口上下文估算：不同提供方相同成本均被排除，不改变预算', () => {
  const control = { tokenBudgetEnforced: true, taskTokenBudget: 12000, workerMinTokens: { codex: { work: 20000 }, 'dock:cheap': { work: 20000 }, deepseek: { work: 3000 } } };
  const routed = taskRouting({ tokenBudget: 12000 }, ['codex', 'dock:cheap', 'deepseek'], control);
  assert.deepEqual(routed.eligibleWorkers, ['deepseek']); assert.equal(routed.excluded.length, 2);
  assert.equal(routed.availableTokens, 12000); assert.ok(routed.excluded.every(item => item.measurement === 'estimate'));
  const upgrade = taskRouting({ difficulty: 'easy', tokenBudget: 12000 }, ['dock:cheap', 'deepseek'], { ...control, cheapAgents: ['dock:cheap'], strongAgent: 'deepseek' });
  assert.deepEqual(upgrade.eligibleWorkers, ['deepseek']); assert.match(upgrade.routingReason, /显式升级/);
});

test('显式强模型接口成本超过任务预算直接blocked，保留文件路由证据且不调用模型', async () => {
  const s = setup(async () => { assert.fail('预算不够时不得调用模型'); }, ['dock:strong', 'codex'], { strongAgent: 'dock:strong', workerMinTokens: { 'dock:strong': { work: 20000, review: 9000 } } });
  const db = new Store(path.join(root, 'cost-db-' + Date.now() + '-' + Math.random().toString(36).slice(2), 'test.sqlite'));
  s.orch.store = db; delete s.orch.TaskQueue;
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { difficulty: 'hard', tokenBudget: 12000 })] }, new AbortController().signal);
    assert.equal(result.verdict.verdict, 'fail'); assert.equal(result.queue[0].state, 'blocked'); assert.equal(s.calls.length, 0);
    const evidence = JSON.parse(fs.readFileSync(result.metrics.routing.path, 'utf8'));
    assert.equal(evidence.measurement, 'estimate'); assert.equal(evidence.records[0].excluded[0].worker, 'dock:strong');
    assert.equal(evidence.records[0].excluded[0].minimumTokens, 20000);
  } finally { db.close(); }
});

test('预算充分时允许工具接口成本高的拓展坞执行，独立核验仍由其他搭档完成', async () => {
  const s = setup(async ({ run, options, limits }) => options.role === 'evaluate' ? pass : output(run, limits.taskId + '.txt'), ['dock:capable', 'codex'], {
    tokenBudgetEnforced: true, taskTokenBudget: 30000, strongAgent: 'dock:capable', workerMinTokens: { 'dock:capable': { work: 20000, review: 9000 }, codex: { work: 2000, review: 1000 } }
  });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { difficulty: 'hard', tokenBudget: 30000 })] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'pass'); assert.equal(result.reports[0].executor, 'dock:capable'); assert.equal(result.reports[0].reviewer, 'codex');
});

test('核验按任务真实剩余预算排除高成本接口，保留估算排除记录', async () => {
  const s = setup(async ({ run, options, limits, store }) => {
    if (options.role === 'evaluate') { assert.equal(options.seat, 'deepseek'); return pass; }
    store.set('controlMetrics:' + run.id, { tasks: { a: { budget: 12000, usedTokens: 9500 } }, phases: { execution: { budget: 64000, usedTokens: 9500 } }, reservations: {} });
    return output(run, limits.taskId + '.txt');
  }, ['codex', 'dock:reviewer', 'deepseek'], { workerMinTokens: { codex: { work: 1000, review: 1000 }, 'dock:reviewer': { work: 20000, review: 9000 }, deepseek: { work: 1000, review: 600 } } });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { eligibleWorkers: ['codex'] })] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'pass');
  assert.ok(result.metrics.routing.records.some(record => record.mode === 'review' && record.availableTokens === 2500 && record.excluded.some(item => item.worker === 'dock:reviewer')));
});

test('独立核验接口均超出剩余预算时保留产出等待核验，不把未验证结果记成通过', async () => {
  const s = setup(async ({ run, options, limits, store }) => {
    assert.equal(options.role, 'execute');
    store.set('controlMetrics:' + run.id, { tasks: { a: { budget: 12000, usedTokens: 9500 } }, phases: { execution: { budget: 64000, usedTokens: 9500 } } });
    return output(run, limits.taskId + '.txt');
  }, ['codex', 'dock:reviewer'], { workerMinTokens: { codex: { work: 1000 }, 'dock:reviewer': { work: 20000, review: 9000 } } });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { eligibleWorkers: ['codex'] })] }, new AbortController().signal);
  // R363 实测：核验人缺席（欠费/掉线/预算）不是产出有问题——保留产出等核验，不要判死整个任务。
  assert.equal(result.verdict.verdict, 'fail'); assert.notEqual(result.queue[0].state, 'passed');
  assert.equal(result.queue[0].state, 'verifying', '产出保留在验收中，恢复搭档后只核验不重做');
  assert.equal(s.calls.length, 1);
  assert.equal(result.reports[0].verdict.unverified, true);
  assert.ok(result.verdict.issues.some(issue => /等待独立核验/.test(issue)));
});

test('没有能看图的搭档时用不看图的搭档核验非视觉项，视觉项记未验证而不是整项失败', async () => {
  let reviewed = null;
  const s = setup(async ({ run, options, prompt }) => {
    if (options.role === 'execute') return output(run, 'scene.html', '<svg id="bike"></svg>');
    reviewed = { seat: options.seat, prompt, attachments: options.verificationAttachments };
    return pass;                                  // 非视觉项全部通过
  }, ['codex', 'dock:blind'], { difficultyRouting: false, tokenBudgetEnforced: false });
  // 顾问也不可用（R363 实测：Claude 欠费下线），能看图的只剩执行者自己——它不能自证。
  s.orch.roster = { state: agent => ({ status: agent === 'claude' ? 'cooldown' : 'online' }) };
  s.orch.renderHtmlEvidence = async ({ artifacts, evidenceRoot }) => {
    fs.mkdirSync(evidenceRoot, { recursive: true }); const file = path.join(evidenceRoot, 'fixture.png'); fs.writeFileSync(file, 'fixture image');
    const { createHash } = await import('node:crypto');
    return [{ file: artifacts[0].path, sha256: createHash('sha256').update(fs.readFileSync(artifacts[0].path)).digest('hex'), status: 'rendered', screenshots: [file], imageHashes: [{ path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }] }];
  };
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('scene', { owner: 'codex', files: ['scene.html'], acceptance: ['浏览器画面完整'] })] }, AbortSignal.timeout(3000));
  assert.equal(reviewed.seat, 'dock:blind', '没有能看图的搭档时退而用不看图的搭档核验非视觉项');
  assert.equal(reviewed.attachments.length, 0, '不把对方看不了的截图发过去');
  assert.match(reviewed.prompt, /本次核验不支持看图/);
  assert.equal(result.queue[0].state, 'verifying', '视觉项未验证：产出保留，等能看图的搭档回来只核验');
  assert.equal(result.verdict.pass, false);
  assert.ok(result.queue[0].issues.some(issue => /视觉相关验收未验证/.test(issue)));
});

test('核验搭档空答/卡住：只重问核验并挂起，不重跑已完成执行（R379 回归）', async () => {
  let executions = 0, reviews = 0;
  const s = setup(async ({ run, options }) => {
    if (options.role === 'execute') { executions++; return output(run, 'drawing.html', '<svg id="phoenix"></svg>'); }
    reviews++;
    throw Object.assign(new Error('桌面搭档未完成：dock:review：接口返回空答，没有最终答案或工具调用（finish_reason=stop）'), { apiResponseEvidence: { finishReason: 'stop', textLength: 0 } });
  }, ['codex', 'dock:review'], { difficultyRouting: false, tokenBudgetEnforced: false });
  s.orch.roster = { state: agent => ({ status: agent === 'claude' ? 'cooldown' : 'online' }) };
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('draw', { owner: 'codex', files: ['drawing.html'], acceptance: ['文件包含 SVG'] })] }, AbortSignal.timeout(3000));
  assert.equal(executions, 1, '核验失败不能重跑执行');
  assert.equal(reviews, 2, '同一位核验搭档最多重问一次');
  assert.equal(result.queue[0].state, 'verifying', '产出保留在验收中，恢复核验搭档后只核验不重做');
  assert.equal(result.reports[0].verdict.unverified, true);
  assert.ok(result.queue[0].issues.some(issue => /暂时没有返回有效答复/.test(issue)));
});

test('整体验收也执行接口成本准入：本地检查已过而全局核验预算不足仍fail', async () => {
  const s = setup(async ({ run, options, limits }) => { assert.equal(options.role, 'execute'); return output(run, limits.taskId + '.txt'); }, ['codex', 'dock:api'], {
    workerMinTokens: { codex: { work: 1000, review: 15000 }, 'dock:api': { work: 1000, review: 15000 } }
  });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { acceptance: [{ text: '局部格式', check: 'check-a' }] })], acceptance: ['全局组合兼容'] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'fail'); assert.equal(result.queue[0].state, 'passed'); assert.equal(s.calls.length, 1);
  assert.ok(result.verdict.issues.some(issue => issue.includes('预算')));
});

test('真实队列返工后剩余预算不足：动态领取拒绝且queued原地blocked，不多烧一次模型调用', async () => {
  const s = setup(async ({ run, options, limits }) => {
    assert.equal(options.role, 'execute');
    s.orch.store.set('controlMetrics:' + run.id, { tasks: { a: { budget: 12000, usedTokens: 9500 } }, phases: { execution: { budget: 64000, usedTokens: 9500 } }, reservations: {} });
    return output(run, limits.taskId + '.txt');
  }, ['codex', 'deepseek'], { workerMinTokens: { codex: { work: 5000, review: 1000 }, deepseek: { work: 5000, review: 1000 } } });
  const db = new Store(path.join(root, 'dynamic-cost-db-' + Date.now() + '-' + Math.random().toString(36).slice(2), 'test.sqlite'));
  s.orch.store = db; delete s.orch.TaskQueue;
  s.orch.runChecks = async (_cwd, commands) => commands.map(command => ({ command, ok: false, output: '格式仍有问题', exitCode: 1 }));
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { acceptance: [{ text: '局部格式', check: 'check-a' }] })] }, new AbortController().signal);
    assert.equal(result.verdict.verdict, 'fail'); assert.equal(result.queue[0].state, 'blocked'); assert.equal(result.queue[0].attempts, 1); assert.equal(s.calls.length, 1);
    assert.ok(result.metrics.routing.records.some(record => record.mode === 'work-resume' && record.availableTokens === 2500));
  } finally { db.close(); }
});

test('真实队列预算中止保留已发生的provider用量，blocked且不重试', async () => {
  const s = setup(async () => {
    const error = new Error('调用用量超过任务预算，保留已发生的费用证据');
    error.code = 'CONTROL_BUDGET_EXCEEDED';
    error.usage = { inputTokens: 21000, outputTokens: 855, totalTokens: 21855, source: 'native completed usage fixture' };
    throw error;
  });
  const db = new Store(path.join(root, 'failed-usage-db-' + Date.now() + '-' + Math.random().toString(36).slice(2), 'test.sqlite'));
  s.orch.store = db; delete s.orch.TaskQueue;
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { tokenBudget: 12000 })] }, new AbortController().signal);
    const queued = result.queue[0];
    assert.equal(result.verdict.verdict, 'fail'); assert.equal(queued.state, 'blocked');
    assert.equal(queued.attempts, 1); assert.equal(queued.retries, 0); assert.equal(s.calls.length, 1);
    assert.equal(queued.tokensUsed, 21855); assert.equal(queued.usage.measuredTokens, 21855);
    assert.equal(queued.usage.estimatedTokens, 0); assert.equal(queued.usage.unknownCalls, 0);
    assert.equal(result.metrics.tokens.used, 21855);
    assert.equal(result.metrics.tokens.promptTokens, 21000); assert.equal(result.metrics.tokens.completionTokens, 855);
    assert.equal(db.get('queueMetrics:' + s.run.id).tokens.used, 21855, '看板审计不能把失败调用记成零费用');
  } finally { db.close(); }
});

test('controller要求的本任务精确checkpoint文件可作为artifact交付并独立核验', async () => {
  let expectedCheckpoint;
  const s = setup(async ({ run, options, limits }) => {
    if (options.role === 'evaluate') return pass;
    const produced = JSON.parse(output(run, limits.taskId + '.txt').text);
    expectedCheckpoint = path.join(run.cwd, '.beat-control', run.id, limits.taskId, 'checkpoint.json');
    fs.mkdirSync(path.dirname(expectedCheckpoint), { recursive: true });
    fs.writeFileSync(expectedCheckpoint, JSON.stringify({ summary: '阶段完成', completed: ['a.txt'], next: [], artifacts: produced.artifacts }));
    produced.artifacts.push({ path: expectedCheckpoint, summary: '本任务检查点' });
    return { text: JSON.stringify(produced), scopeWriteEvidence: { source: 'native-tool-log', complete: true, paths: [produced.artifacts[0].path, expectedCheckpoint] } };
  });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'pass'); assert.notEqual(result.reports[0].executor, result.reports[0].reviewer);
  assert.ok(result.reports[0].artifacts.some(artifact => artifact.path === expectedCheckpoint));
  assert.equal(result.queue[0].checkpoint.path, expectedCheckpoint);
});

test('其他任务checkpoint没有获得本任务artifact授权；后置校验失败仍保留已发生provider费用', async () => {
  const s = setup(async ({ run, options, limits }) => {
    assert.equal(options.role, 'execute'); assert.equal(limits.taskId, 'a');
    const produced = JSON.parse(output(run, 'a.txt').text);
    const foreignCheckpoint = path.join(run.cwd, '.beat-control', run.id, 'b', 'checkpoint.json');
    fs.mkdirSync(path.dirname(foreignCheckpoint), { recursive: true }); fs.writeFileSync(foreignCheckpoint, '{}');
    produced.artifacts.push({ path: foreignCheckpoint, summary: '另一个任务的检查点' });
    return { text: JSON.stringify(produced), usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      scopeWriteEvidence: { source: 'native-tool-log', complete: true, paths: [produced.artifacts[0].path] } };
  });
  const db = new Store(path.join(root, 'checkpoint-scope-db-' + Date.now() + '-' + Math.random().toString(36).slice(2), 'test.sqlite'));
  s.orch.store = db; delete s.orch.TaskQueue;
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a'), task('b', { dependsOn: ['a'] })] }, new AbortController().signal);
    assert.equal(result.verdict.verdict, 'fail'); assert.ok(result.reports.every(report => /产出超出本任务文件范围/.test(report.error)));
    const failedTask = result.queue.find(item => item.id === 'a');
    assert.equal(failedTask.state, 'blocked'); assert.equal(failedTask.usage.measuredTokens, 120 * s.calls.length);
    assert.ok(failedTask.usage.measuredTokens > 0); assert.equal(result.queue.find(item => item.id === 'b').attempts, 0);
  } finally { db.close(); }
});

test('依赖任务在共享原生会话里重写前序任务声明的文件，不算越界（R514 回归）', async () => {
  const s = setup(async ({ run, options, limits }) => {
    if (options.role !== 'execute') return pass;
    if (limits.taskId === 'a') return output(run, 'a.txt', 'a');
    const b = path.join(run.cwd, 'b.txt'); fs.writeFileSync(b, 'b');
    return { text: JSON.stringify({ summary: '完成', artifacts: [{ path: b, summary: 'b' }] }),
      scopeWriteEvidence: { source: 'native-tool-log', complete: true, paths: [path.join(run.cwd, 'a.txt'), b] } };
  }, ['codex', 'deepseek'], { tokenBudgetEnforced: false, difficultyRouting: false });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [
    task('a', { owner: 'codex' }),
    task('b', { owner: 'codex', files: ['b.txt'], dependsOn: ['a'] }),
  ] }, AbortSignal.timeout(5000));
  assert.equal(result.verdict.verdict, 'pass');
  assert.deepEqual(result.queue.map(item => item.state), ['passed', 'passed']);
});

test('完整可信原生工具写入证据下并发外部改动只记未归因，不误怪执行者', async () => {
  const s = setup(async ({ run, options, limits }) => {
    if (options.role === 'evaluate') return pass;
    const produced = JSON.parse(output(run, limits.taskId + '.txt').text);
    const external = path.join(run.cwd, 'beat-portable', 'config.json'); fs.mkdirSync(path.dirname(external), { recursive: true });
    fs.writeFileSync(external, '{"externalActor":true}');
    return { text: JSON.stringify(produced), scopeWriteEvidence: { source: 'native-tool-log', complete: true, paths: [produced.artifacts[0].path] } };
  });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'pass');
  assert.deepEqual(result.reports[0].concurrentUnattributedChanges, [path.join('beat-portable', 'config.json')]);
  assert.deepEqual(result.reports[0].changes, ['a.txt']);
  assert.equal(result.reports[0].scopeWriteEvidence.complete, true);
});

test('可信原生工具日志中实际观察到的越界write仍拒绝通过', async () => {
  const s = setup(async ({ run, options, limits }) => {
    assert.equal(options.role, 'execute');
    const produced = JSON.parse(output(run, limits.taskId + '.txt').text);
    const outsideScope = path.join(run.cwd, 'other-project', 'config.json'); fs.mkdirSync(path.dirname(outsideScope), { recursive: true }); fs.writeFileSync(outsideScope, '{}');
    return { text: JSON.stringify(produced), scopeWriteEvidence: { source: 'native-tool-log', complete: true, paths: [produced.artifacts[0].path, outsideScope] } };
  });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'fail'); assert.ok(result.reports.every(report => /范围外.*other-project/.test(report.error)));
  assert.equal(s.calls.filter(call => call.options.role === 'evaluate').length, 0);
});

test('不完整原生工具证据保留原有保守scope检查，不把未知shell副作用当作外部改动', async () => {
  const s = setup(async ({ run, options, limits }) => {
    assert.equal(options.role, 'execute');
    const produced = JSON.parse(output(run, limits.taskId + '.txt').text);
    const unattributed = path.join(run.cwd, 'other-project', 'shell-output.txt'); fs.mkdirSync(path.dirname(unattributed), { recursive: true }); fs.writeFileSync(unattributed, 'unknown');
    return { text: JSON.stringify(produced), scopeWriteEvidence: { source: 'native-tool-log', complete: false, paths: [produced.artifacts[0].path] } };
  });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'fail'); assert.ok(result.reports.every(report => /范围外/.test(report.error)));
});

test('原生静默思考跨多个租约周期仍由活owner安全保有，一次执行完成后正常验收', async () => {
  const s = setup(async ({ run, options, limits }) => {
    if (options.role === 'evaluate') return pass;
    // No tool events, log output or checkpoints are emitted while reasoning.
    await new Promise(resolve => setTimeout(resolve, 250));
    return output(run, limits.taskId + '.txt');
  }, ['codex', 'deepseek'], { leaseMs: 90, progressPollMs: 20 });
  const db = new Store(path.join(root, 'silent-lease-db-' + Date.now() + '-' + Math.random().toString(36).slice(2), 'test.sqlite'));
  s.orch.store = db; delete s.orch.TaskQueue;
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
    assert.equal(result.verdict.verdict, 'pass'); assert.equal(result.queue[0].state, 'passed');
    assert.equal(result.queue[0].attempts, 1); assert.equal(result.queue[0].retries, 0);
    assert.equal(s.calls.filter(call => call.options.role === 'execute').length, 1, '安静思考不能触发重新派发');
    assert.notEqual(result.reports[0].executor, result.reports[0].reviewer);
  } finally { db.close(); }
});

test('静默执行期间取消后旧owner keeper不续租或改回取消状态', async () => {
  const controller = new AbortController();
  let afterCancellation, unchangedAfterWaiting;
  const s = setup(async ({ options }) => {
    assert.equal(options.role, 'execute');
    await new Promise(resolve => setTimeout(resolve, 60));
    controller.abort(new Error('fixture cancellation'));
    afterCancellation = s.orch.store.db.prepare('SELECT status,lease_token,lease_expires_at,updated_at,cancelled FROM tq_tasks WHERE scope=? AND id=?').get(s.run.id, 'a');
    await new Promise(resolve => setTimeout(resolve, 160));
    unchangedAfterWaiting = s.orch.store.db.prepare('SELECT status,lease_token,lease_expires_at,updated_at,cancelled FROM tq_tasks WHERE scope=? AND id=?').get(s.run.id, 'a');
    return { text: '取消后的旧调用结束' };
  }, ['codex', 'deepseek'], { leaseMs: 90, progressPollMs: 20 });
  const db = new Store(path.join(root, 'cancel-keeper-db-' + Date.now() + '-' + Math.random().toString(36).slice(2), 'test.sqlite'));
  s.orch.store = db; delete s.orch.TaskQueue;
  try {
    await assert.rejects(runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, controller.signal), error => error.cancelled === true);
    assert.equal(afterCancellation.status, 'blocked'); assert.equal(afterCancellation.cancelled, 1);
    assert.equal(afterCancellation.lease_token, null); assert.equal(afterCancellation.lease_expires_at, null);
    assert.deepEqual(unchangedAfterWaiting, afterCancellation);
    assert.equal(s.calls.length, 1);
  } finally { db.close(); }
});

test('租约token被轮换后旧owner keeper不能续新租约或接受旧执行结果', async () => {
  let replacementLease, afterOldKeeper;
  const s = setup(async ({ options }) => {
    assert.equal(options.role, 'execute');
    await new Promise(resolve => setTimeout(resolve, 45));
    const newExpiry = Date.now() + 5000;
    // Simulate an atomic external revocation/reassignment, rather than relaxing
    // TaskQueue fencing or recycling the still-live native execution.
    s.orch.store.db.prepare('UPDATE tq_tasks SET lease_token=?,lease_owner=?,lease_expires_at=?,attempts=attempts+1 WHERE scope=? AND id=?')
      .run('replacement-fence', 'deepseek', newExpiry, s.run.id, 'a');
    replacementLease = s.orch.store.db.prepare('SELECT status,lease_token,lease_owner,lease_expires_at,attempts FROM tq_tasks WHERE scope=? AND id=?').get(s.run.id, 'a');
    await new Promise(resolve => setTimeout(resolve, 170));
    afterOldKeeper = s.orch.store.db.prepare('SELECT status,lease_token,lease_owner,lease_expires_at,attempts FROM tq_tasks WHERE scope=? AND id=?').get(s.run.id, 'a');
    return { text: '{"summary":"旧执行结果","artifacts":[]}' };
  }, ['codex', 'deepseek'], { leaseMs: 90, progressPollMs: 20 });
  const db = new Store(path.join(root, 'fenced-keeper-db-' + Date.now() + '-' + Math.random().toString(36).slice(2), 'test.sqlite'));
  s.orch.store = db; delete s.orch.TaskQueue;
  try {
    // 旧执行结果被拒收，但不再让整个任务崩溃；新持有者的租约保持原样。
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
    assert.equal(result.verdict.verdict, 'fail'); assert.notEqual(result.queue[0].state, 'passed');
    assert.equal(replacementLease.lease_token, 'replacement-fence'); assert.equal(replacementLease.lease_owner, 'deepseek');
    assert.deepEqual(afterOldKeeper, replacementLease); assert.equal(s.calls.length, 1);
    assert.deepEqual(db.db.prepare('SELECT status,lease_token,lease_owner,lease_expires_at,attempts FROM tq_tasks WHERE scope=? AND id=?').get(s.run.id, 'a'), replacementLease);
  } finally { db.close(); }
});

test('不完整原生归因不能借下游files覆盖他人产物，未知副作用隔离且不自动重放', async () => {
  const s = setup(async ({ run, options, limits }) => {
    assert.equal(options.role, 'execute'); assert.equal(limits.taskId, 'a');
    const produced = JSON.parse(output(run, 'a.txt', 'own output').text);
    fs.writeFileSync(path.join(run.cwd, 'b.txt'), 'unknown shell overwrote downstream file');
    return { text: JSON.stringify(produced), scopeWriteEvidence: { source: 'native-tool-log', complete: false, paths: [produced.artifacts[0].path] } };
  });
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a'), task('b', { dependsOn: ['a'] })] }, new AbortController().signal);
    assert.equal(result.verdict.pass, false);
    const executor = result.queue.find(item => item.id === 'a'), downstream = result.queue.find(item => item.id === 'b');
    assert.equal(executor.state, 'blocked');
    assert.match(executor.quarantineReason || '', /unknown/);
    assert.equal(executor.attempts, 1, 'unknown shell write is never replayed');
    assert.equal(downstream.attempts, 0, 'dependent task cannot consume unverified overwritten output');
    assert.equal(s.calls.length, 1, 'no retry, independent approval or downstream execution');
    assert.match(result.reports[0].error, /范围外.*b\.txt/);
    assert.equal(fs.readFileSync(path.join(s.run.cwd, 'b.txt'), 'utf8'), 'unknown shell overwrote downstream file', 'failure evidence remains on disk');
  } finally { db.close(); }
});

test('默认 token 只计量不限额：接口成本超出预算也照常领取执行，队列不设单任务刹车', async () => {
  const s = setup(async ({ run, options, limits }) => options.role === 'evaluate' ? pass : output(run, limits.taskId + '.txt'), ['dock:strong', 'codex'],
    { tokenBudgetEnforced: undefined, strongAgent: 'dock:strong', taskTokenBudget: 1000, workerMinTokens: { 'dock:strong': { work: 20000, review: 9000 }, codex: { work: 2000, review: 15000 } } });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { difficulty: 'hard', tokenBudget: 1000 })] }, new AbortController().signal);
  assert.equal(result.verdict.verdict, 'pass'); assert.equal(result.reports[0].executor, 'dock:strong'); assert.equal(result.reports[0].reviewer, 'codex');
  assert.equal(result.queue[0].tokenBudget, 0, '队列行不带预算，不会触发 token 刹车');
  assert.doesNotMatch(s.calls[0].prompt, /tokenBudget/);
});

test('方案漏写或乱写难度时按规则判断，并补上输入/产出说明而不拒绝方案', () => {
  const tasks = prepareQueuedTasks({ tasks: [
    task('a', { difficulty: undefined, files: ['a.txt'] }),
    task('b', { difficulty: 'simple|hard', files: ['1', '2', '3', '4'], dependsOn: ['a'] }),
    task('c', { difficulty: 'easy', type: 'desktop', files: [] }),
  ] }, ['codex', 'deepseek'], {});
  assert.deepEqual(tasks.map(t => t.difficulty), ['simple', 'hard', 'easy']);
  assert.match(tasks[0].output, /a\.txt/); assert.match(tasks[1].input, /a/);
  assert.deepEqual(inferDifficulty({ type: 'desktop' }), 'hard');
});

test('首次执行的难题在强搭档掉线时先交给在线搭档，并说明原因', () => {
  const routed = taskRouting({ difficulty: 'hard' }, ['deepseek'], { strongAgent: 'codex' });
  assert.deepEqual(routed.eligibleWorkers, ['deepseek']); assert.match(routed.routingReason, /强搭档暂时不在线/);
  assert.deepEqual(taskRouting({ difficulty: 'hard', escalated: true }, ['deepseek'], { strongAgent: 'codex' }).eligibleWorkers, [], '重试升级后仍只给强搭档');
});

test('R156：归因不完整的窗口内改动只叙述成来源不明、无法归因给执行者，不得写成执行者越界', async () => {
  const s = setup(async ({ run, options, limits }) => {
    assert.equal(options.role, 'execute');
    const produced = JSON.parse(output(run, limits.taskId + '.txt').text);
    // 买家自己为了观察任务写的轮询日志（真实 R156：_probeA-logs/poll-*.json、timeline.txt）
    for (const file of ['_probeA-logs/poll-27.json', '_probeA-logs/poll-28.json', '_probeA-logs/timeline.txt']) {
      const abs = path.join(run.cwd, file); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, '{}');
    }
    // 执行者自己的临时探针：归因不完整时同样无法证明是谁写的，不能算在执行者头上
    const probe = path.join(run.cwd, 'tests', '__probe_runner.mjs'); fs.mkdirSync(path.dirname(probe), { recursive: true }); fs.writeFileSync(probe, '// probe');
    return { text: JSON.stringify(produced), scopeWriteEvidence: { source: 'native-tool-log', complete: false, paths: [produced.artifacts[0].path] } };
  });
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
    const issue = result.queue[0].issues.join('\n');
    assert.match(issue, /本任务窗口内检测到来源不明的其他改动（可能是你自己、编辑器或其他程序写的），无法归因给执行者/);
    assert.doesNotMatch(issue, /执行者.*写到了本任务文件范围外/, '来源不明的改动不得叙述成执行者越界');
    assert.match(issue, /poll-27\.json/); assert.match(issue, /__probe_runner\.mjs/);
    // 分级字段：可归因的越界写入为空，改动全部落在 unattributed，两个桶不混在一起
    assert.deepEqual(result.reports[0].outOfScope.observed, []);
    assert.deepEqual(result.reports[0].outOfScope.unattributed.map(f => f.replaceAll('\\', '/')).sort(),
      ['_probeA-logs/poll-27.json', '_probeA-logs/poll-28.json', '_probeA-logs/timeline.txt', 'tests/__probe_runner.mjs']);
    assert.equal(result.reports[0].scopeAttribution.attributable, false);
    // 安全性未放宽：仍然隔离、原因字符串不变、只执行一次、不自动重领
    assert.equal(result.verdict.pass, false);
    assert.equal(result.queue[0].state, 'blocked');
    assert.equal(result.queue[0].quarantineReason, 'unconfirmed-exit+unknown-side-effects');
    assert.equal(result.queue[0].sideEffects, 'unknown');
    assert.equal(result.queue[0].attempts, 1);
    assert.equal(s.calls.filter(call => call.options.role === 'execute').length, 1, '未知来源改动绝不自动重放');
  } finally { db.close(); }
});

test('R156：可归因到执行者工具日志的越界写入仍明确写成执行者越界并拒绝通过', async () => {
  const s = setup(async ({ run, options, limits }) => {
    assert.equal(options.role, 'execute');
    const produced = JSON.parse(output(run, limits.taskId + '.txt').text);
    const outside = path.join(run.cwd, 'other-project', 'config.json'); fs.mkdirSync(path.dirname(outside), { recursive: true }); fs.writeFileSync(outside, '{}');
    return { text: JSON.stringify(produced), scopeWriteEvidence: { source: 'native-tool-log', complete: true, paths: [produced.artifacts[0].path, outside] } };
  });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, new AbortController().signal);
  assert.match(result.reports[0].error, /^执行者（\w+）写到了本任务文件范围外/, '可归因的越界必须点名执行者');
  assert.match(result.reports[0].error, /范围外.*other-project/);
  assert.equal(result.reports[0].outOfScope.observed.length, 1);
  assert.deepEqual(result.reports[0].outOfScope.unattributed, []);
  assert.equal(result.verdict.pass, false);
  assert.equal(s.calls.filter(call => call.options.role === 'evaluate').length, 0);
});

test('R156：检查全部被环境挡住时只继续核验、不消耗返工次数（否则重试两次必然受阻）', async () => {
  const s = setup(async ({ run, options }) => options.role === 'execute' ? output(run, 'a.txt') : pass);
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  // 故意给足 2 次重试：如果环境失败错误地走了返工流程，这张任务会被重做并最终 blocked/retries-exhausted。
  s.orch.config.flow.control.taskMaxRetries = 2;
  s.orch.runChecks = async (_cwd, commands) => commands.map(command => ({ command, ok: false, exitCode: null, timedOut: false, cancelled: false, ms: 4, output: 'spawn EPERM', notDispatched: false }));
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { checks: ['node --test tests/a.test.mjs'], maxRetries: 2 })] }, new AbortController().signal);
    const entry = result.queue[0];
    // 环境挡住 → hold 在"验收中"，产物保留，不重做、不烧返工次数。
    assert.equal(entry.status, 'verifying', '环境类失败应停在只核验状态，而不是重做：' + entry.status);
    assert.equal(entry.attempts, 1, '不得因为环境失败再消耗一次执行');
    assert.equal(entry.retries, 0, '不得因为环境失败消耗返工次数');
    const report = result.reports.find(item => item.checks?.length) || result.reports[0];
    assert.equal(report.verdict.unverified, true);
    assert.match((report.verdict.issues || []).join('\n'), /spawn EPERM/);
  } finally { db.close(); }
});

test('客户显式授权时才允许超出任务文件范围（allowAnyWrite=true）', async () => {
  // 用默认设置（不传 allowAnyWrite:false，也不传 quarantineUnknown:true）
  const s = setup(async ({ run, options, limits }) => options.role === 'evaluate' ? pass : output(run, 'outside.txt'), ['codex', 'deepseek'], { allowAnyWrite: true, quarantineUnknown: false });
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  try {
    // 任务只声明 a.txt，执行者却写了 outside.txt（模拟 PyInstaller 写 .build、pip 写缓存那种正常副作用）
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { checks: [], files: ['a.txt'] })] }, new AbortController().signal);
    assert.equal(result.verdict.pass, true, '范围外写入不再判失败：' + JSON.stringify(result.verdict));
    const reported = result.reports.find(r => r.outOfScope) || null;
    assert.equal(reported, null, '范围外写入不进 verdict');
  } finally { db.close(); }
});

test('未知副作用始终隔离，即使旧任务显式关闭quarantineUnknown', async () => {
  const s = setup(async ({ run, options }) => options.role === 'evaluate' ? pass : Object.assign(output(run, 'a.txt'), { unknownSideEffects: true }), ['codex','deepseek'], { quarantineUnknown: false });
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { checks: [] })] }, new AbortController().signal);
    assert.equal(result.queue[0].status, 'blocked', '未知输入不能因旧设置放行');
  } finally { db.close(); }
});

for (const source of ['nativeToolEvidence', 'desktopEvidence', 'thrown']) test(`未知输入在${source}中也不能重放或冒充通过`, async () => {
  let writes = 0;
  const s = setup(async ({ run, options }) => {
    if (options.role === 'evaluate') return pass;
    writes++;
    if (source === 'thrown') throw Object.assign(Error('timeout after input'), { desktopEvidence: { sideEffects: 'unknown' } });
    return { ...output(run, 'a.txt'), [source]: { sideEffects: 'unknown' } };
  }, ['codex','deepseek'], { quarantineUnknown: false });
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  try {
    const plan = { tasks: [task('a', { checks: [] })] }, signal = new AbortController().signal;
    const result = await runQueuedTasks(s.orch, s.run, plan, signal);
    assert.equal(result.queue[0].status, 'blocked'); assert.equal(result.verdict.pass, false);
    await runQueuedTasks(s.orch, s.run, plan, signal);
    assert.equal(writes, 1, '重新进入队列仍不得重复输入');
  } finally { db.close(); }
});

test('R156：验收检查被沙箱环境挡住（spawn EPERM）时 verdict 带真实原因与环境分类，不写成纪律问题', async () => {  const s = setup(async ({ run, options }) => options.role === 'execute' ? output(run, 'a.txt') : pass);
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  s.orch.config.flow.control.taskMaxRetries = 0;
  s.orch.runChecks = async (_cwd, commands) => commands.map(command => ({ command, ok: false, exitCode: null, timedOut: false, cancelled: false, ms: 4, output: 'spawn EPERM', notDispatched: false }));
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { checks: ['node --test tests/a.test.mjs'], maxRetries: 0 })] }, new AbortController().signal);
    const report = result.reports.find(item => item.checks?.length) || result.reports[0];
    const issues = (report.verdict?.issues || []).join('\n');
    assert.match(issues, /spawn EPERM/, '必须带上真实原因原文');
    assert.match(issues, /\[环境\/权限限制\]/, '必须带分类标签');
    assert.match(issues, /不等于执行者失职/);
    assert.equal(report.verdict.environment.matched, 'spawn EPERM');
    assert.match(result.queue[0].issues.join('\n'), /\[环境\/权限限制\]/, '任务最终 issues 也要带分类');
    assert.match(result.verdict.issues.join('\n'), /spawn EPERM/);
    assert.ok(result.environmentIssues.some(item => item.taskId === 'a' && item.matched === 'spawn EPERM'), 'result 里单独列出环境原因');
    assert.equal(result.verdict.pass, false);
  } finally { db.close(); }
});

test('R156：执行因沙箱 spawn EPERM 异常退出时，report/result 带真实原因并保留检查点恢复入口', async () => {
  const s = setup(async ({ options }) => { assert.equal(options.role, 'execute'); throw new Error('spawn EPERM'); });
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  s.orch.config.flow.control.taskMaxRetries = 0;
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { maxRetries: 0 })] }, new AbortController().signal);
    const issues = result.reports[0].verdict.issues.join('\n');
    assert.match(issues, /spawn EPERM/);
    assert.match(issues, /\[环境\/权限限制\]/);
    assert.match(issues, /不等于执行者失职/);
    assert.match(issues, /检查点已保留：.*\.beat-control/, '环境失败也必须保留检查点恢复入口');
    assert.equal(result.reports[0].environment.class, 'environment-permission');
    assert.match(result.queue[0].issues.join('\n'), /spawn EPERM/);
    assert.ok(result.environmentIssues.some(item => item.taskId === 'a'), 'result 里单独列出环境原因');
    assert.equal(result.queue[0].state, 'blocked');
    assert.equal(s.calls.filter(call => call.options.role === 'execute').length, 1, '环境失败不自动返工烧钱');
  } finally { db.close(); }
});

test('R156：明确列出的测试文件由 BEAT 在沙箱外真跑，真实退出码进 verdict（环境限制已解除）', async () => {
  const s = setup(async ({ run, options }) => options.role === 'execute' ? output(run, 'a.txt') : pass);
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  s.orch.runChecks = (await import('../src/checks.mjs')).runChecks;
  fs.mkdirSync(path.join(s.run.cwd, 'tests'));
  fs.writeFileSync(path.join(s.run.cwd, 'tests', 'green.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('green', () => assert.equal(1, 1));\n");
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { checks: ['node --test tests/green.test.mjs'] })] }, AbortSignal.timeout(20000));
    const check = result.queue[0].result.checks[0];
    assert.equal(check.ok, true, '明确文件必须真的执行，不能停在"尚未执行"');
    assert.equal(check.exitCode, 0);
    assert.equal(check.notDispatched, undefined);
    assert.equal(result.queue[0].state, 'passed');
  } finally { db.close(); }
});

test('整体核验第一次返回被截断的 JSON 时，同一位重发一次后按完整判定收尾', async () => {
  let globalReviews = 0, executions = 0;
  const complete = run => { const file = path.join(run.cwd, 'a.txt'), data = fs.readFileSync(file); return JSON.stringify({ pass: true, issues: [], goalHash: contract.goalHash, goalChecks: { object: 'verified', deliverables: 'verified', prohibitions: 'verified' }, readbacks: [{ path: file, sha256: createHash('sha256').update(data).digest('hex'), quote: data.toString() }] }); };
  const s = setup(async ({ run, options }) => {
    if (options.role === 'execute') { executions++; return output(run, 'a.txt', 'CORRECT_OUTPUT'); }
    const global = options.slot.endsWith(':queue-global-review');
    if (!global) return { text: JSON.stringify({ pass: true, issues: [] }) };
    globalReviews++;
    if (globalReviews === 1) return { text: '\u0060\u0060\u0060json\n{"pass":true,"issues":[],"goalHash":"' };
    return { text: complete(run) };
  }, ['codex', 'deepseek']);
  const contract = createGoalContract({ goal: '新建a.txt并完成组合核验' });
  s.run.goal = contract.originalGoal; s.store.set('goalContract:' + s.run.id, contract);
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a', { eligibleWorkers: ['codex'] })], acceptance: [deliveryGoalCriterion(contract)] }, new AbortController().signal);
  assert.equal(globalReviews, 2, '截断的核验必须被重发一次');
  assert.equal(executions, 1, '重发核验不得重跑执行');
  assert.ok(result.queue.length >= 1, '任务记录保留');
});

test('写声明文件时创建父目录不算越界，真正无关的目录仍拒绝（R408 回归）', async () => {
  const runCase = async extraDir => {
    const s = setup(async ({ run, options }) => {
      if (options.role !== 'execute') return pass;
      const dir = path.join(run.cwd, 'src');
      fs.mkdirSync(dir, { recursive: true });
      const files = ['a.txt', 'b.txt'].map(name => { const p = path.join(dir, name); fs.writeFileSync(p, 'done'); return { path: p, summary: 'done' }; });
      let extra = [];
      if (extraDir) { const other = path.join(run.cwd, extraDir); fs.mkdirSync(other, { recursive: true }); extra = [other]; }
      return { text: JSON.stringify({ summary: 'done', artifacts: files }), scopeWriteEvidence: { source: 'native-tool-log', complete: true, paths: [dir, ...extra, ...files.map(item => item.path)] } };
    });
    return runQueuedTasks(s.orch, s.run, { tasks: [{ id: 'a', title: 'a', detail: '写两个文件', files: ['src/a.txt', 'src/b.txt'], acceptance: ['内容符合要求'] }] }, AbortSignal.timeout(5000));
  };
  const ok = await runCase(null);
  assert.equal(ok.verdict.verdict, 'pass', '创建 src 父目录是写 src/a.txt 的必要动作，不能判越界');
  assert.equal(ok.reports[0].error, undefined);
  assert.deepEqual(ok.reports[0].outOfScope?.observed || [], []);
  const bad = await runCase('other-dir');
  assert.equal(bad.verdict.verdict, 'fail');
  assert.match(bad.reports[0].error, /范围外.*other-dir/);
});

test('被隔离的任务摘要列出此前不同的失败原因，不再只显示最后一次（R408 回归）', async () => {
  let attempts = 0;
  const s = setup(async ({ options }) => {
    if (options.role === 'execute') { attempts++; throw new Error('模拟失败 ' + attempts); }
    return pass;
  });
  const db = new Store(':memory:'); s.orch.store = db; delete s.orch.TaskQueue;
  try {
    const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, AbortSignal.timeout(5000));
    const issue = result.verdict.issues.join('\n');
    assert.equal(result.queue[0].state, 'blocked');
    assert.match(issue, /模拟失败 3/, '最后一次失败原因必须保留');
    assert.match(issue, /此前尝试/, '摘要要说明此前还失败过');
    assert.match(issue, /模拟失败 1|模拟失败 2/, '此前的不同失败原因也要列出');
  } finally { db.close(); }
});

test('artifacts 里写目录时展开目录内文件，不判死整次执行（R408 回归）', async () => {
  const s = setup(async ({ run, options, limits }) => {
    if (options.role !== 'execute') return pass;
    const file = path.join(run.cwd, 'a.txt'); fs.writeFileSync(file, 'done');
    const preview = path.join(run.cwd, '.beat-control', run.id, limits.taskId, 'preview');
    fs.mkdirSync(preview, { recursive: true });
    for (let i = 1; i <= 2; i++) fs.writeFileSync(path.join(preview, 'page-0' + i + '.txt'), 'page');
    return { text: JSON.stringify({ summary: 'done', artifacts: [{ path: file, summary: '结果' }, { path: preview, summary: '页面图' }] }),
      scopeWriteEvidence: { source: 'native-tool-log', complete: true, paths: [file] } };
  });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('a')] }, AbortSignal.timeout(5000));
  assert.equal(result.verdict.verdict, 'pass', '目录不是产物，但不能因此判死整次执行');
  const artifacts = (result.reports[0].artifacts || []).map(item => item.path.replaceAll('\\', '/'));
  assert.ok(artifacts.some(item => /\/preview\/page-01\.txt$/.test(item)), '目录里的真实文件要进入核验');
  assert.ok(s.events.some(row => /产物引用写的是目录/.test(String(row[2] || ''))), '展开目录要留痕');
  assert.ok(s.calls.some(call => /系统临时目录/.test(call.prompt || '')), '执行提示词要提醒临时文件不要写到范围外');
});

test('执行审计：并行任务也留下逐任务动作记录（OpenHands 内核）', async () => {
  const s = setup(async ({ run, options }) => {
    if (options.role === 'execute') {
      const result = output(run, 'audit-task.txt', 'done');
      return { ...result, nativeToolEvidence: { source: 'fixture', trace: { status: 'complete' }, sideEffects: 'file-write',
        calls: [{ tool: 'file_write', status: 'completed', record: { input: { file_path: path.join(run.cwd, 'audit-task.txt') } } }] } };
    }
    return pass;
  }, ['codex', 'deepseek']);
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('audit', { files: ['audit-task.txt'] })] }, AbortSignal.timeout(8000));
  assert.equal(result.verdict.verdict, 'pass', JSON.stringify(result.verdict));
  const audit = s.store.get('executionAudit:fixture-run:audit');
  assert.ok(audit, '并行任务必须写 executionAudit');
  assert.equal(audit.count, 1);
  assert.equal(audit.events[0].tool, 'file_write');
  assert.ok(s.store.get('guardrails:fixture-run:audit'), '并行任务也要写执行/输出护栏');
});

// ───────────── 2026-10-24 代码审查回归：defer 保护 / 执行循环意外中断收尾 ─────────────

test('CONTROL_BUDGET_BUSY 退回队列时 defer 抛错不再击穿整轮：本任务隔离，其他任务照常通过', async () => {
  // 审查发现：queue.defer 内部走 #assertLease，租约过期抛 LeaseLostError 时没有像
  // deferNativeBusy 那样包保护，异常会击穿 perform → Promise.race → 整轮 runQueuedTasks。
  const s = setup(async ({ run, options, limits }) => {
    if (options.role === 'execute' && limits.taskId === 't1') {
      const q = s.store.queue;
      q.defer = () => { throw Object.assign(new Error('任务 t1 的租约已过期，拒绝写入'), { name: 'LeaseLostError', code: 'LEASE_LOST' }); };
      throw Object.assign(new Error('其他调用正在使用预留额度，本任务尚未派发'), { code: 'CONTROL_BUDGET_BUSY', notDispatched: true });
    }
    if (options.role === 'execute') return output(run, limits.taskId + '.txt');
    return pass;
  }, ['codex', 'deepseek'], { tokenBudgetEnforced: false, difficultyRouting: false });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('t1'), task('t2')], acceptance: ['组合结果正确'] }, AbortSignal.timeout(5000));
  const states = Object.fromEntries(result.queue.map(item => [item.id, item.state]));
  assert.equal(states.t1, 'blocked', 'defer 失败必须按未知副作用保守隔离，不能丢弃也不能谎报');
  assert.equal(states.t2, 'passed', 't1 的异常不得影响 t2 执行');
  assert.equal(result.verdict.verdict, 'fail');
});

test('执行循环意外中断时等在飞执行者落地、收摊本进程孤儿，按现状如实收尾而不标死整轮', async () => {
  // 审查发现：perform 的意外异常沿 Promise.race 逃出 runQueuedTasks（外层只有 try/finally），
  // 整条 run 被 launch 标成 error，其他在飞任务被中途抛弃，孤儿 running 行永久占用文件锁。
  let failThrew = false;
  const s = setup(async ({ run, options, limits }) => {
    if (options.role === 'execute' && limits.taskId === 't1') {
      const q = s.store.queue;
      if (!q.orphanPatch) {
        q.orphanPatch = true;
        const originalFail = q.fail.bind(q);
        q.fail = (id, token, issues, opts = {}) => {
          if (id === 't1' && !failThrew) { failThrew = true; throw Object.assign(new Error('注入的写回失败'), { code: 'QUEUE_CONTRACT' }); }
          return originalFail(id, token, issues, opts);
        };
        // FixtureQueue 模拟真实 TaskQueue 的孤儿收摊语义（仅本测试实例）
        q.reclaimOrphans = ({ reason }) => {
          const swept = [];
          for (const item of q.items) if (item.state === 'running') { item.state = 'blocked'; item.quarantineReason = 'orphan-loop-exited'; item.issues = [`执行循环已退出：${reason}`]; swept.push(item.id); }
          return swept;
        };
      }
      throw new Error('执行者崩溃');
    }
    if (options.role === 'execute') return output(run, limits.taskId + '.txt');
    return pass;
  }, ['codex', 'deepseek'], { tokenBudgetEnforced: false, difficultyRouting: false });
  const result = await runQueuedTasks(s.orch, s.run, { tasks: [task('t1'), task('t2')], acceptance: ['组合结果正确'] }, AbortSignal.timeout(8000));
  const states = Object.fromEntries(result.queue.map(item => [item.id, item.state]));
  assert.equal(states.t2, 'passed', '在飞执行者必须先落地，t2 才能通过');
  assert.equal(states.t1, 'blocked', '中断时仍停在 running 的孤儿要被收摊，不能悬着占文件锁');
  assert.equal(result.verdict.verdict, 'fail');
  assert.ok(result.verdict.issues.some(issue => issue.includes('执行循环意外中断')), '中断原因必须如实写进 issues');
  assert.ok(s.events.some(([, , message]) => message.includes('执行循环意外中断')), '时间线要留中断事件');
});
