// Hold the logical-session lock while the native ID is first created, then hold
// both locks for continuations. Different sessions/providers remain parallel.
export class Locks {
  tails = new Map();
  // Register a newly allocated native ID immediately, before subsequent calls
  // can observe it in persistence. Existing IDs use with() before dispatch.
  holdNew(key) {
    if (this.tails.has(key)) throw new Error('新分配的原生会话 ID 已有调用正在运行');
    let release; const gate = new Promise(r => { release = r; }); this.tails.set(key, gate);
    return () => { release(); if (this.tails.get(key) === gate) this.tails.delete(key); };
  }
  async with(key, fn) {
    const before = this.tails.get(key) || Promise.resolve();
    let release; const gate = new Promise(r => { release = r; });
    const tail = before.catch(() => {}).then(() => gate);
    this.tails.set(key, tail);
    await before.catch(() => {});
    try { return await fn(); }
    finally { release(); if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
}
