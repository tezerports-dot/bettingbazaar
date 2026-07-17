// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'framer-motion';
import Header from '../Layout/Header';
import Footer from '../Layout/Footer';
import { UI_PAGE_REGISTRY } from '../../UI_PAGE_REGISTRY';
import { useGame } from '../../services/GameContext';

const groups = ['play', 'finance', 'account', 'community', 'info'] as const;
const groupLabels: Record<string, string> = { play: 'Play', finance: 'Banking', account: 'Account', community: 'Community', info: 'Help' };

const ShellNav: React.FC<{ onNavigate?: () => void }> = ({ onNavigate }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const itemsByGroup = useMemo(() => groups.map(group => ({ group, items: UI_PAGE_REGISTRY.filter(p => p.navGroup === group) })), []);
  return (
    <nav className="h-full overflow-y-auto px-3 py-4 custom-scrollbar">
      <button onClick={() => { navigate('/'); onNavigate?.(); }} className="mb-5 flex w-full items-center gap-3 rounded-2xl bg-[#213743] p-3 text-left shadow-[0_10px_30px_rgba(0,0,0,0.22)] active:scale-[0.98] transition-transform">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#2de370] text-xl shadow-[0_0_24px_rgba(45,227,112,0.22)]">🎲</span>
        <span><span className="block text-sm font-black text-white">Betting Bazaar</span><span className="text-[10px] uppercase tracking-[0.18em] text-[#b1b6bb]">Live Exchange</span></span>
      </button>
      {itemsByGroup.map(({ group, items }) => (
        <section key={group} className="mb-4">
          <h3 className="mb-2 px-2 text-[10px] font-black uppercase tracking-[0.22em] text-[#b1b6bb]/70">{groupLabels[group]}</h3>
          <div className="space-y-1">
            {items.map(item => {
              const active = item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);
              return <button key={item.path} onClick={() => { navigate(item.path); onNavigate?.(); }} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold transition-all active:scale-[0.98] ${active ? 'bg-[#2de370] text-[#07130d] shadow-[0_0_20px_rgba(45,227,112,0.22)]' : 'text-[#b1b6bb] hover:bg-[#213743] hover:text-white'}`}><span>{item.icon}</span><span>{item.label}</span></button>;
            })}
          </div>
        </section>
      ))}
    </nav>
  );
};

const RightRail: React.FC = () => {
  const { currentCycle, userBets, cycleType } = useGame();
  return <aside className="hidden xl:flex h-full w-[320px] shrink-0 flex-col border-l border-white/5 bg-[#1a2c38]/95 backdrop-blur-xl">
    <div className="border-b border-white/5 p-4"><p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#b1b6bb]">Active Bet Slip</p><h2 className="mt-1 text-lg font-black text-white">{cycleType === 'FULL_DAY' ? 'Full Day' : '30 Min'} Cycle</h2></div>
    <div className="space-y-3 p-4">
      <div className="rounded-2xl bg-[#213743] p-4"><div className="flex justify-between text-xs text-[#b1b6bb]"><span>Cycle ID</span><span className="text-white">{currentCycle.id.replace('LOADING_', '')}</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-[#0f212e]"><div className="h-full w-2/3 rounded-full bg-[#2de370]" /></div></div>
      <div className="rounded-2xl bg-[#213743] p-4"><p className="text-[10px] font-black uppercase tracking-widest text-[#b1b6bb]">Recent Bets</p>{userBets.slice(0, 4).map(b => <div key={b.id} className="mt-3 flex justify-between text-xs"><span className="text-white">{b.side}</span><span className="font-bold text-[#2de370]">₹{b.amount}</span></div>)}{userBets.length === 0 && <p className="mt-4 text-xs text-[#b1b6bb]">No active bets yet.</p>}</div>
      <div className="rounded-2xl bg-[#213743] p-4"><p className="text-[10px] font-black uppercase tracking-widest text-[#b1b6bb]">Global Chat</p><div className="mt-4 space-y-3 text-xs text-[#b1b6bb]"><p><b className="text-white">System</b> Welcome to the live room.</p><p><b className="text-[#2de370]">Dealer</b> Bet responsibly.</p></div></div>
    </div>
  </aside>;
};

const EnterpriseShell: React.FC<{ children: React.ReactNode; isGame?: boolean; onAuthRequired?: () => void }> = ({ children, isGame, onAuthRequired }) => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const location = useLocation();
  return <div className="enterprise-shell h-[100dvh] w-full overflow-hidden bg-[#0f212e] text-white">
    <div className="flex h-full min-h-0 w-full">
      <aside className="hidden h-full w-[240px] shrink-0 border-r border-white/5 bg-[#1a2c38]/95 backdrop-blur-xl lg:block"><ShellNav /></aside>
      <div className="central-stage flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="lg:hidden absolute left-3 top-3 z-[70]"><button onClick={() => setDrawerOpen(true)} className="h-11 w-11 rounded-xl bg-[#213743] text-xl shadow-xl active:scale-95">≡</button></div>
        <Header onAuthRequired={onAuthRequired} />
        <main className="central-stage-render-target min-h-0 flex-1 overflow-y-auto overscroll-contain will-change-transform custom-scrollbar">
          <motion.div key={location.pathname} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, ease: 'easeOut' }} className={isGame ? 'h-full min-h-0' : 'min-h-full'}>{children}</motion.div>
        </main>
        <Footer />
      </div>
      <RightRail />
    </div>
    <button onClick={() => setSheetOpen(true)} className="fixed bottom-[calc(74px+env(safe-area-inset-bottom))] right-4 z-50 grid h-12 w-12 place-items-center rounded-full bg-[#2de370] text-xl text-[#07130d] shadow-[0_0_30px_rgba(45,227,112,0.32)] xl:hidden">💬</button>
    <AnimatePresence>{drawerOpen && <motion.div className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDrawerOpen(false)}><motion.aside initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }} transition={{ type: 'spring', stiffness: 360, damping: 34 }} className="h-full w-[280px] bg-[#1a2c38] pb-[env(safe-area-inset-bottom)]" onClick={e => e.stopPropagation()}><ShellNav onNavigate={() => setDrawerOpen(false)} /></motion.aside></motion.div>}</AnimatePresence>
    <AnimatePresence>{sheetOpen && <motion.div className="fixed inset-0 z-[75] bg-black/60 backdrop-blur-sm xl:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSheetOpen(false)}><motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', stiffness: 320, damping: 32 }} className="absolute bottom-0 left-0 right-0 rounded-t-3xl bg-[#1a2c38] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]" onClick={e => e.stopPropagation()}><RightRail /><div className="xl:hidden"><p className="text-sm font-black">Live Chat & Bet Slip</p><p className="mt-2 text-xs text-[#b1b6bb]">Desktop rail content is available here on mobile.</p></div></motion.div></motion.div>}</AnimatePresence>
  </div>;
};
export default EnterpriseShell;
