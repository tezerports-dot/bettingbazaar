// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * hooks/useTelegramPoll.ts — ask the server every few seconds whether Telegram
 * has answered, until it has, it refuses, or the screen goes away.
 *
 * The approval happens in another app, often on another device. Nothing can
 * call this page back, so it asks, and the server spends the approval once.
 */
import { useEffect, useRef } from 'react';

/** Every three seconds: the contract's "every 2-3 s", and the poll limiter's budget. */
export const TELEGRAM_POLL_MS = 3000;

/**
 * Ask `poll` every TELEGRAM_POLL_MS until it answers `done` or throws.
 *
 * One loop for every screen that waits on Telegram, rather than a second
 * loop that forgets to stop (§5). One request in
 * flight at a time: a slow answer must not stack a second poll behind it.
 */
export function useTelegramPoll(
  poll: (() => Promise<'pending' | 'done' | 'handedOff'>) | null,
  onDone: () => void,
  onError: (message: string) => void,
  onHandedOff?: () => void,
) {
  const busy = useRef(false);
  const latest = useRef({ onDone, onError, onHandedOff });
  latest.current = { onDone, onError, onHandedOff };

  useEffect(() => {
    if (!poll) return undefined;
    let stopped = false;
    const tick = async () => {
      if (stopped || busy.current) return;
      busy.current = true;
      try {
        const r = await poll();
        if (!stopped && r === 'done') { stopped = true; latest.current.onDone(); }
        // Verified, and the session went to the device that pressed Verify
        // (a HANDOFF sign-in): nothing more will come to this poll.
        if (!stopped && r === 'handedOff') { stopped = true; latest.current.onHandedOff?.(); }
      } catch (err) {
        if (!stopped) {
          stopped = true;
          latest.current.onError((err as Error)?.message || 'This Telegram step did not finish. Please start again.');
        }
      } finally { busy.current = false; }
    };
    const id = window.setInterval(tick, TELEGRAM_POLL_MS);
    return () => { stopped = true; window.clearInterval(id); };
  }, [poll]);
}

