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
import { db } from '#db';
import crypto from 'crypto';
import { REFERRAL_REWARD_PAISE } from './referralRewards.js';
import { creditWinnings } from '../wallet/walletAuthority.service.js';
import { paiseToRupees } from '../../shared/money.js';

/** Levels paid, in the order they are paid within one joiner. */
const LEVELS = [1, 2];

// ── Joining numbers ─────────────────────────────────────────────────────────

/**
 * `nextJoiningNumber` is GONE, with no replacement here.
 *
 * It incremented a counter document to hand out queue positions. Nothing called
 * it: onboarding claims the number through `db.users.claimJoiningNumber`, which
 * uses a SEQUENCE — atomic on its own, idempotent per account (an account that
 * already holds a number keeps it), and deliberately not rolled back. A signup
 * that fails after taking a number leaves a gap, which is correct: this is an
 * ORDER, not a count, and reusing the number would hand it to somebody else.
 */

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

  // Walk up at most two edges. Level 1 is the direct referrer; level 2 is that
  // referrer's own referrer. Nothing deeper is ever paid.
  const level1 = await db.users.getUser(user.referredBy);
  if (!level1) return { recorded: 0, levels: [] };
  const level2 = level1.referredBy
    ? await db.users.getUser(level1.referredBy)
    : null;

  const earners = [
    { level: 1, earnerId: level1.userId },
    ...(level2 ? [{ level: 2, earnerId: level2.userId }] : []),
  ]
    // A self-referral loop would pay a user for their own signup. The tree is
    // built from ids the bot supplied, so it is not assumed to be acyclic.
    .filter((e) => String(e.earnerId) !== String(user.userId));

  const levels = [];
  for (const { level, earnerId } of earners) {
    // The earning id is DERIVED from the pair and the level, so a replayed
    // onboarding collides on the primary key and books nothing further — the
    // index does the work, rather than a prior read two deliveries would pass.
    const result = await db.referrals.recordEarning({
      earningId: `ref_${earnerId}_${user.userId}_L${level}`,
      earnerId,
      sourceUserId: user.userId,
      level,
      amountRupees: paiseToRupees(REFERRAL_REWARD_PAISE),
    });
    if (!result.idempotent) levels.push(level);
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
  const earner = await db.users.getUser(earning.earnerId);
  if (!earner) return { ok: false, reason: 'Referrer account no longer exists' };
  if (earner.isBlocked || earner.status === 'BLOCKED') {
    return { ok: false, reason: 'Referrer account is blocked' };
  }

  // The referrer's own KYC must have come back YES.
  const earnerKyc = await db.identity.getVerification(earning.earnerId);
  if (earnerKyc?.status !== 'VERIFIED') {
    return { ok: false, reason: 'Referrer KYC is not verified' };
  }

  // And the JOINER's KYC must have passed — a failed KYC invalidates the
  // commissions that signup generated, for every level above it.
  const sourceKyc = await db.identity.getVerification(earning.sourceUserId);
  if (sourceKyc?.status === 'FAILED') {
    return { ok: false, reason: 'Referred user failed KYC — commission void' };
  }
  if (sourceKyc?.status !== 'VERIFIED') {
    return { ok: false, reason: 'Referred user KYC is not yet verified' };
  }

  // The referrer must still be in the channel, on the number they verified.
  const identity = await db.telegram.getIdentityByUserId(earning.earnerId);
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
  await db.referrals.openBatch({
    batchId, poolRupees: paiseToRupees(pool), actorId,
  });

  let spent = 0;
  let paid = 0;
  let blocked = 0;
  let lastPosition = 0;

  try {
    // Strict queue order — the payout order the programme promised, and the
    // thing that makes it defensible to the people waiting in it.
    const payable = await db.referrals.claimPayable({ limit: maxRows });

    for (const earning of payable) {
      const verdict = await eligibilityFor(earning);
      if (!verdict.ok) {
        // Recorded against the batch, and deliberately consuming NO pool: a
        // blocked earning is money still owed, not money spent.
        await db.referrals.markBlocked(earning.earningId, verdict.reason, { batchId });
        await db.referrals.spendFromBatch(batchId, 0, { blocked: true });
        blocked += 1;
        continue;
      }

      // ── The pool ceiling is enforced by the ROW ──────────────────────────
      // `spent_paise + amount <= pool_paise` lives in the UPDATE's WHERE
      // clause. A JavaScript `if (spent + amount > pool) break` compares a
      // total this process is holding, so two disbursal runs against the same
      // batch would each stay under the pool on their own count and together
      // exceed it. Never splits a reward: the whole amount fits or the run
      // stops, leaving the queue intact for the next top-up.
      const reserved = await db.referrals.spendFromBatch(
        batchId, paiseToRupees(earning.amountPaise),
      );
      if (!reserved.ok) break;

      // Deterministic, so a re-run credits nothing further — the wallet
      // authority keys off this id, and two runs reaching the same earning
      // produce the SAME key and therefore one movement.
      const walletTxId = `ref_${earning.earningId}`;
      await creditWinnings(
        String(earning.earnerId),
        paiseToRupees(earning.amountPaise),
        `Referral reward — level ${earning.level}`,
        'ReferralEarning',
        String(earning.earningId),
        walletTxId,
      );

      // MONEY FIRST, then the status. `markPaid`'s `status = 'QUEUED'` guard is
      // what stops two disbursal runs paying the same earning: the loser gets
      // NOT_QUEUED, and because the wallet credit is keyed it moved nothing
      // either. The credit before the mark means a failure leaves a payable
      // earning and a keyed credit that the retry collides with — never a PAID
      // row with no money behind it.
      const marked = await db.referrals.markPaid(earning.earningId, { batchId, walletTxId });
      if (!marked.ok) continue;   // another run got there first

      spent += earning.amountPaise;
      paid += 1;
      lastPosition = earning.queuePosition;
    }

    // The programme budget is a second ceiling, enforced the same way: an
    // application-side check lets two concurrent disbursals both read the same
    // total and both pass it.
    if (spent > 0) await db.referrals.drawFromProgramme('main', paiseToRupees(spent));

    // The counts and the spend are already on the batch — `spendFromBatch`
    // moved them as each earning settled, so a crash mid-run leaves a batch
    // that reports what it actually did rather than nothing.
    await db.referrals.closeBatch(batchId, { lastQueuePosition: lastPosition });

    return {
      batchId, paid, blocked,
      spentPaise: spent,
      unspentPaise: pool - spent,
      lastQueuePosition: lastPosition,
    };
  } catch (err) {
    // Recorded as FAILED with what it managed to pay, so a half-run batch is
    // legible rather than looking like it never happened.
    await db.referrals.closeBatch(batchId, {
      lastQueuePosition: lastPosition, error: err.message,
    }).catch(() => { /* the throw below is the real signal */ });
    throw err;
  }
}

