// 拉取式小任务队列（SQLite 持久化）
//
// 设计要点：
//  - 复用调用方传入的 Store.db（node:sqlite DatabaseSync），不改动 Store 自身 schema 语义。
//  - claim 用 BEGIN IMMEDIATE + COMMIT 原子领取，多实例（多 DatabaseSync 连接）互斥。
//  - 每次领取发放新的 leaseToken（fencing token）；所有写入都要校验 token + 租约未过期，
//    过期即拒绝，防止旧执行者回写覆盖新一轮执行者的结果。
//  - 心跳续租；超时只在“确认持有 pid 已退出且无未知副作用”时才回收重领。
//    活 pid（或无法确认死亡）超时：只标记 stale 并强制过期租约，绝不重新入队。
//    未确认退出（执行者未 complete）且存在未知副作用：隔离为 blocked/unconfirmed-exit，不重领。
//  - 同一 workspace 内文件范围互斥：Windows 大小写不敏感、父子路径冲突；无 files 的任务独占，
//    不得与任何任务并行。路径不得越出 cwd。
//  - 依赖只有 passed 才释放；重复 id / 缺依赖 / cycle 一律 fail closed。
//  - 执行完进入 verifying，由“非执行者”审核；失败携具体 issues 重入队，最多 maxRetries(<=2) 次，
//    之后升级 strong worker，仍不通过则 blocked，不无限返工。
//  - 检查点持久化（路径 + 摘要 + 已完成项），下一执行者据此只续未完成项。
//  - token 记账，预算用尽止损（不再领取，交 strong worker / 人工）。
//  - cancel 保留证据（任务、尝试、检查点、事件都不删除）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { insideDirectory, insideReal } from './path-containment.mjs';

export const STATUS = Object.freeze(['queued', 'running', 'verifying', 'passed', 'blocked']);

/** 租约丢失 / token 失效 / 租约过期：调用方必须放弃本次执行结果。 */
export class LeaseLostError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LeaseLostError';
    this.code = 'LEASE_LOST';
    Object.assign(this, detail);
  }
}

/** 契约/校验错误：重复 id、缺依赖、环、越界路径、超预算等。 */
export class QueueError extends Error {
  constructor(message, code = 'QUEUE_CONTRACT', detail = {}) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
    Object.assign(this, detail);
  }
}

const MAX_RETRIES = 2;
const DIFF_RANK = { easy: 1, normal: 2, hard: 3 };
// tq_tasks 的 JSON payload 列：走 tq_payload 表。
const PAYLOAD_FIELDS = ['result', 'usage', 'last_checkpoint', 'history'];
// tq_tasks 的 JSON TEXT 列：直接写列。
const JSON_FIELDS = ['files', 'depends_on', 'acceptance', 'checks', 'issues', 'scope'];
const DEFAULT_CWD = process.cwd();

function iso(ms) {
  const n = Number(ms);
  return new Date(Number.isFinite(n) ? n : Date.now()).toISOString();
}

function parseJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch { return fallback; }
}

function asArray(value) {
  if (value === null || value === undefined || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

/** 长路径（Windows \\?\ 前缀）规避 MAX_PATH 限制，用于大小写探测。 */
function longPath(p) {
  const abs = path.resolve(p);
  if (process.platform !== 'win32') return abs;
  return abs.startsWith('\\\\?\\') ? abs : '\\\\?\\' + abs;
}

/** 在真实文件系统上探测某路径是否大小写不敏感（Windows 一般 true）。 */
function detectCaseInsensitive(cwd) {
  if (process.platform !== 'win32') return false;
  const probe = path.resolve(cwd, `.__beat_case_probe_${process.pid}_${randomUUID().slice(0, 8)}`);
  let made = false;
  try {
    fs.writeFileSync(probe, 'x');
    made = true;
    // 用 \\?\ 前缀绕过路径归一化，才能观察到真实文件系统的行为。
    fs.accessSync(longPath(probe.toUpperCase()));
    return true;
  } catch {
    return false;
  } finally {
    if (made) { try { fs.unlinkSync(probe); } catch { /* 探测文件残留无害 */ } }
  }
}

function mkdirQuiet(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return;
    throw e;
  }
}

/**
 * 路径归一化：相对 cwd 解析、拒绝越界；按需折叠大小写。
 * 越界返回 null，由调用方 fail closed。
 */
function normalizePath(cwd, rel, caseInsensitive) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const abs = path.resolve(cwd, rel);
  const r = path.relative(cwd, abs);
  if (r === '') return '.';
  if (path.isAbsolute(r) || r === '..' || r.startsWith('..' + path.sep)) return null;
  const norm = abs.split(path.sep).join('/');
  return caseInsensitive ? norm.toLowerCase() : norm;
}

// 交付文件可以在任务目录外（客户明确要求写到某个位置时）。这里只做路径归一，不再限制根目录；
// 是否存在、是否普通文件、哈希是否一致由调用方继续核对。
function normalizeArtifactPath(cwd, value, caseInsensitive) {
  const absolute = path.resolve(cwd, String(value));
  const norm = absolute.split(path.sep).join('/');
  return caseInsensitive ? norm.toLowerCase() : norm;
}

// 交付物路径：绝对路径是客户/方案显式声明的位置，允许在任务目录外；
// 相对路径仍按真实路径限制在任务目录内（防 link/junction 借相对路径逃逸）。
function artifactFile(cwd, value) {
  const text = String(value);
  const absolute = path.resolve(cwd, text);
  if (!path.isAbsolute(text)) assertRealPathInside(cwd, text);
  if (fs.lstatSync(absolute).isSymbolicLink()) throw new QueueError('交付物不能是符号链接', 'VERIFICATION_EVIDENCE_REQUIRED');
  if (!fs.statSync(absolute).isFile()) throw new QueueError('交付物不是普通文件', 'VERIFICATION_EVIDENCE_REQUIRED');
  return absolute;
}

function assertRealPathInside(cwd, value) {
  const absolute = path.resolve(cwd, value);
  // 两层判断的唯一实现在 ./path-containment.mjs；这里只保留本队列的具体错误文案。
  if (!insideDirectory(cwd, absolute)) throw new QueueError('检查点路径超出本任务工作目录', 'PATH_ESCAPE');
  let existing = absolute;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  if (!insideReal(cwd, existing)) throw new QueueError('检查点路径通过链接越出工作目录', 'PATH_ESCAPE');
  return absolute;
}

/** a、b 是否同一路径段前缀（互为父子或相等）。 */
function covers(a, b) {
  if (a === b) return true;
  if (a === '.') return true;
  return b.startsWith(a + '/');
}

