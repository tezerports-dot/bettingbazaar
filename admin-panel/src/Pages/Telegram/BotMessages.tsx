// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * BotMessages.tsx — what the bot says, without a deploy.
 *
 * The welcome message is the first sentence anybody reads from this platform,
 * and it is the one most likely to need changing after launch: it carries the
 * requirement that a player's Telegram account be on the mobile linked to their
 * Aadhaar. Getting that wording wrong does not arrive as a bug report — it
 * arrives weeks later as a pile of failed verifications.
 *
 * ── Two safeties, so this is safe to hand to an operator ────────────────────
 * A blank message means "use the shipped wording", never "send nothing":
 * silence after /start is indistinguishable from a broken platform. And the
 * markup is checked against what Telegram accepts BEFORE it is stored, because
 * a message Telegram refuses is a message that never arrives — which would take
 * signup offline quietly, with nothing in the panel showing it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { MessageSquare, RotateCcw, Save } from 'lucide-react';
import api, { type BotTemplate } from '../../services/api';
import toast from 'react-hot-toast';

/** What each message is, said plainly enough to edit confidently. */
const DESCRIPTIONS: Record<string, string> = {
  welcome: 'Sent the moment somebody starts the bot. The first thing a new player ever reads — this is where the "same mobile as your Aadhaar" warning belongs.',
  ask_contact: 'Sent after they send a valid Aadhaar number, alongside the "Share my contact" button.',
  contact_confirmed: 'Sent once the phone number is proved. Carries the channel invite.',
  login_link: 'Sent with the one-time sign-in link, both after signup and whenever an existing player sends /start.',
  recovery_welcome: 'The recovery bot’s opening message, for someone who has lost their Telegram account but kept their number.',
};

export const BotMessages: React.FC = () => {
  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true); setLoadError('');
    try {
      const res = await api.telegramTemplates.list();
      if (res.success) {
        setTemplates(res.templates || []);
        setDrafts(Object.fromEntries((res.templates || []).map(t => [t.key, t.body])));
      } else {
        setLoadError(res.message || 'Could not load the bot messages.');
      }
    } catch (e: any) {
      setLoadError(e?.response?.data?.message || 'Could not load the bot messages.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (key: string, body: string) => {
    setBusy(key);
    try {
      const res = await api.telegramTemplates.save(key, body);
      if (!res.success) { toast.error(res.message || 'Could not save that message.'); return; }
      toast.success(res.message || 'Saved.');
      await load();
    } catch (e: any) {
      // The server refuses markup Telegram would reject, and says exactly what
      // is wrong. Surfaced verbatim — the operator needs the specific tag.
      toast.error(e?.response?.data?.message || 'Could not save that message.');
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) {
    return (
      <div className="card" style={{ padding: 22, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
        Loading bot messages…
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <MessageSquare size={18} style={{ color: 'var(--gold-ink)' }} />
        <div style={{ fontSize: 15, fontWeight: 800 }}>Bot messages</div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.65, marginBottom: 18, maxWidth: 680 }}>
        Edits take effect on the next message the bot sends — no restart, no deploy. Clearing a
        box restores the wording the platform ships with. Formatting uses Telegram’s HTML:
        <code style={code}>&lt;b&gt;bold&lt;/b&gt;</code>, <code style={code}>&lt;i&gt;italic&lt;/i&gt;</code>,
        <code style={code}>&lt;a href="…"&gt;link&lt;/a&gt;</code>.
      </p>

      {loadError && (
        <div style={{ padding: '12px 14px', marginBottom: 16, borderRadius: 10, border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 12.5 }}>
          {loadError}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {templates.map((t) => {
          const draft = drafts[t.key] ?? t.body;
          const dirty = draft !== t.body;
          const working = busy === t.key;

          return (
            <div key={t.key} style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 800 }}>{t.key}</span>
                {t.customised
                  ? <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--warning)' }}>EDITED</span>
                  : <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)' }}>DEFAULT</span>}
              </div>

              <p style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 8, maxWidth: 640 }}>
                {DESCRIPTIONS[t.key] || ''}
              </p>

              {t.variables.length > 0 && (
                <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
                  Available placeholders:{' '}
                  {t.variables.map(v => <code key={v} style={code}>{`{{${v}}}`}</code>)}
                </p>
              )}

              <textarea
                value={draft}
                onChange={(e) => setDrafts({ ...drafts, [t.key]: e.target.value })}
                rows={Math.min(12, Math.max(4, draft.split('\n').length + 1))}
                spellCheck
                style={{
                  width: '100%', borderRadius: 9, border: `1px solid ${dirty ? 'var(--gold)' : 'var(--input-border)'}`,
                  background: 'var(--input)', color: 'var(--text)', padding: '10px 12px',
                  fontSize: 12.5, lineHeight: 1.6, outline: 'none', resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />

              <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={() => save(t.key, draft)}
                  disabled={!dirty || working}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 8,
                    background: 'var(--gold)', color: 'var(--gold-on)', fontSize: 12, fontWeight: 700,
                    border: 'none', cursor: dirty && !working ? 'pointer' : 'not-allowed', opacity: dirty ? 1 : .45,
                  }}
                >
                  <Save size={13} />{working ? 'Saving…' : 'Save'}
                </button>

                {t.customised && (
                  <button
                    onClick={() => save(t.key, '')}
                    disabled={working}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 13px', borderRadius: 8,
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      color: 'var(--text-2)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    <RotateCcw size={13} />Restore default
                  </button>
                )}

                {dirty && (
                  <button
                    onClick={() => setDrafts({ ...drafts, [t.key]: t.body })}
                    style={{ height: 34, padding: '0 12px', borderRadius: 8, background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 12, cursor: 'pointer' }}
                  >
                    Discard changes
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const code: React.CSSProperties = {
  fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
  background: 'var(--input)', border: '1px solid var(--border)',
  borderRadius: 5, padding: '1px 5px', margin: '0 3px',
};

export default BotMessages;
