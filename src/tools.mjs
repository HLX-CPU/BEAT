import { installDesktop } from '../workspaces/shared/desktop-assistant/integration/runtime.mjs';
import { chatDock } from './dock.mjs';
// 工具表：MCP（Codex / DeepSeek 桌面端里用）、命令行、看板都调用同一组工具。mcp:false 的只给看板/命令行。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { saveSettings, maskKey, VERSION, codexExecutable, loadConfig, CONTROL_FLOW_LIMITS } from './config.mjs';
import { DOCK_PRESETS, dockView, dockKey, dockLabel, listDockModels, saveDockEntry, removeDockEntry, moveDockEntry, setDockField, testDock, isDock, dockEntry, dockReasoning, reasoningChoices, validateDockEffort } from './dock.mjs';
import { testClaude, resetClaudePreflight, claudeReasoning, claudeEnabled } from './claude.mjs';
import { normalizeDockReasoning, effortParameters } from './dock-reasoning.mjs';
import { deepseekProfileFor } from './deepseek.mjs';
import { askZcode, parseModelSelection } from './zcode.mjs';
import { modelId, resolveDefault } from './models.mjs';
import { resolveOpenable, openWithDefaultApp } from './reveal.mjs';
import { usageSummary } from './control-budget.mjs';
import { LocalDeepSeekController, normalizeLocalControllerConfig, resolveController, controllerLabel, buildControllerFor } from './local-controller.mjs';
import { customerIssue } from './customer-issue.mjs';
import { proxyStatus, proxyDownMessage } from './network-guard.mjs';
import { currentProxyStatus } from './system-proxy.mjs';
import { visualReviewReadiness } from './visual-reviewer.mjs';
import { previewTask } from './task-intent.mjs';
import { scanStorage, cleanupStorage } from './storage-lifecycle.mjs';
import { rollbackRunCheckpoint, readCheckpoint, checkpointSummary } from './checkpoint.mjs';
import { availabilityOf } from './availability.mjs';


