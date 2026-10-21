// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * merchantAccount.routes.js — a MERCHANT ACCOUNT's own screens (owner,
 * 2026-10-11 — Phase B of the merchants-and-agents plan). Mounted at
 * /api/merchant, behind `merchantAuth`.
 *
 * A merchant account (a DIRECT team, `teams.js`) serves INR orders itself,
 * through its own payment accounts and its own people:
 *
 *   payment accounts   UPI_QR or BANK, switched per direction, paused or
 *                      removed (merchantPaymentAccounts.js) — the OWNER's;
 *   sub-members        their own logins with roles DEPOSITS / WITHDRAWALS /
 *                      AUDIT and the accounts assigned to them
 *                      (merchantStaff.js) — the OWNER's;
 *   pool requests      tokens into or out of its pool, fulfilled by an admin
 *                      (teamPools.js) — the OWNER's;
 *   reports            per account and sub-member — the owner's and AUDIT's.
 *                      The orders behind them, with who pressed ✓ or ✗, are
 *                      GET /merchant/reports/orders(.xlsx), every merchant's.
 *
 * Every write is scoped to the session's own merchant in the repository's
 * WHERE (trap 16): an account or sub-member id of another merchant matches no
 * row. A session that is not a merchant account's is answered 403
 * NOT_A_MERCHANT_ACCOUNT.
 */
import express from 'express';
import { db } from '#db';
import { merchantAuth } from '../../middleware/merchantAuth.js';
import { respondError } from '../../shared/httpError.js';
import { normalisePhone, isValidMobile } from '../identity/signupFields.js';
import { NAME_IS_A_MOBILE_MESSAGE } from '../identity/mobileInText.js';
import { isAccountMobileRefusal, ACCOUNT_IS_A_MOBILE_MESSAGE } from '../payment/payoutAccount.js';
import { ownerOnly, ownerOrAudit } from './merchantActor.js';
import { rupeesToPaise } from '../../shared/money.js';
import { refuse as refuseTeam } from '../team/teamRefusals.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { merchantSizes, offeredSizes } from './denominations.js';
import { openMerchantPoolUsdtBuy } from '../payment/usdtDeposit.service.js';

const router = express.Router();

/** The session's merchant account (its DIRECT team), or a 403 that says it is not one. */
async function requireMerchantAccount(req, res, next) {
  try {
    const team = await db.teams.directTeamOf(req.merchantId);
    if (!team) {
      return res.status(403).json({
        success: false, code: 'NOT_A_MERCHANT_ACCOUNT',
        message: 'This is not a merchant account. An admin makes a merchant a merchant account.',
      });
    }
    req.directTeam = team;
    return next();
  } catch (err) {
    return respondError(res, err, 'merchant account', { message: 'Could not load the merchant account.' });
  }
}


/** A database refusal of an account's fields, in the words of the person saving it. */
function accountRefusal(res, err) {
  if (isAccountMobileRefusal(err)) {
    return res.status(400).json({ success: false, code: 'ACCOUNT_IS_A_MOBILE', message: ACCOUNT_IS_A_MOBILE_MESSAGE });
  }
  if (err?.code === '23505' && /one_handle/.test(err.constraint ?? '')) {
    return res.status(409).json({ success: false, code: 'UPI_ID_TAKEN', message: 'That UPI ID is already on another live account.' });
  }
  return null;
}

/**
 * The sizes the platform sends to merchant accounts now, per direction: the
 * admin's merchant sizes that are also on offer (owner, 2026-10-20). Every one
 * must be taken by some account of the merchant (merchantPaymentAccounts.js).
 */
async function requiredSizes() {
  const cfg = await getSystemConfig();
  const of = (direction) => merchantSizes(cfg, direction).filter((n) => offeredSizes(cfg, direction).includes(n));
  return { DEPOSIT: of('DEPOSIT'), WITHDRAWAL: of('WITHDRAWAL') };
}

/** A write that would leave a size with no account, in the owner's words, with what is left out. */
function sizesRefusal(res, err) {
  if (err?.code !== 'SIZES_UNCOVERED' && err?.code !== 'INVALID_ORDER_SIZES') return null;
  return res.status(err.status).json({
    success: false, code: err.code, message: err.message,
    ...(err.uncovered ? { uncovered: err.uncovered } : {}),
  });
}

// ── The overview ─────────────────────────────────────────────────────────────

/**
 * GET /api/merchant/account — the merchant account: its pool and commission,
 * its payment accounts, and (owner) its sub-members and recent flags. Every
 * signed-in person of the account reads it: a sub-member needs the account
 * list to name the one they paid a withdrawal from.
 */
