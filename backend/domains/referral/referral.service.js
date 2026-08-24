// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/referral/referral.service.js — attribution and the payout queue.
 *
 * Two responsibilities, deliberately kept apart:
 *
 *   RECORDING an earning happens when a user finishes onboarding. It is cheap,
 *   synchronous, and must be exactly-once — the same ₹25 may never be booked
 *   twice for one joiner.
 *
 *   PAYING an earning happens later, when an admin funds a pool. It walks the
 *   queue in joining order and moves real money, so it re-checks eligibility at
 *   that moment rather than trusting what was true when the earning was made.
 *
 * Money movement itself is delegated to walletAuthority.creditWinnings, which
 * already owns idempotency, the ledger row and the store routing. This module
 * never touches a balance directly.
 */
import mongoose from 'mongoose';
import crypto from 'crypto';
import {
  ReferralEarning, ReferralDisbursal, ReferralProgramme, Counter,
  REFERRAL_REWARD_PAISE,
} from './referral.model.js';
import { creditWinnings } from '../wallet/walletAuthority.service.js';
import { paiseToRupees } from '../../shared/money.js';

/** Levels paid, in the order they are paid within one joiner. */
const LEVELS = [1, 2];

// ── Joining numbers ─────────────────────────────────────────────────────────

/**
 * Allocate the next unique joining number.
 *
 * `findOneAndUpdate` with `$inc` is atomic on a single document, so two
 * simultaneous signups cannot receive the same value however they interleave or
 * whichever process serves them. Counting existing users instead would hand out
 * duplicates under exactly the concurrency this platform is built for.
 */
export async function nextJoiningNumber(session = null) {
  const opts = { new: true, upsert: true, ...(session ? { session } : {}) };
  const doc = await Counter.findOneAndUpdate(
    { key: 'joiningNumber' },
    { $inc: { value: 1 } },
    opts,
  );
  return doc.value;
}

