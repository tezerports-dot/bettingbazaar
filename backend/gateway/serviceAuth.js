// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * gateway/serviceAuth.js — service-to-service authentication (CAP-73).
 * Unit-tested in backend/tests/unit/serviceAuth.test.js.
 *
 * WHY (hybrid roadmap): inside the monolith, domains call each other by direct
 * import — the process boundary IS the trust boundary, so there is nothing to
 * authenticate. The MOMENT a domain is extracted to a remote service, those
 * calls cross the network and MUST be authenticated, or any pod on the network
 * could call "wallet.debit". This module is that seam: short-lived, signed
 * service tokens (mTLS is the infra-layer complement — see docs/governance/04-GOVERNANCE.md).
 *
 * Design (mirrors the user-JWT hardening in domains/identity/jwt.util.js):
 *   - HS256 pinned (alg confusion rejected), NOT "none".
 *   - iss = calling service, aud = called service (a token minted for "wallet"
 *     is rejected by "payment") — blast-radius containment.
 *   - Very short TTL (default 60s): these are per-call credentials, not sessions.
 *   - Dedicated SERVICE_JWT_SECRET; falls back to JWT_SECRET so single-process
 *     dev works, but a real mesh MUST set a distinct secret (key separation).
 *
 * Dormant in the monolith: nothing calls mintServiceToken until a domain is
 * remote. requireServiceAuth is the guard you put on a service's internal API.
 */
import jwt from 'jsonwebtoken';

const ALG = 'HS256';
const DEFAULT_TTL = '60s';
const ISS_PREFIX = 'svc:';

function secret() {
  const s = process.env.SERVICE_JWT_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('serviceAuth: neither SERVICE_JWT_SECRET nor JWT_SECRET is set');
  return s;
}

/** Is a dedicated service secret configured (i.e. the mesh is provisioned)? */
export function serviceAuthConfigured() {
  return !!(process.env.SERVICE_JWT_SECRET && process.env.SERVICE_JWT_SECRET.trim());
}

/**
 * Mint a short-lived token for a call from `from` service to `to` service.
 * @param {{from:string, to:string, ttl?:string|number, claims?:object}} p
 * @returns {string} JWT
 */
export function mintServiceToken({ from, to, ttl = process.env.SERVICE_JWT_TTL || DEFAULT_TTL, claims = {} }) {
  if (!from || !to) throw new Error('mintServiceToken: from and to are required');
  return jwt.sign(
    { ...claims, svc: true },
    secret(),
    { algorithm: ALG, issuer: `${ISS_PREFIX}${from}`, audience: `${ISS_PREFIX}${to}`, expiresIn: ttl },
  );
}

/**
 * Verify a service token addressed to `audience` (the receiving service's name).
 * @returns {{ ok:true, from:string, payload:object } | { ok:false, error:string }}
 */
export function verifyServiceToken(token, audience) {
  if (!token) return { ok: false, error: 'missing token' };
  try {
    const payload = jwt.verify(token, secret(), {
      algorithms: [ALG],
      audience: `${ISS_PREFIX}${audience}`,
    });
    if (payload.svc !== true) return { ok: false, error: 'not a service token' };
    const from = String(payload.iss || '').startsWith(ISS_PREFIX) ? payload.iss.slice(ISS_PREFIX.length) : null;
    if (!from) return { ok: false, error: 'bad issuer' };
    return { ok: true, from, payload };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Express middleware guarding a service's INTERNAL API. `thisService` is the
 * name of the service mounting the guard (the expected audience). Reads the
 * bearer token from Authorization. Dormant until you actually expose an
 * internal API on a remote service.
 */
export function requireServiceAuth(thisService) {
  return (req, res, next) => {
    const hdr = req.headers?.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    const result = verifyServiceToken(token, thisService);
    if (!result.ok) return res.status(401).json({ success: false, message: `service auth failed: ${result.error}` });
    req.callingService = result.from;
    next();
  };
}
