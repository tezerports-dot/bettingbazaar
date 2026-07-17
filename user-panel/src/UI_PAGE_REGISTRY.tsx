// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React from 'react';
import GamePage from './pages/GamePage';
import ProfilePage from './pages/ProfilePage';
import HistoryPage from './pages/HistoryPage';
import ResultsPage from './pages/ResultsPage';
import PromoPage from './pages/PromoPage';
import RulesPage from './pages/RulesPage';
import FaqPage from './pages/FaqPage';
import MyBetsPage from './pages/MyBetsPage';
import SupportPage from './pages/SupportPage';
import AccountRecoveryPage from './pages/AccountRecoveryPage';

const CasinoPage = React.lazy(() => import('./pages/CasinoPage'));
const CrashPage = React.lazy(() => import('./pages/CrashPage'));
const SportsPage = React.lazy(() => import('./pages/SportsPage'));
const WinnersPage = React.lazy(() => import('./pages/WinnersPage'));
const WalletPage = React.lazy(() => import('./pages/WalletPage'));
const InvitePage = React.lazy(() => import('./pages/InvitePage'));
const VIPPage = React.lazy(() => import('./pages/VIPPage'));
const GiftCodePage = React.lazy(() => import('./pages/GiftCodePage'));

export type ShellMode = 'game' | 'page' | 'blank';

export interface UiPageDefinition {
  path: string;
  label: string;
  icon: string;
  shellMode: ShellMode;
  navGroup: 'play' | 'finance' | 'account' | 'community' | 'info' | 'system';
  element: React.ReactElement;
}

export const UI_PAGE_REGISTRY: UiPageDefinition[] = [
  { path: '/', label: 'Delhi vs Bombay', icon: '🎲', shellMode: 'game', navGroup: 'play', element: <GamePage /> },
  { path: '/casino', label: 'All Games', icon: '🎰', shellMode: 'page', navGroup: 'play', element: <CasinoPage /> },
  { path: '/crash', label: 'Crash', icon: '🚀', shellMode: 'page', navGroup: 'play', element: <CrashPage /> },
  { path: '/sports', label: 'Sports', icon: '⚽', shellMode: 'page', navGroup: 'play', element: <SportsPage /> },
  { path: '/wallet', label: 'Wallet', icon: '💳', shellMode: 'page', navGroup: 'finance', element: <WalletPage /> },
  { path: '/invite', label: 'Invite', icon: '🤝', shellMode: 'page', navGroup: 'finance', element: <InvitePage /> },
  { path: '/vip', label: 'VIP', icon: '💎', shellMode: 'page', navGroup: 'finance', element: <VIPPage /> },
  { path: '/gift-code', label: 'Gift Code', icon: '🎁', shellMode: 'page', navGroup: 'finance', element: <GiftCodePage /> },
  { path: '/profile', label: 'Profile', icon: '👤', shellMode: 'page', navGroup: 'account', element: <ProfilePage /> },
  { path: '/history', label: 'History', icon: '🕒', shellMode: 'page', navGroup: 'account', element: <HistoryPage /> },
  { path: '/my-bets', label: 'My Bets', icon: '📜', shellMode: 'page', navGroup: 'account', element: <MyBetsPage /> },
  { path: '/results', label: 'Results', icon: '📊', shellMode: 'page', navGroup: 'play', element: <ResultsPage /> },
  { path: '/winners', label: 'Winners', icon: '🏆', shellMode: 'page', navGroup: 'play', element: <WinnersPage /> },
  { path: '/promo', label: 'Promotions', icon: '💡', shellMode: 'page', navGroup: 'community', element: <PromoPage /> },
  { path: '/chat', label: 'Live Chat', icon: '💬', shellMode: 'blank', navGroup: 'community', element: <div /> },
  { path: '/rules', label: 'Rules', icon: '📋', shellMode: 'page', navGroup: 'info', element: <RulesPage /> },
  { path: '/faq', label: 'FAQ', icon: '❓', shellMode: 'page', navGroup: 'info', element: <FaqPage /> },
  { path: '/support', label: 'Support', icon: '🛟', shellMode: 'page', navGroup: 'info', element: <SupportPage /> },
  { path: '/recover-account', label: 'Recovery', icon: '🔑', shellMode: 'page', navGroup: 'system', element: <AccountRecoveryPage /> },
];
