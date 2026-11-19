// 用户确认的分工：检测到原生桌面端就用它自己的桌面端工具；电脑助手只给拓展坞。
// 这一组用例锁住三件事：① 提示词要求原生搭档用自己客户端的工具（shell/技能/MCP，接口优先）；
// ② 「打开 X」的目标按用户点名的词核验，不再一律当成 github.com；
// ③ 原生工具没有结构化回执时，由 BEAT 自己观察真实进程/窗口做独立核验，不采信模型自述。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openedTarget, assessNativeAction, probeDesktopApps, newDesktopApps, broughtToFront, nativeToolPrompt, actionPrompt, launchCandidates, snapshotProcesses, nativeWrittenFiles } from '../src/quick-work.mjs';
import { desktopAppLaunchFlags, DESKTOP_LAUNCH_DEFAULTS } from '../src/codex-rpc.mjs';
import { Roster } from '../src/roster.mjs';
import { writePatch } from '../src/deepseek.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifactsRoot } from './helpers/temp.mjs';

test('「打开 X」按用户点名的目标词解析，不再把 GitHub 一律当成 github.com', () => {
  assert.deepEqual(openedTarget('打开我桌面的GitHub'), { url: null, word: 'GitHub' });
  assert.deepEqual(openedTarget('帮我打开桌面端GitHub呢'), { url: null, word: 'GitHub' });
  assert.deepEqual(openedTarget('打开计算器'), { url: null, word: '计算器' });
  assert.deepEqual(openedTarget('启动一下我的记事本'), { url: null, word: '记事本' });
  assert.equal(openedTarget('打开 https://github.com/openai').url, 'https://github.com/openai');
  assert.equal(openedTarget('新建通知.txt').word, null);
});

const completedCall = { id: 'n1', tool: 'exec_command', status: 'completed', failed: false };
const nativeEvidence = over => ({ source: 'fixture', calls: [completedCall], verifiedActions: [], verification: { status: 'unverified' }, ...over });

test('原生工具没有结构化回执时：BEAT 看到真实进程/窗口出现才算完成', () => {
  const before = [{ pid: 100, process: 'explorer', title: '' }];
  const afterOk = [...before, { pid: 4242, process: 'GitHubDesktop', title: 'GitHub Desktop' }];
  const ok = assessNativeAction(nativeEvidence(), [], { goal: '打开我桌面的GitHub', beforeApps: before, afterApps: afterOk });
  assert.equal(ok.ok, true); assert.match(ok.source, /os process/);
  const miss = assessNativeAction(nativeEvidence(), [], { goal: '打开我桌面的GitHub', beforeApps: before, afterApps: [{ pid: 101, process: 'notepad', title: '记事本' }] });
  assert.equal(miss.ok, false); assert.match(miss.message, /打开目标的实际结果尚未核验/);
});

test('目标在任务开始前就已经开着且有窗口：按已满足记，但必须 BEAT 前后都看到真实窗口', () => {
  const open = { pid: 42212, process: 'GitHubDesktop', title: 'GitHub Desktop', foreground: false };
  const ok = assessNativeAction(nativeEvidence(), [], { goal: '打开我桌面的GitHub', beforeApps: [open], afterApps: [open] });
  assert.equal(ok.ok, true); assert.match(ok.source, /already satisfied/); assert.match(ok.note, /任务开始前就已经开着/);
  const trayOnly = { pid: 42212, process: 'GitHubDesktop', title: '', foreground: false };
  assert.equal(assessNativeAction(nativeEvidence(), [], { goal: '打开我桌面的GitHub', beforeApps: [trayOnly], afterApps: [trayOnly] }).ok, false, '进程在跑但没有窗口不算打开');
  assert.equal(assessNativeAction(nativeEvidence(), [], { goal: '打开我桌面的GitHub', beforeApps: [open], afterApps: [] }).ok, false, '任务结束后目标没了不算完成');
});

test('已经在跑的同类应用不算“新打开”，不能拿旧进程冒充本次结果', () => {
  const before = [{ pid: 4242, process: 'GitHubDesktop', title: 'GitHub Desktop', foreground: false }];
  assert.deepEqual(newDesktopApps(before, before), [], '同一批进程不算新出现');
  assert.equal(broughtToFront(before, before, a => /github/i.test(a.process + a.title)), false, '本来就不在前台且没变化，不算被切到前台');
});

