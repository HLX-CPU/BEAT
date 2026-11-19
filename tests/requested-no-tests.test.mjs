import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {assertRequestedTesting,requestedTestingPrompt,createGoalContract,assertGoalPlan,deliveryReviewPrompt} from '../src/goal-contract.mjs';
const goal='创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画。你不需要测试';
test('R211 真实提纲的浏览器自检和人工目检不能进入计划',()=>{
 const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/r211-outlines.json',import.meta.url),'utf8'));
 for(const s of raw)assert.throws(()=>assertRequestedTesting(s.value,goal),/用户明确不需要测试/);
});
test('不测试约束只来自原话，允许文件读回，不把风险术语误当步骤',()=>{
 assert.match(requestedTestingPrompt(goal),/不新增测试步骤/);
 assert.doesNotThrow(()=>assertRequestedTesting({core:'单文件HTML',steps:['绘制SVG和CSS动画','保存index.html并读取文件内容'],risks:['浏览器动画兼容性']},goal));
 assert.doesNotThrow(()=>assertRequestedTesting({steps:['不要浏览器测试','无需测试','核对保存回执和文件内容']},goal));
 assert.throws(()=>assertRequestedTesting({steps:['无需测试，但打开浏览器检查动画']},goal),/不需要测试/);
 assert.doesNotThrow(()=>assertRequestedTesting({steps:['打开浏览器检查动画']},'创建HTML并检查动画'));
 assert.equal(requestedTestingPrompt('不用自动测试，但要进行手动测试'),'');
});
test('R379 回归：用户说不要测试结果时，验收不能要求布局/遮挡/画面等视觉检查，内容读回可以',()=>{
 const goal='凤凰背着十八般兵刃端着盒饭举着鸡腿骑独轮车，不要测试结果，不要联网，不要使用插件，不要使用skill';
 assert.throws(()=>assertRequestedTesting({acceptance:['布局保留主体及道具的辨识空间']},goal),/需要看图/);
 assert.throws(()=>assertRequestedTesting({acceptance:['画面完整、无明显遮挡、观感自然']},goal),/需要看图/);
 assert.doesNotThrow(()=>assertRequestedTesting({acceptance:['文件包含凤凰、十八件兵刃、盒饭、鸡腿和独轮车；读回文件存在']},goal));
});
test('检查命令及局部修订也保持不测试，最终验收只读回产物',()=>{
 const c=createGoalContract({goal});
 assert.throws(()=>assertGoalPlan({tasks:[{detail:'绘制SVG',checks:['node --test a.test.mjs']}]},c),/不需要测试/);
 assert.throws(()=>assertRequestedTesting({patches:[{section:'checks',value:['npm test']}]},goal),/不需要测试/);
 assert.doesNotThrow(()=>assertGoalPlan({tasks:[{detail:'绘制SVG并保存HTML',acceptance:['读取HTML含鹈鹕和自行车以及动画关键帧']}],checks:[]},c));
 assert.match(deliveryReviewPrompt(c),/不启动浏览器/);
});
