import { Router } from 'express';
import busboy from 'busboy';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS, readable } from '../../shared/knowledge.js';
import { documentPrefix } from './store.js';
import { KnowledgeService } from './service.js';

export function knowledgeRoutes(service: KnowledgeService | undefined, invalidate: (id?: string) => void, activeSessions: () => number) {
  const router = Router();
  router.use((_request, response, next) => { if (!service) return void response.status(503).json({ error: '尚未配置知识库服务' }); next(); });
  router.get('/', async (_request, response, next) => {
    try { response.json({ ...(await service!.store.read()).manifest, configured: true, maxDocuments: MAX_DOCUMENTS, maxBytes: MAX_DOCUMENT_BYTES, activeSessions: activeSessions() }); } catch (error) { next(error); }
  });
  router.post('/documents', async (request, response, next) => {
    let reservation: Awaited<ReturnType<KnowledgeService['reserve']>> | undefined;
    try {
      const parser = busboy({ headers: request.headers, defParamCharset: 'utf8', limits: { files: 1, fileSize: MAX_DOCUMENT_BYTES + 1, fields: 0, parts: 2 } });
      let job: Promise<void> | undefined; let failure: Error | undefined; let bytes = 0;
      parser.on('filesLimit', () => { failure = new Error('每次只能上传一份文档'); });
      parser.on('partsLimit', () => { failure = new Error('上传请求包含多余字段'); });
      parser.on('fieldsLimit', () => { failure = new Error('上传请求包含多余字段'); });
      parser.on('file', (_name, file, info) => {
        job = (async () => {
          try {
            reservation = await service!.reserve(info.filename);
            const counting = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(null, chunk); } });
            file.on('limit', () => { failure = new Error('文档超过 20 MB'); });
            const path = `${documentPrefix(reservation.generation, reservation.document.id)}original${reservation.document.extension}`;
            const upload = service!.store.upload(path, counting);
            await Promise.all([pipeline(file, counting), upload]);
          } catch (error) { failure = error as Error; file.resume(); }
        })();
      });
      const timer = setTimeout(() => request.destroy(new Error('上传超时')), 120_000);
      try { await pipeline(request, parser); } finally { await job; clearTimeout(timer); }
      if (!reservation) throw failure ?? new Error('请选择要上传的文件');
      if (!bytes || bytes > MAX_DOCUMENT_BYTES) failure = new Error(bytes ? '文档超过 20 MB' : '文件为空');
      const accepted = await service!.uploaded(reservation.document.id, bytes, failure?.message);
      if (!accepted || failure) await service!.store.removePrefix(documentPrefix(reservation.generation, reservation.document.id));
      if (failure) throw failure;
      if (!accepted) throw new Error('上传期间知识库已删除');
      response.status(202).json({ id: reservation.document.id, status: 'queued' });
    } catch (error) {
      if (reservation) await service!.uploaded(reservation.document.id, 0, '上传失败，请删除后重新上传').catch(() => {});
      next(error);
    }
  });
  router.post('/documents/:id/retry', async (request, response, next) => {
    try { await service!.retry(request.params.id); response.status(202).json({ accepted: true }); } catch (error) { next(error); }
  });
  router.get('/documents/:id/content', async (request, response, next) => {
    try {
      const { manifest } = await service!.store.read();
      const document = manifest.documents.find(item => item.id === request.params.id && readable(item));
      if (!document || manifest.deleting) return void response.status(404).json({ error: '文档不存在或已删除' });
      const prefix = documentPrefix(manifest.generation, document.id);
      const isPdf = request.query.preview === '1' && !['.txt', '.md', '.markdown'].includes(document.extension);
      const bytes = await service!.store.get(`${prefix}${isPdf ? 'preview.pdf' : `original${document.extension}`}`);
      const latest = (await service!.store.read()).manifest;
      if (latest.deleting || !latest.documents.some(item => item.id === document.id && readable(item))) return void response.sendStatus(410);
      response.setHeader('Content-Type', isPdf || document.extension === '.pdf' ? 'application/pdf' : ['.txt', '.md', '.markdown'].includes(document.extension) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
      response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(document.name + (isPdf && document.extension !== '.pdf' ? '.pdf' : ''))}`);
      response.send(bytes);
    } catch (error) { next(error); }
  });
  const deletion = async (id: string | undefined, confirmed: unknown) => {
    if (confirmed !== true) throw new Error('请确认删除并结束受影响的知识库会话');
    await service!.markDelete(id); invalidate(id);
  };
  router.delete('/documents/:id', async (request, response, next) => { try { await deletion(request.params.id, request.body.confirmed); response.status(202).json({ status: 'deleting' }); } catch (error) { next(error); } });
  router.delete('/', async (request, response, next) => { try { await deletion(undefined, request.body.confirmed); response.status(202).json({ status: 'deleting' }); } catch (error) { next(error); } });
  router.use((error: any, _request: any, response: any, _next: any) => response.status(400).json({ error: error?.name === 'RestError' ? '知识库云服务暂时不可用' : String(error.message ?? '知识库请求失败').slice(0, 250) }));
  return router;
}
