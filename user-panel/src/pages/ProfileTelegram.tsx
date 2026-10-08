// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ProfileTelegram.tsx — the Profile screen's Telegram card (Step 3).
 *
 * What it shows is `GET /api/v1/auth/telegram`, read, never kept: the Telegram
 * account that verified this mobile, when, and whether sign-ins wait for its
 * approval.
 *
 * Two actions, each finished in Telegram rather than here:
 *
 *   · "Move to another Telegram account": opens the Mini App in the NEW
 *     account, whose shared contact must be this account's mobile. There is no
 *     unlink: every account was verified at signup (owner reading, 2026-10-07).
 *   · The approval switch: ON at once; OFF only once the CURRENT Telegram
 *     approves, so a stolen password cannot switch off what would stop it.
 *
 * Both are watched by re-reading the status (`useTelegramPoll`) until the
 * change shows there, so the card says what the server says, not what was
 * tapped.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { getBackend } from '../services/backend.service';
import type { MyTelegram, TelegramBlock } from '../services/backend.interface';
import { useTelegramPoll } from '../components/Modals/TelegramStep';
import { card } from '../redesign/Screen';

type Waiting = { kind: 'relink' | 'off'; telegram: TelegramBlock; since: string | null } | null;

const PILL: React.CSSProperties = {
  padding: '7px 13px', borderRadius: 999, border: '1px solid var(--line2)',
  background: 'var(--surface3)', color: 'var(--gold-ink)', fontSize: 11, fontWeight: 800, cursor: 'pointer',
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '');

const ProfileTelegram: React.FC = () => {
  const [tg, setTg] = useState<MyTelegram | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Waiting>(null);

  const load = useCallback(async () => {
    const next = await getBackend().getMyTelegram();
    setTg(next);
    return next;
  }, []);

  useEffect(() => {
    load().catch((e) => setError((e as Error)?.message || 'Could not read your Telegram link.'));
  }, [load]);

  // Done when the status shows the change: a new `linkedAt`, or approval off.
  const poll = useCallback(async () => {
    if (!waiting) return 'pending' as const;
    const now = await load();
    if (waiting.kind === 'relink') return now.linkedAt !== waiting.since ? 'done' as const : 'pending' as const;
    return now.twoFactor.enabled ? 'pending' as const : 'done' as const;
  }, [waiting, load]);
  useTelegramPoll(waiting ? poll : null, () => setWaiting(null), (m) => { setWaiting(null); setError(m); });

  const relink = async () => {
    setBusy(true); setError('');
    try {
      const r = await getBackend().relinkTelegram();
      setWaiting({ kind: 'relink', telegram: r.telegram, since: tg?.linkedAt ?? null });
    } catch (e) { setError((e as Error)?.message || 'Could not start moving your Telegram account.'); }
    finally { setBusy(false); }
  };

  const toggle = async () => {
    if (!tg) return;
    setBusy(true); setError('');
    try {
      const r = await getBackend().setTelegramTwoFactor(!tg.twoFactor.enabled);
      if (r.approvalRequired && r.telegram) setWaiting({ kind: 'off', telegram: r.telegram, since: null });
      else await load();
    } catch (e) { setError((e as Error)?.message || 'Could not change Telegram approval.'); }
    finally { setBusy(false); }
  };

  return (
    <section aria-labelledby="bb-tg-title" style={{ ...card, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 18 }} aria-hidden="true">✈️</span>
        <h2 id="bb-tg-title" style={{ margin: 0, flex: 1, fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>Telegram</h2>
      </div>

      {error && <p role="alert" style={{ margin: '0 0 8px', fontSize: 11.5, fontWeight: 700, color: 'var(--red)' }}>{error}</p>}

      {tg && (
        <>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--text2)', lineHeight: 1.6 }}>
            {tg.linked
              ? <>Verified with {tg.telegramUsername ? <strong>@{tg.telegramUsername}</strong> : <strong>{tg.firstName || 'your Telegram account'}</strong>}{tg.verifiedAt ? ` on ${when(tg.verifiedAt)}` : ''}.</>
              : 'Your mobile number is not verified in Telegram yet. Sign out and sign in again to finish.'}
          </p>

          {tg.linked && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderTop: '1px solid var(--line)' }}>
              <span id="bb-tg-approval" style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                Approve every sign-in in Telegram
                <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: 'var(--text3)' }}>
                  {tg.twoFactor.enabled ? 'On' : 'Off'}{tg.twoFactor.enabled ? ' — turning it off needs your approval in Telegram' : ''}
                </span>
              </span>
              <button type="button" role="switch" aria-checked={tg.twoFactor.enabled} aria-labelledby="bb-tg-approval"
                onClick={toggle} disabled={busy || !tg.available || Boolean(waiting)} style={PILL}>
                {tg.twoFactor.enabled ? 'Turn off' : 'Turn on'}
              </button>
            </div>
          )}

          {tg.linked && tg.available && (
            <div style={{ paddingTop: 10, borderTop: '1px solid var(--line)' }}>
              <button type="button" onClick={relink} disabled={busy || Boolean(waiting)} style={PILL}>
                Move to another Telegram account
              </button>
            </div>
          )}

          {waiting && (
            <div role="status" style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text2)', lineHeight: 1.6 }}>
              {waiting.kind === 'relink'
                ? 'Open this link in the Telegram account you want to use, and share its contact there.'
                : 'Approve this in Telegram to turn approval off.'}
              {' '}<a href={waiting.telegram.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--gold-ink)', fontWeight: 800 }}>Open Telegram</a>
              {' '}<button type="button" onClick={() => setWaiting(null)} style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: 11.5, cursor: 'pointer', textDecoration: 'underline' }}>Cancel</button>
            </div>
          )}
        </>
      )}
    </section>
  );
};

export default ProfileTelegram;
