// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the RAG chunker (CAP-71) — pure, no DB, no network.
import { describe, it, expect } from 'vitest';
import { chunkText, chunkDocument, estimateTokens } from '../../domains/support/chunk.js';

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world')).toEqual(['hello world']);
  });

  it('splits an oversized single paragraph and keeps each piece within bound', () => {
    const para = 'word '.repeat(1000); // ~5000 chars, no paragraph breaks
    const chunks = chunkText(para, { maxChars: 500, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(520);
  });

  it('packs multiple paragraphs without exceeding maxChars', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} `.padEnd(120, 'x')).join('\n\n');
    const chunks = chunkText(text, { maxChars: 300, overlap: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(300));
  });

  it('is deterministic', () => {
    const t = 'a\n\nb\n\nc';
    expect(chunkText(t)).toEqual(chunkText(t));
  });

  it('handles empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText(null)).toEqual([]);
  });
});

describe('chunkDocument', () => {
  it('requires a docId', () => {
    expect(() => chunkDocument({ text: 'x' })).toThrow(/docId/);
  });

  it('attaches metadata and sequential indices', () => {
    const recs = chunkDocument({ docId: 'd1', title: 'T', source: 's', category: 'kyc', text: 'para one\n\npara two' });
    expect(recs[0]).toMatchObject({ docId: 'd1', chunkIndex: 0, title: 'T', category: 'kyc' });
    recs.forEach((r, i) => expect(r.chunkIndex).toBe(i));
    recs.forEach((r) => expect(r.tokenEstimate).toBeGreaterThan(0));
  });
});

describe('estimateTokens', () => {
  it('approximates chars/4', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});
