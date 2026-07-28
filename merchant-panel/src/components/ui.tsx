// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Merchant panel design-system primitives, ported from the handoff
// "BB Merchant Panel.dc.html". Presentation only — no data fetching, no
// business rules. Every colour is a token from src/index.css (GOVERNANCE §3:
// never a hex literal in a component).
import React, { useEffect, useState } from 'react';
import { Copy, Check, X, AlertTriangle, RefreshCw, Inbox } from 'lucide-react';
import toast from 'react-hot-toast';
import { OrderStatus } from '../types';

// ── Card ────────────────────────────────────────────────────────────────────
export const cardStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  boxShadow: 'var(--shadow)',
};

export const Card: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}> = ({ children, style, className }) => (
  <div className={className} style={{ ...cardStyle, padding: 18, ...style }}>
    {children}
  </div>
);

export const CardTitle: React.FC<{ title: string; sub?: string; action?: React.ReactNode }> = ({
  title, sub, action,
}) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: sub ? 14 : 15 }}>
    <div>
      <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>{title}</div>
      {sub && <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
    </div>
    {action}
  </div>
);

// ── Status vocabulary ───────────────────────────────────────────────────────
// One tone per P2POrder.status (GOVERNANCE §1 owns the enum; this maps it to
// the design's universal status colours).
interface StatusMeta { label: string; color: string; bg: string; }

const STATUS_META: Record<string, StatusMeta> = {
  [OrderStatus.PENDING_QUEUE]: { label: 'In queue',        color: 'var(--muted)',   bg: 'var(--surface-2)' },
  [OrderStatus.ASSIGNED]:      { label: 'Assigned',        color: 'var(--info)',    bg: 'var(--info-bg)' },
  [OrderStatus.PROCESSING]:    { label: 'Processing',      color: 'var(--warn)',    bg: 'var(--warn-bg)' },
  [OrderStatus.PAID]:          { label: 'Payment claimed', color: 'var(--dep)',     bg: 'var(--dep-bg)' },
  [OrderStatus.COMPLETED]:     { label: 'Completed',       color: 'var(--ok)',      bg: 'var(--ok-bg)' },
  [OrderStatus.DISPUTED]:      { label: 'Disputed',        color: 'var(--dispute)', bg: 'var(--dispute-bg)' },
  [OrderStatus.REJECTED]:      { label: 'Rejected',        color: 'var(--danger)',  bg: 'var(--danger-bg)' },
  [OrderStatus.CANCELLED]:     { label: 'Cancelled',       color: 'var(--muted)',   bg: 'var(--surface-2)' },
  [OrderStatus.FAILED]:        { label: 'Failed',          color: 'var(--danger)',  bg: 'var(--danger-bg)' },
};

export function statusMeta(status?: string): StatusMeta {
  return STATUS_META[status || ''] || STATUS_META[OrderStatus.CANCELLED];
}

export const StatusPill: React.FC<{ status?: string; style?: React.CSSProperties }> = ({ status, style }) => {
  const meta = statusMeta(status);
  return (
    <span
      style={{
        padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 800,
        color: meta.color, background: meta.bg, whiteSpace: 'nowrap', ...style,
      }}
    >
      {meta.label}
    </span>
  );
};

// ── Buttons ─────────────────────────────────────────────────────────────────
export type ButtonTone = 'brand' | 'ok' | 'danger' | 'dispute' | 'neutral';

const TONE_COLOR: Record<ButtonTone, string> = {
  brand: 'var(--brand)', ok: 'var(--ok)', danger: 'var(--danger)',
  dispute: 'var(--dispute)', neutral: 'var(--text-2)',
};

export const Button: React.FC<{
  children: React.ReactNode;
  onClick?: () => void;
  tone?: ButtonTone;
  variant?: 'solid' | 'outline' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  full?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  style?: React.CSSProperties;
}> = ({ children, onClick, tone = 'brand', variant = 'solid', disabled, busy, full, title, type = 'button', style }) => {
  const color = TONE_COLOR[tone];
  const base: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '12px 16px', borderRadius: 12, fontSize: 13.5, fontWeight: 700,
    cursor: disabled || busy ? 'not-allowed' : 'pointer', opacity: disabled || busy ? 0.6 : 1,
    width: full ? '100%' : undefined, whiteSpace: 'nowrap',
    transition: 'background .15s ease, border-color .15s ease, opacity .15s ease',
  };
  const skin: React.CSSProperties =
    variant === 'solid'   ? { border: 0, background: color, color: '#fff' }
  : variant === 'outline' ? { border: `1px solid ${color}`, background: 'var(--surface)', color }
                          : { border: 0, background: 'transparent', color };
  return (
    <button type={type} title={title} disabled={disabled || busy} onClick={onClick} style={{ ...base, ...skin, ...style }}>
      {busy && <Spinner size={15} on={variant === 'solid' ? 'solid' : 'plain'} />}
      {children}
    </button>
  );
};

