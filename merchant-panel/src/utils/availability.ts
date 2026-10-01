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

export function availabilityOf(merchant: Pick<MerchantProfile, 'isOnline' | 'assignmentPausedAt'> | null | undefined) {
  const online = !!merchant?.isOnline;
  const paused = !!merchant?.assignmentPausedAt;
  return {
    online,
    paused,
    /** Sidebar and profile. */
    short: online ? (paused ? 'New orders paused' : 'Available for orders') : 'Not accepting',
    /** The Dashboard's status card. */
    long: online ? (paused ? 'Online · New orders paused' : 'Online · Accepting orders') : 'Offline · Not accepting',
  };
}
