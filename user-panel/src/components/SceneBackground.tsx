// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * SceneBackground.tsx — Lightweight R3F 3D floating geometry background.
 * pointer-events:none — NEVER intercepts bet clicks.
 * prefers-reduced-motion → static CSS gradient fallback.
 * All listeners cleaned up in useEffect return (zero memory leaks).
 */
import React, { useRef, useMemo, useEffect, useState, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Float, MeshTransmissionMaterial } from '@react-three/drei';
import * as THREE from 'three';

function useReducedMotion(): boolean {
  const [r, setR] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setR(mq.matches);
    const h = (e: MediaQueryListEvent) => setR(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return r;
}

interface GeoInst { position:[number,number,number]; rotation:[number,number,number]; scale:number; speed:number; phase:number; }
function genInsts(n:number):GeoInst[] {
  const r=(a:number,b:number)=>Math.random()*(b-a)+a;
  return Array.from({length:n},()=>({position:[r(-6,6),r(-3.5,3.5),r(-4,-1)] as [number,number,number],rotation:[r(0,Math.PI),r(0,Math.PI),r(0,Math.PI)] as [number,number,number],scale:r(0.18,0.55),speed:r(0.12,0.35),phase:r(0,Math.PI*2)}));
}

function useMouseSpring() {
  const mouse=useRef(new THREE.Vector2(0,0));
  const target=useRef(new THREE.Vector2(0,0));
  useEffect(()=>{
    const h=(e:MouseEvent|TouchEvent)=>{
      const x='touches' in e?e.touches[0].clientX:e.clientX;
      const y='touches' in e?e.touches[0].clientY:e.clientY;
      target.current.set((x/window.innerWidth)*2-1,-(y/window.innerHeight)*2+1);
    };
    window.addEventListener('mousemove',h,{passive:true});
    window.addEventListener('touchmove',h,{passive:true});
    return()=>{window.removeEventListener('mousemove',h);window.removeEventListener('touchmove',h);};
  },[]);
  return useCallback(()=>{mouse.current.lerp(target.current,0.045);return mouse.current;},[]);
}

const GOLD=new THREE.Color('#D4AF37');
const GOLD_E=new THREE.Color('#7A5C00');
type GT='octa'|'ico'|'tetra'|'torus';
const GTS:GT[]=['octa','ico','tetra','torus'];
function GeoMesh({type}:{type:GT}){switch(type){case 'octa':return<octahedronGeometry args={[1,0]}/>;case 'ico':return<icosahedronGeometry args={[1,0]}/>;case 'tetra':return<tetrahedronGeometry args={[1,0]}/>;case 'torus':return<torusGeometry args={[0.7,0.25,8,16]}/>;}}

function FloatingInsts({insts}:{insts:GeoInst[]}){
  const getMouse=useMouseSpring();
  const grp=useRef<THREE.Group>(null);
  const refs=useRef<(THREE.Mesh|null)[]>([]);
  useFrame(({clock})=>{
    const t=clock.getElapsedTime(),m=getMouse();
    insts.forEach((inst,i)=>{
      const mesh=refs.current[i];if(!mesh)return;
      mesh.position.set(inst.position[0]+m.x*(0.15+i*0.008),inst.position[1]+Math.sin(t*inst.speed+inst.phase)*0.3,inst.position[2]);
      mesh.rotation.x+=0.003*inst.speed;mesh.rotation.y+=0.004*inst.speed;
    });
    if(grp.current){grp.current.rotation.y=THREE.MathUtils.lerp(grp.current.rotation.y,m.x*0.06,0.02);grp.current.rotation.x=THREE.MathUtils.lerp(grp.current.rotation.x,-m.y*0.04,0.02);}
  });
  return<group ref={grp}>{insts.map((inst,i)=><Float key={i} speed={inst.speed*1.4} rotationIntensity={0} floatIntensity={0}><mesh ref={el=>{refs.current[i]=el;}} position={inst.position} rotation={inst.rotation} scale={inst.scale}><GeoMesh type={GTS[i%GTS.length]}/><MeshTransmissionMaterial color={GOLD} emissive={GOLD_E} emissiveIntensity={0.12} roughness={0.05} metalness={0.7} transmission={0.45} thickness={0.6} chromaticAberration={0.02} anisotropy={0.15} distortion={0.08} temporalDistortion={0.01} transparent opacity={0.55} side={THREE.DoubleSide}/></mesh></Float>)}</group>;
}

function Dust(){
  const n=80;
  const pos=useMemo(()=>{const a=new Float32Array(n*3);for(let i=0;i<n;i++){a[i*3]=(Math.random()-0.5)*14;a[i*3+1]=(Math.random()-0.5)*8;a[i*3+2]=(Math.random()-0.5)*6-2;}return a;},[]);
  const spd=useMemo(()=>Array.from({length:n},()=>Math.random()*0.15+0.05),[]);
  const pRef=useRef<THREE.Points>(null);
  const pArr=useRef(pos.slice());
  useFrame(()=>{if(!pRef.current)return;const a=pArr.current;for(let i=0;i<n;i++){a[i*3+1]+=spd[i]*0.006;if(a[i*3+1]>4)a[i*3+1]=-4;}(pRef.current.geometry.attributes.position as THREE.BufferAttribute).array.set(a);(pRef.current.geometry.attributes.position as THREE.BufferAttribute).needsUpdate=true;});
  return<points ref={pRef}><bufferGeometry><bufferAttribute attach="attributes-position" array={pos} count={n} itemSize={3}/></bufferGeometry><pointsMaterial color={GOLD} size={0.022} transparent opacity={0.45} sizeAttenuation depthWrite={false}/></points>;
}

function Cam(){const{camera}=useThree();useEffect(()=>{camera.position.set(0,0,5.5);(camera as THREE.PerspectiveCamera).fov=60;camera.updateProjectionMatrix();},[camera]);return null;}

export default function SceneBackground(){
  const reduced=useReducedMotion();
  const insts=useMemo(()=>genInsts(12),[]);
  if(reduced)return<div className="fixed inset-0 -z-10 pointer-events-none" style={{background:'radial-gradient(ellipse 80% 60% at 50% 30%, rgba(212,175,55,0.06) 0%, transparent 70%)'}}/>;
  return(
    <div className="fixed inset-0 -z-10 pointer-events-none" aria-hidden="true" style={{willChange:'transform'}}>
      <Canvas dpr={[1,1.5]} gl={{antialias:false,powerPreference:'default',alpha:true,stencil:false,depth:true}} style={{background:'transparent'}}>
        <Cam/>
        <ambientLight intensity={0.3}/>
        <directionalLight position={[4,6,3]} intensity={0.8} color="#FFF5D0"/>
        <pointLight position={[-3,-2,2]} intensity={0.4} color="#D4AF37"/>
        <FloatingInsts insts={insts}/>
        <Dust/>
      </Canvas>
    </div>
  );
}
