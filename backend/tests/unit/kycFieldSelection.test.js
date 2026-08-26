// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The KYC mirror projection is one MongoDB will actually accept.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 * A `select: false` path has to be named for a query to get it, and the obvious
 * way to write that is
 *
 *     .select('kycStatus kycData +kycData.someHiddenField')
 *
 * which compiles to `{kycStatus: 1, kycData: 1, 'kycData.someHiddenField': 1}`.
 * **MongoDB 4.4+ refuses a projection containing both a path and its prefix** —
 * "Path collision at kycData.someHiddenField". It throws at query time, against
 * a real server only. The Postgres suite runs no Mongo queries, so it passed;
 * CI's integration step was the first thing that ran it, and it failed there.
 *
 * A source-text assertion would not have caught this: the string looks right.
 * What is checked here is the PROJECTION Mongoose actually builds — the same
 * object the driver would send.
 *
 * The document keys that originally triggered this are gone with the upload
 * path, but the algebra is unchanged and the next hidden field will hit it, so
 * the probe schema below keeps one to test against.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { KYC_MIRROR_SELECT } from '../../domains/user/kycFieldSelection.js';

/**
 * The real kycData shape plus one `select: false` path to exercise the rule.
 * Declared here rather than importing user.model.js, which pulls in the
 * dual-write hooks and a Postgres client; what matters is the projection
 * algebra, and it is driven entirely by the select flags below.
 */
const schema = new mongoose.Schema({
  kycStatus: String,
  kycData: {
    submittedAt: Date,
    rejectionReason: String,
    reviewedBy: mongoose.Schema.Types.ObjectId,
    reviewedAt: Date,
    hiddenProbe: { type: String, select: false },
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
    // The test's own instrument. Without this, a `collisions()` that always
    // returned [] would make every assertion below pass.
    const bad = projectionFor('kycStatus kycData +kycData.hiddenProbe');
    expect(bad).toMatchObject({ kycData: 1, 'kycData.hiddenProbe': 1 });
    expect(collisions(bad)).toContain('kycData collides with kycData.hiddenProbe');
  });
});

describe('KYC_MIRROR_SELECT — the adoption sweep', () => {
  const projection = projectionFor(KYC_MIRROR_SELECT);

  it('names no parent alongside its child', () => {
    expect(collisions(projection)).toEqual([]);
    expect(projection).not.toHaveProperty('kycData');
  });

  it('brings every field the mirror writes', () => {
    for (const f of ['submittedAt', 'rejectionReason', 'reviewedBy', 'reviewedAt']) {
      expect(projection[`kycData.${f}`]).toBe(1);
    }
    expect(projection.kycStatus).toBe(1);
  });

  it('carries no identity data at all', () => {
    // The sweep is a bulk read over every user. Aadhaar numbers, names, PANs and
    // document references are not in kycData any more — they are in
    // KycVerification, reachable only through the audited bulk export — and
    // nothing should quietly put them back on this path.
    for (const gone of ['aadhaarNumber', 'nameOnAadhaar', 'nameOnPAN', 'panNumber',
                        'idProofKey', 'photoKey', 'idProofUrl', 'photoUrl']) {
      expect(KYC_MIRROR_SELECT).not.toContain(gone);
    }
  });
});
