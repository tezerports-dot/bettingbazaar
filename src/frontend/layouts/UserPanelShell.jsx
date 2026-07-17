import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import '../design-system/variables.css';
import CommandPalette from '../components/CommandPalette.jsx';
import NotificationCenter from '../components/NotificationCenter.jsx';
import RealtimeStatus from '../components/RealtimeStatus.jsx';
const nav = [
  { label:'Lobby', path:'/' }, { label:'Bazaar', path:'/' }, { label:'Casino', path:'/casino' }, { label:'Crash', path:'/crash' },
  { label:'Sports', path:'/sports' }, { label:'Wallet', path:'/wallet' }, { label:'My Bets', path:'/my-bets' }, { label:'Profile', path:'/profile' },
];
export default function UserPanelShell({ children, active = 'Bazaar', activeKey, betSlip, chat }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const activeLabel = active || activeKey;
  return <div className="bb-hw" style={{ minHeight:'100dvh', background:'var(--bb-navy-950)', display:'grid', gridTemplateColumns:'auto minmax(0,1fr) minmax(280px,340px)', overflow:'clip' }}>
    <button className="bb-focus user-mobile-menu" aria-label="Open player navigation" onClick={() => setMenuOpen(v => !v)} style={iconButton}>☰</button>
    <aside aria-label="Player navigation" style={{ width: menuOpen ? 224 : 72, background:'var(--bb-navy-900)', borderRight:'1px solid var(--bb-border)', padding:12, transition:'width .2s ease', overflow:'hidden' }}>
      <button className="bb-focus" aria-label="Toggle player menu" onClick={() => setMenuOpen(v => !v)} style={iconButton}>☰</button>
      <div style={{ fontWeight:900, color:'var(--bb-accent)', padding:'20px 8px' }}>{menuOpen ? 'BETTING BAZAAR' : 'BB'}</div>
      {nav.map((item, index) => <Link className="bb-focus" key={item.label} to={item.path} aria-label={item.label} title={item.label} style={{ ...navButton, textDecoration:'none', background:item.label === activeLabel ? 'var(--bb-surface-raised)' : 'transparent', color:item.label === activeLabel ? 'var(--bb-accent)' : 'var(--bb-text-muted)' }}>{menuOpen ? item.label : `${index + 1}`}</Link>)}
    </aside>
    <main style={{ minWidth:0, minHeight:0, overflowY:'auto', padding:'clamp(12px,2vw,28px)', paddingBottom:'max(24px, env(safe-area-inset-bottom))' }}><header style={{display:'flex',gap:8,justifyContent:'flex-end',alignItems:'center',marginBottom:12}}><RealtimeStatus/><CommandPalette panel="player"/><NotificationCenter panel="player"/></header>{menuOpen && <nav className="user-mobile-nav" aria-label="Player mobile navigation">{nav.map(item => <Link key={item.label} to={item.path}>{item.label}</Link>)}</nav>}{children}</main>
    <aside aria-label="Bet slip and live chat" style={{ minHeight:0, overflowY:'auto', padding:16, borderLeft:'1px solid var(--bb-border)', background:'var(--bb-navy-900)' }}>
      <section className="bb-panel" style={{ padding:16, marginBottom:16 }}>{betSlip || <><b>Bet Slip</b><p style={{ color:'var(--bb-text-muted)' }}>Select a market to add a wager.</p></>}</section>
      <section className="bb-panel" style={{ padding:16 }}>{chat || <><b>Live Chat</b><p style={{ color:'var(--bb-text-muted)' }}>Connected market conversation.</p></>}</section>
    </aside>
    <style>{`.user-mobile-menu,.user-mobile-nav{display:none}@media(max-width:900px){.bb-hw{grid-template-columns:minmax(0,1fr)!important}.bb-hw>aside:first-of-type{display:none}.bb-hw>aside:last-child{display:none}.user-mobile-menu{display:block;position:fixed;z-index:20;left:12px;bottom:12px}.user-mobile-nav{display:grid;gap:6px;margin-bottom:12px;padding:12px;border:1px solid var(--bb-border);border-radius:12px;background:var(--bb-navy-900)}.user-mobile-nav a{color:var(--bb-text);text-decoration:none;padding:10px;border-radius:8px;background:var(--bb-surface-raised)}}`}</style>
  </div>;
}
const iconButton={width:44,border:0,borderRadius:8,background:'var(--bb-surface-raised)',color:'var(--bb-text)',cursor:'pointer'};
const navButton={display:'block',width:'100%',border:0,borderRadius:8,padding:'12px 8px',marginBottom:4,textAlign:'left',cursor:'pointer'};
