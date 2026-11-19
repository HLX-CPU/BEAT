import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { captureExecutionCandidate, selectBestExecutionCandidate } from '../src/advisor-execution-selection.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

function fixture(t) {
  // 测试工作区放系统临时目录：以前写 workspaces/advisor-execution-selection-tests（产品目录里），
  // 每跑一次留一批 fixture.sqlite——提取纯净版时实测把副本弄脏 39 个目录。
  const cwd = path.join(artifactsRoot(), 'advisor-execution-selection-tests', randomUUID());
  fs.mkdirSync(cwd, { recursive: true });
  const store = new Store(path.join(cwd, 'fixture.sqlite'));
  t.after(() => store.close());
  const run = { id: 'R-fixture', cwd }, task = { id: 'draw', title: '交付页面', attempts: 1, files: ['page.html'], checks: ['node --check page.html'], acceptance: ['页面有完整说明'], tokenBudget: 12000 };
  const artifactRoot = path.join(cwd, '.beat-control', run.id);
  const file = path.join(cwd, 'page.html');
  const capture = (attempt = 1, content = 'first output', changes = {}) => {
    task.attempts = attempt; fs.writeFileSync(file, content);
    const report = { taskId: task.id, executor: 'codex', reportPath: path.join(artifactRoot, task.id, `report-${attempt}.json`),
      checks: [{ command: task.checks[0], ok: true, exitCode: 0 }], artifacts: [{ path: file }], ...changes.report };
    const verification = { kind: 'semantic', pass: false, reviewer: 'deepseek', issues: [`缺少验收说明 ${attempt}`], ...changes.verification };
    return captureExecutionCandidate({ store, run, task, report, artifactRoot, verification });
  };
  const choose = (candidate, extra = {}) => ({ by: 'claude', text: JSON.stringify({ candidateId: candidate.candidateId, candidateHash: candidate.candidateHash, reason: '第一份更接近目标', fixes: ['补上验收说明'], ...extra }) });
  return { cwd, store, run, task, artifactRoot, file, capture, choose, orch: { store } };
}

test('two real snapshots survive same-path replacement and selection remains guidance', async t => {
  const f = fixture(t), first = f.capture(1, 'first candidate'), second = f.capture(2, 'second candidate');
  assert.equal(first.status, 'captured'); assert.equal(second.status, 'captured');
  assert.equal(fs.readFileSync(first.candidate.artifacts[0].snapshotPath, 'utf8'), 'first candidate');
  let calls = 0;
  const result = await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: async (seat, options, limits) => {
    calls++; assert.equal(seat, 'claude'); assert.equal(options.call, 'think'); assert.equal(options.role, 'consult'); assert.equal(options.onlyAgent, true);
    assert.equal(limits.phase, 'execution'); assert.equal(limits.taskId, f.task.id); assert.equal(limits.budget, 12000);
    assert.match(options.build(), /first candidate/); assert.match(options.build(), /second candidate/);
    return f.choose(first.candidate);
  } });
  assert.equal(result.status, 'selected'); assert.equal(result.selection.candidateId, first.candidate.candidateId);
  assert.equal(result.selection.pass, undefined); assert.equal(fs.readFileSync(f.file, 'utf8'), 'second candidate');
  const resumed = await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: () => { throw new Error('should not call again'); } });
  assert.equal(resumed.status, 'selected'); assert.equal(calls, 1);
});

test('one failed semantic evaluation never dispatches advisor', async t => {
  const f = fixture(t); f.capture();
  assert.equal((await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: () => { throw new Error('unexpected call'); } })).status, 'not-needed');
});

test('duplicate same-attempt evaluation cannot become a second candidate', async t => {
  const f = fixture(t), first = f.capture();
  assert.equal(f.capture(1, 'changed after evaluation').status, 'existing');
  assert.equal(fs.readFileSync(first.candidate.artifacts[0].snapshotPath, 'utf8'), 'first output');
  assert.equal((await selectBestExecutionCandidate(f.orch, f.run, f.task)).status, 'not-needed');
});

test('non-independent, global, unverified, serious and failed-code reviews are excluded', t => {
  for (const changes of [
    { verification: { reviewer: 'codex' } }, { verification: { kind: 'global' } }, { verification: { pass: true } },
    { verification: { issues: [] } }, { verification: { serious: true } },
    { report: { unknownSideEffects: true } }, { report: { desktopEvidence: { calls: [{ evidence: { sideEffects: 'unknown' } }] } } },
    { report: { checks: [{ command: 'node --check page.html', ok: false, notDispatched: true }] } },
    { report: { checks: [{ command: 'node --check page.html', ok: false, exitCode: 1 }] } },
    { report: { checks: [] } }, { report: { taskId: 'other' } },
  ]) {
    const f = fixture(t); assert.equal(f.capture(1, 'output', changes).status, 'ineligible');
  }
});

