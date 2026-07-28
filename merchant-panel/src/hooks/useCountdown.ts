// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// One ticking clock for the whole screen. Every order card shows time remaining
// against PaymentOrder.expiresAt; mounting a timer per card means N intervals
// re-rendering independently, so a single shared tick drives all of them.
//
// GOVERNANCE §10: display-only. The order window is enforced server-side (the
// expiry sweeper cancels expired orders) — this countdown never gates an action.
import { useEffect, useState } from 'react';
import { TIMEOUTS } from '../constants';

/** Milliseconds since epoch, refreshed once per second while mounted. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TIMEOUTS.ORDER_COUNTDOWN_UPDATE);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** Whole seconds left until `expiresAt`, or null when the order has no window. */
export function secondsLeft(expiresAt: string | number | Date | undefined | null, now: number): number | null {
  if (!expiresAt) return null;
  const end = new Date(expiresAt).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - now) / 1000));
}

/** mm:ss for a countdown; hh:mm:ss once past an hour. */
export function formatCountdown(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Under five minutes is "urgent" — the design turns the timer red and pulses it. */
export const URGENT_SECONDS = 300;
