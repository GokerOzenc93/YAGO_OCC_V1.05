import React, { useState } from 'react';
import { type BackPlacement, type CornerKey, type DoorType, type JoinPass, type QuickBodyBase, type QuickBodyConfig, type Shape } from '../../store';
import { UI_FONT } from '../Ui';
import { effectiveBodyGeometry, localBboxOf, round1 } from '../Geometry';
import { effectiveJoins, legSpots, panelOrderFor } from '../QuickBodyService';
import { DOOR_TYPES, DOOR_TYPE_LABEL, DOOR_TYPE_TITLE } from '../DoorService';
import { BACK_TYPE_LABEL } from '../BackService';
import {
  ApplyBtn, CELL_LABEL, DOCK_ROW, DOCK_STRIP, DockStatus, ExitBtn, FIELD_INPUT, PASSIVE_INPUT, type Pt, READ_CELL, SECTION_LABEL, SectionHead,
  type SegItem, Segmented, dockAxisTag, fmt1, parseNum, stop, useDraft,
} from './kit';

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

type Kids = { children: React.ReactNode };
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
export function DoorTypeBar({ value, hint, onPick }: { value: DoorType | null; hint: string; onPick: (t: DoorType) => void }) {
  return (
    <div className="flex items-stretch gap-1.5 mb-1"
      title="Door type — applies to the doors selected in the schematic (click a door; Shift/Ctrl+click adds more; none selected = all doors). The selection clears once a type is applied.">
      <div className="flex-1 min-w-0" style={{
        display: 'grid', gridTemplateColumns: `repeat(${DOOR_TYPES.length}, minmax(0,1fr))`, gap: 2, padding: 2, borderRadius: 9, background: '#f3efe8',
        border: '1px solid #e9e4dc', fontFamily: UI_FONT,
      }}>
        {DOOR_TYPES.map(t => {
          const on = value === t;
          return (
            <button key={t} type="button" title={DOOR_TYPE_TITLE[t]} onClick={e => { stop(e); onPick(t); }}
              className={on ? '' : 'hover:!bg-white hover:!text-stone-800'} style={{
                height: 34, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, padding: '0 2px',
                borderRadius: 7, border: 'none', outline: 'none', cursor: 'pointer', background: on ? '#44403c' : 'transparent',
                color: on ? '#ffffff' : '#57534e', boxShadow: on ? '0 1px 2px rgba(40,30,20,0.25)' : 'none', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.01em', lineHeight: 1, transition: 'background 0.12s,color 0.12s',
              }}>
              <DoorTypeIcon type={t} size={13} />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{DOOR_TYPE_LABEL[t]}</span>
            </button>
          );
        })}
      </div>
      <div className="shrink-0 flex flex-col items-end justify-center" style={{ minWidth: 46 }}>
        <span className="text-[9px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]">Type</span>
        <span className="text-[10.5px] font-medium text-stone-500 tabular-nums">{hint}</span>
      </div>
    </div>
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
/* GÖRSEL İPUCU (Goker, Eki 2026 — "nereden bollaştıracağımı kestiremiyorum"): değer hücresi üzerine gelince / odaklanınca ANAHTARINI
   yayar (onHint); aynı anahtarı okuyan diyagram / şema o ölçüyü turuncu vurgular. Yeni ölçü = anahtar + hücre + diyagram parçası.
   Metin ipucu (title) bilerek YOK — geri bildirim görseldir. */
type HintProps = { hintKey: string; active: boolean; onHint: (k: string | null) => void };
export function HintCell({ hintKey, active, onHint, label, accent, passive, children }: HintProps & {
  label: string; accent?: boolean; passive?: boolean; children: React.ReactNode;
}) {
  const emit = () => { if (!passive) onHint(hintKey); };
  return (
    <div onClick={stop} onMouseEnter={emit} onFocusCapture={emit} onBlurCapture={() => onHint(null)}
      onMouseLeave={e => { if (!(e.currentTarget as HTMLElement).contains(document.activeElement)) onHint(null); }}
      className={`min-w-0 h-full pl-2 pr-1 flex items-center gap-1 rounded-[7px] transition-shadow duration-150
        ${passive ? 'bg-[#f6f2ec] ring-1 ring-[#ebe5dc]' : active ? 'bg-white ring-[1.5px] ring-orange-500 shadow-[0_0_0_2px_rgba(249,115,22,0.12)]'
          : accent ? 'bg-white ring-1 ring-orange-400/70' : 'bg-white ring-1 ring-[#e6e0d6] shadow-[0_1px_0_rgba(40,30,20,0.03)]'}`}>
      <span className={`flex-1 min-w-0 truncate text-[10px] font-semibold tracking-[0.08em] uppercase
        ${passive ? 'text-[#cfc6b9]' : active ? 'text-orange-600' : 'text-[#b5ada3]'}`}>{label}</span>
      {children}
    </div>
  );
}

/* ───────────── DİYAGRAM ORTAKLARI (kanal kesiti + ayak planı) ───────────── */
const O = '#ea580c', OF = '#fdba74', MUTE = '#b8aea0', TXT = '#8f877c', DARK = '#57534e';
const DiagramSvg = ({ w, h, className, children }: Kids & { w: number; h: number; className?: string }) => (
  <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" className={`block rounded-[8px] bg-[#faf7f2] ring-1 ring-[#ebe5dc] ${className ?? ''}`}
    aria-hidden>{children}</svg>
);
/** Ölçü çizgisi (uçları çentikli), değer yazısı, soluk not, vurgu dolgusu — `active` anahtarı turuncu. */
function diagramKit(active: string | null, { fs, noteFs, tick, wOn }: { fs: number; noteFs: number; tick: number; wOn: number }) {
  const on = (k: string) => active === k;
  const dim = (xa: number, ya: number, xb: number, yb: number, k: string) => {
    const vert = Math.abs(xb - xa) < 0.01;
    const end = (x: number, y: number) => (vert ? <line x1={x - tick} y1={y} x2={x + tick} y2={y} /> : <line x1={x} y1={y - tick} x2={x} y2={y + tick} />);
    return <g stroke={on(k) ? O : MUTE} strokeWidth={on(k) ? wOn : 0.9}><line x1={xa} y1={ya} x2={xb} y2={yb} />{end(xa, ya)}{end(xb, yb)}</g>;
  };
  const txt = (x: number, y: number, s: string, k: string, anchor: 'start' | 'middle' | 'end' = 'middle') => (
    <text x={x} y={y} fontSize={fs} fontWeight={700} fill={on(k) ? O : DARK} textAnchor={anchor} fontFamily={UI_FONT}
      style={{ fontVariantNumeric: 'tabular-nums' }}>{s}</text>
  );
  const note = (x: number, y: number, s: string, p?: React.SVGProps<SVGTextElement>) => (
    <text x={x} y={y} fontSize={noteFs} fill={TXT} fontFamily={UI_FONT} {...p}>{s}</text>
  );
  const mark = (k: string, x: number, y: number, w: number, h: number) => on(k) && <rect x={x} y={y} width={w} height={h} fill={OF} stroke={O} strokeWidth={1} />;
  return { on, dim, txt, note, mark };
}

/** KANAL KESİT DİYAGRAMI (plan görünüş, ölçeksiz): dolaba önden bakar gibi ARKA ÜSTTE, ÖN ALTTA (Goker: "arkası aşağıda durması
 *  kafa karıştırıcı"); sınır paneli sağda. active: 't' · 'setback' · 'gf' / 'gb' / 'gd' (ön / arka / dip payı) · 'in'.
 *  Değerler kutudaki sayıyla aynı yazılır. `inset` verilirse (hızlı gövde) In ölçekli çizilir; arkalık kartında kenar başına olduğundan verilmez. */
export function BackGrooveDiagram({ active, grooved, t, setback, front, rear, depth, inset, className }: {
  active: string | null; grooved: boolean; t: number; setback: number; front: number; rear: number; depth: number; inset?: number; className?: string;
}) {
  const W = BACK_DIAGRAM_W, H = BACK_DIAGRAM_H, T = 15, PX0 = 132, PX1 = 164, D = 7, F = 6, R = 6;
  // Panel genişliği 32 px ≈ 18 mm; In verilmişse giriş o ölçekte (6..24 px), yoksa temsili 16
  const IN = inset == null ? 16 : Math.max(6, Math.min(24, (inset / 18) * (PX1 - PX0)));
  // Kanallı: panelin arka yüzü ÜSTTE (rear0), arkalık S kadar öne (aşağı) içerde, panele IN girer. Çakma: arkalık panelin ARKASINDA
  // (üstünde), ucunu örter ve panelin DIŞ yüzünde biter (sınırı geçmez).
  const rear0 = grooved ? 20 : 36, S = grooved ? 26 : 0;
  const by0 = grooved ? rear0 + S : rear0 - T, by1 = by0 + T;   // arkalık parçası: by0 = arka yüzü (üst), by1 = ön yüzü (alt)
  const gx1 = PX0 + IN + D, gy0 = by0 - R, gy1 = by1 + F;        // kanal: üstte arka payı (R), altta ön payı (F)
  const { on, dim, txt, note, mark } = diagramKit(active, { fs: 10.2, noteFs: 9.2, tick: 3, wOn: 1.3 });
  const lblX = (PX0 + PX1) / 2 + 3, lblY = H - 21;
  return (
    <DiagramSvg w={W} h={H} className={className}>
      {note(8, 13, 'rear')}{note(8, H - 7, 'front ↓')}
      <line x1={6} y1={rear0} x2={PX1 + 10} y2={rear0} stroke={MUTE} strokeWidth={0.8} strokeDasharray="3 2.5" />
      <rect x={PX0} y={rear0} width={PX1 - PX0} height={H - 6 - rear0} fill="#ebe4d9" stroke="#a39a8d" strokeWidth={1} />
      {note(lblX, lblY, 'panel', { textAnchor: 'middle', transform: `rotate(-90 ${lblX} ${lblY})` })}
      {grooved && <>
        <rect x={PX0} y={gy0} width={gx1 - PX0} height={gy1 - gy0} fill="#ffffff" stroke={O} strokeOpacity={0.75} strokeWidth={0.9} strokeDasharray="2.5 2" />
        {mark('gb', PX0, gy0, gx1 - PX0, R)}
        {mark('gf', PX0, by1, gx1 - PX0, F)}
        {mark('gd', PX0 + IN, gy0, D, gy1 - gy0)}
      </>}
      <rect x={10} y={by0} width={(grooved ? PX0 + IN : PX1) - 10} height={T} fill={on('t') ? '#fed7aa' : '#f3ece2'} stroke={on('t') ? O : '#78716c'}
        strokeWidth={1.1} />
      {note(64, by0 + T / 2 + 3, 'back panel', { fill: '#78716c', textAnchor: 'middle' })}
      {dim(20, by0, 20, by1, 't')}{txt(20, by1 + 12, `T ${fmt1(t)}`, 't')}
      {grooved ? <>
        {dim(100, rear0, 100, by0, 'setback')}{txt(105, (rear0 + by0) / 2 + 3.5, `S ${fmt1(setback)}`, 'setback', 'start')}
        {txt(W - 6, gy0 + 3, `R ${fmt1(rear)}`, 'gb', 'end')}
        {txt(W - 6, gy1 + 7, `F ${fmt1(front)}`, 'gf', 'end')}
        {txt(PX0 + IN + D / 2, gy1 + 13, `D ${fmt1(depth)}`, 'gd')}
        {inset != null && <>
          {mark('in', PX0, by0, IN, T)}
          <g stroke={on('in') ? O : TXT} strokeWidth={on('in') ? 1.3 : 0.9}>
            <line x1={PX0} y1={by0 + T / 2} x2={PX0 + IN} y2={by0 + T / 2} /><line x1={PX0 + IN} y1={by0 + 3} x2={PX0 + IN} y2={by1 - 3} />
          </g>
          {txt(PX0 - 4, by1 + 12, `In ${fmt1(inset)}`, 'in', 'end')}
        </>}
      </> : note(PX1, by0 - 5, 'nailed on', { fontWeight: 700, textAnchor: 'end' })}
    </DiagramSvg>
  );
}
/** Tip düğmeleri (kart hücresi): Nailed ve Grooved yan yana İKİ AYRI düğme, hücreyi eşit paylaşır; value=null → ikisi de pasif (karışık). */
export function BackTypeButtons({ value, hint, onPick }: { value: BackPlacement | null; hint: string; onPick: (t: BackPlacement) => void }) {
  return (
    <div className="min-w-0 h-full grid grid-cols-2 gap-1" onClick={stop}>
      {(['outer', 'inner'] as const).map(t => (
        <button key={t} type="button" title={`${BACK_TYPE_LABEL[t]} — ${hint.toLowerCase()}`} onClick={e => { stop(e); onPick(t); }} style={{ fontFamily: UI_FONT }}
          className={`min-w-0 h-full px-1 rounded-[7px] flex items-center justify-center gap-1 text-[11px] font-semibold transition-colors duration-150
            ${value === t ? 'bg-[#44403c] text-white ring-1 ring-[#44403c] shadow-[0_1px_2px_rgba(40,30,20,0.25)]'
              : 'bg-white text-stone-600 ring-1 ring-[#e6e0d6] hover:bg-[#faf7f2] hover:text-stone-800'}`}>
          {/* Dar kenar çubuğunda etiket kesilmesin: yalnız yazı (ikon yok). */}
          <span className="truncate" style={{ letterSpacing: '-0.01em' }}>{BACK_TYPE_LABEL[t]}</span>
        </button>
      ))}
    </div>
  );
}
/** Arkalık kartı kanal bloğu: 4 eşit satır (satır yüksekliği BACK_ROW_H) — diyagram yüksekliği bloğun tamamı. */
export const BACK_ROW_H = 28, BACK_ROW_GAP = 4, BACK_BLOCK_H = 4 * BACK_ROW_H + 3 * BACK_ROW_GAP;
/** Kesit diyagramı viewBox'ı: blok yüksekliğinde, GENİŞ (en-boy ≈ 1.8) — hücreler dar, diyagram geniş. */
export const BACK_DIAGRAM_W = 224, BACK_DIAGRAM_H = BACK_BLOCK_H;

/* ───────────────────────────── HIZLI GÖVDE (Body) ─────────────────────────────
   Tek seferlik yapılandırma: taban (Plain / Legs / Plinth), dört köşe birleşimi, baza / ayak ölçüleri, arkalık. Onay → QuickBodyService.applyQuickBody.
   Görsel dil arkalık kartıyla ortak: HintCell + diyagram vurgusu, FIELD_INPUT, BackGrooveDiagram. */
const QB_BASE_ITEMS: SegItem[] = [
  { key: 'plain', label: 'Plain', title: 'Sits on the floor: bottom panel at the base, any corner joints' },
  { key: 'legs', label: 'Legs', title: 'On legs: the cube is the total height — panels sit leg-height above the floor, legs underneath' },
  { key: 'plinth', label: 'Plinth', title: 'Plinth: sides reach the floor, bottom panel raised by the plinth height, kick panels front / rear' },
];
const QB_CORNER_TITLE: Record<CornerKey, string> = { tl: 'Top-left', tr: 'Top-right', bl: 'Bottom-left', br: 'Bottom-right' };
const QB_CELL_ROW = { gridAutoRows: `${BACK_ROW_H}px`, rowGap: BACK_ROW_GAP } as const;
const qbField = (w: number, passive?: boolean): React.CSSProperties =>
  ({ ...FIELD_INPUT, width: w, flexShrink: 0, textAlign: 'right', ...(passive ? PASSIVE_INPUT : {}) });
const countOpts = (ns: number[]) => ns.map(n => ({ v: String(n), label: n === 0 ? 'None' : String(n) }));

/** Taslaklı sayı girişi: Enter / blur onaylar, Esc geri alır. */
function QbNum({ value, onCommit, passive, w = 34, min = 0, max }: {
  value: number; onCommit: (v: number) => void; passive?: boolean; w?: number; min?: number; max?: number;
}) {
  const [draft, setDraft] = useDraft(value);
  const commit = () => {
    if (draft == null) return;
    const v = parseNum(draft); setDraft(null);
    if (!Number.isFinite(v)) return;
    const c = Math.min(max ?? Infinity, Math.max(min, v));
    if (Math.abs(c - value) > 1e-6) onCommit(round1(c));
  };
  return (
    <input type="text" inputMode="decimal" value={passive ? '—' : draft ?? fmt1(value)} disabled={passive}
      onChange={e => setDraft(e.target.value)} onBlur={commit} onFocus={e => e.target.select()}
      onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }} onClick={stop}
      className="yago-field" style={qbField(w, passive)} />
  );
}
/** Küçük anahtar (koyu = açık). */
function QbSwitch({ on, onToggle, title, disabled }: { on: boolean; onToggle: () => void; title?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} title={title} disabled={disabled} onClick={e => { stop(e); if (!disabled) onToggle(); }}
      className={`relative shrink-0 w-[28px] h-[16px] rounded-full transition-colors duration-150
        ${disabled ? 'bg-[#ebe5dc] cursor-not-allowed' : on ? 'bg-[#44403c]' : 'bg-[#d6cfc3] hover:bg-[#c9c1b4]'}`}>
      <span className={`absolute top-[2px] w-[12px] h-[12px] rounded-full bg-white shadow-[0_1px_2px_rgba(40,30,20,0.3)] transition-[left] duration-150
        ${on ? 'left-[14px]' : 'left-[2px]'}`} />
    </button>
  );
}
function QbSelect<T extends string>({ value, options, onChange, passive, w = 44 }: {
  value: T; options: Array<{ v: T; label: string }>; onChange: (v: T) => void; passive?: boolean; w?: number;
}) {
  return (
    <select value={value} disabled={passive} onChange={e => onChange(e.target.value as T)} onClick={stop} className="yago-field appearance-none cursor-pointer"
      style={{ ...qbField(w, passive), paddingRight: 2 }}>
      {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
    </select>
  );
}
const ReadCell = ({ label, title, className = '', children }: Kids & { label: string; title?: string; className?: string }) => (
  <div className={`${className} ${READ_CELL}`} title={title}>
    <span className={`flex-1 min-w-0 truncate ${CELL_LABEL}`}>{label}</span>
    {children}
  </div>
);
/** Giriş kutusu yazısıyla salt-okunur değer. */
const ReadValue = ({ color, title, className = 'whitespace-nowrap pr-1', children }: Kids & { color: string; title?: string; className?: string }) => (
  <span className={className} style={{ ...FIELD_INPUT, width: 'auto', color }} title={title}>{children}</span>
);
/** Aynı ipucu durumuna bağlı hücreler: `cell` serbest içerik, `num` QbNum (pasiflik hücre ve giriş için ortak). */
function hintCells(hint: string | null, onHint: (k: string | null) => void) {
  const cell = (label: string, k: string, body: React.ReactNode, passive?: boolean) => (
    <HintCell label={label} hintKey={k} active={hint === k} onHint={onHint} passive={passive}>{body}</HintCell>
  );
  const num = (label: string, k: string, value: number, onCommit: (v: number) => void, passive?: boolean, min?: number) =>
    cell(label, k, <QbNum value={value} min={min} passive={passive} onCommit={onCommit} />, passive);
  return { cell, num };
}

/* DÖRT KÖŞE: her köşe büyütülmüş birleşim detayı — hangi panelin üstten bindiği (köşeden geçtiği) görünür; tık değiştirir. */
function CornerJointTiles({ joins, lockBottom, active, onCorner, onHover }: {
  joins: Record<CornerKey, JoinPass>; lockBottom: boolean; active: string | null; onCorner: (c: CornerKey) => void; onHover: (c: CornerKey | null) => void;
}) {
  const VW = 448, TW = 104, TH = 104, GAP = (VW - 4 * TW) / 5, BOX_W = 74, BOX_H = 54, T = 16;
  return (
    <svg viewBox={`0 0 ${VW} ${TH}`} preserveAspectRatio="xMidYMid meet" className="block w-full" aria-hidden>
      {(['tl', 'tr', 'bl', 'br'] as const).map((c, i) => {
        const x = GAP + i * (TW + GAP), locked = lockBottom && (c === 'bl' || c === 'br');
        const side = joins[c] === 'side', hi = active === `c-${c}`, hot = hi && !locked;
        const left = c === 'tl' || c === 'bl', top = c === 'tl' || c === 'tr';
        // Kutunun dış köşesi (ox, oy) ve şerit kalınlığı kadar içerisi (ix, iy); yan şerit dikey, üst/alt şerit yatay.
        const bx = x + (TW - BOX_W) / 2, by = 8, ox = left ? bx : bx + BOX_W, oy = top ? by : by + BOX_H, ix = ox + (left ? T : -T), iy = oy + (top ? T : -T);
        const vRect = { x: left ? ox : ix, y: side ? by : (top ? by + T : by), w: T, h: side ? BOX_H : BOX_H - T };
        const hRect = { x: side && left ? bx + T : bx, y: top ? oy : iy, w: side ? BOX_W - T : BOX_W, h: T };
        const pass = side ? vRect : hRect, butt = side ? hRect : vRect;
        const strokeP = locked ? '#b8aea0' : hi ? O : '#6b6460';
        const label = side ? 'Side passes' : (top ? 'Top passes' : 'Bottom passes');
        return (
          <g key={c} onClick={e => { stop(e); if (!locked) onCorner(c); }} onMouseEnter={() => onHover(c)} onMouseLeave={() => onHover(null)}
            style={{ cursor: locked ? 'default' : 'pointer' }}>
            <title>{`${QB_CORNER_TITLE[c]}: ${side ? 'side panel passes the corner — top/bottom sits between the sides'
              : 'top/bottom panel passes the corner — side sits between'}${locked ? ' · fixed in plinth mode (sides reach the floor)' : ' · click to swap'}`}</title>
            <rect x={x} y={1} width={TW} height={TH - 2} rx={8} fill={hot ? '#fff7f0' : '#ffffff'} stroke={hot ? O : '#e6e0d6'} strokeWidth={hot ? 1.3 : 1} />
            <rect x={bx} y={by} width={BOX_W} height={BOX_H} fill="#f6f2ec" stroke="none" />
            <rect x={butt.x} y={butt.y} width={butt.w} height={butt.h} fill={locked ? '#efe9df' : '#ebe4d9'} stroke={locked ? '#cfc7bb' : '#a39a8d'} strokeWidth={1} />
            <rect x={pass.x} y={pass.y} width={pass.w} height={pass.h} fill={locked ? '#ddd6cb' : hi ? '#fdba74' : '#d6c9b4'} stroke={strokeP} strokeWidth={1.2} />
            {/* geçen panelin görünen ucu (kalınlık kenarı) */}
            <line x1={side ? ix : ox} y1={side ? oy : iy} x2={ix} y2={iy} stroke={strokeP} strokeWidth={1.2} />
            <text x={x + TW / 2} y={TH - 24} fontSize={10} fontWeight={700} fill={locked ? '#b8aea0' : hi ? O : DARK} textAnchor="middle"
              fontFamily={UI_FONT}>{QB_CORNER_TITLE[c]}</text>
            <text x={x + TW / 2} y={TH - 11} fontSize={9.4} fontWeight={600} fill={locked ? '#c7beb1' : TXT} textAnchor="middle"
              fontFamily={UI_FONT}>{locked ? `${label} · fixed` : label}</text>
          </g>
        );
      })}
    </svg>
  );
}

type LegDims = { count: number; height: number; diameter: number; side: number; front: number; rear: number };
/* Plan görünüşü (üstten; ön altta): ayak yerleri, Ø, yan / ön / arka mesafeleri. Tam genişlik. */
function LegsPlanDiagram({ legs, W, D, active, className }: { legs: Omit<LegDims, 'height'>; W: number; D: number; active: string | null; className?: string }) {
  const VW = 448, VH = 176, PX0 = 64, PW = VW - PX0 - 70, PY0 = 22, PH = VH - PY0 - 26;
  const s = Math.max(1e-6, Math.min(PW / W, PH / D));
  const w = W * s, d = D * s, x0 = PX0 + (PW - w) / 2, y0 = PY0 + (PH - d) / 2, x1 = x0 + w, y1 = y0 + d;
  const r = Math.max(3, (legs.diameter / 2) * s);
  const spots = legSpots({ count: (legs.count || 4) as 4 | 5 | 6, side: legs.side, front: legs.front, rear: legs.rear }, W, D)
    .map(p => ({ x: x0 + p.x * s, y: y0 + p.z * s }));   // ön (+Z) altta
  const { on, dim, txt, note } = diagramKit(active, { fs: 10.5, noteFs: 9.4, tick: 3.5, wOn: 1.4 });
  const hi = on('ld') || on('lc'), legStroke = hi ? O : '#78716c';
  const lead = (xa: number, ya: number, xb: number, yb: number) =>
    <line x1={xa} y1={ya} x2={xb} y2={yb} stroke={MUTE} strokeWidth={0.6} strokeDasharray="1.5 1.5" />;
  const first = spots[0], rearLeg = spots[3] ?? spots[2];
  return (
    <DiagramSvg w={VW} h={VH} className={className}>
      {note(10, 13, 'plan view · rear at top')}{note(10, VH - 8, 'front ↓')}
      <rect x={x0} y={y0} width={w} height={d} fill="#f3ede4" stroke="#a39a8d" strokeWidth={1} />
      {note((x0 + x1) / 2, y0 - 7, `W ${fmt1(W)}`, { textAnchor: 'middle' })}
      {note(x1 + 44, (y0 + y1) / 2 + 3, `D ${fmt1(D)}`)}
      {spots.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={r + 3} fill="none" stroke={hi ? O : '#cfc7bb'} strokeWidth={0.7} strokeDasharray="1.8 1.8" />
          <circle cx={p.x} cy={p.y} r={r} fill={hi ? OF : '#d9d2c6'} stroke={legStroke} strokeWidth={1} />
          <line x1={p.x - r * 0.45} y1={p.y} x2={p.x + r * 0.45} y2={p.y} stroke={legStroke} strokeWidth={0.7} />
          <line x1={p.x} y1={p.y - r * 0.45} x2={p.x} y2={p.y + r * 0.45} stroke={legStroke} strokeWidth={0.7} />
        </g>
      ))}
      {/* Ölçüler dışarıda: yan = altta (x0 → ön-sol ayak), ön = solda (ön-sol ayak → ön kenar), arka = sağda (arka kenar → arka-sağ ayak) */}
      {first && <>
        {dim(x0, y1 + 11, first.x, y1 + 11, 'ls')}{lead(first.x, first.y, first.x, y1 + 14)}{txt((x0 + first.x) / 2, y1 + 23, fmt1(legs.side), 'ls')}
        {dim(x0 - 11, first.y, x0 - 11, y1, 'lf')}{lead(x0 - 14, first.y, first.x, first.y)}{txt(x0 - 15, (first.y + y1) / 2 + 4, fmt1(legs.front), 'lf', 'end')}
      </>}
      {rearLeg && <>
        {dim(x1 + 11, y0, x1 + 11, rearLeg.y, 'lr')}{lead(rearLeg.x, rearLeg.y, x1 + 14, rearLeg.y)}
        {txt(x1 + 15, (y0 + rearLeg.y) / 2 + 4, fmt1(legs.rear), 'lr', 'start')}
      </>}
      {spots[2] && txt(spots[2].x + r + 5, spots[2].y + 4, `Ø ${fmt1(legs.diameter)}`, 'ld', 'start')}
      {txt(x1 - 4, y1 - 6 - r * 2 - 4, `${legs.count || 4} legs`, 'lc', 'end')}
    </DiagramSvg>
  );
}

