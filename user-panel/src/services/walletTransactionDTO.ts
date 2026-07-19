// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/walletTransactionDTO.ts
 *
 * SINGLE normalized transaction shape for ALL wallet history sources:
 *   - WalletLedger records    (/api/v1/wallet/ledger)
 *   - PaymentOrder records        (/api/payment/orders)
 *   - WithdrawalRequest records
 *   - Exchange / bonus records
 *
 * Frontend components (TransactionTable, WalletHistoryPage) only ever
 * consume WalletTransactionDTO[]. They never read raw backend shapes.
 */

export type TxType =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'BET'
  | 'WIN'
  | 'REFUND'
  | 'BONUS'
  | 'REFERRAL'
  | 'ADJUSTMENT'
  | 'EXCHANGE';

export type TxStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'DISPUTED';

export interface WalletTransactionDTO {
  id:            string;
  type:          TxType;
  amount:        number;
  status:        TxStatus;
  createdAt:     string;       // ISO 8601
  balanceBefore: number | null;
  balanceAfter:  number | null;
  orderId:       string | null;
  merchantId:    string | null;
  remarks:       string;
  walletType:    'deposit' | 'winnings' | 'unknown';
}

// ── Normalizers ────────────────────────────────────────────────────────────────

/** Map a raw WalletLedger entry to DTO */
export function fromLedger(raw: Record<string, unknown>): WalletTransactionDTO {
  return {
    id:            String(raw._id ?? raw.id ?? ''),
    type:          mapLedgerType(String(raw.type ?? '')),
    amount:        Number(raw.amount ?? 0),
    status:        'COMPLETED',
    createdAt:     String(raw.createdAt ?? raw.timestamp ?? new Date().toISOString()),
    balanceBefore: raw.balanceBefore != null ? Number(raw.balanceBefore) : null,
    balanceAfter:  raw.balanceAfter  != null ? Number(raw.balanceAfter)  : null,
    orderId:       raw.orderId   ? String(raw.orderId)   : null,
    merchantId:    raw.merchantId ? String(raw.merchantId) : null,
    remarks:       String(raw.remarks ?? raw.description ?? raw.reason ?? ''),
    walletType:    (raw.balanceType === 'winnings' ? 'winnings'
                  : raw.balanceType === 'deposit'  ? 'deposit' : 'unknown'),
  };
}

/** Map a raw PaymentOrder to DTO */
export function fromPaymentOrder(raw: Record<string, unknown>): WalletTransactionDTO {
  const isDeposit = String(raw.type ?? '').toUpperCase() === 'DEPOSIT';
  return {
    id:            String(raw._id ?? raw.orderId ?? ''),
    type:          isDeposit ? 'DEPOSIT' : 'WITHDRAWAL',
    amount:        Number(raw.fiatAmount ?? raw.amount ?? 0),
    status:        mapOrderStatus(String(raw.status ?? '')),
    createdAt:     String(raw.createdAt ?? new Date().toISOString()),
    balanceBefore: null,
    balanceAfter:  null,
    orderId:       String(raw.orderId ?? raw._id ?? ''),
    merchantId:    raw.merchantId ? String(raw.merchantId) : null,
    remarks:       String(raw.remarks ?? `P2P ${isDeposit ? 'Deposit' : 'Withdrawal'}`),
    walletType:    isDeposit ? 'deposit' : 'winnings',
  };
}

/** Normalise any raw backend record into DTO (auto-detects source) */
export function normalizeTransaction(raw: Record<string, unknown>): WalletTransactionDTO {
  if (raw.balanceBefore !== undefined || raw.balanceAfter !== undefined) return fromLedger(raw);
  if (raw.orderId !== undefined || raw.fiatAmount !== undefined) return fromPaymentOrder(raw);
  return fromLedger(raw); // fallback
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function mapLedgerType(raw: string): TxType {
  const r = raw.toUpperCase();
  if (r.includes('DEPOSIT'))    return 'DEPOSIT';
  if (r.includes('WITHDRAW'))   return 'WITHDRAWAL';
  if (r.includes('BET'))        return 'BET';
  if (r.includes('WIN'))        return 'WIN';
  if (r.includes('REFUND'))     return 'REFUND';
  if (r.includes('BONUS'))      return 'BONUS';
  if (r.includes('REFERRAL') || r.includes('COMMISSION')) return 'REFERRAL';
  if (r.includes('ADJUST'))     return 'ADJUSTMENT';
  if (r.includes('EXCHANGE'))   return 'EXCHANGE';
  return 'ADJUSTMENT';
}

function mapOrderStatus(raw: string): TxStatus {
  const r = raw.toUpperCase();
  if (['COMPLETED', 'DONE', 'SUCCESS'].includes(r))          return 'COMPLETED';
  if (['FAILED', 'REJECTED', 'EXPIRED'].includes(r))         return 'FAILED';
  if (['CANCELLED', 'CANCELED'].includes(r))                 return 'CANCELLED';
  if (['DISPUTED'].includes(r))                              return 'DISPUTED';
  if (['PROCESSING', 'VERIFYING', 'MERCHANT_ACCEPTED'].includes(r)) return 'PROCESSING';
  return 'PENDING';
}
