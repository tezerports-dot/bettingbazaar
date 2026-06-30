// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React from 'react';
import { useNavigate, useLocation } from 'react-router';

const NAV = [
  { label: 'Game',     path: '/',        icon: '🎲' },
  { label: 'Results',  path: '/results', icon: '📊' },
  { label: 'Winners',  path: '/winners', icon: '🏆' },
  { label: 'Pro Tips', path: '/promo',   icon: '💡' },
  { label: 'Profile',  path: '/profile', icon: '👤' },
];

const Footer: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="flex-none relative z-40" style={{ background:"#0D1120", borderTop:"1px solid rgba(212,175,55,0.18)" }}>
      <div style={{ height:"1px", background:"linear-gradient(90deg,transparent,rgba(212,175,55,0.6) 38.2%,rgba(245,199,122,0.8) 61.8%,transparent)" }} />

      {}
      <button onClick={() => navigate("/chat")}
        className="absolute -top-14 right-4 w-12 h-12 rounded-full flex items-center justify-center active:scale-90 transition-all"
        style={{ background:"linear-gradient(135deg,#1a2235,#121826)", border:"1.5px solid rgba(212,175,55,0.5)", boxShadow:"0 4px 20px rgba(0,0,0,0.5),0 0 12px rgba(212,175,55,0.15)" }}>
        <span className="text-xl leading-none">💬</span>
      </button>

      <footer className="h-[56px] flex items-stretch">
        {NAV.map(item => {
          const isActive = item.path === "/" ? location.pathname === "/" : location.pathname.startsWith(item.path);
          return (
            <button key={item.path} onClick={() => navigate(item.path)}
              className="relative flex flex-col items-center justify-center flex-1 h-full gap-0.5 transition-all"
              style={{ color: isActive ? "#D4AF37" : "#5a6478" }}>
              <span className={"text-[17px] leading-none transition-transform" + (isActive ? " scale-110" : "")}>{item.icon}</span>
              <span className="text-[8px] font-semibold uppercase tracking-wide leading-none">{item.label}</span>
              {isActive && <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-5 h-[2px] rounded-full" style={{ background:"linear-gradient(90deg,#B8860B,#F5C77A,#B8860B)" }} />}
            </button>
          );
        })}
      </footer>
    </div>
  );
};

export default Footer;
