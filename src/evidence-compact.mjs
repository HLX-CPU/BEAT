// 核验材料瘦身：原生工具回执里可能夹着截图/base64（R368 实测 1.2MB），
// 原样塞进评审提示词会把模型上下文直接撑爆（DeepSeek 1M 上下文报 1,074,538 tokens）。
// 评审只需要“做了什么、产物路径、检查结果”，不需要整张图片的字节。
const DATA_URL = /^data:[^,]*,/i;
const BASE64_BLOB = /^(?:[A-Za-z0-9+/=]{512,}\r?\n?)+$/;
const IMAGE_MAGIC = /^(?:iVBORw0KG|\/9j\/|R0lGOD|UklGR|JVBERi0)/;

function isBlob(text) {
  if (typeof text !== 'string') return false;
  if (DATA_URL.test(text)) return true;
  if (text.length < 512) return false;
  if (IMAGE_MAGIC.test(text)) return true;
  return BASE64_BLOB.test(text);
}

function omitString(text) {
  if (!isBlob(text)) return text;
  const kind = DATA_URL.test(text) || IMAGE_MAGIC.test(text) ? '图片/二进制' : '大段数据';
  return '[' + kind + '已省略 ' + text.length + ' 字符]';
}

/**
 * 把任意证据对象压成可安全放进评审提示词的大小。
 * 不改变结构与关键字段（路径、摘要、状态都保留），只省略图片/二进制和超长文本。
 */
export function compactEvidence(value, { maxString = 1200, maxArray = 24, maxDepth = 6, maxChars = 60000 } = {}) {
  const seen = new WeakSet();
  const walk = (input, depth) => {
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') return input.length > maxString && !isBlob(input) ? input.slice(0, maxString) + '…[截断 ' + (input.length - maxString) + ' 字符]' : omitString(input);
    if (typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input !== 'object') return String(input);
    if (seen.has(input)) return '[循环引用已省略]';
    if (depth >= maxDepth) return '[层级过深已省略]';
    seen.add(input);
    if (Array.isArray(input)) {
      const out = input.slice(0, maxArray).map(item => walk(item, depth + 1));
      if (input.length > maxArray) out.push('…[共 ' + input.length + ' 项，其余已省略]');
      return out;
    }
    const out = {};
    for (const [key, item] of Object.entries(input)) out[key] = walk(item, depth + 1);
    return out;
  };
  let compact = walk(value, 0);
  let text = JSON.stringify(compact);
  // 第一遍还不够小：进一步收紧字符串/数组上限，仍保留结构。
  if (text && text.length > maxChars) {
    compact = compactEvidence(value, { maxString: 200, maxArray: 8, maxDepth: 4, maxChars: maxChars * 2 });
    text = JSON.stringify(compact);
  }
  if (text && text.length > maxChars) {
    return { truncated: true, originalChars: text.length, note: '证据过大，已只保留摘要；完整回执在产出报告文件中' };
  }
  return compact;
}
