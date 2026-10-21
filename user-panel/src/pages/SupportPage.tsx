// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * SupportPage.tsx — admin-configured support channels, and the player's
 * support desk (CLAUDE.md §2, "Support desks"; owner, 2026-10-21).
 *
 * A ticket is a short form: topic, an optional order or bet id, and what
 * happened. Opening it gives it a code and a support Telegram account; the
 * conversation then happens on the player's own Telegram with that account,
 * the code already typed in. One ticket a day, held by the database. Nothing
 * here claims an agent is present: the ticket's state is the server's.
 *
 * The assistant (POST /api/support/ask) answers from the ingested knowledge
 * base only and is offered before the form; an ungrounded answer is never
 * shown as one, and what the player asked is carried into the form.
 */
import React, { useCallback, useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { getBackend } from '../services/backend.service';
import { support } from '../services/api';
import ScreenShell, { card } from '../redesign/Screen';
import { useShell } from '../redesign/RedesignShell';

const backend = getBackend();

/**
 * Every field `SUPPORT_LINKS_SPEC` declares. It used to name seven of twelve,
 * and the five it omitted were unreachable for players even though an admin
 * could set them — the §32 S10 shape, a type that omits a field the server does
 * send. `phone` and `helpCenterUrl` are picked up here; `termsUrl` and
 * `privacyUrl` are rows on Profile, where a player looks for them.
 */
interface SupportLinks {
  whatsapp: string; telegram: string; telegramUsername: string;
  telegramGroupUrl: string; telegramChannelUrl: string;
  instagram: string; youtube: string; email: string; phone: string;
  helpCenterUrl: string; termsUrl: string; privacyUrl: string;
}
interface Topic { key: string; label: string }
interface Ticket {
  ticketId: string; code: string; topic: string; subject: string; reference: string;
  status: string; createdAt: string; rating: number | null;
  telegramUsername: string | null; telegramLink: string;
}
interface DeskInfo {
  topics: Topic[]; historyDays: number; descriptionMin: number; descriptionMax: number;
  referenceMax: number; openedToday: boolean; nextTicketAt: string;
}

/** The ticket's state in the player's words. */
const STATUS: Record<string, { label: string; color: string }> = {
  OPEN: { label: 'Waiting for an agent', color: 'var(--gold-ink)' },
  ASSIGNED: { label: 'An agent is on it', color: 'var(--bombay)' },
  WAITING_USER: { label: 'Waiting for your reply on Telegram', color: 'var(--gold-ink)' },
  RESOLVED: { label: 'Resolved', color: 'var(--green)' },
  CLOSED: { label: 'Closed', color: 'var(--text3)' },
};

const fmtWhen = (d: string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Opens the player's own Telegram on the ticket's support account, the code typed in. */
const TelegramButton: React.FC<{ ticket: Ticket }> = ({ ticket }) => (
  ticket.telegramLink ? (
    <a href={ticket.telegramLink} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 12, textDecoration: 'none', background: 'var(--bombay)', color: '#fff', fontWeight: 800, fontSize: 14 }}>
      ✈️ Chat on Telegram · @{ticket.telegramUsername}
    </a>
  ) : (
    <div style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'center', padding: 8 }}>An agent will write a note here. Check back soon.</div>
  )
);

/**
 * One ticket: its code, state, the Telegram chat it opens, the agent's notes,
 * and a rating once it is resolved.
 */
