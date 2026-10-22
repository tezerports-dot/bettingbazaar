// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's payment accounts (owner, 2026-10-11 — Phase B).
 *
 *   UPI scanner   the merchant scans their shop's static UPI QR once (the
 *                 camera scanner the cash buy uses, `QrCamera`), then gives the
 *                 bank details behind it. A buy routed to it reaches the
 *                 player as a UPI link with the order's amount, built on the
 *                 server (playerOrderView.js).
 *   Bank account  holder, account number, IFSC, bank name.
 *
 * Each has two switches, Accept deposits and Pay withdrawals, and is ACTIVE or
 * PAUSED, or removed for good. Which order sizes go to which account is one
 * table, saved in one go (`SizesCard`, owner 2026-10-20): every size the
 * platform sends here must be ticked on at least one account, and the server
 * refuses a save that leaves one out (409 SIZES_UNCOVERED). Every write is the owner's
 * (merchantAccount.routes.js `ownerOnly`); a sub-member reads the list (they
 * name the account they paid a withdrawal from) and is offered no control.
 * Every refusal is the server's own sentence, announced (§32 S44).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Landmark, Pause, Pencil, Play, Plus, QrCode, RotateCcw, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../services/AuthContext';
import { api, type PaymentAccountInput } from '../../services/api';
import { useMerchantAccount } from '../../hooks/useMerchantAccount';
import { isOwner } from '../../utils/actor';
import { readStaticUpiLink, type StaticUpiReading } from '../../utils/cashLink';
import QrCamera, { type QrRead } from '../../components/QrCamera';
import {
  Banner, Button, Card, CardTitle, ConfirmDialog, EmptyState, Field, Skeleton, Toggle, inputStyle,
  type ConfirmRequest,
} from '../../components/ui';
import AccountShell, { Refusal } from './AccountShell';
import type { PaymentAccount, PaymentAccountKind, SizeCoverage } from '../../types';
import { formatMoney } from '../../utils/rail';

const KIND_LABEL: Record<PaymentAccountKind, string> = { UPI_QR: 'UPI scanner', BANK: 'Bank account' };

const errorText = (err: any, fallback: string): string => err?.message || fallback;

// ── The UPI QR scanner ──────────────────────────────────────────────────────

/**
 * Scan the shop's static UPI QR. What was read is said back (UPI ID and name)
 * before it is used; a QR the server would refuse (an amount in it, a mobile
 * number as the UPI ID) is refused here first, in the server's words.
 */
