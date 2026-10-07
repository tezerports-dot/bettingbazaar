// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Profile — design handoff "BB Merchant Panel.dc.html": performance, identity,
// payment details, order preferences and account status. A merchant holds no
// tokens — their team's pool does (PROJECT_STATUS §3.10) — so there is no
// wallet card here.
//
// The payment-details section is the one place the settlement rail is fully
// visible: an INR merchant edits a bank account (no UPI handle: a UPI_BANK buy
// is paid into it, and nobody is shown a handle, CLAUDE.md §2 and §24), a USDT
// merchant edits an address per chain. Which rail this merchant is on is assigned by an admin
// (Merchant.acceptedCurrencies) and is read-only here — the backend rejects a
// request that carries the other rail's fields, so this is a real boundary and
// not merely a hidden form.
import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Edit3, LogOut, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../services/AuthContext';
import { availabilityOf } from '../utils/availability';
import { api } from '../services/api';
import { useViewport } from '../hooks/useViewport';
import TwoFactorEnrol from '../components/TwoFactorEnrol';
import { SUCCESS_MESSAGES } from '../constants';
import {
  formatTokens, railOf,
  USDT_CHAINS, USDT_CHAIN_INFO, isUsdtAddress, type UsdtChain,
} from '../utils/rail';
import {
  Banner, Button, Card, CardTitle, Field, Toggle, Verified, cardStyle, copyText, inputStyle,
} from '../components/ui';

