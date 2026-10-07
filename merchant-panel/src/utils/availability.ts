// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Whether a merchant is taking orders, in the words every screen uses.
 *
 * ONE place (§5). Three components each derived it from `isOnline` alone, and
 * when the platform paused a merchant's assignment (three unpaid buys, §2) the
 * Dashboard was taught to say so while the sidebar went on saying "Available
 * for orders" on the same screen — measured in the browser as the
 * `merchant-paused` profile.
 */
import type { MerchantProfile } from '../types';

export function availabilityOf(
  merchant: Pick<MerchantProfile, 'isOnline' | 'assignmentPausedAt' | 'isSupervisor'> | null | undefined,
) {
  // A supervisor is never a member (CLAUDE.md §2): they take no orders, so
  // there is nothing to switch, and every screen says so instead of offering
  // "Go online" (which the server refuses, SUPERVISOR_TAKES_NO_ORDERS).
  const supervisor = merchant?.isSupervisor === true;
  const online = !supervisor && !!merchant?.isOnline;
  const paused = !supervisor && !!merchant?.assignmentPausedAt;
  return {
    online,
    paused,
    supervisor,
    /** Whether this account has an online switch at all. */
    switchable: !supervisor,
    /** Sidebar and profile. */
    short: supervisor ? 'Supervisor · takes no orders'
      : online ? (paused ? 'New orders paused' : 'Available for orders') : 'Not accepting',
    /** The Dashboard's status card. */
    long: supervisor ? 'Supervisor · your members take the orders'
      : online ? (paused ? 'Online · New orders paused' : 'Online · Accepting orders') : 'Offline · Not accepting',
  };
}
