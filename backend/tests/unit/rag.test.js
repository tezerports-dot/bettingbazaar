// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for RAG store serialization (CAP-71) + the activation gates. Pure —
// no DB, no network. The gates read process.env lazily, so toggling env in a
// test flips them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { toVectorLiteral } from '../../domains/support/ragStore.js';
import { retrievalReady, generationReady, ragEnabled } from '../../domains/support/ragService.js';

describe('toVectorLiteral', () => {
  it('serializes a number[] to a pgvector literal', () => {
    expect(toVectorLiteral([1, 2, 3])).toBe('[1,2,3]');
    expect(toVectorLiteral([0.5, -0.25])).toBe('[0.5,-0.25]');
  });
  it('rejects empty / non-array input', () => {
    expect(() => toVectorLiteral([])).toThrow();
    expect(() => toVectorLiteral(null)).toThrow();
  });
  it('rejects non-finite values (guards against poisoned SQL)', () => {
    expect(() => toVectorLiteral([1, NaN])).toThrow();
    expect(() => toVectorLiteral([1, Infinity])).toThrow();
  });
});

describe('RAG activation gating', () => {
  const keys = ['DATABASE_URL', 'VOYAGE_API_KEY', 'ANTHROPIC_API_KEY'];
  const saved = {};
  beforeEach(() => { keys.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); });
  afterEach(() => { keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  it('all gates are false when nothing is configured (feature dormant)', () => {
    expect(retrievalReady()).toBe(false);
    expect(generationReady()).toBe(false);
    expect(ragEnabled()).toBe(false);
  });

  it('retrievalReady needs BOTH Postgres and an embedding provider', () => {
    process.env.DATABASE_URL = 'postgres://x';
    expect(retrievalReady()).toBe(false);
    process.env.VOYAGE_API_KEY = 'k';
    expect(retrievalReady()).toBe(true);
  });

  it('generationReady needs the Anthropic key', () => {
    expect(generationReady()).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'k';
    expect(generationReady()).toBe(true);
  });

  it('ragEnabled requires retrieval AND generation', () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.VOYAGE_API_KEY = 'k';
    expect(ragEnabled()).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'k';
    expect(ragEnabled()).toBe(true);
  });
});
