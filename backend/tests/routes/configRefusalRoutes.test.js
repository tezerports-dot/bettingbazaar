// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An admin saving a setting the spec does not declare is the ADMIN's mistake,
 * and is answered as one: 400, naming the key, nothing written.
 *
 * The config store threw that refusal as a bare Error — the one refusal in the
 * spec without `status: 400` — and the two routes that can reach it each
 * compensated by regex-matching the message. Any caller that did not (§21's
 * last paragraph, §32 S35) turned the typo into "Something went wrong" and
 * swallowed the only sentence that says which field was wrong. The status is
 * set at the throw now, and both routes answer through `respondError`.
 *
 * Neither write may land: the whole patch is validated before the transaction
 * opens, so the declared field sent beside the bad one must be unchanged too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getConfig } from '#db/repositories/config.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('an undeclared setting is refused as the caller\'s mistake', () => {
  let contentApp;
  let brandingApp;
  let admin;

  beforeAll(async () => {
    await applySchema();
    contentApp = mountRouter((await import('../../domains/cms/content.admin.routes.js')).default);
    brandingApp = mountRouter((await import('../../routes/admin/branding.admin.routes.js')).default);
    admin = await actor({ isAdmin: true });
  });

  afterAll(async () => { await closePg(); });

  it.each([
    ['support links', () => contentApp, '/content/support-links', 'supportLinks', 'telegramChannelUrl'],
    ['branding', () => brandingApp, '/branding', 'branding', 'appName'],
  ])('%s: 400 naming the key, and nothing written', async (_label, app, path, scope, declared) => {
    const before = await getConfig(scope, { fresh: true });
    // A declared field beside the bad one: if either landed, the save was partial.
    const res = await as(app(), admin).put(path).send({
      [declared]: `changed-${Date.now()}`,
      notADeclaredSetting: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIG_INVALID');
    expect(res.body.message).toMatch(/refusing to write undeclared setting 'notADeclaredSetting'/);

    const after = await getConfig(scope, { fresh: true });
    expect(after[declared]).toBe(before[declared]);
    expect(after.version).toBe(before.version);
  });
});
