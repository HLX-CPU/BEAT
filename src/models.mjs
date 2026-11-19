import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { codexExecutable } from './config.mjs';
import { deepseekProfileFor, deepseekModels } from './deepseek.mjs';
import { listCodexModels } from './codex.mjs';
import { resolveDeepseekRuntime } from './native-runtime.mjs';
import { parseModelSelection } from './zcode.mjs';

export function modelId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value)) {
    const e = new Error('模型 ID 无效'); e.modelError = true; throw e;
  }
  return value;
}

// No invented fallback: a failed resolution blocks only callers needing this default.
export function resolveDefault(config, provider) {
  if (provider === 'claude') return modelId(config.claude.model);
  // ZCode：CLI 的模型选择走 session/setModel（providerId/modelId，providerId 可含冒号，
  // 如登录写入的 'account:zai-individual-coding-plan/GLM-5.3'）；客户没填就按其登录计划的首选模型名。
  if (provider === 'zcode') {
    const value = String(config.zcode?.defaultModel || 'zai/glm-5.3');
    if (!parseModelSelection(value)) { const e = new Error('模型 ID 无效'); e.modelError = true; throw e; }
    return value;
  }
  if (!['codex', 'deepseek'].includes(provider)) throw new Error('未知模型提供方');
  if (config[provider]?.defaultModel) return modelId(config[provider].defaultModel);
  if (provider === 'deepseek') return modelId(deepseekProfileFor(config).profile.model);
  const file = path.join(config.codex.home, 'config.toml');
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { throw new Error('无法解析 Codex 默认模型：' + file); }
  const global = text.split(/^\s*\[/m)[0];
  const value = global.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!value) throw new Error('无法解析 Codex 默认模型：没有全局 model 字段');
  return modelId(value);
}
export function capabilityRuntime(config, provider) {
  if (provider === 'deepseek') config = { ...config, deepseek: { ...config.deepseek, ...resolveDeepseekRuntime(config) } };
  const executable = provider === 'codex' ? codexExecutable(config) : config.deepseek.executable;
  const files = [executable];
  if (provider === 'deepseek') {
    const asar = String(config.deepseek.cli || '').match(/^(.*?\.asar)(?:[\\/]|$)/)?.[1]; if (asar) files.push(asar);
  }
  const identity = { home: provider === 'codex' ? config.codex.home : config.deepseek.cli,
    files: files.map(file => { const s = fs.statSync(file); return { file, size: s.size, mtime: s.mtimeMs }; }) };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export class Models {
  constructor(config, { catalog, capabilities, deepseekRuntime } = {}) { this.config = config; this.catalog = catalog; this.capabilities = capabilities; this.deepseekRuntime = deepseekRuntime; }
  // 桌面端模型一律走「先发现、再读取」：客户不需要在配置里填任何路径（测试可注入 runtime）。
  deepseekProfile() { return deepseekProfileFor(this.config, { runtime: typeof this.deepseekRuntime === 'function' ? this.deepseekRuntime(this.config) : undefined }); }
  default(provider) { return resolveDefault(this.config, provider); }
  verifiedIds(provider) {
    const ids = this.store?.get('verifiedModels:' + provider) || [];
    try {
      const e = JSON.parse(fs.readFileSync(path.join(this.config.dataDir, 'runtime', 'model-capabilities.json'), 'utf8'))[provider];
      if (e?.runtime === capabilityRuntime(this.config, provider)) for (const s of e.steps || []) if (s.completed && s.modelVerified === 'verified' && s.actualModel && s.modelEvidence) ids.push(s.actualModel);
    } catch { /* no completed runtime evidence */ }
    return new Set(ids);
  }
  switchExisting(provider) {
    // Only a completed independent context-preserving probe may enable switching.
    if (this.capabilities) return this.capabilities[provider] || 'unverified';
    try {
      const evidence = JSON.parse(fs.readFileSync(path.join(this.config.dataDir, 'runtime', 'model-capabilities.json'), 'utf8'));
      const e = evidence[provider];
      const runtime = capabilityRuntime(this.config, provider);
      const steps = e?.steps;
      const valid = Array.isArray(steps) && steps.length === 3 && steps[0].requestedModel !== steps[2].requestedModel
        && !!steps[0].nativeId && steps.every(s => s.nativeId === steps[0].nativeId && s.completed === true && s.contextPreserved === true && s.modelVerified === 'verified' && s.actualModel === s.requestedModel);
      return e?.switchExisting === 'supported' && valid && e.contextPreserved === true && e.completed === true && e.runtime === runtime
        ? 'supported' : 'unverified';
    } catch { return 'unverified'; }
  }
  async list(provider) {
    if (!['codex', 'deepseek'].includes(provider)) throw new Error('provider 只能是 codex 或 deepseek');
    if (this.catalog) return { ...(await this.catalog(provider)), switchExisting: this.switchExisting(provider) };
    if (provider === 'deepseek') {
      const verified = this.verifiedIds(provider);
      const { file } = this.deepseekProfile();
      return { source: 'desktop-profile', models: deepseekModels(file).map(m => ({ ...m, availability: verified.has(m.id) ? 'verified' : m.availability })), switchExisting: this.switchExisting(provider) };
    }
    try {
      const verified = this.verifiedIds(provider);
      return { source: 'app-server:model/list', models: (await listCodexModels(this.config)).map(m => ({ ...m, availability: verified.has(m.id) ? 'verified' : m.availability })), switchExisting: this.switchExisting(provider) };
    }
    catch (e) {
      return { source: 'configured-default', models: [{ id: this.default(provider), name: this.default(provider), availability: 'configured' }],
        switchExisting: this.switchExisting(provider), error: 'model/list 未取得：' + e.message };
    }
  }
  requireSwitch(provider) {
    if (this.switchExisting(provider) !== 'supported') throw new Error(provider + ' 保留上下文切换模型未验证或不支持，未改写会话');
  }
  async validate(provider, model) {
    modelId(model);
    const list = await this.list(provider);
    if (!list.models.some(m => m.id === model)) {
      const e = new Error('该提供方没有配置或列出模型：' + model); e.modelError = true; throw e;
    }
  }
  // 推理强度：按该模型自己公布的可选值校验（Codex 来自 model/list，DeepSeek 来自适配器）。
  async validateEffort(provider, model, effort) {
    if (effort == null || effort === '') return null;
    if (!['codex', 'deepseek'].includes(provider)) throw new Error('只有 Codex / DeepSeek 支持推理强度');
    if (typeof effort !== 'string' || !/^[a-z]{2,16}$/.test(effort)) { const e = new Error('推理强度格式无效：' + effort); e.modelError = true; throw e; }
    const id = model || this.default(provider);
    const list = await this.list(provider);
    const m = list.models.find(x => x.id === id);
    const allowed = m?.efforts?.length ? m.efforts : list.models.find(x => x.efforts?.length)?.efforts;
    if (allowed && !allowed.includes(effort)) {
      const e = new Error(`${provider === 'codex' ? 'Codex' : 'DeepSeek'} 模型 ${id} 不支持推理强度 ${effort}（可选：${allowed.join(' / ')}）`); e.modelError = true; throw e;
    }
    return effort;
  }
  defaultEffort(provider) { return this.config[provider]?.defaultEffort || null; }
}
