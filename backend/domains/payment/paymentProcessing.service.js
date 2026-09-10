// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/payment/paymentProcessing.service.js — deposits and withdrawals.
 *
 * ── Withdrawal admission is ONE decision, under the wallet's row lock ───────
 * This path is where money LEAVES the platform. It used to admit a withdrawal
 * by reading the player's winnings, summing their in-flight withdrawals, and
 * comparing — three reads, then a debit, with nothing holding them together.
 * Two requests arriving together both passed.
 *
 * Worse, the pending-order sum DOUBLE-COUNTED. The escrow debit moves winnings
 * into `lockedBalance`, so an in-flight withdrawal is already out of the
 * winnings figure the check compared against: a player with ₹1,000 who asked
 * for ₹400 was left holding winnings ₹600 and locked ₹400, and their next ₹400
 * request was refused by `400 + 400 > 600` — against money they genuinely had.
 * The guard both let overdrafts through under concurrency and refused
 * legitimate withdrawals the rest of the time.
 *
 * `debitWinningsForWithdrawal` decides. It moves winnings → locked under
 * `SELECT … FOR UPDATE` on the wallet row, in the same transaction as its
 * ledger entry, and refuses what the row cannot fund. There is nothing left
 * here to get wrong, because there is no check here.
 *
 * ── The order is created in one statement ───────────────────────────────────
 * It used to be a `new PaymentOrder(...)` with a pre-save hook computing the
 * deposit split invisibly, then a `save()`, then further writes. The split is
 * explicit now (`db.depositPolicy.splitForDeposit`) and the order arrives
 * complete — allocations, escrow flag, bank details and all — so it can never
 * be picked up by the assignment sweep in a half-built state.
 *
 * NOTE: this file calls the Merchant domain's `selectBestMerchant()` directly.
 * That is pre-existing cross-domain coupling, flagged per BBEPS Phase 003 §3.7.
 */
