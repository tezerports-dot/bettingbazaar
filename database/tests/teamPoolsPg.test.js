// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Team token pools, against a REAL PostgreSQL (PROJECT_STATUS §3.10, 2b).
 *
 * A team's pool is bought from and sold back to the platform. Every sale is a
 * treasury TRANSFER (TOKEN_SUPPLY → TEAM_FLOAT) — no token is created — and
 * every fulfilment records what was paid for it. What needs a database: the
 * once-only fulfilment is a status flip RACED here, the buyback floor is the
 * UPDATE's own WHERE, and TEAM_FLOAT must equal the sum of every pool.
 *
 * Trap 10: every merchant, team and request is this run's own, removed after;
 * assertions on the treasury are DELTAS, never global totals.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  createMerchant, updateMerchant, newMerchantId, generateMerchantPublicRef,
} from '../repositories/merchants.js';
import { setSupervisorRole, createTeam, deleteTeam, getTeam } from '../repositories/teams.js';
import {
  createRequest, cancelRequest, getRequest, listRequests, rejectRequest, fulfilRequest,
  getPool, listEntries,
} from '../repositories/teamPools.js';
import { getTreasuryBalances, ACCOUNTS } from '../repositories/treasury.js';

const describePg = pgConfigured() ? describe : describe.skip;
const T = (tokens) => tokens * 100;   // tokens → paise
const INR = (rupees) => ({ currency: 'INR', fiatAmountMinor: rupees * 100, rateUsed: null });