test('snapshot content tampering blocks selection before advisor dispatch', async t => {
  const f = fixture(t), first = f.capture(); f.capture(2);
  fs.writeFileSync(first.candidate.artifacts[0].snapshotPath, 'tampered');
  const result = await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: () => { throw new Error('unexpected'); } });
  assert.equal(result.status, 'waiting'); assert.match(result.issues.join(), /快照/);
});

test('report snapshot tampering blocks selection before advisor dispatch', async t => {
  const f = fixture(t), first = f.capture(); f.capture(2);
  fs.writeFileSync(first.candidate.reportSnapshotPath, '{}');
  assert.equal((await selectBestExecutionCandidate(f.orch, f.run, f.task)).status, 'waiting');
});

test('tampering during consultant call is rejected after response', async t => {
  const f = fixture(t), first = f.capture(); f.capture(2);
  const result = await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: async () => {
    fs.writeFileSync(first.candidate.artifacts[0].snapshotPath, 'tampered during call'); return f.choose(first.candidate);
  } });
  assert.equal(result.status, 'waiting');
});

test('provider failure persists one selection identity and can only retry explicitly', async t => {
  const f = fixture(t), first = f.capture(); f.capture(2); const slots = [];
  const failed = await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: async (_seat, options) => { slots.push(options.slot); throw new Error('provider unreachable'); } });
  assert.equal(failed.status, 'waiting'); assert.match(failed.issues.join(), /provider unreachable/);
  assert.equal((await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: () => { throw new Error('no repeat'); } })).status, 'waiting');
  const recovered = await selectBestExecutionCandidate(f.orch, f.run, f.task, { retry: true, call: async (_seat, options) => { slots.push(options.slot); return f.choose(first.candidate); } });
  assert.equal(recovered.status, 'selected'); assert.equal(slots[0], slots[1]);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'first output');
});

test('persisted pending selection prevents concurrent duplicate dispatch', async t => {
  const f = fixture(t), first = f.capture(); f.capture(2);
  let resolveCall; const pending = new Promise(resolve => { resolveCall = resolve; });
  const firstCall = selectBestExecutionCandidate(f.orch, f.run, f.task, { call: () => pending });
  const duplicate = await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: () => { throw new Error('duplicate'); } });
  assert.equal(duplicate.status, 'waiting'); resolveCall(f.choose(first.candidate));
  assert.equal((await firstCall).status, 'selected');
});

test('truncated JSON, old proceed-only answer and wrong candidate proof stay unverified', async t => {
  for (const answer of [
    { by: 'claude', text: '{"candidateId":"draw:attempt-1"' },
    { by: 'claude', text: '{"proceed":true,"reason":"looks fine"}' },
    { by: 'codex', text: '{}' },
  ]) {
    const f = fixture(t); f.capture(); f.capture(2);
    assert.equal((await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: async () => answer })).status, 'waiting');
  }
  const f = fixture(t), first = f.capture(); f.capture(2);
  assert.equal((await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: async () => f.choose(first.candidate, { candidateHash: 'wrong' }) })).status, 'waiting');
});

test('path escapes and files outside task scope never become candidates', t => {
  const f = fixture(t); const outside = path.join(f.cwd, 'other.txt'); fs.writeFileSync(outside, 'other task');
  assert.equal(f.capture(1, 'output', { report: { artifacts: [{ path: outside }] } }).status, 'ineligible');
  assert.equal(f.capture(1, 'output', { report: { artifacts: [{ path: '../outside.html' }] } }).status, 'ineligible');
});

test('cancellation never dispatches a new selection', async t => {
  const f = fixture(t); f.capture(); f.capture(2); const abort = new AbortController(); abort.abort();
  assert.equal((await selectBestExecutionCandidate(f.orch, f.run, f.task, { signal: abort.signal, call: () => { throw new Error('unexpected'); } })).status, 'waiting');
});

test('binary or oversized complete snapshots cannot be silently truncated for consultant', async t => {
  const f = fixture(t); f.capture(1, Buffer.from([0, 1, 2])); f.capture(2, 'text');
  assert.equal((await selectBestExecutionCandidate(f.orch, f.run, f.task)).status, 'waiting');
  const large = fixture(t); large.capture(1, 'x'.repeat(125000)); large.capture(2);
  assert.equal((await selectBestExecutionCandidate(large.orch, large.run, large.task)).status, 'waiting');
});

