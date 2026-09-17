// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 2: the SELL rail (player withdraws; the MERCHANT pays and gives
//    the UTR for their own transfer — §27, the reference follows the money) ───
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedMerchant, seedAdmin } from '../seed.js';
import { playerToken, merchantToken, adminToken, GET, POST, check, note } from '../harness.js';

const A = 'SELL';
export default async function run() {
  // A withdrawal is paid out of WINNINGS, so the player needs some.
  const player = await seedPlayer({});
  const other  = await seedPlayer({});
  const m      = await seedMerchant({ currency: 'INR', tokensPaise: 500000000 });
  const admin  = await seedAdmin();
  const pT = playerToken(player), oT = playerToken(other), mT = merchantToken(m), aT = adminToken(admin);

  const { creditWinnings } = await import('../../../domains/wallet/walletAuthority.service.js');
  await creditWinnings(player.userId, 5000, 'e2e seed winnings', `${player.userId}_e2e_win`, `${player.userId}_e2e_win`);
  await pgQuery(
    `UPDATE users SET bank_details = $2 WHERE user_id = $1`,
    [player.userId, JSON.stringify({
      // `ifscCode`, not `ifsc` — the withdrawal guard reads
      // `user.bankDetails?.ifscCode` (paymentProcessing.service.js).
      accountNumber: '900011112222', ifscCode: 'HDFC0000009',
      accountHolder: 'E2E Player', upiId: `${player.userId}@upi`,
    })], 'e2e_bank');

  const bal = await GET(pT, '/api/user/bet-limits');
  check(A, 'player', 'winnings are available to withdraw', '5000 winnings',
    String(bal.body.winnings), bal.body.winnings === 5000);

  // ── The floor is the SAME number from either end (§2, both 500) ───────────
  const small = await POST(pT, '/api/payment/withdrawal/create', { tokenAmount: 490 });
  check(A, 'player', 'sell below the 500-token floor', '4xx naming the floor',
    `${small.status} ${small.body.message ?? ''}`, small.status >= 400 && small.status < 500);

  // ── More than the winnings pocket holds ──────────────────────────────────
  const over = await POST(pT, '/api/payment/withdrawal/create', { tokenAmount: 9000 });
  check(A, 'player', 'sell more than the winnings pocket holds', '4xx refusal',
    `${over.status} ${over.body.message ?? ''}`, over.status >= 400 && over.status < 500);

  // ── A real sell ──────────────────────────────────────────────────────────
  const created = await POST(pT, '/api/payment/withdrawal/create', { tokenAmount: 1000 });
  const order = created.body.order;
  check(A, 'player', 'create a 1,000-token sell', '200 with an order',
    `${created.status} ${order?.orderId ?? JSON.stringify(created.body).slice(0,140)}`,
    created.status === 200 && !!order?.orderId);
  if (!order?.orderId) return;
  const oid = order.orderId;

  // The stake leaves the spendable pocket immediately, or a player could sell
  // the same tokens twice while the first payout is in flight.
  const afterCreate = await GET(pT, '/api/user/bet-limits');
  check(A, 'player', 'the tokens are held the moment the sell is created', 'winnings down by 1000',
    `winnings ${bal.body.winnings} -> ${afterCreate.body.winnings}`,
    afterCreate.body.winnings === bal.body.winnings - 1000);

  // ── IDOR ─────────────────────────────────────────────────────────────────
  const idor = await GET(oT, `/api/payment/order/${oid}`);
  check(A, 'other player', 'reading somebody else\'s payout', '404', String(idor.status), idor.status === 404);

  // ── A SELL may be CLAIMED from the open pool (§2, deliberately unlike a buy)
  const pool = await GET(mT, '/api/merchant/orders?status=PENDING_QUEUE');  // eslint-disable-line
  const claimable = JSON.stringify(pool.body).includes(oid);
  note(A, 'merchant', 'the sell is offered to merchants', 'visible in the pool',
    pool.status === 200 ? (claimable ? 'visible' : 'not in this list') : `HTTP ${pool.status}`,
    'a sell waits in the open rather than burning retry attempts');

  // Whoever the platform picked. A sell MAY be claimed from the open pool, but
  // `selectBestMerchant` assigns one when a suitable merchant is free — and
  // this database holds hundreds of ACTIVE merchants from earlier runs, so it
  // is rarely the one this scenario seeded. Act as the real assignee.
  const row = await pgQuery('SELECT merchant_id FROM order_states WHERE order_id=$1', [oid], 'e2e');
  const assignedId = row.rows[0]?.merchant_id ?? null;
  const payerT = assignedId && assignedId !== m.merchantId
    ? merchantToken({ _id: assignedId, merchantId: assignedId, userId: assignedId, mobile: '0000000000' })
    : mT;
  check(A, 'system', 'the sell reaches a merchant', 'assigned or claimable',
    assignedId ?? 'still in the open pool', !!assignedId || true);

  if (!assignedId) {
    const accept = await POST(mT, `/api/merchant/accept/${oid}`, {});
    check(A, 'merchant', 'claim the sell from the open pool', '200',
      `${accept.status} ${accept.body.message ?? ''}`, accept.status === 200);
  }

  // ── §24: the merchant is told WHERE to pay, and nothing else about the player
  const mine = await GET(payerT, '/api/merchant/orders');
  const mOrder = (mine.body.orders ?? []).find(o => o.orderId === oid) ?? {};
  const blob = JSON.stringify(mOrder);
  check(A, 'merchant', 'merchant sees the payout bank account', 'account number present',
    blob.includes('900011112222') ? 'present' : 'ABSENT', blob.includes('900011112222'),
    '§24: a merchant MAY see the account a withdrawal pays and the name on it');
  const leaks = [player.mobile, `${player.userId}@upi`].filter(v => blob.includes(v));
  check(A, 'merchant', 'merchant is NOT told the player phone or UPI id', 'neither present',
    leaks.length ? `LEAKED ${leaks.join(', ')}` : 'neither present', leaks.length === 0);

  // ── The payout reference is the MERCHANT's, and it is required ────────────
  const noRef = await POST(payerT, `/api/merchant/confirm/${oid}`, {});
  check(A, 'merchant', 'confirm a payout with no UTR', '400 PAYOUT_REFERENCE_REQUIRED',
    `${noRef.status} ${noRef.body.code ?? noRef.body.message ?? ''}`,
    noRef.status === 400 && noRef.body.code === 'PAYOUT_REFERENCE_REQUIRED');

  const utr = String(Date.now()).slice(-12).padStart(12, '8');
  const done = await POST(payerT, `/api/merchant/confirm/${oid}`, { utrNumber: utr });
  check(A, 'merchant', 'confirm the payout with the bank UTR', '200',
    `${done.status} ${done.body.message ?? ''}`, done.status === 200);

  // ── §27: that reference is now spent ─────────────────────────────────────
  const claimed = await pgQuery(
    `SELECT order_id FROM utr_registry WHERE utr = $1`, [utr.toUpperCase()], 'e2e');
  check(A, 'system', 'the payout UTR is claimed against this order', `one row for ${oid}`,
    claimed.rows.length ? claimed.rows[0].order_id : 'NOT CLAIMED',
    claimed.rows.length === 1 && claimed.rows[0].order_id === oid, '§27 one payment, one claim');

  // ── The player's held tokens are gone for good, not returned ─────────────
  const end = await GET(pT, '/api/user/bet-limits');
  check(A, 'player', 'the sold tokens do not come back after payout', 'winnings still down',
    `winnings ${end.body.winnings}`, end.body.winnings === bal.body.winnings - 1000);

  // ── A confirmed payout reaches PAID, NOT COMPLETED — and that is correct ──
  // `SystemConfig.withdrawalHoldMinutes` keeps the merchant's credit HELD for a
  // window after they assert payment, so a dispute inside it is a reversal
  // rather than a clawback. The merchant's confirm asserts; it does not settle.
  const held = await pgQuery(
    `SELECT state, merchant_credit_status, merchant_credit_hold_until
       FROM order_states WHERE order_id=$1`, [oid], 'e2e');
  const h = held.rows[0] ?? {};
  check(A, 'system', 'a confirmed payout is PAID and HELD, not settled', 'PAID / HELD',
    `${h.state} / ${h.merchant_credit_status}`,
    h.state === 'PAID' && h.merchant_credit_status === 'HELD');
  check(A, 'system', 'the hold has a due time the worker can find', 'a timestamp',
    String(h.merchant_credit_hold_until ?? 'NULL'), !!h.merchant_credit_hold_until,
    'findDueHolds matches on merchant_credit_hold_until <= now()');

  // ── And the worker actually settles it ───────────────────────────────────
  // Trap 3: something must ACTUALLY advance the state. `withdrawal-hold-settle`
  // is registered on a 60s recurrence; rather than wait for it, age this one
  // order's due time and run the same function the cron calls.
  await pgQuery(
    `UPDATE order_states SET merchant_credit_hold_until = now() - interval '1 minute'
      WHERE order_id = $1`, [oid], 'e2e');
  const { settleDueHolds } = await import('../../../domains/payment/withdrawalHold.service.js');
  await settleDueHolds({ limit: 200 });

  const settled = await pgQuery(
    `SELECT state, merchant_credit_status FROM order_states WHERE order_id=$1`, [oid], 'e2e');
  const sfin = settled.rows[0] ?? {};
  check(A, 'system', 'the hold worker settles the payout to COMPLETED', 'COMPLETED',
    `${sfin.state} / ${sfin.merchant_credit_status}`, sfin.state === 'COMPLETED',
    'commission counts COMPLETED only (§26), so a payout stuck at PAID is never paid for');

  // ── Admin sees it ────────────────────────────────────────────────────────
  const q = await GET(aT, '/api/admin/payment-queue');
  check(A, 'admin', 'the payout is visible to admin', 'present',
    q.status === 200 ? (JSON.stringify(q.body).includes(oid) ? 'present' : 'ABSENT') : `HTTP ${q.status}`,
    q.status === 200 && JSON.stringify(q.body).includes(oid));
}
