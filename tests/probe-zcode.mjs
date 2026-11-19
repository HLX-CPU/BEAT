// ZCode CLI 探针：真实调用 zcode CLI（消耗少量额度），为适配器取证。不进 npm test。
// 用法：node tests/probe-zcode.mjs
// 取证三件事：
//   1) -p --json 的输出事件形状（sessionId / text / usage / model / 工具调用事件）
//   2) --resume 已有会话后换 --mode，沙箱是否随每次调用生效（决定 POLICY_PINNED_SESSIONS）
//   3) --mode build 无头运行是否会挂审批
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CLI = 'D:\\ZCODE\\resources\\glm\\zcode.cjs';
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-probe-'));
const log = [];
const record = (step, data) => { log.push({ step, ...data }); console.log(`\n===== ${step} =====`); console.log(JSON.stringify(data).slice(0, 3000)); };

function run(args, { input, timeoutMs = 240_000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: workdir, env: process.env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e) }); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

const parseLines = stdout => stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l.slice(0, 200) }; } });

// ── 探针 1：plan 模式小提问，看输出形状 ──
const r1 = await run(['-p', '只回复两个字母：OK', '--json', '--mode', 'plan']);
const lines1 = parseLines(r1.stdout);
record('probe1-plan-shape', { code: r1.code, lineCount: lines1.length, lines: lines1, stderr: r1.stderr.slice(0, 800) });

// 找 sessionId：任何字段里长得像 sess_ 的
const findSession = lines => {
  for (const l of lines) {
    const hit = JSON.stringify(l).match(/sess_[A-Za-z0-9._-]+/);
    if (hit) return hit[0];
  }
  return null;
};
const sessionId = findSession(lines1);
record('probe1-session', { sessionId });

// ── 探针 2：--resume 同一会话换 --mode build，要求写文件（沙箱随调用生效？）──
if (sessionId) {
  const r2 = await run(['-p', `在工作目录创建文件 hello-zcode.txt，内容正好是 hi。创建完成后只回复：已创建`, '--json', '--mode', 'build', '--resume', sessionId]);
  const lines2 = parseLines(r2.stdout);
  const wrote = fs.existsSync(path.join(workdir, 'hello-zcode.txt'));
  record('probe2-resume-mode-switch', { code: r2.code, wroteOnResumedSession: wrote, lines: lines2.slice(-12), stderr: r2.stderr.slice(0, 800) });

  // ── 探针 3：全新会话直接 build（对照组：写权限在新建会话上是否直接可用）──
  const r3 = await run(['-p', `在工作目录创建文件 fresh-build.txt，内容正好是 ok。创建完成后只回复：已创建`, '--json', '--mode', 'build']);
  const lines3 = parseLines(r3.stdout);
  const wrote3 = fs.existsSync(path.join(workdir, 'fresh-build.txt'));
  record('probe3-fresh-build', { code: r3.code, wroteOnFreshSession: wrote3, sessionId: findSession(lines3), lines: lines3.slice(-12), stderr: r3.stderr.slice(0, 800) });
} else {
  record('probe2-skipped', { reason: 'probe1 未取得 sessionId' });
}

fs.mkdirSync('E:/beat/output', { recursive: true });
fs.writeFileSync('E:/beat/output/zcode-probe.json', JSON.stringify({ workdir, log }, null, 2));
console.log('\n证据已写入 E:/beat/output/zcode-probe.json；临时目录：', workdir);
