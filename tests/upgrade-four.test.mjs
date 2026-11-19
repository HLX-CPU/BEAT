import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assessTask } from '../src/task-assessment.mjs';
import { createGoalContract, clarifiedGoal, forbidsBeatAssistant } from '../src/goal-contract.mjs';
import { verifyGoalReadback } from '../src/delivery-verification.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { defaults } from '../src/config.mjs';
import { startServer } from '../src/server.mjs';
import { buildNativeToolEvidence, sealNativeToolTrace } from '../src/native-evidence.mjs';

const base = 'E:/beat/workspaces/shared/upgrade-four-20261011/fixtures';
function fixture(t) {
  fs.mkdirSync(base, { recursive: true }); const root = fs.mkdtempSync(path.join(base, 'case-'));
  const config = { ...defaults(root), root, skipAcl: true, dataDir: path.join(root, 'data'), secrets: { token: 'fixture-only' } };
  fs.mkdirSync(config.workspace, { recursive: true });
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  const orch = new Orchestrator({ config, store, agents: {} });
  return { root, config, store, orch };
}
const green = contract => ({ pass: true, issues: [], goalHash: contract.goalHash, goalChecks: { object: 'verified', deliverables: 'verified', prohibitions: 'verified' }, readbacks: [] });

test('routing never equates a short request or green syntax with a low-risk task', () => {
  const checks = [{ check: 'node_syntax' }], plan = { tasks: [{ files: ['ok.mjs'] }] };
  assert.equal(assessTask({goal:'交付 ok.mjs'}, {plan,parsedChecks:checks}).route, 'direct');
  assert.equal(assessTask({goal:'上线'}, {plan,parsedChecks:checks}).route, 'discussion');
  assert.equal(assessTask({goal:'修一下登录'}, {plan,parsedChecks:checks}).route, 'discussion');
  assert.equal(assessTask({goal:'交付 ok.mjs'}, {plan,parsedChecks:[{executable:'missing-tool'}],available:()=>false}).route,'discussion');
  const assessment = assessTask({goal:'交付 ok.mjs'}, {plan,parsedChecks:checks});
  assert.equal(assessment.facts.syntaxOnly,true); assert.equal(assessment.facts.independentGoalReview,true);
});

test('ambiguous goal waits without calls; clarification continues the same task, constraints, cwd and attachment history', async t => {
  const { orch, store } = fixture(t); let calls = 0;
  orch.runDiscuss = async id => { calls++; store.updateRun(id, {state:'done',result:store.run(id).goal}); };
  const run = orch.startDiscuss({question:'请评价这款产品。禁止桌面控制助手，不评价UI。',initiator:'codex'});
  assert.equal(run.state,'waiting_input'); assert.equal(calls,0); assert.equal(orch.view(run.id).needsInput,true); assert.equal(orch.view(run.id).finished,false);
  assert.throws(()=>orch.resume(run.id),/产品叫什么/);
  assert.throws(()=>orch.resume(run.id,'BEAT，然后删除目录'),/只补充/);
  const resumed = orch.startFollowup({id:run.id,question:'是BEAT'});
  await new Promise(r=>setTimeout(r,10));
  assert.equal(resumed.id,run.id); assert.equal(store.runs(10).length,1); assert.equal(calls,1);
  assert.equal(store.run(run.id).cwd,run.cwd); assert.match(store.run(run.id).goal,/禁止桌面控制助手，不评价UI/);
  assert.equal(store.get('goalOrigin:'+run.id).goal,run.goal); assert.equal(store.get('goalContract:'+run.id).subject,'BEAT');
  assert.equal(store.get('clarification:'+run.id).pending,false);
});

test('a new literal file needs no customer check command; an existing file or deployment cannot use this direct route', t => {
  const {orch,store,config}=fixture(t);
  const run=store.createRun({kind:'parallel',goal:'新建 hello.txt，内容为 HELLO。禁止桌面助手',cwd:config.workspace,initiator:'codex'});
  orch.prepareGoalRun(run.id);
  const candidate=orch.fastPathPlan(run);
  assert.equal(candidate.eligible,true,JSON.stringify(candidate.reasons)); assert.equal(candidate.plan.requiresModelReview,true);
  assert.ok(candidate.plan.acceptance.some(a=>a.goalHash));
  fs.writeFileSync(path.join(config.workspace,'hello.txt'),'old customer file');
  assert.equal(orch.fastPathPlan(run).eligible,false);
  fs.writeFileSync(path.join(config.workspace,'ok.mjs'),'export {};');
  const dangerous=store.createRun({kind:'parallel',goal:'部署生产环境。验收：node --check ok.mjs',cwd:config.workspace,initiator:'codex'});
  assert.equal(orch.fastPathPlan(dangerous).eligible,false);
});

