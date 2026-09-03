// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * What a player is told about their verification.
 *
 * ── Why this is worth a test ────────────────────────────────────────────────
 * This modal has no form and submits nothing, so it looks like decoration. It
 * is not: it is the only place a player learns WHY they cannot withdraw, and
 * the platform has already shipped the failure this guards against once — a
 * rejected player was told they were rejected and never told why, because the
 * reason was written to a field nothing read. They could not fix the
 * submission, and support could not tell them what was wrong.
 *
 * So the assertions are about what each status actually says, and about the
 * rejection reason surviving all the way to the screen.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let mockUser: Record<string, unknown> | null = null;
vi.mock('../../services/GameContext', () => ({
  useGame: () => ({ user: mockUser }),
}));

const { default: KYCModal } = await import('./KYCModal');

const show = (user: Record<string, unknown> | null, onClose = () => {}) => {
  mockUser = user;
  return render(<KYCModal onClose={onClose} />);
};

describe('KYCModal', () => {
  it('tells an APPROVED player that withdrawals are open', () => {
    show({ kycStatus: 'APPROVED' });
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText(/Withdrawals and token sales are open/i)).toBeInTheDocument();
  });

  it('tells a PENDING player they can still play and deposit', () => {
    // The distinction matters: "wait" is tolerable, "you can do nothing" is a
    // support ticket. Only one of them is true here.
    show({ kycStatus: 'PENDING_APPROVAL' });
    expect(screen.getByText('Verification in progress')).toBeInTheDocument();
    expect(screen.getByText(/You can play and deposit while you wait/i)).toBeInTheDocument();
  });

  it('SHOWS THE REJECTION REASON — the defect this platform shipped once', () => {
    // The reason used to be written to a field nothing read, so every rejected
    // player saw the refusal and no explanation.
    show({ kycStatus: 'REJECTED', kycData: { rejectionReason: 'Name does not match the Aadhaar record.' } });
    expect(screen.getByText('Verification failed')).toBeInTheDocument();
    expect(screen.getByText('Name does not match the Aadhaar record.')).toBeInTheDocument();
    expect(screen.getByText(/Reason given/i)).toBeInTheDocument();
  });

  it('omits the reason block entirely when there is no reason', () => {
    // An empty "Reason given" box is worse than none: it reads as a reason that
    // was withheld.
    show({ kycStatus: 'REJECTED' });
    expect(screen.queryByText(/Reason given/i)).toBeNull();
  });

  it('tells a rejected player a second account will not work', () => {
    // One Aadhaar holds one account, enforced by a UNIQUE. A player who does
    // not know that wastes a signup and hits a wall with no explanation.
    show({ kycStatus: 'REJECTED' });
    expect(screen.getByText(/one Aadhaar can hold one account/i)).toBeInTheDocument();
  });

  it('treats an unknown or missing status as NOT STARTED rather than blank', () => {
    // A modal that renders nothing for an unrecognised status is a player
    // staring at an empty dialog. The bot asks for the Aadhaar before the
    // account exists, so this state is unusual and says so.
    for (const user of [null, {}, { kycStatus: 'SOMETHING_NEW' }]) {
      const { unmount } = show(user as Record<string, unknown> | null);
      expect(screen.getByText('Not started')).toBeInTheDocument();
      expect(screen.getByText(/contact support/i)).toBeInTheDocument();
      unmount();
    }
  });

  it('offers no form — there is nothing here to submit', () => {
    // This used to take a name, an Aadhaar number and two photographs. None of
    // that is collected any more, and a form nobody can submit would be worse
    // than none.
    const { container } = show({ kycStatus: 'PENDING_APPROVAL' });
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it('closes from the dismiss button and from the corner control', async () => {
    const onClose = vi.fn();
    show({ kycStatus: 'APPROVED' }, onClose);
    await userEvent.click(screen.getByRole('button', { name: /got it/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
