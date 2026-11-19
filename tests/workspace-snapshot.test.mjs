import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { snapshot, diffSnapshots } from '../src/workspace.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

test('目录快照不跟随符号链接/目录联接，避免自引用把快照撑爆', t => {
  const root = cleanup(t, tempDir('snapshot-loop'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  let linked = false;
  try { fs.symlinkSync(root, path.join(root, 'loop'), 'junction'); linked = true; } catch {}
  const map = snapshot(root);
  assert.equal(map.get('a.txt') !== undefined, true);
  assert.ok(map.size < 50, '快照只包含真实文件，不能把自引用目录展开：' + map.size);
  if (linked) assert.equal([...map.keys()].some(key => key.startsWith('loop')), false);
});
