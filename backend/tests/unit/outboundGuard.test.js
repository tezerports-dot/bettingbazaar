// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * SSRF egress policy. The realistic threat here is not an anonymous attacker —
 * no outbound URL comes from an end user — it is an admin, or someone holding a
 * stolen admin session, pointing `provider.apiUrl` at something only the server
 * can reach: cloud metadata, the money datastore on the private network, or a
 * loopback admin service.
 */
import { describe, it, expect } from 'vitest';
import { isBlockedAddress, assertAllowedUrl, OutboundBlockedError } from '../../services/outboundGuard.js';

const NO_PRIVATE = { OUTBOUND_ALLOW_PRIVATE: 'false' };

describe('outbound address policy', () => {
  it('blocks the cloud metadata endpoints', () => {
    expect(isBlockedAddress('169.254.169.254')).toBe(true); // AWS/GCP/Azure/Hetzner
    expect(isBlockedAddress('fd00:ec2::254')).toBe(true);   // IPv6 metadata
  });

  it('blocks loopback, private and link-local ranges', () => {
    for (const addr of ['127.0.0.1', '::1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.1.1', 'fc00::1']) {
      expect(isBlockedAddress(addr), addr).toBe(true);
    }
  });

  it('blocks an IPv4-mapped IPv6 address that smuggles a loopback', () => {
    // ::ffff:127.0.0.1 is an IPv6 literal whose range() is 'ipv4Mapped'; it must
    // be judged on the v4 address it carries.
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
  });

  it('blocks unspecified and broadcast', () => {
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
    expect(isBlockedAddress('255.255.255.255')).toBe(true);
  });

  it('treats an unparseable address as unsafe', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });

  it('permits ordinary public addresses', () => {
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });
});

describe('assertAllowedUrl', () => {
  it('rejects non-http protocols', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://x/y', 'gopher://x/1']) {
      await expect(assertAllowedUrl(url, NO_PRIVATE)).rejects.toThrow(OutboundBlockedError);
    }
  });

  it('rejects a literal private address', async () => {
    await expect(assertAllowedUrl('http://169.254.169.254/latest/meta-data/', NO_PRIVATE))
      .rejects.toThrow(/non-public address/);
    await expect(assertAllowedUrl('http://10.0.0.5:5432/', NO_PRIVATE))
      .rejects.toThrow(/non-public address/);
  });

  it('rejects loopback by name as well as by literal', async () => {
    await expect(assertAllowedUrl('http://localhost:9090/metrics', NO_PRIVATE))
      .rejects.toThrow(OutboundBlockedError);
  });

  it('allows a private destination when the operator opts in', async () => {
    // A self-hosted provider inside the private network is a legitimate case.
    await expect(assertAllowedUrl('http://10.0.0.5/api', { OUTBOUND_ALLOW_PRIVATE: 'true' }))
      .resolves.toBeInstanceOf(URL);
  });

  it('enforces the host allow-list when one is configured', async () => {
    const env = { ...NO_PRIVATE, OUTBOUND_ALLOWED_HOSTS: 'api.provider.test, sms.gateway.test' };
    await expect(assertAllowedUrl('https://evil.test/x', env))
      .rejects.toThrow(/not in OUTBOUND_ALLOWED_HOSTS/);
  });

  it('rejects a malformed URL', async () => {
    await expect(assertAllowedUrl('not a url', NO_PRIVATE)).rejects.toThrow(OutboundBlockedError);
  });
});
