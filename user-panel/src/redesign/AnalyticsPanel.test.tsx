// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Tapping an analytics button lights that button alone (owner, 2026-10-14:
 * "probability and streaks are flickering"). The smooth scroll to its slide
 * passes over the slides in between; their buttons must not light on the way.
 * A swipe still moves the button.
 */
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AnalyticsPanel from './AnalyticsPanel';

const WIDTH = 300;
let scrolls: number[] = [];

beforeEach(() => {
  scrolls = [];
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => WIDTH });
  (HTMLElement.prototype as any).scrollTo = function scrollTo(opts: { left?: number }) {
    if (typeof opts?.left === 'number') scrolls.push(opts.left);
  };
});

const track = () => document.getElementById('bb-an-results')!.parentElement as HTMLElement;
const scrollTrackTo = (left: number) => { track().scrollLeft = left; fireEvent.scroll(track()); };
const lit = () => screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);

describe('the analytics buttons', () => {
  it('keep the tapped button lit while its slide scrolls into view', () => {
    render(<AnalyticsPanel winners={['DELHI', 'BOMBAY', 'DELHI']} loadCycleHistory={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Probability' }));
    expect(scrolls[scrolls.length - 1]).toBe(4 * WIDTH);
    for (const left of [WIDTH * 0.6, WIDTH * 1.5, WIDTH * 2.5, WIDTH * 3.4]) {
      scrollTrackTo(left);
      expect(lit()).toEqual(['Probability']);
    }
    scrollTrackTo(4 * WIDTH);
    expect(lit()).toEqual(['Probability']);
  });

  it('follow a swipe once the tapped slide is reached', () => {
    render(<AnalyticsPanel winners={['DELHI', 'BOMBAY', 'DELHI']} loadCycleHistory={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Continuous streaks' }));
    scrollTrackTo(WIDTH);
    scrollTrackTo(2 * WIDTH);
    expect(lit()).toEqual(['Streak gaps']);
  });

  it('follow a swipe when nothing was tapped', () => {
    render(<AnalyticsPanel winners={['DELHI']} loadCycleHistory={() => {}} />);
    scrollTrackTo(3 * WIDTH);
    expect(lit()).toEqual(['Win share']);
  });
});
