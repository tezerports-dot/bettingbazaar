// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The one-bot form: shows what the server holds, sends only what was typed,
 * and says a refusal in the server's words (`role="alert"`, S44).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const { getBot, saveBot } = vi.hoisted(() => ({ getBot: vi.fn(), saveBot: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { telegram: { getBot, saveBot } } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { TelegramBot } from './TelegramBot';

const SAVED = {
  success: true, configured: true, botId: '123', botUsername: 'bb_bot',
  miniAppShortName: 'app', updatedAt: '2026-10-08T09:00:00Z', updatedBy: 'a-1',
};

describe('Telegram setup: the one bot', () => {
  beforeEach(() => { vi.clearAllMocks(); cleanup(); });

  it('shows the saved bot and never pre-fills a token', async () => {
    getBot.mockResolvedValue(SAVED);
    render(<TelegramBot />);
    expect(await screen.findByText('@bb_bot')).toBeInTheDocument();
    expect((screen.getByLabelText('Bot token') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Bot token') as HTMLInputElement).type).toBe('password');
    expect((screen.getByLabelText('Mini App short name') as HTMLInputElement).value).toBe('app');
  });

  it('saves the short name alone when no token is typed', async () => {
    getBot.mockResolvedValue(SAVED);
    saveBot.mockResolvedValue({ ...SAVED, miniAppShortName: 'play' });
    render(<TelegramBot />);
    await screen.findByText('@bb_bot');
    fireEvent.change(screen.getByLabelText('Mini App short name'), { target: { value: 'play' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveBot).toHaveBeenCalledWith({ miniAppShortName: 'play' }));
  });

  it('says a refused token in the server\'s words', async () => {
    getBot.mockResolvedValue({ ...SAVED, configured: false, botId: null, botUsername: '', miniAppShortName: '', updatedAt: null, updatedBy: null });
    saveBot.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { success: false, code: 'TOKEN_INVALID', message: 'That is not a bot token.' } },
    }));
    render(<TelegramBot />);
    await screen.findByText('No bot saved');
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That is not a bot token.');
  });
});
