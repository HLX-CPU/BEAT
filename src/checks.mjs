// 验收命令：Codex/DeepSeek 的沙箱里往往不能启动子进程（node --test 会 spawn EPERM），
// 所以由 BEAT 在沙箱外、工作目录内实际运行双方商定的 checks，把真实输出交给执行方和评估方。
import { spawn } from 'node:child_process';
import { killTree } from './proc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { bounded, walkFiles, globToRegExp } from '../workspaces/shared/desktop-assistant/core/security.mjs';
import { ROOT } from './config.mjs';

// ---------- 验收命令通道（可注册） ----------
// 只认 node 会让 python / go / cargo 等项目的"自动验收"整条链路退化成模型自评，
// 于是出现"产物正确却被判失败"和长时间评估拉锯。这里把入口改成可注册的清单：
//   - 清单里的程序只能以清单声明的固定子命令形式运行（不接受任意参数）
//   - 用户写的 token 必须与声明的固定 token **逐一相同**；只有声明里的 {file} 处才换成明确文件。
//     绝不"跳过前缀不核对"：那样 `python -m pytest x.py` 会被静默改写成
//     `python -m py_compile x.py`（功能测试命令被当成语法检查跑，还显示"通过"），
//     `go build` 会被改写成 `go test`、`mytool other` 会变成 `mytool check`（实测 probe E）。
//   - 文件参数一律 bounded() 限制在工作目录内；不接受通配符、绝对路径、上跳、任意 flags
//   - 参数里出现 {file} 时，该命令属于"会执行项目代码"，由桌面助手走一次性人工短码确认
//   - node --test 的参数全是明确文件（无通配符、无自动发现）时范围已确定，由 BEAT 直接执行，
//     不再要求人工确认；自动发现/通配符仍是项目级范围，保留确认。放宽会写进 degradedReason 留痕
//   - 所有既有拦截（拼接、重定向、反引号、递归 npm、超时）保持不变
export const DEFAULT_CHECK_EXEC = {
  python: { kind: 'syntax', sub: ['-m', 'py_compile'], ext: ['.py'] },
  python3: { kind: 'syntax', sub: ['-m', 'py_compile'], ext: ['.py'] },
  pytest: { kind: 'tests', sub: [], ext: [] },
  go: { kind: 'tests', sub: ['test'], ext: [] },
  cargo: { kind: 'tests', sub: ['test'], ext: [] },
  dotnet: { kind: 'tests', sub: ['test'], ext: [] },
};

// 同一程序可以有不止一条固定子命令：python 既能跑 `-m py_compile`（语法），也能跑
// `-m pytest 明确文件`（功能）。这些 token 写死在代码里，与配置注册走同一套核对：
// token 必须逐一相同，{file} 及追加参数只能是工作目录内的明确文件（不接受 flags、通配符、越界）。
// 只有该程序本身已在清单里（exec 有同名 key）时才生效：用户的清单里没有这个程序就一条都不放行。
const EXTRA_SUBCOMMANDS = {
  python: [{ kind: 'tests', sub: ['-m', 'pytest'], ext: ['.py'] }],
  python3: [{ kind: 'tests', sub: ['-m', 'pytest'], ext: ['.py'] }],
};

// 检查类别：语法通过**不能**当成功能/行为通过。结果与描述都只从这里取类别。
const CHECK_KINDS = new Set(['syntax', 'functional', 'capability', 'unknown']);
const kindOfSpec = spec => {
  if (!spec) return 'unknown';
  if (spec.checkKind && CHECK_KINDS.has(spec.checkKind)) return spec.checkKind;
  if (spec.check === 'node_version') return 'capability';
  if (spec.check === 'node_syntax') return 'syntax';
  if (spec.check === 'project_tests') return 'functional';
  if (spec.kind === 'tests') return 'functional';
  if (spec.kind === 'capability') return 'capability';
  return 'syntax';
};

