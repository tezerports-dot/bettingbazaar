// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../services/AuthContext';
import { Home, Package, History, User, LogOut, Power, Menu, X } from 'lucide-react';
import { api } from '../services/api';
import toast from 'react-hot-toast';
import { AnimatePresence, motion } from 'framer-motion';

const navItems = [
  { path: '/dashboard',    icon: Home,     label: 'Dashboard' },
  { path: '/orders',       icon: Package,  label: 'Orders' },
  { path: '/history',      icon: History,  label: 'History' },
  { path: '/profile',      icon: User,     label: 'Profile' },
];

const MerchantNav: React.FC<{ onNavigate?: () => void }> = ({ onNavigate }) => {
  const location = useLocation();
  return (
    <nav className="space-y-2 px-3 py-4">
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = location.pathname === item.path;
        return (
          <Link
            key={item.path}
            to={item.path}
            onClick={onNavigate}
            className={`group flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-black transition-all active:scale-[0.98] ${
              isActive
                ? 'bg-[#2de370] text-[#07130d] shadow-[0_0_24px_rgba(45,227,112,0.25)]'
                : 'text-[#b1b6bb] hover:bg-[#213743] hover:text-white'
            }`}
          >
            <Icon className="h-5 w-5" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
};

const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { merchant, logout, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleToggleOnline = async () => {
    try {
      await api.toggleOnlineStatus(!merchant?.isOnline);
      await refreshProfile();
      toast.success(merchant?.isOnline ? 'You are now offline' : 'You are now online');
    } catch (error: any) {
      toast.error(error.message || 'Failed to update status');
    }
  };

  return (
    <div className="merchant-shell h-[100dvh] overflow-hidden bg-[#0f212e] text-white">
      <div className="flex h-full min-h-0">
        <aside className="hidden w-[260px] shrink-0 border-r border-white/5 bg-[#1a2c38]/95 backdrop-blur-xl lg:flex lg:flex-col">
          <div className="border-b border-white/5 p-4">
            <button onClick={() => navigate('/dashboard')} className="flex w-full items-center gap-3 rounded-2xl bg-[#213743] p-3 text-left active:scale-[0.98] transition-transform">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#2de370] text-[#07130d] shadow-[0_0_24px_rgba(45,227,112,0.25)]">₹</span>
              <span className="min-w-0"><img src="/brand/brand-wordmark.svg" alt="Betting-Bazaar.com" className="h-9 w-40 object-contain object-left" /><span className="block text-[10px] uppercase tracking-[0.2em] text-[#b1b6bb]">Settlement Ops</span></span>
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar"><MerchantNav /></div>
          <div className="border-t border-white/5 p-4">
            <div className="rounded-2xl bg-[#213743] p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#b1b6bb]">Current Status</p>
              <div className="mt-3 flex items-center gap-2"><span className={`h-3 w-3 rounded-full ${merchant?.isOnline ? 'bg-[#2de370] animate-pulse' : 'bg-[#b1b6bb]'}`} /><span className="text-sm font-bold">{merchant?.isOnline ? 'Available for Orders' : 'Offline'}</span></div>
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/5 bg-[#1a2c38]/90 px-4 backdrop-blur-xl sm:px-6">
            <div className="flex items-center gap-3">
              <button onClick={() => setDrawerOpen(true)} className="grid h-10 w-10 place-items-center rounded-xl bg-[#213743] text-[#b1b6bb] lg:hidden"><Menu className="h-5 w-5" /></button>
              <div className="flex min-w-0 items-center"><img src="/brand/brand-wordmark.svg" alt="Betting-Bazaar.com" className="h-10 w-[min(46vw,260px)] object-contain object-left" /></div>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <button onClick={handleToggleOnline} className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-black transition-all active:scale-95 ${merchant?.isOnline ? 'bg-[#2de370] text-[#07130d]' : 'bg-[#213743] text-[#b1b6bb] hover:text-white'}`} title={merchant?.isOnline ? 'Click to go offline' : 'Click to go online'}><Power className="h-4 w-4" /><span className="hidden sm:inline">{merchant?.isOnline ? 'Online' : 'Offline'}</span></button>
              <button onClick={() => navigate('/profile')} className="hidden rounded-xl bg-[#213743] px-3 py-2 text-xs font-bold text-[#b1b6bb] hover:text-white sm:block">{merchant?.username}</button>
              <button onClick={logout} className="grid h-10 w-10 place-items-center rounded-xl bg-red-500/10 text-red-300 hover:bg-red-500/20"><LogOut className="h-4 w-4" /></button>
            </div>
          </header>

          <main className="merchant-render-target min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}>
              {children}
            </motion.div>
          </main>
        </div>
      </div>

      <AnimatePresence>
        {drawerOpen && (
          <motion.div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDrawerOpen(false)}>
            <motion.aside initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }} transition={{ type: 'spring', stiffness: 360, damping: 34 }} className="h-full w-[280px] bg-[#1a2c38] pb-[env(safe-area-inset-bottom)]" onClick={(e) => e.stopPropagation()}>
              <div className="flex h-16 items-center justify-between border-b border-white/5 px-4"><span className="font-black">Merchant Desk</span><button onClick={() => setDrawerOpen(false)}><X /></button></div>
              <MerchantNav onNavigate={() => setDrawerOpen(false)} />
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Layout;
