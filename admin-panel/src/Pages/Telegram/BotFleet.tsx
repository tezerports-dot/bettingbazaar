// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * BotFleet.tsx — spares registered before the incident, promoted during it.
 *
 * ── The problem this screen solves ──────────────────────────────────────────
 * Telegram suspends gambling bots. The activation form beside this one can
 * replace a dead bot, but only if the operator already has a working token in
 * hand — which means, at 3am, opening @BotFather, creating a bot, naming it,
 * copying a token, and pasting it, with signup and login dead throughout.
 *
 * Everything on this screen happens BEFORE that. A spare is created and proved
 * against Telegram while everything is calm, and parked on STANDBY. The
 * incident response is then one button.
 *
 * ── Why promoting a bot does not disturb anybody ────────────────────────────
 * A player's identity is keyed on THEIR Telegram user id, which belongs to
 * Telegram. Which of our bots they happen to be messaging is not part of who
 * they are, so a promotion changes no account, no balance, no KYC state and no
 * referral position — and, unlike a channel change, it does not make anyone
 * re-join anything.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Bot, Plus, Zap, Link2, Archive, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatters } from '../../utils/formatters';
import api, { type FleetBot } from '../../services/api';
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
 * under pressure. Sign-in and recovery are singular — exactly one of each may be
 * live, because both are addressed by an inbound webhook whose updates are
 * authenticated against the live bot's secret.
 */
const ROLES: Array<{ value: FleetBot['role']; name: string; blurb: string; singular: boolean }> = [
  { value: 'signin', name: 'Sign-in', blurb: 'Signup and login. The bot every player talks to.', singular: true },
  { value: 'recovery', name: 'Recovery', blurb: 'Account recovery, on its own token so a compromised sign-in bot cannot hand out accounts.', singular: true },
  { value: 'broadcast', name: 'Broadcast', blurb: 'Announcements. Kept separate so a send storm cannot exhaust the sign-in bot’s rate limit.', singular: false },
  { value: 'moderation', name: 'Moderation', blurb: 'Channel admin helpers.', singular: false },
  { value: 'generic', name: 'Spare', blurb: 'Held ready with no assigned job — promote it into any role later.', singular: false },
];

const STATUS_TONE: Record<FleetBot['status'], string> = {
  ACTIVE: 'var(--success)',
  STANDBY: 'var(--warning)',
  RETIRED: 'var(--muted)',
};

const EMPTY = { label: '', role: 'signin' as FleetBot['role'], token: '', notes: '' };

export const BotFleet: React.FC<{ webhookBaseUrl?: string; onChanged?: () => void }> = ({ webhookBaseUrl, onChanged }) => {
  const [bots, setBots] = useState<FleetBot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ ...EMPTY });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmPromote, setConfirmPromote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true); setLoadError('');
    try {
      const res = await api.telegramBots.list();
      if (res.success) setBots(res.bots || []);
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
        label: form.label.trim(), role: form.role,
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

  const standbySignin = bots.filter(b => b.role === 'signin' && b.status === 'STANDBY').length;
  const liveSignin = bots.find(b => b.role === 'signin' && b.live);

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

      {liveSignin && standbySignin === 0 && (
        <div style={{ display: 'flex', gap: 10, padding: '12px 14px', marginBottom: 16, borderRadius: 10, border: '1px solid var(--warning)', background: 'color-mix(in srgb, var(--warning) 8%, transparent)' }}>
          <AlertTriangle size={17} style={{ color: 'var(--warning)', flex: 'none', marginTop: 1 }} />
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            <strong>No standby sign-in bot.</strong> If @{liveSignin.username} is suspended, nobody can
            sign up or sign in until a new bot is created from scratch. Add one below — it takes a minute now
            and saves an outage later.
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
          <label style={label}>Notes</label>
          <input
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
              <tr>{['Bot', 'Role', 'Status', 'Added', 'Webhook', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr>
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
                    <td style={td}>{ROLES.find(r => r.value === b.role)?.name || b.role}</td>
                    <td style={td}>
                      <span style={{ color: STATUS_TONE[b.status], fontWeight: 700, fontSize: 11.5 }}>
                        {b.live && <CheckCircle2 size={12} style={{ verticalAlign: '-2px', marginRight: 5 }} />}
                        {b.status}
                      </span>
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
                        {b.status !== 'RETIRED' && !(b.live && b.role === 'signin') && (
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
          Making a sign-in or recovery bot live stands the current one down in the same step, so there
          is never a moment with two live bots or none. Players keep their accounts — the only change is
          which @username the site points them at.
        </p>
      )}
    </div>
  );
};

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
