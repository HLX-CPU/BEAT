// 附件通道回归：客户要求"上传的所有类型附件都必须让 API 通道的模型读到"。
// API 通道（拓展坞 / Claude）读不到盘：图片走图片输入，其余必须由 BEAT 转成文本内联；
// 原生通道（Codex / DeepSeek）保持原样，只给路径 + 提示它们用工具读。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { converterCommand, attachmentText, readableAttachmentBlock, attachmentBlock, inlineTexts, isImage } from '../src/attachments.mjs';

const PY = converterCommand();
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-attach-'));
const hasLibs = PY ? spawnSync(PY, ['-c', 'import openpyxl, docx'], { encoding: 'utf8' }).status === 0 : false;

function makeXlsx(target) {
  const script = `import openpyxl,sys\nwb=openpyxl.Workbook();ws=wb.active;ws.title='表1'\nws.append(['城市','销量']);ws.append(['北京',120])\nwb.save(sys.argv[1])`;
  const r = spawnSync(PY, ['-c', script, target], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  return r.status === 0 && fs.existsSync(target);
}

test('API 通道能读到 Excel 的正文（不只是文件名）', { skip: !hasLibs ? '本机缺 openpyxl/docx' : false }, () => {
  const file = path.join(DIR, 'book.xlsx');
  assert.ok(makeXlsx(file), '先生成测试表格');
  const item = { name: 'book.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', image: false, size: fs.statSync(file).size, path: file };
  const text = attachmentText(item);
  assert.ok(text && text.includes('北京'), 'Excel 内容要转成文本：' + String(text).slice(0, 120));
  const block = readableAttachmentBlock([item]);
  assert.match(block, /附件正文/, '要给出一段"附件正文"');
  assert.ok(block.includes('北京') && block.includes('120'), '数值和中文都要在正文里（Windows 编码坑回归）');
  // 纯文本附件也必须内联（老实现只认 text/* 且会跳过二进制）
  const txt = path.join(DIR, 'note.txt');
  fs.writeFileSync(txt, '文本暗号 TXT-OK\n');
  const txtItem = { name: 'note.txt', mime: 'text/plain', image: false, size: fs.statSync(txt).size, path: txt };
  assert.ok(readableAttachmentBlock([txtItem]).includes('TXT-OK'), '文本附件要有正文');
});

test('图片走图片输入：正文块只给元信息，不重复塞文本', () => {
  const item = { name: 'shot.png', mime: 'image/png', image: true, size: 1234, path: path.join(DIR, 'nope.png') };
  const block = readableAttachmentBlock([item]);
  assert.match(block, /图片本体已作为图片输入/, '要说明图片本体走的是图片输入');
  assert.ok(!block.includes('无法把这种文件转成文本'), '图片不算"转不出来"');
});

test('原通道不变：原生搭档仍然只拿路径，靠工具自己读', () => {
  const item = { name: 'book.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', image: false, size: 10, path: path.join(DIR, 'book.xlsx') };
  const nativeBlock = attachmentBlock([item], 'codex');
  assert.match(nativeBlock, /请用你的文件读取工具打开上面的路径/, 'Codex 的说明保持"自己用工具读"');
  assert.ok(!nativeBlock.includes('附件正文'), '原生通道不该收到转好的正文（保持原样）');
  const apiBlock = attachmentBlock([item], 'dock:any');
  assert.match(apiBlock, /你无法读盘/, 'API 通道要明确告知它读不到盘');
  assert.ok(!/只能看到名字/.test(apiBlock), '文案不能再写"二进制只能看到名字"（现在会转文本）');
});

test('转不出来的文件如实说明，不假装成功', () => {
  const item = { name: 'weird.bin', mime: 'application/octet-stream', image: false, size: 10, path: path.join(DIR, 'missing.bin') };
  assert.equal(attachmentText(item), null, '转不出来要返回 null');
  assert.match(readableAttachmentBlock([item]), /无法把这种文件转成文本/, '要如实告诉模型这份读不了');
});

test('inlineTexts 只吃文本，不会把二进制当文本读', () => {
  const item = { name: 'book.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', image: false, size: 10, path: path.join(DIR, 'book.xlsx') };
  assert.equal(inlineTexts([item]), '', 'xlsx 不是纯文本，inlineTexts 不该硬读');
  assert.equal(isImage('a.PNG'), true);
});
