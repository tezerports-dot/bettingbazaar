// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * CricketManager.tsx — Admin › Cricket (owner, 2026-10-18;
 * docs/reference/CRICKET_OPINION_DESIGN.md). The switch and the numbers
 * (`SystemConfig.cricket`, saved through /api/admin/system/config, explained
 * by the server's `help`), the data feed's token and health, the fixtures to
 * publish one by one or a series at once, the published matches in order,
 * each match's polls with their book, settle and void, and the report.
 *
 * Server: backend/domains/cricket/cricket.admin.routes.js. Every figure is the
 * server's; the screen adds nothing up but the report totals the server sends.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Download, RefreshCw, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { cricket as api, system } from '../../services/api';
import { SettingHelp, SettingHelpProvider, type SettingHelpMap } from '../../components/SettingHelp';

interface Team { id: string; name: string; code: string | null; logo: string | null }
interface Match {
  matchId: string; seriesId: string | null; seriesName: string | null; format: string; teamA: Team; teamB: Team;
  venue: string | null; startsAt: string; status: string; published: boolean; displayOrder: number | null;
  stakesPaise?: number; betCount?: number; result: string | null;
}
interface Feed { tokenSet: boolean; setAt: string | null; lastOkAt: string | null; lastError: string | null; lastErrorAt: string | null }
interface Follow { seriesId: string; seriesName: string }
interface BookLine { key: string; label: string; realPoolPaise: number; liabilityPaise: number; ifWinsPaise: number }
interface AdminPoll {
  pollId: string; kind: string; title: string; status: string; winningOption: string | null; voidReason: string | null;
  spreadBp: number; seedPaise: number; stakesPaise: number; claimsPaidPaise: number; wonPaidPaise: number;
  feesPaise: number; maxLossPaise: number; book: BookLine[];
  options: { key: string; label: string; oddsX100: number }[];
}
interface ReportRow {
  pollId: string; match: string; title: string; kind: string; status: string; winningOption: string | null;
  settledAt: string; bets: number; stakesPaise: number; claimsPaidPaise: number; wonPaidPaise: number;
  feesPaise: number; houseNetPaise: number;
}
interface Settings {
  enabled: boolean; spreadPercent: number; claimMarginPercent: number; rtpBoostPoints: number;
  inPlayDelaySec: number; nextBallWindowSec: number; tossCloseMinutes: number; momVoidHours: number;
  minStakeRupees: number; maxStakeRupees: number;
  seedRupees: { matchResult: number; toss: number; manOfMatch: number; over: number; ball: number };
}

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const day = (d: Date) => d.toISOString().slice(0, 10);

const NUMBER_FIELDS: Array<[keyof Omit<Settings, 'enabled' | 'seedRupees'>, string]> = [
  ['spreadPercent', 'Spread %'],
  ['claimMarginPercent', 'Claim margin %'],
  ['rtpBoostPoints', 'Spread cut while the RTP fund is above zero (points)'],
  ['inPlayDelaySec', 'In-play delay (seconds)'],
  ['nextBallWindowSec', 'Next-ball window (seconds)'],
  ['tossCloseMinutes', 'Toss poll closes before the start (minutes)'],
  ['momVoidHours', 'Man of the match void after (hours)'],
  ['minStakeRupees', 'Minimum stake (tokens)'],
  ['maxStakeRupees', 'Maximum stake (tokens)'],
];
const SEED_FIELDS: Array<[keyof Settings['seedRupees'], string]> = [
  ['matchResult', 'Match result'], ['toss', 'Toss'], ['manOfMatch', 'Man of the match'], ['over', 'Over'], ['ball', 'Next ball'],
];

const SettingsCard: React.FC = () => {
  const [form, setForm] = useState<Settings | null>(null);
  const [help, setHelp] = useState<SettingHelpMap>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res: any = await system.getConfig();
        if (res?.success && res.data?.cricket) { setForm(res.data.cricket); setHelp(res.help ?? {}); }
        else setError(res?.message || 'Could not load the cricket settings');
      } catch (e: any) { setError(e?.message || 'Could not load the cricket settings'); }
    })();
  }, []);

  const save = async () => {
    if (!form) return;
    setSaving(true); setError('');
    try {
      const res: any = await system.updateConfig({ cricket: form });
      if (!res?.success) throw new Error(res?.message || 'Save failed');
      toast.success(form.enabled ? 'Saved. Cricket is on for players.' : 'Saved. Cricket is off for players.');
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  if (!form) return <div className="card p-5 text-sm text-gray-400">{error || 'Loading…'}</div>;
  return (
    <SettingHelpProvider help={help}>
      <div className="card p-5 space-y-4">
        <div className="flex items-start gap-3">
          <input id="cricket-enabled" type="checkbox" className="mt-1" checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          <div>
            <label htmlFor="cricket-enabled" className="label mb-0 cursor-pointer">Cricket is on (players see the Cricket tab)</label>
            <SettingHelp path="cricket.enabled" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {NUMBER_FIELDS.map(([k, label]) => (
            <div key={k}>
              <label className="label" htmlFor={`cricket-${k}`}>{label}</label>
              <input id={`cricket-${k}`} type="number" className="input" value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} />
              <SettingHelp path={`cricket.${k}`} />
            </div>
          ))}
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-1">House seed per option (tokens)</h3>
          <p className="text-xs text-gray-500 mb-2">The most the house can lose on one poll is the seed times its options.</p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {SEED_FIELDS.map(([k, label]) => (
              <div key={k}>
                <label className="label" htmlFor={`cricket-seed-${k}`}>{label}</label>
                <input id={`cricket-seed-${k}`} type="number" className="input" value={form.seedRupees[k]}
                  onChange={(e) => setForm({ ...form, seedRupees: { ...form.seedRupees, [k]: Number(e.target.value) } })} />
                <SettingHelp path={`cricket.seedRupees.${k}`} />
              </div>
            ))}
          </div>
        </div>
        {error && <div role="alert" className="text-sm text-red-400">{error}</div>}
        <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={save} disabled={saving}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </SettingHelpProvider>
  );
};

