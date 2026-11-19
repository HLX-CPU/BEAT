// 配置：config.json 存普通设置，secrets.local.json 存访问令牌与 Claude 密钥（不要外传）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { LOCAL_CONTROLLER_DEFAULTS, normalizeLocalControllerConfig } from './local-controller.mjs';

// 产品根目录 = 代码所在位置（安装目录/便携目录）。
// BEAT_ROOT 允许显式覆盖：测试进程用它把 ROOT 指到临时目录，避免任何"顺带写文件"落到产品目录里
// （实测：跑出厂自检会在包根写出 secrets.local.json——令牌本身无害，但在产品目录里留运行期文件是脏的）。
// 生产运行不设这个变量，行为与以前完全一致。
export const ROOT = process.env.BEAT_ROOT && path.isAbsolute(process.env.BEAT_ROOT)
  ? process.env.BEAT_ROOT
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '2.2.125';

// 独立开关只影响下一任务；安全边界、严重反对处理与防重复执行始终保留。
export const CONTROL_FLOW_DEFAULTS = Object.freeze({
  compactDiscussion: true, outlineMergeFallback: true, disputeVoting: true, planReview: true,
  pullQueue: true, taskAutoChecks: true, taskModelReview: true, checkpoints: true, difficultyRouting: true,
  // 执行者原生会话的沙箱档位（客户 2026-10-18 明确要求：执行者默认管理员权限）：
  //   'danger-full-access'（默认）= 执行者按完全访问建立会话，自己的工具能装依赖、跑命令、写用户目录；
  //   'workspace-write'           = 只能在任务目录内读写，不能起子进程，装依赖/跑测试会 EPERM/ENOENT。
  // 只看这一次任务的实际执行；讨论与核验仍然留在只读会话。安全边界（严重反对、未知副作用隔离、禁止重放）不变。
  executorAccess: 'danger-full-access',
  // 默认按任务文件范围执行；构建缓存等额外范围应在计划中声明。
  allowAnyWrite: false,
  // 未核验的电脑输入始终隔离；旧字段不再授予重放权限。
  quarantineUnknown: true,
  // 免协商快路径（用户裁决第 3 条）：判据是"验收能否被机器证据完全证明"，不是"任务小不小"。
  // 只有目标里已写明、预检通过的验收命令，且单人单任务、没有靠人判断的验收项时才生效；
  // 省掉的是提纲/投票/定稿/多轮评审，**验收照原样执行**。设为 false 可整体关掉（走原流程）。
  fastPath: true,
  // 讨论僵局交顾问裁决（默认开；客户要求"谈不拢就交顾问综合评判"）。
  //   reviewAdjudication：两轮评审仍有意见时，交顾问综合四家意见并选最佳候选执行（记裁决，不判死）。
  //   repairAdjudication：方案作者连改 3 次都没过时，交顾问裁定"选哪个候选"或"作者该改哪几处"，而不是整轮失败。
  // 关掉任一开关就回到严格模式（僵局即失败）。严重安全/资金/不可逆反对始终禁止执行，顾问不能裁过。
  reviewAdjudication: true,
  repairAdjudication: true,
  // 新客户默认启用准入和调用中用量限制；显式关闭仍保留计量和审计。
  tokenBudgetEnforced: true,
  discussionTokenBudget: 256000, executionTokenBudget: 384000, taskTokenBudget: 128000,
  discussionMaxDebates: 3, taskMaxRetries: 2, taskLeaseSec: 120,
  // 同目标重复熔断（task-3）：同一（目标，工作目录）在滚动窗口内失败达到这次数后，拒绝再次发起全新并行任务。
  // 阈值 0/缺省视为用默认值；真正的读取与判定在 src/orchestrator.mjs 的 repeatBudgetConfig()/repeatGuard()。
  repeatFailLimit: 3, repeatFailWindowHours: 24,
  strongAgent: 'codex', cheapAgents: ['deepseek'],
});
// 数值类协作设置（预算/轮数/租约）的唯一事实来源：默认值 + 上下限。
// 看板不再自带一份数字：settingsView 会把这张表随 flow 一起返回（src/tools.mjs），
// web/index.html 只做兜底且由 tests/control-defaults-drift.test.mjs 断言与这里一致。
export const CONTROL_FLOW_LIMITS = Object.freeze(Object.fromEntries([
  ['discussionTokenBudget', { min: 256, max: 10000000 }], ['executionTokenBudget', { min: 256, max: 10000000 }], ['taskTokenBudget', { min: 256, max: 10000000 }],
  ['discussionMaxDebates', { min: 0, max: 3 }], ['taskMaxRetries', { min: 0, max: 2 }], ['taskLeaseSec', { min: 10, max: 3600 }],
  ['repeatFailLimit', { min: 1, max: 50 }], ['repeatFailWindowHours', { min: 1, max: 720 }],
].map(([key, range]) => {
  const value = CONTROL_FLOW_DEFAULTS[key];
  if (!Number.isInteger(value)) throw new Error(`CONTROL_FLOW_LIMITS 缺少 ${key} 的整数默认值`);
  if (value < range.min || value > range.max) throw new Error(`${key} 的默认值 ${value} 不在 ${range.min} 到 ${range.max} 之间`);
  return [key, Object.freeze({ default: value, ...range })];
})));
const CONTROL_SWITCHES = Object.keys(CONTROL_FLOW_DEFAULTS).filter(key => typeof CONTROL_FLOW_DEFAULTS[key] === 'boolean');
const CONTROL_LIMITS = Object.fromEntries(Object.entries(CONTROL_FLOW_LIMITS).map(([key, spec]) => [key, [spec.min, spec.max]]));
const CONTROL_LABELS = {
  discussionTokenBudget: '讨论 token 预算', executionTokenBudget: '执行 token 预算', taskTokenBudget: '单任务 token 预算',
  discussionMaxDebates: '分歧辩论轮数', taskMaxRetries: '单任务重试次数', taskLeaseSec: '任务租约秒数',
  repeatFailLimit: '同目标失败次数上限', repeatFailWindowHours: '同目标失败统计窗口（小时）',
};
const validPartnerId = id => typeof id === 'string' && (/^(codex|deepseek|zcode)$/.test(id) || /^dock:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id));

