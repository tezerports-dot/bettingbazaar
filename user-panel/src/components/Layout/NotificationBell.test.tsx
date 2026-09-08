// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The bell shows a player the notices the platform wrote for them.
 *
 * ── What this is guarding ───────────────────────────────────────────────────
 * The write side already worked: `notify()` persists a row when an admin blocks
 * or unblocks an account, and the channel that writes it called its destination
 * "the existing bell-icon inbox all three panels already read". No panel read
 * it. A blocked player was handed an explanation they could never see.
 *
 * So the assertions here are about REACHING the endpoints and about the message
 * body — not about pixels. A bell that renders titles and drops the message
 * would satisfy a weaker test and still leave the player asking why.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const API = 'https://api.test';
vi.mock('../../services/apiUrl', () => ({ apiUrl: (p: string) => `${API}${p}` }));

import NotificationBell from './NotificationBell';

const fetchMock = vi.fn();
const json = (body: any) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as any);

const NOTES = [
  { id: 2, type: 'ERROR', title: 'Account Blocked', message: 'Suspicious deposit pattern.', isRead: false, createdAt: new Date().toISOString() },
  { id: 1, type: 'SUCCESS', title: 'Account Unblocked', message: 'You can play again.', isRead: true, createdAt: new Date(Date.now() - 7200e3).toISOString() },
];

const route = (over: Record<string, any> = {}) => {
  fetchMock.mockImplementation((url: string, init?: any) => {
    const u = String(url);
    if (u.endsWith('/unread-count')) return json(over.count ?? { success: true, unreadCount: 1 });
    if (u.endsWith('/notifications/read')) return json(over.read ?? { success: true, marked: 1 });
    if (u.endsWith('/api/user/notifications')) return json(over.list ?? { success: true, notifications: NOTES, unreadCount: 1 });
    return json({ success: true });
  });
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.setItem('auth_token', 't0ken');
  route();
});
afterEach(() => vi.unstubAllGlobals());

const bell = () => screen.getByRole('button', { name: /Notifications/i });

describe('the notification bell', () => {
  it('renders nothing for a signed-out visitor, and asks for nothing', () => {
    render(<NotificationBell isAuthenticated={false} />);
    expect(screen.queryByRole('button', { name: /Notifications/i })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('polls only the count, not the whole list, to render the badge', async () => {
    render(<NotificationBell isAuthenticated />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls).toContain(`${API}/api/user/notifications/unread-count`);
    // Fetching fifty rows to show one integer is the read that looks free.
    expect(urls).not.toContain(`${API}/api/user/notifications`);
    expect(await screen.findByText('1')).toBeInTheDocument();
  });

  it('shows the message, which is where "why" lives', async () => {
    render(<NotificationBell isAuthenticated />);
    fireEvent.click(bell());
    expect(await screen.findByText('Account Blocked')).toBeInTheDocument();
    expect(screen.getByText('Suspicious deposit pattern.')).toBeInTheDocument();
  });

  it('loads the list only when the panel is opened', async () => {
    render(<NotificationBell isAuthenticated />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fetchMock.mockClear();
    fireEvent.click(bell());
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((c: any[]) => String(c[0]))).toContain(`${API}/api/user/notifications`));
  });

  it('does not clear the badge merely because the panel was opened', async () => {
    // The badge is the only thing that brings a player back to an unread
    // notice. Clearing it on open marks something read that nobody read.
    render(<NotificationBell isAuthenticated />);
    fireEvent.click(bell());
    await screen.findByText('Account Blocked');
    expect(fetchMock.mock.calls.some(([, i]: any[]) => i?.method === 'POST')).toBe(false);
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('keeps the badge when the panel opens and the list fails', async () => {
    // The case that separates "clear it optimistically on open" from "let the
    // server's count decide": with the list unavailable there is no response to
    // restore the number, so an optimistic clear leaves the player told they
    // have nothing while an unread notice sits there.
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith('/unread-count')) return json({ success: true, unreadCount: 1 });
      return Promise.reject(new Error('offline'));
    });
    render(<NotificationBell isAuthenticated />);
    expect(await screen.findByText('1')).toBeInTheDocument();

    fireEvent.click(bell());
    expect(await screen.findByText(/offline/i)).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('marks everything read on request', async () => {
    render(<NotificationBell isAuthenticated />);
    fireEvent.click(bell());
    fireEvent.click(await screen.findByText(/Mark all read/i));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, i]: any[]) => i?.method === 'POST');
      expect(post, 'no POST to mark notifications read').toBeTruthy();
      expect(String(post![0])).toBe(`${API}/api/user/notifications/read`);
    });
    await waitFor(() => expect(screen.queryByText('1')).toBeNull());
  });

  it('puts the badge back when marking read fails', async () => {
    // A badge that clears on a failed write tells the player they have seen
    // something they have not.
    route({ read: { success: false, message: 'nope' } });
    render(<NotificationBell isAuthenticated />);
    fireEvent.click(bell());
    fireEvent.click(await screen.findByText(/Mark all read/i));

    expect(await screen.findByText('nope')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('keeps the last known count when a poll fails', async () => {
    // The badge polls once a minute, so a real timer has to be advanced for the
    // failing poll to happen at all — waiting a few milliseconds and asserting
    // passes whether or not the failure is handled.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<NotificationBell isAuthenticated />);
      await vi.waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());

      // "Nothing for you" is a claim, and a network blip is not evidence for it.
      const pollsBefore = fetchMock.mock.calls.length;
      fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
      await vi.advanceTimersByTimeAsync(61_000);

      // waitFor (not a bare assertion) so React has flushed the state the
      // failed poll would have set. Asserting straight after advancing the
      // clock passes whether or not the handler zeroed the badge, because the
      // re-render has not happened yet.
      await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(pollsBefore));
      await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the inbox is empty rather than looking broken', async () => {
    route({ list: { success: true, notifications: [], unreadCount: 0 }, count: { success: true, unreadCount: 0 } });
    render(<NotificationBell isAuthenticated />);
    fireEvent.click(bell());
    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();
  });

  it('caps a runaway badge instead of stretching the header', async () => {
    route({ count: { success: true, unreadCount: 4321 } });
    render(<NotificationBell isAuthenticated />);
    expect(await screen.findByText('99+')).toBeInTheDocument();
  });
});
