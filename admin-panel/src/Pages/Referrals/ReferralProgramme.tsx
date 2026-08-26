// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ReferralProgramme.tsx — funding the queue.
 *
 * ── The admin supplies an amount, and nothing else ──────────────────────────
 * There is no "pay this person" button here, and that absence is the design.
 * The queue pays strictly in joining order: whoever joined earliest is paid
 * first, every time. That is what makes the programme defensible to everyone
 * still waiting in it, and what stops a disbursal from being a favour someone
 * can ask for. An operator can decide HOW MUCH to release; they cannot decide
 * WHO it reaches.
 *
 * ── What the numbers mean ───────────────────────────────────────────────────
 * Pending is money owed and not yet paid. Blocked is money owed to referrers
 * who are not currently eligible — unverified KYC, a blocked account — and it
 * is shown separately because it is NOT a shortfall: a blocked row does not
 * consume the pool, so funding ₹1,00,000 pays ₹1,00,000 of eligible earnings
 * regardless of how much sits blocked behind it.
 *
 * ── Why ₹25 is never split ──────────────────────────────────────────────────
 * A pool that runs out mid-queue stops at the last earner it can pay in full.
 * Half a reward is not a reward; it is a support ticket and a broken promise to
 * someone who did the work of inviting a player.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Users, IndianRupee, AlertTriangle } from 'lucide-react';
import { Kpis, inr } from '../../components/design';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import toast from 'react-hot-toast';

type Stats = Awaited<ReturnType<typeof api.referrals.stats>>;
type Disbursal = Awaited<ReturnType<typeof api.referrals.disburse>>;

