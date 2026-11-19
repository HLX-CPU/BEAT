// 分工判断：方案已由搭档共同批准，控制器只决定每个任务由谁执行。
// 与入口决策分开成独立 schema / 提示词 / 校验，避免两份大 JSON 混在一起；
// 这里只做纯判断，不碰文件、不执行命令。

export const LOCAL_DISPATCH_SCHEMA_VERSION = 1;

export const LOCAL_DISPATCH_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'assignments', 'confidence', 'reasons'],
  properties: {
    schemaVersion: { type: 'integer', const: LOCAL_DISPATCH_SCHEMA_VERSION },
    assignments: {
      type: 'array', minItems: 1, maxItems: 64,
      items: {
        type: 'object', additionalProperties: false,
        required: ['taskId', 'owner', 'reason'],
        properties: {
          taskId: { type: 'string', minLength: 1, maxLength: 80 },
          owner: { type: 'string', minLength: 1, maxLength: 80 },
          reason: { type: 'string', minLength: 1, maxLength: 160 },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasons: { type: 'array', minItems: 0, maxItems: 6, items: { type: 'string', maxLength: 160 } },
  },
});

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new Error(label + '必须为对象');
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(label + '包含不允许的字段：' + extra.join('、'));
  for (const key of allowed) if (!(key in value)) throw new Error(label + '缺少字段：' + key);
}

function stringArray(value, label, { min = 0, max = 16, maxLength = 160 } = {}) {
  if (!Array.isArray(value)) throw new Error(label + '必须为字符串数组');
  if (value.length < min) throw new Error(label + '至少需要 ' + min + ' 条');
  if (value.length > max) throw new Error(label + '最多 ' + max + ' 条');
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(label + '第 ' + (index + 1) + ' 条必须为非空文字');
    const text = item.trim();
    if (text.length > maxLength) throw new Error(label + '第 ' + (index + 1) + ' 条超过 ' + maxLength + ' 字');
    return text;
  });
}

/** 与 prepareQueuedTasks 的 task.id 规则对齐：没有 id 的任务用 task-N。 */
export function dispatchTaskId(task, index) {
  return String(task?.taskId ?? task?.id ?? 'task-' + (Number(index) + 1));
}

function partnerId(value) {
  return String(value?.id ?? value ?? '').trim().toLowerCase();
}

/**
 * 分工判断提示词。方案内容已经锁定，模型不得借分工修改任务、文件范围或验收标准；
 * 它只能从本次在线搭档里给每个任务挑一个人。
 */
export function localDispatchPrompt({ goal, cwd, tasks = [], availablePartners = [], partners = [], limits = {}, context = '' } = {}) {
  const partnerRows = (Array.isArray(partners) && partners.length ? partners : availablePartners.map(id => ({ id })))
    .map(partner => plainObject(partner)
      ? { id: String(partner.id || ''), label: String(partner.label || partner.name || ''), kind: String(partner.kind || '') }
      : { id: String(partner || ''), label: '', kind: '' })
    .filter(partner => partner.id);
  const taskRows = (Array.isArray(tasks) ? tasks : []).map((task, index) => ({
    taskId: dispatchTaskId(task, index),
    title: String(task.title || '').slice(0, 160),
    detail: String(task.detail || '').slice(0, 700),
    type: task.type === 'desktop' ? 'desktop' : 'workspace',
    difficulty: task.difficulty ?? null,
    files: (Array.isArray(task.files) ? task.files : []).slice(0, 12).map(String),
    currentOwner: String(task.currentOwner ?? task.owner ?? '').toLowerCase() || null,
    limitedTo: Array.isArray(task.eligibleWorkers) ? task.eligibleWorkers.map(String) : [],
  }));
  return [
    '你是 BEAT 的分工控制器。方案内容已经由搭档共同批准，你只决定每个任务由谁执行。',
    '不得增加、删除、合并任务，不得修改任务标题、说明、文件范围、依赖或验收标准；只分配执行者。',
    '每个任务必须给出且只给出一个执行者；taskId 必须来自下面的任务列表，不能重复。',
    'owner 必须来自“可用搭档”列表，不能填写 current_user、user 或未列出的名字。',
    '任务写了 limitedTo 时，owner 只能从 limitedTo 里选；写了 limitedTo 的任务不能分给名单外的人。',
    '任务数量：' + taskRows.length + '。assignments 必须恰好 ' + taskRows.length + ' 条，taskId 一个都不能少、不能重复；少一个整份分工都不采纳。',
    '优先按任务类型、难度、文件范围和搭档能力分配；不要把所有任务都塞给同一个人，除非确实只有它适合。',
    'reason 不超过 40 个字，写清楚为什么选这个人；不要写任务内容。',
    'confidence 必须是 0 到 1 的小数，例如 0.9；绝不能填 85 或 100。reasons 最多 4 条。',
    '只输出严格的 JSON，不要解释文字，不要 Markdown 代码块。',
    '用户目标：' + String(goal || '').trim(),
    '工作目录：' + (String(cwd || '').trim() || '未知'),
    '可用搭档：' + JSON.stringify(partnerRows),
    '任务列表：' + JSON.stringify(taskRows),
    '当前预算边界：' + JSON.stringify(limits || {}),
    context ? '补充上下文：' + String(context).slice(0, 8000) : '',
  ].filter(Boolean).join('\n');
}

