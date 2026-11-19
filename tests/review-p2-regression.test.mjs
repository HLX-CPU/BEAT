// 测评问题清单 P2 回归：资金误报、确认入口、用量/帮助接口、错误话术。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { inputGuardrail } from '../src/guardrails.mjs';
import { customerIssue } from '../src/customer-issue.mjs';
import { customerIssueText } from '../src/client.mjs';
import { quarantineText } from '../src/state-machine.mjs';
import { usageReport, helpText, TOOLS } from '../src/tools.mjs';
import { defaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

test('P2-1：描述价格不再命中资金护栏；真正的转账/支付仍要确认', () => {
  const described = inputGuardrail({ goal: '请用三句话向一位刚花 15 元购买 BEAT 的普通用户解释三个工具。' });
  assert.notEqual(described.level, 'confirm', JSON.stringify(described.findings));
  assert.equal(described.findings.some(finding => finding.category === 'money'), false);
  const pay = inputGuardrail({ goal: '帮我给客户转账 5000 元' });
  assert.equal(pay.level, 'confirm');
  assert.equal(pay.requiresConfirmation, true);
  assert.match(pay.confirmation.token, /^[a-f0-9]{16}$/);
  assert.equal(pay.confirmation.tool, 'beat_confirm');
  const purchase = inputGuardrail({ goal: '帮我购买 15 元的会员' });
  assert.equal(purchase.level, 'confirm');
});

test('P2-1：只读任务命中资金词只提示；写任务未确认不执行，确认码可继续', async t => {
  const root = cleanup(t, tempDir('p2-confirm'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'fixture' } };
  config.codex.defaultModel = 'fixture-codex'; config.deepseek.defaultModel = 'fixture-deepseek';
  const store = new Store(path.join(config.dataDir, 'beat.sqlite')); t.after(() => store.close());
  const orch = new Orchestrator({ config, store, agents: {} });
  orch.launch = () => {}; // 测试只验证确认流程，不真的调用模型
  const readOnly = store.createRun({ kind: 'ask', goal: '帮我给客户转账 5000 元是什么意思？只解释，不执行。', cwd: config.workspace, target: 'deepseek', access: 'read-only' });
  assert.equal(orch.applyInputGuardrail(readOnly), true);
  const ro = store.get('guardrails:' + readOnly.id).input;
  assert.equal(ro.level, 'warn');
  assert.equal(ro.advisory, true);
  assert.equal(store.get('inputConfirmation:' + readOnly.id) ?? null, null);

  const write = store.createRun({ kind: 'ask', goal: '帮我给客户转账 5000 元', cwd: config.workspace, target: 'deepseek', access: 'workspace-write' });
  assert.equal(orch.applyInputGuardrail(write), false);
  assert.equal(store.run(write.id).state, 'waiting_input');
  const pending = store.get('inputConfirmation:' + write.id);
  assert.match(pending.token, /^[a-f0-9]{16}$/);
  assert.throws(() => orch.confirmInputGuardrail(write.id, 'wrong-token'), /确认码不对/);
  const confirmed = orch.confirmInputGuardrail(write.id, pending.token);
  assert.equal(confirmed.state, 'queued');
  assert.equal(store.get('inputConfirmation:' + write.id), null);
  assert.equal(store.get('guardrailConfirmations:' + write.id).length, 1);
});

test('P2-2：用量与帮助接口可查，金额与上游配额明确标注为未知', () => {
  assert.ok(TOOLS.beat_usage?.mcp);
  assert.ok(TOOLS.beat_help?.mcp);
  assert.ok(TOOLS.beat_confirm?.mcp);
  const now = new Date().toISOString();
  const fake = {
    config: { flow: { taskTokenBudget: 256000, executionTokenBudget: 512000 } },
    store: {
      runs: () => [{ id: 'R1', kind: 'ask', state: 'done', target: 'deepseek', created_at: now }],
      get: key => key.startsWith('controlMetrics:')
        ? { phases: { execution: { usedTokens: 120 } }, records: [{ seat: 'deepseek', tokens: 120, ms: 10, phase: 'execution' }] }
        : null,
    },
  };
  const usage = usageReport(fake, { hours: 24, id: 'R1' });
  assert.equal(usage.totalTokens, 120);
  assert.equal(usage.byTarget.deepseek, 120);
  assert.equal(usage.limits.taskTokenBudget, 256000);
  assert.equal(usage.cost, null);
  assert.match(usage.costNote, /账单/);
  assert.equal(usage.providerQuota, 'unknown');
  assert.equal(usage.detail.id, 'R1');
  const help = helpText('confirm');
  assert.match(help.topics.confirm, /beat_confirm/);
  assert.match(helpText('nope').next, /没有这个主题/);
});

test('P2-3：任务号不存在与校验失败不再带“关闭提示/未核实文件”等执行期话术', () => {
  const missing = customerIssue(new Error('找不到任务 R999999999'));
  assert.equal(missing.title, '任务号不存在');
  assert.deepEqual(missing.actions, [{ id: 'dismiss', label: '关闭提示' }]);
  assert.doesNotMatch(missing.message, /关闭提示/);
  assert.doesNotMatch(customerIssueText(missing), /关闭提示/);
  assert.match(missing.message, /只是查询/);
  const invalid = customerIssue(new Error('请求缺少必填内容'), { beforeDispatch: true });
  assert.equal(invalid.title, '操作尚未开始');
  assert.doesNotMatch(invalid.message, /关闭提示/);
  assert.deepEqual(invalid.actions, [{ id: 'dismiss', label: '关闭提示' }]);
  assert.doesNotMatch(customerIssueText(invalid), /关闭提示/);
  assert.match(invalid.fileStatus, /未修改|没有修改/);
  assert.match(invalid.costStatus, /没有产生模型费用/);
  assert.match(quarantineText('unconfirmed-exit+unknown-side-effects'), /核对/);
  assert.match(quarantineText('retries-exhausted'), /重试/);
  assert.equal(quarantineText(null), null);
});
