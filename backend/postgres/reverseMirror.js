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
    const { _id, status, settledAt, payout, platformFee, ...immutable } = doc;
    await mongoose.model('Bet').updateOne(
      { _id },
      {
        $set: {
          status,
          ...(settledAt ? { settledAt } : {}),
          ...(payout !== undefined ? { payout } : {}),
          // Written alongside the payout because the settlement decided both at
          // once. `Cycle.totalPlatformFees` sums this over the cycle's WON bets,
          // so a mirror that carried the payout and not the fee would leave the
          // accounting itemisation reading zero on every Postgres-settled cycle.
          ...(platformFee !== undefined ? { platformFee } : {}),
        },
        $setOnInsert: immutable,
      },
      { upsert: true },
    );
  });
}

/**
 * A bonus_grants row → the Mongo `BonusRecord` document. Domain 8's rollback leg.
 *
 * Keyed on the `bg_<mongoId>` grant id the forward mirror mints, so a grant
 * that originated in Mongo round-trips onto its own document rather than a
 * duplicate. A grant that originated in POSTGRES has no such id embedded, and
 * that case is what `upsert` is for: those are precisely the rows that would be
 * lost on a fallback, which is the whole reason this direction exists.
 *
 * ── A clawback becomes a second record, not an edit ─────────────────────────
 * Mongo's BonusRecord is append-only history with no status field, so there is
 * nowhere to write CLAWED_BACK. Rewriting the original row's amount to zero
 * would destroy the answer to "was this user ever given a signup bonus?" —
 * which is the question fraud review actually asks, and the reason bonusPg
 * keeps the clawed-back grant instead of deleting it.
 *
 * So a clawback mirrors as its own NEGATIVE record, keyed `<grantId>:clawback`.
 * The history then reads the way it happened: granted, then taken back.
 */
export function reverseMirrorBonusGrant(row) {
  if (!row?.grant_id || !row?.user_id) return;
  return mirrorBack('bonus_grants', async () => {
    const BonusRecord = mongoose.model('BonusRecord');
    const amount = rupees(row.amount_paise);
    if (amount === undefined) return;

    const type = row.kind === 'COMMISSION' ? 'REFERRAL_COMMISSION' : 'MANUAL';

    // The upsert FILTER has to be stable across replays, and the two grant-id
    // shapes need different ones.
    //
    // `bg_<mongoId>` came from Mongo, so its document already exists and is
    // found by `_id`. A grant born in Postgres has no Mongo id — and minting a
    // fresh ObjectId for the filter would be a duplicate-insert generator: the
    // filter would match nothing on EVERY pass, so each reconcile run would add
    // another copy of the same grant. Keying on the grant id itself is what
    // makes the second run a no-op.
    //
    // `mongoose.Types.ObjectId.isValid` guards the `_id` branch because `_id`
    // is a typed field: a malformed key would throw a CastError rather than
    // miss, which is M-8's failure mode.
    const embedded = String(row.grant_id).startsWith('bg_') ? String(row.grant_id).slice(3) : null;
    const fromMongo = Boolean(embedded) && mongoose.Types.ObjectId.isValid(embedded);
    const filter = fromMongo ? { _id: embedded } : { refId: `grant:${row.grant_id}` };
    const refId = fromMongo ? (row.ref_id ? String(row.ref_id) : null) : `grant:${row.grant_id}`;

    await BonusRecord.updateOne(
      filter,
      {
        $setOnInsert: {
          userId: row.user_id, type, amount,
          description: `${row.kind} grant from ${row.pool}`,
          ...(refId ? { refId } : {}),
          createdAt: row.granted_at || new Date(),
        },
      },
      { upsert: true },
    );

    if (row.status !== 'CLAWED_BACK') return;

    // The reversal, as its own row. `refId` carries the grant it undoes so the
    // pair can be matched without inferring it from amounts and timestamps.
    await BonusRecord.updateOne(
      { refId: `${row.grant_id}:clawback` },
      {
        $setOnInsert: {
          userId: row.user_id, type: 'MANUAL', amount: 0 - amount,
          description: `Clawback of ${row.kind} grant ${row.grant_id}`,
          refId: `${row.grant_id}:clawback`,
          createdAt: row.updated_at || new Date(),
        },
      },
      { upsert: true },
    );
  });
}

