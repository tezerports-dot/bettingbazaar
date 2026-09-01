-- GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
-- POSTGRES MONEY SCHEMA — hybrid architecture step 1 (plan items 6/10/11).
-- 2026-07-13. Requires PostgreSQL >= 14 (CREATE OR REPLACE TRIGGER).
--
-- PERMANENT SPLIT (per the locked plan): Postgres = source of truth for money
-- (wallets, transactions, ledger, payment orders, UTR, merchant wallet, KYC);
-- MongoDB keeps everything else forever. Every money column is BIGINT *paise*
-- (smallest unit) — this schema IS the fix for the round2() float-rupee
-- pattern: once Postgres is authoritative, integer paise is the only
-- representation money has at rest.
--
-- Applied idempotently by pgClient.applySchema() at boot when DATABASE_URL is
-- set (every statement is IF NOT EXISTS / OR REPLACE).
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
  mongo_id            TEXT UNIQUE,
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

-- WalletLedger.balanceBefore is `required` on the Mongo side, so a row that
-- travels back through the reverse mirror needs it. Nullable because rows
-- written before this column existed genuinely do not have one — readers
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
  mongo_id        TEXT UNIQUE,
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
-- rule ledgerReconcile.integration.test.js proves on the Mongo side.
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

-- ── TRANSACTIONS (mirrors transaction.model.js — the money-movement log) ─────
CREATE TABLE IF NOT EXISTS transactions (
  mongo_id     TEXT PRIMARY KEY,
  user_id      TEXT,
  tx_type      TEXT,
  status       TEXT,
  amount_paise BIGINT NOT NULL DEFAULT 0,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── PAYMENT ORDERS (mirrors PaymentOrder) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_orders (
  mongo_id           TEXT PRIMARY KEY,
  order_id           TEXT UNIQUE,
  user_id            TEXT NOT NULL,
  merchant_id        TEXT,
  order_type         TEXT NOT NULL,
  status             TEXT NOT NULL,
  fiat_amount_paise  BIGINT NOT NULL DEFAULT 0,
  token_amount_paise BIGINT NOT NULL DEFAULT 0,
  utr                TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

BEGIN;
ALTER TABLE transactions ALTER COLUMN created_at SET DEFAULT now();
UPDATE transactions SET created_at = now() WHERE created_at IS NULL;
ALTER TABLE transactions ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE payment_orders ALTER COLUMN created_at SET DEFAULT now();
UPDATE payment_orders SET created_at = now() WHERE created_at IS NULL;
ALTER TABLE payment_orders ALTER COLUMN created_at SET NOT NULL;
COMMIT;

CREATE INDEX IF NOT EXISTS transactions_user_cursor_idx       ON transactions (user_id, created_at DESC, mongo_id DESC);
CREATE INDEX IF NOT EXISTS payment_orders_user_cursor_idx     ON payment_orders (user_id, created_at DESC, mongo_id DESC);
CREATE INDEX IF NOT EXISTS payment_orders_status_cursor_idx   ON payment_orders (status, created_at DESC, mongo_id DESC);
CREATE INDEX IF NOT EXISTS payment_orders_merchant_cursor_idx ON payment_orders (merchant_id, status, created_at DESC, mongo_id DESC);

-- ── UTR REGISTRY — moves WITH payment_orders in the SAME database (plan:
-- splitting these two across databases would race two atomicity guarantees).
CREATE TABLE IF NOT EXISTS utr_registry (
  utr           TEXT PRIMARY KEY,            -- one UTR = one order, storage-enforced
  order_id      TEXT NOT NULL UNIQUE,
  user_id       TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── MERCHANT WALLET LEDGER (mirrors MerchantWalletLedger) ────────────────────
CREATE TABLE IF NOT EXISTS merchant_wallet_ledger (
  id                  BIGSERIAL PRIMARY KEY,
  mongo_id            TEXT UNIQUE,
  tx_id               TEXT NOT NULL UNIQUE,
  merchant_id         TEXT NOT NULL,
  direction           TEXT,
  amount_paise        BIGINT NOT NULL,
  balance_after_paise BIGINT,
  reason              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_wallet_ledger_idx ON merchant_wallet_ledger (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS merchant_wallet_ledger_cursor_idx ON merchant_wallet_ledger (merchant_id, created_at DESC, id DESC);
CREATE OR REPLACE TRIGGER merchant_wallet_ledger_append_only
  BEFORE UPDATE OR DELETE ON merchant_wallet_ledger FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- ── REMOVED 2026-08-11: the strict-NUMERIC wallet block ─────────────────────
-- `user_wallets`, `financial_ledger` and `operational_bet_outbox` were the
-- table set for postgres/secureBetPlacement.js — a reference implementation of
-- the serializable-with-outbox pattern on a string-decimal money model. That
-- module was imported by nothing and is deleted; these tables were created on
-- every boot for it and never held a balance the application read.
--
-- The authoritative money tables are `wallets` + `wallet_ledger`, BIGINT paise.
-- Do not resurrect these: two wallet table sets in one schema is how a cutover
-- silently switches to an empty set of balances. See docs/DEAD_CODE_AUDIT.md.
--
-- Existing databases keep the (empty) tables; `CREATE TABLE IF NOT EXISTS` only
-- stops making new ones. Dropping them is a manual, deliberate step.

-- ── USER KYC (split OUT of user.model.js per the plan — identity documents
-- need ACID + compliance guarantees; the rest of the user stays on Mongo).
-- NOTE: last in the CUTOVER order (plan step 7) — mirrored from day one, made
-- authoritative only after wallet/ledger/payment/UTR are proven in production.
CREATE TABLE IF NOT EXISTS user_kyc (
  user_id          TEXT PRIMARY KEY,
  kyc_status       TEXT,
  name_on_pan      TEXT,
  pan_number       TEXT,
  id_proof_url     TEXT,
  photo_url        TEXT,
  submitted_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- WHO decided, and WHEN. The Mongo route intended to record both — it assigns
-- to `user.kyc.reviewedBy` — but the User schema has no `kyc` subdocument, only
-- `kycData`, so the guarded block never executes and nothing is stored. A KYC
-- approval with no reviewer is not auditable, which is the one thing a KYC
-- decision has to be.
ALTER TABLE user_kyc ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE user_kyc ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
-- Where the documents actually live. `id_proof_url`/`photo_url` are CDN URLs,
-- which are a delivery detail and can change with the CDN; the object key is
-- the durable identity of the blob in object storage. Kept separately so a
-- bucket or CDN migration does not lose the reference to the file itself.
ALTER TABLE user_kyc ADD COLUMN IF NOT EXISTS id_proof_key TEXT;
ALTER TABLE user_kyc ADD COLUMN IF NOT EXISTS photo_key    TEXT;

-- Every KYC decision, append-only. The Mongo path has no history at all: the
-- status is a string on the User document, so "was this user ever rejected, and
-- why?" — the question every compliance review asks — cannot be answered from
-- it once a resubmission overwrites the field.
--
-- `tx_id` UNIQUE is the idempotency gate, same as order_transitions: a double
-- clicked approve collides inside the transaction and unwinds.
CREATE TABLE IF NOT EXISTS kyc_transitions (
  id          BIGSERIAL PRIMARY KEY,
  tx_id       TEXT NOT NULL UNIQUE,
  user_id     TEXT NOT NULL REFERENCES user_kyc (user_id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT kyc_transitions_moves CHECK (from_status IS NULL OR from_status <> to_status)
);
CREATE INDEX IF NOT EXISTS kyc_transitions_user_idx ON kyc_transitions (user_id, id);
CREATE OR REPLACE TRIGGER kyc_transitions_append_only
  BEFORE UPDATE OR DELETE ON kyc_transitions FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();


-- ── MERCHANT WALLET (Postgres authority, integer paise) ─────────────────────
-- The Postgres counterpart of domains/merchant/merchantWallet.service.js, which
-- is Mongo-only and is the sole writer of Merchant.tokenBalance. Until this
-- exists there is no meaningful "Postgres owns the money" claim, because every
-- user↔merchant settlement and admin↔merchant issuance lives on that path.
--
-- Pockets, per the financial domain graph:
--   available_paise   spendable now
--   reserved_paise    committed to an in-flight settlement, not yet applied
--   settlement_paise  owed out, awaiting payout
-- liability = reserved + settlement; a merchant's obligation at any instant.
--
-- Integer paise only. The float-rupee round2() pattern stops at this wall, the
-- same as wallets/wallet_ledger.
CREATE TABLE IF NOT EXISTS merchant_wallets (
  merchant_id      TEXT PRIMARY KEY,
  available_paise  BIGINT NOT NULL DEFAULT 0,
  reserved_paise   BIGINT NOT NULL DEFAULT 0,
  settlement_paise BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Reserved and settlement can never go negative: they are counters of
  -- outstanding obligations, and a negative obligation is not a state that
  -- exists. `available` is deliberately NOT constrained here — an authorised
  -- corrective adjustment may drive it below zero, and that decision belongs to
  -- the caller, recorded in the ledger, not to a constraint that would make the
  -- correction impossible to record.
  CONSTRAINT merchant_wallets_reserved_non_negative   CHECK (reserved_paise   >= 0),
  CONSTRAINT merchant_wallets_settlement_non_negative CHECK (settlement_paise >= 0)
);

-- Every movement of a merchant pocket, append-only.
-- `tx_id` UNIQUE is the durable idempotency gate — the same contract the user
-- wallet uses, so a replay collides inside the transaction rather than relying
-- on a pre-read that a concurrent caller can pass simultaneously.
CREATE TABLE IF NOT EXISTS merchant_wallet_entries (
  id                   BIGSERIAL PRIMARY KEY,
  tx_id                TEXT NOT NULL UNIQUE,
  -- The caller's LOGICAL key. A movement that touches several pockets writes
  -- one row per pocket, each with its own unique tx_id (`<key>:<pocket>`),
  -- but all of them share this. Without it, "did movement K already happen?"
  -- could only be asked with a prefix match — and a prefix is not an identity:
  -- `bet_1` matches `bet_10:available`. That exact bug was found and fixed in
  -- walletPg during this audit; this column is how the merchant side avoids
  -- reintroducing it.
  movement_id          TEXT,
  merchant_id          TEXT NOT NULL,
  pocket               TEXT NOT NULL,
  amount_paise         BIGINT NOT NULL,
  balance_before_paise BIGINT NOT NULL,
  balance_after_paise  BIGINT NOT NULL,
  entry_type           TEXT NOT NULL,
  operation            TEXT NOT NULL,
  actor                TEXT,
  reason               TEXT,
  ref_model            TEXT,
  ref_id               TEXT,
  correlation_id       TEXT,
  reverses_tx_id       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT merchant_wallet_entries_pocket_known
    CHECK (pocket IN ('available', 'reserved', 'settlement')),
  CONSTRAINT merchant_wallet_entries_type_known
    CHECK (entry_type IN ('CREDIT', 'DEBIT')),
  -- Amount is a positive magnitude; direction lives in entry_type. Storing a
  -- signed amount here would make every sum-based reconciliation disagree with
  -- the Mongo side, which stores positive amounts.
  CONSTRAINT merchant_wallet_entries_amount_positive CHECK (amount_paise > 0),
  -- The arithmetic must be internally consistent: a row that claims a before
  -- and after which its own amount cannot explain is corrupt on its face.
  CONSTRAINT merchant_wallet_entries_arithmetic CHECK (
    (entry_type = 'CREDIT' AND balance_after_paise = balance_before_paise + amount_paise) OR
    (entry_type = 'DEBIT'  AND balance_after_paise = balance_before_paise - amount_paise)
  )
);
CREATE INDEX IF NOT EXISTS merchant_wallet_entries_merchant_idx
  ON merchant_wallet_entries (merchant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS merchant_wallet_entries_ref_idx
  ON merchant_wallet_entries (ref_model, ref_id);
-- Existing deployments: the column is additive and nullable, so this is safe to
-- re-run and safe on a table that already has rows (they keep movement_id NULL,
-- which is correct — every one of them was a single-leg movement whose tx_id IS
-- its logical key). It MUST precede the index below: on a table that already
-- exists, CREATE TABLE IF NOT EXISTS is a no-op, so the column arrives here or
-- not at all and the index would fail with 42703.
ALTER TABLE merchant_wallet_entries ADD COLUMN IF NOT EXISTS movement_id TEXT;
CREATE INDEX IF NOT EXISTS merchant_wallet_entries_movement_idx
  ON merchant_wallet_entries (movement_id);
CREATE OR REPLACE TRIGGER merchant_wallet_entries_append_only
  BEFORE UPDATE OR DELETE ON merchant_wallet_entries FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

-- ─────────────────────────────────────────────────────────────────────────────
-- MERCHANT SETTLEMENT (domain 2)
--
-- The lifecycle of one user↔merchant settlement, as a state machine the
-- database enforces rather than the application remembers.
--
-- The Mongo original keeps this state on the PaymentOrder
-- (`merchantCreditStatus`) and moves the money in SEPARATE operations after the
-- transition commits. withdrawalHold.settleHold documents the consequence in
-- its own comment: if the player-side release throws, "the merchant is not
-- credited and the next sweep cannot retry (the order has left HELD)". The
-- order is stranded and needs a human.
--
-- Here the transition and the merchant-side movement are ONE transaction, so
-- that window does not exist: either the state advanced and the pockets moved,
-- or neither did and the retry finds the settlement exactly where it was.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merchant_settlements (
  settlement_id TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  -- DEPOSIT  merchant dispenses tokens to the user (inventory leaves)
  -- WITHDRAWAL  merchant receives tokens from the user (owed, then spendable)
  direction     TEXT NOT NULL,
  amount_paise  BIGINT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'RESERVED',
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT merchant_settlements_direction_known
    CHECK (direction IN ('DEPOSIT', 'WITHDRAWAL')),
  -- The complete set of states. A transition to anything else cannot be
  -- written, so an application bug becomes a constraint violation rather than a
  -- settlement sitting in a state nothing knows how to advance.
  CONSTRAINT merchant_settlements_state_known
    CHECK (state IN ('RESERVED', 'SETTLED', 'CANCELLED', 'REVERSED')),
  CONSTRAINT merchant_settlements_amount_positive CHECK (amount_paise > 0)
);
CREATE INDEX IF NOT EXISTS merchant_settlements_merchant_idx
  ON merchant_settlements (merchant_id, state);
CREATE INDEX IF NOT EXISTS merchant_settlements_order_idx
  ON merchant_settlements (order_id);

-- Every state change, append-only. The settlements table holds the CURRENT
-- state; this holds how it got there, and it is the only place a duplicate
-- transition can be detected durably — `tx_id` UNIQUE is the idempotency gate,
-- the same contract the wallets use, so a replay collides inside the
-- transaction rather than relying on a pre-read a concurrent caller can pass.
CREATE TABLE IF NOT EXISTS merchant_settlement_transitions (
  id            BIGSERIAL PRIMARY KEY,
  tx_id         TEXT NOT NULL UNIQUE,
  settlement_id TEXT NOT NULL REFERENCES merchant_settlements (settlement_id),
  from_state    TEXT,
  to_state      TEXT NOT NULL,
  actor         TEXT,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT merchant_settlement_transitions_to_state_known
    CHECK (to_state IN ('RESERVED', 'SETTLED', 'CANCELLED', 'REVERSED')),
  -- A transition must actually change something. A row claiming X → X is not a
  -- transition, it is a duplicate that escaped the idempotency gate.
  CONSTRAINT merchant_settlement_transitions_moves
    CHECK (from_state IS NULL OR from_state <> to_state)
);
CREATE INDEX IF NOT EXISTS merchant_settlement_transitions_settlement_idx
  ON merchant_settlement_transitions (settlement_id, id);
CREATE OR REPLACE TRIGGER merchant_settlement_transitions_append_only
  BEFORE UPDATE OR DELETE ON merchant_settlement_transitions
  FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

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
-- The Mongo original is a single counter — SystemConfig.adminTokenSupply.minted
-- with a 10B cap — incremented on mint and decremented by a blind, swallowed
-- $inc on rollback. That counter cannot say WHERE the tokens went, is not
-- idempotent (a retried rollback decrements twice), and permanently overstates
-- supply if the rollback's .catch(() => {}) ever fires.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS treasury_accounts (
  account       TEXT PRIMARY KEY,
  balance_paise BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT treasury_accounts_known CHECK (account IN (
    'TOKEN_SUPPLY',      -- contra: -(every token in existence)
    'MERCHANT_FLOAT',    -- tokens held by merchants
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
-- magnitude with the direction in entry_type because Mongo stores positive
-- amounts and the two had to agree. This table has no Mongo counterpart and is
-- double-entry, where the sign IS the meaning: the legs of one movement sum to
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
-- ORDERS (domain 5) — the workflow state machine, and the glue between domains
--
-- `payment_orders` above is a MIRROR: a projection of the Mongo document,
-- overwritten on every change, with no history and no guard on what may follow
-- what. It answers "where is this order now" and nothing else.
--
-- These two tables make the order's LIFECYCLE authoritative. Every transition
-- names the state it expects to find, so an out-of-order provider callback is
-- refused rather than obeyed, and every transition is recorded so the sequence
-- that produced the current state can be read back.
--
-- The FK from the transitions to the order is what stops a transition existing
-- for an order that does not — the mirror has no such constraint, because a
-- projection cannot have one.
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
  -- The same nine states the Mongo enum declares. Kept identical on purpose:
  -- during the migration both stores describe the same order, and a state one
  -- of them cannot represent would make the mirror lossy in one direction.
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
-- The Mongo original keeps a bet's status on the Bet document and moves the
-- stake separately (walletAuthority._mongoBetStake). Two defects follow from
-- that split and neither is ported here:
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
-- The Mongo document's _id. Derived from bet_id (see betPgAuthority.mongoIdFor)
-- rather than generated, because Mongo types _id as an ObjectId and cannot hold
-- the idempotency key itself — and a freshly generated one per attempt would
-- let a replay create a SECOND Mongo document behind the one Postgres bet,
-- which is the very duplication bet_id exists to prevent.
--
-- ALTER, not a column in the CREATE above, and it must stay BEFORE anything
-- that references it. `CREATE TABLE IF NOT EXISTS` is a NO-OP on a table that
-- already exists, so a column added to it never reaches a deployed database —
-- exactly how merchant_wallet_entries.movement_id went missing and took its
-- index down with a 42703.
ALTER TABLE bets ADD COLUMN IF NOT EXISTS mongo_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS bets_mongo_id_key ON bets (mongo_id);

-- The winnings platform fee retained from THIS bet's gross payout.
--
-- Not a display field. `Cycle.totalPlatformFees` is derived by summing
-- `Bet.platformFee` over the cycle's WON bets, so a store that owns the
-- settlement but not the fee cannot answer what it retained — and the Mongo
-- path writes the fee in the SAME statement as the status and the payout
-- (settlementService's stampOps). Splitting them across stores would put the
-- accounting number behind a second writer, so a crash between the two leaves a
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
-- The Mongo path settles a cycle by flipping `Cycle.isSettled` and then running
-- payouts, and it deliberately RE-ADMITS a PROCESSING cycle so a recovery task
-- can resume an interrupted run. Two passes over one cycle is therefore a
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
-- The defect this table exists to remove (docs/MONGO_MONEY_AUDIT, matrix):
-- a ROLLBACK or REFUND callback credits the player WITHOUT having to prove a
-- matching prior debit. A provider that is buggy, replayed, or hostile can
-- therefore mint real money by sending a rollback for a round that never had a
-- bet — and nothing in the current path can tell that from a legitimate one.
--
-- Every callback is a row keyed on the provider's own tx id, and a rollback
-- must name the round it reverses. The `debited_paise`/`refunded_paise`
-- running totals on the ROUND are what make "you cannot give back more than
-- was taken" checkable inside one transaction.
CREATE TABLE IF NOT EXISTS casino_rounds (
  id              BIGSERIAL PRIMARY KEY,
  round_id        TEXT NOT NULL UNIQUE,
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

CREATE TABLE IF NOT EXISTS casino_transactions (
  id            BIGSERIAL PRIMARY KEY,
  tx_id         TEXT NOT NULL UNIQUE,      -- the PROVIDER's id; the idempotency gate
  round_id      TEXT NOT NULL REFERENCES casino_rounds (round_id) ON DELETE RESTRICT,
  user_id       TEXT NOT NULL,
  tx_type       TEXT NOT NULL,
  amount_paise  BIGINT NOT NULL CHECK (amount_paise > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT casino_transactions_type_check
    CHECK (tx_type IN ('BET','WIN','ROLLBACK','REFUND'))
);
CREATE INDEX IF NOT EXISTS casino_transactions_round_idx ON casino_transactions (round_id, id);

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
--
-- The KYC decision fields are likewise not here: `user_kyc` owns them, with
-- `kyc_transitions` as its audit trail. `users.kyc_status` exists only as the
-- denormalised status the authorisation checks read on every request, and is
-- written by the same transaction that writes `user_kyc` — never independently.
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
  kyc_status         TEXT NOT NULL DEFAULT 'PENDING_SUBMISSION',
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
    CHECK (status IN ('ACTIVE','BLOCKED','SUSPENDED','PENDING_KYC','DELETED')),
  CONSTRAINT users_kyc_status_check
    CHECK (kyc_status IN ('PENDING_SUBMISSION','PENDING_APPROVAL','APPROVED','REJECTED')),
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

CREATE INDEX IF NOT EXISTS users_status_idx        ON users (status);
CREATE INDEX IF NOT EXISTS users_kyc_status_idx    ON users (kyc_status);
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
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one active generation, as the DATABASE's rule rather than something
-- every writer has to remember: activating a new one must deactivate the old
-- in the same transaction, or fail.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_telegram_config
  ON telegram_configs (active) WHERE active;

-- ── Telegram: the bot registry ───────────────────────────────────────────────
--
-- Exists so that replacing a suspended bot is one click on a row that already
-- exists, rather than creating, naming and verifying a bot during the outage
-- where nobody can sign up. STANDBY is the point of the table.
CREATE TABLE IF NOT EXISTS telegram_bots (
  bot_id          TEXT PRIMARY KEY,   -- Telegram's numeric id: the real identity
  label           TEXT NOT NULL,
  role            TEXT NOT NULL,
  username        TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  webhook_secret  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'STANDBY',

  -- GENERATED, not maintained by application code.
  --
  -- This column exists only to be indexed: it holds the role for a LIVE bot in
  -- a singular role and NULL otherwise, so the partial unique index below makes
  -- "at most one live sign-in bot" a rule the database enforces.
  --
  -- The document model derived it in a pre-validate hook, which meant a writer
  -- using an update operator instead of a document save bypassed the hook
  -- entirely and left the invariant unguarded — a live-bot promotion that set
  -- status without recomputing the slot would have been accepted. Generating it
  -- from the row removes the requirement to remember, and there is no writer
  -- that can get it wrong.
  live_slot       TEXT GENERATED ALWAYS AS (
                    CASE WHEN status = 'ACTIVE' AND role IN ('signin', 'recovery')
                         THEN role END
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
    CHECK (status IN ('ACTIVE','STANDBY','RETIRED'))
);
-- Partial rather than sparse: rows with no live_slot are not indexed at all, so
-- any number of standby, retired and outbound-only bots coexist.
CREATE UNIQUE INDEX IF NOT EXISTS one_live_bot_per_singular_role
  ON telegram_bots (live_slot) WHERE live_slot IS NOT NULL;
CREATE INDEX IF NOT EXISTS telegram_bots_role_status_idx ON telegram_bots (role, status);

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
  telegram_user_id  TEXT PRIMARY KEY,
  -- UNIQUE both ways: one Telegram account cannot hold two platform accounts,
  -- and one platform account cannot be driven by two Telegram accounts. That
  -- pair IS the no-duplicate-accounts rule, enforced by the database rather
  -- than by a check-then-insert that a concurrent signup fits between.
  user_id           TEXT NOT NULL UNIQUE REFERENCES users (user_id) ON DELETE CASCADE,
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

  CONSTRAINT telegram_identities_channel_status_check
    CHECK (channel_status IN ('member','administrator','creator','restricted','left','kicked','unknown'))
);
-- The phone is an identity anchor: two Telegram accounts sharing one number
-- must not become two platform accounts. Partial on contact_active so somebody
-- who genuinely moves their number to a new Telegram account (the recovery
-- path) is not blocked by their own retired row.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_identity_per_phone
  ON telegram_identities (phone) WHERE contact_active;
CREATE INDEX IF NOT EXISTS telegram_identities_channel_idx
  ON telegram_identities (channel_generation, channel_status);

-- ── Telegram: the half-finished conversation ─────────────────────────────────
--
-- Deliberately SEPARATE from telegram_identities: nothing here has proven
-- anything yet, and a half-finished signup must never be mistaken for an
-- account.
--
-- EXPIRY IS NOT A TTL INDEX. PostgreSQL has none, so `expires_at` is enforced
-- by the READS — every query filters on it — and the sweep below only reclaims
-- space. That ordering matters: a sweep that has not run yet must never make an
-- abandoned onboarding usable, and code that trusts the sweep to have run is
-- code that trusts a cron job with an Aadhaar hash.
CREATE TABLE IF NOT EXISTS telegram_pending_links (
  telegram_user_id  TEXT PRIMARY KEY,
  step              TEXT NOT NULL DEFAULT 'AWAITING_AADHAAR',
  aadhaar_hash      TEXT,
  aadhaar_encrypted TEXT,
  aadhaar_last4     TEXT NOT NULL DEFAULT '',
  phone             TEXT,
  telegram_username TEXT NOT NULL DEFAULT '',
  first_name        TEXT NOT NULL DEFAULT '',
  -- Attribution is recorded HERE, at first contact, because that is the only
  -- moment the deep-link payload exists. Carrying it forward to the created
  -- account is what makes a referral link work at all.
  referral_code     TEXT,
  generation        BIGINT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),

  CONSTRAINT telegram_pending_links_step_check
    CHECK (step IN ('AWAITING_AADHAAR','AWAITING_CONTACT','AWAITING_CHANNEL','COMPLETE'))
);
CREATE INDEX IF NOT EXISTS telegram_pending_links_expiry_idx ON telegram_pending_links (expires_at);

-- ── Telegram: the bridge from a chat to a browser session ────────────────────
--
-- A bearer credential for the seconds it lives, travelling through a chat the
-- player might forward. Deliberately hostile to reuse: single-use (consumed_at
-- is set in the SAME atomic UPDATE that reads it), short-lived, and bound to
-- the Telegram account it was issued to.
--
-- Stored as a SHA-256 hash, so a database dump yields nothing usable — the
-- plaintext exists only in the message Telegram delivered.
CREATE TABLE IF NOT EXISTS telegram_login_tokens (
  token_hash      TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  consumed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS telegram_login_tokens_user_idx ON telegram_login_tokens (user_id);
CREATE INDEX IF NOT EXISTS telegram_login_tokens_expiry_idx ON telegram_login_tokens (expires_at);

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

-- ── KYC verification ─────────────────────────────────────────────────────────
--
-- No identity DOCUMENTS are collected, stored or accepted anywhere: KYC is a
-- 12-digit number, held as an HMAC plus a ciphertext. See 04-GOVERNANCE.md §1.
CREATE TABLE IF NOT EXISTS kyc_verifications (
  user_id          TEXT PRIMARY KEY REFERENCES users (user_id) ON DELETE CASCADE,
  -- UNIQUE: the no-duplicate-accounts rule, enforced by the database. Two
  -- people cannot register the same Aadhaar, and it is a hash, so the index
  -- itself reveals nothing.
  aadhaar_hash     TEXT NOT NULL UNIQUE,
  -- Ciphertext. Read in exactly one place (the audited export), which is why
  -- the repository never selects it by default.
  aadhaar_encrypted TEXT NOT NULL,
  -- Shown to operators instead of the number: enough to match a query, useless
  -- to an attacker.
  aadhaar_last4    TEXT NOT NULL,
  phone            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',

  -- Which export a row went out in and which import decided it. Two rows
  -- sharing an export batch went to the verifier together, which is what makes
  -- a disputed result traceable to a specific file.
  export_batch_id  TEXT,
  exported_at      TIMESTAMPTZ,
  import_batch_id  TEXT,
  verified_at      TIMESTAMPTZ,
  -- Verbatim from the verifier on a NO, so support can tell a player why
  -- instead of guessing.
  failure_reason   TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT kyc_verifications_status_check
    CHECK (status IN ('PENDING_VERIFICATION','VERIFIED','FAILED'))
);
CREATE INDEX IF NOT EXISTS kyc_verifications_phone_idx ON kyc_verifications (phone);
-- The export query: everything still awaiting a verdict, oldest first.
CREATE INDEX IF NOT EXISTS kyc_verifications_pending_idx
  ON kyc_verifications (created_at) WHERE status = 'PENDING_VERIFICATION';
CREATE INDEX IF NOT EXISTS kyc_verifications_export_batch_idx ON kyc_verifications (export_batch_id);
CREATE INDEX IF NOT EXISTS kyc_verifications_import_batch_idx ON kyc_verifications (import_batch_id);

-- ── KYC batches: one export or one import, as an auditable record ────────────
-- An EXPORT is Aadhaar numbers LEAVING the platform. Recording who asked and
-- when is the difference between a controlled disclosure and a leak nobody can
-- reconstruct afterwards.
CREATE TABLE IF NOT EXISTS kyc_batches (
  batch_id       TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  row_count      INT NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  verified_count INT NOT NULL DEFAULT 0 CHECK (verified_count >= 0),
  failed_count   INT NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  skipped_count  INT NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  note           TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT kyc_batches_kind_check CHECK (kind IN ('EXPORT','IMPORT'))
);
CREATE INDEX IF NOT EXISTS kyc_batches_kind_idx ON kyc_batches (kind, created_at DESC);
