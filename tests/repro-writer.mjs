// 诊断：BEAT 把 Codex 线程打开到桌面端后，还能不能继续写同一个线程？
// 1) 新建一个线程（会触发 codex:// 打开桌面端）  2) 同一个线程续问
import { loadConfig } from '../src/config.mjs';
import { askCodex } from '../src/codex-engine.mjs';
import { resolveWorkspace } from '../src/workspace.mjs';

const config = loadConfig();
const cwd = resolveWorkspace(config);
const step = async (label, nativeId) => {
  try {
    const r = await askCodex(config, { prompt: '只回复 ' + label, cwd, nativeId, timeoutMs: 300000, title: 'BEAT · writer 诊断' });
    console.log(`✔ ${label} native=${r.nativeId} text=${JSON.stringify(r.text.slice(0, 40))}`);
    return r.nativeId;
  } catch (e) {
    console.log(`✖ ${label} → ${e.message.slice(0, 300)}`);
    return null;
  }
};
const first = await step('ONE');
if (first) { await new Promise(r => setTimeout(r, 5000)); await step('TWO', first); }
process.exit(0);
