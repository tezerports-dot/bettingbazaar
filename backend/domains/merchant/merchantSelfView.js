// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * merchantSelfView.js — the merchant's own view of their account.
 *
 * What `GET /api/merchant/profile` and the profile writes answer with, and what
 * every merchant sign-in hands the panel (`issueMerchantSession`, routes.js).
 * One projection (§5): the sign-in kept a hand-built copy that lacked whatever
 * was added here since, `isSupervisor` among it, so a supervisor signing in was
 * shown a member's online switch until the next reload.
 *
 * A member holds no tokens — their team's pool does (§3.10) — so there is no
 * balance here; the Team page shows the pool.
 */
import { merchantTypeOf, usdtChainsHeldBy } from './merchantCurrency.js';

/**
 * @param {object} merchant  a `merchants` row as the repository maps it
 * @param {object} [user]    the login row, whose username and mobile win
 */
export function formatMerchant(merchant, user = null) {
  // A merchant settles on exactly one rail; the panel renders the bank account
  // OR the USDT addresses from this, never both (domains/merchant/merchantCurrency.js).
  // merchantTypeOf() is used rather than the `merchantType` virtual so lean()
  // documents (which carry no virtuals) format identically to hydrated ones.
  const merchantType = merchantTypeOf(merchant);
  return {
    id:                   merchant._id,
    _id:                  merchant._id,
    userId:               merchant.userId,
    name:                 merchant.name,
    username:             user?.username || merchant.username,
    mobile:               user?.mobile   || merchant.mobile,
    email:                merchant.email,
    status:               merchant.status,
    // A supervisor runs teams and takes no orders (§2): the panel hides
    // the member's online switch and order settings for them, and the
    // server refuses both (`SUPERVISOR_TAKES_NO_ORDERS`).
    isSupervisor:         merchant.isSupervisor === true,
    isOnline:             merchant.isOnline,
    acceptsDeposits:      merchant.acceptsDeposits,
    acceptsWithdrawals:   merchant.acceptsWithdrawals,
    merchantType,
    acceptedCurrencies:   merchant.acceptedCurrencies,
    bankDetails:          merchant.bankDetails,
    // One per chain, and the list of chains they can actually be paid on
    // — which is what decides whether any USDT order reaches them.
    usdtAddressTrc20:     merchant.usdtAddressTrc20 || '',
    usdtAddressBep20:     merchant.usdtAddressBep20 || '',
    usdtChains:           usdtChainsHeldBy(merchant),
    limits:               merchant.limits,
    // Whether the platform has stopped sending them new buy orders (three
    // unpaid in a row, §2). A merchant was never told: the Dashboard read
    // "Online · Accepting orders" while no order could reach them. Only the
    // TIME is sent — the stored reason is written for an admin.
    assignmentPausedAt:   merchant.assignmentPausedAt ?? null,
    // A CASH member's Ready: at the machine and able to take a buy. Each
    // buy assigned to them switches it off (§3.10, 2c).
    cashReady:            merchant.cashReady === true,
    earnings:             merchant.earnings,
    totalProcessedVolume: merchant.totalProcessedVolume,
    // Performance figures the panel's dashboard/profile show; all are
    // maintained by the order lifecycle — read-only here.
    totalDepositsProcessed:    merchant.totalDepositsProcessed,
    totalDepositAmount:        merchant.totalDepositAmount,
    totalWithdrawalsProcessed: merchant.totalWithdrawalsProcessed,
    totalWithdrawalAmount:     merchant.totalWithdrawalAmount,
    successRate:               merchant.successRate,
    avgResponseMinutes:        merchant.avgResponseMinutes,
    disputeRate:               merchant.disputeRate,
    totalOrdersCompleted:      merchant.totalOrdersCompleted,
    rating:               merchant.rating,
    createdAt:            merchant.createdAt,
  };
}