function scalar(value) {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function sameId(a, b) { return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(); }

function unknownVerificationEffects(value) {
  return value?.unknownSideEffects === true || value?.sideEffects === 'unknown' ||
    value?.desktopEvidence?.sideEffects === 'unknown' ||
    value?.calls?.some(call => call.unknownSideEffects === true || call.evidence?.sideEffects === 'unknown') ||
    value?.desktopEvidence?.calls?.some(call => call.unknownSideEffects === true || call.evidence?.sideEffects === 'unknown');
}

function normalizeWorker(input) {
  if (input && typeof input === 'object') {
    const id = input.id ?? input.worker ?? input.name;
    if (!id) throw new QueueError('worker 缺少 id', 'BAD_WORKER');
    return { id: String(id), strong: input.strong === true };
  }
  if (typeof input === 'string' && input.trim()) return { id: input.trim(), strong: false };
  throw new QueueError('worker 必须是非空字符串或 {id,strong}', 'BAD_WORKER');
}

function toSafeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

/**
 * SQLite 持久化拉取式小任务队列。
 *
 * new TaskQueue({store, runId, cwd, leaseMs = 120000, workers, now = Date.now, isProcessAlive, caseInsensitive})
 */
export class TaskQueue {
  constructor({ store, runId, cwd, leaseMs = 120000, workers, strongAgent, maxRetries = MAX_RETRIES, now = Date.now, isProcessAlive, canClaim, caseInsensitive, enforceTokenBudget = true, workerAvailable } = {}) {
    if (!store || !store.db) throw new QueueError('TaskQueue 需要传入含 db(DatabaseSync) 的 Store', 'BAD_STORE');
    const db = store.db;
    if (typeof db.prepare !== 'function' || typeof db.exec !== 'function') throw new QueueError('store.db 必须是 node:sqlite DatabaseSync 实例', 'BAD_STORE');

    this.store = store;
    this.db = db;
    this.runId = runId === undefined || runId === null || runId === '' ? 'default' : String(runId);
    this.leaseMs = Math.max(1, toSafeInt(leaseMs, 120000));
    this.maxRetries = Math.min(MAX_RETRIES, Math.max(0, toSafeInt(maxRetries, MAX_RETRIES)));
    this.timeFn = typeof now === 'function' ? now : () => now;
    this.isProcessAlive = typeof isProcessAlive === 'function' ? isProcessAlive : defaultIsProcessAlive;
    this.canClaim = typeof canClaim === 'function' ? canClaim : () => true;
    // 方案点名的 owner 优先接单：这里的判定决定"它不接时是否让别人顶上"。
    this.workerAvailable = typeof workerAvailable === 'function' ? workerAvailable : null;
    // false = token 只记账不刹车（旧任务行里遗留的预算也不再拦截领取）。
    this.enforceTokenBudget = enforceTokenBudget !== false;
    const rawCwd = (cwd === undefined || cwd === null || cwd === '') ? DEFAULT_CWD : String(cwd);
    this.cwd = path.resolve(rawCwd);
    this.caseInsensitive = caseInsensitive === undefined ? detectCaseInsensitive(this.cwd) : caseInsensitive === true;

    this.workers = new Set();
    this.strongWorkers = new Set();
    for (const w of (workers === undefined || workers === null ? [] : asArray(workers))) {
      const norm = normalizeWorker(w);
      this.workers.add(norm.id);
      if (norm.strong) this.strongWorkers.add(norm.id);
    }
    if (strongAgent && this.workers.has(strongAgent)) this.strongWorkers.add(strongAgent);

    const dir = store.file ? path.dirname(store.file) : null;
    if (dir) mkdirQuiet(dir);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`);
    } catch (e) {
      if (!e || !/locked|busy/i.test(String(e.message))) throw e;
    }
    this.#schema();
    try { this.#meta('cwd', this.cwd); } catch { /* 只读或占用时忽略 */ }
  }

  get currentPid() { return process.pid; }
  now() { return Number(this.timeFn()); }

  // ───────────────────────────── schema ─────────────────────────────

  #schema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tq_tasks (
        id TEXT NOT NULL,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'task',
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        difficulty TEXT NOT NULL DEFAULT 'normal',
        max_retries INTEGER NOT NULL DEFAULT 2,
        token_budget INTEGER NOT NULL DEFAULT 0,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        escalated INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_pid INTEGER,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        lease_stale INTEGER NOT NULL DEFAULT 0,
        side_effects_verified INTEGER NOT NULL DEFAULT 1,
        executor TEXT,
        reviewer TEXT,
        history TEXT NOT NULL DEFAULT '[]',
        result TEXT,
        usage TEXT,
        last_checkpoint TEXT,
        side_effects TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        quarantine_reason TEXT,
        cancelled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id, scope)
      );
      CREATE INDEX IF NOT EXISTS idx_tq_status ON tq_tasks(scope, status);
      CREATE TABLE IF NOT EXISTS tq_files (
        task_id TEXT NOT NULL, scope TEXT NOT NULL, path TEXT NOT NULL,
        PRIMARY KEY (task_id, scope, path)
      );
      CREATE TABLE IF NOT EXISTS tq_deps (
        task_id TEXT NOT NULL, scope TEXT NOT NULL, dep TEXT NOT NULL,
        PRIMARY KEY (task_id, scope, dep)
      );
      CREATE TABLE IF NOT EXISTS tq_payload (
        task_id TEXT NOT NULL, scope TEXT NOT NULL, field TEXT NOT NULL, value TEXT,
        PRIMARY KEY (task_id, scope, field)
      );
      CREATE TABLE IF NOT EXISTS tq_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, scope TEXT NOT NULL,
        attempt INTEGER NOT NULL, worker TEXT, role TEXT NOT NULL, outcome TEXT NOT NULL,
        issues TEXT, detail TEXT, lease_token TEXT, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tq_attempts ON tq_attempts(scope, task_id, id);
      CREATE TABLE IF NOT EXISTS tq_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, scope TEXT NOT NULL,
        attempt INTEGER NOT NULL, worker TEXT, path TEXT, summary TEXT,
        files_done TEXT NOT NULL DEFAULT '[]', data TEXT, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tq_checkpoints ON tq_checkpoints(scope, task_id, id);
      CREATE TABLE IF NOT EXISTS tq_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, task_id TEXT,
        type TEXT, text TEXT, data TEXT, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tq_usage (
        scope TEXT NOT NULL, task_id TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, task_id)
      );
      CREATE TABLE IF NOT EXISTS tq_meta (scope TEXT NOT NULL, k TEXT NOT NULL, v TEXT, PRIMARY KEY (scope, k));
    `);
    // 旧库补列：只做 ADD COLUMN，不动既有数据。
    const existing = new Set(this.db.prepare('PRAGMA table_info(tq_tasks)').all().map(c => c.name));
    for (const [name, type] of Object.entries({
      result: 'TEXT', usage: 'TEXT', last_checkpoint: 'TEXT', side_effects: 'TEXT',
      completed: 'INTEGER NOT NULL DEFAULT 0', lease_stale: 'INTEGER NOT NULL DEFAULT 0', executor_pid: 'INTEGER',
    })) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE tq_tasks ADD COLUMN ${name} ${type}`);
    }
  }

  // ───────────────────────────── 小工具 ─────────────────────────────

  tx(fn) {
    for (let i = 0; ; i++) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* 回滚失败也要抛原错 */ }
        if (i < 5 && e && /busy|locked/i.test(String(e.message))) { continue; }
        throw e;
      }
    }
  }

  #meta(key, value) {
    if (value === undefined) {
      const row = this.db.prepare('SELECT v FROM tq_meta WHERE scope=? AND k=?').get(this.runId, key);
      return row ? row.v : null;
    }
    this.db.prepare('INSERT INTO tq_meta (scope,k,v) VALUES (?,?,?) ON CONFLICT(scope,k) DO UPDATE SET v=excluded.v').run(this.runId, key, value === null ? null : scalar(value));
    return value;
  }

  #event(taskId, type, text, data = null) {
    this.db.prepare('INSERT INTO tq_events (scope,task_id,type,text,data,at) VALUES (?,?,?,?,?,?)')
      .run(this.runId, taskId ?? null, type, text ?? null, data === null ? null : JSON.stringify(data), iso(this.now()));
  }

  #attempt(taskId, { attempt = 0, worker = null, role = 'executor', outcome, issues = null, detail = null, leaseToken = null }) {
    this.db.prepare(`INSERT INTO tq_attempts (task_id,scope,attempt,worker,role,outcome,issues,detail,lease_token,at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(taskId, this.runId, attempt, worker, role, outcome,
        issues === null || issues === undefined ? null : JSON.stringify(issues),
        detail === null || detail === undefined ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
        leaseToken, iso(this.now()));
  }

  #attempts(taskId, limit = 50) {
    const rows = this.db.prepare('SELECT * FROM tq_attempts WHERE scope=? AND task_id=? ORDER BY id DESC LIMIT ?').all(this.runId, taskId, limit);
    return rows.map(r => ({ ...r, issues: parseJson(r.issues, null), detail: parseJson(r.detail, null) }));
  }

  #checkpoints(taskId, limit = 50) {
    const rows = this.db.prepare('SELECT * FROM tq_checkpoints WHERE scope=? AND task_id=? ORDER BY id DESC LIMIT ?').all(this.runId, taskId, limit);
    return rows.map(r => ({ attempt: r.attempt, worker: r.worker, path: r.path, summary: r.summary, filesDone: parseJson(r.files_done, []), data: parseJson(r.data, null), at: r.at }));
  }

  #rawTask(id) {
    return this.db.prepare('SELECT * FROM tq_tasks WHERE id=? AND scope=?').get(String(id), this.runId) || null;
  }

  #requireTask(id) {
    const row = this.#rawTask(id);
    if (!row) throw new QueueError(`找不到任务 ${id}`, 'NOT_FOUND', { taskId: id });
    return row;
  }

  /** 行 → 对外 task 对象。 */
  #taskView(row, { withLease = false, withHistory = false } = {}) {
    if (!row) return null;
    const payload = {};
    for (const r of this.db.prepare('SELECT field,value FROM tq_payload WHERE scope=? AND task_id=?').all(this.runId, row.id)) {
      payload[r.field] = parseJson(r.value, null);
    }
    const files = this.db.prepare('SELECT path FROM tq_files WHERE scope=? AND task_id=? ORDER BY path').all(this.runId, row.id).map(r => r.path);
    const dependsOn = this.db.prepare('SELECT dep FROM tq_deps WHERE scope=? AND task_id=? ORDER BY dep').all(this.runId, row.id).map(r => r.dep);
    const checkpoint = parseJson(row.last_checkpoint, null);
    const task = {
      id: row.id,
      scope: row.scope,
      title: row.title,
      detail: row.detail,
      type: row.kind,
      files,
      dependsOn,
      input: payload.input ?? null,
      output: payload.output ?? null,
      inputRefs: payload.inputRefs ?? [],
      outputRefs: payload.outputRefs ?? [],
      eligibleWorkers: payload.eligibleWorkers ?? null,
      // 方案点名（硬限制）还是路由算出的名单（可升级换人）：接单时用不同语义。
      // 老任务（本次升级前落盘）没有这个字段：有非空名单就按"点名"处理——宁可不升级，
      // 也不能让原生搭档去抢拓展坞的桌面活（R171 task-4 实测死锁）。
      planPinned: payload.planPinned === true || (payload.planPinned === undefined && Array.isArray(payload.eligibleWorkers) && payload.eligibleWorkers.length > 0),
      // 方案点名的执行方：接单时用它实现"指定者优先"（客户要求对应的模型做对应的模块）。
      owner: payload.owner ?? null,
      nativeBusyWorker: payload.nativeBusyWorker ?? null,
      expectedNativeId: payload.expectedNativeId ?? null,
      inputRefsInvalid: payload.inputRefsInvalid === true,
      supersededVerification: payload.supersededVerification ?? null,
      invalidatedDependencies: payload.invalidatedDependencies ?? [],
      repairScope: payload.repairScope ?? null,
      acceptance: payload.acceptance ?? [],
      checks: payload.checks ?? [],
      difficulty: row.difficulty,
      tokenBudget: Number(row.token_budget) || 0,
      tokensUsed: Number(row.tokens_used) || 0,
      maxRetries: Number(row.max_retries),
      status: row.status,
      state: row.status,
      attempts: Number(row.attempts),
      retries: Number(row.retries),
      escalated: row.escalated === 1,
      executor: row.executor ?? null,
      actualExecutor: row.executor ?? null,
      reviewer: row.reviewer ?? null,
      issues: payload.issues ?? [],
      result: parseJson(row.result, null),
      usage: parseJson(row.usage, null),
      sideEffects: row.side_effects ?? null,
      sideEffectsVerified: row.side_effects_verified === 1,
      completed: row.completed === 1,
      quarantineReason: row.quarantine_reason ?? null,
      scopeEvidence: payload.scopeEvidence ?? null,
      cancelled: row.cancelled === 1,
      stale: row.lease_stale === 1,
      checkpoint,
      checkpointPath: checkpoint?.path ?? null,
      completedItems: checkpoint?.filesDone ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lease: row.lease_token === null && row.lease_expires_at === null ? null : {
        owner: row.lease_owner ?? null,
        pid: row.lease_pid === null ? null : Number(row.lease_pid),
        executorPid: row.executor_pid == null ? null : Number(row.executor_pid),
        expiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
        expired: row.lease_expires_at !== null && Number(row.lease_expires_at) <= this.now(),
        stale: row.lease_stale === 1,
      },
      // 兼容别名
      max_retries: Number(row.max_retries),
      token_budget: Number(row.token_budget) || 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (withLease) task.leaseToken = row.lease_token ?? null;
    if (withHistory) task.history = this.#attempts(row.id);
    return task;
  }

  #payloadSet(taskId, field, value) {
    this.db.prepare('INSERT INTO tq_payload (task_id,scope,field,value) VALUES (?,?,?,?) ON CONFLICT(task_id,scope,field) DO UPDATE SET value=excluded.value')
      .run(taskId, this.runId, field, value === undefined || value === null ? null : JSON.stringify(value));
  }

  #touch(row, fields, extra = {}) {
    const columns = {};
    for (const [k, v] of Object.entries(fields)) columns[k] = scalar(v);
    if (extra && Object.keys(extra).length) Object.assign(columns, extra);
    const keys = Object.keys(columns);
    if (keys.length) {
      this.db.prepare(`UPDATE tq_tasks SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=? WHERE id=? AND scope=?`)
        .run(...keys.map(k => columns[k]), iso(this.now()), row.id, this.runId);
    } else {
      this.db.prepare('UPDATE tq_tasks SET updated_at=? WHERE id=? AND scope=?').run(iso(this.now()), row.id, this.runId);
    }
    return this.#taskView(this.#requireTask(row.id));
  }

  #historyPush(row, entry) {
    const history = parseJson(row.history, []) || [];
    history.push({ at: iso(this.now()), ...entry });
    return history.slice(-50);
  }

  #clearLease() {
    return { lease_token: null, lease_pid: null, lease_owner: null, lease_expires_at: null, lease_stale: 0 };
  }

  #issueList(issues) {    if (issues === undefined || issues === null || issues === '') return [];
    const list = asArray(issues).map(i => (typeof i === 'string' ? i : JSON.stringify(i))).map(s => String(s).trim()).filter(Boolean);
    if (!list.length) return [];
    return list;
  }

  #normalizeFiles(files) {
    const raw = asArray(files);
    if (!raw.length) return null; // null = 无 files（独占）
    const seen = new Set();
    for (const f of raw) {
      const value = typeof f === 'string' ? f : String(f);
      const declaredAbsolute = path.isAbsolute(value);
      // 显式声明的绝对路径可以在任务目录外（客户明确要求交付到那里）；相对路径越界仍然拒绝。
      const norm = declaredAbsolute ? normalizeArtifactPath(this.cwd, value, this.caseInsensitive) : normalizePath(this.cwd, value, this.caseInsensitive);
      if (norm === null) throw new QueueError(`路径越出 workspace：${JSON.stringify(f)}（cwd=${this.cwd}）`, 'PATH_ESCAPE', { file: f });
      if (!declaredAbsolute) assertRealPathInside(this.cwd, value);
      seen.add(norm);
    }
    return [...seen].sort();
  }

  /** 文件范围是否冲突：无 files 独占；否则大小写/父子/相等都算重叠。 */
  #filesConflict(a, b) {
    if (a === null || b === null) return true;
    // 公共文件范围保持原声明；仅锁 key 对通配做保守目录覆盖，并归一化真实路径别名。
    const lockKey = value => {
      if (value === '.') return '.';
      let absolute = path.resolve(value), wildcard = absolute.search(/[*?\[]/);
      if (wildcard >= 0) {
        const before = absolute.slice(0,wildcard), boundary = Math.max(before.lastIndexOf(path.sep),before.lastIndexOf('/'));
        absolute = absolute.slice(0,Math.max(boundary,path.parse(absolute).root.length));
      }
      let existing = absolute;
      while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing=path.dirname(existing);
      const canonical = path.resolve(fs.realpathSync(existing),path.relative(existing,absolute));
      const key = canonical.split(path.sep).join('/');
      return this.caseInsensitive ? key.toLowerCase() : key;
    };
    for (const x of a) {
      for (const y of b) { const left=lockKey(x),right=lockKey(y);if (covers(left,right) || covers(right,left)) return true; }
    }
    return false;
  }

  #runningScopes() {
    const rows = this.db.prepare("SELECT t.id,t.scope,m.v cwd FROM tq_tasks t LEFT JOIN tq_meta m ON m.scope=t.scope AND m.k='cwd' LEFT JOIN tq_payload p ON p.scope=t.scope AND p.task_id=t.id AND p.field='inputRefsInvalid' WHERE t.status='running' OR (t.status='verifying' AND COALESCE(p.value,'false')!='true') OR (t.status='blocked' AND (t.side_effects='unknown' OR t.quarantine_reason='unconfirmed-exit+unknown-side-effects') AND t.quarantine_reason!='file-lock-superseded')").all();
    const cwd = this.#canonicalCwd(this.cwd);
    return rows.filter(row => row.scope === this.runId || cwd && this.#canonicalCwd(row.cwd) === cwd).map(row => ({
      id: row.id, scope: row.scope,
      files: (() => {
        const files = this.db.prepare('SELECT path FROM tq_files WHERE scope=? AND task_id=?').all(row.scope, row.id);
        return files.length ? files.map(r => r.path) : null;
      })(),
    }));
  }

  #canonicalCwd(value) {
    try {
      const real = fs.realpathSync(path.resolve(value));
      return this.caseInsensitive ? real.toLowerCase() : real;
    } catch { return null; }
  }

  /** 显式继续/重新发起较新的同目标任务时，退役旧失败任务遗留的核验锁与"副作用未知"锁。 */
  releaseTerminalVerificationConflicts({ explicitResume = false, explicitStart = false, isRunActive } = {}) {
    if (explicitResume !== true && explicitStart !== true) return { released: [] };
    if (typeof isRunActive !== 'function') return { released: [] };
    return this.tx(() => {
      const current = this.db.prepare('SELECT * FROM runs WHERE id=?').get(this.runId);
      const cwd = this.#canonicalCwd(this.cwd);
      if (!current || current.kind !== 'parallel' || current.state !== 'running' || !cwd || this.#canonicalCwd(current.cwd) !== cwd) return { released: [] };
      const matching = this.db.prepare('SELECT * FROM runs WHERE goal=? AND kind=? ORDER BY n DESC').all(current.goal, current.kind)
        .filter(run => this.#canonicalCwd(run.cwd) === cwd);
      if (matching[0]?.id !== this.runId || !Number.isFinite(Date.parse(current.created_at))) return { released: [] };
      const currentTasks = this.db.prepare("SELECT * FROM tq_tasks WHERE scope=? AND cancelled=0 AND status IN ('queued','running','verifying')").all(this.runId)
        .map(row => ({ id: row.id, files: this.db.prepare('SELECT path FROM tq_files WHERE scope=? AND task_id=?').all(this.runId, row.id).map(file => file.path) }))
        .map(task => ({ ...task, files: task.files.length ? task.files : null }));
      const released = [];
      for (const previous of matching) {
        if (previous.id === this.runId || previous.state !== 'failed' || Number(previous.n) >= Number(current.n) ||
          !Number.isFinite(Date.parse(previous.created_at)) || Date.parse(previous.created_at) > Date.parse(current.created_at) || isRunActive(previous.id) !== false) continue;
        if (this.db.prepare("SELECT id FROM tq_tasks WHERE scope=? AND (status='running' OR lease_token IS NOT NULL OR lease_pid IS NOT NULL OR lease_expires_at IS NOT NULL) LIMIT 1").get(previous.id)) continue;
        const meta = this.db.prepare("SELECT v FROM tq_meta WHERE scope=? AND k='cwd'").get(previous.id);
        if (this.#canonicalCwd(meta?.v) !== cwd) continue;
        // 旧任务留下的两类锁：① 安全完成的核验锁；② "执行进程没确认退出、副作用未知"的隔离锁。
        // ② 以前完全不退役：同一个目标重新跑（客户最常见的重试方式）会被永久挡住（R152 实测：同目标同文件被 R91 挡住）。
        // 两类都只在"更新且同目标的这次任务要重写同一个文件"时退役，并且全程留痕。
        const rows = this.db.prepare("SELECT * FROM tq_tasks WHERE scope=? AND (status='verifying' OR (status='blocked' AND quarantine_reason='unconfirmed-exit+unknown-side-effects'))").all(previous.id);
        for (const row of rows) {
          const files = this.db.prepare('SELECT path FROM tq_files WHERE scope=? AND task_id=?').all(previous.id, row.id).map(file => file.path);
          const conflicts = currentTasks.filter(task => this.#filesConflict(task.files, files.length ? files : null)).map(task => task.id);
          if (!conflicts.length) continue;
          const unknownHold = row.status === 'blocked' && row.quarantine_reason === 'unconfirmed-exit+unknown-side-effects';
          try {
            if (row.executor_pid !== null && this.isProcessAlive(Number(row.executor_pid)) !== false) continue;
            if (!unknownHold) {
              this.#assertCompletedVerification(row);
              const report = parseJson(row.result, null);
              this.#assertVerificationReport(row, report);
              if (report.checks?.some(check => unknownVerificationEffects(check) || unknownVerificationEffects(check?.evidence))) continue;
            }
          } catch { continue; }
          const marker = { runId: this.runId, taskIds: conflicts, supersededAt: iso(this.now()), attempt: Number(row.attempts), kind: unknownHold ? 'unknown-side-effects' : 'verification' };
          const message = unknownHold
            ? `同目标的新任务 ${this.runId} 已接手同一个文件；旧任务"副作用未知"的隔离锁已退役，旧产出与费用保留，新任务会把文件重新写一遍并重新核验`
            : `同目标的新任务 ${this.runId} 已继续；已有产出、费用和历史保留，旧任务需读取最新文件重新核验`;
          const history = this.#historyPush(row, { event: unknownHold ? 'unknown-hold-superseded' : 'verification-superseded', ...marker });
          const changed = unknownHold
            ? this.db.prepare("UPDATE tq_tasks SET quarantine_reason='file-lock-superseded',history=?,updated_at=? WHERE scope=? AND id=? AND status='blocked' AND quarantine_reason='unconfirmed-exit+unknown-side-effects'").run(JSON.stringify(history), iso(this.now()), previous.id, row.id)
            : this.db.prepare("UPDATE tq_tasks SET status='blocked',quarantine_reason='superseded-verification',history=?,updated_at=? WHERE scope=? AND id=? AND status='verifying' AND attempts=? AND completed=1 AND side_effects_verified=1 AND lease_token IS NULL AND lease_pid IS NULL AND lease_expires_at IS NULL")
              .run(JSON.stringify(history), iso(this.now()), previous.id, row.id, Number(row.attempts));
          if (!changed.changes) continue;
          for (const [field, value] of Object.entries({ inputRefsInvalid: true, supersededVerification: marker, issues: [message] })) {
            this.db.prepare('INSERT INTO tq_payload (task_id,scope,field,value) VALUES (?,?,?,?) ON CONFLICT(task_id,scope,field) DO UPDATE SET value=excluded.value')
              .run(row.id, previous.id, field, JSON.stringify(value));
          }
          this.db.prepare('INSERT INTO tq_events (scope,task_id,type,text,data,at) VALUES (?,?,?,?,?,?)')
            .run(previous.id, row.id, unknownHold ? 'unknown-hold-superseded' : 'verification-superseded', message, JSON.stringify(marker), iso(this.now()));
          this.#event(null, unknownHold ? 'file-lock-released' : 'verification-conflict-released', message, { previousRunId: previous.id, taskId: row.id, ...marker });
          released.push({ runId: previous.id, taskId: row.id, currentTaskIds: conflicts, ...(unknownHold ? { kind: 'unknown-side-effects' } : {}) });
        }
      }
      return { released };
    });
  }

  #assertSupersededWriterAbsent(row, marker, isRunActive) {
    const newer = this.db.prepare('SELECT * FROM runs WHERE id=?').get(marker.runId);
    if (typeof isRunActive !== 'function' || isRunActive(marker.runId) !== false || !newer || !['passed', 'done', 'failed', 'error'].includes(newer.state)) {
      throw new QueueError('较新的任务仍可能修改产物，请等它结束后重新核验', 'VERIFICATION_WRITER_ACTIVE');
    }
    const task = this.#taskView(row);
    if (this.#runningScopes().some(other => (other.scope !== this.runId || other.id !== row.id) && this.#filesConflict(task.files.length ? task.files : null, other.files))) {
      throw new QueueError('当前产物仍由其他任务使用，请等待后再核验', 'VERIFICATION_WRITER_ACTIVE');
    }
  }

  /** 旧任务恢复只重验最新文件，不能将旧评估直接批准或重新执行。 */
  restoreSupersededVerification(id, { attempt, isRunActive } = {}) {
    return this.tx(() => {
      const row = this.#requireTask(id);
      this.#assertVerificationAttempt(row, attempt);
      if (row.status !== 'verifying' && (row.status !== 'blocked' || row.quarantine_reason !== 'superseded-verification')) throw new QueueError('此任务没有被较新任务取代的待验收产物', 'BAD_STATE');
      this.#assertCompletedVerification(row);
      if (row.executor_pid !== null && this.isProcessAlive(Number(row.executor_pid)) !== false) throw new QueueError('上次执行进程尚未确认退出', 'VERIFICATION_UNSAFE');
      this.#assertVerificationReport(row, parseJson(row.result, null));
      const marker = parseJson(this.db.prepare("SELECT value FROM tq_payload WHERE scope=? AND task_id=? AND field='supersededVerification'").get(this.runId, row.id)?.value, null);
      if (!marker || marker.attempt !== attempt) throw new QueueError('缺少同轮次的历史核验交接证据', 'VERIFICATION_EVIDENCE_REQUIRED');
      this.#assertSupersededWriterAbsent(row, marker, isRunActive);
      this.supersededRunActive = isRunActive;
      marker.restoredAt = iso(this.now());
      const history = this.#historyPush(row, { event: 'superseded-verification-restored', attempt, newerRunId: marker.runId });
      this.db.prepare("UPDATE tq_tasks SET status='verifying',quarantine_reason=NULL,history=?,updated_at=? WHERE scope=? AND id=?")
        .run(JSON.stringify(history), iso(this.now()), this.runId, row.id);
      this.#payloadSet(row.id, 'supersededVerification', marker);
      this.#payloadSet(row.id, 'inputRefsInvalid', true);
      this.#event(row.id, 'superseded-verification-restored', '保留原成果与执行历史，读取当前文件并重新核验；旧评估不能直接通过', { newerRunId: marker.runId, attempt });
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  #assertSupersededVerificationFresh(row, report) {
    const marker = this.#taskView(row).supersededVerification;
    if (!marker) return;
    this.#assertSupersededWriterAbsent(row, marker, this.supersededRunActive);
    if (!marker.restoredAt || !Number.isFinite(Date.parse(report?.artifactVerifiedAt)) || Date.parse(report.artifactVerifiedAt) < Date.parse(marker.restoredAt)) {
      throw new QueueError('旧评估已过期，请对最新文件完成一次独立核验', 'VERIFICATION_EVIDENCE_REQUIRED');
    }
    this.#assertVerificationReport(row, report);
    const artifacts = report.artifacts.map(item => typeof item === 'string' ? item : item?.path);
    const hashes = report.artifactHashes;
    if (!Array.isArray(hashes) || hashes.length !== artifacts.length || new Set(hashes.map(item => normalizeArtifactPath(this.cwd, item?.path, this.caseInsensitive))).size !== hashes.length) {
      throw new QueueError('缺少当前所有产物的真实文件校验记录', 'VERIFICATION_EVIDENCE_REQUIRED');
    }
    for (const artifact of artifacts) {
      const normalized = normalizeArtifactPath(this.cwd, artifact, this.caseInsensitive);
      const evidence = hashes.find(item => normalizeArtifactPath(this.cwd, item?.path, this.caseInsensitive) === normalized);
      try {
        const file = artifactFile(this.cwd, artifact);
        if (!evidence || !/^[a-f0-9]{64}$/i.test(evidence.sha256) || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== evidence.sha256.toLowerCase()) throw new Error('changed');
      } catch { throw new QueueError('产物已发生变化或无法读取，请读取当前文件重新核验', 'VERIFICATION_EVIDENCE_REQUIRED'); }
    }
  }

  #hasStrongWorker() {
    // 只有显式声明 strong 的 worker 才算升级通道；否则重试耗尽直接 blocked，不无限返工。
    return this.strongWorkers.size > 0;
  }

  #runTokensUsed() {
    const row = this.db.prepare('SELECT COALESCE(SUM(tokens),0) AS t FROM tq_usage WHERE scope=?').get(this.runId);
    return Number(row?.t ?? 0) || 0;
  }

  #budgetExhausted(task) {
    if (!this.enforceTokenBudget) return false;
    if (task.tokenBudget > 0 && task.tokensUsed >= task.tokenBudget) return true;
    const cap = toSafeInt(this.#meta('tokenBudgetCap'), 0);
    return cap > 0 && this.#runTokensUsed() >= cap;
  }

  #statusCounts() {
    const map = {};
    for (const s of STATUS) map[s] = 0;
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM tq_tasks WHERE scope=? GROUP BY status').all(this.runId)) {
      map[String(r.status)] = Number(r.n);
    }
    return map;
  }

  // ───────────────────────────── 入队 ─────────────────────────────

  /**
   * 批量入队。全部校验通过才写入；重复 id / 缺依赖 / 依赖环 / 越界路径 → 抛错（fail closed）。
   * @returns {string[]} 新入队或已存在的 id（按传入顺序）
   */
  enqueue(tasks) {
    const list = asArray(tasks);
    if (!list.length) throw new QueueError('enqueue 需要至少一个任务', 'EMPTY_ENQUEUE');

    const specs = list.map((spec) => {
      if (!spec || typeof spec !== 'object') throw new QueueError('任务必须是对象', 'BAD_TASK');
      const id = String(spec.id ?? '').trim();
      if (!id) throw new QueueError('任务缺少 id', 'BAD_TASK');
      if (!spec.title || !String(spec.title).trim()) throw new QueueError(`任务 ${id} 缺少 title`, 'BAD_TASK');
      const maxRetries = toSafeInt(spec.maxRetries, this.maxRetries);
      if (maxRetries < 0 || maxRetries > MAX_RETRIES) throw new QueueError(`任务 ${id} 的 maxRetries 必须在 0..${MAX_RETRIES}`, 'BAD_RETRIES');
      const tokenBudget = toSafeInt(spec.tokenBudget, 0);
      if (tokenBudget < 0) throw new QueueError(`任务 ${id} 的 tokenBudget 不能为负`, 'BAD_BUDGET');
      const rawDifficulty = String(spec.difficulty ?? spec.taskDifficulty ?? 'normal').toLowerCase();
      const difficulty = ({ simple: 'easy', low: 'easy', complex: 'hard', high: 'hard', difficult: 'hard', medium: 'normal' })[rawDifficulty] || rawDifficulty;
      if (!(difficulty in DIFF_RANK)) throw new QueueError(`任务 ${id} 的 difficulty 必须是 easy/normal/hard`, 'BAD_DIFFICULTY');
      const files = this.#normalizeFiles(spec.files);
      const dependsOn = [...new Set(asArray(spec.dependsOn).map(d => String(d).trim()).filter(Boolean))];
      return {
        id,
        title: String(spec.title),
        detail: spec.detail === undefined || spec.detail === null ? '' : String(spec.detail),
        type: spec.type === undefined || spec.type === null ? 'task' : String(spec.type),
        files,
        dependsOn,
        input: spec.input ?? null,
        output: spec.output ?? null,
        inputRefs: asArray(spec.inputRefs), outputRefs: asArray(spec.outputRefs),
        eligibleWorkers: spec.eligibleWorkers === undefined || spec.eligibleWorkers === null ? null : [...new Set(asArray(spec.eligibleWorkers).map(w => normalizeWorker(w).id))],
        // 方案点名（硬限制）还是路由算出来的名单：接单时的升级语义不同，必须一起落盘。
        planPinned: spec.planPinned === true,
        // 方案点名的 owner（'codex'/'deepseek'/'dock:…'，空 = 不指定）：接单时"指定者优先"要用它。
        owner: spec.owner === undefined || spec.owner === null || !String(spec.owner).trim() ? null : String(spec.owner).toLowerCase(),
        acceptance: asArray(spec.acceptance),
        checks: asArray(spec.checks),
        difficulty,
        tokenBudget,
        maxRetries: Math.min(maxRetries, this.maxRetries),
      };
    });

    // 重复 id：同批重复或库中已存在（已存在视为幂等，不重复插入）。
    const seen = new Set();
    for (const s of specs) {
      const key = s.id.toLowerCase();
      if (seen.has(key)) throw new QueueError(`重复任务 id：${s.id}`, 'DUPLICATE_ID', { taskId: s.id });
      seen.add(key);
    }

    const known = new Set(specs.map(s => s.id.toLowerCase()));
    for (const row of this.db.prepare('SELECT id FROM tq_tasks WHERE scope=?').all(this.runId)) known.add(String(row.id).toLowerCase());

    for (const s of specs) {
      for (const dep of s.dependsOn) {
        if (!known.has(dep.toLowerCase())) throw new QueueError(`任务 ${s.id} 依赖不存在的任务 ${dep}`, 'MISSING_DEP', { taskId: s.id, dep });
      }
    }

    // 依赖环检测（含库中已有任务）：fail closed。
    const graph = new Map();
    for (const row of this.db.prepare('SELECT id FROM tq_tasks WHERE scope=?').all(this.runId)) graph.set(String(row.id).toLowerCase(), []);
    for (const row of this.db.prepare('SELECT task_id,dep FROM tq_deps WHERE scope=?').all(this.runId)) {
      const k = String(row.task_id).toLowerCase();
      if (!graph.has(k)) graph.set(k, []);
      graph.get(k).push(String(row.dep).toLowerCase());
    }
    for (const s of specs) graph.set(s.id.toLowerCase(), s.dependsOn.map(d => d.toLowerCase()));
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    const stack = [];
    const visit = (node) => {
      const c = color.get(node) ?? WHITE;
      if (c === GRAY) throw new QueueError(`依赖成环：${[...stack, node].join(' → ')}`, 'DEP_CYCLE', { taskId: node });
      if (c === BLACK) return;
      color.set(node, GRAY);
      stack.push(node);
      for (const next of graph.get(node) || []) visit(next);
      stack.pop();
      color.set(node, BLACK);
    };
    for (const key of graph.keys()) visit(key);

    const inserted = [];
    this.tx(() => {
      for (const s of specs) {
        if (this.#rawTask(s.id)) { inserted.push(s.id); continue; }
        const at = iso(this.now());
        this.db.prepare(`INSERT INTO tq_tasks
          (id,scope,kind,title,detail,status,difficulty,max_retries,token_budget,created_at,updated_at,side_effects_verified)
          VALUES (?,?,?,?,?,'queued',?,?,?,?,?,1)`)
          .run(s.id, this.runId, s.type, s.title, s.detail, s.difficulty, s.maxRetries, s.tokenBudget, at, at);
        for (const p of s.files ?? []) this.db.prepare('INSERT OR IGNORE INTO tq_files (task_id,scope,path) VALUES (?,?,?)').run(s.id, this.runId, p);
        for (const dep of s.dependsOn) this.db.prepare('INSERT OR IGNORE INTO tq_deps (task_id,scope,dep) VALUES (?,?,?)').run(s.id, this.runId, dep);
        for (const [field, value] of [['input', s.input], ['output', s.output], ['inputRefs', s.inputRefs], ['outputRefs', s.outputRefs], ['eligibleWorkers', s.eligibleWorkers], ['owner', s.owner], ['planPinned', s.planPinned], ['acceptance', s.acceptance], ['checks', s.checks], ['issues', []]]) {
          this.#payloadSet(s.id, field, value);
        }
        if (s.eligibleWorkers !== null && (!s.eligibleWorkers.length || this.workers.size && !s.eligibleWorkers.some(w => this.workers.has(w)))) {
          this.db.prepare("UPDATE tq_tasks SET status='blocked',quarantine_reason='no-eligible-worker' WHERE id=? AND scope=?").run(s.id, this.runId);
          this.#payloadSet(s.id, 'issues', ['本任务指定的搭档当前不可用，未静默换人执行']);
        }
        this.#attempt(s.id, { outcome: 'enqueued', role: 'queue' });
        this.#event(s.id, 'enqueued', `任务入队：${s.title}`, { type: s.type, difficulty: s.difficulty, files: s.files });
        inserted.push(s.id);
      }
    });
    return inserted;
  }

  // ───────────────────────────── 查询 ─────────────────────────────

  list({ status, ready, limit = 10000 } = {}) {
    const rows = this.db.prepare('SELECT * FROM tq_tasks WHERE scope=? ORDER BY created_at, id').all(this.runId);
    const running = this.#runningScopes();
    const items = [];
    for (const row of rows) {
      const task = this.#taskView(row);
      if (status && (Array.isArray(status) ? !status.includes(task.status) : task.status !== status)) continue;
      const unmet = task.dependsOn.filter(dep => (this.#rawTask(dep)?.status ?? 'missing') !== 'passed');
      task.unmetDependencies = unmet;
      task.ready = task.status === 'queued' && unmet.length === 0 && !task.cancelled
        && !this.#budgetExhausted(task)
        && !running.some(r => (r.id !== task.id || r.scope !== this.runId) && this.#filesConflict(task.files, r.files));
      if (ready !== undefined && task.ready !== ready) continue;
      items.push(task);
      if (items.length >= limit) break;
    }
    return items;
  }

  get(id, { withHistory = false } = {}) {
    return this.#taskView(this.#requireTask(id), { withHistory });
  }

  // ───────────────────────────── 领取 ─────────────────────────────

  /**
   * 原子领取一个可执行任务。多实例互斥；返回 task（含 leaseToken），无可用任务返回 null。
   * taskIds：调用方（queue-runner）先行过滤出的候选名单，必须被尊重——
   * 名单之外的任务即使 escalated 排在前面也不能领走，否则“原生会话忙 60 秒退避”、
   * 逐 worker 路由等上游过滤会被绕过，同 worker 的其他就绪任务被饿住。
   * @returns {object|null}
   */
  claim(worker, { pid = process.pid, taskIds } = {}) {
    const w = normalizeWorker(worker);
    const at = this.now();
    const allowed = Array.isArray(taskIds) ? new Set(taskIds.map(String)) : null;
    return this.tx(() => {
      if (this.db.prepare("SELECT id FROM tq_tasks WHERE scope=? AND status='running' AND lease_owner=?").get(this.runId, w.id)) return null;
      const rows = this.db.prepare(
        "SELECT * FROM tq_tasks WHERE scope=? AND status='queued' AND cancelled=0 AND escalated<=1 ORDER BY escalated DESC, id"
      ).all(this.runId).filter(row => !allowed || allowed.has(row.id));

      const running = this.#runningScopes();
      for (const row of rows) {
        const task = this.#taskView(row);
        if (task.nativeBusyWorker && !sameId(task.nativeBusyWorker, w.id)) continue;
        // 方案点名了执行搭档就守住：升级（escalated）也不能把点名绕过去，
        // 否则"必须由拓展坞执行的桌面活"会被原生搭档抢走并必然失败（R171 task-4 实测）；
        // 路由算出的名单则不硬守，升级就该换强搭档（老测试守的行为）。
        const pinnedWorkers = task.planPinned === true && Array.isArray(task.eligibleWorkers) && task.eligibleWorkers.length > 0;
        if (pinnedWorkers && !task.eligibleWorkers.includes(w.id)) continue;
        if (!pinnedWorkers && !task.escalated && task.eligibleWorkers !== null && task.eligibleWorkers !== undefined && !task.eligibleWorkers.includes(w.id)) continue;
        if (this.canClaim(w.id, task) !== true) continue;

        // 依赖：只有 passed 才释放。
        const deps = this.db.prepare('SELECT dep FROM tq_deps WHERE scope=? AND task_id=?').all(this.runId, row.id).map(r => r.dep);
        if (deps.some(dep => (this.#rawTask(dep)?.status ?? 'missing') !== 'passed')) continue;

        // 升级任务只交给 strong worker（避免普通 worker 反复撞同一堵墙）。
        // 但"方案点名了执行搭档"的任务例外：门槛已经由 eligibleWorkers 定了，
        // 再要求 strong 会出现死锁——R171 task-4 实测：escalated=1 + 只能由 dock 执行，
        // 强搭档（codex/deepseek）没资格、dock 又不算 strong ⇒ 谁都领不走，续跑也救不回来。
        const pinned = task.planPinned === true && Array.isArray(task.eligibleWorkers) && task.eligibleWorkers.length > 0;
        if (task.escalated && !pinned && this.#hasStrongWorker() && !this.strongWorkers.has(w.id)) continue;
        // 预算止损。
        if (this.#budgetExhausted(task)) {
          this.#event(row.id, 'token-brake', `token 预算用尽（${task.tokensUsed}/${task.tokenBudget || this.#meta('tokenBudgetCap') || '-'}），停止领取`);
          continue;
        }

        // 方案点名的 owner 优先：分工里写着谁做，就让谁先做（客户要求"对应的模型完成对应的模块"）。
        // 只有它本人有资格接单、且当前可用时才等它；否则（未参与/掉线/被文件锁挡住）允许别人顶上，事件留痕。
        const designated = task.owner ? String(task.owner).toLowerCase() : '';
        if (designated && designated !== w.id && !task.escalated) {
          const ownerEligible = (task.eligibleWorkers === null || task.eligibleWorkers === undefined || task.eligibleWorkers.includes(designated))
            && this.canClaim(designated, task) === true;
          const ownerAvailable = ownerEligible && (this.workerAvailable ? this.workerAvailable(designated) : true);
          if (ownerAvailable) {
            this.#event(row.id, 'owner-waiting', `方案指定 ${designated} 执行本任务，先等它接单（${w.id} 不抢）`);
            continue;
          }
        }

        // 文件范围互斥：命中要留痕，不能静默跳过（否则客户只看到"等待执行"）。
        if (running.some(r => this.#filesConflict(task.files, r.files))) {
          const holders = running.filter(r => this.#filesConflict(task.files, r.files)).map(r => `${r.scope}/${r.id}`);
          this.#event(row.id, 'file-conflict', `文件范围与正在占用它的任务重叠（${holders.join('、')}），先等它结束`, { holders });
          continue;
        }

        const token = randomUUID();
        const expiresAt = at + this.leaseMs;
        const attempt = Number(row.attempts) + 1;
        const history = this.#historyPush(row, { event: 'claim', worker: w.id, attempt, pid, token });
        this.db.prepare(`UPDATE tq_tasks SET status='running', lease_token=?, lease_pid=?, lease_owner=?, lease_expires_at=?,
            lease_stale=0, executor_pid=NULL, attempts=?, side_effects_verified=0, completed=0, side_effects=NULL, executor=?, updated_at=?, history=? WHERE id=? AND scope=?`)
          .run(token, scalar(pid), w.id, expiresAt, attempt, w.id, iso(at), JSON.stringify(history), row.id, this.runId);
        const claimedAt = iso(at);
        this.#attempt(row.id, { attempt, worker: w.id, outcome: 'claimed', detail: { pid }, leaseToken: token });
        this.#event(row.id, 'claimed', `${w.id} 领取任务（第 ${attempt} 次执行）`, { pid, token, expiresAt: claimedAt });
        return this.#taskView(this.#requireTask(row.id), { withLease: true });
      }
      return null;
    });
  }

  // ─────────────────── 执行者写操作（全部 fence） ───────────────────

  /** Trusted admission rejection only: no provider/tool dispatch, no retry spent. */
  defer(id,token,{notDispatched=false,reason='等待其他调用释放预留额度'}={}) {
    return this.tx(()=>{
      const row=this.#requireTask(id);this.#assertLease(row,token);
      if(notDispatched!==true||row.executor_pid!==null)throw new QueueError('已启动执行的任务不能退回为未派发','DISPATCH_UNCERTAIN');
      const history=this.#historyPush(row,{event:'admission-deferred',worker:row.lease_owner,attempt:Number(row.attempts),reason});
      this.#attempt(row.id,{attempt:Number(row.attempts),worker:row.lease_owner,outcome:'not-dispatched',detail:{reason},leaseToken:token});
      this.db.prepare(`UPDATE tq_tasks SET status='queued',attempts=MAX(0,attempts-1),executor=NULL,executor_pid=NULL,
        lease_token=NULL,lease_pid=NULL,lease_owner=NULL,lease_expires_at=NULL,lease_stale=0,
        side_effects='none',side_effects_verified=1,history=?,updated_at=? WHERE id=? AND scope=?`)
        .run(JSON.stringify(history),iso(this.now()),row.id,this.runId);
      this.#event(row.id,'admission-deferred',reason);return this.#taskView(this.#requireTask(row.id));
    });
  }

  /** 原生RPC明确拒绝启动本轮且进程已退出：只等待会话释放，不消耗执行或返工次数。 */
  deferNativeBusy(id, token, { notDispatched = false, nativeBusyEvidence, reason = '原生会话正在被其他进程使用，等待释放后继续' } = {}) {
    return this.tx(() => {
      const row = this.#requireTask(id);
      this.#assertLease(row, token);
      const proof = nativeBusyEvidence;
      if (notDispatched !== true || proof?.rpcMethod !== 'thread/resume' || proof.rpcCode !== -32600 || proof.turnStarted !== false ||
        typeof proof.nativeId !== 'string' || !proof.nativeId.trim() || typeof proof.message !== 'string' || !proof.message.includes(proof.nativeId) || !/already has an active writer|already owned by an active write handle/i.test(proof.message)) {
        throw new QueueError('缺少原生RPC明确拒绝启动本轮的证据，不能按等待恢复', 'DISPATCH_UNCERTAIN');
      }
      const expected = this.#taskView(row).expectedNativeId;
      if (expected && expected !== proof.nativeId) throw new QueueError('原生会话与上次等待记录不一致，不能静默换会话恢复', 'DISPATCH_UNCERTAIN');
      this.#assertExecutorExited(row, { requirePid: true });
      const claim = this.db.prepare("SELECT * FROM tq_attempts WHERE scope=? AND task_id=? AND attempt=? AND outcome='claimed' AND lease_token=? ORDER BY id DESC LIMIT 1")
        .get(this.runId, row.id, Number(row.attempts), token);
      const claimEvent = this.db.prepare("SELECT id,data FROM tq_events WHERE scope=? AND task_id=? AND type='claimed' ORDER BY id DESC LIMIT 1").get(this.runId, row.id);
      if (!claim || row.completed !== 0 || row.side_effects !== null && row.side_effects !== 'none' ||
        !claimEvent || parseJson(claimEvent.data, null)?.token !== token || this.db.prepare("SELECT id FROM tq_events WHERE scope=? AND task_id=? AND id>? AND type='scope-evidence' LIMIT 1").get(this.runId, row.id, claimEvent.id) ||
        this.db.prepare('SELECT id FROM tq_attempts WHERE scope=? AND task_id=? AND id>? LIMIT 1').get(this.runId, row.id, claim.id) ||
        this.db.prepare('SELECT id FROM tq_checkpoints WHERE scope=? AND task_id=? AND attempt=? LIMIT 1').get(this.runId, row.id, Number(row.attempts)) ||
        parseJson(row.last_checkpoint, null)?.attempt === Number(row.attempts)) {
        throw new QueueError('本轮已有完成、动作或检查点证据，不能退回为未启动', 'DISPATCH_UNCERTAIN');
      }
      const history = this.#historyPush(row, { event: 'native-busy-deferred', worker: row.lease_owner, attempt: Number(row.attempts), nativeBusyEvidence: proof });
      this.#attempt(row.id, { attempt: Number(row.attempts), worker: row.lease_owner, outcome: 'not-dispatched', detail: { reason, source: 'native-rpc-rejection', nativeBusyEvidence: proof }, leaseToken: token });
      this.db.prepare(`UPDATE tq_tasks SET status='queued',attempts=MAX(0,attempts-1),executor=NULL,executor_pid=NULL,
        lease_token=NULL,lease_pid=NULL,lease_owner=NULL,lease_expires_at=NULL,lease_stale=0,
        side_effects='none',side_effects_verified=1,history=?,updated_at=? WHERE id=? AND scope=?`)
        .run(JSON.stringify(history), iso(this.now()), row.id, this.runId);
      this.#payloadSet(row.id, 'nativeBusyWorker', row.lease_owner);
      this.#payloadSet(row.id, 'expectedNativeId', proof.nativeId);
      this.#event(row.id, 'native-busy-deferred', reason, { nativeBusyEvidence: proof, notDispatched: true });
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  /**
   * 心跳续租。必须持有有效 token 且租约未过期，否则 LeaseLostError。
   * checkpoint 传入时等价于 checkpoint()。
   */
  heartbeat(id, token, checkpoint) { return this.tx(() => this.#heartbeat(id, token, checkpoint)); }
  #heartbeat(id, token, checkpoint) {
    const row = this.#requireTask(id);
    this.#assertLease(row, token);
    const at = this.now();
    this.db.prepare('UPDATE tq_tasks SET lease_expires_at=?, updated_at=? WHERE id=? AND scope=?')
      .run(at + this.leaseMs, iso(at), row.id, this.runId);
    if (checkpoint?.executorPid !== undefined) {
      if (!Number.isInteger(checkpoint.executorPid) || checkpoint.executorPid < 1) throw new QueueError('执行进程 PID 无效', 'BAD_PID');
      this.db.prepare('UPDATE tq_tasks SET executor_pid=? WHERE id=? AND scope=?').run(checkpoint.executorPid, row.id, this.runId);
    }
    if (checkpoint !== undefined && checkpoint !== null && Object.keys(checkpoint).some(k => k !== 'executorPid')) return this.#checkpoint(id, token, checkpoint);
    this.#event(row.id, 'heartbeat', `${row.lease_owner} 心跳`, { expiresAt: iso(at + this.leaseMs) });
    return this.#taskView(this.#requireTask(row.id));
  }

  /** 持久化检查点：路径 + 摘要 + 已完成项；下一执行者据此只续未完成项。 */
  checkpoint(id, token, data = {}) { return this.tx(() => this.#checkpoint(id, token, data)); }
  #checkpoint(id, token, data = {}) {
    const row = this.#requireTask(id);
    this.#assertLease(row, token);
    const at = this.now();
    const filesDone = asArray(data.filesDone ?? data.completed ?? data.completedItems ?? data.done ?? []);
    if (data.path != null) assertRealPathInside(this.cwd, data.path);
    // 检查点里列出的交付物可能在任务目录外（客户明确要求的位置）；只记录，存在性与哈希在验收阶段核对。
    const checkpoint = {
      path: data.path === undefined || data.path === null ? null : String(data.path),
      summary: data.summary === undefined || data.summary === null ? '' : String(data.summary),
      filesDone: filesDone.map(f => String(f)),
      data: data.data ?? { next: asArray(data.next), artifacts: asArray(data.artifacts) },
      next: asArray(data.next), artifacts: asArray(data.artifacts),
      at: iso(at),
      attempt: Number(row.attempts),
      worker: row.lease_owner ?? null,
    };
    this.db.prepare(`INSERT INTO tq_checkpoints (task_id,scope,attempt,worker,path,summary,files_done,data,at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(row.id, this.runId, checkpoint.attempt, checkpoint.worker, checkpoint.path, checkpoint.summary,
        JSON.stringify(checkpoint.filesDone), JSON.stringify(checkpoint.data), checkpoint.at);
    const history = this.#historyPush(row, { event: 'checkpoint', worker: checkpoint.worker, path: checkpoint.path, summary: checkpoint.summary });
    // sideEffects 可由适配器显式声明：'none' 时死 pid 回收可安全重领；缺省视为未知。
    const sideEffects = data.sideEffects === undefined || data.sideEffects === null ? row.side_effects : String(data.sideEffects);
    this.db.prepare('UPDATE tq_tasks SET lease_expires_at=?, last_checkpoint=?, history=?, side_effects=?, updated_at=? WHERE id=? AND scope=?')
      .run(at + this.leaseMs, JSON.stringify(checkpoint), JSON.stringify(history), sideEffects, iso(at), row.id, this.runId);
    this.#event(row.id, 'checkpoint', checkpoint.summary || `检查点 @ ${checkpoint.path ?? '-'}`, { path: checkpoint.path, filesDone: checkpoint.filesDone });
    return this.#taskView(this.#requireTask(row.id));
  }

  /** 执行完成 → verifying（等非执行者审核）。 */
  complete(id, token, result = null) { return this.tx(() => this.#complete(id, token, result)); }
  #complete(id, token, result = null) {
    const row = this.#requireTask(id);
    this.#assertLease(row, token);
    const attempt = Number(row.attempts);
    const history = this.#historyPush(row, { event: 'complete', worker: row.lease_owner, attempt });
    this.db.prepare(`UPDATE tq_tasks SET status='verifying', side_effects_verified=1, completed=1, side_effects=COALESCE(side_effects,'none'), result=?, history=?, updated_at=? WHERE id=? AND scope=?`)
      .run(result === null || result === undefined ? null : JSON.stringify(result), JSON.stringify(history), iso(this.now()), row.id, this.runId);
    this.db.prepare('UPDATE tq_tasks SET lease_token=NULL, lease_pid=NULL, lease_expires_at=NULL, lease_stale=0 WHERE id=? AND scope=?')
      .run(row.id, this.runId);
    this.#attempt(row.id, { attempt, worker: row.lease_owner, outcome: 'completed', detail: { result: result ?? null }, leaseToken: token });
    this.#event(row.id, 'completed', `${row.lease_owner} 执行完成，等待验证`, { attempt });
    this.#payloadSet(row.id, 'nativeBusyWorker', null);
    this.#payloadSet(row.id, 'expectedNativeId', null);
    return this.#taskView(this.#requireTask(row.id));
  }

  /** 重试用尽但仍留在 queued 的任务：谁都领不走（领单闸门要求 retries < maxRetries）。
   *  这是恢复路径必须能救活的状态；重置重试次数让它重新可领取，并留痕。 */
  resetRetries(id, { worker = 'controller', note = '' } = {}) {
    return this.tx(() => {
      const row = this.#requireTask(id);
      if (row.status !== 'queued' || Number(row.retries) < Number(row.max_retries)) throw new QueueError(`任务 ${id} 不需要重置重试（status=${row.status}，retries=${row.retries}/${row.max_retries}）`, 'NOT_EXHAUSTED', { taskId: id });
      const history = this.#historyPush(row, { event: 'reset-retries', worker, previousRetries: Number(row.retries), note });
      this.db.prepare("UPDATE tq_tasks SET retries=0, history=?, updated_at=? WHERE id=? AND scope=?")
        .run(JSON.stringify(history), iso(this.now()), row.id, this.runId);
      this.#event(row.id, 'retries-reset', `${worker} 重置重试计数（原 ${row.retries}/${row.max_retries}）：任务重新可领取${note ? '；' + note : ''}`);
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  /** 人工解除隔离：把 blocked（含 unconfirmed-exit+unknown-side-effects 隔离）重新放回队列。
   *  客户在看板上确认"这些改动我认了"之后走这里，不需要手工改库。放行即留痕（谁在什么时候解的、原原因）。 */
  release(id, { worker = 'customer', note = '' } = {}) {
    return this.tx(() => {
      const row = this.#requireTask(id);
      // blocked（含隔离）需要人工解封；此外还有一种死结：retries 用尽但仍留在 queued，
      // 谁都领不走（R171 task-4 实测）。客户显式放行时，这两种都应该能重新排队。
      const exhaustedQueued = row.status === 'queued' && Number(row.retries) >= Number(row.max_retries);
      if (row.status !== 'blocked' && !exhaustedQueued) throw new QueueError(`任务 ${id} 当前是 ${row.status}（重试 ${row.retries}/${row.max_retries}），不需要人工解封`, 'NOT_BLOCKED', { taskId: id });
      const history = this.#historyPush(row, { event: 'release', worker, previousReason: row.quarantine_reason || null, note });
      this.db.prepare(`UPDATE tq_tasks SET status='queued', quarantine_reason=NULL, side_effects=NULL, lease_token=NULL, lease_pid=NULL,
          lease_owner=NULL, lease_expires_at=NULL, lease_stale=0, retries=0, history=?, updated_at=? WHERE id=? AND scope=?`)
        .run(JSON.stringify(history), iso(this.now()), row.id, this.runId);
      this.#payloadSet(row.id, 'issues', []);
      this.#event(row.id, 'released', `人工解封（${worker}）：${note || '确认已知改动后放行'}；原隔离原因 ${row.quarantine_reason || '无'}，重新排队`);
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  /** 失败/放弃：携具体 issues 重入队；unknownSideEffects 只能隔离，不能重领。 */
  fail(id, token, issues, options = {}) { return this.tx(() => this.#fail(id, token, issues, options)); }
  #fail(id, token, issues, { unknownSideEffects = false, terminal = false, budgetExceeded = false, attempt: expectedAttempt } = {}) {
    const row = this.#requireTask(id);
    if (row.status === 'verifying' && expectedAttempt !== undefined) {
      if (expectedAttempt !== Number(row.attempts)) throw new LeaseLostError('核验对应的执行轮次已过期，拒绝修改新结果', { taskId: id });
    } else this.#assertLease(row, token);
    const list = this.#issueList(issues);
    if (!list.length) throw new QueueError(`任务 ${id} fail() 必须给出具体 issues`, 'ISSUES_REQUIRED', { taskId: id });
    const attempt = Number(row.attempts);
    const retries = Number(row.retries);
    const maxRetries = Number(row.max_retries);

    this.#attempt(row.id, { attempt, worker: row.lease_owner, outcome: unknownSideEffects ? 'unknown-side-effects' : 'failed', issues: list, leaseToken: token });
    if (!unknownSideEffects) {
      this.#payloadSet(row.id, 'nativeBusyWorker', null);
      this.#payloadSet(row.id, 'expectedNativeId', null);
    }

    if ((terminal || budgetExceeded) && !unknownSideEffects) {
      this.db.prepare("UPDATE tq_tasks SET status='blocked',quarantine_reason=?,lease_token=NULL,lease_pid=NULL,lease_owner=NULL,lease_expires_at=NULL,lease_stale=0,updated_at=? WHERE id=? AND scope=?")
        .run(budgetExceeded ? 'token-budget-exhausted' : 'terminal-failure', iso(this.now()), row.id, this.runId);
      this.#payloadSet(row.id, 'issues', list);
      this.#event(row.id, 'blocked', '本任务停止追加调用，已保存具体问题与已有证据', { issues: list });
      return this.#taskView(this.#requireTask(row.id));
    }

    // 未确认退出 + 未知副作用：隔离，绝不重领。
    if (unknownSideEffects) {
      const history = this.#historyPush(row, { event: 'quarantine', worker: row.lease_owner, issues: list, reason: 'unconfirmed-exit+unknown-side-effects' });
      this.db.prepare(`UPDATE tq_tasks SET status='blocked', retries=?, quarantine_reason='unconfirmed-exit+unknown-side-effects',
          side_effects='unknown', history=?, lease_token=NULL, lease_pid=NULL, lease_owner=NULL, lease_expires_at=NULL, lease_stale=0, updated_at=? WHERE id=? AND scope=?`)
        .run(retries, JSON.stringify(history), iso(this.now()), row.id, this.runId);
      this.#payloadSet(row.id, 'issues', list);
      this.#event(row.id, 'quarantined', '执行者未确认退出且可能有未知副作用：隔离为 blocked，人工确认前不重领', { issues: list });
      return this.#taskView(this.#requireTask(row.id));
    }

    // 无副作用（或已确认）：可安全重试。
    let status = 'blocked';
    let escalated = row.escalated === 1;
    let quarantine = null;
    if (retries < maxRetries) {
      status = 'queued';
    } else if (escalated) {
      quarantine = 'retries-exhausted';
    } else if (this.#hasStrongWorker()) {
      status = 'queued';
      escalated = true;
    } else {
      quarantine = 'retries-exhausted';
    }

    const history = this.#historyPush(row, { event: 'fail', worker: row.lease_owner, issues: list, status, escalated });
    this.db.prepare(`UPDATE tq_tasks SET status=?, retries=?, escalated=?, executor=NULL,
        lease_token=NULL, lease_pid=NULL, lease_owner=NULL, lease_expires_at=NULL, lease_stale=0,
        quarantine_reason=?, history=?, updated_at=? WHERE id=? AND scope=?`)
      .run(status === 'queued' ? 'queued' : 'blocked', Math.min(retries + 1, maxRetries), escalated ? 1 : 0, quarantine, JSON.stringify(history), iso(this.now()), row.id, this.runId);
    this.#payloadSet(row.id, 'issues', list);
    this.#event(row.id, status === 'queued' ? 'requeued' : 'blocked',
      status === 'queued' ? `失败重入队（第 ${retries + 1} 次重试），携 ${list.length} 条 issues` : `失败且不再返工：${quarantine ?? 'blocked'}`,
      { issues: list, escalated });
    return this.#taskView(this.#requireTask(row.id));
  }

  // ───────────────────────────── 验证 ─────────────────────────────

  /** 验收尚未运行或暂时没有独立审核者：保留成果等待核验，不消耗返工次数。 */
  holdVerification(id, issues, { attempt, result } = {}) {
    return this.tx(() => {
      const row = this.#requireTask(id);
      this.#assertVerificationAttempt(row, attempt);
      if (row.status !== 'verifying') throw new QueueError('只有已完成、等待核验的任务可以保留验收', 'BAD_STATE');
      this.#assertCompletedVerification(row);
      const list = this.#issueList(issues);
      if (!list.length) throw new QueueError('保留验收必须说明具体待解决问题', 'ISSUES_REQUIRED');
      const report = result === undefined ? parseJson(row.result, null) : result;
      this.#assertVerificationReport(row, report, { requireArtifacts: false });
      const history = this.#historyPush(row, { event: 'verification-held', attempt, issues: list });
      this.db.prepare('UPDATE tq_tasks SET result=?, history=?, updated_at=? WHERE id=? AND scope=?')
        .run(JSON.stringify(report), JSON.stringify(history), iso(this.now()), row.id, this.runId);
      this.#payloadSet(row.id, 'issues', list);
      this.#attempt(row.id, { attempt, role: 'queue', outcome: 'verification-held', issues: list });
      this.#event(row.id, 'verification-held', '产出已保留，待验收条件满足后仅继续核验，不重新执行', { attempt, issues: list });
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  /** 仅恢复旧控制器把“检查未派发”误算成返工失败的任务，绝不重执行。 */
  restoreBlockedVerification(id, { attempt, result } = {}) {
    return this.tx(() => {
      const row = this.#requireTask(id);
      this.#assertVerificationAttempt(row, attempt);
      if (row.status !== 'blocked' || row.quarantine_reason !== 'retries-exhausted') throw new QueueError('此任务不属于检查未执行导致的返工停止', 'BAD_STATE');
      this.#assertCompletedVerification(row);
      const saved = parseJson(row.result, null);
      // result 只由控制器提供严格检查器的新证据，模型与外部接口不能调用此恢复方法。
      // 已保存的执行失败/未知副作用不能被新的“未派发”记录覆盖。
      if (unknownVerificationEffects(saved) || Array.isArray(saved?.checks) && saved.checks.some(check => !check || check.ok !== true && (check.notDispatched !== true || check.unknownSideEffects !== false || check.cancelled === true) || unknownVerificationEffects(check) || unknownVerificationEffects(check.evidence) || check.evidence?.observed?.dispatched === true && check.ok !== true)) {
        throw new QueueError('历史检查曾执行失败或副作用未知，不能覆盖原失败证据', 'VERIFICATION_EVIDENCE_REQUIRED');
      }
      const report = result === undefined ? saved : result;
      const executor = this.#assertVerificationReport(row, report);
      const checks = report.checks;
      if (!Array.isArray(checks) || !checks.length || checks.some(check => !check || typeof check.ok !== 'boolean' || typeof check.command !== 'string' || !check.command.trim() || unknownVerificationEffects(check) || unknownVerificationEffects(check.evidence))) {
        throw new QueueError('缺少完整、可归属的真实检查记录，不能自动恢复已有产物', 'VERIFICATION_EVIDENCE_REQUIRED');
      }
      const failed = checks.filter(check => !check.ok);
      if (!failed.length || failed.some(check => check.notDispatched !== true || check.unknownSideEffects !== false || check.cancelled === true || check.evidence?.observed?.dispatched === true)) {
        throw new QueueError('曾运行失败、取消或派发状态未知的检查不能按待核验恢复', 'VERIFICATION_EVIDENCE_REQUIRED');
      }
      const history = this.#historyPush(row, { event: 'verification-restored', attempt, executor, previousQuarantine: row.quarantine_reason });
      this.db.prepare("UPDATE tq_tasks SET status='verifying', executor=?, quarantine_reason=NULL, result=?, history=?, updated_at=? WHERE id=? AND scope=?")
        .run(executor, JSON.stringify(report), JSON.stringify(history), iso(this.now()), row.id, this.runId);
      this.#attempt(row.id, { attempt, role: 'queue', outcome: 'verification-restored', detail: { executor, previousQuarantine: row.quarantine_reason } });
      this.#event(row.id, 'verification-restored', '已有产出和检查证据已核对，仅恢复验收；历史用量与返工记录保留', { attempt, executor });
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  // Explicit resume may re-check a safely completed semantic rejection. It does
  // not grant another execution attempt or replace actual failed code checks.
  restoreBlockedSemanticVerification(id, { attempt } = {}) {
    return this.tx(() => {
      const row = this.#requireTask(id);
      this.#assertVerificationAttempt(row, attempt);
      if (row.status !== 'blocked' || row.quarantine_reason !== 'retries-exhausted') throw new QueueError('当前任务不属于语义验收停止', 'BAD_STATE');
      this.#assertCompletedVerification(row);
      this.#assertExecutorExited(row);
      const report = parseJson(row.result, null), executor = this.#assertVerificationReport(row, report);
      const checks = report.checks, payload = this.#taskView(row);
      const commands = [...(payload.checks || []), ...(payload.acceptance || []).filter(item => item && typeof item === 'object').map(item => item.check)].filter(item => typeof item === 'string' && item.trim());
      if (!Array.isArray(checks) || checks.some(check => !check || check.ok !== true || unknownVerificationEffects(check) || unknownVerificationEffects(check.evidence)) || commands.some(command => !checks.some(check => check.command === command && check.ok === true)) || report.verdict?.pass !== false || !Array.isArray(report.verdict.issues) || !report.verdict.issues.length || !row.reviewer || sameId(row.reviewer, executor) || !sameId(report.reviewer, row.reviewer)) throw new QueueError('缺少独立语义核验或真实检查失败，保留原停止状态', 'VERIFICATION_EVIDENCE_REQUIRED');
      this.#assertExactArtifactHashes(report);
      const conflicts = this.#runningScopes().filter(item => item.scope !== this.runId || item.id !== row.id);
      const own = payload.files.length ? payload.files : null;
      if (conflicts.some(item => this.#filesConflict(own, item.files))) throw new QueueError('同一文件正在被其他任务处理，保留原结果等待', 'VERIFICATION_UNSAFE');
      const history = this.#historyPush(row, { event: 'semantic-verification-restored', attempt, executor, previousQuarantine: row.quarantine_reason });
      this.db.prepare("UPDATE tq_tasks SET status='verifying',executor=?,quarantine_reason=NULL,history=?,updated_at=? WHERE id=? AND scope=?")
        .run(executor, JSON.stringify(history), iso(this.now()), row.id, this.runId);
      this.#attempt(row.id, { attempt, role: 'queue', outcome: 'semantic-verification-restored', detail: { executor } });
      this.#event(row.id, 'semantic-verification-restored', '继续核验已有产物，保留执行次数、费用和原失败记录', { attempt, executor });
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  /** 旧控制器把原生启动前的busy算作返工：只在真实RPC日志逐次证实后纠正计数。 */
  restoreBlockedNativeBusy(id, { attempt, nativeId, proofs, trustedLogRoot } = {}) {
    return this.tx(() => {
      const row = this.#requireTask(id);
      this.#assertVerificationAttempt(row, attempt);
      if (row.status !== 'blocked' || row.quarantine_reason !== 'retries-exhausted' || row.cancelled === 1 || row.completed !== 0 || row.side_effects !== null && row.side_effects !== 'none' ||
        row.lease_token !== null || row.lease_pid !== null || row.lease_expires_at !== null || row.result !== null || row.last_checkpoint !== null ||
        this.db.prepare('SELECT id FROM tq_checkpoints WHERE scope=? AND task_id=? LIMIT 1').get(this.runId, row.id) ||
        this.db.prepare("SELECT id FROM tq_events WHERE scope=? AND task_id=? AND type='scope-evidence' LIMIT 1").get(this.runId, row.id)) throw new QueueError('此任务存在完成、动作或未知执行证据，不能按原生等待恢复', 'DISPATCH_UNCERTAIN');
      this.#assertExecutorExited(row, { requirePid: true });
      const history = this.db.prepare('SELECT * FROM tq_attempts WHERE scope=? AND task_id=? ORDER BY id').all(this.runId, row.id);
      const claims = history.filter(entry => entry.outcome === 'claimed'), failures = history.filter(entry => entry.outcome === 'failed');
      if (typeof nativeId !== 'string' || !nativeId || !Array.isArray(proofs) || !attempt || claims.length !== attempt || failures.length !== attempt || proofs.length !== attempt ||
        history.some(entry => !['enqueued', 'claimed', 'failed'].includes(entry.outcome)) || history.filter(entry => entry.outcome === 'enqueued').length !== 1 || history[0]?.outcome !== 'enqueued' || history[0]?.attempt !== 0 ||
        new Set(proofs.map(proof => proof?.stepId)).size !== proofs.length || new Set(proofs.map(proof => proof?.attempt)).size !== proofs.length) {
        throw new QueueError('缺少每次原生失败的完整、独立且同轮次的真实证据', 'DISPATCH_UNCERTAIN');
      }
      const workers = new Set(claims.map(claim => claim.worker));
      if (workers.size !== 1 || !sameId(claims[0]?.worker, 'codex')) throw new QueueError('此恢复仅支持有固定启动协议证据的Codex原生会话', 'DISPATCH_UNCERTAIN');
      for (let number = 1; number <= attempt; number++) {
        const claim = claims.find(entry => entry.attempt === number), failure = failures.find(entry => entry.attempt === number);
        const proof = proofs.find(entry => entry?.attempt === number);
        const issues = parseJson(failure?.issues, null);
        if (!claim || !failure || !proof || failure.id <= claim.id || claim.lease_token !== failure.lease_token || !sameId(failure.worker, claim.worker) ||
          !Array.isArray(issues) || !issues.length || issues.some(message => typeof message !== 'string' || message !== `thread ${nativeId} already has an active writer`)) {
          throw new QueueError('历史失败包含真实执行问题或无法归属的错误，不能重置返工次数', 'DISPATCH_UNCERTAIN');
        }
        this.#assertLegacyNativeBusyProof(row, claim, failure, proof, nativeId, trustedLogRoot);
      }
      const previous = { attempts: Number(row.attempts), retries: Number(row.retries), escalated: row.escalated === 1 };
      const audit = this.#historyPush(row, { event: 'native-busy-restored', previous, nativeId, stepIds: proofs.map(proof => proof.stepId) });
      this.db.prepare("UPDATE tq_tasks SET status='queued',attempts=0,retries=0,escalated=0,executor=NULL,executor_pid=NULL,side_effects='none',side_effects_verified=1,quarantine_reason=NULL,history=?,updated_at=? WHERE scope=? AND id=?")
        .run(JSON.stringify(audit), iso(this.now()), this.runId, row.id);
      this.#payloadSet(row.id, 'nativeBusyWorker', claims[0].worker);
      this.#payloadSet(row.id, 'expectedNativeId', nativeId);
      this.#attempt(row.id, { attempt, worker: claims[0].worker, role: 'queue', outcome: 'native-busy-restored', detail: { previous, nativeId, proofs } });
      this.#event(row.id, 'native-busy-restored', '历史请求均在启动前被原生会话占用拒绝，已纠正执行及返工计数；费用和失败证据全部保留，继续原会话等待', { previous, nativeId, proofs });
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  #assertLegacyNativeBusyProof(row, claim, failure, proof, nativeId, trustedLogRoot) {
    try {
      const step = Number.isInteger(proof.stepId) ? this.db.prepare('SELECT * FROM steps WHERE id=?').get(proof.stepId) : null;
      const error = `thread ${nativeId} already has an active writer`;
      if (!step || step.run_id !== this.runId || step.role !== 'execute' || step.agent !== 'codex' || step.state !== 'failed' || Number(step.round) !== Number(claim.attempt) || step.error !== error ||
        !sameId(step.seat || step.agent, claim.worker) || ![claim.at, failure.at, step.started_at, step.ended_at].every(value => Number.isFinite(Date.parse(value))) ||
        Date.parse(step.started_at) < Date.parse(claim.at) || Date.parse(step.ended_at) < Date.parse(step.started_at) || Date.parse(step.ended_at) > Date.parse(failure.at)) throw new Error('step mismatch');
      if (!path.isAbsolute(trustedLogRoot) || !path.isAbsolute(proof.logFile) || path.basename(proof.logFile) !== `${this.runId}-${proof.stepId}.jsonl` ||
        typeof proof.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(proof.sha256)) throw new Error('unbound log');
      const root = fs.realpathSync(trustedLogRoot), file = fs.realpathSync(proof.logFile), relative = path.relative(root, file);
      if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) || !fs.statSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) throw new Error('outside trusted logs');
      const text = fs.readFileSync(file, 'utf8');
      if (!text.endsWith('\n') || createHash('sha256').update(text).digest('hex') !== proof.sha256.toLowerCase()) throw new Error('incomplete log');
      let phase = 'initialize', segments = 0;
      for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
        const message = JSON.parse(line);
        if (phase === 'initialize' && message.id === 1 && !message.method && !message.error && typeof message.result?.userAgent === 'string' && /\bbeat[;/]/i.test(message.result.userAgent)) {
          phase = 'resume'; continue;
        }
        if (phase === 'resume' && message.id === undefined && message.method === 'remoteControl/status/changed' && message.params?.status === 'disabled') continue;
        if (phase === 'resume' && message.id === 2 && !message.method && !message.result && message.error?.code === -32600 && message.error.message === error) {
          segments++; phase = 'initialize'; continue;
        }
        throw new Error('possible turn or unrecognized RPC event');
      }
      if (phase !== 'initialize' || !segments) throw new Error('no complete startup rejection');
    } catch { throw new QueueError('原生失败日志、步骤身份或未启动证据不完整，保留停止状态', 'DISPATCH_UNCERTAIN'); }
  }

  #assertVerificationAttempt(row, attempt) {
    if (!Number.isInteger(attempt) || attempt !== Number(row.attempts)) throw new LeaseLostError('验收对应的执行轮次已过期或缺失，不能修改当前结果', { taskId: row.id });
  }

  #assertExecutorExited(row, { requirePid = false } = {}) {
    const pid = row.executor_pid === null ? null : Number(row.executor_pid);
    let exited = pid === null && !requirePid;
    if (pid !== null && Number.isInteger(pid) && pid > 0) {
      try { exited = this.isProcessAlive(pid) === false; } catch { exited = false; }
    }
    if (!exited) throw new QueueError('上次执行进程尚未确认退出，保留现有证据等待核对', 'VERIFICATION_UNSAFE');
  }

  #assertExactArtifactHashes(report) {
    try {
      const hashes = report.artifactHashes;
      const artifacts = report.artifacts.map(item => typeof item === 'string' ? item : item?.path);
      if (!Array.isArray(hashes) || hashes.length !== artifacts.length || !artifacts.length) throw new Error('incomplete');
      const files = values => values.map(value => {
        if (typeof value !== 'string' || !value.trim()) throw new Error('missing path');
        const absolute = artifactFile(this.cwd, value);
        const normalized = normalizeArtifactPath(this.cwd, absolute, this.caseInsensitive);
        const real = fs.realpathSync(absolute);
        return { absolute, normalized, real: this.caseInsensitive ? real.toLowerCase() : real };
      });
      const expected = files(artifacts), observed = files(hashes.map(item => item?.path));
      if (new Set(expected.map(file => file.normalized)).size !== expected.length || new Set(expected.map(file => file.real)).size !== expected.length ||
        new Set(observed.map(file => file.normalized)).size !== observed.length || new Set(observed.map(file => file.real)).size !== observed.length ||
        expected.some(file => !observed.some(hash => hash.normalized === file.normalized))) throw new Error('mismatched set');
      for (let index = 0; index < observed.length; index++) {
        const hash = hashes[index]?.sha256;
        if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash) || createHash('sha256').update(fs.readFileSync(observed[index].absolute)).digest('hex') !== hash.toLowerCase()) throw new Error('changed');
      }
    } catch { throw new QueueError('当前产物已变化、真实路径越界或缺少完整且唯一的文件哈希，不能沿用旧完成记录', 'VERIFICATION_EVIDENCE_REQUIRED'); }
  }

  #assertCompletedVerification(row) {
    if (row.cancelled === 1 || row.completed !== 1 || row.side_effects_verified !== 1 || row.side_effects === 'unknown' || row.lease_token !== null || row.lease_pid !== null || row.lease_expires_at !== null) {
      throw new QueueError('执行尚未安全完成、已取消或仍持有租约，不能恢复验收', 'VERIFICATION_UNSAFE');
    }
  }

  #assertVerificationReport(row, report, { requireArtifacts = true } = {}) {
    const completed = this.db.prepare("SELECT worker,detail FROM tq_attempts WHERE scope=? AND task_id=? AND attempt=? AND outcome='completed' ORDER BY id DESC LIMIT 1")
      .get(row.scope, row.id, Number(row.attempts));
    const original = parseJson(completed?.detail, null)?.result;
    const executor = completed?.worker;
    const artifactPaths = value => Array.isArray(value?.artifacts) ? value.artifacts.map(item => typeof item === 'string' ? item : item?.path).map(item => typeof item === 'string' && item.trim() ? normalizeArtifactPath(this.cwd, item, this.caseInsensitive) : null).sort() : [];
    const paths = artifactPaths(report), originalPaths = artifactPaths(original);
    if (!report || typeof report !== 'object' || Array.isArray(report) || report.taskId !== row.id || original?.taskId !== row.id || !executor || !sameId(report.executor, executor) || !sameId(original?.executor, executor) || (row.executor && !sameId(row.executor, executor)) || requireArtifacts && !paths.length || paths.some(item => item === null) || JSON.stringify(paths) !== JSON.stringify(originalPaths) || (report.reportPath ?? null) !== (original?.reportPath ?? null) || unknownVerificationEffects(report) || unknownVerificationEffects(original)) {
      throw new QueueError('核验报告的执行者或产物与当前轮次的真实完成记录不一致', 'VERIFICATION_EVIDENCE_REQUIRED');
    }
    return executor;
  }

  /**
   * 审核（只能由非执行者调用）。pass → passed；失败 → 携 issues 重入队（次数 +1），
   * 超过 maxRetries 升级 strong worker，再不行 blocked。
   * @param {string} reviewer
   * @param {{pass:boolean, issues?:Array, token?:string}} verdict
   */
  verify(id, reviewer, verdict = {}) { return this.tx(() => this.#verify(id, reviewer, verdict)); }
  #verify(id, reviewer, { pass, issues, token, result, attempt: expectedAttempt } = {}) {
    if (typeof pass !== 'boolean') throw new QueueError('verify 需要显式的 {pass:boolean}', 'BAD_VERDICT', { taskId: id });
    const row = this.#requireTask(id);
    if (expectedAttempt !== undefined && expectedAttempt !== Number(row.attempts)) throw new LeaseLostError('核验对应的执行轮次已过期，拒绝批准新的执行结果', { taskId: id });
    if (row.status !== 'verifying') throw new QueueError(`任务 ${id} 当前状态为 ${row.status}，不可验证（需先 complete 进入 verifying）`, 'BAD_STATE', { taskId: id, status: row.status });

    const reviewerId = normalizeWorker(reviewer).id;
    if ((row.executor ?? '') && sameId(row.executor, reviewerId)) {
      throw new QueueError(`审核者不能是执行者本人（${reviewerId}）`, 'REVIEWER_IS_EXECUTOR', { taskId: id, reviewer: reviewerId, executor: row.executor });
    }

    const attempt = Number(row.attempts);
    const retries = Number(row.retries);
    const maxRetries = Number(row.max_retries);
    const list = this.#issueList(issues);
    if (pass && list.length) throw new QueueError('核验存在具体问题，不能同时判定通过', 'BAD_VERDICT', { taskId: id });
    if (!pass && !list.length) throw new QueueError(`任务 ${id} 验证不通过必须给出具体 issues`, 'ISSUES_REQUIRED', { taskId: id });

    if (pass) {
      this.#assertSupersededVerificationFresh(row, result);
      const dependencies = this.db.prepare('SELECT dep FROM tq_deps WHERE scope=? AND task_id=?').all(this.runId,row.id);
      if (dependencies.some(({dep}) => this.#rawTask(dep)?.status !== 'passed')) throw new QueueError('依赖任务尚未通过，必须先等待依赖修复再核验', 'DEPENDENCY_NOT_PASSED');
      const history = this.#historyPush(row, { event: 'verified', reviewer: reviewerId, pass: true });
      this.db.prepare(`UPDATE tq_tasks SET status='passed', reviewer=?, history=?, updated_at=? WHERE id=? AND scope=?`)
        .run(reviewerId, JSON.stringify(history), iso(this.now()), row.id, this.runId);
      this.db.prepare('UPDATE tq_tasks SET lease_token=NULL, lease_pid=NULL, lease_expires_at=NULL, lease_stale=0 WHERE id=? AND scope=?').run(row.id, this.runId);
      this.#payloadSet(row.id, 'issues', []);
      this.#payloadSet(row.id, 'inputRefsInvalid', false); this.#payloadSet(row.id, 'invalidatedDependencies', []);
      if (result !== undefined) this.#payloadSet(row.id, 'result', result);
      if (result !== undefined) this.db.prepare('UPDATE tq_tasks SET result=? WHERE id=? AND scope=?').run(JSON.stringify(result), row.id, this.runId);
      this.#attempt(row.id, { attempt, worker: reviewerId, role: 'reviewer', outcome: 'passed', leaseToken: token ?? null });
      this.#event(row.id, 'passed', `${reviewerId} 验证通过`, { attempt });
      return this.#taskView(this.#requireTask(row.id));
    }

    // 不通过：次数 +1，要么重入队，要么升级 strong worker，要么 blocked。
    let status = 'blocked';
    let escalated = row.escalated === 1;
    let quarantine = null;
    if (retries < maxRetries) status = 'queued';
    else if (escalated) quarantine = 'retries-exhausted';
    else if (this.#hasStrongWorker()) { status = 'queued'; escalated = true; }
    else quarantine = 'retries-exhausted';

    const history = this.#historyPush(row, { event: 'verified', reviewer: reviewerId, pass: false, issues: list, status, escalated });
    // 失败检查也是实际证据；保存本轮报告，恢复不能只看到 complete 时的旧副本。
    if (result !== undefined) this.db.prepare('UPDATE tq_tasks SET result=? WHERE id=? AND scope=?').run(JSON.stringify(result), row.id, this.runId);
    this.db.prepare(`UPDATE tq_tasks SET status=?, retries=?, escalated=?, executor=NULL, reviewer=?,
        lease_token=NULL, lease_pid=NULL, lease_owner=NULL, lease_expires_at=NULL, lease_stale=0,
        quarantine_reason=?, history=?, updated_at=? WHERE id=? AND scope=?`)
      .run(status === 'queued' ? 'queued' : 'blocked', Math.min(retries + 1, maxRetries), escalated ? 1 : 0, reviewerId, quarantine, JSON.stringify(history), iso(this.now()), row.id, this.runId);
    this.#payloadSet(row.id, 'issues', list);
    this.#attempt(row.id, { attempt, worker: reviewerId, role: 'reviewer', outcome: 'rejected', issues: list, leaseToken: token ?? null });
    this.#event(row.id, status === 'queued' ? 'requeued' : 'blocked',
      status === 'queued' ? `验证不通过，重入队（第 ${retries + 1} 次重试）${escalated ? '并升级 strong worker' : ''}` : '验证反复不通过，停止返工',
      { issues: list, escalated });
    return this.#taskView(this.#requireTask(row.id));
  }

  // ───────────────────────── 租约与回收 ─────────────────────────

  /**
   * 本进程仍持有的租约只是“时间过了”（电脑睡眠、负载卡顿）：令牌没被轮换、状态仍是执行中、
   * 持有进程就是自己——说明没有任何人接手过，续上租约再写结果，不把已做完的活作废。
   * 令牌已轮换或被别的进程持有时一律拒绝。
   */
  renewOwnLease(id, token) {
    return this.tx(() => {
      const row = this.#requireTask(id);
      if (!token || String(token) !== String(row.lease_token) || row.status !== 'running' || Number(row.lease_pid) !== process.pid) return false;
      if (row.lease_expires_at !== null && Number(row.lease_expires_at) > this.now() && row.lease_stale !== 1) return true;
      this.db.prepare('UPDATE tq_tasks SET lease_expires_at=?, lease_stale=0, updated_at=? WHERE id=? AND scope=?').run(this.now() + this.leaseMs, iso(this.now()), row.id, this.runId);
      this.#event(row.id, 'lease-renewed', '本进程的租约因电脑睡眠或卡顿过期，令牌未被轮换、无人接手，已续期后保存结果');
      return true;
    });
  }

  #assertLease(row, token) {
    if (!token || row.lease_token === null || row.lease_token === undefined) {
      throw new LeaseLostError(`任务 ${row.id} 没有有效租约（可能已超时回收）`, { taskId: row.id });
    }
    if (String(token) !== String(row.lease_token)) {
      throw new LeaseLostError(`任务 ${row.id} 的 leaseToken 已失效（fencing token 不匹配）`, { taskId: row.id });
    }
    if (row.status !== 'running') {
      throw new LeaseLostError(`任务 ${row.id} 状态为 ${row.status}，租约已释放`, { taskId: row.id, status: row.status });
    }
    if (row.lease_expires_at !== null && Number(row.lease_expires_at) <= this.now()) {
      throw new LeaseLostError(`任务 ${row.id} 租约已于 ${iso(row.lease_expires_at)} 过期，拒绝写入`, { taskId: row.id, expiredAt: Number(row.lease_expires_at) });
    }
  }

  /** 全局评估定位到已通过的小任务：只返工该任务，依赖消费者先重核，不自动重做。 */
  reopen(id, reviewer, issues, { attempt: expectedAttempt } = {}) {
    return this.tx(() => {
      const row = this.#requireTask(id), reviewerId = normalizeWorker(reviewer).id, list = this.#issueList(issues);
      if (row.status !== 'passed') throw new QueueError('只有已通过的任务才能按评估问题返工', 'BAD_STATE');
      if (expectedAttempt === undefined || expectedAttempt !== Number(row.attempts)) throw new LeaseLostError('返工评估对应的执行轮次已过期', { taskId: id });
      if (sameId(row.executor, reviewerId)) throw new QueueError('执行者不能自己批准自己的返工评估', 'REVIEWER_IS_EXECUTOR');
      if (!list.length) throw new QueueError('返工需要指明具体问题', 'ISSUES_REQUIRED');
      const retries = Number(row.retries), maxRetries = Number(row.max_retries);
      const escalated = row.escalated === 1 || retries >= maxRetries && this.#hasStrongWorker();
      const retry = retries < maxRetries || row.escalated !== 1 && this.#hasStrongWorker();
      const history = this.#historyPush(row, { event:'reopened', reviewer:reviewerId, issues:list, attempt:expectedAttempt });
      this.db.prepare("UPDATE tq_tasks SET status=?,retries=?,escalated=?,reviewer=?,quarantine_reason=?,history=?,updated_at=? WHERE id=? AND scope=?")
        .run(retry ? 'queued' : 'blocked', Math.min(retries+1,maxRetries), escalated ? 1 : 0, reviewerId, retry ? null : 'retries-exhausted', JSON.stringify(history), iso(this.now()), row.id, this.runId);
      this.#payloadSet(row.id,'issues',list); this.#attempt(row.id,{attempt:expectedAttempt,worker:reviewerId,role:'reviewer',outcome:'reopened',issues:list});
      const previousResult = parseJson(row.result,null);
      this.#payloadSet(row.id,'repairScope',{ taskId:row.id, attempt:expectedAttempt, issues:list, files:this.#taskView(row).files, previousArtifacts:previousResult?.artifacts || [], previousChecks:previousResult?.checks || [], policy:'repair-only-listed-issues' });
      this.#event(row.id,'reopened','全局评估定位具体问题，保留证据并仅返工对应任务',{issues:list});
      const invalidated = new Set([row.id]), pending = [row.id];
      while (pending.length) {
        const dep = pending.shift();
        for (const {task_id} of this.db.prepare('SELECT task_id FROM tq_deps WHERE scope=? AND dep=?').all(this.runId,dep)) {
          if (invalidated.has(task_id)) continue;
          invalidated.add(task_id); pending.push(task_id);
          const consumer = this.#requireTask(task_id);
          if (consumer.status !== 'passed') continue;
          this.db.prepare("UPDATE tq_tasks SET status='verifying',reviewer=NULL,updated_at=? WHERE id=? AND scope=?").run(iso(this.now()),task_id,this.runId);
          this.#payloadSet(task_id,'inputRefsInvalid',true);this.#payloadSet(task_id,'invalidatedDependencies',[row.id]);
          this.#payloadSet(task_id,'issues',['依赖任务已返工，原输入引用需重新核验，尚未自动重执行']);
          this.#event(task_id,'inputs-invalidated','依赖产出已返工，先重新核验已有产物',{dependency:row.id});
        }
      }
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  /** 记录被判越界的改动证据（文件 + 本次尝试开始时间），供恢复时复核是否误判。 */
  recordScopeEvidence(id, token, evidence) {
    return this.tx(() => {
      const row = this.#requireTask(id); this.#assertLease(row, token);
      const files = [...new Set((Array.isArray(evidence?.files) ? evidence.files : []).filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))].slice(0, 200);
      const payload = { files, attemptStartedAt: Number(evidence?.attemptStartedAt) || Date.now(), attributed: evidence?.attributed === true };
      this.#payloadSet(row.id, 'scopeEvidence', payload);
      this.#event(row.id, 'scope-evidence', '记录越界改动证据，恢复时按文件时间复核是否误判', payload);
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  /** 恢复任务时按当前客户设置重新分配的单任务预算上限（只增不减，审计留在历史里）。 */
  setTaskBudget(id, budget) {
    return this.tx(() => {
      const row = this.#requireTask(id);
      const from = Number(row.token_budget) || 0;
      const to = Math.max(from, Math.floor(Number(budget) || 0));
      if (to === from) return this.#taskView(row);
      const history = this.#historyPush(row, { event: 'budget-reallocated', from, to });
      this.db.prepare('UPDATE tq_tasks SET token_budget=?,history=?,updated_at=? WHERE id=? AND scope=?')
        .run(to, JSON.stringify(history), iso(this.now()), row.id, this.runId);
      this.#event(row.id, 'budget-reallocated', `恢复时按当前客户设置重新分配单任务预算：${from} → ${to}`, { from, to });
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  /**
   * 显式恢复被中断的任务：把从未执行成功、只因预算或路由被停止的任务重新排队。
   * 只接受路由类隔离原因（预算/无可用搭档）；额度耗尽、未知副作用、未确认退出等仍须人工核对，不自动恢复。
   * 重试计数按新一轮重置，历史与新事件全部保留。
   */
  requeueBlocked(id, { reason = 'resume-reallocation', allowReasons = null } = {}) {
    return this.tx(() => {
      const row = this.#requireTask(id);
      if (row.status !== 'blocked') throw new QueueError('只有被停止的任务可以恢复排队', 'BAD_STATE');
      const previous = String(row.quarantine_reason || '');
      const allowed = Array.isArray(allowReasons) && allowReasons.length ? allowReasons : ['token-budget-routing', 'admission-blocked', 'no-eligible-worker', 'token-budget-exhausted'];
      if (!allowed.includes(previous))
        throw new QueueError('该任务的停止原因需要人工核对，不能自动恢复：' + (previous || '未记录'), 'NOT_REQUEUEABLE');
      const history = this.#historyPush(row, { event: 'resume-requeue', reason, previousQuarantine: previous, previousRetries: Number(row.retries) });
      this.db.prepare("UPDATE tq_tasks SET status='queued',retries=0,quarantine_reason=NULL,lease_token=NULL,lease_pid=NULL,lease_owner=NULL,lease_expires_at=NULL,lease_stale=0,history=?,updated_at=? WHERE id=? AND scope=?")
        .run(JSON.stringify(history), iso(this.now()), row.id, this.runId);
      this.#attempt(row.id, { attempt: Number(row.attempts), role: 'queue', outcome: 'resume-requeue', detail: { reason, previousQuarantine: previous } });
      this.#event(row.id, 'resume-requeue', '恢复任务：按当前设置重新分配预算并重新排队；历史用量与失败证据保留', { reason, previousQuarantine: previous });
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  /** 规则判定当前预算/搭档不足：只停止未领取任务，不伪造用户取消或抹去已有证据。 */
  block(id, issues, { attempt: expectedAttempt, reason = 'admission-blocked' } = {}) {
    return this.tx(() => {
      const row=this.#requireTask(id),list=this.#issueList(issues);
      if (row.status !== 'queued') throw new QueueError('只有尚未领取的任务可以按路由规则停止', 'BAD_STATE');
      if (expectedAttempt !== undefined && expectedAttempt !== Number(row.attempts)) throw new LeaseLostError('路由评估对应的任务轮次已过期', {taskId:id});
      if (!list.length) throw new QueueError('停止任务必须给出具体原因', 'ISSUES_REQUIRED');
      this.db.prepare("UPDATE tq_tasks SET status='blocked',quarantine_reason=?,updated_at=? WHERE id=? AND scope=?").run(String(reason).slice(0,200),iso(this.now()),row.id,this.runId);
      this.#payloadSet(row.id,'issues',list);this.#attempt(row.id,{attempt:Number(row.attempts),role:'queue',outcome:'admission-blocked',issues:list});
      this.#event(row.id,'blocked','当前预算或搭档不足，任务尚未执行；保留已有检查点与证据',{issues:list,reason});
      return this.#taskView(this.#requireTask(row.id));
    });
  }

  /**
   * 回收超时租约。规则：
   *  - 活 pid（或无法确认死亡）→ 只标记 stale + 强制过期租约，绝不重领。
   *  - 确认 pid 已退出、已验证副作用 → 重新入队（retries 不变，下次 claim 递增 attempts）。
   *  - 确认 pid 已退出、但未确认退出且可能有未知副作用 → 隔离为 blocked/unconfirmed-exit。
   * @returns {{requeued:string[], quarantined:string[], stale:string[]}}
   */
  recover(options = {}) { return this.tx(() => this.#recover()); }
  #recover() {
    const at = this.now();
    const result = { requeued: [], quarantined: [], stale: [] };
    const rows = this.db.prepare("SELECT * FROM tq_tasks WHERE scope=? AND status='running'").all(this.runId);
    for (const row of rows) {
      if (row.lease_expires_at !== null && Number(row.lease_expires_at) > at) continue; // 租约仍有效
      const pid = row.lease_pid === null || row.lease_pid === undefined ? null : Number(row.lease_pid);
      let alive = true;
      try { alive = pid === null ? true : this.isProcessAlive(pid) !== false; } catch { alive = true; }
      if (!alive && row.executor_pid != null) {
        try { alive = this.isProcessAlive(Number(row.executor_pid)) !== false; } catch { alive = true; }
      }

      if (alive) {
        // 活 pid 或无法确认：不重领，只强制过期租约并标记 stale。
        this.db.prepare('UPDATE tq_tasks SET lease_expires_at=?, lease_stale=1, updated_at=? WHERE id=? AND scope=?')
          .run(at, iso(at), row.id, this.runId);
        this.#event(row.id, 'lease-stale', `租约超时但 pid ${pid ?? '未知'} 仍存活：不重领，已标记 stale`, { pid });
        result.stale.push(row.id);
        continue;
      }

      const sideEffects = row.side_effects ?? null;
      // 只有“已确认退出（complete）= 已确认”或“显式声明无副作用”才允许回收；
      // 其余未确认退出（含显式 unknown）一律隔离，绝不重领。
      const safeToRequeue = row.completed === 1 || sideEffects === 'none';
      if (safeToRequeue) {
        const history = this.#historyPush(row, { event: 'recovered', reason: 'dead-pid+verified-side-effects' });
        this.db.prepare(`UPDATE tq_tasks SET status='queued', executor=NULL,
            lease_token=NULL, lease_pid=NULL, lease_owner=NULL, lease_expires_at=NULL, lease_stale=0,
            history=?, quarantine_reason=NULL, updated_at=? WHERE id=? AND scope=?`)
          .run(JSON.stringify(history), iso(at), row.id, this.runId);
        this.#attempt(row.id, { attempt: Number(row.attempts), worker: row.lease_owner, outcome: 'recovered', detail: 'dead-pid' });
        this.#event(row.id, 'requeued', '确认持有 pid 已退出且无未知副作用：重新入队', { pid });
        result.requeued.push(row.id);
      } else {
        const history = this.#historyPush(row, { event: 'quarantine', reason: 'unconfirmed-exit+unknown-side-effects', pid });
        this.db.prepare(`UPDATE tq_tasks SET status='blocked', quarantine_reason='unconfirmed-exit+unknown-side-effects',
            lease_token=NULL, lease_pid=NULL, lease_owner=NULL, lease_expires_at=NULL, lease_stale=0, history=?, updated_at=? WHERE id=? AND scope=?`)
          .run(JSON.stringify(history), iso(at), row.id, this.runId);
        this.#payloadSet(row.id, 'issues', ['执行者未确认退出且可能产生未知副作用，需人工确认后才能重领']);
        this.#attempt(row.id, { attempt: Number(row.attempts), worker: row.lease_owner, outcome: 'quarantined', detail: 'unconfirmed-exit' });
        this.#event(row.id, 'quarantined', '未确认退出 + 可能有未知副作用：隔离，不重领', { pid });
        result.quarantined.push(row.id);
      }
    }
    return result;
  }

  // ───────────────────── 记账 / 取消 / 指标 ─────────────────────

  /** token 记账。token 传入时校验 fencing；预算耗尽只止损（不删除成果）。 */
  recordUsage(id, token, usage = {}) { return this.tx(() => this.#recordUsage(id, token, usage)); }
  #recordUsage(id, token, usage = {}) {
    const row = this.#requireTask(id);
    if (token !== undefined && token !== null) this.#assertLease(row, token);
    const tokens = toSafeInt(usage.tokens ?? usage.totalTokens ?? usage.total_tokens, 0);
    const prompt = toSafeInt(usage.promptTokens ?? usage.prompt_tokens ?? usage.inputTokens, 0);
    const completion = toSafeInt(usage.completionTokens ?? usage.completion_tokens ?? usage.outputTokens, 0);
    const total = tokens || (prompt + completion);
    if ([tokens, prompt, completion].some(value => value < 0)) throw new QueueError('用量不能为负数', 'BAD_USAGE');
    const at = this.now();
    this.db.prepare(`INSERT INTO tq_usage (scope,task_id,tokens,prompt_tokens,completion_tokens) VALUES (?,?,?,?,?)
      ON CONFLICT(scope,task_id) DO UPDATE SET tokens=tokens+excluded.tokens, prompt_tokens=prompt_tokens+excluded.prompt_tokens, completion_tokens=completion_tokens+excluded.completion_tokens`)
      .run(this.runId, row.id, total, prompt, completion);
    const usedRow = this.db.prepare('SELECT * FROM tq_usage WHERE scope=? AND task_id=?').get(this.runId, row.id);
    const used = Number(usedRow?.tokens ?? 0);
    const previous = parseJson(row.usage, {}) || {}, measured = usage.verified === true;
    const merged = { ...previous, ...usage, tokens: used, measuredTokens: (previous.measuredTokens || 0) + (measured ? total : 0),
      estimatedTokens: (previous.estimatedTokens || 0) + (measured ? 0 : total), unknownCalls: (previous.unknownCalls || 0) + (measured ? 0 : 1), at: iso(at) };
    const exhausted = this.enforceTokenBudget && Number(row.token_budget) > 0 && used >= Number(row.token_budget);
    this.db.prepare('UPDATE tq_tasks SET tokens_used=?, usage=?, updated_at=? WHERE id=? AND scope=?')
      .run(used, JSON.stringify(merged), iso(at), row.id, this.runId);
    this.#event(row.id, exhausted ? 'token-brake' : 'usage', exhausted
      ? `token 预算用尽（${used}/${Number(row.token_budget)}），停止领取`
      : `token 记账 ${total}（累计 ${used}）`, { usage: merged });
    return this.#taskView(this.#requireTask(row.id));
  }

  /** 设置/读取 run 级 token 上限（跨任务总量止损）。 */
  tokenBudgetCap(limit) {
    if (limit === undefined) return toSafeInt(this.#meta('tokenBudgetCap'), 0);
    const n = toSafeInt(limit, 0);
    this.#meta('tokenBudgetCap', n < 0 ? 0 : n);
    return this.tokenBudgetCap();
  }

  /**
   * 取消：保留证据（任务、尝试、检查点、事件一律不删除）。
   * @param {string|object} [taskId] 省略则取消整个 run 的未终结任务
   * @param {{reason?:string}} [opts]
   */
  cancel(taskId, opts = {}) {
    if (taskId && typeof taskId === 'object') { opts = taskId; taskId = undefined; }
    const reason = opts.reason ?? 'cancelled-by-operator';
    const at = this.now();
    // 只先取 id；状态必须在事务内重读——另一个连接可能在 SELECT 与 BEGIN IMMEDIATE 之间
    // 把任务置为 passed/blocked，用过期的快照判定会把已通过的结果覆盖成取消。
    const ids = taskId
      ? [this.#requireTask(taskId).id]
      : this.db.prepare("SELECT id FROM tq_tasks WHERE scope=? AND status NOT IN ('passed','failed','blocked')").all(this.runId).map(r => r.id);
    const cancelled = [];
    this.tx(() => {
      for (const id of ids) {
        const row = this.#requireTask(id);
        if (row.status === 'passed' || row.status === 'blocked') continue;
        const history = this.#historyPush(row, { event: 'cancel', reason, previousStatus: row.status });
        const info = this.db.prepare(`UPDATE tq_tasks SET status='blocked', cancelled=1, executor=NULL,
            lease_token=NULL, lease_pid=NULL, lease_owner=NULL, lease_expires_at=NULL, lease_stale=0,
            quarantine_reason=?, history=?, updated_at=? WHERE id=? AND scope=? AND status NOT IN ('passed','blocked')`)
          .run(`cancelled:${reason}`, JSON.stringify(history), iso(at), row.id, this.runId);
        if (!info.changes) continue; // 事务内重读后状态已变（如已通过），不改写
        this.#payloadSet(row.id, 'issues', [`已取消：${reason}`]);
        this.#attempt(row.id, { attempt: Number(row.attempts), worker: row.lease_owner, outcome: 'cancelled', detail: reason });
        this.#event(row.id, 'cancelled', `任务被取消：${reason}（证据/检查点保留）`, { previousStatus: row.status });
        cancelled.push(this.#taskView(this.#requireTask(row.id)));
      }
    });
    return cancelled;
  }

  /**
   * 孤儿回收：执行循环退出后，本进程名下仍停在 running 的任务必然没有活着的执行者
   * （能收尾它们的循环已经不在了）。安全收摊为 blocked（人工可放行），证据与检查点保留。
   * 只回收 lease_pid 等于本进程的行；跨进程租约由 recover() 的三分法处理，绝不越界。
   * @returns {object[]} 被收摊的任务视图
   */
  reclaimOrphans({ reason = '执行循环已退出', pid = process.pid, loopExited = false } = {}) {
    if (!loopExited) throw new QueueError('reclaimOrphans 只能在执行循环退出后调用（否则会把合法执行中的任务收摊）', 'BAD_STATE');
    return this.tx(() => {
      const reclaimed = [];
      const rows = this.db.prepare("SELECT * FROM tq_tasks WHERE scope=? AND status='running' AND lease_pid=?").all(this.runId, scalar(pid));
      for (const row of rows) {
        const list = [`执行循环已退出但任务仍处于执行中（执行者已无归属），已安全收摊：${reason}`];
        const history = this.#historyPush(row, { event: 'orphan-reclaimed', reason, pid: Number(row.lease_pid) });
        this.db.prepare(`UPDATE tq_tasks SET status='blocked', quarantine_reason='orphan-loop-exited',
            lease_token=NULL, lease_pid=NULL, lease_owner=NULL, lease_expires_at=NULL, lease_stale=0, history=?, updated_at=? WHERE id=? AND scope=? AND status='running'`)
          .run(JSON.stringify(history), iso(this.now()), row.id, this.runId);
        this.#payloadSet(row.id, 'issues', list);
        this.#attempt(row.id, { attempt: Number(row.attempts), worker: row.lease_owner, outcome: 'orphan-reclaimed', detail: reason });
        this.#event(row.id, 'orphan-reclaimed', '执行循环退出后任务仍标记为执行中：安全收摊为待人工处理（证据/检查点保留），可在看板放行重试');
        reclaimed.push(this.#taskView(this.#requireTask(row.id)));
      }
      return reclaimed;
    });
  }

  metrics() {
    const depth = this.#statusCounts();
    const quarantined = this.db.prepare("SELECT id FROM tq_tasks WHERE scope=? AND status='blocked' AND quarantine_reason IS NOT NULL ORDER BY id").all(this.runId).map(r => r.id);
    const blocked = this.db.prepare("SELECT id FROM tq_tasks WHERE scope=? AND status='blocked' ORDER BY id").all(this.runId).map(r => r.id);
    const running = this.db.prepare("SELECT id,lease_owner,lease_pid,lease_expires_at,lease_stale FROM tq_tasks WHERE scope=? AND status='running' ORDER BY id").all(this.runId)
      .map(r => ({ id: r.id, worker: r.lease_owner, pid: r.lease_pid === null ? null : Number(r.lease_pid), expiresAt: r.lease_expires_at === null ? null : Number(r.lease_expires_at), expired: r.lease_expires_at !== null && Number(r.lease_expires_at) <= this.now(), stale: r.lease_stale === 1 }));
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM tq_tasks WHERE scope=?').get(this.runId)?.n ?? 0);
    const usageRow = this.db.prepare('SELECT COALESCE(SUM(tokens),0) AS tokens, COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion FROM tq_usage WHERE scope=?').get(this.runId);
    const timedOut = Number(this.db.prepare("SELECT COUNT(*) AS n FROM tq_events WHERE scope=? AND type IN ('lease-stale','quarantined','token-brake')").get(this.runId)?.n ?? 0);
    const retriesByTask = {};
    for (const r of this.db.prepare('SELECT id, retries FROM tq_tasks WHERE scope=? AND retries>0').all(this.runId)) retriesByTask[r.id] = Number(r.retries);
    const workers = {};
    for (const r of this.db.prepare("SELECT executor, COUNT(*) AS n FROM tq_tasks WHERE scope=? AND executor IS NOT NULL AND status='running' GROUP BY executor").all(this.runId)) {
      workers[r.executor] = { active: Number(r.n), strong: this.strongWorkers.has(r.executor) };
    }
    return {
      runId: this.runId,
      depth: { ...depth, total },
      total,
      passed: depth.passed,
      queued: depth.queued,
      running: depth.running,
      verifying: depth.verifying,
      blocked,
      quarantined,
      active: running,
      workers,
      retries: retriesByTask,
      tokens: {
        used: Number(usageRow?.tokens ?? 0) || 0,
        ...this.db.prepare('SELECT usage FROM tq_tasks WHERE scope=? AND usage IS NOT NULL').all(this.runId).reduce((total,row) => { const usage=parseJson(row.usage,{});total.measuredTokens+=usage.measuredTokens||0;total.estimatedTokens+=usage.estimatedTokens||0;total.unknownCalls+=usage.unknownCalls||0;return total; }, { measuredTokens: 0, estimatedTokens: 0, unknownCalls: 0 }),
        promptTokens: Number(usageRow?.prompt ?? 0) || 0,
        completionTokens: Number(usageRow?.completion ?? 0) || 0,
        budgetCap: toSafeInt(this.#meta('tokenBudgetCap'), 0),
        exhausted: this.#budgetExhausted({ tokenBudget: 0, tokensUsed: 0 }),
      },
      timeouts: timedOut,
      caseInsensitive: this.caseInsensitive,
      cwd: this.cwd,
    };
  }

  /** 事件流（含取消/隔离证据）。 */
  events({ taskId, limit = 100 } = {}) {
    const rows = taskId
      ? this.db.prepare('SELECT * FROM tq_events WHERE scope=? AND task_id=? ORDER BY id DESC LIMIT ?').all(this.runId, taskId, limit)
      : this.db.prepare('SELECT * FROM tq_events WHERE scope=? ORDER BY id DESC LIMIT ?').all(this.runId, limit);
    return rows.map(r => ({ ...r, data: parseJson(r.data, null) }));
  }

  /** 任务的全部尝试记录（证据，不删除）。 */
  attempts(id, limit = 50) { this.#requireTask(id); return this.#attempts(id, limit); }

  /** 任务的全部检查点（证据，不删除）。 */
  checkpoints(id, limit = 50) { this.#requireTask(id); return this.#checkpoints(id, limit); }

  /** 续做提示：本次执行者应从哪里继续、还剩哪些未完成项。 */
  resumePlan(id) {
    const task = this.get(id);
    const cps = this.#checkpoints(id);
    const last = cps[0] ?? null;
    const done = new Set(cps.flatMap(c => c.filesDone));
    const donePaths = new Set([...done].map(file => normalizeArtifactPath(this.cwd,file,this.caseInsensitive)));
    return {
      taskId: task.id,
      attempt: task.attempts + 1,
      status: task.status,
      startFrom: last,
      completedItems: [...done],
      remainingFiles: task.files.filter(f => !donePaths.has(f)),
      openIssues: task.issues ?? [],
      note: task.attempts > 0 ? `第 ${task.attempts + 1} 次执行：从检查点续做，不要重做已完成项` : '首次执行',
    };
  }
}

function defaultIsProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // 进程存在但无权限发送信号 → 仍算存活（不能回收）。
    return e && e.code === 'EPERM';
  }
}

export default TaskQueue;
