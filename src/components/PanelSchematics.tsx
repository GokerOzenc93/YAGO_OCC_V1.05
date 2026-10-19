import React, { useRef, useState, useEffect, useMemo } from 'react';
import { Lock, Pin, Unlock } from 'lucide-react';
import * as THREE from 'three';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { round1, localBboxOf, axisDirToVec, largestFaceNormal, isFlatNormal, clipPolyToConvex, polyArea } from './Geometry';
import { UI_FONT } from './Ui';
import {
  type DoorType, type BackPlacement, type Shape, type CavityBox, type PanelGroup, type DoorAlign, type DoorGroup, type BackGroup, type BackEdgeRel,
} from '../store';
import {
  passiveGapIndex, memberThicknessesOf, groupFacing, panelStarts, traceMaskLoops, boxSpan, gapMode, type EdgeKey, type SolvedNode, treeLeaves,
  type SplitOf, findParent,
} from './PanelGroupService';
import {
  type DoorNodeSolved, type DoorCut, type DoorNearPanel, type DoorEdgeKey, type EdgeOverlayMode, edgeGapsOf, solveDoorTree, applyDoorCuts,
  doorMemberRects, doorCutBands, findSolvedNode, doorJoints, type DoorJoint, JOINT_NEAR, jointOverlayState, canSplitDoorAtPanel, doorCutOutline,
  passiveSizeIndex, doorSizeMode, doorLeafAxis, DOOR_TYPE_LABEL, doorJointParts,
} from './DoorService';
import {
  type BackNodeSolved, type BackSolution, type BackCut, type BackNearPanel, type BackEdgeKey, findBackNode, backPieceOf, backLeaves,
  findSolvedBackNode, edgeRelOf, backCutBands, canSplitBackAtPanel, backJointRelOf, backCutOutline, backSizeBoundByJoint, passiveBackSizeIndex,
  backSizeMode, backGrooveClearOverridden, backGrooveClearOf, BACK_REL_LABEL, BACK_TYPE_LABEL,
} from './BackService';

/* PANEL ŞEMALARI — 1) şema kiti · 2) panel önizlemesi + raf / dikme şeması · 3) kapak / arkalık ortak çekirdeği ·
   4) kapak şeması · 5) arkalık şeması. Panel editörü (PanelEditor.tsx) bunları kullanır. */

// ════════════════════════════════════════════════════ 1. ŞEMA KİTİ ════════════════════════════════════════════════════
/* ŞEMA KİTİ — şema görsel dili (pill / kilit / rozet), şema kancaları, tip ikonları ve kapak açılım çizimi.
   Kapak, arkalık ve raf/dikme şemaları ile panel listesi aynı parçaları kullanır. */

export const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export type Pt = { x: number; y: number };
/** Ondalık giriş: virgül de kabul edilir. */
export const parseNum = (s: string) => parseFloat(s.replace(',', '.'));
export const fmt1 = (v: number) => String(round1(v));

/* ───────────── ŞEMA GÖRSEL DİLİ ───────────── */

/* Önizleme yazı ölçeği (Goker: "bir tık büyük, okunaklı") — kapak / arkalık / raf-dikme şemaları ve panel önizlemesi aynı ölçek. */
export const schemFs = (w: number) => Math.max(10.5, Math.min(14, w * 0.0285));
export const schemFsT = (fs: number) => Math.max(9.5, fs * 0.88);
/** Bant rozetleri (Full / Half / Split here / Groove / In …). */
export const chipFs = (fsT: number) => fsT * 0.86;
/* ŞEMA ROZET DİLİ (Goker: kapak rozetleri arkalık gibi): beyaz = seçenek; koyu taş = AÇIK/seçili durum; turuncu çerçeve = bu tık
   seçili parçayı / bölmeyi değiştirir; kırmızı = kaldır. */
export const CHIP = {
  base: { fill: '#ffffff', stroke: '#cfc6b9', text: '#57534e' },
  on: { fill: '#44403c', stroke: '#292524', text: '#ffffff' },
  accent: { fill: '#fff7ed', stroke: '#f97316', text: '#c2410c' },
  danger: { fill: '#fef2f2', stroke: '#ef4444', text: '#b91c1c' },
} as const;
export type ChipTone = { fill: string; stroke: string; text: string };
export const CHIP_SHADOW = 'drop-shadow(0 1px 1px rgba(40,30,20,0.12))';
export const pillSize = (txt: string, fs: number) => ({ pw: Math.max(txt.length * fs * 0.6 + 10, 26), ph: fs + 6 });
export const DIM_LINE = '#b8b0a4';
export const DIM_EXT = '#ddd6ca';
export const SOFT = {
  area: '#fdfcfa', areaStroke: '#e4ded4',
  part0: '#f5f0e8', part1: '#eae3d7', partStroke: '#b8afa2',
  sel0: '#f8f0e6', sel1: '#f0e3d1', selStroke: '#dcae84',
  on0: '#fdeee1', on1: '#f9dcc4', onStroke: '#ea580c',
  label: '#a39b90', shadow: 'drop-shadow(0 1px 1.5px rgba(70,50,30,0.09))',
  pillStroke: '#ece6dc', pillShadow: 'drop-shadow(0 1px 1px rgba(60,40,20,0.06))',
};
export const PREVIEW_BG = 'radial-gradient(130% 95% at 50% 0%, #fefdfb 0%, #f8f5f0 62%, #f3efe8 100%)';
export const PREVIEW_FRAME =
  'relative rounded-[12px] ring-1 ring-[#ebe5dc] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_1px_2px_rgba(60,40,20,0.04)]';
export const PREVIEW_HEIGHT = 500;
export const SCHEMATIC_CSS = [
  '.yago-gap .lockbtn{transition:transform .12s;transform-box:fill-box;transform-origin:center}.yago-gap .lockbtn:hover{transform:scale(1.12)}',
  '.yago-band .chip{opacity:0;transition:opacity .15s}.yago-band.on .chip,.yago-band:hover .chip{opacity:1}',
  '.yago-band .hit{transition:fill .12s}.yago-band:hover .hit{fill:rgba(234,88,12,0.10)}.yago-band.pnl:hover .hit{fill:transparent}',
  '.yago-band .hov{opacity:0;transition:opacity .12s;pointer-events:none}.yago-band:hover .hov{opacity:1}',
  '@keyframes yagoHintPulse{0%,100%{opacity:1}50%{opacity:.45}}.yago-hint-pulse{animation:yagoHintPulse 1.1s ease-in-out infinite}',
].join('');

export function DimArrows({ a, b, asz, color }: { a: Pt; b: Pt; asz: number; color: string }) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, px = -uy, py = ux;
  const k = 0.42, f = (n: number) => n.toFixed(1);
  const head = (x: number, y: number, sx: number, sy: number) =>
    `M${f(x + sx * asz + px * asz * k)},${f(y + sy * asz + py * asz * k)} L${f(x)},${f(y)} L${f(x + sx * asz - px * asz * k)},${f(y + sy * asz - py * asz * k)}`;
  return (
    <>
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={0.8} />
      <path d={`${head(a.x, a.y, ux, uy)} ${head(b.x, b.y, -ux, -uy)}`} fill="none" stroke={color} strokeWidth={0.9}
        strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}
