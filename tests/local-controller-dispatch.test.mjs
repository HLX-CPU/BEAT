import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOCAL_DISPATCH_SCHEMA_VERSION,
  LOCAL_DISPATCH_JSON_SCHEMA,
  LocalDeepSeekController,
  OpenAICompatibleController,
  dispatchTaskId,
  localDispatchPolicy,
  validateLocalDispatch,
} from '../src/local-controller.mjs';

const tasks = () => ([
  { id: 'task-1', title: '读取输入并写汇总', detail: '读取 input.txt，写 summary.md', files: ['summary.md'], acceptance: ['文件存在'] },
  { id: 'task-2', title: '生成页面', detail: '写 page.html', files: ['page.html'], owner: 'deepseek', acceptance: ['页面包含标题'] },
  { id: 'task-3', title: '扩展坞桌面操作', detail: '用桌面助手打开应用', type: 'desktop', files: [], eligibleWorkers: ['dock:a'], acceptance: ['应用打开'] },
]);

const decision = (assignments) => ({
  schemaVersion: LOCAL_DISPATCH_SCHEMA_VERSION,
  assignments,
  confidence: 0.92,
  reasons: ['按能力和负载分配'],
});

test('分工 schema 独立且要求逐任务覆盖', () => {
  assert.equal(LOCAL_DISPATCH_JSON_SCHEMA.properties.assignments.minItems, 1);
  const list = tasks();
  const value = decision([
    { taskId: 'task-1', owner: 'codex', reason: '适合文件任务' },
    { taskId: 'task-2', owner: 'deepseek', reason: '负责页面' },
    { taskId: 'task-3', owner: 'dock:a', reason: '有桌面能力' },
  ]);
  const checked = validateLocalDispatch(value, { tasks: list, partners: ['codex', 'deepseek', 'dock:a'] });
  assert.equal(checked.assignments.length, 3);
  assert.equal(checked.assignments[2].owner, 'dock:a');
  assert.throws(() => validateLocalDispatch(decision([
    { taskId: 'task-1', owner: 'codex', reason: 'x' },
    { taskId: 'task-2', owner: 'deepseek', reason: 'y' },
  ]), { tasks: list, partners: ['codex', 'deepseek', 'dock:a'] }), /覆盖每一个任务/);
  assert.throws(() => validateLocalDispatch(decision([
    { taskId: 'task-1', owner: 'codex', reason: 'x' },
    { taskId: 'task-1', owner: 'deepseek', reason: 'y' },
    { taskId: 'task-3', owner: 'dock:a', reason: 'z' },
  ]), { tasks: list, partners: ['codex', 'deepseek', 'dock:a'] }), /重复分配/);
  assert.throws(() => validateLocalDispatch(decision([
    { taskId: 'task-1', owner: 'codex', reason: 'x' },
    { taskId: 'task-2', owner: 'outsider', reason: 'y' },
    { taskId: 'task-3', owner: 'dock:a', reason: 'z' },
  ]), { tasks: list, partners: ['codex', 'deepseek', 'dock:a'] }), /不在可用搭档/);
  assert.throws(() => validateLocalDispatch({ ...decision([
    { taskId: 'task-1', owner: 'codex', reason: 'x' },
    { taskId: 'task-2', owner: 'deepseek', reason: 'y' },
    { taskId: 'task-3', owner: 'dock:a', reason: 'z' },
  ]), shell: 'danger' }, { tasks: list, partners: ['codex', 'deepseek', 'dock:a'] }), /不允许的字段/);
});

