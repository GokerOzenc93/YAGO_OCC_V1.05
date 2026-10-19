import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Check, X, type LucideIcon, Lock, SlidersHorizontal, Crosshair, LayoutPanelTop, Rows3, Columns3, DoorClosed, SendToBack, Footprints, Shapes,
  ChevronRight, Minus, Plus, ChevronDown, Pencil, Trash2, Unlink, MoveVertical, Move, RotateCw, GripVertical, ArrowUp, Box, Move3d, Equal,
  SplitSquareVertical, SplitSquareHorizontal, RotateCcw, Container,
} from 'lucide-react';
import { type Box3 } from 'three';
import { UI_FONT } from './Ui';
import {
  stop, parseNum, DoorTypeIcon, type Kids, fmt1, panelDims, geoAxes, PREVIEW_FRAME, PREVIEW_HEIGHT, PREVIEW_BG, PanelPreview2D, BackTypeIcon,
  GroupSchematic, DoorSchematic, BackSchematic,
} from './PanelSchematics';
import {
  type BackPlacement, type DoorType, type CornerKey, type JoinPass, type Shape, type QuickBodyConfig, type QuickBodyBase, type PanelGroup,
  useStoreFields, useAppStore, type VirtualFace, type DoorGroup, type BackGroup, shapeById, childPanelsOf, panelOfVf, requestRebuild,
} from '../store';
import {
  BACK_TYPE_TITLE, BACK_TYPE_LABEL, vfBackBound, isBackVf, confirmBackPick, backLeaves, backPieceOf, backLeafOfMember, backGroupName, setVfBackBound,
  backMemberCount, renameBackGroup, deleteBackGroupWithMembers, solveBackGroup, backFallbackSolution, findSolvedBackNode, setBackNodeSplit,
  splitBackAtPanel, findBackNode, backSetbackOf, backGrooveClearOverridden, backGrooveClearOf, setBackThickness, setBackSetback, setBackGrooveClear,
  resetBackGrooveClear, setBackPlacement, collectBackCuts, backNearPanels, editBackSize, toggleBackSizeLock, setBackSplitGap, setBackEdgeInset,
  setBackJointIn, backLayoutSnapshot, restoreBackLayout, type BackLayoutSnap, setBackEdgeCover, setBackEdgeRel, edgeRelOf, setBackJointRel,
  backJointRelOf,
} from './BackService';
import {
  DOOR_TYPES, DOOR_TYPE_TITLE, DOOR_TYPE_LABEL, isDoorVf, confirmDoorPick, doorMembersOf, doorGroupName, setVfDoorBound, doorMemberCount,
  renameDoorGroup, deleteDoorGroupWithMembers, doorPlacementLabel, solveDoorTree, findSolvedNode, setDoorNodeSplit, splitDoorAtPanel, doorLeaves,
  addPanelAtDoorJoint, doorJoints, doorPlaneAxes, doorNearPanels, doorSpacingTargetsInScope, clearDoorSpacing, setDoorNodeSpacing, setDoorPlacement,
  setDoorThickness, equalizeDoorGroup, doorJointParts, setDoorLeafTypes, collectDoorCuts, editDoorSize, toggleDoorSizeLock, setDoorSplitGap,
  setDoorEdgeGap, editDoorLeafSize, setDoorLeafGap, doorLayoutSnapshot, restoreDoorLayout, type DoorLayoutSnap, setDoorHalfOverlay, setDoorEdgeOverlay,
  setDoorJointRef, setDoorJointOverlay,
} from './DoorService';
import {
  round1, localBboxOf, effectiveBodyGeometry, confirmRefFaceExtrude, executeFaceExtrude, confirmPanelMoveRef, executePanelMoveFixed, executePanelMove,
  confirmPanelRotateRef, executePanelRotate, type ExtrudeStep, type TransformStep, updateExtrudeStep, updateTransformStep, deleteExtrudeStep,
  deleteTransformStep, createPanelFromVirtualFace, convertReplicadToThreeGeometry, genId, getFacesAndGroups, isFlatNormal, dominantAxisLabel,
  findExistingStepForFace,
} from './Geometry';
import {
  legSpots, effectiveJoins, panelOrderFor, confirmRefCavityExtrude, executeCavityExtrude, updateCavityStep, deleteCavityStep, groupName,
  confirmVolumePick, type TreeNode, findNode, treeLeaves, memberThicknessesOf, bodyLegsOf, legHeightOf, setBodyLegs, boxSpan, groupKindLabel,
  renamePanelGroup, deletePanelGroupWithMembers, setGroupCount, startCavityEdit, startGroupRepick, setGroupTargetGap, equalizeGroupGaps,
  previewGroupGap, editGroupGap, toggleGroupGapLock, groupLayoutSnapshot, restoreGroupLayout, type GroupLayoutSnap, previewGroupMemberThickness,
  setGroupMemberThickness, applyQuickBody, quickBodyOf, quickBodyVfsOf, removeQuickBody,
} from './PanelGroupService';
import { confirmBodyPanelPlacement } from './Scene';

/* PANEL EDİTÖRÜ — 1) şerit + liste satırı parçaları · 2) kart blokları (ipucu hücresi, kanal / ayak diyagramları, hızlı gövde) ·
   3) şeritler, adım listeleri, yerleştirme şeritleri · 4) panel listesi ve kartlar. Şemalar PanelSchematics.tsx'te. */

export const AXIS_COLORS: Record<string, string> = {
  'x+': '#dc2626', 'x-': '#b91c1c', 'y+': '#16a34a', 'y-': '#15803d', 'z+': '#2563eb', 'z-': '#1d4ed8', x: '#dc2626', y: '#16a34a', z: '#2563eb',
};
export const SECTION_LABEL: React.CSSProperties = { fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#b5ada3' };

// ═════════════════════════════════════════ 1. ŞERİT + LİSTE SATIRI PARÇALARI ═════════════════════════════════════════
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
type RowKind = 'body' | 'shelf' | 'divider' | 'door' | 'back' | 'legs' | 'quick';
const ROW_KIND_ICON: Record<RowKind, LucideIcon> = {
  body: LayoutPanelTop, shelf: Rows3, divider: Columns3, door: DoorClosed, back: SendToBack, legs: Footprints, quick: Container,
};
const ROW_KIND_TITLE: Record<RowKind, string> = {
  body: 'Body panel', shelf: 'Shelf', divider: 'Divider', door: 'Door', back: 'Back panel', legs: 'Legs', quick: 'Quick body',
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

// ══════════════════════════════════════════════════ 2. KART BLOKLARI ══════════════════════════════════════════════════
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
   Tek seferlik yapılandırma: taban (Plain / Legs / Plinth), dört köşe birleşimi, baza / ayak ölçüleri, arkalık. Onay → applyQuickBody (PanelGroupService).
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
          ? cell('Leg count', 'lc', <QbSelect value={String(legs.count)} options={countOpts(countOptions)} onChange={v => onChange({ count: parseInt(v, 10) })} />)
          : (
            <ReadCell label="Layout" title="Leg layout">
              <span className="whitespace-nowrap text-[11px] font-semibold text-stone-500">
                {legs.count === 5 ? '4 + centre' : legs.count === 6 ? '4 + front/rear' : 'corners'}
              </span>
            </ReadCell>
          )}
        {num('Diameter', 'ld', legs.diameter, v => onChange({ diameter: v }), false, 5)}
        {heightEditable ? num('Leg height', 'lh', legs.height, v => onChange({ height: v }), false, 1) : cell('Leg height', 'lh', (
          <ReadValue color={countOptions.length ? '#57534e' : '#c7beb1'} title={countOptions.length ? "Read from the bottom panel's underside" : '= plinth height'}>
            {fmt1(heightReadout ?? legs.height)}
          </ReadValue>
        ), true)}
        {num('Side offset', 'ls', legs.side, v => onChange({ side: v }))}
        {num('Front offset', 'lf', legs.front, v => onChange({ front: v }))}
        {num('Rear offset', 'lr', legs.rear, v => onChange({ rear: v }))}
      </div>
    </div>
  );
}

/* BÖLÜM KUTUSU: hızlı gövde panelinin üç bölümü (gövde panelleri · ayaklar · arkalık) ayrı kutularda, başlıkta bölümün ana seçimi
   (Goker: "gövde, arkalık ve ayak kısımları iç içe giriyor"). */
function QbSection({ title, sub, trailing, children }: Kids & { title: string; sub?: string; trailing?: React.ReactNode }) {
  return (
    <div className="rounded-[10px] ring-1 ring-[#e6e0d6] bg-white overflow-hidden shadow-[0_1px_2px_rgba(68,64,60,0.04)]">
      <div className="flex items-center gap-2 pl-2.5 pr-1.5 h-[32px] bg-[#f6f2ec] border-b border-[#ebe5dc]">
        <span style={{ ...SECTION_LABEL, color: '#57534e' }}>{title}</span>
        {sub && <span className="min-w-0 truncate text-[10px] font-medium text-stone-400">{sub}</span>}
        <div className="flex-1" />
        {trailing}
      </div>
      <div className="p-1.5">{children}</div>
    </div>
  );
}
const QbNote = ({ children }: Kids) => <div className="px-1 py-1 text-[10.5px] leading-snug text-stone-400">{children}</div>;
const QB_BACK_ITEMS: SegItem[] = [
  { key: 'none', label: 'None', title: 'No back panel' },
  { key: 'outer', label: BACK_TYPE_LABEL.outer, title: 'Nailed onto the rear edges of the body panels' },
  { key: 'inner', label: BACK_TYPE_LABEL.inner, title: 'Sits in a groove cut into the body panels, set back from the rear' },
];
const QB_LEG_OPTS = (ns: number[]) => ns.map(n => ({ v: String(n), label: n === 0 ? 'None' : `${n} legs` }));

/* HIZLI GÖVDE PANELİ — liste alanının üstünde (üst şerit yapışık) ya da Body satırının içinde (`revise`: ayarlar gövdeden gelir,
   ✓ panelleri yerinde yeniden kurar). Üç ayrı bölüm: GÖVDE PANELLERİ (köşeler, kalınlık, baza) · AYAKLAR · ARKALIK. */
