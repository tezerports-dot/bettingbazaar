// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * KYCModal.tsx — where a player stands on verification.
 *
 * There is nothing to submit here any more. This used to take a name, an
 * Aadhaar number, a photograph of the card and a selfie, presign two uploads
 * into a private bucket and queue the lot for a human reviewer. All of that is
 * gone: the Telegram bot asks for the Aadhaar NUMBER before the account exists,
 * so verification is a precondition of signing up rather than a later step, and
 * checking happens in bulk against the issuing authority.
 *
 * What is left is the half that still matters to the player — what their status
 * is, what it lets them do, and what to do about it if it went wrong. Showing
 * a form nobody can submit would be worse than showing nothing.
 */
import React from 'react';
import { useGame } from '../../services/GameContext';

interface KYCModalProps { onClose: () => void; }

type Status = 'APPROVED' | 'PENDING_APPROVAL' | 'REJECTED' | 'PENDING_SUBMISSION';

const COPY: Record<Status, { tone: string; title: string; body: string; next?: string }> = {
  APPROVED: {
    tone: 'var(--green)',
    title: 'Verified',
    body: 'Your Aadhaar has been verified. Withdrawals and token sales are open to you.',
  },
  PENDING_APPROVAL: {
    tone: '#FB8C00',
    title: 'Verification in progress',
    body: 'We have your Aadhaar and it is being checked. This usually finishes within a day.',
    next: 'You can play and deposit while you wait. Withdrawals open once it clears.',
  },
  PENDING_SUBMISSION: {
    tone: '#FB8C00',
    title: 'Not started',
    body: 'We do not have an Aadhaar number on file for this account, which is unusual — '
      + 'the bot asks for it before an account is created.',
    next: 'Please contact support so we can sort it out.',
  },
  REJECTED: {
    tone: 'var(--red)',
    title: 'Verification failed',
    body: 'The Aadhaar number on this account could not be verified.',
    next: 'Contact support with the correct number to hand. It is the fastest way to fix this, '
      + 'and opening a second account will not work — one Aadhaar can hold one account.',
  },
};

const KYCModal: React.FC<KYCModalProps> = ({ onClose }) => {
  const { user } = useGame();
  const status = (user?.kycStatus as Status) || 'PENDING_SUBMISSION';
  const copy = COPY[status] || COPY.PENDING_SUBMISSION;
  const reason = (user as any)?.kycData?.rejectionReason || '';

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 200, overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', background: 'var(--app-bg)' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(900px 480px at 50% -6%, var(--glow), transparent 62%)', opacity: .45, pointerEvents: 'none' }} />
      <button onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: 16, right: 16, width: 38, height: 38, borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 15, zIndex: 2 }}>✕</button>

      <div className="bb-rise" style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 400, background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 22, padding: '26px 22px', boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          <span style={{ width: 52, height: 52, borderRadius: 15, background: `color-mix(in srgb,${copy.tone} 14%,var(--surface3))`, border: '1px solid var(--line2)', display: 'grid', placeItems: 'center', fontSize: 24 }}>🪪</span>
        </div>

        <p style={{ margin: '0 0 4px', textAlign: 'center', fontSize: 11, fontWeight: 800, letterSpacing: '.2em', textTransform: 'uppercase', color: copy.tone }}>
          {copy.title}
        </p>
        <p style={{ margin: '0 0 16px', textAlign: 'center', fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
          {copy.body}
        </p>

        {reason && (
          <div style={{ background: 'color-mix(in srgb,var(--red) 10%,transparent)', border: '1px solid color-mix(in srgb,var(--red) 35%,transparent)', borderRadius: 12, padding: '11px 13px', marginBottom: 14 }}>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--red)', marginBottom: 4 }}>Reason given</div>
            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.5 }}>{reason}</div>
          </div>
        )}

        {copy.next && (
          <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--text3)', lineHeight: 1.6, textAlign: 'center' }}>
            {copy.next}
          </p>
        )}

        <button
          onClick={onClose}
          style={{ width: '100%', height: 46, borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 13, letterSpacing: '.06em', color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))' }}
        >
          GOT IT
        </button>
      </div>
    </div>
  );
};

export default KYCModal;
