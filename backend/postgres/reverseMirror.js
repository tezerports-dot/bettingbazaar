// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/reverseMirror.js — Postgres → MongoDB mirror (cutover Phase B).
 *
 * dualWrite.js mirrors Mongo → Postgres while Mongo is authoritative (Phase A).
 * DATA_ROLLBACK_PLAN.md Phase B requires that relationship to INVERT the moment
 * a path cuts over: "the dual-write inverts: PG-first, Mongo mirror". Without
 * that inversion the plan's central safety property does not hold —
 *
 *     "RPO for this rollback: zero — both stores hold every write because
 *      dual-write never stopped in either direction during the window."
 *
 * — because rows written while Postgres was authoritative would exist only in
 * Postgres, and falling back to Mongo would silently lose them. This module is
 * that missing direction.
 *
 * ── Semantics ───────────────────────────────────────────────────────────────
 *  - Runs ONLY for paths where Postgres is authoritative (moneyAuthority.js).
 *    On a Mongo-authoritative path the mirror would fight the real write.
 *  - Fire-and-forget, exactly like the forward mirror: a Mongo failure must
 *    never break a money path that has already committed in Postgres. Failures
 *    are logged, counted and (throttled) paged; the reverse reconcile in
 *    reconcile.js is the backstop that repairs whatever the mirror dropped.
 *  - Idempotent by the same keys the forward mirror uses (txId /
 *    idempotencyKey / _id), so replays and the reconcile backfill cannot
 *    double-write. Mongo's own unique indexes are the second line of defence.
 *  - Writes go through the Mongoose models directly rather than the wallet
 *    authority: this is a MIRROR of a decision already made and committed in
 *    Postgres, not a new money movement. Routing it through walletAuthority
 *    would re-run business rules and could reject or alter a settled fact.
 *
 * ── Units ───────────────────────────────────────────────────────────────────
 * Postgres stores integer paise; Mongo stores float rupees. Conversion happens
 * here, at the boundary, using the Integer Money Engine — the same wall the
 * forward mirror uses in the other direction.
 */
import mongoose from 'mongoose';
import { paiseToRupees } from '../shared/money.js';
import { pgQuery } from './pgClient.js';

let failStreak = 0;

async function mirrorBack(name, fn) {
  try {
    await fn();
    failStreak = 0;
  } catch (e) {
    failStreak++;
    console.error(`[reverse-mirror] ${name} → Mongo failed:`, e.message);
    if (failStreak === 5) { // page once per streak, not per row
      try {
        const { sendAlert } = await import('../services/alerting.service.js');
        sendAlert(
          'reverse-mirror-failure',
          'Postgres→Mongo reverse mirror failing repeatedly — Mongo is falling behind the source of truth, ' +
          'which breaks the zero-RPO rollback guarantee (run reconcile --repair-mongo and investigate)',
          { lastError: e.message },
        );
      } catch { /* alerting optional */ }
    }
  }
}

/**
 * paise → rupees for the Mongo document.
 *
 * `pg` returns BIGINT columns as STRINGS (it will not silently narrow a 64-bit
 * integer into a JS double), so every value arriving here is a string like
 * '5000' — not a number. paiseToRupees demands a safe integer Number and throws
 * on anything else, which is the behaviour we want: a paise value too large to
 * represent exactly should fail loudly at the boundary rather than round.
 */
export function rupeesFromPaise(paiseValue) {
  if (paiseValue === null || paiseValue === undefined) return undefined;
  return paiseToRupees(Number(paiseValue));
}
const rupees = rupeesFromPaise;

const FIELD_FROM_COLUMN = {
  deposit_paise: 'depositBalance', winnings_paise: 'winningsBalance',
  token_paise: 'tokenBalance', reserve_paise: 'reserveBalance', locked_paise: 'lockedBalance',
  locked_deposit_paise: 'lockedDepositAmount', locked_winnings_paise: 'lockedWinningsAmount',
};

/**
 * wallet_ledger row → WalletLedger doc + the User balance snapshot.
 *
 * Keyed on txId, which the ledger already guarantees unique — the same key the
 * forward mirror and the wallet authority's idempotency use.
 */
