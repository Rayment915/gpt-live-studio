import 'dotenv/config';
import { BlobKnowledgeStore, documentPrefix, mutate, newManifest } from './store.js';
import { AzureKnowledge } from './azure.js';
import { cleanupDocumentTemporaryFiles, parseDocument } from './parser.js';
import type { ParsedDocument } from '../../shared/knowledge.js';

const store = new BlobKnowledgeStore();
const azure = new AzureKnowledge();
await store.init();
const lock = store.container.getBlockBlobClient('worker-lock');
try { await lock.upload('', 0, { conditions: { ifNoneMatch: '*' } }); } catch (error: any) { if (![409, 412].includes(error.statusCode)) throw error; }
const lease = lock.getBlobLeaseClient();
let stop = false;
process.on('SIGTERM', () => { stop = true; });
process.on('SIGINT', () => { stop = true; });
try { await lease.acquireLease(60); }
catch (error: any) {
  if (error.statusCode === 409) { console.log('Another worker holds the lease; this execution is complete'); process.exit(0); }
  throw error;
}
// Scheduled jobs drain work then exit; local workers retain their continuous behavior.
const idleExitMs = Number(process.env.KNOWLEDGE_WORKER_IDLE_EXIT_SECONDS ?? 0) * 1000;
const maxRuntimeMs = Number(process.env.KNOWLEDGE_WORKER_MAX_SECONDS ?? 0) * 1000;
const startedAt = Date.now();
let lastWorkAt = startedAt;
const renew = setInterval(() => { void lease.renewLease().catch(() => { console.error('worker lease lost'); process.exit(1); }); }, 20_000);
const heartbeat = setInterval(() => { void mutate(store, manifest => { manifest.workerHeartbeat = Date.now(); }).catch(() => {}); }, 15_000);
console.log('Knowledge worker running (durable Blob queue; concurrency=1)');
try {
  await mutate(store, manifest => {
    for (const document of manifest.documents) if (document.status === 'processing') document.status = 'queued';
  });
  while (!stop) {
    if (maxRuntimeMs > 0 && Date.now() - startedAt >= maxRuntimeMs) break;
    try {
      await mutate(store, manifest => {
        manifest.workerHeartbeat = Date.now();
        for (const document of manifest.documents) if (document.status === 'uploading' && Date.now() - Date.parse(document.createdAt) > 5 * 60_000) {
          document.status = 'failed'; document.error = '上传中断，请删除后重新上传';
        }
      });
      const { manifest } = await store.read();
      if (manifest.deleting && !manifest.documents.length && (manifest.deleteAttempts ?? 0) < 3 && (manifest.nextDeleteAttempt ?? 0) <= Date.now()) {
        try {
          await azure.deleteBase(manifest.generation);
          await store.removePrefix(`documents/${manifest.generation}/`);
          await mutate(store, state => { if (state.generation === manifest.generation) Object.assign(state, newManifest()); });
        } catch { await mutate(store, state => { state.deleteError = '云端知识库清理失败，请重试删除'; state.deleteAttempts = (state.deleteAttempts ?? 0) + 1; state.nextDeleteAttempt = Date.now() + state.deleteAttempts * 5000; }); }
      }
      const document = manifest.documents.find(item => item.status === 'deleting' && item.nextAttempt <= Date.now()) ?? manifest.documents.find(item => item.status === 'queued' && item.nextAttempt <= Date.now());
      if (!document) {
        if (idleExitMs > 0 && Date.now() - lastWorkAt >= idleExitMs) break;
        await new Promise(resolve => setTimeout(resolve, 2000)); continue;
      }
      lastWorkAt = Date.now();
      const deleting = document.status === 'deleting';
      const generation = manifest.generation;
      const prefix = documentPrefix(generation, document.id);
      const cancellation = new AbortController();
      let cancelWatch: ReturnType<typeof setInterval> | undefined;
      try {
        if (deleting) {
          await azure.deleteDocument(generation, document.id);
          await cleanupDocumentTemporaryFiles(document.id);
          await store.removePrefix(prefix);
          await mutate(store, state => { state.documents = state.documents.filter(item => item.id !== document.id); });
          continue;
        }
        const claimed = await mutate(store, state => {
          const current = state.documents.find(item => item.id === document.id);
          if (!current || current.status !== 'queued' || state.deleting) return false;
          current.status = 'processing'; current.attempts++; current.updatedAt = new Date().toISOString(); return true;
        });
        if (!claimed) continue;
        cancelWatch = setInterval(() => {
          if (cancellation.signal.aborted) return;
          void store.read().then(({ manifest: current }) => {
            if (current.generation !== generation || current.deleting || current.documents.find(item => item.id === document.id)?.status !== 'processing') cancellation.abort();
          }).catch(() => cancellation.abort());
        }, 1000);
        let parsed: ParsedDocument;
        if (document.parsed) parsed = JSON.parse((await store.get(`${prefix}parsed.json`, cancellation.signal)).toString());
        else {
          const result = await parseDocument(await store.get(`${prefix}original${document.extension}`, cancellation.signal), document.extension, cancellation.signal, document.id);
          parsed = result.parsed;
          cancellation.signal.throwIfAborted();
          await store.put(`${prefix}parsed.json`, JSON.stringify(parsed), 'application/json');
          if (result.preview) await store.put(`${prefix}preview.pdf`, result.preview, 'application/pdf');
          await mutate(store, state => {
            const current = state.documents.find(item => item.id === document.id);
            if (!current || current.status !== 'processing' || state.deleting) return;
            current.parsed = true; current.tokens = parsed.tokens; state.revision++;
          });
        }
        const fresh = (await store.read()).manifest;
        if (fresh.deleting || fresh.documents.find(item => item.id === document.id)?.status !== 'processing') continue;
        await azure.index(generation, document, parsed, cancellation.signal);
        await mutate(store, state => {
          const current = state.documents.find(item => item.id === document.id);
          if (!current || current.status !== 'processing' || state.deleting) return;
          current.indexed = true; current.status = 'ready'; current.error = undefined; current.updatedAt = new Date().toISOString();
        });
        console.log(`Document ${document.id} ready`);
      } catch (error) {
        const safe = error instanceof Error && /^(Azure \d|OCR |文档|Office|PDF|请|不支持|旧版|文本|未配置|索引|转换后)/.test(error.message) ? error.message.slice(0, 300) : '文档处理失败，请检查 worker 配置并重试';
        await mutate(store, state => {
          const current = state.documents.find(item => item.id === document.id);
          if (!current || (!deleting && current.status !== 'processing')) return;
          if (deleting) current.attempts++;
          current.status = deleting ? (current.attempts >= 3 ? 'delete_failed' : 'deleting') : (current.attempts >= 3 ? 'failed' : 'queued');
          current.error = safe; current.nextAttempt = Date.now() + 5000 * current.attempts;
        });
        console.error(`Document ${document.id}: ${cancellation.signal.aborted ? '任务已取消' : safe}`);
      } finally { clearInterval(cancelWatch); }
    } catch { console.error('Knowledge worker storage unavailable; retrying'); await new Promise(resolve => setTimeout(resolve, 5000)); }
  }
} finally { clearInterval(renew); clearInterval(heartbeat); await lease.releaseLease(); }
