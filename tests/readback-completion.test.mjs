// 最近一次失败（R366）的根因回归：任务与 4 条验收全过，但整体读回时 Claude 只给了 index.html 的摘录、
// 漏了 tests/animation.test.mjs，控制器按"未独立读回"把整轮判失败。现在漏读会补问一次（只补读回）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fillMissingReadbacks } from '../src/queue-runner.mjs';
import { verifyGoalReadback, goalReviewInstructions, sameArtifactPath } from '../src/delivery-verification.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

const contract = { goalHash: 'h'.repeat(64), originalGoal: '创建一个HTML动画', object: '', deliverables: [], prohibitions: [] };
function files(t) {
  const root = cleanup(t, tempDir('readback2'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><svg id="pelican"></svg>');
  fs.writeFileSync(path.join(root, 'animation.test.mjs'), "// 结构自检\nimport test from 'node:test';\n");
  return { html: path.join(root, 'index.html'), spec: path.join(root, 'animation.test.mjs') };
}

test('核验顾问漏读一个交付文件时补问一次，补齐后读回通过（R366 场景）', async t => {
  const { html, spec } = files(t);
  const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const verdict = { goalHash: 'h'.repeat(64), goalChecks: { object: 'verified', deliverables: 'verified', prohibitions: 'verified' },
    readbacks: [{ path: html, sha256: 'controller', quote: '<svg id="pelican">' }] };
  const asked = [];
  const completed = await fillMissingReadbacks({ artifacts: [html, spec], verdict, ask: async missing => {
    asked.push(...missing);
    return JSON.stringify({ readbacks: missing.map(file => ({ path: file, sha256: 'controller', quote: 'import test' })) });
  } });
  assert.deepEqual(asked, [spec], '只补问漏掉的那个文件');
  assert.deepEqual(completed.filled, [spec]);
  const result = verifyGoalReadback(completed.verdict, [html, spec], contract, { controllerHashed: true });
  assert.equal(result.pass, true, JSON.stringify(result.issues));
  assert.equal(result.evidenceComplete, true);
});

test('补问后仍然漏读就不算补齐，也不抛错（保留原结论）', async t => {
  const { html, spec } = files(t);
  const verdict = { readbacks: [{ path: html, sha256: 'controller', quote: '<svg id="pelican">' }] };
  const completed = await fillMissingReadbacks({ artifacts: [html, spec], verdict, ask: async () => JSON.stringify({ readbacks: [] }) });
  assert.deepEqual(completed.filled, []);
  assert.deepEqual(completed.missing, [spec]);
  const result = verifyGoalReadback(completed.verdict, [html, spec], contract, { controllerHashed: true });
  assert.equal(result.pass, false);
  assert.match(result.issues.join('\n'), /未独立读回当前产物/);
});

test('没有漏读就不补问；没有 ask 时原样返回', async t => {
  const { html, spec } = files(t);
  let calls = 0;
  const complete = { readbacks: [{ path: html, quote: 'x' }, { path: spec, quote: 'y' }] };
  const same = await fillMissingReadbacks({ artifacts: [html, spec], verdict: complete, ask: async () => { calls++; return ''; } });
  assert.equal(calls, 0);
  assert.equal(same.verdict, complete);
  const noAsk = await fillMissingReadbacks({ artifacts: [html, spec], verdict: { readbacks: [] } });
  assert.deepEqual(noAsk.missing, [html, spec]);
  assert.deepEqual(noAsk.filled, []);
});

test('路径大小写/相对写法不同也能对上；提示词要求逐件覆盖', () => {
  assert.equal(sameArtifactPath('E:\\beat\\WORK\\index.html', 'e:/beat/work/index.html'), true);
  assert.equal(sameArtifactPath('E:\\beat\\a.html', 'E:\\beat\\b.html'), false);
  assert.match(goalReviewInstructions(contract), /逐一覆盖/);
  const source = fs.readFileSync(new URL('../src/queue-runner.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/fillMissingReadbacks\(/g) || []).length >= 2, true, '任务级和整体级都要补读回');
  assert.match(source, /已补读回（不重新评价）/);
});
