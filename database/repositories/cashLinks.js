// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/cashLinks.js — the ATM cash-link queue.
 *
 * ── Supply before demand, which nothing else here does ─────────────────────
 * Every other assignment on this platform is demand-pull: an order arrives and
 * `merchantScoring` ranks candidates for it. Here a merchant stands at an ATM,
 * initiates a UPI cash withdrawal, and the machine hands them a payment link
 * for a fixed amount. That link exists BEFORE any order asks for it, and a buy
 * order of the same denomination claims it.
 *
 * So the interesting operation is not "pick a merchant" but "take a link
 * nobody else is taking", and that is a locking problem rather than a scoring
 * one. `merchantScoring` is not involved on this rail at all.
 *
 * ── What each part of the claim actually buys ──────────────────────────────
 * `FOR UPDATE` is the correctness half: without it a plain SELECT then UPDATE
 * lets two claimants read the same live link and both write it, sending two
 * players to collect one pile of notes.
 *
 * `SKIP LOCKED` is the CONTENTION half, and the distinction is worth stating
 * because it is easy to overclaim. Under plain `FOR UPDATE` PostgreSQL blocks
 * the second claimant, re-qualifies the row when the lock lifts, finds it no
 * longer LIVE and moves on to the next — so the OUTCOME is the same and a
 * mutation removing SKIP LOCKED cannot be killed by asserting on results. What
 * it changes is that claimants queue behind each other instead of fanning out,
 * which at a busy denomination is the difference between a claim taking
 * microseconds and taking as long as the transaction ahead of it.
 *
 * The unique index on `claimed_by_order` is the backstop under either.
 *
 * The "enough time left" floor is applied INSIDE the same statement, not by the
 * caller afterwards. A link with thirty seconds on it is worse than no link: a
 * player cannot reach the machine, and having been handed one they now believe
 * they have been served.
 *
 * ── A wasted trip buys priority, once ──────────────────────────────────────
 * An expired link earns no money — nothing moved, the ATM transaction simply
 * timed out — but the merchant still drove there. So their NEXT link is claimed
 * ahead of others at the same denomination.
 *
 * The credit is DERIVED and BOOLEAN: "you have an expired link newer than your
 * last claimed one". That shape is deliberate. A tally would need a decay rule
 * and a cap to stop a merchant farming priority by supplying links at dead
 * hours; a boolean gives ten wasted links exactly the priority of one, and a
 * single successful claim consumes it. Nothing is accumulated, so nothing can
 * be left stale by a crash.
 */
import { pgQuery, withTransaction } from '../client.js';

const toLink = (r) => (r ? {
  linkId: r.link_id,
  merchantId: r.merchant_id,
  denominationPaise: Number(r.denomination_paise),
  paymentLink: r.payment_link,
  status: r.status,
  claimedByOrder: r.claimed_by_order,
  claimedAt: r.claimed_at,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
} : null);

/**
 * A merchant supplies a link they have just produced at an ATM.
 *
 * The denomination is COPIED from the merchant here rather than joined at claim
 * time: an admin changing a merchant's approval must not silently re-price a
 * link already sitting in the queue, for the same reason an order snapshots the
 * rail it was created on.
 *
 * One live link per merchant is the index's rule. A second supply while one is
 * still live collides, and that is reported as a refusal the merchant can act
 * on rather than an unhandled 23505.
 */
export async function supplyLink({
  linkId, merchantId, denominationPaise, paymentLink, expiresAt,
}) {
  if (!linkId) throw new Error('supplyLink requires a linkId');
  if (!merchantId) throw new Error('supplyLink requires a merchantId');
  if (!paymentLink || !String(paymentLink).trim()) {
    return { ok: false, reason: 'LINK_REQUIRED', message: 'A cash link cannot be empty — paste the link the ATM produced.' };
  }
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new TypeError('supplyLink requires an expiresAt Date');
  }

  try {
    const { rows } = await pgQuery(
      `INSERT INTO cash_link_queue
         (link_id, merchant_id, denomination_paise, payment_link, status, expires_at)
       VALUES ($1, $2, $3, $4, 'LIVE', $5)
       RETURNING *`,
      [String(linkId), String(merchantId), Number(denominationPaise),
       String(paymentLink).trim(), expiresAt],
      'cash_link_supply',
    );
    return { ok: true, link: toLink(rows[0]) };
  } catch (err) {
    if (err.constraint === 'cash_link_one_live_per_merchant') {
      return {
        ok: false,
        reason: 'LINK_ALREADY_LIVE',
        message: 'You already have a live link waiting. Wait for it to be taken or to expire before supplying another — you can only be at one machine.',
      };
    }
    if (err.constraint === 'cash_link_denomination_known') {
      return { ok: false, reason: 'UNKNOWN_DENOMINATION', message: 'That is not an amount an ATM dispenses.' };
    }
    if (err.constraint === 'cash_link_expiry_after_creation') {
      return { ok: false, reason: 'ALREADY_EXPIRED', message: 'That link expires in the past.' };
    }
    if (err.code === '23505') {
      return { ok: false, reason: 'DUPLICATE_LINK', message: 'That link id already exists.' };
    }
    throw err;
  }
}

