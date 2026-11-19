import test from 'node:test';
import assert from 'node:assert/strict';
import {runCustomerIssue,customerIssue} from '../src/customer-issue.mjs';

test('客户端限制、余额和账号池故障在人话提示中区分，包装文本也保留原因',()=>{
 for(const [kind,raw,title,expected] of [
  ['client-restricted','No available accounts: this group only allows Claude Code clients','服务商限制客户端',/开放普通 API/],
  ['balance','INSUFFICIENT_BALANCE','服务商账户余额不足',/充值/],
  ['account-pool','All available accounts exhausted','上游账号池暂无可用账号',/未说明/],
 ]){
  const issue=customerIssue({failureKind:kind,message:raw});
  assert.equal(issue.title,title);assert.match(issue.message,expected);
  assert.equal(customerIssue('桌面搭档未完成：'+raw).title,title);
  assert.doesNotMatch(issue.costStatus,/没有产生模型费用/);
 }
});
test('成功任务的旧失败和代答错误只留诊断，不再冒充当前任务失败',()=>{
 const steps=[{state:'failed',error:'提纲缺少决策 decisions'},{state:'done',error:'上游 HTTP 502',modelVerified:'verified'}];
 assert.equal(runCustomerIssue({state:'passed',steps}),null);
 assert.equal(runCustomerIssue({state:'running',steps}),null);
 assert.equal(steps[0].error,'提纲缺少决策 decisions');
 assert.equal(steps[1].error,'上游 HTTP 502');
 assert.ok(runCustomerIssue({state:'failed',steps}));
});
test('R211 停止提示区分实测和估算，不给恢复或换人重放按钮',()=>{
 const issue=runCustomerIssue({state:'cancelled',error:'用户取消；已写入的文件保留',kind:'parallel',steps:[],tokenUsage:{totalTokens:53424,measuredTokens:19644,estimatedTokens:33780}});
 assert.equal(issue.title,'任务已停止');assert.match(issue.costStatus,/19,644/);assert.match(issue.costStatus,/估算 33,780/);assert.match(issue.costStatus,/不是新增扣费通知/);
 assert.deepEqual(issue.actions.map(a=>a.id),['inspect','dismiss']);
});
