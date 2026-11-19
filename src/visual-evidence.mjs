import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hashMatches = item => {
  try { return createHash('sha256').update(fs.readFileSync(item.path)).digest('hex') === item.sha256; } catch { return false; }
};
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

export function visualAttachments(evidence, root) {
  const groups = (evidence || []).filter(item => item.status === 'rendered' && hashMatches({ path: item.file, sha256: item.sha256 }) && item.imageHashes?.length && item.imageHashes.every(image => {
    try { return hashMatches(image) && inside(fs.realpathSync(root), fs.realpathSync(image.path)); } catch { return false; }
  })).map(item => item.imageHashes);
  // Give every source a frame before taking additional animation frames.
  const images = groups.map(group => group[0]);
  for (const group of groups) images.push(...group.slice(1, 2));
  return images.map(item => ({ name: path.basename(item.path), path: item.path, size: fs.statSync(item.path).size, mime: 'image/png', image: true, sha256: item.sha256 }));
}

export function verificationWaitMessage(row) {
  const issues = [...(row?.issues || []), ...(row?.result?.verdict?.issues || [])].filter(issue => typeof issue === 'string');
  const reason = issues.find(issue => /图片|图像|截图|渲染|预算|范围|会话|搭档/.test(issue)) || issues[0];
  return (reason ? reason.slice(0, 350) : '独立核验尚未完成，具体原因未记录') + '；已有成果保留，点“继续”接着检查。';
}

export function imageReadFailure(verdict) {
  return verdict?.pass === false && (verdict.issues || []).some(issue => /(?:未收到|没有收到|未能.*查看|无法.*查看|不能读取|无法读取).{0,35}(?:图片|图像|PNG|render\.png)|(?:图片|图像).{0,20}(?:未收到|没有收到|无法读取)/i.test(String(issue?.problem || issue)));
}
