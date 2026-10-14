// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// "Continue with Telegram", waiting: the link the server opened, what to do
// there, and what the wait has come to (LoginPage). A MATCH shows the number
// to choose in Telegram and, on a wide screen, the link as a QR for the phone
// to scan. The polling itself is `useTelegramPoll`; this only shows it.
import React, { useMemo } from 'react';
import QRCode from 'qrcode';
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
  /** A MATCH sign-in: the number the merchant chooses in Telegram. */
  matchNumber?: number | null;
}

/** The QR's dark modules as one SVG path. */
function qrPath(link: string): { size: number; d: string } | null {
  try {
    const { modules } = QRCode.create(link, { errorCorrectionLevel: 'M' });
    let d = '';
    for (let row = 0; row < modules.size; row += 1) {
      for (let col = 0; col < modules.size; col += 1) {
        if (modules.get(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { size: modules.size, d };
  } catch {
    return null;
  }
}

/** The Telegram link as a QR, black on white for any scanner (§11: a scanner's contrast). */
const LinkQr: React.FC<{ link: string }> = ({ link }) => {
  const qr = useMemo(() => qrPath(link), [link]);
  if (!qr) return null;
  const box = qr.size + 8;
  return (
    <svg role="img" aria-label="QR code that opens Telegram" viewBox={`-4 -4 ${box} ${box}`}
      width={168} height={168} shapeRendering="crispEdges"
      style={{ display: 'block', margin: '0 auto', background: 'white', borderRadius: 8 }}>
      <path d={qr.d} fill="black" />
    </svg>
  );
};

export const TelegramStep: React.FC<TelegramStepProps> = ({
  title, body, telegram, waiting, error, onBack, backLabel = 'Back to sign in', matchNumber,
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
    <div>
      <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4, color: 'var(--text)' }}>{title}</div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>{body}</div>
    </div>

    {typeof matchNumber === 'number' && !error && (
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', fontWeight: 600 }}>In Telegram, choose this number and press Verify:</div>
        <div data-testid="match-number" style={{ fontSize: 44, fontWeight: 900, letterSpacing: '.08em', color: 'var(--brand)' }}>{matchNumber}</div>
      </div>
    )}

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

    {telegram?.url && !error && typeof matchNumber === 'number' && (
      <>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', textAlign: 'center' }}>Or scan this with your phone&apos;s camera:</div>
        <LinkQr link={telegram.url} />
      </>
    )}

    {waiting && !error && (
      <div role="status" aria-live="polite" style={{
        display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)',
      }}>
        <Spinner />
        Waiting for Telegram… this page continues on its own.
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
