// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Funding Platform (BBEPS Phase 009).
//
// FUNDING PROVIDER REGISTRY — the Provider/Adapter pattern confirmed in the
// Phase 005 technology strategy. Every way money can enter or leave the
// ecosystem is a PROVIDER behind one interface. Adding a payment gateway or
// a crypto rail = add an adapter here; no route or service changes.
//
// Adapter interface (duck-typed; ACTIVE adapters must implement both create
// methods or declare the capability false):
//   {
//     code, label, currency, kind: 'P2P' | 'GATEWAY' | 'CRYPTO',
//     active: boolean,
//     capabilities: { deposit: boolean, withdrawal: boolean },
//     createDeposit({ userId, tokenAmount })    → provider-specific result
//     createWithdrawal({ userId, tokenAmount }) → provider-specific result
//   }

import { createDepositOrder, createWithdrawalOrder } from '../payment/paymentProcessing.service.js';

// ── MANUAL_P2P_INR — the live provider ───────────────────────────────────────
// The existing merchant-fulfilled INR flow (queue assignment, UPI/bank, UTR
// verification). The implementation stays in domains/payment/ — this adapter
// is the Funding Platform's handle on it.
const manualP2PInr = {
  code: 'MANUAL_P2P_INR',
  label: 'Merchant P2P (INR)',
  currency: 'INR',
  kind: 'P2P',
  active: true,
  capabilities: { deposit: true, withdrawal: true },
  createDeposit:    ({ userId, tokenAmount }) => createDepositOrder(userId, tokenAmount),
  createWithdrawal: ({ userId, tokenAmount }) => createWithdrawalOrder(userId, tokenAmount),
};

// ── USDT_TRC20 — declared, inactive ──────────────────────────────────────────
// Deposit-only USDT (TRC20) per the 2026-07 direction; config fields exist
// on the platform already. Activating requires the USDT Treasury build
// (address management, chain confirmation watching, INR-peg conversion at
// the fixed 1:1 token rate) — tracked in docs/governance/EXECUTION_QUEUE.md. Until then the
// adapter exists so the registry, not scattered route code, is where USDT
// lands.
const usdtTrc20 = {
  code: 'USDT_TRC20',
  label: 'USDT (TRC20)',
  currency: 'USDT',
  kind: 'CRYPTO',
  active: false,
  capabilities: { deposit: true, withdrawal: false },
  createDeposit:    () => { throw Object.assign(new Error('USDT deposits are not live yet.'), { status: 503 }); },
  createWithdrawal: () => { throw Object.assign(new Error('USDT withdrawals are not supported.'), { status: 400 }); },
};

// ── PAYMENT_GATEWAY — declared, inactive ─────────────────────────────────────
// Third-party gateway scaffolding (PaymentGatewayConfig model exists,
// confirmed intentional). An actual gateway integration implements this
// adapter's methods against the gateway API.
const paymentGateway = {
  code: 'PAYMENT_GATEWAY',
  label: 'Payment Gateway (future)',
  currency: 'INR',
  kind: 'GATEWAY',
  active: false,
  capabilities: { deposit: true, withdrawal: true },
  createDeposit:    () => { throw Object.assign(new Error('No payment gateway is configured.'), { status: 503 }); },
  createWithdrawal: () => { throw Object.assign(new Error('No payment gateway is configured.'), { status: 503 }); },
};

const PROVIDERS = Object.freeze({
  [manualP2PInr.code]: manualP2PInr,
  [usdtTrc20.code]: usdtTrc20,
  [paymentGateway.code]: paymentGateway,
});

export const DEFAULT_PROVIDER = manualP2PInr.code;

export function getProvider(code = DEFAULT_PROVIDER) {
  const p = PROVIDERS[code];
  if (!p) throw Object.assign(new Error(`Unknown funding provider '${code}'.`), { status: 400 });
  return p;
}

export function listProviders() {
  return Object.values(PROVIDERS).map(({ code, label, currency, kind, active, capabilities }) =>
    ({ code, label, currency, kind, active, capabilities }));
}