export function DimPill({ cx, cy, txt, fs, fill = '#ffffff', stroke = SOFT.pillStroke, strokeWidth = 0.7, color = '#57534e', hideText, onClick, title }: {
  cx: number; cy: number; txt: string; fs: number; fill?: string; stroke?: string; strokeWidth?: number; color?: string;
  hideText?: boolean; onClick?: (e: React.MouseEvent) => void; title?: string;
}) {
  const { pw, ph } = pillSize(txt, fs);
  return (
    <>
      <rect x={cx - pw / 2} y={cy - ph / 2} width={pw} height={ph} rx={ph / 2} fill={fill} stroke={stroke} strokeWidth={strokeWidth}
        style={{ filter: SOFT.pillShadow, ...(onClick ? { cursor: 'text' } : {}) }} onClick={onClick}>{title && <title>{title}</title>}</rect>
      {!hideText && (
        <text x={cx} y={cy + fs * 0.36} textAnchor="middle" fontSize={fs} fontWeight={500} fill={color} fontFamily={UI_FONT}
          style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>{txt}</text>
      )}
    </>
  );
}
/** Pasif ölçü (diğerleri pinli/kilitli, kalanı toplar): girilemez, rozetsiz. */
export const PassivePill = (p: { cx: number; cy: number; txt: string; fs: number; title: string }) => (
  <DimPill {...p} fill="#f5f3ef" stroke="#d6cfc3" strokeWidth={0.9} color="#a8a29e" hideText={false} />
);
export const LOCK_R = 9;
/* Kilit rozeti pill'in ucuna 2px biner → hangi ölçüye ait olduğu belli olur. */
export const LOCK_OFF = LOCK_R - 2;
export const LOCK_EXT = LOCK_OFF + LOCK_R + 2;
/** `holdIcon`: ölçünün 'tut' modu — girilmiş değer raptiye ikonuyla gösterilir. */
export function LockBadge({ cx, cy, locked, edited, onClick, title, holdIcon }: {
  cx: number; cy: number; locked: boolean; edited?: boolean; onClick: () => void; title?: string; holdIcon?: boolean;
}) {
  const fill = locked ? '#ea580c' : edited ? '#fff7ed' : '#ffffff';
  const stroke = locked ? '#c2410c' : edited ? '#f59e0b' : '#d6cfc3';
  const ico = locked ? '#ffffff' : edited ? '#9a3412' : '#8c8378';
  const sz = 10, at = { x: cx - sz / 2, y: cy - sz / 2, size: sz, color: ico };
  return (
    <g className="lockbtn" style={{ cursor: 'pointer' }} onClick={e => { e.stopPropagation(); onClick(); }}>
      <circle cx={cx} cy={cy} r={LOCK_R} fill={fill} stroke={stroke} strokeWidth={locked ? 1 : 0.9} style={{ filter: SOFT.pillShadow }} />
      {locked ? <Lock {...at} strokeWidth={2.4} /> : edited && holdIcon ? <Pin {...at} strokeWidth={2.3} /> : <Unlock {...at} strokeWidth={2.1} />}
      <title>{title ?? (locked ? 'Locked — stays fixed on resize. Click to unlock (follows resize)'
        : edited ? 'Entered value — click to lock it (stays fixed on resize)' : 'Click to lock (stays fixed on resize)')}</title>
    </g>
  );
}
/** Şema rozeti (CHIP tonlarıyla). `rot` verilirse (derece) rozet kendi merkezinde döner. */
export function Chip({ cx, cy, txt, fs, tone, rot, className }: {
  cx: number; cy: number; txt: string; fs: number; tone: ChipTone; rot?: number | string; className?: string;
}) {
  const { pw, ph } = pillSize(txt, fs);
  return (
    <g className={className} transform={rot ? `rotate(${rot} ${cx} ${cy})` : undefined}>
      <rect x={cx - pw / 2} y={cy - ph / 2} width={pw} height={ph} rx={ph / 2} fill={tone.fill} stroke={tone.stroke} strokeWidth={0.9}
        style={{ filter: CHIP_SHADOW }} />
      <text x={cx} y={cy + fs * 0.36} textAnchor="middle" fontSize={fs} fontWeight={700} letterSpacing="0.02em" fill={tone.text}
        fontFamily={UI_FONT}>{txt}</text>
    </g>
  );
}
/** Dikey gradyan (üst → alt). */
export const VGrad = ({ id, from, to }: { id: string; from: string; to: string }) => (
  <linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={from} /><stop offset="1" stopColor={to} /></linearGradient>
);
/** Parça gradyanları — her SVG kendi id'siyle bir kez tanımlar (aynı sayfada id çakışmasın). */
export function SoftDefs({ id }: { id: string }) {
  return (
    <defs>
      <VGrad id={`${id}-part`} from={SOFT.part0} to={SOFT.part1} />
      <VGrad id={`${id}-on`} from={SOFT.on0} to={SOFT.on1} />
    </defs>
  );
}
/** SVG id'si için grup id'sinden güvenli önek. */
export const svgId = (prefix: string, id: string) => `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;

/* ───────────── ŞEMA KANCALARI ───────────── */

/** Kabın genişliği (ResizeObserver). */
export function useElementWidth(initial = 300) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(es => { const w = es[0].contentRect.width; if (w > 0) setWidth(Math.round(w)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
/** Şema değer düzenleme oturumu: başta kayıt alınır (onBegin), Esc kaydı geri yükler (onCancel) ve sonraki blur onayını iptal eder. */
export function useEditSession<E>(onBegin?: () => unknown, onCancel?: (snap: unknown) => void) {
  const [editing, setEditing] = useState<E | null>(null);
  const snapRef = useRef<unknown>(undefined);
  const cancelledRef = useRef(false);
  return {
    editing, setEditing,
    begin: (e: E) => { snapRef.current = onBegin?.(); cancelledRef.current = false; setEditing(e); },
    cancel: () => { cancelledRef.current = true; onCancel?.(snapRef.current); setEditing(null); },
    /** Esc sonrası gelen blur mu? (true → onay yapılmaz) */
    wasCancelled: () => { if (!cancelledRef.current) return false; cancelledRef.current = false; return true; },
    /** Geçersiz giriş: canlı önizleme kayda geri alınır. */
    revert: () => onCancel?.(snapRef.current),
  };
}
/** Pill'in üzerinde açılan değer kutusu: Enter / blur onaylar, Esc iptal eder. */
export function PillEditInput({ at, fs, value, onChange, onCommit, onCancel }: {
  at: { cx: number; cy: number; pw: number; ph: number }; fs: number; value: string;
  onChange: (v: string) => void; onCommit: () => void; onCancel: () => void;
}) {
  return (
    <input autoFocus type="text" inputMode="decimal" value={value}
      onChange={e => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={e => { if (e.key === 'Enter') onCommit(); if (e.key === 'Escape') onCancel(); }}
      onClick={stop}
      style={{
        position: 'absolute', left: at.cx - at.pw / 2 - 4, top: at.cy - at.ph / 2 - 2, width: at.pw + 8, height: at.ph + 4, textAlign: 'center',
        fontFamily: UI_FONT, fontSize: fs, fontWeight: 600, color: '#1c1917', fontVariantNumeric: 'tabular-nums',
        background: '#fff', border: '1px solid #f97316', borderRadius: 99, outline: 'none', boxShadow: '0 0 0 2px rgba(249,115,22,0.12)', padding: 0,
      }} />
  );
}

/* AÇILIŞ İŞARETİ (DIN/AWI görünüş sözleşmesi): kulp kenarının iki köşesinden menteşe kenarının ORTASINA kesikli çizgi —
   sivri uç menteşe tarafıdır. Fold'da iki kanadın ucu da üstte. Şema ve tip ikonları aynı çizimi kullanır. */
export type Hinge = 'L' | 'R' | 'T' | 'B';
const vPath = (...v: number[]) => { const s = v.map(n => n.toFixed(1)); return `M${s[0]},${s[1]} L${s[2]},${s[3]} L${s[4]},${s[5]}`; };
export const swingPath = (x0: number, y0: number, x1: number, y1: number, h: Hinge) => {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return h === 'L' ? vPath(x1, y0, x0, cy, x1, y1) : h === 'R' ? vPath(x0, y0, x1, cy, x0, y1)
    : h === 'T' ? vPath(x0, y1, cx, y0, x1, y1) : vPath(x0, y0, cx, y1, x1, y0);
};
const HINGE_DIR: Record<Hinge, Pt> = { L: { x: -1, y: 0 }, R: { x: 1, y: 0 }, T: { x: 0, y: -1 }, B: { x: 0, y: 1 } };
const HINGE_OPP: Record<Hinge, Hinge> = { L: 'R', R: 'L', T: 'B', B: 'T' };
/** Çokgen kapakta açılış işareti: menteşe kenarı = dış normali menteşe yönüne en çok bakan kenar; kulp kenarı = karşısı. */
export const swingPathPoly = (pts: Pt[], h: Hinge, ins: number): string | null => {
  if (pts.length < 3) return null;
  const c = { x: pts.reduce((a, q) => a + q.x, 0) / pts.length, y: pts.reduce((a, q) => a + q.y, 0) / pts.length };
  const edges = pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
    if (nx * ((a.x + b.x) / 2 - c.x) + ny * ((a.y + b.y) / 2 - c.y) < 0) { nx = -nx; ny = -ny; }
    return { a, b, len, nx, ny };
  });
  const pick = (k: Hinge) => {
    const d = HINGE_DIR[k];
    const sc = edges.map(e => ({ e, dot: e.nx * d.x + e.ny * d.y })).filter(x => x.dot > 0.5);
    if (!sc.length) return null;
    const top = Math.max(...sc.map(x => x.dot));
    return sc.filter(x => x.dot > top - 0.15).sort((p, q) => q.e.len - p.e.len)[0].e;
  };
  const he = pick(h), pe = pick(HINGE_OPP[h]);
  if (!he || !pe) return null;
  const inward = (q: Pt) => {
    const dx = c.x - q.x, dy = c.y - q.y, L = Math.hypot(dx, dy) || 1;
    return { x: q.x + dx / L * ins * 1.4, y: q.y + dy / L * ins * 1.4 };
  };
  const p0 = inward(pe.a), p1 = inward(pe.b);
  return vPath(p0.x, p0.y, (he.a.x + he.b.x) / 2 - he.nx * ins, (he.a.y + he.b.y) / 2 - he.ny * ins, p1.x, p1.y);
};
/** Kanat sırası: double sol→sağ (bakan kişiye göre), fold üst→alt. */
const LEAF_HINGES: Partial<Record<DoorType, Hinge[]>> = { left: ['L'], right: ['R'], up: ['T'], down: ['B'], double: ['L', 'R'], fold: ['T', 'T'] };
export const leafHinges = (t: DoorType): Hinge[] => LEAF_HINGES[t] ?? [];

export type Kids = { children: React.ReactNode };
type TypeIconProps = { size?: number; strokeWidth?: number };
/** Tip ikonlarının ortak 20×16 çerçevesi. */
const TypeSvg = ({ size, strokeWidth, children }: Kids & { size: number; strokeWidth: number }) => (
  <svg width={size * 20 / 16} height={size} viewBox="0 0 20 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round"
    strokeLinecap="round" style={{ flexShrink: 0, display: 'block' }} aria-hidden>{children}</svg>
);
export function DoorTypeIcon({ type, size = 14, strokeWidth = 1.25 }: TypeIconProps & { type: DoorType }) {
  const W = 20, H = 16, p = 1, g = 1.2, hinges = leafHinges(type);
  const leaves: Array<[number, number, number, number]> =
    type === 'double' ? [[p, p, W / 2 - g / 2, H - p], [W / 2 + g / 2, p, W - p, H - p]]
      : type === 'fold' ? [[p, p, W - p, H / 2 - g / 2], [p, H / 2 + g / 2, W - p, H - p]]
        : [[p, p, W - p, H - p]];
  return (
    <TypeSvg size={size} strokeWidth={strokeWidth}>
      {leaves.map(([x0, y0, x1, y1], i) => (
        <g key={i}>
          <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx={0.6} />
          {hinges[i] && <path d={swingPath(x0 + 1.6, y0 + 1.6, x1 - 1.6, y1 - 1.6, hinges[i])} strokeDasharray="1.8 1.3" strokeWidth={strokeWidth * 0.85} />}
        </g>
      ))}
      {type === 'drawer' && <line x1={W / 2 - 3.5} y1={H / 2 - 1.5} x2={W / 2 + 3.5} y2={H / 2 - 1.5} strokeWidth={strokeWidth * 1.5} />}
      {type === 'fixed' && [[4, 4], [W - 4, 4], [4, H - 4], [W - 4, H - 4]]
        .map(([x, y], i) => <circle key={i} cx={x} cy={y} r={0.9} fill="currentColor" stroke="none" />)}
    </TypeSvg>
  );
}

/* ARKALIK TİPİ İKONU — plan kesiti: iki yan panel (düşey çubuklar) + arkalık. Çakma: panellerin arkasında, dışta;
   kanallı: panellerin arasında, iki yana da kanal kadar girer. */
export function BackTypeIcon({ type, size = 14, strokeWidth = 1.25 }: TypeIconProps & { type: BackPlacement }) {
  const outer = type === 'outer';
  return (
    <TypeSvg size={size} strokeWidth={strokeWidth}>
      {[2.5, 14.5].map(x => <rect key={x} x={x} y={1.5} width={3} height={outer ? 9.5 : 13} rx={0.6} />)}
      <rect {...(outer ? { x: 2.5, y: 12, width: 15 } : { x: 4, y: 9.5, width: 12 })} height={2.5} rx={0.6} fill="currentColor" fillOpacity={0.18} />
    </TypeSvg>
  );
}

// ══════════════════════════════════════ 2. PANEL ÖNİZLEMESİ + RAF / DİKME ŞEMASI ══════════════════════════════════════
/* PANEL ÖNİZLEMESİ (2B ölçülü görünüş) ve RAF / DİKME ŞEMASI. */

export function geoAxes(geo: THREE.BufferGeometry) {
  const bbox = localBboxOf(geo); if (!bbox) return null;
  const size = new THREE.Vector3(); bbox.getSize(size);
  const axes = [{ i: 0, v: size.x }, { i: 1, v: size.y }, { i: 2, v: size.z }].sort((a, b) => a.v - b.v);
  return { axes, size, bbox };
}

/* PANEL ÇERÇEVESİ: önizleme ve ölçüler gövde-yerel geometriden okunursa dönmüş panelde eğik bbox
   yanlış ölçü ve sahte "kesim" verir. Dönüş adımlarının birleşik dönüşü (PanelEngine.composeSteps ile
   AYNI sıra) tersine uygulanır; adımsız eğik levhada en büyük yüz normali en yakın eksene çevrilir. */
const _frameCache = new WeakMap<THREE.BufferGeometry, { key: string; geo: THREE.BufferGeometry; inv: THREE.Quaternion }>();
const rotDeg = (st: any): number => (typeof st.resolvedValue === 'number' ? st.resolvedValue : st.value);
function stepsFrameQuat(steps: any[] | undefined): THREE.Quaternion {
  const frame = new THREE.Quaternion();
  for (const st of steps || []) {
    if (st?.type !== 'rotate') continue;
    const deg = rotDeg(st) || 0;
    if (Math.abs(deg) < 1e-9) continue;
    const axis = Array.isArray(st.axisVec)
      ? new THREE.Vector3(st.axisVec[0], st.axisVec[1], st.axisVec[2]).normalize()
      : axisDirToVec(String(st.axis || 'y') + '+');
    const worldAxis = axis.applyQuaternion(frame).normalize();
    frame.premultiply(new THREE.Quaternion().setFromAxisAngle(worldAxis, (deg * Math.PI) / 180));
  }
  return frame;
}
/** Panelin kendi çerçevesindeki geometrisi (dönüşsüz panelde geometrinin kendisi) + uygulanan ters dönüş. */
export function panelFrameOf(shape: Shape | undefined | null): { geo: THREE.BufferGeometry; inv: THREE.Quaternion } | null {
  const geo = shape?.geometry as THREE.BufferGeometry | undefined; if (!geo) return null;
  const steps: any[] = shape?.parameters?.transformSteps || [];
  const vecKey = (s: any) => (Array.isArray(s.axisVec) ? s.axisVec.map((v: number) => v.toFixed(3)).join('/') : '');
  const key = steps.filter(s => s?.type === 'rotate').map(s => `${s.axis}${vecKey(s)}:${rotDeg(s)}`).join('|');
  const hit = _frameCache.get(geo); if (hit && hit.key === key) return { geo: hit.geo, inv: hit.inv };
  const inv = stepsFrameQuat(steps).invert();
  let out = geo;
  if (Math.abs(inv.w) < 0.9999999) { out = geo.clone(); out.applyQuaternion(inv); }
  const n = largestFaceNormal(out, 1e-6);
  if (n && !isFlatNormal(n, 0.9999)) {
    const ax = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)]; const i = ax.indexOf(Math.max(...ax));
    const target = new THREE.Vector3().setComponent(i, Math.sign(n.getComponent(i)) || 1);
    const q2 = new THREE.Quaternion().setFromUnitVectors(n.clone().normalize(), target);
    if (out === geo) out = geo.clone();
    out.applyQuaternion(q2); inv.premultiply(q2);
  }
  if (out !== geo) { out.computeBoundingBox(); out.computeBoundingSphere(); }
  _frameCache.set(geo, { key, geo: out, inv });
  return { geo: out, inv };
}

/** Liste satırı ölçüleri: en / boy (ok yönüne göre) + kalınlık (parametreden; dönmüş panelde bbox'ın en küçüğü gerçek kalınlık değildir). */
export const panelDims = (p: Shape | undefined | null) => {
  const geo = panelFrameOf(p)?.geo; if (!geo) return null;
  const r = geoAxes(geo); if (!r) return null;
  const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
  const target = p!.parameters?.arrowRotated ? pa[1] : pa[0], secondary = pa.find(a => a !== target) ?? pa[0], s = [r.size.x, r.size.y, r.size.z];
  const pt = parseFloat(p!.parameters?.panelThickness) || 18;
  return { primary: round1(s[target]), secondary: round1(s[secondary]), thickness: pt > 0 ? round1(pt) : round1(s[r.axes[0].i]) };
};

interface GroundDimWorld { fa: THREE.Vector3; fb: THREE.Vector3; da: THREE.Vector3; db: THREE.Vector3; length: number; along?: number; }
/* Panelin tam enini/boyunu kaplayan "kesim" (pah kenarı, tam boy kanal) dış ölçünün kopyasıdır → atılır. */
const CUT_FULL_SPAN = 0.9;
const KEYS = ['x', 'y', 'z'] as const;
type CutFrame = { p0: number; p1: number; thin: number; topVal: number; lo0: number; hi0: number; lo1: number; hi1: number; gap: number; span0: number; span1: number };
/** Panel yüzü çerçevesi: düzlem eksenleri, üst yüz değeri, kenarlar ve ölçü aralığı. */
function cutFrame(thin: number, box: THREE.Box3, size: THREE.Vector3, nDir: THREE.Vector3): CutFrame {
  const [p0, p1] = [0, 1, 2].filter(i => i !== thin), k0 = KEYS[p0], k1 = KEYS[p1], tk = KEYS[thin];
  const span0 = size.getComponent(p0), span1 = size.getComponent(p1);
  return {
    p0, p1, thin, topVal: nDir.getComponent(thin) > 0 ? box.max[tk] : box.min[tk],
    lo0: box.min[k0], hi0: box.max[k0], lo1: box.min[k1], hi1: box.max[k1], gap: Math.min(span0, span1) * 0.045, span0, span1,
  };
}
/** Kesim kutusunun iki ölçüsü (yakın kenar tarafında); tam boy olanlar atılır. */
function cutBoxDims(mn0: number, mx0: number, mn1: number, mx1: number, c: CutFrame): GroundDimWorld[] {
  const mk = (v0: number, v1: number) => new THREE.Vector3().setComponent(c.p0, v0).setComponent(c.p1, v1).setComponent(c.thin, c.topVal);
  const w0 = mx0 - mn0, w1 = mx1 - mn1;
  const dims: GroundDimWorld[] = [];
  // Ölçü kesimin panel kenarına yakın tarafına, kenardan `gap` dışarı çizilir.
  const side = (mn: number, mx: number, lo: number, hi: number) => ((mn - lo) <= (hi - mx) ? [mn, mn - c.gap] : [mx, mx + c.gap]);
  if (w0 > 0.5) {
    const [e, o] = side(mn1, mx1, c.lo1, c.hi1);
    dims.push({ fa: mk(mn0, e), fb: mk(mx0, e), da: mk(mn0, o), db: mk(mx0, o), length: Math.round(w0), along: c.p0 });
  }
  if (w1 > 0.5) {
    const [e, o] = side(mn0, mx0, c.lo0, c.hi0);
    dims.push({ fa: mk(e, mn1), fb: mk(e, mx1), da: mk(o, mn1), db: mk(o, mx1), length: Math.round(w1), along: c.p1 });
  }
  return dims.filter(d => d.length < CUT_FULL_SPAN * (d.along === c.p0 ? c.span0 : c.span1));
}
const subXform = (sg: any) => {
  const rot = sg.relativeRotation || [0, 0, 0];
  return {
    rotM: new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ')),
    off: new THREE.Vector3(...((sg.relativeOffset || [0, 0, 0]) as number[])),
  };
};
/** Çıkarma geometrilerinin (subtraction) panel yüzündeki ölçüleri. */
function cutDimsFromSubGeos(subGeos: any[], box: THREE.Box3, size: THREE.Vector3, thin: number, nDir: THREE.Vector3, frame?: THREE.Matrix4): GroundDimWorld[] {
  const c = cutFrame(thin, box, size, nDir);
  const out: GroundDimWorld[] = [];
  const v = new THREE.Vector3();
  subGeos.forEach(sg => {
    const pos = sg?.geometry?.getAttribute('position'); if (!pos) return;
    const { rotM, off } = subXform(sg);
    let mn0 = Infinity, mx0 = -Infinity, mn1 = Infinity, mx1 = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(rotM).add(off);
      if (frame) v.applyMatrix4(frame);
      const c0 = v.getComponent(c.p0), c1 = v.getComponent(c.p1);
      mn0 = Math.min(mn0, c0); mx0 = Math.max(mx0, c0); mn1 = Math.min(mn1, c1); mx1 = Math.max(mx1, c1);
    }
    out.push(...cutBoxDims(Math.max(mn0, c.lo0), Math.min(mx0, c.hi0), Math.max(mn1, c.lo1), Math.min(mx1, c.hi1), c));
  });
  return out;
}
/** Çıkarma geometrisi yoksa: üst yüzdeki iç kenar kümeleri (cep / kanal) kesim sayılır. */
function computeCutDimsWorld(geometry: THREE.BufferGeometry, thin: number, nDir: THREE.Vector3): GroundDimWorld[] {
  const eg = new THREE.EdgesGeometry(geometry, 15);
  const pos = eg.getAttribute('position');
  if (!pos) { eg.dispose(); return []; }
  const bbox = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const size = bbox.getSize(new THREE.Vector3());
  const tk = KEYS[thin];
  const c = cutFrame(thin, bbox, size, nDir);
  const { p0, p1, topVal, span0, span1 } = c;
  const minSpan = Math.min(span0, span1);
  const tolT = Math.max((bbox.max[tk] - bbox.min[tk]) * 0.15, 0.6);
  const tolE = Math.max(minSpan * 0.01, 0.4), minLen = Math.max(minSpan * 0.03, 4);
  const onLine = (av: number, bv: number, val: number) => Math.abs(av - val) < tolE && Math.abs(bv - val) < tolE;

  type Seg = { a0: number; a1: number; b0: number; b1: number };
  const segs: Seg[] = [];
  const comp = [0, 0, 0];
  const read = (i: number) => { comp[0] = pos.getX(i); comp[1] = pos.getY(i); comp[2] = pos.getZ(i); return [comp[thin], comp[p0], comp[p1]]; };
  for (let i = 0; i < pos.count; i += 2) {
    const [aThin, a0, a1] = read(i), [bThin, b0, b1] = read(i + 1);
    if (Math.abs(aThin - topVal) > tolT || Math.abs(bThin - topVal) > tolT) continue;
    if (onLine(a0, b0, c.lo0) || onLine(a0, b0, c.hi0) || onLine(a1, b1, c.lo1) || onLine(a1, b1, c.hi1)) continue;
    if (Math.hypot(b0 - a0, b1 - a1) < minLen) continue;
    segs.push({ a0, a1, b0, b1 });
  }
  eg.dispose();
  if (!segs.length) return [];

  // Uç noktası ortak segmentler birleşim-bul ile kümelenir.
  const qstep = Math.max(tolE * 2, 0.8);
  const q = (val: number) => Math.round(val / qstep);
  const parent = segs.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const ptMap = new Map<string, number>();
  segs.forEach((s, i) => {
    [[s.a0, s.a1], [s.b0, s.b1]].forEach(([x, y]) => {
      const kk = q(x) + ',' + q(y);
      if (ptMap.has(kk)) { const ra = find(i), rb = find(ptMap.get(kk)!); if (ra !== rb) parent[ra] = rb; } else ptMap.set(kk, i);
    });
  });
  const clusters = new Map<number, Seg[]>();
  segs.forEach((s, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r)!.push(s); });

  const out: GroundDimWorld[] = [];
  let count = 0;
  clusters.forEach(arr => {
    if (count > 16) return;
    let mn0 = Infinity, mx0 = -Infinity, mn1 = Infinity, mx1 = -Infinity;
    arr.forEach(s => { mn0 = Math.min(mn0, s.a0, s.b0); mx0 = Math.max(mx0, s.a0, s.b0); mn1 = Math.min(mn1, s.a1, s.b1); mx1 = Math.max(mx1, s.a1, s.b1); });
    if ((mx0 - mn0) <= span0 * 0.02 && (mx1 - mn1) <= span1 * 0.02) return;
    // Yüzün tamamını kaplayan kenar kümesi (pah / eğik yüz dış hattı) kesim değildir.
    if ((mx0 - mn0) >= span0 * CUT_FULL_SPAN && (mx1 - mn1) >= span1 * CUT_FULL_SPAN) return;
    const dd = cutBoxDims(mn0, mx0, mn1, mx1, c);
    out.push(...dd); count += dd.length;
  });
  return out;
}
/** Dış ölçüler: en ve boy, zemine (kameraya göre alt) yakın yüzde, kutunun dışında. */
function computeGroundDimWorld(geometry: THREE.BufferGeometry, wIdx: number, hIdx: number, thin: number, up: THREE.Vector3): GroundDimWorld[] {
  const bbox = localBboxOf(geometry); if (!bbox) return [];
  const size = bbox.getSize(new THREE.Vector3()), cen = bbox.getCenter(new THREE.Vector3());
  const wKey = KEYS[wIdx], hKey = KEYS[hIdx], tk = KEYS[thin];
  const cMax = cen.clone().setComponent(thin, bbox.max[tk]);
  const cMin = cen.clone().setComponent(thin, bbox.min[tk]);
  const groundVal = cMin.dot(up) <= cMax.dot(up) ? bbox.min[tk] : bbox.max[tk];
  const wExt = size.getComponent(wIdx), hExt = size.getComponent(hIdx);
  const gOff = Math.max(wExt, hExt) * 0.12;
  const mk = (wv: number, hv: number) => new THREE.Vector3().setComponent(wIdx, wv).setComponent(hIdx, hv).setComponent(thin, groundVal);
  const he = bbox.max[hKey], we = bbox.max[wKey], w0 = bbox.min[wKey], w1 = bbox.max[wKey], h0 = bbox.min[hKey], h1 = bbox.max[hKey];
  return [
    { fa: mk(w0, he), fb: mk(w1, he), da: mk(w0, he + gOff), db: mk(w1, he + gOff), length: Math.round(wExt) },
    { fa: mk(we, h0), fb: mk(we, h1), da: mk(we + gOff, h0), db: mk(we + gOff, h1), length: Math.round(hExt) },
  ];
}

interface GroundRender { fa: Pt; fb: Pt; da: Pt; db: Pt; cx: number; cy: number; value: number; }
const PREVIEW_PANEL_COLOR = 0xeee7dc;
const PREVIEW_EDGE_COLOR = 0xa1988b;
const PREVIEW_LIGHT = { hemi: 1.0, ambient: 0.3, key: 1.9, fill: 0.55 };
const dimFs = (w: number) => Math.max(10.5, Math.min(13.5, w * 0.027));
const arrowSize = (w: number) => Math.max(4, Math.min(6.5, w * 0.014));

/* TEK WebGL BAĞLAMI: tarayıcı ~16 bağlamı aşınca EN ESKİSİNİ (ana sahne Canvas'ı) öldürür. Tüm önizlemeler
   tek ekran-dışı renderer'ı paylaşır; görüntü görünür canvas'a 2D drawImage ile kopyalanır. */
let _sharedPreviewRenderer: THREE.WebGLRenderer | null = null;
function getSharedPreviewRenderer(): THREE.WebGLRenderer | null {
  const cur = _sharedPreviewRenderer;
  if (cur && !cur.getContext().isContextLost()) return cur;
  if (cur) { try { cur.dispose(); } catch { /* yok say */ } _sharedPreviewRenderer = null; }
  try {
    const r = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setClearColor(0x000000, 0);
    _sharedPreviewRenderer = r;
    return r;
  } catch (e) {
    console.error('[YAGO][ÖNİZLEME] önizleme renderer oluşturulamadı:', e);
    return null;
  }
}
function fatLines(geometry: THREE.BufferGeometry, color: number, linewidth: number, w: number, h: number, disposables: Array<{ dispose: () => void }>) {
  const edgesGeo = new THREE.EdgesGeometry(geometry, 18);
  const lineGeo = new LineSegmentsGeometry().fromEdgesGeometry(edgesGeo);
  const mat = new LineMaterial({ color, linewidth, worldUnits: false, alphaToCoverage: true });
  mat.resolution.set(w, h);
  disposables.push(edgesGeo, lineGeo, mat);
  const lines = new LineSegments2(lineGeo, mat);
  lines.computeLineDistances();
  return lines;
}

export function PanelPreview2D({ shape, arrowRotated }: { shape: Shape; arrowRotated?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [ground, setGround] = useState<GroundRender[]>([]);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const [az, setAz] = useState(22);
  const shapeRef = useRef(shape); shapeRef.current = shape;
  const arrowRotatedRef = useRef(arrowRotated); arrowRotatedRef.current = arrowRotated;
  const azRef = useRef(az); azRef.current = az;
  const dragRef = useRef<{ x: number; az: number } | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return;
    let raf = 0, tries = 0;
    const apply = (w: number, h: number) => { if (w > 0 && h > 0) { setCanvasSize({ w: Math.round(w), h: Math.round(h) }); return true; } return false; };
    const measure = () => { if (!apply(wrap.clientWidth, wrap.clientHeight) && ++tries < 20) raf = requestAnimationFrame(measure); };
    raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(es => { const { width, height } = es[0].contentRect; apply(width, height); });
    ro.observe(wrap);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const shape = shapeRef.current, arrowRotated = arrowRotatedRef.current;
    const { w, h } = canvasSize;
    if (!canvas || !shape?.geometry || w <= 0 || h <= 0) return;
    const renderer = getSharedPreviewRenderer();
    if (!renderer) return;
    const frame = panelFrameOf(shape)!;
    const frameGeo = frame.geo;
    const frameM = new THREE.Matrix4().makeRotationFromQuaternion(frame.inv);
    const unrotated = Math.abs(frame.inv.w) > 0.9999999;

    const dpr = window.devicePixelRatio;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);

    const disposables: Array<{ dispose: () => void }> = [];
    const scene = new THREE.Scene();
    const material = new THREE.MeshStandardMaterial({ color: PREVIEW_PANEL_COLOR, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide });
    // Klon: paylaşılan renderer GPU tamponlarını tutar; klon çizimden sonra dispose edilir, sahne geometrisine dokunulmaz.
    const previewGeo = frameGeo.clone();
    disposables.push(material, previewGeo);
    scene.add(new THREE.Mesh(previewGeo, material));
    scene.add(fatLines(frameGeo, PREVIEW_EDGE_COLOR, 0.9, w, h, disposables));

    const bbox = new THREE.Box3().setFromObject(scene);
    const sz = bbox.getSize(new THREE.Vector3()), center = bbox.getCenter(new THREE.Vector3());
    const dims3 = [sz.x, sz.y, sz.z];
    const minIdx = dims3.indexOf(Math.min(...dims3));

    // En/yükseklik düzlem EKSENLERİNE bağlı (panelDims ile aynı) → extrude sonrası önizleme kendiliğinden dönmez.
    const planar = [0, 1, 2].filter(i => i !== minIdx).sort((a, b) => a - b);
    const [wIdx, hIdx] = arrowRotated ? [planar[1], planar[0]] : planar;
    const wDir = new THREE.Vector3().setComponent(wIdx, 1);
    const hDir = new THREE.Vector3().setComponent(hIdx, 1);
    const nDir = new THREE.Vector3().crossVectors(wDir, hDir).normalize();

    const elev = THREE.MathUtils.degToRad(15), azim = THREE.MathUtils.degToRad(azRef.current);
    const camOffset = new THREE.Vector3()
      .addScaledVector(nDir, Math.cos(elev) * Math.cos(azim))
      .addScaledVector(wDir, Math.cos(elev) * Math.sin(azim))
      .addScaledVector(hDir, Math.sin(elev)).normalize();

    // three r155+ fiziksel ışık ölçeği: düşük şiddetler paneli kirli griye çeker.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d1c4, PREVIEW_LIGHT.hemi));
    scene.add(new THREE.AmbientLight(0xffffff, PREVIEW_LIGHT.ambient));
    const light = (color: number, k: number, n: number, hh: number, ww: number) => {
      const l = new THREE.DirectionalLight(color, k);
      l.position.copy(nDir).multiplyScalar(n).addScaledVector(hDir, hh).addScaledVector(wDir, ww);
      return l;
    };
    scene.add(light(0xffffff, PREVIEW_LIGHT.key, 3, 2, 1.4), light(0xf4f1ec, PREVIEW_LIGHT.fill, 1, -1.6, -2.2), light(0xffffff, 0.15, -1, 1, 0.6));

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -40000, 40000);
    camera.position.copy(center).addScaledVector(camOffset, 4000);
    camera.up.copy(hDir);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const upW = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);

    const subGeos: any[] = Array.isArray(shape.subtractionGeometries) ? shape.subtractionGeometries : [];
    const allDimsW = [
      ...computeGroundDimWorld(frameGeo, wIdx, hIdx, minIdx, upW),
      ...(subGeos.length ? cutDimsFromSubGeos(subGeos, bbox, sz, minIdx, nDir, unrotated ? undefined : frameM) : computeCutDimsWorld(frameGeo, minIdx, nDir)),
    ];

    // Kamera kutusu: tüm köşeler + ölçü uçları sığsın; altta pill için pay.
    const allW: THREE.Vector3[] = [];
    for (const X of [bbox.min.x, bbox.max.x]) for (const Y of [bbox.min.y, bbox.max.y]) for (const Z of [bbox.min.z, bbox.max.z]) allW.push(new THREE.Vector3(X, Y, Z));
    allDimsW.forEach(d => allW.push(d.fa, d.fb, d.da, d.db));
    let maxU = 0, maxV = 0;
    allW.forEach(p => { const d = p.clone().sub(center); maxU = Math.max(maxU, Math.abs(d.dot(right))); maxV = Math.max(maxV, Math.abs(d.dot(upW))); });
    const halfV = maxV * 1.06;
    const ratioTop = halfV, ratioBot = halfV + halfV * 0.06;
    let vSpan = ratioTop + ratioBot, halfH = (vSpan / 2) * (w / h);
    const needH = maxU * 1.06;
    if (halfH < needH) { vSpan *= needH / halfH; halfH = needH; }
    camera.left = -halfH; camera.right = halfH;
    camera.top = vSpan * ratioTop / (ratioTop + ratioBot); camera.bottom = -vSpan * ratioBot / (ratioTop + ratioBot);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    subGeos.forEach((sg: any) => {
      if (!sg?.geometry) return;
      const { rotM, off } = subXform(sg);
      const sgLines = fatLines(sg.geometry, 0xd97706, 1.2, w, h, disposables);
      sgLines.matrix.copy(rotM); sgLines.matrix.setPosition(off);
      if (!unrotated) sgLines.matrix.premultiply(frameM);
      sgLines.matrixAutoUpdate = false;
      scene.add(sgLines);
    });

    renderer.render(scene, camera);
    // 2D bağlam WebGL bağlam sınırına sayılmaz.
    const ctx2d = canvas.getContext('2d');
    if (ctx2d) { ctx2d.clearRect(0, 0, canvas.width, canvas.height); ctx2d.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height); }
    renderer.renderLists.dispose();

    // Ölçü pill'leri: çakışan pill ölçü yönünde dışa itilir.
    const fsG = dimFs(w);
    const proj = (p: THREE.Vector3): Pt => { const ndc = p.clone().project(camera); return { x: (ndc.x + 1) / 2 * w, y: (1 - ndc.y) / 2 * h }; };
    const items = allDimsW.map(d => {
      const fa = proj(d.fa), fb = proj(d.fb), da = proj(d.da), db = proj(d.db);
      const ox = da.x - fa.x, oy = da.y - fa.y, l = Math.hypot(ox, oy) || 1;
      const { pw, ph } = pillSize(String(d.length), fsG);
      return { fa, fb, da, db, length: d.length, out: { x: ox / l, y: oy / l }, cx: (da.x + db.x) / 2, cy: (da.y + db.y) / 2, hw: pw / 2, hh: ph / 2 };
    });
    const placed: Array<{ cx: number; cy: number; hw: number; hh: number }> = [];
    const hits = (cx: number, cy: number, hw: number, hh: number) => placed.some(pp => Math.abs(pp.cx - cx) < pp.hw + hw + 4 && Math.abs(pp.cy - cy) < pp.hh + hh + 4);
    setGround(items.map(it => {
      let push = 0; const step = Math.max(it.hh * 2, 16); let cx = it.cx, cy = it.cy, guard = 0;
      while (hits(cx, cy, it.hw, it.hh) && guard < 12) { push += step; cx = it.cx + it.out.x * push; cy = it.cy + it.out.y * push; guard++; }
      placed.push({ cx, cy, hw: it.hw, hh: it.hh });
      const shift = (p: Pt) => ({ x: p.x + it.out.x * push, y: p.y + it.out.y * push });
      return { fa: it.fa, fb: it.fb, da: shift(it.da), db: shift(it.db), cx, cy, value: it.length };
    }));
    disposables.forEach(d => d.dispose());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape?.geometry?.uuid, panelFrameOf(shape)?.geo, arrowRotated, az, canvasSize.w, canvasSize.h]);

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, az: azRef.current };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* yok say */ }
  };
  const onPointerMove = (e: React.PointerEvent) => { const d = dragRef.current; if (d) setAz(Math.max(-55, Math.min(55, d.az + (e.clientX - d.x) * 0.35))); };
  const onPointerUp = () => { dragRef.current = null; };
  const fsG = dimFs(canvasSize.w), asz = arrowSize(canvasSize.w);
  const fill = { position: 'absolute', inset: 0, width: '100%', height: '100%' } as const;

  return (
    <div ref={wrapRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}
      style={{ position: 'absolute', inset: 0, userSelect: 'none', cursor: 'ew-resize', touchAction: 'none' }}>
      <canvas ref={canvasRef} style={{ display: 'block', ...fill, filter: 'drop-shadow(0 8px 14px rgba(60,40,20,0.06))' }} />
      <svg style={{ ...fill, pointerEvents: 'none', overflow: 'visible' }} viewBox={`0 0 ${canvasSize.w} ${canvasSize.h}`}>
        {ground.map((d, i) => (
          <g key={`gd-${i}`}>
            <line x1={d.fa.x} y1={d.fa.y} x2={d.da.x} y2={d.da.y} stroke={DIM_EXT} strokeWidth="0.7" />
            <line x1={d.fb.x} y1={d.fb.y} x2={d.db.x} y2={d.db.y} stroke={DIM_EXT} strokeWidth="0.7" />
            <DimArrows a={d.da} b={d.db} asz={asz} color={DIM_LINE} />
            <DimPill cx={d.cx} cy={d.cy} txt={String(d.value)} fs={fsG} />
          </g>
        ))}
      </svg>
    </div>
  );
}

/* RAF / DİKME ŞEMASI: kalınlık kutucuğu yalnız değer girişi açar; üye seçimi yalnız LEVHAYA tıklayınca. */
const SCHEMA_PAD = 34;
function regionMask(boxes: CavityBox[], h: number, v: number) {
  const hsSet = new Set<number>(), vsSet = new Set<number>();
  for (const b of boxes) { hsSet.add(b.min[h]); hsSet.add(b.max[h]); vsSet.add(b.min[v]); vsSet.add(b.max[v]); }
  const hs = Array.from(hsSet).sort((a, b) => a - b), vs = Array.from(vsSet).sort((a, b) => a - b);
  const filled = (i: number, j: number) => {
    const ch = (hs[i] + hs[i + 1]) / 2, cv = (vs[j] + vs[j + 1]) / 2;
    return boxes.some(b => ch > b.min[h] && ch < b.max[h] && cv > b.min[v] && cv < b.max[v]);
  };
  return { hs, vs, filled };
}
type SchemaEdit = { kind: 'gap'; k: number; v: string } | { kind: 't'; i: number; v: string };
const widestRun = (runs: Array<[number, number]>) => runs.reduce((b, x) => (x[1] - x[0] > b[1] - b[0] ? x : b));
const BADGE_LABELS = ['Door ref', 'Back ref'] as const;
const GAP_LOCK_TITLE = {
  locked: 'Locked — fixed on resize and when other gaps are edited. Click: open',
  hold: 'Pinned — keeps its value when other gaps are edited, still scales with the volume on resize. Click: lock',
  open: 'Open — takes up changes from other gaps and scales with the volume on resize. Click: pin',
};

export function GroupSchematic({
  group, selectedIndex, memberLabels, doorRefs, backRefs, onEditGap, onToggleLock, onEditThickness, onSelectMember, onToggleDoorRef, onToggleBackRef,
  onEditBegin, onEditCancel,
}: {
  group: PanelGroup; selectedIndex: number;
  memberLabels: string[];
  doorRefs: boolean[]; backRefs: boolean[];
  /** preview=true → canlı önizleme (yalnız store dağılımı, rebuild yok); yoksa onay (yazım + rebuild). */
  onEditGap: (k: number, v: number, preview?: boolean) => void; onToggleLock: (k: number) => void;
  onEditThickness: (i: number, v: number, preview?: boolean) => void; onSelectMember: (i: number) => void;
  onToggleDoorRef: (i: number) => void; onToggleBackRef: (i: number) => void;
  /** Düzenleme başında kayıt alınır; Esc → kayıt geri yüklenir. */
  onEditBegin?: () => unknown; onEditCancel?: (snap: unknown) => void;
}) {
  const [wrapRef, width] = useElementWidth();
  // Canlı önizleme: her tuşta önizleme yazılır; Esc kaydı geri yükler ve blur onayını iptal eder.
  const ed = useEditSession<SchemaEdit>(onEditBegin, onEditCancel);
  const { editing, setEditing } = ed;
  const apply = (e: SchemaEdit, v: number, preview?: boolean) => {
    if (e.kind === 'gap') { if (v >= 0) { onEditGap(e.k, v, preview); return true; } } else if (v > 0) { onEditThickness(e.i, v, preview); return true; }
    return false;
  };
  useEffect(() => { setEditing(null); }, [group.id, group.count, selectedIndex >= 0]);

  const { cavity, gaps, axis } = group;
  const passiveIdx = passiveGapIndex(gaps, gaps.length);   // tek açık boşluk → pasif (kalanı toplar)
  const gsid = svgId('gs', group.id);
  const ts = memberThicknessesOf(group);
  const barsHorizontal = axis === 1;
  const height = PREVIEW_HEIGHT;
  // Sayım yönü: facing>0 → hacmin MİN tarafından, facing<0 → MAX tarafından.
  const facing = groupFacing(group);
  const stackOrigin = facing > 0 ? cavity.min[axis] : cavity.max[axis];
  const starts = panelStarts(cavity, axis, facing, gaps, ts);

  // Bölge silueti: iki aday görünüşten ŞEKLİ gösteren seçilir (ikisi de dikdörtgense ön görünüş); levha/pill maskeye kırpılır.
  const region = group.region && group.region.length ? group.region : [cavity];
  const view = useMemo(() => {
    const views: Array<[number, number]> = barsHorizontal ? [[0, 1], [2, 1]] : [[axis, 1], [axis, axis === 0 ? 2 : 0]];
    const cands = views.map(([h, v]) => {
      const m = regionMask(region, h, v); const loops = traceMaskLoops(m.hs, m.vs, m.filled);
      return { h, v, m, loops, shaped: loops.length > 1 || loops.some(l => l.length > 4) };
    });
    return cands[0].shaped || !cands[1].shaped ? cands[0] : cands[1];
  }, [region, barsHorizontal]);
  const { h: hAxis, v: vAxis, m: mask, loops } = view;
  // Temsili kare çizim: dizilim ekseninde dünya → px parça-doğrusal, böylece L/U siluet de aynı haritayla çizilir.
  const innerW = width - 2 * SCHEMA_PAD, innerH = height - 2 * SCHEMA_PAD;
  const S = Math.max(40, Math.min(innerW, innerH));
  const ox = SCHEMA_PAD + (innerW - S) / 2, oy = SCHEMA_PAD + (innerH - S) / 2;
  const crossAxis = barsHorizontal ? hAxis : vAxis;
  const nBars = starts.length;
  const barPx = Math.max(3, Math.min(7, S / Math.max(1, (nBars + 1) * 4)));
  const tMin = ts.length ? Math.max(1, Math.min(...ts)) : 1;
  const barPxOf = (i: number) => Math.min(barPx * 3, barPx * ((ts[i] ?? tMin) / tMin));
  const barPxSum = starts.reduce((a, _, i) => a + barPxOf(i), 0);
  // Kırılma noktaları stackOrigin'den yürür; facing<0 ise mapStack için dünya-artan sıraya çevrilir.
  const stackMap = useMemo(() => {
    const wb: number[] = [stackOrigin], pb: number[] = [0];
    const gSum = gaps.reduce((a, g) => a + Math.max(0, g.value), 0);
    const avail = Math.max(0, S - barPxSum);
    let w = stackOrigin, p = 0;
    gaps.forEach((g, k) => {
      w += facing * Math.max(0, g.value); p += gSum > 1e-6 ? (Math.max(0, g.value) / gSum) * avail : avail / gaps.length;
      wb.push(w); pb.push(p);
      if (k < nBars) { w += facing * ts[k]; p += barPxOf(k); wb.push(w); pb.push(p); }
    });
    if (facing < 0) { const pEnd = pb[pb.length - 1]; wb.reverse(); pb.reverse(); for (let i = 0; i < pb.length; i++) pb[i] = pEnd - pb[i]; }
    return { wb, pb };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cavity, axis, facing, stackOrigin, gaps, S, nBars, barPx, barPxSum, ts.join('/')]);
  const mapStack = (w: number) => {
    const { wb, pb } = stackMap;
    if (w <= wb[0]) return pb[0];
    for (let i = 1; i < wb.length; i++) {
      if (w <= wb[i]) { const d = wb[i] - wb[i - 1]; return d > 1e-9 ? pb[i - 1] + ((w - wb[i - 1]) / d) * (pb[i] - pb[i - 1]) : pb[i]; }
    }
    return Math.min(S, pb[pb.length - 1]);
  };
  const crossSpan = Math.max(boxSpan(cavity, crossAxis), 1);
  const mapCross = (w: number) => ((w - cavity.min[crossAxis]) / crossSpan) * S;
  const sx = (wh: number) => ox + (hAxis === axis ? mapStack(wh) : mapCross(wh));
  const sy = (wv: number) => oy + S - (vAxis === axis ? mapStack(wv) : mapCross(wv));
  /** Dizilim (stack) ve çapraz (cross) koordinattan ekran noktası. */
  const at = (stack: number, cross: number): Pt => (barsHorizontal ? { x: sx(cross), y: sy(stack) } : { x: sx(stack), y: sy(cross) });
  const silhouettePath = loops.map(l => l.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ') + ' Z').join(' ');
  const runsAt = (a0: number, a1: number): Array<[number, number]> => {
    const stackPl = barsHorizontal ? mask.vs : mask.hs, crossPl = barsHorizontal ? mask.hs : mask.vs;
    const layers: number[] = [];
    for (let j = 0; j < stackPl.length - 1; j++) if (stackPl[j] < a1 - 0.5 && stackPl[j + 1] > a0 + 0.5) layers.push(j);
    const out: Array<[number, number]> = [];
    let run: [number, number] | null = null;
    for (let i = 0; i <= crossPl.length - 1; i++) {
      const on = i < crossPl.length - 1 && layers.length > 0 && layers.every(j => (barsHorizontal ? mask.filled(i, j) : mask.filled(j, i)));
      if (on) { if (!run) run = [crossPl[i], crossPl[i + 1]]; else run[1] = crossPl[i + 1]; }
      else if (run) { out.push(run); run = null; }
    }
    return out;
  };
  /** Levha i'nin ekran kutusu (çapraz aralık r üzerinde). */
  const barBox = (i: number, r: [number, number]) => {
    const st = starts[i], a = at(st, r[0]), b = at(st + ts[i], r[1]);
    return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  };

  const fs = schemFs(width), fsT = schemFsT(fs), cfsB = chipFs(fsT), asz = arrowSize(width);
  let cursor = stackOrigin;
  const pills = gaps.map((g, k) => {
    const a = cursor, b = cursor + facing * g.value; cursor = b + facing * (ts[k] ?? 0);
    const mid = (a + b) / 2;
    const txt = String(round1(g.value));
    const { pw, ph } = pillSize(txt, fs);
    // L bölgede pill boş kısma düşmesin: en geniş DOLU aralığın ortası.
    const runs = runsAt(mid - 0.5, mid + 0.5);
    const widest = runs.length ? widestRun(runs) : null;
    const crossMid = widest ? (widest[0] + widest[1]) / 2 : (cavity.min[crossAxis] + cavity.max[crossAxis]) / 2;
    let { x: cx, y: cy } = at(mid, crossMid);
    const gapPx = Math.abs(mapStack(b) - mapStack(a));
    if (!barsHorizontal && gapPx < pw + 6) cy += (k % 2 === 0 ? -1 : 1) * (ph * 0.75);
    if (barsHorizontal && gapPx < ph + 6) cx += (k % 2 === 0 ? -1 : 1) * (pw * 0.6);
    return { k, cx, cy, pw, ph, txt, a, b, crossMid };
  });
  // Kalınlık pill'i ve üye numarası levhanın iki ucunda (yatay levhada sağ / sol, düşeyde üst / alt).
  const ends = starts.map((st, i) => {
    const mid = st + ts[i] / 2;
    const txt = String(round1(ts[i])), lbl = memberLabels[i] ?? String(i + 1);
    const t = pillSize(txt, fsT), n = pillSize(lbl, fsT);
    return barsHorizontal
      ? { i, txt, lbl, ...t, cx: Math.min(ox + S + 6 + t.pw / 2, width - t.pw / 2 - 2), cy: sy(mid), nx: Math.max(ox - 6 - n.pw / 2, n.pw / 2 + 2), ny: sy(mid) }
      : { i, txt, lbl, ...t, cx: sx(mid), cy: Math.max(oy - 6 - t.ph / 2, t.ph / 2 + 2), nx: sx(mid), ny: Math.min(oy + S + 6 + n.ph / 2, height - n.ph / 2 - 2) };
  });

  const commit = () => {
    if (!editing || ed.wasCancelled()) return;   // Esc sonrası blur: onay yok
    const v = parseNum(editing.v);
    setEditing(null);
    if (isNaN(v) || !apply(editing, v)) ed.revert();
  };
  const HIT = 5;
  const bar = (key: string, i: number, b: { x0: number; y0: number; x1: number; y1: number }) => {
    const on = i === selectedIndex;
    const tip = `Panel ${memberLabels[i] ?? i + 1} · ${round1(ts[i])} mm — click to select`;
    return (
      <g key={key} style={{ cursor: 'pointer' }} onClick={e => { stop(e); onSelectMember(i); }}>
        <rect x={b.x0} y={b.y0} width={b.x1 - b.x0} height={b.y1 - b.y0} rx={1.5} fill={on ? `url(#${gsid}-on)` : `url(#${gsid}-part)`}
          stroke={on ? SOFT.onStroke : SOFT.partStroke} strokeWidth={on ? 1.1 : 0.8} style={{ filter: SOFT.shadow }} />
        <rect x={b.x0 - HIT} y={b.y0 - HIT} width={b.x1 - b.x0 + 2 * HIT} height={b.y1 - b.y0 + 2 * HIT} fill="transparent"><title>{tip}</title></rect>
      </g>
    );
  };
  /* Levha rozetleri (kapak sınırı · arkalık sınırı) — YAZILI rozet (Goker): arkalık/kapak şemasındaki bant rozetleriyle aynı dil
     (beyaz = kapalı, koyu taş = açık). Levhanın UZUNLUĞU boyunca, levha yönünde dizilir → üye sayısı artsa da çakışmaz. */
  const barBadges = (i: number, b: { x0: number; y0: number; x1: number; y1: number }) => {
    const lbl = memberLabels[i] ?? String(i + 1);
    // Rozet uzunluğu (levha yönünde) = pill genişliği; ilki levhanın ucundan 6 px içeride, aralarında 5 px.
    const ws = BADGE_LABELS.map(t => pillSize(t, cfsB).pw);
    const along = (k: number) => 6 + ws.slice(0, k).reduce((a, w) => a + w + 5, 0) + ws[k] / 2;
    const spot = (k: number): [number, number] => (barsHorizontal ? [b.x1 - along(k), (b.y0 + b.y1) / 2] : [(b.x0 + b.x1) / 2, b.y0 + along(k)]);
    const badge = (k: 0 | 1, on: boolean, tip: string, onClick: () => void) => {
      const [cx, cy] = spot(k);
      return (
        <g key={`${k ? 'back' : 'door'}-${i}`} style={{ cursor: 'pointer' }} onClick={e => { stop(e); onClick(); }}>
          <Chip cx={cx} cy={cy} txt={BADGE_LABELS[k]} fs={cfsB} tone={on ? CHIP.on : CHIP.base} rot={barsHorizontal ? 0 : -90} />
          <title>{tip}</title>
        </g>
      );
    };
    return (
      <g key={`badges-${i}`}>
        {badge(0, !!doorRefs[i], doorRefs[i]
          ? `Panel ${lbl}: door reference ON — doors are built from this panel's edges. Click to remove`
          : `Panel ${lbl}: mark as door reference (doors are built from this panel's edges)`, () => onToggleDoorRef(i))}
        {badge(1, !!backRefs[i], backRefs[i]
          ? `Panel ${lbl}: back panel reference ON — click to remove`
          : `Panel ${lbl}: mark as back panel reference (the back panel ends at / splits at this panel)`, () => onToggleBackRef(i))}
      </g>
    );
  };
  // Sayım yönü oku: dizilimin başladığı köşede kırmızı ok.
  const facingArrow = (() => {
    const len = 18, m = 9, horiz = hAxis === axis;
    const x0 = horiz ? (facing > 0 ? ox + m : ox + S - m) : ox + m;
    const y0 = horiz ? oy + m : (facing > 0 ? oy + S - m : oy + m);
    const x1 = horiz ? x0 + facing * len : x0, y1 = horiz ? y0 : y0 - facing * len;
    const ang = Math.atan2(y1 - y0, x1 - x0), arm = 6.5, f = (n: number) => n.toFixed(1);
    const ax = (k: number) => f(x1 - arm * Math.cos(ang + k * Math.PI / 4)), ay = (k: number) => f(y1 - arm * Math.sin(ang + k * Math.PI / 4));
    return `M${f(x0)},${f(y0)} L${f(x1)},${f(y1)} M${ax(1)},${ay(1)} L${f(x1)},${f(y1)} L${ax(-1)},${ay(-1)}`;
  })();
  const editPill = editing ? (editing.kind === 'gap' ? pills[editing.k] : ends[editing.i]) : undefined;

  return (
    <div ref={wrapRef} className={PREVIEW_FRAME} style={{ background: PREVIEW_BG, height }}>
      <style>{SCHEMATIC_CSS}</style>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', fontFamily: UI_FONT }}>
        <SoftDefs id={gsid} />
        <path d={silhouettePath} fill={SOFT.area} stroke={SOFT.areaStroke} strokeWidth={1} strokeLinejoin="round" fillRule="evenodd" />
        <g style={{ pointerEvents: 'none' }} opacity={0.95}>
          <path d={facingArrow} fill="none" stroke="#dc2626" strokeWidth={2.4} strokeLinecap="butt" strokeLinejoin="miter" />
          <title>Gaps and members are counted from this side</title>
        </g>
        {starts.map((st, i) => runsAt(st, st + ts[i]).map((r, ri) => bar(`bar-${i}-${ri}`, i, barBox(i, r))))}
        {starts.map((st, i) => {
          const runs = runsAt(st, st + ts[i]);
          return runs.length ? barBadges(i, barBox(i, widestRun(runs))) : null;
        })}
        {ends.map(p => {
          const on = p.i === selectedIndex;
          return (
            <DimPill key={`t-${p.i}`} cx={p.cx} cy={p.cy} txt={p.txt} fs={fsT} fill={on ? '#fff7ed' : '#f5f2ec'} stroke={on ? '#f97316' : SOFT.pillStroke}
              strokeWidth={on ? 1 : 0.7} color={on ? '#c2410c' : '#57534e'} hideText={editing?.kind === 't' && editing.i === p.i}
              title={`Panel ${memberLabels[p.i] ?? p.i + 1} thickness — click to edit`}
              onClick={e => { stop(e); ed.begin({ kind: 't', i: p.i, v: p.txt }); }} />
          );
        })}
        {ends.map(n => {
          const on = n.i === selectedIndex;
          return (
            <text key={`n-${n.i}`} x={n.nx} y={n.ny + fsT * 0.36} textAnchor="middle" fontSize={fsT} fontWeight={on ? 700 : 600} fill={on ? '#ea580c' : SOFT.label}
              fontFamily={UI_FONT} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', userSelect: 'none' }}>{n.lbl}</text>
          );
        })}
        {pills.map(p => {
          const mode = gapMode(gaps[p.k]);
          const a = at(p.a, p.crossMid), b = at(p.b, p.crossMid);
          if (passiveIdx === p.k) return (
            <g key={`gap-${p.k}`} className="yago-gap passive" style={{ cursor: 'not-allowed' }}>
              <DimArrows a={a} b={b} asz={asz} color={DIM_LINE} />
              <PassivePill cx={p.cx} cy={p.cy} txt={p.txt} fs={fs} title="Gap — remainder (all other gaps pinned or locked); open one to edit" />
            </g>
          );
          const locked = mode === 'locked', edited = mode === 'hold';
          return (
            <g key={`gap-${p.k}`} className={`yago-gap${locked ? ' locked' : ''}`}>
              <DimArrows a={a} b={b} asz={asz} color={locked ? '#f59e0b' : DIM_LINE} />
              <DimPill cx={p.cx} cy={p.cy} txt={p.txt} fs={fs} fill={locked || edited ? '#fff7ed' : '#ffffff'}
                stroke={locked ? '#f97316' : edited ? '#fbbf24' : SOFT.pillStroke} strokeWidth={locked || edited ? 1 : 0.7}
                color={locked ? '#c2410c' : edited ? '#9a3412' : '#44403c'} hideText={editing?.kind === 'gap' && editing.k === p.k}
                title={edited ? 'Pinned gap — click to edit (open gaps take up the difference)' : 'Edit gap (open gaps take up the difference)'}
                onClick={e => { stop(e); ed.begin({ kind: 'gap', k: p.k, v: p.txt }); }} />
              <LockBadge cx={p.cx + p.pw / 2 + LOCK_OFF} cy={p.cy} locked={locked} edited={edited} onClick={() => onToggleLock(p.k)}
                title={GAP_LOCK_TITLE[locked ? 'locked' : edited ? 'hold' : 'open']} holdIcon />
            </g>
          );
        })}
      </svg>
      {editing && editPill && (
        <PillEditInput at={editPill} fs={editing.kind === 'gap' ? fs : fsT} value={editing.v} onCommit={commit} onCancel={ed.cancel}
          onChange={raw => {
            const next = { ...editing, v: raw } as SchemaEdit; setEditing(next);
            const v = parseNum(raw); if (!isNaN(v)) apply(next, v, true);
          }} />
      )}
    </div>
  );
}

