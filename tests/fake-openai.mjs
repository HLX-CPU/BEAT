// 本地假端点（OpenAI 兼容），用来手动/界面联调拓展坞：node tests/fake-openai.mjs [端口]
import http from 'node:http';
const port = Number(process.argv[2] || 18999);
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: ['fake-max', 'fake-vl-plus', 'fake-turbo'].map(id => ({ id, owned_by: 'fake' })) })); }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
  const j = JSON.parse(body);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
  if (j.tools?.length) send({ model: j.model, choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: j.tools[0].function.name, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
  else send({ model: j.model, choices: [{ delta: { content: 'OK' } }] });
  res.end('data: [DONE]\n\n');
}).listen(port, '127.0.0.1', () => console.log('fake openai on ' + port));
