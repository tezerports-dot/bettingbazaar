// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
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
  it('changes only the fields the admin supplied', async () => {
    const created = await upsertPromo({
      title: 'Diwali', description: 'Festival offer', location: 'HOME',
      mediaType: 'IMAGE', fileUrl: 'https://cdn/x.png', priority: 7,
      status: 'PUBLISHED', isActive: true,
    });

    const edited = await updatePromo(created.promoId, { title: 'Diwali 2026' });

    expect(edited.title).toBe('Diwali 2026');
    // Everything the form did not send survives. An upsert-with-defaults here
    // reset the priority to 0, the status to DRAFT and the media to null.
    expect(edited.description).toBe('Festival offer');
    expect(edited.priority).toBe(7);
    expect(edited.status).toBe('PUBLISHED');
    expect(edited.fileUrl).toBe('https://cdn/x.png');
  });

  it('does not mistake priority 0 for an absent priority', async () => {
    const created = await upsertPromo({ title: 'T', priority: 5 });
    const edited = await updatePromo(created.promoId, { priority: 0 });
    expect(edited.priority).toBe(0);
  });

  it('returns null for a promo that does not exist', async () => {
    expect(await updatePromo('no-such-promo', { title: 'x' })).toBeNull();
    expect(await getPromo('no-such-promo')).toBeNull();
    expect(await deletePromo('no-such-promo')).toBe(false);
  });

  it('refuses a published promo with nothing to show', async () => {
    await expect(upsertPromo({
      title: 'Empty', status: 'PUBLISHED', mediaType: 'IMAGE', fileUrl: null,
    })).rejects.toThrow(/promo_published_has_media/);
  });

  it('shows a client only published, active promos for its own slot', async () => {
    await upsertPromo({ title: 'live', location: 'HOME', fileUrl: 'u', status: 'PUBLISHED', isActive: true });
    await upsertPromo({ title: 'draft', location: 'HOME', fileUrl: 'u', status: 'DRAFT', isActive: true });
    await upsertPromo({ title: 'elsewhere', location: 'WALLET', fileUrl: 'u', status: 'PUBLISHED', isActive: true });

    const live = await listLivePromos('HOME');
    expect(live.map((p) => p.title)).toEqual(['live']);

    // The admin list is unfiltered by default and filterable by slot.
    expect((await listPromos({})).length).toBe(3);
    expect((await listPromos({ location: 'HOME' })).length).toBe(2);
    expect((await listPromos({ location: 'HOME', status: 'PUBLISHED' })).length).toBe(1);
  });

  it('orders promos by priority, so the important one is first', async () => {
    await upsertPromo({ title: 'low',  location: 'HOME', fileUrl: 'u', priority: 1, status: 'PUBLISHED', isActive: true });
    await upsertPromo({ title: 'high', location: 'HOME', fileUrl: 'u', priority: 9, status: 'PUBLISHED', isActive: true });
    expect((await listLivePromos('HOME')).map((p) => p.title)).toEqual(['high', 'low']);
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
