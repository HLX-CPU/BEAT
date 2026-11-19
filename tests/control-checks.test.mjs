import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registeredCheckFor, preflightCheck, runChecks } from '../src/checks.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

function fixture() {
  const parent=artifactsRoot();fs.mkdirSync(parent,{recursive:true});
  const cwd=fs.mkdtempSync(path.join(parent,'control-checks-'));fs.mkdirSync(path.join(cwd,'src'));fs.mkdirSync(path.join(cwd,'tests'));
  fs.writeFileSync(path.join(cwd,'src','app.mjs'),'export const valid = true;\n');
  fs.writeFileSync(path.join(cwd,'tests','one.test.mjs'),"import fs from 'node:fs'; fs.writeFileSync('UNAUTHORIZED-EXECUTION.txt','must never run without broker');\n");
  return cwd;
}
function packageFor(cwd,scripts){fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({scripts},null,2));}

test('plan preflight permits future outputs but keeps exact command and path protections', async () => {
  const cwd = fixture();
  assert.equal(preflightCheck(cwd, 'node --check future/app.mjs').check, 'node_syntax');
  assert.deepEqual(preflightCheck(cwd, 'node --test future/check.test.mjs').files, ['future/check.test.mjs']);
  for (const command of ['node -e "process.exit(0)"', 'node --check ../escape.mjs', 'node --test ../escape.test.mjs', 'node --test --experimental-test-isolation=none', 'node --version & whoami']) assert.throws(() => preflightCheck(cwd, command));
  const [result] = await runChecks(cwd, ['node --check future/app.mjs'], { strict: true });
  assert.equal(result.ok, false); assert.equal(result.notDispatched, true);
  packageFor(cwd, { test: 'node --test future/check.test.mjs' });
  assert.equal(preflightCheck(cwd, 'npm test').check, 'project_tests');
  packageFor(cwd, { test: 'node --version & whoami' });
  assert.throws(() => preflightCheck(cwd, 'npm test'));
});

test('strict checks reject shell injection before spawning or calling registered broker',async()=>{
  const cwd=fixture();let calls=0;
  const commands=['node --version & echo injected > injected.txt','node --version; echo injected','node --version | cmd','node --version > injected.txt','node --version `whoami`','node --version $(whoami)','node --version %COMSPEC%','node --version\nnode --version','powershell -Command "exit 0"','cmd /c ver','node -e "process.exit(0)"'];
  const results=await runChecks(cwd,commands,{strict:true,registeredCheck:async()=>{calls++;return {ok:true,output:'should not dispatch'};}});
  assert.equal(calls,0);assert.equal(results.length,commands.length);
  for(const r of results){assert.equal(r.ok,false);assert.equal(r.exitCode,null);assert.equal(r.notDispatched,true);assert.ok(r.output);}
  assert.equal(fs.existsSync(path.join(cwd,'injected.txt')),false);
});

test('explicit test files run without board confirmation while glob scopes still never execute unconfirmed project code',async()=>{
  // 明确文件：范围在计划期已确定，BEAT 在沙箱外直接跑，执行者才拿得到真实证据（放宽有留痕）。
  const explicit=fixture();
  const [green]=await runChecks(explicit,['node --test tests/one.test.mjs'],{strict:true});
  assert.equal(green.ok,true);assert.equal(green.exitCode,0);assert.equal(green.notDispatched,undefined);
  assert.match(green.degradedReason||'',/明确列出的测试文件/);
  assert.equal(fs.existsSync(path.join(explicit,'UNAUTHORIZED-EXECUTION.txt')),true,'explicit file is now really executed by BEAT outside the sandbox');
  // npm 入口解析成的 argv 与直接写 node --test 完全一致，因此同样按明确文件执行。
  packageFor(explicit,{test:'node --test tests/one.test.mjs'});
  const [npmGreen]=await runChecks(explicit,['npm test'],{strict:true});
  assert.equal(npmGreen.ok,true);assert.match(npmGreen.degradedReason||'',/明确列出的测试文件/);
  // 通配符仍是项目级范围：没有确认通道时拒绝，且绝不执行生成的测试代码。
  const globbed=fixture();packageFor(globbed,{test:'node --test "tests/*.test.mjs"'});
  const results=await runChecks(globbed,['node --test "tests/*.test.mjs"','npm test'],{strict:true});
  assert.equal(results.length,2);
  for(const r of results){assert.equal(r.ok,false);assert.equal(r.notDispatched,true);assert.match(r.output,/尚未执行|确认/);assert.equal(r.degradedReason,undefined);}
  assert.equal(fs.existsSync(path.join(globbed,'UNAUTHORIZED-EXECUTION.txt')),false);
});