export function validateControlFlow(flow = {}, config = {}) {
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) throw new Error('协作控制设置必须为对象');
  for (const key of CONTROL_SWITCHES) if (flow[key] !== undefined && typeof flow[key] !== 'boolean') throw new Error(`${key} 必须选择开启或关闭`);
  for (const [key, [min, max]] of Object.entries(CONTROL_LIMITS)) {
    if (flow[key] !== undefined && (!Number.isInteger(flow[key]) || flow[key] < min || flow[key] > max)) throw new Error(`${CONTROL_LABELS[key]}必须为 ${min} 到 ${max} 的整数`);
  }
  if (flow.strongAgent !== undefined && !validPartnerId(flow.strongAgent)) throw new Error('裁决搭档必须选择已配置的执行搭档');
  if (flow.cheapAgents !== undefined && (!Array.isArray(flow.cheapAgents) || flow.cheapAgents.length > 64 || flow.cheapAgents.some(id => !validPartnerId(id)) || new Set(flow.cheapAgents).size !== flow.cheapAgents.length)) throw new Error('轻量任务搭档必须为不重复的执行搭档列表');
  const docks = new Set((config.dock || []).map(d => d.id));
  for (const id of [flow.strongAgent, ...(flow.cheapAgents || [])].filter(Boolean)) {
    if (id.startsWith('dock:') && !docks.has(id)) throw new Error('所选搭档尚未接入；请从看板已接入的搭档中选择');
  }
}