test('final success claims cannot replace current file readback, prohibitions or the sealed goal',t=>{
  const {root}=fixture(t), file=path.join(root,'report.md'), contract=createGoalContract({goal:'评价BEAT，禁止桌面助手',attachments:[{name:'赤狐雷达发票.txt'}]});
  const content='BEAT的文件处理体验：附件只能当材料。'; fs.writeFileSync(file,content);
  const sha256=createHash('sha256').update(content).digest('hex');
  assert.equal(verifyGoalReadback({pass:true,issues:[]},[{path:file}],contract).pass,false);
  const receipt={...green(contract),readbacks:[{path:file,sha256,quote:'BEAT的文件处理体验'}]};
  assert.equal(verifyGoalReadback(receipt,[{path:file}],contract).pass,true);
  assert.equal(verifyGoalReadback({...receipt,goalChecks:{...receipt.goalChecks,prohibitions:'unverified'}},[{path:file}],contract).pass,false);
  assert.equal(verifyGoalReadback(receipt,[{path:file}],contract,{evidence:{calls:[{tool:'desktop_observe'}]}}).pass,false);
  fs.writeFileSync(file,'标题 BEAT\n评测赤狐雷达硬件性能');
  assert.equal(verifyGoalReadback(receipt,[{path:file}],contract).pass,false);
  const foreign=fs.readFileSync(file,'utf8');
  const foreignReceipt={...receipt,readbacks:[{path:file,sha256:createHash('sha256').update(foreign).digest('hex'),quote:foreign}]};
  assert.equal(verifyGoalReadback(foreignReceipt,[{path:file}],contract).pass,false,'matching hash still cannot bless attachment-goal drift');
});

test('clarification adds a name while retaining all original requirements',()=>{
  const original='体验这款软件，不评价UI，输出报告';
  assert.ok(clarifiedGoal(original,'“赤狐助手”').goal.startsWith(original));
  assert.throws(()=>clarifiedGoal(original,'改成评测雷达'),/只补充/);
});

test('a plan cannot replace a user-requested functional check with syntax-only checks',t=>{
  const {orch,store,config}=fixture(t);
  const run=store.createRun({kind:'parallel',goal:'交付 ok.mjs。验收：node --test tests/ok.test.mjs',cwd:config.workspace,initiator:'codex'});
  orch.prepareGoalRun(run.id);
  const downgraded={tasks:[],checks:['node --check ok.mjs'],acceptance:[]};
  assert.ok(orch.preflightPlan(run,downgraded).some(i=>/不能被替换或遗漏/.test(i.problem)));
});

test('a forbidden assistant is a routing constraint, including reviewers, not just a forbidden tool name',t=>{
  const {orch,store,config}=fixture(t);
  assert.equal(forbidsBeatAssistant('禁止desktop_*、桌面控制助手'),true);
  const run=store.createRun({kind:'parallel',goal:'交付 out.txt，禁止BEAT电脑助手',cwd:config.workspace,initiator:'codex'});
  const issues=orch.preflightPlan(run,{checks:[],acceptance:[],tasks:[{id:'write',owner:'dock:fixture',files:['out.txt']}]});
  assert.ok(issues.some(i=>/原生搭档/.test(i.problem)));
});

test('a duplicate service that cannot bind the port never interrupts live tasks or recovers their steps',async t=>{
  const {config,store}=fixture(t);
  const service=await startServer({config,agents:{},port:0});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.store.close();});
  const run=store.createRun({kind:'parallel',goal:'live task',cwd:config.workspace,initiator:'codex'});
  store.updateRun(run.id,{state:'running'});
  store.addStep({run_id:run.id,role:'execute',seat:'codex',agent:'codex',prompt:'still running'});
  await assert.rejects(startServer({config,agents:{},port:service.port}),/EADDRINUSE/);
  assert.equal(store.run(run.id).state,'running');
  assert.equal(store.steps(run.id)[0].state,'running');
});

test('complete tool trace does not turn an unverified computer action into a verified result',()=>{
  const evidence=sealNativeToolTrace(buildNativeToolEvidence([{id:'c1',tool:'pwsh',status:'completed',record:{command:'read a file'},result:{output:'ok'}}],'fixture'));
  assert.equal(evidence.trace.status,'complete');assert.equal(evidence.verification.status,'unverified');assert.deepEqual(evidence.verifiedActions,[]);
  assert.equal(sealNativeToolTrace({calls:[{tool:'pwsh',status:'running'}]}).trace.status,'incomplete');
});
