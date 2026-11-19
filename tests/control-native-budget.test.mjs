import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { defaults } from '../src/config.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

// Exercise admission, the live usage callback, cancellation and the persisted
// audit together, without invoking or charging a real native model.
function fixture(flow = {}, nativeContextTokens = { codex: 24576, deepseek: 8192 }) {
  // 工作区放系统临时目录：以前写在 ../workspaces/control-native-budget-tests（产品目录里），
  // 每跑一次留一批带时间戳的目录——提取纯净版时实测把副本弄脏。
  const root = path.join(artifactsRoot(), 'control-native-budget-tests', Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
  const config = defaults(root);
  Object.assign(config, { root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 'fixture' } });
  config.flow = { ...config.flow, tokenBudgetEnforced: true, ...flow };
  config.codex.defaultModel = 'gpt-6.1-sol'; config.deepseek.defaultModel = 'deepseek-fixture';
  const store = new Store(':memory:');
  const orch = new Orchestrator({ config, store, agents: { nativeContextTokens } });
  const run = store.createRun({ kind: 'discuss', goal: '原生上下文预算回归', cwd: root, initiator: 'codex' });
  store.updateRun(run.id, { state: 'running' });
  const calls = [];
  const bind = handler => {
    orch.step = async (task, options) => {
      calls.push(options);
      const stepId = store.addStep({ run_id: task.id, role: options.role, seat: options.seat, agent: options.seat });
      const result = await handler(options);
      return { by: options.seat, stepId, text: '短提纲', prompt: options.build(options.seat), ...result };
    };
  };
  const options = () => ({ role: 'discuss', seat: 'codex', call: 'think', build: () => '只给三条提纲', signal: new AbortController().signal, sessions: {} });
  return { orch, store, run, calls, bind, options };
}

test('短提纲预算仍预留原生系统工具前缀：21855实测token不被900短答复上限误取消', async () => {
  const f = fixture();
  try {
    const usage = { inputTokens: 21000, outputTokens: 855, totalTokens: 21855, source: 'native fixture' };
    f.bind(async options => {
      assert.equal(options.maxTokens, 900, '可见答复上限仍保持短提纲');
      assert.ok(options.maxTotalTokens >= 21855, '总调用预算包含真实原生上下文');
      options.onUsage(usage); assert.equal(options.signal.aborted, false);
      return { usage };
    });
    const result = await f.orch.controlCall(f.run, f.options(), { phase: 'discussion', maxOutputTokens: 900 });
    assert.equal(result.usage.totalTokens, 21855); assert.equal(f.calls.length, 1);
    const audit = f.store.get('controlMetrics:' + f.run.id);
    assert.equal(audit.phases.discussion.measuredTokens, 21855); assert.equal(audit.phases.discussion.estimatedTokens, 0);
    assert.equal(audit.phases.discussion.unknownCalls, 0); assert.equal(Object.keys(audit.reservations).length, 0);
    assert.equal(audit.records[0].measurement, 'provider');
  } finally { f.store.close(); }
});

test('讨论总预算放不下原生前缀时派发前停止，不因短输出而发起已知超预算调用', async () => {
  const f = fixture({ discussionTokenBudget: 12000 });
  try {
    f.bind(async () => { assert.fail('上下文预算不足时不应调模型'); });
    await assert.rejects(f.orch.controlCall(f.run, f.options(), { phase: 'discussion', maxOutputTokens: 900 }), { code: 'CONTROL_BUDGET_EXCEEDED' });
    assert.equal(f.calls.length, 0); assert.equal(f.store.steps(f.run.id).length, 0);
    const audit = f.store.get('controlMetrics:' + f.run.id);
    assert.ok(!audit || !audit.records.length, '未派发不伪造provider用量');
  } finally { f.store.close(); }
});

test('任务预算放不下原生前缀时执行前停止，即使共享执行预算充足', async () => {
  const f = fixture({ executionTokenBudget: 192000, taskTokenBudget: 10000 });
  try {
    f.bind(async () => { assert.fail('不得放宽单任务预算'); });
    const options = { ...f.options(), role: 'execute', call: 'write' };
    await assert.rejects(f.orch.controlCall(f.run, options, { phase: 'execution', taskId: 'one', budget: 10000, maxOutputTokens: 1600 }), { code: 'CONTROL_BUDGET_EXCEEDED' });
    assert.equal(f.calls.length, 0); assert.equal(f.store.steps(f.run.id).length, 0);
  } finally { f.store.close(); }
});

