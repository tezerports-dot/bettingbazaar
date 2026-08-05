// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The four WalletLedger writers in wallet.service.js, with mongoose mocked.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The M-8 fix rewrote `refId: orderId` to a shorthand `refId` at all four call
 * sites but declared the variable in refundOrder alone. The other three —
 * deposit, reserve allocation and withdrawal — then threw
 * `ReferenceError: refId is not defined` INSIDE the transaction, i.e. every
 * deposit, every reserve credit and every withdrawal returned 500.
 *
 * `node --check` passes on that (it is valid syntax), the unit suite passed
 * (these functions had no unit test), and the Postgres suite passed (it does
 * not touch the Mongo path). Only the integration suite caught it, and that
 * suite cannot run in the build sandbox — so the regression could only be seen
 * after a push. These tests close that gap: they exercise the real function
 * bodies with a fake mongoose, so the same class of mistake fails locally in
 * milliseconds with no database at all.
 *
 * The assertions are deliberately about the LEDGER DOCUMENT each writer
 * builds, because that document is the audit record. Getting a field wrong
 * there is not cosmetic — it is a money movement nobody can later explain.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import {
  creditDeposit, creditReserve, debitWinningsForWithdrawal, refundOrder,
} from '../../domains/wallet/wallet.service.js';

/** A real 24-hex id, so `ObjectId.isValid` is genuinely satisfied. */
const ORDER_OID = '6512ab34cd56ef7890123456';
const USER_OID  = '6512ab34cd56ef7890000001';

let ledgerDocs;   // every doc handed to WalletLedger.create
let incs;         // every $inc handed to User.findByIdAndUpdate
let userDoc;

/**
 * The narrowest fake that lets the real function bodies run: a chainable
 * `findById(...).session(...)` that also answers `.lean()`, plus a
 * `findOne(...).lean()` for the idempotency probe.
 */
function installMongooseFakes() {
  const chain = () => {
    const p = Promise.resolve(userDoc);
    p.session = () => chain();
    p.lean = () => Promise.resolve(userDoc);
    return p;
  };

  const User = {
    findById: () => chain(),
    findByIdAndUpdate: (_id, update) => { incs.push(update.$inc); return Promise.resolve(userDoc); },
  };

  const WalletLedger = {
    // No prior row: the writers must proceed to the movement.
    findOne: () => ({ lean: () => Promise.resolve(null), session() { return this; }, select() { return this; } }),
    create: (docs) => { ledgerDocs.push(...docs); return Promise.resolve(docs); },
  };

  vi.spyOn(mongoose, 'model').mockImplementation((name) => {
    if (name === 'User') return User;
    if (name === 'WalletLedger') return WalletLedger;
    throw new Error(`unexpected model(${name}) — the fake does not cover it`);
  });
}

// Truthy `extSession` makes each writer call its body directly instead of
// opening a transaction, which is what lets this run with no server.
const SESSION = { fake: true };

beforeEach(() => {
  ledgerDocs = [];
  incs = [];
  userDoc = {
    _id: USER_OID,
    depositBalance: 100, winningsBalance: 250, reserveBalance: 40, lockedBalance: 0,
  };
  installMongooseFakes();
});

afterEach(() => { vi.restoreAllMocks(); });

describe('wallet.service ledger writers run end to end', () => {
  it('creditDeposit writes one CREDIT row against depositBalance', async () => {
    const r = await creditDeposit(USER_OID, 25, ORDER_OID, SESSION);

    expect(r).toMatchObject({ depositBefore: 100, depositAfter: 125 });
    expect(ledgerDocs).toHaveLength(1);
    expect(ledgerDocs[0]).toMatchObject({
      type: 'CREDIT', field: 'depositBalance', amount: 25,
      balanceBefore: 100, balanceAfter: 125,
      refModel: 'PaymentOrder', refId: ORDER_OID, txId: `dep_complete_${ORDER_OID}`,
    });
    expect(incs).toEqual([{ depositBalance: 25 }]);
  });

  it('creditReserve writes one CREDIT row against reserveBalance', async () => {
    const r = await creditReserve(USER_OID, 10, ORDER_OID, SESSION);

    expect(r).toMatchObject({ reserveBefore: 40, reserveAfter: 50 });
    expect(ledgerDocs[0]).toMatchObject({
      type: 'CREDIT', field: 'reserveBalance', amount: 10,
      refId: ORDER_OID, txId: `reserve_credit_${ORDER_OID}`,
    });
  });

  it('debitWinningsForWithdrawal moves winnings into locked, never deposit', async () => {
    const r = await debitWinningsForWithdrawal(USER_OID, 50, ORDER_OID, SESSION);

    expect(r).toMatchObject({ winningsBefore: 250, winningsAfter: 200, lockedAfter: 50 });
    expect(ledgerDocs[0]).toMatchObject({
      type: 'DEBIT', field: 'winningsBalance', amount: 50, refId: ORDER_OID,
    });
    // Withdrawals must never draw on deposit money — that is the rule the
    // whole winnings/deposit split exists to enforce.
    expect(incs).toEqual([{ winningsBalance: -50, lockedBalance: 50 }]);
  });

  it('refundOrder credits back the field it was given', async () => {
    await refundOrder(USER_OID, 30, ORDER_OID, 'depositBalance', SESSION);
    expect(ledgerDocs[0]).toMatchObject({
      type: 'CREDIT', field: 'depositBalance', amount: 30,
      refId: ORDER_OID, txId: `refund_${ORDER_OID}`,
    });
  });
});

describe('M-8: a non-ObjectId order id must not abort the movement', () => {
  // The live case. gameProvider.routes passes
  // `body.roundId || body.round_id || body.gameRound || txId` — provider text,
  // not a PaymentOrder _id. Before the fix this threw a CastError inside the
  // transaction and took the whole refund with it.
  const ROUND = 'round-7f3a-provider-supplied';

  it('refundOrder stores a null refId rather than throwing', async () => {
    const r = await refundOrder(USER_OID, 30, ROUND, 'depositBalance', SESSION);

    expect(r).toMatchObject({ before: 100, after: 130 });
    expect(ledgerDocs[0].refId).toBeNull();
    // The id is not lost: it is still in the key and in the human-readable
    // reason, which is the whole argument for dropping the typed column.
    expect(ledgerDocs[0].txId).toBe(`refund_${ROUND}`);
    expect(ledgerDocs[0].reason).toContain(ROUND);
  });

  it('keeps a real ObjectId when it is given one', async () => {
    await refundOrder(USER_OID, 30, ORDER_OID, 'depositBalance', SESSION);
    // Dropping every refId would "fix" M-8 by throwing the audit link away.
    expect(ledgerDocs[0].refId).toBe(ORDER_OID);
  });
});
