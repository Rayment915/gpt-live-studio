import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { KnowledgeManifest } from '../../shared/knowledge.js';

export interface KnowledgeStore {
  read(): Promise<{ manifest: KnowledgeManifest; etag: string }>;
  compareWrite(manifest: KnowledgeManifest, etag: string): Promise<boolean>;
  get(path: string, signal?: AbortSignal): Promise<Buffer>;
  put(path: string, data: Buffer | string, contentType?: string): Promise<void>;
  upload(path: string, stream: Readable): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
}
export const newManifest = (): KnowledgeManifest => ({ generation: randomUUID(), revision: 1, deleting: false, deleteError: undefined, deleteAttempts: 0, nextDeleteAttempt: 0, documents: [] });
export async function mutate<T>(store: KnowledgeStore, action: (manifest: KnowledgeManifest) => T): Promise<T> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const { manifest, etag } = await store.read();
    const result = action(manifest);
    if (await store.compareWrite(manifest, etag)) return result;
  }
  throw new Error('知识库正忙，请稍后重试');
}
export class BlobKnowledgeStore implements KnowledgeStore {
  container: ContainerClient;
  private ready?: Promise<void>;
  constructor() {
    const connection = process.env.KNOWLEDGE_STORAGE_CONNECTION_STRING;
    const service = connection ? BlobServiceClient.fromConnectionString(connection) : new BlobServiceClient(process.env.KNOWLEDGE_STORAGE_URL!, new DefaultAzureCredential());
    this.container = service.getContainerClient(process.env.KNOWLEDGE_CONTAINER ?? 'gpt-live-dev');
  }
  async init() {
    this.ready ??= (async () => {
      await this.container.createIfNotExists();
      const initial = JSON.stringify(newManifest());
      try { await this.container.getBlockBlobClient('manifest.json').upload(initial, Buffer.byteLength(initial), { conditions: { ifNoneMatch: '*' } }); }
      catch (error: any) { if (![409, 412].includes(error.statusCode)) throw error; }
    })().catch(error => { this.ready = undefined; throw error; });
    await this.ready;
  }
  async read() {
    await this.init();
    const response = await this.container.getBlobClient('manifest.json').download();
    const chunks: Buffer[] = [];
    for await (const chunk of response.readableStreamBody!) chunks.push(Buffer.from(chunk));
    return { manifest: JSON.parse(Buffer.concat(chunks).toString()) as KnowledgeManifest, etag: response.etag! };
  }
  async compareWrite(manifest: KnowledgeManifest, etag: string) {
    const body = JSON.stringify(manifest);
    try { await this.container.getBlockBlobClient('manifest.json').upload(body, Buffer.byteLength(body), { conditions: { ifMatch: etag } }); return true; }
    catch (error: any) { if (error.statusCode === 412) return false; throw error; }
  }
  async get(path: string, signal?: AbortSignal) { return this.container.getBlobClient(path).downloadToBuffer(0, undefined, { abortSignal: signal }); }
  async put(path: string, data: Buffer | string, contentType = 'application/octet-stream') {
    await this.init();
    await this.container.getBlockBlobClient(path).uploadData(Buffer.from(data), { blobHTTPHeaders: { blobContentType: contentType } });
  }
  async upload(path: string, stream: Readable) {
    await this.init();
    await this.container.getBlockBlobClient(path).uploadStream(stream, 1024 * 1024, 2);
  }
  async removePrefix(prefix: string) {
    for await (const blob of this.container.listBlobsFlat({ prefix })) await this.container.deleteBlob(blob.name, { deleteSnapshots: 'include' });
  }
}
export function documentPrefix(generation: string, id: string) { return `documents/${generation}/${id}/`; }
