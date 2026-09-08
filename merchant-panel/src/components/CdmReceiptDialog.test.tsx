// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The slip a merchant sends once and never sees again.
 *
 * ── What these assertions are protecting ────────────────────────────────────
 * A CDM slip is admin-and-disputes-manager only from the moment it is stored —
 * `toOrder` does not map the columns, so no projection can carry them back, and
 * there is no route to build. Two properties of this dialog follow from that,
 * and neither is cosmetic:
 *
 *   1. **Replacement is free until submit.** This is the last moment the
 *      merchant can look at what they are sending. A picker that kept the first
 *      file — or a preview that kept showing it — would be a photo of the wrong
 *      slip, submitted, unfixable and unviewable.
 *
 *   2. **The confirmation stays on screen.** The server's echo is the only
 *      record the merchant keeps of what it accepted, so success must not close
 *      the dialog and throw it away.
 *
 * And the submit gate: the server refuses a transaction id under 6 characters
 * and refuses a submission with no image, so the button must refuse both first
 * — being told after the upload that the id was too short is a wasted trip to
 * a machine they have already left.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CdmReceiptDialog } from './CdmReceiptDialog';

// jsdom has no object URLs. The component revokes what it creates, so both
// halves are stubbed and `revokeObjectURL` is asserted on.
const created: string[] = [];
const revoked: string[] = [];
beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  let n = 0;
  URL.createObjectURL = vi.fn(() => { const u = `blob:slip-${n += 1}`; created.push(u); return u; });
  URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); });
});

const png = (name: string) => new File(['x'], name, { type: 'image/png' });

const props = {
  open: true,
  orderRef: 'ORD-77',
  amount: 4000,
  busy: false,
  submitted: null,
  onCancel: vi.fn(),
  onSubmit: vi.fn(),
};

const pick = (file: File) => {
  const input = screen.getByLabelText('CDM receipt photo') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
};

const typeId = (value: string) => {
  fireEvent.change(screen.getByLabelText('Bank transaction id (from the slip)'), { target: { value } });
};

describe('CdmReceiptDialog', () => {
  it('refuses a transaction id the server would refuse, even with a photo', () => {
    const onSubmit = vi.fn();
    render(<CdmReceiptDialog {...props} onSubmit={onSubmit} />);
    const button = screen.getByRole('button', { name: 'Submit receipt' });

    // Nothing at all.
    expect(button).toBeDisabled();

    // The server requires 6+. Being told after the upload that the id was too
    // short is a wasted trip to a machine they have already left.
    typeId('123');
    pick(png('slip.png'));
    expect(button).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses a transaction id with no photo — an assertion with no evidence', () => {
    const onSubmit = vi.fn();
    render(<CdmReceiptDialog {...props} onSubmit={onSubmit} />);
    typeId('481920356711');
    expect(screen.getByRole('button', { name: 'Submit receipt' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends the trimmed id and the file once both are present', () => {
    const onSubmit = vi.fn();
    render(<CdmReceiptDialog {...props} onSubmit={onSubmit} />);
    typeId('  481920356711  ');
    const file = png('slip.png');
    pick(file);

    fireEvent.click(screen.getByRole('button', { name: 'Submit receipt' }));
    expect(onSubmit).toHaveBeenCalledWith('481920356711', file);
  });

  it('replaces the picked file freely, and previews the LATEST one', () => {
    const onSubmit = vi.fn();
    render(<CdmReceiptDialog {...props} onSubmit={onSubmit} />);
    typeId('481920356711');

    pick(png('blurry.png'));
    expect(screen.getByText(/blurry\.png/)).toBeTruthy();

    const good = png('readable.png');
    pick(good);
    expect(screen.getByText(/readable\.png/)).toBeTruthy();
    expect(screen.queryByText(/blurry\.png/)).toBeNull();

    // The preview follows the replacement — a merchant checking a re-taken
    // photo must not be looking at the one they just discarded.
    const preview = screen.getByAltText('The slip you are about to submit') as HTMLImageElement;
    expect(preview.src).toBe(created[1]);
    expect(revoked).toContain(created[0]);

    fireEvent.click(screen.getByRole('button', { name: 'Submit receipt' }));
    expect(onSubmit).toHaveBeenCalledWith('481920356711', good);
  });

  it('rejects a file the server would refuse, and KEEPS the good one already picked', () => {
    render(<CdmReceiptDialog {...props} />);
    typeId('481920356711');
    pick(png('good.png'));

    pick(new File(['x'], 'statement.pdf', { type: 'application/pdf' }));
    expect(screen.getByText('Use a JPEG, PNG or WebP photo of the slip.')).toBeTruthy();
    // The refused file must not replace the acceptable one — otherwise a
    // mis-tap silently empties the form and the submit button goes dead with
    // no explanation of what was lost.
    expect(screen.getByText(/good\.png/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit receipt' })).not.toBeDisabled();
  });

  it('shows the server echo instead of closing — it is the only record kept', () => {
    render(
      <CdmReceiptDialog
        {...props}
        submitted={{ transactionId: '481920356711', submittedAt: '2026-09-08T10:30:00.000Z' }}
      />
    );
    expect(screen.getByText('Receipt recorded')).toBeTruthy();
    expect(screen.getByText('481920356711')).toBeTruthy();
    // And the form is gone: there is nothing left to submit.
    expect(screen.queryByRole('button', { name: 'Submit receipt' })).toBeNull();
  });

  it('never offers a way to read a submitted slip back', () => {
    render(
      <CdmReceiptDialog
        {...props}
        submitted={{ transactionId: '481920356711', submittedAt: '2026-09-08T10:30:00.000Z' }}
      />
    );
    // No image, no link. The echo is text the server sent back, not the stored
    // receipt — the merchant cannot open it again and the dialog must not
    // pretend otherwise by leaving the local preview on screen.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
