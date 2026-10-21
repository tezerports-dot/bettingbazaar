// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Operator sign-in — design handoff "BB Merchant Panel.dc.html". One button,
// "Continue with Telegram" (owner, 2026-10-14): no password, no form. The first
// Verify shares the contact once. A mobile with an account (one an admin made,
// or an approved application) is linked and signed in; a mobile with none sends
// a merchant APPLICATION, which signs in once an admin approves it (owner,
// 2026-10-21: merchants sign up themselves, the admin only reviews). A
// sub-member signs in the same way, with the Telegram on the mobile their
// merchant added.
//
// How the approval comes back is decided per device (`deliveryHere`):
//   HANDOFF  an Android browser: Telegram is on this phone, and Verify opens
//            the panel on it with a one-time ticket (`#/tg/<ticket>`, read and
//            removed at startup by services/telegramTicket.ts, spent here).
//   MATCH    anywhere else: this screen shows a two-digit number, Telegram
//            offers three, Verify counts only with the right one, and this
//            screen gets the session by polling. The link is also a QR.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router';
import { ShieldCheck, CheckCircle, Send } from 'lucide-react';
import { useAuth } from '../services/AuthContext';
import { useTelegramPoll } from '../hooks/useTelegramPoll';
import { api, type TelegramDelivery, type TelegramSignIn } from '../services/api';
import { takeTelegramTicket } from '../services/telegramTicket';
import { APP_CONFIG, ROUTES } from '../constants';
import type { AuthResponse, MiniAppSetup } from '../types';
import { Button, Logo, Spinner } from '../components/ui';
import { TelegramStep } from '../components/TelegramStep';
import { PlatformUnreachable } from '../components/PlatformUnreachable';

/** HANDOFF where Telegram runs on this same device and can open the panel on it; MATCH elsewhere. */
export function deliveryHere(): TelegramDelivery {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Android/i.test(ua) ? 'HANDOFF' : 'MATCH';
}

/** The finished-but-not-signed-in screen: an account an admin has not activated. */
interface Notice { title: string; body: string; }

/** The body `request()` attaches to a refusal. */
type Refusal = { status?: number; message?: string; data?: { code?: string; message?: string } };

const refusalText = (err: unknown, fallback: string): string => {
  const e = err as Refusal;
  return (typeof e?.data?.message === 'string' && e.data.message) || e?.message || fallback;
};

/** An account an admin has not approved or has suspended: a state to explain, not a failure. */
const isWaitingApplication = (err: unknown): boolean => {
  const e = err as Refusal;
  return e?.status === 403 && e.data?.code === 'MERCHANT_NOT_ACTIVE';
};

