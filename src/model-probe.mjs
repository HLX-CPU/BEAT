// Manual, real-model verification only. Never imported by the automatic tests.
// Creates independent native test records and retained JSONL logs; not read-only.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { Models, capabilityRuntime } from './models.mjs';
import { askCodex } from './codex.mjs';
import { askDeepseek } from './deepseek.mjs';

export async function probe(config, provider, firstModel, nextModel) {
  const models = new Models(config);
  await models.validate(provider, firstModel); await models.validate(provider, nextModel);
  if (firstModel === nextModel) throw new Error('切换探针须提供两个不同的模型');
  const uuid = randomUUID(); const dir = path.join(config.dataDir, 'runtime', 'model-probes', uuid);
  fs.mkdirSync(dir, { recursive: true });
  const marker = 'BEAT_' + uuid.replaceAll('-', '');
  const ask = provider === 'codex' ? askCodex : askDeepseek;
  const evidence = { provider, firstModel, nextModel, dir, runtime: capabilityRuntime(config, provider), switchExisting: 'unverified', completed: false, contextPreserved: false, steps: [] };
  try {
    let nativeId;
    for (const [index, model] of [firstModel, firstModel, nextModel].entries()) {
      const prompt = index === 0 ? `Remember this marker in our conversation: ${marker}. Reply with the marker only. Do not use any tools.`
        : 'Reply with the exact marker I asked you to remember earlier, and nothing else. Do not use tools or search files.';
      const r = await ask(config, { prompt, model, nativeId, cwd: config.workspace, access: 'read-only', timeoutMs: 180000,
        title: 'BEAT · 独立模型与上下文测试 ' + uuid, logFile: path.join(dir, index + '.jsonl') });
      if (index && r.nativeId !== nativeId) throw new Error('续问原生 ID 改变，不能视为保留上下文');
      nativeId = r.nativeId;
      evidence.steps.push({ requestedModel: model, nativeId, actualModel: r.actualModel, modelVerified: r.modelVerified, modelEvidence: r.modelEvidence,
        contextPreserved: r.text.trim() === marker, completed: true });
      if (r.text.trim() !== marker) throw new Error('上下文标记回读失败');
    }
    evidence.completed = true; evidence.contextPreserved = true;
    if (evidence.steps.every(s => s.actualModel === s.requestedModel && s.modelVerified === 'verified')) evidence.switchExisting = 'supported';
  } catch (e) { evidence.error = e.message; throw e; }
  finally {
    fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
    const file = path.join(config.dataDir, 'runtime', 'model-capabilities.json'); let previous = {};
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    fs.writeFileSync(file, JSON.stringify({ ...previous, [provider]: evidence }, null, 2));
  }
  return evidence;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [provider, firstModel, nextModel] = process.argv.slice(2);
  if (!['codex', 'deepseek'].includes(provider) || !firstModel || !nextModel) {
    console.error('用法：node src/model-probe.mjs codex|deepseek 新建模型 切换模型（会产生独立测试记录）'); process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await probe(loadConfig(), provider, firstModel, nextModel), null, 2)); }
    catch (e) { console.error(e.message); process.exitCode = 1; }
  }
}
