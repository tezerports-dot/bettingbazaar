// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Profile — design handoff "BB Merchant Panel.dc.html": performance, identity,
// payment details, order preferences and account status. A merchant holds no
// tokens — their team's pool does (PROJECT_STATUS §3.10) — so there is no
// wallet card here.
//
// The payment-details section is where an agent edits the bank account and
// UPI ID a UPI_BANK buy is paid into (CLAUDE.md §2 and §24). A merchant
// account is paid into its payment accounts, kept on Account › Payment
// accounts, so it has no such form here (owner, 2026-10-22). The figures are
// counted from the order rows (`bb_merchant_processed`, and the success rate
// from `bb_merchant_track_record`), so they match the orders. USDT buys are paid to the platform, never to a
// merchant (owner, 2026-10-18, CLAUDE.md §25), so there is no USDT address.
import React, { useEffect, useState } from 'react';
import { Edit3, LogOut, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../services/AuthContext';
import { availabilityOf } from '../utils/availability';
import { actorOf, isMerchantAccountSession, ROLE_LABEL } from '../utils/actor';
import { api } from '../services/api';
import { useViewport } from '../hooks/useViewport';
import { SUCCESS_MESSAGES } from '../constants';
import { formatTokens } from '../utils/rail';
import {
  Button, Card, CardTitle, Field, Toggle, Verified, cardStyle, copyText, inputStyle,
} from '../components/ui';

/**
 * A merchant account's SUB-MEMBER's profile (owner, 2026-10-11): their own
 * Telegram (every sign-in is approved there; `req.userId` is their own login),
 * who they are and their roles, and Log out. The account's identity, bank
 * details, preferences and online switch are the owner's (OWNER_ONLY), and the
 * owner's mobile is not theirs to see (CLAUDE.md §24), so none is shown.
 */
export const SubMemberProfile: React.FC = () => {
  const { merchant, logout } = useAuth();
  const actor = actorOf(merchant);
  if (actor.isOwner) return null;
  return (
    <div style={{ maxWidth: 840, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <CardTitle title="Signed in as a sub-member" sub={`Of the merchant account ${merchant?.username ?? ''}`.trim()} />
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>{actor.name}</div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)', marginTop: 4 }}>
          {actor.roles.map((r) => ROLE_LABEL[r]).join(' · ')}
        </div>
        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', lineHeight: 1.5, margin: '10px 0 0' }}>
          The account owner manages the profile, payment accounts and online status, and decides which
          accounts you work.
        </p>
        <Button variant="outline" tone="danger" full onClick={logout} style={{ marginTop: 14 }}>
          <LogOut size={16} /> Log out
        </Button>
      </Card>
    </div>
  );
};

const OwnerProfileSettings: React.FC = () => {
  const { merchant, logout, refreshProfile } = useAuth();
  const { isMobile } = useViewport();
  // Online, paused, or a supervisor with no switch at all: one helper (§5).
  const availability = availabilityOf(merchant);
  // A merchant account's payment details are its payment accounts (Account).
  const ownsPaymentDetails = !isMerchantAccountSession(merchant);

  const [editingPayment, setEditingPayment] = useState(false);
  const [savingPayment, setSavingPayment] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);

  const [form, setForm] = useState({
    accountHolderName: '',
    bankName: '',
    accountNo: '',
    ifsc: '',
    upiId: '',
  });

  const [prefs, setPrefs] = useState({ acceptsDeposits: true, acceptsWithdrawals: true });

  // Re-seed the forms whenever the profile changes, so an edit never starts
  // from values that have since been changed elsewhere (e.g. by an admin).
  useEffect(() => {
    if (!merchant) return;
    setForm({
      accountHolderName: merchant.bankDetails?.accountHolderName ?? merchant.settlementDetails?.accountName ?? '',
      bankName: merchant.bankDetails?.bankName ?? merchant.settlementDetails?.bankName ?? '',
      accountNo: merchant.bankDetails?.accountNo ?? merchant.settlementDetails?.accountNumber ?? '',
      ifsc: merchant.bankDetails?.ifsc ?? merchant.settlementDetails?.ifsc ?? '',
      upiId: merchant.upiId ?? '',
    });
    setPrefs({
      acceptsDeposits: merchant.acceptsDeposits ?? merchant.orderPreferences?.acceptDeposits ?? true,
      acceptsWithdrawals: merchant.acceptsWithdrawals ?? merchant.orderPreferences?.acceptWithdrawals ?? true,
    });
  }, [merchant]);

  const savePayment = async () => {
    setSavingPayment(true);
    try {
      await api.updateProfile({
        bankDetails: {
          accountHolderName: form.accountHolderName.trim(),
          bankName: form.bankName.trim(),
          accountNo: form.accountNo.trim(),
          ifsc: form.ifsc.trim().toUpperCase(),
        },
        upiId: form.upiId.trim(),
      });
      await refreshProfile();
      setEditingPayment(false);
      toast.success(SUCCESS_MESSAGES.PROFILE_UPDATED);
    } catch (error: any) {
      toast.error(error.message || 'Failed to update payment details');
    } finally {
      setSavingPayment(false);
    }
  };

  const savePrefs = async () => {
    setSavingPrefs(true);
    try {
      await api.updatePreferences(prefs);
      await refreshProfile();
      toast.success('Preferences saved');
    } catch (error: any) {
      toast.error(error.message || 'Failed to save preferences');
    } finally {
      setSavingPrefs(false);
    }
  };

  const perfColumns = isMobile ? '1fr 1fr' : 'repeat(auto-fit, minmax(140px, 1fr))';
  const twoColumns = isMobile ? '1fr' : '1fr 1fr';

  const accountAgeDays = merchant?.createdAt
    ? Math.max(0, Math.floor((Date.now() - new Date(merchant.createdAt).getTime()) / 86400000))
    : null;

  const maskedAccount = form.accountNo ? `••••••••${form.accountNo.slice(-4)}` : '—';

  const identityRow = (label: string, value: string, onCopy?: () => void, trailing?: React.ReactNode) => (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 12,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>{label}</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {value || '—'}
        </div>
      </div>
      {trailing ?? (onCopy && value ? (
        <button onClick={onCopy} style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)', background: 'none', border: 0, cursor: 'pointer', flexShrink: 0 }}>
          Copy
        </button>
      ) : null)}
    </div>
  );

  return (
    <div style={{ maxWidth: 840, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: isMobile ? 14 : 16 }}>
      {/* Account security first: the Telegram account every sign-in is
          approved from, and moving it. */}

      {/* Performance */}
      <Card>
        <CardTitle title="Merchant performance" />
        <div style={{ display: 'grid', gridTemplateColumns: perfColumns, gap: 11 }}>
          {[
            { label: 'Completed orders', value: merchant?.totalOrdersCompleted !== undefined ? String(merchant.totalOrdersCompleted) : '—', tone: 'var(--text)' },
            // TOKENS, counted from the order rows (`bb_merchant_processed`).
            { label: 'Deposits processed', value: merchant?.totalDepositAmount !== undefined ? formatTokens(merchant.totalDepositAmount) : '—', tone: 'var(--dep)' },
            { label: 'Withdrawals processed', value: merchant?.totalWithdrawalAmount !== undefined ? formatTokens(merchant.totalWithdrawalAmount) : '—', tone: 'var(--wd)' },
            // Decided orders that went right (owner, 2026-10-22: it belongs here, not on Home).
            {
              label: 'Success rate',
              value: typeof merchant?.successRate === 'number' ? `${(merchant.successRate * 100).toFixed(1)}%` : '—',
              tone: 'var(--ok)',
            },
            {
              label: 'Avg response',
              value: typeof merchant?.avgResponseMinutes === 'number' ? `${merchant.avgResponseMinutes.toFixed(1)} min` : '—',
              tone: 'var(--text)',
            },
          ].map((tile) => (
            <div key={tile.label} style={{ background: 'var(--surface-2)', borderRadius: 13, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{tile.label}</div>
              <div className="bb-mono" style={{ fontSize: 17, fontWeight: 700, color: tile.tone, marginTop: 4 }}>{tile.value}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Identity */}
      <Card>
        <CardTitle title="Profile information" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {identityRow('Username', merchant?.username || '')}
          {identityRow('Mobile', merchant?.mobile || '', () => copyText(merchant?.mobile || '', 'Mobile'))}
          {identityRow('Email', merchant?.email || '', () => copyText(merchant?.email || '', 'Email'))}
          {identityRow(
            'Account age',
            accountAgeDays === null ? '—' : `${accountAgeDays} days`,
            undefined,
            merchant?.status === 'ACTIVE' ? <Verified label="Active" /> : undefined
          )}
        </div>
      </Card>

      {/* Payment details: an agent's own; a merchant account's are on Account. */}
      {ownsPaymentDetails && (
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>Payment details</span>
            <span style={{
              fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 7, letterSpacing: '.03em',
              color: 'var(--brand)',
              background: 'var(--brand-bg)',
            }}>
              INR · bank account
            </span>
          </div>
          {!editingPayment && (
            <button
              onClick={() => setEditingPayment(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, color: 'var(--brand)', background: 'none', border: 0, cursor: 'pointer' }}
            >
              <Edit3 size={14} /> Edit
            </button>
          )}
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 15 }}>
          Users pay here for deposits · you receive settlements here
        </div>

        {!editingPayment && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {/* The bank account a player paying by bank transfer pays into,
                and the UPI ID a player paying by UPI is given a link from
                (owner, 2026-10-21; never a mobile, the server refuses one). */}
            <div style={{ padding: '14px 15px', background: 'var(--surface-2)', borderRadius: 13 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 9 }}>Bank settlement account</div>
              <div style={{ display: 'grid', gridTemplateColumns: twoColumns, gap: '9px 18px' }}>
                {[
                  { label: 'Holder', value: form.accountHolderName },
                  { label: 'Bank', value: form.bankName },
                  { label: 'Account no.', value: maskedAccount, mono: true },
                  { label: 'IFSC', value: form.ifsc, mono: true },
                  { label: 'UPI ID', value: form.upiId, mono: true },
                ].map((row) => (
                  <div key={row.label}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>{row.label}</div>
                    <div className={row.mono ? 'bb-mono' : undefined} style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>
                      {row.value || '—'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {editingPayment && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            <div style={{ display: 'grid', gridTemplateColumns: twoColumns, gap: 12 }}>
              <Field label="Account holder">
                <input value={form.accountHolderName} onChange={(e) => setForm((f) => ({ ...f, accountHolderName: e.target.value }))} style={inputStyle} />
              </Field>
              <Field label="Bank name">
                <input value={form.bankName} onChange={(e) => setForm((f) => ({ ...f, bankName: e.target.value }))} style={inputStyle} />
              </Field>
              <Field label="Account number">
                <input
                  value={form.accountNo}
                  onChange={(e) => setForm((f) => ({ ...f, accountNo: e.target.value }))}
                  inputMode="numeric"
                  className="bb-mono"
                  style={inputStyle}
                />
              </Field>
              <Field label="IFSC code">
                <input
                  value={form.ifsc}
                  onChange={(e) => setForm((f) => ({ ...f, ifsc: e.target.value.toUpperCase() }))}
                  autoCapitalize="characters"
                  className="bb-mono"
                  style={inputStyle}
                />
              </Field>
              <Field label="UPI ID (not your mobile number)">
                <input
                  value={form.upiId}
                  onChange={(e) => setForm((f) => ({ ...f, upiId: e.target.value }))}
                  autoCapitalize="none"
                  placeholder="name@okaxis"
                  className="bb-mono"
                  style={inputStyle}
                />
              </Field>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <Button onClick={savePayment} busy={savingPayment}>
                <Save size={15} /> Save payment details
              </Button>
              <Button variant="outline" tone="neutral" onClick={() => setEditingPayment(false)} style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Card>
      )}

      {/* Order preferences: a member's. A supervisor takes no orders (CLAUDE.md
          §2) and the server refuses the write (SUPERVISOR_TAKES_NO_ORDERS), so
          they are told so instead of being offered two switches. */}
      <Card>
        <CardTitle title="Order preferences" />
        {availability.supervisor ? (
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>
            You are a supervisor: you run teams and take no orders yourself, so there is nothing to choose
            here. Your agents choose which orders they take from their own accounts.
          </div>
        ) : (<>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { key: 'acceptsDeposits' as const, title: 'Accept deposit orders', sub: 'Receive deposit requests from users' },
              { key: 'acceptsWithdrawals' as const, title: 'Accept withdrawal orders', sub: 'Receive withdrawal requests from users' },
            ].map((row) => (
              <div key={row.key} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                padding: 14, background: 'var(--surface-2)', borderRadius: 13,
              }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{row.title}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{row.sub}</div>
                </div>
                <Toggle
                  on={prefs[row.key]}
                  label={row.title}
                  onChange={() => setPrefs((p) => ({ ...p, [row.key]: !p[row.key] }))}
                />
              </div>
            ))}
          </div>
          <Button onClick={savePrefs} busy={savingPrefs} style={{ marginTop: 14 }}>
            Save preferences
          </Button>
        </>)}
      </Card>

      {/* Account status */}
      <Card>
        <CardTitle title="Account status" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ ...cardStyle, boxShadow: 'none', background: 'var(--surface-2)', border: 0, borderRadius: 13, padding: '13px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' }}>Account</span>
            <Verified label={merchant?.status === 'ACTIVE' ? 'Active' : merchant?.status || 'Pending'} />
          </div>
          <div style={{ background: 'var(--surface-2)', borderRadius: 13, padding: '13px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' }}>Availability</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: availability.online ? 'var(--online)' : 'var(--offline)',
                animation: availability.online ? 'bb-pulse 2s ease infinite' : 'none',
              }} />
              {availability.short}
            </span>
          </div>
          <div style={{ background: 'var(--surface-2)', borderRadius: 13, padding: '13px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' }}>Settlement rail</span>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
              INR · bank account
            </span>
          </div>
          <Button variant="outline" tone="danger" full onClick={logout} style={{ marginTop: 2 }}>
            <LogOut size={16} /> Log out
          </Button>
        </div>
      </Card>
    </div>
  );
};

/** The owner's profile, or a sub-member's own (above). */
const ProfileSettings: React.FC = () => {
  const { merchant } = useAuth();
  return actorOf(merchant).isOwner ? <OwnerProfileSettings /> : <SubMemberProfile />;
};

export default ProfileSettings;
