// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The banner that gives `announcements` a reader.
 *
 * ── What this file is defending ─────────────────────────────────────────────
 * The admin panel has a full Announcements page — create, edit, expire,
 * delete — and `GET /api/announcements` serves the live ones to anybody. There
 * was no screen in the player panel that read it, so an operator wrote "buying
 * is paused for an hour", the platform stored it, and no player was ever shown
 * it. Fourteen rows were sitting in the database when this was found.
 *
 * That is §28's shape for the third time here, after the notification inbox
 * and the app-download links: an admin surface finished and a player surface
 * assumed. So these cases assert the things that make it a real consumer
 * rather than a component that exists — it FETCHES, it renders signed out, a
 * dismissal sticks, and a failing request leaves the page alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../services/apiUrl', () => ({ apiUrl: (p: string) => `https://api.test${p}` }));
const { default: AnnouncementBanner } = await import('./AnnouncementBanner');

const announcement = (over: Record<string, unknown> = {}) => ({
  announcementId: 'a-1', title: 'Buying is paused', body: 'Back within the hour.',
  kind: 'CRITICAL', priority: 10, ...over,
});

const reply = (announcements: unknown[]) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, announcements }) });

beforeEach(() => { localStorage.clear(); vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('AnnouncementBanner', () => {
  it('reads the live announcements and shows one', async () => {
    (fetch as any).mockReturnValue(reply([announcement()]));
    render(<AnnouncementBanner />);
    expect(await screen.findByText('Buying is paused')).toBeTruthy();
    expect(screen.getByText('Back within the hour.')).toBeTruthy();
    // The consumer half: it actually CALLS the route nothing was calling.
    expect((fetch as any).mock.calls[0][0]).toBe('https://api.test/api/announcements');
  });

  it('sends no credentials — the people who most need a service notice cannot sign in', async () => {
    (fetch as any).mockReturnValue(reply([announcement()]));
    render(<AnnouncementBanner />);
    await screen.findByText('Buying is paused');
    // One argument: no headers, no token. The route takes none.
    expect((fetch as any).mock.calls[0].length).toBe(1);
  });

  it('shows the highest-priority one only, not a stack', async () => {
    // The server orders by priority then recency; a column of banners pushes
    // the game off the screen.
    (fetch as any).mockReturnValue(reply([
      announcement({ announcementId: 'a-1', title: 'Most important' }),
      announcement({ announcementId: 'a-2', title: 'Less important' }),
    ]));
    render(<AnnouncementBanner />);
    expect(await screen.findByText('Most important')).toBeTruthy();
    expect(screen.queryByText('Less important')).toBeNull();
  });

  it('a dismissal sticks, and reveals the next one', async () => {
    (fetch as any).mockReturnValue(reply([
      announcement({ announcementId: 'a-1', title: 'First' }),
      announcement({ announcementId: 'a-2', title: 'Second' }),
    ]));
    render(<AnnouncementBanner />);
    await screen.findByText('First');
    await userEvent.click(screen.getByLabelText('Dismiss announcement'));
    expect(await screen.findByText('Second')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('dismissed_announcements')!)).toContain('a-1');
  });

  it('renders nothing when there is nothing live', async () => {
    (fetch as any).mockReturnValue(reply([]));
    const { container } = render(<AnnouncementBanner />);
    await waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
  });

  it('a failed request leaves the page alone', async () => {
    // An announcement is the least important thing on the screen. It must never
    // be the reason the game does not render.
    (fetch as any).mockRejectedValue(new Error('offline'));
    const { container } = render(<AnnouncementBanner />);
    await waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
  });
});
