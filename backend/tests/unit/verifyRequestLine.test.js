// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The line the Verify screen shows about who asked (owner, 2026-10-13: the
 * destination, time, device, IP and city): the device in a few words, and the
 * city only from the header the operator names, never from one a caller sends
 * on a server that named none.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { deviceOf, requestCity } from '../../domains/identity/telegramChallenge.service.js';

const reqWith = (headers) => ({ get: (name) => headers[String(name).toLowerCase()] });

describe('deviceOf', () => {
  it('names the browser and the system', () => {
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')).toBe('Edge on Windows');
    expect(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox on macOS');
  });
  it('keeps what it cannot read, cut short, and says nothing for nothing', () => {
    expect(deviceOf('curl/8.5.0')).toBe('curl/8.5.0');
    expect(deviceOf('x'.repeat(500))).toHaveLength(120);
    expect(deviceOf('')).toBe('');
  });
});

describe('requestCity', () => {
  const before = process.env.GEO_CITY_HEADER;
  afterEach(() => { if (before === undefined) delete process.env.GEO_CITY_HEADER; else process.env.GEO_CITY_HEADER = before; });

  it('reads nothing a caller sends when the operator named no header', () => {
    delete process.env.GEO_CITY_HEADER;
    expect(requestCity(reqWith({ 'cf-ipcity': 'Mumbai' }))).toBe('');
  });
  it('reads the named header, without control characters, at most 80 characters', () => {
    process.env.GEO_CITY_HEADER = 'CF-IPCity';
    expect(requestCity(reqWith({ 'cf-ipcity': 'Mumbai' }))).toBe('Mumbai');
    expect(requestCity(reqWith({ 'cf-ipcity': 'Pune\n<b>' }))).toBe('Pune<b>');
    expect(requestCity(reqWith({ 'cf-ipcity': 'y'.repeat(200) }))).toHaveLength(80);
    expect(requestCity(reqWith({}))).toBe('');
  });
});