router.get('/account', merchantAuth, requireMerchantAccount, async (req, res) => {
  try {
    const owner = req.merchantActor?.isOwner !== false;
    const [accounts, staff, flags, poolRequests, sizes, poolTrades] = await Promise.all([
      db.merchantPaymentAccounts.listAccounts(req.merchantId),
      owner ? db.merchantStaff.listStaff(req.merchantId) : null,
      db.merchantProblems.listFlags({ merchantId: req.merchantId, days: 30 }),
      owner ? db.teamPools.listRequests({ teamId: req.directTeam.teamId, limit: 50 }) : null,
      requiredSizes().then((required) => db.merchantPaymentAccounts.sizeCoverage(req.merchantId, required)),
      db.teamPools.poolTradeTotals(req.directTeam.teamId),
    ]);
    res.json({
      success: true,
      team: req.directTeam,
      accounts,
      // Which sizes the platform sends here, and which no account takes yet.
      sizes,
      // Tokens bought from the platform (owner, 2026-10-21).
      poolTrades,
      ...(owner ? { staff, poolRequests } : {}),
      flags,
    });
  } catch (err) {
    respondError(res, err, 'GET /merchant/account', { message: 'Could not load the merchant account.' });
  }
});

// ── Payment accounts (owner) ─────────────────────────────────────────────────

router.post('/account/payment-accounts', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const out = await db.merchantPaymentAccounts.addAccount(req.merchantId, req.body ?? {}, { required: await requiredSizes() });
    if (!out.ok) return res.status(403).json({ success: false, code: 'NOT_A_MERCHANT_ACCOUNT', message: 'This is not a merchant account.' });
    res.status(201).json({ success: true, account: out.account });
  } catch (err) {
    if (accountRefusal(res, err) || sizesRefusal(res, err)) return;
    respondError(res, err, 'POST /merchant/account/payment-accounts', { message: 'Could not add the account.' });
  }
});

/**
 * PUT /api/merchant/account/payment-accounts/sizes `{ accounts: [{ accountId,
 * buySizes, sellSizes }] }` — which order sizes go to which account, in one
 * save (owner, 2026-10-20). Refused 409 SIZES_UNCOVERED, with `uncovered`,
 * when a size the platform sends here would be left with no account.
 */
// Mounted before `/:accountId`, which would otherwise read "sizes" as an id.
router.put('/account/payment-accounts/sizes', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const out = await db.merchantPaymentAccounts.setAccountSizes(req.merchantId, req.body?.accounts,
      { required: await requiredSizes() });
    if (!out.ok) return res.status(404).json({ success: false, code: 'ACCOUNT_NOT_FOUND', message: 'One of those accounts is not a live account of yours.' });
    res.json({ success: true, accounts: out.accounts });
  } catch (err) {
    if (sizesRefusal(res, err)) return;
    respondError(res, err, 'PUT /merchant/account/payment-accounts/sizes', { message: 'Could not save the sizes.' });
  }
});

router.put('/account/payment-accounts/:accountId', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const out = await db.merchantPaymentAccounts.updateAccount(req.merchantId, req.params.accountId, req.body ?? {},
      { required: await requiredSizes() });
    if (!out.ok) return res.status(404).json({ success: false, code: 'ACCOUNT_NOT_FOUND', message: 'No such account.' });
    res.json({ success: true, account: out.account });
  } catch (err) {
    if (accountRefusal(res, err) || sizesRefusal(res, err)) return;
    respondError(res, err, 'PUT /merchant/account/payment-accounts/:id', { message: 'Could not save the account.' });
  }
});

router.delete('/account/payment-accounts/:accountId', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const out = await db.merchantPaymentAccounts.removeAccount(req.merchantId, req.params.accountId,
      { required: await requiredSizes() });
    if (!out.ok) return res.status(404).json({ success: false, code: 'ACCOUNT_NOT_FOUND', message: 'No such account.' });
    res.json({ success: true });
  } catch (err) {
    if (sizesRefusal(res, err)) return;
    respondError(res, err, 'DELETE /merchant/account/payment-accounts/:id', { message: 'Could not remove the account.' });
  }
});

// ── Sub-members (owner) ──────────────────────────────────────────────────────

/** End a sub-member's open streams now; their sessions already died with the cutoff. */
const closeStreams = (staff) => { try { global.sseManager?.closeMerchantClientsFor(staff.userId); } catch { /* best effort */ } };