export function validateLocalDispatch(value, { tasks = [], partners = [] } = {}) {
  if (!plainObject(value)) throw new Error('分工判断必须为对象');
  exactKeys(value, ['schemaVersion', 'assignments', 'confidence', 'reasons'], '分工判断');
  if (value.schemaVersion !== LOCAL_DISPATCH_SCHEMA_VERSION) throw new Error('分工判断版本无效');
  const taskIds = (Array.isArray(tasks) ? tasks : []).map((task, index) => dispatchTaskId(task, index));
  if (!taskIds.length) throw new Error('分工判断缺少任务列表');
  if (new Set(taskIds).size !== taskIds.length) throw new Error('分工判断的任务编号重复');
  if (!Array.isArray(value.assignments) || !value.assignments.length) throw new Error('分工判断缺少执行者分配');
  if (value.assignments.length > taskIds.length) throw new Error('分工判断包含了不存在的任务');
  if (value.assignments.length !== taskIds.length) throw new Error('分工判断必须覆盖每一个任务');
  const allowedTasks = new Set(taskIds);
  const allowedPartners = new Set((Array.isArray(partners) ? partners : []).map(partnerId).filter(Boolean));
  const seen = new Set();
  const assignments = value.assignments.map((row, index) => {
    const label = '分工第 ' + (index + 1) + ' 项';
    exactKeys(row, ['taskId', 'owner', 'reason'], label);
    const taskId = String(row.taskId || '').trim();
    if (!allowedTasks.has(taskId)) throw new Error(label + '引用了不存在的任务：' + taskId);
    if (seen.has(taskId)) throw new Error(label + '重复分配了任务：' + taskId);
    seen.add(taskId);
    const owner = partnerId(row.owner);
    if (!owner) throw new Error(label + '缺少执行搭档');
    if (allowedPartners.size && !allowedPartners.has(owner)) throw new Error(label + '选择了不在可用搭档中的执行者：' + row.owner);
    if (typeof row.reason !== 'string' || !row.reason.trim() || row.reason.trim().length > 160) throw new Error(label + '必须写 1 到 160 字的理由');
    return { taskId, owner, reason: row.reason.trim() };
  });
  for (const id of taskIds) if (!seen.has(id)) throw new Error('分工判断漏掉了任务：' + id);
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error('分工置信度必须为 0 到 1');
  return {
    schemaVersion: LOCAL_DISPATCH_SCHEMA_VERSION,
    assignments,
    confidence: value.confidence,
    reasons: stringArray(value.reasons, '分工原因', { min: 0, max: 6, maxLength: 160 }),
  };
}

