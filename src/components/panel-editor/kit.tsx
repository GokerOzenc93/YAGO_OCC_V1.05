import React, { useEffect, useRef, useState } from 'react';
import {
  Check, ChevronDown, ChevronRight, Columns3, Crosshair, DoorClosed, LayoutPanelTop, Lock, type LucideIcon, Minus, Pin, Plus, Footprints, Rows3,
  SendToBack, Shapes, SlidersHorizontal, Unlock, X,
} from 'lucide-react';
import { type BackPlacement } from '../../store';
import { UI_FONT } from '../Ui';
import { round1 } from '../Geometry';
import { BACK_TYPE_LABEL, BACK_TYPE_TITLE } from '../BackService';

/* PANEL EDİTÖRÜ ORTAK KİTİ — şema görsel dili (pill / kilit / rozet), şema kancaları, şerit (dock) ve liste satırı parçaları.
   Kapak, arkalık ve raf/dikme şemaları ile panel listesi aynı parçaları kullanır. */

export const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
export const AXIS_COLORS: Record<string, string> = {
  'x+': '#dc2626', 'x-': '#b91c1c', 'y+': '#16a34a', 'y-': '#15803d', 'z+': '#2563eb', 'z-': '#1d4ed8', x: '#dc2626', y: '#16a34a', z: '#2563eb',
};
export const SECTION_LABEL: React.CSSProperties = { fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#b5ada3' };

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

/* ───────────── ŞERİT (DOCK) ───────────── */

export const DOCK_SHELL: React.CSSProperties = {
  position: 'relative', marginTop: 5, borderRadius: 12, background: 'linear-gradient(180deg,#fefdfb 0%,#faf8f4 100%)', border: '1px solid #ebe5dc',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 2px rgba(60,40,20,0.04)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
  fontFamily: UI_FONT,
};
/** Liste üstüne yapışık şerit (yerleştirme / hızlı gövde). */
export const DOCK_STRIP: React.CSSProperties = {
  ...DOCK_SHELL, marginTop: 0, borderRadius: 0, border: 'none', borderBottom: '1px solid #ebe5dc', boxShadow: 'none',
  background: 'linear-gradient(180deg,#fefdfb 0%,#faf8f4 100%)',
};
export const DOCK_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 5px 5px' };
const DOCK_INPUT: React.CSSProperties = {
  flex: 1, minWidth: 0, height: 24, textAlign: 'center',
  fontFamily: UI_FONT, fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
  color: '#1c1917', background: '#ffffff', border: '1px solid #e6e0d6', borderRadius: 7, outline: 'none', boxShadow: '0 1px 0 rgba(40,30,20,0.02)',
};
export const dockAxisTag = (color: string): React.CSSProperties => ({
  flexShrink: 0, fontSize: 10, fontWeight: 700, fontFamily: UI_FONT, color, height: 20, lineHeight: '20px', padding: '0 6px', borderRadius: 5,
  background: '#f5f2ec',
});
export function DockStatus({ ready = false, dot, text, title, trailing }: {
  ready?: boolean; dot?: string; text: string; title?: string; trailing?: React.ReactNode;
}) {
  return (
    <div title={title} style={{
      flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, height: 24, padding: '0 8px', borderRadius: 6,
      background: ready ? 'rgba(22,163,74,0.07)' : '#f5f2ec', border: ready ? '1px solid rgba(22,163,74,0.22)' : '1px solid transparent',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: dot ?? (ready ? '#16a34a' : '#a8a29e'), flexShrink: 0 }} />
      <span style={{ fontSize: 11, fontWeight: 500, color: ready ? '#15803d' : '#78716c', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {text}
      </span>
      {trailing}
    </div>
  );
}
export function ApplyBtn({ enabled, onClick, title = 'Apply' }: { enabled: boolean; onClick: () => void; title?: string }) {
  return (
    <button onClick={e => { stop(e); onClick(); }} title={title} style={{
      flexShrink: 0, width: 28, height: 24, borderRadius: 6, border: 'none', outline: 'none', cursor: enabled ? 'pointer' : 'not-allowed',
      display: 'flex', alignItems: 'center', justifyContent: 'center', background: enabled ? '#44403c' : '#ebe6de', color: enabled ? '#ffffff' : '#b5ada3',
      boxShadow: enabled ? '0 1px 2px rgba(40,30,20,0.22)' : 'none', transition: 'background 0.12s',
    }}><Check size={13} strokeWidth={2.4} /></button>
  );
}
export function ExitBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={e => { stop(e); onClick(); }} title="Exit" className="hover:!bg-[#f3efe8] hover:!text-stone-600" style={{
      flexShrink: 0, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none',
      cursor: 'pointer', outline: 'none', background: 'transparent', color: '#a8a29e', transition: 'color 0.12s,background 0.12s',
    }}><X size={13} strokeWidth={2} /></button>
  );
}
export const iconBtn = (color: string): React.CSSProperties => ({
  width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, border: 'none',
  background: 'transparent', cursor: 'pointer', color, outline: 'none', padding: 0, transition: 'background 0.12s',
});
/** Sayısal giriş: yerel metin taslağı (başta -/+ yazılabilsin); geçerli sayı yazıldıkça store güncellenir. */
export function NumInput({ draft, setDraft, setValue, fallback, onEnter, onEscape, autoFocus, style }: {
  draft: string; setDraft: (s: string) => void; setValue: (v: number) => void; fallback: number;
  onEnter?: () => void; onEscape?: () => void; autoFocus?: boolean; style?: React.CSSProperties;
}) {
  const onBlur = () => {
    const p = parseFloat(draft);
    if (isNaN(p)) { setDraft(String(fallback)); setValue(fallback); } else { setValue(p); setDraft(String(p)); }
  };
  return (
    <input type="text" inputMode="numeric" autoFocus={autoFocus} value={draft}
      onChange={e => { const v = e.target.value; setDraft(v); const p = parseFloat(v); if (!isNaN(p)) setValue(p); }}
      onBlur={onBlur}
      onKeyDown={e => { if (e.key === 'Enter') onEnter?.(); if (e.key === 'Escape') onEscape?.(); }}
      style={{ ...DOCK_INPUT, ...style }} />
  );
}

export type SegItem = { key: string; label: string; Icon?: LucideIcon; title?: string; disabled?: boolean };
export function Segmented({ items, active, onPick, height = 24 }: { items: SegItem[]; active: string | null; onPick: (k: string) => void; height?: number }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${items.length}, minmax(0,1fr))`, gap: 2, padding: 2, borderRadius: 8,
      background: '#f3efe8', border: '1px solid #e9e4dc', fontFamily: UI_FONT,
    }}>
      {items.map(({ key, label, Icon, title, disabled }) => {
        const on = active === key;
        return (
          <button key={key} type="button" title={title || label} disabled={disabled} onClick={e => { stop(e); if (!disabled) onPick(key); }}
            className={on || disabled ? '' : 'hover:!bg-white hover:!text-stone-800'}
            style={{
              height, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '0 6px', borderRadius: 6,
              border: 'none', outline: 'none', cursor: disabled ? 'not-allowed' : 'pointer', background: on ? '#44403c' : 'transparent',
              color: disabled ? '#c9c2b7' : on ? '#ffffff' : '#57534e', boxShadow: on ? '0 1px 2px rgba(40,30,20,0.25)' : 'none',
              fontSize: 11, fontWeight: 600, letterSpacing: '0.01em', transition: 'background 0.12s,color 0.12s',
            }}>
            {Icon && <Icon size={11} strokeWidth={2.1} style={{ flexShrink: 0 }} />}
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
type DockMode = { key: string; label: string; sub: string; Icon: LucideIcon; title?: string };
const DOCK_MODE_DEFS: Record<string, Omit<DockMode, 'key'>> = {
  fixed: { label: 'Fixed', sub: 'Constant', Icon: Lock },
  dyn:   { label: 'Dyn',   sub: 'Dynamic',   Icon: SlidersHorizontal },
  ref:   { label: 'Ref',   sub: 'Reference', Icon: Crosshair },
};
export const dockModes = (keys: string[], overrides: Record<string, Partial<DockMode>> = {}): DockMode[] =>
  keys.map(k => ({ key: k, ...DOCK_MODE_DEFS[k], ...(overrides[k] || {}) } as DockMode));
export function DockModeBar({ modes, active, onPick, trailing }: {
  modes: DockMode[]; active: string | null; onPick: (k: string) => void; trailing?: React.ReactNode;
}) {
  const items = modes.map(m => ({ key: m.key, label: m.label, Icon: m.Icon, title: m.title || `${m.label} — ${m.sub}` }));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 5px 0' }}>
      <div style={{ flex: 1, minWidth: 0 }}><Segmented active={active} onPick={onPick} items={items} /></div>
      {trailing}
    </div>
  );
}

/* ───────────── LİSTE SATIRI ───────────── */

/* Satır hizalama: tüm satır türleri aynı sabit sütunları kullanır; üye satırı kartta 8px içeride → sağ alan 8px dar. */
const ROW_NUM_W = 28;              // "12" ve üye "3.12" rahat sığar (Goker: numaralar dar görünüyordu)
export const ROW_BTN = 'w-[22px] h-[22px] shrink-0 rounded-md flex items-center justify-center transition-colors duration-150';
export const ROW_SPACER = 'w-[22px] h-[22px] shrink-0';
export const ROW_ICON = 13;
// 6 × 22px düğme (5 araç: şekil · kapak sınırı · arkalık sınırı · ok · sil + aç/kapa oku) + 5 × 1px aralık (Goker: grup sıkı dursun)
export const ROW_TRAIL_W = 137;
/* Seçili satır (Goker: "çok renkli, daha soft"): sıcak kemik zemin + tek ince yumuşak turuncu çizgi; numara/rozet/ok nötr koyu taş. */
export const ROW_SEL_HEAD = 'bg-[#faf8f5]';
export const ROW_SEL_BAR = 'pointer-events-none absolute left-0 top-[7px] bottom-[7px] w-[2px] rounded-r-full bg-orange-300/70';
export const MEMBER_INSET = 8;           // grup kartı gövdesinin yatay dolgusu (px-2)
/** Pasif/kapalı buton rengi (satır araçları). */
export const ROW_IDLE = 'text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700';
type RowKind = 'body' | 'shelf' | 'divider' | 'door' | 'back' | 'legs';
const ROW_KIND_ICON: Record<RowKind, LucideIcon> = {
  body: LayoutPanelTop, shelf: Rows3, divider: Columns3, door: DoorClosed, back: SendToBack, legs: Footprints,
};
const ROW_KIND_TITLE: Record<RowKind, string> = {
  body: 'Body panel', shelf: 'Shelf', divider: 'Divider', door: 'Door', back: 'Back panel', legs: 'Legs',
};
export const rowCardClass = (open: boolean, dragging: boolean, armed: boolean) =>
  `group/row relative flex flex-col rounded-[10px] overflow-hidden transition-[background-color,box-shadow,opacity,transform] duration-150 ease-out
   ${open ? 'bg-white ring-1 ring-[#e2dbd1] shadow-[0_1px_2px_rgba(68,64,60,0.04),0_8px_20px_-16px_rgba(68,64,60,0.25)] my-1'
     : 'bg-[#fdfcfa] ring-1 ring-[#ece7df] shadow-[0_1px_0_rgba(68,64,60,0.025)] hover:bg-white hover:ring-[#e2dbd0] hover:shadow-[0_1px_2px_rgba(68,64,60,0.04),0_4px_10px_-8px_rgba(68,64,60,0.18)]'}
   ${dragging ? 'opacity-40 scale-[0.99]' : ''}
   ${armed && !dragging ? '!ring-orange-300 !bg-white shadow-[0_6px_16px_-8px_rgba(234,88,12,0.35)] scale-[1.006]' : ''}`;
export const ROW_INPUT_CLASS = 'yago-row-note flex-1 min-w-0 h-[22px] px-[5px] text-[11.5px] text-stone-700 bg-transparent border border-transparent '
  + 'rounded-[5px] outline-none placeholder:text-stone-300 hover:border-[#ebe5dc] focus:bg-white focus:border-orange-400/50 transition-colors';
export const ROW_DEL_CLASS = `${ROW_BTN} text-stone-400 hover:bg-red-50 hover:text-red-500`;
export const DROP_BAND = 'pointer-events-none h-[7px] mx-1 rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-amber-400 '
  + 'shadow-[0_0_10px_rgba(245,158,11,0.65),0_1px_2px_rgba(180,83,9,0.3)]';
/** Kart gövdesi (açılınca). */
export const CARD_BODY = 'yago-expand px-2 pt-2 pb-2';
export const CARD_BODY_STYLE: React.CSSProperties = { borderTop: '1px solid #efebe5', fontFamily: UI_FONT };
/** Hücre etiketi (FieldBox / HintCell / salt-okunur hücre). */
export const CELL_LABEL = 'text-[10px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]';
/** Salt-okunur hücre zemini. */
export const READ_CELL = 'min-w-0 h-full pl-2 pr-1.5 flex items-center gap-1 rounded-[7px] bg-[#f6f2ec]';

/* Satırdaki açık anahtarlar (şekil · kapak sınırı · arkalık sınırı) TEK yumuşak renk (Goker): dolgu yok, yalnız ince dış hat. */
const ROW_TOGGLE_ON = 'text-[#c0814f] ring-1 ring-inset ring-[#ecd6c2] hover:ring-[#e0bf9f]';
type ToggleProps = { checked: boolean; disabled?: boolean; onToggle: () => void };
function RowToggle({ checked, disabled, onToggle, icon: Icon, title }: ToggleProps & { icon: LucideIcon; title: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} onClick={e => { stop(e); if (!disabled) onToggle(); }} title={title}
      className={`${ROW_BTN} ${disabled ? 'text-stone-200 cursor-not-allowed' : checked ? ROW_TOGGLE_ON : ROW_IDLE}`}>
      <Icon size={ROW_ICON} strokeWidth={1.9} />
    </button>
  );
}
/* "Yüzeyin şeklini al": AÇIK → panel serbest bölgenin tam şeklini alır (L/U/çentik); KAPALI → kardeş kenarında düz kesilir. */
export const FitShapeToggle = (p: ToggleProps) => (
  <RowToggle {...p} icon={Shapes} title={p.checked
    ? 'Fit to face shape: ON — the panel takes the full shape of its free region (L / U / notch). Click to cut straight at siblings.'
    : 'Fit to face shape: OFF — the panel is cut straight at the sibling edge. Click to follow the free region\'s full shape.'} />
);
export const DoorRefToggle = (p: ToggleProps) => (
  <RowToggle {...p} icon={DoorClosed} title={p.checked ? 'Door reference: ON — doors are built from this panel\'s edges' : 'Mark as door reference'} />
);
/* Arkalık sınırı: arkalık adayları bu panelin kenarlarından kurulur, arkalık bu panelde (Panel ref) bölünür. */
export const BackRefToggle = (p: ToggleProps) => (
  <RowToggle {...p} icon={SendToBack} title={p.checked
    ? 'Back panel reference: ON — the back panel is built from this panel\'s edges and can be split at it' : 'Mark as back panel reference'} />
);

export function RowTypeBadge({ kind, active, count }: { kind: RowKind; active: boolean; count?: number }) {
  const Icon = ROW_KIND_ICON[kind];
  return (
    <span title={count != null ? `${ROW_KIND_TITLE[kind]} · ${count} panel${count === 1 ? '' : 's'}` : ROW_KIND_TITLE[kind]}
      className={`relative shrink-0 w-5 h-5 rounded-[6px] flex items-center justify-center transition-colors duration-150
        ${active ? 'bg-white text-stone-600 ring-1 ring-[#e2dbd1]' : 'bg-[#f5f2ec] text-stone-400 group-hover/row:text-stone-500'}`}>
      <Icon size={13} strokeWidth={2} />
      {count != null && (
        <span className={`absolute -top-[5px] -right-[6px] min-w-[13px] h-[13px] px-[3px] rounded-full text-[8.5px] font-bold tabular-nums leading-[13px] text-center ring-2 ring-[#fdfcfa]
          ${active ? 'bg-stone-600 text-white' : 'bg-stone-400 text-white'}`}>{count}</span>
      )}
    </span>
  );
}
/* Ölçü hücresi: eski sade görünüm (kapsül yok); harften sonra 3 px, değer en fazla 1 ondalık.
   Sabit 59 px → 5 haneye kadar ("9999.9", "12345") sığar ve tüm satırlarda sütunlar hizalı kalır. */
const fmtDim = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
/** Satır ölçü şeridi: [harf, değer, soluk?] üçlüsü; değer sayıysa fmtDim ile yazılır. */
export function RowCells({ cells, title }: { cells: Array<[string, number | string | null | undefined, boolean?]>; title?: string }) {
  return (
    <span onClick={stop} title={title} className="shrink-0 inline-flex items-baseline leading-none tabular-nums cursor-default">
      {cells.map(([letter, v, muted], i) => (
        <React.Fragment key={letter}>
          {i > 0 && <span className="w-px h-3 bg-[#e6e0d6] mx-[4px] self-center" />}
          <span className="inline-flex items-baseline w-[59px] whitespace-nowrap overflow-hidden">
            <span className="text-[11px] font-semibold text-stone-400">{letter}</span>
            <span className={`ml-[3px] text-[12px] font-medium ${muted ? 'text-stone-500' : 'text-stone-700'}`}>{typeof v === 'string' ? v : fmtDim(v)}</span>
          </span>
        </React.Fragment>
      ))}
    </span>
  );
}
export const RowDims = ({ w, h, t, tLetter = 'T', title }: { w?: number | null; h?: number | null; t?: number | null; tLetter?: string; title?: string }) => (
  <RowCells title={title} cells={[['W', w], ['H', h], [tLetter, t, true]]} />
);
export const RowNum = ({ label, active, small }: { label: string; active: boolean; small?: boolean }) => (
  <span style={{ width: ROW_NUM_W }} className={`shrink-0 ${small ? 'text-[11px] tracking-[-0.02em]' : 'text-[13px]'} text-center whitespace-nowrap font-semibold tabular-nums leading-none transition-colors duration-150
    ${active ? 'text-stone-800' : 'text-stone-400 group-hover/row:text-stone-600'}`}>{label}</span>
);
/* Satır aç/kapa TEK mantık: tüm satır türlerinde başlık ya da ok tıkı aynı işi yapar (kapalı → aç + seç; açık → kapat + seçim düşer). */
export const RowChevron = ({ open, onClick, title }: { open: boolean; onClick?: (e: React.MouseEvent) => void; title?: string }) => (
  <button type="button" onClick={onClick} title={title ?? (open ? 'Collapse' : 'Expand')}
    className={`${ROW_BTN} ${open ? 'text-stone-700 bg-[#f1ece4] hover:bg-[#ebe5dc]' : ROW_IDLE}`}>
    <ChevronRight size={ROW_ICON} strokeWidth={2.1} className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
  </button>
);
const cardActionCls = (on: boolean, tone: 'stone' | 'amber' = 'stone') =>
  `h-[26px] min-w-0 flex items-center justify-center gap-1.5 rounded-[7px] text-[11px] font-semibold tracking-[0.01em] transition-[background-color,color,box-shadow] duration-150
   ${on ? (tone === 'amber' ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-300 shadow-[0_1px_2px_rgba(217,119,6,0.18)]' : 'bg-[#44403c] text-white ring-1 ring-[#44403c] shadow-[0_1px_3px_rgba(40,30,20,0.22)]')
     : 'bg-white ring-1 ring-[#e6e0d6] text-stone-600 shadow-[0_1px_0_rgba(40,30,20,0.03)] hover:bg-[#faf7f2] hover:ring-[#dcd4c8] hover:text-stone-800'}`;
export function CardAction({ icon: Icon, label, active = false, tone, title, onClick, compact }: {
  icon: LucideIcon; label: string; active?: boolean; tone?: 'stone' | 'amber'; title: string; onClick: () => void; compact?: boolean;
}) {
  return (
    <button type="button" title={title} onClick={e => { stop(e); onClick(); }} className={`${cardActionCls(active, tone)}${compact ? ' shrink-0 !h-[28px] px-2.5' : ''}`}>
      <Icon size={12} strokeWidth={2} className="shrink-0" /><span className="truncate">{label}</span>
    </button>
  );
}
export function FieldBox({ label, title, accent, fixed, children }: { label: string; title?: string; accent?: boolean; fixed?: boolean; children: React.ReactNode }) {
  return (
    <div title={title} onClick={stop}
      className={`${fixed ? 'shrink-0' : 'flex-1 min-w-0'} h-[28px] pl-2 pr-1 flex items-center gap-1 rounded-[7px] bg-white transition-shadow duration-150
        ${accent ? 'ring-1 ring-orange-400/70 shadow-[0_0_0_2px_rgba(249,115,22,0.08)]' : 'ring-1 ring-[#e6e0d6] shadow-[0_1px_0_rgba(40,30,20,0.03)]'}`}>
      {label && <span className={`shrink-0 ${CELL_LABEL}`}>{label}</span>}
      <div className="flex-1 min-w-0 flex items-center justify-end gap-0.5">{children}</div>
    </div>
  );
}
export const FIELD_INPUT: React.CSSProperties = {
  width: 40, minWidth: 0, height: 22, textAlign: 'center', border: 'none', outline: 'none', background: 'transparent', padding: 0,
  fontFamily: UI_FONT, fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: '#1c1917',
};
/** Pasif (girilemez) değer rengi. */
export const PASSIVE_INPUT: React.CSSProperties = { color: '#c7beb1', cursor: 'default' };
export const StepBtn = ({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button type="button" title={title} disabled={disabled} onClick={e => { stop(e); if (!disabled) onClick(); }}
    className={`w-[20px] h-[20px] shrink-0 rounded-[5px] flex items-center justify-center transition-colors duration-150
      ${disabled ? 'text-stone-300 cursor-not-allowed' : 'text-stone-500 hover:bg-[#f3efe8] hover:text-stone-800'}`}>{children}</button>
);
export const IconSquareBtn = ({ icon: Icon, title, onClick }: { icon: LucideIcon; title: string; onClick: () => void }) => (
  <button type="button" title={title} onClick={e => { stop(e); onClick(); }}
    className="shrink-0 w-[28px] h-[28px] rounded-[7px] flex items-center justify-center bg-white ring-1 ring-[#e6e0d6] text-stone-500 shadow-[0_1px_0_rgba(40,30,20,0.03)] hover:bg-[#faf7f2] hover:ring-[#dcd4c8] hover:text-stone-800 transition-colors duration-150">
    <Icon size={12.5} strokeWidth={2.2} />
  </button>
);
/** Alan içindeki küçük temizle (×) düğmesi. */
export const ClearBtn = ({ title, label, onClick }: { title: string; label: string; onClick: () => void }) => (
  <button type="button" title={title} aria-label={label} onClick={e => { stop(e); onClick(); }}
    className="shrink-0 w-[18px] h-[18px] rounded-md flex items-center justify-center text-stone-400 hover:bg-[#f5f2ec] hover:text-stone-700 transition-colors">
    <X size={11} strokeWidth={2.4} />
  </button>
);
export const unitTxt = (u: string) => <span className="shrink-0 pr-1 text-[10.5px] font-medium text-stone-400">{u}</span>;

/** Yerel metin taslağı: değer dışarıdan değişince taslak düşer. */
export function useDraft(value: unknown) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); }, [value]);
  return [draft, setDraft] as const;
}
/** Adet girişi (1..max): Enter / blur onaylar, Esc geri alır, ↑ / ↓ adım. */
function useCountInput(value: number, max: number, onChange: (n: number) => void) {
  const [draft, setDraft] = useDraft(value);
  const commit = () => {
    if (draft == null) return;
    const n = parseInt(draft, 10);
    setDraft(null);
    if (Number.isFinite(n) && n >= 1 && n <= max && n !== value) onChange(n);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') setDraft(null);
    if (e.key === 'ArrowUp') { e.preventDefault(); if (value < max) onChange(value + 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (value > 1) onChange(value - 1); }
  };
  return {
    type: 'text', inputMode: 'numeric' as const, value: draft ?? String(value), className: 'yago-field', onBlur: commit, onKeyDown, onClick: stop,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value.replace(/[^0-9]/g, '')),
  };
}
const FIELD_TAG = `flex items-center gap-[3px] pr-0.5 mr-auto ${CELL_LABEL}`;
export function CountBox({ icon: Icon, label, value, title, onChange, max = 12 }: {
  icon: LucideIcon; label: string; value: number; title: string; onChange: (n: number) => void; max?: number;
}) {
  const input = useCountInput(value, max, onChange);
  return (
    <FieldBox label="" title={title}>
      <span className={FIELD_TAG}><Icon size={11} strokeWidth={2} />{label}</span>
      <StepBtn title="Fewer pieces" disabled={value <= 1} onClick={() => onChange(value - 1)}><Minus size={10} strokeWidth={2.2} /></StepBtn>
      <input {...input} style={{ ...FIELD_INPUT, width: 24, flexShrink: 0 }} aria-label={`${label} pieces`} />
      <StepBtn title="More pieces" disabled={value >= max} onClick={() => onChange(value + 1)}><Plus size={10} strokeWidth={2.2} /></StepBtn>
    </FieldBox>
  );
}
/** Arkalık kartı için KOMPAKT sayı kutusu: [ikon][−][n][+] — etiket yerine bölme ikonu (V / H), dar satıra sığar. */
export function CountMini({ icon: Icon, value, title, onChange, max = 12 }: {
  icon: LucideIcon; value: number; title: string; onChange: (n: number) => void; max?: number;
}) {
  const input = useCountInput(value, max, onChange);
  const step = (d: number, dis: boolean) => (
    <button type="button" disabled={dis} title={d < 0 ? 'Fewer pieces' : 'More pieces'} onClick={e => { stop(e); if (!dis) onChange(value + d); }}
      className={`w-[14px] h-[18px] shrink-0 rounded-[4px] flex items-center justify-center ${dis ? 'text-stone-300 cursor-not-allowed' : 'text-stone-500 hover:bg-[#f3efe8] hover:text-stone-800'}`}>
      {d < 0 ? <Minus size={9} strokeWidth={2.4} /> : <Plus size={9} strokeWidth={2.4} />}
    </button>
  );
  return (
    <div title={title} onClick={stop}
      className="min-w-0 h-full min-h-[26px] px-[2px] flex items-center justify-between gap-0 overflow-hidden rounded-[7px] bg-white ring-1 ring-[#e6e0d6] shadow-[0_1px_0_rgba(40,30,20,0.03)]">
      <Icon size={12} strokeWidth={2} className="shrink-0 text-[#a8a29e] ml-[1px]" />
      {step(-1, value <= 1)}
      <input {...input} style={{ ...FIELD_INPUT, width: 18, flexShrink: 0 }} />
      {step(1, value >= max)}
    </div>
  );
}
/** Spacing kutusu: hedef parça ölçüsü (mm); boş girilirse hedef kalkar (parçalar olduğu gibi kalır). */
export function SizeBox({ icon: Icon, label, value, title, onChange }: {
  icon: LucideIcon; label: string; value: number | null; title: string; onChange: (mm: number | null) => void;
}) {
  const [draft, setDraft] = useDraft(value);
  const commit = () => {
    if (draft == null) return;
    const t = draft.trim();
    setDraft(null);
    if (t === '') { if (value != null) onChange(null); return; }
    const v = parseNum(t);
    if (Number.isFinite(v) && v > 0 && v !== value) onChange(v);
  };
  return (
    <FieldBox label="" title={title} accent={value != null}>
      <span className={FIELD_TAG}><Icon size={11} strokeWidth={2} />{label}</span>
      <input type="text" inputMode="decimal" value={draft ?? (value != null ? String(value) : '')} placeholder="mm" onChange={e => setDraft(e.target.value)}
        onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }} onClick={stop}
        className="yago-field" style={{ ...FIELD_INPUT, width: 44, textAlign: 'right', ...(value != null ? { color: '#9a3412' } : {}) }}
        aria-label={`${label} target size`} />
      {value != null && (
        <ClearBtn title="Clear the spacing target (the current pieces stay; change them with Count)" label={`Clear ${label} target size`}
          onClick={() => { setDraft(null); onChange(null); }} />
      )}
    </FieldBox>
  );
}
const SELECT_CLASS = 'h-[28px] pl-2.5 pr-7 rounded-[7px] bg-white ring-1 ring-[#e6e0d6] shadow-[0_1px_0_rgba(40,30,20,0.03)] text-[11.5px] font-semibold '
  + 'text-stone-700 appearance-none outline-none cursor-pointer hover:ring-[#dcd4c8] focus:ring-orange-400/60 transition-shadow duration-150';
function SelectBox<T extends string>({ value, options, title, onChange }: { value: T; options: Array<[T, string]>; title: string; onChange: (v: T) => void }) {
  return (
    <div className="relative shrink-0" onClick={stop} title={title}>
      <select value={value} onChange={e => onChange(e.target.value as T)} className={SELECT_CLASS} style={{ fontFamily: UI_FONT }}>
        {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <ChevronDown size={12} strokeWidth={2.2} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-stone-400" />
    </div>
  );
}
export type SplitMode = 'count' | 'ref' | 'spacing';
const SPLIT_MODE_TITLE: Record<SplitMode, string> = {
  count: 'Count — split the selected region by number of pieces (V side by side · H stacked)',
  ref: 'Panel ref — click a door-reference divider / shelf (3D view or schematic): the door splits through its middle; door sizes stay, afterwards Left / Center / Right moves the panel',
  spacing: 'Spacing — split by target piece size (mm); the number of pieces follows the region length and body resizes',
};
export const SplitModeSelect = ({ value, onChange }: { value: SplitMode; onChange: (v: SplitMode) => void }) => (
  <SelectBox value={value} onChange={onChange} title={SPLIT_MODE_TITLE[value]} options={[['count', 'Count'], ['ref', 'Panel ref'], ['spacing', 'Spacing']]} />
);
/** Arkalık seçme şeridinde tip. */
export const BackTypeSelect = ({ value, onChange }: { value: BackPlacement; onChange: (v: BackPlacement) => void }) => (
  <SelectBox value={value} onChange={onChange} title={BACK_TYPE_TITLE[value]} options={[['outer', BACK_TYPE_LABEL.outer], ['inner', BACK_TYPE_LABEL.inner]]} />
);
export const PlacementSelect = ({ value, onChange }: { value: 'outer' | 'inner'; onChange: (v: 'outer' | 'inner') => void }) => (
  <SelectBox value={value} onChange={onChange} options={[['outer', 'Outer'], ['inner', 'Inner']]}
    title={value === 'outer' ? 'Outer door — over the reference panels, in front of them' : 'Inner (inset) door — between the reference panels, flush with their front'} />
);

export const SectionHead = ({ label, count, rule = true, className = 'px-1 pt-2 pb-1' }: { label: string; count?: number; rule?: boolean; className?: string }) => (
  <div className={`${className} flex items-center gap-2`}>
    <span style={SECTION_LABEL}>{label}</span>
    {count != null && <span className="text-[10.5px] font-medium tabular-nums text-stone-300">{count}</span>}
    {rule && <div className="flex-1 h-px bg-[#efeae2]" />}
  </div>
);

export const LIST_CSS = '@keyframes yagoExpand{from{opacity:0;clip-path:inset(0 0 100% 0);transform:translateY(-4px)}to{opacity:1;clip-path:inset(0 0 0 0);transform:none}}'
  + '.yago-expand{animation:yagoExpand 260ms cubic-bezier(.2,.7,.2,1) both}';