const LoginPage: React.FC = () => {
  const { merchant, loading: authLoading, acceptSession, unreachable, refreshProfile } = useAuth();

  // Why the panel just signed this merchant out — a suspension, a session
  // ended elsewhere — in the server's words (§32 S48). Read once per page load.
  const [signedOutReason] = useState(() => api.signedOutReason());

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [starting, setStarting] = useState(false);

  /** A refusal that may be an account not active yet: said as such. */
  const refused = useCallback((err: unknown, fallback: string) => {
    if (isWaitingApplication(err)) {
      setNotice({ title: 'Account not active yet', body: refusalText(err, 'Your account is waiting for an admin to activate it.') });
      return;
    }
    setError(refusalText(err, fallback));
  }, []);

  // ── Is Telegram set up ────────────────────────────────────────────────────
  const [setup, setSetup] = useState<MiniAppSetup | null>(null);
  const [setupFailed, setSetupFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.getMiniAppSetup()
      .then((s) => { if (live) setSetup(s); })
      .catch(() => { if (live) setSetupFailed(true); });
    return () => { live = false; };
  }, []);

  // ── The ticket Verify opened this panel with, spent once ─────────────────
  const [redeeming, setRedeeming] = useState(false);
  const ticketTaken = useRef(false);
  useEffect(() => {
    if (ticketTaken.current) return;
    ticketTaken.current = true;
    const ticket = takeTelegramTicket();
    if (ticket === null) return;
    if (!ticket) {
      setError('This sign-in link is not valid. Press Continue with Telegram again.');
      return;
    }
    setRedeeming(true);
    api.redeemTelegramTicket(ticket)
      .then((session) => acceptSession(session))
      .catch((err) => refused(err, 'This sign-in link has already been used or has expired. Press Continue with Telegram again.'))
      .finally(() => setRedeeming(false));
  }, [acceptSession, refused]);

  // ── Waiting on Telegram ───────────────────────────────────────────────────
  const [wait, setWait] = useState<TelegramSignIn | null>(null);
  const [waitError, setWaitError] = useState<string | null>(null);
  const [handedOff, setHandedOff] = useState<string | null>(null);
  const endWait = useCallback(() => { setWait(null); setWaitError(null); setHandedOff(null); }, []);

  const token = wait?.challengeToken ?? null;
  const poll = useMemo(
    () => (token && !waitError && !handedOff ? () => api.pollTelegramSignIn(token) : null),
    [token, waitError, handedOff],
  );
  useTelegramPoll<AuthResponse | 'handedOff'>(poll, {
    onDone: (answer) => {
      if (answer === 'handedOff') {
        setHandedOff('Verified in Telegram. You are signed in where Telegram opened the panel; you can close this page.');
        return;
      }
      endWait();
      acceptSession(answer);
    },
    onError: (err) => {
      if (isWaitingApplication(err)) { endWait(); refused(err, ''); return; }
      setWaitError(refusalText(err, 'Telegram sign-in failed. Please try again.'));
    },
  });

  if (!authLoading && merchant) return <Navigate to={ROUTES.DASHBOARD} replace />;
  /**
   * `ROUTES.LOGIN` is `/`, and it is the path a merchant lands on — so this
   * screen, not `ProtectedRoute`, is where a held session with no profile
   * behind it is actually seen.
   */
  if (!authLoading && !merchant && unreachable) {
    return <PlatformUnreachable onRetry={refreshProfile} />;
  }

  const handleContinue = async () => {
    setStarting(true);
    setError(null);
    try {
      const opened = await api.startTelegramSignIn(deliveryHere());
      setWaitError(null);
      setHandedOff(null);
      setWait(opened);
    } catch (err) {
      setError(refusalText(err, 'Telegram sign-in is not available right now.'));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      padding: '32px 22px', background: 'linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%)',
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: 26 }}>
          <Logo size={56} radius={16} />
          <h1 style={{ margin: '18px 0 4px', fontSize: 23, fontWeight: 800, letterSpacing: '-.5px', color: 'var(--text)' }}>
            BB Token
          </h1>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--text-2)' }}>Merchant Panel</p>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, padding: '6px 12px',
            background: 'var(--dep-bg)', borderRadius: 20,
          }}>
            <ShieldCheck size={13} style={{ color: 'var(--dep)' }} />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--dep)' }}>Secure operator sign-in</span>
          </div>
        </div>

        {signedOutReason && (
          <div role="alert" style={{
            marginBottom: 16, padding: '12px 14px', borderRadius: 12, fontSize: 13.5, fontWeight: 600, lineHeight: 1.5,
            background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--border)',
          }}>
            You were signed out: {signedOutReason}
          </div>
        )}

        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20,
          boxShadow: 'var(--shadow)', overflow: 'hidden',
        }}>
          <div style={{ padding: '22px 22px 24px' }}>
            {redeeming ? (
              <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>
                <Spinner /> Signing you in…
              </div>
            ) : wait ? (
              <TelegramStep
                title="Continue in Telegram"
                body={handedOff
                  || (wait.delivery === 'MATCH'
                    ? 'Open Telegram, choose the number shown here, and press Verify.'
                    : 'Open Telegram and press Verify. It brings you back here signed in.')}
                telegram={handedOff ? null : wait.telegram}
                matchNumber={handedOff || wait.delivery !== 'MATCH' ? null : wait.matchNumber}
                waiting={!waitError && !handedOff}
                error={waitError}
                onBack={endWait}
              />
            ) : notice ? (
              <div style={{ textAlign: 'center', padding: '14px 0' }}>
                <CheckCircle size={44} style={{ color: 'var(--ok)' }} />
                <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', margin: '12px 0 6px' }}>
                  {notice.title}
                </div>
                <p role="status" style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 18px' }}>
                  {notice.body}
                </p>
                <Button variant="outline" tone="neutral" full onClick={() => setNotice(null)} style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
                  Back to sign in
                </Button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {error && (
                  <div role="alert" style={{
                    padding: '10px 12px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, lineHeight: 1.5,
                    background: 'var(--danger-bg)', color: 'var(--danger)',
                  }}>
                    {error}
                  </div>
                )}
                {setup?.available ? (
                  <>
                    <Button full busy={starting} onClick={handleContinue} style={{ padding: 13, fontSize: 14, borderRadius: 12 }}>
                      <Send size={15} /> Continue with Telegram
                    </Button>
                    <p style={{ margin: 0, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
                      New here? Continue with Telegram and share your contact to apply. An admin reviews
                      your application, and you can sign in as soon as it is approved. Sub-members: use
                      the Telegram on the mobile your merchant added.
                    </p>
                  </>
                ) : setup ? (
                  <div role="alert" style={{
                    padding: '12px 14px', borderRadius: 12, fontSize: 13, fontWeight: 600, lineHeight: 1.5,
                    background: 'var(--warn-bg)', color: 'var(--warn)', border: '1px solid var(--warn)',
                  }}>
                    Sign-in is through Telegram, and Telegram is not set up on this platform yet, so nobody can
                    sign in right now. Contact your operations admin.
                  </div>
                ) : setupFailed ? (
                  <div role="alert" style={{
                    padding: '10px 12px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, lineHeight: 1.5,
                    background: 'var(--danger-bg)', color: 'var(--danger)',
                  }}>
                    Could not reach the platform. Check your connection and try again.
                  </div>
                ) : (
                  <Spinner />
                )}
                <p style={{ margin: 0, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
                  Trouble signing in? Contact your operations admin.
                </p>
              </div>
            )}
          </div>
        </div>

        <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', marginTop: 18, lineHeight: 1.6 }}>
          Authorised payment operators only. All activity is logged and monitored for compliance.
          {/* VITE_APP_VERSION is injected from package.json at build time (L-03);
              a dev build without it falls back to '—', which is worth omitting
              rather than printing as "v—". */}
          {APP_CONFIG.VERSION !== '—' && (
            <>
              <br />
              <span className="bb-mono">v{APP_CONFIG.VERSION}</span>
            </>
          )}
        </p>
      </div>

      {authLoading && (
        <div style={{ marginTop: 20 }}>
          <Spinner />
        </div>
      )}
    </div>
  );
};

export default LoginPage;
