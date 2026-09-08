// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * SettlementRail.tsx — the one button that moves the platform between rails.
 *
 * Admin UI for backend/domains/configuration/paymentMode.{service,admin.routes}.js.
 * Sibling of DepositPolicy in the Business Policy Platform, and versioned the
 * same way: each save IS a version, exactly one is ACTIVE, and a switch back is
 * a new version rather than an edit — so an auditor can always answer "what was
 * in force at time T".
 *
 * ── What this screen must make impossible to get wrong ──────────────────────
 * Switching the rail changes the workflow every merchant performs. The two
 * things an admin most needs to see before pressing it are therefore stated on
 * the screen itself, not in a runbook:
 *
 *   • what the new rail asks of a merchant, in the same words the merchant's
 *     own notification will use — read from the API rather than duplicated
 *     here, because a copy that drifts is worse than no copy; and
 *   • that orders already in flight are NOT affected. That is the question
 *     every operator asks at this button, and the answer is enforced by a
 *     database trigger.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeftRight, History as HistoryIcon, Info, RefreshCw, Save, Timer,
} from 'lucide-react';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { Toolbar } from '../../components/design';
import { paymentMode as paymentModeApi } from '../../services/api';
import type { PaymentModePolicy, PaymentModeOption, PaymentMode } from '../../types';
import toast from 'react-hot-toast';

/**
 * The timers, with the label an operator reads and the rail each one belongs
 * to. `both` means the window applies whichever rail is live.
 *
 * Keyed by the API's own field names so the form posts exactly what the server
 * accepts — the server refuses an unknown timer by name rather than silently
 * dropping it, and a label table with its own key spellings is how the two
 * drift apart.
 */
const TIMERS: Array<{ key: keyof PaymentModePolicy & string; label: string; help: string; rail: 'both' | PaymentMode }> = [
  { key: 'assignmentWaitSeconds',   label: 'Assignment wait',   help: 'How long an unassigned order waits for a merchant before it fails.', rail: 'both' },
  { key: 'processingWindowSeconds', label: 'Processing window', help: 'How long an assigned merchant has to act.', rail: 'both' },
  { key: 'utrSubmitSeconds',        label: 'UTR submit window', help: 'How long the player has to submit the UTR after clicking Paid.', rail: 'both' },
  { key: 'disputeWindowSeconds',    label: 'Dispute window',    help: 'How long a merchant assertion is frozen before it settles. Silence completes the order.', rail: 'both' },
  { key: 'linkExpirySeconds',       label: 'ATM link lifetime', help: 'How long a scanned ATM cash link stays valid.', rail: 'CASH_ATM' },
  { key: 'linkMinRemainingSeconds', label: 'ATM link floor',    help: 'A link with less than this remaining is not handed to a player — they could not reach the machine in time. Must be less than the lifetime.', rail: 'CASH_ATM' },
];

const secondsLabel = (n: number) => {
  if (!Number.isFinite(n)) return '—';
  if (n % 60 === 0 && n >= 60) return `${n / 60} min`;
  return `${n} s`;
};

