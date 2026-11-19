import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { classifyCheckFailure, describeChecks, registeredCheckFor, runChecks, DEFAULT_CHECK_EXEC } from '../src/checks.mjs';
import { ROOT } from '../src/config.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

function fixture() {
  const parent=artifactsRoot();fs.mkdirSync(parent,{recursive:true});
  const cwd=fs.mkdtempSync(path.join(parent,'checks-'));fs.mkdirSync(path.join(cwd,'tests'));
  return cwd;
}
function packageFor(cwd,scripts){fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({scripts},null,2));}
const greenTest='import test from "node:test";\nimport assert from "node:assert/strict";\ntest("adds",()=>assert.equal(1+1,2));\n';
const redTest='import test from "node:test";\nimport assert from "node:assert/strict";\ntest("fails",()=>assert.equal(1,2));\n';
// 受限环境（例如沙箱里不能给子进程开管道）会 spawn EPERM。suite 必须在两种环境下都给出
// 可信结论：能跑就要求真实跑绿/跑红，跑不了就必须如实报"未核验 + 环境原因"，绝不假通过。
const spawnDenied=(()=>{try{const child=spawn(process.execPath,['--version'],{stdio:['ignore','pipe','pipe'],windowsHide:true});child.on('error',()=>{});child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});child.on('close',()=>{});return false;}catch(error){return error?.code==='EPERM'||error?.errno===-4048;}})();

test('classifyCheckFailure keeps ok, environment limits and executor faults apart',()=>{
  const ok=classifyCheckFailure({ok:true,exitCode:0,output:'# pass 1'});
  assert.equal(ok.kind,'ok');assert.ok(ok.reason);

  // 未派发：等待范围确认或没有确认通道，不是执行者的错。
  const undelivered=classifyCheckFailure({ok:false,exitCode:null,notDispatched:true,output:'此检查会执行项目代码，需通过看板确认本次文件范围后运行；尚未执行'});
  assert.equal(undelivered.kind,'environment');assert.match(undelivered.reason,/未派发/);

  // R156 原始日志：执行者沙箱禁止启动子进程，node --test 报 spawn EPERM（退出码仍是 1，但代码没错）。
  const eperm=classifyCheckFailure({ok:false,exitCode:1,timedOut:false,output:'Error: spawn EPERM\n    at ChildProcess.spawn (node:internal/child_process:421:11)'});
  assert.equal(eperm.kind,'environment');assert.match(eperm.reason,/EPERM/,'reason must quote the matched fragment');assert.match(eperm.reason,/权限|沙箱/);

  // 工具不存在与权限被拒必须是两种不同的原因文案。
  const enoent=classifyCheckFailure(Object.assign(new Error('spawn pytest ENOENT'),{ok:false,exitCode:127}));
  assert.equal(enoent.kind,'environment');assert.match(enoent.reason,/ENOENT/);assert.match(enoent.reason,/未安装|缺少/);
  assert.notEqual(enoent.reason,eperm.reason);

  const timedOut=classifyCheckFailure({ok:false,exitCode:null,timedOut:true,output:'still running'});
  assert.equal(timedOut.kind,'environment');assert.match(timedOut.reason,/超时/);

  // 真的跑了并且真的失败：执行者要修。
  const failed=classifyCheckFailure({ok:false,exitCode:1,timedOut:false,output:'1 test failed'});
  assert.equal(failed.kind,'executor');assert.match(failed.reason,/退出码 1/);
  // 入参也接受裸 Error。
  assert.equal(classifyCheckFailure(new Error('检查命令包含不支持的拼接或输入')).kind,'executor');

  // R179 实测：Codex 的检查工具在沙箱里起不来，报的是 Windows 进程创建错误（不是 EPERM），
  // 旧分类把它当"执行者要修的问题"，让读不到文件的核验冤枉了模型、白烧一轮返工。
  const winSandbox=classifyCheckFailure({ok:false,exitCode:-1073283067,output:'命令工具因 CreateProcessAsUserW 错误 -1073283067 无法启动'});
  assert.equal(winSandbox.kind,'environment','Windows 沙箱起不来进程属于环境限制');
  assert.match(winSandbox.reason,/CreateProcessAsUser|沙箱/);
  assert.equal(classifyCheckFailure({ok:false,exitCode:-1073741502,output:'failed: 0xC0000142'}).kind,'environment');
});

