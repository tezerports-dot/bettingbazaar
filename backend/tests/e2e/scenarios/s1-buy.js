// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 1: the BUY rail (player buys platform tokens with INR/UPI) ──────
// Driven over real HTTP as three different actors, with the database consulted
// directly for the facts a panel cannot show (the team pool's hold, ledger rows).
//
// Since Step 2c an order is served by a MEMBER of a working team on the order's
// rail, and the tokens come out of the team's POOL — held when the order is
// assigned, spent when the member confirms. The size names the rail (Step 2d,
// `denominations.js`), so this buy is 50,000 tokens: the smallest UPI/bank size.
import { db } from '#db';
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedMerchant, seedTeam, seedAdmin, orderPoolTrail } from '../seed.js';
import { playerToken, merchantToken, adminToken, GET, POST, check, note } from '../harness.js';

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

  // ── Only an order size is a buy (Step 2d) ────────────────────────────────
  // 20,000 sits between the two rails and 490 below the smallest cash size:
  // neither is one of the seven, and the refusal names the ones that are.
  for (const amount of [20000, 490]) {
    const refused = await POST(pT, '/api/payment/deposit/create', { tokenAmount: amount });
    check(A, 'player', `buy ${amount.toLocaleString('en-IN')} tokens, which is not an order size`, '400 NOT_AN_ORDER_SIZE naming the sizes',
      `${refused.status} ${refused.body.code ?? ''} ${refused.body.message ?? ''}`,
      refused.status === 400 && refused.body.code === 'NOT_AN_ORDER_SIZE' && /50,000/.test(refused.body.message ?? ''));
  }

  // ── Create a real buy ─────────────────────────────────────────────────────
  const created = await POST(pT, '/api/payment/deposit/create', { tokenAmount: 50000 });
  const order = created.body.order;
  check(A, 'player', 'create a 50,000-token buy', '200 with an order', `${created.status} ${order?.orderId ?? JSON.stringify(created.body).slice(0,120)}`,
    created.status === 200 && !!order?.orderId);
  if (!order?.orderId) return;
  const oid = order.orderId;

  // ── §24: the player is told where to pay and nothing else about who ───────
  // A bank-transfer buy is paid into the member's bank account, so the player
  // is shown that account (owner, 2026-10-03), and never the member's mobile,
  // UPI handle or anything else from their profile. Not before the member has
  // ACCEPTED the order: until then an admin may still move it to another
  // member, and a player who paid the first would have paid the wrong account.
  const forbidden = ['accountNumber', 'upiId', '@upi', 'upi://', 'usdtAddress', 'merchantSnapshot', 'mobile', m.mobile, m2.mobile];
  const leaks = (body) => forbidden.filter(k => JSON.stringify(body).includes(k));
  check(A, 'player', 'buy response carries no mobile, UPI handle or merchant profile', 'none of ' + forbidden.join(', '),
    leaks(order).join(', ') || 'none present', leaks(order).length === 0);
  check(A, 'player', 'before the member accepts, the player is shown no account to pay', 'payTo with no bankAccount',
    JSON.stringify(order.payTo ?? null), !!order.payTo && !order.payTo.bankAccount && !order.payTo.paymentLink);

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
  check(A, 'system', 'the order is held by the routing team\'s pool', `team ${team.teamId}, 5000000 paise held`,
    `team ${row.team_id ?? 'none'}, ${row.pool_held_paise ?? 'none'} paise held`,
    row.team_id === team.teamId && Number(row.pool_held_paise) === 5000000);
  const held = (await orderPoolTrail(oid)).entries;
  const holdEntry = held.filter(e => e.kind === 'BUY_HOLD');
  check(A, 'system', 'one BUY_HOLD pool entry moves the tokens available → held', 'available -5000000, held +5000000',
    holdEntry.map(e => `${e.kind} avail ${e.available}, held ${e.held}`).join('; ') || 'NO HOLD ENTRY',
    holdEntry.length === 1 && holdEntry[0].teamId === team.teamId
      && holdEntry[0].available === -5000000 && holdEntry[0].held === 5000000);

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

  // ── Nothing is paid before the member accepts ────────────────────────────
  const utr = String(Date.now()).slice(-12).padStart(12, '7');
  const unaccepted = await POST(pT, `/api/payment/order/${oid}/mark-paid`, { utrNumber: utr });
  check(A, 'player', 'mark paid before the member accepts', '409 NOT_ACCEPTED_YET',
    `${unaccepted.status} ${unaccepted.body.code ?? ''}`, unaccepted.status === 409 && unaccepted.body.code === 'NOT_ACCEPTED_YET');
  const stranger = await POST(strangerT, `/api/merchant/accept/${oid}`, {});
  check(A, 'merchant', 'a member it is not assigned to accepts it', '4xx', String(stranger.status), stranger.status >= 400 && stranger.status < 500);
  const accepted = await POST(assignedT, `/api/merchant/accept/${oid}`, {});
  check(A, 'merchant', 'the assigned member accepts the buy', '200', `${accepted.status} ${accepted.body.message ?? ''}`, accepted.status === 200);

  const shown = (await GET(pT, `/api/payment/order/${oid}`)).body.order ?? {};
  const account = shown.payTo?.bankAccount ?? {};
  const payee = [m, m2].find(x => x.bankDetails?.accountNo === account.accountNo);
  check(A, 'player', 'once accepted, the order names the bank account to transfer to', 'the ACCEPTING member\'s account no, IFSC and holder',
    account.accountNo ? `${account.accountNo} ${account.ifsc} ${account.accountHolder}` : 'no account',
    !!payee && payee.merchantId === assignedId && account.ifsc === payee.bankDetails.ifsc && !!account.accountHolder);
  check(A, 'player', 'and still no mobile, UPI handle or merchant profile', 'none of ' + forbidden.join(', '),
    leaks(shown).join(', ') || 'none present', leaks(shown).length === 0);

  // ── Player marks paid with a UTR ──────────────────────────────────────────
  const paid = await POST(pT, `/api/payment/order/${oid}/mark-paid`, { utrNumber: utr });
  check(A, 'player', 'mark paid with a UTR', '200', `${paid.status} ${paid.body.message ?? ''}`, paid.status === 200);

  // ── §27: that UTR now belongs to this order, for good ────────────────────
  const dupPlayer = await seedPlayer({});
  const dupT = playerToken(dupPlayer);
  const dup = await POST(dupT, '/api/payment/deposit/create', { tokenAmount: 50000 });
  // Only an ACCEPTED order can be marked paid at all; a refusal of an order
  // nobody accepted would pass this check for the wrong reason.
  if (dup.body.order?.orderId) {
    const dupMember = (await pgQuery('SELECT merchant_id FROM order_states WHERE order_id = $1', [dup.body.order.orderId], 'e2e')).rows[0]?.merchant_id;
    const dupT2 = dupMember === m.merchantId ? mT : dupMember === m2.merchantId ? m2T : null;
    if (dupT2) await POST(dupT2, `/api/merchant/accept/${dup.body.order.orderId}`, {});
  }
  const dupState = dup.body.order?.orderId
    ? (await pgQuery('SELECT state FROM order_states WHERE order_id = $1', [dup.body.order.orderId], 'e2e')).rows[0]?.state
    : null;
  check(A, 'system', 'the second buy is accepted, so only the UTR can refuse it', 'PROCESSING',
    dupState ?? `no order: ${dup.status} ${JSON.stringify(dup.body).slice(0, 120)}`, dupState === 'PROCESSING');
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
  check(A, 'player', 'the tokens bought arrive, split per the deposit policy', '50000 across the pockets',
    `deposit +${dDep}, reserve +${dRes} = ${dDep + dRes}`, dDep + dRes === 50000,
    'cross-panel: merchant confirms, player sees it');
  check(A, 'player', 'the split matches the ACTIVE policy, not a hardcoded number', 'deposit 45000 / reserve 5000',
    `${dDep} / ${dRes}`, dDep === 45000 && dRes === 5000);

  // `spendForBuy`: the hold leaves the pool (BUY_PAID, held -amount), the order
  // holds nothing, and the treasury moves the tokens TEAM_FLOAT → USER_FLOAT
  // under the movement named after this order. Read by the order's id, never by
  // diffing the floats (trap 10 — the crons move them underneath).
  const trail = await orderPoolTrail(oid);
  const paidEntry = trail.entries.filter(e => e.kind === 'BUY_PAID');
  check(A, 'system', 'the pool hold is spent by the confirm', 'one BUY_PAID entry, held -5000000',
    paidEntry.map(e => `${e.kind} avail ${e.available}, held ${e.held}`).join('; ') || 'NO BUY_PAID ENTRY',
    paidEntry.length === 1 && paidEntry[0].available === 0 && paidEntry[0].held === -5000000);
  const heldAfter = (await pgQuery(
    'SELECT pool_held_paise FROM order_states WHERE order_id = $1', [oid], 'e2e')).rows[0]?.pool_held_paise;
  check(A, 'system', 'the order no longer holds pool tokens', '0', String(heldAfter), Number(heldAfter) === 0);
  const legs = trail.legs[`team_buy_${oid}`] ?? {};
  check(A, 'system', 'the treasury moves the tokens from the team float to the players', 'TEAM_FLOAT -5000000, USER_FLOAT +5000000',
    JSON.stringify(legs), legs.TEAM_FLOAT === -5000000 && legs.USER_FLOAT === 5000000 && Object.keys(legs).length === 2);

  // ── Admin sees the completed order ───────────────────────────────────────
  const adminOrders = await GET(aT, `/api/admin/payment-queue`);
  const adminSees = JSON.stringify(adminOrders.body).includes(oid);
  check(A, 'admin', 'the order is visible to admin', 'present',
    adminOrders.status === 200 ? (adminSees ? 'present' : 'ABSENT') : `HTTP ${adminOrders.status}`,
    adminOrders.status === 200 && adminSees);

  return { player, m, m2, team, admin, oid };
}
