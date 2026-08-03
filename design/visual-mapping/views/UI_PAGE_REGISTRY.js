import React from 'react';
import UserPanelShell from '../layouts/UserPanelShell.jsx';
import MerchantPanelShell from '../layouts/MerchantPanelShell.jsx';
import AdminPanelShell from '../layouts/AdminPanelShell.jsx';
import MainBazaarStage from './user/MainBazaarStage';
import CasinoLobby from './user/CasinoLobby';
import CrashArena from './user/CrashArena';
import SportsBook from './user/SportsBook';
import Wallet from './user/Wallet';
import Invite from './user/Invite';
import Vip from './user/Vip';
import GiftCode from './user/GiftCode';
import AccountRecovery from './user/AccountRecovery';
import Profile from './user/Profile';
import TransactionHistory from './user/TransactionHistory';
import MyBets from './user/MyBets';
import Results from './user/Results';
import Winners from './user/Winners';
import Promotions from './user/Promotions';
import Rules from './user/Rules';
import Faq from './user/Faq';
import Support from './user/Support';
import MerchantLogin from './merchant/MerchantLogin';
import MerchantDashboard from './merchant/MerchantDashboard';
import MerchantOrders from './merchant/MerchantOrders';
import MerchantHistory from './merchant/MerchantHistory';
import MerchantProfile from './merchant/MerchantProfile';
import MerchantPayouts from './merchant/MerchantPayouts';
import AdminLogin from './admin/AdminLogin';
import AdminDashboard from './admin/AdminDashboard';
import LiveCycles from './admin/LiveCycles';
import CycleHistory from './admin/CycleHistory';
import ProfitLoss from './admin/ProfitLoss';
import Users from './admin/Users';
import BalanceAdjustments from './admin/BalanceAdjustments';
import Merchants from './admin/Merchants';
import KycQueue from './admin/KycQueue';
import Transactions from './admin/Transactions';
import QueueManager from './admin/QueueManager';
import PaymentControl from './admin/PaymentControl';
import Disputes from './admin/Disputes';
import DepositPolicy from './admin/DepositPolicy';
import RevenueLedger from './admin/RevenueLedger';
import Operations from './admin/Operations';
import Reports from './admin/Reports';
import MerchantPlatform from './admin/MerchantPlatform';
import GameRegistry from './admin/GameRegistry';
import GameProviders from './admin/GameProviders';
import RecoveryQueue from './admin/RecoveryQueue';
import WinnersManager from './admin/WinnersManager';
import SupportOperations from './admin/SupportOperations';
import Announcements from './admin/Announcements';
import GiftCodes from './admin/GiftCodes';
import FaqManager from './admin/FaqManager';
import ContentSlides from './admin/ContentSlides';
import SupportLinks from './admin/SupportLinks';
import CdnLibrary from './admin/CdnLibrary';
import Branding from './admin/Branding';
import AppAssets from './admin/AppAssets';
import SubAdmins from './admin/SubAdmins';
import SystemSettings from './admin/SystemSettings';
import AuditLogs from './admin/AuditLogs';
import ErrorLogs from './admin/ErrorLogs';

/**
 * Exact 59-view presentation-to-API mapping — 18 player, 6 merchant, 35 admin.
 * No backend model is imported here.
 *
 * The count is stated because §4 tells you to grep this registry before adding a
 * screen; a registry that misdescribes its own size undermines that instruction.
 * It read "60" until 2026-07-30 while holding 59 entries. Re-derive rather than
 * trusting the prose — anchored to the entry indentation so the command does not
 * match itself inside this comment and inflate its own answer:
 *   grep -c "^  { key: '" design/visual-mapping/views/UI_PAGE_REGISTRY.js
 */
