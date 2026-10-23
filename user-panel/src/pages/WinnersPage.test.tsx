// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Curated winners carry no tag on screen (owner, 2026-10-23: "remove that
 * label from admin created winners"): every entry reads as its name alone.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { winners } = vi.hoisted(() => ({ winners: vi.fn() }));
vi.mock('../services/api', () => ({ platform: { winners } }));

import WinnersPage from './WinnersPage';

describe('WinnersPage', () => {
  it('shows curated and real entries alike, with no tag beside either', async () => {
    winners.mockResolvedValue({ success: true, winners: [
      { displayName: 'Real One', amount: 900, isReal: true },
      { displayName: 'Curated One', amount: 800, isReal: false },
      { displayName: 'Real Two', amount: 700, isReal: true },
      { displayName: 'Curated Two', amount: 600, isReal: false },
    ] });
    render(<WinnersPage />);
    expect(await screen.findByText('Curated Two')).toBeInTheDocument();
    expect(screen.getByText('Curated One').textContent).toBe('Curated One');
    expect(screen.getByText('Real One').textContent).toBe('Real One');
    expect(screen.queryByText('Demo')).toBeNull();
  });
});
