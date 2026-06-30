// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useState, useEffect } from 'react';
import { useGame } from '../services/GameContext';
import Header from '../components/Layout/Header';
import Footer from '../components/Layout/Footer';
import CycleControl from '../components/Game/CycleControl';
import BettingCard from '../components/Game/BettingCard';
import BetControls from '../components/Game/BetControls';
import LivePoolStats from '../components/Game/LivePoolStats';
// Oracle (AIAnalyst) removed — the "Bazaar Oracle" prediction button has been
// removed from the game page. It was a purple floating button that called an
// AI prediction endpoint. Removed per product decision.
import { BettingSide, GameState, PromoContent } from '../types';
// Fix: Import useNavigate from 'react-router'
import { useNavigate, useLocation } from 'react-router';
import GameCategoryStrip from '../components/Game/GameCategoryStrip';
// MIN_BET removed — GamePage now reads live sysConfig.minBet from GameContext (C-3 fix)
import { getBackend, getAssetUrl } from '../services/backend.service'; 
import Modal from '../components/ui/Modal';
import { Show } from '../components/ui/Show';
import AuthModal from '../components/Modals/AuthModal';
import WalletModal from '../components/Modals/WalletModal';

const backend = getBackend();

const GamePage: React.FC = () => {
  const { currentCycle, gameState, pastCycles, placeBet, placePhantomBet, cycleType, isGhostMode, isAuthenticated, sysConfig, user } = useGame();
  const [betAmount, setBetAmount] = useState<number | null>(null);
  const navigate  = useNavigate();
  const location  = useLocation();
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [chatOrderId, setChatOrderId] = useState<string | null>(null);

  const [promoPopup, setPromoPopup] = useState<PromoContent | null>(null);

  useEffect(() => {
    setBetAmount(null);
  }, [cycleType]);

  useEffect(() => {
    const hasSeen = localStorage.getItem('hasSeenPromoPopup');
    if (hasSeen) return;

    const loadPopup = async () => {
       try {
         const promos = await backend.getPublicContent('HOME_POPUP');
         if (promos.length > 0) {
           setPromoPopup(promos[0]);
           localStorage.setItem('hasSeenPromoPopup', 'true');
         }
       } catch {
         // Promo popup is optional -- silently skip if route unavailable
       }
    };
    loadPopup();
  }, []);


  // ── DEPOSIT INTERCEPT (from WalletPage "Buy Tokens" → navigate('/',{state:{openDeposit:true}})) ──
  useEffect(() => {
    const state = location.state as Record<string, unknown> | null;
    if (state?.openDeposit) {
      if (isAuthenticated) {
        setShowWalletModal(true);
      } else {
        setShowAuthModal(true);
      }
      // Clear the navigation state so back/forward doesn't re-trigger the modal
      window.history.replaceState({}, document.title, window.location.href);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once on mount — location.state is consumed immediately

  const handlePlaceBet = (side: BettingSide) => {
    // Check if user is authenticated - if not, show auth modal
    if (!isAuthenticated) {
      setShowAuthModal(true);
      return;
    }

    if (!betAmount) {
      alert("Please select a chip or enter amount first!");
      return;
    }
    
    // Live server-pushed value — single authority is GameContext.sysConfig.
    // Server enforcement in bet.routes.js is authoritative; this is the client pre-check.
    const minRequired = sysConfig?.minBet ?? 10;
    if (betAmount < minRequired) {
        alert(`Minimum bet for this cycle is Rs.${minRequired}`);
        return;
    }

    if (navigator.vibrate) navigator.vibrate(50);
    
    if (isGhostMode) {
        placePhantomBet(betAmount, side);
    } else {
        placeBet(betAmount, side);
    }
  };

  const showMerged = gameState === GameState.MERGED || gameState === GameState.CLOSED;

  return (
    <div className={`h-full w-full flex flex-col bg-gradient-to-b from-[#0B0E14] to-[#121826] relative ${isGhostMode ? 'border-4 border-purple-900/50' : ''}`}>
      <Header onAuthRequired={() => setShowAuthModal(true)} />
      <GameCategoryStrip />

      {/* AUTH MODAL - Only show when explicitly requested */}
      {showAuthModal && !isAuthenticated ? (
          <AuthModal onClose={() => setShowAuthModal(false)} />
      ) : null}

      <CycleControl />

      <div className="flex-none flex flex-col items-center justify-center relative px-4 py-4 min-h-[60px]">
        <h2 className="text-[#EAEAEA] font-bold text-base md:text-lg tracking-wide shadow-black drop-shadow-md flex items-center">
          DELHI BAZAAR <span className="text-[#D4AF37] italic mx-2 text-lg font-black">VS</span> BOMBAY BAZAAR
        </h2>
        <LivePoolStats showMerged={showMerged} />
      </div>

      <BettingCard onPlaceBet={handlePlaceBet} selectedAmount={betAmount} isMerged={showMerged} />

      {/* -- RESULT STRIP -- previous results, both cycle types, colored balls -- */}
      <div className="flex-none py-2 px-3 flex items-center gap-1.5 border-y border-[#121826] bg-black/20 backdrop-blur-sm z-20 mb-2 min-h-[40px] overflow-x-auto scrollbar-none">

        {/* 30-MIN results */}
        <span className="text-[8px] font-bold text-[#D4AF37]/60 uppercase tracking-widest shrink-0 mr-0.5">30M</span>
        <div className="flex items-center gap-1 flex-1 overflow-hidden">
          {pastCycles
            .filter(c => (c.type as string) === '30_MIN' && c.winner)
            .slice(0, 30)
            .map((c, i) => (
              <div
                key={`30m-${c.id || i}`}
                title={c.winner === 'DELHI' ? 'Delhi won' : 'Bombay won'}
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white shrink-0 shadow-md border border-white/10
                  ${c.winner === 'DELHI' ? 'bg-[#E53935]' : 'bg-[#1E88E5]'}
                `}
              >
                {c.winner === 'DELHI' ? 'D' : 'B'}
              </div>
            ))}
          {pastCycles.filter(c => (c.type as string) === '30_MIN' && c.winner).length === 0 && (
            <span className="text-[9px] text-white/20 italic">no results yet</span>
          )}
        </div>

        {/* Divider */}
        <div className="w-px h-4 bg-[#D4AF37]/30 shrink-0 mx-0.5" />

        {/* FULL-DAY results */}
        <span className="text-[8px] font-bold text-[#D4AF37]/60 uppercase tracking-widest shrink-0 mr-0.5">24H</span>
        <div className="flex items-center gap-1">
          {pastCycles
            .filter(c => (c.type as string) === 'FULL_DAY' && c.winner)
            .slice(0, 5)
            .map((c, i) => (
              <div
                key={`fd-${c.id || i}`}
                title={c.winner === 'DELHI' ? 'Delhi won' : 'Bombay won'}
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white shrink-0 shadow-md border border-white/10
                  ${c.winner === 'DELHI' ? 'bg-[#E53935]' : 'bg-[#1E88E5]'}
                `}
              >
                {c.winner === 'DELHI' ? 'D' : 'B'}
              </div>
            ))}
          {pastCycles.filter(c => (c.type as string) === 'FULL_DAY' && c.winner).length === 0 && (
            <span className="text-[9px] text-white/20 italic">--</span>
          )}
        </div>

        {/* Results button */}
        <button
          onClick={() => navigate('/history')}
          className="text-[#D4AF37] text-[9px] uppercase font-bold tracking-wider px-2 py-0.5 border border-[#D4AF37]/50 rounded hover:bg-[#D4AF37] hover:text-black transition-colors shrink-0 ml-1"
        >
          All
        </button>
      </div>

      <BetControls onAmountChange={setBetAmount} currentAmount={betAmount} />
      <Footer />
      
      


      {/* ── DEPOSIT MODAL — triggered by openDeposit navigation state ── */}
      {showWalletModal && isAuthenticated && (
        <WalletModal
          isOpen={showWalletModal}
          onClose={() => setShowWalletModal(false)}
          onOpenChat={(orderId) => { setChatOrderId(orderId); setShowWalletModal(false); }}
          onNavigateToHistory={() => { setShowWalletModal(false); navigate('/wallet'); }}
        />
      )}
      {chatOrderId && isAuthenticated && user && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-gray-900 border border-white/10 rounded-t-3xl sm:rounded-2xl w-full max-w-md h-[85vh] flex flex-col overflow-hidden">
            {}
          </div>
        </div>
      )}

      {promoPopup !== null ? (
        <Modal onClose={() => setPromoPopup(null)} title="">
          <div className="text-center relative">
              <button 
                onClick={() => setPromoPopup(null)}
                className="absolute -top-3 -right-3 w-8 h-8 flex items-center justify-center bg-black/50 hover:bg-red-500 text-white/70 hover:text-white rounded-full border border-white/20 transition-colors z-50 backdrop-blur-md"
              >
                ?
              </button>
              <div className="absolute -top-10 -left-10 text-6xl opacity-20 animate-spin-slow">?</div>
              <div className="absolute -bottom-10 -right-10 text-6xl opacity-20 animate-bounce">?</div>

              <h2 className="text-xl font-black text-[#D4AF37] mb-3 uppercase tracking-widest drop-shadow-md">
                {promoPopup?.title}
              </h2>
              
              {promoPopup?.fileUrl !== undefined && promoPopup?.fileUrl !== null && promoPopup?.fileUrl !== '' ? (
                <div className="w-full rounded-xl overflow-hidden border-2 border-[#D4AF37]/50 shadow-[0_0_20px_rgba(212,175,55,0.2)] mb-4 bg-black">
                    <img 
                        src={getAssetUrl(promoPopup?.fileUrl || '', '')} 
                        alt="Promo" 
                        className="w-full h-auto object-cover max-h-[300px]" 
                    />
                </div>
              ) : null}

              <div className="bg-[#121826] p-4 rounded-lg border border-white/5 mb-6">
                <p className="text-slate-200 text-sm font-medium leading-relaxed whitespace-pre-wrap">
                    {promoPopup?.description}
                </p>
              </div>
              <button 
                onClick={() => setPromoPopup(null)}
                className="w-full bg-gradient-to-r from-[#D4AF37] to-[#F5C77A] hover:from-[#B8860B] hover:to-[#D4AF37] text-black font-black py-4 rounded-xl shadow-lg transform transition-all hover:scale-[1.02] active:scale-95 text-sm tracking-wider uppercase"
              >
                ? ENTER ARENA ?
              </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

export default GamePage;

