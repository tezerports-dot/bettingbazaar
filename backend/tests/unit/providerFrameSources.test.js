// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A provider game has to be allowed INTO an iframe, and only the right one.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `CSP_DIRECTIVES` carried no `frame-src`. CSP falls back `frame-src` →
 * `child-src` → `default-src`, and `default-src` is `'self'`, so every provider
 * game was blocked by the browser. CasinoPage, CrashPage and SportsPage each
 * build an iframe around a `launchUrl` whose origin is the provider's
 * `api_url`, and all three rendered their chrome around a blank frame.
 *
 * Nothing could have caught it. The launch route works and is tested; the panel
 * calls a route that exists, so `check:ui-coverage` is satisfied; the refusal
 * happens in the browser and appears in no response. The config file even
 * turned COEP off *because* iframes were expected — the intent was recorded and
 * the permission was not.
 *
 * ── What is asserted here ──────────────────────────────────────────────────
 * The header, not the helper. A test that only checked `providerFrameSources()`
 * returns an array would have passed against `frameSrc: providerFrameSources`,
 * which is what I wrote first and which throws `directiveValue is not iterable`
 * at boot, because helmet's directive values are ITERABLES and a function may
 * only be an ELEMENT of one. So these drive the middleware and read the
 * `Content-Security-Policy` it actually sets.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  providerOrigin, providerFrameSources, __setProviderFrameSourcesForTest,
} from '../../domains/casino/providerFrameSources.js';
import { securityHeaders, __resetSecurityHeadersCache } from '../../middleware/cspMiddleware.js';

/** The header, split into directives, from a real response. */
async function cspOf() {
  const app = express();
  app.use(securityHeaders);
  app.get('/', (_req, res) => res.json({ ok: true }));
  const res = await request(app).get('/');
  const header = res.headers['content-security-policy'] || '';
  return Object.fromEntries(
    header.split(';').map((d) => d.trim()).filter(Boolean)
      .map((d) => { const [name, ...rest] = d.split(/\s+/); return [name, rest]; }),
  );
}

beforeEach(() => {
  __setProviderFrameSourcesForTest([]);
  __resetSecurityHeadersCache();
});

describe('which origin a provider game may be framed from', () => {
  it('takes the ORIGIN, because CSP matches origins and a path would rot', () => {
    expect(providerOrigin('https://api.provider.example/launch/v2')).toBe('https://api.provider.example');
    expect(providerOrigin('https://api.provider.example')).toBe('https://api.provider.example');
    // A port is part of the origin and must survive.
    expect(providerOrigin('https://staging.provider.example:8443/x')).toBe('https://staging.provider.example:8443');
  });

  it('refuses anything that is not https', () => {
    // A game iframe carries a session token in its query string, and on an
    // https page the browser blocks mixed content anyway — so an http entry
    // would only be a permission that cannot be exercised.
    expect(providerOrigin('http://api.provider.example')).toBeNull();
    expect(providerOrigin('ftp://api.provider.example')).toBeNull();
  });

  it('refuses what a half-configured provider row actually holds', () => {
    for (const junk of ['', null, undefined, '   ', 'api.provider.example', 'TBD', '<set me>']) {
      expect(providerOrigin(junk), String(junk)).toBeNull();
    }
  });
});

describe('the header the browser is sent', () => {
  it('names the enabled provider, so its game can load', async () => {
    __setProviderFrameSourcesForTest(['https://api.provider.example/launch']);
    const csp = await cspOf();
    expect(csp['frame-src']).toEqual(["'self'", 'https://api.provider.example']);
  });

  it('is `self` alone when no provider is enabled — never a wildcard', async () => {
    // Failing closed. This is also the state before the first database read
    // completes, and it is exactly what shipped, so the failure mode is the
    // status quo rather than something an attacker can widen.
    const csp = await cspOf();
    expect(csp['frame-src']).toEqual(["'self'"]);
    expect(csp['frame-src']).not.toContain('*');
    expect(csp['frame-src']).not.toContain('https:');
  });

  it('still carries frame-ancestors — the opposite question', async () => {
    // Who may frame US. It was present all along and was NOT the missing one;
    // a fix that confused the two would leave the games blocked and the panels
    // frameable.
    const csp = await cspOf();
    expect(csp['frame-ancestors']).toEqual(["'self'"]);
  });

  it('leaves every other directive exactly as it was', async () => {
    __setProviderFrameSourcesForTest(['https://api.provider.example']);
    const csp = await cspOf();
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    // The provider's origin is admitted for FRAMING only. It does not become a
    // script source, which would be a much larger grant than the defect needed.
    expect(csp['script-src']).not.toContain('https://api.provider.example');
  });

  it('follows a provider being added and removed', async () => {
    // The middleware caches its helmet instance, so this is the case that says
    // the cache is keyed on the origins rather than built once and kept.
    __setProviderFrameSourcesForTest(['https://one.example']);
    expect((await cspOf())['frame-src']).toEqual(["'self'", 'https://one.example']);

    __setProviderFrameSourcesForTest(['https://one.example', 'https://two.example']);
    expect((await cspOf())['frame-src']).toEqual(["'self'", 'https://one.example', 'https://two.example']);

    // A provider switched off stops being frameable. That toggle is how a
    // supplier is cut off in a hurry.
    __setProviderFrameSourcesForTest(['https://two.example']);
    expect((await cspOf())['frame-src']).toEqual(["'self'", 'https://two.example']);
  });

  it('does not repeat an origin two providers share', async () => {
    __setProviderFrameSourcesForTest([
      'https://api.example/casino', 'https://api.example/sports', 'https://api.example',
    ]);
    // Provider origins only — `'self'` belongs to the directive builder.
    expect(providerFrameSources()).toEqual(['https://api.example']);
    expect((await cspOf())['frame-src']).toEqual(["'self'", 'https://api.example']);
  });
});
