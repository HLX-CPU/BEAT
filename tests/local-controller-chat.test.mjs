import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../src/tools.mjs';
import { Store } from '../src/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = { localController: { enabled:true, mode:'shadow', baseUrl:'http://127.0.0.1:11434', model:'deepseek-r1:14b', timeoutSec:30, keepAlive:'10m' } };
const memoryStore = () => {
  const data = new Map();
  return { get:key => data.get(key) ?? null, set:(key,value) => { if (value === null) data.delete(key); else data.set(key, value); } };
};

test('dashboard local DS chat persists a session and reuses explicit customer corrections', async () => {
  const originalFetch = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models:[{ name:'deepseek-r1:14b' }] }), { status:200 });
    const body = JSON.parse(options.body); requests.push(body);
    return new Response(JSON.stringify({ model:'deepseek-r1:14b', message:{ content:requests.length === 1 ? '第一次回答' : '已经参考纠正' }, prompt_eval_count:10, eval_count:4 }), { status:200 });
  };
  try {
    const o = { config, store:memoryStore() };
    const first = await TOOLS.local_controller_chat.run(o, { message:'怎么判断这个任务？' });
    assert.equal(first.status, 'online'); assert.match(first.sessionId, /^LDS-/); assert.equal(first.messages.length, 2);
    const saved = TOOLS.local_controller_feedback.run(o, { session_id:first.sessionId, message_id:first.message.id, verdict:'incorrect', correction:'应该先确认是否涉及删除。' });
    assert.equal(saved.saved, true); assert.match(saved.note, /不是重新训练/);
    const second = await TOOLS.local_controller_chat.run(o, { session_id:first.sessionId, message:'再判断一次' });
    assert.equal(second.messages.length, 4);
    assert.match(requests[1].messages[0].content, /应该先确认是否涉及删除/);
    assert.equal(TOOLS.local_controller_chat_history.run(o, { session_id:first.sessionId }).messages.length, 4);
  } finally { globalThis.fetch = originalFetch; }
});

test('missing Ollama or model reports local DS offline without breaking BEAT', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect refused'); };
  try {
    const result = await TOOLS.local_controller_chat.run({ config, store:memoryStore() }, { message:'你好' });
    assert.equal(result.status, 'offline'); assert.equal(result.online, false); assert.match(result.reason, /连不上|没有找到/);
  } finally { globalThis.fetch = originalFetch; }
});

test('dashboard exposes visible local DS status, chat and correction controls', () => {
  const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  for (const id of ['localDsState','localDsTraining','localDsChatLog','localDsInput','localDsSend','localDsCorrect','localDsWrong','localDsCorrection','localDsSubmitCorrection']) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /本地 DS 离线/); assert.match(html, /local_controller_chat/); assert.match(html, /local_controller_feedback/); assert.match(html, /local_controller_decision_feedback/);
});

test('task decision feedback becomes local teaching evidence and promotion never happens automatically', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-local-training-'));
  const store = new Store(path.join(dir, 'beat.sqlite')); t.after(() => { store.close(); fs.rmSync(dir, { recursive:true, force:true }); });
  const run = store.createRun({ kind:'parallel', goal:'整理已有说明', cwd:dir, initiator:'codex' });
  store.set('localController:' + run.id, { status:'shadow', decision:{ taskType:'execution', risk:{ level:'low' }, flow:{ kind:'direct' } } });
  const o = { config:{ ...config, root }, store };
  const saved = TOOLS.local_controller_decision_feedback.run(o, { run_id:run.id, verdict:'incorrect', correction:'应该先判断为只读问题，不执行。' });
  assert.equal(saved.saved, true);
  assert.equal(store.get('localControllerDecisionFeedback')[0].runId, run.id);
  const status = TOOLS.local_controller_training_status.run(o, {});
  assert.equal(status.automaticPromotion, false); assert.equal(status.readyForLowRiskReview, false);
  assert.equal(status.criteria.shadowSamples.current, 1); assert.equal(status.criteria.ratedDecisions.current, 1);
});
