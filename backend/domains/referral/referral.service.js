// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/referral/referral.service.js — attribution and the payout queue.
 *
 * Two responsibilities, deliberately kept apart:
 *
 *   RECORDING an earning happens when a user finishes onboarding. It is cheap,
 *   synchronous, and must be exactly-once — the same reward may never be booked
 *   twice for one joiner.
 *
 *   PAYING an earning happens a moment later, by itself: the
 *   `referral-autopay` cron pays the whole queue every minute (owner,
 *   2026-10-20: "auto deducted from that total token"), and an admin may run
 *   it at once with an amount. It walks the queue in joining order and moves
 *   real money, so it re-checks eligibility at that moment rather than
 *   trusting what was true when the earning was made. There is no programme
 *   budget: a bonus comes out of the platform's own token holding, bounded
 *   only by the supply (`treasury_supply_ceiling`); the ₹400 crore ceiling and
 *   the paused/active switch were removed (owner, 2026-10-20).
 *
 * Money movement itself is delegated to `db.promo.creditReferralBonus`, which
 * pays the GENERAL balance and opens the bonus's turnover requirement in one
 * transaction, keyed by the earning. This module never touches a balance
 * directly.
 */
import { db } from '#db';
import crypto from 'crypto';
import { referralRewardsFrom } from './referralRewards.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { paiseToRupees } from '../../shared/money.js';

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
 * Earnings are RECORDED by `db.referrals.recordJoinerEarnings`, inside the
 * transaction that verifies the joiner's mobile (the Mini App contact share,
 * `database/repositories/telegram.js`). A referral counts only once the joiner
 * is verified (owner, 2026-10-07), and booking it in that same transaction
 * means a verified joiner always has their referrer's earning and an
 * unverified one never does — there is no window where one exists without the
 * other. The derived earning id and `ON CONFLICT DO NOTHING` make a replayed
 * verification book nothing further.
 */

// ── Eligibility ─────────────────────────────────────────────────────────────

/**
 * Decide whether one earning may be paid RIGHT NOW.
 *
 * Every condition here is something that can change between earning and payout,
 * which is why none of them are baked in at attribution time. The returned
 * reason is shown to the player verbatim on their referral report — "why is
 * this reward still pending" should never require a support ticket.
 */
export async function eligibilityFor(earning) {
  const earner = await db.users.getUser(earning.earnerId);
  if (!earner) return { ok: false, reason: 'Referrer account no longer exists' };
  if (earner.isBlocked || earner.status === 'BLOCKED') {
    return { ok: false, reason: 'Referrer account is blocked' };
  }

  // No KYC condition (removed 2026-10-02 with KYC itself), and no channel
  // condition (the channel gate was removed in Step 3, owner 2026-10-07). The
  // joiner earned this only by verifying their mobile; the referrer must hold a
  // verified Telegram link too — the same proof, asked of both ends.
  const link = await db.telegram.getLinkByUserId(earning.earnerId);
  if (!link) return { ok: false, reason: 'Referrer has not verified their mobile in Telegram' };

  return { ok: true };
}

// ── Disbursal ───────────────────────────────────────────────────────────────

/**
 * Pay down the queue from a pool: the whole queue (the `referral-autopay`
 * cron, `payReferralQueue`) or an amount an admin entered.
 *
 * Who gets paid is never chosen by hand — the queue decides, strictly in
 * joining order, which is what makes the programme defensible to the people
 * waiting in it.
 *
 * Ineligible rows are marked BLOCKED with a reason and SKIPPED WITHOUT
 * consuming pool: an ineligible row upstream must not deprive the next
 * eligible person of their turn.
 *
 * @param {object} args
 * @param {number} args.poolPaise  how much this run may pay
 * @param {string|null} args.actorId  the admin, or null for the cron
 * @param {number} [args.maxRows]  safety bound per run
 */
