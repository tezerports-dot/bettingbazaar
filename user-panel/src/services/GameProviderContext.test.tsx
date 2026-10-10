// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * A section is live only when it has a game to show (owner, 2026-10-08).
 *
 * The home cards, the footer and each section page's redirect read `anyCasino`,
 * `anyCrash` and `anySports`. Those used to be "a provider is switched on", so
 * a provider enabled with no game added put a card on the home screen that led
 * to "No games available yet". They now ask the provider's `gameCount`, which
 * the server counts by the rules each page lists by (`listPublicProviders`).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
// apiClient waits for a validated origin; here it is ready and fixed.
vi.mock('./originFailover', async (orig) => ({
  ...(await orig<typeof import('./originFailover')>()),
  whenEndpointReady: async () => '', currentOrigin: () => '', failoverAvailable: () => false,
}));

import { GameProviderProvider, useGameProviders } from './GameProviderContext';

const provider = (key: string, gameCount: number) =>
  ({ key, name: key, enabled: true, description: '', logoUrl: '', gameCount });

const answer = (providers: object) => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, providers }) })));
};

const Probe = () => {
  const { loading, anyCasino, anyCrash, anySports } = useGameProviders();
  return <p>{loading ? 'loading' : `casino=${anyCasino} crash=${anyCrash} sports=${anySports}`}</p>;
};

const read = async () => {
  render(<GameProviderProvider><Probe /></GameProviderProvider>);
  await waitFor(() => expect(screen.queryByText('loading')).toBeNull());
  return screen.getByText(/casino=/).textContent;
};

describe('which sections are live', () => {
  beforeEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });

  it('hides a section whose enabled providers have no games', async () => {
    answer({ casino: [provider('evo', 0)], crash: [provider('spribe', 0)], sports: [provider('betby', 0)] });
    expect(await read()).toBe('casino=false crash=false sports=false');
  });

  it('shows a section once any of its providers has a game', async () => {
    answer({ casino: [provider('evo', 0), provider('prag', 3)], crash: [provider('spribe', 1)], sports: [] });
    expect(await read()).toBe('casino=true crash=true sports=false');
  });
});