const FeedCard: React.FC<{ feed: Feed | null; onChange: () => void }> = ({ feed, onChange }) => {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const saveToken = async () => {
    setBusy(true);
    try { await api.saveToken(token.trim()); setToken(''); toast.success(token.trim() ? 'Token saved' : 'Token cleared'); onChange(); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Could not save the token'); }
    finally { setBusy(false); }
  };
  const sync = async () => {
    setBusy(true);
    try { const r = await api.sync(); toast.success(`${r.fixtures} fixtures read, ${r.added} new`); onChange(); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'The feed did not answer'); }
    finally { setBusy(false); }
  };
  return (
    <div className="card p-5 space-y-3">
      <h3 className="text-base font-semibold">Cricket data feed (Sportmonks)</h3>
      <p className="text-xs text-gray-500">
        Only this server calls the feed; players read our API. Live matches are read every 4 seconds and the fixture list every 10 minutes.
      </p>
      <div className="text-sm">
        Token: {feed?.tokenSet ? <span className="text-green-400">saved {when(feed.setAt)}</span> : <span className="text-red-400">not set</span>}
        {' · '}Last good read: {when(feed?.lastOkAt ?? null)}
        {feed?.lastError && <div role="status" className="text-xs text-red-400 mt-1">Last error {when(feed.lastErrorAt)}: {feed.lastError}</div>}
      </div>
      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[16rem]">
          <label className="label" htmlFor="cricket-token">API token (paste to replace; save empty to clear)</label>
          <input id="cricket-token" type="password" autoComplete="off" className="input" value={token} onChange={(e) => setToken(e.target.value)} />
        </div>
        <button type="button" className="btn-primary" onClick={saveToken} disabled={busy}>Save token</button>
        <button type="button" className="btn-secondary inline-flex items-center gap-1" onClick={sync} disabled={busy || !feed?.tokenSet}>
          <RefreshCw size={14} /> Read fixtures now
        </button>
      </div>
    </div>
  );
};

