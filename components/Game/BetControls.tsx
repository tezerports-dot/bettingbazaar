// C-03 fix: brand colors use CSS variables — GOVERNANCE §3: no hex literals for brand colors.
// Replace: style={{color:'var(--brand-primary)'}} → style={{color: 'var(--brand-primary)'}}
// Replace: className="text-[#D4AF37]" → className="text-[color:var(--brand-primary)]"
// Full sweep is done by scripts/apply-brand-variables.sh (generated in this patch).
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useState, useEffect, memo } from 'react';
import { useGame } from '../../services/GameContext';
import { CHIP_VALUES } from '../../constants';
import { Show } from '../ui/Show';
import { BettingSide, CycleType } from '../../types';

interface BetControlsProps {
  onAmountChange: (amount: number | null) => void;
  currentAmount: number | null;
}

// Configuration for distinct chip styles
const CHIP_STYLES = [
  { colorHex: '#C62828', gradient: 'from-[#B71C1C] to-[#E53935]', text: 'text-white' },
  { colorHex: '#2E7D32', gradient: 'from-[#1B5E20] to-[#43A047]', text: 'text-white' },
  { colorHex: '#1565C0', gradient: 'from-[#0D47A1] to-[#1E88E5]', text: 'text-white' },
  { colorHex: '#6A1B9A', gradient: 'from-[#4A148C] to-[#8E24AA]', text: 'text-white' },
  { colorHex: '#212121', gradient: 'from-[#000000] to-[#424242]', text: 'text-[#D4AF37]' },
];

