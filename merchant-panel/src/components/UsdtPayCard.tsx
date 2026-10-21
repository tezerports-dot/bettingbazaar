// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// A pool buy paid in USDT (owner, 2026-10-21): where to pay, how much, on
// which network and by when, and what has arrived. The tokens go into the
// pool by themselves once the USDT covers the price; nothing here is pressed
// to say it was paid. Every figure is the server's (`toRequest`, teamPools.js).
import React, { useMemo } from 'react';
import { CopyRow } from './ui';
import { qrPath } from '../utils/qrPath';
import type { PoolUsdtPayment } from '../types';

const usdtText = (n: number) => `${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 6 })} USDT`;

/** The address as a QR, black on white for any wallet's scanner (§11: a scanner's contrast). */
const AddressQr: React.FC<{ address: string }> = ({ address }) => {
  const qr = useMemo(() => qrPath(address), [address]);
  if (!qr) return null;
  const box = qr.size + 8;
  return (
    <svg role="img" aria-label="QR code of the USDT address" viewBox={`-4 -4 ${box} ${box}`}
      width={148} height={148} shapeRendering="crispEdges"
      style={{ display: 'block', background: 'white', borderRadius: 8, flexShrink: 0 }}>
      <path d={qr.d} fill="black" />
    </svg>
  );
};

export const UsdtPayCard: React.FC<{ tokensText: string; payment: PoolUsdtPayment; action?: React.ReactNode }> = ({
  tokensText, payment, action,
}) => {
  const left = Math.max(0, payment.amount - payment.received);
  const expired = new Date(payment.expiresAt).getTime() < Date.now();
  return (
    <div data-testid="usdt-pay-card" style={{
      display: 'flex', flexWrap: 'wrap', gap: 14, padding: 14, borderRadius: 14,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
    }}>
      <AddressQr address={payment.address} />
      <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--text)' }}>
          Pay {usdtText(payment.amount)} for {tokensText} tokens
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Send USDT on <strong>BNB Smart Chain (BEP-20)</strong> only, to this address. The tokens go into your pool by
          themselves once it arrives. Price ₹{payment.rate} per USDT.
        </div>
        <CopyRow label="USDT address (BEP-20)" value={payment.address} />
        <CopyRow label="Amount" value={String(left || payment.amount)} sub="USDT" />
        <div role="status" style={{ fontSize: 12, fontWeight: 700, color: payment.received > 0 ? 'var(--ok)' : 'var(--muted)' }}>
          {payment.received > 0
            ? `${usdtText(payment.received)} received${left > 0 ? `, ${usdtText(left)} still to come` : ''}.`
            : expired
              ? 'The time to pay has passed. Send nothing more to this address.'
              : `Waiting for your payment. Pay by ${new Date(payment.expiresAt).toLocaleString()}.`}
        </div>
        {action}
      </div>
    </div>
  );
};
