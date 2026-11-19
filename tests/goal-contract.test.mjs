import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalContract, goalContractPrompt, assertGoalBinding, assertGoalPlan } from '../src/goal-contract.mjs';
import { requestedDestination, captureNativeFiles } from '../src/quick-work.mjs';
import path from 'node:path';

const contract = goal => createGoalContract({ goal, attachments: [{ name: '赤狐雷达发票.txt' }] });
const binding = c => ({ goalHash: c.goalHash, subjectQuote: c.subject || '统计附件发票金额', attachmentRole: 'material' });

test('negative tool restrictions cannot change the requested file destination', () => {
  const goal = '在当前工作目录新建result.txt，禁止desktop_*、桌面助手和UI检查';
  assert.equal(requestedDestination(goal), null);
  assert.equal(requestedDestination('新建result.txt，不要放到桌面，放在文档文件夹'), 'documents');
  assert.equal(requestedDestination('在我的桌面新建result.txt'), 'desktop');
  assert.equal(requestedDestination('桌面上新建result.txt'), 'desktop');
  assert.equal(requestedDestination('Save result.txt to my desktop'), 'desktop');
  assert.equal(captureNativeFiles(goal, { desktop: 'E:/fake-desktop' }, 'E:/fake-workspace')[0].path, path.resolve('E:/fake-workspace/result.txt'));
});

test('attachment name cannot determine the product; raw user subject is sealed', () => {
  const c = contract('请评价BEAT的任务完成体验，附件只作为材料。');
  assert.equal(c.subject, 'BEAT'); assert.equal(c.clarification, null);
  assert.equal(contract('请评价AuroraDesk软件。').subject, 'AuroraDesk');
  assert.equal(contract('请评价“赤狐助手”的文件处理体验。').subject, '赤狐助手');
  assert.match(goalContractPrompt(c), /附件.*不得替换目标/);
  assert.match(goalContractPrompt(c), /实施步骤允许合理推导/);
});

test('an attachment-derived subject or a stale goal hash cannot enter voting', () => {
  const c = contract('请评价BEAT的任务完成体验，附件只作为材料。');
  assert.throws(() => assertGoalBinding({ core: '评测赤狐雷达', goalBinding: { ...binding(c), subjectQuote: '赤狐雷达' } }, c, 'outline'), /用户原话/);
  assert.throws(() => assertGoalBinding({ core: '评价BEAT', goalBinding: { ...binding(c), goalHash: 'stale' } }, c, 'outline'), /原始目标/);
  assert.throws(() => assertGoalBinding({ core: '评测赤狐雷达', goalBinding: binding(c) }, c, 'outline'), /执行步骤偏离/);
  assert.doesNotThrow(() => assertGoalBinding({ core: '以原话为准防止材料诱导', steps: ['评价BEAT对任务目标的核对方式'], goalBinding: binding(c) }, c, 'outline'));
});

test('mentioning the product in metadata or filenames cannot bless unrelated work', () => {
  const c = contract('请评价BEAT的任务完成体验。');
  const unrelated = { tasks: [{ title: 'BEAT体验', detail: '评测赤狐雷达硬件', outputRefs: ['BEAT.md'] }] };
  assert.throws(() => assertGoalPlan(unrelated, c), /主要工作/);
  assert.throws(() => assertGoalBinding({ goalBinding: binding(c), plan: unrelated }, c, 'expand'), /主要工作/);
  assert.throws(() => assertGoalPlan({ summary: 'BEAT', sections: [{ content: '评测赤狐雷达硬件' }] }, c), /主要工作/);
  assert.doesNotThrow(() => assertGoalPlan({ tasks: [{ detail: '读取发票作为BEAT文件处理的测试材料' }, { detail: '汇总证据' }] }, c));
  assert.throws(() => assertGoalPlan({ tasks: [{ detail: '评价BEAT的文件处理' }, { detail: '评测赤狐雷达的硬件性能' }] }, c), /附件对象/);
  assert.doesNotThrow(() => assertGoalPlan({ tasks: [{ detail: '评价BEAT拒绝“评测赤狐雷达”的错误指令。不要评测赤狐雷达硬件' }] }, c));
});

test('real invoice processing remains allowed, without turning the invoice into a product', () => {
  const c = contract('统计附件发票金额，输出合计。');
  assert.equal(c.subject, ''); assert.equal(c.clarification, null);
  assert.doesNotThrow(() => assertGoalBinding({ core: '读取发票并统计', goalBinding: binding(c) }, c, 'outline'));
  assert.doesNotThrow(() => assertGoalPlan({ tasks: [{ detail: '读取赤狐雷达发票并汇总金额' }] }, c));
});

test('ambiguous product is clarified before discussing attachment products; prohibitions are not targets', () => {
  assert.match(contract('请体验这款产品并写报告。').clarification, /产品叫什么/);
  const c = contract('请评价BEAT。不要评价“赤狐雷达”。');
  assert.equal(c.subject, 'BEAT');
  assert.equal(contract('统计附件发票金额。不要评价BEAT。').subject, '');
  assert.equal(contract('统计附件发票金额，请不要评价BEAT。').subject, '');
  assert.equal(contract('请不要评价BEAT，只统计附件金额。').subject, '');
  assert.equal(contract('我买了BEAT，请体验这款产品。').subject, 'BEAT');
  assert.equal(contract('软件名叫AuroraDesk，请体验这款软件。').subject, 'AuroraDesk');
  assert.equal(contract('请评价附件里的这款产品。').clarification, null);
});