const checkExecSpecs = flow => {
  const raw = flow?.checkExec, out = { ...DEFAULT_CHECK_EXEC };
  if (raw === false) return {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [name, spec] of Object.entries(raw)) {
      const key = path.basename(String(name || '')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
      if (!key || !spec || typeof spec !== 'object') continue;
      const sub = Array.isArray(spec.sub) ? spec.sub.map(String) : [];
      const ext = Array.isArray(spec.ext) ? spec.ext.map(s => String(s).toLowerCase()) : [];
      // kind 支持 tests/functional（功能）、capability（能力探测）、syntax（语法，默认）。
      const rawKind = String(spec.kind || '').toLowerCase();
      const kind = rawKind === 'capability' ? 'capability' : rawKind === 'tests' || rawKind === 'functional' ? 'tests' : 'syntax';
      if (sub.some(a => /[;&|`<>$%\r\n]/.test(a))) continue;
      if (kind === 'tests' || sub.length) out[key] = { kind, sub, ext, file: spec.file === true };
    }
  }
  return out;
};

const checkFileArg = (cwd, arg, { allowMissing = false } = {}) => {
  const raw = String(arg || '');
  if (!raw || raw.startsWith('-')) throw new Error('检查文件名不能作为命令参数，未执行');
  // `./--help` 这种"带路径前缀的横杠文件名"能绕过上面那层：node --check ./--help 会把 ./--help
  // 当普通文件、**什么都不检查就返回 0**，于是一个语法错的文件被判"通过"（实测）。
  // 凡是 basename 以横杠开头的，一律拒绝：既可能被当成选项，也可能被 node 静默忽略。
  if (/^[.\\/]*[-]+/.test(raw)) throw new Error('检查文件名不能以横杠开头（会被当成命令选项，导致检查没真正执行），未执行');
  if (/[?*\[\]{}]/.test(raw)) throw new Error('检查文件名不接受通配符，未执行；请写明具体文件');
  // 目标里写绝对路径是常见写法（尤其用户给的是绝对交付目录）。只要落在工作目录内，
  // 就归一成相对路径再执行；越界仍然拒绝——bounded 负责这一层判断。
  if (path.isAbsolute(raw)) {
    const resolved = bounded(cwd, raw, { exists: !allowMissing });
    const rel = path.relative(cwd, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('检查文件名必须是工作目录内的相对路径，未执行');
    return rel.replaceAll('\\', '/');
  }
  bounded(cwd, raw, { exists: !allowMissing });
  return raw;
};

const PY_MODULE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
// 该程序在清单里注册的全部固定子命令：配置/默认清单里的那条，加上代码里写死的附加子命令。
// 候选全部来自清单本身，不会因为用户写的内容临时拼出别的命令。
const execSpecsFor = (executable, exec) => {
  const primary = exec?.[executable];
  if (!primary || typeof primary !== 'object') return [];
  return [primary, ...(EXTRA_SUBCOMMANDS[executable] || [])];
};
const specLabel = spec => (Array.isArray(spec?.sub) ? spec.sub : []).map(t => (t === '{file}' ? '明确文件' : t)).join(' ') || '（无固定子命令）';

// 固定 token 逐一核对；只有声明里的 {file} 处才从用户写法里取一个文件参数。
const matchSpecSub = (parts, spec) => {
  const subs = Array.isArray(spec.sub) ? spec.sub : [];
  const out = [];
  let cursor = 0;
  for (const token of subs) {
    if (token === '{file}') {
      if (cursor >= parts.length) return null;
      out.push({ file: parts[cursor++] });
      continue;
    }
    if (parts[cursor] !== token) return null;
    out.push(token); cursor++;
  }
  return { out, rest: parts.slice(cursor) };
};

const matchExecCheck = (cwd, executable, parts, exec, { allowMissing = false } = {}) => {
  const specs = execSpecsFor(executable, exec);
  if (!specs.length) return null;
  // python -m unittest [-v] 模块名：模块名不带 .py，不能当成文件路径处理。
  // 保留用户实际写的命令：旧实现把 `-m unittest test_x` 改写成 `-m unittest -v test_x`。
  if (['python', 'python3'].includes(executable) && parts[0] === '-m' && parts[1] === 'unittest') {
    const args = ['-m', 'unittest'], modules = [];
    for (const token of parts.slice(2)) {
      if (token === '-v' || token === '--verbose') { args.push(token); continue; }
      if (!PY_MODULE.test(token)) throw new Error('python -m unittest 只接受模块名（如 test_wordstat），未执行');
      modules.push(token); args.push(token);
    }
    if (!modules.length) throw new Error('python -m unittest 只接受模块名（如 test_wordstat），未执行');
    return { check: 'exec', executable, args, file: modules[0] + '.py', checkKind: 'functional', runsProjectCode: true, planned: allowMissing };
  }
  for (const spec of specs) {
    const matched = matchSpecSub(parts, spec);
    if (!matched) continue;
    const ext = Array.isArray(spec.ext) ? spec.ext : [];
    const args = [], files = [];
    for (const token of matched.out) {
      if (token && typeof token === 'object') { const file = checkFileArg(cwd, token.file, { allowMissing }); files.push(file); args.push(file); continue; }
      args.push(token);
    }
    // 固定子命令之后的参数只能是明确文件：flags（-x / --tb=short）、通配符、目录、越界路径都在这里被拒。
    for (const token of matched.rest) { const file = checkFileArg(cwd, token, { allowMissing }); files.push(file); args.push(file); }
    if (ext.length) {
      if (!files.length) throw new Error(`该检查需要明确的文件参数（${executable} ${specLabel(spec)}），未执行`);
      if (files.some(f => !ext.some(suffix => String(f).toLowerCase().endsWith(suffix)))) throw new Error('该检查只接受 ' + ext.join('/') + ' 文件，未执行');
    }
    const checkKind = kindOfSpec(spec);
    return { check: 'exec', executable, args, file: files[0] || null, kind: spec.kind, checkKind, runsProjectCode: checkKind === 'functional' || matched.out.some(t => t && typeof t === 'object'), planned: allowMissing };
  }
  // 程序已注册，但用户写的固定 token 不在清单里：拒绝，**绝不**改成清单里的另一条子命令。
  throw new Error(`该检查子命令未注册，未执行：${executable} 只接受清单声明的固定子命令（${specs.map(specLabel).join('；')}）；不会把用户写的参数改写成别的子命令。文件参数须是工作目录内的明确文件，不接受 flags、通配符或越界路径`);
};

export function registeredCheckFor(cwd, command, depth=0, { allowMissing = false, exec = DEFAULT_CHECK_EXEC } = {}) {
  if(depth>0&&/^\s*["']?npm(?:\.cmd)?(?:["']?\s)/i.test(String(command)))throw new Error('检查入口不能递归调用 npm，未执行');
  const text=String(command||'').trim();
  if(!text || /[;&|<>`$%\r\n]/.test(text))throw new Error('检查命令包含不支持的拼接或输入，已阻止执行；请改用独立的语法检查或测试检查');
  const parts=[];const pattern=/"([^"]*)"|'([^']*)'|([^\s"']+)/g;let end=0;
  for(const m of text.matchAll(pattern)){if(text.slice(end,m.index).trim())throw new Error('检查命令引号不完整');parts.push(m[1]??m[2]??m[3]);end=m.index+m[0].length;}
  if(text.slice(end).trim())throw new Error('检查命令引号不完整');
  const executable=path.basename(parts.shift()||'').toLowerCase();
  if(depth>0&&['npm','npm.cmd'].includes(executable))throw new Error('检查入口不能递归调用 npm，未执行');
  if(executable==='npm'||executable==='npm.cmd'){
    const key=parts.join(' ')==='test'?'test':parts[0]==='run'&&parts.length===2?parts[1]:null;
    if(!['test','lint','check','format:check'].includes(key))throw new Error('该检查入口尚未注册，已阻止任意命令执行');
    const file=bounded(cwd,'package.json',{exists:true}),script=JSON.parse(fs.readFileSync(file,'utf8')).scripts?.[key];
    if(typeof script!=='string'||/^\s*npm\b/.test(script))throw new Error('检查入口缺少可明确核验的命令；请由执行搭档补齐独立测试入口');
    return registeredCheckFor(cwd,script,depth+1,{allowMissing,exec});
  }
  if(!['node','node.exe'].includes(executable)){
    const bridged=matchExecCheck(cwd,executable,parts,exec,{allowMissing});
    if(bridged)return bridged;
    const listed=Object.keys(exec);
    // 看板设置里没有"验收命令通道"这个入口（settings_set 会把 flow.checkExec 丢弃），
    // 原来的提示把人引到一个不存在的开关上，还让人手改配置重启。这里只写真实可行的做法：
    // 说清缺的是"哪个程序的已注册入口"，下一步由执行搭档改用受支持的入口。
    throw new Error(`该检查工具尚未注册，未执行。缺少的能力：本机没有可核验「${executable}」的已注册检查入口。可用：node（--version / --check 明确文件 / --test 明确测试文件）${listed.length?'、'+listed.join('、'):''}。下一步由执行搭档改用受支持的入口：node --check 明确文件、node --test 明确测试文件，或用清单里已注册的程序检查明确文件；相对路径按工作目录解析，绝对路径若在工作目录内会被归一化`);
  }
  if(parts.length===1&&parts[0]==='--version')return {check:'node_version'};
  // 语法检查的文件参数统一走 checkFileArg：那里挡了"横杠开头的文件名"（`./--help` 这种
  // node --check 会静默不检查却返回 0，实测曾把语法错的文件判成通过）。
  // allowMissing 时按"计划期"处理：只做边界与形状校验，不要求文件已存在。
  if(parts.length===2&&parts[0]==='--check'){const file=checkFileArg(cwd,parts[1],{allowMissing});if(allowMissing)return {check:'node_syntax',file,planned:true};return {check:'node_syntax',file};}
  if(parts[0]==='--test'&&parts.slice(1).every(p=>p&&!p.startsWith('-'))){
    let files=parts.slice(1);
    if(allowMissing){files.forEach(f=>bounded(cwd,f,{exists:false}));return {check:'project_tests',files,planned:true};}
    let autoScope=false;
    if(!files.length||files.some(p=>/[?*]/.test(p))){
      // 通配符 / 未写文件（自动发现）都是"项目级范围"，无法在计划期确定要跑哪些文件，
      // 因此保留人工范围确认。只有参数全是明确文件时才由 BEAT 直接执行（见 runChecks）。
      autoScope=true;
      const all=walkFiles(cwd,{maxFiles:2001});if(all.length>2000)throw new Error('测试范围太大，未运行；请由执行搭档明确本任务的测试入口');
      const patterns=files.map(globToRegExp);files=all.map(f=>path.relative(cwd,f).replaceAll('\\','/')).filter(f=>patterns.length?patterns.some(p=>p.test(f)):/(?:^|\/)(?:test[^/]*|[^/]+[.-]test)\.(?:mjs|cjs|js)$/.test(f));
    }
    if(!files.length)throw new Error('没有找到本任务可核验的测试文件，未运行检查');
    files.forEach(f=>bounded(cwd,f,{exists:true}));
    // 明确文件的返回对象保持原样（既有断言依赖它的形状）；只有自动发现/通配符才多带 autoScope。
    return autoScope?{check:'project_tests',files,autoScope:true}:{check:'project_tests',files};
  }
  throw new Error('检查参数不属于已注册的安全检查，未执行；请改成 node --check 文件 或 node --test 明确测试文件');
}

// Use the exact registered grammar before execution. Planned output files may
// not exist yet; execution still revalidates real files and confirmation.
export function preflightCheck(cwd, command, options = {}) {
  return registeredCheckFor(cwd, command, 0, { allowMissing: true, exec: options.exec || DEFAULT_CHECK_EXEC });
}

const flowExec = () => {
  // 这里**只需要读** config.json 的 flow.checkExec 一项。
  // 早先写的是 loadConfig().flow —— loadConfig 有副作用：缺令牌时它会生成并**写入**
  // secrets.local.json。于是"跑一次检查"这种只读动作会往产品目录里塞文件
  //（实测：出厂自检跑完，包根多出一个 secrets.local.json）。
  // 只读的场景就读文件，不要走带写入的加载路径。
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    return checkExecSpecs(JSON.parse(raw).flow || {});
  } catch { return { ...DEFAULT_CHECK_EXEC }; }
};

