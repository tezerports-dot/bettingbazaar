// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a player is told about money support moved on their account.
 *
 * ── What was wrong (2026-10-01) ─────────────────────────────────────────────
 * An admin adjustment writes the admin's note into the ledger row, prefixed
 * with the staff account's id — `[Admin:<staff id>] <note>` — and the admin
 * screen says that note "is written to the audit log". The player's
 * `GET /api/v1/wallet/ledger` returned it as `reason`, and the wallet's History
 * tab renders `reason` as each entry's title. Found while wiring the player's
 * bonus history (`GET /api/bonuses/my`), whose records carry the same note.
 *
 * The opposite behaviour (§37 step 6) is asserted beside it: the ADMIN's own
 * user-detail screen still reads the full note, and every movement that is not
 * an adjustment keeps its reason.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const NOTE = 'goodwill after the 3pm outage, flagged for review';

describePg("the player's view of support credits", () => {
  let players; let retention; let staffUsers; let admin;

  beforeAll(async () => {
    await applySchema();
    players = mountRouter((await import('../../domains/user/user.routes.js')).default);
    retention = mountRouter((await import('../../routes/retention.routes.js')).default);
    staffUsers = mountRouter((await import('../../routes/admin/users.admin.routes.js')).default);
    admin = await actor({ isAdmin: true });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A player with one support credit and one ordinary movement. */
  const credited = async () => {
    const player = await actor({});
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(player.userId, 50, 'Cycle win', 'Test', `seed_${player.userId}`, `plv_seed_${player.userId}`);
    const adj = await as(retention, admin).post('/admin/balance-adjust').send({
      userId: player.userId, type: 'CREDIT', field: 'depositBalance', amount: 125, reason: NOTE,
    });
    expect(adj.status, JSON.stringify(adj.body)).toBe(200);
    return player;
  };

  it('shows the player "Credited by support" — never the staff id or the note', async () => {
    const player = await credited();
    const res = await as(players, player).get('/v1/wallet/ledger');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(NOTE);
    expect(body).not.toContain('[Admin:');
    expect(body).not.toContain(String(admin.userId));

    const adjustment = res.body.entries.find((e) => e.amount === 125);
    expect(adjustment.reason).toBe('Credited by support');
    // The allowlist, asserted as a key set (§24 rule 2).
    for (const e of res.body.entries) {
      expect(Object.keys(e).sort()).toEqual(
        ['amount', 'balanceAfter', 'balanceBefore', 'createdAt', 'field', 'reason', 'txId', 'type'],
      );
    }
  });

  it('keeps the reason of every movement that is not an adjustment (the opposite behaviour)', async () => {
    const player = await credited();
    const res = await as(players, player).get('/v1/wallet/ledger');
    expect(res.body.entries.find((e) => e.amount === 50).reason).toBe('Cycle win');
  });

  it('lists the credit in the bonus history with a label, and without the note', async () => {
    const player = await credited();
    const res = await as(retention, player).get('/bonuses/my');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0]).toMatchObject({ type: 'ADMIN_CREDIT', label: 'Credited by support', amount: 125 });
    expect(Object.keys(res.body.records[0]).sort()).toEqual(['amount', 'bonusId', 'createdAt', 'label', 'type']);
    expect(JSON.stringify(res.body)).not.toContain(NOTE);
  });

  it("shows a debit as 'Debited by support'", async () => {
    const player = await credited();
    const debit = await as(retention, admin).post('/admin/balance-adjust').send({
      userId: player.userId, type: 'DEBIT', field: 'depositBalance', amount: 25, reason: NOTE,
    });
    expect(debit.status, JSON.stringify(debit.body)).toBe(200);
    const res = await as(players, player).get('/v1/wallet/ledger');
    expect(res.body.entries.find((e) => e.type === 'DEBIT' && e.amount === 25).reason).toBe('Debited by support');
    expect(JSON.stringify(res.body)).not.toContain(NOTE);
  });

  it("still shows the ADMIN the note, on the admin's own screen (the opposite behaviour)", async () => {
    const player = await credited();
    const res = await as(staffUsers, admin).get(`/users/${player.userId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = res.body.recentTransactions.find((e) => e.amount === 125);
    expect(row.reason).toContain(NOTE);
  });
});
