export type KnowledgeMode = 'iq';
export type DocumentStatus = 'uploading' | 'queued' | 'processing' | 'ready' | 'failed' | 'deleting' | 'delete_failed';
export type KnowledgeDocument = {
  id: string; name: string; extension: string; bytes: number; status: DocumentStatus;
  createdAt: string; updatedAt: string; attempts: number; nextAttempt: number;
  version?: string; // Immutable upload UUID; older manifests use id as the version.
  tokens?: number; parsed?: boolean; indexed?: boolean; error?: string;
};
export type KnowledgeManifest = {
  generation: string; revision: number; deleting: boolean; deleteError?: string; deleteAttempts?: number; nextDeleteAttempt?: number;
  documents: KnowledgeDocument[]; workerHeartbeat?: number;
};
export type KnowledgeView = KnowledgeManifest & { configured: boolean; maxDocuments: number; maxBytes: number; activeSessions: number };
export type KnowledgeSnapshot = { generation: string; documentIds: string[]; mode: KnowledgeMode; revision: number };
export type Evidence = { source_id: string; document_id: string; document_version: string; title: string; location: string; text: string; url: string };
export type ParsedDocument = { sections: { location: string; text: string }[]; tokens: number; preview: boolean };
export const KNOWLEDGE_EXTENSIONS = ['.doc', '.docx', '.pdf', '.ppt', '.pptx', '.md', '.markdown', '.txt'];
export const MAX_DOCUMENTS = 3;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export function estimateTokens(text: string): number {
  return Math.ceil(BufferlessByteLength(text) / 2);
}
function BufferlessByteLength(text: string): number { return new TextEncoder().encode(text).length; }
export function readable(document: KnowledgeDocument): boolean {
  return !!document.parsed && !['uploading', 'deleting', 'delete_failed'].includes(document.status);
}
