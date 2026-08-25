// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * TelegramConfig.tsx — replacing the bot or the channel, without a deploy.
 *
 * ── Why this screen exists at all ───────────────────────────────────────────
 * Telegram suspends bots, and gambling bots more than most. The bot is the ONLY
 * way a player signs up or signs in, so a suspension is a total outage of both.
 * If fixing it meant a code change and a redeploy of three applications, that
 * outage would be measured in hours. Here it is a form: paste a new token,
 * activate, done — and the operator doing it at 3am does not need a developer.
 *
 * ── Existing players are unaffected, and that is not luck ───────────────────
 * Identities are keyed on the person's TELEGRAM user id, which belongs to
 * Telegram rather than to our bot. A new bot sees the same ids, so balances,
 * history, referral trees and joining numbers all survive a replacement
 * untouched. The generation counter records which bot each identity was linked
 * under, so membership caches invalidate themselves rather than carrying a
 * verdict from a channel that no longer applies.
 *
 * ── Tokens are write-only ───────────────────────────────────────────────────
 * There is no read path for a bot token anywhere in the platform. This form
 * therefore never shows one and never pre-fills one; an operator changing a bot
 * supplies a fresh value. What the server sends back is only whether a token is
 * configured, which is the one thing this screen needs to know.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Bot, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Kpis } from '../../components/design';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import toast from 'react-hot-toast';

type Active = NonNullable<Awaited<ReturnType<typeof api.telegram.getConfig>>['active']>;
type HistoryRow = NonNullable<Awaited<ReturnType<typeof api.telegram.getConfig>>['history']>[number];

const label: React.CSSProperties = {
  display: 'block', fontSize: 10.5, fontWeight: 700, color: 'var(--text-2)', marginBottom: 5,
};
const input: React.CSSProperties = {
  width: '100%', height: 38, borderRadius: 9, border: '1px solid var(--input-border)',
  background: 'var(--input)', color: 'var(--text)', padding: '0 12px', fontSize: 12.5, outline: 'none',
};

const EMPTY = {
  botToken: '', recoveryBotToken: '', channelId: '', channelUsername: '',
  channelInviteLink: '', webhookBaseUrl: '', reason: '',
};

