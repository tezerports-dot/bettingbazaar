// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * KycBulk.tsx — where Aadhaar numbers leave the platform, and verdicts come back.
 *
 * ── This screen is a boundary, not a feature ────────────────────────────────
 * Everything else in this panel moves data around inside the platform. Pressing
 * Export here writes thousands of national identity numbers to a file on an
 * operator's laptop. That is a deliberate, audited act with a record naming the
 * admin who did it, and the screen says so plainly rather than making it feel
 * like any other download button.
 *
 * ── Why the file is built in the browser from a fetch ───────────────────────
 * The request needs the Authorization header, which a plain <a href> cannot
 * carry, so the CSV is fetched as text and handed over as a Blob. It is never
 * written to disk server-side — there is no file to forget about and no bucket
 * to misconfigure.
 *
 * ── Import is deliberately blunt ────────────────────────────────────────────
 * YES verifies, NO fails, and anything the parser does not recognise is left
 * PENDING and reported. Guessing either way is worse than stopping: a wrong YES
 * activates payouts on an unchecked identity, and a wrong NO voids an innocent
 * player's upline commissions. Rows already decided are skipped, so re-importing
 * the same file is a no-op rather than a way to overturn a settled verdict.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Upload, ShieldAlert } from 'lucide-react';
import { Kpis } from '../../components/design';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import toast from 'react-hot-toast';

type Stats = Awaited<ReturnType<typeof api.kycBulk.stats>>;
type Batch = NonNullable<Stats['recentBatches']>[number];
type ImportResult = Awaited<ReturnType<typeof api.kycBulk.importCsv>>;

