// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * usdtDeposit.admin.routes.js — Admin › USDT Deposits (owner, 2026-10-18: USDT
 * buys paid to the platform on BNB Smart Chain, one address per order).
 *
 * What an admin does here, and nothing more:
 *   - see every deposit address, what arrived at it and what became of it,
 *     narrowed by `DEPOSIT_FILTERS`, with the watcher's health and totals;
 *   - mark money the server could not credit (late, overpaid, after credit) as
 *     dealt with, with a note saying how;
 *   - download what the offline sweep tool moves out, and record its sweep
 *     transactions back, one at a time or as the tool's results file.
 *
 * Nothing here credits a player: the watcher does that, and a late payment is
 * settled by an admin elsewhere (a balance adjustment or a refund on chain),
 * then marked handled here. All of it asks `canManageUsdtDeposits`.
 */
import { express, authenticate, hasPermission } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { respondError, refusal } from '../../shared/httpError.js';
import { toCsv } from '../reporting/csv.util.js';
import { watcherStatus } from './usdtDeposit.service.js';

const router = express.Router();
const AREA = hasPermission('canManageUsdtDeposits');

/** The most results lines one upload may record. */
export const SWEEP_UPLOAD_MAX = 1000;

// ─── GET /api/admin/usdt-deposits ────────────────────────────────────────────
router.get('/usdt-deposits', authenticate, AREA, async (req, res) => {
  try {
    const filter = String(req.query.filter ?? 'ALL').toUpperCase();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const page = Math.max(1, Number(req.query.page) || 1);
    const [list, totals, watcher] = await Promise.all([
      db.usdtDeposits.listDeposits({ filter, limit, offset: (page - 1) * limit }),
      db.usdtDeposits.depositTotals(),
      watcherStatus(),
    ]);
    res.json({
      success: true,
      filters: db.usdtDeposits.DEPOSIT_FILTERS, filter,
      total: list.total, page, pages: Math.max(1, Math.ceil(list.total / limit)),
      deposits: list.rows, totals, watcher,
    });
  } catch (error) {
    respondError(res, error, 'GET /admin/usdt-deposits', { message: 'Could not load the USDT deposits.' });
  }
});

// ─── GET /api/admin/usdt-deposits/sweep.csv ──────────────────────────────────
// The sweep tool's input. The derivation index is what lets the tool, holding
// the mnemonic offline, derive the key; it checks every address against it.
router.get('/usdt-deposits/sweep.csv', authenticate, AREA, async (req, res) => {
  try {
    const rows = await db.usdtDeposits.sweepCandidates();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="usdt-sweep.csv"');
    res.send(toCsv(rows.map((r) => ({
      orderId: r.orderId, address: r.address, keyId: r.keyId,
      derivationIndex: r.derivationIndex, usdtReceived: r.usdtReceived, state: r.state,
    }))));
  } catch (error) {
    respondError(res, error, 'GET /admin/usdt-deposits/sweep.csv', { message: 'Could not build the sweep file.' });
  }
});

// ─── GET /api/admin/usdt-deposits/:orderId/transfers ─────────────────────────
router.get('/usdt-deposits/:orderId/transfers', authenticate, AREA, async (req, res) => {
  try {
    res.json({ success: true, orderId: req.params.orderId, transfers: await db.usdtDeposits.transfersFor(req.params.orderId) });
  } catch (error) {
    respondError(res, error, 'GET /admin/usdt-deposits/:orderId/transfers', { message: 'Could not load the transfers.' });
  }
});

// ─── POST /api/admin/usdt-deposits/:orderId/handled ──────────────────────────
router.post('/usdt-deposits/:orderId/handled', authenticate, AREA, async (req, res) => {
  try {
    const { marked } = await db.usdtDeposits.markHandled(req.params.orderId, { actor: `admin:${req.userId}`, note: req.body?.note });
    if (marked === 0) {
      throw refusal(409, 'NOTHING_TO_MARK',
        'Nothing to mark on this order: it is still open, or every transfer on it is already marked handled.');
    }
    res.json({ success: true, marked });
  } catch (error) {
    respondError(res, error, 'POST /admin/usdt-deposits/:orderId/handled', { message: 'Could not mark it handled.' });
  }
});

// ─── POST /api/admin/usdt-deposits/:orderId/sweep ────────────────────────────
router.post('/usdt-deposits/:orderId/sweep', authenticate, AREA, async (req, res) => {
  try {
    const { ok } = await db.usdtDeposits.recordSweep(req.params.orderId, { actor: `admin:${req.userId}`, txHash: req.body?.txHash });
    if (!ok) {
      throw refusal(409, 'SWEEP_NOT_RECORDED',
        'Not recorded: the order is still open, nothing arrived at its address, or a sweep is already recorded for it.');
    }
    res.json({ success: true });
  } catch (error) {
    respondError(res, error, 'POST /admin/usdt-deposits/:orderId/sweep', { message: 'Could not record the sweep.' });
  }
});

// ─── POST /api/admin/usdt-deposits/sweeps ────────────────────────────────────
// The sweep tool's results file (`orderId,txHash` per line, a header allowed),
// recorded line by line. Each line is answered on its own: one already
// recorded does not stop the rest.
router.post('/usdt-deposits/sweeps', authenticate, AREA, async (req, res) => {
  try {
    const text = String(req.body?.results ?? '');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .filter((l) => !/^order_?id\s*,/i.test(l));
    if (lines.length === 0) throw refusal(400, 'NO_RESULTS', 'Paste the results file the sweep tool wrote: one line per address, orderId,txHash.');
    if (lines.length > SWEEP_UPLOAD_MAX) throw refusal(400, 'TOO_MANY_RESULTS', `At most ${SWEEP_UPLOAD_MAX} lines at a time.`);
    const results = [];
    for (const line of lines) {
      const [orderId, txHash] = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      try {
        const { ok } = await db.usdtDeposits.recordSweep(orderId, { actor: `admin:${req.userId}`, txHash });
        results.push({ orderId, recorded: ok, reason: ok ? null : 'open, empty or already recorded' });
      } catch (e) {
        if (!e?.status) throw e;
        results.push({ orderId, recorded: false, reason: e.message });
      }
    }
    res.json({ success: true, recorded: results.filter((r) => r.recorded).length, results });
  } catch (error) {
    respondError(res, error, 'POST /admin/usdt-deposits/sweeps', { message: 'Could not record the sweeps.' });
  }
});

export default router;