export const UpiQrScanner: React.FC<{
  open: boolean;
  onClose: () => void;
  onUse: (reading: Extract<StaticUpiReading, { ok: true }>) => void;
}> = ({ open, onClose, onUse }) => {
  const [reading, setReading] = useState<StaticUpiReading | null>(null);
  useEffect(() => { if (open) setReading(null); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  const onRead = (read: QrRead) => setReading('raw' in read ? readStaticUpiLink(read.raw) : { ok: false, message: read.error });

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="upi-qr-title"
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--overlay)', padding: 16 }}>
      <div style={{ width: 'min(94vw, 460px)', maxHeight: '94vh', overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <h2 id="upi-qr-title" style={{ margin: 0, fontSize: 17, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
            <QrCode size={18} /> Scan your UPI QR
          </h2>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 0, color: 'var(--muted)', cursor: 'pointer', padding: 4 }}>
            <X size={18} />
          </button>
        </div>
        <p style={{ margin: '8px 0 12px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2)' }}>
          Scan the static UPI QR your bank or UPI app gives your shop (one with no amount in it). Players
          pay it with each order&apos;s exact amount filled in.
        </p>

        {!reading && <QrCamera onRead={onRead} photoLabel="Photo of your UPI QR" />}

        {reading && !reading.ok && (
          <div role="alert"><Banner tone="danger" title="Not this QR">{reading.message}</Banner></div>
        )}
        {reading?.ok && (
          <div role="status" style={{ padding: '12px 14px', background: 'var(--dep-bg)', borderRadius: 12 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Players will pay</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>{reading.name}</div>
            <div className="bb-mono" style={{ fontSize: 12, color: 'var(--text-2)', wordBreak: 'break-all' }}>{reading.payee}</div>
          </div>
        )}
        {reading && (
          <div style={{ display: 'flex', gap: 9, marginTop: 12 }}>
            <Button variant="outline" onClick={() => setReading(null)}>
              <RotateCcw size={15} /> Scan again
            </Button>
            {reading.ok && (
              <Button tone="ok" style={{ flex: 1 }} onClick={() => { onUse(reading); onClose(); }}>
                Use this QR
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ── Add / edit ──────────────────────────────────────────────────────────────

interface FormState {
  label: string; holderName: string; accountNo: string; ifsc: string; bankName: string;
  acceptsDeposits: boolean; paysWithdrawals: boolean;
  upiLink: string; upiId: string; upiName: string;
}

const formFrom = (a?: PaymentAccount): FormState => ({
  label: a?.label ?? '', holderName: a?.holderName ?? '', accountNo: a?.accountNo ?? '',
  ifsc: a?.ifsc ?? '', bankName: a?.bankName ?? '',
  acceptsDeposits: a?.acceptsDeposits ?? true, paysWithdrawals: a?.paysWithdrawals ?? true,
  upiLink: '', upiId: a?.upiId ?? '', upiName: a?.upiName ?? '',
});

/**
 * One form for adding (kind chosen first) and editing (kind fixed: the server
 * never changes it). A UPI scanner needs a scanned QR before it can be added;
 * on an edit, scanning again replaces it, and not scanning keeps it.
 */
export const PaymentAccountForm: React.FC<{
  editing: PaymentAccount | null;
  kind: PaymentAccountKind;
  onDone: () => void;
  onCancel: () => void;
}> = ({ editing, kind, onDone, onCancel }) => {
  const [form, setForm] = useState<FormState>(() => formFrom(editing ?? undefined));
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const id = (name: string) => `pa-${editing?.accountId ?? 'new'}-${name}`;
  const upi = kind === 'UPI_QR';
  const needsScan = upi && !editing && !form.upiLink;

  const submit = async () => {
    setRefusal('');
    if (needsScan) { setRefusal('Scan your UPI QR first.'); return; }
    const body: PaymentAccountInput = {
      label: form.label, holderName: form.holderName, accountNo: form.accountNo,
      ifsc: form.ifsc, bankName: form.bankName,
      acceptsDeposits: form.acceptsDeposits, paysWithdrawals: form.paysWithdrawals,
      ...(upi && form.upiLink ? { upiLink: form.upiLink } : {}),
    };
    setBusy(true);
    try {
      if (editing) {
        await api.updatePaymentAccount(editing.accountId, body);
        toast.success('Account saved');
      } else {
        await api.addPaymentAccount({ ...body, kind });
        toast.success('Account added');
      }
      onDone();
    } catch (err) {
      setRefusal(errorText(err, 'Could not save the account.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardTitle
        title={editing ? `Edit ${editing.label}` : `Add a ${KIND_LABEL[kind].toLowerCase()}`}
        sub={upi ? 'Scan your UPI QR, then give the bank account it pays into.' : 'The bank account players transfer to and you pay from.'}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {upi && (
          <div style={{ padding: 12, background: 'var(--surface-2)', borderRadius: 12 }}>
            {form.upiId ? (
              <div role="status" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' }}>
                UPI QR: <b style={{ color: 'var(--text)' }}>{form.upiName}</b>{' '}
                <span className="bb-mono">{form.upiId}</span>
                {form.upiLink ? ' (newly scanned)' : ''}
              </div>
            ) : (
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>No UPI QR scanned yet.</div>
            )}
            <Button variant="outline" style={{ marginTop: 9 }} onClick={() => setScanning(true)}>
              <QrCode size={15} /> {form.upiId ? 'Scan again' : 'Scan your UPI QR'}
            </Button>
          </div>
        )}
        <Field label="Account label" htmlFor={id('label')} hint="Your own name for it, e.g. “Shop HDFC”.">
          <input id={id('label')} value={form.label} onChange={(e) => set({ label: e.target.value })} style={inputStyle} maxLength={60} />
        </Field>
        <Field label="Account holder name" htmlFor={id('holder')}>
          <input id={id('holder')} value={form.holderName} onChange={(e) => set({ holderName: e.target.value })} style={inputStyle} maxLength={100} />
        </Field>
        <Field label="Account number" htmlFor={id('number')}>
          <input id={id('number')} value={form.accountNo} inputMode="numeric" onChange={(e) => set({ accountNo: e.target.value })} style={inputStyle} />
        </Field>
        <Field label="IFSC" htmlFor={id('ifsc')}>
          <input id={id('ifsc')} value={form.ifsc} onChange={(e) => set({ ifsc: e.target.value.toUpperCase() })} style={inputStyle} />
        </Field>
        <Field label="Bank name" htmlFor={id('bank')}>
          <input id={id('bank')} value={form.bankName} onChange={(e) => set({ bankName: e.target.value })} style={inputStyle} maxLength={100} />
        </Field>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, fontWeight: 700 }}>
            <Toggle on={form.acceptsDeposits} label="Accept deposits" onChange={() => set({ acceptsDeposits: !form.acceptsDeposits })} />
            Accept deposits
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, fontWeight: 700 }}>
            <Toggle on={form.paysWithdrawals} label="Pay withdrawals" onChange={() => set({ paysWithdrawals: !form.paysWithdrawals })} />
            Pay withdrawals
          </span>
        </div>
        <Refusal message={refusal} />
        <div style={{ display: 'flex', gap: 9 }}>
          <Button variant="outline" tone="neutral" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => void submit()} busy={busy} style={{ flex: 1 }}>
            {editing ? 'Save account' : 'Add account'}
          </Button>
        </div>
      </div>
      <UpiQrScanner
        open={scanning}
        onClose={() => setScanning(false)}
        onUse={(r) => set({ upiLink: r.link, upiId: r.payee, upiName: r.name })}
      />
    </Card>
  );
};

// ── One account ─────────────────────────────────────────────────────────────

const AccountRow: React.FC<{
  account: PaymentAccount;
  owner: boolean;
  onEdit: (a: PaymentAccount) => void;
  onChanged: () => Promise<void>;
  onConfirm: (r: ConfirmRequest) => void;
}> = ({ account, owner, onEdit, onChanged, onConfirm }) => {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');
  const paused = account.status === 'PAUSED';

  const patch = async (body: PaymentAccountInput, ok: string) => {
    setBusy(true); setRefusal('');
    try {
      await api.updatePaymentAccount(account.accountId, body);
      toast.success(ok);
      await onChanged();
    } catch (err) {
      setRefusal(errorText(err, 'Could not save the account.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = () => onConfirm({
    title: `Remove ${account.label}?`,
    body: 'It stops taking deposits and paying withdrawals for good, and is unassigned from every sub-member. Orders that name it keep naming it.',
    confirmLabel: 'Remove account',
    tone: 'danger',
    onConfirm: async () => {
      try {
        await api.removePaymentAccount(account.accountId);
        toast.success('Account removed');
        await onChanged();
      } catch (err) {
        setRefusal(errorText(err, 'Could not remove the account.'));
      }
    },
  });

  const yesNo = (v: boolean) => (v ? 'Yes' : 'No');

  return (
    <Card style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text)' }}>{account.label}</span>
            <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 7px', borderRadius: 6, color: 'var(--brand)', background: 'var(--brand-bg)' }}>
              {KIND_LABEL[account.kind]}
            </span>
            <span style={{
              fontSize: 10.5, fontWeight: 800, padding: '2px 7px', borderRadius: 6,
              color: paused ? 'var(--warn)' : 'var(--ok)', background: paused ? 'var(--warn-bg)' : 'var(--ok-bg)',
            }}>
              {paused ? 'Paused' : 'Active'}
            </span>
          </div>
          {account.kind === 'UPI_QR' && account.upiId && (
            <div className="bb-mono" style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
              UPI: {account.upiName} · {account.upiId}
            </div>
          )}
          <div className="bb-mono" style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3 }}>
            {account.holderName} · {account.accountNo} · {account.ifsc} · {account.bankName}
          </div>
        </div>
        {owner && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <Button variant="outline" tone="neutral" title="Edit" onClick={() => onEdit(account)} style={{ padding: '8px 10px' }}>
              <Pencil size={14} /> Edit
            </Button>
          </div>
        )}
      </div>

      {owner ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18, marginTop: 12 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, fontWeight: 700 }}>
            <Toggle on={account.acceptsDeposits} label={`Accept deposits on ${account.label}`}
              onChange={() => void patch({ acceptsDeposits: !account.acceptsDeposits },
                account.acceptsDeposits ? 'No longer accepting deposits here' : 'Accepting deposits here')} />
            Accept deposits
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, fontWeight: 700 }}>
            <Toggle on={account.paysWithdrawals} label={`Pay withdrawals from ${account.label}`}
              onChange={() => void patch({ paysWithdrawals: !account.paysWithdrawals },
                account.paysWithdrawals ? 'No longer paying withdrawals from here' : 'Paying withdrawals from here')} />
            Pay withdrawals
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Button variant="outline" tone={paused ? 'ok' : 'neutral'} busy={busy} style={{ padding: '8px 11px' }}
              onClick={() => void patch({ status: paused ? 'ACTIVE' : 'PAUSED' }, paused ? 'Account resumed' : 'Account paused')}>
              {paused ? <><Play size={14} /> Resume</> : <><Pause size={14} /> Pause</>}
            </Button>
            <Button variant="outline" tone="danger" style={{ padding: '8px 11px' }} onClick={remove}>
              <Trash2 size={14} /> Remove
            </Button>
          </span>
        </div>
      ) : (
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginTop: 10 }}>
          Accepts deposits: {yesNo(account.acceptsDeposits)} · Pays withdrawals: {yesNo(account.paysWithdrawals)}
        </div>
      )}
      <Refusal message={refusal} style={{ marginTop: 10 }} />
    </Card>
  );
};

