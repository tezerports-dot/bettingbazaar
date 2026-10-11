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
 *   reports            per account and sub-member, with a CSV — the owner's
 *                      and AUDIT's.
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
import { hashPassword } from '../identity/password.util.js';
import { assertStaffPassword } from '../identity/passwordPolicy.js';
import { normalisePhone, isValidMobile } from '../identity/signupFields.js';
import { NAME_IS_A_MOBILE_MESSAGE } from '../identity/mobileInText.js';
import { isAccountMobileRefusal, ACCOUNT_IS_A_MOBILE_MESSAGE } from '../payment/payoutAccount.js';
import { ownerOnly, ownerOrAudit } from './merchantActor.js';
import { rupeesToPaise } from '../../shared/money.js';
import { toCsv } from '../reporting/csv.util.js';
import { refuse as refuseTeam } from '../team/teamRefusals.js';

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
    const [accounts, staff, flags, poolRequests] = await Promise.all([
      db.merchantPaymentAccounts.listAccounts(req.merchantId),
      owner ? db.merchantStaff.listStaff(req.merchantId) : null,
      db.merchantProblems.listFlags({ merchantId: req.merchantId, days: 30 }),
      owner ? db.teamPools.listRequests({ teamId: req.directTeam.teamId, limit: 50 }) : null,
    ]);
    res.json({
      success: true,
      team: req.directTeam,
      accounts,
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
    const out = await db.merchantPaymentAccounts.addAccount(req.merchantId, req.body ?? {});
    if (!out.ok) return res.status(403).json({ success: false, code: 'NOT_A_MERCHANT_ACCOUNT', message: 'This is not a merchant account.' });
    res.status(201).json({ success: true, account: out.account });
  } catch (err) {
    if (accountRefusal(res, err)) return;
    respondError(res, err, 'POST /merchant/account/payment-accounts', { message: 'Could not add the account.' });
  }
});

router.put('/account/payment-accounts/:accountId', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const out = await db.merchantPaymentAccounts.updateAccount(req.merchantId, req.params.accountId, req.body ?? {});
    if (!out.ok) return res.status(404).json({ success: false, code: 'ACCOUNT_NOT_FOUND', message: 'No such account.' });
    res.json({ success: true, account: out.account });
  } catch (err) {
    if (accountRefusal(res, err)) return;
    respondError(res, err, 'PUT /merchant/account/payment-accounts/:id', { message: 'Could not save the account.' });
  }
});

router.delete('/account/payment-accounts/:accountId', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const out = await db.merchantPaymentAccounts.removeAccount(req.merchantId, req.params.accountId);
    if (!out.ok) return res.status(404).json({ success: false, code: 'ACCOUNT_NOT_FOUND', message: 'No such account.' });
    res.json({ success: true });
  } catch (err) {
    respondError(res, err, 'DELETE /merchant/account/payment-accounts/:id', { message: 'Could not remove the account.' });
  }
});

// ── Sub-members (owner) ──────────────────────────────────────────────────────

/** End a sub-member's open streams now; their sessions already died with the cutoff. */
const closeStreams = (staff) => { try { global.sseManager?.closeMerchantClientsFor(staff.userId); } catch { /* best effort */ } };

router.post('/account/staff', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const { name, password, roles } = req.body ?? {};
    if (!isValidMobile(req.body?.mobile)) {
      return res.status(400).json({ success: false, code: 'MOBILE_INVALID',
        message: 'Enter the sub-member\'s 10-digit mobile number — the one on their Telegram account — without +91.' });
    }
    const mobile = normalisePhone(req.body.mobile);
    try {
      assertStaffPassword(password, { mobile, username: name }, 'merchant');
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, code: e.code, message: e.message });
    }
    const out = await db.merchantStaff.addStaff(req.merchantId, {
      userId: db.users.newUserId(), mobile, passwordHash: await hashPassword(password),
      name, roles, createdBy: req.userId,
    });
    if (!out.ok && out.reason === 'MOBILE_TAKEN') {
      return res.status(409).json({ success: false, code: 'MOBILE_TAKEN', message: 'That mobile number already has a merchant login.' });
    }
    if (!out.ok && out.reason === 'NAME_IS_A_MOBILE') {
      return res.status(400).json({ success: false, code: 'NAME_IS_A_MOBILE', message: NAME_IS_A_MOBILE_MESSAGE });
    }
    if (!out.ok) return res.status(403).json({ success: false, code: 'NOT_A_MERCHANT_ACCOUNT', message: 'This is not a merchant account.' });
    // They sign in at the merchant door, and verify their mobile in Telegram
    // there first like every merchant login (§33).
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
 * into the merchant account's pool (BUY) or buy them back (SELL), in whole
 * tokens. An admin with `canFundMerchants` fulfils it (Team pool requests).
 */
router.post('/account/pool-requests', merchantAuth, requireMerchantAccount, ownerOnly, async (req, res) => {
  try {
    const tokens = Number(req.body?.tokens);
    if (!Number.isInteger(tokens) || tokens <= 0) {
      return res.status(400).json({ success: false, code: 'BAD_TOKENS', message: 'Enter a whole number of tokens greater than zero.' });
    }
    const out = await db.teamPools.createRequest({
      teamId: req.directTeam.teamId, supervisorId: req.merchantId,
      direction: req.body?.direction, tokenAmountPaise: rupeesToPaise(tokens), note: req.body?.note,
    });
    if (!out.ok) return refuseTeam(res, out.reason);
    res.status(201).json({ success: true, requestId: out.requestId });
  } catch (err) {
    respondError(res, err, 'POST /merchant/account/pool-requests', { message: 'Could not send the request.' });
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

/** GET /api/merchant/account/reports/orders.csv?from&to — the orders behind the report, as CSV. */
router.get('/account/reports/orders.csv', merchantAuth, requireMerchantAccount, ownerOrAudit, async (req, res) => {
  try {
    const rows = await db.merchantReports.ordersForExport(req.merchantId, {
      from: req.query.from || null, to: req.query.to || null,
    });
    const csv = toCsv(rows.map((r) => ({
      order_id: r.order_id,
      direction: r.order_type,
      state: r.state,
      tokens: Number(r.token_amount_paise) / 100,
      utr: r.utr ?? '',
      account_id: r.pay_account_id ?? r.paid_from_account_id ?? '',
      account_label: r.account_label ?? '',
      created_at: r.created_at?.toISOString?.() ?? r.created_at,
      completed_at: r.completed_at?.toISOString?.() ?? (r.completed_at ?? ''),
      disputed: r.dispute_raised_at ? 'yes' : 'no',
      dispute_lost: r.dispute_lost ? 'yes' : 'no',
    })));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="merchant-orders-${req.query.from || 'last7'}-${req.query.to || 'today'}.csv"`);
    res.send(csv);
  } catch (err) {
    respondError(res, err, 'GET /merchant/account/reports/orders.csv', { message: 'Could not build the export.' });
  }
});

export default router;
