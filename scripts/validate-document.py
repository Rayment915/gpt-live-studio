import json
import sys
import zipfile
from pathlib import Path

import olefile
from pypdf import PdfReader


def validate(path, extension):
    if extension in ('.doc', '.ppt'):
        with olefile.OleFileIO(path) as document:
            expected = 'WordDocument' if extension == '.doc' else 'PowerPoint Document'
            if not document.exists(expected):
                raise ValueError('旧版 Office 内容与扩展名不匹配')
    elif extension in ('.docx', '.pptx'):
        with zipfile.ZipFile(path) as document:
            entries = document.infolist()
            if sum(entry.file_size for entry in entries) > 200 * 1024 * 1024:
                raise ValueError('Office 解压大小超过 200 MB')
            expected = 'word/document.xml' if extension == '.docx' else 'ppt/presentation.xml'
            if expected not in document.namelist():
                raise ValueError('Office 内容与扩展名不匹配')
            if any('vbaproject' in entry.filename.lower() for entry in entries):
                raise ValueError('不支持包含宏的文档')
            for entry in entries:
                if entry.filename.endswith('.rels') and b'TargetMode="External"' in document.read(entry):
                    if b'oleObject' in document.read(entry) or b'attachedTemplate' in document.read(entry):
                        raise ValueError('不支持外部嵌入对象或模板')
    elif extension == '.pdf':
        document = PdfReader(path, strict=False)
        if document.is_encrypted:
            raise ValueError('请先解密 PDF')
        if not len(document.pages) or len(document.pages) > 2000:
            raise ValueError('PDF 页数必须在 1–2000 之间')
    else:
        content = Path(path).read_bytes()
        if b'\x00' in content:
            raise ValueError('文本文件不能包含二进制内容；请使用 UTF-8')
        content.decode('utf-8-sig')


try:
    validate(sys.argv[1], sys.argv[2])
    print(json.dumps({'valid': True}))
except Exception as error:
    print(json.dumps({'valid': False, 'error': str(error)[:200]}, ensure_ascii=False))
    sys.exit(1)