// ── Which sizes go to which account ─────────────────────────────────────────

type Direction = 'DEPOSIT' | 'WITHDRAWAL';
type Picks = Record<string, { buySizes: number[]; sellSizes: number[] }>;

const DIRECTIONS: Array<{ key: Direction; title: string; sub: string; field: 'buySizes' | 'sellSizes'; on: (a: PaymentAccount) => boolean; tone: string; bg: string }> = [
  { key: 'DEPOSIT', title: 'Buys paid into', sub: 'A player buying this size pays into the ticked account.', field: 'buySizes',
    on: (a) => a.acceptsDeposits, tone: 'var(--dep)', bg: 'var(--dep-bg)' },
  { key: 'WITHDRAWAL', title: 'Sells paid from', sub: 'You pay a player selling this size from a ticked account.', field: 'sellSizes',
    on: (a) => a.paysWithdrawals, tone: 'var(--wd)', bg: 'var(--wd-bg)' },
];

const picksOf = (accounts: PaymentAccount[]): Picks =>
  Object.fromEntries(accounts.map((a) => [a.accountId, { buySizes: [...a.buySizes], sellSizes: [...a.sellSizes] }]));

/**
 * One table per direction: a row per size the platform sends here, a column
 * per account switched on for that direction, a tick where that size goes.
 * A size with no tick is shown in red and the save is refused by the server
 * until it has one; what the server says is shown as it says it.
 */
