// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Save, Power, AlertTriangle } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import api from '../../services/api';
import toast from 'react-hot-toast';

// C-05 fix: tokenBuyRate/tokenSellRate removed from SystemSettings — use /token-rates page.
// GOVERNANCE §2: TokenRates page is the sole write path for token exchange rates.
export const SystemSettings: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showMaintenanceConfirm, setShowMaintenanceConfirm] = useState(false);

  const [formData, setFormData] = useState({
    maintenanceMode: false,
    maintenanceMessage: '',
    registrationEnabled: true,
    minDeposit: 100,
    minWithdrawal: 100,
    minBet: 10,
    maxBet: 50000,
    max30MinBet: 50000,
    maxFullDayBet: 100000,
    maxWinningsWithdrawal: 500000,
    // ── Money rules (Phase A + Risk Platform) — consumed by bet.routes.js,
    //    gameEngine.js and riskValidation.service.js on the backend ──────────
    betReservePercent: 3,      // schema default: 3
    winningsFeePercent: 1,     // schema default: 1
    payoutFeePercent: 0,       // schema default: 0
    cycleDurationMinutes: 30,  // schema default: 30 (Phase X X-5)
    riskRules: {
      enforceMultiplesOf10: true,      // schema default: true
      blockOppositeSideBetting: false, // schema default: false
      maxFundingOrdersPerHour: 0,      // schema default: 0 (off)
    },
    // App distribution
    webUrl:        '',
    androidUrl:    '',
    iosUrl:        '',
    minVersion:    '1.0.0',
    latestVersion: '1.0.0',
  });

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const response = await api.system.getConfig();
      if (response.success && response.data) {
        setFormData({
          maintenanceMode: response.data.maintenanceMode || false,
          maintenanceMessage: response.data.maintenanceMessage || '',
          registrationEnabled: response.data.registrationEnabled !== false,
          minDeposit: response.data.minDeposit || 100,
          minWithdrawal: response.data.minWithdrawal || 100,
          minBet: response.data.minBet || 10,
          maxBet: response.data.maxBet || 50000,
          max30MinBet: response.data.max30MinBet || 50000,
          maxFullDayBet: response.data.maxFullDayBet || 100000,
          maxWinningsWithdrawal: response.data.maxWinningsWithdrawal || 500000,
          betReservePercent:  response.data.betReservePercent  ?? 3, // schema default: 3
          winningsFeePercent: response.data.winningsFeePercent ?? 1, // schema default: 1
          payoutFeePercent:   response.data.payoutFeePercent   ?? 0, // schema default: 0
          cycleDurationMinutes: response.data.cycleDurationMinutes ?? 30, // schema default: 30
          riskRules: {
            enforceMultiplesOf10:     response.data.riskRules?.enforceMultiplesOf10     ?? true,
            blockOppositeSideBetting: response.data.riskRules?.blockOppositeSideBetting ?? false,
            maxFundingOrdersPerHour:  response.data.riskRules?.maxFundingOrdersPerHour  ?? 0,
          },
          webUrl:        response.data.webUrl        || '',
          androidUrl:    response.data.androidUrl    || '',
          iosUrl:        response.data.iosUrl        || '',
          minVersion:    response.data.minVersion    || '1.0.0',
          latestVersion: response.data.latestVersion || '1.0.0',
        });
      }
    } catch (error) {
      toast.error('Failed to load system config');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await api.system.updateConfig(formData);
      toast.success('System settings updated');
      loadConfig();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to update settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleMaintenance = async () => {
    try {
      await api.system.toggleMaintenance(!formData.maintenanceMode, formData.maintenanceMessage);
      toast.success(
        formData.maintenanceMode ? 'Maintenance mode disabled' : 'Maintenance mode enabled'
      );
      loadConfig();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to toggle maintenance mode');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-4 border-dark-600 border-t-gold-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold mb-2">System Settings</h1>
        <p className="text-gray-400">Configure platform-wide settings</p>
      </div>

      {/* Maintenance Mode Warning */}
      {formData.maintenanceMode && (
        <div className="bg-orange-500/10 border-2 border-orange-500/50 rounded-lg p-4">
          <div className="flex items-start space-x-3">
            <AlertTriangle className="text-orange-500 flex-shrink-0 mt-0.5" size={24} />
            <div className="flex-1">
              <p className="font-semibold text-orange-400 mb-1">
                [!] MAINTENANCE MODE ACTIVE
              </p>
              <p className="text-sm text-gray-300">
                Platform is currently inaccessible to users. Only admins can login.
              </p>
              {formData.maintenanceMessage && (
                <p className="text-sm text-gray-400 mt-2 italic">
                  Message: "{formData.maintenanceMessage}"
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Maintenance Mode */}
      <div className="card border-2 border-orange-500/30">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <h3 className="text-lg font-semibold mb-2 flex items-center">
              <Power className="mr-2 text-orange-500" size={20} />
              Maintenance Mode
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              {formData.maintenanceMode
                ? '[!] Platform is currently in maintenance mode'
                : '? Platform is operational'}
            </p>
            {formData.maintenanceMode && (
              <div className="mb-4">
                <label className="label">Maintenance Message</label>
                <textarea
                  value={formData.maintenanceMessage}
                  onChange={(e) =>
                    setFormData({ ...formData, maintenanceMessage: e.target.value })
                  }
                  className="input min-h-[80px]"
                  placeholder="We are performing scheduled maintenance..."
                />
              </div>
            )}
          </div>
          <button
            onClick={() => setShowMaintenanceConfirm(true)}
            className={`px-4 py-2 rounded-lg font-semibold transition-colors ${
              formData.maintenanceMode
                ? 'bg-green-600 hover:bg-green-700'
                : 'bg-orange-600 hover:bg-orange-700'
            } text-white`}
          >
            {formData.maintenanceMode ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>

      {/* Registration */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">User Registration</h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">Allow New Registrations</p>
            <p className="text-sm text-gray-400">Users can create new accounts</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={formData.registrationEnabled}
              onChange={(e) =>
                setFormData({ ...formData, registrationEnabled: e.target.checked })
              }
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
          </label>
        </div>

        {!formData.registrationEnabled && (
          <div className="mt-3 flex items-center space-x-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
            <AlertTriangle className="text-yellow-500 flex-shrink-0" size={16} />
            <p className="text-sm text-yellow-400">
              New user registrations are currently disabled
            </p>
          </div>
        )}
      </div>

      {/* Transaction Limits */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">Transaction Limits</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Min Deposit Amount (Rs.)</label>
            <input
              type="number"
              value={formData.minDeposit}
              onChange={(e) =>
                setFormData({ ...formData, minDeposit: (Number(e.target.value) || 0) })
              }
              className="input"
            />
          </div>
          <div>
            <label className="label">Min Withdrawal Amount (Rs.)</label>
            <input
              type="number"
              value={formData.minWithdrawal}
              onChange={(e) =>
                setFormData({ ...formData, minWithdrawal: (Number(e.target.value) || 0) })
              }
              className="input"
            />
          </div>
        </div>
      </div>

      {/* Betting Limits */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">Betting Limits</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Min Bet Amount (Rs.)</label>
            <input
              type="number"
              value={formData.minBet}
              onChange={(e) =>
                setFormData({ ...formData, minBet: (Number(e.target.value) || 0) })
              }
              className="input"
            />
          </div>
          <div>
            <label className="label">Max Bet Amount (Rs.)</label>
            <input
              type="number"
              value={formData.maxBet}
              onChange={(e) =>
                setFormData({ ...formData, maxBet: (Number(e.target.value) || 0) })
              }
              className="input"
            />
          </div>
        </div>

        {formData.minBet > formData.maxBet && (
          <div className="mt-3 flex items-center space-x-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <AlertTriangle className="text-red-500 flex-shrink-0" size={16} />
            <p className="text-sm text-red-400">
              Minimum bet amount cannot be greater than maximum bet amount!
            </p>
          </div>
        )}
      </div>

      {/* Cycle-Wise Limits */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">Cycle-Wise Bet Limits</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="max-30min-bet" className="label">Max Bet -- 30-Min Cycle (Rs.)</label>
            <input id="max-30min-bet" name="max30MinBet" type="number" min="0"
              value={formData.max30MinBet}
              onChange={(e) => setFormData({ ...formData, max30MinBet: (Number(e.target.value) || 0) })}
              className="input" />
          </div>
          <div>
            <label htmlFor="max-fullday-bet" className="label">Max Bet -- Full Day Cycle (Rs.)</label>
            <input id="max-fullday-bet" name="maxFullDayBet" type="number" min="0"
              value={formData.maxFullDayBet}
              onChange={(e) => setFormData({ ...formData, maxFullDayBet: (Number(e.target.value) || 0) })}
              className="input" />
          </div>
          <div>
            <label htmlFor="max-withdrawal" className="label">Max Winnings Withdrawal (Rs.)</label>
            <input id="max-withdrawal" name="maxWinningsWithdrawal" type="number" min="0"
              value={formData.maxWinningsWithdrawal}
              onChange={(e) => setFormData({ ...formData, maxWinningsWithdrawal: (Number(e.target.value) || 0) })}
              className="input" />
            <p className="text-xs text-gray-400 mt-1">Maximum single withdrawal from winnings balance</p>
          </div>
        </div>
      </div>

      {/* ── BETTING MONEY RULES (Phase A) ──────────────────────────────────── */}
      <div className="card border-2 border-gold-500/30">
        <h3 className="text-lg font-semibold mb-1">Betting Money Rules</h3>
        <p className="text-xs text-gray-400 mb-4">
          The core money rules of the cycle market. Every value here drives real behavior
          the moment you save — bets and settlements pick it up immediately.
        </p>

        <div className="space-y-5">
          <div>
            <label className="label">Bet Reserve Percent (%)</label>
            <input
              type="number" min={0} max={100} step={0.01}
              value={formData.betReservePercent}
              onChange={(e) => setFormData({ ...formData, betReservePercent: Number(e.target.value) })}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              What share of every bet stake is taken from the user's <strong>reserve wallet</strong>;
              the rest comes from the deposit wallet first, then winnings. If the reserve runs short,
              the shortfall shifts to the other wallets automatically.
            </p>
            <p className="text-xs text-gold-400/80 mt-1">
              Example with {formData.betReservePercent}%: a ₹100 bet takes
              ₹{(Math.floor(10000 * Math.round(formData.betReservePercent * 100) / 10000) / 100).toFixed(2)} from
              reserve and ₹{(100 - Math.floor(10000 * Math.round(formData.betReservePercent * 100) / 10000) / 100).toFixed(2)} from
              deposit/winnings. Paise-exact — the parts always add up to the stake.
            </p>
          </div>

          <div className="pt-4 border-t border-dark-700">
            <label className="label">Winnings Platform Fee (%)</label>
            <input
              type="number" min={0} max={100} step={0.01}
              value={formData.winningsFeePercent}
              onChange={(e) => setFormData({ ...formData, winningsFeePercent: Number(e.target.value) })}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              The platform's cut of gross winnings at settlement. Winners are paid
              2× their stake minus this fee; the fee goes to platform revenue in the ledger
              (and becomes distributable — e.g. for merchant bonuses). Set 0 for a flat 2× payout.
            </p>
            <p className="text-xs text-gold-400/80 mt-1">
              Example with {formData.winningsFeePercent}%: bet ₹100 → win gross ₹200 → fee
              ₹{(Math.floor(20000 * Math.round(formData.winningsFeePercent * 100) / 10000) / 100).toFixed(2)} → user
              receives ₹{(200 - Math.floor(20000 * Math.round(formData.winningsFeePercent * 100) / 10000) / 100).toFixed(2)} in
              the winnings wallet. The fee is rounded down — never against the user.
            </p>
          </div>

          <div className="pt-4 border-t border-dark-700">
            <label className="label">Withdrawal Payout Fee (%)</label>
            <input
              type="number" min={0} max={100} step={0.01}
              value={formData.payoutFeePercent}
              onChange={(e) => setFormData({ ...formData, payoutFeePercent: Number(e.target.value) })}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              Fee charged when a user sells tokens back (withdrawal). The user receives
              tokens − fee in INR; the fee posts to the PAYOUT_FEES ledger account. 0 = no fee.
            </p>
            <p className="text-xs text-gold-400/80 mt-1">
              Example with {formData.payoutFeePercent}%: withdrawing 1000 tokens pays out
              ₹{(1000 - Math.floor(100000 * Math.round(formData.payoutFeePercent * 100) / 10000) / 100).toFixed(2)}.
            </p>
          </div>

          <div className="pt-4 border-t border-dark-700 space-y-4">
            <div className="flex items-center justify-between">
              <div className="pr-4">
                <p className="font-medium">Enforce Multiples of 10</p>
                <p className="text-xs text-gray-500">
                  Buy, sell and bet amounts must be multiples of 10 tokens (e.g. 10, 50, 200 — not 15).
                  Keeps amounts clean for P2P cash handling.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" checked={formData.riskRules.enforceMultiplesOf10}
                  onChange={(e) => setFormData({ ...formData, riskRules: { ...formData.riskRules, enforceMultiplesOf10: e.target.checked } })}
                  className="sr-only peer" />
                <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
              </label>
            </div>

            <div className="flex items-center justify-between">
              <div className="pr-4">
                <p className="font-medium">Block Opposite-Side Betting</p>
                <p className="text-xs text-gray-500">
                  Stops a user betting both DELHI and BOMBAY in the same cycle
                  (wash-bet / guaranteed-arbitrage prevention).
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" checked={formData.riskRules.blockOppositeSideBetting}
                  onChange={(e) => setFormData({ ...formData, riskRules: { ...formData.riskRules, blockOppositeSideBetting: e.target.checked } })}
                  className="sr-only peer" />
                <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
              </label>
            </div>

            <div>
              <label className="label">Funding Velocity Limit (orders per hour per user)</label>
              <input
                type="number" min={0} step={1}
                value={formData.riskRules.maxFundingOrdersPerHour}
                onChange={(e) => setFormData({ ...formData, riskRules: { ...formData.riskRules, maxFundingOrdersPerHour: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })}
                className="input"
              />
              <p className="text-xs text-gray-500 mt-1">
                Maximum deposit/withdrawal requests a single user may create per hour.
                0 = unlimited (off). Cancelled orders count — churn is velocity too.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── CYCLE TIMING (Phase X X-5) ──────────────────────────────────────── */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-1">Cycle Timing</h3>
        <p className="text-xs text-gray-400 mb-4">
          How long each short betting cycle stays open. Takes effect on the next
          cycle the generator creates.
        </p>
        <div>
          <label className="label">Short Cycle Duration</label>
          <select
            className="input"
            value={formData.cycleDurationMinutes}
            onChange={(e) => setFormData({ ...formData, cycleDurationMinutes: Number(e.target.value) })}
          >
            {[10, 12, 15, 20, 30, 60].map((m) => (
              <option key={m} value={m}>{m} minutes</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Must divide 60 evenly so cycles line up with the clock (e.g. a 15-minute
            cycle starts at :00, :15, :30, :45). The cycle is still labelled
            &ldquo;30 Min&rdquo; internally — only its actual length changes.
          </p>
        </div>
      </div>

      {/* App Distribution */}
      <div className="card border-2 border-blue-500/30">
        <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
          <span>📱</span> App Distribution
        </h3>
        <p className="text-xs text-gray-400 mb-4">
          Control where users download the app and force updates. Changes take effect immediately — no redeploy needed.
        </p>

        <div className="space-y-4">
          <div>
            <label className="label">Web App URL</label>
            <input
              type="url"
              value={formData.webUrl}
              onChange={(e) => setFormData({ ...formData, webUrl: e.target.value })}
              className="input"
              placeholder="https://your-user-panel.up.railway.app"
            />
            <p className="text-xs text-gray-500 mt-1">The link users share via the "Share Link" button. Update here when you change your Railway domain.</p>
          </div>

          <div>
            <label className="label">Android APK URL</label>
            <input
              type="url"
              value={formData.androidUrl}
              onChange={(e) => setFormData({ ...formData, androidUrl: e.target.value })}
              className="input"
              placeholder="https://your-cdn.com/app-v1.0.0.apk"
            />
            <p className="text-xs text-gray-500 mt-1">Direct link to the APK file. Get this from PWABuilder after building. The Download button in the app points here.</p>
          </div>

          <div>
            <label className="label">iOS URL <span className="text-gray-500 font-normal">(optional)</span></label>
            <input
              type="url"
              value={formData.iosUrl}
              onChange={(e) => setFormData({ ...formData, iosUrl: e.target.value })}
              className="input"
              placeholder="https://apps.apple.com/... (leave blank for Add to Home Screen)"
            />
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2 border-t border-dark-700">
            <div>
              <label className="label">Minimum Version</label>
              <input
                type="text"
                value={formData.minVersion}
                onChange={(e) => setFormData({ ...formData, minVersion: e.target.value })}
                className="input font-mono"
                placeholder="1.0.0"
              />
              <p className="text-xs text-gray-500 mt-1">Users below this version see a forced update screen and cannot use the app until they refresh.</p>
            </div>
            <div>
              <label className="label">Latest Version</label>
              <input
                type="text"
                value={formData.latestVersion}
                onChange={(e) => setFormData({ ...formData, latestVersion: e.target.value })}
                className="input font-mono"
                placeholder="1.0.0"
              />
              <p className="text-xs text-gray-500 mt-1">Shown to users on the update screen. Update this when you release a new APK.</p>
            </div>
          </div>

          <div className="bg-yellow-900/20 border border-yellow-500/30 rounded-lg p-3">
            <p className="text-xs text-yellow-300">
              <strong>How forced updates work:</strong> Set Minimum Version to the new version number (e.g. 1.1.0). Any user whose app reports version 1.0.x will immediately see the "Update Available" screen and cannot proceed until they tap Update & Restart. This clears their cache and loads the latest code.
            </p>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={isSaving || (formData.minBet > formData.maxBet)}
        className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
      >
        {isSaving ? (
          'Saving...'
        ) : (
          <>
            <Save className="mr-2" size={16} />
            Save Settings
          </>
        )}
      </button>

      {/* Maintenance Confirmation */}
      <ConfirmDialog
        isOpen={showMaintenanceConfirm}
        onClose={() => setShowMaintenanceConfirm(false)}
        onConfirm={handleToggleMaintenance}
        title={formData.maintenanceMode ? 'Disable Maintenance Mode' : 'Enable Maintenance Mode'}
        message={
          formData.maintenanceMode
            ? 'Platform will be accessible to all users'
            : 'Platform will be inaccessible to users. Only admins can login.'
        }
        type="warning"
      />
    </div>
  );
};
