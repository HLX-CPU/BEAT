// 视觉类交付（HTML/SVG/CSS 动画、页面、截图、图表…）的验收需要"能看懂画面"的独立搭档：
// 现在只有 Claude（能收图）和勾了「支持图片输入」的拓展坞能做到。只剩不看图的搭档时，
// 产出会全部做好却卡在"待核验"（R365 实测：客户把 Claude 和两个看图拓展坞都暂停，5 条视觉验收没人能判）。
// 所以在**发起前**就把这件事提示出来，而不是等跑完才失败。
const VISUAL_GOAL = /(html|htm|svg|css|canvas|webgl|网页|页面|网站|动画|动效|截图|图片|图像|视觉|配色|排版|渲染|海报|logo|图标|界面|\bui\b|\bux\b|\b2d\b|\b3d\b)/i;

export function looksVisualGoal(goal) { return VISUAL_GOAL.test(String(goal || '')); }

// 能当"独立视觉核验人"的搭档：Claude（默认收图）与勾了「支持图片输入」的拓展坞。
// 不含 Codex：这类任务的执行方通常就是 Codex，自己不能核验自己的产出，它在线也不算数。
export function visualReviewPartners(config, agents = {}) {
  const status = agent => (agents && agents[agent] && agents[agent].status) || 'offline';
  const out = [];
  const c = (config && config.claude) || {};
  if (c.enabled !== false && c.vision !== false) out.push({ agent: 'claude', name: c.name || 'Claude', status: status('claude') });
  for (const dock of (config && config.dock) || []) {
    if (!dock || dock.enabled === false || dock.vision === false) continue;
    const raw = String(dock.id || '');
    const id = raw.startsWith('dock:') ? raw : 'dock:' + raw;
    if (!id || id === 'dock:') continue;
    out.push({ agent: id, name: dock.name || id, status: status(id) });
  }
  return out;
}

// 发起前检查：goal 像视觉交付、且没有一个能看图的独立搭档在线 → ok:false，并说明后果和下一步。
export function visualReviewReadiness({ config, agents, goal } = {}) {
  if (!looksVisualGoal(goal)) return { visual: false, ok: true, parties: [], online: [], paused: [], reason: null };
  const parties = visualReviewPartners(config, agents);
  const online = parties.filter(item => item.status === 'online');
  const paused = parties.filter(item => item.status === 'paused');
  return {
    visual: true,
    ok: online.length > 0,
    parties,
    online: online.map(item => item.agent),
    paused: paused.map(item => item.agent),
    reason: online.length ? null : '当前没有能看图的独立搭档在线（Claude 和勾了「支持图片输入」的拓展坞都不在线）。这类视觉交付做好后会停在「待核验」，恢复搭档后点「继续」只核验不重做',
  };
}
