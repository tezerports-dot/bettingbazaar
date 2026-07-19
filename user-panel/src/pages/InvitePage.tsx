// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

export default function InvitePage() {
  const navigate = useNavigate();
  const [data, setData]   = useState<any>(null);
  // H-03 NOTICE: Only F1 (direct referral) commissions are paid out by gameEngine.js.
// F2/F3 tree data is shown for reference only — those levels do NOT earn commission.
// GOVERNANCE §7: commission calculated but not paid is a violation of this rule's spirit.
const [team, setTeam]   = useState<any>({ f1:[], f2:[], f3:[] });
  const [copied, setCopied] = useState(false);
  const [tab, setTab]     = useState<'invite'|'team'|'earnings'>('invite');

  useEffect(() => {
    const token = localStorage.getItem('auth_token') || '';
    const h = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/referral/me', { headers: h, credentials: 'include' }).then(r => r.json()),
      fetch('/api/referral/team', { headers: h, credentials: 'include' }).then(r => r.json()),
    ]).then(([me, t]) => {
      if (me.success) setData(me);
      if (t.success) setTeam(t);
    });
  }, []);

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const share = () => {
    if (navigator.share && data?.inviteUrl) {
      navigator.share({ title: 'Join BettingBazaar!', text: `Use my invite code ${data.inviteCode} and win big!`, url: data.inviteUrl });
    } else {
      copy(data?.inviteUrl || '');
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#0A0F1C] text-white pb-4">
      <div className="bg-gradient-to-b from-yellow-900/30 to-transparent px-4 pt-4 pb-6">
        <button onClick={() => navigate(-1)} className="text-gray-500 text-xs mb-3 block">← Back</button>
        <h1 className="text-xl font-bold">🎁 Invite & Earn</h1>
        <p className="text-gray-400 text-sm mt-1">Earn commission on every bet your referrals place</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mx-4 mb-5">
        {[
          { label:'Total Referrals', val: data?.totalReferrals || 0, icon:'👥' },
          { label:'Today Earned',    val: `₹${(data?.todayEarned||0).toFixed(0)}`, icon:'💰' },
          { label:'Total Earned',    val: `₹${(data?.totalEarned||0).toFixed(0)}`, icon:'🏆' },
        ].map(s => (
          <div key={s.label} className="bg-dark-800 border border-dark-700 rounded-xl p-3 text-center">
            <div className="text-2xl mb-1">{s.icon}</div>
            <div className="font-bold text-lg text-yellow-400">{s.val}</div>
            <div className="text-[9px] text-gray-500 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-4 mb-4">
        {(['invite','team','earnings'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${tab===t?'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30':'bg-dark-800 text-gray-400 border border-dark-700'}`}>
            {t==='invite'?'My Code':t==='team'?'My Team':'Earnings'}
          </button>
        ))}
      </div>

      {tab === 'invite' && (
        <div className="mx-4 space-y-4">
          <div className="bg-dark-800 border border-dark-700 rounded-2xl p-5 text-center">
            <p className="text-gray-400 text-xs mb-2">Your Invite Code</p>
            <p className="text-3xl font-black tracking-widest text-yellow-400 font-mono">{data?.inviteCode || '———'}</p>
          </div>
          <div className="space-y-3">
            <button onClick={() => copy(data?.inviteCode)} className="w-full bg-dark-700 border border-dark-600 hover:border-yellow-500/50 active:scale-95 text-white py-3.5 rounded-xl text-sm font-medium transition-all">
              {copied ? '✅ Copied!' : '📋 Copy Invite Code'}
            </button>
            <button onClick={() => copy(data?.inviteUrl)} className="w-full bg-dark-700 border border-dark-600 hover:border-yellow-500/50 active:scale-95 text-white py-3.5 rounded-xl text-sm font-medium transition-all">
              🔗 Copy Invite Link
            </button>
            <button onClick={share} className="w-full bg-gradient-to-r from-yellow-600 to-yellow-500 hover:from-yellow-500 hover:to-yellow-400 active:scale-95 text-black font-bold py-3.5 rounded-xl text-sm transition-all">
              📤 Share to WhatsApp / Telegram
            </button>
          </div>
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-4 space-y-2 text-xs">
            <p className="font-semibold text-white">How it works</p>
            <p className="text-gray-400">🎯 Direct Referral (F1): Earn 1% on every winning bet your direct invite places</p>
            <p className="text-gray-400">💡 Rate is set by admin and may change — check Earnings tab for current rate</p>
            <p className="text-gray-400">💰 Commissions credited to your Winnings Balance within 5 minutes of payout</p>
            <p className="text-gray-400">🔒 Commission only on winning bets — encouraging your team to play smart</p>
          </div>
        </div>
      )}

      {tab === 'team' && (
        <div className="mx-4 space-y-3">
          {[{label:'Direct Referrals', data:team.f1 || [], icon:'🤝'}].map(lvl => (
            <div key={lvl.label} className="bg-dark-800 border border-dark-700 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold">{lvl.icon} {lvl.label}</span>
                <span className="text-xs text-yellow-400">{lvl.data.length} members</span>
              </div>
              {lvl.data.slice(0,5).map((m:any) => (
                <div key={m.userId} className="flex items-center gap-3 py-2 border-t border-dark-700">
                  <div className="w-8 h-8 rounded-full bg-dark-600 flex items-center justify-center text-sm">👤</div>
                  <div><p className="text-sm font-medium">{m.username || '***' + m.mobile}</p><p className="text-[10px] text-gray-500">{new Date(m.joinedAt).toLocaleDateString()}</p></div>
                </div>
              ))}
              {lvl.data.length === 0 && <p className="text-gray-600 text-xs text-center py-2">No members yet</p>}
            </div>
          ))}
        </div>
      )}

      {tab === 'earnings' && (
        <div className="mx-4">
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-4 text-center text-gray-500 text-sm">
            Commission details load from your referral history. All earnings go to your Winnings Balance.
          </div>
        </div>
      )}
    </div>
  );
}