const PollsPanel: React.FC<{ match: Match; onClose: () => void }> = ({ match, onClose }) => {
  const [polls, setPolls] = useState<AdminPoll[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try { setPolls((await api.polls(match.matchId)).polls ?? []); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Could not load the polls'); }
  }, [match.matchId]);
  useEffect(() => { void load(); }, [load]);

  const settle = async (p: AdminPoll) => {
    const option = choice[p.pollId];
    if (!option) { toast.error('Pick the winning option first'); return; }
    try { await api.settle(p.pollId, option); toast.success(`${p.title} settled`); void load(); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Could not settle'); }
  };
  const voidIt = async (p: AdminPoll) => {
    const reason = (reasons[p.pollId] ?? '').trim();
    if (!reason) { toast.error('Say why the poll is void; players see it'); return; }
    try { await api.voidPoll(p.pollId, reason); toast.success(`${p.title} voided; stakes returned`); void load(); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Could not void'); }
  };

  return (
    <div className="card p-5 space-y-3">
      <div className="flex justify-between items-center">
        <h3 className="text-base font-semibold">{match.teamA.name} v {match.teamB.name}: polls and book</h3>
        <button type="button" className="btn-secondary text-xs" onClick={onClose}>Close</button>
      </div>
      <p className="text-xs text-gray-500">
        "If it wins" is what the house keeps (or loses, in red) if that option wins: real stakes less claims paid less what its
        backers are owed. It never goes below minus the poll's seed.
      </p>
      {polls.length === 0 && <p className="text-sm text-gray-500">No polls yet.</p>}
      {polls.map((p) => (
        <div key={p.pollId} className="border border-dark-700 rounded-lg p-3">
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <span className="font-semibold">{p.title} <span className="text-xs text-gray-500">({p.status}{p.winningOption ? `: ${p.winningOption}` : ''}{p.voidReason ? `: ${p.voidReason}` : ''})</span></span>
            <span className="text-xs text-gray-400">
              Staked {rupees(p.stakesPaise)} · claims {rupees(p.claimsPaidPaise)} · wins {rupees(p.wonPaidPaise)} · fees {rupees(p.feesPaise)} · spread {p.spreadBp / 100}% · max loss {rupees(p.maxLossPaise)}
            </span>
          </div>
          <table className="w-full text-xs mt-2">
            <thead><tr className="text-left text-gray-500"><th className="py-1">Option</th><th className="text-right">Odds</th><th className="text-right">Real money</th><th className="text-right">Owed if it wins</th><th className="text-right">House if it wins</th></tr></thead>
            <tbody>{p.book.map((b) => (
              <tr key={b.key} className="border-t border-dark-700">
                <td className="py-1">
                  {['OPEN', 'CLOSED'].includes(p.status) && (
                    <input type="radio" name={`win-${p.pollId}`} aria-label={`${b.label} won`} className="mr-2"
                      checked={choice[p.pollId] === b.key} onChange={() => setChoice({ ...choice, [p.pollId]: b.key })} />
                  )}
                  {b.label}
                </td>
                <td className="text-right">{((p.options.find((o) => o.key === b.key)?.oddsX100 ?? 0) / 100).toFixed(2)}</td>
                <td className="text-right">{rupees(b.realPoolPaise)}</td>
                <td className="text-right">{rupees(b.liabilityPaise)}</td>
                <td className={`text-right ${b.ifWinsPaise < 0 ? 'text-red-400' : 'text-green-400'}`}>{rupees(b.ifWinsPaise)}</td>
              </tr>
            ))}</tbody>
          </table>
          {['OPEN', 'CLOSED'].includes(p.status) && (
            <div className="flex flex-wrap gap-2 mt-2 items-center">
              <button type="button" className="btn-primary text-xs" onClick={() => settle(p)}>Settle on the picked option</button>
              <input aria-label={`Why ${p.title} is void`} placeholder="Why it is void (players see this)" className="input text-xs flex-1 min-w-[12rem]"
                value={reasons[p.pollId] ?? ''} onChange={(e) => setReasons({ ...reasons, [p.pollId]: e.target.value })} />
              <button type="button" className="btn-secondary text-xs" onClick={() => voidIt(p)}>Void (return stakes)</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

const ReportCard: React.FC = () => {
  const [from, setFrom] = useState(day(new Date(Date.now() - 7 * 86400_000)));
  const [to, setTo] = useState(day(new Date(Date.now() + 86400_000)));
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [totals, setTotals] = useState<Record<string, number> | null>(null);
  const load = async () => {
    try { const r = await api.report(from, to); setRows(r.polls ?? []); setTotals(r.totals ?? null); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Could not build the report'); }
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="card p-5 space-y-3">
      <h3 className="text-base font-semibold">Report: what the house kept per poll</h3>
      <div className="flex flex-wrap gap-2 items-end">
        <div><label className="label" htmlFor="crk-from">From</label><input id="crk-from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="label" htmlFor="crk-to">To</label><input id="crk-to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <button type="button" className="btn-primary" onClick={load}>Show</button>
        <button type="button" className="btn-secondary inline-flex items-center gap-1" onClick={() => api.reportCsv(from, to).catch(() => toast.error('Could not export'))}>
          <Download size={14} /> CSV
        </button>
      </div>
      {totals && (
        <p className="text-sm">
          Staked {rupees(totals.stakesPaise)} · claims {rupees(totals.claimsPaidPaise)} · wins {rupees(totals.wonPaidPaise)} · fees {rupees(totals.feesPaise)} ·{' '}
          <b className={totals.houseNetPaise < 0 ? 'text-red-400' : 'text-green-400'}>house kept {rupees(totals.houseNetPaise)}</b>
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th className="py-1">Ended</th><th>Match</th><th>Poll</th><th>Result</th><th className="text-right">Bets</th><th className="text-right">Staked</th><th className="text-right">Paid</th><th className="text-right">House</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.pollId} className="border-t border-dark-700">
              <td className="py-1">{when(r.settledAt)}</td><td>{r.match}</td><td>{r.title}</td>
              <td>{r.status === 'VOID' ? 'Void' : r.winningOption}</td><td className="text-right">{r.bets}</td>
              <td className="text-right">{rupees(r.stakesPaise)}</td><td className="text-right">{rupees(r.claimsPaidPaise + r.wonPaidPaise)}</td>
              <td className={`text-right ${r.houseNetPaise < 0 ? 'text-red-400' : ''}`}>{rupees(r.houseNetPaise)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
};

export const CricketManager: React.FC = () => {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [follows, setFollows] = useState<Follow[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [open, setOpen] = useState<Match | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.overview();
      setFeed(r.feed ?? null); setFollows(r.follows ?? []); setMatches(r.matches ?? []);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Could not load cricket'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const published = useMemo(() => matches.filter((m) => m.published), [matches]);
  const upcoming = useMemo(() => matches.filter((m) => !m.published), [matches]);
  const followed = useMemo(() => new Set(follows.map((f) => f.seriesId)), [follows]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast.success(ok); await load(); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'That did not work'); }
  };
  const move = (i: number, by: -1 | 1) => {
    const ids = published.map((m) => m.matchId);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void act(() => api.setOrder(ids), 'Order saved');
  };

  const row = (m: Match) => (
    <div className="flex items-center gap-2 min-w-0">
      {m.teamA.logo && <img src={m.teamA.logo} alt="" className="w-6 h-6 object-contain" />}
      <span className="font-semibold truncate">{m.teamA.name} v {m.teamB.name}</span>
      {m.teamB.logo && <img src={m.teamB.logo} alt="" className="w-6 h-6 object-contain" />}
      <span className="text-xs text-gray-500 truncate">{m.format} · {m.seriesName ?? 'No series'} · {when(m.startsAt)} · {m.status}</span>
    </div>
  );

  return (
    <div className="space-y-6">
      <SettingsCard />
      <FeedCard feed={feed} onChange={load} />

      <div className="card p-5 space-y-2">
        <h3 className="text-base font-semibold">Shown to players, top to bottom</h3>
        <p className="text-xs text-gray-500">Matches you have not ordered follow by start time.</p>
        {published.length === 0 && <p className="text-sm text-gray-500">No match is published yet.</p>}
        {published.map((m, i) => (
          <div key={m.matchId} className="flex flex-wrap items-center justify-between gap-2 border-t border-dark-700 pt-2">
            {row(m)}
            <div className="flex items-center gap-1 text-xs">
              <span className="text-gray-400 mr-2">{m.betCount ?? 0} bets · {rupees(m.stakesPaise ?? 0)}</span>
              <button type="button" aria-label="Move up" className="btn-secondary p-1" onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
              <button type="button" aria-label="Move down" className="btn-secondary p-1" onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
              <button type="button" className="btn-secondary" onClick={() => setOpen(m)}>Polls</button>
              <button type="button" className="btn-secondary" onClick={() => act(() => api.unpublish(m.matchId), 'Taken off the players\' list')}>Unpublish</button>
            </div>
          </div>
        ))}
      </div>

      {open && <PollsPanel match={open} onClose={() => setOpen(null)} />}

      <div className="card p-5 space-y-2">
        <h3 className="text-base font-semibold">Fixtures from the feed</h3>
        <p className="text-xs text-gray-500">
          Publish a match on its own, or follow its series: every match of a followed series is published now and as it is listed.
        </p>
        {follows.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs">
            {follows.map((f) => (
              <span key={f.seriesId} className="px-2 py-1 rounded border border-dark-700">
                Following {f.seriesName}{' '}
                <button type="button" className="text-red-400 ml-1" onClick={() => act(() => api.unfollow(f.seriesId), `Stopped following ${f.seriesName}`)}>stop</button>
              </span>
            ))}
          </div>
        )}
        {upcoming.length === 0 && <p className="text-sm text-gray-500">No unpublished fixtures. Save the token and read the fixtures.</p>}
        {upcoming.map((m) => (
          <div key={m.matchId} className="flex flex-wrap items-center justify-between gap-2 border-t border-dark-700 pt-2">
            {row(m)}
            <div className="flex gap-1 text-xs">
              <button type="button" className="btn-primary" onClick={() => act(() => api.publish(m.matchId), 'Published')}>Publish</button>
              {m.seriesId && !followed.has(m.seriesId) && (
                <button type="button" className="btn-secondary"
                  onClick={() => act(() => api.follow(m.seriesId as string, m.seriesName ?? m.seriesId as string), 'Series followed')}>
                  Publish the whole series
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <ReportCard />
    </div>
  );
};

export default CricketManager;