export function reverseMirrorWalletLedger(row) {
  return mirrorBack('wallet_ledger', async () => {
    const WalletLedger = mongoose.model('WalletLedger');
    const amount = rupees(row.amount_paise);
    const balanceAfter = rupees(row.balance_after_paise);
    const doc = {
      txId: row.tx_id,
      userId: row.user_id,
      field: row.field,
      amount,
      // balanceBefore is `required` on the Mongo schema. Rows written since
      // balance_before_paise was added carry it; older ones are derived — in
      // PAISE, so the derivation stays exact instead of reintroducing the float
      // error the integer representation exists to avoid.
      balanceBefore: rupees(
        row.balance_before_paise != null
          ? row.balance_before_paise
          : (row.tx_type === 'DEBIT'
              ? Number(row.balance_after_paise) + Number(row.amount_paise)
              : Number(row.balance_after_paise) - Number(row.amount_paise))
      ),
      balanceAfter,
      type: row.tx_type,
      reason: row.description || 'Postgres-authoritative movement',
      refId: row.ref_id,
      createdAt: row.created_at,
    };
    // upsert-on-txId: a replay of the same committed movement is a no-op.
    await WalletLedger.updateOne({ txId: row.tx_id }, { $setOnInsert: doc }, { upsert: true });

    // Keep the denormalised balances on User in step, so a fallback to Mongo
    // reads the same numbers Postgres last committed.
    //
    // The whole snapshot is copied, not just this row's field: one movement can
    // shift several pockets at once (a withdrawal lock moves winnings AND
    // locked under a single ledger row), and syncing only the row's own field
    // would leave the others silently stale — which is precisely the drift the
    // zero-RPO rollback guarantee cannot afford.
    const { rows: [wallet] } = await pgQuery(
      `SELECT ${Object.keys(FIELD_FROM_COLUMN).join(', ')} FROM wallets WHERE user_id = $1`,
      [row.user_id], 'reverse_wallet_snapshot',
    );
    if (wallet) {
      await mongoose.model('User').updateOne(
        { _id: row.user_id },
        { $set: Object.fromEntries(
          Object.entries(FIELD_FROM_COLUMN).map(([column, field]) => [field, rupees(wallet[column])]),
        ) },
      );
    }
  });
}

/** accounting_events row → AccountingEvent doc (append-only in both stores). */
export function reverseMirrorAccountingEvent(row) {
  return mirrorBack('accounting_events', async () => {
    const AccountingEvent = mongoose.model('AccountingEvent');
    const postings = (typeof row.postings === 'string' ? JSON.parse(row.postings) : row.postings) || [];
    await AccountingEvent.updateOne(
      { idempotencyKey: row.idempotency_key },
      {
        $setOnInsert: {
          idempotencyKey: row.idempotency_key,
          eventType: row.event_type,
          amountMinor: Number(row.amount_paise) || 0,
          refModel: row.ref_model,
          refId: row.ref_id,
          postings: postings.map((p) => ({ account: p.account, amountMinor: Number(p.amountPaise) || 0 })),
          description: row.description,
          createdAt: row.created_at,
        },
      },
      { upsert: true },
    );
  });
}

/** merchant_wallet_ledger row → MerchantWalletLedger doc (keyed on txId). */
/**
 * merchant_wallets → Merchant.tokenBalance. The rollback leg for the merchant
 * path: while Postgres is authoritative this keeps Mongo current, so reverting
 * the flip is lossless rather than a restore.
 *
 * Postgres splits the balance into pockets; Mongo has one number. The whole
 * position — available + reserved + settlement — maps back to `tokenBalance`,
 * because reverting means Mongo becomes authoritative again and it must not
 * silently forget tokens that were reserved or awaiting payout. Mapping only
 * `available` back would destroy exactly the money a merchant is owed.
 */
export function reverseMirrorMerchantBalance(row) {
  return mirrorBack('merchant_wallets', async () => {
    const total = Number(row.available_paise ?? 0)
      + Number(row.reserved_paise ?? 0)
      + Number(row.settlement_paise ?? 0);
    await mongoose.model('Merchant').updateOne(
      { _id: row.merchant_id },
      { $set: { tokenBalance: rupees(total) } },
    );
  });
}

/**
 * A committed merchant_wallet_entries movement → MerchantWalletLedger rows +
 * Merchant.tokenBalance. The live rollback leg for the merchant path, called by
 * merchantWalletPgAuthority after Postgres commits.
 *
 * Mirroring the BALANCE alone would not be enough. Mongo's idempotency gate for
 * this domain is `MerchantWalletLedger.findOne({ txId })` — so if the ledger
 * rows did not come back, a fallback to Mongo would no longer recognise the
 * movements Postgres made, and the first retry of any of them would apply a
 * second time. The ledger rows are the part that makes a fallback safe; the
 * balance is only the part that makes it correct.
 *
 * Both numbers use the merchant TOTAL (available + reserved + settlement).
 * Mongo has a single `tokenBalance` and cannot express pockets, and reverting
 * means Mongo becomes authoritative again — mapping only `available` back would
 * destroy exactly the tokens a merchant is owed.
 */
