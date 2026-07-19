// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/dualWrite.js — hybrid-DB dual-write layer (plan step 2). 2026-07-13.
 *
 * Every money-critical Mongo write is MIRRORED here into Postgres, hooked at
 * the models' own post-save points (one choke point per collection — e.g.
 * every wallet mutation already writes exactly one WalletLedger row, so its
 * hook covers every money mover without touching walletAuthority call sites).
 *
 * SEMANTICS AT THIS PHASE (plan step 2, pre-cutover):
 *  - Mongo remains the WRITE-FIRST store and the READ path — zero behavior
 *    change for the app. Mirrors are fire-and-forget: a Postgres failure can
 *    NEVER break a money path; it is logged, counted, and (throttled) paged.
 *  - Postgres rows are integer-paise from day one (pgClient.paise at the
 *    boundary) — the float-rupee round2() pattern ends at this wall.
 *  - Idempotent by key (tx_id / idempotency_key / mongo_id ON CONFLICT), so
 *    replays, retries, and the backfill can never double-write.
 *  - Drift between the stores is detected (and repaired Mongo→PG) by
 *    postgres/reconcile.js — run it on a schedule in staging (plan step 4).
 *  - CUTOVER (plan step 5 — flipping reads/authority to Postgres, then
 *    stopping Mongo writes per path) is a deliberate later phase gated on
 *    reconciliation passing repeatedly; procedure + fallback in
 *    DATA_ROLLBACK_PLAN.md. KYC cuts over LAST (step 7).
 */
import { pgConfigured, pgQuery, paise } from './pgClient.js';

let failStreak = 0;
async function mirror(name, fn) {
  if (!pgConfigured()) return;
  try {
    await fn();
    failStreak = 0;
  } catch (e) {
    failStreak++;
    console.error(`[dual-write] ${name} mirror failed:`, e.message);
    if (failStreak === 5) { // page once per streak, not per row
      try {
        const { sendAlert } = await import('../services/alerting.service.js');
        sendAlert('dualwrite-failure', 'Postgres dual-write failing repeatedly — stores are drifting (reconcile + investigate)', { lastError: e.message });
      } catch { /* alerting optional */ }
    }
  }
}

const FIELD_COLUMN = {
  depositBalance: 'deposit_paise', winningsBalance: 'winnings_paise',
  tokenBalance: 'token_paise', reserveBalance: 'reserve_paise', lockedBalance: 'locked_paise',
};

/** WalletLedger doc → wallet_ledger row + wallets snapshot upsert. */
export function mirrorWalletLedger(doc) {
  return mirror('wallet_ledger', async () => {
    await pgQuery(
      `INSERT INTO wallet_ledger (mongo_id, tx_id, user_id, field, amount_paise, balance_after_paise, tx_type, description, ref_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, now()))
       ON CONFLICT (mongo_id) DO NOTHING`,
      [String(doc._id), doc.txId || null, String(doc.userId), doc.field,
       paise(doc.amount), paise(doc.balanceAfter), doc.type || null,
       doc.reason || null, doc.refId ? String(doc.refId) : null, doc.createdAt || null],
    );
    const col = FIELD_COLUMN[doc.field];
    if (col) {
      await pgQuery(
        `INSERT INTO wallets (user_id, ${col}, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (user_id) DO UPDATE SET ${col} = $2, updated_at = now()`,
        [String(doc.userId), paise(doc.balanceAfter)],
      );
    }
  });
}

