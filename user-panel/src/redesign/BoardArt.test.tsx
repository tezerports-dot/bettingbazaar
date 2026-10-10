// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A Home promo card opens its own link: an app page in place, https in a new
 * tab, and anything else not at all.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { cardHref, PromoCard, CitiesArt, HowToPlayArt } from './BoardArt';

describe('cardHref', () => {
  it('opens an app page in place and https in a new tab', () => {
    expect(cardHref('/referrals')).toEqual({ href: '#/referrals', external: false });
    expect(cardHref('https://t.me/x')).toEqual({ href: 'https://t.me/x', external: true });
  });
  it.each(['', null, undefined, 'javascript:alert(1)', 'http://x.example', '//evil.example'])('makes %s not clickable', (v) => {
    expect(cardHref(v as string)).toBeNull();
  });
});

describe('PromoCard', () => {
  const R = { w: 3, h: 1 };
  it('draws its image in the screen\'s own frame', () => {
    render(<PromoCard card={{ promoId: 'p0', title: 'Frame', image: 'https://cdn.example/f.png', ratio: { w: 18, h: 5 } }} />);
    expect(screen.getByRole('img', { name: 'Frame' }).style.aspectRatio).toBe('18 / 5');
  });
  it('is a link to its own page, named by its label', () => {
    render(<PromoCard card={{ promoId: 'p1', title: 'Refer & Earn', image: 'https://cdn.example/r.png', ratio: R, linkUrl: '/referrals' }} />);
    const a = screen.getByRole('link', { name: 'Refer & Earn' });
    expect(a).toHaveAttribute('href', '#/referrals');
    expect(a).not.toHaveAttribute('target');
  });
  it('opens an https link in a new tab, without handing it this window', () => {
    render(<PromoCard card={{ promoId: 'p2', title: 'Channel', image: 'https://cdn.example/c.png', ratio: R, linkUrl: 'https://t.me/x' }} />);
    const a = screen.getByRole('link', { name: 'Channel' });
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });
  it('is not a link when it has none', () => {
    render(<PromoCard card={{ promoId: 'p3', title: 'News', image: 'https://cdn.example/n.png', ratio: R }} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('img', { name: 'News' })).toBeInTheDocument();
  });
});

describe('side-column artwork', () => {
  it('draws both pieces with their captions', () => {
    render(<><CitiesArt /><HowToPlayArt /></>);
    expect(screen.getByRole('figure', { name: /India Gate/ })).toHaveTextContent('Two cities. One winner.');
    expect(screen.getByRole('figure', { name: /How a round is played/ })).toHaveTextContent('Pick · Tap · Win');
  });
});