export function reverseMirrorMerchantMovement({ merchantId, entries = [], balances }) {
  return mirrorBack('merchant_wallet_entries', async () => {
    // A multi-leg movement is keyed `<txId>:<pocket>` in Postgres. Those rows
    // used to be refused here, because Mongo's gate looked up the bare txId and
    // could not see them — mirroring them would have left a double-apply
    // waiting on the other side of a fallback. Every row now carries
    // `movementId` (the caller's logical key) and the gate matches on either,
    // so they are safe to mirror and the settlement domain has a rollback path.
    //
    // The invariant that replaced the refusal: a row without a movementId is
    // one the gate can only find by its own txId, which for a multi-leg
    // movement is the wrong key.
    const unkeyed = entries.filter((e) => e.txId.includes(':') && !e.movementId);
    if (unkeyed.length) {
      throw new Error(
        `multi-leg merchant movement is missing movementId on `
        + `${unkeyed.map((e) => e.txId).join(', ')} — MerchantWalletLedger's idempotency `
        + `gate would not match these rows, so a fallback to Mongo could double-apply them.`,
      );
    }

    const total = Number(balances.available ?? 0)
      + Number(balances.reserved ?? 0)
      + Number(balances.settlement ?? 0);

    const MerchantWalletLedger = mongoose.model('MerchantWalletLedger');
    for (const e of entries) {
      await MerchantWalletLedger.updateOne(
        { txId: e.txId },
        {
          $setOnInsert: {
            txId: e.txId,
            movementId: e.movementId ?? e.txId,
            merchantId: String(merchantId),
            type: e.entryType,
            amount: rupees(Math.abs(e.amountPaise)),
            // The merchant's balance after, not the pocket's: Mongo's number is
            // the whole position, so its ledger must describe the same thing.
            balanceAfter: rupees(total),
            reason: e.reason || `${e.operation} (Postgres-authoritative movement)`,
            refModel: e.refModel || undefined,
            refId: e.refId ? String(e.refId) : undefined,
          },
        },
        { upsert: true },
      );
    }

    await mongoose.model('Merchant').updateOne(
      { _id: merchantId },
      { $set: { tokenBalance: rupees(total) } },
    );
  });
}

export function reverseMirrorMerchantWalletLedger(row) {
  return mirrorBack('merchant_wallet_ledger', async () => {
    await mongoose.model('MerchantWalletLedger').updateOne(
      { txId: row.tx_id },
      {
        $setOnInsert: {
          txId: row.tx_id,
          merchantId: row.merchant_id,
          type: row.direction,
          amount: rupees(row.amount_paise),
          balanceAfter: rupees(row.balance_after_paise),
          reason: row.reason,
          createdAt: row.created_at,
        },
      },
      { upsert: true },
    );
    if (row.balance_after_paise != null) {
      await mongoose.model('Merchant').updateOne(
        { _id: row.merchant_id },
        { $set: { tokenBalance: rupees(row.balance_after_paise) } },
      );
    }
  });
}

/**
 * merchant_settlements row → the PaymentOrder fields Mongo keeps the lifecycle
 * in. Domain 2's rollback leg.
 *
 * The inverse of dualWrite.mirrorMerchantSettlement, and it has to be, because
 * a fallback re-reads the lifecycle from the order: settleDueHolds sweeps on
 * `merchantCreditStatus: 'HELD'`, and settleHold/reverseHold use that same field
 * as their concurrency gate. A settlement Postgres advanced while it was
 * authoritative would, without this, still look HELD to Mongo — and the first
 * sweep after a fallback would settle it a second time.
 *
 * Written through updateOne rather than the state machine on purpose: this is a
 * MIRROR of a decision already committed in Postgres, not a new transition.
 * Routing it through the guards would re-run them against Mongo's stale state
 * and could refuse a settled fact.
 */