export const SizesCard: React.FC<{
  accounts: PaymentAccount[];
  sizes: SizeCoverage;
  owner: boolean;
  onSaved: () => Promise<void>;
}> = ({ accounts, sizes, owner, onSaved }) => {
  const live = useMemo(() => accounts.filter((a) => a.status !== 'REMOVED'), [accounts]);
  const [picks, setPicks] = useState<Picks>(() => picksOf(live));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');
  useEffect(() => { setPicks(picksOf(live)); }, [live]);

  const toggle = (accountId: string, field: 'buySizes' | 'sellSizes', size: number) => setPicks((p) => {
    const now = p[accountId]?.[field] ?? [];
    const next = now.includes(size) ? now.filter((n) => n !== size) : [...now, size].sort((a, b) => a - b);
    return { ...p, [accountId]: { ...p[accountId], [field]: next } };
  });
  const missing = (d: (typeof DIRECTIONS)[number]) => sizes.required[d.key].filter((size) =>
    !live.some((a) => d.on(a) && (picks[a.accountId]?.[d.field] ?? []).includes(size)));
  const gaps = DIRECTIONS.flatMap((d) => missing(d).map((size) => `${d.key === 'DEPOSIT' ? 'buy' : 'sell'} ${formatMoney(size)}`));
  const dirty = live.some((a) => JSON.stringify(picks[a.accountId]) !== JSON.stringify({ buySizes: a.buySizes, sellSizes: a.sellSizes }));

  const save = async () => {
    setBusy(true); setRefusal('');
    try {
      await api.setPaymentAccountSizes(live.map((a) => ({ accountId: a.accountId, ...picks[a.accountId] })));
      toast.success('Sizes saved');
      await onSaved();
    } catch (err) {
      setRefusal(errorText(err, 'Could not save the sizes.'));
    } finally {
      setBusy(false);
    }
  };

  if (live.length === 0) return null;
  const anyRequired = sizes.required.DEPOSIT.length + sizes.required.WITHDRAWAL.length > 0;
  return (
    <Card>
      <CardTitle
        title="Which sizes go to which account"
        sub="Every size must be ticked on at least one account, buys and sells both. Tick a size on more than one account to share it."
      />
      {!anyRequired && (
        <div role="status" style={{ fontSize: 12.5, color: 'var(--muted)' }}>The platform sends no order sizes to merchant accounts right now.</div>
      )}
      {gaps.length > 0 && (
        <div role="alert" style={{ marginBottom: 12 }}>
          <Banner tone="danger" title="Some sizes have no account">
            Nothing takes {gaps.join(', ')} yet. Orders of a size with no account are not sent to you.
          </Banner>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {DIRECTIONS.filter((d) => sizes.required[d.key].length > 0).map((d) => {
          const columns = live.filter(d.on);
          const gap = missing(d);
          return (
            <div key={d.key} style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12.5, minWidth: 320 }}>
                <caption style={{ textAlign: 'left', padding: '0 0 8px' }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: d.tone }}>{d.title}</span>
                  <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>{d.sub}</span>
                </caption>
                <thead>
                  <tr style={{ background: d.bg }}>
                    <th scope="col" style={{ textAlign: 'left', padding: '9px 12px', color: d.tone, borderRadius: '10px 0 0 10px' }}>Size</th>
                    {columns.map((a, i) => (
                      <th key={a.accountId} scope="col" style={{ padding: '9px 12px', color: 'var(--text)', textAlign: 'center', whiteSpace: 'nowrap',
                        borderRadius: i === columns.length - 1 ? '0 10px 10px 0' : 0 }}>
                        {a.label}{a.status === 'PAUSED' ? ' (paused)' : ''}
                      </th>
                    ))}
                    {columns.length === 0 && <th scope="col" style={{ padding: '9px 12px', borderRadius: '0 10px 10px 0' }} />}
                  </tr>
                </thead>
                <tbody>
                  {sizes.required[d.key].map((size) => {
                    const left = gap.includes(size);
                    return (
                      <tr key={size} style={{ background: left ? 'var(--danger-bg)' : undefined }}>
                        <th scope="row" className="bb-mono" style={{ textAlign: 'left', padding: '9px 12px', borderBottom: '1px solid var(--border-2)',
                          color: left ? 'var(--danger)' : 'var(--text)' }}>
                          {formatMoney(size)}{left ? ' · no account' : ''}
                        </th>
                        {columns.map((a) => {
                          const on = (picks[a.accountId]?.[d.field] ?? []).includes(size);
                          const id = `size-${d.key}-${a.accountId}-${size}`;
                          return (
                            <td key={a.accountId} style={{ textAlign: 'center', padding: '6px 12px', borderBottom: '1px solid var(--border-2)' }}>
                              <input id={id} type="checkbox" checked={on} disabled={!owner || busy}
                                aria-label={`${d.key === 'DEPOSIT' ? 'Buys' : 'Sells'} of ${formatMoney(size)} on ${a.label}`}
                                onChange={() => toggle(a.accountId, d.field, size)}
                                style={{ width: 18, height: 18, accentColor: d.tone, cursor: owner ? 'pointer' : 'default' }} />
                            </td>
                          );
                        })}
                        {columns.length === 0 && (
                          <td style={{ padding: '9px 12px', color: 'var(--muted)', borderBottom: '1px solid var(--border-2)' }}>
                            Switch an account on for {d.key === 'DEPOSIT' ? 'deposits' : 'withdrawals'} first.
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
      <Refusal message={refusal} style={{ marginTop: 10 }} />
      {owner && anyRequired && (
        <div style={{ display: 'flex', gap: 9, marginTop: 12, justifyContent: 'flex-end' }}>
          <Button variant="outline" tone="neutral" disabled={!dirty || busy} onClick={() => { setPicks(picksOf(live)); setRefusal(''); }}>Undo</Button>
          <Button onClick={() => void save()} busy={busy} disabled={!dirty}>Save sizes</Button>
        </div>
      )}
    </Card>
  );
};

// ── The screen ──────────────────────────────────────────────────────────────

const PaymentAccountsBody: React.FC = () => {
  const { merchant } = useAuth();
  const owner = isOwner(merchant);
  const { overview, state, error, reload } = useMerchantAccount();
  const [adding, setAdding] = useState<PaymentAccountKind | null>(null);
  const [editing, setEditing] = useState<PaymentAccount | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  if (state === 'loading') return <Skeleton height={180} />;
  if (state === 'error') return <Refusal message={error} />;
  const accounts = overview?.accounts ?? [];
  const done = async () => { setAdding(null); setEditing(null); await reload(); };

  return (
    <>
      {owner && !adding && !editing && (
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
          <Button onClick={() => setAdding('UPI_QR')}><QrCode size={15} /> Add a UPI scanner</Button>
          <Button variant="outline" onClick={() => setAdding('BANK')}><Plus size={15} /> Add a bank account</Button>
        </div>
      )}
      {!owner && (
        <Banner tone="info">The account owner adds, edits and pauses these. You see them to name the account you paid from.</Banner>
      )}
      {(adding || editing) && (
        <PaymentAccountForm
          key={editing?.accountId ?? `new-${adding}`}
          editing={editing}
          kind={editing?.kind ?? adding ?? 'BANK'}
          onDone={() => void done()}
          onCancel={() => { setAdding(null); setEditing(null); }}
        />
      )}
      {accounts.length === 0 ? (
        <EmptyState
          title="No payment accounts yet"
          body={owner ? 'Add a UPI scanner or a bank account. Deposits are routed to you only once one accepts deposits.' : 'The owner has not added any yet.'}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {accounts.map((a) => (
            <AccountRow key={a.accountId} account={a} owner={owner} onEdit={(x) => { setAdding(null); setEditing(x); }}
              onChanged={reload} onConfirm={setConfirm} />
          ))}
        </div>
      )}
      {overview?.sizes && <SizesCard accounts={accounts} sizes={overview.sizes} owner={owner} onSaved={reload} />}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
};

const PaymentAccountsPage: React.FC = () => (
  <AccountShell>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
      <Landmark size={18} /> Payment accounts
    </div>
    <PaymentAccountsBody />
  </AccountShell>
);

export default PaymentAccountsPage;
