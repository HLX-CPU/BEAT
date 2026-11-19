import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DesktopAssistant, resetLeaseForTests, minAssistantTokens, scopeToolsFor } from '../workspaces/shared/desktop-assistant/core/assistant.mjs';
import { executeDesktopPartner } from '../workspaces/shared/desktop-assistant/integration/partner.mjs';
import { estimateTokens } from '../src/control-budget.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

const usage = total => ({ total_tokens: total, prompt_tokens: total - 10, completion_tokens: 10 });
function turnFixture(chat, tokenLimit = 230) {
  const a = Object.create(DesktopAssistant.prototype);
  Object.assign(a, { chat, config: { dock: [{ id: 'dock:test', maxTokens: 16384 }] }, modelTurnSec: 10, modelTimeoutMs: 1000, save: () => {} });
  const emissions = [];
  const t = { dockId: 'dock:test', controller: new AbortController(), controlBudget: { tokenLimit, maxOutputTokens: 128 }, onUsage: value => emissions.push(value) };
  return { a, t, emissions };
}
const messages = [{ role: 'user', content: 'x' }];

test('each model/tool round accumulates full provider usage including cached input; insufficient third call is not sent', async () => {
  const requested = [];
  const f = turnFixture(async (_id, opts) => { requested.push(opts.maxTokens); return { text: 'ok', usage: requested.length === 1 ? usage(50) : { total_tokens: 70, prompt_tokens: 60, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 55 } } }; });
  await f.a.modelTurn(f.t, messages, []);
  await f.a.modelTurn(f.t, messages, []);
  assert.equal(f.t.usage.total_tokens, 120);
  assert.equal(f.t.usage.input_tokens, 100);
  assert.equal(f.t.budgetSpentTokens, 120);
  await assert.rejects(f.a.modelTurn(f.t, messages, []), e => e.code === 'CONTROL_BUDGET_EXCEEDED' && e.nonRetryable && e.noFallback);
  assert.equal(requested.length, 2);
  assert.ok(requested.every(x => x <= 128));
  assert.equal(f.emissions.at(-1).total_tokens, 120);
});

test('unknown usage stays an estimate and failed calls consume conservative reservation', async () => {
  let calls = 0;
  const f = turnFixture(async () => { if (++calls === 1) return { text: 'ok' }; throw Object.assign(Error('empty reasoning response'), { code: 'OUTPUT_BUDGET_EXHAUSTED' }); }, 500);
  await f.a.modelTurn(f.t, messages, []);
  const first = f.t.budgetSpentTokens;
  await assert.rejects(f.a.modelTurn(f.t, messages, []), /empty reasoning/);
  assert.equal(f.t.modelUsage.unknownCalls, 2);
  assert.equal(f.t.usage, null);
  assert.equal(f.t.budgetSpentTokens, first + estimateTokens({ messages, tools: [] }) + 128);
  assert.equal(f.emissions.at(-1).verified, false);
  assert.equal(f.t.modelUsage.records.at(-1).measurement, 'estimate');
});

test('messages and tool schemas are admitted together, zero-budget context never calls API', async () => {
  let calls = 0;
  const f = turnFixture(async () => { calls++; return { text: 'x', usage: usage(20) }; }, 200);
  await assert.rejects(f.a.modelTurn(f.t, messages, [{ hugeSchema: 'x'.repeat(300) }]), e => e.code === 'CONTROL_BUDGET_EXCEEDED' && e.noDispatch === true && e.usage.total_tokens === 0 && e.usage.source === 'controller-no-dispatch');
  assert.equal(calls, 0);
  assert.equal(f.t.modelUsage.calls, 0);
});

test('code-only minimum context estimates include full capabilities and distinguish read-only mode', () => {
  assert.ok(minAssistantTokens('work') > minAssistantTokens('observe'));
  assert.ok(minAssistantTokens('work') > 18000);
  assert.ok(minAssistantTokens('work', { goal: 'x'.repeat(1000) }) > minAssistantTokens('work'));
});

test('a live over-budget usage event cannot dispatch returned tools', async () => {
  const f = turnFixture(async (_id, opts) => {
    opts.onUsage(usage(300));
    return { usage: usage(300), toolCalls: [{ id: 'danger', name: 'file_write', arguments: '{}' }] };
  }, 230);
  await assert.rejects(f.a.modelTurn(f.t, messages, []), e => e.code === 'CONTROL_BUDGET_EXCEEDED' && e.usage.total_tokens === 300);
  assert.equal(f.t.modelUsage.measuredTokens, 300);
});

