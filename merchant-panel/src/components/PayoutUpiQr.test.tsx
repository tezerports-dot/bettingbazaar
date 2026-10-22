// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** A sell's payout QR (owner, 2026-10-21): the server's link, drawn and opened as sent. */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PayoutUpiQr } from './PayoutUpiQr';

const LINK = 'upi://pay?pa=asha.rao%40okaxis&pn=Asha%20Rao&am=1000.00&cu=INR&tn=BB%20ABCD1234';

describe('PayoutUpiQr', () => {
  it('draws the link as a QR and opens the same link', () => {
    render(<PayoutUpiQr link={LINK} amountText="₹1,000" />);
    const qr = screen.getByRole('img', { name: /UPI QR to pay the player ₹1,000/ });
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(screen.getByRole('link', { name: /open in upi app/i }).getAttribute('href')).toBe(LINK);
  });
});
