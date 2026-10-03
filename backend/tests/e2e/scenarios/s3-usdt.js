// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 3: the USDT rail ───────────────────────────────────────────────
// §25. A player buys PLATFORM TOKENS by sending USDT to a USDT merchant's own
// wallet. The USDT never touches the platform: what the platform moves is the
// token side of that trade, out of the serving TEAM's pool (Step 2c — a member
// of a working team on the USDT rail serves it, and holds an address on the
// order's chain).
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedMerchant, seedTeam, seedAdmin, trc20, bep20, orderPoolTrail } from '../seed.js';
import { playerToken, merchantToken, adminToken, GET, POST, PUT, check, note } from '../harness.js';

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
    '§25: there is no fallback — 0 gives Infinity USDT and 1 sells 50,000 tokens for 50,000 USDT');

  // Two members of one USDT team, each holding an address on ONE chain: `tron`
  // on TRC-20, `bnb` on BEP-20. They are the only members online on the rail
  // (`exclusive`), and the pool can cover the buy.
  const tron = await seedMerchant({ currency: 'USDT', usdtAddressTrc20: trc20() });
  const bnb  = await seedMerchant({ currency: 'USDT', usdtAddressBep20: bep20() });
  const team = await seedTeam({ rail: 'USDT', poolTokens: 100000, include: [tron, bnb], online: [tron, bnb] });
  // Routing's tie-break is least recently assigned, never-assigned first. So
  // `tron` is marked as just assigned: if the chain guard were missing, `bnb`
  // would be the member chosen, and the check below would catch it.
  await pgQuery('UPDATE merchants SET last_assigned_at = now() WHERE merchant_id = $1', [tron.merchantId], 'e2e');
  await pgQuery('UPDATE merchants SET last_assigned_at = NULL WHERE merchant_id = $1', [bnb.merchantId], 'e2e');
  const player = await seedPlayer({});
  const pT = playerToken(player);

  // ── The denominations are the only sizes (§25) ───────────────────────────
  const odd = await POST(pT, '/api/payment/usdt/deposit/create', { tokenAmount: 60000, usdtChain: 'TRC20' });
  check(A, 'player', 'a size that is not a denomination', '4xx naming the sizes',
    `${odd.status} ${odd.body.message ?? ''}`, odd.status >= 400 && odd.status < 500);

  // ── The chain is required, and must be one that exists ───────────────────
  const noChain = await POST(pT, '/api/payment/usdt/deposit/create', { tokenAmount: 50000 });
  check(A, 'player', 'no chain named', '4xx', `${noChain.status} ${noChain.body.message ?? ''}`,
    noChain.status >= 400 && noChain.status < 500,
    '§25: USDT sent to the wrong chain is the one unrecoverable mistake this platform can make');

  const badChain = await POST(pT, '/api/payment/usdt/deposit/create', { tokenAmount: 50000, usdtChain: 'ERC20' });
  check(A, 'player', 'a chain the platform does not run', '4xx',
    `${badChain.status} ${badChain.body.message ?? ''}`, badChain.status >= 400 && badChain.status < 500);

  // ── A real USDT buy ──────────────────────────────────────────────────────
  const created = await POST(pT, '/api/payment/usdt/deposit/create', { tokenAmount: 50000, usdtChain: 'TRC20' });
  const order = created.body.order;
  check(A, 'player', 'create a 50,000-token USDT buy on TRC-20', '200 with an order',
    `${created.status} ${order?.orderId ?? JSON.stringify(created.body).slice(0,160)}`,
    created.status === 200 && !!order?.orderId);
  if (!order?.orderId) return;
  const oid = order.orderId;

  // ── The quote is the contract, frozen on the row (§25) ───────────────────
  const row = await pgQuery(
    `SELECT currency, usdt_chain, rate_used, fiat_amount_paise, token_amount_paise, merchant_id
       FROM order_states WHERE order_id = $1`, [oid], 'e2e');
  const r = row.rows[0] ?? {};
  check(A, 'system', 'the order is USDT on the chain the player picked', 'USDT / TRC20',
    `${r.currency} / ${r.usdt_chain}`, r.currency === 'USDT' && r.usdt_chain === 'TRC20');
  check(A, 'system', 'the rate is written WITH the order', 'a stored rate',
    String(r.rate_used ?? 'NULL'), r.rate_used != null,
    '§25: assignment may not re-price — an admin edit in between must not change an agreed purchase');

  // Trap 15: `fiat_amount_paise` is in the ORDER's currency. On a USDT order it
  // holds USDT, and `token_amount_paise` is what the ledger and any aggregate
  // must use.
  check(A, 'system', 'the token amount is recorded separately from the USDT figure', '50,000 tokens',
    `tokens ${Number(r.token_amount_paise) / 100}, fiat ${Number(r.fiat_amount_paise) / 100}`,
    Number(r.token_amount_paise) === 5000000,
    'trap 15: a 50,000-token USDT deposit must never be aggregated as ₹500');

  // ── The chain is FROZEN by trigger ───────────────────────────────────────
  let frozen = false; let why = '';
  try {
    await pgQuery(`UPDATE order_states SET usdt_chain = 'BEP20' WHERE order_id = $1`, [oid], 'e2e');
  } catch (e) { frozen = true; why = e.message.slice(0, 90); }
  check(A, 'system', 'the chain cannot be changed after the order exists', 'the trigger refuses it',
    frozen ? why : 'CHANGED — the snapshot now names the wrong chain', frozen,
    '§25: the snapshot carries the address for that chain alone');

  // ── And so is the quote ──────────────────────────────────────────────────
  let rateFrozen = false;
  try {
    await pgQuery(`UPDATE order_states SET rate_used = 1 WHERE order_id = $1`, [oid], 'e2e');
  } catch { rateFrozen = true; }
  check(A, 'system', 'the quote cannot be re-priced after the order exists', 'the trigger refuses it',
    rateFrozen ? 'refused' : 'RE-PRICED', rateFrozen);

  // ── §24: the player is told where to pay and nothing about who ───────────
  const view = JSON.stringify(order);
  check(A, 'player', 'the player is given an address AND its network together', 'both present',
    /TRC20|Tron/i.test(view) ? 'chain named' : 'CHAIN MISSING', /TRC20|Tron/i.test(view),
    '§25: an address on its own is the mistake');

  // ── A member with no address on THAT chain is not a candidate ────────────
  const bnbClaim = await POST(merchantToken(bnb), `/api/merchant/accept/${oid}`, {});
  check(A, 'merchant', 'a BEP-20-only teammate cannot take this order', '4xx',
    `${bnbClaim.status} ${bnbClaim.body.message ?? ''}`, bnbClaim.status >= 400,
    'NOTE: once the order is assigned, ANY other member is refused, so this '
    + 'does not on its own prove the CHAIN guard. §25 puts that guard in the '
    + 'routing query (a row cannot see which chain an order asked for); the '
    + 'assignment below landing on the TRC-20 holder is the evidence for it.');

  // ── The team's pool holds TOKENS, not USDT (owner correction; trap 15) ───
  // The USDT goes to the member's own wallet; the platform holds the 50,000
  // TOKENS the player is buying in the team's pool, at assignment.
  const hold = (await orderPoolTrail(oid)).entries.filter(e => e.kind === 'BUY_HOLD');
  check(A, 'system', 'the team pool holds the TOKENS bought, not the USDT figure', `BUY_HOLD held +5000000 in ${team.teamId}`,
    hold.map(e => `${e.kind} avail ${e.available}, held ${e.held}, team ${e.teamId}`).join('; ') || 'NO HOLD',
    hold.length === 1 && hold[0].teamId === team.teamId && hold[0].held === 5000000 && hold[0].available === -5000000,
    'trap 15: 50,000 tokens is 5,000,000 paise; the order\'s USDT figure is a different unit');

  // The real proof of the chain guard: whoever the platform CHOSE holds an
  // address on the order's chain. A merchant with only a BEP-20 address must
  // never be selected for a TRC-20 order — the money would be unrecoverable.
  check(A, 'system', 'the TRC-20 member is chosen over the BEP-20 one routing would otherwise prefer', tron.merchantId,
    r.merchant_id ?? 'nobody', r.merchant_id === tron.merchantId);
  if (r.merchant_id) {
    const who = await pgQuery(
      `SELECT usdt_address_trc20, usdt_address_bep20 FROM merchants WHERE merchant_id = $1`,
      [r.merchant_id], 'e2e');
    const w = who.rows[0] ?? {};
    check(A, 'system', 'the chosen merchant holds an address on the ORDER\'s chain', 'a TRC-20 address',
      w.usdt_address_trc20 ? 'TRC-20 address held' : 'NO TRC-20 ADDRESS',
      !!w.usdt_address_trc20,
      '§25: the one unrecoverable mistake is USDT sent to the wrong chain');
  }

  // ── A tx hash is claimed exactly once (§27) ──────────────────────────────
  // A TRON hash is 64 hex characters with NO `0x` — that prefix is an EVM
  // convention and belongs to BEP-20. The route refuses the wrong shape BY
  // NAME ("Enter the Tron (TRC-20) transaction ID — 64 hexadecimal
  // characters"), which is §25's rule that a refusal names that rail's own
  // choices; my first attempt sent an 0x-prefixed hash and was correctly told.
  const hash = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random()*16)]).join('');
  const assigned = r.merchant_id;
  if (!assigned) {
    note(A, 'system', 'the USDT buy reached a merchant', 'assigned', 'still queued',
      'no USDT member was free — the hash-claim half of this scenario needs an assigned order');
    return;
  }
  const paid = await POST(pT, `/api/payment/order/${oid}/mark-paid`, { utrNumber: hash });
  check(A, 'player', 'submit the chain transaction id', '200',
    `${paid.status} ${paid.body.message ?? ''}`, paid.status === 200);

  const claim = await pgQuery(`SELECT order_id FROM utr_registry WHERE utr = $1`, [hash.toUpperCase()], 'e2e');
  check(A, 'system', 'the tx hash is claimed, uppercased, against this order', `one row for ${oid}`,
    claim.rows.length ? claim.rows[0].order_id : 'NOT CLAIMED',
    claim.rows.length === 1 && claim.rows[0].order_id === oid,
    '§27: 0xAB… and 0xab… are ONE transaction and must collide on the key');
}