/**
 * An order takes the oldest live link of its denomination that still has time
 * on it — and the order row is stamped in the SAME transaction.
 *
 * Both writes commit together or neither does. Claiming the link and then
 * stamping the order would leave, if the second write failed, a link marked
 * taken by an order that does not know it — a player waiting forever beside a
 * link nothing will ever hand them.
 *
 * Oldest-first, deliberately: a link is perishable, so the one closest to
 * expiring is the one to use before it is wasted.
 */
export async function claimLinkForOrder({
  orderId, denominationPaise, minRemainingSeconds,
}) {
  if (!orderId) throw new Error('claimLinkForOrder requires an orderId');
  const remaining = Number(minRemainingSeconds);
  if (!Number.isFinite(remaining) || remaining < 0) {
    throw new TypeError(`claimLinkForOrder: minRemainingSeconds must be a non-negative number, got ${minRemainingSeconds}`);
  }

  try {
    return await withTransaction(async (client) => {
      const { rows: found } = await client.query(
        `SELECT l.link_id FROM cash_link_queue l
          WHERE l.status = 'LIVE'
            AND l.denomination_paise = $1
            -- The floor, applied HERE rather than by the caller. A link with
            -- seconds left is worse than none: the player cannot reach the
            -- machine, but now believes they have been served.
            AND l.expires_at > now() + make_interval(secs => $2)
          ORDER BY
            -- A merchant whose LAST trip was wasted goes first.
            --
            -- Derived from the rows, never accumulated: a counter of wasted
            -- trips would be incremented in one place and decremented in
            -- another, and a crash between them would throttle or favour a
            -- merchant permanently with nothing able to correct it.
            --
            -- It is also self-consuming, which is what makes it un-farmable
            -- without a decay rule or a cap. The credit is "you have an
            -- expired link newer than your last claimed one" — a boolean, not
            -- a tally. Supplying ten links at a dead hour earns exactly the
            -- same priority as one, and the moment a link of theirs IS
            -- claimed, the credit is gone.
            (EXISTS (
               SELECT 1 FROM cash_link_queue e
                WHERE e.merchant_id = l.merchant_id
                  AND e.status = 'EXPIRED'
                  AND e.created_at > COALESCE((
                        SELECT MAX(c.created_at) FROM cash_link_queue c
                         WHERE c.merchant_id = l.merchant_id AND c.status = 'CLAIMED'
                      ), '-infinity'::timestamptz)
            )) DESC,
            l.expires_at ASC
          LIMIT 1
          FOR UPDATE OF l SKIP LOCKED`,
        [Number(denominationPaise), remaining],
      );
      if (!found.length) return { ok: false, reason: 'NO_LINK_AVAILABLE' };

      const linkId = found[0].link_id;
      const { rows: claimed } = await client.query(
        `UPDATE cash_link_queue
            SET status = 'CLAIMED', claimed_by_order = $1, claimed_at = now()
          WHERE link_id = $2 AND status = 'LIVE'
          RETURNING *`,
        [String(orderId), linkId],
      );
      // The row was taken between the lock and the write, which SKIP LOCKED
      // makes vanishingly unlikely but not impossible. Report it as "none
      // available" so the caller retries rather than treating it as an error.
      if (!claimed.length) return { ok: false, reason: 'NO_LINK_AVAILABLE' };

      const { rowCount } = await client.query(
        `UPDATE order_states SET cash_link_id = $1, updated_at = now()
          WHERE order_id = $2 AND cash_link_id IS NULL`,
        [linkId, String(orderId)],
      );
      // The order already holds a link, or does not exist. Either way this
      // claim must not stand — rolling back returns the link to the queue.
      if (rowCount !== 1) {
        throw Object.assign(new Error('ORDER_NOT_CLAIMABLE'), { code: 'ORDER_NOT_CLAIMABLE' });
      }

      return { ok: true, link: toLink(claimed[0]) };
    });
  } catch (err) {
    if (err.code === 'ORDER_NOT_CLAIMABLE') {
      return { ok: false, reason: 'ORDER_ALREADY_LINKED' };
    }
    if (err.constraint === 'cash_link_one_per_order') {
      return { ok: false, reason: 'ORDER_ALREADY_LINKED' };
    }
    throw err;
  }
}

