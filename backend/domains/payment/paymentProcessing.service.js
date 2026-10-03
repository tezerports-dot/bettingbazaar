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
 * ── Who serves an order ─────────────────────────────────────────────────────
 * A member of a working team on the order's rail (`db.teamRouting`, §3.10 2c).
 * A buy's tokens are held in the team's pool in the transaction that assigns
 * it; there are no per-merchant wallets and no escrow outside the pool.
 */
import crypto from 'crypto';
import { db } from '#db';
// One owner for what a token is worth: the INR peg, and the two USDT legs.
import {
  INR_TOKEN_RATE, tokensForUsdt,
} from '../configuration/tokenRates.js';
import { debitWinningsForWithdrawal, refundWithdrawal } from '../wallet/walletAuthority.service.js';
import {
  MERCHANT_CURRENCY, merchantTypeOf, usdtAddressFor,
  USDT_CHAIN_SPEC, USDT_CHAINS, isUsdtChain,
} from '../merchant/merchantCurrency.js';
// Risk Platform (Phase 010): the single validation authority for funding orders.
import { assessFundingOrder, getRiskRules, computePayoutFeeMinor } from '../risk/riskValidation.service.js';
// What a valid payment reference looks like on this order, what to call it, and
// the ONE place any of them is claimed. A UTR and a chain transaction hash are
// the same fact — this payment happened, once.
import { referenceSpecFor, claimPaymentReference } from './paymentReference.js';
// The order state machine. Every status change goes through here so an illegal
// move is refused by the database rather than by whichever check ran first.
import {
  markOrderPaid as markOrderPaidState,
  cancelOrder as cancelOrderState, disputeOrder as disputeOrderState,
} from './orderLifecycle.service.js';
import { emitWalletUpdate, emitOrderUpdate, emitMerchantUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';
import { getSystemConfig } from '#db/repositories/config.js';
// Which rail an order runs on, and the per-rail timers and caps.
import {
  PAYMENT_MODES, paymentModeFor, railOf, routingSettings,
} from '#db/repositories/teamRouting.js';
import { rupeesToPaise, paiseToRupees } from '../../shared/money.js';
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
    // An opaque label, and on an INR bank-transfer buy the member's bank
    // account below (`bankName`…`accountHolder`, owner 2026-10-03). A CASH buy
    // is paid through the ATM the member scans (`cash_link`, Step 2d), never
    // to the member; the USDT rail through the address for the order's chain.
    merchantRef,

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

// ─── Assign an order to a team member; returns true if assigned ───────────────
/**
 * Hand a PENDING_QUEUE order to a member of a working team on its rail.
 *
 * ── The choice and the hold are one transaction ────────────────────────────
 * `db.teamRouting.assignToTeam` ranks the eligible members (fewest open orders,
 * then least recently assigned), and takes each candidate inside the order's
 * own transition: the member's row locked, their open orders counted again, and
 * on a buy the tokens HELD in the team's pool in the same statement that moves
 * the order (§32 S6). There is nothing to release here when it does not take —
 * a refused candidate unwinds its own transaction.
 *
 * ── The quote is NOT re-made here ───────────────────────────────────────────
 * The order was priced at creation, and the player was shown that price before
 * they agreed to anything. Its own `rateUsed` is what stands (§25).
 *
 * Both directions come here. There is no open pool any more: a sell nobody is
 * free for waits PENDING_QUEUE and the assignment sweep offers it again.
 */
async function tryAssignMerchant(order, { alsoBar = [] } = {}) {
  const settings = routingSettings(await getSystemConfig());
  // Who this order may NOT go to: anybody who already refused it, anybody who
  // refused an order from this player before, and — on an admin's reassign —
  // the member it was just taken from.
  const barredMerchantIds = [
    ...await db.orders.merchantsBarredFrom({ orderId: order.orderId, userId: order.userId }),
    ...alsoBar,
  ];
  const expiresAt = new Date(Date.now() + settings.processingWindowSeconds[railOf(order)] * 1000);

  const assigned = await db.teamRouting.assignToTeam(order, {
    cap: settings.concurrency[railOf(order)],
    barredMerchantIds,
    actor: 'assignment',
    // Per candidate, because the snapshot names the member — what was true
    // about them at the moment the order became theirs.
    buildSet: async (cand) => {
      const merchant = await db.merchants.getMerchant(cand.merchantId);
      return {
        assignedAt: new Date(),
        expiresAt,
        merchantSnapshot: buildMerchantSnapshot(merchant, expiresAt, order),
      };
    },
  });
  if (!assigned.ok) return false;

  // Keep the caller's in-memory copy consistent with what was written, so the
  // emitters below describe the row that exists rather than a hoped-for one.
  Object.assign(order, assigned.order);

  // Through the projection: the merchant receives the merchant's shape of the
  // order and nothing else (§24).
  emitMerchantUpdate(String(assigned.merchantId), 'new_order', {
    ...toMerchantOrderView(order),
    server_ts: Date.now(),
  });

  // `payTo`, not the snapshot (§24).
  emitOrderUpdate(String(order.userId), 'order_assigned', {
    orderId:          order.orderId,
    _id:              order.orderId,
    payTo:            toPlayerOrderView(order).payTo ?? null,
    expiresAt:        order.expiresAt,
    status:           'ASSIGNED',
    server_ts:        Date.now(),
  });

  return true;
}

/**
 * Offer every queued order to the teams again — the cron's half of assignment.
 *
 * An order is offered once at creation. One that found nobody free waits at
 * PENDING_QUEUE and this sweep offers it again on every run, best claim first:
 * a retry outranks a first attempt, then the oldest goes first. It replaces the
 * in-process `setTimeout` retry loop (which a restart forgot) and the cash-link
 * matcher (a queue that no longer exists). Expiry is `expireOrders`'s, against
 * `teamRouting.assignmentWaitSeconds`.
 *
 * Safe from several instances at once: `assignToTeam` moves an order through
 * the guarded transition, so two sweeps reaching one order assign it once.
 */
export async function assignQueuedOrders({ limit = 200 } = {}) {
  const waiting = await db.orders.queuedOrdersForAssignment({ limit });
  let assigned = 0;
  for (const order of waiting) {
    try {
      if (await tryAssignMerchant(order)) {
        assigned += 1;
        emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'ASSIGNED', server_ts: Date.now() });
      }
    } catch (error) {
      // One bad row must not hold up everybody behind it.
      console.error(`[assignment] ${order.orderId}:`, error.message);
    }
  }
  return { assigned, considered: waiting.length };
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
/**
 * Is this player inside a cool-off, and if so, refuse by NAME and by CLOCK.
 *
 * Three buy orders in a row expired with nobody paying, so they cannot open
 * another for an hour. Refused BEFORE anything is written, and refused the same
 * way on both rails — a player who can still place a sell while buys are locked
 * would just have found the way around it.
 *
 * The message carries the TIME. "Try again later" is the shape a player reads
 * as the app being broken, and they retry immediately and repeatedly; a time
 * they can look at is a rule they can follow.
 */
