// 试验 4：判别性实验——/model 斜杠命令在 -p 下是否生效；个人配置文件是否被读取。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CLI = 'D:\\ZCODE\\resources\\glm\\zcode.cjs';
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-model4-'));
const cfgFile = path.join(workdir, 'provider_config.json');

function run(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: workdir, env: { ...process.env, ...env } });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// ① 未知的 --model flag：报 "Unknown option" 就说明不支持
const r0 = await run(['-p', 'OK', '--model', 'zai/glm-5.3']);
console.log('=== --model flag → exit', r0.code, '===');
console.log((r0.err || r0.out).slice(0, 400), '\n');

// ② 坏 JSON 的个人配置：报解析错误=文件被读；照旧 "Select a model"=没读
fs.writeFileSync(cfgFile, '{ this is not json !!!');
const r1 = await run(['-p', '只回复OK', '--json', '--mode', 'plan'], { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: cfgFile });
console.log('=== broken personal config → exit', r1.code, '===');
console.log((r1.err || r1.out).slice(0, 400), '\n');

// ③ /model 斜杠命令前缀
const r2 = await run(['-p', '/model\n\n只回复OK', '--json', '--mode', 'plan']);
console.log('=== /model prefix → exit', r2.code, '===');
console.log((r2.out || r2.err).slice(0, 1200), '\n');

// ④ /model 带值
const r3 = await run(['-p', '/model zai/glm-5.3\n\n只回复OK', '--json', '--mode', 'plan']);
console.log('=== /model zai/glm-5.3 → exit', r3.code, '===');
console.log((r3.out || r3.err).slice(0, 1200));
