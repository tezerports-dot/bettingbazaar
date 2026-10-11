// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The resolved-history feed is cached per board and audience
 * (`cycleHistory.service.js` `historyForType`), and the cache must never serve
 * a feed that is older than the database.
 *
 * Why it is cached: every stream open asks for it, and each read sums every
 * listed cycle's bets — 1.15 s of database time per open on 100k players / 2M
 * bets, which left the server unresponsive for minutes when 500 players
 * connected together. Why this test: a cache is only safe if the two writes
 * that change a resolved row — a new result, and a settlement moving a row to
 * COMPLETED — both rebuild it. These cases run against real PostgreSQL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { ensureCycle, declareWinner, markSettled, resolvedHistoryVersion } from '../repositories/markets.js';
import { fetchCycleHistory } from '../../backend/domains/markets/cycleHistory.service.js';

const describePg = pgConfigured() ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);
// Far in the future, so these rows are the newest resolved history and the
// assertions read them first whatever else this database holds.
let slot = Date.UTC(2101, 0, 1) + Math.floor(Math.random() * 1e6) * 1_800_000;
const ids = [];

async function resolvedCycle(winner) {
  const cycleId = `hc-${RUN}-${ids.length + 1}`;
  ids.push(cycleId);
  const start = new Date(slot); slot += 1_800_000;
  await ensureCycle({ cycleId, cycleType: '30_MIN', audience: 'VIP', startTime: start, endTime: new Date(start.getTime() + 1_800_000) });
  await declareWinner(cycleId, winner);
  return cycleId;
}
const feed = async (limit) => (await fetchCycleHistory({ types: '30_MIN', audience: 'VIP', limit })).cycles;

describePg('the cached resolved-history feed', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => {
    await pgQuery('DELETE FROM cycles WHERE cycle_id = ANY($1::text[])', [ids]).catch(() => {});
    await closePg();
  });

  it('shows a new result on the next read', async () => {
    const first = await resolvedCycle('DELHI');
    expect((await feed(5))[0].id).toBe(first);
    const second = await resolvedCycle('BOMBAY');
    const rows = await feed(5);
    expect(rows[0].id).toBe(second);
    expect(rows[1].id).toBe(first);
  });

  it('shows a settlement moving a row on, though no new result arrived', async () => {
    const id = await resolvedCycle('DELHI');
    expect((await feed(5))[0]).toMatchObject({ id, status: 'RESULT_DECLARED' });
    await markSettled(id, { paidOutRupees: 0, netProfitRupees: 0, platformFeesRupees: 0, feePercentUsed: 0 });
    expect((await feed(5))[0]).toMatchObject({ id, isSettled: true });
  });

  it('serves a shallow window from a deep one, and the same rows either way', async () => {
    const deep = await feed(20);
    const shallow = await feed(3);
    expect(shallow).toEqual(deep.slice(0, 3));
  });

  it('versions on the newest change, and the version moves with a result', async () => {
    const before = await resolvedHistoryVersion('30_MIN', 'VIP');
    await resolvedCycle('BOMBAY');
    const after = await resolvedHistoryVersion('30_MIN', 'VIP');
    expect(after).not.toBe(before);
  });
});
