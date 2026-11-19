// 回归：方案缺文件范围时，compact discussion 必须让作者在预检阶段补上，再评审、再执行。
// 这是 R2 实战失败（8 次调用 / 98k token 后死在执行入口）的直接回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { negotiateCompact } from '../src/compact-discussion.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

const seats = ['codex', 'deepseek', 'dock:a', 'dock:b'];
const decision = (id, option = 'A', serious = false) => ({ id, option, reason: serious ? '不可逆操作缺少确认' : '简单可靠', category: serious ? 'irreversible' : 'ordinary', serious });
const outline = () => ({ core: '按接口处理', steps: ['实现', '检查'], risks: ['异常中断'], decisions: [decision('route'), decision('sequence'), decision('risk')] });
const decisions = { route: 'A', sequence: 'A', risk: 'A' };
const plan = { tasks: [{ id: 'task-1', owner: 'codex', type: 'workspace', title: '实现控制逻辑', detail: '用接口实现并检查，写入 src/new.mjs', files: ['src/new.mjs'], dependsOn: [], inputRefs: [], outputRefs: ['src/new.mjs'], acceptance: ['通过脚本校验'], checks: [], difficulty: 'simple', tokenBudget: 4000, maxRetries: 2 }], acceptance: ['无需修改配置'], checks: [] };

function fixture(handler) {
  const store = new Store(':memory:');
  const base = artifactsRoot();
  fs.mkdirSync(base, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(base, 'structure-'));
  const run = store.createRun({ kind: 'parallel', goal: '通过接口完成操作，无需修改设置', cwd, initiator: 'codex', max_turns: 12 });
  const calls = [];
  const orch = {
    config: { flow: { outlineMergeFallback: false } }, store,
    participants: () => seats,
    guard: (_id, signal) => { if (signal.aborted) throw signal.reason || Error('已取消'); },
    validatePlan: (_run, value) => { assert.ok(value.tasks.length); return value; },
    setStep: (id, note, data) => {
      const old = store.steps(run.id).find(x => x.id === id);
      store.updateStep(id, { note, data: { ...old?.data, ...data } });
    },
    async controlCall(r, opts, budget) {
      const prompt = opts.build(opts.seat);
      const stage = /阶段=([a-z]+)/.exec(prompt)[1];
      calls.push({ stage, seat: opts.seat, budget, prompt });
      const id = store.addStep({ run_id: r.id, role: opts.role, seat: opts.seat, agent: opts.seat, round: opts.round });
      opts.onStart?.(id);
      let answer;
      try { answer = await handler({ stage, seat: opts.seat, prompt, calls }); }
      catch (e) { store.updateStep(id, { state: 'failed', error: e.message }); throw e; }
      const response = answer?.response || answer;
      const by = answer?.by || opts.seat;
      const text = typeof response === 'string' ? response : JSON.stringify(response);
      store.updateStep(id, { state: 'done', agent: by, prompt, output: text, data: { actualAgent: by } });
      return { by, text, stepId: id, label: by };
    },
  };
  orch.step = orch.controlCall;
  return { store, run, orch, calls, signal: new AbortController().signal };
}
const standard = ({ stage, seat, prompt }) => {
  if (stage === 'outline') return outline();
  if (stage === 'expand') return { summary: '完整方案', decisions, plan: { ...plan, tasks: [{ ...plan.tasks[0], files: [] }] } };
  if (stage === 'review') return { verdict: 'pass', planHash: /hash=([a-f0-9]{64})/.exec(prompt)[1], issues: [] };
  if (stage === 'vote') return { votes: [decision('route')] };
  throw Error('unexpected ' + stage + ' ' + seat);
};

test('任务漏写文件范围：预检交作者补 files 后重新评审，不进入执行入口', async () => {
  let repairCalls = 0;
  const f = fixture(args => {
    if (args.stage === 'repair') {
      repairCalls++;
      assert.match(args.prompt, /任务没有写文件范围/);
      return { decisions, summary: '补上文件范围', patches: [{ section: 'tasks.task-1', value: { files: ['src/new.mjs'] } }] };
    }
    return standard(args);
  });
  f.orch.preflightPlan = (_run, candidate) => candidate.tasks
    .filter(task => !(task.files || []).length)
    .map(task => ({ section: 'tasks.' + task.id, kind: 'files', problem: '任务没有写文件范围：' + task.id }));
  const result = await negotiateCompact(f.orch, f.run, f.signal, {}, 'parallel');
  assert.equal(result.consensus, true, JSON.stringify(result));
  assert.equal(repairCalls, 1, '只补一次文件范围，不反复拉锯');
  assert.deepEqual(result.plan.tasks[0].files, ['src/new.mjs']);
  const preflightEvidence = f.store.get('preflightEvidence:' + f.run.id);
  assert.ok(preflightEvidence?.issues?.some(issue => issue.kind === 'files'));
});
