// 验证修复：两个写请求同时打同一个原生会话时，roster 应该原地等待重试，而不是失败/换人。
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { realAgents } from '../src/server.mjs';
import { resolveWorkspace } from '../src/workspace.mjs';

const config = loadConfig();
const store = new Store(config.dataDir + '/beat.sqlite');
const orch = new Orchestrator({ config, store, agents: realAgents(() => config) });
const cwd = resolveWorkspace(config);

const seed = orch.startAsk({ to: 'codex', question: '只回复 SEED', cwd });
for (let i = 0; i < 300 && !orch.isFinal(store.run(seed.id).state); i++) await new Promise(r => setTimeout(r, 500));
const sid = store.run(seed.id).session_id;
console.log('seed', seed.id, sid, store.run(seed.id).state);

// 同一会话并发两次写
const [a, b] = await Promise.all([
  orch.startAsk({ to: 'codex', question: '只回复 C1', session_id: sid, source: 'user' }),
  orch.startAsk({ to: 'codex', question: '只回复 C2', session_id: sid, source: 'user' }),
]);
for (let i = 0; i < 900 && !(orch.isFinal(store.run(a.id).state) && orch.isFinal(store.run(b.id).state)); i++) await new Promise(r => setTimeout(r, 500));
for (const id of [a.id, b.id]) {
  const r = store.run(id);
  console.log(id, r.state, JSON.stringify((r.result || r.error || '').slice(0, 90)));
}
console.log('重试事件：', store.events(40).filter(e => /正被另一个进程写入/.test(e.text)).length);
console.log('codex 是否被判下线：', orch.roster.state('codex').status);
process.exit(0);
