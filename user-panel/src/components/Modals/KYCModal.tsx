// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * KYCModal.tsx — where a player stands on verification.
 *
 * The signup FORM takes the Aadhaar number before the account exists (§33),
 * so verification is a precondition of signing up rather than a later step,
 * and checking happens in bulk against the issuing authority. This shows the
 * player where they stand, what it lets them do, and — when the number was
 * REJECTED — takes the corrected one, through `POST /api/v1/auth/kyc/resubmit`.
 *
 * ── The correction form, and why it is here ────────────────────────────────
 * The route, its service and the client method all existed; no screen called
 * the method. A rejected player was told to contact support, with no way to
 * fix a mistyped digit themselves — found by measuring which routes any tier
 * ever reached (`npm run report:routes`): the resubmit route, never. §2 says
 * a rejected Aadhaar may be replaced ON THE PANEL; this is that panel.
 */
import React, { useState } from 'react';
import { useGame } from '../../services/GameContext';
import { getBackend } from '../../services/backend.service';

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
      + 'the signup form asks for it before an account is created.',
    next: 'Please contact support so we can sort it out.',
  },
  REJECTED: {
    tone: 'var(--red)',
    title: 'Verification failed',
    body: 'The Aadhaar number on this account could not be verified.',
    next: 'Enter the correct number below. Each account has a few attempts; if they run out, '
      + 'contact support. Opening a second account will not work — one Aadhaar can hold one account.',
  },
};

const KYCModal: React.FC<KYCModalProps> = ({ onClose }) => {
  const { user, refreshUserWallet } = useGame();
  const status = (user?.kycStatus as Status) || 'PENDING_SUBMISSION';
  const [aadhaar, setAadhaar] = useState('');
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState('');
  const [accepted, setAccepted] = useState('');

  const resubmit = async () => {
    setSending(true); setRefused('');
    try {
      const r = await getBackend().resubmitAadhaar(aadhaar);
      setAccepted(r.message || 'Received. It is queued for verification.');
      setAadhaar('');
      await refreshUserWallet();   // the status moves to "in progress"
    } catch (err) {
      // The server names every refusal (playerAuth.routes.js), so show its words.
      setRefused(err instanceof Error ? err.message : 'Could not submit that number. Please try again.');
    } finally {
      setSending(false);
    }
  };
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

        {status === 'REJECTED' && !accepted && (
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="kyc-resubmit-aadhaar" style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text2)', marginBottom: 6 }}>
              Correct Aadhaar number
            </label>
            <input
              id="kyc-resubmit-aadhaar" inputMode="numeric" autoComplete="off" placeholder="12 digits"
              value={aadhaar}
              // Spaces and dashes as printed on the card are dropped; anything
              // past twelve digits is not an Aadhaar number.
              onChange={(e) => setAadhaar(e.target.value.replace(/\D/g, '').slice(0, 12))}
              style={{ width: '100%', height: 44, borderRadius: 12, border: '1px solid var(--line2)', background: 'var(--surface2)', color: 'var(--text)', padding: '0 12px', fontSize: 15, letterSpacing: '.08em' }}
            />
            {refused && (
              <p role="alert" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--red)', lineHeight: 1.5 }}>{refused}</p>
            )}
            <button
              onClick={resubmit} disabled={aadhaar.length !== 12 || sending}
              style={{ marginTop: 10, width: '100%', height: 44, borderRadius: 12, border: '1px solid var(--line2)', cursor: aadhaar.length === 12 && !sending ? 'pointer' : 'not-allowed', fontWeight: 800, fontSize: 13, color: 'var(--text)', background: 'var(--surface3)', opacity: aadhaar.length === 12 && !sending ? 1 : .55 }}
            >
              {sending ? 'Submitting…' : 'Submit corrected number'}
            </button>
          </div>
        )}

        {accepted && (
          <p role="status" style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--green)', lineHeight: 1.6, textAlign: 'center' }}>{accepted}</p>
        )}

        {copy.next && !accepted && (
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
