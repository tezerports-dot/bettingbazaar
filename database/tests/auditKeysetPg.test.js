// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Paging the audit trail shows every entry, exactly once.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `search()` pages on `(created_at, id)` precisely so that an entry written
 * mid-read cannot shift the window and hide a row. The cursor then carried
 * `created_at` as a JavaScript Date — MILLISECONDS — while the column is
 * TIMESTAMPTZ — MICROSECONDS. Every cursor was therefore rounded down.
 *
 * Two entries written in the same millisecond (routine: this table takes a row
 * per admin action) compare EQUAL on the tuple's first element once truncated,
 * so `(created_at, id) < (cursor, id)` is false for the row that follows the
 * page boundary and the next page starts after it. The entry is not shown
 * late — it is never shown, in the one place where a missing row is the point.
 *
 * The suite already had a paging test. It asserted only that two pages held
 * four distinct ids, and it PASSED on a run that lost a row: the skip pulled an
 * older entry up into page two, and the count came out right. Counting what
 * came back cannot detect a row that never came back. These assert on the
 * identities, against rows deliberately written into one millisecond.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import * as audit from '../repositories/audit.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('audit keyset paging', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => { await closePg(); });

  /**
   * Write `n` entries that share one millisecond but differ in microseconds —
   * the case the Date round trip could not represent. Written directly so the
   * timestamps are exact rather than whatever the machine happened to produce:
   * the defect only appeared on hardware fast enough to collide naturally, so
   * it reproduced on CI and not on a developer's laptop.
   */
  const seed = async (adminId, n) => {
    for (let i = 0; i < n; i += 1) {
      await pgQuery(
        `INSERT INTO audit_logs (admin_id, action, created_at)
         VALUES ($1, $2, TIMESTAMPTZ '2026-01-01 00:00:00.123' + ($3 || ' microseconds')::interval)`,
        [adminId, `A${i}`, String(i * 100)],
      );
    }
  };

  const drain = async (adminId, limit) => {
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await audit.search({ adminId, limit, cursor });
      seen.push(...page.entries.map((e) => e.id));
      if (!page.nextCursor) return seen;
      cursor = page.nextCursor;
    }
    throw new Error('paging did not terminate');
  };

  it('shows every entry when all of them share a millisecond', async () => {
    // Six rows, one millisecond, microseconds 0/100/200/300/400/500. With a
    // truncating cursor the page-two window opened at .123000 and every row
    // after the first boundary compared greater — they were dropped silently.
    const adminId = `ms-${RUN}`;
    await seed(adminId, 6);
    const seen = await drain(adminId, 2);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size, 'no entry may repeat across pages').toBe(6);
  });

  it('loses nothing at any page size', async () => {
    // The boundary lands between a different pair each time; a cursor that is
    // only right for some page sizes is not right.
    const adminId = `sz-${RUN}`;
    await seed(adminId, 7);
    const all = await drain(adminId, 7);
    expect(all).toHaveLength(7);
    for (const size of [1, 2, 3, 5, 6]) {
      const seen = await drain(adminId, size);
      expect(seen, `limit ${size} must return the same 7 entries`).toHaveLength(7);
      expect(new Set(seen).size, `limit ${size} must not repeat one`).toBe(7);
      expect([...seen].sort(), `limit ${size} must return the SAME entries`).toEqual([...all].sort());
    }
  });

  it('carries the cursor timestamp losslessly, not as a Date', async () => {
    // The mechanism, asserted directly: a Date cannot hold microseconds, so a
    // cursor that is one is already wrong before it is used. The check is
    // equality with what the column actually holds — not a digit-count pattern,
    // because PostgreSQL trims trailing zeros when it renders a timestamp as
    // text (".1231+00", never ".123100+00"), and a test that expected the
    // padding would fail on a value that is perfectly lossless.
    const adminId = `cur-${RUN}`;
    await seed(adminId, 4);
    const page = await audit.search({ adminId, limit: 2 });
    expect(page.nextCursor).toBeTruthy();
    expect(page.nextCursor.createdAt, 'the cursor must not be a Date').not.toBeInstanceOf(Date);

    const boundary = page.entries[page.entries.length - 1].id;
    const { rows } = await pgQuery('SELECT created_at::text AS t FROM audit_logs WHERE id = $1', [boundary]);
    expect(page.nextCursor.createdAt, 'the cursor must equal the stored value exactly')
      .toBe(rows[0].t);
  });

  it('still returns entries newest first', async () => {
    // The fix must not reorder the trail.
    const adminId = `ord-${RUN}`;
    await seed(adminId, 5);
    const seen = await drain(adminId, 2);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });
});
