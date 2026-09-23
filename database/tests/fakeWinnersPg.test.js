// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Curated winners, against a REAL PostgreSQL.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The admin screen read `w._id` on every row, and `toFakeWinner` has never
 * emitted one — it emits `id`. So Edit, Delete and the visibility toggle all
 * built `/api/admin/fake-winners/undefined`.
 *
 * That is not a 404. `id` is an INTEGER, `Number('undefined')` is NaN, and
 * node-postgres sends NaN for an integer parameter, so PostgreSQL refuses it
 * and the route answered **500** — which `serverError` answers with nothing
 * (§2). The operator is told the platform broke, with no way to tell that the
 * id was the problem. Measured before the fix: `PUT .../undefined` -> 500,
 * `PUT .../1` -> 200.
 *
 * Two things had to be true, so both are asserted here:
 *
 *   1. The mapper emits `id` — the panel's contract, and the thing that was
 *      wrong. An assertion on the KEY, because the value being right is not
 *      the same fact as the key being the one a caller reads.
 *   2. A malformed id is refused as the CALLER's mistake, 400 with a message
 *      that names itself, rather than reaching the driver. Defence in depth:
 *      the panel is fixed, and the next panel to get it wrong gets an answer
 *      it can act on instead of a silent 500.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  addFakeWinner, listFakeWinners, updateFakeWinner, deleteFakeWinner,
} from '../repositories/engagement.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('curated winners (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => { await pgQuery('TRUNCATE fake_winners RESTART IDENTITY CASCADE'); });

  const mk = (over = {}) => ({
    displayName: 'Rahul K.', amount: 50000, city: 'Mumbai',
    game: 'Delhi/Bombay', badge: '', isPublic: true, sortOrder: 0, ...over,
  });

  describe('the id a caller reads', () => {
    it('is `id`, and there is no `_id`', async () => {
      const created = await addFakeWinner(mk());
      expect(created).toHaveProperty('id');
      expect(created.id).toBeGreaterThan(0);
      // The whole defect, as an assertion: a panel reading `_id` got undefined.
      expect(created).not.toHaveProperty('_id');

      const [listed] = await listFakeWinners({ publicOnly: false, limit: 10 });
      expect(listed).toHaveProperty('id');
      expect(listed).not.toHaveProperty('_id');
    });

    it('round-trips through update and delete', async () => {
      const { id } = await addFakeWinner(mk());
      const updated = await updateFakeWinner(id, { isPublic: false });
      expect(updated.isPublic).toBe(false);
      expect(await deleteFakeWinner(id)).toBe(true);
      expect(await listFakeWinners({ publicOnly: false, limit: 10 })).toEqual([]);
    });

    it('deleting one that is gone reports FALSE, not a silent success', async () => {
      const { id } = await addFakeWinner(mk());
      expect(await deleteFakeWinner(id)).toBe(true);
      expect(await deleteFakeWinner(id)).toBe(false);
    });
  });

  describe('a malformed id is the caller\'s mistake', () => {
    // Exactly what the panel sent for months.
    const BAD = ['undefined', 'null', '', 'abc', '1.5', '-3', '0', NaN];

    for (const bad of BAD) {
      it(`refuses ${JSON.stringify(bad)} with a 400 that names itself`, async () => {
        await expect(updateFakeWinner(bad, { isPublic: false }))
          .rejects.toMatchObject({ status: 400, code: 'BAD_FAKE_WINNER_ID' });
        await expect(deleteFakeWinner(bad))
          .rejects.toMatchObject({ status: 400, code: 'BAD_FAKE_WINNER_ID' });
      });
    }

    it('the message tells the operator what a winner id looks like', async () => {
      // §21: the refusal carries its own wording, and `respondError` only keeps
      // it because `status` is present at the throw. A 500 would say nothing.
      await expect(updateFakeWinner('undefined', {})).rejects.toThrow(/positive whole number/i);
    });

    it('an id that is merely ABSENT is still refused, not treated as row zero', async () => {
      await expect(updateFakeWinner(undefined, { isPublic: false }))
        .rejects.toMatchObject({ status: 400 });
    });

    it('a real id still works after all that', async () => {
      const { id } = await addFakeWinner(mk({ displayName: 'Still fine' }));
      expect((await updateFakeWinner(id, { city: 'Pune' })).city).toBe('Pune');
    });
  });
});
