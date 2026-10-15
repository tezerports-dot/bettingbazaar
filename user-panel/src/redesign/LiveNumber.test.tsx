// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** Live pool figures count up to each new figure instead of jumping (owner, 2026-10-15). */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { LiveNumber, COUNT_MS } from './LiveNumber';

afterEach(() => { vi.useRealTimers(); });

describe('LiveNumber', () => {
  it('shows the first figure as it is, then counts up to the next one', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const { rerender } = render(<span data-testid="n"><LiveNumber value={1000} /></span>);
    expect(screen.getByTestId('n').textContent).toBe('1,000');
    rerender(<span data-testid="n"><LiveNumber value={2000} /></span>);
    act(() => { vi.advanceTimersByTime(COUNT_MS / 3); });
    const mid = Number(screen.getByTestId('n').textContent!.replace(/,/g, ''));
    expect(mid).toBeGreaterThan(1000);
    expect(mid).toBeLessThan(2000);
    act(() => { vi.advanceTimersByTime(COUNT_MS); });
    expect(screen.getByTestId('n').textContent).toBe('2,000');
  });

  it('shows a smaller figure (a new round) at once', () => {
    const { rerender } = render(<span data-testid="n"><LiveNumber value={5000} /></span>);
    rerender(<span data-testid="n"><LiveNumber value={0} /></span>);
    expect(screen.getByTestId('n').textContent).toBe('0');
  });
});
