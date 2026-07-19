// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


export const PAYMENT_STATES = [
  'PENDING_QUEUE',
  'ASSIGNED',
  'PROCESSING',
  'PAID',
  'COMPLETED',
  'DISPUTED',
  'REJECTED',
  'FAILED',
  'CANCELLED',
] as const;

export type PaymentOrderState = typeof PAYMENT_STATES[number];

/** States where the order is still active (UI should poll or listen via SSE) */
export const ACTIVE_STATES: PaymentOrderState[] = [
  'PENDING_QUEUE', 'ASSIGNED', 'PROCESSING', 'PAID', 'DISPUTED',
];

/** States where the order is terminal (UI stops polling) */
export const TERMINAL_STATES: PaymentOrderState[] = [
  'COMPLETED', 'REJECTED', 'FAILED', 'CANCELLED',
];

/** Human-readable labels for display */
export const PAYMENT_STATE_LABELS: Record<PaymentOrderState, string> = {
  PENDING_QUEUE: 'Waiting for Merchant',
  ASSIGNED:      'Merchant Assigned — Submit Payment',
  PROCESSING:    'Payment Processing',
  PAID:          'Payment Submitted — Awaiting Merchant Review',
  COMPLETED:     'Completed',
  DISPUTED:      'Under Dispute',
  REJECTED:      'Order Rejected',
  FAILED:        'Order Failed',
  CANCELLED:     'Cancelled',
};

/** Colour token for badge rendering */
export const PAYMENT_STATE_COLOR: Record<PaymentOrderState, 'yellow' | 'blue' | 'green' | 'red' | 'orange'> = {
  PENDING_QUEUE: 'yellow',
  ASSIGNED:      'blue',
  PROCESSING:    'orange',
  PAID:          'orange',
  COMPLETED:     'green',
  DISPUTED:      'red',
  REJECTED:      'red',
  FAILED:        'red',
  CANCELLED:     'red',
};

export function isActive(state: PaymentOrderState):   boolean { return ACTIVE_STATES.includes(state); }
export function isTerminal(state: PaymentOrderState): boolean { return TERMINAL_STATES.includes(state); }

/** Show UTR + screenshot evidence panel */
export function evidencePanelVisible(state: PaymentOrderState): boolean {
  return ['ASSIGNED', 'PROCESSING'].includes(state);
}

/** Show merchant snapshot payment details */
export function paymentDetailsPanelVisible(state: PaymentOrderState): boolean {
  return ['ASSIGNED', 'PROCESSING', 'PAID'].includes(state);
}


