// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The board rules pop-up shows the server's text, opens for a player who has
 * not accepted the current version, and records the acceptance through the
 * server (owner, 2026-10-08).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: api, apiClient: api }));

const { BoardRulesModal, BOARD_RULES_EVENT } = await import('./BoardRules');

let accepted = 0;
beforeEach(() => {
  accepted = 0;
  api.get.mockReset().mockImplementation(async (path: string) => (path === '/api/v1/board-rules'
    ? { success: true, version: 1, sections: [{ title: 'How a round is won', body: 'The side with LESS real player money wins.' }] }
    : { success: true, version: 1, acceptedVersion: accepted }));
  api.post.mockReset().mockImplementation(async (_p: string, body: any) => { accepted = body.version; return { success: true, acceptedVersion: accepted }; });
});

describe('the board rules pop-up', () => {
  it('opens with the server\'s text for a player who has not accepted, and closes once they agree', async () => {
    render(<BoardRulesModal isAuthenticated />);
    const dialog = await screen.findByRole('dialog', { name: 'How the boards work' });
    expect(dialog.textContent).toMatch(/LESS real player money/);
    fireEvent.click(screen.getByRole('button', { name: 'I understand and agree' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/user/board-rules/accept', { version: 1 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stays closed for a player who already accepted, and opens when a bet is refused for it', async () => {
    accepted = 1;
    render(<BoardRulesModal isAuthenticated />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/user/board-rules'));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { window.dispatchEvent(new Event(BOARD_RULES_EVENT)); });
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('announces a failed save', async () => {
    api.post.mockRejectedValueOnce(Object.assign(new Error('The board rules have changed. Please read them again.'), { data: { code: 'BOARD_RULES_CHANGED' } }));
    render(<BoardRulesModal isAuthenticated />);
    await screen.findByRole('dialog');
    await waitFor(() => expect((screen.getByRole('button', { name: 'I understand and agree' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'I understand and agree' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/have changed/);
  });
});
