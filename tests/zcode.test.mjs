// ZCode 搭档适配器单测：注入假 app-server 进程，不跑真 CLI（真实冒烟见 tests/live-zcode.mjs）。
// 覆盖：发现与启用门、会话创建/续接、模式映射、模型选择失败给登录指引、事件终结、用量差值、
//       interaction/* 绝不代批、注册面（AGENTS/可用性门/路由白名单/设置往返）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { askZcode, detectZcodeRuntime, parseModelSelection } from '../src/zcode.mjs';
import { nativeAvailability } from '../src/native-runtime.mjs';
import { defaults, saveSettings, validateControlFlow } from '../src/config.mjs';
import { Roster, AGENTS } from '../src/roster.mjs';
import { Store } from '../src/store.mjs';
import { TOOLS } from '../src/tools.mjs';
import { tempDir, cleanup } from './helpers/temp.mjs';

/** 假 app-server 工厂：实现适配器用到的最小协议面，记录全部收到的请求。 */
function fakeServer(options = {}) {
  const {
    sessionMode = 'build', failModel = false, terminalStatus = 'complete', assistantText = '好的，OK',
    resumeError = false, noTerminal = false, requireInteraction = false, terminalError = null,
    usage = { totalTokens: 42, inputTokens: 30, outputTokens: 12, cacheReadTokens: 0 },
  } = options;
  const factory = (cmd, args, opts = {}) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    let killed = false;
    child.kill = () => { killed = true; };
    child.isKilled = () => killed;
    child.args = args;
    child.opts = opts;
    const respond = obj => process.nextTick(() => child.stdout.emit('data', JSON.stringify(obj) + '\n'));
    child.stdin.write = line => {
      let req; try { req = JSON.parse(line); } catch { return; }
      factory.requests.push(req);
      // 服务端→客户端回调（模拟真实 app-server 的 requestRuntimePreferences 与权限请求）
      if ((req.method === 'session/create' || req.method === 'session/resume')) {
        const sid = req.method === 'session/resume' ? (resumeError ? null : req.params.sessionId) : 'sess_factory-' + (factory.counter = (factory.counter || 0) + 1);
        process.nextTick(() => {
          child.stdout.emit('data', JSON.stringify({ method: 'session/requestRuntimePreferences', id: 'server-1', params: { sessionId: sid || 'sess_x', scope: 'runtime-materialization' } }) + '\n');
          if (requireInteraction) child.stdout.emit('data', JSON.stringify({ method: 'interaction/requestPermission', id: 'server-2', params: { kind: 'bash', sessionId: sid } }) + '\n');
          if (req.method === 'session/resume' && resumeError) respond({ id: req.id, error: { code: -32001, message: 'session not found' } });
          else respond({ id: req.id, result: { session: { sessionId: sid, mode: sessionMode } } });
        });
        return;
      }
      if (req.method === 'session/setModel') {
        if (failModel) { respond({ id: req.id, error: { code: -32603, message: 'Provider Registry 中不存在 Model' } }); return; }
        respond({ id: req.id, result: { model: req.params.model.providerId + '/' + req.params.model.modelId, previousModel: null } });
        return;
      }
      if (req.method === 'session/send') {
        respond({ id: req.id, result: { accepted: true, sessionId: req.params.sessionId } });
        if (!noTerminal) process.nextTick(() => child.stdout.emit('data', JSON.stringify({ method: 'v4/telemetry/event', params: { kind: 'turn.terminal', status: terminalStatus, sessionId: req.params.sessionId, turnId: 'turn_1', errorMessage: terminalStatus === 'failed' ? (terminalError || '出错了') : null } }) + '\n'));
        return;
      }
      if (req.method === 'session/read') {
        respond({ id: req.id, result: { messages: [ { role: 'user', content: '用户消息' }, { role: 'assistant', content: assistantText } ] } });
        return;
      }
      if (req.method === 'session/usage') {
        factory.usageCalls = (factory.usageCalls || 0) + 1;
        const totals = factory.usageCalls === 1
          ? { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
          : usage;
        respond({ id: req.id, result: totals });
        return;
      }
      respond({ id: req.id, result: { ok: true } });
    };
    child.stdin.end = () => {};
    factory.children.push(child);
    return child;
  };
  factory.requests = [];
  factory.children = [];
  return factory;
}

