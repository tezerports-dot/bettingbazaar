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

/** The slice of `window.Telegram.WebApp` this page uses. */
export interface WebApp {
  initData: string;
  ready(): void;
  expand(): void;
  close(): void;
  openLink(url: string): void;
  requestContact(cb: (shared: boolean, res?: { response?: string }) => void): void;
  requestWriteAccess?(cb: (allowed: boolean) => void): void;
}

export function webApp(): WebApp | null {
  const w = (window as unknown as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;
  return w && typeof w.initData === 'string' ? w : null;
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

export type Panel = 'PLAYER' | 'STAFF' | 'MERCHANT';
export type StartKind = 'VERIFY' | 'LOGIN' | 'TELEGRAM_LOGIN' | 'RELINK' | 'TWO_FACTOR_OFF'
  | 'RESET' | 'SIGNUP' | 'NONE' | 'UNKNOWN';

/** `POST /api/telegram/mini-app/context`: what this page was opened for. */
export interface MiniAppContext {
  telegramUser: { id: string; username: string; firstName: string };
  start: {
    kind: StartKind; panel: Panel | null; needsContact: boolean;
    state?: 'PENDING' | 'APPROVED' | 'DENIED' | 'REDEEMED' | 'EXPIRED';
    expiresAt?: string; mobileHint?: string;
    request?: { at: string; ip: string; device: string };
    referral?: { code: string | null; invitedBy: string };
  };
  accounts: Array<{ panel: Panel; mobileHint: string }>;
}

/** A refusal: the server's sentence, and its code for the few that change the screen. */
export class MiniAppRefusal extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), credentials: 'omit',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json?.success === false && !json?.passwordRequired)) {
    throw new MiniAppRefusal(json?.message || 'Something went wrong. Please try again.', json?.code || '', res.status);
  }
  return json as T;
}

export const miniApi = {
  context: (initData: string) => post<MiniAppContext>('/api/telegram/mini-app/context', { initData }),

  approve: (initData: string, decision: 'approve' | 'deny', contact?: string | null) =>
    post<{ kind: StartKind; panel: Panel; approved: boolean; message: string }>(
      '/api/telegram/mini-app/approve', { initData, decision, ...(contact ? { contact } : {}) }),

  signup: (initData: string, form: { contact: string; password: string; confirmPassword: string; referralCode?: string }) =>
    post<{ token: string }>('/api/telegram/mini-app/signup', { initData, ...form }),

  passwordReset: (initData: string, contact: string, panel?: Panel) =>
    post<{ resetUrl: string; message: string; panel: Panel }>(
      '/api/telegram/mini-app/password-reset', { initData, contact, ...(panel ? { panel } : {}) }),

  /** Login with Telegram, from inside Telegram: a player is signed in on the proof alone. */
  playerLogin: (initData: string) =>
    post<{ token: string }>('/api/v1/auth/login/telegram', { initData }),
};