const ProfileSettings: React.FC = () => {
  const { merchant, logout, refreshProfile } = useAuth();
  const { isMobile } = useViewport();
  const rail = railOf(merchant);
  const isUsdt = rail === 'USDT';

  const [editingPayment, setEditingPayment] = useState(false);
  const [savingPayment, setSavingPayment] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);

  const [form, setForm] = useState({
    accountHolderName: '',
    bankName: '',
    accountNo: '',
    ifsc: '',
    usdtAddressTrc20: '',
    usdtAddressBep20: '',
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
      usdtAddressTrc20: merchant.usdtAddressTrc20 ?? '',
      usdtAddressBep20: merchant.usdtAddressBep20 ?? '',
    });
    setPrefs({
      acceptsDeposits: merchant.acceptsDeposits ?? merchant.orderPreferences?.acceptDeposits ?? true,
      acceptsWithdrawals: merchant.acceptsWithdrawals ?? merchant.orderPreferences?.acceptWithdrawals ?? true,
    });
  }, [merchant]);

  /**
   * One error per chain, and a separate one for holding none.
   *
   * A blank field CLEARS that chain — a merchant who stops serving a network
   * needs a way to say so. What is refused is clearing the last one: with no
   * address, no order can be assigned, and a merchant who quietly stopped
   * receiving work would have no way to find out why.
   */
  const addressErrors = useMemo(() => {
    if (!isUsdt || !editingPayment) return {} as Partial<Record<UsdtChain, string>>;
    const out: Partial<Record<UsdtChain, string>> = {};
    for (const chain of USDT_CHAINS) {
      const value = form[USDT_CHAIN_INFO[chain].field].trim();
      if (!value) continue;
      if (!isUsdtAddress(chain, value)) {
        out[chain] = `That is not a ${USDT_CHAIN_INFO[chain].label} address — ${USDT_CHAIN_INFO[chain].hint}.`;
      }
    }
    return out;
  }, [isUsdt, editingPayment, form.usdtAddressTrc20, form.usdtAddressBep20]);

  const holdsNoAddress = isUsdt
    && !form.usdtAddressTrc20.trim() && !form.usdtAddressBep20.trim();

  const savePayment = async () => {
    if (isUsdt) {
      if (Object.keys(addressErrors).length) {
        toast.error('Fix the wallet address before saving. USDT sent to a wrong address cannot be recovered.');
        return;
      }
      if (holdsNoAddress) {
        toast.error('Keep at least one wallet address — with none, no order can be assigned to you.');
        return;
      }
    }
    setSavingPayment(true);
    try {
      // Only the fields for this merchant's rail are sent — the backend rejects
      // the other rail's fields outright.
      await api.updateProfile(
        isUsdt
          ? {
              // Both chains, every time: an empty string CLEARS that chain, and
              // sending only the one being edited would leave the panel unable
              // to remove an address at all.
              usdtAddressTrc20: form.usdtAddressTrc20.trim(),
              usdtAddressBep20: form.usdtAddressBep20.trim(),
            }
          : {
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
      {/* Account security first: a merchant who has not enrolled is protected
          by a password alone on an account that settles real INR and USDT.
          The login flow routes un-enrolled merchants straight here. */}
      <TwoFactorEnrol />

      {/* Performance */}
      <Card>
        <CardTitle title="Merchant performance" />
        <div style={{ display: 'grid', gridTemplateColumns: perfColumns, gap: 11 }}>
          {[
            { label: 'Completed orders', value: merchant?.totalOrdersCompleted !== undefined ? String(merchant.totalOrdersCompleted) : '—', tone: 'var(--text)' },
            // TOKENS, not the rail's currency. `merchants.total_deposit_amount_paise`
            // is fed `order.tokenAmount` by recordCompletedOrder, so on the USDT rail
            // `formatMoney(..., rail)` printed a token count with a USDT suffix —
            // a 50,000-token deposit read "50,000 USDT" for about 555 USDT of work.
            // CLAUDE.md trap 15, in the line a human reads.
            { label: 'Deposits processed', value: merchant?.totalDepositAmount !== undefined ? formatTokens(merchant.totalDepositAmount) : '—', tone: 'var(--dep)' },
            { label: 'Withdrawals processed', value: merchant?.totalWithdrawalAmount !== undefined ? formatTokens(merchant.totalWithdrawalAmount) : '—', tone: 'var(--wd)' },
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
              {isUsdt ? 'USDT · TRC-20 / BEP-20' : 'INR · bank account'}
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
            ? 'Players send USDT to the address for the network they chose'
            : 'Users pay here for deposits · you receive settlements here'}
        </div>

        {!editingPayment && (isUsdt ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {/* One row per chain. A merchant may hold either, both, or neither
                — and which they hold decides which orders reach them, so it is
                shown as two separate facts rather than one "wallet address". */}
            {USDT_CHAINS.map((chain) => {
              const info = USDT_CHAIN_INFO[chain];
              const address = merchant?.[info.field] || '';
              return (
                <div key={chain} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  padding: '13px 15px', background: 'var(--dep-bg)', borderRadius: 13,
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--dep)' }}>{info.label}</div>
                    <div className="bb-mono" style={{ fontSize: 14, fontWeight: 700, color: address ? 'var(--text)' : 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {address || 'Not set — no orders on this network'}
                    </div>
                  </div>
                  {address && (
                    <button
                      onClick={() => copyText(address, `${info.label} address`)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: 'var(--dep)',
                        background: 'var(--surface)', border: 0, padding: '8px 12px', borderRadius: 9, cursor: 'pointer', flexShrink: 0,
                      }}
                    >
                      <Copy size={13} /> Copy
                    </button>
                  )}
                </div>
              );
            })}
            {!merchant?.usdtAddressTrc20 && !merchant?.usdtAddressBep20 ? (
              <Banner tone="warn" title="Add a wallet address">
                You cannot take USDT orders until at least one address is saved.
              </Banner>
            ) : (
              <Banner tone="warn">
                You are offered orders <strong style={{ color: 'var(--text)' }}>only on the networks you hold an
                address for</strong>. The player chooses the network, sends USDT to that address, and submits the
                transaction ID for you to verify.
              </Banner>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {/* A bank account only. A UPI ID row stood above this, saved and
                copied into every order, and nothing ever read it: a UPI_BANK
                buy is paid into this account and nobody is shown a handle. */}
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
            {/* One field per chain, each independently clearable. A blank field
                means "I do not serve this network"; clearing BOTH is refused,
                because a merchant with no address silently receives nothing. */}
            {USDT_CHAINS.map((chain) => {
              const info = USDT_CHAIN_INFO[chain];
              return (
                <Field
                  key={chain}
                  label={`${info.label} address`}
                  error={addressErrors[chain]}
                  hint={`${info.hint}. Leave blank if you do not accept USDT on this network. USDT sent to a wrong address cannot be recovered — check it character by character.`}
                >
                  <input
                    value={form[info.field]}
                    onChange={(e) => setForm((f) => ({ ...f, [info.field]: e.target.value }))}
                    placeholder={info.hint}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="bb-mono"
                    style={inputStyle}
                  />
                </Field>
              );
            })}
            {holdsNoAddress && (
              <Banner tone="warn" title="Keep at least one address">
                With no address on either network, no order can be assigned to you.
              </Banner>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <Button
                onClick={savePayment}
                busy={savingPayment}
                disabled={Object.keys(addressErrors).length > 0 || holdsNoAddress}
              >
                <Save size={15} /> Save wallet addresses
              </Button>
              <Button variant="outline" tone="neutral" onClick={() => setEditingPayment(false)} style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
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
                background: merchant?.isOnline ? 'var(--online)' : 'var(--offline)',
                animation: merchant?.isOnline ? 'bb-pulse 2s ease infinite' : 'none',
              }} />
              {availabilityOf(merchant).short}
            </span>
          </div>
          <div style={{ background: 'var(--surface-2)', borderRadius: 13, padding: '13px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' }}>Settlement rail</span>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
              {isUsdt ? 'USDT · TRC-20 / BEP-20' : 'INR · bank account'}
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

export default ProfileSettings;
