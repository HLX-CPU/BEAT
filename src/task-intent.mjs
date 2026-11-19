import { wantsAction } from './quick-work.mjs';

// Preview is deterministic and never calls a model or changes a setting.
// Explicit choice/session wins over automatic routing.

// 买家在点「开始」前最想知道两件事：会走哪种处理方式、大概要烧多少额度。
// token 不是金额，这里只给"档位 + 调用次数 + token 量级"，不伪造金额。
export function estimateTaskCost(route, text = '', { work = false } = {}) {
  const chars = String(text || '').trim().length;
  if (route === 'ask') {
    if (work) return { tier: '中', calls: '1–2 次', tokens: '约 2–9 万',
      note: '文件/电脑任务由桌面端原生模型执行，记录用量受客户端上下文影响，通常比纯问答高很多。' };
    const tier = chars > 800 ? '中' : '轻';
    return { tier, calls: '1–2 次', tokens: chars > 800 ? '约 3–8 千' : '约 1–3 千',
      note: '一次问答，通常只有一轮模型调用。' };
  }
  if (route === 'discuss') {
    const tier = chars > 300 ? '中到重' : '中';
    return { tier, calls: '8–16 次', tokens: chars > 300 ? '约 8–25 万' : '约 4–15 万',
      note: '按 4 位搭档的短提纲、收敛、短评审估算；方案修订多时会更高。' };
  }
  return { tier: '重', calls: '12–20 次', tokens: '约 10–30 万',
    note: '含多位搭档讨论/评审与执行、复核；执行轮次多时会更高。' };
}

export function previewTask({ question = '', mode = 'auto', session_id, to = 'codex' } = {}) {
  const text = String(question).trim();
  const positive = text.split(/[。；;，,\n]/).filter(s => !/^\s*(?:请)?(?:不要|禁止|不用|无需|不需要)/.test(s)).join('。');
  const readonly = mode === 'read-only' || /^(?:请)?(?:只读|只(?:需|要)?(?:回答|讨论|解释|分析))/.test(text) || mode !== 'workspace-write' && /^(?:请)?(?:怎样|如何|怎么|为什么|能否|是否|解释|介绍)/.test(text);
  const work = !readonly && (mode === 'workspace-write' || wantsAction(text) || /^(?:请|帮我|麻烦)?\s*(?:修复|实现|开发|搭建|制作|生成|整理|转换|优化|把.+(?:改好|修好|做好))/.test(text));
  const collaboration = /(?:多(?:个|位|方)|所有|全体|各位|两位).{0,12}(?:搭档|模型|AI|协作|讨论)|并行(?:任务|分工|处理)|共同讨论|一起讨论/i.test(positive);
  const complex = /开发.{0,12}(?:系统|项目|应用)|架构|跨系统|接口联调|迁移数据库|生产环境|批量修改|全部修好|体验.{0,10}(?:修复|改造)/.test(positive);
  let route = mode === 'discuss' ? 'discuss' : mode === 'parallel' ? 'parallel'
    : mode === 'auto' && !session_id && (collaboration || (work && complex)) ? (work ? 'parallel' : 'discuss') : 'ask';
  if (readonly && mode !== 'discuss') route = 'ask';
  const multi = route !== 'ask';
  const cost = estimateTaskCost(route, text, { work });
  const disclaimer = '软件购买价不代表模型调用费用；账号额度和 API 费用以提供方为准，token 不能换算成金额。';
  return { route, access: work ? 'workspace-write' : 'read-only', multi,
    partner: to, needsInitiator: multi && !['codex', 'deepseek', 'zcode'].includes(to),
    title: multi ? route === 'parallel' ? '多位搭档协作完成' : '多位搭档共同讨论' : work ? '一位搭档直接执行，再核验结果' : '直接回答问题',
    explanation: multi ? '会调用多位搭档，讨论与复核会增加等待和模型用量。已有安全确认继续保留。' : work ? '目标明确，省去多方讨论；文件读回和必要的独立核验仍会执行。' : '只回答，不修改文件或操作电脑。',
    costEstimate: cost,
    costSummary: '预计档位：' + cost.tier + '（' + cost.calls + '模型调用，' + cost.tokens + ' token；' + cost.note + '）',
    costNotice: '预计档位：' + cost.tier + '（' + cost.calls + '模型调用，' + cost.tokens + ' token）。' + cost.note + disclaimer,
    estimatedSeconds: null, estimatedCost: null };
}
