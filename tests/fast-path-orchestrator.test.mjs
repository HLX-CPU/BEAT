// 免协商快路径（第 3 条）在真实编排器里的判定：只有"验收能被机器证据完全证明"才放行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { defaults } from '../src/config.mjs';

function setup(flow = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-fastpath-'));
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), skipAcl: true, secrets: { token: 't' } };
  config.flow = { ...config.flow, ...flow };
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  const orch = new Orchestrator({ config, store, agents: {} });
  return { config, store, orch, root };
}

test('目标里写明可执行验收命令时，编排器判为可走快路径：单人单任务、验收全挂命令', () => {
  const s = setup();
  const cwd = path.join(s.root, 'work'); fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'ok.mjs'), 'export const x = 1;\n');
  const run = s.store.createRun({ kind: 'parallel', goal: '在目录里交付 ok.mjs。验收：\n① node --check ok.mjs 退出码 0', cwd, initiator: 'deepseek', max_turns: 12 });
  try {
    const verdict = s.orch.fastPathPlan(run);
    assert.equal(verdict.eligible, true, JSON.stringify(verdict.reasons));
    assert.deepEqual(verdict.plan.checks, ['node --check ok.mjs']);
    assert.equal(verdict.plan.tasks.length, 1);
    assert.equal(verdict.plan.tasks[0].checks.length, 1);
    // 构造出的方案必须过原流程的校验，否则快路径等于绕开安全检查
    assert.doesNotThrow(() => s.orch.validatePlan(run, verdict.plan));
    assert.deepEqual(s.orch.preflightPlan(run, verdict.plan), []);
  } finally { s.store.close(); }
});

test('没有写明验收命令 / 有靠人判断的验收 / 命令预检不过 → 一律回原流程协商', () => {
  const s = setup();
  const cwd = path.join(s.root, 'work'); fs.mkdirSync(cwd, { recursive: true });
  try {
    const vague = s.store.createRun({ kind: 'parallel', goal: '把界面做得好看一点，代码要优雅', cwd, initiator: 'deepseek', max_turns: 12 });
    const first = s.orch.fastPathPlan(vague);
    assert.equal(first.eligible, false);
    assert.ok(first.reasons.some(r => /没有写出可执行的验收命令/.test(r)), JSON.stringify(first.reasons));

    // 拼接型命令不走快路径
    const chained = s.store.createRun({ kind: 'parallel', goal: '交付 ok.mjs。验收：node --check ok.mjs && node --version', cwd, initiator: 'deepseek', max_turns: 12 });
    assert.equal(s.orch.fastPathPlan(chained).eligible, false);

    // 预检不过（越界文件）→ 回原流程
    const escaped = s.store.createRun({ kind: 'parallel', goal: '交付 ok.mjs。验收：node --check ..\\..\\escape.mjs', cwd, initiator: 'deepseek', max_turns: 12 });
    assert.equal(s.orch.fastPathPlan(escaped).eligible, false);
  } finally { s.store.close(); }
});

test('快路径可以整体关掉（fastPath:false），不影响既有流程', () => {
  const s = setup({ fastPath: false });
  const cwd = path.join(s.root, 'work'); fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'ok.mjs'), 'export const x = 1;\n');
  const run = s.store.createRun({ kind: 'parallel', goal: '交付 ok.mjs。验收：node --check ok.mjs', cwd, initiator: 'deepseek', max_turns: 12 });
  try {
    // 判定函数本身仍然可用（它是纯函数），但 runParallel 里会因开关跳过它
    assert.equal(s.config.flow.fastPath, false, 'setup 传入的开关应当生效（false 不能被当成未设置）');
    assert.equal(s.orch.flowFor(run).fastPath, false, 'flowFor 必须保留开关');
    const verdict = s.orch.fastPathPlan(run);
    assert.equal(verdict.eligible, true, '关掉开关只影响编排器是否调用，不影响纯判定：' + JSON.stringify(verdict.reasons));
  } finally { s.store.close(); }
});
