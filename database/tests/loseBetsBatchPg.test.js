// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Lost bets settled a page at a time (`bets.loseBets`), against a real
 * PostgreSQL (owner, 2026-10-10).
 *
 * The batch exists to make a round settle faster, never to settle it
 * differently. So the first test settles the same bets twice over, once with
 * `loseBet` one at a time and once as a page, and asserts every row each path
 * wrote is the same row: the wallets, the wallet ledger, the treasury entries,
 * the transitions, the bets. The rest pin the edges where the page must fall
 * back to the single settlement: a replay, a bet the page cannot batch, a
 * GENERAL cycle, and a single settlement racing the page for the same bet.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { applyDeltaPaise, getBalancesPaise } from '../repositories/wallets.core.js';
import { placeBet, loseBet, loseBets } from '../repositories/bets.core.js';
import * as promo from '../repositories/promo.js';
import { ensureCycle } from '../repositories/markets.js';
import { TEST_FUNDING } from './_funding.js';

const describePg = pgConfigured() ? describe : describe.skip;
const RUN = `lb-${Date.now().toString(36)}`;
let seq = 0;
const next = (tag) => `${RUN}-${tag}${++seq}`;

const fund = (userId, field, paise) => applyDeltaPaise({
  userId, field, deltaPaise: paise, txId: next('fund'), type: 'CREDIT',
  reason: 'test funding', counterparty: TEST_FUNDING,
});

/** Mixed pockets, so the provenance counters are exercised too. */
const MIXED = [
  { field: 'depositBalance', amountPaise: 3_000 },
  { field: 'winningsBalance', amountPaise: 1_500 },
  { field: 'reserveBalance', amountPaise: 500 },
];

async function player() {
  const u = next('u');
  await fund(u, 'depositBalance', 100_000);
  await fund(u, 'winningsBalance', 100_000);
  await fund(u, 'reserveBalance', 100_000);
  return u;
}

async function bet(userId, cycleId, slices = MIXED) {
  const betId = next('b');
  const r = await placeBet({ betId, userId, cycleId, side: 'DELHI', slices });
  expect(r.ok).toBe(true);
  return { betId, userId, slices };
}

let cycleN = 0;
async function cycle(audience = 'VIP') {
  const start = new Date(Date.UTC(2032, 0, 1) + (++cycleN) * 60_000);
  const { cycle: c } = await ensureCycle({
    cycleId: next(`c-${audience}-`), cycleType: '1_MIN', audience,
    startTime: start, endTime: new Date(start.getTime() + 60_000),
  });
  return c.cycleId;
}

/** Everything a settlement of `betIds` wrote, with the keys mapped to bet order. */
async function written(betIds) {
  const keys = betIds.map((b) => `${b}_lose`);
  const ledger = (await pgQuery(
    `SELECT tx_id, field, amount_paise, balance_before_paise, balance_after_paise, tx_type, description, ref_id
       FROM wallet_ledger WHERE tx_id = ANY($1) ORDER BY id`, [keys])).rows;
  const entries = (await pgQuery(
    `SELECT tx_id, movement_id, account, amount_paise, balance_before_paise, balance_after_paise,
            operation, actor, reason, ref_model, ref_id, correlation_id
       FROM treasury_entries WHERE movement_id = ANY($1) ORDER BY id`, [keys])).rows;
  const transitions = (await pgQuery(
    `SELECT tx_id, bet_id, from_status, to_status, actor, reason
       FROM bet_transitions WHERE tx_id = ANY($1) ORDER BY id`, [keys])).rows;
  const bets = (await pgQuery(
    `SELECT bet_id, status, payout_paise, platform_fee_paise, settled_at IS NOT NULL AS settled
       FROM bets WHERE bet_id = ANY($1) ORDER BY bet_id`, [betIds])).rows;
  // Bet ids differ between the two runs; their position does not.
  const pos = new Map(betIds.map((b, i) => [b, `#${i}`]));
  const anon = (s) => (s == null ? s : betIds.reduce((t, b) => t.split(b).join(pos.get(b)), String(s)));
  const strip = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? anon(v) : v])));
  return { ledger: strip(ledger), entries: strip(entries), transitions: strip(transitions), bets: strip(bets).sort((a, b) => a.bet_id.localeCompare(b.bet_id)) };
}

const ACTOR = { actor: 'settlement', reason: 'Lost bet — cycle result' };

