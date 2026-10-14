// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * VerifyScreen.tsx — "Continue with Telegram", answered (owner, 2026-10-13).
 *
 * Nothing is approved by opening the page: the person presses **Verify**, and
 * above it the server's own sentence says where they will be sent and whose
 * account they are entering. That is the phishing defence a page can offer —
 * a sign-in somebody else started shows somebody else's site or device here.
 *
 *   HANDOFF, CONTINUE  Verify answers a link to the site with a one-time ticket
 *                      in its fragment, and this page opens it (`openLink`):
 *                      the session lands on THIS phone, whoever asked.
 *   MATCH              the screen that asked shows a two-digit number; this
 *                      page offers three, and Verify counts only with the right
 *                      one (the server checks; a wrong pick costs one of three
 *                      tries). The session then goes to the screen that asked.
 *
 * A Telegram account with no account on that panel yet shares its contact at
 * Verify — once, at signup; the server finds the account of that number or
 * makes one.
 *
 * Every sentence a refusal shows is the server's (§32 S14).
 */
import React, { useState } from 'react';
import { miniApi, shareContact, MiniAppRefusal, type MiniAppContext, type WebApp } from './miniAppApi';
import { PRIMARY, SECONDARY, HINT } from './styles';

const PANEL_WORD = { PLAYER: 'player', MERCHANT: 'merchant' } as const;

const CHOICE: React.CSSProperties = {
  flex: 1, height: 64, borderRadius: 12, fontSize: 26, fontWeight: 800, cursor: 'pointer',
  border: '2px solid var(--tg-theme-hint-color, GrayText)',
  background: 'var(--tg-theme-secondary-bg-color, ButtonFace)', color: 'var(--tg-theme-text-color, ButtonText)',
};
const CHOSEN: React.CSSProperties = {
  ...CHOICE, borderColor: 'var(--tg-theme-button-color, Highlight)',
  background: 'var(--tg-theme-button-color, Highlight)', color: 'var(--tg-theme-button-text-color, HighlightText)',
};

interface Props {
  app: WebApp;
  start: MiniAppContext['start'];
  /** The finished screen's sentence (approved without a redirect, or denied). */
  onDone: (message: string) => void;
}

const VerifyScreen: React.FC<Props> = ({ app, start, onDone }) => {
  const [pick, setPick] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<string | null>(null);

  const panel = start.panel ?? 'PLAYER';
  const word = PANEL_WORD[panel];
  const match = start.kind === 'TELEGRAM_LOGIN' && start.delivery === 'MATCH';
  const choices = match ? start.choices ?? [] : [];
  const account = start.account;
  const needsContact = Boolean(account?.isNew ?? start.needsContact);

  /** Send the person to the site the server named, on this device. */
  const go = (url: string) => {
    setOpened(url);
    if (app.openLink) app.openLink(url);
    else window.location.href = url;
  };

  const verify = async () => {
    setBusy(true); setError('');
    try {
      let contact: string | null = null;
      if (needsContact) {
        contact = await shareContact(app);
        if (!contact) throw new Error('Share your contact to continue. Telegram sends only your number, and only once.');
      }
      const r = start.kind === 'CONTINUE'
        ? await miniApi.continueToSite(app.initData, contact)
        : await miniApi.approve(app.initData, 'approve', contact, match ? pick : null);
      if (r.redirectUrl) go(r.redirectUrl);
      else onDone(r.message);
    } catch (e) {
      setError(e instanceof MiniAppRefusal || e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally { setBusy(false); }
  };

  const deny = async () => {
    if (start.kind === 'CONTINUE') { app.close(); return; }
    setBusy(true); setError('');
    try { onDone((await miniApi.approve(app.initData, 'deny', null)).message); } catch (e) {
      setError((e as Error).message || 'Something went wrong. Please try again.');
    } finally { setBusy(false); }
  };

  if (opened) {
    return (
      <section role="status">
        <p>Opening {start.destination}… You are signed in there.</p>
        <p style={HINT}>Nothing opened? <a href={opened} onClick={(e) => { e.preventDefault(); go(opened); }}>Open {start.destination}</a></p>
        <button type="button" style={SECONDARY} onClick={() => app.close()}>Close</button>
      </section>
    );
  }

  return (
    <section>
      <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Sign in to your {word} account</h2>

      {/* Where Verify sends them: the server's, never this page's. */}
      <p style={{ fontWeight: 700 }}>
        {match
          ? <>You are signing in to {start.destination} on the screen that shows a number.</>
          : <>You will be sent to {start.destination}.</>}
      </p>

      {account && (
        <p data-testid="verify-account">
          {account.isNew
            ? panel === 'MERCHANT'
              ? <>This submits your merchant application on your Telegram number. Telegram asks you to share your contact once; an admin approves the application before you can sign in.</>
              : <>This creates your {word} account on your Telegram number. Telegram asks you to share your contact once.</>
            : <>Your {word} account {account.mobileHint}.</>}
        </p>
      )}
      {start.referral?.invitedBy && <p style={HINT}>Invited by <strong>{start.referral.invitedBy}</strong>.</p>}
      {start.referral?.unknown && <p style={HINT}>The invite code in your link is not recognised, so none is applied.</p>}

      {start.request && (
        <p style={HINT}>Asked {new Date(start.request.at).toLocaleString()} from {start.request.ip || 'an unknown address'}{start.request.device ? ` · ${start.request.device}` : ''}</p>
      )}

      {match && (
        <fieldset style={{ border: 'none', padding: 0, margin: '12px 0 0' }}>
          <legend style={{ marginBottom: 8 }}>Which number does that screen show?</legend>
          <div style={{ display: 'flex', gap: 10 }}>
            {choices.map((n) => (
              <button key={n} type="button" aria-pressed={pick === n} disabled={busy}
                style={pick === n ? CHOSEN : CHOICE} onClick={() => setPick(n)}>
                {n}
              </button>
            ))}
          </div>
          {typeof start.strikesLeft === 'number' && start.strikesLeft < 3 && (
            <p style={HINT}>{start.strikesLeft} {start.strikesLeft === 1 ? 'try' : 'tries'} left.</p>
          )}
        </fieldset>
      )}

      {error && <p role="alert" style={{ color: 'var(--tg-theme-destructive-text-color, MarkText)', fontWeight: 600 }}>{error}</p>}

      <p style={{ ...HINT, marginTop: 14 }}>Press Verify only if you started this sign-in yourself.</p>
      <button type="button" style={PRIMARY} disabled={busy || (match && pick === null)} onClick={verify}>
        {needsContact ? 'Share contact and verify' : 'Verify'}
      </button>
      <button type="button" style={SECONDARY} disabled={busy} onClick={deny}>Deny</button>
    </section>
  );
};

export default VerifyScreen;
