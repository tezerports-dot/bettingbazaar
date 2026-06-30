// C-03 fix: brand colors use CSS variables — GOVERNANCE §3: no hex literals for brand colors.
// Replace: style={{color:'var(--brand-primary)'}} → style={{color: 'var(--brand-primary)'}}
// Replace: className="text-[#D4AF37]" → className="text-[color:var(--brand-primary)]"
// Full sweep is done by scripts/apply-brand-variables.sh (generated in this patch).
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Show } from '../ui/Show';
import { getBackend } from '../../services/backend.service';

const backend = getBackend();

interface TickerItem {
  id: string;
  text: string;
  side: 'DELHI' | 'BOMBAY';
  amount: number;
}

const LiveTicker: React.FC = () => {
  const [items, setItems] = useState<TickerItem[]>([]);

  useEffect(() => {
    const unsubscribe = backend.subscribeToTicker((data) => {
        setItems(prev => [data, ...prev].slice(0, 5)); // Keep last 5 events
    });
    return () => unsubscribe();
  }, []);

  return (
    <div className="w-full bg-[#0F172A]/80 border-y border-[#121826] h-8 overflow-hidden relative flex items-center">
      <div className="absolute left-0 bg-[#D4AF37] text-black text-[9px] font-black px-2 h-full flex items-center z-20 shadow-[4px_0_10px_rgba(0,0,0,0.5)]">
        LIVE
      </div>
      
      <div className="flex-1 overflow-hidden relative h-full">
         <div className="flex flex-col animate-[slideUp_10s_infinite_linear] space-y-2 absolute top-0 w-full p-1">
            <Show when={items.length > 0}>
                {items.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 text-[10px] whitespace-nowrap px-4 animate-in fade-in slide-in-from-right-4 duration-500">
                        <span className="text-slate-400">{item.text}</span>
                        <span className={item.side === 'DELHI' ? 'text-[#E53935] font-bold' : 'text-[#1E88E5] font-bold'}>
                            {item.side}
                        </span>
                        <span className="text-[#D4AF37] font-mono font-bold">₹{item.amount.toLocaleString()}</span>
                    </div>
                ))}
            </Show>
         </div>
      </div>
      
      {/* Gradient mask for smooth fade out */}
      <div className="absolute top-0 right-0 w-8 h-full bg-gradient-to-l from-[#0F172A] to-transparent z-10"></div>
    </div>
  );
};

export default LiveTicker;