const runTokens = (o, id) => usageSummary(o.store.get('controlMetrics:' + id))?.totalTokens ?? null;
// 用量报表：接口不返回金额与上游配额，但至少要让客户查得到“用了多少、上限是多少、花在谁身上”。
export function usageReport(o, { hours = 24, id = '' } = {}) {
  const hoursValue = Math.max(1, Math.min(720, Number(hours) || 24));
  const span = hoursValue * 3600000, now = Date.now();
  const rows = [];
  for (const run of o.store.runs(500)) {
    const at = Date.parse(run.created_at || run.createdAt || '');
    if (!Number.isFinite(at) || at < now - span) continue;
    rows.push({ id: run.id, kind: run.kind, state: run.state, target: run.target || null, tokens: runTokens(o, run.id), created_at: run.created_at || run.createdAt || null });
  }
  const totalTokens = rows.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0);
  const byTarget = {};
  for (const row of rows) {
    const key = row.target || row.kind;
    byTarget[key] = (byTarget[key] || 0) + (Number(row.tokens) || 0);
  }
  const limits = {};
  for (const key of ['askTokenBudget', 'discussionTokenBudget', 'executionTokenBudget', 'taskTokenBudget']) {
    const value = Number(o.config?.flow?.[key]);
    if (Number.isFinite(value) && value > 0) limits[key] = value;
  }
  let detail = null;
  if (id) {
    const metrics = o.store.get('controlMetrics:' + id) || null;
    detail = { id, tokens: runTokens(o, id), phases: metrics?.phases || null, records: (metrics?.records || []).slice(-20).map(record => ({ seat: record.seat, tokens: record.tokens, ms: record.ms, phase: record.phase })) };
  }
  return { service: 'beat', windowHours: hoursValue, runs: rows.length, totalTokens, byTarget, limits,
    cost: null, costNote: '接口只返回 token，不返回金额；实际费用以提供方账单为准。', providerQuota: 'unknown', detail };
}
const HELP = {
  ask: 'beat_ask：一句话提问/办事；续问传 session_id；执行类目标会自动识别并留下产物。',
  discuss: 'beat_discuss：多搭档讨论一个难题；只读，不执行任务。',
  parallel: 'beat_parallel：可拆分的交付任务；先协商分工，再逐项执行和独立验收。',
  usage: 'beat_usage：查最近 token 用量、本机预算上限与逐任务明细。',
  confirm: 'beat_confirm：高风险目标（资金/不可逆/凭据/外发）需用任务详情里的确认码确认后才执行。',
  resume: 'beat_resume：任务等待补充信息或中断时继续；有未知副作用时先核对再继续。',
  get: 'beat_get：看任务进度、每一步、验收结论；finished=true 才算结束。',
};
export function helpText(topic = '') {
  const key = String(topic || '').trim().toLowerCase();
  return { service: 'beat', version: VERSION, quickStart: ['不确定用哪个：先 beat_ask', '要多个方案：beat_discuss', '要交付文件：beat_parallel'],
    topics: key ? (HELP[key] ? { [key]: HELP[key] } : {}) : HELP,
    next: key && !HELP[key] ? '没有这个主题；可用：' + Object.keys(HELP).join('、') : '任务在等待确认时用 beat_confirm；中断时用 beat_resume。' };
}
// 全历史搜索/列表片段：内部审计与附件路径只显示占位，不把真实路径交给客户。
const redactInternal = value => String(value || '').replace(/[^\s]*[\\/]\.beat-(?:control|attachments)[^\s]*/gi, '[内部文件]').replace(/\.beat-(?:control|attachments)[^\s]*/gi, '[内部文件]');
export async function validateRequestedPartnerModel(o, to, model) {
  if (model === undefined) return;
  modelId(model);
  if (isDock(to) || to === 'claude') {
    const configured = isDock(to) ? dockEntry(o.config, to)?.model : o.config.claude?.model;
    if (!configured || configured !== model) throw new Error('指定型号与所选搭档当前型号不同，请选择使用该型号的搭档；本次任务未派发');
    return;
  }
  await o.models.validate(to, model);
}
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = description => ({ type: 'number', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const initiator = str('发起方：codex / deepseek / zcode。不填用调用者或看板默认。各搭档同轮并发提纲；发起方负责最终结论与整体结果', { enum: ['codex', 'deepseek', 'zcode'] });
const wait = { type: 'number', description: '最多等待秒数（默认 0 立即返回，上限 280），没结束就用 beat_get 继续等', minimum: 0, maximum: 280 };
const attachments = { type: 'array', items: { type: 'string' }, description: '附件：本机文件的绝对路径（图片/文档等），或看板上传返回的上传号 F-…。最多 20 个，单个 ≤50MB。会复制进工作目录，Codex 能直接看图，DeepSeek 用文件工具读取' };
const effortOf = who => str(`${who} 推理强度（不填用默认）。Codex：low/medium/high/xhigh/max/ultra（以所选模型支持的为准）；DeepSeek：off/low/high/max`);
// 推理强度按所选模型实际支持的值校验
async function checkEfforts(o, pairs) {
  for (const [provider, effort, model] of pairs) if (effort) {if(isDock(provider))validateDockEffort(o.config,provider,effort);else await o.models.validateEffort(provider, model, effort);}
}
const dockEfforts={type:'object',additionalProperties:{type:'string'},description:'本次拓展坞推理强度，key 为 dock:id，值须来自 dock_reasoning 支持列表'};
function checkedDockEfforts(values={}) {if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(id=>!isDock(id)))throw Error('dock_efforts 的 key 必须是 dock:id');return Object.entries(values);}
const reasoningConfig={type:['object','null'],properties:{protocol:str('推理参数协议'),models:{type:'array',items:{type:'string'}},levels:{type:'array',items:{type:'string'}},source:str('参数支持文档地址')},additionalProperties:false};

export const TOOLS = {
  task_preview: { mcp: false,
    schema: obj({ question: str('需求'), mode: str('操作方式', { enum: ['auto','read-only','workspace-write','discuss','parallel'] }), session_id: str('已有会话'), to: str('所选搭档') }, ['question']),
    run: (_o, a) => previewTask(a),
  },
  workspace_access_grant: {
    mcp:false,
    schema:obj({requestId:str('待授权请求'),decision:str('本次、以后或取消',{enum:['once','always','cancel']})},['requestId','decision']),
    run:(_o,a,_actor,svc)=>svc.workspaceAccessGrant(a),
  },
  inspect_run_files:{mcp:false,schema:obj({id:str('任务号')},['id']),run:(o,a,_actor,svc)=>{
    if(!svc?.workspaceHuman)throw new Error('请在看板中点击查看现有文件。');
    const r=o.store.run(a.id);if(!r)throw new Error('没有找到这个任务。');
    const real=fs.realpathSync(r.cwd);if(path.resolve(real).toLowerCase()!==path.resolve(r.cwd).toLowerCase())throw new Error('文件夹位置已变化，请重新选择。');
    if(!fs.statSync(real).isDirectory())throw new Error('没有找到任务文件夹。');
    return openWithDefaultApp(real,{isDirectory:true,reveal:true});
  }},
  // 看板专用：本地存储占用与清理。清理只删旧缓存/旧上传副本，任务成果、数据库和设置不动。
  // 看板专用：撤销某个任务留下的文件改动。只恢复检查点里有备份且任务后没再被改过的文件。
  run_rollback: {
    mcp: false,
    schema: obj({ id: str('任务号'), paths: { type: 'array', items: { type: 'string' }, description: '只撤销这些文件；不填撤销全部' }, dryRun: { type: 'boolean', description: '只预览会恢复哪些文件，不写入' } }, ['id']),
    run: (o, a, _actor, svc) => {
      if (!svc?.workspaceHuman) throw new Error('请在看板中点击撤销；模型不能自行回滚客户文件。');
      const result = rollbackRunCheckpoint({ config: o.config, runId: a.id, paths: a.paths, dryRun: a.dryRun === true });
      const meta = readCheckpoint(o.config, a.id);
      if (meta && !a.dryRun) o.store.set('checkpoint:' + a.id, checkpointSummary(meta));
      return result;
    },
  },
  // 看板专用：打开本地数据文件夹（报告、日志、上传缓存、检查点都在这里）。
  open_data_folder: {
    mcp: false, schema: obj({}),
    run: (o, a, _actor, svc) => {
      if (!svc?.workspaceHuman) throw new Error('请在看板中点击打开数据文件夹。');
      return openWithDefaultApp(o.config.dataDir, { isDirectory: true, reveal: true });
    },
  },
  storage_report: {
    mcp: false, schema: obj({}),
    run: o => scanStorage(o.config),
  },
  storage_cleanup: {
    mcp: false, schema: obj({ dryRun: { type: 'boolean', description: '只预览可释放多少，不删除' } }),
    run: (o, a) => cleanupStorage(o.config, { dryRun: a.dryRun === true, includeCheckpoints: true }),
  },
  beat_discuss: {
    mcp: true,
    description: '难题讨论：搭档并行短提纲，代码锁定共识，仅短辩分歧；3/4多数或一次裁决，严重安全反对单独解决。只展开一份方案，其他人短评审；最多3轮辩论，停滞或预算上限及时裁决。各阶段可独立开关。立即返回任务号，用 beat_get 跟进。',
    schema: obj({ question: str('要讨论的问题，含背景、约束、已知信息'), initiator, cwd: str('可供参考的项目目录（须在允许范围内）'), max_turns: num('多方讨论最多发言次数，默认 6；至少允许每位搭档表态一次'),
      attachments, codex_effort: effortOf('Codex'), deepseek_effort: effortOf('DeepSeek'), dock_efforts: dockEfforts, wait_seconds: wait }, ['question']),
    run: async (o, a, actor) => {
      await checkEfforts(o, [['codex', a.codex_effort], ['deepseek', a.deepseek_effort],...checkedDockEfforts(a.dock_efforts)]);
      const r = o.startDiscuss({ ...a, source: actor, efforts: { ...a.dock_efforts,codex: a.codex_effort, deepseek: a.deepseek_effort } });
      return a.wait_seconds ? o.waitFor(r.id, a.wait_seconds) : r;
    },
  },
  beat_parallel: {
    mcp: true,
    description: '并行任务：先短提纲收敛和短评审，再按依赖、文件范围、接口成本及预算拉取小任务。带心跳租约和检查点，产物按文件引用传递；每项立即由代码和非执行者核验，最多2次重试后升级或停止。共享电脑动作互斥，未知副作用不重放，人工确认保留。同一（目标，工作目录）连续失败 2 次、或统计窗口内（默认 24 小时）失败达到上限（默认 3 次）时会拒绝新建；确认要重发同一目标请显式传 allowRepeat:true。立即返回任务号，用 beat_get 跟进。',
    schema: obj({ goal: str('完整的目标：需求、约束、怎样算完成'), initiator, cwd: str('工作目录（须在允许范围内），不填用默认共享目录'),
      max_rounds: num('执行+评估最多几轮，默认 3'), max_turns: num('多方讨论发言基数，默认 6；未共同批准不执行'),
      allowRepeat: { type: 'boolean', description: '显式确认重发同一目标（默认 false）。同一（目标，工作目录）连续失败 2 次、或窗口内失败达到上限时默认拒绝新建；确认要继续才传 true，会记入任务事件' },
      attachments, codex_effort: effortOf('Codex'), deepseek_effort: effortOf('DeepSeek'), dock_efforts: dockEfforts, wait_seconds: wait }, ['goal']),
    run: async (o, a, actor) => {
      await checkEfforts(o, [['codex', a.codex_effort], ['deepseek', a.deepseek_effort],...checkedDockEfforts(a.dock_efforts)]);
      const r = o.startParallel({ ...a, source: actor, efforts: { ...a.dock_efforts,codex: a.codex_effort, deepseek: a.deepseek_effort } });
      // 发起前检查：目标是视觉类交付、却没有能看图的独立搭档时，把后果先写进任务时间线
      // （看板在派发前也会弹一次同样的提示）。这不阻止发起、不改原有响应形状，
      // 只避免跑完才发现没人能核验（R365 实测）。
      try {
        const read = visualReviewReadiness({ config: o.config, agents: o.roster?.status?.() || {}, goal: a.goal });
        if (read?.visual && !read.ok) o.store?.event?.(r.id, 'run', '发起前提示：' + read.reason);
      } catch { /* 检查失败绝不影响发起 */ }
      if (a.wait_seconds) return o.waitFor(r.id, a.wait_seconds);
      const adjust = o.store?.get?.('maxRoundsAdjustment:' + r.id) || null;
      return adjust ? { ...r, maxRoundsAdjustment: adjust } : r;
    },
  },
  beat_ask: {
    mcp: true,
    description: '一句话提问或办事：默认自动识别明确的文件/应用操作请求，用受控工具执行并核验；普通问题只读并保留原问答接替机制。执行任务指定搭档不可用时如实报告、不自动换人重放。续问传 session_id；access=read-only 强制只提问，workspace-write 强制执行。Claude 只提供建议。同一句话（含相同附件）在 30 分钟内重复发给同一搭档会被拒绝，避免固定会话反复重读全部材料；要接着上一轮说请用 beat_followup 传任务号。',
    schema: obj({ to: str('codex | deepseek | claude，或拓展坞里的模型 ID（dock:…，用 dock_list 查看）'), question: str('完整的问题与必要背景'),
      session_id: str('续问时传上次的 session_id，如 S3'), model: str('可选，对应提供方模型 ID；已存在会话切换须验证保留上下文'), cwd: str('工作目录；桌面交付不需要填写'), access: str('auto（默认，识别明确请求）、read-only（只提问）或 workspace-write（执行）', { enum: ['auto', 'read-only', 'workspace-write'] }),
      effort: str('推理强度（不填用会话/默认设置）。拓展坞可选值由 dock_reasoning 查询；Claude 不支持'), attachments,
      allowRepeat: { type: 'boolean', description: '显式确认重发同一句（默认 false）。确认确实要重发才传 true：始终创建全新会话，原会话与历史保留；不绕过用量预算，会记入任务事件' },
      wait_seconds: num('最多等待秒数，默认 240，上限 280') }, ['to', 'question']),
    run: async (o, a, actor) => {
        await validateRequestedPartnerModel(o, a.to, a.model);
      if (a.effort) {
        const model = a.model || (a.session_id ? o.store.session(a.session_id).model : undefined);
        if(isDock(a.to))validateDockEffort(o.config,a.to,a.effort);else await o.models.validateEffort(a.to, model, a.effort);
      }
      const r = o.startAsk({ ...a, source: actor }); return o.waitFor(r.id, a.wait_seconds ?? 240);
    },
  },
  beat_get: {
    mcp: true,
    description: '查看任务进度与结果：每一步谁说了什么/做了什么、是否同意、分工、评估结论。finished=true 才是结束；并行任务 state=passed 才是评估通过。字段太多时用 fields 只取需要的部分。',
    schema: obj({ id: str('任务号，如 R12'), wait_seconds: wait, fields: { type: 'array', items: { type: 'string' }, description: '可选：只返回这些顶层字段（id 与 finished 始终返回），减少返回体积，例如 ["state","result","steps"]' } }, ['id']),
    run: async (o, a) => {
      const view = await o.waitFor(a.id, a.wait_seconds ?? 0);
      if (!Array.isArray(a.fields) || !a.fields.length) return view;
      const keep = new Set([...a.fields.map(String), 'id', 'finished']);
      return Object.fromEntries(Object.entries(view).filter(([key]) => keep.has(key)));
    },
  },
  beat_list: {
    mcp: true,
    description: '列出最近的任务。',
    schema: obj({ limit: num('条数，默认 15') }),
    run: (o, a) => o.store.runs(a.limit || 15).map(r => ({ id: r.id, kind: r.kind, state: r.state, initiator: r.initiator, target: r.target, rounds: r.rounds, session_id: r.session_id, goal: r.goal.slice(0, 80), tokens: runTokens(o, r.id), created_at: r.created_at })),
  },
  beat_cancel: {
    mcp: true,
    description: '取消任务（结束后台进程，已写的文件保留）。',
    schema: obj({ id: str('任务号') }, ['id']),
    run: (o, a) => o.cancel(a.id),
  },
  beat_release: {
    mcp: false,
    description: '人工解除被隔离的小任务（blocked，例如"执行者未确认退出且可能有未知副作用"）：确认已知改动后重新排队执行。放行会留痕（谁解的、原隔离原因）。',
    schema: obj({ id: str('任务号，如 R171'), task: str('小任务 ID，如 task-3'), note: str('可选：放行说明'), cli: { type: 'boolean', description: '命令行本人操作标记（仅本地 CLI 使用，看板不需要）' } }, ['id', 'task']),
    run: (o, a) => o.releaseTask(a.id, a.task, { note: a.note }),
  },
  beat_resume: {
    mcp: true,
    description: '任务等待补充信息时传 id 和 answer，保留原目标、附件和任务号继续。中断的讨论/并行任务保留已完成答复、分工与固定会话，只补失败部分；并行 failed 时追加1轮。一句话任务若仅最终核验未完成，继续只核验已落盘产物，不重复执行。',
    schema: obj({ id: str('任务号，如 R45'), answer: str('任务等待补充信息时填写答案，保留原任务继续') }, ['id']),
    run: (o, a) => o.resume(a.id, a.answer),
  },
  beat_discuss_adopt: {
    mcp: true,
    description: '讨论未通过时，采纳其中一个候选方案作为结论（不重跑、不执行文件操作）。结果会如实标注"未全票"，评审记录保留。候选编号用 beat_get 查看 discussionMetrics.candidates。',
    schema: obj({ id: str('讨论任务号，如 R477'), candidate_id: str('候选编号，如 candidate-3') }, ['id', 'candidate_id']),
    run: (o, a) => o.adoptDiscussionCandidate(a.id, a.candidate_id),
  },
  beat_confirm: {
    mcp: true,
    description: '确认高风险目标（资金/不可逆/凭据/外发）后继续执行。任务详情里会给出确认码；确认记录保留，未确认前不会调用模型或改文件。',
    schema: obj({ id: str('任务号，如 R45'), token: str('任务详情里给出的确认码') }, ['id', 'token']),
    run: (o, a) => o.confirmInputGuardrail(a.id, a.token),
  },
  repair_run_files: { mcp:false, schema:obj({id:str('任务号')},['id']),
    run:(o,a,_actor,svc)=>{if(!svc?.workspaceHuman)throw new Error('请在看板中点击补齐未完成的文件内容。');return o.resume(a.id,undefined,{repairFiles:true});},
  },
  beat_budget_continue: {
    mcp: false,
    description: '客户在看板查看本任务的新预算与费用后继续，保留已有结果。',
    schema: obj({ id: str('任务号'), offerHash: str('当前预算继续方案指纹') }, ['id', 'offerHash']),
    run: (o, a) => o.resumeWithBudget(a.id, a.offerHash),
  },
  beat_agents: {
    mcp: true,
    description: '查看搭档在线状态（online / cooldown 冷却中 / paused 已暂停 / unconfigured 未配置）；action=pause 手动让某一方下线（由其他方顶上），action=resume 恢复并清除冷却。也支持拓展坞（dock:…）：暂停后它不参与协作，也不会被直接提问。',
    schema: obj({ agent: str('搭档：codex / deepseek / claude / dock:id（拓展坞用 dock_list 查）'), action: str('动作：pause 或 resume', { enum: ['pause', 'resume'] }) }),
    run: (o, a) => {
      if (!a.agent || !a.action) return o.roster.status();
      if (!o.roster.allAgents().includes(a.agent)) throw new Error('没有找到你指定的搭档：' + a.agent + '。可用搭档见 beat_status（拓展坞 ID 形如 dock:f2fbcc9d）');
      return o.roster.setPaused(a.agent, a.action === 'pause');
    },
  },
  beat_status: {
    mcp: true,
    description: '服务状态：三方是否在线、正在运行和排队的任务。',
    schema: obj({}),
    run: o => status(o),
  },
  beat_usage: {
    mcp: true,
    description: '查看最近用量（token、任务数、按搭档），以及本机预算上限；接口不返回金额或上游剩余配额，实际费用以提供方账单为准。',
    schema: obj({ hours: num('最近小时数，默认 24（最大 720）'), id: str('可选任务号，查看逐阶段用量') }),
    run: (o, a) => usageReport(o, a),
  },
  beat_help: {
    mcp: true,
    description: '查看 BEAT 的接口速查：核心工具、下一步怎么走、常见限制。',
    schema: obj({ topic: str('可选主题：ask / discuss / parallel / usage / confirm / resume / get') }),
    run: (_o, a) => helpText(a.topic),
  },

  model_list: { mcp: true, description: '提供方可选模型与已有会话切换能力。列表存在不代表调用已验证。', schema: obj({ provider: str('codex | deepseek', { enum: ['codex', 'deepseek'] }) }, ['provider']), run: (o, a) => o.models.list(a.provider) },
  session_set_model: { mcp: true, description: '更改已有会话模型，从后续请求生效；未验证保留上下文能力时拒绝。', schema: obj({ session_id: str('会话 ID'), model: str('模型 ID') }, ['session_id', 'model']),
    run: async (o, a) => { const s = o.store.session(a.session_id); await o.models.validate(s.seat, a.model); return sessionView(o.setSessionModel(a.session_id, a.model)); } },
  beat_sessions: { mcp: true, description: '会话列表及同一快照的 revision。', schema: obj({ limit: num('1 至 1000，默认 100') }), run: (o, a) => o.store.sessions(a.limit ?? 100) },
  // 看板专用：按类型列出任务（默认把历史全部取回来），并给出总数——"最近任务（讨论/执行）"和"最近问答"分开显示用。
  run_index: {
    schema: obj({ kind: str('只看某一类：ask / discuss / parallel，留空表示全部'), limit: num('最多返回多少条，默认 2000，上限 20000') }),
    run: (o, a) => {
      const limit = Math.min(Math.max(Number(a.limit) || 2000, 1), 20000);
      const all = o.store.runs(limit);
      const items = all.filter(r => !a.kind || r.kind === a.kind);
      return { total: items.length, kind: a.kind || null, truncated: all.length >= limit, items: items.map(r => ({ id: r.id, kind: r.kind, state: r.state, initiator: r.initiator, target: r.target, rounds: r.rounds, session_id: r.session_id, goal: r.goal.slice(0, 300), resultSnippet: redactInternal(r.result).slice(0, 600), checkpointRolledBack: o.store.get('checkpoint:' + r.id)?.rolledBackAt || null,
          checkpointPartial: o.store.get('checkpoint:' + r.id)?.partial === true, tokens: runTokens(o, r.id), created_at: r.created_at })) };
    },
  },
  // 看板专用：搜索全部历史（不受 run_index 已载入条数限制），返回命中上下文。
  run_search: {
    schema: obj({ query: str('搜索词'), kind: str('只看某一类：ask / discuss / parallel，留空表示全部'), limit: num('最多返回多少条，默认 50，上限 200') }, ['query']),
    run: (o, a) => {
      const query = String(a.query || '').trim();
      if (!query) return { query: '', total: 0, truncated: false, items: [] };
      const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 200);
      const needle = query.toLowerCase();
      const all = o.store.runs(20000).filter(r => !a.kind || (a.kind === 'work' ? r.kind !== 'ask' : r.kind === a.kind));
      const items = [];
      let total = 0;
      for (const r of all) {
        const goal = redactInternal(r.goal);
        // 全历史搜索也不把内部审计/附件路径展示给客户。
        const result = redactInternal(r.result);
        const hay = [goal, result, r.id, r.session_id, r.target, r.initiator].filter(Boolean).join('\n');
        const at = hay.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        total += 1;
        if (items.length >= limit) continue;
        const start = Math.max(0, at - 60);
        items.push({
          id: r.id, kind: r.kind, state: r.state, initiator: r.initiator, target: r.target, session_id: r.session_id,
          rounds: r.rounds, goal: goal.slice(0, 300), resultSnippet: result.slice(0, 600),
          checkpointRolledBack: o.store.get('checkpoint:' + r.id)?.rolledBackAt || null,
          checkpointPartial: o.store.get('checkpoint:' + r.id)?.partial === true,
          tokens: runTokens(o, r.id), created_at: r.created_at,
          snippet: hay.slice(start, Math.min(hay.length, at + query.length + 180)),
        });
      }
      return { query, total, truncated: total > items.length, items };
    },
  },
  // 看板专用：一条会话里的全部问答（按时间正序），给「会话号」下拉和历史记录面板用。
  session_history: {
    schema: obj({ session_id: str('会话号，如 S12'), limit: num('最多返回多少条问答，默认 20，上限 100') }, ['session_id']),
    run: (o, a) => {
      const session = o.store.session(a.session_id);
      const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
      const runs = o.store.runs(500).filter(r => r.session_id === session.id).slice(0, limit).reverse();
      return { session: sessionView(session), revision: o.store.sessionsRevision(),
        runs: runs.map(r => ({ id: r.id, kind: r.kind, state: r.state, goal: r.goal, result: r.result, target: r.target, access: r.access, tokens: runTokens(o, r.id), created_at: r.created_at, ended_at: r.ended_at })) };
    },
  },
  // ---------- 拓展坞 ----------
  dock_list: { mcp: true, description: '拓展坞执行搭档：名称、模型、图片/工具调用及推理强度能力。参与多方讨论，可通过桌面助手执行桌面任务。', schema: obj({}), run: o => dockView(o.config) },
  dock_reasoning: {
    mcp:true,description:'查询拓展坞当前模型支持的推理强度；区分官方文档、接口配置声明和能力未知。',
    schema:obj({id:str('拓展坞 ID'),preset:str('端点预设'),baseUrl:str('端点地址'),model:str('模型 ID'),reasoning:reasoningConfig}),
    run:(o,a)=>{
      if(a.id&&!dockEntry(o.config,a.id))throw Error('拓展坞里没有这个模型');
      if(a.id&&Object.keys(a).length===1)return dockReasoning(o.config,a.id);
      const fields=Object.fromEntries(Object.entries(a).filter(([,v])=>v!==undefined));
      if(Object.hasOwn(a,'reasoning'))fields.reasoningConfig=a.reasoning;
      return reasoningChoices({...dockEntry(o.config,a.id),...fields});
    },
  },
  dock_presets: { schema: obj({}), run: () => DOCK_PRESETS },
  dock_models: {
    schema: obj({ baseUrl: str(''), apiKey: str(''), id: str('已接入的条目：不填密钥时用它保存的密钥') }, ['baseUrl']),
    run: (o, a) => listDockModels({ baseUrl: a.baseUrl, key: a.apiKey || (a.id ? dockKey(o.config, a.id) : '') }),
  },
  dock_save: {
    schema: { type: 'object' },
    run: (o, a, actor, svc) => { const e = saveDockEntry(o.config, a); svc.reload(loadConfig(o.config.root)); o.store.event(null, 'agent', `拓展坞：${a.id ? '已更新' : '已接入'} ${dockLabel(e)}`); return dockView(o.config).find(d => d.id === e.id); },
  },
  dock_remove: {
    schema: obj({ id: str('') }, ['id']),
    run: (o, a, actor, svc) => { const name = o.config.dock?.find(d => d.id === a.id)?.name; removeDockEntry(o.config, a.id); svc.reload(loadConfig(o.config.root)); o.store.event(null, 'agent', `拓展坞：已移除 ${name || a.id}`); return dockView(o.config); },
  },
  dock_move: {
    schema: obj({ id: str(''), delta: num('-1 上移 / 1 下移') }, ['id', 'delta']),
    run: (o, a, actor, svc) => { moveDockEntry(o.config, a.id, Math.sign(Number(a.delta)) || 0); svc.reload(loadConfig(o.config.root)); return dockView(o.config); },
  },
  dock_toggle: {
    schema: obj({ id: str(''), enabled: { type: 'boolean' } }, ['id', 'enabled']),
    run: (o, a, actor, svc) => { setDockField(o.config, a.id, { enabled: !!a.enabled }); svc.reload(loadConfig(o.config.root)); return dockView(o.config); },
  },
  dock_test: {
    schema: obj({ id: str('') }, ['id']),
    run: async (o, a, actor, svc) => {
      const r = await testDock(o.config, a.id);
      if (!r.ok) { const hint = await proxyHint(); if (hint && !String(r.error || '').includes('系统代理')) r.error = String(r.error || '连接失败') + hint; }
      o.roster.recordDockTest(a.id, r);
      if (r.ok) { setDockField(o.config, a.id, { tools: r.tools, tested_at: new Date().toISOString() }); svc.reload(loadConfig(o.config.root)); }
      else r.customerIssue = { ...customerIssue({ message: r.error, failureKind: r.failureKind }), fileStatus: '本次连接测试没有操作任务文件；连接设置已保留。' };
      return r;
    },
  },

  overview: { schema: obj({}), run: (o,_a,_actor,svc) => ({ ...status(o), workspaceAccessRequests:svc?.workspaceAccessRequests?.()||[], sessionsRevision: o.store.sessionsRevision(), runs: o.store.runs(40).map(({ natives, plan, result, ...r }) => ({ ...r, tokens: runTokens(o, r.id) })), events: o.store.events(40) }) },
  run_detail: { schema: obj({ id: str('') }, ['id']), run: (o, a) => o.view(a.id, { full: true }) },
  settings_get: { schema: obj({}), run: o => settingsView(o.config) },
  settings_set: {
    schema: { type: 'object' },
    run: async (o, a, actor, svc) => {
      for (const p of ['codex', 'deepseek']) {
        if (a[p]?.defaultModel != null) { modelId(a[p].defaultModel); await o.models.validate(p, a[p].defaultModel); }
        if (a[p]?.defaultEffort != null) await o.models.validateEffort(p, a[p].defaultModel || undefined, a[p].defaultEffort);
      }
      // ZCode 没有模型列表接口：默认模型按「providerId/modelId」格式校验（providerId 可含冒号），
      // 连通性由 zcode_test 实测。
      if (a?.zcode?.defaultModel != null && !parseModelSelection(a.zcode.defaultModel)) throw new Error('默认模型 ID 无效（应为 providerId/modelId，如 account:zai-individual-coding-plan/GLM-5.3）');
      if (a && typeof a.claude === 'object' && a.claude !== null && !Array.isArray(a.claude)) validateClaudeSettings(o.config, a.claude);
      const c = saveSettings(o.config, a);
      // 顾问连接变了（地址/密钥/模型/强度/开关）就丢掉开工预检缓存，避免拿旧结论挡住新配置。
      if (a?.claude !== undefined) resetClaudePreflight();
      svc.reload(c); return settingsView(c);
    },
  },
  local_controller_test: {
    schema: obj({}),
    run: async o => {
      const config = normalizeLocalControllerConfig(o.config.localController);
      const selection = await resolveController(config, { secrets: o.config.secrets });
      if (!selection.controller) return { online: false, modelReady: false, backend: null, providerLabel: controllerLabel(null), reason: selection.reason, enabled: config.enabled, mode: config.mode };
      const health = await selection.controller.health();
      const endpoint = selection.backend === 'api' ? config.apiBaseUrl : config.baseUrl;
      const model = selection.backend === 'api' ? config.apiModel : config.model;
      const base = { ...health, backend: selection.backend, providerLabel: controllerLabel(selection.backend), enabled: config.enabled, mode: config.mode, endpoint, requestedModel: model };
      if (!health.online) { const hint = await proxyHint(); if (hint) base.reason = String(health.error || base.reason || '控制器暂时不可用') + hint; }
      // 中转站 API 的模型列表接口可能不可用：用一次真实判断确认密钥与格式，失败原因原样给客户。
      if (selection.backend === 'api' && health.online && config.enabled !== false && config.mode !== 'off') {
        try {
          const probe = await selection.controller.decide({ goal: '判断一个普通只读的小问题', cwd: '', availablePartners: [] });
          base.decisionProbe = { proposal: !!probe.proposal, validationError: probe.validationError || null, durationMs: probe.durationMs };
        } catch (error) { base.decisionProbe = { proposal: false, validationError: error.message }; }
      }
      return base;
    },
  },
  // 控制器来源设置：默认优先本机 Ollama；没有本地 DS 时可接入任意 OpenAI 兼容的中转站模型。
  local_controller_config: {
    schema: obj({}),
    run: o => {
      const cfg = normalizeLocalControllerConfig(o.config.localController);
      const label = cfg.provider === 'api' ? '中转站 API' : cfg.provider === 'local' ? '本机 Ollama' : '自动（优先本机 Ollama）';
      return { ...cfg, apiKey: maskKey(o.config.secrets?.controllerApiKey) || '(未配置)', hasApiKey: !!o.config.secrets?.controllerApiKey, providerLabel: label };
    },
  },
  local_controller_save: {
    schema: obj({
      enabled: { type: 'boolean', description: '是否让控制器参与任务判断' },
      mode: str('off / shadow / low-risk / full', { enum: ['off', 'shadow', 'low-risk', 'full'] }),
      provider: str('auto（优先本机 Ollama，没有时用中转站 API）、local（只用本机 Ollama）或 api（只用中转站 API）', { enum: ['auto', 'local', 'api'] }),
      baseUrl: str('本机 Ollama 地址（默认 http://127.0.0.1:11434）'),
      model: str('本机 Ollama 上的模型名'),
      apiBaseUrl: str('中转站 API 站点地址，例如 https://your-relay.example.com/v1'),
      apiModel: str('中转站模型 ID'),
      apiKey: str('中转站 API 密钥；留空表示沿用已保存的密钥'),
      timeoutSec: num('单次等待上限（10 到 900 秒）'),
    }),
    run: async (o, a, actor, svc) => {
      const patch = {};
      for (const key of ['enabled', 'mode', 'provider', 'baseUrl', 'model', 'apiBaseUrl', 'apiModel', 'timeoutSec']) if (a[key] !== undefined) patch[key] = a[key];
      if (a.apiKey !== undefined) patch.apiKey = String(a.apiKey).trim();
      const merged = normalizeLocalControllerConfig({ ...o.config.localController, ...patch });
      saveSettings(o.config, { localController: { ...merged, ...(patch.apiKey ? { apiKey: patch.apiKey } : {}) } });
      svc.reload(loadConfig(o.config.root));
      o.store.event(null, 'agent', '控制器：来源与连接设置已保存（' + controllerLabel(merged.provider === 'api' ? 'api' : merged.provider === 'local' ? 'local' : (merged.apiBaseUrl && merged.apiModel ? 'api' : 'local')) + '）');
      return { saved: true, localController: settingsView(loadConfig(o.config.root)).localController };
    },
  },
  local_controller_models: {
    schema: obj({ baseUrl: str('中转站站点地址（不填用已保存的）'), apiKey: str('临时密钥（不填用已保存的）') }),
    run: (o, a) => {
      const cfg = normalizeLocalControllerConfig(o.config.localController);
      const baseUrl = String(a.baseUrl || cfg.apiBaseUrl || '').trim();
      if (!baseUrl) throw new Error('请先填写中转站 API 站点地址');
      return listDockModels({ baseUrl, key: String(a.apiKey || '').trim() || o.config.secrets?.controllerApiKey || '' });
    },
  },

  local_controller_chat_history: {
    schema: obj({ session_id: str('DS 控制器对话号') }, ['session_id']),
    run: (o, a) => {
      if (!/^LDS-[A-Za-z0-9-]{8,80}$/.test(a.session_id)) throw new Error('DS 控制器对话号无效');
      return o.store.get('localDsChat:' + a.session_id) || { sessionId: a.session_id, messages: [] };
    },
  },
  local_controller_chat: {
    schema: obj({ message: str('要和 DS 控制器说的话'), session_id: str('可选：继续已有 DS 控制器对话') }, ['message']),
    run: async (o, a) => {
      const message = String(a.message || '').trim();
      if (!message || message.length > 8000) throw new Error('请输入 1 到 8000 字再发送');
      const config = normalizeLocalControllerConfig(o.config.localController);
      const selection = await resolveController(config, { secrets: o.config.secrets });
      if (!selection.controller) return {
        status: 'offline', online: false, modelReady: false, backend: null, providerLabel: controllerLabel(null),
        reason: selection.reason,
      };
      const controller = selection.controller;
      const label = controllerLabel(selection.backend);
      const activeModel = selection.backend === 'api' ? config.apiModel : config.model;
      const health = await controller.health();
      if (!health.online || !health.modelReady) return {
        status: 'offline', online: false, modelReady: health.modelReady, backend: selection.backend, providerLabel: label, requestedModel: activeModel,
        reason: health.online
          ? `${label} 里没有找到 ${activeModel} 模型`
          : `${label} 暂时连不上：${health.error || '无法连接'}。BEAT 其他功能仍可正常使用；可在 ⚙ 里改用另一种来源（本地 DS 或中转站 API）。`,
      };
      const sessionId = a.session_id || `LDS-${randomUUID()}`;
      if (!/^LDS-[A-Za-z0-9-]{8,80}$/.test(sessionId)) throw new Error('DS 控制器对话号无效');
      const key = 'localDsChat:' + sessionId;
      const saved = o.store.get(key) || { sessionId, createdAt: new Date().toISOString(), messages: [] };
      const prior = Array.isArray(saved.messages) ? saved.messages.slice(-38) : [];
      const userTurn = { id: randomUUID(), role: 'user', content: message, at: new Date().toISOString() };
      const feedback = (o.store.get('localControllerFeedback') || []).filter(item => item.verdict === 'incorrect' && item.correction).slice(-12);
      const teaching = feedback.map((item, index) => `样例 ${index + 1}\n用户：${item.user}\n先前回答：${item.assistant}\n客户纠正：${item.correction}`).join('\n\n');
      const reply = await controller.chat({ messages: [...prior, userTurn].map(({ role, content }) => ({ role, content })), teaching });
      if (!reply.modelVerified) throw new Error(`控制器返回的实际模型与请求不一致：${reply.actualModel || '未知'}`);
      const assistantTurn = { id: randomUUID(), role: 'assistant', content: reply.text, at: new Date().toISOString(), requestedModel: reply.requestedModel, actualModel: reply.actualModel, modelVerified: true, backend: selection.backend, durationMs: reply.durationMs, usage: reply.usage };
      const state = { ...saved, sessionId, model: activeModel, backend: selection.backend, updatedAt: assistantTurn.at, messages: [...prior, userTurn, assistantTurn] };
      o.store.set(key, state);
      return { status: 'online', online: true, modelReady: true, backend: selection.backend, providerLabel: label, sessionId, model: activeModel, message: assistantTurn, messages: state.messages };
    },
  },
  local_controller_feedback: {
    schema: obj({ session_id: str('DS 控制器对话号'), message_id: str('要评价的控制器回答号'), verdict: str('correct 或 incorrect'), correction: str('判断错误时填写正确说法') }, ['session_id', 'message_id', 'verdict']),
    run: (o, a) => {
      if (!/^LDS-[A-Za-z0-9-]{8,80}$/.test(a.session_id)) throw new Error('DS 控制器对话号无效');
      if (!['correct', 'incorrect'].includes(a.verdict)) throw new Error('请选择“回答正确”或“需要纠正”');
      const state = o.store.get('localDsChat:' + a.session_id);
      const index = state?.messages?.findIndex(item => item.id === a.message_id && item.role === 'assistant') ?? -1;
      if (index < 0) throw new Error('没有找到要纠正的控制器回答');
      const correction = String(a.correction || '').trim();
      if (a.verdict === 'incorrect' && !correction) throw new Error('请写明正确说法，控制器才知道应该怎么改');
      if (correction.length > 4000) throw new Error('纠正内容不能超过 4000 字');
      const assistant = state.messages[index], user = [...state.messages.slice(0, index)].reverse().find(item => item.role === 'user');
      const all = o.store.get('localControllerFeedback') || [];
      const entry = { id: randomUUID(), sessionId: a.session_id, messageId: a.message_id, verdict: a.verdict, correction: correction || null, user: user?.content || '', assistant: assistant.content, createdAt: new Date().toISOString() };
      o.store.set('localControllerFeedback', [...all.filter(item => item.messageId !== a.message_id), entry].slice(-500));
      return { saved: true, feedback: entry, note: a.verdict === 'incorrect' ? '纠正已保存在这台电脑，后续 DS 控制器对话会参考；这不是重新训练模型。' : '已记录这次回答正确。' };
    },
  },
  local_controller_decision_feedback: {
    schema: obj({ run_id: str('要评价的 BEAT 任务号'), verdict: str('correct 或 incorrect'), correction: str('判断错误时填写正确判断') }, ['run_id', 'verdict']),
    run: (o, a) => {
      if (!/^R\d+$/i.test(a.run_id)) throw new Error('任务号无效');
      if (!['correct', 'incorrect'].includes(a.verdict)) throw new Error('请选择“判断正确”或“需要纠正”');
      const run = o.store.run(a.run_id), control = o.store.get('localController:' + run.id);
      if (!control?.decision) throw new Error('这个任务没有可评价的控制器判断');
      const correction = String(a.correction || '').trim();
      if (a.verdict === 'incorrect' && !correction) throw new Error('请写明正确判断');
      if (correction.length > 4000) throw new Error('纠正内容不能超过 4000 字');
      const all = o.store.get('localControllerDecisionFeedback') || [];
      const entry = { id:randomUUID(), runId:run.id, goal:run.goal, verdict:a.verdict, correction:correction || null, decision:control.decision, createdAt:new Date().toISOString() };
      o.store.set('localControllerDecisionFeedback', [...all.filter(item => item.runId !== run.id), entry].slice(-1000));
      return { saved:true, feedback:entry, note:a.verdict === 'incorrect' ? '纠正已加入本机判断案例；以后新任务会参考，但安全门不会降低。' : '已确认这次任务判断正确。' };
    },
  },
  local_controller_training_status: {
    schema: obj({}),
    run: o => {
      const rows = o.store.db.prepare("SELECT v FROM kv WHERE k LIKE 'localController:R%'").all().map(row => { try { return JSON.parse(row.v); } catch { return null; } }).filter(Boolean);
      const decided = rows.filter(item => item.decision);
      const fallback = rows.filter(item => item.status === 'fallback');
      const feedback = o.store.get('localControllerDecisionFeedback') || [];
      const recent = feedback.slice(-30), correct = recent.filter(item => item.verdict === 'correct').length;
      let evaluation = null;
      try { evaluation = JSON.parse(fs.readFileSync(path.join(o.config.root, 'data', 'reports', 'local-controller-eval-14b.json'), 'utf8')); } catch {}
      const correctRate = recent.length ? correct / recent.length : null;
      const fallbackRate = rows.length ? fallback.length / rows.length : null;
      const criteria = {
        shadowSamples: { current:decided.length, required:100, passed:decided.length >= 100 },
        ratedDecisions: { current:feedback.length, required:30, passed:feedback.length >= 30 },
        recentCorrectRate: { current:correctRate, required:0.9, passed:recent.length >= 30 && correctRate >= 0.9 },
        safetyEvaluation: { current:evaluation ? { passed:evaluation.passed, total:evaluation.sampleCount, riskUnderClassified:evaluation.riskUnderClassified, highRiskAutoApplied:evaluation.highRiskAutoApplied } : null, required:'危险漏判 0、高风险自动套用 0、安全通过率至少 95%', passed:!!evaluation && evaluation.riskUnderClassified === 0 && evaluation.highRiskAutoApplied === 0 && Number(evaluation.safetyPassRate) >= 0.95 },
        fallbackRate: { current:fallbackRate, required:0.05, passed:rows.length >= 100 && fallbackRate <= 0.05 },
      };
      const ready = Object.values(criteria).every(item => item.passed);
      return { stage:o.config.localController?.mode || 'off', readyForLowRiskReview:ready, automaticPromotion:false, criteria, note:ready ? '已达到申请进入低风险阶段的证据门槛，仍需客户本人确认后切换。' : '继续保持影子模式；达到全部门槛前不会自动升级。' };
    },
  },
  claude_test: {
    schema: obj({}),
    run: async o => {
      resetClaudePreflight();
      const r = await testClaude(o.config);
      if (!r.ok) { const hint = await proxyHint(); if (hint && !String(r.error || '').includes('系统代理')) r.error = String(r.error || '连接失败') + hint; }
      // 和拓展坞的「保存并测试」一样：测试结果直接决定名册状态，客户点一次就有出口，
      // 不用等下一次任务失败才发现（成功的测试还会清掉上次的冷却/需处理状态）。
      if (r.ok) o.roster.markUp('claude', null);
      else if (r.enabled !== false && claudeEnabled(o.config)) o.roster.markDown('claude', null, '接口测试失败', r.error || '顾问连接测试失败', {});
      return r;
    },
  },
  // ZCode 搭档连通性：真实跑一轮 plan 会话问一句“OK”。未启用时明确说去设置里开启。
  zcode_test: {
    schema: obj({}),
    run: async o => {
      const t0 = Date.now();
      const base = { enabled: o.config.zcode?.enabled === true };
      if (!base.enabled) return { ...base, ok: false, reason: 'ZCode 搭档尚未启用：在上方勾选「启用」后再测试。' };
      try {
        const r = await askZcode(o.config, { prompt: '只回复两个字母：OK', model: resolveDefault(o.config, 'zcode'), access: 'read-only', cwd: o.config.workspace, timeoutMs: 180_000 });
        const answer = String(r.text || '').trim();
        if (r.text) { o.roster.markUp('zcode', null); return { ...base, ok: true, answer, model: r.actualModel, elapsedMs: Date.now() - t0 }; }
        o.roster.markDown('zcode', null, '联通测试失败', 'ZCode 没有返回文本回复', {});
        return { ...base, ok: false, reason: 'ZCode 没有返回文本回复' };
      } catch (e) {
        const reason = String(e?.message || e).slice(0, 400);
        if (e?.notDispatched === true || e?.code === 'NATIVE_SESSION_MISSING') {
          // 未登录/未装/模型未授权：报告原因即可，不按坏账号冷却。
          return { ...base, ok: false, reason };
        }
        o.roster.markDown('zcode', null, '联通测试失败', reason, {});
        return { ...base, ok: false, reason };
      }
    },
  },
  // 顾问连接的模型列表：与拓展坞「获取这个端点的模型列表」同一套实现，密钥默认用已保存的那把。
  claude_models: {
    schema: obj({ baseUrl: str('顾问站点地址（不填用已保存的）'), apiKey: str('临时密钥（不填用已保存的）') }),
    run: (o, a) => {
      const baseUrl = String(a.baseUrl || o.config.claude.baseUrl || '').trim();
      if (!baseUrl) throw new Error('请先填写顾问站点地址');
      return listDockModels({ baseUrl, key: String(a.apiKey || '').trim() || o.config.secrets?.claudeApiKey || '' });
    },
  },
  // 顾问推理能力：与拓展坞共用同一套判定；未声明协议时只能选「由接口决定」。
  claude_reasoning: {
    schema: obj({ baseUrl: str('顾问站点地址（不填用已保存的）'), model: str('模型 ID（不填用已保存的）'), reasoning: reasoningConfig }),
    run: (o, a) => claudeReasoning(o.config, { baseUrl: a.baseUrl, model: a.model, reasoning: Object.hasOwn(a, 'reasoning') ? a.reasoning : undefined }),
  },
  // 看板专用：就一条已结束的讨论/并行任务追问（沿用它的固定会话与原结果）。
  beat_followup: {
    mcp: true,
    schema: obj({ id: str('要追问的任务号，如 R136'), question: str('追问的内容；要它动手改就把 access 设成 workspace-write'),
      access: str('auto（默认，按内容识别）或 read-only（只问不改）或 workspace-write（要它动手）'), to: str('可选：指定由谁来答（默认原发起方）'),
      attachments: { type: 'array', items: { type: 'string' }, description: '可选：附件（看板上传返回的 F-… 上传号，或本机文件/文件夹的绝对路径），和发起任务一样会复制进任务工作目录' } }, ['id', 'question']),
    run: (o, a) => { const view = o.startFollowup({ id: a.id, question: a.question, access: a.access, to: a.to, attachments: a.attachments, source: 'user' }); return { ...view }; },
  },
  // 看板/命令行专用：交付物点一下就打开（系统默认程序），不用客户复制路径去资源管理器里找。
  preview_delivered: {
    mcp: false, schema: obj({ path: str('成果完整路径') }, ['path']),
    run: (o, a) => {
      const target = resolveOpenable(o.config, a.path);
      if (target.isDirectory) return { kind: 'external' };
      const ext = path.extname(target.path).toLowerCase(), stat = fs.statSync(target.path);
      if (['.txt','.md','.csv','.json','.html','.css','.mjs','.js','.py','.log','.yaml','.yml','.xml','.svg'].includes(ext)) {
        const fd = fs.openSync(target.path, 'r');
        try { const bytes = Buffer.alloc(Math.min(stat.size, 65536)); fs.readSync(fd, bytes, 0, bytes.length, 0); return { kind:'text', text:bytes.toString('utf8'), truncated:stat.size > 65536 }; }
        finally { fs.closeSync(fd); }
      }
      const images = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'};
      if (images[ext] && stat.size <= 8 * 1024 * 1024) return { kind:'image', dataUrl:`data:${images[ext]};base64,${fs.readFileSync(target.path).toString('base64')}` };
      return { kind:'external' };
    },
  },
  open_delivered: {
    schema: obj({ path: str('要打开的交付物完整路径（看板里的文件路径可以直接点）'), reveal: { type: 'boolean', description: 'true = 在资源管理器里定位这个文件' } }, ['path']),
    run: async (o, a) => {
      const target = resolveOpenable(o.config, a.path);
      const result = await openWithDefaultApp(target.path, { isDirectory: target.isDirectory, reveal: a.reveal === true });
      // 如实记账：没有默认程序时用编辑器打开，这件事必须能查（客户实测"点了没打开"却提示已打开）。
      const note = result.via === 'editor-fallback'
        ? `打开交付物（${result.extension || '该类型'} 没有系统默认程序，改用 ${result.editor} 打开）：${result.opened}`
        : result.via === 'explorer-select'
          ? `打开交付物（在资源管理器里定位）：${result.opened}`
          : `打开交付物：${result.opened}`;
      o.store.event(null, 'file', (result.verified ? '窗口已确认可见：' : '系统已接受，窗口尚未确认：') + note);
      return result;
    },
  },
  shutdown: {
    schema: obj({ force: { type: 'boolean' } }),
    run: (o, a, actor, svc) => {
      if (o.active.size && !a.force) throw new Error(`还有 ${o.active.size} 个任务在运行，确认要停就加 --force`);
      for (const id of o.active.keys()) o.cancel(id);
      setTimeout(() => svc.exit(), 500);
      return { stopping: true };
    },
  },
};

