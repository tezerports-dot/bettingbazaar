// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * DemoResultsEditor.tsx — Admin › Boards › Demo results (owner, 2026-10-20:
 * "give me an option where I can fill B,D,B,D like ghost mode, so I can fill
 * the 1440 results by comma", for every board in VIP and General).
 *
 * One box per board and profile: B (Bombay) and D (Delhi), comma separated,
 * OLDEST first, up to the server's `max` (1,440). They fill the analytics
 * before the board's oldest real result, drawn faded like the drawn demo
 * results they replace; an empty box goes back to the drawn ones. The whole
 * set also travels as one file: download it (it is the template, with what is
 * saved now), edit it, upload it. The server checks every line before saving
 * any (database/repositories/boards.js `importDemoResults`) and says which
 * entry is wrong; this screen keeps no rule of its own.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Save, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { boards as boardsApi, type DemoResultsPage } from '../../services/api';

type Drafts = Record<string, string>; // `${key}:${audience}` -> text

/** A live count of what is typed, for the line under each box (the server decides what is valid). */
const tally = (text: string) => {
  const t = text.split(/[\s,;]+/).filter(Boolean);
  const isB = (x: string) => /^(b|bombay)$/i.test(x);
  const isD = (x: string) => /^(d|delhi)$/i.test(x);
  return { total: t.length, b: t.filter(isB).length, d: t.filter(isD).length, other: t.filter((x) => !isB(x) && !isD(x)).length };
};

export const DemoResultsEditor: React.FC = () => {
  const [page, setPage] = useState<DemoResultsPage | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await boardsApi.demoResults();
      setPage(res);
      setDrafts(Object.fromEntries(res.boards.flatMap((b) => res.audiences.map((a) => [`${b.key}:${a}`, b[a].results]))));
      setError('');
    } catch (e: any) {
      setError(e?.response?.data?.message || 'The demo results could not be loaded.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (key: string, audience: string) => {
    const id = `${key}:${audience}`;
    setBusy(id);
    try {
      const res = await boardsApi.saveDemoResults(key, audience, drafts[id] ?? '');
      toast.success(res.count ? `Saved ${res.count.toLocaleString('en-IN')} results` : 'Cleared: the drawn demo results are back');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Could not save these results');
    } finally { setBusy(''); }
  };

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy('import');
    try {
      const res = await boardsApi.importDemoResults(await f.text());
      toast.success(`Saved ${res.saved.length} board line(s) from ${f.name}`);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Could not read that file');
    } finally {
      setBusy('');
      if (file.current) file.current.value = '';
    }
  };

  if (error) return <div className="card p-4 text-sm text-red-400" role="alert">{error}</div>;
  if (!page) return <div className="card p-4 text-sm text-slate-400" role="status">Loading demo results…</div>;

  return (
    <section className="card p-4 space-y-4" aria-labelledby="demo-results-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="demo-results-title" className="text-base font-semibold text-white">Demo results</h2>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            Type B (Bombay) or D (Delhi), separated by commas, <strong>oldest first</strong>: the last one you type sits
            just before the board&apos;s oldest real result. Up to {page.max.toLocaleString('en-IN')} per box. They fill the
            analytics until real results replace them, shown faded like the drawn ones. Leave a box empty to use the drawn ones.
            Switch them all off under Settings (Demo results).
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void boardsApi.downloadDemoResults()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs">
            <Download size={13} /> Download file (template)
          </button>
          <label className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs cursor-pointer">
            <Upload size={13} /> {busy === 'import' ? 'Uploading…' : 'Upload file'}
            <input ref={file} type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only"
              disabled={busy === 'import'} onChange={(e) => void upload(e.target.files?.[0])} />
          </label>
        </div>
      </div>
      <p className="text-[11px] text-slate-500">
        The file has one line per board and profile: <code>board key, VIP or GENERAL, then the results</code>. Every line is
        checked before anything is saved.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {page.boards.flatMap((b) => page.audiences.map((a) => {
          const id = `${b.key}:${a}`;
          const text = drafts[id] ?? '';
          const t = tally(text);
          const changed = text !== b[a].results;
          const over = t.total > page.max;
          return (
            <div key={id} className="rounded-lg border border-slate-800 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={`demo-${id}`} className="text-sm font-semibold text-slate-200">
                  {b.name} <span className="text-slate-500 font-normal">· {a === 'VIP' ? 'VIP' : 'General'}</span>
                  {!b.enabled && <span className="ml-2 text-[10px] text-slate-500">(board off)</span>}
                </label>
                <span className="text-[10px] text-slate-500">saved: {b[a].count.toLocaleString('en-IN')}</span>
              </div>
              <textarea id={`demo-${id}`} value={text} rows={4} spellCheck={false}
                onChange={(e) => setDrafts({ ...drafts, [id]: e.target.value })}
                placeholder="B,D,B,B,D,…" className="input font-mono text-xs w-full" />
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span className={over || t.other ? 'text-red-400' : 'text-slate-400'}>
                  {t.total.toLocaleString('en-IN')} / {page.max.toLocaleString('en-IN')} · B {t.b} · D {t.d}
                  {t.other ? ` · ${t.other} not B or D` : ''}
                </span>
                <button type="button" disabled={!changed || busy === id} onClick={() => void save(b.key, a)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-yellow-500 text-black font-bold disabled:opacity-40">
                  <Save size={12} /> {busy === id ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          );
        }))}
      </div>
    </section>
  );
};

export default DemoResultsEditor;