// ---------- 环境失败归类 ----------
// 真实故障 R156：执行者的沙箱禁止启动子进程（node --test 报 spawn EPERM），它拿不到
// "测试跑绿"的证据，于是不敢宣告完成而被隔离；判失败的人却把它当成代码写错。
// 这里把"环境不允许"和"执行者写错"分开，调用方据此不再让环境限制咬人。
// 只用结果对象/错误本身作证据，不做任何推测性的外推。
const PERMISSION_DENIED_RE = /EPERM|EACCES/;
const MISSING_TOOL_RE = /spawn[^\r\n]{0,80}?ENOENT|ENOENT/;
// Windows 上"沙箱/权限导致进程根本起不来"的失败：Codex 的检查工具实测报
// "命令工具因 CreateProcessAsUserW 错误 -1073283067 无法启动"（0xC0000142）。
// 这跟 EPERM 同类：检查没跑起来，不是执行者的产出有问题——R179 里因为没认出来，
// 把"读不到文件的核验"判成执行者要修，模型被白烧一轮返工。
const WINDOWS_SANDBOX_RE = /CreateProcessAsUser|0xC0000142|-1073283067/i;

export function classifyCheckFailure(result) {
  const source = result instanceof Error
    ? { ...result, output: result.message, error: result }
    : (result && typeof result === 'object' ? result : {});
  const errorText = source.error instanceof Error ? source.error.message : String(source.error ?? '');
  const text = String(source.output ?? '') + '\n' + errorText;
  // "没有取得可判定的结果"必须先判：未派发、副作用未知、超时、取消、未核验时退出码可能是 0，
  // 但那不是"检查通过"。旧顺序把 exitCode===0 当成功，会把没跑成的检查报成通过。
  if (source.unknownSideEffects === true || source.evidence?.sideEffects === 'unknown') return { kind: 'environment', reason: '检查的副作用未知（是否真的执行过、改了什么无法确认），没有取得可判定的结果' };
  if (source.notDispatched === true) return { kind: 'environment', reason: '检查未派发（等待文件范围确认，或没有可用的确认通道），不是执行者的问题' };
  if (source.timedOut === true) return { kind: 'environment', reason: '检查超时（环境或资源限制），没有取得可判定的执行结果' };
  if (source.cancelled === true) return { kind: 'environment', reason: '检查在执行前或执行中被取消，没有取得可判定的执行结果' };
  const denied = text.match(PERMISSION_DENIED_RE), missing = text.match(MISSING_TOOL_RE), sandbox = text.match(WINDOWS_SANDBOX_RE);
  if (sandbox) return { kind: 'environment', reason: `环境（Windows 沙箱/权限）无法启动进程，检查没有真正运行：命中「${sandbox[0].trim()}」` };
  if (missing && (!denied || missing.index <= denied.index)) return { kind: 'environment', reason: `环境缺少该程序或工具未安装，检查没有启动：命中「${missing[0].trim()}」` };
  if (denied) return { kind: 'environment', reason: `环境禁止启动子进程或访问文件（沙箱权限限制），检查没有真正运行：命中「${denied[0].trim()}」` };
  if (source.verificationStatus === 'unverified') return { kind: 'environment', reason: '检查没有取得可判定的执行结果（未核验），不能算通过' };
  if (source.ok === true || source.exitCode === 0) return { kind: 'ok', reason: '检查已通过（退出码 0）' };
  return { kind: 'executor', reason: `检查已实际执行并失败（退出码 ${source.exitCode ?? '未知'}），属于执行者需要修复的问题` };
}

