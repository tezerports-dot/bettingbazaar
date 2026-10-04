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
//   Oversight (Step 2f): a supervisor sees every member's completed orders and
//   online time (today, 7 days), the low-activity red flags, each member's log,
//   and the disputes on their teams, where they speak for the member to the
//   dispute manager. A member sees the team's totals and their own figures.
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
  getMemberLog, getTeamDisputes, getDisputeThread, postDisputeMessage,
} from '../services/api';
import type {
  DisputeThreadMessage, LowActivityFlag, MemberActivity, MemberLog, MyTeam, PoolDirection, SupervisorOrder,
  Team, TeamCommission, TeamMember, TeamPerformance, TeamPoolEntry, TeamPoolRequest,
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

/** Seconds as "2h 05m", "45m" or "30s". */
const duration = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN') : '');
const ORDER_KIND: Record<SupervisorOrder['type'], string> = { DEPOSIT: 'Buy', WITHDRAWAL: 'Sell' };
const sectionStyle: React.CSSProperties = { borderTop: '1px solid var(--border)', paddingTop: 12, marginBottom: 12 };

/** What a member sees of the team's last seven days (Step 2f): totals, the average, and their own. Module level (§32 S23). */
const PerformanceSection: React.FC<{ performance: TeamPerformance }> = ({ performance: p }) => (
  <div style={sectionStyle}>
    <span style={{ fontSize: 13, fontWeight: 800 }}>Team performance, last {p.days} days</span>
    <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', fontSize: 12.5 }}>
      {p.team ? (
        <>
          <li style={{ padding: '3px 0' }}>The team completed {p.team.completedOrders} orders ({tokens(p.team.completedTokens * 100)} tokens).</li>
          <li style={{ padding: '3px 0' }}>An average member: {p.team.averageOrders} orders, online {duration(p.team.averageOnlineSeconds)}.</li>
        </>
      ) : (
        <li style={{ padding: '3px 0', color: 'var(--muted)' }}>The team&apos;s figures show once it has three approved members.</li>
      )}
      {p.me && <li style={{ padding: '3px 0', fontWeight: 700 }}>You: {p.me.completedOrders} orders, online {duration(p.me.onlineSeconds)}.</li>}
    </ul>
  </div>
);

/** One member's log for their supervisor: orders without the player, and online stretches. Module level (§32 S23). */
const MemberLogPanel: React.FC<{ merchantId: string }> = ({ merchantId }) => {
  const [log, setLog] = useState<MemberLog | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    getMemberLog(merchantId).then(setLog).catch((err) => setError(errorText(err, 'Could not load the log.')));
  }, [merchantId]);
  if (error) return <p role="alert" style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</p>;
  if (!log) return <Skeleton height={60} />;
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 10, margin: '6px 0 10px', fontSize: 12.5 }}>
      <strong>Orders</strong>
      {log.orders.length === 0 ? <p style={{ color: 'var(--muted)', margin: '4px 0' }}>No orders yet.</p> : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 8px' }}>
          {log.orders.map((o) => (
            <li key={o.orderId} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
              <span>{ORDER_KIND[o.type]} · {tokens(o.tokenAmount * 100)} tokens · {when(o.createdAt)}</span>
              <span className="bb-mono">{o.status}</span>
            </li>
          ))}
        </ul>
      )}
      <strong>Online, last 7 days</strong>
      {log.sessions.length === 0 ? <p style={{ color: 'var(--muted)', margin: '4px 0' }}>Not online in the last 7 days.</p> : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 0' }}>
          {log.sessions.map((s) => (
            <li key={s.startedAt} style={{ padding: '2px 0' }}>
              {when(s.startedAt)} to {s.endedAt ? when(s.endedAt) : 'now'} · {duration(s.seconds)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/**
 * Each approved member's completed orders and online time, today and over
 * seven days, with any low-activity flag of the last fortnight and their log
 * on demand. A flag is for the supervisor to judge: nothing acts on it.
 */
const TeamActivitySection: React.FC<{ team: Team; today: MemberActivity[]; week: MemberActivity[]; flags: LowActivityFlag[] }> = ({ team, today, week, flags }) => {
  const [open, setOpen] = useState('');
  const mine = week.filter((r) => r.teamId === team.teamId);
  const todayOf = (id: string) => today.find((r) => r.merchantId === id);
  const flagsOf = (id: string) => flags.filter((f) => f.merchantId === id && f.teamId === team.teamId);
  return (
    <div style={sectionStyle}>
      <span style={{ fontSize: 13, fontWeight: 800 }}>Member activity</span>
      <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '4px 0 8px' }}>
        Completed orders and time online. A red flag means a member was well below the team&apos;s average in both on that day. It is for you to judge; nothing happens to them automatically.
      </p>
      {mine.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>No approved members yet.</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {mine.map((r) => {
          const t = todayOf(r.merchantId);
          const flagged = flagsOf(r.merchantId);
          return (
            <li key={r.merchantId} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>
                  {r.name} {r.isOnline && <span style={{ fontSize: 11, color: 'var(--ok)' }}>online</span>}
                </span>
                <span style={{ fontSize: 12 }}>
                  Today {t?.completedOrders ?? 0} orders, {duration(t?.onlineSeconds ?? 0)} · 7 days {r.completedOrders} orders, {duration(r.onlineSeconds)}
                </span>
                <Button variant="ghost" tone="neutral" onClick={() => setOpen(open === r.merchantId ? '' : r.merchantId)}>
                  {open === r.merchantId ? `Hide log of ${r.name}` : `Log of ${r.name}`}
                </Button>
              </div>
              {flagged.map((f) => (
                <Banner key={f.flagId} tone="danger" style={{ marginTop: 6 }}>
                  Red flag, {f.flagDay}: {f.details.completedOrders} orders and {duration(f.details.onlineSeconds)} online,
                  against a team average of {f.details.teamAverageOrders} orders and {duration(f.details.teamAverageOnlineSeconds)}.
                </Banner>
              ))}
              {open === r.merchantId && <MemberLogPanel merchantId={r.merchantId} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/** One dispute's thread with the dispute manager, and the supervisor's reply box while it is open. Module level (§32 S23). */
const DisputeThread: React.FC<{ order: SupervisorOrder }> = ({ order }) => {
  const [messages, setMessages] = useState<DisputeThreadMessage[] | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const load = useCallback(async () => {
    try {
      setMessages((await getDisputeThread(order.orderId)).messages);
      setError('');
    } catch (err) { setError(errorText(err, 'Could not load the thread.')); }
  }, [order.orderId]);
  useEffect(() => { void load(); }, [load]);
  const boxId = `dm-${order.orderId}`;
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 10, margin: '6px 0 10px', fontSize: 12.5 }}>
      {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
      {messages === null && !error ? <Skeleton height={50} /> : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 8px' }}>
          {(messages ?? []).length === 0 && <li style={{ color: 'var(--muted)' }}>No messages yet.</li>}
          {(messages ?? []).map((m) => (
            <li key={m.id} style={{ padding: '3px 0', whiteSpace: 'pre-wrap' }}>
              <strong>{m.senderType === 'SUPERVISOR' ? 'You' : m.senderType === 'ADMIN' ? 'Dispute manager' : m.senderName}</strong>
              {' · '}{when(m.createdAt)}<br /><span>{m.message}</span>
            </li>
          ))}
        </ul>
      )}
      {order.status === 'DISPUTED' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim() || sending) return;
            setSending(true);
            postDisputeMessage(order.orderId, text.trim())
              .then(async () => { setText(''); toast.success('Sent to the dispute manager'); await load(); })
              .catch((err) => toast.error(errorText(err, 'Could not send that.')))
              .finally(() => setSending(false));
          }}
        >
          <label htmlFor={boxId} style={labelStyle}>Message the dispute manager for your member</label>
          <textarea id={boxId} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} rows={3}
            style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '4px 0' }}>Do not include anyone&apos;s mobile number.</p>
          <Button type="submit" disabled={!text.trim() || sending}>Send</Button>
        </form>
      ) : <p style={{ color: 'var(--muted)' }}>Decided{order.disputeDecision ? `: ${order.disputeDecision}` : ''}. The thread is closed.</p>}
    </div>
  );
};

/** Disputes on the supervisor's teams: open first. Module level (§32 S23). */
const TeamDisputesCard: React.FC<{ members: TeamMember[] }> = ({ members }) => {
  const [disputes, setDisputes] = useState<SupervisorOrder[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState('');
  useEffect(() => {
    getTeamDisputes().then(setDisputes).catch((err) => setError(errorText(err, 'Could not load the disputes.')));
  }, []);
  const nameOf = (id: string) => members.find((m) => m.merchantId === id)?.name ?? 'A former member';
  return (
    <Card style={{ marginBottom: 14 }}>
      <CardTitle title="Disputes on your teams" sub="Speak for your member to the dispute manager while a dispute is open." />
      {error && <p role="alert" style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</p>}
      {disputes === null && !error && <Skeleton height={60} />}
      {disputes?.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>No disputes in the last 30 days.</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {(disputes ?? []).map((d) => (
          <li key={d.orderId} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13 }}>
                <strong>{nameOf(d.merchantId)}</strong> · {ORDER_KIND[d.type]} of {tokens(d.tokenAmount * 100)} tokens ·{' '}
                <span style={{ color: d.status === 'DISPUTED' ? 'var(--warn)' : 'var(--muted)' }}>{d.status === 'DISPUTED' ? 'Open' : 'Decided'}</span>
              </span>
              <Button variant="ghost" tone="neutral" onClick={() => setOpen(open === d.orderId ? '' : d.orderId)}>
                {open === d.orderId ? 'Hide the thread' : `Open the thread for ${nameOf(d.merchantId)}`}
              </Button>
            </div>
            {d.disputeReason && <p style={{ fontSize: 12.5, color: 'var(--text-2)', margin: '4px 0 0' }}>Reason given: {d.disputeReason}</p>}
            {open === d.orderId && <DisputeThread order={d} />}
          </li>
        ))}
      </ul>
    </Card>
  );
};

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
  today: MemberActivity[]; week: MemberActivity[]; flags: LowActivityFlag[];
  run: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>;
}> = ({ team, members, poolRequests, commissions, busy, today, week, flags, run }) => {
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
      <TeamActivitySection team={team} today={today} week={week} flags={flags} />

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
          {data.status === 'APPROVED' && data.performance && <PerformanceSection performance={data.performance} />}
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
          commissions={data.commissions ?? []}
          today={data.activity?.today ?? []} week={data.activity?.week ?? []} flags={data.redFlags ?? []} />
      ))}
      {data.teams.length > 0 && <TeamDisputesCard members={data.members} />}
    </div>
  );
};

export default TeamPage;
