// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * TelegramBot.tsx — the bot and its standbys (Step 3, owner 2026-10-07;
 * standbys, owner 2026-10-14).
 *
 * The primary bot carries the Mini App that verifies every player and merchant
 * and approves their sign-ins (staff sign in with an authenticator app, owner
 * 2026-10-13). Up to three standby bots, each with its own Mini App, wait
 * beside it: Telegram suspends gambling bots, and when it refuses the bot in
 * use the server suspends it and every new link names the next standby, with
 * nobody at the keyboard. Links survive any swap — they key on the person's
 * Telegram id, which belongs to Telegram, not to the bot.
 *
 * Server: `GET|PUT /api/admin/telegram/bot`, `DELETE /api/admin/telegram/bot/:slot`,
 * `POST /api/admin/telegram/bot/:slot/resume` (backend/routes/admin/
 * telegram.admin.routes.js), area `canManageTelegram`. The token is
 * write-only: the server never sends one back, so this form never shows or
 * pre-fills one. The bot's id and @username are Telegram's answer to the
 * token, never typed here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Bot, CheckCircle2, AlertTriangle, PauseCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { type TelegramBot as BotView, type TelegramBotSlot } from '../../services/api';
import { formatters } from '../../utils/formatters';
import { refusalText } from '../../utils/refusal';

const label: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-2)', marginBottom: 5,
};
const input: React.CSSProperties = {
  width: '100%', height: 38, borderRadius: 9, border: '1px solid var(--input-border)',
  background: 'var(--input)', color: 'var(--text)', padding: '0 12px', fontSize: 12.5, outline: 'none',
};
const alertStyle: React.CSSProperties = {
  padding: '12px 14px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, lineHeight: 1.5,
  background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--border)',
};

/** One labelled figure of the bot's state. Module level (§32 S23). */
const Fact: React.FC<{ name: string; children: React.ReactNode }> = ({ name, children }) => (
  <div style={{ minWidth: 150 }}>
    <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em' }}>{name}</div>
    <div className="font-mono" style={{ fontSize: 13, fontWeight: 700, marginTop: 3 }}>{children}</div>
  </div>
);

/** What a slot is called on screen. */
const slotName = (slot: number) => (slot === 1 ? 'Primary bot' : `Standby ${slot - 1}`);

/**
 * One slot: what it holds and the form that fills or replaces it. Module
 * level (§32 S23). `inUse` marks the bot every new link names.
 */
