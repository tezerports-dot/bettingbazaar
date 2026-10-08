// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * POST /api/bet/place — the platform's hottest money route, through a real
 * database.
 *
 * It had no route test at all: the repository's `placeBet` was proven, and the
 * route that decides WHICH limits apply and what happens when the cycle closes
 * underneath a bet was reached only by the e2e and browser passes, one request
 * at a time. Two defects lived there (R6, 2026-09-30):
 *
 *   1. The stake limits were chosen from the `type` in the REQUEST BODY, not
 *      the cycle's own type. A full-day bet (floor ₹100) went through at ₹10 by
 *      saying `type: "30_MIN"`, and a 30-minute bet reached the full-day
 *      ceiling by saying `FULL_DAY`.
 *   2. A cycle closing between the debit and the pool check DELETED the bet and
 *      then refunded the stake in a SECOND transaction whose failure was
 *      swallowed. The player was told "Your balance has been fully restored"
 *      either way; when the refund failed, the bet was gone and the stake stayed
 *      locked against nothing. The comment claiming reconciliation would catch
 *      it named a function nothing calls.
 *
 * The close is FORCED, not hoped for: the test holds the player's wallet row,
 * the request parks on it inside `placeBet`, the cycle is closed, and the lock
 * is released — so the route sees a committed stake on a closed cycle every
 * time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt } from 'node:crypto';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { ensureCycle } from '#db/repositories/markets.js';
import { listBoards, createBoard, updateBoard } from '#db/repositories/boards.js';
import { invalidateBoards } from '../../domains/markets/cycleTypes.js';
import { getBalances } from '../../domains/wallet/walletAuthority.service.js';
// Funded from the platform's own holding, posted with the credit: a wallet
// that gains tokens from nowhere does not commit.
import { fundWallet } from '#db/tests/_funding.js';
import { actor, mountRouter, as } from './_harness.js';
import { linkTelegram } from '../miniAppFixture.js';
import { accept as acceptBoardRules } from '#db/repositories/boardRules.js';
import * as promo from '#db/repositories/promo.js';
import { BOARD_RULES_VERSION } from '../../domains/markets/boardRules.js';

const describePg = pgConfigured() ? describe : describe.skip;

const HOUR = 3_600_000;

/** A cycle of this type running now, at a start time nothing else holds. */
async function openCycle(type, { startedAgoMs, lengthMs, audience = 'VIP' }) {
  const start = new Date(Date.now() - startedAgoMs - randomInt(0, 50_000_000));
  const { cycle } = await ensureCycle({
    cycleId: `rt-bet-${type}-${start.getTime()}`, cycleType: type, audience,
    startTime: start, endTime: new Date(Date.now() + lengthMs),
  });
  return cycle;
}

