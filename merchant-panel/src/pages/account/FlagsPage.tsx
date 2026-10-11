// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's problem flags (owner, 2026-10-11 — Phase B).
 *
 * For a merchant account, refusals, unpaid buys counted against it and lost
 * disputes count towards a daily total; at the admin's threshold the day is
 * flagged to the admin. A flag suspends nothing and pauses nothing
 * (merchantProblems.js); an admin can still suspend by hand. The last thirty
 * days, as GET /api/merchant/account sends them.
 */
import React from 'react';
import { Flag } from 'lucide-react';
import { useMerchantAccount } from '../../hooks/useMerchantAccount';
import { Banner, Card, CardTitle, Skeleton } from '../../components/ui';
import AccountShell, { Refusal } from './AccountShell';

const FlagsBody: React.FC = () => {
  const { overview, state, error } = useMerchantAccount();
  if (state === 'loading') return <Skeleton height={120} />;
  if (state === 'error') return <Refusal message={error} />;
  const flags = overview?.flags ?? [];
  return (
    <Card>
      <CardTitle title="Problem days" sub="Refusals, unpaid buys counted against you and lost disputes, per IST day. A flag goes to the admin; it suspends nothing." />
      {flags.length === 0 ? (
        <div role="status" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>No flags in the last 30 days.</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {flags.map((f) => (
            <li key={f.id}>
              <Banner tone="dispute" title={f.day}>
                {f.problemCount} problems against a threshold of {f.threshold}.
              </Banner>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

const FlagsPage: React.FC = () => (
  <AccountShell>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
      <Flag size={18} /> Flags
    </div>
    <FlagsBody />
  </AccountShell>
);

export default FlagsPage;
