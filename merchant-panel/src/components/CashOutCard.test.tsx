// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The cash-out card (owner, 2026-10-21; the rule is
 * database/repositories/teamCashOut.js): a start asks once more before it
 * calls the server; a running cash out offers only Stop; the pause offers
 * nothing; a refusal is shown in the server's words, announced.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CashOutCard } from './CashOutCard';

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const idle = { active: false, startedAt: null, pausedUntil: null, pauseHours: 48 };

describe('CashOutCard', () => {
  it('asks before starting, then starts through the server and reloads', async () => {
    const change = vi.fn().mockResolvedValue({ ...idle, active: true });
    const onChanged = vi.fn();
    render(<CashOutCard cashOut={idle} canAct change={change} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /start cash out/i }));
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /yes, start the cash out/i }));
    await waitFor(() => expect(change).toHaveBeenCalledWith(true));
    expect(onChanged).toHaveBeenCalled();
  });

  it('a running cash out offers only Stop, which starts the pause', async () => {
    const change = vi.fn().mockResolvedValue(idle);
    render(<CashOutCard cashOut={{ ...idle, active: true, startedAt: '2026-10-21T10:00:00Z' }} canAct change={change} onChanged={vi.fn()} />);
    expect(screen.getByText(/only buy orders come to this pool now/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /start cash out/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /stop cash out/i }));
    await waitFor(() => expect(change).toHaveBeenCalledWith(false));
  });

  it('the pause offers no control, and a sub-member never sees one', () => {
    const { unmount } = render(<CashOutCard cashOut={{ ...idle, pausedUntil: '2026-10-23T10:00:00Z' }} canAct change={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText(/paused until/i)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    unmount();
    render(<CashOutCard cashOut={idle} canAct={false} change={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows the server refusal as worded', async () => {
    const change = vi.fn().mockRejectedValue(new Error('This team already has a request of that kind waiting.'));
    render(<CashOutCard cashOut={idle} canAct change={change} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /start cash out/i }));
    fireEvent.click(screen.getByRole('button', { name: /yes, start the cash out/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('already has a request of that kind waiting');
  });
});
