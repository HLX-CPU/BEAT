import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deepseekInstallCandidates, deepseekProfileCandidates, detectDeepseekRuntime, applyDeepseekRuntime, deepseekHomeCandidates, findDeepseekSessionHome } from '../src/deepseek-runtime.mjs';
import { nativeAvailability } from '../src/native-runtime.mjs';

// 这些用例锁定"客户机器上装在哪都能被发现、没登录时给人话提示"，
// 防止再把开发机绝对路径（D:/deepseek）写回默认配置。
const localAppData = path.join('C:', 'Users', 'x', 'AppData', 'Local');
const fakeEnv = {
  LOCALAPPDATA: localAppData,
  ProgramFiles: path.join('C:', 'Program Files'),
  ProgramData: path.join('C:', 'ProgramData'),
  APPDATA: path.join('C:', 'Users', 'x', 'AppData', 'Roaming'),
};
const norm = p => String(p).replace(/\\/g, '/').toLowerCase();

test('安装位置候选：标准目录 + 自定义安装（注册表/快捷方式/进程发现）都要覆盖', () => {
  const custom = path.join('D:', 'custom', 'DeepSeek Harness.exe');
  const list = deepseekInstallCandidates({ deepseek: {} }, fakeEnv, { systemInstalls: () => [custom] });
  const paths = list.map(norm);
  for (const want of [
    path.join(fakeEnv.ProgramFiles, 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    custom,
  ]) assert.ok(paths.includes(norm(want)), '缺少候选：' + want);
});

test('登录配置候选：DSH_HOME、配置 home、用户目录、安装目录旁都要探测', () => {
  const list = deepseekProfileCandidates({ deepseek: { home: path.join('E:', 'dsdata') } }, { DSH_HOME: path.join('F:', 'dsh') }, path.join('D:', 'Apps', 'DeepSeek Harness.exe'));
  const paths = list.map(norm);
  assert.ok(paths.includes(norm(path.join('E:', 'dsdata', 'profiles', 'desktop', 'cordis.patch.yml'))));
  assert.ok(paths.includes(norm(path.join('F:', 'dsh', 'profiles', 'desktop', 'cordis.patch.yml'))));
  assert.ok(paths.includes(norm(path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'))), '应包含用户目录下的 .dsh');
  assert.ok(paths.some(p => p.startsWith(norm(path.join('D:', 'Apps', 'dsh-data')))), '应包含安装目录旁的 dsh-data');
});

test('检测：注入文件系统后能组装出 executable / cli / 登录配置 / DSH_HOME', () => {
  const exe = path.join('D:', 'Apps', 'DeepSeek Harness.exe');
  const asar = path.join('D:', 'Apps', 'resources', 'app.asar');
  const profile = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  const exists = p => [exe, asar, profile].includes(p);
  const runtime = detectDeepseekRuntime({ deepseek: {} }, { LOCALAPPDATA: localAppData }, { exists, systemInstalls: () => [exe] });
  assert.equal(runtime.executable, exe);
  assert.equal(runtime.cli, path.join('D:', 'Apps', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'));
  assert.equal(runtime.profileFile, profile);
  assert.equal(norm(runtime.home), norm(path.join(os.homedir(), '.dsh')));
});

test('只填空缺项：客户/上次保存的显式路径优先', () => {
  const explicit = path.join('E:', 'real', 'DeepSeek Harness.exe');
  const exists = p => p === explicit;
  const config = { deepseek: { executable: explicit, cli: '', profileFile: '', home: '' } };
  applyDeepseekRuntime(config, fakeEnv, { exists, systemInstalls: () => [] });
  assert.equal(config.deepseek.executable, explicit);
});

test('没装桌面端：给出安装/登录指引与拓展坞替代', () => {
  const probe = { deepseekRuntime: () => ({ executable: '', cli: '', profileFile: '' }) };
  const r = nativeAvailability({ deepseek: {} }, 'deepseek', probe);
  assert.equal(r.installed, false);
  assert.equal(r.available, false);
  assert.match(r.reason, /安装后打开一次/);
  assert.match(r.reason, /拓展坞/);
});

test('装了但没登录：明确说"打开登录一次即可，之后不用保持运行"', () => {
  const probe = { deepseekRuntime: () => ({ executable: path.join('D:', 'x', 'DeepSeek Harness.exe'), cli: path.join('D:', 'x', 'resources', 'app.asar'), profileFile: '' }) };
  const r = nativeAvailability({ deepseek: {} }, 'deepseek', probe);
  assert.equal(r.installed, true);
  assert.equal(r.available, false);
  assert.match(r.reason, /首次登录/);
  assert.match(r.reason, /不用保持运行/);
});

test('缺少后台执行组件：提示升级或改用拓展坞', () => {
  const probe = { deepseekRuntime: () => ({ executable: path.join('D:', 'x', 'DeepSeek Harness.exe'), cli: '', profileFile: path.join('C:', 'x', 'cordis.patch.yml') }) };
  const r = nativeAvailability({ deepseek: {} }, 'deepseek', probe);
  assert.equal(r.available, false);
  assert.match(r.reason, /升级到最新版/);
  assert.match(r.reason, /拓展坞/);
});

test('安装齐全且已登录：搭档可用（不要求桌面端进程正在运行）', () => {
  const probe = { deepseekRuntime: () => ({ executable: path.join('D:', 'x', 'DeepSeek Harness.exe'), cli: path.join('D:', 'x', 'resources', 'app.asar'), profileFile: path.join('C:', 'Users', 'x', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml') }) };
  const r = nativeAvailability({ deepseek: {} }, 'deepseek', probe);
  assert.equal(r.installed, true);
  assert.equal(r.available, true);
  assert.equal(r.toolsVerified, false);
});

test('固定会话换了 DSH_HOME 仍按会话文件实际位置找到原目录（R408 回归）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-session-home-'));
  const oldHome = path.join(root, 'old-home');
  const newHome = path.join(root, 'new-home');
  const nativeId = 'session-f66e1872-88e8-41f9-a8b0-135c56d4c70c';
  fs.mkdirSync(path.join(oldHome, 'sessions', '--E-beat-R408--', nativeId), { recursive: true });
  fs.writeFileSync(path.join(oldHome, 'sessions', '--E-beat-R408--', nativeId, 'session.v4.jsonl.zstd'), 'x');
  fs.mkdirSync(path.join(newHome, 'sessions'), { recursive: true });
  // 当前环境指着新目录，但会话实际在旧目录：以文件为准，不能按当前环境报“不存在”。
  assert.equal(path.resolve(findDeepseekSessionHome(nativeId, { config: { deepseek: { home: oldHome } }, env: { DSH_HOME: newHome } })), path.resolve(oldHome));
  // 候选顺序：显式配置 → 当前 DSH_HOME → 用户默认 .dsh
  assert.deepEqual(deepseekHomeCandidates({ deepseek: { home: oldHome } }, { DSH_HOME: newHome }).map(p => path.resolve(p)),
    [path.resolve(oldHome), path.resolve(newHome), path.resolve(os.homedir(), '.dsh')]);
  // 找不到就是 null，不猜；非法 ID 不扫描目录
  assert.equal(findDeepseekSessionHome('session-does-not-exist', { config: {}, env: { DSH_HOME: newHome } }), null);
  assert.equal(findDeepseekSessionHome('../escape', { config: {}, env: { DSH_HOME: newHome } }), null);
  fs.rmSync(root, { recursive: true, force: true });
});
