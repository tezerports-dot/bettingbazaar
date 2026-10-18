// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * RtpFunds.tsx — the RTP switch on Admin › Boards (owner, 2026-10-17): per
 * board and profile, on/off and the rate, the fund's balance, the rounds a
 * house bet helped and what the fund returned, and the per-round entries
 * (with CSV). Server: boards.admin.routes.js `/rtp` over database/repositories/rtp.js.
 */
import React, { useEffect, useState } from 'react';
import { Download, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { boards as boardsApi } from '../../services/api';

interface Fund {
  gameKey: string; gameName?: string; audience: 'VIP' | 'GENERAL'; enabled: boolean; ratePercent: number;
  balancePaise: number; roundsHelped: number; returnedPaise: number;
}
interface Entry {
  id: number; cycleId: string; rateBp: number; poolPaise: number; paidBackPaise: number;
  deltaPaise: number; balanceAfterPaise: number; houseBetPaise: number; createdAt: string;
}

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const inp = 'w-20 bg-[#0B0E14] border border-[#1e2736] rounded-lg p-1.5 text-sm text-white outline-hidden focus:border-yellow-500';

function downloadCsv(name: string, entries: Entry[]) {
  const head = 'cycle_id,rate_percent,pool_rupees,paid_back_rupees,delta_rupees,balance_after_rupees,house_bet_rupees,at';
  const lines = entries.map((e) => [e.cycleId, e.rateBp / 100, e.poolPaise / 100, e.paidBackPaise / 100,
    e.deltaPaise / 100, e.balanceAfterPaise / 100, e.houseBetPaise / 100, e.createdAt].join(','));
  const url = URL.createObjectURL(new Blob([[head, ...lines].join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

export const RtpFunds: React.FC = () => {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [open, setOpen] = useState<{ key: string; entries: Entry[] } | null>(null);

  const load = async () => {
    try { setFunds((await boardsApi.rtpFunds()).funds ?? []); } catch { toast.error('Failed to load the RTP funds'); }
  };
  useEffect(() => { void load(); }, []);

  const edit = (f: Fund, patch: Partial<Fund>) =>
    setFunds((all) => all.map((x) => (x.gameKey === f.gameKey && x.audience === f.audience ? { ...x, ...patch } : x)));

  const save = async (f: Fund) => {
    try {
      await boardsApi.saveRtp(f.gameKey, f.audience, { enabled: f.enabled, ratePercent: Number(f.ratePercent) });
      toast.success(`RTP saved for ${f.gameKey} ${f.audience === 'VIP' ? 'VIP' : 'General'}`);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Failed to save the RTP setting');
    }
  };

  const showEntries = async (f: Fund) => {
    try {
      const key = `${f.gameKey}:${f.audience}`;
      setOpen({ key, entries: (await boardsApi.rtpEntries(f.gameKey, f.audience)).entries ?? [] });
    } catch { toast.error('Failed to load the RTP entries'); }
  };

  return (
    <div className="mt-8">
      <h2 className="text-base font-semibold text-white">RTP (return to player)</h2>
      <p className="text-xs text-slate-500 mb-3">
        Each round adds the rate × the real player pool, minus what players got back, to the fund. When the fund covers
        a whole round, the house places a real bet as the round's last bet so the side most players backed wins.
        Phantom bets are never part of this. Cricket keeps its own fund (VIP only): each ended poll adds the rate × real
        stakes less what was paid back, and while the fund is above zero new cricket polls open with a lower spread.
      </p>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-slate-500 text-xs">
          <th className="py-1.5">Board</th><th>Profile</th><th>On</th><th>Rate %</th>
          <th className="text-right">Fund</th><th className="text-right">Rounds helped</th><th className="text-right">Returned</th><th />
        </tr></thead>
        <tbody>
          {funds.map((f) => (
            <tr key={`${f.gameKey}:${f.audience}`} className="border-t border-[#1e2736]">
              <td className="py-1.5">{f.gameName ?? f.gameKey}</td>
              <td>{f.audience === 'VIP' ? 'VIP' : 'General'}</td>
              <td><input type="checkbox" aria-label={`RTP on for ${f.gameKey} ${f.audience}`} checked={f.enabled}
                onChange={(e) => edit(f, { enabled: e.target.checked })} /></td>
              <td><input className={inp} type="number" min={0} max={100} step={0.01} aria-label={`RTP rate for ${f.gameKey} ${f.audience}`}
                value={f.ratePercent} onChange={(e) => edit(f, { ratePercent: Number(e.target.value) })} /></td>
              <td className={`text-right ${f.balancePaise < 0 ? 'text-red-400' : ''}`}>{rupees(f.balancePaise)}</td>
              <td className="text-right">{f.roundsHelped}</td>
              <td className="text-right">{rupees(f.returnedPaise)}</td>
              <td className="text-right whitespace-nowrap">
                <button onClick={() => save(f)} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-yellow-500 text-black text-xs font-bold"><Save size={12} /> Save</button>
                <button onClick={() => showEntries(f)} className="ml-2 px-2 py-1 rounded border border-[#1e2736] text-xs">Rounds</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-gray-300">Fund entries: {open.key}</p>
            <button onClick={() => downloadCsv(`rtp-${open.key.replace(':', '-')}.csv`, open.entries)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[#1e2736] text-xs"><Download size={12} /> CSV</button>
          </div>
          {open.entries.length === 0 ? <p className="text-xs text-slate-500">No rounds counted yet.</p> : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-slate-500">
                <th className="py-1">Round</th><th className="text-right">Pool</th><th className="text-right">Paid back</th>
                <th className="text-right">Change</th><th className="text-right">Fund after</th><th className="text-right">House bet</th>
              </tr></thead>
              <tbody>{open.entries.map((e) => (
                <tr key={e.id} className="border-t border-[#1e2736]">
                  <td className="py-1">{e.cycleId}</td><td className="text-right">{rupees(e.poolPaise)}</td>
                  <td className="text-right">{rupees(e.paidBackPaise)}</td><td className="text-right">{rupees(e.deltaPaise)}</td>
                  <td className="text-right">{rupees(e.balanceAfterPaise)}</td>
                  <td className="text-right">{e.houseBetPaise ? rupees(e.houseBetPaise) : '—'}</td>
                </tr>))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
};

export default RtpFunds;
