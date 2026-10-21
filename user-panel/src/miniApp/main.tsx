// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Mini App's entry (mini-app.html). No router, no socket, no session of
 * its own: see MiniApp.tsx.
 *
 * Telegram's page script comes from telegram.org (mini-app.html). Where that
 * address did not load (a network that blocks or stalls it), the page would
 * have no `Telegram.WebApp` and could only say "open this page from
 * Telegram" while already inside Telegram. So a missing script is followed
 * by the same script as bundled with this app (`@twa-dev/sdk`, which reads
 * the launch data from this page's address exactly as telegram.org's does).
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import MiniApp from './MiniApp';
import { webApp, reportNoLaunchData, type WebApp } from './miniAppApi';

async function telegramApp(): Promise<{ app: WebApp | null; bundled: boolean }> {
  const app = webApp();
  if (app) return { app, bundled: false };
  try { await import('@twa-dev/sdk'); } catch { /* neither copy: the page says so */ }
  return { app: webApp(), bundled: true };
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
void telegramApp().then(({ app, bundled }) => {
  if (!app?.initData) reportNoLaunchData({ hasScript: Boolean(app), bundled });
  root.render(<React.StrictMode><MiniApp app={app} /></React.StrictMode>);
});
