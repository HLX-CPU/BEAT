// Diagnostic categories do not authorize retries. Unknown side effects stay protected.
export function failureRecord({ state, error, result, issues = [], steps = [] }) {
  const errorText = String(error || '').trim();
  const stepErrors = steps.filter(step => step && step.error).map(step => String(step.error).trim()).filter(Boolean);
  const resultText = String(result || '').trim();
  const details = issues.filter(x => typeof x === 'string' && x.trim());
  const verdictDetails = details.slice();
  if (!details.length) for (const step of steps) if (step.error) details.push(String(step.error));
  // 归因只看"错误"本身：验收结果里常写着"由独立搭档复核（未通过）"，
  // 旧实现把它当成"核验搭档不足"（R363-R368 批量误判），客户看到的失败原因完全是错的。
  // 但"失败步骤"里可能留着早已重试成功的早期错误（R408：提纲格式错误早已修好，
  // 真正的失败是验收挂起），所以验收失败时优先用当前验收结论，别把旧错误当成本次原因。
  const text = errorText || (state === 'failed' && verdictDetails.length ? verdictDetails.join('；') : stepErrors.at(-1) || resultText || '');
  let category = 'internal', label = '系统或调用异常';
  if (state === 'interrupted') [category, label] = ['interrupted', '服务中断，进度已保留'];
  else if (/session\s+["']?[\w.-]+["']?\s+does not exist|omit --session-id to start a new Session|原会话已不存在|原会话已不可用|会话在本机找不到了/i.test(text)) [category, label] = ['session', '原会话已不可用'];
  else if (/图片输入没有完成|接口拒绝了本次图片输入|图片输入未启用|图片准备失败|核验图片尚未准备完整|核验搭档未能读取图片/.test(text)) [category, label] = ['image_input', '图片尚未完成独立核验'];
  else if (/is not defined|ReferenceError|TypeError|SyntaxError/.test(text)) [category, label] = ['internal', '系统代码异常'];
  else if (/(?:maximum context length|context length|上下文(?:长度)?超过|requested \d+ tokens)/i.test(text)) [category, label] = ['context', '上下文超过模型上限'];
  else if (/预算|CONTROL_BUDGET/.test(text)) [category, label] = ['budget', '用量保护已停止追加调用'];
  else if (/(?:没有|缺少|不足).{0,8}(?:独立|核验).{0,6}搭档|独立核验搭档不足|至少.{0,4}(?:两位|2\s*位)/.test(text)) [category, label] = ['participants', '独立核验搭档不足'];
  else if (/active writer|active write handle|会话.*占用|会话空闲/i.test(text)) [category, label] = ['session_busy', '原生会话正在使用'];
  else if (/\b429\b|rate limit|quota|限额|限流|额度|out of credits/i.test(text)) [category, label] = ['rate_limit', '提供方额度或限流'];
  else if (/\b40[13]\b|unauthorized|登录|密钥|没有权限/i.test(text)) [category, label] = ['authentication', '账号或权限异常'];
  else if (/timeout|timed out|超时|\b5\d\d\b|ECONN|ENOTFOUND|network|网络|站点\/上游故障|服务端故障/i.test(text)) [category, label] = ['transient', '连接或上游服务异常'];
  else if (state === 'failed') [category, label] = ['acceptance', '验收或审批未通过'];
  return { version: 1, state, category, label, reasonKnown: !!(details.length || text && !/^(?:fail|failed|error|未通过|失败)$/i.test(text)), message: text || '未记录具体原因，请查看步骤和已保存产物',
    issues: [...new Set(details)], failedSteps: steps.filter(s => s.error || s.state === 'failed').map(s => ({ id: s.id, agent: s.agent, role: s.role, error: s.error || null })),
    // An external failure is not evidence that a dispatched write never happened.
    automaticReplayAllowed: false, at: new Date().toISOString() };
}
