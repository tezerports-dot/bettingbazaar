// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// The one-time ticket Verify in the Mini App opens this panel with:
// `https://<site>/merchant/#/tg/<ticket>` (backend telegramChallenge.service.js
// `destinationFor`). The ticket is in the FRAGMENT, which no browser sends to a
// server or in a Referer; it is taken out of the address bar at startup
// (`main.tsx`), before anything renders, and held here until the sign-in
// screen spends it, once.

const TICKET_FRAGMENT = /^#\/tg\/([A-Za-z0-9_-]{16,128})$/;

let held: string | null = null;

/** Read a ticket from the fragment and remove it from the address bar. Called once at startup. */
export function captureTelegramTicket(): void {
  if (typeof window === 'undefined') return;
  const match = TICKET_FRAGMENT.exec(window.location.hash);
  if (!window.location.hash.startsWith('#/tg/')) return;
  held = match ? match[1] : '';
  try {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  } catch { /* the ticket is still held; it just stays visible */ }
}

/**
 * The captured ticket, handed out once. `''` when the fragment held something
 * that is not a ticket (said plainly by the caller); `null` when there was none.
 */
export function takeTelegramTicket(): string | null {
  const t = held;
  held = null;
  return t;
}
