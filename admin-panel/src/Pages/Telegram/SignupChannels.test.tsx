// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Signup channels (owner, 2026-10-21): the card lists what the server holds,
 * adds by what was typed, approves only on a press, and says a refusal in the
 * server's words (`role="alert"`, S44).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { getChannels, addChannel, setChannelActive, approveChannelRequests } = vi.hoisted(() => ({
  getChannels: vi.fn(), addChannel: vi.fn(), setChannelActive: vi.fn(), approveChannelRequests: vi.fn(),
}));
vi.mock('../../services/api', () => ({ default: { telegram: { getChannels, addChannel, setChannelActive, approveChannelRequests } } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { SignupChannels } from './SignupChannels';
import type { TelegramChannel } from '../../services/api';

const NEWS: TelegramChannel = {
  chatId: '-1001234567', title: 'Bazaar News', username: 'bazaarnews', inviteLink: 'https://t.me/+abc',
  linkCheckedAt: '2026-10-21T10:00:00Z', linkError: '', active: true, addedAt: '2026-10-21T09:00:00Z',
  switchedAt: null, waiting: 3, approved: 5, gone: 1,
};

beforeEach(() => {
  [getChannels, addChannel, setChannelActive, approveChannelRequests].forEach((f) => f.mockReset());
});

describe('Signup channels', () => {
  it('says plainly when there are none, so sign-in is unchanged', async () => {
    getChannels.mockResolvedValue({ success: true, channels: [], approvePerPress: 1000 });
    render(<SignupChannels />);
    expect(await screen.findByText(/no channels/i)).toBeTruthy();
  });

  it('shows each channel with its waiting, approved and gone counts and its link', async () => {
    getChannels.mockResolvedValue({ success: true, channels: [NEWS], approvePerPress: 1000 });
    render(<SignupChannels />);
    const card = await screen.findByTestId('channel--1001234567');
    expect(card.textContent).toMatch(/Bazaar News \(@bazaarnews\)/);
    expect(card.textContent).toMatch(/Waiting: 3.*Approved: 5.*No longer in Telegram: 1/);
    expect(card.textContent).toMatch(/https:\/\/t\.me\/\+abc/);
    expect(approveChannelRequests).not.toHaveBeenCalled();
  });

  it('adds a channel by what was typed', async () => {
    getChannels.mockResolvedValue({ success: true, channels: [], approvePerPress: 1000 });
    addChannel.mockResolvedValue({ success: true, channels: [NEWS] });
    render(<SignupChannels />);
    fireEvent.change(await screen.findByLabelText('Channel'), { target: { value: ' @bazaarnews ' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => expect(addChannel).toHaveBeenCalledWith('@bazaarnews'));
    expect(await screen.findByText(/Bazaar News/)).toBeTruthy();
  });

  it('says a refusal in the server\'s words', async () => {
    getChannels.mockResolvedValue({ success: true, channels: [], approvePerPress: 1000 });
    addChannel.mockRejectedValue({ response: { data: { message: 'Make @bb_bot an administrator of that channel.' } } });
    render(<SignupChannels />);
    fireEvent.change(await screen.findByLabelText('Channel'), { target: { value: '@x_chan' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/administrator of that channel/);
  });

  it('approves the waiting requests only on a press, and switches a channel off', async () => {
    getChannels.mockResolvedValue({ success: true, channels: [NEWS], approvePerPress: 1000 });
    approveChannelRequests.mockResolvedValue({ success: true, approved: 3, gone: 0, waiting: 0, stopped: null, channels: [{ ...NEWS, waiting: 0, approved: 8 }] });
    setChannelActive.mockResolvedValue({ success: true, channels: [{ ...NEWS, active: false, waiting: 0 }] });
    render(<SignupChannels />);
    fireEvent.click(await screen.findByRole('button', { name: /approve waiting \(3\)/i }));
    await waitFor(() => expect(approveChannelRequests).toHaveBeenCalledWith('-1001234567'));
    await waitFor(() => expect(screen.getByTestId('channel--1001234567').textContent).toMatch(/Approved: 8/));
    fireEvent.click(screen.getByRole('button', { name: /switch off/i }));
    await waitFor(() => expect(setChannelActive).toHaveBeenCalledWith('-1001234567', false));
    expect(await screen.findByRole('button', { name: /switch on/i })).toBeTruthy();
  });
});
