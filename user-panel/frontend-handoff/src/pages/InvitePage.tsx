// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * InvitePage.tsx — 2026 "Bazaar" redesign.
 *
 * Referral hub wired to the real referral API (/api/referral/me + /team).
 * GOVERNANCE §7 / H-03: only F1 (direct-referral) commission is paid by
 * gameEngine.js — the copy here describes F1 only; no F2/F3 earning is implied.
 */
import React, { useEffect, useState } from 'react';
import { fmt } from '../redesign/format';
import ScreenShell, { card, capLabel } from '../redesign/Screen';

export default function InvitePage() {
  const [data, setData] = useState<any>(null);
  const [team, setTeam] = useState<any>({ f1: [], f2: [], f3: [] });
  const [copied, setCopied] = useState('');

  useEffect(() => {
    const token = localStorage.getItem('auth_token') || '';
    const h = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/referral/me', { headers: h, credentials: 'include' }).then(r => r.json()).catch(() => ({})),
      fetch('/api/referral/team', { headers: h, credentials: 'include' }).then(r => r.json()).catch(() => ({})),
    ]).then(([me, t]) => { if (me?.success) setData(me); if (t?.success) setTeam(t); });
  }, []);

  const copy = (text: string, which: string) => {
    if (!text) return;
    navigator.clipboard?.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(''), 2000);
  };
  const share = () => {
    if (navigator.share && data?.inviteUrl) navigator.share({ title: 'Join Betting Bazaar!', text: `Use my invite code ${data?.inviteCode} and win big!`, url: data.inviteUrl });
    else copy(data?.inviteUrl || '', 'link');
  };

  const code = data?.inviteCode || '———';
  const url = data?.inviteUrl || '';
  const friends = team.f1 || [];

  const steps = [
    { n: '1', t: 'Share your code', d: 'Send your link or code to friends.' },
    { n: '2', t: 'They join & play', d: 'Friend signs up with your code and places bets.' },
    { n: '3', t: 'You earn', d: 'Earn F1 commission on their winning bets, credited to Winnings.' },
  ];

  return (
    <ScreenShell icon="🤝" title="Invite & Earn" sub="Share your code, get rewarded">
      {/* Referral hero */}
      <div style={{ borderRadius: 18, padding: 18, background: 'linear-gradient(135deg,#062018,#04120d),radial-gradient(120% 120% at 100% 0,rgba(49,196,110,.28),transparent 55%)', border: '1px solid rgba(49,196,110,.3)', boxShadow: 'var(--shadow)', marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: '#66d99a' }}>Your referral code</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <div className="font-grotesk" style={{ flex: 1, fontWeight: 700, fontSize: 26, letterSpacing: '.14em', color: '#b6f2cf', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{code}</div>
          <button onClick={() => copy(code, 'code')} style={{ padding: '11px 18px', borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 13, color: '#062018', background: 'linear-gradient(135deg,#8ff0b6,#31c46e)' }}>{copied === 'code' ? 'Copied!' : 'Copy'}</button>
        </div>
        {url && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 11, padding: '9px 12px' }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: 'ui-monospace,monospace', color: '#cdeede', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{url}</span>
            <button onClick={() => copy(url, 'link')} style={{ flex: 'none', fontSize: 11, fontWeight: 800, color: '#8ff0b6', background: 'none', border: 'none', cursor: 'pointer' }}>{copied === 'link' ? 'Copied!' : 'Copy link'}</button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button onClick={share} style={{ flex: 1, padding: 9, borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 800, color: '#052018', background: '#25D366' }}>WhatsApp</button>
          <button onClick={share} style={{ flex: 1, padding: 9, borderRadius: 10, border: '1px solid rgba(255,255,255,.18)', cursor: 'pointer', fontSize: 12, fontWeight: 800, color: '#cdeede', background: 'rgba(255,255,255,.05)' }}>Telegram</button>
          <button onClick={share} style={{ flex: 1, padding: 9, borderRadius: 10, border: '1px solid rgba(255,255,255,.18)', cursor: 'pointer', fontSize: 12, fontWeight: 800, color: '#cdeede', background: 'rgba(255,255,255,.05)' }}>More</button>
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
          <div><div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: '#66d99a' }}>EARNED</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 20, color: '#eafff2' }}>₹{fmt(Math.round(data?.totalEarned || 0))}</div></div>
          <div style={{ width: 1, background: 'rgba(255,255,255,.12)' }} />
          <div><div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: '#66d99a' }}>FRIENDS</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 20, color: '#eafff2' }}>{fmt(data?.totalReferrals || friends.length)}</div></div>
        </div>
      </div>

      {/* Commission structure (F1 only) */}
      <div style={{ ...card, marginBottom: 14 }}>
        <span style={capLabel}>Commission structure</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 12 }}>
          <div style={{ background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 12, padding: '11px 13px' }}><div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: 'var(--text3)' }}>DIRECT REFERRAL · F1</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 18, color: 'var(--gold-ink)' }}>1%</div><div style={{ fontSize: 9, color: 'var(--text3)' }}>on every winning bet your invite places</div></div>
          <div style={{ background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 12, padding: '11px 13px' }}><div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: 'var(--text3)' }}>TODAY EARNED</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 18, color: 'var(--green)' }}>₹{fmt(Math.round(data?.todayEarned || 0))}</div><div style={{ fontSize: 9, color: 'var(--text3)' }}>credited to your Winnings balance</div></div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 10, lineHeight: 1.5 }}>Rate is set by admin and may change. Commission is paid on winning bets by direct (F1) referrals only.</div>
      </div>

      {/* How it works */}
      <div style={{ ...card, marginBottom: 14 }}>
        <span style={capLabel}>How it works</span>
        <div style={{ display: 'grid', gap: 12, marginTop: 13 }}>
          {steps.map(s => (
            <div key={s.n} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <span className="font-grotesk" style={{ width: 28, height: 28, flex: 'none', borderRadius: '50%', background: 'color-mix(in srgb,var(--gold) 16%,transparent)', border: '1px solid var(--line2)', color: 'var(--gold-ink)', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{s.n}</span>
              <div><div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{s.t}</div><div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 1 }}>{s.d}</div></div>
            </div>
          ))}
        </div>
      </div>

      {/* Referred friends */}
      <div style={card}>
        <span style={capLabel}>Referred friends</span>
        {friends.length === 0 && <div style={{ fontSize: 12, color: 'var(--text3)', padding: '12px 0 2px' }}>No referrals yet — share your code to get started.</div>}
        {friends.slice(0, 8).map((m: any) => (
          <div key={m.userId} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 0', borderTop: '1px solid var(--line)' }}>
            <span style={{ width: 32, height: 32, flex: 'none', borderRadius: '50%', background: 'var(--surface3)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>👤</span>
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}><span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{m.username || `•••${String(m.mobile || '').slice(-4)}`}</span><span style={{ fontSize: 10, color: 'var(--text3)' }}>{m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : ''}</span></span>
          </div>
        ))}
      </div>
    </ScreenShell>
  );
}
