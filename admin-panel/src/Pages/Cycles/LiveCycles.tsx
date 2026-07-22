// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Live Cycles — Command Center design (handoff "Betting Bazaar Admin.dc.html").
// Cycle-card grid with the real/phantom book. Data loading (admin phases
// endpoint + SSE) and admin actions (equalizer / pause / resume / cancel) are
// unchanged; only the presentation is rebuilt. There is intentionally no manual
// "Declare Result" — winners are algorithmic (Markets Platform), not admin-set.
import React, { useEffect, useState } from 'react';
import { Activity, RefreshCw, Play, Pause, XCircle, Scale } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import api from '../../services/api';
import sseService from '../../services/sse';
import type { Cycle } from '../../types';
import toast from 'react-hot-toast';

const inr = (n: number | undefined | null): string => {
  const x = Number(n) || 0;
  if (x >= 1e7) return `₹${(x / 1e7).toFixed(2)}Cr`;
  if (x >= 1e5) return `₹${(x / 1e5).toFixed(2)}L`;
  if (x >= 1e3) return `₹${(x / 1e3).toFixed(1)}k`;
  return `₹${x.toLocaleString('en-IN')}`;
};

const cycleStatusTone: Record<string, string> = {
  OPEN: 'success', MERGED: 'info', CLOSED: 'warning', RESULT_DECLARED: 'gold',
  COMPLETED: 'success', PAUSED: 'neutral', CANCELLED: 'danger',
};

