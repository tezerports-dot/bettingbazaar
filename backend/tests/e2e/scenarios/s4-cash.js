// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 4: the CASH_ATM rail, and the RAIL SWITCH across three panels ──
// The switch is a cross-panel event in its own right: an admin publishes a new
// `payment_mode_policies` version and all three panels must read the same rail
// from the same owner (§2). The rail is restored at the end — this runs against
// a shared config document (trap 10).
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedMerchant, seedAdmin } from '../seed.js';
import { playerToken, merchantToken, adminToken, GET, POST, check, note } from '../harness.js';

const A = 'CASH';
export default async function run() {
  const admin = await seedAdmin(); const aT = adminToken(admin);

  const before = await GET(aT, '/api/admin/payment-mode');
  const startMode = before.body?.policy?.activeMode ?? null;
  check(A, 'admin', 'read the rail in force before touching it', 'a mode',
    String(startMode), !!startMode, 'restored at the end of this scenario');
  if (!startMode) return;

  try {
    // ══ Switch to the cash rail ═══════════════════════════════════════════
    const sw = await POST(aT, '/api/admin/payment-mode', {
      activeMode: 'CASH_ATM',
      justification: 'e2e: drive the cash rail end to end, restored immediately after',
    });
    check(A, 'admin', 'publish a CASH_ATM policy version', '200',
      `${sw.status} ${sw.body.message ?? ''}`, sw.status === 200);

    // ── All three panels read the SAME rail from the SAME owner ───────────
    const p = await seedPlayer({});
    const m = await seedMerchant({ currency: 'INR', tokensPaise: 500000000 });
    const pT = playerToken(p), mT = merchantToken(m);

    const sys = await GET(pT, '/api/v1/system/config');
    const playerMode = sys.body?.config?.paymentMode ?? null;
    check(A, 'player', 'the player panel now reads CASH_ATM', 'CASH_ATM',
      String(playerMode), playerMode === 'CASH_ATM',
      'the buy screen branches on this — a stale value offers the wrong flow');

    const mm = await GET(mT, '/api/merchant/payment-mode');
    check(A, 'merchant', 'the merchant panel now reads CASH_ATM', 'CASH_ATM',
      `${mm.status} ${mm.body?.activeMode}`, mm.body?.activeMode === 'CASH_ATM');

    const am = await GET(aT, '/api/admin/payment-mode');
    check(A, 'admin', 'the admin panel agrees', 'CASH_ATM',
      String(am.body?.policy?.activeMode), am.body?.policy?.activeMode === 'CASH_ATM',
      '§2: one ACTIVE version, append-only — not a feature flag that dies with the process');

    // ── The ATM's ceiling bounds a CASH buy, and ONLY a cash buy (§25) ─────
    const big = await POST(pT, '/api/payment/deposit/create', { tokenAmount: 20000 });
    check(A, 'player', 'a cash buy above the ATM ceiling is refused', '4xx',
      `${big.status} ${big.body.message ?? ''}`, big.status >= 400 && big.status < 500,
      '§25: ₹10,000 is the largest a cash machine dispenses in one go — it bounds CASH_ATM, not UPI');

    // ── A merchant supplies a cash link ───────────────────────────────────
    const supply = await POST(mT, '/api/merchant/cash-links', {
      denomination: 500, amount: 5000,
      link: 'https://example.test/atm/e2e', expiresInSeconds: 600,
    });
    note(A, 'merchant', 'supply a cash link', '200 or a named refusal',
      `${supply.status} ${supply.body.message ?? JSON.stringify(supply.body).slice(0,110)}`,
      'the supply side of the cash rail; the claim is a queue, not a contest (§2)');

    // ── The rail is stamped IMMUTABLY on any order created now ────────────
    const ord = await POST(pT, '/api/payment/deposit/create', { tokenAmount: 1000 });
    const oid = ord.body?.order?.orderId;
    if (oid) {
      const row = await pgQuery(
        'SELECT payment_mode FROM order_states WHERE order_id=$1', [oid], 'e2e');
      check(A, 'system', 'the order carries the rail it was created under', 'CASH_ATM',
        row.rows[0]?.payment_mode ?? 'missing', row.rows[0]?.payment_mode === 'CASH_ATM');

      let immutable = false;
      try {
        await pgQuery(
          `UPDATE order_states SET payment_mode='P2P_UPI' WHERE order_id=$1`, [oid], 'e2e');
      } catch { immutable = true; }
      check(A, 'system', 'an order\'s rail cannot be changed afterwards', 'the trigger refuses it',
        immutable ? 'refused' : 'CHANGED', immutable,
        '§2: every worker and screen branches on the ORDER\'s own value, never the current policy');
    } else {
      note(A, 'player', 'create a cash buy', 'an order',
        `${ord.status} ${ord.body.message ?? ''}`, 'could not stage the immutability check');
    }
  } finally {
    // ══ Put the rail back (trap 10) ═══════════════════════════════════════
    // `payment_mode_policies` is the platform's live rule, not a fixture. A
    // scenario that switched the rail and stopped there would leave every
    // later run — and the browser session — on a rail nobody chose.
    const restore = await POST(aT, '/api/admin/payment-mode', {
      activeMode: startMode,
      justification: 'e2e: restoring the rail this scenario switched away from',
    });
    const back = await GET(aT, '/api/admin/payment-mode');
    check(A, 'admin', 'the rail is put back where it started', startMode,
      `${restore.status} -> ${back.body?.policy?.activeMode}`,
      back.body?.policy?.activeMode === startMode,
      'trap 10: a suite that writes config leaves the platform running under different rules');
  }
}