/* Ayak bloğu: plan diyagramı (tam genişlik) + 3 sütun hücre. Hızlı gövde ve kalıcı Legs satırı ortak kullanır. */
export function LegsBlock({ legs, W, D, heightReadout, heightEditable, countOptions, onChange, hint, onHint }: {
  legs: LegDims; W: number; D: number; heightReadout?: number; heightEditable?: boolean;
  /** boş = adet hücresi yok (adet gövde bloğunda seçilir) */ countOptions: number[];
  onChange: (p: Partial<LegDims>) => void; hint: string | null; onHint: (k: string | null) => void;
}) {
  const { cell, num } = hintCells(hint, onHint);
  return (
    <div className="flex flex-col gap-1.5" onMouseLeave={() => onHint(null)}>
      <LegsPlanDiagram legs={legs} W={W} D={D} active={hint} className="w-full" />
      <div className="grid grid-cols-3 gap-x-1" style={QB_CELL_ROW}>
        {countOptions.length > 0
          ? cell('Legs', 'lc', <QbSelect value={String(legs.count)} options={countOpts(countOptions)} onChange={v => onChange({ count: parseInt(v, 10) })} />)
          : (
            <ReadCell label="Layout" title="Leg layout">
              <span className="whitespace-nowrap text-[11px] font-semibold text-stone-500">
                {legs.count === 5 ? '4 + centre' : legs.count === 6 ? '4 + front/rear' : 'corners'}
              </span>
            </ReadCell>
          )}
        {num('Ø', 'ld', legs.diameter, v => onChange({ diameter: v }), false, 5)}
        {heightEditable ? num('Height', 'lh', legs.height, v => onChange({ height: v }), false, 1) : cell('Height', 'lh', (
          <ReadValue color={countOptions.length ? '#57534e' : '#c7beb1'} title={countOptions.length ? "Read from the bottom panel's underside" : '= plinth height'}>
            {fmt1(heightReadout ?? legs.height)}
          </ReadValue>
        ), true)}
        {num('Side', 'ls', legs.side, v => onChange({ side: v }))}
        {num('Front', 'lf', legs.front, v => onChange({ front: v }))}
        {num('Rear', 'lr', legs.rear, v => onChange({ rear: v }))}
      </div>
    </div>
  );
}