export const Spinner: React.FC<{ size?: number; on?: 'solid' | 'plain' }> = ({ size = 16, on = 'plain' }) => (
  <span
    aria-hidden
    style={{
      width: size, height: size, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
      border: `2px solid ${on === 'solid' ? 'rgba(255,255,255,.4)' : 'var(--border)'}`,
      borderTopColor: on === 'solid' ? '#fff' : 'var(--brand)',
      animation: 'bb-spin .7s linear infinite',
    }}
  />
);

// ── Inputs ──────────────────────────────────────────────────────────────────
export const inputStyle: React.CSSProperties = {
  width: '100%', padding: '11px 13px', borderRadius: 11,
  border: '1.5px solid var(--input-border)', background: 'var(--input-bg)',
  color: 'var(--text)', fontSize: 13.5, fontWeight: 600, outline: 'none',
};

export const Field: React.FC<{
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}> = ({ label, hint, error, children }) => (
  <div>
    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text-2)', marginBottom: 6 }}>
      {label}
    </label>
    {children}
    {error
      ? <p style={{ margin: '7px 0 0', fontSize: 11.5, fontWeight: 600, color: 'var(--danger)', lineHeight: 1.5 }}>{error}</p>
      : hint && <p style={{ margin: '7px 0 0', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', lineHeight: 1.5 }}>{hint}</p>}
  </div>
);

// ── Segmented control ───────────────────────────────────────────────────────
export interface Segment<T extends string> { value: T; label: string; title?: string; }

export function SegmentedControl<T extends string>({ value, options, onChange, style }: {
  value: T;
  options: Segment<T>[];
  onChange: (next: T) => void;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{
      display: 'flex', gap: 2, padding: 3, background: 'var(--surface-2)',
      border: '1px solid var(--border)', borderRadius: 11, ...style,
    }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            title={option.title}
            onClick={() => onChange(option.value)}
            style={{
              padding: '6px 11px', border: 0, borderRadius: 8, cursor: 'pointer',
              fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap',
              transition: 'background .15s ease, color .15s ease',
              background: active ? 'var(--surface)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-2)',
              boxShadow: active ? 'var(--shadow)' : 'none',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Toggle ──────────────────────────────────────────────────────────────────
export const Toggle: React.FC<{ on: boolean; onChange: () => void; label: string }> = ({ on, onChange, label }) => (
  <button
    role="switch"
    aria-checked={on}
    aria-label={label}
    onClick={onChange}
    style={{
      width: 44, height: 26, borderRadius: 14, border: 0, cursor: 'pointer', flexShrink: 0,
      background: on ? 'var(--ok)' : 'var(--border)', position: 'relative',
      transition: 'background .2s ease',
    }}
  >
    <span
      style={{
        position: 'absolute', top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: '50%',
        background: '#fff', transition: 'left .2s ease', boxShadow: '0 1px 3px rgba(0,0,0,.35)',
      }}
    />
  </button>
);

// ── Copy-to-clipboard ───────────────────────────────────────────────────────
export async function copyText(value: string, label: string): Promise<void> {
  const text = String(value ?? '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    // Clipboard is blocked on insecure origins and in some embedded webviews.
    toast.error(`Could not copy — select and copy the ${label.toLowerCase()} manually`);
  }
}

export const CopyRow: React.FC<{
  label: string;
  value: string;
  sub?: string;
  tone?: string;
  background?: string;
}> = ({ label, value, sub, tone = 'var(--brand)', background = 'var(--surface-2)' }) => (
  <button
    onClick={() => copyText(value, label)}
    style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px',
      background, border: '1px solid transparent', borderRadius: 12, cursor: 'pointer', textAlign: 'left',
    }}
  >
    <span style={{ flex: 1, minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: 10.5, fontWeight: 700, color: tone, textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {label}
      </span>
      <span className="bb-mono" style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </span>
      {sub && <span style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)' }}>{sub}</span>}
    </span>
    <Copy size={16} style={{ color: tone, flexShrink: 0 }} />
  </button>
);

export const CopyInline: React.FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone = 'var(--brand)' }) => (
  <button
    onClick={() => copyText(value, label)}
    style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
      padding: '10px 0', width: '100%', background: 'none', border: 0,
      borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
    }}
  >
    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', flexShrink: 0 }}>{label}</span>
    <span className="bb-mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      <Copy size={12} style={{ color: tone, flexShrink: 0 }} />
    </span>
  </button>
);

// ── Banners ─────────────────────────────────────────────────────────────────
export const Banner: React.FC<{
  tone: 'warn' | 'ok' | 'dep' | 'dispute' | 'danger' | 'info';
  title?: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ tone, title, children, icon, style }) => (
  <div style={{
    display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 13px',
    background: `var(--${tone}-bg)`, borderRadius: 12, ...style,
  }}>
    {icon ?? <AlertTriangle size={16} style={{ color: `var(--${tone})`, flexShrink: 0, marginTop: 1 }} />}
    <div style={{ minWidth: 0 }}>
      {title && <div style={{ fontSize: 12, fontWeight: 800, color: `var(--${tone})`, marginBottom: 2 }}>{title}</div>}
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>{children}</div>
    </div>
  </div>
);

// ── Empty / error / loading states ──────────────────────────────────────────
export const EmptyState: React.FC<{ title: string; body: string; action?: React.ReactNode }> = ({ title, body, action }) => (
  <div style={{
    background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 16,
    padding: '48px 24px', textAlign: 'center',
  }}>
    <span style={{
      width: 60, height: 60, borderRadius: 18, background: 'var(--dep-bg)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
    }}>
      <Inbox size={28} style={{ color: 'var(--dep)' }} />
    </span>
    <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 5 }}>{title}</div>
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', maxWidth: 320, margin: '0 auto 18px' }}>{body}</div>
    {action}
  </div>
);

