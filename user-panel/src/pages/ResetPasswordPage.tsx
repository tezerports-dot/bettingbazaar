// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ResetPasswordPage.tsx — where the bot's reset link lands.
 *
 * ── The token is in the FRAGMENT, and that is why this is a hash route ─────
 * The link is `.../#/reset/<token>`. A query string reaches the server: it
 * lands in access logs, in the proxy's log, and in the `Referer` header of
 * whatever the page loads next. A fragment is never sent. That lesson was paid
 * for once already, by the one-time login link this platform used to issue.
 *
 * So the token arrives as a ROUTE PARAM of a HashRouter route, which is the
 * fragment, and it is never put anywhere else — not in a redirect, not in a
 * link, not in an error message.
 *
 * ── It does not sign anybody in, deliberately ─────────────────────────────
 * Setting the password sends them to the login form. A reset that seated the
 * player would put session-minting back inside the bot fleet — hundreds of
 * tokens, any one of which could then hand out an account — which is the exact
 * thing deleting the one-time login link was for.
 *
 * ── Every refusal is the SERVER's sentence ────────────────────────────────
 * "Unknown", "already used" and "expired" are one message on purpose: a caller
 * that can tell them apart can map which tokens were ever live. The password
 * policy is the exception and has to be — "at least 8 characters" is the only
 * refusal a person can act on — and it also says that the link is spent, because
 * it is: the token is consumed before the password is validated, so a weak
 * password costs them the link and they need to be told rather than left to
 * discover it.
 */
import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { getBackend } from '../services/backend.service';

const FIELD: React.CSSProperties = {
  width: '100%', height: 48, borderRadius: 12, border: '1px solid var(--line2)',
  background: 'var(--surface2)', color: 'var(--text)', padding: '0 14px',
  fontSize: 15, outline: 'none', boxSizing: 'border-box',
};
const GOLD: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: '100%', height: 50, borderRadius: 13, border: 'none', fontWeight: 800,
  fontSize: 14, letterSpacing: '.04em', color: '#1a1200',
  background: 'linear-gradient(135deg,var(--gold2),var(--gold))',
};
const LABEL: React.CSSProperties = {
  display: 'block', marginBottom: 6, fontSize: 11, fontWeight: 700,
  letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)',
};

const ResetPasswordPage: React.FC = () => {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const ready = password.length >= 8 && confirm.length > 0 && !busy;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    setBusy(true); setError('');
    try {
      const res = await getBackend().resetPassword(token, password, confirm);
      if (res.success) { setDone(true); return; }
      // Verbatim: the server's message is the only one that names what to do.
      setError(res.message || 'This reset link is no longer valid.');
    } catch (err) {
      setError((err as Error)?.message || 'Could not change your password. Please try again.');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
      <div style={{ width: '100%', maxWidth: 400, background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 22, padding: '26px 22px', boxShadow: 'var(--shadow)' }}>
        <h1 style={{ margin: '0 0 6px', textAlign: 'center', fontSize: 19, fontWeight: 800, color: 'var(--text)' }}>
          {done ? 'Password changed' : 'Choose a new password'}
        </h1>

        {done ? (
          <>
            <p style={{ margin: '0 0 18px', textAlign: 'center', fontSize: 13, lineHeight: 1.6, color: 'var(--text2)' }}>
              Sign in with it now. Any devices that were signed in have been signed out.
            </p>
            <button style={{ ...GOLD, cursor: 'pointer' }} onClick={() => navigate('/')}>
              Go to sign in
            </button>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ margin: '0 0 4px', textAlign: 'center', fontSize: 12.5, lineHeight: 1.6, color: 'var(--text3)' }}>
              This link works once. Setting a password here does not sign you in —
              you will log in with it on the next screen.
            </p>

            {error && (
              <div role="alert" style={{ background: 'color-mix(in srgb,var(--red) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)', borderRadius: 10, padding: 10, textAlign: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--red)', lineHeight: 1.5 }}>
                {error}
              </div>
            )}

            <div>
              <label htmlFor="bb-new-password" style={LABEL}>New password</label>
              <input
                id="bb-new-password" name="new-password" type="password"
                autoComplete="new-password" autoFocus value={password}
                onChange={(e) => setPassword(e.target.value)} style={FIELD}
              />
              <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
                At least 8 characters. A phrase you can remember beats a short one with symbols in it.
              </p>
            </div>
            <div>
              <label htmlFor="bb-new-confirm" style={LABEL}>Confirm new password</label>
              <input
                id="bb-new-confirm" name="confirm-new-password" type="password"
                autoComplete="new-password" value={confirm}
                onChange={(e) => setConfirm(e.target.value)} style={FIELD}
              />
            </div>

            <button type="submit" disabled={!ready}
              style={{ ...GOLD, cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.55 }}>
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default ResetPasswordPage;