const SlotCard: React.FC<{
  slot: number;
  bot: TelegramBotSlot | undefined;
  inUse: boolean;
  onChanged: () => Promise<void>;
}> = ({ slot, bot, inUse, onChanged }) => {
  const name = slotName(slot);
  const [token, setToken] = useState('');
  const [shortName, setShortName] = useState(bot?.miniAppShortName || '');
  const [busy, setBusy] = useState<'save' | 'resume' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setShortName(bot?.miniAppShortName || ''); }, [bot?.miniAppShortName]);

  const run = async (what: 'save' | 'resume' | 'remove', act: () => Promise<string>, fallback: string) => {
    setBusy(what);
    setError(null);
    try {
      toast.success(await act());
      await onChanged();
    } catch (err) {
      setError(refusalText(err, fallback));
    } finally {
      setBusy(null);
    }
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void run('save', async () => {
      const body: { slot?: number; token?: string; miniAppShortName: string } = { miniAppShortName: shortName.trim() };
      if (slot !== 1) body.slot = slot;
      if (token.trim()) body.token = token.trim();
      const view = await api.telegram.saveBot(body);
      setToken('');
      return `Saved. ${name} is @${view.botUsername}.`;
    }, 'Could not save the bot.');
  };

  const status = !bot
    ? { icon: <AlertTriangle size={18} style={{ color: slot === 1 ? 'var(--danger)' : 'var(--muted)' }} />, text: 'Empty' }
    : bot.suspended
      ? { icon: <PauseCircle size={18} style={{ color: 'var(--danger)' }} />, text: 'Suspended' }
      : { icon: <CheckCircle2 size={18} style={{ color: 'var(--success)' }} />, text: inUse ? 'In use' : 'Ready' };

  const id = `tg-bot-${slot}`;
  return (
    <section className="card" aria-label={name} style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <Bot size={18} style={{ color: 'var(--gold-ink)' }} />
        <div style={{ fontSize: 15, fontWeight: 800 }}>{name}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700 }}>
          {status.icon}{status.text}
        </div>
      </div>

      {bot && (
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginBottom: 14 }}>
          <Fact name="Bot">@{bot.botUsername}</Fact>
          <Fact name="Mini App short name">{bot.miniAppShortName || '(main Mini App)'}</Fact>
          <Fact name="Updated">{bot.updatedAt ? formatters.datetime(bot.updatedAt) : '—'}</Fact>
          <Fact name="Updated by">{bot.updatedBy || '—'}</Fact>
        </div>
      )}
      {bot?.suspended && (
        <div role="status" style={{ ...alertStyle, marginBottom: 14 }}>
          Suspended {bot.suspendedAt ? formatters.datetime(bot.suspendedAt) : ''}: {bot.suspendedReason || 'no reason given'}.
          New links use the next standby. Save a new token, or resume it if Telegram has lifted the ban.
        </div>
      )}

      <form onSubmit={save} style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
        <div>
          <label htmlFor={`${id}-token`} style={label}>{name} token</label>
          <input
            id={`${id}-token`}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={bot ? 'Leave empty to keep this bot' : '123456789:AA…'}
            className="font-mono"
            style={input}
          />
        </div>
        <div>
          <label htmlFor={`${id}-short`} style={label}>{name} Mini App short name</label>
          <input
            id={`${id}-short`}
            type="text"
            value={shortName}
            onChange={(e) => setShortName(e.target.value)}
            placeholder="Empty for the bot's main Mini App"
            className="font-mono"
            style={input}
          />
        </div>

        {error && <div role="alert" style={alertStyle}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="submit" className="btn btn-primary" disabled={busy !== null} aria-label={`Save ${name}`} style={{ opacity: busy ? 0.6 : 1 }}>
            {busy === 'save' ? 'Asking Telegram…' : 'Save'}
          </button>
          {bot?.suspended && (
            <button type="button" className="btn" disabled={busy !== null} aria-label={`Resume ${name}`}
              onClick={() => void run('resume', async () => {
                const view = await api.telegram.resumeBot(slot);
                return `@${view.botUsername} is back in use.`;
              }, 'Could not resume the bot.')}>
              {busy === 'resume' ? 'Asking Telegram…' : 'Resume'}
            </button>
          )}
          {bot && slot !== 1 && (
            <button type="button" className="btn" disabled={busy !== null} aria-label={`Remove ${name}`}
              onClick={() => {
                if (!window.confirm(`Remove @${bot.botUsername} from ${name}?`)) return;
                void run('remove', async () => {
                  await api.telegram.removeBot(slot);
                  setShortName('');
                  return `${name} removed.`;
                }, 'Could not remove the bot.');
              }}>
              Remove
            </button>
          )}
        </div>
      </form>
    </section>
  );
};

export const TelegramBot: React.FC = () => {
  const [view, setView] = useState<BotView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.telegram.getBot());
      setLoadError(null);
    } catch (err) {
      setLoadError(refusalText(err, 'Could not read the Telegram bots.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!view && !loadError) {
    return <div role="status" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>;
  }

  const slots = Array.from({ length: view?.slots || 4 }, (_, i) => i + 1);
  const bots = view?.bots ?? [];
  return (
    <div className="om-fade" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {loadError && <div role="alert" style={alertStyle}>{loadError}</div>}

      {view && (
        <div className="card" style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {view.configured
            ? <CheckCircle2 size={20} style={{ color: 'var(--success)' }} />
            : <AlertTriangle size={20} style={{ color: 'var(--danger)' }} />}
          <div style={{ fontSize: 14, fontWeight: 800 }}>
            {view.configured ? `In use: @${view.botUsername} (${slotName(view.slot ?? 1)})` : 'No bot in use'}
          </div>
        </div>
      )}

      {view && !view.configured && (
        <div className="card" style={{ padding: '14px 18px', fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-2)' }}>
          Until a bot is saved and working, no player or merchant can verify their account or sign
          in with Telegram. Staff sign-in does not use Telegram.
        </div>
      )}

      <div className="card" style={{ padding: '14px 18px', fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }}>
        Each token comes from @BotFather and is asked of Telegram before it is stored; it is never
        shown again. Give every standby its own Mini App at the same page as the primary
        (https://&lt;site&gt;/mini-app.html). When Telegram refuses the bot in use, it is suspended within
        seconds and new sign-ins and links use the next standby. Accounts belong to the person's
        Telegram, so every bot already knows everyone.
      </div>

      {slots.map((slot) => (
        <SlotCard
          key={slot}
          slot={slot}
          bot={bots.find((b) => b.slot === slot)}
          inUse={view?.slot === slot}
          onChanged={load}
        />
      ))}
    </div>
  );
};
