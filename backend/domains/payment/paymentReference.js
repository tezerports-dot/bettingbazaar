// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * paymentReference.js — what counts as proof that a payment was made, and what
 * to call it when talking to the person who made it.
 *
 * ── One registry, three kinds of reference ─────────────────────────────────
 * A UTR is a bank's reference for an INR transfer. A transaction hash is a
 * blockchain's reference for a USDT transfer. A CDM slip carries the machine's
 * reference for a cash deposit. They look nothing alike and they mean exactly
 * the same thing: THIS payment happened, once.
 *
 * So they share one registry (`utr_registry`), because the property that
 * matters is the one they share — a reference may be claimed by ONE order, ever.
 * Two registries would let the same string be spent once on each, and the whole
 * point is that a payment cannot be claimed twice.
 *
 * ── What this module is for ────────────────────────────────────────────────
 * The registry decides UNIQUENESS. It cannot decide whether a string is even a
 * plausible reference, and it should not: a player who mistypes their hash has
 * made a payment nobody can match, and the only cheap moment to tell them is
 * before it is claimed. That is this module — the SHAPE, and the NAME to use in
 * the sentence.
 *
 * Naming matters more than it looks. "This UTR was already used" shown to
 * somebody who submitted a Tron hash reads as a different system's error, and
 * they will submit it again.
 */
import { MERCHANT_CURRENCY, USDT_CHAIN_SPEC } from '../merchant/merchantCurrency.js';
import { markUTRAsUsed, normalizeUTR } from '../../middleware/utrValidation.js';

/** The minimum length of a bank UTR. Twelve is the shortest a bank issues. */
const MIN_UTR_LENGTH = 12;

/**
 * What this order's payment reference is called and what it must look like.
 *
 * Derived from the ORDER — its currency and, on USDT, its chain — never from
 * what the submitter says it is. A caller who could name its own format could
 * submit anything.
 */
export function referenceSpecFor(order) {
  if (order?.currency === MERCHANT_CURRENCY.USDT) {
    const chain = USDT_CHAIN_SPEC[order?.usdtChain];
    // A USDT order with no chain cannot say what a valid hash looks like. It is
    // refused rather than falling back to the bank rule, which would accept a
    // twelve-character string as proof of a blockchain transfer.
    if (!chain) {
      return {
        label: 'transaction ID',
        valid: () => false,
        hint: 'This order names no network, so its transaction ID cannot be checked. Contact support.',
      };
    }
    return {
      label: 'transaction ID',
      valid: (value) => chain.txPattern.test(value),
      hint: `Enter the ${chain.label} transaction ID — ${chain.txLabel}.`,
    };
  }
  return {
    label: 'UTR',
    valid: (value) => value.length >= MIN_UTR_LENGTH,
    hint: `The UTR is at least ${MIN_UTR_LENGTH} characters. It is on your payment receipt.`,
  };
}

/**
 * The sentence a person is shown when their reference is already spent.
 *
 * Said in THEIR vocabulary and it names the fact plainly — the payment behind
 * this reference has already been counted. A vague "invalid reference" has
 * somebody retyping a string that will never be accepted.
 */
export function duplicateMessage(spec, reason) {
  if (reason === 'FRAUD_FLAGGED') {
    return `This ${spec.label} is under review. Contact support.`;
  }
  return `This ${spec.label} has already been used for another order. `
    + 'Each payment can only be claimed once — check you have copied the right one, '
    + 'and contact support if you believe this is a mistake.';
}


/**
 * Claim a reference for one order, or refuse it by name.
 *
 * ── Why every path calls THIS and not the registry directly ────────────────
 * Three money paths record an external payment reference: a player's UTR or
 * transaction hash on a buy, the bank reference on a CDM slip, and the hash a
 * merchant gives when buying platform tokens with USDT. Only the first of them
 * ever claimed one. The other two wrote the reference into a column and nothing
 * stopped the same string being used twice — so one real payment could be
 * presented as two, on two different orders, and every check was green.
 *
 * Three copies of "claim, and say something if it is taken" would drift, and
 * the direction they drift is toward a path that forgets to claim. So the claim
 * has one owner, and `check:payment-references` fails the build on a path that
 * writes a reference column without coming through here.
 *
 * Throws rather than returning a flag. A caller that gets a `false` back can
 * ignore it; a throw stops the write that was about to happen.
 */
export async function claimPaymentReference({
  reference, orderId, userId = null, amountRupees = null, spec,
}) {
  const normalized = normalizeUTR(reference);
  if (!normalized || !spec.valid(normalized)) {
    throw Object.assign(new Error(spec.hint), { status: 400, code: 'INVALID_PAYMENT_REFERENCE' });
  }

  const claimed = await markUTRAsUsed(normalized, orderId, userId, amountRupees);
  if (!claimed.ok) {
    throw Object.assign(
      new Error(duplicateMessage(spec, claimed.reason)),
      {
        status: 409,
        code: claimed.reason,
        // WHICH order already holds it. Support answering "it says already
        // used" needs this, and looking it up a second time is a query that can
        // return something different from the one that refused the claim.
        originalOrderId: claimed.entry?.orderId ?? null,
      },
    );
  }
  return { reference: normalized, idempotent: Boolean(claimed.idempotent) };
}

/**
 * The reference rule for a CDM slip: a bank's own transaction id for a cash
 * deposit at a machine. Not an order's currency — a CDM slip is a bank
 * reference whatever the order was created in.
 */
export const CDM_REFERENCE_SPEC = Object.freeze({
  label: 'bank transaction id',
  valid: (value) => value.length >= 6,
  hint: 'Enter the bank transaction id from the CDM slip — it is what a dispute is matched against.',
});

/** The reference rule for a merchant paying the platform in USDT. */
export const MERCHANT_TOKEN_REFERENCE_SPEC = Object.freeze({
  label: 'transaction ID',
  // Either chain's shape. A merchant pays the platform's own wallet and the
  // platform accepts both networks, so this cannot narrow to one of them.
  valid: (value) => Object.values(USDT_CHAIN_SPEC).some((c) => c.txPattern.test(value)),
  hint: 'Enter the USDT transaction ID for your payment — 64 hexadecimal characters, with or without a leading 0x.',
});
