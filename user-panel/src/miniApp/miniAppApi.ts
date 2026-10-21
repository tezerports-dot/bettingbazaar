// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * miniAppApi.ts — the Mini App's two halves: Telegram's page script, and the
 * server's `/api/telegram/mini-app/*` routes (Step 3).
 *
 * The Mini App has no session. Its credential is `initData`, the string
 * Telegram signs with the bot's token; it is sent with every request and the
 * server proves it each time (`backend/domains/telegram/miniAppAuth.js`). A
 * shared contact is sent as the signed `response` string Telegram returns,
 * never as `responseUnsafe`, which is the same data with nothing to check it by.
 *
 * Kept apart from the player app's transport on purpose: that one opens a
 * socket and keeps a session, and this page must do neither.
 */
import { apiUrl } from '../services/apiUrl';
import { secureFetch } from '../services/secureTransport';

/** The slice of `window.Telegram.WebApp` this page uses. */
export interface WebApp {
  initData: string;
  ready(): void;
  expand(): void;
  close(): void;
  requestContact(cb: (shared: boolean, res?: { response?: string }) => void): void;
  /** Opens a link outside Telegram: how Verify sends the person to the site. */
  openLink?(url: string): void;
}

export function webApp(): WebApp | null {
  const w = (window as unknown as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;
  return w && typeof w.initData === 'string' ? w : null;
}

/**
 * Tell the admin's error log that this page opened without Telegram's launch
 * data, and why as far as the page can see: whether Telegram's script ran,
 * whether the bundled copy was needed, whether the address carried the data.
 * Never the launch data itself. Fire and forget.
 */
export function reportNoLaunchData(seen: { hasScript: boolean; bundled: boolean }): void {
  const carried = /(?:^#|&)tgWebAppData=/.test(window.location.hash || '');
  const why = !seen.hasScript ? 'Telegram script did not load'
    : carried ? 'launch data in the address but not read' : 'no launch data from Telegram';
  void secureFetch(apiUrl('/api/internal/error-report'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
    body: JSON.stringify({
      panel: 'user',
      message: `Mini App opened without sign-in data: ${why}`,
      component: `script=${seen.hasScript} bundledScript=${seen.bundled} hashData=${carried} ua=${navigator.userAgent}`,
      url: `${window.location.origin}${window.location.pathname}`,
    }),
  }).catch(() => { /* the screen says what to do either way */ });
}

/**
 * Ask Telegram for the person's own contact. Resolves the signed string, or
 * null when they declined. Telegram shows its own confirmation; nothing here
 * can fill it in for them.
 */
export function shareContact(app: WebApp): Promise<string | null> {
  return new Promise((resolve) => {
    app.requestContact((shared, res) => resolve(shared && res?.response ? res.response : null));
  });
}

/** The panels Telegram serves (`TELEGRAM_AUDIENCES`, database/repositories/telegram.js). Staff have none (owner, 2026-10-13). */
export type Panel = 'PLAYER' | 'MERCHANT';

export type StartKind = 'TELEGRAM_LOGIN' | 'CONTINUE' | 'UNKNOWN';

/** Whose account Verify enters (`accountFor`, miniApp.routes.js). */
export interface VerifyAccount { panel: Panel; isNew: boolean; mobileHint: string }

/** `POST /api/telegram/mini-app/context`: what this page was opened for. */
export interface MiniAppContext {
  telegramUser: { id: string; username: string; firstName: string };
  start: {
    kind: StartKind; panel: Panel | null; needsContact: boolean;
    state?: 'PENDING' | 'APPROVED' | 'DENIED' | 'REDEEMED' | 'EXPIRED';
    expiresAt?: string; mobileHint?: string;
    /** Who asked: the server's clock, address, city ('' when the edge names none) and device. */
    request?: { at: string; ip: string; city: string; device: string };
    referral?: { code: string | null; invitedBy: string; unknown?: boolean };
    /** A sign-in: how it reaches a browser, and where Verify sends the person. */
    delivery?: 'MATCH' | 'HANDOFF';
    /** MATCH: the three numbers to choose from; which is right is never sent. */
    choices?: number[] | null;
    strikesLeft?: number | null;
    destination?: string;
    account?: VerifyAccount;
  };
  accounts: Array<{ panel: Panel; mobileHint: string }>;
}

/** A refusal: the server's sentence, and its code for the few that change the screen. */
export class MiniAppRefusal extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await secureFetch(apiUrl(path), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), credentials: 'omit',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    throw new MiniAppRefusal(json?.message || 'Something went wrong. Please try again.', json?.code || '', res.status);
  }
  return json as T;
}

export const miniApi = {
  context: (initData: string) => post<MiniAppContext>('/api/telegram/mini-app/context', { initData }),

  approve: (initData: string, decision: 'approve' | 'deny', contact?: string | null, pick?: number | null) =>
    post<{ panel: Panel; approved: boolean; created: boolean; message: string; redirectUrl?: string | null }>(
      '/api/telegram/mini-app/approve',
      { initData, decision, ...(contact ? { contact } : {}), ...(typeof pick === 'number' ? { pick } : {}) }),

  /** Verify, opened from the bot itself: answers the site's address with a one-time ticket. */
  continueToSite: (initData: string, contact?: string | null) =>
    post<{ redirectUrl: string; message: string; created: boolean }>(
      '/api/telegram/mini-app/continue', { initData, ...(contact ? { contact } : {}) }),

};
