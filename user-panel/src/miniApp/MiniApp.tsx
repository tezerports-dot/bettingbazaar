// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * MiniApp.tsx — the page Telegram opens from the one bot.
 *
 * What it shows is decided by the server from the `start_param` Telegram signed
 * into `initData` (`/api/telegram/mini-app/context`), never by anything this
 * page could alter:
 *
 *   TELEGRAM_LOGIN, CONTINUE  the Verify screen ("Continue with Telegram",
 *                             owner 2026-10-13/14): where Verify sends them,
 *                             whose account it enters (or that it makes one),
 *                             the three numbers of a MATCH; Verify or Deny.
 *                             CONTINUE is the page opened from the bot itself
 *                             or a referral link.
 *   UNKNOWN                   an expired or unknown link.
 *
 * There is nothing else: no password, no reset, no separate verification
 * (owner, 2026-10-14). Everything is the server's sentence (§32 S14).
 */
import React, { useEffect, useState } from 'react';
import { miniApi, type MiniAppContext, type WebApp } from './miniAppApi';
import VerifyScreen from './VerifyScreen';
import { PAGE, SECONDARY, HINT } from './styles';

const MiniApp: React.FC<{ app: WebApp | null }> = ({ app }) => {
  const [ctx, setCtx] = useState<MiniAppContext | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const initData = app?.initData || '';

  useEffect(() => {
    if (!app || !initData) return;
    app.ready(); app.expand();
    miniApi.context(initData)
      .then(setCtx)
      .catch((e) => setError((e as Error).message));
  }, [app, initData]);

  if (!app || !initData) {
    // Inside Telegram with no launch data (Telegram's script missing, or the
    // page opened as a plain link) the old "open this page from Telegram" read
    // as nonsense to someone already in Telegram: say what to do instead.
    return (
      <main style={PAGE}>
        <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>Betting Bazaar</h1>
        <p role="alert">Telegram did not pass your sign-in to this page.</p>
        <p style={HINT}>Close this window and press Login with Telegram again on the website or in the app. If you came from an invite link, open the link again.</p>
        {app && <button type="button" style={SECONDARY} onClick={() => app.close()}>Close</button>}
      </main>
    );
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
          {(start.kind === 'CONTINUE' || start.kind === 'TELEGRAM_LOGIN') && (
            fresh ? (
              <VerifyScreen app={app} start={start} onDone={setDone} />
            ) : (
              <p role="status">This sign-in has {start.state === 'DENIED' ? 'been refused' : start.state === 'EXPIRED' ? 'expired' : 'already been answered'}. Start again from the website or app if you still need it.</p>
            )
          )}
          {start.kind === 'UNKNOWN' && <p role="status">This link has expired. Start again from the website or app.</p>}
        </>
      )}
    </main>
  );
};

export default MiniApp;