test('strict broker error preserves task ID, dispatched state, cancellation and complete unknown side-effect evidence',async()=>{
  const cwd=fixture();
  const evidence={sideEffects:'unknown',observed:{dispatched:true,pid:123},hash:'original-hash',calls:[{tool:'registered_check',status:'unverified',path:path.join(cwd,'tests','one.test.mjs')}]};
  const [r]=await runChecks(cwd,['node --test "tests/*.test.mjs"'],{strict:true,registeredCheck:async(spec)=>{
    assert.equal(spec.check,'project_tests');throw Object.assign(Error('broker operation interrupted'),{taskId:'fixture-check-task',cancelled:true,evidence});
  }});
  assert.equal(r.ok,false);assert.equal(r.notDispatched,false);assert.equal(r.cancelled,true);assert.equal(r.unknownSideEffects,true);
  assert.equal(r.taskId,'fixture-check-task');assert.deepEqual(r.evidence,evidence);assert.equal(r.output,'broker operation interrupted');
});

test('strict broker no-dispatch failure remains distinct from unknown dispatched action',async()=>{
  const cwd=fixture();const evidence={sideEffects:'none',observed:{dispatched:false},reason:'needs confirmation'};
  const [r]=await runChecks(cwd,['node --test "tests/*.test.mjs"'],{strict:true,registeredCheck:async()=>{throw Object.assign(Error('confirmation pending'),{noDispatch:true,evidence});}});
  assert.equal(r.ok,false);assert.equal(r.notDispatched,true);assert.equal(r.unknownSideEffects,false);assert.deepEqual(r.evidence,evidence);
});

test('real node syntax checks validate source without executing it, and report real syntax errors',async()=>{
  const cwd=fixture();
  fs.writeFileSync(path.join(cwd,'src','side-effect.mjs'),"import fs from 'node:fs';fs.writeFileSync('SYNTAX-MUST-NOT-EXECUTE.txt','bad');\n");
  fs.writeFileSync(path.join(cwd,'src','invalid.mjs'),'export const broken = ;\n');
  const results=await runChecks(cwd,['node --check src/side-effect.mjs','node --check src/invalid.mjs','node --version'],{strict:true});
  assert.equal(results[0].ok,true);assert.equal(results[0].exitCode,0);assert.equal(fs.existsSync(path.join(cwd,'SYNTAX-MUST-NOT-EXECUTE.txt')),false);
  assert.equal(results[1].ok,false);assert.ok(results[1].exitCode);assert.match(results[1].output,/SyntaxError/);
  assert.equal(results[2].ok,true);assert.match(results[2].output,/v\d+\./);
});

test('npm registered entries resolve to approved argv instead of running npm or its package shell',async()=>{
  const cwd=fixture();packageFor(cwd,{test:'node --test "tests/one.test.mjs"',lint:'node --check src/app.mjs',check:'node --version','format:check':'node --check src/app.mjs',deploy:'node --version'});
  assert.deepEqual(registeredCheckFor(cwd,'npm test'),{check:'project_tests',files:['tests/one.test.mjs']});
  assert.deepEqual(registeredCheckFor(cwd,'npm.cmd run lint'),{check:'node_syntax',file:'src/app.mjs'});
  assert.deepEqual(registeredCheckFor(cwd,'npm run format:check'),{check:'node_syntax',file:'src/app.mjs'});
  assert.deepEqual(registeredCheckFor(cwd,'npm run check'),{check:'node_version'});
  const [r]=await runChecks(cwd,['npm run lint'],{strict:true});assert.equal(r.ok,true);assert.equal(r.exitCode,0);
  for(const command of ['npm run deploy','npm install','npm test -- --watch','npm run lint --ignore-scripts'])assert.throws(()=>registeredCheckFor(cwd,command));
  packageFor(cwd,{lint:'node --check src/app.mjs && echo bad',test:'npm run test'});
  assert.throws(()=>registeredCheckFor(cwd,'npm run lint'),/阻止/);assert.throws(()=>registeredCheckFor(cwd,'npm test'),/明确核验/);
});

