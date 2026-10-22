// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Curated winners carry a quiet tag on screen, its word the admin's; real wins carry none
 * (owner, 2026-10-22: the winners list can be uploaded as a CSV, so the
 * entries an admin types must never read as players' real wins).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { winners } = vi.hoisted(() => ({ winners: vi.fn() }));
vi.mock('../services/api', () => ({ platform: { winners } }));

import WinnersPage from './WinnersPage';

describe('WinnersPage', () => {
  it('marks curated entries with the server\'s word and leaves real wins unmarked', async () => {
    winners.mockResolvedValue({ success: true, winners: [
      { displayName: 'Real One', amount: 900, isReal: true },
      { displayName: 'Curated One', amount: 800, isReal: false },
      { displayName: 'Real Two', amount: 700, isReal: true },
      { displayName: 'Curated Two', amount: 600, isReal: false },
    ], demoLabel: 'Sample' });
    render(<WinnersPage />);
    expect(await screen.findByText('Curated Two')).toBeInTheDocument();
    expect(screen.getAllByText('Sample')).toHaveLength(2);
    expect(screen.getByText('Real One').textContent).toBe('Real One');
    expect(screen.getByText('Curated One').textContent).toBe('Curated OneSample');
  });
});
