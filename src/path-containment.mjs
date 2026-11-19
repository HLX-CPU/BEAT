// 路径包含判断的唯一实现。
//
// 为什么要有这个文件：此前同样的“target 是否在 root 内”判断在 orchestrator、
// queue-runner、checkpoint、task-queue 各写了一份，细节互不相同（是否解析链接、
// 是否先 resolve）。这是安全敏感逻辑——任何一份将来漏掉 junction/symlink 防护
// 就是越界漏洞。现在全部收敛到这里：
//  - insideDirectory：纯词法比较，不解析链接。用于两边都可能不存在的路径
//    （报告路径、声明范围等），以及第一层的快速拒绝。
//  - realPathSafe / insideReal / insideAnyReal：按真实路径解析后比较，
//    拒绝经 junction/symlink 绕过允许目录；目标不存在时校验最近的已存在祖先。

import fs from 'node:fs';
import path from 'node:path';

/** 词法包含判断：target 等于 root 或在 root 之下（不解析链接）。 */
export function insideDirectory(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** 真实路径：拒绝经 junction/symlink 绕过；文件尚不存在时校验父目录；
 *  完全无法解析时退回词法 resolve（由调用方的包含判断继续兜底）。 */
export function realPathSafe(file) {
  try { return fs.realpathSync.native(file); } catch {
    try { return path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)); } catch { return path.resolve(file); }
  }
}

/** 真实路径包含判断：root 与 target 都按真实路径解析后比较（防链接逃逸）。 */
export function insideReal(root, target) {
  const resolved = realPathSafe(target);
  const rel = path.relative(realPathSafe(root), resolved);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** 多根版本：target 在任一允许目录的真实路径内。 */
export function insideAnyReal(roots, target) {
  const resolved = realPathSafe(target);
  return (roots || []).some(root => {
    const rel = path.relative(realPathSafe(root), resolved);
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
  });
}
