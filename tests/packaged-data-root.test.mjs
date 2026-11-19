// 打包后的 app 进程（MCP/CLI）必须和启动器用同一份数据目录/端口/令牌，
// 否则启动器自动换端口后，MCP 还去连 8765 就会误报"端口被占用"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

const mk = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('便携包：app 进程从 portable-data 读同一份配置和端口', () => {
  const pkg = mk('beat-pkg-');
  const app = path.join(pkg, 'app');
  fs.mkdirSync(app);
  const portable = path.join(pkg, 'portable-data');
  fs.mkdirSync(portable);
  fs.writeFileSync(path.join(portable, 'config.json'), JSON.stringify({ port: 8811 }));
  const cfg = loadConfig(app);
  assert.equal(path.resolve(cfg.dataRoot), path.resolve(portable));
  assert.equal(cfg.port, 8811);
  assert.equal(path.resolve(cfg.configFile), path.resolve(path.join(portable, 'config.json')));
});

test('安装版：app 进程从 launcher-settings.json 的 DataDir 读同一份配置', () => {
  const pkg = mk('beat-inst-');
  const app = path.join(pkg, 'app');
  fs.mkdirSync(app);
  const data = path.join(pkg, 'local-data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(pkg, 'launcher-settings.json'), JSON.stringify({ DataDir: data }));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port: 8812 }));
  const cfg = loadConfig(app);
  assert.equal(path.resolve(cfg.dataRoot), path.resolve(data));
  assert.equal(cfg.port, 8812);
});

test('开发/源码目录不受影响：没有打包标记时数据目录仍是根目录', () => {
  const root = mk('beat-dev-');
  const cfg = loadConfig(root);
  assert.equal(path.resolve(cfg.dataRoot), path.resolve(root));
});
