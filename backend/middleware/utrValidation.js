// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * middleware/utrValidation.js — the bank-reference anti-fraud control.
 *
 * A thin adapter over `db.utr`. The rules live in the repository and the table;
 * this file exists because a dozen call sites already import these names.
 *
 * ── What changed underneath ─────────────────────────────────────────────────
 *
 * 1. THE GUARD IS THE INSERT, not a prior check. `checkUTR` followed by
 *    `markUTRAsUsed` left a window in which two submissions of the same
 *    reference both passed the check and one then failed on the index — a 500
 *    to a player who had done nothing wrong. `claimUtr` decides in one
 *    statement and returns which of the three outcomes happened.
 *
 * 2. A REFUSED DUPLICATE IS COUNTED. Someone submitting a reference that is
 *    already spent is the signal this control exists to catch; the attempt now
 *    increments a counter on the row rather than vanishing into a 400.
 *
 * 3. `clearAllUTRs` IS GONE. It emptied the whole registry and was one import
 *    away from any route. Reusing a bank reference is the thing the registry
 *    prevents, and a registry that can be emptied prevents it only until
 *    somebody empties it — the table now refuses DELETE outright.
 */
import { db } from '#db';

export const normalizeUTR = db.utr.normalizeUtr;

/**
 * Has this reference been seen? A READ, for warning a player before they
 * commit. It is NOT the guard — `markUTRAsUsed` is.
 */
export const checkUTR = (utr) => db.utr.checkUtr(utr);

/**
 * Claim a reference for an order.
 *
 * Returns the repository's three-way answer rather than throwing on a duplicate:
 * `{ ok: true }`, `{ ok: true, idempotent: true }` for a retried submission by
 * the same order, or `{ ok: false, reason }` naming which rule refused it.
 */
export const markUTRAsUsed = (utr, orderId, userId, amount) =>
  db.utr.claimUtr({ utr, orderId, userId, amountRupees: amount });

/** Mark the reference spent because its order closed. It does NOT free it. */
export const releaseUTR = (orderId) => db.utr.releaseUtr(orderId);

export const getUTRDetails = (utr) => db.utr.getUtr(utr);
export const getUserUTRHistory = (userId, limit = 20) => db.utr.userUtrHistory(userId, { limit });
export const getUTRStats = () => db.utr.utrStats();

/** Flag a reference. Requires an actor and a reason — the row insists. */
export const recordFraudAttempt = (utr, { actor, reason } = {}) =>
  db.utr.flagFraud(utr, { actor, reason });

/** References somebody tried to reuse. The review queue. */
export const contestedUTRs = (options) => db.utr.contestedUtrs(options);

/**
 * Express middleware (pass-through).
 *
 * The validation is inline in the mark-paid route so the error responses can be
 * precise. Kept as a named hook for the rate limiting it will eventually carry.
 */
export const validateUTR = (_req, _res, next) => next();

export default {
  normalizeUTR, checkUTR, markUTRAsUsed, releaseUTR, getUTRDetails,
  getUserUTRHistory, validateUTR, getUTRStats, recordFraudAttempt, contestedUTRs,
};
