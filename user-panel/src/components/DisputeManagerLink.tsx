// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * "Message the Dispute Manager on Telegram", on the player's own DISPUTED order
 * (CLAUDE.md §2, "Support desks"; owner, 2026-10-21).
 *
 * The account is asked for on tap, not with every order list: the server
 * answers only for the caller's own order while it is DISPUTED, and gives the
 * same Dispute Manager for the same order every time.
 */
import React, { useState } from 'react';
import { support } from '../services/api';

export const DisputeManagerLink: React.FC<{ orderId: string }> = ({ orderId }) => {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (busy) return;
    setBusy(true); setNote('');
    try {
      const d = await support.disputeContact(orderId);
      if (d?.contact?.telegramLink) window.open(d.contact.telegramLink, '_blank', 'noopener,noreferrer');
      else setNote('Our Dispute Managers are reviewing it. You will see the decision here.');
    } catch {
      setNote('Our Dispute Managers are reviewing it. You will see the decision here.');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <button onClick={open} disabled={busy} style={{ height: 38, borderRadius: 10, border: 'none', cursor: 'pointer', background: 'var(--bombay)', color: '#fff', fontWeight: 800, fontSize: 12, opacity: busy ? .6 : 1 }}>
        {busy ? 'Opening…' : '✈️ Message the Dispute Manager on Telegram'}
      </button>
      {note && <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center' }}>{note}</div>}
    </div>
  );
};
