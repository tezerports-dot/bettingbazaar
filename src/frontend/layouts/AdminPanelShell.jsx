import React from 'react';
import '../design-system/variables.css';
export default function AdminPanelShell({ children, title = 'Operations', actions }) {
  return <div style={{ minHeight:'100dvh', display:'grid', gridTemplateColumns:'264px minmax(0,1fr)', background:'var(--bb-navy-950)' }}>
    <aside aria-label="Administrative navigation" style={{ padding:16, background:'var(--bb-navy-900)', borderRight:'1px solid var(--bb-border)' }}><b style={{ color:'var(--bb-accent)' }}>BETTING BAZAAR<br/>ADMIN</b><nav style={{ display:'grid', gap:4, marginTop:32 }}>{['Overview','Players','Payments','Cycles','Merchants','Content','Configuration','Audit'].map(x=><button className="bb-focus" key={x} style={sideButton}>{x}</button>)}</nav></aside>
    <main style={{ minWidth:0, overflow:'auto', padding:'clamp(16px,2vw,32px)' }}><header style={{ display:'flex', gap:16, alignItems:'center', justifyContent:'space-between', marginBottom:20 }}><div><small style={{ color:'var(--bb-text-muted)' }}>HIGH-DENSITY WORKSPACE</small><h1 style={{ margin:'4px 0' }}>{title}</h1></div>{actions}</header>{children}</main>
    <style>{`@media(max-width:760px){div[style*="264px"]{grid-template-columns:1fr!important}div[style*="264px"]>aside{display:none}}`}</style>
  </div>;
}
const sideButton={border:0,borderRadius:8,padding:'12px',textAlign:'left',background:'transparent',color:'var(--bb-text-muted)',cursor:'pointer'};
