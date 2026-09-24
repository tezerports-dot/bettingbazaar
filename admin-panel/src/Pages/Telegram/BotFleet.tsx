// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * BotFleet.tsx — the sign-in FLEET, and the spares behind every other role.
 *
 * ── Two jobs, and the first one is new (owner decision, 2026-09-23) ─────────
 * Sign-in is a FLEET now. One bot is a throughput ceiling, not a design: the
 * Bot API allows roughly thirty messages a second PER BOT, and every signup
 * sends several. An operator runs as many sign-in bots as they need — the
 * owner's figure was 500 to 1,000 — and each account is assigned one of them in
 * rotation. They all do the same job, so which one a player gets does not
 * matter to the player; what matters is that no single one is the whole
 * platform's front door.
 *
 * So this screen ADDS, REPLACES and REMOVES sign-in bots freely, and shows the
 * one number that says whether there are enough: how many accounts each live
 * bot is carrying.
 *
 * ── The second job, unchanged ──────────────────────────────────────────────
 * Telegram suspends gambling bots. The activation form beside this one can
 * replace a dead bot, but only if the operator already has a working token in
 * hand — which means, at 3am, opening @BotFather, creating a bot, naming it,
 * copying a token, and pasting it. A spare registered here is created and
 * proved against Telegram while everything is calm, and parked on STANDBY.
 *
 * ── Why any of this disturbs nobody ────────────────────────────────────────
 * A player's identity is keyed on THEIR Telegram user id, which belongs to
 * Telegram. Which of our bots they happen to be messaging is not part of who
 * they are, so adding, promoting or retiring one changes no account, no
 * balance, no KYC state and no referral position — and, unlike a channel
 * change, it does not make anyone re-join anything. Retiring a sign-in bot
 * simply moves the players it carried onto the remaining ones, the next time
 * each of them is asked to verify.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Bot, Plus, Zap, Link2, Archive, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatters } from '../../utils/formatters';
import api, { type FleetBot, type Audience, AUDIENCES, AUDIENCE_LABEL } from '../../services/api';
import toast from 'react-hot-toast';

const label: React.CSSProperties = {
  display: 'block', fontSize: 10.5, fontWeight: 700, color: 'var(--text-2)', marginBottom: 5,
};
const input: React.CSSProperties = {
  width: '100%', height: 38, borderRadius: 9, border: '1px solid var(--input-border)',
  background: 'var(--input)', color: 'var(--text)', padding: '0 12px', fontSize: 12.5, outline: 'none',
};
const th: React.CSSProperties = {
  textAlign: 'left', fontSize: 10.5, fontWeight: 800, color: 'var(--muted)',
  textTransform: 'uppercase', letterSpacing: '.06em', padding: '0 12px 9px 0', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '11px 12px 11px 0', fontSize: 12 };

/**
 * What each role is for, in the words of the person who will have to choose one
 * under pressure.
 *
 * RECOVERY is singular — exactly one may be live — because it is the one path
 * that hands an account to a DIFFERENT Telegram account, so it stays a single
 * door somebody can watch. SIGN-IN is not, any more: each bot carries its own
 * webhook path and its own secret, so any number of them can be live at once.
 */
const ROLES: Array<{ value: FleetBot['role']; name: string; blurb: string; singular: boolean }> = [
  { value: 'signin', name: 'Sign-in', blurb: 'Verification. Run as many as you need — each account is assigned one in rotation.', singular: false },
  { value: 'recovery', name: 'Recovery', blurb: 'Account recovery, on its own token. Exactly one may be live.', singular: true },
  { value: 'broadcast', name: 'Broadcast', blurb: 'Announcements. Kept separate so a send storm cannot exhaust the sign-in bot’s rate limit.', singular: false },
  { value: 'moderation', name: 'Moderation', blurb: 'Channel admin helpers.', singular: false },
  { value: 'generic', name: 'Spare', blurb: 'Held ready with no assigned job — promote it into any role later.', singular: false },
];

const STATUS_TONE: Record<FleetBot['status'], string> = {
  ACTIVE: 'var(--success)',
  STANDBY: 'var(--warning)',
  RETIRED: 'var(--muted)',
};