test('未执行/副作用未知/超时/取消/未核验时，退出码 0 也不能算成功',()=>{
  for(const row of [
    {ok:true,exitCode:0,notDispatched:true,output:'等待文件范围确认'},
    {ok:true,exitCode:0,timedOut:true,output:'still running'},
    {ok:true,exitCode:0,cancelled:true,output:'已取消'},
    {ok:true,exitCode:0,unknownSideEffects:true,output:'派发后失去联系，不知道跑到哪一步'},
    {ok:true,exitCode:0,evidence:{sideEffects:'unknown'},output:'副作用未知'},
    {ok:true,exitCode:0,verificationStatus:'unverified',output:''},
  ]){
    const r=classifyCheckFailure(row);
    assert.equal(r.kind,'environment','退出码 0 但没有可信结果，不能算通过：'+JSON.stringify(row));
    assert.ok(r.reason);
  }
  // 真的跑过并通过才算通过。
  assert.equal(classifyCheckFailure({ok:true,exitCode:0,verificationStatus:'passed',output:'# pass 1'}).kind,'ok');
  // 真的跑过并失败：执行者要修。
  assert.equal(classifyCheckFailure({ok:false,exitCode:1,verificationStatus:'failed',output:'1 test failed'}).kind,'executor');
  // spawn 直接抛 EPERM（检查根本没起来）仍然是环境类，不是执行者的错，且原因里保留 EPERM 原文。
  const spawnFail=classifyCheckFailure({ok:false,exitCode:null,verificationStatus:'unverified',output:'Error: spawn EPERM'});
  assert.equal(spawnFail.kind,'environment');assert.match(spawnFail.reason,/EPERM/);
});

test('已注册固定子命令逐一核对：python -m pytest 绝不被改写成 py_compile，未知子命令一律拒绝',()=>{
  const cwd=fixture();fs.writeFileSync(path.join(cwd,'tests','test_ok.py'),'def test_ok():\n    assert True\n');fs.writeFileSync(path.join(cwd,'tests','test_ok.txt'),'not python\n');
  // 用户写的 pytest 必须原样执行：旧实现在这里静默改写成 `python -m py_compile`，
  // 于是功能测试命令被当成语法检查跑，还显示"通过"。
  const pytest=registeredCheckFor(cwd,'python -m pytest tests/test_ok.py');
  assert.equal(pytest.check,'exec');assert.equal(pytest.checkKind,'functional');
  assert.deepEqual(pytest.args,['-m','pytest','tests/test_ok.py'],'必须是用户写的 pytest 命令');
  assert.ok(!pytest.args.includes('py_compile'),'绝不改写成 py_compile');
  assert.equal(pytest.runsProjectCode,true);
  const syntax=registeredCheckFor(cwd,'python -m py_compile tests/test_ok.py');
  assert.deepEqual(syntax.args,['-m','py_compile','tests/test_ok.py']);assert.equal(syntax.checkKind,'syntax');
  assert.equal(syntax.runsProjectCode,false,'语法检查不执行被测代码');
  // 未注册的子命令（doctest / pip / 任意模块）不得落到 py_compile 上，也不能带任意 flags。
  for(const command of ['python -m doctest tests/test_ok.py','python -m pip install requests','python -m pytest','python -m pytest -x tests/test_ok.py','python -m pytest tests/test_ok.py --tb=short']){
    assert.throws(()=>registeredCheckFor(cwd,command),/子命令未注册|只接受|明确(的)?文件|不能作为命令参数/,command);
  }
  // pytest 通道同样拒绝越界、通配符和非 .py 文件。
  assert.throws(()=>registeredCheckFor(cwd,'python -m pytest ../outside.py'),/PATH_REJECTED/);
  assert.throws(()=>registeredCheckFor(cwd,'python -m pytest "tests/*.py"'),/通配符/);
  assert.throws(()=>registeredCheckFor(cwd,'python -m pytest tests/test_ok.txt'),/只接受/);
  assert.throws(()=>registeredCheckFor(cwd,'python -m pytest A:\\Windows\\system32\\x.py'),/PATH_REJECTED/);
  // 同一类改写 bug：go/cargo/dotnet build 不许被当成 test 执行。
  for(const command of ['go test','cargo test','dotnet test'])assert.deepEqual(registeredCheckFor(cwd,command).args,['test']);
  for(const command of ['go build','cargo build','dotnet build','go test ./...'])assert.throws(()=>registeredCheckFor(cwd,command),command);
  // 计划期（allowMissing）也按同一条语法核对：token 必须相同，只是不要求文件已存在。
  assert.deepEqual(registeredCheckFor(cwd,'python -m pytest future/test_x.py',0,{allowMissing:true}).args,['-m','pytest','future/test_x.py']);
  assert.throws(()=>registeredCheckFor(cwd,'python -m doctest future/test_x.py',0,{allowMissing:true}),/子命令未注册/);
});

