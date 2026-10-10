// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * "Play with your bonus" — the Wallet's and the Referral page's way into the
 * General profile (owner, 2026-10-10).
 *
 * The profile switch lives only in the header pill (`ProfileSwitch`), so a
 * player whose only money is a referral bonus saw a ₹0 wallet and nothing
 * saying the bonus was playable. This card appears while they are on VIP with
 * a General balance above zero; its button makes the same
 * `PUT /api/user/play-profile` the pill does and takes them to the board,
 * where the header re-reads the profile (it keys on the route).
 *
 * Every figure is the server's (`GET /api/user/general`, `promo.js`).
 */
import React, { useState } from 'react';
import { usePlayProfile } from './ProfileSwitch';
import { card } from './Screen';
import { fmt } from './format';

const BonusPlayPrompt: React.FC = () => {
  // Mounted only on signed-in screens (Wallet, Referral); signed out, the
  // read answers 401 and the card simply stays away.
  const { general, choose, error } = usePlayProfile(true, 'bonus-prompt');
  const [busy, setBusy] = useState(false);

  if (!general || general.profile !== 'VIP' || !(general.promoBalance > 0)) return null;

  const play = async () => {
    setBusy(true);
    const switched = await choose('GENERAL');
    setBusy(false);
    if (!switched) return;
    // The app runs on a HashRouter; the board is its root.
    window.location.hash = '#/';
  };

  return (
    <div style={{ ...card, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12, border: '1px solid color-mix(in srgb,var(--green) 40%,transparent)', background: 'color-mix(in srgb,var(--green) 8%,var(--surface))' }}>
      <span aria-hidden="true" style={{ fontSize: 26, flex: 'none' }}>🎁</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>₹{fmt(general.promoBalance)} referral bonus ready to play</div>
        <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.5, marginTop: 2 }}>
          {general.outstandingTurnover > 0
            ? `Play ₹${fmt(general.outstandingTurnover)} more and it unlocks into withdrawable winnings.`
            : 'Played with, it unlocks into withdrawable winnings.'}
        </div>
        {error && <div role="alert" style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{error}</div>}
      </div>
      <button type="button" onClick={() => { void play(); }} disabled={busy} style={{ flex: 'none', padding: '10px 14px', borderRadius: 12, border: 'none', cursor: busy ? 'wait' : 'pointer', fontSize: 12, fontWeight: 800, color: '#06210f', background: 'linear-gradient(180deg,color-mix(in srgb,var(--green) 70%,#fff),var(--green))', opacity: busy ? 0.6 : 1 }}>
        Play with your bonus
      </button>
    </div>
  );
};

export default BonusPlayPrompt;
