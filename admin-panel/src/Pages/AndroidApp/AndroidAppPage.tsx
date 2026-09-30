// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * AndroidAppPage — Admin › Android App.
 *
 * Ship a new version of the Android app to every installed copy:
 *
 *   1. Upload the APK the "Android release" GitHub workflow built. The server
 *      reads its version and signing key out of the FILE and refuses the three
 *      mistakes that only show up on phones — another app, a debug build, a
 *      version not newer than what players have.
 *   2. Write what changed, and decide whether it is MANDATORY.
 *   3. Publish. Installed apps check on launch and whenever they come back to
 *      the foreground; they download it themselves and open Android's
 *      installer. A mandatory release blocks every older install until it
 *      updates; any other release is offered and can be postponed.
 *
 * Nothing here can be undone by deleting — a published release stays in the
 * history, because players may have it installed. A mistake is fixed by
 * publishing a newer one.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Upload, RefreshCw, CheckCircle, AlertTriangle, Smartphone, Trash2, Send, ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import { androidReleases, type AndroidRelease, type AndroidReleasesResponse } from '../../services/api';
import { Toolbar } from '../../components/design';

const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const short = (h: string) => `${h.slice(0, 12)}…${h.slice(-6)}`;
const when = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');
const errMsg = (e: any, fallback: string) => e?.response?.data?.message || e?.message || fallback;

