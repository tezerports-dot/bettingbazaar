// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Profile → Telegram: shows the linked account and moves it, polling the
 * status until `linkedAt` changes (and no longer than the wait allows).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getTelegramStatus: vi.fn(),
  relinkTelegram: vi.fn(),
}));
vi.mock('../services/api', () => ({ api, default: api, ...api }));

const { TelegramCard } = await import('./TelegramCard');

const status = (over: Record<string, unknown> = {}) => ({
  success: true, available: true, linked: true, telegramUsername: 'old_me', firstName: 'Old',
  verifiedAt: '2026-10-01T10:00:00Z', linkedAt: '2026-10-01T10:00:00Z',
  twoFactor: { enabled: true, required: true }, ...over,
});
const TELEGRAM = { url: 'https://t.me/bb_bot/app?startapp=r-1', botUsername: 'bb_bot', expiresAt: '2026-10-08T10:00:00Z' };
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('Profile Telegram card', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows the link and that approval is required, with no switch', async () => {
    api.getTelegramStatus.mockResolvedValue(status());
    render(<TelegramCard />);
    await flush();
    expect(screen.getByText('@old_me')).toBeTruthy();
    expect(screen.getByText('Required')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('moves to another account once linkedAt changes', async () => {
    api.getTelegramStatus.mockResolvedValueOnce(status());
    api.relinkTelegram.mockResolvedValue({ success: true, telegram: TELEGRAM, message: 'Open the link in the new account.' });
    render(<TelegramCard />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Move to another Telegram account' }));
    await flush();
    expect(screen.getByRole('link', { name: /Open Telegram/ }).getAttribute('href')).toBe(TELEGRAM.url);

    api.getTelegramStatus.mockResolvedValueOnce(status());
    await flush(3000);
    expect(screen.queryByText('@new_me')).toBeNull();

    api.getTelegramStatus.mockResolvedValueOnce(status({ telegramUsername: 'new_me', linkedAt: '2026-10-08T09:00:00Z' }));
    await flush(3000);
    expect(screen.getByText('@new_me')).toBeTruthy();
    expect(screen.getByText('Telegram account moved')).toBeTruthy();
  });

  it('gives up after the wait and says so', async () => {
    api.getTelegramStatus.mockResolvedValue(status());
    api.relinkTelegram.mockResolvedValue({ success: true, telegram: TELEGRAM, message: '' });
    render(<TelegramCard />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Move to another Telegram account' }));
    await flush();
    await flush(6 * 60 * 1000);
    expect(screen.getByRole('alert').textContent).toContain('No approval arrived from Telegram');
  });
});
