// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React, { useCallback, useEffect, useState } from 'react';
import { Save, Power, AlertTriangle } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SettingHelp, SettingHelpProvider, type SettingHelpMap } from '../../components/SettingHelp';
import api from '../../services/api';
import toast from 'react-hot-toast';

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
  key: string; label: string; min: number; max: number; fallback: number;
}> = [
  { key: 'maxConsecutiveRejections', label: 'Consecutive Refusals Before Suspension',
    min: 1, max: 20, fallback: 3 },   // spec default: 3,
  { key: 'paidResponseMinutes', label: 'Merchant Response Window on a PAID Buy (minutes)',
    min: 5, max: 1440, fallback: 30 },   // spec default: 30,
  { key: 'utrAfterPaidMinutes', label: 'Cash Buy: Reference Due After Paid (minutes)',
    min: 2, max: 60, fallback: 15 },   // spec default: 15,
  { key: 'maxConsecutivePlayerPaymentFailures', label: 'Player Unpaid Buys Before Cool-off',
    min: 1, max: 50, fallback: 3 },   // spec default: 3,
  { key: 'playerOrderLockMinutes', label: 'Player Cool-off Length (minutes)',
    min: 1, max: 1440, fallback: 60 },   // spec default: 60,
  { key: 'maxConsecutiveMerchantExpiries', label: 'Expiries Before Assignment is Paused',
    min: 1, max: 20, fallback: 3 },   // spec default: 3,
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
  min: number; max: number; fallback: number;
}> = [
  { key: 'assignmentWaitSeconds', label: 'Queue Wait Before Expiry (seconds)',
    min: 60, max: 86400, fallback: 1500 },   // spec default: 1500,
  { key: 'utrSubmitSeconds', label: 'Extra Time to Submit a Reference (seconds)',
    min: 15, max: 3600, fallback: 60 },   // spec default: 60,
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

// §5 MIRROR — `SYSTEM_CONFIG_SPEC.fields.merchantRouting` and
// `.directMerchants` in `database/spec/config.spec.js` (owner, 2026-10-11),
// read by `merchantRoutingSettings` (database/repositories/teamRouting.js),
// `payTeamCommission` and `merchantProblems.js`. Bounds repeat the spec's for
// the input; the server refuses an out-of-range value by name. `fallback` is a
// LOADING placeholder equal to the spec default beside it (§4).
type OrderDirection = 'DEPOSIT' | 'WITHDRAWAL';
const MERCHANT_ROUTING_DIRECTIONS: Array<{
  direction: OrderDirection; label: string;
  concurrency: { min: number; max: number; fallback: number };
  processing: { min: number; max: number; fallback: number };
}> = [
  { direction: 'DEPOSIT', label: 'Buys',
    concurrency: { min: 1, max: 100, fallback: 10 },     // spec default: 10
    processing:  { min: 60, max: 7200, fallback: 900 } }, // spec default: 900
  { direction: 'WITHDRAWAL', label: 'Sells',
    concurrency: { min: 1, max: 100, fallback: 10 },     // spec default: 10
    processing:  { min: 60, max: 7200, fallback: 900 } }, // spec default: 900
];
const MERCHANT_ASSIGNMENT_WAIT = { min: 60, max: 86400, fallback: 1500 };   // spec default: 1500
const DIRECT_MERCHANT_FIELDS: Array<{
  key: 'commissionPercent' | 'dailyProblemFlagThreshold'; label: string;
  min: number; max: number; fallback: number;
}> = [
  { key: 'commissionPercent', label: 'Merchant commission (%)',
    min: 1, max: 50, fallback: 10 },   // spec default: 10,
  { key: 'dailyProblemFlagThreshold', label: 'Problems in a day before a merchant is flagged',
    min: 1, max: 100, fallback: 5 },   // spec default: 5,
];
/** Per direction, the field listing the sizes sent to merchant accounts (MERCHANT_SIZE_FIELD, denominations.js). §5 mirror. */
type MerchantSizeKey = 'merchantBuySizes' | 'merchantSellSizes';
const MERCHANT_SIZE_LISTS: Array<{ key: MerchantSizeKey; verb: string }> = [
  { key: 'merchantBuySizes', verb: 'Buy' },
  { key: 'merchantSellSizes', verb: 'Sell' },
];

interface MerchantRoutingForm {
  concurrency: Record<OrderDirection, number>;
  processingWindowSeconds: Record<OrderDirection, number>;
  assignmentWaitSeconds: number;
  [other: string]: unknown;
}
const merchantRoutingDefaults = (): MerchantRoutingForm => ({
  concurrency: Object.fromEntries(MERCHANT_ROUTING_DIRECTIONS.map((d) => [d.direction, d.concurrency.fallback])) as Record<OrderDirection, number>,
  processingWindowSeconds: Object.fromEntries(MERCHANT_ROUTING_DIRECTIONS.map((d) => [d.direction, d.processing.fallback])) as Record<OrderDirection, number>,
  assignmentWaitSeconds: MERCHANT_ASSIGNMENT_WAIT.fallback,
});
const directMerchantDefaults = () =>
  Object.fromEntries(DIRECT_MERCHANT_FIELDS.map((f) => [f.key, f.fallback])) as Record<'commissionPercent' | 'dailyProblemFlagThreshold', number>;

const outOfRange = (v: number, b: { min: number; max: number }) => !Number.isFinite(v) || v < b.min || v > b.max;

// ── The seven order sizes, per rail ──────────────────────────────────────────
// Served by GET /api/admin/system/config as `orderSizeRails` (ORDER_SIZE_RAILS in
// backend/domains/merchant/denominations.js): each rail's sizes, its name, and
// how a buy and a sell on it are paid. The card renders that list and keeps no
// copy (§5); what is ticked is `buyOrderSizes` / `sellOrderSizes`.
interface OrderSizeRail {
  rail: string; label: string; sizes: number[];
  methods: { DEPOSIT: string; WITHDRAWAL: string };
}
type SizeListKey = 'buyOrderSizes' | 'sellOrderSizes';
const SIZE_LISTS: Array<{ key: SizeListKey; title: string; verb: string; direction: 'DEPOSIT' | 'WITHDRAWAL' }> = [
  { key: 'buyOrderSizes',  title: 'Sizes players can buy',  verb: 'Buy',  direction: 'DEPOSIT' },
  { key: 'sellOrderSizes', title: 'Sizes players can sell', verb: 'Sell', direction: 'WITHDRAWAL' },
];
// Mirrors USDT_BUY_STEP (denominations.js) and the spec's usdtBuy defaults.
const USDT_BUY_STEP = 100;
const usdtStepOk = (v: number) => Number.isInteger(v) && v >= USDT_BUY_STEP && v <= 100000 && v % USDT_BUY_STEP === 0;

/** Mirror of `gatewayDocumentStatus` (backend/domains/configuration/gatewayConfig.js). */
type GatewayDocumentStatus =
  | { state: 'NOT_CONFIGURED' }
  | { state: 'SERVING'; version: number; issuedAt: string; expiresAt: string; hostCount: number }
  | { state: 'NOT_SERVING'; code: string; message: string };

/** Days left at which a served document's line turns to a warning. UI-only (§11), never sent to the server. */
const GATEWAY_WARN_DAYS = 30;

/**
 * The signed gateway document, in one line under API Host. Nothing here is a
 * setting: the document is signed offline and replaced only on the server
 * (docs/governance/GATEWAY_KEY_ROTATION.md). The line says whether apps are
 * getting it and when it lapses, so an expiry is seen before it happens.
 */
const GatewayStatusLine: React.FC<{ status: GatewayDocumentStatus | null }> = ({ status }) => {
  if (!status) return null;
  if (status.state === 'NOT_CONFIGURED') {
    return (
      <p role="status" className="mt-3 text-sm text-gray-400">
        Signed gateway document: none configured. Apps use only the hosts built into them.
      </p>
    );
  }
  if (status.state === 'NOT_SERVING') {
    return (
      <p role="alert" className="mt-3 text-sm text-red-400">
        Signed gateway document: not being served ({status.code}: {status.message}). Put a newly
        signed document on the server (GATEWAY_KEY_ROTATION.md).
      </p>
    );
  }
  const daysLeft = Math.floor((Date.parse(status.expiresAt) - Date.now()) / 86_400_000);
  const soon = daysLeft < GATEWAY_WARN_DAYS;
  return (
    <p role="status" className={`mt-3 text-sm ${soon ? 'text-yellow-400' : 'text-green-400'}`}>
      Signed gateway document: serving version {status.version} with {status.hostCount}{' '}
      {status.hostCount === 1 ? 'host' : 'hosts'}, expires {new Date(status.expiresAt).toLocaleDateString()}{' '}
      ({daysLeft} {daysLeft === 1 ? 'day' : 'days'} left).
      {soon && ' Sign a replacement before it lapses.'}
    </p>
  );
};

export const SystemSettings: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showMaintenanceConfirm, setShowMaintenanceConfirm] = useState(false);
  // The deployment's approved API hosts (API_ALLOWED_HOSTS), served with the
  // config. Read-only: the server refuses any other value for `apiHost`.
  const [apiHostChoices, setApiHostChoices] = useState<string[]>([]);
  // The signed gateway document's state (`gatewayDocumentStatus`,
  // domains/configuration/gatewayConfig.js). Read-only, like the choices.
  const [gateway, setGateway] = useState<GatewayDocumentStatus | null>(null);
  // The order-size universe by rail, from the server (see ORDER_SIZE_RAILS above).
  const [orderSizeRails, setOrderSizeRails] = useState<OrderSizeRail[]>([]);
  // What each setting means, served beside the config (configHelp.js).
  const [help, setHelp] = useState<SettingHelpMap>({});

  const [formData, setFormData] = useState({
    maintenanceMode: false,
    maintenanceMessage: '',
    registrationEnabled: true,
    // The sizes on offer to buy and to sell (Step 2d, Phase A). Filled from the
    // GET, which serves every declared key at its live value (schema default:
    // all seven, each).
    buyOrderSizes: [] as number[],
    sellOrderSizes: [] as number[],
    usdtBuy: { minUsdt: 100, maxUsdt: 10000 },   // schema defaults: 100 / 10,000
    maxBalanceAdjustment: 1000000, // schema default: 1000000 (₹10,00,000)
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
    // Who serves INR orders: agents' teams or merchants (owner, 2026-10-11).
    // The sizes sent to merchant accounts, per direction (owner, 2026-10-15).
    merchantBuySizes: [] as number[],   // schema default: [] (all to agents)
    merchantSellSizes: [] as number[],  // schema default: []
    merchantRouting: merchantRoutingDefaults(),
    directMerchants: directMerchantDefaults(),
    // Business Config Audit (2026-07-11) — formerly-hardcoded business values
    payoutMultiplier: 2,       // schema default: 2 (2x)
    // The line under the board rules (owner, 2026-10-15). '' until loaded: the
    // server always sends one (phantomBetsLabelOf), and an empty save is refused.
    phantomBetsLabel: '',
    // Demo results in the analytics (owner, 2026-10-15); schema default: true.
    demoResultsOn: true,
    // How long a sell stays in escrow after the member marks it paid.
    withdrawalHoldMinutes: 60,  // schema default: 60 (also the floor)
    // How long a player has to dispute a buy the member rejected as unpaid.
    rejectedBuyDisputeMinutes: 15,  // schema default: 15
    // The daily red flag on team members (Step 2f): low activity.
    redFlags: { lowActivityPercent: 25 },  // schema default: 25
    // What a referral pays (owner, 2026-10-14: admin-editable).
    referralRewards: { level1Rupees: 25, level2Rupees: 25, turnoverMultiplier: 10 },  // schema defaults: 25 / 25 / 10
    // What a player's first completed deposit pays into GENERAL (owner, 2026-10-15).
    firstDepositBonus: { rupees: 0 },  // schema default: 0 (off)
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
    footerPages: ['home', 'results', 'wallet', 'promo'], // schema default (config.spec.js footerPages)
    // Operational alert webhook (2026-07-13) — '' = alerting off
    alertWebhookUrl: '',
    tlsFingerprintDefense: {
      enabled: true,
      logOnly: true,
      requireJa3Hash: false,
      blockJa3Hashes: [] as string[],
    },
    // The API host player apps are sent to; '' = their configured primary.
    // schema default: '' (SYSTEM_CONFIG_SPEC.apiHost)
    apiHost: '',
    // App distribution
    webUrl:        '',
    iosUrl:        '',
    minVersion:    '1.0.0',
    latestVersion: '1.0.0',
  });

  const loadConfig = useCallback(async () => {
    try {
      const response = await api.system.getConfig();
      if (response.success && response.data) {
        setApiHostChoices(Array.isArray(response.data.apiHostChoices) ? response.data.apiHostChoices : []);
        setGateway(response.data.gatewayDocument ?? null);
        setOrderSizeRails(Array.isArray(response.data.orderSizeRails) ? response.data.orderSizeRails : []);
        setHelp(response.help ?? {});
        setFormData({
          maintenanceMode: response.data.maintenanceMode || false,
          maintenanceMessage: response.data.maintenanceMessage || '',
          registrationEnabled: response.data.registrationEnabled !== false,
          // `??` rather than `||` throughout: 0 is a value an operator may
          // legitimately set, and `||` silently replaces it with the default.
          buyOrderSizes: Array.isArray(response.data.buyOrderSizes) ? response.data.buyOrderSizes : [],
          sellOrderSizes: Array.isArray(response.data.sellOrderSizes) ? response.data.sellOrderSizes : [],
          usdtBuy: {
            minUsdt: response.data.usdtBuy?.minUsdt ?? 100,    // schema default: 100
            maxUsdt: response.data.usdtBuy?.maxUsdt ?? 10000,  // schema default: 10,000
          },
          maxBalanceAdjustment: response.data.maxBalanceAdjustment ?? 1000000, // schema default: 1000000
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
          merchantBuySizes: Array.isArray(response.data.merchantBuySizes) ? response.data.merchantBuySizes : [],   // schema default: []
          merchantSellSizes: Array.isArray(response.data.merchantSellSizes) ? response.data.merchantSellSizes : [], // schema default: []
          // Taken whole, like teamRouting.
          merchantRouting: (() => {
            const served = response.data.merchantRouting ?? {};
            const d = merchantRoutingDefaults();
            return {
              ...d, ...served,
              concurrency: { ...d.concurrency, ...(served.concurrency ?? {}) },
              processingWindowSeconds: { ...d.processingWindowSeconds, ...(served.processingWindowSeconds ?? {}) },
            } as MerchantRoutingForm;
          })(),
          directMerchants: { ...directMerchantDefaults(), ...(response.data.directMerchants ?? {}) },
          payoutMultiplier:   response.data.payoutMultiplier   ?? 2,  // schema default: 2
          phantomBetsLabel:     response.data.phantomBetsLabel     ?? '',
          demoResultsOn:      response.data.demoResultsOn      ?? true,  // schema default: true
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
            lowActivityPercent: response.data.redFlags?.lowActivityPercent ?? 25, // schema default: 25
          },
          referralRewards: {
            level1Rupees:       response.data.referralRewards?.level1Rupees       ?? 25, // schema default: 25
            level2Rupees:       response.data.referralRewards?.level2Rupees       ?? 25, // schema default: 25
            turnoverMultiplier: response.data.referralRewards?.turnoverMultiplier ?? 10, // schema default: 10
          },
          firstDepositBonus: {
            rupees: response.data.firstDepositBonus?.rupees ?? 0, // schema default: 0
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
          footerPages: response.data.footerPages?.length ? response.data.footerPages : ['home', 'results', 'wallet', 'promo'], // schema default
          alertWebhookUrl: response.data.alertWebhookUrl || '',
          tlsFingerprintDefense: {
            enabled: response.data.tlsFingerprintDefense?.enabled ?? true,
            logOnly: response.data.tlsFingerprintDefense?.logOnly ?? true,
            requireJa3Hash: response.data.tlsFingerprintDefense?.requireJa3Hash ?? false,
            blockJa3Hashes: response.data.tlsFingerprintDefense?.blockJa3Hashes || [],
          },
          apiHost:       response.data.apiHost       ?? '', // schema default: ''
          webUrl:        response.data.webUrl        || '',
          iosUrl:        response.data.iosUrl        || '',
          minVersion:    response.data.minVersion    || '1.0.0',
          latestVersion: response.data.latestVersion || '1.0.0',
        });
      }
    } catch {
      toast.error('Failed to load system config');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // The size lists go back only when the card had the universe to tick
      // them from: an empty list sent from a card that drew nothing would be
      // refused (minItems 1) and take every other setting's save down with it.
      // The same for who serves each size: lists drawn from nothing would send
      // every size back to agents.
      const { buyOrderSizes, sellOrderSizes, merchantBuySizes, merchantSellSizes, ...rest } = formData;
      const saved = await api.system.updateConfig(orderSizeRails.length > 0
        ? { ...rest, buyOrderSizes, sellOrderSizes, merchantBuySizes, merchantSellSizes } : rest);
      // Moving a size between agents and merchant accounts moves the INR orders
      // of that size still waiting for a first taker; the server says how many.
      const moved = Number(saved?.rerailedOrders) || 0;
      toast.success(moved > 0
        ? `System settings updated. ${moved} waiting INR ${moved === 1 ? 'order was' : 'orders were'} moved to the new route.`
        : 'System settings updated');
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
    <SettingHelpProvider help={help}>
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
            <p className="text-sm text-gray-400">
              {formData.maintenanceMode
                ? '[!] Platform is currently in maintenance mode'
                : 'Platform is operational'}
            </p>
            <SettingHelp path="maintenanceMode" className="mb-4" />
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
                <SettingHelp path="maintenanceMessage" />
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
            <SettingHelp path="registrationEnabled" />
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

      {/* API Host — where player apps connect (SystemConfig.apiHost) */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-1">API Host</h3>
        <p className="text-xs text-gray-500 mb-4">
          The server player apps connect to. Apps ask for this when they start, and switch to their
          backups by themselves if it stops answering. Only hosts the deployment already serves can be
          chosen (API_ALLOWED_HOSTS); a host must also be built into the app, or the app ignores it.
        </p>
        <label className="label" htmlFor="api-host">Host</label>
        <select
          id="api-host"
          className="input w-full"
          value={formData.apiHost}
          onChange={(e) => setFormData({ ...formData, apiHost: e.target.value })}
        >
          <option value="">Default (the app's configured primary)</option>
          {apiHostChoices.map((host) => (
            <option key={host} value={host}>{host}</option>
          ))}
          {formData.apiHost && !apiHostChoices.includes(formData.apiHost) && (
            <option value={formData.apiHost}>{formData.apiHost} (no longer approved)</option>
          )}
        </select>
        {apiHostChoices.length === 0 && (
          <p role="status" className="mt-2 text-sm text-yellow-400">
            No approved hosts are configured on the server, so apps use their built-in primary.
          </p>
        )}
        {formData.apiHost && !apiHostChoices.includes(formData.apiHost) && (
          <div role="alert" className="mt-3 flex items-center space-x-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <AlertTriangle className="text-red-500 shrink-0" size={16} />
            <p className="text-sm text-red-400">
              This host was removed from the approved list, so apps are not being sent to it. Choose another.
            </p>
          </div>
        )}
        <SettingHelp path="apiHost" />
        <GatewayStatusLine status={gateway} />
      </div>

      {/* Order sizes (Step 2d; separate buy and sell lists, Phase A) */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-1">Order Sizes</h3>
        <p className="text-xs text-gray-500 mb-4">
          Every buy and sell is exactly one of these sizes, in tokens. The size decides the rail:
          cash sizes go to an agent at an ATM, UPI/bank sizes to a UPI or bank team. Untick a size
          to stop offering it; each list must keep at least one.
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          {SIZE_LISTS.map((list) => {
            const chosen = formData[list.key];
            const all = orderSizeRails.flatMap((r) => r.sizes);
            return (
              <div key={list.key}>
                <h4 className="text-sm font-semibold">{list.title}</h4>
                <SettingHelp path={list.key} className="mb-2" />
                <div className="space-y-3">
                  {orderSizeRails.map((group) => (
                    <fieldset key={group.rail}>
                      <legend className="label">{group.label}</legend>
                      <p className="text-xs text-gray-500 mb-1">{group.methods[list.direction]}</p>
                      <div className="flex flex-wrap gap-4">
                        {group.sizes.map((size) => {
                          const id = `order-size-${list.verb.toLowerCase()}-${size}`;
                          const shown = size.toLocaleString('en-IN');
                          return (
                            <label key={size} htmlFor={id} className="flex items-center gap-2 text-sm">
                              <input id={id} type="checkbox" aria-label={`${list.verb} ${shown}`}
                                checked={chosen.includes(size)}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  [list.key]: e.target.checked
                                    ? all.filter((s) => s === size || chosen.includes(s))
                                    : chosen.filter((s) => s !== size),
                                })}
                              />
                              {shown}
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                  ))}
                </div>
                {orderSizeRails.length > 0 && chosen.length === 0 && (
                  <div role="alert" className="mt-3 flex items-center space-x-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                    <AlertTriangle className="text-red-500 shrink-0" size={16} />
                    <p className="text-sm text-red-400">
                      Keep at least one size players can {list.verb.toLowerCase()}. With none, no player could {list.verb.toLowerCase()}.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

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
          <SettingHelp path="maxBalanceAdjustment" />
        </div>

      </div>

      {/* Each board's stakes, timer and phases are on the Boards page (owner,
          2026-10-08: admins create boards, each with its own timer). */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-1">Board stakes and timers</h3>
        <p className="text-sm text-gray-400">
          Each board's minimum and maximum bet, timer and phase timings are set on the{' '}
          <a href="/boards" className="text-gold-500 underline">Boards</a> page.
        </p>
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
            <SettingHelp path="betReservePercent" />
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
            <SettingHelp path="payoutMultiplier" />
            <p className="text-xs text-gold-400/80 mt-1">
              Example with {formData.payoutMultiplier}×: a ₹100 winning bet returns gross
              ₹{100 * formData.payoutMultiplier} before the winnings fee.
            </p>
          </div>

          <div className="pt-4 border-t border-dark-700">
            <label className="label" htmlFor="phantom-bets-label">Phantom Bets Line (shown to players)</label>
            <input id="phantom-bets-label"
              type="text" minLength={10} maxLength={160}
              value={formData.phantomBetsLabel}
              onChange={(e) => setFormData({ ...formData, phantomBetsLabel: e.target.value })}
              className="input"
            />
            <SettingHelp path="phantomBetsLabel" />
            <p className="text-xs text-gold-400/80 mt-1">
              Players see this at the end of the board rules.
              You can reword it; it cannot be removed.
            </p>
          </div>

          <div className="pt-4 border-t border-dark-700">
            <div className="flex items-center justify-between">
              <div className="pr-4">
                <p className="font-medium">Demo Results in Analytics</p>
                <SettingHelp path="demoResultsOn" />
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" aria-label="Fill the analytics with demo results"
                  checked={formData.demoResultsOn}
                  onChange={(e) => setFormData({ ...formData, demoResultsOn: e.target.checked })}
                  className="sr-only peer" />
                <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
              </label>
            </div>
          </div>

          <div className="pt-4 border-t border-dark-700">
            <label className="label" htmlFor="winnings-platform-fee">Winnings Platform Fee (%)</label>
            <input id="winnings-platform-fee"
              type="number" min={0} max={100} step={0.01}
              value={formData.winningsFeePercent}
              onChange={(e) => setFormData({ ...formData, winningsFeePercent: Number(e.target.value) })}
              className="input"
            />
            <SettingHelp path="winningsFeePercent" />
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
            <SettingHelp path="usdtPricing.userMerchantBuyInr" />
          </div>

          <div className="pt-4 border-t border-dark-700">
            <label className="label" htmlFor="usdt-buy-price-merchant-admin-inr">USDT Price: Team Pool Purchases (INR)</label>
            <input id="usdt-buy-price-merchant-admin-inr"
              type="number" min={0} step={0.01}
              value={formData.usdtPricing.merchantAdminBuyInr}
              onChange={(e) => setFormData({ ...formData, usdtPricing: { ...formData.usdtPricing, merchantAdminBuyInr: Math.max(0, Number(e.target.value) || 0) } })}
              className="input"
            />
            <SettingHelp path="usdtPricing.merchantAdminBuyInr" />
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
              <SettingHelp path="usdtBuy.minUsdt" />
            </div>
            <div>
              <label className="label" htmlFor="usdt-buy-max">USDT Buy Maximum (USDT)</label>
              <input id="usdt-buy-max"
                type="number" min={formData.usdtBuy.minUsdt} max={100000} step={USDT_BUY_STEP}
                value={formData.usdtBuy.maxUsdt}
                onChange={(e) => setFormData({ ...formData, usdtBuy: { ...formData.usdtBuy, maxUsdt: Number(e.target.value) || 0 } })}
                className="input"
              />
              <SettingHelp path="usdtBuy.maxUsdt" />
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
                  <SettingHelp path={`merchantOrderLimits.${rule.key}`} />
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
            <h3 className="font-semibold mb-1">Agent Team Routing</h3>
            <p className="text-xs text-gray-500 mb-4">
              An order routed to agents goes to an agent of a working team on its rail: USDT orders to USDT teams,
              INR orders up to the cash ceiling to Cash teams, larger INR orders to UPI / bank teams. Each rail has
              its own cap and window.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {ROUTING_RAILS.map((r) => {
                const conc = formData.teamRouting.concurrency[r.rail];
                const proc = formData.teamRouting.processingWindowSeconds[r.rail];
                return (
                  <div key={r.rail} className="space-y-3 p-3 bg-dark-800 rounded-lg">
                    <p className="text-sm font-medium">{r.label}</p>
                    <div>
                      <label className="label" htmlFor={`tr-conc-${r.rail}`}>Open orders per agent ({r.concurrency.min}–{r.concurrency.max})</label>
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
                      <SettingHelp path={`teamRouting.concurrency.${r.rail}`} />
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
                      <SettingHelp path={`teamRouting.processingWindowSeconds.${r.rail}`} />
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
                    {outOfRange(v, t) && <p role="alert" className="text-xs text-red-400 mt-1">Must be {t.min}–{t.max} seconds.</p>}
                    <SettingHelp path={`teamRouting.${t.key}`} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Who serves each INR size, and the merchants' numbers ─────────
              Per direction and size, agents or merchant accounts (owner,
              2026-10-15). The sizes are the served `orderSizeRails`; sent
              back as `merchantBuySizes` / `merchantSellSizes`, with
              `merchantRouting` and `directMerchants`, which the PUT accepts
              by declaration. */}
          <div className="pt-4 border-t border-dark-700">
            <h3 className="font-semibold mb-1">INR Orders</h3>
            <p className="text-xs text-gray-500 mb-3">
              Pick who serves each size. Agents: 500 to 10,000 as cash at an ATM, 50,000 and up by UPI/bank.
              Merchant accounts: paid by UPI QR or bank transfer. USDT always goes to agents.
            </p>
            <table className="text-sm" aria-label="Who serves each INR size">
              <thead>
                <tr>
                  <th className="text-left pr-6 pb-2">Size (tokens)</th>
                  {MERCHANT_SIZE_LISTS.map((l) => <th key={l.key} className="text-left pr-6 pb-2">{l.verb} goes to</th>)}
                </tr>
              </thead>
              <tbody>
                {orderSizeRails.flatMap((r) => r.sizes).map((size) => {
                  const shown = size.toLocaleString('en-IN');
                  return (
                    <tr key={size}>
                      <td className="pr-6 py-1">{shown}</td>
                      {MERCHANT_SIZE_LISTS.map((l) => {
                        const list = formData[l.key];
                        const all = orderSizeRails.flatMap((r) => r.sizes);
                        return (
                          <td key={l.key} className="pr-6 py-1">
                            <select aria-label={`${l.verb} ${shown} goes to`} className="input py-1"
                              value={list.includes(size) ? 'MERCHANTS' : 'AGENTS'}
                              onChange={(e) => setFormData({
                                ...formData,
                                [l.key]: e.target.value === 'MERCHANTS'
                                  ? all.filter((x) => x === size || list.includes(x))
                                  : list.filter((x) => x !== size),
                              })}>
                              <option value="AGENTS">Agents</option>
                              <option value="MERCHANTS">Merchant accounts</option>
                            </select>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <SettingHelp path="merchantBuySizes" />
            <SettingHelp path="merchantSellSizes" />

            <h3 className="font-semibold mt-6 mb-1">Merchant Routing</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {MERCHANT_ROUTING_DIRECTIONS.map((d) => {
                const conc = formData.merchantRouting.concurrency[d.direction];
                const proc = formData.merchantRouting.processingWindowSeconds[d.direction];
                return (
                  <div key={d.direction} className="space-y-3 p-3 bg-dark-800 rounded-lg">
                    <p className="text-sm font-medium">{d.label}</p>
                    <div>
                      <label className="label" htmlFor={`mr-conc-${d.direction}`}>Open orders per merchant ({d.concurrency.min}–{d.concurrency.max})</label>
                      <input id={`mr-conc-${d.direction}`} type="number" step={1}
                        min={d.concurrency.min} max={d.concurrency.max}
                        value={Number.isFinite(conc) ? conc : ''}
                        onChange={(e) => setFormData({
                          ...formData,
                          merchantRouting: {
                            ...formData.merchantRouting,
                            concurrency: { ...formData.merchantRouting.concurrency, [d.direction]: Math.floor(Number(e.target.value)) },
                          },
                        })}
                        className="input" />
                      {outOfRange(conc, d.concurrency) && (
                        <p role="alert" className="text-xs text-red-400 mt-1">Must be {d.concurrency.min}–{d.concurrency.max}.</p>
                      )}
                      <SettingHelp path={`merchantRouting.concurrency.${d.direction}`} />
                    </div>
                    <div>
                      <label className="label" htmlFor={`mr-proc-${d.direction}`}>Window to serve an assigned order (seconds)</label>
                      <input id={`mr-proc-${d.direction}`} type="number" step={1}
                        min={d.processing.min} max={d.processing.max}
                        value={Number.isFinite(proc) ? proc : ''}
                        onChange={(e) => setFormData({
                          ...formData,
                          merchantRouting: {
                            ...formData.merchantRouting,
                            processingWindowSeconds: { ...formData.merchantRouting.processingWindowSeconds, [d.direction]: Math.floor(Number(e.target.value)) },
                          },
                        })}
                        className="input" />
                      {outOfRange(proc, d.processing)
                        ? <p role="alert" className="text-xs text-red-400 mt-1">Must be {d.processing.min}–{d.processing.max} seconds.</p>
                        : <p className="text-xs text-gray-500 mt-1">{Math.round(proc / 60)} min</p>}
                      <SettingHelp path={`merchantRouting.processingWindowSeconds.${d.direction}`} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
              <div>
                <label className="label" htmlFor="mr-assignmentWaitSeconds">Queue Wait Before Expiry (seconds)</label>
                <input id="mr-assignmentWaitSeconds" type="number" step={1}
                  min={MERCHANT_ASSIGNMENT_WAIT.min} max={MERCHANT_ASSIGNMENT_WAIT.max}
                  value={Number.isFinite(formData.merchantRouting.assignmentWaitSeconds) ? formData.merchantRouting.assignmentWaitSeconds : ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    merchantRouting: { ...formData.merchantRouting, assignmentWaitSeconds: Math.floor(Number(e.target.value)) },
                  })}
                  className="input" />
                {outOfRange(formData.merchantRouting.assignmentWaitSeconds, MERCHANT_ASSIGNMENT_WAIT)
                  ? <p role="alert" className="text-xs text-red-400 mt-1">Must be {MERCHANT_ASSIGNMENT_WAIT.min}–{MERCHANT_ASSIGNMENT_WAIT.max} seconds.</p>
                  : null}
                <SettingHelp path="merchantRouting.assignmentWaitSeconds" />
              </div>
              {DIRECT_MERCHANT_FIELDS.map((f) => {
                const v = formData.directMerchants[f.key];
                return (
                  <div key={f.key}>
                    <label className="label" htmlFor={`dm-${f.key}`}>{f.label}</label>
                    <input id={`dm-${f.key}`} type="number" step={1} min={f.min} max={f.max}
                      value={Number.isFinite(v) ? v : ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        directMerchants: { ...formData.directMerchants, [f.key]: Math.floor(Number(e.target.value)) },
                      })}
                      className="input" />
                    {outOfRange(v, f) && <p role="alert" className="text-xs text-red-400 mt-1">Must be {f.min}–{f.max}.</p>}
                    <SettingHelp path={`directMerchants.${f.key}`} />
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
            <SettingHelp path="payoutFeePercent" />
            <p className="text-xs text-gold-400/80 mt-1">
              Example with {formData.payoutFeePercent}%: withdrawing 1000 tokens pays out
              ₹{(1000 - Math.floor(100000 * Math.round(formData.payoutFeePercent * 100) / 10000) / 100).toFixed(2)}.
            </p>
          </div>

          <div className="pt-4 border-t border-dark-700 space-y-4">
            <div className="flex items-center justify-between">
              <div className="pr-4">
                <p className="font-medium">Enforce Multiples of 10</p>
                <SettingHelp path="riskRules.enforceMultiplesOf10" />
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
                <SettingHelp path="riskRules.blockOppositeSideBetting" />
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
              <SettingHelp path="riskRules.maxFundingOrdersPerHour" />
            </div>

            <div>
              <label className="label" htmlFor="purchase-pace-new-buys-per-minute-per-user">Purchase Pace (new buys per minute per user)</label>
              <input id="purchase-pace-new-buys-per-minute-per-user"
                type="number" min={0} max={60} step={1}
                value={formData.riskRules.maxDepositOrdersPerMinute}
                onChange={(e) => setFormData({ ...formData, riskRules: { ...formData.riskRules, maxDepositOrdersPerMinute: Math.min(60, Math.max(0, Math.floor(Number(e.target.value) || 0))) } })}
                className="input"
              />
              <SettingHelp path="riskRules.maxDepositOrdersPerMinute" />
            </div>

            <div>
              <label className="label" htmlFor="flag-for-review-after-n-payment-warnings">Flag For Review After N Payment Warnings</label>
              <input id="flag-for-review-after-n-payment-warnings"
                type="number" min={0} step={1}
                value={formData.riskRules.maxWarnings}
                onChange={(e) => setFormData({ ...formData, riskRules: { ...formData.riskRules, maxWarnings: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })}
                className="input"
              />
              <SettingHelp path="riskRules.maxWarnings" />
            </div>

          </div>
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
            <SettingHelp path="withdrawalHoldMinutes" />
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
            <SettingHelp path="rejectedBuyDisputeMinutes" />
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
            <SettingHelp path="redFlags.lowActivityPercent" />
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
          <SettingHelp path="loadShedding.enabled" className="mb-3" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="max-requests-in-flight">Max Requests In Flight</label>
              <input id="max-requests-in-flight"
                type="number" min={0} step={10}
                value={formData.loadShedding.maxInFlight}
                onChange={(e) => setFormData({ ...formData, loadShedding: { ...formData.loadShedding, maxInFlight: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })}
                className="input"
              />
              <SettingHelp path="loadShedding.maxInFlight" />
            </div>
            <div>
              <label className="label" htmlFor="max-event-loop-lag-ms">Max Event-Loop Lag (ms)</label>
              <input id="max-event-loop-lag-ms"
                type="number" min={0} step={10}
                value={formData.loadShedding.maxEventLoopLagMs}
                onChange={(e) => setFormData({ ...formData, loadShedding: { ...formData.loadShedding, maxEventLoopLagMs: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })}
                className="input"
              />
              <SettingHelp path="loadShedding.maxEventLoopLagMs" />
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
          <SettingHelp path="ipDefense.enabled" className="mb-3" />
          <div className="mb-3">
            <label className="label" htmlFor="subnet-multiplier">Subnet Multiplier</label>
            <input id="subnet-multiplier"
              type="number" min={1} step={1}
              value={formData.ipDefense.subnetMultiplier}
              onChange={(e) => setFormData({ ...formData, ipDefense: { ...formData.ipDefense, subnetMultiplier: Math.max(1, Math.floor(Number(e.target.value) || 1)) } })}
              className="input"
            />
            <SettingHelp path="ipDefense.subnetMultiplier" />
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
                  <label className="text-xs text-gray-400" htmlFor={`surge-${key}-window`}>Window (sec)</label>
                  <input id={`surge-${key}-window`}
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
                  <SettingHelp path={`ipDefense.surge.${key}.windowSec`} />
                </div>
                <div>
                  <label className="text-xs text-gray-400" htmlFor={`surge-${key}-max`}>Max in window (0 = off)</label>
                  <input id={`surge-${key}-max`}
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
                  <SettingHelp path={`ipDefense.surge.${key}.max`} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── GENERAL BONUSES (owner, 2026-10-14/15: referral + first deposit, one play rule) ── */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-1">Bonuses (General balance)</h3>
        <p className="text-xs text-gray-400 mb-4">
          Every bonus here goes into the player&apos;s General balance, never VIP. Referral rewards are paid
          from the queue you fund on the Referrals page; the first deposit bonus is paid once, with the
          player&apos;s first completed buy. One play requirement applies to every bonus.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <div>
            <label className="label" htmlFor="referral-level1Rupees">Level 1 reward (₹ per joiner)</label>
            <input id="referral-level1Rupees"
              type="number" min={0} max={10000} step={1}
              value={formData.referralRewards.level1Rupees}
              onChange={(e) => setFormData({ ...formData, referralRewards: { ...formData.referralRewards,
                level1Rupees: Math.min(10000, Math.max(0, Math.floor(Number(e.target.value) || 0))) } })}
              className="input"
            />
            <SettingHelp path="referralRewards.level1Rupees" />
          </div>
          <div>
            <label className="label" htmlFor="referral-level2Rupees">Level 2 reward (₹ per joiner)</label>
            <input id="referral-level2Rupees"
              type="number" min={0} max={10000} step={1}
              value={formData.referralRewards.level2Rupees}
              onChange={(e) => setFormData({ ...formData, referralRewards: { ...formData.referralRewards,
                level2Rupees: Math.min(10000, Math.max(0, Math.floor(Number(e.target.value) || 0))) } })}
              className="input"
            />
            <SettingHelp path="referralRewards.level2Rupees" />
          </div>
          <div>
            <label className="label" htmlFor="firstDepositBonus-rupees">First deposit bonus (₹, 0 = off)</label>
            <input id="firstDepositBonus-rupees"
              type="number" min={0} max={100000} step={1}
              value={formData.firstDepositBonus.rupees}
              onChange={(e) => setFormData({ ...formData, firstDepositBonus: {
                rupees: Math.min(100000, Math.max(0, Math.floor(Number(e.target.value) || 0))) } })}
              className="input"
            />
            <SettingHelp path="firstDepositBonus.rupees" />
          </div>
          <div>
            <label className="label" htmlFor="referral-turnoverMultiplier">Play requirement for every bonus (× the bonus)</label>
            <input id="referral-turnoverMultiplier"
              type="number" min={1} max={100} step={1}
              value={formData.referralRewards.turnoverMultiplier}
              onChange={(e) => setFormData({ ...formData, referralRewards: { ...formData.referralRewards,
                turnoverMultiplier: Math.min(100, Math.max(1, Math.floor(Number(e.target.value) || 1))) } })}
              className="input"
            />
            <SettingHelp path="referralRewards.turnoverMultiplier" />
          </div>
        </div>
      </div>

      {/* ── FOOTER NAVIGATION (2026-07-13) — admin-editable user-panel tabs ── */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-1">Footer Navigation (User Panel)</h3>
        <p className="text-xs text-gray-400 mb-4">
          Choose which pages appear in the player app&apos;s bottom bar on phones and
          tablets, and in what order (2–5 tabs; a Menu tab always comes last).
          Applies live to all connected players, no redeploy.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[0, 1, 2, 3, 4].map((i) => {
            // The keys are the server's FOOTER_PAGE_KEYS (systemConfigPayload.js).
            const FOOTER_PAGE_OPTIONS: [string, string][] = [
              ['home', '🎲 Game'], ['results', '📊 Results'], ['winners', '🏆 Winners'],
              ['leaderboard', '📈 Leaderboard'], ['promo', '💡 Pro Tips'], ['profile', '👤 Profile'],
              ['wallet', '💰 Wallet'], ['referrals', '🎁 Refer & Earn'],
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
        <SettingHelp path="footerPages" className="mt-2" />
        <p className="text-xs text-gray-500 mt-1">
          Duplicates are disabled. Provider pages (Casino/Crash/Sports) still only show when that provider is enabled.
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
        <SettingHelp path="alertWebhookUrl" />
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
            ['enabled', 'Enable JA3 Policy'],
            ['logOnly', 'Log Only Mode'],
            ['requireJa3Hash', 'Require JA3 Hash'],
          ] as const).map(([field, label]) => (
            <div key={field} className="flex items-center justify-between">
              <div className="pr-4">
                <p className="font-medium">{label}</p>
                <SettingHelp path={`tlsFingerprintDefense.${field}`} />
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
            <SettingHelp path="tlsFingerprintDefense.blockJa3Hashes" />
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
            <SettingHelp path="webUrl" />
          </div>

          <div className="text-xs text-gray-400 rounded-lg border border-dark-700 p-3">
            <span className="font-semibold text-gray-300">Android app:</span> uploaded, published and force-updated on the{' '}
            <a href="#/android-app" className="underline">Android App</a> page. The download link in the player app always points at the newest published release.
          </div>

          <div>
            <label className="label" htmlFor="ios-url">iOS URL <span className="text-gray-500 font-normal">(optional)</span></label>
            <input id="ios-url"
              type="url"
              value={formData.iosUrl}
              onChange={(e) => setFormData({ ...formData, iosUrl: e.target.value })}
              className="input"
              placeholder="https://apps.apple.com/... (leave blank for Add to Home Screen)"
            />
            <SettingHelp path="iosUrl" />
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
              <SettingHelp path="minVersion" />
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
              <SettingHelp path="latestVersion" />
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
          || (orderSizeRails.length > 0 && (formData.buyOrderSizes.length === 0 || formData.sellOrderSizes.length === 0))
          || !usdtStepOk(formData.usdtBuy.minUsdt) || !usdtStepOk(formData.usdtBuy.maxUsdt)
          || (formData.usdtBuy.minUsdt > formData.usdtBuy.maxUsdt)
          || ROUTING_RAILS.some((r) => outOfRange(formData.teamRouting.concurrency[r.rail], r.concurrency)
            || outOfRange(formData.teamRouting.processingWindowSeconds[r.rail], r.processing))
          || ROUTING_TIMERS.some((t) => outOfRange(formData.teamRouting[t.key], t))
          || MERCHANT_ROUTING_DIRECTIONS.some((d) => outOfRange(formData.merchantRouting.concurrency[d.direction], d.concurrency)
            || outOfRange(formData.merchantRouting.processingWindowSeconds[d.direction], d.processing))
          || outOfRange(formData.merchantRouting.assignmentWaitSeconds, MERCHANT_ASSIGNMENT_WAIT)
          || DIRECT_MERCHANT_FIELDS.some((f) => outOfRange(formData.directMerchants[f.key], f))}
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
    </SettingHelpProvider>
  );
};