export const ErrorState: React.FC<{ title: string; body: string; onRetry: () => void }> = ({ title, body, onRetry }) => (
  <div style={{ ...cardStyle, padding: '44px 24px', textAlign: 'center' }}>
    <span style={{
      width: 56, height: 56, borderRadius: 16, background: 'var(--danger-bg)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
    }}>
      <AlertTriangle size={26} style={{ color: 'var(--danger)' }} />
    </span>
    <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 5 }}>{title}</div>
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', marginBottom: 20, maxWidth: 340, marginLeft: 'auto', marginRight: 'auto' }}>
      {body}
    </div>
    <Button onClick={onRetry} style={{ display: 'inline-flex', margin: '0 auto' }}>
      <RefreshCw size={16} /> Retry
    </Button>
  </div>
);

export const Skeleton: React.FC<{ height: number | string; radius?: number }> = ({ height, radius = 16 }) => (
  <div className="bb-skeleton" style={{ height, borderRadius: radius }} />
);

// ── Modal / drawer plumbing ─────────────────────────────────────────────────
/** Closes on Escape and locks background scroll while open. */
export function useDismissable(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);
}

export const Overlay: React.FC<{ onClick: () => void; zIndex?: number }> = ({ onClick, zIndex = 40 }) => (
  <div
    onClick={onClick}
    style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex, animation: 'bb-fade .2s ease' }}
  />
);

/**
 * Panel — a right-side drawer on desktop, a bottom sheet on mobile. Used for
 * the order detail view; the design specifies both forms.
 */
