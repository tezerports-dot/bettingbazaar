// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Operations Command dashboard — Command Center design (handoff
// "Betting Bazaar Admin.dc.html"). The layout matches the design; every figure
// is sourced from real backend data (analytics, active cycles, audit logs).
// Sections with no live source render an honest "awaiting data" state rather
// than fabricated numbers (GOVERNANCE §2: no hardcoded business values).
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowRight, Inbox, ShieldCheck, Activity } from 'lucide-react';
import { LoadingSpinner } from '../components/LoadingSpinner';
import api from '../services/api';
import type { DashboardStats, Cycle } from '../types';

// ── formatting helpers ──────────────────────────────────────────────────────
const inr = (n: number | undefined | null): string => {
  const x = Number(n) || 0;
  const s = x < 0 ? '-' : '';
  const a = Math.abs(x);
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(1)}k`;
  return `${s}₹${a.toLocaleString('en-IN')}`;
};
const num = (n: number | undefined | null): string => (Number(n) || 0).toLocaleString('en-IN');
const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0);

const fmtCountdown = (ms: number): string => {
  if (ms <= 0) return '00:00';
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const p = (v: number) => String(v).padStart(2, '0');
  return h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
};
const fmtWait = (seconds: number): string => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** Deterministic, decorative sparkline (ornamental only — asserts no history). */
function spark(seed: string): { line: string; area: string } {
  const w = 120, h = 26;
  let acc = 0;
  const vals = Array.from({ length: 8 }, (_, i) => {
    acc = (acc * 31 + seed.charCodeAt(i % seed.length) + i * 7) % 97;
    return 0.35 + (acc / 97) * 0.55;
  });
  const mx = Math.max(...vals), mn = Math.min(...vals), rg = (mx - mn) || 1;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 2 - ((v - mn) / rg) * (h - 5)]);
  const line = 'M' + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ');
  return { line, area: `${line} L ${w} ${h} L 0 ${h} Z` };
}

// ── card + KPI primitives ───────────────────────────────────────────────────
const Card: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div className="card" style={{ padding: '18px 20px', ...style }}>{children}</div>
);

const Kpi: React.FC<{ label: string; value: string; sub?: string; badge?: string; tone?: string; gold?: boolean; seed: string }>
  = ({ label, value, sub, badge, tone = 'success', gold, seed }) => {
  const sp = spark(seed);
  return (
    <div className="card" style={{ padding: '15px 16px 12px', position: 'relative', overflow: 'hidden' }}>
      <span style={{ fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600 }}>{label}</span>
      <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-.02em', fontFamily: "'JetBrains Mono',monospace", marginTop: 8, color: gold ? 'var(--gold-ink)' : 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5 }}>
        {badge && (
          <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", padding: '2px 7px', borderRadius: 6, whiteSpace: 'nowrap', color: `var(--${tone})`, background: `var(--${tone}-bg)` }}>{badge}</span>
        )}
        {sub && <span style={{ fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</span>}
      </div>
      <svg width="100%" height="26" viewBox="0 0 120 26" preserveAspectRatio="none" style={{ marginTop: 9, display: 'block', opacity: 0.45 }}>
        <path d={sp.area} fill="var(--success-bg)" />
        <path d={sp.line} fill="none" stroke="var(--success)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
};

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activeCycles, setActiveCycles] = useState<Cycle[]>([]);
  const [feed, setFeed] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [chartMode, setChartMode] = useState<'cashflow' | 'revenue'>('cashflow');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [sRes, cRes] = await Promise.allSettled([api.analytics.getDashboard(), api.cycles.getActive()]);
        if (!alive) return;
        if (sRes.status === 'fulfilled' && (sRes.value as any)?.success) setStats((sRes.value as any).data);
        if (cRes.status === 'fulfilled' && (cRes.value as any)?.success) setActiveCycles((cRes.value as any).data || []);
        // Audit-log feed is admin-only and best-effort.
        try {
          const l = await api.system.getAuditLogs(1, 6);
          if (alive && (l as any)?.success) setFeed((l as any).data || []);
        } catch { /* not permitted / unavailable */ }
      } finally {
        if (alive) setIsLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Live countdown for the featured active cycle.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const book = useMemo(() => {
    const c = activeCycles.find((x) => x.status === 'OPEN') || activeCycles[0];
    if (!c) return null;
    const delhi = c.totalDelhi ?? 0, bombay = c.totalBombay ?? 0, total = delhi + bombay;
    return {
      cycleId: c.cycleId,
      timer: fmtCountdown((c.endTime || 0) - now),
      delhi, bombay,
      delhiPct: total > 0 ? pct(delhi, total) : 50,
      bombayPct: total > 0 ? 100 - pct(delhi, total) : 50,
      phantom: (c.phantomDelhi ?? 0) + (c.phantomBombay ?? 0),
      balanced: c.phantomBalanced,
    };
  }, [activeCycles, now]);

  if (isLoading) return <LoadingSpinner size="lg" />;

  const s = stats;
  const margin = s ? pct(s.finance.netProfit, s.finance.totalBets) : 0;
  const inflow = s ? (s.finance.tokenBuy ?? s.finance.totalDeposits ?? 0) : 0;
  const outflow = s ? (s.finance.tokenSell ?? s.finance.totalWithdrawals ?? 0) : 0;

  // Chart bars (real current-period figures; two series per the design).
  const chart = chartMode === 'cashflow'
    ? { legend: [{ label: 'Inflow', color: '#34d17f' }, { label: 'Outflow', color: '#5aa0f2' }], bars: [{ label: 'Inflow', val: inflow, color: 'linear-gradient(180deg,#34d17f,#2bb96f)' }, { label: 'Outflow', val: outflow, color: 'linear-gradient(180deg,#5aa0f2,#3d6bd6)' }] }
    : { legend: [{ label: 'Net Revenue', color: '#efb03e' }, { label: 'Net Profit', color: '#34d17f' }], bars: [{ label: 'Net Revenue', val: s?.finance.totalBets ?? 0, color: 'linear-gradient(180deg,#efb03e,#d4913a)' }, { label: 'Net Profit', val: s?.finance.netProfit ?? 0, color: 'linear-gradient(180deg,#34d17f,#2bb96f)' }] };
  const barMax = Math.max(1, ...chart.bars.map((b) => Math.abs(b.val)));

  const seg = (on: boolean): React.CSSProperties => ({
    padding: '5px 11px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
    background: on ? 'var(--gold)' : 'transparent', color: on ? 'var(--gold-on)' : 'var(--text-2)',
  });

  const lanes = s ? [
    { title: 'Operations Queue', sub: 'Actionable work items', icon: Inbox, tone: 'info', rows: [
      { label: 'Pending payment orders', value: num(s.queue.pendingOrders), color: 'var(--warning)', go: '/queue-manager' },
      { label: 'KYC awaiting review', value: num(s.users.kycPending), color: 'var(--warning)', go: '/kyc' },
      { label: 'Merchant approvals', value: num(s.merchants.pending), color: 'var(--info)', go: '/merchants' },
    ] },
    { title: 'Risk & Controls', sub: 'Needs admin intervention', icon: ShieldCheck, tone: 'danger', rows: [
      { label: 'Blocked users', value: num(s.users.blocked), color: 'var(--text)', go: '/users' },
      { label: 'Pending KYC', value: num(s.users.kycPending), color: 'var(--warning)', go: '/kyc' },
      { label: 'Online merchants', value: num(s.merchants.online), color: 'var(--success)', go: '/merchants' },
    ] },
  ] : [];

  return (
    <div className="om-fade">
      {/* ── KPI ROW ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(158px,1fr))', gap: 14, marginBottom: 16 }}>
        {s ? (
          <>
            <Kpi seed="users" label="Total Users" value={num(s.users.total)} badge={`${pct(s.users.active, s.users.total)}% active`} sub={`${num(s.users.active)} active`} />
            <Kpi seed="merchants" label="Active Merchants" value={num(s.merchants.online)} sub={`of ${num(s.merchants.total)} total`} />
            <Kpi seed="orders" label="Pending Orders" value={num(s.queue.pendingOrders)} tone="warning" badge={fmtWait(s.queue.avgWaitTime)} sub="avg wait" />
            <Kpi seed="bets" label="Bets Today" value={num(s.cycles.totalBets)} sub={`${num(s.cycles.activeCount)} active cycles`} />
            <Kpi seed="revenue" label="Net Revenue" value={inr(s.finance.netProfit)} gold badge={`${margin}% margin`} sub="today" />
            <Kpi seed="payouts" label="Total Payouts" value={inr(s.finance.totalPayouts)} tone="warning" sub="today" />
          </>
        ) : (
          <Card style={{ gridColumn: '1/-1' }}>
            <div style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', padding: '18px 0' }}>Live metrics are unavailable right now.</div>
          </Card>
        )}
      </div>

      {/* ── CHART + LIVE BOOK ───────────────────────────────────────────── */}
      <div className="bb-grid" style={{ display: 'grid', gridTemplateColumns: '1.85fr 1fr', gap: 16, marginBottom: 16 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700 }}>{chartMode === 'cashflow' ? 'Cashflow & Settlement' : 'Revenue vs Profit'}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                {chartMode === 'cashflow' ? 'Token buy (inflow) vs token sell (outflow) · today' : 'Total bets vs net profit · today'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 3, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
              <div onClick={() => setChartMode('cashflow')} style={seg(chartMode === 'cashflow')}>Cashflow</div>
              <div onClick={() => setChartMode('revenue')} style={seg(chartMode === 'revenue')}>Revenue vs Profit</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 16, margin: '2px 0 6px' }}>
            {chart.legend.map((l) => (
              <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: l.color }} />
                <span style={{ fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600 }}>{l.label}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 40, height: 214, marginTop: 12, padding: '0 8px', justifyContent: 'center' }}>
            {chart.bars.map((b) => (
              <div key={b.label} style={{ flex: '0 1 130px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%' }}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%', justifyContent: 'center' }}>
                  <div style={{ width: '100%', maxWidth: 90, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: 'var(--text-2)', marginBottom: 6 }}>{inr(b.val)}</span>
                    <div style={{ width: '100%', borderRadius: '6px 6px 0 0', background: b.color, height: `${Math.max(4, Math.round((Math.abs(b.val) / barMax) * 150))}px` }} title={inr(b.val)} />
                  </div>
                </div>
                <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginTop: 8 }}>{b.label}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Live book */}
        <Card style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700 }}>Delhi vs Bombay</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{book ? `Live book · cycle ${book.cycleId}` : 'No open cycle'}</div>
            </div>
            {book && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, color: 'var(--success)', background: 'var(--success-bg)', padding: '4px 9px', borderRadius: 20 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', animation: 'om-pulse 1.6s infinite' }} />OPEN
              </span>
            )}
          </div>
          {book ? (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 8, margin: '18px 0 4px' }}>
                <span style={{ fontSize: 34, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", letterSpacing: '-.02em' }}>{book.timer}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>to close</span>
              </div>
              <div style={{ display: 'flex', height: 12, borderRadius: 8, overflow: 'hidden', marginTop: 12, background: 'var(--track)' }}>
                <div style={{ width: `${book.delhiPct}%`, background: 'linear-gradient(90deg,#5aa0f2,#3d6bd6)' }} />
                <div style={{ width: `${book.bombayPct}%`, background: 'linear-gradient(90deg,#efb03e,#d4913a)' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 9 }}>
                <div><div style={{ fontSize: 11, color: 'var(--info)', fontWeight: 700 }}>DELHI</div><div style={{ fontSize: 15, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", marginTop: 1 }}>{inr(book.delhi)}</div></div>
                <div style={{ textAlign: 'right' }}><div style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 700 }}>BOMBAY</div><div style={{ fontSize: 15, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", marginTop: 1 }}>{inr(book.bombay)}</div></div>
              </div>
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 9 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Phantom exposure</span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: 'var(--risk)' }}>{inr(book.phantom)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Book balance</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, color: book.balanced ? 'var(--success)' : 'var(--warning)', background: book.balanced ? 'var(--success-bg)' : 'var(--warning-bg)', padding: '3px 9px', borderRadius: 20 }}>{book.balanced ? 'Balanced' : 'Balancing'}</span>
                </div>
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '28px 0', color: 'var(--muted)' }}>
              <Activity size={28} />
              <div style={{ fontSize: 12.5 }}>No open cycle right now</div>
            </div>
          )}
          <div onClick={() => navigate('/live-cycles')} style={{ marginTop: 14, height: 38, borderRadius: 9, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', color: 'var(--text)' }}>
            Open Live Cycles <ArrowRight size={14} />
          </div>
        </Card>
      </div>

      {/* ── LANES + ACTIVITY ────────────────────────────────────────────── */}
      <div className="bb-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.15fr', gap: 16, marginBottom: 16 }}>
        {lanes.map((lane) => (
          <Card key={lane.title}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 15 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `var(--${lane.tone}-bg)` }}>
                <lane.icon size={18} style={{ color: `var(--${lane.tone})` }} />
              </div>
              <div><div style={{ fontSize: 13.5, fontWeight: 700 }}>{lane.title}</div><div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{lane.sub}</div></div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              {lane.rows.map((r) => (
                <div key={r.label} onClick={() => navigate(r.go)} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '2px 0' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-2)', flex: 1 }}>{r.label}</span>
                  <span style={{ fontSize: 14, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: r.color }}>{r.value}</span>
                  <ArrowRight size={13} style={{ color: 'var(--muted)' }} />
                </div>
              ))}
            </div>
          </Card>
        ))}

        <Card style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, flex: 1 }}>Recent Activity</div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 800, color: 'var(--success)', letterSpacing: '.05em' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', animation: 'om-pulse 1.6s infinite' }} />LIVE
            </span>
          </div>
          {feed.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {feed.slice(0, 5).map((f, i) => {
                const who = f.adminUsername || f.actor || f.adminName || f.performedBy || 'System';
                const action = f.action || f.event || f.description || 'activity';
                const when = f.createdAt || f.timestamp || f.time;
                return (
                  <div key={f._id || i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ width: 29, height: 29, borderRadius: 8, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--info-bg)', color: 'var(--info)', fontSize: 11, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace" }}>
                      {String(who).slice(0, 2).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <span style={{ fontWeight: 700, color: 'var(--text)' }}>{who}</span> {String(action).toLowerCase()}
                      </div>
                    </div>
                    <span style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 500, flex: 'none', fontFamily: "'JetBrains Mono',monospace" }}>
                      {when ? new Date(when).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '24px 0', color: 'var(--muted)' }}>
              <Inbox size={26} />
              <div style={{ fontSize: 12.5 }}>No recent activity to show</div>
            </div>
          )}
        </Card>
      </div>

      {/* ── FINANCIAL OVERVIEW + PLATFORM HEALTH ────────────────────────── */}
      <div className="bb-grid" style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16 }}>
        <Card>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Financial Overview</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, marginBottom: 15 }}>Net Revenue = Total Bets − Payouts − costs · today</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            {[
              { label: 'Token Buy', value: inr(inflow), color: 'var(--success)' },
              { label: 'Token Sell', value: inr(outflow), color: 'var(--danger)' },
              { label: 'Total Bets', value: inr(s?.finance.totalBets), color: 'var(--info)' },
              { label: 'Payouts', value: inr(s?.finance.totalPayouts), color: 'var(--warning)' },
            ].map((f) => (
              <div key={f.label}><div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600 }}>{f.label}</div><div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", marginTop: 5, color: f.color }}>{f.value}</div></div>
            ))}
          </div>
          <div style={{ marginTop: 15, padding: '13px 15px', borderRadius: 12, background: 'var(--warning-bg)', border: '1px solid rgba(212,175,55,.28)' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600 }}>Net Revenue</div>
            <div style={{ fontSize: 26, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: 'var(--gold-ink)', marginTop: 2 }}>{inr(s?.finance.netProfit)}</div>
          </div>
        </Card>

        <Card>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 2 }}>Platform Health</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 15 }}>Live coverage & operational load</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {[
              { name: 'Liquidity coverage', pctVal: outflow > 0 ? Math.min(100, Math.round((inflow / outflow) * 100)) : 100, amount: `${outflow > 0 ? Math.round((inflow / outflow) * 100) : 100}%`, color: 'linear-gradient(90deg,#34d17f,#2bb96f)' },
              { name: 'Merchants online', pctVal: pct(s?.merchants.online ?? 0, s?.merchants.total ?? 0), amount: `${num(s?.merchants.online)} / ${num(s?.merchants.total)}`, color: 'linear-gradient(90deg,#5aa0f2,#3d6bd6)' },
              { name: 'KYC verified users', pctVal: pct((s?.users.total ?? 0) - (s?.users.kycPending ?? 0), s?.users.total ?? 0), amount: `${num((s?.users.total ?? 0) - (s?.users.kycPending ?? 0))}`, color: 'linear-gradient(90deg,#efb03e,#d4913a)' },
              { name: 'Active users', pctVal: pct(s?.users.active ?? 0, s?.users.total ?? 0), amount: `${num(s?.users.active)}`, color: 'linear-gradient(90deg,#b57cf0,#9b5fe0)' },
            ].map((m) => (
              <div key={m.name}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' }}>{m.name}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>{m.amount}</span>
                </div>
                <div style={{ height: 7, borderRadius: 6, background: 'var(--track)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 6, background: m.color, width: `${Math.max(2, Math.min(100, m.pctVal))}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};
