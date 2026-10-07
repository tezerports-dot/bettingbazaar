-- GOVERNANCE: Read CLAUDE.md before editing this file.
-- THE SCHEMA. Requires PostgreSQL >= 14 (CREATE OR REPLACE TRIGGER).
--
-- Every piece of state this platform holds is here: money, identity,
-- configuration, content, engagement. There is no second store.
--
-- Every money column is BIGINT *paise* — the smallest unit. That is this
-- schema's central claim and the fix for the float-rupee round2() pattern it
-- replaced: integer paise is the only representation money has at rest, and
-- rupees exist only above the data layer, for callers and responses.
--
-- Applied idempotently by applySchema() at boot; a failed apply fails startup
-- rather than serving a half-built database (every statement is
-- IF NOT EXISTS / OR REPLACE).
--
-- PARTITIONING STRATEGY (capability 16 — apply WHEN VOLUME WARRANTS, not now):
-- The two unbounded append-only tables (wallet_ledger, accounting_events) are
-- the partitioning candidates — RANGE partition by created_at, one partition per
-- month, so old months can be detached/archived cheaply and index scans stay
-- warm. This is deliberately NOT pre-applied because it interacts with the
-- idempotency contract: PostgreSQL requires a partitioned table's UNIQUE/PRIMARY
-- KEY to INCLUDE the partition key, so `tx_id` / `idempotency_key` uniqueness
-- would have to become UNIQUE(idempotency_key, created_at) — which no longer
-- prevents the same key reappearing in a different month. Preserve the gate by
-- pairing partitioning with an EXCLUDE/global-uniqueness mechanism (e.g. a
-- separate unpartitioned unique index table, or app-level dedup on the key) at
-- the time it is introduced. Until row counts justify it (millions/month), a
-- single table with the btree indexes below outperforms partition overhead.

-- ── USER WALLET LEDGER (mirrors WalletLedger — every balance mutation) ───────
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id                  BIGSERIAL PRIMARY KEY,
  tx_id               TEXT UNIQUE,          -- the idempotency gate (nullable, unique when present)
  user_id             TEXT NOT NULL,
  field               TEXT NOT NULL,        -- depositBalance|winningsBalance|tokenBalance|reserveBalance|lockedBalance
  amount_paise        BIGINT NOT NULL,      -- POSITIVE magnitude; tx_type carries the direction
  balance_after_paise BIGINT NOT NULL,
  tx_type             TEXT,                 -- CREDIT | DEBIT
  description         TEXT,
  ref_id              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The balance a movement started from, so a ledger row is auditable on its own
-- without replaying every row before it. Nullable because rows written before
-- this column existed genuinely do not have one — readers
-- derive those as balance_after ∓ amount from tx_type.
ALTER TABLE wallet_ledger ADD COLUMN IF NOT EXISTS balance_before_paise BIGINT;
CREATE INDEX IF NOT EXISTS wallet_ledger_user_idx ON wallet_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_ledger_user_cursor_idx ON wallet_ledger (user_id, created_at DESC, id DESC);

-- Ledgers are append-only: corrections are new rows, never edits.
CREATE OR REPLACE FUNCTION bb_forbid_change() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only (corrections are new offsetting rows)', TG_TABLE_NAME; END
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER wallet_ledger_append_only
  BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- ── WALLET SNAPSHOT (derived from the ledger; convenience read model) ────────