export async function disburse({ poolPaise, actorId, maxRows = 50_000 }) {
  if (!(poolPaise > 0)) {
    throw Object.assign(new Error('Disbursal amount must be positive'), { status: 400 });
  }
  const pool = poolPaise;

  const batchId = `refdisb_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  await db.referrals.openBatch({ batchId, poolRupees: paiseToRupees(pool), actorId });

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
      // Into the GENERAL (promotional) balance, with its 10× turnover
      // requirement opened in the same transaction — never straight into
      // withdrawable winnings (owner, 2026-10-08; `db.promo`).
      const credited = await db.promo.creditReferralBonus({
        userId: String(earning.earnerId),
        amountPaise: earning.amountPaise,
        earningId: String(earning.earningId),
        reason: `Referral bonus — level ${earning.level}`,
      });
      if (!credited.ok) throw new Error(`referral bonus refused: ${credited.refused}`);

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

/**
 * Pay every queued earning now, in joining order: the `referral-autopay`
 * cron. The pool is exactly what the queue holds at this moment, so a run
 * never pays more than was owed when it started; an earning booked during the
 * run waits for the next minute. Null when nothing is queued.
 */
export async function payReferralQueue() {
  const { queuedPaise } = await db.referrals.queueSummary();
  if (!(queuedPaise > 0)) return null;
  return disburse({ poolPaise: queuedPaise, actorId: null });
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
    paidPaise:       queue.paidPaise,
    paidCount:       queue.paidCount,
    memberCap:       programme.memberCap,
    verifiedMembers: programme.verifiedMembers,
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
 * Their JOINING NUMBER and nothing else. Not a username, not a phone — a referrer has no business identifying the people beneath them, and
 * a leaderboard of "who did I recruit" is exactly the data a scraped referral
 * tree would want. The joining number is already the queue key, so it is the
 * one identifier that has to be visible for the ordering to be checkable.
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
  const rewards = referralRewardsFrom(await getSystemConfig());

  const rows = await db.referrals.listEarnings({ earnerId: userId, limit });

  // Per level, and per state within it. `confirmed` is the only figure a
  // referrer should treat as theirs.
  const empty = () => ({ count: 0, confirmedPaise: 0, disbursedPaise: 0, blockedPaise: 0 });
  // Every level the admin pays today, plus any older level an earning has.
  const byLevel = Object.fromEntries(rewards.levelsPaise.map((_, i) => [i + 1, empty()]));

  const detail = rows.map((r) => {
    const bucket = byLevel[r.level] || (byLevel[r.level] = empty());
    bucket.count += 1;

    if (r.status === 'DISBURSED') {
      bucket.disbursedPaise += r.amountPaise;
      bucket.confirmedPaise += r.amountPaise;
    } else if (r.status === 'BLOCKED') {
      bucket.blockedPaise += r.amountPaise;
    } else {
      // An earning exists only for a joiner who completed the Telegram step
      // (that claims the joining number), so there is nothing left to wait on.
      bucket.confirmedPaise += r.amountPaise;
    }

    // No joining number, theirs or anyone's (owner, 2026-10-14: "remove
    // them"). Nothing here identifies the person invited.
    return {
      level: r.level,
      amount: paiseToRupees(r.amountPaise),
      status: r.status,
      reason: r.blockedReason || '',
      disbursedAt: r.disbursedAt || null,
    };
  });

  const sum = (k) => Object.values(byLevel).reduce((t, b) => t + (b[k] || 0), 0);
  const level = (n) => ({
    level: n,
    // What a NEW joiner earns at this level now; 0 when the level is off.
    reward: paiseToRupees(rewards.levelsPaise[n - 1] ?? 0),
    count: byLevel[n].count,
    confirmed:    paiseToRupees(byLevel[n].confirmedPaise),
    disbursed:    paiseToRupees(byLevel[n].disbursedPaise),
    blocked:      paiseToRupees(byLevel[n].blockedPaise),
  });

  return {
    referralCode: me?.referralCode || '',
    // Per level, level 1 first: what a NEW joiner earns now (the admin's
    // settings) and the totals so far; what each earning below pays is the
    // amount stamped on it when its joiner verified.
    levels: Object.keys(byLevel).map(Number).sort((a, b) => a - b).map(level),
    totals: {
      referrals:   detail.length,
      // Earned and confirmed — not blocked.
      confirmed:   paiseToRupees(sum('confirmedPaise')),
      // Already paid into the GENERAL balance.
      disbursed:   paiseToRupees(sum('disbursedPaise')),
      // Confirmed but not yet paid — this is what the next disbursal draws on.
      nextDisbursal: paiseToRupees(sum('confirmedPaise') - sum('disbursedPaise')),
      blocked:     paiseToRupees(sum('blockedPaise')),
      // How many people opened the link, deduplicated per viewer per day.
      // Shown beside the signup count because the gap between the two is the
      // one number that says whether the link or the signup is the problem.
      clicks:      me?.referralClicks || 0,
    },
    rows: detail,
  };
}
