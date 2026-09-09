// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cashLink.service.js — supplying an ATM link, and telling the right merchants
 * there is work.
 *
 * The repository owns the queue and its locking. This owns the rules ABOUT the
 * queue: who may supply, for how long a link lives, and who hears that demand
 * exists. One place, so a second caller cannot supply a link and forget the
 * half that makes it useful.
 *
 * ── The broadcast is load-bearing, not a nicety ────────────────────────────
 * An expired link earns a merchant nothing — no compensation, no priority. That
 * is a deliberate choice, and it puts the entire weight of "do not waste a
 * merchant's trip" on this broadcast being accurate. Two things follow:
 *
 *   • Only orders with NO LINK YET are counted. A link is claimed the instant
 *     it exists, so an order that already has one is served, and advertising it
 *     sends somebody to a machine for work that no longer exists.
 *
 *   • Only merchants who can actually take it are told. On this rail a buy
 *     means the merchant receives cash and gives TOKENS, so a merchant without
 *     the tokens cannot serve it however close the ATM is.
 *
 * A merchant whose tokens are held on a withdrawal they have already paid is
 * still told, if that hold expires within the lookahead: those tokens come back
 * without them doing anything, and they will be able to serve by the time they
 * reach the machine.
 */
import { randomBytes } from 'node:crypto';
import { db } from '#db';
import {
  PAYMENT_MODES, getActivePolicy, concurrencyCapFor,
} from '#db/repositories/paymentModePolicy.js';
import { getAvailablePaiseFor } from '#db/repositories/merchantWallets.core.js';
import { emitMerchantUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';

/** How far ahead a releasing hold counts as headroom. */
const HEADROOM_LOOKAHEAD_SECONDS = 120;

const newLinkId = () => `clk_${randomBytes(12).toString('hex')}`;

/**
 * The merchants who should hear that orders are waiting at one denomination.
 *
 * Exported because the broadcast and the merchant's own "is it worth going"
 * read must agree — two implementations of "can this merchant serve one" would
 * put a different answer on the screen than in the notification.
 */
export async function suppliersWithHeadroom(denominationPaise) {
  const candidates = await db.merchants.cashSuppliersFor(denominationPaise, {
    lookaheadSeconds: HEADROOM_LOOKAHEAD_SECONDS,
  });
  if (!candidates.length) return [];

  // One batched read, so every candidate is judged against the same instant.
  const available = await getAvailablePaiseFor(candidates.map((c) => c.merchantId));
  const needed = Number(denominationPaise);

  return candidates.filter((c) => {
    // A merchant with NO wallet row is excluded, not treated as empty: no row
    // means the money system has never seen them, which is a different thing
    // from having nothing and routes differently.
    const now = available.get(String(c.merchantId));
    if (now === undefined) return false;
    return now + c.soonPaise >= needed;
  }).map((c) => c.merchantId);
}

/**
 * Tell every merchant who could serve it how deep their own queue is.
 *
 * Scoped to ONE denomination, because that is the only work any of them can
 * do — a ₹500 merchant seeing the ₹10,000 backlog learns nothing and is
 * tempted by an order they cannot take.
 */
export async function broadcastDemand(denominationPaise) {
  const waiting = await db.cashLinks.countOrdersAwaitingLink(denominationPaise);
  const merchantIds = await suppliersWithHeadroom(denominationPaise);

  const payload = { denominationPaise, waiting };
  for (const merchantId of merchantIds) {
    emitMerchantUpdate(merchantId, 'cash_link_demand', payload);
  }
  // Admins see both sides of the queue, across every denomination.
  emitAdminUpdate('cash_link_demand', payload);

  return { waiting, told: merchantIds.length };
}

/**
 * A merchant supplies the link their ATM just produced.
 *
 * Refuses with a NAMED reason rather than throwing, because every one of these
 * is something the merchant can act on — and a merchant standing at a machine
 * with a live link in their hand needs to know which rule stopped them, now.
 */
export async function supplyCashLink({ merchantId, merchant, paymentLink }) {
  const policy = await getActivePolicy();
  if (policy.activeMode !== PAYMENT_MODES.CASH_ATM) {
    return {
      ok: false,
      reason: 'WRONG_RAIL',
      message: 'The platform is not on the ATM cash rail right now, so a cash link cannot be used.',
    };
  }

  const denominationPaise = merchant?.cashDenominationPaise ?? null;
  if (denominationPaise === null) {
    return {
      ok: false,
      reason: 'NOT_APPROVED_FOR_CASH',
      message: 'You are not approved for the ATM cash rail. An admin sets the denomination you serve.',
    };
  }

  // ── One order at a time, and the LINK path has to obey it too ──────────
  //
  // `cash_link_one_live_per_merchant` stops a merchant holding two UNCLAIMED
  // links. It does nothing once one is claimed: the claim sets the row to
  // CLAIMED, the partial index stops matching, and they may supply again —
  // while already serving an order.
  //
  // That is not a small gap. The concurrency cap every other assignment obeys
  // lives in `selectBestMerchant`, and the cash-link claim does not go through
  // it: a link's owner BECOMES the order's merchant directly. So supply →
  // claimed → supply → claimed gives one merchant unbounded concurrent orders,
  // and on this rail the cap is ONE, because the notes they are holding are the
  // same notes and two orders would promise them twice.
  //
  // The count is DERIVED from the order rows by the same function the scorer
  // uses — never a stored counter, which a crash between increment and
  // decrement throttles a merchant with permanently.
  // From the one owner. On this rail it is 1 by derivation, not by configuration
  // — an admin cannot grant a merchant a second pair of hands.
  const cap = concurrencyCapFor(policy, merchant);
  const counts = await db.merchants.getActiveOrderCounts([merchantId]);
  const open = counts.get(String(merchantId))?.total ?? 0;
  if (open >= cap) {
    return {
      ok: false,
      reason: 'ALREADY_SERVING',
      message: open === 1
        ? 'You are already working an order. Finish it before going to another machine.'
        : `You are already working ${open} orders, which is the limit for this rail.`,
    };
  }

  // The expiry comes from the policy, and it is computed HERE rather than sent
  // by the merchant: a client-supplied lifetime is a client that can keep a
  // link alive as long as it likes.
  const expiresAt = new Date(Date.now() + policy.linkExpirySeconds * 1000);

  const result = await db.cashLinks.supplyLink({
    linkId: newLinkId(), merchantId, denominationPaise, paymentLink, expiresAt,
  });
  if (!result.ok) return result;

  // The queue got deeper on the supply side, so the demand figure every other
  // merchant at this denomination is looking at has changed.
  await broadcastDemand(denominationPaise);
  return result;
}

/**
 * Claim a link for a buy order, using the floor from the ORDER's own rail.
 *
 * The floor is read from the order's policy version, not the live one, for the
 * same reason its window is: an order created before a switch is still running
 * the process it was created under.
 */
export async function claimLinkFor(order) {
  if (order?.paymentMode !== PAYMENT_MODES.CASH_ATM) return { ok: false, reason: 'WRONG_RAIL' };

  const policy = (order.paymentModeVersion != null
    ? await db.paymentModePolicy.getPolicyVersion(order.paymentModeVersion)
    : null) ?? await getActivePolicy();

  const denominationPaise = Math.round(Number(order.tokenAmount) * 100);
  const claim = await db.cashLinks.claimLinkForOrder({
    orderId: order.orderId,
    denominationPaise,
    minRemainingSeconds: policy.linkMinRemainingSeconds,
  });

  // A claim removes an order from the waiting count, so what merchants are
  // being shown has changed whether or not it succeeded.
  if (claim.ok) await broadcastDemand(denominationPaise);
  return claim;
}

/**
 * Retire links whose time has run out, and refresh what merchants are seeing.
 *
 * A swept state rather than a timer: expiry has to survive a restart and
 * outlive any single request. Idempotent, so running it on several instances
 * retires each link once.
 */
export async function sweepExpiredLinks() {
  const expired = await db.cashLinks.expireDueLinks();
  if (!expired.length) return { expired: 0 };

  // Supply dropped at these denominations, so the merchants there should be
  // told there is still work — this is the moment a wasted trip is most
  // recoverable, because somebody else can still go.
  const denominations = [...new Set(expired.map((l) => l.denominationPaise))];
  for (const d of denominations) await broadcastDemand(d);

  return { expired: expired.length, denominations };
}