import crypto from 'crypto';
import { db } from '#db';
// One owner for what a token is worth: the INR peg, and the two USDT legs.
import {
  INR_TOKEN_RATE, rateForMerchant, tokensPerUsdt, usdtForTokens,
} from '../configuration/tokenRates.js';
import { debitWinningsForWithdrawal, refundWithdrawal, getBalances } from '../wallet/walletAuthority.service.js';
import { selectBestMerchant } from '../merchant/merchantScoring.service.js';
import { claimLinkFor } from '../merchant/cashLink.service.js';
import {
  MERCHANT_CURRENCY, merchantTypeOf, usdtAddressFor,
  USDT_CHAIN_SPEC, USDT_CHAINS, isUsdtChain,
} from '../merchant/merchantCurrency.js';
// Risk Platform (Phase 010): the single validation authority for funding orders.
import { assessFundingOrder, getRiskRules, computePayoutFeeMinor } from '../risk/riskValidation.service.js';
// What a valid payment reference looks like on this order, what to call it, and
// the ONE place any of them is claimed. A UTR, a chain transaction hash and a
// CDM slip's bank id are the same fact — this payment happened, once.
import { referenceSpecFor, claimPaymentReference } from './paymentReference.js';
// The order state machine. Every status change goes through here so an illegal
// move is refused by the database rather than by whichever check ran first.
import {
  assignOrder as assignOrderState, markOrderPaid as markOrderPaidState,
  cancelOrder as cancelOrderState,
} from './orderLifecycle.service.js';
import { emitWalletUpdate, emitOrderUpdate, emitMerchantUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';
import { getSystemConfig } from '#db/repositories/config.js';
import {
  PAYMENT_MODES,
  getActivePolicy as getActivePaymentModePolicy,
  getPolicyVersion as getPaymentModePolicyVersion,
} from '#db/repositories/paymentModePolicy.js';
// The denomination ladder and the split rule. One owner — the same module the
// risk gate validates buys against and `systemConfigPayload` builds the picker
// from, so the amounts a screen offers, the amounts the gate accepts and the
// amounts a withdrawal splits into cannot disagree.
import {
  WITHDRAWAL_DENOMINATIONS_PAISE, USDT_BUY_DENOMINATIONS_PAISE,
  splitWithdrawal, shareFeeAcrossParts,
} from '../merchant/denominations.js';
import { rupeesToPaise, paiseToRupees } from '../../shared/money.js';
// The KYC gate for money IN, and the sentences that explain a refusal. Imported
// rather than restated: the route in front of this used one rule and this file
// used a stricter one, and the stricter copy silently won.
import { isKycLinked, isKycApproved, kycRefusalFor } from '../identity/kycGates.js';
// The per-order payment link has one owner, and it is not the client.
import { upiPaymentLink } from './paymentLink.js';
// The only shape of an order a player receives.
import { toPlayerOrderView } from './playerOrderView.js';
// The mirror of it, pointing the other way: the one shape a MERCHANT receives.
// This service pushes to both parties, so it needs both projections.
import { toMerchantOrderView } from '../merchant/merchantOrderView.js';

// ─── Shared admin SSE payload ─────────────────────────────────────────────────
function adminOrderPayload(order, user) {
  return {
    _id:            order.orderId,
    orderId:        order.orderId,
    type:           order.type,
    status:         order.status,
    fiatAmount:     order.fiatAmount,
    tokenAmount:    order.tokenAmount,
    userName:       user?.username,
    userMobile:     user?.mobile,
    userId:         user?.userId || order.userId,
    merchantProfit: order.merchantProfit || 0,
    rateUsed:       order.rateUsed,
    createdAt:      order.createdAt,
    server_ts:      Date.now(),
  };
}

// ─── Build merchantSnapshot from a merchant row ───────────────────────────────
/**
 * How a merchant is named to anybody who is not them.
 *
 * A persisted, NON-IDENTIFYING reference. Exported because the admin assignment
 * routes had their own copy of this and of the snapshot builder — one owner.
 */
export function merchantDisplayRef(merchant) {
  return `Merchant #${merchant.publicRef}`;
}

/**
 * What was true about the merchant at the moment of assignment.
 *
 * ── Two audiences, and only one of them gets the credentials ──────────────
 * This row is what a dispute is decided from months later, so it keeps the
 * merchant's details: which handle was quoted, which account, at what time.
 * The admin and the disputes desk read the row.
 *
 * The PLAYER does not. `playerOrderView.js` is the only shape that reaches them
 * and it passes on three things from here — the payment link, an opaque
 * reference, and the deadline. Before that projection existed this whole object
 * was sent as-is, so every deposit handed the player the merchant's UPI handle,
 * their QR, and their bank account number, IFSC and account-holder name. The
 * screen rendered the handle in a copy-to-clipboard row.
 *
 * ── The link is built HERE, once ──────────────────────────────────────────
 * The panel used to assemble the UPI intent out of these fields, which is why it
 * had to be given them. Building it server-side is what makes the projection
 * above achievable rather than aspirational, and it puts the amount formatting
 * on the side that cannot be edited by whoever is holding the phone.
 */
function buildMerchantSnapshot(merchant, expiresAt, order = null) {
  const upiId = merchant.bankDetails?.upiId || '';
  const merchantRef = merchantDisplayRef(merchant);
  return {
    // ── For the player, through `toPlayerOrderView` ─────────────────────
    merchantRef,
    // Null on the USDT rail and when the merchant has no handle on file, which
    // a screen must render as "waiting for details" rather than as a button
    // that does nothing.
    paymentLink: order
      ? upiPaymentLink({
          payeeUpiId: upiId,
          payeeName: merchantRef,
          amountRupees: order.fiatAmount ?? order.amount,
          orderId: order.orderId,
        })
      : null,

    // ── For the player, on the USDT rail ───────────────────────────────
    // Where to send, and on WHICH network. Both, always together: an address
    // without its chain is how somebody sends BEP-20 tokens to a Tron address
    // and loses them, and this is the one field on the platform where a
    // mistake is unrecoverable.
    //
    // ONLY the chain this order asked for. The merchant's address on the other
    // chain is not part of this order and is not sent — the same allowlist
    // reasoning as everything else the player receives.
    usdtChain:     order?.usdtChain ?? null,
    usdtPayTo:     order?.usdtChain ? usdtAddressFor(merchant, order.usdtChain) : null,
    usdtChainLabel: order?.usdtChain ? (USDT_CHAIN_SPEC[order.usdtChain]?.label ?? null) : null,

    // ── For the admin and the disputes desk, from the row ───────────────
    merchantId:    merchant.merchantId,
    merchantName:  merchantRef,
    // A merchant settles on exactly one rail, so exactly one credential set is
    // populated: UPI/bank for an INR merchant, the wallet addresses for a USDT
    // one. Both chains are recorded here because a dispute months later is
    // decided from what was true at assignment.
    merchantType:  merchantTypeOf(merchant),
    upiId,
    bankName:      merchant.bankDetails?.bankName          || '',
    accountNo:     merchant.bankDetails?.accountNo         || '',
    ifsc:          merchant.bankDetails?.ifsc              || '',
    accountHolder: merchant.bankDetails?.accountHolderName || '',
    usdtAddressTrc20: merchant.usdtAddressTrc20 || '',
    usdtAddressBep20: merchant.usdtAddressBep20 || '',
    snapshotAt:    new Date(),
    expiresAt,
  };
}

// ─── Payment order window ─────────────────────────────────────────────────────
//
// How long a user has to pay the assigned merchant before the order expires and
// refunds. Owned by `payment_mode_policies.processing_window_seconds`.
//
// ── Why it moved off SystemConfig.orderExpiryMinutes ─────────────────────────
// The two settlement rails have DIFFERENT timelines by design: paying a
// merchant's UPI and drawing cash at an ATM are not the same act and do not
// take the same time. One global number cannot express that, so the window
// belongs to the policy that also names the rail. The existing value was
// carried forward into the seeded policy (see schema.sql) so nothing an admin
// tuned was discarded, and `orderExpiryMinutes` is gone — two owners for one
// number is how they drift.
//
// ── Why it reads the ORDER's version, not the active one ─────────────────────
// This runs at ASSIGNMENT, on an order whose rail was stamped at creation. If
// an admin switched the rail in between, the order is still running the process
// it was created under and must be held to that rail's window — otherwise a
// player is given a deadline for a workflow they were never shown.
//
// There is no hardcoded fallback. The column is NOT NULL with a CHECK that it
// is positive, and the schema seeds a version 1, so a policy always exists; a
// literal here would be a second owner waiting to disagree with the first.
async function getOrderExpiryMs(order = null) {
  const policy = (order?.paymentModeVersion != null
    ? await getPaymentModePolicyVersion(order.paymentModeVersion)
    : null) ?? await getActivePaymentModePolicy();
  return policy.processingWindowSeconds * 1000;
}

/**
 * Assign a cash-rail BUY by claiming a link from the queue.
 *
 * The claim and the order's own stamp commit together inside the repository,
 * so an order never ends up holding a link the queue does not agree it has.
 * What is left here is the ASSIGNMENT: the link's supplier becomes the
 * merchant, and the order moves to ASSIGNED with the same lifecycle call the
 * UPI rail uses — the state machine stays the one owner of a state change.
 *
 * The expiry is the link's, not the rail's processing window. The player has
 * until the ATM transaction times out and not a second longer, so a window
 * from the policy would promise time the machine will not give them.
 */
/**
 * Claim a link for a buy order and assign its owner as the merchant.
 *
 * EXPORTED for the suite that covers its rollback. The failure it has to survive
 * is a transition refused AFTER the claim has committed — the order moved under
 * it — and that cannot be staged from outside without being able to hand this
 * function an order whose row has already moved on. A test that tried to time it
 * would be asserting about scheduling instead of about the rollback, and what is
 * at stake is a consumed link no merchant can be sent with.
 */
export async function tryClaimCashLink(order) {
  const claim = await claimLinkFor(order);
  if (!claim.ok) return false;

  const moved = await assignOrderState(order.orderId, {
    set: {
      merchantId: claim.link.merchantId,
      assignedAt: new Date(),
      // The machine's deadline, not ours.
      expiresAt: claim.link.expiresAt,
    },
  });
  if (!moved.ok || moved.idempotent) {
    // ── Give the link back ────────────────────────────────────────────────
    // The claim committed BEFORE this transition was attempted, so a refusal
    // here leaves the link consumed and the order still PENDING_QUEUE holding a
    // link id. Nothing about either row looks wrong: the link is out of the
    // queue so no merchant can be sent with it, and the order shows a payment
    // link nobody is working. Two people waiting on a link doing nothing for
    // either of them, until it expires.
    //
    // The release is guarded on this order's own claim, so it can never take a
    // link away from an order that IS being served, and it is not fatal: the
    // caller's answer is still "not assigned" whether or not the tidy-up
    // worked, and failing the request would turn a recoverable state into an
    // error the player sees.
    await db.cashLinks.releaseClaim({ linkId: claim.link.linkId, orderId: order.orderId })
      .catch((e) => console.error(`[cashLink] could not release ${claim.link.linkId}:`, e.message));
    return false;
  }

  // Keep the caller's in-memory copy consistent with the row that now exists,
  // so the emitters below describe reality rather than a hoped-for state.
  Object.assign(order, {
    merchantId: claim.link.merchantId,
    status: 'ASSIGNED',
    assignedAt: moved.order.assignedAt,
    expiresAt: claim.link.expiresAt,
    cashLinkId: claim.link.linkId,
  });
  return true;
}

/**
 * Hand waiting orders the links that have appeared since they were created.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 * The claim ran exactly ONCE per order, at creation. An order created at a
 * moment when no merchant held a link at its denomination therefore never got
 * one — nothing looked again when the link it had been waiting for was supplied
 * a minute later. The player watched a live order sit at PENDING_QUEUE until it
 * expired while a merchant stood at a machine with a link nobody took. Both
 * sides waiting for each other, and every check in this repository green.
 *
 * ── It lives HERE, not in the link service ────────────────────────────────
 * Because it must go through `tryClaimCashLink`, which is the COMPLETE
 * operation: claim the link, assign its owner as the order's merchant, and take
 * the machine's deadline as the order's. Calling the raw claim instead stamps a
 * link id onto an order that still has no merchant and is still PENDING_QUEUE —
 * a half-assignment, which is worse than no assignment because the player sees
 * a link and nobody is serving them.
 *
 * ── Order matters, and it is the design's order ───────────────────────────
 * Best claim first: a retry outranks a first attempt, because sending somebody
 * who already waited and got nothing to the back of the same queue is how they
 * wait twice and get nothing twice. Age breaks the tie.
 *
 * Safe to run from anywhere and from several places at once — the claim takes
 * the link `FOR UPDATE … SKIP LOCKED` with a unique index behind it, so two
 * matchers hand each link to exactly one order and the loser finds nothing.
 * A failure on one order does not stop the rest: the next one is a different
 * player, and one bad row must not hold up everybody behind it.
 */
export async function matchWaitingOrdersToLinks({ limit = 100 } = {}) {
  const rail = await getActivePaymentModePolicy();
  if (rail?.activeMode !== PAYMENT_MODES.CASH_ATM) return { matched: 0, considered: 0 };

  const waiting = await db.orders.ordersAwaitingCashLink({ limit });
  let matched = 0;
  for (const order of waiting) {
    try {
      if (await tryClaimCashLink(order)) {
        matched += 1;
        emitAdminUpdate('queue_order_update', {
          orderId: order.orderId, status: 'ASSIGNED', server_ts: Date.now(),
        });
      }
    } catch (error) {
      console.error(`[cashLink] could not match order ${order.orderId}:`, error.message);
    }
  }
  return { matched, considered: waiting.length };
}

// ─── Attempt to assign order to best merchant; returns true if assigned ────────
async function tryAssignMerchant(order) {
  // ── On the cash rail, a BUY is assigned by taking a link, not by ranking ──
  //
  // The merchant is already standing at the machine. Their link is the supply,
  // and whoever supplied the one this order takes IS the merchant serving it —
  // so there is nothing to score. Ranking candidates here would pick a merchant
  // who has no link, and the player would be assigned somebody who is not at an
  // ATM.
  //
  // Withdrawals on this rail still go through the scorer below: the merchant
  // deposits at a CDM, which is not a link and has no queue.
  if (order.paymentMode === PAYMENT_MODES.CASH_ATM && order.type === 'DEPOSIT') {
    return tryClaimCashLink(order);
  }

  // Pass the order's rail: `selectBestMerchant` matches it against the
  // merchant's accepted currencies, so a USDT order can only reach a USDT
  // merchant and an INR order only an INR merchant. The argument was once
  // omitted and every order fell back to the 'INR' default, which would have
  // routed a USDT order to an INR merchant (2026-07-27).
  // The order's OWN rail, not the one live now: on CASH_ATM the amount is a
  // denomination a merchant must be approved for, and the concurrency cap is
  // the one that rail promised them.
  const merchant = await selectBestMerchant(order.type, order.tokenAmount, order.currency, {
    paymentMode: order.paymentMode,
    paymentModeVersion: order.paymentModeVersion,
    // On USDT, the chain the player chose. A merchant holding only a TRC-20
    // address cannot receive a BEP-20 payment, so they are not a candidate at
    // all — the alternative is assigning an order the merchant must refuse,
    // with the player already waiting.
    usdtChain: order.usdtChain ?? null,
  });
  if (!merchant) return false;

  // ── The quote is NOT re-made here ───────────────────────────────────────
  // A USDT order was priced at creation, from the rate live at that moment, and
  // the player was shown the USDT figure before they agreed to anything. This
  // used to read the rate again and overwrite `rateUsed` with whatever it was
  // when a merchant happened to accept — minutes later, and an admin edit in
  // between silently re-priced a purchase already agreed to.
  //
  // So the order's OWN rate is what stands. It is read back rather than
  // recomputed, and only an order that somehow has none falls through to the
  // merchant's rail rate.
  const rateUsed = order.rateUsed ?? rateForMerchant(merchant, await getSystemConfig());
  if (rateUsed === null) {
    console.error(
      `[assignment] ${order.orderId}: merchant ${merchant.merchantId} settles in USDT and `
      + 'usdtPricing.userMerchantBuyInr is not set — leaving the order queued rather than pricing it at the INR peg',
    );
    return false;
  }

  // The window of the rail THIS order was created on, not the rail live now.
  const expiresAt = new Date(Date.now() + await getOrderExpiryMs(order));
  const snapshot  = buildMerchantSnapshot(merchant, expiresAt, order);

  // The transition is the gate. Two assignment passes racing the same queued
  // order — the synchronous attempt at creation and the retry loop, which do
  // overlap — both used to pass a `status === 'PENDING_QUEUE'` read and both
  // used to save, so the second silently overwrote the first merchant's
  // assignment. Exactly one caller now matches a row.
  const moved = await assignOrderState(order.orderId, {
    set: {
      merchantId:       merchant.merchantId,
      assignedAt:       new Date(),
      expiresAt,
      merchantSnapshot: snapshot,
      rateUsed,
    },
  });
  if (!moved.ok || moved.idempotent) return false;

  // Keep the caller's in-memory copy consistent with what was written, so the
  // emitters below describe the row that exists rather than a hoped-for one.
  Object.assign(order, {
    merchantId: merchant.merchantId,
    rateUsed,
    status: 'ASSIGNED',
    assignedAt: moved.order.assignedAt,
    expiresAt,
    merchantSnapshot: snapshot,
  });

  // No activeOrderCount increment. That counter is DERIVED from the orders
  // themselves (`db.merchants.getActiveOrderCounts`), so there is nothing to
  // bump and nothing to leave stale when an assignment is refused — which is
  // precisely how a merchant ended up holding a count for an order they did
  // not have.

  // Notify merchant via SSE (GOVERNANCE §11: new_order)
  //
  // Through the projection. This spread the WHOLE order — `...order` — to the
  // merchant's stream at the moment of assignment: the player's phone number,
  // their UPI id, their bank details on a deposit, the platform's treasury
  // split and the risk verdicts on the player, all of it. `check:merchant-
  // privacy` was green throughout because it only read `merchant.routes.js`,
  // and this line is in a service.
  emitMerchantUpdate(String(merchant.merchantId), 'new_order', {
    ...toMerchantOrderView(order),
    server_ts: Date.now(),
  });

  // Notify user: order_assigned (GOVERNANCE §11)
  emitOrderUpdate(String(order.userId), 'order_assigned', {
    orderId:          order.orderId,
    _id:              order.orderId,
    // `payTo`, not the snapshot. This pushed the whole thing — the merchant's
    // handle, their QR and their bank account — to the player's socket the
    // instant an order was assigned.
    payTo:            toPlayerOrderView(order).payTo ?? null,
    expiresAt:        order.expiresAt,
    status:           'ASSIGNED',
    server_ts:        Date.now(),
  });

  return true;
}

// ─── Short merchant-search retry loop when no merchant available ─────────────
// Owner directive (2026-07-14): retry at most TWICE (30s apart); if no merchant
// is found after those 2 attempts, FAIL the order (CANCELLED/EXPIRED) instead of
// keeping the user waiting for minutes. Uses a setTimeout chain — NOT a cron job.
// NOTE: an initial assignment was already attempted synchronously at order
// creation; this loop is the fallback, capped at 2 tries (~60s) then fail.
function startPendingRetryLoop(orderId) {
  const MAX_RETRIES = 2; // 2 × 30s ≈ 1 min, then fail (was 10 = 5 min)
  let attempts = 0;

  async function attempt() {
    attempts++;
    try {
      const order = await db.orders.getOrderRecord(orderId);
      if (!order || order.status !== 'PENDING_QUEUE') return; // already assigned/cancelled

      if (await tryAssignMerchant(order)) {
        emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'ASSIGNED', server_ts: Date.now() });
        return;
      }

      if (attempts >= MAX_RETRIES) {
        // Expire the order. The transition gates the refund: this loop and the
        // expireOrders cron can both reach the same order, and only the caller
        // that actually moved it may release the escrow.
        const expired = await cancelOrderState(order.orderId, {
          expectFrom: 'PENDING_QUEUE',
          set: { cancelReason: 'EXPIRED', cancelledAt: new Date() },
        });
        if (!expired.ok || expired.idempotent) return;
        order.status = 'CANCELLED';

        // Release escrow if WITHDRAWAL
        if (order.type === 'WITHDRAWAL' && order.escrowLocked) {
          await refundWithdrawal(order.userId, order.tokenAmount, order.orderId)
            .catch(e => console.error('[startPendingRetryLoop] escrow release failed:', e.message));
        }

        emitOrderUpdate(String(order.userId), 'order_expired', {
          orderId:   order.orderId,
          _id:       order.orderId,
          status:    'CANCELLED',
          reason:    'EXPIRED',
          server_ts: Date.now(),
        });
        emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'CANCELLED', reason: 'EXPIRED' });
        return;
      }

      setTimeout(attempt, 30 * 1000);
    } catch (err) {
      console.error('[startPendingRetryLoop] attempt error:', err.message);
      if (attempts < MAX_RETRIES) setTimeout(attempt, 30 * 1000);
    }
  }

  setTimeout(attempt, 30 * 1000); // first retry after 30s
}