describePg('team token pools (PostgreSQL)', () => {
  const made = [];
  const teams = [];
  let seq = 0;
  const supervisor = async () => {
    const merchantId = newMerchantId();
    seq += 1;
    await createMerchant({
      merchantId, name: `TP ${merchantId.slice(-6)}`, publicRef: generateMerchantPublicRef(),
      mobile: `6${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`, status: 'ACTIVE',
    });
    await updateMerchant(merchantId, { merchantApprovalStatus: 'APPROVED' });
    made.push(merchantId);
    expect(await setSupervisorRole(merchantId, { rail: 'UPI_BANK' })).toEqual({ ok: true });
    return merchantId;
  };
  const team = async () => {
    const sup = await supervisor();
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Pool' });
    teams.push(teamId);
    return { sup, teamId };
  };
  const ask = async (t, direction, tokens) => {
    const out = await createRequest({ teamId: t.teamId, supervisorId: t.sup, direction, tokenAmountPaise: T(tokens) });
    expect(out.ok).toBe(true);
    return out.requestId;
  };
  /** A team whose pool already holds `tokens`. */
  const funded = async (tokens) => {
    const t = await team();
    const id = await ask(t, 'BUY', tokens);
    expect((await fulfilRequest({ requestId: id, actor: 'admin-1', consideration: INR(tokens) })).ok).toBe(true);
    return t;
  };

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => {
    // The pool tables are append-only or keyed to teams; this run's rows only.
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery('DELETE FROM admin_token_considerations WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_pool_entries WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_pool_requests WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_pools WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM teams WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM merchants WHERE merchant_id = ANY($1)', [made]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    await closePg();
  });

  // ── Requests ─────────────────────────────────────────────────────────────
  it('a supervisor asks to buy; one pending request per direction per team', async () => {
    const t = await team();
    const id = await ask(t, 'BUY', 1000);
    expect(await getRequest(id)).toMatchObject({ teamId: t.teamId, direction: 'BUY', status: 'PENDING', tokenAmountPaise: T(1000) });
    expect(await createRequest({ teamId: t.teamId, supervisorId: t.sup, direction: 'BUY', tokenAmountPaise: T(5) }))
      .toEqual({ ok: false, reason: 'request_pending' });
    // A pending BUY does not stop a SELL being asked — they are different questions.
    // (The pool is empty, so the SELL is refused for that reason, not for the BUY.)
    expect(await createRequest({ teamId: t.teamId, supervisorId: t.sup, direction: 'SELL', tokenAmountPaise: T(5) }))
      .toEqual({ ok: false, reason: 'pool_short' });
  });

  it('refuses another supervisor\'s team as not found, and a bad direction or amount by name', async () => {
    const t = await team();
    const other = await supervisor();
    expect(await createRequest({ teamId: t.teamId, supervisorId: other, direction: 'BUY', tokenAmountPaise: T(10) }))
      .toEqual({ ok: false, reason: 'team_not_found' });
    await expect(createRequest({ teamId: t.teamId, supervisorId: t.sup, direction: 'HOLD', tokenAmountPaise: T(10) }))
      .rejects.toMatchObject({ status: 400 });
    await expect(createRequest({ teamId: t.teamId, supervisorId: t.sup, direction: 'BUY', tokenAmountPaise: 0 }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('only the supervisor who asked can cancel, and only while pending', async () => {
    const t = await team();
    const id = await ask(t, 'BUY', 10);
    const other = await supervisor();
    expect(await cancelRequest({ requestId: id, supervisorId: other })).toEqual({ ok: false, reason: 'request_not_pending' });
    expect(await cancelRequest({ requestId: id, supervisorId: t.sup })).toEqual({ ok: true });
    expect((await getRequest(id)).status).toBe('CANCELLED');
    expect(await cancelRequest({ requestId: id, supervisorId: t.sup })).toEqual({ ok: false, reason: 'request_not_pending' });
    // And a cancelled request cannot then be fulfilled.
    expect(await fulfilRequest({ requestId: id, actor: 'admin-1', consideration: INR(10) }))
      .toEqual({ ok: false, reason: 'request_not_pending' });
  });

  // ── Fulfilment: both sides of the money ──────────────────────────────────
  it('a sale moves tokens from the platform into the pool, records the payment, and conserves', async () => {
    const t = await team();
    const id = await ask(t, 'BUY', 2500);
    const before = await getTreasuryBalances();
    const out = await fulfilRequest({ requestId: id, actor: 'admin-1', consideration: INR(2400) });
    expect(out.ok).toBe(true);
    const after = await getTreasuryBalances();

    expect(after[ACCOUNTS.TOKEN_SUPPLY] - before[ACCOUNTS.TOKEN_SUPPLY]).toBe(-T(2500));
    expect(after[ACCOUNTS.TEAM_FLOAT] - before[ACCOUNTS.TEAM_FLOAT]).toBe(T(2500));
    expect(await getPool(t.teamId)).toEqual({ teamId: t.teamId, availablePaise: T(2500), heldPaise: 0, totalPaise: T(2500) });

    const { rows } = await pgQuery(
      'SELECT direction, currency, fiat_amount_minor, merchant_id, team_id FROM admin_token_considerations WHERE movement_id = $1',
      [`team_pool_${id}`]);
    expect(rows).toEqual([{ direction: 'RECEIVED', currency: 'INR', fiat_amount_minor: String(240000), merchant_id: t.sup, team_id: t.teamId }]);
    const entries = await listEntries(t.teamId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'ADMIN_SALE', availableDeltaPaise: T(2500), availableAfterPaise: T(2500) });
    expect((await getRequest(id)).status).toBe('FULFILLED');
    expect((await getTeam(t.teamId)).poolAvailablePaise).toBe(T(2500));
  });

  it('a buyback takes tokens back to the platform and records a rupee payment', async () => {
    const t = await funded(1000);
    const id = await ask(t, 'SELL', 400);
    const before = await getTreasuryBalances();
    expect((await fulfilRequest({ requestId: id, actor: 'admin-1', consideration: INR(390) })).ok).toBe(true);
    const after = await getTreasuryBalances();
    expect(after[ACCOUNTS.TOKEN_SUPPLY] - before[ACCOUNTS.TOKEN_SUPPLY]).toBe(T(400));
    expect(after[ACCOUNTS.TEAM_FLOAT] - before[ACCOUNTS.TEAM_FLOAT]).toBe(-T(400));
    expect((await getPool(t.teamId)).availablePaise).toBe(T(600));
    const { rows } = await pgQuery('SELECT direction FROM admin_token_considerations WHERE movement_id = $1', [`team_pool_${id}`]);
    expect(rows[0].direction).toBe('PAID');
  });

  it('a buyback larger than the pool is refused at fulfilment, and nothing moves', async () => {
    const t = await funded(500);
    const sell = await ask(t, 'SELL', 500);
    // The pool is drawn down after the request was made: the courtesy check at
    // asking time is not the guard, the fulfilment's own write is.
    await pgQuery('UPDATE team_pool_requests SET token_amount_paise = $2 WHERE request_id = $1', [sell, T(501)]);
    const before = await getTreasuryBalances();
    expect(await fulfilRequest({ requestId: sell, actor: 'admin-1', consideration: INR(501) }))
      .toEqual({ ok: false, reason: 'pool_short' });
    const after = await getTreasuryBalances();
    expect(after[ACCOUNTS.TEAM_FLOAT]).toBe(before[ACCOUNTS.TEAM_FLOAT]);
    expect((await getPool(t.teamId)).availablePaise).toBe(T(500));
    // The refusal rolled the status flip back with everything else.
    expect((await getRequest(sell)).status).toBe('PENDING');
  });

  it('a USDT payment is recorded in USDT with its rate, but a buyback must be paid in rupees', async () => {
    const t = await team();
    const id = await ask(t, 'BUY', 50000);
    const out = await fulfilRequest({
      requestId: id, actor: 'admin-1',
      consideration: { currency: 'USDT', fiatAmountMinor: 55000, rateUsed: 90.9 },
    });
    expect(out.ok).toBe(true);
    expect(out.consideration).toMatchObject({ currency: 'USDT', fiatAmountMinor: 55000 });

    const sell = await ask(t, 'SELL', 100);
    await expect(fulfilRequest({
      requestId: sell, actor: 'admin-1', consideration: { currency: 'USDT', fiatAmountMinor: 100, rateUsed: 90 },
    })).rejects.toThrow();
    expect((await getRequest(sell)).status).toBe('PENDING');
  });

  // ── Once only ────────────────────────────────────────────────────────────
  it('a second fulfilment of one request moves nothing', async () => {
    const t = await team();
    const id = await ask(t, 'BUY', 300);
    expect((await fulfilRequest({ requestId: id, actor: 'admin-1', consideration: INR(300) })).ok).toBe(true);
    const before = await getTreasuryBalances();
    expect(await fulfilRequest({ requestId: id, actor: 'admin-2', consideration: INR(300) }))
      .toEqual({ ok: false, reason: 'request_not_pending' });
    expect((await getTreasuryBalances())[ACCOUNTS.TEAM_FLOAT]).toBe(before[ACCOUNTS.TEAM_FLOAT]);
    expect((await getPool(t.teamId)).availablePaise).toBe(T(300));
  });

  it('8 simultaneous fulfilments of one request land exactly once', async () => {
    const t = await team();
    const id = await ask(t, 'BUY', 700);
    const before = await getTreasuryBalances();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      fulfilRequest({ requestId: id, actor: `admin-${i}`, consideration: INR(700) })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.reason === 'request_not_pending')).toBe(true);
    const after = await getTreasuryBalances();
    expect(after[ACCOUNTS.TEAM_FLOAT] - before[ACCOUNTS.TEAM_FLOAT]).toBe(T(700));
    expect((await getPool(t.teamId)).availablePaise).toBe(T(700));
    const { rows } = await pgQuery('SELECT count(*)::int AS n FROM admin_token_considerations WHERE team_id = $1', [t.teamId]);
    expect(rows[0].n).toBe(1);
  });

  // ── Books ────────────────────────────────────────────────────────────────
  it('TEAM_FLOAT moves by exactly what this run\'s pools hold', async () => {
    const start = (await getTreasuryBalances())[ACCOUNTS.TEAM_FLOAT];
    const { rows: s0 } = await pgQuery('SELECT COALESCE(SUM(available_paise + held_paise),0)::bigint AS s FROM team_pools');
    const a = await funded(120);
    const b = await funded(80);
    const id = await ask(b, 'SELL', 30);
    await fulfilRequest({ requestId: id, actor: 'admin-1', consideration: INR(30) });
    const end = (await getTreasuryBalances())[ACCOUNTS.TEAM_FLOAT];
    const { rows: s1 } = await pgQuery('SELECT COALESCE(SUM(available_paise + held_paise),0)::bigint AS s FROM team_pools');
    expect(end - start).toBe(T(170));
    expect(Number(s1[0].s) - Number(s0[0].s)).toBe(T(170));
    expect((await getPool(a.teamId)).availablePaise + (await getPool(b.teamId)).availablePaise).toBe(T(170));
  });

  it('the pool ledger is append-only', async () => {
    const t = await funded(50);
    await expect(pgQuery('UPDATE team_pool_entries SET available_delta_paise = 1 WHERE team_id = $1', [t.teamId])).rejects.toThrow();
    await expect(pgQuery('DELETE FROM team_pool_entries WHERE team_id = $1', [t.teamId])).rejects.toThrow();
  });

  // ── Neighbours ───────────────────────────────────────────────────────────
  it('a team whose pool has history cannot be deleted; an untouched one can', async () => {
    const t = await funded(10);
    expect(await deleteTeam({ teamId: t.teamId, supervisorId: t.sup })).toEqual({ ok: false, reason: 'has_pool_history' });
    const fresh = await team();
    expect(await deleteTeam({ teamId: fresh.teamId, supervisorId: fresh.sup })).toEqual({ ok: true });
  });

  it('a rejected request moves nothing and lists with its reason', async () => {
    const t = await team();
    const id = await ask(t, 'BUY', 90);
    expect(await rejectRequest({ requestId: id, actor: 'admin-1', reason: 'No payment seen' })).toEqual({ ok: true });
    expect(await rejectRequest({ requestId: id, actor: 'admin-1' })).toEqual({ ok: false, reason: 'request_not_pending' });
    expect((await getPool(t.teamId)).availablePaise).toBe(0);
    const [r] = await listRequests({ teamId: t.teamId });
    expect(r).toMatchObject({ status: 'REJECTED', decisionNote: 'No payment seen' });
  });
});
