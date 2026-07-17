// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import crypto from 'crypto';

function normalizedAadhaar(raw) {
  if (raw === undefined || raw === null) return null;
  const normalized = String(raw).replace(/[\s-]/g, '');
  return /^\d{12}$/.test(normalized) ? normalized : null;
}

function configuredSecrets() {
  const current = process.env.AADHAAR_HMAC_SECRET?.trim();
  if (!current) throw new Error('AADHAAR_HMAC_SECRET must be configured');
  const previous = (process.env.AADHAAR_HMAC_PREVIOUS_SECRETS || '')
    .split(',').map((secret) => secret.trim()).filter(Boolean);
  return [current, ...previous];
}

function hmac(normalized, secret) {
  return crypto.createHmac('sha256', secret).update(normalized).digest('hex');
}

export function hashAadhaar(raw) {
  const normalized = normalizedAadhaar(raw);
  return normalized ? hmac(normalized, configuredSecrets()[0]) : null;
}

// Compare against the current secret and retained rotation secrets. Rehashing
// legacy records with the active secret is handled by migrate-aadhaar-hashes.
export function hashAadhaarCandidates(raw) {
  const normalized = normalizedAadhaar(raw);
  return normalized ? configuredSecrets().map((secret) => hmac(normalized, secret)) : [];
}

