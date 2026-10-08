// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * boardsPg.test.js — boards as rows (owner, 2026-10-08: admins create any
 * number of board games, each with its own timer, and order the home page).
 *
 * Asserted against the database: the three original boards as they were
 * configured; that the schema refuses a board the engine cannot run, for every
 * writer; that the repository says which field is wrong; that the order is
 * all-or-nothing; and that the generator runs an admin-created board on its own
 * timer and stops starting rounds when it is switched off.
 *
 * Every board this file creates is switched off in `afterAll` (boards are
 * never deleted), so a generator started on this database does not run them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt } from 'node:crypto';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import * as boards from '../repositories/boards.js';
import { currentCycleWithPools } from '../repositories/markets.js';
import CycleGenerator from '../../backend/domains/markets/cycleGenerator.service.js';
import { invalidateBoards } from '../../backend/domains/markets/cycleTypes.js';
import { actor } from '../../backend/tests/routes/_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const PHASES = { mergeBeforeEndSec: 40, equalizerBeforeEndSec: 30, closeBeforeEndSec: 20, celebrateBeforeEndSec: 5 };
const uniqueName = (tag) => `${tag} ${randomInt(0, 1e9)}`;
const created = [];
const make = async (over = {}) => {
  const b = await boards.createBoard({
    name: uniqueName('Tb'), kind: 'INTERVAL', durationMin: 5, phases: PHASES, minBet: 10, maxBet: 1000, ...over,
  });
  created.push(b.key);
  return b;
};

/** A raw INSERT, as any writer could send it: the schema is what refuses. */
const rawInsert = (cols) => pgQuery(
  `INSERT INTO boards (board_key, name, kind, duration_min, anchor_hour_ist, merge_sec, equalizer_sec,
                       close_sec, celebrate_sec, min_bet_paise, max_bet_paise, id_prefix, enabled)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false)`,
  [cols.key, cols.name ?? 'Raw', cols.kind ?? 'INTERVAL', cols.duration ?? 5, cols.anchor ?? null,
    cols.merge ?? 40, cols.eq ?? 30, cols.close ?? 20, cols.celebrate ?? 5,
    cols.min ?? 1000, cols.max ?? 2000, cols.prefix ?? cols.key.replace(/_/g, '')],
);

