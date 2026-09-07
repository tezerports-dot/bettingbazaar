// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The support chat sends what the player typed to a real ticket.
 *
 * ── What this is guarding ───────────────────────────────────────────────────
 * The panel used to be a prop. `send()` made NO network call: it appended
 * "Thanks! An agent is looking into this and will reply here shortly." to local
 * state, under a hardcoded "Agent online · avg reply 2 min". A player with a
 * money problem was told help was coming and nothing left the browser.
 *
 * That is worse than a dead button, because a dead button looks broken and this
 * looked like it worked. The assertions below are therefore about the REQUEST,
 * not about what is on screen — a rendered reply proves nothing, which is the
 * whole lesson of the thing it replaced.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const API = 'https://api.test';
vi.mock('../services/apiUrl', () => ({ apiUrl: (p: string) => `${API}${p}` }));
vi.mock('../services/backend.service', () => ({
  getBackend: () => ({ getSupportLinks: () => Promise.resolve({ links: { telegram: 'bb_support' } }) }),
}));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

import SupportPage from './SupportPage';

const fetchMock = vi.fn();

const jsonOnce = (body: any) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as any);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.setItem('auth_token', 't0ken');
  // No existing ticket, so the first message must OPEN one.
  fetchMock.mockImplementation((url: string, init?: any) => {
    const u = String(url);
    if (u.endsWith('/api/support/tickets') && (!init || init.method !== 'POST')) return jsonOnce({ success: true, tickets: [] });
    if (u.endsWith('/api/support/tickets') && init?.method === 'POST') {
      return jsonOnce({ success: true, ticket: { ticketId: 'tkt-abcdef12', status: 'OPEN' } });
    }
    if (u.includes('/reply')) return jsonOnce({ success: true, message: {} });
    return jsonOnce({ success: true });
  });
});

const openChat = async () => {
  render(<SupportPage />);
  fireEvent.click(await screen.findByText('Message Support'));
  await screen.findByPlaceholderText(/Describe your problem/);
};

const type = (t: string) => {
  fireEvent.change(screen.getByPlaceholderText(/Describe your problem/), { target: { value: t } });
  fireEvent.click(screen.getByRole('button', { name: '➤' }));
};

const posts = () => fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST');

describe('the support chat', () => {
  it('opens a real ticket with what the player typed', async () => {
    await openChat();
    type('My deposit of 5000 has not arrived, UTR 123456789012');

    await waitFor(() => expect(posts().length).toBe(1));
    const [url, init] = posts()[0];
    expect(url).toBe(`${API}/api/support/tickets`);
    const body = JSON.parse(init.body);
    // The subject is the player's own words, so an agent sees the problem in
    // the queue rather than a placeholder.
    expect(body.subject).toContain('deposit of 5000');
    expect(body.message).toContain('UTR 123456789012');
  });

  it('replies to the existing ticket on the second message', async () => {
    await openChat();
    type('first');
    await waitFor(() => expect(posts().length).toBe(1));
    type('second');
    await waitFor(() => expect(posts().length).toBe(2));
    expect(posts()[1][0]).toBe(`${API}/api/support/tickets/tkt-abcdef12/reply`);
    expect(JSON.parse(posts()[1][1].body)).toMatchObject({ content: 'second' });
  });

  it('invents no agent reply', async () => {
    // The exact string the fake used, and the shape of it.
    await openChat();
    type('is anyone there');
    await waitFor(() => expect(posts().length).toBe(1));
    expect(screen.queryByText(/an agent is looking into this/i)).toBeNull();
    expect(screen.queryByText(/will reply here shortly/i)).toBeNull();
  });

  it('claims no agent is online', async () => {
    // "Agent online · avg reply 2 min" was hardcoded and always shown.
    await openChat();
    expect(screen.queryByText(/agent online/i)).toBeNull();
    expect(screen.queryByText(/avg reply/i)).toBeNull();
  });

  it('shows the real ticket state once one exists', async () => {
    await openChat();
    type('hello');
    expect(await screen.findByText(/tkt-abcd/)).toBeInTheDocument();
  });

  it('does not leave a failed message looking delivered', async () => {
    // The optimistic line is removed and the text put back in the box, so a
    // player never walks away believing something was sent that was not.
    fetchMock.mockImplementation((url: string, init?: any) => {
      const u = String(url);
      if (u.endsWith('/api/support/tickets') && init?.method === 'POST') return jsonOnce({ success: false, message: 'nope' });
      return jsonOnce({ success: true, tickets: [] });
    });
    await openChat();
    type('this will fail');
    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
    expect((screen.getByPlaceholderText(/Describe your problem/) as HTMLInputElement).value).toBe('this will fail');
  });

  it('continues an existing open ticket instead of starting a new one', async () => {
    fetchMock.mockImplementation((url: string, init?: any) => {
      const u = String(url);
      if (u.endsWith('/api/support/tickets') && (!init || init.method !== 'POST')) {
        return jsonOnce({ success: true, tickets: [{ ticketId: 'tkt-existing', status: 'OPEN' }] });
      }
      if (u.includes('/api/support/tickets/tkt-existing') && !u.includes('reply')) {
        return jsonOnce({ success: true, ticket: { ticketId: 'tkt-existing', status: 'OPEN' }, messages: [{ senderType: 'AGENT', content: 'We are on it.' }] });
      }
      return jsonOnce({ success: true });
    });
    await openChat();
    // A real agent reply, loaded from the server rather than invented.
    expect(await screen.findByText('We are on it.')).toBeInTheDocument();

    type('thanks');
    await waitFor(() => expect(posts().length).toBe(1));
    expect(posts()[0][0]).toContain('/tickets/tkt-existing/reply');
  });
});