test('固定原生会话增长使用先前实测输入修正预留，短输出仍受独立上限控制', async () => {
  const f = fixture();
  try {
    const sequence = [{ inputTokens: 27800, outputTokens: 200, totalTokens: 28000 }, { inputTokens: 31000, outputTokens: 200, totalTokens: 31200 }];
    f.bind(async options => {
      const usage = sequence[f.calls.length - 1]; options.onUsage(usage);
      assert.equal(options.signal.aborted, false); assert.equal(options.maxTokens, 900);
      return { usage };
    });
    const options = f.options();
    await f.orch.controlCall(f.run, options, { phase: 'discussion', maxOutputTokens: 900 });
    await f.orch.controlCall(f.run, options, { phase: 'discussion', maxOutputTokens: 900 });
    assert.ok(f.calls[1].maxTotalTokens > f.calls[0].maxTotalTokens);
    assert.ok(f.calls[1].maxTotalTokens >= 31200);
    const audit = f.store.get('controlMetrics:' + f.run.id);
    assert.equal(audit.phases.discussion.measuredTokens, 59200); assert.equal(audit.phases.discussion.calls, 2);
    assert.equal(Object.keys(audit.reservations).length, 0);
  } finally { f.store.close(); }
});

// R363 实测：同一个扩展坞席位实际输入 1,145 → 8,300（固定会话每次重发 system + 整段历史 + 本次 prompt），
// 而预留按旧规则始终 4,639 → 每一次都超出预留、被判成“任务预算已到上限”，加大预算也修不好。
test('拓展坞固定会话的增长计入预留：下一次预留不低于上次实测输入，不再被误判成预算用尽', async () => {
  const f = fixture();
  try {
    const options = { ...f.options(), seat: 'dock:fixture' };
    f.bind(async opts => {
      const usage = f.calls.length === 1
        ? { prompt_tokens: 4200, completion_tokens: 800, total_tokens: 5000 }
        : { prompt_tokens: 7208, completion_tokens: 882, total_tokens: 8090 };
      opts.onUsage(usage);
      assert.equal(opts.signal.aborted, false, '阶段预算充足时不得因单次估算偏差中止调用');
      return { usage };
    });
    await f.orch.controlCall(f.run, options, { phase: 'discussion', maxOutputTokens: 900 });
    await f.orch.controlCall(f.run, options, { phase: 'discussion', maxOutputTokens: 900 });
    assert.ok(f.calls[0].maxTotalTokens >= 2000, '首次调用仍给扩展坞保留会话下限');
    assert.ok(f.calls[1].maxTotalTokens >= 4200, '第二次预留必须包含会话实测输入，而不是只算本次 prompt');
    assert.ok(f.calls[1].maxTotalTokens > f.calls[0].maxTotalTokens);
    const audit = f.store.get('controlMetrics:' + f.run.id);
    assert.equal(audit.records.length, 2); assert.equal(audit.phases.discussion.usedTokens, 13090);
  } finally { f.store.close(); }
});

test('单次调用超出预留且剩余额度补不上时，报真实原因而不是“预算已到上限…提高预算”', async () => {
  const f = fixture({ discussionTokenBudget: 12000 }, null);
  try {
    const options = { ...f.options(), seat: 'dock:fixture' };
    f.bind(async opts => {
      const usage = { prompt_tokens: 20000, completion_tokens: 900, total_tokens: 20900 };
      opts.onUsage(usage);
      assert.equal(opts.signal.aborted, true, '剩余额度确实不够时必须停下');
      return { usage };
    });
    await assert.rejects(f.orch.controlCall(f.run, options, { phase: 'discussion', maxOutputTokens: 900 }), e => {
      assert.equal(e.code, 'CONTROL_BUDGET_EXCEEDED');
      assert.match(e.message, /剩余预算已不足以完成本次调用/);
      assert.doesNotMatch(e.message, /提高预算后继续/, '不能把单次估算偏差说成整任务预算已到上限');
      return true;
    });
    assert.equal(f.calls.length, 1, '起步预留本身是成立的，所以仍然派发过一次');
  } finally { f.store.close(); }
});
