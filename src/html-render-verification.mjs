// BEAT 的浏览器核验：在独立临时 profile、无头、网络被拦的前提下真实渲染交付的 HTML，
// 采样动画关键帧并把截图与哈希作为证据交给非执行者核验。
//
// 安全边界（三条都不能松）：
//   1. 独立临时 profile，绝不接触用户正在用的浏览器会话；
//   2. 网络请求在导航前就全部拦住，脚本既读不到也发不出外部内容；
//   3. 工作目录边界 + 体积上限 + 硬超时看门狗，页面卡死不影响整个任务。
//
// 历史教训：早期版本把含 <script> 的页面整体排除在核验之外，且排除得没有任何记录。
// 结果是"2D 动画"这种最典型的交付物永远拿不到渲染证据，执行者只能自己手搓浏览器、
// 撞上环境崩溃，最后烧掉几十万 token 判失败——而文件本身其实是好的。
// 所以现在：能验的一律真验；确实不能验的，必须留下带原因的记录，不允许静默跳过。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep); };

const MAX_HTML_BYTES = 2_000_000;
const MAX_ARTIFACTS = 4;
const LAUNCH_TIMEOUT_MS = 25_000;

// 会执行页面脚本的标记集合；只有这些才需要放宽"禁用脚本"。
const SCRIPT_TAG = /<\s*script\b/i;
const SCRIPT_ATTR = /\son[a-z]+\s*=/i;
const JAVASCRIPT_URL = /\b(?:href|src|xlink:href)\s*=\s*["']?\s*javascript:/i;
// 页面会去取外部/本地别处资源、或自带导航行为：这类依然不自动渲染，但会把原因写清楚。
const EXTERNAL_RESOURCE = /<\s*(?:iframe|frame|frameset|object|embed|base|img|audio|video|source|track|form|input)\b/i;
const META_REFRESH = /<\s*meta\b[^>]*http-equiv/i;
const URL_REF = /\s(?:src|srcset|action|formaction|background|poster)\s*=/i;
const EXTERNAL_HREF = /\b(?:href|xlink:href)\s*=\s*(?!["']?(?:#|javascript:))[^\s>]+/i;
const CSS_IMPORT = /@import\b|url\(\s*(?!["']?#[^)]*\))[^)]*\)/i;

/**
 * 判断一份 HTML 能不能自动渲染，以及"能，但要开脚本"还是"不能，因为什么"。
 * 返回 { eligible, scripted, reason }；reason 为 null 表示可以渲染。
 * 兼容旧的布尔语义：被排除的输入仍然返回 eligible:false，但不再丢失原因。
 */
export function classifyHtml(text) {
  const source = String(text || '');
  if (!/<svg(?:\s|>)/i.test(source)) return { eligible: false, scripted: false, reason: '文件里没有内联 <svg>，不属于可视化交付物，未做渲染核验' };
  // 先认"脚本"：含脚本的页面要真渲染，只是标记 needScript。
  // javascript: URL 也算脚本，必须在"外部 href"之前判断，否则会被误判成外链。
  const scripted = SCRIPT_TAG.test(source) || SCRIPT_ATTR.test(source) || JAVASCRIPT_URL.test(source);
  if (EXTERNAL_RESOURCE.test(source)) return { eligible: false, scripted, reason: '页面引用了外部/其它本地资源（如 iframe、img、video、form），无法在只读沙箱里完整重现，未做自动渲染核验' };
  if (META_REFRESH.test(source)) return { eligible: false, scripted, reason: '页面带 meta 跳转，渲染结果不是交付内容本身，未做自动渲染核验' };
  if (URL_REF.test(source)) return { eligible: false, scripted, reason: '页面引用了外部资源（src/background/poster 等），未做自动渲染核验' };
  if (EXTERNAL_HREF.test(source)) return { eligible: false, scripted, reason: '页面带有指向外部的 href，未做自动渲染核验' };
  if (CSS_IMPORT.test(source)) return { eligible: false, scripted, reason: '页面用 @import / url() 拉取样式或字体，未做自动渲染核验' };
  // 含脚本的页面在"独立 profile + 全网络拦截 + 硬超时"下渲染：这是 2D 动画、交互演示的常态，
  // 不验就等于这类交付物永远没有渲染证据。
  return { eligible: true, scripted, reason: null };
}

/** 旧接口保留：只看"能不能交给渲染器"，语义与 classifyHtml().eligible 一致。 */
export function inlineHtmlEligible(text) {
  return classifyHtml(text).eligible;
}

/**
 * 候选浏览器的**路径清单**（不判断是否存在）。拆出来是为了可测试：
 * 只认两个硬编码路径曾经让装在别处的用户静默失去渲染核验能力。
 */
export function browserPathCandidates(env = process.env, platform = process.platform) {
  const out = [];
  const add = value => { const file = String(value || '').trim().replace(/^"|"$/g, ''); if (file && !out.includes(file)) out.push(file); };
  if (platform === 'win32') {
    const pf = env['ProgramFiles'] || 'C:/Program Files', pf86 = env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', local = env['LOCALAPPDATA'] || '';
    for (const base of [pf, pf86]) {
      add(path.join(base, 'Google/Chrome/Application/chrome.exe'));
      add(path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
      add(path.join(base, 'BraveSoftware/Brave-Browser/Application/brave.exe'));
      add(path.join(base, 'Chromium/Application/chrome.exe'));
    }
    if (local) {
      add(path.join(local, 'Google/Chrome/Application/chrome.exe'));
      add(path.join(local, 'Microsoft/Edge/Application/msedge.exe'));
      add(path.join(local, 'BraveSoftware/Brave-Browser/Application/brave.exe'));
      add(path.join(local, 'Chromium/Application/chrome.exe'));
    }
    // 注册表里登记的安装位置：装在 D 盘或用户目录的浏览器也能被发现。
    try {
      for (const hive of ['HKLM', 'HKCU']) {
        const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths`;
        for (const exe of ['chrome.exe', 'msedge.exe', 'brave.exe']) {
          try {
            const value = execFileSync('reg', ['query', `${key}\\${exe}`, '/ve'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            const m = /REG_SZ\s+(.+?)\s*$/m.exec(value);
            if (m) add(m[1]);
          } catch { /* 没有这个键就跳过 */ }
        }
      }
    } catch { /* 注册表不可用不影响其它候选 */ }
  } else if (platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']) add(`/Applications/${app}.app/Contents/MacOS/${app}`);
  } else {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'chromium', 'chromium-browser', 'brave-browser']) {
      for (const dir of ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome']) add(path.join(dir, bin));
    }
  }
  return out;
}

/** 本机实际可用的候选浏览器；不再只认两个硬编码路径。 */
export function browserCandidates(env = process.env) {
  return browserPathCandidates(env).filter(file => fs.existsSync(file));
}

/**
 * 依次尝试的参数组：GPU 子进程崩了要能自动降级，而不是整轮判失败。
 * 每组带独立超时且**逐次收紧**：真失败通常几百毫秒就暴露（R152 那次 GPU 崩溃就是），
 * 后面两组是保底。不能让用户为了一个坏页面干等 75 秒——那本身就是"卡住"的体感。
 */
const LAUNCH_ARG_SETS = [
  { label: '默认', timeoutMs: 15_000, args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-default-apps', '--no-service-autorun'] },
  { label: '软件渲染', timeoutMs: 8_000, args: ['--disable-gpu', '--in-process-gpu', '--use-gl=swiftshader', '--disable-software-rasterizer', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-default-apps', '--no-service-autorun'] },
  { label: '最小参数', timeoutMs: 5_000, args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'] },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Windows 上 Chrome 的 profile 路径过长时会启动失败（实测：profile 约 246 字符时退出码 21，
// 报 "Lock file can not be created ... Failed to create a ProcessSingleton"）。
// 证据目录可能很深（自检副本、深工作目录），这时改用短的系统临时目录，用完即删。
const MAX_BROWSER_PROFILE_PATH = 200;
export function browserProfileBase(profileRoot) {
  const probe = path.join(String(profileRoot || ''), '0'.repeat(36));
  if (probe.length <= MAX_BROWSER_PROFILE_PATH) return { base: profileRoot, temporary: false };
  return { base: path.join(os.tmpdir(), 'beat-browser-' + process.pid + '-' + randomUUID().slice(0, 8)), temporary: true };
}

/** 启动无头浏览器，返回 { proc, port, endpoint, attempts, temporaryProfileBase }；全部参数组都失败时抛出带明细的错误。 */
async function launchBrowser(executable, profileRoot, { signal } = {}) {
  const attempts = [];
  const { base, temporary } = browserProfileBase(profileRoot);
  fs.mkdirSync(base, { recursive: true });
  for (const [index, argSet] of LAUNCH_ARG_SETS.entries()) {
    if (signal?.aborted) throw Error('任务已取消，停止浏览器核验');
    const attemptIndex = index + 1;
    const profile = path.join(base, randomUUID());
    fs.mkdirSync(profile, { recursive: true });
    let proc, launchError = null;
    const args = [...argSet.args, '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'];
    try {
      proc = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      attempts.push({ attempt: attemptIndex, args: argSet.label, error: String(error.message).slice(0, 200) });
      continue;
    }
    proc.on('error', error => { launchError = error; });
    const active = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + (argSet.timeoutMs || LAUNCH_TIMEOUT_MS);
    let failure = null;
    while (Date.now() < deadline) {
      if (launchError) { failure = `启动失败：${launchError.message}`; break; }
      if (fs.existsSync(active)) break;
      if (proc.exitCode !== null) { failure = `浏览器提前退出（退出码 ${proc.exitCode}），常见原因是 GPU 子进程不可用`; break; }
      if (signal?.aborted) { failure = '任务已取消'; break; }
      await sleep(100);
    }
    if (!failure && !fs.existsSync(active)) failure = `等待调试端口超时（${argSet.timeoutMs || LAUNCH_TIMEOUT_MS}ms）`;
    if (!failure) {
      try {
        const [port, endpoint] = fs.readFileSync(active, 'utf8').trim().split('\n');
        if (!port) throw Error('DevToolsActivePort 内容为空');
        attempts.push({ attempt: attemptIndex, args: argSet.label, ok: true });
        return { proc, port, endpoint, attempts, temporaryProfileBase: temporary ? base : null };
      } catch (error) {
        failure = `读取调试端口失败：${String(error.message).slice(0, 160)}`;
      }
    }
    attempts.push({ attempt: attemptIndex, args: argSet.label, error: failure });
    try { if (proc.exitCode === null) proc.kill(); } catch { /* 已退出 */ }
    await sleep(200);
  }
  if (temporary) { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 删不掉就留给系统临时目录清理 */ } }
  const detail = attempts.map(item => `${item.args}: ${item.error || '未知原因'}`).join('；');
  const error = Error(`后台浏览器三次启动尝试都失败（${detail}）`);
  error.attempts = attempts;
  throw error;
}

/**
 * 把控制器的浏览器核验写成客户看得懂的一行（执行者自己说"未验证"不代表 BEAT 没验）。
 * 没有核验记录时返回空串，不往报告里塞噪音。
 */
export function describeRenderEvidence(evidence) {
  const items = evidence || [];
  const rendered = items.filter(item => item.status === 'rendered');
  const failed = items.filter(item => item.status && item.status !== 'rendered');
  const lines = [];
  if (rendered.length) {
    lines.push('BEAT 独立核验（后台浏览器实际渲染，非模型自述）：' + rendered.map(item => {
      const animations = item.structure?.animations?.length ?? 0;
      // 有周期就报周期与首尾；没周期但有运动就报采样帧；脚本页明确说明不对闭合下结论。
      const loop = item.cycleMilliseconds
        ? `（循环 ${item.cycleMilliseconds}ms${item.exactLoopFramesEqual === true ? '，首尾帧一致' : item.exactLoopFramesEqual === false ? '，首尾帧不一致' : ''}）`
        : item.distinctFrames > 1 ? `（真实时间采样，${item.distinctFrames} 帧内容各不相同）`
        : item.distinctFrames === 1 ? '（采样帧内容相同，未观察到运动）' : '';
      const closureNote = item.loopClosureNote && item.exactLoopFramesEqual === null ? `；${item.loopClosureNote}` : '';
      const script = item.scriptExecution === 'enabled-network-blocked' ? '，页面脚本已执行（网络仍全拦）' : '';
      return `${item.browser || '浏览器'} · SVG ${item.structure?.svg ?? '?'} 个 · 动画 ${animations} 个${loop}${script}${closureNote} · 截图 ${item.screenshots?.length ?? 0} 张 · 证据 ${item.evidencePath || ''}`;
    }).join('；'));
  }
  if (failed.length) lines.push('BEAT 浏览器核验未完成：' + failed.map(item => `${item.file || ''}（${item.status}${item.issue ? '：' + item.issue : ''}）`).join('；'));
  return lines.length ? '\n' + lines.join('\n') : '';
}

/**
 * 把"没有拿到渲染证据"的原因整理成可以直接写进任务事件的一行行文本。
 * 静默跳过是历史缺陷，这里保证任何一次跳过、失败、浏览器缺失都有人能看见。
 */
export function describeRenderGaps(evidence) {
  const items = evidence || [];
  const lines = [];
  for (const item of items) {
    if (item.status === 'rendered') continue;
    const file = item.file ? path.basename(String(item.file)) : '(未知文件)';
    if (item.status === 'skipped') lines.push(`已交付 ${file}，但未做自动渲染核验：${item.issue || '原因未记录'}`);
    else if (item.status === 'browser-missing') lines.push(`已交付 ${file}，但本机没有可用于核验的浏览器：${item.issue || ''}`);
    else if (item.status === 'launch-failed') lines.push(`已交付 ${file}，但后台浏览器启动失败：${item.issue || ''}`);
    else if (item.status === 'unverified') lines.push(`已交付 ${file}，但后台渲染未完成：${item.issue || ''}`);
    else lines.push(`已交付 ${file}，但当前图片证据不可用：${item.issue || '源文件在渲染后发生变化，需要重新采样'}`);
  }
  return lines;
}

// 只有"确实要求看画面"的验收才触发自动渲染；否定句不是视觉要求。
// R408 实测：A4 打印页的验收写着"无外链字体或图片"，旧正则把它当成要看图；
// 页面没有内联 <svg>，渲染器按设计跳过，整项任务于是永远停在"核验图片尚未准备完整"，
// 依赖它的 PDF 任务也永远等不到依赖——一句否定验收把整条交付链卡死。
const VISUAL_TERMS = /画面|动画|视觉|外观|布局|排版|版式|对齐|裁切|清晰|可辨|辨认|目视|像素|截图|渲染|绘制|绘图|凤凰|visual|render|animation|screenshot/i;
const NEGATED_VISUAL = /(?:无|不含|不要|没有|禁止|避免|不使用|不引用|不包含)/;
/** 从验收条件里挑出真正要求"看画面"的分句；带否定的分句先剔除。 */
export function visualAcceptance(acceptance) {
  return (Array.isArray(acceptance) ? acceptance : []).map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && typeof item.description === 'string') return item.description;
    return JSON.stringify(item ?? '');
  }).flatMap(text => String(text).split(/[，。；;、\n]/)).filter(part => !NEGATED_VISUAL.test(part)).join('，');
}
export function wantsHtmlRender({ acceptance = [], artifacts = [] } = {}) {
  if ((artifacts || []).some(item => /\.(svg|png|jpe?g|webp|gif|bmp)$/i.test(item?.path || ''))) return true;
  return VISUAL_TERMS.test(visualAcceptance(acceptance));
}

export async function renderHtmlEvidence({ cwd, task, artifacts, evidenceRoot, profileRoot, signal, findBrowsers = browserCandidates, launch = launchBrowser }) {
  if (!wantsHtmlRender({ acceptance: task.acceptance, artifacts })) return [];
  const candidates = findBrowsers();
  const executable = candidates[0] || null;
  const results = [];
  const visualArtifacts = artifacts.filter(item => /\.(html?|svg|png|jpe?g|webp|gif|bmp)$/i.test(item.path));
  for (const artifact of visualArtifacts.slice(0, MAX_ARTIFACTS)) {
    if (signal?.aborted) break;
    let file, buffer;
    try {
      file = fs.realpathSync(artifact.path);
      const rootCwd = fs.realpathSync(cwd);
      if (!inside(rootCwd, file)) continue;
      buffer = fs.readFileSync(file);
    } catch { continue; }
    const raster = /\.(png|jpe?g|webp|gif|bmp)$/i.test(file);
    const maxBytes = raster ? 5 * 1024 * 1024 : MAX_HTML_BYTES;
    if (buffer.length > maxBytes) {
      results.push({ file, sha256: sha(buffer), status: 'skipped', issue: `文件 ${buffer.length} 字节超过 ${maxBytes} 的核验上限，未做渲染核验` });
      continue;
    }
    if (raster) {
      const ext = path.extname(file).toLowerCase();
      const valid = ext === '.png' ? buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : /^\.jpe?g$/.test(ext) ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
          : ext === '.gif' ? /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))
            : ext === '.webp' ? buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
              : buffer.subarray(0, 2).toString('ascii') === 'BM';
      if (!valid) { results.push({ file, sha256: sha(buffer), status:'unverified', issue:'文件内容与图片格式不符，尚未发送给模型；需要重新导出有效图片后继续核验' }); continue; }
    }
    const standalone = raster || /\.svg$/i.test(file);
    const classification = raster ? { eligible: true, scripted: false } : classifyHtml(buffer.toString('utf8'));
    const binding = { file, sha256: sha(buffer) };
    if (!classification.eligible) {
      // 早先这里直接 continue：买家看到"真实检查：[]"却查不到原因，只能自己手搓浏览器。
      results.push({ ...binding, status: 'skipped', issue: classification.reason, skippedReason: classification.reason });
      continue;
    }
    if (!executable) {
      results.push({ ...binding, status: 'browser-missing', issue: '本机没找到 Chrome / Edge / Brave / Chromium；可安装任一浏览器，或把对应的可执行文件路径加入 PATH' });
      continue;
    }
    const root = path.join(evidenceRoot, 'html-render-' + randomUUID());
    fs.mkdirSync(root, { recursive: true });
    const profile = profileRoot ? path.join(profileRoot, randomUUID()) : path.join(root, 'profile');
    fs.mkdirSync(profile, { recursive: true });
    let proc = null, socket = null, send = null, launchAttempts = [], temporaryProfileBase = null;
    let launchError = null; const pending = new Map();
    const deadline = Date.now() + 60_000;
    const alive = step => { if (signal?.aborted) throw Error('任务已取消，停止浏览器核验'); if (Date.now() > deadline) throw Error(`${step}：浏览器核验总超时，未验证`); };
    const abort = () => { for (const waiter of pending.values()) waiter.reject(Error('任务已取消')); pending.clear(); socket?.close(); if (proc && proc.exitCode === null) proc.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const launched = await launch(executable, profile, { signal });
      proc = launched.proc; launchAttempts = launched.attempts; temporaryProfileBase = launched.temporaryProfileBase || null;
      socket = new WebSocket(`ws://127.0.0.1:${launched.port}${launched.endpoint}`);
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('浏览器连接超时')), 8000); const finish = fn => arg => { clearTimeout(timer); fn(arg); }; socket.addEventListener('open', finish(resolve), { once: true }); socket.addEventListener('error', finish(reject), { once: true }); });
      let nextId = 0; const events = [];
      socket.addEventListener('message', event => { const data = JSON.parse(event.data); if (data.id) { const waiter = pending.get(data.id); if (!waiter) return; pending.delete(data.id); clearTimeout(waiter.timer); data.error ? waiter.reject(Error(data.error.message)) : waiter.resolve(data.result); } else events.push(data); });
      socket.addEventListener('close', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error('后台浏览器连接已关闭')); } pending.clear(); });
      send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { alive(method); const id = ++nextId; const timer = setTimeout(() => { pending.delete(id); reject(Error('浏览器核验超时：' + method)); }, 8000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
      const version = await send('Browser.getVersion');
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const page = (method, params) => send(method, params, sessionId);
      const evaluate = async expression => { const value = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (value.exceptionDetails) throw Error(value.exceptionDetails.text); return value.result.value; };
      await page('Page.enable'); await page('Runtime.enable'); await page('Network.enable');
      // 网络必须在导航之前拦住：页面脚本既读不到外部内容，也发不出内容。
      await page('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });
      const scriptExecution = classification.scripted ? 'enabled-network-blocked' : 'disabled';
      if (!classification.scripted) await page('Emulation.setScriptExecutionDisabled', { value: true });
      await page('Emulation.setDeviceMetricsOverride', { width: 1000, height: 850, deviceScaleFactor: 1, mobile: false });
      await page('Page.navigate', { url: pathToFileURL(file).href });
      while (!await evaluate('document.readyState === "complete"')) { alive('等待页面加载'); await sleep(50); }
      if (standalone) {
        const dimensions = await evaluate(raster
          ? '(()=>{const i=document.querySelector("img");return i?.complete&&i.naturalWidth?{width:i.naturalWidth,height:i.naturalHeight}:null})()'
          : '(()=>{const s=document.documentElement;if(s.localName!=="svg")return null;const v=s.viewBox.baseVal;return {width:v.width||s.width.baseVal.value,height:v.height||s.height.baseVal.value}})()');
        if (!dimensions || !(dimensions.width > 0 && dimensions.height > 0)) throw Error('图片无法正常解码或尺寸无效，尚未生成可核验画面');
        const scale = Math.min(1, 2048 / Math.max(dimensions.width, dimensions.height));
        const width = Math.max(64, Math.ceil(dimensions.width * scale)), height = Math.max(64, Math.ceil(dimensions.height * scale));
        await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await evaluate(raster
          ? `(()=>{document.body.style.cssText='margin:0;background:white';const i=document.querySelector('img');i.style.cssText='display:block;width:${width}px;height:${height}px;max-width:none;max-height:none';})()`
          : `(()=>{const s=document.documentElement;s.style.cssText+=';width:${width}px;height:${height}px;margin:0;display:block';})()`);
      }
      // 脚本驱动的动画要跑起来才采得到帧；给页面一点启动时间，但不无限等。
      if (classification.scripted) await sleep(150);
      const structure = await evaluate('({title:document.title,svg:document.querySelectorAll("svg").length,viewBox:document.querySelector("svg")?.getAttribute("viewBox"),scripts:document.scripts?.length||0,animations:document.getAnimations().map(a=>({name:a.animationName,duration:a.effect.getTiming().duration,state:a.playState}))})');
      const gcd = (a, b) => b ? gcd(b, a % b) : a;
      const durations = structure.animations.map(a => Math.round(Number(a.duration))).filter(n => n > 0 && Number.isFinite(n));
      let cycle = durations.reduce((a, b) => a / gcd(a, b) * b, 1); if (cycle > 120000 || !durations.length) cycle = null;
      // 只按 CSS 动画时长采样会漏掉 JS 驱动的动画：requestAnimationFrame 改属性不会进
      // document.getAnimations()，帧表为空就只采到一帧，等于"看起来验过了，其实什么也没证明"。
      // 所以没有可枚举的 CSS 动画时，按真实时间采样——帧不相等本身就是"动画在动"的证据。
      const timedSampling = !cycle;
      const times = standalone && !classification.scripted && !cycle && !/\.gif$/i.test(file) ? [0] : cycle ? [0, cycle / 4, cycle / 2, cycle * 3 / 4, cycle - 1, cycle] : [0, 400, 800, 1200, 1600, 2000];
      // 几何证据必须能反映 CSS transform 动画。getScreenCTM() 只看 SVG 属性变换，
      // CSS 动画旋转的元素在它眼里六帧完全一样——那样的"证据"证明不了轮子在转。
      // 所以这里补上合成后的最终矩阵（含 CSS 动画），两者都留。
      const SNAPSHOT_EXPR = t => `(()=>{
  document.getAnimations().forEach(a=>{try{a.pause();a.currentTime=${t};}catch(e){}});
  getComputedStyle(document.documentElement).transform;
  const round6=m=>m?[m.a,m.b,m.c,m.d,m.e,m.f].map(v=>Math.round(v*1000)/1000):null;
  const cssMatrix=el=>{try{const m=el.computedStyleMap?.().get('transform')?.toMatrix?.();return m?round6(m):null;}catch(e){return null;}};
  const animated=[...document.querySelectorAll('*')].filter(el=>getComputedStyle(el).transform!=='none').map(el=>({id:el.id||el.tagName.toLowerCase(),cssMatrix:cssMatrix(el)})).filter(x=>x.cssMatrix);
  const svg=[...document.querySelectorAll('svg [id]')].filter(x=>x.getScreenCTM).map(x=>({id:x.id,screenCTM:round6(x.getScreenCTM())}));
  return {animated,svg};
})()`;
      const snapshot = async t => {
        const geometry = await evaluate(SNAPSHOT_EXPR(t));
        const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        return { geometry, png: Buffer.from(data, 'base64') };
      };
      const samples = [];
      for (const t of times) {
        if (timedSampling && t) await sleep(Math.max(0, t - (samples.at(-1)?.milliseconds ?? 0)));
        const { geometry, png } = await snapshot(t);
        const screenshot = path.join(root, 'frame-' + t + '.png');
        fs.writeFileSync(screenshot, png); samples.push({ milliseconds: t, geometry, screenshot, sha256: sha(png) });
      }
      const unchanged = sha(fs.readFileSync(file)) === binding.sha256;
      const externalRequests = events.filter(e => e.method === 'Network.requestWillBeSent' && /^(https?|wss?):/.test(e.params.request.url)).map(e => e.params.request.url);
      const errors = events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => e.params.exceptionDetails.text);
      // 判定"有没有动"用几何真值，不用截图哈希：软件光栅下同一角度的抗锯齿可能逐帧微抖。
      const geometryKey = sample => JSON.stringify(sample.geometry);
      const distinctGeometry = new Set(samples.map(geometryKey)).size;
      const distinctFrames = new Set(samples.map(s => s.sha256)).size;
      // 首尾闭合只对**能被暂停的 CSS 动画**下结论。JS 用 requestAnimationFrame 逐帧改 DOM 属性时，
      // 暂停 CSS 动画拦不住它，两个采样点之间的实时推进会让 getScreenCTM() 无法逐位复现——
      // 那不是交付物没闭合，是测量噪声，所以这种情况必须诚实返回 null，不能编一个"没闭合"的结论。
      const cssOnlyKey = sample => JSON.stringify((sample.geometry.animated || []).map(item => [item.id, item.cssMatrix]));
      const closure = cycle && !classification.scripted ? geometryKey(samples[0]) === geometryKey(samples.at(-1)) : null;
      const cssClosure = cycle ? cssOnlyKey(samples[0]) === cssOnlyKey(samples.at(-1)) : null;
      // 只有"确实能对闭合下结论"（closure !== null）时才不需要说明；
      // 其余情况——含脚本、或没有可枚举周期——都必须留一句为什么不下结论。
      const loopClosureNote = closure !== null ? null
        : classification.scripted
          ? '页面含脚本：JS 驱动的运动不受暂停控制，控制器不对首尾闭合下结论，由非执行者看截图判断'
          : '没有可枚举的 CSS 动画周期，无法判定首尾闭合';
      const evidence = { ...binding, status: unchanged ? 'rendered' : 'stale', source: 'real-headless-browser-cdp', browser: version.product, scripted: classification.scripted, scriptExecution, pageScriptsDisabled: scriptExecution === 'disabled', networkBlocked: true, launchAttempt: launchAttempts.at(-1)?.args || null, capturedAt: new Date().toISOString(), structure, samplingMode: timedSampling ? 'real-time' : 'css-timeline', cycleMilliseconds: cycle, distinctFrames, distinctGeometry, samples, externalRequests, errors, exactLoopFramesEqual: closure, cssLoopFramesEqual: cssClosure, loopClosureNote, note: '这是实际渲染证据；部件对齐及运动质量仍须由非执行者对照截图核验，不能仅凭渲染成功判定通过。' };
      const evidencePath = path.join(root, 'evidence.json'); fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
      results.push({ ...binding, status: evidence.status, evidencePath, browser: evidence.browser, scripted: classification.scripted, scriptExecution, samplingMode: evidence.samplingMode, structure, cycleMilliseconds: cycle, distinctFrames, distinctGeometry, exactLoopFramesEqual: evidence.exactLoopFramesEqual, loopClosureNote: evidence.loopClosureNote, externalRequests, errors, screenshots: samples.map(s => s.screenshot), imageHashes: samples.map(s => ({ path: s.screenshot, sha256: s.sha256 })), note: evidence.note });
    } catch (error) {
      launchError = error;
      const attemptsDetail = (error.attempts || launchAttempts).map(item => `${item.args}: ${item.error || 'ok'}`).join('；');
      results.push({ ...binding, status: error.attempts ? 'launch-failed' : 'unverified', issue: String(error.message).slice(0, 500), launchAttempts: error.attempts || launchAttempts, attemptsDetail: attemptsDetail || null, scripted: classification.scripted });
    }
    finally { signal?.removeEventListener('abort', abort); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error('浏览器核验结束')); } pending.clear(); if (socket?.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch { /* 已经关了 */ } } socket?.close?.(); if (proc && proc.exitCode === null) proc.kill(); if (temporaryProfileBase) { try { fs.rmSync(temporaryProfileBase, { recursive: true, force: true }); } catch { /* 浏览器可能还占着目录，留给系统临时目录清理 */ } } }
  }
  for (const artifact of visualArtifacts.slice(MAX_ARTIFACTS)) results.push({ file: artifact.path, status: 'skipped', issue: '本轮图片核验数量已到上限，其余图片尚未核验；继续检查时须补齐这些图片，不能判定整体验收通过' });
  return results;
}
