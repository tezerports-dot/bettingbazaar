import React, { useState } from 'react';
import '../design-system/variables.css';
import CommandPalette from '../components/CommandPalette.jsx';
import NotificationCenter from '../components/NotificationCenter.jsx';
import RealtimeStatus from '../components/RealtimeStatus.jsx';
const nav = ['Lobby','Bazaar','Casino','Crash','Sports','Wallet','My Bets','Profile'];
export default function UserPanelShell({ children, active = 'Bazaar', betSlip, chat }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="bb-hw" style={{ minHeight:'100dvh', background:'var(--bb-navy-950)', display:'grid', gridTemplateColumns:'auto minmax(0,1fr) minmax(280px,340px)', overflow:'clip' }}>
    <aside aria-label="Player navigation" style={{ width: menuOpen ? 224 : 72, background:'var(--bb-navy-900)', borderRight:'1px solid var(--bb-border)', padding:12, transition:'width .2s ease', overflow:'hidden' }}>
      <button className="bb-focus" aria-label="Toggle player menu" onClick={() => setMenuOpen(v => !v)} style={iconButton}>☰</button>
      <div style={{ fontWeight:900, color:'var(--bb-accent)', padding:'20px 8px' }}>{menuOpen ? 'BETTING BAZAAR' : 'BB'}</div>
      {nav.map(item => <button className="bb-focus" key={item} style={{ ...navButton, background:item === active ? 'var(--bb-surface-raised)' : 'transparent', color:item === active ? 'var(--bb-accent)' : 'var(--bb-text-muted)' }}>{menuOpen ? item : item.slice(0,1)}</button>)}
    </aside>
    <main style={{ minWidth:0, minHeight:0, overflowY:'auto', padding:'clamp(12px,2vw,28px)', paddingBottom:'max(24px, env(safe-area-inset-bottom))' }}><header style={{display:'flex',gap:8,justifyContent:'flex-end',alignItems:'center',marginBottom:12}}><RealtimeStatus/><CommandPalette panel="player"/><NotificationCenter panel="player"/></header>{children}</main>
    <aside aria-label="Bet slip and live chat" style={{ minHeight:0, overflowY:'auto', padding:16, borderLeft:'1px solid var(--bb-border)', background:'var(--bb-navy-900)' }}>
      <section className="bb-panel" style={{ padding:16, marginBottom:16 }}>{betSlip || <><b>Bet Slip</b><p style={{ color:'var(--bb-text-muted)' }}>Select a market to add a wager.</p></>}</section>
      <section className="bb-panel" style={{ padding:16 }}>{chat || <><b>Live Chat</b><p style={{ color:'var(--bb-text-muted)' }}>Connected market conversation.</p></>}</section>
    </aside>
    <style>{`@media(max-width:900px){.bb-hw{grid-template-columns:minmax(0,1fr)!important}.bb-hw>aside:first-child{display:none}.bb-hw>aside:last-child{display:none}}`}</style>
  </div>;
}
const iconButton={width:44,border:0,borderRadius:8,background:'var(--bb-surface-raised)',color:'var(--bb-text)',cursor:'pointer'};
const navButton={display:'block',width:'100%',border:0,borderRadius:8,padding:'12px 8px',marginBottom:4,textAlign:'left',cursor:'pointer'};
