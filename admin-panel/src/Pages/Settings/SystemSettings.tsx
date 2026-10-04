// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Save, Power, AlertTriangle } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import api from '../../services/api';
import toast from 'react-hot-toast';
import TwoFactorSetup from '../../components/TwoFactorSetup';

// BB token buy/sell rates remain removed: internal token conversion is fixed 1:1.
// USDT pricing below is buy-only: no user or merchant USDT sell rail exists.
// §5 MIRROR — the operational half of `merchantOrderLimits`.
// Backend owner: `SYSTEM_CONFIG_SPEC.fields.merchantOrderLimits.fields` in
// `database/spec/config.spec.js`; served and accepted by
// `backend/routes/admin/system.admin.routes.js`, both of which derive from that
// spec so a field is editable the moment it is declared there.
//
// `min`/`max` repeat the spec's bounds so the input refuses out-of-range values
// before the round trip; the server validates against the spec regardless, so
// this is a convenience and never the authority. `fallback` is a LOADING
// placeholder only (§4) and equals the spec default cited beside it — the GET
// fills every key from the spec, so after load nothing here is read.
const MERCHANT_ORDER_RULES: Array<{
  key: string; label: string; min: number; max: number; fallback: number; help: string;
}> = [
  { key: 'maxConsecutiveRejections', label: 'Consecutive Refusals Before Suspension',
    min: 1, max: 20, fallback: 3,   // spec default: 3
    help: 'Declines and unanswered PAID buys in a row before the merchant is suspended. Any completed order resets the streak. Lifted by an admin, never by a timer.' },
  { key: 'paidResponseMinutes', label: 'Merchant Response Window on a PAID Buy (minutes)',
    min: 5, max: 1440, fallback: 30,   // spec default: 30
    help: 'The player has already paid. After this long with no answer the order goes to the dispute queue for a human, and the silence counts as a refusal.' },
  { key: 'utrAfterPaidMinutes', label: 'Cash Buy: Reference Due After Paid (minutes)',
    min: 2, max: 60, fallback: 15,   // spec default: 15
    help: 'On the cash rail the player taps Paid at the machine and the bank reference follows. Missing this window sends the order to the admin queue, never to cancelled — the cash may have been dispensed.' },
  { key: 'maxConsecutivePlayerPaymentFailures', label: 'Player Unpaid Buys Before Cool-off',
    min: 1, max: 50, fallback: 3,   // spec default: 3
    help: 'Buy orders a player lets expire without paying, in a row, before they are flagged and cannot open a new order. Cleared when a payment actually arrives.' },
  { key: 'playerOrderLockMinutes', label: 'Player Cool-off Length (minutes)',
    min: 1, max: 1440, fallback: 60,   // spec default: 60
    help: 'How long that player cannot open a new order, on BOTH rails. It lifts itself; no admin action is needed.' },
  { key: 'maxConsecutiveMerchantExpiries', label: 'Expiries Before Assignment is Paused',
    min: 1, max: 20, fallback: 3,   // spec default: 3
    help: 'Buy orders sent to one merchant that expired unpaid, in a row. Most often it means that merchant cannot BE paid (dead QR, closed handle). NOT a suspension: they keep their orders and standing, and an admin resumes them from the merchant\'s profile.' },
];

// §5 MIRROR — `SYSTEM_CONFIG_SPEC.fields.teamRouting` in
// `database/spec/config.spec.js`, read by `routingSettings` in
// `database/repositories/teamRouting.js`. An order goes to a member of a
// working team on its own rail, so each rail has its own cap and window.
// `min`/`max` repeat the spec's bounds for the input; the server validates
// against the spec and refuses an out-of-range value by name. `fallback` is a
// LOADING placeholder equal to the spec default beside it (§4).
//
// There is no per-rail dispute window here. The two windows a player has to
// dispute in are `rejectedBuyDisputeMinutes` and `withdrawalHoldMinutes`,
// offered beside the withdrawal hold below; a per-rail copy that nothing read
// was removed from the spec (§3).
type RoutingRail = 'CASH' | 'UPI_BANK' | 'USDT';
const ROUTING_RAILS: Array<{
  rail: RoutingRail; label: string;
  concurrency: { min: number; max: number; fallback: number };
  processing: { min: number; max: number; fallback: number };
}> = [
  { rail: 'CASH',     label: 'Cash (ATM)',
    concurrency: { min: 1, max: 10, fallback: 1 },     // spec default: 1
    processing:  { min: 60, max: 7200, fallback: 900 } }, // spec default: 900
  { rail: 'UPI_BANK', label: 'UPI / bank',
    concurrency: { min: 1, max: 20, fallback: 3 },     // spec default: 3
    processing:  { min: 60, max: 7200, fallback: 900 } }, // spec default: 900
  { rail: 'USDT',     label: 'USDT',
    concurrency: { min: 1, max: 20, fallback: 3 },     // spec default: 3
    processing:  { min: 60, max: 7200, fallback: 900 } }, // spec default: 900
];
const ROUTING_TIMERS: Array<{
  key: 'assignmentWaitSeconds' | 'utrSubmitSeconds'; label: string;
  min: number; max: number; fallback: number; help: string;
}> = [
  { key: 'assignmentWaitSeconds', label: 'Queue Wait Before Expiry (seconds)',
    min: 60, max: 86400, fallback: 1500,   // spec default: 1500
    help: 'How long a queued order nobody could take waits for a team member before it expires.' },
  { key: 'utrSubmitSeconds', label: 'Extra Time to Submit a Reference (seconds)',
    min: 15, max: 3600, fallback: 60,   // spec default: 60
    help: 'The one-off grace a player can claim to fetch their payment reference.' },
];

interface TeamRoutingForm {
  concurrency: Record<RoutingRail, number>;
  processingWindowSeconds: Record<RoutingRail, number>;
  assignmentWaitSeconds: number;
  utrSubmitSeconds: number;
  [other: string]: unknown;   // declared keys this screen does not offer, kept as served
}

