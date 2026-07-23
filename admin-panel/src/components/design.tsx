// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Command Center "generic engine" primitives — shared building blocks that let
// the standard list/form pages match the design handoff with minimal per-page
// code: a KPI row, a toolbar (pill tabs + search + actions) and table-cell
// helpers (avatar, mono amount, progress bar). Presentation only; each page
// keeps its own data fetching and backend actions.
import React from 'react';
import { Search, type LucideIcon } from 'lucide-react';

// ── shared avatar palette + initials ────────────────────────────────────────
export const AV = [
  'linear-gradient(140deg,#3d6bd6,#7b4fe0)', 'linear-gradient(140deg,#e08a3d,#d4593a)',
  'linear-gradient(140deg,#34a97f,#2b8f6f)', 'linear-gradient(140deg,#b57cf0,#7b4fe0)',
  'linear-gradient(140deg,#d4913a,#b8941f)',
];
export const initialsOf = (name?: string) =>
  (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2) || '?';

// ── KPI row ─────────────────────────────────────────────────────────────────
export interface KpiItem {
  label: string;
  value: React.ReactNode;
  sub?: string;
  delta?: string;
  deltaTone?: 'success' | 'danger' | 'warning';
  tone?: string; // CSS colour for the value
}

const deltaStyle = (tone: KpiItem['deltaTone']): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 800,
  fontFamily: "'JetBrains Mono',monospace", padding: '2px 7px', borderRadius: 6, whiteSpace: 'nowrap',
  color: `var(--${tone || 'success'})`, background: `var(--${tone || 'success'}-bg)`,
});

export const Kpis: React.FC<{ items: KpiItem[]; min?: number }> = ({ items, min = 190 }) => (
  <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit,minmax(${min}px,1fr))`, gap: 14, marginBottom: 16 }}>
    {items.map((k) => (
      <div key={k.label} className="card" style={{ padding: '15px 16px' }}>
        <div style={{ fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600 }}>{k.label}</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 7 }}>
          <span className="font-mono" style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-.02em', color: k.tone || 'var(--text)' }}>{k.value}</span>
          {k.delta && <span style={deltaStyle(k.deltaTone)}>{k.delta}</span>}
        </div>
        {k.sub && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>{k.sub}</div>}
      </div>
    ))}
  </div>
);

// ── Toolbar (pill tabs + search + action buttons) ───────────────────────────
export interface ToolbarTab { label: string; count?: string | number; active?: boolean; onClick?: () => void; }
export interface ToolbarAction { label: string; icon?: LucideIcon; primary?: boolean; onClick?: () => void; }

const tabStyle = (on?: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 7, height: 30, padding: '0 13px', borderRadius: 7,
  fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
  background: on ? 'var(--gold)' : 'transparent', color: on ? 'var(--gold-on)' : 'var(--text-2)',
});
const countStyle = (on?: boolean): React.CSSProperties => ({
  fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", padding: '1px 6px', borderRadius: 10,
  background: on ? 'rgba(0,0,0,.18)' : 'var(--surface-2)', color: on ? 'var(--gold-on)' : 'var(--muted)',
});
const actionStyle = (primary?: boolean): React.CSSProperties => primary
  ? { display: 'flex', alignItems: 'center', gap: 7, height: 38, padding: '0 15px', borderRadius: 9, background: 'var(--gold)', color: 'var(--gold-on)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: 'none' }
  : { display: 'flex', alignItems: 'center', gap: 7, height: 38, padding: '0 14px', borderRadius: 9, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };

export const Toolbar: React.FC<{
  tabs?: ToolbarTab[];
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  actions?: ToolbarAction[];
}> = ({ tabs, search, actions }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 15, flexWrap: 'wrap' }}>
    {tabs && tabs.length > 0 && (
      <div style={{ display: 'flex', gap: 6, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 4 }}>
        {tabs.map((t) => (
          <div key={t.label} onClick={t.onClick} style={tabStyle(t.active)}>
            {t.label}
            {t.count != null && <span style={countStyle(t.active)}>{t.count}</span>}
          </div>
        ))}
      </div>
    )}
    <div style={{ flex: 1 }} />
    {search && (
      <div style={{ position: 'relative', width: 250, maxWidth: '44vw' }}>
        <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
          placeholder={search.placeholder || 'Search…'}
          style={{ width: '100%', height: 38, borderRadius: 9, border: '1px solid var(--input-border)', background: 'var(--input)', color: 'var(--text)', padding: '0 12px 0 34px', fontSize: 12.5, outline: 'none' }}
        />
      </div>
    )}
    {(actions || []).map((a) => (
      <button key={a.label} onClick={a.onClick} style={actionStyle(a.primary)}>
        {a.icon && <a.icon size={15} />}{a.label}
      </button>
    ))}
  </div>
);

// ── table cell helpers ──────────────────────────────────────────────────────
export const AvatarCell: React.FC<{ name: string; sub?: string; index?: number }> = ({ name, sub, index = 0 }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
    <div style={{ width: 34, height: 34, borderRadius: 9, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12, color: '#fff', background: AV[index % 5] }}>{initialsOf(name)}</div>
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
      {sub && <div className="font-mono" style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
    </div>
  </div>
);

export const Money: React.FC<{ value: React.ReactNode; tone?: string }> = ({ value, tone }) => (
  <span className="font-mono" style={{ fontSize: 13, fontWeight: 700, color: tone ? `var(--${tone})` : 'var(--text)' }}>{value}</span>
);

export const Mono: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color }) => (
  <span className="font-mono" style={{ fontSize: 12.5, color: color || 'var(--text-2)' }}>{children}</span>
);

export const Progress: React.FC<{ pct: number; label?: string; tone?: string }> = ({ pct, label, tone = 'success' }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
    <div style={{ flex: 1, height: 6, borderRadius: 5, background: 'var(--track)', overflow: 'hidden' }}>
      <div style={{ height: '100%', background: `var(--${tone})`, width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
    <span className="font-mono" style={{ fontSize: 11.5, fontWeight: 700, color: `var(--${tone})` }}>{label ?? `${Math.round(pct)}%`}</span>
  </div>
);

// Compact INR formatter shared by the rebuilt pages.
export const inr = (n: number | undefined | null): string => {
  const x = Number(n) || 0;
  const s = x < 0 ? '-' : '';
  const a = Math.abs(x);
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(1)}k`;
  return `${s}₹${a.toLocaleString('en-IN')}`;
};