test('自定义注册：{file} 语法兼容，固定 token 同样要逐一核对',()=>{
  const cwd=fixture();fs.writeFileSync(path.join(cwd,'a.py'),'x = 1\n');
  const exec={...DEFAULT_CHECK_EXEC,mytool:{kind:'tests',sub:['run','--file','{file}'],ext:['.py']}};
  const run=registeredCheckFor(cwd,'mytool run --file a.py',0,{exec});
  assert.deepEqual(run.args,['run','--file','a.py']);assert.equal(run.checkKind,'functional');assert.equal(run.runsProjectCode,true);
  assert.equal(run.file,'a.py');
  // 固定 token 少写/换写一律拒绝：旧实现会把 `mytool other` 当成 `mytool run --file <用户参数>` 执行。
  for(const command of ['mytool run a.py','mytool other --file a.py','mytool','mytool run --file'])assert.throws(()=>registeredCheckFor(cwd,command,0,{exec}),command);
  // 计划期同样核对形状，但不要求文件已存在。
  assert.deepEqual(registeredCheckFor(cwd,'mytool run --file future/a.py',0,{exec,allowMissing:true}).args,['run','--file','future/a.py']);
  assert.throws(()=>registeredCheckFor(cwd,'mytool other --file future/a.py',0,{exec,allowMissing:true}),/子命令未注册/);
  // 清单里没有这个程序时，任何写法都不放行（用户关掉验收通道不会凭空多出入口）。
  assert.throws(()=>registeredCheckFor(cwd,'mytool run --file a.py',0,{exec:{...DEFAULT_CHECK_EXEC}}),/尚未注册/);
  // 配置注册的 capability 类别不能被当成语法检查。
  const capExec={...DEFAULT_CHECK_EXEC,mycap:{kind:'capability',sub:['--version'],ext:[]}};
  assert.equal(registeredCheckFor(cwd,'mycap --version',0,{exec:capExec}).checkKind,'capability');
});

test('python -m unittest 保留用户实际命令，不再默认补 -v',()=>{
  const cwd=fixture();
  const plain=registeredCheckFor(cwd,'python -m unittest test_wordstat');
  assert.deepEqual(plain.args,['-m','unittest','test_wordstat'],'不得默认添加 -v');
  assert.equal(plain.checkKind,'functional');assert.equal(plain.runsProjectCode,true);
  const verbose=registeredCheckFor(cwd,'python -m unittest -v test_wordstat');
  assert.deepEqual(verbose.args,['-m','unittest','-v','test_wordstat'],'用户自己写的 -v 原样保留');
  const module=registeredCheckFor(cwd,'python -m unittest tests.test_wordstat');
  assert.deepEqual(module.args,['-m','unittest','tests.test_wordstat'],'点分模块名照旧');
  for(const command of ['python -m unittest','python -m unittest test_wordstat -q','python -m unittest ../../etc/passwd','python -m unittest --locals test_wordstat'])assert.throws(()=>registeredCheckFor(cwd,command),command);
});

