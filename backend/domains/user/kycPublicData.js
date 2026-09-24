// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The public KYC projection, shared by the auth, session and user routes.
 *
 * KYC documents and PII stay private after submission; the ONE thing a rejected
 * player is entitled to is the reason, because §2 lets them replace a REJECTED
 * Aadhaar and a resubmission with no idea what was wrong is the same
 * submission again.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IT READ A FIELD NOTHING WRITES, AND SO IT NEVER ONCE SHOWED A REASON
 * ══════════════════════════════════════════════════════════════════════════
 * This was `user?.kycData?.rejectionReason` — a field on the USERS row. There
 * is no `kyc_data` column on `users` and the repository's projection has never
 * carried one, so the expression was `undefined` for every player who has ever
 * been rejected, and this function returned `null` every time.
 *
 * Everything around it worked. `decideKyc` REFUSES a rejection with no reason
 * — "it is what the user is shown" — and writes it to `user_kyc` in the same
 * transaction as the status. The admin screen collects it. Three call sites
 * render it. The value simply never crossed from the row that holds it to the
 * one that was being read.
 *
 * Measured, on a running server: a player rejected with "The Aadhaar number did
 * not match the name on file." read `kycStatus: REJECTED` and `kycData: null`
 * on login, on `/me`, and on their profile. §32 S4 — a consumer outliving its
 * producer — and §32 S14 on top of it: a refusal nobody can act on.
 *
 * ── Why it reads the kyc row rather than widening `getUser` ────────────────
 * `getUser` runs on EVERY authenticated request. Joining `user_kyc` into it
 * would tax every one of them to serve a field only a rejected player has. The
 * early return below means the extra read happens only in the REJECTED case,
 * which is rare and is the only case that needs it.
 */
import { db } from '#db';

/**
 * @param {{userId: string, kycStatus: string}} user a users row
 * @returns {Promise<{rejectionReason: string}|null>}
 */
export async function buildPublicKycData(user) {
  if (user?.kycStatus !== 'REJECTED') return null;
  // `user_kyc` is where the decision wrote it. Reading the producer's own table
  // is what stops this drifting again.
  const kyc = await db.kyc.getKyc(user.userId).catch(() => null);
  return kyc?.rejectionReason ? { rejectionReason: kyc.rejectionReason } : null;
}
