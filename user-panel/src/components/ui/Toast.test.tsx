// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A toast is how the player app says no. "You already backed BOMBAY this
 * cycle", "Pick a chip or enter an amount first" and every other refusal on
 * the bet card are toasts, so one that is painted but not ANNOUNCED is a
 * refusal a screen-reader user never hears: they press the card and nothing
 * happens. Found by the browser drive (R4), which reads the same roles.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ToastProvider, useToast, TOAST_MS } from './Toast';

function Say({ message, type }: { message: string; type?: 'success' | 'error' | 'info' }) {
  const { addToast } = useToast();
  return <button onClick={() => addToast(message, type)}>say</button>;
}

describe('player toasts are announced', () => {
  it('an error is an alert', () => {
    render(<ToastProvider><Say message="You already backed BOMBAY this cycle" type="error" /></ToastProvider>);
    act(() => { screen.getByText('say').click(); });
    expect(screen.getByRole('alert').textContent).toContain('You already backed BOMBAY this cycle');
  });

  it('anything else is a status, inside a polite live region', () => {
    render(<ToastProvider><Say message="Bet placed" type="success" /></ToastProvider>);
    act(() => { screen.getByText('say').click(); });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Bet placed');
    expect(status.closest('[aria-live="polite"]')).not.toBeNull();
  });
});

describe('one notice at a time (owner, 2026-10-14)', () => {
  afterEach(() => { vi.useRealTimers(); });

  function Two() {
    const { addToast } = useToast();
    return (<>
      <button onClick={() => addToast('first', 'error')}>one</button>
      <button onClick={() => addToast('second', 'error')}>two</button>
    </>);
  }

  it('a new notice replaces the one on screen at once', () => {
    render(<ToastProvider><Two /></ToastProvider>);
    act(() => { screen.getByText('one').click(); });
    act(() => { screen.getByText('two').click(); });
    const shown = screen.getAllByRole('alert');
    expect(shown).toHaveLength(1);
    expect(shown[0].textContent).toContain('second');
  });

  it('the cross closes it', () => {
    render(<ToastProvider><Two /></ToastProvider>);
    act(() => { screen.getByText('one').click(); });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the last one goes by itself after TOAST_MS, counted from the newest', () => {
    vi.useFakeTimers();
    render(<ToastProvider><Two /></ToastProvider>);
    act(() => { screen.getByText('one').click(); });
    act(() => { vi.advanceTimersByTime(TOAST_MS - 100); });
    act(() => { screen.getByText('two').click(); });
    act(() => { vi.advanceTimersByTime(TOAST_MS - 100); });
    expect(screen.getByRole('alert').textContent).toContain('second');
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
