import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator, askRepeatError } from '../src/orchestrator.mjs';
import { requestedFiles, requestedLiteralBlock, captureNativeFiles } from '../src/quick-work.mjs';
import { machineVerifiedDelivery } from '../src/delivery-verification.mjs';
import { customerIssue } from '../src/customer-issue.mjs';
import { fileOutlineVocabulary, mergeOutlines } from '../src/compact-discussion.mjs';
import { artifactsRoot } from './helpers/temp.mjs';
import { literalFileScope } from '../src/literal-files.mjs';
import { newFilePreflight } from '../src/new-file-preflight.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function finished(orch, id) {
  for (let i = 0; i < 500; i++) {
    const run = orch.store.run(id);
    if (orch.isFinal(run.state) && !orch.active.has(id)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('test task did not finish');
}
function fixture(t, { validReview = true, content = '这是实际生成的通知内容。' } = {}) {
  const root = fs.mkdtempSync(path.join(artifactsRoot(), 'buyer15-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 'fixture' } };
  config.codex.defaultModel = 'codex-fixture'; config.deepseek.defaultModel = 'deepseek-fixture';
  fs.mkdirSync(config.workspace, { recursive: true });
  const file = path.join(config.workspace, '通知_A7.txt');
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  const counts = { writes: 0, questions: 0, reviews: 0 }; let valid = validReview;
  const agents = {
    deepseek: async options => {
      const base = { nativeId: options.nativeId || 'fixed-executor', actualModel: options.model, modelVerified: 'verified' };
      if (options.access === 'read-only') { counts.questions++; return { ...base, text: '模型声称已经核验成功。' }; }
      counts.writes++; fs.writeFileSync(file, content);
      return { ...base, text: '已完成', nativeToolEvidence: { trace: { status: 'complete' }, calls: [
        { tool: 'write', status: 'completed', record: { type: 'tool_call', input: { file_path: file } }, result: { type: 'tool_result', status: 'completed', result: 'Created file' } },
        { tool: 'read', status: 'completed', record: { type: 'tool_call', input: { file_path: file } }, result: { type: 'tool_result', status: 'completed', result: content } },
      ] } };
    },
    codex: async options => {
      counts.reviews++;
      const contract = store.get('goalContract:' + store.runs(1)[0].id), bytes = fs.readFileSync(file);
      return { nativeId: options.nativeId || 'fixed-reviewer', text: JSON.stringify({ pass: true, issues: [], goalHash: contract.goalHash,
        goalChecks: { object: 'verified', deliverables: 'verified', prohibitions: 'verified' },
        readbacks: valid ? [{ path: file, sha256: sha(bytes), quote: bytes.toString('utf8') }] : [] }) };
    },
  };
  return { config, store, file, counts, orch: new Orchestrator({ config, store, agents }), allowReview: () => { valid = true; } };
}

test('corner-quoted filename targets the real name, and multiline literal delivery is byte-checked without an extra model', async t => {
  const content = '这是第一行。\n验收口令：A7-20261019';
  const f = fixture(t, { content });
  for (const [left,right] of [['「','」'],['『','』'],['“','”']]) {
    assert.deepEqual(requestedFiles(`在桌面新建一个叫${left}通知_A7.txt${right}的文件`), ['通知_a7.txt']);
  }
  const question = `在当前目录新建「通知_A7.txt」，内容严格为以下两行：\n${content}\n不要覆盖已有文件。`;
  assert.equal(requestedLiteralBlock(question), content);
  const run = f.orch.startAsk({ to: 'deepseek', question });
  assert.equal((await finished(f.orch, run.id)).state, 'passed');
  const view = f.orch.view(run.id);
  assert.equal(view.deliveryVerification.machine, true);
  assert.equal(view.quickWorkEvidence.ok, true);
  assert.equal(view.quickWorkEvidence.verificationOnly, false);
  assert.equal(view.customer.artifacts.length, 1);
  assert.equal(view.customer.artifacts[0].verified, true);
  assert.equal(view.triage.evidence.unknownSideEffects, false);
  assert.equal(f.counts.reviews, 0);
  // A wrong second line cannot use the machine path, nor may an extra blank line.
  const evidence = view.quickWorkEvidence.evidence;
  for (const bad of [content.replace('A7-', 'WRONG-'), content + '\n\n']) {
    fs.writeFileSync(f.file, bad);
    const check = machineVerifiedDelivery({ goal: question, cwd: f.config.workspace, scope: ['通知_A7.txt'], artifacts: [{ path: f.file, sha256: sha(bad) }], evidence });
    assert.equal(check.eligible, false);
  }
});

test('a failed file can be verified by natural-language followup; original writes are not replayed and delivery remains visible', async t => {
  const f = fixture(t, { validReview: false });
  const run = f.orch.startAsk({ to: 'deepseek', question: '新建「通知_A7.txt」，根据本次需求编写一份简短通知并保存。' });
  assert.equal((await finished(f.orch, run.id)).state, 'failed');
  const before = fs.readFileSync(f.file), original = f.store.steps(run.id)[0].data.nativeToolEvidence;
  assert.doesNotMatch(f.orch.view(run.id).result, /\n\n已完成/);
  f.orch.resume(run.id);
  assert.equal((await finished(f.orch, run.id)).state, 'failed');
  assert.doesNotMatch(f.orch.view(run.id).result, /已完成/, '继续核验未过时也不能引用执行者成功自述');
  f.allowReview();
  f.orch.startFollowup({ id: run.id, question: '继续只读核验刚才生成的文件，不重新写入。', access: 'read-only' });
  assert.equal((await finished(f.orch, run.id)).state, 'passed');
  const view = f.orch.view(run.id);
  assert.equal(f.counts.writes, 1); assert.equal(f.counts.questions, 0);
  assert.equal(view.deliveryVerification.pass, true); assert.equal(view.quickWorkEvidence.ok, true);
  assert.equal(view.quickWorkEvidence.verificationOnly, false);
  assert.equal(view.customer.artifacts.length, 1); assert.equal(view.customer.artifacts[0].verified, true);
  assert.equal(view.triage.evidence.unknownSideEffects, false);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(f.store.steps(run.id)[0].data.nativeToolEvidence, original);
  f.orch.startFollowup({ id: run.id, question: '文件放在哪里？', access: 'read-only' });
  assert.equal((await finished(f.orch, run.id)).state, 'passed');
  assert.equal(f.orch.view(run.id).customer.artifacts.length, 1);
});

test('an explanatory answer or a true unknown input cannot approve a failed delivery', async t => {
  const f = fixture(t, { validReview: false });
  const run = f.orch.startAsk({ to: 'deepseek', question: '新建「通知_A7.txt」，根据本次需求编写简短通知。' });
  await finished(f.orch, run.id);
  f.orch.startFollowup({ id: run.id, question: '为什么没有通过？', access: 'read-only' });
  assert.equal((await finished(f.orch, run.id)).state, 'failed');
  assert.equal(f.orch.view(run.id).deliveryVerification.pass, false);
  // An actual unknown operation in the retained raw trace is never laundered.
  const step = f.store.steps(run.id).find(s => s.data?.nativeToolEvidence);
  const raw = { ...step.data.nativeToolEvidence, sideEffects: 'unknown' };
  f.store.updateStep(step.id, { data: { ...step.data, nativeToolEvidence: raw } });
  const saved = f.store.get('quickWorkEvidence:' + run.id);
  f.store.set('quickWorkEvidence:' + run.id, { ...saved, evidence: raw });
  f.allowReview();
  f.orch.startFollowup({ id: run.id, question: '请继续核验文件。', access: 'read-only' });
  assert.equal((await finished(f.orch, run.id)).state, 'failed');
  assert.equal(f.orch.view(run.id).triage.evidence.unknownSideEffects, true);
  assert.equal(f.counts.writes, 1); assert.equal(f.counts.reviews, 1);
});

test('known file delivery containing a native hash command can resume read-only verification without replaying the command', async t => {
  const f = fixture(t, { validReview: false });
  const native = f.orch.agents.deepseek;
  f.orch.agents.deepseek = async options => {
    const result = await native(options);
    if (result.nativeToolEvidence) result.nativeToolEvidence.calls.push({ tool: 'pwsh', status: 'completed', record: { command: 'Get-FileHash -LiteralPath 通知_A7.txt' } });
    return result;
  };
  const run = f.orch.startAsk({ to: 'deepseek', question: '新建「通知_A7.txt」，根据需求编写简短通知。' });
  assert.equal((await finished(f.orch, run.id)).state, 'failed');
  assert.equal(f.store.get('quickWorkEvidence:' + run.id).verificationOnly, true);
  f.allowReview();
  f.orch.startFollowup({ id: run.id, question: '只读复核已有文件。', access: 'read-only' });
  assert.equal((await finished(f.orch, run.id)).state, 'passed');
  assert.equal(f.counts.writes, 1); assert.equal(f.counts.questions, 0);
  assert.equal(f.orch.view(run.id).customer.artifacts[0].verified, true);
});

test('final delivery filters exactly controller checkpoints, retaining real extra files and same-named customer files', t => {
  const f = fixture(t);
  const run = f.store.createRun({ kind: 'parallel', cwd: f.config.workspace, goal: '交付文件', initiator: 'codex' });
  const customer = path.join(run.cwd, 'checkpoint.json'), extra = path.join(run.cwd, 'extra.txt');
  const internal = path.join(run.cwd, '.beat-control', run.id, 'task-1', 'checkpoint.json');
  const plan = { tasks: [{ id: 'task-1', files: ['checkpoint.json'] }] };
  f.store.updateRun(run.id, { plan });
  const reports = [{ taskId: 'task-1', summary: '完成', artifacts: [{ path: customer }, { path: internal }, { path: extra }] }];
  f.orch.finishParallel(run.id, 'passed', { verdict: 'pass', summary: '完成', issues: [] }, reports);
  const result = f.store.run(run.id).result;
  assert.ok(result.includes(customer)); assert.ok(result.includes(extra)); assert.ok(!result.includes(internal));
  assert.equal(reports[0].artifacts.length, 3, 'raw evidence must not be mutated');
});

test('duplicate rejection separates this zero-dispatch request from prior usage, and keeps actionable guidance', () => {
  const raw = askRepeatError('算账', 'codex', [{ id: 'R100' }], { tokenText: '累计消耗42338 token' });
  for (const error of [raw, raw.message]) {
    const issue = customerIssue(error);
    assert.match(issue.title, /重复/); assert.match(issue.message, /R100/); assert.match(issue.message, /原任务/);
    assert.match(issue.fileStatus, /没有派发/); assert.match(issue.costStatus, /没有新增模型费用/);
    assert.doesNotMatch(JSON.stringify(issue), /费用尚未取得|修改文件尚未核实|累计消耗|allowRepeat/);
  }
  assert.match(customerIssue('to 只能是 codex / deepseek / claude', { beforeDispatch: true }).message, /搭档列表/);
});

test('shared outline vocabulary leaves votes and serious objections authoritative', () => {
  assert.deepEqual(literalFileScope('新建a.txt和b.csv，内容给定，将两个文件分给不同执行搭档', process.cwd()), [], '用户明确要求不同搭档时不能走单人快路径');
  assert.match(fileOutlineVocabulary('新建a.txt和b.csv，内容已给定'), /本人同意/);
  assert.match(fileOutlineVocabulary('新建a.txt和b.csv，内容已给定'), /共享父目录不等于数据依赖/);
  assert.equal(fileOutlineVocabulary('讨论系统架构'), '');
  const outlines = ['a','b'].map(seat => ({ seat, by: seat, value: { decisions: [{ id: 'risk', option: '保留已有文件', reason: '防止覆盖', serious: seat === 'b', category: 'safety' }] } }));
  const result = mergeOutlines(outlines, ['a','b']);
  assert.equal(result.locked.risk, undefined); assert.equal(result.disputes.length > 0, true);
});

test('shared new-file preflight sees a prior conflict before any executor starts, without rewriting or deleting it', async t => {
  const f = fixture(t), existing = path.join(f.config.workspace, 'existing.txt');
  fs.writeFileSync(existing, 'keep original');
  const plan = { tasks: [
    { id: 'a', owner: 'codex', type: 'workspace', files: ['fresh.txt'], acceptance: ['完整内容'] },
    { id: 'b', owner: 'deepseek', type: 'workspace', files: ['existing.txt'], acceptance: ['完整内容'] },
  ], acceptance: ['两个文件不覆盖旧文件'] };
  const run = f.store.createRun({ kind: 'parallel', goal: '创建两个文件，分给不同执行搭档，不覆盖，已有同名文件则停止。', cwd: f.config.workspace, initiator: 'codex' });
  const preflight = newFilePreflight(run, plan);
  assert.equal(preflight.pass, false); assert.equal(preflight.files.filter(x => x.existedBefore).length, 1);
  f.config.flow.fastPath = false; f.orch.negotiate = async () => ({ consensus: true, plan });
  await f.orch.runParallel(run.id, new AbortController().signal);
  assert.equal(f.store.run(run.id).state, 'failed');
  assert.equal(f.counts.writes + f.counts.reviews, 0);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep original');
  assert.equal(fs.existsSync(path.join(f.config.workspace, 'fresh.txt')), false);
  assert.equal(f.orch.view(run.id).newFilePreflight.pass, false);
  assert.equal(f.orch.view(run.id).workflow.resumable, false);
  assert.match(f.orch.view(run.id).customerIssue.message, /不同名称/);
  f.orch.resume(run.id);
  assert.equal((await finished(f.orch, run.id)).state, 'failed');
  assert.equal(f.counts.writes, 0, '直接调用继续接口不能绕过同名冲突保护');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep original');
  const mixed = { ...run, goal: '新建fresh.txt并修改existing.txt，不覆盖其他文件。' };
  assert.equal(newFilePreflight(mixed, plan), null, '混合修改任务不能误用纯新建预检');
});
