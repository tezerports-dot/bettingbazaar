// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * putDocumentObject is the server-side KYC upload (used by the public-CDN →
 * private-bucket migration). It must enforce the SAME rules as the user-facing
 * presigned path BEFORE any byte reaches storage: identity documents are images
 * only, of a known type, or the write is refused. A migration that let a PDF or
 * an executable land under a `kyc/<user>/id_proof/...` key would defeat the
 * point of the private bucket. These guards run before s3().send(), so no real
 * storage is touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const KYC_ENV = ['KYC_S3_BUCKET', 'KYC_S3_ENDPOINT', 'KYC_S3_ACCESS_KEY', 'KYC_S3_SECRET_KEY'];

describe('putDocumentObject — server-side upload guards', () => {
  const saved = {};
  beforeEach(() => { for (const k of KYC_ENV) saved[k] = process.env[k]; vi.resetModules(); });
  afterEach(() => { for (const k of KYC_ENV) (saved[k] === undefined ? delete process.env[k] : process.env[k] = saved[k]); });

  it('refuses when the private bucket is not configured', async () => {
    for (const k of KYC_ENV) delete process.env[k];
    const { putDocumentObject } = await import('../../services/kycDocuments.service.js');
    await expect(putDocumentObject({ userId: 'u1', docType: 'id_proof', contentType: 'image/jpeg', body: Buffer.from('x') }))
      .rejects.toThrow(/not configured/i);
  });

  describe('with a configured bucket', () => {
    beforeEach(() => { for (const k of KYC_ENV) process.env[k] = 'dummy'; });

    it('rejects a non-image content type before touching storage', async () => {
      const { putDocumentObject } = await import('../../services/kycDocuments.service.js');
      await expect(putDocumentObject({ userId: 'u1', docType: 'id_proof', contentType: 'application/pdf', body: Buffer.from('x') }))
        .rejects.toThrow(/must be an image/i);
    });

    it('rejects an unknown document type', async () => {
      const { putDocumentObject } = await import('../../services/kycDocuments.service.js');
      await expect(putDocumentObject({ userId: 'u1', docType: 'passport', contentType: 'image/jpeg', body: Buffer.from('x') }))
        .rejects.toThrow(/unknown kyc document type/i);
    });

    it('rejects an oversized document', async () => {
      const { putDocumentObject } = await import('../../services/kycDocuments.service.js');
      const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1);
      await expect(putDocumentObject({ userId: 'u1', docType: 'id_proof', contentType: 'image/png', body: tooBig }))
        .rejects.toThrow(/between 1 byte and/i);
    });
  });
});
