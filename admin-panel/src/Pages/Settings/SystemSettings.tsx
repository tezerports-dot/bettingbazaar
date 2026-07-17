// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Save, Power, AlertTriangle } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import api from '../../services/api';
import toast from 'react-hot-toast';

// C-05 fix: tokenBuyRate/tokenSellRate removed from SystemSettings.
// Token conversion is fixed 1:1; the old TokenRates admin page/model is retired.
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
    // Business Config Audit (2026-07-11) — formerly-hardcoded business values
    payoutMultiplier: 2,       // schema default: 2 (2x)
    orderExpiryMinutes: 15,    // schema default: 15
    cyclePhases: {
      thirtyMin: { mergeBeforeEndSec: 180, equalizerBeforeEndSec: 120, closeBeforeEndSec: 30, celebrateBeforeEndSec: 10 },
      fullDay:   { mergeBeforeEndSec: 300, equalizerBeforeEndSec: 120, closeBeforeEndSec: 30, celebrateBeforeEndSec: 10 },
    },
    riskRules: {
      enforceMultiplesOf10: true,      // schema default: true
      blockOppositeSideBetting: false, // schema default: false
      maxFundingOrdersPerHour: 0,      // schema default: 0 (off)
      maxWarnings: 3,                  // schema default: 3 (0 = never auto-block)
    },
    // Footer navigation (2026-07-13) — schema default: the historical five tabs
    footerPages: ['home', 'results', 'winners', 'promo', 'profile'],
    // Operational alert webhook (2026-07-13) — '' = alerting off
    alertWebhookUrl: '',
    tlsFingerprintDefense: {
      enabled: true,
      logOnly: true,
      requireJa3Hash: false,
      blockJa3Hashes: [] as string[],
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
          payoutMultiplier:   response.data.payoutMultiplier   ?? 2,  // schema default: 2
          orderExpiryMinutes: response.data.orderExpiryMinutes ?? 15, // schema default: 15
          cyclePhases: {
            thirtyMin: {
              mergeBeforeEndSec:     response.data.cyclePhases?.thirtyMin?.mergeBeforeEndSec     ?? 180,
              equalizerBeforeEndSec: response.data.cyclePhases?.thirtyMin?.equalizerBeforeEndSec ?? 120,
              closeBeforeEndSec:     response.data.cyclePhases?.thirtyMin?.closeBeforeEndSec     ?? 30,
              celebrateBeforeEndSec: response.data.cyclePhases?.thirtyMin?.celebrateBeforeEndSec ?? 10,
            },
            fullDay: {
              mergeBeforeEndSec:     response.data.cyclePhases?.fullDay?.mergeBeforeEndSec     ?? 300,
              equalizerBeforeEndSec: response.data.cyclePhases?.fullDay?.equalizerBeforeEndSec ?? 120,
              closeBeforeEndSec:     response.data.cyclePhases?.fullDay?.closeBeforeEndSec     ?? 30,
              celebrateBeforeEndSec: response.data.cyclePhases?.fullDay?.celebrateBeforeEndSec ?? 10,
            },
          },
          riskRules: {
            enforceMultiplesOf10:     response.data.riskRules?.enforceMultiplesOf10     ?? true,
            blockOppositeSideBetting: response.data.riskRules?.blockOppositeSideBetting ?? false,
            maxFundingOrdersPerHour:  response.data.riskRules?.maxFundingOrdersPerHour  ?? 0,
            maxWarnings:              response.data.riskRules?.maxWarnings              ?? 3,
          },
          footerPages: response.data.footerPages?.length ? response.data.footerPages : ['home', 'results', 'winners', 'promo', 'profile'],
          alertWebhookUrl: response.data.alertWebhookUrl || '',
          tlsFingerprintDefense: {
            enabled: response.data.tlsFingerprintDefense?.enabled ?? true,
            logOnly: response.data.tlsFingerprintDefense?.logOnly ?? true,
            requireJa3Hash: response.data.tlsFingerprintDefense?.requireJa3Hash ?? false,
            blockJa3Hashes: response.data.tlsFingerprintDefense?.blockJa3Hashes || [],
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
            <label className="label">Payout Multiplier (×)</label>
            <input
              type="number" min={1} max={10} step={1}
              value={formData.payoutMultiplier}
              onChange={(e) => setFormData({ ...formData, payoutMultiplier: Math.max(1, Math.min(10, Math.floor(Number(e.target.value) || 1))) })}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              Gross payout on a winning bet = stake × this multiplier (before the winnings
              fee below). The default 2 pays winners double their stake. Whole number, 1–10.
            </p>
            <p className="text-xs text-gold-400/80 mt-1">
              Example with {formData.payoutMultiplier}×: a ₹100 winning bet returns gross
              ₹{100 * formData.payoutMultiplier} before the winnings fee.
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
              {' '}{formData.payoutMultiplier}× their stake minus this fee; the fee goes to platform revenue in the ledger
              (and becomes distributable — e.g. for merchant bonuses). Set 0 for a flat {formData.payoutMultiplier}× payout.
            </p>
            <p className="text-xs text-gold-400/80 mt-1">
              Example with {formData.winningsFeePercent}%: bet ₹100 → win gross ₹{100 * formData.payoutMultiplier} → fee
              ₹{(Math.floor(100 * formData.payoutMultiplier * 100 * Math.round(formData.winningsFeePercent * 100) / 10000) / 100).toFixed(2)} → user
              receives ₹{(100 * formData.payoutMultiplier - Math.floor(100 * formData.payoutMultiplier * 100 * Math.round(formData.winningsFeePercent * 100) / 10000) / 100).toFixed(2)} in
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

            <div>
              <label className="label">Auto-Block After N Payment Warnings</label>
              <input
                type="number" min={0} step={1}
                value={formData.riskRules.maxWarnings}
                onChange={(e) => setFormData({ ...formData, riskRules: { ...formData.riskRules, maxWarnings: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })}
                className="input"
              />
              <p className="text-xs text-gray-500 mt-1">
                A user is auto-blocked once a merchant has rejected their payment this many
                times. Each merchant rejection adds one warning. 0 = never auto-block (off).
              </p>
            </div>

            <div>
              <label className="label">Payment Order Expiry (minutes)</label>
              <input
                type="number" min={1} max={1440} step={1}
                value={formData.orderExpiryMinutes}
                onChange={(e) => setFormData({ ...formData, orderExpiryMinutes: Math.max(1, Math.min(1440, Math.floor(Number(e.target.value) || 1))) })}
                className="input"
              />
              <p className="text-xs text-gray-500 mt-1">
                How long a user has to pay the assigned merchant before the order auto-expires
                and any locked balance is refunded. Applies to new assignments only. 1–1440 min.
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

        <div className="pt-4 mt-4 border-t border-dark-700">
          <label className="label">Cycle Phase Timings (seconds before cycle end)</label>
          <p className="text-xs text-gray-500 mb-3">
            When each phase fires inside a cycle, measured in seconds before its end.
            Values must strictly decrease: Merge &gt; Equalizer &gt; Close &gt; Celebrate.
            Takes effect within ~30 seconds.
          </p>
          {([['thirtyMin', '30-Min Cycle'], ['fullDay', 'Full-Day Cycle']] as const).map(([key, label]) => (
            <div key={key} className="mb-3">
              <p className="text-sm font-medium mb-1">{label}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {([
                  ['mergeBeforeEndSec', 'Merge'],
                  ['equalizerBeforeEndSec', 'Equalizer'],
                  ['closeBeforeEndSec', 'Close'],
                  ['celebrateBeforeEndSec', 'Celebrate'],
                ] as const).map(([field, flabel]) => (
                  <div key={field}>
                    <label className="text-xs text-gray-400">{flabel}</label>
                    <input
                      type="number" min={0} step={1}
                      value={formData.cyclePhases[key][field]}
                      onChange={(e) => setFormData({
                        ...formData,
                        cyclePhases: {
                          ...formData.cyclePhases,
                          [key]: {
                            ...formData.cyclePhases[key],
                            [field]: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                          },
                        },
                      })}
                      className="input"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── FOOTER NAVIGATION (2026-07-13) — admin-editable user-panel tabs ── */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-1">Footer Navigation (User Panel)</h3>
        <p className="text-xs text-gray-400 mb-4">
          Choose which pages appear in the user panel&apos;s bottom bar and in what
          order (2–5 tabs). Applies live to all connected users — no redeploy.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[0, 1, 2, 3, 4].map((i) => {
            const FOOTER_PAGE_OPTIONS: [string, string][] = [
              ['home', '🎲 Game'], ['results', '📊 Results'], ['winners', '🏆 Winners'],
              ['promo', '💡 Pro Tips'], ['profile', '👤 Profile'], ['wallet', '💰 Wallet'],
              ['invite', '🤝 Invite'], ['vip', '👑 VIP'], ['gift-code', '🎁 Gifts'],
              ['my-bets', '📜 My Bets'], ['history', '🕘 History'], ['rules', '📖 Rules'],
              ['faq', '❓ FAQ'], ['support', '🛟 Support'],
              ['casino', '🎰 Casino'], ['crash', '🚀 Crash'], ['sports', '⚽ Sports'],
            ];
            const current = formData.footerPages[i] || '';
            const usedElsewhere = formData.footerPages.filter((_, j) => j !== i);
            return (
              <div key={i}>
                <label className="text-[10px] text-gray-500 uppercase font-bold block mb-1">Slot {i + 1}</label>
                <select
                  className="input"
                  value={current}
                  onChange={(e) => {
                    const slots = [0, 1, 2, 3, 4].map(j => (j === i ? e.target.value : (formData.footerPages[j] || '')));
                    setFormData({ ...formData, footerPages: slots.filter(Boolean) });
                  }}
                >
                  <option value="">— empty —</option>
                  {FOOTER_PAGE_OPTIONS.map(([key, label]) => (
                    <option key={key} value={key} disabled={usedElsewhere.includes(key)}>{label}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-gray-500 mt-2">
          At least 2 tabs required; duplicates are disabled. Provider pages
          (Casino/Crash/Sports) still only show when that provider is enabled.
        </p>
      </div>

      {/* ── OPERATIONAL ALERTS (plan item 38, 2026-07-13) ── */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-1">Operational Alerts</h3>
        <p className="text-xs text-gray-400 mb-4">
          Money-critical failures (ledger reconciliation errors, settlement
          failures) POST a JSON alert to this webhook. Slack incoming-webhook
          format — Slack, Discord (with /slack suffix), Mattermost, or any HTTP
          collector works. Leave empty to disable.
        </p>
        <label className="label">Alert Webhook URL</label>
        <input
          type="url"
          value={formData.alertWebhookUrl}
          onChange={(e) => setFormData({ ...formData, alertWebhookUrl: e.target.value.trim() })}
          placeholder="https://hooks.slack.com/services/…"
          className="input"
        />
        <p className="text-xs text-gray-500 mt-1">
          Must be https. Same alert fires at most once per 10 minutes (anti-flood).
        </p>
      </div>


      {/* ── TLS / JA3 FINGERPRINT DEFENSE ─────────────────────────────────── */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-1">TLS / JA3 Fingerprint Defense</h3>
        <p className="text-xs text-gray-400 mb-4">
          JA3 is calculated from the client TLS handshake by your edge proxy/CDN, then
          forwarded to the app as <code>x-ja3-hash</code> or <code>x-tls-ja3-hash</code>.
          The app cannot randomize a user's browser handshake; this panel controls
          logging and enforcement for the JA3 signal on every request.
        </p>
        <div className="space-y-4">
          {([
            ['enabled', 'Enable JA3 Policy', 'Reads JA3 headers on every request and applies the rules below.'],
            ['logOnly', 'Log Only Mode', 'When on, violations are logged but not blocked. Turn off only after your TLS edge forwards JA3 reliably.'],
            ['requireJa3Hash', 'Require JA3 Hash', 'Blocks requests missing a JA3 hash when Log Only Mode is off.'],
          ] as const).map(([field, label, help]) => (
            <div key={field} className="flex items-center justify-between">
              <div className="pr-4">
                <p className="font-medium">{label}</p>
                <p className="text-xs text-gray-500">{help}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.tlsFingerprintDefense[field]}
                  onChange={(e) => setFormData({
                    ...formData,
                    tlsFingerprintDefense: { ...formData.tlsFingerprintDefense, [field]: e.target.checked },
                  })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
              </label>
            </div>
          ))}

          <div>
            <label className="label">Blocked JA3 Hashes</label>
            <textarea
              value={formData.tlsFingerprintDefense.blockJa3Hashes.join('\n')}
              onChange={(e) => setFormData({
                ...formData,
                tlsFingerprintDefense: {
                  ...formData.tlsFingerprintDefense,
                  blockJa3Hashes: e.target.value.split(/[\n,\s]+/).map(v => v.trim().toLowerCase()).filter(Boolean),
                },
              })}
              className="input min-h-[96px] font-mono text-xs"
              placeholder="32-char JA3 MD5 hash, one per line"
            />
            <p className="text-xs text-gray-500 mt-1">
              Known-bad JA3 hashes are denied when Log Only Mode is off. Keep Log Only on until you verify your edge forwards JA3 for all traffic.
            </p>
          </div>
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
