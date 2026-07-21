// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// PART-A-V5
/**
 * MyBetsPage.tsx  v5.0.0
 *
 * Two tabs:
 *   BETS         — cycle-grouped. All bets in the same cycle collapsed into
 *                  ONE card: Delhi ₹X | Bombay ₹Y, result, net P&L.
 *   TRANSACTIONS — deposit / withdrawal / payout ledger.
 *
 * Filter (WON/LOST/PENDING/ALL) applies to cycles, not individual bets.
 */
import React, { useState, useEffect } from 'react';
import { useGame } from '../services/GameContext';
import { useNavigate } from 'react-router-dom';
import { getBackend } from '../services/backend.service';
import { Bet } from '../types';

const backend = getBackend();

type MainTab   = 'BETS' | 'TRANSACTIONS';
// FIX2-NO-FILTER-TABS: filter removed

interface CycleGroup {
  cycleId:      string;
  cycleType:    string | null;
  delhiTotal:   number;
  bombayTotal:  number;
  delhiStatus:  string;
  bombayStatus: string;
  result:       'WON' | 'LOST' | 'PENDING' | 'SPLIT';
  payout:       number;
  wagered:      number;
  netPL:        number;
  timestamp:    number;
}

function groupBetsByCycle(bets: Bet[]): CycleGroup[] {
  const map = new Map<string, Bet[]>();
  bets.forEach(b => {
    const key = b.cycleId || 'unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(b);
  });
  const groups: CycleGroup[] = [];
  map.forEach((cycleBets, cycleId) => {
    const dBets = cycleBets.filter(b => b.side === 'DELHI');
    const bBets = cycleBets.filter(b => b.side === 'BOMBAY');
    const dTotal = dBets.reduce((s, b) => s + (b.amount || 0), 0);
    const bTotal = bBets.reduce((s, b) => s + (b.amount || 0), 0);
    const wagered = dTotal + bTotal;
    const sideStatus = (sb: Bet[]): string => {
      if (!sb.length)                          return 'NONE';
      if (sb.some(b => b.status === 'WON'))   return 'WON';
      if (sb.every(b => b.status === 'LOST')) return 'LOST';
      return 'PENDING';
    };
    const dStatus = sideStatus(dBets);
    const bStatus = sideStatus(bBets);
    const payout = cycleBets.filter(b => b.status === 'WON')
      .reduce((s, b) => s + (b.payout || b.amount * 2 || 0), 0);
    const netPL = payout - wagered;
    const hasWon     = dStatus === 'WON'  || bStatus === 'WON';
    const hasLost    = dStatus === 'LOST' || bStatus === 'LOST';
    const hasPending = dStatus === 'PENDING' || bStatus === 'PENDING'
                    || dStatus === 'NONE'    || bStatus === 'NONE';
    let result: CycleGroup['result'] = 'PENDING';
    if (!hasPending) {
      if (hasWon && hasLost) result = 'SPLIT';
      else if (hasWon)       result = 'WON';
      else                   result = 'LOST';
    }
    groups.push({
      cycleId, cycleType: (cycleBets[0] as any).cycleType || null,
      delhiTotal: dTotal, bombayTotal: bTotal,
      delhiStatus: dStatus, bombayStatus: bStatus,
      result, payout, wagered, netPL,
      timestamp: Math.max(...cycleBets.map(b => b.timestamp || 0)),
    });
  });
  return groups.sort((a, b) => b.timestamp - a.timestamp);
}


function gameTag(cycleId: string, cycleType: string | null) {
  const id = (cycleId || '').toLowerCase();
  const t  = (cycleType || '').toLowerCase();
  if (t.includes('crash') || id.includes('crash'))   return { label: '✈️ Crash',  color: '#60a5fa' };
  if (t.includes('casino') || id.includes('casino')) return { label: '🃏 Casino', color: '#a78bfa' };
  if (t.includes('sport') || id.includes('sport'))   return { label: '⚽ Sports', color: '#34d399' };
  return { label: '🎯 Bazaar', color: '#D4AF37' };
}

function cycleLabel(id: string, type: string | null) {
  if (type === 'FULL_DAY' || type === 'FULLDAY')       return 'Full Day';
  if (type === '30_MIN'   || type === 'THIRTY_MIN')    return '30 Min';
  if (id.startsWith('30MIN'))   return '30 Min';
  if (id.startsWith('FULLDAY')) return 'Full Day';
  return 'Cycle';
}
function shortId(id: string) {
  const p = id.split('_'); const ts = p[p.length - 1];
  return ts.length >= 6 ? `#${ts.slice(-6)}` : `#${ts}`;
}

