// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The KYC projections are ones MongoDB will actually accept.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 * Making `kycData.idProofKey` and `kycData.photoKey` `select: false` meant every
 * query that wants them has to say so, and the obvious way to write that is
 *
 *     .select('kycStatus kycData +kycData.idProofKey')
 *
 * which compiles to `{kycStatus: 1, kycData: 1, 'kycData.idProofKey': 1}`.
 * **MongoDB 4.4+ refuses a projection containing both a path and its prefix** —
 * "Path collision at kycData.idProofKey". It throws at query time, against a
 * real server only. The Postgres suite runs no Mongo queries, so it passed;
 * CI's integration step was the first thing that ran it, and it failed there.
 *
 * A source-text assertion would not have caught this: the string looks right.
 * What is checked here is the PROJECTION Mongoose actually builds from the real
 * schema — the same object the driver would send.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { KYC_MIRROR_SELECT, KYC_DOCUMENT_KEY_SELECT } from '../../domains/user/kycFieldSelection.js';

/**
 * The real kycData shape, including which paths are `select: false`. Declared
 * here rather than importing user.model.js, which pulls in the dual-write hooks
 * and a Postgres client; what matters is the projection algebra, and it is
 * driven entirely by the select flags below.
 */
const schema = new mongoose.Schema({
  kycStatus: String,
  kycData: {
    nameOnAadhaar: String,
    aadhaarNumber: { type: String, select: false },
    nameOnPAN: String,
    panNumber: String,
    idProofKey: { type: String, select: false },
    photoKey:   { type: String, select: false },
    idProofUrl: { type: String, select: false },
    photoUrl:   { type: String, select: false },
    submittedAt: Date,
    rejectionReason: String,
  },
});
const User = mongoose.models.KycSelectionProbe || mongoose.model('KycSelectionProbe', schema);

/** The projection Mongoose would send for a select string. No connection needed. */
function projectionFor(select) {
  const q = User.find({}).select(select);
  q._applyPaths();
  return q._fields ?? {};
}

/** MongoDB's rule: no key may be a prefix of another key. */
function collisions(projection) {
  const keys = Object.keys(projection);
  const found = [];
  for (const a of keys) {
    for (const b of keys) {
      if (a !== b && b.startsWith(`${a}.`)) found.push(`${a} collides with ${b}`);
    }
  }
  return found;
}

describe('the projection algebra itself', () => {
  it('detects the collision that broke CI', () => {
    // The test's own instrument, checked against the exact string that failed.
    // Without this, a `collisions()` that always returned [] would make every
    // assertion below pass.
    const bad = projectionFor('kycStatus kycData +kycData.idProofKey +kycData.photoKey');
    expect(bad).toMatchObject({ kycData: 1, 'kycData.idProofKey': 1 });
    expect(collisions(bad)).toContain('kycData collides with kycData.idProofKey');
  });
});

describe('KYC_MIRROR_SELECT — the adoption sweep', () => {
  const projection = projectionFor(KYC_MIRROR_SELECT);

  it('names no parent alongside its child', () => {
    expect(collisions(projection)).toEqual([]);
    expect(projection).not.toHaveProperty('kycData');
  });

  it('brings the document keys, which are select:false', () => {
    // The whole reason the sweep needed changing: without these the mirror
    // writes a null key and an admin cannot open a document that exists.
    expect(projection['kycData.idProofKey']).toBe(1);
    expect(projection['kycData.photoKey']).toBe(1);
  });

  it('brings every other field the mirror writes', () => {
    for (const f of ['nameOnAadhaar', 'nameOnPAN', 'panNumber', 'submittedAt', 'rejectionReason']) {
      expect(projection[`kycData.${f}`]).toBe(1);
    }
    expect(projection.kycStatus).toBe(1);
  });

  it('keeps the legacy URL fields, so a pre-cutover record stays mirrorable', () => {
    expect(projection['kycData.idProofUrl']).toBe(1);
    expect(projection['kycData.photoUrl']).toBe(1);
  });

  it('still does NOT pull the Aadhaar number into a bulk sweep', () => {
    // It was never in this sweep — it is select:false and the old query asked
    // for the parent. Adding it would change what `pan_number` stores and put
    // an identity number in a batch read; that is a decision, not a side
    // effect of fixing a projection.
    expect(projection).not.toHaveProperty('kycData.aadhaarNumber');
  });
});

describe('KYC_DOCUMENT_KEY_SELECT — the admin review endpoint', () => {
  const projection = projectionFor(KYC_DOCUMENT_KEY_SELECT);

  it('returns the two keys and nothing else', () => {
    // Minting one short-lived grant does not require the rest of a user
    // document, and every extra field is one more place the reference travels.
    expect(collisions(projection)).toEqual([]);
    expect(projection['kycData.idProofKey']).toBe(1);
    expect(projection['kycData.photoKey']).toBe(1);
    expect(Object.keys(projection).filter((k) => !k.startsWith('kycData.'))).toEqual([]);
  });

  it('does not use the `+` spelling as well as the plain one', () => {
    // Naming a select:false leaf in an inclusive projection is what includes
    // it. Writing both spellings is how the collision gets reintroduced.
    expect(KYC_DOCUMENT_KEY_SELECT).not.toMatch(/\+/);
  });
});