const TicketCard: React.FC<{ ticket: Ticket; topics: Topic[]; expanded: boolean; onToggle: () => void }> = ({ ticket, topics, expanded, onToggle }) => {
  const [notes, setNotes] = useState<any[] | null>(null);
  const [rated, setRated] = useState<number | null>(ticket.rating);
  const st = STATUS[ticket.status] || { label: ticket.status, color: 'var(--text3)' };
  const live = ['OPEN', 'ASSIGNED', 'WAITING_USER'].includes(ticket.status);

  useEffect(() => {
    if (!expanded || notes) return;
    support.ticket(ticket.ticketId).then((d: any) => setNotes((d?.messages || []).filter((m: any) => m.senderType === 'AGENT'))).catch(() => setNotes([]));
  }, [expanded, notes, ticket.ticketId]);

  const rate = async (n: number) => {
    try { await support.rate(ticket.ticketId, n); setRated(n); } catch { /* already rated */ }
  };

  return (
    <div style={{ ...card, padding: 14 }}>
      <button onClick={onToggle} style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span className="font-grotesk" style={{ fontWeight: 800, fontSize: 14, color: 'var(--text)' }}>{ticket.code}</span>
          <span style={{ fontSize: 10, fontWeight: 800, color: st.color }}>{st.label}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>
          {topics.find((t) => t.key === ticket.topic)?.label || ticket.topic} · {fmtWhen(ticket.createdAt)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: expanded ? 'normal' : 'nowrap' }}>{ticket.subject}</div>
      </button>
      {expanded && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
          {ticket.reference && <div style={{ fontSize: 11, color: 'var(--text3)' }}>Reference: <b style={{ color: 'var(--text2)' }}>{ticket.reference}</b></div>}
          {live && <TelegramButton ticket={ticket} />}
          {notes?.map((n) => (
            <div key={n.id} style={{ background: 'var(--surface3)', borderRadius: 12, padding: '9px 12px' }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.06em', color: 'var(--text3)', marginBottom: 3 }}>SUPPORT · {fmtWhen(n.createdAt)}</div>
              <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.45 }}>{n.content}</div>
            </div>
          ))}
          {!live && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text3)' }}>
              {rated ? <>You rated this {'★'.repeat(rated)}</> : <>How did we do?{[1, 2, 3, 4, 5].map((n) => (
                <button key={n} onClick={() => rate(n)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--gold)' }}>☆</button>
              ))}</>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * The support desk (owner, 2026-10-21): the assistant first when it is on, then
 * a short form that opens the day's one ticket, which hands the player to a
 * support account on their own Telegram with the ticket code typed in. The
 * chat itself happens there, not in the app. Payment problems on a buy or a
 * sell are disputes, raised on the order.
 */
const SupportDesk: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [info, setInfo] = useState<DeskInfo | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [topic, setTopic] = useState('');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [assistantOn, setAssistantOn] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ text: string; grounded: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([support.desk(), support.tickets()]);
      setInfo(d);
      const list: Ticket[] = t?.tickets || [];
      setTickets(list);
      if (list[0] && ['OPEN', 'ASSIGNED', 'WAITING_USER'].includes(list[0].status)) setExpanded(list[0].ticketId);
    } catch (e: any) {
      setError(e?.message || 'Could not load support.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    // The assistant is offered only when both halves are configured; a failed
    // probe is "no", never a reason to stop a player reaching a person.
    support.assistantStatus().then((d: any) => setAssistantOn(Boolean(d?.success && d?.enabled))).catch(() => setAssistantOn(false));
  }, [load]);

  const askAssistant = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      const d = await support.ask(q);
      // An ungrounded answer is not shown as one: the form is the offer.
      const grounded = Boolean(d?.success && d?.grounded && String(d?.answer || '').trim());
      setAnswer({ text: grounded ? String(d.answer).trim() : "I don't have an answer for that. Open a ticket below and a person will help.", grounded });
      if (!description) setDescription(q);
    } catch {
      setAnswer({ text: 'The assistant is not answering right now. Open a ticket below.', grounded: false });
      if (!description) setDescription(q);
    } finally { setBusy(false); }
  };

  const submit = async () => {
    if (!info || busy) return;
    setBusy(true); setError('');
    try {
      const d = await support.openTicket({ topic, reference: reference.trim(), description: description.trim() });
      setTickets((prev) => [d.ticket, ...prev]);
      setExpanded(d.ticket.ticketId);
      setInfo({ ...info, openedToday: true });
      setDescription(''); setReference(''); setTopic('');
    } catch (e: any) {
      setError(e?.message || 'Could not open your ticket.');
      if (e?.data?.code === 'ONE_TICKET_A_DAY') setInfo({ ...info, openedToday: true });
    } finally { setBusy(false); }
  };

  const len = description.trim().length;
  const canSend = Boolean(info && topic && len >= info.descriptionMin && len <= info.descriptionMax && !busy);
  const field: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 12, padding: '11px 13px', color: 'var(--text)', fontSize: 13, outline: 'none' };
  const label: React.CSSProperties = { fontSize: 10, fontWeight: 800, letterSpacing: '.06em', color: 'var(--text3)', margin: '0 0 6px 2px' };

  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 130, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(2px)' }} />
      <div className="bb-rise" style={{ position: 'absolute', right: 0, bottom: 0, top: 0, zIndex: 131, width: 'min(94vw,440px)', display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderLeft: '1px solid var(--line2)', boxShadow: '-20px 0 50px -12px rgba(0,0,0,.6)' }}>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 11, padding: '16px 16px 14px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', background: 'color-mix(in srgb,var(--gold) 14%,var(--surface3))', border: '1px solid var(--line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19 }}>🛟</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>Support</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600 }}>One ticket a day · we chat on Telegram</div>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid var(--line)', background: 'var(--surface3)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13 }}>✕</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          {loading && <div style={{ textAlign: 'center', color: 'var(--text3)', fontSize: 12, padding: 20 }}>Loading…</div>}

          {!loading && assistantOn && !info?.openedToday && (
            <div style={{ ...card, padding: 14 }}>
              <div style={label}>ASK THE ASSISTANT FIRST</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') askAssistant(); }} placeholder="How do I…" style={{ ...field, borderRadius: 999 }} />
                <button onClick={askAssistant} disabled={busy || !question.trim()} style={{ flex: 'none', width: 44, borderRadius: '50%', border: 'none', background: 'var(--gold-metal)', color: 'var(--on-gold)', cursor: 'pointer', opacity: busy || !question.trim() ? .5 : 1 }}>➤</button>
              </div>
              {answer && (
                <div style={{ marginTop: 10, background: 'var(--surface3)', borderRadius: 12, padding: '9px 12px' }}>
                  <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.06em', color: 'var(--gold)', marginBottom: 3 }}>ASSISTANT · AUTOMATED</div>
                  <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.45 }}>{answer.text}</div>
                </div>
              )}
            </div>
          )}

          {!loading && info && !info.openedToday && (
            <div style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>Open a support ticket</div>
              <div>
                <div style={label}>WHAT IS IT ABOUT?</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                  {info.topics.map((t) => (
                    <button key={t.key} onClick={() => setTopic(t.key)} style={{ padding: '7px 12px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: topic === t.key ? '1px solid var(--gold)' : '1px solid var(--line2)', background: topic === t.key ? 'color-mix(in srgb,var(--gold) 16%,var(--surface2))' : 'var(--surface2)', color: topic === t.key ? 'var(--gold-ink)' : 'var(--text2)' }}>{t.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={label}>ORDER OR BET ID (OPTIONAL)</div>
                <input value={reference} maxLength={info.referenceMax} onChange={(e) => setReference(e.target.value)} placeholder="Paste it if your problem is about one" style={field} />
              </div>
              <div>
                <div style={label}>WHAT HAPPENED?</div>
                <textarea value={description} maxLength={info.descriptionMax} onChange={(e) => setDescription(e.target.value)} rows={5} placeholder="Tell us what you did, what you expected and what you saw." style={{ ...field, resize: 'vertical', lineHeight: 1.45 }} />
                <div style={{ fontSize: 10, color: len && len < info.descriptionMin ? 'var(--red)' : 'var(--text3)', textAlign: 'right', marginTop: 3 }}>
                  {len < info.descriptionMin ? `At least ${info.descriptionMin} characters` : `${len} / ${info.descriptionMax}`}
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.45, background: 'var(--surface2)', borderRadius: 10, padding: '9px 11px' }}>
                A problem with a payment on a buy or a sell? Use <b style={{ color: 'var(--text2)' }}>Dispute</b> on that order in your Wallet instead: our Dispute Managers handle those.
              </div>
              <button onClick={submit} disabled={!canSend} style={{ height: 48, borderRadius: 12, border: 'none', cursor: canSend ? 'pointer' : 'default', background: 'var(--gold-metal)', color: 'var(--on-gold)', fontWeight: 800, fontSize: 14, opacity: canSend ? 1 : .5 }}>
                {busy ? 'Opening…' : 'Open ticket'}
              </button>
              <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center' }}>You can open one ticket a day. After this, the chat continues on Telegram.</div>
            </div>
          )}

          {!loading && info?.openedToday && (
            <div style={{ ...card, padding: 12, fontSize: 12, color: 'var(--text2)', lineHeight: 1.45 }}>
              You have opened today&apos;s ticket. Keep talking to us in its Telegram chat. A new ticket opens from {fmtWhen(info.nextTicketAt)}.
            </div>
          )}

          {error && <div style={{ fontSize: 12, color: 'var(--red)', textAlign: 'center' }}>{error}</div>}

          {!loading && tickets.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <div style={label}>YOUR TICKETS · LAST {info?.historyDays ?? 7} DAYS</div>
              {tickets.map((t) => (
                <TicketCard key={t.ticketId} ticket={t} topics={info?.topics || []} expanded={expanded === t.ticketId} onToggle={() => setExpanded(expanded === t.ticketId ? null : t.ticketId)} />
              ))}
            </div>
          )}

          <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center', lineHeight: 1.5 }}>
            🔒 Our support team never asks for your OTP, password or money, and never sends a payment link. Only chat with the Telegram account shown on your ticket.
          </div>
        </div>
      </div>
    </>
  );
};

