import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const between = (a,b) => script.slice(script.indexOf(a), script.indexOf(b, script.indexOf(a)));
const FENCE = String.fromCharCode(96).repeat(3);
function ctx() {
  const c = vm.createContext({ String });
  vm.runInContext("const esc = s => String(s ?? '').replace(/[&<>\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[ch]));\n" + between('const FILE_PATH_RE', 'async function openDelivered'), c);
  return c;
}
test('恶意 HTML / 脚本经生产链路 mdLite(linkify(...)) 后不会复活', () => {
  const c = ctx();
  const inputs = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    '[x](javascript:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    FENCE + 'html\n<script>alert(1)</script>\n' + FENCE,
    '| <img src=x onerror=alert(1)> | b |\n| --- | --- |\n| <script>alert(1)</script> | 2 |',
  ];
  for (const input of inputs) {
    const out = c.mdLite(c.linkify(input));
    assert.doesNotMatch(out, /<script/i, out);
    assert.doesNotMatch(out, /<img/i, out);
  }
});