test('strict parser keeps quoted file paths and refuses broken quoting, traversal, test flags and missing entries',()=>{
  const cwd=fixture();fs.writeFileSync(path.join(cwd,'src','with space.mjs'),'export const valid=1;');
  assert.deepEqual(registeredCheckFor(cwd,'node --check "src/with space.mjs"'),{check:'node_syntax',file:'src/with space.mjs'});
  for(const command of ['node --check "src/app.mjs','node --check ../outside.mjs','node --check src/missing.mjs','node --test --test-reporter=spec tests/one.test.mjs'])assert.throws(()=>registeredCheckFor(cwd,command));
  packageFor(cwd,{});assert.throws(()=>registeredCheckFor(cwd,'npm run check'));
});

test('strict test globs are converted to explicit local file references before broker dispatch',async()=>{
  const cwd=fixture();let received;
  fs.writeFileSync(path.join(cwd,'tests','two.test.mjs'),'import assert from "node:assert";assert.ok(true);\n');
  const [r]=await runChecks(cwd,['node --test "tests/*.test.mjs"'],{strict:true,registeredCheck:async(spec,context)=>{
    received=spec;assert.equal(context.cwd,cwd);return {ok:true,exitCode:0,output:'approved fixture broker',evidence:{sideEffects:'none'}};
  }});
  assert.equal(received.check,'project_tests');assert.deepEqual([...received.files].sort(),['tests/one.test.mjs','tests/two.test.mjs']);assert.equal(r.ok,true);
  assert.equal(fs.existsSync(path.join(cwd,'UNAUTHORIZED-EXECUTION.txt')),false,'fixture broker itself did not run generated code');
});

test('already cancelled check group does not parse or dispatch further commands',async()=>{
  const cwd=fixture(),ac=new AbortController();ac.abort();let calls=0;
  const results=await runChecks(cwd,['node --version'],{strict:true,signal:ac.signal,registeredCheck:async()=>{calls++;}});
  assert.deepEqual(results,[]);assert.equal(calls,0);
});

test('dash-leading source filename cannot become node help and falsely pass a syntax check',async()=>{
  const cwd=fixture();fs.writeFileSync(path.join(cwd,'--help'),'export const invalid = ;\n');
  const [r]=await runChecks(cwd,['node --check "--help"'],{strict:true});
  assert.equal(r.ok,false,'invalid source must never pass because Node interprets the filename as --help');
  const [explicit]=await runChecks(cwd,['node --check "./--help"'],{strict:true});
  // `./--help` 以前会被放行：node 把它当普通文件、什么都不检查就返回 0，语法错的文件因此"通过"（漏洞）。
  // 现在这类横杠开头的文件名一律拒绝执行——检查根本没跑，不会产生假证据。
  assert.equal(explicit.ok,false);
  assert.match(explicit.output,/横杠|不能作为命令参数/,'必须拒绝执行，而不是静默通过：'+explicit.output);
});

test('quoted npm recursion is bounded and never dispatches a package shell',async()=>{
  const cwd=fixture();packageFor(cwd,{test:'"npm" run test'});let calls=0;
  const [r]=await runChecks(cwd,['npm test'],{strict:true,registeredCheck:async()=>{calls++;return{ok:true};}});
  assert.equal(r.ok,false);assert.equal(r.notDispatched,true);assert.equal(calls,0);assert.ok(r.output);
  assert.doesNotMatch(r.output,/Maximum call stack|RangeError/,'recursive entry must be rejected before exhausting the JS stack');
});