router.post('/account/staff', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const { name, roles } = req.body ?? {};
    if (!isValidMobile(req.body?.mobile)) {
      return res.status(400).json({ success: false, code: 'MOBILE_INVALID',
        message: 'Enter the sub-member\'s 10-digit mobile number — the one on their Telegram account — without +91.' });
    }
    const mobile = normalisePhone(req.body.mobile);
    const out = await db.merchantStaff.addStaff(req.merchantId, {
      userId: db.users.newUserId(), mobile, name, roles, createdBy: req.userId,
    });
    if (!out.ok && out.reason === 'MOBILE_TAKEN') {
      return res.status(409).json({ success: false, code: 'MOBILE_TAKEN', message: 'That mobile number already has a merchant login.' });
    }
    if (!out.ok && out.reason === 'NAME_IS_A_MOBILE') {
      return res.status(400).json({ success: false, code: 'NAME_IS_A_MOBILE', message: NAME_IS_A_MOBILE_MESSAGE });
    }
    if (!out.ok) return res.status(403).json({ success: false, code: 'NOT_A_MERCHANT_ACCOUNT', message: 'This is not a merchant account.' });
    // No password (owner, 2026-10-14): they sign in with "Continue with
    // Telegram" at the merchant door, and their first Verify shares the
    // contact of this mobile, which links this login (§33).
    res.status(201).json({ success: true, staff: out.staff });
  } catch (err) {
    respondError(res, err, 'POST /merchant/account/staff', { message: 'Could not add the sub-member.' });
  }
});

router.put('/account/staff/:staffId/roles', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const out = await db.merchantStaff.setRoles(req.merchantId, req.params.staffId, req.body?.roles);
    if (!out.ok) return res.status(404).json({ success: false, code: 'STAFF_NOT_FOUND', message: 'No such sub-member.' });
    closeStreams(out.staff);
    res.json({ success: true, staff: await db.merchantStaff.getStaff(req.merchantId, req.params.staffId) });
  } catch (err) {
    respondError(res, err, 'PUT /merchant/account/staff/:id/roles', { message: 'Could not change the roles.' });
  }
});

router.delete('/account/staff/:staffId', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const out = await db.merchantStaff.removeStaff(req.merchantId, req.params.staffId);
    if (!out.ok) return res.status(404).json({ success: false, code: 'STAFF_NOT_FOUND', message: 'No such sub-member.' });
    closeStreams(out.staff);
    res.json({ success: true });
  } catch (err) {
    respondError(res, err, 'DELETE /merchant/account/staff/:id', { message: 'Could not remove the sub-member.' });
  }
});

router.post('/account/staff/:staffId/accounts', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const { accountId, duty } = req.body ?? {};
    const out = await db.merchantStaff.assignAccount(req.merchantId, req.params.staffId, accountId, duty);
    if (!out.ok && out.reason === 'not_found') {
      return res.status(404).json({ success: false, code: 'STAFF_NOT_FOUND', message: 'No such sub-member.' });
    }
    if (!out.ok) {
      return res.status(409).json({ success: false, code: 'CANNOT_ASSIGN',
        message: 'Assign one of your live accounts, for a duty the sub-member\'s roles include (DEPOSIT needs DEPOSITS, WITHDRAWAL needs WITHDRAWALS).' });
    }
    res.json({ success: true, staff: await db.merchantStaff.getStaff(req.merchantId, req.params.staffId) });
  } catch (err) {
    respondError(res, err, 'POST /merchant/account/staff/:id/accounts', { message: 'Could not assign the account.' });
  }
});

router.delete('/account/staff/:staffId/accounts/:accountId/:duty', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const { staffId, accountId, duty } = req.params;
    const out = await db.merchantStaff.unassignAccount(req.merchantId, staffId, accountId, duty);
    if (!out.ok) return res.status(404).json({ success: false, code: 'NOT_ASSIGNED', message: 'That account is not assigned to them for that duty.' });
    res.json({ success: true, staff: await db.merchantStaff.getStaff(req.merchantId, staffId) });
  } catch (err) {
    respondError(res, err, 'DELETE /merchant/account/staff/:id/accounts', { message: 'Could not unassign the account.' });
  }
});

// ── The pool (owner) ─────────────────────────────────────────────────────────

/**
 * POST /api/merchant/account/pool-requests — ask the platform to sell tokens
 * into the merchant account's pool, in whole tokens. An admin with
 * `canFundMerchants` fulfils it (Team pool requests). Nothing is sold back
 * (owner, 2026-10-21): another `direction` is 400 POOL_BUY_ONLY.
 */
router.post('/account/pool-requests', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const tokens = Number(req.body?.tokens);
    if (!Number.isInteger(tokens) || tokens <= 0) {
      return res.status(400).json({ success: false, code: 'BAD_TOKENS', message: 'Enter a whole number of tokens greater than zero.' });
    }
    const out = await db.teamPools.createRequest({
      teamId: req.directTeam.teamId, supervisorId: req.merchantId,
      direction: String(req.body?.direction ?? 'BUY').toUpperCase(), tokenAmountPaise: rupeesToPaise(tokens), note: req.body?.note,
    });
    if (!out.ok) return refuseTeam(res, out.reason);
    res.status(201).json({ success: true, requestId: out.requestId });
  } catch (err) {
    respondError(res, err, 'POST /merchant/account/pool-requests', { message: 'Could not send the request.' });
  }
});

