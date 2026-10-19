// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cricketFeed.js — the one door to the cricket data providers (owner,
 * 2026-10-18, providers 2026-10-19; CLAUDE.md §17.1.4: a volatile third-party
 * surface through one thin adapter). Only the server calls a provider; players
 * read our own API and stream.
 *
 * Each provider is an adapter in `feeds/` giving the engine the same
 * provider-free shapes (fixtures, live facts, squads), so adding one is a new
 * adapter here and nothing else. The fixture list comes from the provider the
 * admin made active (Admin › Cricket); a match is always read from the
 * provider it came from (`cricket_matches.feed_provider`), so switching never
 * strands a match under way.
 *
 * Each provider's token is saved on Admin › Cricket, encrypted
 * (`cricket_feed`), and decrypted here, per call; it is never logged or sent
 * to a panel.
 */
import { db } from '#db';
import { decryptField } from '../identity/fieldCrypto.util.js';
import * as sportmonks from './feeds/sportmonks.js';
import * as entitysport from './feeds/entitysport.js';

/** The providers the platform can read, by key (the `cricket_feed.provider` CHECK). */
export const FEED_PROVIDERS = Object.freeze({ [sportmonks.KEY]: sportmonks, [entitysport.KEY]: entitysport });

/** What the admin panel lists: each provider's key and name. */
export const feedProviderList = () => Object.values(FEED_PROVIDERS).map((p) => ({ key: p.KEY, label: p.LABEL }));

function adapter(provider) {
  const a = FEED_PROVIDERS[provider];
  if (!a) throw Object.assign(new Error(`Unknown cricket data provider '${provider}'`), { code: 'CRICKET_FEED_UNKNOWN' });
  return a;
}

async function token(provider) {
  const enc = await db.cricket.feedTokenCiphertext(provider);
  if (!enc) throw Object.assign(new Error(`The ${adapter(provider).LABEL} token is not set (Admin › Cricket).`), { code: 'CRICKET_FEED_NOT_SET' });
  return decryptField(enc);
}

/** The active provider's upcoming fixtures, each stamped with that provider. */
export async function fetchUpcoming({ fetchImpl } = {}) {
  const { provider } = await db.cricket.getFeed();
  const fixtures = await adapter(provider).fetchUpcoming({ token: await token(provider), fetchImpl });
  return fixtures.map((f) => ({ ...f, provider }));
}

/** One match's live facts, from the provider it came from. */
export async function fetchLive(match, { fetchImpl } = {}) {
  return adapter(match.feedProvider).fetchLive(match, { token: await token(match.feedProvider), fetchImpl });
}

/** Both teams' whole squads for one match, from the provider it came from. */
export async function fetchSquads(match, { fetchImpl } = {}) {
  return adapter(match.feedProvider).fetchSquads(match, { token: await token(match.feedProvider), fetchImpl });
}
