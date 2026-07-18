// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { describe, expect, it } from 'vitest';
import {
  buildDescendingCursorFilter,
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

  it('builds a compound descending cursor filter', () => {
    const doc = { _id: '64f000000000000000000001', createdAt: new Date('2026-07-18T12:00:00.000Z') };
    const cursor = encodeCompoundCursor(doc);

    expect(buildDescendingCursorFilter(cursor)).toEqual({
      $or: [
        { createdAt: { $lt: doc.createdAt } },
        { createdAt: doc.createdAt, _id: { $lt: doc._id } },
      ],
    });
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