// ── Reporting ───────────────────────────────────────────────────────────────

/** The programme row, created on first read. */
export async function getProgramme() {
  return (await db.referrals.getProgramme('main'))
    ?? (await db.referrals.upsertProgramme({ key: 'main' }));
}

/** What the admin dashboard needs in one call. */
export async function programmeStats() {
  const programme = await getProgramme();
  // One statement for the whole queue: the counts, the money and the head of
  // the queue describe the same instant. Three reads a moment apart can show a
  // queue whose head has already been paid.
  const queue = await db.referrals.queueSummary();

  return {
    budgetPaise:     programme.budgetPaise,
    disbursedPaise:  programme.disbursedPaise,
    remainingPaise:  programme.budgetPaise - programme.disbursedPaise,
    memberCap:       programme.memberCap,
    verifiedMembers: programme.verifiedMembers,
    active:          programme.active,
    pendingCount:    queue.queuedCount,
    pendingPaise:    queue.queuedPaise,
    blockedCount:    queue.blockedCount,
    blockedPaise:    queue.blockedPaise,
    nextQueuePosition: queue.nextQueuePosition,
  };
}

/** One player's referral report, including WHY anything is unpaid. */
/**
 * A referrer's own report: what they are owed, what has been paid, and why any
 * of it is waiting.
 *
 * ── What a referrer may see about the people they invited ───────────────────
 * Their JOINING NUMBER and nothing else. Not a username, not a phone, not an
 * Aadhaar — a referrer has no business identifying the people beneath them, and
 * a leaderboard of "who did I recruit" is exactly the data a scraped referral
 * tree would want. The joining number is already the queue key, so it is the
 * one identifier that has to be visible for the ordering to be checkable.
 *
 * ── Why an earning is not income until the JOINER's KYC clears ──────────────
 * `eligibilityFor` refuses to pay a row whose source user is not VERIFIED, and
 * voids it outright on FAILED. Counting those ₹25s as "earned" would show a
 * referrer a number they may never receive, so they are reported separately as
 * awaiting verification.
 */
/**
 * Someone opened a referral link.
 *
 * ── Why a click is worth counting at all ────────────────────────────────────
 * A referrer who has sent their link to twenty people and signed up two cannot
 * tell which half is broken: nobody is opening it, or everybody opens it and
 * stops at the bot. Those need opposite responses, and signups alone cannot
 * distinguish them.
 *
 * ── Deduplication, and why it is an index rather than a check ───────────────
 * One tap produces more than one request: a WhatsApp or Telegram link preview
 * fetches the URL before the human sees it, and a back-button retry fetches it
 * again. Counting each would make the number flattering and useless.
 *
 * So a viewer is recorded once per code per 24 hours, and the unique index is
 * what enforces it — a read-then-write would double-count two taps that arrive
 * together, which is exactly what happens when a link is posted to a group.
 *
 * The address itself is never stored. It is keyed-hashed to something that can
 * recognise a repeat and do nothing else, and the row is deleted after a day.
 *
 * Never throws: this runs beside a redirect that must not be delayed or broken
 * by a counting failure.
 */
