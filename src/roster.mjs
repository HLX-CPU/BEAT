// 在线名册与顶替：三方任何一个下线（限额/登录失效/起不来/网络），这一步立即由下一位接上，
// 并让它冷却一段时间（期间直接跳过）；冷却结束自动再试，成功即恢复。也可以在看板里手动暂停某一方。
import { claudeReady } from './claude.mjs';
import { AGENT, SYSTEM, NATIVE_SEATS } from './prompts.mjs';
import { Locks } from './locks.mjs';
import { readImage } from './attachments.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { fixedConversation, conversationKey } from './conversation.mjs';
import { findDeepseekSessionHome } from './native-runtime.mjs';
import { isDock, dockList, dockReady, dockEntry, dockKey } from './dock.mjs';

export const AGENTS = ['codex', 'deepseek', 'zcode', 'claude'];

// 电脑助手的停止原因在内部是状态码（STEP_LIMIT 等）。客户需要看到的是「发生了什么 + 下一步」，
// 状态码只放进括号里供排查；直接把它甩给客户等于让客户猜。
const DESKTOP_STOP = {
  STEP_LIMIT: ['这位搭档反复调用工具超过上限仍未收敛，已停止', '把目标拆小一点再试'],
  CALL_REPLAY: ['检测到重复调用同一个操作，按保护规则已停止', '确认上一次操作的结果后再重试'],
  FILE_TOO_LARGE: ['要读的文件太大，已停止', '先截取需要的那一段再试'],
  ISOLATED: ['上一次电脑操作的结果没有确认，为避免重复执行需要先核对', '在任务详情里核对已完成的步骤后继续'],
  TIMEOUT: ['这位搭档在限定时间内没有完成，已停止', '把目标拆小或稍后重试'],
  UNSUPPORTED: ['这台电脑上缺少完成该操作所需的工具，已停止', '换一位能操作电脑的搭档，或改用手工步骤'],
  FAILED: ['这位搭档没能完成操作，已停止', '看一眼任务详情里的步骤记录再重试'],
  UNVERIFIED: ['这位搭档报告完成，但没有可核验的证据，已停止', '改为要求它留下文件或用具名工具再试'],
};
export function desktopStopText(status) {
  const entry = DESKTOP_STOP[String(status || '').toUpperCase()];
  if (!entry) return { text: '这位搭档没能完成这次操作', next: '任务详情里保留了每一步记录；也可以把目标拆小一点重试' };
  return { text: entry[0], next: entry[1] };
}
// Claude 只在失败/受阻时担任顾问，常规讨论和执行由搭档接替。
function chainOf(role, seat, dock) {
  if (seat === 'advisor') return ['claude', ...dock, ...NATIVE_SEATS];
  if (seat === 'claude') return ['claude', ...dock];
  if (NATIVE_SEATS.includes(seat) || isDock(seat)) return [seat, ...[...NATIVE_SEATS, ...dock].filter(id => id !== seat)];
  return [seat];
}

// 原生会话被另一个进程占用：Codex 报 "already has an active writer"，
// DeepSeek 报 "already owned by an active write handle"。这是暂时的（通常是上一轮进程还没退干净），
// 必须原地等待重试，绝不能因此换人——换人只会让两个席位互相顶替，越顶越堵。
export const BUSY = /already has an active writer|already owned by an active write handle|active write handle|active writer/i;

// 沙箱策略在“创建会话”时固定的一方。目前的真实情况是 DeepSeek Harness：恢复已有会话不会改用新预设，
// 所以只读建起来的会话在执行阶段会被沙箱拒绝写文件（R77 实测 [sandbox: file access denied under read-only mode]）。
// 这一类搭档的可写角色必须使用另一条“创建时就是 workspace-write”的固定会话；其余搭档保持一条会话。
export const POLICY_PINNED_SESSIONS = new Set(['deepseek']);

// 名册与看板的排列顺序（买家 2026-10-15 指定）：**本地模型端在前，顾问居中，拓展坞模型始终最后**。
// 只影响展示顺序；候选/顶替链（chainOf）的兜底语义保持不变，避免悄悄改变谁能顶上谁。
export const partnerGroup = agent => agent === 'claude' ? 1 : isDock(agent) ? 2 : 0;

// 拓展坞 / Claude 这类 API 搭档没有原生会话：BEAT 每次都得自己把上下文发过去。
// 默认带上同一会话里已经发生过的往来（不再靠调用方传 referenceOnly 才带），否则每一步都是失忆的，
// 续问也接不上——控制器记账里明明有历史，模型却看不到。体积封顶，历史再长也不会无限涨。
export const API_HISTORY = Object.freeze({ messages: 12, chars: 8000, messageChars: 4000 });
export const API_HISTORY_TRUNCATED = '\n…（这一条过长，已截断）';
export function apiHistory(history = [], limits = API_HISTORY) {
  const out = []; let chars = 0;
  for (const message of [...(history || [])].reverse()) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    let content = String(message?.content ?? '').trim();
    if (!content) continue;
    if (content.length > limits.messageChars) content = content.slice(0, limits.messageChars) + API_HISTORY_TRUNCATED;
    if (out.length >= limits.messages || chars + content.length > limits.chars) break;
    out.push({ role, content }); chars += content.length;
  }
  return out.reverse();
}