test('原生自带结构化回执：回执里出现用户点名的目标即通过（GitHub Desktop 不再被 github.com 卡死）', () => {
  const receipt = { evidence: { sideEffects: 'app-open', verification: { status: 'verified' }, after: { windows: [{ title: 'GitHub Desktop', processName: 'GitHubDesktop.exe' }] } } };
  const ok = assessNativeAction(nativeEvidence({ verifiedActions: [receipt], verification: { status: 'verified' } }), [], { goal: '打开我桌面的GitHub' });
  assert.equal(ok.ok, true); assert.equal(ok.source, 'native structured tool receipts');
  const urlOk = assessNativeAction(nativeEvidence({ verifiedActions: [{ evidence: { sideEffects: 'app-open', verification: { status: 'verified' }, after: { url: 'https://github.com/openai' } } }], verification: { status: 'verified' } }), [], { goal: '打开 https://github.com/openai' });
  assert.equal(urlOk.ok, true);
  const wrong = assessNativeAction(nativeEvidence({ verifiedActions: [receipt], verification: { status: 'verified' } }), [], { goal: '打开我桌面的Notion' });
  assert.equal(wrong.ok, false);
});

test('进程/窗口探针只读真实进程表，命令失败时不谎报', () => {
  const seen = [];
  const run = (cmd, args) => { seen.push([cmd, args]); return { status: 0, stdout: JSON.stringify([{ pid: 5, process: 'GitHubDesktop', title: 'GitHub Desktop' }]) }; };
  const apps = probeDesktopApps('GitHub', { spawnSync: run });
  assert.equal(seen[0][0], 'powershell.exe'); assert.match(seen[0][1].join(' '), /Get-Process/);
  assert.deepEqual(apps, [{ pid: 5, process: 'GitHubDesktop', title: 'GitHub Desktop', foreground: false }]);
  assert.deepEqual(probeDesktopApps('GitHub', { spawnSync: () => { throw new Error('no powershell'); } }), []);
  assert.deepEqual(probeDesktopApps(null, { spawnSync: run }), []);
});

test('原生提示词：先用自己客户端的工具（接口/命令优先），电脑助手只给拓展坞', () => {
  for (const agent of ['codex', 'deepseek']) {
    const p = nativeToolPrompt(agent);
    assert.match(p, /使用自己桌面端的原生工具/);
    assert.match(p, /自己的命令行\/shell 工具、已安装的技能脚本、自己的 MCP/);
    assert.match(p, /BEAT 电脑助手专供拓展坞/);
    assert.doesNotMatch(p, /不能开 fullAccess、任意 Shell/);
    assert.match(p, /本步骤需要的权限已经按任务设置好/);
    assert.match(p, /不要拿“沙箱\/权限\/没有接口”当作拒绝执行的理由/);
    assert.match(p, /不要自己去改权限、关沙箱或绕过审批/);
    assert.match(p, /先核对自己环境里实际列出的工具与技能/);
  }
});

test('中文应用名和 exe 名对不上时，用模型自己启动过的可执行名核对（豆包 → Doubao.exe）', () => {
  const evidence = { calls: [{ tool: 'pwsh', status: 'completed', failed: false, record: { type: 'tool_call', tool: 'pwsh', input: { command: '$exe = "F:\\LenovoSoftstore\\Install\\doubao\\Doubao.exe"; Start-Process -FilePath $exe' } } }], verifiedActions: [], verification: { status: 'unverified' } };
  assert.deepEqual(launchCandidates(evidence), ['doubao'], '只取真实应用名，不把 shell/工具宿主当目标');
  const toolOnly = { calls: [{ tool: 'pwsh', record: { input: { command: '"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.5.0_x64__8wekyb3d8bbwe\\pwsh.exe" -Command "Get-Process"' } } }] };
  assert.deepEqual(launchCandidates(toolOnly), [], 'pwsh/powershell/node 这类执行宿主不算被打开的应用');
  const before = [{ pid: 1, process: 'explorer', title: '', foreground: false }];
  const after = [...before, { pid: 47644, process: 'Doubao', title: '', foreground: false }];
  const r = assessNativeAction(evidence, [], { goal: '打开桌面端的豆包', beforeApps: before, afterApps: after });
  assert.equal(r.ok, true, '豆包进程出现即算打开');
  assert.match(r.source, /os process/);
  assert.equal(assessNativeAction(evidence, [], { goal: '打开桌面端的豆包', beforeApps: before, afterApps: before }).ok, false);
});