async function assertNotInCoolOff(userId) {
  const until = await db.users.orderLockFor(userId);
  if (!until) return;
  throw Object.assign(
    new Error(
      'Three of your orders in a row expired without payment, so new orders are paused '
      + `until ${new Date(until).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}. `
      + 'Paying for an order clears this straight away.',
    ),
    { status: 429, code: 'ORDER_COOL_OFF', retryAt: until },
  );
}

export async function createDepositOrder(userId, tokenAmount, attempt = {}) {
  await assertNotInCoolOff(userId);
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

  // ── The USDT a USDT buy is priced in ────────────────────────────────────
  // A USDT buy is chosen in what the player SENDS — whole steps of 100 USDT
  // (Step 2d) — and the tokens follow from the admin's rate. `tokenAmount` is
  // ignored on this rail: a client cannot name its own token count.
  const usdtAmount = currency === MERCHANT_CURRENCY.USDT ? attempt.usdtAmount : null;

  // Risk Platform gate (Phase 010): the size on offer (INR) or the USDT step
  // and bounds, one open buy per currency, velocity — the single validation
  // authority. It reads the same config row the picker is built from.
  await assessFundingOrder({ userId, tokenAmount, type: 'DEPOSIT', currency, usdtAmount });

  const user = await db.users.getUser(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.isBlocked) {
    throw Object.assign(
      new Error('Your account has been suspended due to payment violations. Contact support.'),
      { status: 403, code: 'USER_BLOCKED' },
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
    const quoted = tokensForUsdt(usdtAmount, cfg);
    // NO FALLBACK. The schema default is 0 and 0 is not a rate: substituting 1
    // would sell 100 USDT's worth of tokens for 100 tokens, and a band breach
    // is a misplaced decimal. A caller that cannot price a purchase refuses it.
    if (quoted === null) {
      throw Object.assign(
        new Error('USDT pricing has not been set. Contact support.'),
        { status: 503, code: 'USDT_RATE_UNSET' },
      );
    }
    tokenAmount = quoted.tokens;
    fiatAmount = usdtAmount;
    rateUsed = quoted.rate;
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
  // The rail is DERIVED from the currency and the size, inside the writer —
  // the same rule the risk gate judged the amount by (`paymentModeFor`).
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

  // Offered to the teams now; if nobody is free it waits PENDING_QUEUE and
  // `assignQueuedOrders` offers it again on every run until it expires.
  if (await tryAssignMerchant(order)) {
    emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'ASSIGNED', server_ts: Date.now() });
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
 * A sell is ONE order of one size on offer (Step 2d, owner 2026-10-02): no
 * splitting. Whatever its rail, the member pays it by bank transfer to the
 * player's account (owner, 2026-10-03), so the payout need not be a note a
 * machine dispenses; it is the size less any payout fee.
 *
 * @param attempt `{ priority, retryOf }` — see `createDepositOrder`.
 */
export async function createWithdrawalOrder(userId, tokenAmount, attempt = {}) {
  // The same cool-off. A player locked out of buying who could still sell has
  // simply found the way around it.
  await assertNotInCoolOff(userId);

  // The size on offer, and velocity — the single validation authority.
  await assessFundingOrder({ userId, tokenAmount, type: 'WITHDRAWAL' });

  const user = await db.users.getUser(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.isBlocked) {
    throw Object.assign(
      new Error('Your account has been suspended due to payment violations. Contact support.'),
      { status: 403, code: 'USER_BLOCKED' },
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

  // ── ADMISSION ───────────────────────────────────────────────────────────
  // The stake debit IS the gate, and it is the whole gate: winnings → locked
  // under `SELECT … FOR UPDATE` on the wallet row, in one transaction with its
  // ledger entry, refusing what the row cannot fund. Idempotent on `wd_<id>`.
  //
  // ── The lock and its order are ONE commit ───────────────────────────────
  // They used to be two: the debit, then `createOrderRecord`. The INSERT can
  // fail too — the partial UNIQUE on `retry_of_order_id` refuses a second retry
  // of the same expired withdrawal — and when it did, the winnings stayed
  // locked against an order that was never written. So the order is PREPARED
  // first — every field validated, the rail stamped, the tag computed — and its
  // INSERT runs inside the debit's own transaction, under the wallet row lock.
  // A refused INSERT unwinds the lock with it; a refused debit writes no order.
  const orderId = `WD_${crypto.randomBytes(12).toString('hex')}`;
  const insertOrder = await db.orders.prepareOrderRecord({
    orderId,
    userId:            user.userId,
    type:              'WITHDRAWAL',
    tokenAmountRupees: tokenAmount,
    fiatAmountRupees:  fiatAmount,
    // The gap between the tokens debited and the money paid out.
    payoutFee,
    rateUsed:          INR_TOKEN_RATE,
    escrowLocked:      true,
    escrowStatus:      'LOCKED',
    escrowAmount:      tokenAmount,
    assignmentPriority: attempt.priority ?? 0,
    retryOfOrderId:     attempt.retryOf ?? null,
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

  let debited;
  try {
    debited = await debitWinningsForWithdrawal(String(user.userId), tokenAmount, orderId, { within: insertOrder });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_WITHDRAWABLE') {
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

  // Written in the debit's own transaction. A replayed debit (same key) wrote
  // nothing this time, and its order is the one written the first time.
  const order = debited.record ?? await db.orders.getOrderRecord(orderId);

  emitAdminUpdate('new_order', adminOrderPayload(order, user));

  // Offered to the teams now; if nobody is free it waits PENDING_QUEUE for the
  // assignment sweep, its stake locked, until it is served or expires.
  if (await tryAssignMerchant(order)) {
    emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'ASSIGNED', server_ts: Date.now() });
  }

  await emitWalletUpdate(user.userId);

  return {
    // Through the projection, for the reason the deposit above is: one owner of
    // the player's shape. It carries `userBankDetails` (their own account, which
    // the sell screen renders masked).
    order: toPlayerOrderView(order),
    // From the movement that actually happened, not from a record read before
    // it. `debited.balances` is what the wallet holds now.
    remainingBalance: {
      deposit:  debited.balances?.depositBalance ?? 0,
      winnings: debited.balances?.winningsBalance ?? 0,
      total:    (debited.balances?.depositBalance ?? 0) + (debited.balances?.winningsBalance ?? 0),
    },
    note: `You will receive ₹${Number(order.fiatAmount).toLocaleString('en-IN')} from merchant`,
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
 * The amount limits, the denomination rule, the one-open-buy rule, the
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
  // REJECTED is no longer an end (2c+): a buy the member rejected as unpaid
  // waits there, with the team's tokens in escrow, for the player to dispute
  // it. A retry beside it would hold a second team's tokens for the same
  // purchase. Once the window closes the buy is CANCELLED and may be retried.
  if (original.status === 'REJECTED') {
    throw Object.assign(
      new Error('This buy was rejected as unpaid. If you paid, raise a dispute before the window closes; otherwise you can try again once it has closed.'),
      { status: 409, code: 'DISPUTE_WINDOW_OPEN' },
    );
  }
  const retryable = ['CANCELLED', 'FAILED'].includes(original.status);
  if (!retryable) {
    throw Object.assign(
      new Error(`This order is ${original.status}. Only an order that ended without being served can be retried.`),
      { status: 409, code: 'NOT_RETRYABLE' },
    );
  }

  const attempt = { priority: 1, retryOf: original.orderId };
  // A USDT buy is retried AS a USDT buy, for the USDT it asked for, on the
  // chain it named: it is priced in USDT (Step 2d), and its token count is not
  // an INR size, so retrying it on the INR rail would be refused — or worse,
  // be a different purchase. The new order is quoted at today's rate.
  if (original.type === 'DEPOSIT' && String(original.currency).toUpperCase() === MERCHANT_CURRENCY.USDT) {
    Object.assign(attempt, {
      currency: MERCHANT_CURRENCY.USDT, usdtChain: original.usdtChain, usdtAmount: original.fiatAmount,
    });
  }
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
 * ── The window is the admin's ──────────────────────────────────────────────
 * `SystemConfig.teamRouting.utrSubmitSeconds`, the time the player has to
 * submit the UTR after tapping Paid.
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

  const graceSeconds = routingSettings(await getSystemConfig()).utrSubmitSeconds;

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
  // `order_update`, the registered name the merchant panel listens for. This
  // was `order_updated` — a typo variant of it (§12), listened for by nothing,
  // so the merchant's countdown kept the old deadline.
  if (extended.merchantId) {
    emitMerchantUpdate(String(extended.merchantId), 'order_update', {
      orderId: extended.orderId, expiresAt: extended.expiresAt, server_ts: Date.now(),
    });
  }
  return extended;
}

/** A buy moved to another member between the player's read and their tap. */
const MOVED_TO_ANOTHER_MEMBER = 'This order has moved to another member, so what you were shown is not where to pay. Wait for the new payment details.';

export async function markOrderPaid(userId, orderId, utrNumber) {
  const order = await db.orders.getOrderRecord(orderId);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

  if (String(order.userId) !== String(userId))
    throw Object.assign(new Error('Access denied'), { status: 403 });
  if (order.type !== 'DEPOSIT')
    throw Object.assign(new Error('Only DEPOSIT orders can be marked paid by user'), { status: 400 });
  // ── Nothing is paid before the member accepts ─────────────────────────
  // ASSIGNED is the state a member may still decline and an admin may still
  // move (`/reject`, the admin reassign), so the player is shown where to pay
  // only from PROCESSING (`playerOrderView`), and "I've paid" is taken only
  // there. Otherwise a member could take a transfer, decline, and leave the
  // player's money with them and the order with somebody else.
  if (order.status === 'ASSIGNED') {
    throw Object.assign(
      new Error('The member has not accepted this order yet. Wait for the payment details, pay them, then tap I\'ve paid.'),
      { status: 409, code: 'NOT_ACCEPTED_YET' },
    );
  }
  if (order.status !== 'PROCESSING')
    throw Object.assign(new Error(`Cannot mark paid — order is in ${order.status} status`), { status: 400 });

  // ── The CASH rail reaches PAID on the TAP, with the reference to follow ──
  //
  // On every other rail the player is at their own phone and can read the
  // reference off their banking app before they say anything. At a cash
  // machine they are not: the MERCHANT is standing at the ATM with a session
  // that times out, and making them wait while the player goes and finds a
  // twelve-character bank reference loses the machine — and with it the
  // player's turn at it.
  //
  // So a cash buy is PAID the moment the player says so, which is what
  // unblocks the merchant to continue at the machine, and the reference
  // follows through `submitPaymentReference` below. What does NOT move is the
  // money: the merchant cannot confirm until the reference is on the row, so
  // PAID here means "the player says they have paid", not "evidenced".
  // `sweepUtrAfterPaid` sends an order whose reference never arrives to an
  // admin rather than cancelling it, because at a machine the cash may
  // genuinely have been dispensed and only a person can tell.
  //
  // Any other rail still requires it up front. The ATM's clock is the whole
  // reason for the split, and there is no clock on a UPI transfer.
  const isCashRail = order.paymentMode === PAYMENT_MODES.CASH_ATM;

  // ── A cash buy is paid through the machine's link, so there must BE one ──
  // The member scans the ATM's QR and the player pays that (Step 2d). Before
  // the scan there is nothing the player could have paid, so "I've paid" is a
  // tap on a button the screen does not show, and accepting it would free the
  // member to walk away from a machine nobody has paid.
  //
  // The link goes only when the order changes hands (the schema clears it with
  // the member, `bb_cash_link_follows_member`), so the transition below names
  // the member read here (`expectMerchant`, in its WHERE): a reassignment
  // between this read and the move is refused rather than leaving a PAID cash
  // buy with no link, or one paid to the previous member's machine.
  if (isCashRail && !order.cashLink) {
    throw Object.assign(
      new Error('The member has not scanned the cash machine yet. Wait for the "Pay" button, pay it, then tap I\'ve paid.'),
      { status: 409, code: 'CASH_LINK_PENDING' },
    );
  }
  // The member whose account, address or machine the player was shown: the
  // move names them in its WHERE, on every rail.
  const sameMember = order.merchantId;
  const deferred = isCashRail && !String(utrNumber ?? '').trim();

  if (!deferred && !String(utrNumber ?? '').trim()) {
    throw Object.assign(new Error('utrNumber is required'), { status: 400 });
  }

  if (deferred) {
    const paidNow = await markOrderPaidState(order.orderId, {
      expectFrom: ['PROCESSING'],
      expectMerchant: sameMember,
      set: { paidAt: new Date() },
    });
    if (!paidNow.ok) {
      throw Object.assign(
        new Error(paidNow.reason === 'merchant_changed'
          ? MOVED_TO_ANOTHER_MEMBER
          : `Cannot mark paid — order is in ${paidNow.status ?? 'unknown'} status`),
        { status: 409, code: paidNow.reason },
      );
    }
    const row = paidNow.order ?? order;
    order.status = 'PAID';
    order.paidAt = row.paidAt;
    order.utrNumber = null;
    if (order.merchantId) {
      // The merchant's screen needs to know this is the tap and not the
      // evidence, or their Confirm button looks broken when it refuses.
      emitMerchantUpdate(String(order.merchantId), 'order_paid', {
        orderId: order.orderId, _id: order.orderId, status: 'PAID',
        utrNumber: null, awaitingReference: true,
        fiatAmount: order.fiatAmount, tokenAmount: order.tokenAmount,
        paidAt: order.paidAt, server_ts: Date.now(),
      });
    }
    emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'PAID', server_ts: Date.now() });
    return order;
  }

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
    expectFrom: ['PROCESSING'],
    expectMerchant: sameMember,
    set: {
      utrNumber:       normalizedUTR,
      paidAt:          new Date(),
    },
  });
  if (!paid.ok) {
    throw Object.assign(
      new Error(paid.reason === 'merchant_changed'
          ? MOVED_TO_ANOTHER_MEMBER
          : `Cannot mark paid — order is in ${paid.status ?? 'unknown'} status`),
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
 * "Here is the reference" — the second half of a CASH buy.
 *
 * The player tapped Paid, which put the order at PAID and let the merchant
 * carry on at the machine. The order carries no reference yet, and the
 * merchant cannot confirm without one, so this is the step that unblocks the
 * money.
 *
 * ── Only where the split applies ────────────────────────────────────────────
 * PAID, a DEPOSIT, the player's own, on the CASH rail, and carrying no
 * reference already. Every one of those is refused by name rather than
 * silently ignored: a player who submits a second reference to an order that
 * has one is telling us something is wrong, and §27 means the first is the
 * one that counts.
 *
 * ── The claim commits before the row is written ─────────────────────────────
 * `claimPaymentReference` binds the reference to this order in `utr_registry`
 * and THROWS rather than returning a flag. The field write follows it, which
 * is §21's shape — but the two disagree only in the direction that is
 * recoverable: the registry names the order, so a reference claimed without
 * the row showing it can be found and repaired, whereas writing the row first
 * would leave a confirmable order whose reference nothing had claimed. That is
 * the same ordering `markOrderPaid` above uses, for the same reason.
 */
export async function submitPaymentReference(userId, orderId, utrNumber) {
  const order = await db.orders.getOrderRecord(orderId);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
  if (String(order.userId) !== String(userId))
    throw Object.assign(new Error('Access denied'), { status: 403 });
  if (order.type !== 'DEPOSIT')
    throw Object.assign(new Error('Only a deposit carries a payment reference from the player'), { status: 400 });
  if (order.paymentMode !== PAYMENT_MODES.CASH_ATM)
    throw Object.assign(
      new Error('On this rail the reference is submitted with the payment, not after it'),
      { status: 400 },
    );
  if (order.status !== 'PAID')
    throw Object.assign(
      new Error(`A reference can only be added to a paid order — this one is ${order.status}`),
      { status: 409 },
    );
  if (String(order.utrNumber ?? '').trim())
    throw Object.assign(
      new Error('This order already has a payment reference.'),
      { status: 409 },
    );
  if (!String(utrNumber ?? '').trim())
    throw Object.assign(new Error('utrNumber is required'), { status: 400 });

  const { reference } = await claimPaymentReference({
    reference: utrNumber, orderId: order.orderId, userId: order.userId,
    amountRupees: order.currency === MERCHANT_CURRENCY.USDT ? null : order.fiatAmount,
    spec: referenceSpecFor(order),
  });

  await db.orders.setOrderFields(order.orderId, { utrNumber: reference });
  order.utrNumber = reference;

  if (order.merchantId) {
    // The merchant's Confirm button has been refusing until now. This is what
    // turns it on, so it has to reach them without a refresh.
    emitMerchantUpdate(String(order.merchantId), 'order_paid', {
      orderId: order.orderId, _id: order.orderId, status: 'PAID',
      utrNumber: reference, awaitingReference: false,
      fiatAmount: order.fiatAmount, tokenAmount: order.tokenAmount,
      paidAt: order.paidAt, server_ts: Date.now(),
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

  // A completed order ends the rejection streak.
  //
  // `success` is the discriminator and it is already exactly right: the confirm
  // path passes true, the expiry path passes false. Without this the cap is a
  // LIFETIME allowance of three refusals rather than three in a row, and every
  // honest merchant reaches it eventually — which is the failure mode that
  // makes an operator switch a control off.
  //
  // It is NOT put inside `recordCompletedOrder`: the reject route calls that
  // too, with zero amounts, to move the lifetime counters — so resetting there
  // would undo the very increment the rejection just made.
  if (success) await db.merchants.resetConsecutiveRejections(merchantId);

  // …and the EXPIRY run ends too, for the same reason and separately.
  //
  // Separately because they count different things: a refusal is the merchant's
  // doing, an expiry is nobody's. One completed order proves the merchant is
  // reachable and can be paid, which is the exact question the expiry streak
  // was asking — so it answers that one whether or not there were refusals.
  if (success) await db.merchants.resetConsecutiveExpiries(merchantId);

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
  // A PENDING_QUEUE deposit holds nothing in a pool — a requeue releases its
  // hold in the same transaction that moves it back. Releasing here anyway
  // costs one query and is a no-op when there is nothing held.
  if (!cancelled.idempotent && order.type === 'DEPOSIT') {
    await db.teamPools.releaseBuyHold(order.orderId, { actor: 'cancel', reason: 'Order cancelled' });
  }

  await emitWalletUpdate(order.userId);
  return cancelled.order ?? order;
}

// ═════════════════════════════════════════════════════════════════════════════
// sweepUnansweredPaidDeposits — the merchant's own clock
// ═════════════════════════════════════════════════════════════════════════════
/**
 * A buy order the player has PAID for and the merchant has not answered.
 *
 * ── The window nobody was watching ─────────────────────────────────────────
 * `expireOrders` covers PENDING_QUEUE, ASSIGNED and PROCESSING and CANCELS what
 * it finds, and it stops short of PAID on purpose: cancelling an order the
 * player has already paid for strands the payment. That is right, and it left
 * the case with no owner at all. A merchant who neither approves nor rejects a
 * PAID buy simply kept it — nothing swept it, nothing counted it against them,
 * and the only route out was the player noticing and pressing dispute. **The
 * one window where the player's money is already gone was the one window with
 * no clock on it.**
 *
 * ── Three things happen, in this order, and the order matters ──────────────
 * 1. The order moves to DISPUTED, which is the admin review queue. NOT
 *    cancelled and NOT reassigned: the player paid THIS merchant's account, so
 *    only a person can decide whether the money arrived. Reassigning would ask
 *    a second merchant to hand over tokens for a payment they never received.
 * 2. The merchant's silence is recorded as a refusal — the same streak and the
 *    same cap as pressing reject, because to the player they are the same
 *    event and only one of them is honest about it.
 * 3. The player is told it is being reviewed. They have been waiting on money
 *    they already sent; silence is the one thing this path must not add to.
 *
 * The transition is FIRST because it is the guarded one: exactly one caller
 * moves the order, so two instances running this cron cannot both record a
 * refusal for the same silence.
 *
 * **The merchant's HOLD stays.** DISPUTED is a committing state, so their
 * tokens remain reserved — they still owe them, and a resolution in the
 * player's favour will take them.
 */
export async function sweepUnansweredPaidDeposits() {
  const config = await getSystemConfig();
  // schema default: 30
  const minutes = config?.merchantOrderLimits?.paidResponseMinutes ?? 30;

  const due = await db.orders.findUnansweredPaidDeposits({ olderThanMinutes: minutes });
  if (!due.length) return 0;

  let handled = 0;
  for (const order of due) {
    try {
      const moved = await disputeOrderState(order.orderId, {
        expectFrom: 'PAID',
        set: {
          disputeReason: `The merchant did not answer within ${minutes} minutes of the payment being submitted.`,
          disputeRaisedAt: new Date(),
          // 'system', not 'user': a player who has raised no dispute must not
          // appear in the record as having raised one. The distinction decides
          // what the admin screen is looking at.
          disputeRaisedBy: 'system',
        },
      });
      // The loser of a race between two cron instances gets `idempotent` and
      // skips, so one silence produces one refusal.
      if (!moved.ok || moved.idempotent) continue;
      handled += 1;

      const { recordMerchantRefusal, REFUSAL } =
        await import('../merchant/merchantRefusal.service.js');
      await recordMerchantRefusal({
        orderId: order.orderId,
        merchantId: order.merchantId,
        userId: String(order.userId),
        reason: `No answer within ${minutes} minutes of a submitted payment.`,
        kind: REFUSAL.UNANSWERED,
      });

      console.error(
        `[paid-timeout] ${order.orderId}: merchant ${order.merchantId} did not answer a paid `
        + `buy order for ${minutes} minutes. Sent to the admin queue.`,
      );

      // The player learns it is being looked at — and learns nothing about the
      // merchant, which §24 forbids on a player-facing message.
      const { notify } = await import('../communication/communication.service.js');
      await notify({
        userId: String(order.userId),
        type: 'ORDER_UPDATE',
        title: 'Your purchase is being reviewed',
        message: 'We have not had confirmation for your payment yet, so our team is checking it. '
               + 'You do not need to do anything or pay again.',
        meta: { orderId: order.orderId },
      }).catch(() => {});

      emitOrderUpdate(String(order.userId), 'order_disputed', {
        orderId: order.orderId, status: 'DISPUTED', server_ts: Date.now(),
      });
      emitAdminUpdate('queue_order_update', {
        orderId: order.orderId, status: 'DISPUTED', server_ts: Date.now(),
      });
    } catch (error) {
      // One bad order must not take down the rest of the batch.
      console.error(`[paid-timeout] ${order.orderId} failed:`, error);
    }
  }
  return handled;
}

/**
 * A cash buy the player said they had paid for and never evidenced.
 *
 * The mirror of `sweepUnansweredPaidDeposits`, and deliberately NOT the same
 * sweep. That one is the MERCHANT's silence on an order they could act on;
 * this is the PLAYER's, on an order the merchant CANNOT act on because their
 * Confirm refuses without a reference. Running them as one row would suspend a
 * merchant for somebody else's delay, which is §2 in as many words: whose
 * fault an expiry is depends on the DIRECTION.
 *
 * ── DISPUTED, never CANCELLED ───────────────────────────────────────────────
 * The player tapped Paid at a machine. The cash may genuinely have been
 * dispensed and the reference simply not found — a bank app that never showed
 * it, a slip dropped — and cancelling would take tokens back from somebody who
 * paid. Only a person can tell, so it goes to the admin queue with
 * `disputeRaisedBy: 'system'`: a player who raised nothing must not appear to
 * have.
 *
 * **No merchant refusal is recorded.** They did nothing wrong, and the hold on
 * their tokens stays because DISPUTED is a committing state — they still owe
 * them if the resolution goes the player's way.
 */
export async function sweepUtrAfterPaid() {
  const config = await getSystemConfig();
  // schema default: 15 (merchantOrderLimits.utrAfterPaidMinutes)
  const minutes = config?.merchantOrderLimits?.utrAfterPaidMinutes ?? 15;

  const due = await db.orders.findPaidDepositsAwaitingReference({ olderThanMinutes: minutes });
  if (!due.length) return 0;

  let handled = 0;
  for (const order of due) {
    try {
      const moved = await disputeOrderState(order.orderId, {
        expectFrom: 'PAID',
        set: {
          disputeReason:
            `No payment reference was submitted within ${minutes} minutes of the payment being reported.`,
          disputeRaisedAt: new Date(),
          disputeRaisedBy: 'system',
        },
      });
      // Two cron instances racing: the loser gets `idempotent` and skips, so
      // one missing reference produces one dispute.
      if (!moved.ok || moved.idempotent) continue;
      handled += 1;

      console.error(
        `[utr-timeout] ${order.orderId}: no payment reference within ${minutes} minutes of the `
        + 'player reporting payment. Sent to the admin queue.',
      );

      const { notify } = await import('../communication/communication.service.js');
      await notify({
        userId: String(order.userId),
        type: 'ORDER_UPDATE',
        title: 'We still need your payment reference',
        message:
          'You told us you had paid but we did not receive the reference in time, so our team is '
          + 'checking this order. You do not need to pay again.',
        meta: { orderId: order.orderId },
      }).catch(() => {});
    } catch (e) {
      // One bad row must not stop the rest: the next one is a different player.
      console.error(`[utr-timeout] ${order.orderId}:`, e.message);
    }
  }
  return handled;
}


// ═════════════════════════════════════════════════════════════════════════════
// expireOrders  — cron worker (called from cronJobs.js or setInterval)
// ═════════════════════════════════════════════════════════════════════════════
export async function expireOrders() {
  // The due set comes from the DATABASE's clock, not the app server's. Three
  // instances with drifting clocks expiring the same orders is how an order
  // gets refunded a minute before its own deadline.
  // An order nobody ever took is expired by the assignment wait — creation
  // sets no deadline, assignment does, so without it such an order waits
  // forever and a withdrawal's stake is locked with nothing to release it.
  const expired = await db.orders.findExpiredOrders({
    limit: 500,
    assignmentWaitSeconds: routingSettings(await getSystemConfig()).assignmentWaitSeconds,
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

      // …and the other side of the same idea for a DEPOSIT. The team's pool
      // tokens were held the moment the order became a member's; the window
      // has closed, so they come back. Unconditional because an order that
      // never reached a member holds nothing and this is a no-op.
      if (order.type === 'DEPOSIT') {
        await db.teamPools.releaseBuyHold(order.orderId, { actor: 'expiry', reason: 'Order expired' });
      }

      // Scoring: the merchant did not complete it.
      if (order.merchantId) {
        await updateMerchantStatsOnComplete(order.merchantId, false, {
          direction: order.type, amountRupees: order.tokenAmount,
        }).catch(() => {});

        // ── Whose failure was this? The DIRECTION decides ──────────────────
        // An expired assignment used to count against the merchant in every
        // case, and on a BUY that is the wrong party. A buy expires at ASSIGNED
        // or PROCESSING because THE PLAYER NEVER PAID — the merchant was
        // standing by, did nothing wrong, and took a strike for it. Three
        // players who changed their minds and an honest merchant is suspended,
        // which is precisely the failure mode that gets a control switched off.
        //
        // A SELL expiring IS the merchant's: they had the order and did not pay
        // the player. And a BUY the merchant sits on AFTER the player has paid
        // is theirs too — that one is swept separately, from PAID, because it
        // must not be cancelled (see `sweepUnansweredPaidDeposits`).
        //
        // `PENDING_QUEUE` orders reach this loop too and have no merchant —
        // the `order.merchantId` guard above is what keeps this to assignments
        // somebody actually held.
        const nobodyPaid = order.type === 'DEPOSIT';
        if (nobodyPaid) {
          // ── Nobody is at fault, and TWO things are still worth knowing ────
          // The player did not pay and the merchant did nothing. Neither is
          // penalised for it. But three in a row means something on each side:
          // a player cycling through orders is holding merchant inventory that
          // other players needed, and a MERCHANT three of whose players could
          // not pay is probably one nobody can pay — a dead QR, a closed
          // handle. That second one is invisible any other way, because each
          // failure on its own looks like an ordinary abandoned purchase.
          //
          // Both counts are advanced by one function, so an expiry cannot be
          // recorded against one party and forgotten against the other.
          //
          // A buy the member never accepted, or a cash buy whose member never
          // scanned the machine's QR, gave the player nothing to pay (Step
          // 2d), so it is not the player's: only the member's count moves.
          const { recordPlayerPaymentFailure } =
            await import('./playerPaymentFailure.service.js');
          const neverAccepted = order.status === 'ASSIGNED';
          const noCashLink = order.paymentMode === PAYMENT_MODES.CASH_ATM && !order.cashLink;
          await recordPlayerPaymentFailure({
            orderId: order.orderId,
            userId: String(order.userId),
            merchantId: order.merchantId ?? null,
            reason: neverAccepted
              ? 'The member never accepted this buy.'
              : noCashLink
                ? 'The member never scanned the cash machine for this buy.'
                : 'The buy order expired before any payment was made.',
            playerCouldPay: !neverAccepted && !noCashLink,
          });
        } else {
          const { recordMerchantRefusal, REFUSAL } =
            await import('../merchant/merchantRefusal.service.js');
          await recordMerchantRefusal({
            orderId: order.orderId,
            merchantId: order.merchantId,
            userId: String(order.userId),
            kind: REFUSAL.EXPIRED,
          });
        }
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
