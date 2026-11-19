// path-containment：路径包含判断的唯一实现。
// 2026-10-24 审查发现同样的判断在 4 个文件各写一份、细节互不相同；
// 这是安全敏感逻辑，统一后必须有自己的 junction/越界回归网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { insideDirectory, realPathSafe, insideReal, insideAnyReal } from '../src/path-containment.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

test('insideDirectory 词法判断：相等/子路径/兄弟/上级/绝对越界', () => {
  const root = 'E:\\proj\\work';
  assert.equal(insideDirectory(root, root), true, '根本身算在内');
  assert.equal(insideDirectory(root, 'E:\\proj\\work\\a\\b.txt'), true);
  assert.equal(insideDirectory(root, 'E:\\proj\\work2\\a.txt'), false, '前缀相同但路径段不同不算');
  assert.equal(insideDirectory(root, 'E:\\proj\\other'), false);
  assert.equal(insideDirectory(root, 'E:\\other'), false);
  assert.equal(insideDirectory(root, 'C:\\proj\\work'), false);
});

test('insideDirectory 不要求路径存在，也不解析链接（调用方语义保留）', t => {
  const dir = cleanup(t, tempDir('containment-lexical'));
  assert.equal(insideDirectory(dir, path.join(dir, '不存在的文件.txt')), true);
});

test('realPathSafe：文件本身不存在时回退到已存在父目录 + 文件名；多层缺失时退回词法解析', t => {
  const dir = cleanup(t, tempDir('containment-real'));
  const fold = p => (process.platform === 'win32' ? p.toLowerCase() : p);
  // 一层缺失（原 checkpoint 语义：文件未落盘、父目录存在）
  const missing = path.join(dir, 'file.txt');
  assert.equal(fold(path.dirname(realPathSafe(missing))), fold(fs.realpathSync.native(dir)), '父目录按真实路径解析');
  assert.equal(path.basename(realPathSafe(missing)), 'file.txt');
  // 多层缺失：祖先解析不到，退回词法 resolve（由调用方的包含判断兜底）
  const deep = path.join(dir, 'no-such-dir', 'file.txt');
  assert.equal(fold(realPathSafe(deep)), fold(path.resolve(deep)), '多层缺失退回词法解析，不抛错');
});

test('insideReal 拒绝经 junction 逃逸出允许目录', t => {
  const dir = cleanup(t, tempDir('containment-junction'));
  const root = path.join(dir, 'allowed');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  // junction 指向允许目录之外：真实路径判断必须拒绝，词法判断看不出问题
  const link = path.join(root, 'jump');
  fs.symlinkSync(outside, link, 'junction');
  const smuggled = path.join(link, 'secret.txt');
  assert.equal(insideDirectory(root, smuggled), true, '词法判断会被 junction 骗过（这就是要有真实路径判断的原因）');
  assert.equal(insideReal(root, smuggled), false, '真实路径判断必须拒绝');
  // 正常文件不受影响
  fs.writeFileSync(path.join(root, 'ok.txt'), 'x');
  assert.equal(insideReal(root, path.join(root, 'ok.txt')), true);
  // 允许目录本身经 junction 别名访问时，两边都解析后仍然一致
  assert.equal(insideReal(link, path.join(link, 'secret.txt')), true, 'root 本身是 junction 时按真实路径比较');
});

test('insideReal：目标不存在时按最近已存在祖先判断', t => {
  const dir = cleanup(t, tempDir('containment-missing'));
  const root = path.join(dir, 'allowed');
  fs.mkdirSync(root);
  assert.equal(insideReal(root, path.join(root, 'new', 'deep', 'file.txt')), true);
  assert.equal(insideReal(root, path.join(dir, 'elsewhere', 'file.txt')), false);
});

test('insideAnyReal：多根任一命中即可', t => {
  const dir = cleanup(t, tempDir('containment-roots'));
  const a = path.join(dir, 'a'), b = path.join(dir, 'b'), c = path.join(dir, 'c');
  for (const d of [a, b, c]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(b, 'f.txt'), 'x');
  assert.equal(insideAnyReal([a, b], path.join(b, 'f.txt')), true);
  assert.equal(insideAnyReal([a, b], path.join(c, 'f.txt')), false);
  assert.equal(insideAnyReal([], path.join(a, 'f.txt')), false, '空根列表不含任何路径');
});
