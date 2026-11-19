import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const context = vm.createContext({
  esc, isDockId: id => String(id).startsWith('dock:'), AG: { codex: 'Codex', deepseek: 'DeepSeek', claude: 'Claude' },
  ROLE_OF: { codex: '桌面端搭档', deepseek: '桌面端搭档', claude: '顾问 · 只读' },
  STATUS: { online: '在线', offline: '离线', cooldown: '冷却中', paused: '已暂停', unconfigured: '未配置' },
  effortLabel: value => ({ high: '高', low: '低' }[value] || value), Math, Object, Array, String, Map,
});
const start = script.indexOf('function capabilityMatrixHtml(');
const end = script.indexOf('function renderCapabilityMatrix()', start);
assert.ok(start > 0 && end > start);
vm.runInContext(script.slice(start, end), context);

test('能力矩阵：文件/电脑/看图/推理强度分别标出已验证和待验证，不把"没测过"写成会用', () => {
  const box = context.capabilityMatrixHtml([
    { agent: 'codex', status: 'online', native: { toolsVerified: true, capabilities: { fileDelivery: true, desktopAction: false } } },
    { agent: 'deepseek', status: 'online', native: { toolsVerified: false, capabilities: {} } },
    { agent: 'claude', status: 'online', advisor: { enabled: true } },
    { agent: 'dock:d1', status: 'online' },
  ], [{ id: 'dock:d1', name: '我的模型', tools: 'supported', vision: true, defaultEffort: 'high', enabled: true }]);
  assert.match(box, /Codex/); assert.match(box, /DeepSeek/); assert.match(box, /我的模型/);
  assert.match(box, /有通过记录/); assert.match(box, /待验证（跑一次打开\/操作任务）/);
  assert.match(box, /可读写（电脑助手，已测）/); assert.match(box, /可看图/); assert.match(box, /高/);
  assert.match(box, /待验证.*不是不能用/);
});

test('能力矩阵没有搭档时给下一步，而不是空白', () => {
  assert.match(context.capabilityMatrixHtml([], []), /还没有可用搭档/);
});

test('首次引导：有在线搭档时出现，收起后不再打扰，没有搭档时让位给连接提示', () => {
  const box = { hidden: true, innerHTML: '' };
  const make = (ready, dismissed) => vm.createContext({
    $: id => id === 'firstRunGuide' ? box : null, READY_PARTNERS: ready, GUIDE_KEY: 'beat.guide.dismissed.v1', localStorage: { getItem: () => dismissed ? '1' : null },
  });
  const extract = (ctx) => { vm.runInContext(script.slice(script.indexOf('function guideIsDismissed()'), script.indexOf('function capabilityMatrixHtml(')), ctx); return ctx; };
  let ctx = extract(make(['codex'], false)); ctx.renderFirstRunGuide(); assert.equal(box.hidden, false);
  ctx = extract(make(['codex'], true)); ctx.renderFirstRunGuide(); assert.equal(box.hidden, true);
  ctx = extract(make([], false)); ctx.renderFirstRunGuide(); assert.equal(box.hidden, true);
});

test('首页有三步引导、能力矩阵入口和示例按钮', () => {
  assert.match(html, /三步开始/);
  assert.match(html, /各位搭档能做什么（能力矩阵）/);
  assert.match(html, /用示例试一下/);
  assert.match(html, /搭档与操作方式（可选）/);
  assert.match(script, /renderFirstRunGuide\(\);/);
});
