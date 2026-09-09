// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * usdtDeposit.service.js — the USDT rail, end to end.
 *
 * ── Where this rail begins ─────────────────────────────────────────────────
 * ₹10,000 is the ceiling on any INR buy, because that is the largest amount a
 * cash machine dispenses and the largest a merchant is approved to serve. Above
 * it there is no merchant who could take the order at all, so the player pays
 * the PLATFORM directly, in USDT, through BTCPay Server.
 *
 * The floor here is DERIVED from that ceiling, not written as its own number.
 * Two constants meaning "₹10,000" drift, and the day they disagree is the day
 * an amount is legal on neither rail — a player who can buy nothing, with every
 * check green.
 *
 * ── The three things a player must not be able to do ───────────────────────
 * 1. Decide the token amount from the callback. The rate is read and the tokens
 *    are fixed when the invoice is CREATED. `settleDeposit` reads the ROW.
 * 2. Be credited twice. The guarded transition plus the UNIQUE `tx_id` in
 *    `usdt_deposits`, and then the wallet's own `dep_complete_<id>` gate
 *    underneath it — three gates deep, because a signed webhook body can be
 *    replayed by anyone who captures one.
 * 3. Hold ten open invoices. One at a time, the same rule the INR rail has, for
 *    the same reason: an invoice is a price held at a rate, and a player
 *    holding many is a player holding an option on the exchange rate.
 *
 * ── Where the tokens come from ─────────────────────────────────────────────
 * They are MINTED — `TOKEN_SUPPLY → USER_FLOAT`, under the supply cap an admin
 * set — because nobody else parted with them. An INR deposit moves tokens out
 * of a merchant's float; this one creates them, and the treasury says so in one
 * movement rather than pretending a merchant was involved.
 */
import crypto from 'crypto';
import { db } from '#db';
import { creditDeposit, creditReserve } from '../wallet/walletAuthority.service.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { merchantToUserUsdtRate } from '../configuration/tokenRates.js';
import { MAX_INR_BUY_PAISE } from '../merchant/denominations.js';
import { rupeesToPaise } from '../../shared/money.js';
import { btcpay as btcpayConfig, btcpayConfigured } from '../../config/btcpay.config.js';
import { createInvoice as createBtcpayInvoice } from './btcpay.client.js';
import { emitWalletUpdate, emitAdminUpdate, emitOrderUpdate } from '../notification/realtimeEmitters.js';

/**
 * The smallest USDT buy: one paise above the INR ceiling.
 *
 * Derived, so the two rails meet exactly and neither leaves a gap. ₹10,000.00
 * is an INR buy; ₹10,000.01 is a USDT one.
 */
export const MIN_USDT_BUY_PAISE = MAX_INR_BUY_PAISE + 1;

/** Six decimals, which is USDT's precision. Rounded UP, never against the platform. */
function usdtFor(tokenAmountRupees, rateInrPerUsdt) {
  const raw = Number(tokenAmountRupees) / Number(rateInrPerUsdt);
  return Math.ceil(raw * 1e6) / 1e6;
}

/**
 * What a player is told about their own USDT deposit.
 *
 * An allowlist, for the reason `playerOrderView.js` is one. There is no
 * merchant to hide here, but there is a store id, an invoice's internal state
 * and the platform's own policy snapshot, and none of that is the player's.
 */
export function toPlayerDepositView(deposit) {
  if (!deposit) return null;
  return {
    depositId: deposit.depositId,
    status: deposit.state,
    tokenAmount: deposit.tokenAmount,
    usdtAmount: deposit.usdtAmount,
    usdtRateInr: deposit.usdtRateInr,
    checkoutLink: deposit.checkoutLink,
    expiresAt: deposit.expiresAt,
    settledAt: deposit.settledAt,
    createdAt: deposit.createdAt,
  };
}

/**
 * Open a USDT deposit and hand back somewhere to pay.
 *
 * ── The order of operations, and what each failure leaves ──────────────────
 * The ROW is written before the invoice is requested. The other order — create
 * the invoice, then write — loses the deposit entirely if the process dies
 * between them: BTCPay holds an invoice a player can pay and nothing here knows
 * it was ours, so the money arrives and no row exists to credit. This way the
 * worst failure is a row with no invoice id, which is a deposit that never
 * started and credits nobody.
 */