// 放宽留痕：走"明确文件直接执行"这条路时，结果里必须写出放宽了什么，不许静默放过。
const EXPLICIT_TEST_DEGRADE = '未经看板人工确认：仅执行明确列出的测试文件（无 lockfile 时不再要求范围确认）';

// 真实执行了什么：记录交给 spawn 的 argv（可执行文件 + 参数数组），而不是用户写的那行文本。
// 桌面助手通道只跑 node 的三种 argv（见 desktop-assistant/core/security.mjs executionPlan）。
const brokerArgv = spec => spec?.check === 'node_version' ? { executable: process.execPath, args: ['--version'] }
  : spec?.check === 'node_syntax' ? { executable: process.execPath, args: ['--check', spec.file] }
  : spec?.check === 'project_tests' ? { executable: process.execPath, args: ['--test', ...(spec.files || [])] }
  : null;
const strictArgv = spec => spec?.check === 'exec' ? { executable: spec.executable, args: [...(spec.args || [])] } : brokerArgv(spec);
// 非 strict 走 shell：真实被启动的是 cmd.exe，命令文本是它的参数（Node 的 shell 规范化）。
const shellArgv = command => ({ executable: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], shell: true });

export async function runChecks(cwd, checks, { timeoutMs = 180000, signal, strict=false, registeredCheck, exec = flowExec() } = {}) {
  const results = [];
  // 桌面助手只实现了这几类检查（且只认 node --version / node --check / node --test 三种 argv）。
  // 其余已注册命令（如 python -m py_compile）直接由 BEAT 在沙箱外跑，不再转交它。
  const BROKER_CHECKS = new Set(['node_version', 'node_syntax', 'project_tests']);
  // 每条结果统一在这里收口：ok 只由"真的执行并通过"决定。退出码 0 不能把
  // 未执行/副作用未知/超时/取消/未核验变成成功；通道自己判否的也不替它改成通过。
  const finish = row => {
    let verificationStatus = row.notDispatched === true || row.timedOut === true || row.cancelled === true
      || row.unknownSideEffects === true || row.evidence?.sideEffects === 'unknown' || row.verificationStatus === 'unverified'
      || row.exitCode === null || row.exitCode === undefined ? 'unverified'
      : Number(row.exitCode) === 0 ? 'passed' : 'failed';
    if (verificationStatus === 'passed' && row.ok === false) verificationStatus = 'unverified';
    return { ...row, ok: verificationStatus === 'passed', verificationStatus, checkKind: row.checkKind || 'unknown', executedCommand: row.executedCommand ?? null };
  };
  // 被拒/解析失败时也给出类别（只解析形状，不执行任何东西）：这样"语法检查"和"功能检查"
  // 在结果里始终分得开。
  const kindOfCommand = command => { try { return kindOfSpec(registeredCheckFor(cwd, command, 0, { allowMissing: true, exec })); } catch { return 'unknown'; } };
  for (const command of checks) {
    if (signal?.aborted) break;
    const t0 = Date.now();
    let registered, degradedReason;
    if(strict){
      try{
        registered=registeredCheckFor(cwd,command,0,{exec});
        // 参数全是明确文件（既无通配符，也不是自动发现）时，要跑哪些文件在计划期就已确定，
        // 范围不再需要人工确认：由 BEAT 在沙箱外直接执行，执行者因此能拿到真实跑绿/跑红的证据。
        const explicitTests=registered.check==='project_tests'&&!registered.executable&&registered.autoScope!==true;
        if(explicitTests)degradedReason=EXPLICIT_TEST_DEGRADE;
        // 会执行项目代码的检查必须走桌面助手的一次性人工短码确认；注册命令通道里的
        // 语法检查不执行被测代码，直接由 BEAT 在沙箱外跑。明确文件的测试检查已经确定范围，
        // 不再转交确认通道；自动发现/通配符仍然是项目级范围，必须确认。
        if(registeredCheck&&BROKER_CHECKS.has(registered.check)&&!(registered.check==='project_tests'&&(registered.executable||explicitTests))){
          const r=await registeredCheck(registered,{cwd,signal});
          const unknownSideEffects=r.unknownSideEffects===true||r.evidence?.sideEffects==='unknown';
          // 通道真的把命令派出去了才写"执行了什么"；没派发就不许编造执行记录。
          const dispatched=!(r.notDispatched===true||r.evidence?.observed?.dispatched===false);
          results.push(finish({...r,command,ms:Date.now()-t0,checkKind:kindOfSpec(registered),unknownSideEffects,executedCommand:dispatched?brokerArgv(registered):null}));
          continue;
        }
        if(registered.check==='project_tests'&&!registered.executable&&!explicitTests)throw new Error('此检查会执行项目代码，需通过看板确认本次文件范围后运行；尚未执行');
      }catch(e){
        const notDispatched=!registered||!registeredCheck||e.noDispatch===true||e.evidence?.observed?.dispatched===false;
        results.push(finish({command,exitCode:null,ok:false,timedOut:false,cancelled:e.cancelled===true,ms:Date.now()-t0,output:e.message,notDispatched,taskId:e.taskId||null,needsConfirmation:e.needsConfirmation===true,evidence:e.evidence||null,unknownSideEffects:!!(e.evidence?.sideEffects==='unknown'),checkKind:registered?kindOfSpec(registered):kindOfCommand(command),executedCommand:null}));
        continue;
      }
    }
    const executedCommand = strict ? strictArgv(registered) : shellArgv(command);
    const r = await new Promise(resolve => {
      // 非 strict 分支没有 registered，argv 必须先判类型再取字段，否则读 registered.executable 会抛 TypeError。
      const env={...process.env,BEAT_CHILD:'1',NO_COLOR:'1',FORCE_COLOR:'0'};
      // 检查必须是独立的顶层测试运行。若 BEAT 自己跑在 node --test 里（集成测试场景），
      // 继承 NODE_TEST_CONTEXT 会让子进程的 node --test 判定为"嵌套 run()"而直接跳过测试文件，
      // 于是又变成"跑不出证据"。清掉它，检查照常真实执行。
      delete env.NODE_TEST_CONTEXT;
      let child;
      try{
        child = !strict?spawn(command,{cwd,shell:true,windowsHide:true,env})
          :registered?.check==='exec'?!registered.executable?(()=>{throw new Error('注册检查缺少 executable')})():spawn(registered.executable,registered.args||[],{cwd,shell:false,windowsHide:true,env})
          :registered?.check==='node_version'?spawn(process.execPath,['--version'],{cwd,shell:false,windowsHide:true,env})
          :registered?.check==='project_tests'?spawn(process.execPath,['--test',...(registered.files||[])],{cwd,shell:false,windowsHide:true,env})
          :spawn(process.execPath,['--check',registered.file],{cwd,shell:false,windowsHide:true,env});
      }catch(error){
        // 沙箱不允许起子进程时 spawn 会**直接抛**（实测 EPERM），不是发 error 事件。
        // 这时检查根本没跑：必须变成"未核验 + 环境原因"的结果，而不是把整组检查异常抛出去
        //（R156 的教训：环境限制被当成执行者写错，白烧一轮返工）。
        resolve({code:null,timedOut:false,out:'',spawnError:error});
        return;
      }
      let out = '', timedOut = false;
      const add = d => { out = (out + d).slice(-20000); };
      child.stdout.on('data', add); child.stderr.on('data', add);
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, Number(registered?.timeoutMs) > 0 ? Number(registered.timeoutMs) : timeoutMs);
      const abort = () => killTree(child);
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', e => add('\n' + e.message));
      child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ code: timedOut ? null : code, timedOut, out }); });
    });
    const output = (r.spawnError ? `${r.out}\n${r.spawnError.message}` : r.out).slice(-4000);
    results.push(finish({command,exitCode:r.code,ok:r.code===0,timedOut:r.timedOut,cancelled:signal?.aborted===true,ms:Date.now()-t0,output,
      ...(r.spawnError?{error:r.spawnError}:{}),
      checkKind:strict?kindOfSpec(registered):kindOfCommand(command),
      executedCommand:r.spawnError?null:executedCommand,
      ...(degradedReason?{degradedReason}:{})}));
  }
  return results;
}