export const ReferralProgramme: React.FC = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [last, setLast] = useState<Disbursal | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setStats(await api.referrals.stats());
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Could not load the referral programme.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0;

  const disburse = async () => {
    if (!valid) { toast.error('Enter a positive amount.'); return; }
    setIsPaying(true);
    try {
      const res = await api.referrals.disburse(parsed);
      if (!res.success) { toast.error(res.message || 'Disbursal failed.'); return; }
      setLast(res);
      setAmount('');
      setConfirming(false);
      toast.success(res.message || `₹${res.spent} paid to ${res.paid} referrer(s).`);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Disbursal failed.');
    } finally {
      setIsPaying(false);
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><div className="w-8 h-8 border-4 border-dark-600 border-t-gold-500 rounded-full animate-spin" /></div>;
  }

  const capUsedPct = stats?.memberCap
    ? Math.min(100, ((stats.verifiedMembers || 0) / stats.memberCap) * 100)
    : 0;
  const budgetUsedPct = stats?.budget
    ? Math.min(100, ((stats.disbursed || 0) / stats.budget) * 100)
    : 0;

  return (
    <div className="om-fade" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Kpis items={[
        { label: 'Owed and unpaid', value: inr(stats?.pendingValue), sub: `${formatters.number(stats?.pendingCount || 0)} earner(s)`, tone: 'var(--warning)' },
        { label: 'Paid to date', value: inr(stats?.disbursed), sub: `${budgetUsedPct.toFixed(1)}% of budget` },
        { label: 'Budget remaining', value: inr(stats?.remaining) },
        { label: 'Verified members', value: formatters.number(stats?.verifiedMembers || 0), sub: `${capUsedPct.toFixed(2)}% of cap` },
      ]} />

      {stats?.active === false && (
        <div className="card" style={{ padding: '16px 18px', display: 'flex', gap: 12, borderColor: 'var(--danger)' }}>
          <AlertTriangle size={20} style={{ color: 'var(--danger)', flex: 'none', marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>The programme is closed</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>
              Either the budget or the member cap has been reached. New referrals no longer
              accrue; earnings already owed can still be paid out below.
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(330px,1fr))', gap: 16 }}>
        {/* ── Fund the queue ──────────────────────────────────────────── */}
        <div className="card" style={{ padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <IndianRupee size={17} style={{ color: 'var(--gold-ink)' }} />
            <div style={{ fontSize: 15, fontWeight: 800 }}>Fund the queue</div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.65, marginBottom: 16 }}>
            Enter an amount. It is paid out in strict joining order — earliest joiner first —
            until it runs out. Nobody is chosen by hand, and a reward is never split: if the
            pool cannot cover the next ₹25 in full, it stops there and the remainder is
            reported back to you unspent.
          </p>

          <label style={{ display: 'block', fontSize: 10.5, fontWeight: 700, color: 'var(--text-2)', marginBottom: 5 }}>
            Pool amount (₹)
          </label>
          <input
            value={amount}
            onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, '')); setConfirming(false); }}
            inputMode="decimal" placeholder="100000" className="font-mono"
            style={{ width: '100%', height: 42, borderRadius: 9, border: '1px solid var(--input-border)', background: 'var(--input)', color: 'var(--text)', padding: '0 13px', fontSize: 15, fontWeight: 700, outline: 'none' }}
          />
          {valid && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 7 }}>
              Covers up to {formatters.number(Math.floor(parsed / 25))} reward(s) of ₹25.
            </div>
          )}

          <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
            {!confirming ? (
              <button
                onClick={() => setConfirming(true)} disabled={!valid}
                style={{ height: 42, padding: '0 20px', borderRadius: 9, background: 'var(--gold)', color: 'var(--gold-on)', fontSize: 13, fontWeight: 700, border: 'none', cursor: valid ? 'pointer' : 'not-allowed', opacity: valid ? 1 : .5 }}
              >
                Disburse
              </button>
            ) : (
              <>
                <span style={{ fontSize: 12.5, color: 'var(--warning)', fontWeight: 600 }}>
                  Pay out {inr(parsed)}? Money moves into player wallets immediately.
                </span>
                <button
                  onClick={disburse} disabled={isPaying}
                  style={{ height: 42, padding: '0 18px', borderRadius: 9, background: 'var(--danger)', color: '#fff', fontSize: 13, fontWeight: 700, border: 'none', cursor: 'pointer', opacity: isPaying ? .6 : 1 }}
                >
                  {isPaying ? 'Paying…' : 'Yes, pay out'}
                </button>
                <button
                  onClick={() => setConfirming(false)} disabled={isPaying}
                  style={{ height: 42, padding: '0 16px', borderRadius: 9, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Blocked earnings ────────────────────────────────────────── */}
        <div className="card" style={{ padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <Users size={17} style={{ color: 'var(--gold-ink)' }} />
            <div style={{ fontSize: 15, fontWeight: 800 }}>Blocked earnings</div>
          </div>
          <div className="font-mono" style={{ fontSize: 24, fontWeight: 800, margin: '10px 0 6px', color: (stats?.blockedCount || 0) ? 'var(--danger)' : 'var(--text)' }}>
            {inr(stats?.blockedValue)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
            {formatters.number(stats?.blockedCount || 0)} earner(s) currently ineligible
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.65 }}>
            Owed to referrers who cannot be paid right now — KYC not verified, or the account
            blocked. This is <strong>not</strong> a shortfall: a blocked row does not consume
            the pool, so funding a disbursal pays that full amount to eligible earners and
            simply steps over these. They become payable the moment their eligibility returns,
            keeping their original place in the queue.
          </p>
        </div>
      </div>

      {/* ── Programme position ─────────────────────────────────────────── */}
      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 14 }}>Programme position</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: '0 28px' }}>
          {[
            { k: 'Total budget', v: inr(stats?.budget) },
            { k: 'Paid to date', v: inr(stats?.disbursed) },
            { k: 'Remaining', v: inr(stats?.remaining) },
            { k: 'Member cap', v: formatters.number(stats?.memberCap || 0) },
            { k: 'Verified members', v: formatters.number(stats?.verifiedMembers || 0) },
            { k: 'Next joining number', v: formatters.number(stats?.nextQueuePosition || 0) },
          ].map((r) => (
            <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{r.k}</span>
              <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 700 }}>{r.v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Last disbursal ─────────────────────────────────────────────── */}
      {last && (
        <div className="card" style={{ padding: 22 }}>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>Disbursal {last.batchId}</div>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 14 }}>
            Paid in joining order up to joiner #{formatters.number(last.paidUpToJoiner || 0)}.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 14 }}>
            {[
              { k: 'Referrers paid', v: formatters.number(last.paid || 0), tone: 'var(--success)' },
              { k: 'Amount paid', v: inr(last.spent), tone: 'var(--success)' },
              { k: 'Skipped (ineligible)', v: formatters.number(last.blocked || 0), tone: (last.blocked || 0) ? 'var(--warning)' : undefined },
              { k: 'Returned unspent', v: inr(last.unspent), tone: (last.unspent || 0) ? 'var(--warning)' : undefined },
            ].map((c) => (
              <div key={c.k} style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{c.k}</div>
                <div className="font-mono" style={{ fontSize: 17, fontWeight: 800, marginTop: 5, color: c.tone || 'var(--text)' }}>{c.v}</div>
              </div>
            ))}
          </div>
          {!!last.unspent && (
            <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 14, lineHeight: 1.6 }}>
              The remainder came back because the queue ran out of eligible earners, or because
              the next reward could not be paid in full. Rewards are never split.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default ReferralProgramme;
