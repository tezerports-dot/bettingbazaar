// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * KYC documents are PRIVATE — asserted at every layer that could republish one.
 *
 * `kycDocuments.test.js` proves the storage module's own safety logic. This
 * file proves the thing that was actually broken: that the ROUTES use it, and
 * that no KYC path can still produce a public CDN URL.
 *
 * The module has existed and been tested since Task H(b); nothing called it.
 * The upload route went to cdn.service, the submit route stored the resulting
 * public URL in `kycData.idProofUrl`, and the admin queue shipped that URL to
 * every reviewer's browser. A tested module that is not wired in protects
 * nothing, so what is asserted here is the WIRING.
 *
 * ── Why several of these read source text ───────────────────────────────────
 * The alternative is an HTTP integration test per route, which needs Mongo and
 * therefore only runs in CI. These properties are negative ("this file cannot
 * reach the public CDN"), and a negative is exactly what a source assertion
 * states well: it fails when someone adds a FOURTH call site the old way, which
 * is the regression worth catching. Behavioural coverage of the same paths runs
 * in the integration suite.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Source with COMMENTS REMOVED.
 *
 * Every negative below ("this file cannot reach the public CDN") is a claim
 * about code, and the files here explain at length what they no longer do — so
 * an assertion against raw text fails on the prose describing the fix. Three of
 * these did exactly that on the first run. Stripping comments is what makes
 * `not.toMatch(/cdnUrl/)` mean "does not use it" rather than "does not mention
 * it". Only whole-line and block comments go; `https://` inside a string is
 * left alone.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = (p) => stripComments(read(`../../${p}`));

// ── Storage module, with the SDK stubbed ────────────────────────────────────
const signed = [];
vi.mock('@aws-sdk/client-s3', () => {
  class Cmd { constructor(input) { this.input = input; this.name = new.target.name; } }
  return {
    S3Client: class { async send() { return { ContentType: 'image/jpeg', ContentLength: 1024 }; } },
    PutObjectCommand: class PutObjectCommand extends Cmd {},
    GetObjectCommand: class GetObjectCommand extends Cmd {},
    DeleteObjectCommand: class DeleteObjectCommand extends Cmd {},
    HeadObjectCommand: class HeadObjectCommand extends Cmd {},
  };
});
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_c, cmd, opts) => {
    signed.push({ cmd, opts });
    return `https://kyc.private.example/${cmd.input.Key}?X-Amz-Expires=${opts.expiresIn}`;
  },
}));

process.env.KYC_S3_BUCKET = 'bb-kyc-private';
process.env.KYC_S3_ENDPOINT = 'https://account.r2.cloudflarestorage.com';
process.env.KYC_S3_ACCESS_KEY = 'test-key';
process.env.KYC_S3_SECRET_KEY = 'test-secret';

const kycDocs = await import('../../services/kycDocuments.service.js');

beforeEach(() => { signed.length = 0; kycDocs._resetClient(); });

