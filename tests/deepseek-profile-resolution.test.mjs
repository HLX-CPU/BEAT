import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deepseekProfileFor, deepseekModels } from '../src/deepseek.mjs';
import { Models } from '../src/models.mjs';
import { defaults } from '../src/config.mjs';
import { TOOLS } from '../src/tools.mjs';
import { customerIssue } from '../src/customer-issue.mjs';

const PROFILE = [
  '- id: agent-default-model',
  '  config:',
  '    provider: deepseek-account',
  '    model: deepseek-flash',
  '    reasoningEffort: high',
  '- id: llm-deepseek-account',
  '  config:',
  '    models:',
  '      - id: deepseek-flash',
  '      - id: deepseek-v4-pro',
  '',
].join('\n');

function fixture(t, { loggedIn = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-ds-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'dsh-home');
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true });
  const file = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  if (loggedIn) fs.writeFileSync(file, PROFILE);
  const base = defaults(root);
  const config = {
    ...base, root, dataDir: path.join(root, 'data'), secrets: {},
    codex: { ...base.codex, home: path.join(root, 'codex') },
    deepseek: { ...base.deepseek, home, profileFile: '', executable: '', cli: '' },
  };
  return { root, home, file, config };
}

// 回归：2.2.99 把默认 profileFile 改为空字符串后，models.list/设置页仍把空字符串当路径，
// 客户点「开始」会弹出一句没有下文的「无法解析 DeepSeek 默认模型：」并挡住任务。
test('空 profileFile 不再当路径用：按自动发现读桌面端登录配置', (t) => {
  const { config, file } = fixture(t);
  const { profile, file: resolved } = deepseekProfileFor(config, { runtime: {} });
  assert.equal(profile.provider, 'deepseek-account');
  assert.equal(profile.model, 'deepseek-flash');
  assert.equal(resolved, file);
  // 真实发现路径（不注入）也必须先认客户配置的 home，而不是开发机默认目录。
  assert.equal(deepseekProfileFor(config).profile.model, 'deepseek-flash');
});

test('发现结果只在缺失时补位：客户显式配置的登录文件优先', (t) => {
  const { root, config } = fixture(t);
  const other = path.join(root, 'other.yml');
  fs.writeFileSync(other, PROFILE.replace('deepseek-flash', 'deepseek-v4-pro'));
  config.deepseek.profileFile = other;
  const picked = deepseekProfileFor(config, { runtime: { profileFile: path.join(root, 'not-used.yml') } });
  assert.equal(picked.file, other);
  assert.equal(picked.profile.model, 'deepseek-v4-pro');
});

test('自动发现到登录文件时，即使没有配置 home/profileFile 也能读出模型', (t) => {
  const { file, home } = fixture(t);
  const { profile, file: resolved } = deepseekProfileFor({ deepseek: {} }, { runtime: { profileFile: file, home } });
  assert.equal(profile.model, 'deepseek-flash');
  assert.equal(resolved, file);
});

test('model_list 不再因空的 profileFile 抛内部错误（客户点开始/保存设置会走这里）', async (t) => {
  const { config, file } = fixture(t);
  const models = new Models(config, { deepseekRuntime: () => ({ profileFile: file }) });
  const list = await models.list('deepseek');
  assert.deepEqual(list.models.map(m => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(deepseekModels(file).map(m => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
});

test('没有登录时给可执行的下一步：不出现悬空冒号，也不把内部路径当提示', (t) => {
  const { config } = fixture(t, { loggedIn: false });
  assert.throws(() => deepseekProfileFor(config, { runtime: {} }), (error) => {
    assert.equal(error.deepseekNotReady, true);
    assert.match(error.message, /DeepSeek 桌面端还没有准备好/);
    assert.match(error.message, /打开 DeepSeek Harness 登录一次/);
    assert.doesNotMatch(error.message, /：$/);
    assert.doesNotMatch(error.message, /\.yml/);
    assert.match(String(error.detail), /cordis\.patch\.yml/);
    return true;
  });
});

test('没有登录时 model_list 的失败原因也是人话，不是空的「无法解析…：」', async (t) => {
  const { config } = fixture(t, { loggedIn: false });
  const models = new Models(config, { deepseekRuntime: () => ({}) });
  await assert.rejects(() => models.list('deepseek'), (error) => {
    assert.match(error.message, /DeepSeek 桌面端还没有准备好/);
    assert.match(error.message, /登录/);
    assert.doesNotMatch(error.message, /：$/);
    return true;
  });
});

// 这台机器上可能真的装了 DeepSeek，所以这里只锁「人话」：要么显示模型，要么显示登录提示，
// 绝不能再出现 2.2.99 那种没有下文的「无法解析 DeepSeek 默认模型：」。
test('设置页的 DeepSeek 状态永远是人话，不出现内部错误或悬空冒号', (t) => {
  const { config } = fixture(t, { loggedIn: false });
  const view = TOOLS.settings_get.run({ config }, {});
  assert.doesNotMatch(view.detected.deepseekModel, /：$/);
  assert.doesNotMatch(view.detected.deepseekModel, /无法解析/);
  assert.match(view.detected.deepseekModel, /deepseek-account|登录/);
});

test('设置页在已登录时显示桌面端真实模型', (t) => {
  const { config } = fixture(t);
  const view = TOOLS.settings_get.run({ config }, {});
  assert.match(view.detected.deepseekModel, /deepseek-account \/ deepseek-flash/);
});

test('历史失败记录里的旧「无法解析 DeepSeek 默认模型：」升级后也翻译成人话', (t) => {
  const issue = customerIssue('无法解析 DeepSeek 默认模型：');
  assert.equal(issue.title, 'DeepSeek 桌面端还没有准备好');
  assert.match(issue.message, /打开 DeepSeek Harness 登录一次/);
  assert.match(issue.message, /拓展坞/);
  assert.doesNotMatch(issue.message, /：$/);
});
