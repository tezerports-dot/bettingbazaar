// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * usdtDeposit.admin.routes.js — the USDT rail, from the operator's side.
 *
 * ── Why a rail needs an operator surface at all ────────────────────────────
 * "A backend feature with no UI is not shipped." The USDT rail has one failure
 * that nothing automatic can fix, and it is the worst kind: a player HAS PAID
 * and is not credited. It happens when the mint is refused by the supply cap,
 * or when the process dies between the settle and the wallet write. Both leave
 * a deposit SETTLED with `credited_at` null — a state that exists precisely so
 * a person can find it.
 *
 * Without this screen that row is invisible until the player complains, which
 * is the same shape as the five dead admin buttons: no error, no red test, no
 * stack trace, just somebody's money sitting still.
 *
 * ── And the callback that never arrived ────────────────────────────────────
 * `GET /usdt-deposits/:depositId/invoice` asks BTCPay what IT thinks. That is
 * the authority on whether a player paid, and it is the only way to tell a
 * dropped webhook from a player who simply never sent anything. It READS; it
 * does not credit. Crediting from an admin click would be a second money path
 * beside the webhook, and the two would disagree — this repository has paid for
 * that exact mistake in `moveDepositMoney`.
 */
import { express, authenticate, hasPermission } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { USDT_DEPOSIT_STATES } from '#db/repositories/usdtDeposits.js';
import { getInvoice } from './btcpay.client.js';

const router = express.Router();

/**
 * GET /api/admin/usdt-deposits — every USDT deposit, newest first.
 *
 * `state` filters, and an unknown one is REFUSED rather than silently ignored.
 * A filter that quietly does nothing shows the operator the whole list while
 * they believe they are looking at one state.
 */
router.get('/usdt-deposits', authenticate, hasPermission('canViewTransactions'), async (req, res) => {
  try {
    const state = req.query.state ? String(req.query.state).toUpperCase() : null;
    if (state && !USDT_DEPOSIT_STATES.includes(state)) {
      return res.status(400).json({
        success: false,
        message: `Unknown state '${state}'. One of: ${USDT_DEPOSIT_STATES.join(', ')}`,
      });
    }
    const deposits = await db.usdtDeposits.listAll({ state, limit: req.query.limit });
    res.json({ success: true, deposits });
  } catch (err) {
    console.error('GET /admin/usdt-deposits error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch USDT deposits' });
  }
});

/**
 * GET /api/admin/usdt-deposits/uncredited — paid, and not credited.
 *
 * The queue that must be empty. Every row here is a player who sent USDT and
 * whose wallet has not moved.
 */
router.get('/usdt-deposits/uncredited', authenticate, hasPermission('canViewTransactions'), async (req, res) => {
  try {
    const deposits = await db.usdtDeposits.findUncredited({ limit: req.query.limit });
    res.json({ success: true, deposits, count: deposits.length });
  } catch (err) {
    console.error('GET /admin/usdt-deposits/uncredited error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch uncredited deposits' });
  }
});

/**
 * GET /api/admin/usdt-deposits/:depositId/invoice — what BTCPay says.
 *
 * A READ. It reconciles our row against the payment processor's own record and
 * reports whether they agree; it moves no money, because the webhook is the one
 * path that credits and a second one would eventually disagree with it.
 */
router.get('/usdt-deposits/:depositId/invoice', authenticate, hasPermission('canViewTransactions'), async (req, res) => {
  try {
    const deposit = await db.usdtDeposits.getDeposit(req.params.depositId);
    if (!deposit) return res.status(404).json({ success: false, message: 'Deposit not found' });
    if (!deposit.invoiceId) {
      // A deposit whose invoice was never created. There is nothing at BTCPay
      // to ask about, and saying so is different from saying "not paid".
      return res.json({ success: true, deposit, invoice: null, agrees: null });
    }

    const invoice = await getInvoice(deposit.invoiceId);
    // BTCPay's `Settled` against our SETTLED. A disagreement is the whole point
    // of the screen: it is a dropped webhook, and it names the deposit to fix.
    const btcpaySettled = String(invoice?.status || '').toLowerCase() === 'settled';
    res.json({
      success: true,
      deposit,
      invoice,
      agrees: invoice === null ? null : btcpaySettled === (deposit.state === 'SETTLED'),
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message, code: err.code });
  }
});

export default router;