// ════════════════════════════════════════════════════════════════════════════
describe('a key names ONE document belonging to ONE user', () => {
  it('parses a key produced by the upload grant', async () => {
    const { key } = await kycDocs.presignUpload({
      userId: 'user-1', docType: 'id-proof', contentType: 'image/jpeg', fileSize: 2048,
    });
    // The route says `id-proof`; the key and the Postgres column say `id_proof`.
    // Mapping them in one place is what stops a third spelling appearing.
    expect(key).toMatch(/^kyc\/user-1\/id_proof\//);
    expect(kycDocs.parseKey(key)).toMatchObject({ userId: 'user-1', docType: 'id_proof' });
  });

  it('maps both spellings of every document type', () => {
    expect(kycDocs.normaliseDocType('id-proof')).toBe('id_proof');
    expect(kycDocs.normaliseDocType('selfie')).toBe('photo');
    expect(kycDocs.normaliseDocType('id_proof')).toBe('id_proof');
    expect(kycDocs.normaliseDocType('photo')).toBe('photo');
    expect(kycDocs.normaliseDocType('bank_statement')).toBeNull();
  });

  it('refuses anything that is not one of our keys', () => {
    for (const bad of [
      'branding/logo.png',          // another prefix
      '../../etc/passwd',           // traversal
      'kyc/u1/a.jpg',               // no document type segment
      'kyc/u1/id_proof/a/b.jpg',    // extra segment
      'kyc//id_proof/a.jpg',        // empty user
      'kyc/u1/bank_statement/a.jpg',// not a document type we issue
      '', null, undefined,
    ]) {
      expect(kycDocs.parseKey(bad)).toBeNull();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a key is checked against the user who submitted it', () => {
  // The key is the ONLY thing the submit route receives from the client. The
  // old CDN path checked `expectedUserId`; losing that check while moving to a
  // private bucket would trade one exposure for a worse one — user A submitting
  // user B's key, and a reviewer approving B's Aadhaar card as A's identity.
  const aliceKey = 'kyc/alice/id_proof/1-abc.jpg';

  it('refuses another user’s key on submission', async () => {
    await expect(kycDocs.verifyUploaded({ key: aliceKey, expectedUserId: 'bob' }))
      .rejects.toThrow(/belongs to another user/);
  });

  it('accepts the owner’s own key', async () => {
    const v = await kycDocs.verifyUploaded({ key: aliceKey, expectedUserId: 'alice' });
    expect(v).toMatchObject({ key: aliceKey, docType: 'id_proof' });
  });

  it('refuses a key submitted as the wrong document type', async () => {
    // Otherwise a selfie can be submitted as the ID proof and the reviewer sees
    // two selfies with nothing to compare against.
    await expect(kycDocs.verifyUploaded({
      key: aliceKey, expectedUserId: 'alice', expectedDocType: 'selfie',
    })).rejects.toThrow(/is a id_proof, not a photo/);
  });

  it('refuses to mint a review grant for a key that is not that user’s', async () => {
    // The admin route reads the key out of one user's record. If it does not
    // match, the record is wrong, and refusing beats showing a reviewer someone
    // else's identity document.
    await expect(kycDocs.presignReview({ key: aliceKey, expectedUserId: 'bob' }))
      .rejects.toThrow(/belongs to another user/);
    expect(signed).toHaveLength(0);
  });

  it('mints a short-lived grant for the right user', async () => {
    const g = await kycDocs.presignReview({ key: aliceKey, expectedUserId: 'alice' });
    expect(g.expiresIn).toBe(120);
    expect(signed[0].cmd.name).toBe('GetObjectCommand');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('the upload route cannot produce a public URL', () => {
  const source = src('routes/upload.routes.js');
  const kycBlock = source.slice(source.indexOf("router.post('/user/kyc/"), source.indexOf("router.post('/user/profile/picture/upload-url'"));

  it('routes KYC at the private store, not the CDN', () => {
    expect(kycBlock).toMatch(/kycDocuments\.presignUpload\(/);
    // The one line that mattered: the whole exposure came from this route
    // asking cdn.service for a `kyc/...` category and getting back a CDN URL.
    expect(kycBlock).not.toMatch(/cdnService/);
  });

  it('returns a key and no cdnUrl', () => {
    expect(kycBlock).toMatch(/key: grant\.key/);
    expect(kycBlock).not.toMatch(/cdnUrl/);
  });

  it('FAILS CLOSED when the private store is unconfigured', () => {
    // Every other upload category may degrade — a missing chat attachment is an
    // inconvenience. Here, "fall back to the old path" means publishing an
    // identity document, so the upload is refused instead.
    expect(kycBlock).toMatch(/if \(!kycDocuments\.configured\(\)\)/);
    expect(kycBlock).toMatch(/503/);
  });

  it('leaves the other upload categories on the public CDN', () => {
    // The private bucket is for identity documents. Sending branding images or
    // chat attachments through it would break the pages that render them and
    // put unrelated files under the KYC retention rules.
    expect(source).toMatch(/generateChatUploadUrl/);
    expect(source).toMatch(/generatePaymentProofUploadUrl/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('submission stores a reference, never a grant', () => {
  const source = src('domains/user/user.routes.js');

  it('cannot reach the public CDN at all', () => {
    // Stronger than "does not call it here": a module that never imports
    // cdn.service cannot publish an identity document by any future edit.
    expect(source).not.toMatch(/cdn\.service\.js/);
  });

  it('verifies both documents through the private store, with ownership', () => {
    expect([...source.matchAll(/kycDocuments\.verifyUploaded\(/g)]).toHaveLength(2);
    expect([...source.matchAll(/expectedUserId: req\.user\._id\.toString\(\)/g)]).toHaveLength(2);
    expect(source).toMatch(/expectedDocType: 'id-proof'/);
    expect(source).toMatch(/expectedDocType: 'selfie'/);
  });

  it('writes the KEY into kycData and no URL', () => {
    expect(source).toMatch(/idProofKey: idProof\.key/);
    expect(source).toMatch(/photoKey: photo\.key/);
    // The field that carried the permanent public grant into the database.
    expect(source).not.toMatch(/idProofUrl:/);
    expect(source).not.toMatch(/photoUrl:/);
  });

  it('refuses to submit when the private store is unconfigured', () => {
    expect(source).toMatch(/if \(!kycDocuments\.configured\(\)\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('the document reference does not leave the database by default', () => {
  const model = src('domains/user/user.model.js');
  const admin = src('routes/admin/kyc.admin.routes.js');

  it('marks both keys select:false, like aadhaarNumber', () => {
    // Several admin routes return whole user documents. A key that shipped by
    // default would put the document reference back into API responses,
    // browser history and support tickets — the shape of the original problem.
    expect(model).toMatch(/idProofKey: \{ type: String, select: false \}/);
    expect(model).toMatch(/photoKey:\s+\{ type: String, select: false \}/);
  });

  it('keeps the legacy URL fields out of responses too', () => {
    expect(model).toMatch(/idProofUrl: \{ type: String, select: false \}/);
    expect(model).toMatch(/photoUrl:\s+\{ type: String, select: false \}/);
  });

  it('projects the document fields out of the review queue', () => {
    expect(admin).toMatch(/-kycData\.idProofUrl -kycData\.photoUrl/);
  });

  it('mints the grant per view, behind canVerifyKYC, and audits it', () => {
    expect(admin).toMatch(/router\.get\('\/kyc\/:userId\/document\/:docType', authenticate, hasPermission\('canVerifyKYC'\)/);
    expect(admin).toMatch(/kycDocuments\.presignReview\(\{ key, expectedUserId/);
    expect(admin).toMatch(/KYC_DOCUMENT_VIEWED/);
  });

  it('audits the KEY, never the minted URL', () => {
    // An audit log is a store nobody deletes from. Recording the grant there
    // would put a live credential in the one place designed to be permanent.
    // Scoped to the audit call alone — the response below it legitimately
    // carries the URL, which is the entire point of the endpoint.
    const audit = admin.slice(admin.indexOf('EnhancedAuditLog'), admin.indexOf('catch (auditErr)'));
    expect(audit).toMatch(/metadata:\s+\{ docType, key \}/);
    expect(audit).not.toMatch(/grant\.url/);
    expect(audit).not.toMatch(/url/);
  });

  it('opts in explicitly where it genuinely needs the key', () => {
    expect(admin).toMatch(/\+kycData\.idProofKey \+kycData\.photoKey/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('the panels no longer hold a document URL', () => {
  const modal = stripComments(read('../../../user-panel/src/components/Modals/KYCModal.tsx'));
  const queue = stripComments(read('../../../admin-panel/src/Pages/KYC/KYCQueue.tsx'));

  it('the user panel submits keys only', () => {
    expect(modal).toMatch(/idProofKey: idProof\.key, photoKey: photo\.key/);
    expect(modal).not.toMatch(/cdnUrl/);
  });

  it('the user panel offers only the formats the store accepts', () => {
    // The picker offered `.pdf`, which the private store refuses — the user
    // waited for an upload that was always going to be rejected.
    expect(modal).toMatch(/accept="image\/jpeg,image\/png,image\/webp"/);
    expect(modal).not.toMatch(/\.pdf/);
  });

  it('the admin panel fetches a grant per document instead of reading one', () => {
    expect(queue).toMatch(/api\.kyc\.viewDocument\(userId, docType\)/);
    expect(queue).not.toMatch(/kycData\?\.idProofUrl/);
    expect(queue).not.toMatch(/kycData\?\.photoUrl/);
  });

  it('the admin panel drops the image when the grant expires', () => {
    // Otherwise a decoded identity document sits in the DOM behind a dead link
    // for as long as the tab is open.
    expect(queue).toMatch(/setTimeout\(\(\) => setGrant\(null\), grant\.expiresIn \* 1000\)/);
  });
});
