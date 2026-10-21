// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/support/merchantSupport.routes.js — the merchant's support desk
 * (CLAUDE.md §2, "Support desks"), mounted at /api/merchant/support.
 *
 * Its own desk, queue and staff permission, apart from the players' (owner,
 * 2026-10-21). A ticket belongs to the LOGIN that opened it (`req.userId`: the
 * owner, or a merchant account's sub-member with their own Telegram); a
 * dispute contact is for an order assigned to this merchant.
 */
import { merchantAuth } from '../../middleware/merchantAuth.js';
import { accountSupportRouter } from './accountSupport.routes.js';

export default accountSupportRouter({
  desk: 'MERCHANT',
  authenticate: merchantAuth,
  // A merchant row made before merchants had a login of their own carries no
  // user id; its tickets are the merchant's.
  accountOf: (req) => req.userId || String(req.merchantId),
  orderOwner: (req) => ({ merchantId: String(req.merchantId) }),
});
