import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const between = (a, b) => script.slice(script.indexOf(a), script.indexOf(b, script.indexOf(a)));
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const kb = n => Math.max(1, Math.round(Number(n || 0) / 1024)) + ' KB';

test('看板展示本次文件改动：新增/修改/删除、可撤销按钮和差异；没有改动就不占地方', () => {
  const ctx = vm.createContext({ esc, kb });
  vm.runInContext(between('const CHANGE_LABELS', 'function installArtifactActions()'), ctx);
  const panel = ctx.checkpointPanel({ checkpoint: {
    total: 3, truncated: true, rolledBackAt: null,
    changes: [
      { path: 'E:\\work\\a.txt', kind: 'modified', restorable: true, addedLines: 1, removedLines: 1, diff: '-old\n+new\n<script>alert(1)</script>' },
      { path: 'E:\\work\\new.txt', kind: 'added', restorable: true, addedLines: 1, diff: '+hello' },
      { path: 'E:\\work\\b.txt', kind: 'deleted', restorable: false, reason: '执行前没有备份', removedLines: 2 },
    ],
  } });
  assert.match(panel, /本次文件改动/); assert.match(panel, /新增/); assert.match(panel, /修改/); assert.match(panel, /删除/);
  assert.match(panel, /data-rollback="E:\\work\\a.txt"/); assert.match(panel, /撤销全部可恢复文件/);
  assert.match(panel, /<pre class="diff">/); assert.match(panel, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(panel, /<script>alert/);
  assert.match(panel, /执行前没有备份/);
  assert.equal(ctx.checkpointPanel({}), '');
  assert.equal(ctx.checkpointPanel({ checkpoint: { changes: [] } }), '');
});

test('撤销入口存在，并走 run_rollback 的 dryRun 预览 + 确认', () => {
  assert.match(script, /run_rollback/);
  assert.match(script, /dryRun: true/);
  assert.match(script, /撤销本次文件改动/);
  assert.match(html, /data-rollback-all/);
});

test('检查点文件被清理后只展示记录，不再给撤销按钮', () => {
  const ctx = vm.createContext({ esc, kb });
  vm.runInContext(between('const CHANGE_LABELS', 'function installArtifactActions()'), ctx);
  const panel = ctx.checkpointPanel({ checkpoint: { expired: true, total: 1, changes: [{ path:'E:\\work\\a.txt', kind:'modified', restorable:false, reason:'检查点已过期或已清理，无法撤销', addedLines:1, removedLines:1 }] } });
  assert.match(panel, /检查点已过期/); assert.match(panel, /不能再撤销/);
  assert.doesNotMatch(panel, /data-rollback=/);
});

test('完整撤销的每一行显示已撤销；部分撤销只对剩余文件给按钮', () => {
  const ctx = vm.createContext({ esc, kb });
  vm.runInContext(between('const CHANGE_LABELS', 'function installArtifactActions()'), ctx);
  const changes = [
    { path:'E:\\work\\a.txt', kind:'modified', restorable:true, addedLines:1, removedLines:1 },
    { path:'E:\\work\\b.txt', kind:'modified', restorable:true, addedLines:1, removedLines:1 },
  ];
  const full = ctx.checkpointPanel({ checkpoint: { total:2, changes, rolledBackAt:'2026-10-19T00:00:00Z', rolledBackPaths: changes.map(c => c.path) } });
  assert.equal((full.match(/已撤销/g) || []).length >= 3, true);
  assert.doesNotMatch(full, /data-rollback/);
  const partial = ctx.checkpointPanel({ checkpoint: { total:2, partial:true, changes, rolledBackAt:'2026-10-19T00:00:00Z', rolledBackPaths:[changes[0].path] } });
  assert.match(partial, /部分撤销/);
  assert.equal((partial.match(/data-rollback=/g) || []).length, 1);
});

test('改动列表被截断时明确告诉客户还有多少条未显示', () => {
  const ctx = vm.createContext({ esc, kb });
  vm.runInContext(between('const CHANGE_LABELS', 'function installArtifactActions()'), ctx);
  const panel = ctx.checkpointPanel({ checkpoint: { total: 5, changes: [{ path:'E:\\a', kind:'modified', restorable:false }, { path:'E:\\b', kind:'modified', restorable:false }] } });
  assert.match(panel, /还有 3 个改动未显示/);
});
