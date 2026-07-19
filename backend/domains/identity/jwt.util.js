// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Compatibility wrapper: JWT has been replaced by PASETO v2.public.
 * Keep the historical function names so the wider codebase does not need to
 * import token internals, while every issued token is now an Ed25519-signed
 * PASETO without an algorithm header.
 */
export {
  signToken,
  verifyPaseto as verifyJwt,
  tryVerifyPaseto as tryVerifyJwt,
  decodeTokenClaims,
  PASETO_EXPIRES_IN as JWT_EXPIRES_IN,
  PASETO_ISSUER as JWT_ISSUER,
  PASETO_AUDIENCE as JWT_AUDIENCE,
  PASETO_PUBLIC_KEY,
} from './paseto.util.js';

// Deprecated compatibility export. Do not use for signing or verification.
export const JWT_SECRET = process.env.PASETO_SECRET_KEY || process.env.JWT_SECRET;
export const ENFORCE_CLAIMS = true;