test('runChecks 结果带 checkKind/verificationStatus/真实 executedCommand，语法通过不宣称功能通过',async()=>{
  const cwd=fixture();fs.writeFileSync(path.join(cwd,'tests','green.test.mjs'),greenTest);fs.writeFileSync(path.join(cwd,'valid.mjs'),'export const ok = true;\n');
  const [version,syntax,tests]=await runChecks(cwd,['node --version','node --check valid.mjs','node --test tests/green.test.mjs'],{strict:true});
  assert.equal(version.checkKind,'capability');
  assert.equal(syntax.checkKind,'syntax');
  assert.equal(tests.checkKind,'functional');
  for(const r of [version,syntax,tests])assert.ok(['passed','failed','unverified'].includes(r.verificationStatus),'核验状态必须是三选一：'+r.verificationStatus);
  if(spawnDenied){
    // 本机起不了子进程：必须如实报"未核验 + 环境原因"，绝不能是"通过"，也不能抛异常。
    for(const r of [version,syntax,tests]){assert.equal(r.ok,false);assert.equal(r.verificationStatus,'unverified');assert.equal(classifyCheckFailure(r).kind,'environment');assert.equal(r.executedCommand,null,'没执行就不许编造 executedCommand');}
    assert.match(version.output,/EPERM/);
  }else{
    for(const r of [version,syntax,tests])assert.equal(r.verificationStatus,'passed');
    assert.deepEqual(version.executedCommand,{executable:process.execPath,args:['--version']});
    assert.deepEqual(syntax.executedCommand,{executable:process.execPath,args:['--check','valid.mjs']});
    assert.deepEqual(tests.executedCommand,{executable:process.execPath,args:['--test','tests/green.test.mjs']});
  }
  // 拒绝执行的命令也必须带类别和"未核验"，绝不写执行记录。解析不出已注册形状时类别是
  // unknown（"类别未判定"），绝不能被当成"功能检查通过"。
  const [refused]=await runChecks(cwd,['node --check ./--help'],{strict:true});
  assert.equal(refused.ok,false);assert.equal(refused.verificationStatus,'unverified');assert.equal(refused.checkKind,'unknown');assert.equal(refused.executedCommand,null);
  assert.match(describeChecks([refused]),/类别未判定/);
  // 语法标签必须写明"不代表功能通过"；功能标签不得这么写。
  const syntaxText=describeChecks([{command:'node --check valid.mjs',exitCode:0,ok:true,ms:10,output:'',checkKind:'syntax',verificationStatus:'passed'}]);
  assert.match(syntaxText,/语法检查/);assert.match(syntaxText,/不代表功能通过/);
  const functionalText=describeChecks([{command:'node --test tests/green.test.mjs',exitCode:0,ok:true,ms:10,output:'# pass 1',checkKind:'functional',verificationStatus:'passed'}]);
  assert.match(functionalText,/功能测试/);assert.doesNotMatch(functionalText,/不代表功能通过/);
  // 退出码 0 但未核验：描述里必须出现"未核验"和 ❌，不能读成通过。
  const unverifiedText=describeChecks([{command:'node --test tests/green.test.mjs',exitCode:0,ok:false,ms:10,output:'',checkKind:'functional',verificationStatus:'unverified'}]);
  assert.match(unverifiedText,/未核验/);assert.match(unverifiedText,/❌/);assert.doesNotMatch(unverifiedText,/✅/);
});

