// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// TeamPage — supervisors and teams on the merchant panel (redesign Step 2a,
// PROJECT_STATUS §3.10).
//
// One screen, three readers, decided by the server (GET /api/merchant/team):
//   SUPERVISOR — up to 4 teams of exactly 10; create, rename, delete an empty
//                team, propose members by their merchant ID, remove members.
//   MEMBER     — the team they are in, whether an admin has approved them yet,
//                and whether the team is working.
//   NONE       — not in a team; shows the ID to hand to a supervisor.
//
// Every cap is the server's. A refusal is shown as the server worded it,
// because it names what to do next (§32 S14).
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { RefreshCw, Users } from 'lucide-react';
import {
  getMyTeam, createTeam, renameTeam, deleteTeam, addTeamMember, removeTeamMember,
} from '../services/api';
import type { MyTeam, Team, TeamMember } from '../types';
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

/** One team, as its supervisor manages it. Declared at module level so typing does not remount it (§32 S23). */
const SupervisorTeamCard: React.FC<{
  team: Team; members: TeamMember[]; busy: string;
  run: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>;
}> = ({ team, members, busy, run }) => {
  const [ref, setRef] = useState('');
  const [name, setName] = useState(team.name);
  const inputId = `add-${team.teamId}`;
  const nameId = `name-${team.teamId}`;
  return (
    <Card style={{ marginBottom: 14 }}>
      <CardTitle title={team.name} sub={`${team.approvedCount} approved · ${team.pendingCount} waiting for an admin`} action={<StrengthTag team={team} />} />
      <Banner tone={STRENGTH[team.strength].tone} style={{ marginBottom: 12 }}>{STRENGTH[team.strength].body}</Banner>

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
        </Card>
      </div>
    );
  }

  return (
    <div>
      {header}
      <Card style={{ marginBottom: 14 }}>
        <CardTitle title="Your teams" sub={`Supervisor · rail ${data.rail} · up to 4 teams of 10`} />
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
          members={data.members.filter((m) => m.teamId === t.teamId)} />
      ))}
    </div>
  );
};

export default TeamPage;