const nativeDesktopNotDispatched = error => error?.notDispatched === true || error?.notStarted === true || error?.dispatched === false || error?.sideEffects === 'none' || error?.evidence?.sideEffects === 'none'
  || (error?.code === 'ENOENT' && (/^spawn/i.test(error?.syscall || '') || error?.spawnFailed === true))
  || /^(?:无法启动\s*(?:Codex|DeepSeek)|找不到\s*Codex)|\bspawn[^\r\n]*\bENOENT/i.test(String(error?.message || ''));

export function classifyFailure(text) {
  const kind = text?.failureKind;
  const permanent = { 'client-restricted': '服务商限制客户端', balance: '账户余额不足', auth: '登录/密钥异常', permission: '服务商权限不足' };
  if (permanent[kind]) return { reason: permanent[kind], down: true, requiresAction: true };
  if (kind === 'rate-limit') return { reason: '触发限额', down: true };
  if (kind === 'server') return { reason: '网络或超时', down: true };
  if (kind === 'account-pool') return { reason: '上游账号池暂无可用账号', down: true };
  const s = String(text?.message || text || '');
  if (BUSY.test(s)) return { reason: '原生会话被占用', down: false, busy: true };
  if (/上游账号池暂时没有可用账号|all available accounts exhausted/i.test(s)) return { reason: '上游账号池暂无可用账号', down: true };
  // 工具适配器可能只保留错误文本，仍须保留账户故障的处置语义。
  if (/限制为 Claude Code 专用|restricted to Claude Code clients|only allows Claude Code clients/i.test(s)) return { reason: '服务商限制客户端', down: true, requiresAction: true };
  if (/账户余额不足|INSUFFICIENT_BALANCE|insufficient (?:account )?balance/i.test(s)) return { reason: '账户余额不足', down: true, requiresAction: true };
  if (/服务商拒绝此账号访问/.test(s)) return { reason: '服务商权限不足', down: true, requiresAction: true };
  if (/密钥无效或已失效。请在此模型设置/.test(s)) return { reason: '登录/密钥异常', down: true, requiresAction: true };
  if (/usage limit|rate limit|too many requests|\b429\b|quota|limit reached|out of credits|额度|限额|超限|限流|欠费|capacity|overloaded/i.test(s)) return { reason: '触发限额', down: true };
  if (/\b401\b|\b403\b|unauthorized|not logged in|密钥无效|密钥被站点禁用|没有权限|not supported when using/i.test(s)) return { reason: '登录/密钥异常', down: true };
  if (/无法启动|ENOENT|找不到 Codex|未配置|没有配置密钥|地址不对/i.test(s)) return { reason: '无法启动', down: true };
  if (/超时|timeout|timed out|ECONNRESET|不可达|连不上|network|ENOTFOUND|\b50[234]\b|服务端故障|提前退出/i.test(s)) return { reason: '网络或超时', down: true };
  return { reason: '调用失败', down: false };
}

