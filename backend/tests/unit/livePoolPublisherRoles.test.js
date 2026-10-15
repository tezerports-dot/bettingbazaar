// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The live pool feed starts in every runtime role (fixed 2026-10-15).
 *
 * Players' bets are placed on the api role and auto house bets by the
 * scheduler. The publisher used to start only inside the realtime-only block,
 * so on the three-role deploy (deploy/vps/docker-compose.prod.yml) the totals
 * those roles recorded were never flushed and players saw the pool move only
 * when a reload re-read it. Pinned here so moving the start back inside that
 * block fails a test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const server = readFileSync(fileURLToPath(new URL('../../server.js', import.meta.url)), 'utf8');

describe('cycle snapshot publisher start', () => {
  it('is started once, after the realtime-only block, so every role flushes what it records', () => {
    const starts = [...server.matchAll(/cycleSnapshotPublisher\.attach\(\{ io, sseManager \}\)\.start\(\)/g)];
    expect(starts).toHaveLength(1);
    const realtimeOnlyEnd = server.indexOf("message: 'Realtime disabled on this API role'");
    expect(realtimeOnlyEnd).toBeGreaterThan(0);
    expect(starts[0].index).toBeGreaterThan(realtimeOnlyEnd);
  });
});