export async function createUsdtDeposit(userId, tokenAmount, {
  createInvoice = createBtcpayInvoice, config = btcpayConfig,
} = {}) {
  if (!btcpayConfigured(config)) {
    throw Object.assign(
      new Error('USDT deposits are not available right now. Please try a smaller amount or contact support.'),
      { status: 503, code: 'USDT_NOT_CONFIGURED' },
    );
  }

  const amount = Number(tokenAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('Enter a valid amount.'), { status: 400, code: 'INVALID_AMOUNT' });
  }
  const paise = rupeesToPaise(amount);
  if (paise < MIN_USDT_BUY_PAISE) {
    throw Object.assign(
      new Error(`USDT is for purchases above ₹${MAX_INR_BUY_PAISE / 100}. Buy this amount with UPI or cash instead.`),
      { status: 400, code: 'BELOW_USDT_FLOOR' },
    );
  }

  const user = await db.users.getUser(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.isBlocked) {
    throw Object.assign(
      new Error('Your account has been suspended due to payment violations. Contact support.'),
      { status: 403, code: 'USER_BLOCKED' },
    );
  }
  // The same door the INR deposit uses. Money IN needs linked identity, not an
  // approved one — but this route is reached by a player buying a large amount,
  // so the rule is the platform's ordinary one and not a looser one invented
  // here.
  if (user.kycStatus !== 'APPROVED' && user.kycStatus !== 'LINKED') {
    throw Object.assign(
      new Error('Please complete KYC verification to purchase tokens'),
      { status: 403, code: 'KYC_REQUIRED' },
    );
  }

  const open = await db.usdtDeposits.countOpenForUser(user.userId);
  if (open > 0) {
    throw Object.assign(
      new Error('You already have a USDT purchase waiting for payment. Finish or let it expire before starting another.'),
      { status: 409, code: 'USDT_BUY_ALREADY_OPEN' },
    );
  }

  // NO FALLBACK. The schema default is 0 and 0 is not a rate: dividing by it
  // gives Infinity USDT, and substituting 1 would sell tokens at the INR peg
  // for a currency that is not pegged to it. A caller that cannot price a
  // purchase must refuse it, not guess.
  const rate = merchantToUserUsdtRate(await getSystemConfig());
  if (rate === null) {
    throw Object.assign(
      new Error('USDT pricing has not been set. Contact support.'),
      { status: 503, code: 'USDT_RATE_UNSET' },
    );
  }

  const split = await db.depositPolicy.splitForDeposit(amount, 'USDT');
  const usdtAmount = usdtFor(amount, rate);
  const depositId = `USDT_${crypto.randomBytes(12).toString('hex')}`;

  await db.usdtDeposits.openDeposit({
    depositId,
    userId: user.userId,
    tokenPaise: paise,
    depositAllocationPaise: rupeesToPaise(split.depositAllocation),
    reserveAllocationPaise: rupeesToPaise(split.reserveAllocation),
    usdtAmount,
    usdtRateInr: rate,
  });

  let invoice;
  try {
    invoice = await createInvoice({
      depositId,
      amount: usdtAmount,
      currency: config.invoiceCurrency,
      expiryMinutes: config.invoiceExpiryMinutes,
    });
  } catch (error) {
    // The invoice never existed, so nothing can ever pay it. Close the row
    // rather than leaving it AWAITING_PAYMENT — an open row blocks this
    // player's next attempt on the one-at-a-time rule above, which would turn
    // one upstream hiccup into a player who can never buy again.
    await db.usdtDeposits.transition(depositId, 'INVALID', {
      txId: `${depositId}:invoice_failed`,
      actor: 'system',
      reason: 'BTCPay would not create an invoice',
      set: { failureReason: String(error?.code || error?.message || 'BTCPAY_CREATE_FAILED') },
    });
    throw error;
  }

  const attached = await db.usdtDeposits.attachInvoice({
    depositId,
    invoiceId: invoice.invoiceId,
    checkoutLink: invoice.checkoutLink,
    expiresAt: invoice.expiresAt,
  });

  emitAdminUpdate('usdt_deposit_created', {
    depositId, userId: user.userId, tokenAmount: amount, usdtAmount, server_ts: Date.now(),
  });

  return { deposit: toPlayerDepositView(attached ?? await db.usdtDeposits.getDeposit(depositId)) };
}

