// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

export default function VIPPage() {
  const navigate = useNavigate();
  const [data, setData]   = useState<any>({});
  const [config, setConfig] = useState<any>({ levels: [] });

  useEffect(() => {
    const token = localStorage.getItem('auth_token') || '';
    const h = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/vip/my', { headers: h, credentials: 'include' }).then(r => r.json()),
      fetch('/api/vip/config').then(r => r.json()),
    ]).then(([v, c]) => {
      if(v.success) setData(v);
      if(c.success) setConfig(c.config||{ levels:[] });
    });
  }, []);

  const levels = config.levels || [];
  const myLevel = data.vip?.currentLevel || 0;
  const myDeposit = data.vip?.totalDeposited || 0;
  const current = levels.find((l:any) => l.level === myLevel) || {};
  const next    = levels.find((l:any) => l.level === myLevel + 1);
  const progress = next ? Math.min(100, (myDeposit / next.minTotalDeposit) * 100) : 100;

  return (
    <div className="h-full overflow-y-auto bg-[#0A0F1C] text-white pb-4">
      <div className="bg-gradient-to-b from-purple-900/30 to-transparent px-4 pt-4 pb-5">
        <button onClick={() => navigate(-1)} className="text-gray-500 text-xs mb-3 block">← Back</button>
        <h1 className="text-xl font-bold">💎 VIP Program</h1>
      </div>

      {/* Current level card */}
      <div className="mx-4 mb-5">
        <div className="bg-gradient-to-br from-purple-900/40 to-dark-800 border border-purple-700/30 rounded-2xl p-5 text-center">
          <div className="text-4xl mb-2">{current.badgeIcon || '🥉'}</div>
          <p className="text-xl font-bold" style={{color: current.badgeColor || '#fff'}}>{current.name || 'Bronze'}</p>
          <p className="text-gray-400 text-xs mt-1">Total deposited: ₹{myDeposit.toLocaleString()}</p>
          {next && (
            <div className="mt-4">
              <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                <span>Progress to {next.name}</span>
                <span>₹{(next.minTotalDeposit - myDeposit).toLocaleString()} more</span>
              </div>
              <div className="w-full bg-dark-700 rounded-full h-2"><div className="h-2 rounded-full bg-gradient-to-r from-purple-500 to-yellow-500 transition-all" style={{width:`${progress}%`}}/></div>
            </div>
          )}
          {!next && <p className="text-yellow-400 text-sm mt-3 font-semibold">🏆 Maximum VIP Level!</p>}
        </div>
      </div>

      {/* Perks */}
      {current.level !== undefined && (
        <div className="mx-4 mb-5 bg-dark-800 border border-dark-700 rounded-xl p-4 space-y-2">
          <p className="font-semibold text-sm mb-3">Your {current.name} Perks</p>
          <div className="flex justify-between text-sm"><span className="text-gray-400">Daily Withdrawal Limit</span><span className="text-green-400 font-medium">₹{(current.dailyWithdrawalLimit||10000).toLocaleString()}</span></div>
          <div className="flex justify-between text-sm"><span className="text-gray-400">Deposit Bonus</span><span className="text-yellow-400 font-medium">{current.bonusPercent||0}%</span></div>
          <div className="flex justify-between text-sm"><span className="text-gray-400">Fee Discount</span><span className="text-blue-400 font-medium">{current.withdrawalFeeDiscount||0}%</span></div>
        </div>
      )}

      {/* All levels */}
      <div className="mx-4 space-y-2">
        <p className="font-semibold text-sm mb-3">All VIP Levels</p>
        {levels.map((lvl:any) => (
          <div key={lvl.level} className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${lvl.level === myLevel?'border-yellow-500/40 bg-yellow-500/5':'border-dark-700 bg-dark-800'}`}>
            <span className="text-2xl">{lvl.badgeIcon}</span>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm" style={{color:lvl.badgeColor}}>{lvl.name}</span>
                {lvl.level === myLevel && <span className="text-[9px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">CURRENT</span>}
              </div>
              <span className="text-[10px] text-gray-500">Deposit ₹{lvl.minTotalDeposit.toLocaleString()}+</span>
            </div>
            <div className="text-right text-[10px] text-gray-400">
              <div>+{lvl.bonusPercent}% bonus</div>
              <div>₹{lvl.dailyWithdrawalLimit?.toLocaleString()} daily</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