describePg('lost bets settled a page at a time', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('writes exactly the rows single settlements write, for players with one stake and with several', async () => {
    // Two identical worlds: A settled bet by bet, B as one page.
    const build = async () => {
      const c = await cycle();
      const p1 = await player();
      const p2 = await player();
      const bets = [await bet(p1, c), await bet(p2, c), await bet(p1, c, [{ field: 'depositBalance', amountPaise: 2_500 }])];
      return { players: [p1, p2], bets };
    };
    const A = await build();
    const B = await build();

    for (const b of A.bets) expect((await loseBet({ ...b, ...ACTOR })).ok).toBe(true);
    const page = await loseBets(B.bets, ACTOR);
    expect(page.ok).toBe(true);
    expect(page.batched).toBe(true);
    expect(page.results.map((r) => [r.ok, r.idempotent, r.bet.status])).toEqual(B.bets.map(() => [true, false, 'LOST']));

    // The wallets: each player's pockets and locks exactly as the single path left them.
    for (let i = 0; i < 2; i += 1) {
      expect(await getBalancesPaise(B.players[i])).toEqual(await getBalancesPaise(A.players[i]));
    }
    // Every row, field by field. Treasury balances are compared as a chain
    // (the second world posts after the first, so its absolute balances are
    // higher); everything else must be identical.
    const a = await written(A.bets.map((b) => b.betId));
    const b = await written(B.bets.map((x) => x.betId));
    expect(b.ledger).toEqual(a.ledger);
    expect(b.transitions).toEqual(a.transitions);
    expect(b.bets).toEqual(a.bets);
    const shape = (rows) => rows.map(({ balance_before_paise: _b, balance_after_paise: _a, ...rest }) => rest);
    expect(shape(b.entries)).toEqual(shape(a.entries));
    expect(b.entries).toHaveLength(6);

    // Each treasury account's entries chain without a gap, and the account
    // stands where its chain ends.
    for (const account of ['HOUSE_RESERVE', 'USER_FLOAT']) {
      const rows = b.entries.filter((e) => e.account === account);
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i].balance_before_paise).toBe(rows[i - 1].balance_after_paise);
      }
      for (const r of rows) {
        expect(Number(r.balance_after_paise)).toBe(Number(r.balance_before_paise) + Number(r.amount_paise));
      }
    }
    // The player with two stakes: two ledger rows, the second starting where the first ended.
    const p1Rows = b.ledger.filter((r) => r.tx_id === '#0_lose' || r.tx_id === '#2_lose');
    expect(p1Rows[1].balance_before_paise).toBe(p1Rows[0].balance_after_paise);
  });

  it('a replayed page writes nothing and answers every bet as already settled', async () => {
    const c = await cycle();
    const u = await player();
    const bets = [await bet(u, c), await bet(u, c)];
    expect((await loseBets(bets, ACTOR)).batched).toBe(true);
    const before = await written(bets.map((b) => b.betId));
    const wallet = await getBalancesPaise(u);

    const again = await loseBets(bets, ACTOR);
    expect(again.ok).toBe(true);
    expect(again.batched).toBe(false);
    expect(again.results.map((r) => [r.ok, r.idempotent])).toEqual([[true, true], [true, true]]);
    expect(await written(bets.map((b) => b.betId))).toEqual(before);
    expect(await getBalancesPaise(u)).toEqual(wallet);
  });

  it('a page holding one bet it cannot batch settles the rest and refuses that one alone', async () => {
    const c = await cycle();
    const u = await player();
    const other = await player();
    const good = [await bet(u, c), await bet(u, c)];
    const stranger = await bet(other, c);
    // Named under the wrong player: the owner comes from the row (trap 2).
    const page = await loseBets([good[0], { ...stranger, userId: u }, good[1]], ACTOR);
    expect(page.ok).toBe(true);
    expect(page.batched).toBe(false);
    expect(page.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(page.results[1].reason).toBe('wrong_owner');

    const rows = (await pgQuery(`SELECT bet_id, status FROM bets WHERE bet_id = ANY($1)`,
      [[...good.map((b) => b.betId), stranger.betId]])).rows;
    const status = Object.fromEntries(rows.map((r) => [r.bet_id, r.status]));
    expect(status[good[0].betId]).toBe('LOST');
    expect(status[good[1].betId]).toBe('LOST');
    expect(status[stranger.betId]).toBe('PENDING');
    expect((await getBalancesPaise(other)).lockedBalance).toBe(5_000);
  });

  it('a GENERAL cycle is settled bet by bet, so each lost stake still counts as turnover', async () => {
    const u = next('g');
    await pgQuery(`INSERT INTO users (user_id, username, mobile) VALUES ($1, $1, $2)`,
      [u, `8${String(Date.now() + seq).slice(-9)}`]);
    await promo.creditReferralBonus({ userId: u, amountPaise: 10_000, earningId: `${u}-e1` });
    const c = await cycle('GENERAL');
    const gen = [{ field: 'promoBalance', amountPaise: 2_000 }];
    const bets = [await bet(u, c, gen), await bet(u, c, gen)];

    const page = await loseBets(bets, ACTOR);
    expect(page.ok).toBe(true);
    expect(page.batched).toBe(false);
    expect(page.results.every((r) => r.ok && !r.idempotent)).toBe(true);
    expect((await promo.promoSummary(u)).grants[0].turnoverPaise).toBe(4_000);
  });

  it('a single settlement racing the page for the same bet: each stake is consumed once', async () => {
    const c = await cycle();
    const u = await player();
    const v = await player();
    const bets = [await bet(u, c), await bet(v, c), await bet(u, c)];
    const lockedBefore = (await getBalancesPaise(u)).lockedBalance + (await getBalancesPaise(v)).lockedBalance;

    const [page, single] = await Promise.all([loseBets(bets, ACTOR), loseBet({ ...bets[1], ...ACTOR })]);
    expect(page.ok).toBe(true);
    expect(single.ok).toBe(true);
    expect(page.results.every((r) => r.ok)).toBe(true);

    const w = await written(bets.map((b) => b.betId));
    expect(w.ledger).toHaveLength(3);
    expect(w.entries).toHaveLength(6);
    expect(w.transitions).toHaveLength(3);
    const lockedAfter = (await getBalancesPaise(u)).lockedBalance + (await getBalancesPaise(v)).lockedBalance;
    expect(lockedBefore - lockedAfter).toBe(15_000);
  });
});
