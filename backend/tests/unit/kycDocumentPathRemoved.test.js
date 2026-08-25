// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * KYC no longer collects documents, and must not start again by accident.
 *
 * The old path presigned an Aadhaar card and a selfie into a private bucket and
 * had an admin look at them. Every control that made that defensible — the
 * separate bucket, the per-view expiring grant, the audit row on each view —
 * existed because the documents existed. Now they do not, and the strongest
 * version of that control is that there is nothing to protect.
 *
 * These are absence checks, which no feature test can make: a happy-path suite
 * for bulk verification passes perfectly well with an upload endpoint still
 * mounted next to it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const at = (p) => join(here, p);
const read = (p) => readFileSync(at(p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

describe('the document store is gone, not merely unused', () => {
  it('has no kycDocuments service left to import', () => {
    // While the module exists someone will wire it back in "just for the
    // exception case", and the private-bucket controls would come back with it.
    expect(existsSync(at('../../services/kycDocuments.service.js'))).toBe(false);
  });

  it('presigns no KYC upload', () => {
    const uploads = read('../../routes/upload.routes.js');
    expect(uploads).not.toMatch(/kycDocuments/);
    expect(uploads).not.toMatch(/user\/kyc\/:docType\/upload-url/);
  });

  it('serves no document to a reviewer', () => {
    const admin = read('../../routes/admin/kyc.admin.routes.js');
    expect(admin).not.toMatch(/document\/:docType/);
    expect(admin).not.toMatch(/presignReview/);
  });

  it('accepts no KYC submission from a signed-in player', () => {
    // The bot asks for the Aadhaar BEFORE the account exists, so verification is
    // a precondition of signing up rather than a step a player can skip. An
    // endpoint here would be a second way in with none of that ordering.
    const user = read('../../domains/user/user.routes.js');
    expect(user).not.toMatch(/router\.post\('\/user\/:userId\/kyc'/);
  });
});

describe('identity data is not on the User document', () => {
  const model = read('../../domains/user/user.model.js');

  it('holds no Aadhaar, name, PAN or document reference', () => {
    for (const gone of ['aadhaarNumber', 'nameOnAadhaar', 'nameOnPAN', 'panNumber',
                        'idProofKey', 'photoKey', 'idProofUrl', 'photoUrl']) {
      expect(model).not.toMatch(new RegExp(`\\b${gone}\\b`));
    }
  });

  it('holds no second Aadhaar hash', () => {
    // KycVerification.aadhaarHash is unique and is what enforces one account per
    // Aadhaar. A second hash on User would be a second answer to the same
    // question, and the two would disagree the first time one write failed.
    expect(model).not.toMatch(/aadhaarHash/);
  });

  it('declares reviewedBy, which the decision seam writes', () => {
    // It was absent while kycDecision.service.js and reverseMirror.js both set
    // `kycData.reviewedBy`. Mongoose drops an unknown path in strict mode
    // without erroring, so every approval stayed anonymous — the exact defect
    // that seam was written to fix, fixed at the write and never at the schema.
    expect(model).toMatch(/reviewedBy:\s*\{ type: mongoose\.Schema\.Types\.ObjectId/);
  });
});

describe('there is one KYC decision path', () => {
  it('admin.service.js no longer carries its own approve/reject/queue', () => {
    // A third implementation, with no callers, doing read-modify-write on a
    // stale read and logging raw Aadhaar numbers to an append-only audit store.
    const svc = read('../../services/admin.service.js');
    expect(svc).not.toMatch(/async approveKYC/);
    expect(svc).not.toMatch(/async rejectKYC/);
    expect(svc).not.toMatch(/async getKYCQueue/);
  });

  it('the admin routes still decide through the state machine', () => {
    // Removing duplicates must not remove the real one: this is the exception
    // path an operator needs when a batch got a case wrong.
    const admin = read('../../routes/admin/kyc.admin.routes.js');
    expect(admin).toMatch(/approveKyc\(user\._id/);
    expect(admin).toMatch(/rejectKyc\(user\._id/);
    expect(admin).not.toMatch(/user\.kycStatus = /);
  });
});

describe('the withdrawal order carries no phantom KYC snapshot', () => {
  it('does not build userKycSnapshot', () => {
    // Write-only three times over: both sanitizers deleted it before any
    // response, its `aadhaar` field was never a path on the PaymentOrder schema
    // so Mongoose dropped it, and the fields feeding it no longer exist.
    const proc = read('../../domains/payment/paymentProcessing.service.js');
    const model = read('../../domains/payment/paymentOrder.model.js');
    expect(proc).not.toMatch(/userKycSnapshot:/);
    expect(model).not.toMatch(/userKycSnapshot/);
  });
});
