import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { absolutePathTargets, withinDirectory } from '../src/orchestrator.mjs';

test('目标里写出的绝对路径被识别，并判断是否位于用户目录内（R412 回归）', () => {
  const root = path.resolve('E:\\beat\\workspaces\\ux-test-20261018');
  const goal = '在 E:\\beat\\workspaces\\ux-test-20261018 下创建 a.txt 和 b.txt，完成后告诉我。';
  const targets = absolutePathTargets(goal);
  assert.ok(targets.some(target => target === root), '根目录本身要被识别');
  assert.equal(withinDirectory(root, root), true);
  assert.equal(withinDirectory(root, path.join(root, 'a.txt')), true);
  assert.equal(withinDirectory(root, path.resolve('E:\\beat\\workspaces\\shared\\x.txt')), false);
  assert.equal(absolutePathTargets('没有绝对路径的一句话').length, 0);
});
