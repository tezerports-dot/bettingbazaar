// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 1: the BUY rail (player buys platform tokens with INR/UPI) ──────
// Driven over real HTTP as three different actors, with the database consulted
// directly for the facts a panel cannot show (the team pool's hold, ledger rows).
//
// Since Step 2c an order is served by a MEMBER of a working team on the order's
// rail, and the tokens come out of the team's POOL — held when the order is
// assigned, spent when the member confirms. Above ₹10,000 an INR buy runs on the
// UPI/bank rail (`orderRails.js`), so this buy is 20,000 tokens.
import { db } from '#db';
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedMerchant, seedTeam, seedAdmin, orderPoolTrail } from '../seed.js';
import { playerToken, merchantToken, adminToken, GET, POST, PUT, check, note } from '../harness.js';

const A = 'BUY';
export default async function run() {
  const player = await seedPlayer({ balancePaise: 0 });
  const other  = await seedPlayer({ balancePaise: 0 });
  const m      = await seedMerchant({ currency: 'INR' });
  const m2     = await seedMerchant({ currency: 'INR' });
  // The two named members are the only ones online on the rail (`exclusive`),
  // so the buy lands on one of them and the other is the stranger.
  const team   = await seedTeam({ rail: 'UPI_BANK', poolTokens: 100000, include: [m, m2], online: [m, m2] });
  const admin  = await seedAdmin();
  const pT = playerToken(player), oT = playerToken(other);
  const mT = merchantToken(m), m2T = merchantToken(m2), aT = adminToken(admin);

  // ── The step and the floor ─────────────────────────────────────────────────
  // 20,005 is above the cash ceiling, so it reaches the multiple-of-10 rule;
  // a small odd amount would stop earlier, at the cash denomination rule.
  const notTen = await POST(pT, '/api/payment/deposit/create', { tokenAmount: 20005 });
  check(A, 'player', 'buy an amount that is not a multiple of 10', '4xx naming the step',
    `${notTen.status} ${notTen.body.message ?? ''}`,
    notTen.status === 400 && /multiple of 10/i.test(notTen.body.message ?? ''));

  // 490 is a multiple of 10 and below the 500-token floor. At that size the
  // buy is cash-sized, so the refusal that names it is the denomination rule
  // (500 is the smallest amount a machine dispenses) — the floor from the
  // other end.
  const tooSmall = await POST(pT, '/api/payment/deposit/create', { tokenAmount: 490 });
  check(A, 'player', 'buy below the 500-token floor', '400 NOT_A_DENOMINATION',
    `${tooSmall.status} ${tooSmall.body.code ?? ''} ${tooSmall.body.message ?? ''}`,
    tooSmall.status === 400 && tooSmall.body.code === 'NOT_A_DENOMINATION');

  // ── Create a real buy ─────────────────────────────────────────────────────
  const created = await POST(pT, '/api/payment/deposit/create', { tokenAmount: 20000 });
  const order = created.body.order;
  check(A, 'player', 'create a 20,000-token buy', '200 with an order', `${created.status} ${order?.orderId ?? JSON.stringify(created.body).slice(0,120)}`,
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
  check(A, 'system', 'the buy is ASSIGNED to one of the two team members', 'one of the seeded members',
    assignedId ?? 'nobody', !!assignedT);
  if (!assignedT) return;

  const mine = await GET(assignedT, `/api/merchant/orders`);
  const listed = (mine.body.orders ?? []).some(o => o.orderId === oid);
  check(A, 'merchant', 'assigned merchant sees the order in their list', 'the order present', listed ? 'present' : 'ABSENT', listed);

  const theirs = await GET(strangerT, `/api/merchant/orders`);
  const crossListed = (theirs.body.orders ?? []).some(o => o.orderId === oid);
  check(A, 'merchant', 'a different merchant does NOT see it', 'absent', crossListed ? 'PRESENT' : 'absent', !crossListed);

  // ── The tokens are HELD in the team's pool at assignment, not merely checked
  // `holdForBuyWithin`, in the same transaction that assigned the order: the
  // order names its team and the amount it holds, and the pool's ledger has
  // one BUY_HOLD entry for this order moving available → held.
  const row = (await pgQuery(
    'SELECT team_id, pool_held_paise FROM order_states WHERE order_id = $1', [oid], 'e2e')).rows[0] ?? {};
  check(A, 'system', 'the order is held by the routing team\'s pool', `team ${team.teamId}, 2000000 paise held`,
    `team ${row.team_id ?? 'none'}, ${row.pool_held_paise ?? 'none'} paise held`,
    row.team_id === team.teamId && Number(row.pool_held_paise) === 2000000);
  const held = (await orderPoolTrail(oid)).entries;
  const holdEntry = held.filter(e => e.kind === 'BUY_HOLD');
  check(A, 'system', 'one BUY_HOLD pool entry moves the tokens available → held', 'available -2000000, held +2000000',
    holdEntry.map(e => `${e.kind} avail ${e.available}, held ${e.held}`).join('; ') || 'NO HOLD ENTRY',
    holdEntry.length === 1 && holdEntry[0].teamId === team.teamId
      && holdEntry[0].available === -2000000 && holdEntry[0].held === 2000000);

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
  const dup = await POST(dupT, '/api/payment/deposit/create', { tokenAmount: 20000 });
  // Only an ASSIGNED order can be marked paid at all; a refusal of an order
  // nobody held would pass this check for the wrong reason.
  const dupState = dup.body.order?.orderId
    ? (await pgQuery('SELECT state FROM order_states WHERE order_id = $1', [dup.body.order.orderId], 'e2e')).rows[0]?.state
    : null;
  check(A, 'system', 'the second buy is ASSIGNED, so only the UTR can refuse it', 'ASSIGNED',
    dupState ?? `no order: ${dup.status} ${JSON.stringify(dup.body).slice(0, 120)}`, dupState === 'ASSIGNED');
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

  // ── Member confirms; the player is credited and the pool hold is spent ────
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
  check(A, 'player', 'the tokens bought arrive, split per the deposit policy', '20000 across the pockets',
    `deposit +${dDep}, reserve +${dRes} = ${dDep + dRes}`, dDep + dRes === 20000,
    'cross-panel: merchant confirms, player sees it');
  check(A, 'player', 'the split matches the ACTIVE policy, not a hardcoded number', 'deposit 18000 / reserve 2000',
    `${dDep} / ${dRes}`, dDep === 18000 && dRes === 2000);

  // `spendForBuy`: the hold leaves the pool (BUY_PAID, held -amount), the order
  // holds nothing, and the treasury moves the tokens TEAM_FLOAT → USER_FLOAT
  // under the movement named after this order. Read by the order's id, never by
  // diffing the floats (trap 10 — the crons move them underneath).
  const trail = await orderPoolTrail(oid);
  const paidEntry = trail.entries.filter(e => e.kind === 'BUY_PAID');
  check(A, 'system', 'the pool hold is spent by the confirm', 'one BUY_PAID entry, held -2000000',
    paidEntry.map(e => `${e.kind} avail ${e.available}, held ${e.held}`).join('; ') || 'NO BUY_PAID ENTRY',
    paidEntry.length === 1 && paidEntry[0].available === 0 && paidEntry[0].held === -2000000);
  const heldAfter = (await pgQuery(
    'SELECT pool_held_paise FROM order_states WHERE order_id = $1', [oid], 'e2e')).rows[0]?.pool_held_paise;
  check(A, 'system', 'the order no longer holds pool tokens', '0', String(heldAfter), Number(heldAfter) === 0);
  const legs = trail.legs[`team_buy_${oid}`] ?? {};
  check(A, 'system', 'the treasury moves the tokens from the team float to the players', 'TEAM_FLOAT -2000000, USER_FLOAT +2000000',
    JSON.stringify(legs), legs.TEAM_FLOAT === -2000000 && legs.USER_FLOAT === 2000000 && Object.keys(legs).length === 2);

  // ── Admin sees the completed order ───────────────────────────────────────
  const adminOrders = await GET(aT, `/api/admin/payment-queue`);
  const adminSees = JSON.stringify(adminOrders.body).includes(oid);
  check(A, 'admin', 'the order is visible to admin', 'present',
    adminOrders.status === 200 ? (adminSees ? 'present' : 'ABSENT') : `HTTP ${adminOrders.status}`,
    adminOrders.status === 200 && adminSees);

  return { player, m, m2, team, admin, oid };
}