const routingDefaults = (): TeamRoutingForm => ({
  concurrency: Object.fromEntries(ROUTING_RAILS.map((r) => [r.rail, r.concurrency.fallback])) as Record<RoutingRail, number>,
  processingWindowSeconds: Object.fromEntries(ROUTING_RAILS.map((r) => [r.rail, r.processing.fallback])) as Record<RoutingRail, number>,
  ...Object.fromEntries(ROUTING_TIMERS.map((t) => [t.key, t.fallback])),
} as TeamRoutingForm);

const outOfRange = (v: number, b: { min: number; max: number }) => !Number.isFinite(v) || v < b.min || v > b.max;

// ── The seven order sizes, per rail (§5 mirror) ──────────────────────────────
// Mirrors CASH_SIZES / UPI_BANK_SIZES in backend/domains/merchant/denominations.js,
// the only legal values of SystemConfig.orderSizes. Display only: the server
// refuses anything else, and the GET serves the list actually on offer.
const ORDER_SIZE_RAILS: Array<{ rail: string; label: string; sizes: number[] }> = [
  { rail: 'CASH', label: 'Cash (member at an ATM)', sizes: [500, 1000, 5000, 10000] },
  { rail: 'UPI_BANK', label: 'UPI / bank', sizes: [50000, 100000, 500000] },
];
const ALL_ORDER_SIZES = ORDER_SIZE_RAILS.flatMap((r) => r.sizes);
// Mirrors USDT_BUY_STEP (denominations.js) and the spec's usdtBuy defaults.
const USDT_BUY_STEP = 100;
const usdtStepOk = (v: number) => Number.isInteger(v) && v >= USDT_BUY_STEP && v <= 100000 && v % USDT_BUY_STEP === 0;

