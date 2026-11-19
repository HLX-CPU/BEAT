// 命令行：node src/cli.mjs <命令>。不带参数显示帮助。
import { spawn } from 'node:child_process';
import { call, ensureService } from './client.mjs';
import { loadConfig } from './config.mjs';
import { listWorkspaceGrants, addWorkspaceGrant, removeWorkspaceGrant } from './workspace-access.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = name => { const i = rest.indexOf('--' + name); if (i < 0) return undefined; const v = rest[i + 1]; rest.splice(i, 2); return v; };
const has = name => { const i = rest.indexOf('--' + name); if (i < 0) return false; rest.splice(i, 1); return true; };
const print = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const n = v => (v === undefined ? undefined : Number(v));

const HELP = `BEAT 三方协同 —— 命令行
  open                          启动服务并打开看板
  start | stop [--force]        启动 / 停止后台服务
  status                        三方在线状态、运行中的任务
  discuss "问题" [--by codex|deepseek] [--cwd 目录] [--turns 6]
                                难题讨论：并行提纲 → 分歧短投票 → 裁决 → 一份方案与短评审
  parallel "目标" [--by codex|deepseek] [--cwd 目录] [--rounds 3]
                                并行任务：明确验收与依赖 → 拉取小任务 → 逐项独立验收 → 局部返工
  get <任务号> [--wait 秒]       查看进度/结果
  list | cancel <任务号>
  ask <codex|deepseek|claude> "问题" [--session S1] [--model 模型ID] [--write] [--cwd 目录]
  agents [pause|resume <搭档>]   查看/手动暂停/恢复某一方（含拓展坞 dock:…）
  usage [--hours 24]            查看最近 token 用量与本机预算（不含金额，费用以提供方账单为准）
  folders [list | add <目录> | remove <目录>]
                                查看/授权/取消文件夹（命令行授权，不需要打开看板）
  release <任务号> [--task 小任务] [--note 说明]
                                核对现有文件后，解除被隔离的小任务并重新排队（不重放已完成写入）
  claude-test                   测试 Claude 号池联通性
  setup                         把 beat 注册到 Codex 与 DeepSeek 桌面端（会先备份原配置）`;

try {
  switch (cmd) {
    case 'open': {
      const url = await ensureService();
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      print('看板：' + url); break;
    }
    case 'start': print('BEAT 服务：' + await ensureService()); break;
    case 'stop': {
      const config = loadConfig();
      try { await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(800) }); } catch { print('服务没有在运行'); break; }
      print(await call('shutdown', { force: has('force') })); break;
    }
    case 'status': print(await call('beat_status')); break;
    case 'discuss': { const initiator = opt('by'), cwd = opt('cwd'), max_turns = n(opt('turns')); print(await call('beat_discuss', { question: rest.join(' '), initiator, cwd, max_turns })); break; }
    case 'parallel': { const initiator = opt('by'), cwd = opt('cwd'), max_rounds = n(opt('rounds')); print(await call('beat_parallel', { goal: rest.join(' '), initiator, cwd, max_rounds })); break; }
    case 'get': print(await call('beat_get', { id: rest[0], wait_seconds: n(opt('wait')) || 0 })); break;
    case 'list': print(await call('beat_list')); break;
    case 'cancel': print(await call('beat_cancel', { id: rest[0] })); break;
    case 'ask': {
      const session_id = opt('session'), cwd = opt('cwd'), model = opt('model'), write = has('write');
      const [to, ...q] = rest;
      const r = await call('beat_ask', { to, question: q.join(' '), session_id, model, cwd, access: write ? 'workspace-write' : undefined });
      print(r.finished ? `[${r.id} · 会话 ${r.session_id} · ${r.steps.at(-1)?.by || ''}]\n${r.result || r.error}` : r); break;
    }
    case 'agents': print(await call('beat_agents', rest[0] ? { action: rest[0], agent: rest[1] } : {})); break;
    case 'usage': print(await call('beat_usage', { hours: n(opt('hours')) })); break;
    case 'folders': {
      const config = loadConfig();
      const sub = rest[0];
      if (!sub || sub === 'list') { print(listWorkspaceGrants(config)); break; }
      if (sub === 'add') { print(addWorkspaceGrant(config, rest[1], has('read-only') ? 'read-only' : 'workspace-write')); break; }
      if (sub === 'remove') { print(removeWorkspaceGrant(config, rest[1])); break; }
      throw new Error('用法：folders [list | add <目录> [--read-only] | remove <目录>]');
    }
    case 'release': {
      const id = rest[0];
      if (!id) throw new Error('请写任务号，例如：release R499');
      const note = opt('note') || '命令行：主人核对已有文件后放行';
      const task = opt('task');
      if (task) { print(await call('beat_release', { id, task, note, cli: true })); break; }
      const view = await call('beat_get', { id, wait_seconds: 0 });
      const blocked = (view.taskQueue || []).filter(item => ['blocked', 'failed'].includes(item.state || item.status));
      if (!blocked.length) throw new Error('这个任务没有待解除隔离的小任务');
      for (const item of blocked) print(await call('beat_release', { id, task: item.id, note, cli: true }));
      break;
    }
    case 'claude-test': print(await call('claude_test')); break;
    case 'setup': await import('./setup.mjs'); break;
    default: print(HELP);
  }
} catch (e) { console.error('失败：' + e.message); process.exitCode = 1; }