async function assistantFixture(chat) {
  resetLeaseForTests();
  const base = artifactsRoot(); fs.mkdirSync(base, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(base, 'dock-budget-'));
  const a = new DesktopAssistant({ config: { workspace: cwd, allowedRoots: [cwd], dock: [{ id: 'dock:test', tools: 'supported', maxTokens: 16384 }], flow: {} }, dataDir: path.join(cwd, 'data'), userFolders: {}, chat, bridgeFactory: () => { throw Error('fixture must use interfaces without desktop worker'); } });
  return { a, cwd };
}

test('adapter carries cumulative two-round usage and output caps from real assistant, retaining the written file', async () => {
  let count = 0;
  const caps = [], observed = [];
  const f = await assistantFixture(async (_id, opts) => {
    caps.push(opts.maxTokens);
    if (++count === 1) return { usage: usage(700), toolCalls: [{ id: 'write-1', name: 'file_write', arguments: JSON.stringify({ path: 'result.txt', content: 'verified result', expectedHash: 'absent' }) }] };
    return { text: '完成', toolCalls: [], usage: usage(500) };
  });
  const result = await executeDesktopPartner({}, 'dock:test', { prompt: '创建结果文件', cwd: f.cwd, executionScope: 'workspace', parallelPartner: true, maxTokens: 900, maxTotalTokens: 30000, onUsage: value => observed.push(value) }, { assistant: f.a });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.usage.total_tokens, 1200);
  assert.equal(result.budgetSpentTokens, 1200);
  assert.equal(result.modelUsage.calls, 2);
  assert.ok(caps.every(x => x <= 900));
  assert.equal(fs.readFileSync(path.join(f.cwd, 'result.txt'), 'utf8'), 'verified result');
  assert.ok(observed.some(x => x?.total_tokens === 1200));
});

test('empty reasoning retry uses the same cap and remaining budget, never silently jumps to 16384', async () => {
  const caps = [];
  const f = await assistantFixture(async (_id, opts) => {
    caps.push(opts.maxTokens);
    if (caps.length === 1) throw Object.assign(Error('empty answer'), { code: 'OUTPUT_BUDGET_EXHAUSTED', usage: usage(500) });
    return { text: '只读评审通过', toolCalls: [], usage: usage(200) };
  });
  const result = await executeDesktopPartner({}, 'dock:test', { prompt: '只读评审', cwd: f.cwd, mode: 'observe', executionScope: 'workspace', parallelPartner: true, maxTokens: 600, maxTotalTokens: 30000 }, { assistant: f.a });
  assert.deepEqual(caps, [600, 600]);
  assert.equal(result.usage.total_tokens, 700);
  assert.equal(f.a.get(result.desktopTaskId).modelRetries, 1);
});

test('over-budget assistant result stops before file tools and propagates a non-retryable error with real usage', async () => {
  const f = await assistantFixture(async () => ({ usage: usage(31000), toolCalls: [{ id: 'w', name: 'file_write', arguments: JSON.stringify({ path: 'forbidden.txt', content: 'should not execute', expectedHash: 'absent' }) }] }));
  await assert.rejects(executeDesktopPartner({}, 'dock:test', { prompt: '写文件', cwd: f.cwd, executionScope: 'workspace', parallelPartner: true, maxTokens: 900, maxTotalTokens: 30000 }, { assistant: f.a }), e => {
    assert.equal(e.code, 'CONTROL_BUDGET_EXCEEDED'); assert.equal(e.nonRetryable, true); assert.equal(e.noFallback, true);
    assert.equal(e.usage.total_tokens, 31000); assert.equal(e.desktopEvidence.calls.length, 0); return true;
  });
  assert.equal(fs.existsSync(path.join(f.cwd, 'forbidden.txt')), false);
});