test('full 模式补空并改派，low-risk 只补空，shadow 只记录', () => {
  const list = tasks();
  const proposed = decision([
    { taskId: 'task-1', owner: 'codex', reason: '文件任务适合 codex' },
    { taskId: 'task-2', owner: 'codex', reason: '页面任务也交给 codex' },
    { taskId: 'task-3', owner: 'deepseek', reason: '桌面任务给 deepseek' },
  ]);
  const full = localDispatchPolicy(proposed, { mode: 'full', tasks: list, partners: ['codex', 'deepseek', 'dock:a'] });
  assert.equal(full.applied, true);
  assert.deepEqual(full.rows.map(row => row.action), ['assigned', 'reassigned', 'rejected']);
  assert.deepEqual(full.patch.map(row => [row.taskId, row.finalOwner]), [['task-1', 'codex'], ['task-2', 'codex']]);
  assert.equal(full.rows[2].finalOwner, 'dock:a');
  assert.match(full.rows[2].detail, /限定了执行搭档/);

  const low = localDispatchPolicy({
    schemaVersion: 1,
    assignments: [
      { taskId: 'task-1', owner: 'codex', reason: '补空' },
      { taskId: 'task-2', owner: 'codex', reason: '想改派' },
    ],
    confidence: 0.9,
    reasons: ['低风险'],
  }, { mode: 'low-risk', tasks: [
    { id: 'task-1', owner: '', title: 'a', files: ['a.txt'] },
    { id: 'task-2', owner: 'deepseek', title: 'b', files: ['b.txt'] },
  ], partners: ['codex', 'deepseek'] });
  assert.equal(low.applied, true);
  assert.deepEqual(low.rows.map(row => row.action), ['assigned', 'kept']);
  assert.equal(low.rows[1].finalOwner, 'deepseek');

  const shadow = localDispatchPolicy(proposed, { mode: 'shadow', tasks: list, partners: ['codex', 'deepseek', 'dock:a'] });
  assert.equal(shadow.applied, false);
  assert.equal(shadow.patch.length, 2);
  assert.match(shadow.reason, /影子/);
});

test('高风险分工建议不应用，只在证据里保留', () => {
  const result = localDispatchPolicy(decision([
    { taskId: 'task-1', owner: 'codex', reason: 'x' },
    { taskId: 'task-2', owner: 'deepseek', reason: 'y' },
    { taskId: 'task-3', owner: 'dock:a', reason: 'z' },
  ]), { mode: 'full', tasks: tasks(), partners: ['codex', 'deepseek', 'dock:a'], highRisk: true });
  assert.equal(result.applied, false);
  assert.match(result.reason, /高风险/);
});

test('本地控制器 dispatch 发送独立 schema 并保留模型证据', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: 'deepseek-r1:14b',
      message: { content: JSON.stringify(decision([
        { taskId: 'task-1', owner: 'codex', reason: '文件任务' },
        { taskId: 'task-2', owner: 'deepseek', reason: '页面任务' },
        { taskId: 'task-3', owner: 'dock:a', reason: '桌面任务' },
      ])) },
      prompt_eval_count: 100,
      eval_count: 40,
    }), { status: 200 });
  };
  const ctl = new LocalDeepSeekController({ mode: 'full' }, { fetchImpl, now: () => 7 });
  const out = await ctl.dispatch({ goal: '做完三件事', tasks: tasks(), availablePartners: ['codex', 'deepseek', 'dock:a'] });
  assert.deepEqual(sent.format, LOCAL_DISPATCH_JSON_SCHEMA);
  assert.match(sent.messages[0].content, /分工控制器/);
  assert.match(sent.messages[0].content, /task-3/);
  assert.equal(out.proposal.assignments.length, 3);
  assert.equal(out.modelVerified, true);
  assert.deepEqual(out.usage, { promptTokens: 100, outputTokens: 40 });
});

test('API 控制器 dispatch 走同一 schema，并校验实际模型', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      model: 'gpt-4o-mini-2024-07-18',
      choices: [{ message: { content: JSON.stringify(decision([
        { taskId: 'task-1', owner: 'codex', reason: '文件任务' },
        { taskId: 'task-2', owner: 'deepseek', reason: '页面任务' },
        { taskId: 'task-3', owner: 'dock:a', reason: '桌面任务' },
      ])) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    }), { status: 200 });
  };
  const ctl = new OpenAICompatibleController({ apiBaseUrl: 'https://relay.example.com/v1', apiModel: 'gpt-4o-mini', timeoutSec: 30 }, { fetchImpl, now: () => 9 });
  const out = await ctl.dispatch({ goal: '做完三件事', tasks: tasks(), availablePartners: ['codex', 'deepseek', 'dock:a'] });
  assert.equal(sent.url, 'https://relay.example.com/v1/chat/completions');
  assert.match(sent.body.messages[0].content, /分工控制器/);
  assert.equal(out.proposal.assignments[2].owner, 'dock:a');
  assert.equal(out.modelVerified, true);
});

test('看板任务详情展示控制器分工证据', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '').replace(/\//g, path.sep)), '..');
  const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  assert.match(html, /function controllerDispatchPanel/);
  assert.match(html, /控制器分工/);
  assert.match(html, /r\.localControllerDispatch/);
  assert.match(html, /方案指定/);
  assert.match(html, /最终执行/);
});

test('dispatchTaskId 与任务队列规则一致', () => {
  assert.equal(dispatchTaskId({ id: 'task-9' }, 0), 'task-9');
  assert.equal(dispatchTaskId({}, 1), 'task-2');
});
