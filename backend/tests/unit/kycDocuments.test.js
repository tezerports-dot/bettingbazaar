// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * KYC document storage — the SAFETY properties, not the SDK.
 *
 * What is asserted here is what distinguishes this store from the public CDN it
 * replaces: no ACL is ever set, review grants are short and bounded, only
 * images are accepted, and a key can never be mistaken for a URL. The S3 calls
 * themselves are the AWS SDK's problem.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sent = [];
const signed = [];
vi.mock('@aws-sdk/client-s3', () => {
  class Cmd { constructor(input) { this.input = input; this.name = new.target.name; } }
  return {
    S3Client: class { async send(cmd) { sent.push(cmd); return { ContentType: 'image/jpeg', ContentLength: 1024 }; } },
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

const {
  configured, presignUpload, presignReview, verifyUploaded, deleteDocument, _resetClient,
} = await import('../../services/kycDocuments.service.js');

beforeEach(() => { sent.length = 0; signed.length = 0; _resetClient(); });

describe('configuration', () => {
  it('reports configured when all four settings are present', () => {
    expect(configured()).toBe(true);
  });
});

describe('upload grants', () => {
  it('returns a KEY to store and a URL to use once', async () => {
    const r = await presignUpload({ userId: 'u1', docType: 'id_proof', contentType: 'image/jpeg', fileSize: 2048 });

    // The key is what every other layer handles. A key is a reference; a URL is
    // a grant, and grants do not belong in a database column.
    expect(r.key).toMatch(/^kyc\/u1\/id_proof\/\d+-[0-9a-f]{32}\.jpg$/);
    expect(r.uploadUrl).toContain(r.key);
    expect(r.expiresIn).toBe(300);
  });

  it('NEVER sets an ACL', async () => {
    // The single line that could make an identity document public. The bucket is
    // private and objects inherit that; an ACL here would override it.
    await presignUpload({ userId: 'u1', docType: 'photo', contentType: 'image/png', fileSize: 1024 });
    const put = signed[0].cmd;
    expect(put.name).toBe('PutObjectCommand');
    expect(put.input).not.toHaveProperty('ACL');
    expect(JSON.stringify(put.input)).not.toMatch(/public-read/);
  });

  it('pins the content type and length into the grant', async () => {
    // An upload grant that did not pin these would let a client take a grant for
    // a 2KB JPEG and upload a 2GB something-else.
    await presignUpload({ userId: 'u1', docType: 'id_proof', contentType: 'image/webp', fileSize: 4096 });
    expect(signed[0].cmd.input).toMatchObject({ ContentType: 'image/webp', ContentLength: 4096 });
  });

  it('accepts images only', async () => {
    for (const bad of ['application/pdf', 'application/zip', 'text/html', 'image/svg+xml']) {
      await expect(presignUpload({ userId: 'u1', docType: 'id_proof', contentType: bad, fileSize: 1024 }))
        .rejects.toThrow(/must be an image/);
    }
    expect(signed).toHaveLength(0);
  });

  it('refuses an implausible size and an unknown document type', async () => {
    await expect(presignUpload({ userId: 'u1', docType: 'id_proof', contentType: 'image/jpeg', fileSize: 0 }))
      .rejects.toThrow(/between 1 byte/);
    await expect(presignUpload({ userId: 'u1', docType: 'id_proof', contentType: 'image/jpeg', fileSize: 50 * 1024 * 1024 }))
      .rejects.toThrow(/between 1 byte/);
    await expect(presignUpload({ userId: 'u1', docType: 'bank_statement', contentType: 'image/jpeg', fileSize: 1024 }))
      .rejects.toThrow(/Unknown KYC document type/);
  });

  it('namespaces by user, so an erasure request can enumerate one subject', async () => {
    const a = await presignUpload({ userId: 'alice', docType: 'id_proof', contentType: 'image/jpeg', fileSize: 10 });
    const b = await presignUpload({ userId: 'bob', docType: 'id_proof', contentType: 'image/jpeg', fileSize: 10 });
    expect(a.key.startsWith('kyc/alice/')).toBe(true);
    expect(b.key.startsWith('kyc/bob/')).toBe(true);
  });
});

describe('review grants', () => {
  it('is short-lived by default', async () => {
    const r = await presignReview({ key: 'kyc/u1/id_proof/1-abc.jpg' });
    expect(r.expiresIn).toBe(120);
    expect(signed[0].cmd.name).toBe('GetObjectCommand');
  });

  it('BOUNDS what a caller may ask for', async () => {
    // A "convenient" hour-long review link is the failure this replaces, in a
    // smaller form. Ten minutes is the ceiling however the caller asks.
    expect((await presignReview({ key: 'kyc/u1/id_proof/1-abc.jpg', expiresIn: 86_400 })).expiresIn).toBe(600);
    expect((await presignReview({ key: 'kyc/u1/id_proof/1-abc.jpg', expiresIn: 1 })).expiresIn).toBe(30);
    expect((await presignReview({ key: 'kyc/u1/id_proof/1-abc.jpg', expiresIn: 'forever' })).expiresIn).toBe(120);
  });

  it('refuses a key from outside the KYC namespace', async () => {
    // Otherwise this becomes a general-purpose read oracle for the bucket.
    for (const bad of ['branding/logo.png', '../../etc/passwd', '', null]) {
      await expect(presignReview({ key: bad })).rejects.toThrow(/Not a KYC document key/);
    }
  });
});

describe('verification and deletion', () => {
  it('confirms the object actually arrived', async () => {
    // A presigned PUT is a grant, not a promise. Storing the key without this
    // leaves a KYC record pointing at nothing, which a reviewer cannot
    // distinguish from a storage fault.
    const v = await verifyUploaded({ key: 'kyc/u1/id_proof/1-abc.jpg', contentType: 'image/jpeg' });
    expect(v).toMatchObject({ key: 'kyc/u1/id_proof/1-abc.jpg', size: 1024 });
    expect(sent[0].name).toBe('HeadObjectCommand');
  });

  it('refuses an object whose type does not match what was declared', async () => {
    await expect(verifyUploaded({ key: 'kyc/u1/id_proof/1-abc.jpg', contentType: 'image/png' }))
      .rejects.toThrow(/not the declared/);
  });

  it('deletes only within the KYC namespace', async () => {
    await deleteDocument('kyc/u1/id_proof/1-abc.jpg');
    expect(sent[0].name).toBe('DeleteObjectCommand');
    await expect(deleteDocument('branding/logo.png')).rejects.toThrow(/Not a KYC document key/);
  });
});
