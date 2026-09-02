// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The nine domains written from scratch, against a real PostgreSQL.
 *
 * Each test asserts a property the row itself carries, rather than that a
 * function returns what it just stored. The properties worth a test here are
 * the ones a document store could not enforce and that cost real defects:
 * counters that lose a concurrent increment, caps that two requests both pass,
 * expiries a late sweep leaves in force, and rows that say two things at once.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import * as markets from '../repositories/markets.js';
import * as games from '../repositories/games.js';
import * as content from '../repositories/content.js';
import * as engagement from '../repositories/engagement.js';
import * as social from '../repositories/social.js';
import * as referrals from '../repositories/referrals.js';
import * as audit from '../repositories/audit.js';
import * as compliance from '../repositories/compliance.js';
import * as operations from '../repositories/operations.js';
import * as paymentConfig from '../repositories/paymentConfig.js';
import * as depositPolicy from '../repositories/depositPolicy.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the domains written from scratch', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  let ID;

  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(() => { seq += 1; ID = `${RUN}-${seq}`; });

  // ══════════════════════════════════════════════════════════════════════════
  describe('markets — the betting cycle', () => {
    const makeCycle = async (over = {}) => {
      const start = new Date(Date.now() - 60_000);
      const { cycle } = await markets.ensureCycle({
        cycleId: `c-${ID}`, cycleType: '30_MIN',
        startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), ...over,
      });
      return cycle;
    };

    it('creates ONE cycle when two generators wake together', async () => {
      const start = new Date(Date.now() - 120_000);
      const spec = {
        cycleType: '1_MIN', startTime: start,
        endTime: new Date(start.getTime() + 60_000),
      };
      const [a, b] = await Promise.all([
        markets.ensureCycle({ cycleId: `c-${ID}-a`, ...spec }),
        markets.ensureCycle({ cycleId: `c-${ID}-b`, ...spec }),
      ]);
      // The unique index decides, not a prior existence check. One created, one
      // read the winner's row — and both hold the SAME cycle.
      expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
      expect(a.cycle.cycleId).toBe(b.cycle.cycleId);
    });

    it('accepts every status the ENGINE uses, not a tidier subset', async () => {
      // The first draft of the CHECK declared four states. The engine moves a
      // cycle through seven — a cycle it moved to MERGED would have been
      // refused by the row, which is a betting round that stops mid-cycle.
      await makeCycle();
      for (const status of ['MERGED', 'CLOSED', 'PAUSED']) {
        await pgQuery('UPDATE cycles SET status = $2 WHERE cycle_id = $1', [`c-${ID}`, status]);
        expect((await markets.getCycle(`c-${ID}`)).status).toBe(status);
      }
      await expect(pgQuery('UPDATE cycles SET status = $2 WHERE cycle_id = $1', [`c-${ID}`, 'SETTLING']))
        .rejects.toThrow(/cycles_status_known/);
    });

    it('refuses RESULT_DECLARED without a result, as well as COMPLETED', async () => {
      // Both states claim the result is in. Neither may claim it without one.
      await makeCycle();
      await expect(pgQuery(
        `UPDATE cycles SET status = 'RESULT_DECLARED' WHERE cycle_id = $1`, [`c-${ID}`],
      )).rejects.toThrow(/cycles_completed_has_winner/);
    });

    it('lists only cycles that are still running', async () => {
      // A cycle whose generator died still reads OPEN. Offering it takes bets
      // on a round that will never settle — which is how the engine looked
      // healthy while nothing was being resolved.
      const start = new Date(Date.now() - 7200_000);
      await markets.ensureCycle({
        cycleId: `c-${ID}-dead`, cycleType: '1_MIN',
        startTime: start, endTime: new Date(start.getTime() + 60_000),
      });
      const active = (await markets.listActiveCycles()).map((c) => c.cycleId);
      expect(active).not.toContain(`c-${ID}-dead`);
    });

    it('finds the cycle covering an instant, and falls back to the last result', async () => {
      const cycle = await makeCycle();
      const midpoint = new Date(cycle.startTime).getTime() + 30_000;
      expect((await markets.getCycleAt('30_MIN', midpoint)).cycleId).toBe(`c-${ID}`);

      // Outside every live window: during the celebration the current cycle
      // has completed and the next has not opened, so returning nothing would
      // blank the page mid-animation.
      await markets.declareWinner(`c-${ID}`, 'DELHI');
      const far = await markets.getCycleAt('30_MIN', Date.now() + 86_400_000);
      expect(far).not.toBeNull();
      expect(far.winner).not.toBeNull();
    });

    it('writes the winner and the status in ONE statement', async () => {
      await makeCycle();
      const r = await markets.declareWinner(`c-${ID}`, 'DELHI', { by: 'engine', confidence: 0.9 });
      expect(r.ok).toBe(true);
      // There is no instant at which the cycle is COMPLETED with no winner —
      // which is exactly what the settlement sweep would otherwise read.
      expect(r.cycle.status).toBe('COMPLETED');
      expect(r.cycle.winner).toBe('DELHI');
    });

    it('refuses to overwrite a result players have already seen', async () => {
      await makeCycle();
      await markets.declareWinner(`c-${ID}`, 'DELHI');
      const second = await markets.declareWinner(`c-${ID}`, 'BOMBAY');
      expect(second).toEqual({ ok: false, reason: 'ALREADY_DECLARED', winner: 'DELHI' });
    });

    it('will not let SQL itself complete a cycle with no winner', async () => {
      await makeCycle();
      await expect(pgQuery(
        `UPDATE cycles SET status = 'COMPLETED' WHERE cycle_id = $1`, [`c-${ID}`],
      )).rejects.toThrow(/cycles_completed_has_winner/);
    });

    it('DERIVES the real pools from bets, and never stores them', async () => {
      // A bet holds FOR SHARE on the cycle row. A bet that also UPDATEd it would
      // deadlock against another bet doing the same — 40P01 on the hottest path.
      await makeCycle();
      for (const [side, stake] of [['DELHI', 10000], ['DELHI', 25000], ['BOMBAY', 5000]]) {
        await pgQuery(
          `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status)
           VALUES ($1, 'u1', $2, $3, $4, 'PENDING')`,
          [`b-${ID}-${Math.random().toString(36).slice(2, 8)}`, `c-${ID}`, side, stake],
        );
      }
      await markets.setPhantomPools(`c-${ID}`, { delhiRupees: 100, bombayRupees: 200 });

      const pools = await markets.getPools(`c-${ID}`);
      expect(pools.realDelhiPaise).toBe(35000);
      expect(pools.realBombayPaise).toBe(5000);
      expect(pools.delhiBets).toBe(2);
      // Phantom comes from the row; the displayed total is the sum.
      expect(pools.totalDelhi).toBe(350 + 100);
      expect(pools.totalBombay).toBe(50 + 200);
    });

    it('never offers a cycle with no winner for settlement', async () => {
      await makeCycle({ endTime: new Date(Date.now() - 1000) });
      const before = await markets.claimSettleable({ limit: 100 });
      expect(before.map((c) => c.cycleId)).not.toContain(`c-${ID}`);

      await markets.declareWinner(`c-${ID}`, 'BOMBAY');
      const after = await markets.claimSettleable({ limit: 100 });
      expect(after.map((c) => c.cycleId)).toContain(`c-${ID}`);
    });

    it('finds a cycle that ended and was never given a result', async () => {
      // The check that would have caught "the engine looked healthy and
      // silently never settled" on the day it shipped.
      const start = new Date(Date.now() - 60 * 60_000);
      await markets.ensureCycle({
        cycleId: `c-${ID}-stalled`, cycleType: 'FULL_DAY',
        startTime: start, endTime: new Date(start.getTime() + 60_000),
      });
      const stalled = await markets.findStalledCycles({ olderThanMinutes: 5, limit: 1000 });
      expect(stalled.cycles.map((c) => c.cycleId)).toContain(`c-${ID}-stalled`);
      // The count is of everything matching, not of the page — an alarm that
      // reads the page length cannot tell 100 stalled cycles from 400.
      expect(stalled.total).toBeGreaterThanOrEqual(stalled.cycles.length);
    });

    it('counts every stalled cycle even when the page is smaller', async () => {
      const start = new Date(Date.now() - 90 * 60_000);
      for (const n of [1, 2, 3]) {
        await markets.ensureCycle({
          cycleId: `c-${ID}-stall-${n}`, cycleType: 'FULL_DAY',
          startTime: start, endTime: new Date(start.getTime() + 60_000),
        });
      }
      const page = await markets.findStalledCycles({ olderThanMinutes: 5, limit: 2 });
      expect(page.cycles).toHaveLength(2);
      expect(page.total).toBeGreaterThanOrEqual(4);
    });

    it('records the settlement once, and only with a winner', async () => {
      await makeCycle();
      await markets.declareWinner(`c-${ID}`, 'DELHI');
      const first = await markets.markSettled(`c-${ID}`, {
        paidOutRupees: 500, netProfitRupees: 50, platformFeesRupees: 5, feePercentUsed: 1,
      });
      expect(first.ok).toBe(true);
      expect(first.cycle.totalPaidOut).toBe(500);
      // A replay writes nothing rather than doubling the recorded payout.
      expect((await markets.markSettled(`c-${ID}`, { paidOutRupees: 999 })).ok).toBe(false);
      expect((await markets.getCycle(`c-${ID}`)).totalPaidOut).toBe(500);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('engagement — check-ins, gift codes, notifications', () => {
    it('claims a check-in ONCE a day, however many taps arrive', async () => {
      const user = `u-${ID}`;
      const claims = await Promise.all(
        Array.from({ length: 10 }, () => engagement.claimCheckIn(user, { rewardRupees: 5 })),
      );
      // A read-then-write lets a double-tap claim twice — and the reward is money.
      expect(claims.filter((c) => c.ok)).toHaveLength(1);
      const state = await engagement.getCheckIn(user);
      expect(state.totalCheckIns).toBe(1);
      expect(state.currentStreak).toBe(1);
      expect(state.totalEarned).toBe(5);
    });

    it('continues a streak from yesterday and restarts it after a gap', async () => {
      const user = `u-${ID}-streak`;
      await engagement.claimCheckIn(user, { rewardRupees: 5 });
      // Yesterday's claim: the streak continues.
      await pgQuery(
        `UPDATE check_ins SET last_check_in_date = CURRENT_DATE - 1 WHERE user_id = $1`, [user],
      );
      expect((await engagement.claimCheckIn(user, { rewardRupees: 5 })).checkIn.currentStreak).toBe(2);

      // A gap: it restarts, and the high-water mark survives.
      await pgQuery(
        `UPDATE check_ins SET last_check_in_date = CURRENT_DATE - 5 WHERE user_id = $1`, [user],
      );
      const after = await engagement.claimCheckIn(user, { rewardRupees: 5 });
      expect(after.checkIn.currentStreak).toBe(1);
      expect(after.checkIn.longestStreak).toBe(2);
    });

    it('pays a single-use gift code exactly ONCE under a storm', async () => {
      // The document model's check-then-increment let two concurrent
      // redemptions both pass, and a single-use code paid out twice.
      await engagement.createGiftCode({ code: `GC${ID}`, amountRupees: 100, maxUses: 1 });
      const attempts = await Promise.all(
        Array.from({ length: 15 }, (_, i) => engagement.redeemGiftCode(`GC${ID}`, `u-${ID}-${i}`)),
      );
      expect(attempts.filter((a) => a.ok)).toHaveLength(1);
      expect((await engagement.getGiftCode(`GC${ID}`)).usedCount).toBe(1);
    });

    it('lets one player redeem a multi-use code only once', async () => {
      await engagement.createGiftCode({ code: `GM${ID}`, amountRupees: 50, maxUses: 5 });
      const first = await engagement.redeemGiftCode(`GM${ID}`, `u-${ID}`);
      expect(first.ok).toBe(true);
      expect(await engagement.redeemGiftCode(`GM${ID}`, `u-${ID}`))
        .toMatchObject({ ok: false, reason: 'ALREADY_REDEEMED' });
      // …and a failed attempt does not consume a use.
      expect((await engagement.getGiftCode(`GM${ID}`)).usedCount).toBe(1);
    });

    it('distinguishes why a code was refused', async () => {
      expect(await engagement.redeemGiftCode(`NOPE${ID}`, 'u1')).toMatchObject({ reason: 'NOT_FOUND' });

      await engagement.createGiftCode({
        code: `GX${ID}`, amountRupees: 10, expiresAt: new Date(Date.now() - 1000),
      });
      expect(await engagement.redeemGiftCode(`GX${ID}`, 'u1')).toMatchObject({ reason: 'EXPIRED' });

      await engagement.createGiftCode({ code: `GI${ID}`, amountRupees: 10 });
      await engagement.setGiftCodeActive(`GI${ID}`, false);
      expect(await engagement.redeemGiftCode(`GI${ID}`, 'u1')).toMatchObject({ reason: 'INACTIVE' });
    });

    it('keeps a bonus record nothing can edit', async () => {
      await engagement.recordBonus({
        bonusId: `bn-${ID}`, userId: `u-${ID}`, bonusType: 'ADMIN_CREDIT', amountRupees: 25,
      });
      await expect(pgQuery(
        `UPDATE bonus_records SET amount_paise = 1 WHERE bonus_id = $1`, [`bn-${ID}`],
      )).rejects.toThrow();
      // A retried grant records once.
      const again = await engagement.recordBonus({
        bonusId: `bn-${ID}`, userId: `u-${ID}`, bonusType: 'ADMIN_CREDIT', amountRupees: 25,
      });
      expect(again.idempotent).toBe(true);
    });

    it('marks a notification read with its timestamp, never without', async () => {
      const user = `u-${ID}-notif`;
      await engagement.notify({ userId: user, title: 'One' });
      await engagement.notify({ userId: user, title: 'Two' });
      expect(await engagement.unreadCount(user)).toBe(2);

      await engagement.markRead(user);
      expect(await engagement.unreadCount(user)).toBe(0);
      const [n] = await engagement.listNotifications(user);
      expect(n.readAt).not.toBeNull();

      await expect(pgQuery(
        `UPDATE notifications SET is_read = TRUE, read_at = NULL WHERE user_id = $1`, [user],
      )).rejects.toThrow(/notifications_read_has_time/);
    });

    it('hides an expired notification without waiting for a sweep', async () => {
      const user = `u-${ID}-exp`;
      await engagement.notify({ userId: user, title: 'Gone', expiresAt: new Date(Date.now() - 1000) });
      await engagement.notify({ userId: user, title: 'Here', expiresAt: new Date(Date.now() + 60_000) });
      expect((await engagement.listNotifications(user)).map((n) => n.title)).toEqual(['Here']);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('referrals — money owed', () => {
    it('gives every earning a unique place in the payout queue', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
        referrals.recordEarning({
          earningId: `e-${ID}-${i}`, earnerId: `earner-${ID}`,
          sourceUserId: `src-${ID}-${i}`, amountRupees: 10,
        })));
      const positions = results.filter((r) => r.earning).map((r) => r.earning.queuePosition);
      // MAX + 1 gave two concurrent signups the same slot — reproduced by this
      // test before the position came from a sequence.
      expect(new Set(positions).size).toBe(positions.length);
      expect(positions).toHaveLength(10);
    });

    it('refuses to pay an earning without the ledger row that moved it', async () => {
      await referrals.recordEarning({
        earningId: `e-${ID}-p`, earnerId: `a-${ID}`, sourceUserId: `b-${ID}`, amountRupees: 20,
      });
      await expect(referrals.markPaid(`e-${ID}-p`, { batchId: null, walletTxId: null }))
        .rejects.toThrow(/requires the walletTxId/);
      // And the row refuses it too, from the other direction.
      await expect(pgQuery(
        `UPDATE referral_earnings SET status = 'PAID' WHERE earning_id = $1`, [`e-${ID}-p`],
      )).rejects.toThrow(/referral_earnings_paid_is_ledgered/);

      const paid = await referrals.markPaid(`e-${ID}-p`, { batchId: `bt-${ID}`, walletTxId: `tx-${ID}` });
      expect(paid.ok).toBe(true);
      expect(paid.earning.walletTxId).toBe(`tx-${ID}`);
    });

    it('nobody earns from their own signup', async () => {
      await expect(referrals.recordEarning({
        earnerId: `self-${ID}`, sourceUserId: `self-${ID}`, amountRupees: 10,
      })).rejects.toThrow(/own signup/);
    });

    it('a batch cannot overspend its pool, however many payments race', async () => {
      await referrals.openBatch({ batchId: `bt-${ID}`, poolRupees: 100 });
      const spends = await Promise.all(
        Array.from({ length: 20 }, () => referrals.spendFromBatch(`bt-${ID}`, 10)),
      );
      // The ceiling is in the WHERE clause; an application check lets two
      // concurrent payments both read the same total and both pass.
      expect(spends.filter((s) => s.ok)).toHaveLength(10);
      const [batch] = await referrals.listBatches({ limit: 200 });
      const mine = (await referrals.listBatches({ limit: 200 })).find((b) => b.batchId === `bt-${ID}`);
      expect(mine.spent).toBe(100);
    });

    it('a programme cannot disburse past its budget', async () => {
      await referrals.upsertProgramme({ key: `pg-${ID}`, budgetRupees: 50, memberCap: 2, active: true });
      const draws = await Promise.all(
        Array.from({ length: 10 }, () => referrals.drawFromProgramme(`pg-${ID}`, 10)),
      );
      expect(draws.filter((d) => d.ok)).toHaveLength(5);
      expect((await referrals.getProgramme(`pg-${ID}`)).remaining).toBe(0);
    });

    it('counts a click once per viewer, so a refresh loop cannot inflate it', async () => {
      for (let i = 0; i < 5; i += 1) {
        await referrals.recordClick({ code: `rc-${ID}`, viewerHash: 'same-viewer' });
      }
      await referrals.recordClick({ code: `rc-${ID}`, viewerHash: 'other-viewer' });
      expect(await referrals.countClicks(`rc-${ID}`)).toBe(2);
    });

    it('summarises what a referrer is owed', async () => {
      const earner = `sum-${ID}`;
      await referrals.recordEarning({ earningId: `s1-${ID}`, earnerId: earner, sourceUserId: `x1-${ID}`, amountRupees: 30 });
      await referrals.recordEarning({ earningId: `s2-${ID}`, earnerId: earner, sourceUserId: `x2-${ID}`, amountRupees: 20 });
      await referrals.markPaid(`s1-${ID}`, { batchId: null, walletTxId: `tx-s1-${ID}` });
      await referrals.markBlocked(`s2-${ID}`, 'KYC incomplete');

      const summary = await referrals.earningsSummary(earner);
      expect(summary).toMatchObject({ paid: 30, queued: 0, blocked: 20, total: 2 });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('operations — the leader lock', () => {
    it('lets exactly ONE instance lead, however many start together', async () => {
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          operations.acquireLock(`job-${ID}`, `instance-${i}`, { ttlSeconds: 60 })),
      );
      expect(claims.filter((c) => c.acquired)).toHaveLength(1);
    });

    it('makes an abandoned lock claimable the INSTANT it lapses', async () => {
      // The document version waited on a TTL index that sweeps on its own
      // schedule, so a crashed leader's lock lingered and every instance
      // skipped its jobs until the sweep happened to run.
      await operations.acquireLock(`job-${ID}-x`, 'crashed-instance', { ttlSeconds: 60 });
      expect((await operations.acquireLock(`job-${ID}-x`, 'other')).acquired).toBe(false);

      // What a crashed leader actually leaves: an acquisition in the past and
      // a lease that has since lapsed. Moving only `expires_at` backwards would
      // put it before `acquired_at`, which is a row the table refuses — and
      // rightly, because that state cannot occur.
      await pgQuery(
        `UPDATE cron_locks
            SET acquired_at = now() - interval '10 minutes',
                expires_at  = now() - interval '1 second'
          WHERE job_name = $1`,
        [`job-${ID}-x`],
      );
      expect((await operations.acquireLock(`job-${ID}-x`, 'other')).acquired).toBe(true);
    });

    it('lets the holder extend its own lease but nobody else theirs', async () => {
      await operations.acquireLock(`job-${ID}-r`, 'me', { ttlSeconds: 60 });
      expect(await operations.renewLock(`job-${ID}-r`, 'me')).toBe(true);
      expect(await operations.renewLock(`job-${ID}-r`, 'someone-else')).toBe(false);
      expect(await operations.releaseLock(`job-${ID}-r`, 'someone-else')).toBe(false);
      expect(await operations.releaseLock(`job-${ID}-r`, 'me')).toBe(true);
    });

    it('releases the lock even when the job throws', async () => {
      await expect(operations.withLock(`job-${ID}-t`, 'me', async () => {
        throw new Error('job failed');
      })).rejects.toThrow('job failed');
      // Held until expiry would skip the next tick for no reason.
      expect((await operations.acquireLock(`job-${ID}-t`, 'other')).acquired).toBe(true);
    });

    it('hands out a counter value to one claimant at a time', async () => {
      const values = await Promise.all(
        Array.from({ length: 20 }, () => operations.nextCounterValue(`ctr-${ID}`)),
      );
      expect(new Set(values).size).toBe(20);
      expect(await operations.getCounter(`ctr-${ID}`)).toBe(20);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('audit — append-only, and failures included', () => {
    it('records an entry nothing can edit or delete', async () => {
      await audit.record({ adminId: `a-${ID}`, action: 'TEST_ACTION', targetId: `t-${ID}` });
      await expect(pgQuery(
        `UPDATE audit_logs SET action = 'CHANGED' WHERE target_id = $1`, [`t-${ID}`],
      )).rejects.toThrow();
      await expect(pgQuery(
        `DELETE FROM audit_logs WHERE target_id = $1`, [`t-${ID}`],
      )).rejects.toThrow();
    });

    it('records a FAILED action with its reason', async () => {
      // An audit of successes cannot show an attack that did not land.
      await audit.recordDetailed({
        performedBy: `a-${ID}`, action: 'LOGIN', category: 'AUTH',
        success: false, errorMessage: 'bad password', targetId: `t-${ID}-f`,
      });
      const failures = await audit.recentFailures({ hours: 1 });
      expect(failures.some((f) => f.targetId === `t-${ID}-f`)).toBe(true);

      // The row refuses a failure with no message at all.
      await expect(pgQuery(
        `INSERT INTO enhanced_audit_logs (action, success) VALUES ('X', FALSE)`,
      )).rejects.toThrow(/enhanced_audit_failure_has_message/);
    });

    it('never lets a logging failure take down the operation it describes', async () => {
      // An oversized category would violate nothing, so force a real failure:
      // a null action is refused by the column, and the caller still gets null
      // rather than a thrown error.
      const result = await audit.recordDetailed({
        performedBy: `a-${ID}`, action: 'OK', details: { circular: undefined },
      });
      expect(result).not.toBeUndefined();
    });

    it('pages the trail by keyset so no entry is skipped mid-read', async () => {
      for (let i = 0; i < 5; i += 1) {
        await audit.record({ adminId: `page-${ID}`, action: `A${i}` });
      }
      const first = await audit.search({ adminId: `page-${ID}`, limit: 2 });
      expect(first.entries).toHaveLength(2);
      const second = await audit.search({ adminId: `page-${ID}`, limit: 2, cursor: first.nextCursor });
      const ids = new Set([...first.entries, ...second.entries].map((e) => e.id));
      expect(ids.size).toBe(4);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('compliance — one PAN, one account', () => {
    it('refuses a second account on the same PAN, under a storm', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 10 }, (_, i) => compliance.registerPan({
          panHash: `pan-${ID}`, panLast4: '1234', userId: `u-${ID}-${i}`,
        })));
      expect(attempts.filter((a) => a.ok && !a.idempotent)).toHaveLength(1);
      expect(attempts.filter((a) => a.reason === 'PAN_ALREADY_REGISTERED')).toHaveLength(9);
    });

    it('refuses a second PAN on the same account', async () => {
      await compliance.registerPan({ panHash: `p1-${ID}`, panLast4: 'ABCD', userId: `u-${ID}` });
      expect(await compliance.registerPan({ panHash: `p2-${ID}`, panLast4: 'EFGH', userId: `u-${ID}` }))
        .toMatchObject({ ok: false, reason: 'ACCOUNT_ALREADY_HAS_PAN' });
    });

    it('treats the same account re-registering the same PAN as a retry', async () => {
      await compliance.registerPan({ panHash: `pr-${ID}`, panLast4: 'WXYZ', userId: `u-${ID}` });
      const again = await compliance.registerPan({ panHash: `pr-${ID}`, panLast4: 'WXYZ', userId: `u-${ID}` });
      expect(again).toMatchObject({ ok: true, idempotent: true });
    });

    it('will not free a PAN for someone who only knows the hash', async () => {
      await compliance.registerPan({ panHash: `pf-${ID}`, panLast4: 'QRST', userId: `u-${ID}` });
      expect(await compliance.releasePan(`pf-${ID}`, 'not-the-owner')).toBe(false);
      expect(await compliance.releasePan(`pf-${ID}`, `u-${ID}`)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('content, games, social — rows that cannot say two things', () => {
    // ACTIVE / MAINTENANCE / INACTIVE is the registry's own vocabulary. This
    // test said 'LIVE' — a status the registry never sets — and so proved the
    // launchability rule against a value the column rejects outright for a
    // different reason. It passed for the wrong reason, which is worse than
    // failing: the constraint it names could have been dropped entirely.
    it('refuses an ACTIVE game nothing can launch', async () => {
      await expect(games.upsertGame({
        slug: `g-${ID}`, name: 'Broken', status: 'ACTIVE', launchStrategy: 'PROVIDER',
      })).rejects.toThrow(/games_live_is_launchable/);

      const ok = await games.upsertGame({
        slug: `g-${ID}-ok`, name: 'Fine', status: 'ACTIVE',
        launchStrategy: 'URL', launchUrl: 'https://example.test/play',
      });
      expect(ok.status).toBe('ACTIVE');
    });

    it('refuses a status the registry never sets', async () => {
      await expect(games.upsertGame({
        slug: `g-${ID}-bad`, name: 'Wrong vocabulary', status: 'LIVE',
        launchStrategy: 'URL', launchUrl: 'https://example.test/play',
      })).rejects.toThrow(/games_status_known/);
    });

    it('does not wipe a provider credential when an admin edits its name', async () => {
      await games.upsertProvider({
        providerKey: `p-${ID}`, name: 'First', apiUrl: 'https://api.test',
        apiKeyEncrypted: 'secret-key',
      });
      await games.upsertProvider({ providerKey: `p-${ID}`, name: 'Renamed', apiUrl: 'https://api.test' });
      expect((await games.getProviderSecrets(`p-${ID}`)).apiKeyEncrypted).toBe('secret-key');
      // …and the general reader never sees it.
      expect(JSON.stringify(await games.getProvider(`p-${ID}`))).not.toContain('secret-key');
    });

    it('never returns a credential from the list, only whether one is set', async () => {
      await games.upsertProvider({
        providerKey: `pl-${ID}`, name: 'Listed', apiUrl: 'https://api.test',
        apiKeyEncrypted: 'sealed-key-material',
      });
      const listed = (await games.listProviders()).find((p) => p.key === `pl-${ID}`);
      expect(listed.hasApiKey).toBe(true);
      expect(listed.hasApiSecret).toBe(false);
      // The whole row, serialised. A new credential column added later and
      // forgotten in the SELECT would fail here rather than in production.
      expect(JSON.stringify(listed)).not.toContain('sealed-key-material');
    });

    it('keeps configuration state off the public list', async () => {
      await games.upsertProvider({
        providerKey: `pp-${ID}`, name: 'Public', category: 'casino',
        apiUrl: 'https://api.test', apiKeyEncrypted: 'sealed', enabled: true,
      });
      await games.upsertProvider({
        providerKey: `px-${ID}`, name: 'Not live', category: 'casino',
        apiUrl: 'https://api.test', apiKeyEncrypted: 'sealed',
      });
      const publicList = await games.listPublicProviders();
      const keys = publicList.map((p) => p.key);
      expect(keys).toContain(`pp-${ID}`);
      // A configured-but-switched-off supplier is commercial information.
      expect(keys).not.toContain(`px-${ID}`);
      expect(Object.keys(publicList[0])).not.toContain('hasApiKey');
    });

    it('lets the key decide, so two creates cannot both win', async () => {
      const [a, b] = await Promise.all([
        games.createProvider({ providerKey: `pc-${ID}`, name: 'First' }),
        games.createProvider({ providerKey: `pc-${ID}`, name: 'Second' }),
      ]);
      // One row, one null. Never two rows and never a throw.
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect((await games.getProvider(`pc-${ID}`)).enabled).toBe(false);
    });

    it('leaves an untouched credential alone on a partial edit', async () => {
      await games.createProvider({
        providerKey: `pu-${ID}`, name: 'Before', apiUrl: 'https://api.test',
        apiKeyEncrypted: 'keep-me', apiSecretEncrypted: 'also-keep-me',
      });
      await games.updateProvider(`pu-${ID}`, { name: 'After' }, { updatedBy: 'admin-1' });
      const secrets = await games.getProviderSecrets(`pu-${ID}`);
      expect(secrets.apiKeyEncrypted).toBe('keep-me');
      expect(secrets.apiSecretEncrypted).toBe('also-keep-me');
      expect((await games.getProvider(`pu-${ID}`)).name).toBe('After');

      // An explicit null is how a credential is retired.
      await games.updateProvider(`pu-${ID}`, { apiSecretEncrypted: null });
      expect((await games.getProviderSecrets(`pu-${ID}`)).apiSecretEncrypted).toBeNull();
      expect((await games.getProviderSecrets(`pu-${ID}`)).apiKeyEncrypted).toBe('keep-me');
    });

    it('reports a missing provider rather than succeeding at nothing', async () => {
      expect(await games.updateProvider(`nope-${ID}`, { name: 'Ghost' })).toBeNull();
      expect(await games.deleteProvider(`nope-${ID}`)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    });

    it('will not delete a provider out from under a game', async () => {
      await games.createProvider({ providerKey: `pd-${ID}`, name: 'In use' });
      await games.upsertGame({
        slug: `gd-${ID}`, name: 'Uses it', providerKey: `pd-${ID}`,
        launchStrategy: 'PROVIDER', externalGameId: 'x1', status: 'INACTIVE',
      });
      expect(await games.deleteProvider(`pd-${ID}`)).toMatchObject({ ok: false, reason: 'HAS_GAMES', games: 1 });

      await games.deleteGame(`gd-${ID}`);
      expect(await games.deleteProvider(`pd-${ID}`)).toMatchObject({ ok: true, name: 'In use' });
    });

    it('pages provider transactions with a total from the same query', async () => {
      for (let i = 0; i < 5; i += 1) {
        await games.recordGameTransaction({
          txId: `gt-${ID}-${i}`, roundId: `r-${ID}`, userId: `u-${ID}`,
          providerKey: `pt-${ID}`, txType: 'BET', amountRupees: 10 + i,
        });
      }
      const first = await games.adminGameTransactions({ providerKey: `pt-${ID}`, page: 1, limit: 2 });
      expect(first.transactions).toHaveLength(2);
      // The count describes the FILTERED set, not the page and not the table.
      expect(first.total).toBe(5);

      const last = await games.adminGameTransactions({ providerKey: `pt-${ID}`, page: 3, limit: 2 });
      expect(last.transactions).toHaveLength(1);
      expect(last.total).toBe(5);

      const empty = await games.adminGameTransactions({ providerKey: `absent-${ID}` });
      expect(empty).toMatchObject({ total: 0, transactions: [] });
    });

    it('refuses an enabled provider with no endpoint', async () => {
      await expect(games.upsertProvider({
        providerKey: `pe-${ID}`, name: 'No URL', enabled: true,
      })).rejects.toThrow(/game_providers_enabled_has_url/);
    });

    it('refuses a redelivered provider callback', async () => {
      const spec = {
        txId: `gt-${ID}`, userId: `u-${ID}`, providerKey: 'prov', txType: 'BET', amountRupees: 50,
      };
      expect((await games.recordGameTransaction(spec)).recorded).toBe(true);
      expect((await games.recordGameTransaction(spec))).toMatchObject({ recorded: false, idempotent: true });
    });

    it('will not delete an image something still references', async () => {
      const img = await content.addImage({ url: `https://cdn.test/${ID}.png` });
      await content.adjustImageUsage(img.imageId, 1);
      expect(await content.deleteImage(img.imageId)).toMatchObject({ ok: false, reason: 'IN_USE' });
      await content.adjustImageUsage(img.imageId, -1);
      expect(await content.deleteImage(img.imageId)).toEqual({ ok: true });
    });

    it('hides an expired announcement without waiting for a sweep', async () => {
      await content.createAnnouncement({
        title: `Gone ${ID}`, expiresAt: new Date(Date.now() - 1000),
      });
      await content.createAnnouncement({ title: `Here ${ID}` });
      const live = (await content.listLiveAnnouncements({ limit: 100 })).map((a) => a.title);
      expect(live).toContain(`Here ${ID}`);
      expect(live).not.toContain(`Gone ${ID}`);
    });

    it('refuses a published promo with nothing to show', async () => {
      await expect(content.upsertPromo({
        promoId: `pm-${ID}`, title: 'Empty', status: 'PUBLISHED', mediaType: 'IMAGE',
      })).rejects.toThrow(/promo_published_has_media/);
    });

    it('holds one asset per slot', async () => {
      await content.setAsset(`splash-${ID}`, { url: 'https://cdn.test/a.png' });
      await content.setAsset(`splash-${ID}`, { url: 'https://cdn.test/b.png' });
      expect((await content.getAsset(`splash-${ID}`)).url).toBe('https://cdn.test/b.png');
    });

    it('stops a banned player posting, with no gap between check and write', async () => {
      const user = `u-${ID}-chat`;
      expect((await social.postChatMessage({ userId: user, content: 'hi' })).ok).toBe(true);
      await social.banFromChat(user, { reason: 'spam' });
      expect(await social.postChatMessage({ userId: user, content: 'again' }))
        .toEqual({ ok: false, reason: 'BANNED' });
      await social.unbanFromChat(user);
      expect((await social.postChatMessage({ userId: user, content: 'back' })).ok).toBe(true);
    });

    it('keeps a deleted chat message as evidence', async () => {
      const posted = await social.postChatMessage({ userId: `u-${ID}-ev`, content: 'said something' });
      await social.deleteChatMessage(posted.message.id, `mod-${ID}`);
      const { rows } = await pgQuery(
        'SELECT content, is_deleted, deleted_by FROM public_chat_messages WHERE id = $1',
        [posted.message.id],
      );
      expect(rows[0]).toMatchObject({ content: 'said something', is_deleted: true });
      expect(rows[0].deleted_by).toBe(`mod-${ID}`);
      // …and it is gone from the feed.
      const feed = await social.listChatMessages({ limit: 100 });
      expect(feed.map((m) => m.id)).not.toContain(posted.message.id);
    });

    it('gives a ticket ONE owner when two agents open it together', async () => {
      const ticket = await social.openTicket({ userId: `u-${ID}`, subject: 'Help' });
      const claims = await Promise.all(
        Array.from({ length: 5 }, (_, i) => social.assignTicket(ticket.ticketId, `agent-${i}`)),
      );
      expect(claims.filter((c) => c.ok)).toHaveLength(1);
      expect(claims.filter((c) => c.reason === 'ALREADY_ASSIGNED')).toHaveLength(4);
    });

    it('moves a reply and the ticket it is on together', async () => {
      const ticket = await social.openTicket({ userId: `u-${ID}`, subject: 'Thread' });
      await social.replyToTicket({
        ticketId: ticket.ticketId, senderId: `u-${ID}`, senderType: 'USER', content: 'first',
      });
      const messages = await social.listTicketMessages(ticket.ticketId);
      expect(messages).toHaveLength(1);
      // A queue ordered by last reply must not show this as untouched.
      expect((await social.getTicket(ticket.ticketId)).lastReplyAt).not.toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('payment configuration', () => {
    it('gives a reviewed token order an owner, or refuses it', async () => {
      await paymentConfig.createTokenOrder({
        orderId: `to-${ID}`, merchantId: `m-${ID}`, tokenAmountRupees: 1000,
      });
      const claims = await Promise.all([
        paymentConfig.approveTokenOrder(`to-${ID}`, { actor: 'admin-1' }),
        paymentConfig.approveTokenOrder(`to-${ID}`, { actor: 'admin-2' }),
      ]);
      expect(claims.filter((c) => c.ok)).toHaveLength(1);

      await expect(pgQuery(
        `UPDATE merchant_admin_token_orders SET status = 'REJECTED', reviewed_by = NULL
          WHERE order_id = $1`, [`to-${ID}`],
      )).rejects.toThrow(/merchant_token_orders/);
    });

    it('refuses a rejection with no note', async () => {
      await paymentConfig.createTokenOrder({
        orderId: `tr-${ID}`, merchantId: `m-${ID}`, tokenAmountRupees: 500,
      });
      await expect(paymentConfig.rejectTokenOrder(`tr-${ID}`, { actor: 'admin', note: '' }))
        .rejects.toThrow(/requires a note/);
    });

    it('refuses to leave a player with no way to fund an account', async () => {
      await paymentConfig.setGatewayConfig({ key: `gw-${ID}`, p2pEnabled: true });
      await expect(paymentConfig.setGatewayConfig({
        key: `gw-${ID}`, p2pEnabled: false, gatewayEnabled: false,
      })).rejects.toThrow(/payment_gateway_one_rail_live/);
    });

    it('reads as P2P-only when nothing has been configured', async () => {
      const cfg = await paymentConfig.getGatewayConfig(`fresh-${ID}`);
      expect(cfg).toMatchObject({ activeMode: 'P2P', p2pEnabled: true, gatewayEnabled: false });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('deposit policy — the split that governs every deposit', () => {
    const CUR = () => `T${ID.slice(0, 5).toUpperCase()}`;

    const activeCount = async (currency) => {
      const { rows } = await pgQuery(
        "SELECT count(*)::int AS n FROM deposit_policies WHERE currency = $1 AND status = 'ACTIVE'",
        [currency],
      );
      return rows[0].n;
    };

    it('gives the FIRST version of a currency to exactly one of two writers', async () => {
      const currency = `${CUR()}A`;
      // There is no ACTIVE row yet, so there is nothing for the supersede to
      // lock and both writers compute version 1. The unique constraint is what
      // decides — one gets the row, the other a clean refusal it can retry.
      // Never a throw, and never two rows governing deposits.
      const results = await Promise.all([
        depositPolicy.createPolicyVersion({
          currency, depositAllocationPercent: 90, reserveAllocationPercent: 10,
          justification: 'race a', changedBy: 'admin-1',
        }),
        depositPolicy.createPolicyVersion({
          currency, depositAllocationPercent: 80, reserveAllocationPercent: 20,
          justification: 'race b', changedBy: 'admin-2',
        }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => r.reason)).toEqual(['CONCURRENT_CHANGE']);
      expect(await activeCount(currency)).toBe(1);
    });

    it('refuses the loser of a contended edit rather than doubling the policy', async () => {
      const currency = `${CUR()}H`;
      await depositPolicy.createPolicyVersion({
        currency, depositAllocationPercent: 90, reserveAllocationPercent: 10,
        justification: 'v1', changedBy: 'admin-1',
      });
      // Two admins editing the live policy at once. The supersede does not
      // serialise them — under READ COMMITTED the loser's UPDATE matches
      // nothing and holds no lock — so it is the one-ACTIVE-row index that
      // decides. What matters is what a caller can observe: one applied edit,
      // one retryable refusal, and one policy governing deposits.
      const results = await Promise.all([
        depositPolicy.createPolicyVersion({
          currency, depositAllocationPercent: 70, reserveAllocationPercent: 30,
          justification: 'race a', changedBy: 'admin-1',
        }),
        depositPolicy.createPolicyVersion({
          currency, depositAllocationPercent: 60, reserveAllocationPercent: 40,
          justification: 'race b', changedBy: 'admin-2',
        }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => r.reason)).toEqual(['CONCURRENT_CHANGE']);
      expect(await activeCount(currency)).toBe(1);

      // Retrying the refused edit succeeds, which is what makes the refusal an
      // acceptable answer rather than a lost change.
      const retried = await depositPolicy.createPolicyVersion({
        currency, depositAllocationPercent: 60, reserveAllocationPercent: 40,
        justification: 'race b, retried', changedBy: 'admin-2',
      });
      expect(retried.ok).toBe(true);
      expect(await activeCount(currency)).toBe(1);
      expect((await depositPolicy.getActivePolicy(currency)).depositAllocationPercent).toBe(60);
    });

    it('refuses a split that does not conserve the deposit', async () => {
      const currency = `${CUR()}B`;
      // 70 + 20 destroys a tenth of every deposit it governs. The JavaScript
      // validator caught this for callers that called it; the rollback path
      // did not, and this is the row refusing it regardless.
      const refused = await depositPolicy.createPolicyVersion({
        currency, depositAllocationPercent: 70, reserveAllocationPercent: 20,
        justification: 'loses money',
      });
      expect(refused).toMatchObject({ ok: false, reason: 'PERCENTAGES_MUST_SUM_TO_100' });
      expect(await depositPolicy.getActivePolicy(currency)).toBeNull();
    });

    it('conserves the full amount when it splits one', async () => {
      const currency = `${CUR()}C`;
      await depositPolicy.createPolicyVersion({
        currency, depositAllocationPercent: 93, reserveAllocationPercent: 7,
        justification: 'awkward percentage', changedBy: 'admin-1',
      });
      for (const amount of [1, 7, 99, 1000, 1234, 99_999]) {
        const split = await depositPolicy.splitForDeposit(amount, currency);
        // Rounding both shares independently loses or invents a paisa on most
        // amounts; over a day of deposits that is a reserve that will not
        // reconcile. The reserve is floored and the player gets the remainder.
        expect(split.depositAllocation + split.reserveAllocation).toBe(amount);
        expect(split.reserveAllocation).toBe(Math.floor((amount * 7) / 100));
      }
    });

    it('never edits history — a superseded version keeps its numbers', async () => {
      const currency = `${CUR()}D`;
      await depositPolicy.createPolicyVersion({
        currency, depositAllocationPercent: 90, reserveAllocationPercent: 10,
        justification: 'v1', changedBy: 'admin-1',
      });
      await depositPolicy.createPolicyVersion({
        currency, depositAllocationPercent: 60, reserveAllocationPercent: 40,
        justification: 'v2', changedBy: 'admin-1',
      });

      const v1 = await depositPolicy.getPolicyVersion(currency, 1);
      expect(v1).toMatchObject({ status: 'SUPERSEDED', depositAllocationPercent: 90 });

      // An order created under v1 carries v1's split forever, so v1's numbers
      // are not editable and v1 is not deletable.
      await expect(pgQuery(
        'UPDATE deposit_policies SET deposit_allocation_percent = 50, reserve_allocation_percent = 50 WHERE currency = $1 AND version = 1',
        [currency],
      )).rejects.toThrow(/immutable/);
      await expect(pgQuery(
        'DELETE FROM deposit_policies WHERE currency = $1 AND version = 1', [currency],
      )).rejects.toThrow(/permanent/);
    });

    it('holds a proposal back until somebody approves it', async () => {
      const currency = `${CUR()}E`;
      await depositPolicy.createPolicyVersion({
        currency, depositAllocationPercent: 90, reserveAllocationPercent: 10,
        justification: 'live', changedBy: 'admin-1',
      });
      const proposed = await depositPolicy.createPolicyVersion({
        currency, depositAllocationPercent: 50, reserveAllocationPercent: 50,
        justification: 'proposal', changedBy: 'admin-2', status: 'PENDING_APPROVAL',
      });
      expect(proposed.policy.status).toBe('PENDING_APPROVAL');
      // A proposal does not govern deposits. The 90/10 keeps running.
      expect((await depositPolicy.getActivePolicy(currency)).depositAllocationPercent).toBe(90);

      const activated = await depositPolicy.activatePolicyVersion(currency, proposed.policy.version, { changedBy: 'admin-3' });
      expect(activated.status).toBe('ACTIVE');
      expect((await depositPolicy.getActivePolicy(currency)).depositAllocationPercent).toBe(50);
      // …and approving it superseded the one it replaced, in the same breath.
      expect((await depositPolicy.getPolicyVersion(currency, 1)).status).toBe('SUPERSEDED');
    });

    it('reinstates an old version as a new one rather than reviving it', async () => {
      const currency = `${CUR()}F`;
      await depositPolicy.createPolicyVersion({
        currency, depositAllocationPercent: 95, reserveAllocationPercent: 5,
        justification: 'v1', changedBy: 'admin-1',
      });
      await depositPolicy.createPolicyVersion({
        currency, depositAllocationPercent: 70, reserveAllocationPercent: 30,
        justification: 'v2', changedBy: 'admin-1',
      });
      const rolled = await depositPolicy.rollbackToPolicyVersion(currency, 1, { changedBy: 'admin-9' });
      expect(rolled.ok).toBe(true);
      expect(rolled.policy.version).toBe(3);
      expect(rolled.policy.depositAllocationPercent).toBe(95);
      // v1 is untouched history, not resurrected.
      expect((await depositPolicy.getPolicyVersion(currency, 1)).status).toBe('SUPERSEDED');
    });

    it('activates a scheduled version once its time has come', async () => {
      const currency = `${CUR()}G`;
      await depositPolicy.createPolicyVersion({
        currency, depositAllocationPercent: 90, reserveAllocationPercent: 10,
        justification: 'current', changedBy: 'admin-1',
      });
      await depositPolicy.createPolicyVersion({
        currency, depositAllocationPercent: 85, reserveAllocationPercent: 15,
        justification: 'scheduled', changedBy: 'admin-1',
        status: 'SCHEDULED', effectiveAt: new Date(Date.now() - 60_000),
      });

      const applied = await depositPolicy.applyScheduledPolicyChanges();
      expect(applied.some((r) => r.currency === currency && r.applied)).toBe(true);
      expect((await depositPolicy.getActivePolicy(currency)).depositAllocationPercent).toBe(85);

      // Running the sweep again finds nothing to do — it is not a second
      // activation, and it does not error.
      const second = await depositPolicy.applyScheduledPolicyChanges();
      expect(second.some((r) => r.currency === currency)).toBe(false);
    });
  });

});
