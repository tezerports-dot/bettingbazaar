// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The approved API host list (API_ALLOWED_HOSTS) is the whole of what Admin >
 * Settings > API Host may choose from; anything that is not an exact hostname
 * is dropped, never interpreted.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseApiHosts, apiOriginFor, approvedApiHosts } from '../../../config/apiHosts.js';
import { SYSTEM_CONFIG_SPEC } from '#db/spec/config.spec.js';

const envBefore = process.env.API_ALLOWED_HOSTS;
afterEach(() => {
  if (envBefore === undefined) delete process.env.API_ALLOWED_HOSTS; else process.env.API_ALLOWED_HOSTS = envBefore;
});

describe('parseApiHosts', () => {
  it('keeps exact hostnames, lowercased, deduplicated, in order', () => {
    expect(parseApiHosts(' API.example.com , edge.example.org., api.example.com ')).toEqual(['api.example.com', 'edge.example.org']);
  });

  it.each([
    ['a wildcard', '*.example.com'],
    ['a URL', 'https://api.example.com'],
    ['a port', 'api.example.com:8443'],
    ['an IPv4 address', '10.0.0.1'],
    ['an IPv6 address', '[::1]'],
    ['a single label', 'localhost'],
    ['a path', 'api.example.com/x'],
  ])('drops %s', (_why, entry) => {
    expect(parseApiHosts(entry)).toEqual([]);
  });

  it('empty or unset is no hosts', () => {
    expect(parseApiHosts('')).toEqual([]);
    expect(parseApiHosts(undefined)).toEqual([]);
  });
});

describe('apiOriginFor', () => {
  it('serves an approved choice as an https origin', () => {
    expect(apiOriginFor('API.example.com', ['api.example.com'])).toBe('https://api.example.com');
  });
  it('serves nothing for no choice, or a choice no longer approved', () => {
    expect(apiOriginFor('', ['api.example.com'])).toBe('');
    expect(apiOriginFor('gone.example.com', ['api.example.com'])).toBe('');
  });
});

describe('SystemConfig.apiHost', () => {
  it('may be none or one of the approved hosts, read when it is saved', () => {
    process.env.API_ALLOWED_HOSTS = 'api.example.com';
    expect(approvedApiHosts()).toEqual(['api.example.com']);
    const field = SYSTEM_CONFIG_SPEC.fields.apiHost;
    expect(field.default).toBe('');
    expect(field.oneOf()).toEqual(['', 'api.example.com']);
    process.env.API_ALLOWED_HOSTS = 'other.example.com';
    expect(field.oneOf()).toEqual(['', 'other.example.com']);
  });
});
