// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A sell's payout as a UPI QR (owner, 2026-10-21): the link the server built
 * from the player's UPI ID for this order's exact amount (`payoutUpiLink`,
 * backend/domains/merchant/merchantOrderView.js), drawn here in the browser as
 * a QR for the member to scan with their UPI app, and a button that opens it
 * on this phone. The player's bank details are shown beside it, so either way
 * pays them. The row refuses a UPI ID that is a mobile, so the link never
 * carries one. Black on white whatever the theme (§11: a scanner's contrast).
 */
import React, { useMemo } from 'react';
import { qrPath } from '../utils/qrPath';

export const PayoutUpiQr: React.FC<{ link: string; amountText: string }> = ({ link, amountText }) => {
  const qr = useMemo(() => qrPath(link), [link]);
  if (!qr) return null;
  const box = qr.size + 8;
  return (
    <div data-testid="payout-upi-qr" style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, padding: 12, borderRadius: 13,
      background: 'var(--surface-2)', border: '1px solid var(--border)', marginBottom: 10,
    }}>
      <svg role="img" aria-label={`UPI QR to pay the player ${amountText}`} viewBox={`-4 -4 ${box} ${box}`}
        width={156} height={156} shapeRendering="crispEdges"
        style={{ display: 'block', background: 'white', borderRadius: 8, flexShrink: 0 }}>
        <path d={qr.d} fill="black" />
      </svg>
      <div style={{ flex: '1 1 180px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--text)' }}>Scan to pay {amountText}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          The amount is filled in. Scan it with your UPI app, or pay the bank account below, then enter the
          reference.
        </div>
        <a href={link} style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--wd)' }}>Open in UPI app</a>
      </div>
    </div>
  );
};
