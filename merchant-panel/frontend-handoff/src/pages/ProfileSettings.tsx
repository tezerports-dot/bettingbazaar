// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Profile — design handoff "BB Merchant Panel.dc.html": performance, identity,
// payment details, order preferences, wallet and account status.
//
// The payment-details section is the one place the settlement rail is fully
// visible: an INR merchant edits UPI + QR + bank, a USDT merchant edits a single
// TRC-20 address. Which rail this merchant is on is assigned by an admin
// (Merchant.acceptedCurrencies) and is read-only here — the backend rejects a
// request that carries the other rail's fields, so this is a real boundary and
// not merely a hidden form.
import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Edit3, LogOut, Save, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../services/AuthContext';
import { api } from '../services/api';
import { useViewport } from '../hooks/useViewport';
import { SUCCESS_MESSAGES } from '../constants';
import { formatMoney, formatWallet, isTrc20Address, railCopy, railOf } from '../utils/rail';
import {
  Banner, Button, Card, CardTitle, Field, Toggle, Verified, cardStyle, copyText, inputStyle,
} from '../components/ui';

const ProfileSettings: React.FC = () => {
  const { merchant, logout, refreshProfile } = useAuth();
  const { isMobile } = useViewport();
  const rail = railOf(merchant);
  const copy = railCopy(rail);
  const isUsdt = rail === 'USDT';

  const [editingPayment, setEditingPayment] = useState(false);
  const [savingPayment, setSavingPayment] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);

  const bank = merchant?.bankDetails ?? merchant?.settlementDetails;

  const [form, setForm] = useState({
    upiId: '',
    qrCodeUrl: '',
    accountHolderName: '',
    bankName: '',
    accountNo: '',
    ifsc: '',
    usdtWalletAddress: '',
  });

  const [prefs, setPrefs] = useState({ acceptsDeposits: true, acceptsWithdrawals: true });

  // Re-seed the forms whenever the profile changes, so an edit never starts
  // from values that have since been changed elsewhere (e.g. by an admin).
  useEffect(() => {
    if (!merchant) return;
    setForm({
      upiId: merchant.bankDetails?.upiId ?? merchant.settlementDetails?.upiId ?? '',
      qrCodeUrl: merchant.settlementDetails?.upiQrCodeUrl ?? '',
      accountHolderName: merchant.bankDetails?.accountHolderName ?? merchant.settlementDetails?.accountName ?? '',
      bankName: merchant.bankDetails?.bankName ?? merchant.settlementDetails?.bankName ?? '',
      accountNo: merchant.bankDetails?.accountNo ?? merchant.settlementDetails?.accountNumber ?? '',
      ifsc: merchant.bankDetails?.ifsc ?? merchant.settlementDetails?.ifsc ?? '',
      usdtWalletAddress: merchant.usdtWalletAddress ?? '',
    });
    setPrefs({
      acceptsDeposits: merchant.acceptsDeposits ?? merchant.orderPreferences?.acceptDeposits ?? true,
      acceptsWithdrawals: merchant.acceptsWithdrawals ?? merchant.orderPreferences?.acceptWithdrawals ?? true,
    });
  }, [merchant]);

  const addressError = useMemo(() => {
    if (!isUsdt || !editingPayment) return undefined;
    const value = form.usdtWalletAddress.trim();
    if (!value) return undefined;
    return isTrc20Address(value)
      ? undefined
      : 'That is not a TRC-20 address — it must be 34 characters starting with "T".';
  }, [isUsdt, editingPayment, form.usdtWalletAddress]);

  const savePayment = async () => {
    if (isUsdt && !isTrc20Address(form.usdtWalletAddress)) {
      toast.error('Enter a valid TRC-20 (Tron) wallet address before saving.');
      return;
    }
    setSavingPayment(true);
    try {
      // Only the fields for this merchant's rail are sent — the backend rejects
      // the other rail's fields outright.
      await api.updateProfile(
        isUsdt
          ? { usdtWalletAddress: form.usdtWalletAddress.trim() }
          : {
              upiId: form.upiId.trim(),
              qrCodeUrl: form.qrCodeUrl.trim(),
              bankDetails: {
                accountHolderName: form.accountHolderName.trim(),
                bankName: form.bankName.trim(),
                accountNo: form.accountNo.trim(),
                ifsc: form.ifsc.trim().toUpperCase(),
              },
            }
      );
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

  const perfColumns = isMobile ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))';
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
      {/* Performance */}
      <Card>
        <CardTitle title="Merchant performance" />
        <div style={{ display: 'grid', gridTemplateColumns: perfColumns, gap: 11 }}>
          {[
            { label: 'Completed orders', value: merchant?.totalOrdersCompleted !== undefined ? String(merchant.totalOrdersCompleted) : '—', tone: 'var(--text)' },
            { label: 'Deposits processed', value: merchant?.totalDepositAmount !== undefined ? formatMoney(merchant.totalDepositAmount, rail) : '—', tone: 'var(--dep)' },
            { label: 'Withdrawals processed', value: merchant?.totalWithdrawalAmount !== undefined ? formatMoney(merchant.totalWithdrawalAmount, rail) : '—', tone: 'var(--wd)' },
            { label: 'Merchant rating', value: merchant?.rating !== undefined ? `${merchant.rating.toFixed(1)} ★` : '—', tone: 'var(--text)' },
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

      {/* Payment details — the rail-specific section */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>Payment details</span>
            <span style={{
              fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 7, letterSpacing: '.03em',
              color: isUsdt ? 'var(--dep)' : 'var(--brand)',
              background: isUsdt ? 'var(--dep-bg)' : 'var(--brand-bg)',
            }}>
              {isUsdt ? 'USDT · TRC-20' : 'INR · UPI & bank'}
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
          {isUsdt
            ? 'Users send USDT deposits to this address · payouts are sent from here'
            : 'Users pay here for deposits · you receive settlements here'}
        </div>

        {!editingPayment && (isUsdt ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
              padding: '13px 15px', background: 'var(--dep-bg)', borderRadius: 13,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--dep)' }}>USDT wallet · TRC-20</div>
                <div className="bb-mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {merchant?.usdtWalletAddress || 'Not set'}
                </div>
              </div>
              {merchant?.usdtWalletAddress && (
                <button
                  onClick={() => copyText(merchant.usdtWalletAddress || '', 'USDT address')}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: 'var(--dep)',
                    background: 'var(--surface)', border: 0, padding: '8px 12px', borderRadius: 9, cursor: 'pointer', flexShrink: 0,
                  }}
                >
                  <Copy size={13} /> Copy
                </button>
              )}
            </div>
            {!merchant?.usdtWalletAddress ? (
              <Banner tone="warn" title="Add your wallet address">
                You cannot take USDT orders until a TRC-20 address is saved.
              </Banner>
            ) : (
              <Banner tone="warn">
                Only <strong style={{ color: 'var(--text)' }}>TRC-20 (Tron)</strong> USDT is supported. Users send deposits
                here and submit the transaction ID for you to verify.
              </Banner>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
              padding: '13px 15px', background: 'var(--dep-bg)', borderRadius: 13,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--dep)' }}>UPI ID</div>
                <div className="bb-mono" style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {bank?.upiId || 'Not set'}
                </div>
              </div>
              {bank?.upiId && (
                <button
                  onClick={() => copyText(bank.upiId || '', 'UPI ID')}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: 'var(--dep)',
                    background: 'var(--surface)', border: 0, padding: '8px 12px', borderRadius: 9, cursor: 'pointer', flexShrink: 0,
                  }}
                >
                  <Copy size={13} /> Copy
                </button>
              )}
            </div>

            <div style={{ padding: '14px 15px', background: 'var(--surface-2)', borderRadius: 13 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 9 }}>Bank settlement account</div>
              <div style={{ display: 'grid', gridTemplateColumns: twoColumns, gap: '9px 18px' }}>
                {[
                  { label: 'Holder', value: form.accountHolderName },
                  { label: 'Bank', value: form.bankName },
                  { label: 'Account no.', value: maskedAccount, mono: true },
                  { label: 'IFSC', value: form.ifsc, mono: true },
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
        ))}

        {editingPayment && (isUsdt ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            <Field
              label="USDT wallet address (TRC-20)"
              error={addressError}
              hint="USDT sent to a wrong or non-TRC-20 address cannot be recovered. Check it character by character."
            >
              <input
                value={form.usdtWalletAddress}
                onChange={(e) => setForm((f) => ({ ...f, usdtWalletAddress: e.target.value }))}
                placeholder="T… TRC-20 address"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                className="bb-mono"
                style={inputStyle}
              />
            </Field>
            <div style={{ display: 'flex', gap: 10 }}>
              <Button onClick={savePayment} busy={savingPayment} disabled={!!addressError}>
                <Save size={15} /> Save USDT address
              </Button>
              <Button variant="outline" tone="neutral" onClick={() => setEditingPayment(false)} style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            <Field label="UPI ID">
              <input
                value={form.upiId}
                onChange={(e) => setForm((f) => ({ ...f, upiId: e.target.value }))}
                placeholder="yourname@bank"
                spellCheck={false}
                autoCapitalize="none"
                className="bb-mono"
                style={inputStyle}
              />
            </Field>
            <Field label="Payment QR image URL" hint="Shown to users alongside your UPI ID.">
              <input
                value={form.qrCodeUrl}
                onChange={(e) => setForm((f) => ({ ...f, qrCodeUrl: e.target.value }))}
                placeholder="https://…"
                spellCheck={false}
                style={inputStyle}
              />
            </Field>
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
        ))}
      </Card>

      {/* Order preferences */}
      <Card>
        <CardTitle title="Order preferences" />
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
      </Card>

      {/* Wallet + account status */}
      <div style={{ display: 'grid', gridTemplateColumns: twoColumns, gap: 14, alignItems: 'start' }}>
        <Card>
          <CardTitle title="Wallet" />
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 13,
            background: isUsdt ? 'var(--dep-bg)' : 'var(--brand-bg)',
          }}>
            <span style={{
              width: 38, height: 38, borderRadius: 11, background: 'var(--surface)', flexShrink: 0,
              color: isUsdt ? 'var(--dep)' : 'var(--brand)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Wallet size={18} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{copy.walletLabel}</div>
              <div className="bb-mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>
                {formatWallet(merchant?.tokenBalance, rail)}
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginTop: 2 }}>{copy.walletNote}</div>
            </div>
          </div>
        </Card>

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
                  background: merchant?.isOnline ? 'var(--online)' : 'var(--offline)',
                  animation: merchant?.isOnline ? 'bb-pulse 2s ease infinite' : 'none',
                }} />
                {merchant?.isOnline ? 'Available for orders' : 'Not accepting'}
              </span>
            </div>
            <div style={{ background: 'var(--surface-2)', borderRadius: 13, padding: '13px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' }}>Settlement rail</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
                {isUsdt ? 'USDT · TRC-20' : 'INR · UPI & bank'}
              </span>
            </div>
            <Button variant="outline" tone="danger" full onClick={logout} style={{ marginTop: 2 }}>
              <LogOut size={16} /> Log out
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default ProfileSettings;
