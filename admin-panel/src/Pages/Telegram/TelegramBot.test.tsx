// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The bot and its standbys: each slot shows what the server holds, sends only
 * what was typed, and says a refusal in the server's words (`role="alert"`, S44).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const { getBot, saveBot, removeBot, resumeBot } = vi.hoisted(() => ({
  getBot: vi.fn(), saveBot: vi.fn(), removeBot: vi.fn(), resumeBot: vi.fn(),
}));
vi.mock('../../services/api', () => ({ default: { telegram: { getBot, saveBot, removeBot, resumeBot } } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { TelegramBot } from './TelegramBot';
import type { TelegramBotSlot } from '../../services/api';

const PRIMARY: TelegramBotSlot = {
  slot: 1, botId: '123', botUsername: 'bb_bot', miniAppShortName: 'app', suspended: false,
  suspendedAt: null, suspendedReason: '', updatedAt: '2026-10-08T09:00:00Z', updatedBy: 'a-1',
};
const view = (bots: TelegramBotSlot[]) => {
  const inUse = bots.find((b) => !b.suspended);
  return {
    success: true, configured: Boolean(inUse), slot: inUse?.slot ?? null, botId: inUse?.botId ?? null,
    botUsername: inUse?.botUsername ?? '', miniAppShortName: inUse?.miniAppShortName ?? '',
    updatedAt: inUse?.updatedAt ?? null, updatedBy: inUse?.updatedBy ?? null, slots: 4, bots,
  };
};

describe('Telegram setup: the bot and its standbys', () => {
  beforeEach(() => { vi.clearAllMocks(); cleanup(); vi.spyOn(window, 'confirm').mockReturnValue(true); });

  it('shows the saved bot and never pre-fills a token', async () => {
    getBot.mockResolvedValue(view([PRIMARY]));
    render(<TelegramBot />);
    expect(await screen.findByText('@bb_bot')).toBeInTheDocument();
    expect(screen.getByText('In use: @bb_bot (Primary bot)')).toBeInTheDocument();
    const token = screen.getByLabelText('Primary bot token') as HTMLInputElement;
    expect(token.value).toBe('');
    expect(token.type).toBe('password');
    expect((screen.getByLabelText('Primary bot Mini App short name') as HTMLInputElement).value).toBe('app');
    expect(screen.getByLabelText('Standby 1 token')).toBeInTheDocument();
    expect(screen.getByLabelText('Standby 3 token')).toBeInTheDocument();
  });

  it('saves the primary\'s short name alone when no token is typed', async () => {
    getBot.mockResolvedValue(view([PRIMARY]));
    saveBot.mockResolvedValue({ ...PRIMARY, miniAppShortName: 'play' });
    render(<TelegramBot />);
    await screen.findByText('@bb_bot');
    // The field is filled from the saved bot after it renders; type only once
    // it holds the saved value, or the fill can overwrite what was typed.
    await waitFor(() => expect((screen.getByLabelText('Primary bot Mini App short name') as HTMLInputElement).value).toBe('app'));
    fireEvent.change(screen.getByLabelText('Primary bot Mini App short name'), { target: { value: 'play' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Primary bot' }));
    await waitFor(() => expect(saveBot).toHaveBeenCalledWith({ miniAppShortName: 'play' }));
  });

  it('saves a standby into its own slot', async () => {
    getBot.mockResolvedValue(view([PRIMARY]));
    saveBot.mockResolvedValue({ ...PRIMARY, slot: 2, botId: '456', botUsername: 'bb_two_bot' });
    render(<TelegramBot />);
    await screen.findByText('@bb_bot');
    fireEvent.change(screen.getByLabelText('Standby 1 token'), { target: { value: '456:AAAAAAAAAAAAAAAAAAAAAAAA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Standby 1' }));
    await waitFor(() => expect(saveBot).toHaveBeenCalledWith({ slot: 2, token: '456:AAAAAAAAAAAAAAAAAAAAAAAA', miniAppShortName: '' }));
    expect(getBot).toHaveBeenCalledTimes(2);
  });

  it('shows a suspended bot with its reason, names the standby in use, and resumes or removes', async () => {
    const two = { ...PRIMARY, slot: 2, botId: '456', botUsername: 'bb_two_bot' };
    getBot.mockResolvedValue(view([
      { ...PRIMARY, suspended: true, suspendedAt: '2026-10-14T10:00:00Z', suspendedReason: 'Telegram refused the token: Unauthorized' },
      two,
    ]));
    resumeBot.mockResolvedValue(PRIMARY);
    removeBot.mockResolvedValue({ success: true, slot: 2 });
    render(<TelegramBot />);
    expect(await screen.findByText('In use: @bb_two_bot (Standby 1)')).toBeInTheDocument();
    expect(screen.getByText(/Telegram refused the token: Unauthorized/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Primary bot' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume Primary bot' }));
    await waitFor(() => expect(resumeBot).toHaveBeenCalledWith(1));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Standby 1' }));
    await waitFor(() => expect(removeBot).toHaveBeenCalledWith(2));
  });

  it('says a refused token in the server\'s words', async () => {
    getBot.mockResolvedValue(view([]));
    saveBot.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { success: false, code: 'TOKEN_INVALID', message: 'That is not a bot token.' } },
    }));
    render(<TelegramBot />);
    await screen.findByText('No bot in use');
    fireEvent.change(screen.getByLabelText('Primary bot token'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Primary bot' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That is not a bot token.');
  });
});