export const SystemSettings: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showMaintenanceConfirm, setShowMaintenanceConfirm] = useState(false);

  const [formData, setFormData] = useState({
    maintenanceMode: false,
    maintenanceMessage: '',
    registrationEnabled: true,
    // The sizes on offer (Step 2d). Schema default: all seven.
    orderSizes: [...ALL_ORDER_SIZES] as number[],
    usdtBuy: { minUsdt: 100, maxUsdt: 10000 },   // schema defaults: 100 / 10,000
    maxBalanceAdjustment: 1000000, // schema default: 1000000 (₹10,00,000)
    minBet: 10,           // schema default: 10
    maxBet: 100000,       // schema default: 100000 (was 50000 here — §4 drift)
    max30MinBet: 50000,
    maxFullDayBet: 100000,
    // ── Money rules (Phase A + Risk Platform) — consumed by bet.routes.js,
    //    gameEngine.js and riskValidation.service.js on the backend ──────────
    betReservePercent: 1,      // schema default: 1
    winningsFeePercent: 1,     // schema default: 1
    payoutFeePercent: 0,       // schema default: 0
    usdtPricing: { userMerchantBuyInr: 0, merchantAdminBuyInr: 0 },
    // Every key the spec declares, so every one is sent back on save. The
    // operational half is seeded from MERCHANT_ORDER_RULES rather than restated.
    merchantOrderLimits: {
      ...Object.fromEntries(MERCHANT_ORDER_RULES.map((r) => [r.key, r.fallback])),
    } as Record<string, number>,
    // Per-rail caps and windows for team routing, seeded from ROUTING_RAILS /
    // ROUTING_TIMERS rather than restated.
    teamRouting: routingDefaults(),
    cycleDurationMinutes: 30,  // schema default: 30 (Phase X X-5)
    // Business Config Audit (2026-07-11) — formerly-hardcoded business values
    payoutMultiplier: 2,       // schema default: 2 (2x)
    cyclePhases: {
      // The one-minute board is declared in the spec and run by the engine, and
      // was missing from BOTH halves of this screen and from the route's own
      // response — a board whose phase timings nobody could see or change.
      oneMin:    { mergeBeforeEndSec: 12,  equalizerBeforeEndSec: 9,   closeBeforeEndSec: 5,  celebrateBeforeEndSec: 3 },  // schema defaults: 12/9/5/3
      thirtyMin: { mergeBeforeEndSec: 180, equalizerBeforeEndSec: 120, closeBeforeEndSec: 30, celebrateBeforeEndSec: 10 },
      fullDay:   { mergeBeforeEndSec: 300, equalizerBeforeEndSec: 120, closeBeforeEndSec: 30, celebrateBeforeEndSec: 10 },
    },
    // How long a sell stays in escrow after the member marks it paid.
    withdrawalHoldMinutes: 60,  // schema default: 60 (also the floor)
    // How long a player has to dispute a buy the member rejected as unpaid.
    rejectedBuyDisputeMinutes: 15,  // schema default: 15
    // The daily red flags on teams (Step 2f): low activity, commission farming.
    redFlags: { lowActivityPercent: 25, farmingMinRounds: 3, farmingHedgePercent: 80 },  // schema defaults: 25 / 3 / 80
    // Overload ceilings — past either one the server answers 503 fast rather
    // than admitting work into a queue that will never drain.
    loadShedding: { enabled: true, maxInFlight: 300, maxEventLoopLagMs: 0 },  // schema defaults: true / 300 / 0
    // IP-rotation defence. `max: 0` means that surge layer is off.
    ipDefense: {
      enabled: true, subnetMultiplier: 8,  // schema defaults: true / 8
      surge: {
        auth:       { windowSec: 60, max: 0 },  // schema defaults: 60 / 0
        withdrawal: { windowSec: 60, max: 0 },  // schema defaults: 60 / 0
        funding:    { windowSec: 60, max: 0 },  // schema defaults: 60 / 0
      },
    },
    riskRules: {
      enforceMultiplesOf10: true,      // schema default: true
      blockOppositeSideBetting: false, // schema default: false
      maxFundingOrdersPerHour: 0,      // schema default: 0 (off)
      maxDepositOrdersPerMinute: 1,    // schema default: 1 (0 = off)
      maxWarnings: 3,                  // schema default: 3 (0 = never mark for review)
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
          // `??` rather than `||` throughout: 0 is a value an operator may
          // legitimately set, and `||` silently replaces it with the default.
          orderSizes: Array.isArray(response.data.orderSizes) ? response.data.orderSizes : [...ALL_ORDER_SIZES],
          usdtBuy: {
            minUsdt: response.data.usdtBuy?.minUsdt ?? 100,    // schema default: 100
            maxUsdt: response.data.usdtBuy?.maxUsdt ?? 10000,  // schema default: 10,000
          },
          maxBalanceAdjustment: response.data.maxBalanceAdjustment ?? 1000000, // schema default: 1000000
          minBet: response.data.minBet ?? 10,                 // schema default: 10
          maxBet: response.data.maxBet ?? 100000,             // schema default: 100000
          max30MinBet: response.data.max30MinBet || 50000,
          maxFullDayBet: response.data.maxFullDayBet || 100000,
          betReservePercent:  response.data.betReservePercent  ?? 1, // schema default: 1
          winningsFeePercent: response.data.winningsFeePercent ?? 1, // schema default: 1
          payoutFeePercent:   response.data.payoutFeePercent   ?? 0, // schema default: 0
          usdtPricing: {
            userMerchantBuyInr:  response.data.usdtPricing?.userMerchantBuyInr  ?? 0, // schema default: 0
            merchantAdminBuyInr: response.data.usdtPricing?.merchantAdminBuyInr ?? 0, // schema default: 0 (unset)
          },
          // The GET derives from the spec and fills EVERY key with its default,
          // so the server's object is taken whole. The placeholders underneath
          // it exist only for a response that predates a newly declared field.
          merchantOrderLimits: {
            ...Object.fromEntries(MERCHANT_ORDER_RULES.map((r) => [r.key, r.fallback])),
            ...(response.data.merchantOrderLimits ?? {}),
          } as Record<string, number>,
          // Taken whole, like merchantOrderLimits: the GET fills every declared
          // key from the spec, and a key this screen does not offer goes back
          // exactly as it came.
          teamRouting: (() => {
            const served = response.data.teamRouting ?? {};
            const d = routingDefaults();
            return {
              ...d, ...served,
              concurrency: { ...d.concurrency, ...(served.concurrency ?? {}) },
              processingWindowSeconds: { ...d.processingWindowSeconds, ...(served.processingWindowSeconds ?? {}) },
            } as TeamRoutingForm;
          })(),
          cycleDurationMinutes: response.data.cycleDurationMinutes ?? 30, // schema default: 30
          payoutMultiplier:   response.data.payoutMultiplier   ?? 2,  // schema default: 2
          cyclePhases: {
            oneMin: {
              mergeBeforeEndSec:     response.data.cyclePhases?.oneMin?.mergeBeforeEndSec     ?? 12, // schema default: 12
              equalizerBeforeEndSec: response.data.cyclePhases?.oneMin?.equalizerBeforeEndSec ?? 9,  // schema default: 9
              closeBeforeEndSec:     response.data.cyclePhases?.oneMin?.closeBeforeEndSec     ?? 5,  // schema default: 5
              celebrateBeforeEndSec: response.data.cyclePhases?.oneMin?.celebrateBeforeEndSec ?? 3,  // schema default: 3
            },
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
            maxDepositOrdersPerMinute: response.data.riskRules?.maxDepositOrdersPerMinute ?? 1,
            maxWarnings:              response.data.riskRules?.maxWarnings              ?? 3,
          },
          withdrawalHoldMinutes: response.data.withdrawalHoldMinutes ?? 60, // schema default: 60
          rejectedBuyDisputeMinutes: response.data.rejectedBuyDisputeMinutes ?? 15, // schema default: 15
          redFlags: {
            lowActivityPercent:  response.data.redFlags?.lowActivityPercent  ?? 25, // schema default: 25
            farmingMinRounds:    response.data.redFlags?.farmingMinRounds    ?? 3,  // schema default: 3
            farmingHedgePercent: response.data.redFlags?.farmingHedgePercent ?? 80, // schema default: 80
          },
          loadShedding: {
            enabled:           response.data.loadShedding?.enabled           ?? true, // schema default: true
            maxInFlight:       response.data.loadShedding?.maxInFlight       ?? 300,  // schema default: 300
            maxEventLoopLagMs: response.data.loadShedding?.maxEventLoopLagMs ?? 0,    // schema default: 0
          },
          ipDefense: {
            enabled:          response.data.ipDefense?.enabled          ?? true, // schema default: true
            subnetMultiplier: response.data.ipDefense?.subnetMultiplier ?? 8,    // schema default: 8
            surge: {
              auth: {
                windowSec: response.data.ipDefense?.surge?.auth?.windowSec ?? 60, // schema default: 60
                max:       response.data.ipDefense?.surge?.auth?.max       ?? 0,  // schema default: 0
              },
              withdrawal: {
                windowSec: response.data.ipDefense?.surge?.withdrawal?.windowSec ?? 60, // schema default: 60
                max:       response.data.ipDefense?.surge?.withdrawal?.max       ?? 0,  // schema default: 0
              },
              funding: {
                windowSec: response.data.ipDefense?.surge?.funding?.windowSec ?? 60, // schema default: 60
                max:       response.data.ipDefense?.surge?.funding?.max       ?? 0,  // schema default: 0
              },
            },
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

      {/* Account security — THIS admin's own second factor, not a
          platform-wide setting. It sits first because an operator who has not
          enrolled is the single most valuable unprotected credential on the
          platform (docs/PROJECT_STATUS.md §3.3). */}
      <TwoFactorSetup />

      {/* Maintenance Mode Warning */}
      {formData.maintenanceMode && (
        <div className="bg-orange-500/10 border-2 border-orange-500/50 rounded-lg p-4">
          <div className="flex items-start space-x-3">
            <AlertTriangle className="text-orange-500 shrink-0 mt-0.5" size={24} />
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
                <label className="label" htmlFor="maintenance-message">Maintenance Message</label>
                <textarea id="maintenance-message"
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
              aria-label="Allow new registrations"
              checked={formData.registrationEnabled}
              onChange={(e) =>
                setFormData({ ...formData, registrationEnabled: e.target.checked })
              }
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-700 peer-focus:outline-hidden rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
          </label>
        </div>

        {!formData.registrationEnabled && (
          <div className="mt-3 flex items-center space-x-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
            <AlertTriangle className="text-yellow-500 shrink-0" size={16} />
            <p className="text-sm text-yellow-400">
              New user registrations are currently disabled
            </p>
          </div>
        )}
      </div>

      {/* Order sizes (Step 2d) */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-1">Order Sizes</h3>
        <p className="text-xs text-gray-500 mb-4">
          Every buy and sell is exactly one of these sizes, in tokens. The size decides the rail:
          cash sizes go to a member at an ATM, UPI/bank sizes to a UPI or bank team. Untick a size
          to stop offering it; at least one must stay on.
        </p>
        <div className="space-y-3">
          {ORDER_SIZE_RAILS.map((group) => (
            <fieldset key={group.rail}>
              <legend className="label">{group.label}</legend>
              <div className="flex flex-wrap gap-4">
                {group.sizes.map((size) => {
                  const id = `order-size-${size}`;
                  return (
                    <label key={size} htmlFor={id} className="flex items-center gap-2 text-sm">
                      <input id={id} type="checkbox"
                        checked={formData.orderSizes.includes(size)}
                        onChange={(e) => setFormData({
                          ...formData,
                          orderSizes: e.target.checked
                            ? ALL_ORDER_SIZES.filter((s) => s === size || formData.orderSizes.includes(s))
                            : formData.orderSizes.filter((s) => s !== size),
                        })}
                      />
                      {size.toLocaleString('en-IN')}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
        {formData.orderSizes.length === 0 && (
          <div role="alert" className="mt-3 flex items-center space-x-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <AlertTriangle className="text-red-500 shrink-0" size={16} />
            <p className="text-sm text-red-400">
              Keep at least one size on offer — with none, no player could buy or sell.
            </p>
          </div>
        )}

        {/* An admin adjustment moves money into or out of a player's balance in
            one click. The ceiling is a setting rather than a constant so it is
            an operator's decision, and it is rendered here because a setting
            nobody can reach is §3. */}
        <div className="mt-4">
          <label className="label" htmlFor="max-balance-adjustment">Max Balance Adjustment (Rs., per adjustment)</label>
          <input id="max-balance-adjustment"
            type="number" min={0}
            value={formData.maxBalanceAdjustment}
            onChange={(e) => setFormData({ ...formData, maxBalanceAdjustment: (Number(e.target.value) || 0) })}
            className="input"
          />
          <p className="text-xs text-gray-500 mt-1">
            The most one admin may credit or debit in a single adjustment. A debit is
            capped by the player's balance regardless.
          </p>
        </div>

      </div>

      {/* Betting Limits */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">Betting Limits</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="min-bet-amount-rs">Min Bet Amount (Rs.)</label>
            <input id="min-bet-amount-rs" min="0"
              type="number"
              value={formData.minBet}
              onChange={(e) =>
                setFormData({ ...formData, minBet: (Number(e.target.value) || 0) })
              }
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="max-bet-amount-rs">Max Bet Amount (Rs.)</label>
            <input id="max-bet-amount-rs" min="0"
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
            <AlertTriangle className="text-red-500 shrink-0" size={16} />
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
            <label className="label" htmlFor="bet-reserve-percent">Bet Reserve Percent (%)</label>
            <input id="bet-reserve-percent"
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
            <label className="label" htmlFor="payout-multiplier">Payout Multiplier (×)</label>
            <input id="payout-multiplier"
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
            <label className="label" htmlFor="winnings-platform-fee">Winnings Platform Fee (%)</label>
            <input id="winnings-platform-fee"
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
            <label className="label" htmlFor="usdt-buy-price-user-merchant-inr">USDT Price: Players Buying Tokens (INR per USDT)</label>
            <input id="usdt-buy-price-user-merchant-inr"
              type="number" min={0} step={0.01}
              value={formData.usdtPricing.userMerchantBuyInr}
              onChange={(e) => setFormData({ ...formData, usdtPricing: { ...formData.usdtPricing, userMerchantBuyInr: Math.max(0, Number(e.target.value) || 0) } })}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              What a player pays in USDT when buying tokens: one USDT buys this many tokens (1 token = ₹1).
              Frozen on each order when it is placed. Must be ₹10–₹1,000, or 0 to stop USDT buys.
              There is no USDT sell option.
            </p>
          </div>

          <div className="pt-4 border-t border-dark-700">
            <label className="label" htmlFor="usdt-buy-price-merchant-admin-inr">USDT Price: Team Pool Purchases (INR)</label>
            <input id="usdt-buy-price-merchant-admin-inr"
              type="number" min={0} step={0.01}
              value={formData.usdtPricing.merchantAdminBuyInr}
              onChange={(e) => setFormData({ ...formData, usdtPricing: { ...formData.usdtPricing, merchantAdminBuyInr: Math.max(0, Number(e.target.value) || 0) } })}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              Admin-owned INR price for one USDT when a supervisor pays for team pool tokens in USDT.
              Read when a pool request is fulfilled and frozen on that record, so a later change cannot
              restate a trade that has settled. Must be ₹10–₹1,000, or 0 to refuse USDT pool payments.
            </p>
          </div>


          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-dark-700">
            <div>
              <label className="label" htmlFor="usdt-buy-min">USDT Buy Minimum (USDT)</label>
              <input id="usdt-buy-min"
                type="number" min={USDT_BUY_STEP} max={formData.usdtBuy.maxUsdt} step={USDT_BUY_STEP}
                value={formData.usdtBuy.minUsdt}
                onChange={(e) => setFormData({ ...formData, usdtBuy: { ...formData.usdtBuy, minUsdt: Number(e.target.value) || 0 } })}
                className="input"
              />
              <p className="text-xs text-gray-500 mt-1">The smallest USDT purchase. A multiple of {USDT_BUY_STEP}.</p>
            </div>
            <div>
              <label className="label" htmlFor="usdt-buy-max">USDT Buy Maximum (USDT)</label>
              <input id="usdt-buy-max"
                type="number" min={formData.usdtBuy.minUsdt} max={100000} step={USDT_BUY_STEP}
                value={formData.usdtBuy.maxUsdt}
                onChange={(e) => setFormData({ ...formData, usdtBuy: { ...formData.usdtBuy, maxUsdt: Number(e.target.value) || 0 } })}
                className="input"
              />
              <p className="text-xs text-gray-500 mt-1">
                The largest USDT purchase. Players buy in steps of {USDT_BUY_STEP} USDT between the two; there is no USDT sell.
              </p>
            </div>
          </div>
          {(!usdtStepOk(formData.usdtBuy.minUsdt) || !usdtStepOk(formData.usdtBuy.maxUsdt)
            || formData.usdtBuy.minUsdt > formData.usdtBuy.maxUsdt) && (
            <div role="alert" className="mt-3 flex items-center space-x-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <AlertTriangle className="text-red-500 shrink-0" size={16} />
              <p className="text-sm text-red-400">
                USDT limits must be multiples of {USDT_BUY_STEP} between {USDT_BUY_STEP} and 100,000, with the minimum
                no higher than the maximum.
              </p>
            </div>
          )}

          {/* ── Merchant and player order rules ──────────────────────────────
              Every operational limit the backend acts on, rendered from the
              §5 mirror above. Adding a field to SYSTEM_CONFIG_SPEC and a row to
              MERCHANT_ORDER_RULES is all it takes — no per-field wiring here.

              None of these has a timer attached at the far end: a suspension
              and an assignment pause are both lifted by an admin who has read
              the reason (CLAUDE.md §2). The one clock that lifts itself is the
              player cool-off, which the database's own timestamp expires. */}
          <div className="pt-4 border-t border-dark-700">
            <h3 className="font-semibold mb-1">Merchant &amp; Player Order Rules</h3>
            <p className="text-xs text-gray-500 mb-4">
              These govern what happens when an order is not served. A buy&apos;s CEILING is not here —
              it is the tokens in the serving team&apos;s pool, held when the order is assigned. The FLOOR
              is Minimum Deposit / Minimum Withdrawal above. Per-rail caps and windows are under Team
              Routing below.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {MERCHANT_ORDER_RULES.map((rule) => (
                <div key={rule.key}>
                  <label className="label" htmlFor={`mol-${rule.key}`}>{rule.label}</label>
                  <input
                    id={`mol-${rule.key}`}
                    type="number" min={rule.min} max={rule.max} step={1}
                    value={formData.merchantOrderLimits[rule.key] ?? rule.fallback}
                    onChange={(e) => setFormData({
                      ...formData,
                      merchantOrderLimits: {
                        ...formData.merchantOrderLimits,
                        [rule.key]: Math.min(
                          rule.max,
                          Math.max(rule.min, Math.floor(Number(e.target.value) || rule.min)),
                        ),
                      },
                    })}
                    className="input"
                  />
                  <p className="text-xs text-gray-500 mt-1">{rule.help}</p>
                </div>
              ))}
            </div>
          </div>

          {/* ── Team routing ─────────────────────────────────────────────────
              Every order is offered to a member of a working team on the
              order's own rail. These are that rail's numbers; there is no
              platform-wide rail switch any more. Rendered from the §5 mirror
              above and sent back as `teamRouting`, which the PUT accepts by
              declaration. */}
          <div className="pt-4 border-t border-dark-700">
            <h3 className="font-semibold mb-1">Team Routing</h3>
            <p className="text-xs text-gray-500 mb-4">
              An order goes to a member of a working team on its rail: USDT orders to USDT teams, INR orders up
              to the cash ceiling to Cash teams, larger INR orders to UPI / bank teams. Each rail has its own cap
              and window.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {ROUTING_RAILS.map((r) => {
                const conc = formData.teamRouting.concurrency[r.rail];
                const proc = formData.teamRouting.processingWindowSeconds[r.rail];
                return (
                  <div key={r.rail} className="space-y-3 p-3 bg-dark-800 rounded-lg">
                    <p className="text-sm font-medium">{r.label}</p>
                    <div>
                      <label className="label" htmlFor={`tr-conc-${r.rail}`}>Open orders per member ({r.concurrency.min}–{r.concurrency.max})</label>
                      <input id={`tr-conc-${r.rail}`} type="number" step={1}
                        min={r.concurrency.min} max={r.concurrency.max}
                        value={Number.isFinite(conc) ? conc : ''}
                        onChange={(e) => setFormData({
                          ...formData,
                          teamRouting: {
                            ...formData.teamRouting,
                            concurrency: { ...formData.teamRouting.concurrency, [r.rail]: Math.floor(Number(e.target.value)) },
                          },
                        })}
                        className="input" />
                      {outOfRange(conc, r.concurrency) && (
                        <p role="alert" className="text-xs text-red-400 mt-1">Must be {r.concurrency.min}–{r.concurrency.max}.</p>
                      )}
                    </div>
                    <div>
                      <label className="label" htmlFor={`tr-proc-${r.rail}`}>Window to serve an assigned order (seconds)</label>
                      <input id={`tr-proc-${r.rail}`} type="number" step={1}
                        min={r.processing.min} max={r.processing.max}
                        value={Number.isFinite(proc) ? proc : ''}
                        onChange={(e) => setFormData({
                          ...formData,
                          teamRouting: {
                            ...formData.teamRouting,
                            processingWindowSeconds: { ...formData.teamRouting.processingWindowSeconds, [r.rail]: Math.floor(Number(e.target.value)) },
                          },
                        })}
                        className="input" />
                      {outOfRange(proc, r.processing)
                        ? <p role="alert" className="text-xs text-red-400 mt-1">Must be {r.processing.min}–{r.processing.max} seconds.</p>
                        : <p className="text-xs text-gray-500 mt-1">{Math.round(proc / 60)} min</p>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              {ROUTING_TIMERS.map((t) => {
                const v = formData.teamRouting[t.key];
                return (
                  <div key={t.key}>
                    <label className="label" htmlFor={`tr-${t.key}`}>{t.label}</label>
                    <input id={`tr-${t.key}`} type="number" step={1} min={t.min} max={t.max}
                      value={Number.isFinite(v) ? v : ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        teamRouting: { ...formData.teamRouting, [t.key]: Math.floor(Number(e.target.value)) },
                      })}
                      className="input" />
                    {outOfRange(v, t)
                      ? <p role="alert" className="text-xs text-red-400 mt-1">Must be {t.min}–{t.max} seconds.</p>
                      : <p className="text-xs text-gray-500 mt-1">{t.help}</p>}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="pt-4 border-t border-dark-700">
            <label className="label" htmlFor="withdrawal-payout-fee">Withdrawal Payout Fee (%)</label>
            <input id="withdrawal-payout-fee"
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
                <input type="checkbox" aria-label="Enforce bet amounts in multiples of 10"
                  checked={formData.riskRules.enforceMultiplesOf10}
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
                <input type="checkbox" aria-label="Block opposite-side betting in one cycle"
                  checked={formData.riskRules.blockOppositeSideBetting}
                  onChange={(e) => setFormData({ ...formData, riskRules: { ...formData.riskRules, blockOppositeSideBetting: e.target.checked } })}
                  className="sr-only peer" />
                <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
              </label>
            </div>

            <div>
              <label className="label" htmlFor="funding-velocity-limit-orders-per-hour-per-user">Funding Velocity Limit (orders per hour per user)</label>
              <input id="funding-velocity-limit-orders-per-hour-per-user"
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
              <label className="label" htmlFor="purchase-pace-new-buys-per-minute-per-user">Purchase Pace (new buys per minute per user)</label>
              <input id="purchase-pace-new-buys-per-minute-per-user"
                type="number" min={0} max={60} step={1}
                value={formData.riskRules.maxDepositOrdersPerMinute}
                onChange={(e) => setFormData({ ...formData, riskRules: { ...formData.riskRules, maxDepositOrdersPerMinute: Math.min(60, Math.max(0, Math.floor(Number(e.target.value) || 0))) } })}
                className="input"
              />
              <p className="text-xs text-gray-500 mt-1">
                How often one player may START a purchase. A player holds one open buy at a
                time anyway, so a second attempt inside the same minute is a retry storm or a
                script, not somebody buying twice. 0 = off. Takes effect immediately — no redeploy.
              </p>
            </div>

            <div>
              <label className="label" htmlFor="flag-for-review-after-n-payment-warnings">Flag For Review After N Payment Warnings</label>
              <input id="flag-for-review-after-n-payment-warnings"
                type="number" min={0} step={1}
                value={formData.riskRules.maxWarnings}
                onChange={(e) => setFormData({ ...formData, riskRules: { ...formData.riskRules, maxWarnings: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })}
                className="input"
              />
              <p className="text-xs text-gray-500 mt-1">
                Each merchant rejection adds one warning. A player who reaches this many is
                marked for review at the top of <strong>Flagged Players</strong>. It does
                <strong> not</strong> block anyone — this box used to say it did, and the
                block is now yours to make with the merchant's reason and proof in front of
                you. 0 = never mark for review (off).
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
          <label className="label" htmlFor="short-cycle-duration">Short Cycle Duration</label>
          <select id="short-cycle-duration"
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
          {([['oneMin', '1-Min Cycle'], ['thirtyMin', '30-Min Cycle'], ['fullDay', 'Full-Day Cycle']] as const).map(([key, label]) => (
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
                    <label className="text-xs text-gray-400" htmlFor={`phase-${key}-${field}`}>{flabel}</label>
                    <input
                      id={`phase-${key}-${field}`}
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

      {/* ── OPERATIONAL DEFENCES ─────────────────────────────────────────────
          Every field here was DECLARED in the config spec and read by live
          code, and reachable from no screen and no route: `withdrawalHoldMinutes`
          by the withdrawal worker, `loadShedding` by the overload middleware,
          `ipDefense` by the IP-rotation limiter — the last two under source
          comments that called them "admin-editable" (F-022). Changing any of
          them meant editing the spec and redeploying. */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-1">Operational Defences</h3>
        <p className="text-xs text-gray-400 mb-4">
          Withdrawal timing and the two overload ceilings. These take effect within about 30 seconds
          of saving — nothing here needs a restart.
        </p>

        {/* Both escrow windows (owner, 2026-10-02). Bounds are the spec's
            (database/spec/config.spec.js): 60–1440 and 5–1440. The hold may
            not go below an hour: it is the player's chance to dispute a sell
            the member says they paid. */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="withdrawal-hold-minutes">Sell escrow after "paid" (minutes)</label>
            <input id="withdrawal-hold-minutes"
              type="number" min={60} max={1440} step={1}
              value={formData.withdrawalHoldMinutes}
              onChange={(e) => setFormData({
                ...formData,
                withdrawalHoldMinutes: Math.min(1440, Math.max(60, Math.floor(Number(e.target.value) || 60))),
              })}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              After a team member marks a sell paid, the player's tokens stay in escrow this long so the
              player can raise a dispute. At least 60 minutes.
            </p>
          </div>
          <div>
            <label className="label" htmlFor="rejected-buy-dispute-minutes">Dispute window after a rejected buy (minutes)</label>
            <input id="rejected-buy-dispute-minutes"
              type="number" min={5} max={1440} step={1}
              value={formData.rejectedBuyDisputeMinutes}
              onChange={(e) => setFormData({
                ...formData,
                rejectedBuyDisputeMinutes: Math.min(1440, Math.max(5, Math.floor(Number(e.target.value) || 15))),
              })}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              When a team member rejects a paid buy as unpaid, the team's tokens stay in escrow this long.
              If the player disputes in time they stay until the dispute is decided; if not, they go back
              to the team pool.
            </p>
          </div>
        </div>

        {/* ── Red flags (Step 2f) ─────────────────────────────────────────
            Computed once a day; shown to the supervisor and on the Teams
            page. Nothing acts on a flag. */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 mt-4 border-t border-dark-700">
          <div>
            <label className="label" htmlFor="red-flag-low-activity">Low-activity red flag (% below team average)</label>
            <input id="red-flag-low-activity"
              type="number" min={1} max={90} step={1}
              value={formData.redFlags.lowActivityPercent}
              onChange={(e) => setFormData({ ...formData, redFlags: { ...formData.redFlags,
                lowActivityPercent: Math.min(90, Math.max(1, Math.floor(Number(e.target.value) || 25))) } })}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              A member is flagged to their supervisor and here when their completed orders and their online
              time on a day were both this far below their team's average.
            </p>
          </div>
          <div>
            <label className="label" htmlFor="red-flag-farming-rounds">Commission farming: rounds bet against each other</label>
            <input id="red-flag-farming-rounds"
              type="number" min={1} max={100} step={1}
              value={formData.redFlags.farmingMinRounds}
              onChange={(e) => setFormData({ ...formData, redFlags: { ...formData.redFlags,
                farmingMinRounds: Math.min(100, Math.max(1, Math.floor(Number(e.target.value) || 3))) } })}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              A team is flagged when one of its buyers and one of its sellers (or one player on both sides)
              bet against each other in at least this many rounds of a day…
            </p>
          </div>
          <div>
            <label className="label" htmlFor="red-flag-farming-share">Commission farming: share of their stake (%)</label>
            <input id="red-flag-farming-share"
              type="number" min={1} max={100} step={1}
              value={formData.redFlags.farmingHedgePercent}
              onChange={(e) => setFormData({ ...formData, redFlags: { ...formData.redFlags,
                farmingHedgePercent: Math.min(100, Math.max(1, Math.floor(Number(e.target.value) || 80))) } })}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              …with at least this share of everything the two staked that day on those bets.
            </p>
          </div>
        </div>

        <div className="pt-4 mt-4 border-t border-dark-700">
          <label className="flex items-center space-x-2 mb-2">
            <input
              type="checkbox"
              aria-label="Load shedding"
              checked={formData.loadShedding.enabled}
              onChange={(e) => setFormData({ ...formData, loadShedding: { ...formData.loadShedding, enabled: e.target.checked } })}
            />
            <span className="label mb-0">Load shedding</span>
          </label>
          <p className="text-xs text-gray-500 mb-3">
            Past either ceiling the server answers 503 straight away rather than admitting work into a
            queue that will never drain. Both default to values only genuine overload reaches — ordinary
            traffic and settlement bursts never see one.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="max-requests-in-flight">Max Requests In Flight</label>
              <input id="max-requests-in-flight"
                type="number" min={0} step={10}
                value={formData.loadShedding.maxInFlight}
                onChange={(e) => setFormData({ ...formData, loadShedding: { ...formData.loadShedding, maxInFlight: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })}
                className="input"
              />
              <p className="text-xs text-gray-500 mt-1">0 turns this ceiling off.</p>
            </div>
            <div>
              <label className="label" htmlFor="max-event-loop-lag-ms">Max Event-Loop Lag (ms)</label>
              <input id="max-event-loop-lag-ms"
                type="number" min={0} step={10}
                value={formData.loadShedding.maxEventLoopLagMs}
                onChange={(e) => setFormData({ ...formData, loadShedding: { ...formData.loadShedding, maxEventLoopLagMs: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })}
                className="input"
              />
              <p className="text-xs text-gray-500 mt-1">0 turns this ceiling off.</p>
            </div>
          </div>
        </div>

        <div className="pt-4 mt-4 border-t border-dark-700">
          <label className="flex items-center space-x-2 mb-2">
            <input
              type="checkbox"
              aria-label="IP-rotation defence"
              checked={formData.ipDefense.enabled}
              onChange={(e) => setFormData({ ...formData, ipDefense: { ...formData.ipDefense, enabled: e.target.checked } })}
            />
            <span className="label mb-0">IP-rotation defence</span>
          </label>
          <p className="text-xs text-gray-500 mb-3">
            Sits on top of the per-IP limiters. Origin and traffic shape only — no geo or ISP lookups
            and no third-party reputation. A surge <strong>Max of 0 means that layer is off</strong>.
          </p>
          <div className="mb-3">
            <label className="label" htmlFor="subnet-multiplier">Subnet Multiplier</label>
            <input id="subnet-multiplier"
              type="number" min={1} step={1}
              value={formData.ipDefense.subnetMultiplier}
              onChange={(e) => setFormData({ ...formData, ipDefense: { ...formData.ipDefense, subnetMultiplier: Math.max(1, Math.floor(Number(e.target.value) || 1)) } })}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              How much more a whole /24 (or /64) may do than one address, before the subnet itself is limited.
            </p>
          </div>
          {([
            ['auth', 'Login & OTP'],
            ['withdrawal', 'Withdrawals'],
            ['funding', 'Deposits & funding'],
          ] as const).map(([key, label]) => (
            <div key={key} className="mb-3">
              <p className="text-sm font-medium mb-1">{label}</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-400" htmlFor="window-sec">Window (sec)</label>
                  <input id="window-sec"
                    type="number" min={1} step={1}
                    value={formData.ipDefense.surge[key].windowSec}
                    onChange={(e) => setFormData({
                      ...formData,
                      ipDefense: {
                        ...formData.ipDefense,
                        surge: {
                          ...formData.ipDefense.surge,
                          [key]: { ...formData.ipDefense.surge[key], windowSec: Math.max(1, Math.floor(Number(e.target.value) || 1)) },
                        },
                      },
                    })}
                    className="input"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-400" htmlFor="max-in-window-0-off">Max in window (0 = off)</label>
                  <input id="max-in-window-0-off"
                    type="number" min={0} step={1}
                    value={formData.ipDefense.surge[key].max}
                    onChange={(e) => setFormData({
                      ...formData,
                      ipDefense: {
                        ...formData.ipDefense,
                        surge: {
                          ...formData.ipDefense.surge,
                          [key]: { ...formData.ipDefense.surge[key], max: Math.max(0, Math.floor(Number(e.target.value) || 0)) },
                        },
                      },
                    })}
                    className="input"
                  />
                </div>
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
              ['gift-code', '🎁 Gifts'],
              ['my-bets', '📜 My Bets'], ['history', '🕘 History'], ['rules', '📖 Rules'],
              ['faq', '❓ FAQ'], ['support', '🛟 Support'],
              ['casino', '🎰 Casino'], ['crash', '🚀 Crash'], ['sports', '⚽ Sports'],
            ];
            const current = formData.footerPages[i] || '';
            const usedElsewhere = formData.footerPages.filter((_, j) => j !== i);
            return (
              <div key={i}>
                {/* The words "Slot 1" were on screen and attached to nothing —
                    five identical comboboxes to a screen reader, on the control
                    that decides the player's bottom navigation. S24. */}
                <label htmlFor={`footer-slot-${i}`}
                  className="text-[10px] text-gray-500 uppercase font-bold block mb-1">Slot {i + 1}</label>
                <select
                  id={`footer-slot-${i}`}
                  aria-label={`Player footer navigation, slot ${i + 1}`}
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
        <label className="label" htmlFor="alert-webhook-url">Alert Webhook URL</label>
        <input id="alert-webhook-url"
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
                  aria-label={label}
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
            <label className="label" htmlFor="blocked-ja3-hashes">Blocked JA3 Hashes</label>
            <textarea id="blocked-ja3-hashes"
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
            <label className="label" htmlFor="web-app-url">Web App URL</label>
            <input id="web-app-url"
              type="url"
              value={formData.webUrl}
              onChange={(e) => setFormData({ ...formData, webUrl: e.target.value })}
              className="input"
              placeholder="https://your-domain.example"
            />
            <p className="text-xs text-gray-500 mt-1">The link users share via the "Share Link" button. Update here when your public domain changes.</p>
          </div>

          <div className="text-xs text-gray-400 rounded-lg border border-dark-700 p-3">
            <span className="font-semibold text-gray-300">Android app:</span> uploaded, published and force-updated on the{' '}
            <a href="#/android-app" className="underline">Android App</a> page. The download link in the player app always points at the newest published release.
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
              <label className="label" htmlFor="minimum-version">Minimum Web Version</label>
              <input id="minimum-version"
                type="text"
                value={formData.minVersion}
                onChange={(e) => setFormData({ ...formData, minVersion: e.target.value })}
                className="input font-mono"
                placeholder="1.0.0"
              />
              <p className="text-xs text-gray-500 mt-1">Browser users on an older web bundle see a forced update screen until they refresh. Does not apply to the Android app.</p>
            </div>
            <div>
              <label className="label" htmlFor="latest-version">Latest Web Version</label>
              <input id="latest-version"
                type="text"
                value={formData.latestVersion}
                onChange={(e) => setFormData({ ...formData, latestVersion: e.target.value })}
                className="input font-mono"
                placeholder="1.0.0"
              />
              <p className="text-xs text-gray-500 mt-1">Shown to browser users on the web update screen.</p>
            </div>
          </div>

          <div className="bg-yellow-900/20 border border-yellow-500/30 rounded-lg p-3">
            <p className="text-xs text-yellow-300">
              <strong>How forced updates work:</strong> On the <em>web</em>, set Minimum Web Version to the new version (e.g. 1.1.0): a browser still running 1.0.x sees the update screen until it taps Update &amp; Restart, which reloads the latest code. The <em>Android app</em> carries its code inside the APK, so a reload cannot update it — publish a release on the <a href="#/android-app" className="underline">Android App</a> page and mark it Mandatory instead; the app downloads and installs it itself.
            </p>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={isSaving
          || (formData.minBet > formData.maxBet)
          || formData.orderSizes.length === 0
          || !usdtStepOk(formData.usdtBuy.minUsdt) || !usdtStepOk(formData.usdtBuy.maxUsdt)
          || (formData.usdtBuy.minUsdt > formData.usdtBuy.maxUsdt)
          || ROUTING_RAILS.some((r) => outOfRange(formData.teamRouting.concurrency[r.rail], r.concurrency)
            || outOfRange(formData.teamRouting.processingWindowSeconds[r.rail], r.processing))
          || ROUTING_TIMERS.some((t) => outOfRange(formData.teamRouting[t.key], t))}
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
