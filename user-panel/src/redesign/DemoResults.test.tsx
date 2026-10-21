// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** Demo results fill the analytics window behind the real ones, named nowhere on screen (owner, 2026-10-15). */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

let config: Record<string, unknown> = { demoResultsOn: true };
vi.mock('../services/backend.service', () => ({ getBackend: () => ({ getSystemConfig: () => Promise.resolve(config) }) }));

const { demoWinners, withDemoResults, typedDemoWinners } = await import('./DemoResults');
const { default: AnalyticsView } = await import('./AnalyticsView');

const board = { key: 'b1', name: 'One Minute', kind: 'INTERVAL' } as any;

describe('demo results', () => {
  it('are the same every time, and demo #n never changes as fewer are shown', () => {
    expect(demoWinners('b1', 1440)).toEqual(demoWinners('b1', 1440));
    expect(demoWinners('b1', 1000)).toEqual(demoWinners('b1', 1440).slice(0, 1000));
    const d = demoWinners('b1', 1440).filter((s) => s === 'DELHI').length;
    expect(d).toBeGreaterThan(600); expect(d).toBeLessThan(840);
  });

  it('fill the window after the real results; each real one pushes the oldest demo out', () => {
    const real = ['DELHI', 'BOMBAY', 'BOMBAY'] as const;
    const a = withDemoResults([...real], 'b1', 1440, true);
    expect(a.winners).toHaveLength(1440);
    expect(a.real).toBe(3);
    expect(a.winners.slice(0, 3)).toEqual(real);
    const b = withDemoResults(['DELHI', ...real], 'b1', 1440, true);
    expect(b.winners.slice(4)).toEqual(a.winners.slice(3, 1439));
    expect(withDemoResults(Array(1500).fill('DELHI'), 'b1', 1440, true)).toMatchObject({ real: 1440 });
    expect(withDemoResults([...real], 'b1', 1440, false).winners).toHaveLength(3);
  });

  it('the admin\'s typed results fill the window instead, newest typed one next to the oldest real', () => {
    // Typed oldest first: B, B, D (so D is the newest demo result).
    expect(typedDemoWinners('BBD', 5)).toEqual(['DELHI', 'BOMBAY', 'BOMBAY']);
    const out = withDemoResults(['BOMBAY'], 'b1', 1440, true, 'BBD');
    expect(out).toEqual({ winners: ['BOMBAY', 'DELHI', 'BOMBAY', 'BOMBAY'], real: 1 });
    // With a nearly full window only the newest typed ones are used.
    expect(withDemoResults(Array(1439).fill('DELHI'), 'b1', 1440, true, 'BBD').winners[1439]).toBe('DELHI');
    // Switched off, typed results are not shown either.
    expect(withDemoResults(['BOMBAY'], 'b1', 1440, false, 'BBD').winners).toEqual(['BOMBAY']);
  });

  it('typed results are drawn like the drawn ones, faded, for the profile shown', async () => {
    config = { demoResultsOn: true };
    const typed = { ...board, demoResults: { VIP: 'DDD', GENERAL: 'BB' } };
    render(<AnalyticsView board={typed} winners={['DELHI']} audience="GENERAL" />);
    expect(await screen.findByText(/^3 One Minute results$/)).toBeInTheDocument();
    expect(screen.getByTestId('run-strip').querySelectorAll('span[data-demo]').length).toBe(2);
  });

  it('the analytics show every result and do not mention demo results', async () => {
    render(<AnalyticsView board={board} winners={['DELHI', 'BOMBAY']} />);
    expect(await screen.findByText(/^1,440 One Minute results$/)).toBeInTheDocument();
    expect(screen.queryByText(/demo/i)).toBeNull();
    const strip = screen.getByTestId('run-strip');
    expect(strip.querySelectorAll('span[data-demo]').length).toBe(1438);
  });

  it('Probability reads the whole window, demo results included', async () => {
    config = { demoResultsOn: true };
    render(<AnalyticsView board={board} winners={['DELHI', 'BOMBAY']} />);
    await screen.findByText(/^1,440 One Minute results$/);
    fireEvent.click(screen.getByRole('tab', { name: 'Probability' }));
    expect(screen.queryByText(/Shown from \d+ results/)).toBeNull();
    expect(screen.getByText('DELHI next')).toBeInTheDocument();
  });

  it('switched off, nothing is filled', async () => {
    config = { demoResultsOn: false };
    render(<AnalyticsView board={board} winners={['DELHI', 'BOMBAY']} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(/^2 One Minute results$/)).toBeInTheDocument();
  });
});
