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
      `INSERT INTO wallet_ledger (mongo_id, tx_id, user_id, field, amount_paise, balance_before_paise, balance_after_paise, tx_type, description, ref_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, now()))
       ON CONFLICT (mongo_id) DO NOTHING`,
      [String(doc._id), doc.txId || null, String(doc.userId), doc.field,
       paise(doc.amount), paise(doc.balanceBefore), paise(doc.balanceAfter), doc.type || null,
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

/**
 * Best-effort creation time for a mirrored doc.
 *
 * Every mirrored PG table declares `created_at TIMESTAMPTZ NOT NULL DEFAULT
 * now()`, and a column DEFAULT only fires when the column is OMITTED from the
 * INSERT — passing an explicit NULL defeats it and the row is rejected. The
 * SQL below therefore wraps the parameter in COALESCE(..., now()), and this
 * helper makes a NULL unlikely in the first place by falling back to the
 * ObjectId's embedded creation time, which every Mongo document has.
 */
function createdAt(doc, ...candidates) {
  for (const c of candidates) if (c) return c;
  return doc?._id?.getTimestamp?.() || null;
}

/**
 * Transaction doc → transactions row.
 *
 * NOTE the field name: transactionSchema calls its time column `timestamp`,
 * NOT `createdAt` (models/transaction.model.js), and the schema has no
 * `timestamps: true`. Reading doc.createdAt here yielded undefined → an
 * explicit NULL → "null value in column created_at violates not-null
 * constraint" on EVERY transaction, so the PG table stayed empty while
 * mirror() swallowed the error. Fixed 2026-07-29.
 */
export function mirrorTransaction(doc) {
  return mirror('transactions', () => pgQuery(
    `INSERT INTO transactions (mongo_id, user_id, tx_type, status, amount_paise, description, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()))
     ON CONFLICT (mongo_id) DO NOTHING`,
    [String(doc._id), doc.userId ? String(doc.userId) : null, doc.type || null,
     doc.status || null, paise(doc.amount), doc.description || null,
     createdAt(doc, doc.timestamp, doc.createdAt)],
  ));
}

/** PaymentOrder doc → payment_orders upsert (status transitions overwrite). */
export function mirrorPaymentOrder(doc) {
  if (!doc) return;
  return mirror('payment_orders', () => pgQuery(
    `INSERT INTO payment_orders (mongo_id, order_id, user_id, merchant_id, order_type, status, fiat_amount_paise, token_amount_paise, utr, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, now()),now())
     ON CONFLICT (mongo_id) DO UPDATE SET
       status = EXCLUDED.status, merchant_id = EXCLUDED.merchant_id,
       utr = EXCLUDED.utr, updated_at = now()`,
    [String(doc._id), doc.orderId || null, String(doc.userId), doc.merchantId ? String(doc.merchantId) : null,
     doc.type || 'UNKNOWN', doc.status || 'UNKNOWN',
     paise(doc.fiatAmount), paise(doc.tokenAmount), doc.utrNumber || null,
     createdAt(doc, doc.createdAt)],
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

/**
 * MerchantWalletLedger doc → merchant_wallet_ledger row.
 *
 * MIRRORS ONLY COMPLETED ROWS, and the timing is the whole point.
 *
 * The merchant service writes its ledger in two steps — reserve (balanceAfter
 * null) then complete — and only the first is a document save, so a post-save
 * hook alone mirrors the row while its balance is still unknown and every
 * mirrored row keeps balance_after_paise = NULL: the exact column a rollback
 * reads to restore Merchant.tokenBalance.
 *
 * The obvious repair, `ON CONFLICT (tx_id) DO UPDATE`, does not work and cannot
 * be made to: merchant_wallet_ledger carries an append-only trigger, an upsert's
 * DO UPDATE *is* an UPDATE, and the trigger raises. Because the mirror is
 * fire-and-forget the raise was swallowed, so the tests stayed green while the
 * column stayed NULL and Postgres logged an error per movement. Found by
 * reading the logs of a PASSING CI job.
 *
 * So the reservation is not mirrored at all — it is a transient artefact of
 * Mongo's two-step, and a row that may still be deleted is not a fact worth
 * copying. merchantWallet.service.completeLedger calls this once the balance is
 * known, and the INSERT lands cleanly with nothing to update.
 */
export function mirrorMerchantWalletLedger(doc) {
  // Reservations carry a null balanceAfter. Skipping them here means the model
  // hook and the completion path can both call this without the caller having
  // to know which stage it is at.
  if (doc?.balanceAfter == null) return;
  return mirror('merchant_wallet_ledger', () => pgQuery(
    `INSERT INTO merchant_wallet_ledger (mongo_id, tx_id, merchant_id, direction, amount_paise, balance_after_paise, reason, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, now()))
     ON CONFLICT (tx_id) DO NOTHING`,
    [String(doc._id), doc.txId, String(doc.merchantId), doc.type || doc.direction || null,
     paise(doc.amount), paise(doc.balanceAfter),
     doc.reason || doc.description || null, doc.createdAt || null],
  ));
}

/**
 * Merchant BALANCE → merchant_wallets.
 *
 * mirrorMerchantWalletLedger above mirrors the merchant's ledger ROWS. It does
 * not mirror the balance, so `merchant_wallets` stayed empty while
 * `merchant_wallet_ledger` filled up — meaning a cutover to Postgres authority
 * would have started reading balances of zero. The audit recorded this as the
 * merchant path's `dualWrite` capability being only half true.
 *
 * The Mongo side keeps a single `tokenBalance`; the Postgres side splits it
 * into available/reserved/settlement pockets. While Mongo is authoritative
 * there are no reservations in it to mirror, so the whole balance maps to
 * `available` and the other two stay at whatever Postgres already holds. The
 * mapping stops being a projection the moment Postgres takes over, which is
 * exactly why the flip is gated on reconciliation rather than on this write
 * succeeding.
 */
export function mirrorMerchantBalance(doc) {
  return mirror('merchant_wallets', () => pgQuery(
    `INSERT INTO merchant_wallets (merchant_id, available_paise, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (merchant_id) DO UPDATE
       SET available_paise = EXCLUDED.available_paise, updated_at = now()`,
    [String(doc._id ?? doc.merchantId), paise(doc.tokenBalance ?? 0)],
  ));
}

/**
 * PaymentOrder → merchant_settlements (domain 2's Mongo→Postgres leg).
 *
 * Mongo has no settlement table. It keeps the same lifecycle on the order —
 * `merchantCreditStatus` for withdrawals, `status` for deposits — so this
 * PROJECTS those onto the state machine Postgres owns. A cutover then finds the
 * in-flight settlements already there and the sweeper can advance them, instead
 * of losing every held withdrawal at the moment of the flip.
 *
 * It writes STATE ONLY. Pockets are not touched here: mirrorMerchantBalance
 * already projects the merchant's single Mongo number, and moving pockets from
 * two places would double-count. Deriving the pockets from the outstanding
 * settlements is a cutover step, not a mirror — same shape as the opening
 * balances (see merchantWalletPg.recordOpeningBalances).
 *
 * Only facts Mongo actually asserts are mirrored. A deposit that is merely
 * assigned has nothing reserved on the Mongo side, so it is not mirrored as
 * RESERVED — that would be inventing a claim the source store does not make.
 */
const SETTLEMENT_STATE_FROM_ORDER = {
  // Withdrawals carry the lifecycle explicitly.
  HELD:     'RESERVED',
  RELEASED: 'SETTLED',
  REVERSED: 'CANCELLED', // never owed after all — the tokens are taken back
};

function settlementStateFor(doc) {
  if (doc.type === 'WITHDRAWAL') return SETTLEMENT_STATE_FROM_ORDER[doc.merchantCreditStatus] ?? null;
  // A deposit has no reserve step in Mongo: the merchant is debited at confirm.
  if (doc.status === 'COMPLETED') return 'SETTLED';
  if (['CANCELLED', 'EXPIRED', 'FAILED'].includes(doc.status)) return 'CANCELLED';
  return null;
}

export function mirrorMerchantSettlement(doc) {
  if (!doc?.merchantId) return; // unassigned orders have no merchant side yet

  // SYNCHRONOUS at the boundary, with every fallible step inside mirror()'s
  // try/catch — the invariant every other mirror in this file holds, and one
  // this function originally broke. It is invoked unawaited from two Mongoose
  // post-save hooks, so an `async` version doing work BEFORE entering the
  // try/catch turns any throw there into an unhandled promise rejection on a
  // path that runs for every order save. `paise()` alone is enough to cause
  // one: rupeesToPaise THROWS on a non-finite amount, so a single order
  // without a tokenAmount would take the process down rather than skipping a
  // mirror. Fire-and-forget means the failure must stay inside the box.
  return mirror('merchant_settlements', async () => {
    // Once Postgres owns this path it also owns the state machine, and a
    // Mongo-derived overwrite could drag a settlement BACKWARDS through states
    // the transition guards exist to prevent. The forward mirror stops at the
    // flip; reverseMirror.js takes over in the other direction.
    const { isPostgresAuthoritative, MONEY_PATHS } = await import('./moneyAuthority.js');
    if (isPostgresAuthoritative(MONEY_PATHS.MERCHANT_SETTLEMENT)) return;

    const state = settlementStateFor(doc);
    if (!state) return;

    // A settlement of nothing is not a settlement. Guarding here keeps a
    // malformed order out of the table instead of relying on the CHECK
    // constraint to reject it once per save, forever.
    const amountPaise = Number.isFinite(Number(doc.tokenAmount)) ? paise(doc.tokenAmount) : 0;
    if (amountPaise <= 0) return;

    await pgQuery(
      `INSERT INTO merchant_settlements
         (settlement_id, merchant_id, order_id, direction, amount_paise, state, reason, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, now()),now())
       ON CONFLICT (settlement_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [`ms_${doc._id}`, String(doc.merchantId), String(doc._id),
       doc.type === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'DEPOSIT',
       amountPaise, state,
       doc.merchantCreditReversedReason || null, createdAt(doc, doc.createdAt)],
    );
  });
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

/**
 * An admin mint (or its rollback) → the treasury ledger. Domain 4's Mongo→PG leg.
 *
 * Mongo has no mint DOCUMENT to hang a post-save hook on — issuance is a single
 * counter on SystemConfig, so there is nothing per-mint for the other mirrors'
 * pattern to observe. This one is therefore called EXPLICITLY by
 * adminIssuanceAuthority after the Mongo counter has moved, which is also why it
 * takes an amount rather than a document.
 *
 * A negative `amountPaise` is a rollback, and it mirrors as a BURN rather than
 * as a negative mint. The distinction is the whole reason this domain is worth
 * moving: Mongo unwinds by decrementing the counter, which leaves no trace that
 * a mint ever happened, while the treasury keeps the mint AND its reversal.
 * Mirroring a rollback as "un-mint" would import the erasure into the store that
 * exists to prevent it.
 *
 * Idempotent on `movementId` (UNIQUE tx_id inside postMovement's transaction),
 * so a replayed mirror posts nothing.
 */
export function mirrorAdminSupply({
  movementId, amountPaise, merchantId = null, actor = null, reason = null,
  refModel = 'Merchant', refId = null, correlationId = null,
}) {
  return mirror('treasury_entries', async () => {
    const paiseValue = Number(amountPaise);
    if (!Number.isInteger(paiseValue) || paiseValue === 0) return;

    const { mintToMerchantFloat, burnFromMerchantFloat } = await import('./treasuryPg.js');
    const post = paiseValue > 0 ? mintToMerchantFloat : burnFromMerchantFloat;
    const result = await post(Math.abs(paiseValue), {
      movementId, actor, reason: reason || 'Mongo-authoritative admin issuance',
      refModel, refId: refId ?? merchantId, correlationId,
      // Mongo's own $expr guard already refused anything over the cap, so a
      // refusal here would mean the two caps disagree — which is a drift the
      // reconciler must surface, not something the mirror should silently
      // enforce a second time and then swallow.
      supplyCapPaise: Number.MAX_SAFE_INTEGER,
    });
    if (!result.ok) throw new Error(`treasury mirror refused the movement: ${result.reason}`);
  });
}
