// R179 回归：评审给"pass + 非严重备注"时，控制器要记备注**且不能崩**。
// 那次的崩因：compact-discussion.mjs 是模块级函数，代码里写了 this.store —— ES module 里 this 是 undefined，
// 于是报 "Cannot read properties of undefined (reading 'store')"。
// 触发条件很窄（只有 pass+备注 才走那一段），所以：
//   ① 源码级契约：那段必须用注入的 orch.store，绝不能出现裸 this.store；
//   ② 解析层行为：pass + 非严重备注必须通过并把备注挂到 notes 上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCompact } from '../src/compact-discussion.mjs';

const source = fs.readFileSync(new URL('../src/compact-discussion.mjs', import.meta.url), 'utf8');

test('compact-discussion 里不得出现裸 this.store（模块级函数，this 是 undefined）', () => {
  const bare = source.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\bthis\.(store|config|agents|queue)\b/.test(line) && !/^\s*\/\//.test(line));
  assert.equal(bare.length, 0, '这些行会在运行期崩，改成注入的 orch/store：\n' + bare.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n'));
});

test('评审备注写的是 orch.store（带注解），不是 this', () => {
  assert.match(source, /以?orch\.store\.set\(key,/, '评审备注要写进 orch.store');
  assert.match(source, /reviewNotes/, '要有 reviewNotes 记账');
});

test('解析层：pass + 非严重备注通过，且备注挂在 notes 上（供控制器记账）', () => {
  const value = parseCompact(JSON.stringify({
    verdict: 'pass', planHash: 'a'.repeat(64),
    issues: [{ section: 'sections.summary', problem: '建议执行前确认依赖可用（非阻塞）', serious: false }],
  }), 'review');
  assert.equal(value.verdict, 'pass');
  assert.equal(value.notes.length, 1, '备注要保留下来，控制器才能记进 reviewNotes');
  assert.match(value.notes[0].problem, /非阻塞/);
});
