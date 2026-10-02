// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A number that GATES money is read from the wallet.
 *
 * Four gates were decided from a stored copy of a balance while the movement
 * itself touched the wallet it was about (player wallets, and the merchant
 * wallets Step 2c replaced with team pools):
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
    // The debit carries the part's prepared INSERT (`within`), so the lock and
    // the order it is for commit together — a lock with no order is money no
    // expiry or refund can ever find.
    gates: [/debited = await debitWinningsForWithdrawal\(String\(user\.userId\), partTokens, partOrderId, \{ within: insertPart \}\)/,
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
    // ── A buy's cover is a WRITE, not a read (Step 2c) ───────────────────────
    // Merchant wallets are gone: a buy is served from its TEAM's pool, and the
    // pool's cover is taken by `holdForBuyWithin` inside the same transaction
    // that assigns the order — `UPDATE team_pools … WHERE available_paise >= $n`
    // under the pool's row lock. The candidate query's pool predicate is only a
    // filter; the hold is the decision. What is asserted is that the hold is
    // still taken inside the assignment, and that no per-merchant balance has
    // come back as a gate.
    name: 'team assignment',
    file: '../database/repositories/teamRouting.js',
    gates: [/await holdForBuyWithin\(client, \{/],
    source: /if \(isBuy\) \{\s*\n\s*await holdForBuyWithin/,
    forbidden: [/getSpendablePaiseFor/, /getAvailablePaiseFor/, /tokenBalance/],
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