// Functions of the row, not constants, because SETTLED and CANCELLED carry a
// TIME as well as a status. The time is taken from the settlement's own
// `updated_at` — the moment Postgres decided — rather than from `new Date()` at
// mirror time, so a mirror that runs late (or a reconcile repair that runs days
// later) writes the same timestamp the first attempt would have, instead of
// back-dating the decision to whenever Mongo happened to catch up.
const ORDER_STATE_FROM_SETTLEMENT = {
  RESERVED:  () => ({ merchantCreditStatus: 'HELD' }),
  SETTLED:   (at) => ({ merchantCreditStatus: 'RELEASED', status: 'COMPLETED', escrowLocked: false, completedAt: at }),
  CANCELLED: (at) => ({ merchantCreditStatus: 'REVERSED', escrowLocked: false, merchantCreditReversedAt: at }),
  // A reversal after settlement is a correction an admin has to see; it does
  // not silently return the order to a pre-settlement status.
  REVERSED:  (at) => ({ merchantCreditStatus: 'REVERSED', status: 'DISPUTED', escrowLocked: false, merchantCreditReversedAt: at }),
};

export function reverseMirrorMerchantSettlement(row) {
  return mirrorBack('merchant_settlements', async () => {
    const build = ORDER_STATE_FROM_SETTLEMENT[row.state];
    if (!build) throw new Error(`unknown settlement state '${row.state}' — cannot mirror to the order`);
    const fields = build(row.updated_at ? new Date(row.updated_at) : new Date());
    // A DEPOSIT never used the merchantCredit* fields in Mongo (it has no
    // hold), so only the order status and its timestamps are meaningful for it.
    // Writing HELD onto a deposit would put it in the sweeper's query and
    // settle something twice.
    const patch = row.direction === 'DEPOSIT'
      ? Object.fromEntries(Object.entries(fields).filter(([k]) => !k.startsWith('merchantCredit')))
      : fields;
    if (!Object.keys(patch).length) return;

    await mongoose.model('PaymentOrder').updateOne(
      { _id: row.order_id }, { $set: { ...patch, updatedAt: new Date() } },
    );
  });
}

/**
 * The treasury's circulating supply → `SystemConfig.adminTokenSupply`.
 * Domain 4's rollback leg.
 *
 * Written as a SET, not an $inc, and that is the point. Mongo's counter is a
 * running total maintained by increments; the treasury's figure is DERIVED from
 * double-entry rows. Mirroring increments would make the follower accumulate its
 * own rounding and its own missed writes, so it would drift away from the number
 * it is supposed to be following. Copying the total means a mirror that ran late
 * or twice still lands on exactly the right number — which is what makes a
 * fallback to Mongo safe rather than approximately safe.
 *
 * `cap` is written too, because a fallback must not silently restore an older
 * ceiling than the one issuance was actually being checked against.
 */
export function reverseMirrorAdminSupply({ minted, cap }) {
  return mirrorBack('admin_token_supply', async () => {
    if (!Number.isFinite(minted)) throw new Error(`refusing to mirror a non-finite minted total: ${minted}`);
    await mongoose.model('SystemConfig').updateOne(
      { key: 'main' },
      {
        $set: {
          'adminTokenSupply.minted': minted,
          ...(Number.isFinite(cap) ? { 'adminTokenSupply.cap': cap } : {}),
        },
        $setOnInsert: { key: 'main' },
      },
      { upsert: true },
    );
  });
}

/**
 * A committed bet → the Mongo `Bet` document. Domain 5's rollback leg.
 *
 * Keyed on `_id`, which is the caller's bet id in both stores — the same value
 * `bets.bet_id` holds — so a replay is a no-op and a fallback to Mongo finds
 * every bet Postgres placed.
 *
 * `$setOnInsert` for the immutable facts and `$set` for the lifecycle: a bet's
 * amount, side and funding split never change, but its status does, and a
 * mirror that ran twice must not resurrect an older status over a newer one.
 * The status carried here is always the one the transaction just committed.
 */
export function reverseMirrorBet(doc) {
  return mirrorBack('bets', async () => {
    const { _id, status, settledAt, payout, ...immutable } = doc;
    await mongoose.model('Bet').updateOne(
      { _id },
      {
        $set: {
          status,
          ...(settledAt ? { settledAt } : {}),
          ...(payout !== undefined ? { payout } : {}),
        },
        $setOnInsert: immutable,
      },
      { upsert: true },
    );
  });
}

/** bets row (snake_case, paise) → the Mongo document, for the reconcile repair. */
export function reverseMirrorBetRow(row) {
  return reverseMirrorBet({
    _id: row.mongo_id || row.bet_id,
    userId: row.user_id,
    cycleId: row.cycle_id,
    side: row.side,
    amount: rupees(row.stake_paise),
    status: row.status,
    ...(row.settled_at ? { settledAt: row.settled_at } : {}),
    ...(Number(row.payout_paise) ? { payout: rupees(row.payout_paise) } : {}),
    timestamp: row.placed_at,
  });
}

