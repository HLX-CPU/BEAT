// Development/release gate. ESLint reads syntax and bindings; it never executes the source.
// Upstream rule: https://eslint.org/docs/latest/rules/no-undef
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { Linter } = require('eslint');
const globals = require('globals');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const linter = new Linter();
const configuration = { languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.nodeBuiltin },
  rules: { 'no-undef': ['error', { typeof: true }], 'no-dupe-args': 'error', 'no-dupe-keys': 'error', 'no-unreachable': 'error' } };
export function lintSource(source, filename = 'source.mjs') {
  return linter.verify(source, [{ files: ['**/*.mjs'], ...configuration }], { filename });
}
export function checkSourceTree(base = root) {
  const results = [];
  for (const folder of ['src', 'scripts']) for (const entry of fs.readdirSync(path.join(base, folder), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const name = folder + '/' + entry.name;
    for (const diagnostic of lintSource(fs.readFileSync(path.join(base, name), 'utf8'), name)) results.push({ file: name, ...diagnostic });
  }
  return results;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Regression canaries from R294-R299 and the live stall branch. The gate must
  // reject these names even though `node --check` accepts their syntax.
  const canary = lintSource('getConfig(); isLocalAgentId("x"); console.log(round);');
  if (canary.filter(d => d.ruleId === 'no-undef').length !== 3) throw new Error('静态检查器自检未通过，未检查发布源码');
  const results = checkSourceTree();
  for (const diagnostic of results) console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message} (${diagnostic.ruleId || 'syntax'})`);
  if (results.length) process.exitCode = 1;
  else console.log('源码静态检查通过：语法、未定义变量、重复键和不可达代码');
}
