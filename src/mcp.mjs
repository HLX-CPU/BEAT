// MCP stdio 服务器（零依赖）：Codex 与 DeepSeek 桌面端都注册它，服务名 beat。
// 用法：node src/mcp.mjs --as codex|deepseek
import { MCP_TOOLS } from './tools.mjs';
import { call } from './client.mjs';
import { VERSION } from './config.mjs';
import { schemas as assistantSchemas } from '../workspaces/shared/desktop-assistant/core/schemas.mjs';

const argv = process.argv;
const flag = argv.findIndex(a => a === '--as' || a === '--actor');
const actor = flag >= 0 ? argv[flag + 1] : 'codex';
const worker = argv.includes('--worker');
const nativeActor = ['codex', 'deepseek'].includes(actor);
const actorTools = nativeActor ? MCP_TOOLS.filter(t => !Object.hasOwn(assistantSchemas, t.name)) : MCP_TOOLS;
const exposedTools = worker ? actorTools.filter(t => t.name === 'desktop_call') : actorTools;

const INSTRUCTIONS = `BEAT 平等搭档协同：Codex、DeepSeek、拓展坞＋助手地位相同，Claude 是执行失败或受阻时的只读顾问。
- 难题、想听搭档意见：beat_discuss(question)。默认各搭档并行出短提纲，代码归并共识，仅讨论分歧；3/4多数通过，平票或停滞一次裁决，严重安全反对必须单独解决。只展开一份方案，其他人短评审。
- 可以拆开执行的任务：beat_parallel(goal)。默认提纲收敛后进入带依赖、文件范围、心跳租约和预算的小任务拉取队列；每项做完立即由代码和非执行者验收，最多重试2次再升级或停止。产物只按文件引用传递。各阶段在看板设置里独立开关。旧任务沿原流程续接。
- Codex、DeepSeek 使用自己桌面端的原生工具、已安装 MCP 和技能；BEAT 电脑助手专供拓展坞模型。先观察再操作，遵守所用工具的确认、租约与权限规则，未知输入结果不能自动重放。
- 同一任务中每个搭档固定会话，讨论/执行/评估/恢复持续追加；新任务才新建。原生会话的沙箱模式在创建时固定（DeepSeek Harness 恢复会话不会改用新预设），所以需要写权限的执行/返工使用另一条创建时就是可写的固定会话，讨论与核验仍走只读会话。beat_get 的 conversations 可核对固定 conversationId、policy 与原生 nativeId。
- 只想问一句：beat_ask(to=codex|deepseek|claude, question)，续问带 session_id。
- 用 beat_get(id, wait_seconds=240) 跟进；finished=true 才算结束，并行任务 state=passed 才是评估通过。
- 对方看不到你们的聊天：问题/目标里必须写完整背景与约束。`;

const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(m) {
  const { id, method, params = {} } = m;
  if (method === 'initialize') {
    return reply(id, { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'beat', title: 'BEAT 三方协同', version: VERSION }, instructions: worker ? '执行搭档仅使用 desktop_call。文件优先后台接口，桌面位置用真实用户文件夹别名；每次操作带任务提供的 contextId/cwd。人类确认、租约和未知操作保护保留。不可发起协作或自行批准。' : INSTRUCTIONS });
  }
  if (method === 'tools/list') return reply(id, { tools: exposedTools });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/call') {
    try {
      if (!exposedTools.some(t => t.name === params.name)) throw new Error('当前搭档不能调用这项 BEAT 工具；原生搭档请使用自己的桌面端工具。');
      const result = await call(params.name, params.arguments || {}, { actor });
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return reply(id, { isError: true, content: [{ type: 'text', text: e.message }] });
    }
  }
  if (id !== undefined) fail(id, -32601, '不支持的方法：' + method);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { fail(null, -32700, 'JSON 解析失败'); continue; }
    handle(m).catch(e => m.id !== undefined && fail(m.id, -32603, e.message));
  }
});
process.stdin.on('end', () => process.exit(0));