/**
 * 安全应用分工。
 * - shadow：只记录模型建议，不改方案；
 * - low-risk：只补方案里的空 owner，不改已指名的人；
 * - full：可以在没有 limitedTo 硬限制时改派，但每个改派都留原值、模型理由和证据。
 * 方案任务上写了 eligibleWorkers（能力/通道硬限制）时，任何模式都不越过它。
 */
export function localDispatchPolicy(decision, { mode = 'shadow', tasks = [], partners = [], highRisk = false } = {}) {
  const checked = validateLocalDispatch(decision, { tasks, partners });
  const stop = reason => ({ applied: false, reason, patch: [], rows: [], decision: checked });
  if (mode === 'off') return stop('控制器已关闭');
  if (highRisk) return stop('高风险、资金、不可逆或电脑输入继续由原 BEAT 安全流程处理');
  const minConfidence = mode === 'low-risk' ? 0.8 : 0;
  if (checked.confidence < minConfidence) return stop('分工置信度低于当前模式门槛');
  const byId = new Map(checked.assignments.map(row => [row.taskId, row]));
  const rows = tasks.map((task, index) => {
    const taskId = dispatchTaskId(task, index);
    const chosen = byId.get(taskId);
    const previousOwner = String(task.currentOwner ?? task.owner ?? '').toLowerCase();
    const limitedTo = Array.isArray(task.eligibleWorkers) ? task.eligibleWorkers.map(partnerId).filter(Boolean) : [];
    const base = { index, taskId, previousOwner, controllerOwner: chosen.owner, reason: chosen.reason };
    if (limitedTo.length && !limitedTo.includes(chosen.owner)) {
      // 方案本身就把 owner 写在硬限制名单外时，也不能把 finalOwner 记成它：
      // 队列最终只会在 limitedTo 里选人，这里如实写“未定，由硬限制名单决定”。
      const finalOwner = previousOwner && limitedTo.includes(previousOwner) ? previousOwner : limitedTo.length === 1 ? limitedTo[0] : '';
      return { ...base, action: 'rejected', finalOwner, detail: '任务限定了执行搭档（' + limitedTo.join('、') + '），控制器选了名单外的人；执行人由该名单决定' + (finalOwner ? '（' + finalOwner + '）' : '') };
    }
    if (!previousOwner) return { ...base, action: 'assigned', finalOwner: chosen.owner, detail: '方案没有指定执行人，由控制器补位' };
    if (previousOwner === chosen.owner) return { ...base, action: 'confirmed', finalOwner: previousOwner, detail: '与方案指定一致' };
    if (limitedTo.length) return { ...base, action: 'kept', finalOwner: previousOwner, detail: '任务有明确的执行搭档限制，保留方案指定的人' };
    if (mode === 'full' || mode === 'shadow') return { ...base, action: 'reassigned', finalOwner: chosen.owner, detail: mode === 'shadow' ? '影子模式记录改派建议，实际不改方案' : '完全接管模式允许改派，已记录理由' };
    return { ...base, action: 'kept', finalOwner: previousOwner, detail: '低风险模式只补空缺，不改方案已指定的人' };
  });
  const patch = rows.filter(row => ['assigned', 'reassigned'].includes(row.action));
  const summary = {
    assigned: rows.filter(row => row.action === 'assigned').length,
    reassigned: rows.filter(row => row.action === 'reassigned').length,
    confirmed: rows.filter(row => row.action === 'confirmed').length,
    kept: rows.filter(row => row.action === 'kept').length,
    rejected: rows.filter(row => row.action === 'rejected').length,
  };
  const applied = mode !== 'shadow' && patch.length > 0;
  const reason = mode === 'shadow'
    ? '影子模式只记录分工建议，不改变方案'
    : patch.length ? '已在安全边界内把 ' + patch.length + ' 个任务交给控制器选择的执行搭档' : '没有需要改变的分工';
  return { applied, reason, patch, rows, summary, decision: checked };
}
