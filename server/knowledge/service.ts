import { randomUUID } from 'node:crypto';
import { extname, basename } from 'node:path';
import { KNOWLEDGE_EXTENSIONS, MAX_DOCUMENTS, MAX_DOCUMENT_BYTES, readable, type KnowledgeSnapshot, type KnowledgeMode } from '../../shared/knowledge.js';
import { mutate, type KnowledgeStore } from './store.js';

export class KnowledgeService {
  constructor(public store: KnowledgeStore) {}
  async reserve(filename: string) {
    const name = basename(filename.replaceAll('\\', '/')).replace(/[\x00-\x1f]/g, '').slice(0, 180);
    const extension = extname(name).toLowerCase();
    if (!KNOWLEDGE_EXTENSIONS.includes(extension)) throw new Error('不支持的文档格式');
    return mutate(this.store, manifest => {
      if (manifest.deleting) throw new Error('知识库正在删除');
      if (manifest.documents.length >= MAX_DOCUMENTS) throw new Error('最多三份文档，请先删除已有文档');
      const now = new Date().toISOString();
      const id = randomUUID();
      const document = { id, version: id, name, extension, bytes: 0, status: 'uploading' as const, createdAt: now, updatedAt: now, attempts: 0, nextAttempt: 0 };
      manifest.documents.push(document); manifest.revision++;
      return { document, generation: manifest.generation };
    });
  }
  async uploaded(id: string, bytes: number, failure?: string) {
    return mutate(this.store, manifest => {
      const document = manifest.documents.find(item => item.id === id);
      if (!document || manifest.deleting || ['deleting', 'delete_failed'].includes(document.status)) return false;
      document.bytes = bytes; document.updatedAt = new Date().toISOString();
      document.status = failure || !bytes || bytes > MAX_DOCUMENT_BYTES ? 'failed' : 'queued';
      document.error = failure ?? (!bytes ? '文件为空' : bytes > MAX_DOCUMENT_BYTES ? '文档超过 20 MB' : undefined);
      return true;
    });
  }
  async snapshot(mode: KnowledgeMode = 'iq', revision?: number): Promise<KnowledgeSnapshot> {
    if (mode !== 'iq') throw new Error('知识库仅支持 Foundry IQ 问答');
    const { manifest } = await this.store.read();
    if (manifest.deleting) throw new Error('知识库正在删除');
    if (revision !== undefined && revision !== manifest.revision) throw new Error('知识库已更新，请刷新后重新开始');
    const documents = manifest.documents.filter(readable);
    if (!documents.length) throw new Error('请先上传文档并等待正文解析完成');
    const snapshot = { generation: manifest.generation, revision: manifest.revision, documentIds: documents.map(item => item.id), mode };
    await this.resolveMode(snapshot);
    return snapshot;
  }
  async validate(snapshot: KnowledgeSnapshot) {
    const { manifest } = await this.store.read();
    if (manifest.deleting || manifest.generation !== snapshot.generation || snapshot.documentIds.some(id => !manifest.documents.some(item => item.id === id && readable(item)))) throw new Error('知识库资料已删除或失效，请重新开始会话');
    return manifest.documents.filter(item => snapshot.documentIds.includes(item.id));
  }
  async resolveMode(snapshot: KnowledgeSnapshot) {
    if (snapshot.mode !== 'iq') throw new Error('知识库仅支持 Foundry IQ 问答');
    const documents = await this.validate(snapshot);
    if (documents.some(item => !item.indexed)) throw new Error('Foundry IQ 索引尚未就绪，请等待处理完成');
    return 'iq' as const;
  }
  async markDelete(id?: string) {
    return mutate(this.store, manifest => {
      if (id && !manifest.documents.some(item => item.id === id)) throw new Error('文档不存在');
      if (!id) { manifest.deleting = true; manifest.deleteError = undefined; manifest.deleteAttempts = 0; manifest.nextDeleteAttempt = 0; }
      for (const document of manifest.documents) if (!id || document.id === id) {
        document.nextAttempt = document.status === 'uploading' ? Date.now() + 125_000 : 0;
        document.status = 'deleting'; document.attempts = 0; document.error = undefined;
      }
      manifest.revision++;
      return manifest.generation;
    });
  }
  async retry(id: string) {
    await mutate(this.store, manifest => {
      const document = manifest.documents.find(item => item.id === id);
      if (!document || manifest.deleting || !['failed', 'delete_failed'].includes(document.status)) throw new Error('该文档不能重试');
      document.status = document.status === 'delete_failed' ? 'deleting' : 'queued';
      document.attempts = 0; document.nextAttempt = 0; document.error = undefined;
    });
  }
}
