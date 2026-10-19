import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, Box, Equal, GripVertical, Minus, Move, Move3d, MoveVertical, Plus, RotateCcw, RotateCw, SplitSquareHorizontal, SplitSquareVertical, X,
} from 'lucide-react';
import type { Box3 } from 'three';
import {
  type BackGroup, type BackPlacement, type DoorGroup, type PanelGroup, type Shape, type VirtualFace, childPanelsOf, panelOfVf, requestRebuild,
  shapeById, useAppStore, useStoreFields,
} from '../store';
import { UI_FONT } from './Ui';
import {
  convertReplicadToThreeGeometry, createPanelFromVirtualFace, dominantAxisLabel, effectiveBodyGeometry, genId, getFacesAndGroups, isFlatNormal,
  localBboxOf, round1,
} from './Geometry';
import { applyQuickBody, bodyLegsOf, legHeightOf, setBodyLegs } from './QuickBodyService';
import { findExistingStepForFace } from './PanelOps';
import {
  type GroupLayoutSnap, boxSpan, deletePanelGroupWithMembers, editGroupGap, equalizeGroupGaps, groupKindLabel, groupLayoutSnapshot, groupName,
  memberThicknessesOf, previewGroupGap, previewGroupMemberThickness, renamePanelGroup, restoreGroupLayout, setGroupCount, setGroupMemberThickness,
  setGroupTargetGap, startCavityEdit, startGroupRepick, toggleGroupGapLock,
} from './PanelGroupService';
import {
  type DoorLayoutSnap, DOOR_TYPE_TITLE, addPanelAtDoorJoint, clearDoorSpacing, collectDoorCuts, deleteDoorGroupWithMembers, doorGroupName,
  doorJointParts, doorJoints, doorLayoutSnapshot, doorLeaves, doorMemberCount, doorMembersOf, doorNearPanels, doorPlacementLabel, doorPlaneAxes,
  doorSpacingTargetsInScope, editDoorLeafSize, editDoorSize, equalizeDoorGroup, findSolvedNode, renameDoorGroup, restoreDoorLayout, setDoorEdgeGap,
  setDoorEdgeOverlay, setDoorHalfOverlay, setDoorJointOverlay, setDoorJointRef, setDoorLeafGap, setDoorLeafTypes, setDoorNodeSpacing, setDoorNodeSplit,
  setDoorPlacement, setDoorSplitGap, setDoorThickness, setVfDoorBound, solveDoorTree, splitDoorAtPanel, toggleDoorSizeLock,
} from './DoorService';
import {
  type BackLayoutSnap, BACK_TYPE_LABEL, BACK_TYPE_TITLE, backFallbackSolution, backGrooveClearOf, backGrooveClearOverridden, backGroupName,
  backJointRelOf, backLayoutSnapshot, backLeafOfMember, backLeaves, backMemberCount, backNearPanels, backPieceOf, backSetbackOf, collectBackCuts,
  deleteBackGroupWithMembers, edgeRelOf, editBackSize, findBackNode, findSolvedBackNode, renameBackGroup, resetBackGrooveClear, restoreBackLayout,
  setBackEdgeCover, setBackEdgeInset, setBackEdgeRel, setBackGrooveClear, setBackJointIn, setBackJointRel, setBackNodeSplit, setBackPlacement,
  setBackSetback, setBackSplitGap, setBackThickness, setVfBackBound, solveBackGroup, splitBackAtPanel, toggleBackSizeLock, vfBackBound,
} from './BackService';
import { GroupSchematic, PanelPreview2D, geoAxes, panelDims } from './panel-editor/preview';
import {
  BackRefToggle, CARD_BODY, CARD_BODY_STYLE, CELL_LABEL, CardAction, ClearBtn, CountBox, CountMini, DROP_BAND, DockStatus, DoorRefToggle, FIELD_INPUT,
  FieldBox, FitShapeToggle, IconSquareBtn, LIST_CSS, MEMBER_INSET, PASSIVE_INPUT, PREVIEW_BG, PREVIEW_FRAME, PREVIEW_HEIGHT, PlacementSelect, READ_CELL,
  ROW_BTN, ROW_ICON, ROW_IDLE, ROW_INPUT_CLASS, ROW_SEL_BAR, ROW_SEL_HEAD, ROW_SPACER, ROW_TRAIL_W, RowCells, RowChevron, RowDims, RowNum, RowTypeBadge,
  SectionHead, Segmented, SizeBox, type SplitMode, SplitModeSelect, StepBtn, fmt1, parseNum, rowCardClass, stop, unitTxt,
} from './panel-editor/kit';
import {
  BACK_BLOCK_H, BACK_DIAGRAM_W, BACK_ROW_GAP, BackGrooveDiagram, BackTypeButtons, BackTypeIcon, DoorTypeBar, DoorTypeIcon, HintCell, LegsBlock,
  QuickBodyPanel,
} from './panel-editor/cardBlocks';
import {
  type NodeSel, type StepEdit, DoorBondBadge, ExtrudeDock, JointPanelBar, MoveDock, PanelSteps, PlacementDocks, RotateDock, RowDelBtn, VolumeSteps,
  leafIdsUnder, memberLabel, memberLabels, regionTools,
} from './panel-editor/cards';
import { DoorSchematic } from './panel-editor/doorSchematic';
import { BackSchematic } from './panel-editor/backSchematic';

/* PANEL EDİTÖRÜ — sol çubuktaki panel listesi (VF satırları, ayaklar, raf/dikme · kapak · arkalık grup kartları), satır
   önizlemesi ve liste durumu. Şeritler / adım listeleri panel-editor/cards'ta; mantık motora (PanelOps / PanelGroupService /
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

type RowKind = React.ComponentProps<typeof RowTypeBadge>['kind'];
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
    if (st.selectedPanelRow !== null) {
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
                {cell('Thick', 't', g.thickness)}
                {cell('Setback', 'setback', setbackVal, { accent: scoped && isGrooved, passive: !isGrooved, mixed: setbackMixed })}
                {cell('Front', 'gf', gc.front, pas)}
                {cell('Rear', 'gb', gc.back, pas)}
                {cell('Bottom', 'gd', gc.depth, pas)}
                <div className={`${READ_CELL} ${isGrooved ? '' : 'opacity-60'}`}>
                  <span className={`flex-1 min-w-0 truncate ${CELL_LABEL}`}>Groove</span>
                  <span className="whitespace-nowrap" style={{ ...FIELD_INPUT, width: 'auto', color: '#57534e' }}>
                    {isGrooved ? <>
                      {fmt1(g.thickness + gc.front + gc.back)}
                      <span className="text-[10px] font-medium text-stone-400" style={{ fontFamily: UI_FONT }}> ×In+{fmt1(gc.depth)}</span>
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
    return elements;
  };

  /* HIZLI GÖVDE: yapılandırma listenin üstünde, kaydırılan alanda (üst şerit yapışık); onay → servis, bitince mod kapanır. */
  const onQuickBodyApply = async () => {
    if (!selectedShape || quickBodyBusy) return;
    setQuickBodyBusy(true);
    try {
      await applyQuickBody(selectedShape.id, useAppStore.getState().quickBodyConfig);
      setQuickBodyMode(false);
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
              onApply={() => { void onQuickBodyApply(); }} onExit={() => setQuickBodyMode(false)} />
          )}
          <div className="px-0.5 pb-2 space-y-[2px]">{renderFaceList()}</div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center"><div className="text-center text-stone-400 text-xs py-4">No shape selected</div></div>
      )}
    </div>
  );
}
