import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compactEvidence } from '../src/evidence-compact.mjs';

const png = Buffer.from('89504e470d0a1a0a' + 'A'.repeat(900000), 'hex').toString('base64');

test('超大截图/base64 证据被省略，路径与摘要仍在', () => {
  const report = {
    summary: '浏览器目视验收完成',
    artifacts: [{ path: 'tasks/x/pelican-bike.html', sha256: 'abc', summary: '动画页面' }],
    nativeToolEvidence: {
      trace: {
        status: 'complete',
        calls: [
          { tool: 'browser_screenshot', result: { data: 'data:image/png;base64,' + png } },
          { tool: 'read_file', result: { text: 'ok' } },
        ],
      },
      blobs: [png, png.slice(0, 200000)],
    },
  };
  const compact = compactEvidence(report);
  const text = JSON.stringify(compact);
  assert.ok(text.length < 60000, '压到 60KB 以内，实际 ' + text.length);
  assert.match(text, /pelican-bike\.html/);
  assert.match(text, /浏览器目视验收完成/);
  assert.match(text, /已省略/);
  assert.doesNotMatch(text, /data:image\/png;base64/);
  assert.doesNotMatch(text, new RegExp(png.slice(0, 80)));
});

test('小证据原样保留，不改动可判读内容', () => {
  const input = { passes: true, issues: [], path: 'a.txt', note: 'ok' };
  assert.deepEqual(compactEvidence(input), input);
});

test('超长数组与深层嵌套有界，不静默变化结构', () => {
  const input = { items: Array.from({ length: 200 }, (_, i) => ({ i, text: 'x'.repeat(2000) })) };
  const text = JSON.stringify(compactEvidence(input));
  assert.ok(text.length < 60000);
  assert.match(text, /共 200 项/);
  let deep = { leaf: 'ok' };
  for (let i = 0; i < 30; i++) deep = { child: deep };
  assert.match(JSON.stringify(compactEvidence(deep)), /层级过深已省略/);
});

test('评审提示词使用瘦身后的证据（防止 1M 上下文被撑爆）', () => {
  const src = fs.readFileSync(new URL('../src/queue-runner.mjs', import.meta.url), 'utf8');
  assert.match(src, /compactEvidence\(report\.(?:nativeToolEvidenceReview \|\| report\.)?nativeToolEvidence\)/);
  assert.match(src, /compactEvidence\(report\.htmlRenderEvidence\)/);
  assert.match(src, /compactEvidence\(report\.desktopEvidence\)/);
});
