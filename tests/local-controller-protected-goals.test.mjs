import test from 'node:test';
import assert from 'node:assert/strict';
import {detectGoalRisk,validateLocalDecision,localDecisionPolicy} from '../src/local-controller.mjs';
const proposal=()=>({schemaVersion:1,taskType:'question',risk:{level:'low',reasons:[],money:false,irreversible:false,computerInput:false},flow:{kind:'direct',maxDebates:0,maxRounds:1,maxParallelTasks:1},assignees:{strong:'codex',cheap:[]},budget:{discussionTokens:1000,executionTokens:1000,taskTokens:1000},requiresHuman:false,confidence:.95,reasons:['bounded answer']});
test('unknown outcome of prior input cannot enter automatic continuation; safe readback stays distinct',()=>{
 for(const goal of ['表单提交后超时，不清楚是否成功，请继续完成。','点击转账按钮后掉线，不确定订单状态，接着做。','提交后没反应，继续处理。','充值后页面无响应，接着做。','网页卡死了，无法确认提交是否生效，请重新点一次提交。','授权后结果不明，请继续。','下单后没收到成功提示，再试一次。','The submit button got no response; resume.','The publish button timed out; unsure whether it succeeded. Resume the operation.']){
  const d=proposal();d.taskType='execution';const guarded=validateLocalDecision(d,{goal,partners:['codex']});
  assert.equal(guarded.risk.computerInput,true,goal);assert.equal(guarded.requiresHuman,true);
  assert.equal(localDecisionPolicy(guarded,{goal,partners:['codex'],runKind:'parallel',mode:'low-risk'}).applied,false);
 }
 assert.equal(detectGoalRisk('不知道订单是否成功，只查询当前状态，不操作按钮。').computerInput,false);
});
test('medical/legal decision risk blocks automatic routing without inventing an operation confirmation',()=>{
 for(const goal of ['能否根据检验结果调整胰岛素剂量？','胸痛是否可以在家观察？','今晚该不该停这颗药？','劳动合同需不需要签？','分析收到的律师函后我是否可以完全不回应。','根据合同判断我是否可以立即单方面解约并拒付尾款。','这份合同是否有效，我准备签署。','Can I stop this medication based on the medical report?','Should I stop this pill tonight?','Is this noncompete agreement enforceable?']){
  const d=validateLocalDecision(proposal(),{goal,partners:['codex']});
  assert.equal(d.risk.level,'high',goal);assert.equal(d.requiresHuman,false,goal);
  assert.equal(d.risk.computerInput,false);assert.equal(d.risk.money,false);assert.equal(d.risk.irreversible,false);
  for(const mode of ['low-risk','full'])assert.equal(localDecisionPolicy(d,{goal,partners:['codex'],runKind:'discuss',mode}).applied,false);
 }
});
test('content-risk handling retains all model and operational gates',()=>{
 const goal='判断这份合同是否有效';
 for(const flag of ['money','irreversible','computerInput']){
  const raw=proposal();raw.risk[flag]=true;const d=validateLocalDecision(raw,{goal,partners:['codex']});assert.equal(d.risk[flag],true);assert.equal(d.requiresHuman,true);
 }
 const raw=proposal();raw.requiresHuman=true;assert.equal(validateLocalDecision(raw,{goal,partners:['codex']}).requiresHuman,true);
});
test('ordinary files and bounded quoted-language explanations retain low-risk behavior',()=>{
 for(const goal of ['通过文件接口创建工作区普通笔记。','把工作区两个CSV的表头读出来并比较差异，不覆盖任何原文件。','不要付款也不要购买，只回答什么是自动续费。','核对合同PDF与报价截图的金额、日期是否一致，冲突处列出来。','把化验单整理成表格，不作医学判断。','帮我生成一份空白合同模板。','不转账、不登录网银，只解释转账失败提示可能是什么意思。','只翻译“Can I stop this medication?”成中文。','只解释“停药”的含义。']){
  assert.equal(detectGoalRisk(goal).level,'low',goal);
 }
 assert.equal(detectGoalRisk('只翻译“Can I stop this medication?”成中文，然后判断今晚是否可以停掉抗凝药。').level,'high');
 assert.equal(detectGoalRisk('把化验单整理成表格，不作医学判断，但建议今晚是否停药。').level,'high');
 assert.equal(detectGoalRisk('请帮我转账到客户账号。').money,true);
 for(const goal of ['Transfer $500 to Alex','Pay the electricity bill','Transfer 500 USD to the account','请不要帮我转账，但现在请转账到客户账号。']){
  const d=validateLocalDecision(proposal(),{goal,partners:['codex']});assert.equal(d.risk.money,true,goal);assert.equal(d.requiresHuman,true);assert.equal(localDecisionPolicy(d,{goal,partners:['codex'],runKind:'discuss',mode:'low-risk'}).applied,false);
 }
 for(const goal of ['请不要帮我转账，只解释失败提示。',"Don't pay the electricity bill, just explain the failed transfer notice.",'Transfer 500 files into the workspace.','Pay attention to this report.'])assert.equal(detectGoalRisk(goal).money,false,goal);
});
test('bounded negation never erases later positive requests, double negation or model flags',()=>{
 for(const goal of ['不要付款，但现在购买会员。','不要覆盖原文件，但删除备份。','不要不付款。','不能不购买。','不要不转账。','不应该不删除旧备份。','不应该不转账给客户。','不该不删除备份。'])assert.notEqual(detectGoalRisk(goal).level,'low',goal);
 for(const goal of ['不要付款，只作解释。','不覆盖任何原文件，只读表头。']){
  const raw=proposal();raw.risk.money=true;raw.risk.irreversible=true;raw.requiresHuman=true;
  const checked=validateLocalDecision(raw,{goal,partners:['codex']});assert.equal(checked.risk.money,true);assert.equal(checked.risk.irreversible,true);assert.equal(checked.requiresHuman,true);
 }
});
test('priced subscription activation stays protected even when automatic renewal is disabled',()=>{
 for(const goal of ['开通每月199元的云存储会员，但不要开启自动续费。','激活付费订阅。','Renew the paid subscription.']){
  const raw=proposal();raw.taskType='execution';const checked=validateLocalDecision(raw,{goal,partners:['codex']});assert.equal(checked.risk.money,true,goal);assert.equal(checked.risk.computerInput,true);assert.equal(checked.requiresHuman,true);
 }
 assert.equal(detectGoalRisk('开通0元免费试用。').money,false);
 assert.equal(detectGoalRisk('只解释199元会员的价格，不开通。').money,false);
});