function baseConfig(t) {
  const root = tempDir('zcode-test');
  cleanup(t, root);
  return { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'fixture' }, zcode: { enabled: true, cliPath: 'C:\\fake\\zcode.cjs', dataDir: '', defaultModel: 'zai/glm-5.3' } };
}

test('detectZcodeRuntime：配置的 cliPath 可用时优先使用', t => {
  // 本机装了 ZCode 时先发现真实安装，再把它固定成 cliPath，断言「配置优先」
  const discovered = detectZcodeRuntime({ zcode: { cliPath: '' } });
  assert.equal(discovered.available, true, '开发机装有 ZCode，发现应命中');
  const pinned = detectZcodeRuntime({ zcode: { cliPath: discovered.cli } });
  assert.equal(pinned.available, true);
  assert.equal(pinned.cli, discovered.cli);
});

test('askZcode 运行时不可用：报 notDispatched 带人话指引，允许搭档顶上', async t => {
  const config = baseConfig(t);
  await assert.rejects(
    () => askZcode(config, { prompt: 'hi', model: 'zai/glm-5.3', cwd: 'E:\\proj', access: 'read-only' },
      { runtime: { available: false, reason: '未检测到 ZCode 桌面端。安装并打开一次完成登录即可。' } }),
    e => { assert.equal(e.notDispatched, true); assert.match(e.message, /未检测到 ZCode 桌面端/); return true; },
  );
});

test('askZcode 满意路径：plan 模式、模型解析、读回文本、用量与 onNative', async t => {
  const config = baseConfig(t);
  const spawnProcess = fakeServer({ usage: { totalTokens: 150, inputTokens: 120, outputTokens: 30, cacheReadTokens: 0 } });
  const seenNative = [];
  const result = await askZcode(config, {
    prompt: '只回复OK', model: 'zai/glm-5.3', cwd: 'E:\\proj', access: 'read-only',
    onNative: id => seenNative.push(id),
  }, { spawnProcess });
  const requests = spawnProcess.requests;
  assert.equal(result.text, '好的，OK');
  assert.match(String(seenNative[0]), /^sess_/);
  assert.equal(result.nativeId, seenNative[0]);
  assert.equal(result.actualModel, 'zai/glm-5.3');
  assert.equal(result.usage.totalTokens, 150, '基线为 0 时本轮用量 = 全部累计');
  assert.equal(result.usage.verified, true);
  const modeReq = requests.find(r => r.method === 'session/setMode');
  assert.equal(modeReq.params.mode, 'plan', 'read-only 会话必须是 plan 模式');
  const modelReq = requests.find(r => r.method === 'session/setModel');
  assert.deepEqual(modelReq.params.model, { providerId: 'zai', modelId: 'glm-5.3' });
  const sendReq = requests.find(r => r.method === 'session/send');
  assert.equal(sendReq.params.content, '只回复OK');
  // 运行时偏好必须被应答（否则会话会卡在 15 秒服务端超时上）
  const answered = requests.find(r => r.id === 'server-1' && r.result);
  assert.ok(answered, 'session/requestRuntimePreferences 必须应答');
  assert.equal(answered.result.nativeSearchEnhancementsEnabled, false);
});

test('askZcode 执行档映射为 yolo（无头无审批人，BEAT 外层有文件范围核验兜底）', async t => {
  const config = baseConfig(t);
  const spawnProcess = fakeServer({});
  await askZcode(config, { prompt: '写文件', model: 'zai/glm-5.3', cwd: 'E:\\proj', access: 'workspace-write' }, { spawnProcess });
  const modeReq = spawnProcess.requests.find(r => r.method === 'session/setMode');
  assert.equal(modeReq.params.mode, 'yolo');
});

