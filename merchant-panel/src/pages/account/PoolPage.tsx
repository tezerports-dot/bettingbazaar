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
 *
 * Buying in USDT (owner, 2026-10-21) needs no admin: the request comes back
 * with an address of its own and the price, and the tokens arrive in the pool
 * once the USDT does (`UsdtPayCard`). What the pool bought from the platform
 * is shown under the balance (`poolTrades`). Nothing is sold back to the
 * platform (owner, 2026-10-21); the pool is turned into cash by a cash out
 * (`CashOutCard`).
 */
import React, { useState } from 'react';
import { Coins, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../services/AuthContext';
import { api } from '../../services/api';
import { useMerchantAccount } from '../../hooks/useMerchantAccount';
import { isOwner } from '../../utils/actor';
import { formatTokens } from '../../utils/rail';
import { Button, Card, CardTitle, Field, Skeleton, inputStyle } from '../../components/ui';
import AccountShell, { Refusal } from './AccountShell';
import { PoolBreakdown } from '../../components/PoolBreakdown';
import { UsdtPayCard } from '../../components/UsdtPayCard';
import { CashOutCard } from '../../components/CashOutCard';

const errorText = (err: any, fallback: string): string => err?.message || fallback;
const tokensOf = (paise: number) => formatTokens((Number(paise) || 0) / 100);

/** Tokens are bought from the platform in USDT only (owner, 2026-10-22). */
export const PoolRequestForm: React.FC<{ onSent: () => Promise<void> }> = ({ onSent }) => {
  const [tokens, setTokens] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');

  const submit = async () => {
    setRefusal('');
    setBusy(true);
    try {
      await api.buyMerchantPoolUsdt(Number(tokens));
      toast.success('Pay the USDT shown below. The tokens arrive by themselves.');
      setTokens('');
      await onSent();
    } catch (err) {
      setRefusal(errorText(err, 'Could not start the purchase.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardTitle title="Buy tokens from the platform"
        sub="Pay in USDT and the tokens arrive in your pool by themselves. This is the only way your pool size grows." />
      <Field label="Tokens (whole number)" htmlFor="pool-tokens">
        <input id="pool-tokens" value={tokens} inputMode="numeric" onChange={(e) => setTokens(e.target.value.replace(/[^0-9]/g, ''))} style={inputStyle} />
      </Field>
      <Refusal message={refusal} style={{ marginTop: 10 }} />
      <Button onClick={() => void submit()} busy={busy} disabled={!(Number(tokens) > 0)} style={{ marginTop: 12 }}>
        Get the USDT address
      </Button>
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
  const { team, poolTrades } = overview;
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
        <PoolBreakdown exposure={team.poolExposure} availablePaise={team.poolAvailablePaise} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 11, marginTop: 11 }}>
          {[
            { label: `Bought from the platform (${poolTrades?.buys ?? 0})`, value: tokensOf(poolTrades?.boughtPaise ?? 0) },
            { label: `Commission paid (${team.commission.depositPercent}% buys · ${team.commission.withdrawalPercent}% sells)`, value: tokensOf(team.commission.paidPaise) },
            { label: 'Commission owed', value: tokensOf(team.commission.owedPaise) },
          ].map((tile) => (
            <div key={tile.label} style={{ background: 'var(--surface-2)', borderRadius: 13, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{tile.label}</div>
              <div className="bb-mono" style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', marginTop: 4 }}>{tile.value}</div>
            </div>
          ))}
        </div>
      </Card>

      <CashOutCard cashOut={team.cashOut} canAct={owner} change={api.setMerchantCashOut} onChanged={reload} />

      {/* A pool cashing out, or paused after one, buys no tokens (teamCashOut.js). */}
      {owner && !team.cashOut.active && !team.cashOut.pausedUntil && <PoolRequestForm onSent={reload} />}

      {owner && (
        <Card>
          <CardTitle title="Your requests" />
          <Refusal message={refusal} style={{ marginBottom: 10 }} />
          {requests.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No requests yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {requests.map((r) => (r.status === 'PENDING' && r.usdt ? (
                <UsdtPayCard key={r.requestId} tokensText={tokensOf(r.tokenAmountPaise)} payment={r.usdt}
                  action={r.usdt.received === 0 ? (
                    <Button variant="outline" tone="danger" busy={busy === r.requestId} style={{ padding: '7px 10px', alignSelf: 'flex-start' }}
                      onClick={() => void cancel(r.requestId)}>
                      <X size={14} /> Cancel
                    </Button>
                  ) : null} />
              ) : (
                <div key={r.requestId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                      Add {tokensOf(r.tokenAmountPaise)}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                      {r.status}{r.usdt ? ` · paid in USDT (${r.usdt.amount} USDT)` : ''} · {new Date(r.createdAt).toLocaleString()}{r.decisionNote ? ` · ${r.decisionNote}` : ''}
                    </div>
                  </div>
                  {r.status === 'PENDING' && (
                    <Button variant="outline" tone="danger" busy={busy === r.requestId} style={{ padding: '7px 10px' }}
                      onClick={() => void cancel(r.requestId)}>
                      <X size={14} /> Cancel
                    </Button>
                  )}
                </div>
              )))}
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
