import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('看板：未批准讨论含旧done状态均可继续，已通过讨论不可重复，验收保留产物提示正确', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(html.slice(html.indexOf('function resumeAction('), html.indexOf('function customerResultText(')), context);
  for (const state of ['failed', 'error', 'interrupted', 'done']) assert.equal(context.resumeAction({ kind: 'discuss', state, verdict: 'not-approved' }).label, '继续讨论');
  assert.equal(context.resumeAction({ kind: 'discuss', state: 'done', verdict: 'consensus' }), null);
  assert.equal(context.resumeAction({ kind: 'discuss', state: 'running' }), null);
  assert.equal(context.resumeAction({ kind: 'parallel', state: 'failed', plan: {}, taskQueue: [{ state: 'verifying' }, { state: 'passed' }] }).label, '继续验收');
  assert.equal(context.resumeAction({ kind: 'parallel', state: 'failed', plan: {}, taskQueue: [{ state: 'queued' }] }).label, '继续执行');
  assert.match(html, /const resume = resumeAction\(r\)/);
  assert.match(html, /已' \+ resume.label/);
});
