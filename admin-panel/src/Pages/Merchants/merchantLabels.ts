// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * UI names for the server's merchant role keys (database/repositories/
 * adminDirectory.js `MERCHANT_ROLES`). §11: labels only; the keys are the
 * server's, sent with every merchants-table answer as `roles`.
 */
export const ROLE_LABEL: Record<string, string> = {
  MERCHANT: 'Merchant', SUPERVISOR: 'Supervisor', AGENT: 'Agent', UNASSIGNED: 'Agent, no team',
};
