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

-- How many Aadhaar numbers this account has ever submitted.
--
-- ON `users`, NOT on `kyc_verifications`, and the placement is the whole point.
-- `releaseFailedSubmission` DELETES the verification row when a number comes
-- back rejected — that is what frees the unique hash so a mistyped digit does
-- not park a stranger's Aadhaar in the index forever. A counter living on that
-- row would be deleted with it and reset to zero, which defeats the cap
-- entirely: submit, fail, submit again, indefinitely.
--
-- The cap exists because "submit a number, be told whether it is already
-- registered" is an ENUMERATION ORACLE the moment it can be repeated freely.
-- Bounding it is what keeps this a correction path rather than a probe.
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_submission_count INT NOT NULL DEFAULT 0;
-- `ADD CONSTRAINT` has no IF NOT EXISTS, and this file is applied on EVERY
-- boot — so a bare ADD would fail the second start with "constraint already
-- exists". Swallowing just that error is the idempotent idiom.
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_kyc_submission_count_check
    CHECK (kyc_submission_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- THREE TABLES FOR CODE THAT WAS ALREADY DEAD
-- ═══════════════════════════════════════════════════════════════════════════
--
-- BlockedIP, ChatMessage and BalanceAdjustment were referenced through the
-- document store in five files and DEFINED NOWHERE. Every call raised
-- MissingSchemaError, and every call site swallowed it — so the IP block never
-- blocked, order chat never persisted, and the admin adjustment audit row was
-- never written. Nothing reported any of it.

-- ── The IP deny-list ─────────────────────────────────────────────────────────
--
-- A REAL SECURITY CONTROL THAT HAS NEVER FUNCTIONED. `ipBlocker` runs on every
-- request, asked for a model that does not exist, threw, and hit a catch that
-- fails open with no log. `blockIP` did nothing at all: an operator blocking an
-- abusive address got a success message and no effect.
CREATE TABLE IF NOT EXISTS blocked_ips (
  ip          TEXT PRIMARY KEY,
  reason      TEXT NOT NULL DEFAULT '',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  blocked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_by  TEXT,
  -- An unblock keeps the row, marked. "Was this address ever blocked, and why?"
  -- is what an appeal asks, and deleting the row destroys the answer.
  unblocked_at TIMESTAMPTZ,
  unblocked_by TEXT,
  -- Optional expiry for a temporary block. NULL means indefinite. Enforced by
  -- the READ, like every other expiry here — a sweep that is late must not let
  -- a live block lapse.
  expires_at  TIMESTAMPTZ,
  notes       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS blocked_ips_active_idx ON blocked_ips (ip) WHERE active;

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

  CONSTRAINT chat_messages_sender_type_check
    CHECK (sender_type IN ('USER','MERCHANT','ADMIN','SYSTEM')),
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
-- The token balance is NOT here. It lives in `merchant_wallets`, behind the row
-- lock its movements take — a second copy on this row would be a second writer
-- waiting to disagree with the first. That is the same rule the player wallet
-- follows and the reason `users` has no balance columns either.
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
  -- Hashed. Never selected by the general reader — see `getMerchantCredentials`.
  password_hash TEXT,

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
  bank_account_holder_name TEXT,
  bank_upi_id              TEXT,
  bank_name                TEXT,
  bank_account_no          TEXT,
  bank_ifsc                TEXT,
  -- TRC-20 (Tron), base58 and CASE-SENSITIVE. Uppercasing corrupts an address
  -- and USDT sent to a corrupted address is unrecoverable, so the format is
  -- checked by the row rather than trusted to the caller.
  usdt_wallet_address      TEXT,
  qr_code_url              TEXT,

  -- ── Limits and thresholds, in integer paise ───────────────────────────────
  -- The document store held these as rupee floats. Every one of them is
  -- compared against an order amount, and an order amount is paise.
  min_deposit_paise  BIGINT NOT NULL DEFAULT 50000,
  max_deposit_paise  BIGINT NOT NULL DEFAULT 5000000,
  min_withdraw_paise BIGINT NOT NULL DEFAULT 50000,
  max_withdraw_paise BIGINT NOT NULL DEFAULT 5000000,
  min_order_paise    BIGINT NOT NULL DEFAULT 50000,
  max_order_paise    BIGINT NOT NULL DEFAULT 5000000,

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
  max_concurrent_orders            INTEGER NOT NULL DEFAULT 3,
  -- NULL means "use the platform default from SystemConfig", which is a real
  -- state and not the same as 0.
  max_concurrent_deposit_orders    INTEGER,
  max_concurrent_withdrawal_orders INTEGER,
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
  -- 34 base58 characters beginning with T. Base58 excludes 0, O, I and l so
  -- visually similar characters cannot be confused.
  CONSTRAINT merchants_usdt_address_format CHECK (
    usdt_wallet_address IS NULL
    OR usdt_wallet_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  -- A suspended merchant without a reason is a suspension nobody can appeal.
  CONSTRAINT merchants_suspension_has_reason CHECK (
    status <> 'SUSPENDED' OR (suspension_reason IS NOT NULL AND suspension_reason <> '')),
  CONSTRAINT merchants_rating_range CHECK (rating >= 0 AND rating <= 5),
  CONSTRAINT merchants_success_rate_range CHECK (success_rate >= 0 AND success_rate <= 1),
  CONSTRAINT merchants_dispute_rate_range CHECK (dispute_rate >= 0 AND dispute_rate <= 1),
  CONSTRAINT merchants_limits_ordered CHECK (
    min_deposit_paise  <= max_deposit_paise
    AND min_withdraw_paise <= max_withdraw_paise
    AND min_order_paise    <= max_order_paise),
  CONSTRAINT merchants_limits_non_negative CHECK (
    min_deposit_paise >= 0 AND min_withdraw_paise >= 0 AND min_order_paise >= 0),
  CONSTRAINT merchants_concurrency_positive CHECK (
    max_concurrent_orders > 0
    AND (max_concurrent_deposit_orders    IS NULL OR max_concurrent_deposit_orders    BETWEEN 1 AND 10)
    AND (max_concurrent_withdrawal_orders IS NULL OR max_concurrent_withdrawal_orders BETWEEN 1 AND 10))
);

-- Payment credentials are an IDENTITY, not a preference: two merchants sharing
-- a UPI id or a bank account means money routed to one arrives at the other,
-- and there is no way afterwards to say which was intended. Partial indexes,
-- because most merchants have only the credentials for their own rail.
CREATE UNIQUE INDEX IF NOT EXISTS merchants_upi_unique
  ON merchants (bank_upi_id) WHERE bank_upi_id IS NOT NULL AND bank_upi_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS merchants_bank_account_unique
  ON merchants (bank_account_no, bank_ifsc)
  WHERE bank_account_no IS NOT NULL AND bank_account_no <> '';
CREATE UNIQUE INDEX IF NOT EXISTS merchants_usdt_unique
  ON merchants (usdt_wallet_address) WHERE usdt_wallet_address IS NOT NULL;
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
  CONSTRAINT cycles_status_known CHECK (status IN ('OPEN', 'CLOSED', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT cycles_side_known   CHECK (winner IS NULL OR winner IN ('DELHI', 'BOMBAY')),
  CONSTRAINT cycles_pending_side_known CHECK (pending_result IS NULL OR pending_result IN ('DELHI', 'BOMBAY')),
  CONSTRAINT cycles_window_ordered CHECK (end_time > start_time),
  -- Rules 2 and 3. A completed cycle HAS a winner; an unsettled one has not
  -- paid anything out.
  CONSTRAINT cycles_completed_has_winner CHECK (status <> 'COMPLETED' OR winner IS NOT NULL),
  CONSTRAINT cycles_settled_has_winner   CHECK (NOT is_settled OR winner IS NOT NULL),
  CONSTRAINT cycles_unsettled_paid_nothing CHECK (is_settled OR total_paid_out_paise = 0),
  CONSTRAINT cycles_phantom_non_negative CHECK (
    phantom_delhi_paise >= 0 AND phantom_bombay_paise >= 0)
);
-- One cycle per type per start instant. Two generators waking together must
-- produce one cycle, and the index is what decides rather than a pre-read.
CREATE UNIQUE INDEX IF NOT EXISTS cycles_type_start_unique ON cycles (cycle_type, start_time);
CREATE INDEX IF NOT EXISTS cycles_open_idx   ON cycles (cycle_type, status, end_time);
CREATE INDEX IF NOT EXISTS cycles_recent_idx ON cycles (cycle_type, start_time DESC);
-- The settlement sweep's query: declared, not yet settled.
CREATE INDEX IF NOT EXISTS cycles_settleable_idx ON cycles (end_time)
  WHERE winner IS NOT NULL AND NOT is_settled;

-- ═══════════════════════════════════════════════════════════════════════════
-- CASINO — third-party game providers
-- ═══════════════════════════════════════════════════════════════════════════
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
  status           TEXT NOT NULL DEFAULT 'DRAFT',
  featured         BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       TEXT,
  updated_by       TEXT,
  CONSTRAINT games_status_known   CHECK (status IN ('DRAFT', 'LIVE', 'DISABLED')),
  CONSTRAINT games_strategy_known CHECK (launch_strategy IN ('PROVIDER', 'URL', 'INTERNAL')),
  CONSTRAINT games_bet_range      CHECK (min_bet_paise > 0 AND min_bet_paise <= max_bet_paise),
  CONSTRAINT games_rtp_range      CHECK (rtp IS NULL OR (rtp >= 0 AND rtp <= 100)),
  -- A LIVE game nobody can launch is a tile that 404s.
  CONSTRAINT games_live_is_launchable CHECK (
    status <> 'LIVE'
    OR (launch_strategy = 'PROVIDER' AND provider_key IS NOT NULL AND external_game_id IS NOT NULL)
    OR (launch_strategy = 'URL' AND launch_url IS NOT NULL)
    OR launch_strategy = 'INTERNAL')
);
CREATE INDEX IF NOT EXISTS games_catalogue_idx ON games (category_slug, sort_order) WHERE status = 'LIVE';
CREATE INDEX IF NOT EXISTS games_featured_idx  ON games (sort_order) WHERE status = 'LIVE' AND featured;

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

CREATE TABLE IF NOT EXISTS gift_codes (
  code        TEXT PRIMARY KEY,
  amount_paise BIGINT NOT NULL,
  bonus_type  TEXT NOT NULL DEFAULT 'DEPOSIT',
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gift_codes_amount_positive CHECK (amount_paise > 0),
  -- The redemption cap is a property of the ROW. A check-then-increment in the
  -- application lets two concurrent redemptions both read the same used_count
  -- and both pass, which is how a single-use code pays out twice.
  CONSTRAINT gift_codes_within_cap CHECK (used_count >= 0 AND used_count <= max_uses),
  CONSTRAINT gift_codes_uses_positive CHECK (max_uses > 0)
);

CREATE TABLE IF NOT EXISTS gift_code_redemptions (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL REFERENCES gift_codes (code) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  amount_paise BIGINT NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One redemption per player per code, decided by the index rather than by a
  -- pre-read two concurrent requests can both pass.
  CONSTRAINT gift_code_redemptions_once UNIQUE (code, user_id)
);
CREATE INDEX IF NOT EXISTS gift_code_redemptions_user_idx ON gift_code_redemptions (user_id, redeemed_at DESC);

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
-- COMPLIANCE — the PAN registry
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One PAN, one account. The hash is the primary key, so the uniqueness is
-- STORAGE-ENFORCED: two accounts cannot claim one tax identity, and the index
-- decides rather than a pre-read two concurrent registrations both pass. The
-- number itself is never stored — only its hash and last four, which is what a
-- support agent needs to confirm an identity without holding the document.
CREATE TABLE IF NOT EXISTS pan_registry (
  pan_hash    TEXT PRIMARY KEY,
  pan_last4   TEXT NOT NULL,
  user_id     TEXT NOT NULL UNIQUE,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pan_registry_last4_shape CHECK (pan_last4 ~ '^[0-9A-Z]{4}$')
);

-- ═══════════════════════════════════════════════════════════════════════════
-- PAYMENTS — merchant token purchases from the platform
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS merchant_admin_token_orders (
  order_id      TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL,
  token_paise   BIGINT NOT NULL,
  usdt_rate     NUMERIC(18, 6),
  usdt_amount   NUMERIC(18, 6),
  usdt_tx_hash  TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at   TIMESTAMPTZ,
  reviewed_by   TEXT,
  review_note   TEXT,
  CONSTRAINT merchant_token_orders_status_known CHECK (
    status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT merchant_token_orders_amount_positive CHECK (token_paise > 0),
  -- A reviewed order records WHO and WHEN, or the decision has no owner.
  CONSTRAINT merchant_token_orders_reviewed_has_actor CHECK (
    status = 'PENDING' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CONSTRAINT merchant_token_orders_rejected_has_note CHECK (
    status <> 'REJECTED' OR review_note IS NOT NULL),
  -- A settled USDT purchase names the transaction that paid for it.
  CONSTRAINT merchant_token_orders_approved_has_hash CHECK (
    status <> 'APPROVED' OR usdt_amount IS NULL OR usdt_tx_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS merchant_token_orders_merchant_idx
  ON merchant_admin_token_orders (merchant_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS merchant_token_orders_queue_idx
  ON merchant_admin_token_orders (requested_at) WHERE status = 'PENDING';

-- The payment-gateway credentials. One row, key 'main'.
CREATE TABLE IF NOT EXISTS payment_gateway_configs (
  config_key       TEXT PRIMARY KEY,
  active_mode      TEXT NOT NULL DEFAULT 'P2P',
  p2p_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  gateway_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  gateway_provider TEXT,
  -- Encrypted at rest, and never selected by the general reader.
  gateway_api_key_encrypted        TEXT,
  gateway_api_secret_encrypted     TEXT,
  gateway_webhook_secret_encrypted TEXT,
  gateway_callback_url TEXT,
  gateway_merchant_id  TEXT,
  updated_by       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_gateway_mode_known CHECK (active_mode IN ('P2P', 'GATEWAY', 'BOTH')),
  -- Turning off both rails leaves no way for a player to fund an account, and
  -- an admin doing it by accident finds out from the support queue.
  CONSTRAINT payment_gateway_one_rail_live CHECK (p2p_enabled OR gateway_enabled),
  -- A live gateway that names no provider cannot be called.
  CONSTRAINT payment_gateway_enabled_has_provider CHECK (
    NOT gateway_enabled OR gateway_provider IS NOT NULL)
);

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
