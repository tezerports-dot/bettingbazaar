// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// TeamPage — supervisors and teams on the merchant panel (redesign Step 2a,
// PROJECT_STATUS §3.10).
//
// One screen, three readers, decided by the server (GET /api/merchant/team):
//   SUPERVISOR — up to 4 teams of exactly 10; create, rename, delete an empty
//                team, propose members by their merchant ID, remove members,
//                and buy tokens into each team's pool or sell them back
//                (Step 2b) — an admin fulfils once the money has moved.
//   MEMBER     — the team they are in, whether an admin has approved them yet,
//                whether the team is working, and its commission with their
//                own share of each payment (Step 2e).
//   Supervisors also see each team's commission and their 16% of it.
//   NONE       — not in a team; shows the ID to hand to a supervisor.
//
// Every cap is the server's. A refusal is shown as the server worded it,
// because it names what to do next (§32 S14).
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { RefreshCw, Users } from 'lucide-react';
import {
  getMyTeam, createTeam, renameTeam, deleteTeam, addTeamMember, removeTeamMember,
  getTeamPool, requestTeamPool, cancelTeamPoolRequest,
} from '../services/api';
import type {
  MyTeam, PoolDirection, Team, TeamCommission, TeamMember, TeamPoolEntry, TeamPoolRequest,
} from '../types';
import { Banner, Button, Card, CardTitle, CopyRow, ErrorState, Skeleton, inputStyle } from '../components/ui';

const STRENGTH: Record<Team['strength'], { label: string; tone: 'ok' | 'warn' | 'danger'; body: string }> = {
  WORKING: { label: 'Working', tone: 'ok', body: 'All 10 members are in. The team takes orders.' },
  GRACE:   { label: 'Short today', tone: 'warn', body: 'A member left today. The team keeps working until midnight IST, then stops until it has 10 again.' },
  STOPPED: { label: 'Not working', tone: 'danger', body: 'A team takes orders only with 10 approved members.' },
};

const errorText = (err: unknown, fallback: string) => (err as Error)?.message || fallback;

const StrengthTag: React.FC<{ team: Team }> = ({ team }) => {
  const s = STRENGTH[team.strength];
  return (
    <span style={{
      padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 800,
      color: `var(--${s.tone})`, background: `var(--${s.tone}-bg)`,
    }}>
      {s.label} · {team.approvedCount}/{team.size}
    </span>
  );
};

const tokens = (paise: number) => (paise / 100).toLocaleString('en-IN');

/** What each pool movement was, in the supervisor's words. Every kind `teamPools.js` writes. */
const POOL_KIND: Record<TeamPoolEntry['kind'], string> = {
  ADMIN_SALE: 'Bought from the platform',
  ADMIN_BUYBACK: 'Sold back to the platform',
  BUY_HOLD: 'Held for a buy order',
  BUY_RELEASE: 'Hold released',
  BUY_PAID: 'Paid to a player (buy)',
  SELL_SETTLED: 'Received from a player (sell)',
  SELL_REVERSED: 'Sell reversed',
  COMMISSION: 'Team commission',
};

/**
 * A team's commission (Step 2e): its matched volume, what has been paid into
 * the pool, anything earned and waiting, and the reader's own share of each
 * recent payment. Module level (§32 S23).
 */
