// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the item-12 IP-rotation defense (pure parts: subnet keying +
// config gate). The subnet key is the whole point — rotating the last octet
// must collapse to the SAME key.
import { describe, it, expect } from 'vitest';
import { subnetKey, _ipDefenseConfig, _setIpDefenseConfig } from '../../middleware/ipDefense.js';

describe('subnetKey (IP-rotation collapse)', () => {
  it('IPv4 → /24: last octet does not change the key', () => {
    expect(subnetKey('203.0.113.7')).toBe('203.0.113.0/24');
    expect(subnetKey('203.0.113.250')).toBe('203.0.113.0/24');
    expect(subnetKey('203.0.113.7')).toBe(subnetKey('203.0.113.99')); // rotation defeated
  });

  it('different /24 blocks stay distinct', () => {
    expect(subnetKey('203.0.113.7')).not.toBe(subnetKey('203.0.114.7'));
  });

  it('IPv6 → /64 by default: host bits do not change the key', () => {
    expect(subnetKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(subnetKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(subnetKey('2001:db8:1:2:3:4:5:6')).toBe(subnetKey('2001:db8:1:2:9:9:9:9'));
  });

  it('IPv4-mapped IPv6 is treated as its IPv4 /24', () => {
    expect(subnetKey('::ffff:203.0.113.7')).toBe('203.0.113.0/24');
  });

  it('unparseable / empty input degrades safely', () => {
    expect(subnetKey('')).toBe('unknown');
    expect(subnetKey(undefined)).toBe('unknown');
    expect(subnetKey('garbage')).toBe('garbage');
  });
});

describe('ipDefense config gate', () => {
  it('exposes an enabled flag and a positive multiplier by default', () => {
    const c = _ipDefenseConfig();
    expect(typeof c.enabled).toBe('boolean');
    expect(c.subnetMultiplier).toBeGreaterThan(0);
  });

  it('is runtime-tunable (admin edits reflected via the cached setter)', () => {
    _setIpDefenseConfig({ subnetMultiplier: 20 });
    expect(_ipDefenseConfig().subnetMultiplier).toBe(20);
    _setIpDefenseConfig({ subnetMultiplier: 8 }); // restore default
  });
});
