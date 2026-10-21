// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The support desk opens a real ticket and hands the player to Telegram
 * (CLAUDE.md §2, "Support desks"; owner, 2026-10-21).
 *
 * The assertions are about the REQUEST and the link, not about a reply on
 * screen: the panel this replaced once showed a canned "an agent is looking
 * into this" with no network call at all.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const API = 'https://api.test';
// apiClient waits for a validated origin; here it is ready and fixed.
vi.mock('../services/originFailover', async (orig) => ({
  ...(await orig<typeof import('../services/originFailover')>()),
  whenEndpointReady: async () => API, currentOrigin: () => API, failoverAvailable: () => false,
}));
vi.mock('../services/backend.service', () => ({
  getBackend: () => ({ getSupportLinks: () => Promise.resolve({ links: { telegram: 'bb_support' } }) }),
}));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../redesign/RedesignShell', () => ({ useShell: () => ({ isAuthenticated: true, openAuth: vi.fn(), openMenu: vi.fn() }) }));

import SupportPage from './SupportPage';

const fetchMock = vi.fn();
const jsonOnce = (body: any, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) } as any);

const DESK = {
  success: true, historyDays: 7, descriptionMin: 20, descriptionMax: 1000, referenceMax: 64,
  topics: [{ key: 'BETS', label: 'Bets and results' }, { key: 'OTHER', label: 'Something else' }],
  openedToday: false, nextTicketAt: '2026-10-22T18:30:00.000Z',
};
const OPENED = {
  ticketId: 't1', code: 'S-7K4Q2M', topic: 'BETS', subject: 'My bet shows no result after the round', reference: '',
  status: 'OPEN', createdAt: '2026-10-21T05:00:00.000Z', rating: null, telegramUsername: 'bb_help_1',
  telegramLink: 'https://t.me/bb_help_1?text=Ticket%20S-7K4Q2M',
};

const backend = ({ desk = DESK, assistant = false, askBody = null as any } = {}) => {
  fetchMock.mockImplementation((url: string, init?: any) => {
    const u = String(url);
    if (u.endsWith('/api/support/status')) return jsonOnce({ success: true, enabled: assistant });
    if (u.endsWith('/api/support/ask')) return jsonOnce(askBody);
    if (u.endsWith('/api/support/desk')) return jsonOnce(desk);
    if (u.endsWith('/api/support/tickets') && init?.method === 'POST') return jsonOnce({ success: true, ticket: OPENED });
    if (u.endsWith('/api/support/tickets')) return jsonOnce({ success: true, tickets: [] });
    if (u.includes('/api/support/tickets/')) return jsonOnce({ success: true, ticket: OPENED, messages: [] });
    return jsonOnce({ success: true });
  });
};

const posts = () => fetchMock.mock.calls.filter(([u, i]) => i?.method === 'POST' && String(u).endsWith('/api/support/tickets'));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.setItem('auth_token', 't0ken');
  backend();
});

const openDesk = async () => {
  render(<SupportPage />);
  fireEvent.click(await screen.findByText('Get help'));
  await screen.findByText('Open a support ticket');
};

describe('support desk', () => {
  it('opens a ticket with the topic and description, and offers its Telegram chat', async () => {
    await openDesk();
    const send = screen.getByText('Open ticket') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByText('Bets and results'));
    fireEvent.change(screen.getByPlaceholderText(/what you did/), { target: { value: 'My bet shows no result after the round ended.' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ topic: 'BETS', reference: '', description: 'My bet shows no result after the round ended.' });
    const link = await screen.findByText(/Chat on Telegram/);
    expect(link.closest('a')?.getAttribute('href')).toBe(OPENED.telegramLink);
    expect(screen.queryByText('Open a support ticket')).toBeNull();
  });

  it('shows no form once today’s ticket is used', async () => {
    backend({ desk: { ...DESK, openedToday: true } });
    render(<SupportPage />);
    fireEvent.click(await screen.findByText('Get help'));
    await screen.findByText(/opened today/);
    expect(screen.queryByText('Open a support ticket')).toBeNull();
  });

  it('never shows an ungrounded assistant answer as one, and carries the question into the form', async () => {
    backend({ assistant: true, askBody: { success: true, grounded: false, answer: 'Please contact support.' } });
    await openDesk();
    const ask = await screen.findByPlaceholderText('How do I…');
    fireEvent.change(ask, { target: { value: 'Why is my referral bonus missing from my wallet?' } });
    fireEvent.keyDown(ask, { key: 'Enter' });
    await screen.findByText(/don't have an answer/);
    expect(screen.queryByText('Please contact support.')).toBeNull();
    expect((screen.getByPlaceholderText(/what you did/) as HTMLTextAreaElement).value).toBe('Why is my referral bonus missing from my wallet?');
  });
});
