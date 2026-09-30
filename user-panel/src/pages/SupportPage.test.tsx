// GOVERNANCE: Read CLAUDE.md before editing this file.
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

const jsonOnce = (body: any, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) } as any);

/**
 * A backend with the assistant live. `enabled` is the server's own conjunction
 * of retrievalReady && generationReady — the panel must not re-derive it.
 */
const withAssistant = (askBody: any, askOk = true) => {
  fetchMock.mockImplementation((url: string, init?: any) => {
    const u = String(url);
    if (u.endsWith('/api/support/status')) return jsonOnce({ success: true, enabled: true });
    if (u.endsWith('/api/support/ask')) return jsonOnce(askBody, askOk);
    if (u.endsWith('/api/support/tickets') && (!init || init.method !== 'POST')) return jsonOnce({ success: true, tickets: [] });
    if (u.endsWith('/api/support/tickets') && init?.method === 'POST') {
      return jsonOnce({ success: true, ticket: { ticketId: 'tkt-abcdef12', status: 'OPEN' } });
    }
    if (u.includes('/reply')) return jsonOnce({ success: true, message: {} });
    return jsonOnce({ success: true });
  });
};

const asks = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/support/ask'));
const tickets = () => fetchMock.mock.calls.filter(([u, i]) =>
  i?.method === 'POST' && !String(u).endsWith('/api/support/ask'));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.setItem('auth_token', 't0ken');
  // No existing ticket, so the first message must OPEN one.
  fetchMock.mockImplementation((url: string, init?: any) => {
    const u = String(url);
    // Assistant dormant by default: these cases are about the human path.
    if (u.endsWith('/api/support/status')) return jsonOnce({ success: true, enabled: false });
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
  // ── The assistant ─────────────────────────────────────────────────────────
  // It answers first, and it must never become a wall between a player and a
  // person. Every case below is about that boundary rather than about the
  // answer text, which comes from the model and is not this panel's business.

  it('asks the assistant before opening a ticket', async () => {
    withAssistant({ success: true, grounded: true, answer: 'Withdrawals settle in 24 hours.' });
    await openChat();
    type('how long do withdrawals take');

    await waitFor(() => expect(asks().length).toBe(1));
    expect(JSON.parse(asks()[0][1].body)).toMatchObject({ query: 'how long do withdrawals take' });
    expect(await screen.findByText('Withdrawals settle in 24 hours.')).toBeInTheDocument();
    // A grounded answer does NOT open a ticket — that is the point of asking.
    expect(tickets().length).toBe(0);
  });

  it('labels the answer as automated', async () => {
    // A player deciding what to do about their money must not mistake this for
    // a person. The old panel's whole defect was reading as human.
    withAssistant({ success: true, grounded: true, answer: 'KYC takes one working day.' });
    await openChat();
    type('kyc');
    expect(await screen.findByText(/ASSISTANT · AUTOMATED/)).toBeInTheDocument();
  });

  it('keeps a person one tap away after it answers, carrying the question over', async () => {
    withAssistant({ success: true, grounded: true, answer: 'Deposits credit instantly.' });
    await openChat();
    type('my deposit of 5000 is missing');
    await screen.findByText('Deposits credit instantly.');

    // The answer may simply be wrong for this player's case.
    fireEvent.click(screen.getByText(/talk to a person/i));
    await waitFor(() => expect(tickets().length).toBe(1));
    const body = JSON.parse(tickets()[0][1].body);
    // Their own words, not retyped and not lost.
    expect(body.message).toBe('my deposit of 5000 is missing');
    expect(body.subject).toContain('deposit of 5000');
  });

  it('does not present an ungrounded answer as an answer', async () => {
    // grounded:false means nothing matched; the server still returns a canned
    // "contact human support" line. Showing that as a reply would be the exact
    // fake this panel was written to delete.
    const canned = "I couldn't find this in our help center. Please contact human support and they'll assist you.";
    withAssistant({ success: true, grounded: false, answer: canned, citations: [] });
    await openChat();
    type('something obscure');

    await waitFor(() => expect(asks().length).toBe(1));
    expect(screen.queryByText(canned)).toBeNull();
    expect(await screen.findByText(/talk to a person/i)).toBeInTheDocument();
  });

  it('falls through to a human when the assistant call fails', async () => {
    withAssistant({ success: false, message: 'RAG retrieval not configured.' }, false);
    await openChat();
    type('help');

    await waitFor(() => expect(asks().length).toBe(1));
    // Nothing is claimed, and the human route is offered.
    expect(screen.queryByText(/RAG retrieval/)).toBeNull();
    expect(await screen.findByText(/talk to a person/i)).toBeInTheDocument();
  });

  it('never asks the assistant when the server reports it dormant', async () => {
    // Default mock has enabled:false. A 503 on every message would be a wasted
    // round trip for a player who already has a problem.
    await openChat();
    type('anything');
    await waitFor(() => expect(tickets().length).toBe(1));
    expect(asks().length).toBe(0);
  });

  it('stops intercepting once a human thread is open', async () => {
    withAssistant({ success: true, grounded: true, answer: 'See our fees page.' });
    await openChat();
    type('what are the fees');
    await screen.findByText('See our fees page.');
    fireEvent.click(screen.getByText(/talk to a person/i));
    await waitFor(() => expect(tickets().length).toBe(1));

    // The player asked for a human. Answering them with a robot again is the
    // behaviour this file exists to prevent.
    const asksBefore = asks().length;
    type('still not resolved');
    await waitFor(() => expect(tickets().length).toBe(2));
    expect(asks().length).toBe(asksBefore);
    expect(tickets()[1][0]).toContain('/tickets/tkt-abcdef12/reply');
  });

  it('keeps the escalation offer alive when sending it fails', async () => {
    fetchMock.mockImplementation((url: string, init?: any) => {
      const u = String(url);
      if (u.endsWith('/api/support/status')) return jsonOnce({ success: true, enabled: true });
      if (u.endsWith('/api/support/ask')) return jsonOnce({ success: true, grounded: true, answer: 'Try again later.' });
      if (u.endsWith('/api/support/tickets') && init?.method === 'POST') return jsonOnce({ success: false, message: 'queue full' });
      return jsonOnce({ success: true, tickets: [] });
    });
    await openChat();
    type('urgent money problem');
    await screen.findByText('Try again later.');
    fireEvent.click(screen.getByText(/talk to a person/i));

    await waitFor(() => expect(screen.getByText('queue full')).toBeInTheDocument());
    // The way to a person must not vanish because one attempt failed.
    expect(screen.getByText(/talk to a person/i)).toBeInTheDocument();
  });
});
