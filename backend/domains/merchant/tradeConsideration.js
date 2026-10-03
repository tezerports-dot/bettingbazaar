// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * tradeConsideration.js — what the platform got, or gave, for tokens it moved
 * to or from a merchant or a team pool, read off an admin's request.
 *
 * Read by the team-pool fulfilment route (`team.admin.routes.js`), the one
 * place tokens now move between the platform and the merchant side. The
 * per-merchant top-up/deduct routes it used to be shared with were removed
 * with merchant wallets in Step 2c.
 */
import { rupeesToPaise } from '../../shared/money.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { adminToMerchantUsdtRate } from '../configuration/tokenRates.js';
import {
  DIRECTIONS as CONSIDERATION_DIRECTIONS,
  CONSIDERATION_CURRENCIES,
} from '#db/repositories/adminTokenConsiderations.js';

// ─────────────────────────────────────────────────────────────────────────────
// What the platform got, or gave, for the tokens — read off the request and
// checked BEFORE anything moves.
//
// Both money routes below hand an admin's typed figure to the same function, so
// the two cannot come to different conclusions about the same input (§5). It is
// called at the TOP of each handler, before a single token moves, because the
// row it prepares is written AFTER the movement commits: §21's shape, where
// anything that can throw on the second write throws with the tokens already
// gone. By the time the insert runs, every CHECK on the table is known to hold.
//
// `settlementAmount` arrives in the MAJOR unit — rupees, or whole USDT — the
// way `tokenAmount` does, because that is what an admin types. It is stored in
// hundredths, and `rupeesToPaise` is the same rounding every other money field
// on this platform uses, so ₹0.1 + ₹0.2 cannot become ₹0.30000000000000004.
//
// The USDT rate is NOT typed. It is the admin's own configured buy rate read at
// this moment and frozen on the row (§25): an operator editing that rate
// tomorrow must not restate a trade that has already settled. When it is unset
// the trade is REFUSED BY NAME rather than valued at the INR peg — a 500 USDT
// receipt booked as ₹500 is trap 15, a hundredfold understatement in the exact
// figure this feature exists to get right.
// ─────────────────────────────────────────────────────────────────────────────
export async function resolveConsideration(body, direction) {
  const currency = String(body?.settlementCurrency ?? 'INR').toUpperCase();
  const raw      = body?.settlementAmount;

  // Refused here rather than at the repository so the message names the field
  // the operator can see, and carries 400 so respondError keeps its wording.
  const refuse = (message) => { const e = new Error(message); e.status = 400; throw e; };

  if (raw === null || raw === undefined || raw === '') {
    refuse(
      'Record what the platform '
      + (direction === CONSIDERATION_DIRECTIONS.RECEIVED ? 'received' : 'paid')
      + ' for these tokens. Enter 0 if no money changed hands.',
    );
  }
  const major = Number(raw);
  if (!Number.isFinite(major) || major < 0) {
    refuse(`The settlement amount must be zero or more — got '${raw}'.`);
  }
  if (!CONSIDERATION_CURRENCIES.includes(currency)) {
    refuse(`Settlement currency must be one of ${CONSIDERATION_CURRENCIES.join(', ')} — got '${currency}'.`);
  }

  let rateUsed = null;
  if (currency === 'USDT') {
    const cfg  = await getSystemConfig();
    // null when unset or outside the sanity band (`tokenRates.js`, the owner).
    const rate = adminToMerchantUsdtRate(cfg);
    if (rate === null) {
      refuse(
        'The admin USDT buy rate is not set to a usable price (₹10–₹1,000 per USDT), so a USDT receipt cannot be valued in rupees. '
        + 'Set it in System Settings → USDT Pricing, or record this settlement in INR.',
      );
    }
    rateUsed = rate;
  }

  const consideration = {
    direction,
    currency,
    fiatAmountMinor: rupeesToPaise(major),
    rateUsed,
  };
  return consideration;
}