export const UI_PAGE_REGISTRY = Object.freeze([
  { key: 'main_bazaar_stage', path: '/', component: MainBazaarStage, componentName: 'MainBazaarStage', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/bet/place, /api/sse/events' },
  { key: 'casino_lobby', path: '/casino', component: CasinoLobby, componentName: 'CasinoLobby', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/game/providers, /api/game/games' },
  { key: 'crash_arena', path: '/crash', component: CrashArena, componentName: 'CrashArena', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/game/launch' },
  { key: 'sports_book', path: '/sports', component: SportsBook, componentName: 'SportsBook', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/game/games' },
  { key: 'wallet', path: '/wallet', component: Wallet, componentName: 'Wallet', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/v1/user/profile, /api/payment/orders, /api/v1/wallet/ledger' },
  { key: 'invite', path: '/invite', component: Invite, componentName: 'Invite', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/referral/me, /api/referral/team, /api/referral/commissions' },
  { key: 'vip', path: '/vip', component: Vip, componentName: 'Vip', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/vip/config, /api/vip/my' },
  { key: 'gift_code', path: '/gift-code', component: GiftCode, componentName: 'GiftCode', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/giftcode/redeem' },
  { key: 'account_recovery', path: '/recover-account', component: AccountRecovery, componentName: 'AccountRecovery', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/auth/check-aadhaar, /api/auth/recover' },
  { key: 'profile', path: '/profile', component: Profile, componentName: 'Profile', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/v1/user/profile, /api/user/:userId/kyc' },
  { key: 'transaction_history', path: '/history', component: TransactionHistory, componentName: 'TransactionHistory', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/payment/orders' },
  { key: 'my_bets', path: '/my-bets', component: MyBets, componentName: 'MyBets', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/user/:userId/bets' },
  { key: 'results', path: '/results', component: Results, componentName: 'Results', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/v1/game/cycles/history' },
  { key: 'winners', path: '/winners', component: Winners, componentName: 'Winners', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/v1/winners, /api/leaderboard/:period' },
  { key: 'promotions', path: '/promo', component: Promotions, componentName: 'Promotions', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/announcements' },
  { key: 'rules', path: '/rules', component: Rules, componentName: 'Rules', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/v1/system/config' },
  { key: 'faq', path: '/faq', component: Faq, componentName: 'Faq', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/v1/content/faq' },
  { key: 'support', path: '/support', component: Support, componentName: 'Support', layout: UserPanelShell, layoutName: 'UserPanelShell', apiBinding: '/api/v1/content/support-links, /api/support/ask' },
  { key: 'merchant_login', path: '/merchant', component: MerchantLogin, componentName: 'MerchantLogin', layout: MerchantPanelShell, layoutName: 'MerchantPanelShell', apiBinding: '/api/merchant/auth/login' },
  { key: 'merchant_dashboard', path: '/merchant/dashboard', component: MerchantDashboard, componentName: 'MerchantDashboard', layout: MerchantPanelShell, layoutName: 'MerchantPanelShell', apiBinding: '/api/merchant/stats, /api/merchant/earnings' },
  { key: 'merchant_orders', path: '/merchant/orders', component: MerchantOrders, componentName: 'MerchantOrders', layout: MerchantPanelShell, layoutName: 'MerchantPanelShell', apiBinding: '/api/merchant/orders' },
  { key: 'merchant_history', path: '/merchant/history', component: MerchantHistory, componentName: 'MerchantHistory', layout: MerchantPanelShell, layoutName: 'MerchantPanelShell', apiBinding: '/api/merchant/orders, /api/merchant/earnings/weekly' },
  { key: 'merchant_profile', path: '/merchant/profile', component: MerchantProfile, componentName: 'MerchantProfile', layout: MerchantPanelShell, layoutName: 'MerchantPanelShell', apiBinding: '/api/merchant/profile' },
  { key: 'merchant_payouts', path: '/merchant/payouts', component: MerchantPayouts, componentName: 'MerchantPayouts', layout: MerchantPanelShell, layoutName: 'MerchantPanelShell', apiBinding: '/api/merchant/bulk-payouts, /api/merchant/bulk-payouts/export' },
  { key: 'admin_login', path: '/admin/login', component: AdminLogin, componentName: 'AdminLogin', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/login' },
  { key: 'admin_dashboard', path: '/admin', component: AdminDashboard, componentName: 'AdminDashboard', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/analytics/dashboard' },
  { key: 'live_cycles', path: '/admin/live-cycles', component: LiveCycles, componentName: 'LiveCycles', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/cycles/phases' },
  { key: 'cycle_history', path: '/admin/cycle-history', component: CycleHistory, componentName: 'CycleHistory', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/cycles/history' },
  { key: 'profit_loss', path: '/admin/profit-loss', component: ProfitLoss, componentName: 'ProfitLoss', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/analytics/financials' },
  { key: 'users', path: '/admin/users', component: Users, componentName: 'Users', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/users' },
  { key: 'balance_adjustments', path: '/admin/users/balance-adjust', component: BalanceAdjustments, componentName: 'BalanceAdjustments', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/balance-adjustments' },
  { key: 'merchants', path: '/admin/merchants', component: Merchants, componentName: 'Merchants', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/merchants' },
  { key: 'kyc_queue', path: '/admin/kyc', component: KycQueue, componentName: 'KycQueue', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/kyc/queue' },
  { key: 'transactions', path: '/admin/transactions', component: Transactions, componentName: 'Transactions', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/transactions' },
  { key: 'queue_manager', path: '/admin/queue-manager', component: QueueManager, componentName: 'QueueManager', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/queue/pending-orders' },
  { key: 'payment_control', path: '/admin/payment-control', component: PaymentControl, componentName: 'PaymentControl', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/payment/admin/config, /api/admin/withdrawal-requests' },
  { key: 'disputes', path: '/admin/disputes', component: Disputes, componentName: 'Disputes', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/dispute-orders' },
  { key: 'deposit_policy', path: '/admin/business-policy/deposit', component: DepositPolicy, componentName: 'DepositPolicy', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/deposit-policy/:currency' },
  { key: 'revenue_ledger', path: '/admin/revenue', component: RevenueLedger, componentName: 'RevenueLedger', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/revenue/ledger' },
  { key: 'operations', path: '/admin/operations', component: Operations, componentName: 'Operations', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/operations/overview' },
  { key: 'reports', path: '/admin/reports', component: Reports, componentName: 'Reports', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/reports/ledger-export' },
  { key: 'merchant_platform', path: '/admin/merchant-platform', component: MerchantPlatform, componentName: 'MerchantPlatform', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/merchant-platform/leaderboard' },
  { key: 'game_registry', path: '/admin/games', component: GameRegistry, componentName: 'GameRegistry', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/game/admin/games, /api/game/admin/categories' },
  { key: 'game_providers', path: '/admin/game-providers', component: GameProviders, componentName: 'GameProviders', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/game/admin/game-providers' },
  { key: 'recovery_queue', path: '/admin/account-recovery', component: RecoveryQueue, componentName: 'RecoveryQueue', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/account-recovery' },
  { key: 'winners_manager', path: '/admin/winners-manager', component: WinnersManager, componentName: 'WinnersManager', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/fake-winners' },
  { key: 'support_operations', path: '/admin/chat-management', component: SupportOperations, componentName: 'SupportOperations', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/support/status, /api/admin/support/documents' },
  { key: 'announcements', path: '/admin/promotions/announcements', component: Announcements, componentName: 'Announcements', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/announcements' },
  { key: 'gift_codes', path: '/admin/promotions/gift-codes', component: GiftCodes, componentName: 'GiftCodes', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/giftcodes' },
  { key: 'faq_manager', path: '/admin/content/faq', component: FaqManager, componentName: 'FaqManager', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/content/faq' },
  { key: 'content_slides', path: '/admin/content/slides', component: ContentSlides, componentName: 'ContentSlides', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/content/slides' },
  { key: 'support_links', path: '/admin/content/support', component: SupportLinks, componentName: 'SupportLinks', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/content/support-links' },
  { key: 'cdn_library', path: '/admin/content/cdn', component: CdnLibrary, componentName: 'CdnLibrary', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/branding/images' },
  { key: 'branding', path: '/admin/branding', component: Branding, componentName: 'Branding', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/branding' },
  { key: 'app_assets', path: '/admin/app-assets', component: AppAssets, componentName: 'AppAssets', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/app-assets' },
  { key: 'sub_admins', path: '/admin/sub-admins', component: SubAdmins, componentName: 'SubAdmins', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/sub-admins' },
  { key: 'system_settings', path: '/admin/settings', component: SystemSettings, componentName: 'SystemSettings', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/system/config' },
  { key: 'audit_logs', path: '/admin/audit-logs', component: AuditLogs, componentName: 'AuditLogs', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/audit-logs' },
  { key: 'error_logs', path: '/admin/error-logs', component: ErrorLogs, componentName: 'ErrorLogs', layout: AdminPanelShell, layoutName: 'AdminPanelShell', apiBinding: '/api/admin/error-reports' }
]);

export const UI_PAGE_BY_KEY = Object.freeze(Object.fromEntries(UI_PAGE_REGISTRY.map(page => [page.key, page])));
export default UI_PAGE_REGISTRY;