/**
 * Retire links whose time has run out.
 *
 * A swept state rather than a timer, for the same reason the withdrawal hold
 * is: expiry has to survive a restart and outlive any one request. Idempotent,
 * so running it twice or on several instances retires each link once.
 *
 * An expired link owes nobody anything — no money moved, the ATM transaction
 * simply timed out — so this writes no compensation and no priority.
 */
export async function expireDueLinks() {
  const { rows } = await pgQuery(
    `UPDATE cash_link_queue SET status = 'EXPIRED'
      WHERE status = 'LIVE' AND expires_at <= now()
      RETURNING link_id, merchant_id, denomination_paise`,
    [], 'cash_link_expire_due',
  );
  return rows.map((r) => ({
    linkId: r.link_id,
    merchantId: r.merchant_id,
    denominationPaise: Number(r.denomination_paise),
  }));
}

/** A merchant withdrawing a link they can no longer honour. */
export async function cancelLink(linkId, merchantId) {
  const { rows } = await pgQuery(
    `UPDATE cash_link_queue SET status = 'CANCELLED'
      WHERE link_id = $1 AND merchant_id = $2 AND status = 'LIVE'
      RETURNING *`,
    [String(linkId), String(merchantId)], 'cash_link_cancel',
  );
  return toLink(rows[0]);
}

/** The link this merchant currently has waiting, if any. */
export async function getLiveLinkFor(merchantId) {
  const { rows } = await pgQuery(
    `SELECT * FROM cash_link_queue
      WHERE merchant_id = $1 AND status = 'LIVE' AND expires_at > now()`,
    [String(merchantId)], 'cash_link_live_for_merchant',
  );
  return toLink(rows[0]);
}

/** The link serving an order, for the screen that shows the player where to go. */
export async function getLinkForOrder(orderId) {
  const { rows } = await pgQuery(
    'SELECT * FROM cash_link_queue WHERE claimed_by_order = $1',
    [String(orderId)], 'cash_link_for_order',
  );
  return toLink(rows[0]);
}

/**
 * How many buy orders are waiting for a link at ONE denomination.
 *
 * This is the number the broadcast shows a merchant, and it is scoped to their
 * own denomination because that is the only work they can do. Counting orders
 * that already hold a link would advertise demand that is already served and
 * send merchants to an ATM for nothing — and with no compensation for a wasted
 * trip, that accuracy is what keeps supply coming.
 */
export async function countOrdersAwaitingLink(denominationPaise) {
  const { rows } = await pgQuery(
    `SELECT COUNT(*)::int AS n
       FROM order_states
      WHERE order_type = 'DEPOSIT'
        AND payment_mode = 'CASH_ATM'
        AND state = 'PENDING_QUEUE'
        AND cash_link_id IS NULL
        AND token_amount_paise = $1`,
    [Number(denominationPaise)], 'cash_link_demand_at_denomination',
  );
  return rows[0]?.n ?? 0;
}

/** The same count for every denomination at once, for an admin overview. */
export async function demandByDenomination() {
  const { rows } = await pgQuery(
    `SELECT token_amount_paise AS denomination_paise, COUNT(*)::int AS waiting
       FROM order_states
      WHERE order_type = 'DEPOSIT'
        AND payment_mode = 'CASH_ATM'
        AND state = 'PENDING_QUEUE'
        AND cash_link_id IS NULL
      GROUP BY token_amount_paise
      ORDER BY token_amount_paise`,
    [], 'cash_link_demand_all',
  );
  return rows.map((r) => ({
    denominationPaise: Number(r.denomination_paise),
    waiting: r.waiting,
  }));
}

/** Live supply per denomination, so an admin can see both sides of the queue. */
export async function supplyByDenomination() {
  const { rows } = await pgQuery(
    `SELECT denomination_paise, COUNT(*)::int AS live
       FROM cash_link_queue
      WHERE status = 'LIVE' AND expires_at > now()
      GROUP BY denomination_paise
      ORDER BY denomination_paise`,
    [], 'cash_link_supply_all',
  );
  return rows.map((r) => ({
    denominationPaise: Number(r.denomination_paise),
    live: r.live,
  }));
}
