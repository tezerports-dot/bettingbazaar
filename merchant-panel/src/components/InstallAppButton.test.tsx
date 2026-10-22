// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * "Install app" in the merchant panel (owner, 2026-10-21): offered in the
 * browser when it kept an install prompt, explained on an iPhone, and never
 * shown inside the installed app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const setStandalone = (on: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: on && q.includes('standalone'), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
};

describe('Install app', () => {
  beforeEach(() => { vi.resetModules(); setStandalone(false); });
  afterEach(() => { vi.restoreAllMocks(); });

  const load = async () => {
    const prompt = await import('../services/installPrompt');
    prompt.listenForInstallPrompt();
    const { default: InstallAppButton } = await import('./InstallAppButton');
    return { prompt, InstallAppButton };
  };
  const offer = (outcome: 'accepted' | 'dismissed') => {
    const e = Object.assign(new Event('beforeinstallprompt'), {
      prompt: vi.fn().mockResolvedValue(undefined), userChoice: Promise.resolve({ outcome }),
    });
    act(() => { window.dispatchEvent(e); });
    return e;
  };

  it('shows the browser\'s prompt from a tap, and goes once installed', async () => {
    const { InstallAppButton } = await load();
    render(<InstallAppButton />);
    expect(screen.queryByRole('button', { name: /Install app/ })).not.toBeInTheDocument();
    const e = offer('accepted');
    const button = await screen.findByRole('button', { name: /Install app/ });
    await act(async () => { fireEvent.click(button); });
    expect(e.prompt).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Install app/ })).not.toBeInTheDocument();
  });

  it('is never shown inside the installed app (the opposite case)', async () => {
    setStandalone(true);
    const { InstallAppButton } = await load();
    render(<InstallAppButton />);
    offer('dismissed');
    expect(screen.queryByRole('button', { name: /Install app/ })).not.toBeInTheDocument();
  });
});
