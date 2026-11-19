// 交付物「点击打开」：只允许打开允许范围内的真实文件/文件夹，用系统默认程序打开（不执行内容）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOpenable, openableRoots } from '../src/reveal.mjs';
import { describeRenderEvidence } from '../src/html-render-verification.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-reveal-'));
  const workspace = path.join(root, 'workspaces', 'shared');
  fs.mkdirSync(workspace, { recursive: true });
  const file = path.join(workspace, 'delivery.html');
  fs.writeFileSync(file, '<html><svg></svg></html>');
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  const desktop = path.join(root, 'Desktop'); fs.mkdirSync(desktop, { recursive: true });
  const desktopFile = path.join(desktop, 'note.txt'); fs.writeFileSync(desktopFile, 'hi');
  const config = { root, workspace, allowedRoots: [path.join(root, 'workspaces')] };
  return { config, workspace, file, outside, desktop, desktopFile, userFolders: { desktop, documents: null, downloads: null } };
}

test('点击打开：工作目录和桌面里的文件可以打开，范围外/不存在/相对路径一律拒绝', () => {
  const f = fixture();
  assert.deepEqual(openableRoots(f.config, f.userFolders).sort(), [f.desktop, path.join(f.config.root, 'workspaces'), f.workspace].sort());
  const ok = resolveOpenable(f.config, f.file, { userFolders: f.userFolders });
  assert.equal(ok.path, fs.realpathSync(f.file)); assert.equal(ok.isDirectory, false);
  const folder = resolveOpenable(f.config, f.workspace, { userFolders: f.userFolders });
  assert.equal(folder.isDirectory, true);
  const onDesktop = resolveOpenable(f.config, f.desktopFile, { userFolders: f.userFolders });
  assert.equal(onDesktop.path, fs.realpathSync(f.desktopFile));
  assert.throws(() => resolveOpenable(f.config, f.outside, { userFolders: f.userFolders }), /不在 BEAT 允许打开的范围内/);
  assert.throws(() => resolveOpenable(f.config, path.join(f.workspace, 'missing.html'), { userFolders: f.userFolders }), /不存在/);
  assert.throws(() => resolveOpenable(f.config, 'delivery.html', { userFolders: f.userFolders }), /完整路径/);
  assert.throws(() => resolveOpenable(f.config, '', { userFolders: f.userFolders }), /完整路径/);
});

// 用户看到执行者自己写"浏览器效果未验证"就以为没验：BEAT 控制器的真实浏览器核验必须出现在报告里。
test('报告里要显示 BEAT 自己的浏览器核验（执行者自述不覆盖控制器证据）', () => {
  const line = describeRenderEvidence([{
    file: 'E:\\beat\\workspaces\\shared\\pelican-bike.html', sha256: 'abc', status: 'rendered', browser: 'Chrome/154.0.8037.98',
    structure: { title: '鹈鹕的海岸骑行', svg: 1, viewBox: '0 0 960 580', scripts: 0, animations: [{ name: 'turn' }, { name: 'cloud' }] },
    cycleMilliseconds: 1800, exactLoopFramesEqual: true, screenshots: ['a.png', 'b.png'], evidencePath: 'E:\\beat\\workspaces\\shared\\.beat-control\\R136\\verification\\evidence.json',
  }]);
  assert.match(line, /BEAT 独立核验（后台浏览器实际渲染，非模型自述）/);
  assert.match(line, /Chrome\/154/);
  assert.match(line, /SVG 1 个 · 动画 2 个（循环 1800ms，首尾帧一致）/);
  assert.match(line, /截图 2 张/);
  assert.match(line, /evidence\.json/);
  assert.equal(describeRenderEvidence([]), '', '没有核验记录时不塞噪音');
  assert.match(describeRenderEvidence([{ file: 'x.html', status: 'unverified', issue: '后台浏览器暂不可用' }]), /BEAT 浏览器核验未完成：x\.html（unverified：后台浏览器暂不可用）/);
});