const SupportPage: React.FC = () => {
  const navigate = useNavigate();
  const [links, setLinks] = useState<SupportLinks | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  // A ticket belongs to an account: signed out, the button asks them to sign in.
  const { isAuthenticated, openAuth } = useShell();

  useEffect(() => {
    (backend as any).getSupportLinks?.()
      .then((data: any) => {
        // A THIRD hand-written list of these fields lived here, and it named
        // seven. Every field it forgot was unreachable no matter what an admin
        // set. Take what the server sent and coerce the shape, so a field added
        // to the spec arrives without an edit here (§5: two builders of one
        // payload are one bug waiting for the next field).
        const d = data?.links ?? data;
        if (d) {
          const str = (v: unknown) => (typeof v === 'string' ? v : '');
          setLinks({
            ...(d as SupportLinks),
            whatsapp: str(d.whatsapp),
            // `telegram` is the legacy single field; the username supersedes it
            // and either may be the one an operator filled in.
            telegram: str(d.telegram) || str(d.telegramUsername),
            telegramUsername: str(d.telegramUsername),
            telegramGroupUrl: str(d.telegramGroupUrl),
            telegramChannelUrl: str(d.telegramChannelUrl),
            instagram: str(d.instagram),
            youtube: str(d.youtube),
            email: str(d.email),
            phone: str(d.phone),
            helpCenterUrl: str(d.helpCenterUrl),
            termsUrl: str(d.termsUrl),
            privacyUrl: str(d.privacyUrl),
          });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const channels = links ? [
    links.whatsapp && { icon: '💬', label: 'WhatsApp', sub: 'Chat with Support', href: `https://wa.me/${links.whatsapp.replace(/\D/g, '')}`, tag: '9am–11pm', tagBg: 'var(--green)' },
    links.telegram && { icon: '✈️', label: 'Telegram', sub: 'Message support', href: links.telegram.startsWith('http') ? links.telegram : `https://t.me/${links.telegram.replace('@', '')}`, tag: 'Fast', tagBg: 'var(--bombay)' },
    links.telegramGroupUrl && { icon: '👥', label: 'Telegram Group', sub: 'Join the community', href: links.telegramGroupUrl, tag: 'Community', tagBg: 'var(--bombay)' },
    links.telegramChannelUrl && { icon: '📢', label: 'Telegram Channel', sub: 'Announcements', href: links.telegramChannelUrl, tag: 'News', tagBg: 'var(--bombay)' },
    links.instagram && { icon: '📸', label: 'Instagram', sub: 'Follow us', href: links.instagram.startsWith('http') ? links.instagram : `https://instagram.com/${links.instagram.replace('@', '')}`, tag: 'Follow', tagBg: '#E1306C' },
    links.youtube && { icon: '▶️', label: 'YouTube', sub: 'Watch tutorials', href: links.youtube, tag: 'Watch', tagBg: 'var(--red)' },
    links.email && { icon: '📧', label: 'Email', sub: links.email, href: `mailto:${links.email}`, tag: '~24h', tagBg: 'var(--text3)' },
    links.phone && { icon: '📞', label: 'Phone', sub: links.phone, href: `tel:${links.phone.replace(/[^\d+]/g, '')}`, tag: 'Call', tagBg: 'var(--green)' },
    links.helpCenterUrl && { icon: '📚', label: 'Help Centre', sub: 'Guides and answers', href: links.helpCenterUrl, tag: 'Read', tagBg: 'var(--text3)' },
  ].filter(Boolean) as Array<{ icon: string; label: string; sub: string; href: string; tag: string; tagBg: string }> : [];

  return (
    <ScreenShell icon="🛟" title="Support" sub="We are here to help">
      <button onClick={() => (isAuthenticated ? setChatOpen(true) : openAuth())} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 13, padding: 16, borderRadius: 16, border: 'none', cursor: 'pointer', textAlign: 'left', background: 'var(--gold-metal)', color: 'var(--on-gold)', boxShadow: '0 10px 26px -10px var(--glow)', marginBottom: 14 }}>
        <span style={{ fontSize: 24 }}>💬</span>
        <span style={{ flex: 1 }}><span className="font-grotesk" style={{ display: 'block', fontWeight: 700, fontSize: 16 }}>Get help</span><span style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: .75 }}>{isAuthenticated ? 'Open a ticket · chat with us on Telegram' : 'Sign in to open a support ticket'}</span></span>
        <span style={{ fontSize: 18 }}>›</span>
      </button>

      {loading && <div style={{ textAlign: 'center', padding: 24, color: 'var(--text3)', fontSize: 12 }}>Loading support contacts…</div>}
      {!loading && channels.length === 0 && (
        <div style={{ ...card, textAlign: 'center', padding: '28px 16px' }}><div style={{ fontSize: 34, marginBottom: 8 }}>📭</div><div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Support contacts not configured</div><div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>Please check back later.</div></div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10 }}>
        {channels.map((c, i) => (
          <a key={i} href={c.href} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 12, ...card, padding: 14, textDecoration: 'none' }}>
            <span style={{ width: 40, height: 40, flex: 'none', borderRadius: 11, background: 'var(--surface3)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19 }}>{c.icon}</span>
            <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{c.label}</span><span style={{ display: 'block', fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.sub}</span></span>
            <span style={{ fontSize: 9, fontWeight: 800, padding: '4px 9px', borderRadius: 999, color: '#fff', background: c.tagBg }}>{c.tag}</span>
          </a>
        ))}
      </div>

      <div style={{ ...card, marginTop: 14, textAlign: 'center' }}>
        <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>Support available <b style={{ color: 'var(--text2)' }}>9 AM – 11 PM IST</b>, 7 days a week.</p>
      </div>
      <button onClick={() => navigate('/faq')} style={{ width: '100%', marginTop: 12, background: 'color-mix(in srgb,var(--gold) 10%,transparent)', border: '1px solid var(--line2)', borderRadius: 14, padding: 14, color: 'var(--gold-ink)', fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>❓ View FAQ / Help Articles</button>

      {chatOpen && <SupportDesk onClose={() => setChatOpen(false)} />}
    </ScreenShell>
  );
};

export default SupportPage;
