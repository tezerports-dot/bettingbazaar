// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * contentPg.test.js — the panels' content, against a real PostgreSQL.
 *
 * These cover the three rules the routes above them lean on and cannot check
 * themselves:
 *
 *   • the starter FAQ seeds once, and a second concurrent seed adds nothing;
 *   • a promo edit touches the fields the admin sent and no others;
 *   • an image something still points at cannot be deleted out from under it.
 *
 * Every one of them was a live defect before this pass: the seed was a
 * count-then-insert two admins could both pass, the promo update wrote every
 * column from its defaults, and the delete route reported success for an id
 * that was never there.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { applySchema, closePg, pgQuery } from '../client.js';
import {
  seedFaqs, listFaqs, upsertFaq, deleteFaq,
  upsertPromo, updatePromo, getPromo, listPromos, listLivePromos, deletePromo,
  addImage, listImages, adjustImageUsage, deleteImage,
} from '../repositories/content.js';

const STARTER = [
  { faqId: 'seed_a', question: 'A?', answer: 'a', category: 'payments' },
  { faqId: 'seed_b', question: 'B?', answer: 'b', category: 'gameplay' },
  { faqId: 'seed_c', question: 'C?', answer: 'c', category: 'account' },
];

describe('content', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('DELETE FROM faqs', []);
    await pgQuery('DELETE FROM promo_content', []);
    await pgQuery('DELETE FROM cdn_images', []);
  });

  // ── The FAQ seed ──────────────────────────────────────────────────────────
  it('seeds the starter FAQ into an empty table, once', async () => {
    expect(await seedFaqs(STARTER)).toBe(3);
    expect(await seedFaqs(STARTER)).toBe(0);
    expect((await listFaqs({ publishedOnly: false })).length).toBe(3);
  });

  it('does not seed on top of an FAQ an editor already wrote', async () => {
    await upsertFaq({ question: 'Only mine', answer: 'x' });
    expect(await seedFaqs(STARTER)).toBe(0);
    const faqs = await listFaqs({ publishedOnly: false });
    expect(faqs.map((f) => f.question)).toEqual(['Only mine']);
  });

  it('does not bring back a starter entry the admin deleted', async () => {
    await seedFaqs(STARTER);
    expect(await deleteFaq('seed_b')).toBe(true);
    // The table is not empty, so the guard holds and `seed_b` stays gone.
    expect(await seedFaqs(STARTER)).toBe(0);
    const ids = (await listFaqs({ publishedOnly: false })).map((f) => f.faqId);
    expect(ids).not.toContain('seed_b');
    expect(ids).toHaveLength(2);
  });

  it('seeds exactly one set when two admins open the page at once', async () => {
    // Both calls read an empty table; the fixed ids are what stops the second
    // from inserting a duplicate set. A generated id per row would have left
    // six FAQs here, which is what the count-then-insert shape did.
    const [first, second] = await Promise.all([seedFaqs(STARTER), seedFaqs(STARTER)]);
    expect(first + second).toBe(3);
    expect((await listFaqs({ publishedOnly: false })).length).toBe(3);
  });

  it('seeds the FAQ published, so the help page is not blank', async () => {
    await seedFaqs(STARTER);
    expect((await listFaqs({ publishedOnly: true })).length).toBe(3);
  });

  // ── Promo edits ───────────────────────────────────────────────────────────
  // A home card's picture is one image per screen (spec/promoDevices.js).
  const IMG = { PHONE: 'https://cdn.test/phone.png' };

  it('changes only the fields the admin supplied', async () => {
    const created = await upsertPromo({
      title: 'Diwali', description: 'Festival offer', location: 'HOME',
      mediaType: 'IMAGE', images: { LAPTOP: 'https://cdn.test/l.png', PHONE: 'https://cdn.test/p.png' }, priority: 7,
      status: 'PUBLISHED', isActive: true,
    });

    const edited = await updatePromo(created.promoId, { title: 'Diwali 2026' });

    expect(edited.title).toBe('Diwali 2026');
    // Everything the form did not send survives. An upsert-with-defaults here
    // reset the priority to 0, the status to DRAFT and the media to null.
    expect(edited.description).toBe('Festival offer');
    expect(edited.priority).toBe(7);
    expect(edited.status).toBe('PUBLISHED');
    expect(edited.images).toEqual({ LAPTOP: 'https://cdn.test/l.png', PHONE: 'https://cdn.test/p.png' });
  });

  it('does not mistake priority 0 for an absent priority', async () => {
    const created = await upsertPromo({ title: 'T', priority: 5 });
    const edited = await updatePromo(created.promoId, { priority: 0 });
    expect(edited.priority).toBe(0);
  });

  it('returns null for a promo that does not exist', async () => {
    expect(await updatePromo('no-such-promo', { title: 'x' })).toBeNull();
    expect(await updatePromo('no-such-promo', { images: IMG })).toBeNull();
    expect(await getPromo('no-such-promo')).toBeNull();
    expect(await deletePromo('no-such-promo')).toBe(false);
  });

  it('refuses a published slide with nothing to show', async () => {
    await expect(upsertPromo({
      title: 'Empty', location: 'RULES_PAGE', status: 'PUBLISHED', mediaType: 'IMAGE', fileUrl: null,
    })).rejects.toThrow(/promo_published_has_media/);
  });

  it('refuses a published home card with no image for any screen, and leaves nothing behind', async () => {
    await expect(upsertPromo({ title: 'Empty', status: 'PUBLISHED', isActive: true }))
      .rejects.toMatchObject({ status: 400, message: /at least one screen/ });
    expect(await listPromos({})).toEqual([]);
  });

  it('keeps each screen\'s own image, and changes only the screens named', async () => {
    const p = await upsertPromo({ title: 'c', status: 'DRAFT', images: { TABLET: 'https://cdn.test/t.png', SMALL_PHONE: 'https://cdn.test/s.png' } });
    expect(p.images).toEqual({ TABLET: 'https://cdn.test/t.png', SMALL_PHONE: 'https://cdn.test/s.png' });
    const q = await updatePromo(p.promoId, { images: { TABLET: 'https://cdn.test/t2.png', SMALL_PHONE: null, LAPTOP: 'https://cdn.test/l.png' } });
    expect(q.images).toEqual({ TABLET: 'https://cdn.test/t2.png', LAPTOP: 'https://cdn.test/l.png' });
  });

  it('refuses to take the last image off a published card, and keeps it', async () => {
    const p = await upsertPromo({ title: 'c', status: 'PUBLISHED', isActive: true, images: IMG });
    await expect(updatePromo(p.promoId, { images: { PHONE: null } }))
      .rejects.toMatchObject({ status: 400 });
    expect((await getPromo(p.promoId)).images).toEqual(IMG);
    // Unpublished first, it may go.
    expect((await updatePromo(p.promoId, { status: 'DRAFT', isActive: false, images: { PHONE: null } })).images).toEqual({});
  });

  it('refuses an unknown screen, in the writer and in the row', async () => {
    await expect(upsertPromo({ title: 'c', images: { WATCH: 'https://cdn.test/w.png' } }))
      .rejects.toMatchObject({ status: 400 });
    const p = await upsertPromo({ title: 'c' });
    await expect(pgQuery(`INSERT INTO promo_content_images (promo_id, device, file_url) VALUES ($1, 'WATCH', 'https://cdn.test/w.png')`, [p.promoId]))
      .rejects.toThrow(/promo_image_device_known/);
  });

  it('gives device images to home cards only, and no single file to a home card', async () => {
    await expect(upsertPromo({ title: 's', location: 'RULES_PAGE', fileUrl: 'u', images: IMG }))
      .rejects.toMatchObject({ status: 400 });
    await expect(upsertPromo({ title: 'h', location: 'HOME', fileUrl: 'https://cdn.test/x.png' }))
      .rejects.toThrow(/promo_home_uses_device_images/);
  });

  it('shows a client only published, active promos for its own slot, with something to draw', async () => {
    await upsertPromo({ title: 'live', location: 'HOME', images: IMG, status: 'PUBLISHED', isActive: true });
    await upsertPromo({ title: 'draft', location: 'HOME', images: IMG, status: 'DRAFT', isActive: true });
    await upsertPromo({ title: 'elsewhere', location: 'WALLET', fileUrl: 'u', status: 'PUBLISHED', isActive: true });

    const live = await listLivePromos('HOME');
    expect(live.map((p) => p.title)).toEqual(['live']);
    expect(live[0].images).toEqual(IMG);

    // The admin list is unfiltered by default and filterable by slot.
    expect((await listPromos({})).length).toBe(3);
    expect((await listPromos({ location: 'HOME' })).length).toBe(2);
    expect((await listPromos({ location: 'HOME', status: 'PUBLISHED' })).length).toBe(1);
  });

  it('orders promos by priority, so the important one is first', async () => {
    await upsertPromo({ title: 'low',  location: 'HOME', images: IMG, priority: 1, status: 'PUBLISHED', isActive: true });
    await upsertPromo({ title: 'high', location: 'HOME', images: IMG, priority: 9, status: 'PUBLISHED', isActive: true });
    expect((await listLivePromos('HOME')).map((p) => p.title)).toEqual(['high', 'low']);
  });

  it('carries a card\'s link to the player, and changes or clears it on edit', async () => {
    const p = await upsertPromo({ title: 'refer', location: 'HOME', images: IMG, linkUrl: '/referrals', status: 'PUBLISHED', isActive: true });
    expect((await listLivePromos('HOME'))[0].linkUrl).toBe('/referrals');
    expect((await updatePromo(p.promoId, { linkUrl: 'https://t.me/x' })).linkUrl).toBe('https://t.me/x');
    expect((await updatePromo(p.promoId, { linkUrl: null })).linkUrl).toBeNull();
  });

  it('re-applying the schema over a home card that still has a single file converges (S31)', async () => {
    // The database as it was before per-screen images: the old media rule,
    // which asked every published card for a file_url, and no home rule.
    await pgQuery('ALTER TABLE promo_content DROP CONSTRAINT promo_home_uses_device_images', []);
    await pgQuery('ALTER TABLE promo_content DROP CONSTRAINT promo_published_has_media', []);
    await pgQuery(`ALTER TABLE promo_content ADD CONSTRAINT promo_published_has_media CHECK (
      status <> 'PUBLISHED' OR media_type = 'TEXT' OR file_url IS NOT NULL)`, []);
    await pgQuery(`INSERT INTO promo_content (promo_id, title, location, file_url, status, is_active)
                   VALUES ('legacy-home', 'old', 'HOME', 'https://cdn.test/old.png', 'PUBLISHED', TRUE)`, []);
    await applySchema();
    expect((await getPromo('legacy-home')).fileUrl).toBeNull();
    // Nothing to draw on any screen: not sent to players.
    expect((await listLivePromos('HOME')).map((p) => p.promoId)).not.toContain('legacy-home');
  });

  it.each(['javascript:alert(1)', 'http://example.com', '//evil.example', 'referrals'])(
    'the row refuses a card link %s, whoever writes it', async (link) => {
      await expect(upsertPromo({ title: 'bad', location: 'HOME', linkUrl: link }))
        .rejects.toThrow(/promo_link_known/);
    });

  // ── The image library ─────────────────────────────────────────────────────
  it('refuses to delete an image something still points at', async () => {
    const image = await addImage({ url: 'https://cdn/logo.png', title: 'Logo', category: 'logo' });
    await adjustImageUsage(image.imageId, 1);

    const refused = await deleteImage(image.imageId);
    expect(refused).toEqual({ ok: false, reason: 'IN_USE', usageCount: 1 });
    expect((await listImages({})).length).toBe(1);

    await adjustImageUsage(image.imageId, -1);
    expect(await deleteImage(image.imageId)).toEqual({ ok: true });
  });

  it('tells a delete of a missing image apart from a refused one', async () => {
    expect(await deleteImage('no-such-image')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('re-registering a url updates that image rather than adding a second', async () => {
    await addImage({ url: 'https://cdn/a.png', title: 'First', category: 'logo' });
    await addImage({ url: 'https://cdn/a.png', title: 'Renamed', category: 'banner' });
    const images = await listImages({});
    expect(images).toHaveLength(1);
    expect(images[0].title).toBe('Renamed');
  });
});