test('selected snapshot tampering after resume is never accepted from cached choice', async t => {
  const f = fixture(t), first = f.capture(); f.capture(2);
  assert.equal((await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: async () => f.choose(first.candidate) })).status, 'selected');
  fs.writeFileSync(first.candidate.artifacts[0].snapshotPath, 'post-selection tamper');
  assert.equal((await selectBestExecutionCandidate(f.orch, f.run, f.task)).status, 'waiting');
});

test('goal, acceptance and file-scope changes cannot reuse old candidates', async t => {
  for (const mutate of [f => { f.run.goal = 'new customer request'; }, f => { f.task.acceptance.push('新增明确验收'); }, f => { f.task.files = ['other.html']; }]) {
    const f = fixture(t); f.run.goal = 'original'; f.capture(); f.capture(2); mutate(f);
    const result = await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: () => { throw new Error('old baseline'); } });
    assert.equal(result.status, 'waiting'); assert.match(result.issues.join(), /变更/);
  }
});

test('framework checkpoint is retained as report evidence but is not a user candidate artifact', t => {
  const f = fixture(t), checkpoint = path.join(f.artifactRoot, f.task.id, 'checkpoint.json');
  fs.mkdirSync(path.dirname(checkpoint), { recursive: true }); fs.writeFileSync(checkpoint, '{"completed":["file"]}');
  const result = f.capture(1, 'actual customer output', { report: { artifacts: [{ path: f.file }, { path: checkpoint }] } });
  assert.equal(result.status, 'captured'); assert.equal(result.candidate.artifacts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(result.candidate.reportSnapshotPath, 'utf8')).artifacts.length, 2);
});

test('glob scopes follow runner matching and snapshot paths remain bounded', t => {
  const f = fixture(t); f.task.files = ['*.html'];
  assert.equal(f.capture().status, 'captured');
  const nested = path.join(f.cwd, 'nested', 'page.html'); fs.mkdirSync(path.dirname(nested)); fs.writeFileSync(nested, 'nested');
  assert.equal(f.capture(2, 'root', { report: { artifacts: [{ path: nested }] } }).status, 'ineligible');
  f.task.files = ['nested/**'];
  assert.equal(f.capture(3, 'root', { report: { artifacts: [{ path: nested }] } }).status, 'captured');
});

test('two legitimate semantic failures without comparable snapshots wait instead of repeated execution', async t => {
  const f = fixture(t);
  assert.equal(f.capture(1, 'output', { report: { artifacts: [] } }).status, 'ineligible');
  assert.equal((await selectBestExecutionCandidate(f.orch, f.run, f.task)).status, 'not-needed');
  assert.equal(f.capture(2, 'output', { report: { artifacts: [] } }).status, 'ineligible');
  const result = await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: () => { throw new Error('no evidence'); } });
  assert.equal(result.status, 'waiting'); assert.match(result.issues.join(), /两次/);
});

test('provider and invalid-answer usage is retained when selection fails', async t => {
  for (const call of [
    async () => { throw Object.assign(new Error('provider failed'), { usage: { totalTokens: 33 } }); },
    async () => ({ by: 'claude', text: '{"proceed":true}', usage: { totalTokens: 33 } }),
  ]) {
    const f = fixture(t); f.capture(); f.capture(2);
    const result = await selectBestExecutionCandidate(f.orch, f.run, f.task, { call });
    assert.equal(result.status, 'waiting'); assert.equal(result.response.usage.totalTokens, 33);
  }
});

test('another SQLite connection resumes cached selection without another consultant call', async t => {
  const f = fixture(t), first = f.capture(); f.capture(2);
  assert.equal((await selectBestExecutionCandidate(f.orch, f.run, f.task, { call: async () => f.choose(first.candidate) })).status, 'selected');
  const secondStore = new Store(f.store.file); t.after(() => secondStore.close());
  assert.equal((await selectBestExecutionCandidate({ store: secondStore }, f.run, f.task, { call: () => { throw new Error('unexpected re-call'); } })).status, 'selected');
});

test('junction escaping cwd cannot become a candidate even when glob scope matches', t => {
  const f = fixture(t), outside = path.join(artifactsRoot(), 'advisor-execution-selection-tests', randomUUID());
  fs.mkdirSync(outside, { recursive: true }); fs.writeFileSync(path.join(outside, 'page.html'), 'outside');
  const link = path.join(f.cwd, 'link'); fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.task.files = ['link/*.html'];
  assert.equal(f.capture(1, 'output', { report: { artifacts: [{ path: path.join(link, 'page.html') }] } }).status, 'ineligible');
});