/**
 * Which PANEL each bot serves (owner, 2026-09-24).
 *
 * "one bot with its own channel for merchant and one bot with its own channel
 * for admin thus it will be complete separate from user panel whether its
 * signup or login or account recovery."
 *
 * One bot serves exactly one panel, so this is a property of the bot and not a
 * mode of the screen. The blurbs say what an operator is actually choosing
 * between, because PLAYER / MERCHANT / STAFF on its own is the database's
 * vocabulary, not theirs.
 */
const AUDIENCE_BLURB: Record<Audience, string> = {
  PLAYER: 'Players signing up and verifying on the user panel. The biggest fleet by far.',
  MERCHANT: 'Merchants verifying on the merchant panel. Separate bot, separate channel.',
  STAFF: 'Admins and sub-admins verifying on this panel, and where security alerts are posted.',
};

/**
 * PLAYER is the default because it is the fleet an operator adds to most, and
 * because it is the panel that existed before the split — so the form behaves
 * as it always did unless somebody changes it. The SERVER takes no default and
 * refuses a registration with no audience, which is what stops a mistake here
 * becoming a bot quietly registered against the wrong panel.
 */
const EMPTY = {
  label: '', role: 'signin' as FleetBot['role'], audience: 'PLAYER' as Audience,
  token: '', notes: '',
};