test('模型未授权：setModel 失败回退会话默认；发送阶段 "Select a model" 给出 CLI 限制说明并让搭档顶上', async t => {
  const config = baseConfig(t);
  // 注入隔离的 runtime：personalConfigFile 指向不存在的路径，屏蔽本机真实登录选择的干扰
  const runtime = { available: true, cli: 'C:\\fake\\zcode.cjs', dataBaseDir: '', personalConfigFile: 'C:\\nonexistent\\provider_config.json' };
  const spawnProcess = fakeServer({ failModel: true, terminalStatus: 'failed', terminalError: 'Select a model before continuing', assistantText: '' });
  await assert.rejects(
    () => askZcode(config, { prompt: 'hi', model: 'zai/glm-5.3', cwd: 'E:\\proj', access: 'read-only' }, { runtime, spawnProcess }),
    e => { assert.equal(e.notDispatched, true); assert.match(e.message, /模型注册表|登录|授权/); return true; },
  );
  // setModel 被拒后必须继续走会话默认（不硬失败在模型选择上）
  assert.ok(spawnProcess.requests.some(r => r.method === 'session/send'), 'setModel 失败后应继续发送');
});

test('续接原生会话失败：报 NATIVE_SESSION_MISSING + notDispatched，让名册换新会话', async t => {
  const config = baseConfig(t);
  const spawnProcess = fakeServer({ resumeError: true });
  await assert.rejects(
    () => askZcode(config, { prompt: 'hi', model: 'zai/glm-5.3', cwd: 'E:\\proj', access: 'read-only', nativeId: 'sess_old' }, { spawnProcess }),
    e => { assert.equal(e.code, 'NATIVE_SESSION_MISSING'); assert.equal(e.notDispatched, true); return true; },
  );
});

test('interaction/* 权限请求绝不代批：显式拒绝并如实报告，不伪造完成', async t => {
  const config = baseConfig(t);
  const spawnProcess = fakeServer({ requireInteraction: true, terminalStatus: 'failed', assistantText: '' });
  await assert.rejects(
    () => askZcode(config, { prompt: '跑个命令', model: 'zai/glm-5.3', cwd: 'E:\\proj', access: 'workspace-write' }, { spawnProcess }),
    e => { assert.match(e.message, /代批|权限/); return true; },
  );
  const reject = spawnProcess.requests.find(r => r.id === 'server-2' && r.error);
  assert.ok(reject, '权限请求必须被显式拒绝');
});

test('没有终结事件：超时失败但保留已读到的部分文本', async t => {
  const config = baseConfig(t);
  const spawnProcess = fakeServer({ noTerminal: true, assistantText: '半成品输出' });
  await assert.rejects(
    () => askZcode(config, { prompt: 'hi', model: 'zai/glm-5.3', cwd: 'E:\\proj', access: 'read-only', timeoutMs: 1500 }, { spawnProcess }),
    e => { assert.equal(e.partialText, '半成品输出'); assert.equal(e.notDispatched, undefined); return true; },
  );
});