/**
 * POST /api/merchant/account/pool-requests/usdt { tokens } — buy pool tokens
 * from the platform in USDT, the way a player buys (owner, 2026-10-21): an
 * address of its own on BNB Smart Chain and the price, and the tokens arrive
 * by themselves once the USDT does. No admin step.
 */
router.post('/account/pool-requests/usdt', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const tokens = Number(req.body?.tokens);
    if (!Number.isInteger(tokens) || tokens <= 0) {
      return res.status(400).json({ success: false, code: 'BAD_TOKENS', message: 'Enter a whole number of tokens greater than zero.' });
    }
    const out = await openMerchantPoolUsdtBuy({
      teamId: req.directTeam.teamId, supervisorId: req.merchantId, tokenAmountPaise: rupeesToPaise(tokens),
    });
    if (!out.ok) return refuseTeam(res, out.reason);
    res.status(201).json({ success: true, request: await db.teamPools.getRequest(out.requestId) });
  } catch (err) {
    respondError(res, err, 'POST /merchant/account/pool-requests/usdt', { message: 'Could not start the USDT payment.' });
  }
});

router.delete('/account/pool-requests/:requestId', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const out = await db.teamPools.cancelRequest({ requestId: req.params.requestId, supervisorId: req.merchantId });
    if (!out.ok) return refuseTeam(res, out.reason);
    res.json({ success: true });
  } catch (err) {
    respondError(res, err, 'DELETE /merchant/account/pool-requests/:id', { message: 'Could not cancel the request.' });
  }
});

// ── Reports (owner and AUDIT) ────────────────────────────────────────────────

const ZERO = () => ({ orders: 0, completed: 0, completedPaise: 0, disputed: 0, disputesLost: 0 });
const add = (into, row) => {
  for (const k of Object.keys(into)) into[k] += row[k];
  return into;
};

/**
 * GET /api/merchant/account/reports?from=YYYY-MM-DD&to=YYYY-MM-DD — deposits
 * and withdrawals over a range of IST days (default: the last seven), per
 * payment account and per sub-member: counts, completed counts and tokens,
 * disputes and disputes lost. A sub-member's figures are their accounts' for
 * the duty they hold them for.
 */
router.get('/account/reports', merchantAuth, requireMerchantAccount, ownerOrAudit, async (req, res) => {
  try {
    const range = { from: req.query.from || null, to: req.query.to || null };
    const [rows, accounts, staff] = await Promise.all([
      db.merchantReports.accountTotals(req.merchantId, range),
      db.merchantPaymentAccounts.listAccounts(req.merchantId, { includeRemoved: true }),
      db.merchantStaff.listStaff(req.merchantId, { includeRemoved: true }),
    ]);
    const byAccount = accounts.map((a) => ({
      accountId: a.accountId, label: a.label, kind: a.kind, status: a.status,
      deposits: rows.filter((r) => r.accountId === a.accountId && r.direction === 'DEPOSIT').reduce(add, ZERO()),
      withdrawals: rows.filter((r) => r.accountId === a.accountId && r.direction === 'WITHDRAWAL').reduce(add, ZERO()),
    }));
    const unattributed = {
      deposits: rows.filter((r) => r.accountId === null && r.direction === 'DEPOSIT').reduce(add, ZERO()),
      withdrawals: rows.filter((r) => r.accountId === null && r.direction === 'WITHDRAWAL').reduce(add, ZERO()),
    };
    const bySubMember = staff.map((st) => {
      const mine = (duty, direction) => rows.filter((r) => r.direction === direction
        && st.assignments.some((x) => x.duty === duty && x.accountId === r.accountId)).reduce(add, ZERO());
      return {
        staffId: st.staffId, name: st.name, roles: st.roles, status: st.status,
        deposits: mine('DEPOSIT', 'DEPOSIT'), withdrawals: mine('WITHDRAWAL', 'WITHDRAWAL'),
      };
    });
    const totals = {
      deposits: rows.filter((r) => r.direction === 'DEPOSIT').reduce(add, ZERO()),
      withdrawals: rows.filter((r) => r.direction === 'WITHDRAWAL').reduce(add, ZERO()),
    };
    res.json({ success: true, range, totals, byAccount, bySubMember, unattributed });
  } catch (err) {
    respondError(res, err, 'GET /merchant/account/reports', { message: 'Could not build the report.' });
  }
});

export default router;
