// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * usdtDeposit.routes.js — the USDT rail's HTTP surface.
 *
 * Three routes: a player opens an invoice, a player watches it, and BTCPay says
 * what happened to it. The third has no `authenticate` on it and mints tokens,
 * which is why its signature check is the first thing in the handler and why
 * that check lives in a module of its own.
 *
 * ── Mounted under /api/payment, not /api/funding ───────────────────────────
 * A player's screen already talks to `/api/payment` for the INR rail, and which
 * rail serves an amount is the SERVER's decision. Two prefixes would make the
 * client's URL a statement about which rail it expects, and this codebase has
 * already paid for a panel that decided a money rule.
 */
import express from 'express';
import { authenticate, requireLinkedKyc } from '../identity/auth.middleware.js';
import { requireChannelMembership } from '../../middleware/requireChannelMembership.js';
import { usdtDepositLimiter } from '../../middleware/security.js';
import { db } from '#db';
import { verifyBtcpaySignature } from './btcpaySignature.js';
import { btcpay as btcpayConfig, btcpayConfigured } from '../../config/btcpay.config.js';
import {
  createUsdtDeposit, settleUsdtDeposit, closeUsdtDeposit,
  markUsdtDepositProcessing, toPlayerDepositView, MIN_USDT_BUY_PAISE,
} from './usdtDeposit.service.js';

const router = express.Router();

/**
 * POST /api/payment/usdt/deposit/create — buy above the INR ceiling.
 *
 * `requireLinkedKyc` and not `requireApprovedKyc`, matching the INR deposit
 * exactly: money IN needs linked identity, and holding a player at the door
 * while verification runs in batches loses the player without protecting
 * anyone. The stricter rule belongs on withdrawal, where the money leaves.
 */
router.post('/usdt/deposit/create',
  authenticate,
  requireLinkedKyc,
  requireChannelMembership({ action: 'add funds' }),
  usdtDepositLimiter,
  async (req, res) => {
    try {
      const result = await createUsdtDeposit(req.user.userId, Number(req.body.tokenAmount));
      res.json({ success: true, message: 'Pay the invoice to receive your tokens.', ...result });
    } catch (err) {
      res.status(err.status || 500).json({ success: false, message: err.message, code: err.code });
    }
  });

/**
 * GET /api/payment/usdt/deposit/:depositId — the player's own invoice.
 *
 * Ownership is checked HERE and not assumed from the id. A deposit id is not a
 * capability: it appears in logs and in a checkout URL, and answering anyone
 * who names one would leak what a player bought and for how much.
 */
router.get('/usdt/deposit/:depositId', authenticate, async (req, res) => {
  try {
    const deposit = await db.usdtDeposits.getDeposit(req.params.depositId);
    if (!deposit || String(deposit.userId) !== String(req.user.userId)) {
      return res.status(404).json({ success: false, message: 'Deposit not found' });
    }
    res.json({ success: true, deposit: toPlayerDepositView(deposit) });
  } catch (err) {
    console.error('GET /payment/usdt/deposit/:depositId error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch the deposit' });
  }
});

/** GET /api/payment/usdt/deposits — this player's USDT history. */
router.get('/usdt/deposits', authenticate, async (req, res) => {
  try {
    const deposits = await db.usdtDeposits.listForUser(req.user.userId, { limit: req.query.limit });
    res.json({ success: true, deposits: deposits.map(toPlayerDepositView) });
  } catch (err) {
    console.error('GET /payment/usdt/deposits error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch deposits' });
  }
});

/**
 * GET /api/payment/usdt/availability — is this rail open, and from what amount.
 *
 * The panel needs to know whether to offer USDT at all, and the floor it starts
 * at. Both are the SERVER's answers: the floor is derived from the INR ceiling
 * and the availability is whether BTCPay is configured. A panel that hard-coded
 * either would be a second owner of a money rule.
 */
router.get('/usdt/availability', authenticate, (req, res) => {
  res.json({
    success: true,
    available: btcpayConfigured(btcpayConfig),
    minTokenAmount: MIN_USDT_BUY_PAISE / 100,
  });
});