const CommissionSection: React.FC<{ team: Team; commissions: TeamCommission[] }> = ({ team, commissions }) => {
  const c = team.commission;
  const mine = commissions.filter((x) => x.teamId === team.teamId);
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 800 }}>Commission</span>
        <span className="bb-mono" style={{ fontSize: 14, fontWeight: 800 }}>{tokens(c.paidPaise)} tokens paid</span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-2)', margin: '0 0 8px' }}>
        Matched volume {tokens(c.matchedPaise)} (completed buys {tokens(c.buysPaise)}, sells {tokens(c.sellsPaise)}).
        Each time it passes its highest so far, {c.commissionPercent}% of the rise is paid into the pool:
        {' '}{c.supervisorSharePercent}% is the supervisor&apos;s, {100 - c.supervisorSharePercent}% is shared equally by the members.
      </p>
      {c.owedPaise > 0 && (
        <Banner tone="warn" style={{ marginBottom: 8 }}>
          {tokens(c.owedPaise)} tokens earned and waiting for the platform&apos;s commission pool. They are paid automatically once it is topped up.
        </Banner>
      )}
      {mine.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {mine.map((x) => (
            <li key={x.commissionId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '4px 0' }}>
              <span>{new Date(x.createdAt).toLocaleString('en-IN')} · +{tokens(x.commissionPaise)} into the pool</span>
              <span className="bb-mono">your share {tokens(x.mySharePaise)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text-2)', marginBottom: 6 };

/**
 * A team's token pool: its balance, a request to buy or sell, the requests
 * still waiting, and the pool's history on demand. Module level (§32 S23).
 */
const TeamPoolSection: React.FC<{
  team: Team; requests: TeamPoolRequest[]; busy: string;
  run: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>;
}> = ({ team, requests, busy, run }) => {
  const [direction, setDirection] = useState<PoolDirection>('BUY');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [history, setHistory] = useState<TeamPoolEntry[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  const pending = requests.filter((r) => r.status === 'PENDING');
  const decided = requests.filter((r) => r.status === 'REJECTED').slice(0, 3);
  const whole = Number(amount);
  const valid = Number.isInteger(whole) && whole > 0;

  const showHistory = async () => {
    try {
      setHistory((await getTeamPool(team.teamId)).entries);
      setHistoryError('');
    } catch (err) {
      setHistoryError(errorText(err, 'Could not load the pool history.'));
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 800 }}>Token pool</span>
        <span className="bb-mono" style={{ fontSize: 14, fontWeight: 800 }}>
          {tokens(team.poolAvailablePaise)} tokens
          {team.poolHeldPaise > 0 && <span style={{ fontSize: 11, color: 'var(--muted)' }}> · {tokens(team.poolHeldPaise)} held</span>}
        </span>
      </div>

      {pending.map((r) => (
        <Banner key={r.requestId} tone="warn" style={{ marginBottom: 8 }}>
          {r.direction === 'BUY' ? 'Buying' : 'Selling back'} {tokens(r.tokenAmountPaise)} tokens — waiting for an admin.{' '}
          <Button variant="ghost" tone="danger" disabled={!!busy}
            onClick={() => void run(`pc-${r.requestId}`, () => cancelTeamPoolRequest(r.requestId), 'Request cancelled')}>
            Cancel this request
          </Button>
        </Banner>
      ))}
      {decided.map((r) => (
        <Banner key={r.requestId} tone="danger" style={{ marginBottom: 8 }}>
          An admin turned down {r.direction === 'BUY' ? 'buying' : 'selling back'} {tokens(r.tokenAmountPaise)} tokens
          {r.decisionNote ? `: ${r.decisionNote}` : '.'}
        </Banner>
      ))}

      <form
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          void run(`pr-${team.teamId}`, async () => {
            const message = await requestTeamPool(team.teamId, direction, whole, note.trim());
            setAmount(''); setNote('');
            return message;
          }, direction === 'BUY' ? 'Requested. Pay the platform; an admin adds the tokens.' : 'Requested. An admin will pay you and take the tokens.');
        }}
      >
        <div>
          <label htmlFor={`pd-${team.teamId}`} style={labelStyle}>Request for {team.name}</label>
          <select id={`pd-${team.teamId}`} value={direction} onChange={(e) => setDirection(e.target.value as PoolDirection)} style={inputStyle}>
            <option value="BUY">Buy tokens</option>
            <option value="SELL">Sell tokens back</option>
          </select>
        </div>
        <div>
          <label htmlFor={`pa-${team.teamId}`} style={labelStyle}>Tokens for {team.name}</label>
          <input id={`pa-${team.teamId}`} inputMode="numeric" value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} style={{ ...inputStyle, width: 130 }} />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <label htmlFor={`pn-${team.teamId}`} style={labelStyle}>Note for the admin (optional)</label>
          <input id={`pn-${team.teamId}`} value={note} onChange={(e) => setNote(e.target.value)} style={inputStyle} maxLength={200} />
        </div>
        <Button type="submit" disabled={!valid || !!busy}>Send {team.name} request</Button>
      </form>

      <div style={{ marginTop: 10 }}>
        {history === null ? (
          <Button variant="ghost" tone="neutral" onClick={() => void showHistory()}>Show {team.name} pool history</Button>
        ) : history.length === 0 ? (
          <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nothing has moved in this pool yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {history.map((h) => (
              <li key={h.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '4px 0' }}>
                <span>{POOL_KIND[h.kind] ?? h.kind} · {new Date(h.createdAt).toLocaleString('en-IN')}</span>
                <span className="bb-mono">{h.availableDeltaPaise > 0 ? '+' : ''}{tokens(h.availableDeltaPaise)} → {tokens(h.availableAfterPaise)}</span>
              </li>
            ))}
          </ul>
        )}
        {historyError && <p role="alert" style={{ fontSize: 12.5, color: 'var(--danger)' }}>{historyError}</p>}
      </div>
    </div>
  );
};

