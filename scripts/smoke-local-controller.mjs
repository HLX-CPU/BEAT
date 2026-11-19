import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalDeepSeekController, localDecisionPolicy } from '../src/local-controller.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--low-risk') ? 'low-risk' : 'shadow';
const output = path.join(root, 'data', 'reports', `local-controller-${mode}-smoke.json`);
const goal = mode === 'low-risk'
  ? 'Create a new README text file and verify its exact contents'
  : 'Create a harmless text summary from existing files without modifying source files';
const controller = new LocalDeepSeekController({
  enabled: true,
  mode,
  baseUrl: 'http://127.0.0.1:11434',
  model: 'deepseek-r1:14b',
  timeoutSec: 300,
  keepAlive: '10m',
});
const currentFlow = {
  discussionMaxDebates: 3,
  maxRounds: 5,
  maxParallelTasks: 3,
  discussionTokenBudget: 2560000,
  executionTokenBudget: 3840000,
  taskTokenBudget: 1280000,
  fastPath: true,
};
const health = await controller.health();
const evidence = await controller.decide({
  goal,
  cwd: root,
  availablePartners: ['codex', 'deepseek'],
  limits: currentFlow,
  context: `Real ${mode} controller smoke test. Decide only; do not execute the task.`,
});
const policy = evidence.proposal
  ? localDecisionPolicy(evidence.proposal, { mode, runKind: 'parallel', partners: ['codex', 'deepseek'], currentFlow, goal })
  : { applied: false, reason: evidence.validationError || 'no proposal', patch: {} };
const report = {
  generatedAt: new Date().toISOString(),
  health,
  requestedModel: evidence.requestedModel,
  actualModel: evidence.actualModel,
  modelVerified: evidence.modelVerified,
  durationMs: evidence.durationMs,
  proposal: evidence.proposal,
  policy,
  originalFlow: currentFlow,
  flowUnchanged: policy.applied === false && Object.keys(policy.patch || {}).length === 0,
  passed: health.online === true && health.modelReady === true && evidence.modelVerified === true
    && (mode === 'shadow' ? policy.applied === false && Object.keys(policy.patch || {}).length === 0 : policy.applied === true),
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, passed: report.passed, modelVerified: report.modelVerified, flowUnchanged: report.flowUnchanged }, null, 2));
if (!report.passed) process.exitCode = 1;
