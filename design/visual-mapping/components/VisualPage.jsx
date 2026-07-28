import React, { useState } from 'react';
import { EmptyState, LoadingState, RecoveryState } from './ExperienceStates.jsx';
/** Presentation-only route container with explicit loading, empty, and recovery states. */
export default function VisualPage({ title, eyebrow, children }) {
  const [state, setState] = useState('ready');
  return <section className="bb-panel bb-hw" style={{ padding: 'var(--bb-space-6)', minHeight: 320 }}>
    <header style={{display:'flex',justifyContent:'space-between',gap:12,alignItems:'center'}}><div><p style={{ color: 'var(--bb-accent)', fontSize: 12, fontWeight: 800, letterSpacing: '.12em', margin: 0 }}>{eyebrow}</p><h1 style={{ margin: '8px 0 20px' }}>{title}</h1></div><select className="bb-focus" value={state} onChange={e=>setState(e.target.value)} aria-label="Preview visual state" style={{background:'var(--bb-navy-900)',color:'var(--bb-text)',border:'1px solid var(--bb-border)',borderRadius:8,padding:8}}><option value="ready">Ready</option><option value="loading">Loading</option><option value="empty">Empty</option><option value="error">Error</option></select></header>
    {state==='loading' && <LoadingState/>}
    {state==='empty' && <EmptyState illustration="◌" headline="No activity yet" description="Your first completed action will appear here." action="Explore available actions" onAction={()=>setState('ready')}/>}
    {state==='error' && <RecoveryState onRetry={()=>setState('ready')}/>}
    {state==='ready' && (children || <div aria-live="polite" style={{ color: 'var(--bb-text-muted)' }}>Visual mapping layer ready for API-bound content.</div>)}
  </section>;
}
