// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * MyTelegram.tsx — the signed-in staff account's own Telegram link.
 *
 * Every staff account, of any role, may see and move its own link (the server
 * mounts it with `authenticateStaff` and no area), so this is its own screen
 * rather than a card on Telegram setup, which only `canManageTelegram` opens.
 *
 * Server: `GET /api/admin/account/telegram`, `POST …/relink`
 * (backend/domains/identity/accountTelegram.js). A relink is approved in the
 * Mini App from the NEW Telegram account by sharing its contact; this screen
 * opens the link and polls GET until `linkedAt` moves.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Send, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { type MyTelegram as MyTelegramView, type TelegramBlock } from '../../services/api';
import { formatters } from '../../utils/formatters';
import { useTelegramPoll, isRefusal, refusalText, type PollStep } from '../../hooks/useTelegramPoll';

const alertStyle: React.CSSProperties = {
  padding: '12px 14px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, lineHeight: 1.5,
  background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--border)',
};

/** One labelled line. Module level (§32 S23). */
const Row: React.FC<{ name: string; children: React.ReactNode }> = ({ name, children }) => (
  <div style={{ display: 'flex', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
    <div style={{ width: 170, flex: 'none', color: 'var(--muted)', fontWeight: 600 }}>{name}</div>
    <div style={{ fontWeight: 700 }}>{children}</div>
  </div>
);

export const MyTelegram: React.FC = () => {
  const [view, setView] = useState<MyTelegramView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ telegram: TelegramBlock; fromLinkedAt: string | null } | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api.telegram.myTelegram());
      setError(null);
    } catch (err) {
      setError(refusalText(err, 'Could not read your Telegram link.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const startMove = async () => {
    setStarting(true);
    setError(null);
    try {
      const opened = await api.telegram.relink();
      setMoving({ telegram: opened.telegram, fromLinkedAt: view?.linkedAt ?? null });
    } catch (err) {
      setError(refusalText(err, 'Could not start moving your Telegram account.'));
    } finally {
      setStarting(false);
    }
  };

  // Poll GET until the link moves (one loop, `useTelegramPoll`).
  const ask = useCallback(async (live: () => boolean): Promise<PollStep> => {
    if (!moving) return 'stop';
    try {
      const next = await api.telegram.myTelegram();
      if (!live()) return 'stop';
      if (next.linkedAt && next.linkedAt !== moving.fromLinkedAt) {
        setView(next);
        setMoving(null);
        toast.success(next.telegramUsername ? `Moved to @${next.telegramUsername}.` : 'Your Telegram account was moved.');
        return 'stop';
      }
      return 'again';
    } catch (err) {
      if (!isRefusal(err)) throw err;
      if (live()) { setError(refusalText(err, 'Could not read your Telegram link.')); setMoving(null); }
      return 'stop';
    }
  }, [moving]);
  useTelegramPoll(ask, moving !== null);

  return (
    <div className="om-fade" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
      {error && <div role="alert" style={alertStyle}>{error}</div>}

      {!view && !error && (
        <div role="status" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
      )}

      {view && (
        <div className="card" style={{ padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <Send size={18} style={{ color: 'var(--gold-ink)' }} />
            <div style={{ fontSize: 15, fontWeight: 800 }}>My Telegram</div>
          </div>

          {!view.available && (
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
              Telegram is not set up on this platform yet, so there is nothing to link. A bot is saved
              on the Telegram setup screen.
            </div>
          )}

          <Row name="Linked account">
            {view.linked
              ? (view.telegramUsername ? `@${view.telegramUsername}` : (view.firstName || 'Linked'))
              : 'Not linked'}
          </Row>
          <Row name="Verified">{view.verifiedAt ? formatters.datetime(view.verifiedAt) : '—'}</Row>
          <Row name="Linked since">{view.linkedAt ? formatters.datetime(view.linkedAt) : '—'}</Row>
          <Row name="Telegram approval">
            {view.twoFactor?.required ? 'Required for every sign-in' : (view.twoFactor?.enabled ? 'On' : 'Off')}
          </Row>

          {view.available && view.linked && !moving && (
            <button
              type="button"
              className="btn"
              onClick={startMove}
              disabled={starting}
              style={{ marginTop: 16, opacity: starting ? 0.6 : 1 }}
            >
              {starting ? 'Opening…' : 'Move to another Telegram account'}
            </button>
          )}

          {moving && (
            <div style={{ marginTop: 16, padding: 16, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 12 }}>
                Open the link in the Telegram account you want to use, and share its contact there.
                Its number must be this account's mobile.
              </div>
              <a
                href={moving.telegram.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}
              >
                <Send size={15} /> Open Telegram{moving.telegram.botUsername ? ` (@${moving.telegram.botUsername})` : ''}
              </a>
              <div role="status" aria-live="polite" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
                Waiting for the new account to confirm…
              </div>
              <button
                type="button"
                onClick={() => setMoving(null)}
                style={{ marginTop: 8, background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 12, cursor: 'pointer', padding: 0 }}
              >
                Cancel
              </button>
            </div>
          )}

          {view.linked && !moving && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, fontSize: 11.5, color: 'var(--muted)' }}>
              <CheckCircle2 size={13} /> Every sign-in to this panel is approved in this Telegram account.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
