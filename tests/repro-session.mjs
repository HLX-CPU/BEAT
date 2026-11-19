// 复现「同一会话只能问答一次」：分别走看板路径、带 model 的路径、并发路径。
import { loadConfig } from '../src/config.mjs';
const config = loadConfig();
const call = async (name, args = {}) => {
  const r = await fetch(`http://127.0.0.1:${config.port}/api/call`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + config.secrets.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args, actor: 'user' }),
  });
  return r.json();
};
const ask = async (label, args) => {
  const d = await call('beat_ask', args);
  const v = d.ok ? { id: d.result.id, session: d.result.session_id, state: d.result.state, result: (d.result.result || '').slice(0, 60), error: (d.result.error || '').slice(0, 200) } : { error: d.error };
  console.log(label, JSON.stringify(v));
  return d;
};

for (const to of ['deepseek', 'codex']) {
  console.log('=== ' + to + ' 连续三次 ===');
  const a = await ask('1)', { to, question: '只回复 一', wait_seconds: 200 });
  const sid = a.result?.session_id;
  if (sid) {
    await ask('2)', { to, question: '只回复 二', session_id: sid, wait_seconds: 200 });
    await ask('3)', { to, question: '只回复 三', session_id: sid, wait_seconds: 200 });
    // 客户端把模型一起传上来（桌面端的模型下拉会这样做）
    const m = a.result.requested_model;
    await ask('4) 带 model=' + m, { to, question: '只回复 四', session_id: sid, model: m, wait_seconds: 200 });
    // 并发两次
    console.log('5) 并发两次');
    const both = await Promise.all([
      call('beat_ask', { to, question: '只回复 五A', session_id: sid, wait_seconds: 200 }),
      call('beat_ask', { to, question: '只回复 五B', session_id: sid, wait_seconds: 200 }),
    ]);
    for (const d of both) console.log('   ', d.ok ? JSON.stringify({ id: d.result.id, state: d.result.state, result: (d.result.result || '').slice(0, 40), error: (d.result.error || '').slice(0, 160) }) : JSON.stringify({ error: d.error }));
  }
}
process.exit(0);