export function defaults(root = ROOT) {
  return {
    port: 8765,
    workspace: path.join(root, 'workspaces', 'shared'),
    allowedRoots: [path.join(root, 'workspaces')],
    codex: { executable: '', home: 'D:/Codex', windowsSandbox: 'unelevated', defaultModel: null, defaultEffort: null },
    // DeepSeek Harness 的安装位置/后台组件/登录配置一律按本机自动发现（见 src/deepseek-runtime.mjs），
    // 不写死开发机路径：客户可能装在任意目录。
    deepseek: { defaultModel: null, defaultEffort: null, executable: '', cli: '', profileFile: '', home: '' },
    // ZCode 桌面端搭档：与拓展坞一样需要客户显式启用（enabled），不启用就不探测、不调用、不占额度。
    // cliPath/dataDir 留空 = 按本机自动发现（ZCode 桌面端安装目录与其数据目录）；
    // defaultModel 为「providerId/modelId」格式（与 ZCode CLI 的模型选择一致），留空用 CLI 自己的默认。
    zcode: { enabled: false, cliPath: '', dataDir: '', defaultModel: null },
    // 顾问连接：选项与拓展坞接入模型保持一致（名称/地址/密钥/模型/推理强度/推理协议/图片/启用）。
    // 每一项的默认值都等于改动前的行为：默认开启、默认收图、默认由接口决定推理强度。
    claude: { name: 'Claude', baseUrl: 'https://api.aisj.ai', model: 'claude-opus-5-5', protocol: 'auto', maxTokens: 8192, firstTokenSec: 90, timeoutSec: 900,
      enabled: true, vision: true, defaultEffort: null, reasoningConfig: null },
    localController: { ...LOCAL_CONTROLLER_DEFAULTS },
    flow: { maxTurns: 6, discussionRounds: 3, maxRounds: 3, consultAfterFails: 2, discussionSkipAfterRetries: 3, stepTimeoutMin: 0, cooldownMin: 30, runChecks: true, codexOpenInDesktop: true,
    // 拓展坞（API 模型）单次调用：整体超时（分钟，0 = 不限）与「多久没有任何输出算卡住」（秒）
    dockTimeoutMin: 30, dockStallSec: 90, maxParallelTasks: 3, negotiateCap: 20, ...CONTROL_FLOW_DEFAULTS,
    cheapAgents: [...CONTROL_FLOW_DEFAULTS.cheapAgents] },
  };
}

// 打包后的 app 进程（MCP/CLI）没有启动器注入的 BEAT_DATA_DIR：
// 必须从"包目录"推断同一个数据目录，否则 MCP 会用 app 根目录的默认端口 8765 和另一份令牌，
// 既连不上启动器起的服务，也会在端口被占时误报。规则与 PortableLauncher 的数据目录解析保持一致：
//   便携版：<包>\portable-data；安装版：<包>\launcher-settings.json 的 DataDir/dataDir。
function packagedDataRoot(root) {
  try {
    if (path.basename(root).toLowerCase() !== 'app') return null;
    const pkg = path.dirname(root);
    const portable = path.join(pkg, 'portable-data');
    try { if (fs.statSync(portable).isDirectory()) return portable; } catch { /* 不是便携版 */ }
    const settings = path.join(pkg, 'launcher-settings.json');
    if (fs.existsSync(settings)) {
      const row = readJson(settings);
      const value = row.DataDir || row.dataDir;
      if (typeof value === 'string' && value.trim()) return path.resolve(pkg, value.trim());
    }
  } catch { /* 推断失败就沿用旧行为 */ }
  return null;
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };

