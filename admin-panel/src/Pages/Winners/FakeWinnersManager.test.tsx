// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * You can type a whole word into this form.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * The field component was declared INSIDE `FakeWinnersManager`, so it was a new
 * component TYPE on every parent render. React cannot reconcile that: it
 * unmounts the old `<input>` and mounts a fresh one. Typing calls `setForm`,
 * which renders the parent, which remounts the field, which takes the caret
 * with it — so every keystroke after the first went to `<body>`.
 *
 * Measured in Chromium before the fix: typing "Rahul" left the field holding
 * "R", focus on `<body>`. The same test on `/game-providers`, whose field
 * component was already at module level, kept all five characters — the control
 * case, which is what made the cause certain rather than suspected.
 *
 * Nothing could have caught it below this level. The component renders
 * correctly, every keystroke is "handled", and a test that types ONE character
 * passes. It needs a real caret and more than one letter (§28).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { get, post, put, del } = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(),
}));
vi.mock('../../services/api', () => ({ default: { get, post, put, delete: del } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { FakeWinnersManager } from './FakeWinnersManager';

beforeEach(() => {
  get.mockReset(); post.mockReset(); put.mockReset(); del.mockReset();
  get.mockResolvedValue({ data: { success: true, winners: [] } });
  post.mockResolvedValue({ data: { success: true } });
  put.mockResolvedValue({ data: { success: true } });
  del.mockResolvedValue({ data: { success: true } });
  vi.stubGlobal('confirm', () => true);
});

describe('FakeWinnersManager keeps the caret while you type', () => {
  it('a whole name reaches the field, not just its first letter', async () => {
    const user = userEvent.setup();
    render(<FakeWinnersManager />);

    await user.click(await screen.findByRole('button', { name: /Add Winner/i }));

    // Addressed BY ITS LABEL — which is also the fix for the 202 controls the
    // browser pass found with no accessible name at all.
    const name = await screen.findByLabelText(/Display Name/i);
    await user.type(name, 'Rahul');
    expect(name).toHaveValue('Rahul');

    // Focus stays put. Losing it is the mechanism; the truncated value is only
    // the symptom, and asserting the symptom alone would pass on a fix that
    // merely re-focused after each keystroke.
    expect(name).toHaveFocus();
  });

  it('a second field is independent — one field is not every field', async () => {
    const user = userEvent.setup();
    render(<FakeWinnersManager />);
    await user.click(await screen.findByRole('button', { name: /Add Winner/i }));

    await user.type(await screen.findByLabelText(/Display Name/i), 'Rahul');
    await user.type(await screen.findByLabelText(/^City/i), 'Mumbai');

    expect(await screen.findByLabelText(/Display Name/i)).toHaveValue('Rahul');
    expect(await screen.findByLabelText(/^City/i)).toHaveValue('Mumbai');
  });

  it('what is typed is what is sent', async () => {
    const user = userEvent.setup();
    render(<FakeWinnersManager />);
    await user.click(await screen.findByRole('button', { name: /Add Winner/i }));

    await user.type(await screen.findByLabelText(/Display Name/i), 'Rahul');
    await user.type(await screen.findByLabelText(/Amount Won/i), '50000');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    expect(post).toHaveBeenCalled();
    const [, body] = post.mock.calls[0];
    // The old behaviour would have posted "R" and 5 — a winner named after one
    // letter, for five rupees.
    expect(body.displayName).toBe('Rahul');
    expect(body.amount).toBe(50000);
  });
});

/**
 * The id is `id`, and every control that names one must use it.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * `toFakeWinner` emits `id, displayName, profilePic, city, amount, …` and has
 * never emitted an `_id`. This screen read `_id` on every row, so Edit, Delete
 * and the visibility toggle all built `/api/admin/fake-winners/undefined`.
 *
 * Not even a 404: the column is an INTEGER, `Number('undefined')` is NaN, and
 * PostgreSQL refuses the parameter — so the route answered **500**, which
 * `serverError` answers with nothing (§2). Measured live: `PUT .../undefined`
 * -> 500, `PUT .../1` -> 200.
 *
 * Edit was the quiet one. `setEditId(undefined)` makes Save take the CREATE
 * branch, so editing an entry silently added a second copy of it.
 *
 * These assert on the URL, because the URL is what was wrong; a test that only
 * checked "a request was made" passed throughout.
 */
describe('FakeWinnersManager identifies a winner by its id', () => {
  const WINNER = {
    id: 7, displayName: 'Rahul K.', profilePic: '', city: 'Mumbai', amount: 50000,
    game: 'Delhi/Bombay', badge: '', userId: null, isPublic: true, sortOrder: 0,
    displayTime: '2026-09-17T00:00:00.000Z', createdBy: 'admin', createdAt: '2026-09-17T00:00:00.000Z',
  };
  const listed = () => get.mockResolvedValue({ data: { success: true, winners: [WINNER] } });

  it('Delete asks the server to delete THAT winner', async () => {
    listed();
    const user = userEvent.setup();
    render(<FakeWinnersManager />);
    await screen.findByText('Rahul K.');

    await user.click(screen.getByTitle('Delete Rahul K.'));

    await waitFor(() => expect(del).toHaveBeenCalled());
    expect(del.mock.calls[0][0]).toBe('/api/admin/fake-winners/7');
    expect(del.mock.calls[0][0]).not.toContain('undefined');
  });

  it('the visibility toggle reaches THAT winner', async () => {
    listed();
    const user = userEvent.setup();
    render(<FakeWinnersManager />);
    await screen.findByText('Rahul K.');

    await user.click(screen.getByTitle('Hide Rahul K.'));

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][0]).toBe('/api/admin/fake-winners/7');
  });

  it('Edit UPDATES the entry instead of adding a second copy of it', async () => {
    listed();
    const user = userEvent.setup();
    render(<FakeWinnersManager />);
    await screen.findByText('Rahul K.');

    await user.click(screen.getByTitle('Edit Rahul K.'));

    // The heading is the symptom an operator could actually see.
    expect(await screen.findByText(/Edit Winner Entry/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Update$/ }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][0]).toBe('/api/admin/fake-winners/7');
    expect(post).not.toHaveBeenCalled();             // NOT a duplicate
  });
});
