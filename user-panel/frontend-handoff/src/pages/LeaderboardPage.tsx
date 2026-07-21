// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

type Period = 'daily'|'weekly'|'monthly'|'alltime';

export default function LeaderboardPage() {
  const navigate = useNavigate();
  const [period, setPeriod]   = useState<Period>('daily');
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [generated, setGenerated] = useState('');

  useEffect(() => {
    setLoading(true);
    fetch(`/api/leaderboard/${period}`)
      .then(r => r.json())
      .then(d => { if(d.success){ setEntries(d.entries||[]); setGenerated(d.generatedAt||''); } })
      .finally(() => setLoading(false));
  }, [period]);

  const PERIODS: { key: Period; label: string }[] = [
    {key:'daily',label:'Today'},{key:'weekly',label:'Week'},{key:'monthly',label:'Month'},{key:'alltime',label:'All Time'}
  ];
  const medals = ['🥇','🥈','🥉'];

  return (
    <div className="h-full overflow-y-auto bg-[#0A0F1C] text-white pb-4">
      <div className="bg-gradient-to-b from-yellow-900/30 to-transparent px-4 pt-4 pb-5">
        <button onClick={() => navigate(-1)} className="text-gray-500 text-xs mb-3 block">← Back</button>
        <h1 className="text-xl font-bold">🏆 Leaderboard</h1>
        <p className="text-gray-400 text-xs mt-1">Top winners by net profit · Updates every 10 min</p>
      </div>

      <div className="flex gap-2 px-4 mb-4">
        {PERIODS.map(p => (
          <button key={p.key} onClick={() => setPeriod(p.key)}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${period===p.key?'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30':'bg-dark-800 text-gray-400 border border-dark-700'}`}>
            {p.label}
          </button>
        ))}
      </div>

      {loading
        ? <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin"/></div>
        : entries.length === 0
          ? <div className="text-center py-16 text-gray-600">No data yet for this period</div>
          : (
            <div className="px-4 space-y-2">
              {entries.slice(0,3).length > 0 && (
                <div className="grid grid-cols-3 gap-2 mb-4">
                  {[entries[1], entries[0], entries[2]].filter(Boolean).map((e,i) => {
                    const realRank = i===0?2:i===1?1:3;
                    return (
                      <div key={e._id||e.userId} className={`rounded-2xl p-3 text-center border ${realRank===1?'border-yellow-500/50 bg-yellow-500/10':realRank===2?'border-gray-500/40 bg-gray-500/5':'border-orange-700/40 bg-orange-700/5'} ${realRank===1?'mt-0':'mt-4'}`}>
                        <div className="text-3xl mb-1">{medals[realRank-1]}</div>
                        <div className="font-bold text-sm text-white truncate">{e.username}</div>
                        <div className="text-green-400 font-bold text-xs mt-1">₹{(e.netProfit||0).toLocaleString()}</div>
                        <div className="text-gray-600 text-[9px]">{e.totalBets} bets</div>
                      </div>
                    );
                  })}
                </div>
              )}
              {entries.slice(3).map(e => (
                <div key={e._id||e.userId} className="flex items-center gap-3 bg-dark-800 border border-dark-700 rounded-xl px-4 py-3">
                  <span className="text-gray-500 font-mono text-sm w-6 text-center">#{e.rank}</span>
                  <div className="w-8 h-8 rounded-full bg-dark-600 flex items-center justify-center text-sm font-bold text-gray-400">{(e.username||'?')[0]?.toUpperCase()}</div>
                  <div className="flex-1"><p className="text-sm font-medium">{e.username}</p><p className="text-[10px] text-gray-500">{e.totalBets} bets · {e.winRate}% win rate</p></div>
                  <div className="text-right"><p className="text-green-400 font-bold text-sm">₹{(e.netProfit||0).toLocaleString()}</p></div>
                </div>
              ))}
              {generated && <p className="text-center text-[9px] text-gray-700 mt-2">Updated: {new Date(generated).toLocaleTimeString()}</p>}
            </div>
          )
      }
    </div>
  );
}
