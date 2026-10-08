// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * MiniApp.tsx — the page Telegram opens from the one bot (Step 3).
 *
 * What it shows is decided by the server from the `start_param` Telegram signed
 * into `initData` (`/api/telegram/mini-app/context`), never by anything this
 * page could alter:
 *
 *   VERIFY, RELINK            share your contact (it must be the account's mobile)
 *   LOGIN, TELEGRAM_LOGIN,    approve or deny a sign-in, showing where and when
 *   TWO_FACTOR_OFF            it was asked for; a contact only when the server
 *                             says this Telegram account is not the linked one
 *   RESET                     share your contact, then open the reset link
 *   SIGNUP                    a player's signup, the referral code locked
 *   NONE                      opened plainly: log in, sign up, or reset
 *
 * Everything is the server's sentence. A screen that phrased its own refusals
 * would phrase CONTACT_MISMATCH as "error" to somebody whose Telegram is on
 * another number, who then cannot act on it (§32 S14).
 */
import React, { useEffect, useState } from 'react';
import { miniApi, shareContact, MiniAppRefusal, type MiniAppContext, type Panel, type WebApp } from './miniAppApi';

const PANEL_WORD: Record<Panel, string> = { PLAYER: 'player', STAFF: 'staff', MERCHANT: 'merchant' };

const PAGE: React.CSSProperties = {
  minHeight: '100vh', boxSizing: 'border-box', padding: '20px 16px',
  background: 'var(--tg-theme-bg-color, Canvas)', color: 'var(--tg-theme-text-color, CanvasText)',
  fontFamily: 'system-ui, sans-serif', fontSize: 15, lineHeight: 1.5,
};
const PRIMARY: React.CSSProperties = {
  width: '100%', height: 48, border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700,
  background: 'var(--tg-theme-button-color, Highlight)', color: 'var(--tg-theme-button-text-color, HighlightText)',
  cursor: 'pointer', marginTop: 10,
};
const SECONDARY: React.CSSProperties = {
  ...PRIMARY, background: 'var(--tg-theme-secondary-bg-color, ButtonFace)', color: 'var(--tg-theme-text-color, ButtonText)',
};
const INPUT: React.CSSProperties = {
  width: '100%', height: 44, boxSizing: 'border-box', borderRadius: 10, padding: '0 12px', fontSize: 15,
  border: '1px solid var(--tg-theme-hint-color, GrayText)', background: 'var(--tg-theme-secondary-bg-color, Field)',
  color: 'var(--tg-theme-text-color, FieldText)',
};
const HINT: React.CSSProperties = { color: 'var(--tg-theme-hint-color, GrayText)', fontSize: 13 };

/** A labelled password field, at module level so typing keeps the caret (§32 S23). */
const PasswordField: React.FC<{ id: string; label: string; value: string; onChange: (v: string) => void }> =
  ({ id, label, value, onChange }) => (
    <div style={{ marginTop: 12 }}>
      <label htmlFor={id} style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>{label}</label>
      <input id={id} type="password" autoComplete="new-password" value={value}
        onChange={(e) => onChange(e.target.value)} style={INPUT} />
    </div>
  );

/** After a signup or a Login with Telegram: the session, kept as the app keeps it, then the app. */
function enterApp(token: string) {
  try { localStorage.setItem('auth_token', token); } catch { /* the app will ask them to sign in */ }
  window.location.href = '/';
}

const MiniApp: React.FC<{ app: WebApp | null }> = ({ app }) => {
  const [ctx, setCtx] = useState<MiniAppContext | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'home' | 'signup' | 'reset'>('home');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [invite, setInvite] = useState('');
  const [resetUrl, setResetUrl] = useState('');

  const initData = app?.initData || '';

  useEffect(() => {
    if (!app || !initData) return;
    app.ready(); app.expand();
    miniApi.context(initData)
      .then((c) => {
        setCtx(c);
        if (c.start.kind === 'SIGNUP') { setMode('signup'); setInvite(c.start.referral?.code || ''); }
        if (c.start.kind === 'RESET') setMode('reset');
      })
      .catch((e) => setError((e as Error).message));
  }, [app, initData]);

  /** Run one action; its refusal is shown as the server worded it. */
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) {
      setError(e instanceof MiniAppRefusal || e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally { setBusy(false); }
  };

  /** The contact, or a refusal the person can act on. */
  const contact = async () => {
    const c = await shareContact(app!);
    if (!c) throw new Error('Share your contact to continue. Telegram sends only your number, and only once.');
    return c;
  };

  const answer = (decision: 'approve' | 'deny') => act(async () => {
    const withContact = decision === 'approve' && ctx?.start.needsContact ? await contact() : null;
    const r = await miniApi.approve(initData, decision, withContact);
    // Staff security alerts come from the bot, which may write only to people
    // who allowed it. Asked once, after an approval, when it is wanted.
    if (r.approved && r.panel === 'STAFF') app?.requestWriteAccess?.(() => { /* either answer is fine */ });
    setDone(r.message);
  });

  const signup = () => act(async () => {
    const c = await contact();
    const r = await miniApi.signup(initData, { contact: c, password, confirmPassword: confirm, referralCode: invite || undefined });
    enterApp(r.token);
  });

  const reset = (panel?: Panel) => act(async () => {
    const c = await contact();
    const r = await miniApi.passwordReset(initData, c, panel);
    setResetUrl(r.resetUrl);
    setDone(r.message);
  });

  const login = () => act(async () => { enterApp((await miniApi.playerLogin(initData)).token); });

  if (!app || !initData) {
    return <main style={PAGE}><p role="alert">Open this page from Telegram. It works only inside the Telegram app.</p></main>;
  }

  const start = ctx?.start;
  const fresh = start && (!start.state || start.state === 'PENDING');

  return (
    <main style={PAGE}>
      <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>Betting Bazaar</h1>
      {error && <p role="alert" style={{ color: 'var(--tg-theme-destructive-text-color, MarkText)', fontWeight: 600 }}>{error}</p>}
      {!ctx && !error && <p aria-busy="true" style={HINT}>Loading…</p>}

      {done && (
        <div role="status">
          <p>{done}</p>
          {resetUrl && <button type="button" style={PRIMARY} onClick={() => app.openLink(resetUrl)}>Choose a new password</button>}
          <button type="button" style={SECONDARY} onClick={() => app.close()}>Close</button>
        </div>
      )}

      {ctx && !done && start && (
        <>
          {/* ── A challenge: verify, relink, approve ─────────────────────── */}
          {['VERIFY', 'RELINK', 'LOGIN', 'TELEGRAM_LOGIN', 'TWO_FACTOR_OFF'].includes(start.kind) && (
            fresh ? (
              <section>
                <p>
                  {start.kind === 'VERIFY' && <>Verify the mobile number of your {PANEL_WORD[start.panel!]} account{start.mobileHint ? ` (${start.mobileHint})` : ''}. Share your Telegram contact; its number must be the same.</>}
                  {start.kind === 'RELINK' && <>Move your {PANEL_WORD[start.panel!]} account to this Telegram account. Share this account&apos;s contact; its number must be the account&apos;s mobile{start.mobileHint ? ` (${start.mobileHint})` : ''}.</>}
                  {start.kind === 'LOGIN' && <>Someone is signing in to your {PANEL_WORD[start.panel!]} account{start.mobileHint ? ` (${start.mobileHint})` : ''}. Approve only if it is you.</>}
                  {start.kind === 'TELEGRAM_LOGIN' && <>Log in to your {PANEL_WORD[start.panel!]} account with Telegram. Approve only if you just asked for this.</>}
                  {start.kind === 'TWO_FACTOR_OFF' && <>Turn off Telegram approval of sign-ins for your account{start.mobileHint ? ` (${start.mobileHint})` : ''}. Approve only if it is you.</>}
                </p>
                {start.request && (
                  <p style={HINT}>Asked {new Date(start.request.at).toLocaleString()} from {start.request.ip || 'an unknown address'}{start.request.device ? ` · ${start.request.device}` : ''}</p>
                )}
                <button type="button" style={PRIMARY} disabled={busy} onClick={() => answer('approve')}>
                  {start.needsContact ? 'Share contact and approve' : 'Approve'}
                </button>
                {start.kind !== 'VERIFY' && start.kind !== 'RELINK' && (
                  <button type="button" style={SECONDARY} disabled={busy} onClick={() => answer('deny')}>Deny</button>
                )}
              </section>
            ) : (
              <p role="status">This request has {start.state === 'DENIED' ? 'been refused' : start.state === 'EXPIRED' ? 'expired' : 'already been answered'}. Start again from the website or app if you still need it.</p>
            )
          )}

          {start.kind === 'UNKNOWN' && <p role="status">This link has expired. Start again from the website or app.</p>}

          {/* ── Signup (a player) ─────────────────────────────────────────── */}
          {mode === 'signup' && (
            <section>
              <p>Create your player account. Your mobile number is your Telegram account&apos;s, which you share next.</p>
              {start.referral?.invitedBy && <p style={HINT}>Invited by <strong>{start.referral.invitedBy}</strong>.</p>}
              <PasswordField id="mini-password" label="Password" value={password} onChange={setPassword} />
              <PasswordField id="mini-confirm" label="Confirm password" value={confirm} onChange={setConfirm} />
              <div style={{ marginTop: 12 }}>
                <label htmlFor="mini-invite" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>Invite code (optional)</label>
                <input id="mini-invite" value={invite} disabled={Boolean(start.referral?.code)}
                  onChange={(e) => setInvite(e.target.value.toUpperCase())} style={INPUT} />
              </div>
              <button type="button" style={PRIMARY} disabled={busy || password.length < 8 || !confirm} onClick={signup}>
                Share contact and create account
              </button>
              {start.kind === 'NONE' && <button type="button" style={SECONDARY} onClick={() => setMode('home')}>Back</button>}
            </section>
          )}

          {/* ── Forgot password ───────────────────────────────────────────── */}
          {mode === 'reset' && (
            <section>
              <p>Reset the password of your {start.panel ? PANEL_WORD[start.panel] : 'player'} account. Share your contact; its number must be the account&apos;s mobile.</p>
              <button type="button" style={PRIMARY} disabled={busy} onClick={() => reset(start.panel ? undefined : 'PLAYER')}>
                Share contact and reset
              </button>
              {start.kind === 'NONE' && <button type="button" style={SECONDARY} onClick={() => setMode('home')}>Back</button>}
            </section>
          )}

          {/* ── Opened plainly ────────────────────────────────────────────── */}
          {start.kind === 'NONE' && mode === 'home' && (
            <section>
              {ctx.accounts.length > 0 && (
                <p style={HINT}>This Telegram account verifies: {ctx.accounts.map((a) => `${PANEL_WORD[a.panel]} ${a.mobileHint}`).join(', ')}.</p>
              )}
              {ctx.accounts.some((a) => a.panel === 'PLAYER')
                ? <button type="button" style={PRIMARY} disabled={busy} onClick={login}>Log in</button>
                : <button type="button" style={PRIMARY} disabled={busy} onClick={() => setMode('signup')}>Sign up</button>}
              <button type="button" style={SECONDARY} disabled={busy} onClick={() => setMode('reset')}>Forgot password</button>
            </section>
          )}
        </>
      )}
    </main>
  );
};

export default MiniApp;