/**
 * A cycle_settlements row → the Mongo `Cycle` document. Domain 6's rollback leg.
 *
 * The inverse of dualWrite.mirrorCycleSettlement, and it carries the settlement
 * RUN only: which pass owns the cycle and whether it finished. The per-bet
 * outcomes travel on reverseMirrorBet and the money on
 * reverseMirrorWalletLedger — projecting them from here too would double-count
 * in the direction where double-counting is hardest to see.
 *
 * ── VOIDED is written into Mongo even though its enum has no such value ─────
 * Deliberate, and the alternatives are worse. Mongo's `isSettled` is
 * PENDING|PROCESSING|COMPLETED, so a run Postgres voided has nowhere honest to
 * land. Mapping it to COMPLETED would claim bets were paid that were refunded.
 * Leaving it at PROCESSING is the dangerous one: `payoutRecoveryTask` sweeps
 * every PROCESSING cycle and re-runs its payout, so a fallback to Mongo would
 * resurrect the payout of a cycle that was deliberately voided.
 *
 * `updateOne` does not run enum validators, so the true state is what gets
 * stored, and a cycle in that state matches none of the engine's queries —
 * which is exactly the behaviour wanted from a run that must not be resumed.
 * Same principle as reverseMirrorBet's VOID: the rollback record must not lie
 * about what the authoritative store decided.
 */
const CYCLE_SETTLED_FROM_STATUS = Object.freeze({
  RUNNING:   'PROCESSING',
  COMPLETED: 'COMPLETED',
  VOIDED:    'VOIDED',
});

