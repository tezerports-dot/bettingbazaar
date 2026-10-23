// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A branding image saved on Admin › Images shows on an open screen at once
 * (useBranding), not on the screen's next mount. The screens read the cache
 * once per render, so a saved banner waited for a reload.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { applyBranding, useBranding } from './branding';

const Banner: React.FC = () => {
  const b = useBranding();
  const url = String(b.rulesPageImageUrl || '');
  return url ? <img alt="banner" src={url} /> : <p>no banner</p>;
};

describe('useBranding', () => {
  beforeEach(() => localStorage.clear());

  it('draws the cached image on mount', () => {
    localStorage.setItem('app_branding', JSON.stringify({ rulesPageImageUrl: 'https://cdn.test/a.png' }));
    render(<Banner />);
    expect(screen.getByAltText('banner').getAttribute('src')).toBe('https://cdn.test/a.png');
  });

  it('redraws an open screen when a new document is applied', () => {
    render(<Banner />);
    expect(screen.getByText('no banner')).toBeTruthy();
    act(() => applyBranding({ palette: 'GOLD', rulesPageImageUrl: 'https://cdn.test/new.png' }));
    expect(screen.getByAltText('banner').getAttribute('src')).toBe('https://cdn.test/new.png');
  });

  it('takes an image away when the admin removes it', () => {
    localStorage.setItem('app_branding', JSON.stringify({ rulesPageImageUrl: 'https://cdn.test/a.png' }));
    render(<Banner />);
    act(() => applyBranding({ palette: 'GOLD', rulesPageImageUrl: '' }));
    expect(screen.getByText('no banner')).toBeTruthy();
  });
});