describePg('boards', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => {
    if (created.length) {
      await pgQuery('UPDATE boards SET enabled = false WHERE board_key = ANY($1)', [created]).catch(() => {});
    }
    await closePg();
  });

  describe('the three original boards, as they were configured', () => {
    it('keeps their timers, phases and stakes', async () => {
      const byKey = Object.fromEntries((await boards.listBoards()).map((b) => [b.key, b]));
      expect(byKey['1_MIN']).toMatchObject({
        kind: 'INTERVAL', durationMin: 1, idPrefix: '1MIN', minBet: 10, maxBet: 100000,
        phases: { mergeBeforeEndSec: 12, equalizerBeforeEndSec: 9, closeBeforeEndSec: 5, celebrateBeforeEndSec: 3 },
      });
      expect(byKey['30_MIN']).toMatchObject({
        kind: 'INTERVAL', durationMin: 30, idPrefix: '30MIN',
        phases: { mergeBeforeEndSec: 180, equalizerBeforeEndSec: 120, closeBeforeEndSec: 30, celebrateBeforeEndSec: 10 },
      });
      expect(byKey.FULL_DAY).toMatchObject({
        kind: 'DAILY', durationMin: 1440, anchorHourIst: 18, idPrefix: 'FULLDAY', minBet: 100, maxBet: 500000,
        phases: { mergeBeforeEndSec: 300, equalizerBeforeEndSec: 120, closeBeforeEndSec: 30, celebrateBeforeEndSec: 10 },
      });
    });
  });

  describe('the schema refuses a board the engine cannot run, from any writer', () => {
    const key = () => `RAW_${randomInt(0, 1e9)}`;
    it.each([
      ['a duration that does not tile the hour', { duration: 7 }, 'boards_timer_runs'],
      ['a daily board with no start hour', { kind: 'DAILY', duration: 1440, merge: 300, eq: 120, close: 30, celebrate: 10 }, 'boards_timer_runs'],
      ['phases out of order', { eq: 45 }, 'boards_phases_ordered'],
      ['a merge before the round begins', { duration: 1, merge: 60, eq: 30, close: 20, celebrate: 5 }, 'boards_phases_ordered'],
      ['a minimum above the maximum', { min: 5000, max: 2000 }, 'boards_stakes'],
      ['a mobile number in the name', { name: 'Call 9876543210' }, 'boards_name_not_a_mobile'],
    ])('%s', async (_label, cols, constraint) => {
      const k = key();
      try {
        await expect(rawInsert({ key: k, ...cols })).rejects.toMatchObject({ code: '23514', constraint });
      } finally {
        await pgQuery('DELETE FROM boards WHERE board_key = $1', [k]);
      }
    });

    it('never changes a board\'s key, kind or id prefix', async () => {
      const b = await make();
      await expect(pgQuery(`UPDATE boards SET kind = 'DAILY' WHERE board_key = $1`, [b.key]))
        .rejects.toMatchObject({ constraint: 'boards_identity_fixed' });
      await expect(pgQuery(`UPDATE boards SET id_prefix = 'ZZ' WHERE board_key = $1`, [b.key]))
        .rejects.toMatchObject({ constraint: 'boards_identity_fixed' });
    });

    it('runs every cycle on a board that exists, and never deletes a board with cycles', async () => {
      await expect(pgQuery(
        `INSERT INTO cycles (cycle_id, cycle_type, status, start_time, end_time)
         VALUES ($1, 'NO_SUCH_BOARD', 'OPEN', now(), now() + interval '1 minute')`, [`x-${randomInt(0, 1e9)}`],
      )).rejects.toMatchObject({ code: '23503', constraint: 'cycles_board_fk' });
      await expect(pgQuery(`DELETE FROM boards WHERE board_key = '30_MIN'`, []))
        .rejects.toMatchObject({ code: '23503' });
    });

    it('lets phantom access name any board, and nothing else', async () => {
      const b = await make();
      const { userId } = await actor({});
      await pgQuery('UPDATE users SET phantom_access = $2 WHERE user_id = $1', [userId, b.key]);
      await pgQuery(`UPDATE users SET phantom_access = 'BOTH' WHERE user_id = $1`, [userId]);
      await expect(pgQuery(`UPDATE users SET phantom_access = 'NO_SUCH_BOARD' WHERE user_id = $1`, [userId]))
        .rejects.toMatchObject({ constraint: 'users_phantom_access_check' });
    });
  });

  describe('the repository', () => {
    it('derives the key and prefix from the name and puts a new board last', async () => {
      const before = await boards.listBoards();
      const name = uniqueName('Five minute!');
      const b = await make({ name });
      expect(b.key).toBe(boards.keyFromName(name));
      expect(b.key).toMatch(/^FIVE_MINUTE_\d+$/);
      expect(b.idPrefix).toBe(b.key.replace(/_/g, '').slice(0, 12));
      expect(b.homeOrder).toBe(Math.max(...before.map((x) => x.homeOrder)) + 1);
      expect(b).toMatchObject({ minBetPaise: 1000, maxBetPaise: 100000, enabled: true });
    });

    it('says which field is wrong, as a 400', async () => {
      const cases = [
        [{ durationMin: 7 }, /tile the hour/],
        [{ kind: 'DAILY', anchorHourIst: 24 }, /whole hour, 0 to 23/],
        [{ phases: { ...PHASES, closeBeforeEndSec: 35 } }, /strictly decrease/],
        [{ durationMin: 1, phases: { ...PHASES, mergeBeforeEndSec: 70 } }, /less than 60 seconds/],
        [{ minBet: 500, maxBet: 100 }, /minimum bet cannot be above/],
        [{ minBet: 10.5 }, /whole number of rupees/],
        [{ name: '   ' }, /1 to 40 characters/],
        [{ kind: 'WEEKLY' }, /INTERVAL \(repeating\) or DAILY/],
      ];
      for (const [over, message] of cases) {
        const err = await boards.createBoard({
          name: uniqueName('Bad'), kind: 'INTERVAL', durationMin: 5, phases: PHASES, minBet: 10, maxBet: 1000, ...over,
        }).catch((e) => e);
        expect(err, JSON.stringify(over)).toBeInstanceOf(Error);
        expect(err.status, JSON.stringify(over)).toBe(400);
        expect(err.message, JSON.stringify(over)).toMatch(message);
      }
    });

    it('refuses a second board with the same name as 409', async () => {
      const b = await make();
      const err = await boards.createBoard({
        name: b.name, kind: 'INTERVAL', durationMin: 5, phases: PHASES, minBet: 10, maxBet: 1000,
      }).catch((e) => e);
      expect(err).toMatchObject({ status: 409, code: 'BOARD_EXISTS' });
    });

    it('edits a board as one whole, checked against the merged result', async () => {
      const b = await make();
      // Valid alone, invalid on this 5-minute board: the merge falls before the round.
      const err = await boards.updateBoard(b.key, { phases: { mergeBeforeEndSec: 300 } }).catch((e) => e);
      expect(err).toMatchObject({ status: 400 });
      expect((await boards.getBoard(b.key)).phases).toEqual(PHASES);

      const after = await boards.updateBoard(b.key, { durationMin: 10, minBet: 20, enabled: false, name: `${b.name} x` });
      expect(after).toMatchObject({ durationMin: 10, minBet: 20, enabled: false, name: `${b.name} x`, key: b.key });
      await expect(boards.updateBoard(b.key, { kind: 'DAILY' })).rejects.toMatchObject({ status: 400 });
      expect(await boards.updateBoard('NO_SUCH_BOARD', { minBet: 20 })).toBeNull();
    });

    it('orders the home page all-or-nothing', async () => {
      const all = (await boards.listBoards()).map((b) => b.key);
      try {
        const reversed = [...all].reverse();
        const out = await boards.setHomeOrder(reversed);
        expect(out.map((b) => b.key)).toEqual(reversed);
        expect(out.map((b) => b.homeOrder)).toEqual(reversed.map((_, i) => i));

        for (const bad of [all.slice(1), [...all, all[0]], [...all.slice(1), 'NO_SUCH_BOARD']]) {
          await expect(boards.setHomeOrder(bad)).rejects.toMatchObject({ status: 400, code: 'INVALID_BOARD_ORDER' });
        }
        expect((await boards.listBoards()).map((b) => b.key)).toEqual(reversed);
      } finally {
        await boards.setHomeOrder(all);
      }
    });
  });

  describe('the generator runs a board on its own row', () => {
    const gen = () => new CycleGenerator(null, null);

    it('tiles the hour by the board\'s duration, and starts a daily board at its own hour', () => {
      const g = gen();
      // 10:47:30 IST.
      const now = new Date(Date.UTC(2026, 9, 8, 5, 17, 30));
      const five = g.blockFor({ kind: 'INTERVAL', durationMin: 5 }, now);
      expect(five.startTime.toISOString()).toBe('2026-10-08T05:15:00.000Z');   // 10:45 IST
      expect(five.endTime.toISOString()).toBe('2026-10-08T05:20:00.000Z');
      const twenty = g.blockFor({ kind: 'INTERVAL', durationMin: 20 }, now);
      expect(twenty.startTime.toISOString()).toBe('2026-10-08T05:10:00.000Z'); // 10:40 IST
      // Before 12:00 IST: the round began yesterday at 12:00 IST (06:30 UTC).
      const noon = g.blockFor({ kind: 'DAILY', durationMin: 1440, anchorHourIst: 12 }, now);
      expect(noon.startTime.toISOString()).toBe('2026-10-07T06:30:00.000Z');
      // From 09:00 IST: today's.
      const nine = g.blockFor({ kind: 'DAILY', durationMin: 1440, anchorHourIst: 9 }, now);
      expect(nine.startTime.toISOString()).toBe('2026-10-08T03:30:00.000Z');
      expect(nine.endTime.toISOString()).toBe('2026-10-09T03:30:00.000Z');
    });

    it('opens a round on a new board with its own length and prefix, and none once it is switched off', async () => {
      const b = await make({ durationMin: 2, phases: { mergeBeforeEndSec: 30, equalizerBeforeEndSec: 20, closeBeforeEndSec: 10, celebrateBeforeEndSec: 3 } });
      invalidateBoards();
      const g = gen();
      await g.ensureActiveCycle(b.key, 'VIP');
      const c = await currentCycleWithPools(b.key, 'VIP');
      expect(c, 'no round opened on the new board').toBeTruthy();
      expect(c.cycleId.startsWith(`${b.idPrefix}_`)).toBe(true);
      expect(new Date(c.endTime) - new Date(c.startTime)).toBe(2 * 60_000);

      await g.ensureActiveCycle(b.key, 'GENERAL');
      const gc = await currentCycleWithPools(b.key, 'GENERAL');
      expect(gc.cycleId.startsWith(`${b.idPrefix}_G_`)).toBe(true);

      const off = await make();
      await boards.updateBoard(off.key, { enabled: false });
      invalidateBoards();
      await g.ensureActiveCycle(off.key, 'VIP');
      expect(await currentCycleWithPools(off.key, 'VIP')).toBeNull();

      await pgQuery(`UPDATE cycles SET status = 'CLOSED' WHERE cycle_type = $1 AND status = 'OPEN'`, [b.key]);
    });
  });
});