export const BotFleet: React.FC<{ webhookBaseUrl?: string; onChanged?: () => void }> = ({ webhookBaseUrl, onChanged }) => {
  const [bots, setBots] = useState<FleetBot[]>([]);
  /** botId → how many accounts it is carrying. Live sign-in bots only. */
  const [loads, setLoads] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ ...EMPTY });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmPromote, setConfirmPromote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true); setLoadError('');
    try {
      const res = await api.telegramBots.list();
      if (res.success) { setBots(res.bots || []); setLoads(res.loads || {}); }
      else setLoadError(res.message || 'Could not load the bot fleet.');
    } catch (e: any) {
      setLoadError(e?.response?.data?.message || 'Could not load the bot fleet.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const register = async () => {
    if (!form.label.trim() || !form.token.trim()) {
      toast.error('A name and a token are both required.');
      return;
    }
    setBusy('register');
    try {
      const res = await api.telegramBots.register({
        label: form.label.trim(), role: form.role, audience: form.audience,
        token: form.token.trim(), notes: form.notes.trim() || undefined,
      });
      if (!res.success) { toast.error(res.message || 'Could not register that bot.'); return; }
      toast.success(res.message || 'Registered.');
      setForm({ ...EMPTY });
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Could not register that bot.');
    } finally {
      setBusy(null);
    }
  };

  const promote = async (bot: FleetBot) => {
    setBusy(bot.id);
    try {
      const res = await api.telegramBots.promote(bot.id, webhookBaseUrl?.trim() || undefined);
      if (!res.success) { toast.error(res.message || 'Promotion failed.'); return; }
      toast.success(res.message || `@${bot.username} is live.`);

      // Reported separately because a webhook failure does NOT unwind the
      // promotion: the row is correct and retrying is one click, whereas
      // rolling back would put the platform back on a bot that may be dead.
      if (res.webhook && res.webhook !== 'registered' && res.webhook !== 'not_required' && res.webhook !== 'unchanged') {
        toast.error(
          `Webhook ${res.webhook}. Telegram is not delivering to @${bot.username} yet — `
          + 'fill in the public URL above and use "Retry webhook".',
          { duration: 10000 },
        );
      }
      setConfirmPromote(null);
      await load();
      onChanged?.();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Promotion failed.');
    } finally {
      setBusy(null);
    }
  };

  const retryWebhook = async (bot: FleetBot) => {
    setBusy(bot.id);
    try {
      const res = await api.telegramBots.retryWebhook(bot.id, webhookBaseUrl?.trim() || undefined);
      if (!res.success) { toast.error(res.message || 'Telegram refused the webhook.'); return; }
      toast.success(res.message || 'Webhook registered.');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Telegram refused the webhook.');
    } finally {
      setBusy(null);
    }
  };

  const retire = async (bot: FleetBot) => {
    setBusy(bot.id);
    try {
      const res = await api.telegramBots.retire(bot.id);
      if (!res.success) { toast.error(res.message || 'Could not retire that bot.'); return; }
      toast.success(res.message || 'Retired.');
      await load();
      onChanged?.();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Could not retire that bot.');
    } finally {
      setBusy(null);
    }
  };

  const liveSignin = bots.filter(b => b.role === 'signin' && b.live);
  const carried = Object.values(loads).reduce((n, v) => n + v, 0);
  // The figure the fleet exists for. The Bot API allows roughly thirty messages
  // a second per bot; this says how much of the player base each one is
  // responsible for, which is the thing an operator is deciding about.
  const busiest = Math.max(0, ...Object.values(loads));

  return (
    <div className="card" style={{ padding: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Bot size={18} style={{ color: 'var(--gold-ink)' }} />
        <div style={{ fontSize: 15, fontWeight: 800 }}>Bot fleet</div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.65, marginBottom: 18, maxWidth: 680 }}>
        Register spare bots now, while nothing is wrong. Each one is verified against Telegram
        when you add it, so a bot that sits here is a bot you can trust in an emergency —
        promoting it is one click, and no player account, balance or referral position moves.
      </p>

      {/* ── The fleet's own summary ──────────────────────────────────────
          Rendered from the loads the server derived, never counted here: a
          second place that computes "how many accounts per bot" is a second
          number that can disagree with the assignment itself (§2). */}
      {!isLoading && (
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', padding: '12px 14px', marginBottom: 16, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }}>
          <Stat label="Live sign-in bots" value={String(liveSignin.length)} />
          <Stat label="Accounts assigned" value={String(carried)} />
          <Stat label="Busiest bot" value={busiest ? `${busiest} accounts` : '—'} />
        </div>
      )}

      {liveSignin.length === 1 && (
        <div style={{ display: 'flex', gap: 10, padding: '12px 14px', marginBottom: 16, borderRadius: 10, border: '1px solid var(--warning)', background: 'color-mix(in srgb, var(--warning) 8%, transparent)' }}>
          <AlertTriangle size={17} style={{ color: 'var(--warning)', flex: 'none', marginTop: 1 }} />
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            <strong>Only one live sign-in bot.</strong> Every signup goes through @{liveSignin[0].username},
            it cannot be retired while it is the last one, and if Telegram suspends it nobody can verify
            until a new bot is registered from scratch. Add a second below — it takes a minute now and
            saves an outage later.
          </div>
        </div>
      )}

      {liveSignin.length === 0 && (
        <div style={{ display: 'flex', gap: 10, padding: '12px 14px', marginBottom: 16, borderRadius: 10, border: '1px solid var(--danger)', background: 'color-mix(in srgb, var(--danger) 8%, transparent)' }}>
          <AlertTriangle size={17} style={{ color: 'var(--danger)', flex: 'none', marginTop: 1 }} />
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            <strong>No live sign-in bot.</strong> Accounts can still be created, but nobody can verify
            their mobile number, so nobody can bet, deposit or withdraw. Register one below and make it
            live.
          </div>
        </div>
      )}

      {loadError && (
        <div style={{ padding: '12px 14px', marginBottom: 16, borderRadius: 10, border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 12.5 }}>
          {loadError}
        </div>
      )}

      {/* ── Register ────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14, marginBottom: 18 }}>
        <div>
          <label style={label}>Name <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input
            value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })}
            placeholder="e.g. Backup sign-in #2" style={input}
          />
        </div>
        <div>
          <label style={label}>Role <span style={{ color: 'var(--danger)' }}>*</span></label>
          <select
            aria-label="What this bot is for"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as FleetBot['role'] })}
            style={{ ...input, cursor: 'pointer' }}
          >
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.name}</option>)}
          </select>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5, lineHeight: 1.5 }}>
            {ROLES.find(r => r.value === form.role)?.blurb}
          </div>
        </div>
        <div>
          <label style={label} htmlFor="bot-audience">
            Panel <span style={{ color: 'var(--danger)' }}>*</span>
          </label>
          <select
            id="bot-audience"
            value={form.audience}
            onChange={(e) => setForm({ ...form, audience: e.target.value as Audience })}
            style={{ ...input, cursor: 'pointer' }}
          >
            {AUDIENCES.map(a => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
          </select>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5, lineHeight: 1.5 }}>
            {AUDIENCE_BLURB[form.audience]}
          </div>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={label}>Bot token <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input
            type="password" autoComplete="off" value={form.token}
            onChange={(e) => setForm({ ...form, token: e.target.value })}
            placeholder="123456789:AA…" className="font-mono" style={input}
          />
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5 }}>
            From @BotFather. Checked against Telegram before it is stored, and never shown again —
            there is no read path for a bot token anywhere in the platform.
          </div>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={label} htmlFor="notes">Notes</label>
          <input id="notes"
            value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="e.g. created on the ops account, 14 Mar" style={input}
          />
        </div>
      </div>

      <button
        onClick={register}
        disabled={busy === 'register' || !form.label.trim() || !form.token.trim()}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 18px', borderRadius: 9,
          background: 'var(--gold)', color: 'var(--gold-on)', fontSize: 13, fontWeight: 700, border: 'none',
          cursor: busy === 'register' ? 'wait' : 'pointer',
          opacity: form.label.trim() && form.token.trim() ? 1 : .5,
          marginBottom: 22,
        }}
      >
        <Plus size={15} />{busy === 'register' ? 'Verifying with Telegram…' : 'Register bot'}
      </button>

      {/* ── Which panels have a live sign-in bot, and which do not ───────────
          The one thing this screen exists to make un-missable. A panel with no
          live sign-in bot cannot verify anybody: its gate has nothing to open,
          and the people behind it see a wall with no button. Counting it here
          turns "nobody mentioned the merchant panel" into a red line on the
          screen where it is fixed. */}
      {!isLoading && !loadError && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))',
          gap: 10, marginBottom: 18,
        }}>
          {AUDIENCES.map((a) => {
            const live = bots.filter(b => b.audience === a && b.role === 'signin' && b.live).length;
            const recovery = bots.filter(b => b.audience === a && b.role === 'recovery' && b.live).length;
            return (
              <div key={a} style={{
                padding: '11px 13px', borderRadius: 10,
                border: `1px solid ${live ? 'var(--border)' : 'var(--danger)'}`,
                background: 'var(--surface-2)',
              }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-2)' }}>
                  {AUDIENCE_LABEL[a]}
                </div>
                <div style={{
                  fontSize: 11.5, marginTop: 4, lineHeight: 1.5,
                  color: live ? 'var(--muted)' : 'var(--danger)',
                }}>
                  {live
                    ? `${live} live sign-in bot${live === 1 ? '' : 's'}`
                    : 'No live sign-in bot — nobody on this panel can verify'}
                  <br />
                  {recovery ? '1 live recovery bot' : 'No recovery bot — no password resets here'}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── The fleet ───────────────────────────────────────────────────── */}
      {isLoading ? (
        <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>Loading…</div>
      ) : bots.length === 0 ? (
        <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
          No bots registered yet.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead>
              <tr>{['Bot', 'Panel', 'Role', 'Status', 'Accounts', 'Added', 'Webhook', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {bots.map((b) => {
                const working = busy === b.id;
                return (
                  <tr key={b.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={td}>
                      <div className="font-mono" style={{ fontSize: 12.5, fontWeight: 700 }}>@{b.username}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{b.label}</div>
                      {b.notes && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>{b.notes}</div>}
                    </td>
                    {/* Rendered per row rather than as three separate tables:
                        the state an operator most needs to SEE is a panel with
                        no bot at all, and an absence is exactly what a filtered
                        list cannot show. The summary above counts it for them. */}
                    <td style={td}>{AUDIENCE_LABEL[b.audience] || b.audience}</td>
                    <td style={td}>{ROLES.find(r => r.value === b.role)?.name || b.role}</td>
                    <td style={td}>
                      <span style={{ color: STATUS_TONE[b.status], fontWeight: 700, fontSize: 11.5 }}>
                        {b.live && <CheckCircle2 size={12} style={{ verticalAlign: '-2px', marginRight: 5 }} />}
                        {b.status}
                      </span>
                    </td>
                    {/* Only a LIVE sign-in bot carries anybody. A dash for the
                        rest is the honest answer; a 0 would read as "live and
                        idle", which is a different and much more alarming fact. */}
                    <td style={td}>
                      {b.role === 'signin' && b.live
                        ? <span className="font-mono" style={{ fontSize: 12 }}>{loads[b.id] ?? 0}</span>
                        : <span style={{ color: 'var(--muted)' }}>—</span>}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{b.addedAt ? formatters.datetime(b.addedAt) : '—'}</td>
                    <td style={td}>
                      {b.lastError
                        ? <span style={{ color: 'var(--danger)', fontSize: 11 }}>{b.lastError}</span>
                        : b.webhookRegisteredAt
                          ? <span style={{ color: 'var(--success)', fontSize: 11 }}>registered</span>
                          : <span style={{ color: 'var(--muted)', fontSize: 11 }}>—</span>}
                    </td>
                    <td style={{ ...td, paddingRight: 0 }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {b.status === 'STANDBY' && (
                          confirmPromote === b.id ? (
                            <>
                              <button onClick={() => promote(b)} disabled={working} style={dangerBtn}>
                                {working ? 'Promoting…' : 'Yes, make it live'}
                              </button>
                              <button onClick={() => setConfirmPromote(null)} disabled={working} style={ghostBtn}>Cancel</button>
                            </>
                          ) : (
                            <button onClick={() => setConfirmPromote(b.id)} style={goldBtn}>
                              <Zap size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />Make live
                            </button>
                          )
                        )}
                        {b.live && (b.role === 'signin' || b.role === 'recovery') && (
                          <button onClick={() => retryWebhook(b)} disabled={working} style={ghostBtn}>
                            <Link2 size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                            {working ? 'Retrying…' : 'Retry webhook'}
                          </button>
                        )}
                        {/* A live SIGN-IN bot is retirable: the server refuses
                            only the LAST one, by counting what would be left, and
                            says so by name. Hiding the button for every live
                            sign-in bot would make a fleet of a hundred
                            un-prunable from the only screen that manages it. */}
                        {b.status !== 'RETIRED' && (
                          <button onClick={() => retire(b)} disabled={working} style={ghostBtn}>
                            <Archive size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />Retire
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmPromote && (
        <p style={{ fontSize: 11.5, color: 'var(--warning)', marginTop: 14, lineHeight: 1.6 }}>
          {bots.find(b => b.id === confirmPromote)?.role === 'recovery'
            ? 'Making a recovery bot live stands the current one down in the same step, so there is '
              + 'never a moment with two live recovery bots or none.'
            : 'Making a sign-in bot live ADDS it to the fleet — nothing is stood down, and the bots '
              + 'already carrying players keep them. New signups start including it in the rotation '
              + 'from the next one.'}
          {' '}Players keep their accounts either way.
        </p>
      )}
    </div>
  );
};

/** Declared at module level, never inside the component (§32 S23). */
const Stat: React.FC<{ label: string; value: string }> = ({ label: name, value }) => (
  <div>
    <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{name}</div>
    <div className="font-mono" style={{ fontSize: 16, fontWeight: 800, marginTop: 3 }}>{value}</div>
  </div>
);

const goldBtn: React.CSSProperties = {
  height: 30, padding: '0 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'var(--gold)', color: 'var(--gold-on)', fontSize: 11.5, fontWeight: 700,
};
const dangerBtn: React.CSSProperties = {
  height: 30, padding: '0 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'var(--danger)', color: '#fff', fontSize: 11.5, fontWeight: 700,
};
const ghostBtn: React.CSSProperties = {
  height: 30, padding: '0 11px', borderRadius: 8, cursor: 'pointer',
  background: 'var(--surface)', border: '1px solid var(--border)',
  color: 'var(--text-2)', fontSize: 11.5, fontWeight: 600,
};

export default BotFleet;
