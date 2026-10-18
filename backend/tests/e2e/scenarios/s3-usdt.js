// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 3: the USDT rail ───────────────────────────────────────────────
// §25. A player buys PLATFORM TOKENS by sending USDT on BNB Smart Chain to an
// address the platform derived for that order alone (owner, 2026-10-18). No
// merchant and no transaction hash: the server's chain watcher sees the
// transfer (here on the stand-in node, `bscStub.js`) and credits the order.
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedAdmin } from '../seed.js';
import { playerToken, adminToken, GET, POST, PUT, check } from '../harness.js';
import { sendUsdt } from '../bscStub.js';
import { setTimeout as sleep } from 'node:timers/promises';

const A = 'USDT';
export default async function run() {
  const admin = await seedAdmin(); const aT = adminToken(admin);

  // ── The rate is a PRECONDITION this scenario establishes, not one it assumes ─
  // It read the rate ambiently and asserted it was positive. The schema default
  // is 0 — §25's "there is no fallback", which is the CORRECT state of a database
  // nobody has priced — so on a fresh database this failed twice and reported the
  // platform refusing by name (`USDT_RATE_UNSET`) as a defect. That is trap 10 in
  // its config form: `config_documents` is one row per scope holding the live
  // rules, so a scenario that needs a value SETS it, through the admin route a
  // human would use, and puts the old one back in a `finally` — outside any
  // assertion, because a restore that only runs when the run passed is the one
  // that matters least.
  const cfgBefore = await GET(aT, '/api/admin/system/config');
  const priced = cfgBefore.body?.config?.usdtPricing ?? {};
  const baseline = Number(priced.userMerchantBuyInr ?? 0);
  check(A, 'admin', 'the admin can read the USDT price', '200 with a pricing group',
    `${cfgBefore.status} userMerchantBuyInr=${baseline}`,
    cfgBefore.status === 200 && priced.userMerchantBuyInr !== undefined,
    'the field the Settings screen binds — absent here means the screen edits nothing');

  const setRate = await PUT(aT, '/api/admin/system/config', {
    usdtPricing: { ...priced, userMerchantBuyInr: 90 },
  });
  check(A, 'admin', 'the admin prices the USDT rail', '200',
    `${setRate.status} ${setRate.body?.message ?? ''}`, setRate.status === 200,
    '§25: the rate is admin-set and bounded — a misplaced decimal could price the whole rail');

  try {
    await drivePricedRail();
  } finally {
    await PUT(aT, '/api/admin/system/config', {
      usdtPricing: { ...priced, userMerchantBuyInr: baseline },
    });
  }
}

