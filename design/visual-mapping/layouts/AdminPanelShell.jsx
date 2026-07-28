import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import '../design-system/variables.css';
import CommandPalette from '../components/CommandPalette.jsx';
import NotificationCenter from '../components/NotificationCenter.jsx';
import RealtimeStatus from '../components/RealtimeStatus.jsx';
const adminNav=[['Overview','/admin'],['Players','/admin/users'],['Payments','/admin/payment-control'],['Cycles','/admin/live-cycles'],['Merchants','/admin/merchants'],['Content','/admin/content/faq'],['Configuration','/admin/settings'],['Audit','/admin/audit-logs']];
export default function AdminPanelShell({ children, title = 'Operations', actions }) {
  const [mobileNavOpen,setMobileNavOpen]=useState(false);
  const navLinks=<nav aria-label="Administrative navigation" style={{ display:'grid', gap:4, marginTop:32 }}>{adminNav.map(([label,path])=><Link className="bb-focus" key={label} to={path} style={sideButton}>{label}</Link>)}</nav>;
  return <div style={{ minHeight:'100dvh', display:'grid', gridTemplateColumns:'264px minmax(0,1fr)', background:'var(--bb-navy-950)' }}>
    <aside aria-label="Administrative sidebar" style={{ padding:16, background:'var(--bb-navy-900)', borderRight:'1px solid var(--bb-border)' }}><b style={{ color:'var(--bb-accent)' }}>BETTING BAZAAR<br/>ADMIN</b>{navLinks}</aside>
    <main style={{ minWidth:0, overflow:'auto', padding:'clamp(16px,2vw,32px)' }}><header style={{ display:'flex', gap:16, alignItems:'center', justifyContent:'space-between', marginBottom:20 }}><div><small style={{ color:'var(--bb-text-muted)' }}>HIGH-DENSITY WORKSPACE</small><h1 style={{ margin:'4px 0' }}>{title}</h1></div><div style={{display:'flex',gap:8,alignItems:'center'}}><button className="bb-focus admin-mobile-nav-button" onClick={()=>setMobileNavOpen(v=>!v)} aria-expanded={mobileNavOpen}>Menu</button><RealtimeStatus/><CommandPalette panel="admin"/><NotificationCenter panel="admin"/>{actions}</div></header>{mobileNavOpen&&<div className="admin-mobile-nav">{navLinks}</div>}{children}</main>
    <style>{`.admin-mobile-nav-button,.admin-mobile-nav{display:none}@media(max-width:760px){div[style*="264px"]{grid-template-columns:1fr!important}div[style*="264px"]>aside{display:none}.admin-mobile-nav-button{display:inline-flex}.admin-mobile-nav{display:block;margin-bottom:16px}}`}</style>
  </div>;
}
const sideButton={border:0,borderRadius:8,padding:'12px',textAlign:'left',background:'transparent',color:'var(--bb-text-muted)',cursor:'pointer',textDecoration:'none'};
