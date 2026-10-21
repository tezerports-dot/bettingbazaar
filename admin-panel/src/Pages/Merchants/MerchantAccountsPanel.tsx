// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Merchants (merchant accounts) and their flags (owner, 2026-10-11 — Phase B).
 *
 * A merchant serves INR orders directly when "INR orders go to" is Merchants
 * (System Settings): its own pool, payment accounts and sub-members, with no
 * supervisor. Everything here is the server's answer
 * (merchantAccount.admin.routes.js, `canManageMerchants`):
 *   GET /api/admin/merchant-accounts  the accounts, sub-members, pool and problem days
 *   GET /api/admin/merchant-flags     the days problems crossed the threshold
 * Shown on Payments (Merchants side), above it the merchants' pool requests
 * (`canFundMerchants`).
 *
 * A sub-member's mobile is served but never shown (CLAUDE.md §24).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Flag } from 'lucide-react';
import api from '../../services/api';
import { poolExposureLine, type PoolExposure } from '../../types';

const tokens = (paise: number) => ((Number(paise) || 0) / 100).toLocaleString('en-IN');

interface AdminPaymentAccount {
  accountId: string; kind: 'UPI_QR' | 'BANK'; label: string; upiId: string | null;
  bankName: string; accountNo: string; acceptsDeposits: boolean; paysWithdrawals: boolean; status: string;
}
interface AdminSubMember { staffId: string; name: string; roles: string[]; status: string }
interface AdminMerchantAccount {
  teamId: string; ownerMerchantId: string; ownerName: string; ownerRef: string; ownerStatus: string;
  ownerOnline: boolean; name: string; poolAvailablePaise: number; poolHeldPaise: number;
  poolExposure?: PoolExposure;
  commission: { paidPaise: number; owedPaise: number; depositPercent: number; withdrawalPercent: number };
  accounts: AdminPaymentAccount[]; staff: AdminSubMember[];
  problemDays: Array<{ day: string; kind: string; count: number }>;
}
interface AdminMerchantFlag { id: number; merchantId: string; merchantName?: string; publicRef?: string; day: string; problemCount: number; threshold: number }

/** UI names for the server's role keys (merchantStaff.js STAFF_ROLES). §11. */
const ROLE_LABEL: Record<string, string> = { DEPOSITS: 'Deposits', WITHDRAWALS: 'Withdrawals', AUDIT: 'Audit' };

export const MerchantAccountsPanel: React.FC<{ reloadKey?: number }> = ({ reloadKey = 0 }) => {
  const [accounts, setAccounts] = useState<AdminMerchantAccount[]>([]);
  const [flags, setFlags] = useState<AdminMerchantFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setProblem('');
    try {
      const [a, f] = await Promise.all([api.merchants.listMerchantAccounts(), api.merchants.listMerchantFlags(30)]);
      setAccounts(Array.isArray(a?.merchantAccounts) ? a.merchantAccounts : []);
      setFlags(Array.isArray(f?.flags) ? f.flags : []);
    } catch (e: any) {
      setProblem(e?.response?.data?.message || 'Could not load the merchants.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, reloadKey]);

  return (
    <section className="card mt-4" aria-labelledby="merchant-accounts-title">
      <div className="flex items-center justify-between mb-3">
        <h2 id="merchant-accounts-title" className="text-base font-semibold">Merchants (direct INR)</h2>
        <button onClick={() => void load()} className="btn-secondary flex items-center gap-1 text-sm" disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-4">
        A merchant serves INR orders itself when System Settings sends INR orders to Merchants: its own pool,
        payment accounts and sub-members, no supervisor. Create one with Create Merchant (kind Merchant), or make an
        existing INR agent one from their profile. Its pool requests are fulfilled on Supervisors &amp; Teams.
      </p>
      {problem && <p role="alert" className="text-sm text-red-400 mb-3">{problem}</p>}
      {!loading && accounts.length === 0 && !problem && (
        <p role="status" className="text-sm text-gray-400">No merchants yet.</p>
      )}
      <div className="space-y-3">
        {accounts.map((m) => (
          <article key={m.teamId} className="p-3 bg-dark-800 rounded-lg" aria-label={m.name}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{m.name}</span>
              <span className="text-xs text-gray-400">{m.ownerName} · {m.ownerRef} · {m.ownerStatus}{m.ownerOnline ? ' · online' : ''}</span>
            </div>
            <p className="text-sm text-gray-300 mt-1">
              Pool: {tokens(m.poolAvailablePaise)} tokens{m.poolHeldPaise ? ` · ${tokens(m.poolHeldPaise)} held` : ''}
              {m.poolExposure && (m.poolExposure.openBuys + m.poolExposure.openSells > 0 || m.poolExposure.heldDisputedPaise > 0) && ` (${poolExposureLine(m.poolExposure, tokens)})`}
              {' · '}Commission {m.commission.depositPercent}% buys, {m.commission.withdrawalPercent}% sells: {tokens(m.commission.paidPaise)} paid, {tokens(m.commission.owedPaise)} owed
            </p>
            <div className="grid md:grid-cols-2 gap-3 mt-2 text-xs">
              <div>
                <p className="text-gray-400 mb-1">Payment accounts ({m.accounts.length})</p>
                <ul className="space-y-0.5">
                  {m.accounts.map((a) => (
                    <li key={a.accountId}>
                      {a.label} · {a.kind === 'UPI_QR' ? 'UPI scanner' : 'Bank'} · {a.bankName} ·{String(a.accountNo).slice(-4)} · {a.status}
                      {a.acceptsDeposits ? ' · deposits' : ''}{a.paysWithdrawals ? ' · withdrawals' : ''}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-gray-400 mb-1">Sub-members ({m.staff.length})</p>
                <ul className="space-y-0.5">
                  {m.staff.map((s) => (
                    <li key={s.staffId}>{s.name} · {s.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ') || 'no roles'} · {s.status}</li>
                  ))}
                </ul>
              </div>
            </div>
            {m.problemDays.length > 0 && (
              <p className="text-xs text-amber-400 mt-2">
                Problems, last 14 days: {m.problemDays.map((p) => `${p.day} ${p.kind.toLowerCase().replace(/_/g, ' ')} ×${p.count}`).join(' · ')}
              </p>
            )}
          </article>
        ))}
      </div>

      <h3 className="text-sm font-semibold mt-5 mb-2 flex items-center gap-1"><Flag size={14} /> Merchant flags (last 30 days)</h3>
      <p className="text-xs text-gray-400 mb-2">A flag suspends nothing; suspend by hand if it is warranted.</p>
      {flags.length === 0 ? (
        <p className="text-sm text-gray-400">No flags.</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Merchant flags</caption>
          <thead><tr className="text-left text-gray-400"><th className="py-1 pr-3 font-medium">Day</th><th className="py-1 pr-3 font-medium">Merchant</th><th className="py-1 font-medium">Problems / threshold</th></tr></thead>
          <tbody>
            {flags.map((f) => (
              <tr key={f.id} className="border-t border-dark-700">
                <td className="py-1 pr-3">{f.day}</td>
                <td className="py-1 pr-3">{f.merchantName ?? f.merchantId}{f.publicRef ? ` · ${f.publicRef}` : ''}</td>
                <td className="py-1">{f.problemCount} / {f.threshold}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};

export default MerchantAccountsPanel;
