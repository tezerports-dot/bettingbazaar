// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The private-store KEY survives the mirror. Against real Postgres, because the
 * property being tested is an ON CONFLICT rule, not a code shape.
 *
 * `mirrorUserKyc` is called with two very different arguments:
 *
 *   • the adoption sweep passes a WHOLE User document, keys included;
 *   • the reconcile repair path passes a PARTIAL one — reconcile.js selects
 *     only `kycStatus` and `kycData.rejectionReason` there, because status is
 *     what it is repairing.
 *
 * With a plain `SET id_proof_key = EXCLUDED.id_proof_key`, the second call
 * writes NULL over a key the first call stored. The failure is silent and
 * delayed: the row still exists, the status is right, and nobody notices until
 * a reviewer opens the submission weeks later and there is no document to show
 * — indistinguishable, at that point, from an upload that never happened.
 *
 * So the rule is ABSENT MEANS UNCHANGED for the document references, and
 * last-write-wins for status and rejection_reason, where clearing is
 * meaningful (an approval legitimately empties the reason).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import { mirrorUserKyc } from '../../postgres/dualWrite.js';
import { KYC_STATES } from '../../postgres/kycPg.js';

if (process.env.CI && !pgConfigured()) {
  throw new Error('kycDocumentKeyMirror.test.js: DATABASE_URL is unset in CI — this suite must not skip silently.');
}
const describePg = pgConfigured() ? describe : describe.skip;

const KEY_ID = 'kyc/u-doc-1/id_proof/1700000000000-aaaabbbbccccddddeeeeffff00001111.jpg';
const KEY_PHOTO = 'kyc/u-doc-1/photo/1700000000000-11112222333344445555666677778888.jpg';

const row = async (userId) => (await pgQuery('SELECT * FROM user_kyc WHERE user_id = $1', [userId])).rows[0];

describePg('KYC document keys through the dual-write mirror', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE kyc_transitions, user_kyc RESTART IDENTITY CASCADE');
  });

  it('carries both keys from the User document into user_kyc', async () => {
    await mirrorUserKyc({
      _id: 'u-doc-1',
      kycStatus: KYC_STATES.PENDING_APPROVAL,
      kycData: {
        nameOnAadhaar: 'A PERSON', idProofKey: KEY_ID, photoKey: KEY_PHOTO,
        submittedAt: new Date(), rejectionReason: '',
      },
    });

    expect(await row('u-doc-1')).toMatchObject({
      id_proof_key: KEY_ID, photo_key: KEY_PHOTO,
      // Nothing writes a public URL any more. A row created after the cutover
      // has none, which is what "the document is private" looks like in the
      // database.
      id_proof_url: null, photo_url: null,
    });
  });

  it('does NOT lose the keys when the repair path mirrors a partial document', async () => {
    await mirrorUserKyc({
      _id: 'u-doc-1', kycStatus: KYC_STATES.PENDING_APPROVAL,
      kycData: { idProofKey: KEY_ID, photoKey: KEY_PHOTO, submittedAt: new Date() },
    });

    // Exactly the shape reconcile.js:repairKyc passes: status and reason only.
    await mirrorUserKyc({
      _id: 'u-doc-1', kycStatus: KYC_STATES.REJECTED,
      kycData: { rejectionReason: 'Aadhaar card is not legible' },
    });

    const after = await row('u-doc-1');
    expect(after.kyc_status).toBe(KYC_STATES.REJECTED);
    expect(after.rejection_reason).toBe('Aadhaar card is not legible');
    // The documents are still openable. This is the assertion the whole file
    // exists for.
    expect(after.id_proof_key).toBe(KEY_ID);
    expect(after.photo_key).toBe(KEY_PHOTO);
    expect(after.submitted_at).not.toBeNull();
  });

  it('still lets a resubmission replace the keys', async () => {
    // Absent means unchanged; PRESENT means replace. Otherwise a user who
    // resubmitted after a rejection would be reviewed against the document
    // that got them rejected.
    await mirrorUserKyc({
      _id: 'u-doc-1', kycStatus: KYC_STATES.REJECTED,
      kycData: { idProofKey: KEY_ID, photoKey: KEY_PHOTO },
    });

    const NEW_KEY = 'kyc/u-doc-1/id_proof/1700000009999-99998888777766665555444433332222.jpg';
    await mirrorUserKyc({
      _id: 'u-doc-1', kycStatus: KYC_STATES.PENDING_APPROVAL,
      kycData: { idProofKey: NEW_KEY, photoKey: KEY_PHOTO },
    });

    expect((await row('u-doc-1')).id_proof_key).toBe(NEW_KEY);
  });

  it('still clears a rejection reason on approval', async () => {
    // The document columns are preserved on absence; the reason is not, and
    // must not be — an approved user showing a stale "rejected because…" is a
    // support ticket every time.
    await mirrorUserKyc({
      _id: 'u-doc-1', kycStatus: KYC_STATES.REJECTED,
      kycData: { idProofKey: KEY_ID, rejectionReason: 'Blurry' },
    });
    await mirrorUserKyc({
      _id: 'u-doc-1', kycStatus: KYC_STATES.APPROVED, kycData: { idProofKey: KEY_ID },
    });

    expect(await row('u-doc-1')).toMatchObject({
      kyc_status: KYC_STATES.APPROVED, rejection_reason: null, id_proof_key: KEY_ID,
    });
  });

  it('keeps a pre-cutover row readable', async () => {
    // Records written before the private store have a public URL and no key.
    // The URL columns are not dropped, so those submissions can still be
    // reviewed — and the admin route says plainly that the document predates
    // the private store rather than reporting it missing.
    await mirrorUserKyc({
      _id: 'u-legacy', kycStatus: KYC_STATES.PENDING_APPROVAL,
      kycData: { idProofUrl: 'https://cdn.example/old.jpg', photoUrl: 'https://cdn.example/old2.jpg' },
    });

    expect(await row('u-legacy')).toMatchObject({
      id_proof_url: 'https://cdn.example/old.jpg', id_proof_key: null,
    });
  });
});