// ═════════════════════════════════════════ 3. KAPAK / ARKALIK ORTAK ÇEKİRDEĞİ ═════════════════════════════════════════
/* KAPAK / ARKALIK ŞEMASI ORTAK ÇEKİRDEĞİ — yalnız çizim ve yerleşim (servisler ayrı): ekran haritası, levha bantları, ölçü zincirleri,
   pill şeritleri, kilit / rozet yerleşimi, ortak SVG parçaları ve değer kutusu. */

const PART_INSET = 1.5;   // parçalar içeri çizilir ki 3 mm boşluklar görünsün
const BAND_MIN = 6;
const CHAIN_OFF_H = 27;          // alt bant ve ortadaki rozetle çakışmasın
const CHAIN_OFF_V = 38;          // pill'ler yatay geniş, sağ bant rozetini aşsın
const CHAIN_STEP = 16;
const PILL_LANE_GAP = 3;

type Axis = 'u' | 'v';
export type Box4 = { u0: number; u1: number; v0: number; v1: number };
type PxBox = { x0: number; y0: number; x1: number; y1: number };
type Rect = { x: number; y: number; w: number; h: number };
type SchemEdit = { key: string; v: string };
/** Ölçü zinciri öğesi; a..b = eksen boyunca mm. `span` (yalnız boşluk): kenarın/derzin çapraz eksendeki GERÇEK uzunluğu —
 *  pill bu uzunluğun ortasına yerleşir (açılı kesimde kenar kısalır). */
export type ChainItem = {
  key: string; kind: 'size' | 'gap'; a: number; b: number; txt: string; title: string; locked?: boolean; edited?: boolean; passive?: boolean;
  onLock?: () => void; lockTitle?: string; commit: (v: number) => void; preview?: (v: number) => void; min: number; span?: [number, number];
};
type Chain = { horiz: boolean; pos: number; items: ChainItem[] };
/** Düzenlenebilir değerin kutusu (pill / rozet). */
export type EditTarget = { cx: number; cy: number; pw: number; ph: number; f: number; item: ChainItem };
type Pill = EditTarget & { key: string; horiz: boolean; deg?: number; lock?: Pt };
/** Rozet ekseni: merkez, birim yön ve yarı boy — rozet bu eksen boyunca kaydırılır. */
export type ChipAxis = { cx: number; cy: number; ux: number; uy: number; half: number };