// 类别标签：让核验的人一眼看出"这条检查到底证明了什么"。
// 语法检查通过**不能**当作功能/行为通过，所以标签里直接写明这一点。
const CHECK_KIND_LABEL = { syntax: '语法检查（不代表功能通过）', functional: '功能测试', capability: '能力探测', unknown: '类别未判定' };

export function describeChecks(results) {
  if (!results?.length) return '';
  return results.map(r => {
    // 旧结果没有 checkKind/verificationStatus：这一路径的输出必须与升级前逐字一致，
    // 既有核验话术依赖它。只有新结果才多出类别标签和"未核验"提示。
    const kind = r.checkKind ? ` ［${CHECK_KIND_LABEL[r.checkKind] || r.checkKind}］` : '';
    const unverified = r.verificationStatus === 'unverified' && r.notDispatched !== true && r.timedOut !== true && r.unknownSideEffects !== true ? ' ⚠️ 未核验' : '';
    return `$ ${r.command}\n→ ${r.notDispatched === true ? '尚未执行' : r.unknownSideEffects ? '执行结果待核验' : r.timedOut ? '超时' : '退出码 ' + r.exitCode}（${Math.round(r.ms / 100) / 10}s）${unverified}${r.ok ? ' ✅' : ' ❌'}${kind}${r.degradedReason ? `\n⚠️ ${r.degradedReason}` : ''}\n${String(r.output || '').trim()}`;
  }).join('\n\n');
}
