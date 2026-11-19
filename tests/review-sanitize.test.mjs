import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sanitizeDeliveryVerdict, verifyGoalReadback } from '../src/delivery-verification.mjs';
import { artifactsRoot } from './helpers/temp.mjs';

const root = artifactsRoot();
fs.mkdirSync(root, { recursive: true });
const file = path.join(fs.mkdtempSync(path.join(root, 'review-sanitize-')), 'hello.txt');
fs.writeFileSync(file, 'HELLO BEAT');
const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const contract = {
  version: 1,
  goalHash: createHash('sha256').update('目标').digest('hex'),
  originalGoal: '在当前工作目录新建 hello.txt，内容严格为 HELLO BEAT，完成后告诉我。',
  subject: '',
  attachments: [],
};

test('复核模型的字节口误和"告知"要求不阻塞正确产物（R417/R418 回归）', () => {
  const verdict = {
    pass: false,
    goalHash: contract.goalHash,
    goalChecks: { object: 'verified', deliverables: 'unverified', prohibitions: 'verified' },
    issues: [
      '严格内容核验存在矛盾：本次 file_read 返回文本为“HELLO BEAT”（9 个 ASCII 字符），但 bytes 和 totalBytes 均为 10；原执行日志中的字节核验也返回 bytes=10。现有证据无法解释额外的 1 字节，不能确认文件内容严格等于指定字符串。',
      '未提供原执行者向用户报告完整路径的最终回复，无法验证“把文件的完整路径告诉我”这一交付要求已完成。工具回执包含路径不等于已向用户报告。',
      '“完成后告诉我”未验证：所提供的证据没有执行者最终通知用户的消息。',
      '交付要求未得到独立核验',
    ],
    readbacks: [{ path: file, sha256, quote: 'HELLO BEAT' }],
  };
  const sanitized = sanitizeDeliveryVerdict(verdict, { artifacts: [file] });
  assert.deepEqual(sanitized.verdict.issues, [], '软意见/数字口误不应留作阻塞 issue');
  assert.equal(sanitized.verdict.pass, true);
  assert.equal(sanitized.verdict.goalChecks.deliverables, 'verified');
  assert.ok(sanitized.notes.length >= 3, '被降级的意见要保留为备注');
  const result = verifyGoalReadback(sanitized.verdict, [file], contract);
  assert.equal(result.pass, true, '代码核验通过后不应再被模型意见判失败');
});

test('文件名大小写差异只作备注，不把正确交付判失败（R426 回归）', () => {
  const verdict = {
    pass: false,
    goalHash: contract.goalHash,
    goalChecks: { object: 'verified', deliverables: 'failed', prohibitions: 'verified' },
    issues: ['Get-Item 实读文件名为 beat夜间验证.txt，与要求的 BEAT夜间验证.txt 大小写不一致；Windows 下可定位同一文件，但名称未逐字满足要求。'],
    readbacks: [{ path: file, sha256, quote: 'HELLO BEAT' }],
  };
  const sanitized = sanitizeDeliveryVerdict(verdict, { artifacts: [file] });
  assert.equal(sanitized.verdict.goalChecks.deliverables, 'verified');
  assert.equal(sanitized.verdict.pass, true);
  assert.equal(verifyGoalReadback(sanitized.verdict, [file], contract).pass, true);
});

test('目标文件本来就有且内容正确时，不要求本次必须有"新建"调用（R428 回归）', () => {
  const verdict = {
    pass: false,
    goalHash: contract.goalHash,
    goalChecks: { object: 'verified', deliverables: 'failed', prohibitions: 'verified' },
    issues: ['“新建”未验证：完整工具日志仅包含 glob、read、pwsh 读取操作，没有创建文件的调用；产出记录标记 unchanged=true。', '交付要求未得到独立核验'],
    readbacks: [{ path: file, sha256, quote: 'HELLO BEAT' }],
  };
  const sanitized = sanitizeDeliveryVerdict(verdict, { artifacts: [{ path: file, unchanged: true }] });
  assert.equal(sanitized.verdict.pass, true);
  assert.equal(sanitized.verdict.goalChecks.deliverables, 'verified');
  assert.equal(verifyGoalReadback(sanitized.verdict, [file], contract).pass, true);
});

test('真正的文件问题仍然会被拦住（不是降低标准）', () => {
  const wrong = {
    pass: true,
    goalHash: contract.goalHash,
    goalChecks: { object: 'verified', deliverables: 'verified', prohibitions: 'verified' },
    issues: [],
    readbacks: [{ path: file, sha256: '0'.repeat(64), quote: 'HELLO BEAT' }],
  };
  assert.equal(verifyGoalReadback(wrong, [file], contract).pass, false, '哈希不对仍然失败');
  const hard = {
    pass: false,
    goalHash: contract.goalHash,
    goalChecks: { object: 'failed', deliverables: 'failed', prohibitions: 'verified' },
    issues: ['文件内容与要求不符：hello.txt 实际写成了 HELLO WORLD'],
    readbacks: [],
  };
  const sanitized = sanitizeDeliveryVerdict(hard, { artifacts: [file] });
  assert.equal(sanitized.verdict.pass, false);
  assert.equal(sanitized.verdict.issues.length, 1, '真实内容问题不能被当成软意见吞掉');
});
