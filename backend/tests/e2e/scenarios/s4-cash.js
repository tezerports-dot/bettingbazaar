// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 4: the CASH_ATM rail ───────────────────────────────────────────
// Since Step 2c there is no rail switch to publish: an order's rail is DERIVED
// from its size and currency (`orderRails.js`) — an INR buy up to ₹10,000 is
// paid in cash at an ATM, anything above runs on UPI/bank — and stamped on the
// order immutably. A cash buy is served by a member of a CASH team who has
// pressed Ready (they are standing at the machine), and taking the order clears
// Ready, so one member holds one cash buy at a time.
//
// Nothing here writes shared config, so there is nothing to restore (trap 10).
// The one ordering hazard is the server's `order-assignment` cron: an order
// left PENDING_QUEUE is offered again every run, so the queued order below is
// cancelled BEFORE the member presses Ready, or the cron could hand it over.
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedMerchant, seedTeam, orderPoolTrail } from '../seed.js';
import { playerToken, merchantToken, GET, POST, PUT, check, note } from '../harness.js';

const A = 'CASH';
const stateOf = async (oid) => (await pgQuery(
  'SELECT state, merchant_id, payment_mode, pool_held_paise FROM order_states WHERE order_id = $1',
  [oid], 'e2e')).rows[0] ?? {};

