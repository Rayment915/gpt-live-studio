import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DefaultAzureCredential } from '@azure/identity';
import { estimateTokens, type ParsedDocument } from '../../shared/knowledge.js';

const execute = promisify(execFile);
const processingRoot = resolve('.knowledge-tmp/processing');
export async function cleanupDocumentTemporaryFiles(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('文档任务 ID 无效');
  const names = await readdir(processingRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of names.filter(name => name.startsWith(`${id}-`))) await rm(join(processingRoot, name), { recursive: true, force: true });
}
export async function parseDocument(bytes: Buffer, extension: string, signal?: AbortSignal, taskId?: string): Promise<{ parsed: ParsedDocument; preview?: Buffer }> {
  signal?.throwIfAborted();
  const requestSignal = (ms: number) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  await mkdir(processingRoot, { recursive: true, mode: 0o700 });
  if (taskId) await cleanupDocumentTemporaryFiles(taskId);
  const directory = await mkdtemp(join(processingRoot, `${taskId ?? 'sample'}-`));
  const path = join(directory, `document${extension}`);
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    try { await execute(resolve('.venv/bin/python'), [resolve('scripts/validate-document.py'), path, extension], { timeout: 30_000, maxBuffer: 65536, signal }); }
    catch (error: any) {
      let message = '文档无效，或缺少 .venv 文档处理依赖';
      try { message = JSON.parse(error.stdout).error; } catch {}
      throw new Error(message);
    }
    if (['.txt', '.md', '.markdown'].includes(extension)) {
      const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
      if (!text.trim()) throw new Error('文档没有可读取正文');
      const lines = text.split('\n');
      const sections: ParsedDocument['sections'] = [];
      for (let offset = 0; offset < lines.length; offset += 80) sections.push({ location: `第 ${offset + 1}–${Math.min(offset + 80, lines.length)} 行`, text: lines.slice(offset, offset + 80).join('\n') });
      return { parsed: { sections, tokens: estimateTokens(text), preview: false } };
    }
    let pdf = bytes;
    if (extension !== '.pdf') {
      const profile = join(directory, 'profile');
      await mkdir(join(profile, 'user'), { recursive: true });
      // Bundled headless LibreOffice on macOS needs explicit system font paths.
      const fontEnvironment: NodeJS.ProcessEnv = { ...process.env };
      if (process.platform === 'darwin' && !process.env.FONTCONFIG_FILE) {
        const fontConfig = join(directory, 'fonts.conf');
        await writeFile(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir><cachedir>${directory}/font-cache</cachedir></fontconfig>`);
        fontEnvironment.FONTCONFIG_FILE = fontConfig;
      }
      await writeFile(join(profile, 'user', 'registrymodifications.xcu'), '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateLinks" oor:op="fuse"><value>false</value></prop></item></oor:items>');
      await execute(process.env.KNOWLEDGE_SOFFICE ?? 'soffice', [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', 'pdf', '--outdir', directory, path], { timeout: 120_000, maxBuffer: 65536, env: fontEnvironment, signal });
      pdf = await readFile(join(directory, 'document.pdf'));
    }
    if (pdf.length > 50 * 1024 * 1024) throw new Error('转换后的 PDF 超过 50 MB');
    const base = process.env.KNOWLEDGE_OCR_ENDPOINT;
    if (!base) throw new Error('未配置 Document Intelligence');
    const headers: Record<string, string> = { 'Content-Type': 'application/pdf' };
    if (process.env.KNOWLEDGE_OCR_KEY) headers['Ocp-Apim-Subscription-Key'] = process.env.KNOWLEDGE_OCR_KEY;
    else headers.Authorization = `Bearer ${(await new DefaultAzureCredential().getToken('https://cognitiveservices.azure.com/.default'))!.token}`;
    const result = await fetch(new URL('/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=2024-11-30&outputContentFormat=markdown&stringIndexType=utf16CodeUnit', base), { method: 'POST', headers, body: new Uint8Array(pdf), signal: requestSignal(90_000) });
    if (!result.ok) throw new Error(`OCR 提交失败 (${result.status})`);
    const operation = result.headers.get('operation-location');
    if (!operation || new URL(operation).origin !== new URL(base).origin) throw new Error('OCR 返回无效任务位置');
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await delay(1500, undefined, { signal });
      const response = await fetch(operation, { headers, signal: requestSignal(30_000) });
      if (!response.ok) throw new Error(`OCR 查询失败 (${response.status})`);
      const data = await response.json();
      if (data.status === 'failed') throw new Error('OCR 无法解析该文件，请检查文件内容或加密状态');
      if (data.status !== 'succeeded') continue;
      const analysis = data.analyzeResult;
      const sections = (analysis.pages ?? []).map((page: any) => ({ location: `${extension === '.pdf' ? '' : '转换后 '}第 ${page.pageNumber} 页`, text: (page.spans ?? []).map((span: any) => analysis.content.slice(span.offset, span.offset + span.length)).join('\n') })).filter((section: any) => section.text.trim());
      if (!sections.length && analysis.content?.trim()) sections.push({ location: '文档正文', text: analysis.content });
      if (!sections.length) throw new Error('OCR 未提取到可用正文');
      return { parsed: { sections, tokens: estimateTokens(sections.map((section: any) => section.text).join('\n')), preview: true }, preview: pdf };
    }
    throw new Error('OCR 处理超过 10 分钟，请重试');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
