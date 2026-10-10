// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * POST /api/v1/client/endpoint-events takes closed enums only: an attacker
 * controls this body, so nothing outside the lists reaches a metric label.
 */
import { describe, it, expect } from 'vitest';
import { endpointEventLabels } from '../../../routes/clientTelemetry.routes.js';

describe('endpointEventLabels', () => {
  it('accepts the events the player app sends', () => {
    expect(endpointEventLabels({ events: [
      { kind: 'discovery_failed', source: 'discovery', reason: 'http_503' },
      { kind: 'adopted', source: 'configured', reason: 'none' },
      { kind: 'failover', source: 'configured' },
    ] }, 'api.example.com')).toEqual([
      { kind: 'discovery_failed', source: 'discovery', reason: 'http_error', host: 'api.example.com' },
      { kind: 'adopted', source: 'configured', reason: 'none', host: 'api.example.com' },
      { kind: 'failover', source: 'configured', reason: 'none', host: 'api.example.com' },
    ]);
  });

  it.each([
    ['no body', undefined],
    ['not a list', { events: 'x' }],
    ['empty', { events: [] }],
    ['too many', { events: Array.from({ length: 21 }, () => ({ kind: 'adopted', source: 'configured' })) }],
    ['unknown kind', { events: [{ kind: 'pwned', source: 'configured' }] }],
    ['free-text source', { events: [{ kind: 'adopted', source: 'https://evil.example.com' }] }],
    ['free-text reason', { events: [{ kind: 'discovery_failed', source: 'discovery', reason: 'a'.repeat(200) }] }],
    ['non-object event', { events: [42] }],
  ])('refuses %s', (_why, body) => {
    expect(endpointEventLabels(body)).toBeNull();
  });
});
