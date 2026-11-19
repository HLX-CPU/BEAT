// DeepSeek 桌面端插件（由 setup 写入桌面端 patch，桌面端启动时加载）：
// 提供 /api/beat/register-history，BEAT 在后台跑完 headless 后调用它，桌面端会话列表立即出现/更新该会话，无需重启。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const name = 'beat-desktop-history';
export const inject = ['connection', 'workspaceRegistry', 'sessionQuery', 'sessionPersistence', 'sessionProjections', 'sessionProjectionCache', 'sessions', 'sessionController'];

const within = (root, p) => { const rel = path.relative(root, p); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };

// 会话列表行的“刚刚 / N 分钟”是渲染时用一次 Date.now() 算出来的（侧栏没有时钟），
// 只有 api-session/activity(sessionId, updatedAt) 会推进它，且要求新值更大。
export async function registerNativeHistory(ctx, sessions, allowedRoots) {
  if (!Array.isArray(sessions) || sessions.length < 1 || sessions.length > 50) throw new Error('会话登记数量必须为 1 至 50');
  const roots = await Promise.all(allowedRoots.map(p => fs.realpath(p).catch(() => path.resolve(p))));
  const receipts = [];
  for (const input of sessions) {
    if (!/^session-[a-f0-9-]{36}$/i.test(input.native_id || '')) throw new Error('原生会话 ID 无效');
    const cwd = await fs.realpath(input.cwd);
    if (!roots.some(r => within(r, cwd))) throw new Error('会话目录不在 BEAT 允许的工作区内');
    const observed = await ctx.sessionQuery.observeSession(input.native_id);
    try {
      // 只折叠持久化事件；桌面端缓存不会监视另一个 Host 写入的检查点，所以这里主动重建投影。
      const handle = await ctx.sessionPersistence.open(input.native_id, 'read');
      let header, inheritedEventCount, read;
      try {
        header = handle.header; inheritedEventCount = handle.inheritedEventCount;
        if (header.id !== input.native_id || await fs.realpath(header.cwd) !== cwd) throw new Error('会话身份与登记目录不一致');
        read = await handle.read(0);
      } finally { await handle.close(); }
      const restored = ctx.sessionProjections.restore({}, read.events, 0, header, inheritedEventCount);
      await ctx.sessionProjectionCache.put(input.native_id, { formatVersion: header.version, createdAt: header.createdAt, cwd: header.cwd, isSeeded: header.isSeeded, inheritedEventCount }, restored.checkpoint);
      const title = path.basename(cwd) === 'shared' ? 'BEAT 后台协作' : 'BEAT · ' + path.basename(cwd) + ' · ' + createHash('sha256').update(cwd).digest('hex').slice(0, 6);
      const workspace = await ctx.workspaceRegistry.create(cwd, title);
      await workspace.attachSession(input.native_id);
      // 会话列表的行只有在收到事件时才会重画；added 让新会话出现，activity 才会推进那一行的时间。
      if (!ctx.sessions.get(input.native_id)) ctx.emit('api-session/added', ctx.sessionController.listState.summarizeCold(header));
      ctx.emit('api-session/activity', input.native_id, Date.now());
      if (input.running === true) ctx.emit('api-session/status', input.native_id, true);
      else if (input.running === false) ctx.emit('api-session/status', input.native_id, false);
      receipts.push({ native_id: input.native_id, workspace_title: workspace.title, session_title: restored.snapshot.values.title ?? null,
        activity_at: Date.now(), running: input.running ?? null });
    } finally { observed[Symbol.dispose](); }
  }
  return receipts;
}

export function apply(ctx, config) {
  // connection 会先做它自己的 cookie 与 Host/Origin 校验，再分发到这里。
  ctx.connection.fetch.register({
    path: '/api/beat/register-history', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const input = await request.json();
        return Response.json({ ok: true, receipts: await registerNativeHistory(ctx, input.sessions, config.allowedRoots || []) });
      } catch (e) { return Response.json({ ok: false, error: e.message }, { status: 400 }); }
    },
  });
}
