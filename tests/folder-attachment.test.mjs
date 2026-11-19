// 文件夹附件：HTTP 路由 → 服务端落成"一个文件夹附件" → 任务里保留目录结构。
//
// 客户要求：拖文件夹进来不能被拆成一堆文件，要保留文件夹本身。
// 浏览器沙箱拿不到本机绝对路径，所以前端把整棵树打成 tar 一次上传，服务端按相对路径清单还原。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { resolveAttachments, materialize, attachmentBlock, readableAttachmentBlock } from '../src/attachments.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

const TAR_BLOCK = 512;
function tarHeader(name, size) {
  const h = Buffer.alloc(TAR_BLOCK);
  const put = (s, off, len) => Buffer.from(s, 'utf8').copy(h, off, 0, len);
  const oct = (n, off, len) => put(n.toString(8).padStart(len - 1, '0') + '\0', off, len);
  put(name, 0, 100);
  oct(0o644, 100, 8); oct(0, 108, 8); oct(0, 116, 8); oct(size, 124, 12); oct(Math.floor(Date.now() / 1000), 136, 12);
  h[156] = 48; put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
function buildTar(tree) {
  const parts = [];
  for (const [rel, text] of tree) {
    const buf = Buffer.from(text, 'utf8');
    parts.push(tarHeader(rel, buf.length), buf);
    const pad = (TAR_BLOCK - (buf.length % TAR_BLOCK)) % TAR_BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(TAR_BLOCK * 2));
  return Buffer.concat(parts);
}
const tree = [
  ['项目说明.md', '# 我的项目\n'],
  ['src/main.js', 'export const main = () => 1;\n'],
  ['src/util/helper.js', 'export const helper = () => 2;\n'],
  ['data/sample.csv', 'a,b\n1,2\n'],
];

function fixture() {
  const base = fs.mkdtempSync(path.join(artifactsRoot(), 'folder-'));
  const dataRoot = path.join(base, 'data-root');
  const config = { ...loadConfig(dataRoot), allowedRoots: [base], maxUploadMb: 64, port: 0 };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(path.join(config.dataRoot, 'secrets.local.json'), JSON.stringify({ token: config.secrets.token }));
  return { base, config };
}

test('拖文件夹：HTTP 上传后落成一个文件夹附件（不是多个文件）', async () => {
  const { base, config } = fixture();
  const svc = await startServer({ config, agents: {}, port: 0 });
  try {
    const manifest = tree.map(([rel]) => rel);    const r = await fetch(`http://127.0.0.1:${svc.port}/api/upload-folder`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.secrets.token,
        'X-Folder-Name': encodeURIComponent('我的项目'),
        'X-Folder-Manifest': encodeURIComponent(JSON.stringify(manifest)),
        'Content-Type': 'application/octet-stream',
      },
      body: buildTar(tree),
    });
    const body = await r.json();
    assert.equal(body.ok, true, '上传必须成功：' + JSON.stringify(body).slice(0, 300));
    assert.equal(body.result.folder, true, '必须标成一个文件夹附件');
    assert.equal(body.result.folderFiles, tree.length, '文件数要与目录一致');
    assert.equal(body.result.name, '我的项目');

    // 附件解析 + 复制进工作目录：结构必须保留
    const items = resolveAttachments(config, [body.result.id]);
    assert.equal(items.length, 1, '一个文件夹只占一个附件位');
    assert.equal(items[0].folder, true);
    const cwd = path.join(base, 'task-cwd');
    fs.mkdirSync(cwd, { recursive: true });
    const mats = materialize(items, cwd, 'R1');
    const dest = mats[0].path;
    for (const p of ['src/main.js', 'src/util/helper.js', 'data/sample.csv', '项目说明.md'])
      assert.ok(fs.existsSync(path.join(dest, p)), '目录结构必须保留：' + p);
    assert.equal(fs.readFileSync(path.join(dest, 'src/main.js'), 'utf8'), 'export const main = () => 1;\n');

    // 提示词：告诉模型这是文件夹、要按目录读
    assert.match(attachmentBlock(mats, 'deepseek'), /文件夹/);
    assert.match(attachmentBlock(mats, 'deepseek'), /完整目录/);
    const readable = readableAttachmentBlock(mats);
    assert.match(readable, /src\//, '读不到盘的搭档要能看到目录树');
    assert.match(readable, /main\.js/);
  } finally { svc.server.close(); }
});

test('文件夹上传的边界：路径逃逸、清单不匹配、空目录都要挡住', async () => {
  const { base, config } = fixture();
  const svc = await startServer({ config, agents: {}, port: 0 });
  const post = (manifest, buf, name = 'x') => fetch(`http://127.0.0.1:${svc.port}/api/upload-folder`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.secrets.token,
      'X-Folder-Name': encodeURIComponent(name),
      'X-Folder-Manifest': encodeURIComponent(JSON.stringify(manifest)),
    },
    body: buf,
  }).then(r => r.json());
  try {
    // 清单里的 ../ 必须被消毒，不能写到上传目录之外
    const evil = await post(['../../evil.txt'], buildTar([['../../evil.txt', 'x']]), 'evil');
    assert.ok(!fs.existsSync(path.join(base, 'evil.txt')), '不得写到上传目录之外');
    assert.ok(!fs.existsSync(path.join(path.dirname(base), 'evil.txt')), '不得写到工作区之外');
    assert.equal(evil.ok, true, '消毒后落在自己的上传目录里即可（不是拒绝，但也绝不能逃逸）');

    // 清单比内容多 / 内容比清单多：都要拒绝（否则会落一个不完整的目录）
    const fewer = await post(['a.txt', 'b.txt'], buildTar([['a.txt', 'a']]));
    assert.equal(fewer.ok, false, '清单多于内容必须拒绝：' + JSON.stringify(fewer).slice(0, 200));
    const more = await post(['a.txt'], buildTar([['a.txt', 'a'], ['b.txt', 'b']]));
    assert.equal(more.ok, false, '内容多于清单必须拒绝');

    // 空目录
    const empty = await post([], Buffer.alloc(0));
    assert.equal(empty.ok, false, '空文件夹必须拒绝');
    assert.match(String(empty.error), /空/, '错误信息要能看懂');
  } finally { svc.server.close(); }
});



