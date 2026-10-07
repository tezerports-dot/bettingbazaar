// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 2: the SELL rail (player withdraws; the MERCHANT pays and gives
//    the UTR for their own transfer — §27, the reference follows the money) ───
//
// Since Step 2c a sell is ASSIGNED to a member of a working team on its rail,
// exactly like a buy — there is no open pool to claim from — and when it
// settles the player's tokens join that team's POOL. The size names the rail
// (Step 2d, `denominations.js`), so this sell is 50,000 tokens: UPI/bank.
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedMerchant, seedTeam, seedAdmin, orderPoolTrail } from '../seed.js';
import { playerToken, merchantToken, adminToken, GET, POST, PUT, check } from '../harness.js';

const A = 'SELL';
export default async function run() {
  // A withdrawal is paid out of WINNINGS, so the player needs some.
  const player = await seedPlayer({});
  const other  = await seedPlayer({});
  const m      = await seedMerchant({ currency: 'INR' });
  const m2     = await seedMerchant({ currency: 'INR' });
  // `m` is the only member online on the rail (`exclusive`), so the sell is
  // routed to `m`; `m2` is in the same team and is NOT its assignee.
  const team   = await seedTeam({ rail: 'UPI_BANK', include: [m, m2], online: [m] });
  const admin  = await seedAdmin();
  const pT = playerToken(player), oT = playerToken(other), mT = merchantToken(m), m2T = merchantToken(m2), aT = adminToken(admin);

  const { creditWinnings } = await import('../../../domains/wallet/walletAuthority.service.js');
  await creditWinnings(player.userId, 60000, 'e2e seed winnings', `${player.userId}_e2e_win`, `${player.userId}_e2e_win`);
  // The payout account through the player's own Profile route, as production
  // saves it (§32 S16): a bank account, the four fields, no UPI handle. This
  // was a raw UPDATE carrying `accountHolder` (a key nothing reads) and a
  // `upiId` the row now refuses (`users_bank_details_bank_account_only`).
  const saved = await PUT(pT, `/api/user/${player.userId}/bank-details`, {
    accountHolderName: 'E2E Player', accountNumber: '900011112222',
    ifscCode: 'HDFC0000009', bankName: 'HDFC Bank', upiId: `${player.userId}@upi`,
  });
  const kept = (await pgQuery('SELECT bank_details FROM users WHERE user_id = $1', [player.userId], 'e2e')).rows[0]?.bank_details;
  check(A, 'player', 'saves a bank account, and not a UPI handle sent beside it', '200, the four fields only',
    `${saved.status} ${Object.keys(kept ?? {}).sort().join(',')}`,
    saved.status === 200 && Object.keys(kept ?? {}).sort().join(',') === 'accountHolderName,accountNumber,bankName,ifscCode');

  const bal = await GET(pT, '/api/user/bet-limits');
  check(A, 'player', 'winnings are available to withdraw', '60000 winnings',
    String(bal.body.winnings), bal.body.winnings === 60000);

  // ── The sizes are the SAME list from either end (§2, Step 2d) ────────────
  const small = await POST(pT, '/api/payment/withdrawal/create', { tokenAmount: 490 });
  check(A, 'player', 'sell an amount that is not an order size', '400 NOT_AN_ORDER_SIZE',
    `${small.status} ${small.body.code ?? ''} ${small.body.message ?? ''}`,
    small.status === 400 && small.body.code === 'NOT_AN_ORDER_SIZE');

  // ── More than the winnings pocket holds ──────────────────────────────────
  // 100,000 IS a size, so the refusal can only be the pocket's.
  const over = await POST(pT, '/api/payment/withdrawal/create', { tokenAmount: 100000 });
  check(A, 'player', 'sell more than the winnings pocket holds', '4xx refusal',
    `${over.status} ${over.body.message ?? ''}`, over.status >= 400 && over.status < 500);

  // ── A real sell ──────────────────────────────────────────────────────────
  const created = await POST(pT, '/api/payment/withdrawal/create', { tokenAmount: 50000 });
  const order = created.body.order;
  check(A, 'player', 'create a 50,000-token sell', '200 with an order',
    `${created.status} ${order?.orderId ?? JSON.stringify(created.body).slice(0,140)}`,
    created.status === 200 && !!order?.orderId);
  if (!order?.orderId) return;
  const oid = order.orderId;

  // The stake leaves the spendable pocket immediately, or a player could sell
  // the same tokens twice while the first payout is in flight.
  const afterCreate = await GET(pT, '/api/user/bet-limits');
  check(A, 'player', 'the tokens are held the moment the sell is created', 'winnings down by 50000',
    `winnings ${bal.body.winnings} -> ${afterCreate.body.winnings}`,
    afterCreate.body.winnings === bal.body.winnings - 50000);

  // ── IDOR ─────────────────────────────────────────────────────────────────
  const idor = await GET(oT, `/api/payment/order/${oid}`);
  check(A, 'other player', 'reading somebody else\'s payout', '404', String(idor.status), idor.status === 404);

  // ── A sell is ASSIGNED to a team member, never claimed from an open pool ──
  const row = await pgQuery('SELECT merchant_id, team_id, state FROM order_states WHERE order_id=$1', [oid], 'e2e');
  const r0 = row.rows[0] ?? {};
  check(A, 'system', 'the sell is ASSIGNED to the online team member', `ASSIGNED to ${m.merchantId} in ${team.teamId}`,
    `${r0.state} to ${r0.merchant_id ?? 'nobody'} in ${r0.team_id ?? 'no team'}`,
    r0.state === 'ASSIGNED' && r0.merchant_id === m.merchantId && r0.team_id === team.teamId);
  if (r0.merchant_id !== m.merchantId) return;
  const payerT = mT;

  // The only order a member may accept is one already theirs (§2c).
  const stranger = await POST(m2T, `/api/merchant/accept/${oid}`, {});
  check(A, 'merchant', 'a teammate who is not the assignee cannot take the sell', '403',
    `${stranger.status} ${stranger.body.message ?? ''}`, stranger.status === 403);
  const accept = await POST(mT, `/api/merchant/accept/${oid}`, {});
  check(A, 'merchant', 'the assignee accepts the sell', '200',
    `${accept.status} ${accept.body.message ?? ''}`, accept.status === 200);

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
    `winnings ${end.body.winnings}`, end.body.winnings === bal.body.winnings - 50000);

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

  // ── Settling puts the player's tokens into the serving team's pool ────────
  // `creditSellToPool`: one SELL_SETTLED entry for this order (available +a)
  // and the treasury movement named after it, USER_FLOAT → TEAM_FLOAT. Read by
  // the order's id, never by diffing the pool or the floats (trap 10).
  const trail = await orderPoolTrail(oid);
  const sold = trail.entries.filter(e => e.kind === 'SELL_SETTLED');
  check(A, 'system', 'the settled sell credits the team pool', `one SELL_SETTLED +5000000 in ${team.teamId}`,
    sold.map(e => `${e.kind} avail ${e.available}, held ${e.held}, team ${e.teamId}`).join('; ') || 'NO POOL ENTRY',
    sold.length === 1 && sold[0].teamId === team.teamId && sold[0].available === 5000000 && sold[0].held === 0);
  const legs = trail.legs[`team_sell_${oid}`] ?? {};
  check(A, 'system', 'the treasury moves the tokens from the players to the team float', 'USER_FLOAT -5000000, TEAM_FLOAT +5000000',
    JSON.stringify(legs), legs.USER_FLOAT === -5000000 && legs.TEAM_FLOAT === 5000000 && Object.keys(legs).length === 2);

  // ── Admin sees it ────────────────────────────────────────────────────────
  const q = await GET(aT, '/api/admin/payment-queue');
  check(A, 'admin', 'the payout is visible to admin', 'present',
    q.status === 200 ? (JSON.stringify(q.body).includes(oid) ? 'present' : 'ABSENT') : `HTTP ${q.status}`,
    q.status === 200 && JSON.stringify(q.body).includes(oid));
}
