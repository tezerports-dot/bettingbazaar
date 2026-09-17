// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Support Assistant — the knowledge base the player-facing assistant answers from.
 *
 * ── Why this page exists ────────────────────────────────────────────────────
 * Five endpoints were built and unreachable: status, ingest-knowledge-base,
 * ingest-document, list-documents, delete-document. Without a screen the only
 * way to put anything in the store was to call the API by hand, so the
 * assistant had nothing to answer from and looked broken rather than empty.
 *
 * ── The readiness panel is the important half ───────────────────────────────
 * The feature is dormant until two independent things are configured:
 * RETRIEVAL (PostgreSQL + an embedding provider) and GENERATION (an LLM key).
 * Either can be missing on its own, and the failure reads completely
 * differently — retrieval down means nothing is found, generation down means
 * passages are found and nothing is written. They are reported separately for
 * that reason, rather than collapsed into one "enabled" light.
 *
 * The assistant answers ONLY from ingested passages and is instructed to refuse
 * rather than guess, so what is in this store is exactly what a player can be
 * told about their money. Ingesting something wrong here is a support answer
 * that is wrong for everyone.
 */
import React, { useEffect, useState } from 'react';
import { RefreshCw, BookOpenCheck, Upload, Trash2, CheckCircle2, XCircle } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

interface RagStatus {
  enabled: boolean;
  retrievalReady: boolean;
  generationReady: boolean;
  generationProvider: string;
  generationModel: string;
  // Field names match embeddingInfo() exactly — `dim`, not `dimensions`. A card
  // reading a name the server never sends renders blank, not an error.
  embedding?: { provider?: string; model?: string; dim?: number; configured?: boolean };
  store?: { configured: boolean; documents: number; chunks: number };
}

interface Doc { doc_id: string; title: string | null; category: string | null; chunks: number; updated_at: string; }

const Light: React.FC<{ ok: boolean; label: string; detail?: string }> = ({ ok, label, detail }) => (
  <div className="flex items-start gap-2.5">
    {ok ? <CheckCircle2 size={16} className="text-green-400 mt-0.5 shrink-0" />
        : <XCircle size={16} className="text-gray-600 mt-0.5 shrink-0" />}
    <div className="min-w-0">
      <p className={`text-sm font-medium ${ok ? 'text-gray-200' : 'text-gray-400'}`}>{label}</p>
      {detail && <p className="text-xs text-gray-500 truncate">{detail}</p>}
    </div>
  </div>
);

