// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Redirect handling in the outbound client.
 *
 * Validating only the URL we were handed is not an egress policy. A permitted
 * provider host that answers `302 Location: http://169.254.169.254/…` walks
 * straight to cloud metadata if redirects are followed by the fetch layer,
 * because that layer does not consult our policy. The client therefore follows
 * redirects by hand and re-checks every hop.
 *
 * A fake fetch is injected so these assert the client's own logic without
 * network access.
 */
import { describe, it, expect } from 'vitest';
import { NetworkClient } from '../../services/networkClient.js';

/** Minimal Response-alike: only what the redirect loop reads. */
const reply = (status, location) => ({
  status,
  headers: { get: (name) => (name.toLowerCase() === 'location' ? location ?? null : null) },
});

// A public IP LITERAL stands in for the permitted provider origin: dns.lookup
// returns it without a query, so these tests are deterministic and need no
// network. A hostname would fail on ENOTFOUND in the guard before the redirect
// logic under test was ever reached.

/** Fake fetch driven by a URL → response map, recording what it was asked for. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const res = routes[String(url)];
    if (!res) throw new Error(`unexpected fetch: ${url}`);
    return res;
  };
  impl.calls = calls;
  return impl;
}

describe('NetworkClient redirect handling', () => {
  it('refuses a redirect that points at cloud metadata', async () => {
    const fetchImpl = fakeFetch({
      'https://1.1.1.1/launch': reply(302, 'http://169.254.169.254/latest/meta-data/'),
    });
    const client = new NetworkClient({ fetchImpl });

    await expect(client.request('https://1.1.1.1/launch'))
      .rejects.toThrow(/non-public address/);

    // It stopped at the first hop — the metadata endpoint was never contacted.
    expect(fetchImpl.calls).toEqual(['https://1.1.1.1/launch']);
  });

  it('refuses a redirect to a private host', async () => {
    const fetchImpl = fakeFetch({
      'https://1.1.1.1/x': reply(307, 'http://10.0.0.5:5432/'),
    });
    await expect(new NetworkClient({ fetchImpl }).request('https://1.1.1.1/x'))
      .rejects.toThrow(/non-public address/);
  });

  it('refuses a redirect that switches to a non-http protocol', async () => {
    const fetchImpl = fakeFetch({
      'https://1.1.1.1/y': reply(302, 'file:///etc/passwd'),
    });
    await expect(new NetworkClient({ fetchImpl }).request('https://1.1.1.1/y'))
      .rejects.toThrow(/protocol/);
  });

  it('returns a non-redirect response untouched', async () => {
    const ok = reply(200, null);
    const fetchImpl = fakeFetch({ 'https://1.1.1.1/ok': ok });
    const res = await new NetworkClient({ fetchImpl }).request('https://1.1.1.1/ok');
    expect(res).toBe(ok);
  });

  it('rejects the initial URL when it is already private', async () => {
    const fetchImpl = fakeFetch({});
    await expect(new NetworkClient({ fetchImpl }).request('http://127.0.0.1:9090/metrics'))
      .rejects.toThrow(/non-public address/);
    expect(fetchImpl.calls).toEqual([]); // never dialled
  });

  it('stops after the redirect cap instead of looping forever', async () => {
    // A host redirecting to itself would spin without a bound.
    const self = 'https://1.1.1.1/loop';
    const fetchImpl = fakeFetch({ [self]: reply(302, self) });
    await expect(new NetworkClient({ fetchImpl }).request(self))
      .rejects.toThrow(/exceeded 5 redirects/);
  });

  it('leaves redirect handling alone when the caller sets its own policy', async () => {
    const res = reply(302, 'http://169.254.169.254/');
    const fetchImpl = fakeFetch({ 'https://1.1.1.1/manual': res });
    // Caller opted out of managed following; the initial URL is still checked,
    // and the redirect is handed back rather than followed by us.
    const out = await new NetworkClient({ fetchImpl })
      .request('https://1.1.1.1/manual', { redirect: 'manual' });
    expect(out).toBe(res);
  });
});
