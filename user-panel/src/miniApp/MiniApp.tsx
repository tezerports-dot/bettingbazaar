// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * MiniApp.tsx — the page Telegram opens from the one bot (Step 3).
 *
 * What it shows is decided by the server from the `start_param` Telegram signed
 * into `initData` (`/api/telegram/mini-app/context`), never by anything this
 * page could alter:
 *
 *   TELEGRAM_LOGIN, CONTINUE  the Verify screen ("Continue with Telegram",
 *                             owner 2026-10-13): where Verify sends them, whose
 *                             account it enters, the three numbers of a MATCH;
 *                             Verify or Deny. CONTINUE is the page opened from
 *                             the bot itself or a referral link.
 *   VERIFY, RELINK            share your contact (it must be the account's mobile)
 *   LOGIN, TWO_FACTOR_OFF     approve or deny a sign-in, showing where and when
 *                             it was asked for; a contact only when the server
 *                             says this Telegram account is not the linked one
 *   RESET                     type a new password, share your contact; it is set
 *
 * Everything is the server's sentence. A screen that phrased its own refusals
 * would phrase CONTACT_MISMATCH as "error" to somebody whose Telegram is on
 * another number, who then cannot act on it (§32 S14).
 */
import React, { useEffect, useState } from 'react';
import { miniApi, shareContact, MiniAppRefusal, PASSWORD_FLOOR, type MiniAppContext, type Panel, type WebApp } from './miniAppApi';
import VerifyScreen from './VerifyScreen';
import { PAGE, PRIMARY, SECONDARY, INPUT, HINT } from './styles';

const PANEL_WORD: Record<Panel, string> = { PLAYER: 'player', MERCHANT: 'merchant' };


/** A labelled password field, at module level so typing keeps the caret (§32 S23). */
const PasswordField: React.FC<{ id: string; label: string; value: string; onChange: (v: string) => void; hint?: string }> =
  ({ id, label, value, onChange, hint }) => (
    <div style={{ marginTop: 12 }}>
      <label htmlFor={id} style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>{label}</label>
      <input id={id} type="password" autoComplete="new-password" value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)} style={INPUT} />
      {hint ? <p id={`${id}-hint`} style={{ ...HINT, margin: '4px 0 0' }}>{hint}</p> : null}
    </div>
  );

const MiniApp: React.FC<{ app: WebApp | null }> = ({ app }) => {
  const [ctx, setCtx] = useState<MiniAppContext | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'home' | 'reset'>('home');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const initData = app?.initData || '';

  useEffect(() => {
    if (!app || !initData) return;
    app.ready(); app.expand();
    miniApi.context(initData)
      .then((c) => {
        setCtx(c);
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
    setDone(r.message);
  });

  const reset = (panel?: Panel) => act(async () => {
    // Asked before Telegram's contact prompt opens: the server would refuse it
    // too, but only after the person had shared their number for nothing.
    if (password !== confirm) throw new Error('The two passwords do not match.');
    const c = await contact();
    const r = await miniApi.passwordReset(initData, c, { password, confirmPassword: confirm, ...(panel ? { panel } : {}) });
    setPassword(''); setConfirm('');
    setDone(r.message);
  });

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
          <button type="button" style={SECONDARY} onClick={() => app.close()}>Close</button>
        </div>
      )}

      {ctx && !done && start && (
        <>
          {/* ── Continue with Telegram: the Verify screen ───────────────── */}
          {(start.kind === 'CONTINUE' || start.kind === 'TELEGRAM_LOGIN') && (
            fresh ? (
              <VerifyScreen app={app} start={start} onDone={setDone} />
            ) : (
              <p role="status">This sign-in has {start.state === 'DENIED' ? 'been refused' : start.state === 'EXPIRED' ? 'expired' : 'already been answered'}. Start again from the website or app if you still need it.</p>
            )
          )}

          {/* ── A challenge: verify, relink, approve ─────────────────────── */}
          {['VERIFY', 'RELINK', 'LOGIN', 'TWO_FACTOR_OFF'].includes(start.kind) && (
            fresh ? (
              <section>
                <p>
                  {start.kind === 'VERIFY' && <>Verify the mobile number of your {PANEL_WORD[start.panel!]} account{start.mobileHint ? ` (${start.mobileHint})` : ''}. Share your Telegram contact; its number must be the same.</>}
                  {start.kind === 'RELINK' && <>Move your {PANEL_WORD[start.panel!]} account to this Telegram account. Share this account&apos;s contact; its number must be the account&apos;s mobile{start.mobileHint ? ` (${start.mobileHint})` : ''}.</>}
                  {start.kind === 'LOGIN' && <>Someone is signing in to your {PANEL_WORD[start.panel!]} account{start.mobileHint ? ` (${start.mobileHint})` : ''}. Approve only if it is you.</>}
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

          {/* ── Forgot password ───────────────────────────────────────────── */}
          {/* Set here, for every panel (2026-10-08): the merchant and admin
              panels have no page a reset link could open. */}
          {mode === 'reset' && (
            <section>
              <p>
                Choose a new password for your {PANEL_WORD[start.panel || 'PLAYER']} account, then share your
                contact; its number must be the account&apos;s mobile. Every device signed in to the account
                is signed out.
              </p>
              <PasswordField id="mini-new-password" label="New password" value={password} onChange={setPassword}
                hint={`At least ${PASSWORD_FLOOR[start.panel || 'PLAYER']} characters. A long phrase you can remember is best.`} />
              <PasswordField id="mini-new-confirm" label="Confirm new password" value={confirm} onChange={setConfirm} />
              <button type="button" style={PRIMARY}
                disabled={busy || password.length < PASSWORD_FLOOR[start.panel || 'PLAYER'] || !confirm}
                onClick={() => reset(start.panel ? undefined : 'PLAYER')}>
                Share contact and reset
              </button>
            </section>
          )}

        </>
      )}
    </main>
  );
};

export default MiniApp;
