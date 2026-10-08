// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The board rules a player reads and accepts before betting (owner,
 * 2026-10-08: tell players how the boards work).
 *
 * The text is the server's (`GET /api/v1/board-rules`, owned by
 * `backend/domains/markets/boardRules.js`); the panel keeps no copy of it.
 * The pop-up opens on the board screen when this player has not accepted the
 * current version (`GET /api/user/board-rules`), and again whenever the bet
 * route answers `BOARD_RULES_NOT_ACCEPTED` (GameContext dispatches
 * BOARD_RULES_EVENT). Accepting is `POST /api/user/board-rules/accept`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import apiClient from '../services/apiClient';

export interface BoardRulesText {
  version: number;
  sections: { title: string; body: string }[];
}

/** Fired by GameContext when a bet is refused because the rules are not accepted. */
export const BOARD_RULES_EVENT = 'bb:board-rules-required';

/** The rules text, as the server states it. */
export function useBoardRulesText() {
  const [rules, setRules] = useState<BoardRulesText | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const res: any = await apiClient.get('/api/v1/board-rules');
      if (res?.success) setRules({ version: res.version, sections: res.sections });
      else throw new Error(res?.message);
    } catch (e: any) {
      setError(e?.message || 'Could not load the board rules');
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { rules, error, reload: load };
}

export const BoardRulesSections: React.FC<{ rules: BoardRulesText }> = ({ rules }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    {rules.sections.map((s) => (
      <div key={s.title}>
        <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{s.title}</div>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 3, lineHeight: 1.5 }}>{s.body}</div>
      </div>
    ))}
  </div>
);

/** The pop-up on the board screen. Renders nothing for a signed-out visitor. */
export const BoardRulesModal: React.FC<{ isAuthenticated: boolean }> = ({ isAuthenticated }) => {
  const { rules, error: loadError, reload } = useBoardRulesText();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isAuthenticated) { setOpen(false); return; }
    let live = true;
    apiClient.get('/api/user/board-rules')
      .then((res: any) => { if (live && res?.success && res.acceptedVersion < res.version) setOpen(true); })
      .catch(() => { /* the bet route still asks, and its refusal opens this */ });
    return () => { live = false; };
  }, [isAuthenticated]);

  useEffect(() => {
    const ask = () => { setError(''); reload(); setOpen(true); };
    window.addEventListener(BOARD_RULES_EVENT, ask);
    return () => window.removeEventListener(BOARD_RULES_EVENT, ask);
  }, [reload]);

  if (!open || !isAuthenticated) return null;

  const accept = async () => {
    if (!rules) return;
    setSaving(true);
    setError('');
    try {
      const res: any = await apiClient.post('/api/user/board-rules/accept', { version: rules.version });
      if (!res?.success) throw new Error(res?.message);
      setOpen(false);
    } catch (e: any) {
      // The rules changed while this was open: show the new text to accept.
      if (e?.data?.code === 'BOARD_RULES_CHANGED') reload();
      setError(e?.message || 'Could not save that you accepted the rules');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, background: 'rgba(0,0,0,.6)',
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="board-rules-title" style={{
        width: '100%', maxWidth: 460, maxHeight: '86vh', overflowY: 'auto', padding: 18, borderRadius: 18,
        background: 'var(--bg)', border: '1px solid var(--line2)', boxShadow: 'var(--shadow)',
      }}>
        <h2 id="board-rules-title" className="font-grotesk" style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>
          How the boards work
        </h2>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text3)' }}>
          Please read this before you bet. You can read it again any time on the Rules page.
        </p>
        {rules ? <BoardRulesSections rules={rules} /> : (
          <p role={loadError ? 'alert' : 'status'} style={{ fontSize: 12, color: 'var(--text2)' }}>
            {loadError || 'Loading the rules…'}
          </p>
        )}
        {error && <p role="alert" style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--red)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button onClick={() => setOpen(false)} style={{
            flex: 1, height: 42, borderRadius: 12, cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text2)',
          }}>Not now</button>
          <button onClick={accept} disabled={!rules || saving} style={{
            flex: 2, height: 42, borderRadius: 12, cursor: 'pointer', fontWeight: 800, fontSize: 13, border: 'none',
            background: 'linear-gradient(180deg,var(--gold2),var(--gold))', color: '#1a1200',
            opacity: !rules || saving ? 0.6 : 1,
          }}>{saving ? 'Saving…' : 'I understand and agree'}</button>
        </div>
      </div>
    </div>
  );
};
