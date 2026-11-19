// 免协商快路径：判据是"验收能否被机器证据完全证明"，不是"任务小不小"。
// 用户裁决原话："能用我们产品的人肯定是希望去做好一个大项目，小任务我只是拿来测试的，
// 小任务都跑不通大任务你敢跑？" —— 所以这里不做"小任务特例"：
// 大项目里同样存在大量"自证得了"的工作单元，它们都该走同一条路。
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCheckCommands, fastPathEligible, buildFastPathPlan, canonicalizeChecks, looksLikePath, namedTestFiles, inferFileScope } from '../src/fast-path.mjs';
import { registeredCheckFor } from '../src/checks.mjs';

test('抠出来的文字必须能通过解析器且文件参数像路径，否则丢弃（实测假阳性回归）', () => {
  const cwd = process.cwd();
  const parse = (c, cmd, d, o) => registeredCheckFor(c, cmd, d, o);
  const r = canonicalizeChecks([
    'node --test 测试，测试',        // 曾被抓成合法命令：把中文说明当文件名
    'node --check util.mjs 验证语法', // 尾巴导致解析失败
    'node --test tests/a.test.mjs',   // 真的
    'node --test 测试',               // 中文名不是路径
  ], { cwd, parse });
  assert.deepEqual(r.kept.map(row => row.command), ['node --test tests/a.test.mjs']);
  assert.equal(r.dropped.length, 3, JSON.stringify(r.dropped));
  assert.ok(r.dropped.every(row => typeof row.reason === 'string' && row.reason.length));
  assert.equal(looksLikePath('测试，测试'), false);
  assert.equal(looksLikePath('tests/a.test.mjs'), true);
  assert.equal(looksLikePath('a.mjs'), true);
  assert.equal(looksLikePath('src/x'), false);
});

test('只在目标点名了可运行的测试文件时才推断自证契约', () => {
  assert.deepEqual(namedTestFiles('交付 a.mjs 与 tests/a.test.mjs，测试通过'), ['tests/a.test.mjs']);
  assert.deepEqual(namedTestFiles('附 a.test.mjs，必须通过'), ['a.test.mjs']);
  assert.deepEqual(namedTestFiles('帮我做个待办工具，测试必须通过'), [], '只写"测试"两个字不算点名文件');
  assert.deepEqual(namedTestFiles('把界面做得好看一点'), []);
});


test('从目标文本里只抽"明确写出的、产品支持的命令"，不做猜测', () => {
  const goal = [
    '在 D:\\work\\demo 下交付一个小工具 linecount.mjs。',
    '验收（必须用这些命令）：',
    '① node --test tests/linecount.test.mjs 退出码 0',
    '② node --check linecount.mjs 退出码 0',
    '③ 结果要好看、代码要优雅',                     // 语义要求：不是命令
    '顺便跑一下 node --test tests/linecount.test.mjs && del /f /q *.*',  // 拼接：不许进快路径
  ].join('\n');
  const commands = extractCheckCommands(goal);
  assert.deepEqual(commands, ['node --test tests/linecount.test.mjs', 'node --check linecount.mjs']);
  assert.equal(commands.some(command => command.includes('&&')), false, '拼接命令不得进入快路径');
});

test('中文分号分隔的多条命令各算一条；英文分号串联仍然拒绝', () => {
  const goal = '交付 stat.mjs。验收命令（必须原样用）：node --test tests/stat.test.mjs；node --check stat.mjs；node stat.mjs sample.txt。';
  assert.deepEqual(extractCheckCommands(goal), [
    'node --test tests/stat.test.mjs',
    'node --check stat.mjs',
    'node stat.mjs sample.txt',
  ]);
  // 英文 ; 是真的 shell 串联，不能进快路径
  assert.deepEqual(extractCheckCommands('验收：node --check a.mjs; node --check b.mjs'), []);
});

test('R172 回归：中文说明里的 pytest 不算命令；目标点名的 .py 主脚本必须进文件范围', () => {
  const goal = '交付一个 JSON 美化脚本 beautify.py（读一个 JSON 文件，输出缩进 2 空格的美化结果）与 tests/test_beautify.py（用 pytest 写）。验收命令（必须原样用）：pytest tests/test_beautify.py。如果本机缺 pytest 或依赖，请自行安装后再跑（你有完全访问权限）。';
  const commands = extractCheckCommands(goal);
  assert.deepEqual(commands, ['pytest tests/test_beautify.py'], '中文句子不得被当成命令：' + JSON.stringify(commands));
  const scope = inferFileScope(commands, goal);
  assert.ok(scope.includes('beautify.py'), '目标点名的主脚本必须在文件范围内：' + JSON.stringify(scope));
  assert.ok(scope.includes('tests/test_beautify.py'));
  // 文件范围太窄会让执行者写主脚本反而被判"越界"（R172 白跑三轮的根因）
  const plan = buildFastPathPlan(goal, commands, { owner: 'deepseek' });
  assert.deepEqual(plan.tasks[0].files, scope);
});

test('只为 node 项目的命令与文件范围：不误吞无关后缀', () => {
  const goal = '交付 clamp.mjs 与 tests/clamp.test.mjs。验收命令：node --test tests/clamp.test.mjs';
  const commands = extractCheckCommands(goal);
  assert.deepEqual(commands, ['node --test tests/clamp.test.mjs']);
  const scope = inferFileScope(commands, goal);
  assert.deepEqual(scope.sort(), ['clamp.mjs', 'tests/clamp.test.mjs']);
});

