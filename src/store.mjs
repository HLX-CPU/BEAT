// 存储：一个 SQLite 文件记录任务（runs）、每一步（steps）、可续问的会话（sessions）、事件流（events）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { failureRecord } from './failure-record.mjs';

const now = () => new Date().toISOString();
const JSON_COLS = { runs: ['plan', 'natives', 'attachments', 'efforts'], steps: ['data'], sessions: ['natives'] };

export class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.file = file;
    // VACUUM INTO includes WAL content and produces one consistent SQLite image.
    const exists = this.db.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get();
    if (exists && !this.db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === 'model')) this.backup();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, n INTEGER NOT NULL, kind TEXT NOT NULL, goal TEXT NOT NULL, cwd TEXT NOT NULL, state TEXT NOT NULL,
        initiator TEXT, target TEXT, access TEXT, session_id TEXT, max_turns INTEGER, max_rounds INTEGER, rounds INTEGER NOT NULL DEFAULT 0,
        verdict TEXT, result TEXT, error TEXT, plan TEXT, natives TEXT, source TEXT,
        created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
      CREATE TABLE IF NOT EXISTS steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, role TEXT NOT NULL, seat TEXT, agent TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, prompt TEXT, output TEXT, error TEXT, note TEXT, data TEXT,
        started_at TEXT NOT NULL, ended_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, id);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, n INTEGER NOT NULL, seat TEXT NOT NULL, cwd TEXT NOT NULL, access TEXT NOT NULL, natives TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, run_id TEXT, type TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    this.transaction(() => {
      for (const [table, columns] of Object.entries({
        sessions: { model: 'TEXT', model_source: 'TEXT', actual_agent: 'TEXT', actual_model: 'TEXT', model_verified: "TEXT NOT NULL DEFAULT 'unknown'", effort: 'TEXT' },
        runs: { requested_model: 'TEXT', model_source: 'TEXT', default_models: 'TEXT', attachments: 'TEXT', efforts: 'TEXT' },
        steps: { requested_model: 'TEXT', actual_model: 'TEXT', model_verified: "TEXT NOT NULL DEFAULT 'unknown'", effort: 'TEXT' },
      })) {
        const have = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
        for (const [name, type] of Object.entries(columns)) if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
      if (this.get('sessionsRevision') === null) this.set('sessionsRevision', 0);
    });
  }
  backup() {
    const file = this.file + '.pre-model-' + randomUUID() + '.sqlite';
    this.db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('迁移备份校验失败');
      const rows = copy.prepare('SELECT id,n,seat,cwd,access,natives,created_at,updated_at FROM sessions ORDER BY id').all();
      const original = this.db.prepare('SELECT id,n,seat,cwd,access,natives,created_at,updated_at FROM sessions ORDER BY id').all();
      if (JSON.stringify(rows) !== JSON.stringify(original)) throw new Error('迁移备份回读不一致，请停止写入后重试');
      for (const name of ['runs', 'steps', 'events', 'kv']) {
        if (this.db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(name)
          && copy.prepare(`SELECT count(*) n FROM ${name}`).get().n !== this.db.prepare(`SELECT count(*) n FROM ${name}`).get().n) throw new Error('迁移备份表回读不一致：' + name);
      }
      this.backupFile = file;
    } finally { copy.close(); }
    return file;
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  // skip(seat)：明确"没有提供方模型"的席位（本机智能体 local:*）不参与迁移，也不因此让整体迁移失败。
  // 没有 skip 时行为与以前完全一致：任一席位解析不出默认模型就整体拒绝迁移。
  migrateModels(resolve, { skip } = {}) {
    const pend = typeof skip === 'function' ? ({ seat }) => skip(seat) : () => false;
    const pending = this.db.prepare('SELECT DISTINCT seat FROM sessions WHERE model IS NULL').all().filter(row => !pend(row));
    if (!pending.length) return;
    const defaults = Object.fromEntries(pending.map(({ seat }) => [seat, resolve(seat)]));
    if (Object.values(defaults).some(v => !v)) throw new Error('历史会话默认模型无法解析，未迁移');
    if (!this.backupFile) this.backup();
    this.transaction(() => {
      for (const [seat, model] of Object.entries(defaults)) this.db.prepare("UPDATE sessions SET model=?,model_source='migrated',actual_model=NULL,model_verified='unknown' WHERE model IS NULL AND seat=?").run(model, seat);
      this.bumpSessions();
      // 回读校验只看本次迁移的席位：被 skip 掉的席位（本机智能体）留着 model=NULL 是正常的。
      const seats = Object.keys(defaults);
      const marks = seats.map(() => '?').join(',');
      if (this.db.prepare('SELECT count(*) n FROM sessions WHERE model IS NULL AND seat IN (' + marks + ')').get(...seats).n) throw new Error('模型迁移回读失败');
      this.set('modelMigration', { defaults, backup: this.backupFile, at: now() });
    });
  }
  bumpSessions() { this.set('sessionsRevision', (this.get('sessionsRevision') || 0) + 1); }
  sessionsRevision() { return this.get('sessionsRevision') || 0; }
  sessions(limit = 100) {
    limit = Number(limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit 必须为 1 到 1000 的整数');
    // One SQLite SELECT gives revision and list the same read snapshot.
    const rows = this.db.prepare(`SELECT (SELECT v FROM kv WHERE k='sessionsRevision') revision, s.*
      FROM (SELECT 1) LEFT JOIN (SELECT * FROM sessions ORDER BY updated_at DESC,n DESC LIMIT ?) s ON 1=1`).all(limit);
    return { revision: Number(rows[0].revision || 0), items: rows.filter(r => r.id).map(r => ({
      id: r.id, seat: r.seat, model: r.model, modelSource: r.model_source, actualAgent: r.actual_agent,
      actualModel: r.actual_model, modelVerified: r.model_verified, updated_at: r.updated_at,
    })) };
  }
  nextN(table) { return Number(this.db.prepare(`SELECT COALESCE(MAX(n),0)+1 AS n FROM ${table}`).get().n); }
  decode(table, row) {
    if (!row) return row;
    for (const c of JSON_COLS[table] || []) if (row[c]) { try { row[c] = JSON.parse(row[c]); } catch { /* 保留原文 */ } }
    return row;
  }

  createRun(r) {
    const n = this.nextN('runs');
    const row = { id: 'R' + n, n, kind: r.kind, goal: r.goal, cwd: r.cwd, state: 'queued', initiator: r.initiator ?? null, target: r.target ?? null,
      access: r.access ?? null, session_id: r.session_id ?? null, max_turns: r.max_turns ?? null, max_rounds: r.max_rounds ?? null, source: r.source ?? null, created_at: now() };
    this.db.prepare(`INSERT INTO runs (id,n,kind,goal,cwd,state,initiator,target,access,session_id,max_turns,max_rounds,source,created_at)
      VALUES (@id,@n,@kind,@goal,@cwd,@state,@initiator,@target,@access,@session_id,@max_turns,@max_rounds,@source,@created_at)`).run(row);
    if (r.requested_model !== undefined) this.updateRun(row.id, { requested_model: r.requested_model, model_source: r.model_source, default_models: JSON.stringify(r.default_models || {}) });
    return this.run(row.id);
  }
  run(id) { const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(String(id).toUpperCase()); if (!r) throw new Error('找不到任务 ' + id); return this.decode('runs', r); }
  runs(limit = 30) { return this.db.prepare('SELECT * FROM runs ORDER BY n DESC LIMIT ?').all(limit).map(r => this.decode('runs', r)); }
  updateRun(id, fields) {
    const run = this.update('runs', id, fields);
    if (['failed', 'error', 'interrupted'].includes(fields.state)) {
      const failure = failureRecord({ ...run, issues: fields.state === 'failed' ? this.get('verdict:' + id)?.issues || [] : [], steps: this.steps(id) });
      this.set('failure:' + id, failure);
      // Retain every failed attempt across continuation, never replace history with success.
      const history = this.get('failureHistory:' + id) || [];
      history.push(failure); this.set('failureHistory:' + id, history);
    }
    return run;
  }

  addStep(s) {
    return Number(this.db.prepare('INSERT INTO steps (run_id,role,seat,agent,round,state,prompt,started_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(s.run_id, s.role, s.seat ?? null, s.agent, s.round || 0, 'running', s.prompt ?? null, now()).lastInsertRowid);
  }
  updateStep(id, fields) { return this.update('steps', id, fields); }
  steps(runId) { return this.db.prepare('SELECT * FROM steps WHERE run_id=? ORDER BY id').all(runId).map(s => this.decode('steps', s)); }

  createSession(s) {
    return this.transaction(() => {
    const n = this.nextN('sessions');
    const row = { id: 'S' + n, n, seat: s.seat, cwd: s.cwd, access: s.access || 'read-only', created_at: now(), updated_at: now() };
    this.db.prepare('INSERT INTO sessions (id,n,seat,cwd,access,created_at,updated_at) VALUES (@id,@n,@seat,@cwd,@access,@created_at,@updated_at)').run(row);
    this.update('sessions', row.id, { model: s.model ?? null, model_source: s.model_source || 'default', model_verified: 'unknown' });
    this.bumpSessions();
    return this.session(row.id);
    });
  }
  session(id) { const r = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(String(id).toUpperCase()); if (!r) throw new Error('找不到会话 ' + id); return this.decode('sessions', r); }
  updateSession(id, fields) {
    return this.transaction(() => {
      this.session(id);
      const result = this.update('sessions', String(id).toUpperCase(), { ...fields, updated_at: now() });
      this.bumpSessions(); return result;
    });
  }

  update(table, id, fields) {
    const keys = Object.keys(fields);
    const val = (k, v) => (JSON_COLS[table]?.includes(k) && v != null && typeof v !== 'string' ? JSON.stringify(v) : v ?? null);
    if (keys.length) this.db.prepare(`UPDATE ${table} SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => val(k, fields[k])), id);
    return this.decode(table, this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id));
  }

  event(runId, type, text) { this.db.prepare('INSERT INTO events (ts,run_id,type,text) VALUES (?,?,?,?)').run(now(), runId ?? null, type, text); }
  events(limit = 40) { return this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(limit); }

  get(k) { const r = this.db.prepare('SELECT v FROM kv WHERE k=?').get(k); return r ? JSON.parse(r.v) : null; }
  set(k, v) {
    if (v === null || v === undefined) this.db.prepare('DELETE FROM kv WHERE k=?').run(k);
    else this.db.prepare('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v));
  }

  // 服务重启：未结束的任务标为 interrupted，不自动重放（可能已经写过文件）。
  recover() {
    const t = now();
    this.db.prepare("UPDATE steps SET state='interrupted',ended_at=? WHERE state='running'").run(t);
    for (const run of this.db.prepare("SELECT id FROM runs WHERE state IN ('queued','running')").all())
      this.updateRun(run.id, { state: 'interrupted', error: '服务重启，任务中断；并行任务可在看板点「继续执行」接着做', ended_at: t });
  }
  close() { this.db.close(); }
}
