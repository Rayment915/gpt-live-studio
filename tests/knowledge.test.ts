import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { KnowledgeService } from '../server/knowledge/service';
import { newManifest, documentPrefix, type KnowledgeStore } from '../server/knowledge/store';
import { splitSections } from '../server/knowledge/azure';
import { estimateTokens, type KnowledgeManifest } from '../shared/knowledge';
import { withoutKnowledgeBodies } from '../server/knowledge/privacy';
import express from 'express';
import { knowledgeRoutes } from '../server/knowledge/routes';
import { abortable } from '../server/knowledge/deadline';
import { cleanupDocumentTemporaryFiles } from '../server/knowledge/parser';
import { mkdir, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

class MemoryStore implements KnowledgeStore {
  manifest = newManifest(); revision = 0; files = new Map<string, Buffer>();
  async read() { return { manifest: structuredClone(this.manifest), etag: String(this.revision) }; }
  async compareWrite(manifest: KnowledgeManifest, etag: string) { if (etag !== String(this.revision)) return false; this.manifest = structuredClone(manifest); this.revision++; return true; }
  async get(path: string) { const value = this.files.get(path); if (!value) throw new Error('missing'); return value; }
  async put(path: string, data: string | Buffer) { this.files.set(path, Buffer.from(data)); }
  async upload(path: string, stream: Readable) { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); await this.put(path, Buffer.concat(chunks)); }
  async removePrefix(prefix: string) { for (const key of this.files.keys()) if (key.startsWith(prefix)) this.files.delete(key); }
}
async function fixture(text = '设备可借用14天。', indexed = true) {
  const store = new MemoryStore(); const service = new KnowledgeService(store);
  const { document, generation } = await service.reserve('规则.md');
  await service.uploaded(document.id, Buffer.byteLength(text));
  Object.assign(store.manifest.documents[0], { parsed: true, indexed, tokens: estimateTokens(text), status: indexed ? 'ready' : 'processing' });
  await store.put(`${documentPrefix(generation, document.id)}parsed.json`, JSON.stringify({ sections: [{ location: '第1行', text }], tokens: estimateTokens(text), preview: false }));
  return { store, service, document };
}
describe('persistent knowledge lifecycle', () => {
  it('cleans crash leftovers only for the deleted document', async () => {
    const id = randomUUID(); const other = randomUUID();
    const first = `.knowledge-tmp/processing/${id}-fixture`; const second = `.knowledge-tmp/processing/${other}-fixture`;
    await mkdir(first, { recursive: true }); await mkdir(second, { recursive: true });
    try { await cleanupDocumentTemporaryFiles(id); await expect(access(first)).rejects.toThrow(); await expect(access(second)).resolves.toBeUndefined(); }
    finally { await cleanupDocumentTemporaryFiles(other); }
  });
  it('times out a stalled storage read and safely ignores its late rejection', async () => {
    const controller = new AbortController(); let finish!: (error: Error) => void;
    const work = new Promise<void>((_resolve, reject) => { finish = reject; });
    const pending = abortable(work, controller.signal); controller.abort();
    await expect(pending).rejects.toThrow('超时或已取消'); finish(new Error('late storage failure'));
    await expect(abortable(Promise.resolve('ok'), new AbortController().signal)).resolves.toBe('ok');
  });
  it('streams one multipart file, rejects oversized and additional parts, and preserves deletion tombstones', async () => {
    const store = new MemoryStore(); const service = new KnowledgeService(store);
    const app = express(); app.use(express.json()); app.use('/api/knowledge', knowledgeRoutes(service, () => {}, () => 0));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const upload = (name: string, bytes: string | Uint8Array, extra = false) => { const form = new FormData(); form.append('file', new Blob([bytes as BlobPart]), name); if (extra) form.append('extra', 'not allowed'); return fetch(`${origin}/api/knowledge/documents`, { method: 'POST', body: form }); };
    try {
      const response = await upload('中文资料.md', '设备可借用14天。'); expect(response.status).toBe(202);
      expect(store.manifest.documents[0].name).toBe('中文资料.md');
      expect(store.manifest.documents[0].status).toBe('queued');
      expect((await upload('extra.txt', 'text', true)).status).toBe(400);
      expect((await upload('large.txt', new Uint8Array(20 * 1024 * 1024 + 1))).status).toBe(400);
      expect(store.manifest.documents).toHaveLength(3);
      expect((await upload('fourth.md', 'text')).status).toBe(400);
      const deletion = await fetch(`${origin}/api/knowledge/documents/${store.manifest.documents[0].id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
      expect(deletion.status).toBe(202); expect(store.manifest.documents[0].status).toBe('deleting');
      expect((await upload('still-full.md', 'text')).status).toBe(400);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('redacts echoed document bodies but preserves answer and correlation IDs', () => {
    const event = { delegation_id: 'd1', event: { response: { output: [{ type: 'function_call_output', call_id: 'c1', output: 'PRIVATE_DOCUMENT' }, { type: 'message', text: 'answer' }] } } };
    const safe = withoutKnowledgeBodies(event);
    expect(JSON.stringify(safe)).not.toContain('PRIVATE_DOCUMENT');
    expect(safe.event.response.output[0].call_id).toBe('c1');
    expect(safe.event.response.output[1].text).toBe('answer');
    expect(JSON.stringify(event)).toContain('PRIVATE_DOCUMENT');
  });
  it('atomically reserves only three slots across simultaneous uploads, including failures', async () => {
    const store = new MemoryStore(); const service = new KnowledgeService(store);
    const result = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => service.reserve(`${i}.txt`)));
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(3);
    await service.uploaded(store.manifest.documents[0].id, 0, 'bad file');
    await expect(service.reserve('fourth.txt')).rejects.toThrow('最多三份');
    expect((await new KnowledgeService(store).store.read()).manifest.documents).toHaveLength(3);
  });
  it('uses IQ even for small documents without reading full text', async () => {
    const { service, store } = await fixture();
    store.files.clear();
    const snapshot = await service.snapshot();
    expect(snapshot.mode).toBe('iq');
    expect(await service.resolveMode(snapshot)).toBe('iq');
  });
  it('rejects removed modes, including legacy clients', async () => {
    const { service } = await fixture();
    for (const mode of ['auto', 'full', 'unknown']) {
      await expect(service.snapshot(mode as any)).rejects.toThrow('仅支持 Foundry IQ');
    }
  });
  it('waits for IQ indexing and never falls back to parsed text', async () => {
    const { service } = await fixture('测试', false);
    await expect(service.snapshot()).rejects.toThrow('索引尚未就绪');
  });
  it('uses IQ for large documents without a full-document budget', async () => {
    const { service } = await fixture('大'.repeat(100_000));
    expect(await service.resolveMode(await service.snapshot())).toBe('iq');
  });
  it('binds sessions to documents and invalidates immediately on deletion', async () => {
    const { service, store, document } = await fixture(); const snapshot = await service.snapshot('iq');
    await service.reserve('next.md');
    expect((await service.validate(snapshot)).map(d => d.id)).toEqual([document.id]);
    await expect(service.snapshot('iq', snapshot.revision)).rejects.toThrow('已更新');
    await service.markDelete(document.id);
    await expect(service.validate(snapshot)).rejects.toThrow('已删除');
    expect(await service.uploaded(document.id, 100)).toBe(false);
    expect(store.manifest.documents[0].status).toBe('deleting');
  });
  it('retains slots through failed cleanup and retries deletion instead of ingestion', async () => {
    const { store, service, document } = await fixture();
    store.manifest.documents[0].status = 'delete_failed';
    await service.retry(document.id); expect(store.manifest.documents[0].status).toBe('deleting');
    await service.markDelete(); await expect(service.reserve('new.txt')).rejects.toThrow('正在删除');
  });
  it('chunks Chinese and emoji without corrupting codepoints, preserving location', () => {
    const text = '中文🌏'.repeat(800);
    const chunks = splitSections({ sections: [{ text, location: '第 2 页' }], preview: true, tokens: estimateTokens(text) });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.location === '第 2 页' && !c.text.includes('\uFFFD') && estimateTokens(c.text) <= 802)).toBe(true);
    expect(chunks[0].text.startsWith('中文🌏')).toBe(true);
  });
});
