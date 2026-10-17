// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The dialog will not let a merchant accuse a player without saying why.
 *
 * ── Why the guard is here as well as on the server ──────────────────────────
 * The route refuses a short reason, so this is not the only defence. It is the
 * one that stops a merchant filling in a form, pressing Reject, and being told
 * no — the backend's rule stated early enough to be useful.
 *
 * ── Reason only ─────────────────────────────────────────────────────────────
 * No proof image is asked for (owner, 2026-10-17); the dispute that may follow
 * is where evidence is weighed. So the dialog offers no file box at all.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PaymentNotReceivedDialog from './PaymentNotReceivedDialog';

const REASON = 'No credit against UTR 123456789012 in my statement';

const setup = (over: Partial<React.ComponentProps<typeof PaymentNotReceivedDialog>> = {}) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(<PaymentNotReceivedDialog
    open orderRef="ORD-77" busy={false} onCancel={onCancel} onSubmit={onSubmit} {...over} />);
  return { onSubmit, onCancel };
};

const reasonBox = () => screen.getByPlaceholderText(/No credit of/i);
const submit = () => screen.getByRole('button', { name: /Reject order/i });

describe('the payment-not-received dialog', () => {
  it('renders nothing when closed', () => {
    render(<PaymentNotReceivedDialog open={false} orderRef="ORD-1" busy={false} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says what will happen to the player before anything is typed', () => {
    setup();
    expect(screen.getByText(/warning on their/i)).toBeInTheDocument();
    expect(screen.getByText(/ORD-77/)).toBeInTheDocument();
  });

  it('asks for no proof image', () => {
    setup();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(/proof/i)).toBeNull();
  });

  it('will not submit without a reason', () => {
    const { onSubmit } = setup();
    expect(submit()).toBeDisabled();
    fireEvent.click(submit());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('will not accept a throwaway reason, and says how much more it needs', () => {
    const { onSubmit } = setup();
    fireEvent.change(reasonBox(), { target: { value: 'no' } });
    expect(submit()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/8 more characters needed/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the trimmed reason alone', () => {
    const { onSubmit } = setup();
    fireEvent.change(reasonBox(), { target: { value: `  ${REASON}  ` } });
    fireEvent.click(submit());
    expect(onSubmit).toHaveBeenCalledWith(REASON);
  });

  it('does not let padding carry a short reason past the gate', () => {
    const { onSubmit } = setup();
    fireEvent.change(reasonBox(), { target: { value: '   short    ' } });
    expect(submit()).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('holds everything still while a submission is in flight', () => {
    const { onSubmit, onCancel } = setup({ busy: true });
    fireEvent.change(reasonBox(), { target: { value: REASON } });
    const sending = screen.getByRole('button', { name: /Sending/i });
    expect(sending).toBeDisabled();
    fireEvent.click(sending);
    expect(onSubmit).not.toHaveBeenCalled();
    const cancel = screen.getByRole('button', { name: /Cancel/i });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('can be cancelled', () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