export const SupportAssistant: React.FC = () => {
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ docId: '', title: '', category: 'general', text: '' });

  const load = async () => {
    setLoading(true);
    const [st, dl] = await Promise.allSettled([
      api.get<any>('/api/admin/support/status'),
      api.get<any>('/api/admin/support/documents'),
    ]);
    if (st.status === 'fulfilled' && st.value.data?.success) setStatus(st.value.data);
    if (dl.status === 'fulfilled' && dl.value.data?.success) setDocs(dl.value.data.documents || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const ingestKb = async () => {
    if (!window.confirm('Re-ingest the built-in knowledge base? Existing passages for those documents are replaced.')) return;
    setBusy('kb');
    try {
      const r = await api.post<any>('/api/admin/support/ingest/knowledge-base', {});
      toast.success(`Knowledge base ingested — ${r.data?.documents ?? 0} document(s)`);
      load();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Ingest failed'); }
    finally { setBusy(null); }
  };

  const ingestDoc = async () => {
    if (!form.docId.trim() || !form.text.trim()) {
      toast.error('A document id and some text are required');
      return;
    }
    setBusy('doc');
    try {
      await api.post('/api/admin/support/ingest', {
        docId: form.docId.trim(), title: form.title.trim(),
        category: form.category.trim() || 'general', text: form.text,
      });
      toast.success('Document ingested');
      setForm({ docId: '', title: '', category: 'general', text: '' });
      load();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Ingest failed'); }
    finally { setBusy(null); }
  };

  const removeDoc = async (d: Doc) => {
    // Removing a document removes what the assistant can say on that subject.
    if (!window.confirm(`Remove "${d.doc_id}" and its ${d.chunks} passage(s)?\n\nThe assistant will no longer be able to answer from it.`)) return;
    setBusy(d.doc_id);
    try {
      const r = await api.delete<any>(`/api/admin/support/documents/${encodeURIComponent(d.doc_id)}`);
      toast.success(`Removed ${r.data?.removedChunks ?? 0} passage(s)`);
      load();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Remove failed'); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Support Assistant</h1>
          <p className="text-gray-400 text-sm mt-1">
            The knowledge base players are answered from. The assistant may only use what is here.
          </p>
        </div>
        <button onClick={load} disabled={loading} className="p-2 hover:bg-dark-700 rounded-lg disabled:opacity-50">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="card space-y-4">
        <p className="text-[11px] uppercase tracking-wider text-gray-500">Readiness</p>
        {!status ? (
          <p className="text-sm text-gray-500">Status unavailable.</p>
        ) : (
          <>
            <div className="grid md:grid-cols-2 gap-4">
              <Light ok={status.retrievalReady} label="Retrieval"
                detail={status.retrievalReady
                  ? `${status.embedding?.provider ?? 'embeddings'} · ${status.embedding?.model ?? ''} · ${status.embedding?.dim ?? '?'}d`
                  : 'No embedding provider — nothing can be found'} />
              <Light ok={status.generationReady} label="Generation"
                detail={status.generationReady
                  ? `${status.generationProvider} · ${status.generationModel}`
                  : 'No API key — passages are found but nothing is written'} />
            </div>
            <p className={`text-sm font-medium ${status.enabled ? 'text-green-400' : 'text-gray-400'}`}>
              {status.enabled
                ? 'The assistant is answering players.'
                : 'Dormant — players are not offered an assistant answer while either half is unconfigured.'}
            </p>
            <p className="text-xs text-gray-500">
              {status.store?.documents ?? 0} document(s) · {status.store?.chunks ?? 0} passage(s) in the store
            </p>
          </>
        )}
      </div>

      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-gray-300">Built-in knowledge base</p>
            <p className="text-xs text-gray-500 mt-0.5">
              The platform's own policy documents. Re-ingest after changing them.
            </p>
          </div>
          <button onClick={ingestKb} disabled={busy !== null}
            className="btn-secondary text-sm flex items-center gap-1.5 disabled:opacity-50">
            <BookOpenCheck size={14} />{busy === 'kb' ? 'Ingesting…' : 'Re-ingest'}
          </button>
        </div>
      </div>

      <div className="card space-y-3">
        <p className="text-sm font-semibold text-gray-300">Add a document</p>
        <p className="text-xs text-gray-500">
          Anything here becomes an answer a player can be given about their money. Re-using an id
          replaces that document's passages rather than adding a second copy.
        </p>
        <div className="grid md:grid-cols-3 gap-3">
          <input value={form.docId} onChange={e => setForm(f => ({ ...f, docId: e.target.value }))}
            className="input text-sm" placeholder="Document id (e.g. withdrawal-limits)" />
          <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            className="input text-sm" placeholder="Title (optional)" />
          <input value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
            className="input text-sm" placeholder="Category" />
        </div>
        <textarea value={form.text} onChange={e => setForm(f => ({ ...f, text: e.target.value }))}
          className="input resize-none w-full" rows={6} placeholder="The text players should be answered from…" />
        <button onClick={ingestDoc} disabled={busy !== null || !form.docId.trim() || !form.text.trim()}
          className="btn-primary text-sm flex items-center gap-1.5 disabled:opacity-50">
          <Upload size={14} />{busy === 'doc' ? 'Ingesting…' : 'Ingest document'}
        </button>
      </div>

      <div className="card">
        <p className="text-sm font-semibold text-gray-300 mb-3">Ingested documents ({docs.length})</p>
        {docs.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center">
            Nothing ingested. The assistant has nothing to answer from.
          </p>
        ) : (
          <div className="space-y-1.5">
            {docs.map(d => (
              <div key={d.doc_id} className="flex items-center justify-between gap-4 bg-dark-800 rounded-lg px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="text-gray-200 truncate">{d.title || d.doc_id}</p>
                  <p className="text-xs text-gray-500 font-mono truncate">
                    {d.doc_id}{d.category ? ` · ${d.category}` : ''} · {d.chunks} passage(s)
                  </p>
                </div>
                <button onClick={() => removeDoc(d)} disabled={busy !== null}
                  className="shrink-0 text-red-400 hover:text-red-300 disabled:opacity-50" title="Remove">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
