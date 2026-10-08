// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * TelegramBot.tsx — the one bot (Step 3, owner 2026-10-07).
 *
 * One bot carries the Mini App that verifies every account and approves every
 * staff and merchant sign-in. Telegram suspends gambling bots, so replacing it
 * is this form, not a deploy: paste a new token from @BotFather and save.
 * Links survive a swap — they key on the person's Telegram id, which belongs
 * to Telegram, not to the bot.
 *
 * Server: `GET|PUT /api/admin/telegram/bot` (backend/routes/admin/
 * telegram.admin.routes.js), area `canManageTelegram`. The token is
 * write-only: the server never sends one back, so this form never shows or
 * pre-fills one. The bot's id and @username are Telegram's answer to the
 * token, never typed here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Bot, CheckCircle2, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { type TelegramBot as BotView } from '../../services/api';
import { useAuthStore } from '../../services/auth';
import { formatters } from '../../utils/formatters';
import { refusalText } from '../../hooks/useTelegramPoll';

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

export const TelegramBot: React.FC = () => {
  const [bot, setBot] = useState<BotView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [shortName, setShortName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const view = await api.telegram.getBot();
      setBot(view);
      setShortName(view.miniAppShortName || '');
      setLoadError(null);
    } catch (err) {
      setLoadError(refusalText(err, 'Could not read the Telegram bot.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    const wasBootstrap = useAuthStore.getState().bootstrap;
    try {
      const body: { token?: string; miniAppShortName: string } = { miniAppShortName: shortName.trim() };
      if (token.trim()) body.token = token.trim();
      const view = await api.telegram.saveBot(body);
      setBot(view);
      setShortName(view.miniAppShortName || '');
      setToken('');
      toast.success(`Saved. The bot is @${view.botUsername}.`);
      // This session was a password alone (no bot existed). Now one does, the
      // server refuses it on the next request with TWO_FACTOR_REQUIRED;
      // asking now ends it with those words on the sign-in form, where the
      // operator signs in again and approves in Telegram.
      if (wasBootstrap) await useAuthStore.getState().verifySession();
    } catch (err) {
      setSaveError(refusalText(err, 'Could not save the bot.'));
    } finally {
      setSaving(false);
    }
  };

  if (!bot && !loadError) {
    return <div role="status" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>;
  }

  return (
    <div className="om-fade" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {loadError && <div role="alert" style={alertStyle}>{loadError}</div>}

      {bot && (
        <div className="card" style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {bot.configured
              ? <CheckCircle2 size={20} style={{ color: 'var(--success)' }} />
              : <AlertTriangle size={20} style={{ color: 'var(--danger)' }} />}
            <div style={{ fontSize: 14, fontWeight: 800 }}>
              {bot.configured ? 'Bot configured' : 'No bot saved'}
            </div>
          </div>
          <Fact name="Bot">{bot.botUsername ? `@${bot.botUsername}` : '—'}</Fact>
          <Fact name="Mini App short name">{bot.miniAppShortName || '(main Mini App)'}</Fact>
          <Fact name="Updated">{bot.updatedAt ? formatters.datetime(bot.updatedAt) : '—'}</Fact>
          <Fact name="Updated by">{bot.updatedBy || '—'}</Fact>
        </div>
      )}

      {bot && !bot.configured && (
        <div className="card" style={{ padding: '14px 18px', fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-2)' }}>
          Until a bot is saved, nobody can verify an account or approve a sign-in, and staff sign in
          with a password alone. Saving one ends that: every staff account, yours included, then signs
          in again and approves it in Telegram.
        </div>
      )}

      <div className="card" style={{ padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <Bot size={18} style={{ color: 'var(--gold-ink)' }} />
          <div style={{ fontSize: 15, fontWeight: 800 }}>{bot?.configured ? 'Replace or update the bot' : 'Save the bot'}</div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 18, lineHeight: 1.5 }}>
          The token comes from @BotFather. Telegram is asked about it before it is stored, and it is
          never shown again. Leave it empty to change only the Mini App short name.
        </div>

        <form onSubmit={save} style={{ display: 'grid', gap: 14, maxWidth: 560 }}>
          <div>
            <label htmlFor="tg-bot-token" style={label}>Bot token</label>
            <input
              id="tg-bot-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={bot?.configured ? 'Leave empty to keep the current bot' : '123456789:AA…'}
              className="font-mono"
              style={input}
            />
          </div>
          <div>
            <label htmlFor="tg-mini-app-short-name" style={label}>Mini App short name</label>
            <input
              id="tg-mini-app-short-name"
              type="text"
              value={shortName}
              onChange={(e) => setShortName(e.target.value)}
              placeholder="Empty for the bot's main Mini App"
              className="font-mono"
              style={input}
            />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
              The part after the bot in t.me/&lt;bot&gt;/&lt;short name&gt;: letters, digits and _.
            </div>
          </div>

          {saveError && <div role="alert" style={alertStyle}>{saveError}</div>}

          <div>
            <button type="submit" className="btn btn-primary" disabled={saving} style={{ opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Asking Telegram…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