export async function recordReferralClick({ code, ip }) {
  if (!code) return { counted: false, reason: 'no_code' };

  // One click per viewer per code inside the window, decided by the unique
  // constraint rather than by a prior read two refreshes would both pass. The
  // expected duplicate is a link preview followed by the human's own tap.
  const { counted } = await db.referrals.recordClick({
    code, viewerHash: hashViewer(ip, code),
  });
  if (!counted) return { counted: false, reason: 'duplicate' };

  // The running total lives on the user so reading it is one column rather than
  // a count over rows that retention is continuously deleting — the evidence
  // expires, the aggregate must not.
  const bumped = await db.referrals.bumpClickCount(code);

  // A code nobody owns is not an error — it is a mistyped or retired link, and
  // the visitor was still sent to the bot. Reported as uncounted so the caller
  // can tell "nobody has this code" from "counted".
  return { counted: bumped, reason: bumped ? 'counted' : 'unknown_code' };
}

/**
 * A viewer identifier that cannot be turned back into an address.
 *
 * An IP has about 2^32 possible values, so a plain SHA-256 of one is reversible
 * by brute force in seconds — a hash without a key would not actually protect
 * anything. The key is DERIVED from an existing server secret rather than being
 * a new one to manage, and derivation means this use cannot leak the parent.
 *
 * The code is mixed in so the same viewer produces a different hash per link,
 * which stops the collection from becoming a way to correlate one person's
 * interest across every referrer on the platform.
 */
function hashViewer(ip, code) {
  const key = crypto.createHmac('sha256', String(process.env.PASETO_SECRET_KEY || 'referral-click'))
    .update('referral-click-viewer-salt')
    .digest();
  return crypto.createHmac('sha256', key).update(`${code}|${ip || ''}`).digest('hex').slice(0, 32);
}

export async function referralSummaryFor(userId, { limit = 200 } = {}) {
  const me = await db.users.getUser(userId);

  const rows = await db.referrals.listEarnings({ earnerId: userId, limit });

  // One query for every source, rather than one per row. A referral report can
  // list two hundred joiners, and a lookup each would be two hundred round
  // trips to render one page.
  const sourceIds = [...new Set(rows.map((r) => String(r.sourceUserId)))];
  const kycBySource = await db.identity.verificationStatusFor(sourceIds);

  // Per level, and per state within it. `confirmed` is the only figure a
  // referrer should treat as theirs.
  const empty = () => ({ count: 0, confirmedPaise: 0, awaitingKycPaise: 0, disbursedPaise: 0, blockedPaise: 0 });
  const byLevel = { 1: empty(), 2: empty() };

  const detail = rows.map((r) => {
    const sourceKyc = kycBySource.get(String(r.sourceUserId)) || 'PENDING_VERIFICATION';
    const bucket = byLevel[r.level] || (byLevel[r.level] = empty());
    bucket.count += 1;

    if (r.status === 'DISBURSED') {
      bucket.disbursedPaise += r.amountPaise;
      bucket.confirmedPaise += r.amountPaise;
    } else if (r.status === 'BLOCKED' || sourceKyc === 'FAILED') {
      bucket.blockedPaise += r.amountPaise;
    } else if (sourceKyc === 'VERIFIED') {
      bucket.confirmedPaise += r.amountPaise;
    } else {
      bucket.awaitingKycPaise += r.amountPaise;
    }

    return {
      // The invited player's joining number — the ONLY thing identifying them.
      joiningNumber: r.queuePosition,
      level: r.level,
      amount: paiseToRupees(r.amountPaise),
      kyc: sourceKyc,
      status: r.status,
      reason: r.blockedReason || '',
      disbursedAt: r.disbursedAt || null,
    };
  });

  const sum = (k) => (byLevel[1][k] || 0) + (byLevel[2][k] || 0);
  const level = (n) => ({
    count: byLevel[n].count,
    confirmed:    paiseToRupees(byLevel[n].confirmedPaise),
    awaitingKyc:  paiseToRupees(byLevel[n].awaitingKycPaise),
    disbursed:    paiseToRupees(byLevel[n].disbursedPaise),
    blocked:      paiseToRupees(byLevel[n].blockedPaise),
  });

  return {
    referralCode: me?.referralCode || '',
    joiningNumber: me?.joiningNumber ?? null,
    rewardPerReferral: paiseToRupees(REFERRAL_REWARD_PAISE),
    level1: level(1),
    level2: level(2),
    totals: {
      referrals:   detail.length,
      // Earned and confirmed — the joiner's KYC came back verified.
      confirmed:   paiseToRupees(sum('confirmedPaise')),
      // Already paid into the winnings wallet.
      disbursed:   paiseToRupees(sum('disbursedPaise')),
      // Confirmed but not yet paid — this is what the next disbursal draws on.
      nextDisbursal: paiseToRupees(sum('confirmedPaise') - sum('disbursedPaise')),
      // Waiting on the invited player's KYC. Not yours yet.
      awaitingKyc: paiseToRupees(sum('awaitingKycPaise')),
      blocked:     paiseToRupees(sum('blockedPaise')),
      // How many people opened the link, deduplicated per viewer per day.
      // Shown beside the signup count because the gap between the two is the
      // one number that says whether the link or the signup is the problem.
      clicks:      me?.referralClicks || 0,
    },
    rows: detail,
  };
}