// R135 实测：Codex 先用 rg 搜记忆（没匹配、exit 1），随后 fileChange 真实创建了 HTML 并读回，
// 旧逻辑却因为"有一条命令非零退出"把交付判成失败，还报"尚无完整的原生工具执行证据"。
test('个别探索命令非零退出不判死交付；目标没点名文件时按原生日志里的真实写入核对磁盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-native-write-'));
  const file = path.join(dir, 'pelican-coastal-ride.html');
  const since = Date.now() - 1000;
  fs.writeFileSync(file, '<!doctype html><html><svg></svg></html>');
  const evidence = {
    source: 'codex app-server tool events',
    calls: [
      { id: 'c1', tool: 'commandExecution', status: 'completed', failed: true, record: { command: 'rg -n "pelican" D:\\Codex\\memories\\MEMORY.md', exitCode: 1 } },
      { id: 'c2', tool: 'fileChange', status: 'completed', failed: false, record: { type: 'fileChange', changes: [{ path: file, kind: { type: 'add' } }] } },
      { id: 'c3', tool: 'commandExecution', status: 'completed', failed: false, record: { command: 'Get-Item .\\pelican-coastal-ride.html', exitCode: 0 } },
    ],
    verifiedActions: [], verification: { status: 'unverified' },
  };
  assert.deepEqual(nativeWrittenFiles(evidence, { cwd: dir, roots: [dir] }), [{ path: file, kind: 'add' }]);
  const r = assessNativeAction(evidence, [], { goal: '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画', cwd: dir, roots: [dir], since });
  assert.equal(r.ok, true, '有真实写入 + 磁盘上文件确实在，就该通过');
  assert.equal(r.source, 'native file-change log + real file on disk');
  assert.deepEqual(r.artifacts.map(a => a.path), [file]);
  assert.equal(r.artifacts[0].bytes, fs.statSync(file).size);
  assert.ok(r.warnings?.[0]?.includes('非零退出码'), '把失败探测记成提示，不吞掉');
  // 客户要求：写在默认目录以外也要能评估。日志里真实写入 + 磁盘存在就收，不再按工作区过滤。
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-native-outside-'));
  const outFile = path.join(outside, 'x.html'); fs.writeFileSync(outFile, '<html></html>');
  const escaped = { ...evidence, calls: [evidence.calls[0], { id: 'c9', tool: 'fileChange', status: 'completed', failed: false, record: { changes: [{ path: outFile, kind: { type: 'add' } }] } }] };
  assert.deepEqual(nativeWrittenFiles(escaped, { cwd: dir, roots: [dir] }), [{ path: outFile, kind: 'add' }]);
  // 磁盘上不存在（模型只是嘴上说写了）→ 仍然不通过
  const ghost = { ...evidence, calls: [evidence.calls[0], { id: 'c9', tool: 'fileChange', status: 'completed', failed: false, record: { changes: [{ path: path.join(dir, 'nope.html'), kind: { type: 'add' } }] } }] };
  assert.equal(assessNativeAction(ghost, [], { goal: '创建一个HTML', cwd: dir, roots: [dir], since }).ok, false);
});

test('进程快照只列真实进程，探测失败返回空而不是编造', () => {  const run = () => ({ status: 0, stdout: JSON.stringify([{ pid: 7, process: 'notepad', title: '无标题 - 记事本', foreground: true }]) });
  const snap = snapshotProcesses({ spawnSync: run });
  assert.deepEqual(snap, [{ pid: 7, process: 'notepad', title: '无标题 - 记事本', foreground: true }]);
  assert.deepEqual(snapshotProcesses({ spawnSync: () => { throw new Error('no powershell'); } }), []);
});