/**
 * POST /api/payment/usdt/webhook — BTCPay's callback.
 *
 * ── What stands between the internet and a mint ────────────────────────────
 * This route has no `authenticate`, because the caller is a server and not a
 * session. The HMAC over the RAW BYTES is the whole of the authentication, and
 * everything after it treats the body as a NAME (which invoice) and never as an
 * AMOUNT (how many tokens) — the amount is read from the row.
 *
 * `express.raw` is mounted for this path in server.js, so `req.body` here is a
 * Buffer. Parsing it before verifying would digest a re-serialisation of the
 * bytes rather than the bytes themselves, which is the known limitation the
 * casino verifier still carries and is not repeated here.
 *
 * ── Answering 200 to a delivery that changed nothing ───────────────────────
 * BTCPay retries anything that is not 2xx. A redelivery of a settle we already
 * processed changed nothing and must be answered 200, or BTCPay retries it
 * forever. A body we cannot verify is 401 and a rail that is not configured is
 * 503 — those SHOULD be retried, because both are our side being wrong.
 */
router.post('/usdt/webhook', async (req, res) => {
  const check = verifyBtcpaySignature(btcpayConfig.webhookSecret, req.headers, req.body);
  if (!check.ok) {
    return res.status(check.status).json({ success: false, message: check.message });
  }

  let event;
  try {
    event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
  } catch {
    return res.status(400).json({ success: false, message: 'Malformed body' });
  }

  const invoiceId = String(event?.invoiceId || '');
  const deliveryId = event?.deliveryId ? String(event.deliveryId) : null;
  const type = String(event?.type || '');
  if (!invoiceId) {
    return res.status(400).json({ success: false, message: 'No invoice in the event' });
  }

  try {
    let outcome;
    switch (type) {
      // The one event that moves money. BTCPay sends this when the invoice is
      // paid AND settled — not when a payment is merely seen.
      case 'InvoiceSettled':
        outcome = await settleUsdtDeposit({ invoiceId, deliveryId });
        break;
      // Seen on chain, not confirmed. Moves no money; it exists so the player's
      // screen can tell "we can see it" from "nothing has arrived".
      case 'InvoiceProcessing':
      case 'InvoiceReceivedPayment':
        outcome = await markUsdtDepositProcessing({ invoiceId, deliveryId });
        break;
      case 'InvoiceExpired':
        outcome = await closeUsdtDeposit({ invoiceId, state: 'EXPIRED', deliveryId });
        break;
      case 'InvoiceInvalid':
        outcome = await closeUsdtDeposit({
          invoiceId, state: 'INVALID', deliveryId, reason: 'BTCPay marked the invoice invalid',
        });
        break;
      // An event type this platform does not act on — BTCPay sends several.
      // Acknowledged, so it is not retried, and NOT treated as an error.
      default:
        return res.json({ success: true, ignored: type || 'unknown' });
    }

    // An invoice nothing here created. Answered 200 on purpose: it is not our
    // invoice, retrying will not make it ours, and a 4xx would have BTCPay
    // redeliver something we will refuse identically every time.
    if (!outcome.ok && outcome.reason === 'unknown_invoice') {
      return res.json({ success: true, ignored: 'unknown_invoice' });
    }
    // A mint the supply cap refused. The player HAS paid, so this is money owed
    // and must be retried — a 500 is what makes BTCPay come back.
    if (!outcome.ok) {
      console.error(`[usdt] webhook ${type} for ${invoiceId} did not complete: ${outcome.reason}`);
      return res.status(500).json({ success: false, message: 'Not processed' });
    }
    return res.json({ success: true });
  } catch (err) {
    // Loud, and a 5xx so BTCPay retries. Swallowing this would mean a player
    // who paid and is never credited, with nothing in the log to find.
    console.error(`[usdt] webhook ${type} for ${invoiceId} threw:`, err);
    return res.status(500).json({ success: false, message: 'Not processed' });
  }
});

export default router;