export const SettlementRail: React.FC = () => {
  const [policy, setPolicy] = useState<PaymentModePolicy | null>(null);
  const [modes, setModes] = useState<PaymentModeOption[]>([]);
  const [history, setHistory] = useState<PaymentModePolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [targetMode, setTargetMode] = useState<PaymentMode | ''>('');
  const [timers, setTimers] = useState<Record<string, string>>({});
  const [justification, setJustification] = useState('');
  const [confirming, setConfirming] = useState(false);

  const seedForm = useCallback((p: PaymentModePolicy | null) => {
    if (!p) return;
    setTargetMode(p.activeMode);
    const next: Record<string, string> = {};
    for (const t of TIMERS) next[t.key] = String(p[t.key] ?? '');
    setTimers(next);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [current, past] = await Promise.all([
        paymentModeApi.getCurrent(),
        paymentModeApi.getHistory(50),
      ]);
      setPolicy(current.policy ?? null);
      setModes(current.modes ?? []);
      setHistory(past.history ?? []);
      seedForm(current.policy ?? null);
    } catch {
      toast.error('Could not load the settlement rail.');
    } finally {
      setLoading(false);
    }
  }, [seedForm]);

  useEffect(() => { void load(); }, [load]);

  const railChanging = Boolean(policy && targetMode && targetMode !== policy.activeMode);

  // Only the timers the operator actually changed are sent. Posting every field
  // every time would make an unrelated edit look like a deliberate change to
  // each one in the audit record.
  const changedTimers = (): Record<string, number> => {
    const out: Record<string, number> = {};
    if (!policy) return out;
    for (const t of TIMERS) {
      const raw = timers[t.key];
      if (raw === undefined || raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      if (value !== Number(policy[t.key])) out[t.key] = Math.trunc(value);
    }
    return out;
  };

  const dirty = railChanging || Object.keys(changedTimers()).length > 0;

  const save = async () => {
    setSaving(true);
    try {
      const body: { activeMode?: string; timers?: Record<string, number>; justification: string } = {
        justification: justification.trim(),
      };
      if (railChanging) body.activeMode = targetMode as string;
      const t = changedTimers();
      if (Object.keys(t).length) body.timers = t;

      await paymentModeApi.update(body);
      toast.success(railChanging ? 'Settlement rail switched. Every merchant has been told.' : 'Timers updated.');
      setJustification('');
      setConfirming(false);
      await load();
    } catch (err: any) {
      // The server refuses with a NAMED reason — "that timer is zero", "no link
      // would ever be assignable" — and each is something the operator can act
      // on. Showing a generic failure would throw that away.
      toast.error(err?.response?.data?.message || 'Could not change the settlement rail.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSpinner />;
  if (!policy) {
    return (
      <EmptyState
        icon={ArrowLeftRight}
        title="No settlement rail configured"
        description="The platform has no active payment mode policy."
      />
    );
  }

  const activeCopy = modes.find((m) => m.mode === policy.activeMode);
  const targetCopy = modes.find((m) => m.mode === targetMode);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <header>
        <h1 style={{ margin: 0 }}>Settlement rail</h1>
        <p style={{ color: 'var(--muted)', margin: '4px 0 0' }}>
          Version {policy.version} · in force since {new Date(policy.createdAt).toLocaleString()}
        </p>
      </header>
      <Toolbar actions={[{ label: 'Reload', icon: RefreshCw, onClick: () => void load() }]} />

      <section aria-labelledby="rail-current" style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 16 }}>
        <h2 id="rail-current" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 0 }}>
          <ArrowLeftRight size={18} /> In force now
        </h2>
        <p><strong>{activeCopy?.label ?? policy.activeMode}</strong></p>
        <p style={{ color: 'var(--muted, #666)' }}>{activeCopy?.merchantMessage}</p>
      </section>

      <section aria-labelledby="rail-switch" style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 16 }}>
        <h2 id="rail-switch" style={{ marginTop: 0 }}>Change the rail</h2>

        <div role="radiogroup" aria-label="Settlement rail" style={{ display: 'grid', gap: 8 }}>
          {modes.map((m) => (
            <label key={m.mode} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <input
                type="radio"
                name="settlement-rail"
                value={m.mode}
                checked={targetMode === m.mode}
                onChange={() => setTargetMode(m.mode)}
              />
              <span>
                <strong>{m.label}</strong>
                <br />
                <span style={{ color: 'var(--muted, #666)' }}>{m.merchantMessage}</span>
              </span>
            </label>
          ))}
        </div>

        {railChanging && (
          <p role="status" style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Info size={16} />
            <span>
              Orders already in flight keep the <strong>{activeCopy?.label ?? policy.activeMode}</strong> process
              they were created under. Both rails run side by side until the last of them settles.
            </span>
          </p>
        )}

        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Timer size={16} /> Timers</h3>
        <div style={{ display: 'grid', gap: 12 }}>
          {TIMERS.map((t) => (
            <div key={t.key}>
              <label htmlFor={`timer-${t.key}`}>
                {t.label}
                {t.rail !== 'both' && <span style={{ color: 'var(--muted, #666)' }}> · {t.rail === 'CASH_ATM' ? 'ATM cash rail only' : t.rail}</span>}
              </label>
              <input
                id={`timer-${t.key}`}
                type="number"
                min={1}
                step={1}
                value={timers[t.key] ?? ''}
                onChange={(e) => setTimers((prev) => ({ ...prev, [t.key]: e.target.value }))}
              />
              <span style={{ color: 'var(--muted, #666)' }}> currently {secondsLabel(Number(policy[t.key]))}</span>
              <p style={{ color: 'var(--muted, #666)', margin: '2px 0 0' }}>{t.help}</p>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 16 }}>
          <label htmlFor="rail-justification">Why (recorded against this version)</label>
          <textarea
            id="rail-justification"
            rows={3}
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder="Moving to ATM cash settlement while the UPI merchants are re-verified."
          />
        </div>

        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={saving || !dirty || !justification.trim()}
        >
          <Save size={16} /> {railChanging ? 'Switch the rail' : 'Save timers'}
        </button>
        {!justification.trim() && dirty && (
          <p role="note" style={{ color: 'var(--muted, #666)' }}>
            A reason is required — it is what a reviewer reads months from now.
          </p>
        )}
      </section>

      <section aria-labelledby="rail-history">
        <h2 id="rail-history" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <HistoryIcon size={18} /> Version history
        </h2>
        <DataTable
          data={history}
          currentPage={1}
          totalPages={1}
          onPageChange={() => {}}
          columns={[
            { key: 'version', label: 'Version', render: (v: PaymentModePolicy) => `v${v.version}` },
            { key: 'activeMode', label: 'Rail', render: (v: PaymentModePolicy) => modes.find((m) => m.mode === v.activeMode)?.label ?? v.activeMode },
            { key: 'status', label: 'Status', render: (v: PaymentModePolicy) => <StatusBadge status={v.status} /> },
            { key: 'changedByName', label: 'Changed by', render: (v: PaymentModePolicy) => v.changedByName || '—' },
            { key: 'justification', label: 'Why', render: (v: PaymentModePolicy) => v.justification },
            { key: 'createdAt', label: 'At', render: (v: PaymentModePolicy) => new Date(v.createdAt).toLocaleString() },
          ]}
        />
      </section>

      <ConfirmDialog
        isOpen={confirming}
        type={railChanging ? 'warning' : 'info'}
        title={railChanging ? `Switch to ${targetCopy?.label ?? targetMode}?` : 'Save these timers?'}
        message={
          railChanging
            ? `Every merchant will be told their workflow has changed. Orders already in flight keep the ${activeCopy?.label ?? policy.activeMode} process — they are not migrated.`
            : 'The new windows apply to orders created from now on.'
        }
        confirmText={railChanging ? 'Switch the rail' : 'Save'}
        onConfirm={() => void save()}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
};

export default SettlementRail;
