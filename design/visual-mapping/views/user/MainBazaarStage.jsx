import React, { useMemo, useState } from 'react';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

const seedLedger = Array.from({ length: 1000 }, (_, index) => ({ id: `market-${index}`, player: `Player ${1000 + index}`, side: index % 2 ? 'DELHI BAZAAR' : 'BOMBAY BAZAAR', amount: 50 + (index % 24) * 25, at: `${index % 60}s ago` }));
function VirtualMarketLedger({ rows = seedLedger, rowHeight = 48, height = 336 }) {
  const [scrollTop, setScrollTop] = useState(0);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 3);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + 3);
  return <div aria-label="Global live market action" role="log" onScroll={e => setScrollTop(e.currentTarget.scrollTop)} style={{ height, overflowY:'auto', border:'1px solid var(--bb-border)', borderRadius:12, background:'var(--bb-navy-900)' }}>
    <div style={{ height: rows.length * rowHeight, position:'relative' }}>{rows.slice(start,end).map((row,i) => <div key={row.id} style={{ position:'absolute', top:(start+i)*rowHeight, left:0, right:0, height:rowHeight, display:'grid', gridTemplateColumns:'1fr auto auto', alignItems:'center', gap:12, padding:'0 16px', borderBottom:'1px solid var(--bb-border)', contain:'content' }}><span>{row.player}</span><b style={{ color:row.side.startsWith('DELHI') ? 'var(--bb-blue)' : 'var(--bb-gold)' }}>{row.side}</b><span style={{ fontVariantNumeric:'tabular-nums' }}>₹{row.amount} · {row.at}</span></div>)}</div>
  </div>;
}
function MarketSide({ name, color, odds, volume }) { return <article className="bb-panel bb-hw" style={{ padding:'clamp(16px,3vw,32px)', borderColor:color, textAlign:'center' }}><small style={{ color }}>LIVE MARKET</small><h2 style={{ fontSize:'clamp(22px,4vw,44px)', margin:'10px 0' }}>{name}</h2><strong style={{ fontSize:32, fontVariantNumeric:'tabular-nums' }}>{odds.toFixed(2)}×</strong><p style={{ color:'var(--bb-text-muted)' }}>Pool volume ₹{volume.toLocaleString('en-IN')}</p></article> }
export default function MainBazaarStage() {
  const [side,setSide]=useState('DELHI BAZAAR'); const [amount,setAmount]=useState(100);
  const ledger=useMemo(()=>seedLedger,[]);
  const stakeAmount = Number(amount);
  const isValidStake = Number.isFinite(stakeAmount) && stakeAmount > 0;
  const previewOnlyTitle = 'Preview only: live bet submission is not wired in this visual map.';
  const betSlip=<><b>Selected market</b><p style={{ color:'var(--bb-accent)' }}>{side}</p><p>Stake: ₹{isValidStake ? stakeAmount.toLocaleString('en-IN') : '—'}</p><button className="bb-focus" type="button" disabled title={previewOnlyTitle} aria-disabled="true" style={{...placeButton,...disabledButton}}>PREVIEW ONLY</button></>;
  return <UserPanelShell active="Bazaar" betSlip={betSlip}><section style={{ display:'grid', gap:20 }}>
    <header><small style={{ color:'var(--bb-text-muted)' }}>LIVE • NEXT RESULT IN 00:12:48</small><h1 style={{ margin:'6px 0' }}>DELHI BAZAAR <span style={{ color:'var(--bb-accent)', textShadow:'0 0 22px var(--bb-accent)' }}>VS</span> BOMBAY BAZAAR</h1></header>
    <section aria-label="Head to head market" style={{ display:'grid', gridTemplateColumns:'minmax(0,1fr) auto minmax(0,1fr)', gap:16, alignItems:'center' }}><MarketSide name="DELHI BAZAAR" color="var(--bb-blue)" odds={1.92} volume={124500}/><div aria-hidden="true" style={{ width:72,height:72,borderRadius:'50%',display:'grid',placeItems:'center',background:'var(--bb-accent)',color:'var(--bb-accent-ink)',fontWeight:1000,fontSize:24,boxShadow:'0 0 32px rgba(0,231,1,.55)' }}>VS</div><MarketSide name="BOMBAY BAZAAR" color="var(--bb-gold)" odds={2.08} volume={131200}/></section>
    <section className="bb-panel" style={{ padding:20 }}><h2 style={{ marginTop:0 }}>Build your bet</h2><div style={{ display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:12 }}><button className="bb-focus" aria-pressed={side==='DELHI BAZAAR'} onClick={()=>setSide('DELHI BAZAAR')} style={{...marketButton, borderColor:side==='DELHI BAZAAR'?'var(--bb-blue)':'var(--bb-border)'}}>DELHI BAZAAR</button><button className="bb-focus" aria-pressed={side==='BOMBAY BAZAAR'} onClick={()=>setSide('BOMBAY BAZAAR')} style={{...marketButton,borderColor:side==='BOMBAY BAZAAR'?'var(--bb-gold)':'var(--bb-border)'}}>BOMBAY BAZAAR</button></div><label style={{ display:'block',marginTop:16 }}>Stake <input className="bb-focus" value={amount} type="number" min="1" onChange={e=>setAmount(e.target.value)} style={amountInput}/></label><div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginTop:12}}>{[['Min',10],['2×',amount*2],['Max',100000],['1/2',Math.max(1,amount/2)]].map(([label,value])=><button className="bb-focus" key={label} onClick={()=>setAmount(Math.round(value))} style={presetButton}>{label}</button>)}</div><button className="bb-focus bb-hw" type="button" disabled={!isValidStake || true} title={previewOnlyTitle} aria-disabled="true" style={{...placeButton,...disabledButton,width:'100%',marginTop:16}}>PREVIEW ONLY · ₹{isValidStake ? stakeAmount.toLocaleString('en-IN') : '—'}</button></section>
    <section><div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><h2>Global market action</h2><span style={{color:'var(--bb-success)'}}>● LIVE</span></div><VirtualMarketLedger rows={ledger}/></section>
  </section><style>{`@media(max-width:650px){section[aria-label="Head to head market"]{grid-template-columns:1fr!important}section[aria-label="Head to head market"]>div[aria-hidden="true"]{justify-self:center}}`}</style></UserPanelShell>;
}
const marketButton={minHeight:64,background:'var(--bb-navy-900)',color:'var(--bb-text)',border:'2px solid',borderRadius:12,fontWeight:800,cursor:'pointer'};
const amountInput={display:'block',width:'100%',marginTop:8,padding:14,borderRadius:10,border:'1px solid var(--bb-border)',background:'var(--bb-navy-900)',color:'var(--bb-text)',fontSize:20};
const presetButton={border:'1px solid var(--bb-border)',borderRadius:8,background:'var(--bb-surface-raised)',color:'var(--bb-text)',cursor:'pointer'};
const placeButton={border:0,borderRadius:12,background:'var(--bb-accent)',color:'var(--bb-accent-ink)',fontWeight:1000,letterSpacing:'.06em',cursor:'pointer',boxShadow:'0 10px 28px rgba(0,231,1,.25)'};

const disabledButton={opacity:.6,cursor:'not-allowed'};
