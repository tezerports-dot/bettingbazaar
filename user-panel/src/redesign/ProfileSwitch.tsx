// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The header's profile switch: VIP ID (deposited money) or General (referral
 * bonus money), owner 2026-10-08.
 *
 * Everything shown comes from the server (`GET /api/user/general`, owned by
 * `database/repositories/promo.js`): which profile is in use, the General
 * balance, and how much turnover is still needed before the bonus unlocks into
 * withdrawable winnings. Switching is `PUT /api/user/play-profile`; creating a
 * deposit switches to VIP on the server, so the panel only re-reads.
 */
import React, { useCallback, useEffect, useState } from 'react';
import apiClient from '../services/apiClient';
import type { PlayProfile } from '../types';

export type { PlayProfile };

export interface GeneralSummary {
  profile: PlayProfile;
  promoBalance: number;
  outstandingTurnover: number;
  turnoverMultiplier: number;
}

/** The player's profile and General balance, re-read whenever `key` changes. */
export function usePlayProfile(isAuthenticated: boolean, key: string) {
  const [general, setGeneral] = useState<GeneralSummary | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!isAuthenticated) { setGeneral(null); return; }
    try {
      const res: any = await apiClient.get('/api/user/general');
      if (res?.success) setGeneral(res as GeneralSummary);
    } catch { /* the header keeps the last answer; the wallet pill still works */ }
  }, [isAuthenticated]);

  useEffect(() => { load(); }, [load, key]);

  /** Switch profile; true once the server has it. */
  const choose = useCallback(async (profile: PlayProfile): Promise<boolean> => {
    setError('');
    try {
      const res: any = await apiClient.put('/api/user/play-profile', { profile });
      if (!res?.success) throw new Error(res?.message || 'Could not switch profile');
      await load();
      return true;
    } catch (e: any) {
      setError(e?.message || 'Could not switch profile');
      return false;
    }
  }, [load]);

  return { general, choose, error };
}

const LABEL: Record<PlayProfile, string> = { VIP: 'VIP ID', GENERAL: 'General' };

interface Props {
  general: GeneralSummary;
  choose: (p: PlayProfile) => void;
  error: string;
}

export const ProfileSwitch: React.FC<Props> = ({ general, choose, error }) => {
  const [open, setOpen] = useState(false);
  const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const option = (p: PlayProfile, sub: string) => (
    <button
      key={p}
      role="menuitemradio"
      aria-checked={general.profile === p}
      onClick={() => { setOpen(false); if (general.profile !== p) choose(p); }}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, width: '100%',
        padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
        border: `1px solid ${general.profile === p ? 'var(--gold)' : 'var(--line)'}`,
        background: general.profile === p ? 'var(--surface3)' : 'var(--surface)',
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>{LABEL[p]}</span>
      <span style={{ fontSize: 11, color: 'var(--text3)' }}>{sub}</span>
    </button>
  );

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Profile: ${LABEL[general.profile]}. Switch profile`}
        style={{
          height: 34, padding: '0 10px', borderRadius: 999, cursor: 'pointer', fontSize: 11, fontWeight: 800,
          letterSpacing: '.06em', border: '1px solid var(--pill-line)', background: 'var(--pill)',
          color: general.profile === 'VIP' ? 'var(--gold-ink)' : 'var(--green)',
        }}
      >
        {general.profile === 'VIP' ? 'VIP' : 'GEN'} ▾
      </button>
      {open && (
        <div role="menu" style={{
          position: 'absolute', right: 0, top: 40, width: 240, padding: 8, borderRadius: 14, zIndex: 80,
          display: 'flex', flexDirection: 'column', gap: 6,
          background: 'var(--bg)', border: '1px solid var(--line2)', boxShadow: 'var(--shadow)',
        }}>
          {option('VIP', 'Play with deposited money')}
          {option('GENERAL', general.outstandingTurnover > 0
            ? `${rupees(general.promoBalance)} bonus · ${rupees(general.outstandingTurnover)} turnover to unlock`
            : `${rupees(general.promoBalance)} referral bonus balance`)}
          <span style={{ fontSize: 10, color: 'var(--text3)', padding: '2px 4px' }}>
            Each referral bonus unlocks into withdrawable winnings after {general.turnoverMultiplier}× its amount is played.
            VIP and General players never play in the same pools.
          </span>
        </div>
      )}
      {error && <span role="alert" style={{ position: 'absolute', right: 0, top: 40, fontSize: 11, color: 'var(--red, #f87171)' }}>{error}</span>}
    </div>
  );
};