async function waitForLockWaiters(n) {
  for (let i = 0; i < 200; i += 1) {
    const { rows } = await pgQuery(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`, []);
    if (rows[0].n >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no request parked on the wallet lock within 5s`);
}

describePg('POST /api/bet/place', () => {
  let app;
  let limits;
  const made = [];

  const fundedPlayer = async (rupees, { boardRules = true } = {}) => {
    const p = await actor({ boardRules });
    await linkTelegram(p.userId);
    await fundWallet(p.userId, rupees * 100, `rt-bet-fund-${p.userId}`);
    return p;
  };
  const place = (who, body, key = `k-${Math.random().toString(36).slice(2)}`) =>
    as(app, who).post('/place').set('Idempotency-Key', key).send(body);

  beforeAll(async () => {
    await applySchema();
    const router = (await import('../../domains/markets/bet.routes.js')).default;
    app = mountRouter(router);
    // Each board's own stake bounds (the `boards` row).
    const byKey = Object.fromEntries((await listBoards()).map((b) => [b.key, { min: b.minBet, max: b.maxBet }]));
    limits = { fullDay: byKey.FULL_DAY, thirtyMin: byKey['30_MIN'] };
  }, 60_000);

  afterAll(async () => {
    // Cycles this file opened are closed, outside any assertion (trap 10): a
    // generator started against this database must not find them OPEN.
    if (made.length) {
      await pgQuery(`UPDATE cycles SET status = 'CLOSED' WHERE cycle_id = ANY($1) AND status IN ('OPEN','MERGED')`, [made]).catch(() => {});
    }
    await pgQuery(`DROP TRIGGER IF EXISTS rt_bet_refund_fails ON wallet_ledger`, []).catch(() => {});
    await pgQuery(`DROP FUNCTION IF EXISTS rt_bet_refund_fails()`, []).catch(() => {});
    await closePg();
  });

  describe('the stake limits are the CYCLE\'s, whatever the body says', () => {
    it('refuses a full-day stake under the full-day floor, sent as a 30-minute bet', async () => {
      const stake = limits.fullDay.min - 10;
      expect(stake, 'the live config must leave a stake the two floors disagree on').toBeGreaterThanOrEqual(limits.thirtyMin.min);
      const cycle = await openCycle('FULL_DAY', { startedAgoMs: HOUR, lengthMs: 20 * HOUR });
      made.push(cycle.cycleId);
      const p = await fundedPlayer(1_000);

      const res = await place(p, { cycleId: cycle.cycleId, side: 'DELHI', amount: stake, type: '30_MIN' });

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      const { rows } = await pgQuery(`SELECT count(*)::int AS n FROM bets WHERE user_id = $1`, [p.userId]);
      expect(rows[0].n).toBe(0);
    });

    it('refuses a 30-minute stake over the 30-minute ceiling, sent as a full-day bet', async () => {
      const stake = limits.thirtyMin.max + 10;
      expect(stake, 'the live config must leave a stake the two ceilings disagree on').toBeLessThanOrEqual(limits.fullDay.max);
      const cycle = await openCycle('30_MIN', { startedAgoMs: 60_000, lengthMs: 25 * 60_000 });
      made.push(cycle.cycleId);
      const p = await fundedPlayer(stake * 2);

      const res = await place(p, { cycleId: cycle.cycleId, side: 'BOMBAY', amount: stake, type: 'FULL_DAY' });

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      const { rows } = await pgQuery(`SELECT count(*)::int AS n FROM bets WHERE user_id = $1`, [p.userId]);
      expect(rows[0].n).toBe(0);
    });

    it('still takes a stake the cycle\'s own limits allow', async () => {
      const cycle = await openCycle('FULL_DAY', { startedAgoMs: HOUR, lengthMs: 20 * HOUR });
      made.push(cycle.cycleId);
      const p = await fundedPlayer(1_000);
      const res = await place(p, { cycleId: cycle.cycleId, side: 'DELHI', amount: limits.fullDay.min, type: 'FULL_DAY' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
  });

  describe('a board an admin created runs on its own row', () => {
    // One board per run (boards are never deleted); switched off afterwards so
    // no generator started on this database runs it.
    let board;
    beforeAll(async () => {
      board = await createBoard({
        name: `Rt bet ${randomInt(0, 1e9)}`, kind: 'INTERVAL', durationMin: 5,
        phases: { mergeBeforeEndSec: 40, equalizerBeforeEndSec: 30, closeBeforeEndSec: 20, celebrateBeforeEndSec: 5 },
        minBet: 50, maxBet: 500,
      });
      invalidateBoards();
    });
    afterAll(async () => {
      await updateBoard(board.key, { enabled: false }).catch(() => {});
      invalidateBoards();
    });

    it('holds a stake to the board\'s own bounds', async () => {
      const cycle = await openCycle(board.key, { startedAgoMs: 60_000, lengthMs: 4 * 60_000 });
      made.push(cycle.cycleId);
      const p = await fundedPlayer(2_000);
      const low = await place(p, { cycleId: cycle.cycleId, side: 'DELHI', amount: 40 });
      expect(low.status, JSON.stringify(low.body)).toBe(400);
      const high = await place(p, { cycleId: cycle.cycleId, side: 'DELHI', amount: 510 });
      expect(high.status, JSON.stringify(high.body)).toBe(400);
      const ok = await place(p, { cycleId: cycle.cycleId, side: 'DELHI', amount: 50 });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    });

    it('closes betting on the board\'s own close offset, whatever the status says', async () => {
      // 15s before the end: inside this board's 20s close, while the row still reads OPEN.
      const cycle = await openCycle(board.key, { startedAgoMs: 60_000, lengthMs: 15_000 });
      made.push(cycle.cycleId);
      const p = await fundedPlayer(1_000);
      const res = await place(p, { cycleId: cycle.cycleId, side: 'DELHI', amount: 50 });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.code).toBe('BETTING_CLOSED');
    });

    it('takes no new bet once the board is switched off, and takes nothing', async () => {
      const cycle = await openCycle(board.key, { startedAgoMs: 60_000, lengthMs: 4 * 60_000 });
      made.push(cycle.cycleId);
      const p = await fundedPlayer(1_000);
      await updateBoard(board.key, { enabled: false });
      invalidateBoards();
      try {
        const res = await place(p, { cycleId: cycle.cycleId, side: 'DELHI', amount: 50 });
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(res.body.code).toBe('BOARD_SWITCHED_OFF');
        const { rows } = await pgQuery(`SELECT count(*)::int AS n FROM bets WHERE user_id = $1`, [p.userId]);
        expect(rows[0].n).toBe(0);
      } finally {
        await updateBoard(board.key, { enabled: true });
        invalidateBoards();
      }
      // Switched back on, the same round takes the bet: the refusal was the switch.
      const ok = await place(p, { cycleId: cycle.cycleId, side: 'DELHI', amount: 50 });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    });
  });

  describe('the board rules are read and accepted before a first bet', () => {
    it('refuses a player who has not accepted them, takes nothing, and takes the bet once they have', async () => {
      const cycle = await openCycle('FULL_DAY', { startedAgoMs: HOUR, lengthMs: 20 * HOUR });
      made.push(cycle.cycleId);
      const p = await fundedPlayer(1_000, { boardRules: false });
      const body = { cycleId: cycle.cycleId, side: 'DELHI', amount: limits.fullDay.min, type: 'FULL_DAY' };
      const before = await getBalances(p.userId);

      const refused = await place(p, body);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe('BOARD_RULES_NOT_ACCEPTED');
      const { rows } = await pgQuery(`SELECT count(*)::int AS n FROM bets WHERE user_id = $1`, [p.userId]);
      expect(rows[0].n).toBe(0);
      const after = await getBalances(p.userId);
      expect(after.depositBalance).toBe(before.depositBalance);
      expect(after.lockedBalance).toBe(before.lockedBalance);

      await acceptBoardRules(p.userId, BOARD_RULES_VERSION);
      const taken = await place(p, body);
      expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    });

    it('refuses a player who accepted an OLDER version of the rules', async () => {
      const cycle = await openCycle('FULL_DAY', { startedAgoMs: HOUR, lengthMs: 20 * HOUR });
      made.push(cycle.cycleId);
      const p = await fundedPlayer(1_000, { boardRules: false });
      await pgQuery('UPDATE users SET board_rules_version = $2 WHERE user_id = $1', [p.userId, BOARD_RULES_VERSION - 1]);
      const res = await place(p, { cycleId: cycle.cycleId, side: 'BOMBAY', amount: limits.fullDay.min, type: 'FULL_DAY' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BOARD_RULES_NOT_ACCEPTED');
    });
  });

  describe('VIP and GENERAL players never share a board (owner, 2026-10-08)', () => {
    const generalPlayer = async (bonusPaise) => {
      const p = await actor({});
      await linkTelegram(p.userId);
      await promo.creditReferralBonus({ userId: p.userId, amountPaise: bonusPaise, earningId: `${p.userId}-ref` });
      await promo.setPlayProfile(p.userId, 'GENERAL');
      return p;
    };

    it('takes a GENERAL player\'s stake from the General balance on a GENERAL board', async () => {
      const cycle = await openCycle('FULL_DAY', { startedAgoMs: HOUR, lengthMs: 20 * HOUR, audience: 'GENERAL' });
      made.push(cycle.cycleId);
      const p = await generalPlayer(limits.fullDay.min * 100 * 2);
      const res = await place(p, { cycleId: cycle.cycleId, side: 'DELHI', amount: limits.fullDay.min, type: 'FULL_DAY' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.balance.general).toBe(limits.fullDay.min);
      const after = await getBalances(p.userId);
      expect(after.depositBalance).toBe(0);
      expect(after.lockedBalance).toBe(limits.fullDay.min);
    });

    it('refuses a GENERAL player on a VIP board, and a VIP player on a GENERAL board, moving nothing', async () => {
      const vipBoard = await openCycle('FULL_DAY', { startedAgoMs: HOUR, lengthMs: 20 * HOUR });
      const generalBoard = await openCycle('FULL_DAY', { startedAgoMs: HOUR, lengthMs: 20 * HOUR, audience: 'GENERAL' });
      made.push(vipBoard.cycleId, generalBoard.cycleId);

      const g = await generalPlayer(100_000);
      const r1 = await place(g, { cycleId: vipBoard.cycleId, side: 'DELHI', amount: limits.fullDay.min, type: 'FULL_DAY' });
      expect(r1.status).toBe(409);
      expect(r1.body.code).toBe('WRONG_PROFILE_FOR_CYCLE');
      // Told what to do about it (S14), not that something changed mid-bet.
      expect(r1.body.message).toMatch(/Switch to VIP ID/);

      const v = await fundedPlayer(1_000);
      const r2 = await place(v, { cycleId: generalBoard.cycleId, side: 'DELHI', amount: limits.fullDay.min, type: 'FULL_DAY' });
      expect(r2.status).toBe(409);
      expect(r2.body.code).toBe('WRONG_PROFILE_FOR_CYCLE');
      expect(r2.body.message).toMatch(/Switch to General/);

      const { rows } = await pgQuery(`SELECT count(*)::int AS n FROM bets WHERE user_id = ANY($1)`, [[g.userId, v.userId]]);
      expect(rows[0].n).toBe(0);
    });

    it('refuses a GENERAL stake larger than the General balance, whatever else the wallet holds', async () => {
      const cycle = await openCycle('FULL_DAY', { startedAgoMs: HOUR, lengthMs: 20 * HOUR, audience: 'GENERAL' });
      made.push(cycle.cycleId);
      const p = await generalPlayer(limits.fullDay.min * 100);
      await fundWallet(p.userId, 1_000_000, `rt-bet-gen-dep-${p.userId}`);
      const res = await place(p, { cycleId: cycle.cycleId, side: 'DELHI', amount: limits.fullDay.min * 2, type: 'FULL_DAY' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('STAKE_EXCEEDS_FUNDABLE');
    });
  });

  describe('a cycle that closes after the stake is taken', () => {
    /** Park a bet on the wallet lock, close the cycle under it, then let it go. */
    async function placeAcrossTheClose(p, cycle, amount) {
      let release;
      const released = new Promise((r) => { release = r; });
      const holder = withTransaction(async (client) => {
        await client.query(`SELECT 1 FROM wallets WHERE user_id = $1 FOR UPDATE`, [p.userId]);
        await released;
      });
      // Let the holder take the lock before the request arrives.
      await new Promise((r) => setTimeout(r, 100));
      const pending = place(p, { cycleId: cycle.cycleId, side: 'DELHI', amount, type: '30_MIN' });
      const responded = pending.then((r) => r);
      await waitForLockWaiters(1);
      await pgQuery(`UPDATE cycles SET status = 'CLOSED' WHERE cycle_id = $1`, [cycle.cycleId]);
      release();
      await holder;
      return responded;
    }

    it('returns the stake and KEEPS the bet, as REFUNDED, in one transaction', async () => {
      const cycle = await openCycle('30_MIN', { startedAgoMs: 60_000, lengthMs: 25 * 60_000 });
      made.push(cycle.cycleId);
      const p = await fundedPlayer(1_000);
      const before = await getBalances(p.userId);

      const res = await placeAcrossTheClose(p, cycle, 100);

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.message).toMatch(/fully restored/);
      const after = await getBalances(p.userId);
      expect(after.depositBalance).toBe(before.depositBalance);
      expect(after.lockedBalance).toBe(before.lockedBalance);
      // The bet is a record of what happened, not something to erase.
      const { rows } = await pgQuery(`SELECT status FROM bets WHERE user_id = $1 AND cycle_id = $2`, [p.userId, cycle.cycleId]);
      expect(rows.map((r) => r.status)).toEqual(['REFUNDED']);
    });

    it('when the refund FAILS, leaves the bet PENDING with its stake behind it, and does not claim a refund', async () => {
      const cycle = await openCycle('30_MIN', { startedAgoMs: 60_000, lengthMs: 25 * 60_000 });
      made.push(cycle.cycleId);
      const p = await fundedPlayer(1_000);
      const before = await getBalances(p.userId);

      // Any CREDIT to this player's ledger fails — the refund, however it is
      // written. Scoped to one user id, so nothing else in the run is touched.
      await pgQuery(`
        CREATE OR REPLACE FUNCTION rt_bet_refund_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.user_id = '${p.userId}' AND NEW.tx_type = 'CREDIT' THEN
            RAISE EXCEPTION 'injected refund failure';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`, []);
      await pgQuery(`DROP TRIGGER IF EXISTS rt_bet_refund_fails ON wallet_ledger`, []);
      await pgQuery(`CREATE TRIGGER rt_bet_refund_fails BEFORE INSERT ON wallet_ledger
                      FOR EACH ROW EXECUTE FUNCTION rt_bet_refund_fails()`, []);
      let res;
      try {
        res = await placeAcrossTheClose(p, cycle, 100);
      } finally {
        await pgQuery(`DROP TRIGGER IF EXISTS rt_bet_refund_fails ON wallet_ledger`, []);
      }

      // Not "your balance has been fully restored" — it was not.
      expect(res.body.message ?? '').not.toMatch(/fully restored/);
      // The stake is still behind a live bet, which settlement will resolve.
      // Deleting the bet first would leave ₹100 locked against nothing.
      const { rows } = await pgQuery(`SELECT status, stake_paise FROM bets WHERE user_id = $1 AND cycle_id = $2`, [p.userId, cycle.cycleId]);
      expect(rows.map((r) => r.status)).toEqual(['PENDING']);
      const after = await getBalances(p.userId);
      expect(after.lockedBalance).toBe(before.lockedBalance + 100);
      expect(after.depositBalance).toBe(before.depositBalance - 100);
    });
  });

  describe('POST /api/bet/phantom', () => {
    it('answers 400, not 500, for an amount that is not a number', async () => {
      const agent = await actor({});
      await pgQuery(`UPDATE users SET phantom_access = 'BOTH' WHERE user_id = $1`, [agent.userId]);
      const cycle = await openCycle('30_MIN', { startedAgoMs: 60_000, lengthMs: 25 * 60_000 });
      made.push(cycle.cycleId);
      const res = await as(app, agent).post('/phantom').send({ cycleId: cycle.cycleId, side: 'DELHI', amount: 'lots' });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      const { rows } = await pgQuery(`SELECT count(*)::int AS n FROM bets WHERE user_id = $1`, [agent.userId]);
      expect(rows[0].n).toBe(0);
    });
  });
});
