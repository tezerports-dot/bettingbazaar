// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Profile → Telegram: the account this merchant's sign-ins are approved from
// (GET /api/merchant/telegram), and moving it to another Telegram account
// (POST /api/merchant/telegram/relink, approved there, then GET polled until
// `linkedAt` moves). There is no switch: Telegram approval of every merchant
// sign-in is mandatory (the link's CHECK, backend accountTelegram.js).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import type { TelegramLink, TelegramStatus } from '../types';
import { useTelegramPoll } from '../hooks/useTelegramPoll';
import { TelegramStep } from './TelegramStep';
import { Banner, Button, Card, CardTitle } from './ui';

/** How long the relink waits for the new account's approval (UI only, §11). */
const RELINK_WAIT_MS = 5 * 60 * 1000;

const when = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{
    display: 'flex', justifyContent: 'space-between', gap: 10, padding: '11px 14px',
    background: 'var(--surface-2)', borderRadius: 12,
  }}>
    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{label}</span>
    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', textAlign: 'right', overflowWrap: 'anywhere' }}>{value}</span>
  </div>
);

export const TelegramCard: React.FC = () => {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [relink, setRelink] = useState<{ telegram: TelegramLink | null; message: string; from: string | null } | null>(null);
  const [relinkError, setRelinkError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [moved, setMoved] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.getTelegramStatus());
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error)?.message || 'Could not read your Telegram link.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const startRelink = async () => {
    setStarting(true);
    setRelinkError(null);
    setMoved(false);
    try {
      const opened = await api.relinkTelegram();
      setRelink({ telegram: opened.telegram, message: opened.message || '', from: status?.linkedAt ?? null });
    } catch (err) {
      setRelinkError((err as Error)?.message || 'Could not start moving your Telegram account.');
    } finally {
      setStarting(false);
    }
  };

  const poll = useMemo(() => {
    if (!relink || relinkError) return null;
    const since = relink.from;
    return async () => {
      const next = await api.getTelegramStatus();
      return next.linkedAt && next.linkedAt !== since ? next : null;
    };
  }, [relink, relinkError]);
  useTelegramPoll<TelegramStatus>(poll, {
    maxMs: RELINK_WAIT_MS,
    onDone: (next) => { setStatus(next); setRelink(null); setMoved(true); },
    onError: (err) => setRelinkError((err as Error)?.message || 'Could not read your Telegram link.'),
    onTimeout: () => setRelinkError('No approval arrived from Telegram. Start again when you are ready.'),
  });

  return (
    <Card>
      <CardTitle title="Telegram" sub="Every sign-in to this panel is approved in Telegram" />
      {loadError && (
        <div role="alert" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--danger)', marginBottom: 10 }}>{loadError}</div>
      )}
      {status && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <Row
            label="Linked account"
            value={status.linked
              ? (status.telegramUsername ? `@${status.telegramUsername}` : status.firstName || 'Linked')
              : 'Not linked'}
          />
          <Row label="Verified" value={when(status.verifiedAt)} />
          <Row label="Telegram approval" value="Required" />
          {moved && (
            <div role="status">
              <Banner tone="ok" title="Telegram account moved">Your sign-ins are now approved from this account.</Banner>
            </div>
          )}
          {!status.available && (
            <Banner tone="warn">Telegram is not set up on the platform yet. Contact your operations admin.</Banner>
          )}
          {relink ? (
            <TelegramStep
              title="Move to another Telegram account"
              body={relink.message || 'Open the link in the Telegram account you want to use, and share its contact there.'}
              telegram={relink.telegram}
              waiting={!relinkError}
              error={relinkError}
              onBack={() => { setRelink(null); setRelinkError(null); }}
              backLabel="Cancel"
            />
          ) : (
            <>
              {relinkError && (
                <div role="alert" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--danger)' }}>{relinkError}</div>
              )}
              {status.available && status.linked && (
                <Button variant="outline" full busy={starting} onClick={startRelink}>
                  Move to another Telegram account
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
};

export default TelegramCard;
