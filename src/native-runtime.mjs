// Installation detection is separate from model/tool capability verification.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { codexExecutable } from './config.mjs';
import { detectDeepseekRuntime } from './deepseek-runtime.mjs';
import { detectZcodeRuntime } from './zcode.mjs';
export { resolveDeepseekRuntime, deepseekHomeCandidates, findDeepseekSessionHome } from './deepseek-runtime.mjs';

let codexPackageCache;
const isFile = file => { try { return !!file && fs.statSync(file).isFile(); } catch { return false; } };
const hasCli = file => { if (!file) return false; try { const asar = file.match(/^(.*?\.asar)(?:[\\/]|$)/i)?.[1] || file; return isFile(asar) || fs.statSync(asar).isDirectory(); } catch { return false; } };

function codexDesktopInstalled() {
  if (process.platform !== 'win32') return false;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  for (const file of [path.join(local, 'Programs', 'Codex', 'Codex.exe'), path.join(local, 'OpenAI', 'Codex', 'Codex.exe')]) if (isFile(file)) return true;
  if (!codexPackageCache || Date.now() - codexPackageCache.at > 30000) {
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop | Where-Object { Test-Path -LiteralPath $_.InstallLocation }).Count"], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (probe.status !== 0 || !/^\d+$/.test(probe.stdout.trim())) throw new Error('桌面端安装状态暂时无法核验，请稍后再试；已有任务与文件已保留');
    codexPackageCache = { at: Date.now(), installed: Number(probe.stdout.trim()) > 0 };
  }
  return codexPackageCache.installed;
}

/**
 * 原生桌面端安装检测。探针（probe）只为测试注入，生产调用不传；
 * 注入的安装证据不许冒充本机真实安装，测试报告里要分别记录。
 */
export function nativeAvailability(config, agent, probe = {}) {
  const name = agent === 'codex' ? 'Codex' : agent === 'deepseek' ? 'DeepSeek' : agent === 'zcode' ? 'ZCode' : '';
  const codexInstalled = typeof probe.codexDesktopInstalled === 'function' ? probe.codexDesktopInstalled : codexDesktopInstalled;
  let installed = null;
  try {
    if (agent === 'codex') {
      if (!codexInstalled()) return { installed: false, available: false, reason: '未检测到 Codex 桌面端。安装并启动一次完成登录即可（之后不用保持运行，BEAT 会在后台调用）。' };
      installed = true;
      const executable = codexExecutable(config);
      if (!isFile(executable)) throw new Error('桌面端执行组件不可用');
    } else if (agent === 'deepseek') {
      const runtime = typeof probe.deepseekRuntime === 'function' ? probe.deepseekRuntime(config) : detectDeepseekRuntime(config);
      if (!runtime.executable) {
        return {
          installed: false, available: false,
          reason: '未检测到 DeepSeek Harness 桌面端。安装后打开一次完成登录即可（之后不用保持运行，BEAT 会在后台调用它）；也可以改用「拓展坞」接入 DeepSeek API 当搭档。',
        };
      }
      installed = true;
      if (!runtime.cli) return { installed: true, available: false, reason: 'DeepSeek Harness 缺少后台执行组件，请升级到最新版；或改用「拓展坞」接入 DeepSeek API 当搭档。' };
      if (!runtime.profileFile) {
        return {
          installed: true, available: false,
          reason: '已检测到 DeepSeek Harness，但还没完成首次登录：打开它登录一次即可（之后不用保持运行，BEAT 会在后台调用它）。',
        };
      }
    } else if (agent === 'zcode') {
      // ZCode 与拓展坞一样需要客户显式启用：没启用就不探测、不调用、不占额度。
      if (config.zcode?.enabled !== true) {
        return { installed: null, available: false, enabled: false, reason: '已在看板设置里开启 ZCode 后即可加入协作（需要 ZCode 桌面端并完成一次登录）。' };
      }
      const runtime = typeof probe.zcodeRuntime === 'function' ? probe.zcodeRuntime(config) : detectZcodeRuntime(config);
      if (!runtime.available) return { installed: false, available: false, enabled: true, reason: runtime.reason };
      installed = true;
      return { installed: true, available: true, toolSource: 'native-desktop', toolsVerified: false };
    } else return null;
    return { installed: true, available: true, toolSource: 'native-desktop', toolsVerified: false };
  } catch (e) {
    return { installed, available: false, reason: `${name || agent} ${e.message}` };
  }
}
