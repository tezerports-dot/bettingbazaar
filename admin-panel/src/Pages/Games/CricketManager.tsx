// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * CricketManager.tsx — Admin › Cricket (owner, 2026-10-18; tabs, providers,
 * poll switches and the Matches list 2026-10-19;
 * docs/reference/CRICKET_OPINION_DESIGN.md). In tabs: Matches (every fixture
 * the active provider lists, searched and filtered, grouped by series, to
 * publish one by one or a series at once; the published ones in order, each
 * with its polls and book, settle — several options for a dead heat — and
 * void), Polls & settings (`SystemConfig.cricket`: the switch, which poll
 * kinds open and their seeds, the numbers; saved through
 * /api/admin/system/config, explained by the server's `help`), Data feed (each
 * provider's token and health, and which one lists the fixtures) and Report.
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
interface FeedRow { provider: string; active: boolean; tokenSet: boolean; setAt: string | null; lastOkAt: string | null; lastError: string | null; lastErrorAt: string | null }
interface Feed extends FeedRow { providers: FeedRow[]; anyTokenSet: boolean }
interface FeedProvider { key: string; label: string }
interface Follow { seriesId: string; seriesName: string }
interface BookLine { key: string; label: string; realPoolPaise: number; liabilityPaise: number; ifWinsPaise: number }
interface AdminPoll {
  pollId: string; kind: string; title: string; status: string; winningOptions: string[] | null; voidReason: string | null;
  spreadBp: number; seedPaise: number; stakesPaise: number; claimsPaidPaise: number; wonPaidPaise: number;
  feesPaise: number; maxLossPaise: number; book: BookLine[];
  options: { key: string; label: string; oddsX100: number }[];
}
interface ReportRow {
  pollId: string; match: string; title: string; kind: string; status: string; winningOptions: string[] | null; winnerLabel: string | null;
  settledAt: string; bets: number; stakesPaise: number; claimsPaidPaise: number; wonPaidPaise: number;
  feesPaise: number; houseNetPaise: number;
}
interface Settings {
  enabled: boolean; comingSoon: boolean; claimHoldSec: number; spreadPercent: number; rtpBoostPoints: number;
  inPlayDelaySec: number; nextBallWindowSec: number; tossCloseMinutes: number;
  minStakeRupees: number; maxStakeRupees: number;
  seedRupees: Record<PollKey, number>;
  polls: Record<PollKey, boolean>;
}
// The poll kinds' setting keys (backend/domains/cricket/cricketPolls.js SEED_KEY; §5 mirror for labels only).
type PollKey = 'toss' | 'matchResult' | 'topBatsman' | 'topBowler' | 'mostSixes' | 'powerplay' | 'over' | 'ball';

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const day = (d: Date) => d.toISOString().slice(0, 10);

const NUMBER_FIELDS: Array<[keyof Omit<Settings, 'enabled' | 'comingSoon' | 'seedRupees' | 'polls'>, string]> = [
  ['spreadPercent', 'Spread %'],
  ['rtpBoostPoints', 'Spread cut while the RTP fund is above zero (points)'],
  ['inPlayDelaySec', 'In-play delay (seconds)'],
  ['claimHoldSec', 'A new bet can be claimed after (seconds)'],
  ['nextBallWindowSec', 'Next-ball window (seconds)'],
  ['tossCloseMinutes', 'Toss poll closes before the start (minutes)'],
  ['minStakeRupees', 'Minimum stake (tokens)'],
  ['maxStakeRupees', 'Maximum stake (tokens)'],
];
// Each poll kind: its name, when it runs and what players pick from (UI text only, §11).
const POLL_KINDS: Array<{ key: PollKey; label: string; runs: string }> = [
  { key: 'toss', label: 'Toss', runs: 'From publication to the toss · who wins it and their choice' },
  { key: 'matchResult', label: 'Match result', runs: 'From publication to the result · team A, draw (a tie included), team B' },
  { key: 'topBatsman', label: 'Best batsman', runs: 'From the team news to the result · most runs; level players share the win' },
  { key: 'topBowler', label: 'Best bowler', runs: 'From the team news to the result · most wickets; level players share the win' },
  { key: 'mostSixes', label: 'More sixes', runs: 'From the team news to the result · team A, level, team B' },
  { key: 'powerplay', label: 'Powerplay runs', runs: 'Each innings, until its first ball · runs in ranges (T20, ODI, T10)' },
  { key: 'over', label: 'Next over', runs: 'Each over, during the over before · odd, even or zero runs' },
  { key: 'ball', label: 'Next ball', runs: 'After every ball, for the next-ball window · 0 to 5, 6+, wide, no ball, wicket' },
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
        {!form.enabled && (
          <div className="flex items-start gap-3">
            <input id="cricket-coming-soon" type="checkbox" className="mt-1" checked={form.comingSoon}
              onChange={(e) => setForm({ ...form, comingSoon: e.target.checked })} />
            <div>
              <label htmlFor="cricket-coming-soon" className="label mb-0 cursor-pointer">While off, show the tab as coming soon (image on Admin › Images)</label>
              <SettingHelp path="cricket.comingSoon" />
            </div>
          </div>
        )}
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
          <h3 className="text-sm font-semibold mb-1">Which polls run, and the house seed on each</h3>
          <p className="text-xs text-gray-500 mb-2">
            A poll switched off is not opened for new matches or overs; polls already open run to their end. The seed is per
            option, in tokens: the most the house can lose on one poll is the seed times its options.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-gray-500"><th className="py-1">On</th><th>Poll</th><th>When it runs · what players pick</th><th className="w-36">Seed per option</th></tr></thead>
              <tbody>{POLL_KINDS.map((k) => (
                <tr key={k.key} className="border-t border-dark-700 align-top">
                  <td className="py-2 pr-2">
                    <input id={`cricket-poll-${k.key}`} type="checkbox" checked={form.polls?.[k.key] !== false}
                      onChange={(e) => setForm({ ...form, polls: { ...form.polls, [k.key]: e.target.checked } })} />
                  </td>
                  <td className="py-2 pr-2 font-semibold"><label htmlFor={`cricket-poll-${k.key}`} className="cursor-pointer">{k.label}</label></td>
                  <td className="py-2 pr-2 text-xs text-gray-400">{k.runs}<SettingHelp path={`cricket.polls.${k.key}`} /></td>
                  <td className="py-2">
                    <input aria-label={`${k.label} seed per option`} type="number" className="input" value={form.seedRupees[k.key]}
                      onChange={(e) => setForm({ ...form, seedRupees: { ...form.seedRupees, [k.key]: Number(e.target.value) } })} />
                    <SettingHelp path={`cricket.seedRupees.${k.key}`} />
                  </td>
                </tr>
              ))}</tbody>
            </table>
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

const FeedCard: React.FC<{ feed: Feed | null; providers: FeedProvider[]; onChange: () => void }> = ({ feed, providers, onChange }) => {
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  const saveToken = (provider: string) => run(async () => {
    const token = (tokens[provider] ?? '').trim();
    try { await api.saveToken(provider, token); setTokens({ ...tokens, [provider]: '' }); toast.success(token ? 'Token saved' : 'Token cleared'); onChange(); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Could not save the token'); }
  });
  const use = (provider: string) => run(async () => {
    try { await api.setProvider(provider); toast.success('The fixture list now comes from this provider'); onChange(); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Could not switch the provider'); }
  });
  const rowOf = (key: string) => feed?.providers.find((p) => p.provider === key);
  return (
    <div className="card p-5 space-y-4">
      <div>
        <h3 className="text-base font-semibold">Cricket data providers</h3>
        <p className="text-xs text-gray-500">
          Only this server calls a provider; players read our API. Save the token of the provider you subscribe to and press
          "Use for the fixture list". The list is read every 10 minutes and a match under way every 4 seconds, always from the
          provider it came from, so switching never stops a match being played.
        </p>
      </div>
      {providers.map((p) => {
        const r = rowOf(p.key);
        return (
          <div key={p.key} className={`border rounded-lg p-3 space-y-2 ${r?.active ? 'border-green-600' : 'border-dark-700'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{p.label} {r?.active && <span className="text-xs text-green-400 ml-1">· lists the fixtures</span>}</span>
              {!r?.active && (
                <button type="button" className="btn-secondary text-xs" disabled={busy || !r?.tokenSet} onClick={() => use(p.key)}>
                  Use for the fixture list
                </button>
              )}
            </div>
            <div className="text-xs">
              Token: {r?.tokenSet ? <span className="text-green-400">saved {when(r.setAt)}</span> : <span className="text-red-400">not set</span>}
              {' · '}Last good read: {when(r?.lastOkAt ?? null)}
              {r?.lastError && <div role="status" className="text-red-400 mt-1">Last error {when(r.lastErrorAt)}: {r.lastError}</div>}
            </div>
            <div className="flex flex-wrap gap-2 items-end">
              <div className="flex-1 min-w-[16rem]">
                <label className="label" htmlFor={`cricket-token-${p.key}`}>{p.label} API token (paste to replace; save empty to clear)</label>
                <input id={`cricket-token-${p.key}`} type="password" autoComplete="off" className="input" value={tokens[p.key] ?? ''}
                  onChange={(e) => setTokens({ ...tokens, [p.key]: e.target.value })} />
              </div>
              <button type="button" className="btn-primary" onClick={() => saveToken(p.key)} disabled={busy}>Save token</button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

const PollsPanel: React.FC<{ match: Match; onClose: () => void }> = ({ match, onClose }) => {
  const [polls, setPolls] = useState<AdminPoll[]>([]);
  const [choice, setChoice] = useState<Record<string, string[]>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try { setPolls((await api.polls(match.matchId)).polls ?? []); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Could not load the polls'); }
  }, [match.matchId]);
  useEffect(() => { void load(); }, [load]);

  const toggle = (pollId: string, key: string) => {
    const now = choice[pollId] ?? [];
    setChoice({ ...choice, [pollId]: now.includes(key) ? now.filter((k) => k !== key) : [...now, key] });
  };
  const settle = async (p: AdminPoll) => {
    const options = choice[p.pollId] ?? [];
    if (!options.length) { toast.error('Tick the winning option first'); return; }
    try {
      await api.settle(p.pollId, options);
      toast.success(options.length > 1 ? `${p.title} settled as a dead heat of ${options.length}` : `${p.title} settled`);
      void load();
    }
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
        backers are owed. It never goes below minus the poll's seed. Tick two or more options to settle a dead heat: each
        winning bet is paid its odds on its stake divided by the number of winners.
      </p>
      {polls.length === 0 && <p className="text-sm text-gray-500">No polls yet.</p>}
      {polls.map((p) => (
        <div key={p.pollId} className="border border-dark-700 rounded-lg p-3">
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <span className="font-semibold">{p.title} <span className="text-xs text-gray-500">({p.status}{p.winningOptions?.length ? `: ${p.winningOptions.map((k) => p.options.find((o) => o.key === k)?.label ?? k).join(' / ')}${p.winningOptions.length > 1 ? ' (dead heat)' : ''}` : ''}{p.voidReason ? `: ${p.voidReason}` : ''})</span></span>
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
                    <input type="checkbox" aria-label={`${b.label} won`} className="mr-2"
                      checked={(choice[p.pollId] ?? []).includes(b.key)} onChange={() => toggle(p.pollId, b.key)} />
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
              <button type="button" className="btn-primary text-xs" onClick={() => settle(p)}>
                {(choice[p.pollId]?.length ?? 0) > 1 ? `Settle as a dead heat of ${choice[p.pollId].length}` : 'Settle on the ticked option'}
              </button>
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
              <td>{r.status === 'VOID' ? 'Void' : r.winnerLabel}</td><td className="text-right">{r.bets}</td>
              <td className="text-right">{rupees(r.stakesPaise)}</td><td className="text-right">{rupees(r.claimsPaidPaise + r.wonPaidPaise)}</td>
              <td className={`text-right ${r.houseNetPaise < 0 ? 'text-red-400' : ''}`}>{rupees(r.houseNetPaise)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
};

type Tab = 'matches' | 'settings' | 'feed' | 'report';
const TABS: Array<[Tab, string]> = [['matches', 'Matches'], ['settings', 'Polls & settings'], ['feed', 'Data feed'], ['report', 'Report']];
type When = 'all' | 'today' | '3d' | '7d';
const WHEN_LABEL: Record<When, string> = { all: 'Any date', today: 'Today', '3d': 'Next 3 days', '7d': 'Next 7 days' };
const WHEN_MS: Record<When, number> = { all: Infinity, today: 0, '3d': 3 * 86400_000, '7d': 7 * 86400_000 };

/** Whether a fixture starts within the chosen window (today: before local midnight). */
function startsWithin(m: Match, w: When): boolean {
  if (w === 'all') return true;
  const t = new Date(m.startsAt).getTime();
  if (w === 'today') { const end = new Date(); end.setHours(24, 0, 0, 0); return t < end.getTime(); }
  return t < Date.now() + WHEN_MS[w];
}

export const CricketManager: React.FC = () => {
  const [tab, setTab] = useState<Tab>('matches');
  const [feed, setFeed] = useState<Feed | null>(null);
  const [providers, setProviders] = useState<FeedProvider[]>([]);
  const [follows, setFollows] = useState<Follow[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [open, setOpen] = useState<Match | null>(null);
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState('ALL');
  const [within, setWithin] = useState<When>('all');
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.overview();
      setFeed(r.feed ?? null); setProviders(r.feedProviders ?? []); setFollows(r.follows ?? []); setMatches(r.matches ?? []);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Could not load cricket'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const published = useMemo(() => matches.filter((m) => m.published), [matches]);
  const followed = useMemo(() => new Set(follows.map((f) => f.seriesId)), [follows]);
  const formats = useMemo(() => [...new Set(matches.filter((m) => !m.published).map((m) => m.format))].sort(), [matches]);
  // The fixtures not yet published, filtered, grouped by series in start order.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = matches.filter((m) => !m.published
      && (format === 'ALL' || m.format === format)
      && startsWithin(m, within)
      && (!q || [m.teamA.name, m.teamB.name, m.teamA.code ?? '', m.teamB.code ?? '', m.seriesName ?? '', m.venue ?? ''].some((x) => x.toLowerCase().includes(q))));
    const by = new Map<string, { seriesId: string | null; seriesName: string; matches: Match[] }>();
    for (const m of list) {
      const k = m.seriesId ?? 'none';
      if (!by.has(k)) by.set(k, { seriesId: m.seriesId, seriesName: m.seriesName ?? 'No series', matches: [] });
      by.get(k)!.matches.push(m);
    }
    return [...by.values()];
  }, [matches, query, format, within]);
  const shown = groups.reduce((n, g) => n + g.matches.length, 0);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast.success(ok); await load(); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'That did not work'); }
  };
  const sync = async () => {
    setSyncing(true);
    try { const r = await api.sync(); toast.success(`${r.fixtures} fixtures read, ${r.added} new`); await load(); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'The feed did not answer'); }
    finally { setSyncing(false); }
  };
  const move = (i: number, by: -1 | 1) => {
    const ids = published.map((m) => m.matchId);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void act(() => api.setOrder(ids), 'Order saved');
  };
  const activeLabel = providers.find((p) => p.key === feed?.provider)?.label ?? feed?.provider ?? 'the provider';

  const row = (m: Match, withSeries = true) => (
    <div className="flex items-center gap-2 min-w-0">
      {m.teamA.logo && <img src={m.teamA.logo} alt="" className="w-6 h-6 object-contain" />}
      <span className="font-semibold truncate">{m.teamA.name} v {m.teamB.name}</span>
      {m.teamB.logo && <img src={m.teamB.logo} alt="" className="w-6 h-6 object-contain" />}
      <span className="text-xs text-gray-500 truncate">{m.format}{withSeries ? ` · ${m.seriesName ?? 'No series'}` : ''} · {when(m.startsAt)}{m.venue ? ` · ${m.venue}` : ''} · {m.status}</span>
    </div>
  );

  return (
    <div className="space-y-6">
      <nav aria-label="Cricket sections" className="flex flex-wrap gap-2">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" aria-current={tab === k ? 'page' : undefined}
            className={tab === k ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>

      {tab === 'settings' && <SettingsCard />}
      {tab === 'feed' && <FeedCard feed={feed} providers={providers} onChange={load} />}
      {tab === 'report' && <ReportCard />}

      {tab === 'matches' && (<>
        <div className="card p-5 space-y-2">
          <h3 className="text-base font-semibold">Shown to players, top to bottom</h3>
          <p className="text-xs text-gray-500">Each published match gets the polls switched on under Polls &amp; settings. Matches you have not ordered follow by start time.</p>
          {published.length === 0 && <p className="text-sm text-gray-500">No match is published yet. Pick one from the list below.</p>}
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

        <div className="card p-5 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold">All matches from {activeLabel}</h3>
              <p className="text-xs text-gray-500">
                Every fixture the provider lists for the next two weeks. Publish a match on its own, or a whole series: every match of
                a followed series is published now and as it is listed. Last read {when(feed?.lastOkAt ?? null)}.
              </p>
            </div>
            <button type="button" className="btn-secondary inline-flex items-center gap-1" onClick={sync} disabled={syncing || !feed?.tokenSet}>
              <RefreshCw size={14} /> {syncing ? 'Reading…' : 'Read fixtures now'}
            </button>
          </div>
          {!feed?.tokenSet && (
            <p role="status" className="text-sm text-amber-400">
              No token is saved for {activeLabel}, so there is no list yet. Save one under Data feed.{' '}
              <button type="button" className="underline" onClick={() => setTab('feed')}>Open Data feed</button>
            </p>
          )}
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex-1 min-w-[14rem]">
              <label className="label" htmlFor="crk-search">Search team, series or ground</label>
              <input id="crk-search" className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="India, IPL, Wankhede…" />
            </div>
            <div>
              <label className="label" htmlFor="crk-format">Format</label>
              <select id="crk-format" className="input" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="ALL">All formats</option>
                {formats.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="crk-when">Starts</label>
              <select id="crk-when" className="input" value={within} onChange={(e) => setWithin(e.target.value as When)}>
                {(Object.keys(WHEN_LABEL) as When[]).map((w) => <option key={w} value={w}>{WHEN_LABEL[w]}</option>)}
              </select>
            </div>
          </div>
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
          <p className="text-xs text-gray-500" role="status">{shown} {shown === 1 ? 'match' : 'matches'} in {groups.length} {groups.length === 1 ? 'series' : 'series'}</p>
          {feed?.tokenSet && shown === 0 && <p className="text-sm text-gray-500">No unpublished match fits. Clear the search or read the fixtures now.</p>}
          {groups.map((g) => (
            <div key={g.seriesId ?? 'none'} className="border border-dark-700 rounded-lg">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-dark-800 rounded-t-lg">
                <span className="font-semibold text-sm">{g.seriesName} <span className="text-xs text-gray-500">· {g.matches.length}</span></span>
                {g.seriesId && (followed.has(g.seriesId)
                  ? <span className="text-xs text-green-400">Following: new matches publish themselves</span>
                  : (
                    <button type="button" className="btn-secondary text-xs"
                      onClick={() => act(() => api.follow(g.seriesId as string, g.seriesName), `${g.seriesName}: every match published`)}>
                      Publish the whole series
                    </button>
                  ))}
              </div>
              {g.matches.map((m) => (
                <div key={m.matchId} className="flex flex-wrap items-center justify-between gap-2 border-t border-dark-700 px-3 py-2">
                  {row(m, false)}
                  <button type="button" className="btn-primary text-xs" onClick={() => act(() => api.publish(m.matchId), `${m.teamA.name} v ${m.teamB.name} published`)}>Publish</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </>)}
    </div>
  );
};

export default CricketManager;
