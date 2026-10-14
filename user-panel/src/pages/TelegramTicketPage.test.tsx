// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * `#/tg/<ticket>`: the ticket leaves the address bar before it is spent, is
 * spent once, and a refused one says so with the way back in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const signInWithTicket = vi.fn();
const openAuth = vi.fn();
vi.mock('../services/GameContext', () => ({ useGame: () => ({ signInWithTicket }) }));
vi.mock('../redesign/RedesignShell', () => ({ useShell: () => ({ openAuth }) }));

const { default: TelegramTicketPage } = await import('./TelegramTicketPage');

const at = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/tg/:ticket" element={<TelegramTicketPage />} />
      <Route path="/" element={<p>home board</p>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => { signInWithTicket.mockReset(); openAuth.mockReset(); });

describe('the ticket page', () => {
  it('takes the ticket out of the address bar, spends it once, and goes to the board', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    signInWithTicket.mockResolvedValue(undefined);
    at('/tg/T0k3n');
    expect(await screen.findByText('home board')).toBeTruthy();
    expect(signInWithTicket).toHaveBeenCalledTimes(1);
    expect(signInWithTicket).toHaveBeenCalledWith('T0k3n');
    expect(String(replace.mock.calls[0]?.[2])).not.toContain('T0k3n');
  });

  it('a used ticket is said plainly, with Continue with Telegram', async () => {
    signInWithTicket.mockRejectedValue(new Error('This sign-in link has already been used or has expired. Press Continue with Telegram again.'));
    at('/tg/used');
    expect((await screen.findByRole('alert')).textContent).toMatch(/already been used/);
    screen.getByRole('button', { name: /continue with telegram/i }).click();
    expect(openAuth).toHaveBeenCalledWith();
  });
});
