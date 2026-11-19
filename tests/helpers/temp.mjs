// 测试临时目录工具。
//
// 为什么要有这个文件：早先多个测试用 fs.mkdtempSync 把临时目录开在**生产的**
// E:\beat\data\ 下面，跑完也不删。买家打开 data/ 看到 900 多个 control-settings-test-*
// 目录，第一反应是"这软件在我机器上撒了一地垃圾"，而且它会和真实数据混在一起。
// 现在统一走系统临时目录，并且提供 after() 自动清理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PARENT = path.join(os.tmpdir(), 'beat-tests');

/** 看板/队列类测试的工作区根目录。
 *  以前这些测试用 path.resolve('.beat-test-artifacts')——相对**当前工作目录**，
 *  于是跑到哪就在哪留一坨（把产品目录当垃圾场）。统一放进系统临时目录。 */
export function artifactsRoot() {
  const dir = path.join(os.tmpdir(), 'beat-test-artifacts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 在系统临时目录里建一个带前缀的独立目录。 */
export function tempDir(tag = 'case') {
  fs.mkdirSync(PARENT, { recursive: true });
  return fs.mkdtempSync(path.join(PARENT, `beat-${tag}-`));
}

/** 给 node:test 用：注册 after 钩子，用例结束后删掉临时目录。 */
export function cleanup(t, dir) {
  if (!t || typeof t.after !== 'function') return dir;
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 已经删了或被占用 */ } });
  return dir;
}