test('R177 回归：目标里有"机器证不了"的要求（使用说明）时，快路径必须留着它去复核，不能整条丢掉', () => {
  const goal = '做一个记账小工具 expense.mjs 与生成月报的 report.mjs，并提供 tests/report.test.mjs 覆盖三种情况；验收命令（必须原样执行）：node --test tests/report.test.mjs。另外请交付一份简短的使用说明，写明每个命令的用法。';
  const commands = extractCheckCommands(goal);
  assert.deepEqual(commands, ['node --test tests/report.test.mjs']);
  const plan = buildFastPathPlan(goal, commands, { owner: 'codex' });
  // ① 交付物范围要收进使用说明对应的文件，否则执行者写了它反而算越界
  assert.ok(plan.tasks[0].files.includes('README.md'), '使用说明对应的文件必须在文件范围里：' + JSON.stringify(plan.tasks[0].files));
  // ② 机器证不了的要求要变成"文字验收项"，交给非执行者复核（queue-runner 的语义核验通道）
  const text = plan.acceptance.filter(item => item && item.machine === false);
  assert.equal(text.length, 1, '要有且只有一条文字验收项：' + JSON.stringify(plan.acceptance));
  assert.match(text[0].text, /使用说明/);
  assert.equal(plan.requiresModelReview, true, '要标记这次必须由模型复核');
  // ③ 仍然允许走快路径（不能因为多了一条文字要求就退回几百万 token 的协商）
  assert.deepEqual(fastPathEligible(plan, { registered: true, preflightIssues: [] }), { eligible: true, reasons: [] });
  // ④ 但"没说要给谁判"的裸文字验收项仍然不放行（原契约不能松）
  const loose = { tasks: [{ id: 'a', owner: 'codex', title: 'x', files: ['a.mjs'], acceptance: [{ text: '看着顺眼' }] }], acceptance: [{ text: '看着顺眼' }], checks: [] };
  assert.equal(fastPathEligible(loose, { registered: true }).eligible, false, '说不清谁判的验收项必须继续挡住快路径');
});

test('机器证据闭环才算快路径：有一条验收落空就必须走原流程', () => {
  const plan = { checks: ['node --test a.test.mjs'], acceptance: [{ text: '测试通过', check: 'node --test a.test.mjs' }], tasks: [{ id: 'task-1', owner: 'deepseek', eligibleWorkers: ['deepseek'] }] };
  const ok = fastPathEligible(plan, { registered: true });
  assert.equal(ok.eligible, true, JSON.stringify(ok.reasons));

  // ① 有一条只能靠人判断的验收 → 不满足"机器可全证"
  const human = fastPathEligible({ ...plan, acceptance: [...plan.acceptance, '界面要美观'] }, { registered: true });
  assert.equal(human.eligible, false);
  assert.ok(human.reasons.some(reason => /只能靠人|人\/模型/.test(reason)));

  // ② 验收命令没有对应验收项 → 不成立
  const uncovered = fastPathEligible({ ...plan, acceptance: [{ text: 'x', check: 'node --check b.mjs' }] }, { registered: true });
  assert.equal(uncovered.eligible, false);

  // ③ 多个工作单元（需要分工协商）→ 不成立
  const multi = fastPathEligible({ ...plan, tasks: [plan.tasks[0], { id: 'task-2', owner: 'codex', eligibleWorkers: ['codex'] }] }, { registered: true });
  assert.equal(multi.eligible, false);
  assert.ok(multi.reasons.some(reason => /工作单元有 2 个/.test(reason)));

  // ④ 没有可执行验收命令 → 不成立
  assert.equal(fastPathEligible({ ...plan, checks: [] }, { registered: true }).eligible, false);
  // ⑤ 预检没过 → 不成立
  assert.equal(fastPathEligible(plan, { registered: true, preflightIssues: ['PATH_REJECTED'] }).eligible, false);
});

test('构造出的快路径方案与原流程方案同形：单人、单任务、验收与检查一一对应', () => {
  const commands = ['node --test tests/a.test.mjs', 'node --check a.mjs'];
  const plan = buildFastPathPlan('交付 a.mjs 并按命令自证', commands, { owner: 'deepseek' });
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].owner, 'deepseek');
  assert.deepEqual(plan.tasks[0].checks, commands);
  assert.deepEqual(plan.checks, commands);
  assert.equal(plan.tasks[0].dependsOn.length, 0);
  assert.equal(plan.tasks[0].type, 'workspace');
  // 任务级验收与顶层验收一致，且每一条都挂到了命令上（否则队列验收会算成"未验证"）
  const covered = new Set(plan.tasks[0].acceptance.map(item => item.check));
  for (const command of commands) assert.ok(covered.has(command), '验收必须覆盖命令：' + command);
  const verdict = fastPathEligible(plan, { registered: true });
  assert.equal(verdict.eligible, true, JSON.stringify(verdict.reasons));
  assert.throws(() => buildFastPathPlan('x', [], { owner: 'deepseek' }), /至少一条验收命令/);
  assert.throws(() => buildFastPathPlan('x', commands, {}), /需要一个执行方/);
});