const ReleaseCard: React.FC<{ r: AndroidRelease; onChange: () => Promise<void> }> = ({ r, onChange }) => {
  const [notes, setNotes] = useState(r.releaseNotes);
  const [mandatory, setMandatory] = useState(r.mandatory);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setNotes(r.releaseNotes); setMandatory(r.mandatory); }, [r.releaseNotes, r.mandatory]);
  const dirty = notes !== r.releaseNotes || mandatory !== r.mandatory;
  const notesId = `notes-${r.releaseId}`;
  const mandatoryId = `mandatory-${r.releaseId}`;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); await onChange(); } catch (e) { toast.error(errMsg(e, 'That did not work')); } finally { setBusy(false); }
  };

  const save = () => run(() => androidReleases.update(r.releaseId, { releaseNotes: notes, mandatory }), 'Saved');
  const publish = () => {
    const warn = mandatory
      ? `Publish ${r.versionName} as MANDATORY?\n\nEvery older install will be blocked until it updates.`
      : `Publish ${r.versionName}?\n\nEvery older install will be offered this update.`;
    if (!confirm(warn)) return;
    return run(async () => {
      if (dirty) await androidReleases.update(r.releaseId, { releaseNotes: notes, mandatory });
      await androidReleases.publish(r.releaseId);
    }, `${r.versionName} published — installed apps will pick it up`);
  };
  const remove = () => {
    if (!confirm(`Delete the draft ${r.versionName} (${r.versionCode})?`)) return;
    return run(() => androidReleases.remove(r.releaseId), 'Draft deleted');
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div>
          <div className="text-white font-bold">
            {r.versionName} <span className="text-slate-500 font-mono text-xs">· code {r.versionCode}</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {size(r.sizeBytes)} · uploaded {when(r.uploadedAt)}{r.published ? ` · published ${when(r.publishedAt)}` : ''}
          </div>
        </div>
        <div className="flex gap-2">
          {r.published
            ? <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-green-900/40 text-green-300 border border-green-800">Published</span>
            : <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-800 text-slate-300 border border-slate-700">Draft</span>}
          {r.mandatory && <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-900/40 text-red-300 border border-red-800">Mandatory</span>}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-2 text-[11px] font-mono text-slate-500">
        <div title={r.fileSha256}>file sha256 {short(r.fileSha256)}</div>
        <div title={r.signerSha256}>signing key {short(r.signerSha256)}</div>
      </div>

      <div>
        <label htmlFor={notesId} className="block text-xs text-slate-400 mb-1">What's new (shown to players on the update screen)</label>
        <textarea id={notesId} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} rows={3}
          className="input w-full" placeholder="e.g. Faster wallet, fixes a crash on older phones" />
      </div>

      <div className="flex items-start gap-2">
        <input id={mandatoryId} type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} className="mt-1" />
        <label htmlFor={mandatoryId} className="text-sm text-slate-300">
          <span className="font-semibold">Mandatory</span>
          <span className="block text-xs text-slate-500">Installs older than this version are blocked until they update. Use for security fixes and changes the server now requires.</span>
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        {dirty && (
          <button type="button" onClick={save} disabled={busy} className="btn btn-secondary text-sm">Save changes</button>
        )}
        {!r.published && (
          <>
            <button type="button" onClick={publish} disabled={busy}
              className="btn btn-primary text-sm inline-flex items-center gap-1.5" aria-label={`Publish ${r.versionName}`}>
              <Send size={14} /> Publish
            </button>
            <button type="button" onClick={remove} disabled={busy}
              className="btn text-sm inline-flex items-center gap-1.5 bg-red-900/30 text-red-300 hover:bg-red-900/50" aria-label={`Delete draft ${r.versionName}`}>
              <Trash2 size={14} /> Delete draft
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export const AndroidAppPage: React.FC = () => {
  const [data, setData] = useState<AndroidReleasesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try { setData(await androidReleases.list()); } catch (e) { toast.error(errMsg(e, 'Failed to load Android releases')); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const upload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.apk')) { toast.error('Choose the .apk file (not the .aab — that one is for the Play Store).'); return; }
    setProgress(0);
    try {
      const res = await androidReleases.upload(file, setProgress);
      toast.success(`Uploaded ${res.release.versionName} (code ${res.release.versionCode}) as a draft`);
      await load();
    } catch (e) {
      toast.error(errMsg(e, 'Upload failed'), { duration: 9000 });
    } finally { setProgress(null); }
  };

  const latest = data?.releases.find((r) => r.published) ?? null;

  return (
    <div className="om-fade" style={{ maxWidth: 1040, margin: '0 auto' }}>
      <Toolbar actions={[{ label: 'Refresh', icon: RefreshCw, onClick: load }]} />

      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 flex items-center gap-1.5"><Smartphone size={13} /> Players are offered</div>
          <div className="text-2xl font-black text-white mt-1">{latest ? latest.versionName : 'Nothing yet'}</div>
          <div className="text-[11px] text-slate-500">{latest ? `version code ${latest.versionCode}` : 'Upload and publish an APK'}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 flex items-center gap-1.5"><ShieldAlert size={13} /> Oldest version allowed</div>
          <div className="text-2xl font-black text-white mt-1">{data?.minRequiredVersionCode ? `code ${data.minRequiredVersionCode}` : 'Any'}</div>
          <div className="text-[11px] text-slate-500">Set by the newest mandatory release</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">App identity</div>
          <div className="text-sm font-mono text-white mt-1 break-all">{data?.packageName ?? '—'}</div>
          <div className="text-[11px] text-slate-500">APKs are stored on {data?.storage ?? '—'}</div>
        </div>
      </div>

      {data && (
        <div className="mb-6 bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-sm font-semibold text-white mb-3">Before players can use the app</div>
          <ul className="space-y-2">
            {data.checks.map((c) => (
              <li key={c.key} className="flex gap-2 text-sm">
                {c.ok ? <CheckCircle size={16} className="text-green-400 shrink-0 mt-0.5" /> : <AlertTriangle size={16} className="text-yellow-400 shrink-0 mt-0.5" />}
                <div><div className={c.ok ? 'text-slate-300' : 'text-yellow-200'}>{c.label}</div><div className="text-xs text-slate-500">{c.why}</div></div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        role="button" tabIndex={0}
        aria-label="Upload a new APK"
        onClick={() => progress === null && input.current?.click()}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && progress === null) input.current?.click(); }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) upload(f); }}
        className="mb-6 border-2 border-dashed border-slate-700 hover:border-yellow-500/60 rounded-xl p-6 text-center cursor-pointer transition-colors"
      >
        {progress === null ? (
          <>
            <Upload size={26} className="mx-auto text-slate-500 mb-2" />
            <div className="text-white font-semibold">Upload a new APK</div>
            <div className="text-xs text-slate-500 mt-1 max-w-xl mx-auto">
              Use <span className="font-mono">app-release.apk</span> from the <b>Android release</b> workflow in GitHub Actions.
              Its version comes from <span className="font-mono">user-panel/package.json</span> — bump that for every release.
              It is saved as a draft; nothing reaches players until you publish.
            </div>
          </>
        ) : (
          <div aria-live="polite">
            <div className="text-white font-semibold mb-2">Uploading and checking… {progress}%</div>
            <div className="h-2 bg-slate-800 rounded-full overflow-hidden max-w-md mx-auto">
              <div className="h-full bg-yellow-500 transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
        <input ref={input} type="file" accept=".apk,application/vnd.android.package-archive" className="hidden"
          aria-label="APK file"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
      </div>

      {loading && !data ? (
        <div className="text-center py-16 text-slate-600"><RefreshCw size={28} className="mx-auto mb-3 animate-spin opacity-40" />Loading…</div>
      ) : data && data.releases.length === 0 ? (
        <div className="text-center py-10 text-slate-500 text-sm">No releases uploaded yet.</div>
      ) : (
        <div className="space-y-4">
          {data?.releases.map((r) => <ReleaseCard key={r.releaseId} r={r} onChange={load} />)}
        </div>
      )}
    </div>
  );
};
