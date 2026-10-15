// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** A tapped home card opens its own page: image, title, details, optional link. */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getHomeCards } = vi.hoisted(() => ({ getHomeCards: vi.fn() }));
vi.mock('../services/backend.service', () => ({
  getBackend: () => ({ getHomeCards }),
  getAssetUrl: (p: string) => p,
}));

import PromoCardPage from './PromoCardPage';

const devices = [
  { key: 'LAPTOP', label: 'Laptop', minWidth: 1024, maxWidth: null, ratio: { w: 3, h: 4 } },
  { key: 'PHONE', label: 'Phone', minWidth: 0, maxWidth: 1023, ratio: { w: 3, h: 1 } },
];

const at = (id: string) => render(
  <MemoryRouter initialEntries={[`/card/${id}`]}>
    <Routes><Route path="/card/:promoId" element={<PromoCardPage />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => getHomeCards.mockReset());

describe('PromoCardPage', () => {
  it('shows the card image, title, details and its link as a button', async () => {
    getHomeCards.mockResolvedValue({ devices, cards: [{
      promoId: 'c1', title: 'Diwali bonus', description: 'Deposit this weekend.\nEnds Sunday.',
      linkUrl: '/wallet', images: { LAPTOP: 'https://cdn.example/l.png' },
    }] });
    at('c1');
    expect(await screen.findByRole('heading', { name: 'Diwali bonus' })).toBeInTheDocument();
    // No image for this screen: the first screen it has one for.
    expect(screen.getByRole('img', { name: 'Diwali bonus' })).toHaveAttribute('src', 'https://cdn.example/l.png');
    expect(screen.getByText(/Deposit this weekend/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go there' })).toHaveAttribute('href', '#/wallet');
  });

  it('has no button when the card has no link', async () => {
    getHomeCards.mockResolvedValue({ devices, cards: [{ promoId: 'c2', title: 'News', linkUrl: null, images: { PHONE: 'p.png' } }] });
    at('c2');
    expect(await screen.findByRole('heading', { name: 'News' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says so when the card is gone', async () => {
    getHomeCards.mockResolvedValue({ devices, cards: [] });
    at('missing');
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer available');
  });
});