export const isAdditive = (e: React.MouseEvent) => e.shiftKey || e.ctrlKey || e.metaKey;
const ptsPath = (pts: Pt[]) => pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ') + ' Z';
const rectPts = (b: PxBox): Pt[] => [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }];
/** Yazı okunur yönde (−90°..90°); % yerine döngü: JS % negatifte işaret korur. */
const readableDeg = (deg: number) => { while (deg > 90) deg -= 180; while (deg < -90) deg += 180; return deg; };
/** Aralık en az `min` (ortasından açılır). */
export const widen = (lo: number, hi: number, min: number): [number, number] => (hi - lo < min ? [(lo + hi) / 2 - min / 2, (lo + hi) / 2 + min / 2] : [lo, hi]);
export const crossOf = (r: Box4, ax: Axis): [number, number] => (ax === 'u' ? [r.v0, r.v1] : [r.u0, r.u1]);

/* ───────────── EKRAN HARİTASI ───────────── */

/** mm (u, v) → px. Eksenler ayrı ölçeklenir; aynalı görünüşte u / v ters akar. x1 / y1 = çizim alanının sağ / alt sınırı (bantlar
 *  buraya kırpılır). */
export function schemView(rect: Box4, ox: number, oy: number, SW: number, SH: number, mirrorU: boolean, mirrorV: boolean, x1: number, y1: number) {
  const duR = Math.max(1e-6, rect.u1 - rect.u0), dvR = Math.max(1e-6, rect.v1 - rect.v0);
  const sx = (u: number) => (mirrorU ? ox + SW - ((u - rect.u0) / duR) * SW : ox + ((u - rect.u0) / duR) * SW);
  const sy = (v: number) => (mirrorV ? oy + ((v - rect.v0) / dvR) * SH : oy + ((rect.v1 - v) / dvR) * SH);
  const toMm = ([x, y]: number[]): Pt => ({
    x: rect.u0 + (mirrorU ? (ox + SW - x) : (x - ox)) * duR / SW,
    y: mirrorV ? rect.v0 + (y - oy) * dvR / SH : rect.v1 - (y - oy) * dvR / SH,
  });
  return {
    sx, sy, ox, oy, SW, SH, duR, dvR, mirrorU, mirrorV,
    toPx: (q: Pt): Pt => ({ x: sx(q.x), y: sy(q.y) }),
    /** mm kutusunun px kutusu, `inset` px içeri. */
    box: (r: Box4, inset = 0): PxBox => ({
      x0: Math.min(sx(r.u0), sx(r.u1)) + inset, x1: Math.max(sx(r.u0), sx(r.u1)) - inset,
      y0: Math.min(sy(r.v1), sy(r.v0)) + inset, y1: Math.max(sy(r.v1), sy(r.v0)) - inset,
    }),
    clampX: (x: number) => Math.max(2, Math.min(x1, x)),
    clampY: (y: number) => Math.max(2, Math.min(y1, y)),
    /** Çizim alanı (mm): açılı / pahlı levha zarfı buna kırpılır. */
    areaMm: [[2, 2], [x1, 2], [x1, y1], [2, y1]].map(toMm),
  };
}
export type SchemView = ReturnType<typeof schemView>;
/** Açılı levha şeridinin en ince kalınlığı (mm) = BAND_MIN px. */
export const cutMinMm = (v: SchemView) => BAND_MIN * v.dvR / v.SH;
/** Ekrandaki yan adı (dikeyde Left / Right, yatayda Top / Bottom); `lead` = aynasız görünüşte sol / üst taraf. */
export const sideLabel = (vertical: boolean, lead: boolean, v: SchemView) =>
  (vertical ? (lead !== v.mirrorU ? 'Left' : 'Right') : (lead !== v.mirrorV ? 'Top' : 'Bottom'));
export const edgeLabel = (vertical: boolean, k: EdgeKey | undefined, v: SchemView) => sideLabel(vertical, vertical ? k === 'uMin' : k === 'vMax', v);
export const leafIds = (n: SolvedNode): string[] => treeLeaves(n).map(l => l.id);
/** Kökten düğüme kimlik yolu. */
export function nodePath(root: SolvedNode, id: string): string[] {
  const out: string[] = [];
  const dfs = (n: SolvedNode): boolean => {
    out.push(n.id);
    if (n.id === id) return true;
    if (n.kind === 'split') for (const c of n.children) if (dfs(c)) return true;
    out.pop(); return false;
  };
  dfs(root);
  return out;
}

/* ───────────── LEVHA BANTLARI ───────────── */

type NearLike = { kind: Axis; a0: number; a1: number; c0: number; c1: number; poly?: Pt[]; ref?: unknown; joint?: unknown };
/** Sınır levhası bandı (px): kalınlık en az BAND_MIN, boy çizim alanına kırpılı. Ön görünüşü dikdörtgen olmayan levhada (eğik panel
 *  altında pahlı yan) `pts` gerçek izdüşüm zarfı, x/y/w/h = zarfın kutusu. `aligned` = levhaya bağlı derz (sıcak ton). */
export function bandGeom(np: NearLike, v: SchemView) {
  const vertical = np.kind === 'u';
  const along = vertical ? v.sx : v.sy, across = vertical ? v.sy : v.sx, clamp = vertical ? v.clampY : v.clampX;
  const [a0, a1] = widen(Math.min(along(np.a0), along(np.a1)), Math.max(along(np.a0), along(np.a1)), BAND_MIN);
  const c0 = clamp(Math.min(across(np.c0), across(np.c1))), c1 = clamp(Math.max(across(np.c0), across(np.c1)));
  let x = vertical ? a0 : c0, y = vertical ? c0 : a0, w = vertical ? a1 - a0 : c1 - c0, h = vertical ? c1 - c0 : a1 - a0;
  let pts: Pt[] = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const hull = np.poly ? clipPolyToConvex(np.poly, v.areaMm) : [];
  if (hull.length >= 3) {
    pts = hull.map(v.toPx);
    const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
    x = Math.min(...xs); y = Math.min(...ys); w = Math.max(...xs) - x; h = Math.max(...ys) - y;
  }
  return { vertical, x, y, w, h, pts, aligned: !!np.ref && !!np.joint };
}
export const bandAxis = (b: Rect & { vertical: boolean }): ChipAxis =>
  ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2, ux: b.vertical ? 0 : 1, uy: b.vertical ? 1 : 0, half: (b.vertical ? b.h : b.w) / 2 });
/** Açılı levha şeridi (px): ağırlık merkezi ve okunur yöndeki açısı. */
export function cutBandGeom(cb: { poly: Pt[]; dir: Pt }, v: SchemView) {
  const pts = cb.poly.map(v.toPx);
  const cx = pts.reduce((a, q) => a + q.x, 0) / pts.length, cy = pts.reduce((a, q) => a + q.y, 0) / pts.length;
  return { pts, cx, cy, deg: readableDeg(Math.atan2((v.mirrorV ? 1 : -1) * cb.dir.y, (v.mirrorU ? -1 : 1) * cb.dir.x) * 180 / Math.PI) };
}
export const cutAxis = (cb: { pts: Pt[]; cx: number; cy: number; deg: number }): ChipAxis => {
  const rad = cb.deg * Math.PI / 180, ux = Math.cos(rad), uy = Math.sin(rad);
  return { cx: cb.cx, cy: cb.cy, ux, uy, half: Math.max(...cb.pts.map(q => Math.abs((q.x - cb.cx) * ux + (q.y - cb.cy) * uy))) };
};
/** Bandın parçaların ALTINDA kalan kısımları (taralı, kesikli çizilir). */
const hiddenParts = (pts: Pt[], members: Box4[], v: SchemView) => members.flatMap(m => {
  const b = v.box(m, PART_INSET);
  if (b.x1 - b.x0 < 0.5 || b.y1 - b.y0 < 0.5) return [];
  const part = clipPolyToConvex(pts, rectPts(b));
  return part.length >= 3 && Math.abs(polyArea(part)) > 0.5 ? [part] : [];
});
/** Üyelerin `dir` yönündeki en uzun kenarı (eğik kenar). */
export function longestEdgeAlong<M extends { poly?: Pt[] }>(members: M[], dir: Pt, keep: (m: M) => boolean = () => true) {
  let best: { a: Pt; b: Pt; len: number; m: M } | null = null;
  for (const m of members) {
    if (!m.poly || !keep(m)) continue;
    for (let i = 0; i < m.poly.length; i++) {
      const a = m.poly[i], b = m.poly[(i + 1) % m.poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1 || Math.abs((b.x - a.x) * dir.y - (b.y - a.y) * dir.x) / len > 0.01) continue;
      if (!best || len > best.len) best = { a, b, len, m };
    }
  }
  return best;
}
/** Eğik kenarlar: kesilen kenarı olan her açılı şeridin, üyelerdeki en uzun eşyönlü kenarı. Düz kenar zincirlerinde o kenar GÖSTERİLMEZ. */
export const slopeSegsOf = <C extends { edge: EdgeKey | null; dir: Pt }, M extends { poly?: Pt[] }>(cutBands: C[], members: M[]) =>
  cutBands.flatMap(cb => {
    if (!cb.edge) return [];
    const best = longestEdgeAlong(members, cb.dir);
    return best ? [{ cb, edge: cb.edge, ...best }] : [];
  });
/** Eğik kenar pill'i: kenarın ortasında, kenar yönünde döndürülmüş; `off` px parçanın içine (+) / dışına (−). */
export function slopePill(sg: { a: Pt; b: Pt; m: { poly?: Pt[] } }, v: SchemView, fs: number, item: ChainItem, off: number): Pill {
  const a = v.toPx(sg.a), b = v.toPx(sg.b), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, tx = (b.x - a.x) / L, ty = (b.y - a.y) / L;
  const poly = sg.m.poly!, cxm = poly.reduce((s0, q) => s0 + v.sx(q.x), 0) / poly.length, cym = poly.reduce((s0, q) => s0 + v.sy(q.y), 0) / poly.length;
  let nx = -ty, ny = tx;
  if (nx * (cxm - mid.x) + ny * (cym - mid.y) < 0) { nx = -nx; ny = -ny; }
  const { pw, ph } = pillSize(item.txt, fs);
  return { key: item.key, cx: mid.x + nx * off, cy: mid.y + ny * off, pw, ph, f: fs, item, horiz: true, deg: readableDeg(Math.atan2(ty, tx) * 180 / Math.PI) };
}

/* ───────────── ÖLÇÜ ZİNCİRLERİ ───────────── */

/** Çokgenin `ax` = val doğrusu üzerindeki kesişim aralığı (çapraz eksende). */
function lineSpan(poly: Pt[], ax: Axis, val: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const pa = ax === 'u' ? a.x : a.y, pb = ax === 'u' ? b.x : b.y;
    if ((pa - val) * (pb - val) > 0 || Math.abs(pb - pa) < 1e-9) continue;
    const t = (val - pa) / (pb - pa), q = ax === 'u' ? a.y + t * (b.y - a.y) : a.x + t * (b.x - a.x);
    lo = Math.min(lo, q); hi = Math.max(hi, q);
  }
  return hi - lo > 0.5 ? [lo, hi] : null;
}
const clampSpan = (sp: [number, number], c: [number, number]): [number, number] => {
  const lo = Math.max(sp[0], Math.min(c[0], c[1])), hi = Math.min(sp[1], Math.max(c[0], c[1]));
  return hi - lo > 1 ? [lo, hi] : sp;
};
/** Ölçü zincirleri + turuncu boşluk şeritleri. `outline` = kutunun (açılı kesimli) mm çokgeni: boşluk pill'i kenarın / derzin
 *  gerçek uzunluğunun ortasına yerleşir. */
export function chainKit(v: SchemView, outline: (r: Box4) => Pt[]) {
  const chains: Chain[] = [], strips: Rect[] = [];
  const slots = new Map<string, { h: number; v: number }>();   // bölge başına aynı yöndeki zincir sayısı (kademe)
  const memo = new Map<string, Pt[]>();
  const outlineOf = (r: Box4) => {
    const key = `${r.u0.toFixed(2)},${r.u1.toFixed(2)},${r.v0.toFixed(2)},${r.v1.toFixed(2)}`;
    let o = memo.get(key);
    if (!o) { o = outline(r); memo.set(key, o); }
    return o;
  };
  /** R'nin ax = val doğrusundaki uzunluğu; `on` verilirse o bölgeye kırpılır. */
  const spanAt = (R: Box4, ax: Axis, val: number, on?: Box4) => {
    const sp = lineSpan(outlineOf(R), ax, val) ?? crossOf(R, ax);
    return on ? clampSpan(sp, crossOf(on, ax)) : sp;
  };
  return {
    chains, strips,
    jointSpan: (R: Box4, ax: Axis, a: number, b: number, on?: Box4) => spanAt(R, ax, (a + b) / 2, on),
    /** Doğru kenarın 0.5 mm içinden geçer (tam kenarda kesişim belirsiz). */
    edgeSpan: (R: Box4, k: EdgeKey, on?: Box4) => spanAt(R, k === 'uMin' || k === 'uMax' ? 'u' : 'v',
      k === 'uMin' ? R.u0 + 0.5 : k === 'uMax' ? R.u1 - 0.5 : k === 'vMin' ? R.v0 + 0.5 : R.v1 - 0.5, on),
    /** Boşluk şeridi: `ax` ekseninde a..b (en az 3 px), çapraz eksende c. */
    strip: (ax: Axis, a: number, b: number, [c0, c1]: [number, number]) => {
      let { x0, x1, y0, y1 } = v.box(ax === 'u' ? { u0: a, u1: b, v0: c0, v1: c1 } : { u0: c0, u1: c1, v0: a, v1: b });
      if (ax === 'u') [x0, x1] = widen(x0, x1, 3); else [y0, y1] = widen(y0, y1, 3);
      strips.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    },
    /** Zincir bölgenin alt (yatay) / sağ (düşey) kenarının içinde; aynı bölgede aynı yöndeki her yeni zincir bir adım içeride. */
    pushChain: (on: Box4 & { id: string }, horiz: boolean, items: ChainItem[]) => {
      if (!items.length) return;
      const sl = slots.get(on.id) ?? { h: 0, v: 0 }; slots.set(on.id, sl);
      const b = v.box(on);
      const pos = horiz ? b.y1 - CHAIN_OFF_H - CHAIN_STEP * sl.h : b.x1 - CHAIN_OFF_V - CHAIN_STEP * sl.v;
      if (horiz) sl.h++; else sl.v++;
      chains.push({ horiz, pos, items });
    },
  };
}
type ChainKit = ReturnType<typeof chainKit>;
export type ChainParts<N extends SolvedNode> = {
  size: (P: SplitOf<N>, i: number, a: number, b: number, horiz: boolean) => ChainItem;
  /** Bölme yokken alanın tamamı (`ax` yönünde). */
  full: (ax: Axis, on: N) => ChainItem[];
  gapTitle: string;
  onGap: (splitId: string, k: number, v: number, preview?: boolean) => void;
  /** true → bu derzde zincirde ara yok (levhaya bağlı derz). */
  hideGap?: (P: SplitOf<N>, k: number) => boolean;
  /** Bölge alanın kenarına değiyorsa kenar boşluğu öğesi (`end` = bitiş ucu; `on` = zincirin bölgesi). */
  edge?: (n: N, horiz: boolean, end: boolean, at: number, on?: N) => ChainItem | null;
};
/** Seçili bölgenin zincirleri: bölmede kendi ölçüleri, yaprakta üst bölmedeki yeri; çapraz yönde ilk farklı eksenli üst bölmedeki yer
 *  (yoksa alanın tamamı). */
export function regionChains<N extends SolvedNode>(kit: ChainKit, root: N, n: N, parts: ChainParts<N>) {
  const gap = (P: SplitOf<N>, k: number, a: number, b: number, on: N, clampOn?: N): ChainItem[] => {
    if (parts.hideGap?.(P, k)) return [];
    kit.strip(P.axis, a, b, crossOf(on, P.axis));
    return [{ key: `sgap-${P.id}-${k}`, kind: 'gap', a, b, txt: fmt1(P.gaps[k] ?? 0), title: parts.gapTitle, min: 0,
      span: kit.jointSpan(P, P.axis, a, b, clampOn), commit: x => parts.onGap(P.id, k, x), preview: x => parts.onGap(P.id, k, x, true) }];
  };
  const edge = (m: N, horiz: boolean, end: boolean, at: number, on?: N): ChainItem[] => {
    const it = parts.edge?.(m, horiz, end, at, on);
    return it ? [it] : [];
  };
  const splitItems = (S: SplitOf<N>): ChainItem[] => {
    const horiz = S.axis === 'u', dir = horiz ? 1 : -1;
    let p = horiz ? S.u0 : S.v1;
    const items = edge(S, horiz, false, p);
    S.children.forEach((_c, i) => {
      const w = S.sizes[i]?.value ?? 0;
      items.push(parts.size(S, i, p, p + dir * w, horiz));
      p += dir * w;
      if (i < S.children.length - 1) { const g = S.gaps[i] ?? 0; items.push(...gap(S, i, p, p + dir * g, S)); p += dir * g; }
    });
    return [...items, ...edge(S, horiz, true, p)];
  };
  const placeItems = (m: N, P: SplitOf<N>, on: N): ChainItem[] => {
    const horiz = P.axis === 'u', dir = horiz ? 1 : -1;
    const idx = P.children.findIndex(c => c.id === m.id);
    if (idx < 0) return [];
    const start = horiz ? m.u0 : m.v1, end = start + dir * (P.sizes[idx]?.value ?? 0);
    const head = idx > 0 ? gap(P, idx - 1, start - dir * (P.gaps[idx - 1] ?? 0), start, on, on) : edge(m, horiz, false, start, on);
    const size = parts.size(P, idx, start, end, horiz);
    return [...head, size, ...(idx < P.children.length - 1 ? gap(P, idx, end, end + dir * (P.gaps[idx] ?? 0), on, on) : edge(m, horiz, true, end, on))];
  };
  const crossChain = (m: N, axis: Axis, on: N) => {
    let A: N = m, B = findParent(root, A.id);
    while (B && B.axis === axis) { A = B; B = findParent(root, B.id); }
    if (B) kit.pushChain(on, B.axis === 'u', placeItems(A, B, on));
    else kit.pushChain(on, axis !== 'u', parts.full(axis === 'u' ? 'v' : 'u', on));
  };
  if (n.kind === 'split') {
    const S = n as SplitOf<N>;
    kit.pushChain(n, S.axis === 'u', splitItems(S));
    crossChain(n, S.axis, n);
    return;
  }
  const P = findParent(root, n.id);
  if (P) { kit.pushChain(n, P.axis === 'u', placeItems(n, P, n)); crossChain(P, P.axis, n); }
  else { kit.pushChain(n, true, parts.full('u', n)); kit.pushChain(n, false, parts.full('v', n)); }
}

/* ───────────── PILL / KİLİT / ROZET YERLEŞİMİ ───────────── */

/** Çakışma önlemi: zincir başına şeritler (kademeli ölçü). Sabit boşluk pill'leri (kenar/derz ortasında) yerinde kalır; önce ÖLÇÜ
 *  pill'leri bunlara 2B'de çarpmayan ilk şeride, sonra serbest BOŞLUK pill'leri ilk boş şeride girer (sığmazsa son şerit — hiçbir boşluk
 *  gizlenmez). Şeritler bölgenin içine doğru (yatay → yukarı, düşey → sola). Kilit yeri: ölçünün ucu; çarpıyorsa karşı uç, sonra
 *  pill'in yanları — kilitler pill'lere ve birbirine binmesin. W / H = SVG boyu. */
export function layoutPills(chains: Chain[], v: SchemView, fs: number, slopePills: Pill[], W: number, H: number): Pill[] {
  type LanePill = Pill & { fixed: boolean };
  const chainPills = chains.map(ch => ({ ch, all: ch.items.map((it): LanePill => {
    const { pw, ph } = pillSize(it.txt, fs);
    const along = ch.horiz ? v.sx : v.sy, mid = (along(it.a) + along(it.b)) / 2;
    const sc = it.kind === 'gap' && it.span ? (ch.horiz ? v.sy : v.sx)((it.span[0] + it.span[1]) / 2) : null;
    return { key: it.key, cx: ch.horiz ? mid : (sc ?? ch.pos), cy: ch.horiz ? (sc ?? ch.pos) : mid, pw, ph, f: fs, item: it, horiz: ch.horiz,
      fixed: sc != null };
  }) }));
  const fixedAll: Pill[] = [...chainPills.flatMap(c => c.all.filter(p => p.fixed)), ...slopePills];
  const boxHit = (x: number, y: number, w: number, h: number, q: Pill) => Math.abs(x - q.cx) < (w + q.pw) / 2 + 2 && Math.abs(y - q.cy) < (h + q.ph) / 2 + 2;
  const pills: Pill[] = chainPills.flatMap(({ ch, all }) => {
    const base = all.filter(p => !p.fixed).sort((a, b) => (ch.horiz ? a.cx - b.cx : a.cy - b.cy));
    // Dar kapakta ölçü, boşluk kutucuklarından kaçmak için 5 şeride kadar çıkar.
    const lanes: Array<Array<{ start: number; end: number }>> = [[], [], [], [], []];
    const spanOf = (p: Pill) => {
      const c = ch.horiz ? p.cx : p.cy, half = (ch.horiz ? p.pw : p.ph) / 2 + 1;
      return { start: c - half, end: c + half + (p.item.onLock ? LOCK_EXT : 0) };
    };
    const fits = (lane: number, { start, end }: { start: number; end: number }) => lanes[lane].every(q => end <= q.start || start >= q.end);
    const laneStep = Math.max(...base.map(p => (ch.horiz ? p.ph : p.pw)), 0) + PILL_LANE_GAP;
    const clear2D = (p: Pill, lane: number) => {
      const x = ch.horiz ? p.cx : p.cx - lane * laneStep, y = ch.horiz ? p.cy - lane * laneStep : p.cy;
      if (fixedAll.some(q => boxHit(x, y, p.pw, p.ph, q))) return false;
      if (!p.item.onLock) return true;
      const lx = ch.horiz ? x + p.pw / 2 + LOCK_OFF : x, ly = ch.horiz ? y : y + p.ph / 2 + LOCK_OFF;
      return !fixedAll.some(q => boxHit(lx, ly, 2 * LOCK_R, 2 * LOCK_R, q));
    };
    const place = (p: Pill, lane: number) => {
      lanes[lane].push(spanOf(p));
      if (lane > 0) { if (ch.horiz) p.cy -= lane * laneStep; else p.cx -= lane * laneStep; }
    };
    for (const p of base.filter(x => x.item.kind === 'size')) {
      const sp = spanOf(p);
      // Hiçbir şerit uymazsa 0. şerit: ölçü hep çizilir.
      place(p, [0, 1, 2, 3, 4].find(l => fits(l, sp) && clear2D(p, l)) ?? (fits(0, sp) ? 0 : fits(1, sp) ? 1 : 0));
    }
    for (const p of base.filter(x => x.item.kind === 'gap')) { const sp = spanOf(p); place(p, [0, 1, 2].find(l => fits(l, sp)) ?? 2); }
    return [...base, ...all.filter(p => p.fixed)];
  });
  pills.push(...slopePills);
  const locks: Pt[] = [];
  const clearOf = (x: number, y: number, self: Pill) =>
    x >= LOCK_R + 1 && x <= W - LOCK_R - 1 && y >= LOCK_R + 1 && y <= H - LOCK_R - 1 &&
    pills.every(q => q === self || Math.abs(x - q.cx) >= q.pw / 2 + LOCK_R + 2 || Math.abs(y - q.cy) >= q.ph / 2 + LOCK_R + 2) &&
    locks.every(l => Math.hypot(l.x - x, l.y - y) >= 2 * LOCK_R + 3);
  for (const p of pills) {
    if (!p.item.onLock) continue;
    const d = (p.horiz ? p.pw : p.ph) / 2 + LOCK_OFF, e = (p.horiz ? p.ph : p.pw) / 2 + LOCK_OFF;
    const cand = p.horiz ? [{ x: p.cx + d, y: p.cy }, { x: p.cx - d, y: p.cy }, { x: p.cx, y: p.cy + e }, { x: p.cx, y: p.cy - e }]
      : [{ x: p.cx, y: p.cy + d }, { x: p.cx, y: p.cy - d }, { x: p.cx + e, y: p.cy }, { x: p.cx - e, y: p.cy }];
    p.lock = cand.find(c => clearOf(c.x, c.y, p)) ?? cand[0];
    locks.push(p.lock);
  }
  return pills;
}
/** Bant rozeti yerleşimi: rozet pill / kilide çarpıyorsa bant boyunca (dönüşümlü) kaydırılır, bandın içinde kalır. Parça etiket bloğu
 *  (no · ölçü · tür) da engel: "Split here" gibi rozetler etiketin üstüne binmesin. `obstacles` dışarıdan büyütülebilir. */
