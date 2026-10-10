// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Wallet's VIP / General toggle (owner, 2026-10-10).
 *
 * Two wallets, one switch: VIP is the deposited money, General is the referral
 * bonus. Picking a side here IS the play-profile switch — the same
 * `PUT /api/user/play-profile` the header pill makes — so the board the player
 * opens next plays from the wallet they are looking at. The pill hears it
 * through `PROFILE_CHANGED_EVENT` and re-reads.
 *
 * Every figure is the server's: the VIP total from the wallet the page already
 * read, the General balance and its outstanding turnover from
 * `GET /api/user/general` (`promo.js`).
 */
import React, { useState } from 'react';
import type { GeneralSummary, PlayProfile } from './ProfileSwitch';
import { fmt } from './format';

interface Props {
  general: GeneralSummary | null;
  choose: (p: PlayProfile) => Promise<boolean>;
  error: string;
  /** The VIP wallet's total, as the page shows it. */
  vipTotal: number;
}

const WalletProfileToggle: React.FC<Props> = ({ general, choose, error, vipTotal }) => {
  const [busy, setBusy] = useState<PlayProfile | null>(null);
  if (!general) return null;

  const pick = async (p: PlayProfile) => {
    if (busy || general.profile === p) return;
    setBusy(p);
    await choose(p);
    setBusy(null);
  };

  const side = (p: PlayProfile, title: string, amount: number, sub: string) => {
    const on = general.profile === p;
    const tone = p === 'VIP' ? 'var(--gold)' : 'var(--green)';
    return (
      <button
        type="button"
        role="radio"
        aria-checked={on}
        onClick={() => { void pick(p); }}
        disabled={busy !== null}
        style={{
          flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
          padding: '10px 12px', borderRadius: 12, cursor: busy ? 'wait' : 'pointer', textAlign: 'left',
          border: `1.5px solid ${on ? tone : 'transparent'}`,
          background: on ? `color-mix(in srgb,${tone} 14%,var(--surface))` : 'transparent',
          opacity: busy && busy !== p ? 0.6 : 1, transition: 'background .15s, border-color .15s',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: on ? tone : 'var(--text3)' }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: on ? tone : 'var(--line2)' }} />
          {title}
        </span>
        <span className="font-grotesk" style={{ fontSize: 18, fontWeight: 700, color: on ? 'var(--text)' : 'var(--text2)' }}>₹{fmt(amount)}</span>
        <span style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.35 }}>{busy === p ? 'Switching…' : sub}</span>
      </button>
    );
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div role="radiogroup" aria-label="Which wallet you play from" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 16, background: 'var(--surface2)', border: '1px solid var(--line)' }}>
        {side('VIP', 'VIP wallet', vipTotal, 'Deposited money')}
        {side('GENERAL', 'General wallet', general.promoBalance,
          general.outstandingTurnover > 0 ? `Bonus · play ₹${fmt(general.outstandingTurnover)} to unlock` : 'Referral bonus')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6, paddingLeft: 4 }}>
        You are playing from your <strong style={{ color: 'var(--text2)' }}>{general.profile === 'VIP' ? 'VIP' : 'General'}</strong> wallet. Tap the other one to switch.
      </div>
      {error && <div role="alert" style={{ fontSize: 11, color: 'var(--red)', marginTop: 4, paddingLeft: 4 }}>{error}</div>}
    </div>
  );
};

export default WalletProfileToggle;
