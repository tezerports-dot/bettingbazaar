// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The DATABASE enforces token conservation. This is where that is proven.
 *
 * The owner's decision (2026-10-07): *"dont run the supply checks each minute
 * i want these live atomic so no double spend could happen, idempotency or
 * anything which make sure that 1 token can't be calculated or used twice."*
 * So there is no periodic reconciliation to catch drift: a transaction that
 * would create, lose or duplicate a token DOES NOT COMMIT.
 *
 * Six guards (`schema.sql`, "TOKEN CONSERVATION, ENFORCED BY THE DATABASE"),
 * each asserted here by the write that breaks it — in raw SQL, because the
 * claim is that the rule holds for EVERY writer, not just for the repository
 * functions that are careful:
 *
 *   wallets_pockets_nonneg             a pocket below zero
 *   wallets_lock_provenance_nonneg     a lock said to come from nowhere
 *   treasury_accounts_sign             tokens never released; a holding below none
 *   treasury_supply_ceiling            more released than exists
 *   bb_conservation_user_float         wallets moving without USER_FLOAT
 *   bb_conservation_team_float         pools moving without TEAM_FLOAT
 *   bb_conservation_pool_available     a pool's available tokens with no entry
 *   bb_conservation_pool_held          a pool's held tokens with no entry
 *   bb_conservation_treasury_entries   a balance moving unrecorded
 *   bb_conservation_movement_balanced  legs that do not sum to zero
 *
 * Every refusal is matched by the opposite assertion — the legitimate movement
 * still commits (§37 step 6) — and by the §37.1 pairs that money paths get
 * wrong: concurrent, duplicate and retried.
 *
 * ── What is NOT enforced here, said plainly (§29) ──────────────────────────
 * TRUNCATE fires no row trigger, and a table owner can set
 * `session_replication_role = replica`. Neither is on any application path;
 * test cleanup uses both, deliberately. `wallet_ledger` is NOT reconciled
 * against `wallets` per user by the database: a stake lock writes a ledger row
 * while the wallet's total is unchanged, so the two are not equal by
 * construction (`ledgerPg` asserts the ledger's own invariants).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, withTransaction, applySchema, closePg } from '../client.js';
import { ACCOUNTS, postMovement, getTreasuryBalances } from '../repositories/treasury.js';
import { applyDeltaPaise, getBalancesPaise, transferPaise } from '../repositories/wallets.core.js';
import { SYSTEM_CONFIG_SPEC } from '../spec/config.spec.js';
import { teamFixture } from '../../backend/tests/teamFixture.js';
import { fundWallet, refusedBy, TEST_FUNDING } from './_funding.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

// Globally-unique keys: a fixed id would collide with the previous run.
const RUN = Math.random().toString(36).slice(2, 8);
let n = 0;
const key = (p) => `cons_${p}_${RUN}_${(n += 1)}`;
const user = (p) => `cons-u-${p}-${RUN}-${(n += 1)}`;

/**
 * The guards are DEFERRED: they run at COMMIT, not at the statement. So a test
 * that wants to see one has to try to commit — a transaction left open proves
 * nothing. `refusedBy` returns the constraint NAME, which is where
 * `RAISE … USING CONSTRAINT` puts it (never in the message).
 */
const commitOf = (statements) => withTransaction(async (client) => {
  for (const [sql, params] of statements) await client.query(sql, params ?? []);
});

describePg('token conservation, enforced by the database', () => {
  const teams = teamFixture();
  let team = null;

  beforeAll(async () => {
    await applySchema();
    // The suite owns its state: the wallets and the treasury start empty, so
    // "the books close" below is a claim about rows this run created (trap 10).
    await pgQuery('TRUNCATE wallets, wallet_ledger, treasury_entries, treasury_accounts RESTART IDENTITY CASCADE');
    // A real team with a real pool, funded through the supervisor's request and
    // the admin's fulfilment — the only path that puts tokens in a pool.
    team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 1000 });
  }, 120_000);

  afterAll(async () => {
    await teams.cleanup();
    await pgQuery('TRUNCATE wallets, wallet_ledger, treasury_entries, treasury_accounts RESTART IDENTITY CASCADE');
    await closePg();
  });

  /** Every token this run created is still in exactly one place. */
  async function booksClose() {
    const { rows: t } = await pgQuery('SELECT COALESCE(SUM(balance_paise), 0)::bigint AS total FROM treasury_accounts');
    const { rows: w } = await pgQuery(`
      SELECT COALESCE(SUM(bb_wallet_value_paise(w)), 0)::bigint AS wallets,
             (SELECT COALESCE(balance_paise, 0) FROM treasury_accounts WHERE account = 'USER_FLOAT') AS float
        FROM wallets w`);
    // The treasury totals zero because every movement's legs do…
    expect(Number(t[0].total), 'the treasury does not total zero').toBe(0);
    // …and USER_FLOAT holds exactly what the wallets hold.
    expect(Number(w[0].wallets), 'USER_FLOAT and the wallets disagree').toBe(Number(w[0].float ?? 0));
  }

  // ════════════════════════════════════════════════════════════════════════
  // SIGNS — no pocket, pool or holding below zero; nothing released twice
  // ════════════════════════════════════════════════════════════════════════
  describe('signs', () => {
    it('REFUSES a pocket below zero, whoever writes it', async () => {
      // `moveBalances` guards this in its UPDATE's WHERE, which makes a debit a
      // refusal rather than an error. The CHECK is the same rule as a property
      // of the ROW, so a writer that never learned the guard cannot write it.
      const refused = await refusedBy(pgQuery(
        'INSERT INTO wallets (user_id, deposit_paise) VALUES ($1, -1)', [user('neg')]));
      expect(refused.constraint).toBe('wallets_pockets_nonneg');
    });

    it('REFUSES a lock that came from nowhere', async () => {
      // `locked_deposit_paise` / `locked_winnings_paise` say which pocket part
      // of `locked` came from. Negative, a returned stake would go back to a
      // pocket it never left.
      const refused = await refusedBy(pgQuery(
        'INSERT INTO wallets (user_id, locked_deposit_paise) VALUES ($1, -1)', [user('prov')]));
      expect(refused.constraint).toBe('wallets_lock_provenance_nonneg');
    });

    it('REFUSES tokens the platform never released (TOKEN_SUPPLY above zero)', async () => {
      const refused = await refusedBy(pgQuery(
        `INSERT INTO treasury_accounts (account, balance_paise) VALUES ('TOKEN_SUPPLY', 1)
         ON CONFLICT (account) DO UPDATE SET balance_paise = 1`));
      expect(refused.constraint).toBe('treasury_accounts_sign');
    });

    it('REFUSES a platform account holding fewer than none', async () => {
      // The house pays a win it cannot cover from the platform's holding
      // (`postHouseSettlement`), never from a negative reserve.
      const refused = await refusedBy(pgQuery(
        `INSERT INTO treasury_accounts (account, balance_paise) VALUES ('HOUSE_RESERVE', -1)
         ON CONFLICT (account) DO UPDATE SET balance_paise = -1`));
      expect(refused.constraint).toBe('treasury_accounts_sign');
    });

    it('REFUSES releasing more tokens than exist', async () => {
      const { rows } = await pgQuery('SELECT bb_token_supply_paise() AS paise');
      const ceiling = Number(rows[0].paise);
      expect(ceiling).toBeGreaterThan(0);
      const refused = await refusedBy(pgQuery(
        `INSERT INTO treasury_accounts (account, balance_paise) VALUES ('TOKEN_SUPPLY', $1)
         ON CONFLICT (account) DO UPDATE SET balance_paise = $1`, [0 - (ceiling + 100)]));
      expect(refused.constraint).toBe('treasury_supply_ceiling');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // THE SUB-LEDGERS MOVE WITH THEIR FLOAT
  // ════════════════════════════════════════════════════════════════════════
  describe('wallets and USER_FLOAT', () => {
    it('REFUSES a wallet that gains tokens with nothing moving the other way', async () => {
      const uid = user('ghost');
      await fundWallet(uid, 10_000, key('seed'));
      const refused = await refusedBy(commitOf([
        ['UPDATE wallets SET deposit_paise = deposit_paise + 5000 WHERE user_id = $1', [uid]],
      ]));
      expect(refused.constraint).toBe('bb_conservation_user_float');
      // Nothing was left behind by the refusal.
      expect((await getBalancesPaise(uid)).depositBalance).toBe(10_000);
      await booksClose();
    });

    it('REFUSES deleting a wallet that still holds tokens', async () => {
      // The same rule in the other direction: tokens cannot be made to vanish
      // by dropping the row that holds them. (This is why the load harness and
      // the operations drill return a wallet's balance before deleting it.)
      const uid = user('del');
      await fundWallet(uid, 7_500, key('seed'));
      const refused = await refusedBy(commitOf([
        ['DELETE FROM wallets WHERE user_id = $1', [uid]],
      ]));
      expect(refused.constraint).toBe('bb_conservation_user_float');
      expect((await getBalancesPaise(uid)).depositBalance).toBe(7_500);
    });

    it('allows deleting an EMPTY wallet, because no token moves', async () => {
      const uid = user('empty');
      await pgQuery('INSERT INTO wallets (user_id) VALUES ($1)', [uid]);
      await commitOf([['DELETE FROM wallets WHERE user_id = $1', [uid]]]);
      const { rows } = await pgQuery('SELECT 1 FROM wallets WHERE user_id = $1', [uid]);
      expect(rows.length).toBe(0);
    });
  });

  describe('pools, TEAM_FLOAT and the pool entries', () => {
    it('REFUSES a pool that gains tokens with nothing moving the other way', async () => {
      const refused = await refusedBy(commitOf([
        ['UPDATE team_pools SET available_paise = available_paise + 5000 WHERE team_id = $1', [team.teamId]],
      ]));
      expect(refused.constraint).toBe('bb_conservation_team_float');
    });

    it('REFUSES available tokens that no pool entry explains', async () => {
      // TEAM_FLOAT and the pool agree, so the float rule passes — but the pool
      // moved with no `team_pool_entries` row, which is the pool's own audit
      // trail. The entry and the balance are one fact.
      const refused = await refusedBy(commitOf([
        ['UPDATE team_pools SET available_paise = available_paise + 5000 WHERE team_id = $1', [team.teamId]],
        [`INSERT INTO treasury_accounts (account, balance_paise) VALUES ('TEAM_FLOAT', 5000)
          ON CONFLICT (account) DO UPDATE SET balance_paise = treasury_accounts.balance_paise + 5000`],
      ]));
      expect(refused.constraint).toBe('bb_conservation_pool_available');
    });

    it('REFUSES held tokens that no pool entry explains', async () => {
      const refused = await refusedBy(commitOf([
        ['UPDATE team_pools SET held_paise = held_paise + 5000 WHERE team_id = $1', [team.teamId]],
        [`INSERT INTO treasury_accounts (account, balance_paise) VALUES ('TEAM_FLOAT', 5000)
          ON CONFLICT (account) DO UPDATE SET balance_paise = treasury_accounts.balance_paise + 5000`],
      ]));
      expect(refused.constraint).toBe('bb_conservation_pool_held');
    });

    it('moves the pool and TEAM_FLOAT by the same amount on the real path', async () => {
      const before = await getTreasuryBalances();
      const { rows: p0 } = await pgQuery(
        'SELECT available_paise + held_paise AS held FROM team_pools WHERE team_id = $1', [team.teamId]);
      await teams.fund(team, 250);
      const after = await getTreasuryBalances();
      const { rows: p1 } = await pgQuery(
        'SELECT available_paise + held_paise AS held FROM team_pools WHERE team_id = $1', [team.teamId]);

      expect(Number(p1[0].held) - Number(p0[0].held)).toBe(25_000);
      expect(after[ACCOUNTS.TEAM_FLOAT] - before[ACCOUNTS.TEAM_FLOAT]).toBe(25_000);
      // …and the tokens came out of the platform's holding, not from nowhere.
      expect(after[ACCOUNTS.TOKEN_SUPPLY] - before[ACCOUNTS.TOKEN_SUPPLY]).toBe(-25_000);
      await booksClose();
    });
  });

  describe('treasury balances and their entries', () => {
    it('REFUSES entries that do not move the balance they describe', async () => {
      const movementId = key('unposted');
      const refused = await refusedBy(commitOf([
        [`INSERT INTO treasury_entries
            (tx_id, movement_id, account, amount_paise, balance_before_paise, balance_after_paise, operation)
          VALUES ($1, $2, 'OPERATIONAL_FLOAT', 500, 0, 500, 'DIRECT_SQL'),
                 ($3, $2, 'TOKEN_SUPPLY', -500, 0, -500, 'DIRECT_SQL')`,
          [`${movementId}_a`, movementId, `${movementId}_b`]],
      ]));
      expect(refused.constraint).toBe('bb_conservation_treasury_entries');
    });

    it('REFUSES legs that do not sum to zero, even written by hand', async () => {
      // The balance and the entry agree here, so the entries rule passes: what
      // is wrong is that 500 paise APPEARED. One movement, two sides, always.
      const movementId = key('onesided');
      const refused = await refusedBy(commitOf([
        [`INSERT INTO treasury_entries
            (tx_id, movement_id, account, amount_paise, balance_before_paise, balance_after_paise, operation)
          VALUES ($1, $2, 'OPERATIONAL_FLOAT', 500, 0, 500, 'DIRECT_SQL')`,
          [`${movementId}_a`, movementId]],
        [`INSERT INTO treasury_accounts (account, balance_paise) VALUES ('OPERATIONAL_FLOAT', 500)
          ON CONFLICT (account) DO UPDATE SET balance_paise = treasury_accounts.balance_paise + 500`],
      ]));
      expect(refused.constraint).toBe('bb_conservation_movement_balanced');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // THE LEGITIMATE MOVEMENTS STILL COMMIT (§37 step 6)
  // ════════════════════════════════════════════════════════════════════════
  describe('the legitimate movements', () => {
    it('credits a wallet when the tokens come from somewhere', async () => {
      const uid = user('ok');
      const before = await getTreasuryBalances();
      await fundWallet(uid, 12_345, key('fund'));
      const after = await getTreasuryBalances();

      expect((await getBalancesPaise(uid)).depositBalance).toBe(12_345);
      expect(after[ACCOUNTS.USER_FLOAT] - before[ACCOUNTS.USER_FLOAT]).toBe(12_345);
      expect(after[ACCOUNTS.TOKEN_SUPPLY] - before[ACCOUNTS.TOKEN_SUPPLY]).toBe(-12_345);
      await booksClose();
    });

    it('moves tokens between a player\'s own pockets with NO counterparty', async () => {
      // Nothing enters or leaves the wallet, so USER_FLOAT must not move —
      // and a counterparty here would be the error.
      const uid = user('pocket');
      await fundWallet(uid, 20_000, key('fund'));
      const before = await getTreasuryBalances();
      const moved = await transferPaise({
        userId: uid, fromField: 'depositBalance', toField: 'tokenBalance', amountPaise: 8_000,
        txId: key('transfer'), reason: 'pocket to pocket',
      });
      expect(moved.ok).toBe(true);
      const after = await getTreasuryBalances();

      expect(await getBalancesPaise(uid)).toMatchObject({ depositBalance: 12_000, tokenBalance: 8_000 });
      expect(after[ACCOUNTS.USER_FLOAT]).toBe(before[ACCOUNTS.USER_FLOAT]);
      await booksClose();
    });

    it('pays a win the house cannot cover out of the platform\'s holding', async () => {
      // A loss fills HOUSE_RESERVE; a win empties it first and takes the rest
      // from TOKEN_SUPPLY. The reserve never goes negative, and the player is
      // paid in full either way.
      const uid = user('house');
      await fundWallet(uid, 30_000, key('fund'));
      const lost = await applyDeltaPaise({
        userId: uid, field: 'depositBalance', deltaPaise: -30_000, txId: key('loss'),
        type: 'DEBIT', reason: 'stake lost to the house',
        counterparty: { house: true, operation: 'TEST_BET_LOST' },
      });
      expect(lost.ok).toBe(true);
      expect((await getTreasuryBalances())[ACCOUNTS.HOUSE_RESERVE]).toBe(30_000);

      const before = await getTreasuryBalances();
      const won = await applyDeltaPaise({
        userId: uid, field: 'winningsBalance', deltaPaise: 50_000, txId: key('win'),
        type: 'CREDIT', reason: 'paid by the house',
        counterparty: { house: true, operation: 'TEST_BET_WON' },
      });
      expect(won.ok).toBe(true);
      const after = await getTreasuryBalances();

      expect((await getBalancesPaise(uid)).winningsBalance).toBe(50_000);
      expect(after[ACCOUNTS.HOUSE_RESERVE]).toBe(0);
      expect(after[ACCOUNTS.TOKEN_SUPPLY] - before[ACCOUNTS.TOKEN_SUPPLY]).toBe(-20_000);
      await booksClose();
    });

    it('unwinds the broken write with its SAVEPOINT, and commits the rest', async () => {
      // The buckets the guard reads are TRANSACTION-LOCAL settings, so they are
      // undone by the savepoint that undoes the row. A caller that catches a
      // refusal and carries on must not be refused at COMMIT for a write that
      // no longer exists — which is what `postMovement`'s savepoint relies on.
      const uid = user('savepoint');
      await fundWallet(uid, 5_000, key('seed'));
      const movementId = key('sp');
      await withTransaction(async (client) => {
        await client.query('SAVEPOINT bad');
        await client.query('UPDATE wallets SET deposit_paise = deposit_paise + 9999 WHERE user_id = $1', [uid]);
        await client.query('ROLLBACK TO SAVEPOINT bad');
        // A balanced platform movement in the same transaction still commits.
        const moved = await postMovement({
          client, movementId, operation: 'TEST_AFTER_SAVEPOINT',
          legs: { [ACCOUNTS.TOKEN_SUPPLY]: -1_000, [ACCOUNTS.OPERATIONAL_FLOAT]: 1_000 },
        });
        expect(moved.ok).toBe(true);
      });
      expect((await getBalancesPaise(uid)).depositBalance).toBe(5_000);
      await booksClose();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §37.1 — concurrent, duplicate, retried
  // ════════════════════════════════════════════════════════════════════════
  describe('the pairs that money paths get wrong', () => {
    it('keeps the books closed under 25 CONCURRENT credits to one wallet', async () => {
      const uid = user('race');
      await fundWallet(uid, 1_000, key('seed'));
      const before = await getTreasuryBalances();
      const results = await Promise.all(Array.from({ length: 25 }, (_, i) => applyDeltaPaise({
        userId: uid, field: 'depositBalance', deltaPaise: 400, txId: `${key('race')}_${i}`,
        type: 'CREDIT', reason: 'concurrent credit', counterparty: TEST_FUNDING,
      })));
      expect(results.every((r) => r.ok)).toBe(true);
      const after = await getTreasuryBalances();

      expect((await getBalancesPaise(uid)).depositBalance).toBe(1_000 + 25 * 400);
      expect(after[ACCOUNTS.USER_FLOAT] - before[ACCOUNTS.USER_FLOAT]).toBe(25 * 400);
      await booksClose();
    });

    it('moves once when the SAME credit is delivered twice', async () => {
      const uid = user('dup');
      const txId = key('dup');
      const credit = () => applyDeltaPaise({
        userId: uid, field: 'depositBalance', deltaPaise: 6_000, txId,
        type: 'CREDIT', reason: 'duplicate delivery', counterparty: TEST_FUNDING,
      });
      const before = await getTreasuryBalances();
      const first = await credit();
      const second = await credit();
      const third = await Promise.all([credit(), credit()]);
      const after = await getTreasuryBalances();

      expect(first).toMatchObject({ ok: true, idempotent: false });
      expect(second).toMatchObject({ ok: true, idempotent: true });
      expect(third.every((r) => r.ok && r.idempotent)).toBe(true);
      // One credit, one treasury leg: the wallet half and the treasury half
      // share one key, so a replay cannot post the counterparty again (that is
      // `treasury_already_posted`).
      expect((await getBalancesPaise(uid)).depositBalance).toBe(6_000);
      expect(after[ACCOUNTS.USER_FLOAT] - before[ACCOUNTS.USER_FLOAT]).toBe(6_000);
      await booksClose();
    });

    it('spends one token ONCE: two concurrent debits of the whole balance', async () => {
      // The owner's sentence, as a test. Both debits are legal on their own;
      // together they would spend the same tokens twice.
      const uid = user('double');
      await fundWallet(uid, 10_000, key('seed'));
      const spend = (i) => applyDeltaPaise({
        userId: uid, field: 'depositBalance', deltaPaise: -10_000, txId: `${key('spend')}_${i}`,
        type: 'DEBIT', reason: 'double spend attempt',
        counterparty: { account: ACCOUNTS.OPERATIONAL_FLOAT, operation: 'TEST_SPEND' },
      });
      const [a, b] = await Promise.all([spend('a'), spend('b')]);

      expect([a.ok, b.ok].filter(Boolean).length, 'both debits were allowed').toBe(1);
      const loser = a.ok ? b : a;
      expect(loser).toMatchObject({ ok: false, insufficient: true });
      expect((await getBalancesPaise(uid)).depositBalance).toBe(0);
      await booksClose();
    });

    it('leaves nothing behind when a debit is refused, so the retry is clean', async () => {
      const uid = user('retry');
      await fundWallet(uid, 2_000, key('seed'));
      const before = await getTreasuryBalances();
      const tooMuch = await applyDeltaPaise({
        userId: uid, field: 'depositBalance', deltaPaise: -5_000, txId: key('over'),
        type: 'DEBIT', reason: 'more than there is',
        counterparty: { account: ACCOUNTS.OPERATIONAL_FLOAT, operation: 'TEST_SPEND' },
      });
      expect(tooMuch).toMatchObject({ ok: false, insufficient: true });
      // The refusal moved no tokens anywhere — not in the wallet, and not in
      // the treasury, where a leg posted before the refusal would be a token
      // in two places.
      expect((await getBalancesPaise(uid)).depositBalance).toBe(2_000);
      expect(await getTreasuryBalances()).toEqual(before);

      const affordable = await applyDeltaPaise({
        userId: uid, field: 'depositBalance', deltaPaise: -2_000, txId: key('retry'),
        type: 'DEBIT', reason: 'the retry',
        counterparty: { account: ACCOUNTS.OPERATIONAL_FLOAT, operation: 'TEST_SPEND' },
      });
      expect(affordable.ok).toBe(true);
      expect((await getBalancesPaise(uid)).depositBalance).toBe(0);
      await booksClose();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // THE CEILING IS THE CONFIGURED SUPPLY, NOT A NUMBER IN SQL
  // ════════════════════════════════════════════════════════════════════════
  describe('the configured supply', () => {
    it('reads the ceiling from SystemConfig.adminTokenSupply.total', async () => {
      const { rows: cfg } = await pgQuery(
        `SELECT (settings #>> '{adminTokenSupply,total}')::numeric AS total
           FROM config_documents WHERE scope = 'system' AND doc_key = 'main'`);
      const { rows } = await pgQuery('SELECT bb_token_supply_paise() AS paise');
      const spec = SYSTEM_CONFIG_SPEC.fields.adminTokenSupply.fields.total.default;
      const total = cfg[0]?.total != null ? Number(cfg[0].total) : spec;
      expect(Number(rows[0].paise)).toBe(total * 100);
    });

    it('falls back to the SPEC default, not a number of its own (§6)', async () => {
      // A fallback that drifted from the spec would mean the database and the
      // admin screen disagree about how many tokens exist. Read the literal out
      // of the function the database is actually running.
      const { rows } = await pgQuery(
        `SELECT pg_get_functiondef('bb_token_supply_paise'::regproc) AS src`);
      const fallback = /COALESCE\([\s\S]*?,\s*(\d+)\s*\)/.exec(rows[0].src);
      expect(fallback, 'bb_token_supply_paise has no COALESCE fallback to read').not.toBeNull();
      expect(Number(fallback[1]))
        .toBe(SYSTEM_CONFIG_SPEC.fields.adminTokenSupply.fields.total.default);
    });
  });
});
