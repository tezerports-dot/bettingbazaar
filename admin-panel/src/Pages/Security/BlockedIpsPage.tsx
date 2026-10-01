// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * BlockedIpsPage — Admin › Blocked IPs.
 *
 * Block an address or a range; every request from it is refused before any
 * route runs (backend/middleware/ipBlocklist.js). Lift a block; the record is
 * kept, so an appeal can be answered from who blocked it and why.
 *
 * The server refuses the mistakes that lock out the wrong people — a range
 * wider than /16, loopback, and any range covering the address this screen is
 * being used from — and this page shows that address so an admin can see it
 * before choosing a range.
 */
import React, { useEffect, useState } from 'react';
import { RefreshCw, ShieldBan, ShieldCheck, History } from 'lucide-react';
import toast from 'react-hot-toast';
import { ipBlocks, type IpBlocksResponse, type IpBlock } from '../../services/api';
import { Toolbar } from '../../components/design';

const when = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');
const errMsg = (e: any, fallback: string) => e?.response?.data?.message || e?.message || fallback;

export const BlockedIpsPage: React.FC = () => {
  const [data, setData] = useState<IpBlocksResponse | null>(null);
  const [history, setHistory] = useState(false);
  const [network, setNetwork] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (withHistory = history) => {
    try { setData(await ipBlocks.list(withHistory)); } catch (e) { toast.error(errMsg(e, 'Failed to load blocked IPs')); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: { network: string; reason: string; expiresInMinutes?: number } = { network: network.trim(), reason: reason.trim() };
      if (minutes.trim()) body.expiresInMinutes = Number(minutes);
      const res = await ipBlocks.block(body);
      toast.success(`Blocked ${res.block.network}`);
      setNetwork(''); setReason(''); setMinutes('');
      await load();
    } catch (err) {
      toast.error(errMsg(err, 'Could not block that address'), { duration: 9000 });
    } finally { setBusy(false); }
  };

  const release = async (b: IpBlock) => {
    if (!confirm(`Lift the block on ${b.network}?\n\nRequests from it will be served again.`)) return;
    try {
      await ipBlocks.release(b.blockId);
      toast.success(`Lifted ${b.network}`);
      await load();
    } catch (err) { toast.error(errMsg(err, 'Could not lift that block')); }
  };

  const toggleHistory = async () => { const next = !history; setHistory(next); await load(next); };

  return (
    <div className="om-fade" style={{ maxWidth: 1040, margin: '0 auto' }}>
      <Toolbar actions={[
        { label: history ? 'Live blocks only' : 'Show history', icon: History, onClick: toggleHistory },
        { label: 'Refresh', icon: RefreshCw, onClick: () => load() },
      ]} />

      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 flex items-center gap-1.5"><ShieldBan size={13} /> Blocks in force</div>
          <div className="text-2xl font-black text-white mt-1">{data?.enforcer.blocks ?? '—'}</div>
          <div className="text-[11px] text-slate-500">Every server picks up a change within {data?.enforcer.refreshSeconds ?? 10} seconds</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 md:col-span-2">
          <div className="text-xs text-slate-500 flex items-center gap-1.5"><ShieldCheck size={13} /> You are connecting from</div>
          <div className="text-lg font-mono text-white mt-1 break-all">{data?.yourIp ?? '—'}</div>
          <div className="text-[11px] text-slate-500">A block covering this address is refused, so you cannot lock yourself out. If every request shows the same address here, the server's TRUST_PROXY setting is wrong and a block would hit everyone.</div>
        </div>
      </div>

      <form onSubmit={submit} className="mb-6 bg-slate-900 border border-slate-800 rounded-xl p-4 grid md:grid-cols-4 gap-3 items-end">
        <div>
          <label htmlFor="ipb-network" className="block text-xs text-slate-400 mb-1">Address or range</label>
          <input id="ipb-network" value={network} onChange={(e) => setNetwork(e.target.value)} required
            placeholder="203.0.113.7 or 203.0.113.0/24" className="input w-full font-mono text-sm" />
        </div>
        <div className="md:col-span-2">
          <label htmlFor="ipb-reason" className="block text-xs text-slate-400 mb-1">Reason (kept for appeals)</label>
          <input id="ipb-reason" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500}
            placeholder="e.g. credential stuffing against player logins" className="input w-full text-sm" />
        </div>
        <div>
          <label htmlFor="ipb-minutes" className="block text-xs text-slate-400 mb-1">Expires after (minutes, empty = until lifted)</label>
          <input id="ipb-minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="numeric"
            placeholder="e.g. 1440" className="input w-full text-sm" />
        </div>
        <div className="md:col-span-4 flex justify-end">
          <button type="submit" disabled={busy} className="btn btn-primary text-sm inline-flex items-center gap-1.5">
            <ShieldBan size={14} /> Block
          </button>
        </div>
      </form>

      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500 text-left">
            <tr>
              <th className="p-3">Range</th><th className="p-3">Reason</th><th className="p-3">Blocked</th>
              <th className="p-3">Expires</th><th className="p-3">Status</th><th className="p-3" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {data && data.blocks.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-500">{history ? 'No address has ever been blocked.' : 'Nothing is blocked.'}</td></tr>
            )}
            {data?.blocks.map((b) => (
              <tr key={b.blockId} className="border-t border-slate-800">
                <td className="p-3 font-mono text-white">{b.network}</td>
                <td className="p-3 text-slate-300">{b.reason}</td>
                <td className="p-3 text-slate-400">{when(b.blockedAt)}</td>
                <td className="p-3 text-slate-400">{b.expiresAt ? when(b.expiresAt) : 'Until lifted'}</td>
                <td className="p-3">{b.live ? 'Blocked' : b.releasedAt ? `Lifted ${when(b.releasedAt)}` : 'Expired'}</td>
                <td className="p-3 text-right">
                  {b.live && (
                    <button type="button" onClick={() => release(b)} className="btn btn-secondary text-xs" aria-label={`Lift the block on ${b.network}`}>
                      Lift block
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
