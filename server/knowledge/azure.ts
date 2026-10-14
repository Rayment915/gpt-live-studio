import { DefaultAzureCredential } from '@azure/identity';
import { estimateTokens, type Evidence, type ParsedDocument, type KnowledgeSnapshot } from '../../shared/knowledge.js';

const credential = new DefaultAzureCredential();
export async function cloudRequest(base: string, path: string, key: string | undefined, body?: unknown, method = 'POST', signal?: AbortSignal, scope = 'https://cognitiveservices.azure.com/.default') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['api-key'] = key;
  else headers.Authorization = `Bearer ${(await credential.getToken(scope))!.token}`;
  const response = await fetch(new URL(path, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000) });
  if (method === 'DELETE' && response.status === 404) return {};
  if (!response.ok) throw new Error(`Azure ${response.status} ${response.statusText} (${new URL(base).hostname}${path.split('?')[0]})`);
  return response.status === 204 ? {} : response.json();
}
export function splitSections(parsed: ParsedDocument) {
  const chunks: { text: string; location: string }[] = [];
  for (const section of parsed.sections) {
    const characters = [...section.text];
    let start = 0;
    while (start < characters.length) {
      let end = start; let bytes = 0;
      while (end < characters.length && bytes < 1600) { bytes += Buffer.byteLength(characters[end]); end++; }
      if (end < characters.length) {
        const lastBreak = characters.slice(start, end).lastIndexOf('\n');
        if (lastBreak > (end - start) * 0.6) end = start + lastBreak + 1;
      }
      const text = characters.slice(start, end).join('');
      if (text.trim()) chunks.push({ text, location: section.location });
      if (end === characters.length) break;
      let overlap = end; let overlapBytes = 0;
      while (overlap > start + 1 && overlapBytes < 200) { overlap--; overlapBytes += Buffer.byteLength(characters[overlap]); }
      start = Math.max(start + 1, overlap);
    }
  }
  return chunks;
}
export class AzureKnowledge {
  prefix = process.env.KNOWLEDGE_INDEX_PREFIX ?? 'gpt-live-dev';
  names(generation: string) {
    const name = `${this.prefix}-${generation.replaceAll('-', '').slice(0, 16)}`;
    return { index: `${name}-index`, source: `${name}-source`, base: `${name}-kb` };
  }
  request(path: string, body?: unknown, method = 'POST', signal?: AbortSignal) {
    if (!process.env.KNOWLEDGE_SEARCH_ENDPOINT) throw new Error('未配置 Azure AI Search');
    return cloudRequest(process.env.KNOWLEDGE_SEARCH_ENDPOINT, `${path}${path.includes('?') ? '&' : '?'}api-version=2026-04-01`, process.env.KNOWLEDGE_SEARCH_KEY, body, method, signal, 'https://search.azure.com/.default');
  }
  async ensure(generation: string) {
    const names = this.names(generation);
    const stringField = (name: string, options: Record<string, unknown> = {}) => ({ name, type: 'Edm.String', retrievable: true, ...options });
    await this.request(`/indexes/${names.index}`, {
      name: names.index,
      fields: [stringField('id', { key: true, filterable: true }), stringField('document_id', { filterable: true }), stringField('document_version', { filterable: true }), stringField('title', { searchable: true }), stringField('location'), stringField('content', { searchable: true, analyzer: 'zh-Hans.microsoft' }), { name: 'vector', type: 'Collection(Edm.Single)', searchable: true, retrievable: false, dimensions: 1536, vectorSearchProfile: 'profile' }],
      vectorSearch: { algorithms: [{ name: 'hnsw', kind: 'hnsw' }], profiles: [{ name: 'profile', algorithm: 'hnsw', vectorizer: 'embedding' }], vectorizers: [{ name: 'embedding', kind: 'azureOpenAI', azureOpenAIParameters: { resourceUri: process.env.KNOWLEDGE_EMBEDDING_ENDPOINT, deploymentId: process.env.KNOWLEDGE_EMBEDDING_DEPLOYMENT, modelName: 'text-embedding-3-small', ...(process.env.KNOWLEDGE_EMBEDDING_KEY ? { apiKey: process.env.KNOWLEDGE_EMBEDDING_KEY } : {}) } }] },
      semantic: { defaultConfiguration: 'semantic', configurations: [{ name: 'semantic', prioritizedFields: { titleField: { fieldName: 'title' }, prioritizedContentFields: [{ fieldName: 'content' }], prioritizedKeywordsFields: [] } }] },
    }, 'PUT');
    await this.request(`/knowledgesources/${names.source}`, { name: names.source, kind: 'searchIndex', description: 'GPT-Live uploaded documents', searchIndexParameters: { searchIndexName: names.index, semanticConfigurationName: 'semantic', sourceDataFields: ['id', 'document_id', 'document_version', 'title', 'location', 'content'].map(name => ({ name })), searchFields: [{ name: 'content' }, { name: 'title' }] } }, 'PUT');
    await this.request(`/knowledgebases/${names.base}`, { name: names.base, knowledgeSources: [{ name: names.source }] }, 'PUT');
  }
  async index(generation: string, document: { id: string; name: string; version?: string }, parsed: ParsedDocument, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.ensure(generation);
    const chunks = splitSections(parsed);
    for (let offset = 0; offset < chunks.length; offset += 16) {
      signal?.throwIfAborted();
      const batch = chunks.slice(offset, offset + 16);
      const embeddings = await cloudRequest(process.env.KNOWLEDGE_EMBEDDING_ENDPOINT!, '/openai/v1/embeddings', process.env.KNOWLEDGE_EMBEDDING_KEY, { model: process.env.KNOWLEDGE_EMBEDDING_DEPLOYMENT, input: batch.map(item => item.text) }, 'POST', signal);
      signal?.throwIfAborted();
      // Complete an accepted Search write before deletion can run; never abandon an in-flight write.
      const result = await this.request(`/indexes/${this.names(generation).index}/docs/index`, { value: batch.map((item, index) => ({ '@search.action': 'mergeOrUpload', id: `${document.id}_${offset + index}`, document_id: document.id, document_version: document.version ?? document.id, title: document.name, location: item.location, content: item.text, vector: embeddings.data.find((entry: any) => entry.index === index).embedding })) });
      if (result.value.some((item: any) => !item.status)) throw new Error('索引部分片段写入失败');
    }
  }
  async retrieve(snapshot: KnowledgeSnapshot, query: string, signal: AbortSignal): Promise<Evidence[]> {
    const names = this.names(snapshot.generation);
    const filter = snapshot.documentIds.map(id => `document_id eq '${id.replaceAll("'", "''")}'`).join(' or ');
    const result = await this.request(`/knowledgebases/${names.base}/retrieve`, { intents: [{ type: 'semantic', search: query }], knowledgeSourceParams: [{ kind: 'searchIndex', knowledgeSourceName: names.source, filterAddOn: filter, includeReferences: true, includeReferenceSourceData: true }] }, 'POST', signal);
    const evidence: Evidence[] = [];
    const seen = new Set<string>(); let tokens = 0;
    for (const reference of result.references ?? []) {
      const data = reference.sourceData;
      if (!data || !snapshot.documentIds.includes(data.document_id) || typeof data.content !== 'string' || seen.has(data.id)) continue;
      if (tokens + estimateTokens(data.content) > 12_000 || evidence.length >= 6) break;
      seen.add(data.id); tokens += estimateTokens(data.content);
      evidence.push({ source_id: `S${evidence.length + 1}`, document_id: data.document_id, document_version: data.document_version ?? data.document_id, title: data.title, location: data.location, text: data.content, url: `/api/knowledge/documents/${data.document_id}/content?preview=1` });
    }
    return evidence;
  }
  async deleteDocument(generation: string, id: string) {
    const index = this.names(generation).index;
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        const result = await this.request(`/indexes/${index}/docs/search`, { search: '*', filter: `document_id eq '${id}'`, select: 'id', top: 1000 });
        if (!result.value.length) return;
        const removed = await this.request(`/indexes/${index}/docs/index`, { value: result.value.map((item: any) => ({ '@search.action': 'delete', id: item.id })) });
        if (removed.value.some((item: any) => !item.status)) throw new Error('索引清理失败');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('索引清理超时，请重试');
    } catch (error) { if (!(error instanceof Error && error.message.startsWith('Azure 404 '))) throw error; }
  }
  async deleteBase(generation: string) {
    const names = this.names(generation);
    for (const path of [`knowledgebases/${names.base}`, `knowledgesources/${names.source}`, `indexes/${names.index}`]) await this.request(`/${path}`, undefined, 'DELETE');
  }
}
