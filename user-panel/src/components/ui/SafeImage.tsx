// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * SafeImage.tsx — Resilient image with instant SVG fallback.
 * Zero blank boxes. Zero broken-image icons. Works on every device.
 * Usage: <SafeImage src={url} alt="name" className="w-10 h-10 rounded-full" />
 * Convenience wrappers: <UserAvatar>, <AppLogo>, <CardThumbnail>
 */
import React, { useState, useCallback, useId } from 'react';

function getInitials(t:string):string{if(!t)return'?';const w=t.trim().split(/\s+/);return w.length===1?w[0].slice(0,2).toUpperCase():(w[0][0]+w[w.length-1][0]).toUpperCase();}
function hashColor(s:string):string{const P=['#7C3AED','#B45309','#065F46','#1D4ED8','#9D174D','#0F766E','#A16207','#7E22CE'];let h=0;for(let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i);h|=0;}return P[Math.abs(h)%P.length];}

function AvatarSVG({text,size=40,className='',style}:{text:string;size?:number;className?:string;style?:React.CSSProperties}){
  const id=useId();const bg=hashColor(text);const init=getInitials(text);
  return<svg width={size} height={size} viewBox="0 0 40 40" className={className} style={style} aria-label={text} role="img"><defs><radialGradient id={`g-${id}`} cx="35%" cy="25%" r="75%"><stop offset="0%" stopColor={bg} stopOpacity="0.9"/><stop offset="100%" stopColor={bg} stopOpacity="1"/></radialGradient></defs><rect width="40" height="40" fill={`url(#g-${id})`} rx="20"/><text x="20" y="20" textAnchor="middle" dominantBaseline="central" fill="rgba(255,255,255,0.95)" fontSize={init.length>1?'14':'18'} fontWeight="600" fontFamily="system-ui,sans-serif">{init}</text></svg>;
}

function LogoSVG({text,className,style}:{text:string;className?:string;style?:React.CSSProperties}){
  return<svg viewBox="0 0 120 36" className={className} style={style} aria-label={text} role="img"><defs><linearGradient id="lg" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#D4AF37"/><stop offset="100%" stopColor="#F5C77A"/></linearGradient></defs><text x="60" y="22" textAnchor="middle" dominantBaseline="central" fill="url(#lg)" fontSize="18" fontWeight="700" fontFamily="system-ui,sans-serif" letterSpacing="1">{text}</text></svg>;
}

function CardSVG({text,className,style}:{text:string;className?:string;style?:React.CSSProperties}){
  const id=useId();
  return<svg viewBox="0 0 320 180" className={className} style={style} aria-label={`${text} unavailable`} role="img"><defs><linearGradient id={`cg-${id}`} x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#1a1f2e"/><stop offset="100%" stopColor="#0d1117"/></linearGradient></defs><rect width="320" height="180" fill={`url(#cg-${id})`} rx="8"/><rect x="1" y="1" width="318" height="178" fill="none" stroke="rgba(212,175,55,0.2)" strokeWidth="1" rx="8"/><circle cx="160" cy="80" r="30" fill="none" stroke="rgba(212,175,55,0.12)" strokeWidth="1"/><text x="160" y="145" textAnchor="middle" fill="rgba(212,175,55,0.5)" fontSize="11" fontFamily="system-ui,sans-serif">{text||'Image unavailable'}</text></svg>;
}

export type SafeImageVariant='avatar'|'logo'|'card'|'auto';
interface SafeImageProps extends React.ImgHTMLAttributes<HTMLImageElement>{src?:string|null;alt:string;fallbackText?:string;variant?:SafeImageVariant;fallbackSize?:number;}

const SafeImage:React.FC<SafeImageProps>=({src,alt,fallbackText,variant='auto',fallbackSize=40,className='',style,...rest})=>{
  const [failed,setFailed]=useState(!src||src.trim()==='');
  const prev=React.useRef(src);
  if(src!==prev.current){prev.current=src;if(src&&src.trim()!=='')Promise.resolve().then(()=>setFailed(false));}
  const onErr=useCallback(()=>setFailed(true),[]);
  const txt=fallbackText||alt||'?';
  const v:Exclude<SafeImageVariant,'auto'>=variant!=='auto'?variant:className.includes('rounded-full')||fallbackSize<=56?'avatar':className.includes('logo')?'logo':'card';
  if(failed){switch(v){case 'avatar':return<AvatarSVG text={txt} size={fallbackSize} className={className} style={style}/>;case 'logo':return<LogoSVG text={txt} className={className} style={style}/>;default:return<CardSVG text={txt} className={className} style={style}/>;}}
  return<img src={src||undefined} alt={alt} className={className} style={style} onError={onErr} loading="lazy" decoding="async" {...rest}/>;
};
export default SafeImage;

export function UserAvatar({src,name,size=40,className=''}:{src?:string|null;name:string;size?:number;className?:string}){return<SafeImage src={src} alt={name} fallbackText={name} variant="avatar" fallbackSize={size} className={className} style={{width:size,height:size}}/>;}
export function AppLogo({src,appName,className=''}:{src?:string|null;appName:string;className?:string}){return<SafeImage src={src} alt={`${appName} logo`} fallbackText={appName} variant="logo" className={className}/>;}
export function CardThumbnail({src,title,className=''}:{src?:string|null;title:string;className?:string}){return<SafeImage src={src} alt={title} fallbackText={title} variant="card" className={className}/>;}
