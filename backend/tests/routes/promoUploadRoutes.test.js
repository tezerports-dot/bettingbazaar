// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Promo slide image upload, over HTTP.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * ContentSlideManager.tsx has always had an "upload image" button that called
 * POST /api/admin/promo/upload-url, and that route did not exist. The presign
 * 404'd, the component's catch turned it into "Upload failed", and the only way
 * to publish a slide was to paste a URL to an image already hosted elsewhere.
 *
 * No test could have caught it. There was no handler to test — that is the
 * point: a route test proves a handler works, never that a button reaches it.
 * `npm run check:ui-coverage` is what catches the missing half; this file
 * covers the half that now exists.
 *
 * The cases below are the ones that decide whether a hostile upload reaches the
 * CDN origin. An SVG or an .html served from the same origin as the panels is
 * stored XSS, so a refusal here is a security control, not input tidying.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('promo upload-url route', () => {
  let app; let admin; let plainUser;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/cms/content.admin.routes.js');
    app = mountRouter(mod.default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
    plainUser = await actor({});
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const png = { fileName: 'slide.png', contentType: 'image/png', fileSize: 120_000 };

  it('exists — a signed-in admin does not get a 404', async () => {
    // The regression that started this: the path was never served at all.
    const res = await as(app, admin).post('/promo/upload-url').send(png);
    expect(res.status, JSON.stringify(res.body)).not.toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    expect((await request(app).post('/promo/upload-url').send(png)).status).toBe(401);
  });

  it('refuses a signed-in player', async () => {
    // Presigned PUT into the platform's own bucket is an admin capability.
    const res = await as(app, plainUser).post('/promo/upload-url').send(png);
    expect([401, 403]).toContain(res.status);
  });

  it('refuses an incomplete request', async () => {
    for (const body of [{}, { fileName: 'a.png' }, { ...png, fileSize: 0 }, { ...png, fileSize: 'big' }]) {
      const res = await as(app, admin).post('/promo/upload-url').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses a file over 5 MB before asking the CDN for anything', async () => {
    const res = await as(app, admin).post('/promo/upload-url').send({ ...png, fileSize: 6 * 1024 * 1024 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/5 MB/i);
  });

  it('refuses SVG and HTML — stored XSS served from the CDN origin', async () => {
    for (const [fileName, contentType] of [
      ['x.svg', 'image/svg+xml'], ['x.html', 'text/html'], ['x.js', 'application/javascript'],
    ]) {
      const res = await as(app, admin).post('/promo/upload-url').send({ fileName, contentType, fileSize: 1000 });
      expect(res.status, `${fileName} must be refused`).toBe(400);
    }
  });

  it('refuses an extension that disagrees with the declared MIME', async () => {
    // The claim and the name must agree, or the name decides what the CDN serves.
    const res = await as(app, admin).post('/promo/upload-url').send({
      fileName: 'payload.php', contentType: 'image/png', fileSize: 1000,
    });
    expect(res.status).toBe(400);
  });

  it('answers 503, not 500, when S3 is simply not configured', async () => {
    // A deployment without CDN credentials is a configuration state, not a
    // crash — the panel tells the operator to paste a URL instead.
    const res = await as(app, admin).post('/promo/upload-url').send(png);
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('uploadUrl');
      expect(res.body).toHaveProperty('cdnUrl');
    }
  });
});
