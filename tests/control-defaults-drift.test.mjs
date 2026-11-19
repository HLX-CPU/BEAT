// 买家评审 P1：看板的 token 预算默认值曾与后端差 10 倍。
// 这里锁死两件事：看板数字必须与 src/config.mjs 同源（改一处就红），
// 以及"什么都没改点保存"绝不把任何兜底数字写进 config.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { VERSION, CONTROL_FLOW_DEFAULTS, CONTROL_FLOW_LIMITS, loadConfig } from '../src/config.mjs';
import { TOOLS } from '../src/tools.mjs';
import { tempDir } from './helpers/temp.mjs';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const serverSource = fs.readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const KEYS = Object.keys(CONTROL_FLOW_LIMITS);

function fixture() {
  // 走系统 temp：生产 data/ 里不该出现 control-defaults-drift-* 残留。
  const root = tempDir('defaults-drift');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ workspace: root }));
  return loadConfig(root);
}
function dashboardSeed() {
  const block = /const CONTROL_NUMERIC_SEED = \{([\s\S]*?)\n\};/.exec(html)?.[1];
  assert.ok(block, 'web/index.html 必须保留 CONTROL_NUMERIC_SEED 兜底表');
  const table = {};
  for (const [, key, def, min, max] of block.matchAll(/(\w+):\s*\{\s*default:\s*(-?\d+),\s*min:\s*(-?\d+),\s*max:\s*(-?\d+)\s*\}/g)) table[key] = { default: Number(def), min: Number(min), max: Number(max) };
  return table;
}
function dashboardHarness() {
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const fields = new Map();
  const $ = id => { if (!fields.has(id)) fields.set(id, { value: '', innerHTML: '', selectedOptions: [], querySelectorAll() { return this.selectedOptions; } }); return fields.get(id); };
  const context = vm.createContext({ $, esc, nameOf: id => id, READY_PARTNERS: ['codex', 'deepseek', 'dock:ready'] });
  vm.runInContext(script.slice(script.indexOf('const CONTROL_FIELDS = ['), script.indexOf("$('toggleSettings').onclick")), context);
  return { context, $ };
}
const patchOf = context => JSON.parse(JSON.stringify(context.readControlSettings()));

test('看板兜底数字必须与后端 CONTROL_FLOW_DEFAULTS / CONTROL_FLOW_LIMITS 逐字段一致（改一处就红）', () => {
  const seed = dashboardSeed();
  assert.deepEqual(Object.keys(seed).sort(), [...KEYS].sort(), 'index.html 兜底表字段列表必须与后端一致');
  for (const key of KEYS) {
    assert.deepEqual(seed[key], { default: CONTROL_FLOW_DEFAULTS[key], min: CONTROL_FLOW_LIMITS[key].min, max: CONTROL_FLOW_LIMITS[key].max }, key + '：看板兜底值必须等于后端');
    assert.equal(CONTROL_FLOW_LIMITS[key].default, CONTROL_FLOW_DEFAULTS[key], key + '：CONTROL_FLOW_LIMITS.default 必须来自 CONTROL_FLOW_DEFAULTS');
    assert.ok(CONTROL_FLOW_LIMITS[key].min <= CONTROL_FLOW_LIMITS[key].default && CONTROL_FLOW_LIMITS[key].default <= CONTROL_FLOW_LIMITS[key].max, key + '：默认值必须落在上下限内');
  }
});

test('CONTROL_FIELDS 不再内联预算数字，渲染与校验都用服务端返回的表', () => {
  const block = /const CONTROL_FIELDS = \[([\s\S]*?)\n\];/.exec(html)[1];
  for (const key of KEYS) {
    const line = block.split('\n').find(l => l.includes(`'${key}'`));
    assert.ok(line, 'CONTROL_FIELDS 缺少 ' + key);
    assert.match(line, new RegExp(`\\['${key}',\\s*'[^']*',\\s*null,`), key + ' 不应在 CONTROL_FIELDS 里内联默认值');
    assert.doesNotMatch(line, /\d{4,}/, key + ' 行不应再出现写死的预算数字');
  }
  assert.match(html, /renderControlSettings\(s\.flow \|\| \{\}, s\.controlLimits\)/, '看板必须把服务端返回的 controlLimits 交给渲染函数');
});

test('settings_get 随 flow 返回同一张表：前端拿到的就是后端的事实来源', () => {
  const view = TOOLS.settings_get.run({ config: fixture() });
  assert.deepEqual(JSON.parse(JSON.stringify(view.controlLimits)), JSON.parse(JSON.stringify(CONTROL_FLOW_LIMITS)));
  for (const key of KEYS) assert.equal(view.flow[key], CONTROL_FLOW_DEFAULTS[key], key);
});

test('服务端返回什么默认值看板就显示什么；什么都没改点保存绝不回写任何数字', () => {
  const { context, $ } = dashboardHarness();
  const flow = { ...CONTROL_FLOW_DEFAULTS };
  for (const key of KEYS) delete flow[key];   // 模拟旧 config.json / 老后端没返回这些字段
  context.renderControlSettings(flow, CONTROL_FLOW_LIMITS);
  $('sCheapAgents').selectedOptions = [{ value: 'deepseek' }];
  for (const key of KEYS) assert.equal($('cf_' + key).value, String(CONTROL_FLOW_LIMITS[key].default), key + ' 必须按服务端返回的默认值渲染');
  assert.deepEqual(patchOf(context), {}, '什么都没改就不该回写任何字段');
  $('cf_taskTokenBudget').value = '64000';   // 用户真的改了才回写
  assert.deepEqual(patchOf(context), { taskTokenBudget: 64000 });
  $('cf_taskTokenBudget').value = '10000001';
  assert.throws(() => context.readControlSettings(), /256 到 10000000/);

  // 服务端表与本地兜底不一致时，以后端为准；此时"没改"依旧不写盘。
  const { context: c2, $: $2 } = dashboardHarness();
  const shifted = { ...CONTROL_FLOW_LIMITS, taskTokenBudget: { default: 1280000, min: 256, max: 10000000 } };
  c2.renderControlSettings({ ...flow, taskTokenBudget: undefined }, shifted);
  $2('sCheapAgents').selectedOptions = [{ value: 'deepseek' }];
  assert.equal($2('cf_taskTokenBudget').value, '1280000', '后端默认值优先于看板兜底');
  assert.deepEqual(patchOf(c2), {}, '后端已给出的默认值不该被当成用户改动');
});

test('版本号三处一致：package.json 与 /health.version 跟随 VERSION，接口兼容版本单独保留', async t => {
  assert.equal(pkg.version, VERSION, 'package.json 版本必须跟随 src/config.mjs 的 VERSION');
  assert.doesNotMatch(serverSource, /version:\s*'2\.1\.0'/, '/health.version 不能硬编码旧版本');
  assert.match(serverSource, /version:\s*VERSION/, '/health.version 必须读 VERSION');
  const svc = await (await import('../src/server.mjs')).startServer({ config: fixture(), agents: {}, port: 0 });
  t.after(async () => { await new Promise(resolve => svc.server.close(resolve)); svc.store.close(); });
  const health = await (await fetch('http://127.0.0.1:' + svc.port + '/health')).json();
  assert.equal(health.version, VERSION);
  assert.equal(health.actualVersion, VERSION);
  assert.equal(health.apiCompatibilityVersion, '2.1.0', '接口兼容级别应保持不变');
});