const ResultBadge: React.FC<{ result: CycleGroup['result'] }> = ({ result }) => {
  const cls: Record<string, string> = {
    WON:     'bg-green-900/50 text-green-400 border-green-500/40',
    LOST:    'bg-red-900/50 text-red-400 border-red-500/40',
    SPLIT:   'bg-blue-900/50 text-blue-400 border-blue-500/40',
    PENDING: 'bg-yellow-900/40 text-yellow-400 border-yellow-500/30',
  };
  const lbl = { WON:'Won', LOST:'Lost', SPLIT:'Split', PENDING:'Live' };
  return (
    <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full border ${cls[result]}`}>
      {lbl[result]}
    </span>
  );
};

const SideChip: React.FC<{ label: string; total: number; status: string }> = ({ label, total, status }) => {
  if (total === 0) return null;
  const isD = label === 'Delhi';
  const won = status === 'WON'; const lost = status === 'LOST';
  return (
    <div className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border
      ${won ? 'bg-green-900/20 border-green-500/30' :
        lost? 'bg-red-900/20 border-red-500/30' :
        isD ? 'bg-blue-900/20 border-blue-500/20' : 'bg-orange-900/20 border-orange-500/20'}`}>
      <span className={`text-[10px] font-black ${isD ? 'text-blue-400' : 'text-orange-400'}`}>{label}</span>
      <span className="text-white font-bold text-xs">₹{total.toLocaleString()}</span>
      {won  && <span className="text-green-400 text-[9px]">✓</span>}
      {lost && <span className="text-red-400   text-[9px]">✗</span>}
    </div>
  );
};

