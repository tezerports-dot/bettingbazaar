// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ProfileSettings.tsx  v3.0.0
 *
 * FIX M6: Add editable UPI / QR Code / bank details form.
 *
 * Before: The profile page was entirely read-only. Merchants had no way to
 *   update their UPI ID or bank details after registration.
 *   The settlement details section rendered merchant.settlementDetails which
 *   doesn't match the Merchant schema (bankDetails.upiId, qrCodeUrl).
 *
 * After:
 *   - New "Payment Details" section with editable inputs for:
 *       UPI ID, QR Code URL, bank name, account number, IFSC
 *   - Save calls api.updateProfile() -> PUT /api/merchant/profile (Batch 1)
 *   - Profile is refreshed after save so AuthContext reflects latest values
 *   - Display reads from correct schema paths (bankDetails.upiId, qrCodeUrl)
 *
 * All existing functionality retained.
 */
import React, { useState } from 'react';
import { useAuth } from '../services/AuthContext';
import { api } from '../services/api';
import toast from 'react-hot-toast';
import {
  Save, User, Phone, Mail, Wallet, CreditCard,
  Settings, TrendingUp, Award, Calendar, Edit3,
} from 'lucide-react';

const ProfileSettings: React.FC = () => {
  const { merchant, refreshProfile } = useAuth();

  // Order preferences
  const [acceptDeposits,    setAcceptDeposits]    = useState(merchant?.acceptsDeposits    !== false);
  const [acceptWithdrawals, setAcceptWithdrawals] = useState(merchant?.acceptsWithdrawals !== false);
  const [saving,            setSaving]            = useState(false);

  // FIX M6: Payment details form state
  const existingUpiId    = (merchant as any)?.bankDetails?.upiId || (merchant as any)?.upiId || '';
  const existingQrUrl    = (merchant as any)?.qrCodeUrl || '';
  const existingAccountHolderName = (merchant as any)?.bankDetails?.accountHolderName || '';
  const existingBankName = (merchant as any)?.bankDetails?.bankName || '';
  const existingAccountNo = (merchant as any)?.bankDetails?.accountNo || '';
  const existingIfsc     = (merchant as any)?.bankDetails?.ifsc || '';

  const [upiId,              setUpiId]              = useState<string>(existingUpiId);
  const [qrCodeUrl,          setQrCodeUrl]          = useState<string>(existingQrUrl);
  const [accountHolderName,  setAccountHolderName]  = useState<string>(existingAccountHolderName);
  const [bankName,           setBankName]           = useState<string>(existingBankName);
  const [accountNo,          setAccountNo]          = useState<string>(existingAccountNo);
  const [ifsc,               setIfsc]               = useState<string>(existingIfsc);
  const [savingProfile, setSavingProfile] = useState(false);
  const [editingPayment, setEditingPayment] = useState(false);
  const [uploadingQr, setUploadingQr] = useState(false);

  const handleSavePreferences = async () => {
    setSaving(true);
    try {
      await api.updatePreferences({
        acceptsDeposits:    acceptDeposits,
        acceptsWithdrawals: acceptWithdrawals,
      });
      await refreshProfile();
      toast.success('Preferences updated successfully');
    } catch (error: any) {
      toast.error(error.message || 'Failed to update preferences');
    } finally {
      setSaving(false);
    }
  };

  // FIX M6: save payment details via PUT /api/merchant/profile
  const handleSavePaymentDetails = async () => {
    setSavingProfile(true);
    try {
      await api.updateProfile({
        upiId:      upiId.trim()     || undefined,
        qrCodeUrl:  qrCodeUrl.trim() || undefined,
        bankDetails: {
          accountHolderName: accountHolderName.trim() || undefined,
          bankName:  bankName.trim()  || undefined,
          accountNo: accountNo.trim() || undefined,
          ifsc:      ifsc.trim()      || undefined,
        },
      });
      await refreshProfile();
      setEditingPayment(false);
      toast.success('Payment details updated');
    } catch (error: any) {
      toast.error(error.message || 'Failed to update payment details');
    } finally {
      setSavingProfile(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  const totalEarnings          = (merchant as any)?.earnings           || 0;
  const totalDepositsVolume    = (merchant as any)?.totalDepositsProcessed    || 0;
  const totalWithdrawalsVolume = (merchant as any)?.totalWithdrawalsProcessed || 0;
  const merchantRating         = merchant?.rating || 0;
  const accountAge             = merchant?.createdAt
    ? Math.floor((Date.now() - new Date(merchant.createdAt).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-3">
        <Settings className="h-8 w-8 text-blue-600" />
        <h1 className="text-3xl font-bold text-gray-900">Profile Settings</h1>
      </div>

      {/* Performance Stats */}
      <div className="bg-gradient-to-br from-blue-50 to-indigo-50 p-6 rounded-lg shadow border border-blue-200">
        <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center">
          <Award className="h-6 w-6 text-blue-600 mr-2" />
          Merchant Performance
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-lg shadow-sm">
            <p className="text-xs text-gray-600">Total Earnings</p>
            <p className="text-2xl font-bold text-green-600">Rs.{totalEarnings.toLocaleString('en-IN')}</p>
            <p className="text-xs text-gray-500 mt-1">Lifetime profit</p>
          </div>
          <div className="bg-white p-4 rounded-lg shadow-sm">
            <p className="text-xs text-gray-600">Deposits Processed</p>
            <p className="text-2xl font-bold text-blue-600">Rs.{totalDepositsVolume.toLocaleString('en-IN')}</p>
            <p className="text-xs text-gray-500 mt-1">Total volume</p>
          </div>
          <div className="bg-white p-4 rounded-lg shadow-sm">
            <p className="text-xs text-gray-600">Withdrawals Processed</p>
            <p className="text-2xl font-bold text-purple-600">Rs.{totalWithdrawalsVolume.toLocaleString('en-IN')}</p>
            <p className="text-xs text-gray-500 mt-1">Total volume</p>
          </div>
          <div className="bg-white p-4 rounded-lg shadow-sm">
            <p className="text-xs text-gray-600">Merchant Rating</p>
            <p className="text-2xl font-bold text-orange-600">{merchantRating.toFixed(1)} [star]</p>
            <p className="text-xs text-gray-500 mt-1">From users</p>
          </div>
        </div>
      </div>

      {/* Profile Information */}
      <div className="bg-white rounded-lg shadow p-6 border border-gray-200">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Profile Information</h2>
        <div className="space-y-4">
          {[
            { icon: User,     label: 'Username',    value: merchant?.username },
            { icon: Phone,    label: 'Mobile',      value: merchant?.mobile },
            { icon: Mail,     label: 'Email',       value: merchant?.email },
            { icon: Calendar, label: 'Account Age', value: `${accountAge} days`, noCopy: true },
          ].map(({ icon: Icon, label, value, noCopy }) => (
            <div key={label} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center space-x-3">
                <Icon className="h-5 w-5 text-gray-400" />
                <div>
                  <p className="text-sm text-gray-600">{label}</p>
                  <p className="text-lg font-medium text-gray-900">{value || '--'}</p>
                </div>
              </div>
              {!noCopy && value && (
                <button
                  onClick={() => copyToClipboard(value, label)}
                  className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  Copy
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* FIX M6: Editable Payment Details */}
      <div className="bg-white rounded-lg shadow p-6 border border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Payment Details</h2>
          {!editingPayment && (
            <button
              onClick={() => setEditingPayment(true)}
              className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium"
            >
              <Edit3 className="h-4 w-4" />
              Edit
            </button>
          )}
        </div>

        {!editingPayment ? (
          /* Read-only view -- uses correct schema paths */
          <div className="space-y-3">
            {upiId ? (
              <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div>
                  <p className="text-sm text-gray-600">UPI ID</p>
                  <p className="text-base font-medium text-gray-900 font-mono">{upiId}</p>
                </div>
                <button onClick={() => copyToClipboard(upiId, 'UPI ID')} className="text-blue-600 hover:text-blue-700 text-sm font-medium">Copy</button>
              </div>
            ) : (
              <p className="text-sm text-gray-500 italic p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                [!] No UPI ID set. Users won't see payment instructions. Click Edit to add one.
              </p>
            )}

            {qrCodeUrl && (
              <div className="p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-600 mb-2">QR Code</p>
                <img src={qrCodeUrl} alt="UPI QR Code" className="w-40 h-40 border rounded shadow-sm object-contain" />
              </div>
            )}

            {(bankName || accountNo || ifsc || accountHolderName) && (
              <div className="p-3 bg-gray-50 rounded-lg space-y-1">
                <p className="text-sm text-gray-600 font-medium">Bank Details</p>
                {accountHolderName && <p className="text-sm text-gray-900"><span className="font-medium">Name:</span> {accountHolderName}</p>}
                {bankName  && <p className="text-sm text-gray-900"><span className="font-medium">Bank:</span> {bankName}</p>}
                {accountNo && <p className="text-sm text-gray-900"><span className="font-medium">Account:</span> {accountNo}</p>}
                {ifsc      && <p className="text-sm text-gray-900"><span className="font-medium">IFSC:</span> {ifsc}</p>}
              </div>
            )}
          </div>
        ) : (
          /* Edit form */
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">UPI ID</label>
              <input
                type="text"
                value={upiId}
                onChange={e => setUpiId(e.target.value)}
                placeholder="yourname@upi"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 font-mono"
              />
              {!upiId.trim() && (
                <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                  ⚠️ No UPI ID set — users cannot pay you. Add your UPI ID to receive DEPOSIT payments.
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">QR Code Image</label>
              {qrCodeUrl ? (
                <div className="flex items-center gap-3">
                  <img src={qrCodeUrl} alt="Current QR Code" className="w-24 h-24 rounded border border-gray-200 object-contain" />
                  <div>
                    <p className="text-xs text-green-600 font-medium mb-1">✅ QR Code uploaded</p>
                    <button
                      type="button"
                      onClick={() => setQrCodeUrl('')}
                      className="text-xs text-red-500 hover:text-red-700 underline"
                    >
                      Replace QR Code
                    </button>
                  </div>
                </div>
              ) : (
                <label className="block border-2 border-dashed border-gray-300 rounded-lg p-4 text-center cursor-pointer hover:border-blue-400 transition-colors">
                  <p className="text-sm text-gray-500">
                    {uploadingQr ? '⏳ Uploading QR…' : '📁 Click to upload QR code image (JPG, PNG, WebP)'}
                  </p>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    disabled={uploadingQr}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setUploadingQr(true);
                      try {
                        const token = localStorage.getItem('merchantToken') || '';
                        const BASE_URL = (import.meta as any).env?.VITE_API_URL || '';
                        const urlRes = await fetch(`${BASE_URL}/api/upload/merchant/qr/upload-url`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                          body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size }),
                        }).then(r => r.json());
                        if (urlRes.uploadUrl) {
                          await fetch(urlRes.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
                          setQrCodeUrl(urlRes.cdnUrl || urlRes.fileUrl || '');
                          toast.success('QR code uploaded');
                        } else {
                          toast.error(urlRes.message || 'CDN not configured. Enter QR URL manually.');
                        }
                      } catch (err: any) {
                        toast.error(err?.message || 'QR upload failed');
                      } finally {
                        setUploadingQr(false);
                      }
                    }}
                  />
                </label>
              )}
              <p className="text-xs text-gray-400 mt-1">Used to generate dynamic UPI QR with pre-filled amount for users</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Account Holder Name</label>
                <input
                  type="text"
                  value={accountHolderName}
                  onChange={e => setAccountHolderName(e.target.value)}
                  placeholder="Full name as on bank account"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Bank Name</label>
                <input
                  type="text"
                  value={bankName}
                  onChange={e => setBankName(e.target.value)}
                  placeholder="HDFC Bank"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Account Number</label>
                <input
                  type="text"
                  value={accountNo}
                  onChange={e => setAccountNo(e.target.value)}
                  placeholder="1234567890"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">IFSC Code</label>
                <input
                  type="text"
                  value={ifsc}
                  onChange={e => setIfsc(e.target.value.toUpperCase())}
                  placeholder="HDFC0001234"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleSavePaymentDetails}
                disabled={savingProfile}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
              >
                <Save className="h-4 w-4" />
                {savingProfile ? 'Saving...' : 'Save Payment Details'}
              </button>
              <button
                onClick={() => setEditingPayment(false)}
                className="px-6 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Order Preferences */}
      <div className="bg-white rounded-lg shadow p-6 border border-gray-200">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Order Preferences</h2>
        <div className="space-y-4">
          <label className="flex items-center justify-between p-4 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
            <div>
              <p className="font-medium text-gray-900">Accept Deposit Orders</p>
              <p className="text-sm text-gray-600">Receive deposit requests from users</p>
            </div>
            <input
              type="checkbox"
              checked={acceptDeposits}
              onChange={e => setAcceptDeposits(e.target.checked)}
              className="w-6 h-6 text-blue-600 rounded focus:ring-blue-500"
            />
          </label>
          <label className="flex items-center justify-between p-4 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
            <div>
              <p className="font-medium text-gray-900">Accept Withdrawal Orders</p>
              <p className="text-sm text-gray-600">Receive withdrawal requests from users</p>
            </div>
            <input
              type="checkbox"
              checked={acceptWithdrawals}
              onChange={e => setAcceptWithdrawals(e.target.checked)}
              className="w-6 h-6 text-blue-600 rounded focus:ring-blue-500"
            />
          </label>
        </div>
        <button
          onClick={handleSavePreferences}
          disabled={saving}
          className="mt-6 w-full sm:w-auto px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center space-x-2 transition-colors"
        >
          <Save className="h-4 w-4" />
          <span>{saving ? 'Saving...' : 'Save Preferences'}</span>
        </button>
      </div>

      {/* Wallet */}
      <div className="bg-white rounded-lg shadow p-6 border border-gray-200">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Wallet Information</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="flex items-center space-x-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
            <Wallet className="h-10 w-10 text-blue-500" />
            <div>
              <p className="text-sm text-gray-600">BB Token Balance</p>
              <p className="text-2xl font-bold text-gray-900">
                {((merchant as any)?.tokenBalance || (merchant as any)?.walletBalance || 0).toLocaleString('en-IN')}
              </p>
              <p className="text-xs text-gray-500 mt-1">Available tokens</p>
            </div>
          </div>
          <div className="flex items-center space-x-4 p-4 bg-green-50 rounded-lg border border-green-200">
            <CreditCard className="h-10 w-10 text-green-500" />
            <div>
              <p className="text-sm text-gray-600">Fiat Balance</p>
              <p className="text-2xl font-bold text-gray-900">
                Rs.{((merchant as any)?.fiatBalance || 0).toLocaleString('en-IN')}
              </p>
              <p className="text-xs text-gray-500 mt-1">Available funds</p>
            </div>
          </div>
        </div>
      </div>

      {/* Pricing */}
      <div className="bg-white rounded-lg shadow p-6 border border-gray-200">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Current Pricing (Set by Admin)</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="p-4 bg-green-50 rounded-lg border border-green-200">
            <div className="flex items-center space-x-2 mb-2">
              <TrendingUp className="h-5 w-5 text-green-600" />
              <p className="text-sm text-gray-600 font-medium">Buy Price</p>
            </div>
            <p className="text-xs text-gray-500 mb-2">You buy BB Tokens from users</p>
            <p className="text-3xl font-semibold text-gray-900">
              Rs.{((merchant as any)?.prices?.buyPrice || 0).toFixed(2)}
            </p>
            <p className="text-xs text-gray-500 mt-1">per token</p>
          </div>
          <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
            <div className="flex items-center space-x-2 mb-2">
              <TrendingUp className="h-5 w-5 text-blue-600 transform rotate-180" />
              <p className="text-sm text-gray-600 font-medium">Sell Price</p>
            </div>
            <p className="text-xs text-gray-500 mb-2">You sell BB Tokens to users</p>
            <p className="text-3xl font-semibold text-gray-900">
              Rs.{((merchant as any)?.prices?.sellPrice || 0).toFixed(2)}
            </p>
            <p className="text-xs text-gray-500 mt-1">per token</p>
          </div>
        </div>
        <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-sm text-yellow-800">(i) Prices are set by the admin and cannot be modified by merchants</p>
          <p className="text-xs text-yellow-700 mt-1">Your profit = (Sell Price - Buy Price) x Token Amount</p>
        </div>
      </div>

      {/* Account Status */}
      <div className="bg-white rounded-lg shadow p-6 border border-gray-200">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Account Status</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-sm text-gray-600">Status</p>
            <p className="text-lg font-semibold text-gray-900">{merchant?.status || 'ACTIVE'}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Online Status</p>
            <p className={`text-lg font-semibold ${merchant?.isOnline ? 'text-green-600' : 'text-gray-600'}`}>
              {merchant?.isOnline ? '[green] Online' : '[red] Offline'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProfileSettings;
