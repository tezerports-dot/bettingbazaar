// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Seeding the shipped providers must not undo an operator's decision.
 *
 * ── What this is protecting ─────────────────────────────────────────────────
 * `seedProviders()` ran on every `GET /api/game/providers` — a public,
 * unauthenticated route the player panel calls on page load — through
 * `upsertProvider`, passing only the key, name, category, description and
 * logo. `enabled` therefore defaulted to `false` and `apiUrl` to `null`, and
 * the `ON CONFLICT DO UPDATE` assigned both columns from those defaults.
 *
 * So every page load switched off every shipped provider and wiped the API URL
 * an operator had entered. Measured against the live server before the fix:
 *
 *     after the operator enables them   betby: enabled=true  url=https://betby.example.test
 *                                       spribe: enabled=true url=https://aviator.example.test
 *     after ONE player loads the page   betby: enabled=false url=null
 *                                       spribe: enabled=false url=null
 *
 * An operator could not turn on a crash or sports provider AT ALL. They
 * switched it on; the next visitor switched it off; the admin screen showed it
 * off again on reload. And because `game_providers_enabled_has_url` refuses an
 * enabled provider with no URL, the wiped URL had to be retyped every attempt.
 *
 * The comment guarding the old code reasoned that credentials are `COALESCE`d
 * and concluded the seed was safe to run on every request. True of the three
 * credential columns, and of nothing else.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { seedProviderIfMissing, upsertProvider, getProvider, listPublicProviders } from '../repositories/games.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('seeding the shipped game providers (PostgreSQL)', () => {
  const KEY = 'seedtest-aviator';
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => {
    await pgQuery('DELETE FROM game_providers WHERE provider_key = $1', [KEY]);
    await closePg();
  });
  // Own rows only — never a global assertion over a shared table (trap 10).
  beforeEach(async () => { await pgQuery('DELETE FROM game_providers WHERE provider_key = $1', [KEY]); });

  const seed = () => seedProviderIfMissing({
    providerKey: KEY, name: 'Spribe — Aviator', category: 'crash',
    description: 'a crash game', logoUrl: '',
  });

  it('creates a provider that is missing, switched OFF', async () => {
    await seed();
    const p = await getProvider(KEY);
    expect(p).toBeTruthy();
    expect(p.enabled).toBe(false);
    expect(p.category).toBe('crash');
  });

  it('is idempotent — running it again changes nothing', async () => {
    await seed();
    const first = await getProvider(KEY);
    await seed();
    expect(await getProvider(KEY)).toEqual(first);
  });

  it('LEAVES AN OPERATOR\'S SWITCH ALONE — the whole defect', async () => {
    await seed();
    // The operator turns it on and gives it a URL, as the admin screen does.
    await pgQuery(
      'UPDATE game_providers SET enabled = TRUE, api_url = $2 WHERE provider_key = $1',
      [KEY, 'https://aviator.example.test'],
    );
    // A player opens the app. Ten of them.
    for (let i = 0; i < 10; i++) await seed();

    const after = await getProvider(KEY);
    expect(after.enabled).toBe(true);
    expect(after.apiUrl).toBe('https://aviator.example.test');

    // And the player panel is still told about it, which is the fact that
    // decides whether the CASH OR CRASH card is offered at all.
    const pub = await listPublicProviders();
    expect(pub.some((p) => p.providerKey === KEY && p.category === 'crash')).toBe(true);
  });

  it('a deliberate admin upsert still CAN switch it off — this is not a lock', async () => {
    await seed();
    await pgQuery('UPDATE game_providers SET enabled = TRUE, api_url = $2 WHERE provider_key = $1',
      [KEY, 'https://aviator.example.test']);
    // `upsertProvider` is the admin path and is meant to write what it is given.
    await upsertProvider({ providerKey: KEY, name: 'Spribe — Aviator', category: 'crash', enabled: false });
    expect((await getProvider(KEY)).enabled).toBe(false);
  });
});