/** Everything that needs a priced rail. The caller owns the price and restores it. */
async function drivePricedRail() {
  // Cross-panel: the price the ADMIN just set is the price the PLAYER panel is
  // told, from one owner (§2 `SystemConfig.usdtPricing`). Reading it here and
  // asserting it is positive used to be the whole check, which asserted the
  // ambient state of whatever database it ran against rather than anything the
  // platform does.
  const cfg = (await GET(playerToken(await seedPlayer({})), '/api/v1/system/config')).body?.config ?? {};
  const rate = cfg.usdtTokensPerUnit;
  check(A, 'player', 'the player panel is told the rate the admin set', '90',
    String(rate), Number(rate) === 90,
    '§25: there is no fallback — 0 prices nothing and 1 sells 500 tokens for 500 USDT');

  const player = await seedPlayer({});
  const pT = playerToken(player);

  // ── A USDT buy is whole steps of 100 USDT, inside the bounds (Step 2d) ──
  const odd = await POST(pT, '/api/payment/usdt/deposit/create', { usdtAmount: 150 });
  check(A, 'player', 'a USDT amount that is not a step of 100', '400 NOT_A_USDT_AMOUNT',
    `${odd.status} ${odd.body.code ?? ''} ${odd.body.message ?? ''}`,
    odd.status === 400 && odd.body.code === 'NOT_A_USDT_AMOUNT');

  // ── One network, and any other is refused by name ────────────────────────
  const tron = await POST(pT, '/api/payment/usdt/deposit/create', { usdtAmount: 500, usdtChain: 'TRC20' });
  check(A, 'player', 'a buy on Tron, which the platform no longer takes', '400 USDT_CHAIN_UNSUPPORTED',
    `${tron.status} ${tron.body.code ?? ''}`, tron.status === 400 && tron.body.code === 'USDT_CHAIN_UNSUPPORTED',
    '§25: USDT sent on the wrong network is the one unrecoverable mistake this platform can make');

  // ── A real USDT buy ──────────────────────────────────────────────────────
  const created = await POST(pT, '/api/payment/usdt/deposit/create', { usdtAmount: 500 });
  const order = created.body.order;
  check(A, 'player', 'create a 500 USDT buy (45,000 tokens at 90)', '200 with an order',
    `${created.status} ${order?.orderId ?? JSON.stringify(created.body).slice(0, 160)}`,
    created.status === 200 && !!order?.orderId);
  if (!order?.orderId) return;
  const oid = order.orderId;
  const address = order.payTo?.usdtAddress;
  check(A, 'player', 'the player is shown an address of its own AND its network', '0x… on BEP20',
    `${address ?? 'none'} on ${order.payTo?.usdtChain ?? 'none'}`,
    /^0x[0-9a-f]{40}$/.test(address ?? '') && order.payTo?.usdtChain === 'BEP20');

  // ── The quote is the contract, frozen on the row (§25) ───────────────────
  const r = (await pgQuery(
    `SELECT state, currency, usdt_chain, usdt_pay_address, rate_used, fiat_amount_paise, token_amount_paise, merchant_id
       FROM order_states WHERE order_id = $1`, [oid], 'e2e')).rows[0] ?? {};
  check(A, 'system', 'the order is started at once, served by nobody', 'PROCESSING, no merchant',
    `${r.state}, ${r.merchant_id ?? 'no merchant'}`, r.state === 'PROCESSING' && !r.merchant_id);
  check(A, 'system', 'the token amount is recorded separately from the USDT figure', '45,000 tokens',
    `tokens ${Number(r.token_amount_paise) / 100}, fiat ${Number(r.fiat_amount_paise) / 100}`,
    Number(r.token_amount_paise) === 4500000 && Number(r.fiat_amount_paise) === 50000,
    'trap 15: a 45,000-token USDT deposit must never be aggregated as ₹500');

  let frozen = false;
  try {
    await pgQuery(`UPDATE order_states SET usdt_pay_address = $2 WHERE order_id = $1`, [oid, `0x${'1'.repeat(40)}`], 'e2e');
  } catch { frozen = true; }
  check(A, 'system', 'the address cannot be changed after the order exists', 'the trigger refuses it',
    frozen ? 'refused' : 'CHANGED', frozen);
  let rateFrozen = false;
  try {
    await pgQuery(`UPDATE order_states SET rate_used = 1 WHERE order_id = $1`, [oid], 'e2e');
  } catch { rateFrozen = true; }
  check(A, 'system', 'the quote cannot be re-priced after the order exists', 'the trigger refuses it',
    rateFrozen ? 'refused' : 'RE-PRICED', rateFrozen);

  // ── Nothing to submit ────────────────────────────────────────────────────
  const hash = `0x${'a'.repeat(64)}`;
  const submitted = await POST(pT, `/api/payment/order/${oid}/mark-paid`, { utrNumber: hash });
  check(A, 'player', 'a transaction hash is not asked for, and is refused', '400 USDT_CONFIRMED_ON_CHAIN',
    `${submitted.status} ${submitted.body.code ?? ''}`,
    submitted.status === 400 && submitted.body.code === 'USDT_CONFIRMED_ON_CHAIN');

  // ── The USDT arrives, in two transfers, and the watcher credits it ───────
  const tokensHeld = async () => Number((await pgQuery(
    `SELECT COALESCE(deposit_paise + reserve_paise + promo_paise, 0) AS p FROM wallets WHERE user_id = $1`,
    [player.userId], 'e2e')).rows[0]?.p ?? 0) / 100;
  const before = await tokensHeld();
  sendUsdt(address, 200);
  sendUsdt(address, 300);
  let state = null; let received = null;
  for (let i = 0; i < 40 && state !== 'COMPLETED'; i += 1) {
    await sleep(1500);
    const st = (await GET(pT, `/api/payment/order/${oid}`)).body.order ?? {};
    state = st.status; received = st.usdtReceived ?? received;
  }
  check(A, 'system', 'the watcher sees both transfers and completes the buy', 'COMPLETED',
    String(state), state === 'COMPLETED',
    'the server reads the stand-in node every 20 seconds; nobody confirms anything');
  const gained = (await tokensHeld()) - before;
  check(A, 'player', 'the 45,000 tokens are in the wallet', '+45,000 (betting + reserve, and any first-buy bonus)',
    String(gained), gained >= 45000);
  const movement = (await pgQuery(
    `SELECT account, amount_paise FROM treasury_entries WHERE movement_id = $1`, [`usdt_buy_${oid}`], 'e2e')).rows;
  check(A, 'system', 'the tokens leave supply and enter the players\' float, once', 'TOKEN_SUPPLY −4,500,000 / USER_FLOAT +4,500,000',
    movement.map((m) => `${m.account} ${m.amount_paise}`).join(', ') || 'NO MOVEMENT',
    movement.length === 2 && movement.reduce((a, m) => a + Number(m.amount_paise), 0) === 0);
}
