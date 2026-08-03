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



-- ── STRICT NUMERIC WALLET LEDGER (authoritative financial block) ───────────
-- Wallets use fixed NUMERIC(20,8); ledger values remain unconstrained NUMERIC
-- so explicit constraints validate submitted precision before any typmod coercion.
CREATE TABLE IF NOT EXISTS user_wallets (
  user_id    VARCHAR(255) PRIMARY KEY,
  balance    NUMERIC(20, 8) NOT NULL DEFAULT 0.00000000,
  currency   VARCHAR(3) NOT NULL DEFAULT 'USD',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_wallets_balance_cannot_be_negative CHECK (balance >= 0.00000000),
  CONSTRAINT user_wallets_currency_iso3 CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE TABLE IF NOT EXISTS financial_ledger (
  id               BIGSERIAL PRIMARY KEY,
  user_id          VARCHAR(255) NOT NULL REFERENCES user_wallets(user_id),
  transaction_type VARCHAR(50) NOT NULL,
  amount           NUMERIC NOT NULL,
  running_balance  NUMERIC NOT NULL,
  currency         VARCHAR(3) NOT NULL,
  reference_id     VARCHAR(255) UNIQUE NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT financial_ledger_amount_non_zero CHECK (amount <> 0),
  CONSTRAINT financial_ledger_running_balance_non_negative CHECK (running_balance >= 0),
  CONSTRAINT financial_ledger_amount_scale CHECK (scale(amount) <= 8),
  CONSTRAINT financial_ledger_running_balance_scale CHECK (scale(running_balance) <= 8),
  CONSTRAINT financial_ledger_amount_precision CHECK (abs(amount) < 1000000000000),
  CONSTRAINT financial_ledger_running_balance_precision CHECK (abs(running_balance) < 1000000000000),
  CONSTRAINT financial_ledger_currency_iso3 CHECK (currency ~ '^[A-Z]{3}$')
);
-- Migrate pre-existing deployments from NUMERIC(20,8) and backfill the ledger currency.
ALTER TABLE financial_ledger ALTER COLUMN amount TYPE NUMERIC;
ALTER TABLE financial_ledger ALTER COLUMN running_balance TYPE NUMERIC;
ALTER TABLE financial_ledger ADD COLUMN IF NOT EXISTS currency VARCHAR(3);
UPDATE financial_ledger AS ledger
   SET currency = wallet.currency
  FROM user_wallets AS wallet
 WHERE ledger.user_id = wallet.user_id
   AND ledger.currency IS NULL;
ALTER TABLE financial_ledger ALTER COLUMN currency SET NOT NULL;
ALTER TABLE financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_amount_non_zero;
ALTER TABLE financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_running_balance_non_negative;
ALTER TABLE financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_amount_scale;
ALTER TABLE financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_running_balance_scale;
ALTER TABLE financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_amount_finite;
ALTER TABLE financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_running_balance_finite;
ALTER TABLE financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_amount_precision;
ALTER TABLE financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_running_balance_precision;
ALTER TABLE financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_currency_iso3;
ALTER TABLE financial_ledger ADD CONSTRAINT financial_ledger_amount_non_zero CHECK (amount <> 0);
ALTER TABLE financial_ledger ADD CONSTRAINT financial_ledger_running_balance_non_negative CHECK (running_balance >= 0);
ALTER TABLE financial_ledger ADD CONSTRAINT financial_ledger_amount_scale CHECK (scale(amount) <= 8);
ALTER TABLE financial_ledger ADD CONSTRAINT financial_ledger_running_balance_scale CHECK (scale(running_balance) <= 8);
ALTER TABLE financial_ledger ADD CONSTRAINT financial_ledger_amount_precision CHECK (abs(amount) < 1000000000000);
ALTER TABLE financial_ledger ADD CONSTRAINT financial_ledger_running_balance_precision CHECK (abs(running_balance) < 1000000000000);
ALTER TABLE financial_ledger ADD CONSTRAINT financial_ledger_currency_iso3 CHECK (currency ~ '^[A-Z]{3}$');

CREATE TABLE IF NOT EXISTS operational_bet_outbox (
  reference_id    VARCHAR(255) PRIMARY KEY REFERENCES financial_ledger(reference_id),
  user_id         VARCHAR(255) NOT NULL,
  amount          NUMERIC NOT NULL,
  running_balance NUMERIC NOT NULL,
  currency        VARCHAR(3) NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS operational_bet_outbox_pending_idx ON operational_bet_outbox (created_at) WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_ledger_user_idx ON financial_ledger (user_id, created_at DESC);
CREATE OR REPLACE TRIGGER financial_ledger_append_only
  BEFORE UPDATE OR DELETE ON financial_ledger FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();

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
CREATE OR REPLACE TRIGGER merchant_wallet_entries_append_only
  BEFORE UPDATE OR DELETE ON merchant_wallet_entries FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();