/** One team, as its supervisor manages it. Declared at module level so typing does not remount it (§32 S23). */
const SupervisorTeamCard: React.FC<{
  team: Team; members: TeamMember[]; poolRequests: TeamPoolRequest[]; commissions: TeamCommission[]; busy: string;
  run: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>;
}> = ({ team, members, poolRequests, commissions, busy, run }) => {
  const [ref, setRef] = useState('');
  const [name, setName] = useState(team.name);
  const inputId = `add-${team.teamId}`;
  const nameId = `name-${team.teamId}`;
  return (
    <Card style={{ marginBottom: 14 }}>
      <CardTitle title={team.name} sub={`${team.approvedCount} approved · ${team.pendingCount} waiting for an admin`} action={<StrengthTag team={team} />} />
      <Banner tone={STRENGTH[team.strength].tone} style={{ marginBottom: 12 }}>{STRENGTH[team.strength].body}</Banner>
      <TeamPoolSection team={team} requests={poolRequests} busy={busy} run={run} />
      <CommissionSection team={team} commissions={commissions} />

      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
        {members.length === 0 && <li style={{ fontSize: 12.5, color: 'var(--muted)' }}>No members yet.</li>}
        {members.map((m) => (
          <li key={m.merchantId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>
              {m.name} <span className="bb-mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{m.publicRef}</span>
              {m.status === 'PENDING' && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--warn)' }}>waiting for admin</span>}
            </span>
            <Button tone="danger" variant="ghost" disabled={!!busy}
              onClick={() => void run(`rm-${m.merchantId}`, () => removeTeamMember(team.teamId, m.merchantId), `${m.name} removed`)}>
              Remove {m.name}
            </Button>
          </li>
        ))}
      </ul>

      <form
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!ref.trim()) return;
          void run(`add-${team.teamId}`, async () => { await addTeamMember(team.teamId, ref.trim()); setRef(''); }, 'Added. An admin must approve them before they join.');
        }}
      >
        <div style={{ flex: 1 }}>
          <label htmlFor={inputId} style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text-2)', marginBottom: 6 }}>
            Add a member to {team.name} — their merchant ID
          </label>
          <input id={inputId} value={ref} onChange={(e) => setRef(e.target.value)} style={inputStyle} placeholder="M…" />
        </div>
        <Button type="submit" disabled={!ref.trim() || !!busy}>Add</Button>
      </form>

      <form
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || name.trim() === team.name) return;
          void run(`ren-${team.teamId}`, () => renameTeam(team.teamId, name.trim()), 'Team renamed');
        }}
      >
        <div style={{ flex: 1 }}>
          <label htmlFor={nameId} style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text-2)', marginBottom: 6 }}>
            Team name
          </label>
          <input id={nameId} value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} maxLength={60} />
        </div>
        <Button type="submit" variant="outline" disabled={!name.trim() || name.trim() === team.name || !!busy}>Rename</Button>
        {members.length === 0 && (
          <Button tone="danger" variant="outline" disabled={!!busy}
            onClick={() => void run(`del-${team.teamId}`, () => deleteTeam(team.teamId), 'Team deleted')}>
            Delete team
          </Button>
        )}
      </form>
    </Card>
  );
};

