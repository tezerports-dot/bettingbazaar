// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The database's `bb_text_has_a_mobile` and the JavaScript `textHasAMobile`
 * (backend/domains/identity/mobileInText.js) are one rule written twice: the
 * row refuses what the route would have refused. Held to the same list here,
 * so a spelling added to one and not the other fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '../client.js';
import { textHasAMobile } from '../../backend/domains/identity/mobileInText.js';
import { MOBILE_SPELLINGS, NOT_MOBILES } from '../../backend/tests/mobileSpellings.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('bb_text_has_a_mobile agrees with textHasAMobile', () => {
  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => { await closePg(); });

  it.each([...MOBILE_SPELLINGS, ...NOT_MOBILES])('%j', async (text) => {
    const { rows } = await pgQuery('SELECT bb_text_has_a_mobile($1) AS has', [text]);
    expect(rows[0].has).toBe(textHasAMobile(text));
  });

  it('reads a null as no mobile', async () => {
    expect((await pgQuery('SELECT bb_text_has_a_mobile(NULL) AS has')).rows[0].has).toBe(false);
  });
});
