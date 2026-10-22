// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * SignupChannels.tsx — the Telegram channels a new player is asked to join at
 * Verify, and their waiting join requests (owner, 2026-10-21).
 *
 * A player's Verify opens the channel's "Request to join" screen in Telegram;
 * the server reads the requests from Telegram and never approves one on its
 * own. "Approve waiting" here is the one way they are approved. With no
 * channel switched on, sign-in is exactly as it was. Rotating a channel is
 * adding the new one and switching the old one off.
 *
 * Server: `GET|POST /api/admin/telegram/channels`, `PUT …/:chatId`,
 * `POST …/:chatId/approve` (backend/routes/admin/telegram.admin.routes.js),
 * area `canManageTelegram`. The title and id are Telegram's, never typed.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Megaphone, Plus, CheckCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { type TelegramChannel } from '../../services/api';
import { formatters } from '../../utils/formatters';
import { refusalText } from '../../utils/refusal';

const input: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 10,
  border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13,
};

export const SignupChannels: React.FC = () => {
  const [channels, setChannels] = useState<TelegramChannel[] | null>(null);
  const [perPress, setPerPress] = useState(1000);
  const [error, setError] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.telegram.getChannels();
      setChannels(r.channels); setPerPress(r.approvePerPress); setError(null);
    } catch (err) {
      setError(refusalText(err, 'Could not read the channels.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('add'); setError(null);
    try {
      setChannels((await api.telegram.addChannel(ref.trim())).channels);
      setRef('');
      toast.success('Channel added. New players are asked to join it at Verify.');
    } catch (err) {
      setError(refusalText(err, 'Could not add the channel.'));
    } finally { setBusy(null); }
  };

  const toggle = async (c: TelegramChannel) => {
    setBusy(c.chatId); setError(null);
    try {
      setChannels((await api.telegram.setChannelActive(c.chatId, !c.active)).channels);
    } catch (err) {
      setError(refusalText(err, 'Could not switch the channel.'));
    } finally { setBusy(null); }
  };

  const approve = async (c: TelegramChannel) => {
    setBusy(c.chatId); setError(null);
    try {
      const r = await api.telegram.approveChannelRequests(c.chatId);
      setChannels(r.channels);
      const parts = [`${r.approved} approved`];
      if (r.gone) parts.push(`${r.gone} no longer waiting in Telegram`);
      if (r.waiting) parts.push(`${r.waiting} still waiting`);
      if (r.stopped) setError(r.stopped);
      toast.success(parts.join(', '));
    } catch (err) {
      setError(refusalText(err, 'Could not approve the requests.'));
    } finally { setBusy(null); }
  };

  return (
    <section className="card" aria-label="Signup channels" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Megaphone size={18} />
        <h2 style={{ fontSize: 15, fontWeight: 800, margin: 0 }}>Signup channels</h2>
      </div>
      <p style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--muted)', margin: '0 0 12px' }}>
        A player's Verify opens a "Request to join" for every channel switched on here. Requests are
        never approved on their own: press Approve waiting when you want them in. With none switched
        on, sign-in works as before. To rotate, add the new channel and switch the old one off. The bot in
        use must be an administrator of the channel with "Invite users via link" on.
      </p>

      {error && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 10 }}>{error}</div>}

      <form onSubmit={add} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <label htmlFor="channel-ref" style={{ position: 'absolute', left: -9999 }}>Channel</label>
        <input id="channel-ref" style={input} value={ref} onChange={(e) => setRef(e.target.value)}
          placeholder="@channelname, t.me/channelname or -100…" />
        <button type="submit" className="btn-primary flex items-center gap-1" disabled={!ref.trim() || busy === 'add'}>
          <Plus size={14} /> Add
        </button>
      </form>

      {!channels && !error && <div role="status" style={{ color: 'var(--muted)', fontSize: 12.5 }}>Loading…</div>}
      {channels && channels.length === 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>No channels. Sign-in does not ask anyone to join one.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {channels?.map((c) => (
          <div key={c.chatId} data-testid={`channel-${c.chatId}`}
            style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, opacity: c.active ? 1 : 0.65 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 14 }}>{c.title}{c.username ? ` (@${c.username})` : ''}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {c.active ? 'On' : 'Off'} · {c.chatId} · added {formatters.datetime(c.addedAt)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button type="button" className="btn-primary flex items-center gap-1" disabled={busy === c.chatId || c.waiting === 0}
                  onClick={() => approve(c)} title={`Approves up to ${perPress} per press`}>
                  <CheckCheck size={14} /> Approve waiting ({c.waiting})
                </button>
                <button type="button" className="btn-secondary" disabled={busy === c.chatId} onClick={() => toggle(c)}>
                  {c.active ? 'Switch off' : 'Switch on'}
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 12, marginTop: 8, flexWrap: 'wrap' }}>
              <span>Waiting: <strong>{c.waiting}</strong></span>
              <span>Approved: <strong>{c.approved}</strong></span>
              <span>No longer in Telegram: <strong>{c.gone}</strong></span>
            </div>
            <div style={{ fontSize: 11.5, marginTop: 6, color: c.linkError ? 'var(--danger)' : 'var(--muted)', wordBreak: 'break-all' }}>
              {c.linkError
                ? c.linkError
                : c.inviteLink ? <>Invite link {c.inviteLink}{c.linkCheckedAt ? `, checked ${formatters.datetime(c.linkCheckedAt)}` : ''}</> : 'No invite link yet.'}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
