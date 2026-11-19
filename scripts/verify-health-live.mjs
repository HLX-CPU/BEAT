// Zero-inference production probe: only submit a task already proved over its
// objective budget; verify that no run/session/model request is created.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, VERSION } from '../src/config.mjs';
import { objectiveUsage, OBJECTIVE_TOKEN_LIMIT } from '../src/objective-budget.mjs';
const config = loadConfig(), db = new DatabaseSync(path.join(config.dataDir, 'beat.sqlite'), { readOnly: true });
try {
  const url = `http://127.0.0.1:${config.port}`;
  const health = await (await fetch(url + '/health')).json();
  if (health.actualVersion !== VERSION) throw Error('服务版本尚未更新，未提交探针');
  const previous = db.prepare('SELECT * FROM runs WHERE id=?').get('R289');
  const metricsFor = id => { const row = db.prepare('SELECT v FROM kv WHERE k=?').get('controlMetrics:' + id); return row ? JSON.parse(row.v) : null; };
  const usage = objectiveUsage(db.prepare('SELECT * FROM runs').all(), { goal: previous.goal, cwd: previous.cwd, metricsFor });
  if (usage.tokens < OBJECTIVE_TOKEN_LIMIT) throw Error('不满足零推理探针前置条件，未提交任何任务');
  const counts = () => Object.fromEntries(['runs', 'sessions', 'steps'].map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
  const before = counts();
  const reply = await (await fetch(url + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.secrets.token },
    body: JSON.stringify({ name: 'beat_ask', args: { to: 'codex', question: previous.goal, cwd: previous.cwd, access: 'read-only', wait_seconds: 0 }, actor: 'user', child: false }) })).json();
  const after = counts();
  const passed = reply.ok === false && String(reply.error).includes('重发保护线') && JSON.stringify(before) === JSON.stringify(after);
  const evidence = { at: new Date().toISOString(), version: health.actualVersion, priorRun: previous.id, recordedAndReservedTokens: usage.tokens,
    before, after, rejectedBeforeDispatch: passed, error: reply.error, customerIssue: reply.customerIssue };
  const file = path.join(config.dataDir, 'reports', `health-report-live-acceptance-${VERSION}-20261016.json`);
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ version: evidence.version, priorRun: evidence.priorRun, before, after, rejectedBeforeDispatch: passed, evidence: file }));
  if (!passed) process.exitCode = 1;
} finally { db.close(); }