test('broker 结果也带类别、核验状态与真实 argv；未派发/副作用未知绝不算通过',async()=>{
  const cwd=fixture();fs.writeFileSync(path.join(cwd,'src_ok.mjs'),'export const x=1;\n');
  const [good]=await runChecks(cwd,['node --check src_ok.mjs'],{strict:true,registeredCheck:async()=>({ok:true,exitCode:0,output:'syntax ok',evidence:{sideEffects:'none'}})});
  assert.equal(good.checkKind,'syntax');assert.equal(good.verificationStatus,'passed');assert.equal(good.ok,true);
  assert.deepEqual(good.executedCommand,{executable:process.execPath,args:['--check','src_ok.mjs']});
  // exitCode 0 + 副作用未知：不能算成功，执行记录照实保留（它确实派出去了）。
  const [unknown]=await runChecks(cwd,['node --check src_ok.mjs'],{strict:true,registeredCheck:async()=>({ok:true,exitCode:0,output:'launched, no result',evidence:{sideEffects:'unknown',observed:{dispatched:true}}})});
  assert.equal(unknown.ok,false);assert.equal(unknown.verificationStatus,'unverified');assert.equal(classifyCheckFailure(unknown).kind,'environment');
  assert.deepEqual(unknown.executedCommand,{executable:process.execPath,args:['--check','src_ok.mjs']});
  // 真的跑了并且真的失败：verificationStatus=failed，属于执行者要修的问题。
  const [failed]=await runChecks(cwd,['node --check src_ok.mjs'],{strict:true,registeredCheck:async()=>({ok:false,exitCode:1,output:'SyntaxError: unexpected token',evidence:{sideEffects:'none'}})});
  assert.equal(failed.verificationStatus,'failed');assert.equal(failed.ok,false);assert.equal(classifyCheckFailure(failed).kind,'executor');
  // 没有派发：不许编造执行记录。
  const [undelivered]=await runChecks(cwd,['node --check src_ok.mjs'],{strict:true,registeredCheck:async()=>{throw Object.assign(Error('等确认'),{noDispatch:true,evidence:{sideEffects:'none',observed:{dispatched:false}}});}});
  assert.equal(undelivered.ok,false);assert.equal(undelivered.notDispatched,true);assert.equal(undelivered.executedCommand,null);assert.equal(undelivered.checkKind,'syntax');
  // 真实 argv 与用户写法不同时写真实 argv：npm run lint 解析后执行的是 node --check。
  packageFor(cwd,{lint:'node --check src_ok.mjs'});
  const [viaNpm]=await runChecks(cwd,['npm run lint'],{strict:true,registeredCheck:async()=>({ok:true,exitCode:0,evidence:{sideEffects:'none'}})});
  assert.equal(viaNpm.command,'npm run lint');
  assert.deepEqual(viaNpm.executedCommand,{executable:process.execPath,args:['--check','src_ok.mjs']});
});

test('环境起不了子进程时结果是"未核验+环境原因"，而不是异常或假通过',async()=>{
  const cwd=fixture();fs.writeFileSync(path.join(cwd,'valid.mjs'),'export const ok=1;\n');
  const [r]=await runChecks(cwd,['node --check valid.mjs'],{strict:true});
  if(r.verificationStatus==='passed'){
    assert.equal(r.ok,true);assert.equal(r.exitCode,0);
    assert.deepEqual(r.executedCommand,{executable:process.execPath,args:['--check','valid.mjs']});
    return;
  }
  assert.equal(spawnDenied,true,'只有在环境确实无法启动子进程时才允许走未核验分支');
  assert.equal(r.ok,false);assert.equal(r.verificationStatus,'unverified');assert.equal(r.exitCode,null);
  assert.equal(r.checkKind,'syntax');assert.equal(r.executedCommand,null);
  assert.equal(classifyCheckFailure(r).kind,'environment');assert.match(r.output,/EPERM|EACCES/);
});

test('explicit node --test files run outside the sandbox without board confirmation and say so',async()=>{
  const cwd=fixture();fs.writeFileSync(path.join(cwd,'tests','green.test.mjs'),greenTest);
  let brokerCalls=0;
  const results=await runChecks(cwd,['node --test tests/green.test.mjs'],{strict:true,registeredCheck:async()=>{brokerCalls++;return {ok:true,output:'should not be needed'};}});
  assert.equal(brokerCalls,0,'explicit test files must no longer wait for board confirmation');
  assert.equal(results.length,1);
  const r=results[0];
  assert.equal(r.checkKind,'functional');
  if(spawnDenied){
    assert.equal(r.ok,false);assert.equal(r.verificationStatus,'unverified');assert.equal(classifyCheckFailure(r).kind,'environment');
  }else{
    assert.equal(r.ok,true,'the real test must actually run green');assert.equal(r.exitCode,0);
    assert.match(r.output,/pass 1/,'green evidence comes from a real run');
    assert.deepEqual(r.executedCommand,{executable:process.execPath,args:['--test','tests/green.test.mjs']});
  }
  assert.equal(r.notDispatched,undefined);
  assert.match(r.degradedReason||'',/明确列出的测试文件/,'loosening must be recorded in the result');
  assert.match(r.degradedReason||'',/无 lockfile/);
  assert.match(describeChecks(results),/⚠️ 未经看板人工确认：仅执行明确列出的测试文件/,'the reviewer/model must see the loosening');
  // npm 入口解析出的 argv 与直接写 node --test 相同，因此同样执行（范围仍只含明确文件）。
  packageFor(cwd,{test:'node --test tests/green.test.mjs'});
  const [viaNpm]=await runChecks(cwd,['npm test'],{strict:true});
  assert.match(viaNpm.degradedReason||'',/明确列出的测试文件/);
  if(spawnDenied){assert.equal(viaNpm.ok,false);assert.equal(viaNpm.verificationStatus,'unverified');}
  else{assert.equal(viaNpm.ok,true);assert.deepEqual(viaNpm.executedCommand,{executable:process.execPath,args:['--test','tests/green.test.mjs']});}
});