export function loadConfig(root = ROOT) {
  const file = path.join(root, 'config.json');
  // 数据目录可用环境变量重定位——便携版/安装版必需：
  //   便携版把 data/、工作区、配置、令牌全放 <包目录>\portable-data\，跟着文件夹搬走；
  //   安装版落在 Program Files 时，包目录通常不可写，必须把可变状态挪到用户目录（或便携目录）。
  // 不设这个变量时行为与以前完全一致（都放 root 下），所以老用法不受影响。
  const envData = process.env.BEAT_DATA_DIR && path.isAbsolute(process.env.BEAT_DATA_DIR) ? process.env.BEAT_DATA_DIR : null;
  const dataRoot = envData || packagedDataRoot(root) || root;
  const secretFile = path.join(root, 'secrets.local.json');
  const dataSecretFile = path.join(dataRoot, 'secrets.local.json');
  // config.json 只从包目录读（保持"跟随产品文件夹走"的既有语义）；数据目录里若也放了一份，
  // 以数据目录那份为准——安装版把用户改过的配置写在可写目录时需要这个覆盖能力。
  const dataFile = path.join(dataRoot, 'config.json');
  const config = merge(defaults(dataRoot), fs.existsSync(dataFile) && dataFile !== file ? readJson(dataFile) : readJson(file));
  // Follow the customer's own Codex desktop home on machines without the
  // development machine's D:/Codex directory; never replace an existing home.
  const nativeCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if ((!config.codex.home || !fs.existsSync(path.join(config.codex.home, 'config.toml'))) && fs.existsSync(path.join(nativeCodexHome, 'config.toml'))) config.codex.home = nativeCodexHome;
  let secrets = readJson(fs.existsSync(dataSecretFile) ? dataSecretFile : secretFile);
  if (!secrets.token) {
    secrets = { ...secrets, token: randomBytes(24).toString('hex') };
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(dataSecretFile, JSON.stringify(secrets, null, 2) + '\n');
  }
  if (process.env.BEAT_CLAUDE_API_KEY) secrets.claudeApiKey = process.env.BEAT_CLAUDE_API_KEY;
  return { ...config, root, dataDir: path.join(dataRoot, 'data'), dataRoot, configFile: fs.existsSync(dataFile) ? dataFile : file, secretFile: fs.existsSync(dataSecretFile) ? dataSecretFile : secretFile, secrets };
}

// 只把用户可改的字段写回 config.json；密钥写 secrets.local.json。
// 顾问连接可写字段（与拓展坞接入模型的选项对齐）。reasoningConfig/defaultEffort 传 null 表示清除，
// 所以这里不能用会丢掉空值的 pick()。
const CLAUDE_FIELDS = ['name', 'baseUrl', 'model', 'protocol', 'maxTokens', 'firstTokenSec', 'timeoutSec', 'enabled', 'vision', 'defaultEffort', 'reasoningConfig'];
function claudePatch(claude) {
  return Object.fromEntries(CLAUDE_FIELDS.filter(key => Object.hasOwn(claude, key) && claude[key] !== undefined).map(key => [key, claude[key]]));
}

