// The test runner observes root-directory hygiene; it never deletes old evidence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = () => new Set(fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name));
const before = dirs(), env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const args = process.argv.slice(2);
const child = spawn(process.execPath, ['--test', ...(args.length ? args : ['tests/*.test.mjs'])], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => {
  const added = [...dirs()].filter(dir => !before.has(dir));
  if (added.length) console.error('测试在产品根目录留下新目录（已保留供检查）：' + added.join('、'));
  else console.log('产品根目录卫生检查通过：没有新增目录');
  process.exitCode = code === 0 && !added.length ? 0 : 1;
});
