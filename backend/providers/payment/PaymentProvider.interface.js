// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * PaymentProvider.interface.js — Base class for all payment gateway integrations.
 *
 * HOW TO ADD A NEW PROVIDER
 * ─────────────────────────
 * 1. Create backend/providers/payment/<name>/<Name>Provider.js
 * 2. Extend PaymentProvider and implement every method.
 * 3. Register at startup: providerRegistry.register(new YourProvider());
 * 4. No changes to business logic or existing routes required.
 *
 * SUPPORTED PROVIDER TYPES
 *   Domestic UPI/IMPS  — current merchant provider (already live)
 *   International      — Stripe, Razorpay international, etc.
 *   Crypto             — future
 *   UPI aggregator     — future
 */

export class PaymentProvider {
  /** Unique snake_case identifier, e.g. 'merchant_upi', 'stripe_intl' */
  get id()          { throw new Error(`${this.constructor.name}: id not implemented`); }
  get displayName() { return this.id; }
  get version()     { return '1.0.0'; }
  /** Currencies this provider accepts, e.g. ['INR'], ['USD','EUR'] */
  get currencies()  { return ['INR']; }

  /** @returns {Promise<boolean>} */
  async isAvailable()  { return true; }
  /** @returns {Promise<{ok: boolean, latencyMs?: number}>} */
  async healthCheck()  { return { ok: true }; }

  /**
   * Called when a user initiates a DEPOSIT.
   * Return enough data for the UI to show payment instructions.
   * @param {object} order  PaymentOrder document
   * @returns {Promise<{sessionId: string, instructions: object}>}
   */
  async createDepositSession(order) {
    throw new Error(`${this.constructor.name}: createDepositSession not implemented`);
  }

  /**
   * Verify a payment reference against provider records.
   * @param {string} reference  UTR, transaction ID, etc.
   * @param {number} amount     Expected amount in minor units
   * @param {string} currency
   * @returns {Promise<{verified: boolean, providerRef?: string}>}
   */
  async verifyPayment(reference, amount, currency = 'INR') {
    throw new Error(`${this.constructor.name}: verifyPayment not implemented`);
  }

  /**
   * Initiate a WITHDRAWAL / merchant payout.
   * @param {object} order  PaymentOrder document
   * @returns {Promise<{providerRef: string, eta?: Date}>}
   */
  async initiateWithdrawal(order) {
    throw new Error(`${this.constructor.name}: initiateWithdrawal not implemented`);
  }

  /**
   * Validate and parse an incoming webhook payload.
   * @param {Buffer|object} payload
   * @param {string}        signature  From provider request headers
   * @param {string}        secret     From environment config
   * @returns {Promise<{event: string, orderId: string, status: string}>}
   */
  async handleWebhook(payload, signature, secret) {
    throw new Error(`${this.constructor.name}: handleWebhook not implemented`);
  }
}