/** AccountingEvent doc → accounting_events row (append-only, balance-checked in PG). */
export function mirrorAccountingEvent(doc) {
  return mirror('accounting_events', () => pgQuery(
    `INSERT INTO accounting_events (mongo_id, idempotency_key, event_type, amount_paise, ref_model, ref_id, postings, description, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, now()))
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [String(doc._id), doc.idempotencyKey, doc.eventType, Number(doc.amountMinor) || 0,
     doc.refModel || null, doc.refId ? String(doc.refId) : null,
     JSON.stringify((doc.postings || []).map(p => ({ account: p.account, amountPaise: Number(p.amountMinor) || 0 }))),
     doc.description || null, doc.createdAt || doc.occurredAt || null],
  ));
}

/** Transaction doc → transactions row. */
export function mirrorTransaction(doc) {
  return mirror('transactions', () => pgQuery(
    `INSERT INTO transactions (mongo_id, user_id, tx_type, status, amount_paise, description, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (mongo_id) DO NOTHING`,
    [String(doc._id), doc.userId ? String(doc.userId) : null, doc.type || null,
     doc.status || null, paise(doc.amount), doc.description || null, doc.createdAt || null],
  ));
}

/** PaymentOrder doc → payment_orders upsert (status transitions overwrite). */
export function mirrorPaymentOrder(doc) {
  if (!doc) return;
  return mirror('payment_orders', () => pgQuery(
    `INSERT INTO payment_orders (mongo_id, order_id, user_id, merchant_id, order_type, status, fiat_amount_paise, token_amount_paise, utr, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
     ON CONFLICT (mongo_id) DO UPDATE SET
       status = EXCLUDED.status, merchant_id = EXCLUDED.merchant_id,
       utr = EXCLUDED.utr, updated_at = now()`,
    [String(doc._id), doc.orderId || null, String(doc.userId), doc.merchantId ? String(doc.merchantId) : null,
     doc.type || 'UNKNOWN', doc.status || 'UNKNOWN',
     paise(doc.fiatAmount), paise(doc.tokenAmount), doc.utrNumber || null, doc.createdAt || null],
  ));
}

/** UTRRegistry doc → utr_registry row (the uniqueness constraint, co-located). */
export function mirrorUtr(doc) {
  return mirror('utr_registry', () => pgQuery(
    `INSERT INTO utr_registry (utr, order_id, user_id, registered_at)
     VALUES ($1,$2,$3,COALESCE($4, now()))
     ON CONFLICT (utr) DO NOTHING`,
    [doc.utr, String(doc.orderId), doc.userId ? String(doc.userId) : null, doc.registeredAt || null],
  ));
}

/** MerchantWalletLedger doc → merchant_wallet_ledger row. */
export function mirrorMerchantWalletLedger(doc) {
  return mirror('merchant_wallet_ledger', () => pgQuery(
    `INSERT INTO merchant_wallet_ledger (mongo_id, tx_id, merchant_id, direction, amount_paise, balance_after_paise, reason, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, now()))
     ON CONFLICT (tx_id) DO NOTHING`,
    [String(doc._id), doc.txId, String(doc.merchantId), doc.type || doc.direction || null,
     paise(doc.amount), doc.balanceAfter != null ? paise(doc.balanceAfter) : null,
     doc.reason || doc.description || null, doc.createdAt || null],
  ));
}

/** User doc (KYC fields only — plan: split KYC out; cutover LAST). */
export function mirrorUserKyc(doc) {
  const k = doc.kycData || {};
  return mirror('user_kyc', () => pgQuery(
    `INSERT INTO user_kyc (user_id, kyc_status, name_on_pan, pan_number, id_proof_url, photo_url, submitted_at, rejection_reason, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (user_id) DO UPDATE SET
       kyc_status = EXCLUDED.kyc_status, name_on_pan = EXCLUDED.name_on_pan,
       pan_number = EXCLUDED.pan_number, id_proof_url = EXCLUDED.id_proof_url,
       photo_url = EXCLUDED.photo_url, submitted_at = EXCLUDED.submitted_at,
       rejection_reason = EXCLUDED.rejection_reason, updated_at = now()`,
    [String(doc._id), doc.kycStatus || null,
     k.nameOnPAN || k.nameOnAadhaar || null, k.panNumber || k.aadhaarNumber || null,
     k.idProofUrl || null, k.photoUrl || null, k.submittedAt || null, k.rejectionReason || null],
  ));
}
