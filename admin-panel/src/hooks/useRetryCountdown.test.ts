// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The timer a throttled operator watches.
 *
 * A countdown that is wrong is worse than no countdown: it says "0s" while the
 * server still refuses, so the operator retries, is refused again, and now
 * believes the login is broken rather than paced. Three ways it could be wrong,
 * and one test each.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRetryCountdown, readPacedError } from './useRetryCountdown';

const axios429 = (data: Record<string, unknown>) => ({ response: { status: 429, data } });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('readPacedError', () => {
  it('recognises a 429 from axios and from a fetch-style error', () => {
    expect(readPacedError(axios429({ retryAfter: 10 }))).toEqual({ retryAfter: 10 });
    expect(readPacedError({ status: 429, data: { retryAfter: 3 } })).toEqual({ retryAfter: 3 });
  });

  it('ignores an ordinary credential failure', () => {
    // A pace refusal must never be reported as "check your credentials" — that
    // sends an admin to reset a password that was never wrong.
    expect(readPacedError({ response: { status: 401, data: { message: 'Bad password' } } })).toBeNull();
    expect(readPacedError(new Error('network'))).toBeNull();
    expect(readPacedError(undefined)).toBeNull();
  });
});

describe('useRetryCountdown', () => {
  it('counts down from the absolute instant, not the seconds', () => {
    // `retryAfter` starts ageing the moment the server writes it. Here the
    // response spent 4 seconds in flight: trusting `retryAfter` would show 10
    // and finish 4 seconds before the server is ready.
    const { result } = renderHook(() => useRetryCountdown());
    act(() => {
      result.current.startFrom(axios429({
        retryAfter: 10,
        retryAt: new Date(Date.now() + 6_000).toISOString(),
      }));
    });
    expect(result.current.secondsLeft).toBe(6);
    expect(result.current.blocked).toBe(true);
  });

  it('falls back to retryAfter when no instant is sent', () => {
    const { result } = renderHook(() => useRetryCountdown());
    act(() => { result.current.startFrom(axios429({ retryAfter: 7 })); });
    expect(result.current.secondsLeft).toBe(7);
  });

  it('reaches zero and unblocks', async () => {
    const { result } = renderHook(() => useRetryCountdown());
    act(() => {
      result.current.startFrom(axios429({ retryAt: new Date(Date.now() + 3_000).toISOString() }));
    });
    expect(result.current.blocked).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(result.current.secondsLeft).toBe(0);
    expect(result.current.blocked).toBe(false);
  });

  it('recomputes from the deadline rather than decrementing', async () => {
    // A decrementing counter drifts whenever the tab is backgrounded and the
    // browser throttles timers — it would still be counting down long after the
    // server was ready. Here the clock jumps while only one tick fires.
    const { result } = renderHook(() => useRetryCountdown());
    act(() => {
      result.current.startFrom(axios429({ retryAt: new Date(Date.now() + 10_000).toISOString() }));
    });
    expect(result.current.secondsLeft).toBe(10);

    await act(async () => {
      vi.setSystemTime(new Date(Date.now() + 8_000));
      await vi.advanceTimersByTimeAsync(300);
    });
    // 2, not 9 — the deadline is the truth, not the number of ticks observed.
    expect(result.current.secondsLeft).toBe(2);
  });

  it('keeps the LATER deadline when two refusals overlap', async () => {
    const { result } = renderHook(() => useRetryCountdown());
    act(() => {
      result.current.startFrom(axios429({ retryAt: new Date(Date.now() + 9_000).toISOString() }));
    });
    act(() => {
      // A shorter one arriving second must not release the button early.
      result.current.startFrom(axios429({ retryAt: new Date(Date.now() + 2_000).toISOString() }));
    });
    expect(result.current.secondsLeft).toBe(9);
  });

  it('reports false for a non-pace error so the caller still toasts it', () => {
    const { result } = renderHook(() => useRetryCountdown());
    let handled = true;
    act(() => { handled = result.current.startFrom(new Error('Invalid authentication code')); });
    expect(handled).toBe(false);
    expect(result.current.blocked).toBe(false);
  });
});