export function chipPlacer(pills: Pill[], members: Box4[], v: SchemView, fsT: number) {
  const obstacles = pills.flatMap(p => {
    const o = [{ x: p.cx, y: p.cy, r: Math.max(p.pw, p.ph) / 2 }];
    if (p.lock) o.push({ ...p.lock, r: LOCK_R });
    return o;
  });
  for (const m of members) obstacles.push({ x: (v.sx(m.u0) + v.sx(m.u1)) / 2, y: (v.sy(m.v0) + v.sy(m.v1)) / 2, r: fsT * 2.6 });
  const spot = ({ cx, cy, ux, uy, half }: ChipAxis, cw: number): Pt => {
    const r = cw / 2 + 2, step = cw / 2 + 6;
    const free = (x: number, y: number) => obstacles.every(o => Math.hypot(o.x - x, o.y - y) >= o.r + r);
    for (let k = 0; k <= 12; k++) {
      const d = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
      if (Math.abs(d) > Math.max(0, half - cw / 2)) continue;
      const x = cx + ux * d, y = cy + uy * d;
      if (free(x, y)) return { x, y };
    }
    return { x: cx, y: cy };
  };
  return { obstacles, spot };
}

/* ───────────── DÜZENLEME ───────────── */

/** Şema değer düzenleme oturumu: kutu grup / seçim değişince kapanır — ağaç değişince KAPANMAMALI (canlı önizleme her tuşta yazar). */
export function useSchemEdit(
  onBegin: (() => unknown) | undefined, onCancel: ((snap: unknown) => void) | undefined, groupId: string, hasSel: boolean, selKey: string,
) {
  const ed = useEditSession<SchemEdit>(onBegin, onCancel);
  const { setEditing } = ed;
  useEffect(() => { setEditing(null); }, [groupId, hasSel, selKey, setEditing]);
  return ed;
}
type SchemEditSession = ReturnType<typeof useSchemEdit>;
/** Değer kutusu: her tuşta canlı önizleme; Enter / blur onaylar (geçersiz → önizleme geri alınır), Esc iptal eder. */
export function ChainEditInput({ ed, find }: { ed: SchemEditSession; find: (key: string) => EditTarget | undefined }) {
  const { editing, setEditing } = ed;
  const at = editing ? find(editing.key) : undefined;
  if (!editing || !at) return null;
  const valid = (raw: string) => {
    const v = parseNum(raw), p = find(editing.key);
    return isNaN(v) || !p || v < p.item.min ? null : { v, item: p.item };
  };
  const commit = () => {
    if (ed.wasCancelled()) return;   // Esc sonrası blur: onay yok
    const ok = valid(editing.v);
    setEditing(null);
    if (ok) ok.item.commit(ok.v); else ed.revert();
  };
  return (
    <PillEditInput at={at} fs={at.f} value={editing.v} onCommit={commit} onCancel={ed.cancel}
      onChange={raw => { setEditing({ ...editing, v: raw }); const ok = valid(raw); ok?.item.preview?.(ok.v); }} />
  );
}

/* ───────────── SVG PARÇALARI ───────────── */

const NO_PTR: React.CSSProperties = { pointerEvents: 'none' };
const NUM_TXT: React.CSSProperties = { fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', userSelect: 'none' };
const hatch = (gid: string, warm: boolean) => `url(#${gid}-hatch${warm ? '-on' : ''})`;
const HatchDef = ({ id, stroke, w }: { id: string; stroke: string; w: number }) => (
  <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="4" stroke={stroke} strokeWidth={w} />
  </pattern>
);
/** Şema çerçevesi: önizleme kutusu, SVG (parça gradyanları, levha taramaları, alan zemini) ve SVG üstü katman (değer kutusu). */
export function SchemFrame({ wrapRef, width, height, gid, view, overlay, children }: {
  wrapRef: React.RefObject<HTMLDivElement>; width: number; height: number; gid: string; view: SchemView; overlay: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div ref={wrapRef} className={PREVIEW_FRAME} style={{ background: PREVIEW_BG, height }}>
      <style>{SCHEMATIC_CSS}</style>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', fontFamily: UI_FONT }}>
        <defs>
          <VGrad id={`${gid}-part`} from={SOFT.part0} to={SOFT.part1} />
          <VGrad id={`${gid}-part-on`} from={SOFT.on0} to={SOFT.on1} />
          <VGrad id={`${gid}-part-sel`} from={SOFT.sel0} to={SOFT.sel1} />
          <HatchDef id={`${gid}-hatch`} stroke="#bfb5a6" w={0.7} />
          <HatchDef id={`${gid}-hatch-on`} stroke="#e8925a" w={0.9} />
        </defs>
        <rect x={view.ox} y={view.oy} width={view.SW} height={view.SH} rx={3} fill={SOFT.area} stroke={SOFT.areaStroke} strokeWidth={0.8} />
        {children}
      </svg>
      {overlay}
    </div>
  );
}
/** Levha bandı (taralı); warm = sıcak ton (bini / bağlı derz). */
export const BandFill = ({ gid, pts, warm }: { gid: string; pts: Pt[]; warm: boolean }) => (
  <g style={NO_PTR}>
    <path d={ptsPath(pts)} fill={warm ? '#f9dcc4' : '#ddd4c6'} />
    <path d={ptsPath(pts)} fill={hatch(gid, warm)} />
    <path d={ptsPath(pts)} fill="none" stroke={warm ? '#e07b3c' : '#a39a8d'} strokeWidth={1} strokeLinejoin="round" />
  </g>
);
/** Bandın parçaların altında kalan kısımları (kesikli). */
export const HiddenParts = ({ gid, pts, warm, members, view }: { gid: string; pts: Pt[]; warm: boolean; members: Box4[]; view: SchemView }) => (
  <>{hiddenParts(pts, members, view).map((hp, k) => (
    <g key={k} style={NO_PTR}>
      <path d={ptsPath(hp)} fill={hatch(gid, warm)} opacity={0.4} />
      <path d={ptsPath(hp)} fill="none" stroke={warm ? '#e8925a' : '#9a9185'} strokeWidth={0.8} strokeDasharray="3 2" opacity={0.9} strokeLinejoin="round" />
    </g>
  ))}</>
);
/** Bant tık alanı + üzerine gelince koyu bant + rozet. `rect` yoksa tık alanı bandın kendi çokgeni. */
export function BandHit({ gid, pts, rect, warm, onClick, chip, title }: {
  gid: string; pts: Pt[]; rect?: Rect; warm: boolean; onClick?: (e: React.MouseEvent) => void; chip?: React.ReactNode; title: string;
}) {
  const d = ptsPath(pts);
  return (
    <g className={`yago-band pnl${chip ? ' on' : ''}`} style={{ cursor: onClick ? 'pointer' : 'default' }} onClick={onClick && (e => { stop(e); onClick(e); })}>
      {rect ? <rect x={rect.x - 2} y={rect.y - 2} width={rect.w + 4} height={rect.h + 4} fill="transparent" className="hit" />
        : <path d={d} fill="transparent" stroke="transparent" strokeWidth={4} strokeLinejoin="round" className="hit" />}
      <g className="hov">
        <path d={d} fill={warm ? '#f6c39c' : '#cbbca6'} fillOpacity={0.92} />
        <path d={d} fill={hatch(gid, warm)} />
        <path d={d} fill="none" stroke={warm ? '#c2410c' : '#6f6457'} strokeWidth={1.3} strokeLinejoin="round" />
      </g>
      {chip}
      <title>{title}</title>
    </g>
  );
}
/** Boşluk şeritleri (turuncu); açılı kesimde alana kırpılır. */
export const FocusStrips = ({ strips, clip }: { strips: Rect[]; clip: Pt[] | null }) => (
  <>{strips.map((r, i) => {
    const sp = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
    const cl = clip ? clipPolyToConvex(sp, clip) : sp;
    return cl.length >= 3
      ? <path key={`fs-${i}`} d={ptsPath(cl)} fill="#f97316" fillOpacity={0.28} stroke="#ea580c" strokeOpacity={0.55} strokeWidth={0.6} style={NO_PTR} /> : null;
  })}</>
);
/** Seçili bölge çerçevesi (bölme kesikli); açılı kesimle küçülmüş bölgede gerçek şekli (`shape`, mm). */
export function SelOutline({ n, shape, view }: { n: Box4 & { kind: string }; shape: Pt[] | null; view: SchemView }) {
  const split = n.kind === 'split';
  const line = { fill: '#ea580c', fillOpacity: split ? 0.05 : 0.0, stroke: '#ea580c', strokeWidth: 1.2, strokeDasharray: split ? '5 3' : undefined };
  if (shape && Math.abs(polyArea(shape)) < (n.u1 - n.u0) * (n.v1 - n.v0) - 1) {
    return <g style={NO_PTR}><path d={ptsPath(shape.map(view.toPx))} strokeLinejoin="round" {...line} /></g>;
  }
  const b = view.box(n), pad = split ? 2.5 : 0.5;
  return <g style={NO_PTR}><rect x={b.x0 - pad} y={b.y0 - pad} width={b.x1 - b.x0 + 2 * pad} height={b.y1 - b.y0 + 2 * pad} rx={3} {...line} /></g>;
}
/** Parça ipucu: başlık · W × H mm … — tık açıklaması · son. */
export const memberTip = (head: string, m: Box4 & { poly?: Pt[] }, depth: number, tail: string) =>
  `${head} · ${Math.round(m.u1 - m.u0)} × ${Math.round(m.v1 - m.v0)} mm${m.poly ? ' · angled (cut by rotated reference)' : ''}`
  + ` — click: select the area, click again to go one level deeper (${depth} level${depth === 1 ? '' : 's'})`
  + ` · Shift/Ctrl+click: add another region · ${tail}`;
/** Parça (kapak / arkalık parçası): gradyanlı kutu ya da açılı çokgen + no · W×H · tür yazısı. Zincir pill'i yazı alanına biniyorsa
 *  W×H gizlenir (zincir zaten söyler). `extra` = kutunun üstüne çizilen işaret (kapak açılım çizgisi). */
export function MemberCell({ m, view, gid, on, inSel, lbl, tip, caption, fsT, pills, onPick, extra }: {
  m: Box4 & { poly?: Pt[] }; view: SchemView; gid: string; on: boolean; inSel: boolean; lbl: string; tip: string; caption: string | null; fsT: number;
  pills: Pill[]; onPick: (additive: boolean) => void; extra?: (b: PxBox, pts: Pt[] | null) => React.ReactNode;
}) {
  const b = view.box(m, PART_INSET), { x0, y0, x1, y1 } = b, w = x1 - x0, h = y1 - y0;
  const pts = m.poly ? m.poly.map(view.toPx) : null;
  const fill = `url(#${gid}-part${on ? '-on' : inSel ? '-sel' : ''})`, stroke = on ? SOFT.onStroke : inSel ? SOFT.selStroke : SOFT.partStroke;
  const wMm = Math.round(m.u1 - m.u0), hMm = Math.round(m.v1 - m.v0);
  const cx = pts ? pts.reduce((a, q) => a + q.x, 0) / pts.length : (x0 + x1) / 2;
  const cy = pts ? pts.reduce((a, q) => a + q.y, 0) / pts.length : (y0 + y1) / 2;
  const fsz = fsT * 0.86, lh = fsT * 1.18;
  const capW = `${wMm} × ${hMm}`.length * fsz * 0.6 + 6, capH = fsz * 1.2;
  const capHit = pills.some(pp => Math.abs(pp.cx - cx) < (pp.pw + capW) / 2 && Math.abs(pp.cy - cy) < (pp.ph + capH) / 2 + lh);
  const showSize = w > 58 && h > 34 && !capHit, showCap = !!caption && showSize && h > 50;
  const lines = 1 + (showSize ? 1 : 0) + (showCap ? 1 : 0);
  const ty0 = capHit ? cy - lh : cy - ((lines - 1) * lh) / 2;
  return (
    <g style={{ cursor: 'pointer' }} onClick={e => { stop(e); onPick(isAdditive(e)); }}>
      {pts ? (
        <polygon points={pts.map(q => `${q.x},${q.y}`).join(' ')} fill={fill} stroke={stroke} strokeWidth={on ? 1.2 : 0.9} strokeLinejoin="round">
          <title>{tip}</title>
        </polygon>
      ) : (
        <rect x={x0} y={y0} width={Math.max(1, w)} height={Math.max(1, h)} rx={2.5} fill={fill} stroke={stroke} strokeWidth={on ? 1.2 : 0.8}
          style={{ filter: SOFT.shadow }}>
          <title>{tip}</title>
        </rect>
      )}
      {!pts && w > 6 && h > 6 && (
        <rect x={x0 + 1} y={y0 + 1} width={Math.max(0, w - 2)} height={Math.max(0, h - 2)} rx={1.5} fill="none" stroke="#ffffff" strokeOpacity={0.55}
          strokeWidth={0.8} style={NO_PTR} />
      )}
      {extra?.(b, pts)}
      <text x={cx} y={ty0 + fsT * 0.36} textAnchor="middle" fontSize={fsT} fontWeight={on ? 700 : 650} fill={on ? '#ea580c' : '#8f877c'} fontFamily={UI_FONT}
        style={NUM_TXT}>{lbl}</text>
      {showSize && (
        <text x={cx} y={ty0 + lh + fsz * 0.36} textAnchor="middle" fontSize={fsz} fontWeight={500} fill={on ? '#c2410c' : '#a39b90'} fontFamily={UI_FONT}
          style={NUM_TXT}>{wMm} × {hMm}</text>
      )}
      {showCap && (
        <text x={cx} y={ty0 + 2 * lh + fsz * 0.36} textAnchor="middle" fontSize={fsz * 0.92} fontWeight={600} fill="#b5ada3" letterSpacing="0.06em"
          fontFamily={UI_FONT} style={{ textTransform: 'uppercase', pointerEvents: 'none', userSelect: 'none' }}>{caption!.toUpperCase()}</text>
      )}
    </g>
  );
}
/** Zincir pill'leri: boşluk (turuncu, eğik kenarda döndürülmüş), pasif ölçü (kalanı toplar), ölçü + kilit rozeti. Düzenlenebilir ölçü =
 *  kilitlenebilir ya da canlı önizlemeli (kanat ölçüsü); alanın tamamı sınırlardan gelir (`bounds`). */
export function ChainPills({ pills, ed, bounds }: { pills: Pill[]; ed: SchemEditSession; bounds: string }) {
  const edit = (p: Pill) => (e: React.MouseEvent) => { stop(e); ed.begin({ key: p.key, v: p.item.txt }); };
  return (
    <>{pills.map(p => {
      const { item: it, f } = p;
      const hide = ed.editing?.key === p.key;
      if (it.kind === 'gap') {
        const gp = <DimPill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} fill="#fff7ed" stroke="#f97316" strokeWidth={1} color="#c2410c" hideText={hide}
          title={it.title} onClick={edit(p)} />;
        return p.deg ? <g key={p.key} transform={`rotate(${p.deg.toFixed(1)} ${p.cx} ${p.cy})`}>{gp}</g> : <g key={p.key}>{gp}</g>;
      }
      if (it.passive) {
        return (
          <g key={p.key} className="yago-gap passive" style={{ cursor: 'not-allowed' }}><PassivePill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} title={it.title} /></g>
        );
      }
      const locked = !!it.locked, edited = !locked && !!it.edited, editable = !!(it.onLock || it.preview);
      return (
        <g key={p.key} className={`yago-gap${locked ? ' locked' : ''}`}>
          <DimPill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} fill={locked || edited ? '#fff7ed' : '#ffffff'} stroke={edited ? '#fbbf24' : '#f97316'}
            strokeWidth={locked ? 1.2 : 1} color={locked ? '#c2410c' : edited ? '#9a3412' : '#1c1917'} hideText={hide} onClick={editable ? edit(p) : undefined}
            title={!editable ? `${it.title} — set by the ${bounds} bounds` : edited ? `${it.title} (${it.lockTitle ? 'held' : 'entered'} value)` : it.title} />
          {it.onLock && p.lock && (
            <LockBadge cx={p.lock.x} cy={p.lock.y} locked={locked} edited={edited} onClick={it.onLock} title={it.lockTitle} holdIcon={!!it.lockTitle} />
          )}
        </g>
      );
    })}</>
  );
}

// ══════════════════════════════════════════════════ 4. KAPAK ŞEMASI ══════════════════════════════════════════════════
/* KAPAK ŞEMASI: temsili ön görünüş (eksenler ayrı ölçeklenir). Ölçü zinciri yalnız seçili bölgenin üzerinde ve
   oksuz (oklar 3 mm boşluklara giriyordu). Sınır levhaları yalnız DIŞ kapakta çizilir. */
const DOOR_PAD = 12;                   // dört kenar
const DOOR_MIN_ASPECT = 0.6;      // çok geniş kapakta ölçüler sıkışmasın
type DoorSplit = Extract<DoorNodeSolved, { kind: 'split' }>;
// DERZ BİNİSİ: 'min'/'max' = o taraftaki (düşük/yüksek u·v) kapak levhayı tamamen örter (Full), 'center' = ikisi yarı (Half).
// KAPAK BİNİSİ (kapak seçili): Full = seçili kapak levhayı tamamen örter · Half = iki kapak levha ortasına · None = seçili kapak
// levhanın kenarında biter, komşu kapak levhayı örter. Levha yerinde kalır; yalnız iki komşu kapak uzar/kısalır.
type OverlayOpt = 'Full' | 'Half' | 'None';
const alignForOpt = (side: DoorAlign, o: OverlayOpt): DoorAlign => (o === 'Full' ? side : o === 'Half' ? 'center' : side === 'min' ? 'max' : 'min');
const optOf = (side: DoorAlign, st: DoorAlign | null): OverlayOpt | null => (st === 'center' ? 'Half' : st === side ? 'Full' : st ? 'None' : null);

