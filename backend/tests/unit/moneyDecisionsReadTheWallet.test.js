// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
    name: 'withdrawal admission',
    file: 'domains/payment/paymentProcessing.service.js',
    gates: [/if \(pendingTotal \+ tokenAmount > availableWinnings\)/,
            /if \(availableWinnings < tokenAmount\)/],
    source: /const balances = await getBalances\(String\(user\._id\)\)/,
    forbidden: [/> \(user\.winningsBalance/, /user\.winningsBalance < tokenAmount/],
  },
  {
    name: 'merchant assignment',
    file: 'domains/merchant/merchantScoring.service.js',
    gates: [/availablePaise\.get\(String\(m\._id\)\) \?\? -1\) >= neededPaise/],
    source: /await getAvailablePaiseFor\(candidates\.map/,
    // A Mongo query cannot express a Postgres condition, so this must not come
    // back as a filter on the query document.
    forbidden: [/baseQuery\.tokenBalance/],
  },
  {
    name: 'merchant accept guard',
    file: 'domains/merchant/merchant.routes.js',
    gates: [/availableTokens < order\.tokenAmount/],
    source: /await getMerchantTokenBalance\(merchant\._id\)/,
    forbidden: [/\(merchant\.tokenBalance \|\| 0\) < order\.tokenAmount/],
  },
  {
    name: 'account delete guard',
    file: 'services/admin.service.js',
    gates: [/if \(lockedBalance > 0\)/],
    source: /const \{ lockedBalance \} = await getBalances\(/,
    forbidden: [/if \(user\.lockedBalance > 0\)/],
  },
  {
    name: 'queue-manager assignment list',
    file: 'domains/merchant/merchant.assignment.routes.js',
    gates: [/m\.walletAvailableTokens < amount/],
    source: /await getAvailablePaiseFor\(merchantDocs\.map/,
    forbidden: [/if \(m\.tokenBalance < amount\)/],
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