/**
 * BTCPay says an invoice settled. Credit the player, once.
 *
 * ── Ordering: state, then money, and why it is that way round here ─────────
 * The INR deposit moves money BEFORE the status, because there the status is
 * the last word and a crash between them leaves a PAID order whose next confirm
 * replays the movements as no-ops.
 *
 * Here it is the other way, and the difference is the caller. BTCPay RETRIES a
 * delivery it did not get a 2xx for, and anybody who captures a signed body can
 * replay it forever. So the guarded transition goes first and IS the admission
 * gate: exactly one delivery moves AWAITING_PAYMENT → SETTLED, and only that
 * one reaches the credit. The others are told `already_there` and answered 200,
 * because "you already told me" is a success from BTCPay's side.
 *
 * A crash between the transition and the credit leaves a SETTLED deposit with
 * `credited_at` null — which is a named, findable state, not a silent one, and
 * the wallet's own `dep_complete_<id>` key makes the repair a replay.
 *
 * ── The amount is READ, never received ─────────────────────────────────────
 * Nothing in `event` decides how many tokens are minted. The row does. That is
 * the whole reason a webhook can be trusted with a mint at all.
 */
export async function settleUsdtDeposit({ invoiceId, deliveryId = null } = {}) {
  const deposit = await db.usdtDeposits.getDepositByInvoice(invoiceId);
  // An invoice we did not create. Not an error to shout about — anyone can POST
  // a well-signed body for a store that also serves something else — but it
  // must never create a row, because a row is a claim on tokens.
  if (!deposit) return { ok: false, reason: 'unknown_invoice' };

  const moved = await db.usdtDeposits.transition(deposit.depositId, 'SETTLED', {
    txId: `${deposit.depositId}:SETTLED`,
    actor: 'btcpay',
    reason: 'Invoice settled',
    deliveryId,
    ledgerKey: `dep_complete_${deposit.depositId}`,
  });

  if (!moved.ok) {
    // `already_there` and `duplicate` are the redelivery cases and are a
    // success: the money moved on the delivery that won.
    const settled = ['already_there', 'duplicate'].includes(moved.reason);
    return { ok: settled, reason: moved.reason, alreadySettled: settled };
  }

  // ── The money, from the row ─────────────────────────────────────────────
  // Minted, because no merchant parted with anything. The movement carries the
  // deposit id as its key, so a repair after a crash replays it as a no-op.
  const mint = await db.treasury.mintToUser(rupeesToPaise(deposit.tokenAmount), {
    movementId: `usdt_mint_${deposit.depositId}`,
    operation: 'MINT_TO_USER',
    actor: 'btcpay',
    reason: `USDT deposit ${deposit.depositId} settled`,
    refModel: 'UsdtDeposit',
    refId: deposit.depositId,
  });
  if (!mint.ok) {
    // The supply cap refused it. The player HAS paid, so this is money owed and
    // must be loud: the deposit stays SETTLED and uncredited, which is exactly
    // the state an operator can find and act on.
    console.error(
      `[usdt] ${deposit.depositId}: mint refused (${mint.reason}) — the player has paid and is NOT credited`,
    );
    return { ok: false, reason: mint.reason, owed: deposit.tokenAmount };
  }

  // Both keyed on the DEPOSIT ID, so the wallet's unique-tx_id gate is the last
  // line under the two above.
  if (deposit.depositAllocation > 0) {
    await creditDeposit(deposit.userId, deposit.depositAllocation, deposit.depositId);
  }
  if (deposit.reserveAllocation > 0) {
    await creditReserve(deposit.userId, deposit.reserveAllocation, deposit.depositId);
  }

  // `credited_at` is stamped directly rather than through a transition,
  // because it is not a new state: it is a fact ABOUT the settle, and the
  // audit row for that already exists. A transition SETTLED → SETTLED is
  // refused by design, and calling one here and swallowing the refusal would
  // be a write that quietly does nothing.
  //
  // It is what separates "settled and paid" from "settled and the process died
  // before the wallet moved" — a state an operator can find rather than a
  // silence they cannot.
  await db.usdtDeposits.markCredited(deposit.depositId);

  await emitWalletUpdate(deposit.userId);
  emitOrderUpdate(String(deposit.userId), 'usdt_deposit_settled', {
    depositId: deposit.depositId,
    status: 'SETTLED',
    tokenAmount: deposit.tokenAmount,
    server_ts: Date.now(),
  });
  emitAdminUpdate('usdt_deposit_settled', {
    depositId: deposit.depositId, userId: deposit.userId,
    tokenAmount: deposit.tokenAmount, server_ts: Date.now(),
  });

  return { ok: true, credited: deposit.tokenAmount, depositId: deposit.depositId };
}

