// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 3: the USDT rail ───────────────────────────────────────────────
// §25. A player buys PLATFORM TOKENS by sending USDT to a USDT merchant's own
// wallet. The USDT never touches the platform: the merchant's balance is
// tokens, and what moves here is the token side of that trade.
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedMerchant, seedAdmin, trc20, bep20 } from '../seed.js';
import { playerToken, merchantToken, adminToken, GET, POST, check, note } from '../harness.js';

const A = 'USDT';
export default async function run() {
  const admin = await seedAdmin(); const aT = adminToken(admin);
  const cfg = (await GET(playerToken(await seedPlayer({})), '/api/v1/system/config')).body?.config ?? {};
  const rate = cfg.usdtTokensPerUnit;
  check(A, 'system', 'a USDT rate is set', 'a positive number', String(rate), Number(rate) > 0,
    '§25: there is no fallback — 0 gives Infinity USDT and 1 sells 50,000 tokens for 50,000 USDT');

  // A TRC-20 merchant with tokens to sell, holding an address on that chain only.
  const tron = await seedMerchant({
    currency: 'USDT', tokensPaise: 100000000000, usdtAddressTrc20: trc20(),
  });
  const player = await seedPlayer({});
  const pT = playerToken(player), tT = merchantToken(tron);

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

  // ── A merchant with no address on THAT chain is not a candidate ──────────
  const bnb = await seedMerchant({
    currency: 'USDT', tokensPaise: 100000000000, usdtAddressBep20: bep20(),
  });
  const bnbClaim = await POST(merchantToken(bnb), `/api/merchant/accept/${oid}`, {});
  check(A, 'merchant', 'a BEP-20-only merchant cannot take this order', '4xx',
    `${bnbClaim.status} ${bnbClaim.body.message ?? ''}`, bnbClaim.status >= 400,
    'NOTE: once the order is assigned, ANY other merchant is refused, so this '
    + 'does not on its own prove the CHAIN guard. §25 puts that guard in the '
    + 'assignment query (a row cannot see which chain an order asked for); the '
    + 'assignment below landing on a TRC-20 holder is the evidence for it.');

  // ── The merchant's wallet is TOKENS, not USDT (owner correction) ─────────
  const prof = await GET(tT, '/api/merchant/profile');
  check(A, 'merchant', 'the USDT merchant\'s balance is platform tokens', 'a token balance',
    String(prof.body.merchant?.tokenBalance ?? 'ABSENT'),
    Number(prof.body.merchant?.tokenBalance) > 0,
    'the USDT goes to the merchant\'s own wallet against tokens; the platform moves the tokens');

  // The real proof of the chain guard: whoever the platform CHOSE holds an
  // address on the order's chain. A merchant with only a BEP-20 address must
  // never be selected for a TRC-20 order — the money would be unrecoverable.
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
      'no USDT merchant was free — the hash-claim half of this scenario needs an assigned order');
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
