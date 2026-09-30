// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A failed load is not an empty list.
 *
 * The page caught every load failure silently and rendered "No announcements",
 * so an operator could not tell "none yet" from "never loaded" — §28's dead
 * buttons, the same shape. The browser pass flagged the screen (R4); these
 * pin the three states apart.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { get, post, put: vi.fn(), delete: vi.fn() } }));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: toastError } }));

import { AnnouncementsPage } from './AnnouncementsPage';

beforeEach(() => { get.mockReset(); post.mockReset(); toastError.mockReset(); });

describe('Announcements', () => {
  it('says the list could not be loaded, with the reason, when the load fails', async () => {
    get.mockRejectedValue({ response: { data: { message: 'Insufficient permissions. Required: canManageContent' } } });
    render(<AnnouncementsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
    expect(screen.getByText(/Required: canManageContent/)).toBeTruthy();
    expect(screen.queryByText(/No announcements yet/)).toBeNull();
  });

  it('explains an empty list, and does not call it an error', async () => {
    get.mockResolvedValue({ data: { success: true, announcements: [] } });
    render(<AnnouncementsPage />);
    expect(await screen.findByText(/No announcements yet/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the server\'s reason when a save is refused, not "Error"', async () => {
    get.mockResolvedValue({ data: { success: true, announcements: [] } });
    post.mockRejectedValue({ response: { data: { message: 'title is required' } } });
    render(<AnnouncementsPage />);
    await screen.findByText(/No announcements yet/);
    await userEvent.click(screen.getByRole('button', { name: /New/i }));
    const save = await screen.findByRole('button', { name: /^(Create|Save|Publish)/i });
    await userEvent.click(save);
    expect(toastError).toHaveBeenCalledWith('title is required');
  });
});
