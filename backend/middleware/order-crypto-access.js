// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * order-crypto-access.js — the order tamper-evidence tag, and the guard over it.
 *
 * ── What the tag is for ─────────────────────────────────────────────────────
 * An HMAC over the order id under a server-held secret, written into
 * `order_states.order_hmac` at creation and never updated. A forged or guessed
 * order id has no valid tag, and a row whose id was edited in the database no
 * longer matches its own tag. It is not authorisation — that is the ownership
 * check below — it is detection of a row that did not come from this system.
 *
 * ── Rotation ────────────────────────────────────────────────────────────────
 * New orders sign with the CURRENT secret; verification ALSO accepts retained
 * rotation secrets (ORDER_HMAC_PREVIOUS_SECRETS, comma-separated) so rotating
 * ORDER_HMAC_SECRET never 403s an order signed under the old key. Mirrors the
 * PASETO previous-public-keys and Aadhaar previous-secrets overlap. Secrets are
 * read at CALL time, not at import, so a rotation takes effect without a
 * restart.
 */
import crypto from 'crypto';
import { db } from '#db';

const currentOrderSecret = () => process.env.ORDER_HMAC_SECRET || process.env.JWT_SECRET;
const orderVerifySecrets = () => [
  currentOrderSecret(),
  ...(process.env.ORDER_HMAC_PREVIOUS_SECRETS || '').split(',').map((s) => s.trim()).filter(Boolean),
].filter(Boolean);
const orderHmacWith = (secret, orderId) =>
  crypto.createHmac('sha256', secret).update(`order:${orderId}:v1`).digest('hex');

/** Warned once, not once per order: a boot-time misconfiguration, not an event. */
let warnedNoSecret = false;

/**
 * The tag for an order id, or null when no secret is configured.
 *
 * NULL, not a throw. `createOrderRecord` calls this for every funding order,
 * so a deployment that has set neither ORDER_HMAC_SECRET nor JWT_SECRET would
 * have had `createHmac` throw on the key — taking down order creation entirely,
 * on the money path, over the tamper-evidence tag. A missing secret must
 * degrade to an untagged order, loudly, not to a broken deposit. It cannot
 * reach production: `validateEnv` refuses to boot one without both secrets.
 */
export function deriveOrderHmac(orderId) {
  const secret = currentOrderSecret();
  if (!secret) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.warn('[order-crypto] ORDER_HMAC_SECRET and JWT_SECRET are both unset — '
        + 'orders will be created WITHOUT a tamper-evidence tag.');
    }
    return null;
  }
  return orderHmacWith(secret, orderId);
}

/** Does this deployment tag its orders at all? Read at call time, like the secrets. */
const orderTaggingConfigured = () => Boolean(currentOrderSecret());

/**
 * Timing-safe match against the current OR any retained rotation secret.
 *
 * EVERY candidate is evaluated — no early return — so the time taken never
 * reveals which secret matched, or how many are retained.
 */
export function verifyOrderHmac(orderId, stored) {
  if (!stored) return false;
  const presented = Buffer.from(String(stored));
  let ok = false;
  for (const secret of orderVerifySecrets()) {
    const expected = Buffer.from(orderHmacWith(secret, orderId));
    if (expected.length === presented.length && crypto.timingSafeEqual(expected, presented)) ok = true;
  }
  return ok;
}


/**
 * Guard a route that acts on somebody's funding order.
 *
 * Two checks, in this order: the order is one this system issued (the tag), and
 * the caller is entitled to it (buyer, its assigned merchant, or an admin).
 *
 * ── What changed with the store ────────────────────────────────────────────
 * The version this replaces looked the order up with `$or: [{orderId}, {_id:
 * …}]`, coercing the parameter to an ObjectId when it looked like one — so an
 * order was reachable by TWO different identifiers and the tag only ever
 * covered one of them. There is one identifier now, `order_id`, and it is the
 * one the tag is computed over.
 *
 * ── An order with NO tag is refused too, whenever tagging is configured ────
 * This used to wave an untagged order through, "because orders created before
 * the column existed have none". There are none: this platform has never held
 * a live order (CLAUDE.md §0.0). And the exemption was not hypothetical — the
 * one production creation path never wrote the tag, so EVERY live order was
 * untagged and the refusal below had never once run (see createOrderRecord).
 *
 * Every order this system writes now carries a tag, written with the row. A row
 * without one did not come from this system — it was inserted, or its tag was
 * stripped — which is the one thing the tag exists to detect. The single
 * exception is a deployment with no secret at all, where nothing CAN be tagged:
 * `deriveOrderHmac` warns at the first order and the guard degrades with it.
 * Production cannot be that deployment; `validateEnv` refuses to boot it.
 */
export async function orderAccessGuard(req, res, next) {
  try {
    const orderId = req.params.orderId || req.body?.orderId;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId required' });

    // ONE refusal for every reason. A caller cannot tell "no such order" from
    // "not yours" from "that tag does not verify", because order ids travel in
    // URLs and a distinguishable answer tells someone probing which ids are
    // real. This is the contract `ownedOrder` had before this guard replaced
    // it, and it is the reason this returns 404 rather than the 403 it used to.
    const refuse = () => res.status(404).json({ success: false, message: 'Order not found' });

    // The FULL record, not `getOrder`. `getOrder` maps twelve columns and omits
    // status, tokenAmount, the deposit/reserve split, the UTR and the merchant
    // snapshot — everything the handlers downstream actually read. Handing them
    // that shape as `req.p2pOrder` would leave every field they render
    // undefined, with no error anywhere: the exact "a route rewritten without
    // its service is a bug with a green test" failure.
    const order = await db.orders.getOrderRecord(orderId);
    if (!order) return refuse();

    // A tag that is PRESENT and wrong, or ABSENT on a deployment that tags
    // every order, is the tamper signal — see the note above. It is an
    // operational alarm, not an ordinary refusal: the row did not come from
    // this system.
    if (order.orderHmac ? !verifyOrderHmac(order.orderId, order.orderHmac) : orderTaggingConfigured()) {
      console.error(`[orderAccessGuard] HMAC ${order.orderHmac ? 'MISMATCH' : 'MISSING'} orderId=${order.orderId} — this row was not written by this system`);
      return refuse();
    }

    // A merchant arrives through `merchantAuth`, which sets `req.merchantId`
    // and does NOT set `req.user`. This read `req.user?.isMerchant`, a field no
    // middleware on this path populates, so the guard could never recognise a
    // merchant — mounting it as written would have refused every merchant
    // confirm on the deposit path.
    const uid = req.user?.userId ? String(req.user.userId) : null;
    const isBuyer = uid !== null && String(order.userId) === uid;
    const isMerchant = req.merchantId != null
      && order.merchantId != null && String(order.merchantId) === String(req.merchantId);
    const isAdmin = req.user?.isAdmin === true || req.user?.isSubAdmin === true;

    if (!isBuyer && !isMerchant && !isAdmin) return refuse();

    req.p2pOrder = order;
    req.orderRole = isAdmin ? 'admin' : (isMerchant ? 'merchant' : 'buyer');
    next();
  } catch (e) {
    // FAILS CLOSED. This guard decides who may act on somebody else's money, so
    // a database blip must not become an open door — unlike the IP deny-list,
    // which fails open because its false positives are ordinary users.
    console.error('[orderAccessGuard] access check failed:', e.message);
    res.status(500).json({ success: false, message: 'Access check failed' });
  }
}
