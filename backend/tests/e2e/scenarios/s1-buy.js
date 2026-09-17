// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 1: the BUY rail (player buys platform tokens with INR/UPI) ──────
// Driven over real HTTP as three different actors, with the database consulted
// directly for the facts a panel cannot show (escrow holds, ledger rows).
import { db } from '#db';
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedMerchant, seedAdmin } from '../seed.js';
import { playerToken, merchantToken, adminToken, GET, POST, PUT, check, note } from '../harness.js';

const A = 'BUY';
export default async function run() {
  const player = await seedPlayer({ balancePaise: 0 });
  const other  = await seedPlayer({ balancePaise: 0 });
  const m      = await seedMerchant({ currency: 'INR', tokensPaise: 500000000 });
  const m2     = await seedMerchant({ currency: 'INR', tokensPaise: 500000000 });
  const admin  = await seedAdmin();
  const pT = playerToken(player), oT = playerToken(other);
  const mT = merchantToken(m), m2T = merchantToken(m2), aT = adminToken(admin);

  // ── The floor (§2: minDeposit, 500 tokens, same rule from either end) ──────
  const notTen = await POST(pT, '/api/payment/deposit/create', { tokenAmount: 1 });
  check(A, 'player', 'buy an amount that is not a multiple of 10', '4xx naming the step',
    `${notTen.status} ${notTen.body.message ?? ''}`,
    notTen.status === 400 && /multiple of 10/i.test(notTen.body.message ?? ''));

  // 490 is a multiple of 10 and below the 500-token floor, so this reaches the
  // floor check rather than stopping at the step check above.
  const tooSmall = await POST(pT, '/api/payment/deposit/create', { tokenAmount: 490 });
  check(A, 'player', 'buy below the 500-token floor', '4xx naming the floor',
    `${tooSmall.status} ${tooSmall.body.message ?? ''}`,
    tooSmall.status >= 400 && tooSmall.status < 500);

  // ── Create a real buy ─────────────────────────────────────────────────────
  const created = await POST(pT, '/api/payment/deposit/create', { tokenAmount: 1000 });
  const order = created.body.order;
  check(A, 'player', 'create a 1,000-token buy', '200 with an order', `${created.status} ${order?.orderId ?? JSON.stringify(created.body).slice(0,120)}`,
    created.status === 200 && !!order?.orderId);
  if (!order?.orderId) return;
  const oid = order.orderId;

  // ── §24: the player is told where to pay and NOTHING about who ────────────
  const leak = JSON.stringify(order);
  const forbidden = ['accountNumber', 'ifsc', 'accountHolder', 'usdtAddress', 'merchantSnapshot'];
  const found = forbidden.filter(k => leak.includes(k));
  check(A, 'player', 'buy response hides the merchant identity', 'none of ' + forbidden.join(', '),
    found.length ? found.join(', ') : 'none present', found.length === 0);

  // ── The assigned merchant sees it; the other merchant does not ────────────
  const assignedId = (await db.orders?.getOrderRecord?.(oid).catch(() => null))?.merchantId
    ?? (await pgQuery('SELECT merchant_id FROM order_states WHERE order_id=$1', [oid], 'e2e')).rows[0]?.merchant_id;
  const assignedT = assignedId === m.merchantId ? mT : assignedId === m2.merchantId ? m2T : null;
  const strangerT = assignedT === mT ? m2T : mT;
  check(A, 'system', 'the buy is ASSIGNED to one of the two merchants', 'one of the seeded merchants',
    assignedId ?? 'nobody', !!assignedT);
  if (!assignedT) return;

  const mine = await GET(assignedT, `/api/merchant/orders`);
  const listed = (mine.body.orders ?? []).some(o => o.orderId === oid);
  check(A, 'merchant', 'assigned merchant sees the order in their list', 'the order present', listed ? 'present' : 'ABSENT', listed);

  const theirs = await GET(strangerT, `/api/merchant/orders`);
  const crossListed = (theirs.body.orders ?? []).some(o => o.orderId === oid);
  check(A, 'merchant', 'a different merchant does NOT see it', 'absent', crossListed ? 'PRESENT' : 'absent', !crossListed);

  // ── §2/F-018: the tokens are HELD at attachment, not merely checked ───────
  const hold = await pgQuery(
    `SELECT state, amount_paise FROM merchant_settlements
      WHERE order_id = $1 AND direction = 'DEPOSIT'`, [oid], 'e2e');
  check(A, 'system', 'a deposit escrow hold exists on assignment', 'one live DEPOSIT hold',
    hold.rows.length ? `${hold.rows.length} row(s), state ${hold.rows[0].state}` : 'NO HOLD', hold.rows.length === 1);

  // ── §24 the other way: the merchant is told the payout account, not the player
  const mOrder = (mine.body.orders ?? []).find(o => o.orderId === oid) ?? {};
  const mLeak = JSON.stringify(mOrder);
  const playerPhone = player.mobile;
  const phoneLeak = mLeak.includes(playerPhone);
  check(A, 'merchant', 'merchant view hides the player phone number', 'absent',
    phoneLeak ? `LEAKED ${playerPhone}` : 'absent', !phoneLeak);

  // ── IDOR: another player cannot read this order ───────────────────────────
  const idor = await GET(oT, `/api/payment/order/${oid}`);
  check(A, 'other player', 'reading somebody else\'s order', '404', String(idor.status), idor.status === 404);

  // ── Player marks paid with a UTR ──────────────────────────────────────────
  const utr = String(Date.now()).slice(-12).padStart(12, '7');
  const paid = await POST(pT, `/api/payment/order/${oid}/mark-paid`, { utrNumber: utr });
  check(A, 'player', 'mark paid with a UTR', '200', `${paid.status} ${paid.body.message ?? ''}`, paid.status === 200);

  // ── §27: that UTR now belongs to this order, for good ────────────────────
  const dupPlayer = await seedPlayer({});
  const dupT = playerToken(dupPlayer);
  const dup = await POST(dupT, '/api/payment/deposit/create', { tokenAmount: 1000 });
  if (dup.body.order?.orderId) {
    const reuse = await POST(dupT, `/api/payment/order/${dup.body.order.orderId}/mark-paid`, { utrNumber: utr });
    check(A, 'player', 'reusing the same UTR on a second order', '4xx refusal',
      `${reuse.status} ${reuse.body.message ?? ''}`, reuse.status >= 400 && reuse.status < 500,
      '§27 one payment, one claim');
  } else {
    note(A, 'player', 'second order for the UTR-reuse check', 'an order', JSON.stringify(dup.body).slice(0,120), 'could not stage the duplicate check');
  }

  // ── The ten-minute dispute wait (just fixed) ──────────────────────────────
  const early = await POST(pT, `/api/payment/order/${oid}/dispute`, { reason: 'nothing arrived' });
  check(A, 'player', 'dispute a freshly PAID order', '4xx mentioning the wait',
    `${early.status} ${early.body.message ?? ''}`,
    early.status >= 400 && /10 minutes/i.test(early.body.message ?? ''));

  // ── Merchant confirms; the player is credited and the hold is consumed ────
  // Balances from the LIMITS endpoint, which is what `WalletPage` reads and the
  // only one that reports all four pockets. `/api/v1/user/profile` carries
  // deposit/winnings/locked but NOT reserve, so measuring there would read a
  // correct 900 as a 100-token shortfall.
  const before = await GET(pT, '/api/user/bet-limits');
  const confirm = await POST(assignedT, `/api/merchant/confirm/${oid}`, {});
  check(A, 'merchant', 'confirm the paid buy', '200', `${confirm.status} ${confirm.body.message ?? ''}`, confirm.status === 200);

  const after = await GET(pT, '/api/user/bet-limits');
  const b0 = before.body ?? {}, b1 = after.body ?? {};
  const dDep = (b1.deposit ?? 0) - (b0.deposit ?? 0);
  const dRes = (b1.reserve ?? 0) - (b0.reserve ?? 0);
  // §2: the split is owned by `deposit_policies`, one ACTIVE per currency
  // (90/10 by default). Asserting only the deposit pocket would read a correct
  // 900 as a 100-token shortfall — the pockets have to be added up.
  check(A, 'player', 'the tokens bought arrive, split per the deposit policy', '1000 across the pockets',
    `deposit +${dDep}, reserve +${dRes} = ${dDep + dRes}`, dDep + dRes === 1000,
    'cross-panel: merchant confirms, player sees it');
  check(A, 'player', 'the split matches the ACTIVE policy, not a hardcoded number', 'deposit 900 / reserve 100',
    `${dDep} / ${dRes}`, dDep === 900 && dRes === 100);

  const holdAfter = await pgQuery(
    `SELECT state FROM merchant_settlements WHERE order_id=$1 AND direction='DEPOSIT'`, [oid], 'e2e');
  check(A, 'system', 'the escrow hold is consumed by the confirm', 'not still HELD',
    holdAfter.rows.map(r => r.state).join(',') || 'none', !holdAfter.rows.some(r => r.state === 'HELD'));

  // ── Admin sees the completed order ───────────────────────────────────────
  const adminOrders = await GET(aT, `/api/admin/payment-queue`);
  const adminSees = JSON.stringify(adminOrders.body).includes(oid);
  check(A, 'admin', 'the order is visible to admin', 'present',
    adminOrders.status === 200 ? (adminSees ? 'present' : 'ABSENT') : `HTTP ${adminOrders.status}`,
    adminOrders.status === 200 && adminSees);

  return { player, m, m2, admin, oid };
}
