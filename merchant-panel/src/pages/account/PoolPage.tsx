// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's token pool (owner, 2026-10-11 — Phase B).
 *
 * The pool replaces a team's pool for this type: a buy routed here holds its
 * tokens in it at assignment and spends them at completion; a settled sell
 * adds to it; commission is paid into it. Tokens come from, and go back to,
 * the platform only through a request an admin fulfils (`canFundMerchants`,
 * Team pool requests), the same as a supervisor's.
 *
 * Everyone in the account sees the balance; asking and cancelling are the
 * owner's (`ownerOnly`), and the request list is sent to the owner only.
 */
import React, { useState } from 'react';
import { Coins, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../services/AuthContext';
import { api } from '../../services/api';
import { useMerchantAccount } from '../../hooks/useMerchantAccount';
import { isOwner } from '../../utils/actor';
import { formatTokens } from '../../utils/rail';
import { Button, Card, CardTitle, Field, SegmentedControl, Skeleton, inputStyle } from '../../components/ui';
import AccountShell, { Refusal } from './AccountShell';
import type { PoolDirection } from '../../types';

const errorText = (err: any, fallback: string): string => err?.message || fallback;
const tokensOf = (paise: number) => formatTokens((Number(paise) || 0) / 100);

export const PoolRequestForm: React.FC<{ onSent: () => Promise<void> }> = ({ onSent }) => {
  const [direction, setDirection] = useState<PoolDirection>('BUY');
  const [tokens, setTokens] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');

  const submit = async () => {
    setRefusal('');
    setBusy(true);
    try {
      await api.requestMerchantPool(direction, Number(tokens), note.trim());
      toast.success('Request sent. An admin fulfils it.');
      setTokens(''); setNote('');
      await onSent();
    } catch (err) {
      setRefusal(errorText(err, 'Could not send the request.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardTitle title="Ask for tokens, or return them" sub="An admin fulfils the request and records what was paid." />
      <SegmentedControl<PoolDirection>
        value={direction}
        onChange={setDirection}
        options={[
          { value: 'BUY', label: 'Add tokens to the pool' },
          { value: 'SELL', label: 'Return tokens to the platform' },
        ]}
        style={{ marginBottom: 12, alignSelf: 'flex-start', width: 'fit-content' }}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <Field label="Tokens (whole number)" htmlFor="pool-tokens">
          <input id="pool-tokens" value={tokens} inputMode="numeric" onChange={(e) => setTokens(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Note for the admin (optional)" htmlFor="pool-note">
          <input id="pool-note" value={note} onChange={(e) => setNote(e.target.value)} style={inputStyle} maxLength={300} />
        </Field>
      </div>
      <Refusal message={refusal} style={{ marginTop: 10 }} />
      <Button onClick={() => void submit()} busy={busy} style={{ marginTop: 12 }}>Send request</Button>
    </Card>
  );
};

const PoolBody: React.FC = () => {
  const { merchant } = useAuth();
  const owner = isOwner(merchant);
  const { overview, state, error, reload } = useMerchantAccount();
  const [refusal, setRefusal] = useState('');
  const [busy, setBusy] = useState('');
  if (state === 'loading') return <Skeleton height={160} />;
  if (state === 'error' || !overview) return <Refusal message={error} />;
  const { team } = overview;
  const requests = overview.poolRequests ?? [];

  const cancel = async (requestId: string) => {
    setBusy(requestId); setRefusal('');
    try {
      await api.cancelMerchantPoolRequest(requestId);
      toast.success('Request cancelled');
      await reload();
    } catch (err) {
      setRefusal(errorText(err, 'Could not cancel the request.'));
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <Card>
        <CardTitle title="Pool" sub="Buys routed to you hold their tokens here until they complete." />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 11 }}>
          {[
            { label: 'Available', value: tokensOf(team.poolAvailablePaise) },
            { label: 'Held for open buys', value: tokensOf(team.poolHeldPaise) },
            { label: `Commission paid (${team.commission.commissionPercent}%)`, value: tokensOf(team.commission.paidPaise) },
            { label: 'Commission owed', value: tokensOf(team.commission.owedPaise) },
          ].map((tile) => (
            <div key={tile.label} style={{ background: 'var(--surface-2)', borderRadius: 13, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{tile.label}</div>
              <div className="bb-mono" style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', marginTop: 4 }}>{tile.value}</div>
            </div>
          ))}
        </div>
      </Card>

      {owner && <PoolRequestForm onSent={reload} />}

      {owner && (
        <Card>
          <CardTitle title="Your requests" />
          <Refusal message={refusal} style={{ marginBottom: 10 }} />
          {requests.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No requests yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {requests.map((r) => (
                <div key={r.requestId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                      {r.direction === 'BUY' ? 'Add' : 'Return'} {tokensOf(r.tokenAmountPaise)}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                      {r.status} · {new Date(r.createdAt).toLocaleString()}{r.decisionNote ? ` · ${r.decisionNote}` : ''}
                    </div>
                  </div>
                  {r.status === 'PENDING' && (
                    <Button variant="outline" tone="danger" busy={busy === r.requestId} style={{ padding: '7px 10px' }}
                      onClick={() => void cancel(r.requestId)}>
                      <X size={14} /> Cancel
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </>
  );
};

const PoolPage: React.FC = () => (
  <AccountShell>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
      <Coins size={18} /> Pool
    </div>
    <PoolBody />
  </AccountShell>
);

export default PoolPage;
