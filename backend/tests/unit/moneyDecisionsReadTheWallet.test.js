// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A number that GATES money is read from the wallet.
 *
 * Four gates were decided from a stored copy of a balance while the movement
 * itself touched `wallets` / `merchant_wallets`:
 *
 *   - withdrawal admission          (the path where money LEAVES the platform)
 *   - merchant assignment           (which merchant is handed a deposit)
 *   - the merchant accept guard     (whether that merchant may take it)
 *   - the account-delete guard      (whether money is still committed)
 *
 * None of them looked wrong at the call site. Each was a plain property access
 * on an object that happened to have come from somewhere else, and each would
 * have admitted a movement the wallet could not fund.
 *
 * These are SOURCE assertions rather than behavioural ones, deliberately. The
 * behaviour is covered against a real database elsewhere; what is asserted here
 * is that the gate cannot silently regress to reading a record field again —
 * which is exactly how it was written the first time.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/** The gate line, with its surrounding function, for each site. */
const SITES = [
  {
    // ── The strongest form of this rule ──────────────────────────────────
    // The other four sites READ the wallet and then decide. This one does not
    // decide at all: `debitWinningsForWithdrawal` moves winnings → locked under
    // `SELECT … FOR UPDATE` on the wallet row and refuses what the row cannot
    // fund, so admission and movement are the same act and cannot disagree.
    //
    // The three checks that used to stand in front of it are gone, and their
    // absence is what is asserted. They read the balance, summed the player's
    // in-flight withdrawals, and compared — three reads with nothing holding
    // them together, so two requests arriving at once both passed. And the sum
    // DOUBLE-COUNTED: an in-flight withdrawal's tokens are already out of
    // winnings and in locked, so a player with ₹1,000 who asked for ₹400 had
    // their next ₹400 refused against money they held. The guard admitted
    // overdrafts under concurrency and refused legitimate withdrawals the rest
    // of the time.
    name: 'withdrawal admission',
    file: 'domains/payment/paymentProcessing.service.js',
    // A cash payout too large for one denomination is created as SEVERAL
    // ordinary withdrawals, so this runs once per part — each debiting its own
    // amount against its own order id. The gate is unchanged in kind: the
    // wallet's row lock still decides, it is simply consulted once per
    // withdrawal being created, which is what one-withdrawal-per-part means.
    gates: [/debited = await debitWinningsForWithdrawal\(String\(user\.userId\), partTokens, partOrderId\)/,
            /err\.code === 'INSUFFICIENT_WITHDRAWABLE'/],
    // The figures in the refusal come off the refusal itself — from the rows
    // the debit locked — never from a record read separately.
    source: /err\.availableWinnings/,
    forbidden: [
      /> \(user\.winningsBalance/,
      /user\.winningsBalance < tokenAmount/,
      // The pre-checks, by shape. Any of these coming back means somebody has
      // put a second, unsynchronised decision in front of the wallet again.
      /if \(availableWinnings < tokenAmount\)/,
      /pendingTotal \+ tokenAmount > availableWinnings/,
    ],
  },
  {
    name: 'merchant assignment',
    file: 'domains/merchant/merchantScoring.service.js',
    gates: [/candidates\.filter\(\(m\) => paiseOf\(m\) >= neededPaise\)/],
    source: /await getSpendablePaiseFor\(candidates\.map/,
    forbidden: [
      // The eligibility query must not gain a balance predicate. The merchant
      // row has no balance column, so one written here would be reading
      // something that is not a merchant's money — the same defect as the
      // stored `tokenBalance` filter it replaced, one layer down.
      /baseQuery\.tokenBalance/,
      /token_balance/,
      /m\.tokenBalance\s*[<>]/,
      // The RAW pocket, at a site that GATES an assignment. It answers "what
      // does this merchant hold", and admission needs "what have they not
      // already promised" — the two differ by exactly the orders in flight,
      // which is the whole of F-018. Forbidden by name so a later edit cannot
      // quietly swap the reader back and stay green.
      /getAvailablePaiseFor/,
    ],
  },
  {
    // ── This gate is no longer a READ ────────────────────────────────────────
    // It compared a balance and then accepted the order in a later statement.
    // Any such pair is a snapshot however good the number is, and two merchants
    // claiming from the open pool in the same instant both passed it. Taking
    // the HOLD is the question: its refusal is in the reserve leg's own
    // `UPDATE … WHERE available_paise + $n >= 0` under the merchant's row lock.
    //
    // So what is asserted here is that no balance READ has come back to this
    // gate — the entry is kept in this file precisely so that reintroducing one
    // fails.
    name: 'merchant accept guard',
    file: 'domains/merchant/merchant.routes.js',
    gates: [/if \(!held\.ok\) \{/],
    source: /const held = await holdDepositTokens\(order, merchant\.merchantId/,
    forbidden: [
      /\(merchant\.tokenBalance \|\| 0\) < order\.tokenAmount/,
      // Every reader, by name. All three answer "what does this merchant have",
      // and admission needs "are these tokens now MINE" — which only a write
      // can answer (F-018).
      /await getMerchantTokenBalance\(/,
      /getMerchantSpendableTokens\(/,
      /getAvailablePaiseFor\(/,
    ],
  },
  {
    // ── This entry pointed at a file NOTHING IMPORTED ────────────────────────
    // `services/admin.service.js` was a 380-line parallel implementation of
    // block/unblock/delete/sub-admin CRUD that no route, service or script ever
    // called. It held this guard, so this assertion passed on every run — while
    // the LIVE `DELETE /api/admin/users/:userId` had no guard at all and would
    // soft-delete a player with a withdrawal still in escrow.
    //
    // The dead file is gone and the entry points at the route that actually
    // serves the delete. Asserting a money guard against unreachable code is
    // worse than having no assertion: it reports the guard as present.
    name: 'account delete guard',
    file: 'routes/admin/users.admin.routes.js',
    gates: [/if \(lockedBalance > 0\)/],
    source: /const \{ lockedBalance \} = await getBalancesPaise\(/,
    forbidden: [/if \(user\.lockedBalance > 0\)/],
  },
  {
    name: 'queue-manager assignment list',
    file: 'domains/merchant/merchant.assignment.routes.js',
    gates: [/return m\.walletAvailableTokens >= amount;/],
    // SPENDABLE, because this list is what a queue manager assigns FROM.
    //
    // The regex used to be `getAvailablePaiseFor\(merchants\.map`, and after
    // this site moved to the spendable reader it still MATCHED — the two pool
    // LISTINGS further down the same file call it with the same argument name,
    // and they are display reads that correctly keep it. The assertion went on
    // passing while measuring a different site than the one it names. Anchored
    // on the reader that only the gating site uses.
    source: /await getSpendablePaiseFor\(merchants\.map/,
    forbidden: [
      /if \(m\.tokenBalance < amount\)/,
      // The pool and candidate listings quote a balance too, and an admin
      // curating the pool picks from that figure. Reading a stored
      // `tokenBalance` there showed them a number no transfer would find.
      /tokenBalance: m\.tokenBalance/,
    ],
  },
  {
    // The manual-assign and reassign gate. It is the only assignment path with
    // no concurrency query behind it, so it is the only thing standing between
    // a merchant and a second order they cannot fund.
    // Same change, at the manual-assign gate — the one assignment path with no
    // concurrency query behind it, so the only thing between a merchant and an
    // order they cannot fund.
    name: 'queue-manager inventory refusal',
    file: 'domains/merchant/merchant.assignment.routes.js',
    gates: [/const held = await holdDepositTokens\(order, merchantId, \{ actor \}\);\s*\n\s*if \(held\.ok\) return null;/],
    source: /async function inventoryRefusal\(order, merchantId/,
    forbidden: [
      /await getMerchantTokenBalance\(/,
      /getMerchantSpendableTokens\(/,
      /getAvailablePaiseFor\(merchantId/,
    ],
  },
  {
    // Who is told to walk to a cash machine. A merchant already serving a buy
    // order has those tokens promised; sending them out for work they cannot
    // fund wastes a trip they cannot get back.
    name: 'cash link suppliers',
    file: 'domains/merchant/cashLink.service.js',
    gates: [/return row\.spendable \+ c\.soonPaise >= needed;/],
    source: /await getSpendablePaiseFor\(candidates\.map/,
    forbidden: [/getAvailablePaiseFor/],
  },
];

describe('every money decision reads the wallet', () => {
  for (const site of SITES) {
    describe(site.name, () => {
      const source = read(site.file);

      it('reads the balance from the wallet', () => {
        expect(source).toMatch(site.source);
      });

      for (const gate of site.gates) {
        it(`gates on that number: ${gate.source.slice(0, 46)}`, () => {
          expect(source).toMatch(gate);
        });
      }

      for (const bad of site.forbidden) {
        it(`does NOT gate on a record field: ${bad.source.slice(0, 40)}`, () => {
          expect(source).not.toMatch(bad);
        });
      }
    });
  }

  it('the audit script agrees there are none left', async () => {
    // The same check CI runs. Kept here too so a regression fails the fast
    // suite rather than waiting for the slower job.
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('node', ['scripts/audit-balance-reads.mjs'], { encoding: 'utf8' });
    expect(out).toMatch(/No decision read bypasses the wallet/);
  });
});
