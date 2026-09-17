// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Editing and deleting a game must reach the game, not `/undefined`.
 *
 * ── The defect (§23, and §28's dead button) ─────────────────────────────────
 * `interface Game` declared an `_id` the server has never sent. The list route
 * emits `slug, name, providerKey, …`, and the mutation routes say so in their
 * own words — "the slug IS the identity". So every `g._id` typechecked and was
 * `undefined` at runtime:
 *
 *   - Delete began `if (!g._id) return;`, so the button did NOTHING, silently.
 *   - Save on an existing game took `editing._id ? PUT : POST`'s false branch
 *     and tried to CREATE a second game on the same slug.
 *   - The dialog titled itself "New Game" while editing an existing one.
 *
 * Verified against the live server while fixing it: `PUT
 * /api/game/admin/games/browser-pass-probe` answers 200 and
 * `PUT /api/game/admin/games/undefined` answers 404.
 *
 * These assert on the URL, because the URL is the thing that was wrong and a
 * test that only checked "some request was made" would have passed throughout.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { get, post, put, del } = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(),
}));
vi.mock('../../services/api', () => ({ default: { get, post, put, delete: del } }));
const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: { success: toastSuccess, error: toastError } }));

import GamesManager from './GamesManager';

// Copied from a real `GET /api/game/admin/games` response. Note: no `_id`.
const GAMES = [{
  slug: 'delhi-bombay', name: 'Delhi vs Bombay', providerKey: '', categorySlug: 'bb-originals',
  launchStrategy: 'INTERNAL', externalGameId: null, launchUrl: '/', thumbnail: null, banner: null,
  badge: '🎯 Original', rtp: null, tags: ['original'], minBet: 10, maxBet: 100000,
  status: 'ACTIVE', featured: true, order: 0,
}];
const CATEGORIES = [{ slug: 'bb-originals', name: 'BB Originals', icon: '🎯', order: 0, enabled: true, gameCount: 1 }];

beforeEach(() => {
  get.mockReset(); post.mockReset(); put.mockReset(); del.mockReset();
  toastSuccess.mockReset(); toastError.mockReset();
  get.mockImplementation((url: string) => {
    if (url.includes('/games'))          return Promise.resolve({ data: { success: true, games: GAMES } });
    if (url.includes('/categories'))     return Promise.resolve({ data: { success: true, categories: CATEGORIES } });
    if (url.includes('/game-providers')) return Promise.resolve({ data: { success: true, providers: [] } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  put.mockResolvedValue({ data: { success: true } });
  del.mockResolvedValue({ data: { success: true } });
  vi.stubGlobal('confirm', () => true);
});

describe('GamesManager identifies a game by its slug', () => {
  it('Delete asks the server to delete THAT game', async () => {
    render(<GamesManager />);
    await screen.findByText('Delhi vs Bombay');

    await userEvent.click(screen.getByTitle('Delete Delhi vs Bombay'));

    // The whole defect: this used to return before ever calling the API.
    await waitFor(() => expect(del).toHaveBeenCalled());
    expect(del.mock.calls[0][0]).toBe('/api/game/admin/games/delhi-bombay');
    expect(del.mock.calls[0][0]).not.toContain('undefined');
  });

  it('Save on an existing game UPDATES it instead of creating a second one', async () => {
    render(<GamesManager />);
    await screen.findByText('Delhi vs Bombay');

    await userEvent.click(screen.getByTitle('Edit Delhi vs Bombay'));
    // The title is the symptom an operator could actually see.
    expect(await screen.findByText('Edit Game')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Save changes'));

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][0]).toBe('/api/game/admin/games/delhi-bombay');
    expect(post).not.toHaveBeenCalled();
  });
});