const CycleCard: React.FC<{ g: CycleGroup }> = ({ g }) => {
  const pos = g.netPL > 0; const neg = g.netPL < 0;
  return (
    <div className={`rounded-2xl border overflow-hidden
      ${g.result==='WON' ?'border-green-500/20 bg-green-950/10':
        g.result==='LOST'?'border-red-500/20 bg-red-950/10':
        g.result==='SPLIT'?'border-blue-500/20 bg-blue-950/10':'border-white/5 bg-[#1A1F2E]'}`}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          {(() => { const tag = gameTag(g.cycleId, g.cycleType); return (
            <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full border"
              style={{ color: tag.color, borderColor: `${tag.color}40`, background: `${tag.color}12` }}>
              {tag.label}
            </span>
          ); })()}
          <span className="text-[10px] font-black text-slate-500 uppercase">{cycleLabel(g.cycleId, g.cycleType)}</span>
          <span className="text-[10px] text-slate-600 font-mono">{shortId(g.cycleId)}</span>
        </div>
        <div className="flex items-center gap-2">
          <ResultBadge result={g.result} />
          <span className="text-[10px] text-slate-600">
            {new Date(g.timestamp).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
          </span>
        </div>
      </div>
      <div className="px-4 py-3 flex flex-wrap gap-2">
        <SideChip label="Delhi"  total={g.delhiTotal}  status={g.delhiStatus}  />
        <SideChip label="Bombay" total={g.bombayTotal} status={g.bombayStatus} />
      </div>
      <div className="flex items-center justify-between px-4 py-2 border-t border-white/5 bg-black/10">
        <div className="text-[10px] text-slate-500">
          Wagered: <span className="text-slate-400 font-bold">₹{g.wagered.toLocaleString()}</span>
          {g.payout > 0 && <> · Payout: <span className="text-green-400 font-bold">₹{g.payout.toLocaleString()}</span></>}
        </div>
        <div className={`text-sm font-black ${pos?'text-[#25D366]':neg?'text-[#E53935]':'text-slate-400'}`}>
          {pos?'+':neg?'−':''}₹{Math.abs(g.netPL).toLocaleString()}
        </div>
      </div>
    </div>
  );
};

const TxnRow: React.FC<{ txn: any }> = ({ txn }) => {
  const isIn = ['DEPOSIT','WIN','REFUND'].includes(txn.type);
  const labels: Record<string,string> = {
    DEPOSIT:'Token Purchase', WITHDRAWAL:'Token Sale', WIN:'Game Payout',
    BET:'Bet Placed', REFUND:'Refund', ADMIN_ADJUSTMENT:'Admin Adjustment',
  };
  return (
    <div className="bg-[#121826] border border-white/5 rounded-xl p-4 flex justify-between items-center">
      <div className="flex items-center gap-3">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0
          ${isIn?'bg-green-900/50 text-green-400':'bg-red-900/50 text-red-400'}`}>
          {isIn ? '↓' : '↑'}
        </div>
        <div>
          <div className="text-xs font-bold text-white">{labels[txn.type] || txn.type?.replace(/_/g,' ')}</div>
          <div className="text-[10px] text-slate-500">{txn.reference || txn.description || txn.note || '—'}</div>
          <div className="text-[9px] text-slate-600">
            {txn.createdAt ? new Date(txn.createdAt).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : ''}
          </div>
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className={`font-black text-sm ${isIn?'text-[#25D366]':'text-[#E53935]'}`}>
          {isIn?'+':'−'}₹{(txn.amount||0).toLocaleString()}
        </div>
        <div className="text-[9px] text-slate-500">{txn.status || ''}</div>
      </div>
    </div>
  );
};

const MyBetsPage: React.FC = () => {
  const { user, userBets: contextBets } = useGame();
  const navigate = useNavigate();
  const [mainTab,      setMainTab]      = useState<MainTab>('BETS');
  // FIX2-NO-FILTER-TABS: betFilter state removed
  const [allBets,      setAllBets]      = useState<Bet[]>([]);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [txnLoading,   setTxnLoading]   = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    setLoading(true);
    backend.getBetHistory(user.id)
      .then((res: any) => setAllBets(Array.isArray(res) ? res : (res?.bets || [])))
      .catch(() => setAllBets(contextBets || []))
      .finally(() => setLoading(false));
  }, [user?.id]);

  useEffect(() => {
    if (mainTab !== 'TRANSACTIONS' || !user?.id || transactions.length > 0) return;
    setTxnLoading(true);
    (backend as any).getTransactionHistory?.(user.id)
      .then((t: any[]) => setTransactions(t || []))
      .catch(() => setTransactions([]))
      .finally(() => setTxnLoading(false));
  }, [mainTab, user?.id]);

  const allGroups = groupBetsByCycle(allBets);
  const filtered = allGroups; // FIX2-NO-FILTER-TABS: show all cycles

  // MYBETS-CLEAN-V6: stats vars removed

  return (
    <div className="h-full flex flex-col bg-[#0B0E14]">
      <div className="flex-1 overflow-y-auto pb-4">

        {/* Main tab toggle */}
        <div className="px-4 pt-4 pb-2 flex gap-2">
          {(['BETS','TRANSACTIONS'] as MainTab[]).map(t => (
            <button key={t} onClick={() => setMainTab(t)}
              className={`flex-1 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all
                ${mainTab===t
                  ? 'bg-[#D4AF37] text-black shadow-[0_0_12px_rgba(212,175,55,0.3)]'
                  : 'bg-[#1A1F2E] text-slate-400 border border-white/5'}`}>
              {t === 'BETS' ? '🎯 Bet History' : '💳 Transactions'}
            </button>
          ))}
        </div>

        {/* ── BETS TAB ── */}
        {mainTab === 'BETS' && (
          <>
            {/* MYBETS-CLEAN-V6: stats card removed */}

            {/* FIX2-NO-FILTER-TABS: filter tabs removed */}

            <div className="px-4 space-y-3">
              {loading ? (
                <div className="flex flex-col items-center py-16 gap-4">
                  <div className="w-10 h-10 border-4 border-[#D4AF37]/20 border-t-[#D4AF37] rounded-full animate-spin" />
                  <p className="text-slate-500 text-xs">Loading…</p>
                </div>
              ) : filtered.length === 0 ? (
                <div className="text-center py-16">
                  <div className="text-5xl mb-4">🎯</div>
                  <h3 className="text-white font-bold mb-2">No bets yet</h3>
                  <p className="text-slate-400 text-sm">Place your first bet to get started.</p>
                  <button onClick={() => navigate('/')} className="mt-4 bg-[#D4AF37] text-black font-black px-6 py-2 rounded-xl text-sm">Play Now</button>
                </div>
              ) : (
                filtered.map(g => <CycleCard key={g.cycleId} g={g} />)
              )}
            </div>
          </>
        )}

        {/* ── TRANSACTIONS TAB ── */}
        {mainTab === 'TRANSACTIONS' && (
          <div className="px-4 pt-2 space-y-2">
            <div className="text-[9px] text-slate-500 bg-[#0B0E14] rounded px-2 py-1.5 mb-1 border border-white/5">
              💡 These records can be used as evidence for ITR / income tax filings.
            </div>
            {txnLoading ? (
              <div className="flex flex-col items-center py-16 gap-4">
                <div className="w-10 h-10 border-4 border-[#D4AF37]/20 border-t-[#D4AF37] rounded-full animate-spin" />
                <p className="text-slate-500 text-xs">Loading transactions…</p>
              </div>
            ) : transactions.length === 0 ? (
              <div className="text-center py-16">
                <div className="text-5xl mb-4">💳</div>
                <h3 className="text-white font-bold mb-2">No transactions yet</h3>
                <p className="text-slate-400 text-sm">Your deposit and withdrawal history will appear here.</p>
              </div>
            ) : (
              transactions
                .filter((txn: any) => txn.type === 'DEPOSIT' || txn.type === 'WITHDRAWAL')
                .map((txn: any, i: number) => <TxnRow key={txn.id || txn._id || i} txn={txn} />)
            )}
          </div>
        )}

      </div>
    </div>
  );
};

export default MyBetsPage;
