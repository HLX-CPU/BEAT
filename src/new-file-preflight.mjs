import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// A shared, read-only barrier before any creator is dispatched. Workers still
// exclusively create their own file: this is not permission to overwrite.
export function newFilePreflight(run, plan) {
  if (!/(?:新建|创建)/.test(run.goal || '') || !/(?:不覆盖|禁止覆盖|不能覆盖|已有[^。\n]{0,25}停止)/.test(run.goal || '')) return null;
  const positive = String(run.goal).split(/[。；;，,\n]/).filter(clause => !/^\s*(?:请)?(?:不要|禁止|不得|不能|不许|无需|不用|不)/.test(clause)).join('。');
  if (/修改|更新|编辑|追加|重命名|移动|复制|删除/.test(positive)) return null;
  if (!plan?.tasks?.length || plan.tasks.some(task => task.type && task.type !== 'workspace')) return null;
  const raw = [...new Set(plan.tasks.flatMap(task => task.files || []))];
  if (!raw.length || raw.length > 8 || raw.some(file => typeof file !== 'string' || /[*?]/.test(file) || !/\.(?:txt|md|csv|json)$/i.test(file))) return null;
  const files = raw.map(file => path.resolve(run.cwd, file));
  if (files.some(file => { const rel = path.relative(run.cwd, file); return !rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel); })) return null;
  const rows = files.map(file => {
    try { fs.lstatSync(file); return { path: file, existedBefore: true }; }
    catch (error) { if (error.code === 'ENOENT') return { path: file, existedBefore: false }; throw error; }
  });
  return { version: 1, goalHash: createHash('sha256').update(run.goal).digest('hex'), at: new Date().toISOString(),
    pass: rows.every(row => !row.existedBefore), files: rows, method: 'controller lstat before any file-task dispatch' };
}