test('用量差值 = 末值 − 基线（session/usage 是累计值），缓存单列', async t => {
  const config = baseConfig(t);
  let calls = 0;
  const spawnProcess = fakeServer({});
  const custom = (cmd, args, opts) => {
    const child = spawnProcess(cmd, args, opts);
    const raw = child.stdin.write.bind(child.stdin);
    child.stdin.write = line => {
      let req; try { req = JSON.parse(line); } catch { return raw(line); }
      if (req.method === 'session/usage') {
        calls++;
        const totals = calls === 1
          ? { totalTokens: 100, inputTokens: 80, outputTokens: 20, cacheReadTokens: 0 }
          : { totalTokens: 250, inputTokens: 180, outputTokens: 60, cacheReadTokens: 40 };
        return child.stdout.emit('data', JSON.stringify({ id: req.id, result: totals }) + '\n');
      }
      return raw(line);
    };
    return child;
  };
  const result = await askZcode(config, { prompt: 'hi', model: 'zai/glm-5.3', cwd: 'E:\\proj', access: 'read-only' }, { spawnProcess: custom });
  assert.equal(result.usage.totalTokens, 150);
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.usage.outputTokens, 40);
  assert.equal(result.usage.cacheReadTokens, 40);
});

test('注册面：AGENTS 含 zcode、可用性门（未启用=停用、启用+未安装=离线）、roster 不把未启用当在线', t => {
  assert.ok(AGENTS.includes('zcode'));
  const root = tempDir('zcode-reg');
  cleanup(t, root);
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'fixture' } };
  const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
  t.after(() => store.close());
  // 未启用：不探测、不调用，明确告知去设置里开启
  const disabled = nativeAvailability(config, 'zcode');
  assert.equal(disabled.available, false);
  assert.equal(disabled.enabled, false);
  assert.match(disabled.reason, /设置里开启/);
  // 启用 + 未安装（注入探测，屏蔽本机真实安装的干扰）：离线给指引
  const missing = nativeAvailability({ ...config, zcode: { enabled: true, cliPath: 'C:\\nope\\zcode.cjs' } }, 'zcode',
    { zcodeRuntime: () => ({ available: false, reason: '未检测到 ZCode 桌面端。安装并打开一次完成登录即可。' }) });
  assert.equal(missing.available, false);
  assert.equal(missing.enabled, true);
  assert.match(missing.reason, /未检测到 ZCode 桌面端/);
  // 启用 + 已安装：可用（本机若装了 ZCode，真实发现会命中；注入探测保证确定性）
  const ok = nativeAvailability({ ...config, zcode: { enabled: true, cliPath: 'C:\\fake\\zcode.cjs' } }, 'zcode',
    { zcodeRuntime: () => ({ available: true, cli: 'C:\\fake\\zcode.cjs' }) });
  assert.equal(ok.available, true);
  // roster 视角：未启用时显示 offline（带原因），绝不当作在线参与
  const roster = new Roster({ config, store, agents: { nativeAvailability: agent => nativeAvailability(config, agent) } });
  assert.equal(roster.state('zcode').status, 'offline');
});

test('设置往返：zcode.enabled/defaultModel 走 saveSettings 持久化并在 settingsView 暴露；路由白名单放行', t => {
  const root = tempDir('zcode-settings');
  cleanup(t, root);
  const config = { ...defaults(root), root, dataDir: path.join(root, 'data'), secrets: { token: 'fixture' }, configFile: path.join(root, 'config.json') };
  const saved = saveSettings(config, { zcode: { enabled: true, defaultModel: 'zai/glm-5.3' } });
  assert.equal(saved.zcode.enabled, true);
  assert.equal(saved.zcode.defaultModel, 'zai/glm-5.3');
  const view = TOOLS.settings_get.run({ config: saved });
  assert.equal(view.zcode.enabled, true);
  assert.equal(view.zcode.defaultModel, 'zai/glm-5.3');
  validateControlFlow({ strongAgent: 'zcode' }, saved);
});

test('parseModelSelection：只接受 providerId/modelId 形状（providerId 可含冒号）', t => {
  assert.deepEqual(parseModelSelection('zai/glm-5.3'), { providerId: 'zai', modelId: 'glm-5.3' });
  assert.deepEqual(parseModelSelection('account:zai-individual-coding-plan/GLM-5.3'),
    { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3' }, '登录写入的真实形状必须可解析');
  assert.equal(parseModelSelection('glm-5.3'), null);
  assert.equal(parseModelSelection(''), null);
});
