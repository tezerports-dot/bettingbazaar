-- GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
-- Partition migration 001 — RANGE-by-month partitioning for the two unbounded
-- append-only money tables (capability #16). OPT-IN and NOT run at boot — apply
-- with `npm run pg:migrate:partition` only when data volume justifies it.
--
-- WHY THIS ISN'T AUTO-APPLIED: PostgreSQL requires a partitioned table's
-- UNIQUE / PRIMARY KEY to INCLUDE the partition key. wallet_ledger.tx_id and
-- accounting_events.idempotency_key are the double-spend / double-record gates,
-- so this migration preserves them with a SEPARATE unpartitioned unique index
-- table (`*_idem`) that keeps GLOBAL uniqueness while the fact tables partition.
-- Applying it is a data migration (copy → swap), hence explicit and operator-run.
--
-- Idempotent: every statement guards existence, so re-running is safe.

-- ── Global idempotency guards (unpartitioned — preserve the money invariants) ──
CREATE TABLE IF NOT EXISTS wallet_ledger_idem (
  tx_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS accounting_events_idem (
  idempotency_key TEXT PRIMARY KEY
);

-- ── Partitioned successor tables (created alongside; cutover is a separate,
--    operator-controlled step documented in the runbook — see deploy/README). ──
-- wallet_ledger_p: same columns as wallet_ledger, RANGE partitioned by created_at.
CREATE TABLE IF NOT EXISTS wallet_ledger_p (
  id                  BIGSERIAL,
  mongo_id            TEXT,
  tx_id               TEXT,
  user_id             TEXT NOT NULL,
  field               TEXT NOT NULL,
  amount_paise        BIGINT NOT NULL,
  balance_after_paise BIGINT NOT NULL,
  tx_type             TEXT,
  description         TEXT,
  ref_id              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX IF NOT EXISTS wallet_ledger_p_user_idx ON wallet_ledger_p (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS accounting_events_p (
  id              BIGSERIAL,
  mongo_id        TEXT,
  idempotency_key TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  amount_paise    BIGINT NOT NULL,
  ref_model       TEXT,
  ref_id          TEXT,
  postings        JSONB NOT NULL,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX IF NOT EXISTS accounting_events_p_ref_idx ON accounting_events_p (ref_model, ref_id);

-- A default partition catches any row whose month partition hasn't been created
-- yet, so writes never fail; the runner (create_monthly_partitions) pre-creates
-- the current + next month each run.
CREATE TABLE IF NOT EXISTS wallet_ledger_p_default    PARTITION OF wallet_ledger_p    DEFAULT;
CREATE TABLE IF NOT EXISTS accounting_events_p_default PARTITION OF accounting_events_p DEFAULT;

-- Helper: create a month partition for a given parent if absent. Called by the
-- runner for the current and next month so there is always a landing partition.
CREATE OR REPLACE FUNCTION bb_ensure_month_partition(parent TEXT, month_start DATE)
RETURNS void AS $$
DECLARE
  part_name TEXT := format('%s_%s', parent, to_char(month_start, 'YYYYMM'));
  next_start DATE := (month_start + INTERVAL '1 month')::date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      part_name, parent, month_start, next_start);
  END IF;
END $$ LANGUAGE plpgsql;
