// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// The one poll behind every "Approve in Telegram" wait in this panel: the
// sign-in approval and the signup verification (`/login/2fa`), "Login with
// Telegram" (`/login/telegram/complete`) and the Profile relink (GET
// `/api/merchant/telegram`). The server answers each poll; this only asks.
//
// One request at a time (a timeout chain, never an interval, so a slow answer
// is not overtaken by the next ask), stopped on unmount, on Back (the caller
// passes `null`) and after `maxMs`.
import { useEffect, useRef } from 'react';

/**
 * Seconds between polls. The backend's poll limiter is sized for one every
 * 2–3 s (backend/domains/identity/loginDoors.js); display-only pacing, §11.
 */
export const TELEGRAM_POLL_MS = 3000;

export interface TelegramPollOptions<T> {
  /** Called once with the first non-null answer; polling stops. */
  onDone: (result: T) => void;
  /** Called once with the first thrown refusal; polling stops. */
  onError: (error: unknown) => void;
  /** Called once if nothing answered within `maxMs`; polling stops. */
  onTimeout?: () => void;
  intervalMs?: number;
  maxMs?: number;
}

/**
 * Polls `poll` while it is non-null. `poll` answers `null` to keep waiting.
 * Changing `poll` (or passing `null`) stops the previous chain at once.
 */
export function useTelegramPoll<T>(
  poll: (() => Promise<T | null>) | null,
  { onDone, onError, onTimeout, intervalMs = TELEGRAM_POLL_MS, maxMs }: TelegramPollOptions<T>,
): void {
  // The callbacks are read through a ref so a parent re-render does not
  // restart the chain (and with it, the first ask).
  const handlers = useRef({ onDone, onError, onTimeout });
  handlers.current = { onDone, onError, onTimeout };

  useEffect(() => {
    if (!poll) return undefined;
    let stopped = false;
    let timer: number | undefined;
    const started = Date.now();

    const ask = async () => {
      if (stopped) return;
      if (maxMs !== undefined && Date.now() - started > maxMs) {
        stopped = true;
        handlers.current.onTimeout?.();
        return;
      }
      try {
        const result = await poll();
        if (stopped) return;
        if (result !== null) {
          stopped = true;
          handlers.current.onDone(result);
          return;
        }
      } catch (error) {
        if (stopped) return;
        stopped = true;
        handlers.current.onError(error);
        return;
      }
      timer = window.setTimeout(ask, intervalMs);
    };

    timer = window.setTimeout(ask, intervalMs);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [poll, intervalMs, maxMs]);
}