export function saveSettings(config, patch = {}) {
  if (patch.flow !== undefined) validateControlFlow(patch.flow, config);
  if(patch.flow?.discussionSkipAfterRetries!==undefined&&(!Number.isInteger(patch.flow.discussionSkipAfterRetries)||patch.flow.discussionSkipAfterRetries<0||patch.flow.discussionSkipAfterRetries>20))throw new Error('失败方重试轮数必须为 0 到 20 的整数');
  for(const [key,min,max] of [['maxTurns',2,12],['discussionRounds',2,12],['maxRounds',1,8],['consultAfterFails',1,8]]){
    const value=patch.flow?.[key];if(value!==undefined&&(!Number.isInteger(value)||value<min||value>max))throw new Error(`${key} 必须为 ${min} 到 ${max} 的整数`);
  }
  for(const key of ['stepTimeoutMin','cooldownMin','stallMinutes','dockTimeoutMin','dockStallSec','maxParallelTasks']){const value=patch.flow?.[key];if(value!==undefined&&(!Number.isFinite(value)||value<0||((key==='stallMinutes'||key==='dockStallSec')&&value===0)))throw new Error(`${key} 必须为有效非负数，卡住阈值必须大于 0`);}
  for (const provider of ['codex', 'deepseek', 'zcode']) {
    const model = patch[provider]?.defaultModel;
    if (model != null && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model))) throw new Error('默认模型 ID 无效');
  }
  if (patch.zcode?.enabled !== undefined && typeof patch.zcode.enabled !== 'boolean') throw new Error('ZCode 的启用开关必须为开启或关闭');
  if (patch.localController !== undefined) normalizeLocalControllerConfig(merge(config.localController || {}, patch.localController));
  const current = readJson(config.configFile);
  const next = merge(current, {
    ...(patch.workspace ? { workspace: patch.workspace } : {}),
    ...(Array.isArray(patch.allowedRoots) ? { allowedRoots: patch.allowedRoots } : {}),
    ...(isObj(patch.codex) ? { codex: pick(patch.codex, ['defaultModel', 'defaultEffort']) } : {}),
    ...(isObj(patch.deepseek) ? { deepseek: pick(patch.deepseek, ['defaultModel', 'defaultEffort']) } : {}),
    ...(isObj(patch.zcode) ? { zcode: pick(patch.zcode, ['enabled', 'cliPath', 'dataDir', 'defaultModel']) } : {}),
    ...(isObj(patch.claude) ? { claude: claudePatch(patch.claude) } : {}),
    ...(isObj(patch.localController) ? { localController: pick(patch.localController, ['enabled', 'mode', 'provider', 'baseUrl', 'model', 'apiBaseUrl', 'apiModel', 'apiProtocol', 'timeoutSec', 'keepAlive']) } : {}),
    ...(isObj(patch.flow) ? { flow: pick(patch.flow, ['maxTurns', 'discussionRounds', 'maxRounds', 'consultAfterFails', 'discussionSkipAfterRetries', 'stepTimeoutMin', 'cooldownMin', 'dockTimeoutMin', 'dockStallSec', 'maxParallelTasks', 'runChecks', 'codexOpenInDesktop', 'stallMinutes', 'negotiateCap', ...Object.keys(CONTROL_FLOW_DEFAULTS)]) } : {}),
  });
  const staged = config.configFile + '.pending-' + randomBytes(12).toString('hex');
  const bytes = JSON.stringify(next, null, 2) + '\n';
  fs.writeFileSync(staged, bytes, { flag: 'wx' });
  if (fs.readFileSync(staged, 'utf8') !== bytes) throw new Error('设置写入回读校验失败，未替换原配置');
  fs.renameSync(staged, config.configFile);
  if (patch.claude?.apiKey) {
    const secrets = { ...readJson(config.secretFile), claudeApiKey: String(patch.claude.apiKey).trim() };
    fs.writeFileSync(config.secretFile, JSON.stringify(secrets, null, 2) + '\n');
  }
  // 控制器接入中转站 API 的密钥：只写 secrets.local.json，config.json 不落明文。
  if (patch.localController?.apiKey) {
    const secrets = { ...readJson(config.secretFile), controllerApiKey: String(patch.localController.apiKey).trim() };
    fs.writeFileSync(config.secretFile, JSON.stringify(secrets, null, 2) + '\n');
  }
  return loadConfig(config.root);
}
function pick(o, keys) { return Object.fromEntries(keys.filter(k => o[k] !== undefined && o[k] !== '').map(k => [k, o[k]])); }

// 桌面端自带的 codex.exe：与账号/桌面端同一二进制（npm 版会被拒绝使用 gpt-6.1-sol）。桌面更新后路径会变，所以每次现找。
export function codexExecutable(config) {
  if (config.codex.executable && fs.existsSync(config.codex.executable)) return config.codex.executable;
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  const found = fs.existsSync(base) ? fs.readdirSync(base).map(d => path.join(base, d, 'codex.exe')).filter(f => fs.existsSync(f)) : [];
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!found.length) throw new Error('未检测到 Codex 桌面端的执行组件，请先在 Codex 桌面端完成首次启动');
  return found[0];
}

export function redact(text, config) {
  let s = String(text ?? '');
  for (const secret of [config?.secrets?.token, config?.secrets?.claudeApiKey, config?.secrets?.controllerApiKey, ...Object.values(config?.secrets?.dockKeys || {})]) if (secret && secret.length >= 8) s = s.split(secret).join('[已隐去]');
  return s.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***').replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1***');
}

export function maskKey(key) { return key ? key.slice(0, 6) + '…' + key.slice(-4) : ''; }
