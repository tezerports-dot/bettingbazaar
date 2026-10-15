// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** Demo results fill the analytics window behind the real ones, labelled (owner, 2026-10-15). */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let config: Record<string, unknown> = { demoResultsOn: true, demoResultsLabel: 'Includes demo results.' };
vi.mock('../services/backend.service', () => ({ getBackend: () => ({ getSystemConfig: () => Promise.resolve(config) }) }));

const { demoWinners, withDemoResults } = await import('./DemoResults');
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

  it('the analytics say so with the admin line, and show every result', async () => {
    render(<AnalyticsView board={board} winners={['DELHI', 'BOMBAY']} />);
    expect(await screen.findByTestId('demo-results-note')).toHaveTextContent('Includes demo results. (1,438 demo)');
    expect(screen.getByText(/1,440 One Minute results · 1,438 demo/)).toBeInTheDocument();
    const strip = screen.getByTestId('run-strip');
    expect(strip.querySelectorAll('span[data-demo]').length).toBe(1438);
  });

  it('switched off, nothing is filled and no line is shown', async () => {
    config = { demoResultsOn: false, demoResultsLabel: 'Includes demo results.' };
    render(<AnalyticsView board={board} winners={['DELHI', 'BOMBAY']} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('demo-results-note')).toBeNull();
    expect(screen.getByText(/^2 One Minute results$/)).toBeInTheDocument();
  });
});
