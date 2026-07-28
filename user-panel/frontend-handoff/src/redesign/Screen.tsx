// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Screen.tsx — shared layout primitives for the redesigned secondary screens
 * (Wallet, Profile, Results, …). Provides the centered bb-rise container with a
 * consistent icon + title + subtitle page header, plus a few reusable inline
 * style objects so every screen reads as one system.
 */
import React from 'react';

export const card: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16,
  padding: 16, boxShadow: 'var(--shadow-sm)',
};

export const capLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 800, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--text2)',
};

export const goldButton: React.CSSProperties = {
  width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer',
  fontWeight: 800, fontSize: 15, color: '#1a1200',
  background: 'linear-gradient(135deg,var(--gold2),var(--gold))', boxShadow: '0 8px 22px -8px var(--glow)',
};

export const inputStyle: React.CSSProperties = {
  width: '100%', height: 46, background: 'var(--surface2)', border: '1px solid var(--line2)',
  borderRadius: 12, padding: '0 14px', color: 'var(--text)', fontSize: 14, outline: 'none',
};

export const fieldLabel: React.CSSProperties = {
  display: 'block', fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase',
  color: 'var(--text3)', marginBottom: 6,
};

interface ScreenShellProps {
  icon: string;
  title: string;
  sub?: string;
  children: React.ReactNode;
  maxWidth?: number;
}

const ScreenShell: React.FC<ScreenShellProps> = ({ icon, title, sub, children, maxWidth = 1040 }) => (
  <div className="bb-rise" style={{ width: '100%', maxWidth, margin: '0 auto', padding: '18px 15px 104px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 18 }}>
      <span style={{ width: 46, height: 46, flex: 'none', borderRadius: 13, background: 'color-mix(in srgb,var(--gold) 12%,var(--surface))', border: '1px solid var(--line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 23 }}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <h1 className="font-grotesk" style={{ margin: 0, fontWeight: 700, fontSize: 22, color: 'var(--text)', lineHeight: 1.1 }}>{title}</h1>
        {sub && <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text3)' }}>{sub}</p>}
      </div>
    </div>
    {children}
  </div>
);

export default ScreenShell;