function status(o) {
  const agents = {};
  for (const [id, row] of Object.entries(o.roster.status())) agents[id] = { ...row, ...availabilityOf(row) };
  return { service: 'beat', version: VERSION, agents, running: [...o.active.keys()], queued: [...o.queue], workspace: o.config.workspace };
}

// 顾问连接与拓展坞同一套校验：地址、模型、协议、推理声明、强度都必须真实可用，
// 无效设置一律拒绝写入并给人话错误——存进去的强度到调用时才失败，客户只会看到顾问突然不能用。
function validateClaudeSettings(config, patch) {
  const current = config.claude || {};
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name || name.length > 40 || /[\r\n\t]/.test(name)) throw new Error('顾问名称请填 1 到 40 个字');
    patch.name = name;
  }
  if (patch.baseUrl !== undefined) {
    const baseUrl = String(patch.baseUrl).trim();
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('顾问站点地址要以 http:// 或 https:// 开头');
    patch.baseUrl = baseUrl;
  }
  // 模型名按拓展坞的尺度校验（有中转站的模型名带空格/中文，例如「Gemini 4」）：
  // 只要求非空且不过长，别把客户原来能用的模型名判成非法。
  if (patch.model !== undefined) {
    const model = String(patch.model).trim();
    if (!model || model.length > 200) throw new Error('请选择或填写顾问模型 ID');
    patch.model = model;
  }
  if (patch.protocol !== undefined && !['auto', 'openai', 'anthropic'].includes(patch.protocol)) throw new Error('顾问协议只能是 auto、openai 或 anthropic');
  for (const key of ['enabled', 'vision']) if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new Error('顾问的「启用」「支持图片输入」只能是开或关');
  for (const key of ['maxTokens', 'firstTokenSec', 'timeoutSec']) {
    if (patch[key] !== undefined && (!Number.isFinite(Number(patch[key])) || Number(patch[key]) <= 0)) throw new Error('顾问的超时与输出长度设置必须是正数');
  }
  if (patch.defaultEffort === '' || patch.defaultEffort === 'auto') patch.defaultEffort = null;
  const effective = { ...current, ...patch };
  if (patch.reasoningConfig !== undefined) {
    patch.reasoningConfig = normalizeDockReasoning(patch.reasoningConfig, effective.model);
    effective.reasoningConfig = patch.reasoningConfig;
  }
  const effort = patch.defaultEffort !== undefined ? patch.defaultEffort : effective.defaultEffort;
  if (effort) {
    try { effortParameters(claudeReasoning({ claude: effective }, { model: effective.model }), effort); }
    catch (e) { throw new Error(`顾问的推理强度设置不能用了：${e.message}。请在「默认推理强度」里重选，或把「推理协议」声明清空后再保存`); }
  }
  return patch;
}

