// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Profile screen's Telegram card says what the server says (Step 3).
 *
 * Turning approval OFF is the one switch a stolen password would reach for,
 * so it must not change on the tap: the server answers 202 with a link, and
 * the card shows it until Telegram has approved.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { getMyTelegram, relinkTelegram, setTelegramTwoFactor } = vi.hoisted(() => ({
  getMyTelegram: vi.fn(), relinkTelegram: vi.fn(), setTelegramTwoFactor: vi.fn(),
}));
vi.mock('../services/backend.service', () => ({
  getBackend: () => ({ getMyTelegram, relinkTelegram, setTelegramTwoFactor }),
}));

import ProfileTelegram from './ProfileTelegram';

const LINK = { url: 'https://t.me/bb_bot?startapp=cabc', botUsername: 'bb_bot', expiresAt: '' };
const status = (over = {}) => ({
  available: true, linked: true, telegramUsername: 'asha', firstName: 'Asha',
  verifiedAt: '2026-10-07T10:00:00Z', linkedAt: '2026-10-07T10:00:00Z',
  twoFactor: { enabled: false, required: false }, ...over,
});

beforeEach(() => {
  getMyTelegram.mockReset().mockResolvedValue(status());
  relinkTelegram.mockReset().mockResolvedValue({ telegram: LINK });
  setTelegramTwoFactor.mockReset();
});

describe('the Telegram card', () => {
  it('names the Telegram account that verified the mobile', async () => {
    render(<ProfileTelegram />);
    expect(await screen.findByText('@asha')).toBeTruthy();
  });

  it('turns approval ON at once', async () => {
    setTelegramTwoFactor.mockResolvedValue({ twoFactor: { enabled: true, required: false } });
    render(<ProfileTelegram />);
    const sw = await screen.findByRole('switch');
    getMyTelegram.mockResolvedValue(status({ twoFactor: { enabled: true, required: false } }));
    fireEvent.click(sw);
    await vi.waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'));
    expect(setTelegramTwoFactor).toHaveBeenCalledWith(true);
  });

  it('does NOT show approval off until Telegram approves it', async () => {
    getMyTelegram.mockResolvedValue(status({ twoFactor: { enabled: true, required: false } }));
    setTelegramTwoFactor.mockResolvedValue({ approvalRequired: true, telegram: LINK });
    render(<ProfileTelegram />);
    fireEvent.click(await screen.findByRole('switch'));
    expect((await screen.findByRole('link', { name: /open telegram/i })).getAttribute('href')).toBe(LINK.url);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('starts a move to another Telegram account with a link to open there', async () => {
    render(<ProfileTelegram />);
    fireEvent.click(await screen.findByRole('button', { name: /move to another telegram account/i }));
    expect(await screen.findByText(/share its contact there/i)).toBeTruthy();
    expect(relinkTelegram).toHaveBeenCalled();
  });

  it('shows a refusal as an alert', async () => {
    getMyTelegram.mockRejectedValue(new Error('Could not read your Telegram link.'));
    render(<ProfileTelegram />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not read/i);
  });
});