/** A short, unambiguous public referral code. */
export function generateReferralCode() {
  // Crockford-ish alphabet: no O/0, I/1, so a code read aloud or typed from a
  // screenshot does not land on the wrong account.
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// ── Attribution ─────────────────────────────────────────────────────────────

/**
 * Record the earnings a newly-onboarded user generates for their upline.
 *
 * Called once, when onboarding completes. Safe to call again: the
 * `one_earning_per_source_level` unique index rejects a duplicate rather than
 * booking a second ₹25, so a retried or replayed onboarding is a no-op.
 *
 * @param {object} user  the joining user — must already have joiningNumber and referredBy
 * @returns {Promise<{recorded: number, levels: number[]}>}
 */
export async function recordEarningsFor(user) {
  if (!user?.referredBy || !user?.joiningNumber) return { recorded: 0, levels: [] };

  const User = mongoose.model('User');

  // Walk up at most two edges. Level 1 is the direct referrer; level 2 is that
  // referrer's own referrer. Nothing deeper is ever paid.
  const level1 = await User.findById(user.referredBy).select('_id referredBy').lean();
  if (!level1) return { recorded: 0, levels: [] };
  const level2 = level1.referredBy
    ? await User.findById(level1.referredBy).select('_id').lean()
    : null;

  const earners = [
    { level: 1, earnerId: level1._id },
    ...(level2 ? [{ level: 2, earnerId: level2._id }] : []),
  ]
    // A self-referral loop would pay a user for their own signup. The tree is
    // built from ids the bot supplied, so it is not assumed to be acyclic.
    .filter((e) => String(e.earnerId) !== String(user._id));

  const levels = [];
  for (const { level, earnerId } of earners) {
    try {
      await ReferralEarning.create({
        earnerId,
        sourceUserId: user._id,
        level,
        amountPaise: REFERRAL_REWARD_PAISE,
        queuePosition: user.joiningNumber,
        status: 'PENDING',
      });
      levels.push(level);
    } catch (err) {
      // 11000 = this earning already exists. That is the index doing its job on
      // a replay, not a failure.
      if (err?.code !== 11000) throw err;
    }
  }
  return { recorded: levels.length, levels };
}

// ── Eligibility ─────────────────────────────────────────────────────────────

/**
 * Decide whether one earning may be paid RIGHT NOW.
 *
 * Every condition here is something that can change between earning and payout,
 * which is why none of them are baked in at attribution time. The returned
 * reason is shown to the player verbatim on their referral report — "why is
 * this ₹25 still pending" should never require a support ticket.
 */
export async function eligibilityFor(earning) {
  const User = mongoose.model('User');
  const { KycVerification } = await import('../identity/kycVerification.model.js');
  const { TelegramIdentity } = await import('../telegram/telegram.model.js');

  const earner = await User.findById(earning.earnerId).select('_id status isBlocked').lean();
  if (!earner) return { ok: false, reason: 'Referrer account no longer exists' };
  if (earner.isBlocked || earner.status === 'BLOCKED') {
    return { ok: false, reason: 'Referrer account is blocked' };
  }

  // The referrer's own KYC must have come back YES.
  const earnerKyc = await KycVerification.findOne({ userId: earning.earnerId }).select('status').lean();
  if (earnerKyc?.status !== 'VERIFIED') {
    return { ok: false, reason: 'Referrer KYC is not verified' };
  }

  // And the JOINER's KYC must have passed — a failed KYC invalidates the
  // commissions that signup generated, for every level above it.
  const sourceKyc = await KycVerification.findOne({ userId: earning.sourceUserId }).select('status').lean();
  if (sourceKyc?.status === 'FAILED') {
    return { ok: false, reason: 'Referred user failed KYC — commission void' };
  }
  if (sourceKyc?.status !== 'VERIFIED') {
    return { ok: false, reason: 'Referred user KYC is not yet verified' };
  }

  // The referrer must still be in the channel, on the number they verified.
  const identity = await TelegramIdentity.findOne({ userId: earning.earnerId })
    .select('channelStatus contactActive').lean();
  if (!identity) return { ok: false, reason: 'Referrer has no linked Telegram account' };
  if (!identity.contactActive) {
    return { ok: false, reason: 'Referrer’s shared contact is no longer active' };
  }
  if (!['member', 'administrator', 'creator'].includes(identity.channelStatus)) {
    return { ok: false, reason: 'Referrer is not a member of the official channel' };
  }

  return { ok: true };
}

// ── Disbursal ───────────────────────────────────────────────────────────────

/**
 * Pay down the queue from an admin-funded pool.
 *
 * The admin supplies only an amount. Who gets paid is never chosen by hand —
 * the queue decides, strictly in joining order, which is what makes the
 * programme defensible to the people waiting in it.
 *
 * Ineligible rows are marked BLOCKED with a reason and SKIPPED WITHOUT
 * consuming pool: a failed KYC upstream must not deprive the next eligible
 * person of their turn.
 *
 * @param {object} args
 * @param {number} args.poolPaise  what the admin authorised
 * @param {string} args.actorId    the admin
 * @param {number} [args.maxRows]  safety bound per run
 */
export async function disburse({ poolPaise, actorId, maxRows = 50_000 }) {
  if (!(poolPaise > 0)) {
    throw Object.assign(new Error('Disbursal amount must be positive'), { status: 400 });
  }

  const programme = await getProgramme();
  if (!programme.active) {
    throw Object.assign(new Error('The referral programme is paused'), { status: 409 });
  }

  // The ₹400 crore ceiling is a hard stop, not a warning.
  const remainingBudget = programme.budgetPaise - programme.disbursedPaise;
  if (remainingBudget <= 0) {
    throw Object.assign(new Error('The referral programme budget is exhausted'), { status: 409 });
  }
  const pool = Math.min(poolPaise, remainingBudget);

  const batchId = `refdisb_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const batch = await ReferralDisbursal.create({
    batchId, poolPaise: pool, actorId, status: 'RUNNING',
  });

  let spent = 0;
  let paid = 0;
  let blocked = 0;
  let lastPosition = 0;

  try {
    // Strict queue order. `level` breaks ties within one joiner so level 1 is
    // always settled before level 2 for the same signup.
    const cursor = ReferralEarning.find({ status: 'PENDING' })
      .sort({ queuePosition: 1, level: 1 })
      .limit(maxRows)
      .cursor();

    for await (const earning of cursor) {
      // Never split a reward. When the remaining pool cannot cover the next
      // ₹25 the run stops, leaving the queue intact for the next top-up.
      if (spent + earning.amountPaise > pool) break;

      const verdict = await eligibilityFor(earning);
      if (!verdict.ok) {
        earning.status = 'BLOCKED';
        earning.blockedReason = verdict.reason;
        earning.disbursalBatchId = batchId;
        await earning.save();
        blocked += 1;
        continue;   // deliberately does NOT consume pool
      }

      // Deterministic — a re-run credits nothing further because the wallet
      // authority keys off this id.
      const walletTxId = `ref_${earning._id}`;
      await creditWinnings(
        String(earning.earnerId),
        paiseToRupees(earning.amountPaise),
        `Referral reward — level ${earning.level}`,
        'ReferralEarning',
        String(earning._id),
        walletTxId,
      );

      earning.status = 'DISBURSED';
      earning.disbursalBatchId = batchId;
      earning.disbursedAt = new Date();
      earning.walletTxId = walletTxId;
      await earning.save();

      spent += earning.amountPaise;
      paid += 1;
      lastPosition = earning.queuePosition;
    }

    await ReferralProgramme.updateOne(
      { key: 'main' },
      { $inc: { disbursedPaise: spent }, $set: { updatedAt: new Date() } },
    );

    batch.spentPaise = spent;
    batch.paidCount = paid;
    batch.blockedCount = blocked;
    batch.lastQueuePosition = lastPosition;
    batch.status = 'COMPLETED';
    batch.completedAt = new Date();
    await batch.save();

    return {
      batchId, paid, blocked,
      spentPaise: spent,
      unspentPaise: pool - spent,
      lastQueuePosition: lastPosition,
    };
  } catch (err) {
    batch.status = 'FAILED';
    batch.error = err.message;
    batch.spentPaise = spent;
    batch.paidCount = paid;
    batch.blockedCount = blocked;
    await batch.save().catch(() => { /* the throw below is the real signal */ });
    throw err;
  }
}

// ── Reporting ───────────────────────────────────────────────────────────────

/** The programme document, created on first read. */
export async function getProgramme() {
  return ReferralProgramme.findOneAndUpdate(
    { key: 'main' }, { $setOnInsert: { key: 'main' } },
    { new: true, upsert: true },
  ).lean();
}

/** What the admin dashboard needs in one call. */
export async function programmeStats() {
  const programme = await getProgramme();
  const [pending] = await ReferralEarning.aggregate([
    { $match: { status: 'PENDING' } },
    { $group: { _id: null, count: { $sum: 1 }, paise: { $sum: '$amountPaise' } } },
  ]);
  const [blocked] = await ReferralEarning.aggregate([
    { $match: { status: 'BLOCKED' } },
    { $group: { _id: null, count: { $sum: 1 }, paise: { $sum: '$amountPaise' } } },
  ]);
  const nextInQueue = await ReferralEarning.findOne({ status: 'PENDING' })
    .sort({ queuePosition: 1, level: 1 }).select('queuePosition').lean();

  return {
    budgetPaise:     programme.budgetPaise,
    disbursedPaise:  programme.disbursedPaise,
    remainingPaise:  programme.budgetPaise - programme.disbursedPaise,
    memberCap:       programme.memberCap,
    verifiedMembers: programme.verifiedMembers,
    active:          programme.active,
    pendingCount:    pending?.count || 0,
    pendingPaise:    pending?.paise || 0,
    blockedCount:    blocked?.count || 0,
    blockedPaise:    blocked?.paise || 0,
    nextQueuePosition: nextInQueue?.queuePosition ?? null,
  };
}

/** One player's referral report, including WHY anything is unpaid. */
export async function earningsFor(userId, { page = 1, limit = 50 } = {}) {
  const skip = (Math.max(1, page) - 1) * limit;
  const [rows, total] = await Promise.all([
    ReferralEarning.find({ earnerId: userId })
      .sort({ queuePosition: 1, level: 1 })
      .skip(skip).limit(limit)
      .populate('sourceUserId', 'username joiningNumber')
      .lean(),
    ReferralEarning.countDocuments({ earnerId: userId }),
  ]);
  return {
    total,
    rows: rows.map((r) => ({
      level: r.level,
      amount: paiseToRupees(r.amountPaise),
      status: r.status,
      reason: r.blockedReason || '',
      queuePosition: r.queuePosition,
      referred: r.sourceUserId?.username || 'a player',
      disbursedAt: r.disbursedAt || null,
    })),
  };
}