/**
 * BTCPay says an invoice expired or turned out invalid. Nothing is owed.
 *
 * The player never sent USDT, so there is nothing to refund and nothing to
 * reverse — an expired invoice is the ABSENCE of a transaction. This exists so
 * the row stops blocking the player's next attempt and their screen stops
 * offering a checkout link BTCPay will refuse.
 */
export async function closeUsdtDeposit({ invoiceId, state, deliveryId = null, reason = null }) {
  const deposit = await db.usdtDeposits.getDepositByInvoice(invoiceId);
  if (!deposit) return { ok: false, reason: 'unknown_invoice' };

  const moved = await db.usdtDeposits.transition(deposit.depositId, state, {
    txId: `${deposit.depositId}:${state}`,
    actor: 'btcpay',
    reason: reason || `Invoice ${state.toLowerCase()}`,
    deliveryId,
    set: { failureReason: reason },
  });
  if (moved.ok) {
    emitOrderUpdate(String(deposit.userId), 'usdt_deposit_closed', {
      depositId: deposit.depositId, status: state, server_ts: Date.now(),
    });
  }
  return moved.ok
    ? { ok: true, depositId: deposit.depositId, state }
    : { ok: ['already_there', 'duplicate'].includes(moved.reason), reason: moved.reason };
}

/**
 * A payment has been seen on chain but is not confirmed.
 *
 * It moves NO money. It exists so a player's screen can say "we can see your
 * payment, waiting for confirmations" instead of the same "waiting" it showed
 * before they sent anything — two states that must not look alike.
 */
export async function markUsdtDepositProcessing({ invoiceId, deliveryId = null }) {
  const deposit = await db.usdtDeposits.getDepositByInvoice(invoiceId);
  if (!deposit) return { ok: false, reason: 'unknown_invoice' };
  const moved = await db.usdtDeposits.transition(deposit.depositId, 'PROCESSING', {
    txId: `${deposit.depositId}:PROCESSING`,
    actor: 'btcpay', reason: 'Payment seen, awaiting confirmations', deliveryId,
  });
  if (moved.ok) {
    emitOrderUpdate(String(deposit.userId), 'usdt_deposit_processing', {
      depositId: deposit.depositId, status: 'PROCESSING', server_ts: Date.now(),
    });
  }
  return { ok: moved.ok, reason: moved.reason };
}

/**
 * Close the invoices whose window has passed.
 *
 * BTCPay sends `InvoiceExpired`, so this is the backstop for a delivery that
 * never arrived — the same reason the INR rail sweeps its own expiries rather
 * than trusting every callback to land.
 */
export async function expireUsdtDeposits({ limit = 100 } = {}) {
  const due = await db.usdtDeposits.findExpiredDeposits({ limit });
  let expired = 0;
  for (const deposit of due) {
    const moved = await db.usdtDeposits.transition(deposit.depositId, 'EXPIRED', {
      txId: `${deposit.depositId}:EXPIRED`,
      actor: 'system',
      reason: 'Invoice window passed with no confirmed payment',
    });
    if (moved.ok) {
      expired += 1;
      emitOrderUpdate(String(deposit.userId), 'usdt_deposit_closed', {
        depositId: deposit.depositId, status: 'EXPIRED', server_ts: Date.now(),
      });
    }
  }
  return { considered: due.length, expired };
}
