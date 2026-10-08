// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// "Approve in Telegram": the link the server opened for a challenge, what to
// do there, and what the wait has come to. Used by sign-in, signup and
// "Login with Telegram" (LoginPage) and by the Profile relink. The polling
// itself is `useTelegramPoll`; this only shows it.
import React from 'react';
import { Send } from 'lucide-react';
import type { TelegramLink } from '../types';
import { Spinner } from './ui';

export interface TelegramStepProps {
  title: string;
  /** What to do in Telegram, in the server's words where it gave some. */
  body: string;
  telegram: TelegramLink | null | undefined;
  /** True while the poll is still asking. */
  waiting: boolean;
  /** The server's refusal, shown verbatim. */
  error?: string | null;
  onBack?: () => void;
  backLabel?: string;
}

export const TelegramStep: React.FC<TelegramStepProps> = ({
  title, body, telegram, waiting, error, onBack, backLabel = 'Back to sign in',
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
    <div>
      <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4, color: 'var(--text)' }}>{title}</div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>{body}</div>
    </div>

    {telegram?.url && !error && (
      <a
        href={telegram.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          padding: 13, borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: 'none',
          background: 'var(--brand-bg)', color: 'var(--brand)', border: '1px solid var(--brand)',
        }}
      >
        <Send size={16} />
        Open Telegram{telegram.botUsername ? ` (@${telegram.botUsername})` : ''}
      </a>
    )}

    {waiting && !error && (
      <div role="status" aria-live="polite" style={{
        display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)',
      }}>
        <Spinner />
        Waiting for your approval in Telegram…
      </div>
    )}

    {error && (
      <div role="alert" style={{
        padding: '12px 14px', borderRadius: 12, fontSize: 13, fontWeight: 600, lineHeight: 1.5,
        background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--border)',
      }}>
        {error}
      </div>
    )}

    {onBack && (
      <button type="button" onClick={onBack} style={{
        background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 12, cursor: 'pointer',
      }}>
        {backLabel}
      </button>
    )}
  </div>
);
