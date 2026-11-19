// 诊断拓展坞端点：看 /chat/completions 实际返回了什么（不打印密钥）。
// 用法：node tests/probe-dock.mjs [名称关键字] [模型]
import { loadConfig, redact } from '../src/config.mjs';
import { dockList, dockKey } from '../src/dock.mjs';

const config = loadConfig();
const d = dockList(config).find(x => !process.argv[2] || x.name.includes(process.argv[2]) || x.id === process.argv[2]);
if (!d) { console.log('拓展坞里没有匹配的条目：', dockList(config).map(x => x.name)); process.exit(1); }
const key = dockKey(config, d.id), model = process.argv[3] || d.model;
console.log('条目：', d.name, '| 基础地址：', d.baseUrl, '| 模型：', model);
const bases = [...new Set([d.baseUrl.replace(/\/+$/, ''), d.baseUrl.replace(/\/+$/, '') + '/v1'])];
for (const base of bases) for (const stream of [true, false]) {
  const url = base + '/chat/completions';
  try {
    const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ model, stream, max_tokens: 32, messages: [{ role: 'user', content: '只回复 OK' }] }) });
    const text = await r.text();
    console.log(`\n${url}  stream=${stream}\n  HTTP ${r.status}  content-type: ${r.headers.get('content-type')}\n  前 400 字：${redact(text, config).replace(/\s+/g, ' ').slice(0, 400)}`);
  } catch (e) { console.log(`\n${url} stream=${stream}\n  请求失败：${e.cause?.code || e.message}`); }
}
process.exit(0);
