// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Pull to refresh (owner, 2026-10-15): a pull down from the top past the
 * threshold refreshes; a short pull, a sideways swipe, a pull from mid-page
 * or a laptop does not.
 */
import React, { useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { usePullToRefresh, PullIndicator, PULL_THRESHOLD, refreshApp } from './PullToRefresh';

let coarse = true;
beforeEach(() => {
  coarse = true;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' ? coarse : false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const Harness: React.FC<{ onRefresh: () => void }> = ({ onRefresh }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const { pull, refreshing } = usePullToRefresh(ref, onRefresh);
  return (
    <div ref={ref} data-testid="scroller">
      <PullIndicator pull={pull} refreshing={refreshing} />
      <div data-testid="inner">content</div>
    </div>
  );
};

const touch = (el: Element, type: string, x: number, y: number) => {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as any;
  ev.touches = type === 'touchend' ? [] : [{ clientX: x, clientY: y }];
  act(() => { el.dispatchEvent(ev); });
  return ev as Event;
};

const drag = (el: Element, dx: number, dy: number) => {
  touch(el, 'touchstart', 100, 100);
  touch(el, 'touchmove', 100 + dx / 2, 100 + dy / 2);
  const move = touch(el, 'touchmove', 100 + dx, 100 + dy);
  touch(el, 'touchend', 0, 0);
  return move;
};

describe('pull to refresh', () => {
  it('refreshes after a pull past the threshold, holding the page still while pulling', async () => {
    const onRefresh = vi.fn(() => new Promise<void>(() => {}));
    render(<Harness onRefresh={onRefresh} />);
    const inner = screen.getByTestId('inner');
    touch(inner, 'touchstart', 100, 100);
    touch(inner, 'touchmove', 100, 130);
    const move = touch(inner, 'touchmove', 100, 100 + PULL_THRESHOLD * 2 + 10);
    expect(move.defaultPrevented).toBe(true);
    expect(screen.getByTestId('pull-indicator')).toBeTruthy();
    touch(inner, 'touchend', 0, 0);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status', { name: 'Refreshing' })).toBeTruthy();
  });

  it('does nothing for a short pull', () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    drag(screen.getByTestId('inner'), 0, PULL_THRESHOLD);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pull-indicator')).toBeNull();
  });

  it('leaves a sideways swipe alone', () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const move = drag(screen.getByTestId('inner'), 300, 200);
    expect(move.defaultPrevented).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('leaves a page that is scrolled down alone', () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    screen.getByTestId('scroller').scrollTop = 50;
    drag(screen.getByTestId('inner'), 0, 400);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('is off on a laptop', () => {
    coarse = false;
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    drag(screen.getByTestId('inner'), 0, 400);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('asks the service worker for a newer build, lets it take over, then reloads', async () => {
    const waiting = { postMessage: vi.fn() };
    const reg = { update: vi.fn(async () => undefined), waiting };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => reg } });
    const reload = vi.fn();
    const realLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });
    try {
      await refreshApp();
      expect(reg.update).toHaveBeenCalled();
      expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
      delete (navigator as any).serviceWorker;
    }
  });
});