const TeamPage: React.FC = () => {
  const [data, setData] = useState<MyTeam | null>(null);
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState('');
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await getMyTeam());
      setFailed('');
    } catch (err) {
      setFailed(errorText(err, 'Could not load your team.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Run one action, toast its outcome, and reload what the server now says. */
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      await load();
    } catch (err) {
      toast.error(errorText(err, 'That could not be done.'));
    } finally {
      setBusy('');
    }
  };

  if (failed) return <ErrorState title="Team unavailable" body={failed} onRetry={() => void load()} />;
  if (!data) return <Skeleton height={220} />;

  const header = (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
      <Button variant="ghost" tone="neutral" onClick={() => void load()} title="Refresh"><RefreshCw size={15} /> Refresh</Button>
    </div>
  );

  if (data.role === 'NONE') {
    return (
      <div>
        {header}
        <Card>
          <CardTitle title="You are not in a team" sub="Orders reach merchants through teams." />
          <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
            Give this ID to a supervisor. They add you to their team, and an admin approves it.
          </p>
          <CopyRow label="Your merchant ID" value={data.publicRef} />
        </Card>
      </div>
    );
  }

  if (data.role === 'MEMBER') {
    const t = data.team;
    return (
      <div>
        {header}
        <Card>
          <CardTitle title={t.name} sub={`Supervisor ${t.supervisorName} · rail ${t.rail}`} action={<StrengthTag team={t} />} />
          {data.status === 'PENDING'
            ? <Banner tone="warn" title="Waiting for an admin">Your supervisor added you. You join the team once an admin approves.</Banner>
            : <Banner tone={STRENGTH[t.strength].tone}>{STRENGTH[t.strength].body}</Banner>}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '12px 0' }}>
            <span style={{ fontSize: 13, fontWeight: 800 }}>Your commission so far</span>
            <span className="bb-mono" style={{ fontSize: 14, fontWeight: 800 }}>{tokens(data.myCommissionPaise)} tokens</span>
          </div>
          <CommissionSection team={t} commissions={data.commissions} />
        </Card>
      </div>
    );
  }

  return (
    <div>
      {header}
      <Card style={{ marginBottom: 14 }}>
        <CardTitle title="Your teams" sub={`Supervisor · rail ${data.rail} · up to 4 teams of 10`}
          action={<span className="bb-mono" style={{ fontSize: 13, fontWeight: 800 }}>Your commission {tokens(data.myCommissionPaise)} tokens</span>} />
        <form
          style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            void run('create', async () => { await createTeam(newName.trim()); setNewName(''); }, 'Team created');
          }}
        >
          <div style={{ flex: 1 }}>
            <label htmlFor="new-team-name" style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text-2)', marginBottom: 6 }}>
              New team name
            </label>
            <input id="new-team-name" value={newName} onChange={(e) => setNewName(e.target.value)} style={inputStyle} maxLength={60} />
          </div>
          <Button type="submit" disabled={!newName.trim() || !!busy}><Users size={15} /> Create team</Button>
        </form>
      </Card>
      {data.teams.map((t) => (
        <SupervisorTeamCard key={t.teamId} team={t} busy={busy} run={run}
          members={data.members.filter((m) => m.teamId === t.teamId)}
          poolRequests={(data.poolRequests ?? []).filter((r) => r.teamId === t.teamId)}
          commissions={data.commissions ?? []} />
      ))}
    </div>
  );
};

export default TeamPage;
