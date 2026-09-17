// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The countdown a throttled sign-in shows.
 *
 * ── Why this is shared, and why it reads `retryAt` ──────────────────────────
 * A 429 that says "too many requests" and nothing else leaves a person to guess
 * when to try again — and guessing means retrying immediately, which extends
 * the window and makes the screen look broken rather than throttled.
 *
 * The server sends `retryAfter` (whole seconds) AND `retryAt` (an absolute ISO
 * instant). This prefers `retryAt`, because `retryAfter` starts ageing the
 * moment the server writes it: on a slow connection a "10 seconds" that spent
 * two seconds in flight counts down to zero while the server still refuses.
 * The absolute instant survives the trip, and the fallback to `retryAfter`
 * over-states the wait rather than inviting an early retry.
 *
 * One copy per panel — the three build separately and share no module — but
 * they are byte-identical on purpose. A timer that behaves differently on the
 * merchant screen is a support call nobody can reproduce.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PacedError {
  retryAfter?: number;
  retryAt?: string;
  code?: string;
  message?: string;
}

/** Pull the throttle out of an axios error, a fetch body, or nothing. */
export function readPacedError(err: unknown): PacedError | null {
  const e = err as { response?: { status?: number; data?: PacedError }; status?: number; data?: PacedError };
  const status = e?.response?.status ?? e?.status;
  const body = e?.response?.data ?? e?.data;
  if (status !== 429 && body?.code !== 'LOGIN_PACED') return null;
  return body ?? {};
}

export function useRetryCountdown() {
  const [secondsLeft, setSecondsLeft] = useState(0);
  const deadline = useRef<number>(0);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = window.setInterval(() => {
      // Recomputed from the deadline every tick, never decremented. A
      // decrementing counter drifts whenever the tab is backgrounded and the
      // browser throttles timers — it would still be counting down long after
      // the server was ready.
      const left = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setSecondsLeft(left);
    }, 250);
    return () => window.clearInterval(id);
  }, [secondsLeft]);

  /** Start (or extend) the countdown from a 429. Returns true if it was one. */
  const startFrom = useCallback((err: unknown): boolean => {
    const paced = readPacedError(err);
    if (!paced) return false;
    const at = paced.retryAt ? Date.parse(paced.retryAt) : NaN;
    const ms = Number.isFinite(at)
      ? at - Date.now()
      : Math.max(1, Number(paced.retryAfter) || 10) * 1000;
    // Never shorten a countdown already running: two overlapping refusals must
    // leave the LATER deadline standing.
    deadline.current = Math.max(deadline.current, Date.now() + Math.max(ms, 0));
    setSecondsLeft(Math.max(1, Math.ceil((deadline.current - Date.now()) / 1000)));
    return true;
  }, []);

  const clear = useCallback(() => { deadline.current = 0; setSecondsLeft(0); }, []);

  return { secondsLeft, blocked: secondsLeft > 0, startFrom, clear };
}