export const KycBulk: React.FC = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setStats(await api.kycBulk.stats());
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Could not load verification counts.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const pending = stats?.pending || 0;

  const doExport = async () => {
    setIsExporting(true);
    try {
      const csv = await api.kycBulk.exportCsv(10000);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kyc-export-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked immediately: the object URL points at a blob holding Aadhaar
      // numbers, and leaving it alive keeps them reachable from the page.
      URL.revokeObjectURL(url);
      toast.success('Export downloaded. It is recorded against your account.');
      await load();
    } catch (e: any) {
      const msg = e?.response?.status === 404
        ? 'Nothing to export — no verifications are pending.'
        : (e?.response?.data?.message || 'Export failed.');
      toast.error(msg);
    } finally {
      setIsExporting(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared straight away so choosing the SAME file twice still fires change.
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast.error('That file is larger than 20MB.'); return; }

    setIsImporting(true); setResult(null);
    try {
      const csv = await file.text();
      const res = await api.kycBulk.importCsv(csv);
      setResult(res);
      if (res.success) {
        toast.success(`${res.verified ?? 0} verified, ${res.failed ?? 0} failed, ${res.skipped ?? 0} skipped.`);
        await load();
      } else {
        toast.error(res.message || 'Import failed.');
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Import failed.');
    } finally {
      setIsImporting(false);
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><div className="w-8 h-8 border-4 border-dark-600 border-t-gold-500 rounded-full animate-spin" /></div>;
  }

  return (
    <div className="om-fade" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Kpis items={[
        { label: 'Awaiting verification', value: formatters.number(pending), tone: pending ? 'var(--warning)' : undefined },
        { label: 'Verified', value: formatters.number(stats?.verified || 0), tone: 'var(--success)' },
        { label: 'Failed', value: formatters.number(stats?.failed || 0), tone: (stats?.failed || 0) ? 'var(--danger)' : undefined },
      ]} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 16 }}>
        {/* ── Export ──────────────────────────────────────────────────── */}
        <div className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <Download size={17} style={{ color: 'var(--gold-ink)' }} />
            <div style={{ fontSize: 15, fontWeight: 800 }}>Export for verification</div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.65, marginBottom: 14 }}>
            Downloads every account still awaiting a verdict, up to 10,000 rows, as a CSV with
            one Aadhaar number per row. Send it to your verification provider, put their YES/NO
            in the verdict column, and bring it back here.
          </p>

          <div style={{ display: 'flex', gap: 11, padding: '12px 14px', borderRadius: 10, background: 'var(--warning-bg)', border: '1px solid var(--warning)', marginBottom: 16 }}>
            <ShieldAlert size={17} style={{ color: 'var(--warning)', flex: 'none', marginTop: 1 }} />
            <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
              This file contains national identity numbers in the clear. The download is logged
              against your account. Treat the file as you would the register itself, and delete
              it once the verdicts are imported.
            </div>
          </div>

          <div style={{ flex: 1 }} />
          <button
            onClick={doExport} disabled={isExporting || !pending}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 42, borderRadius: 9,
              background: 'var(--gold)', color: 'var(--gold-on)', fontSize: 13, fontWeight: 700, border: 'none',
              cursor: isExporting || !pending ? 'not-allowed' : 'pointer', opacity: isExporting || !pending ? .5 : 1,
            }}
          >
            <Download size={15} />
            {isExporting ? 'Preparing…' : pending ? `Export ${formatters.number(pending)} pending` : 'Nothing pending'}
          </button>
        </div>

        {/* ── Import ──────────────────────────────────────────────────── */}
        <div className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <Upload size={17} style={{ color: 'var(--gold-ink)' }} />
            <div style={{ fontSize: 15, fontWeight: 800 }}>Import verdicts</div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.65, marginBottom: 14 }}>
            Upload the completed file. <strong>YES</strong> verifies an account and opens
            withdrawals; <strong>NO</strong> fails it and the player is told the reason from the
            remarks column. Anything else is left pending and listed back to you — nothing is
            guessed.
          </p>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 16 }}>
            Rows already decided are skipped, so re-uploading the same file changes nothing.
          </p>

          <div style={{ flex: 1 }} />
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: 'none' }} />
          <button
            onClick={() => fileRef.current?.click()} disabled={isImporting}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 42, borderRadius: 9,
              background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)',
              fontSize: 13, fontWeight: 700, cursor: isImporting ? 'wait' : 'pointer', opacity: isImporting ? .6 : 1,
            }}
          >
            <Upload size={15} />{isImporting ? 'Applying…' : 'Choose CSV'}
          </button>
        </div>
      </div>

      {/* ── Last import report ─────────────────────────────────────────── */}
      {result && (
        <div className="card" style={{ padding: 22 }}>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>
            Import {result.batchId}
          </div>
          <div className="font-mono" style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 14 }}>
            {result.verified ?? 0} verified · {result.failed ?? 0} failed · {result.skipped ?? 0} skipped
          </div>
          {result.errors?.length ? (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--warning)', marginBottom: 8 }}>
                {result.errors.length} row{result.errors.length === 1 ? '' : 's'} needed attention
              </div>
              <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 12px' }}>
                {result.errors.map((err, i) => (
                  <div key={i} className="font-mono" style={{ fontSize: 11.5, color: 'var(--text-2)', padding: '3px 0' }}>{err}</div>
                ))}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--success)' }}>Every row applied cleanly.</div>
          )}
        </div>
      )}

      {/* ── Batch history ──────────────────────────────────────────────── */}
      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>Batch history</div>
        <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 14 }}>
          Twenty most recent. Each export and import is a row here naming the admin who ran it.
        </p>

        {!stats?.recentBatches?.length ? (
          <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
            No batches yet.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr>
                  {['Batch', 'Kind', 'Rows', 'Outcome', 'When', 'By'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', padding: '0 12px 9px 0', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.recentBatches.map((b: Batch) => (
                  <tr key={b.batchId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="font-mono" style={{ padding: '11px 12px 11px 0', fontSize: 11.5 }}>{b.batchId}</td>
                    <td style={{ padding: '11px 12px 11px 0', fontSize: 12 }}>
                      <span style={{ fontSize: 10.5, fontWeight: 800, padding: '3px 9px', borderRadius: 20, color: b.kind === 'EXPORT' ? 'var(--warning)' : 'var(--info)', background: b.kind === 'EXPORT' ? 'var(--warning-bg)' : 'var(--info-bg)' }}>
                        {b.kind}
                      </span>
                    </td>
                    <td className="font-mono" style={{ padding: '11px 12px 11px 0', fontSize: 12 }}>{formatters.number(b.rowCount)}</td>
                    <td className="font-mono" style={{ padding: '11px 12px 11px 0', fontSize: 11.5, color: 'var(--text-2)' }}>
                      {b.kind === 'IMPORT'
                        ? `${b.verified ?? 0} ✓ · ${b.failed ?? 0} ✗ · ${b.skipped ?? 0} —`
                        : '—'}
                    </td>
                    <td style={{ padding: '11px 12px 11px 0', fontSize: 12, whiteSpace: 'nowrap' }}>{b.at ? formatters.datetime(b.at) : '—'}</td>
                    <td style={{ padding: '11px 0', fontSize: 12 }}>{b.actor || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default KycBulk;
