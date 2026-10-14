import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Upload, Trash2, RefreshCw, FileText, LoaderCircle } from 'lucide-react';
import { KNOWLEDGE_EXTENSIONS, type KnowledgeView, type DocumentStatus } from '../../shared/knowledge';

const labels: Record<DocumentStatus, string> = { uploading: '上传中', queued: '等待处理', processing: '解析 / 建索引', ready: 'IQ 已就绪', failed: '处理失败', deleting: '删除中', delete_failed: '清理失败' };
export function KnowledgePanel({ csrf, locked, onRevision }: { csrf: string; locked: boolean; onRevision: (revision: number) => void }) {
  const [view, setView] = useState<KnowledgeView>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ id?: string; name: string }>();
  const [progress, setProgress] = useState<number>();
  const refresh = useCallback(async () => {
    const response = await fetch('/api/knowledge');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setView(data); onRevision(data.revision);
  }, [onRevision]);
  useEffect(() => {
    let stopped = false;
    const update = () => { void refresh().catch(reason => { if (!stopped) setError(reason.message); }); };
    update(); const timer = setInterval(update, 2500);
    return () => { stopped = true; clearInterval(timer); };
  }, [refresh]);
  async function action(path: string, method: string, body?: unknown) {
    setBusy(true); setError('');
    try {
      const response = await fetch(path, { method, headers: { 'X-Studio-Csrf': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setConfirm(undefined); await refresh();
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  async function upload(file: File) {
    setBusy(true); setError(''); setProgress(0);
    try {
      if (file.size > 20 * 1024 * 1024 || !file.size) throw new Error('文件不能为空且每份最多 20 MB');
      await new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest(); request.open('POST', '/api/knowledge/documents'); request.timeout = 125_000;
        request.setRequestHeader('X-Studio-Csrf', csrf);
        request.upload.onprogress = event => { if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)); };
        request.onload = () => { try { const result = JSON.parse(request.responseText); request.status < 300 ? resolve() : reject(new Error(result.error)); } catch { reject(new Error('上传失败')); } };
        request.onerror = () => reject(new Error('上传网络错误')); request.ontimeout = () => reject(new Error('上传超时'));
        const form = new FormData(); form.append('file', file); request.send(form);
      });
      await refresh();
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); setProgress(undefined); }
  }
  return <section className="knowledge-panel panel" aria-label="知识库管理">
    <div className="knowledge-heading"><div><h2><BookOpen size={20} />工作台知识库 <span>{view?.documents.length ?? 0} / 3</span></h2><p>共享资料 · 持久保存 · PDF / Word / PowerPoint / Markdown / TXT</p></div>
      <div className="knowledge-actions"><label className={`secondary upload-button ${busy || !view || view.deleting || view.documents.length >= 3 ? 'disabled' : ''}`}><Upload size={15} />上传文档<input aria-label="上传知识库文档" type="file" accept={KNOWLEDGE_EXTENSIONS.join(',')} disabled={busy || !view || view.deleting || view.documents.length >= 3} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} /></label><button className="text-button" disabled={!view || busy} onClick={() => setConfirm({ name: '整个知识库' })}><Trash2 size={15} />删除知识库</button></div>
    </div>
    <div className="knowledge-options"><span aria-label="知识库回答方式">回答方式：Foundry IQ 检索</span><span>每份 ≤ 20 MB · 扫描 PDF 支持 OCR{locked ? ' · 新增资料需重新开始会话' : ''}</span></div>
    {progress !== undefined && <div className="knowledge-progress"><progress max={100} value={progress} /><span>上传 {progress}%</span></div>}
    <div className="knowledge-documents">{!view?.documents.length ? <p className="knowledge-empty"><FileText size={25} />上传第一份资料，让语音回答有据可查。</p> : view.documents.map(document => <article key={document.id} className="knowledge-document"><FileText size={21} /><div className="knowledge-document-body"><strong title={document.name}>{document.name}</strong><small>{(document.bytes / 1024).toFixed(0)} KB · {labels[document.status]}{document.parsed && !document.indexed ? ' · 正文已解析，等待 IQ 索引' : ''}{document.tokens !== undefined ? ` · 约 ${document.tokens.toLocaleString()} tokens` : ''}</small>{document.error && <p className="field-error">{document.error}</p>}</div><div className="knowledge-document-actions">{document.parsed && !['deleting', 'delete_failed'].includes(document.status) && !view.deleting && <a href={`/api/knowledge/documents/${document.id}/content`} target="_blank" rel="noreferrer">原文</a>}{['failed', 'delete_failed'].includes(document.status) && <button aria-label={`重试 ${document.name}`} disabled={busy} onClick={() => void action(`/api/knowledge/documents/${document.id}/retry`, 'POST')}><RefreshCw size={15} /></button>}<button aria-label={`删除 ${document.name}`} disabled={busy || document.status === 'deleting'} onClick={() => setConfirm({ id: document.id, name: document.name })}><Trash2 size={15} /></button></div></article>)}</div>
    {view?.deleting && <p className="field-help"><LoaderCircle size={14} />正在清理知识库，清理完成后可以重新上传。</p>}
    {view?.deleteError && <p className="field-error">{view.deleteError}</p>}
    {view && view.documents.some(document => ['queued', 'processing', 'deleting'].includes(document.status)) && (!view.workerHeartbeat || Date.now() - view.workerHeartbeat > 90_000) && <p className="field-error">文档 worker 尚未运行或正在处理长任务，请检查本地 worker 终端。</p>}
    {error && <p role="alert" className="field-error">{error}</p>}
    {confirm && <div className="knowledge-confirm" role="alertdialog" aria-label="确认删除知识库资料"><strong>删除{confirm.name}？</strong><p>此操作将移除资料并结束受影响的知识库会话。当前共有 {view?.activeSessions ?? 0} 个知识库会话；整库含 {view?.documents.length ?? 0} 份文档。</p><button className="secondary" disabled={busy} onClick={() => void action(confirm.id ? `/api/knowledge/documents/${confirm.id}` : '/api/knowledge', 'DELETE', { confirmed: true })}>确认删除并结束相关会话</button><button className="text-button" disabled={busy} onClick={() => setConfirm(undefined)}>取消</button></div>}
  </section>;
}