/** payment_orders row → PaymentOrder doc. Status transitions overwrite. */
export function reverseMirrorPaymentOrder(row) {
  return mirrorBack('payment_orders', async () => {
    await mongoose.model('PaymentOrder').updateOne(
      { _id: row.mongo_id },
      {
        $set: {
          status: row.status,
          merchantId: row.merchant_id || null,
          utrNumber: row.utr || undefined,
          updatedAt: row.updated_at || new Date(),
        },
        $setOnInsert: {
          orderId: row.order_id,
          userId: row.user_id,
          type: row.order_type,
          fiatAmount: rupees(row.fiat_amount_paise),
          tokenAmount: rupees(row.token_amount_paise),
          createdAt: row.created_at,
        },
      },
      { upsert: true },
    );
  });
}

/** utr_registry row → UTRRegistry doc (the uniqueness gate, mirrored back). */
export function reverseMirrorUtr(row) {
  return mirrorBack('utr_registry', async () => {
    await mongoose.model('UTRRegistry').updateOne(
      { utr: row.utr },
      { $setOnInsert: { utr: row.utr, orderId: row.order_id, userId: row.user_id, registeredAt: row.registered_at } },
      { upsert: true },
    );
  });
}

/** user_kyc row → User KYC fields. Cuts over last (plan step 7). */
export function reverseMirrorUserKyc(row) {
  return mirrorBack('user_kyc', async () => {
    await mongoose.model('User').updateOne(
      { _id: row.user_id },
      {
        $set: {
          kycStatus: row.kyc_status,
          'kycData.nameOnPAN': row.name_on_pan,
          'kycData.panNumber': row.pan_number,
          'kycData.idProofUrl': row.id_proof_url,
          'kycData.photoUrl': row.photo_url,
          'kycData.submittedAt': row.submitted_at,
          'kycData.rejectionReason': row.rejection_reason,
        },
      },
    );
  });
}

/**
 * The reverse counterpart of reconcile.js's TABLES: how to find a Postgres row
 * in Mongo, and how to write it back if it is missing. Exported so the reverse
 * reconcile drives exactly the same mirrors rather than re-implementing them —
 * one write path per direction, which is what makes replay idempotent.
 */
// `since` column is per-table: utr_registry timestamps its rows as
// registered_at, everything else as created_at. Hardcoding created_at made the
// reverse reconcile throw 42703 on that one table (caught against a real
// Postgres, 2026-07-28) — so the column is part of the spec.
export const REVERSE_TABLES = Object.freeze([
  { table: 'wallet_ledger',          model: 'WalletLedger',         pgKey: 'tx_id',           mongoKey: 'txId',           since: 'created_at',    mirror: reverseMirrorWalletLedger },
  { table: 'accounting_events',      model: 'AccountingEvent',      pgKey: 'idempotency_key', mongoKey: 'idempotencyKey', since: 'created_at',    mirror: reverseMirrorAccountingEvent },
  { table: 'merchant_wallet_ledger', model: 'MerchantWalletLedger', pgKey: 'tx_id',           mongoKey: 'txId',           since: 'created_at',    mirror: reverseMirrorMerchantWalletLedger },
  { table: 'payment_orders',         model: 'PaymentOrder',         pgKey: 'mongo_id',        mongoKey: '_id',            since: 'created_at',    mirror: reverseMirrorPaymentOrder },
  { table: 'utr_registry',           model: 'UTRRegistry',          pgKey: 'utr',             mongoKey: 'utr',            since: 'registered_at', mirror: reverseMirrorUtr },
  // merchant_settlements keys on the ORDER, because that is where Mongo keeps
  // this lifecycle — there is no settlement document to be missing. So the
  // presence check here is near-vacuous (the order always exists); what makes
  // the entry worth having is `repair`, which drives the same reverse mirror the
  // live path uses and so re-applies a state Mongo fell behind on.
  { table: 'merchant_settlements',   model: 'PaymentOrder',         pgKey: 'order_id',        mongoKey: '_id',            since: 'updated_at',    mirror: reverseMirrorMerchantSettlement },
  { table: 'bets',                   model: 'Bet',                  pgKey: 'bet_id',          mongoKey: '_id',            since: 'updated_at',    mirror: reverseMirrorBetRow },
]);