export const Panel: React.FC<{
  open: boolean;
  onClose: () => void;
  isMobile: boolean;
  header: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ open, onClose, isMobile, header, footer, children }) => {
  useDismissable(open, onClose);
  if (!open) return null;
  const panelStyle: React.CSSProperties = isMobile
    ? {
        position: 'fixed', left: 0, right: 0, bottom: 0, top: '8%',
        borderRadius: '22px 22px 0 0', animation: 'bb-sheet .3s cubic-bezier(.4,0,.2,1)',
      }
    : {
        position: 'fixed', top: 0, bottom: 0, right: 0, width: 'min(460px, 100vw)',
        animation: 'bb-drawer .3s cubic-bezier(.4,0,.2,1)',
      };
  return (
    <>
      <Overlay onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        style={{
          ...panelStyle, background: 'var(--surface)', zIndex: 50, display: 'flex',
          flexDirection: 'column', boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
        }}
      >
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px',
          borderBottom: '1px solid var(--border)', background: 'var(--surface)',
        }}>
          {header}
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 34, height: 34, borderRadius: 10, border: '1px solid var(--border)',
              background: 'var(--surface)', color: 'var(--text-2)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >
            <X size={17} />
          </button>
        </div>
        <div className="bb-scroll" style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {children}
        </div>
        {footer && (
          <div style={{
            flexShrink: 0, display: 'flex', gap: 9, padding: '14px 18px',
            paddingBottom: 'calc(14px + env(safe-area-inset-bottom))',
            borderTop: '1px solid var(--border)', background: 'var(--surface)',
          }}>
            {footer}
          </div>
        )}
      </div>
    </>
  );
};

// ── Confirm dialog ──────────────────────────────────────────────────────────
export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  tone: ButtonTone;
  /** When set, the operator must type a reason before confirming. */
  reasonLabel?: string;
  onConfirm: (reason: string) => Promise<void> | void;
}

export const ConfirmDialog: React.FC<{ request: ConfirmRequest | null; onClose: () => void }> = ({ request, onClose }) => {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const open = !!request;

  useEffect(() => { setReason(''); setBusy(false); }, [request]);
  useDismissable(open, onClose);

  if (!request) return null;
  const needsReason = !!request.reasonLabel;

  const confirm = async () => {
    if (needsReason && !reason.trim()) {
      toast.error('Please add a reason');
      return;
    }
    setBusy(true);
    try {
      await request.onConfirm(reason.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 22,
        animation: 'bb-fade .18s ease',
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 380, background: 'var(--surface)', borderRadius: 18,
          boxShadow: 'var(--shadow-lg)', overflow: 'hidden', animation: 'bb-pop .2s ease',
        }}
      >
        <div style={{ padding: '22px 22px 18px' }}>
          <span style={{
            width: 44, height: 44, borderRadius: 12, marginBottom: 14,
            background: `var(--${request.tone === 'brand' ? 'brand' : request.tone}-bg)`,
            color: TONE_COLOR[request.tone],
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <AlertTriangle size={22} />
          </span>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text)', marginBottom: 6 }}>{request.title}</div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.55 }}>{request.body}</div>
          {needsReason && (
            <textarea
              value={reason}
              autoFocus
              onChange={(e) => setReason(e.target.value)}
              placeholder={request.reasonLabel}
              style={{ ...inputStyle, marginTop: 14, minHeight: 66, resize: 'none', fontSize: 13 }}
            />
          )}
        </div>
        <div style={{ display: 'flex', gap: 9, padding: '0 22px 22px' }}>
          <Button variant="outline" tone="neutral" onClick={onClose} style={{ flex: 1, borderColor: 'var(--border)', color: 'var(--text)' }}>
            Cancel
          </Button>
          <Button tone={request.tone} onClick={confirm} busy={busy} style={{ flex: 1 }}>
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};

// ── Misc ────────────────────────────────────────────────────────────────────
export const Avatar: React.FC<{ name?: string; size?: number }> = ({ name, size = 30 }) => (
  <span style={{
    width: size, height: size, borderRadius: '50%', flexShrink: 0,
    background: 'linear-gradient(135deg, var(--brand), var(--brand-ink))', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 700, fontSize: size * 0.4,
  }}>
    {(name || '?').trim().charAt(0).toUpperCase() || '?'}
  </span>
);

export const Logo: React.FC<{ size?: number; radius?: number }> = ({ size = 34, radius = 10 }) => (
  <div style={{
    width: size, height: size, borderRadius: radius, flexShrink: 0,
    background: 'linear-gradient(135deg, var(--brand), var(--brand-ink))',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 800, fontSize: size * 0.41, color: '#fff', letterSpacing: '-.5px',
  }}>
    BB
  </div>
);

export const Verified: React.FC<{ label: string }> = ({ label }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700,
    color: 'var(--ok)', background: 'var(--ok-bg)', padding: '3px 10px', borderRadius: 20,
  }}>
    <Check size={11} /> {label}
  </span>
);
