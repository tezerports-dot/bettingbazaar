// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * staffContactShield.js — what a staff account that is not a full admin may
 * never be sent (owner, 2026-10-21: "only a full admin can know users details
 * and their records"; CLAUDE.md §24).
 *
 * A sub-admin, a dispute manager and a queue manager work orders, disputes and
 * people without their contact or payout details: no mobile (not even masked
 * digits), no email, no Telegram handle, no account number, IFSC or UPI ID,
 * no link built from one, and every mobile written into free text hidden.
 * Names stay: the holder's and the bank's name are what a dispute is judged by.
 *
 * Applied at the doors rather than in each route, so a route added later is
 * covered without remembering to: every `/api/admin` JSON answer
 * (`shieldContactForStaff`, routes/admin/index.js), every workbook
 * (`sendXlsx`, by `res.req.user`) and every staff stream event
 * (`sseManager._localBroadcastToAdmins`). A full admin gets everything.
 */
import { hideMobiles } from './mobileInText.js';

/** Keys whose value is contact or payout detail, in every spelling the routes send. */
export const CONTACT_KEYS = Object.freeze(new Set([
  'mobile', 'phone', 'email', 'telegramUsername', 'telegram_username',
  'userMobile', 'user_mobile', 'merchantMobile', 'merchant_mobile', 'userPhone', 'merchantPhone',
  'accountNumber', 'accountNo', 'account_number', 'ifscCode', 'ifsc', 'ifsc_code',
  'upiId', 'upi_id', 'upiPa', 'payoutUpiLink', 'paymentLink', 'cashLink', 'cash_link',
  'walletAddress', 'wallet_address',
]));

/** Keys whose value is text somebody typed: shown, with any mobile in it hidden. */
export const FREE_TEXT_KEYS = Object.freeze(new Set([
  'message', 'text', 'body', 'content', 'note', 'notes', 'reason', 'description', 'comment',
  'disputeReason', 'resolutionNote', 'subject',
]));

/**
 * Keys holding the PLATFORM's own published contact (the Support page's
 * WhatsApp, email and phone), which a sub-admin with the content area edits:
 * passed whole, never a person's details.
 */
export const PLATFORM_CONTACT_KEYS = Object.freeze(new Set(['supportLinks']));

/** Whether this staff viewer may be sent contact and payout details. */
export function seesContact(user) {
  return user?.isAdmin === true;
}

/** `value` with every contact key removed and free text's mobiles hidden, at any depth. */
export function shieldContact(value) {
  if (Array.isArray(value)) return value.map(shieldContact);
  if (value === null || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (CONTACT_KEYS.has(key)) continue;
    if (PLATFORM_CONTACT_KEYS.has(key)) { out[key] = v; continue; }
    out[key] = FREE_TEXT_KEYS.has(key) && typeof v === 'string' ? hideMobiles(v) : shieldContact(v);
  }
  return out;
}

/** A workbook with the contact columns and keys taken out of every table. */
export function shieldWorkbook(workbook) {
  return {
    ...workbook,
    sheets: (workbook.sheets || []).map((sheet) => ({
      ...sheet,
      tables: (sheet.tables || []).map((table) => ({
        ...table,
        columns: (table.columns || []).filter((c) => !CONTACT_KEYS.has(c.key)),
        rows: shieldContact(table.rows || []),
      })),
    })),
  };
}

/**
 * Express middleware for the staff router: a viewer who is not a full admin
 * has every JSON answer shielded. Mounted after `authenticateStaff`.
 */
export function shieldContactForStaff(req, res, next) {
  if (seesContact(req.user)) return next();
  const json = res.json.bind(res);
  res.json = (body) => json(shieldContact(body));
  return next();
}