/* HIZLI GÖVDE PANELİ — liste alanının üstünde (kaydırılan alanda; üst şerit yapışık). Diyagramlar tam genişlik, hücreler altında 3 sütun. */
export function QuickBodyPanel({ shape, cfg, setCfg, busy, existingCount, onApply, onExit }: {
  shape: Shape; cfg: QuickBodyConfig; setCfg: (p: Partial<QuickBodyConfig>) => void; busy: boolean; existingCount: number; onApply: () => void; onExit: () => void;
}) {
  const [hint, setHint] = useState<string | null>(null);
  const { cell, num } = hintCells(hint, setHint);
  const bb = localBboxOf(effectiveBodyGeometry(shape));
  const W = bb ? bb.max.x - bb.min.x : 600, H = bb ? bb.max.y - bb.min.y : 720, D = bb ? bb.max.z - bb.min.z : 560;
  const joins = effectiveJoins(cfg);
  const isPlinth = cfg.base === 'plinth', isLegs = cfg.base === 'legs', isPlain = cfg.base === 'plain';
  const legCount = isLegs ? (cfg.legs.count || 4) : isPlinth ? cfg.legs.count : 0;
  const panelCount = 4 + (isPlinth ? 1 + (cfg.plinth.rearPlinth ? 1 : 0) : 0);
  const { cyclic } = panelOrderFor(joins);
  const b = cfg.back, grooved = b.placement === 'inner';
  const setPlinth = (p: Partial<QuickBodyConfig['plinth']>) => setCfg({ plinth: { ...cfg.plinth, ...p } });
  const setLegs = (p: Partial<QuickBodyConfig['legs']>) => setCfg({ legs: { ...cfg.legs, ...p } });
  const setBack = (p: Partial<QuickBodyConfig['back']>) => setCfg({ back: { ...b, ...p } });
  const setClear = (p: Partial<QuickBodyConfig['back']['clear']>) => setBack({ clear: { ...b.clear, ...p } });
  // Taban değişince ayak: Legs → en az 4; Plinth → otomatik None (Goker); Plain → yok.
  const setBase = (base: QuickBodyBase) => setCfg({ base, legs: { ...cfg.legs, count: base === 'legs' ? (cfg.legs.count || 4) : 0 } });
  const toggleCorner = (c: CornerKey) => setCfg({ joins: { ...cfg.joins, [c]: cfg.joins[c] === 'side' ? 'horiz' : 'side' } });
  const existing = existingCount ? `${existingCount} panel${existingCount === 1 ? '' : 's'} already on the body · ` : '';
  const status = busy ? 'Building panels…' : cyclic ? 'Corner joints form a cycle — sides will pass first'
    : `${existing}${panelCount} panels${b.enabled ? ' + back' : ''}${legCount ? ` + ${legCount} legs` : ''}`;
  const sub = (s: React.ReactNode) => <span className="text-[10px] font-medium text-stone-400" style={{ fontFamily: UI_FONT }}>{s}</span>;
  return (
    <div style={{ fontFamily: UI_FONT }}>
      <div className="sticky top-0 z-[3]" style={DOCK_STRIP}>
        <div style={DOCK_ROW}>
          <span style={dockAxisTag('#44403c')}>BODY</span>
          <div className="flex-1 min-w-0"><Segmented items={QB_BASE_ITEMS} active={cfg.base} onPick={k => setBase(k as QuickBodyBase)} /></div>
          <ApplyBtn enabled={!busy} onClick={onApply} title="Place body panels" />
          <ExitBtn onClick={onExit} />
        </div>
        <div style={{ ...DOCK_ROW, paddingTop: 0 }}><DockStatus ready={!busy && !cyclic} text={status} /></div>
      </div>
      <div className="px-1.5 pb-2" onMouseLeave={() => setHint(null)}>
        {/* GÖVDE: yalnız dört köşe birleşimi (dolap çizimi yok — Goker), altında 3 sütun hücre */}
        <div className="pt-1.5 pb-1 flex items-center gap-2 px-0.5">
          <span style={SECTION_LABEL}>Corner joints</span>
          <span className="text-[10px] text-stone-400">click a corner to swap which panel passes</span>
          <div className="flex-1 h-px bg-[#efeae2]" />
        </div>
        <CornerJointTiles joins={joins} lockBottom={isPlinth} active={hint} onCorner={toggleCorner} onHover={c => setHint(c ? `c-${c}` : null)} />
        <div className="mt-1 grid grid-cols-3 gap-x-1" style={QB_CELL_ROW}>
          {num('Thick', 't', cfg.thickness, v => setCfg({ thickness: v }), false, 1)}
          {num('Plinth', 'ph', cfg.plinth.height, v => setPlinth({ height: v }), !isPlinth, 1)}
          {num('Front', 'pf', cfg.plinth.front, v => setPlinth({ front: v }), !isPlinth)}
          {cell('Rear', 'pr', <>
            <QbSwitch on={cfg.plinth.rearPlinth} disabled={!isPlinth} title="Rear plinth on / off"
              onToggle={() => setPlinth({ rearPlinth: !cfg.plinth.rearPlinth })} />
            <QbNum value={cfg.plinth.rear} passive={!isPlinth || !cfg.plinth.rearPlinth} w={30} onCommit={v => setPlinth({ rear: v })} />
          </>, !isPlinth)}
          {cell('Legs', 'lc', <QbSelect value={String(legCount)} passive={isPlain} options={countOpts(isLegs ? [4, 5, 6] : [0, 4, 5, 6])}
            onChange={v => setLegs({ count: parseInt(v, 10) as 0 | 4 | 5 | 6 })} />, isPlain)}
          {isLegs ? num('Leg H', 'lh', cfg.legs.height, v => setLegs({ height: v }), false, 1)
            : cell('Leg H', 'lh', <ReadValue color="#c7beb1">{isPlinth && legCount ? fmt1(cfg.plinth.height) : '—'}</ReadValue>, true)}
          {cell('Back', 'bt', <QbSelect value={b.enabled ? b.placement : 'none'} w={70}
            options={[{ v: 'outer', label: BACK_TYPE_LABEL.outer }, { v: 'inner', label: BACK_TYPE_LABEL.inner }, { v: 'none', label: 'None' }]}
            onChange={v => setBack(v === 'none' ? { enabled: false } : { enabled: true, placement: v })} />)}
          <ReadCell label="Size" title="Body size W × H × D" className="col-span-2">
            <span className="whitespace-nowrap text-[11px] font-semibold text-stone-500 tabular-nums">{fmt1(W)} × {fmt1(H)} × {fmt1(D)}</span>
          </ReadCell>
        </div>
        {legCount > 0 && <>
          <SectionHead label="Legs" className="px-0.5 pt-2.5 pb-1" />
          <LegsBlock legs={{ ...cfg.legs, count: legCount, height: isPlinth ? cfg.plinth.height : cfg.legs.height }} W={W} D={D} heightEditable={isLegs}
            heightReadout={isPlinth ? cfg.plinth.height : undefined} countOptions={[]} hint={hint} onHint={setHint}
            onChange={p => setLegs(p as Partial<QuickBodyConfig['legs']>)} />
        </>}
        {/* ARKALIK: arkalık kartıyla aynı kesit diyagramı, büyük */}
        {b.enabled && <>
          <SectionHead label="Back panel" className="px-0.5 pt-2.5 pb-1" />
          <div className="flex flex-col gap-1.5">
            <div className="w-full flex" style={{ height: 200 }}>
              <BackGrooveDiagram active={hint === 'bi' ? 'in' : hint && hint.startsWith('b') ? hint.slice(1) : null} grooved={grooved} t={b.thickness}
                setback={grooved ? b.setback : 0} front={b.clear.front} rear={b.clear.back} depth={b.clear.depth} inset={b.inset} className="w-full h-full" />
            </div>
            <div className="grid grid-cols-3 gap-x-1" style={QB_CELL_ROW}>
              {num('Thick', 'bt', b.thickness, v => setBack({ thickness: v }), false, 1)}
              {num('In', 'bi', b.inset, v => setBack({ inset: v }), !grooved)}
              {num('Setback', 'bsetback', b.setback, v => setBack({ setback: v }), !grooved)}
              {num('Front', 'bgf', b.clear.front, v => setClear({ front: v }), !grooved)}
              {num('Rear', 'bgb', b.clear.back, v => setClear({ back: v }), !grooved)}
              {num('Bottom', 'bgd', b.clear.depth, v => setClear({ depth: v }), !grooved)}
              <ReadCell label="Groove" className={`col-span-2 ${grooved ? '' : 'opacity-60'}`}>
                <ReadValue color="#57534e" className="whitespace-nowrap">{grooved ? <>
                  {fmt1(b.thickness + b.clear.front + b.clear.back)}{sub(' × ')}{fmt1(b.inset + b.clear.depth)}
                  {sub(<> (In {fmt1(b.inset)} + {fmt1(b.clear.depth)})</>)}
                </> : '—'}</ReadValue>
              </ReadCell>
            </div>
          </div>
        </>}
      </div>
    </div>
  );
}
