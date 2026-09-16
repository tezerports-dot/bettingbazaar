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
    // A COMPARISON of a balance against an order amount is a gate wherever it
    // appears, so this one is banned across the whole file.
    forbidden: [
      /\(merchant\.tokenBalance \|\| 0\) < order\.tokenAmount/,
    ],
    // ── The reader names are banned INSIDE THE HANDLER, not file-wide ────────
    // They were banned across the file, and that was a proxy standing in for
    // what this entry actually means: no balance read has come back to THIS
    // GATE. The proxy held only while nothing else in the file had a reason to
    // read a balance — and then something did. `formatMerchant` and
    // `issueMerchantSession` project the merchant's own wallet figure onto
    // their panel, which is a DISPLAY read (§9) feeding a screen, not a gate
    // deciding anything. The file-wide ban failed it, and a gate that fails a
    // correct change is how a gate loses trust and gets silenced (§28).
    //
    // So the ban is scoped to the accept handler's own body — "derive what a
    // gate checks from the thing it is checking". A read reintroduced AT the
    // gate still fails; a read used to paint a number on a screen does not.
    //
    // §9 is what makes this safe to narrow: every balance read is classified
    // display or decision, and `check:balance-reads` audits that classification
    // across the whole backend independently of this file. This entry is the
    // one-site belt; that script is the braces.
    forbiddenWithin: {
      // Both ends are asserted below, so a rename that makes this select
      // nothing is a FAILURE rather than a silent pass over zero lines
      // (§24.6 — a check that measures nothing reads exactly like a check).
      from: /^router\.post\('\/accept\/:id'/m,
      to:   /^router\.post\('\/confirm\/:id'/m,
      patterns: [
        // All three answer "what does this merchant have", and admission needs
        // "are these tokens now MINE" — which only a write can answer (F-018).
        /await getMerchantTokenBalance\(/,
        /getMerchantSpendableTokens\(/,
        /getAvailablePaiseFor\(/,
      ],
    },
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

      if (site.forbiddenWithin) {
        const { from, to, patterns } = site.forbiddenWithin;

        // The slice is asserted before anything is asserted ABOUT it. A
        // `from`/`to` that no longer matches would otherwise hand every check
        // below an empty string, which passes every `not.toMatch` there is —
        // a check measuring nothing, reading exactly like a check (§24.6).
        const start = source.search(from);
        const rest  = start < 0 ? '' : source.slice(start + 1);
        const end   = rest.search(to);
        const body  = start < 0 || end < 0 ? '' : rest.slice(0, end);

        it('can still find the handler it is scoped to', () => {
          expect(start, `${site.file}: ${from} no longer matches`).toBeGreaterThanOrEqual(0);
          expect(end, `${site.file}: ${to} no longer matches`).toBeGreaterThanOrEqual(0);
          // A handler this short is a delimiter that has slid, not a handler.
          expect(body.length).toBeGreaterThan(400);
          // And it really is the gate's own body.
          expect(body).toMatch(site.source);
        });

        for (const bad of patterns) {
          it(`does not read a balance inside the handler: ${bad.source.slice(0, 40)}`, () => {
            expect(body).not.toMatch(bad);
          });
        }
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