export const LiveCycles: React.FC = () => {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [confirmAction, setConfirmAction] = useState<{ type: string; cycle: Cycle } | null>(null);

  useEffect(() => {
    loadCycles();
    const handleCycleUpdate = (update: any) => {
      setCycles((prev) => prev.map((c) =>
        c.cycleId === update.cycleId
          ? {
              ...c,
              status: update.status || c.status,
              totalDelhi: update.totalDelhi ?? c.totalDelhi,
              totalBombay: update.totalBombay ?? c.totalBombay,
              realDelhi: update.realDelhi ?? c.realDelhi,
              realBombay: update.realBombay ?? c.realBombay,
              phantomDelhi: update.phantomDelhi ?? c.phantomDelhi,
              phantomBombay: update.phantomBombay ?? c.phantomBombay,
            }
          : c
      ));
    };
    const reload = () => loadCycles();
    sseService.on('admin_new_cycle', handleCycleUpdate);
    sseService.on('cycle_update', handleCycleUpdate);
    sseService.on('new_cycle', reload);
    sseService.on('cycle_result', reload);
    return () => {
      sseService.off('admin_new_cycle', handleCycleUpdate);
      sseService.off('cycle_update', handleCycleUpdate);
      sseService.off('new_cycle', reload);
      sseService.off('cycle_result', reload);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const loadCycles = async () => {
    try {
      const response = await api.get<any>('/api/admin/cycles/phases');
      if (response.data?.success && response.data?.cycles) {
        setCycles(response.data.cycles.map((c: any) => ({
          _id: c.cycleId,
          cycleId: c.cycleId,
          type: c.type,
          status: c.status,
          startTime: c.startTime,
          endTime: c.endTime,
          totalDelhi: c.pools?.totalDelhi || 0,
          totalBombay: c.pools?.totalBombay || 0,
          realDelhi: c.pools?.realDelhi || 0,
          realBombay: c.pools?.realBombay || 0,
          phantomDelhi: c.pools?.phantomDelhi || 0,
          phantomBombay: c.pools?.phantomBombay || 0,
          phantomBalanced: c.phantomBalanced || false,
        })) as Cycle[]);
      }
    } catch {
      toast.error('Failed to load cycles');
    } finally {
      setIsLoading(false);
    }
  };

  const act = async (type: string, cycleId: string) => {
    try {
      if (type === 'equalizer') { await api.cycles.triggerEqualizer(cycleId); toast.success('Phantom equalizer triggered'); }
      else if (type === 'pause') { await api.cycles.pauseCycle(cycleId); toast.success('Cycle paused'); }
      else if (type === 'resume') { await api.cycles.resumeCycle(cycleId); toast.success('Cycle resumed'); }
      else if (type === 'cancel') { await api.cycles.cancelCycle(cycleId, 'Cancelled by admin'); toast.success('Cycle cancelled — all bets refunded'); }
      loadCycles();
    } catch (e: any) {
      toast.error(e.response?.data?.message || `Failed to ${type} cycle`);
    }
  };

  const timer = (endTime: number): string => {
    const diff = endTime - now;
    if (diff <= 0) return '00:00';
    const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
    const p = (v: number) => String(v).padStart(2, '0');
    return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  };

  const totalBook = cycles.reduce((a, c) => a + (c.totalDelhi || 0) + (c.totalBombay || 0), 0);
  const totalPhantom = cycles.reduce((a, c) => a + (c.phantomDelhi || 0) + (c.phantomBombay || 0), 0);
  const nextClose = cycles.filter((c) => c.status === 'OPEN' && c.endTime > now).sort((a, b) => a.endTime - b.endTime)[0];

  const kpis = [
    { label: 'Active Cycles', value: String(cycles.length), color: 'var(--text)' },
    { label: 'Total Book', value: inr(totalBook), color: 'var(--text)' },
    { label: 'Phantom Exposure', value: inr(totalPhantom), color: 'var(--risk)' },
    { label: 'Next Settlement', value: nextClose ? timer(nextClose.endTime) : '—', color: 'var(--gold-ink)' },
  ];

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><div className="w-8 h-8 border-4 border-dark-600 border-t-gold-500 rounded-full animate-spin" /></div>;
  }

  return (
    <div className="om-fade" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14 }}>
        {kpis.map((k) => (
          <div key={k.label} className="card" style={{ padding: '15px 16px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600 }}>{k.label}</div>
            <div className="font-mono" style={{ fontSize: 22, fontWeight: 800, marginTop: 7, color: k.color }}>{k.value}</div>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
          <button onClick={loadCycles} className="btn-secondary flex items-center" style={{ height: 38 }}>
            <RefreshCw size={15} className="mr-2" /> Refresh
          </button>
        </div>
      </div>

      {cycles.length === 0 ? (
        <div className="card" style={{ padding: '64px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
          <Activity size={40} style={{ color: 'var(--muted)', marginBottom: 14 }} />
          <div style={{ fontSize: 16, fontWeight: 700 }}>No active cycles</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>New Delhi vs Bombay cycles will appear here as they open.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))', gap: 16 }}>
          {cycles.map((c) => {
            const total = (c.totalDelhi || 0) + (c.totalBombay || 0);
            const delhiPct = total > 0 ? Math.round(((c.totalDelhi || 0) / total) * 100) : 50;
            const tone = cycleStatusTone[c.status] || 'neutral';
            const toneColor = tone === 'gold' ? 'var(--gold-ink)' : `var(--${tone})`;
            const toneBg = tone === 'gold' ? 'var(--warning-bg)' : `var(--${tone}-bg)`;
            const phantom = (c.phantomDelhi || 0) + (c.phantomBombay || 0);
            return (
              <div key={c.cycleId} className="card" style={{ padding: '18px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 15 }}>
                  <div className="font-mono" style={{ fontSize: 15, fontWeight: 800 }}>{c.cycleId}</div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border)', padding: '3px 8px', borderRadius: 6 }}>{c.type === '30_MIN' ? '30 MIN' : 'FULL DAY'}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, padding: '4px 10px', borderRadius: 20, color: toneColor, background: toneBg }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: toneColor }} />{(c.status || '').replace(/_/g, ' ')}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 13 }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Closes in</span>
                  <span className="font-mono" style={{ fontSize: 25, fontWeight: 800, color: c.endTime - now <= 0 ? 'var(--danger)' : 'var(--text)' }}>{timer(c.endTime)}</span>
                </div>

                <div style={{ display: 'flex', height: 12, borderRadius: 8, overflow: 'hidden', background: 'var(--track)', marginBottom: 12 }}>
                  <div style={{ width: `${delhiPct}%`, background: 'linear-gradient(90deg,#5aa0f2,#3d6bd6)' }} />
                  <div style={{ width: `${100 - delhiPct}%`, background: 'linear-gradient(90deg,#efb03e,#d4913a)' }} />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 11, padding: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--info)' }} /><span style={{ fontSize: 11, fontWeight: 800, color: 'var(--info)' }}>DELHI</span></div>
                    <div className="font-mono" style={{ fontSize: 17, fontWeight: 800 }}>{inr(c.totalDelhi)}</div>
                    <div className="font-mono" style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>real {inr(c.realDelhi)} · ph {inr(c.phantomDelhi)}</div>
                  </div>
                  <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 11, padding: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--warning)' }} /><span style={{ fontSize: 11, fontWeight: 800, color: 'var(--warning)' }}>BOMBAY</span></div>
                    <div className="font-mono" style={{ fontSize: 17, fontWeight: 800 }}>{inr(c.totalBombay)}</div>
                    <div className="font-mono" style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>real {inr(c.realBombay)} · ph {inr(c.phantomBombay)}</div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 600 }}>Phantom exposure</div>
                    <div className="font-mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--risk)', marginTop: 2 }}>{inr(phantom)}</div>
                  </div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, padding: '4px 10px', borderRadius: 20, color: c.phantomBalanced ? 'var(--success)' : 'var(--warning)', background: c.phantomBalanced ? 'var(--success-bg)' : 'var(--warning-bg)' }}>
                    {c.phantomBalanced ? 'Balanced' : 'Balancing'}
                  </span>
                </div>

                {/* Actions — Balance Book (equalizer) + lifecycle controls */}
                <div style={{ display: 'flex', gap: 9, marginTop: 14, flexWrap: 'wrap' }}>
                  {!c.phantomBalanced && c.status === 'OPEN' && (
                    <button onClick={() => setConfirmAction({ type: 'equalizer', cycle: c })} style={{ flex: 1, minWidth: 130, height: 38, borderRadius: 9, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', color: 'var(--text)' }}>
                      <Scale size={14} /> Balance Book
                    </button>
                  )}
                  {c.status === 'OPEN' && (
                    <>
                      <button onClick={() => setConfirmAction({ type: 'pause', cycle: c })} style={{ height: 38, padding: '0 14px', borderRadius: 9, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', color: 'var(--text)' }}><Pause size={14} /> Pause</button>
                      <button onClick={() => setConfirmAction({ type: 'cancel', cycle: c })} style={{ height: 38, padding: '0 14px', borderRadius: 9, background: 'var(--danger-bg)', border: '1px solid var(--danger)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', color: 'var(--danger)' }}><XCircle size={14} /> Cancel</button>
                    </>
                  )}
                  {c.status === 'PAUSED' && (
                    <button onClick={() => setConfirmAction({ type: 'resume', cycle: c })} style={{ flex: 1, height: 38, borderRadius: 9, background: 'var(--gold)', color: 'var(--gold-on)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: 'none' }}><Play size={14} /> Resume</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {confirmAction && (
        <ConfirmDialog
          isOpen={!!confirmAction}
          onClose={() => setConfirmAction(null)}
          onConfirm={() => act(confirmAction.type, confirmAction.cycle.cycleId)}
          title={confirmAction.type === 'equalizer' ? 'Balance the book?' : confirmAction.type === 'cancel' ? 'Cancel Cycle' : `${confirmAction.type.charAt(0).toUpperCase() + confirmAction.type.slice(1)} Cycle`}
          message={confirmAction.type === 'equalizer' ? 'Add phantom bets to balance Delhi vs Bombay exposure for this cycle. Recorded in Audit Logs.' : confirmAction.type === 'cancel' ? 'All bets will be refunded. This cannot be undone!' : `Are you sure you want to ${confirmAction.type} this cycle?`}
          type={confirmAction.type === 'cancel' ? 'danger' : 'warning'}
          confirmText={confirmAction.type.charAt(0).toUpperCase() + confirmAction.type.slice(1)}
        />
      )}
    </div>
  );
};
