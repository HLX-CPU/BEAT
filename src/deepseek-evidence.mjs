// Read only the requested native session. Effective dispatch + committed
// assistant response + completed turn is stronger evidence than a BEAT patch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
export function decodeFrames(buffer) {
  let at = 0, text = '';
  const need = n => { if (at + n > buffer.length) throw new Error('原生日志 Zstandard 帧不完整'); };
  while (at < buffer.length) {
    const start = at; need(5);
    if (buffer.readUInt32LE(at) !== 0xfd2fb528) throw new Error('原生日志 Zstandard 帧格式未知'); at += 4;
    const d = buffer[at++], flag = d >>> 6, single = !!(d & 32);
    if (d & 24) throw new Error('原生日志帧含保留位');
    const headerSize = (single ? 0 : 1) + [0, 1, 2, 4][d & 3] + (flag ? [0, 2, 4, 8][flag] : single ? 1 : 0);
    need(headerSize); at += headerSize;
    let last;
    do {
      need(3); const h = buffer.readUIntLE(at, 3); at += 3; last = !!(h & 1); const type = (h >>> 1) & 3;
      if (type === 3) throw new Error('原生日志含保留块');
      const length = type === 1 ? 1 : h >>> 3; need(length); at += length;
    } while (!last);
    if (d & 4) { need(4); at += 4; }
    text += zstdDecompressSync(buffer.subarray(start, at)).toString('utf8');
  }
  return text;
}
export function readNativeRows(config, nativeId, cwd) {
  if (!/^session-[A-Za-z0-9-]+$/.test(nativeId || '')) throw new Error('原生会话 ID 格式未知');
  const home = config.deepseek.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const base = path.join(home, 'sessions');
  const files = fs.readdirSync(base, { withFileTypes: true }).filter(x => x.isDirectory())
    .flatMap(x => ['session.v4.jsonl.zstd', 'session.v4.jsonl'].map(name => path.join(base, x.name, nativeId, name))).filter(f => fs.existsSync(f));
  if (files.length !== 1) throw new Error('原生 v4 日志缺失或位置不唯一');
  const file = files[0]; if (fs.statSync(file).size > 50_000_000) throw new Error('原生日志超出证据读取大小限制');
  const b = fs.readFileSync(file); const text = file.endsWith('.zstd') ? decodeFrames(b) : b.toString('utf8');
  const rows = text.split('\n').filter(Boolean).map(x => JSON.parse(x));
  const header = rows[0];
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (header?.type !== 'session' || header.version !== 4 || header.id !== nativeId || normalize(header.cwd) !== normalize(cwd)) throw new Error('原生日志会话或工作目录校验失败');
  return { file, rows };
}
export function nativeModelEvidence(config, { nativeId, cwd, afterSeq = 0, startedAt = 0 }) {
  try {
    const { file, rows } = readNativeRows(config, nativeId, cwd);
    const end = rows.findLast(x => x.type === 'turn/end');
    if (!end || end.seq <= afterSeq || !['completed', 'complete', 'stop'].includes(end.data?.reason?.kind)) throw new Error('没有本次调用的已完成原生轮次');
    const turn = end.data.turn;
    const start = rows.findLast(x => x.type === 'turn/start' && x.data?.turn === turn && x.seq < end.seq);
    if (!start || start.seq <= afterSeq || start.time < startedAt - 1000) throw new Error('原生轮次不是当前调用');
    const range = rows.filter(x => x.seq > start.seq && x.seq < end.seq);
    const requests = range.filter(x => x.type === 'request/header');
    const messages = range.filter(x => x.type === 'assistant/message' && x.data?.turn === turn);
    const configValue = requests.at(-1)?.data?.header?.config;
    if (!configValue?.model || !configValue.provider || !messages.length || requests.some(x => x.data?.header?.config?.model !== configValue.model || x.data?.header?.config?.provider !== configValue.provider)) throw new Error('原生模型路由不唯一或缺少已提交响应');
    return { actualModel: configValue.model, actualProvider: configValue.provider, modelVerified: 'verified', modelEvidence: {
      source: 'native-session request/header + assistant/message + turn/end', file, nativeId, turn,
      requestSeqs: requests.map(x => x.seq), assistantSeqs: messages.map(x => x.seq), completedSeq: end.seq,
      provider: configValue.provider, model: configValue.model,
    } };
  } catch (e) { return { actualModel: null, modelVerified: 'unknown', modelEvidence: { source: 'native-session', error: e.message } }; }
}