// F10：额度类失败的冷却不能短于提供方真正恢复的时间（实测 R326/R328：冷却约 10 分钟后自动重试，
// 各白烧一次约 12–15 万的整笔预留）。能读到提供方给的恢复时刻就用它，读不到至少等 60 分钟。
const quotaRetryAt = detail => {
  const text = String(detail || '');
  const m = /try again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(text);
  if (!m) return null;
  let hh = Number(m[1]);
  if (/pm/i.test(m[3] || '') && hh < 12) hh += 12;
  if (/am/i.test(m[3] || '') && hh === 12) hh = 0;
  const now = new Date(); const at = new Date(now); at.setHours(hh, Number(m[2]), 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
};

export class Roster {
  constructor({ config, store, agents }) { this.config = config; this.store = store; this.agents = agents; this.locks = new Locks();this.selectionSeed=randomUUID();this.migrateAdvisorHealth(); }
  // 升级前留下的顾问失败记录没有配置标识，无法判断还适不适用于现在的连接：丢掉重试一次
  // （失败会在新配置下重新记录），只保留客户手动「暂停」。否则客户升级后会一直看到顾问"离线"。
  migrateAdvisorHealth() {
    const h = this.health, entry = h.claude;
    if (!entry || entry.configKey) return;
    const next = { ...h };
    if (entry.paused) next.claude = { paused: true }; else delete next.claude;
    this.saveHealth(next);
  }
  get health() { return this.store.get('health') || {}; }
  saveHealth(h) { this.store.set('health', h); }
  // 失败记录绑定"当时的连接配置"：地址/模型/密钥/强度一变，旧结论就不该继续压着这一方。
  // 拓展坞按接入条目算，顾问按顾问连接算（两边同一套语义）。
  healthKey(agent) {
    if (agent === 'claude') {
      const c = this.config.claude || {};
      return createHash('sha256').update(JSON.stringify([c.baseUrl, c.model, c.protocol, c.reasoningConfig ?? null, c.defaultEffort ?? null, this.config.secrets?.claudeApiKey || ''])).digest('hex');
    }
    const d = dockEntry(this.config, agent);
    return d ? createHash('sha256').update(JSON.stringify([d.baseUrl, d.model, dockKey(this.config, agent)])).digest('hex') : null;
  }
  dockHealthKey(agent) { return this.healthKey(agent); }

  state(agent) {
    const saved = this.health[agent] || {};
    const h = saved.configKey && saved.configKey !== this.healthKey(agent) ? { paused: saved.paused } : saved;
    const down = h.until && new Date(h.until).getTime() > Date.now() ? { reason: h.reason, detail: h.detail, until: h.until } : null;
    // 只有真的注入了安装检测才按检测结果判定离线。检测钩子缺失＝这一方没有桌面端证据，
    // 不能说它"没有桌面端"（否则测试/集成注入的执行器会把原生搭档一直显示成未配置）。
    // 唯一例外是 ZCode：它需要客户显式启用，没有检测钩子时按配置门判定（与拓展坞的 enabled 同理），
    // 绝不能因为"没有证据"就默认在线——未启用的搭档被选中必然失败。
    const native = NATIVE_SEATS.includes(agent)
      ? (typeof this.agents.nativeAvailability === 'function' ? this.agents.nativeAvailability(agent)
        : agent === 'zcode' && this.config.zcode?.enabled !== true
          ? { available: false, enabled: false, reason: '已在看板设置里开启 ZCode 后即可加入协作（需要 ZCode 桌面端并完成一次登录）。' }
          : null)
      : null;
    if(native)native.capabilities=this.store.get('nativeCapability:'+agent)||null;
    const configured = agent === 'claude' ? claudeReady(this.config) : isDock(agent) ? dockReady(this.config, agent) : native ? native.available : true;
    const paused = !!h.paused;
    // 顾问在设置里关掉（启用=不勾选）：显示成已暂停，而不是"未配置"——客户自己关的要看得懂，
    // 也不该按坏账号冷却；candidates() 只看 online/cooldown，所以停用后不会被选去做顾问。
    const advisorDisabled = agent === 'claude' && this.config.claude?.enabled === false;
    const status = native && !native.available ? 'offline' : advisorDisabled ? 'paused' : !configured ? 'unconfigured' : paused ? 'paused' : h.requiresAction ? 'offline' : down ? 'cooldown' : 'online';
    // 顾问的连接信息随名册一起下发：卡片要像拓展坞一样显示型号/看图/强度，并给出 ⚙ 设置入口。
    const advisor = agent === 'claude' ? { name: this.config.claude?.name || AGENT.claude || 'Claude', baseUrl: this.config.claude?.baseUrl || '',
      model: this.config.claude?.model || '', enabled: !advisorDisabled, vision: this.config.claude?.vision !== false,
      defaultEffort: this.config.claude?.defaultEffort || null, reason: h.detail || null, failureReason: h.reason || null } : null;
    return { agent, status, paused: paused || advisorDisabled, configured, down, ...(native ? { native, reason: native.reason || null } : {}), ...(advisor ? { advisor } : {}), ...(isDock(agent) ? { name: AGENT[agent] || agent, dock: true, reason: h.detail || null, failureReason: h.reason || null, requiresAction: h.requiresAction === true, healthCheck: h.healthCheck || null } : {}) };
  }
  dockIds() { return dockList(this.config).filter(d => d.enabled !== false).map(d => d.id); }
  allAgents() { return [...AGENTS, ...dockList(this.config).map(d => d.id)]; }
  // 展示顺序（买家指定）：本地模型端在前（codex、deepseek 固定在前）→ 顾问居中 → 拓展坞始终最后。
  orderedAgents() {
    const list = this.allAgents(), native = [...NATIVE_SEATS];
    return [...list].sort((a, b) => {
      const g = partnerGroup(a) - partnerGroup(b);
      if (g) return g;
      if (partnerGroup(a) === 0) {
        const ia = native.indexOf(a), ib = native.indexOf(b);
        if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      }
      return list.indexOf(a) - list.indexOf(b);
    });
  }
  status() { return Object.fromEntries(this.orderedAgents().map(a => [a, this.state(a)])); }
  // 下一步会实际由谁来做（用于看板预告）
  pick(seat, role = 'think') { return this.candidates(seat, role)[0] || seat; }

  setPaused(agent, paused) {
    if (!this.allAgents().includes(agent)) throw new Error('没有这一方：' + agent);
    const h = this.health;
    h[agent] = paused ? { ...(h[agent] || {}), paused: true } : {};
    this.saveHealth(h);
    this.store.event(null, 'agent', `${AGENT[agent] || agent} ${paused ? '已手动暂停（由其他方顶上）' : '已恢复'}`);
    return this.status();
  }
  markDown(agent, runId, reason, detail, { requiresAction = false } = {}) {
    const h = this.health;
    const base = (this.config.flow.cooldownMin || 30) * 60000;
    const quota = reason === '触发限额';
    const hint = quota ? quotaRetryAt(detail) : null;
    const waitMs = hint ? Math.max(base, hint - Date.now() + 120000) : quota ? Math.max(base, 3600000) : base;
    const until = requiresAction ? null : new Date(Date.now() + waitMs).toISOString();
    h[agent] = { ...(h[agent] || {}), reason, detail: String(detail).slice(0, 300), since: new Date().toISOString(), until, requiresAction, ...(isDock(agent) || agent === 'claude' ? { configKey: this.healthKey(agent) } : {}) };
    this.saveHealth(h);
    this.store.event(runId, 'agent', `⚠ ${AGENT[agent]} ${reason}，${requiresAction ? '请处理账户问题后点击测试，停止自动重试' : `${Math.round(waitMs / 60000)} 分钟内由其他方顶上`}`);
  }
  markUp(agent, runId) {
    const h = this.health;
    if (!h[agent]?.until && !h[agent]?.requiresAction) return;
    h[agent] = { paused: h[agent].paused || undefined, healthCheck: h[agent].healthCheck };
    this.saveHealth(h);
    this.store.event(runId, 'agent', `${AGENT[agent]} 已恢复`);
  }

  recordDockTest(agent, result) {
    if (!isDock(agent) || !dockEntry(this.config, agent)) return;
    if (result.ok) this.markUp(agent, null);
    else {
      const failure = classifyFailure({ message: result.error, failureKind: result.failureKind });
      this.markDown(agent, null, failure.reason, result.error || '接口测试失败，请稍后重试', failure);
    }
    const h = this.health;
    h[agent] = { ...(h[agent] || {}), configKey: this.dockHealthKey(agent), healthCheck: { ok: result.ok === true, checkedAt: new Date().toISOString(), failureKind: result.failureKind || null, tools: result.tools || null } };
    this.saveHealth(h);
  }

  // 顺序：在线的优先；冷却中的放最后兜底（总比全部失败强）；暂停/未配置的不用。avoid 里的尽量往后排。
  candidates(seat, role, avoid = [], participants = null) {
    const docks = this.dockIds().filter(id => !participants || participants.includes(id));
    const chain = chainOf(role, seat, docks);
    // 指定负责人保留；其余搭档按本次服务的中性抽签顺序兜底，品牌与看板排列不产生优先级。
    if(seat!=='advisor'&&seat!=='claude')chain.splice(1,chain.length-1,...chain.slice(1).sort((a,b)=>createHash('sha256').update(this.selectionSeed+a).digest('hex').localeCompare(createHash('sha256').update(this.selectionSeed+b).digest('hex'))));
    chain.sort((a,b)=>avoid.includes(a)-avoid.includes(b));
    // 顾问（Claude）不以讨论参与者身份出现，但需要它本人裁决时必须能叫到它，
    // 否则候选会被 participants 过滤掉、由别人代答，裁决就永远"不是本人完成"（R150 实测）。
    const st = chain.filter(a=>!participants||participants.includes(a)||a==='claude').map(a => this.state(a)).filter(s => s.status === 'online' || s.status === 'cooldown');
    return [...st.filter(s => s.status === 'online'), ...st.filter(s => s.status === 'cooldown')].map(s => s.agent);
  }

  // 原生会话被占用时原地重试（退避等待对方进程释放写句柄）。
  async withBusyRetry(fn, { runId, agent, signal, waits = [3000, 8000, 20000, 30000, 45000] }) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (e.cancelled || signal?.aborted) throw e;
        if (!e.busy && !BUSY.test(e.message || '')) throw e;
        if (i >= waits.length) throw e;
        this.store.event(runId, 'agent', `${AGENT[agent]} 的原生会话正被另一个进程写入，${Math.round(waits[i] / 1000)} 秒后重试（第 ${i + 1} 次）`);
        await new Promise(r => setTimeout(r, waits[i]));
      }
    }
  }

  // sessions：本次协作/会话的原生会话表，key = `${slot}:${agent}`，调用方负责持久化。
  // efforts：各方本次的推理强度（null = 用该方自己的默认）。attachments：任务附件（图片只给每个原生会话发一次）。
  async call({ runId, sessionId, seat, slot = seat, role = 'think', avoid, participants, executionKey, build, sessions = {}, cwd, signal, timeoutMs, logFile, title, onSwitch, onProgress, onUsage, maxTokens, maxTotalTokens, onlyAgent = false, contextPolicy, referenceOnly = false, models = {}, requestedModel, modelSource, persist, efforts = {}, attachments = [], nativeAccess }) {
    // 恢复时可能因冷却优先选中了另一位搭档；未知原生"电脑输入"属于逻辑任务，不能只在旧 agent 会话里拦截。
    // 文件写入的中断/限额恢复按"先核对已落盘文件再补"继续（nativeWrite 只留审计证据，不挡后续步骤）。
    const uncertainNative = role === 'desktop' && this.config?.flow?.quarantineUnknown === true && Object.entries(sessions).find(([key, session]) => key.startsWith(slot + ':') && session?.nativeDesktop?.sideEffects === 'unknown');
    if (uncertainNative) {
      const e = new Error('DESKTOP_REPLAY_REQUIRES_REVIEW：该任务上次原生桌面输入的副作用未知，不能自动换搭档继续输入');
      e.code = 'DESKTOP_REPLAY_REQUIRES_REVIEW'; e.noFallback = true; e.desktopEvidence = uncertainNative[1].nativeDesktop; e.actualAgent = e.desktopEvidence.actualAgent; throw e;
    }
    const list = onlyAgent ? (this.state(seat).status === 'online' && !(avoid||[]).includes(seat) ? [seat] : []) : this.candidates(seat, role, avoid, participants);
    if (!list.length) {
      const status = this.state(seat).status, who = seat === 'advisor' ? '顾问' : AGENT[seat] || seat;
      const stateText = status === 'cooldown' ? '冷却中' : status === 'paused' ? '已暂停' : status === 'offline' ? '离线' : '未配置或不可用';
      // 冻结在固定搭档（onlyAgent）时失败原因通常是"它自己不可用"，不能笼统说成"其余各方均已暂停或未配置"。
      const error = new Error(onlyAgent && status !== 'online'
        ? `${who} 当前不可用（${stateText}）${this.state(seat).reason ? '：' + this.state(seat).reason : '，这一步没有可接替的搭档'}`
        : `${who}这一步没有可用的接替者（其余各方均已暂停或未配置）`);
      error.code = 'NO_SUCCESSOR'; error.seat = seat; error.agentStatus = status;
      throw error;
    }
    const errors = [], apiResponseFailures = []; let lastError;
    for (const [i, agent] of list.entries()) {
      if (i > 0) onSwitch?.(agent);
      const key = `${slot}:${agent}`;
      const prompt = build(agent);
      try {
        const r = await this.locks.with(`logical:${sessionId || runId}:conversation:${agent}`, async () => {
          const sess = sessions[key] || (sessions[key] = {});
          // 需要写权限的角色（执行/返工/电脑操作）在策略固定的搭档上必须走可写会话，否则沙箱会拒绝写入。
          const needsWrite = role === 'write' || role === 'desktop';
          const conversationPolicy = needsWrite && POLICY_PINNED_SESSIONS.has(agent) ? 'write' : undefined;
          const firstWritable = conversationPolicy === 'write' && !sessions[conversationKey(agent, 'write')];
          const readOnlyNative = sessions[conversationKey(agent)]?.native || null;
          const conversation=fixedConversation(sessions,agent,{id:sessionId||runId,cwd,policy:conversationPolicy});
          if (firstWritable && !conversation.native) this.store.event(runId, 'agent', `${AGENT[agent]||agent} 的执行需要可写沙箱：只读会话的权限在创建时已固定、无法切换，因此新建一条可写原生会话并在本任务内固定复用${readOnlyNative ? `（只读会话 ${readOnlyNative} 继续用于讨论与核验）` : ''}`);
          sess.native=conversation.native||sess.native;
          sess.history=conversation.history;
          sess.seenImages=conversation.seenImages;
          // DeepSeek 的固定原生会话和创建它的 DSH 根目录绑定。先按会话文件实际位置找，
          // 找不到再让适配器按当前环境解析；找到/解析到的 home 持久化在会话记录里，续用不受服务重启影响。
          let nativeHome = null;
          if (agent === 'deepseek') {
            nativeHome = conversation.deepseekHome || null;
            if (!nativeHome && conversation.native) {
              try { nativeHome = findDeepseekSessionHome(conversation.native, { config: this.config }); } catch { nativeHome = null; }
              if (nativeHome) { conversation.deepseekHome = nativeHome; persist?.(sessions); }
            }
          }
          const invoke = async () => {
            let nativeRelease, selectedModel;
            try {
            if (signal?.aborted) { const e = new Error('已取消'); e.cancelled = true; throw e; }
            const api = agent === 'claude' || isDock(agent);       // 只走 API 的一方：靠对话历史续问，不涉及原生会话/推理强度
            const model = isDock(agent) ? dockEntry(this.config, agent)?.model : api ? null : agent === seat && requestedModel ? requestedModel : conversation.model || sess.model || models[agent];
            selectedModel = model || null;
            if (!model && !api) { const e = new Error(agent + ' 默认模型无法解析'); e.modelError = true; throw e; }
            if(conversation.model&&model&&conversation.model!==model&&!(sessionId&&requestedModel&&agent===seat)){const e=Error('固定会话模型发生变化，拒绝静默替换模型');e.modelError=true;throw e;}
            conversation.model=model||null;
            sess.model = model || null; sess.modelSource = agent === seat ? modelSource || 'default' : sess.modelSource || 'default';
            persist?.(sessions);
            const effort = agent === 'claude' ? null : (efforts[agent] || (isDock(agent) ? dockEntry(this.config, agent)?.defaultEffort : null) || null);
            // API history may retain only text; each request must carry its current
            // images even when this path was sent during a previous review.
            const unseen = attachments.filter(a => a.image && (api || !(sess.seenImages || []).includes(a.path)));
            let result;
            if (api) {
              if (role === 'write' || role === 'desktop') {
                if (!isDock(agent) || !this.agents.desktopDock) throw new Error('桌面搭档执行接口未配置');
                try {
                  result = executionKey && sess.desktopExecutionKey === executionKey && sess.desktop?.status === 'succeeded' ? {...sess.desktop,executionReused:true,originalUsage:sess.desktop.usage,usage:null,budgetSpentTokens:0,history:conversation.history} : await this.agents.desktopDock(agent, { prompt, cwd, signal, runId, slot, effort, executionKey, maxTokens, maxTotalTokens, onUsage, attachments: unseen.map(a => a.path), conversationId:conversation.id,history:contextPolicy === 'references' ? [] : conversation.history,executionScope:'workspace', parallelPartner:true, previous: sess.desktop || null,
                    onProgress: progress => { sess.desktop = { ...(sess.desktop || {}), ...progress }; sess.desktopTaskId = progress.desktopTaskId || sess.desktopTaskId; persist?.(sessions); onProgress?.(progress); } });
                } catch (e) {
                  if (e.desktopTaskId || e.desktopEvidence) { sess.desktop = { ...(sess.desktop || {}), ...e.desktopEvidence, desktopTaskId: e.desktopTaskId || sess.desktopTaskId, status: e.desktopEvidence?.status || e.status || 'failed' }; sess.desktopTaskId = sess.desktop.desktopTaskId;if(e.desktopEvidence?.history?.length)conversation.history=e.desktopEvidence.history;persist?.(sessions); }
                  throw e;
                }
                sess.desktop = { ...result }; sess.desktopTaskId = result.desktopTaskId; sess.desktopExecutionKey = executionKey || null; persist?.(sessions);
                if (result.status !== 'succeeded') {
                  // 幂等/只读完成（例如"文件已存在且内容一致 → 保持不动"）本来就不会产生副作用，
                  // 助手因此报 unverified。只要没有任何调用留下未知副作用，就把结论交给控制器的逐项核验，
                  // 不在这里直接判失败——否则正确的"无需改动"会被反复重跑，最后烧光预算变成假失败（R82 实测）。
                  const calls = result.calls || [];
                  const unknownEffects = calls.some(c => c.evidence?.sideEffects === 'unknown');
                  const verifiedWork = calls.some(c => c.status === 'verified' && c.evidence);
                  if (result.status === 'unverified' && !unknownEffects && verifiedWork) {
                    result.assistantUnverified ||= '桌面搭档本次没有产生已验证的操作结果（只读完成或确认无需改动），交由逐项核验判定';
                  } else {
                    const stop = desktopStopText(result.status);
                    const extra = result.text && result.text !== result.status ? '。' + result.text : '';
                    const e = new Error(`桌面搭档未完成：${stop.text}${stop.next ? '；' + stop.next : ''}（原始状态：${result.status || 'unknown'}）${extra}`); e.desktopTaskId = result.desktopTaskId; e.desktopEvidence = result; e.noFallback = true; throw e;
                  }
                }
              } else {
                // 方案 A：只读调用（referenceOnly=false 且 role=think，即 BEAT 的独立核验）走电脑助手的只读通道。
                // 实测：整套工具 14,076 token/轮，精简只读工具 4,010 token/轮 → 每轮省 10,066；
                // 核验不需要写工具，而完整工具集会把每轮上下文撑到约 17.5K，导致核验中途预算耗尽（R324）。
                const assistantRead = agent !== 'claude' && !referenceOnly && (!sessionId || role === 'think') && this.agents.dockRead;
                const ask = agent === 'claude' ? this.agents.claude : assistantRead ? o => this.agents.dockRead(agent, o) : o => this.agents.dock(agent, o);
                // 习惯用「同一会话」：API 搭档永远带上自己在这一条固定会话里的上文（默认开，客户不用勾）。
                // 走电脑助手观察的那条路，上下文由助手自己的固定会话维持，不再重复喂一份。
                const history = assistantRead ? (contextPolicy === 'references' ? [] : conversation.history || []) : apiHistory(conversation.history);
                try {
                  result = await ask({ prompt, cwd, conversationId:conversation.id,system: SYSTEM, history, signal, role, effort, maxTokens, maxTotalTokens, onUsage, attachments: unseen.map(a => a.path), images: assistantRead ? [] : unseen.map(readImage) });
                } catch (error) {
                  if (unseen.length && /image|vision|multimodal|图片|图像/i.test(error.message || '')) {
                    error.imageInputDiagnostic = error.message;
                    if (!/^IMAGE_INPUT_/.test(error.code || '')) {
                      const rejected = /(?:unsupported|not supported|invalid).{0,30}(?:image|vision)|(?:image|vision).{0,30}(?:unsupported|not supported|invalid)|不支持.{0,10}(?:图片|图像)/i.test(error.message);
                      error.message = rejected ? '接口拒绝了本次图片输入：所选服务未接受这次图片格式或视觉请求。已有成果保留，请在搭档设置中核对图片输入，或选择其他支持图片的搭档后继续检查。' : '图片输入没有完成：当前接口未能接收或处理本次图片，不能据此判定模型没有视觉能力。已有成果保留，请点“继续”重新检查；持续失败时可在搭档设置中核对图片输入或选择其他支持图片的搭档。';
                      error.code = rejected ? 'IMAGE_INPUT_REJECTED' : 'IMAGE_INPUT_FAILED';
                    }
                    error.noFallback = true;
                  }
                  throw error;
                }
              }
              // 提供方（dock/claude）回给我们的是「它自己那份含上文的完整历史」，直接替换即可。
              // 以前 reference 模式是拿它跟本地历史拼接，同一轮会被记两次（实测 6→14→28 条），
              // 既让模型看到重复内容，也把上限额度浪费在重复上。
              conversation.history = result.history?.length
                ? result.history
                : [...(conversation.history || []), { role: 'user', content: prompt }, { role: 'assistant', content: result.text || '' }];
              sess.history = conversation.history;
            } else {
              if(role==='desktop'&&executionKey&&sess.nativeExecution?.executionKey===executionKey&&sess.nativeExecution.status==='succeeded')return {...sess.nativeExecution.result,executionReused:true,originalUsage:sess.nativeExecution.result.usage,usage:null,budgetSpentTokens:0};
              if (role === 'desktop' && sess.nativeDesktop?.sideEffects === 'unknown') {
                // 未核验的电脑输入始终阻止重放，包括旧配置关闭隔离的任务。
                {
                  const e = new Error('上次电脑操作的实际结果尚未核对，已保留记录，不能自动重做。请先查看实际结果，再由你决定是否继续。');
                  e.code = 'DESKTOP_REPLAY_REQUIRES_REVIEW'; e.noFallback = true; e.desktopEvidence = sess.nativeDesktop; throw e;
                }
              }
              try {
              // 打开/操作桌面软件这类任务，原生会话必须用该客户端自己的完整权限级别：
              // 沙箱（workspace-write）会挡住目标程序写自己的数据目录、起自己的进程（R127 实测：豆包起不来）。
              // 文件任务仍然留在 workspace-write，讨论/核验留在 read-only。
              // 执行者默认档位跟随客户设置（默认 danger-full-access = 管理员权限）；讨论与核验仍是 read-only。
              const configuredAccess = this.config?.flow?.executorAccess === 'danger-full-access' ? 'danger-full-access' : 'workspace-write';
              const nativeAccessLevel = nativeAccess || (role === 'write' || role === 'desktop' ? configuredAccess : 'read-only');
              const previousAccess = conversation.access || (role === 'write' || role === 'desktop' ? this.store.get?.('controlConfig:' + runId)?.executorAccess : null);
              if (agent === 'deepseek' && conversation.native && nativeAccessLevel === 'workspace-write' && previousAccess === 'danger-full-access') {
                throw Object.assign(new Error('这条旧会话创建时拥有完全访问权限，无法在原会话内可靠收回。旧会话与已有文件已保留；请新建受限任务继续，BEAT不会借旧权限执行。'), { code: 'NATIVE_PERMISSION_REVOKED', noFallback: true, notDispatched: true });
              }
              // 反过来升级也做不到：DSH 原生会话的沙箱档位在创建时固定。客户把默认权限改到完全访问后，
              // 旧的可写会话仍会按旧沙箱拒绝写用户目录（R419 实测）。这里新建一条完全访问会话，旧会话历史保留。
              if (agent === 'deepseek' && conversation.native && nativeAccessLevel === 'danger-full-access'
                  && (conversation.access || previousAccess) && (conversation.access || previousAccess) !== 'danger-full-access') {
                this.store.event?.(runId, 'agent', `${AGENT[agent]||agent} 原来的可写会话创建于受限沙箱，无法原地升级；按「执行者完全访问」设置新建一条完全访问会话（旧会话历史保留）`);
                conversation.native = null;
                sess.native = null;
              }
              conversation.access = nativeAccessLevel;
              if (typeof this.agents[agent] !== 'function') throw Object.assign(new Error(`${AGENT[agent] || agent} 没有注册执行器，无法调用`), { notDispatched: true });
              const invokeNative = nativeId => this.agents[agent]({ prompt, model, effort, images: ['codex', 'zcode'].includes(agent) ? unseen.map(a => a.path) : [], cwd, access: nativeAccessLevel, nativeId, nativeHome, signal, timeoutMs, logFile, title, role, maxTokens, onUsage, onProgress,
                onNative: id => {
                  if (conversation.native && conversation.native !== id) { const e = new Error('续问返回了不同的原生 ID，拒绝用新空会话替代'); e.modelError = true; throw e; }
                  if (!conversation.native) { nativeRelease = this.locks.holdNew(`native:${agent}:${id}`); conversation.native=id;sess.native = id; persist?.(sessions); }
                } });
              try {
                result = await invokeNative(conversation.native ?? undefined);
              } catch (e) {
                // 会话文件确实找不到了：CLI 在查找阶段就退出，没有执行任何工具。清理失效会话，
                // 用新会话继续（记录事件，不静默把任务卡死）；任务历史、文件和检查点全部保留。
                if (e?.code !== 'NATIVE_SESSION_MISSING' || !conversation.native || e.cancelled) throw e;
                const lost = conversation.native;
                this.store.event(runId, 'agent', `${AGENT[agent]||agent} 原来的会话在本机找不到了（${lost}；可能换了登录目录或会话被清理）。任务、历史和已写文件都保留，改用新会话继续，不重复已完成的操作`);
                conversation.native = null; sess.native = null; persist?.(sessions);
                result = await invokeNative(undefined);
              }
              } catch (e) {
                // 原生电脑输入没有逐工具证据：出错后可能已经按键或发送消息，保留"副作用未知"，
                // 不换人、不自动重放，后续桌面动作要人工核对。
                // 原生文件写入不同：产物有文件哈希和检查点，中断/限额恢复按"先核对已落盘文件再补未完成部分"继续，
                // 不能用一次取消或限额把客户永久卡在"上次操作未确认"上（最高指令：失败必须有出口）。
                if ((role === 'desktop' || role === 'write') && !BUSY.test(e.message || '') && !nativeDesktopNotDispatched(e)) {
                  const failure = { status: e.cancelled || signal?.aborted ? 'cancelled' : 'unverified', source: role === 'desktop' ? 'native-desktop' : 'native-workspace', sideEffects: 'unknown',
                    actualAgent: agent, nativeId: sess.native || null, executionKey: executionKey || null, error: String(e.message || '').slice(0, 1000) };
                  if (role === 'desktop') sess.nativeDesktop = failure; else sess.nativeWrite = failure;
                  persist?.(sessions); onProgress?.(role === 'desktop' ? { desktopEvidence: failure, status: failure.status } : { nativeWriteEvidence: failure, status: failure.status });
                  e.noFallback = true; e.desktopEvidence = failure;
                  const failureReason = classifyFailure(e);
                  if (failureReason.down && !e.cancelled && !signal?.aborted && !e.downMarked) { e.downMarked = true; this.markDown(agent, runId, failureReason.reason, e.message, failureReason); }
                }
                throw e;
              }
              // Native actors use their own tool receipts, never the dock
              // assistant's context database as a proxy for execution.
              if (role === 'desktop') {
                const receipt = result.nativeToolEvidence;
                if (receipt?.verification?.status !== 'verified') {
                  sess.nativeDesktop = { source: 'native-desktop', status: 'unverified', sideEffects: receipt?.calls?.length ? 'unknown' : 'none', nativeId: result.nativeId || sess.native, actualAgent: agent, nativeToolEvidence: receipt || null };
                  persist?.(sessions);
                  const e = Error('原生工具已返回，但电脑操作结果尚未独立核验；已保留记录，不自动重放'); e.desktopEvidence = sess.nativeDesktop; e.noFallback = true; throw e;
                }
                result.desktopEvidence = receipt;
              }
              if (agent === 'deepseek' && result.nativeHome && conversation.deepseekHome !== result.nativeHome) { conversation.deepseekHome = result.nativeHome; persist?.(sessions); }
              if (conversation.native && result.nativeId && conversation.native !== result.nativeId) { const e = new Error('续问返回了不同的原生 ID，拒绝用新空会话替代'); e.modelError = true; throw e; }
              if (result.nativeId) {sess.native = result.nativeId;conversation.native=result.nativeId;}
            }
            if (unseen.length) sess.seenImages = [...new Set([...(sess.seenImages || []), ...unseen.map(a => a.path)])];
            conversation.seenImages=sess.seenImages||[];
            if (effort || result.effort) sess.effort = result.effort || effort;
            persist?.(sessions);
            onUsage?.(result.usage);
            const verified = result.modelVerified === 'verified' && !!result.actualModel && !!result.modelEvidence;
            if (!api && verified && result.actualModel !== model) { const e = new Error(`模型不匹配：请求 ${model}，实际 ${result.actualModel}`); e.modelError = true; e.actualModel = result.actualModel; throw e; }
            const delivered={ ...result, history:undefined,conversationId:conversation.id,effort: result.effort || effort, requestedModel: model || null, actualModel: verified ? result.actualModel : null, modelVerified: verified ? 'verified' : 'unknown' };
            if(!api&&role==='desktop'&&executionKey&&result.desktopEvidence){sess.nativeExecution={executionKey,status:'succeeded',result:delivered};persist?.(sessions);}
            return delivered;
            } catch (e) { if(e.desktopEvidence?.history?.length){conversation.history=e.desktopEvidence.history;const {history,...evidence}=e.desktopEvidence;e.desktopEvidence=evidence;persist?.(sessions);}e.requestedModel = selectedModel; throw e; }
            finally { nativeRelease?.(); }
          };
          // 进程内互斥之外，原生会话可能仍被上一次调用的进程（例如在桌面端打开过的会话）占着写句柄；
          // 这里在真正发起前按占用情况退避重试，避免把并发冲突误判成「这一方不行」而换人。
          const run = () => (conversation.native ? this.locks.with(`native:${agent}:${conversation.native}`, invoke) : invoke());
          return this.withBusyRetry(run, { runId, agent, signal, waits: [2500, 6000, 15000, 30000] });
        });
        this.markUp(agent, runId);
        if (r.modelVerified === 'verified' && r.actualModel) this.store.set('verifiedModels:' + agent, [...new Set([...(this.store.get('verifiedModels:' + agent) || []), r.actualModel])]);
        return { ...r, by: agent, prompt, errors, ...(apiResponseFailures.length ? { apiResponseFailures } : {}) };
      } catch (e) {
        e.actualAgent = agent;
        lastError = e;
        if (e.apiResponseEvidence) apiResponseFailures.push({ agent, error: String(e.message || '').slice(0, 1000), apiResponseEvidence: e.apiResponseEvidence });
        if (e.cancelled || signal?.aborted) throw e;
        if (e.busy || BUSY.test(e.message || '')) {
          // The account is available; only this fixed native thread is occupied.
          // Preserve its identity and let the controller wait without fallback.
          e.busy = true; e.noFallback = true;
          this.store.event(runId, 'agent', `${AGENT[agent]} 的原会话仍被占用，保留进度等待空闲，不更换搭档`);
          throw e;
        }
        const c = classifyFailure(e);
        // 记录接口账户故障不重放电脑动作；适配器的副作用隔离继续保留。
        if (c.requiresAction) { e.downMarked = true; this.markDown(agent, runId, c.reason, e.message, c); }
        // 电脑助手执行通道的提供方故障（账号池/限额/网络）也要先标记冷却，再走“禁止重放”分支：
        // 旧顺序在 e.noFallback/desktopEvidence 处先 throw，账号池故障从未 markDown，
        // 队列会在 1 秒内连续重试同一家（R408 实测），白烧调用、还挡住了换人。
        // 只对带执行/桌面证据的通道生效，讨论阶段的普通超时仍按原逻辑交给控制器重试/恢复。
        else if (c.down && (e.desktopTaskId || e.desktopEvidence) && !e.cancelled && !signal?.aborted && !e.downMarked) { e.downMarked = true; this.markDown(agent, runId, c.reason, e.message, c); }
        // 桌面操作可能已发生，不能换一个模型自动重放相同输入。保留证据，交给评估和顾问。
        if (e.noFallback || e.desktopTaskId || e.desktopEvidence || e.code === 'DESKTOP_REPLAY_REQUIRES_REVIEW') throw e;
        if (e.modelError || /model.*(invalid|unknown|not found|unsupported|not supported)|invalid.*model|模型.*(无效|不存在|不匹配|未配置)/i.test(e.message)) throw e;
        if (c.down) { if (!c.requiresAction && !e.downMarked) { e.downMarked = true; this.markDown(agent, runId, c.reason, e.message, c); } }
        else this.store.event(runId, 'agent', `${AGENT[agent]} 这一步失败（${e.message.slice(0, 80)}）${onlyAgent?'，已保留固定搭档的失败与用量证据，不代其批准':'，换下一位'}`);
        if(onlyAgent)throw e;
        errors.push(`${AGENT[agent]}：${e.message}`);
      }
    }
    const e = new Error('各方都没能完成这一步：\n' + errors.join('\n'));
    e.actualAgent = lastError?.actualAgent; e.requestedModel = lastError?.requestedModel;
    if (apiResponseFailures.length) { e.apiResponseFailures = apiResponseFailures; e.apiResponseEvidence = apiResponseFailures.at(-1).apiResponseEvidence; }
    throw e;
  }
}
