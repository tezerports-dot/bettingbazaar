// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Waiting on Telegram: the one poll loop every Telegram step in this panel uses
 * (sign-in approval, "Login with Telegram", moving one's own Telegram link).
 *
 * The server asks for a poll every 2–3 s (`challengePollLimiter`); the loop
 * waits for each answer before scheduling the next, so a slow response never
 * stacks requests. It stops when `enabled` goes false, when the component
 * unmounts, or when `ask` answers `'stop'`. `ask` is handed `live()`, which is
 * false once the loop has been stopped, so an answer arriving after "Back"
 * signs nobody in.
 */
import { useEffect, useRef } from 'react';

/** Every 3 s: inside the server's 2–3 s ask, and under its poll limiter. */
export const TELEGRAM_POLL_MS = 3000;

export type PollStep = 'again' | 'stop';

export function useTelegramPoll(
  ask: (live: () => boolean) => Promise<PollStep>,
  enabled: boolean,
  intervalMs: number = TELEGRAM_POLL_MS,
): void {
  const askRef = useRef(ask);
  useEffect(() => { askRef.current = ask; }, [ask]);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const live = () => alive;
    const tick = async () => {
      let step: PollStep = 'again';
      try {
        step = await askRef.current(live);
      } catch {
        // A blip (network, 5xx) is not an answer; the challenge's own expiry
        // ends the wait with a 401 the caller turns into 'stop'.
        step = 'again';
      }
      if (alive && step === 'again') timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [enabled, intervalMs]);
}

/**
 * Whether a failed poll is the server's ANSWER (a 4xx refusal: denied,
 * expired, an account refusal) rather than a blip worth asking again
 * (no response, a 5xx, or the poll limiter's 429).
 */
export function isRefusal(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
}

/** The server's refusal in its own words, else the fallback. */
export function refusalText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { message?: unknown } }; message?: unknown } | null;
  const said = e?.response?.data?.message;
  if (typeof said === 'string' && said.trim()) return said;
  return fallback;
}