test('an explicitly listed test that really fails is still an executor failure',async()=>{
  const cwd=fixture();fs.writeFileSync(path.join(cwd,'tests','red.test.mjs'),redTest);fs.writeFileSync(path.join(cwd,'--help'),'export const broken = ;\n');
  const [red]=await runChecks(cwd,['node --test tests/red.test.mjs'],{strict:true});
  assert.equal(red.ok,false);assert.equal(red.checkKind,'functional');
  if(spawnDenied){
    assert.equal(red.verificationStatus,'unverified');assert.equal(red.exitCode,null);
  }else{
    assert.equal(red.exitCode,1);assert.match(red.output,/fails/);
    assert.equal(classifyCheckFailure(red).kind,'executor');
  }
  const [syntax]=await runChecks(cwd,['node --check ./--help'],{strict:true});
  assert.equal(syntax.ok,false);
  // 修前：`node --check ./--help` 会被放行，node 把 ./--help 当普通文件、**什么都不检查就返回 0**，
  // 于是一个语法错的文件被判"通过"（漏洞）。现在这类"横杠开头"的文件名直接拒绝执行，
  // 比"跑出 SyntaxError"更安全：检查根本没被执行，不会给出假证据。
  assert.ok(syntax.notDispatched === true || /SyntaxError/.test(syntax.output), '要么拒绝执行，要么真跑出语法错：' + syntax.output);
  assert.match(syntax.output, /横杠|不能作为命令参数/);
  assert.equal(classifyCheckFailure(syntax).kind, 'environment');
});

test('glob and auto-discovered project tests still require board scope confirmation and never execute',async()=>{
  const cwd=fixture();fs.writeFileSync(path.join(cwd,'tests','one.test.mjs'),'import fs from "node:fs";fs.writeFileSync("MUST-NOT-RUN.txt","unsafe");\n');
  let brokerCalls=0;
  const [dispatched]=await runChecks(cwd,['node --test "tests/*.test.mjs"'],{strict:true,registeredCheck:async()=>{brokerCalls++;return {ok:true,exitCode:0,output:'approved fixture broker',evidence:{sideEffects:'none'}};}});
  assert.equal(brokerCalls,1,'glob scope still goes through the confirmation channel');assert.equal(dispatched.ok,true);
  assert.equal(dispatched.checkKind,'functional');
  const [noBroker]=await runChecks(cwd,['node --test "tests/*.test.mjs"'],{strict:true});
  assert.equal(noBroker.ok,false);assert.equal(noBroker.notDispatched,true);assert.match(noBroker.output,/需通过看板确认/);assert.equal(noBroker.degradedReason,undefined);
  // 不写文件（自动发现）也是项目级范围。
  const [auto]=await runChecks(cwd,['node --test'],{strict:true});
  assert.equal(auto.ok,false);assert.equal(auto.notDispatched,true);assert.match(auto.output,/需通过看板确认/);
  assert.equal(fs.existsSync(path.join(cwd,'MUST-NOT-RUN.txt')),false,'unconfirmed project code must never run');
  // 明确列出的文件必须真实存在，否则拒绝而不是空跑。
  const [missing]=await runChecks(cwd,['node --test tests/missing.test.mjs'],{strict:true});
  assert.equal(missing.notDispatched,true);assert.match(missing.output,/PATH_NOT_FOUND/);
  assert.equal(missing.verificationStatus,'unverified');assert.equal(missing.executedCommand,null);
  // 被拒的检查也要有类别（这里是功能检查），不能被当成"已核验的功能通过"。
  assert.equal(noBroker.checkKind,'functional');assert.equal(missing.checkKind,'functional');
});