export const TelegramConfig: React.FC = () => {
  const [active, setActive] = useState<Active | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ ...EMPTY });
  const [isSaving, setIsSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true); setLoadError('');
    try {
      const res = await api.telegram.getConfig();
      if (res.success) {
        setActive(res.active || null);
        setHistory(res.history || []);
      } else {
        setLoadError(res.message || 'Could not load the Telegram configuration.');
      }
    } catch (e: any) {
      setLoadError(e?.response?.data?.message || 'Could not load the Telegram configuration.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    if (!form.botToken.trim() || !form.channelId.trim()) {
      toast.error('A bot token and a channel id are both required.');
      return;
    }
    setIsSaving(true);
    try {
      const res = await api.telegram.activate({
        botToken: form.botToken.trim(),
        recoveryBotToken: form.recoveryBotToken.trim() || undefined,
        channelId: form.channelId.trim(),
        channelUsername: form.channelUsername.trim() || undefined,
        channelInviteLink: form.channelInviteLink.trim() || undefined,
        webhookBaseUrl: form.webhookBaseUrl.trim() || undefined,
        reason: form.reason.trim() || undefined,
      });
      if (!res.success) { toast.error(res.message || 'Activation failed.'); return; }

      // The webhook is reported separately because its failure does NOT unwind
      // the config: the row is correct and can be retried, whereas rolling back
      // would leave the platform on a bot that may already be dead.
      toast.success(res.message || `Generation ${res.generation} is active.`);
      if (res.webhook && res.webhook !== 'registered') {
        toast.error(`Webhook ${res.webhook}. Sign-in will not work until it is registered — retry with the public URL filled in.`, { duration: 9000 });
      }
      setForm({ ...EMPTY });
      setConfirming(false);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Activation failed.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><div className="w-8 h-8 border-4 border-dark-600 border-t-gold-500 rounded-full animate-spin" /></div>;
  }

  return (
    <div className="om-fade" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Kpis items={[
        { label: 'Active generation', value: active ? `#${active.generation}` : '—', tone: active ? 'var(--success)' : 'var(--danger)' },
        { label: 'Sign-in bot', value: active?.botUsername ? `@${active.botUsername}` : 'Not configured', tone: active ? undefined : 'var(--danger)' },
        { label: 'Recovery bot', value: active?.recoveryBotUsername ? `@${active.recoveryBotUsername}` : 'None', tone: active?.recoveryBotConfigured ? undefined : 'var(--warning)' },
        { label: 'Channel', value: active?.channelUsername ? `@${active.channelUsername}` : (active?.channelId || '—') },
      ]} />

      {!active && (
        <div className="card" style={{ padding: '16px 18px', display: 'flex', gap: 12, borderColor: 'var(--danger)' }}>
          <AlertTriangle size={20} style={{ color: 'var(--danger)', flex: 'none', marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>No bot is configured</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>
              Nobody can sign up or sign in until a generation is activated. The bot is the
              only door players have.
            </div>
          </div>
        </div>
      )}

      {loadError && (
        <div className="card" style={{ padding: '14px 16px', borderColor: 'var(--danger)', color: 'var(--danger)', fontSize: 12.5 }}>
          {loadError}
        </div>
      )}

      {/* ── Activate a new generation ──────────────────────────────────── */}
      <div className="card" style={{ padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <Bot size={18} style={{ color: 'var(--gold-ink)' }} />
          <div style={{ fontSize: 15, fontWeight: 800 }}>Activate a new generation</div>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.65, marginBottom: 18, maxWidth: 680 }}>
          Use this when a bot is suspended or a channel is lost. Existing players keep their
          accounts, balances and referral positions — identities are keyed on each person's
          Telegram user id, not on our bot. The token is verified against Telegram before
          anything is stored, so a mistyped value is refused here rather than silently taking
          sign-in down.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 14 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={label}>Bot token <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input
              type="password" autoComplete="off" value={form.botToken}
              onChange={(e) => setForm({ ...form, botToken: e.target.value })}
              placeholder="123456789:AA…" className="font-mono" style={input}
            />
            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5 }}>
              From @BotFather. Never displayed again once stored — there is no read path for it.
            </div>
          </div>

          <div style={{ gridColumn: '1 / -1' }}>
            <label style={label}>Recovery bot token</label>
            <input
              type="password" autoComplete="off" value={form.recoveryBotToken}
              onChange={(e) => setForm({ ...form, recoveryBotToken: e.target.value })}
              placeholder="Optional — a SECOND bot, not the same one" className="font-mono" style={input}
            />
            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5 }}>
              Handles account recovery on its own token and secret, so a compromised sign-in
              bot cannot hand out other people's accounts. Leave blank to run without recovery.
            </div>
          </div>

          <div>
            <label style={label}>Channel id <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input
              value={form.channelId} onChange={(e) => setForm({ ...form, channelId: e.target.value })}
              placeholder="-1001234567890" className="font-mono" style={input}
            />
          </div>
          <div>
            <label style={label}>Channel @username</label>
            <input
              value={form.channelUsername} onChange={(e) => setForm({ ...form, channelUsername: e.target.value })}
              placeholder="bettingbazaar" style={input}
            />
          </div>
          <div>
            <label style={label}>Channel invite link</label>
            <input
              value={form.channelInviteLink} onChange={(e) => setForm({ ...form, channelInviteLink: e.target.value })}
              placeholder="https://t.me/+…" style={input}
            />
          </div>
          <div>
            <label style={label}>Public URL for the webhook</label>
            <input
              value={form.webhookBaseUrl} onChange={(e) => setForm({ ...form, webhookBaseUrl: e.target.value })}
              placeholder="https://your-domain.example" style={input}
            />
            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5 }}>
              Defaults to the server's configured origin. Telegram must be able to reach it.
            </div>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={label}>Reason</label>
            <input
              value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}
              placeholder="e.g. previous bot suspended by Telegram" style={input}
            />
            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5 }}>
              Kept with the generation. Worth writing — it is what the next person reads when
              they wonder why the bot changed.
            </div>
          </div>
        </div>

        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {!confirming ? (
            <button
              onClick={() => setConfirming(true)}
              disabled={!form.botToken.trim() || !form.channelId.trim()}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 18px', borderRadius: 9,
                background: 'var(--gold)', color: 'var(--gold-on)', fontSize: 13, fontWeight: 700, border: 'none',
                cursor: form.botToken.trim() && form.channelId.trim() ? 'pointer' : 'not-allowed',
                opacity: form.botToken.trim() && form.channelId.trim() ? 1 : .5,
              }}
            >
              <RefreshCw size={15} />Activate
            </button>
          ) : (
            <>
              <span style={{ fontSize: 12.5, color: 'var(--warning)', fontWeight: 600 }}>
                This immediately becomes the live bot for every new sign-in. Continue?
              </span>
              <button
                onClick={submit} disabled={isSaving}
                style={{ height: 40, padding: '0 18px', borderRadius: 9, background: 'var(--danger)', color: '#fff', fontSize: 13, fontWeight: 700, border: 'none', cursor: 'pointer', opacity: isSaving ? .6 : 1 }}
              >
                {isSaving ? 'Activating…' : 'Yes, activate'}
              </button>
              <button
                onClick={() => setConfirming(false)} disabled={isSaving}
                style={{ height: 40, padding: '0 16px', borderRadius: 9, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── History ────────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>Generation history</div>
        <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 14 }}>
          Ten most recent. Every replacement is recorded with who made it and why.
        </p>

        {history.length === 0 ? (
          <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
            Nothing yet — no generation has been activated.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
              <thead>
                <tr>
                  {['Gen', 'Bot', 'Channel', 'Activated', 'By', 'Reason'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', padding: '0 12px 9px 0', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.generation} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="font-mono" style={{ padding: '11px 12px 11px 0', fontSize: 12.5, fontWeight: 700 }}>
                      #{h.generation}
                      {h.active && <CheckCircle2 size={13} style={{ color: 'var(--success)', marginLeft: 7, verticalAlign: '-2px' }} />}
                    </td>
                    <td className="font-mono" style={{ padding: '11px 12px 11px 0', fontSize: 12 }}>{h.botUsername ? `@${h.botUsername}` : '—'}</td>
                    <td className="font-mono" style={{ padding: '11px 12px 11px 0', fontSize: 12 }}>{h.channelUsername ? `@${h.channelUsername}` : h.channelId}</td>
                    <td style={{ padding: '11px 12px 11px 0', fontSize: 12, whiteSpace: 'nowrap' }}>{h.activatedAt ? formatters.datetime(h.activatedAt) : '—'}</td>
                    <td style={{ padding: '11px 12px 11px 0', fontSize: 12 }}>{h.activatedBy?.username || '—'}</td>
                    <td style={{ padding: '11px 0', fontSize: 12, color: 'var(--muted)' }}>{h.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default TelegramConfig;