// ═════════════════════════════════════════════════════════════════════════════
// createDepositOrder
// ═════════════════════════════════════════════════════════════════════════════
/**
 * @param attempt `{ priority, retryOf }` when this is a second attempt at an
 *   order that never found a merchant. Both are written with the row and
 *   decide nothing else: the retry is an ORDINARY order, and the only thing
 *   that treats it differently is the queue ordering.
 */
export async function createDepositOrder(userId, tokenAmount, attempt = {}) {
  const cfg        = await getSystemConfig();

  // ── Which rail is this buy on, and on which chain ───────────────────────
  // INR unless the caller says USDT. The provider registry is what says so —
  // the player's request reaches this through `requestDeposit({ provider })`,
  // so which rail serves an amount stays a decision the SERVER makes.
  const currency = attempt.currency === MERCHANT_CURRENCY.USDT
    ? MERCHANT_CURRENCY.USDT : MERCHANT_CURRENCY.INR;
  const usdtChain = currency === MERCHANT_CURRENCY.USDT ? attempt.usdtChain ?? null : null;
  if (currency === MERCHANT_CURRENCY.USDT && !isUsdtChain(usdtChain)) {
    // Named, and refused BEFORE anything is written. A USDT order with no chain
    // matches no merchant, so it would sit in the queue until it expired while
    // the screen said "waiting for a merchant" — and the player would never
    // learn that the request was malformed.
    throw Object.assign(
      new Error(`Choose the network you will send USDT on: ${USDT_CHAINS.join(' or ')}.`),
      { status: 400, code: 'USDT_CHAIN_REQUIRED' },
    );
  }

  // Risk Platform gate (Phase 010): positive/numeric/multiples-of-10,
  // min/max, velocity — the single validation authority.
  // The rail this order is ABOUT to be created on. `createOrderRecord` stamps
  // the same active policy a moment later, so the amount is judged against the
  // rail the order will actually run on. Omitting it here would leave the
  // denomination rule silently never firing — the failure mode this whole
  // guard exists to prevent, one layer up.
  // ── The min and max, from the rail this buy is actually on ─────────────
  // `minDeposit`/`maxDeposit` are the INR rail's, and the INR rail's maximum is
  // ₹50,000 by default — BELOW the larger USDT denomination. Judging a USDT buy
  // against them refused every ₹100,000 purchase with "Maximum purchase is
  // 50000 BB tokens", a sentence about a limit that does not govern that rail.
  //
  // On USDT the DENOMINATIONS are the limit: there are exactly two amounts and
  // `assertBuyIsLegal` refuses everything else, so the bounds are derived from
  // that list rather than being a second, looser statement of it.
  const usdtBounds = {
    min: Math.min(...USDT_BUY_DENOMINATIONS_PAISE) / 100,
    max: Math.max(...USDT_BUY_DENOMINATIONS_PAISE) / 100,
  };
  const minDeposit = currency === MERCHANT_CURRENCY.USDT ? usdtBounds.min : (cfg?.minDeposit || 100);
  const maxDeposit = currency === MERCHANT_CURRENCY.USDT ? usdtBounds.max : (cfg?.maxDeposit || 50000);

  const railNow = await getActivePaymentModePolicy();
  await assessFundingOrder({
    userId, tokenAmount, type: 'DEPOSIT', min: minDeposit, max: maxDeposit,
    paymentMode: railNow.activeMode,
    // The CURRENCY decides which rules apply: the USDT rail has two fixed
    // amounts and no cash denominations, the INR rail has its ceiling. Omitting
    // it here would judge a USDT buy against the INR rules and refuse every one
    // for being over the ceiling.
    currency,
  });

  const user = await db.users.getUser(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.isBlocked) {
    throw Object.assign(
      new Error('Your account has been suspended due to payment violations. Contact support.'),
      { status: 403, code: 'USER_BLOCKED' },
    );
  }
  // ── Money IN needs identity LINKED, not approved ────────────────────────
  //
  // Owner decision: an Aadhaar submitted and waiting on a verifier is enough to
  // fund an account. Verification runs in batches and the player can do nothing
  // to hurry it, so holding deposits behind it loses the player without
  // protecting anyone — the protection that matters is on the way OUT, where
  // `requestWithdrawal` still demands APPROVED.
  //
  // This read `!== 'APPROVED'`, which contradicted `requireLinkedKyc` on the
  // route in front of it: every PENDING_APPROVAL player passed the gate built
  // to admit them and was refused here, with a message that named neither their
  // status nor what to do. Same predicate as the middleware now, so the two cannot
  // drift apart again.
  if (!isKycLinked(user.kycStatus)) {
    throw Object.assign(
      new Error(kycRefusalFor(user.kycStatus)),
      { status: 403, code: 'KYC_NOT_LINKED', kycStatus: user.kycStatus },
    );
  }

  // ── What the player actually pays, and in what ──────────────────────────
  //
  // On the INR rails: the peg. 1 BB token = ₹1, no buy/sell spread (Phase 006
  // flattening, 2026-07-08) — merchant earnings come from the cycle-completion
  // Merchant Performance Bonus, never from a rate spread. Named rather than a
  // bare 1 so the rule is legible and has one owner.
  //
  // On the USDT rail: a USDT amount, derived from the admin's rate. The
  // denomination is what the player RECEIVES (50,000 / 100,000 / 500,000
  // tokens); this is what they SEND.
  //
  // ── And it is fixed HERE, at creation, not at assignment ────────────────
  // The rate is admin-editable. `rateUsed` was stamped when a merchant was
  // chosen, which is minutes later — so a player was quoted one USDT amount on
  // the screen and the order recorded whatever the rate happened to be when
  // somebody accepted it. An admin editing the rate in between silently
  // re-priced a purchase already agreed to.
  //
  // The quote is the contract. It is written with the order, and the
  // assignment path is forbidden from touching it.
  let fiatAmount = tokenAmount * INR_TOKEN_RATE;
  let rateUsed = INR_TOKEN_RATE;
  if (currency === MERCHANT_CURRENCY.USDT) {
    const quoted = usdtForTokens(tokenAmount, cfg);
    const rate = tokensPerUsdt(cfg);
    // NO FALLBACK. The schema default is 0 and 0 is not a rate: dividing by it
    // gives Infinity USDT, and substituting 1 would sell 50,000 tokens for
    // 50,000 USDT. A caller that cannot price a purchase must refuse it.
    if (quoted === null || rate === null) {
      throw Object.assign(
        new Error('USDT pricing has not been set. Contact support.'),
        { status: 503, code: 'USDT_RATE_UNSET' },
      );
    }
    fiatAmount = quoted;
    rateUsed = rate;
  }

  // ── The split, computed HERE ────────────────────────────────────────────
  // This was a pre-save hook on the order model: invisible, and a second
  // writer to a value with a designated owner. The service that computes the
  // note below used to derive it from its own stale local variables while the
  // hook silently overwrote the persisted ones — so the order was right and
  // the message describing it was wrong. One computation, one source.
  const split = await db.depositPolicy.splitForDeposit(tokenAmount, user.currency || 'INR');

  // Created COMPLETE, in one statement. It used to be a save followed by
  // further writes, and between them the order existed at PENDING_QUEUE with a
  // zero allocation — visible to the assignment sweep in that state, and stuck
  // there for good if the process died in between.
  const order = await db.orders.createOrderRecord({
    orderId:           `DEP_${crypto.randomBytes(12).toString('hex')}`,
    userId:            user.userId,
    type:              'DEPOSIT',
    tokenAmountRupees: tokenAmount,
    fiatAmountRupees:  fiatAmount,
    // A second attempt goes to the front of the queue. Nothing else about it
    // differs — the guards above are the same guards, because this is the same
    // function.
    assignmentPriority: attempt.priority ?? 0,
    retryOfOrderId:     attempt.retryOf ?? null,
    // The peg on an INR buy; tokens-per-USDT on a USDT one. Written HERE and
    // not re-stamped at assignment — see the quote above.
    rateUsed,
    // The rail this buy runs on, and — on USDT — the chain the player chose.
    // Both are frozen: the chain by a trigger, because the merchant snapshot
    // carries the address for this chain alone.
    currency,
    usdtChain,
    merchantProfit:    0,
    depositAllocation: split.depositAllocation,
    reserveAllocation: split.reserveAllocation,
    depositPolicySnapshot: split.snapshot,
  });

  emitAdminUpdate('new_order', adminOrderPayload(order, user));

  // Auto-assign merchant immediately
  if (await tryAssignMerchant(order)) {
    emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'ASSIGNED', server_ts: Date.now() });
  } else {
    startPendingRetryLoop(order.orderId);
  }

  // THROUGH the projection, not a literal that happens to agree with it.
  //
  // This was a hand-written list of eight fields — a second owner of "what a
  // player sees", which is how the two drift. It already carried two the
  // projection would have to decide about, and a field added to the order for
  // one screen would have had to be added here too, by somebody remembering.
  return {
    order: toPlayerOrderView(order),
    // Built from the STORED figures, so the message and the order agree — and
    // in the CURRENCY the player actually sends. Saying "₹500" to somebody
    // about to transfer 500 USDT names the wrong thing entirely.
    note: currency === MERCHANT_CURRENCY.USDT
      ? `You will send ${fiatAmount.toLocaleString('en-IN')} USDT to receive `
        + `${tokenAmount.toLocaleString('en-IN')} BB tokens `
        + `(${order.depositAllocation} betting + ${order.reserveAllocation} reserve)`
      : `You will pay ₹${fiatAmount.toLocaleString()} to receive ${tokenAmount} BB tokens (${order.depositAllocation} betting + ${order.reserveAllocation} reserve)`,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// createWithdrawalOrder
// ═════════════════════════════════════════════════════════════════════════════
/**
 * @param attempt `{ priority, retryOf }` — see `createDepositOrder`. On a split
 *   the label goes on the FIRST part only, because a partial unique index
 *   allows one retry per expired order and every part is a separate withdrawal.
 *   The priority goes on all of them: they are all second attempts.
 */
export async function createWithdrawalOrder(userId, tokenAmount, attempt = {}) {
  const cfg         = await getSystemConfig();
  const minWithdraw = cfg?.minWithdrawal || 500;
  const maxWithdraw = cfg?.maxWithdrawal || 50000;

  await assessFundingOrder({ userId, tokenAmount, type: 'WITHDRAWAL', min: minWithdraw, max: maxWithdraw });

  const user = await db.users.getUser(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.isBlocked) {
    throw Object.assign(
      new Error('Your account has been suspended due to payment violations. Contact support.'),
      { status: 403, code: 'USER_BLOCKED' },
    );
  }
  // Money OUT is the stricter rule, and deliberately not the one above: a
  // deposit needs identity LINKED, a withdrawal needs it APPROVED. Same owner
  // for both predicates so the asymmetry is stated once rather than inferred
  // from two string comparisons that could drift apart.
  if (!isKycApproved(user.kycStatus)) {
    throw Object.assign(
      new Error('Your Aadhaar must be verified before you can withdraw.'),
      { status: 403, code: 'KYC_NOT_APPROVED', kycStatus: user.kycStatus },
    );
  }
  if (!user.bankDetails?.accountNumber || !user.bankDetails?.ifscCode) {
    throw Object.assign(new Error('Please add your bank account details before withdrawing'), { status: 400 });
  }

  // Phase 010: a configurable payout fee (SystemConfig.payoutFeePercent —
  // Business Policy owns the number, Risk owns the arithmetic) may be deducted
  // from the fiat paid out. Default 0%.
  const riskRules      = await getRiskRules();
  const payoutFeeMinor = computePayoutFeeMinor(tokenAmount, riskRules.payoutFeePercent);
  const payoutFee      = payoutFeeMinor / 100;
  const fiatAmount     = tokenAmount - payoutFee;

  // ── SPLIT, decided BEFORE any money moves ───────────────────────────────
  //
  // An ATM dispenses denominations, not amounts, so on the cash rail a payout
  // larger than ₹40,000 is not one job — it is several merchants at several
  // machines.
  //
  // ── Several ORDINARY withdrawals, not a parent and its legs ─────────────
  // Each part below is a complete withdrawal in its own right: its own escrow
  // lock, its own assignment, its own cancel, its own dispute, its own release.
  // Nothing downstream branches on whether an order came from a split, which is
  // the point — the first version made a container row and every query in the
  // system then had to decide whether it counted containers or the work inside
  // them, and one of the six that had to decide was a money guard.
  //
  // The reliability argument is the stronger one. A crash partway through this
  // loop leaves N valid withdrawals and nothing dangling: the money that moved
  // is locked against orders that exist, and the money that did not move is
  // still the player's. A container holding an escrow with only some of its
  // legs written is a withdrawal that does not add up, and no row looks wrong.
  //
  // What gets split is the FIAT figure, because that is the cash that reaches a
  // machine. The fee rides on the token side — see `shareFeeAcrossParts`.
  //
  // This runs before any debit deliberately. An amount no set of denominations
  // can make is one no merchant can pay at a machine, and discovering that
  // AFTER a debit means unwinding a lock that has already committed.
  const rail = await getActivePaymentModePolicy();
  const fiatPaise = rupeesToPaise(fiatAmount);
  const feePaise = rupeesToPaise(payoutFee);

  // One part for an ordinary withdrawal, several for a split. The loop below
  // does not know which it is, so there is exactly one creation path and the
  // split is not a special case of anything.
  let parts = [{ tokenPaise: rupeesToPaise(tokenAmount), fiatPaise }];
  let batchRef = null;

  if (rail?.activeMode === PAYMENT_MODES.CASH_ATM) {
    const cashParts = splitWithdrawal(fiatPaise);
    if (!cashParts) {
      // Named amounts, not "invalid amount". The player cannot guess which
      // figures a cash machine can make, and the fee means the payable figure
      // is not the one they typed.
      const tiers = WITHDRAWAL_DENOMINATIONS_PAISE.map((p) => `₹${paiseToRupees(p).toLocaleString('en-IN')}`);
      throw Object.assign(
        new Error(
          `Cash withdrawals are paid at an ATM, so the payout must be made up of ${tiers.join(', ')}`
          + `. ₹${fiatAmount.toLocaleString('en-IN')} cannot be.`,
        ),
        { status: 400, code: 'NOT_A_CASH_AMOUNT' },
      );
    }
    if (cashParts.length > 1) {
      parts = shareFeeAcrossParts(cashParts, feePaise);
      // A LABEL, not a relation. It groups the siblings so the player is told
      // "part 2 of 4" and support can pull the set; nothing derives state from
      // it, no money reads it, and no assignment consults it.
      batchRef = `WB_${crypto.randomBytes(8).toString('hex')}`;
    }
  }

  // ── ADMISSION, once per part ────────────────────────────────────────────
  // The escrow debit IS the gate, and it is the whole gate: winnings → locked
  // under `SELECT … FOR UPDATE` on the wallet row, in one transaction with its
  // ledger entry, refusing what the row cannot fund. Idempotent on `wd_<id>`.
  //
  // It runs BEFORE each order row exists. A failed debit therefore leaves
  // nothing behind to undo — the alternative, writing the order first, means a
  // refused debit needs a compensating delete that can itself fail, and a
  // crash between the two leaves an escrow-flagged order holding money that
  // was never taken.
  //
  // The three checks that used to precede it are gone. See the module header:
  // they raced each other AND double-counted the escrow, so they admitted
  // overdrafts under concurrency and refused legitimate withdrawals otherwise.
  //
  // ── Part by part, and a refusal partway is not a broken state ───────────
  // Each part debits its OWN amount against its OWN order id. There is no
  // pooled lock to reconcile and no compensating refund to get wrong: if the
  // wallet refuses part three, parts one and two are complete withdrawals the
  // player actually has, and the money for part three never left winnings.
  //
  // That is the whole reliability argument for flat siblings, and it is why
  // this does not pre-check the total. A pre-check is exactly what the module
  // header says was removed for racing the debit and double-counting escrow;
  // the debit under the row lock is the only honest gate, and running it N
  // times just means the gate is consulted N times.
  const created = [];
  let debitResult = null;
  let refusal = null;

  for (const [index, part] of parts.entries()) {
    const partOrderId = `WD_${crypto.randomBytes(12).toString('hex')}`;
    const partTokens = paiseToRupees(part.tokenPaise);
    const partFiat   = paiseToRupees(part.fiatPaise);

    let debited;
    try {
      debited = await debitWinningsForWithdrawal(String(user.userId), partTokens, partOrderId);
    } catch (err) {
      if (err.code === 'INSUFFICIENT_WITHDRAWABLE') {
        // Nothing was taken for this part. If earlier parts succeeded they are
        // real withdrawals and stay — reversing them would be a compensating
        // action that can itself fail, over money the player is entitled to.
        if (created.length) { refusal = err; break; }

        // The figures come off the refusal, from the rows the debit locked —
        // never from a record read separately, which is how a player was once
        // told an available balance no wallet ever held.
        const pending = await db.orders.pendingWithdrawalTotal(user.userId);
        throw Object.assign(
          new Error(
            `Insufficient winnings balance. Available: ${err.availableWinnings} tokens`
            + (pending > 0 ? ` (${pending} already committed to withdrawals in progress).` : '.'),
          ),
          {
            status: 400,
            balance: { winnings: err.availableWinnings, pending },
          },
        );
      }
      throw err;
    }
    // The LAST successful debit's balances are what the response reports, so
    // the figure the player is shown is the one the wallet holds after
    // everything this request did.
    debitResult = debited;

    const partOrder = await db.orders.createOrderRecord({
      orderId:           partOrderId,
      userId:            user.userId,
      type:              'WITHDRAWAL',
      tokenAmountRupees: partTokens,
      fiatAmountRupees:  partFiat,
      // The fee this part carries — its own share, not the whole. It is the
      // gap between the tokens debited and the cash paid out, part by part.
      payoutFee:         partTokens - partFiat,
      rateUsed:          INR_TOKEN_RATE,
      escrowLocked:      true,
      escrowStatus:      'LOCKED',
      escrowAmount:      partTokens,
      withdrawalBatchRef: batchRef,
      // Every part of a retried withdrawal is a second attempt, so all of them
      // carry the rank. The retry LABEL goes on the first part only: the
      // partial unique index allows one retry per expired order, and each part
      // is a separate withdrawal that would otherwise collide on it.
      assignmentPriority: attempt.priority ?? 0,
      retryOfOrderId:     index === 0 ? (attempt.retryOf ?? null) : null,
      // A merchant verifies a payout against these. `userKycSnapshot` was removed
      // 2026-08-25: it was stripped from every response before it reached anyone,
      // and its `aadhaar` field was never a real path on the model.
      userBankDetails: {
        accountNumber:     user.bankDetails?.accountNumber || '',
        ifscCode:          user.bankDetails?.ifscCode      || '',
        bankName:          user.bankDetails?.bankName      || '',
        accountHolderName: user.bankDetails?.accountHolderName || user.username || '',
        upiId:             user.bankDetails?.upiId || '',
      },
      userPhone: user.mobile,
    });

    emitAdminUpdate('new_order', adminOrderPayload(partOrder, user));

    if (await tryAssignMerchant(partOrder)) {
      emitAdminUpdate('queue_order_update', { orderId: partOrder.orderId, status: 'ASSIGNED', server_ts: Date.now() });
    } else {
      // Sell orders become an open merchant pool item immediately. They do not
      // consume the deposit retry loop because any eligible merchant may accept
      // them later as their sell capacity opens up.
      emitAdminUpdate('queue_order_update', {
        orderId: partOrder.orderId, status: 'PENDING_QUEUE', pool: 'SELL_OPEN_POOL', server_ts: Date.now(),
      });
    }

    created.push({ ...partOrder, partIndex: index + 1 });
  }

  await emitWalletUpdate(user.userId);

  // The first part is what the caller has always been handed back. On an
  // ordinary withdrawal it is the only one.
  const order = created[0];
  const paidOut = created.reduce((sum, o) => sum + Number(o.fiatAmount || 0), 0);

  return {
    // Through the projection, for the reason the deposit above is: one owner of
    // the player's shape. It carries `userBankDetails` (their own account, which
    // the sell screen renders masked) and `withdrawalBatchRef` (the label that
    // groups the siblings of this request — a screen says "part 1 of 4" from it;
    // nothing decides anything by it).
    order: toPlayerOrderView(order),
    // Every withdrawal this request actually created, as PARTS — deliberately
    // not `orders`, and deliberately not order-shaped. Four fields a progress
    // list needs, so nothing here has to be projected or kept in step with the
    // player's view. One entry on an ordinary withdrawal: the shape does not
    // change, so a caller never has to ask whether this was a split.
    parts: created.map((o) => ({
      orderId:   o.orderId,
      partIndex: o.partIndex,
      amount:    o.fiatAmount,
      status:    o.status,
    })),
    // From the movement that actually happened, not from a record read before
    // it. `debitResult.balances` is what the wallet holds now.
    remainingBalance: {
      deposit:  debitResult.balances?.depositBalance ?? 0,
      winnings: debitResult.balances?.winningsBalance ?? 0,
      total:    (debitResult.balances?.depositBalance ?? 0) + (debitResult.balances?.winningsBalance ?? 0),
    },
    note: created.length > 1
      ? `An ATM pays fixed amounts, so this is ${created.length} separate withdrawals`
        + ` totalling ₹${paidOut.toLocaleString('en-IN')}. Each is paid by its own merchant.`
      : `You will receive ₹${paidOut.toLocaleString('en-IN')} from merchant`,
    // Said plainly, and only when it happened. Some parts were created and the
    // wallet refused the rest — those are real withdrawals the player has, and
    // reversing them would be a compensating action over money they are owed.
    ...(refusal ? {
      partial: {
        requested: fiatAmount,
        created: paidOut,
        message: `Only ₹${paidOut.toLocaleString('en-IN')} of ₹${fiatAmount.toLocaleString('en-IN')} could be`
          + ' withdrawn — your balance changed while this was being set up.'
          + ' The parts that were created are being paid; request the rest again.',
      },
    } : {}),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// markOrderPaid  — user submits the UTR (DEPOSIT only)
//
// ── The screenshot is gone, deliberately ─────────────────────────────────────
// A screenshot proved nothing. It is trivially forged, nobody's approval
// depended on it, and the merchant confirms against their own bank statement —
// the UTR is what they match on, and it is the only piece of this submission
// the platform can actually verify.
//
// It was not free, either. It is a user-supplied image, uploaded to durable
// storage, retained, and carrying whatever else happened to be on the player's
// screen. Collecting an identifying artefact that no decision reads is exactly
// the data a platform should not hold.
//
// What did the real work is still here and unchanged: the registry claims
// the reference in ONE statement, so the same UTR cannot be spent on two
// orders, and the state transition is the gate for the response.
//
// The `proofScreenshot` COLUMN stays: orders that already carry an image still
// display it and the retention job still expires it. Only the collection of new
// ones is gone, and with it the presign route that produced the keys — so an
// optional key parameter here would be a parameter nothing on the platform can
// now supply.
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Try again, at the front of the queue.
 *
 * ── What a retry is, and what it is not ───────────────────────────────────
 * An order that never found a merchant owes nothing — no assignment means no
 * transaction happened and nobody is liable. But the player still wants their
 * tokens, and sending them to the back of the queue that just failed them is
 * how somebody waits twice and gets nothing twice. So the new order carries
 * priority, and the matcher walks the queue best-claim-first.
 *
 * It is a NEW order, not a revival. CANCELLED is terminal — reviving it would
 * mean widening `ALLOWED_FROM` to let any cancelled order in the system come
 * back to life, which is a hole opened platform-wide to describe one button.
 *
 * ── It goes through the ordinary creation path, deliberately ──────────────
 * KYC, the amount limits, the denomination rule, the one-open-buy rule, the
 * escrow debit under the wallet's row lock: every guard a first attempt passes,
 * a retry passes too, because it is the SAME function. A bespoke retry path is
 * a second creation path, and the second one is where a guard goes missing —
 * which on a withdrawal means locking money without the checks that decide
 * whether it may be locked.
 *
 * The database refuses a second retry of the same order (a partial UNIQUE on
 * `retry_of_order_id`). Two live orders for one intent is two merchants
 * assigned on a buy, and on a SELL it is the player's tokens locked twice.
 */
export async function retryOrder(userId, orderId) {
  const original = await db.orders.getOrderRecord(orderId);
  if (!original) throw Object.assign(new Error('Order not found'), { status: 404 });
  if (String(original.userId) !== String(userId))
    throw Object.assign(new Error('Access denied'), { status: 403 });

  // Only an order that ended with nothing having happened. A COMPLETED order
  // has been paid, a PAID one is being worked, and a DISPUTED one is somebody
  // else's decision — "try again" is not the right offer for any of them.
  const retryable = ['CANCELLED', 'FAILED', 'REJECTED'].includes(original.status);
  if (!retryable) {
    throw Object.assign(
      new Error(`This order is ${original.status}. Only an order that ended without being served can be retried.`),
      { status: 409, code: 'NOT_RETRYABLE' },
    );
  }

  const attempt = { priority: 1, retryOf: original.orderId };
  const result = original.type === 'DEPOSIT'
    ? await createDepositOrder(userId, original.tokenAmount, attempt)
    : await createWithdrawalOrder(userId, original.tokenAmount, attempt);

  return result;
}

/**
 * The player taps "I have paid" and claims their minute to find the UTR.
 *
 * ── What this is protecting ───────────────────────────────────────────────
 * The order's own timer IS the UTR deadline. A player who taps with fifteen
 * seconds left is not going to find a twelve-character bank reference in
 * fifteen seconds, and the order expiring under them cancels a payment they
 * have ALREADY MADE — the worst outcome this flow has, because the money is
 * gone and the order is not.
 *
 * ── The window is the admin's, and this is what makes it real ─────────────
 * `utrSubmitSeconds` has been in `payment_mode_policies` and on the admin
 * screen, labelled "how long the player has to submit the UTR after clicking
 * Paid", since the policy was built — and nothing read it. A value an operator
 * can edit is only configuration if something consults it; until this, it was a
 * number that decided nothing.
 *
 * Read from the ORDER's rail, not the live one. An order held across a rail
 * switch keeps the process it was created under, so it keeps that rail's
 * window too.
 *
 * ── Once ──────────────────────────────────────────────────────────────────
 * The repository decides that in the UPDATE's WHERE clause. Refusing a second
 * claim is not tidiness: without it a player taps every fifty seconds and holds
 * a merchant's capacity open indefinitely.
 */
export async function claimUtrGrace(userId, orderId) {
  const order = await db.orders.getOrderRecord(orderId);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
  if (String(order.userId) !== String(userId))
    throw Object.assign(new Error('Access denied'), { status: 403 });
  if (order.type !== 'DEPOSIT')
    throw Object.assign(new Error('Only a buy order takes a UTR'), { status: 400 });

  const policy = order.paymentModeVersion
    ? await getPaymentModePolicyVersion(order.paymentModeVersion)
    : await getActivePaymentModePolicy();
  const graceSeconds = policy?.utrSubmitSeconds ?? 60;

  const extended = await db.orders.claimUtrGrace(order.orderId, userId, graceSeconds);
  if (!extended) {
    // Two different refusals, said differently, because the player can act on
    // one and not the other. Already claimed: the deadline on screen is the
    // real one. Wrong state: the order moved on, and re-tapping will not help.
    if (order.utrGraceAt) {
      throw Object.assign(
        new Error('You have already been given extra time for this order.'),
        { status: 409, code: 'GRACE_ALREADY_TAKEN', expiresAt: order.expiresAt },
      );
    }
    throw Object.assign(
      new Error(`This order is ${order.status} and no longer waiting for a payment reference.`),
      { status: 409, code: 'NOT_AWAITING_UTR' },
    );
  }

  // The merchant's screen shows this deadline too, and it just moved.
  if (extended.merchantId) {
    emitMerchantUpdate(String(extended.merchantId), 'order_updated', {
      orderId: extended.orderId, expiresAt: extended.expiresAt, server_ts: Date.now(),
    });
  }
  return extended;
}

export async function markOrderPaid(userId, orderId, utrNumber) {
  const order = await db.orders.getOrderRecord(orderId);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

  if (String(order.userId) !== String(userId))
    throw Object.assign(new Error('Access denied'), { status: 403 });
  if (!['ASSIGNED', 'PROCESSING'].includes(order.status))
    throw Object.assign(new Error(`Cannot mark paid — order is in ${order.status} status`), { status: 400 });
  if (order.type !== 'DEPOSIT')
    throw Object.assign(new Error('Only DEPOSIT orders can be marked paid by user'), { status: 400 });

  // What a valid reference looks like on THIS order, and what to call it.
  // Derived from the order's own currency and chain, never from what the
  // submitter says it is: a caller that could name its own format could submit
  // anything. On a USDT order this is the chain's transaction hash; on an INR
  // order it is a bank UTR.
  const spec = referenceSpecFor(order);


  // The claim decides in ONE statement, through the one owner every money path
  // uses. It used to be a check followed by an insert, so two submissions of
  // the same reference arriving together both passed the check and one then
  // died on the index — a 500 to a player who had done nothing wrong. The
  // refusal names which rule stopped it, in the submitter's own vocabulary, and
  // carries the order that holds the reference so support has an answer without
  // a second lookup.
  //
  // `amountRupees` is a RUPEE figure, in a `BIGINT` paise column. On a USDT
  // order `fiatAmount` is USDT, so passing it here would record 500 USDT as
  // ₹500 — a number that reads perfectly and is wrong by two orders of
  // magnitude to whoever investigates a duplicate. Nothing decides on this
  // column, and the order it names carries both the amount and the currency,
  // so the honest value is NONE. A field that lies is worse than no field.
  const { reference: normalizedUTR } = await claimPaymentReference({
    reference: utrNumber, orderId: order.orderId, userId: order.userId,
    amountRupees: order.currency === MERCHANT_CURRENCY.USDT ? null : order.fiatAmount,
    spec,
  });

  // The UTR was consumed above and is not returnable, so the transition being
  // refused here means the order moved under us between the status read and
  // now — a 409, not a 400: the request was understood and is no longer valid.
  const paid = await markOrderPaidState(order.orderId, {
    expectFrom: ['ASSIGNED', 'PROCESSING'],
    set: {
      utrNumber:       normalizedUTR,
      paidAt:          new Date(),
    },
  });
  if (!paid.ok) {
    throw Object.assign(
      new Error(`Cannot mark paid — order is in ${paid.status ?? 'unknown'} status`),
      { status: 409, code: paid.reason },
    );
  }
  // The POST-transition document. Returning the stale `order` would report a
  // PAID order still showing its previous status and no UTR.
  const paidOrder = paid.order ?? order;
  order.status          = 'PAID';
  order.utrNumber       = normalizedUTR;
  order.paidAt          = paidOrder.paidAt;

  if (order.merchantId) {
    emitMerchantUpdate(String(order.merchantId), 'order_paid', {
      orderId:         order.orderId,
      _id:             order.orderId,
      status:          'PAID',
      utrNumber:       normalizedUTR,
      // Whatever the order already carries, which is nothing for a new one —
      // the merchant matches on the UTR, not on an image.
      proofScreenshot: order.proofScreenshot ?? null,
      fiatAmount:      order.fiatAmount,
      tokenAmount:     order.tokenAmount,
      paidAt:          order.paidAt,
      server_ts:       Date.now(),
    });
  }
  emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'PAID', server_ts: Date.now() });

  return order;
}

/**
 * Record an order against a merchant's scoring stats.
 *
 * ── Two statements became one ───────────────────────────────────────────────
 * This incremented the counters, read them back, computed `successRate` from
 * what it read, and wrote that in a SECOND update. Two orders completing
 * together both read the same totals, and both wrote a rate that described
 * neither — a merchant's success rate drifting away from their own counters
 * with nothing to say which was right.
 *
 * `recordCompletedOrder` derives the rate from the counters the same statement
 * is moving, so the rate and the count it describes are always the same pair.
 *
 * The `activeOrderCount: -1` is gone with no replacement. That figure is
 * DERIVED from the orders themselves, so there is no counter to decrement and
 * none to leave wrong when this is called twice or not at all.
 */
export async function updateMerchantStatsOnComplete(merchantId, success, detail = {}) {
  if (!merchantId) return;
  await db.merchants.recordCompletedOrder(merchantId, {
    direction: detail.direction ?? 'DEPOSIT',
    amountRupees: detail.amountRupees ?? 0,
    earningsRupees: detail.earningsRupees ?? 0,
    // `success` false means the order did not complete. It still counts toward
    // total_orders_all, which is what makes the success rate fall.
    disputed: !success,
    responseMinutes: detail.responseMinutes ?? null,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// cancelOrder  — user or admin cancels a PENDING_QUEUE order
// ═════════════════════════════════════════════════════════════════════════════
export async function cancelOrder(actorId, isAdmin, orderId) {
  const order = await db.orders.getOrderRecord(orderId);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

  if (String(order.userId) !== String(actorId) && !isAdmin)
    throw Object.assign(new Error('Access denied'), { status: 403 });

  // A part of a split withdrawal needs nothing special here. It IS an ordinary
  // withdrawal — its own escrow, its own state, its own refund — so cancelling
  // one cancels one, and the parts already with a merchant are untouched. That
  // is the whole reason the split is flat: this function had a branch for
  // containers and a branch for legs, and now it has neither.

  // ORDER INVERTED, deliberately. This refunded the escrow FIRST and set the
  // status afterwards, guarded only by a stale status read. A user
  // double-tapping cancel put two refunds in flight, and only
  // `refundWithdrawal`'s own idempotency key stopped the second credit — which
  // means the protection lived in a different domain from the decision. The
  // transition decides now, and only the winner refunds.
  const cancelled = await cancelOrderState(order.orderId, {
    expectFrom: 'PENDING_QUEUE',
    set: {
      cancelReason: 'USER_CANCELLED',
      cancelledAt:  new Date(),
      ...(order.type === 'WITHDRAWAL' && order.escrowLocked
        ? { escrowLocked: false, escrowStatus: 'REFUNDED' }
        : {}),
    },
  });
  if (!cancelled.ok) {
    throw Object.assign(
      new Error('Order cannot be cancelled at this stage'),
      { status: 409, code: cancelled.reason },
    );
  }
  if (!cancelled.idempotent && order.type === 'WITHDRAWAL' && order.escrowLocked) {
    await refundWithdrawal(order.userId, order.tokenAmount, order.orderId);
  }

  await emitWalletUpdate(order.userId);
  return cancelled.order ?? order;
}

// ═════════════════════════════════════════════════════════════════════════════
// expireOrders  — cron worker (called from cronJobs.js or setInterval)
// ═════════════════════════════════════════════════════════════════════════════
export async function expireOrders() {
  // The due set comes from the DATABASE's clock, not the app server's. Three
  // instances with drifting clocks expiring the same orders is how an order
  // gets refunded a minute before its own deadline.
  // The assignment window comes from the live policy as the FALLBACK; each
  // order's own rail governs it where the order carries a policy version. An
  // order nobody ever took is expired by that window — creation sets no
  // deadline, assignment does, so without it such an order waits forever and a
  // withdrawal's escrow is locked with nothing scheduled to release it.
  const rail = await getActivePaymentModePolicy();
  const expired = await db.orders.findExpiredOrders({
    limit: 500,
    assignmentWaitSeconds: rail?.assignmentWaitSeconds ?? 1500,
  });
  if (expired.length === 0) return 0;

  let count = 0;
  for (const order of expired) {
    try {
      // Two instances running this cron both read the same expired batch. The
      // transition is what makes the refund happen once: the loser gets
      // `idempotent` and skips the release rather than racing it.
      // PENDING_QUEUE is in this list, and was not before. The retry loop that
      // expires an unassigned order is a `setTimeout` chain living in one
      // process — so a restart between an order's creation and its deadline
      // orphaned it permanently, and for a WITHDRAWAL that means the player's
      // money sits in escrow forever with nothing scheduled to release it.
      const moved = await cancelOrderState(order.orderId, {
        expectFrom: ['PENDING_QUEUE', 'ASSIGNED', 'PROCESSING'],
        set: {
          cancelReason: 'EXPIRED',
          cancelledAt:  new Date(),
          ...(order.type === 'WITHDRAWAL' && order.escrowLocked
            ? { escrowLocked: false, escrowStatus: 'REFUNDED' }
            : {}),
        },
      });
      if (!moved.ok || moved.idempotent) continue;

      // Release escrow if WITHDRAWAL
      if (order.type === 'WITHDRAWAL' && order.escrowLocked) {
        await refundWithdrawal(order.userId, order.tokenAmount, order.orderId)
          .catch(e => console.error('[expireOrders] escrow release failed:', e.message));
      }

      // Scoring: the merchant did not complete it.
      if (order.merchantId) {
        await updateMerchantStatsOnComplete(order.merchantId, false, {
          direction: order.type, amountRupees: order.tokenAmount,
        }).catch(() => {});
      }

      emitOrderUpdate(String(order.userId), 'order_expired', {
        orderId:   order.orderId,
        _id:       order.orderId,
        status:    'CANCELLED',
        reason:    'EXPIRED',
        expiresAt: order.expiresAt,
        server_ts: Date.now(),
      });
      emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'CANCELLED', reason: 'EXPIRED' });
      count++;
    } catch (e) {
      console.error('[expireOrders] failed:', order.orderId, e.message);
    }
  }
  return count;
}

// Export tryAssignMerchant for re-assignment after rejection
export { tryAssignMerchant, buildMerchantSnapshot };
