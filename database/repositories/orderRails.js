// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Which rail an order runs on (redesign Step 2c, PROJECT_STATUS §3.10).
 *
 * Its own module because both the order writer (which STAMPS the rail at
 * creation) and the router (which READS it to choose a team) need it, and the
 * router already imports the order writer — a home in either would be a cycle.
 */
import { SUPERVISOR_RAILS } from './teams.js';
import { MAX_CASH_BUY_PAISE } from '../../backend/domains/merchant/denominations.js';

/** The three rails a supervisor is approved for, as constants. */
export const RAILS = Object.freeze(Object.fromEntries(SUPERVISOR_RAILS.map((r) => [r, r])));

/**
 * The two values `order_states.payment_mode` takes. Import these — never write
 * the strings. CASH_ATM is the cash rail (a member at a machine); P2P_UPI is
 * everything else, USDT included, whose rail `railOf` reads off the currency.
 */
export const PAYMENT_MODES = Object.freeze({
  P2P_UPI:  'P2P_UPI',
  CASH_ATM: 'CASH_ATM',
});

/**
 * The mode a NEW order is stamped with — derived from the order itself, never
 * read from a switch (PROJECT_STATUS §3.10, 2c). There is no platform-wide rail
 * any more: each supervisor is approved for one, and an order goes to whichever
 * rail serves its size. An INR order up to the cash ceiling (₹10,000, the most
 * a machine dispenses in one go) is a cash order; a larger one is UPI/bank; a
 * USDT order is the USDT rail whatever its size.
 *
 * Stamped at creation and frozen by trigger, so an open order cannot change
 * rail under the member serving it. 2d replaces the size boundary with the
 * admin's denomination list.
 */
export function paymentModeFor({ currency, tokenAmountPaise }) {
  if (String(currency ?? 'INR').toUpperCase() === 'USDT') return PAYMENT_MODES.P2P_UPI;
  const paise = Number(tokenAmountPaise);
  if (!Number.isInteger(paise) || paise <= 0) {
    throw new TypeError(`paymentModeFor: token amount must be positive paise, got ${tokenAmountPaise}`);
  }
  return paise <= MAX_CASH_BUY_PAISE ? PAYMENT_MODES.CASH_ATM : PAYMENT_MODES.P2P_UPI;
}

/**
 * The rail an order runs on, from its own row. A USDT order is the USDT rail;
 * an INR order on the cash-machine mode is CASH; every other INR order is
 * UPI_BANK. The order's mode is stamped at creation and frozen by trigger, so
 * this answer cannot change under an open order.
 */
export function railOf(order) {
  if (String(order?.currency ?? 'INR').toUpperCase() === 'USDT') return RAILS.USDT;
  return order?.paymentMode === PAYMENT_MODES.CASH_ATM ? RAILS.CASH : RAILS.UPI_BANK;
}

