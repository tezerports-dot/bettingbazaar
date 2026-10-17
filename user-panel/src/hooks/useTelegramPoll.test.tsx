// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The poll asks every TELEGRAM_POLL_MS, and at once when the page comes back
 * in front (the player returning from Verify in Telegram).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTelegramPoll, TELEGRAM_POLL_MS } from './useTelegramPoll';

afterEach(() => { vi.useRealTimers(); });

describe('useTelegramPoll', () => {
  it('asks at once when the page is shown again, not only at the next tick', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue('done');
    const onDone = vi.fn();
    renderHook(() => useTelegramPoll(poll, onDone, vi.fn()));
    expect(poll).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(TELEGRAM_POLL_MS * 3); });
    expect(poll).toHaveBeenCalledTimes(1);   // stopped once done
  });

  it('stops listening when the screen goes away', async () => {
    const poll = vi.fn().mockResolvedValue('pending');
    const { unmount } = renderHook(() => useTelegramPoll(poll, vi.fn(), vi.fn()));
    unmount();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    expect(poll).not.toHaveBeenCalled();
  });
});
