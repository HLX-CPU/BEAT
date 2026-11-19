"""把用户上传的附件转成纯文本，供"读不到盘的 API 搭档（拓展坞 / Claude）"在提示词里内联。

原生搭档（Codex / DeepSeek）不走这里：它们自己能用工具打开路径，客户要求保持原样。
输出一律打到 stdout（UTF-8），出错打到 stderr 并以退出码 2 结束，调用方据此降级。
用法：python attach2text.py <文件路径> [最大字符数]
"""
import sys
import os
import json
import zipfile

LIMIT = 20000

# Windows 上默认按本地编码（GBK/cp936）写 stdout，调用方按 UTF-8 解会乱码；
# 这里直接以 UTF-8 字节写，不依赖任何 locale 设置。
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')


def out(text):
    sys.stdout.write(text if text is not None else '')


def clip(text, limit):
    if text is None:
        return ''
    text = str(text)
    if len(text) <= limit:
        return text
    return text[:limit] + f'\n…（已截断，原文共 {len(text)} 字）'


def ext_of(path):
    return os.path.splitext(path)[1].lower().lstrip('.')


def read_xlsx(path, limit):
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    parts = []
    for ws in wb.worksheets:
        parts.append(f'### 工作表：{ws.title}（{ws.max_row} 行 × {ws.max_column} 列）')
        rows = 0
        for row in ws.iter_rows(values_only=True):
            if all(v is None for v in row):
                continue
            cells = ['' if v is None else str(v).replace('\n', ' ') for v in row]
            parts.append('| ' + ' | '.join(cells) + ' |')
            rows += 1
            if rows >= 200:
                parts.append(f'…（本表只列前 200 行）')
                break
        parts.append('')
    wb.close()
    return clip('\n'.join(parts), limit)


def read_docx(path, limit):
    import docx
    d = docx.Document(path)
    parts = []
    for p in d.paragraphs:
        if p.text.strip():
            parts.append(p.text)
    for i, table in enumerate(d.tables, 1):
        parts.append(f'\n### 表格 {i}')
        for row in table.rows:
            parts.append('| ' + ' | '.join(c.text.replace('\n', ' ').strip() for c in row.cells) + ' |')
    return clip('\n'.join(parts), limit)


def read_pptx(path, limit):
    from pptx import Presentation
    prs = Presentation(path)
    parts = []
    for i, slide in enumerate(prs.slides, 1):
        parts.append(f'### 第 {i} 页')
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                parts.append(shape.text_frame.text)
    return clip('\n'.join(parts), limit)


def read_pdf(path, limit):
    # 不引第三方依赖：先试 pypdf（如果环境里有），否则从 PDF 的流里抠可读文本碎片。
    try:
        from pypdf import PdfReader
        reader = PdfReader(path)
        return clip('\n'.join((page.extract_text() or '') for page in reader.pages), limit)
    except Exception:
        pass
    data = open(path, 'rb').read()
    chunks = []
    for marker in (b'BT', b'Tj'):
        chunks.append(data.count(marker))
    text = data.decode('latin-1', 'ignore')
    import re
    pieces = re.findall(r'\((?:[^()\\]|\\.){2,200}\)', text)
    joined = ' '.join(p[1:-1] for p in pieces[:4000])
    note = '（PDF 无文本提取库，以下是从文件里抠出的文本碎片，可能不完整）\n'
    return clip(note + joined, limit)


def read_image(path, limit):
    from PIL import Image
    im = Image.open(path)
    return f'（图片 {im.format} {im.width}×{im.height}；图片本体已作为图片输入随消息发送，这里给的是元信息）'


def read_zip(path, limit):
    names = []
    with zipfile.ZipFile(path) as z:
        for info in z.infolist()[:500]:
            names.append(f'{info.filename}（{info.file_size} 字节）')
    return clip('压缩包内文件：\n' + '\n'.join(names), limit)


def main():
    if len(sys.argv) < 2:
        sys.stderr.write('用法：attach2text.py <文件> [最大字符数]\n')
        return 2
    path = sys.argv[1]
    limit = int(sys.argv[2]) if len(sys.argv) > 2 and str(sys.argv[2]).isdigit() else LIMIT
    if not os.path.isfile(path):
        sys.stderr.write('文件不存在：' + path + '\n')
        return 2
    ext = ext_of(path)
    kind = {
        'xlsx': 'Excel 表格', 'xlsm': 'Excel 表格', 'xls': 'Excel 表格', 'csv': 'CSV 表格', 'tsv': 'TSV 表格',
        'docx': 'Word 文档', 'doc': 'Word 文档', 'pptx': 'PPT 演示', 'ppt': 'PPT 演示', 'pdf': 'PDF 文档',
        'zip': '压缩包', 'json': 'JSON', 'txt': '文本', 'md': 'Markdown', 'log': '日志',
        'png': '图片', 'jpg': '图片', 'jpeg': '图片', 'gif': '图片', 'webp': '图片', 'bmp': '图片',
    }.get(ext, '文件')
    try:
        if ext in ('xlsx', 'xlsm'):
            body = read_xlsx(path, limit)
        elif ext == 'docx':
            body = read_docx(path, limit)
        elif ext == 'pptx':
            body = read_pptx(path, limit)
        elif ext == 'pdf':
            body = read_pdf(path, limit)
        elif ext == 'zip':
            body = read_zip(path, limit)
        elif ext in ('png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'):
            body = read_image(path, limit)
        else:
            with open(path, 'r', encoding='utf-8', errors='replace') as fh:
                body = clip(fh.read(), limit)
    except Exception as exc:  # 转不出来就如实说明，不假装成功
        sys.stderr.write(f'{kind}解析失败：{type(exc).__name__}: {exc}\n')
        return 2
    if not body.strip():
        body = f'（{kind}没有可提取的文本内容）'
    out(body)
    return 0


if __name__ == '__main__':
    sys.exit(main())
