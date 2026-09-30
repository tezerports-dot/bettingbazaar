// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * This screen could not save anything, and these are the two assertions that
 * would have said so.
 *
 * It kept its own list of ten fields; `SUPPORT_LINKS_SPEC` declares twelve
 * different ones. Four the form offered were never declared (facebook, twitter,
 * supportHours, responseTime) and six declared ones were unreachable
 * (telegramUsername, telegramGroupUrl, telegramChannelUrl, helpCenterUrl,
 * termsUrl, privacyUrl).
 *
 * The PUT is ONE patch validated as a whole, so the first undeclared key
 * refuses the entire save. Driven in a browser: typing a support email and
 * pressing Save answered 400 with "refusing to write undeclared setting
 * 'facebook'" — about a field the admin never touched — and the email went with
 * it. Every support channel a player sees was unreachable.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { getSupportLinks, updateSupportLinks } = vi.hoisted(() => ({
  getSupportLinks: vi.fn(), updateSupportLinks: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  default: { content: { getSupportLinks, updateSupportLinks } },
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { SupportLinks } from './SupportLinks';

/** Exactly what `GET /api/admin/content/support-links` returns — spec keys plus row metadata. */
const DOC = {
  whatsapp: '', telegram: '', telegramUsername: '', telegramGroupUrl: '', telegramChannelUrl: '',
  instagram: '', youtube: '', email: '', phone: '',
  helpCenterUrl: '', termsUrl: '', privacyUrl: '',
  key: 'main', version: 3, updatedAt: '2026-09-17T00:00:00.000Z', updatedBy: 'someone',
};

beforeEach(() => {
  getSupportLinks.mockReset(); updateSupportLinks.mockReset();
  getSupportLinks.mockResolvedValue({ success: true, data: DOC });
  updateSupportLinks.mockResolvedValue({ success: true });
});

describe('SupportLinks edits exactly what the server declares', () => {
  it('offers a field for every declared setting, including the three no admin could reach', async () => {
    render(<SupportLinks />);
    for (const label of [/Terms & conditions/i, /Privacy policy/i, /Help centre/i,
                         /Telegram channel/i, /Telegram group/i, /^Phone/i]) {
      expect(await screen.findByLabelText(label)).toBeInTheDocument();
    }
  });

  it('offers NO field the spec does not declare — the whole reason Save failed', async () => {
    render(<SupportLinks />);
    await screen.findByLabelText(/^Email/i);
    for (const gone of [/facebook/i, /twitter/i, /support hours/i, /response time/i]) {
      expect(screen.queryByLabelText(gone)).toBeNull();
    }
  });

  it('sends back only keys the server sent — row metadata is not a setting', async () => {
    const user = userEvent.setup();
    render(<SupportLinks />);
    await user.type(await screen.findByLabelText(/^Email/i), 'support@bb.test');
    await user.click(screen.getByRole('button', { name: /Save support links/i }));

    await waitFor(() => expect(updateSupportLinks).toHaveBeenCalled());
    const sent = updateSupportLinks.mock.calls[0][0];
    expect(sent.email).toBe('support@bb.test');
    // `version`/`updatedBy` are the row's own columns. Sending them back is how
    // an "undeclared setting" refusal happens, which is this whole defect.
    for (const meta of ['key', 'version', 'updatedAt', 'updatedBy']) {
      expect(sent).not.toHaveProperty(meta);
    }
    expect(Object.keys(sent).sort()).toEqual(
      Object.keys(DOC).filter((k) => !['key', 'version', 'updatedAt', 'updatedBy'].includes(k)).sort());
  });

  it('a key the server adds tomorrow renders without anybody editing this screen', async () => {
    getSupportLinks.mockResolvedValue({ success: true, data: { ...DOC, responsibleGamingUrl: '' } });
    render(<SupportLinks />);
    // Humanised from its own name, because the label table does not know it yet.
    expect(await screen.findByLabelText(/Responsible Gaming/i)).toBeInTheDocument();
  });
});