export default async function run() {
  const m = await seedMerchant({ currency: 'INR' });
  const outsider = await seedMerchant({ currency: 'INR' });
  // `m` is the only member online on the cash rail (`exclusive`), and has NOT
  // pressed Ready. The pool covers several cash buys.
  const team = await seedTeam({ rail: 'CASH', poolTokens: 20000, include: [m], online: [m] });
  const mT = merchantToken(m), outT = merchantToken(outsider);

  // ── The rail is DERIVED from the size, not chosen by a policy ─────────────
  const upiPlayer = await seedPlayer({});
  const upiPT = playerToken(upiPlayer);
  const big = await POST(upiPT, '/api/payment/deposit/create', { tokenAmount: 50000 });
  const bigId = big.body?.order?.orderId;
  const bigRow = bigId ? await stateOf(bigId) : {};
  check(A, 'system', 'a 50,000-token buy runs on UPI/bank, not cash', 'P2P_UPI',
    bigId ? String(bigRow.payment_mode) : `no order: ${big.status} ${big.body.message ?? ''}`,
    bigRow.payment_mode === 'P2P_UPI',
    'Step 2d: the size names the rail — 500 to 10,000 cash, 50,000 and up UPI/bank');
  // Not this scenario's order to keep; a queued one is cancelled so it does
  // not sit on the UPI rail for a later scenario's team to pick up.
  if (bigId && bigRow.state === 'PENDING_QUEUE') await POST(upiPT, '/api/payment/order/cancel', { orderId: bigId });

  const oddPlayer = await seedPlayer({});
  const odd = await POST(playerToken(oddPlayer), '/api/payment/deposit/create', { tokenAmount: 7770 });
  check(A, 'player', 'a buy that is not an order size is refused by name', '400 NOT_AN_ORDER_SIZE',
    `${odd.status} ${odd.body.code ?? ''} ${odd.body.message ?? ''}`,
    odd.status === 400 && odd.body.code === 'NOT_AN_ORDER_SIZE');

  // ── Nobody is Ready, so a cash buy waits ──────────────────────────────────
  const waitPlayer = await seedPlayer({});
  const waitPT = playerToken(waitPlayer);
  const waiting = await POST(waitPT, '/api/payment/deposit/create', { tokenAmount: 1000 });
  const waitId = waiting.body?.order?.orderId;
  const waitRow = waitId ? await stateOf(waitId) : {};
  check(A, 'system', 'a cash buy with no member Ready waits in the queue', 'PENDING_QUEUE, nobody assigned',
    waitId ? `${waitRow.state}, ${waitRow.merchant_id ?? 'nobody'}` : `no order: ${waiting.status} ${waiting.body.message ?? ''}`,
    waitRow.state === 'PENDING_QUEUE' && !waitRow.merchant_id,
    'a cash member must be at the machine before a buy is theirs');
  if (waitId) {
    const cancel = await POST(waitPT, '/api/payment/order/cancel', { orderId: waitId });
    check(A, 'player', 'cancel the waiting buy', '200', `${cancel.status} ${cancel.body.message ?? ''}`,
      cancel.status === 200);
  }

  // ── Ready is the member's own switch, and only a cash member has one ──────
  const notCash = await PUT(outT, '/api/merchant/cash-ready', { ready: true });
  check(A, 'merchant', 'a merchant in no cash team cannot press Ready', '409 not_cash_member',
    `${notCash.status} ${notCash.body.code ?? ''}`, notCash.status === 409 && notCash.body.code === 'not_cash_member');
  const ready = await PUT(mT, '/api/merchant/cash-ready', { ready: true });
  check(A, 'merchant', 'the cash member presses Ready', '200, ready true',
    `${ready.status} ready=${ready.body.ready}`, ready.status === 200 && ready.body.ready === true);
  const prof = await GET(mT, '/api/merchant/profile');
  check(A, 'merchant', 'the merchant panel reads Ready back', 'cashReady true',
    `${prof.status} cashReady=${prof.body.merchant?.cashReady}`, prof.body.merchant?.cashReady === true);

  // ── A cash buy now reaches the Ready member, and Ready is spent ───────────
  const p = await seedPlayer({});
  const pT = playerToken(p);
  const ord = await POST(pT, '/api/payment/deposit/create', { tokenAmount: 1000 });
  const oid = ord.body?.order?.orderId;
  if (!oid) {
    note(A, 'player', 'create a cash buy', 'an order', `${ord.status} ${ord.body.message ?? ''}`,
      'could not stage the rest of the cash rail');
    return;
  }
  const row = await stateOf(oid);
  check(A, 'system', 'the cash buy is ASSIGNED to the Ready member', `ASSIGNED to ${m.merchantId}`,
    `${row.state} to ${row.merchant_id ?? 'nobody'}`, row.state === 'ASSIGNED' && row.merchant_id === m.merchantId);
  check(A, 'system', 'the order carries the rail its size implies', 'CASH_ATM',
    row.payment_mode ?? 'missing', row.payment_mode === 'CASH_ATM');
  const hold = (await orderPoolTrail(oid)).entries.filter(e => e.kind === 'BUY_HOLD');
  check(A, 'system', 'the cash team\'s pool holds the tokens', `BUY_HOLD held +100000 in ${team.teamId}`,
    hold.map(e => `${e.kind} held ${e.held}, team ${e.teamId}`).join('; ') || 'NO HOLD',
    hold.length === 1 && hold[0].teamId === team.teamId && hold[0].held === 100000);
  const after = await GET(mT, '/api/merchant/profile');
  check(A, 'merchant', 'taking the cash buy clears Ready', 'cashReady false',
    `cashReady=${after.body.merchant?.cashReady}`, after.body.merchant?.cashReady === false,
    'one member, one cash buy at the machine at a time');

  let immutable = false;
  try {
    await pgQuery(`UPDATE order_states SET payment_mode='P2P_UPI' WHERE order_id=$1`, [oid], 'e2e');
  } catch { immutable = true; }
  check(A, 'system', 'an order\'s rail cannot be changed afterwards', 'the trigger refuses it',
    immutable ? 'refused' : 'CHANGED', immutable,
    '§2: every worker and screen branches on the ORDER\'s own value');

  // ── A cash SELL is not handed to a member holding a cash buy ──────────────
  const seller = await seedPlayer({});
  const sT = playerToken(seller);
  const { creditWinnings } = await import('../../../domains/wallet/walletAuthority.service.js');
  await creditWinnings(seller.userId, 20000, 'e2e seed winnings', `${seller.userId}_e2e_win`, `${seller.userId}_e2e_win`);
  await pgQuery(`UPDATE users SET bank_details = $2 WHERE user_id = $1`,
    [seller.userId, JSON.stringify({ accountNumber: '900033334444', ifscCode: 'HDFC0000009', accountHolder: 'E2E Seller' })],
    'e2e_bank');
  const oddSell = await POST(sT, '/api/payment/withdrawal/create', { tokenAmount: 7770 });
  check(A, 'player', 'a sell that is not an order size is refused by name', '400 NOT_AN_ORDER_SIZE',
    `${oddSell.status} ${oddSell.body.code ?? ''}`, oddSell.status === 400 && oddSell.body.code === 'NOT_AN_ORDER_SIZE');
  const sell = await POST(sT, '/api/payment/withdrawal/create', { tokenAmount: 1000 });
  const sellId = sell.body?.order?.orderId;
  const sellRow = sellId ? await stateOf(sellId) : {};
  check(A, 'system', 'a cash sell is not routed to the member holding a cash buy', `not ${m.merchantId}`,
    sellId ? `${sellRow.state}, ${sellRow.merchant_id ?? 'nobody'}` : `no order: ${sell.status} ${sell.body.message ?? ''}`,
    !!sellId && sellRow.merchant_id !== m.merchantId,
    'the member is at the machine paying in; they cannot also be paying out');
  if (sellId && sellRow.state === 'PENDING_QUEUE') {
    const back = await POST(sT, '/api/payment/order/cancel', { orderId: sellId });
    check(A, 'player', 'cancel the waiting sell', '200', `${back.status} ${back.body.message ?? ''}`, back.status === 200);
  }

  // ── Nothing to pay until the member accepts and scans the machine (2d) ──
  const unaccepted = await POST(pT, `/api/payment/order/${oid}/mark-paid`, {});
  check(A, 'player', '"I\'ve paid" before the member accepts', '409 NOT_ACCEPTED_YET',
    `${unaccepted.status} ${unaccepted.body.code ?? ''}`, unaccepted.status === 409 && unaccepted.body.code === 'NOT_ACCEPTED_YET');
  const scanFirst = await POST(mT, `/api/merchant/orders/${oid}/cash-link`, { link: `upi://pay?pa=atm.cash@icici&am=1000.00` });
  check(A, 'merchant', 'scanning before accepting the order', '409 ACCEPT_FIRST',
    `${scanFirst.status} ${scanFirst.body.code ?? ''}`, scanFirst.status === 409 && scanFirst.body.code === 'ACCEPT_FIRST',
    'until the member accepts, an admin may still move the order; a QR attached now would be another member\'s machine');
  const accepted = await POST(mT, `/api/merchant/accept/${oid}`, {});
  check(A, 'merchant', 'the member accepts the cash buy', '200', `${accepted.status} ${accepted.body.message ?? ''}`, accepted.status === 200);
  const tooSoon = await POST(pT, `/api/payment/order/${oid}/mark-paid`, {});
  check(A, 'player', '"I\'ve paid" before the member scans the machine', '409 CASH_LINK_PENDING',
    `${tooSoon.status} ${tooSoon.body.code ?? ''}`, tooSoon.status === 409 && tooSoon.body.code === 'CASH_LINK_PENDING',
    'there was nothing to pay: a cash buy is paid through the machine\'s QR');
  const unscanned = await GET(pT, `/api/payment/order/${oid}/status`);
  check(A, 'player', 'the player is given nothing to pay before the scan', 'no payTo.paymentLink, no bank account',
    JSON.stringify(unscanned.body.payTo ?? null), !unscanned.body.payTo?.paymentLink && !unscanned.body.payTo?.bankAccount);
  const atm = (rupees) => `upi://pay?pa=atm.cash@icici&pn=ICICI%20ATM&am=${rupees}.00&cu=INR&tr=E2E${String(Date.now()).slice(-8)}`;
  const wrong = await POST(mT, `/api/merchant/orders/${oid}/cash-link`, { link: atm(5000) });
  check(A, 'merchant', 'a QR for another amount is refused by name', '400 INVALID_CASH_LINK',
    `${wrong.status} ${wrong.body.code ?? ''} ${wrong.body.message ?? ''}`,
    wrong.status === 400 && wrong.body.code === 'INVALID_CASH_LINK');
  const link = atm(1000);
  const scanned = await POST(mT, `/api/merchant/orders/${oid}/cash-link`, { link });
  check(A, 'merchant', 'the member scans the machine\'s QR for the order amount', '200, the link on the order',
    `${scanned.status} ${scanned.body.order?.cashLink === link ? 'stored' : scanned.body.message ?? 'not stored'}`,
    scanned.status === 200 && scanned.body.order?.cashLink === link);
  const payable = await GET(pT, `/api/payment/order/${oid}/status`);
  check(A, 'player', 'the player is given exactly that QR to pay', link,
    payable.body.payTo?.paymentLink ?? 'missing', payable.body.payTo?.paymentLink === link);

  // ── "Payment not received" waits for the tap (owner, 2026-10-07) ─────────
  // The member's rejection denies a payment the player CLAIMED; with the QR
  // scanned and no tap yet there is none. Both doors refuse, and the player is
  // neither warned nor flagged.
  const earlyProof = await POST(mT, `/api/merchant/order-reject-proof/${oid}/upload-url`,
    { fileName: 'statement.jpg', contentType: 'image/jpeg', fileSize: 1024 });
  const earlyReject = await POST(mT, `/api/merchant/orders/${oid}/reject`,
    { reason: 'No credit for this order in my account', proofFileKey: 'merchant-reject-proof/none.jpg' });
  const unwarned = (await pgQuery('SELECT warning_count, payment_flagged FROM users WHERE user_id = $1',
    [p.userId], 'e2e')).rows[0] ?? {};
  const unpaid = await stateOf(oid);
  check(A, 'merchant', '"payment not received" and its proof upload before the player taps Paid',
    '400 NOT_PAID_YET from both; still PROCESSING; player not warned or flagged',
    `${earlyProof.status} ${earlyProof.body.code ?? ''}; ${earlyReject.status} ${earlyReject.body.code ?? ''}; `
      + `${unpaid.state}; warnings ${unwarned.warning_count}, flagged ${unwarned.payment_flagged}`,
    earlyProof.status === 400 && earlyProof.body.code === 'NOT_PAID_YET'
      && earlyReject.status === 400 && earlyReject.body.code === 'NOT_PAID_YET'
      && unpaid.state === 'PROCESSING' && Number(unwarned.warning_count) === 0 && unwarned.payment_flagged === false,
    'REJECTED has one edge in the state machine, from PAID; the message tells the member to wait for the tap');

  // ── The tap reaches PAID; the reference follows; then the member confirms ─
  const tap = await POST(pT, `/api/payment/order/${oid}/mark-paid`, {});
  const tapped = await stateOf(oid);
  check(A, 'player', 'a cash buy is marked paid on the tap, with no reference yet', '200, PAID',
    `${tap.status} ${tapped.state}`, tap.status === 200 && tapped.state === 'PAID');
  const early = await POST(mT, `/api/merchant/confirm/${oid}`, {});
  check(A, 'merchant', 'confirming before the player\'s reference arrives', '400 naming the missing reference',
    `${early.status} ${early.body.message ?? ''}`,
    early.status === 400 && /no payment reference/i.test(early.body.message ?? ''));
  const ref = String(Date.now()).slice(-12).padStart(12, '6');
  const sent = await POST(pT, `/api/payment/order/${oid}/payment-reference`, { utrNumber: ref });
  check(A, 'player', 'the reference follows the tap', '200', `${sent.status} ${sent.body.message ?? ''}`, sent.status === 200);
  const done = await POST(mT, `/api/merchant/confirm/${oid}`, {});
  check(A, 'merchant', 'the member confirms the cash buy', '200', `${done.status} ${done.body.message ?? ''}`,
    done.status === 200);
  const spent = (await orderPoolTrail(oid)).entries.filter(e => e.kind === 'BUY_PAID');
  check(A, 'system', 'the pool hold is spent by the confirm', 'one BUY_PAID, held -100000',
    spent.map(e => `${e.kind} held ${e.held}`).join('; ') || 'NO BUY_PAID',
    spent.length === 1 && spent[0].held === -100000 && spent[0].available === 0);
}
