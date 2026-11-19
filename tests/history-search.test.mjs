import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/tools.mjs';
test('全历史搜索能命中已载入列表之外的任务并返回上下文', () => {
  const rows = [
    { id:'R1', kind:'ask', state:'done', goal:'帮我整理桌面', result:'已完成', target:'deepseek', created_at:'2026-10-19' },
    { id:'R2', kind:'parallel', state:'passed', goal:'开发一个系统', result:'关键术语只在长结果中间：量子咖啡机 其他内容', target:'codex' },
    { id:'R3', kind:'ask', state:'failed', goal:'其他任务', result:'失败原因\n.beat-control/R3/report.json 内部', target:'deepseek' },
  ];
  const o = { store: { runs: () => rows, get: () => null }, config: {} };
  const out = TOOLS.run_search.run(o, { query:'量子咖啡机', limit: 10 });
  assert.equal(out.total, 1);
  assert.equal(out.items[0].id, 'R2');
  assert.match(out.items[0].snippet, /量子咖啡机/);
  assert.equal(TOOLS.run_search.run(o, { query:'不存在', limit: 10 }).total, 0);
  const limited = TOOLS.run_search.run(o, { query:'R', limit: 1 });
  assert.equal(limited.truncated, true);
  const internal = TOOLS.run_search.run(o, { query:'.beat-control', limit:10 });
  assert.equal(internal.items.length, 0, '内部路径不应进入全历史搜索结果');
  const work = TOOLS.run_search.run(o, { query:'R', kind:'work', limit:10 });
  assert.equal(work.items.every(item => item.kind !== 'ask'), true);
});
