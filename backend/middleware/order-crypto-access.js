// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
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
 * NULL, not a throw. `openOrder` calls this for every funding order, so a
 * deployment that has set neither ORDER_HMAC_SECRET nor JWT_SECRET would have
 * had `createHmac` throw on the key — taking down order creation entirely, on
 * the money path, over an OPTIONAL tamper-evidence tag. An untagged order is
 * exactly what this platform had before the tag existed and the guard passes
 * it; a missing secret must degrade to that, loudly, not to a broken deposit.
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
 * The document-model pre-save hook, kept only until those models go.
 *
 * `user.model.js` and `paymentOrder.model.js` still register it, and a missing
 * export makes their schema construction throw at import time — which takes
 * four unrelated test files down with it, since importing any model loads the
 * whole registry. It signs nothing that PostgreSQL reads: `openOrder` writes
 * the tag with the row. Delete this with the models.
 */
export function setOrderHmacHook() {
  if (this.isNew || !this.orderHmac) this.orderHmac = deriveOrderHmac(this.orderId);
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
 * An order with NO tag is allowed through. Orders created before the column
 * existed have none, and refusing those would lock their owners out of their
 * own money; a tag that is present and wrong is the tamper signal, and that is
 * refused.
 */
export async function orderAccessGuard(req, res, next) {
  try {
    const orderId = req.params.orderId || req.body?.orderId;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId required' });

    const order = await db.orders.getOrder(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.orderHmac && !verifyOrderHmac(order.orderId, order.orderHmac)) {
      console.error(`[orderAccessGuard] HMAC mismatch orderId=${order.orderId}`);
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const uid = req.user?.userId ? String(req.user.userId) : null;
    const isBuyer = uid !== null && String(order.userId) === uid;
    const isMerchant = req.user?.isMerchant === true
      && order.merchantId != null && String(order.merchantId) === String(req.merchantId);
    const isAdmin = req.user?.isAdmin === true || req.user?.isSubAdmin === true;

    if (!isBuyer && !isMerchant && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

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
