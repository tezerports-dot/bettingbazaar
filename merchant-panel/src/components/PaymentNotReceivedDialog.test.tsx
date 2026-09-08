// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The dialog will not let a merchant accuse a player without saying why and
 * showing it.
 *
 * ── Why the guard is here as well as on the server ──────────────────────────
 * The route refuses a short reason or a missing proof, so this is not the only
 * defence. It is the one that stops a merchant filling in a form, pressing
 * Reject, and being told no — the backend's rules stated early enough to be
 * useful.
 *
 * ── What this action does, which is why it is guarded at all ────────────────
 * Rejecting a PAID order cancels it, adds a warning to the player's account,
 * and auto-blocks them once they pass the admin's threshold, with no admin
 * looking at it. It is the heaviest thing a merchant can do to a player.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PaymentNotReceivedDialog from './PaymentNotReceivedDialog';

const REASON = 'No credit against UTR 123456789012 in my statement';
const image = (over: Partial<{ name: string; type: string; size: number }> = {}) => {
  const f = new File(['x'], over.name ?? 'proof.jpg', { type: over.type ?? 'image/jpeg' });
  if (over.size !== undefined) Object.defineProperty(f, 'size', { value: over.size });
  return f;
};

const setup = (over: Partial<React.ComponentProps<typeof PaymentNotReceivedDialog>> = {}) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(<PaymentNotReceivedDialog
    open orderRef="ORD-77" busy={false} onCancel={onCancel} onSubmit={onSubmit} {...over} />);
  return { onSubmit, onCancel };
};

const reasonBox = () => screen.getByPlaceholderText(/No credit of/i);
const fileBox = () => screen.getByLabelText('Proof image') as HTMLInputElement;
const submit = () => screen.getByRole('button', { name: /Reject order/i });
const attach = (file: File) => fireEvent.change(fileBox(), { target: { files: [file] } });

describe('the payment-not-received dialog', () => {
  it('renders nothing when closed', () => {
    render(<PaymentNotReceivedDialog open={false} orderRef="ORD-1" busy={false} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says what will happen to the player before anything is typed', () => {
    // A merchant should know this warns an account, not just closes an order.
    setup();
    expect(screen.getByText(/warning on their/i)).toBeInTheDocument();
    expect(screen.getByText(/ORD-77/)).toBeInTheDocument();
  });

  it('will not submit without a reason', () => {
    const { onSubmit } = setup();
    attach(image());
    expect(submit()).toBeDisabled();
    fireEvent.click(submit());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('will not submit without proof', () => {
    const { onSubmit } = setup();
    fireEvent.change(reasonBox(), { target: { value: REASON } });
    expect(submit()).toBeDisabled();
    fireEvent.click(submit());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('will not accept a throwaway reason', () => {
    // The reason is shown to the player. "no" explains nothing to them, to
    // support, or to an admin reading it later — and the route refuses it.
    const { onSubmit } = setup();
    attach(image());
    fireEvent.change(reasonBox(), { target: { value: 'no' } });
    expect(submit()).toBeDisabled();
    expect(screen.getByText(/more characters needed/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the reason and the file once both are there', () => {
    const { onSubmit } = setup();
    const file = image();
    fireEvent.change(reasonBox(), { target: { value: `  ${REASON}  ` } });
    attach(file);
    fireEvent.click(submit());
    // Trimmed, so trailing whitespace cannot pad a short reason past the gate.
    expect(onSubmit).toHaveBeenCalledWith(REASON, file);
  });

  it('refuses a file that is not an image', () => {
    const { onSubmit } = setup();
    fireEvent.change(reasonBox(), { target: { value: REASON } });
    attach(image({ name: 'statement.pdf', type: 'application/pdf' }));
    expect(screen.getByText(/JPEG, PNG, WebP or GIF/i)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses a file over the size limit before uploading it', () => {
    const { onSubmit } = setup();
    fireEvent.change(reasonBox(), { target: { value: REASON } });
    attach(image({ size: 11 * 1024 * 1024 }));
    expect(screen.getByText(/over 10 MB/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('holds everything still while a submission is in flight', () => {
    // Double-submitting sends the proof twice and, on the second pass, hits a
    // 409 the merchant reads as a failure on a rejection that did go through.
    const { onSubmit, onCancel } = setup({ busy: true });
    fireEvent.change(reasonBox(), { target: { value: REASON } });
    attach(image());

    // The label changes while busy, which is the only signal the merchant gets.
    const sending = screen.getByRole('button', { name: /Sending/i });
    expect(sending).toBeDisabled();
    fireEvent.click(sending);
    expect(onSubmit).not.toHaveBeenCalled();

    // Cancel is held too — closing mid-flight loses the outcome.
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
