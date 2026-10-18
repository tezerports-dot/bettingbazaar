// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Profit and loss counted from the token ledger: every token the platform
 * gained or gave away, movement by movement (`GET /api/admin/analytics/token-profit`,
 * `database/repositories/tokenLedger.js`). Rendered under the P&L on the same
 * window; the server classifies and sums, this screen adds nothing up.
 */
import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { downloadCsv, cleanParams } from '../../services/api';
import { usePermissions } from '../../hooks/usePermission';
import { formatters } from '../../utils/formatters';

/** `tokenLedger.tokenProfit`, as the route sends it. Rupees, 1 token = ₹1. */
interface TokenProfit {
  kinds: {
    kind: string; profit: boolean; tokens: number; movements: number;
    operations: { operation: string; movements: number; tokens: number; wallets: number; pools: number }[];
  }[];
  netProfit: number;
  unclassifiedMovements: number;
  cash: { receivedFromTeams: number; receivedFromPlayersUsdt: number; paidToTeams: number; net: number };
  outstandingNow: { wallets: number; pools: number; total: number };
}

/** What each kind means, for the reader. Display text only (§11). */
const KIND_LABEL: Record<string, string> = {
  GAME_BOARD: 'Board games (kept or paid by the house)',
  GAME_CASINO: 'Casino games',
  BONUS: 'Bonuses given (referral, first deposit)',
  COMMISSION: 'Team commission given',
  PLATFORM_COVER: 'Sell refunds the platform covered',
  ADJUSTMENT: 'Admin balance adjustments',
  POOL_TRADE: 'Tokens sold to / bought back from team pools (exchange, not profit)',
  PLAYER_TRADE: 'Player buys and sells through pools (zero for the platform)',
  COMPENSATION: 'Dispute compensation paid by teams to players (zero for the platform)',
  INTERNAL: 'Between platform accounts (zero)',
  UNCLASSIFIED: 'Not classified',
};

const fmt = (n: number) => formatters.currency(n);

export const TokenLedgerPanel: React.FC<{ start: string; end: string }> = ({ start, end }) => {
  const { can } = usePermissions();
  const [data, setData] = useState<TokenProfit | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api.get<any>('/api/admin/analytics/token-profit', { params: cleanParams({ startDate: start, endDate: end }) })
      .then((r) => { if (live) { setData(r.data?.data ?? null); setFailed(!r.data?.success); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [start, end]);

  const exportMovements = async () => {
    try {
      await downloadCsv('/api/admin/analytics/token-movements.csv',
        cleanParams({ startDate: start, endDate: end }), 'token-movements.csv');
    } catch { toast.error('Export failed'); }
  };

  if (failed) return <div className="card" role="alert"><p className="text-sm text-red-400">Could not read the token ledger.</p></div>;
  if (!data) return null;
  const cashPosition = data.cash.net - data.outstandingNow.total;
  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h3 className="text-base font-semibold">Token ledger: every token in and out</h3>
        {can('canExportLedger') && (
          <button onClick={exportMovements} className="btn-secondary text-xs flex items-center gap-1">
            <Download className="w-3.5 h-3.5" /> Download every movement (CSV)
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Counted from each token movement (every bet settled, casino transaction, bonus, commission and pool trade).
        Positive means the platform holds more tokens.
      </p>
      {data.unclassifiedMovements > 0 && (
        <p className="text-sm text-red-400 mb-2" role="alert">
          {data.unclassifiedMovements} movement(s) have an operation this report does not classify.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-gray-500 border-b border-dark-600">
            <th className="pb-2 font-medium">Kind / operation</th>
            <th className="pb-2 font-medium text-right">Movements</th>
            <th className="pb-2 font-medium text-right">Platform tokens</th>
          </tr></thead>
          <tbody className="divide-y divide-dark-700">
            {data.kinds.filter((k) => k.movements > 0).map((k) => (
              <React.Fragment key={k.kind}>
                <tr>
                  <td className="py-2 font-medium">{KIND_LABEL[k.kind] ?? k.kind}</td>
                  <td className="py-2 text-right text-gray-400">{k.movements.toLocaleString()}</td>
                  <td className={`py-2 text-right font-semibold ${!k.profit ? 'text-gray-400' : k.tokens >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmt(k.tokens)}</td>
                </tr>
                {k.operations.map((o) => (
                  <tr key={o.operation} className="text-xs text-gray-500">
                    <td className="py-1 pl-4">{o.operation}</td>
                    <td className="py-1 text-right">{o.movements.toLocaleString()}</td>
                    <td className="py-1 text-right">{fmt(o.tokens)}</td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div className="p-3 bg-dark-700 rounded-lg">
          <p className="text-xs text-gray-400">Net profit in tokens (this window)</p>
          <p className={`text-xl font-bold ${data.netProfit >= 0 ? 'text-gold-500' : 'text-red-400'}`}>{fmt(data.netProfit)}</p>
        </div>
        <div className="p-3 bg-dark-700 rounded-lg text-xs text-gray-400 space-y-1">
          <p className="font-medium text-gray-300">Cash check</p>
          <p>Paid by teams for pool tokens: {fmt(data.cash.receivedFromTeams)}</p>
          <p>Paid by players in USDT (at ₹1 a token): {fmt(data.cash.receivedFromPlayersUsdt)}</p>
          <p>Paid back to teams: {fmt(-data.cash.paidToTeams)}</p>
          <p>Tokens now in wallets and pools, owed back at ₹1: {fmt(-data.outstandingNow.total)}</p>
          <p className="text-gray-300">Cash position if everyone cashed out now: {fmt(cashPosition)}</p>
        </div>
      </div>
    </div>
  );
};
