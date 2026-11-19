// 近三次任务未通过的修复回归：
//   R364：最后整体读回由只能走 API 的顾问（Claude）做，它算不出 SHA-256（返回"计算验证"占位符）→ 整轮被判未通过。
//   R365：客户把 Claude 和两个拓展坞都暂停后跑视觉任务，剩下的搭档不看图 → 产物全对却显示"未通过"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyGoalReadback, goalReviewInstructions } from '../src/delivery-verification.mjs';
import { awaitingReviewerTask } from '../src/orchestrator.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

function contractFor(goal = '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画') {
  return { goalHash: 'h'.repeat(64), originalGoal: goal, object: goal, deliverables: [], prohibitions: [] };
}

function workspace(t, files) {
  const root = cleanup(t, tempDir('readback'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
  return root;
}

test('API 顾问核验：哈希由控制器绑定，模型的逐字摘录对得上就算读回', t => {
  const root = workspace(t, { 'index.html': '<!doctype html><html><body><svg id="pelican"></svg></body></html>', 'verify.test.mjs': "// 结构自检：只读 index.html\nimport test from 'node:test';\n" });
  const html = path.join(root, 'index.html'), spec = path.join(root, 'verify.test.mjs');
  const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const verdict = {
    goalHash: 'h'.repeat(64), goalChecks: { object: 'verified', deliverables: 'verified', prohibitions: 'verified' },
    readbacks: [
      { path: html, sha256: sha(html), quote: '<svg id="pelican">' },
      // R364 实际发生的：模型写不出哈希，只能写"计算验证"
      { path: spec, sha256: '计算验证', quote: '// 结构自检：只读 index.html' },
    ],
  };
  const result = verifyGoalReadback(verdict, [html, spec], contractFor(), { controllerHashed: true });
  assert.equal(result.pass, true, JSON.stringify(result.issues));
  assert.equal(result.evidenceComplete, true);
  assert.deepEqual(result.readbacks.map(item => item.sha256Source), ['controller', 'controller']);
  assert.equal(result.readbacks[1].sha256, sha(spec), '哈希必须是控制器算出来的真实值');
});

test('API 顾问核验：摘录对不上照样不通过（不是降低标准）', t => {
  const root = workspace(t, { 'index.html': '<svg id="pelican"></svg>' });
  const file = path.join(root, 'index.html');
  const verdict = { goalHash: 'h'.repeat(64), goalChecks: { object: 'verified', deliverables: 'verified', prohibitions: 'verified' },
    readbacks: [{ path: file, sha256: 'controller', quote: '这段文字不在文件里' }] };
  const result = verifyGoalReadback(verdict, [file], contractFor(), { controllerHashed: true });
  assert.equal(result.pass, false);
  assert.match(result.issues.join('\n'), /产物读回片段不匹配/);
});

test('能读盘的搭档核验时，哈希仍必须由它自己给出并匹配（原行为不变）', t => {
  const root = workspace(t, { 'index.html': '<svg id="pelican"></svg>' });
  const file = path.join(root, 'index.html');
  const verdict = { goalHash: 'h'.repeat(64), goalChecks: { object: 'verified', deliverables: 'verified', prohibitions: 'verified' },
    readbacks: [{ path: file, sha256: '计算验证', quote: '<svg id="pelican">' }] };
  const result = verifyGoalReadback(verdict, [file], contractFor());
  assert.equal(result.pass, false);
  assert.match(result.issues.join('\n'), /未独立读回当前产物/);
});

test('给 API 顾问的提示词明确说"哈希写 controller、必须给摘录"，其他搭档不出现这句', () => {
  const api = goalReviewInstructions(contractFor(), { cannotReadFiles: true });
  assert.match(api, /sha256 一律写 "controller"/);
  assert.match(api, /逐字摘录/);
  const normal = goalReviewInstructions(contractFor());
  assert.doesNotMatch(normal, /controller/);
});

test('等待看图核验的小任务显示为待核验，而不是"未通过"', () => {
  assert.equal(awaitingReviewerTask({ status: 'verifying', state: 'verifying', issues: ['视觉相关验收未验证：本次核验搭档不支持看图，产出已保留；有能看图的搭档后点「继续」只核验、不重做'] }), true);
  assert.equal(awaitingReviewerTask({ status: 'blocked', state: 'blocked', issues: ['没有独立于执行者且接口成本符合剩余预算的在线核验搭档，语义验收未验证'] }), true);
  assert.equal(awaitingReviewerTask({ status: 'passed', state: 'passed', issues: [] }), false);
  assert.equal(awaitingReviewerTask({ status: 'failed', state: 'failed', issues: ['脚掌没有贴合踏板'] }), false);
  assert.equal(awaitingReviewerTask(null), false);
  const source = fs.readFileSync(new URL('../src/orchestrator.mjs', import.meta.url), 'utf8');
  assert.match(source, /⏳ \$\{text\}｜待核验/);
  assert.match(source, /具体原因见下方待核验项目/);
});
