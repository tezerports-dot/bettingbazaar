// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * A single store means there is nothing to route between. `MONEY_PATHS` named
 * the eleven money domains a per-call resolver chose a store for; the resolver
 * is deleted, and these are kept only as the metric LABELS that dashboards and
 * alerts already query by.
 */
export const MONEY_PATHS = Object.freeze({
  WALLET: 'wallet', BETS: 'bets', ORDERS: 'orders', LEDGER: 'ledger',
  SETTLEMENTS: 'settlements', CASINO_SETTLEMENT: 'casino_settlement',
  BONUSES_AND_COMMISSIONS: 'bonuses_and_commissions', KYC: 'kyc',
  MERCHANT_WALLET: 'merchant_wallet', MERCHANT_SETTLEMENT: 'merchant_settlement',
  ADMIN_ISSUANCE: 'admin_issuance',
});