test('用户明确要求搭档只读讨论时入口不降级成单人问答（CX-12）', () => {
  for (const goal of ['请让搭档们只读讨论一下这个方案的取舍，不要改文件。', '让 codex 和 deepseek 一起讨论评审这个设计，只读。', '帮我讨论一下这个接口设计的取舍，不要动任何文件。']) {
    const d = validateLocalDecision(proposal(), { goal, partners: ['codex', 'deepseek'] });
    assert.equal(d.taskType, 'discussion', goal);
    assert.equal(d.flow.kind, 'compact-discussion', goal);
    assert.ok(d.risk.reasons.some(reason => /入口规则/.test(reason)), goal);
  }
  const execRaw = proposal();
  execRaw.taskType = 'execution'; execRaw.flow = { ...execRaw.flow, kind: 'parallel' };
  const exec = validateLocalDecision(execRaw, { goal: '让搭档讨论后新建 a.csv 并写入内容。', partners: ['codex'] });
  assert.equal(exec.taskType, 'execution');
  assert.equal(exec.flow.kind, 'parallel');
  const plain = validateLocalDecision(proposal(), { goal: '什么是自动续费？', partners: ['codex'] });
  assert.equal(plain.taskType, 'question');
  assert.equal(plain.flow.kind, 'direct');
});

test('读取工作区文件并回报的目标按只读执行处理，不降级成纯问答（CX-17）', () => {
  for (const goal of ['读取工作区已有的日志，统计ERROR出现次数，回报数字，不修改日志。', '核对工作区两份报告的金额是否一致，列出不一致项。', '读取附件里的表格并汇总总金额。']) {
    const d = validateLocalDecision(proposal(), { goal, partners: ['codex'] });
    assert.equal(d.taskType, 'execution', goal);
    assert.equal(d.flow.kind, 'direct', goal);
    assert.ok(d.risk.reasons.some(r => /入口规则/.test(r)), goal);
  }
  for (const goal of ['什么是自动续费？', '解释一下这个报错可能的原因。']) {
    const d = validateLocalDecision(proposal(), { goal, partners: ['codex'] });
    assert.equal(d.taskType, 'question', goal);
  }
  const risky = proposal();
  risky.risk = { ...risky.risk, irreversible: true };
  const guarded = validateLocalDecision(risky, { goal: '读取工作区日志后删除旧日志。', partners: ['codex'] });
  assert.equal(guarded.taskType, 'question', '有不可逆标志时不得被入口规则抬升成执行');
});
