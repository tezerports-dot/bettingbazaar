// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * presignedPutCarriesNoChecksum — a presigned upload URL must not carry a
 * checksum. With the SDK's default (WHEN_SUPPORTED) it carried
 * `x-amz-checksum-crc32=AAAAAA==`, the CRC32 of an empty body, so the storage
 * refused every real image the browser PUT (cdn.service.js, S3 client).
 */
import { describe, it, expect, beforeAll } from 'vitest';

let cdn;
beforeAll(async () => {
  Object.assign(process.env, {
    S3_BUCKET_NAME: process.env.S3_BUCKET_NAME || 'test-bucket',
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY || 'test-key',
    S3_SECRET_KEY: process.env.S3_SECRET_KEY || 'test-secret',
    S3_ENDPOINT: process.env.S3_ENDPOINT || 'https://storage.example.test',
    CDN_URL: process.env.CDN_URL || 'https://cdn.example.test',
  });
  cdn = await import('../../services/cdn.service.js');
});

describe('presignedPutCarriesNoChecksum', () => {
  it('a branding image upload URL has no checksum parameters', async () => {
    const { uploadUrl } = await cdn.generateBrandingUploadUrl('logo.png', 'image/png', 2048, 'u1', 'logo');
    const params = [...new URL(uploadUrl).searchParams.keys()].map((k) => k.toLowerCase());
    expect(params.filter((k) => k.startsWith('x-amz-checksum') || k === 'x-amz-sdk-checksum-algorithm')).toEqual([]);
    expect(params).toContain('x-amz-signature');
  });
});

describe('presignedPutSignsItsOwner', () => {
  it('sends the owner as signed headers, never as query parameters (R2 stores none given that way)', async () => {
    const { uploadUrl, uploadHeaders } = await cdn.generateBrandingUploadUrl('logo.png', 'image/png', 2048, 'u1', 'logo');
    const url = new URL(uploadUrl);
    const params = [...url.searchParams.keys()].map((k) => k.toLowerCase());
    expect(params.filter((k) => k.startsWith('x-amz-meta-'))).toEqual([]);
    const signed = url.searchParams.get('X-Amz-SignedHeaders').split(';');
    expect(signed).toEqual(expect.arrayContaining(['x-amz-meta-userid', 'x-amz-meta-declaredmime']));
    expect(uploadHeaders).toMatchObject({ 'Content-Type': 'image/png', 'x-amz-meta-userid': 'u1' });
    for (const name of signed.filter((h) => h.startsWith('x-amz-meta-'))) expect(uploadHeaders[name]).toBeDefined();
  });
});
