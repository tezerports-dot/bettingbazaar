// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * SupportPage.tsx — the merchants' own support desk (CLAUDE.md §2, "Support
 * desks"; owner, 2026-10-21), apart from the players'.
 *
 * A short form opens the day's one ticket: a code and a support Telegram
 * account. The conversation then happens on the merchant's own Telegram with
 * that account, the code already typed in. A payment problem on an order is a
 * dispute, decided by the Dispute Managers, not a ticket.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { LifeBuoy, Send } from 'lucide-react';
import {
  getSupportDesk, getSupportTickets, getSupportTicket, openSupportTicket, rateSupportTicket,
  type SupportDeskInfo, type SupportTicket, type SupportNote,
} from '../services/api';
import { Banner, Button, Card, CardTitle, EmptyState, Field, Skeleton, inputStyle } from '../components/ui';

const STATUS: Record<string, { label: string; color: string; bg: string }> = {
  OPEN: { label: 'Waiting for an agent', color: 'var(--warn)', bg: 'var(--warn-bg)' },
  ASSIGNED: { label: 'An agent is on it', color: 'var(--dep)', bg: 'var(--dep-bg)' },
  WAITING_USER: { label: 'Waiting for your reply', color: 'var(--warn)', bg: 'var(--warn-bg)' },
  RESOLVED: { label: 'Resolved', color: 'var(--ok)', bg: 'var(--ok-bg)' },
  CLOSED: { label: 'Closed', color: 'var(--muted)', bg: 'var(--surface-2)' },
};
const LIVE = ['OPEN', 'ASSIGNED', 'WAITING_USER'];
const when = (d: string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const TelegramLink: React.FC<{ ticket: SupportTicket }> = ({ ticket }) => (ticket.telegramLink ? (
  <a href={ticket.telegramLink} target="_blank" rel="noopener noreferrer"
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 16px', borderRadius: 12, background: 'var(--dep)', color: '#fff', fontWeight: 800, fontSize: 13.5, textDecoration: 'none' }}>
    <Send size={15} /> Chat on Telegram · @{ticket.telegramUsername}
  </a>
) : (
  <div style={{ fontSize: 12, color: 'var(--muted)' }}>An agent will write a note here. Check back soon.</div>
));

const TicketRow: React.FC<{ ticket: SupportTicket; topicLabel: string; open: boolean; onToggle: () => void }> = ({ ticket, topicLabel, open, onToggle }) => {
  const [notes, setNotes] = useState<SupportNote[] | null>(null);
  const [rated, setRated] = useState<number | null>(ticket.rating);
  const st = STATUS[ticket.status] || STATUS.CLOSED;
  const live = LIVE.includes(ticket.status);

  useEffect(() => {
    if (!open || notes) return;
    getSupportTicket(ticket.ticketId).then((d) => setNotes(d.messages.filter((m) => m.senderType === 'AGENT'))).catch(() => setNotes([]));
  }, [open, notes, ticket.ticketId]);

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface)' }}>
      <button type="button" onClick={onToggle} style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 800, fontSize: 14, color: 'var(--text)', fontFamily: 'var(--mono, monospace)' }}>{ticket.code}</span>
          <span style={{ fontSize: 11, fontWeight: 800, color: st.color, background: st.bg, padding: '3px 9px', borderRadius: 999 }}>{st.label}</span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, fontWeight: 600 }}>{topicLabel} · {when(ticket.createdAt)}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 6 }}>{ticket.subject}</div>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 11 }}>
          {ticket.reference && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Reference: <b style={{ color: 'var(--text-2)' }}>{ticket.reference}</b></div>}
          {live && <TelegramLink ticket={ticket} />}
          {notes?.map((n) => (
            <div key={n.id} style={{ background: 'var(--surface-2)', borderRadius: 11, padding: '9px 12px' }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--muted)', marginBottom: 3 }}>SUPPORT · {when(n.createdAt)}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>{n.content}</div>
            </div>
          ))}
          {!live && (
            <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              {rated ? <>You rated this {'★'.repeat(rated)}</> : <>How did we do?{[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => { rateSupportTicket(ticket.ticketId, n).then(() => setRated(n)).catch(() => {}); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--brand)' }}>☆</button>
              ))}</>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const SupportPage: React.FC = () => {
  const [info, setInfo] = useState<SupportDeskInfo | null>(null);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [topic, setTopic] = useState('');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([getSupportDesk(), getSupportTickets()]);
      setInfo(d); setTickets(t);
      if (t[0] && LIVE.includes(t[0].status)) setExpanded(t[0].ticketId);
    } catch (e: any) { setError(e?.message || 'Could not load support.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!info) return;
    setBusy(true); setError('');
    try {
      const t = await openSupportTicket({ topic, reference: reference.trim(), description: description.trim() });
      setTickets((prev) => [t, ...prev]); setExpanded(t.ticketId);
      setInfo({ ...info, openedToday: true });
      setTopic(''); setReference(''); setDescription('');
    } catch (e: any) {
      setError(e?.message || 'Could not open your ticket.');
      if (e?.data?.code === 'ONE_TICKET_A_DAY') setInfo({ ...info, openedToday: true });
    } finally { setBusy(false); }
  };

  if (loading) return <div style={{ display: 'grid', gap: 12 }}><Skeleton height={260} /><Skeleton height={120} /></div>;

  const len = description.trim().length;
  const canSend = Boolean(info && topic && len >= info.descriptionMin && len <= info.descriptionMax);
  const topicLabel = (key: string) => info?.topics.find((t) => t.key === key)?.label || key;

  return (
    <div style={{ display: 'grid', gap: 14, maxWidth: 760 }}>
      {info && !info.openedToday && (
        <Card>
          <CardTitle title="Open a support ticket" sub="One ticket a day. After this, the chat continues on Telegram." />
          <div style={{ display: 'grid', gap: 14 }}>
            <Field label="What is it about?">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {info.topics.map((t) => (
                  <button key={t.key} type="button" onClick={() => setTopic(t.key)}
                    style={{ padding: '8px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                      border: `1.5px solid ${topic === t.key ? 'var(--brand)' : 'var(--input-border)'}`,
                      background: topic === t.key ? 'var(--brand-bg, var(--surface-2))' : 'var(--surface)',
                      color: topic === t.key ? 'var(--brand)' : 'var(--text-2)' }}>{t.label}</button>
                ))}
              </div>
            </Field>
            <Field label="Order ID (optional)" htmlFor="support-ref">
              <input id="support-ref" value={reference} maxLength={info.referenceMax} onChange={(e) => setReference(e.target.value)} placeholder="Paste it if your problem is about one order" style={inputStyle} />
            </Field>
            <Field label="What happened?" htmlFor="support-desc"
              hint={len < info.descriptionMin ? `At least ${info.descriptionMin} characters` : `${len} / ${info.descriptionMax}`}>
              <textarea id="support-desc" value={description} maxLength={info.descriptionMax} rows={5} onChange={(e) => setDescription(e.target.value)}
                placeholder="Tell us what you did, what you expected and what you saw." style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.45 }} />
            </Field>
            <Banner tone="dispute" title="A payment problem on an order?">
              Disputes are decided by our Dispute Managers. Open the order: while it is disputed you can message the Dispute Manager on Telegram from there.
            </Banner>
            <Button full busy={busy} disabled={!canSend} onClick={submit}><LifeBuoy size={16} /> Open ticket</Button>
          </div>
        </Card>
      )}

      {info?.openedToday && (
        <Banner tone="info" title="Today's ticket is open">
          Keep talking to us in its Telegram chat. A new ticket opens from {when(info.nextTicketAt)}.
        </Banner>
      )}
      {error && <Banner tone="danger">{error}</Banner>}

      <Card>
        <CardTitle title="Your tickets" sub={`Last ${info?.historyDays ?? 7} days`} />
        {tickets.length === 0
          ? <EmptyState title="No tickets" body="Tickets you open appear here for 7 days." />
          : <div style={{ display: 'grid', gap: 10 }}>{tickets.map((t) => (
            <TicketRow key={t.ticketId} ticket={t} topicLabel={topicLabel(t.topic)} open={expanded === t.ticketId}
              onToggle={() => setExpanded(expanded === t.ticketId ? null : t.ticketId)} />
          ))}</div>}
      </Card>

      <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center', fontWeight: 600 }}>
        Our support team never asks for your OTP, password, tokens or money. Only chat with the Telegram account shown on your ticket.
      </div>
    </div>
  );
};

export default SupportPage;
