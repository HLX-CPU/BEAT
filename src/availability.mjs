// 状态页的“在线”不等于“可用”：原生工具可能未验证、拓展坞上游可能没账号。
// 这里把差异显式算出来，客户不用自己从 reason/toolsVerified 字段猜。
// 状态与下线原因一律说人话：客户看到的必须是中文句子，不能是 cooldown 或 [object Object]。
const STATUS_TEXT = { online: '在线', cooldown: '冷却中', paused: '已暂停', offline: '离线', down: '离线', unknown: '状态未知' };
const statusText = value => STATUS_TEXT[String(value || '').toLowerCase()] || String(value || '未知');

function untilText(until) {
  if (!until) return '';
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) return '';
  return `（约 ${at.toLocaleString('zh-CN', { hour12: false })} 后自动重试）`;
}

// down 既可能是字符串，也可能是 {reason, detail, until} 结构；直接 String() 会得到 [object Object]。
function downText(down) {
  if (!down) return '';
  if (typeof down === 'string') return down;
  const reason = down.reason || '暂时不可用';
  const detail = down.detail && down.detail !== reason ? '：' + down.detail : '';
  return reason + detail + untilText(down.until);
}

export function availabilityOf(row) {
  if (!row || typeof row !== 'object') return { usable: false, warnings: ['状态未知'] };
  const warnings = [];
  if (row.paused) warnings.push('已手动暂停');
  // 有结构化的下线信息时以它为准（更具体），否则才退回状态词。
  if (row.status !== 'online' && !row.down) warnings.push(row.reason || ('当前状态：' + statusText(row.status)));
  if (row.native && row.native.available === false) warnings.push('原生搭档当前不可用');
  if (row.native && row.native.toolsVerified === false) warnings.push('原生工具尚未验证：问答可用；文件/桌面任务会按真实工具回执逐项核验，首次成功后自动记为“有通过记录”（未验证不等于能力缺失）');
  if (row.dock && row.failureReason) warnings.push(row.failureReason);
  if (row.healthCheck && row.healthCheck.ok === false) warnings.push(row.healthCheck.reason || '健康检查未通过');
  if (row.down) warnings.push(downText(row.down));
  const unique = [...new Set(warnings.filter(Boolean))];
  const usable = row.status === 'online' && !row.paused && !row.failureReason
    && !(row.native && row.native.available === false)
    && !(row.healthCheck && row.healthCheck.ok === false);
  return { usable, warnings: unique };
}