test('unregistered tool guidance names the missing capability instead of asking the customer to edit config and restart',()=>{
  const cwd=fixture();
  let error;try{registeredCheckFor(cwd,'ruby main.rb');}catch(e){error=e;}
  assert.ok(error,'unknown tools must still be refused');
  const message=String(error.message);
  assert.match(message,/尚未注册/);
  assert.match(message,/缺少的能力/,'must say which capability is missing');
  assert.match(message,/ruby/,'must name the program that has no registered entry');
  assert.match(message,/执行搭档/,'the next step is the executing partner picking a supported entry');
  assert.match(message,/node --check|node --test/,'must list supported entries');
  for(const forbidden of ['flow.checkExec','config.json','重启服务','看板设置','手工编辑']){
    assert.doesNotMatch(message,new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'must not send the customer to config/restart: '+forbidden);
  }
  assert.ok(message.includes(path.join(ROOT,'config.json'))===false,'不得让客户去找配置文件');
});

test('describeChecks keeps the existing format untouched when nothing was loosened',()=>{
  assert.equal(describeChecks([]),'');
  assert.equal(describeChecks([{command:'node --version',exitCode:0,ok:true,ms:150,output:'v24.19.0'}]),'$ node --version\n→ 退出码 0（0.2s） ✅\nv24.19.0');
  assert.match(describeChecks([{command:'node --test',exitCode:null,ok:false,ms:150,notDispatched:true,output:'需通过看板确认'}]),
    /^\$ node --test\n→ 尚未执行（0\.2s） ❌\n需通过看板确认$/);
  assert.match(describeChecks([{command:'node --test tests/one.test.mjs',exitCode:0,ok:true,ms:150,output:'# pass 1',degradedReason:'未经看板人工确认：仅执行明确列出的测试文件'}]),
    /^\$ node --test tests\/one\.test\.mjs\n→ 退出码 0（0\.2s） ✅\n⚠️ 未经看板人工确认：仅执行明确列出的测试文件\n# pass 1$/);
  // 旧结果（没有 checkKind/verificationStatus）一个字符都不能变：分类标签只加在新结果上。
  const legacy=describeChecks([{command:'node --check a.mjs',exitCode:0,ok:true,ms:150,output:'ok'}]);
  assert.equal(legacy,'$ node --check a.mjs\n→ 退出码 0（0.2s） ✅\nok');
});

test('existing interceptors still refuse concatenation, traversal, wildcards, flags and unregistered tools',()=>{
  const cwd=fixture();fs.writeFileSync(path.join(path.dirname(cwd),'outside.test.mjs'),'export {};\n');
  for(const command of [
    'node --test tests/one.test.mjs; calc.exe','node --test tests/one.test.mjs & echo x','node --test tests/one.test.mjs | more',
    'node --test tests/one.test.mjs > out.txt','node --test tests/one.test.mjs `whoami`','node --test "$(whoami)".test.mjs',
    'node --test ../outside.test.mjs','node --test --test-reporter=spec tests/one.test.mjs','node --check "tests/*.mjs"',
    'node -e "process.exit(0)"','powershell -Command "exit 0"','cmd /c ver','npm install',
  ]){let threw=false;try{registeredCheckFor(cwd,command);}catch{threw=true;}assert.equal(threw,true,`must still refuse: ${command}`);}
  assert.throws(()=>registeredCheckFor(cwd,'node --test ../outside.test.mjs'),/PATH_REJECTED/);
  const recursive=fixture();packageFor(recursive,{test:'npm run test'});
  assert.throws(()=>registeredCheckFor(recursive,'npm test'),/明确核验/);
  assert.deepEqual(registeredCheckFor(cwd,'node --test tests/one.test.mjs',0,{allowMissing:true}),{check:'project_tests',files:['tests/one.test.mjs'],planned:true});
});
