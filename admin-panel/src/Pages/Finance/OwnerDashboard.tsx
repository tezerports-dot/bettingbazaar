// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin › Owner Dashboard (owner, 2026-10-22): the token supply and who holds
 * it on top, then the platform's figures for today, any range or all time,
 * three separate ledgers (VIP revenue, merchants, General bonuses), and the
 * owner's weekly profit settlement.
 *
 * Every figure comes from the server (`/api/admin/owner/*`, read by
 * database/repositories/ownerLedger.js); this screen only lays them out. The
 * settlement is the owner's own money, so it is drawn for a full admin only,
 * as the server allows it to nobody else.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Crown, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { cleanParams } from '../../services/api';
import { usePermissions } from '../../hooks/usePermission';
import { formatters } from '../../utils/formatters';
import { TokenSupplyPanel } from './TokenSupplyPanel';

type Preset = 'today' | 'week' | 'month' | 'all' | 'custom';
const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom' },
];

/** Today's date in India, as the server reads a day (IST). */
const istToday = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function windowOf(p: Preset, from: string, to: string): { from?: string; to?: string } {
  const today = istToday();
  if (p === 'today') return { from: today, to: today };
  if (p === 'week') return { from: shiftDay(today, -6), to: today };
  if (p === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  if (p === 'custom') return { from: from || undefined, to: to || undefined };
  return {};
}

const rupees = (n: number | undefined) => formatters.currency(n ?? 0);
const count = (n: number | undefined) => (n ?? 0).toLocaleString('en-IN');
const when = (v: string | null | undefined) => (v
  ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
  : '—');

const Tile: React.FC<{ label: string; value: string; note?: string }> = ({ label, value, note }) => (
  <div className="bg-dark-800 rounded-xl p-3 border border-dark-700">
    <p className="text-xs text-gray-400">{label}</p>
    <p className="text-lg font-bold mt-1">{value}</p>
    {note && <p className="text-[11px] text-gray-500 mt-0.5">{note}</p>}
  </div>
);

const Line: React.FC<{ label: string; value: number; note?: string; cost?: boolean; strong?: boolean }> = ({ label, value, note, cost, strong }) => (
  <div className={`flex justify-between items-start gap-3 py-2 ${strong ? 'border-t border-dark-600 font-semibold' : ''}`}>
    <div><p className="text-sm">{label}</p>{note && <p className="text-[11px] text-gray-500">{note}</p>}</div>
    <p className={`text-sm whitespace-nowrap ${cost ? 'text-red-400' : value < 0 ? 'text-red-400' : 'text-green-400'}`}>
      {cost ? `− ${rupees(value)}` : rupees(value)}
    </p>
  </div>
);

const Section: React.FC<{ title: string; note?: string; children: React.ReactNode }> = ({ title, note, children }) => (
  <section className="card space-y-2">
    <div>
      <h2 className="text-lg font-semibold">{title}</h2>
      {note && <p className="text-xs text-gray-500 mt-0.5">{note}</p>}
    </div>
    {children}
  </section>
);

interface Dashboard {
  stats: any; vip: any; general: any;
  online: { now: number; peak: { players: number; at: string } | null; allTimePeak: { players: number; at: string } | null };
}

export const OwnerDashboard: React.FC = () => {
  const { isAdmin } = usePermissions();
  const [preset, setPreset] = useState<Preset>('today');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<Dashboard | null>(null);
  const [merchants, setMerchants] = useState<any | null>(null);
  const [topToday, setTopToday] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const w = cleanParams(windowOf(preset, from, to));
    const today = istToday();
    try {
      const [d, m, t] = await Promise.all([
        api.get<any>('/api/admin/owner/dashboard', { params: w }),
        api.get<any>('/api/admin/owner/merchant-ledger', { params: w }),
        api.get<any>('/api/admin/owner/merchant-ledger', { params: { from: today, to: today } }),
      ]);
      if (d?.data?.success) setData(d.data);
      if (m?.data?.success) setMerchants(m.data);
      if (t?.data?.success) setTopToday(t.data.top);
    } catch {
      toast.error('The dashboard failed to load');
    } finally {
      setLoading(false);
    }
  }, [preset, from, to]);

  useEffect(() => { load(); }, [load]);

  const s = data?.stats;
  const vip = data?.vip;
  const gen = data?.general;
  const on = data?.online;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Crown size={20} className="text-gold-400" />
        <h1 className="text-xl font-bold">Owner Dashboard</h1>
      </div>

      <TokenSupplyPanel />

      <div className="card flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Period">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" onClick={() => setPreset(p.key)} aria-pressed={preset === p.key}
              className={preset === p.key ? 'btn-primary text-sm' : 'btn-secondary text-sm'}>{p.label}</button>
          ))}
        </div>
        {preset === 'custom' && (
          <>
            <div>
              <label className="label text-xs" htmlFor="owner-from">From</label>
              <input id="owner-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input text-sm" />
            </div>
            <div>
              <label className="label text-xs" htmlFor="owner-to">To</label>
              <input id="owner-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input text-sm" />
            </div>
          </>
        )}
        <button type="button" onClick={load} disabled={loading} className="btn-secondary text-sm flex items-center gap-1.5 disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh
        </button>
      </div>

      {s && vip && gen && on && (
        <>
          <Section title="Platform" note="Counts for the period picked above. Days are India time.">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Tile label="Total buys" value={rupees(s.buys.tokens)} note={`${count(s.buys.count)} orders`} />
              <Tile label="Total sells" value={rupees(s.sells.tokens)} note={`${count(s.sells.count)} orders`} />
              <Tile label="Merchant commission" value={rupees(s.merchantCommission)} />
              <Tile label="Referral bonus given" value={rupees(s.referralBonusGiven)} />
              <Tile label="New players" value={count(s.newPlayers)} />
              <Tile label="Registered players" value={count(s.registeredPlayers)} />
              <Tile label="VIP players" value={count(s.vipPlayers)} note="all accounts on VIP now" />
              <Tile label="General players" value={count(s.generalPlayers)} note="all accounts on General now" />
              <Tile label="Active players (VIP)" value={count(s.activePlayers.vip)} note="placed a bet in the period" />
              <Tile label="Active players (General)" value={count(s.activePlayers.general)} note="placed a bet in the period" />
              <Tile label="First-time depositors" value={count(s.firstTimeDepositors)} />
              <Tile label="Weekly depositors" value={count(s.weeklyDepositors)} note="bought in the last 7 days" />
              <Tile label="Online now" value={count(on.now)} />
              <Tile label="Peak online (period)" value={count(on.peak?.players)} note={when(on.peak?.at)} />
              <Tile label="Peak online (ever)" value={count(on.allTimePeak?.players)} note={when(on.allTimePeak?.at)} />
              <Tile label="Net profit" value={rupees(vip.netProfit)} note={`revenue ${rupees(vip.revenue.total)} · costs ${rupees(vip.costs.total)}`} />
              <Tile label="Claimed General bonuses" value={rupees(gen.claimed)} />
            </div>
          </Section>

          <Section title="VIP revenue ledger"
            note="Real money only. Players pay no deposit fee; merchant commission and claimed General bonuses are costs.">
            <Line label="Cycle side difference" value={vip.revenue.cycleSides} note={`${count(vip.revenue.rounds)} VIP rounds settled: the real pool less what winners were paid`} />
            <Line label="Winning fees" value={vip.revenue.winningFees} />
            <Line label="Casino" value={vip.revenue.casino} />
            <Line label="Cricket" value={vip.revenue.cricket} />
            <Line label="Commission kept on USDT orders"
              value={vip.revenue.usdtCommissionKept}
              note={`USDT orders the platform served itself: ${vip.rates.depositPercent}% of buys + ${vip.rates.withdrawalPercent}% of sells, at today's rates`} />
            <Line label="Revenue" value={vip.revenue.total} strong />
            <Line label="Merchant commission" value={vip.costs.merchantCommission} cost />
            <Line label="General bonuses claimed" value={vip.costs.claimedGeneralBonuses} cost />
            <Line label="Net profit" value={vip.netProfit} strong />
            <Line label="Set aside for RTP in the period" value={vip.rtp.setAside}
              note={`RTP fund now ${rupees(vip.rtp.balanceNow)}: held back from what you can claim, because house bets pay it out again`} />
            <Line label="Withdrawn by the owner in the period" value={vip.ownerWithdrawn} cost />
          </Section>

          {merchants && (
            <Section title="Merchant ledger" note="Every agent team and merchant account: what it holds now and what it served in the period. Commission here is the cost line above.">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Tile label="Tokens held by merchants now" value={rupees(merchants.totals.tokensNow)} />
                <Tile label="Volume served" value={rupees(merchants.totals.volume)} note={`${count(merchants.totals.buys)} buys · ${count(merchants.totals.sells)} sells`} />
                <Tile label="Top contributor (period)" value={merchants.top?.name ?? '—'} note={merchants.top ? rupees(merchants.top.volume) : undefined} />
                <Tile label="Top today" value={topToday?.name ?? '—'} note={topToday ? rupees(topToday.volume) : undefined} />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-dark-600">
                      <th className="pb-2 font-medium">Merchant</th>
                      <th className="pb-2 font-medium text-right">Holds now</th>
                      <th className="pb-2 font-medium text-right">Buys</th>
                      <th className="pb-2 font-medium text-right">Sells</th>
                      <th className="pb-2 font-medium text-right">Commission paid</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-dark-700">
                    {merchants.merchants.length === 0 && (
                      <tr><td colSpan={5} className="py-4 text-center text-gray-500">No merchant activity in this period.</td></tr>
                    )}
                    {merchants.merchants.map((m: any) => (
                      <tr key={m.teamId}>
                        <td className="py-2">
                          <p className="font-medium">{m.name}</p>
                          <p className="text-[11px] text-gray-500">{m.kind === 'DIRECT' ? 'Merchant account' : `Agent team${m.owner ? ` · ${m.owner}` : ''}`}</p>
                        </td>
                        <td className="py-2 text-right">{rupees(m.tokensNow)}</td>
                        <td className="py-2 text-right">{rupees(m.buyTokens)}<p className="text-[11px] text-gray-500">{count(m.buys)}</p></td>
                        <td className="py-2 text-right">{rupees(m.sellTokens)}<p className="text-[11px] text-gray-500">{count(m.sells)}</p></td>
                        <td className="py-2 text-right text-red-400">{rupees(m.commission)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <Section title="General bonus ledger" note="Bonuses come out of the supply. Only the part a player claims (unlocks into withdrawable winnings) is a real cost.">
            <Line label="Referral bonuses granted" value={gen.granted.referral.amount} note={`${count(gen.granted.referral.count)} grants`} />
            <Line label="First-deposit bonuses granted" value={gen.granted.firstDeposit.amount} note={`${count(gen.granted.firstDeposit.count)} grants`} />
            <Line label="Granted in total" value={gen.granted.total} strong />
            <Line label="Won back by General play" value={gen.playWonBack.amount} note={`${count(gen.playWonBack.rounds)} General rounds settled`} />
            <Line label="Claimed (a real cost)" value={gen.claimed} cost />
            <Line label="Still in General wallets now" value={gen.outstandingNow}
              note={`${count(gen.openGrantsNow.count)} bonuses not yet played through (${rupees(gen.openGrantsNow.amount)})`} />
          </Section>
        </>
      )}

      {isAdmin && <WeeklySettlement onChange={load} />}
    </div>
  );
};

/** IST wall-clock `YYYY-MM-DDTHH:mm` from an instant, for the picker. */
const toIstInput = (v: string) => new Date(Date.parse(v) + 5.5 * 3_600_000).toISOString().slice(0, 16);

const WeeklySettlement: React.FC<{ onChange: () => void }> = ({ onChange }) => {
  const [data, setData] = useState<any | null>(null);
  const [weekStart, setWeekStart] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<any>('/api/admin/owner/settlements');
      if (r?.data?.success) {
        setData(r.data);
        if (r.data.schedule?.weekStartsAt) setWeekStart(toIstInput(r.data.schedule.weekStartsAt));
      }
    } catch {
      toast.error('Settlements failed to load');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveWeek = async () => {
    if (!weekStart) { toast.error('Pick the date and time your week starts'); return; }
    setBusy(true);
    try {
      await api.put('/api/admin/owner/settlements/week-start', { weekStartsAt: new Date(`${weekStart}:00+05:30`).toISOString() });
      toast.success('Week start saved');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Could not save the week start');
    } finally { setBusy(false); }
  };

  const record = async () => {
    setBusy(true);
    try {
      await api.post('/api/admin/owner/settlements', { amount: Number(amount), note: note.trim() || null });
      toast.success('Withdrawal recorded');
      setAmount(''); setNote('');
      await load();
      onChange();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Could not record it');
    } finally { setBusy(false); }
  };

  if (!data) return null;
  return (
    <Section title="Weekly profit settlement"
      note="Set when your week starts. Each finished week's VIP net profit becomes claimable. Recording a withdrawal moves no tokens: it is the record of cash you took out. Only full admins see this.">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label text-xs" htmlFor="owner-week-start">Week starts (India time)</label>
          <input id="owner-week-start" type="datetime-local" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} className="input text-sm" />
        </div>
        <button type="button" onClick={saveWeek} disabled={busy} className="btn-secondary text-sm disabled:opacity-50">Save week start</button>
      </div>

      {data.schedule && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="You can claim now" value={rupees(data.claimable)} />
            <Tile label="Profit of finished weeks" value={rupees(data.completedNetProfit)} />
            <Tile label="Already withdrawn" value={rupees(data.withdrawnTotal)} />
            <Tile label="Held back for RTP" value={rupees(data.rtpHeldBack)} />
          </div>
          {data.currentWeek && (
            <p className="text-xs text-gray-400">
              This week ({when(data.currentWeek.weekStart)} to {when(data.currentWeek.weekEnd)}) so far: {rupees(data.currentWeek.netProfit)}. It becomes claimable when the week ends.
            </p>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label text-xs" htmlFor="owner-amount">Amount taken out (₹)</label>
              <input id="owner-amount" type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="input text-sm" />
            </div>
            <div className="flex-1 min-w-[180px]">
              <label className="label text-xs" htmlFor="owner-note">Note</label>
              <input id="owner-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="input text-sm w-full" />
            </div>
            <button type="button" onClick={record} disabled={busy || !amount} className="btn-primary text-sm disabled:opacity-50">Record withdrawal</button>
          </div>
          <p className="text-[11px] text-gray-500">To correct a wrong record, enter a negative amount with a note saying why.</p>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-dark-600">
                  <th className="pb-2 font-medium">Week</th>
                  <th className="pb-2 font-medium text-right">Net profit</th>
                  <th className="pb-2 font-medium text-right">Withdrawn</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-700">
                {data.weeks.map((w: any) => (
                  <tr key={w.weekStart}>
                    <td className="py-2">{when(w.weekStart)}{w.complete ? '' : ' (running)'}</td>
                    <td className="py-2 text-right">{rupees(w.netProfit)}</td>
                    <td className="py-2 text-right">{rupees(w.withdrawn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="text-sm font-semibold pt-2">Withdrawals recorded</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-dark-600">
                  <th className="pb-2 font-medium">When</th>
                  <th className="pb-2 font-medium">For week</th>
                  <th className="pb-2 font-medium">Note</th>
                  <th className="pb-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-700">
                {data.settlements.length === 0 && (
                  <tr><td colSpan={4} className="py-4 text-center text-gray-500">Nothing withdrawn yet.</td></tr>
                )}
                {data.settlements.map((x: any) => (
                  <tr key={x.settlementId}>
                    <td className="py-2">{when(x.createdAt)}</td>
                    <td className="py-2">{when(x.weekStart)}</td>
                    <td className="py-2 text-gray-400">{x.note ?? '—'}</td>
                    <td className="py-2 text-right">{rupees(x.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
};
