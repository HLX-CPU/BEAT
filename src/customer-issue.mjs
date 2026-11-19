// Customer wording is separate from retained diagnostic/audit records.
import { verificationWaitMessage } from './visual-evidence.mjs';
export function customerIssue(error, { beforeDispatch = false, run, steps = [], tokens, evidence, usage } = {}) {
  const raw = String(error?.message || error || '任务没有完成');
  if (error?.code === 'ASK_REPEAT_DUPLICATE' || /^⛔ 同一句话（含相同附件）在 \d+ 分钟内/.test(raw)) {
    const ids = error?.previousRuns || [...new Set(raw.match(/\bR\d+\b/g) || [])];
    return { title: '已拦下重复提交',
      message: `这条需求刚刚提交过${ids.length ? '（' + ids.join('、') + '）' : ''}，本次没有重复执行。请打开已有任务查看结果；需要补充要求时，在原任务里继续提问。`,
      fileStatus: '本次没有派发执行，未修改文件；原任务的文件和记录保留。',
      costStatus: '本次没有调用模型，没有新增模型费用。已有任务用量请在原任务查看，实际费用以提供方账单为准。',
      actions: [{ id: 'dismiss', label: '知道了' }] };
  }
  // 参数/目标在派发前就被拒绝的错误：没有调用模型、没有碰文件，别套执行期话术。
  const rejectedBeforeDispatch = /(?:to 只能是|问题不能为空|附件文件不存在|这个任务还在跑|这个问答任务是问|模型 ID 无效|先写要追问什么|这个任务当前不能继续|请选择|指定型号)/.test(raw);
  const noDispatch = beforeDispatch || error?.notDispatched === true || rejectedBeforeDispatch;
  // 纯查询错误（任务号不存在）没有派发、没有文件、没有费用：不要把
  // “是否修改文件尚未核实 / 关闭提示”这类执行期话术套上去（R999 实测）。
  if (/找不到任务|no such task|task .* not found/i.test(raw)) return {
    title: '任务号不存在',
    message: '没有找到这个任务号。请从任务列表确认任务号后再查询；本次只是查询，没有派发执行。',
    fileStatus: '本次只是查询，没有修改任何文件。',
    costStatus: '本次没有调用模型，没有产生费用。',
    actions: [{id:'dismiss',label:'关闭提示'}],
  };
  if (beforeDispatch || /to 只能是/.test(raw)) return {
    title: '操作尚未开始', message: /to 只能是/.test(raw) ? '没有找到你指定的搭档。本次未执行，也没有换人；请从搭档列表选择一位可用搭档后提交。' : /PATH_NOT_FOUND|ENOENT|找不到.*文件/i.test(raw)
      ? '没有找到这个文件，请重新选择文件后提交。'
      : /不是有效 JSON|SyntaxError|Unexpected token|JSON at position/i.test(raw)
        ? '请求内容没能正确读取，请重新提交操作。'
        : /^[\x00-\x7F]+$/.test(raw) || /^(Error:|HTTP \d|fetch failed)/i.test(raw)
          ? '请求没有通过检查，请检查填写的内容后重新提交。' : raw,
    fileStatus: '本次没有派发执行，未修改文件。',
    costStatus: '尚未调用模型，本次没有产生模型费用。',
    actions: [{id:'dismiss',label:'关闭提示'}],
  };
  // 旧任务里可能只存了内部原文：同样翻译成人话，不让买家读"文件范围"这种词。
  const rawPlanStructure = /每个文件任务必须划定文件范围|每个小任务必须写清验收标准|任务依赖引用无效/.test(raw);
  const connectionFailures = {
    'client-restricted': ['服务商限制客户端', '服务商将此密钥分组限制为 Claude Code 专用。请联系服务商开放普通 API 调用权限后重新测试；更换模型名称或等待冷却不能解除限制。'],
    balance: ['服务商账户余额不足', '请为服务商账户充值后重新测试。现有连接设置和任务记录已保留。'],
    'account-pool': ['上游账号池暂无可用账号', '服务商的上游账号池暂时没有可用账号，未说明是额度耗尽还是暂时占满。可稍后重新测试，或联系服务商恢复账号池。'],
    auth: ['密钥无效或已失效', '请在此模型设置中更新密钥后重新测试。'],
    permission: ['服务商未开放访问权限', '请联系服务商为此账号开放所选接口或模型的权限，然后重新测试。'],
    'rate-limit': ['服务商限流或额度用尽', '请查看服务商的额度和限流情况，恢复后重新测试。'],
    server: ['服务商暂时异常', '服务商接口暂时没有正常响应。可稍后重新测试；持续失败请联系服务商。'],
  };
  const inferredKind = /限制为 Claude Code 专用|restricted to Claude Code clients|only allows Claude Code clients/i.test(raw) ? 'client-restricted'
    : /上游账号池暂时没有可用账号|all available accounts exhausted/i.test(raw) ? 'account-pool'
    : /账户余额不足|INSUFFICIENT_BALANCE|insufficient (?:account )?balance/i.test(raw) ? 'balance'
    : /服务商拒绝此账号访问/.test(raw) ? 'permission' : null;
  const connectionFailure = connectionFailures[error?.failureKind || inferredKind];
  // 客户不需要看提供方的英文 JSON：把最常见的两类接口错误翻成人话，其余原始内容只留在步骤诊断里。
  const contextOverflow = /(?:maximum context length|context length|上下文(?:长度)?超过|requested \d+ tokens)/i.test(raw);
  const providerServer = !connectionFailure && /站点\/上游故障|服务端故障|HTTP 5\d\d|Bad Gateway|Service Unavailable/i.test(raw);
  const rawProviderError = !connectionFailure && !contextOverflow && !providerServer && /\{"kind"\s*:\s*"error"|"request_id"|"code"\s*:\s*"[A-Z_]+"/.test(raw);
  // DeepSeek 桌面端没登录/没选模型：这是一句能照着做的话，不是内部错误。
  const deepseekNotReady = /无法解析 DeepSeek 默认模型|DeepSeek 桌面端还没有准备好|DeepSeek 登录配置|还没有完成 DeepSeek 登录/.test(raw);
  let message = raw;
  if (connectionFailure) message = connectionFailure[1];
  else if (/workspace routing discovery timed out/i.test(raw)) message = 'Codex 暂时没有响应。可以稍后重试，或者选择其他在线搭档。';
  else if (/PATH_NOT_FOUND|ENOENT|找不到.*文件/i.test(raw)) message = '没有找到这个文件。它可能被移动或改名了，请重新选择文件。';
  else if (/LEASE_STALE|stale.*lease|租约.*陈旧/i.test(raw)) message = '上一次操作可能还没有结束。为避免重复修改文件，BEAT 已暂停。请先查看现有文件，再决定是否继续。';
  else if (contextOverflow) {
    const who = /deepseek/i.test(raw) ? 'DeepSeek' : /codex/i.test(raw) ? 'Codex' : '搭档';
    message = `${who} 这次需要的上下文超过了模型上限，任务没能继续；已完成的内容和记录都保留着。请先核对已有进度，再按页面提供的操作处理；必要时把目标拆小或减少附件。`;
  }
  else if (providerServer) {
    const who = /deepseek/i.test(raw) ? 'DeepSeek' : /codex/i.test(raw) ? 'Codex' : /claude/i.test(raw) ? 'Claude' : '对方';
    const code = /HTTP\s*\d{3}/.exec(raw)?.[0] || '';
    message = `${who} 那边暂时故障${code ? '（' + code + '）' : ''}，不是你的设置或文件问题。请先核对已有文件和记录，再按页面提供的操作处理。`;
  }
  else if (/modelVerified\s*:\s*unknown/i.test(raw)) message = '任务已经返回结果，但暂时无法确认实际使用的是哪个模型。';
  // 系统代理中途被关掉：消息本身已经是人话（含下一步），保留原文，标题单独说清。
  else if (/网络代理没开|NETWORK_PROXY_DOWN/.test(raw)) message = raw;
  else if (/无法解析 DeepSeek 默认模型/.test(raw)) message = 'DeepSeek 桌面端还没有准备好：先打开 DeepSeek Harness 登录一次（之后不用保持运行），再重新开始；也可以改用「拓展坞」接入 DeepSeek API 当搭档。';
  else if (/session\s+["']?[\w.-]+["']?\s+does not exist|omit --session-id to start a new Session|原会话已不存在|原会话已不可用|会话在本机找不到了/i.test(raw)) message = '搭档原来的会话在本机找不到了（可能换了登录目录或会话被清理），这次没有开始执行。这不是你的文件问题，已有产物保留；点「继续」会用新会话接着做，不会重做已完成的文件操作。';
  else if (/timeout|timed out|超时|等待.*超过/i.test(raw)) {
    const last = steps.at(-1);
    const who = /deepseek/i.test(raw) || last?.agent === 'deepseek' ? 'DeepSeek' : /codex/i.test(raw) || last?.agent === 'codex' ? 'Codex' : '执行搭档';
    const elapsed = last?.started_at && last?.ended_at ? Math.round((Date.parse(last.ended_at) - Date.parse(last.started_at))/1000) : null;
    message = /等待超过 2 分钟/.test(raw) ? `${who} 等待超过 2 分钟，仍未返回完整结果。已有进度和记录已保留。` : `${who}${elapsed > 0 ? ' 等待约 ' + elapsed + ' 秒后' : ' 等待超时，'}没有返回完整结果。已有进度和记录已保留。`;
  } else if (/路径越出\s*workspace|PATH_ESCAPE|path escape/i.test(raw)) message = '任务里写到的文件在任务工作目录之外，BEAT 不能读写它。请把这些文件放进任务目录（或用附件上传），或者把路径改成本任务目录内的相对路径；已有记录已保留。';
  else if (/不是有效 JSON|SyntaxError|Unexpected token|括号或逗号不匹配|JSON at position/i.test(raw)) message = '本次操作的内容没能解析成功。请先核对已有文件和记录，再按页面提供的操作处理。';
  else if (/usage limit|quota|rate limit|额度.*(用完|不足)|触发限额/i.test(raw)) message = '有一位搭档的账号额度暂时用完了。请等待额度恢复，先核对已有进度，再按页面提供的操作处理。';
  else if (rawProviderError) message = '有一位搭档的接口返回了错误，任务没有完成。请先核对已有文件和记录，再按页面提供的操作处理。';
  else if (rawPlanStructure) message = '方案里的任务缺少交付文件或验收标准，BEAT 在派发执行前就停住了，没有改动任何文件。已完成的讨论和用量都保留着；点「重新拟方案并继续」会先补全方案再开工，不会重复已有操作。';
  else if (/^[\x00-\x7F]+$/.test(raw) || /^(Error:|HTTP \d|fetch failed)/i.test(raw)) message = '本次操作没有完成。请查看已有记录，核对后选择下一步。';
  // 文案已经明确说“没有派发/没有产生模型费用”的（例如搭档已暂停），费用与文件状态必须一致，不能再说“尚未取得”。
  const declaredNoDispatch = !noDispatch && /本次没有派发|没有产生模型费用|没有新增模型费用/.test(raw);
  const verifiedUnchanged = evidence?.fileChangesVerified === true && evidence?.fileChanges?.length === 0;
  const knownFiles = evidence?.artifacts?.filter(a => a?.path) || [];
  const fileStatus = noDispatch || declaredNoDispatch || verifiedUnchanged || rawPlanStructure ? '本次没有派发执行，未修改文件。' : knownFiles.length ? `已记录 ${knownFiles.length} 个文件产物，已保留；最终验收状态见成果列表。` : run?.access === 'read-only' || run?.kind === 'discuss' ? '本次按只读权限运行，未授权修改文件；未做完整落盘核验。' : '是否修改文件尚未核实，请先查看现有文件，避免重复操作。';
  const total = Number.isFinite(tokens) ? tokens : null;
  const breakdown=usage&&Number.isFinite(usage.measuredTokens)&&Number.isFinite(usage.estimatedTokens)?`其中提供方已返回 ${usage.measuredTokens.toLocaleString('zh-CN')} token，估算 ${usage.estimatedTokens.toLocaleString('zh-CN')} token；`:'';
  const cancelledBeforeCall = run?.state === 'cancelled' && total === null && !(steps || []).length;
  const costStatus = noDispatch ? '尚未调用模型，本次没有产生模型费用。' : declaredNoDispatch ? '本次没有派发执行，没有产生模型费用。' : cancelledBeforeCall ? '取消发生在调用模型之前，未产生模型费用。' : total !== null ? `已记录约 ${total.toLocaleString('zh-CN')} token；${breakdown}这不是新增扣费通知，实际费用以提供方账单为准。` : '模型用量或费用尚未取得，不能确认是否产生费用。';
  const running = run && !['done','passed','failed','error','cancelled','interrupted'].includes(run.state);
  const resumable = ['parallel','discuss'].includes(run?.kind) || run?.kind === 'ask' && (evidence?.verificationOnly || evidence?.fileResumeSafe || run.access === 'read-only');
  let actions = running ? [{id:'wait',label:'继续等待'},{id:'stop',label:'停止任务'}] : run ? [{id:'inspect',label:'查看现有文件'}, ...(resumable ? [{id:'resume',label:evidence?.verificationOnly ? '继续检查已有成果' : '核对后继续原任务'}] : [{id:'change-partner',label:'选择其他在线搭档'}])] : [{id:'dismiss',label:'关闭提示'}];
  if (!running && evidence?.fileResumeSafe && evidence.verificationOnly) actions.push({id:'repair-files',label:'补齐未完成的文件内容'});
  if (/LEASE_STALE|stale.*lease/i.test(raw)) actions.splice(0,actions.length,{id:'inspect',label:'查看现有文件'},{id:'dismiss',label:'暂不继续'});
  // 方案结构失败：给一条真能继续的路（重新拟方案），而不是让"继续"原样重放。
  if (rawPlanStructure && !running) actions = [{id:'resume',label:'重新拟方案并继续'},{id:'inspect',label:'查看现有文件'}];
  // Derive the recovery guidance from the actions actually offered. A failed
  // HTTP call without a task cannot promise a resume button or a safe replay.
  const resumeAction = actions.find(action => action.id === 'resume');
  const nextStep = running ? '可点「继续等待」等待结果，或点「停止任务」停止后续执行。'
    : resumeAction ? `请先点「查看现有文件」核对成果，再点「${resumeAction.label}」处理未完成的部分。`
      : run ? '请点「查看现有文件」核对成果；需要其他搭档时，点「选择其他在线搭档」，只提交尚未完成的内容。'
        : '请关闭提示，在任务列表查看是否已有本次任务；如有，先核对进度和成果，避免重复提交。';
  message = message.replace('请先核对已有文件和记录，再按页面提供的操作处理。', nextStep)
    .replace('请先核对已有进度，再按页面提供的操作处理；', nextStep + '另外，')
    .replace('先核对已有进度，再按页面提供的操作处理。', nextStep);
  const title = connectionFailure ? connectionFailure[0]
    : /接口拒绝了本次图片输入/.test(raw) ? '接口未接受图片输入'
    : /图片输入没有完成|图片输入未启用|图片准备失败|核验图片尚未准备完整|核验搭档未能读取图片/.test(raw) ? '图片尚未完成独立核验'
    : /session\s+["']?[\w.-]+["']?\s+does not exist|omit --session-id to start a new Session/i.test(raw) ? '搭档原会话已不可用'
    : deepseekNotReady ? 'DeepSeek 桌面端还没有准备好'
    : /网络代理没开|NETWORK_PROXY_DOWN/.test(raw) ? '网络代理没开'
    : noDispatch ? '操作尚未开始'
    : /modelVerified\s*:\s*unknown/i.test(raw) ? '实际模型暂未确认'
    : contextOverflow ? '任务内容超过模型上限'
    : providerServer ? '对方服务暂时故障'
    : rawPlanStructure ? '方案缺了要交付的文件，还没开工'
    : rawProviderError ? '搭档接口返回错误'
    : '任务没有完成';
  return { title, message, fileStatus, costStatus, actions };
}
export function runCustomerIssue(view) {
  if (view.state === 'failed' && view.newFilePreflight?.pass === false) {
    const issue = customerIssue('已有同名文件，尚未开始写入', { run: view, tokens: view.tokenUsage?.totalTokens, usage: view.tokenUsage });
    const files = view.newFilePreflight.files.filter(file => file.existedBefore).map(file => file.path);
    return { ...issue, title: '同名文件已存在，尚未写入',
      message: '这些文件已经存在，已保留原样：\n' + files.join('\n') + '\n请给新文件起一个不同名称后再次提交。',
      fileStatus: '本次尚未派发文件写入，没有覆盖或删除原文件。',
      actions: [{ id: 'inspect', label: '查看现有文件' }] };
  }
  // 方案结构失败（新任务带错误码）：讨论已结束、执行从未开始，给一条真能继续的路。
  if (view.failureCode === 'PLAN_STRUCTURE') {
    const kind = view.failureStructureKind;
    const missing = kind === 'acceptance' ? '验收标准' : kind === 'dependencies' ? '任务依赖' : '要交付的文件';
    const base = customerIssue(view.error || '方案结构不完整', { run: view, steps: view.steps, tokens: view.tokenUsage?.totalTokens, evidence: view.quickWorkEvidence, usage: view.tokenUsage });
    return { ...base, severity: 'warning', title: '方案缺了' + missing + '，还没开工',
      message: '几位搭档讨论完了，但方案里的任务没有写清' + missing + '。BEAT 为了不改动任务目录外的文件，没有派发执行，也没有修改任何任务文件。\n\n已完成的讨论和用量都保留着。点「重新拟方案并继续」会先让搭档补上' + missing + '，再重新开工；不会重复已完成的文件操作。',
      fileStatus: '本次没有派发执行，未修改任务文件。',
      actions: [{ id: 'resume', label: '重新拟方案并继续' }, { id: 'inspect', label: '查看现有文件' }] };
  }
  const pendingVerification = (view.taskQueue || []).filter(task => (task.state || task.status) === 'verifying');
  if (view.state === 'failed' && pendingVerification.length) {
    const base = customerIssue('独立核验尚未完成', { run:view, steps:view.steps, tokens:view.tokenUsage?.totalTokens, evidence:view.quickWorkEvidence, usage:view.tokenUsage });
    const unfinished = (view.taskQueue || []).some(task => ['queued','blocked','failed'].includes(task.state || task.status));
    return { ...base, severity:'warning', title:'已有成果保留，部分核验尚未完成', message:pendingVerification.map(task => `${task.title || task.id}：${verificationWaitMessage(task)}`).join('\n') + (unfinished ? '\n还有未完成的步骤；继续原任务时会接着处理，已完成的步骤保留。' : ''), actions:[{id:'resume',label:unfinished?'核对后继续原任务':'继续检查已有成果'},{id:'inspect',label:'查看现有文件'}] };
  }
  if(view.recovery?.mode==='verification-only'){
    const issue=customerIssue(view.recovery.message,{run:view,tokens:view.tokenUsage?.totalTokens,evidence:{artifacts:view.recovery.artifacts,verificationOnly:true},usage:view.tokenUsage});
    return {...issue,severity:'warning',title:'已有成果可重新检查',message:view.recovery.message,actions:[{id:'resume',label:'重新检查已有成果'},{id:'inspect',label:'查看现有文件'}]};
  }
  const active = !['done','passed','failed','error','cancelled','interrupted'].includes(view.state);
  const reconnecting = active && view.steps?.findLast(s => s.state === 'running' && (s.transport || s.data?.transport)?.status === 'reconnecting');
  if (reconnecting) {
    const connection = reconnecting.transport || reconnecting.data.transport;
    const issue = customerIssue('Codex 连接中断', { run:view, steps:view.steps, tokens:view.tokenUsage?.totalTokens, evidence:view.quickWorkEvidence,usage:view.tokenUsage });
    return { ...issue, title:'Codex 正在重新连接', message:`Codex 的响应连接暂时中断，正在原会话内重新连接${connection.attempt ? `（第 ${connection.attempt}/${connection.maxAttempts} 次）` : ''}。BEAT 没有重新派发任务，也没有更换模型。`, actions:[{id:'wait',label:'继续等待'},{id:'stop',label:'停止任务'}] };
  }
  const waiting=view.steps?.findLast(s=>{
    const connection=s.transport||s.data?.transport;
    const since=connection?.status==='recovered'&&Number.isFinite(Date.parse(connection.at))?connection.at:s.started_at;
    return s.state==='running'&&Number.isFinite(Date.parse(since))&&Date.now()-Date.parse(since)>=120000;
  });
  const unknown = view.steps?.some(s => s.state === 'done' && s.requestedModel && s.modelVerified === 'unknown');
  if (unknown && ['passed','done'].includes(view.state) && !view.error) {
    const issue=customerIssue('modelVerified: unknown',{run:view,tokens:view.tokenUsage?.totalTokens,evidence:view.quickWorkEvidence,usage:view.tokenUsage});
    return {...issue,severity:'warning',title:view.state==='passed'?'成果已核验，实际模型待确认':'答复已返回，实际模型待确认',message:'本次实际使用的模型身份暂未确认。请求模型和已有证据保留在完整过程里，不会把它标记为已确认的模型。',actions:[{id:'dismiss',label:'知道了'}]};
  }
  // Recovered attempts and delegates retain errors for audit, but they do not
  // make an otherwise completed or still-progressing task a failed task.
  const problem = view.error || (['failed','error','interrupted'].includes(view.state)?view.steps?.findLast(s=>s.error)?.error:null) || (waiting&&active?`${waiting.agent||'执行搭档'} 等待超过 2 分钟，没有返回完整结果。`:unknown ? 'modelVerified: unknown' : null);
  if (!problem && !['failed','error','interrupted'].includes(view.state)) return null;
  // 验收没通过时，客户最需要知道"还差什么、下一步点哪里"，而不是一句笼统的"任务没有完成"。
  const acceptance = (() => {
    if (!(view.state === 'failed' && view.kind === 'parallel')) return null;
    const lines = String(view.result || '').split('\n').map(line => line.trim())
      .filter(line => line.startsWith('❌') && !/^❌\s*(?:仍有小任务|整体结果未通过|任务没有通过)/.test(line));
    if (!lines.length) return null;
    const items = lines.slice(0, 3).map(line => line.replace(/^❌\s*/, '').split('｜')[0].trim().slice(0, 80)).filter(Boolean);
    return { count: lines.length, items };
  })();
  if (!problem && acceptance) {
    const base = customerIssue('任务没有通过验收，已有产物已保留。', { run: view, steps: view.steps, tokens: view.tokenUsage?.totalTokens, evidence: view.quickWorkEvidence, usage: view.tokenUsage });
    return { ...base, title: '任务没有通过验收（已有产物保留）', message: `这次有 ${acceptance.count} 项验收没有通过${acceptance.items.length ? '：\n- ' + acceptance.items.join('\n- ') : ''}\n\n已生成的文件都保留着；点「核对后继续原任务」会从未完成的步骤继续，已完成的步骤不会全部重做。` };
  }
  const issue=customerIssue(problem || '任务尚未通过验收，已有产物已保留。', {run:view,steps:view.steps,tokens:view.tokenUsage?.totalTokens,evidence:view.quickWorkEvidence,usage:view.tokenUsage});
  if(view.state==='cancelled')return {...issue,title:'任务已停止',message:'你已停止这个任务。BEAT 保留已有文件和记录，不会自动重新执行。',actions:[{id:'inspect',label:'查看现有文件'},{id:'dismiss',label:'知道了'}]};
  return issue;
}