CREATE TABLE IF NOT EXISTS wallets (
  user_id        TEXT PRIMARY KEY,
  deposit_paise  BIGINT NOT NULL DEFAULT 0,
  winnings_paise BIGINT NOT NULL DEFAULT 0,
  token_paise    BIGINT NOT NULL DEFAULT 0,
  reserve_paise  BIGINT NOT NULL DEFAULT 0,
  locked_paise   BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lock provenance. `locked_paise` says HOW MUCH is locked; these say which
-- pocket it came out of, mirroring the User document's lockedDepositAmount /
-- lockedWinningsAmount. Settlement needs the split to return a stake to the
-- balance it was taken from, so a Postgres-authoritative wallet path cannot
-- work without it. Added as ALTER (not in the CREATE above) so a deployment
-- that already ran this schema picks the columns up on the next boot.
--
-- NOTE for the cutover: no WalletLedger row carries these fields, so the
-- forward mirror never populates them — they are seeded from the User
-- documents by `npm run pg:seed-locks` immediately before a wallet flip.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS locked_deposit_paise  BIGINT NOT NULL DEFAULT 0;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS locked_winnings_paise BIGINT NOT NULL DEFAULT 0;

-- ── ACCOUNTING LEDGER (mirrors AccountingEvent — THE most important table) ───
CREATE TABLE IF NOT EXISTS accounting_events (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,     -- recording the same source event twice is impossible
  event_type      TEXT NOT NULL,
  amount_paise    BIGINT NOT NULL,
  ref_model       TEXT,
  ref_id          TEXT,
  postings        JSONB NOT NULL,           -- [{account, amountPaise}] — double-entry
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounting_events_ref_idx  ON accounting_events (ref_model, ref_id);
CREATE INDEX IF NOT EXISTS accounting_events_type_idx ON accounting_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS accounting_events_type_cursor_idx ON accounting_events (event_type, created_at DESC, id DESC);

-- Genuinely append-only, enforced by the DATABASE not the app (plan requirement).
CREATE OR REPLACE TRIGGER accounting_events_append_only
  BEFORE UPDATE OR DELETE ON accounting_events FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- Double-entry invariant: every event's postings conserve to zero — the same
-- rule the money suites assert against a real database.
CREATE OR REPLACE FUNCTION bb_check_postings_balance() RETURNS trigger AS $$
DECLARE total BIGINT;
BEGIN
  SELECT COALESCE(SUM((p->>'amountPaise')::BIGINT), 0) INTO total
  FROM jsonb_array_elements(NEW.postings) p;
  IF total <> 0 THEN
    RAISE EXCEPTION 'accounting_events postings must conserve to zero (got % paise)', total;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER accounting_events_balanced
  BEFORE INSERT ON accounting_events FOR EACH ROW EXECUTE FUNCTION bb_check_postings_balance();

-- ── REMOVED: the four MIRROR tables ─────────────────────────────────────────
--
-- `payment_orders`, `transactions`, `merchant_wallet_ledger` and the original
-- `utr_registry` were PROJECTIONS of document-store collections, written by a
-- forward mirror so a reader could query either store during a cutover. There
-- is no second store and no cutover, so a projection of one is a table that
-- costs writes and answers nothing. Nothing in `repositories/` read any of
-- them.
--
-- What replaced each:
--   payment_orders        -> `order_states` + `order_transitions`, which own the
--                            lifecycle, the guard on every move, and the
--                            accounting entry written in the same transaction.
--   transactions          -> `wallet_ledger`, append-only and double-entry.
--   merchant_wallet_ledger-> `merchant_wallet_entries`, with a movement_id so
--                            "did movement K happen?" is an identity rather
--                            than a prefix match.
--   utr_registry          -> kept, and defined below with the order it belongs
--                            to, because one UTR to one order is a real rule.
--
-- Dropped explicitly rather than left behind: an empty table with the right
-- name is how a later reader convinces themselves the data is somewhere.
DROP TABLE IF EXISTS payment_orders;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS merchant_wallet_ledger;

-- ── UTR REGISTRY ────────────────────────────────────────────────────────────
-- One UTR belongs to one order, storage-enforced. A bank reference reused
-- across two orders is either a mistake or a fraud attempt, and both are
-- refused by the same primary key.
CREATE TABLE IF NOT EXISTS utr_registry (
  utr           TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL UNIQUE,
  user_id       TEXT,
  amount_paise  BIGINT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE utr_registry ADD COLUMN IF NOT EXISTS amount_paise BIGINT;

-- ─────────────────────────────────────────────────────────────────────────────
-- ADMIN TREASURY (domain 3)
--
-- The platform's own accounts, as DOUBLE ENTRY. Every movement is a set of legs
-- that sums to zero, so the whole ledger sums to zero at all times — which is
-- what turns "the test accounted for that money" into "the books account for
-- it".
--
-- TOKEN_SUPPLY is the contra account and the reason mints conserve. Minting is
-- not value appearing from nowhere: it is TOKEN_SUPPLY going more negative
-- while a float account goes up by the same amount. The negative of
-- TOKEN_SUPPLY is therefore the number of tokens in existence, and a query that
-- says otherwise means something bypassed this table.
--
-- This replaced a single counter — a minted total with a 10B cap — incremented
-- on mint and decremented by a blind, swallowed write on rollback. A counter
-- cannot say WHERE the tokens went, is not
-- idempotent (a retried rollback decrements twice), and permanently overstates
-- supply if the rollback's .catch(() => {}) ever fires.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS treasury_accounts (
  account       TEXT PRIMARY KEY,
  balance_paise BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT treasury_accounts_known CHECK (account IN (
    'TOKEN_SUPPLY',      -- contra: -(every token in existence)
    'USER_FLOAT',        -- tokens held by users
    'HOUSE_RESERVE',     -- stakes the house won
    'COMMISSION_POOL',
    'BONUS_POOL',
    'REFERRAL_POOL',
    'OPERATIONAL_FLOAT'
  ))
);

-- Every leg of every movement, append-only.
--
-- amount_paise is SIGNED here, unlike the wallet ledgers. Those store a
-- magnitude with the direction in entry_type, because every sum-based check
-- over them reads the direction from the type. This table is double-entry,
-- where the sign IS the meaning: the legs of one movement sum to
-- zero, and a magnitude-plus-direction encoding would make that sum express
-- nothing.
CREATE TABLE IF NOT EXISTS treasury_entries (
  id                   BIGSERIAL PRIMARY KEY,
  tx_id                TEXT NOT NULL UNIQUE,
  movement_id          TEXT NOT NULL,
  account              TEXT NOT NULL,
  amount_paise         BIGINT NOT NULL,
  balance_before_paise BIGINT NOT NULL,
  balance_after_paise  BIGINT NOT NULL,
  operation            TEXT NOT NULL,
  actor                TEXT,
  reason               TEXT,
  ref_model            TEXT,
  ref_id               TEXT,
  correlation_id       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT treasury_entries_nonzero CHECK (amount_paise <> 0),
  CONSTRAINT treasury_entries_arithmetic
    CHECK (balance_after_paise = balance_before_paise + amount_paise)
);
CREATE INDEX IF NOT EXISTS treasury_entries_account_idx
  ON treasury_entries (account, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS treasury_entries_movement_idx
  ON treasury_entries (movement_id);
CREATE INDEX IF NOT EXISTS treasury_entries_ref_idx
  ON treasury_entries (ref_model, ref_id);
CREATE OR REPLACE TRIGGER treasury_entries_append_only
  BEFORE UPDATE OR DELETE ON treasury_entries FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- ─────────────────────────────────────────────────────────────────────────────
-- ORDERS — the workflow state machine, and the glue between domains
--
-- These two tables ARE the order. The projection that used to sit beside them
-- was overwritten on every change, kept no history, and guarded nothing about
-- what could follow what — it answered "where is this order now" and nothing
-- else. It is deleted.
--
-- These two make the order's lifecycle authoritative. Every transition
-- names the state it expects to find, so an out-of-order provider callback is
-- refused rather than obeyed, and every transition is recorded so the sequence
-- that produced the current state can be read back.
--
-- The FK from the transitions to the order is what stops a transition existing
-- for an order that does not — a constraint the projection could not have had,
-- because a projection has no authority to refuse anything.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_states (
  order_id           TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  merchant_id        TEXT,
  order_type         TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'PENDING_QUEUE',
  token_amount_paise BIGINT NOT NULL,
  fiat_amount_paise  BIGINT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_states_type_known CHECK (order_type IN ('DEPOSIT', 'WITHDRAWAL')),
  CONSTRAINT order_states_amount_positive CHECK (token_amount_paise > 0),
  -- Nine states, and the CHECK is what makes them the only nine. A state the
  -- constraint does not name cannot be written, so "what can an order be?" is
  -- answered here rather than by reading every writer.
  CONSTRAINT order_states_known CHECK (state IN (
    'PENDING_QUEUE', 'ASSIGNED', 'PROCESSING', 'PAID', 'COMPLETED',
    'DISPUTED', 'CANCELLED', 'FAILED', 'REJECTED'
  ))
);
CREATE INDEX IF NOT EXISTS order_states_user_idx     ON order_states (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_states_merchant_idx ON order_states (merchant_id, state);
CREATE INDEX IF NOT EXISTS order_states_state_idx    ON order_states (state, created_at);

-- Every transition, append-only. `tx_id` UNIQUE is the idempotency gate: a
-- duplicate callback collides inside the transaction and the whole thing
-- unwinds, rather than advancing the order a second time.
CREATE TABLE IF NOT EXISTS order_transitions (
  id          BIGSERIAL PRIMARY KEY,
  tx_id       TEXT NOT NULL UNIQUE,
  order_id    TEXT NOT NULL REFERENCES order_states (order_id),
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  actor       TEXT,
  reason      TEXT,
  -- The ledger event this transition produced, when it produced one. Null for
  -- transitions that move workflow without moving money (ASSIGNED, PROCESSING).
  -- Having it here is what lets an auditor walk from an order to its accounting
  -- entry without guessing at a key format.
  ledger_key  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_transitions_moves CHECK (from_state IS NULL OR from_state <> to_state)
);
CREATE INDEX IF NOT EXISTS order_transitions_order_idx  ON order_transitions (order_id, id);
CREATE INDEX IF NOT EXISTS order_transitions_ledger_idx ON order_transitions (ledger_key);
CREATE OR REPLACE TRIGGER order_transitions_append_only
  BEFORE UPDATE OR DELETE ON order_transitions FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- ── Domain 5: bet lifecycle ────────────────────────────────────────────────
-- A bet's status used to live on the bet record with the stake moved
-- separately. Two defects follow from that split and neither survives here:
--   M-2  the balance move has NO idempotency key, so a replayed request
--        debits twice; and
--   M-4  the ledger is written outside the transaction, so money can move
--        unaudited — and the ledger is what reconciliation is computed from,
--        so the failure erases its own symptom.
-- Here the bet row, its stake movement and its ledger rows commit together or
-- not at all, and `bet_id` is UNIQUE so a replay collides inside the
-- transaction rather than creating a second bet.
CREATE TABLE IF NOT EXISTS bets (
  id              BIGSERIAL PRIMARY KEY,
  bet_id          TEXT NOT NULL UNIQUE,        -- caller's deterministic key
  user_id         TEXT NOT NULL,
  cycle_id        TEXT NOT NULL,
  side            TEXT NOT NULL,
  stake_paise     BIGINT NOT NULL CHECK (stake_paise > 0),
  payout_paise    BIGINT NOT NULL DEFAULT 0 CHECK (payout_paise >= 0),
  status          TEXT NOT NULL,
  placed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bets_status_check
    CHECK (status IN ('PENDING','WON','LOST','VOID','REFUNDED'))
);
-- The bet's PUBLIC id: 24 hex characters, which is the shape every client here
-- expects an entity id to be. DERIVED from bet_id (see publicIdFor) rather than
-- generated, because a freshly generated one per attempt would give a replayed
-- placement a second identity — the very duplication bet_id exists to prevent.
--
-- ALTER, not a column in the CREATE above, and it must stay BEFORE anything
-- that references it. `CREATE TABLE IF NOT EXISTS` is a NO-OP on a table that
-- already exists, so a column added to it never reaches a deployed database —
-- exactly how merchant_wallet_entries.movement_id went missing and took its
-- index down with a 42703.
-- The bet's PUBLIC id: a 24-character hex string derived from the idempotency
-- key, which is the shape every client in this platform expects an entity id to
-- be. Derived rather than generated, so a replayed placement resolves to the
-- same bet instead of minting a second identity for it.
ALTER TABLE bets ADD COLUMN IF NOT EXISTS public_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS bets_public_id_key ON bets (public_id);

-- The winnings platform fee retained from THIS bet's gross payout.
--
-- Not a display field. `Cycle.totalPlatformFees` is derived by summing
-- `Bet.platformFee` over the cycle's WON bets, so a store that owns the
-- settlement but not the fee cannot answer what it retained. The fee is written
-- in the SAME statement as the status and the payout; splitting them would put
-- the accounting number behind a second writer, so a crash between the two
-- leaves a
-- WON bet with a zero fee and silently understates platform revenue.
--
-- payout_paise is NET of this, so gross = payout_paise + platform_fee_paise.
-- Zero for every non-winning transition, and for pre-fee bets.
ALTER TABLE bets ADD COLUMN IF NOT EXISTS platform_fee_paise BIGINT NOT NULL DEFAULT 0
  CONSTRAINT bets_platform_fee_check CHECK (platform_fee_paise >= 0);

CREATE INDEX IF NOT EXISTS bets_user_idx  ON bets (user_id, placed_at DESC);
-- The settlement sweep's query: every unsettled bet on one cycle.
CREATE INDEX IF NOT EXISTS bets_cycle_idx ON bets (cycle_id, status);

CREATE TABLE IF NOT EXISTS bet_transitions (
  id           BIGSERIAL PRIMARY KEY,
  tx_id        TEXT NOT NULL UNIQUE,           -- stops the STATE advancing twice
  bet_id       TEXT NOT NULL REFERENCES bets (bet_id) ON DELETE RESTRICT,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor        TEXT,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bet_transitions_bet_idx ON bet_transitions (bet_id, id);

DROP TRIGGER IF EXISTS bet_transitions_append_only ON bet_transitions;
CREATE TRIGGER bet_transitions_append_only
  BEFORE UPDATE OR DELETE ON bet_transitions
  FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- ── Domain 6: cycle settlement ─────────────────────────────────────────────
-- Settlement used to be a flag flipped on the cycle followed by payouts, with a
-- PROCESSING cycle deliberately RE-ADMITTED so a recovery task could resume an
-- interrupted run. Two passes over one cycle is therefore a
-- supported scenario, and money safety rests entirely on per-bet idempotency.
-- That is a correct design, but it leaves nothing that records what a pass
-- ACTUALLY DID — so a half-finished run cannot be told from a finished one
-- except by re-deriving it from the bets.
--
-- Here a settlement run is a row. It names the cycle, the winning side and the
-- pass that claimed it, and the per-bet outcomes are attributable to it.
CREATE TABLE IF NOT EXISTS cycle_settlements (
  id             BIGSERIAL PRIMARY KEY,
  settlement_id  TEXT NOT NULL UNIQUE,     -- caller's deterministic key
  cycle_id       TEXT NOT NULL UNIQUE,     -- one settlement per cycle, ever
  winning_side   TEXT NOT NULL,
  status         TEXT NOT NULL,
  bets_total     INTEGER NOT NULL DEFAULT 0,
  bets_settled   INTEGER NOT NULL DEFAULT 0,
  payout_paise   BIGINT  NOT NULL DEFAULT 0 CHECK (payout_paise >= 0),
  stake_paise    BIGINT  NOT NULL DEFAULT 0 CHECK (stake_paise >= 0),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cycle_settlements_status_check
    CHECK (status IN ('RUNNING','COMPLETED','VOIDED'))
);
CREATE INDEX IF NOT EXISTS cycle_settlements_status_idx ON cycle_settlements (status, started_at);

-- ── Domain 7: casino provider callbacks ────────────────────────────────────
-- The defect this table exists to remove: a ROLLBACK or REFUND callback that
-- credits the player WITHOUT having to prove a matching prior debit. A provider
-- that is buggy, replayed, or hostile can then mint real money by sending a
-- rollback for a round that never had a bet, and nothing distinguishes that
-- from a legitimate one.
--
-- Every callback is a row keyed on the provider's own tx id, and a rollback
-- must name the round it reverses. The `debited_paise`/`refunded_paise`
-- running totals on the ROUND are what make "you cannot give back more than
-- was taken" checkable inside one transaction.
CREATE TABLE IF NOT EXISTS casino_rounds (
  id              BIGSERIAL PRIMARY KEY,
  -- The PROVIDER's round id. NOT unique on its own: a crash round or a live
  -- table is one round id shared by every player at it, and two providers can
  -- number their rounds the same way. A round here is one player's stake on
  -- one provider's round — `casino_rounds_one_per_player` below.
  round_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  provider_key    TEXT NOT NULL,
  game_id         TEXT,
  debited_paise   BIGINT NOT NULL DEFAULT 0 CHECK (debited_paise  >= 0),
  credited_paise  BIGINT NOT NULL DEFAULT 0 CHECK (credited_paise >= 0),
  refunded_paise  BIGINT NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  -- The whole point: a round can never give back more than it took.
  CONSTRAINT casino_rounds_refund_bound CHECK (refunded_paise <= debited_paise),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS casino_rounds_user_idx ON casino_rounds (user_id, created_at DESC);
-- A round cannot pay out unless it took a stake (owner, 2026-10-01: winnings
-- only where the player bet on that round). Dropped and re-added so the
-- definition converges (CLAUDE.md §32 S31). NOT VALID because a development
-- database can hold rounds the old code credited with no bet: validating them
-- would stop the apply here and leave every statement below unrun. It still
-- binds every INSERT and UPDATE from now on, which is what the rule is about.
ALTER TABLE casino_rounds DROP CONSTRAINT IF EXISTS casino_rounds_win_needs_bet;
ALTER TABLE casino_rounds ADD CONSTRAINT casino_rounds_win_needs_bet
  CHECK (credited_paise = 0 OR debited_paise > 0) NOT VALID;

CREATE TABLE IF NOT EXISTS casino_transactions (
  id            BIGSERIAL PRIMARY KEY,
  tx_id         TEXT NOT NULL UNIQUE,      -- the PROVIDER's id; the idempotency gate
  round_id      TEXT NOT NULL,             -- with provider_key + user_id: casino_transactions_round_fkey
  user_id       TEXT NOT NULL,
  tx_type       TEXT NOT NULL,
  amount_paise  BIGINT NOT NULL CHECK (amount_paise > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT casino_transactions_type_check
    CHECK (tx_type IN ('BET','WIN','ROLLBACK','REFUND'))
);

-- ── A round is one PLAYER's stake on one PROVIDER's round id ───────────────
-- It was keyed on the provider's round id alone (`round_id UNIQUE`). That is
-- one row per slot spin, and wrong for everything multiplayer: a crash round
-- and a live-table round are one round id shared by everybody at the table, so
-- every player after the first was refused, and two providers numbering their
-- rounds from 1 collided. Before that refusal existed the rows MERGED, and one
-- player's rollback was bounded by — and paid against — another player's stake.
-- Keyed (provider, player, round id), each stake is its own row, and "a WIN
-- needs this player's own standing bet" is asked of that row alone.
--
-- Dropped and re-added in this order so an existing database converges
-- (§32 S31): the old foreign key depends on the old global key. The new
-- foreign key and the provider CHECK are NOT VALID because a development
-- database can hold callbacks written before `provider_key` existed, and this
-- table is append-only, so they cannot be backfilled; both bind every write
-- from now on. A fresh database never has an unchecked row.
ALTER TABLE casino_transactions DROP CONSTRAINT IF EXISTS casino_transactions_round_id_fkey;
ALTER TABLE casino_rounds DROP CONSTRAINT IF EXISTS casino_rounds_round_id_key;
ALTER TABLE casino_transactions ADD COLUMN IF NOT EXISTS provider_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS casino_rounds_one_per_player
  ON casino_rounds (provider_key, user_id, round_id);
ALTER TABLE casino_transactions DROP CONSTRAINT IF EXISTS casino_transactions_round_fkey;
ALTER TABLE casino_transactions ADD CONSTRAINT casino_transactions_round_fkey
  FOREIGN KEY (provider_key, user_id, round_id)
  REFERENCES casino_rounds (provider_key, user_id, round_id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE casino_transactions DROP CONSTRAINT IF EXISTS casino_transactions_provider_present;
ALTER TABLE casino_transactions ADD CONSTRAINT casino_transactions_provider_present
  CHECK (provider_key IS NOT NULL) NOT VALID;
DROP INDEX IF EXISTS casino_transactions_round_idx;
CREATE INDEX IF NOT EXISTS casino_transactions_round_key_idx
  ON casino_transactions (provider_key, user_id, round_id, id);

DROP TRIGGER IF EXISTS casino_transactions_append_only ON casino_transactions;
CREATE TRIGGER casino_transactions_append_only
  BEFORE UPDATE OR DELETE ON casino_transactions
  FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- ── Domain 8: bonuses and commissions ──────────────────────────────────────
-- Both are money the PLATFORM gives away, and the treasury already models the
-- pools they come out of (BONUS_POOL, REFERRAL_POOL, COMMISSION_POOL). Paying
-- from a pool rather than crediting from nowhere is what keeps the closed-books
-- invariant true: a bonus is a transfer, not a mint.
CREATE TABLE IF NOT EXISTS bonus_grants (
  id             BIGSERIAL PRIMARY KEY,
  grant_id       TEXT NOT NULL UNIQUE,     -- caller's deterministic key
  user_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,            -- SIGNUP, REFERRAL, CASHBACK, COMMISSION, …
  pool           TEXT NOT NULL,            -- the treasury account it is paid from
  amount_paise   BIGINT NOT NULL CHECK (amount_paise > 0),
  status         TEXT NOT NULL,
  ref_model      TEXT,
  ref_id         TEXT,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bonus_grants_status_check
    CHECK (status IN ('PAID','CLAWED_BACK'))
);
CREATE INDEX IF NOT EXISTS bonus_grants_user_idx ON bonus_grants (user_id, granted_at DESC);
CREATE INDEX IF NOT EXISTS bonus_grants_kind_idx ON bonus_grants (kind, status);

-- ═══════════════════════════════════════════════════════════════════════════
-- IDENTITY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT IS DELIBERATELY NOT HERE: balances.
--
-- The document this replaces carried depositBalance, winningsBalance,
-- lockedBalance, lockedDepositAmount, lockedWinningsAmount and reserveBalance
-- alongside the identity fields. Those live in `wallets`, in integer paise,
-- behind a row lock — and a copy of a balance on this table would be a SECOND
-- WRITER waiting to disagree with the first. Every balance read, for display or
-- for a decision, goes to `wallets`. Do not add a balance column here, not even
-- a cached one, not even "just for the admin list".
CREATE TABLE IF NOT EXISTS users (
  user_id            TEXT PRIMARY KEY,     -- the account's stable identity
  username           TEXT NOT NULL,
  mobile             TEXT NOT NULL UNIQUE, -- never mutable, by anyone (§1)
  -- Absent means "cannot sign in with a password", which is the CORRECT state
  -- for a player: players authenticate through Telegram and never set one.
  -- Admins, sub-admins and merchants have one so their access does not depend
  -- on a third party that can suspend an account.
  password_hash      TEXT,

  -- ── Referral programme identity ──────────────────────────────────────────
  -- Assigned once, when onboarding COMPLETES, never at first contact: a
  -- half-finished signup must not consume a number. The payout queue is ordered
  -- by this, so it is unique and strictly increasing, and it comes from an
  -- atomic counter rather than a count of rows.
  joining_number     BIGINT UNIQUE,
  -- What a player shares. Distinct from joining_number so a public link does not
  -- leak the platform's member count or a person's position in it.
  referral_code      TEXT UNIQUE,
  -- Held rather than derived: the click rows it counts are deleted continuously
  -- by retention, so the aggregate is the thing that must survive, not the
  -- evidence.
  referral_clicks    BIGINT NOT NULL DEFAULT 0 CHECK (referral_clicks >= 0),
  referred_by        TEXT REFERENCES users (user_id) ON DELETE SET NULL,

  -- ── Account state ────────────────────────────────────────────────────────
  status             TEXT NOT NULL DEFAULT 'ACTIVE',
  wallet_address     TEXT UNIQUE,
  profile_pic        TEXT NOT NULL DEFAULT '',
  warning_count      INT  NOT NULL DEFAULT 0 CHECK (warning_count >= 0),

  -- ── Payment risk flags ───────────────────────────────────────────────────
  payment_flagged    BOOLEAN NOT NULL DEFAULT FALSE,
  payment_flag_reason TEXT NOT NULL DEFAULT '',
  payment_flagged_at TIMESTAMPTZ,
  payment_flag_count INT NOT NULL DEFAULT 0 CHECK (payment_flag_count >= 0),

  -- ── Roles ────────────────────────────────────────────────────────────────
  is_admin           BOOLEAN NOT NULL DEFAULT FALSE,
  is_sub_admin       BOOLEAN NOT NULL DEFAULT FALSE,
  is_queue_manager   BOOLEAN NOT NULL DEFAULT FALSE,
  is_mediator        BOOLEAN NOT NULL DEFAULT FALSE,
  sub_admin_role     TEXT NOT NULL DEFAULT 'CUSTOM',
  -- JSONB rather than 8 boolean columns: the permission set is read as a whole
  -- on every authorisation check and is edited as a whole from the admin panel.
  -- The KEYS are still governed — utils/permissions.ts is the one declaration —
  -- and an unknown key here is a bug, not a feature.
  sub_admin_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  phantom_access     TEXT NOT NULL DEFAULT 'NONE',

  -- ── Second factor ────────────────────────────────────────────────────────
  -- MANDATORY for admins and sub-admins, available to merchants, and not
  -- applicable to players (who have no password to protect).
  two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  two_factor_secret  TEXT,
  two_factor_pending_secret TEXT,
  -- The last accepted TOTP counter. Storing it is what makes a replay of an
  -- observed code fail: a code is valid for a window, and without this the same
  -- code works twice inside it.
  two_factor_last_counter BIGINT,
  two_factor_enrolled_at TIMESTAMPTZ,

  -- ── Blocking ─────────────────────────────────────────────────────────────
  is_blocked         BOOLEAN NOT NULL DEFAULT FALSE,
  block_reason       TEXT,
  blocked_at         TIMESTAMPTZ,
  blocked_by         TEXT,

  -- ── Payout destination ───────────────────────────────────────────────────
  -- One JSONB rather than four columns: it is written and read as a unit, and
  -- an account number that disagrees with its IFSC is worse than either being
  -- absent, so they must move together.
  bank_details       JSONB,

  last_login         TIMESTAMPTZ NOT NULL DEFAULT now(),
  joined_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_status_check
    CHECK (status IN ('ACTIVE','BLOCKED','SUSPENDED','DELETED')),
  CONSTRAINT users_phantom_access_check
    CHECK (phantom_access IN ('NONE','1_MIN','30_MIN','FULL_DAY','BOTH')),
  CONSTRAINT users_sub_admin_role_check
    CHECK (sub_admin_role IN ('PHANTOM_MANAGER','PHANTOM_EQUALIZER','USER_OPS',
                              'MERCHANT_OPS','CONTENT_MANAGER','ANALYST','CUSTOM')),
  -- A blocked account must say why and when. "Blocked, reason unknown" is a
  -- support ticket nobody can answer and an appeal nobody can review.
  CONSTRAINT users_blocked_has_reason
    CHECK (NOT is_blocked OR (block_reason IS NOT NULL AND blocked_at IS NOT NULL))
);

-- Single-use 2FA recovery codes, hashed.
--
-- An array rather than a table: they are written as a SET (enrolment mints ten,
-- consuming one rewrites the remainder) and never queried individually, so a
-- child table would add a join and a delete path for no read this code makes.
-- Like the TOTP secret, these are returned only by the function that exists to
-- read them — a recovery code in a response body is a second factor given away.
ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_codes TEXT[] NOT NULL DEFAULT '{}';

-- Coarse role tags, distinct from the is_* booleans that gate authorisation.
-- The booleans decide what an account MAY DO and are what every check reads;
-- this is descriptive (a merchant's linked login carries 'merchant'). Do not
-- start authorising from it — two sources for one decision is how they drift.
ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}';

-- Soft deletion, with its provenance. `status = 'DELETED'` says an account is
-- gone; these say WHO removed it and WHEN, which is the part a dispute needs.
-- The admin route set all three on the document and only status survived the
-- move, so a deleted account carried no record of the deletion at all.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by TEXT;
-- A deleted account must say who deleted it. Without this the two columns are
-- optional decoration and the first busy afternoon leaves them empty.
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_deleted_has_actor
    CHECK (status <> 'DELETED' OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS users_status_idx        ON users (status);
CREATE INDEX IF NOT EXISTS users_referred_by_idx   ON users (referred_by) WHERE referred_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_joined_at_idx     ON users (joined_at DESC);
-- The admin user list filters on these two constantly and they are rare, so a
-- partial index is both smaller and the one the planner actually picks.
CREATE INDEX IF NOT EXISTS users_admins_idx        ON users (user_id) WHERE is_admin OR is_sub_admin;
CREATE INDEX IF NOT EXISTS users_flagged_idx       ON users (payment_flagged_at DESC) WHERE payment_flagged;

-- ── Telegram: the configuration generation ───────────────────────────────────
--
-- `generation` is monotonic and bumped ONLY when the channel changes, never
-- when a bot is swapped. The two have different blast radii: a cached "this
-- user is a member" is meaningful only for the channel it was observed in, so
-- swapping channels must invalidate every cached answer — which the counter
-- does by construction. Swapping a bot invalidates nothing, because identities
-- key on the person's Telegram id, a property of Telegram rather than of our
-- bot. Tying the two would force every player to re-join a channel to fix a
-- problem that never touched it.
CREATE TABLE IF NOT EXISTS telegram_configs (
  generation           BIGINT PRIMARY KEY,
  -- WHICH PANEL this channel belongs to. The three panels are three separate
  -- entities (§33.5) and each has its own bot and its own channel, so "the
  -- active config" is a question per audience, not a question per platform.
  --
  -- `generation` stays GLOBALLY unique — one counter across all three — which
  -- is deliberate and load-bearing: a cached membership stamped with the
  -- merchant channel's generation can then never compare equal to the player
  -- channel's, so a cross-audience stale answer is unrepresentable rather than
  -- merely unlikely.
  audience             TEXT NOT NULL DEFAULT 'PLAYER',
  -- Ciphertext, always. Whoever holds a bot token can read every message sent
  -- to the bot and speak as the platform. Never returned to any panel.
  bot_token_encrypted  TEXT,
  bot_username         TEXT NOT NULL DEFAULT '',
  webhook_secret       TEXT,
  recovery_bot_token_encrypted TEXT,
  recovery_bot_username TEXT NOT NULL DEFAULT '',
  recovery_webhook_secret TEXT,
  channel_id           TEXT NOT NULL,
  channel_username     TEXT NOT NULL DEFAULT '',
  channel_invite_link  TEXT NOT NULL DEFAULT '',
  active               BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at         TIMESTAMPTZ,
  activated_by         TEXT,
  reason               TEXT NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT telegram_configs_audience_check
    CHECK (audience IN ('PLAYER','STAFF','MERCHANT'))
);
-- At most one active generation, as the DATABASE's rule rather than something
-- every writer has to remember: activating a new one must deactivate the old
-- in the same transaction, or fail.
-- On an existing database `CREATE TABLE IF NOT EXISTS` is a no-op, so the column
-- the index below names has to be added here — before the index, not in a
-- migration block at the end of the file, which is where the first draft put it
-- and where it ran far too late to help.
ALTER TABLE telegram_configs ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'PLAYER';
CREATE UNIQUE INDEX IF NOT EXISTS one_active_telegram_config
  ON telegram_configs (audience) WHERE active;

-- ── Telegram: the bot registry ───────────────────────────────────────────────
--
-- Exists so that replacing a suspended bot is one click on a row that already
-- exists, rather than creating, naming and verifying a bot during the outage
-- where nobody can sign up. STANDBY is the point of the table.
CREATE TABLE IF NOT EXISTS telegram_bots (
  bot_id          TEXT PRIMARY KEY,   -- Telegram's numeric id: the real identity
  label           TEXT NOT NULL,
  role            TEXT NOT NULL,
  -- WHICH PANEL this bot serves. One bot serves exactly one audience, which is
  -- why this is a column on the row rather than a join: the whole point of the
  -- split is that a merchant never opens the player bot and an admin never
  -- opens either (owner, 2026-09-24).
  audience        TEXT NOT NULL DEFAULT 'PLAYER',
  username        TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  webhook_secret  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'STANDBY',

  -- GENERATED, not maintained by application code.
  --
  -- This column exists only to be indexed: it holds the role for a LIVE bot in
  -- a SINGULAR role and NULL otherwise, so the partial unique index below makes
  -- "at most one live bot in that role" a rule the database enforces.
  --
  -- The document model derived it in a pre-validate hook, which meant a writer
  -- using an update operator instead of a document save bypassed the hook
  -- entirely and left the invariant unguarded — a live-bot promotion that set
  -- status without recomputing the slot would have been accepted. Generating it
  -- from the row removes the requirement to remember, and there is no writer
  -- that can get it wrong.
  --
  -- ── `signin` is a FLEET, and deliberately not in this list ────────────────
  -- One bot is a throughput ceiling, not a design: the Bot API allows roughly
  -- THIRTY messages a second per bot, and every signup sends several. An
  -- operator runs as many sign-in bots as they need — the owner's figure was
  -- 500 to 1,000 — and each account is assigned one of them in rotation
  -- (`assignSigninBot`). They all do the same job, so which one a player gets
  -- does not matter to the player; what matters is that no single one is the
  -- whole platform's front door.
  --
  -- `recovery` stays singular. There is exactly one account-recovery
  -- conversation and it is the one path that hands an account to a DIFFERENT
  -- Telegram account, so it stays a single, watchable door.
  --
  -- ── The slot is per AUDIENCE ──────────────────────────────────────────────
  -- "One live recovery bot" is a rule about one panel's recovery conversation,
  -- not about the platform: the player, merchant and staff doors are three
  -- separate doors and each gets exactly one. Composing the audience into the
  -- slot value is what makes the single partial unique index below say that,
  -- rather than refusing the second audience's recovery bot outright — which
  -- is what a slot holding the bare role did, silently, on the second INSERT.
  live_slot       TEXT GENERATED ALWAYS AS (
                    CASE WHEN status = 'ACTIVE' AND role = 'recovery'
                         THEN audience || ':' || role END
                  ) STORED,

  webhook_url     TEXT NOT NULL DEFAULT '',
  webhook_registered_at TIMESTAMPTZ,
  last_error      TEXT NOT NULL DEFAULT '',
  added_by        TEXT,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at    TIMESTAMPTZ,
  activated_by    TEXT,
  retired_at      TIMESTAMPTZ,
  retired_by      TEXT,
  notes           TEXT NOT NULL DEFAULT '',

  CONSTRAINT telegram_bots_role_check
    CHECK (role IN ('signin','recovery','broadcast','moderation','generic')),
  CONSTRAINT telegram_bots_status_check
    CHECK (status IN ('ACTIVE','STANDBY','RETIRED')),
  CONSTRAINT telegram_bots_audience_check
    CHECK (audience IN ('PLAYER','STAFF','MERCHANT'))
);
-- Partial rather than sparse: rows with no live_slot are not indexed at all, so
-- any number of standby, retired and outbound-only bots coexist.
ALTER TABLE telegram_bots ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'PLAYER';
CREATE UNIQUE INDEX IF NOT EXISTS one_live_bot_per_singular_role
  ON telegram_bots (live_slot) WHERE live_slot IS NOT NULL;
CREATE INDEX IF NOT EXISTS telegram_bots_role_status_idx
  ON telegram_bots (audience, role, status);

-- ── Telegram: what the bot says ──────────────────────────────────────────────
-- A missing or blank row means THE SHIPPED DEFAULT, never silence: a player
-- staring at nothing after /start is the worst outcome this table can produce.
CREATE TABLE IF NOT EXISTS telegram_templates (
  key        TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- ── Telegram: one Telegram account ↔ one platform account ────────────────────
CREATE TABLE IF NOT EXISTS telegram_identities (
  telegram_user_id  TEXT NOT NULL,
  -- WHICH PANEL this link is for, and why it is part of the KEY.
  --
  -- One person may hold a player account, a merchant account and a staff
  -- account on one mobile (§33.5), and they will open all three bots from the
  -- SAME Telegram account — that is what a Telegram account is. A bare
  -- `telegram_user_id` primary key made the second one impossible: sharing a
  -- contact with the merchant bot answered "this Telegram account is already
  -- verifying a different account", naming the player link the person had made
  -- minutes earlier, and there was no way past it from either side.
  audience          TEXT NOT NULL DEFAULT 'PLAYER',
  -- One Telegram account cannot hold two platform accounts (the PRIMARY KEY),
  -- and one platform account cannot be driven by two ACTIVE Telegram accounts
  -- (`one_active_identity_per_user` below). That pair IS the
  -- no-duplicate-accounts rule, enforced by the database rather than by a
  -- check-then-insert that a concurrent signup fits between.
  user_id           TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  telegram_username TEXT NOT NULL DEFAULT '',
  first_name        TEXT NOT NULL DEFAULT '',

  -- Telegram's own verified number for the account, which is why it can stand
  -- in for an SMS OTP. Normalised to digits so it compares to users.mobile.
  phone             TEXT NOT NULL,
  contact_shared_at TIMESTAMPTZ NOT NULL,
  contact_active    BOOLEAN NOT NULL DEFAULT TRUE,

  -- A CACHE. Telegram is authoritative; this is updated by chat_member events
  -- with a sweep for the ones we miss, because polling per request does not
  -- survive the member counts this platform plans for.
  channel_status    TEXT NOT NULL DEFAULT 'unknown',
  channel_checked_at TIMESTAMPTZ,
  -- Which generation's channel the status above refers to. An admin swapping
  -- the channel makes this stale BY CONSTRUCTION, and the gate then reads the
  -- user as "must join the new channel" rather than trusting an old answer.
  channel_generation BIGINT NOT NULL DEFAULT 0,
  linked_generation  BIGINT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ,

  PRIMARY KEY (telegram_user_id, audience),

  CONSTRAINT telegram_identities_channel_status_check
    CHECK (channel_status IN ('member','administrator','creator','restricted','left','kicked','unknown')),
  CONSTRAINT telegram_identities_audience_check
    CHECK (audience IN ('PLAYER','STAFF','MERCHANT'))
);
-- The phone is an identity anchor: two Telegram accounts sharing one number
-- must not become two platform accounts. Partial on contact_active so somebody
-- who genuinely moves their number to a new Telegram account (the recovery
-- path) is not blocked by their own retired row.
-- Partial on `contact_active`, exactly like the phone index below, and for the
-- same reason: ACCOUNT RECOVERY has to hand an account from one Telegram
-- identity to another, and the old row must survive as history.
--
-- A plain UNIQUE on user_id could not express that. Recovery would have had to
-- DELETE the identity that lost the account — erasing the record of who used to
-- hold it, which is the first thing a takeover review asks for — or point it at
-- some placeholder account, which the foreign key refuses. Partial, the old row
-- keeps its real user_id, goes inactive, and stays readable.
ALTER TABLE telegram_identities ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'PLAYER';
CREATE UNIQUE INDEX IF NOT EXISTS one_active_identity_per_user
  ON telegram_identities (user_id) WHERE contact_active;
DO $$ BEGIN
  ALTER TABLE telegram_identities DROP CONSTRAINT IF EXISTS telegram_identities_user_id_key;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- Per AUDIENCE, for the reason the primary key is: one mobile legitimately
-- holds one account on each panel, so the rule "two Telegram accounts sharing
-- one number must not become two platform accounts" is a rule WITHIN a panel.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_identity_per_phone
  ON telegram_identities (phone, audience) WHERE contact_active;
CREATE INDEX IF NOT EXISTS telegram_identities_channel_idx
  ON telegram_identities (channel_generation, channel_status);

-- ── Telegram: the half-finished conversation — REMOVED 2026-09-23 ──────────
--
-- `telegram_pending_links` held an onboarding conversation: the step, the
-- Aadhaar hash and ciphertext captured over a chat, and the referral code from
-- the deep link. None of those exist any more. The FORM creates the account
-- (domains/identity/playerAuth.routes.js), so by the time anybody opens a bot
-- there is a row in `users` to match a contact share against — which is what
-- `linkTelegramToAccount` does, and why there is no half-finished state to
-- park anywhere.
--
-- Deleted rather than left standing: a table nothing writes is the next
-- reader's false lead (§3, §22), and this one would read as though the
-- platform still took Aadhaar numbers over Telegram.

-- ── The bot can no longer sign anybody in — REMOVED 2026-09-23 ────────────
--
-- Two tables went together, because they were two spellings of one thing: a
-- credential a BOT could mint. `telegram_login_tokens` held the one-time link
-- the bot DMed after signup; `telegram_login_codes` held the six-digit code it
-- sent to a returning player.
--
-- Players have passwords now (the signup form sets one), so both are replaced
-- by `POST /api/v1/auth/login` — and that is the security half of the change,
-- not a side effect. A compromised, suspended or impersonated bot could
-- previously hand out sessions; the fleet makes that worse by multiplying the
-- number of tokens that would do it. Nothing the bot can do now grants access:
-- it proves a phone number and admits somebody to a channel.
--
-- Deleted rather than left standing. A credential table nothing writes is
-- still a credential table, and the next reader has no way to know it is dead.

-- ── Revoked tokens ───────────────────────────────────────────────────────────
-- Checked on every authenticated request, so it is a primary-key lookup and
-- nothing else. Same expiry posture as above: the READ decides, the sweep only
-- reclaims — a revoked token must not become valid again because a cron job
-- was late.
CREATE TABLE IF NOT EXISTS token_blacklist (
  token      TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS token_blacklist_expiry_idx ON token_blacklist (expires_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- TWO TABLES FOR CODE THAT WAS ALREADY DEAD
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ChatMessage and BalanceAdjustment were referenced through the document store
-- and DEFINED NOWHERE. Every call raised MissingSchemaError, and every call site
-- swallowed it — so order chat never persisted and the admin adjustment audit
-- row was never written. Nothing reported any of it.
--
-- There was a third, `blocked_ips`, for an IP deny-list that was never mounted.
-- It is dropped here and REBUILT below as `ip_blocks` (owner, 2026-09-30:
-- "build it properly"). A new name rather than the old one, so a database that
-- still holds the old shape converges on what this file says (§32 S31).
DROP TABLE IF EXISTS blocked_ips;

-- ── The IP deny-list ─────────────────────────────────────────────────────────
--
-- An admin blocks an address or a range; `middleware/ipBlocklist.js` refuses
-- every request from it before the rate limiters, the audit writer or any route
-- runs. The live list is held in memory (Node's `net.BlockList`) and reloaded
-- from this table — so a blocked address costs one in-memory lookup, not a
-- query per request.
--
-- A RANGE, because an abusive client rarely keeps one address; a `CIDR` column
-- so the database, not a regex, decides what a valid range is. `network()` is
-- applied on write, so 203.0.113.7/24 is stored as 203.0.113.0/24 and one
-- range cannot be entered twice under two spellings.
--
-- Nothing is deleted. A release keeps the row, stamped — "was this address ever
-- blocked, by whom, and why?" is what an appeal asks.
CREATE TABLE IF NOT EXISTS ip_blocks (
  block_id    TEXT PRIMARY KEY,
  network     CIDR NOT NULL,
  reason      TEXT NOT NULL,
  blocked_by  TEXT NOT NULL,
  blocked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A temporary block lapses by itself: the enforcer loads only rows whose
  -- expiry is in the future, so a late sweep cannot keep a lapsed block alive.
  expires_at  TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  released_by TEXT,
  CONSTRAINT ip_blocks_reason_present CHECK (length(btrim(reason)) > 0),
  CONSTRAINT ip_blocks_release_pair   CHECK ((released_at IS NULL) = (released_by IS NULL)),
  CONSTRAINT ip_blocks_expiry_future  CHECK (expires_at IS NULL OR expires_at > blocked_at)
);
-- One unreleased row per range: blocking it again refreshes that row rather
-- than stacking a second one that a release would leave behind.
CREATE UNIQUE INDEX IF NOT EXISTS ip_blocks_one_open_per_network
  ON ip_blocks (network) WHERE released_at IS NULL;

-- ── Order chat ───────────────────────────────────────────────────────────────
-- The conversation between a player and a merchant about one payment order.
-- It is the evidence a dispute is decided from, so it is append-only in
-- practice: nothing edits a message, and deleting one destroys the record of
-- what was agreed.
CREATE TABLE IF NOT EXISTS chat_messages (
  id          BIGSERIAL PRIMARY KEY,
  order_id    TEXT NOT NULL,
  -- NULLABLE, and that is the point: a SYSTEM message has no sender. The call
  -- sites pass `senderId: null` for those.
  sender_id   TEXT,
  sender_type TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  -- The CDN object, and the key it was verified under. The key is kept so an
  -- attachment can be traced back to the upload that was checked, which is the
  -- only thing separating a verified object from an arbitrary URL a client sent.
  attachment_url TEXT,
  attachment_key TEXT,
  -- Not derivable from sender_type: a dispute resolution posts a SYSTEM notice
  -- as senderType 'ADMIN', and the client renders those differently.
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Who may send (`chat_messages_sender_type_check`) is defined ONCE, at the
  -- end of this file with Step 2f, where a supervisor joined the senders.
  -- A message with neither text nor an attachment is not a message.
  CONSTRAINT chat_messages_has_content
    CHECK (message <> '' OR attachment_url IS NOT NULL),
  -- Only a SYSTEM message may have no sender. Anything else without one is a
  -- message nobody can be held to.
  CONSTRAINT chat_messages_sender_required
    CHECK (sender_id IS NOT NULL OR sender_type = 'SYSTEM')
);
CREATE INDEX IF NOT EXISTS chat_messages_order_idx ON chat_messages (order_id, created_at, id);

-- ── Admin balance adjustments ────────────────────────────────────────────────
--
-- WHO moved money by hand, for whom, how much, and why. The wallet ledger
-- records the movement; this records the DECISION behind it, which is what an
-- audit of an adjustment actually asks about.
--
-- The amounts are integer paise like every other money column here. The route
-- that writes this spoke rupees and floats, which is how an adjustment of
-- ₹0.1 + ₹0.2 becomes ₹0.30000000000000004 in an audit record.
CREATE TABLE IF NOT EXISTS balance_adjustments (
  adjustment_id  TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  admin_id       TEXT NOT NULL,
  tx_type        TEXT NOT NULL,
  field          TEXT NOT NULL,
  amount_paise   BIGINT NOT NULL CHECK (amount_paise > 0),
  before_paise   BIGINT NOT NULL,
  after_paise    BIGINT NOT NULL,
  reason         TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT balance_adjustments_type_check CHECK (tx_type IN ('CREDIT','DEBIT')),
  CONSTRAINT balance_adjustments_field_check
    CHECK (field IN ('depositBalance','winningsBalance','tokenBalance','reserveBalance')),
  -- The arithmetic has to close. An audit row whose before and after do not
  -- differ by the amount it claims is worse than no row: it looks authoritative
  -- and is wrong.
  CONSTRAINT balance_adjustments_arithmetic
    CHECK (after_paise = before_paise + (CASE WHEN tx_type = 'CREDIT' THEN amount_paise ELSE -amount_paise END)),
  -- A reason is not optional. "Adjusted by admin, reason blank" is an audit
  -- trail that answers nothing.
  CONSTRAINT balance_adjustments_has_reason CHECK (reason <> '')
);
CREATE INDEX IF NOT EXISTS balance_adjustments_user_idx  ON balance_adjustments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS balance_adjustments_admin_idx ON balance_adjustments (admin_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- MERCHANTS — the settlement counterparties
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A merchant account settles real INR and USDT. It is not a player-grade
-- record: it carries login credentials, a mandatory second factor, payment
-- credentials that money is sent to, and the scoring inputs that decide which
-- merchant a player's order is routed to.
--
-- The token balance is NOT here. A merchant holds none: their team's pool does
-- (`team_pools`). That is the same rule the player wallet follows and the
-- reason `users` has no balance columns either.
CREATE TABLE IF NOT EXISTS merchants (
  merchant_id  TEXT PRIMARY KEY,
  -- The player account this merchant is operated by, when there is one. UNIQUE:
  -- one account cannot be two merchants, or an order routed to "the merchant
  -- for this user" is ambiguous.
  user_id      TEXT UNIQUE,
  name         TEXT NOT NULL,
  -- The reference shown to players and printed on receipts. Immutable, and
  -- enforced by a trigger below rather than by a flag on a schema object: the
  -- document store's `immutable: true` is honoured by document saves and
  -- ignored by an update operator, which is not immutability.
  public_ref   TEXT NOT NULL UNIQUE,

  username     TEXT,
  mobile       TEXT,
  email        TEXT,
  -- No password here. A merchant's login is its `users` row (§33.5), and the
  -- password lives there, once. It was stored in both places: the reset
  -- wrote `users`, the login door read this column, so a merchant who reset
  -- was told it worked and was then refused the new password (R6, 2026-09-30).

  -- ── Second factor. Mandatory for merchants ────────────────────────────────
  -- Same column names as `users`, deliberately: the drift window, replay guard
  -- and recovery-code logic in identity/verifySecondFactor.js operates on
  -- either. Two copies of an anti-replay guard is how one of them goes stale.
  two_factor_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  two_factor_secret          TEXT,   -- AES-256-GCM ciphertext
  two_factor_pending_secret  TEXT,
  two_factor_last_counter    BIGINT,
  two_factor_enrolled_at     TIMESTAMPTZ,
  backup_codes               TEXT[] NOT NULL DEFAULT '{}',  -- sha256 hashes, single use

  status            TEXT NOT NULL DEFAULT 'PENDING',
  suspension_reason TEXT,
  is_online         BOOLEAN NOT NULL DEFAULT FALSE,
  accepts_deposits    BOOLEAN NOT NULL DEFAULT TRUE,
  accepts_withdrawals BOOLEAN NOT NULL DEFAULT TRUE,

  -- ── The rail, and why it is still an array ────────────────────────────────
  -- A merchant settles on EXACTLY ONE rail. The array shape is kept because it
  -- is what merchantScoring and the admin capabilities route already filter on;
  -- the cardinality is enforced by a CHECK, so the "exactly one" rule is a
  -- property of the row rather than of a validator that update operators skip.
  accepted_currencies TEXT[] NOT NULL DEFAULT ARRAY['INR'],
  -- The scalar view panels want. A GENERATED column, not a stored copy and not
  -- an application-layer virtual: derived in the database, so it cannot drift
  -- from the array and cannot be written independently of it.
  merchant_type TEXT GENERATED ALWAYS AS (accepted_currencies[1]) STORED,

  -- ── Payment credentials. Money is sent to these ───────────────────────────
  -- A bank account on the INR rail, never a UPI handle (CLAUDE.md §2 "How each
  -- rail is paid", §24): `bank_upi_id` is dropped below.
  bank_account_holder_name TEXT,
  bank_name                TEXT,
  bank_account_no          TEXT,
  bank_ifsc                TEXT,
  -- TRC-20 (Tron), base58 and CASE-SENSITIVE. Uppercasing corrupts an address
  -- and USDT sent to a corrupted address is unrecoverable, so the format is
  -- checked by the row rather than trusted to the caller.
  usdt_wallet_address      TEXT,

  -- ── Limits and thresholds, in integer paise ───────────────────────────────
  -- The document store held these as rupee floats. Every one of them is
  -- compared against an order amount, and an order amount is paise.
  min_deposit_paise  BIGINT NOT NULL DEFAULT 50000,
  max_deposit_paise  BIGINT NOT NULL DEFAULT 5000000,
  min_withdraw_paise BIGINT NOT NULL DEFAULT 50000,
  max_withdraw_paise BIGINT NOT NULL DEFAULT 5000000,

  -- ── Lifetime totals, in paise where they are money ────────────────────────
  total_processed_volume_paise  BIGINT NOT NULL DEFAULT 0,
  earnings_paise                BIGINT NOT NULL DEFAULT 0,
  total_deposit_amount_paise    BIGINT NOT NULL DEFAULT 0,
  total_withdrawal_amount_paise BIGINT NOT NULL DEFAULT 0,
  total_deposits_processed      BIGINT NOT NULL DEFAULT 0,
  total_withdrawals_processed   BIGINT NOT NULL DEFAULT 0,

  rating              DOUBLE PRECISION NOT NULL DEFAULT 5.0,
  last_online_toggle  TIMESTAMPTZ,
  panel_url           TEXT NOT NULL DEFAULT '',

  merchant_approval_status  TEXT NOT NULL DEFAULT 'PENDING',
  merchant_approved_by      TEXT,
  merchant_approved_at      TIMESTAMPTZ,
  merchant_rejection_reason TEXT,

  monthly_processed_paise BIGINT NOT NULL DEFAULT 0,
  daily_processed_paise   BIGINT NOT NULL DEFAULT 0,
  total_orders_processed  BIGINT NOT NULL DEFAULT 0,
  stats_last_reset_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ── Scoring inputs (merchantScoring.service.js is the authority) ──────────
  -- `active_order_count` is DELIBERATELY ABSENT. The document store kept it as
  -- an accumulator incremented on assign and decremented on finish, which
  -- counts passes rather than rows: a crash between the two loses the
  -- decrement permanently and the merchant is throttled forever by a number
  -- nothing can correct. It is derived from `order_states` instead.
  success_rate         DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  avg_response_minutes DOUBLE PRECISION NOT NULL DEFAULT 2,
  dispute_rate         DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_orders_completed BIGINT NOT NULL DEFAULT 0,
  total_orders_all       BIGINT NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT merchants_status_known CHECK (
    status IN ('ACTIVE', 'SUSPENDED', 'INACTIVE', 'PENDING', 'REJECTED')),
  CONSTRAINT merchants_approval_known CHECK (
    merchant_approval_status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED')),
  -- Exactly one rail, and a known one.
  --
  -- `cardinality`, NOT `array_length`: array_length returns NULL for an empty
  -- array, `NULL = 1` is NULL, and a CHECK is satisfied by anything that is not
  -- FALSE — so the first draft of this constraint accepted a merchant on NO
  -- rail, whose merchant_type was then NULL and who matched no assignment
  -- query. cardinality returns 0.
  CONSTRAINT merchants_one_rail CHECK (
    cardinality(accepted_currencies) = 1
    AND accepted_currencies[1] IN ('INR', 'USDT')),
  -- A suspended merchant without a reason is a suspension nobody can appeal.
  CONSTRAINT merchants_suspension_has_reason CHECK (
    status <> 'SUSPENDED' OR (suspension_reason IS NOT NULL AND suspension_reason <> '')),
  CONSTRAINT merchants_rating_range CHECK (rating >= 0 AND rating <= 5),
  CONSTRAINT merchants_success_rate_range CHECK (success_rate >= 0 AND success_rate <= 1),
  CONSTRAINT merchants_dispute_rate_range CHECK (dispute_rate >= 0 AND dispute_rate <= 1),
  CONSTRAINT merchants_limits_ordered CHECK (
    min_deposit_paise  <= max_deposit_paise
    AND min_withdraw_paise <= max_withdraw_paise),
  CONSTRAINT merchants_limits_non_negative CHECK (
    min_deposit_paise >= 0 AND min_withdraw_paise >= 0)
);
ALTER TABLE merchants DROP COLUMN IF EXISTS password_hash;

-- No UPI handle. `bank_upi_id` was written by Profile and copied into each
-- order's snapshot, and nothing ever read it: a UPI_BANK buy is paid into the
-- member's bank account, a cash buy through the ATM QR the member scans, a sell
-- to the player's bank account, and nobody is shown a UPI handle (§2, §24).
-- Dropped, its index with it, so an existing database converges (§32 S31).
DROP INDEX IF EXISTS merchants_upi_unique;
ALTER TABLE merchants DROP COLUMN IF EXISTS bank_upi_id;

-- Payment credentials are an IDENTITY, not a preference: two merchants sharing
-- a bank account means money routed to one arrives at the other, and there is
-- no way afterwards to say which was intended. Partial indexes, because most
-- merchants have only the credentials for their own rail.
CREATE UNIQUE INDEX IF NOT EXISTS merchants_bank_account_unique
  ON merchants (bank_account_no, bank_ifsc)
  WHERE bank_account_no IS NOT NULL AND bank_account_no <> '';
-- Login identifiers. A second merchant on the same mobile is a login that
-- resolves to two accounts.
CREATE UNIQUE INDEX IF NOT EXISTS merchants_mobile_unique
  ON merchants (mobile) WHERE mobile IS NOT NULL AND mobile <> '';
CREATE UNIQUE INDEX IF NOT EXISTS merchants_username_unique
  ON merchants (lower(username)) WHERE username IS NOT NULL AND username <> '';

-- The assignment query: online, active, accepting this direction, on this rail.
CREATE INDEX IF NOT EXISTS merchants_assignable_idx
  ON merchants (status, is_online, merchant_type)
  WHERE status = 'ACTIVE' AND is_online;

-- `public_ref` is immutable. Enforced here because a schema-level flag is
-- honoured by document saves and skipped by update operators, and the reference
-- appears on receipts a player already holds.
CREATE OR REPLACE FUNCTION bb_forbid_public_ref_change() RETURNS trigger AS $$
BEGIN
  IF NEW.public_ref IS DISTINCT FROM OLD.public_ref THEN
    RAISE EXCEPTION 'merchants.public_ref is immutable (% -> %)', OLD.public_ref, NEW.public_ref;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER merchants_public_ref_immutable
  BEFORE UPDATE ON merchants FOR EACH ROW EXECUTE FUNCTION bb_forbid_public_ref_change();

-- ═══════════════════════════════════════════════════════════════════════════
-- CONFIGURATION DOCUMENTS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The platform's admin-editable settings: the system config, branding, promo
-- content, support links, the FAQ, the deposit and merchant-bonus policies.
-- One table, scoped by `scope`, because they are all the same shape — a
-- versioned document an admin edits and the application reads.
--
-- ── Why JSONB here, and only here ───────────────────────────────────────────
-- Money and state get columns and CHECK constraints, because an impossible row
-- must be impossible. Configuration is different in one specific way: its shape
-- changes when the business changes, and a column per setting turns "the admin
-- wants a new toggle" into a migration. What replaces the column constraints is
-- `configPg.js`'s SPEC — every key, its type, its bounds and its default,
-- declared in one place and enforced on WRITE.
--
-- That is STRICTLY STRONGER than what it replaces, not weaker. The document
-- model silently discarded a write to an undeclared path and skipped `min`/`max`
-- entirely on an update operator, so an admin could set a payout fee of 900% or
-- misspell a key and be told it worked. Both are refused now.
CREATE TABLE IF NOT EXISTS config_documents (
  scope      TEXT NOT NULL,
  doc_key    TEXT NOT NULL,
  settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The number of changes applied, so version 0 is "never edited" and the
  -- default a reader falls back to is the same answer whether or not a row has
  -- been materialised. Bumped on every write: an admin panel that read a
  -- document, sat on the form for ten minutes and saved must not silently
  -- overwrite an edit made in between, and the writer compares this and refuses.
  version    BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  PRIMARY KEY (scope, doc_key),
  -- A settings value that is not an object is not a settings document — every
  -- reader indexes into it.
  CONSTRAINT config_documents_is_object CHECK (jsonb_typeof(settings) = 'object'),
  CONSTRAINT config_documents_version_non_negative CHECK (version >= 0)
);
CREATE INDEX IF NOT EXISTS config_documents_scope_idx ON config_documents (scope, updated_at DESC);

-- Every version of every configuration document, append-only.
--
-- This is what `ConfigVersion` was for: "who changed the payout fee, when, and
-- what was it before?" is a question an audit asks after money has already
-- moved under the new value. The document store kept it as a separate
-- collection that had to be written by hand at each call site; here the writer
-- appends in the SAME TRANSACTION as the change, so a configuration change that
-- is not recorded is a configuration change that did not happen.
CREATE TABLE IF NOT EXISTS config_document_versions (
  id          BIGSERIAL PRIMARY KEY,
  scope       TEXT NOT NULL,
  doc_key     TEXT NOT NULL,
  version     BIGINT NOT NULL,
  settings    JSONB NOT NULL,
  -- Only the keys this change touched, so an auditor reading the trail does not
  -- have to diff two full documents to see what an admin actually did.
  changed     JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed_by  TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT config_versions_unique UNIQUE (scope, doc_key, version)
);
CREATE INDEX IF NOT EXISTS config_document_versions_idx
  ON config_document_versions (scope, doc_key, version DESC);
CREATE OR REPLACE TRIGGER config_document_versions_append_only
  BEFORE UPDATE OR DELETE ON config_document_versions FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- ── Deposit policy — the deposit/reserve split, versioned ──────────────────
--
-- Governs ONE thing: how much of a deposit lands in the player's spendable
-- balance and how much goes to the platform reserve. It is versioned because
-- the split is snapshotted onto every DEPOSIT order at creation, and an auditor
-- asking "which policy produced this order's split" needs the version to still
-- exist months later — so versions are never edited or deleted, only superseded.
--
-- ── Two rules the document version could not express ────────────────────────
--
-- 1. EXACTLY ONE ACTIVE VERSION PER CURRENCY. The service made a new version
--    active and then updated the previous one to SUPERSEDED — two writes, and
--    two admins saving at once left two ACTIVE rows for the same currency. The
--    next order to read the policy got whichever the sort happened to return.
--    A partial unique index makes a second ACTIVE row impossible.
--
-- 2. THE PERCENTAGES SUM TO 100. Validated in JavaScript before every write,
--    which means validated by every caller that remembered to call the
--    validator. A split that does not sum to 100 either creates or destroys
--    money on every deposit it governs; that belongs in the row.
CREATE TABLE IF NOT EXISTS deposit_policies (
  id           BIGSERIAL PRIMARY KEY,
  currency     TEXT NOT NULL,
  version      BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ACTIVE',
  deposit_allocation_percent NUMERIC(6,3) NOT NULL,
  reserve_allocation_percent NUMERIC(6,3) NOT NULL,
  reserve_usage_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  justification TEXT NOT NULL DEFAULT '',
  effective_at  TIMESTAMPTZ,
  changed_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,
  CONSTRAINT deposit_policies_version_unique UNIQUE (currency, version),
  CONSTRAINT deposit_policies_status_known CHECK (
    status IN ('ACTIVE', 'PENDING_APPROVAL', 'SCHEDULED', 'SUPERSEDED', 'REJECTED')),
  CONSTRAINT deposit_policies_percent_range CHECK (
    deposit_allocation_percent >= 0 AND reserve_allocation_percent >= 0),
  -- Money is neither created nor destroyed by a split. The 0.01 tolerance is
  -- the same one the JavaScript validator used, kept so a policy it accepted
  -- is one the table accepts.
  CONSTRAINT deposit_policies_sums_to_100 CHECK (
    abs((deposit_allocation_percent + reserve_allocation_percent) - 100) <= 0.01),
  CONSTRAINT deposit_policies_rules_object CHECK (jsonb_typeof(reserve_usage_rules) = 'object')
);
-- One ACTIVE version per currency, enforced by the index rather than by the
-- order two writers happen to run in.
CREATE UNIQUE INDEX IF NOT EXISTS deposit_policies_one_active
  ON deposit_policies (currency) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS deposit_policies_history_idx
  ON deposit_policies (currency, version DESC);
-- A superseded version is history. Editing one would rewrite the split an
-- order in flight was created under.
CREATE OR REPLACE FUNCTION bb_forbid_policy_rewrite() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deposit_policies rows are permanent: version % of % may not be deleted',
      OLD.version, OLD.currency;
  END IF;
  IF OLD.status = 'SUPERSEDED' AND NEW.status <> 'SUPERSEDED' THEN
    RAISE EXCEPTION 'deposit_policies version % of % is superseded and may not be revived',
      OLD.version, OLD.currency;
  END IF;
  IF NEW.deposit_allocation_percent <> OLD.deposit_allocation_percent
     OR NEW.reserve_allocation_percent <> OLD.reserve_allocation_percent THEN
    RAISE EXCEPTION 'deposit_policies percentages are immutable: supersede version % of % instead',
      OLD.version, OLD.currency;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER deposit_policies_immutable
  BEFORE UPDATE OR DELETE ON deposit_policies
  FOR EACH ROW EXECUTE FUNCTION bb_forbid_policy_rewrite();
-- Version numbers are per-currency and contiguous, so they cannot come from a
-- shared sequence. `MAX(version) + 1` does not serialise on its own — but the
-- writer supersedes the current ACTIVE row in the same statement, and that
-- UPDATE takes the row lock that makes the read behind it safe. Where no ACTIVE
-- row exists yet (the first version for a currency) there is nothing to lock,
-- and `deposit_policies_version_unique` is what refuses the second writer.

-- ═══════════════════════════════════════════════════════════════════════════
-- MARKETS — the betting cycle
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A cycle is one betting round: it opens, takes bets on two sides, closes,
-- declares a winner, and settles. Everything a player wagers moves through one.
--
-- ── The three rules this table encodes ──────────────────────────────────────
--
-- 1. REAL POOL TOTALS ARE NOT STORED HERE. A bet holds `FOR SHARE` on this row,
--    so a bet that also UPDATEs it blocks against another bet doing the same —
--    a 40P01 deadlock on the hottest path on the platform. The real pools are
--    DERIVED from `bets`. Only the PHANTOM figures, which nothing concurrent
--    writes, live on the row.
--
-- 2. THE WINNER IS WRITTEN BEFORE THE STATUS. Nothing in the old engine
--    advanced the cycle at all: `ensureCycle` created the row at OPEN and it
--    stayed there, so the engine looked healthy and silently never settled. The
--    CHECK below makes the ordering a property of the row rather than a
--    convention: a cycle cannot be COMPLETED without a winner.
--
-- 3. A CYCLE WITH NO WINNER IS NOT OFFERED FOR SETTLEMENT. Same constraint,
--    read the other way.
CREATE TABLE IF NOT EXISTS cycles (
  cycle_id    TEXT PRIMARY KEY,
  cycle_type  TEXT NOT NULL,
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'OPEN',

  -- Phantom liquidity only. See rule 1: the real pools come from `bets`.
  phantom_delhi_paise   BIGINT NOT NULL DEFAULT 0,
  phantom_bombay_paise  BIGINT NOT NULL DEFAULT 0,
  phantom_balanced      BOOLEAN NOT NULL DEFAULT FALSE,
  phantom_bets_closed   BOOLEAN NOT NULL DEFAULT FALSE,

  winner              TEXT,
  pending_result      TEXT,
  is_paused           BOOLEAN NOT NULL DEFAULT FALSE,
  winner_determined_at TIMESTAMPTZ,
  winner_determined_by TEXT,
  winner_confidence   DOUBLE PRECISION,

  is_settled          BOOLEAN NOT NULL DEFAULT FALSE,
  settled_at          TIMESTAMPTZ,
  total_paid_out_paise BIGINT NOT NULL DEFAULT 0,
  net_profit_paise     BIGINT NOT NULL DEFAULT 0,
  total_platform_fees_paise BIGINT NOT NULL DEFAULT 0,
  -- The fee rate USED, snapshotted. An admin editing the rate afterwards must
  -- not change what a settled cycle says it charged.
  winnings_fee_percent_used DOUBLE PRECISION,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cycles_type_known   CHECK (cycle_type IN ('1_MIN', '30_MIN', 'FULL_DAY')),
  -- The seven states the engine actually uses, in the order it moves through
  -- them: OPEN takes bets, MERGED folds in the phantom pools, CLOSED stops
  -- betting, RESULT_DECLARED names the winner, COMPLETED settles. PAUSED and
  -- CANCELLED are the admin interventions.
  --
  -- The first draft of this constraint declared four of them. A cycle the
  -- engine moved to MERGED would have been refused by the row, which is a
  -- betting round that stops mid-cycle — the vocabulary has to be the engine's,
  -- not a tidier one.
  CONSTRAINT cycles_status_known CHECK (status IN (
    'OPEN', 'MERGED', 'CLOSED', 'RESULT_DECLARED', 'COMPLETED', 'PAUSED', 'CANCELLED')),
  CONSTRAINT cycles_side_known   CHECK (winner IS NULL OR winner IN ('DELHI', 'BOMBAY')),
  CONSTRAINT cycles_pending_side_known CHECK (pending_result IS NULL OR pending_result IN ('DELHI', 'BOMBAY')),
  CONSTRAINT cycles_window_ordered CHECK (end_time > start_time),
  -- Rules 2 and 3. A completed cycle HAS a winner; an unsettled one has not
  -- paid anything out.
  -- A cycle cannot say the result is in without saying what it is. Covers both
  -- states that make that claim.
  CONSTRAINT cycles_completed_has_winner CHECK (
    status NOT IN ('COMPLETED', 'RESULT_DECLARED') OR winner IS NOT NULL),
  CONSTRAINT cycles_settled_has_winner   CHECK (NOT is_settled OR winner IS NOT NULL),
  CONSTRAINT cycles_unsettled_paid_nothing CHECK (is_settled OR total_paid_out_paise = 0),
  CONSTRAINT cycles_phantom_non_negative CHECK (
    phantom_delhi_paise >= 0 AND phantom_bombay_paise >= 0)
);
-- One cycle per type per start instant. Two generators waking together must
-- produce one cycle, and the index is what decides rather than a pre-read.
-- The two constraints above are also applied as ALTERs, because a CHECK written
-- inside `CREATE TABLE IF NOT EXISTS` is skipped entirely on a database where
-- the table already exists — so widening the status vocabulary would have
-- reached a fresh install and no other. Every constraint whose definition
-- CHANGES needs this shape; a new one on a new table does not.
DO $$ BEGIN
  ALTER TABLE cycles DROP CONSTRAINT IF EXISTS cycles_status_known;
  ALTER TABLE cycles ADD CONSTRAINT cycles_status_known CHECK (status IN (
    'OPEN', 'MERGED', 'CLOSED', 'RESULT_DECLARED', 'COMPLETED', 'PAUSED', 'CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE cycles DROP CONSTRAINT IF EXISTS cycles_completed_has_winner;
  ALTER TABLE cycles ADD CONSTRAINT cycles_completed_has_winner CHECK (
    status NOT IN ('COMPLETED', 'RESULT_DECLARED') OR winner IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS cycles_type_start_unique ON cycles (cycle_type, start_time);
CREATE INDEX IF NOT EXISTS cycles_open_idx   ON cycles (cycle_type, status, end_time);
CREATE INDEX IF NOT EXISTS cycles_recent_idx ON cycles (cycle_type, start_time DESC);
-- The settlement sweep's query: declared, not yet settled.
CREATE INDEX IF NOT EXISTS cycles_settleable_idx ON cycles (end_time)
  WHERE winner IS NOT NULL AND NOT is_settled;

-- ═══════════════════════════════════════════════════════════════════════════
-- CASINO — third-party game providers
-- ═══════════════════════════════════════════════════════════════════════════
-- ── Settlement claim, so two workers cannot walk the same cycle ────────────
--
-- `claimSettleable` used `FOR UPDATE SKIP LOCKED`, which did nothing: the query
-- runs in its own implicit transaction, so the lock released as the SELECT
-- returned and both settlement workers walked the same cycles. `markSettled` is
-- guarded on `NOT is_settled`, so only one final write landed and no money was
-- paid twice — but both workers did the whole settlement pass, and the function
-- named "claim" made no claim at all.
--
-- A lock cannot serve here: the claim has to outlive the transaction that takes
-- it, because settling a cycle means walking its bets through other calls, and
-- holding a pooled client across those is the deadlock this codebase already
-- paid for once. A claim COLUMN survives, and a lease that expires means a
-- worker that dies mid-settlement releases its cycles instead of stranding them.
ALTER TABLE cycles ADD COLUMN IF NOT EXISTS settlement_claimed_at TIMESTAMPTZ;
ALTER TABLE cycles ADD COLUMN IF NOT EXISTS settlement_claimed_by TEXT;
CREATE INDEX IF NOT EXISTS cycles_settleable_idx
  ON cycles (end_time) WHERE winner IS NOT NULL AND NOT is_settled;

CREATE TABLE IF NOT EXISTS game_providers (
  provider_key   TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'SLOTS',
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  api_url        TEXT,
  -- Credentials. Encrypted at rest by the application, and never selected by
  -- the general reader — see `getProvider` vs `getProviderSecrets`.
  api_key_encrypted     TEXT,
  api_secret_encrypted  TEXT,
  webhook_secret_encrypted TEXT,
  provider_merchant_id  TEXT,
  extra_config   JSONB NOT NULL DEFAULT '{}'::jsonb,
  logo_url       TEXT,
  description    TEXT NOT NULL DEFAULT '',
  updated_by     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT game_providers_config_object CHECK (jsonb_typeof(extra_config) = 'object'),
  -- An enabled provider with no endpoint is a launch that fails at the click.
  CONSTRAINT game_providers_enabled_has_url CHECK (NOT enabled OR api_url IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS game_sessions (
  session_id   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  game_id      TEXT,
  game_name    TEXT,
  currency     TEXT NOT NULL DEFAULT 'INR',
  status       TEXT NOT NULL DEFAULT 'ACTIVE',
  launch_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Enforced by the READ, like every other expiry here: a sweep that is late
  -- must not leave an expired session usable.
  expires_at   TIMESTAMPTZ,
  CONSTRAINT game_sessions_status_known CHECK (status IN ('ACTIVE', 'CLOSED', 'EXPIRED'))
);
CREATE INDEX IF NOT EXISTS game_sessions_user_idx ON game_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS game_sessions_live_idx ON game_sessions (expires_at) WHERE status = 'ACTIVE';

-- Every provider callback that moved money. `tx_id` UNIQUE is the idempotency
-- gate: a redelivered callback collides inside the transaction rather than
-- debiting twice.
CREATE TABLE IF NOT EXISTS game_transactions (
  id            BIGSERIAL PRIMARY KEY,
  tx_id         TEXT NOT NULL UNIQUE,
  round_id      TEXT,
  session_id    TEXT,
  user_id       TEXT NOT NULL,
  provider_key  TEXT NOT NULL,
  tx_type       TEXT NOT NULL,
  amount_paise  BIGINT NOT NULL,
  balance_before_paise BIGINT,
  balance_after_paise  BIGINT,
  game_id       TEXT,
  game_name     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT game_transactions_type_known CHECK (tx_type IN ('BET', 'WIN', 'REFUND', 'ROLLBACK'))
);
CREATE INDEX IF NOT EXISTS game_transactions_user_idx  ON game_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS game_transactions_round_idx ON game_transactions (round_id);
CREATE OR REPLACE TRIGGER game_transactions_append_only
  BEFORE UPDATE OR DELETE ON game_transactions FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- ═══════════════════════════════════════════════════════════════════════════
-- GAME REGISTRY — the catalogue players browse
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS game_categories (
  slug       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS games (
  slug             TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  provider_key     TEXT,
  category_slug    TEXT REFERENCES game_categories (slug) ON DELETE SET NULL,
  launch_strategy  TEXT NOT NULL DEFAULT 'PROVIDER',
  external_game_id TEXT,
  launch_url       TEXT,
  thumbnail        TEXT,
  banner           TEXT,
  badge            TEXT,
  rtp              DOUBLE PRECISION,
  tags             TEXT[] NOT NULL DEFAULT '{}',
  min_bet_paise    BIGINT NOT NULL DEFAULT 1000,
  max_bet_paise    BIGINT NOT NULL DEFAULT 10000000,
  status           TEXT NOT NULL DEFAULT 'INACTIVE',
  featured         BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       TEXT,
  updated_by       TEXT,
  -- The vocabulary the REGISTRY uses. A status the application sets and the
  -- table refuses is a game that cannot be published — the same mistake the
  -- cycle statuses had, and for the same reason: the tidier set was invented
  -- here rather than read from the code that writes it.
  --   ACTIVE      playable
  --   MAINTENANCE visible, temporarily unplayable
  --   INACTIVE    hidden
  CONSTRAINT games_status_known   CHECK (status IN ('ACTIVE', 'MAINTENANCE', 'INACTIVE')),
  CONSTRAINT games_strategy_known CHECK (launch_strategy IN ('PROVIDER', 'URL', 'INTERNAL')),
  CONSTRAINT games_bet_range      CHECK (min_bet_paise > 0 AND min_bet_paise <= max_bet_paise),
  CONSTRAINT games_rtp_range      CHECK (rtp IS NULL OR (rtp >= 0 AND rtp <= 100)),
  -- A playable game nobody can launch is a tile that 404s.
  CONSTRAINT games_live_is_launchable CHECK (
    status <> 'ACTIVE'
    OR (launch_strategy = 'PROVIDER' AND provider_key IS NOT NULL AND external_game_id IS NOT NULL)
    OR (launch_strategy = 'URL' AND launch_url IS NOT NULL)
    OR launch_strategy = 'INTERNAL')
);
CREATE INDEX IF NOT EXISTS games_catalogue_idx ON games (category_slug, sort_order)
  WHERE status IN ('ACTIVE', 'MAINTENANCE');
CREATE INDEX IF NOT EXISTS games_featured_idx  ON games (sort_order)
  WHERE status IN ('ACTIVE', 'MAINTENANCE') AND featured;

-- Applied as ALTERs too: a CHECK inside `CREATE TABLE IF NOT EXISTS` is skipped
-- where the table already exists, so a corrected vocabulary would reach a fresh
-- install and no other.
DO $$ BEGIN
  ALTER TABLE games DROP CONSTRAINT IF EXISTS games_status_known;
  ALTER TABLE games ADD CONSTRAINT games_status_known
    CHECK (status IN ('ACTIVE', 'MAINTENANCE', 'INACTIVE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE games DROP CONSTRAINT IF EXISTS games_live_is_launchable;
  ALTER TABLE games ADD CONSTRAINT games_live_is_launchable CHECK (
    status <> 'ACTIVE'
    OR (launch_strategy = 'PROVIDER' AND provider_key IS NOT NULL AND external_game_id IS NOT NULL)
    OR (launch_strategy = 'URL' AND launch_url IS NOT NULL)
    OR launch_strategy = 'INTERNAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- CONTENT — what the panels render
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS announcements (
  announcement_id TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'INFO',
  priority   INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT announcements_kind_known CHECK (kind IN ('INFO', 'WARNING', 'CRITICAL', 'PROMO'))
);
-- The user-panel query: live, unexpired, most important first. Expiry is in the
-- READ; the index only makes it cheap.
CREATE INDEX IF NOT EXISTS announcements_live_idx
  ON announcements (priority DESC, created_at DESC) WHERE is_active;

CREATE TABLE IF NOT EXISTS promo_content (
  promo_id    TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'BANNER',
  location    TEXT NOT NULL DEFAULT 'HOME',
  media_type  TEXT NOT NULL DEFAULT 'IMAGE',
  file_url    TEXT,
  priority    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'DRAFT',
  is_active   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT promo_status_known CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  CONSTRAINT promo_media_known  CHECK (media_type IN ('IMAGE', 'VIDEO', 'TEXT')),
  -- A published promo with nothing to show is an empty slot on the home page.
  CONSTRAINT promo_published_has_media CHECK (
    status <> 'PUBLISHED' OR media_type = 'TEXT' OR file_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS promo_content_live_idx
  ON promo_content (location, priority DESC) WHERE status = 'PUBLISHED' AND is_active;

CREATE TABLE IF NOT EXISTS faqs (
  faq_id       TEXT PRIMARY KEY,
  question     TEXT NOT NULL,
  answer       TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'GENERAL',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  views        BIGINT NOT NULL DEFAULT 0,
  tags         TEXT[] NOT NULL DEFAULT '{}',
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT faqs_has_content CHECK (question <> '' AND answer <> ''),
  CONSTRAINT faqs_views_non_negative CHECK (views >= 0)
);
CREATE INDEX IF NOT EXISTS faqs_published_idx ON faqs (category, sort_order) WHERE is_published;

CREATE TABLE IF NOT EXISTS cdn_images (
  image_id    TEXT PRIMARY KEY,
  url         TEXT NOT NULL UNIQUE,
  category    TEXT NOT NULL DEFAULT 'GENERAL',
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags        TEXT[] NOT NULL DEFAULT '{}',
  mime_type   TEXT,
  file_size   BIGINT,
  width       INTEGER,
  height      INTEGER,
  is_public   BOOLEAN NOT NULL DEFAULT TRUE,
  -- Derived from `usage_count`: an image nothing references can be deleted, and
  -- knowing which is a property of the row rather than a scan.
  usage_count BIGINT NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cdn_images_usage_non_negative CHECK (usage_count >= 0),
  CONSTRAINT cdn_images_size_non_negative  CHECK (file_size IS NULL OR file_size >= 0)
);
CREATE INDEX IF NOT EXISTS cdn_images_category_idx ON cdn_images (category, uploaded_at DESC);

-- One asset per named slot — the splash screen, the login banner. `slot` is the
-- primary key because "two things in the splash slot" is not a state.
CREATE TABLE IF NOT EXISTS app_assets (
  slot         TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  storage      TEXT NOT NULL DEFAULT 'CDN',
  file_key     TEXT,
  file_size    BIGINT,
  content_type TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

-- ── Android releases ────────────────────────────────────────────────────────
-- One row per uploaded APK. The identity columns (package, version, signer,
-- file hash) are READ FROM THE FILE by domains/distribution/apkInspector.js,
-- never typed by the admin, and never change afterwards: an installed app
-- downloads `file_url` and refuses to install anything whose SHA-256 is not
-- `file_sha256`, so a row whose file could be swapped under it would be a
-- row that lies to every phone.
--
-- `published_at` NULL is a draft nobody is offered. A published release is
-- never deleted (it is the history of what players were sent); a newer one
-- supersedes it. `mandatory` may be changed after publishing, because "this
-- version must no longer be run" is a decision an operator makes later.
--
-- The app is told: the newest published release, and the highest MANDATORY
-- published version_code. An install below that code is blocked until it
-- updates; one below the newest but above it is offered the update.
--
-- Everything is PER PACKAGE. Android identifies an app by its package, so a
-- release of another package id governs nothing an installed copy of this one
-- would accept — and a deploy that changes ANDROID_PACKAGE_ID starts a new app
-- with its own history rather than inheriting a floor it cannot meet. It also
-- makes each test run hermetic: it uses a package of its own (trap 10).
CREATE TABLE IF NOT EXISTS android_releases (
  release_id     TEXT PRIMARY KEY,
  package_name   TEXT NOT NULL,
  version_code   INTEGER NOT NULL CHECK (version_code > 0),
  version_name   TEXT NOT NULL,
  min_sdk        INTEGER,
  signer_sha256  TEXT NOT NULL CHECK (signer_sha256 ~ '^[0-9A-F]{64}$'),
  file_sha256    TEXT NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes     BIGINT NOT NULL CHECK (size_bytes > 0),
  file_url       TEXT NOT NULL,
  storage        TEXT NOT NULL CHECK (storage IN ('S3', 'LOCAL')),
  file_key       TEXT NOT NULL,
  release_notes  TEXT NOT NULL DEFAULT '' CHECK (length(release_notes) <= 4000),
  mandatory      BOOLEAN NOT NULL DEFAULT false,
  uploaded_by    TEXT,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ,
  published_by   TEXT
);
-- Convergent (§32 S31): the first definition made version_code unique across
-- ALL packages. Drop that, then add the per-package key; its own definition is
-- fixed, so the duplicate guard is safe for it.
ALTER TABLE android_releases DROP CONSTRAINT IF EXISTS android_releases_version_code_key;
DO $$ BEGIN
  ALTER TABLE android_releases ADD CONSTRAINT android_releases_package_version UNIQUE (package_name, version_code);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
-- R9 (owner, 2026-10-01): an admin can HALT a published release so a broken
-- build stops being offered. It stays published, because phones may already run
-- it and every later release must still be above it; it is just no longer
-- what anybody is told to install. Only a published release can be halted.
ALTER TABLE android_releases ADD COLUMN IF NOT EXISTS halted_at   TIMESTAMPTZ;
ALTER TABLE android_releases ADD COLUMN IF NOT EXISTS halted_by   TEXT;
ALTER TABLE android_releases ADD COLUMN IF NOT EXISTS halt_reason TEXT;
-- Which APK signature schemes the upload VERIFIED (R7), e.g. {2,3}.
ALTER TABLE android_releases ADD COLUMN IF NOT EXISTS signature_schemes INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE android_releases DROP CONSTRAINT IF EXISTS android_releases_halt_needs_publish;
ALTER TABLE android_releases ADD CONSTRAINT android_releases_halt_needs_publish
  CHECK (halted_at IS NULL OR (published_at IS NOT NULL AND length(btrim(coalesce(halt_reason, ''))) BETWEEN 3 AND 500));
DROP INDEX IF EXISTS android_releases_published_idx;
CREATE INDEX IF NOT EXISTS android_releases_published_pkg_idx
  ON android_releases (package_name, version_code DESC) WHERE published_at IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- ENGAGEMENT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The daily check-in streak. One row per player.
--
-- `current_streak` and `total_check_ins` are counters, and the rule for
-- counters holds: they are moved by arithmetic IN THE STATEMENT that records
-- the check-in, never read-modify-written. `last_check_in_date` is a DATE, not
-- a timestamp — "have they checked in today" is a question about the day.
CREATE TABLE IF NOT EXISTS check_ins (
  user_id          TEXT PRIMARY KEY,
  current_streak   INTEGER NOT NULL DEFAULT 0,
  longest_streak   INTEGER NOT NULL DEFAULT 0,
  total_check_ins  BIGINT NOT NULL DEFAULT 0,
  last_check_in_date DATE,
  total_earned_paise BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT check_ins_non_negative CHECK (
    current_streak >= 0 AND longest_streak >= 0
    AND total_check_ins >= 0 AND total_earned_paise >= 0),
  -- The longest streak is a high-water mark. It cannot be below the current one.
  CONSTRAINT check_ins_longest_is_high_water CHECK (longest_streak >= current_streak)
);

-- Every bonus a player was granted, and why. Append-only: this is the record a
-- player disputes against.
CREATE TABLE IF NOT EXISTS bonus_records (
  id           BIGSERIAL PRIMARY KEY,
  bonus_id     TEXT UNIQUE,
  user_id      TEXT NOT NULL,
  bonus_type   TEXT NOT NULL,
  amount_paise BIGINT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  ref_id       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bonus_records_user_idx ON bonus_records (user_id, created_at DESC);
CREATE OR REPLACE TRIGGER bonus_records_append_only
  BEFORE UPDATE OR DELETE ON bonus_records FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- A precomputed leaderboard. Genuinely a CACHE: it is derived from bets and
-- settlements, it is rebuilt on a schedule, and nothing reads it to make a
-- decision. Deleting it costs a rebuild, not a fact.
CREATE TABLE IF NOT EXISTS leaderboard_cache (
  period       TEXT PRIMARY KEY,
  entries      JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leaderboard_cache_is_array CHECK (jsonb_typeof(entries) = 'array')
);

CREATE TABLE IF NOT EXISTS notifications (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'INFO',
  title        TEXT NOT NULL,
  message      TEXT NOT NULL DEFAULT '',
  action_url   TEXT,
  action_label TEXT,
  related_id   TEXT,
  related_type TEXT,
  is_read      BOOLEAN NOT NULL DEFAULT FALSE,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  -- A row that says it is read but not when is a row an audit cannot use.
  CONSTRAINT notifications_read_has_time CHECK (NOT is_read OR read_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS notifications_inbox_idx ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE NOT is_read;

-- Display-only winners shown on the marketing carousel.
--
-- These are NOT players and carry no money. `user_id` is nullable and
-- deliberately not a foreign key: attaching one to a real account would put a
-- fabricated payout next to a real person's name.
CREATE TABLE IF NOT EXISTS fake_winners (
  id           BIGSERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  profile_pic  TEXT,
  city         TEXT,
  amount_paise BIGINT NOT NULL DEFAULT 0,
  game         TEXT,
  badge        TEXT,
  user_id      TEXT,
  is_public    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  display_time TIMESTAMPTZ,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fake_winners_carousel_idx ON fake_winners (sort_order, display_time DESC)
  WHERE is_public;

-- ═══════════════════════════════════════════════════════════════════════════
-- SOCIAL — public chat and support
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public_chat_messages (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  profile_pic  TEXT,
  vip_level    INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL DEFAULT 'TEXT',
  content      TEXT NOT NULL DEFAULT '',
  image_key    TEXT,
  status       TEXT NOT NULL DEFAULT 'APPROVED',
  approved_by  TEXT,
  approved_at  TIMESTAMPTZ,
  reject_reason TEXT,
  -- Soft delete: a moderator removing a message must not destroy the evidence
  -- of what was said, which is what a report is about.
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_by   TEXT,
  deleted_at   TIMESTAMPTZ,
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  CONSTRAINT public_chat_kind_known   CHECK (kind IN ('TEXT', 'IMAGE', 'SYSTEM')),
  CONSTRAINT public_chat_status_known CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT public_chat_has_content  CHECK (content <> '' OR image_key IS NOT NULL),
  CONSTRAINT public_chat_rejected_has_reason CHECK (status <> 'REJECTED' OR reject_reason IS NOT NULL),
  CONSTRAINT public_chat_deleted_has_actor  CHECK (NOT is_deleted OR deleted_by IS NOT NULL),
  CONSTRAINT public_chat_reports_non_negative CHECK (report_count >= 0)
);
-- The room's live feed. `(created_at, id)` because two messages in the same
-- millisecond order arbitrarily under the timestamp alone, and a chat is a
-- sequence.
CREATE INDEX IF NOT EXISTS public_chat_feed_idx ON public_chat_messages (created_at DESC, id DESC)
  WHERE status = 'APPROVED' AND NOT is_deleted;
CREATE INDEX IF NOT EXISTS public_chat_moderation_idx ON public_chat_messages (created_at)
  WHERE status = 'PENDING';

-- A chat ban. `ban_until` NULL means permanent, which is a real state and not
-- the same as "expired".
CREATE TABLE IF NOT EXISTS chat_bans (
  user_id    TEXT PRIMARY KEY,
  banned_by  TEXT,
  reason     TEXT NOT NULL DEFAULT '',
  ban_until  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_tickets (
  ticket_id    TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  subject      TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'GENERAL',
  priority     TEXT NOT NULL DEFAULT 'NORMAL',
  status       TEXT NOT NULL DEFAULT 'OPEN',
  assigned_to  TEXT,
  assigned_at  TIMESTAMPTZ,
  resolved_at  TIMESTAMPTZ,
  closed_at    TIMESTAMPTZ,
  rating       INTEGER,
  rating_note  TEXT,
  last_reply_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT support_tickets_status_known CHECK (
    status IN ('OPEN', 'ASSIGNED', 'WAITING_USER', 'RESOLVED', 'CLOSED')),
  CONSTRAINT support_tickets_priority_known CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  CONSTRAINT support_tickets_rating_range CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  -- An assigned ticket with no agent, or a resolved one with no time, is a row
  -- a queue cannot act on.
  CONSTRAINT support_tickets_assigned_has_agent CHECK (status <> 'ASSIGNED' OR assigned_to IS NOT NULL),
  CONSTRAINT support_tickets_resolved_has_time  CHECK (status <> 'RESOLVED' OR resolved_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS support_tickets_user_idx  ON support_tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_queue_idx ON support_tickets (priority, created_at)
  WHERE status IN ('OPEN', 'ASSIGNED', 'WAITING_USER');

CREATE TABLE IF NOT EXISTS support_messages (
  id          BIGSERIAL PRIMARY KEY,
  ticket_id   TEXT NOT NULL REFERENCES support_tickets (ticket_id) ON DELETE CASCADE,
  sender_id   TEXT,
  sender_type TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  attachments TEXT[] NOT NULL DEFAULT '{}',
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT support_messages_sender_known CHECK (sender_type IN ('USER', 'AGENT', 'SYSTEM')),
  CONSTRAINT support_messages_has_content CHECK (content <> '' OR cardinality(attachments) > 0),
  CONSTRAINT support_messages_sender_required CHECK (sender_id IS NOT NULL OR sender_type = 'SYSTEM')
);
CREATE INDEX IF NOT EXISTS support_messages_thread_idx ON support_messages (ticket_id, created_at, id);

-- ═══════════════════════════════════════════════════════════════════════════
-- REFERRALS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A referral earning is MONEY OWED. It is queued, paid in batches, and every
-- state it passes through is auditable — so the amount is paise in BIGINT like
-- every other money column, and `wallet_tx_id` links the payment to the ledger
-- row that actually moved it.
CREATE TABLE IF NOT EXISTS referral_earnings (
  id            BIGSERIAL PRIMARY KEY,
  earning_id    TEXT UNIQUE,
  earner_id     TEXT NOT NULL,
  source_user_id TEXT NOT NULL,
  level         INTEGER NOT NULL DEFAULT 1,
  amount_paise  BIGINT NOT NULL,
  -- The payout order. Unique so two earnings cannot claim one slot, and taken
  -- from a sequence over the maximum rather than from count(*) + 1.
  queue_position BIGINT,
  status        TEXT NOT NULL DEFAULT 'QUEUED',
  blocked_reason TEXT,
  disbursal_batch_id TEXT,
  disbursed_at  TIMESTAMPTZ,
  -- The ledger row that paid this. A PAID earning without one is a payment
  -- nothing in the books accounts for.
  wallet_tx_id  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT referral_earnings_status_known CHECK (
    status IN ('QUEUED', 'PAID', 'BLOCKED', 'CANCELLED')),
  CONSTRAINT referral_earnings_amount_positive CHECK (amount_paise > 0),
  CONSTRAINT referral_earnings_level_positive  CHECK (level >= 1),
  CONSTRAINT referral_earnings_paid_is_ledgered CHECK (
    status <> 'PAID' OR (wallet_tx_id IS NOT NULL AND disbursed_at IS NOT NULL)),
  CONSTRAINT referral_earnings_blocked_has_reason CHECK (
    status <> 'BLOCKED' OR blocked_reason IS NOT NULL),
  -- Nobody earns from their own signup.
  CONSTRAINT referral_earnings_not_self CHECK (earner_id <> source_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS referral_earnings_queue_unique
  ON referral_earnings (queue_position) WHERE queue_position IS NOT NULL;
CREATE INDEX IF NOT EXISTS referral_earnings_earner_idx ON referral_earnings (earner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS referral_earnings_payable_idx ON referral_earnings (queue_position)
  WHERE status = 'QUEUED';

CREATE TABLE IF NOT EXISTS referral_disbursals (
  batch_id      TEXT PRIMARY KEY,
  pool_paise    BIGINT NOT NULL DEFAULT 0,
  spent_paise   BIGINT NOT NULL DEFAULT 0,
  paid_count    INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  last_queue_position BIGINT,
  actor_id      TEXT,
  status        TEXT NOT NULL DEFAULT 'RUNNING',
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  CONSTRAINT referral_disbursals_status_known CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  -- A batch cannot spend more than its pool. That is the whole point of a pool.
  CONSTRAINT referral_disbursals_within_pool CHECK (spent_paise >= 0 AND spent_paise <= pool_paise),
  CONSTRAINT referral_disbursals_failed_has_error CHECK (status <> 'FAILED' OR error IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS referral_programmes (
  programme_key   TEXT PRIMARY KEY,
  budget_paise    BIGINT NOT NULL DEFAULT 0,
  disbursed_paise BIGINT NOT NULL DEFAULT 0,
  member_cap      INTEGER NOT NULL DEFAULT 0,
  verified_members INTEGER NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The budget is a ceiling, enforced by the row. An application-side check
  -- lets two concurrent disbursals both read the same total and both pass.
  CONSTRAINT referral_programmes_within_budget CHECK (
    disbursed_paise >= 0 AND disbursed_paise <= budget_paise),
  CONSTRAINT referral_programmes_members_non_negative CHECK (
    verified_members >= 0 AND member_cap >= 0)
);

-- Click attribution. Short-lived and high-volume: expiry is enforced by the
-- READ, and the sweep only reclaims space.
CREATE TABLE IF NOT EXISTS referral_clicks (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL,
  viewer_hash TEXT NOT NULL,
  clicked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  -- One click per viewer per code within the window. Without this a refresh
  -- loop inflates a referrer's click count without bound.
  CONSTRAINT referral_clicks_once UNIQUE (code, viewer_hash)
);
CREATE INDEX IF NOT EXISTS referral_clicks_sweep_idx ON referral_clicks (expires_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- OPERATIONS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The scheduled-job leader lock.
--
-- ── This replaces a TTL document, and the difference matters ────────────────
-- The document version relied on a TTL index to expire an abandoned lock. A
-- TTL index sweeps on ITS OWN SCHEDULE — up to a minute late, longer under
-- load — so a crashed leader's lock lingered and every instance skipped its
-- jobs until the sweep happened to run. PostgreSQL has no TTL index, which is
-- the better answer: the lock's expiry is in the WHERE clause of the claim, so
-- an abandoned lock is claimable the instant it lapses.
CREATE TABLE IF NOT EXISTS cron_locks (
  job_name   TEXT PRIMARY KEY,
  holder     TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT cron_locks_expires_after_acquire CHECK (expires_at > acquired_at)
);

-- A monotonic counter, for the few values that need one.
--
-- Derive from rows wherever possible — this exists for the cases where there
-- are no rows to derive from. The value moves by arithmetic in the UPDATE, so
-- two concurrent claims cannot both read the same number.
CREATE TABLE IF NOT EXISTS counters (
  counter_key TEXT PRIMARY KEY,
  value       BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT counters_non_negative CHECK (value >= 0)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- AUDIT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Append-only, both of them. An audit log something can edit is not an audit
-- log, and the trigger is what makes that true rather than a convention.
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  admin_id   TEXT,
  action     TEXT NOT NULL,
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_id  TEXT,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_details_object CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX IF NOT EXISTS audit_logs_admin_idx  ON audit_logs (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_target_idx ON audit_logs (target_id, created_at DESC);
CREATE OR REPLACE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- The richer trail: who, in what role, against what, from where, and whether it
-- worked. A FAILED action is as important as a successful one — an audit that
-- records only successes cannot show an attack that did not land.
CREATE TABLE IF NOT EXISTS enhanced_audit_logs (
  id               BIGSERIAL PRIMARY KEY,
  performed_by     TEXT,
  performed_by_name TEXT,
  performed_by_role TEXT,
  action           TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'GENERAL',
  target_type      TEXT,
  target_id        TEXT,
  target_name      TEXT,
  details          JSONB NOT NULL DEFAULT '{}'::jsonb,
  changes          JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip               TEXT,
  user_agent       TEXT,
  method           TEXT,
  endpoint         TEXT,
  success          BOOLEAN NOT NULL DEFAULT TRUE,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT enhanced_audit_details_object CHECK (jsonb_typeof(details) = 'object'),
  CONSTRAINT enhanced_audit_changes_object CHECK (jsonb_typeof(changes) = 'object'),
  -- A failure with no message is a failure nobody can investigate.
  CONSTRAINT enhanced_audit_failure_has_message CHECK (success OR error_message IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS enhanced_audit_actor_idx    ON enhanced_audit_logs (performed_by, created_at DESC);
CREATE INDEX IF NOT EXISTS enhanced_audit_category_idx ON enhanced_audit_logs (category, created_at DESC);
CREATE INDEX IF NOT EXISTS enhanced_audit_target_idx   ON enhanced_audit_logs (target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS enhanced_audit_failures_idx ON enhanced_audit_logs (created_at DESC) WHERE NOT success;
CREATE OR REPLACE TRIGGER enhanced_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON enhanced_audit_logs FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- Client-side crash reports. High volume, low value individually, pruned by
-- retention — deliberately NOT append-only.
CREATE TABLE IF NOT EXISTS frontend_error_reports (
  id         BIGSERIAL PRIMARY KEY,
  message    TEXT NOT NULL,
  stack      TEXT,
  component  TEXT,
  url        TEXT,
  panel      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS frontend_error_reports_recent_idx ON frontend_error_reports (created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- The PAN registry was removed 2026-09-30. Nothing in the product called it,
-- and §2 says no identity document beyond the Aadhaar number is collected — a
-- one-PAN-one-account table contradicted the rule it sat beside.
-- ═══════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS pan_registry;

-- ─────────────────────────────────────────────────────────────────────────────
-- What the PLATFORM got, or gave, for an admin↔merchant token movement.
--
-- The treasury already says the tokens moved: TOKEN_SUPPLY -N, TEAM_FLOAT
-- +N, legs summing to zero. What it cannot say is the OTHER SIDE of that trade
-- — the rupees that arrived in a bank account, or the USDT that arrived in a
-- wallet, in exchange. Without it the books are internally consistent and the
-- profit and loss is missing one half of every admin↔merchant trade: tokens
-- leave the platform's holding and nothing records that they were SOLD.
--
-- One row per MOVEMENT, and movement_id is the primary key, so the fiat fact
-- inherits the token movement's idempotency rather than needing its own: a
-- retried top-up collides here for exactly the same reason it collides in the
-- treasury, and a second deliberate top-up carries a different key and gets its
-- own row.
--
-- ── Why not a column on treasury_entries ────────────────────────────────────
-- A movement is TWO legs there. A column would hold the figure twice, and two
-- copies of one value drift (§5). This is one row for the movement itself.
--
-- ── Why not accounting_events ───────────────────────────────────────────────
-- That table's trigger requires every posting set to conserve to zero, which is
-- the right rule for the platform's own token books. This is EXTERNAL money —
-- rupees in a bank, USDT on a chain — with no balancing token leg, and forcing
-- it in would make the conservation invariant mean something weaker.
--
-- ── Two amounts, deliberately, and this is trap 15 ─────────────────────────
-- `fiat_amount_minor` is in the currency the platform actually transacted:
-- hundredths of it, so paise for INR and hundredths of a USDT for USDT. That is
-- the figure a human is shown and the one that reconciles against a bank line
-- or a chain explorer. `inr_equivalent_paise` is the SAME event valued in
-- rupees, and it is the only one anything may SUM — summing the first across
-- currencies reads 500 USDT as ₹500, which is the exact hundredfold
-- understatement that reached the commission engine. `rate_used` is the rate it
-- was converted at, FROZEN here the way §25 freezes an order's quote, so a
-- later edit of the admin's USDT price cannot restate a trade that has settled.
CREATE TABLE IF NOT EXISTS admin_token_considerations (
  movement_id          TEXT PRIMARY KEY,
  merchant_id          TEXT NOT NULL,
  direction            TEXT NOT NULL,
  token_amount_paise   BIGINT NOT NULL,
  currency             TEXT NOT NULL,
  fiat_amount_minor    BIGINT NOT NULL,
  inr_equivalent_paise BIGINT NOT NULL,
  rate_used            NUMERIC(18, 6),
  recorded_by          TEXT NOT NULL,
  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- RECEIVED: tokens left the platform's holding and money came in.
  -- PAID:     tokens came back and money went out.
  CONSTRAINT admin_token_considerations_direction_known CHECK (
    direction IN ('RECEIVED', 'PAID')),
  CONSTRAINT admin_token_considerations_currency_known CHECK (
    currency IN ('INR', 'USDT')),
  CONSTRAINT admin_token_considerations_tokens_positive CHECK (token_amount_paise > 0),
  -- Zero is ALLOWED and is not the same as absent. An admin correcting their own
  -- mis-keyed top-up moved tokens for no money, and recording that as 0 says so;
  -- leaving it out would let the row be missing for two different reasons.
  CONSTRAINT admin_token_considerations_fiat_nonneg CHECK (fiat_amount_minor >= 0),
  CONSTRAINT admin_token_considerations_inr_nonneg CHECK (inr_equivalent_paise >= 0),
  -- The token is pegged to the rupee and the peg is not configurable, so an INR
  -- consideration IS its own INR equivalent and carries no rate. A rate stored
  -- beside it would be a second owner of a number that cannot vary.
  CONSTRAINT admin_token_considerations_inr_is_its_own_equivalent CHECK (
    currency <> 'INR' OR (inr_equivalent_paise = fiat_amount_minor AND rate_used IS NULL)),
  -- A USDT figure with no rate cannot be valued, and a row that cannot be valued
  -- is one the P&L would have to guess at. Refused here rather than defaulted.
  CONSTRAINT admin_token_considerations_usdt_is_priced CHECK (
    currency <> 'USDT' OR (rate_used IS NOT NULL AND rate_used > 0)),
  -- The platform pays merchants back in rupees (owner, 2026-09-23). USDT comes
  -- IN only. Stated as a constraint so the rule survives the next route that
  -- writes here without reading this file.
  CONSTRAINT admin_token_considerations_payouts_are_inr CHECK (
    direction <> 'PAID' OR currency = 'INR')
);
CREATE INDEX IF NOT EXISTS admin_token_considerations_merchant_idx
  ON admin_token_considerations (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_token_considerations_created_idx
  ON admin_token_considerations (created_at DESC);
-- Append-only for the same reason the treasury is: this is what the books are
-- reconciled from, and a figure that can be edited after the fact is a figure
-- an audit cannot rely on.
CREATE OR REPLACE TRIGGER admin_token_considerations_append_only
  BEFORE UPDATE OR DELETE ON admin_token_considerations FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- The referral payout order.
--
-- A SEQUENCE, not `MAX(queue_position) + 1`. The max is computed by each
-- transaction from what it can see, so two concurrent signups both read the
-- same value and both try to claim it — the unique index then fails one of
-- them for a reason the caller cannot act on. A sequence hands out distinct
-- values to concurrent callers by construction, which is the entire reason it
-- exists. Gaps are fine: this is an ORDER, not a count.
CREATE SEQUENCE IF NOT EXISTS referral_queue_position_seq AS BIGINT START 1;

-- Advance the sequence past anything already in the table.
--
-- A fresh sequence starts at 1, so on a database that already holds earnings it
-- would hand out positions that are already taken and every insert would fail
-- on the unique index. GREATEST against `last_value` means this never moves the
-- sequence BACKWARDS, so it is safe to run on every boot like the rest of this
-- file.
SELECT setval('referral_queue_position_seq', GREATEST(
  (SELECT COALESCE(MAX(queue_position), 0) FROM referral_earnings),
  (SELECT last_value FROM referral_queue_position_seq),
  1), TRUE);

-- The signup queue position.
--
-- Same reason as the referral sequence, and the same defect before it existed:
-- `claimJoiningNumber` took `MAX(joining_number) + 1` inside its UPDATE and its
-- own comment claimed that was "a sequence over the existing maximum". It was
-- not. Two concurrent signups read the same maximum and one of them collided on
-- the unique index — a 500 at the end of onboarding, which the caller was
-- expected to retry. Its concurrency test even documented the collisions as
-- acceptable.
CREATE SEQUENCE IF NOT EXISTS joining_number_seq AS BIGINT START 1;
SELECT setval('joining_number_seq', GREATEST(
  (SELECT COALESCE(MAX(joining_number), 0) FROM users),
  (SELECT last_value FROM joining_number_seq),
  1), TRUE);

-- ═══════════════════════════════════════════════════════════════════════════
-- THE FULL ORDER RECORD
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `order_states` above owns the LIFECYCLE — the state, the guard on every move,
-- and the accounting entry written in the same transaction. These columns carry
-- everything else the order needs to be settled and, when it goes wrong,
-- disputed: the amounts, the counterparty details money is actually sent to,
-- the proof a player uploaded, and the record of who decided what.
--
-- Added as ALTERs rather than folded into the CREATE so the lifecycle tables
-- and their 19 tested functions keep their shape. Money is integer paise
-- throughout, like everywhere else.
-- Tamper evidence: an HMAC over the order id under a server-held secret, so a
-- guessed or forged order id cannot be presented as a real order. Written at
-- creation and never updated — a re-signed order is exactly what the tag exists
-- to detect. The scheme (middleware/order-crypto-access.js) accepts retained
-- rotation secrets on verify, so rotating the key never 403s an in-flight order.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS order_hmac TEXT;

ALTER TABLE order_states ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS rate_used NUMERIC(18, 6);
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS merchant_profit_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS payout_fee_paise      BIGINT NOT NULL DEFAULT 0;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS merchant_fee_paise    BIGINT NOT NULL DEFAULT 0;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS platform_fee_rate     DOUBLE PRECISION;
-- The deposit split, and the policy that produced it. SNAPSHOTTED: an admin
-- editing the policy afterwards must not change what a settled order says it
-- allocated.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS deposit_allocation_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS reserve_allocation_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS deposit_policy_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Escrow and the merchant credit hold. The hold exists so a merchant who
-- asserts payment without sending it cannot convert the tokens before the
-- player reports it.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS escrow_status TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS escrow_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS escrow_amount_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS merchant_credit_status TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS merchant_credit_hold_until TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS merchant_credit_reversed_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS merchant_credit_reversed_reason TEXT;

-- Where the money actually goes. A withdrawal is paid to these.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS user_phone TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS user_bank_details JSONB;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS user_usdt_address TEXT;

-- The payment evidence.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS utr TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS proof_screenshot TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS proof_expires_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS utr_warning BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS utr_warning_message TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS utr_warning_data JSONB;

-- Review, dispute and resolution. Every decision names WHO made it.
-- `requires_review` and its four `review_*` columns were DROPPED 2026-10-01
-- (owner decision). They held an "orders held for review" queue that nothing
-- ever filled: no path on the platform set `requires_review`, so the queue
-- route answered an empty list forever and its resolve route had nothing to
-- act on (§32 S4). Reused references are caught by `utr_registry` and worked
-- on the Payment References screen. Dropped, not left: a column nothing writes
-- is the next reader's false lead (§6).
ALTER TABLE order_states DROP COLUMN IF EXISTS requires_review;
ALTER TABLE order_states DROP COLUMN IF EXISTS reviewed_by;
ALTER TABLE order_states DROP COLUMN IF EXISTS reviewed_at;
ALTER TABLE order_states DROP COLUMN IF EXISTS review_action;
ALTER TABLE order_states DROP COLUMN IF EXISTS review_notes;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS rejected_reason TEXT;
-- The merchant's evidence for rejecting a PAID order — a bank statement
-- screenshot or a photo showing the credit never arrived. Rejecting a PAID
-- order accuses the player of not paying, adds a warning to their account and
-- can auto-block them, so the accusation carries its proof.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS rejection_proof_url TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS dispute_reason TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS dispute_raised_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS dispute_raised_by TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS dispute_escalated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS dispute_escalated_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS dispute_escalation_notes TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS dispute_resolved_by TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS dispute_resolved_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS dispute_decision TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS dispute_resolution TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS refunded_amount_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS mediator_id TEXT;

-- Red flags, assignment provenance and the merchant snapshot the player saw.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS red_flagged BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS red_flag_reason TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS red_flagged_by TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS red_flagged_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS assigned_by TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS merchant_panel_url TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS merchant_response_minutes DOUBLE PRECISION;
-- The merchant's details AS THE PLAYER SAW THEM. A merchant editing their UPI
-- id afterwards must not change the account a player was told to pay.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS merchant_snapshot JSONB;

-- Approval, cancellation, and the terminal timestamps.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS rejected_by TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS warning_issued BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
-- Merchant bulk payouts, DROPPED 2026-09-10 with the feature.
--
-- `bulk_payout_date` had no writer anywhere in the platform, so the batch query
-- that filtered on it matched nothing on every day this has run and the two
-- read routes returned an empty batch to a panel that never called them.
-- Dropped rather than left in place, for the same reason as the split-leg
-- columns further down: a column nothing writes is a column the next reader has
-- to work out the status of. Do not accommodate; remove.
ALTER TABLE order_states DROP COLUMN IF EXISTS bulk_payout_date;
ALTER TABLE order_states DROP COLUMN IF EXISTS bulk_paid_at;
ALTER TABLE order_states DROP COLUMN IF EXISTS bulk_payout_batch;

DO $$ BEGIN
  ALTER TABLE order_states ADD CONSTRAINT order_states_currency_known
    CHECK (currency IN ('INR', 'USDT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- The split has to close: a deposit allocated in two directions must add up
  -- to what was deposited, or the difference is money nothing accounts for.
  ALTER TABLE order_states ADD CONSTRAINT order_states_allocation_closes
    CHECK (deposit_allocation_paise + reserve_allocation_paise
           IN (0, token_amount_paise));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- A resolved dispute names who resolved it and how. "It was resolved" with
  -- no decider is a resolution nobody can be asked about.
  ALTER TABLE order_states ADD CONSTRAINT order_states_resolution_has_decider
    CHECK (dispute_resolved_at IS NULL
           OR (dispute_resolved_by IS NOT NULL AND dispute_decision IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE order_states ADD CONSTRAINT order_states_flag_has_reason
    CHECK (NOT red_flagged OR red_flag_reason IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE order_states ADD CONSTRAINT order_states_refund_non_negative
    CHECK (refunded_amount_paise >= 0 AND refunded_amount_paise <= token_amount_paise);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One UTR per order, enforced here as well as by `utr_registry`: the registry
-- stops the same reference being used on two orders, this stops one order
-- carrying two.
CREATE UNIQUE INDEX IF NOT EXISTS order_states_utr_unique
  ON order_states (utr) WHERE utr IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_states_expiring_idx ON order_states (expires_at)
  WHERE expires_at IS NOT NULL AND state IN ('PENDING_QUEUE', 'ASSIGNED', 'PROCESSING');
CREATE INDEX IF NOT EXISTS order_states_disputes_idx ON order_states (dispute_raised_at DESC)
  WHERE state = 'DISPUTED';

-- ── UTR REGISTRY: the lifecycle, and why the rows are permanent ─────────────
--
-- A UTR is a bank's reference for a real transfer. Reusing one across two
-- orders is either a mistake or an attempt to claim one payment twice, and
-- detecting it is an anti-fraud control an operator is expected to have.
--
-- The row therefore OUTLIVES the order. `RELEASED` means the order finished and
-- the reference is spent — NOT that it is available again. Nothing in the
-- application deletes from this table; the primary key is what refuses the
-- second use, and a delete would hand the reference back to whoever wanted it.
ALTER TABLE utr_registry ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE utr_registry ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
ALTER TABLE utr_registry ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;
ALTER TABLE utr_registry ADD COLUMN IF NOT EXISTS flagged_by TEXT;
ALTER TABLE utr_registry ADD COLUMN IF NOT EXISTS flag_reason TEXT;
ALTER TABLE utr_registry ADD COLUMN IF NOT EXISTS duplicate_attempts INTEGER NOT NULL DEFAULT 0;
-- When the reference was last contested. The counter alone cannot order a
-- review queue: nothing ever leaves this table, so attempts accumulate forever
-- and a queue sorted by count converges on a fixed list of the oldest, most
-- attacked references while everything new sorts underneath it and is never
-- seen. A manual FRAUD flag starts at zero attempts, so it sorted LAST — the
-- one entry a human had already looked at was the one an operator could not
-- reach.
ALTER TABLE utr_registry ADD COLUMN IF NOT EXISTS last_contested_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE utr_registry ADD CONSTRAINT utr_registry_status_known
    CHECK (status IN ('ACTIVE', 'RELEASED', 'FRAUD'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- A fraud flag names who raised it and why. An unattributed fraud marking is
  -- one nobody can defend in a dispute, and it blocks a real customer.
  ALTER TABLE utr_registry ADD CONSTRAINT utr_registry_flag_has_actor
    CHECK (status <> 'FRAUD' OR (flagged_by IS NOT NULL AND flag_reason IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE utr_registry ADD CONSTRAINT utr_registry_attempts_non_negative
    CHECK (duplicate_attempts >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS utr_registry_user_idx ON utr_registry (user_id, registered_at DESC);
-- The review queue: references somebody tried to use more than once, newest
-- contest first. Ordered by the same expression the query uses, so the queue is
-- an index scan rather than a sort over a table that only ever grows.
--
-- Named for the ordering rather than reusing `utr_registry_contested_idx`:
-- CREATE INDEX IF NOT EXISTS leaves an existing index of that name alone, so an
-- already-provisioned database would keep the count-ordered one and silently
-- sort. The old index is dropped by name for the same reason.
DROP INDEX IF EXISTS utr_registry_contested_idx;
CREATE INDEX IF NOT EXISTS utr_registry_contested_recent_idx
  ON utr_registry ((COALESCE(last_contested_at, flagged_at, registered_at)) DESC, duplicate_attempts DESC)
  WHERE duplicate_attempts > 0 OR status = 'FRAUD';

-- Nothing deletes a registered reference.
--
-- A DELETE trigger rather than a convention, because the convention was
-- `clearAllUTRs()` — an exported function that emptied the whole registry and
-- was one import away from any route. Reusing a bank reference is the thing
-- this table exists to prevent, and a table that can be emptied prevents it
-- only until someone empties it.
CREATE OR REPLACE FUNCTION bb_forbid_utr_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'utr_registry rows are permanent — a released UTR is spent, not free';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER utr_registry_no_delete
  BEFORE DELETE ON utr_registry FOR EACH ROW EXECUTE FUNCTION bb_forbid_utr_delete();

-- The bet's cycle type, denormalised.
--
-- A player's bet history shows which market each bet was on, and joining
-- `cycles` for every row of every history page is a join that buys one string.
-- It is written once at placement and a cycle's type never changes, so this is
-- a copy that cannot drift — the one case where denormalising is not a second
-- owner waiting to disagree.
ALTER TABLE bets ADD COLUMN IF NOT EXISTS cycle_type TEXT;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS is_phantom BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS phantom_manager_id TEXT;

-- A player's history, newest first — the query the panel makes on every load.
CREATE INDEX IF NOT EXISTS bets_user_history_idx
  ON bets (user_id, placed_at DESC, id DESC) WHERE NOT is_phantom;

-- ── The recent-winners feed, which is PUBLIC and on the home screen ──────────
--
-- `realWinners` asks for WON bets settled in the last N hours, ordered by
-- payout. With nothing to serve it, that is a Parallel Seq Scan of every bet
-- ever placed — on an unauthenticated endpoint every player's home screen
-- calls.
--
-- MEASURED on 2,000,000 bets (`npm run loadtest:scale`): the endpoint answered
-- in 200ms while every other public path answered in 2-4ms, and it capped a
-- concurrency ramp at ~40 req/s all by itself. With this index the query drops
-- from 171ms to 40ms, and it is the SCAN that goes away — the remaining cost is
-- reading the window, which is proportional to a day's play rather than to the
-- table.
--
-- Partial, on the two facts the feed requires, so it holds only the rows the
-- feed can ever return and does not grow with losing or unsettled bets.
CREATE INDEX IF NOT EXISTS bets_recent_winners_idx
  ON bets (settled_at DESC, payout_paise DESC)
  WHERE status = 'WON' AND payout_paise > 0;

-- ── The rail an order runs on ────────────────────────────────────────────────
-- Derived at creation from the order's size and currency (`paymentModeFor` in
-- database/repositories/orderRails.js) and immutable thereafter, so every
-- worker and every screen branches on THIS column.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'P2P_UPI';
DO $$ BEGIN
  ALTER TABLE order_states ADD CONSTRAINT order_states_payment_mode_known
    CHECK (payment_mode IN ('P2P_UPI', 'CASH_ATM'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Immutability is a property of the row, not a convention a writer is trusted
-- to honour. `setOrderFields` is an allowlist and does not name these, but the
-- allowlist is one edit away from naming them and nothing would fail.
--
-- ── EVERYTHING frozen on an order is frozen HERE ───────────────────────────
-- This function was written three times in this file — once for the rail, once
-- for the USDT chain, once for the quote — each a CREATE OR REPLACE of the same
-- name. Only the LAST one exists after the schema is applied, so the first two
-- were text: editing them changed nothing, and the mutation that deletes the
-- rail check from the first block was reported as surviving because the third
-- block silently put it back.
--
-- One name, one definition. A new frozen fact is a branch added here, beside
-- the others, where a reader can see all of them at once. The columns the
-- later branches name (`usdt_chain`, `rate_used`) are added further down this
-- file; that is fine — a plpgsql body is resolved when it RUNS, not when it is
-- created, and the schema is applied end to end before any row is updated.
CREATE OR REPLACE FUNCTION bb_forbid_order_mode_change() RETURNS trigger AS $$
BEGIN
  IF NEW.payment_mode IS DISTINCT FROM OLD.payment_mode THEN
    RAISE EXCEPTION 'order % was created on the % rail and cannot be moved to %',
      OLD.order_id, OLD.payment_mode, NEW.payment_mode;
  END IF;
  IF OLD.usdt_chain IS NOT NULL AND NEW.usdt_chain IS DISTINCT FROM OLD.usdt_chain THEN
    RAISE EXCEPTION 'order % is being paid on % and cannot be moved to another chain',
      OLD.order_id, OLD.usdt_chain;
  END IF;
  IF OLD.rate_used IS NOT NULL AND NEW.rate_used IS DISTINCT FROM OLD.rate_used THEN
    RAISE EXCEPTION 'order % was quoted at rate % and cannot be re-priced',
      OLD.order_id, OLD.rate_used;
  END IF;
  IF OLD.fiat_amount_paise <> 0 AND NEW.fiat_amount_paise IS DISTINCT FROM OLD.fiat_amount_paise THEN
    RAISE EXCEPTION 'order % was quoted at % and cannot be re-quoted',
      OLD.order_id, OLD.fiat_amount_paise;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER order_states_mode_immutable
  BEFORE UPDATE ON order_states FOR EACH ROW EXECUTE FUNCTION bb_forbid_order_mode_change();

-- ═══════════════════════════════════════════════════════════════════════════
-- 🧩 ONE WITHDRAWAL IS ONE ORDER
--
-- A cash payout used to be split into several withdrawals, first as a parent
-- with legs and then as flat siblings sharing a label. Neither survives: the
-- owner removed splitting (2026-10-02) and in Step 2d every order became one of
-- a fixed list of sizes. The split's columns are dropped at the end of this
-- file with the rest of 2d's removals.
ALTER TABLE order_states DROP CONSTRAINT IF EXISTS order_states_leg_has_index;
ALTER TABLE order_states DROP CONSTRAINT IF EXISTS order_states_leg_index_positive;
ALTER TABLE order_states DROP CONSTRAINT IF EXISTS order_states_leg_holds_no_escrow;
ALTER TABLE order_states DROP CONSTRAINT IF EXISTS order_states_parent_unassigned;
ALTER TABLE order_states DROP CONSTRAINT IF EXISTS order_states_split_is_one_level;
DROP INDEX IF EXISTS order_states_legs_idx;
DROP INDEX IF EXISTS order_states_stalled_legs_idx;
ALTER TABLE order_states DROP COLUMN IF EXISTS parent_order_id;
ALTER TABLE order_states DROP COLUMN IF EXISTS leg_index;
ALTER TABLE order_states DROP COLUMN IF EXISTS is_split_parent;

-- Withdrawals still waiting for a merchant — the admin's stalled queue: which
-- payouts have nobody working them? A player's tokens are locked behind
-- every row here, and an order with no deadline and no owner is one nobody is
-- answerable for.
CREATE INDEX IF NOT EXISTS order_states_stalled_withdrawals_idx
  ON order_states (created_at)
  WHERE order_type = 'WITHDRAWAL' AND state = 'PENDING_QUEUE';

-- ═══════════════════════════════════════════════════════════════════════════
-- ⏱️  THE UTR GRACE — a minute to fetch the reference, taken once
--
-- The order's own timer IS the UTR deadline. A player who taps "I have paid"
-- with fifteen seconds left is not going to find a twelve-character bank
-- reference in fifteen seconds, and the order expiring under them cancels a
-- payment they have already made — the worst outcome this flow has, because the
-- money is gone and the order is not.
--
-- So tapping it claims `SystemConfig.teamRouting.utrSubmitSeconds` from that
-- moment (admin-editable, default 60).
--
-- ── Why the timestamp is a column and not a counter ───────────────────────
-- The grace is claimable ONCE. Without that it is an unbounded extension: a
-- player taps the button every fifty seconds and holds a merchant's capacity
-- open indefinitely, which is a denial of service against the merchant queue
-- wearing the shape of a courtesy.
--
-- Recording WHEN it was taken rather than THAT it was taken makes the rule a
-- property of the row — a second claim finds a non-null column and is refused —
-- and leaves a dispute able to see how long the player actually had.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS utr_grace_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════
-- 🔁 RETRY, AND THE PRIORITY IT CARRIES
--
-- An order that never found a merchant owes nothing: no assignment means no
-- transaction happened and nobody is liable. But the player still wants their
-- tokens, and sending them to the back of the same queue that already failed
-- them is how somebody waits twice and gets nothing twice.
--
-- So a retry outranks a first-time order. `assignment_priority` is that rank —
-- higher first, and the tie is broken by age, so within a rank it stays
-- first-come-first-served.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS assignment_priority INTEGER NOT NULL DEFAULT 0;
DO $$ BEGIN
  -- A negative rank is not "lower priority", it is a queue somebody can bury an
  -- order in. There is no caller that wants one.
  ALTER TABLE order_states ADD CONSTRAINT order_states_priority_not_negative
    CHECK (assignment_priority >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Which expired order this one is a second attempt at.
--
-- ── The UNIQUE is the rule, not a comment about it ────────────────────────
-- Retrying the same expired order twice creates two live orders for one
-- intent. On a buy that is two merchants assigned and one of them wasted; on a
-- SELL it is the player's tokens locked TWICE, because each withdrawal takes
-- its own escrow. A partial unique index makes the second attempt impossible
-- rather than merely discouraged — the same reasoning as the unique `tx_id`
-- gate: the database refuses it, so no caller has to remember.
--
-- Beyond that it is a label. Nothing joins on it, no state is derived from it,
-- and the retry is an ORDINARY order in every other respect — the lesson the
-- withdrawal split paid for.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS retry_of_order_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS order_states_one_retry_per_order_idx
  ON order_states (retry_of_order_id)
  WHERE retry_of_order_id IS NOT NULL;

-- Orders waiting for a team member, best first: the queue the assignment
-- sweep walks (`queuedOrdersForAssignment`).
DROP INDEX IF EXISTS order_states_awaiting_link_idx;
CREATE INDEX IF NOT EXISTS order_states_queued_idx
  ON order_states (assignment_priority DESC, created_at ASC)
  WHERE state = 'PENDING_QUEUE';

-- ── A USDT merchant holds an address PER CHAIN ──────────────────────────────
--
-- USDT is one token on several blockchains, and they are not interchangeable:
-- USDT sent to a TRC-20 address from a BEP-20 wallet is gone. So the player
-- chooses the chain THEY hold funds on, and is shown only the address that can
-- receive them.
--
-- `usdt_wallet_address` was ONE column with a TRC-20 CHECK on it, which made
-- Tron the only chain a merchant could serve and made "which chain is this?" a
-- question the schema could not answer. Two columns say it instead: a merchant
-- may hold one, the other, or both, and the assignment query filters on the
-- chain the order asked for.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS usdt_address_trc20 TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS usdt_address_bep20 TEXT;

-- Carry the existing addresses across before the old column goes. Its CHECK was
-- the TRC-20 format, so every value in it is a Tron address by construction.
--
-- Guarded on the column still existing: this file is applied REPEATEDLY and
-- every statement in it has to be idempotent. A bare UPDATE naming a dropped
-- column is a hard error on the second run, which fails the whole schema apply
-- — and the second run is every run after the first deployment.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'merchants' AND column_name = 'usdt_wallet_address') THEN
    UPDATE merchants
       SET usdt_address_trc20 = usdt_wallet_address
     WHERE usdt_wallet_address IS NOT NULL AND usdt_address_trc20 IS NULL;
    ALTER TABLE merchants DROP COLUMN usdt_wallet_address;
  END IF;
END $$;

DO $$ BEGIN
  -- 34 base58 characters beginning with T. Base58 excludes 0, O, I and l so
  -- visually similar characters cannot be confused.
  ALTER TABLE merchants ADD CONSTRAINT merchants_usdt_trc20_format CHECK (
    usdt_address_trc20 IS NULL
    OR usdt_address_trc20 ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- BEP-20 is an EVM chain, so the address is the ordinary 20-byte hex form.
  -- Case is not checked: EIP-55 mixed-case is a CHECKSUM, and rejecting a
  -- lower-case address would refuse the form most wallets copy.
  ALTER TABLE merchants ADD CONSTRAINT merchants_usdt_bep20_format CHECK (
    usdt_address_bep20 IS NULL
    OR usdt_address_bep20 ~ '^0x[0-9a-fA-F]{40}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- ── Why there is NO "a USDT merchant must hold an address" constraint ───────
--
-- It was written and backed out. A merchant is created, an admin puts them on
-- the USDT rail, and only THEN do they enter a wallet address — so a row-level
-- check refuses the middle step of the ordinary signup, and the migration fails
-- outright on every merchant already on the rail without one.
--
-- It could not be right anyway. The question is not "does this merchant hold an
-- address" but "does this merchant hold an address ON THE CHAIN THIS ORDER
-- ASKED FOR", and a row cannot see the order. The guard belongs in the
-- assignment query, where it is per-chain and where a merchant with no address
-- is simply not a candidate. The merchant panel says so on their own screen, so
-- the symptom is visible rather than silent.

-- A wallet address is an IDENTITY, for the same reason a bank account is: two
-- merchants sharing one means money routed to either arrives at one, and no
-- record afterwards can say which was intended.
CREATE UNIQUE INDEX IF NOT EXISTS merchants_usdt_trc20_unique
  ON merchants (usdt_address_trc20) WHERE usdt_address_trc20 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS merchants_usdt_bep20_unique
  ON merchants (usdt_address_bep20) WHERE usdt_address_bep20 IS NOT NULL;

-- ── The chain a USDT order is being paid on ────────────────────────────────
--
-- Chosen by the PLAYER at creation, from the chain they hold funds on, and
-- fixed for the life of the order: the merchant snapshot carries the address
-- for this chain and nothing else, and a chain that changed after assignment
-- would point a player at an address on a network they cannot reach.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS usdt_chain TEXT;

DO $$ BEGIN
  ALTER TABLE order_states ADD CONSTRAINT order_states_usdt_chain_known
    CHECK (usdt_chain IS NULL OR usdt_chain IN ('TRC20', 'BEP20'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- The chain and the currency are one fact stated twice, so the row insists
  -- they agree: a USDT order names a chain, an INR order names none. Without
  -- this an INR order could carry a chain nothing reads, and a USDT order could
  -- carry none while the assignment query silently matched no merchant.
  ALTER TABLE order_states ADD CONSTRAINT order_states_usdt_chain_matches_currency
    CHECK ((currency = 'USDT') = (usdt_chain IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The assignment path for a USDT buy: merchants on this rail holding an address
-- on the chain the order asked for.
CREATE INDEX IF NOT EXISTS merchants_usdt_trc20_live_idx
  ON merchants (status, merchant_approval_status)
  WHERE usdt_address_trc20 IS NOT NULL;
CREATE INDEX IF NOT EXISTS merchants_usdt_bep20_live_idx
  ON merchants (status, merchant_approval_status)
  WHERE usdt_address_bep20 IS NOT NULL;

-- ── The chain a USDT order pays on cannot move ─────────────────────────────
--
-- The same rule as the payment mode, and the consequence is worse. The merchant
-- snapshot carries the address for THIS chain and nothing else; repointing the
-- order afterwards would leave a player holding an address on a network they
-- did not choose and may not be able to reach. USDT sent on the wrong network
-- is gone.
--
-- The check itself lives in `bb_forbid_order_mode_change()` above, with every
-- other fact frozen on an order. Redefining the function here would replace
-- that one rather than add to it — which is precisely what this file used to
-- do, three times over.

-- ── A quote already given cannot be re-made ────────────────────────────────
--
-- `rate_used` and `fiat_amount_paise` are what the player was SHOWN before they
-- agreed to anything. On the USDT rail that is a token count and the USDT they
-- must send, derived from an admin-editable rate at creation.
--
-- The rate was read again when a merchant was assigned — minutes later — and
-- written over the top, so an admin editing it in between silently re-priced a
-- purchase already agreed to. The player had been told 500 USDT and the order
-- then said something else, with nothing recording that it had moved.
--
-- Setting a NULL rate is still allowed: an order created before this column
-- existed has none, and assignment is what gives it one. What is refused is
-- CHANGING a rate that is already there.
--
-- The checks themselves are in `bb_forbid_order_mode_change()` above, with the
-- rail and the chain.

-- ─────────────────────────────────────────────────────────────────────────────
-- Gift codes, DROPPED 2026-09-10 with the feature (F-014).
--
-- The code was a BEARER CREDENTIAL — presenting the string credited real money
-- from the promotional pool — and it was minted client-side by the admin
-- panel's `Math.random().toString(36)`, which is neither a CSPRNG nor a value
-- this platform owned (§2: one owner per value, and a security value's owner is
-- never a panel). Redemption was authenticated but carried no route-level rate
-- limit and answered NOT_FOUND distinguishably from every other refusal, which
-- is an enumeration oracle over a space nothing bounded.
--
-- Removed rather than hardened, on the owner's decision: the feature was not
-- worth the surface.
--
-- What deliberately STAYS: `bonus_grants` rows with `ref_model = 'GiftCode'`.
-- Those are money that actually moved, and the ledger is append-only (§19) — a
-- payout is not unmade by retiring the thing that triggered it. They read
-- correctly without these tables, because a grant row carries its own `kind`
-- and `amount_paise` and never joins back to the code.
DROP TABLE IF EXISTS gift_code_redemptions;
DROP TABLE IF EXISTS gift_codes;

-- ─────────────────────────────────────────────────────────────────────────────
-- The merchant QR, DROPPED 2026-09-10 with the feature.
--
-- A stored QR image of the merchant's own: it could not carry an order's
-- amount, and it was unreachable besides: its upload route had no UI, while the
-- profile field that stored it was constrained to this platform's CDN, so the
-- only acceptable value was one only that unreachable route could mint (F-016).
-- The QR a cash buy is paid through now is the ATM's, scanned per order
-- (`order_states.cash_link`, Step 2d).
DROP INDEX IF EXISTS merchants_qr_code_url_idx;
ALTER TABLE merchants DROP COLUMN IF EXISTS qr_code_url;

-- ─────────────────────────────────────────────────────────────────────────────
-- Who has REFUSED an order, and whose order it was.
--
-- `order_states.rejected_by` is a single column and is overwritten, so after a
-- second merchant declines the same order the first one is gone. That is enough
-- to show the last reason on a screen and not enough to decide anything, and
-- two rules need to decide something:
--
--   1. a rejected order must never be handed back to a merchant who already
--      refused it — without this the reject route requeues and immediately
--      reassigns, and the same merchant can receive it again in a loop;
--   2. a merchant who refuses a player's order does not serve that player
--      again — the pair is recorded, not just the order.
--
-- Append-only and one row per (order, merchant): a merchant cannot refuse the
-- same order twice, and the UNIQUE index is what says so rather than a pre-read
-- two concurrent rejects could both pass.
--
-- `user_id` is denormalised deliberately. The pair query runs inside merchant
-- ASSIGNMENT, on the hot path of every order, and joining back to order_states
-- to recover the player would make the exclusion cost a join per assignment.
CREATE TABLE IF NOT EXISTS order_rejections (
  id           BIGSERIAL PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES order_states (order_id) ON DELETE CASCADE,
  merchant_id  TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  rejected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_rejections_once UNIQUE (order_id, merchant_id)
);
-- The two reads this table exists for.
CREATE INDEX IF NOT EXISTS order_rejections_order_idx ON order_rejections (order_id);
CREATE INDEX IF NOT EXISTS order_rejections_pair_idx  ON order_rejections (user_id, merchant_id);

-- Consecutive refusals, reset by any COMPLETED order.
--
-- CONSECUTIVE rather than a rate: a rate over all time forgives a merchant who
-- is refusing everything today because they served a thousand orders last
-- month, and it punishes a new merchant for one decline. A streak asks the only
-- question that matters operationally — is this merchant serving orders right
-- now — and answers it the same way for everybody.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS consecutive_rejections INTEGER NOT NULL DEFAULT 0;

-- ── A player's consecutive unpaid buy orders ─────────────────────────────────
-- The mirror of `merchants.consecutive_rejections`, and it exists for the same
-- reason: a pattern is a different fact from a total. A player who abandons the
-- occasional purchase is ordinary; one who places five in a row and pays for
-- none of them is holding merchant inventory hostage — every one of those
-- orders reserved a merchant's tokens for the length of its window.
--
-- CONSECUTIVE, so any completed buy sets it back to zero. A lifetime total
-- would eventually catch every long-standing player, which is the shape that
-- gets a control switched off rather than tuned.
-- ── Per-merchant order min/max: removed ─────────────────────────────────────
-- Two admin-editable numbers that gated nothing. `assignmentCandidates` never
-- named either column; the only filter on them was in the admin's
-- available-merchants LIST, a screen — while a comment in merchant.routes.js
-- stated that assignment filtered on them, and was believed.
--
-- Both questions they were reaching for have owners. The CEILING is the tokens
-- the merchant holds, and the deposit escrow ENFORCES it by reserving them at
-- assignment rather than checking a number (F-018). The SIZE is platform-wide:
-- one of the fixed order sizes on offer (SystemConfig.orderSizes, Step 2d).
--
-- Dropped rather than left in place, per §3: an admin-editable field with no
-- consumer is a violation, and a column nothing reads is the next reader's
-- false lead.
--
-- The CONSTRAINTS are rebuilt BEFORE the columns go, and that order is
-- load-bearing: `DROP COLUMN` cascades to every constraint naming the column,
-- and `merchants_limits_non_negative` also guards `min_deposit_paise` and
-- `min_withdraw_paise`. Dropping the column first would have taken those two
-- guards with it, silently — a schema that still reads correct and no longer
-- refuses a negative deposit floor.
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_limits_ordered;
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_limits_non_negative;
ALTER TABLE merchants DROP COLUMN IF EXISTS min_order_paise;
ALTER TABLE merchants DROP COLUMN IF EXISTS max_order_paise;
DO $$ BEGIN
  ALTER TABLE merchants ADD CONSTRAINT merchants_limits_ordered CHECK (
    min_deposit_paise <= max_deposit_paise
    AND min_withdraw_paise <= max_withdraw_paise);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE merchants ADD CONSTRAINT merchants_limits_non_negative CHECK (
    min_deposit_paise >= 0 AND min_withdraw_paise >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS consecutive_payment_failures INTEGER NOT NULL DEFAULT 0;

-- ── The one-hour cool-off after three unpaid buy orders ─────────────────────
-- A TIMESTAMP, not a boolean. A flag would need something to turn it off, and
-- that something is a cron job that can fail, lag, or be forgotten — the lock
-- would outlive its hour and nobody would know why the player cannot buy. A
-- deadline in the row expires ON ITS OWN: every read compares it to now(), so
-- an hour after it was set the lock is simply gone, with nothing scheduled and
-- nothing to go wrong.
--
-- Distinct from `is_blocked`, which is an admin's decision about an account and
-- has no end. This is a cool-off the platform applies by itself and lifts by
-- itself (§7 — one state field per logical question).
ALTER TABLE users ADD COLUMN IF NOT EXISTS order_lock_until TIMESTAMPTZ;

-- ── A merchant's consecutive EXPIRIES, which are not refusals ───────────────
-- Deliberately NOT `consecutive_rejections`. An expired buy order is nobody's
-- fault: the player did not pay, and the merchant did nothing wrong. Counting
-- it as a refusal would suspend an honest merchant for three players who
-- changed their minds.
--
-- But three in a row IS a signal worth acting on, and it points at the
-- MERCHANT: if three different players were each assigned to Anil and none of
-- them could pay, the likeliest explanation is that something about Anil is
-- broken — a dead QR, a closed UPI handle, a bank that is rejecting. Nothing
-- else on the platform would ever notice that, because each individual failure
-- looks like an ordinary abandoned purchase.
--
-- So this counter exists to FIND the problem, and what it triggers is a pause
-- and a conversation, not a penalty.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS consecutive_expiries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS assignment_paused_at TIMESTAMPTZ;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS assignment_pause_reason TEXT;
DO $$ BEGIN
  ALTER TABLE merchants ADD CONSTRAINT merchants_consecutive_expiries_non_negative
    CHECK (consecutive_expiries >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- A pause nobody can explain is one nobody can lift, so the reason travels with
-- it — the same rule `merchants_suspension_reason_present` already applies to a
-- suspension.
DO $$ BEGIN
  ALTER TABLE merchants ADD CONSTRAINT merchants_assignment_pause_reason_present CHECK (
    assignment_paused_at IS NULL
    OR (assignment_pause_reason IS NOT NULL AND assignment_pause_reason <> ''));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_consecutive_payment_failures_non_negative
    CHECK (consecutive_payment_failures >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE merchants ADD CONSTRAINT merchants_consecutive_rejections_non_negative
    CHECK (consecutive_rejections >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Form signup, and the sign-in bot FLEET (2026-09-23)
-- ═══════════════════════════════════════════════════════════════════════════
-- An account is now created by a FORM — Aadhaar, the Aadhaar-linked mobile, a
-- password and a captcha — and Telegram is the VERIFICATION step that follows,
-- not the thing that creates the account. Two consequences land in the schema.

-- ── 1. Which bot this account was told to open ─────────────────────────────
-- The fleet exists because one bot is a throughput ceiling (~30 messages a
-- second, Bot API). The assignment is STORED rather than recomputed, because a
-- player is TOLD which bot to open: recomputing it would send them to a
-- different conversation on their next page load, and the one they had already
-- started would be the one holding their contact share.
--
-- Nullable: an account created while the operator has registered no bot yet is
-- a real state (it is exactly where a launch sits), and it is assigned the
-- moment one exists rather than being refused at signup.
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_bot_id TEXT;
CREATE INDEX IF NOT EXISTS users_telegram_bot_idx ON users (telegram_bot_id)
  WHERE telegram_bot_id IS NOT NULL;

-- ── 2. The rotation cursor ─────────────────────────────────────────────────
-- Round robin, in the owner's words: "assign 1, assign 2, then 3rd, 4th, 5th
-- and so on, and once it reaches all, again start from 1."
--
-- A SEQUENCE, not a counter row and not a number held in a process. Trap 6
-- forbids accumulating a counter in memory, and a counter row would have to be
-- locked by every signup; `nextval` is non-transactional by design, so two
-- signups arriving together get two different numbers without either waiting
-- for the other. It is allowed to skip on a rollback — a skipped number costs
-- one bot one position in a cycle, which is nothing, and is the correct trade
-- against serialising every signup behind one row.
--
-- The list it indexes is read at assignment time, so adding, replacing or
-- retiring a bot changes the cycle from the next signup onward with nothing to
-- reset.
CREATE SEQUENCE IF NOT EXISTS telegram_signin_rotation;

-- ── 3. What a contact share is matched against ─────────────────────────────
-- The form's mobile. `telegram_identities.phone` already holds Telegram's own
-- verified number for the account, and `users.mobile` holds what was typed —
-- the link is made only when they are the same number, which is what makes the
-- Telegram step a VERIFICATION of the form rather than a second signup.
CREATE INDEX IF NOT EXISTS telegram_identities_phone_idx ON telegram_identities (phone);

-- ── `signin` became a FLEET: rebuild live_slot on a database that predates it ─
--
-- The table above is `CREATE TABLE IF NOT EXISTS`, so an existing database
-- keeps the OLD generated column — the one that names `signin` as a singular
-- role — and the partial unique index then refuses the SECOND live sign-in bot
-- with "duplicate key value violates one_live_bot_per_singular_role".
--
-- That failure is worse than it looks: it arrives on the operator's second bot,
-- which is the moment the fleet starts being a fleet, and its message describes
-- a rule the platform no longer has. Measured on a developer database, which is
-- exactly where it would have been met.
--
-- Guarded on the column's own EXPRESSION rather than on a version marker, so it
-- runs once and is a no-op every time after — including on a database created
-- fresh from this file, where the column is already right.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_attrdef d
      JOIN pg_class     c ON c.oid = d.adrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.adnum
     WHERE c.relname = 'telegram_bots'
       AND a.attname = 'live_slot'
       AND pg_get_expr(d.adbin, d.adrelid) LIKE '%signin%'
  ) THEN
    -- The index depends on the column, so it goes first and comes back after.
    DROP INDEX IF EXISTS one_live_bot_per_singular_role;
    ALTER TABLE telegram_bots DROP COLUMN live_slot;
    ALTER TABLE telegram_bots ADD COLUMN live_slot TEXT GENERATED ALWAYS AS (
      CASE WHEN status = 'ACTIVE' AND role = 'recovery' THEN role END
    ) STORED;
    CREATE UNIQUE INDEX one_live_bot_per_singular_role
      ON telegram_bots (live_slot) WHERE live_slot IS NOT NULL;
    RAISE NOTICE 'telegram_bots.live_slot rebuilt: signin is a fleet, recovery stays singular';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Three separate entities: player, staff, merchant (owner, 2026-09-24)
-- ═══════════════════════════════════════════════════════════════════════════
-- One person may hold a PLAYER account and a STAFF account, with DIFFERENT
-- passwords, and the credentials for one must not work on the other.
--
-- Merchants were already separate — their own table, their own login, their own
-- token shape. Players and staff were not: they share `users`, distinguished by
-- `is_admin` / `is_sub_admin`, and `mobile` was globally UNIQUE. So the same
-- person could not have both, and the door between them was a role check on a
-- row either door could read.
--
-- ── Why a type column rather than a second table ──────────────────────────
-- The separation that matters is the one the LOGIN performs, and a column makes
-- that a predicate in the SELECT: the staff door reads only STAFF rows and the
-- player door only PLAYER rows. A row can therefore never be admitted at the
-- wrong door even if somebody flips `is_admin` on it — which a role check made
-- after the read cannot promise. A second table would say the same thing more
-- loudly and move every admin route, the 2FA enrolment and the audit trail with
-- it; the owner chose the column (2026-09-24).
--
-- ── The uniqueness rule moves, it does not go away ────────────────────────
-- `UNIQUE (mobile)` becomes `UNIQUE (mobile, account_type)`. One mobile still
-- holds at most one PLAYER account and at most one STAFF account. Dropping the
-- old constraint is the load-bearing half: leaving it would make the new one
-- decorative and the second account impossible with a message naming neither.
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'PLAYER';
-- DROP then ADD, not "add if it is missing".
--
-- A guarded `ADD CONSTRAINT ... EXCEPTION WHEN duplicate_object` is idempotent
-- but NOT convergent: when the constraint already exists it does nothing, and
-- "does nothing" is wrong the moment the DEFINITION changes. Measured — this
-- CHECK was widened from (PLAYER, STAFF) to include MERCHANT, the guard skipped
-- it because a constraint of that name existed, and every merchant signup then
-- failed with `violates check constraint "users_account_type_check"` on a value
-- the file plainly allows.
--
-- The rule for this file: a constraint whose DEFINITION may change is dropped
-- and re-added. A guard is only safe for one whose definition is fixed forever.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_type_check;
ALTER TABLE users ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('PLAYER', 'STAFF', 'MERCHANT'));

-- ── MERCHANT is here too, and that was not obvious ────────────────────────
-- A merchant signup writes a `users` row as well as a `merchants` row — the
-- merchant's own table holds the trading identity, and `users` holds the login.
-- So merchants are NOT a separate population by virtue of living elsewhere:
-- without a type of their own they default to PLAYER, and the player login door
-- would then admit a merchant using their merchant password. Measured while
-- adding this column.
--
-- Existing rows predate the column and default to PLAYER, which would put staff
-- behind the player door and lock every admin out. Classified from what the row
-- already says it is — the role flags for staff, the `roles` array for
-- merchants, both of which are written at creation.
UPDATE users SET account_type = 'STAFF'
 WHERE account_type = 'PLAYER'
   AND (is_admin OR is_sub_admin OR is_queue_manager OR is_mediator);
UPDATE users SET account_type = 'MERCHANT'
 WHERE account_type = 'PLAYER' AND roles @> ARRAY['merchant'];

DO $$ BEGIN
  ALTER TABLE users DROP CONSTRAINT users_mobile_key;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- Guarded on EXISTENCE, not by catching one error code.
--
-- `ADD CONSTRAINT ... UNIQUE` creates an INDEX of the same name, so a re-run
-- can raise `duplicate_table` (42P07) rather than `duplicate_object` (42710) —
-- whenever the index outlives the constraint, which is what a half-applied run
-- or a hand-dropped constraint leaves behind. An `EXCEPTION WHEN
-- duplicate_object` guard looks idempotent and is not: it re-raises, and the
-- schema apply stops THERE, leaving every statement after it unapplied.
--
-- Found exactly that way: the apply died here, `sessions_valid_from` below was
-- never created, and the server booted against a table missing a column its own
-- projection names.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'users'::regclass AND conname = 'users_mobile_per_account_type'
  ) THEN
    -- The orphaned index, if one is what is in the way.
    DROP INDEX IF EXISTS users_mobile_per_account_type;
    ALTER TABLE users ADD CONSTRAINT users_mobile_per_account_type UNIQUE (mobile, account_type);
  END IF;
END $$;

-- ── Staff authority lives on STAFF rows, and nowhere else ─────────────────
-- The doors keep a PLAYER row out of the staff LOGIN. They do not keep staff
-- authority out of a PLAYER SESSION: `isAdmin`, `hasPermission` and
-- `queueManagerOrPermission` read the flags on whatever row the session
-- belongs to. So a flag written onto a player's row is staff authority riding
-- a player's password, the player app's session and none of the staff
-- door's 2FA. Measured 2026-10-01: `POST /api/admin/users/:id/queue-manager`
-- with a PLAYER id answered 200, and that player's own session then read the
-- whole payment queue (`GET /api/admin/payment-queue`, 200).
--
-- Stated here rather than in each route because two routes wrote these flags
-- and neither asked, and the next one would not either. Clearing a flag is
-- always allowed — a revoke must never be refused. Dropped and re-added: its
-- definition names the flag set, which may grow.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_staff_flags_need_staff;
ALTER TABLE users ADD CONSTRAINT users_staff_flags_need_staff
  CHECK (account_type = 'STAFF' OR NOT (is_admin OR is_sub_admin OR is_queue_manager OR is_mediator));

-- The same rule from the other side: phantom access is a PLAYER's. Phantom
-- bets are placed from the player app, and the player's routes admit a
-- player's session only (`authenticatePlayer`), so a grant on a staff or
-- merchant row is authority nobody can use — and the grant route took any id.
-- A revoke (NONE) is always allowed. Dropped and re-added so a change to the
-- level list converges (§32 S31).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phantom_access_needs_player;
ALTER TABLE users ADD CONSTRAINT users_phantom_access_needs_player
  CHECK (account_type = 'PLAYER' OR phantom_access = 'NONE');

-- ── The bot's password reset ──────────────────────────────────────────────
-- A player who has forgotten their password opens a bot, shares their contact,
-- and — if that number matches an account — is sent a link that lets them SET a
-- new one. There is no email on this platform, so the number Telegram has
-- already verified is the only channel a reset can travel on.
--
-- ── What the link does NOT do ─────────────────────────────────────────────
-- It does not sign anybody in (owner, 2026-09-24). The whole point of deleting
-- `telegram_login_tokens` was that a fleet of hundreds of bot tokens must not
-- be able to mint a session; a reset that logged somebody in would put that
-- back under a different name. It grants the right to choose a password, and
-- then they log in like anybody else — and setting it REVOKES existing
-- sessions, because the reason somebody resets is often that a session is not
-- theirs.
--
-- Stored as a SHA-256 hash, like every other bearer credential here, so a
-- database dump yields nothing usable. Bound to the Telegram account that asked
-- for it, single-use (`consumed_at` set in the SAME atomic UPDATE that reads
-- it), and short-lived. Expiry is enforced by the READS — every query filters
-- on it — so a sweep that has not run cannot make a stale link usable.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash       TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL,
  consumed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);
CREATE INDEX IF NOT EXISTS password_resets_expiry_idx ON password_resets (expires_at);

-- ── Sessions issued before this instant are dead ────────────────────────────
-- The revocation list is keyed by the TOKEN, so it can retire a token somebody
-- hands it — a sign-out — and cannot answer "retire every session this account
-- has". Sessions are stateless PASETO; nothing anywhere holds a list of them.
--
-- A password reset that leaves the attacker's session alive is a reset in name
-- only, and the commonest reason somebody resets is that a session they did not
-- open is holding their account. So the account carries a CUTOFF, `authenticate`
-- refuses any token whose `iat` predates it, and a reset moves it to now.
--
-- One column, one comparison on a path that already reads the user row. The
-- alternative — recording every issued token — is a write per login and a table
-- that grows with traffic, to answer a question this answers exactly.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_from TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════
-- Three panels, three bots, three channels — 2026-09-24 (owner)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- "two separate bots which handles merchant and admin panel ... one bot with
-- its own channel for merchant and one bot with its own channel for admin thus
-- it will be complete separate from user panel whether its signup or login or
-- account recovery" (owner, 2026-09-24).
--
-- §33.5 already made a player, a merchant and a staff account three separate
-- ENTITIES on one mobile. This makes their Telegram halves three separate
-- entities too, on the SAME axis and with the SAME vocabulary: `audience` here
-- takes exactly the values `users.account_type` takes, so an account's type IS
-- its audience and there is no second place where "which bot serves this
-- person" gets decided (§2).
--
-- Every statement below is CONVERGENT, not merely idempotent (§32 S31): a
-- definition that can move is DROPPED and re-added rather than skipped when an
-- object of that name already exists. The `account_type` CHECK is what taught
-- us the difference — a guard that skipped it left every merchant signup
-- failing on a value the schema file plainly allowed, and because the apply
-- stops at the failure a column further down was never created at all.

-- ── telegram_configs: one active channel PER AUDIENCE ──────────────────────
ALTER TABLE telegram_configs ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'PLAYER';
ALTER TABLE telegram_configs DROP CONSTRAINT IF EXISTS telegram_configs_audience_check;
ALTER TABLE telegram_configs ADD CONSTRAINT telegram_configs_audience_check
  CHECK (audience IN ('PLAYER','STAFF','MERCHANT'));
-- The old index was UNIQUE on (active) WHERE active — "one active config on the
-- whole platform". Left standing, activating the merchant channel would have
-- deactivated the player channel and re-gated every player, which is the most
-- expensive thing this schema can do by accident.
DROP INDEX IF EXISTS one_active_telegram_config;
CREATE UNIQUE INDEX one_active_telegram_config
  ON telegram_configs (audience) WHERE active;

-- ── telegram_bots: a bot serves exactly one panel ──────────────────────────
ALTER TABLE telegram_bots ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'PLAYER';
ALTER TABLE telegram_bots DROP CONSTRAINT IF EXISTS telegram_bots_audience_check;
ALTER TABLE telegram_bots ADD CONSTRAINT telegram_bots_audience_check
  CHECK (audience IN ('PLAYER','STAFF','MERCHANT'));

-- The generated slot must compose the audience in, or the single partial unique
-- index refuses the SECOND panel's recovery bot — on the INSERT, with a
-- duplicate-key error naming an index whose name says nothing about audiences.
-- Guarded on the EXPRESSION rather than on the column's existence, because the
-- column exists in both the old shape and the new one and only the expression
-- tells them apart.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attrdef d
      JOIN pg_class c ON c.oid = d.adrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.adnum
     WHERE c.relname = 'telegram_bots'
       AND a.attname = 'live_slot'
       AND pg_get_expr(d.adbin, d.adrelid) NOT LIKE '%audience%'
  ) THEN
    DROP INDEX IF EXISTS one_live_bot_per_singular_role;
    ALTER TABLE telegram_bots DROP COLUMN live_slot;
    ALTER TABLE telegram_bots ADD COLUMN live_slot TEXT GENERATED ALWAYS AS (
      CASE WHEN status = 'ACTIVE' AND role = 'recovery'
           THEN audience || ':' || role END
    ) STORED;
    CREATE UNIQUE INDEX one_live_bot_per_singular_role
      ON telegram_bots (live_slot) WHERE live_slot IS NOT NULL;
    RAISE NOTICE 'telegram_bots.live_slot rebuilt: one live recovery bot PER AUDIENCE';
  END IF;
END $$;

DROP INDEX IF EXISTS telegram_bots_role_status_idx;
CREATE INDEX telegram_bots_role_status_idx ON telegram_bots (audience, role, status);

-- ── telegram_identities: one Telegram account, one link PER PANEL ──────────
ALTER TABLE telegram_identities ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'PLAYER';
ALTER TABLE telegram_identities DROP CONSTRAINT IF EXISTS telegram_identities_audience_check;
ALTER TABLE telegram_identities ADD CONSTRAINT telegram_identities_audience_check
  CHECK (audience IN ('PLAYER','STAFF','MERCHANT'));

-- An EXISTING row's audience is derivable — it is the account_type of the user
-- it points at — so nothing has to be guessed. Runs before the key changes, so
-- the rows are already in their right audiences when uniqueness is re-imposed.
UPDATE telegram_identities ti
   SET audience = u.account_type
  FROM users u
 WHERE u.user_id = ti.user_id
   AND ti.audience <> u.account_type;

-- The primary key, widened. Guarded on whether `audience` is already part of
-- it, which is the only thing that distinguishes the two shapes.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_attribute a
        ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
     WHERE con.conrelid = 'telegram_identities'::regclass
       AND con.contype = 'p'
       AND a.attname = 'audience'
  ) THEN
    ALTER TABLE telegram_identities DROP CONSTRAINT IF EXISTS telegram_identities_pkey;
    ALTER TABLE telegram_identities ADD PRIMARY KEY (telegram_user_id, audience);
    RAISE NOTICE 'telegram_identities primary key widened to (telegram_user_id, audience)';
  END IF;
END $$;

DROP INDEX IF EXISTS one_active_identity_per_phone;
CREATE UNIQUE INDEX one_active_identity_per_phone
  ON telegram_identities (phone, audience) WHERE contact_active;

-- ═══════════════════════════════════════════════════════════════════════════
-- KYC REMOVED (owner, 2026-10-02)
-- ═══════════════════════════════════════════════════════════════════════════
-- No Aadhaar number, hash or ciphertext is collected any more; the Telegram
-- contact share is the only identity check (PROJECT_STATUS §3.10). The CREATE
-- statements are gone from this file, and these DROPs make a database that
-- already had them CONVERGE on what the file says (§32 S31) — a table left
-- behind would hold every Aadhaar ever submitted, for nobody.
DROP TABLE IF EXISTS kyc_transitions;
DROP TABLE IF EXISTS user_kyc;
DROP TABLE IF EXISTS kyc_batches;
DROP TABLE IF EXISTS kyc_verifications;
DROP TABLE IF EXISTS telegram_recovery_sessions;
DROP INDEX IF EXISTS users_kyc_status_idx;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_kyc_status_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_kyc_submission_count_check;
ALTER TABLE users DROP COLUMN IF EXISTS kyc_status;
ALTER TABLE users DROP COLUMN IF EXISTS kyc_submission_count;
ALTER TABLE order_states DROP COLUMN IF EXISTS requires_video_kyc;
-- PENDING_KYC was an account status nothing wrote; dropped and re-added so the
-- narrower list converges on an existing database too.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('ACTIVE','BLOCKED','SUSPENDED','DELETED'));

-- ═══════════════════════════════════════════════════════════════════════════
-- SUPERVISORS AND TEAMS (owner, 2026-10-02 — PROJECT_STATUS §3.10, Step 2a)
-- ═══════════════════════════════════════════════════════════════════════════
-- A SUPERVISOR is a merchant login with a role and ONE rail, set by an admin.
-- It runs up to four TEAMS of exactly ten member merchants. A member is in one
-- team at most — `team_members.merchant_id` is the primary key, so a second
-- team is unrepresentable rather than merely refused.
--
-- The caps (4 teams, 10 members) are not CHECKs — a row cannot count its
-- siblings — so they are asked inside the statement that writes, under a lock
-- on the parent row (teams.js). A read in one statement acted on in another
-- is a snapshot (§32 S6).
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS is_supervisor BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS supervisor_rail TEXT;
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_supervisor_rail;
-- `IS NOT NULL` is load-bearing: `NULL IN (…)` is NULL, a CHECK passes
-- anything that is not FALSE, and the first draft therefore admitted a
-- supervisor with NO rail — measured by teamsPg before it shipped.
ALTER TABLE merchants ADD CONSTRAINT merchants_supervisor_rail CHECK (
  (NOT is_supervisor AND supervisor_rail IS NULL)
  OR (is_supervisor AND supervisor_rail IS NOT NULL
      AND supervisor_rail IN ('CASH', 'UPI_BANK', 'USDT')));

CREATE TABLE IF NOT EXISTS teams (
  team_id       TEXT PRIMARY KEY,
  supervisor_id TEXT NOT NULL REFERENCES merchants (merchant_id),
  name          TEXT NOT NULL,
  -- When the team dropped below ten APPROVED members, having been at ten. It
  -- keeps taking orders until the end of that day (IST) and then stops until
  -- it is back at ten (owner). NULL while full, and for a team that has never
  -- been full — which has never worked, so it has no grace day to use.
  short_since   TIMESTAMPTZ,
  -- Whether it has EVER been at ten. Distinguishes "dropped to nine today"
  -- from "never had ten", which the grace rule treats differently.
  was_full      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT teams_name_present CHECK (length(btrim(name)) BETWEEN 1 AND 60)
);
CREATE INDEX IF NOT EXISTS teams_supervisor_idx ON teams (supervisor_id);

CREATE TABLE IF NOT EXISTS team_members (
  merchant_id TEXT PRIMARY KEY REFERENCES merchants (merchant_id),
  team_id     TEXT NOT NULL REFERENCES teams (team_id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'PENDING',
  added_by    TEXT NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  CONSTRAINT team_members_status_known CHECK (status IN ('PENDING', 'APPROVED')),
  -- An approval names who made it and when; a PENDING row names neither.
  CONSTRAINT team_members_approval_recorded CHECK (
    (status = 'PENDING' AND approved_by IS NULL AND approved_at IS NULL)
    OR (status = 'APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS team_members_team_idx ON team_members (team_id, status);

-- A supervisor is never a member, and a member is never a supervisor. Both
-- directions, in the data: a supervisor serving orders in a team they also
-- supervise would be paid twice for one volume and judge their own red flags.
CREATE OR REPLACE FUNCTION bb_team_roles_disjoint() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'team_members' THEN
    IF EXISTS (SELECT 1 FROM merchants WHERE merchant_id = NEW.merchant_id AND is_supervisor) THEN
      RAISE EXCEPTION 'a supervisor cannot be a team member' USING ERRCODE = '23514',
        CONSTRAINT = 'team_roles_disjoint';
    END IF;
  ELSIF NEW.is_supervisor AND EXISTS (SELECT 1 FROM team_members WHERE merchant_id = NEW.merchant_id) THEN
    RAISE EXCEPTION 'a team member cannot be a supervisor' USING ERRCODE = '23514',
      CONSTRAINT = 'team_roles_disjoint';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS team_members_roles_disjoint ON team_members;
CREATE TRIGGER team_members_roles_disjoint BEFORE INSERT OR UPDATE ON team_members
  FOR EACH ROW EXECUTE FUNCTION bb_team_roles_disjoint();
DROP TRIGGER IF EXISTS merchants_roles_disjoint ON merchants;
CREATE TRIGGER merchants_roles_disjoint BEFORE INSERT OR UPDATE OF is_supervisor ON merchants
  FOR EACH ROW EXECUTE FUNCTION bb_team_roles_disjoint();

-- ═══════════════════════════════════════════════════════════════════════════
-- TEAM TOKEN POOLS (owner, 2026-10-02 — PROJECT_STATUS §3.10, Step 2b)
-- ═══════════════════════════════════════════════════════════════════════════
-- Each TEAM holds a pool of tokens; individual members hold none. A supervisor
-- buys tokens from the platform for a team (paid off-platform, recorded by the
-- admin) and can sell them back. `available` is what new orders may take;
-- `held` is what open buys have promised (Step 2c). Neither may go negative,
-- and the guard is the UPDATE's own WHERE, under the row lock (§32 S6).
--
-- TEAM_FLOAT in the treasury is the sum of every pool: `teamPools.js` writes
-- both in one transaction, so they cannot disagree.
--
-- MERCHANT_FLOAT is gone with the merchant wallets (Step 2c): a merchant holds
-- no tokens. An empty row for it is removed; the CHECK is NOT VALID so a
-- development database still carrying a non-zero one keeps applying the rest
-- of this file, while every new row is held to the list.
DELETE FROM treasury_accounts WHERE account = 'MERCHANT_FLOAT' AND balance_paise = 0;
ALTER TABLE treasury_accounts DROP CONSTRAINT IF EXISTS treasury_accounts_known;
ALTER TABLE treasury_accounts ADD CONSTRAINT treasury_accounts_known CHECK (account IN (
  'TOKEN_SUPPLY', 'USER_FLOAT', 'HOUSE_RESERVE', 'COMMISSION_POOL',
  'BONUS_POOL', 'REFERRAL_POOL', 'OPERATIONAL_FLOAT', 'TEAM_FLOAT')) NOT VALID;

CREATE TABLE IF NOT EXISTS team_pools (
  team_id         TEXT PRIMARY KEY REFERENCES teams (team_id),
  available_paise BIGINT NOT NULL DEFAULT 0,
  held_paise      BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_pools_available_nonneg CHECK (available_paise >= 0),
  CONSTRAINT team_pools_held_nonneg CHECK (held_paise >= 0)
);

-- Every change to a pool, append-only. `tx_id` is the idempotency key: a
-- redelivered sale or buyback collides here and moves nothing a second time.
CREATE TABLE IF NOT EXISTS team_pool_entries (
  id                    BIGSERIAL PRIMARY KEY,
  tx_id                 TEXT NOT NULL UNIQUE,
  team_id               TEXT NOT NULL REFERENCES teams (team_id),
  kind                  TEXT NOT NULL,
  available_delta_paise BIGINT NOT NULL,
  held_delta_paise      BIGINT NOT NULL DEFAULT 0,
  available_after_paise BIGINT NOT NULL,
  held_after_paise      BIGINT NOT NULL,
  actor                 TEXT,
  ref_id                TEXT,
  note                  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_pool_entries_kind_known CHECK (kind IN (
    'ADMIN_SALE', 'ADMIN_BUYBACK', 'BUY_HOLD', 'BUY_RELEASE', 'BUY_PAID', 'SELL_SETTLED', 'SELL_REVERSED')),
  CONSTRAINT team_pool_entries_moves CHECK (available_delta_paise <> 0 OR held_delta_paise <> 0)
);
CREATE INDEX IF NOT EXISTS team_pool_entries_team_idx ON team_pool_entries (team_id, created_at DESC, id DESC);
CREATE OR REPLACE TRIGGER team_pool_entries_append_only
  BEFORE UPDATE OR DELETE ON team_pool_entries FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- A supervisor asks the platform to sell tokens into a team's pool (BUY) or to
-- buy pool tokens back (SELL). An admin fulfils it, recording what was paid, or
-- rejects it. At most one PENDING request per team and direction.
CREATE TABLE IF NOT EXISTS team_pool_requests (
  request_id         TEXT PRIMARY KEY,
  team_id            TEXT NOT NULL REFERENCES teams (team_id),
  supervisor_id      TEXT NOT NULL REFERENCES merchants (merchant_id),
  direction          TEXT NOT NULL,
  token_amount_paise BIGINT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'PENDING',
  note               TEXT,
  decided_by         TEXT,
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_pool_requests_direction_known CHECK (direction IN ('BUY', 'SELL')),
  CONSTRAINT team_pool_requests_status_known CHECK (status IN ('PENDING', 'FULFILLED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT team_pool_requests_tokens_positive CHECK (token_amount_paise > 0),
  CONSTRAINT team_pool_requests_decision_recorded CHECK (
    (status = 'PENDING' AND decided_at IS NULL) OR (status <> 'PENDING' AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS team_pool_requests_one_pending
  ON team_pool_requests (team_id, direction) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS team_pool_requests_status_idx ON team_pool_requests (status, created_at);

-- What the platform got, or paid, for a pool trade lives in the same table as
-- a merchant's: `merchant_id` is the supervisor who traded, `team_id` the pool.
ALTER TABLE admin_token_considerations ADD COLUMN IF NOT EXISTS team_id TEXT;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEAM ROUTING (redesign Step 2c, PROJECT_STATUS §3.10)
--
-- An order is served by a MEMBER of a TEAM, and a buy's tokens are HELD in
-- the team's pool while it is open. The order row carries which team and how
-- much it holds: `pool_held_paise` is the guard every hold, release and spend
-- writes in its own WHERE, so a hold is taken once and ended once (S6).
-- ═══════════════════════════════════════════════════════════════════════════

-- The kind list grew (S31: a CHECK whose definition moves is dropped and re-added).
ALTER TABLE team_pool_entries DROP CONSTRAINT IF EXISTS team_pool_entries_kind_known;
ALTER TABLE team_pool_entries ADD CONSTRAINT team_pool_entries_kind_known CHECK (kind IN (
  'ADMIN_SALE', 'ADMIN_BUYBACK', 'BUY_HOLD', 'BUY_RELEASE', 'BUY_PAID', 'SELL_SETTLED', 'SELL_REVERSED',
  'COMMISSION'));
-- An order's pool movements name the order; an admin trade names its request.
CREATE INDEX IF NOT EXISTS team_pool_entries_ref_idx ON team_pool_entries (ref_id);

ALTER TABLE order_states ADD COLUMN IF NOT EXISTS team_id TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS pool_held_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE order_states DROP CONSTRAINT IF EXISTS order_states_pool_held_nonneg;
ALTER TABLE order_states ADD CONSTRAINT order_states_pool_held_nonneg CHECK (pool_held_paise >= 0);
-- A hold names the team it is held in.
ALTER TABLE order_states DROP CONSTRAINT IF EXISTS order_states_pool_hold_has_team;
ALTER TABLE order_states ADD CONSTRAINT order_states_pool_hold_has_team CHECK (pool_held_paise = 0 OR team_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS order_states_team_open_idx ON order_states (team_id)
  WHERE state IN ('ASSIGNED', 'PROCESSING', 'PAID', 'DISPUTED');

-- Ready: a CASH member at the machine. Cleared by the assignment it attracts.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS cash_ready BOOLEAN NOT NULL DEFAULT FALSE;
-- Ties in routing go to whoever was assigned least recently.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS last_assigned_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════
-- Step 2c (2026-10-02): orders route to TEAMS. Removed with what they served:
-- the per-merchant wallet and its entries, the deposit escrow (merchant
-- settlements), the pre-supplied cash-link queue (a QR scanned at the machine
-- replaces it in 2d), the platform-wide payment-mode switch (an order's rail is
-- derived from its size), the payment-gateway settings, merchants buying tokens
-- from the platform (a supervisor buys into the team pool instead), the
-- per-variety commission engine's policies (2e replaces it), and the
-- per-merchant cash denomination and concurrency columns (the rail and the
-- per-rail cap in SystemConfig.teamRouting replace them).
-- ═══════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS merchant_settlement_transitions;
DROP TABLE IF EXISTS merchant_settlements;
DROP TABLE IF EXISTS merchant_wallet_entries;
DROP TABLE IF EXISTS merchant_wallets;
DROP TABLE IF EXISTS cash_link_queue;
DROP TABLE IF EXISTS payment_mode_policies;
DROP TABLE IF EXISTS payment_gateway_configs;
DROP TABLE IF EXISTS merchant_admin_token_orders;
DROP TABLE IF EXISTS merchant_commission_rates;
DROP TABLE IF EXISTS merchant_commission_policies;
DROP TABLE IF EXISTS merchant_bonus_policies;
ALTER TABLE order_states DROP COLUMN IF EXISTS payment_mode_version;
ALTER TABLE order_states DROP COLUMN IF EXISTS cash_link_id;
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_concurrency_positive;
ALTER TABLE merchants DROP COLUMN IF EXISTS max_concurrent_orders;
ALTER TABLE merchants DROP COLUMN IF EXISTS max_concurrent_deposit_orders;
ALTER TABLE merchants DROP COLUMN IF EXISTS max_concurrent_withdrawal_orders;
ALTER TABLE merchants DROP COLUMN IF EXISTS cash_denomination_paise;

-- ═══════════════════════════════════════════════════════════════════════════
-- Step 2c+ (owner, 2026-10-02 21:13): escrow windows and dispute outcomes.
--
-- A buy the member REJECTS as unpaid waits in REJECTED, its team pool hold
-- intact, until `dispute_window_until` (SystemConfig.rejectedBuyDisputeMinutes,
-- written by the DATABASE clock in the transition that rejects it). A dispute
-- inside the window keeps the hold until the dispute manager decides; no
-- dispute, and the sweep cancels the order and the hold goes back to the pool.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS dispute_window_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS order_states_rejected_window_idx ON order_states (dispute_window_until)
  WHERE state = 'REJECTED';

-- When a buy's team tokens were PAID to the player (`teamPools.spendForBuy`,
-- under the order's row lock). From then on the order's only way forward is
-- COMPLETED: the transition writer refuses any other move in its UPDATE's
-- WHERE, so a reject, cancel or dispute that loses the race with a confirm
-- cannot leave a buy paid out and not completed (security review, 2026-10-03).
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS pool_paid_at TIMESTAMPTZ;

-- Whoever LOST a dispute: one row per decided dispute, keyed by the order, so
-- a decision replayed (two admins, a retried request) records it once. The
-- count and the suspension it causes are written in the same transaction.
CREATE TABLE IF NOT EXISTS dispute_faults (
  order_id     TEXT PRIMARY KEY,
  party        TEXT NOT NULL,
  user_id      TEXT,
  merchant_id  TEXT,
  decision     TEXT NOT NULL,
  decided_by   TEXT,
  lost_count   INTEGER NOT NULL,
  high_risk    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dispute_faults_party_known CHECK (party IN ('PLAYER', 'MERCHANT')),
  -- The party at fault is named: a player fault names the player, a member
  -- fault names the member.
  CONSTRAINT dispute_faults_party_named CHECK (
    (party = 'PLAYER' AND user_id IS NOT NULL) OR (party = 'MERCHANT' AND merchant_id IS NOT NULL)),
  CONSTRAINT dispute_faults_count_positive CHECK (lost_count >= 1)
);
CREATE INDEX IF NOT EXISTS dispute_faults_user_idx ON dispute_faults (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dispute_faults_merchant_idx ON dispute_faults (merchant_id) WHERE merchant_id IS NOT NULL;

-- Lost disputes, lifetime, and the HIGH-RISK review a third one opens. Only a
-- full admin lifts a suspension while `high_risk_at` is set; that lift clears it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS lost_disputes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS high_risk_at TIMESTAMPTZ;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS lost_disputes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS high_risk_at TIMESTAMPTZ;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_lost_disputes_nonneg;
ALTER TABLE users ADD CONSTRAINT users_lost_disputes_nonneg CHECK (lost_disputes >= 0);
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_lost_disputes_nonneg;
ALTER TABLE merchants ADD CONSTRAINT merchants_lost_disputes_nonneg CHECK (lost_disputes >= 0);

-- Step 2d (owner, 2026-10-02 / 2026-10-03): fixed order sizes, one withdrawal
-- per order, and every sell paid by bank transfer. Removed with what they
-- served: the split withdrawal's batch label, and the CDM slip a cash-machine
-- payout was evidenced by (a cash-team sell now carries the member's bank UTR
-- like any other). Dropped, not left in place (§0.0, §30).
DROP INDEX IF EXISTS order_states_withdrawal_batch_idx;
ALTER TABLE order_states DROP COLUMN IF EXISTS withdrawal_batch_ref;
DROP INDEX IF EXISTS order_states_cdm_receipt_missing_idx;
ALTER TABLE order_states DROP CONSTRAINT IF EXISTS order_states_cdm_receipt_complete;
ALTER TABLE order_states DROP CONSTRAINT IF EXISTS order_states_cdm_receipt_timed;
ALTER TABLE order_states DROP COLUMN IF EXISTS cdm_transaction_id;
ALTER TABLE order_states DROP COLUMN IF EXISTS cdm_receipt_url;
ALTER TABLE order_states DROP COLUMN IF EXISTS cdm_receipt_at;

-- Step 2d (owner, 2026-10-02): a CASH buy is paid through the ATM's own QR.
-- The member stands at a machine offering UPI cash withdrawal, picks the order
-- amount there and scans the QR it shows; the link it decodes is what the
-- player pays, and the machine hands the cash to the member. Written only by
-- `setCashLink` (orders.record.js), after `domains/payment/cashLink.js` has
-- checked it against the order amount. The CHECK holds the shape any writer
-- must keep: only a CASH buy carries one, it is a `upi://pay` intent, it is
-- bounded, and it says when it arrived.
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS cash_link TEXT;
ALTER TABLE order_states ADD COLUMN IF NOT EXISTS cash_link_at TIMESTAMPTZ;
ALTER TABLE order_states DROP CONSTRAINT IF EXISTS order_states_cash_link_shape;
ALTER TABLE order_states ADD CONSTRAINT order_states_cash_link_shape CHECK (
  cash_link IS NULL OR (
    order_type = 'DEPOSIT' AND payment_mode = 'CASH_ATM'
    AND cash_link LIKE 'upi://pay?%' AND length(cash_link) <= 1024
    AND cash_link_at IS NOT NULL
  )
);

-- The link is the machine the ASSIGNED member is standing at. When the order
-- changes hands (reassignment, requeue, an admin move) the next member is at a
-- different machine, so the old link is cleared in the same UPDATE, whichever
-- path made it. A player is never shown a QR for cash somebody else collects.
--
-- This is also why a player's "I've paid" on a cash buy names the member it
-- read (`markOrderPaid`, `expectMerchant`): the only way a link disappears is
-- the order changing hands, and that move is refused in the transition's WHERE.
CREATE OR REPLACE FUNCTION bb_cash_link_follows_member() RETURNS trigger AS $$
BEGIN
  IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id THEN
    NEW.cash_link := NULL;
    NEW.cash_link_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER order_states_cash_link_follows_member
  BEFORE UPDATE ON order_states FOR EACH ROW EXECUTE FUNCTION bb_cash_link_follows_member();

-- ── An account number that is somebody's mobile (Step 2d, owner 2026-10-03) ──
-- The member's bank account is shown to the player on a bank-transfer buy, and
-- the player's to the member on a sell. "Make sure nowhere you expose anyone's
-- mobile numbers": payments banks (Paytm, Airtel, Jio, Fino, NSDL, India Post)
-- issue the customer's MOBILE as the account number, so such an account would
-- show it to the other side. Refused on the row, for every writer:
--   • a mobile-shaped number (10 digits from 6, optionally 91 or 0 first) at a
--     payments bank's IFSC (its first four letters name the bank);
--   • the account holder's OWN registered mobile, at any bank.
-- A ten-digit number at a regular bank (Kotak's are ten digits) is allowed: it
-- is an account number, not a phone number. Every spelling is read the same
-- way: separators dropped, 91 / 091 / 0091 / 0 in front, an IFSC in any case
-- or with stray spaces.
CREATE OR REPLACE FUNCTION bb_account_number_is_a_mobile(account TEXT, ifsc TEXT, own_mobile TEXT)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  WITH n AS (
    SELECT regexp_replace(COALESCE(account, ''), '[^0-9]', '', 'g') AS digits,
           right(regexp_replace(COALESCE(own_mobile, ''), '[^0-9]', '', 'g'), 10) AS own,
           upper(left(regexp_replace(COALESCE(ifsc, ''), '[^A-Za-z0-9]', '', 'g'), 4)) AS bank
  ), b AS (
    SELECT CASE WHEN digits ~ '^(0{0,2}91|0)[6-9][0-9]{9}$' THEN right(digits, 10) ELSE digits END AS bare,
           own, bank
      FROM n
  )
  SELECT (bare ~ '^[6-9][0-9]{9}$'
          AND bank IN ('PYTM', 'AIRP', 'JIOP', 'FINO', 'NSPB', 'IPOS'))
      OR (length(own) = 10 AND bare = own)
    FROM b
$$;
-- The NAMES on an account travel with it (the holder's name, the bank's name),
-- so a mobile number typed into one reaches the other side the same way. Ten
-- digits from 6, standing alone, with 91 / +91 / 091 / 0091 / 0 or not; up to
-- two characters that are neither a digit nor a Latin letter between digits
-- ("98765  43210", "(987) 654-3210", a slash, a newline); digits in the Indian
-- scripts, Arabic-Indic and full-width read as digits. The same rule as
-- `textHasAMobile` (backend/domains/identity/mobileInText.js), held to the
-- same answers by mobileInTextPg. Shorter numbers are left alone.
CREATE OR REPLACE FUNCTION bb_text_has_a_mobile(t TEXT)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT translate(COALESCE(t, ''),
                   '０１２３４５６７８９٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹०१२३४५६७८९০১২৩৪৫৬৭৮৯੦੧੨੩੪੫੬੭੮੯૦૧૨૩૪૫૬૭૮૯୦୧୨୩୪୫୬୭୮୯௦௧௨௩௪௫௬௭௮௯౦౧౨౩౪౫౬౭౮౯೦೧೨೩೪೫೬೭೮೯൦൧൨൩൪൫൬൭൮൯',
                   '012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789')
         ~ '(^|[^0-9])((00|[+]|0)?91[^0-9A-Za-z]{0,2}|0)?[6-9]([^0-9A-Za-z]{0,2}[0-9]){9}([^0-9]|$)'
$$;
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_bank_account_not_a_mobile;
ALTER TABLE merchants ADD CONSTRAINT merchants_bank_account_not_a_mobile
  CHECK (NOT bb_account_number_is_a_mobile(bank_account_no, bank_ifsc, mobile)
     AND NOT bb_text_has_a_mobile(bank_account_holder_name)
     AND NOT bb_text_has_a_mobile(bank_name));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_bank_account_not_a_mobile;
ALTER TABLE users ADD CONSTRAINT users_bank_account_not_a_mobile
  CHECK (NOT bb_account_number_is_a_mobile(bank_details->>'accountNumber', bank_details->>'ifscCode', mobile)
     AND NOT bb_text_has_a_mobile(bank_details->>'accountHolderName')
     AND NOT bb_text_has_a_mobile(bank_details->>'bankName'));

-- A player's payout account is a BANK account: the four fields a transfer
-- needs, and no fifth. Every sell is a bank transfer to it, and no UPI handle
-- is ever a destination or shown (CLAUDE.md §2 "How each rail is paid", §24).
-- The Profile screen asked for a UPI ID and the sell copied
-- `bank_details.upiId` onto every order a member reads; an allowlist, so a
-- handle under any other name is refused the same way.
-- Converged first (§32 S31): a stray key is dropped from a row written before
-- the rule, and a JSON null becomes no value, or the constraint below would
-- stop the apply here.
UPDATE users SET bank_details = NULL
 WHERE bank_details IS NOT NULL AND jsonb_typeof(bank_details) <> 'object';
UPDATE users
   SET bank_details = bank_details - ARRAY(
         SELECT k FROM jsonb_object_keys(bank_details) AS k
          WHERE k <> ALL (ARRAY['accountHolderName', 'accountNumber', 'ifscCode', 'bankName']))
 WHERE jsonb_typeof(bank_details) = 'object'
   AND (bank_details - ARRAY['accountHolderName', 'accountNumber', 'ifscCode', 'bankName']) <> '{}'::jsonb;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_bank_details_bank_account_only;
ALTER TABLE users ADD CONSTRAINT users_bank_details_bank_account_only
  CHECK (bank_details IS NULL
      OR (jsonb_typeof(bank_details) = 'object'
          AND (bank_details - ARRAY['accountHolderName', 'accountNumber', 'ifscCode', 'bankName']) = '{}'::jsonb));

-- ═══════════════════════════════════════════════════════════════════════════
-- Step 2e (owner, 2026-10-02): the team commission, instant and per team.
--
-- A team's MATCHED volume is min(completed buys, completed sells), in tokens.
-- Every time it rises above the team's high-water mark, 10% of the rise is paid
-- as tokens into the team's pool, out of the platform's commission pool
-- (MERCHANT_BONUS_POOL in the accounting ledger, which an admin funds from
-- distributable revenue). The mark is the highest `to_high_paise` recorded for
-- the team: one row per rise, written by `teamCommission.js` alone, in the
-- transaction that credits the pool. Volume that falls (a completed sell
-- disputed and refunded) is never clawed back; it has to climb back past the
-- mark before anything is paid again.
--
-- `team_commissions_from_once` is the double-payment guard (§32 S6, S45): two
-- payments racing from the same mark cannot both land, whatever read them.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS team_commissions (
  commission_id    TEXT PRIMARY KEY,
  team_id          TEXT NOT NULL REFERENCES teams (team_id),
  supervisor_id    TEXT NOT NULL REFERENCES merchants (merchant_id),
  from_high_paise  BIGINT NOT NULL,
  to_high_paise    BIGINT NOT NULL,
  buys_paise       BIGINT NOT NULL,
  sells_paise      BIGINT NOT NULL,
  commission_paise BIGINT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_commissions_rises CHECK (from_high_paise >= 0 AND to_high_paise > from_high_paise),
  CONSTRAINT team_commissions_is_matched CHECK (to_high_paise = LEAST(buys_paise, sells_paise)),
  -- 10% of the rise, rounded down to the paisa; a rise worth nothing is not a row.
  CONSTRAINT team_commissions_tenth CHECK (
    commission_paise = (to_high_paise - from_high_paise) / 10 AND commission_paise > 0),
  CONSTRAINT team_commissions_from_once UNIQUE (team_id, from_high_paise),
  CONSTRAINT team_commissions_to_once UNIQUE (team_id, to_high_paise)
);
CREATE OR REPLACE TRIGGER team_commissions_append_only
  BEFORE UPDATE OR DELETE ON team_commissions FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- Who earned what of each payment: 16% to the supervisor, 84% equally to the
-- team's approved members at that moment. A RECORD, not money: the tokens sit
-- in the team's pool. The shares of one payment add up to it exactly.
CREATE TABLE IF NOT EXISTS team_commission_shares (
  commission_id TEXT NOT NULL REFERENCES team_commissions (commission_id),
  merchant_id   TEXT NOT NULL REFERENCES merchants (merchant_id),
  role          TEXT NOT NULL,
  share_paise   BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (commission_id, merchant_id),
  CONSTRAINT team_commission_shares_role_known CHECK (role IN ('SUPERVISOR', 'MEMBER')),
  CONSTRAINT team_commission_shares_nonneg CHECK (share_paise >= 0)
);
CREATE INDEX IF NOT EXISTS team_commission_shares_merchant_idx
  ON team_commission_shares (merchant_id, created_at DESC);
CREATE OR REPLACE TRIGGER team_commission_shares_append_only
  BEFORE UPDATE OR DELETE ON team_commission_shares FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- A team's completed volume, read on every completion: summed from this index alone.
CREATE INDEX IF NOT EXISTS order_states_team_completed_idx
  ON order_states (team_id, order_type) INCLUDE (token_amount_paise) WHERE state = 'COMPLETED';

-- ═══════════════════════════════════════════════════════════════════════════
-- Step 2f (owner, 2026-10-02 — PROJECT_STATUS §3.10): oversight.
--
-- A member's ONLINE TIME is the time their Online switch was on: the switch is
-- what routing asks (`merchants.is_online`), so it is the time they offered to
-- take orders. One row per stretch, opened and closed by the trigger below on
-- every change of `is_online` from any writer, so the log cannot disagree with
-- the switch it records (§32 S4/S5). Read by `teamOversight.js`.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS merchant_online_sessions (
  id          BIGSERIAL PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants (merchant_id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  CONSTRAINT merchant_online_sessions_order CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- One open stretch per merchant: a second "on" while on opens nothing.
CREATE UNIQUE INDEX IF NOT EXISTS merchant_online_sessions_open_once
  ON merchant_online_sessions (merchant_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS merchant_online_sessions_merchant_idx
  ON merchant_online_sessions (merchant_id, started_at);

-- A stretch is closed once and never edited: only `ended_at`, from NULL.
CREATE OR REPLACE FUNCTION bb_online_session_close_only() RETURNS trigger AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL OR NEW.merchant_id <> OLD.merchant_id OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'merchant_online_sessions: a stretch is closed once and never edited';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER merchant_online_sessions_close_only
  BEFORE UPDATE ON merchant_online_sessions FOR EACH ROW EXECUTE FUNCTION bb_online_session_close_only();

CREATE OR REPLACE FUNCTION bb_log_online_switch() RETURNS trigger AS $$
BEGIN
  IF NEW.is_online THEN
    INSERT INTO merchant_online_sessions (merchant_id) VALUES (NEW.merchant_id)
      ON CONFLICT (merchant_id) WHERE ended_at IS NULL DO NOTHING;
  ELSE
    -- Never before the stretch began: an "offline" statement whose
    -- transaction started before a concurrent "online" committed would
    -- otherwise write an end before the start, and the CHECK would fail the
    -- switch itself.
    UPDATE merchant_online_sessions SET ended_at = GREATEST(started_at, clock_timestamp())
     WHERE merchant_id = NEW.merchant_id AND ended_at IS NULL;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER merchants_log_online_switch
  AFTER UPDATE OF is_online ON merchants FOR EACH ROW
  WHEN (OLD.is_online IS DISTINCT FROM NEW.is_online) EXECUTE FUNCTION bb_log_online_switch();
CREATE OR REPLACE TRIGGER merchants_log_online_insert
  AFTER INSERT ON merchants FOR EACH ROW
  WHEN (NEW.is_online) EXECUTE FUNCTION bb_log_online_switch();
-- Convergent with the switch on a database that predates the log (§32 S31):
-- an online merchant has an open stretch, an offline one has none.
INSERT INTO merchant_online_sessions (merchant_id, started_at)
  SELECT m.merchant_id, COALESCE(m.last_online_toggle, now()) FROM merchants m
   WHERE m.is_online
ON CONFLICT (merchant_id) WHERE ended_at IS NULL DO NOTHING;
UPDATE merchant_online_sessions s SET ended_at = GREATEST(s.started_at, now())
  FROM merchants m
 WHERE m.merchant_id = s.merchant_id AND s.ended_at IS NULL AND NOT m.is_online;

-- What a team completed in a window, for the activity read and the flags.
CREATE INDEX IF NOT EXISTS order_states_team_completed_at_idx
  ON order_states (completed_at) WHERE team_id IS NOT NULL AND completed_at IS NOT NULL;

-- ── Red flags ────────────────────────────────────────────────────────────────
-- Computed once per IST day by `teamOversight.evaluateRedFlags`, the one writer.
-- A flag is a prompt for a person, never an action: nothing reads it to block,
-- pause or pay (owner: "flag only — the supervisor decides").
--   LOW_ACTIVITY  a member whose completed orders AND online time were both
--                 below the team's average by the admin's threshold
--                 (`SystemConfig.redFlags.lowActivityPercent`, 25).
-- No commission-farming flag (owner, 2026-10-04): the deposit/reserve split
-- and the winnings fee make farming cost more than it earns.
-- `team_red_flag_days` is the once-only guard: a day is evaluated in the
-- transaction that inserts its row, with the thresholds it used.
CREATE TABLE IF NOT EXISTS team_red_flag_days (
  flag_day     DATE PRIMARY KEY,
  settings     JSONB NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER team_red_flag_days_append_only
  BEFORE UPDATE OR DELETE ON team_red_flag_days FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- Every flag is about one member.
CREATE TABLE IF NOT EXISTS team_red_flags (
  flag_id     BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  flag_day    DATE NOT NULL REFERENCES team_red_flag_days (flag_day),
  team_id     TEXT NOT NULL REFERENCES teams (team_id),
  merchant_id TEXT NOT NULL REFERENCES merchants (merchant_id) ON DELETE CASCADE,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Dropped and re-added so a changed list converges (S31).
ALTER TABLE team_red_flags DROP CONSTRAINT IF EXISTS team_red_flags_kind_known;
ALTER TABLE team_red_flags ADD CONSTRAINT team_red_flags_kind_known CHECK (kind IN ('LOW_ACTIVITY'));
ALTER TABLE team_red_flags DROP CONSTRAINT IF EXISTS team_red_flags_subject;
ALTER TABLE team_red_flags ALTER COLUMN merchant_id SET NOT NULL;
DROP INDEX IF EXISTS team_red_flags_once;
CREATE UNIQUE INDEX IF NOT EXISTS team_red_flags_once_per_member
  ON team_red_flags (kind, flag_day, merchant_id);
CREATE INDEX IF NOT EXISTS team_red_flags_team_idx ON team_red_flags (team_id, flag_day DESC);

-- ── A supervisor speaks for their members in a dispute ──────────────────────
-- The order chat is what the dispute manager decides from; a supervisor posts
-- into it as SUPERVISOR. No message from one may carry a mobile number
-- (owner, 2026-10-03: nobody's mobile is exposed anywhere), the same test the
-- payout rows use.
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_sender_type_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_sender_type_check
  CHECK (sender_type IN ('USER', 'MERCHANT', 'ADMIN', 'SYSTEM', 'SUPERVISOR'));
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_supervisor_no_mobile;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_supervisor_no_mobile
  CHECK (sender_type <> 'SUPERVISOR' OR NOT bb_text_has_a_mobile(message));

-- A merchant's name and username are shown to other people (their
-- supervisor, their team, admins), and a team's name to its members; many
-- people would use their mobile as a username (owner, 2026-10-03: nobody's
-- mobile number is exposed anywhere). Refused by the row; the signup routes
-- and `teams.js` answer with a sentence first.
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_name_not_a_mobile;
ALTER TABLE merchants ADD CONSTRAINT merchants_name_not_a_mobile
  CHECK (NOT bb_text_has_a_mobile(name) AND NOT bb_text_has_a_mobile(username));
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_name_not_a_mobile;
ALTER TABLE teams ADD CONSTRAINT teams_name_not_a_mobile CHECK (NOT bb_text_has_a_mobile(name));
