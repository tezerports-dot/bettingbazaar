// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useState } from 'react';
import { useNavigate } from 'react-router';

export default function GiftCodePage() {
  const navigate = useNavigate();
  const [code, setCode]     = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const redeem = async () => {
    if (!code.trim()) return;
    setLoading(true); setResult(null);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const r = await fetch('/api/giftcode/redeem', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.toUpperCase().trim() }),
      });
      const d = await r.json();
      setResult(d);
      if (d.success) setCode('');
    } finally { setLoading(false); }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#0A0F1C] text-white pb-4">
      <div className="bg-gradient-to-b from-green-900/30 to-transparent px-4 pt-4 pb-6">
        <button onClick={() => navigate(-1)} className="text-gray-500 text-xs mb-3 block">← Back</button>
        <h1 className="text-xl font-bold">🎁 Redeem Gift Code</h1>
        <p className="text-gray-400 text-sm mt-1">Enter your code and claim your bonus instantly</p>
      </div>

      <div className="mx-4 space-y-4">
        <div className="bg-dark-800 border border-dark-700 rounded-2xl p-6 space-y-4">
          <div>
            <label className="text-xs text-gray-400 block mb-2">Enter Gift Code</label>
            <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && redeem()}
              placeholder="E.g. DIWALI50"
              className="w-full bg-dark-700 border border-dark-600 focus:border-green-500/50 rounded-xl px-4 py-3.5 text-white font-mono text-lg tracking-widest outline-none text-center uppercase"/>
          </div>
          <button onClick={redeem} disabled={loading || !code.trim()}
            className="w-full bg-green-600 hover:bg-green-500 active:scale-95 disabled:opacity-50 text-white font-bold py-3.5 rounded-xl text-sm transition-all">
            {loading ? '⏳ Checking…' : '🎁 Redeem Code'}
          </button>
        </div>

        {result && (
          <div className={`p-4 rounded-2xl border text-center ${result.success?'border-green-500/40 bg-green-500/10':'border-red-500/40 bg-red-500/10'}`}>
            <div className="text-3xl mb-2">{result.success ? '🎉' : '❌'}</div>
            <p className={`font-bold ${result.success?'text-green-400':'text-red-400'}`}>{result.message}</p>
            {result.success && result.amount && <p className="text-white text-sm mt-1">₹{result.amount} added to your balance!</p>}
          </div>
        )}

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-4 space-y-2 text-xs text-gray-400">
          <p className="font-semibold text-white">How gift codes work</p>
          <p>• Each code can only be used once per account</p>
          <p>• Deposit-type codes add to your deposit balance (play only)</p>
          <p>• Winnings-type codes add to your withdrawable winnings balance</p>
          <p>• Codes may have expiry dates — use them quickly!</p>
          <p>• Get codes from promotions, social media, and events</p>
        </div>
      </div>
    </div>
  );
}