export function reverseMirrorCycleSettlement(row) {
  if (!row?.cycle_id) return;
  return mirrorBack('cycle_settlements', async () => {
    const isSettled = CYCLE_SETTLED_FROM_STATUS[row.status];
    if (!isSettled) return;

    const payout = rupees(row.payout_paise);
    await mongoose.model('Cycle').updateOne(
      { cycleId: String(row.cycle_id) },
      {
        $set: {
          isSettled,
          ...(row.completed_at ? { settledAt: row.completed_at } : {}),
          ...(payout !== undefined ? { totalPaidOut: payout } : {}),
        },
      },
      // No upsert. A cycle exists because the engine created it; conjuring one
      // from a settlement row would produce a Cycle with no type, no start time
      // and no pools, which the engine would then try to run.
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
    // Guarded on the column being PRESENT rather than non-zero, unlike the
    // payout above: a settlement that legitimately retained nothing (0% fee)
    // must still be able to write 0 over a stale value, and a row selected
    // without the column must not write `undefined` over a real one.
    ...(row.platform_fee_paise !== undefined && row.platform_fee_paise !== null
      ? { platformFee: rupees(row.platform_fee_paise) }
      : {}),
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

/**
 * order_states row → PaymentOrder.status, plus the fields that belong WITH the
 * transition that produced it.
 *
 * ── Why this is not reverseMirrorPaymentOrder ───────────────────────────────
 * `payment_orders` is a MIRROR: the Mongo document projected forward on every
 * save, overwritten in place, with no history and no guard. `order_states` is
 * the authoritative lifecycle. When Postgres owns the ORDERS path the direction
 * inverts for the lifecycle only — the state is decided here and Mongo follows —
 * while `payment_orders` keeps being written the other way by dualWrite. Using
 * one function for both would send the projection back as though it were the
 * source of truth and reintroduce exactly the loop the two tables exist to
 * avoid. They are different tables on purpose.
 *
 * `set` carries the transition's own fields (completedAt, cancelReason, a UTR)
 * because a Mongo document found in the new state without the facts that
 * justify it is the window the seam's single-update rule exists to close — and
 * a reverse mirror that only wrote the status would reopen it here.
 */
export function reverseMirrorOrderState(row, set = {}) {
  return mirrorBack('order_states', async () => {
    await mongoose.model('PaymentOrder').updateOne(
      { _id: row.order_id },
      {
        $set: {
          status: row.state,
          ...(row.merchant_id === undefined ? {} : { merchantId: row.merchant_id || null }),
          ...set,
          updatedAt: row.updated_at || new Date(),
        },
      },
    );
  });
}

/**
 * user_kyc row → the User document's KYC decision fields. The rollback leg for
 * domain 11.
 *
 * Separate from reverseMirrorUserKyc, which pushes the whole record back
 * including the submitted documents. This one carries a DECISION — status,
 * reason, reviewer — and is called per transition while Postgres is
 * authoritative, so an approval is visible to every KYC gate in the app
 * immediately rather than at the next sweep.
 *
 * The reason lands in `kycData.rejectionReason`, which is the field
 * domains/user/kycPublicData.js actually reads. The Mongo route intended to
 * write `user.kyc.rejectionReason` — a path the schema does not have — so
 * mirroring to the same wrong place would faithfully reproduce the bug.
 */
export function reverseMirrorUserKycStatus(row) {
  return mirrorBack('user_kyc', async () => {
    const set = { kycStatus: row.kyc_status };
    if (row.reviewed_by) set['kycData.reviewedBy'] = row.reviewed_by;
    if (row.reviewed_at) set['kycData.reviewedAt'] = row.reviewed_at;
    const update = { $set: set };
    // An approved user must not keep the reason they were once refused — the
    // projection shows it whenever the status is REJECTED, and a stale value
    // would reappear the next time they were rejected for something else.
    if (row.rejection_reason) set['kycData.rejectionReason'] = row.rejection_reason;
    else update.$unset = { 'kycData.rejectionReason': '' };

    await mongoose.model('User').updateOne({ _id: row.user_id }, update);
  });
}

/**
 * A casino round + its callback → the GameTransaction document. Domain 9's
 * rollback leg.
 *
 * Keyed on the PROVIDER's tx id, which is the same idempotency gate the forward
 * mirror and `casinoPg.recordCallback` use — so a redelivered webhook produces
 * one document however many times it arrives and whichever direction is live.
 *
 * `balanceBefore`/`balanceAfter` are deliberately NOT reconstructed. They are a
 * snapshot of the wallet at the instant the callback ran, and the wallet is a
 * different path with its own authority flag; inventing them here from a later
 * read would write a number that was never true. The player's balance comes
 * from the wallet's own mirror.
 */
export function reverseMirrorCasinoRound({ round, transaction }) {
  return mirrorBack('casino_rounds', async () => {
    if (!transaction?.tx_id) return;
    await mongoose.model('GameTransaction').updateOne(
      { txId: String(transaction.tx_id) },
      {
        $setOnInsert: {
          txId:        String(transaction.tx_id),
          roundId:     String(transaction.round_id),
          userId:      transaction.user_id,
          type:        transaction.tx_type,
          amount:      rupees(transaction.amount_paise),
          providerKey: transaction.provider_key ?? round?.providerKey ?? 'unknown',
          gameId:      transaction.game_id ?? round?.gameId ?? '',
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
  // cycle_settlements keys on the CYCLE for the same reason merchant_settlements
  // keys on the order: Mongo has no settlement document, it has a Cycle with an
  // `isSettled` field. The presence check is therefore near-vacuous and the
  // value is in `repair`, which pushes a run's state and payout back onto the
  // cycle Mongo would fall back to.
  { table: 'cycle_settlements',      model: 'Cycle',                pgKey: 'cycle_id',        mongoKey: 'cycleId',        since: 'updated_at',    mirror: reverseMirrorCycleSettlement },
  // bonus_grants is DELIBERATELY ABSENT from this list, and the reason is worth
  // writing down. A grant id has two shapes: `bg_<mongoId>` for one mirrored
  // out of Mongo, and a caller's own deterministic key for one born in
  // Postgres. The generic check above compares ONE Postgres column against ONE
  // Mongo field, so whichever shape it was pointed at, the other half of the
  // table would report as missing on healthy data — and a check that fires on
  // healthy data is worse than no check, because it teaches an operator to
  // ignore the one that matters.
  //
  // reconcile.js's reconcileBonusGrants understands both shapes and owns this
  // domain's cross-store comparison instead.
]);
