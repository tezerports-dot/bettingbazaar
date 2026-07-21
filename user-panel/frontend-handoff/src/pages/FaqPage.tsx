// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * FaqPage.tsx  v4.3.0 — NEW PAGE
 * BUG-U9 / CROSS-1 FIX: Admin-written FAQs now displayed in the user panel.
 * Grouped by category, accordion style, fetched from GET /v1/content/faq.
 */
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBackend } from '../services/backend.service';

const backend = getBackend();

interface FAQ {
  id:       string;
  question: string;
  answer:   string;
  category: string;
}

const FaqPage: React.FC = () => {
  const navigate       = useNavigate();
  const [faqs, setFaqs]         = useState<FAQ[]>([]);
  const [loading, setLoading]   = useState(true);
  const [openId, setOpenId]     = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('All');

  useEffect(() => {
    (backend as any).getFaq?.()
      .then((data: FAQ[]) => setFaqs(data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const categories = ['All', ...Array.from(new Set(faqs.map(f => f.category)))];
  const filtered   = activeCategory === 'All' ? faqs : faqs.filter(f => f.category === activeCategory);

  // Static fallback FAQs shown while loading or if none configured
  const fallbackFaqs: FAQ[] = [
    { id: 'f1', category: 'General',    question: 'What is BettingBazaar?',                       answer: 'BettingBazaar is a Payment token trading platform with cycle-based gameplay. You buy tokens, bet on Delhi or Bombay in each cycle, and earn winnings from the pool.' },
    { id: 'f2', category: 'General',    question: 'How does a cycle work?',                        answer: 'Each cycle has OPEN, MERGED (betting closed), and RESULT phases. When closed, the side with more pool wins. Payouts are proportional to your bet in the winning pool.' },
    { id: 'f3', category: 'Deposits',   question: 'How do I deposit tokens?',                      answer: 'Open the Wallet, tap "Buy Tokens", enter the amount, and a merchant will be assigned. Pay to the merchant via UPI/NEFT and mark "I Have Paid". After verification, tokens are credited.' },
    { id: 'f4', category: 'Deposits',   question: 'How long does deposit take?',                   answer: 'Usually under 30 minutes once payment is marked. If delayed beyond 2 hours, raise a dispute in the chat.' },
    { id: 'f5', category: 'Withdrawals', question: 'How do I withdraw winnings?',                  answer: 'KYC must be approved and bank details added. Tap "Sell Tokens" in the Wallet and a merchant will process the transfer.' },
    { id: 'f6', category: 'KYC',        question: 'Why is KYC required?',                          answer: 'KYC (Aadhaar verification) is required to unlock withdrawals and comply with regulations. Your data is encrypted.' },
    { id: 'f7', category: 'KYC',        question: 'How long does KYC approval take?',              answer: 'Usually within 24 hours. You will see the status update on your Profile page.' },
    { id: 'f8', category: 'Gameplay',   question: 'What is the minimum and maximum bet?',          answer: 'Minimum bet is ₹10 for 30-minute cycles and ₹100 for full-day cycles. Maximum bet is set by the admin.' },
    { id: 'f9', category: 'Gameplay',   question: 'Can I cancel a bet after placing it?',          answer: 'No. Bets are final once placed. They are locked until the cycle result is declared.' },
    { id: 'f10', category: 'Disputes',  question: 'My deposit is stuck. What do I do?',            answer: 'Open the Wallet, find the order in Recent Activity, tap Chat, and raise a dispute. Admin will review within a few hours.' },
  ];

  const displayFaqs = loading ? [] : (filtered.length > 0 ? filtered : fallbackFaqs);

  return (
    <div className="h-full flex flex-col bg-[#0B0E14]">

      <div className="flex-1 overflow-y-auto pb-4">
        {/* Category filter tabs */}
        {!loading && faqs.length > 0 && (
          <div className="px-4 pt-4 flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
            {categories.map(cat => (
              <button key={cat} onClick={() => setActiveCategory(cat)}
                className={`flex-shrink-0 px-4 py-2 rounded-full text-xs font-black uppercase tracking-wide transition-all
                  ${activeCategory === cat ? 'bg-[#D4AF37] text-black' : 'bg-[#1A1F2E] text-slate-400 border border-white/10'}`}>
                {cat}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center py-16 gap-4">
            <div className="w-10 h-10 border-4 border-[#D4AF37]/20 border-t-[#D4AF37] rounded-full animate-spin" />
            <p className="text-slate-500 text-xs">Loading FAQs…</p>
          </div>
        ) : (
          <div className="p-4 space-y-2">
            {displayFaqs.map(faq => (
              <div key={faq.id}
                className={`bg-[#121826] rounded-2xl border transition-all overflow-hidden
                  ${openId === faq.id ? 'border-[#D4AF37]/30' : 'border-white/5'}`}>
                <button
                  className="w-full text-left p-5 flex justify-between items-start gap-3"
                  onClick={() => setOpenId(openId === faq.id ? null : faq.id)}
                >
                  <span className="text-sm font-bold text-slate-200 leading-snug">{faq.question}</span>
                  <span className={`text-[#D4AF37] text-lg flex-shrink-0 transition-transform duration-200 ${openId === faq.id ? 'rotate-180' : ''}`}>
                    ▾
                  </span>
                </button>
                {openId === faq.id && (
                  <div className="px-5 pb-5 text-sm text-slate-400 leading-relaxed border-t border-white/5 pt-3">
                    {faq.answer}
                  </div>
                )}
              </div>
            ))}

            <div className="text-center pt-6 pb-2">
              <p className="text-slate-500 text-xs">Still have questions?</p>
              <button
                onClick={() => navigate('/support')}
                className="mt-2 text-[#D4AF37] font-bold text-sm"
              >
                Contact Support →
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
};

export default FaqPage;
