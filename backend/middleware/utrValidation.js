// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * utrValidation.js — Active UTRRegistry-backed implementation  v6.0.0
 *
 * Replaces the neutralised v5.2.0 no-op shim.
 * Section 9 of the Migration Patch Specification.
 *
 * UTR lifecycle:
 *   ACTIVE  → UTR registered, order in progress
 *   RELEASED → Order completed or cancelled; UTR kept for audit; cannot be reused
 *   FRAUD   → Admin-flagged; order escalated for review
 */

import mongoose from 'mongoose';

/**
 * Normalize UTR: uppercase, strip all whitespace.
 */
export function normalizeUTR(utr) {
  if (!utr) return null;
  return String(utr).toUpperCase().replace(/\s+/g, '');
}

/**
 * checkUTR — Check whether a normalized UTR already exists in the registry.
 * Returns { isUsed, warning, previousData } without registering anything.
 */
export async function checkUTR(utr) {
  if (!utr) return { isUsed: false, warning: null, previousData: null };
  const UTRRegistry = mongoose.model('UTRRegistry');
  const existing = await UTRRegistry.findOne({ utr: normalizeUTR(utr) }).lean();
  if (!existing) return { isUsed: false, warning: null, previousData: null };
  return {
    isUsed: true,
    warning: existing.status === 'FRAUD' ? 'FRAUD_ALERT' : 'DUPLICATE_UTR',
    previousData: {
      orderId: existing.orderId,
      userId:  existing.userId,
      status:  existing.status,
      registeredAt: existing.registeredAt,
    },
  };
}

/**
 * markUTRAsUsed — Atomic insert into UTRRegistry.
 * Throws { code: 11000 } on duplicate (concurrent-safe via unique index).
 *
 * @param {string} utr        — raw UTR (will be normalized internally)
 * @param {ObjectId} orderId
 * @param {ObjectId} userId
 * @param {number}   amount   — fiatAmount of the order
 * @returns {Promise<object>} — the created UTRRegistry document
 */
export async function markUTRAsUsed(utr, orderId, userId, amount) {
  const UTRRegistry = mongoose.model('UTRRegistry');
  const normalized  = normalizeUTR(utr);
  // Attempt atomic insert — MongoDB unique index prevents duplicates even under
  // concurrent requests (exactly one insert succeeds; others receive code 11000).
  return await UTRRegistry.create({ utr: normalized, orderId, userId, amount });
}

/**
 * releaseUTR — Transition UTR status to RELEASED on order completion or cancellation.
 * UTR record is kept permanently for audit; it cannot be reused.
 */
export async function releaseUTR(orderId) {
  const UTRRegistry = mongoose.model('UTRRegistry');
  await UTRRegistry.updateOne({ orderId }, { $set: { status: 'RELEASED' } });
}

/**
 * getUTRDetails — Fetch a single UTR registry entry by UTR string.
 */
export async function getUTRDetails(utr) {
  const UTRRegistry = mongoose.model('UTRRegistry');
  return UTRRegistry.findOne({ utr: normalizeUTR(utr) }).lean();
}

/**
 * getUserUTRHistory — Fetch UTR entries for a user (recent-first).
 */
export async function getUserUTRHistory(userId, limit = 20) {
  const UTRRegistry = mongoose.model('UTRRegistry');
  return UTRRegistry.find({ userId })
    .sort({ registeredAt: -1 })
    .limit(Math.min(limit, 100))
    .lean();
}

/**
 * validateUTR — Express middleware (pass-through).
 * Heavy validation is done inline in the /mark-paid route for precise error
 * responses. This middleware is kept as a no-op hook for future rate-limiting.
 */
export const validateUTR = (_req, _res, next) => next();

/**
 * getUTRStats — Admin: summary statistics for the UTR registry.
 */
export async function getUTRStats() {
  try {
    const UTRRegistry = mongoose.model('UTRRegistry');
    const [total, active, released, fraud] = await Promise.all([
      UTRRegistry.countDocuments(),
      UTRRegistry.countDocuments({ status: 'ACTIVE' }),
      UTRRegistry.countDocuments({ status: 'RELEASED' }),
      UTRRegistry.countDocuments({ status: 'FRAUD' }),
    ]);
    return { available: true, total, active, released, fraud };
  } catch (err) {
    return { available: false, message: err.message };
  }
}

/**
 * recordFraudAttempt — Admin flags a UTR as FRAUD.
 */
export async function recordFraudAttempt(utr) {
  const UTRRegistry = mongoose.model('UTRRegistry');
  const normalized  = normalizeUTR(utr);
  await UTRRegistry.updateOne({ utr: normalized }, { $set: { status: 'FRAUD' } });
}

/**
 * clearAllUTRs — Dev/test only. Never expose in production routes.
 */
export async function clearAllUTRs() {
  const UTRRegistry = mongoose.model('UTRRegistry');
  const { deletedCount } = await UTRRegistry.deleteMany({});
  return { success: true, clearedCount: deletedCount };
}

export default {
  normalizeUTR, checkUTR, markUTRAsUsed, releaseUTR, getUTRDetails,
  getUserUTRHistory, validateUTR, getUTRStats, recordFraudAttempt, clearAllUTRs,
};
