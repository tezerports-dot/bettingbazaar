// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { describe, expect, it } from 'vitest';
import {
  decodeOrderCursor,
  encodeOrderCursor,
  encodeCompoundCursor,
  normalizeLimit,
  paginatedResponse,
} from '../../utils/cursorPagination.js';

describe('cursor pagination utilities', () => {
  it('normalizes untrusted limits with a configured maximum', () => {
    expect(normalizeLimit('25', 50, 100)).toBe(25);
    expect(normalizeLimit('-1', 50, 100)).toBe(50);
    expect(normalizeLimit('9999', 50, 100)).toBe(100);
  });

  it('round-trips an order cursor through the wire format', () => {
    const at = new Date('2026-07-18T12:00:00.000Z');
    const cursor = encodeOrderCursor({ createdAt: at, orderId: 'ORD-1' });

    // Base64url, so a client cannot construct one by guessing the shape and a
    // caller does not have to know what is inside it.
    expect(cursor).not.toContain('ORD-1');
    expect(decodeOrderCursor(cursor)).toEqual({ createdAt: at, orderId: 'ORD-1' });
  });

  it('treats an unusable cursor as no cursor at all', () => {
    // A client that pasted half a URL gets the FIRST page, not a 400 it cannot
    // act on — and never a filter built from half a value.
    expect(decodeOrderCursor(undefined)).toBeNull();
    expect(decodeOrderCursor('not-base64url-json')).toBeNull();
    // The encoder answers "no cursor" with null for an unusable value too,
    // rather than raising a RangeError out of the response that was only trying
    // to say there is no next page.
    expect(encodeCompoundCursor({ _id: 'x', createdAt: 'not a date' })).toBeNull();
    expect(decodeOrderCursor(encodeCompoundCursor({ _id: 'x', createdAt: 'not a date' }))).toBeNull();
    expect(encodeOrderCursor(null)).toBeNull();
    expect(encodeOrderCursor({ createdAt: new Date() })).toBeNull();
  });

  it('returns one page plus resumable metadata', () => {
    const items = [
      { _id: 'a', createdAt: new Date('2026-07-18T12:00:00.000Z') },
      { _id: 'b', createdAt: new Date('2026-07-18T11:00:00.000Z') },
      { _id: 'c', createdAt: new Date('2026-07-18T10:00:00.000Z') },
    ];

    const page = paginatedResponse(items, 2);

    expect(page.items).toEqual(items.slice(0, 2));
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeTruthy();
    expect(page.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
