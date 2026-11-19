// 实机端到端：真的调用 Codex / DeepSeek / Claude 跑一次讨论和一次并行任务（会消耗少量额度）。
// 用法：node tests/live-e2e.mjs [discuss|parallel|all]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { realAgents } from '../src/server.mjs';

const which = process.argv[2] || 'all';
const config = loadConfig();
const store = new Store(path.join(config.dataDir, 'beat.sqlite'));
const orch = new Orchestrator({ config, store, agents: realAgents(() => config) });
const dir = path.join(config.allowedRoots[0], 'live-e2e-' + Date.now());
fs.mkdirSync(dir, { recursive: true });

async function follow(id) {
  let seen = 0;
  for (;;) {
    const v = orch.view(id);
    for (const s of v.steps.slice(seen)) {
      if (s.state === 'running') break;
      console.log(`  [${s.role}${s.round ? ' ' + s.round : ''}] ${s.by} · ${s.note || s.state} · ${Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 1000)}s${s.error ? ' · 出错/顶替：' + s.error.slice(0, 120) : ''}`); seen++;
    }
    if (v.finished) return v;
    await new Promise(r => setTimeout(r, 2000));
  }
}

if (which !== 'parallel') {
  console.log('== 讨论 ==');
  const r = orch.startDiscuss({ question: '一个 Node.js 小工具要在本机持久化几百条待办事项，选 JSON 文件还是 node:sqlite？给出明确选择和理由，简短回答。', initiator: 'codex', cwd: dir, max_turns: 4 });
  const v = await follow(r.id);
  console.log(v.state, v.verdict, '\n', (v.result || v.error).slice(0, 600));
}
if (which !== 'discuss') {
  console.log('== 并行 ==');
  const r = orch.startParallel({ initiator: 'deepseek', cwd: dir, max_rounds: 2, max_turns: 4,
    goal: '在工作目录里做一个极小的数学库：math.mjs 导出 add(a,b) 和 mul(a,b)；math.test.mjs 用 node:test 测试这两个函数。请把实现和测试分给两方并行完成。验收：node --test 全部通过。' });
  const v = await follow(r.id);
  console.log(v.state, '\n', (v.result || v.error).slice(0, 800));
  console.log('文件：', fs.readdirSync(dir));
}
process.exit(0);
