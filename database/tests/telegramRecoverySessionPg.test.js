// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The half-finished recovery, in the database rather than in one process.
 *
 * Account recovery is two messages — the Aadhaar, then the contact share — and
 * the first was held in a module-level `Map`. This platform is built for
 * horizontal scale and says so, so behind a load balancer the two messages land
 * on different instances and the second answers "please send your Aadhaar
 * first" to somebody who just did: intermittent, indistinguishable from their
 * own mistake, on the one path a person reaches BECAUSE they have already lost
 * access. Audit F-002.
 *
 * The assertion that matters most is the LAST one: the plaintext Aadhaar is not
 * in the row. `attemptRecovery` only ever compared hashes, so it never needed
 * the number — and this is now the only place in the platform where an Aadhaar
 * is neither stored nor held in memory at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import {
  putRecoverySession, getRecoverySession, deleteRecoverySession, sweepExpired,
} from '#db/repositories/telegram.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('telegram recovery sessions', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const tgId = () => `rec-${RUN}-${(seq += 1)}`;

  beforeAll(async () => { await applySchema(); }, 60_000);

  /**
   * Every row this file creates is removed, including the ones a test
   * deliberately leaves live.
   *
   * Not tidiness — trap §20.10. The test database is NOT reset between runs, so
   * a live session with a 600-second TTL is an EXPIRED session ten minutes
   * later, and the retention count in `telegramPg.test.js` then reports a
   * deletion nothing in that test created. Four leftovers a run had accumulated
   * to sixteen before this was caught. `tgId()` namespaces every id to this
   * run, so the prefix delete cannot touch another file's rows.
   */
  afterAll(async () => {
    await pgQuery(
      "DELETE FROM telegram_recovery_sessions WHERE telegram_user_id LIKE $1",
      [`rec-${RUN}-%`],
    );
    await closePg();
  });

  it('is readable by a DIFFERENT caller than the one that wrote it', async () => {
    // The whole point. A Map is readable only by the process that wrote it;
    // these two calls stand in for two instances behind a load balancer.
    const id = tgId();
    await putRecoverySession({ telegramUserId: id, aadhaarHashes: ['h1', 'h2'], ttlSeconds: 600 });

    const held = await getRecoverySession(id);
    expect(held).toBeTruthy();
    expect(held.aadhaarHashes).toEqual(['h1', 'h2']);
  });

  it('keeps the HASHES and never the Aadhaar itself', async () => {
    const id = tgId();
    await putRecoverySession({ telegramUserId: id, aadhaarHashes: ['abc123hash'], ttlSeconds: 600 });

    const { rows } = await pgQuery(
      'SELECT * FROM telegram_recovery_sessions WHERE telegram_user_id = $1', [id],
    );
    const stored = JSON.stringify(rows[0]);
    expect(stored).toContain('abc123hash');
    // No column holds anything resembling a 12-digit number.
    expect(stored).not.toMatch(/\d{12}/);
  });

  it('a second Aadhaar REPLACES the first — a typo is correctable', async () => {
    // Somebody who has already lost their account must not also be told to wait
    // out a TTL because they mistyped.
    const id = tgId();
    await putRecoverySession({ telegramUserId: id, aadhaarHashes: ['first'], ttlSeconds: 600 });
    await putRecoverySession({ telegramUserId: id, aadhaarHashes: ['second'], ttlSeconds: 600 });

    expect((await getRecoverySession(id)).aadhaarHashes).toEqual(['second']);
  });

  it('an expired session reads as absent WITHOUT the sweep having run', async () => {
    // Expiry is in the statement. A sweep that is late, failed or never
    // scheduled must not make a stale session usable.
    const id = tgId();
    await putRecoverySession({ telegramUserId: id, aadhaarHashes: ['stale'], ttlSeconds: 600 });
    await pgQuery(
      "UPDATE telegram_recovery_sessions SET expires_at = now() - interval '1 second' WHERE telegram_user_id = $1",
      [id],
    );

    expect(await getRecoverySession(id)).toBeNull();
    // Still physically present — proving the read, not the sweep, refused it.
    const { rows } = await pgQuery(
      'SELECT 1 FROM telegram_recovery_sessions WHERE telegram_user_id = $1', [id],
    );
    expect(rows).toHaveLength(1);
    // Reclaimed here rather than left for the sweep: the retention counts in
    // telegramPg.test.js are exact, and a stray expired row from this file
    // would show up there as a deletion nothing in that test created.
    await deleteRecoverySession(id);
  });

  it('is consumed on delete, so one send is one attempt', async () => {
    const id = tgId();
    await putRecoverySession({ telegramUserId: id, aadhaarHashes: ['once'], ttlSeconds: 600 });
    await deleteRecoverySession(id);
    expect(await getRecoverySession(id)).toBeNull();
  });

  it('deleting a session that is not there is not an error', async () => {
    await expect(deleteRecoverySession(tgId())).resolves.toBeUndefined();
  });

  it('refuses to store a session with no hashes', async () => {
    // A row with an empty array would read as a live session that can never
    // match, which is the shape most easily mistaken for a working one.
    await expect(putRecoverySession({ telegramUserId: tgId(), aadhaarHashes: [], ttlSeconds: 600 }))
      .rejects.toThrow(/aadhaar hash/i);
  });

  it('the retention sweep reclaims expired rows and reports its own count', async () => {
    // Counted from the DELETE's own row count, per trap 6 — never accumulated.
    const id = tgId();
    await putRecoverySession({ telegramUserId: id, aadhaarHashes: ['sweepme'], ttlSeconds: 600 });
    await pgQuery(
      "UPDATE telegram_recovery_sessions SET expires_at = now() - interval '1 hour' WHERE telegram_user_id = $1",
      [id],
    );

    const result = await sweepExpired();
    expect(result).toHaveProperty('recoverySessions');
    expect(result.recoverySessions).toBeGreaterThan(0);

    const { rows } = await pgQuery(
      'SELECT 1 FROM telegram_recovery_sessions WHERE telegram_user_id = $1', [id],
    );
    expect(rows).toHaveLength(0);
  });
});