test('uncertain input evidence survives budget failure and prevents adapter replay', async () => {
  const task = { taskId: 'D-unknown', dockId: 'dock:test', status: 'failed', errorCode: 'CONTROL_BUDGET_EXCEEDED', nonRetryable: true, usage: usage(500), budgetSpentTokens: 500, calls: [{ callId: 'keypress', tool: 'key_press', status: 'failed', evidence: { sideEffects: 'unknown' } }] };
  let starts = 0;
  const assistant = { start: async () => { starts++; return task; }, get: () => task };
  await assert.rejects(executeDesktopPartner({}, 'dock:test', { prompt: '继续' }, { assistant }), e => e.code === 'CONTROL_BUDGET_EXCEEDED' && e.desktopEvidence.calls[0].evidence.sideEffects === 'unknown');
  await assert.rejects(executeDesktopPartner({}, 'dock:test', { prompt: '再继续', previous: { desktopTaskId: task.taskId } }, { assistant }), /DESKTOP_REPLAY_REQUIRES_REVIEW/);
  assert.equal(starts, 1);
});
test('workspace-scope turn only receives workspace tools and refuses desktop tools before dispatch', async () => {
  const f = await assistantFixture(async (_id, opts) => {
    const names = (opts.tools || []).map(s => s.function && s.function.name);
    f.turns = f.turns || []; f.turns.push(names);
    if (f.turns.length === 1) return { usage: usage(800), toolCalls: [{ id: 'w1', name: 'file_write', arguments: JSON.stringify({ path: 'ok.txt', content: 'ok', expectedHash: 'absent' }) }] };
    if (f.turns.length === 2) return { usage: usage(800), toolCalls: [{ id: 'd1', name: 'click', arguments: JSON.stringify({ x: 1, y: 1 }) }] };
    return { text: '结论', toolCalls: [], usage: usage(300) };
  });
  const t = { taskId: 'scope', dockId: 'dock:test', mode: 'work', executionScope: 'workspace', cwd: f.cwd, goal: '写文件', calls: [], attachments: [], parallelPartner: true, controlBudget: { tokenLimit: 60000, maxOutputTokens: 1024 }, controller: new AbortController(), leaseId: 'lease-scope' };
  await f.a.run(t);
  const names = f.turns[0] || [];
  assert.ok(names.includes('file_write'), '工作目录任务必须保留文件工具');
  assert.ok(!names.includes('click') && !names.includes('screenshot') && !names.includes('type_text'), '工作目录任务不应拿到桌面 GUI 工具');
  assert.deepEqual(names.filter(x => ['click', 'drag', 'type_text', 'key_press', 'scroll', 'screenshot', 'uia_invoke', 'uia_query', 'window_focus', 'window_list', 'app_launch', 'app_open', 'app_list', 'capabilities', 'ping', 'window_info', 'uia_get'].includes(x)), []);
  const click = t.calls.find(c => c.tool === 'click');
  assert.ok(click, '桌面工具调用必须留下记录');
  assert.equal(click.status, 'failed');
  assert.match(String(click.error && click.error.message || ''), /仅允许文件/);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'ok.txt'), 'utf8'), 'ok');
  assert.deepEqual(scopeToolsFor('workspace').filter(x => x.function.name === 'click'), []);
  assert.ok(scopeToolsFor('desktop').some(x => x.function.name === 'click'));
  assert.ok(!scopeToolsFor('desktop').some(x => x.function.name === 'file_write'));
});
test('concatenated tool arguments become real calls instead of one bad argument', async () => {
  const f = await assistantFixture(async () => {
    const n = (f.rounds = (f.rounds || 0) + 1);
    if (n === 1) return { usage: usage(900), toolCalls: [{ id: 'c1', name: 'file_read', arguments: '{"path":"a.txt"}{"path":"b.txt"}' }] };
    return { text: '{"pass":true,"issues":[]}', toolCalls: [], usage: usage(300) };
  });
  fs.writeFileSync(path.join(f.cwd, 'a.txt'), 'A'); fs.writeFileSync(path.join(f.cwd, 'b.txt'), 'B');
  const t = { taskId: 'concat', dockId: 'dock:test', mode: 'observe', executionScope: 'workspace', cwd: f.cwd, goal: '核验', calls: [], attachments: [], parallelPartner: true, controlBudget: { tokenLimit: 60000, maxOutputTokens: 1024 }, controller: new AbortController(), leaseId: 'lease-concat' };
  await f.a.run(t);
  const reads = t.calls.filter(c => c.tool === 'file_read');
  assert.equal(reads.length, 2, '拼接参数必须还原成两次真实调用');
  assert.deepEqual(reads.map(c => c.args.path), ['a.txt', 'b.txt']);
  assert.ok(reads.every(c => c.status === 'verified'));
});