export function QuickBodyPanel({ shape, cfg, setCfg, busy, existingCount, onApply, onExit, revise }: {
  shape: Shape; cfg: QuickBodyConfig; setCfg: (p: Partial<QuickBodyConfig>) => void; busy: boolean; existingCount: number; onApply: () => void;
  onExit: () => void; revise?: boolean;
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
  const summary = `${panelCount} panels${b.enabled ? ` + ${BACK_TYPE_LABEL[b.placement].toLowerCase()} back` : ''}${legCount ? ` + ${legCount} legs` : ''}`;
  const existing = existingCount ? `${existingCount} panel${existingCount === 1 ? '' : 's'} already on the body · ` : '';
  const status = busy ? 'Building panels…' : cyclic ? 'Corner joints form a cycle — sides will pass first' : revise ? `Rebuild: ${summary}` : `${existing}${summary}`;
  const statusTitle = revise
    ? 'Re-applies these settings to the body panels placed by Quick body: the same rows are updated in place (same order, first in the list), '
      + 'parts that no longer apply are removed, the back panel and legs follow. Shelves, dividers and doors are kept; manual steps on the body panels are reset.'
    : undefined;
  const sub = (s: React.ReactNode) => <span className="text-[10px] font-medium text-stone-400" style={{ fontFamily: UI_FONT }}>{s}</span>;
  const backKey = b.enabled ? b.placement : 'none';
  return (
    <div style={{ fontFamily: UI_FONT }}>
      <div className={revise ? '' : 'sticky top-0 z-[3]'} style={DOCK_STRIP}>
        <div style={DOCK_ROW}>
          <span style={dockAxisTag('#44403c')} title="Base: how the body meets the floor">BASE</span>
          <div className="flex-1 min-w-0"><Segmented items={QB_BASE_ITEMS} active={cfg.base} onPick={k => setBase(k as QuickBodyBase)} /></div>
          <ApplyBtn enabled={!busy} onClick={onApply} title={revise ? 'Rebuild the body panels with these settings' : 'Place body panels'} />
          {!revise && <ExitBtn onClick={onExit} />}
        </div>
        <div style={{ ...DOCK_ROW, paddingTop: 0 }}><DockStatus ready={!busy && !cyclic} text={status} title={statusTitle} /></div>
      </div>
      <div className="px-1.5 pt-1.5 pb-2 flex flex-col gap-1.5" onMouseLeave={() => setHint(null)}>
        {/* 1 · GÖVDE PANELLERİ: dört köşe birleşimi (dolap çizimi yok — Goker), kalınlık + ölçü, bazalıda baza ölçüleri */}
        <QbSection title="Body panels" sub={`${panelCount} panels · ${isPlinth ? 'sides reach the floor' : isLegs ? 'raised on legs' : 'on the floor'}`}>
          <div className="pb-1 px-0.5 flex items-center gap-2">
            <span style={SECTION_LABEL}>Corner joints</span>
            <span className="text-[10px] text-stone-400">click a corner to swap which panel passes</span>
          </div>
          <CornerJointTiles joins={joins} lockBottom={isPlinth} active={hint} onCorner={toggleCorner} onHover={c => setHint(c ? `c-${c}` : null)} />
          <div className="mt-1.5 grid grid-cols-2 gap-x-1" style={QB_CELL_ROW}>
            {num('Panel thickness', 't', cfg.thickness, v => setCfg({ thickness: v }), false, 1)}
            <ReadCell label="Body size" title="Body width × height × depth">
              <span className="whitespace-nowrap text-[11px] font-semibold text-stone-500 tabular-nums">{fmt1(W)} × {fmt1(H)} × {fmt1(D)}</span>
            </ReadCell>
          </div>
          {isPlinth && <>
            <div className="pt-2 pb-1 px-0.5 flex items-center gap-2">
              <span style={SECTION_LABEL}>Plinth</span>
              <span className="text-[10px] text-stone-400">kick panels under the bottom panel, between the sides</span>
            </div>
            <div className="grid grid-cols-2 gap-x-1" style={QB_CELL_ROW}>
              {num('Plinth height', 'ph', cfg.plinth.height, v => setPlinth({ height: v }), false, 1)}
              {num('Front plinth setback', 'pf', cfg.plinth.front, v => setPlinth({ front: v }))}
              {cell('Rear plinth', 'pr', <>
                <span className="text-[10.5px] font-medium text-stone-400 pr-1">{cfg.plinth.rearPlinth ? 'on' : 'off'}</span>
                <QbSwitch on={cfg.plinth.rearPlinth} title="Rear plinth on / off" onToggle={() => setPlinth({ rearPlinth: !cfg.plinth.rearPlinth })} />
              </>)}
              {num('Rear plinth inset', 'pri', cfg.plinth.rear, v => setPlinth({ rear: v }), !cfg.plinth.rearPlinth)}
            </div>
          </>}
        </QbSection>

        {/* 2 · AYAKLAR: adet başlıkta; plan diyagramı + ölçüler */}
        <QbSection title="Legs" sub={isLegs ? 'body height includes the legs' : isPlinth ? 'optional, under the bottom panel' : undefined}
          trailing={isPlain ? <span className="pr-1 text-[11px] font-semibold text-stone-300">None</span>
            : <SelectBox value={String(legCount)} title="Number of legs" options={QB_LEG_OPTS(isLegs ? [4, 5, 6] : [0, 4, 5, 6]).map(o => [o.v, o.label])}
              onChange={v => setLegs({ count: parseInt(v, 10) as 0 | 4 | 5 | 6 })} />}>
          {legCount > 0 ? (
            <LegsBlock legs={{ ...cfg.legs, count: legCount, height: isPlinth ? cfg.plinth.height : cfg.legs.height }} W={W} D={D} heightEditable={isLegs}
              heightReadout={isPlinth ? cfg.plinth.height : undefined} countOptions={[]} hint={hint} onHint={setHint}
              onChange={p => setLegs(p as Partial<QuickBodyConfig['legs']>)} />
          ) : (
            <QbNote>{isPlain ? 'A plain base sits on the floor — choose Legs or Plinth for legs.' : 'No legs — the plinth carries the body. Pick a count to add legs under the bottom panel.'}</QbNote>
          )}
        </QbSection>

        {/* 3 · ARKALIK: tip başlıkta; arkalık kartıyla aynı kesit diyagramı, büyük */}
        <QbSection title="Back panel" sub={b.enabled ? (grooved ? 'in a groove, set back from the rear' : 'nailed on the rear edges') : undefined}
          trailing={<div style={{ width: 206 }}><Segmented height={22} items={QB_BACK_ITEMS} active={backKey}
            onPick={k => setBack(k === 'none' ? { enabled: false } : { enabled: true, placement: k as BackPlacement })} /></div>}>
          {b.enabled ? (
            <div className="flex flex-col gap-1.5">
              <div className="w-full flex" style={{ height: 196 }}>
                <BackGrooveDiagram active={hint === 'bi' ? 'in' : hint && hint.startsWith('b') ? hint.slice(1) : null} grooved={grooved} t={b.thickness}
                  setback={grooved ? b.setback : 0} front={b.clear.front} rear={b.clear.back} depth={b.clear.depth} inset={b.inset} className="w-full h-full" />
              </div>
              <div className="grid grid-cols-2 gap-x-1" style={QB_CELL_ROW}>
                {num('Thickness', 'bt', b.thickness, v => setBack({ thickness: v }), false, 1)}
                {num('Setback from rear', 'bsetback', b.setback, v => setBack({ setback: v }), !grooved)}
                {num('Groove entry (In)', 'bi', b.inset, v => setBack({ inset: v }), !grooved)}
                {num('Groove bottom gap', 'bgd', b.clear.depth, v => setClear({ depth: v }), !grooved)}
                {num('Groove gap · front', 'bgf', b.clear.front, v => setClear({ front: v }), !grooved)}
                {num('Groove gap · rear', 'bgb', b.clear.back, v => setClear({ back: v }), !grooved)}
                <ReadCell label="Groove width × depth" className={`col-span-2 ${grooved ? '' : 'opacity-60'}`}>
                  <ReadValue color="#57534e" className="whitespace-nowrap">{grooved ? <>
                    {fmt1(b.thickness + b.clear.front + b.clear.back)}{sub(' × ')}{fmt1(b.inset + b.clear.depth)}
                    {sub(<> (In {fmt1(b.inset)} + {fmt1(b.clear.depth)})</>)}
                  </> : '—'}</ReadValue>
                </ReadCell>
              </div>
            </div>
          ) : <QbNote>No back panel — the rear stays open. Choose Nailed or Grooved to add one.</QbNote>}
        </QbSection>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════ 3. ŞERİTLER + ADIMLAR ═══════════════════════════════════════════════
/* PANEL EDİTÖRÜ PARÇALARI — Extrude / Hacim / Taşı / Döndür şeritleri, işlem adımları, yerleştirme şeritleri, satır parçaları,
   kapak derzi parçaları ve kapak / arkalık şemalarının ortak bölge seçimi (PanelEditor kullanır). Şeritler store'u kendisi okur;
   değer taslakları PanelEditor'da kalır (eksen değişince orada sıfırlanır). */

type Ax = 'u' | 'v';
type DraftProps = { draft: string; setDraft: (s: string) => void };

/* ───────────── ŞERİTLER (Extrude · Hacim · Taşı · Döndür) ───────────── */

/** Eksen etiketi + sayı girişi (Taşı / Döndür). */
const axisInput = (axis: string, { draft, setDraft }: DraftProps, setValue: (v: number) => void, onEnter: () => void, onEscape: () => void) => (
  <>
    <span style={dockAxisTag(AXIS_COLORS[axis] || '#44403c')}>{axis.toUpperCase()}</span>
    <NumInput autoFocus draft={draft} setDraft={setDraft} setValue={setValue} fallback={0} onEnter={onEnter} onEscape={onEscape} />
  </>
);

/** Yüz extrude (panel) ve hacim (`cavity`) şeridi: Fixed / Dyn / Ref modu, ref durumu ya da değer, onay / çıkış. */
export function ExtrudeDock({ panel, cavity, draft, setDraft }: DraftProps & { panel?: Shape; cavity?: PanelGroup }) {
  const {
    faceExtrudeMode, faceExtrudeSelectedFace, faceExtrudeThickness, faceExtrudeValueMode, faceExtrudeRefCandidate, faceExtrudeClickPoint,
    faceExtrudeCavityGroupId, faceExtrudeCavityFaceNormal,
  } = useStoreFields('faceExtrudeMode', 'faceExtrudeSelectedFace', 'faceExtrudeThickness', 'faceExtrudeValueMode', 'faceExtrudeRefCandidate',
    'faceExtrudeClickPoint', 'faceExtrudeCavityGroupId', 'faceExtrudeCavityFaceNormal');
  if (!faceExtrudeMode || (cavity ? faceExtrudeCavityGroupId !== cavity.id : !panel)) return null;
  const { setFaceExtrudeMode, setFaceExtrudeSelectedFace, setFaceExtrudeRefCandidate, setFaceExtrudeValueMode, setFaceExtrudeThickness, updateShape } =
    useAppStore.getState();
  const hf = faceExtrudeSelectedFace !== null && (!cavity || !!faceExtrudeCavityFaceNormal);
  const isRef = faceExtrudeValueMode === 'ref', isFixed = faceExtrudeValueMode === 'fixed';
  const refPanel = isRef && !!faceExtrudeRefCandidate?.panelId;
  const refFace = refPanel && faceExtrudeRefCandidate!.faceGroupIndex >= 0;
  const exit = () => { setFaceExtrudeSelectedFace(null); setFaceExtrudeMode(false); setFaceExtrudeRefCandidate(null); };
  const onApply = async () => {
    if (!hf) return;
    if (cavity) {
      if (isRef) { if (!refFace) return; await confirmRefCavityExtrude(); }
      else { await executeCavityExtrude(cavity.id, faceExtrudeCavityFaceNormal!, faceExtrudeThickness, isFixed, faceExtrudeClickPoint); exit(); }
      return;
    }
    if (isRef) { if (!refFace) return; await confirmRefFaceExtrude(); }
    else await executeFaceExtrude({ panelShape: panel!, faceGroupIndex: faceExtrudeSelectedFace!, value: faceExtrudeThickness, isFixed, updateShape,
      clickPoint: faceExtrudeClickPoint ?? undefined });
    exit();
  };
  return (
    <div style={DOCK_SHELL}>
      {hf && (
        <DockModeBar active={faceExtrudeValueMode}
          modes={dockModes(['fixed', 'dyn', 'ref'], {
            fixed: { sub: 'Constant', title: cavity ? 'Fixed — cavity size along this axis' : 'Fixed — constant thickness' },
            ref: { sub: 'To face', title: 'Ref — up to a reference face' },
          })}
          onPick={k => { setFaceExtrudeValueMode(k as 'fixed' | 'dyn' | 'ref'); if (k !== 'ref') setFaceExtrudeRefCandidate(null); }} />
      )}
      <div style={DOCK_ROW}>
        {cavity && <span style={dockAxisTag('#44403c')}>VOL</span>}
        {!hf ? <DockStatus text={cavity ? 'Pick a face of the volume in the 3D view' : 'Pick a face in the 3D view'} />
          : isRef ? <DockStatus ready={refFace} text={refFace ? 'Reference face selected' : refPanel ? 'Pick the reference face' : 'Pick the reference panel'} />
          : <NumInput draft={draft} setDraft={setDraft} setValue={setFaceExtrudeThickness} fallback={faceExtrudeThickness}
              onEnter={cavity ? onApply : undefined} onEscape={cavity ? exit : undefined} />}
        {hf && <ApplyBtn enabled={!(isRef && !refFace)} onClick={onApply} />}
        <ExitBtn onClick={exit} />
      </div>
    </div>
  );
}

const MOVE_REF_STEPS = ['Pick the source point', 'Pick the target panel', 'Pick the target point', 'Ready — right-click to confirm'];
export function MoveDock({ panel, ...draft }: DraftProps & { panel?: Shape }) {
  const {
    panelMoveMode, panelMoveAxis, panelMoveValue, panelMoveValueMode, panelMoveRefSourceVertex, panelMoveRefTargetPanelId, panelMoveRefTargetVertex,
  } = useStoreFields('panelMoveMode', 'panelMoveAxis', 'panelMoveValue', 'panelMoveValueMode', 'panelMoveRefSourceVertex', 'panelMoveRefTargetPanelId',
    'panelMoveRefTargetVertex');
  if (!panel || !panelMoveMode) return null;
  const {
    setPanelMoveAxis, setPanelMoveMode, setPanelMoveValue, setPanelMoveValueMode, setPanelMoveRefSourceVertex, setPanelMoveRefTargetPanelId,
    setPanelMoveRefTargetVertex, setSelectedPanelRow, updateShape,
  } = useAppStore.getState();
  const isRef = panelMoveValueMode === 'ref', hasAxis = panelMoveAxis !== null;
  const refStep = !panelMoveRefSourceVertex ? 0 : !panelMoveRefTargetPanelId ? 1 : !panelMoveRefTargetVertex ? 2 : 3;
  const refReady = isRef && refStep === 3;
  const exit = () => { setPanelMoveAxis(null); setPanelMoveMode(false); if (isRef) setSelectedPanelRow(null); };
  const onApply = async () => {
    if (isRef) { if (!refReady) return; await confirmPanelMoveRef(); setSelectedPanelRow(null); }
    else {
      if (!hasAxis) return;
      const move = panelMoveValueMode === 'fixed' ? executePanelMoveFixed : executePanelMove;
      await move({ panelShape: panel, axis: panelMoveAxis!, value: panelMoveValue, updateShape });
    }
    setPanelMoveAxis(null); setPanelMoveValue(0); draft.setDraft('0'); setPanelMoveMode(false);
  };
  return (
    <div style={DOCK_SHELL}>
      <DockModeBar active={panelMoveValueMode}
        modes={dockModes(['dyn', 'fixed', 'ref'], {
          dyn: { sub: 'Relative' }, fixed: { sub: 'Absolute', title: 'Fixed — absolute position' }, ref: { sub: 'To point' },
        })}
        onPick={k => {
          setPanelMoveValueMode(k as 'dyn' | 'fixed' | 'ref');
          if (k === 'ref') { setPanelMoveAxis(null); return; }
          setPanelMoveRefSourceVertex(null); setPanelMoveRefTargetPanelId(null); setPanelMoveRefTargetVertex(null);
        }} />
      <div style={DOCK_ROW}>
        {isRef ? <DockStatus ready={refReady} text={MOVE_REF_STEPS[refStep]} />
          : !hasAxis ? <DockStatus text="Pick a direction arrow in the 3D view" />
          : axisInput(panelMoveAxis!, draft, setPanelMoveValue, onApply, () => { setPanelMoveAxis(null); setPanelMoveMode(false); })}
        <ApplyBtn enabled={isRef ? refReady : hasAxis} onClick={onApply} />
        <ExitBtn onClick={exit} />
      </div>
    </div>
  );
}

const ROTATE_REF_STEPS: Array<[string, string]> = [
  ['1/4 · Pivot point', 'The point the panel rotates around (its own corners or center)'],
  ['2/4 · Aim point', 'The point that will TOUCH the reference face — another point on the SAME panel'],
  ['3/4 · Axis ring', 'Rotation axis: pick the X / Y / Z ring in the scene'],
  ['4/4 · Reference face', 'Click a face on another panel (click the same spot again for the face behind). The panel rotates until the aim point touches it.'],
  ['Ready — right-click to confirm', 'Right-click anywhere in the scene — the link is kept and the reference panel edge is beveled to the slope'],
];
/* Döndürme ref modu: onaydan sonra bağ KALICIDIR — referans taşındıkça panel nişan noktasıyla yeniden döner. */
export function RotateDock({ panel, ...draft }: DraftProps & { panel?: Shape }) {
  const { panelRotateMode, panelRotatePivot, panelRotateAxis, panelRotateValue, panelRotateValueMode, panelRotateRefArmVertex, panelRotateRefFace } =
    useStoreFields('panelRotateMode', 'panelRotatePivot', 'panelRotateAxis', 'panelRotateValue', 'panelRotateValueMode', 'panelRotateRefArmVertex',
      'panelRotateRefFace');
  if (!panel || !panelRotateMode) return null;
  const { setPanelRotateAxis, setPanelRotatePivot, setPanelRotateMode, setPanelRotateValue, setPanelRotateValueMode, setSelectedPanelRow, updateShape } =
    useAppStore.getState();
  const isRef = panelRotateValueMode === 'ref';
  const hasPivot = panelRotatePivot !== null, hasAxis = panelRotateAxis !== null, hasArm = panelRotateRefArmVertex !== null;
  const refReady = isRef && hasPivot && hasArm && hasAxis && !!panelRotateRefFace;
  const exit = () => { setPanelRotateAxis(null); setPanelRotatePivot(null); setPanelRotateMode(false); if (isRef) setSelectedPanelRow(null); };
  const onApply = async () => {
    if (isRef) { if (!refReady) return; await confirmPanelRotateRef(); setPanelRotateMode(false); setSelectedPanelRow(null); return; }
    if (!hasAxis || !hasPivot) return;
    await executePanelRotate({ panelShape: panel, axis: panelRotateAxis!, value: panelRotateValue, pivot: panelRotatePivot!, updateShape });
    setPanelRotateAxis(null); setPanelRotateValue(0); draft.setDraft('0');
  };
  const modeBar = (trailing?: React.ReactNode) => (
    <DockModeBar trailing={trailing} active={panelRotateValueMode}
      modes={dockModes(['dyn', 'ref'], {
        dyn: { sub: 'Angle', title: 'Enter an angle: pivot → axis → degrees' },
        ref: { sub: 'Aim at face', title: 'Rotate to a reference: pivot → aim point → axis → reference face → right-click' },
      })}
      onPick={k => { setPanelRotateValueMode(k as 'dyn' | 'ref'); draft.setDraft('0'); }} />
  );
  // Mod seçilene kadar gizmo null döner (sahnede nokta/halka yok).
  if (panelRotateValueMode === null) return (
    <div style={DOCK_SHELL}>
      {modeBar(<div style={{ display: 'flex', alignItems: 'center' }}><ExitBtn onClick={exit} /></div>)}
      <div style={{ padding: '5px 10px 7px', fontSize: 10.5, fontWeight: 500, color: '#a8a29e', fontFamily: UI_FONT }}>Choose a rotation mode</div>
    </div>
  );
  if (isRef) {
    const [text, hint] = ROTATE_REF_STEPS[!hasPivot ? 0 : !hasArm ? 1 : !hasAxis ? 2 : !panelRotateRefFace ? 3 : 4];
    return (
      <div style={DOCK_SHELL}>
        {modeBar()}
        <div style={DOCK_ROW}>
          <DockStatus ready={refReady} text={text} title={hint} trailing={hasAxis && (
            <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: AXIS_COLORS[panelRotateAxis!] || '#44403c' }}>{panelRotateAxis!.toUpperCase()}</span>
          )} />
          <ApplyBtn enabled={refReady} onClick={onApply} />
          <ExitBtn onClick={exit} />
        </div>
      </div>
    );
  }
  return (
    <div style={DOCK_SHELL}>
      {modeBar()}
      <div style={DOCK_ROW}>
        {hasAxis && hasPivot ? (
          <>
            {axisInput(panelRotateAxis!, draft, setPanelRotateValue, onApply, () => { setPanelRotateAxis(null); setPanelRotateMode(false); })}
            <span style={{ fontSize: 12, fontWeight: 500, color: '#a8a29e', marginLeft: -2 }}>°</span>
            <ApplyBtn enabled onClick={onApply} />
          </>
        ) : hasPivot ? <DockStatus dot="#f59e0b" text="Pick an axis (X/Y/Z ring)" />
          : <DockStatus dot="#06b6d4" text="Pick a pivot point (corners/center)" />}
        <ExitBtn onClick={exit} />
      </div>
    </div>
  );
}

/* ───────────── İŞLEM ADIMLARI ───────────── */

export type StepEdit = { id: string; v: string } | null;
type StepEditProps = { edit: StepEdit; setEdit: (e: StepEdit) => void };
type StepItem = {
  id: string; badge: { label: string; bg: string; color: string }; axis: string; axisColor: string; value: number; unit?: string; tag?: string;
  editable: boolean; save: (v: number) => void; remove: () => void;
};
const STEP_BADGE: Record<string, StepItem['badge']> = {
  move: { label: 'Move', bg: 'rgba(22,163,74,0.08)', color: '#15803d' },
  rotate: { label: 'Rotate', bg: 'rgba(37,99,235,0.08)', color: '#1d4ed8' },
  extrude: { label: 'Ext', bg: 'rgba(217,119,6,0.09)', color: '#b45309' },
};
const VOL_BADGE = { label: 'Vol', bg: 'rgba(14,116,144,0.09)', color: '#0e7490' };

/** Adım listesi: sıra · tür · eksen · değer (✎ → ✓ / ✗) · F/D/R · sil. */
function StepList({ label, maxHeight, steps, edit, setEdit }: StepEditProps & { label: string; maxHeight: number; steps: StepItem[] }) {
  const tag = (txt: string) => <span className="shrink-0 text-[10px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px] bg-[#f3efe8] text-stone-500">{txt}</span>;
  const save = (s: StepItem) => { const v = parseFloat(edit?.v ?? ''); if (!isNaN(v)) s.save(v); };
  return (
    <div className="shrink-0 mt-2" style={{ fontFamily: UI_FONT }}>
      <SectionHead label={label} count={steps.length} className="px-1 pb-1.5" />
      <div className="overflow-y-auto" style={{ maxHeight }}>
        <div className="flex flex-col gap-[2px] p-px">
          {steps.map((s, idx) => (
            <div key={s.id} className="group/step flex items-center gap-1.5 pl-1.5 pr-1 h-[30px] rounded-[9px] bg-[#fdfcfa] ring-1 ring-[#ece7df] shadow-[0_1px_0_rgba(68,64,60,0.025)] hover:bg-white hover:ring-[#e2dbd0] transition-colors duration-150">
              <span className="shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#f3efe8] text-[10.5px] font-semibold text-stone-500 tabular-nums leading-none">{idx + 1}</span>
              <span className="shrink-0 text-[10.5px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px]" style={{ background: s.badge.bg, color: s.badge.color }}>{s.badge.label}</span>
              <span className="shrink-0 min-w-[24px] text-center text-[10.5px] font-bold px-1 h-[18px] leading-[18px] rounded-[5px] bg-[#f5f2ec]" style={{ color: s.axisColor }}>{s.axis}</span>
              {edit?.id === s.id ? (
                <>
                  <input type="text" inputMode="numeric" autoFocus value={edit.v}
                    onChange={e => setEdit({ id: s.id, v: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Escape') setEdit(null); else if (e.key === 'Enter') save(s); }}
                    className="flex-1 min-w-0 h-[22px] text-center font-mono text-[12px] font-medium tabular-nums text-stone-800 bg-white border border-[#e6e0d6] rounded-[6px] outline-none focus:border-orange-400/60 focus:shadow-[0_0_0_2px_rgba(249,115,22,0.10)]" />
                  <button onClick={() => save(s)} style={iconBtn('#5b5346')}><Check size={11} /></button>
                  <button onClick={() => setEdit(null)} style={iconBtn('#a8a29e')}><X size={11} /></button>
                </>
              ) : (
                <>
                  <span className="flex-1 pl-1 font-mono text-[12px] font-medium text-stone-700 tabular-nums">{s.value}{s.unit}</span>
                  {s.tag && tag(s.tag)}
                  {s.editable && (
                    <button onClick={() => setEdit({ id: s.id, v: String(s.value) })} style={iconBtn('#a8a29e')}
                      className="hover:!bg-[#f3efe8] hover:!text-stone-700"><Pencil size={10.5} strokeWidth={1.9} /></button>
                  )}
                  <button onClick={s.remove} style={iconBtn('#a8a29e')}
                    className="hover:!bg-red-50 hover:!text-red-500"><Trash2 size={10.5} strokeWidth={1.9} /></button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
/** Panel adımları (extrude + taşı / döndür, zaman sırasıyla). Ref adımlarında donmuş value değil, çözülen gerçek miktar gösterilir. */
export function PanelSteps({ panel, ...edit }: StepEditProps & { panel?: Shape }) {
  const ext: ExtrudeStep[] = panel?.parameters?.extrudeSteps || [], tr: TransformStep[] = panel?.parameters?.transformSteps || [];
  if (!panel || (!ext.length && !tr.length)) return null;
  const { updateShape } = useAppStore.getState();
  const item = (s: { id: string; timestamp: number }, type: string, axis: string, value: number, isRef: boolean, tag: string | undefined) => {
    const isExt = type === 'extrude';
    return {
      ts: s.timestamp, id: s.id, badge: STEP_BADGE[type] || STEP_BADGE.move, axis: axis.toUpperCase(),
      axisColor: AXIS_COLORS[axis] || '#57534e', value, unit: type === 'rotate' ? '°' : '', tag, editable: !((isExt || type === 'rotate') && isRef),
      save: async (v: number) => { await (isExt ? updateExtrudeStep : updateTransformStep)(panel, s.id, v, updateShape); edit.setEdit(null); },
      remove: () => { void (isExt ? deleteExtrudeStep : deleteTransformStep)(panel, s.id, updateShape); },
    };
  };
  const steps = [
    ...ext.map(s => item(s, 'extrude', s.axisLabel, s.resolvedValue != null ? s.resolvedValue : s.value, !!s.refShapeId,
      s.isFixed !== undefined ? (s.refShapeId ? 'R' : s.isFixed ? 'F' : 'D') : undefined)),
    ...tr.map(s => item(s, s.type, s.axis, s.type === 'rotate' && typeof s.resolvedValue === 'number' ? s.resolvedValue : s.value,
      !!s.refTargetPanelId, s.refTargetPanelId ? 'R' : undefined)),
  ].sort((a, b) => a.ts - b.ts);
  return <StepList label="Steps" maxHeight={200} steps={steps} {...edit} />;
}
/** Hacim (cavity) adımları. */
export function VolumeSteps({ group: g, ...edit }: StepEditProps & { group: PanelGroup }) {
  const steps = g.cavitySteps || [];
  if (!steps.length) return null;
  const items: StepItem[] = [...steps].sort((a, b) => a.timestamp - b.timestamp).map(st => {
    const isRef = !!st.refShapeId, ax = st.axisLabel.toLowerCase();
    return {
      id: st.id, badge: VOL_BADGE, axis: st.axisLabel.toUpperCase(), axisColor: AXIS_COLORS[ax] || AXIS_COLORS[ax[0]] || '#57534e',
      value: isRef && st.resolvedValue != null ? st.resolvedValue : st.value, tag: isRef ? 'R' : st.isFixed ? 'F' : 'D', editable: !isRef,
      save: v => { void updateCavityStep(g.id, st.id, v); edit.setEdit(null); }, remove: () => { void deleteCavityStep(g.id, st.id); },
    };
  });
  return <StepList label="Volume steps" maxHeight={160} steps={items} {...edit} />;
}

/* ───────────── YERLEŞTİRME ŞERİTLERİ ───────────── */

const rectTxt = (r: { u0: number; u1: number; v0: number; v1: number }) => `${Math.round(r.u1 - r.u0)}×${Math.round(r.v1 - r.v0)}`;

/* Ortak yerleştirme şeridi: ad ve (kapakta) outer/inner yerleştirme ÖNCESİ seçilir; Enter = sahnede sağ tık. */
function PlacementDock({ tag, defaultName, showName = true, ready, status, onConfirm, onExit, confirmTitle, lead }: {
  tag: string; defaultName: string; showName?: boolean; ready: boolean; status: string;
  onConfirm: () => void; onExit: () => void; confirmTitle: string; lead?: React.ReactNode;
}) {
  const name = useAppStore(s => s.placementName);
  return (
    <div style={DOCK_STRIP}>
      <div style={DOCK_ROW}>
        <span style={dockAxisTag('#44403c')}>{tag}</span>
        {lead}
        {showName ? (
          <FieldBox label="" title={`Name of the new ${defaultName.toLowerCase()} (empty = ${defaultName})`}>
            <input type="text" autoFocus value={name} placeholder={defaultName} spellCheck={false}
              onChange={e => useAppStore.getState().setPlacementName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && ready) onConfirm(); if (e.key === 'Escape') onExit(); }}
              onClick={stop} className="yago-field yago-field-text"
              style={{ ...FIELD_INPUT, flex: 1, width: 'auto', textAlign: 'left', fontFamily: UI_FONT }} />
          </FieldBox>
        ) : <DockStatus ready={ready} text={status} />}
        <ApplyBtn enabled={ready} onClick={onConfirm} title={confirmTitle} />
        <ExitBtn onClick={onExit} />
      </div>
      {showName && <div style={{ ...DOCK_ROW, paddingTop: 0 }}><DockStatus ready={ready} text={status} /></div>}
    </div>
  );
}
/** Liste üstüne yapışık yerleştirme şeritleri: panel yüzü · raf/dikme hacmi (ya da grubu yeniden konumlama) · kapak · arkalık. */
export function PlacementDocks({ shape }: { shape: Shape | undefined }) {
  const {
    virtualFaces, panelGroups, raycastMode, raycastPendingVf, volumePickMode, volumePickGroupId, volumePickCandidates, volumePickIndex,
    doorPickMode, doorPickCandidates, doorPickIndex, doorPickPlacement, backPickMode, backPickCandidates, backPickIndex, backPickPlacement,
  } = useStoreFields('virtualFaces', 'panelGroups', 'raycastMode', 'raycastPendingVf', 'volumePickMode', 'volumePickGroupId', 'volumePickCandidates',
    'volumePickIndex', 'doorPickMode', 'doorPickCandidates', 'doorPickIndex', 'doorPickPlacement', 'backPickMode', 'backPickCandidates', 'backPickIndex',
    'backPickPlacement');
  const { setRaycastMode, setVolumePickMode, setDoorPickMode, setDoorPickPlacement, setBackPickMode, setBackPickPlacement } = useAppStore.getState();
  const noShape = 'Select a body first';
  const boundCount = (bound: (f: VirtualFace) => boolean) => (shape ? virtualFaces.filter(f => f.shapeId === shape.id && bound(f)).length : 0);

  const raycast = () => {
    const ready = !!shape && !!raycastPendingVf;
    const stackBase = virtualFaces.find(f => f.id === raycastPendingVf?.stackBaseVfId);
    return (
      <PlacementDock tag="PANEL" defaultName="Panel" ready={ready} confirmTitle="Place panel"
        status={!shape ? noShape
          : ready ? `${stackBase ? `In front of ${stackBase.description || 'panel'} (on its inner face)` : 'Face selected'}`
            + ' — click again for the next region · right-click: place'
          : 'Click a body face in the 3D view'}
        onConfirm={() => confirmBodyPanelPlacement(useAppStore.getState().raycastPendingVf)} onExit={() => setRaycastMode(false)} />
    );
  };
  const volume = (mode: 'shelf' | 'divider') => {
    const n = volumePickCandidates.length, ready = !!shape && n > 0, cur = volumePickCandidates[volumePickIndex];
    const reloc = volumePickGroupId ? panelGroups.find(g => g.id === volumePickGroupId) : undefined;
    const kind = mode === 'shelf' ? 'Shelf' : 'Divider';
    return (
      <PlacementDock tag={reloc ? `RELOCATE · ${groupName(reloc).toUpperCase()}` : kind.toUpperCase()} defaultName={kind} showName={!reloc} ready={ready}
        status={!shape ? noShape
          : n === 0 ? (reloc ? 'Click the new volume (only panels before this group bound it)' : 'Click inside a volume in the 3D view')
          : `Volume ${volumePickIndex + 1}/${n} · ${cur?.shape === 'box' ? 'Box' : 'Shaped'} — click: next · right-click: ${reloc ? 'relocate' : 'place'}`}
        onConfirm={() => { if (ready && shape) confirmVolumePick(shape.id, mode, volumePickCandidates[volumePickIndex]); }}
        onExit={() => setVolumePickMode(null)} confirmTitle={reloc ? 'Relocate group to this volume' : `Place ${kind.toLowerCase()}`} />
    );
  };
  const door = () => {
    const n = doorPickCandidates.length, ready = !!shape && n > 0, cur = doorPickCandidates[doorPickIndex];
    const boundN = boundCount(f => !!f.doorBound && !isDoorVf(f));
    return (
      <PlacementDock tag="DOOR" defaultName="Door" ready={ready} confirmTitle="Place door"
        lead={<PlacementSelect value={doorPickPlacement} onChange={setDoorPickPlacement} />}
        status={!shape ? noShape
          : n === 0 ? (boundN ? `Click a body face · ${boundN} door ref${boundN === 1 ? '' : 's'}` : 'No door refs — body edges bound the door · click a body face')
          : `Door ${doorPickIndex + 1}/${n} · ${rectTxt(doorPickPlacement === 'inner' ? cur.inner : cur.outer)}${cur.rot ? ' · angled (follows reference)' : ''}`
            + ' — click: next · right-click: place'}
        onConfirm={() => { if (ready && shape) confirmDoorPick(shape.id, doorPickCandidates[doorPickIndex]); }} onExit={() => setDoorPickMode(false)} />
    );
  };
  // ARKALIK şeridi (BackService): tıklama hangi yüzden gelse arka yüze taşınır; tip = Nailed / Grooved.
  const back = () => {
    const n = backPickCandidates.length, ready = !!shape && n > 0, cur = backPickCandidates[backPickIndex];
    const boundN = boundCount(f => vfBackBound(f) && !isBackVf(f));
    return (
      <PlacementDock tag="BACK" defaultName="Back" ready={ready} confirmTitle="Place back panel"
        lead={<BackTypeSelect value={backPickPlacement} onChange={setBackPickPlacement} />}
        status={!shape ? noShape
          : n === 0 ? (boundN ? `Click the body (taken on its back face) · ${boundN} back ref${boundN === 1 ? '' : 's'}`
            : 'No back refs — body edges bound the back · click the body (taken on its back face)')
          : `Back ${backPickIndex + 1}/${n} · ${rectTxt(backPickPlacement === 'inner' ? cur.inner : cur.outer)} — click: next · right-click: place`}
        onConfirm={() => { if (ready && shape) confirmBackPick(shape.id, backPickCandidates[backPickIndex]); }} onExit={() => setBackPickMode(false)} />
    );
  };
  return <>{raycastMode && raycast()}{volumePickMode && volume(volumePickMode)}{doorPickMode && door()}{backPickMode && back()}</>;
}

/* ───────────── SATIR PARÇALARI ───────────── */

export const RowDelBtn = ({ title, onClick }: { title: string; onClick: () => void }) => (
  <button onClick={e => { stop(e); onClick(); }} title={title} className={ROW_DEL_CLASS}><Trash2 size={ROW_ICON - 1} strokeWidth={1.9} /></button>
);
/** Üye etiketi "satır.sıra": sıra = üyenin listedeki yeri; listede yoksa geometrik sıra (i). */
export const memberLabel = (label: string, members: VirtualFace[], vfId: string | undefined, i: number) => {
  const mi = members.findIndex(m => m.id === vfId);
  return `${label}.${(mi >= 0 ? mi : i) + 1}`;
};
/* Şema sırası = geometrik sıra (memberVfIds); numara = listedeki sıra (members) — ikisi farklı olabilir. */
export const memberLabels = (label: string, members: VirtualFace[], ids: string[]) => ids.map((id, i) => memberLabel(label, members, id, i));

/* ───────────── KAPAK DERZİ ───────────── */

/** Kapak derzine bağlı raf/dikme rozeti (grup kartı) + bağı çözme düğmesi. */
export function DoorBondBadge({ g, onUnbind }: { g: PanelGroup; onUnbind: () => void }) {
  const b = g.doorBond;
  if (!b) return null;
  const how = b.align === 'center' ? 'Half overlay — centered on the joint'
    : b.align === 'min' ? 'Full overlay of the lower / left door' : 'Full overlay of the upper / right door';
  return (
    <span className="shrink-0 h-[28px] pl-2 pr-1 inline-flex items-center gap-1 rounded-[7px] bg-orange-50 ring-1 ring-orange-200/70 text-[10.5px] font-semibold text-orange-700"
      title={`Bound to a door joint (${how}): this ${g.kind} follows the doors — when the door sizes change it moves with the joint. `
        + 'Editing its gap here moves the door joint instead. Unbind to free it (it stays where it is).'}>
      <DoorClosed size={12} strokeWidth={2} /><span>Door joint</span>
      <button type="button" onClick={e => { stop(e); onUnbind(); }}
        title="Unbind from the door joint — the panel stays where it is (to delete the panel use the trash button in the row header, or Remove in the door card)"
        className="w-[18px] h-[18px] rounded-md flex items-center justify-center text-orange-500 hover:bg-orange-100 hover:text-orange-800 transition-colors">
        <Unlink size={11} strokeWidth={2.2} />
      </button>
    </span>
  );
}

/** Kapak kartı "Between doors" satırı: derze dikme (V derzi) / raf (H derzi) ekleme modu — yalnız dış kapakta. */
export function JointPanelBar({ outer, pick, joints, added, freeParts, onToggle }: {
  outer: boolean; pick: Ax | null; joints: Record<Ax, number>; added: number; freeParts: number; onToggle: (ax: Ax) => void;
}) {
  const what = (ax: Ax) => (ax === 'u' ? 'divider' : 'shelf');
  const dir = (ax: Ax) => (ax === 'u' ? 'vertical' : 'horizontal');
  const title = (ax: Ax) => (!outer ? `Add a ${what(ax)} between two doors — outer doors only (inner doors sit between the panels).`
    : joints[ax] ? `Add a ${what(ax)} between two ${ax === 'u' ? 'side-by-side' : 'stacked'} doors: pick a ${dir(ax)} joint in the schematic (${joints[ax]}). `
      + `The ${what(ax)} is created behind that joint, listed after this door row, and follows the joint when the doors change.`
    : `No ${dir(ax)} door joint yet — split the door with Split ${ax === 'u' ? 'V' : 'H'} first.`);
  const rm = added ? ' · ✕ Remove to delete' : '';
  return (
    <div className="flex items-center gap-1 mb-1.5">
      <span className={`shrink-0 pl-0.5 pr-1 ${CELL_LABEL}`}>Between doors</span>
      <CardAction compact icon={Columns3} label="Divider" active={pick === 'u'} tone="amber" title={title('u')} onClick={() => onToggle('u')} />
      <CardAction compact icon={Rows3} label="Shelf" active={pick === 'v'} tone="amber" title={title('v')} onClick={() => onToggle('v')} />
      {pick && (
        <DockStatus ready={outer && freeParts > 0}
          text={!outer ? 'Outer doors only'
            : !joints[pick] ? `No ${dir(pick)} joint — split the door first`
            : freeParts ? `Click a ${dir(pick)} joint to add (Shift: all parts)${rm}`
            : `Every part of the ${dir(pick)} joint${joints[pick] > 1 ? 's' : ''} already has a ${what(pick)}${rm}`}
          title={'The highlighted gaps between doors are the joints you can place the panel at — a joint crossed by a divider / shelf is split into parts, '
            + 'each part takes its own panel (its own row in the list). A panel already added between doors shows ✕ Remove. Esc cancels.'} />
      )}
    </div>
  );
}

/* ───────────── ŞEMA BÖLGE SEÇİMİ (kapak / arkalık) ───────────── */

export type NodeSel = { id: string; nodes: string[] } | null;
/** Verilen düğümlerin yaprak id'leri (sırayla; tekrar edebilir). */
export const leafIdsUnder = (tree: TreeNode, ids: string[]) =>
  ids.flatMap(id => { const n = findNode(tree, id); return n ? treeLeaves(n).map(l => l.id) : []; });

/** Kapak ve arkalık kartının ortak bölge seçimi + bölmesi; yalnız ağaç, servis ve adlar farklı (`whole` / `one`: tüm alan / tek parça). */
export function regionTools<N extends TreeNode>(o: {
  gid: string; tree: N; sel: NodeSel; setSel: (s: NodeSel) => void; depthOf: (id: string) => number | undefined;
  split: (gid: string, nodeId: string, ax: Ax, n: number) => string | null; splitAt: (gid: string, vfId: string) => string[];
  live: () => N | undefined; endRefPick: () => void; whole: string; one: string;
}) {
  const { gid, tree, setSel } = o;
  const picked = o.sel?.id === gid ? o.sel.nodes.filter(id => !!findNode(tree, id)) : [];
  const primaryId = picked[picked.length - 1] as string | undefined;
  const primary = primaryId ? findNode(tree, primaryId) : null;
  const splitNode = primary ?? tree;
  const scope = picked.length ? picked : [tree.id];
  const select = (ids: string[]) => setSel(ids.length ? { id: gid, nodes: ids } : null);
  const regionName = !primary ? o.whole
    : primary.kind === 'leaf' ? o.one : `the selected region (${primary.axis === 'u' ? 'V' : 'H'} ×${primary.children.length})`;
  return {
    picked, splitNode, scope, select, regionName,
    countOf: (ax: Ax) => (splitNode.kind === 'split' && splitNode.axis === ax ? splitNode.children.length : 1),
    // Sonuç bölge seçili kalır (ardışık ayar).
    setCount: (ax: Ax, n: number) => select(scope.map(id => o.split(gid, id, ax, n)).filter((x): x is string => !!x)),
    countTitle: (ax: Ax) => `${ax === 'u' ? 'Split V — pieces side by side' : 'Split H — pieces stacked'} in ${regionName}. `
      + `Type or step the number of pieces (1 = not split on this axis). ${splitNode.kind === 'split' && splitNode.axis !== ax
        ? 'This region is already split the other way: splitting here keeps that split in every new piece (e.g. V ×2 then H ×2 = 2 rows × 2 columns).' : ''}`
      + (picked.length > 1 ? ` Applies to ${picked.length} selected regions.` : ''),
    // Seçili düğüm yoldaysa bir seviye iner; yaprak tekrar tıklanırsa seçim kalkar; yolda değilse kök. Shift: aynı derinlikte çoklu seçim.
    onPathClick: (path: string[], additive: boolean) => {
      if (!path.length) return;
      if (!additive) {
        const i = primaryId ? path.indexOf(primaryId) : -1;
        setSel(i < 0 ? { id: gid, nodes: [path[0]] } : i >= path.length - 1 ? null : { id: gid, nodes: [path[i + 1]] });
        return;
      }
      const depth = primaryId ? (o.depthOf(primaryId) ?? path.length - 1) : path.length - 1;
      const node = path[Math.min(depth, path.length - 1)];
      select(picked.includes(node) ? picked.filter(x => x !== node) : [...picked, node]);
    },
    onRefPick: (vfId: string) => { const ids = o.splitAt(gid, vfId); if (ids.length) { o.endRefPick(); setSel({ id: gid, nodes: ids }); } },
    // Sonradan konan sınır levhası: levhanın ortasından bölünür (Half) ve sol/üst parça seçilir → aynı rozet Full/Half/None döner.
    onSplitAtPanel: (vfId: string) => {
      const ids = o.splitAt(gid, vfId);
      if (!ids.length) return;
      const live = o.live();
      const sp = live ? findNode(live, ids[0]) : null;
      const leafId = sp && sp.kind === 'split' ? sp.children[0]?.id : undefined;
      useAppStore.getState().setSelectedPanelRow(null);
      setSel({ id: gid, nodes: leafId ? [leafId] : ids });
    },
  };
}

// ════════════════════════════════════════════ 4. PANEL LİSTESİ VE KARTLAR ════════════════════════════════════════════
/* PANEL EDİTÖRÜ — sol çubuktaki panel listesi (VF satırları, ayaklar, raf/dikme · kapak · arkalık grup kartları), satır
   önizlemesi ve liste durumu. Şeritler / adım listeleri bu dosyanın üst bölümünde; mantık motora (Geometry / PanelGroupService /
   DoorService / BackService) delege edilir, burada yalnız arayüz durumu tutulur. */

const PANEL_THICKNESS = 18;
/** Paneli üretilmekte olan VF id'leri (yarış koruması, bkz. otomatik panel efekti). */
const _creatingPanelForVf = new Set<string>();
/* Sıralama tutamacı imleci: tarayıcının beyaz grab eli kemik zeminde kayboluyor → koyu dolgulu özel imleç. */
const GRIP_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
  "<path d='M12 1.8 L15.8 5.6 H13.3 V10.7 H18.4 V8.2 L22.2 12 L18.4 15.8 V13.3 H13.3 V18.4 H15.8 L12 22.2 L8.2 18.4 H10.7 V13.3 H5.6 V15.8 " +
  "L1.8 12 L5.6 8.2 V10.7 H10.7 V5.6 H8.2 Z' fill='#292524' stroke='#ffffff' stroke-width='1.4' stroke-linejoin='round'/></svg>"
)}") 12 12, move`;

type VfOpts = { member?: boolean; group?: PanelGroup; door?: DoorGroup; back?: BackGroup };
type BackField = 't' | 'setback' | 'gf' | 'gb' | 'gd';
const GROOVE_KEY = { gf: 'front', gb: 'back', gd: 'depth' } as const;

/** Seçili satır bir VF satırıysa ('vf-<id>') VF id'si. */
const rowVfId = (row: number | string | null) => (typeof row === 'string' && row.startsWith('vf-') ? row.slice(3) : null);
/** VF'nin grubu (raf/dikme · kapak · arkalık). */
const groupOf = (vf: VirtualFace | undefined) => vf?.groupId || vf?.doorGroupId || vf?.backGroupId;
const missing = (id: string | null, list: Array<{ id: string }>) => !!id && !list.some(g => g.id === id);
/** Normalin baskın ekseni (0 / 1 / 2). */
const domAxis = (n: number[]) => { const a = n.map(Math.abs); return a.indexOf(Math.max(...a)); };

/** Değer değişince (ilk render hariç) çalışır. */
function useOnChange<T>(value: T, fn: () => void) {
  const prev = useRef(value);
  useEffect(() => { if (prev.current !== value) { prev.current = value; fn(); } }, [value]);
}
/** Anahtarlı satırı görünür alana kaydırır (render sonrası 60 ms). */
function useScrollIntoView(rows: React.MutableRefObject<Map<number | string, HTMLDivElement>>, key: number | string | null) {
  useEffect(() => {
    if (key === null) return;
    const t = window.setTimeout(() => rows.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
    return () => window.clearTimeout(t);
  }, [key]);
}

export function PanelEditor() {
  const {
    selectedShapeId, shapes, selectedPanelRow, virtualFaces, panelGroups, selectedPanelGroupId, volumePickMode, volumePickGroupId,
    faceExtrudeMode, faceExtrudeTargetPanelId, faceExtrudeSelectedFace, faceExtrudeClickPoint, faceExtrudeValueMode, faceExtrudeCavityGroupId,
    faceExtrudeCavityFaceNormal, panelMoveMode, panelMoveTargetPanelId, panelMoveAxis, panelRotateMode, panelRotateTargetPanelId, panelRotateAxis,
    doorGroups, selectedDoorGroupId, doorRefPickGroupId, backGroups, selectedBackGroupId, backRefPickGroupId, quickBodyMode, quickBodyConfig, quickBodyBusy,
  } = useStoreFields(
    'selectedShapeId', 'shapes', 'selectedPanelRow', 'virtualFaces', 'panelGroups', 'selectedPanelGroupId', 'volumePickMode', 'volumePickGroupId',
    'faceExtrudeMode', 'faceExtrudeTargetPanelId', 'faceExtrudeSelectedFace', 'faceExtrudeClickPoint', 'faceExtrudeValueMode', 'faceExtrudeCavityGroupId',
    'faceExtrudeCavityFaceNormal', 'panelMoveMode', 'panelMoveTargetPanelId', 'panelMoveAxis', 'panelRotateMode', 'panelRotateTargetPanelId', 'panelRotateAxis',
    'doorGroups', 'selectedDoorGroupId', 'doorRefPickGroupId', 'backGroups', 'selectedBackGroupId', 'backRefPickGroupId', 'quickBodyMode', 'quickBodyConfig',
    'quickBodyBusy',
  );
  // Eylemler sabittir (store kurulurken tanımlanır) → abonelik gerekmez.
  const {
    updateShape, deleteShape, setSelectedPanelRow, updateVirtualFace, deleteVirtualFace, reorderVirtualFaceGroup, updatePanelGroup,
    setFaceExtrudeMode, setFaceExtrudeTargetPanelId, setFaceExtrudeSelectedFace, setFaceExtrudeThickness, setFaceExtrudeValueMode, setFaceExtrudeRefCandidate,
    setPanelMoveMode, setPanelMoveTargetPanelId, setPanelMoveAxis, setPanelMoveValue, setPanelRotateMode, setPanelRotateTargetPanelId, setPanelRotateAxis,
    setPanelRotateValue, setSelectedPanelGroupId, setVolumePickMode, setSelectedDoorGroupId, setDoorRefPickGroupId, setDoorPickMode,
    setSelectedBackGroupId, setBackRefPickGroupId, setBackPickMode, setQuickBodyMode, setQuickBodyConfig, setQuickBodyBusy,
  } = useAppStore.getState();

  // Şema bölge seçimi (düğüm id'leri): her tık bir seviye iner; üye/3B seçimiyle bağı YOK.
  const [doorNodeSel, setDoorNodeSel] = useState<NodeSel>(null);
  const [doorSplitMode, setDoorSplitMode] = useState<{ id: string; mode: 'count' | 'spacing' } | null>(null);
  const [doorAddPick, setDoorAddPick] = useState<{ id: string; axis: 'u' | 'v' } | null>(null);
  // Arkalık kartı: şema bölge seçimi (Panel ref modu store'da: backRefPickGroupId).
  const [backNodeSel, setBackNodeSel] = useState<NodeSel>(null);
  /** Kenar bollaştırma kapsamı: seçili kenarın (sınır / derz paneli VF'si) kendi kanal payı düzenlenir; null → grup değeri. */
  const [backClearEdge, setBackClearEdge] = useState<{ id: string; vfId: string } | null>(null);
  /** Görsel ipucu: arkalık kartında üzerine gelinen / odaklanan değer (kesit diyagramı + şema vurgusu). */
  const [backHint, setBackHint] = useState<{ id: string; key: string } | null>(null);
  /** Kalıcı Legs satırının plan diyagramı ipucu. */
  const [legsHint, setLegsHint] = useState<string | null>(null);
  /** Body satırı: gövdede saklı hızlı gövde ayarlarının düzenleme taslağı (satır kapanınca / ✓ sonrası düşer → saklı ayar görünür). */
  const [quickDraft, setQuickDraft] = useState<{ sid: string; cfg: QuickBodyConfig } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [armedRowKey, setArmedRowKey] = useState<string | null>(null);
  /** Kart alanlarının yerel metin taslağı; anahtar = grup id : alan (: kenar kapsamı). */
  const [fieldDraft, setFieldDraft] = useState<{ key: string; v: string } | null>(null);
  // Kart açıklığı seçimden AYRI yerel durum: üye seçilince açılır ve üye editörü kapanınca da açık KALIR; yalnız chevron kapatır.
  const [openCards, setOpenCards] = useState<Set<string>>(() => new Set());
  const [stepEdit, setStepEdit] = useState<StepEdit>(null);
  const [extrudeThicknessStr, setExtrudeThicknessStr] = useState(() => String(useAppStore.getState().faceExtrudeThickness));
  const [moveValueStr, setMoveValueStr] = useState('0');
  const [rotateValueStr, setRotateValueStr] = useState('0');
  const rowRefs = useRef<Map<number | string, HTMLDivElement>>(new Map());
  const rowKeysRef = useRef<{ sid: string | null; keys: Set<string> } | null>(null);

  // Şemada seçili parçalar 3B'de vurgulanır (store.backFocusVfIds); tüm alan seçiliyse ya da seçim yoksa boş → grup vurgusu.
  useEffect(() => {
    const st = useAppStore.getState();
    const g = backNodeSel ? backGroups.find(x => x.id === backNodeSel.id) : undefined;
    if (!g || !backNodeSel || selectedBackGroupId !== g.id) { st.setBackFocusVfIds([]); return; }
    const leaves = backLeaves(g.tree).map(l => l.id);
    const want = new Set(leafIdsUnder(g.tree, backNodeSel.nodes));
    const ids = leaves.flatMap((id, i) => (want.has(id) && g.memberVfIds[i] ? [g.memberVfIds[i]] : []));
    st.setBackFocusVfIds(ids.length === leaves.length ? [] : ids);
  }, [backNodeSel, backGroups, selectedBackGroupId]);
  useOnChange(panelMoveAxis, () => { setMoveValueStr('0'); setPanelMoveValue(0); });
  useOnChange(panelRotateAxis, () => { setRotateValueStr('0'); setPanelRotateValue(0); });

  const openCard = (id: string) => setOpenCards(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  /** Store'daki grup seçimlerinden (raf/dikme · kapak · arkalık) koşulu tutanı düşürür; çağrı sırası sabit. */
  const dropGroupSel = (drop: (id: string, groups: Array<{ id: string; shapeId: string }>) => boolean) => {
    const st = useAppStore.getState();
    if (st.selectedPanelGroupId && drop(st.selectedPanelGroupId, st.panelGroups)) setSelectedPanelGroupId(null);
    if (st.selectedDoorGroupId && drop(st.selectedDoorGroupId, st.doorGroups)) setSelectedDoorGroupId(null);
    if (st.selectedBackGroupId && drop(st.selectedBackGroupId, st.backGroups)) setSelectedBackGroupId(null);
  };
  const dropRefPick = (drop: (id: string) => boolean) => {
    const st = useAppStore.getState();
    if (st.doorRefPickGroupId && drop(st.doorRefPickGroupId)) setDoorRefPickGroupId(null);
    if (st.backRefPickGroupId && drop(st.backRefPickGroupId)) setBackRefPickGroupId(null);
  };
  const closeCard = (id: string, memberIds: string[]) => {
    setOpenCards(prev => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
    dropGroupSel(x => x === id);
    const row = rowVfId(useAppStore.getState().selectedPanelRow);
    if (row && memberIds.includes(row)) setSelectedPanelRow(null);
    dropRefPick(x => x === id);
    const off = <T extends { id: string } | null>(p: T) => (p?.id === id ? null : p);
    setDoorNodeSel(off); setDoorAddPick(off); setBackNodeSel(off);
  };

  const selectedShape = shapeById(selectedShapeId, shapes);
  const selVf = rowVfId(selectedPanelRow);
  const vfById = (id: string | null | undefined) => virtualFaces.find(f => f.id === id);
  const activePanelId = useMemo(() => {
    if (!selectedShape || selectedPanelRow === null) return null;
    if (typeof selectedPanelRow === 'number') {
      return childPanelsOf(selectedShape.id, shapes).find(s => s.parameters?.faceIndex === selectedPanelRow)?.id || null;
    }
    return panelOfVf(rowVfId(selectedPanelRow) ?? undefined, shapes)?.id || null;
  }, [selectedShape, selectedPanelRow, shapes]);
  const activePanel = shapeById(activePanelId, shapes);
  const activeDims = panelDims(activePanel);

  useEffect(() => {
    for (const id of [groupOf(vfById(selVf)), selectedPanelGroupId, selectedDoorGroupId, selectedBackGroupId]) if (id) openCard(id);
  }, [selectedPanelRow, selectedPanelGroupId, selectedDoorGroupId, selectedBackGroupId, virtualFaces]);

  // Yeni panel/grup yerleşince (Goker) öteki satırların önizlemeleri kapanır. Satır anahtarı = grup id ya da VF id; grup içi
  // bölme/adet değişimi yeni ÜYE VF üretir ama anahtar aynı kalır → tetiklemez. Yeni kapak/arkalık seçili gelir, açık kalır.
  useEffect(() => {
    const keyOf = (vf: VirtualFace) => groupOf(vf) || vf.id;
    const keys = new Set(virtualFaces.filter(vf => vf.shapeId === selectedShapeId).map(keyOf));
    const prev = rowKeysRef.current;
    rowKeysRef.current = { sid: selectedShapeId, keys };
    if (!prev || prev.sid !== selectedShapeId) return;
    const fresh = new Set([...keys].filter(k => !prev.keys.has(k)));
    if (!fresh.size) return;
    const st = useAppStore.getState();
    setOpenCards(cur => { const n = new Set([...cur].filter(id => fresh.has(id))); return n.size === cur.size ? cur : n; });
    // Body satırı açıkken yeniden kurulan parçalar "yeni" sayılmaz (satır açık kalır).
    if (st.selectedPanelRow !== null && !String(st.selectedPanelRow).startsWith('quick-')) {
      const vf = st.virtualFaces.find(f => f.id === rowVfId(st.selectedPanelRow));
      if (!vf || !fresh.has(keyOf(vf))) setSelectedPanelRow(null);
    }
    const stale = (id: string) => !fresh.has(id);
    dropGroupSel(stale); dropRefPick(stale);
    const keep = <T extends { id: string } | null>(p: T) => (p && stale(p.id) ? null : p);
    setDoorNodeSel(keep); setDoorAddPick(keep); setBackNodeSel(keep); setBackClearEdge(keep);
  }, [virtualFaces, selectedShapeId]);

  useEffect(() => {
    if (selectedShapeId !== useAppStore.getState().selectedPanelRowParentId) setSelectedPanelRow(null);
    dropGroupSel((id, groups) => !groups.some(g => g.id === id && g.shapeId === selectedShapeId));
    const st = useAppStore.getState();
    if (st.volumePickMode) setVolumePickMode(null);
    if (st.doorPickMode) setDoorPickMode(false);
    if (st.backPickMode) setBackPickMode(false);
    if (st.quickBodyMode) setQuickBodyMode(false);
    setOpenCards(new Set());
  }, [selectedShapeId]);
  // Hızlı gövde açılınca gövdede saklı ayarlar taslağa yüklenir (Goker: "ayarını tut"); paneller zaten yerleşmişse yapılandırma
  // Body satırından yapılır — mod kapanır.
  useEffect(() => {
    if (!quickBodyMode || !selectedShape) return;
    if (quickBodyVfsOf(selectedShape.id, useAppStore.getState().virtualFaces).length) { setQuickBodyMode(false); return; }
    const saved = quickBodyOf(selectedShape);
    if (saved) setQuickBodyConfig(JSON.parse(JSON.stringify(saved)) as QuickBodyConfig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickBodyMode, selectedShapeId]);
  useEffect(() => {
    if (missing(selectedDoorGroupId, doorGroups)) setSelectedDoorGroupId(null);
    if (missing(doorRefPickGroupId, doorGroups)) setDoorRefPickGroupId(null);
  }, [doorGroups, selectedDoorGroupId, doorRefPickGroupId]);
  useEffect(() => {
    if (missing(selectedBackGroupId, backGroups)) setSelectedBackGroupId(null);
    if (missing(backRefPickGroupId, backGroups)) setBackRefPickGroupId(null);
  }, [backGroups, selectedBackGroupId, backRefPickGroupId]);
  useEffect(() => {
    if (!doorRefPickGroupId && !doorAddPick && !backRefPickGroupId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDoorRefPickGroupId(null); setDoorAddPick(null); setBackRefPickGroupId(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doorRefPickGroupId, doorAddPick, backRefPickGroupId]);

  useEffect(() => {
    // YARIŞ KORUMASI: ilk VF'nin hasPanel yazımı efekti yeniden tetikler; üretimi süren VF'ler modül düzeyinde
    // işaretlenmezse aynı VF için İKİNCİ panel yaratılır (üst üste iki raf).
    const pending = virtualFaces.filter(vf => !vf.hasPanel && !_creatingPanelForVf.has(vf.id) && !panelOfVf(vf.id, useAppStore.getState().shapes));
    if (!pending.length) return;
    for (const vf of pending) _creatingPanelForVf.add(vf.id);
    (async () => {
      for (const vf of pending) {
        const parentShape = shapeById(vf.shapeId);
        const st = useAppStore.getState();
        if (!parentShape || !st.virtualFaces.some(f => f.id === vf.id)) { _creatingPanelForVf.delete(vf.id); continue; }
        try {
          const grp = vf.groupId ? st.panelGroups.find(pg => pg.id === vf.groupId) : undefined;
          const dgrp = vf.doorGroupId ? st.doorGroups.find(dg => dg.id === vf.doorGroupId) : undefined;
          const bgrp = vf.backGroupId ? st.backGroups.find(bg => bg.id === vf.backGroupId) : undefined;
          const th = grp ? memberThicknessesOf(grp)[vf.groupIndex ?? grp.memberVfIds.indexOf(vf.id)] || grp.thickness
            : dgrp ? dgrp.thickness : bgrp ? bgrp.thickness : PANEL_THICKNESS;
          const rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, th);
          if (!rp) continue;
          const g = convertReplicadToThreeGeometry(rp);
          const r = geoAxes(g); if (!r) continue;
          const [def, alt] = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
          const s = [r.size.x, r.size.y, r.size.z];
          const vi = virtualFaces.filter(f => f.shapeId === vf.shapeId).findIndex(f => f.id === vf.id);
          useAppStore.getState().addShape({
            id: genId('panel-vf'), type: 'panel', position: [...parentShape.position], rotation: parentShape.rotation, scale: [...parentShape.scale],
            color: '#ffffff', geometry: g, replicadShape: rp,
            parameters: {
              width: s[def], height: s[alt], depth: th, parentShapeId: parentShape.id, faceIndex: -(vi + 1), virtualFaceId: vf.id, arrowRotated: false,
              // Grup kimliği + kalınlık panele de yazılır: motor (damga/engel/kesim sınıfı) bunu okur.
              ...(vf.groupId ? { panelGroupId: vf.groupId, panelThickness: th } : {}),
              ...(vf.doorGroupId ? { doorGroupId: vf.doorGroupId, panelThickness: th } : {}),
              ...(vf.backGroupId ? { backGroupId: vf.backGroupId, panelThickness: th } : {}),
            },
          } as Shape);
          updateVirtualFace(vf.id, { hasPanel: true });
        } catch (e) { console.error('Auto panel creation failed:', e); }
        finally { _creatingPanelForVf.delete(vf.id); }
      }
      // Rebuild'i App'teki panel-kümesi izleyicisi (addShape) tetikler — burada ikinci kez çağrılmaz.
    })();
  }, [virtualFaces]);

  useEffect(() => {
    if (!faceExtrudeMode || faceExtrudeCavityGroupId || !activePanelId || activePanelId === faceExtrudeTargetPanelId) return;
    setFaceExtrudeTargetPanelId(activePanelId); setFaceExtrudeSelectedFace(null);
  }, [faceExtrudeMode, faceExtrudeCavityGroupId, activePanelId, faceExtrudeTargetPanelId]);
  useEffect(() => {
    if (!panelMoveMode || !activePanelId || activePanelId === panelMoveTargetPanelId) return;
    setPanelMoveTargetPanelId(activePanelId); setPanelMoveAxis(null); setPanelMoveValue(0);
  }, [panelMoveMode, activePanelId, panelMoveTargetPanelId]);

  // Seçilen yüzde mevcut extrude adımı varsa değeri (ve ref dışında modu) şeride yüklenir.
  useEffect(() => {
    if (faceExtrudeSelectedFace === null || !activePanel?.geometry || faceExtrudeCavityGroupId) return;
    const steps = activePanel.parameters?.extrudeSteps || []; if (!steps.length) return;
    const { groups } = getFacesAndGroups(activePanel.geometry);
    let g = groups[faceExtrudeSelectedFace]; if (!g) return;
    const gn = g.normal.clone().normalize();
    if (!isFlatNormal(gn, 0.9)) {
      const flat = groups
        .filter(f => { const fn = f.normal.clone().normalize(); return isFlatNormal(fn, 0.9) && dominantAxisLabel(fn) === dominantAxisLabel(gn); })
        .sort((a, b) => a.center.distanceTo(g!.center) - b.center.distanceTo(g!.center))[0];
      if (flat) g = flat;
    }
    const existing = findExistingStepForFace(steps, g.normal.clone().normalize(), g.center.clone());
    // Ref akışı bozulmasın: ref modunda mod yazılmaz.
    if (existing) { setFaceExtrudeThickness(existing.value); if (faceExtrudeValueMode !== 'ref') setFaceExtrudeValueMode(existing.isFixed ? 'fixed' : 'dyn'); }
  }, [faceExtrudeSelectedFace, activePanelId, shapes]);

  // GARANTİ ÇIKIŞ: komut yalnız "açık satırın paneli === hedef panel" iken geçerli. Rebuild sırasında activePanelId
  // bir an null olabilir — bu çıkış SAYILMAZ (yalnız satır kapanınca ya da başka panele geçilince).
  const uiLeftPanel = (targetId: string | null) => selectedPanelRow === null || (!!activePanelId && targetId !== activePanelId);
  // Hacim düzenlemenin geçerlilik koşulu: grup bu gövdede ve kartı AÇIK (tümü seçili ya da bir üye satırı açık).
  const groupLive = (gid: string) => panelGroups.some(g => g.id === gid && g.shapeId === selectedShapeId)
    && (selectedPanelGroupId === gid || virtualFaces.some(f => f.groupId === gid && f.id === selVf));
  useEffect(() => {
    if (volumePickMode && volumePickGroupId && !groupLive(volumePickGroupId)) setVolumePickMode(null);
  }, [volumePickMode, volumePickGroupId, panelGroups, selectedShapeId, selectedPanelGroupId, selectedPanelRow, virtualFaces]);
  useEffect(() => {
    const stopExtrude = () => { setFaceExtrudeSelectedFace(null); setFaceExtrudeRefCandidate(null); setFaceExtrudeMode(false); };
    if (faceExtrudeMode && faceExtrudeCavityGroupId) { if (!groupLive(faceExtrudeCavityGroupId)) stopExtrude(); return; }
    if (faceExtrudeMode && uiLeftPanel(faceExtrudeTargetPanelId)) stopExtrude();
    if (panelMoveMode && uiLeftPanel(panelMoveTargetPanelId)) { setPanelMoveAxis(null); setPanelMoveMode(false); }
    if (panelRotateMode && uiLeftPanel(panelRotateTargetPanelId)) { setPanelRotateAxis(null); setPanelRotateMode(false); }
  }, [activePanelId, selectedPanelRow, selectedShapeId, selectedPanelGroupId, panelGroups, faceExtrudeMode, faceExtrudeTargetPanelId, faceExtrudeCavityGroupId,
    panelMoveMode, panelMoveTargetPanelId, panelRotateMode, panelRotateTargetPanelId]);

  // Hacim yüzü seçilince o eksendeki mevcut hacim adımı şeride yüklenir.
  useEffect(() => {
    if (!faceExtrudeCavityGroupId || !faceExtrudeCavityFaceNormal) return;
    const g = panelGroups.find(x => x.id === faceExtrudeCavityGroupId); if (!g?.cavitySteps?.length) return;
    const n = faceExtrudeCavityFaceNormal, ax = domAxis(n);
    // Aynı eksen+yönde birden çok adım (L'nin iki kolu) → çıpası tıklama noktasına en yakın olan.
    const body = selectedShape ? localBboxOf(selectedShape.geometry) : null;
    const cp = faceExtrudeClickPoint;
    const fr = body && cp ? [0, 1, 2].map(a => (cp[a] - body.min.getComponent(a)) / ((body.max.getComponent(a) - body.min.getComponent(a)) || 1)) : null;
    const same = g.cavitySteps.filter(st => { const a = domAxis(st.faceNormal); return a === ax && Math.sign(st.faceNormal[a]) === Math.sign(n[ax]); });
    const dist = ({ anchorFrac: q }: { anchorFrac?: number[] }) => (q && fr ? Math.hypot(q[0] - fr[0], q[1] - fr[1], q[2] - fr[2]) : 9);
    const existing = same.length <= 1 || !fr ? same[0] : same.reduce((b, st) => (dist(st) < dist(b) ? st : b));
    if (!existing) return;
    setFaceExtrudeThickness(existing.value); setExtrudeThicknessStr(String(existing.value));
    if (faceExtrudeValueMode !== 'ref') setFaceExtrudeValueMode(existing.refShapeId ? 'ref' : existing.isFixed ? 'fixed' : 'dyn');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceExtrudeCavityGroupId, faceExtrudeCavityFaceNormal, faceExtrudeClickPoint]);

  useScrollIntoView(rowRefs, selectedPanelRow);
  useScrollIntoView(rowRefs, selectedPanelGroupId ? `grp-${selectedPanelGroupId}` : null);

  // showOutlines yalnız KULLANICI TERCİHİDİR — burada yazılmaz; yerleştirmedeki geçici görünürlük ShapeWithTransform'da.

  const toggleArrow = (p: Shape | undefined) => { if (p) updateShape(p.id, { parameters: { ...p.parameters, arrowRotated: !p.parameters?.arrowRotated } }); };
  // fitFaceShape'i computeFreeRegionLocal yalnız regen'de okur → tam rebuild gerekir.
  const toggleFitShape = async (vf: VirtualFace) => {
    updateVirtualFace(vf.id, { fitFaceShape: !vf.fitFaceShape });
    try { await requestRebuild(vf.shapeId); } catch (e) { console.error('[YAGO][YÜZ-ŞEKLİ] rebuild hatası:', e); }
  };
  /** Taslaklı kart girişi: Enter / blur onaylar (taslak düşer, commit görünen metni alır), Esc geri alır. */
  const draftInput = (key: string, shown: string, commit: (raw: string) => void) => {
    const value = fieldDraft?.key === key ? fieldDraft.v : shown;
    const done = () => { setFieldDraft(null); commit(value); };
    return {
      type: 'text', value, className: 'yago-field', onClick: stop, onBlur: done,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setFieldDraft({ key, v: e.target.value }),
      onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') setFieldDraft(null); },
    };
  };

  /* Şerit önizlemenin ÜSTÜNDE olmalı (altındayken 500px önizlemenin altında kalıp görünmüyordu). */
  const renderExpandedBody = (vf: VirtualFace, vp: Shape | undefined) => {
    const tools = {
      extrude: [faceExtrudeMode, faceExtrudeTargetPanelId, setFaceExtrudeMode, setFaceExtrudeTargetPanelId],
      move: [panelMoveMode, panelMoveTargetPanelId, setPanelMoveMode, setPanelMoveTargetPanelId],
      rotate: [panelRotateMode, panelRotateTargetPanelId, setPanelRotateMode, setPanelRotateTargetPanelId],
    } as const;
    type Tool = keyof typeof tools;
    const tool = (Object.keys(tools) as Tool[]).find(k => tools[k][0] && tools[k][1] === vp?.id) ?? null;
    // Aynı araca tık → kapanır; başka araca → açık olan kapanır, yenisi bu panelde açılır.
    const pickTool = (k: string) => {
      if (!vp) return;
      const [, , setMode, setTarget] = tools[k as Tool];
      if (k === tool) return setMode(false);
      for (const [on, , off] of Object.values(tools)) if (on) off(false);
      setTarget(vp.id); setMode(true);
    };
    const dis = !vf.hasPanel;
    return (
      <div className={CARD_BODY} style={{ borderTop: CARD_BODY_STYLE.borderTop }} onClick={stop}>
        <Segmented active={tool} onPick={pickTool} items={[
          { key: 'extrude', label: 'Extrude', Icon: MoveVertical, title: 'Face extrude — pick a face in the 3D view, then Fixed / Dyn / Ref', disabled: dis },
          { key: 'move', label: 'Move', Icon: Move, title: 'Move the panel — Relative / Absolute / To point', disabled: dis },
          { key: 'rotate', label: 'Rotate', Icon: RotateCw, title: 'Rotate the panel — Angle / Aim at face', disabled: dis },
        ]} />
        <ExtrudeDock panel={activePanel} draft={extrudeThicknessStr} setDraft={setExtrudeThicknessStr} />
        <MoveDock panel={activePanel} draft={moveValueStr} setDraft={setMoveValueStr} />
        <RotateDock panel={activePanel} draft={rotateValueStr} setDraft={setRotateValueStr} />
        <div className={`${PREVIEW_FRAME} mt-1.5`} style={{ height: PREVIEW_HEIGHT, background: PREVIEW_BG }}>
          {activeDims && activePanel
            ? <PanelPreview2D key={activePanel.id} shape={activePanel} arrowRotated={!!activePanel.parameters?.arrowRotated} />
            : <div className="absolute inset-0 flex items-center justify-center"><span className="text-xs text-stone-400">No panel</span></div>}
        </div>
        <PanelSteps panel={activePanel} edit={stepEdit} setEdit={setStepEdit} />
      </div>
    );
  };

  /* ───────────── PANEL LİSTESİ ───────────── */

  const renderFaceList = () => {
    if (!selectedShape?.geometry) return null;
    const sid = selectedShape.id;
    const svf = virtualFaces.filter(vf => vf.shapeId === sid);
    const bodyLegs = bodyLegsOf(selectedShape);
    if (!svf.length && !bodyLegs) return quickBodyMode ? null : (
      <div className="flex flex-col items-center justify-center py-6 text-center">
        <div className="w-8 h-8 rounded-lg bg-stone-100 flex items-center justify-center mb-2"><MoveVertical size={14} className="text-stone-400" /></div>
        <span className="text-xs text-stone-400">No faces added yet</span>
        <span className="text-[10.5px] text-stone-300 mt-0.5">Use Body for a quick carcass, or Panel, Shelf and Divider one by one</span>
      </div>
    );

    // Düz liste: her VF store sırasıyla kendi satırıdır; listedeki numara = VF sırası = basan/basılan önceliği.
    // İstisna: raf/dikme, kapak ve arkalık grubunun üyeleri store'da bitişik durur ve TEK kart olarak (ilk üyenin sırasında) gösterilir.
    type Row = { kind: 'vf'; vf: VirtualFace } | { kind: 'group'; group: PanelGroup; members: VirtualFace[] }
      | { kind: 'door'; group: DoorGroup; members: VirtualFace[] } | { kind: 'back'; group: BackGroup; members: VirtualFace[] };
    const rows: Row[] = [];
    const seenGroups = new Set<string>();
    for (const vf of svf) {
      const g = vf.groupId ? panelGroups.find(x => x.id === vf.groupId) : undefined;
      const dg = vf.doorGroupId ? doorGroups.find(x => x.id === vf.doorGroupId) : undefined;
      const bg = vf.backGroupId ? backGroups.find(x => x.id === vf.backGroupId) : undefined;
      const grp = g ?? dg ?? bg;
      if (!grp) { rows.push({ kind: 'vf', vf }); continue; }
      if (seenGroups.has(grp.id)) continue;
      seenGroups.add(grp.id);
      rows.push(g ? { kind: 'group', group: g, members: svf.filter(m => m.groupId === g.id) }
        : dg ? { kind: 'door', group: dg, members: svf.filter(m => m.doorGroupId === dg.id) }
        : { kind: 'back', group: bg!, members: svf.filter(m => m.backGroupId === bg!.id) });
    }
    const idsOf = (r: Row) => (r.kind === 'vf' ? [r.vf.id] : r.members.map(m => m.id));
    const rowKeyOf = (r: Row) => (r.kind === 'vf' ? r.vf.id : `grp-${r.group.id}`);
    const clearDrag = () => { setDragIndex(null); setDropIndex(null); };

    const deletePanelAndFace = async (vfId: string) => {
      const p = panelOfVf(vfId, shapes);
      if (p) deleteShape(p.id);
      deleteVirtualFace(vfId);
      if (selVf === vfId) setSelectedPanelRow(null);
      // Panel silindiyse rebuild'i App izleyicisi tetikler; yalnız paneli olmayan VF için burada.
      if (!p) { try { await requestRebuild(sid); } catch (e) { console.error('Silme sonrası rebuild hatası:', e); } }
    };
    // reorderVirtualFaceGroup zaten rebuild tetikler; ikinci rebuild BİLİNÇLİ: ref-dönüş açıları geçişler arasında
    // yakınsar, tek geçiş farklı sonuç verir (harness ile doğrulandı).
    const doReorder = async (draggedIds: string[], targetId: string | null) => {
      clearDrag();
      reorderVirtualFaceGroup(sid, draggedIds, targetId);
      await requestRebuild(sid);
    };
    // Bırakma HER ZAMAN üzerine gelinen satırın ALTINA; store insert-BEFORE çalıştığı için hedef = sonraki satırın ilk VF'si.
    const onRowDropBelow = async (draggedRowIdx: number, hoveredRowIdx: number) => {
      if (draggedRowIdx === hoveredRowIdx) return clearDrag();
      const next = rows[hoveredRowIdx + 1];
      if (next && rowKeyOf(next) === rowKeyOf(rows[draggedRowIdx])) return clearDrag();
      await doReorder(idsOf(rows[draggedRowIdx]), next ? idsOf(next)[0] : null);
    };
    const grip = (rowKey: string, rowIdx: number, title: string) => (
      <span draggable
        onMouseDown={() => setArmedRowKey(rowKey)} onMouseUp={() => setArmedRowKey(null)}
        onMouseLeave={() => { if (dragIndex === null) setArmedRowKey(null); }}
        onDragStart={e => { stop(e); setDragIndex(rowIdx); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', rowKey); }}
        onDragEnd={() => { clearDrag(); setArmedRowKey(null); }}
        onClick={stop} style={{ cursor: GRIP_CURSOR }} title={title}
        className={`shrink-0 w-[14px] ml-[2px] self-stretch flex items-center justify-center transition-colors duration-150
          ${armedRowKey === rowKey ? 'text-orange-500' : 'text-stone-300/70 group-hover/row:text-stone-400 hover:!text-orange-500'}`}>
        <GripVertical size={13} strokeWidth={1.75} />
      </span>
    );
    const rowRef = (k: string) => (el: HTMLDivElement | null) => { if (el) rowRefs.current.set(k, el); else rowRefs.current.delete(k); };
    // Satır başlığı / ok: kapalı → aç + seç; açık → kapat (seçim düşer).
    const rowToggle = (key: string, sel: boolean) => (e: React.MouseEvent) => {
      stop(e); if (sel) setSelectedPanelRow(null); else setSelectedPanelRow(key, sid);
    };
    const selIdx = (ids: string[]) => ids.findIndex(id => id === selVf);

    /** Ortak satır iskeleti (VF · ayaklar · grup kartı): tutamaç · no · rozet · ad · ölçüler · araçlar · aç/kapa + açıkken gövde. */
    const rowShell = (o: {
      key: string; refKey?: string; open: boolean; sel: boolean; dragging?: boolean; armed?: boolean; lead: React.ReactNode;
      onToggle: (e: React.MouseEvent) => void; title?: string; num: string; small?: boolean; kind: RowKind; count?: number;
      name: React.ReactNode; dims: React.ReactNode; trail: React.ReactNode; trailW?: number; body: () => React.ReactNode;
    }) => (
      <div key={o.key} ref={o.refKey ? rowRef(o.refKey) : undefined} className={rowCardClass(o.open, !!o.dragging, !!o.armed)}>
        <div className={`relative flex items-stretch ${o.sel ? ROW_SEL_HEAD : ''}`}>
          {o.sel && <span className={ROW_SEL_BAR} />}
          {o.lead}
          <div onClick={o.onToggle} className="flex-1 min-w-0 relative flex items-center gap-1 pl-0 pr-0.5 py-[4px] cursor-pointer" title={o.title}>
            <RowNum label={o.num} active={o.sel} small={o.small} />
            <RowTypeBadge kind={o.kind} active={o.open} count={o.count} />
            {o.name}
            {o.dims}
            <div className="flex items-center justify-end gap-[1px] shrink-0" style={{ width: o.trailW ?? ROW_TRAIL_W }} onClick={stop}>
              {o.trail}
              <RowChevron open={o.open} onClick={o.onToggle} />
            </div>
          </div>
        </div>
        {o.open && o.body()}
      </div>
    );

    /* AYAKLAR SATIRI: VF değil, gövde parametresi; sırası her zaman en başta ("L"). Yükseklik alt panelden canlı okunur. */
    const legsRow = (legs: NonNullable<typeof bodyLegs>) => {
      const key = `legs-${sid}`, sel = selectedPanelRow === key;
      const h = legHeightOf(selectedShape, legs, shapes);
      return rowShell({
        key, open: sel, sel, lead: <span className="shrink-0 w-[14px] ml-[2px] self-stretch" />, onToggle: rowToggle(key, sel),
        num: 'L', kind: 'legs', count: legs.count,
        name: <span title="Cabinet legs — always first; height follows the bottom panel"
          className="flex-1 min-w-0 h-[22px] px-[5px] flex items-center text-[11.5px] font-medium text-stone-700 truncate select-none">Legs</span>,
        dims: <RowCells title={`${legs.count} legs · Ø ${fmt1(legs.diameter)} · height ${fmt1(h)} (from the bottom panel)`}
          cells={[['N', String(legs.count)], ['Ø', fmt1(legs.diameter)], ['H', fmt1(h)]]} />,
        trail: <RowDelBtn title="Remove legs" onClick={() => { if (sel) setSelectedPanelRow(null); setBodyLegs(sid, null); }} />,
        body: () => {
          const bb = localBboxOf(effectiveBodyGeometry(selectedShape));
          return (
            <div className={CARD_BODY} style={CARD_BODY_STYLE} onClick={stop}>
              <LegsBlock legs={legs} W={bb ? bb.max.x - bb.min.x : 600} D={bb ? bb.max.z - bb.min.z : 560} heightReadout={h} heightEditable={false}
                countOptions={[4, 5, 6]} hint={legsHint} onHint={setLegsHint} onChange={p => setBodyLegs(sid, p as Partial<typeof legs>)} />
            </div>
          );
        },
      });
    };

    /* BODY SATIRI: hızlı gövde AYARLARI (gövde parametresi); her zaman en başta ("B"), Legs'ten önce. Açılınca aynı yapılandırma paneli
       (revise): ✓ panelleri yerinde yeniden kurar; × hızlı gövdenin kurduğu her şeyi kaldırır (ayarlar gövdede kalır). */
    const quickRow = (saved: QuickBodyConfig, parts: number) => {
      const key = `quick-${sid}`, sel = selectedPanelRow === key;
      const draft = sel && quickDraft?.sid === sid ? quickDraft.cfg : saved;
      const baseLabel = { plain: 'Plain', legs: 'Legs', plinth: 'Plinth' }[saved.base];
      const backTxt = saved.back.enabled ? `${BACK_TYPE_LABEL[saved.back.placement].toLowerCase()} back` : 'no back';
      const legs = saved.base === 'legs' ? (saved.legs.count || 4) : saved.base === 'plinth' ? saved.legs.count : 0;
      const toggle = (e: React.MouseEvent) => { stop(e); setQuickDraft(null); if (sel) setSelectedPanelRow(null); else setSelectedPanelRow(key, sid); };
      return rowShell({
        key, open: sel, sel, lead: <span className="shrink-0 w-[14px] ml-[2px] self-stretch" />, onToggle: toggle,
        num: 'B', kind: 'quick', count: parts,
        name: <span title="Quick body settings — always first. Open to revise the base, corner joints, thickness, plinth, legs and back, then ✓ to rebuild."
          className="flex-1 min-w-0 h-[22px] px-[5px] flex items-center gap-1.5 text-[11.5px] font-medium text-stone-700 truncate select-none">
          Body<span className="min-w-0 truncate text-[10.5px] font-medium text-stone-400">· {baseLabel} · {backTxt}</span>
        </span>,
        dims: <RowCells title={`${parts} body panels · panel thickness ${fmt1(saved.thickness)} · ${legs ? `${legs} legs` : 'no legs'}`}
          cells={[['T', saved.thickness], ['Legs', legs ? String(legs) : '—']]} />,
        trail: <RowDelBtn title="Remove everything Quick body placed: body panels, plinth, legs and its back panel (the settings are kept)"
          onClick={() => { if (sel) setSelectedPanelRow(null); setQuickDraft(null); removeQuickBody(sid); }} />,
        body: () => (
          <div className="yago-expand" style={{ borderTop: '1px solid #efebe5' }} onClick={stop}>
            <QuickBodyPanel revise shape={selectedShape} cfg={draft} setCfg={p => setQuickDraft({ sid, cfg: { ...draft, ...p } })} busy={quickBodyBusy}
              existingCount={0} onApply={() => { void onQuickBodyApply(draft, true); }} onExit={() => setSelectedPanelRow(null)} />
          </div>
        ),
      });
    };

    const vfRow = (vf: VirtualFace, rowIdx: number, label: string, { member, group, door, back }: VfOpts) => {
      const vp = panelOfVf(vf.id, shapes), ar = vp?.parameters?.arrowRotated || false, sel = selVf === vf.id, dims = panelDims(vp);
      const doorMember = door ? doorMembersOf(door)[door.memberVfIds.indexOf(vf.id)] : undefined;
      const backPiece = back ? backPieceOf(back, backLeafOfMember(back, back.memberVfIds.indexOf(vf.id))) : undefined;   // parça başına tip
      const noPanel = !vf.hasPanel, slab = door || back;
      const memberTitle = backPiece
        ? `${BACK_TYPE_TITLE[backPiece.placement]}${backPiece.placement === 'inner' ? ` · setback ${backPiece.setback} mm` : ''} — name comes from the group `
          + "(edit it on the group row); select this row to change only this piece's type / setback"
        : door && doorMember ? `${DOOR_TYPE_TITLE[doorMember.type]}${doorMember.leafCount === 2 ? ` · leaf ${doorMember.leaf + 1}/2` : ''}`
          + ' — name comes from the group (edit it on the group row)'
        : 'Name comes from the group (edit it on the group row)';
      return rowShell({
        key: vf.id, refKey: `vf-${vf.id}`, open: sel, sel, dragging: !member && dragIndex === rowIdx, armed: armedRowKey === vf.id,
        lead: member ? <span className="shrink-0 w-[6px] ml-[2px] self-stretch" /> : grip(vf.id, rowIdx, 'Drag to reorder'),
        onToggle: rowToggle(`vf-${vf.id}`, sel), num: label, small: member, kind: group ? group.kind : door ? 'door' : back ? 'back' : 'body',
        name: member && (group || slab) ? (
          <span title={memberTitle}
            className="flex-1 min-w-0 h-[22px] px-[5px] flex items-center gap-1.5 text-[11.5px] font-medium text-stone-500 truncate cursor-default select-none">
            {backPiece && <span className="shrink-0 text-stone-400"><BackTypeIcon type={backPiece.placement} size={11} strokeWidth={1.4} /></span>}
            {door && doorMember && <span className="shrink-0 text-stone-400"><DoorTypeIcon type={doorMember.type} size={11} strokeWidth={1.4} /></span>}
            <span className="truncate">{group ? groupName(group) : door ? doorGroupName(door) : backGroupName(back!)}</span>
            {door && doorMember?.leafCount === 2 && (
              <span className="shrink-0 text-[10px] font-semibold text-stone-400 tabular-nums">{doorMember.leaf + 1}/2</span>
            )}
          </span>
        ) : (
          <input type="text" value={vf.description || ''} onClick={stop} onChange={e => updateVirtualFace(vf.id, { description: e.target.value })}
            placeholder="Panel" title="Panel name" className={`${ROW_INPUT_CLASS} font-medium`} />
        ),
        dims: <RowDims w={dims?.primary} h={dims?.secondary} t={dims?.thickness} tLetter="T" />,
        trailW: member ? ROW_TRAIL_W - MEMBER_INSET : ROW_TRAIL_W,
        trail: <>
          {/* İç panelde (raf/dikme) serbest bölge yok → fit-shape gösterilmez. */}
          {!member && <FitShapeToggle checked={!!vf.fitFaceShape} disabled={noPanel} onToggle={() => { void toggleFitShape(vf); }} />}
          {slab ? <span className={ROW_SPACER} />
            : <DoorRefToggle checked={!!vf.doorBound} disabled={noPanel} onToggle={() => setVfDoorBound(vf.id, !vf.doorBound)} />}
          {slab ? <span className={ROW_SPACER} />
            : <BackRefToggle checked={vfBackBound(vf)} disabled={noPanel} onToggle={() => setVfBackBound(vf.id, !vfBackBound(vf))} />}
          <button disabled={noPanel} onClick={e => { stop(e); toggleArrow(vp); }} title="Toggle arrow direction"
            className={`${ROW_BTN} ${noPanel ? 'text-stone-200 cursor-not-allowed' : ar ? 'text-stone-700 bg-[#f1ece4]' : ROW_IDLE}`}>
            <ArrowUp size={ROW_ICON} strokeWidth={1.9} className={`transition-transform duration-200 ${ar ? '' : 'rotate-90'}`} />
          </button>
          {member ? <span className={ROW_SPACER} /> : <RowDelBtn title="Delete panel" onClick={() => { void deletePanelAndFace(vf.id); }} />}
        </>,
        body: () => renderExpandedBody(vf, vp),
      });
    };

    /** Grup kartı (raf/dikme · kapak · arkalık): açık = yerel açık kart ∨ tümü seçili ∨ üye satırı seçili; gövde + üye listesi. */
    const cardShell = (id: string, members: VirtualFace[], rowIdx: number, label: string, o: {
      selected: string | null; select: (id: string) => void; kind: RowKind; count: number; name: string; placeholder: string; plural: string;
      rename: (v: string) => void; remove: () => void; dims: React.ReactNode; section: string; member: VfOpts; body: () => React.ReactNode;
    }) => {
      const rowKey = `grp-${id}`, selAll = o.selected === id;
      const open = openCards.has(id) || selAll || members.some(m => m.id === selVf);
      const toggle = (e: React.MouseEvent) => { stop(e); if (open) closeCard(id, members.map(m => m.id)); else { o.select(id); openCard(id); } };
      return rowShell({
        key: rowKey, refKey: rowKey, open, sel: selAll, dragging: dragIndex === rowIdx, armed: armedRowKey === rowKey,
        lead: grip(rowKey, rowIdx, 'Drag to reorder (whole group)'), onToggle: toggle,
        title: open ? 'Collapse' : `Expand — selects all ${o.plural} in this group`, num: label, kind: o.kind, count: o.count, dims: o.dims,
        name: <input type="text" value={o.name} onClick={stop} onChange={e => o.rename(e.target.value)} placeholder={o.placeholder}
          title={`Group name (applies to all its ${o.plural})`} className={`${ROW_INPUT_CLASS} font-semibold`} />,
        trail: <RowDelBtn title={`Delete group (all ${o.plural})`} onClick={o.remove} />,
        body: () => (
          <div className={CARD_BODY} style={CARD_BODY_STYLE} onClick={stop}>
            {o.body()}
            <SectionHead label={o.section} count={members.length} />
            <div className="flex flex-col gap-[2px]">
              {members.map((m, mi) => vfRow(m, rowIdx, `${label}.${mi + 1}`, { member: true, ...o.member }))}
            </div>
          </div>
        ),
      });
    };

    const groupCard = (g: PanelGroup, members: VirtualFace[], rowIdx: number, label: string) => {
      const [w, h, d] = [0, 1, 2].map(a => round1(boxSpan(g.cavity, a)));
      return cardShell(g.id, members, rowIdx, label, {
        selected: selectedPanelGroupId, select: setSelectedPanelGroupId, kind: g.kind, count: g.count, name: groupName(g),
        placeholder: groupKindLabel(g.kind), plural: 'panels', section: 'Panels', member: { group: g },
        rename: v => renamePanelGroup(g.id, v), remove: () => deletePanelGroupWithMembers(g.id),
        dims: <RowDims w={w} h={h} t={d} tLetter="D" title="Cavity width · height · depth" />,
        body: () => {
          const editingVol = faceExtrudeMode && faceExtrudeCavityGroupId === g.id;
          const relocating = !!volumePickMode && volumePickGroupId === g.id;
          const autoGap = g.targetGap != null && g.targetGap > 0;
          const applyCount = (n: number) => { setFieldDraft(null); if (!isNaN(n) && n >= 1 && n !== g.count) void setGroupCount(g.id, n); };
          const mvf = g.memberVfIds.map(vfById);
          return <>
            <div className="flex items-center gap-1 mb-1.5">
              <CardAction compact icon={Box} label="Volume" active={editingVol}
                title="Edit the volume: pick a face in the 3D view, then extrude it (fixed / dyn / ref)"
                onClick={() => { if (editingVol) setFaceExtrudeMode(false); else startCavityEdit(g.id); }} />
              <CardAction compact icon={Move3d} label="Relocate" active={relocating}
                title="Pick a new volume for this group in the 3D view (count, thicknesses and list order are kept)"
                onClick={() => { if (relocating) setVolumePickMode(null); else startGroupRepick(g.id); }} />
              <DoorBondBadge g={g} onUnbind={() => updatePanelGroup(g.id, { doorBond: undefined })} />
              <span className="flex-1 min-w-0" />
              <FieldBox fixed label="Qty" title="Number of panels">
                <StepBtn title="Fewer" disabled={g.count <= 1} onClick={() => applyCount(g.count - 1)}><Minus size={11} strokeWidth={2.2} /></StepBtn>
                <input {...draftInput(`${g.id}:count`, String(g.count), raw => applyCount(parseInt(raw, 10)))} inputMode="numeric"
                  style={{ ...FIELD_INPUT, width: 26 }} />
                <StepBtn title="More" onClick={() => applyCount(g.count + 1)}><Plus size={11} strokeWidth={2.2} /></StepBtn>
              </FieldBox>
              <FieldBox fixed label="Spacing" accent={autoGap}
                title={autoGap ? `Target spacing ${g.targetGap} mm — the count follows the volume size. Clear to stop.`
                  : 'Target spacing (mm): the count is set to match it and follows the volume size'}>
                <input {...draftInput(`${g.id}:gap`, autoGap ? String(g.targetGap) : '', raw => {
                  const v = parseNum(raw), next = Number.isFinite(v) && v > 0 ? round1(v) : null;
                  if (next !== (autoGap ? g.targetGap : null)) void setGroupTargetGap(g.id, next);
                })} inputMode="decimal" placeholder="auto"
                  style={{ ...FIELD_INPUT, width: 44, textAlign: 'right', ...(autoGap ? { color: '#9a3412' } : {}) }} />
                {autoGap ? (
                  <ClearBtn title="Clear the target spacing (the current count stays)" label="Clear target spacing"
                    onClick={() => { setFieldDraft(null); void setGroupTargetGap(g.id, null); }} />
                ) : unitTxt('mm')}
              </FieldBox>
              <IconSquareBtn icon={Equal} title="Equalize gaps (unlock all)" onClick={() => { void equalizeGroupGaps(g.id); }} />
            </div>
            <GroupSchematic group={g} selectedIndex={selIdx(g.memberVfIds)} memberLabels={memberLabels(label, members, g.memberVfIds)}
              onEditGap={(k, v, pv) => { if (pv) previewGroupGap(g.id, k, v); else void editGroupGap(g.id, k, v); }}
              onToggleLock={k => toggleGroupGapLock(g.id, k)}
              onEditBegin={() => groupLayoutSnapshot(g.id)} onEditCancel={snap => restoreGroupLayout(g.id, snap as GroupLayoutSnap | null)}
              doorRefs={mvf.map(f => !!f?.doorBound)} backRefs={mvf.map(f => vfBackBound(f))}
              onToggleBackRef={i => { const f = mvf[i]; if (f) setVfBackBound(f.id, !vfBackBound(f)); }}
              onEditThickness={(i, v, pv) => { if (pv) previewGroupMemberThickness(g.id, i, v); else void setGroupMemberThickness(g.id, i, v); }}
              onSelectMember={i => { const id = g.memberVfIds[i]; if (id) setSelectedPanelRow(`vf-${id}`, sid); }}
              onToggleDoorRef={i => { const f = mvf[i]; if (f) setVfDoorBound(f.id, !f.doorBound); }} />
            <ExtrudeDock cavity={g} draft={extrudeThicknessStr} setDraft={setExtrudeThicknessStr} />
            <VolumeSteps group={g} edit={stepEdit} setEdit={setStepEdit} />
          </>;
        },
      });
    };

    const doorCard = (g: DoorGroup, members: VirtualFace[], rowIdx: number, label: string) => cardShell(g.id, members, rowIdx, label, {
      selected: selectedDoorGroupId, select: setSelectedDoorGroupId, kind: 'door', count: doorMemberCount(g), name: doorGroupName(g), placeholder: 'Door',
      plural: 'doors', section: 'Doors', member: { door: g }, rename: v => renameDoorGroup(g.id, v), remove: () => deleteDoorGroupWithMembers(g.id),
      dims: <RowDims w={round1(g.rect.u1 - g.rect.u0)} h={round1(g.rect.v1 - g.rect.v0)} t={g.thickness} tLetter="T"
        title={`Door area width · height · thickness (${doorPlacementLabel(g.placement).toLowerCase()} door)`} />,
      body: () => {
        const parent = shapeById(g.shapeId, shapes);   // pahalı: kesimler yalnız kart açıkken çözülür
        const solvedTree = solveDoorTree(g);
        const rg = regionTools({
          gid: g.id, tree: g.tree, sel: doorNodeSel, setSel: setDoorNodeSel, depthOf: id => findSolvedNode(solvedTree, id)?.depth,
          split: setDoorNodeSplit, splitAt: splitDoorAtPanel, live: () => useAppStore.getState().doorGroups.find(x => x.id === g.id)?.tree,
          endRefPick: () => setDoorRefPickGroupId(null), whole: 'whole door area', one: 'the selected door',
        });
        const leaves = doorLeaves(g.tree), allLeafIds = leaves.map(l => l.id);
        const typeTargets = rg.picked.length ? [...new Set(leafIdsUnder(g.tree, rg.picked))] : allLeafIds;
        const typeOf = (id: string) => leaves.find(l => l.id === id)?.type ?? 'left';
        const commonType = typeTargets.length && typeTargets.every(id => typeOf(id) === typeOf(typeTargets[0])) ? typeOf(typeTargets[0]) : null;
        const typeHint = rg.picked.length ? `${typeTargets.length} / ${allLeafIds.length}` : allLeafIds.length === 1 ? '1 door' : `All · ${allLeafIds.length}`;
        const refMode = doorRefPickGroupId === g.id;
        const splitMode: SplitMode = refMode ? 'ref' : doorSplitMode?.id === g.id ? doorSplitMode.mode : 'count';
        const pickSplitMode = (m: SplitMode) => {
          if (m === 'ref') { setDoorAddPick(null); setDoorRefPickGroupId(g.id); return; }
          if (refMode) setDoorRefPickGroupId(null);
          setDoorSplitMode({ id: g.id, mode: m });
        };
        const addPick = doorAddPick?.id === g.id ? doorAddPick.axis : null;
        const toggleAddPick = (axis: 'u' | 'v') => {
          if (addPick === axis) { setDoorAddPick(null); return; }
          if (refMode) setDoorRefPickGroupId(null);
          setDoorAddPick({ id: g.id, axis });
        };
        // Her parça kendi grubu (listede kendi kartı); yeni kart bilinçli olarak otomatik AÇILMAZ/seçilmez — kapak kartı açık kalır.
        const onAddPick = (splitId: string, k: number, ats: number[]) => {
          if (!ats.map(at => addPanelAtDoorJoint(g.id, splitId, k, at)).some(pg => !!pg)) return;
          setDoorAddPick(null);
          setSelectedDoorGroupId(g.id);
          openCard(g.id);
        };
        const joints = doorJoints(solvedTree);
        const planeAx = doorPlaneAxes(g.axis);
        // addObstacles yalnız araya ekleme modunda: işaretsiz dikme/raflar da derzi keser.
        const nearPanels = parent ? doorNearPanels(g, parent, shapes, virtualFaces, panelGroups) : [];
        const addObstacles = parent && addPick ? doorNearPanels(g, parent, shapes, virtualFaces, panelGroups, undefined, true) : undefined;
        // Spacing: yoksa kapsamdaki ilk hedef gösterilir (iptal edilebilsin); iptal kapsamdaki o eksenli TÜM hedefleri kaldırır.
        const sizeOf = (ax: 'u' | 'v') => {
          const n = rg.splitNode;
          if (n.kind === 'split' && n.axis === ax && n.targetSize) return n.targetSize;
          return doorSpacingTargetsInScope(g.tree, rg.scope, ax)[0]?.targetSize ?? null;
        };
        const setSize = (ax: 'u' | 'v', mm: number | null) => {
          if (mm == null) { clearDoorSpacing(g.id, rg.scope, ax); return; }
          rg.select(rg.scope.map(id => setDoorNodeSpacing(g.id, id, ax, mm)).filter((x): x is string => !!x));
        };
        const sizeTitle = (ax: 'u' | 'v') => `Spacing ${ax === 'u' ? 'V — target door width' : 'H — target door height'} (mm) for ${rg.regionName}: `
          + 'the number of pieces is derived from the region length (nearest fit, equal pieces) and re-derived when the body resizes. '
          + 'Clear it (× or empty + Enter) to cancel the target — the current pieces stay.';
        return <>
          <div className="flex items-center gap-1 mb-1.5">
            <PlacementSelect value={g.placement} onChange={v => { void setDoorPlacement(g.id, v); }} />
            <FieldBox fixed label="T" title="Door thickness (mm)">
              <input {...draftInput(`${g.id}:t`, String(g.thickness), raw => {
                const v = parseNum(raw);
                if (Number.isFinite(v)) void setDoorThickness(g.id, v);
              })}
                inputMode="decimal" style={{ ...FIELD_INPUT, width: 34, textAlign: 'right' }} />
              {unitTxt('mm')}
            </FieldBox>
            <SplitModeSelect value={splitMode} onChange={pickSplitMode} />
            {splitMode === 'count' && <>
              <CountBox icon={SplitSquareVertical} label="V" value={rg.countOf('u')} title={rg.countTitle('u')} onChange={n => rg.setCount('u', n)} />
              <CountBox icon={SplitSquareHorizontal} label="H" value={rg.countOf('v')} title={rg.countTitle('v')} onChange={n => rg.setCount('v', n)} />
            </>}
            {splitMode === 'spacing' && <>
              <SizeBox icon={SplitSquareVertical} label="V" value={sizeOf('u')} title={sizeTitle('u')} onChange={mm => setSize('u', mm)} />
              <SizeBox icon={SplitSquareHorizontal} label="H" value={sizeOf('v')} title={sizeTitle('v')} onChange={mm => setSize('v', mm)} />
            </>}
            {splitMode === 'ref' && (
              <div className="flex-1 min-w-0">
                <DockStatus ready text="Pick a divider / shelf"
                  title={'Door-reference dividers and shelves glow amber in the 3D view (doors go transparent); click one in the 3D view or its band in the '
                    + "schematic. The door splits through the panel's middle and the joint is bound to the panel: when the panel moves, the doors follow. "
                    + 'Esc / another mode cancels.'} />
              </div>
            )}
            <IconSquareBtn icon={Equal} title="Equalize sizes (unlock all)" onClick={() => { void equalizeDoorGroup(g.id); }} />
          </div>
          <JointPanelBar outer={g.placement === 'outer'} pick={addPick} onToggle={toggleAddPick}
            joints={{ u: joints.filter(j => j.axis === 'u').length, v: joints.filter(j => j.axis === 'v').length }}
            added={addPick ? panelGroups.filter(pg => pg.doorBond?.doorGroupId === g.id && pg.axis === planeAx[addPick]).length : 0}
            freeParts={addPick ? doorJointParts(joints, addObstacles ?? nearPanels, addPick).reduce((a, p) => a + p.free.length, 0) : 0} />
          <DoorTypeBar value={commonType} hint={typeHint} onPick={t => { void setDoorLeafTypes(g.id, typeTargets, t); setDoorNodeSel(null); }} />
          <DoorSchematic group={g} selectedIndex={selIdx(g.memberVfIds)} selectedNodes={rg.picked}
            memberLabels={memberLabels(label, members, g.memberVfIds)} cuts={parent ? collectDoorCuts(parent, shapes, virtualFaces) : []}
            nearPanels={nearPanels} addObstacles={addObstacles}
            refPick={refMode} onRefPick={rg.onRefPick} onSplitAtPanel={rg.onSplitAtPanel}
            addPick={addPick} onAddPick={onAddPick} onRemovePick={pgId => { deletePanelGroupWithMembers(pgId); }}
            onEditSize={(sid, k, v, pv) => { void editDoorSize(g.id, sid, k, v, { preview: pv }); }}
            onToggleLock={(sid, k) => toggleDoorSizeLock(g.id, sid, k)}
            onEditSplitGap={(sid, k, v, pv) => { void setDoorSplitGap(g.id, sid, k, v, { preview: pv }); }}
            onEditEdgeGap={(edge, v, pv) => { void setDoorEdgeGap(g.id, edge, v, { preview: pv }); }}
            onEditLeaf={(lid, k, v, pv) => { void editDoorLeafSize(g.id, lid, k, v, { preview: pv }); }}
            onEditLeafGap={(lid, v, pv) => { void setDoorLeafGap(g.id, lid, v, { preview: pv }); }}
            onEditBegin={() => doorLayoutSnapshot(g.id)} onEditCancel={snap => restoreDoorLayout(g.id, snap as DoorLayoutSnap | null)}
            onToggleHalfOverlay={(edge, on) => { void setDoorHalfOverlay(g.id, edge, on); }}
            onEdgeOverlay={(edge, mode) => { void setDoorEdgeOverlay(g.id, edge, mode); }}
            onAlignJoint={(sid, k, vfId, a) => { void setDoorJointRef(g.id, sid, k, vfId, a); }}
            onJointOverlay={(sid, k, vfId, a) => { void setDoorJointOverlay(g.id, sid, k, vfId, a); }}
            onPathClick={rg.onPathClick} />
        </>;
      },
    });

    // ARKALIK kartı (BackService): kapak kartından AYRI — kanal bloğu (tip · bölme V / H · değerler), şema ve üyeler.
    // Bölge seçimi bu kartın durumudur; Panel ref modu store'da (3B'de levha tıkı).
    const backCard = (g: BackGroup, members: VirtualFace[], rowIdx: number, label: string) => {
      // Satır W/H = arkalık parçalarının GERÇEK dış ölçüsü (kanala giriş dahil — Goker: "In değeri etki etmiyor" sanılıyordu);
      // parçalar henüz üretilmemişse açıklık dikdörtgeni.
      const boxes = members.map(m => localBboxOf(panelOfVf(m.id, shapes)?.geometry)).filter((b): b is Box3 => !!b);
      const ext = boxes.length ? boxes.reduce((acc, b) => acc.union(b), boxes[0].clone()) : null;
      const kinds = new Set(backLeaves(g.tree).map(l => backPieceOf(g, l).placement));
      const typeTxt = kinds.size > 1 ? 'mixed nailed / grooved pieces' : `${BACK_TYPE_LABEL[[...kinds][0] ?? g.placement].toLowerCase()} back panel`;
      return cardShell(g.id, members, rowIdx, label, {
        selected: selectedBackGroupId, select: setSelectedBackGroupId, kind: 'back', count: backMemberCount(g), name: backGroupName(g),
        placeholder: 'Back', plural: 'back panels', section: 'Back panels', member: { back: g },
        rename: v => renameBackGroup(g.id, v), remove: () => deleteBackGroupWithMembers(g.id),
        dims: <RowDims w={round1(ext ? ext.max.x - ext.min.x : g.rect.u1 - g.rect.u0)} h={round1(ext ? ext.max.y - ext.min.y : g.rect.v1 - g.rect.v0)}
          t={g.thickness} tLetter="T" title={`Back panel overall width · height (groove entry included) · thickness (${typeTxt})`} />,
        body: () => {
          const parent = shapeById(g.shapeId, shapes);   // pahalı: kesimler / çözüm yalnız kart açıkken
          // Çözüm: iç dikdörtgen + parça dikdörtgenleri (her parça kendi tip / setback / inset / bini değerleriyle). Gövde yoksa kenar bilgisiz.
          const sol = (parent && solveBackGroup(g, parent, shapes)) || backFallbackSolution(g);
          const rg = regionTools({
            gid: g.id, tree: g.tree, sel: backNodeSel, setSel: setBackNodeSel, depthOf: id => findSolvedBackNode(sol.solved, id)?.depth,
            split: setBackNodeSplit, splitAt: splitBackAtPanel, live: () => useAppStore.getState().backGroups.find(x => x.id === g.id)?.tree,
            endRefPick: () => setBackRefPickGroupId(null), whole: 'whole back area', one: 'the selected piece',
          });
          const selMemberIdx = selIdx(g.memberVfIds);
          const leaves = backLeaves(g.tree);
          // HEDEF PARÇALAR (tip / setback): seçili bölgelerin yaprakları, yoksa seçili üye satırının parçası,
          // yoksa tüm parçalar (grup varsayılanı yazılır).
          const memberLeaf = selMemberIdx >= 0 ? backLeafOfMember(g, selMemberIdx) : undefined;
          const scoped = rg.picked.length > 0 || !!memberLeaf;
          const targetLeafIds = rg.picked.length ? leafIdsUnder(g.tree, rg.picked) : memberLeaf ? [memberLeaf.id] : leaves.map(l => l.id);
          const targetPieces = targetLeafIds.map(id => { const n = findBackNode(g.tree, id); return backPieceOf(g, n && n.kind === 'leaf' ? n : null); });
          const commonPlacement: BackPlacement | null =
            targetPieces.length && targetPieces.every(p => p.placement === targetPieces[0].placement) ? targetPieces[0].placement : null;
          const grooved = targetPieces.filter(p => p.placement === 'inner');
          const isGrooved = grooved.length > 0;   // hedef parçalarda kanallı var → kanal bloğu etkin; yoksa çakma görünümü, paylar pasif
          const setbackVal = grooved.length ? grooved[0].setback : backSetbackOf(g);
          const setbackMixed = grooved.some(p => Math.abs(p.setback - setbackVal) > 0.05);
          const pieceLabel = (leafId: string) => {
            const li = leaves.findIndex(l => l.id === leafId);
            return memberLabel(label, members, g.memberVfIds[li], li);
          };
          const typeHint = !scoped ? 'All pieces' : targetLeafIds.length === 1 ? `Piece ${pieceLabel(targetLeafIds[0])}` : `${targetLeafIds.length} pieces`;
          // KANAL PAYI kapsamı: şemada bir kenarın "±" rozeti seçiliyse yalnız o kenar, değilse grup değeri (aynı satırda).
          const clearF = backClearEdge?.id === g.id ? vfById(backClearEdge.vfId) : undefined;
          const clearVf = clearF?.id, clearName = clearF ? clearF.description || 'Edge' : '';
          const clearOwn = !!clearVf && backGrooveClearOverridden(g, clearVf);
          const gc = backGrooveClearOf(g, clearVf);
          const commit = (field: BackField) => (raw: string) => {
            const v = parseNum(raw);
            if (!Number.isFinite(v)) return;
            if (field === 't') void setBackThickness(g.id, v);
            else if (field === 'setback') void setBackSetback(g.id, v, scoped ? targetLeafIds : []);
            else void setBackGrooveClear(g.id, { [GROOVE_KEY[field]]: v }, clearVf);
          };
          // Görsel ipucu: üzerine gelinen değerin anahtarı → kesit diyagramı + şema vurgusu.
          const hintKey = backHint?.id === g.id ? backHint.key : null;
          const onHint = (k: string | null) => setBackHint(k ? { id: g.id, key: k } : null);
          const cell = (name: string, field: BackField, value: number, o: { accent?: boolean; passive?: boolean; mixed?: boolean } = {}) => (
            <HintCell label={name} hintKey={field} active={hintKey === field} onHint={onHint} accent={o.accent} passive={o.passive}>
              <input {...draftInput(`${g.id}:${field}:${clearVf ?? ''}`, String(value), commit(field))} {...(o.passive ? { value: '0' } : {})}
                inputMode="decimal" placeholder={o.mixed ? '…' : undefined} disabled={o.passive}
                style={{
                  ...FIELD_INPUT, width: 34, flexShrink: 0, textAlign: 'right', ...(o.mixed ? { color: '#9a3412' } : {}), ...(o.passive ? PASSIVE_INPUT : {}),
                }} />
            </HintCell>
          );
          const pas = { accent: !!clearVf, passive: !isGrooved };
          return <>
            {/* KANAL BLOĞU: solda kesit diyagramı (yükseklik = 4 eşit satır), sağda 4 satır × 2 sütun — satır 1: tip + bölme V / H;
                satır 2–4: Thick · Setback / Front + · Rear + / Bottom + · Groove. Çakmada setback ve paylar 0 ve pasif; geri bildirim görsel. */}
            <div className="mb-1.5 flex gap-1.5" style={{ height: BACK_BLOCK_H }} onMouseLeave={() => setBackHint(null)}>
              <div className="relative shrink-0 h-full" style={{ width: `min(${BACK_DIAGRAM_W}px, 40%)` }}>
                <BackGrooveDiagram active={hintKey} grooved={isGrooved} t={g.thickness} setback={isGrooved ? setbackVal : 0} front={gc.front} rear={gc.back}
                  depth={gc.depth} className="w-full h-full" />
                {/* Kenar kapsamı (şemadaki ± rozeti): yalnız bir kenar seçiliyken. */}
                {clearVf && (
                  <div className="absolute bottom-1 right-1 flex items-center gap-[2px]">
                    <button type="button" onClick={e => { stop(e); setBackClearEdge(null); }}
                      className="h-[17px] pl-1.5 pr-1 rounded-full flex items-center gap-[2px] bg-orange-50 ring-1 ring-orange-300 text-orange-700 text-[9.5px] font-semibold hover:bg-orange-100 max-w-[110px]">
                      <span className="truncate">{clearName}</span><X size={9} strokeWidth={2.6} className="shrink-0" /></button>
                    {clearOwn && (
                      <button type="button" onClick={e => { stop(e); void resetBackGrooveClear(g.id, clearVf); }}
                        className="w-[17px] h-[17px] rounded-full flex items-center justify-center bg-orange-50 ring-1 ring-orange-300 text-orange-600 hover:bg-orange-100">
                        <RotateCcw size={9} strokeWidth={2.4} />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0 grid grid-cols-2 gap-x-1" style={{ gridTemplateRows: 'repeat(4, minmax(0, 1fr))', rowGap: BACK_ROW_GAP }}>
                <BackTypeButtons value={commonPlacement} hint={typeHint} onPick={t => { void setBackPlacement(g.id, t, scoped ? targetLeafIds : []); }} />
                <div className="min-w-0 h-full grid grid-cols-2 gap-1">
                  <CountMini icon={SplitSquareVertical} value={rg.countOf('u')} title={rg.countTitle('u')} onChange={n => rg.setCount('u', n)} />
                  <CountMini icon={SplitSquareHorizontal} value={rg.countOf('v')} title={rg.countTitle('v')} onChange={n => rg.setCount('v', n)} />
                </div>
                {cell('Thickness', 't', g.thickness)}
                {cell('Setback', 'setback', setbackVal, { accent: scoped && isGrooved, passive: !isGrooved, mixed: setbackMixed })}
                {cell('Front gap', 'gf', gc.front, pas)}
                {cell('Rear gap', 'gb', gc.back, pas)}
                {cell('Bottom gap', 'gd', gc.depth, pas)}
                <div className={`${READ_CELL} ${isGrooved ? '' : 'opacity-60'}`} title="Groove width × depth (In = entry into the panel, set per edge in the schematic)">
                  <span className={`flex-1 min-w-0 truncate ${CELL_LABEL}`}>Groove</span>
                  <span className="whitespace-nowrap" style={{ ...FIELD_INPUT, width: 'auto', color: '#57534e' }}>
                    {isGrooved ? <>
                      {fmt1(g.thickness + gc.front + gc.back)}
                      <span className="text-[10px] font-medium text-stone-400" style={{ fontFamily: UI_FONT }}> × In + {fmt1(gc.depth)}</span>
                    </> : '—'}
                  </span>
                </div>
              </div>
            </div>
            <BackSchematic group={g} solution={sol} selectedIndex={selMemberIdx} selectedNodes={rg.picked}
              memberLabels={memberLabels(label, members, g.memberVfIds)}
              cuts={parent ? collectBackCuts(parent, shapes, virtualFaces) : []}
              nearPanels={parent ? backNearPanels(g, parent, shapes, virtualFaces, panelGroups) : []}
              refPick={backRefPickGroupId === g.id} onRefPick={rg.onRefPick} onSplitAtPanel={rg.onSplitAtPanel}
              onEditSize={(sid, k, v, pv) => { void editBackSize(g.id, sid, k, v, { preview: pv }); }}
              onToggleLock={(sid, k) => toggleBackSizeLock(g.id, sid, k)}
              onEditSplitGap={(sid, k, v, pv) => { void setBackSplitGap(g.id, sid, k, v, { preview: pv }); }}
              onEditInset={(edge, mm, ids, pv) => { void setBackEdgeInset(g.id, edge, mm, ids, { preview: pv }); }}
              onEditJointIn={(edge, mm, ids, pv) => { void setBackJointIn(g.id, edge, mm, ids, { preview: pv }); }}
              onEditBegin={() => backLayoutSnapshot(g.id)} onEditCancel={snap => restoreBackLayout(g.id, snap as BackLayoutSnap | null)}
              onEditCover={(edge, mm, ids, pv) => { void setBackEdgeCover(g.id, edge, mm, ids, { preview: pv }); }}
              onToggleEdgeRel={edge => { void setBackEdgeRel(g.id, edge, edgeRelOf(g, edge) === 'nail' ? 'groove' : 'nail'); }}
              onToggleJointRel={(sid, k) => { void setBackJointRel(g.id, sid, k, backJointRelOf(g.tree, sid, k) === 'nail' ? 'groove' : 'nail'); }}
              clearVfId={clearVf} onPickClearEdge={vfId => setBackClearEdge(clearVf === vfId ? null : { id: g.id, vfId })}
              grooveHint={hintKey === 'gf' || hintKey === 'gb' || hintKey === 'gd' ? hintKey : null}
              onPathClick={rg.onPathClick} />
          </>;
        },
      });
    };

    const elements: React.ReactNode[] = [];
    rows.forEach((row, rowIdx) => {
      const draggingThis = dragIndex === rowIdx, dropHere = dropIndex === rowIdx;
      const label = String(rowIdx + 1);
      elements.push(
        <div key={`wrap-${rowKeyOf(row)}`} className={dropHere ? 'rounded-[10px] ring-1 ring-amber-300 bg-[#fffbf0]' : ''}
          onDragOver={e => {
            if (dragIndex === null || draggingThis) return;
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
            if (dropIndex !== rowIdx) setDropIndex(rowIdx);
          }}
          onDrop={e => { e.preventDefault(); if (dragIndex !== null) void onRowDropBelow(dragIndex, rowIdx); }}>
          {row.kind === 'vf' ? vfRow(row.vf, rowIdx, label, {})
            : row.kind === 'door' ? doorCard(row.group, row.members, rowIdx, label)
            : row.kind === 'back' ? backCard(row.group, row.members, rowIdx, label)
            : groupCard(row.group, row.members, rowIdx, label)}
        </div>
      );
      if (dropHere && !draggingThis) elements.push(<div key={`${rowKeyOf(row)}-drop-ind`} className={`${DROP_BAND} -my-0.5`} />);
    });
    // Bırakma hep satırın ALTINA olduğundan en üste taşıma için ayrı bırakma alanı gerekir.
    if (dragIndex !== null && dragIndex !== 0 && rows.length > 0) {
      elements.unshift(
        <div key="drop-top" className="h-4 -mb-1 flex items-center"
          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropIndex !== -2) setDropIndex(-2); }}
          onDrop={e => { e.preventDefault(); if (dragIndex !== null) void doReorder(idsOf(rows[dragIndex]), idsOf(rows[0])[0]); }}>
          {dropIndex === -2 && <div className={`${DROP_BAND} w-full`} />}
        </div>
      );
    }
    if (bodyLegs) elements.unshift(legsRow(bodyLegs));
    const quickParts = quickBodyVfsOf(sid, svf).length, quickSaved = quickBodyOf(selectedShape);
    if (quickParts && quickSaved) elements.unshift(quickRow(quickSaved, quickParts));
    return elements;
  };

  /* HIZLI GÖVDE: yapılandırma listenin üstünde (üst şerit yapışık) ya da Body satırında (revise). Onay → servis; bitince mod kapanır /
     taslak düşer (saklı ayar görünür). */
  const onQuickBodyApply = async (cfg: QuickBodyConfig, revise = false) => {
    if (!selectedShape || quickBodyBusy) return;
    setQuickBodyBusy(true);
    try {
      await applyQuickBody(selectedShape.id, cfg);
      if (revise) setQuickDraft(null); else setQuickBodyMode(false);
    } catch (e) { console.error('[YAGO][HIZLI-GÖVDE] hata:', e); }
    finally { setQuickBodyBusy(false); }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <style>{LIST_CSS}</style>
      <PlacementDocks shape={selectedShape} />
      {selectedShape ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {quickBodyMode && (
            <QuickBodyPanel shape={selectedShape} cfg={quickBodyConfig} setCfg={setQuickBodyConfig} busy={quickBodyBusy}
              existingCount={virtualFaces.filter(vf => vf.shapeId === selectedShape.id && !vf.interior).length}
              onApply={() => { void onQuickBodyApply(useAppStore.getState().quickBodyConfig); }} onExit={() => setQuickBodyMode(false)} />
          )}
          <div className="px-0.5 pb-2 space-y-[2px]">{renderFaceList()}</div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center"><div className="text-center text-stone-400 text-xs py-4">No shape selected</div></div>
      )}
    </div>
  );
}