test('Codex app-server 沿用桌面端自己的启动参数；取不到时用实测默认值', () => {
  const line = 'C:\\...\\codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled -c features.prefer_mxc=true -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true -c "plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true" -c sandbox_mode=danger-full-access';
  const cache = { at: 0, flags: null };
  const discovered = desktopAppLaunchFlags({ spawnSync: () => ({ status: 0, stdout: line }), cache, now: () => 1000 });
  assert.deepEqual(discovered, DESKTOP_LAUNCH_DEFAULTS, '桌面端的 features/plugins 开关照搬，别的配置不碰');
  const empty = desktopAppLaunchFlags({ spawnSync: () => ({ status: 1, stdout: '' }), cache: { at: 0, flags: null }, now: () => 2000 });
  assert.deepEqual(empty, DESKTOP_LAUNCH_DEFAULTS);
  const cached = desktopAppLaunchFlags({ spawnSync: () => { throw new Error('不该再探测'); }, cache: { at: 2000, flags: ['features.x=true'] }, now: () => 2100 });
  assert.deepEqual(cached, ['features.x=true']);
});

// R127：打开桌面软件时，原生会话必须拿到该客户端自己的完整权限级别——
// workspace-write 会挡住目标程序写自己的数据目录/起自己的进程（豆包启动器秒退、app 崩 0x80000003）。
function nativeFixture() {
  const seen = [], sessions = {};
  const roster = new Roster({
    config: { flow: { cooldownMin: 30 }, dock: [], secrets: {} },
    store: { get: () => undefined, set: () => {}, event: () => {} },
    agents: { codex: async o => { seen.push(o); return { text: 'ok', nativeId: 'n1' }; } },
  });
  const call = extra => roster.call({ runId: 'R1', seat: 'codex', slot: 'codex:exec', sessions, cwd: 'E:/x',
    models: { codex: 'codex-fixture' }, build: () => '打开豆包', persist: () => {}, ...extra });
  return { seen, call };
}

test('打开桌面软件时原生会话拿到完整权限；文件任务和讨论仍保持沙箱', async () => {
  const app = nativeFixture();
  await app.call({ role: 'write', nativeAccess: 'danger-full-access' });
  assert.equal(app.seen.at(-1).access, 'danger-full-access', '开软件要让它起自己的进程/写自己的数据目录');
  const file = nativeFixture();
  await file.call({ role: 'write' });
  assert.equal(file.seen.at(-1).access, 'workspace-write', '普通文件任务不放开权限');
  const talk = nativeFixture();
  await talk.call({ role: 'think' });
  assert.equal(talk.seen.at(-1).access, 'read-only');
});

test('DeepSeek headless 覆盖层有 danger-full-access 权限预设（否则 DSH_PERMISSION_MODE 解析不到）', () => {
  const root = fs.mkdtempSync(path.join(artifactsRoot(), 'ds-patch-'));
  const file = writePatch({ root, dataDir: path.join(root, 'data') }, { provider: 'fixture', model: 'fixture-model' }, { access: 'danger-full-access' });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /danger-full-access:/);
  assert.match(text, /sandbox: danger-full-access/);
  assert.match(text, /sandbox: workspace-write/);
});

test('拓展坞一句话提示词：直接用电脑助手自己的工具，不再让它去找 desktop_call', () => {
  const p = actionPrompt({ id: 'R129', target: 'dock:f9cc73b3', cwd: 'E:\\beat\\workspaces\\shared', goal: '打开桌面版的豆包' });
  assert.doesNotMatch(p, /必须使用 BEAT 的 desktop_call|先用 desktop_call\(list:true\)|工具名可能为 beat\.desktop_call|contextId:/);
  assert.match(p, /本任务没有也不需要 desktop_call 这类 MCP 工具/);
  assert.match(p, /你已经在 BEAT 电脑助手里/);
  assert.match(p, /app_list \+ app_launch/);
  assert.match(p, /app_list 按名字查真实应用 ID/);
  assert.match(p, /用户本次原话：\n打开桌面版的豆包/);
});
