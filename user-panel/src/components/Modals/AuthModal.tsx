// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * AuthModal.tsx — the player's way in: one "Continue with Telegram" button.
 *
 * ── What this replaced (owner, 2026-10-14) ─────────────────────────────────
 * A signup form and a login form (mobile, password, confirm, invite), with a
 * Telegram step after them. Signing up and signing in are now the same action:
 * the Mini App's Verify shares the contact once (Telegram's own verified
 * number) and makes the account, or signs into the one already linked. There
 * is no password to type, forget or reset.
 *
 * There is no Aadhaar and no KYC (owner, 2026-10-02): the mobile, proved by a
 * Telegram contact share, is the identity.
 *
 * ── The invite a referral link brought ─────────────────────────────────────
 * It rides with the sign-in and cannot be changed (owner): a code somebody
 * retypes is a code that can be mistyped, and a mistyped code silently costs
 * the referrer their earning. So the screen CONFIRMS it — "Invited by
 * player3210" — and says so plainly when the code is not recognised.
 *
 * ── No bot configured ──────────────────────────────────────────────────────
 * Said plainly: without a Telegram bot nobody can sign in, and the screen says
 * that rather than offering a button that cannot work.
 */
import React, { useEffect, useState } from 'react';
import { storedReferralCode } from '../../services/referralCapture';
import { getBackend } from '../../services/backend.service';
import { useHeaderLogo } from '../../services/brandAssets';
import ContinueWithTelegram from './ContinueWithTelegram';
import type { TelegramSetup } from '../../services/backend.interface';

interface AuthModalProps {
  onClose?: () => void;
}

const NOTE: React.CSSProperties = { margin: 0, textAlign: 'center', fontSize: 12, color: 'var(--text2)', lineHeight: 1.6 };

const AuthModal: React.FC<AuthModalProps> = ({ onClose }) => {
  const [logoFailed, setLogoFailed] = useState(false);
  const logoSrc = useHeaderLogo();

  /** Is Telegram available. `null` while asking; a failed read is "not known", not "no". */
  const [setup, setSetup] = useState<TelegramSetup | null>(null);
  const [setupFailed, setSetupFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    getBackend().getTelegramSetup()
      .then((r) => { if (alive) setSetup(r); })
      .catch(() => { if (alive) setSetupFailed(true); });
    return () => { alive = false; };
  }, []);

  /**
   * Confirm the code the link brought, so a code nobody can edit is not also
   * unexplained. A failure is shown rather than swallowed: a dead code is the
   * referrer's loss and the player is the only person placed to notice.
   */
  const linkedCode = storedReferralCode();
  const [inviteBy, setInviteBy] = useState('');
  const [inviteBad, setInviteBad] = useState(false);
  useEffect(() => {
    if (!linkedCode) return;
    let alive = true;
    getBackend().checkInvite(linkedCode)
      .then((r: { valid: boolean; invitedBy?: string }) => {
        if (!alive) return;
        setInviteBy(r.invitedBy || '');
        setInviteBad(!r.valid);
      })
      .catch(() => { /* the sign-in itself carries it; nothing to confirm */ });
    return () => { alive = false; };
  }, [linkedCode]);

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 200, overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', background: 'var(--app-bg)' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(900px 480px at 50% -6%, var(--glow), transparent 62%)', opacity: .5, pointerEvents: 'none' }} />
      {onClose && (
        <button onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: 16, right: 16, width: 38, height: 38, borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 15, zIndex: 2 }}>✕</button>
      )}

      <div className="bb-rise" style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 400, background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 22, padding: '26px 22px', boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          {!logoFailed
            ? <img src={logoSrc} alt="Betting Bazaar" onError={() => setLogoFailed(true)} style={{ display: 'block', height: 'auto', width: '100%', maxWidth: 240, maxHeight: 52, objectFit: 'contain', filter: 'drop-shadow(0 2px 10px var(--glow))' }} />
            : <span className="font-grotesk bb-gold-text" style={{ color: 'var(--gold-ink)', fontWeight: 700, fontSize: 20, letterSpacing: '.14em' }}>BETTING BAZAAR</span>}
        </div>

        <h1 style={{ margin: '0 0 6px', textAlign: 'center', fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>Sign in or join</h1>
        <p style={{ ...NOTE, marginBottom: 16 }}>One button, no password. Telegram confirms it is you.</p>

        {linkedCode && inviteBy && !inviteBad && (
          <p role="status" style={{ ...NOTE, marginBottom: 12, color: 'var(--gold-ink)' }}>
            Invited by <strong>{inviteBy}</strong>. Applied automatically.
          </p>
        )}
        {linkedCode && inviteBad && (
          <p role="status" style={{ ...NOTE, marginBottom: 12, color: 'var(--red)' }}>
            The invite code in your link ({linkedCode}) is not recognised, so no invite will be applied.
          </p>
        )}

        {setup?.available && <ContinueWithTelegram onDone={() => onClose?.()} />}
        {setup && !setup.available && (
          <div role="alert" style={{ background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 10, padding: 12, textAlign: 'center', fontSize: 12, fontWeight: 700, color: 'var(--text2)', lineHeight: 1.6 }}>
            Sign-in is through Telegram, and Telegram is not set up on this site yet, so nobody can sign in or join right now. Please try again later.
          </div>
        )}
        {!setup && setupFailed && (
          <div role="alert" style={{ background: 'color-mix(in srgb,var(--red) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)', borderRadius: 10, padding: 10, textAlign: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--red)', lineHeight: 1.5 }}>
            Could not reach the site. Check your connection and try again.
          </div>
        )}
        {!setup && !setupFailed && <p role="status" style={NOTE}>Loading…</p>}
      </div>
    </div>
  );
};

export default AuthModal;