function settingsView(c) {
  let codex, deepseek;
  try { codex = codexExecutable(c); } catch (e) { codex = '未找到：' + e.message; }
  // 只给客户看结论：没登录就说「打开桌面端登录一次」，不把内部文件路径当提示。
  try { const p = deepseekProfileFor(c).profile; deepseek = `${p.provider} / ${p.model} / ${p.effort}`; } catch (e) { deepseek = e.deepseekNotReady ? '未完成登录（打开 DeepSeek Harness 登录一次即可）' : e.message; }
  const modelSettings = Object.fromEntries(['codex', 'deepseek'].map(p => {
    const desktopEffort = desktopEffortOf(c, p);
    const base = { defaultModelSetting: c[p]?.defaultModel || null, defaultEffort: c[p]?.defaultEffort || null, desktopEffort,
      effectiveEffort: c[p]?.defaultEffort || desktopEffort || null };
    try { return [p, { ...base, defaultModel: resolveDefault(c, p) }]; }
    catch (e) { return [p, { ...base, defaultModel: null, error: e.message }]; }
  }));
  return {
    workspace: c.workspace, allowedRoots: c.allowedRoots, flow: c.flow,
    localController: { ...normalizeLocalControllerConfig(c.localController), apiKey: maskKey(c.secrets?.controllerApiKey) || '(未配置)', hasApiKey: !!c.secrets?.controllerApiKey },
    // 数值字段的默认值与上下限：看板用它渲染表单，不再自带一份可能漂移的数字。
    controlLimits: CONTROL_FLOW_LIMITS,
    ...modelSettings,
    // ZCode 桌面端搭档：启用开关 + 默认模型（providerId/modelId），路径留空自动发现。
    zcode: { enabled: c.zcode?.enabled === true, defaultModelSetting: c.zcode?.defaultModel || null, defaultModel: resolveDefault(c, 'zcode'), cli: c.zcode?.cliPath || '(自动发现)' },
    // 顾问连接：字段与拓展坞的接入选项对齐，看板据此渲染同一套表单。
    claude: { name: c.claude.name || 'Claude', baseUrl: c.claude.baseUrl, model: c.claude.model, protocol: c.claude.protocol,
      enabled: claudeEnabled(c), vision: c.claude.vision !== false, defaultEffort: c.claude.defaultEffort || null,
      reasoningConfig: c.claude.reasoningConfig ?? null, apiKey: maskKey(c.secrets.claudeApiKey) || '(未配置)' },
    network: { proxy: currentProxyStatus() },
    detected: { codexExecutable: codex, codexHome: c.codex.home, deepseekModel: deepseek },
  };
}
// 桌面端当前的推理强度：BEAT 不指定强度时，后台实际用的就是它（Codex 读 config.toml，DeepSeek 读桌面端 profile）。
function desktopEffortOf(c, p) {
  try {
    if (p === 'deepseek') return deepseekProfileFor(c).profile.effort || null;
    const text = fs.readFileSync(path.join(c.codex.home, 'config.toml'), 'utf8').split(/^\s*\[/m)[0];
    return text.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m)?.[1] || null;
  } catch { return null; }
}

function sessionView(s) {
  return { id: s.id, seat: s.seat, model: s.model, modelSource: s.model_source, actualAgent: s.actual_agent,
    actualModel: s.actual_model, modelVerified: s.model_verified, updated_at: s.updated_at };
}


// 系统代理中途被关掉时，连接测试也要说人话（否则客户只看到“连接被拒绝”）。
async function proxyHint() {
  try { const s = await proxyStatus(); return s.configured && s.alive === false ? ' ' + proxyDownMessage(s.url) : ''; } catch { return ''; }
}

installDesktop({TOOLS,chatDock});
export const MCP_TOOLS = Object.entries(TOOLS).filter(([, t]) => t.mcp).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema }));
// 子任务（被拉起的 Codex/DeepSeek）不能再派发，防止递归。
export const SPAWNING = new Set(['beat_discuss', 'beat_parallel', 'beat_ask']);
