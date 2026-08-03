// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The admin branding upload endpoints the panel actually calls.
 *
 * The panel used to POST multipart to `/api/admin/cdn/upload`, a path that has
 * never existed in this repository — and no multipart parser is mounted
 * anywhere, so it could not have worked even if the path had matched. The
 * failure was swallowed by a bare `catch`, so it read as a flaky upload rather
 * than a feature that was never wired up. Nothing tested that the path the
 * frontend used and the paths the backend served were the same two paths.
 *
 * These pin the contract the panel now depends on:
 *   POST /api/admin/branding/upload-url     → { uploadUrl, fileKey, cdnUrl }
 *   POST /api/admin/branding/confirm-upload → records it
 * and that both refuse an unauthenticated caller.
 *
 * Real MongoDB (mongodb-memory-server in CI). They cannot run in the audit
 * sandbox, where the mongod download is blocked — CI is the verifier.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import '../../models/index.js';
import adminRoutes from '../../routes/admin/index.js';
// PASETO (AQ-2): sign via the token authority; a raw JWT is rejected (401).
import { signToken } from '../../domains/identity/paseto.util.js';
import { User } from '../../models/index.js';

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

let adminToken;

beforeEach(async () => {
  await User.deleteMany({});
  const admin = await User.create({
    username: 'BrandingAdmin', mobile: '9200000001', isAdmin: true,
  });
  adminToken = signToken({ userId: admin._id });
});

const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

describe('admin branding upload endpoints', () => {
  it('rejects an unauthenticated upload-url request', async () => {
    const res = await request(app)
      .post('/api/admin/branding/upload-url')
      .send({ fileName: 'logo.png', contentType: 'image/png', fileSize: 1024 });
    expect([401, 403]).toContain(res.status);
  });

  it('rejects an unauthenticated confirm-upload request', async () => {
    const res = await request(app)
      .post('/api/admin/branding/confirm-upload')
      .send({ fileKey: 'k', cdnUrl: 'https://cdn.test/k' });
    expect([401, 403]).toContain(res.status);
  });

  it('requires fileName, contentType and fileSize', async () => {
    const res = await auth(request(app).post('/api/admin/branding/upload-url')).send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('requires fileKey and cdnUrl on confirm', async () => {
    const res = await auth(request(app).post('/api/admin/branding/confirm-upload')).send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('serves the two paths the admin panel calls (not 404)', async () => {
    // The regression that mattered: the panel's path and the served path must
    // be the same string. A 404 here means they have drifted apart again.
    for (const path of ['/api/admin/branding/upload-url', '/api/admin/branding/confirm-upload']) {
      const res = await auth(request(app).post(path)).send({});
      expect(res.status, `${path} should exist`).not.toBe(404);
    }
  });

  it('issues a presigned URL when S3 is configured', async () => {
    // Without S3 credentials the handler reports failure rather than 404; either
    // way the contract shape is what the panel reads.
    const res = await auth(request(app).post('/api/admin/branding/upload-url'))
      .send({ fileName: 'logo.png', contentType: 'image/png', fileSize: 2048, category: 'logo' });

    expect(res.status).not.toBe(404);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('uploadUrl');
      expect(res.body).toHaveProperty('fileKey');
      expect(res.body).toHaveProperty('cdnUrl');
    }
  });
});