export function DoorSchematic({
  group, selectedIndex, selectedNodes, memberLabels, cuts, nearPanels, refPick, onEditSize, onToggleLock, onEditSplitGap, onEditEdgeGap, onEditLeaf,
  onEditLeafGap, onPathClick, onToggleHalfOverlay, onAlignJoint, onJointOverlay, onRefPick, onSplitAtPanel, onEdgeOverlay, addPick, onAddPick, onRemovePick,
  addObstacles, onEditBegin, onEditCancel,
}: {
  group: DoorGroup; selectedIndex: number; memberLabels: string[];
  selectedNodes: string[];
  /** Açılı referans: üyeler bu kesicilerle kırpılmış çokgen olarak çizilir (3B ile aynı şekil). */
  cuts: DoorCut[];
  nearPanels: DoorNearPanel[];
  /** preview=true → canlı önizleme (yalnız store dağılımı, rebuild yok); yoksa onay (yazım + rebuild). */
  onEditSize: (splitId: string, k: number, v: number, preview?: boolean) => void; onToggleLock: (splitId: string, k: number) => void;
  onEditSplitGap: (splitId: string, k: number, v: number, preview?: boolean) => void; onEditEdgeGap: (edge: DoorEdgeKey, v: number, preview?: boolean) => void;
  onEditLeaf: (leafId: string, k: number, v: number, preview?: boolean) => void; onEditLeafGap: (leafId: string, v: number, preview?: boolean) => void;
  onEditBegin?: () => unknown; onEditCancel?: (snap: unknown) => void;
  /** Tıklanan noktanın kök → yaprak düğüm yolu (yalnız seçim, üye seçilmez); additive = Shift/Ctrl/⌘. */
  onPathClick: (path: string[], additive: boolean) => void;
  onToggleHalfOverlay: (edge: DoorEdgeKey, on: boolean) => void;
  /** Yalnız bağ çözme (null): Shift/Ctrl+tık. */
  onAlignJoint: (splitId: string, k: number, vfId: string, align: DoorAlign | null) => void;
  /** Derz binisi (seçili kapağa göre Full/Half): levha yerinde, kapaklar uzar/kısalır. */
  onJointOverlay: (splitId: string, k: number, vfId: string, align: DoorAlign) => void;
  refPick?: boolean;
  onRefPick?: (vfId: string) => void;
  /** Kapak bölünmemişken arkasındaki sınır levhası: tık kapağı levhanın ortasından böler (Half) ve bir yanı seçer → Full/Half/None döngüsü. */
  onSplitAtPanel?: (vfId: string) => void;
  /** Kenar levhası binisi: Full → Half → None (tek rozet, tıkladıkça döner). */
  onEdgeOverlay?: (edge: DoorEdgeKey, mode: EdgeOverlayMode) => void;
  /** Araya raf/dikme modu: 'u' = V derzleri (dikme), 'v' = H derzleri (raf). Zaten bağlı derzler gösterilmez. */
  addPick?: 'u' | 'v' | null;
  /** ats = derz boyunca seçilen yer(ler) (mm); Shift/Ctrl+tık → derzin tüm BOŞ parçaları. */
  onAddPick?: (splitId: string, k: number, ats: number[]) => void;
  onRemovePick?: (groupId: string) => void;
  /** Derz parçalama engelleri: kapak sınırı İŞARETSİZ levhalar dahil (işaretsiz dikme de derzi keser). Yoksa `nearPanels`. */
  addObstacles?: DoorNearPanel[];
}) {
  const [wrapRef, width] = useElementWidth();
  const ed = useSchemEdit(onEditBegin, onEditCancel, group.id, selectedIndex >= 0, selectedNodes.join('|'));
  const { rect, axis, side } = group;
  const SW = Math.max(40, width - 2 * DOOR_PAD);
  const duR = Math.max(1e-6, rect.u1 - rect.u0), dvR = Math.max(1e-6, rect.v1 - rect.v0);
  const SH = Math.round(Math.max(DOOR_MIN_ASPECT * SW, Math.min(PREVIEW_HEIGHT - 2 * DOOR_PAD, SW * dvR / duR)));
  const height = SH + 2 * DOOR_PAD;
  // Görünüş: arka (Z−) ve sağ yan (X+) aynalı; üst (Y+) → Z aşağı.
  const view = schemView(rect, DOOR_PAD, DOOR_PAD, SW, SH, (axis === 2 && side < 0) || (axis === 0 && side > 0), axis === 1 && side > 0,
    DOOR_PAD + SW + DOOR_PAD - 2, DOOR_PAD + SH + DOOR_PAD - 2);
  const { sx, sy, mirrorU, mirrorV } = view;
  const eg = edgeGapsOf(group);
  const treeKey = JSON.stringify(group.tree);
  const cutsKey = cuts.map(c => `${c.vfId}:${c.n.map(x => x.toFixed(3)).join(',')}:${c.dMin.toFixed(1)}:${c.dMax.toFixed(1)}`).join('|');
  const solved = useMemo(() => solveDoorTree(group), // eslint-disable-next-line react-hooks/exhaustive-deps
    [rect, treeKey, group.gap, eg.uMin, eg.uMax, eg.vMin, eg.vMax]);
  const members = useMemo(() => applyDoorCuts(group, rect, doorMemberRects(solved), cuts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [solved, cutsKey, group.placement, group.thickness, group.gap]);
  const fs = schemFs(width), fsT = schemFsT(fs), cfs = chipFs(fsT);
  const gid = svgId('ds', group.id);
  const isOuter = group.placement === 'outer';

  // Hiza rozeti tıkı derzi levhaya BAĞLAR ve levhayı taşır (kapak yerinde kalır); Shift/Ctrl+tık bağı çözer.
  const bands = nearPanels.map(np => {
    const none = !!np.edge && np.behind && !!group.noOverlay?.[np.edge];
    const half = !none && !!np.edge && np.behind && !!group.halfOverlay?.[np.edge];
    return { np, ...bandGeom(np, view), half, none };
  });
  type Band = typeof bands[number];
  const cutBands = doorCutBands(group, rect, cuts, view.areaMm, cutMinMm(view))
    .map(cb => ({ ...cb, ...cutBandGeom(cb, view), half: !!cb.edge && cb.covered && !!group.halfOverlay?.[cb.edge] }));
  // Eğik kenarın boşluk pill'i eğik kenarın üzerinde durur; düz kenar zincirlerinde o kenar GÖSTERİLMEZ (yanıltıcı olur).
  const slopeSegs = slopeSegsOf(cutBands, members);
  const slopeEdges = new Set<DoorEdgeKey>(slopeSegs.map(sg => sg.edge));
  const selRegions = selectedNodes.map(id => findSolvedNode(solved, id)).filter((n): n is DoorNodeSolved => !!n);
  const selLeafIds = new Set(selRegions.flatMap(leafIds));
  // Bini bağlamı: şemada bölge seçili değilse listede / 3B'de seçili kapağın yaprağı (kapak satırı açıkken de Full/Half/None çıksın).
  const selMemberLeaf = selectedIndex >= 0 && members[selectedIndex] ? findSolvedNode(solved, members[selectedIndex].leafId) : null;
  const overlayRegions: DoorNodeSolved[] = [...(selMemberLeaf ? [selMemberLeaf] : []), ...selRegions];

  const sideName = (b: Band, a: DoorAlign) => sideLabel(b.vertical, b.vertical ? a === 'min' : a === 'max', view);
  const allJoints = doorJoints(solved);
  // Seçili bölge levhaya bitişikse: o bölgenin derzi + levhanın hangi tarafında olduğu (np.joint öncelikli).
  const overlayCtx = (np: DoorNearPanel): { j: DoorJoint; side: DoorAlign } | null => {
    if (np.edge || !np.joint || !overlayRegions.length) return null;
    const pc = (np.a0 + np.a1) / 2, t = np.a1 - np.a0;
    const own = (j: DoorJoint) => Number(!(j.splitId === np.joint!.splitId && j.k === np.joint!.k));
    const cands = allJoints.filter(j => j.axis === np.kind && Math.min(j.c1, np.c1) - Math.max(j.c0, np.c0) >= 0.5
      && Math.abs((j.p0 + j.p1) / 2 - pc) <= t / 2 + (j.p1 - j.p0) / 2 + JOINT_NEAR).sort((a, b) => own(a) - own(b));
    for (const j of cands) for (const n of overlayRegions) {
      const nc0 = np.kind === 'u' ? n.v0 : n.u0, nc1 = np.kind === 'u' ? n.v1 : n.u1;
      if (Math.min(nc1, j.c1, np.c1) - Math.max(nc0, j.c0, np.c0) < 0.5) continue;
      const na0 = np.kind === 'u' ? n.u0 : n.v0, na1 = np.kind === 'u' ? n.u1 : n.v1;
      if (Math.abs(na1 - j.p0) < 0.6) return { j, side: 'min' };
      if (Math.abs(na0 - j.p1) < 0.6) return { j, side: 'max' };
    }
    return null;
  };
  const overlayState = (np: DoorNearPanel, j: DoorJoint): DoorAlign | null =>
    (np.ref && np.ref.splitId === j.splitId && np.ref.k === j.k ? np.ref.align : jointOverlayState(j, np.a0, np.a1));
  const jointChip = (b: Band): string | null => {
    const np = b.np;
    if (np.edge || !np.joint) return null;
    const ctx = overlayCtx(np);
    if (ctx) return optOf(ctx.side, overlayState(np, ctx.j)) ?? 'Free';
    const s = overlayState(np, np.joint);
    return s === 'center' ? 'Half' : s ? `${sideName(b, s)} full` : 'Free';
  };
  const removable = (np: DoorNearPanel) => !!addPick && !np.edge && np.kind === addPick && np.ref?.master === 'door' && !!np.groupId;
  // Kapak sonradan konan levhada henüz bölünmemiş: levha kapağın arkasında, yakınında derz yok → ilk tık böler (Half).
  const splitChipOn = (np: DoorNearPanel) => !!onSplitAtPanel && !np.edge && !np.joint && np.behind && !refPick && !addPick && canSplitDoorAtPanel(group, np);
  const bandTip = (b: Band) => {
    const np = b.np;
    if (np.edge) {
      const edge = edgeLabel(b.vertical, np.edge, view);
      if (!np.behind) return `${edge} — ${np.name}: stands in front of the door plane; the door ends beside it (no overlay possible).`;
      const now = b.none ? 'NONE — the door ends at this panel\'s inner face (does not cover it)'
        : b.half ? 'HALF overlay — the door covers half of this panel\'s thickness (the other half is left for the neighbouring door)'
        : 'FULL overlay — the door covers this panel\'s whole thickness';
      return `${edge} — ${np.name}: ${now}. Click to step Full → Half → None.`;
    }
    const what = b.vertical ? 'divider' : 'shelf';
    if (removable(np)) return `${np.name} (${what}) — added between the doors. Click ✕ Remove to delete it (its row and panel are removed; the doors stay).`;
    if (refPick) return `${np.name} (${what}) — PANEL REF: click to split the door through this ${what}'s middle (Half overlay: both doors reach its middle).`;
    if (!np.joint) return splitChipOn(np)
      ? `${np.name} (${what}) — behind the door; the door passes over it (Full). Click: Half — the door splits through its middle (both reach it); `
        + `click again for None, then Full. The ${what} stays.`
      : `${np.name} (${what}) — behind the door, no joint nearby. Use Panel ref mode to split the door at it.`;
    const unbind = np.ref ? ' · Shift/Ctrl+click: unbind' : '';
    const ctx = overlayCtx(np);
    if (ctx) {
      return `${np.name} (${what}) — overlay of the selected door (${sideName(b, ctx.side).toLowerCase()} of it): ${jointChip(b)}. `
        + `Click to step Full (covers the whole ${what}) → Half (to its middle) → None (ends at its edge, the other door covers it). `
        + `The ${what} stays; the doors next to it lengthen / shorten.${unbind}`;
    }
    return `${np.name} (${what}) at the door joint — ${jointChip(b)}. `
      + `Click: the ${what} MOVES under the joint (Half → ${b.vertical ? 'left' : 'top'} full → ${b.vertical ? 'right' : 'bottom'} full); the doors stay. `
      + `To change the doors instead, select a door next to it first: then Full / Half lengthens / shortens that door and the ${what} stays.${unbind}`;
  };
  const onBandClick = (b: Band, additive: boolean) => {
    const np = b.np;
    if (removable(np)) { onRemovePick?.(np.groupId!); return; }
    if (refPick) { if (!np.edge && onRefPick) onRefPick(np.vfId); return; }
    if (np.edge) {
      if (np.behind) {
        const next: EdgeOverlayMode = b.none ? 'full' : b.half ? 'none' : 'half';
        if (onEdgeOverlay) onEdgeOverlay(np.edge, next); else onToggleHalfOverlay(np.edge, !b.half);
      }
      return;
    }
    const j = np.joint;
    if (!j) { if (splitChipOn(np)) onSplitAtPanel!(np.vfId); return; }
    if (additive) { if (np.ref) onAlignJoint(np.ref.splitId, np.ref.k, np.vfId, null); return; }
    const ctx = overlayCtx(np);
    // İKİ BİNİ MODU: kapak seçiliyken → KAPAK uzar/kısalır, levha yerinde (setDoorJointOverlay); kapak seçili değilken →
    // LEVHA derzin altına taşınır, kapaklar yerinde (setDoorJointRef). Sıra ekrana göre: Half → sol/üst full → sağ/alt full.
    if (ctx) {
      const cur = optOf(ctx.side, overlayState(np, ctx.j));
      onJointOverlay(ctx.j.splitId, ctx.j.k, np.vfId, alignForOpt(ctx.side, cur === 'Full' ? 'Half' : cur === 'Half' ? 'None' : 'Full'));
      return;
    }
    const s0 = overlayState(np, j);
    const first: DoorAlign = b.vertical ? (mirrorU ? 'max' : 'min') : (mirrorV ? 'min' : 'max');
    const second: DoorAlign = first === 'min' ? 'max' : 'min';
    onAlignJoint(j.splitId, j.k, np.vfId, s0 === 'center' ? first : s0 === first ? second : 'center');
  };

  // Ölçü zincirleri YALNIZ seçili bölgeler için; boşluklar turuncu şeritle işaretlenir.
  const kit = chainKit(view, r => doorCutOutline(group, rect, r, cuts));
  const T0 = 0.05;
  // Eğik kenar (slopeEdges) dokunuş sayılmaz: onun pill'i eğik kenarın üzerinde (slopePills).
  const touches = (n: DoorNodeSolved, k: DoorEdgeKey) => !slopeEdges.has(k) && Math.abs(k === 'uMin' ? n.u0 - (rect.u0 + eg.uMin)
    : k === 'uMax' ? n.u1 - (rect.u1 - eg.uMax) : k === 'vMax' ? n.v1 - (rect.v1 - eg.vMax) : n.v0 - (rect.v0 + eg.vMin)) < T0;
  const edgeItem = (k: DoorEdgeKey, a: number, b: number, R: Box4, on?: Box4): ChainItem => ({
    key: `edge-${k}`, kind: 'gap', a, b, txt: fmt1(eg[k]), title: `${edgeLabel(k === 'uMin' || k === 'uMax', k, view)} edge gap — click to edit`,
    commit: x => onEditEdgeGap(k, x), preview: x => onEditEdgeGap(k, x, true), min: 0, span: kit.edgeSpan(R, k, on),
  });
  const edgeStrip = (n: Box4, k: DoorEdgeKey) => {
    if (k === 'uMin') kit.strip('u', rect.u0, n.u0, crossOf(n, 'u')); else if (k === 'uMax') kit.strip('u', n.u1, rect.u1, crossOf(n, 'u'));
    else if (k === 'vMax') kit.strip('v', n.v1, rect.v1, crossOf(n, 'v')); else kit.strip('v', rect.v0, n.v0, crossOf(n, 'v'));
  };
  // Bölmede tek AÇIK ölçü kaldıysa PASİF (pin de kilit sayılır): girilemez, rozetsiz — değeri kalandan gelir.
  const sizeItem = (P: DoorSplit, i: number, a: number, b: number, horiz: boolean): ChainItem => {
    const base = { key: `size-${P.id}-${i}`, kind: 'size' as const, a, b, txt: fmt1(P.sizes[i]?.value ?? 0), min: 1 };
    const what = horiz ? 'Door width' : 'Door height';
    if (passiveSizeIndex(P.sizes, P.children.length) === i) {
      return { ...base, passive: true, title: `${what} — remainder (all other doors pinned or locked); open one to edit`, commit: () => {} };
    }
    // 3 mod (açık → tut → kilitli); değer yazmak ölçüyü 'tut'a alır.
    const mode = doorSizeMode(P.sizes[i]);
    const lockTitle = mode === 'locked' ? 'Locked — fixed on resize and when other doors are edited. Click: open'
      : mode === 'hold' ? 'Hold — keeps its value when other doors are edited, still scales with the door on resize. Click: lock'
      : 'Open — takes up changes from other doors and scales with the door on resize. Click: hold';
    return { ...base, title: `${what} — click to edit (open doors take up the difference)`, locked: mode === 'locked', edited: mode === 'hold', lockTitle,
      onLock: () => onToggleLock(P.id, i), commit: x => onEditSize(P.id, i, x), preview: x => onEditSize(P.id, i, x, true) };
  };
  const fullItems = (ax: 'u' | 'v', on: DoorNodeSolved): ChainItem[] => {
    const horiz = ax === 'u', dir = horiz ? 1 : -1;
    const lo = horiz ? rect.u0 : rect.v1, k0: DoorEdgeKey = horiz ? 'uMin' : 'vMax', k1: DoorEdgeKey = horiz ? 'uMax' : 'vMin';
    const span = (horiz ? rect.u1 - rect.u0 : rect.v1 - rect.v0) - eg[k0] - eg[k1];
    if (!slopeEdges.has(k0)) edgeStrip(on, k0);
    if (!slopeEdges.has(k1)) edgeStrip(on, k1);
    return [...(slopeEdges.has(k0) ? [] : [edgeItem(k0, lo, lo + dir * eg[k0], rect, on)]),
      { key: `full-${ax}`, kind: 'size', a: lo + dir * eg[k0], b: lo + dir * (eg[k0] + span), txt: fmt1(span), commit: () => {}, min: 1,
        title: horiz ? 'Door width (whole area)' : 'Door height (whole area)' },
      ...(slopeEdges.has(k1) ? [] : [edgeItem(k1, lo + dir * (eg[k0] + span), lo + dir * (eg[k0] + span + eg[k1]), rect, on)])];
  };
  const parts: ChainParts<DoorNodeSolved> = {
    size: sizeItem, full: fullItems, gapTitle: 'Gap between doors — click to edit', onGap: onEditSplitGap,
    edge: (n, horiz, end, at, on) => {
      const k: DoorEdgeKey = horiz ? (end ? 'uMax' : 'uMin') : (end ? 'vMin' : 'vMax');
      if (!touches(n, k)) return null;
      const d = (horiz ? 1 : -1) * eg[k];
      edgeStrip(on ?? n, k);
      return end ? edgeItem(k, at, at + d, n, on) : edgeItem(k, at - d, at, n, on);
    },
  };
  for (const n of selRegions) {
    regionChains(kit, solved, n, parts);
    const lax = n.kind === 'leaf' ? doorLeafAxis(n.type) : null;
    if (n.kind !== 'leaf' || !lax || n.leafSplit?.leaves.length !== 2) continue;
    // Çift kanat: kanat · ara · kanat.
    const horiz = lax === 'u', dir = horiz ? 1 : -1;
    const [a, b] = n.leafSplit.leaves.map(l => Math.max(0, l.value)), g = n.leafSplit.gap;
    const p0 = horiz ? n.u0 : n.v1, p1 = p0 + dir * a, p2 = p0 + dir * (a + g);
    kit.strip(lax, p1, p2, crossOf(n, lax));
    const leaf = (k: 0 | 1, from: number, to: number, w: number): ChainItem => ({ key: `leaf-${n.id}-${k}`, kind: 'size', a: from, b: to, txt: fmt1(w), min: 1,
      title: 'Leaf size — click to edit (the other leaf takes the rest)', commit: x => onEditLeaf(n.id, k, x), preview: x => onEditLeaf(n.id, k, x, true) });
    kit.pushChain(n, horiz, [
      leaf(0, p0, p1, a),
      { key: `lgap-${n.id}`, kind: 'gap', a: p1, b: p2, txt: fmt1(g), title: 'Gap between the two leaves — click to edit',
        commit: x => onEditLeafGap(n.id, x), preview: x => onEditLeafGap(n.id, x, true), min: 0, span: kit.jointSpan(n, lax, p1, p2) },
      leaf(1, p2, p0 + dir * (a + g + b), b),
    ]);
  }

  // Eğik kenar boşluk pill'i: yalnız SEÇİLİ kapakların en uzun eğik kenarının ortasında, kenar yönünde döndürülmüş.
  const slopePills = slopeSegs.flatMap(sg => {
    const best = longestEdgeAlong(members, sg.cb.dir, m => selLeafIds.has(m.leafId));
    if (!best) return [];
    const item: ChainItem = { key: `slope-${sg.cb.cut.vfId}`, kind: 'gap', a: 0, b: 0, txt: fmt1(eg[sg.edge]),
      title: `Gap to the angled panel ${sg.cb.cut.name} — click to edit (the door keeps this distance along the slope)`,
      commit: x => onEditEdgeGap(sg.edge, x), preview: x => onEditEdgeGap(sg.edge, x, true), min: 0 };
    return [slopePill(best, view, fs, item, -(eg[sg.edge] * view.SH / view.dvR) / 2)];   // kenar çizgisinden dışa yarım boşluk = boşluğun ortası
  });
  const pills = layoutPills(kit.chains, view, fs, slopePills, width, height);
  const pillByKey = new Map(pills.map(p => [p.key, p]));
  const chips = chipPlacer(pills, members, view, fsT);
  const stripClip = cuts.length ? doorCutOutline(group, rect, rect, cuts, false).map(view.toPx) : null;

  return (
    <SchemFrame wrapRef={wrapRef} width={width} height={height} gid={gid} view={view} overlay={<ChainEditInput ed={ed} find={k => pillByKey.get(k)} />}>
      {bands.map(b => <BandFill key={`band-${b.np.vfId}`} gid={gid} pts={b.pts} warm={b.half || b.aligned} />)}
      {cutBands.map(cb => <BandFill key={`cut-${cb.cut.vfId}`} gid={gid} pts={cb.pts} warm={cb.half} />)}
      {members.map((m, i) => {
        const on = i === selectedIndex, lbl = memberLabels[i] ?? String(i + 1), path = nodePath(solved, m.leafId);
        const typeTxt = DOOR_TYPE_LABEL[m.type] + (m.leafCount === 2 ? ` · leaf ${m.leaf + 1}/2` : '');
        // Double'da menteşe EKRANA göre: solda duran kanat sol menteşe (aynalı görünüşte de doğru).
        const swing = (b: { x0: number; y0: number; x1: number; y1: number }, pts: Array<{ x: number; y: number }> | null) => {
          let hinge: Hinge | undefined = leafHinges(m.type)[0];
          if (m.leafCount === 2 && doorLeafAxis(m.type) === 'u') {
            const sib = members[m.leaf === 0 ? i + 1 : i - 1];
            hinge = sib && Math.min(sx(sib.u0), sx(sib.u1)) < b.x0 ? 'R' : 'L';
          } else if (m.leafCount === 2) hinge = 'T';
          const ins = 5;
          return hinge && b.x1 - b.x0 > 2 * ins + 6 && b.y1 - b.y0 > 2 * ins + 6 && (
            <path d={(pts && swingPathPoly(pts, hinge, ins)) || swingPath(b.x0 + ins, b.y0 + ins, b.x1 - ins, b.y1 - ins, hinge)} fill="none"
              stroke={on ? '#f3b98e' : '#d6cfc4'} strokeWidth={0.7} strokeDasharray="3 3" strokeLinejoin="round" strokeLinecap="round"
              style={{ pointerEvents: 'none' }} />
          );
        };
        return (
          <MemberCell key={`door-${i}`} m={m} view={view} gid={gid} on={on} inSel={selLeafIds.has(m.leafId)} lbl={lbl} fsT={fsT} pills={pills} extra={swing}
            tip={memberTip(`Door ${lbl} · ${typeTxt}`, m, path.length, 'open the door\'s row below to edit it')}
            caption={m.type === 'drawer' || m.type === 'fixed' ? DOOR_TYPE_LABEL[m.type] : null} onPick={add => onPathClick(path, add)} />
        );
      })}
      {cutBands.map(cb => <HiddenParts key={`cuthid-${cb.cut.vfId}`} gid={gid} pts={cb.pts} warm={cb.half} members={members} view={view} />)}
      {bands.map(b => <HiddenParts key={`hid-${b.np.vfId}`} gid={gid} pts={b.pts} warm={b.half || b.aligned} members={members} view={view} />)}
      <FocusStrips strips={kit.strips} clip={stripClip} />
      {addPick && isOuter && doorJointParts(allJoints, addObstacles ?? nearPanels, addPick).flatMap(({ joint: j, all: segs, free }) => {
        // Araya raf/dikme: derz, onu kesen levhalarla parçalara bölünür; yalnız BOŞ parçalar rozet alır, her parça ayrı grup olur.
        const vertical = j.axis === 'u', what = vertical ? 'divider' : 'shelf';
        const along = vertical ? sx : sy, across = vertical ? sy : sx;
        const [a0, a1] = widen(Math.min(along(j.p0), along(j.p1)), Math.max(along(j.p0), along(j.p1)), 14);
        const allMids = free.map(([c0, c1]) => (c0 + c1) / 2);
        return free.map(([c0, c1]) => {
          const q0 = Math.min(across(c0), across(c1)), q1 = Math.max(across(c0), across(c1));
          const x = vertical ? a0 : q0, y = vertical ? q0 : a0, w = vertical ? a1 - a0 : q1 - q0, h = vertical ? q1 - q0 : a1 - a0;
          return (
            <g key={`add-${j.splitId}-${j.k}-${Math.round(c0)}`} className="yago-band on" style={{ cursor: 'pointer' }}
              onClick={e => { stop(e); onAddPick?.(j.splitId, j.k, isAdditive(e) ? allMids : [(c0 + c1) / 2]); }}>
              <rect x={x} y={y} width={w} height={h} rx={3} fill="#fb923c" fillOpacity={0.16} stroke="#f97316" strokeWidth={1} strokeDasharray="4 2.5"
                className="hit" />
              <Chip className="chip" cx={x + w / 2} cy={y + h / 2} txt={vertical ? '+ Divider' : '+ Shelf'} fs={cfs} tone={CHIP.accent}
                rot={vertical ? -90 : 0} />
              <title>{`Add a ${what} between these two doors${segs.length > 1 ? ` (this part of the joint, ${fmt1(c1 - c0)} mm)` : ''}: `
                + `it is created in the free volume behind this spot (listed after the door row) and stays bound to the joint — when the doors change, `
                + `the ${what} follows.${allMids.length > 1 ? ` Shift+click: a ${what} in every free part of this joint (${allMids.length}).` : ''} `
                + 'It starts at Half overlay (both doors reach its middle); select a door next to it to switch that door to Full.'}</title>
            </g>
          );
        });
      })}
      {selRegions.map(n => <SelOutline key={`sel-${n.id}`} n={n} view={view} shape={cuts.length ? doorCutOutline(group, rect, n, cuts) : null} />)}
      {/* Bant tık alanları bilinçli olarak seçim çerçevesi/şeritlerin ÜSTÜNDE, pill'lerin ALTINDA çizilir. */}
      {bands.map(b => {
        const np = b.np;
        const pickable = !!refPick && !np.edge, rem = removable(np), splitOn = splitChipOn(np);
        const jChip = !np.edge ? jointChip(b) : null;
        const ctxOn = (!np.edge && !!overlayCtx(np)) || splitOn;   // bölünmemiş levha da kapak binisi rozetidir (turuncu)
        const interactive = isOuter && (rem || pickable || (!!np.edge && np.behind) || ctxOn || !!np.joint);
        const chipTxt = rem ? '✕ Remove' : pickable ? 'Split here'
          : np.edge ? (np.behind ? (b.none ? 'None' : b.half ? 'Half' : 'Full') : null) : splitOn ? 'Full' : jChip;
        // Rozet dili arkalıkla aynı (CHIP): rozet HER ZAMAN görünür; Half = koyu taş, kapak seçiliyken turuncu çerçeve.
        const tone = rem ? CHIP.danger : (np.edge ? b.half : jChip === 'Half') ? CHIP.on : pickable || ctxOn ? CHIP.accent : CHIP.base;
        const at = chipTxt ? chips.spot(bandAxis(b), pillSize(chipTxt, cfs).pw) : null;
        return (
          <BandHit key={`hit-${np.vfId}`} gid={gid} pts={b.pts} rect={np.poly ? undefined : b} warm={b.half || b.aligned} title={bandTip(b)}
            onClick={interactive ? e => onBandClick(b, isAdditive(e)) : undefined}
            chip={at && <Chip className="chip" cx={at.x} cy={at.y} txt={chipTxt!} fs={cfs} tone={tone} rot={b.vertical ? -90 : 0} />} />
        );
      })}
      {/* Açılı levhanın Full/Half bayrağı, kesilen kenarın halfOverlay bayrağıdır. */}
      {cutBands.map(cb => {
        const interactive = isOuter && cb.covered && !!cb.edge;
        const chipTxt = interactive ? (cb.half ? 'Half' : 'Full') : null;
        const at = chipTxt ? chips.spot(cutAxis(cb), pillSize(chipTxt, cfs).pw) : null;
        const tip = `${cb.cut.name} — angled door reference panel: the door is cut along it (it keeps the side you clicked when placing the door).` +
          (interactive ? ` ${cb.half ? 'HALF overlay — the door reaches the middle of this panel\'s thickness. Click for full overlay.'
            : 'FULL overlay — the door covers this panel\'s whole thickness. Click for half overlay.'}`
            : cb.covered ? '' : ' It stands in front of the door plane, so there is no overlay to set.');
        return (
          <BandHit key={`cuthit-${cb.cut.vfId}`} gid={gid} pts={cb.pts} warm={cb.half} title={tip}
            onClick={interactive ? () => onToggleHalfOverlay(cb.edge!, !cb.half) : undefined}
            chip={at && <Chip className="chip" cx={at.x} cy={at.y} txt={chipTxt!} fs={cfs} tone={cb.half ? CHIP.on : CHIP.base} rot={cb.deg.toFixed(1)} />} />
        );
      })}
      <ChainPills pills={pills} ed={ed} bounds="door" />
    </SchemFrame>
  );
}

// Arkalık şemasının kenar payı: en dış sınır levhaları (yan / üst / alt) iç dikdörtgenin DIŞINDA, bu payda çizilir; ilişki ve değer
// rozetleri levhanın üzerinde durur → pay levha + rozet kalınlığını almalı (kapak payı 12 px ile rozetler SVG dışına taşıp kırpılıyordu).
const BACK_PAD = 22;
const T0 = 0.05;
type BackSplit = Extract<BackNodeSolved, { kind: 'split' }>;
/** Kenar rozeti: değer rozeti (In / On, yerinde düzenlenir) ya da ilişki rozeti (`toggle`: Groove ↔ Nail / ± kanal payı). */
type BandChip = EditTarget & { key: string; vfId: string; label: string; rot: number; warm: boolean; title: string; toggle?: () => void;
  /** Turuncu çerçeve (kenarın kendi kanal payı var). */
  accent?: boolean };
/** Değerler hep aynıysa o değer, yoksa null. */
const same = (vs: number[]) => (vs.length && vs.every(x => Math.abs(x - vs[0]) < T0) ? vs[0] : null);

// ═════════════════════════════════════════════════ 5. ARKALIK ŞEMASI ═════════════════════════════════════════════════
/** ARKALIK ŞEMASI: ön görünüş (arkadan bakış aynalı), parçalar + sınır levhası bantları (çakma parçada bini, kanallı parçada kanal girişi),
 *  açılı levha şeritleri, derz rozetleri ve seçili bölgenin ölçü zincirleri. Değerler PARÇA BAŞINA: kenar rozeti / pill'i seçili
 *  parçalara (seçim yoksa o kenara değen tüm parçalara) yazar; karışık değer "…" / "Mixed" gösterir. */
export function BackSchematic({
  group, solution, selectedIndex, selectedNodes, memberLabels, cuts, nearPanels, refPick, onEditSize, onToggleLock, onEditSplitGap, onEditInset, onEditJointIn,
  onPathClick, onRefPick, onSplitAtPanel, onEditCover, onToggleEdgeRel, onToggleJointRel, clearVfId, onPickClearEdge, grooveHint, onEditBegin, onEditCancel,
}: {
  group: BackGroup; selectedIndex: number; memberLabels: string[];
  /** Çözüm (solveBackGroup / backFallbackSolution): iç dikdörtgen, hücreler, parça dikdörtgenleri (kendi tip/inset/bini uzantılarıyla). */
  solution: BackSolution;
  selectedNodes: string[];
  cuts: BackCut[];
  nearPanels: BackNearPanel[];
  /** preview=true → canlı önizleme (yalnız store dağılımı, rebuild yok); yoksa onay (yazım + rebuild). */
  onEditSize: (splitId: string, k: number, v: number, preview?: boolean) => void; onToggleLock: (splitId: string, k: number) => void;
  onEditSplitGap: (splitId: string, k: number, v: number, preview?: boolean) => void;
  /** Kanallı parça(lar)ın kenar girişi (mm ≥ 0), leafIds = yazılacak parçalar. */
  onEditInset: (edge: BackEdgeKey, mm: number, leafIds: string[], preview?: boolean) => void;
  /** Levhaya bağlı derzde parça(lar)ın dikme/rafın üzerine binme payı (mm), leafIds = yazılacak parçalar (o kenarı derzde olanlar). */
  onEditJointIn: (edge: BackEdgeKey, mm: number, leafIds: string[], preview?: boolean) => void;
  onEditBegin?: () => unknown; onEditCancel?: (snap: unknown) => void;
  /** Tıklanan noktanın kök → yaprak düğüm yolu (yalnız seçim); additive = Shift/Ctrl/⌘. */
  onPathClick: (path: string[], additive: boolean) => void;
  refPick?: boolean;
  onRefPick?: (vfId: string) => void;
  /** Arkalık-sınırı dikme/raf bandı: tık arkalığı levhanın ortasından böler (Panel ref modunda da aynı). */
  onSplitAtPanel?: (vfId: string) => void;
  /** Çakma parça(lar)ın kenar panelinin üzerine binmesi (mm), leafIds = yazılacak parçalar. */
  onEditCover: (edge: BackEdgeKey, mm: number, leafIds: string[], preview?: boolean) => void;
  /** Kenar ilişkisi (grup başına): Groove ↔ Nail. */
  onToggleEdgeRel: (edge: BackEdgeKey) => void;
  /** Levhaya bağlı derzin ilişkisi: Groove (iki yandan kanal) ↔ Nail (dikme/raf kısalır). */
  onToggleJointRel: (splitId: string, k: number) => void;
  /** Kanal payı kapsamı: seçili kenarın (sınır / derz paneli) VF'si — kartta yalnız onun F/R/D değerleri düzenlenir. */
  clearVfId?: string;
  /** Kenarın "±" rozeti: o kenarın kanal payını kart satırına getirir (tekrar tık → grup). */
  onPickClearEdge: (vfId: string) => void;
  /** Görsel ipucu: kartta kanal payı (ön / arka / dip) değerinin üzerindeyken kanal kutuları vurgulanır (kapsamdaki kenarlar). */
  grooveHint?: 'gf' | 'gb' | 'gd' | null;
}) {
  const [wrapRef, width] = useElementWidth();
  const ed = useSchemEdit(onEditBegin, onEditCancel, group.id, selectedIndex >= 0, selectedNodes.join('|'));
  const { axis, side } = group;
  // rect = İÇ dikdörtgen (sınır panellerinin iç yüzleri); parçalar kendi uzantılarıyla dışına taşar.
  const { rect, solved, members, sides } = solution;
  // TEMSİLİ KARE (Goker, Eki 2026 — "preview tam kare olsun, arkalık o alanı maksimum göstersin, ölçüye göre dinamik değil temsili"):
  // şema kare (yükseklik = genişlik), arkalık dikdörtgeni her zaman aynı temsili alana GERİLİR (oran korunmaz) — kenar bantları
  // ve rozetler dar kenar payında kalır.
  const SW = Math.max(40, width - 2 * BACK_PAD), SH = SW, height = SH + 2 * BACK_PAD;
  // Görünüş: arkalık ÖNDEN çizilir (gövdenin içine bakar gibi) — 3B ön görünüşle aynı sol/sağ (Goker: arkadan aynalı görünüş
  // ters geliyordu, soldaki parçayı düzeltirken sağdaki değişiyordu). Sağ yan (X+) aynalı; üst (Y+) → Z aşağı.
  const view = schemView(rect, BACK_PAD, BACK_PAD, SW, SH, axis === 0 && side > 0, axis === 1 && side > 0, width - 2, height - 2);
  const { sx, sy } = view;
  const fs = schemFs(width), fsT = schemFsT(fs), cfs = chipFs(fsT);
  const gid = svgId('bs', group.id);

  // PARÇA BAŞINA değerler: üye dikdörtgeni kendi `piece`'ini taşır (tip / setback / inset / bini).
  const allLeafIds = members.map(m => m.leafId);
  const pieceOfLeaf = (id: string) => {
    const m = members.find(x => x.leafId === id);
    if (m) return m.piece;
    const n = findBackNode(group.tree, id);
    return backPieceOf(group, n && n.kind === 'leaf' ? n : null);
  };
  const groovedOf = (ids: string[]) => ids.filter(id => pieceOfLeaf(id).placement === 'inner');
  const nailedOf = (ids: string[]) => ids.filter(id => pieceOfLeaf(id).placement === 'outer');
  const anyGrooved = groovedOf(allLeafIds).length > 0;
  const cellTouches = (n: BackNodeSolved, k: BackEdgeKey) =>
    Math.abs(k === 'uMin' ? n.u0 - rect.u0 : k === 'uMax' ? n.u1 - rect.u1 : k === 'vMin' ? n.v0 - rect.v0 : n.v1 - rect.v1) < T0;
  /** Kenara değen yapraklar (hücresi iç dikdörtgenin o kenarında), isteğe bağlı bir alt küme içinde. */
  const touchingLeaves = (k: BackEdgeKey, within: string[] = allLeafIds) =>
    backLeaves(solved).filter(n => within.includes(n.id) && cellTouches(n, k)).map(n => n.id);
  /** Çakma parçaların kenar panelinin üzerine ETKİN binmesi (mm; girilmemişse t = tamamen örter); farklıysa null. */
  const coverOf = (k: BackEdgeKey, id: string, t: number) => {
    const c = pieceOfLeaf(id).cover[k];
    return Number.isFinite(c) ? Math.max(0, Math.min(t, c as number)) : t;
  };
  const commonCover = (k: BackEdgeKey, ids: string[], t: number) => same(ids.map(id => coverOf(k, id, t)));
  const selRegions = selectedNodes.map(id => findSolvedBackNode(solved, id)).filter((n): n is BackNodeSolved => !!n);
  const selLeafIds = new Set(selRegions.flatMap(leafIds));
  /** Kenar rozetinin / pill'inin yazacağı parçalar: seçili bölgelerin (ya da seçili üye satırının) o kenara değen yaprakları;
   *  seçim yoksa kenara değen tüm yapraklar. */
  const scopeLeaves = (k: BackEdgeKey): string[] => {
    const sel = selLeafIds.size ? [...selLeafIds] : selectedIndex >= 0 && members[selectedIndex] ? [members[selectedIndex].leafId] : allLeafIds;
    const t = touchingLeaves(k, sel);
    return t.length ? t : touchingLeaves(k);
  };
  const scopeTxt = (ids: string[]) => (ids.length === 1 ? `piece ${memberLabels[allLeafIds.indexOf(ids[0])] ?? ''}`.trim() : `${ids.length} pieces`);

  // Kenar şeritleri: kanallı parçada KANAL GİRİŞİ (pill), çakma parçada bini Full/Half/None (rozet) — ikisi de parça başına.
  /** Kenar bandı: `na` = bini rozeti yazılacak parçalar (dış çakma parçalar + ÇAKMA kenardaki iç parçalar), `gr` = kanallı
   *  kenardaki iç parçalar (giriş pill'i), `nl` = çakma kenardaki iç parçalar (panel kısaltılır), `rel` = kenar ilişkisi (grup başına). */
  const bands = nearPanels.map(np => {
    const scope = np.edge ? scopeLeaves(np.edge) : [];
    const rel: BackEdgeRel | null = np.edge ? edgeRelOf(group, np.edge) : null;
    const inner = np.edge ? groovedOf(scope) : [];
    const gr = rel === 'groove' ? inner : [], nl = rel === 'nail' ? inner : [];
    const na = [...(np.edge && np.behind ? nailedOf(scope) : []), ...nl];
    const t = Math.max(0, np.a1 - np.a0);   // kenar levhasının kalınlığı (bant ekseninde)
    const cov = np.edge && na.length ? commonCover(np.edge, na, t) : null;
    const ins = np.edge && gr.length ? same(gr.map(id => pieceOfLeaf(id).inset[np.edge!])) : null;
    const half = nl.length > 0 || (na.length > 0 && (cov == null || cov < t - T0));   // kısaltılan panel / kısmi binme → sıcak ton
    return { np, ...bandGeom(np, view), half, na, gr, nl, rel, cov, t, ins };
  });
  type Band = typeof bands[number];
  const cutBands = backCutBands(group, rect, cuts, view.areaMm, cutMinMm(view)).map(cb => {
    const na = cb.edge && cb.covered ? nailedOf(scopeLeaves(cb.edge)) : [];
    const t = Math.max(0, cb.cut.dMax - cb.cut.dMin);
    const cov = na.length ? commonCover(cb.edge!, na, t) : null;
    return { ...cb, ...cutBandGeom(cb, view), half: na.length > 0 && (cov == null || cov < t - T0), na, t, cov };
  });
  // Eğik kenarın boşluk pill'i eğik kenarın üzerinde durur; düz kenar zincirlerinde o kenar GÖSTERİLMEZ.
  const slopeSegs = slopeSegsOf(cutBands, members);
  const edgeName = (b: Band) => edgeLabel(b.vertical, b.np.edge, view);
  // İÇ LEVHA (arkalık-sınırı dikme/raf) tek eylemlidir: BÖL. Bini / Left-Right rozeti yok (Goker, Eki 2026): bütün kanallı arkalık
  // levhayı kısaltır; bölününce parçalar levhanın ortasına kadar girer (iki yandan kanallı) ve derz levhayı izler.
  const splittable = (np: BackNearPanel) => !!onSplitAtPanel && !np.edge && !np.joint && canSplitBackAtPanel(group, np);
  /** Levhaya bağlı derz bandı: iki yanın binme değerleri (ekranda sol/üst → sağ/alt), karışıksa "…". */
  const refJoint = (np: BackNearPanel) => {
    if (!np.ref) return null;
    const all = Object.values(sides).flatMap(r => (Object.entries(r) as Array<[BackEdgeKey, NonNullable<typeof r[BackEdgeKey]>]>).map(([key, x]) => ({ key, x })))
      .filter(e => e.x.splitId === np.ref!.splitId && e.x.k === np.ref!.k);
    if (!all.length) return null;
    const val = (keys: BackEdgeKey[]) => {
      const vs = all.filter(e => keys.includes(e.key)).map(e => e.x.in), c = same(vs);
      return !vs.length ? '–' : c == null ? '…' : fmt1(c);
    };
    const lo = val(['uMax', 'vMin']), hi = val(['uMin', 'vMax']);   // lo = derzden önceki (sol / üst) parça(lar), hi = sonraki
    return { txt: (np.kind === 'u' ? view.mirrorU : view.mirrorV) ? `${hi} · ${lo}` : `${lo} · ${hi}` };
  };
  const bandTip = (b: Band) => {
    const np = b.np;
    if (np.edge) {
      const parts: string[] = [];
      if (b.gr.length || b.nl.length) parts.push(b.rel === 'nail'
        ? 'NAIL — this panel is shortened to the back panel\'s front face and the piece covers its end '
          + '(click "Nail" to switch to a groove: the panel keeps its full depth).'
        : 'GROOVE — this panel keeps its full depth and the piece enters its groove '
          + '(click "Groove" to nail instead: the panel is shortened to the back panel\'s front face automatically).');
      if (b.gr.length) {
        parts.push(`GROOVE DEPTH ${b.ins == null ? 'mixed' : `${fmt1(b.ins)} mm`} (${scopeTxt(b.gr)}) — how far the grooved piece enters this panel; `
          + 'click the value to edit (0 = ends at the panel\'s inner face).');
      }
      if (b.na.length) {
        parts.push(`OVERLAP ${b.cov == null ? 'mixed' : `${fmt1(b.cov)} mm`} of ${fmt1(b.t)} (${scopeTxt(b.na)}) — `
          + `how far the piece runs onto this panel's end: 0 = ends at its inner face, ${fmt1(b.t)} = covers it fully. Click the value to edit.`);
      }
      if (!parts.length) {
        parts.push(np.behind ? 'no piece touches this edge.' : 'stands outside the back panel plane; nailed pieces end beside it (no overlay possible).');
      }
      return `${edgeName(b)} — ${np.name}: ${parts.join(' ')} Select a piece to change only that piece.`;
    }
    const what = b.vertical ? 'divider' : 'shelf';
    const whole = anyGrooved ? `While the back panel is whole and grooved, this ${what} is shortened to the back panel's front face.`
      : `While the back panel is whole, it passes behind this ${what}.`;
    if (np.ref) {
      const rel = backJointRelOf(group.tree, np.ref.splitId, np.ref.k) === 'nail' ? `NAIL: the ${what} is shortened to the back panel's front face`
        : `GROOVE: both sides grooved, the ${what} keeps its full depth`;
      return `${np.name} (${what}) — the back panel is split at this ${what} (${rel} — switch with the Groove / Nail chip); `
        + `each piece runs onto it by its own overlap (${refJoint(np)?.txt ?? '–'} mm, default: to its middle) and follows it when it moves. `
        + `Click to select the split region and edit the overlap pills (0 = ends at the ${what}'s face, its thickness = covers it fully). `
        + `Sizes next to this joint come from the ${what}.`;
    }
    if (np.joint) {
      return `${np.name} (${what}) — a joint of the back panel already lies at this ${what} (from a count split); `
        + `it is not bound to it, so the pieces stay when the ${what} moves.`;
    }
    if (refPick || splittable(np)) {
      return `${np.name} (${what}) — back reference: click to split the back panel through its middle `
        + `(both pieces reach the middle${anyGrooved ? ', grooved pieces on both sides' : ''}; the ${what} keeps its full depth). ${whole}`;
    }
    return `${np.name} (${what}) — back reference, cannot be split here (no room for two pieces). ${whole}`;
  };
  const editChip = (c: BandChip | undefined) => { if (c) ed.begin({ key: c.key, v: c.item.txt }); return !!c; };
  const onBandClick = (b: Band) => {
    const np = b.np;
    if (refPick) { if (!np.edge && onRefPick) onRefPick(np.vfId); return; }
    // Kenar bandı: değer rozeti (çakma "On", yoksa kanallı "In") düzenlemeye açılır (ilişki rozeti kendi tıkıyla çevrilir).
    if (np.edge) { editChip(bandChips.find(x => x.vfId === np.vfId && !x.toggle)); return; }
    // Bağlı derz: bölme bölgesi seçilir (binme pill'leri görünür); zaten görünüyorsa ilki düzenlenir.
    if (np.ref) {
      const pre = `bc-jin-${np.vfId}-${np.ref.splitId}-${np.ref.k}-`;
      if (!editChip(bandChips.find(x => x.key.startsWith(pre)))) onPathClick(nodePath(solved, np.ref.splitId), false);
      return;
    }
    if (splittable(np)) onSplitAtPanel!(np.vfId);
  };

  // KENAR / DERZ BİNME DEĞERLERİ ölçü zincirinde GÖSTERİLMEZ (Goker, Eki 2026 — "arkalığa tıklayınca In / On yanında bir de kanal
  // derinlik kutucukları geliyor, iki tane binme değeri görünüyor"): bunlar yalnız bandın In / On rozetlerinde; zincir = parça ölçüleri + aralar.
  const kit = chainKit(view, r => backCutOutline(group, rect, r, cuts));
  const sizeItem = (P: BackSplit, i: number, a: number, b: number, horiz: boolean): ChainItem => {
    const base = { key: `size-${P.id}-${i}`, kind: 'size' as const, a, b, txt: fmt1(P.sizes[i]?.value ?? 0), min: 1 };
    const what = horiz ? 'Piece width' : 'Piece height';
    // Levhaya bağlı derze bitişik ölçü levhadan gelir (derz levhayı izler) — girilemez.
    if (backSizeBoundByJoint(P, i)) {
      return { ...base, passive: true, title: `${what} — set by the divider / shelf the joint is bound to (move that panel to change it)`, commit: () => {} };
    }
    // Bölmede tek AÇIK ölçü kaldıysa PASİF (pin de kilit sayılır): girilemez, rozetsiz — değeri kalandan gelir.
    if (passiveBackSizeIndex(P.sizes, P.children.length) === i) {
      return { ...base, passive: true, title: `${what} — remainder (all other pieces pinned or locked); open one to edit`, commit: () => {} };
    }
    const mode = backSizeMode(P.sizes[i]);
    const lockTitle = mode === 'locked' ? 'Locked — fixed on resize and when other pieces are edited. Click: open'
      : mode === 'hold' ? 'Hold — keeps its value when other pieces are edited, still scales with the back panel on resize. Click: lock'
      : 'Open — takes up changes from other pieces and scales with the back panel on resize. Click: hold';
    return { ...base, title: `${what} — click to edit (open pieces take up the difference)`, locked: mode === 'locked', edited: mode === 'hold', lockTitle,
      onLock: () => onToggleLock(P.id, i), commit: x => onEditSize(P.id, i, x), preview: x => onEditSize(P.id, i, x, true) };
  };
  const fullItems = (ax: 'u' | 'v'): ChainItem[] => {
    const horiz = ax === 'u', lo = horiz ? rect.u0 : rect.v1, span = horiz ? rect.u1 - rect.u0 : rect.v1 - rect.v0;
    return [{ key: `full-${ax}`, kind: 'size', a: lo, b: lo + (horiz ? 1 : -1) * span, txt: fmt1(span), commit: () => {}, min: 1,
      title: `Back area ${horiz ? 'width' : 'height'} (between the reference panels' inner faces)` }];
  };
  // LEVHAYA BAĞLI DERZ: zincirde ara yok (binme değerleri derz bandındaki On / In rozetlerinde).
  const isBoundJoint = (P: BackSplit, k: number) =>
    !!P.refs?.[k] && Object.values(sides).some(r => Object.values(r).some(x => !!x && x.splitId === P.id && x.k === k));
  const parts = { size: sizeItem, full: fullItems, gapTitle: 'Gap between pieces — click to edit', onGap: onEditSplitGap, hideGap: isBoundJoint };
  for (const n of selRegions) regionChains(kit, solved, n, parts);

  // Eğik kenar giriş pill'i: yalnız SEÇİLİ KANALLI parçaların en uzun eğik kenarının ortasında, kenar yönünde döndürülmüş
  // (çakmada rozet var).
  const slopePills = slopeSegs.flatMap(sg => {
    const best = longestEdgeAlong(members, sg.cb.dir, m => selLeafIds.has(m.leafId) && m.piece.placement === 'inner');
    if (!best) return [];
    const { m } = best, ins = m.piece.inset[sg.edge];
    const item: ChainItem = { key: `slope-${sg.cb.cut.vfId}-${m.leafId}`, kind: 'gap', a: 0, b: 0, txt: fmt1(ins),
      title: `Groove inset into the angled panel ${sg.cb.cut.name} (${scopeTxt([m.leafId])}) — `
        + 'click to edit (the piece enters the panel by this much along the slope)',
      commit: x => onEditInset(sg.edge, x, [m.leafId]), preview: x => onEditInset(sg.edge, x, [m.leafId], true), min: 0 };
    return [slopePill(best, view, fs, item, (ins * view.SH / view.dvR) / 2)];
  });
  const pills = layoutPills(kit.chains, view, fs, slopePills, width, height);
  const chips = chipPlacer(pills, members, view, fsT);

  // KENAR DEĞER ROZETLERİ (bant üzerinde, tıklayınca yerinde düzenlenir): çakma parça → "On <mm>" = panelin üzerine binme,
  // kanallı parça → "In <mm>" = kanal derinliği. Değer seçili parçalara (yoksa kenara değen tüm parçalara) yazılır.
  const bandChips: BandChip[] = [];
  const placeChip = (c: Omit<BandChip, 'cx' | 'cy' | 'pw' | 'ph' | 'f' | 'item'> & { item?: ChainItem }, ax: ChipAxis) => {
    const { pw, ph } = pillSize(c.label, cfs);
    const sp0 = chips.spot(ax, pw);
    // Rozet SVG'nin içinde kalır (döndürülmüşse kapladığı kutu yer değiştirir): kenarda kırpılmasın.
    const rad = (c.rot || 0) * Math.PI / 180, cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const hx = (cos * pw + sin * ph) / 2 + 2, hy = (sin * pw + cos * ph) / 2 + 2;
    const sp = { x: Math.max(hx, Math.min(width - hx, sp0.x)), y: Math.max(hy, Math.min(height - hy, sp0.y)) };
    bandChips.push({ ...c, item: c.item ?? valItem(c.key, null), cx: sp.x, cy: sp.y, pw, ph, f: cfs });
    chips.obstacles.push({ x: sp.x, y: sp.y, r: Math.max(pw, ph) / 2 });
  };
  const valItem = (key: string, v: number | null, edit?: (x: number, preview?: boolean) => void): ChainItem =>
    ({ key, kind: 'gap', a: 0, b: 0, txt: v == null ? '' : fmt1(v), title: '', commit: x => edit?.(x), preview: x => edit?.(x, true), min: 0 });
  const rot = (b: Band) => (b.vertical ? -90 : 0);
  // KANAL PAYI rozeti ("±"): kanallı kenarın / derzin kanal bollaştırmasını kart satırına getirir. Seçili → koyu; kendi değeri var → turuncu.
  const clearChip = (b: Band) => {
    const vfId = b.np.vfId, on = clearVfId === vfId, own = backGrooveClearOverridden(group, vfId), c = backGrooveClearOf(group, vfId);
    placeChip({ key: `bc-clr-${vfId}`, vfId, label: '±', rot: 0, warm: on, accent: own && !on, toggle: () => onPickClearEdge(vfId),
      title: `${b.np.name} — groove clearance ${own ? '(own values)' : '(group values)'}: F ${fmt1(c.front)} · R ${fmt1(c.back)} · D ${fmt1(c.depth)} mm. `
        + `Click to edit only this panel's groove clearance in the card row${on ? ' (click again: back to the whole group)' : ''}.` },
      bandAxis(b));
  };
  if (!refPick) {
    for (const b of bands) {
      const k = b.np.edge, vfId = b.np.vfId, ax = bandAxis(b);
      // BAĞLI DERZ (dikme/rafta bölünmüş): ilişki rozeti Groove ↔ Nail; binme değerleri derz pill'lerinde / rozetinde.
      if (!k && b.np.ref && refJoint(b.np)) {
        const { splitId, k: jk } = b.np.ref;
        const rel = backJointRelOf(group.tree, splitId, jk), nail = rel === 'nail';
        const what = b.vertical ? 'divider' : 'shelf';
        placeChip({ key: `bc-jrel-${vfId}-${splitId}-${jk}`, vfId, label: BACK_REL_LABEL[rel], rot: rot(b), warm: nail,
          toggle: () => onToggleJointRel(splitId, jk), title: `${b.np.name} (${what}) — the back panel is split here. ` + (nail
            ? `NAILED — the ${what} is shortened to the back panel's front face and both pieces cover its end by their overlap. `
              + `Click to switch to Groove (the ${what} keeps its full depth, both pieces enter it from both sides).`
            : `GROOVED on both sides — the ${what} keeps its full depth and both pieces enter it by their overlap. `
              + `Click to switch to Nail (the ${what} is shortened to the back panel's front face automatically; the pieces cover its end).`) }, ax);
        // BİNME rozetleri (her yan ayrı, doğrudan düzenlenir): Nail → "On" = parçanın levha ucunun üzerine binmesi,
        // Groove → "In" = levhaya giriş. Rozet o yanın parçasına doğru kaydırılır (hangi yan olduğu görünsün).
        for (const which of ['before', 'after'] as const) {
          const ek: BackEdgeKey = b.vertical ? (which === 'before' ? 'uMax' : 'uMin') : (which === 'before' ? 'vMin' : 'vMax');
          const ids = allLeafIds.filter(id => { const x = sides[id]?.[ek]; return !!x && x.splitId === splitId && x.k === jk; });
          if (!ids.length) continue;
          const ss = ids.map(id => sides[id]![ek]!), common = same(ss.map(x => x.in)), t = ss[0].t;
          const m0 = members.find(mm => mm.leafId === ids[0]);
          const pcx = m0 ? (sx(m0.u0) + sx(m0.u1)) / 2 : b.x, pcy = m0 ? (sy(m0.v0) + sy(m0.v1)) / 2 : b.y;
          const dir = b.vertical ? Math.sign(pcx - ax.cx) || 1 : Math.sign(pcy - ax.cy) || 1;
          const label = `${nail ? 'On' : 'In'} ${common == null ? '…' : fmt1(common)}`;
          const off = (b.vertical ? b.w : b.h) / 2 + pillSize(label, cfs).ph / 2 + 2;
          const key = `bc-jin-${vfId}-${splitId}-${jk}-${which}`;
          placeChip({ key, vfId, label, rot: rot(b), warm: nail, item: valItem(key, common, (x, pv) => onEditJointIn(ek, x, ids, pv)),
            title: `${b.np.name} (${what}) — ${nail ? `how far the piece runs onto the ${what}'s end` : `how far the piece enters the ${what}`} on this side `
              + `(${scopeTxt(ids)}): ${common == null ? 'pieces differ' : `${fmt1(common)} mm`} of ${fmt1(t)} `
              + `(0 = ends at its face, ${fmt1(t)} = covers it fully; default: to its middle). Click to type.` },
            { ...ax, cx: ax.cx + (b.vertical ? dir * off : 0), cy: ax.cy + (b.vertical ? 0 : dir * off) });
        }
        if (!nail) clearChip(b);
      }
      if (!k) continue;
      // KENAR İLİŞKİSİ rozeti (grup başına): kenarda iç (kanallı tip) parça varsa Groove ↔ Nail.
      if (b.rel && (b.gr.length || b.nl.length) && b.t > 0) {
        placeChip({ key: `bc-rel-${vfId}`, vfId, label: BACK_REL_LABEL[b.rel], rot: rot(b), warm: b.rel === 'nail', toggle: () => onToggleEdgeRel(k),
          title: `${edgeName(b)} — ${b.np.name}: ${b.rel === 'nail'
            ? 'NAILED edge — the panel is shortened to the back panel\'s front face and the piece covers its end by the overlap. '
              + 'Click to switch to Groove (the panel keeps its full depth, the piece enters its groove).'
            : 'GROOVED edge — the panel keeps its full depth and the piece enters its groove by the groove depth. '
              + 'Click to switch to Nail (the panel is shortened to the back panel\'s front face automatically; the piece covers its end).'}` }, ax);
      }
      if (b.na.length) {
        const ids = b.na, key = `bc-on-${vfId}`;
        placeChip({ key, vfId, label: `On ${b.cov == null ? '…' : fmt1(b.cov)}`, rot: rot(b), warm: b.half,
          item: valItem(key, b.cov, (x, pv) => onEditCover(k, x, ids, pv)),
          title: `${edgeName(b)} — ${b.np.name}: nailed piece overlap ${b.cov == null ? '(pieces differ)' : `${fmt1(b.cov)} mm`} of ${fmt1(b.t)} `
            + `(${scopeTxt(ids)}). `
            + `Click to type the overlap (0 = ends at the panel's inner face, ${fmt1(b.t)} = covers it fully).` }, ax);
      }
      if (b.gr.length) {
        const ids = b.gr, key = `bc-in-${vfId}`;
        placeChip({ key, vfId, label: `In ${b.ins == null ? '…' : fmt1(b.ins)}`, rot: rot(b), warm: false,
          item: valItem(key, b.ins, (x, pv) => onEditInset(k, x, ids, pv)),
          title: `${edgeName(b)} — ${b.np.name}: groove depth ${b.ins == null ? '(pieces differ)' : `${fmt1(b.ins)} mm`} (${scopeTxt(ids)}). `
            + 'Click to type how far the grooved piece enters the panel (0 = ends at its inner face).' }, ax);
        clearChip(b);
      }
    }
    for (const cb of cutBands) {
      if (!cb.edge || !cb.na.length) continue;
      const k = cb.edge, ids = cb.na, key = `bc-on-${cb.cut.vfId}`;
      placeChip({ key, vfId: cb.cut.vfId, label: `On ${cb.cov == null ? '…' : fmt1(cb.cov)}`, rot: cb.deg, warm: cb.half,
        item: valItem(key, cb.cov, (x, pv) => onEditCover(k, x, ids, pv)),
        title: `${cb.cut.name} — angled panel: nailed piece overlap ${cb.cov == null ? '(pieces differ)' : `${fmt1(cb.cov)} mm`} of ${fmt1(cb.t)} `
          + `(${scopeTxt(ids)}), measured across the panel. Click to type the overlap.` }, cutAxis(cb));
    }
  }
  const editables = new Map<string, EditTarget>([...pills.map(p => [p.key, p] as const), ...bandChips.filter(c => !c.toggle).map(c => [c.key, c] as const)]);

  // GİRİŞ BÖLGELERİ (Goker, Eki 2026 — "arkalığın panelin içine girdiğini daha belirgin göster"): parça ∩ sınır levhası şeridi.
  // groove = parça panelin kanalına giriyor (turuncu, kanal dibi koyu çizgi); nail = parça panelin ucunu örtüyor (taş rengi).
  // Her zaman çizilir (seçim gerekmez); çok ince bölge en az 3 px gösterilir (panelin iç yüzünden dışa doğru).
  type Zone = { key: string; x: number; y: number; w: number; h: number; kind: 'groove' | 'nail'; vertical: boolean; deepX: number; deepY: number;
    /** Kanal (bollaştırılmış) kutusu: parça bölgesi + kanal dibi payı (D), panelin iç yüzü sabit. */
    groove?: { x: number; y: number; w: number; h: number };
    /** Kanal payı bu kenar için düzenleniyor (kart satırı): belirgin çerçeve. */
    active?: boolean; vfId: string };
  const zones: Zone[] = [];
  const pxU = SW / view.duR, pxV = SH / view.dvR;   // mm → px
  for (const np of nearPanels) {
    if (np.poly || (!np.edge && !np.ref)) continue;
    const rel: BackEdgeRel = np.edge ? edgeRelOf(group, np.edge) : backJointRelOf(group.tree, np.ref!.splitId, np.ref!.k);
    for (const m of members) {
      const isU = np.kind === 'u';
      const ma0 = isU ? m.u0 : m.v0, ma1 = isU ? m.u1 : m.v1, mc0 = isU ? m.v0 : m.u0, mc1 = isU ? m.v1 : m.u1;
      const a0 = Math.max(ma0, np.a0), a1 = Math.min(ma1, np.a1), c0 = Math.max(mc0, np.c0), c1 = Math.min(mc1, np.c1);
      if (a1 - a0 < 0.05 || c1 - c0 < 1) continue;
      const kind: 'groove' | 'nail' = m.piece.placement === 'outer' || rel === 'nail' ? 'nail' : 'groove';
      // Kanal dibi = parçanın panel içindeki ucu (panelin iç yüzünden uzak taraf).
      const deepAtMax = (ma0 + ma1) / 2 < (np.a0 + np.a1) / 2;   // parça panelin min tarafında → kanal dibi bölgenin max ucu
      const deep = deepAtMax ? a1 : a0;
      let x0 = isU ? Math.min(sx(a0), sx(a1)) : Math.min(sx(c0), sx(c1)), x1 = isU ? Math.max(sx(a0), sx(a1)) : Math.max(sx(c0), sx(c1));
      let y0 = isU ? Math.min(sy(c0), sy(c1)) : Math.min(sy(a0), sy(a1)), y1 = isU ? Math.max(sy(c0), sy(c1)) : Math.max(sy(a0), sy(a1));
      const MINZ = 3;
      // Çok ince bölge: kanal dibi yönüne doğru en az MINZ px (panelin iç yüzü sabit kalır).
      if (isU && x1 - x0 < MINZ) { if (Math.abs(sx(deep) - x0) < Math.abs(sx(deep) - x1)) x0 = x1 - MINZ; else x1 = x0 + MINZ; }
      if (!isU && y1 - y0 < MINZ) { if (Math.abs(sy(deep) - y0) < Math.abs(sy(deep) - y1)) y0 = y1 - MINZ; else y1 = y0 + MINZ; }
      const deepX = isU ? (Math.abs(sx(deep) - x0) < Math.abs(sx(deep) - x1) ? x0 : x1) : 0;
      const deepY = isU ? 0 : (Math.abs(sy(deep) - y0) < Math.abs(sy(deep) - y1) ? y0 : y1);
      // Kanal kutusu: dip payı (D) kanal dibi yönünde eklenir; kanal genişliği (F/B) derinlik ekseninde olduğundan ön görünüşte yok.
      let grooveBox: Zone['groove'];
      if (kind === 'groove') {
        const dpx = backGrooveClearOf(group, np.vfId).depth * (isU ? pxU : pxV);
        grooveBox = isU
          ? (deepX === x0 ? { x: x0 - dpx, y: y0, w: x1 - x0 + dpx, h: y1 - y0 } : { x: x0, y: y0, w: x1 - x0 + dpx, h: y1 - y0 })
          : (deepY === y0 ? { x: x0, y: y0 - dpx, w: x1 - x0, h: y1 - y0 + dpx } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 + dpx });
      }
      zones.push({ key: `z-${np.vfId}-${m.leafId}`, x: x0, y: y0, w: x1 - x0, h: y1 - y0, kind, vertical: isU, deepX, deepY, groove: grooveBox,
        active: clearVfId === np.vfId, vfId: np.vfId });
    }
  }
  const stripClip = cuts.length ? backCutOutline(group, rect, rect, cuts).map(view.toPx) : null;

  return (
    <SchemFrame wrapRef={wrapRef} width={width} height={height} gid={gid} view={view} overlay={<ChainEditInput ed={ed} find={k => editables.get(k)} />}>
      {bands.map(b => <BandFill key={`band-${b.np.vfId}`} gid={gid} pts={b.pts} warm={b.half || b.aligned} />)}
      {cutBands.map(cb => <BandFill key={`cut-${cb.cut.vfId}`} gid={gid} pts={cb.pts} warm={cb.half} />)}
      {members.map((m, i) => {
        const lbl = memberLabels[i] ?? String(i + 1), path = nodePath(solved, m.leafId), caption = BACK_TYPE_LABEL[m.piece.placement];
        return (
          // Seçili parça (satır ya da şema) belirgin vurgulanır.
          <MemberCell key={`part-${i}`} m={m} view={view} gid={gid} on={i === selectedIndex || selectedNodes.includes(m.leafId)} inSel={selLeafIds.has(m.leafId)}
            lbl={lbl} fsT={fsT} pills={pills} caption={caption} onPick={add => onPathClick(path, add)}
            tip={memberTip(`Back ${lbl} · ${caption}${m.piece.placement === 'inner' ? ` · setback ${fmt1(m.piece.setback)}` : ''}`, m, path.length,
              'with a piece selected, Type / Setback / edge values apply to that piece only')} />
        );
      })}
      {cutBands.map(cb => <HiddenParts key={`cuthid-${cb.cut.vfId}`} gid={gid} pts={cb.pts} warm={cb.half} members={members} view={view} />)}
      {bands.map(b => <HiddenParts key={`hid-${b.np.vfId}`} gid={gid} pts={b.pts} warm={b.half || b.aligned} members={members} view={view} />)}
      {zones.map(z => {
        const groove = z.kind === 'groove';
        const fill = groove ? '#fb923c' : '#78716c', line = groove ? '#c2410c' : '#44403c';
        const gb = z.groove;
        // Kanal dibi çizgisi: kanal kutusunun (parça + D payı) dip kenarı.
        const bx = gb ? (z.vertical ? (z.deepX === z.x ? gb.x : gb.x + gb.w) : 0) : z.deepX;
        const by = gb ? (z.vertical ? 0 : (z.deepY === z.y ? gb.y : gb.y + gb.h)) : z.deepY;
        return (
          <g key={z.key} style={{ pointerEvents: 'none' }}>
            {gb && <rect x={gb.x} y={gb.y} width={Math.max(0.5, gb.w)} height={Math.max(0.5, gb.h)} fill="#fff7ed" fillOpacity={0.95} stroke={line}
              strokeOpacity={0.5} strokeWidth={0.6} strokeDasharray="2 1.5" />}
            {z.active && gb && <rect x={gb.x - 2} y={gb.y - 2} width={gb.w + 4} height={gb.h + 4} rx={2} fill="none" stroke="#ea580c" strokeWidth={1.4} />}
            {/* Görsel ipucu: kartta kanal payının üzerindeyken kapsamdaki kanallar yanıp söner gibi belirginleşir. */}
            {grooveHint && gb && (!clearVfId || clearVfId === z.vfId) && (
              <rect x={gb.x - 3} y={gb.y - 3} width={gb.w + 6} height={gb.h + 6} rx={3} fill="#f97316" fillOpacity={0.18} stroke="#ea580c" strokeWidth={1.6}
                className="yago-hint-pulse" />
            )}
            <rect x={z.x} y={z.y} width={Math.max(0.5, z.w)} height={Math.max(0.5, z.h)} fill={fill} fillOpacity={groove ? 0.62 : 0.42} />
            <rect x={z.x} y={z.y} width={Math.max(0.5, z.w)} height={Math.max(0.5, z.h)} fill="none" stroke={line} strokeOpacity={0.55} strokeWidth={0.6} />
            {/* Kanal dibi / örtme ucu: kalın net çizgi */}
            {z.vertical
              ? <line x1={bx} y1={gb ? gb.y : z.y} x2={bx} y2={(gb ? gb.y + gb.h : z.y + z.h)} stroke={line} strokeWidth={1.6} strokeLinecap="round" />
              : <line x1={gb ? gb.x : z.x} y1={by} x2={(gb ? gb.x + gb.w : z.x + z.w)} y2={by} stroke={line} strokeWidth={1.6} strokeLinecap="round" />}
          </g>
        );
      })}
      <FocusStrips strips={kit.strips} clip={stripClip} />
      {selRegions.map(n => <SelOutline key={`sel-${n.id}`} n={n} view={view} shape={cuts.length ? backCutOutline(group, rect, n, cuts) : null} />)}
      {/* Bant tık alanları bilinçli olarak seçim çerçevesi/şeritlerin ÜSTÜNDE, pill'lerin ALTINDA çizilir. Kenar bandının değer rozetleri
          ayrı çizilir (bandChips); burada yalnız bölme rozeti. */}
      {bands.map(b => {
        const np = b.np;
        const pickable = !!refPick && !np.edge, splitOn = !pickable && splittable(np);
        const interactive = pickable || splitOn || (!pickable && !np.edge && !!refJoint(np)) || (!!np.edge && (b.na.length > 0 || b.gr.length > 0));
        const at = pickable || splitOn ? chips.spot(bandAxis(b), pillSize('Split here', cfs).pw) : null;
        return (
          <BandHit key={`hit-${np.vfId}`} gid={gid} pts={b.pts} rect={np.poly ? undefined : b} warm={b.half || b.aligned} title={bandTip(b)}
            onClick={interactive ? () => onBandClick(b) : undefined}
            chip={at && <Chip className="chip" cx={at.x} cy={at.y} txt="Split here" fs={cfs} tone={CHIP.accent} rot={rot(b)} />} />
        );
      })}
      {/* Açılı levhanın rozeti: kesilen kenara değen ÇAKMA parçaların binisi (kanallı parçada eğik kenar pill'i var). */}
      {cutBands.map(cb => {
        const chip = bandChips.find(c => c.vfId === cb.cut.vfId);
        const tip = `${cb.cut.name} — angled back-reference panel: the back panel is cut along it (it keeps the side you clicked when placing).` +
          (chip ? ` Nailed overlap ${cb.cov == null ? '(pieces differ)' : `${fmt1(cb.cov)} mm`} of ${fmt1(cb.t)} (${scopeTxt(cb.na)}) — click to edit.`
            : cb.covered ? ' Grooved pieces: edit the inset pill on the slanted edge of a selected piece.'
            : ' It stands outside the back panel plane, so there is no overlay to set.');
        return <BandHit key={`cuthit-${cb.cut.vfId}`} gid={gid} pts={cb.pts} warm={cb.half} title={tip} onClick={chip ? () => editChip(chip) : undefined} />;
      })}
      {/* Kenar değer rozetleri: "On <mm>" (çakma binme) / "In <mm>" (kanal derinliği) — tık yerinde düzenler. İlişki rozeti (Groove / Nail):
          dolu koyu taş = Nail (panel kısaltılır), açık = Groove; tık çevirir. */}
      {bandChips.map(c => {
        const tone = c.toggle && c.warm ? CHIP.on : c.warm || c.accent ? CHIP.accent : CHIP.base;
        return (
          <g key={c.key} className="yago-band pnl on" style={{ cursor: 'pointer' }} onClick={e => { stop(e); if (c.toggle) c.toggle(); else editChip(c); }}>
            <g className="chip" transform={c.rot ? `rotate(${c.rot.toFixed(1)} ${c.cx} ${c.cy})` : undefined}>
              <rect x={c.cx - c.pw / 2} y={c.cy - c.ph / 2} width={c.pw} height={c.ph} rx={c.ph / 2} fill={tone.fill} stroke={tone.stroke} strokeWidth={0.9}
                style={{ filter: CHIP_SHADOW }} />
              {ed.editing?.key !== c.key && (
                <text x={c.cx} y={c.cy + c.f * 0.36} textAnchor="middle" fontSize={c.f} fontWeight={700} letterSpacing="0.02em" fill={tone.text}
                  fontFamily={UI_FONT} style={{ fontVariantNumeric: 'tabular-nums' }}>{c.label}</text>
              )}
            </g>
            <title>{c.title}</title>
          </g>
        );
      })}
      <ChainPills pills={pills} ed={ed} bounds="back panel" />
    </SchemFrame>
  );
}
