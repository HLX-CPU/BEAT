// Conservative routing from observable scope/capabilities, never sentence length.
import fs from 'node:fs';
import path from 'node:path';

export function executableAvailable(executable, env = process.env) {
  if (!executable) return false;
  if (['node', 'node.exe'].includes(executable)) return fs.existsSync(process.execPath);
  const suffixes = process.platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  return (env.PATH || env.Path || '').split(path.delimiter).some(dir => suffixes.some(ext => {
    try { return fs.statSync(path.join(dir, executable + ext)).isFile(); } catch { return false; }
  }));
}

export function assessTask(run, { plan, parsedChecks = [], available = executableAvailable, clarification = null } = {}) {
  const goal = String(run.goal || '');
  const reasons = [];
  if (clarification) reasons.push(clarification);
  const positive = goal.split(/[。；;，,\n]/).filter(s => !/^\s*(?:请)?(?:不要|禁止|不用|不需要)/.test(s)).join('。');
  if (/删除|清空|覆盖所有|转账|付款|支付|上线|生产环境|部署|发布到|批量修改|迁移数据库|卸载/.test(positive)) reasons.push('涉及资金、批量改动或难以撤销的操作，需要先明确影响和执行方案');
  if (/修(?:复|一下)?(?:登录|网络|权限)|优化性能|架构|多个系统|跨系统|接口联调|做得更好|好看一点|优雅/.test(positive)) reasons.push('需要探索环境或协商判断标准，不能靠一句话直接确定执行方案');
  const files = plan?.tasks?.flatMap(t => t.files || []) || [];
  const scoped = files.filter(file => !String(file).includes('*'));
  if (files.some(file => String(file).includes('*')) || new Set(scoped).size > 8) reasons.push('文件影响范围较广，先核对范围和依赖');
  if (!parsedChecks.length) reasons.push('还没有可核验的检查入口');
  for (const check of parsedChecks) {
    if (!available(check.executable || 'node')) reasons.push(`当前环境缺少 ${check.executable || 'node'}，先确认执行能力`);
  }
  if (plan?.tasks?.some(t => t.dependsOn?.length) || plan?.tasks?.length > 1) reasons.push('存在跨任务依赖，需要先协调接口');
  const syntaxOnly = parsedChecks.length > 0 && parsedChecks.every(c => c.check === 'node_syntax' || (c.check === 'exec' && !c.runsProjectCode));
  const facts = { goalSpecified: !!goal.trim() && !clarification, files: [...new Set(files)], capabilities: parsedChecks.map(c => ({ executable: c.executable || 'node', installed: available(c.executable || 'node'), executionVerified: false })), syntaxOnly, independentGoalReview: true };
  return { route: clarification ? 'clarify' : reasons.length ? 'discussion' : 'direct', eligible: reasons.length === 0, reasons: [...new Set(reasons)], facts };
}
