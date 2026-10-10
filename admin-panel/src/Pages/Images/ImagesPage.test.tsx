// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin › Images, pressed. The promo card's per-screen images are proven
 * against a real database in database/tests/contentPg.test.js; this proves the
 * page shows the server's screens (sizes, places), previews a change before it
 * is saved, warns when an image's shape is not the frame's, and saves a card
 * with an entry for EVERY screen, so a removed image is removed.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), branding: { getCurrent: vi.fn(), update: vi.fn() } }));
vi.mock('../../services/api', () => ({ default: api }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
const sizes = vi.hoisted(() => ({ next: { w: 1200, h: 675 } as { w: number; h: number } | null }));
vi.mock('../../services/imageUpload', async (orig) => ({
  ...(await orig<typeof import('../../services/imageUpload')>()),
  naturalSize: () => Promise.resolve(sizes.next),
}));

import { PromoDeviceCards } from './PromoDeviceCards';
import { BrandingImages, BOARD_IMAGES } from './BrandingImages';

const DEVICES = [
  { key: 'LAPTOP', label: 'Laptop / desktop', minWidth: 1000, maxWidth: null, ratio: { w: 16, h: 9 }, upload: { w: 1200, h: 675 }, where: 'Side columns beside the game board.', examples: 'Laptops' },
  { key: 'PHONE', label: 'Phone', minWidth: 370, maxWidth: 679, ratio: { w: 3, h: 1 }, upload: { w: 1170, h: 390 }, where: 'Banner under the header.', examples: 'iPhone' },
];
const CARD = { promoId: 'c1', title: 'Diwali', linkUrl: '/referrals', priority: 2, status: 'PUBLISHED', images: { LAPTOP: 'https://cdn.test/l.png', PHONE: 'https://cdn.test/p.png' } };

beforeEach(() => {
  for (const f of [api.get, api.put, api.post, api.delete, api.branding.getCurrent, api.branding.update]) f.mockReset();
  api.get.mockResolvedValue({ data: { success: true, promos: [CARD], devices: DEVICES } });
  api.put.mockResolvedValue({ data: { success: true } });
  sizes.next = { w: 1200, h: 675 };
});

describe('Images › Promo cards', () => {
  it('lists the server\'s screens with the size to make each image and where it goes', async () => {
    render(<PromoDeviceCards />);
    expect(await screen.findByText('1200 × 675 px · 16:9')).toBeInTheDocument();
    expect(screen.getByText('1170 × 390 px · 3:1')).toBeInTheDocument();
    expect(screen.getByText(/370–679 px wide\. Banner under the header\./)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Diwali on Phone' })).toHaveAttribute('src', 'https://cdn.test/p.png');
  });

  it('previews a removed image as not saved, and saves every screen so the removal sticks', async () => {
    const user = userEvent.setup();
    render(<PromoDeviceCards />);
    await user.click(await screen.findByRole('button', { name: /Edit/ }));
    const removes = screen.getAllByRole('button', { name: /Remove/ });
    await user.click(removes[1]); // the phone image
    expect(screen.getByText('Not saved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Save card/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe('/api/admin/promo/c1');
    expect(body.images).toEqual({ LAPTOP: 'https://cdn.test/l.png', PHONE: '' });
    expect(body.status).toBe('PUBLISHED');
  });

  it('shows the server\'s refusal where the admin is looking', async () => {
    const user = userEvent.setup();
    api.put.mockRejectedValue({ response: { data: { message: 'A published card needs an image for at least one screen.' } } });
    render(<PromoDeviceCards />);
    await user.click(await screen.findByRole('button', { name: /Edit/ }));
    await user.click(screen.getByRole('button', { name: /Save card/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('needs an image for at least one screen');
  });

  it('warns before saving when an image is not the frame\'s shape', async () => {
    const user = userEvent.setup();
    sizes.next = { w: 1200, h: 675 }; // a laptop-shaped image…
    render(<PromoDeviceCards />);
    await user.click(await screen.findByRole('button', { name: /Edit/ }));
    // …in the 3:1 phone frame.
    expect(await screen.findByText(/The frame is 3:1, so its edges will be cut\. Make it 1170 × 390 px/)).toBeInTheDocument();
  });
});

describe('Images › Game board (Branding images)', () => {
  it('saves only the image that changed, as a patch', async () => {
    const user = userEvent.setup();
    api.branding.getCurrent.mockResolvedValue({ success: true, data: { betCardDelhiImageUrl: '', betCardBombayImageUrl: 'https://cdn.test/b.png', referPromoImageUrl: '', appName: 'X' } });
    api.branding.update.mockResolvedValue({ success: true });
    render(<BrandingImages fields={BOARD_IMAGES} title="Game board images" intro="" />);
    expect(await screen.findByRole('button', { name: 'Nothing to save' })).toBeDisabled();
    await user.click(screen.getAllByRole('button', { name: /Remove/ })[0]); // Bombay
    await user.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await waitFor(() => expect(api.branding.update).toHaveBeenCalledWith({ betCardBombayImageUrl: '' }));
  });
});