const BetControls: React.FC<BetControlsProps> = memo(({ onAmountChange, currentAmount }) => {
  const { cycleType, user, isGhostMode, toggleGhostMode, sysConfig } = useGame();
  
  const [manualInput, setManualInput] = useState<string>('');
  
  const chips = CHIP_VALUES[cycleType];
  // FIX A1: read live minBet from sysConfig (server-pushed) instead of
  // hardcoded constants.ts which never changes when admin updates limits.
  const minBet = cycleType === '30_MIN'
    ? (sysConfig?.minBet || 10)
    : (sysConfig?.minBet || 100);

  const canUseGhostMode = (() => {
    const access = user?.phantomAccess;
    if (!access || access === 'NONE') return false;
    if (access === 'BOTH') return true;
    // '30_MIN' agent can only ghost on the 30-MIN tab
    if (access === '30_MIN') return cycleType === CycleType.THIRTY_MIN;
    // 'FULL_DAY' agent can only ghost on the FULL-DAY tab
    if (access === 'FULL_DAY') return cycleType === CycleType.FULL_DAY;
    return false;
  })();

  useEffect(() => {
    setManualInput('');
  }, [cycleType]);

  const handleChipClick = (val: number) => {
    setManualInput(''); 
    if (currentAmount === val) {
        onAmountChange(null);
    } else {
        onAmountChange(val);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const valStr = e.target.value;
    // Block negative values and scientific notation (e.g. -1, 1e5)
    if (valStr.includes('-') || valStr.includes('e')) return;
    setManualInput(valStr);
    const val = parseInt(valStr);
    if (!isNaN(val) && val > 0) {
      onAmountChange(val);
    } else {
      onAmountChange(null);
    }
  };

  return (
    <div className="flex-none w-full flex flex-col justify-center px-4 bg-[#0B0E14]/30 relative z-20 pb-4 pt-2">
      
      {/* GHOST MODE TOGGLE (Only for Agents) */}
      <Show when={canUseGhostMode}>
          <div className="flex justify-center mb-2">
              <button 
                onClick={() => { toggleGhostMode(); onAmountChange(null); }}
                className={`text-[10px] font-bold px-3 py-1 rounded-full border transition-all flex items-center gap-2
                    ${isGhostMode ? 'bg-purple-900/50 border-purple-500 text-purple-300 animate-pulse' : 'bg-slate-800 border-slate-600 text-slate-500'}
                `}
              >
                  <span>👻 GHOST MODE:</span>
                  <span>{isGhostMode ? 'ON' : 'OFF'}</span>
              </button>
          </div>
      </Show>

      {/* CHIPS */}
      <div className={`flex justify-between items-center w-full max-w-md mx-auto px-2 py-6 rounded-xl transition-colors
          ${isGhostMode ? 'bg-purple-900/10 border border-purple-500/30' : ''}
      `}>
        {chips.map((val, index) => {
           const style = CHIP_STYLES[index % CHIP_STYLES.length];
           const isSelected = currentAmount === val && manualInput === '';
           
           return (
             <button
               key={val}
               onClick={() => handleChipClick(val)}
               className={`
                 relative w-[15vw] h-[15vw] max-w-[56px] max-h-[56px] rounded-full flex items-center justify-center 
                 transition-transform duration-150 ease-out
                 ${isSelected ? 'scale-125 -translate-y-3 z-20' : 'hover:-translate-y-1 opacity-95 hover:opacity-100'}
                 active:scale-95 active:translate-y-0
               `}
               style={{
                 boxShadow: isSelected 
                   ? '0 20px 25px -5px rgba(0, 0, 0, 0.7), 0 10px 10px -5px rgba(0,0,0,0.5)' 
                   : '0 4px 6px -1px rgba(0, 0, 0, 0.5)'
               }}
             >
               <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-[#B8860B] via-[#F5C77A] to-[#B8860B] shadow-inner border border-[#8A7018]"></div>
               <div 
                  className="absolute inset-[4%] rounded-full opacity-90 shadow-sm"
                  style={{ background: `repeating-conic-gradient(from 0deg, ${style.colorHex} 0deg 45deg, transparent 45deg 60deg)` }}
               ></div>
               <div className="absolute inset-[4%] rounded-full shadow-[inset_0_2px_4px_rgba(0,0,0,0.4)] pointer-events-none"></div>
               <div className="absolute inset-[24%] rounded-full bg-gradient-to-b from-[#FFFACD] via-[#D4AF37] to-[#B8860B] p-[2px] shadow-[0_1px_3px_rgba(0,0,0,0.6)]">
                   <div className={`w-full h-full rounded-full bg-gradient-to-br ${style.gradient} flex items-center justify-center relative overflow-hidden shadow-inner`}>
                      <div className="absolute top-0 w-full h-[45%] bg-white/15 rounded-t-full border-b border-white/5"></div>
                      <span className={`font-black text-[10px] sm:text-xs ${style.text} drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)] relative z-10 tracking-tight`}>
                        {val}
                      </span>
                   </div>
               </div>
               <div className="absolute inset-0 rounded-full overflow-hidden pointer-events-none">
                  <div className="absolute -top-[50%] -left-[50%] w-[200%] h-[200%] bg-gradient-to-r from-transparent via-white/30 to-transparent rotate-45 animate-shimmer"></div>
               </div>
               <Show when={isSelected}>
                 <div className="absolute -inset-[2px] rounded-full border-[2px] border-[#D4AF37] shadow-[0_0_15px_#D4AF37] animate-pulse pointer-events-none"></div>
               </Show>
             </button>
           );
        })}
      </div>

      {/* MANUAL INPUT */}
      <div className="relative w-full max-w-sm mx-auto mt-4">
          <input 
          type="number" 
          min="1"
          placeholder={`Or type amount (Min ₹${minBet})`}
          value={manualInput}
          onChange={handleInputChange}
          className={`
              w-full h-10 bg-[#121826] border rounded-lg px-4 text-[#EAEAEA] 
              placeholder-gray-600 focus:outline-none focus:ring-1 transition-all text-xs font-bold tracking-wide shadow-inner
              ${currentAmount && manualInput !== '' ? 'border-[#D4AF37] ring-[#D4AF37]' : 'border-[#D4AF37]/30'}
          `}
          />
          <div className="absolute right-4 top-1/2 -translate-y-1/2 text-[#D4AF37] text-[10px] font-bold pointer-events-none">
          {manualInput && currentAmount && currentAmount < minBet ? `Min: ₹${minBet}` : '₹'}
          </div>
      </div>
      
      <Show when={isGhostMode}>
          <div className="text-center mt-2 text-[10px] text-purple-400 animate-pulse">
              GHOST MODE ACTIVE: Select Chip & Click Delhi/Bombay Card
          </div>
      </Show>
    </div>
  );
});

export default BetControls;
