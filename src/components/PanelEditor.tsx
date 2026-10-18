import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, Box, Check, ChevronDown, ChevronRight, Columns3, Crosshair, DoorClosed, Equal, GripVertical, LayoutPanelTop, Lock, type LucideIcon, Minus, Move, Move3d,
  MoveVertical, Pencil, Pin, Plus, RotateCcw, Footprints, RotateCw, Rows3, SendToBack, Shapes, SlidersHorizontal, SplitSquareHorizontal, SplitSquareVertical, Trash2, Unlink, Unlock, X,
} from 'lucide-react';
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  type BackEdgeRel, type BackGroup, type BackPlacement, type CavityBox, type CornerKey, type DoorAlign, type DoorGroup, type DoorType, type JoinPass, type PanelGroup, type QuickBodyBase, type QuickBodyConfig, type Shape, type VirtualFace, childPanelsOf, panelOfVf, requestRebuild, shapeById, useAppStore, useStoreFields,
} from '../store';
import { UI_FONT } from './Ui';
import { confirmBodyPanelPlacement } from './SceneObjects';
import { axisDirToVec, convertReplicadToThreeGeometry, createPanelFromVirtualFace, dominantAxisLabel, effectiveBodyGeometry, genId, getFacesAndGroups, isFlatNormal, localBboxOf, round1 } from './Geometry';
import { applyQuickBody, bodyLegsOf, effectiveJoins, legHeightOf, legSpots, panelOrderFor, setBodyLegs } from './QuickBodyService';
import { clipPolyToConvex, polyArea } from './FaceRegion';
import {
  confirmPanelMoveRef, confirmPanelRotateRef, confirmRefFaceExtrude, deleteExtrudeStep, deleteTransformStep, executeFaceExtrude, executePanelMove,
  executePanelMoveFixed, executePanelRotate, findExistingStepForFace, updateExtrudeStep, updateTransformStep,
} from './PanelOps';
import {
  type GroupLayoutSnap, boxSpan, confirmRefCavityExtrude, confirmVolumePick, deleteCavityStep, deletePanelGroupWithMembers, editGroupGap, equalizeGroupGaps, executeCavityExtrude,
  gapMode, groupFacing, groupKindLabel, groupLayoutSnapshot, groupName, memberThicknessesOf, panelStarts, previewGroupGap, previewGroupMemberThickness, renamePanelGroup, restoreGroupLayout, setGroupCount, setGroupMemberThickness, setGroupTargetGap,
  passiveGapIndex, startCavityEdit, startGroupRepick, toggleGroupGapLock, traceMaskLoops, updateCavityStep,
} from './PanelGroupService';
import {
  type DoorCut, type DoorEdgeKey, type DoorJoint, type DoorLayoutSnap, type DoorNearPanel, type DoorNodeSolved, DOOR_TYPES, JOINT_NEAR, jointOverlayState, setDoorJointOverlay, DOOR_TYPE_LABEL, DOOR_TYPE_TITLE, addPanelAtDoorJoint, applyDoorCuts, clearDoorSpacing, collectDoorCuts, doorCutBands, doorCutOutline, doorJointParts, doorJoints, doorLayoutSnapshot, doorLeafAxis, doorPlaneAxes, doorSpacingTargetsInScope, doorLeaves, doorMemberCount, doorNearPanels, restoreDoorLayout,
  confirmDoorPick, deleteDoorGroupWithMembers, doorGroupName, doorMemberRects, doorMembersOf, doorPlacementLabel, edgeGapsOf, editDoorLeafSize, editDoorSize, equalizeDoorGroup, findDoorNode, findSolvedNode,
  isDoorVf, renameDoorGroup, setDoorEdgeGap, setDoorGap, setDoorHalfOverlay, setDoorLeafGap, setDoorLeafTypes, setDoorNodeSpacing, setDoorJointRef, setDoorNodeSplit, setDoorPlacement, setDoorSplitGap, splitDoorAtPanel, setDoorThickness, setVfDoorBound,
  doorSizeMode, passiveSizeIndex, solveDoorTree, toggleDoorSizeLock,
  type EdgeOverlayMode, canSplitDoorAtPanel, setDoorEdgeOverlay,
} from './DoorService';
import {
  type BackCut, type BackEdgeKey, type BackLayoutSnap, type BackNearPanel, type BackNodeSolved, type BackSolution,
  BACK_TYPE_LABEL, BACK_TYPE_TITLE, backCutBands, backCutOutline, backFallbackSolution, backGroupName, backLayoutSnapshot, backLeafOfMember, backLeaves,
  backMemberCount, backNearPanels, backPieceOf, backSetbackOf, backSizeMode, canSplitBackAtPanel, collectBackCuts, confirmBackPick,
  deleteBackGroupWithMembers, editBackSize, findBackNode, findSolvedBackNode, isBackVf, passiveBackSizeIndex, renameBackGroup, restoreBackLayout,
  setBackEdgeCover, setBackEdgeInset, setBackJointIn, setBackNodeSplit, setBackPlacement, setBackSetback,
  setBackSplitGap, backSizeBoundByJoint, setBackThickness, setVfBackBound, solveBackGroup, splitBackAtPanel, toggleBackSizeLock, vfBackBound,
  BACK_REL_LABEL, backGrooveClearOf, backGrooveClearOverridden, backJointRelOf, edgeRelOf, resetBackGrooveClear, setBackEdgeRel, setBackGrooveClear, setBackJointRel,
} from './BackService';

/* PANEL EDİTÖRÜ — sol çubuktaki panel listesi, önizleme, Taşı/Döndür/Extrude şeritleri,
   işlem adımları ve raf/dikme/kapak grup kartları. Mantık motora (PanelOps / PanelGroupService /
   DoorService / BackService) delege edilir; burada yalnız arayüz durumu tutulur. Arkalık kartı ve şeması kapaktan
   ayrı bileşenlerdir (BackSchematic, backCard) ama aynı görünüm dilini kullanır. */

const PANEL_THICKNESS = 18;
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const AXIS_COLORS: Record<string, string> = { 'x+': '#dc2626', 'x-': '#b91c1c', 'y+': '#16a34a', 'y-': '#15803d', 'z+': '#2563eb', 'z-': '#1d4ed8', x: '#dc2626', y: '#16a34a', z: '#2563eb' };
const SECTION_LABEL: React.CSSProperties = { fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#b5ada3' };

function geoAxes(geo: THREE.BufferGeometry) {
  const bbox = localBboxOf(geo); if (!bbox) return null;
  const size = new THREE.Vector3(); bbox.getSize(size);
  const axes = [{ i: 0, v: size.x }, { i: 1, v: size.y }, { i: 2, v: size.z }].sort((a, b) => a.v - b.v);
  return { axes, size, bbox };
}

/** Paneli üretilmekte olan VF id'leri (yarış koruması, bkz. otomatik panel efekti). */
const _creatingPanelForVf = new Set<string>();

/* PANEL ÇERÇEVESİ: önizleme ve ölçüler gövde-yerel geometriden okunursa dönmüş panelde eğik bbox
   yanlış ölçü ve sahte "kesim" verir. Dönüş adımlarının birleşik dönüşü (PanelEngine.composeSteps ile
   AYNI sıra) tersine uygulanır; adımsız eğik levhada en büyük yüz normali en yakın eksene çevrilir. */
const _frameCache = new WeakMap<THREE.BufferGeometry, { key: string; geo: THREE.BufferGeometry; inv: THREE.Quaternion }>();
function stepsFrameQuat(steps: any[] | undefined): THREE.Quaternion {
  const frame = new THREE.Quaternion();
  for (const st of steps || []) {
    if (st?.type !== 'rotate') continue;
    const deg = typeof st.resolvedValue === 'number' ? st.resolvedValue : (st.value || 0);
    if (Math.abs(deg) < 1e-9) continue;
    const axis = Array.isArray(st.axisVec) ? new THREE.Vector3(st.axisVec[0], st.axisVec[1], st.axisVec[2]).normalize() : axisDirToVec(String(st.axis || 'y') + '+');
    const worldAxis = axis.applyQuaternion(frame).normalize();
    frame.premultiply(new THREE.Quaternion().setFromAxisAngle(worldAxis, (deg * Math.PI) / 180));
  }
  return frame;
}
function largestFaceNormal(geo: THREE.BufferGeometry): THREE.Vector3 | null {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined; if (!pos) return null;
  const idx = geo.getIndex(); const cnt = idx ? idx.count : pos.count; const at = (k: number) => (idx ? idx.getX(k) : k);
  const bins = new Map<string, { n: THREE.Vector3; a: number }>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t + 2 < cnt; t += 3) {
    a.fromBufferAttribute(pos, at(t)); b.fromBufferAttribute(pos, at(t + 1)); c.fromBufferAttribute(pos, at(t + 2));
    n.crossVectors(b.sub(a), c.sub(a)); const area = n.length() / 2; if (area < 1e-6) continue;
    n.divideScalar(area * 2);
    if (n.x < -1e-6 || (Math.abs(n.x) <= 1e-6 && n.y < -1e-6) || (Math.abs(n.x) <= 1e-6 && Math.abs(n.y) <= 1e-6 && n.z < 0)) n.negate();
    const key = `${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}`;
    const e = bins.get(key); if (e) e.a += area; else bins.set(key, { n: n.clone(), a: area });
  }
  let best: { n: THREE.Vector3; a: number } | null = null;
  bins.forEach(e => { if (!best || e.a > best.a) best = e; });
  return best ? (best as { n: THREE.Vector3 }).n.clone() : null;
}
/** Panelin kendi çerçevesindeki geometrisi (dönüşsüz panelde geometrinin kendisi) + uygulanan ters dönüş. */
export function panelFrameOf(shape: Shape | undefined | null): { geo: THREE.BufferGeometry; inv: THREE.Quaternion } | null {
  const geo = shape?.geometry as THREE.BufferGeometry | undefined; if (!geo) return null;
  const steps: any[] = shape?.parameters?.transformSteps || [];
  const key = steps.filter(s => s?.type === 'rotate').map(s => `${s.axis}${Array.isArray(s.axisVec) ? s.axisVec.map((v: number) => v.toFixed(3)).join('/') : ''}:${typeof s.resolvedValue === 'number' ? s.resolvedValue : s.value}`).join('|');
  const hit = _frameCache.get(geo); if (hit && hit.key === key) return { geo: hit.geo, inv: hit.inv };
  const inv = stepsFrameQuat(steps).invert();
  let out = geo;
  if (Math.abs(inv.w) < 0.9999999) { out = geo.clone(); out.applyQuaternion(inv); }
  const n = largestFaceNormal(out);
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
const panelFrameGeometry = (shape: Shape | undefined | null) => panelFrameOf(shape)?.geo ?? null;

function getDimsFromGeo(geo: THREE.BufferGeometry, arrowRotated?: boolean, panelThickness?: number) {
  const r = geoAxes(geo); if (!r) return null;
  const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
  const target = arrowRotated ? pa[1] : pa[0], secondary = pa.find(a => a !== target) ?? pa[0], s = [r.size.x, r.size.y, r.size.z];
  // Kalınlık parametreden: dönmüş panelde bbox'ın en küçük boyutu gerçek kalınlık değildir.
  const thickness = (panelThickness != null && panelThickness > 0) ? round1(panelThickness) : round1(s[r.axes[0].i]);
  return { primary: round1(s[target]), secondary: round1(s[secondary]), thickness };
}
const panelDims = (p: Shape | undefined | null) => {
  const geo = panelFrameGeometry(p);
  return geo ? getDimsFromGeo(geo, p!.parameters?.arrowRotated, parseFloat(p!.parameters?.panelThickness) || 18) : null;
};

type Pt = { x: number; y: number };
const project3D = (p: THREE.Vector3, camera: THREE.Camera, w: number, h: number): Pt => {
  const ndc = p.clone().project(camera);
  return { x: (ndc.x + 1) / 2 * w, y: (1 - ndc.y) / 2 * h };
};

interface GroundDimWorld { fa: THREE.Vector3; fb: THREE.Vector3; da: THREE.Vector3; db: THREE.Vector3; length: number; along?: number; }
/* Panelin tam enini/boyunu kaplayan "kesim" (pah kenarı, tam boy kanal) dış ölçünün kopyasıdır → atılır. */
const CUT_FULL_SPAN = 0.9;
function dropFullSpanCuts(dims: GroundDimWorld[], span0: number, span1: number, p0: number): GroundDimWorld[] {
  return dims.filter(d => d.length < CUT_FULL_SPAN * (d.along === p0 ? span0 : span1));
}
const KEYS = ['x', 'y', 'z'] as const;
function planarAxes(thinAxis: number) {
  const planar = [0, 1, 2].filter(i => i !== thinAxis);
  return { p0: planar[0], p1: planar[1], k0: KEYS[planar[0]], k1: KEYS[planar[1]], thinKey: KEYS[thinAxis] };
}
function cutBoxToDims(
  mn0: number, mx0: number, mn1: number, mx1: number, topVal: number, p0: number, p1: number, thinAxis: number,
  pMin0: number, pMax0: number, pMin1: number, pMax1: number, gap: number,
): GroundDimWorld[] {
  const mk = (v0: number, v1: number) => { const p = new THREE.Vector3(); p.setComponent(p0, v0); p.setComponent(p1, v1); p.setComponent(thinAxis, topVal); return p; };
  const w0 = mx0 - mn0, w1 = mx1 - mn1;
  const dims: GroundDimWorld[] = [];
  if (w0 > 0.5) {
    const nearMin1 = (mn1 - pMin1) <= (pMax1 - mx1);
    const hEdge = nearMin1 ? mn1 : mx1, hOff = nearMin1 ? hEdge - gap : hEdge + gap;
    dims.push({ fa: mk(mn0, hEdge), fb: mk(mx0, hEdge), da: mk(mn0, hOff), db: mk(mx0, hOff), length: Math.round(w0), along: p0 });
  }
  if (w1 > 0.5) {
    const nearMin0 = (mn0 - pMin0) <= (pMax0 - mx0);
    const wEdge = nearMin0 ? mn0 : mx0, wOff = nearMin0 ? wEdge - gap : wEdge + gap;
    dims.push({ fa: mk(wEdge, mn1), fb: mk(wEdge, mx1), da: mk(wOff, mn1), db: mk(wOff, mx1), length: Math.round(w1), along: p1 });
  }
  return dims;
}

function cutDimsFromSubGeos(subGeos: any[], panelBbox: THREE.Box3, panelSize: THREE.Vector3, thinAxis: number, nDir: THREE.Vector3, frame?: THREE.Matrix4): GroundDimWorld[] {
  const { p0, p1, k0, k1, thinKey } = planarAxes(thinAxis);
  const topVal = nDir.getComponent(thinAxis) > 0 ? panelBbox.max[thinKey] : panelBbox.min[thinKey];
  const gap = Math.min(panelSize.getComponent(p0), panelSize.getComponent(p1)) * 0.045;
  const span0 = panelSize.getComponent(p0), span1 = panelSize.getComponent(p1);
  const out: GroundDimWorld[] = [];
  const v = new THREE.Vector3();
  subGeos.forEach(sg => {
    const pos = sg?.geometry?.getAttribute('position'); if (!pos) return;
    const rot = sg.relativeRotation || [0, 0, 0];
    const rotM = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
    const off = new THREE.Vector3(...((sg.relativeOffset || [0, 0, 0]) as number[]));
    let mn0 = Infinity, mx0 = -Infinity, mn1 = Infinity, mx1 = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(rotM).add(off);
      if (frame) v.applyMatrix4(frame);
      const c0 = v.getComponent(p0), c1 = v.getComponent(p1);
      mn0 = Math.min(mn0, c0); mx0 = Math.max(mx0, c0); mn1 = Math.min(mn1, c1); mx1 = Math.max(mx1, c1);
    }
    mn0 = Math.max(mn0, panelBbox.min[k0]); mx0 = Math.min(mx0, panelBbox.max[k0]);
    mn1 = Math.max(mn1, panelBbox.min[k1]); mx1 = Math.min(mx1, panelBbox.max[k1]);
    out.push(...dropFullSpanCuts(cutBoxToDims(mn0, mx0, mn1, mx1, topVal, p0, p1, thinAxis, panelBbox.min[k0], panelBbox.max[k0], panelBbox.min[k1], panelBbox.max[k1], gap), span0, span1, p0));
  });
  return out;
}

function computeCutDimsWorld(geometry: THREE.BufferGeometry, thinAxis: number, nDir: THREE.Vector3): GroundDimWorld[] {
  const eg = new THREE.EdgesGeometry(geometry, 15);
  const pos = eg.getAttribute('position');
  if (!pos) { eg.dispose(); return []; }
  const { p0, p1, k0, k1, thinKey } = planarAxes(thinAxis);
  const bbox = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const topVal = nDir.getComponent(thinAxis) > 0 ? bbox.max[thinKey] : bbox.min[thinKey];
  const tolT = Math.max((bbox.max[thinKey] - bbox.min[thinKey]) * 0.15, 0.6);
  const span0 = bbox.max[k0] - bbox.min[k0], span1 = bbox.max[k1] - bbox.min[k1];
  const minSpan = Math.min(span0, span1);
  const tolE = Math.max(minSpan * 0.01, 0.4), minLen = Math.max(minSpan * 0.03, 4), gap = minSpan * 0.045;
  const onLine = (av: number, bv: number, val: number) => Math.abs(av - val) < tolE && Math.abs(bv - val) < tolE;

  type Seg = { a0: number; a1: number; b0: number; b1: number };
  const segs: Seg[] = [];
  const comp = [0, 0, 0];
  for (let i = 0; i < pos.count; i += 2) {
    comp[0] = pos.getX(i); comp[1] = pos.getY(i); comp[2] = pos.getZ(i);
    const aThin = comp[thinAxis], a0 = comp[p0], a1 = comp[p1];
    comp[0] = pos.getX(i + 1); comp[1] = pos.getY(i + 1); comp[2] = pos.getZ(i + 1);
    const bThin = comp[thinAxis], b0 = comp[p0], b1 = comp[p1];
    if (Math.abs(aThin - topVal) > tolT || Math.abs(bThin - topVal) > tolT) continue;
    if (onLine(a0, b0, bbox.min[k0]) || onLine(a0, b0, bbox.max[k0]) || onLine(a1, b1, bbox.min[k1]) || onLine(a1, b1, bbox.max[k1])) continue;
    if (Math.hypot(b0 - a0, b1 - a1) < minLen) continue;
    segs.push({ a0, a1, b0, b1 });
  }
  eg.dispose();
  if (!segs.length) return [];

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
    const dd = dropFullSpanCuts(cutBoxToDims(mn0, mx0, mn1, mx1, topVal, p0, p1, thinAxis, bbox.min[k0], bbox.max[k0], bbox.min[k1], bbox.max[k1], gap), span0, span1, p0);
    out.push(...dd); count += dd.length;
  });
  return out;
}

function computeGroundDimWorld(geometry: THREE.BufferGeometry, wIdx: number, hIdx: number, thinAxis: number, up: THREE.Vector3): GroundDimWorld[] {
  const bbox = localBboxOf(geometry); if (!bbox) return [];
  const size = new THREE.Vector3(); bbox.getSize(size);
  const cen = new THREE.Vector3(); bbox.getCenter(cen);
  const wKey = KEYS[wIdx], hKey = KEYS[hIdx], thinKey = KEYS[thinAxis];
  const cMax = cen.clone().setComponent(thinAxis, bbox.max[thinKey]);
  const cMin = cen.clone().setComponent(thinAxis, bbox.min[thinKey]);
  const groundVal = cMin.dot(up) <= cMax.dot(up) ? bbox.min[thinKey] : bbox.max[thinKey];
  const wExt = size.getComponent(wIdx), hExt = size.getComponent(hIdx);
  const gOff = Math.max(wExt, hExt) * 0.12;
  const mk = (wv: number, hv: number) => new THREE.Vector3().setComponent(wIdx, wv).setComponent(hIdx, hv).setComponent(thinAxis, groundVal);
  const he = bbox.max[hKey], we = bbox.max[wKey];
  return [
    { fa: mk(bbox.min[wKey], he), fb: mk(bbox.max[wKey], he), da: mk(bbox.min[wKey], he + gOff), db: mk(bbox.max[wKey], he + gOff), length: Math.round(wExt) },
    { fa: mk(we, bbox.min[hKey]), fb: mk(we, bbox.max[hKey]), da: mk(we + gOff, bbox.min[hKey]), db: mk(we + gOff, bbox.max[hKey]), length: Math.round(hExt) },
  ];
}

interface GroundRender { fa: Pt; fb: Pt; da: Pt; db: Pt; cx: number; cy: number; value: number; }

/* Önizleme yazı ölçeği (Goker: "bir tık büyük, okunaklı") — kapak / arkalık / raf-dikme şemaları ve panel önizlemesi aynı ölçek. */
const schemFs = (w: number) => Math.max(10.5, Math.min(14, w * 0.0285));
const schemFsT = (fs: number) => Math.max(9.5, fs * 0.88);
/** Bant rozetleri (Full / Half / Split here / Groove / In …). */
const chipFs = (fsT: number) => fsT * 0.86;
/* ŞEMA ROZET DİLİ (Goker: kapak rozetleri arkalık gibi): beyaz = seçenek; koyu taş = AÇIK/seçili durum; turuncu çerçeve = bu tık
   seçili parçayı / bölmeyi değiştirir; kırmızı = kaldır. */
const CHIP = {
  base: { fill: '#ffffff', stroke: '#cfc6b9', text: '#57534e' },
  on: { fill: '#44403c', stroke: '#292524', text: '#ffffff' },
  accent: { fill: '#fff7ed', stroke: '#f97316', text: '#c2410c' },
  danger: { fill: '#fef2f2', stroke: '#ef4444', text: '#b91c1c' },
} as const;
const CHIP_SHADOW = 'drop-shadow(0 1px 1px rgba(40,30,20,0.12))';
const pillSize = (txt: string, fs: number) => ({ pw: Math.max(txt.length * fs * 0.6 + 10, 26), ph: fs + 6 });
const DIM_LINE = '#b8b0a4';
const DIM_EXT = '#ddd6ca';
function DimArrows({ a, b, asz, color }: { a: Pt; b: Pt; asz: number; color: string }) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, px = -uy, py = ux;
  const k = 0.42;
  const head = (x: number, y: number, sx: number, sy: number) =>
    `M${(x + sx * asz + px * asz * k).toFixed(1)},${(y + sy * asz + py * asz * k).toFixed(1)} L${x.toFixed(1)},${y.toFixed(1)} L${(x + sx * asz - px * asz * k).toFixed(1)},${(y + sy * asz - py * asz * k).toFixed(1)}`;
  return (
    <>
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={0.8} />
      <path d={`${head(a.x, a.y, ux, uy)} ${head(b.x, b.y, -ux, -uy)}`} fill="none" stroke={color} strokeWidth={0.9} strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}
function DimPill({ cx, cy, txt, fs, fill = '#ffffff', stroke = SOFT.pillStroke, strokeWidth = 0.7, color = '#57534e', hideText, onClick, title }: {
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
const LOCK_R = 9;
/* Kilit rozeti pill'in ucuna 2px biner → hangi ölçüye ait olduğu belli olur. */
const LOCK_OFF = LOCK_R - 2;
const LOCK_EXT = LOCK_OFF + LOCK_R + 2;
/** `holdIcon`: kapak ölçüsünün 'tut' modu — girilmiş değer raptiye ikonuyla gösterilir. */
function LockBadge({ cx, cy, locked, edited, onClick, title, holdIcon }: { cx: number; cy: number; locked: boolean; edited?: boolean; onClick: () => void; title?: string; holdIcon?: boolean }) {
  const fill = locked ? '#ea580c' : edited ? '#fff7ed' : '#ffffff';
  const stroke = locked ? '#c2410c' : edited ? '#f59e0b' : '#d6cfc3';
  const ico = locked ? '#ffffff' : edited ? '#9a3412' : '#8c8378';
  const sz = 10;
  return (
    <g className="lockbtn" style={{ cursor: 'pointer' }} onClick={e => { e.stopPropagation(); onClick(); }}>
      <circle cx={cx} cy={cy} r={LOCK_R} fill={fill} stroke={stroke} strokeWidth={locked ? 1 : 0.9} style={{ filter: SOFT.pillShadow }} />
      {locked ? <Lock x={cx - sz / 2} y={cy - sz / 2} size={sz} strokeWidth={2.4} color={ico} />
        : edited && holdIcon ? <Pin x={cx - sz / 2} y={cy - sz / 2} size={sz} strokeWidth={2.3} color={ico} />
        : <Unlock x={cx - sz / 2} y={cy - sz / 2} size={sz} strokeWidth={2.1} color={ico} />}
      <title>{title ?? (locked ? 'Locked — stays fixed on resize. Click to unlock (follows resize)' : edited ? 'Entered value — click to lock it (stays fixed on resize)' : 'Click to lock (stays fixed on resize)')}</title>
    </g>
  );
}

/* Sıralama tutamacı imleci: tarayıcının beyaz grab eli kemik zeminde kayboluyor → koyu dolgulu özel imleç. */
const GRIP_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
  "<path d='M12 1.8 L15.8 5.6 H13.3 V10.7 H18.4 V8.2 L22.2 12 L18.4 15.8 V13.3 H13.3 V18.4 H15.8 L12 22.2 L8.2 18.4 H10.7 V13.3 H5.6 V15.8 L1.8 12 L5.6 8.2 V10.7 H10.7 V5.6 H8.2 Z' " +
  "fill='#292524' stroke='#ffffff' stroke-width='1.4' stroke-linejoin='round'/></svg>"
)}") 12 12, move`;
const PREVIEW_BG = 'radial-gradient(130% 95% at 50% 0%, #fefdfb 0%, #f8f5f0 62%, #f3efe8 100%)';
const PREVIEW_FRAME = 'relative rounded-[12px] ring-1 ring-[#ebe5dc] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_1px_2px_rgba(60,40,20,0.04)]';
const SCHEMATIC_CSS = `.yago-gap .lockbtn{transition:transform .12s;transform-box:fill-box;transform-origin:center}.yago-gap .lockbtn:hover{transform:scale(1.12)}.yago-band .chip{opacity:0;transition:opacity .15s}.yago-band.on .chip,.yago-band:hover .chip{opacity:1}.yago-band .hit{transition:fill .12s}.yago-band:hover .hit{fill:rgba(234,88,12,0.10)}.yago-band.pnl:hover .hit{fill:transparent}.yago-band .hov{opacity:0;transition:opacity .12s;pointer-events:none}.yago-band:hover .hov{opacity:1}@keyframes yagoHintPulse{0%,100%{opacity:1}50%{opacity:.45}}.yago-hint-pulse{animation:yagoHintPulse 1.1s ease-in-out infinite}`;
const SOFT = {
  area: '#fdfcfa', areaStroke: '#e4ded4',
  part0: '#f5f0e8', part1: '#eae3d7', partStroke: '#b8afa2',
  sel0: '#f8f0e6', sel1: '#f0e3d1', selStroke: '#dcae84',
  on0: '#fdeee1', on1: '#f9dcc4', onStroke: '#ea580c',
  label: '#a39b90', shadow: 'drop-shadow(0 1px 1.5px rgba(70,50,30,0.09))',
  pillStroke: '#ece6dc', pillShadow: 'drop-shadow(0 1px 1px rgba(60,40,20,0.06))',
};
/** Parça gradyanları — her SVG kendi id'siyle bir kez tanımlar (aynı sayfada id çakışmasın). */
function SoftDefs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-part`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SOFT.part0} /><stop offset="1" stopColor={SOFT.part1} /></linearGradient>
      <linearGradient id={`${id}-on`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SOFT.on0} /><stop offset="1" stopColor={SOFT.on1} /></linearGradient>
    </defs>
  );
}
const PREVIEW_PANEL_COLOR = 0xeee7dc;
const PREVIEW_EDGE_COLOR = 0xa1988b;
const PREVIEW_LIGHT = { hemi: 1.0, ambient: 0.3, key: 1.9, fill: 0.55 };
const PREVIEW_HEIGHT = 500;
const DOCK_SHELL: React.CSSProperties = {
  position: 'relative', marginTop: 5, borderRadius: 12, background: 'linear-gradient(180deg,#fefdfb 0%,#faf8f4 100%)', border: '1px solid #ebe5dc',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 2px rgba(60,40,20,0.04)', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: UI_FONT,
};
const DOCK_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 5px 5px' };
const DOCK_INPUT: React.CSSProperties = {
  flex: 1, minWidth: 0, height: 24, textAlign: 'center',
  fontFamily: UI_FONT, fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
  color: '#1c1917', background: '#ffffff', border: '1px solid #e6e0d6', borderRadius: 7, outline: 'none', boxShadow: '0 1px 0 rgba(40,30,20,0.02)',
};
const dockAxisTag = (color: string): React.CSSProperties => ({
  flexShrink: 0, fontSize: 10, fontWeight: 700, fontFamily: UI_FONT, color, height: 20, lineHeight: '20px', padding: '0 6px', borderRadius: 5, background: '#f5f2ec',
});
function DockStatus({ ready = false, dot, text, title, trailing }: { ready?: boolean; dot?: string; text: string; title?: string; trailing?: React.ReactNode }) {
  return (
    <div title={title} style={{
      flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, height: 24, padding: '0 8px', borderRadius: 6,
      background: ready ? 'rgba(22,163,74,0.07)' : '#f5f2ec', border: ready ? '1px solid rgba(22,163,74,0.22)' : '1px solid transparent',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: dot ?? (ready ? '#16a34a' : '#a8a29e'), flexShrink: 0 }} />
      <span style={{ fontSize: 11, fontWeight: 500, color: ready ? '#15803d' : '#78716c', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
      {trailing}
    </div>
  );
}
function ApplyBtn({ enabled, onClick, title = 'Apply' }: { enabled: boolean; onClick: () => void; title?: string }) {
  return (
    <button onClick={e => { stop(e); onClick(); }} title={title} style={{
      flexShrink: 0, width: 28, height: 24, borderRadius: 6, border: 'none', outline: 'none', cursor: enabled ? 'pointer' : 'not-allowed',
      display: 'flex', alignItems: 'center', justifyContent: 'center', background: enabled ? '#44403c' : '#ebe6de', color: enabled ? '#ffffff' : '#b5ada3',
      boxShadow: enabled ? '0 1px 2px rgba(40,30,20,0.22)' : 'none', transition: 'background 0.12s',
    }}><Check size={13} strokeWidth={2.4} /></button>
  );
}
function ExitBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={e => { stop(e); onClick(); }} title="Exit" className="hover:!bg-[#f3efe8] hover:!text-stone-600" style={{
      flexShrink: 0, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none',
      cursor: 'pointer', outline: 'none', background: 'transparent', color: '#a8a29e', transition: 'color 0.12s,background 0.12s',
    }}><X size={13} strokeWidth={2} /></button>
  );
}
const iconBtn = (color: string): React.CSSProperties => ({
  width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, border: 'none',
  background: 'transparent', cursor: 'pointer', color, outline: 'none', padding: 0, transition: 'background 0.12s',
});
/** Sayısal giriş: yerel metin taslağı (başta -/+ yazılabilsin); geçerli sayı yazıldıkça store güncellenir. */
function NumInput({ draft, setDraft, setValue, fallback, onEnter, onEscape, autoFocus, style }: {
  draft: string; setDraft: (s: string) => void; setValue: (v: number) => void; fallback: number;
  onEnter?: () => void; onEscape?: () => void; autoFocus?: boolean; style?: React.CSSProperties;
}) {
  return (
    <input type="text" inputMode="numeric" autoFocus={autoFocus} value={draft}
      onChange={e => { const v = e.target.value; setDraft(v); const p = parseFloat(v); if (!isNaN(p)) setValue(p); }}
      onBlur={() => { const p = parseFloat(draft); if (isNaN(p)) { setDraft(String(fallback)); setValue(fallback); } else { setValue(p); setDraft(String(p)); } }}
      onKeyDown={e => { if (e.key === 'Enter') onEnter?.(); if (e.key === 'Escape') onEscape?.(); }}
      style={{ ...DOCK_INPUT, ...style }} />
  );
}

type SegItem = { key: string; label: string; Icon?: LucideIcon; title?: string; disabled?: boolean };
function Segmented({ items, active, onPick, height = 24 }: { items: SegItem[]; active: string | null; onPick: (k: string) => void; height?: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${items.length}, minmax(0,1fr))`, gap: 2, padding: 2, borderRadius: 8, background: '#f3efe8', border: '1px solid #e9e4dc', fontFamily: UI_FONT }}>
      {items.map(({ key, label, Icon, title, disabled }) => {
        const on = active === key;
        return (
          <button key={key} type="button" title={title || label} disabled={disabled} onClick={e => { stop(e); if (!disabled) onPick(key); }}
            className={on || disabled ? '' : 'hover:!bg-white hover:!text-stone-800'}
            style={{
              height, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '0 6px', borderRadius: 6, border: 'none', outline: 'none',
              cursor: disabled ? 'not-allowed' : 'pointer', background: on ? '#44403c' : 'transparent', color: disabled ? '#c9c2b7' : on ? '#ffffff' : '#57534e',
              boxShadow: on ? '0 1px 2px rgba(40,30,20,0.25)' : 'none', fontSize: 11, fontWeight: 600, letterSpacing: '0.01em', transition: 'background 0.12s,color 0.12s',
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
const dockModes = (keys: string[], overrides: Record<string, Partial<DockMode>> = {}): DockMode[] =>
  keys.map(k => ({ key: k, ...DOCK_MODE_DEFS[k], ...(overrides[k] || {}) } as DockMode));
function DockModeBar({ modes, active, onPick, trailing }: { modes: DockMode[]; active: string | null; onPick: (k: string) => void; trailing?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 5px 0' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Segmented active={active} onPick={onPick} items={modes.map(m => ({ key: m.key, label: m.label, Icon: m.Icon, title: m.title || `${m.label} — ${m.sub}` }))} />
      </div>
      {trailing}
    </div>
  );
}

/* Satırdaki açık anahtarlar (şekil · kapak sınırı · arkalık sınırı) TEK yumuşak renk (Goker): dolgu yok, yalnız ince dış hat. */
const ROW_TOGGLE_ON = 'text-[#c0814f] ring-1 ring-inset ring-[#ecd6c2] hover:ring-[#e0bf9f]';
/* "Yüzeyin şeklini al": AÇIK → panel serbest bölgenin tam şeklini alır (L/U/çentik); KAPALI → kardeş kenarında düz kesilir. */
function FitShapeToggle({ checked, disabled, onToggle }: { checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} onClick={e => { stop(e); if (!disabled) onToggle(); }}
      title={checked ? 'Fit to face shape: ON — the panel takes the full shape of its free region (L / U / notch). Click to cut straight at siblings.' : 'Fit to face shape: OFF — the panel is cut straight at the sibling edge. Click to follow the free region\'s full shape.'}
      className={`${ROW_BTN} ${disabled ? 'text-stone-200 cursor-not-allowed' : checked ? ROW_TOGGLE_ON : 'text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700'}`}>
      <Shapes size={ROW_ICON} strokeWidth={1.9} />
    </button>
  );
}

function DoorRefToggle({ checked, disabled, onToggle }: { checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} onClick={e => { stop(e); if (!disabled) onToggle(); }}
      title={checked ? 'Door reference: ON — doors are built from this panel\'s edges' : 'Mark as door reference'}
      className={`${ROW_BTN} ${disabled ? 'text-stone-200 cursor-not-allowed' : checked ? ROW_TOGGLE_ON : 'text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700'}`}>
      <DoorClosed size={ROW_ICON} strokeWidth={1.9} />
    </button>
  );
}
/* Arkalık sınırı: arkalık adayları bu panelin kenarlarından kurulur, arkalık bu panelde (Panel ref) bölünür. */
function BackRefToggle({ checked, disabled, onToggle }: { checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} onClick={e => { stop(e); if (!disabled) onToggle(); }}
      title={checked ? 'Back panel reference: ON — the back panel is built from this panel\'s edges and can be split at it' : 'Mark as back panel reference'}
      className={`${ROW_BTN} ${disabled ? 'text-stone-200 cursor-not-allowed' : checked ? ROW_TOGGLE_ON : 'text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700'}`}>
      <SendToBack size={ROW_ICON} strokeWidth={1.9} />
    </button>
  );
}
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
const subXform = (sg: any) => {
  const rot = sg.relativeRotation || [0, 0, 0];
  return { rotM: new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ')), off: new THREE.Vector3(...((sg.relativeOffset || [0, 0, 0]) as number[])) };
};

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
    const sz = new THREE.Vector3(), center = new THREE.Vector3();
    bbox.getSize(sz); bbox.getCenter(center);
    const dims3 = [sz.x, sz.y, sz.z];
    const minIdx = dims3.indexOf(Math.min(...dims3));

    // En/yükseklik düzlem EKSENLERİNE bağlı (getDimsFromGeo ile aynı) → extrude sonrası önizleme kendiliğinden dönmez.
    const planar = [0, 1, 2].filter(i => i !== minIdx).sort((a, b) => a - b);
    let wIdx = planar[0], hIdx = planar[1];
    if (arrowRotated) { const t = wIdx; wIdx = hIdx; hIdx = t; }
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
    const key = new THREE.DirectionalLight(0xffffff, PREVIEW_LIGHT.key);
    key.position.copy(nDir).multiplyScalar(3).addScaledVector(hDir, 2).addScaledVector(wDir, 1.4);
    const fill = new THREE.DirectionalLight(0xf4f1ec, PREVIEW_LIGHT.fill);
    fill.position.copy(nDir).addScaledVector(hDir, -1.6).addScaledVector(wDir, -2.2);
    const rim = new THREE.DirectionalLight(0xffffff, 0.15);
    rim.position.copy(nDir).multiplyScalar(-1).addScaledVector(hDir, 1).addScaledVector(wDir, 0.6);
    scene.add(key, fill, rim);

    const aspect = w / h;
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

    const allW: THREE.Vector3[] = [];
    for (const X of [bbox.min.x, bbox.max.x]) for (const Y of [bbox.min.y, bbox.max.y]) for (const Z of [bbox.min.z, bbox.max.z]) allW.push(new THREE.Vector3(X, Y, Z));
    allDimsW.forEach(d => allW.push(d.fa, d.fb, d.da, d.db));
    let maxU = 0, maxV = 0;
    allW.forEach(p => { const d = p.clone().sub(center); maxU = Math.max(maxU, Math.abs(d.dot(right))); maxV = Math.max(maxV, Math.abs(d.dot(upW))); });
    const halfV = maxV * 1.06;
    const ratioTop = halfV, ratioBot = halfV + halfV * 0.06;
    let vSpan = ratioTop + ratioBot, halfH = (vSpan / 2) * aspect;
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

    const fsG = Math.max(10.5, Math.min(13.5, w * 0.027));
    const items = allDimsW.map(d => {
      const fa = project3D(d.fa, camera, w, h), fb = project3D(d.fb, camera, w, h), da = project3D(d.da, camera, w, h), db = project3D(d.db, camera, w, h);
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
      return { fa: it.fa, fb: it.fb, da: { x: it.da.x + it.out.x * push, y: it.da.y + it.out.y * push }, db: { x: it.db.x + it.out.x * push, y: it.db.y + it.out.y * push }, cx, cy, value: it.length };
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
  const fsG = Math.max(10.5, Math.min(13.5, canvasSize.w * 0.027));
  const asz = Math.max(4, Math.min(6.5, canvasSize.w * 0.014));

  return (
    <div ref={wrapRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}
      style={{ position: 'absolute', inset: 0, userSelect: 'none', cursor: 'ew-resize', touchAction: 'none' }}>
      <canvas ref={canvasRef} style={{ display: 'block', position: 'absolute', inset: 0, width: '100%', height: '100%', filter: 'drop-shadow(0 8px 14px rgba(60,40,20,0.06))' }} />
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }} viewBox={`0 0 ${canvasSize.w} ${canvasSize.h}`}>
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
export function GroupSchematic({ group, selectedIndex, memberLabels, doorRefs, backRefs, onEditGap, onToggleLock, onEditThickness, onSelectMember, onToggleDoorRef, onToggleBackRef, onEditBegin, onEditCancel }: {
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  const [editing, setEditing] = useState<SchemaEdit | null>(null);
  // Canlı önizleme: her tuşta önizleme yazılır; Esc kaydı geri yükler ve blur onayını iptal eder (cancelledRef).
  const snapRef = useRef<unknown>(undefined);
  const cancelledRef = useRef(false);
  const beginEdit = (e: SchemaEdit) => { snapRef.current = onEditBegin?.(); cancelledRef.current = false; setEditing(e); };
  const previewEdit = (e: SchemaEdit, raw: string) => {
    const v = parseFloat(raw.replace(',', '.'));
    if (isNaN(v)) return;
    if (e.kind === 'gap') { if (v >= 0) onEditGap(e.k, v, true); } else if (v > 0) onEditThickness(e.i, v, true);
  };
  const cancelEdit = () => { cancelledRef.current = true; onEditCancel?.(snapRef.current); setEditing(null); };
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(es => { const w = es[0].contentRect.width; if (w > 0) setWidth(Math.round(w)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setEditing(null); }, [group.id, group.count, selectedIndex >= 0]);

  const { cavity, gaps, axis } = group;
  const passiveIdx = passiveGapIndex(gaps, gaps.length);   // tek açık boşluk → pasif (kalanı toplar)
  const gsid = `gs-${group.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const ts = memberThicknessesOf(group);
  const barsHorizontal = axis === 1;
  const memberMode = false;
  const height = PREVIEW_HEIGHT;
  // Sayım yönü: facing>0 → hacmin MİN tarafından, facing<0 → MAX tarafından.
  const facing = groupFacing(group);
  const stackOrigin = facing > 0 ? cavity.min[axis] : cavity.max[axis];
  const starts = panelStarts(cavity, axis, facing, gaps, ts);

  // Bölge silueti: iki aday görünüşten ŞEKLİ gösteren seçilir (ikisi de dikdörtgense ön görünüş); levha/pill maskeye kırpılır.
  const region = group.region && group.region.length ? group.region : [cavity];
  const view = useMemo(() => {
    const views: Array<[number, number]> = barsHorizontal ? [[0, 1], [2, 1]] : [[axis, 1], [axis, axis === 0 ? 2 : 0]];
    const cands = views.map(([h, v]) => { const m = regionMask(region, h, v); const loops = traceMaskLoops(m.hs, m.vs, m.filled); return { h, v, m, loops, shaped: loops.length > 1 || loops.some(l => l.length > 4) }; });
    return cands[0].shaped || !cands[1].shaped ? cands[0] : cands[1];
  }, [region, barsHorizontal]);
  const { h: hAxis, v: vAxis, m: mask, loops } = view;
  // Temsili kare çizim: dizilim ekseninde dünya → px parça-doğrusal, böylece L/U siluet de aynı haritayla çizilir.
  const innerW = width - 2 * SCHEMA_PAD, innerH = height - 2 * SCHEMA_PAD;
  const S = Math.max(40, Math.min(innerW, innerH));
  const ox = SCHEMA_PAD + (innerW - S) / 2, oy = SCHEMA_PAD + (innerH - S) / 2;
  const crossAxisW = barsHorizontal ? hAxis : vAxis;
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
  const crossSpan = Math.max(boxSpan(cavity, crossAxisW), 1);
  const mapCross = (w: number) => ((w - cavity.min[crossAxisW]) / crossSpan) * S;
  const sx = (wh: number) => ox + (hAxis === axis ? mapStack(wh) : mapCross(wh));
  const sy = (wv: number) => oy + S - (vAxis === axis ? mapStack(wv) : mapCross(wv));
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

  const fs = schemFs(width);
  const crossAxis = barsHorizontal ? hAxis : vAxis;
  let cursor = stackOrigin;
  const pills = gaps.map((g, k) => {
    const a = cursor, b = cursor + facing * g.value; cursor = b + facing * (ts[k] ?? 0);
    const mid = (a + b) / 2;
    const txt = String(round1(g.value));
    const { pw, ph } = pillSize(txt, fs);
    // L bölgede pill boş kısma düşmesin: en geniş DOLU aralığın ortası.
    const runs = runsAt(mid - 0.5, mid + 0.5);
    const widest = runs.length ? runs.reduce((bst, r) => (r[1] - r[0] > bst[1] - bst[0] ? r : bst)) : null;
    const crossMid = widest ? (widest[0] + widest[1]) / 2 : (cavity.min[crossAxis] + cavity.max[crossAxis]) / 2;
    let cx = barsHorizontal ? sx(crossMid) : sx(mid);
    let cy = barsHorizontal ? sy(mid) : sy(crossMid);
    const gapPx = Math.abs(mapStack(b) - mapStack(a));
    if (!barsHorizontal && gapPx < pw + 6) cy += (k % 2 === 0 ? -1 : 1) * (ph * 0.75);
    if (barsHorizontal && gapPx < ph + 6) cx += (k % 2 === 0 ? -1 : 1) * (pw * 0.6);
    return { k, cx, cy, pw, ph, txt, a, b, crossMid };
  });
  const asz = Math.max(4, Math.min(6.5, width * 0.014));
  const fsT = schemFsT(fs);
  const tPills = starts.map((st, i) => {
    const txt = String(round1(ts[i]));
    const { pw, ph } = pillSize(txt, fsT);
    const mid = st + ts[i] / 2;
    const cx = barsHorizontal ? Math.min(ox + S + 6 + pw / 2, width - pw / 2 - 2) : sx(mid);
    const cy = barsHorizontal ? sy(mid) : Math.max(oy - 6 - ph / 2, ph / 2 + 2);
    return { i, cx, cy, pw, ph, txt };
  });
  const nLabels = starts.map((st, i) => {
    const txt = memberLabels[i] ?? String(i + 1);
    const { pw, ph } = pillSize(txt, fsT);
    const mid = st + ts[i] / 2;
    const cx = barsHorizontal ? Math.max(ox - 6 - pw / 2, pw / 2 + 2) : sx(mid);
    const cy = barsHorizontal ? sy(mid) : Math.min(oy + S + 6 + ph / 2, height - ph / 2 - 2);
    return { i, cx, cy, txt };
  });

  const commit = () => {
    if (!editing) return;
    if (cancelledRef.current) { cancelledRef.current = false; return; }   // Esc sonrası blur: onay yok
    const v = parseFloat(editing.v.replace(',', '.'));
    setEditing(null);
    if (isNaN(v)) { onEditCancel?.(snapRef.current); return; }
    if (editing.kind === 'gap') { if (v >= 0) onEditGap(editing.k, v); else onEditCancel?.(snapRef.current); }
    else if (v > 0) onEditThickness(editing.i, v); else onEditCancel?.(snapRef.current);
  };
  const HIT = 5;
  const bar = (key: string, i: number, x0: number, y0: number, x1: number, y1: number) => {
    const on = i === selectedIndex;
    const tip = `Panel ${memberLabels[i] ?? i + 1} · ${round1(ts[i])} mm — click to select`;
    return (
      <g key={key} style={{ cursor: 'pointer' }} onClick={e => { stop(e); onSelectMember(i); }}>
        <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx={1.5} fill={on ? `url(#${gsid}-on)` : `url(#${gsid}-part)`} stroke={on ? SOFT.onStroke : SOFT.partStroke} strokeWidth={on ? 1.1 : 0.8} style={{ filter: SOFT.shadow }} />
        <rect x={x0 - HIT} y={y0 - HIT} width={x1 - x0 + 2 * HIT} height={y1 - y0 + 2 * HIT} fill="transparent"><title>{tip}</title></rect>
      </g>
    );
  };
  /* Levha rozetleri (kapak sınırı · arkalık sınırı) — YAZILI rozet (Goker): arkalık/kapak şemasındaki bant rozetleriyle aynı dil
     (beyaz = kapalı, koyu taş = açık). Levhanın UZUNLUĞU boyunca, levha yönünde dizilir → üye sayısı artsa da çakışmaz. */
  const cfsB = chipFs(fsT);
  const badge = (key: string, cx: number, cy: number, rot: number, on: boolean, label: string, tip: string, onClick: () => void) => {
    const { pw, ph } = pillSize(label, cfsB), tone = on ? CHIP.on : CHIP.base;
    return (
      <g key={key} style={{ cursor: 'pointer' }} onClick={e => { stop(e); onClick(); }}>
        <g transform={rot ? `rotate(${rot} ${cx} ${cy})` : undefined}>
          <rect x={cx - pw / 2} y={cy - ph / 2} width={pw} height={ph} rx={ph / 2} fill={tone.fill} stroke={tone.stroke} strokeWidth={0.9} style={{ filter: CHIP_SHADOW }} />
          <text x={cx} y={cy + cfsB * 0.36} textAnchor="middle" fontSize={cfsB} fontWeight={700} letterSpacing="0.02em" fill={tone.text} fontFamily={UI_FONT}>{label}</text>
        </g>
        <title>{tip}</title>
      </g>
    );
  };
  const BADGE_LABELS = ['Door ref', 'Back ref'] as const;
  const barBadges = (i: number, x0: number, y0: number, x1: number, y1: number) => {
    const lbl = memberLabels[i] ?? String(i + 1);
    // Rozet uzunluğu (levha yönünde) = pill genişliği; ilki levhanın ucundan 6 px içeride, aralarında 5 px.
    const ws = BADGE_LABELS.map(t => pillSize(t, cfsB).pw);
    const along = (k: number) => 6 + ws.slice(0, k).reduce((a, w) => a + w + 5, 0) + ws[k] / 2;
    const at = (k: number): [number, number] => barsHorizontal ? [x1 - along(k), (y0 + y1) / 2] : [(x0 + x1) / 2, y0 + along(k)];
    const rot = barsHorizontal ? 0 : -90;
    const [dx, dy] = at(0), [bx, by] = at(1);
    return (
      <g key={`badges-${i}`}>
        {badge(`door-${i}`, dx, dy, rot, !!doorRefs[i], BADGE_LABELS[0],
          doorRefs[i] ? `Panel ${lbl}: door reference ON — doors are built from this panel's edges. Click to remove` : `Panel ${lbl}: mark as door reference (doors are built from this panel's edges)`, () => onToggleDoorRef(i))}
        {badge(`back-${i}`, bx, by, rot, !!backRefs[i], BADGE_LABELS[1],
          backRefs[i] ? `Panel ${lbl}: back panel reference ON — click to remove` : `Panel ${lbl}: mark as back panel reference (the back panel ends at / splits at this panel)`, () => onToggleBackRef(i))}
      </g>
    );
  };

  return (
    <div ref={wrapRef} className={PREVIEW_FRAME} style={{ background: PREVIEW_BG, height }}>
      <style>{SCHEMATIC_CSS}</style>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', fontFamily: UI_FONT }}>
        <SoftDefs id={gsid} />
        <path d={silhouettePath} fill={SOFT.area} stroke={SOFT.areaStroke} strokeWidth={1} strokeLinejoin="round" fillRule="evenodd" />
        {(() => {
          const len = 18, m = 9;
          const horiz = hAxis === axis;
          const x0 = horiz ? (facing > 0 ? ox + m : ox + S - m) : ox + m;
          const y0 = horiz ? oy + m : (facing > 0 ? oy + S - m : oy + m);
          const x1 = horiz ? x0 + facing * len : x0;
          const y1 = horiz ? y0 : y0 - facing * len;
          const ang = Math.atan2(y1 - y0, x1 - x0), arm = 6.5;
          const ax = (k: number) => x1 - arm * Math.cos(ang + k * Math.PI / 4), ay = (k: number) => y1 - arm * Math.sin(ang + k * Math.PI / 4);
          const d = `M${x0.toFixed(1)},${y0.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)} M${ax(1).toFixed(1)},${ay(1).toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)} L${ax(-1).toFixed(1)},${ay(-1).toFixed(1)}`;
          return (
            <g style={{ pointerEvents: 'none' }} opacity={0.95}>
              <path d={d} fill="none" stroke="#dc2626" strokeWidth={2.4} strokeLinecap="butt" strokeLinejoin="miter" />
              <title>Gaps and members are counted from this side</title>
            </g>
          );
        })()}
        {starts.map((st, i) => runsAt(st, st + ts[i]).map((r, ri) => barsHorizontal
          ? bar(`bar-${i}-${ri}`, i, sx(r[0]), sy(st + ts[i]), sx(r[1]), sy(st))
          : bar(`bar-${i}-${ri}`, i, sx(st), sy(r[1]), sx(st + ts[i]), sy(r[0]))))}
        {!memberMode && starts.map((st, i) => {
          const runs = runsAt(st, st + ts[i]);
          if (!runs.length) return null;
          const r = runs.reduce((b, x) => (x[1] - x[0] > b[1] - b[0] ? x : b));
          return barsHorizontal
            ? barBadges(i, sx(r[0]), sy(st + ts[i]), sx(r[1]), sy(st))
            : barBadges(i, sx(st), sy(r[1]), sx(st + ts[i]), sy(r[0]));
        })}
        {!memberMode && tPills.map(p => {
          const on = p.i === selectedIndex;
          return (
            <DimPill key={`t-${p.i}`} cx={p.cx} cy={p.cy} txt={p.txt} fs={fsT} fill={on ? '#fff7ed' : '#f5f2ec'} stroke={on ? '#f97316' : SOFT.pillStroke} strokeWidth={on ? 1 : 0.7}
              color={on ? '#c2410c' : '#57534e'} hideText={editing?.kind === 't' && editing.i === p.i} title={`Panel ${memberLabels[p.i] ?? p.i + 1} thickness — click to edit`}
              onClick={e => { stop(e); beginEdit({ kind: 't', i: p.i, v: p.txt }); }} />
          );
        })}
        {nLabels.map(n => {
          const on = n.i === selectedIndex;
          return (
            <text key={`n-${n.i}`} x={n.cx} y={n.cy + fsT * 0.36} textAnchor="middle" fontSize={fsT} fontWeight={on ? 700 : 600} fill={on ? '#ea580c' : SOFT.label}
              fontFamily={UI_FONT} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', userSelect: 'none' }}>{n.txt}</text>
          );
        })}
        {!memberMode && pills.map(p => {
          const mode = gapMode(gaps[p.k]);
          const passive = passiveIdx === p.k;
          const locked = mode === 'locked', edited = mode === 'hold';
          const a = barsHorizontal ? { x: sx(p.crossMid), y: sy(p.a) } : { x: sx(p.a), y: sy(p.crossMid) };
          const b = barsHorizontal ? { x: sx(p.crossMid), y: sy(p.b) } : { x: sx(p.b), y: sy(p.crossMid) };
          const lockCx = p.cx + p.pw / 2 + LOCK_OFF, lockCy = p.cy;
          if (passive) return (
            <g key={`gap-${p.k}`} className="yago-gap passive" style={{ cursor: 'not-allowed' }}>
              <DimArrows a={a} b={b} asz={asz} color={DIM_LINE} />
              <DimPill cx={p.cx} cy={p.cy} txt={p.txt} fs={fs} fill="#f5f3ef" stroke="#d6cfc3" strokeWidth={0.9} color="#a8a29e" hideText={false}
                title="Gap — remainder (all other gaps pinned or locked); open one to edit" />
            </g>
          );
          const lockTitle = locked ? 'Locked — fixed on resize and when other gaps are edited. Click: open'
            : edited ? 'Pinned — keeps its value when other gaps are edited, still scales with the volume on resize. Click: lock'
            : 'Open — takes up changes from other gaps and scales with the volume on resize. Click: pin';
          return (
            <g key={`gap-${p.k}`} className={`yago-gap${locked ? ' locked' : ''}`}>
              <DimArrows a={a} b={b} asz={asz} color={locked ? '#f59e0b' : DIM_LINE} />
              <DimPill cx={p.cx} cy={p.cy} txt={p.txt} fs={fs} fill={locked || edited ? '#fff7ed' : '#ffffff'} stroke={locked ? '#f97316' : edited ? '#fbbf24' : SOFT.pillStroke} strokeWidth={locked || edited ? 1 : 0.7}
                color={locked ? '#c2410c' : edited ? '#9a3412' : '#44403c'} hideText={editing?.kind === 'gap' && editing.k === p.k} title={edited ? 'Pinned gap — click to edit (open gaps take up the difference)' : 'Edit gap (open gaps take up the difference)'} onClick={e => { stop(e); beginEdit({ kind: 'gap', k: p.k, v: p.txt }); }} />
              <LockBadge cx={lockCx} cy={lockCy} locked={locked} edited={edited} onClick={() => onToggleLock(p.k)} title={lockTitle} holdIcon />
            </g>
          );
        })}
      </svg>
      {editing && !memberMode && (() => {
        const p = editing.kind === 'gap' ? pills[editing.k] : tPills[editing.i]; if (!p) return null;
        const fsE = editing.kind === 'gap' ? fs : fsT;
        return (
          <input autoFocus type="text" inputMode="decimal" value={editing.v}
            onChange={e => { const next = { ...editing, v: e.target.value } as SchemaEdit; setEditing(next); previewEdit(next, e.target.value); }}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancelEdit(); }}
            onClick={stop}
            style={{
              position: 'absolute', left: p.cx - p.pw / 2 - 4, top: p.cy - p.ph / 2 - 2, width: p.pw + 8, height: p.ph + 4, textAlign: 'center',
              fontFamily: UI_FONT, fontSize: fsE, fontWeight: 600, color: '#1c1917', fontVariantNumeric: 'tabular-nums',
              background: '#fff', border: '1px solid #f97316', borderRadius: 99, outline: 'none', boxShadow: '0 0 0 2px rgba(249,115,22,0.12)', padding: 0,
            }} />
        );
      })()}
    </div>
  );
}

/* KAPAK ŞEMASI: temsili ön görünüş (eksenler ayrı ölçeklenir). Ölçü zinciri yalnız seçili bölgenin üzerinde ve
   oksuz (oklar 3 mm boşluklara giriyordu). Sınır levhaları yalnız DIŞ kapakta çizilir. */
const DOOR_INSET_PX = 1.5;        // kapaklar içeri çizilir ki 3 mm boşluklar görünsün
const CHAIN_OFF_H = 27;           // alt bant ve ortadaki rozetle çakışmasın
const CHAIN_OFF_V = 38;           // pill'ler yatay geniş, sağ bant rozetini aşsın
const CHAIN_STEP = 16;
const DOOR_PAD_L = 12, DOOR_PAD_T = 12, DOOR_PAD_R = 12, DOOR_PAD_B = 12;
const DOOR_MIN_ASPECT = 0.6;      // çok geniş kapakta ölçüler sıkışmasın
const PILL_LANE_GAP = 3;

/* AÇILIŞ İŞARETİ (DIN/AWI görünüş sözleşmesi): kulp kenarının iki köşesinden menteşe kenarının ORTASINA kesikli çizgi —
   sivri uç menteşe tarafıdır. Fold'da iki kanadın ucu da üstte. Şema ve tip ikonları aynı çizimi kullanır. */
type Hinge = 'L' | 'R' | 'T' | 'B';
const swingPath = (x0: number, y0: number, x1: number, y1: number, h: Hinge) => {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, f = (n: number) => n.toFixed(1);
  if (h === 'L') return `M${f(x1)},${f(y0)} L${f(x0)},${f(cy)} L${f(x1)},${f(y1)}`;
  if (h === 'R') return `M${f(x0)},${f(y0)} L${f(x1)},${f(cy)} L${f(x0)},${f(y1)}`;
  if (h === 'T') return `M${f(x0)},${f(y1)} L${f(cx)},${f(y0)} L${f(x1)},${f(y1)}`;
  return `M${f(x0)},${f(y0)} L${f(cx)},${f(y1)} L${f(x1)},${f(y0)}`;
};
/** Çokgen kapakta açılış işareti: menteşe kenarı = dış normali menteşe yönüne en çok bakan kenar; kulp kenarı = karşısı. */
const swingPathPoly = (pts: Array<{ x: number; y: number }>, h: Hinge, ins: number): string | null => {
  if (pts.length < 3) return null;
  const c = { x: pts.reduce((a, q) => a + q.x, 0) / pts.length, y: pts.reduce((a, q) => a + q.y, 0) / pts.length };
  const edges = pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
    if (nx * ((a.x + b.x) / 2 - c.x) + ny * ((a.y + b.y) / 2 - c.y) < 0) { nx = -nx; ny = -ny; }
    return { a, b, len, nx, ny };
  });
  const dirOf = (k: Hinge) => (k === 'L' ? { x: -1, y: 0 } : k === 'R' ? { x: 1, y: 0 } : k === 'T' ? { x: 0, y: -1 } : { x: 0, y: 1 });
  const pick = (k: Hinge) => {
    const d = dirOf(k);
    const sc = edges.map(e => ({ e, dot: e.nx * d.x + e.ny * d.y })).filter(x => x.dot > 0.5);
    if (!sc.length) return null;
    const top = Math.max(...sc.map(x => x.dot));
    return sc.filter(x => x.dot > top - 0.15).sort((p, q) => q.e.len - p.e.len)[0].e;
  };
  const opp: Record<Hinge, Hinge> = { L: 'R', R: 'L', T: 'B', B: 'T' };
  const he = pick(h), pe = pick(opp[h]);
  if (!he || !pe) return null;
  const apex = { x: (he.a.x + he.b.x) / 2 - he.nx * ins, y: (he.a.y + he.b.y) / 2 - he.ny * ins };
  const inward = (q: { x: number; y: number }) => { const dx = c.x - q.x, dy = c.y - q.y, L = Math.hypot(dx, dy) || 1; return { x: q.x + dx / L * ins * 1.4, y: q.y + dy / L * ins * 1.4 }; };
  const p0 = inward(pe.a), p1 = inward(pe.b), f = (n: number) => n.toFixed(1);
  return `M${f(p0.x)},${f(p0.y)} L${f(apex.x)},${f(apex.y)} L${f(p1.x)},${f(p1.y)}`;
};
/** Kanat sırası: double sol→sağ (bakan kişiye göre), fold üst→alt. */
const leafHinges = (t: DoorType): Hinge[] => (t === 'left' ? ['L'] : t === 'right' ? ['R'] : t === 'up' ? ['T'] : t === 'down' ? ['B'] : t === 'double' ? ['L', 'R'] : t === 'fold' ? ['T', 'T'] : []);
function DoorTypeIcon({ type, size = 14, strokeWidth = 1.25 }: { type: DoorType; size?: number; strokeWidth?: number }) {
  const W = 20, H = 16, p = 1, g = 1.2;
  const hinges = leafHinges(type);
  const leaves: Array<[number, number, number, number]> =
    type === 'double' ? [[p, p, W / 2 - g / 2, H - p], [W / 2 + g / 2, p, W - p, H - p]]
      : type === 'fold' ? [[p, p, W - p, H / 2 - g / 2], [p, H / 2 + g / 2, W - p, H - p]]
        : [[p, p, W - p, H - p]];
  return (
    <svg width={size * W / H} height={size} viewBox={`0 0 ${W} ${H}`} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" style={{ flexShrink: 0, display: 'block' }} aria-hidden>
      {leaves.map(([x0, y0, x1, y1], i) => (
        <g key={i}>
          <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx={0.6} />
          {hinges[i] && <path d={swingPath(x0 + 1.6, y0 + 1.6, x1 - 1.6, y1 - 1.6, hinges[i])} strokeDasharray="1.8 1.3" strokeWidth={strokeWidth * 0.85} />}
        </g>
      ))}
      {type === 'drawer' && <line x1={W / 2 - 3.5} y1={H / 2 - 1.5} x2={W / 2 + 3.5} y2={H / 2 - 1.5} strokeWidth={strokeWidth * 1.5} />}
      {type === 'fixed' && [[4, 4], [W - 4, 4], [4, H - 4], [W - 4, H - 4]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r={0.9} fill="currentColor" stroke="none" />)}
    </svg>
  );
}
function DoorTypeBar({ value, hint, onPick }: { value: DoorType | null; hint: string; onPick: (t: DoorType) => void }) {
  return (
    <div className="flex items-stretch gap-1.5 mb-1" title="Door type — applies to the doors selected in the schematic (click a door; Shift/Ctrl+click adds more; none selected = all doors). The selection clears once a type is applied.">
      <div className="flex-1 min-w-0" style={{ display: 'grid', gridTemplateColumns: `repeat(${DOOR_TYPES.length}, minmax(0,1fr))`, gap: 2, padding: 2, borderRadius: 9, background: '#f3efe8', border: '1px solid #e9e4dc', fontFamily: UI_FONT }}>
        {DOOR_TYPES.map(t => {
          const on = value === t;
          return (
            <button key={t} type="button" title={DOOR_TYPE_TITLE[t]} onClick={e => { stop(e); onPick(t); }}
              className={on ? '' : 'hover:!bg-white hover:!text-stone-800'}
              style={{
                height: 34, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, padding: '0 2px', borderRadius: 7, border: 'none', outline: 'none',
                cursor: 'pointer', background: on ? '#44403c' : 'transparent', color: on ? '#ffffff' : '#57534e',
                boxShadow: on ? '0 1px 2px rgba(40,30,20,0.25)' : 'none', fontSize: 10, fontWeight: 600, letterSpacing: '0.01em', lineHeight: 1, transition: 'background 0.12s,color 0.12s',
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
function BackTypeIcon({ type, size = 14, strokeWidth = 1.25 }: { type: BackPlacement; size?: number; strokeWidth?: number }) {
  const W = 20, H = 16;
  return (
    <svg width={size * W / H} height={size} viewBox={`0 0 ${W} ${H}`} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" style={{ flexShrink: 0, display: 'block' }} aria-hidden>
      <rect x={2.5} y={1.5} width={3} height={type === 'outer' ? 9.5 : 13} rx={0.6} />
      <rect x={14.5} y={1.5} width={3} height={type === 'outer' ? 9.5 : 13} rx={0.6} />
      {type === 'outer'
        ? <rect x={2.5} y={12} width={15} height={2.5} rx={0.6} fill="currentColor" fillOpacity={0.18} />
        : <rect x={4} y={9.5} width={12} height={2.5} rx={0.6} fill="currentColor" fillOpacity={0.18} />}
    </svg>
  );
}
/* GÖRSEL İPUCU YAPISI (Goker, Eki 2026 — "nereden bollaştıracağımı kestiremiyorum, yeni kullanıcıya görsel geri dönüş"):
   değer kutusu (HintCell) üzerine gelince / odaklanınca kendi ANAHTARINI yayar (onHint); aynı anahtarı okuyan şekil (kesit
   diyagramı, şema) o ölçüyü turuncu vurgular, alt satır (HintCaption) ne olduğunu yazar. Yeni bir ölçü = anahtar + hücre +
   diyagram parçası + açıklama satırı; başka kartlara (kapak, raf) da aynı üç parça ile bağlanır. */
type HintProps = { hintKey: string; active: boolean; onHint: (k: string | null) => void };
/** Tek satırlık değer hücresi: etiket solda, değer sağda; üzerine gelince / odaklanınca anahtarını yayar (diyagram + şema vurgusu).
 *  Metin ipucu (title) bilerek YOK — geri bildirim görseldir (Goker, Eki 2026). */
function HintCell({ hintKey, active, onHint, label, accent, passive, children }: HintProps & { label: string; accent?: boolean; passive?: boolean; children: React.ReactNode }) {
  return (
    <div onClick={stop}
      onMouseEnter={() => { if (!passive) onHint(hintKey); }} onMouseLeave={e => { if (!(e.currentTarget as HTMLElement).contains(document.activeElement)) onHint(null); }}
      onFocusCapture={() => { if (!passive) onHint(hintKey); }} onBlurCapture={() => onHint(null)}
      className={`min-w-0 h-full pl-2 pr-1 flex items-center gap-1 rounded-[7px] transition-shadow duration-150
        ${passive ? 'bg-[#f6f2ec] ring-1 ring-[#ebe5dc]' : active ? 'bg-white ring-[1.5px] ring-orange-500 shadow-[0_0_0_2px_rgba(249,115,22,0.12)]' : accent ? 'bg-white ring-1 ring-orange-400/70' : 'bg-white ring-1 ring-[#e6e0d6] shadow-[0_1px_0_rgba(40,30,20,0.03)]'}`}>
      <span className={`flex-1 min-w-0 truncate text-[10px] font-semibold tracking-[0.08em] uppercase ${passive ? 'text-[#cfc6b9]' : active ? 'text-orange-600' : 'text-[#b5ada3]'}`}>{label}</span>
      {children}
    </div>
  );
}
/** KANAL KESİT DİYAGRAMI (plan görünüş, ölçeksiz): dolaba ÖNDEN bakar gibi — ARKA ÜSTTE, ÖN ALTTA (Goker, Eki 2026: "arkası aşağıda
 *  durması kafa karıştırıcı"). Sınır paneli sağda, arkadan öne uzanır; arkalık parçası üstte (arka tarafta), bollaştırılmış kanal.
 *  active = vurgulanan ölçü: 't' kalınlık · 'setback' arkadan mesafe · 'gf' / 'gb' / 'gd' ön / arka / dip payı.
 *  Değerler yazılı: kutudaki sayıyla aynı (kullanıcı hangi sayının neresi olduğunu görsün). */
/** @param inset verilirse kanala giriş derinliği (In) ölçekli çizilir ve etiketlenir (hızlı gövde; arkalık kartında kenar başına olduğundan verilmez). */
function BackGrooveDiagram({ active, grooved, t, setback, front, rear, depth, inset, className }: { active: string | null; grooved: boolean; t: number; setback: number; front: number; rear: number; depth: number; inset?: number; className?: string }) {
  const W = BACK_DIAGRAM_W, H = BACK_DIAGRAM_H;
  const O = '#ea580c', OF = '#fdba74', MUTE = '#b8aea0', TXT = '#8f877c', DARK = '#57534e';
  const T = 15, PX0 = 132, PX1 = 164, D = 7, F = 6, R = 6;
  // Panel genişliği 32 px ≈ 18 mm; In verilmişse giriş o ölçekte (6..24 px), yoksa temsili 16
  const IN = inset == null ? 16 : Math.max(6, Math.min(24, (inset / 18) * (PX1 - PX0)));
  // Kanallı: panelin arka yüzü ÜSTTE (rear0), arkalık S kadar öne (aşağı) içerde, panele IN girer. Çakma: arkalık panelin ARKASINDA
  // (üstünde), ucunu örter ve panelin DIŞ yüzünde biter (sınırı geçmez).
  const rear0 = grooved ? 20 : 36, S = grooved ? 26 : 0;
  const by0 = grooved ? rear0 + S : rear0 - T, by1 = by0 + T;   // arkalık parçası: by0 = arka yüzü (üst), by1 = ön yüzü (alt)
  const gx1 = PX0 + IN + D, gy0 = by0 - R, gy1 = by1 + F;        // kanal: üstte arka payı (R), altta ön payı (F)
  const on = (k: string) => active === k;
  const f1 = (v: number) => String(round1(v));
  const col = (k: string) => (on(k) ? O : DARK);
  const dim = (x: number, y0: number, y1: number, k: string) => (
    <g stroke={on(k) ? O : MUTE} strokeWidth={on(k) ? 1.3 : 0.9}><line x1={x} y1={y0} x2={x} y2={y1} /><line x1={x - 3} y1={y0} x2={x + 3} y2={y0} /><line x1={x - 3} y1={y1} x2={x + 3} y2={y1} /></g>
  );
  const txt = (x: number, y: number, s: string, k: string, anchor: 'start' | 'middle' | 'end' = 'middle') => (
    <text x={x} y={y} fontSize={10.2} fontWeight={700} fill={col(k)} textAnchor={anchor} fontFamily={UI_FONT} style={{ fontVariantNumeric: 'tabular-nums' }}>{s}</text>
  );
  const panelLblY = H - 21;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className={`block rounded-[8px] bg-[#faf7f2] ring-1 ring-[#ebe5dc] ${className ?? ''}`} aria-hidden>
      <text x={8} y={13} fontSize={9.2} fill={TXT} fontFamily={UI_FONT}>rear</text>
      <text x={8} y={H - 7} fontSize={9.2} fill={TXT} fontFamily={UI_FONT}>front ↓</text>
      <line x1={6} y1={rear0} x2={PX1 + 10} y2={rear0} stroke={MUTE} strokeWidth={0.8} strokeDasharray="3 2.5" />
      {/* sınır paneli: arka yüzünden (üst) öne (alt) */}
      <rect x={PX0} y={rear0} width={PX1 - PX0} height={H - 6 - rear0} fill="#ebe4d9" stroke="#a39a8d" strokeWidth={1} />
      <text x={(PX0 + PX1) / 2 + 3} y={panelLblY} fontSize={9.2} fill="#8f877c" textAnchor="middle" fontFamily={UI_FONT} transform={`rotate(-90 ${(PX0 + PX1) / 2 + 3} ${panelLblY})`}>panel</text>
      {grooved && <>
        {/* kanal (kesilen boşluk) + vurgular */}
        <rect x={PX0} y={gy0} width={gx1 - PX0} height={gy1 - gy0} fill="#ffffff" stroke={O} strokeOpacity={0.75} strokeWidth={0.9} strokeDasharray="2.5 2" />
        {on('gb') && <rect x={PX0} y={gy0} width={gx1 - PX0} height={R} fill={OF} stroke={O} strokeWidth={1} />}
        {on('gf') && <rect x={PX0} y={by1} width={gx1 - PX0} height={F} fill={OF} stroke={O} strokeWidth={1} />}
        {on('gd') && <rect x={PX0 + IN} y={gy0} width={D} height={gy1 - gy0} fill={OF} stroke={O} strokeWidth={1} />}
      </>}
      {/* arkalık parçası: kanallıda panele girer, çakmada panelin arkasında ucunu örter (panelin dış yüzünde biter) */}
      <rect x={10} y={by0} width={(grooved ? PX0 + IN : PX1) - 10} height={T} fill={on('t') ? '#fed7aa' : '#f3ece2'} stroke={on('t') ? O : '#78716c'} strokeWidth={1.1} />
      <text x={64} y={by0 + T / 2 + 3} fontSize={9.2} fill="#78716c" textAnchor="middle" fontFamily={UI_FONT}>back panel</text>
      {/* T — kalınlık (etiket parçanın önünde/altında) */}
      {dim(20, by0, by1, 't')}{txt(20, by1 + 12, `T ${f1(t)}`, 't')}
      {grooved ? <>
        {/* S — setback (panelin arka yüzünden arkalığın arka yüzüne) */}
        {dim(100, rear0, by0, 'setback')}{txt(105, (rear0 + by0) / 2 + 3.5, `S ${f1(setback)}`, 'setback', 'start')}
        {/* R üstte (arkaya), F altta (öne), D kanal dibinde */}
        {txt(W - 6, gy0 + 3, `R ${f1(rear)}`, 'gb', 'end')}
        {txt(W - 6, gy1 + 7, `F ${f1(front)}`, 'gf', 'end')}
        {txt(PX0 + IN + D / 2, gy1 + 13, `D ${f1(depth)}`, 'gd')}
        {inset != null && <>
          {on('in') && <rect x={PX0} y={by0} width={IN} height={T} fill={OF} stroke={O} strokeWidth={1} />}
          <g stroke={on('in') ? O : '#8f877c'} strokeWidth={on('in') ? 1.3 : 0.9}><line x1={PX0} y1={by0 + T / 2} x2={PX0 + IN} y2={by0 + T / 2} /><line x1={PX0 + IN} y1={by0 + 3} x2={PX0 + IN} y2={by1 - 3} /></g>
          {txt(PX0 - 4, by1 + 12, `In ${f1(inset)}`, 'in', 'end')}
        </>}
      </> : (
        <text x={PX1} y={by0 - 5} fontSize={9.2} fontWeight={700} fill={TXT} textAnchor="end" fontFamily={UI_FONT}>nailed on</text>
      )}
    </svg>
  );
}
/** Tip düğmeleri (kart hücresi): Nailed ve Grooved yan yana İKİ AYRI düğme, hücreyi eşit paylaşır; value=null → ikisi de pasif (karışık). */
function BackTypeButtons({ value, hint, onPick }: { value: BackPlacement | null; hint: string; onPick: (t: BackPlacement) => void }) {
  return (
    <div className="min-w-0 h-full grid grid-cols-2 gap-1" onClick={stop}>
      {(['outer', 'inner'] as const).map(t => {
        const on = value === t;
        return (
          <button key={t} type="button" title={`${BACK_TYPE_LABEL[t]} — ${hint.toLowerCase()}`} onClick={e => { stop(e); onPick(t); }}
            className={`min-w-0 h-full px-1 rounded-[7px] flex items-center justify-center gap-1 text-[11px] font-semibold transition-colors duration-150
              ${on ? 'bg-[#44403c] text-white ring-1 ring-[#44403c] shadow-[0_1px_2px_rgba(40,30,20,0.25)]' : 'bg-white text-stone-600 ring-1 ring-[#e6e0d6] hover:bg-[#faf7f2] hover:text-stone-800'}`}
            style={{ fontFamily: UI_FONT }}>
            {/* Dar kenar çubuğunda etiket kesilmesin: yalnız yazı (ikon yok). */}
            <span className="truncate" style={{ letterSpacing: '-0.01em' }}>{BACK_TYPE_LABEL[t]}</span>
          </button>
        );
      })}
    </div>
  );
}
type DoorEdit = { key: string; v: string };
/** Ölçü zinciri öğesi; a..b = eksen boyunca mm. `span` (yalnız boşluk): kenarın/derzin çapraz eksendeki GERÇEK uzunluğu —
 *  pill bu uzunluğun ortasına yerleşir (açılı kesimde kenar kısalır). */
type ChainItem = { key: string; kind: 'size' | 'gap'; a: number; b: number; txt: string; title: string; locked?: boolean; edited?: boolean; passive?: boolean; onLock?: () => void; lockTitle?: string; commit: (v: number) => void; preview?: (v: number) => void; min: number; span?: [number, number] };
type Chain = { horiz: boolean; pos: number; items: ChainItem[]; small?: boolean };
export function DoorSchematic({ group, selectedIndex, selectedNodes, memberLabels, cuts, nearPanels, refPick, onEditSize, onToggleLock, onEditSplitGap, onEditEdgeGap, onEditLeaf, onEditLeafGap, onPathClick, onToggleHalfOverlay, onAlignJoint, onJointOverlay, onRefPick, onSplitAtPanel, onEdgeOverlay, addPick, onAddPick, onRemovePick, addObstacles, onEditBegin, onEditCancel }: {
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  const [editing, setEditing] = useState<DoorEdit | null>(null);
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(es => { const w = es[0].contentRect.width; if (w > 0) setWidth(Math.round(w)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Giriş kutusu ağaç değişince KAPANMAMALI (canlı önizleme ağacı her tuşta yazar) — treeKey deps'e girmez.
  const treeKey = JSON.stringify(group.tree);
  const selKey = selectedNodes.join('|');
  useEffect(() => { setEditing(null); }, [group.id, selectedIndex >= 0, selKey]);
  const snapRef = useRef<unknown>(undefined);
  const cancelledRef = useRef(false);
  const beginEdit = (e: DoorEdit) => { snapRef.current = onEditBegin?.(); cancelledRef.current = false; setEditing(e); };
  const cancelEdit = () => { cancelledRef.current = true; onEditCancel?.(snapRef.current); setEditing(null); };

  const { rect, axis, side } = group;
  const SW = Math.max(40, width - DOOR_PAD_L - DOOR_PAD_R);
  const duR = Math.max(1e-6, rect.u1 - rect.u0), dvR = Math.max(1e-6, rect.v1 - rect.v0);
  const SH = Math.round(Math.max(DOOR_MIN_ASPECT * SW, Math.min(PREVIEW_HEIGHT - DOOR_PAD_T - DOOR_PAD_B, SW * dvR / duR)));
  const height = SH + DOOR_PAD_T + DOOR_PAD_B;
  const ox = DOOR_PAD_L, oy = DOOR_PAD_T;
  // Görünüş: arka (Z−) ve sağ yan (X+) aynalı; üst (Y+) → Z aşağı.
  const mirrorU = (axis === 2 && side < 0) || (axis === 0 && side > 0);
  const mirrorV = axis === 1 && side > 0;
  const eg = edgeGapsOf(group);
  const cutsKey = cuts.map(c => `${c.vfId}:${c.n.map(x => x.toFixed(3)).join(',')}:${c.dMin.toFixed(1)}:${c.dMax.toFixed(1)}`).join('|');
  const solved = useMemo(() => solveDoorTree(group), // eslint-disable-next-line react-hooks/exhaustive-deps
    [rect, treeKey, group.gap, eg.uMin, eg.uMax, eg.vMin, eg.vMax]);
  const members = useMemo(() => applyDoorCuts(group, rect, doorMemberRects(solved), cuts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [solved, cutsKey, group.placement, group.thickness, group.gap]);
  const sx = (u: number) => (mirrorU ? ox + SW - ((u - rect.u0) / duR) * SW : ox + ((u - rect.u0) / duR) * SW);
  const sy = (v: number) => (mirrorV ? oy + ((v - rect.v0) / dvR) * SH : oy + ((rect.v1 - v) / dvR) * SH);
  const fs = schemFs(width);
  const fsT = schemFsT(fs);
  const gid = `ds-${group.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  // Hiza rozeti tıkı derzi levhaya BAĞLAR ve levhayı taşır (kapak yerinde kalır); Shift/Ctrl+tık bağı çözer.
  const I = DOOR_INSET_PX;
  const BAND_MIN = 6;
  const clampX = (x: number) => Math.max(ox - DOOR_PAD_L + 2, Math.min(ox + SW + DOOR_PAD_R - 2, x));
  const clampY = (y: number) => Math.max(oy - DOOR_PAD_T + 2, Math.min(oy + SH + DOOR_PAD_B - 2, y));
  const isOuter = group.placement === 'outer';
  const noun = 'Door';
  const invX = (x: number) => rect.u0 + (mirrorU ? (ox + SW - x) : (x - ox)) * duR / SW;
  const invY = (y: number) => (mirrorV ? rect.v0 + (y - oy) * dvR / SH : rect.v1 - (y - oy) * dvR / SH);
  const areaPx = [[ox - DOOR_PAD_L + 2, oy - DOOR_PAD_T + 2], [ox + SW + DOOR_PAD_R - 2, oy - DOOR_PAD_T + 2], [ox + SW + DOOR_PAD_R - 2, oy + SH + DOOR_PAD_B - 2], [ox - DOOR_PAD_L + 2, oy + SH + DOOR_PAD_B - 2]];
  const areaMm = areaPx.map(([x, y]) => ({ x: invX(x), y: invY(y) }));
  type Pt = { x: number; y: number };
  const ptsPath = (pts: Pt[]) => pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ') + ' Z';
  // `pts`: ön görünüşü dikdörtgen olmayan levhada (eğik panel altında pahlı yan) gerçek izdüşüm zarfı; x/y/w/h = zarfın kutusu.
  type Band = { np: DoorNearPanel; x: number; y: number; w: number; h: number; vertical: boolean; half: boolean; none: boolean; aligned: boolean; pts: Pt[] };
  const bands: Band[] = nearPanels.map(np => {
    const vertical = np.kind === 'u';
    let a0 = vertical ? Math.min(sx(np.a0), sx(np.a1)) : Math.min(sy(np.a0), sy(np.a1)), a1 = vertical ? Math.max(sx(np.a0), sx(np.a1)) : Math.max(sy(np.a0), sy(np.a1));
    if (a1 - a0 < BAND_MIN) { const c = (a0 + a1) / 2; a0 = c - BAND_MIN / 2; a1 = c + BAND_MIN / 2; }
    const c0 = vertical ? clampY(Math.min(sy(np.c0), sy(np.c1))) : clampX(Math.min(sx(np.c0), sx(np.c1)));
    const c1 = vertical ? clampY(Math.max(sy(np.c0), sy(np.c1))) : clampX(Math.max(sx(np.c0), sx(np.c1)));
    const none = !!np.edge && np.behind && !!group.noOverlay?.[np.edge];
    const half = !none && !!np.edge && np.behind && !!group.halfOverlay?.[np.edge];
    let x = vertical ? a0 : c0, y = vertical ? c0 : a0, w = vertical ? a1 - a0 : c1 - c0, h = vertical ? c1 - c0 : a1 - a0;
    let pts: Pt[] = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    const hull = np.poly ? clipPolyToConvex(np.poly, areaMm) : [];
    if (hull.length >= 3) {
      pts = hull.map(q => ({ x: sx(q.x), y: sy(q.y) }));
      const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
      x = Math.min(...xs); y = Math.min(...ys); w = Math.max(...xs) - x; h = Math.max(...ys) - y;
    }
    return { np, vertical, half, none, aligned: !!np.ref && !!np.joint, x, y, w, h, pts };
  });
  const cutBands = doorCutBands(group, rect, cuts, areaMm, BAND_MIN * dvR / SH).map(cb => {
    const pts = cb.poly.map(q => ({ x: sx(q.x), y: sy(q.y) }));
    const cx = pts.reduce((a, q) => a + q.x, 0) / pts.length, cy = pts.reduce((a, q) => a + q.y, 0) / pts.length;
    const dx = (mirrorU ? -1 : 1) * cb.dir.x, dy = (mirrorV ? 1 : -1) * cb.dir.y;
    const deg = Math.atan2(dy, dx) * 180 / Math.PI;
    const half = !!cb.edge && cb.covered && !!group.halfOverlay?.[cb.edge];
    // Yazı hep okunur yönde (−90°..90°); % yerine döngü: JS % negatifte işaret korur.
    let rd = deg; while (rd > 90) rd -= 180; while (rd < -90) rd += 180;
    return { ...cb, pts, cx, cy, deg: rd, half };
  });
  // Eğik kenarın boşluk pill'i eğik kenarın üzerinde durur; düz kenar zincirlerinde o kenar GÖSTERİLMEZ (yanıltıcı olur).
  const slopeSegs = cutBands.flatMap(cb => {
    if (!cb.edge) return [];
    let best: { a: Pt; b: Pt; len: number; m: typeof members[number] } | null = null;
    for (const m of members) {
      if (!m.poly) continue;
      for (let i = 0; i < m.poly.length; i++) {
        const a = m.poly[i], b = m.poly[(i + 1) % m.poly.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1 || Math.abs((b.x - a.x) * cb.dir.y - (b.y - a.y) * cb.dir.x) / len > 0.01) continue;
        if (!best || len > best.len) best = { a, b, len, m };
      }
    }
    return best ? [{ cb, edge: cb.edge, ...best }] : [];
  });
  const slopeEdges = new Set<DoorEdgeKey>(slopeSegs.map(sg => sg.edge));
  const hiddenParts = (b: Band) => members.flatMap(m => {
    const dx0 = Math.min(sx(m.u0), sx(m.u1)) + I, dx1 = Math.max(sx(m.u0), sx(m.u1)) - I, dy0 = Math.min(sy(m.v1), sy(m.v0)) + I, dy1 = Math.max(sy(m.v1), sy(m.v0)) - I;
    if (dx1 - dx0 < 0.5 || dy1 - dy0 < 0.5) return [];
    const part = clipPolyToConvex(b.pts, [{ x: dx0, y: dy0 }, { x: dx1, y: dy0 }, { x: dx1, y: dy1 }, { x: dx0, y: dy1 }]);
    return part.length >= 3 && Math.abs(polyArea(part)) > 0.5 ? [part] : [];
  });
  // DERZ BİNİSİ: 'min'/'max' = o taraftaki (düşük/yüksek u·v) kapak levhayı tamamen örter (Full), 'center' = ikisi yarı (Half).
  const sideName = (b: Band, a: DoorAlign) => (b.vertical ? ((a === 'min') !== mirrorU ? 'Left' : 'Right') : ((a === 'max') !== mirrorV ? 'Top' : 'Bottom'));
  const allJoints = doorJoints(solved);
  // Seçili bölge levhaya bitişikse: o bölgenin derzi + levhanın hangi tarafında olduğu (np.joint öncelikli).
  const overlayCtx = (np: DoorNearPanel): { j: DoorJoint; side: DoorAlign } | null => {
    if (np.edge || !np.joint || !overlayRegions.length) return null;
    const pc = (np.a0 + np.a1) / 2, t = np.a1 - np.a0;
    const cands = allJoints.filter(j => j.axis === np.kind && Math.min(j.c1, np.c1) - Math.max(j.c0, np.c0) >= 0.5
      && Math.abs((j.p0 + j.p1) / 2 - pc) <= t / 2 + (j.p1 - j.p0) / 2 + JOINT_NEAR)
      .sort((a, b) => Number(!(a.splitId === np.joint!.splitId && a.k === np.joint!.k)) - Number(!(b.splitId === np.joint!.splitId && b.k === np.joint!.k)));
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
  // KAPAK BİNİSİ (kapak seçili): Full = seçili kapak levhayı tamamen örter · Half = iki kapak levha ortasına · None = seçili kapak
  // levhanın kenarında biter, komşu kapak levhayı örter. Levha yerinde kalır; yalnız iki komşu kapak uzar/kısalır.
  type OverlayOpt = 'Full' | 'Half' | 'None';
  const oppAlign = (a: DoorAlign): DoorAlign => (a === 'min' ? 'max' : 'min');
  const alignForOpt = (side: DoorAlign, o: OverlayOpt): DoorAlign => (o === 'Full' ? side : o === 'Half' ? 'center' : oppAlign(side));
  const optOf = (side: DoorAlign, st: DoorAlign | null): OverlayOpt | null => (st === 'center' ? 'Half' : st === side ? 'Full' : st ? 'None' : null);
  const jointChip = (b: Band): string | null => {
    const np = b.np;
    if (np.edge || !np.joint) return null;
    const ctx = overlayCtx(np);
    if (ctx) { const s = overlayState(np, ctx.j); return s === 'center' ? 'Half' : s === ctx.side ? 'Full' : s ? 'None' : 'Free'; }
    const s = overlayState(np, np.joint);
    return s === 'center' ? 'Half' : s ? `${sideName(b, s)} full` : 'Free';
  };
  const edgeName = (b: Band) => (b.vertical ? ((b.np.edge === 'uMin') !== mirrorU ? 'Left' : 'Right') : ((b.np.edge === 'vMax') !== mirrorV ? 'Top' : 'Bottom'));
  const bandTip = (b: Band) => {
    const np = b.np;
    if (np.edge) {
      if (!np.behind) return `${edgeName(b)} — ${np.name}: stands in front of the ${noun.toLowerCase()} plane; the ${noun.toLowerCase()} ends beside it (no overlay possible).`;
      const d = noun.toLowerCase();
      const now = b.none ? `NONE — the ${d} ends at this panel's inner face (does not cover it)` : b.half ? `HALF overlay — the ${d} covers half of this panel's thickness (the other half is left for the neighbouring ${d})` : `FULL overlay — the ${d} covers this panel's whole thickness`;
      return `${edgeName(b)} — ${np.name}: ${now}. Click to step Full → Half → None.`;
    }
    const what = b.vertical ? 'divider' : 'shelf';
    if (removable(np)) return `${np.name} (${what}) — added between the doors. Click ✕ Remove to delete it (its row and panel are removed; the doors stay).`;
    if (refPick) return `${np.name} (${what}) — PANEL REF: click to split the door through this ${what}'s middle (Half overlay: both doors reach its middle).`;
    if (!np.joint) return splitChipOn(np)
      ? `${np.name} (${what}) — behind the ${noun.toLowerCase()}; the ${noun.toLowerCase()} passes over it (Full). Click: Half — the ${noun.toLowerCase()} splits through its middle (both reach it); click again for None, then Full. The ${what} stays.`
      : `${np.name} (${what}) — behind the ${noun.toLowerCase()}, no joint nearby. Use Panel ref mode to split the ${noun.toLowerCase()} at it.`;
    const unbind = np.ref ? ' · Shift/Ctrl+click: unbind' : '';
    const ctx = overlayCtx(np);
    if (ctx) {
      const d0 = noun.toLowerCase();
      return `${np.name} (${what}) — overlay of the selected ${d0} (${sideName(b, ctx.side).toLowerCase()} of it): ${jointChip(b)}. Click to step Full (covers the whole ${what}) → Half (to its middle) → None (ends at its edge, the other ${d0} covers it). The ${what} stays; the ${d0}s next to it lengthen / shorten.${unbind}`;
    }
    const d = noun.toLowerCase();
    return `${np.name} (${what}) at the ${d} joint — ${jointChip(b)}. Click: the ${what} MOVES under the joint (Half → ${b.vertical ? 'left' : 'top'} full → ${b.vertical ? 'right' : 'bottom'} full); the ${d}s stay. To change the ${d}s instead, select a ${d} next to it first: then Full / Half lengthens / shortens that ${d} and the ${what} stays.${unbind}`;
  };
  const removable = (np: DoorNearPanel) => !!addPick && !np.edge && np.kind === addPick && np.ref?.master === 'door' && !!np.groupId;
  // Kapak sonradan konan levhada henüz bölünmemiş: levha kapağın arkasında, yakınında derz yok → ilk tık böler (Half).
  const splitChipOn = (np: DoorNearPanel) => !!onSplitAtPanel && !np.edge && !np.joint && np.behind && !refPick && !addPick && canSplitDoorAtPanel(group, np);
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
      const next: OverlayOpt = cur === 'Full' ? 'Half' : cur === 'Half' ? 'None' : 'Full';
      onJointOverlay(ctx.j.splitId, ctx.j.k, np.vfId, alignForOpt(ctx.side, next));
      return;
    }
    const s0 = overlayState(np, j);
    const first: DoorAlign = b.vertical ? (mirrorU ? 'max' : 'min') : (mirrorV ? 'min' : 'max');
    const second: DoorAlign = first === 'min' ? 'max' : 'min';
    onAlignJoint(j.splitId, j.k, np.vfId, s0 === 'center' ? first : s0 === first ? second : 'center');
  };

  const commit = () => {
    if (!editing) return;
    if (cancelledRef.current) { cancelledRef.current = false; return; }   // Esc sonrası blur: onay yok
    const v = parseFloat(editing.v.replace(',', '.'));
    const p = pillByKey.get(editing.key);
    setEditing(null);
    if (isNaN(v) || !p || v < p.item.min) { onEditCancel?.(snapRef.current); return; }   // geçersiz → önizleme geri alınır
    p.item.commit(v);
  };
  const previewEdit = (key: string, raw: string) => {
    const v = parseFloat(raw.replace(',', '.'));
    const p = pillByKey.get(key);
    if (isNaN(v) || !p || v < p.item.min) return;
    p.item.preview?.(v);
  };
  const pathToLeaf = (leafId: string): string[] => {
    const out: string[] = [];
    const dfs = (n: DoorNodeSolved): boolean => { out.push(n.id); if (n.id === leafId) return true; if (n.kind === 'split') for (const c of n.children) if (dfs(c)) return true; out.pop(); return false; };
    dfs(solved);
    return out;
  };
  const nodeBox = (n: DoorNodeSolved) => ({ x0: Math.min(sx(n.u0), sx(n.u1)), x1: Math.max(sx(n.u0), sx(n.u1)), y0: Math.min(sy(n.v1), sy(n.v0)), y1: Math.max(sy(n.v1), sy(n.v0)) });
  const selRegions = selectedNodes.map(id => findSolvedNode(solved, id)).filter((n): n is DoorNodeSolved => !!n);
  // Bini bağlamı: şemada bölge seçili değilse listede / 3B'de seçili kapağın yaprağı (kapak satırı açıkken de Full/Half/None çıksın).
  const selMemberLeaf = selectedIndex >= 0 && members[selectedIndex] ? findSolvedNode(solved, members[selectedIndex].leafId) : null;
  const overlayRegions: DoorNodeSolved[] = [...(selMemberLeaf ? [selMemberLeaf] : []), ...selRegions];
  const leafIdsUnder = (n: DoorNodeSolved): string[] => (n.kind === 'leaf' ? [n.id] : n.children.flatMap(leafIdsUnder));
  const selLeafIds = new Set(selRegions.flatMap(leafIdsUnder));
  // Ölçü zincirleri YALNIZ seçili bölgeler için; boşluklar turuncu şeritle işaretlenir.
  const solvedParent = (id: string): Extract<DoorNodeSolved, { kind: 'split' }> | null => {
    const walkP = (n: DoorNodeSolved): Extract<DoorNodeSolved, { kind: 'split' }> | null => {
      if (n.kind !== 'split') return null;
      if (n.children.some(c => c.id === id)) return n;
      for (const c of n.children) { const h = walkP(c); if (h) return h; }
      return null;
    };
    return walkP(solved);
  };
  const chains: Chain[] = [];
  const fmt = (v: number) => String(round1(v));
  const focusStrips: Array<{ x: number; y: number; w: number; h: number }> = [];
  const stripClip = cuts.length ? doorCutOutline(group, rect, rect, cuts, false).map(q => ({ x: sx(q.x), y: sy(q.y) })) : null;
  const strip = (axis: 'u' | 'v', a: number, b: number, c0: number, c1: number) => {
    const MINW = 3;
    let x0 = axis === 'u' ? Math.min(sx(a), sx(b)) : Math.min(sx(c0), sx(c1)), x1 = axis === 'u' ? Math.max(sx(a), sx(b)) : Math.max(sx(c0), sx(c1));
    let y0 = axis === 'u' ? Math.min(sy(c0), sy(c1)) : Math.min(sy(a), sy(b)), y1 = axis === 'u' ? Math.max(sy(c0), sy(c1)) : Math.max(sy(a), sy(b));
    if (axis === 'u' && x1 - x0 < MINW) { const c = (x0 + x1) / 2; x0 = c - MINW / 2; x1 = c + MINW / 2; }
    if (axis === 'v' && y1 - y0 < MINW) { const c = (y0 + y1) / 2; y0 = c - MINW / 2; y1 = c + MINW / 2; }
    focusStrips.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  };
  const T0 = 0.05;
  // Eğik kenar (slopeEdges) dokunuş sayılmaz: onun pill'i eğik kenarın üzerinde (slopePills).
  const touch = { u0: (n: DoorNodeSolved) => !slopeEdges.has('uMin') && Math.abs(n.u0 - (rect.u0 + eg.uMin)) < T0, u1: (n: DoorNodeSolved) => !slopeEdges.has('uMax') && Math.abs(n.u1 - (rect.u1 - eg.uMax)) < T0,
    v1: (n: DoorNodeSolved) => !slopeEdges.has('vMax') && Math.abs(n.v1 - (rect.v1 - eg.vMax)) < T0, v0: (n: DoorNodeSolved) => !slopeEdges.has('vMin') && Math.abs(n.v0 - (rect.v0 + eg.vMin)) < T0 };
  const edgeKeyName = (k: DoorEdgeKey) => (k === 'uMin' ? (mirrorU ? 'Right' : 'Left') : k === 'uMax' ? (mirrorU ? 'Left' : 'Right') : k === 'vMax' ? (mirrorV ? 'Bottom' : 'Top') : (mirrorV ? 'Top' : 'Bottom'));
  type Box4 = { u0: number; u1: number; v0: number; v1: number };
  const outlineMemo = new Map<string, Pt[]>();
  const outlineOf = (r: Box4): Pt[] => {
    const key = `${r.u0.toFixed(2)},${r.u1.toFixed(2)},${r.v0.toFixed(2)},${r.v1.toFixed(2)}`;
    let o = outlineMemo.get(key);
    if (!o) { o = cuts.length ? doorCutOutline(group, rect, r, cuts) : [{ x: r.u0, y: r.v0 }, { x: r.u1, y: r.v0 }, { x: r.u1, y: r.v1 }, { x: r.u0, y: r.v1 }]; outlineMemo.set(key, o); }
    return o;
  };
  const lineSpan = (poly: Pt[], ax: 'u' | 'v', val: number): [number, number] | null => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const pa = ax === 'u' ? a.x : a.y, pb = ax === 'u' ? b.x : b.y;
      if ((pa - val) * (pb - val) > 0 || Math.abs(pb - pa) < 1e-9) continue;
      const t = (val - pa) / (pb - pa), q = ax === 'u' ? a.y + t * (b.y - a.y) : a.x + t * (b.x - a.x);
      lo = Math.min(lo, q); hi = Math.max(hi, q);
    }
    return hi - lo > 0.5 ? [lo, hi] : null;
  };
  const crossOf = (r: Box4, ax: 'u' | 'v'): [number, number] => (ax === 'u' ? [r.v0, r.v1] : [r.u0, r.u1]);
  const clampSpan = (sp: [number, number], c: [number, number]): [number, number] => {
    const lo = Math.max(sp[0], Math.min(c[0], c[1])), hi = Math.min(sp[1], Math.max(c[0], c[1]));
    return hi - lo > 1 ? [lo, hi] : sp;
  };
  /** Doğru kenarın 0.5 mm içinden geçer (tam kenarda kesişim belirsiz). */
  const edgeSpanOf = (R: Box4, k: DoorEdgeKey, on?: Box4): [number, number] => {
    const ax: 'u' | 'v' = k === 'uMin' || k === 'uMax' ? 'u' : 'v';
    const val = k === 'uMin' ? R.u0 + 0.5 : k === 'uMax' ? R.u1 - 0.5 : k === 'vMin' ? R.v0 + 0.5 : R.v1 - 0.5;
    const sp = lineSpan(outlineOf(R), ax, val) ?? crossOf(R, ax);
    return on ? clampSpan(sp, crossOf(on, ax)) : sp;
  };
  const jointSpanOf = (R: Box4, ax: 'u' | 'v', a: number, b: number, on?: Box4): [number, number] => {
    const sp = lineSpan(outlineOf(R), ax, (a + b) / 2) ?? crossOf(R, ax);
    return on ? clampSpan(sp, crossOf(on, ax)) : sp;
  };
  const edgeItem = (k: DoorEdgeKey, a: number, b: number, R: Box4, on?: Box4): ChainItem =>
    ({ key: `edge-${k}`, kind: 'gap', a, b, txt: fmt(eg[k]), title: `${edgeKeyName(k)} edge gap — click to edit`, commit: v => onEditEdgeGap(k, v), preview: v => onEditEdgeGap(k, v, true), min: 0, span: edgeSpanOf(R, k, on) });
  const edgeStrip = (n: DoorNodeSolved, k: DoorEdgeKey) => {
    if (k === 'uMin') strip('u', rect.u0, n.u0, n.v0, n.v1); else if (k === 'uMax') strip('u', n.u1, rect.u1, n.v0, n.v1);
    else if (k === 'vMax') strip('v', n.v1, rect.v1, n.u0, n.u1); else strip('v', rect.v0, n.v0, n.u0, n.u1);
  };
  const slots = new Map<string, { h: number; v: number }>();   // bölge başına aynı yöndeki zincir sayısı (kademe)
  const pushChain = (on: DoorNodeSolved, horiz: boolean, items: ChainItem[]) => {
    if (!items.length) return;
    const sl = slots.get(on.id) ?? { h: 0, v: 0 }; slots.set(on.id, sl);
    const bx1 = Math.max(sx(on.u0), sx(on.u1)), by1 = Math.max(sy(on.v1), sy(on.v0));
    const pos = horiz ? by1 - CHAIN_OFF_H - CHAIN_STEP * sl.h : bx1 - CHAIN_OFF_V - CHAIN_STEP * sl.v;
    if (horiz) sl.h++; else sl.v++;
    chains.push({ horiz, pos, items, small: true });
  };
  type SplitS = Extract<DoorNodeSolved, { kind: 'split' }>;
  // Bölmede tek AÇIK ölçü kaldıysa PASİF (pin de kilit sayılır): girilemez, rozetsiz — değeri kalandan gelir.
  const sizeItem = (P: SplitS, i: number, a: number, b: number, horiz: boolean): ChainItem => {
    const w = P.sizes[i]?.value ?? 0;
    if (passiveSizeIndex(P.sizes, P.children.length) === i) {
      return { key: `size-${P.id}-${i}`, kind: 'size', a, b, txt: fmt(w), passive: true, title: `${horiz ? 'Door width' : 'Door height'} — remainder (all other doors pinned or locked); open one to edit`,
        commit: () => {}, min: 1 };
    }
    // 3 mod (açık → tut → kilitli); değer yazmak ölçüyü 'tut'a alır.
    const mode = doorSizeMode(P.sizes[i]);
    const lockTitle = mode === 'locked' ? 'Locked — fixed on resize and when other doors are edited. Click: open'
      : mode === 'hold' ? 'Hold — keeps its value when other doors are edited, still scales with the door on resize. Click: lock'
      : 'Open — takes up changes from other doors and scales with the door on resize. Click: hold';
    return { key: `size-${P.id}-${i}`, kind: 'size', a, b, txt: fmt(w), title: `${horiz ? 'Door width' : 'Door height'} — click to edit (open doors take up the difference)`,
      locked: mode === 'locked', edited: mode === 'hold', lockTitle, onLock: () => onToggleLock(P.id, i), commit: v => onEditSize(P.id, i, v), preview: v => onEditSize(P.id, i, v, true), min: 1 };
  };
  const splitItems = (n: SplitS, withStrips: boolean): ChainItem[] => {
    const horiz = n.axis === 'u', dir = horiz ? 1 : -1;
    const items: ChainItem[] = [];
    let p = horiz ? n.u0 : n.v1;
    if (horiz ? touch.u0(n) : touch.v1(n)) { const k: DoorEdgeKey = horiz ? 'uMin' : 'vMax'; items.push(edgeItem(k, p - dir * eg[k], p, n)); if (withStrips) edgeStrip(n, k); }
    n.children.forEach((_c, i) => {
      const w = n.sizes[i]?.value ?? 0;
      items.push(sizeItem(n, i, p, p + dir * w, horiz));
      p += dir * w;
      if (i < n.children.length - 1) {
        const g = n.gaps[i] ?? 0;
        items.push({ key: `sgap-${n.id}-${i}`, kind: 'gap', a: p, b: p + dir * g, txt: fmt(g), title: 'Gap between doors — click to edit', commit: v => onEditSplitGap(n.id, i, v), preview: v => onEditSplitGap(n.id, i, v, true), min: 0, span: jointSpanOf(n, n.axis, p, p + dir * g) });
        if (withStrips) strip(n.axis, p, p + dir * g, horiz ? n.v0 : n.u0, horiz ? n.v1 : n.u1);
        p += dir * g;
      }
    });
    if (horiz ? touch.u1(n) : touch.v0(n)) { const k: DoorEdgeKey = horiz ? 'uMax' : 'vMin'; items.push(edgeItem(k, p, p + dir * eg[k], n)); if (withStrips) edgeStrip(n, k); }
    return items;
  };
  const placeItems = (n: DoorNodeSolved, P: SplitS, on: DoorNodeSolved): ChainItem[] => {
    const horiz = P.axis === 'u', dir = horiz ? 1 : -1;
    const idx = P.children.findIndex(c => c.id === n.id);
    if (idx < 0) return [];
    const items: ChainItem[] = [];
    const start = horiz ? n.u0 : n.v1;
    const c0 = horiz ? on.v0 : on.u0, c1 = horiz ? on.v1 : on.u1;
    if (idx > 0) { const g = P.gaps[idx - 1] ?? 0; items.push({ key: `sgap-${P.id}-${idx - 1}`, kind: 'gap', a: start - dir * g, b: start, txt: fmt(g), title: 'Gap between doors — click to edit', commit: v => onEditSplitGap(P.id, idx - 1, v), preview: v => onEditSplitGap(P.id, idx - 1, v, true), min: 0, span: jointSpanOf(P, P.axis, start - dir * g, start, on) }); strip(P.axis, start - dir * g, start, c0, c1); }
    else if (horiz ? touch.u0(n) : touch.v1(n)) { const k: DoorEdgeKey = horiz ? 'uMin' : 'vMax'; items.push(edgeItem(k, start - dir * eg[k], start, n, on)); edgeStrip(on, k); }
    const w = P.sizes[idx]?.value ?? 0;
    items.push(sizeItem(P, idx, start, start + dir * w, horiz));
    const end = start + dir * w;
    if (idx < P.children.length - 1) { const g = P.gaps[idx] ?? 0; items.push({ key: `sgap-${P.id}-${idx}`, kind: 'gap', a: end, b: end + dir * g, txt: fmt(g), title: 'Gap between doors — click to edit', commit: v => onEditSplitGap(P.id, idx, v), preview: v => onEditSplitGap(P.id, idx, v, true), min: 0, span: jointSpanOf(P, P.axis, end, end + dir * g, on) }); strip(P.axis, end, end + dir * g, c0, c1); }
    else if (horiz ? touch.u1(n) : touch.v0(n)) { const k: DoorEdgeKey = horiz ? 'uMax' : 'vMin'; items.push(edgeItem(k, end, end + dir * eg[k], n, on)); edgeStrip(on, k); }
    return items;
  };
  const fullItems = (ax: 'u' | 'v', on: DoorNodeSolved): ChainItem[] => {
    const horiz = ax === 'u', dir = horiz ? 1 : -1;
    const lo = horiz ? rect.u0 : rect.v1, k0: DoorEdgeKey = horiz ? 'uMin' : 'vMax', k1: DoorEdgeKey = horiz ? 'uMax' : 'vMin';
    const span = (horiz ? rect.u1 - rect.u0 : rect.v1 - rect.v0) - eg[k0] - eg[k1];
    if (!slopeEdges.has(k0)) edgeStrip(on, k0);
    if (!slopeEdges.has(k1)) edgeStrip(on, k1);
    return [...(slopeEdges.has(k0) ? [] : [edgeItem(k0, lo, lo + dir * eg[k0], rect, on)]),
      { key: `full-${ax}`, kind: 'size', a: lo + dir * eg[k0], b: lo + dir * (eg[k0] + span), txt: fmt(span), title: horiz ? 'Door width (whole area)' : 'Door height (whole area)', commit: () => {}, min: 1 },
      ...(slopeEdges.has(k1) ? [] : [edgeItem(k1, lo + dir * (eg[k0] + span), lo + dir * (eg[k0] + span + eg[k1]), rect, on)])];
  };
  const crossChain = (n: DoorNodeSolved, axis: 'u' | 'v', on: DoorNodeSolved) => {
    let A: DoorNodeSolved = n, B = solvedParent(A.id);
    while (B && B.axis === axis) { A = B; B = solvedParent(B.id); }
    if (B) pushChain(on, B.axis === 'u', placeItems(A, B, on));
    else pushChain(on, axis !== 'u', fullItems(axis === 'u' ? 'v' : 'u', on));
  };
  for (const n of selRegions) {
    if (n.kind === 'split') {
      pushChain(n, n.axis === 'u', splitItems(n, true));
      crossChain(n, n.axis, n);
      continue;
    }
    const P = solvedParent(n.id);
    if (P) { pushChain(n, P.axis === 'u', placeItems(n, P, n)); crossChain(P, P.axis, n); }
    else { pushChain(n, true, fullItems('u', n)); pushChain(n, false, fullItems('v', n)); }
    const lax = doorLeafAxis(n.type);
    if (lax && n.leafSplit?.leaves.length === 2) {
      const horiz = lax === 'u', dir = horiz ? 1 : -1;
      const [a, b] = n.leafSplit.leaves.map(l => Math.max(0, l.value)), g = n.leafSplit.gap;
      const p0 = horiz ? n.u0 : n.v1;
      strip(lax, p0 + dir * a, p0 + dir * (a + g), horiz ? n.v0 : n.u0, horiz ? n.v1 : n.u1);
      pushChain(n, horiz, [
        { key: `leaf-${n.id}-0`, kind: 'size', a: p0, b: p0 + dir * a, txt: fmt(a), title: 'Leaf size — click to edit (the other leaf takes the rest)', commit: v => onEditLeaf(n.id, 0, v), preview: v => onEditLeaf(n.id, 0, v, true), min: 1 },
        { key: `lgap-${n.id}`, kind: 'gap', a: p0 + dir * a, b: p0 + dir * (a + g), txt: fmt(g), title: 'Gap between the two leaves — click to edit', commit: v => onEditLeafGap(n.id, v), preview: v => onEditLeafGap(n.id, v, true), min: 0, span: jointSpanOf(n, lax, p0 + dir * a, p0 + dir * (a + g)) },
        { key: `leaf-${n.id}-1`, kind: 'size', a: p0 + dir * (a + g), b: p0 + dir * (a + g + b), txt: fmt(b), title: 'Leaf size — click to edit (the other leaf takes the rest)', commit: v => onEditLeaf(n.id, 1, v), preview: v => onEditLeaf(n.id, 1, v, true), min: 1 },
      ]);
    }
  }

  type Pill = { key: string; cx: number; cy: number; pw: number; ph: number; f: number; item: ChainItem; chain: Chain; x0: number; x1: number; hidden: boolean; lane: number; deg?: number; lock?: { x: number; y: number } };
  // Çakışma önlemi: zincir başına şeritler (kademeli ölçü). Önce ÖLÇÜ pill'leri, sonra serbest BOŞLUK pill'leri ilk boş şeride
  // girer (sığmazsa son şerit — hiçbir boşluk gizlenmez). Şeritler bölgenin içine doğru (yatay → yukarı, düşey → sola).
  type Placed = { start: number; end: number };
  // Eğik kenar boşluk pill'i: yalnız SEÇİLİ kapakların en uzun eğik kenarının ortasında, kenar yönünde döndürülmüş.
  const selSlopeSegs = slopeSegs.flatMap(sg0 => {
    let best: typeof sg0 | null = null;
    for (const m of members) {
      if (!m.poly || !selLeafIds.has(m.leafId)) continue;
      for (let i = 0; i < m.poly.length; i++) {
        const a = m.poly[i], b = m.poly[(i + 1) % m.poly.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1 || Math.abs((b.x - a.x) * sg0.cb.dir.y - (b.y - a.y) * sg0.cb.dir.x) / len > 0.01) continue;
        if (!best || len > best.len) best = { ...sg0, a, b, len, m };
      }
    }
    return best ? [best] : [];
  });
  const slopePills: Pill[] = selSlopeSegs.map(sg => {
    const a = { x: sx(sg.a.x), y: sy(sg.a.y) }, b = { x: sx(sg.b.x), y: sy(sg.b.y) };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, tx = (b.x - a.x) / L, ty = (b.y - a.y) / L;
    const poly = sg.m.poly!, cxm = poly.reduce((s0, q) => s0 + sx(q.x), 0) / poly.length, cym = poly.reduce((s0, q) => s0 + sy(q.y), 0) / poly.length;
    let nx = -ty, ny = tx;
    if (nx * (cxm - mid.x) + ny * (cym - mid.y) < 0) { nx = -nx; ny = -ny; }
    const txt = fmt(eg[sg.edge]);
    const { pw, ph } = pillSize(txt, fs);
    const off = -(eg[sg.edge] * SH / dvR) / 2;   // kenar çizgisinden dışa yarım boşluk = boşluğun ortası
    let deg = Math.atan2(ty, tx) * 180 / Math.PI; while (deg > 90) deg -= 180; while (deg < -90) deg += 180;
    const item: ChainItem = { key: `slope-${sg.cb.cut.vfId}`, kind: 'gap', a: 0, b: 0, txt,
      title: `Gap to the angled panel ${sg.cb.cut.name} — click to edit (the door keeps this distance along the slope)`,
      commit: v => onEditEdgeGap(sg.edge, v), preview: v => onEditEdgeGap(sg.edge, v, true), min: 0 };
    return { key: item.key, cx: mid.x + nx * off, cy: mid.y + ny * off, pw, ph, f: fs, item, chain: { horiz: true, pos: 0, items: [item] }, x0: mid.x, x1: mid.x, hidden: false, lane: 0, deg };
  });
  // Sabit boşluk pill'leri (kenar/derz ortasında) önce; ölçüler bunlara 2B'de çarpmayan şeridi seçer.
  const chainPills = chains.map(ch => ({ ch, all: ch.items.map(it => {
    const f = fs;
    const { pw, ph } = pillSize(it.txt, f);
    const m0 = ch.horiz ? sx(it.a) : sy(it.a), m1 = ch.horiz ? sx(it.b) : sy(it.b);
    const mid = (m0 + m1) / 2;
    const sc = it.kind === 'gap' && it.span ? (ch.horiz ? sy((it.span[0] + it.span[1]) / 2) : sx((it.span[0] + it.span[1]) / 2)) : null;
    return { key: it.key, cx: ch.horiz ? mid : (sc ?? ch.pos), cy: ch.horiz ? (sc ?? ch.pos) : mid, pw, ph, f, item: it, chain: ch, x0: Math.min(m0, m1), x1: Math.max(m0, m1), hidden: false, lane: 0, fixed: sc != null } as Pill & { fixed: boolean };
  }) }));
  const fixedAll: Pill[] = [...chainPills.flatMap(c => c.all.filter(p => p.fixed)), ...slopePills];
  const boxHit = (x: number, y: number, w: number, h: number, q: Pill) => Math.abs(x - q.cx) < (w + q.pw) / 2 + 2 && Math.abs(y - q.cy) < (h + q.ph) / 2 + 2;
  const pills: Pill[] = chainPills.flatMap(({ ch, all }) => {
    const fixedPills = all.filter(p => p.fixed);
    const base = all.filter(p => !p.fixed).sort((a, b) => (ch.horiz ? a.cx - b.cx : a.cy - b.cy));
    const maxLanes = 3, sizeLanes = [0, 1, 2, 3, 4];   // dar kapakta ölçü, boşluk kutucuklarından kaçmak için 5 şeride kadar çıkar
    const lanes: Placed[][] = Array.from({ length: sizeLanes.length }, () => []);
    const posOf = (p: typeof base[number]) => (ch.horiz ? p.cx : p.cy);
    const spanOf = (p: typeof base[number]): Placed => {
      const half = (ch.horiz ? p.pw : p.ph) / 2 + 1;
      return { start: posOf(p) - half, end: posOf(p) + half + (p.item.onLock ? LOCK_EXT : 0) };
    };
    const fits = (lane: number, start: number, end: number) => lanes[lane].every(q => end <= q.start || start >= q.end);
    const laneStep = Math.max(...base.map(p => (ch.horiz ? p.ph : p.pw)), 0) + PILL_LANE_GAP;
    const clear2D = (p: typeof base[number], lane: number) => {
      const x = ch.horiz ? p.cx : p.cx - lane * laneStep, y = ch.horiz ? p.cy - lane * laneStep : p.cy;
      if (fixedAll.some(q => boxHit(x, y, p.pw, p.ph, q))) return false;
      if (!p.item.onLock) return true;
      const lx = ch.horiz ? x + p.pw / 2 + LOCK_OFF : x, ly = ch.horiz ? y : y + p.ph / 2 + LOCK_OFF;
      return !fixedAll.some(q => boxHit(lx, ly, 2 * LOCK_R, 2 * LOCK_R, q));
    };
    const place = (p: typeof base[number], lane: number) => {
      p.lane = lane; lanes[lane].push(spanOf(p));
      if (lane > 0) { if (ch.horiz) p.cy -= lane * laneStep; else p.cx -= lane * laneStep; }
    };
    for (const p of base.filter(x => x.item.kind === 'size')) {
      const { start: st0, end: en0 } = spanOf(p);
      // Hiçbir şerit uymazsa 0. şerit: ölçü hep çizilir.
      const lane = sizeLanes.find(l => fits(l, st0, en0) && clear2D(p, l)) ?? (fits(0, st0, en0) ? 0 : fits(1, st0, en0) ? 1 : 0);
      place(p, lane);
    }
    for (const p of base.filter(x => x.item.kind === 'gap')) {
      const { start: st0, end: en0 } = spanOf(p);
      let lane = maxLanes - 1;
      for (let l = 0; l < maxLanes; l++) if (fits(l, st0, en0)) { lane = l; break; }
      place(p, lane);
    }
    return [...base, ...fixedPills];
  });
  pills.push(...slopePills);
  // Kilit yeri: ölçünün ucu; çarpıyorsa karşı uç, sonra pill'in yanları — kilitler pill'lere ve birbirine binmesin.
  {
    const placedLocks: Array<{ x: number; y: number }> = [];
    const clearOf = (x: number, y: number, self: Pill) =>
      x >= LOCK_R + 1 && x <= width - LOCK_R - 1 && y >= LOCK_R + 1 && y <= height - LOCK_R - 1 &&
      pills.every(q => q === self || Math.abs(x - q.cx) >= q.pw / 2 + LOCK_R + 2 || Math.abs(y - q.cy) >= q.ph / 2 + LOCK_R + 2) &&
      placedLocks.every(l => Math.hypot(l.x - x, l.y - y) >= 2 * LOCK_R + 3);
    for (const p of pills) {
      if (!p.item.onLock) continue;
      const d = (p.chain.horiz ? p.pw : p.ph) / 2 + LOCK_OFF;
      const e = (p.chain.horiz ? p.ph : p.pw) / 2 + LOCK_OFF;
      const cand = p.chain.horiz ? [{ x: p.cx + d, y: p.cy }, { x: p.cx - d, y: p.cy }, { x: p.cx, y: p.cy + e }, { x: p.cx, y: p.cy - e }]
        : [{ x: p.cx, y: p.cy + d }, { x: p.cx, y: p.cy - d }, { x: p.cx + e, y: p.cy }, { x: p.cx - e, y: p.cy }];
      p.lock = cand.find(c => clearOf(c.x, c.y, p)) ?? cand[0];
      placedLocks.push(p.lock);
    }
  }
  const pillByKey = new Map(pills.map(p => [p.key, p]));
  const editPos = editing ? pillByKey.get(editing.key) : undefined;
  // Bant rozeti pill/kilide çarpıyorsa bant boyunca (dönüşümlü) kaydırılır, bandın içinde kalır.
  const obstacles = pills.flatMap(p => {
    const o = [{ x: p.cx, y: p.cy, r: Math.max(p.pw, p.ph) / 2 }];
    if (p.lock) o.push({ ...p.lock, r: LOCK_R });
    return o;
  });
  // Parça etiket bloğu (no · ölçü · tür) da engel: "Split here" gibi bant rozetleri etiketin üstüne binmesin.
  for (const m of members) obstacles.push({ x: (sx(m.u0) + sx(m.u1)) / 2, y: (sy(m.v0) + sy(m.v1)) / 2, r: fsT * 2.6 });
  const chipSpot = (cx: number, cy: number, ux: number, uy: number, half: number, cw: number) => {
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

  return (
    <div ref={wrapRef} className={PREVIEW_FRAME} style={{ background: PREVIEW_BG, height }}>
      <style>{SCHEMATIC_CSS}</style>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', fontFamily: UI_FONT }}>
        <defs>
          <linearGradient id={`${gid}-door`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SOFT.part0} /><stop offset="1" stopColor={SOFT.part1} /></linearGradient>
          <linearGradient id={`${gid}-door-on`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SOFT.on0} /><stop offset="1" stopColor={SOFT.on1} /></linearGradient>
          <linearGradient id={`${gid}-door-sel`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SOFT.sel0} /><stop offset="1" stopColor={SOFT.sel1} /></linearGradient>
          <pattern id={`${gid}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#bfb5a6" strokeWidth="0.7" /></pattern>
          <pattern id={`${gid}-hatch-on`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#e8925a" strokeWidth="0.9" /></pattern>
        </defs>
        <rect x={ox} y={oy} width={SW} height={SH} rx={3} fill={SOFT.area} stroke={SOFT.areaStroke} strokeWidth={0.8} />
        {bands.map(b => {
          const warm = b.half || b.aligned;
          return (
            <g key={`band-${b.np.vfId}`} style={{ pointerEvents: 'none' }}>
              <path d={ptsPath(b.pts)} fill={warm ? '#f9dcc4' : '#ddd4c6'} />
              <path d={ptsPath(b.pts)} fill={warm ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} />
              <path d={ptsPath(b.pts)} fill="none" stroke={warm ? '#e07b3c' : '#a39a8d'} strokeWidth={1} strokeLinejoin="round" />
            </g>
          );
        })}
        {cutBands.map(cb => {
          const d = ptsPath(cb.pts);
          return (
            <g key={`cut-${cb.cut.vfId}`} style={{ pointerEvents: 'none' }}>
              <path d={d} fill={cb.half ? '#f9dcc4' : '#ddd4c6'} />
              <path d={d} fill={cb.half ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} />
              <path d={d} fill="none" stroke={cb.half ? '#e07b3c' : '#a39a8d'} strokeWidth={1} strokeLinejoin="round" />
            </g>
          );
        })}
        {members.map((m, i) => {
          const on = i === selectedIndex;
          const inSel = selLeafIds.has(m.leafId);
          const x0 = Math.min(sx(m.u0), sx(m.u1)) + I, x1 = Math.max(sx(m.u0), sx(m.u1)) - I, y0 = Math.min(sy(m.v1), sy(m.v0)) + I, y1 = Math.max(sy(m.v1), sy(m.v0)) - I;
          const lbl = memberLabels[i] ?? String(i + 1);
          const fill = on ? `url(#${gid}-door-on)` : inSel ? `url(#${gid}-door-sel)` : `url(#${gid}-door)`;
          const stroke = on ? SOFT.onStroke : inSel ? SOFT.selStroke : SOFT.partStroke;
          // Double'da menteşe EKRANA göre: solda duran kanat sol menteşe (aynalı görünüşte de doğru).
          let hinge: Hinge | undefined = leafHinges(m.type)[0];
          if (m.leafCount === 2 && doorLeafAxis(m.type) === 'u') { const sib = members[m.leaf === 0 ? i + 1 : i - 1]; hinge = sib && Math.min(sx(sib.u0), sx(sib.u1)) < x0 ? 'R' : 'L'; }
          else if (m.leafCount === 2) hinge = 'T';
          const typeTxt = DOOR_TYPE_LABEL[m.type] + (m.leafCount === 2 ? ` · leaf ${m.leaf + 1}/2` : '');
          const path = pathToLeaf(m.leafId);
          const wMm = Math.round(m.u1 - m.u0), hMm = Math.round(m.v1 - m.v0);
          const lhGuard = fsT * 1.18;
          const tip = `${noun} ${lbl} · ${typeTxt} · ${wMm} × ${hMm} mm${m.poly ? ' · angled (cut by rotated reference)' : ''}`
            + ` — click: select the area, click again to go one level deeper (${path.length} level${path.length === 1 ? '' : 's'}) · Shift/Ctrl+click: add another region · open the ${noun.toLowerCase()}'s row below to edit it`;
          // Her köşe aynı kapak hücresinde kaldığından eğik kenar parça-doğrusal haritada da düz çizgidir.
          const pts = m.poly ? m.poly.map(q => ({ x: sx(q.x), y: sy(q.y) })) : null;
          const cx = pts ? pts.reduce((a, q) => a + q.x, 0) / pts.length : (x0 + x1) / 2;
          const cy = pts ? pts.reduce((a, q) => a + q.y, 0) / pts.length : (y0 + y1) / 2;
          const w = x1 - x0, h = y1 - y0;
          const ins = 5, sw = !!hinge && w > 2 * ins + 6 && h > 2 * ins + 6;
          const fsz = fsT * 0.86;
          // Zincir pill'i yazı alanına biniyorsa W×H gizlenir (zincir zaten söyler).
          const capW = `${wMm} × ${hMm}`.length * fsz * 0.6 + 6, capH = fsz * 1.2;
          const capHit = pills.some(pp => Math.abs(pp.cx - cx) < (pp.pw + capW) / 2 && Math.abs(pp.cy - cy) < (pp.ph + capH) / 2 + lhGuard);
          const showSize = w > 58 && h > 34 && !capHit;
          const caption = m.type === 'drawer' || m.type === 'fixed' ? DOOR_TYPE_LABEL[m.type] : null;
          const showCap = !!caption && showSize && h > 50;
          const lines = 1 + (showSize ? 1 : 0) + (showCap ? 1 : 0);
          const lh = fsT * 1.18;
          const ty0 = capHit ? cy - lhGuard : cy - ((lines - 1) * lh) / 2;
          return (
            <g key={`door-${i}`} style={{ cursor: 'pointer' }} onClick={e => { stop(e); onPathClick(path, e.shiftKey || e.ctrlKey || e.metaKey); }}>
              {pts ? (
                <polygon points={pts.map(q => `${q.x},${q.y}`).join(' ')} fill={fill} stroke={stroke} strokeWidth={on ? 1.2 : 0.9} strokeLinejoin="round"><title>{tip}</title></polygon>
              ) : (
                <rect x={x0} y={y0} width={Math.max(1, w)} height={Math.max(1, h)} rx={2.5} fill={fill} stroke={stroke} strokeWidth={on ? 1.2 : 0.8} style={{ filter: SOFT.shadow }}><title>{tip}</title></rect>
              )}
              {!pts && w > 6 && h > 6 && <rect x={x0 + 1} y={y0 + 1} width={Math.max(0, w - 2)} height={Math.max(0, h - 2)} rx={1.5} fill="none" stroke="#ffffff" strokeOpacity={0.55} strokeWidth={0.8} style={{ pointerEvents: 'none' }} />}
              {sw && <path d={(pts && swingPathPoly(pts, hinge!, ins)) || swingPath(x0 + ins, y0 + ins, x1 - ins, y1 - ins, hinge!)} fill="none" stroke={on ? '#f3b98e' : '#d6cfc4'} strokeWidth={0.7} strokeDasharray="3 3" strokeLinejoin="round" strokeLinecap="round" style={{ pointerEvents: 'none' }} />}
              <text x={cx} y={ty0 + fsT * 0.36} textAnchor="middle" fontSize={fsT} fontWeight={on ? 700 : 650} fill={on ? '#ea580c' : '#8f877c'}
                fontFamily={UI_FONT} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', userSelect: 'none' }}>{lbl}</text>
              {showSize && (
                <text x={cx} y={ty0 + lh + fsz * 0.36} textAnchor="middle" fontSize={fsz} fontWeight={500} fill={on ? '#c2410c' : '#a39b90'}
                  fontFamily={UI_FONT} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', userSelect: 'none' }}>{wMm} × {hMm}</text>
              )}
              {showCap && (
                <text x={cx} y={ty0 + 2 * lh + fsz * 0.36} textAnchor="middle" fontSize={fsz * 0.92} fontWeight={600} fill="#b5ada3" letterSpacing="0.06em"
                  fontFamily={UI_FONT} style={{ textTransform: 'uppercase', pointerEvents: 'none', userSelect: 'none' }}>{caption!.toUpperCase()}</text>
              )}
            </g>
          );
        })}
        {cutBands.flatMap(cb => members.flatMap((m, mi) => {
          const dx0 = Math.min(sx(m.u0), sx(m.u1)) + I, dx1 = Math.max(sx(m.u0), sx(m.u1)) - I, dy0 = Math.min(sy(m.v1), sy(m.v0)) + I, dy1 = Math.max(sy(m.v1), sy(m.v0)) - I;
          if (dx1 - dx0 < 0.5 || dy1 - dy0 < 0.5) return [];
          const part = clipPolyToConvex(cb.pts, [{ x: dx0, y: dy0 }, { x: dx1, y: dy0 }, { x: dx1, y: dy1 }, { x: dx0, y: dy1 }]);
          if (part.length < 3 || Math.abs(polyArea(part)) < 0.5) return [];
          return [(
            <g key={`cuthid-${cb.cut.vfId}-${mi}`} style={{ pointerEvents: 'none' }}>
              <path d={ptsPath(part)} fill={cb.half ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} opacity={0.4} />
              <path d={ptsPath(part)} fill="none" stroke={cb.half ? '#e8925a' : '#9a9185'} strokeWidth={0.8} strokeDasharray="3 2" opacity={0.9} strokeLinejoin="round" />
            </g>
          )];
        }))}
        {bands.flatMap(b => hiddenParts(b).map((hp, k) => (
          <g key={`hid-${b.np.vfId}-${k}`} style={{ pointerEvents: 'none' }}>
            <path d={ptsPath(hp)} fill={b.half || b.aligned ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} opacity={0.4} />
            <path d={ptsPath(hp)} fill="none" stroke={b.half || b.aligned ? '#e8925a' : '#9a9185'} strokeWidth={0.8} strokeDasharray="3 2" opacity={0.9} strokeLinejoin="round" />
          </g>
        )))}
        {focusStrips.map((r, i) => {
          const sp = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
          const cl = stripClip ? clipPolyToConvex(sp, stripClip) : sp;
          return cl.length >= 3 ? <path key={`fs-${i}`} d={ptsPath(cl)} fill="#f97316" fillOpacity={0.28} stroke="#ea580c" strokeOpacity={0.55} strokeWidth={0.6} style={{ pointerEvents: 'none' }} /> : null;
        })}
        {addPick && isOuter && doorJointParts(doorJoints(solved), addObstacles ?? nearPanels, addPick).flatMap(({ joint: j, all: segs, free }) => {
          const vertical = j.axis === 'u';
          // Araya raf/dikme: derz, onu kesen levhalarla parçalara bölünür; yalnız BOŞ parçalar rozet alır, her parça ayrı grup olur.
          const allMids = free.map(([c0, c1]) => (c0 + c1) / 2);
          return free.map(([c0, c1]) => {
            const mid = (c0 + c1) / 2;
            const MINW = 14;
            let a0 = vertical ? Math.min(sx(j.p0), sx(j.p1)) : Math.min(sy(j.p0), sy(j.p1)), a1 = vertical ? Math.max(sx(j.p0), sx(j.p1)) : Math.max(sy(j.p0), sy(j.p1));
            if (a1 - a0 < MINW) { const c = (a0 + a1) / 2; a0 = c - MINW / 2; a1 = c + MINW / 2; }
            const q0 = vertical ? Math.min(sy(c0), sy(c1)) : Math.min(sx(c0), sx(c1)), q1 = vertical ? Math.max(sy(c0), sy(c1)) : Math.max(sx(c0), sx(c1));
            const x = vertical ? a0 : q0, y = vertical ? q0 : a0, w = vertical ? a1 - a0 : q1 - q0, h = vertical ? q1 - q0 : a1 - a0;
            const txt = vertical ? '+ Divider' : '+ Shelf';
            const cfs = chipFs(fsT), { pw: cw, ph: chh } = pillSize(txt, cfs);
            const bx = x + w / 2, by = y + h / 2;
            const what = vertical ? 'divider' : 'shelf';
            return (
              <g key={`add-${j.splitId}-${j.k}-${Math.round(c0)}`} className="yago-band on" style={{ cursor: 'pointer' }} onClick={e => { stop(e); onAddPick?.(j.splitId, j.k, e.shiftKey || e.ctrlKey || e.metaKey ? allMids : [mid]); }}>
                <rect x={x} y={y} width={w} height={h} rx={3} fill="#fb923c" fillOpacity={0.16} stroke="#f97316" strokeWidth={1} strokeDasharray="4 2.5" className="hit" />
                <g className="chip" transform={vertical ? `rotate(-90 ${bx} ${by})` : undefined}>
                  <rect x={bx - cw / 2} y={by - chh / 2} width={cw} height={chh} rx={chh / 2} fill={CHIP.accent.fill} stroke={CHIP.accent.stroke} strokeWidth={0.9} style={{ filter: CHIP_SHADOW }} />
                  <text x={bx} y={by + cfs * 0.36} textAnchor="middle" fontSize={cfs} fontWeight={700} letterSpacing="0.02em" fill="#c2410c" fontFamily={UI_FONT}>{txt}</text>
                </g>
                <title>{`Add a ${what} between these two doors${segs.length > 1 ? ` (this part of the joint, ${round1(c1 - c0)} mm)` : ''}: it is created in the free volume behind this spot (listed after the door row) and stays bound to the joint — when the doors change, the ${what} follows.${allMids.length > 1 ? ` Shift+click: a ${what} in every free part of this joint (${allMids.length}).` : ''} It starts at Half overlay (both doors reach its middle); select a door next to it to switch that door to Full.`}</title>
              </g>
            );
          });
        })}
        {selRegions.map(n => {
          const b = nodeBox(n);
          const pad = n.kind === 'split' ? 2.5 : 0.5;
          const shape = cuts.length ? doorCutOutline(group, rect, n, cuts) : null;
          if (shape && Math.abs(polyArea(shape)) < (n.u1 - n.u0) * (n.v1 - n.v0) - 1) {
            return (
              <g key={`sel-${n.id}`} style={{ pointerEvents: 'none' }}>
                <path d={ptsPath(shape.map(q => ({ x: sx(q.x), y: sy(q.y) })))} fill="#ea580c" fillOpacity={n.kind === 'split' ? 0.05 : 0.0} stroke="#ea580c" strokeWidth={1.2} strokeLinejoin="round" strokeDasharray={n.kind === 'split' ? '5 3' : undefined} />
              </g>
            );
          }
          return (
            <g key={`sel-${n.id}`} style={{ pointerEvents: 'none' }}>
              <rect x={b.x0 - pad} y={b.y0 - pad} width={b.x1 - b.x0 + 2 * pad} height={b.y1 - b.y0 + 2 * pad} rx={3} fill="#ea580c" fillOpacity={n.kind === 'split' ? 0.05 : 0.0} stroke="#ea580c" strokeWidth={1.2} strokeDasharray={n.kind === 'split' ? '5 3' : undefined} />
            </g>
          );
        })}
        {/* Bant tık alanları bilinçli olarak seçim çerçevesi/şeritlerin ÜSTÜNDE, pill'lerin ALTINDA çizilir. */}
        {bands.map(b => {
          const np = b.np;
          const pickable = !!refPick && !np.edge;
          const rem = removable(np);
          const jChip = !np.edge ? jointChip(b) : null;
          const ctx = !np.edge ? overlayCtx(np) : null;
          const splitOn = splitChipOn(np);
          const ctxOn = !!ctx || splitOn;   // bölünmemiş levha da kapak binisi rozetidir (turuncu)
          const interactive = isOuter && (rem || pickable || (!!np.edge && np.behind) || ctxOn || !!np.joint);
          // Levha-taşıma modu (kapak seçili değil): rozet petrol tonunda — turuncu = kapak değişir, petrol = levha kayar.
          const moveMode = !np.edge && !!np.joint && !ctxOn && !rem && !pickable;
          const moveOn = moveMode && jChip === 'Half';
          const chipTxt = rem ? '✕ Remove' : pickable ? 'Split here' : np.edge ? (np.behind ? (b.none ? 'None' : b.half ? 'Half' : 'Full') : null) : splitOn ? 'Full' : jChip;
          const on = np.edge ? b.half : jChip === 'Half';
          const cfs = chipFs(fsT);
          // Kapak seçiliyken (ctx) tek rozet: tık Full → Half → None arasında döner (onBandClick).
          const { pw: cw, ph: chh } = chipTxt ? pillSize(chipTxt, cfs) : { pw: 0, ph: 0 };
          const spot = chipTxt ? chipSpot(b.x + b.w / 2, b.y + b.h / 2, b.vertical ? 0 : 1, b.vertical ? 1 : 0, (b.vertical ? b.h : b.w) / 2, cw) : null;
          const bx = spot?.x ?? b.x + b.w / 2, by = spot?.y ?? b.y + b.h / 2;
          const warm = b.half || b.aligned;
          // Rozet dili arkalıkla aynı (CHIP): rozet HER ZAMAN görünür; Half / taşıma-Half = koyu taş, kapak seçiliyken turuncu çerçeve.
          const tone = rem ? CHIP.danger : on || moveOn ? CHIP.on : pickable || ctxOn ? CHIP.accent : CHIP.base;
          return (
            <g key={`hit-${np.vfId}`} className={`yago-band pnl${chipTxt ? ' on' : ''}`} style={{ cursor: interactive ? 'pointer' : 'default' }}
              onClick={interactive ? e => { stop(e); onBandClick(b, e.shiftKey || e.ctrlKey || e.metaKey); } : undefined}>
              {b.np.poly
                ? <path d={ptsPath(b.pts)} fill="transparent" stroke="transparent" strokeWidth={4} strokeLinejoin="round" className="hit" />
                : <rect x={b.x - 2} y={b.y - 2} width={b.w + 4} height={b.h + 4} fill="transparent" className="hit" />}
              <g className="hov">
                <path d={ptsPath(b.pts)} fill={warm ? '#f6c39c' : '#cbbca6'} fillOpacity={0.92} />
                <path d={ptsPath(b.pts)} fill={warm ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} />
                <path d={ptsPath(b.pts)} fill="none" stroke={warm ? '#c2410c' : '#6f6457'} strokeWidth={1.3} strokeLinejoin="round" />
              </g>
              {chipTxt && (
                <g className="chip" transform={b.vertical ? `rotate(-90 ${bx} ${by})` : undefined}>
                  <rect x={bx - cw / 2} y={by - chh / 2} width={cw} height={chh} rx={chh / 2} fill={tone.fill} stroke={tone.stroke} strokeWidth={0.9} style={{ filter: CHIP_SHADOW }} />
                  <text x={bx} y={by + cfs * 0.36} textAnchor="middle" fontSize={cfs} fontWeight={700} letterSpacing="0.02em" fill={tone.text} fontFamily={UI_FONT}>{chipTxt}</text>
                </g>
              )}
              <title>{bandTip(b)}</title>
            </g>
          );
        })}
        {/* Açılı levhanın Full/Half bayrağı, kesilen kenarın halfOverlay bayrağıdır. */}
        {cutBands.map(cb => {
          const interactive = isOuter && cb.covered && !!cb.edge;
          const chipTxt = interactive ? (cb.half ? 'Half' : 'Full') : null;
          const cfs = chipFs(fsT);
          const { pw: cw, ph: chh } = chipTxt ? pillSize(chipTxt, cfs) : { pw: 0, ph: 0 };
          const d = ptsPath(cb.pts);
          const rad = cb.deg * Math.PI / 180;
          const ext = Math.max(...cb.pts.map(q => Math.abs((q.x - cb.cx) * Math.cos(rad) + (q.y - cb.cy) * Math.sin(rad))));
          const spot = chipTxt ? chipSpot(cb.cx, cb.cy, Math.cos(rad), Math.sin(rad), ext, cw) : { x: cb.cx, y: cb.cy };
          const tip = `${cb.cut.name} — angled door reference panel: the door is cut along it (it keeps the side you clicked when placing the door).` +
            (interactive ? ` ${cb.half ? 'HALF overlay — the door reaches the middle of this panel\'s thickness. Click for full overlay.' : 'FULL overlay — the door covers this panel\'s whole thickness. Click for half overlay.'}` : cb.covered ? '' : ' It stands in front of the door plane, so there is no overlay to set.');
          return (
            <g key={`cuthit-${cb.cut.vfId}`} className={`yago-band pnl${chipTxt ? " on" : ""}`} style={{ cursor: interactive ? 'pointer' : 'default' }}
              onClick={interactive ? e => { stop(e); onToggleHalfOverlay(cb.edge!, !cb.half); } : undefined}>
              <path d={d} fill="transparent" stroke="transparent" strokeWidth={4} strokeLinejoin="round" className="hit" />
              <g className="hov">
                <path d={d} fill={cb.half ? '#f6c39c' : '#cbbca6'} fillOpacity={0.92} />
                <path d={d} fill={cb.half ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} />
                <path d={d} fill="none" stroke={cb.half ? '#c2410c' : '#6f6457'} strokeWidth={1.3} strokeLinejoin="round" />
              </g>
              {chipTxt && (
                <g className="chip" transform={`rotate(${cb.deg.toFixed(1)} ${spot.x} ${spot.y})`}>
                  <rect x={spot.x - cw / 2} y={spot.y - chh / 2} width={cw} height={chh} rx={chh / 2} fill={(cb.half ? CHIP.on : CHIP.base).fill} stroke={(cb.half ? CHIP.on : CHIP.base).stroke} strokeWidth={0.9}
                    style={{ filter: CHIP_SHADOW }} />
                  <text x={spot.x} y={spot.y + cfs * 0.36} textAnchor="middle" fontSize={cfs} fontWeight={700} letterSpacing="0.02em" fill={(cb.half ? CHIP.on : CHIP.base).text} fontFamily={UI_FONT}>{chipTxt}</text>
                </g>
              )}
              <title>{tip}</title>
            </g>
          );
        })}
        {pills.map(p => {
          const { item: it, f } = p;
          const hide = editing?.key === p.key;
          if (it.kind === 'gap') {
            const gp = <DimPill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} fill="#fff7ed" stroke="#f97316" strokeWidth={1} color="#c2410c" hideText={hide} title={it.title}
              onClick={e => { stop(e); beginEdit({ key: p.key, v: it.txt }); }} />;
            return p.deg ? <g key={p.key} transform={`rotate(${p.deg.toFixed(1)} ${p.cx} ${p.cy})`}>{gp}</g> : <g key={p.key}>{gp}</g>;
          }
          if (it.passive) {
            return (
              <g key={p.key} className="yago-gap passive" style={{ cursor: 'not-allowed' }}>
                <DimPill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} fill="#f5f3ef" stroke="#d6cfc3" strokeWidth={0.9} color="#a8a29e" hideText={false} title={it.title} />
              </g>
            );
          }
          const locked = !!it.locked, edited = !locked && !!it.edited, editable = !!it.onLock || it.key.startsWith('leaf-');
          return (
            <g key={p.key} className={`yago-gap${locked ? ' locked' : ''}`}>
              <DimPill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} fill={locked || edited ? '#fff7ed' : '#ffffff'} stroke={edited ? '#fbbf24' : '#f97316'} strokeWidth={locked ? 1.2 : 1}
                color={locked ? '#c2410c' : edited ? '#9a3412' : '#1c1917'} hideText={hide} title={editable ? (edited ? `${it.title} (${it.lockTitle ? "held" : "entered"} value)` : it.title) : `${it.title} — set by the door bounds`}
                onClick={editable ? e => { stop(e); beginEdit({ key: p.key, v: it.txt }); } : undefined} />
              {it.onLock && p.lock && <LockBadge cx={p.lock.x} cy={p.lock.y} locked={locked} edited={edited} onClick={it.onLock} title={it.lockTitle} holdIcon={!!it.lockTitle} />}
            </g>
          );
        })}
      </svg>
      {editing && editPos && (
        <input autoFocus type="text" inputMode="decimal" value={editing.v}
          onChange={e => { setEditing({ ...editing, v: e.target.value }); previewEdit(editing.key, e.target.value); }}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancelEdit(); }}
          onClick={stop}
          style={{
            position: 'absolute', left: editPos.cx - editPos.pw / 2 - 4, top: editPos.cy - editPos.ph / 2 - 2, width: editPos.pw + 8, height: editPos.ph + 4, textAlign: 'center',
            fontFamily: UI_FONT, fontSize: editPos.f, fontWeight: 600, color: '#1c1917', fontVariantNumeric: 'tabular-nums',
            background: '#fff', border: '1px solid #f97316', borderRadius: 99, outline: 'none', boxShadow: '0 0 0 2px rgba(249,115,22,0.12)', padding: 0,
          }} />
      )}
    </div>
  );
}

// Arkalık şemasının kenar payı: en dış sınır levhaları (yan / üst / alt) iç dikdörtgenin DIŞINDA, bu payda çizilir; ilişki ve değer
// rozetleri levhanın üzerinde durur → pay levha + rozet kalınlığını almalı (kapak payı 12 px ile rozetler SVG dışına taşıp kırpılıyordu).
const BACK_PAD_L = 22, BACK_PAD_T = 22, BACK_PAD_R = 22, BACK_PAD_B = 22;
/** Arkalık kartı kanal bloğu: 4 eşit satır (satır yüksekliği BACK_ROW_H) — diyagram yüksekliği bloğun tamamı. */
const BACK_ROW_H = 28, BACK_ROW_GAP = 4, BACK_BLOCK_H = 4 * BACK_ROW_H + 3 * BACK_ROW_GAP;
/** Kesit diyagramı viewBox'ı: blok yüksekliğinde, GENİŞ (en-boy ≈ 1.8) — hücreler dar, diyagram geniş. */
const BACK_DIAGRAM_W = 224, BACK_DIAGRAM_H = BACK_BLOCK_H;
/** ARKALIK ŞEMASI: ön görünüş (arkadan bakış aynalı), parçalar + sınır levhası bantları (çakma parçada bini, kanallı parçada kanal girişi),
 *  açılı levha şeritleri, derz rozetleri ve seçili bölgenin ölçü zincirleri. Değerler PARÇA BAŞINA: kenar rozeti / pill'i seçili
 *  parçalara (seçim yoksa o kenara değen tüm parçalara) yazar; karışık değer "…" / "Mixed" gösterir. */
function BackSchematic({ group, solution, selectedIndex, selectedNodes, memberLabels, cuts, nearPanels, refPick, onEditSize, onToggleLock, onEditSplitGap, onEditInset, onEditJointIn, onPathClick, onRefPick, onSplitAtPanel, onEditCover, onToggleEdgeRel, onToggleJointRel, clearVfId, onPickClearEdge, grooveHint, onEditBegin, onEditCancel }: {
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  const [editing, setEditing] = useState<DoorEdit | null>(null);
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(es => { const w = es[0].contentRect.width; if (w > 0) setWidth(Math.round(w)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Giriş kutusu ağaç değişince KAPANMAMALI (canlı önizleme ağacı her tuşta yazar) — yalnız grup/seçim değişince kapanır.
  const selKey = selectedNodes.join('|');
  useEffect(() => { setEditing(null); }, [group.id, selectedIndex >= 0, selKey]);
  const snapRef = useRef<unknown>(undefined);
  const cancelledRef = useRef(false);
  const beginEdit = (e: DoorEdit) => { snapRef.current = onEditBegin?.(); cancelledRef.current = false; setEditing(e); };
  const cancelEdit = () => { cancelledRef.current = true; onEditCancel?.(snapRef.current); setEditing(null); };

  const { axis, side } = group;
  const { rect, solved, members, sides } = solution;   // rect = İÇ dikdörtgen (sınır panellerinin iç yüzleri); parçalar kendi uzantılarıyla dışına taşar
  // TEMSİLİ KARE (Goker, Eki 2026 — "preview tam kare olsun, arkalık o alanı maksimum göstersin, ölçüye göre dinamik değil temsili"):
  // şema kare (yükseklik = genişlik), arkalık dikdörtgeni her zaman aynı temsili alana GERİLİR (oran korunmaz) — kenar bantları
  // ve rozetler dar kenar payında kalır.
  const SW = Math.max(40, width - BACK_PAD_L - BACK_PAD_R), SH = SW;
  const duR = Math.max(1e-6, rect.u1 - rect.u0), dvR = Math.max(1e-6, rect.v1 - rect.v0);
  const height = SH + BACK_PAD_T + BACK_PAD_B;
  const ox = BACK_PAD_L, oy = BACK_PAD_T;
  // Görünüş: arkalık ÖNDEN çizilir (gövdenin içine bakar gibi) — 3B ön görünüşle aynı sol/sağ (Goker: arkadan aynalı görünüş
  // ters geliyordu, soldaki parçayı düzeltirken sağdaki değişiyordu). Sağ yan (X+) aynalı; üst (Y+) → Z aşağı.
  const mirrorU = axis === 0 && side > 0;
  const mirrorV = axis === 1 && side > 0;
  // PARÇA BAŞINA değerler: üye dikdörtgeni kendi `piece`'ini taşır (tip / setback / inset / bini).
  const T0 = 0.05;
  const allLeafIds = members.map(m => m.leafId);
  const pieceOfLeaf = (id: string) => { const m = members.find(x => x.leafId === id); if (m) return m.piece; const n = findBackNode(group.tree, id); return backPieceOf(group, n && n.kind === 'leaf' ? n : null); };
  const groovedOf = (ids: string[]) => ids.filter(id => pieceOfLeaf(id).placement === 'inner');
  const nailedOf = (ids: string[]) => ids.filter(id => pieceOfLeaf(id).placement === 'outer');
  const anyGrooved = groovedOf(allLeafIds).length > 0;
  const leafCells = (n: BackNodeSolved): BackNodeSolved[] => (n.kind === 'leaf' ? [n] : n.children.flatMap(leafCells));
  const cellTouches = (n: BackNodeSolved, k: BackEdgeKey) => (k === 'uMin' ? Math.abs(n.u0 - rect.u0) < T0 : k === 'uMax' ? Math.abs(n.u1 - rect.u1) < T0 : k === 'vMin' ? Math.abs(n.v0 - rect.v0) < T0 : Math.abs(n.v1 - rect.v1) < T0);
  /** Kenara değen yapraklar (hücresi iç dikdörtgenin o kenarında), isteğe bağlı bir alt küme içinde. */
  const touchingLeaves = (k: BackEdgeKey, within: string[] = allLeafIds) => leafCells(solved).filter(n => within.includes(n.id) && cellTouches(n, k)).map(n => n.id);
  const commonInset = (k: BackEdgeKey, ids: string[]): number | null => { const vs = ids.map(id => pieceOfLeaf(id).inset[k]); return vs.length && vs.every(v => Math.abs(v - vs[0]) < T0) ? vs[0] : null; };
  /** Çakma parçaların kenar panelinin üzerine ETKİN binmesi (mm; girilmemişse t = tamamen örter); farklıysa null. */
  const coverOf = (k: BackEdgeKey, id: string, t: number) => { const c = pieceOfLeaf(id).cover[k]; return Number.isFinite(c) ? Math.max(0, Math.min(t, c as number)) : t; };
  const commonCover = (k: BackEdgeKey, ids: string[], t: number): number | null => { const vs = ids.map(id => coverOf(k, id, t)); return vs.length && vs.every(v => Math.abs(v - vs[0]) < T0) ? vs[0] : null; };
  const selRegions = selectedNodes.map(id => findSolvedBackNode(solved, id)).filter((n): n is BackNodeSolved => !!n);
  const leafIdsUnder = (n: BackNodeSolved): string[] => (n.kind === 'leaf' ? [n.id] : n.children.flatMap(leafIdsUnder));
  const selLeafIds = new Set(selRegions.flatMap(leafIdsUnder));
  /** Kenar rozetinin / pill'inin yazacağı parçalar: seçili bölgelerin (ya da seçili üye satırının) o kenara değen yaprakları; seçim yoksa kenara değen tüm yapraklar. */
  const scopeLeaves = (k: BackEdgeKey): string[] => {
    const sel = selLeafIds.size ? [...selLeafIds] : selectedIndex >= 0 && members[selectedIndex] ? [members[selectedIndex].leafId] : allLeafIds;
    const t = touchingLeaves(k, sel);
    return t.length ? t : touchingLeaves(k);
  };
  const sx = (u: number) => (mirrorU ? ox + SW - ((u - rect.u0) / duR) * SW : ox + ((u - rect.u0) / duR) * SW);
  const sy = (v: number) => (mirrorV ? oy + ((v - rect.v0) / dvR) * SH : oy + ((rect.v1 - v) / dvR) * SH);
  const fs = schemFs(width);
  const fsT = schemFsT(fs);
  const gid = `bs-${group.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const I = DOOR_INSET_PX;
  const BAND_MIN = 6;
  const clampX = (x: number) => Math.max(2, Math.min(width - 2, x));
  const clampY = (y: number) => Math.max(2, Math.min(height - 2, y));
  // Kenar şeritleri: kanallı parçada KANAL GİRİŞİ (pill), çakma parçada bini Full/Half/None (rozet) — ikisi de parça başına.
  const invX = (x: number) => rect.u0 + (mirrorU ? (ox + SW - x) : (x - ox)) * duR / SW;
  const invY = (y: number) => (mirrorV ? rect.v0 + (y - oy) * dvR / SH : rect.v1 - (y - oy) * dvR / SH);
  const areaPx = [[2, 2], [width - 2, 2], [width - 2, height - 2], [2, height - 2]];
  const areaMm = areaPx.map(([x, y]) => ({ x: invX(x), y: invY(y) }));
  const ptsPath = (pts: Pt[]) => pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ') + ' Z';
  /** Kenar bandı: `na` = bini rozeti yazılacak parçalar (dış çakma parçalar + ÇAKMA kenardaki iç parçalar), `gr` = kanallı
   *  kenardaki iç parçalar (giriş pill'i), `nl` = çakma kenardaki iç parçalar (panel kısaltılır), `rel` = kenar ilişkisi (grup başına). */
  type Band = { np: BackNearPanel; x: number; y: number; w: number; h: number; vertical: boolean; half: boolean; none: boolean; aligned: boolean; pts: Pt[];
    na: string[]; gr: string[]; nl: string[]; rel: BackEdgeRel | null; cov: number | null; t: number; ins: number | null };
  const bands: Band[] = nearPanels.map(np => {
    const vertical = np.kind === 'u';
    let a0 = vertical ? Math.min(sx(np.a0), sx(np.a1)) : Math.min(sy(np.a0), sy(np.a1)), a1 = vertical ? Math.max(sx(np.a0), sx(np.a1)) : Math.max(sy(np.a0), sy(np.a1));
    if (a1 - a0 < BAND_MIN) { const c = (a0 + a1) / 2; a0 = c - BAND_MIN / 2; a1 = c + BAND_MIN / 2; }
    const c0 = vertical ? clampY(Math.min(sy(np.c0), sy(np.c1))) : clampX(Math.min(sx(np.c0), sx(np.c1)));
    const c1 = vertical ? clampY(Math.max(sy(np.c0), sy(np.c1))) : clampX(Math.max(sx(np.c0), sx(np.c1)));
    const scope = np.edge ? scopeLeaves(np.edge) : [];
    const rel: BackEdgeRel | null = np.edge ? edgeRelOf(group, np.edge) : null;
    const inner = np.edge ? groovedOf(scope) : [];
    const gr = rel === 'groove' ? inner : [], nl = rel === 'nail' ? inner : [];
    const na = [...(np.edge && np.behind ? nailedOf(scope) : []), ...nl];
    const t = Math.max(0, np.a1 - np.a0);   // kenar levhasının kalınlığı (bant ekseninde)
    const cov = np.edge && na.length ? commonCover(np.edge, na, t) : null;
    const ins = np.edge && gr.length ? commonInset(np.edge, gr) : null;
    const none = cov === 0, half = nl.length > 0 || (na.length > 0 && (cov == null || cov < t - T0));   // kısaltılan panel / kısmi binme → sıcak ton
    let x = vertical ? a0 : c0, y = vertical ? c0 : a0, w = vertical ? a1 - a0 : c1 - c0, h = vertical ? c1 - c0 : a1 - a0;
    let pts: Pt[] = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    const hull = np.poly ? clipPolyToConvex(np.poly, areaMm) : [];
    if (hull.length >= 3) {
      pts = hull.map(q => ({ x: sx(q.x), y: sy(q.y) }));
      const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
      x = Math.min(...xs); y = Math.min(...ys); w = Math.max(...xs) - x; h = Math.max(...ys) - y;
    }
    return { np, vertical, half, none, aligned: !!np.ref && !!np.joint, x, y, w, h, pts, na, gr, nl, rel, cov, t, ins };
  });
  const cutBands = backCutBands(group, rect, cuts, areaMm, BAND_MIN * dvR / SH).map(cb => {
    const pts = cb.poly.map(q => ({ x: sx(q.x), y: sy(q.y) }));
    const cx = pts.reduce((a, q) => a + q.x, 0) / pts.length, cy = pts.reduce((a, q) => a + q.y, 0) / pts.length;
    const dx = (mirrorU ? -1 : 1) * cb.dir.x, dy = (mirrorV ? 1 : -1) * cb.dir.y;
    const deg = Math.atan2(dy, dx) * 180 / Math.PI;
    const na = cb.edge && cb.covered ? nailedOf(scopeLeaves(cb.edge)) : [];
    const t = Math.max(0, cb.cut.dMax - cb.cut.dMin);
    const cov = na.length ? commonCover(cb.edge!, na, t) : null;
    const half = na.length > 0 && (cov == null || cov < t - T0);
    let rd = deg; while (rd > 90) rd -= 180; while (rd < -90) rd += 180;
    return { ...cb, pts, cx, cy, deg: rd, half, na, t, cov };
  });
  // Eğik kenarın boşluk pill'i eğik kenarın üzerinde durur; düz kenar zincirlerinde o kenar GÖSTERİLMEZ.
  const slopeSegs = cutBands.flatMap(cb => {
    if (!cb.edge) return [];
    let best: { a: Pt; b: Pt; len: number; m: typeof members[number] } | null = null;
    for (const m of members) {
      if (!m.poly) continue;
      for (let i = 0; i < m.poly.length; i++) {
        const a = m.poly[i], b = m.poly[(i + 1) % m.poly.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1 || Math.abs((b.x - a.x) * cb.dir.y - (b.y - a.y) * cb.dir.x) / len > 0.01) continue;
        if (!best || len > best.len) best = { a, b, len, m };
      }
    }
    return best ? [{ cb, edge: cb.edge, ...best }] : [];
  });
  const hiddenParts = (b: Band) => members.flatMap(m => {
    const dx0 = Math.min(sx(m.u0), sx(m.u1)) + I, dx1 = Math.max(sx(m.u0), sx(m.u1)) - I, dy0 = Math.min(sy(m.v1), sy(m.v0)) + I, dy1 = Math.max(sy(m.v1), sy(m.v0)) - I;
    if (dx1 - dx0 < 0.5 || dy1 - dy0 < 0.5) return [];
    const part = clipPolyToConvex(b.pts, [{ x: dx0, y: dy0 }, { x: dx1, y: dy0 }, { x: dx1, y: dy1 }, { x: dx0, y: dy1 }]);
    return part.length >= 3 && Math.abs(polyArea(part)) > 0.5 ? [part] : [];
  });
  const edgeName = (b: Band) => (b.vertical ? ((b.np.edge === 'uMin') !== mirrorU ? 'Left' : 'Right') : ((b.np.edge === 'vMax') !== mirrorV ? 'Top' : 'Bottom'));
  // İÇ LEVHA (arkalık-sınırı dikme/raf) tek eylemlidir: BÖL. Bini / Left-Right rozeti yok (Goker, Eki 2026): bütün kanallı arkalık
  // levhayı kısaltır; bölününce parçalar levhanın ortasına kadar girer (iki yandan kanallı) ve derz levhayı izler.
  const splittable = (np: BackNearPanel) => !!onSplitAtPanel && !np.edge && !np.joint && canSplitBackAtPanel(group, np);
  /** Levhaya bağlı derz bandı: iki yanın binme değerleri (ekranda sol/üst → sağ/alt), karışıksa "…". */
  const refJoint = (np: BackNearPanel) => {
    if (!np.ref) return null;
    const all = Object.entries(sides).flatMap(([id, r]) => (Object.entries(r) as Array<[BackEdgeKey, NonNullable<typeof r[BackEdgeKey]>]>).map(([key, x]) => ({ id, key, x })))
      .filter(e => e.x.splitId === np.ref!.splitId && e.x.k === np.ref!.k);
    if (!all.length) return null;
    const val = (keys: BackEdgeKey[]) => { const vs = all.filter(e => keys.includes(e.key)).map(e => e.x.in); return !vs.length ? '–' : vs.every(v => Math.abs(v - vs[0]) < T0) ? fmt(vs[0]) : '…'; };
    const lo = val(['uMax', 'vMin']), hi = val(['uMin', 'vMax']);   // lo = derzden önceki (sol / üst) parça(lar), hi = sonraki
    const flip = np.kind === 'u' ? mirrorU : mirrorV;
    return { txt: flip ? `${hi} · ${lo}` : `${lo} · ${hi}`, entered: all.some(e => e.x.entered) };
  };
  const scopeTxt = (ids: string[]) => (ids.length === 1 ? `piece ${memberLabels[allLeafIds.indexOf(ids[0])] ?? ''}`.trim() : `${ids.length} pieces`);
  const bandTip = (b: Band) => {
    const np = b.np;
    if (np.edge) {
      const parts: string[] = [];
      if (b.gr.length || b.nl.length) parts.push(b.rel === 'nail'
        ? `NAIL — this panel is shortened to the back panel's front face and the piece covers its end (click "Nail" to switch to a groove: the panel keeps its full depth).`
        : `GROOVE — this panel keeps its full depth and the piece enters its groove (click "Groove" to nail instead: the panel is shortened to the back panel's front face automatically).`);
      if (b.gr.length) parts.push(`GROOVE DEPTH ${b.ins == null ? 'mixed' : `${fmt(b.ins)} mm`} (${scopeTxt(b.gr)}) — how far the grooved piece enters this panel; click the value to edit (0 = ends at the panel's inner face).`);
      if (b.na.length) {
        parts.push(`OVERLAP ${b.cov == null ? 'mixed' : `${fmt(b.cov)} mm`} of ${fmt(b.t)} (${scopeTxt(b.na)}) — how far the piece runs onto this panel's end: 0 = ends at its inner face, ${fmt(b.t)} = covers it fully. Click the value to edit.`);
      }
      if (!parts.length) parts.push(np.behind ? 'no piece touches this edge.' : 'stands outside the back panel plane; nailed pieces end beside it (no overlay possible).');
      return `${edgeName(b)} — ${np.name}: ${parts.join(' ')} Select a piece to change only that piece.`;
    }
    const what = b.vertical ? 'divider' : 'shelf';
    const whole = anyGrooved ? `While the back panel is whole and grooved, this ${what} is shortened to the back panel's front face.` : `While the back panel is whole, it passes behind this ${what}.`;
    if (np.ref) return `${np.name} (${what}) — the back panel is split at this ${what} (${backJointRelOf(group.tree, np.ref.splitId, np.ref.k) === 'nail' ? `NAIL: the ${what} is shortened to the back panel's front face` : `GROOVE: both sides grooved, the ${what} keeps its full depth`} — switch with the Groove / Nail chip); each piece runs onto it by its own overlap (${refJoint(np)?.txt ?? '–'} mm, default: to its middle) and follows it when it moves. Click to select the split region and edit the overlap pills (0 = ends at the ${what}'s face, its thickness = covers it fully). Sizes next to this joint come from the ${what}.`;
    if (np.joint) return `${np.name} (${what}) — a joint of the back panel already lies at this ${what} (from a count split); it is not bound to it, so the pieces stay when the ${what} moves.`;
    if (refPick || splittable(np)) return `${np.name} (${what}) — back reference: click to split the back panel through its middle (both pieces reach the middle${anyGrooved ? ', grooved pieces on both sides' : ''}; the ${what} keeps its full depth). ${whole}`;
    return `${np.name} (${what}) — back reference, cannot be split here (no room for two pieces). ${whole}`;
  };
  const onBandClick = (b: Band) => {
    const np = b.np;
    if (refPick) { if (!np.edge && onRefPick) onRefPick(np.vfId); return; }
    if (np.edge) {
      // Kenar bandı: değer rozeti (çakma "On", yoksa kanallı "In") düzenlemeye açılır (ilişki rozeti kendi tıkıyla çevrilir).
      const c = bandChips.find(x => x.vfId === np.vfId && !x.toggle);
      if (c) beginEdit({ key: c.key, v: c.item.txt });
      return;
    }
    // Bağlı derz: bölme bölgesi seçilir (binme pill'leri görünür); zaten görünüyorsa ilki düzenlenir.
    if (np.ref) {
      const c = bandChips.find(x => x.key.startsWith(`bc-jin-${np.vfId}-${np.ref!.splitId}-${np.ref!.k}-`));
      if (c) beginEdit({ key: c.key, v: c.item.txt }); else onPathClick(pathToLeaf(np.ref.splitId), false);
      return;
    }
    if (splittable(np)) onSplitAtPanel!(np.vfId);
  };

  const commit = () => {
    if (!editing) return;
    if (cancelledRef.current) { cancelledRef.current = false; return; }   // Esc sonrası blur: onay yok
    const v = parseFloat(editing.v.replace(',', '.'));
    const p = editables.get(editing.key);
    setEditing(null);
    if (isNaN(v) || !p || v < p.item.min) { onEditCancel?.(snapRef.current); return; }   // geçersiz → önizleme geri alınır
    p.item.commit(v);
  };
  const previewEdit = (key: string, raw: string) => {
    const v = parseFloat(raw.replace(',', '.'));
    const p = editables.get(key);
    if (isNaN(v) || !p || v < p.item.min) return;
    p.item.preview?.(v);
  };
  const pathToLeaf = (leafId: string): string[] => {
    const out: string[] = [];
    const dfs = (n: BackNodeSolved): boolean => { out.push(n.id); if (n.id === leafId) return true; if (n.kind === 'split') for (const c of n.children) if (dfs(c)) return true; out.pop(); return false; };
    dfs(solved);
    return out;
  };
  const nodeBox = (n: BackNodeSolved) => ({ x0: Math.min(sx(n.u0), sx(n.u1)), x1: Math.max(sx(n.u0), sx(n.u1)), y0: Math.min(sy(n.v1), sy(n.v0)), y1: Math.max(sy(n.v1), sy(n.v0)) });
  const solvedParent = (id: string): Extract<BackNodeSolved, { kind: 'split' }> | null => {
    const walkP = (n: BackNodeSolved): Extract<BackNodeSolved, { kind: 'split' }> | null => {
      if (n.kind !== 'split') return null;
      if (n.children.some(c => c.id === id)) return n;
      for (const c of n.children) { const h = walkP(c); if (h) return h; }
      return null;
    };
    return walkP(solved);
  };
  const chains: Chain[] = [];
  const fmt = (v: number) => String(round1(v));
  const focusStrips: Array<{ x: number; y: number; w: number; h: number }> = [];
  const stripClip = cuts.length ? backCutOutline(group, rect, rect, cuts).map(q => ({ x: sx(q.x), y: sy(q.y) })) : null;
  const strip = (ax: 'u' | 'v', a: number, b: number, c0: number, c1: number) => {
    const MINW = 3;
    let x0 = ax === 'u' ? Math.min(sx(a), sx(b)) : Math.min(sx(c0), sx(c1)), x1 = ax === 'u' ? Math.max(sx(a), sx(b)) : Math.max(sx(c0), sx(c1));
    let y0 = ax === 'u' ? Math.min(sy(c0), sy(c1)) : Math.min(sy(a), sy(b)), y1 = ax === 'u' ? Math.max(sy(c0), sy(c1)) : Math.max(sy(a), sy(b));
    if (ax === 'u' && x1 - x0 < MINW) { const c = (x0 + x1) / 2; x0 = c - MINW / 2; x1 = c + MINW / 2; }
    if (ax === 'v' && y1 - y0 < MINW) { const c = (y0 + y1) / 2; y0 = c - MINW / 2; y1 = c + MINW / 2; }
    focusStrips.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  };
  type Box4 = { u0: number; u1: number; v0: number; v1: number };
  const outlineMemo = new Map<string, Pt[]>();
  const outlineOf = (r: Box4): Pt[] => {
    const key = `${r.u0.toFixed(2)},${r.u1.toFixed(2)},${r.v0.toFixed(2)},${r.v1.toFixed(2)}`;
    let o = outlineMemo.get(key);
    if (!o) { o = cuts.length ? backCutOutline(group, rect, r, cuts) : [{ x: r.u0, y: r.v0 }, { x: r.u1, y: r.v0 }, { x: r.u1, y: r.v1 }, { x: r.u0, y: r.v1 }]; outlineMemo.set(key, o); }
    return o;
  };
  const lineSpan = (poly: Pt[], ax: 'u' | 'v', val: number): [number, number] | null => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const pa = ax === 'u' ? a.x : a.y, pb = ax === 'u' ? b.x : b.y;
      if ((pa - val) * (pb - val) > 0 || Math.abs(pb - pa) < 1e-9) continue;
      const t = (val - pa) / (pb - pa), q = ax === 'u' ? a.y + t * (b.y - a.y) : a.x + t * (b.x - a.x);
      lo = Math.min(lo, q); hi = Math.max(hi, q);
    }
    return hi - lo > 0.5 ? [lo, hi] : null;
  };
  const crossOf = (r: Box4, ax: 'u' | 'v'): [number, number] => (ax === 'u' ? [r.v0, r.v1] : [r.u0, r.u1]);
  const clampSpan = (sp: [number, number], c: [number, number]): [number, number] => {
    const lo = Math.max(sp[0], Math.min(c[0], c[1])), hi = Math.min(sp[1], Math.max(c[0], c[1]));
    return hi - lo > 1 ? [lo, hi] : sp;
  };
  const jointSpanOf = (R: Box4, ax: 'u' | 'v', a: number, b: number, on?: Box4): [number, number] => {
    const sp = lineSpan(outlineOf(R), ax, (a + b) / 2) ?? crossOf(R, ax);
    return on ? clampSpan(sp, crossOf(on, ax)) : sp;
  };
  // KENAR / DERZ BİNME DEĞERLERİ ölçü zincirinde GÖSTERİLMEZ (Goker, Eki 2026 — "arkalığa tıklayınca In / On yanında bir de kanal
  // derinlik kutucukları geliyor, iki tane binme değeri görünüyor"): bunlar yalnız bandın In / On rozetlerinde; zincir = parça ölçüleri + aralar.
  const slots = new Map<string, { h: number; v: number }>();
  const pushChain = (on: BackNodeSolved, horiz: boolean, items: ChainItem[]) => {
    if (!items.length) return;
    const sl = slots.get(on.id) ?? { h: 0, v: 0 }; slots.set(on.id, sl);
    const bx1 = Math.max(sx(on.u0), sx(on.u1)), by1 = Math.max(sy(on.v1), sy(on.v0));
    const pos = horiz ? by1 - CHAIN_OFF_H - CHAIN_STEP * sl.h : bx1 - CHAIN_OFF_V - CHAIN_STEP * sl.v;
    if (horiz) sl.h++; else sl.v++;
    chains.push({ horiz, pos, items, small: true });
  };
  type SplitS = Extract<BackNodeSolved, { kind: 'split' }>;
  // Bölmede tek AÇIK ölçü kaldıysa PASİF (pin de kilit sayılır): girilemez, rozetsiz — değeri kalandan gelir.
  const sizeItem = (P: SplitS, i: number, a: number, b: number, horiz: boolean): ChainItem => {
    const w = P.sizes[i]?.value ?? 0;
    // Levhaya bağlı derze bitişik ölçü levhadan gelir (derz levhayı izler) — girilemez.
    if (backSizeBoundByJoint(P, i)) {
      return { key: `size-${P.id}-${i}`, kind: 'size', a, b, txt: fmt(w), passive: true, title: `${horiz ? 'Piece width' : 'Piece height'} — set by the divider / shelf the joint is bound to (move that panel to change it)`,
        commit: () => {}, min: 1 };
    }
    if (passiveBackSizeIndex(P.sizes, P.children.length) === i) {
      return { key: `size-${P.id}-${i}`, kind: 'size', a, b, txt: fmt(w), passive: true, title: `${horiz ? 'Piece width' : 'Piece height'} — remainder (all other pieces pinned or locked); open one to edit`,
        commit: () => {}, min: 1 };
    }
    const mode = backSizeMode(P.sizes[i]);
    const lockTitle = mode === 'locked' ? 'Locked — fixed on resize and when other pieces are edited. Click: open'
      : mode === 'hold' ? 'Hold — keeps its value when other pieces are edited, still scales with the back panel on resize. Click: lock'
      : 'Open — takes up changes from other pieces and scales with the back panel on resize. Click: hold';
    return { key: `size-${P.id}-${i}`, kind: 'size', a, b, txt: fmt(w), title: `${horiz ? 'Piece width' : 'Piece height'} — click to edit (open pieces take up the difference)`,
      locked: mode === 'locked', edited: mode === 'hold', lockTitle, onLock: () => onToggleLock(P.id, i), commit: v => onEditSize(P.id, i, v), preview: v => onEditSize(P.id, i, v, true), min: 1 };
  };
  // LEVHAYA BAĞLI DERZ: zincirde ara yok (binme değerleri derz bandındaki On / In rozetlerinde).
  const jointSidesOf = (P: SplitS, k: number) => Object.values(sides).flatMap(r => Object.values(r)).filter(x => !!x && x.splitId === P.id && x.k === k);
  const isBoundJoint = (P: SplitS, k: number) => !!P.refs?.[k] && jointSidesOf(P, k).length > 0;
  const splitItems = (n: SplitS, withStrips: boolean): ChainItem[] => {
    const horiz = n.axis === 'u', dir = horiz ? 1 : -1;
    const items: ChainItem[] = [];
    let p = horiz ? n.u0 : n.v1;
    n.children.forEach((_c, i) => {
      const w = n.sizes[i]?.value ?? 0;
      items.push(sizeItem(n, i, p, p + dir * w, horiz));
      p += dir * w;
      if (i < n.children.length - 1 && isBoundJoint(n, i)) {
        p += dir * (n.gaps[i] ?? 0);
      } else if (i < n.children.length - 1) {
        const g = n.gaps[i] ?? 0;
        items.push({ key: `sgap-${n.id}-${i}`, kind: 'gap', a: p, b: p + dir * g, txt: fmt(g), title: 'Gap between pieces — click to edit', commit: v => onEditSplitGap(n.id, i, v), preview: v => onEditSplitGap(n.id, i, v, true), min: 0, span: jointSpanOf(n, n.axis, p, p + dir * g) });
        if (withStrips) strip(n.axis, p, p + dir * g, horiz ? n.v0 : n.u0, horiz ? n.v1 : n.u1);
        p += dir * g;
      }
    });
    return items;
  };
  const placeItems = (n: BackNodeSolved, P: SplitS, on: BackNodeSolved): ChainItem[] => {
    const horiz = P.axis === 'u', dir = horiz ? 1 : -1;
    const idx = P.children.findIndex(c => c.id === n.id);
    if (idx < 0) return [];
    const items: ChainItem[] = [];
    const start = horiz ? n.u0 : n.v1;
    const c0 = horiz ? on.v0 : on.u0, c1 = horiz ? on.v1 : on.u1;
    if (idx > 0 && !isBoundJoint(P, idx - 1)) { const g = P.gaps[idx - 1] ?? 0; items.push({ key: `sgap-${P.id}-${idx - 1}`, kind: 'gap', a: start - dir * g, b: start, txt: fmt(g), title: 'Gap between pieces — click to edit', commit: v => onEditSplitGap(P.id, idx - 1, v), preview: v => onEditSplitGap(P.id, idx - 1, v, true), min: 0, span: jointSpanOf(P, P.axis, start - dir * g, start, on) }); strip(P.axis, start - dir * g, start, c0, c1); }
    const w = P.sizes[idx]?.value ?? 0;
    items.push(sizeItem(P, idx, start, start + dir * w, horiz));
    const end = start + dir * w;
    if (idx < P.children.length - 1 && !isBoundJoint(P, idx)) { const g = P.gaps[idx] ?? 0; items.push({ key: `sgap-${P.id}-${idx}`, kind: 'gap', a: end, b: end + dir * g, txt: fmt(g), title: 'Gap between pieces — click to edit', commit: v => onEditSplitGap(P.id, idx, v), preview: v => onEditSplitGap(P.id, idx, v, true), min: 0, span: jointSpanOf(P, P.axis, end, end + dir * g, on) }); strip(P.axis, end, end + dir * g, c0, c1); }
    return items;
  };
  const fullItems = (ax: 'u' | 'v'): ChainItem[] => {
    const horiz = ax === 'u', dir = horiz ? 1 : -1;
    const lo = horiz ? rect.u0 : rect.v1;
    const span = horiz ? rect.u1 - rect.u0 : rect.v1 - rect.v0;
    const items: ChainItem[] = [];
    items.push({ key: `full-${ax}`, kind: 'size', a: lo, b: lo + dir * span, txt: fmt(span), title: horiz ? 'Back area width (between the reference panels\' inner faces)' : 'Back area height (between the reference panels\' inner faces)', commit: () => {}, min: 1 });
    return items;
  };
  const crossChain = (n: BackNodeSolved, ax: 'u' | 'v', on: BackNodeSolved) => {
    let A: BackNodeSolved = n, B = solvedParent(A.id);
    while (B && B.axis === ax) { A = B; B = solvedParent(B.id); }
    if (B) pushChain(on, B.axis === 'u', placeItems(A, B, on));
    else pushChain(on, ax !== 'u', fullItems(ax === 'u' ? 'v' : 'u'));
  };
  for (const n of selRegions) {
    if (n.kind === 'split') {
      pushChain(n, n.axis === 'u', splitItems(n, true));
      crossChain(n, n.axis, n);
      continue;
    }
    const P = solvedParent(n.id);
    if (P) { pushChain(n, P.axis === 'u', placeItems(n, P, n)); crossChain(P, P.axis, n); }
    else { pushChain(n, true, fullItems('u')); pushChain(n, false, fullItems('v')); }
  }

  type Pill = { key: string; cx: number; cy: number; pw: number; ph: number; f: number; item: ChainItem; chain: Chain; x0: number; x1: number; hidden: boolean; lane: number; deg?: number; lock?: { x: number; y: number } };
  type Placed = { start: number; end: number };
  // Eğik kenar giriş pill'i: yalnız SEÇİLİ KANALLI parçaların en uzun eğik kenarının ortasında, kenar yönünde döndürülmüş (çakmada rozet var).
  const selSlopeSegs = slopeSegs.flatMap(sg0 => {
    let best: typeof sg0 | null = null;
    for (const m of members) {
      if (!m.poly || !selLeafIds.has(m.leafId) || m.piece.placement !== 'inner') continue;
      for (let i = 0; i < m.poly.length; i++) {
        const a = m.poly[i], b = m.poly[(i + 1) % m.poly.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1 || Math.abs((b.x - a.x) * sg0.cb.dir.y - (b.y - a.y) * sg0.cb.dir.x) / len > 0.01) continue;
        if (!best || len > best.len) best = { ...sg0, a, b, len, m };
      }
    }
    return best ? [best] : [];
  });
  const slopePills: Pill[] = selSlopeSegs.map(sg => {
    const a = { x: sx(sg.a.x), y: sy(sg.a.y) }, b = { x: sx(sg.b.x), y: sy(sg.b.y) };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, tx = (b.x - a.x) / L, ty = (b.y - a.y) / L;
    const poly = sg.m.poly!, cxm = poly.reduce((s0, q) => s0 + sx(q.x), 0) / poly.length, cym = poly.reduce((s0, q) => s0 + sy(q.y), 0) / poly.length;
    let nx = -ty, ny = tx;
    if (nx * (cxm - mid.x) + ny * (cym - mid.y) < 0) { nx = -nx; ny = -ny; }
    const ins = sg.m.piece.inset[sg.edge];
    const txt = fmt(ins);
    const { pw, ph } = pillSize(txt, fs);
    const off = (ins * SH / dvR) / 2;
    let deg = Math.atan2(ty, tx) * 180 / Math.PI; while (deg > 90) deg -= 180; while (deg < -90) deg += 180;
    const item: ChainItem = { key: `slope-${sg.cb.cut.vfId}-${sg.m.leafId}`, kind: 'gap', a: 0, b: 0, txt,
      title: `Groove inset into the angled panel ${sg.cb.cut.name} (${scopeTxt([sg.m.leafId])}) — click to edit (the piece enters the panel by this much along the slope)`,
      commit: v => onEditInset(sg.edge, v, [sg.m.leafId]), preview: v => onEditInset(sg.edge, v, [sg.m.leafId], true), min: 0 };
    return { key: item.key, cx: mid.x + nx * off, cy: mid.y + ny * off, pw, ph, f: fs, item, chain: { horiz: true, pos: 0, items: [item] }, x0: mid.x, x1: mid.x, hidden: false, lane: 0, deg };
  });
  // Sabit boşluk pill'leri (kenar/derz ortasında) önce; ölçüler bunlara 2B'de çarpmayan şeridi seçer.
  const chainPills = chains.map(ch => ({ ch, all: ch.items.map(it => {
    const f = fs;
    const { pw, ph } = pillSize(it.txt, f);
    const m0 = ch.horiz ? sx(it.a) : sy(it.a), m1 = ch.horiz ? sx(it.b) : sy(it.b);
    const mid = (m0 + m1) / 2;
    const sc = it.kind === 'gap' && it.span ? (ch.horiz ? sy((it.span[0] + it.span[1]) / 2) : sx((it.span[0] + it.span[1]) / 2)) : null;
    return { key: it.key, cx: ch.horiz ? mid : (sc ?? ch.pos), cy: ch.horiz ? (sc ?? ch.pos) : mid, pw, ph, f, item: it, chain: ch, x0: Math.min(m0, m1), x1: Math.max(m0, m1), hidden: false, lane: 0, fixed: sc != null } as Pill & { fixed: boolean };
  }) }));
  const fixedAll: Pill[] = [...chainPills.flatMap(c => c.all.filter(p => p.fixed)), ...slopePills];
  const boxHit = (x: number, y: number, w: number, h: number, q: Pill) => Math.abs(x - q.cx) < (w + q.pw) / 2 + 2 && Math.abs(y - q.cy) < (h + q.ph) / 2 + 2;
  const pills: Pill[] = chainPills.flatMap(({ ch, all }) => {
    const fixedPills = all.filter(p => p.fixed);
    const base = all.filter(p => !p.fixed).sort((a, b) => (ch.horiz ? a.cx - b.cx : a.cy - b.cy));
    const maxLanes = 3, sizeLanes = [0, 1, 2, 3, 4];
    const lanes: Placed[][] = Array.from({ length: sizeLanes.length }, () => []);
    const posOf = (p: typeof base[number]) => (ch.horiz ? p.cx : p.cy);
    const spanOf = (p: typeof base[number]): Placed => {
      const half = (ch.horiz ? p.pw : p.ph) / 2 + 1;
      return { start: posOf(p) - half, end: posOf(p) + half + (p.item.onLock ? LOCK_EXT : 0) };
    };
    const fits = (lane: number, start: number, end: number) => lanes[lane].every(q => end <= q.start || start >= q.end);
    const laneStep = Math.max(...base.map(p => (ch.horiz ? p.ph : p.pw)), 0) + PILL_LANE_GAP;
    const clear2D = (p: typeof base[number], lane: number) => {
      const x = ch.horiz ? p.cx : p.cx - lane * laneStep, y = ch.horiz ? p.cy - lane * laneStep : p.cy;
      if (fixedAll.some(q => boxHit(x, y, p.pw, p.ph, q))) return false;
      if (!p.item.onLock) return true;
      const lx = ch.horiz ? x + p.pw / 2 + LOCK_OFF : x, ly = ch.horiz ? y : y + p.ph / 2 + LOCK_OFF;
      return !fixedAll.some(q => boxHit(lx, ly, 2 * LOCK_R, 2 * LOCK_R, q));
    };
    const place = (p: typeof base[number], lane: number) => {
      p.lane = lane; lanes[lane].push(spanOf(p));
      if (lane > 0) { if (ch.horiz) p.cy -= lane * laneStep; else p.cx -= lane * laneStep; }
    };
    for (const p of base.filter(x => x.item.kind === 'size')) {
      const { start: st0, end: en0 } = spanOf(p);
      const lane = sizeLanes.find(l => fits(l, st0, en0) && clear2D(p, l)) ?? (fits(0, st0, en0) ? 0 : fits(1, st0, en0) ? 1 : 0);
      place(p, lane);
    }
    for (const p of base.filter(x => x.item.kind === 'gap')) {
      const { start: st0, end: en0 } = spanOf(p);
      let lane = maxLanes - 1;
      for (let l = 0; l < maxLanes; l++) if (fits(l, st0, en0)) { lane = l; break; }
      place(p, lane);
    }
    return [...base, ...fixedPills];
  });
  pills.push(...slopePills);
  // Kilit yeri: ölçünün ucu; çarpıyorsa karşı uç, sonra pill'in yanları.
  {
    const placedLocks: Array<{ x: number; y: number }> = [];
    const clearOf = (x: number, y: number, self: Pill) =>
      x >= LOCK_R + 1 && x <= width - LOCK_R - 1 && y >= LOCK_R + 1 && y <= height - LOCK_R - 1 &&
      pills.every(q => q === self || Math.abs(x - q.cx) >= q.pw / 2 + LOCK_R + 2 || Math.abs(y - q.cy) >= q.ph / 2 + LOCK_R + 2) &&
      placedLocks.every(l => Math.hypot(l.x - x, l.y - y) >= 2 * LOCK_R + 3);
    for (const p of pills) {
      if (!p.item.onLock) continue;
      const d = (p.chain.horiz ? p.pw : p.ph) / 2 + LOCK_OFF;
      const e = (p.chain.horiz ? p.ph : p.pw) / 2 + LOCK_OFF;
      const cand = p.chain.horiz ? [{ x: p.cx + d, y: p.cy }, { x: p.cx - d, y: p.cy }, { x: p.cx, y: p.cy + e }, { x: p.cx, y: p.cy - e }]
        : [{ x: p.cx, y: p.cy + d }, { x: p.cx, y: p.cy - d }, { x: p.cx + e, y: p.cy }, { x: p.cx - e, y: p.cy }];
      p.lock = cand.find(c => clearOf(c.x, c.y, p)) ?? cand[0];
      placedLocks.push(p.lock);
    }
  }
  const obstacles = pills.flatMap(p => {
    const o = [{ x: p.cx, y: p.cy, r: Math.max(p.pw, p.ph) / 2 }];
    if (p.lock) o.push({ ...p.lock, r: LOCK_R });
    return o;
  });
  // Parça etiket bloğu (no · ölçü · tür) da engel: "Split here" gibi bant rozetleri etiketin üstüne binmesin.
  for (const m of members) obstacles.push({ x: (sx(m.u0) + sx(m.u1)) / 2, y: (sy(m.v0) + sy(m.v1)) / 2, r: fsT * 2.6 });
  const chipSpot = (cx: number, cy: number, ux: number, uy: number, half: number, cw: number) => {
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
  // KENAR DEĞER ROZETLERİ (bant üzerinde, tıklayınca yerinde düzenlenir): çakma parça → "On <mm>" = panelin üzerine binme,
  // kanallı parça → "In <mm>" = kanal derinliği. Değer seçili parçalara (yoksa kenara değen tüm parçalara) yazılır.
  type BandChip = { key: string; vfId: string; cx: number; cy: number; pw: number; ph: number; f: number; label: string; item: ChainItem; rot: number; warm: boolean; title: string;
    /** İlişki rozeti: tık değer düzenlemez, kenar ilişkisini çevirir. */
    toggle?: () => void;
    /** Turuncu çerçeve (kenarın kendi kanal payı var). */
    accent?: boolean };
  const bandChips: BandChip[] = [];
  const cfs0 = chipFs(fsT);
  const placeChip = (c: Omit<BandChip, 'cx' | 'cy' | 'pw' | 'ph' | 'f'>, cx: number, cy: number, ux: number, uy: number, half: number) => {
    const { pw, ph } = pillSize(c.label, cfs0);
    const sp0 = chipSpot(cx, cy, ux, uy, half, pw);
    // Rozet SVG'nin içinde kalır (döndürülmüşse kapladığı kutu yer değiştirir): kenarda kırpılmasın.
    const rad = (c.rot || 0) * Math.PI / 180, hx = (Math.abs(Math.cos(rad)) * pw + Math.abs(Math.sin(rad)) * ph) / 2 + 2, hy = (Math.abs(Math.sin(rad)) * pw + Math.abs(Math.cos(rad)) * ph) / 2 + 2;
    const sp = { x: Math.max(hx, Math.min(width - hx, sp0.x)), y: Math.max(hy, Math.min(height - hy, sp0.y)) };
    bandChips.push({ ...c, cx: sp.x, cy: sp.y, pw, ph, f: cfs0 });
    obstacles.push({ x: sp.x, y: sp.y, r: Math.max(pw, ph) / 2 });
  };
  const valItem = (key: string, v: number | null, commit: (x: number) => void, preview: (x: number) => void): ChainItem =>
    ({ key, kind: 'gap', a: 0, b: 0, txt: v == null ? '' : fmt(v), title: '', commit, preview, min: 0 });
  // KANAL PAYI rozeti ("±"): kanallı kenarın / derzin kanal bollaştırmasını kart satırına getirir. Seçili → koyu; kendi değeri var → turuncu.
  const clearChip = (b: Band) => {
    const vfId = b.np.vfId, on = clearVfId === vfId, own = backGrooveClearOverridden(group, vfId);
    const c = backGrooveClearOf(group, vfId);
    const key = `bc-clr-${vfId}`;
    placeChip({ key, vfId, label: '±', rot: 0, warm: on, accent: own && !on, toggle: () => onPickClearEdge(vfId),
      title: `${b.np.name} — groove clearance ${own ? '(own values)' : '(group values)'}: F ${fmt(c.front)} · R ${fmt(c.back)} · D ${fmt(c.depth)} mm. Click to edit only this panel's groove clearance in the card row${on ? ' (click again: back to the whole group)' : ''}.`,
      item: valItem(key, null, () => {}, () => {}) }, b.x + b.w / 2, b.y + b.h / 2, b.vertical ? 0 : 1, b.vertical ? 1 : 0, (b.vertical ? b.h : b.w) / 2);
  };
  if (!refPick) {
    for (const b of bands) {
      const k = b.np.edge;
      // BAĞLI DERZ (dikme/rafta bölünmüş): ilişki rozeti Groove ↔ Nail; binme değerleri derz pill'lerinde / rozetinde.
      if (!k && b.np.ref && refJoint(b.np)) {
        const { splitId, k: jk } = b.np.ref;
        const rel = backJointRelOf(group.tree, splitId, jk);
        const what = b.vertical ? 'divider' : 'shelf';
        const key = `bc-jrel-${b.np.vfId}-${splitId}-${jk}`;
        placeChip({ key, vfId: b.np.vfId, label: BACK_REL_LABEL[rel], rot: b.vertical ? -90 : 0, warm: rel === 'nail', toggle: () => onToggleJointRel(splitId, jk),
          title: `${b.np.name} (${what}) — the back panel is split here. ${rel === 'nail'
            ? `NAILED — the ${what} is shortened to the back panel's front face and both pieces cover its end by their overlap. Click to switch to Groove (the ${what} keeps its full depth, both pieces enter it from both sides).`
            : `GROOVED on both sides — the ${what} keeps its full depth and both pieces enter it by their overlap. Click to switch to Nail (the ${what} is shortened to the back panel's front face automatically; the pieces cover its end).`}`,
          item: valItem(key, null, () => {}, () => {}) }, b.x + b.w / 2, b.y + b.h / 2, b.vertical ? 0 : 1, b.vertical ? 1 : 0, (b.vertical ? b.h : b.w) / 2);
        // BİNME rozetleri (her yan ayrı, doğrudan düzenlenir): Nail → "On" = parçanın levha ucunun üzerine binmesi,
        // Groove → "In" = levhaya giriş. Rozet o yanın parçasına doğru kaydırılır (hangi yan olduğu görünsün).
        for (const which of ['before', 'after'] as const) {
          const ek: BackEdgeKey = b.vertical ? (which === 'before' ? 'uMax' : 'uMin') : (which === 'before' ? 'vMin' : 'vMax');
          const ids = allLeafIds.filter(id => { const x = sides[id]?.[ek]; return !!x && x.splitId === splitId && x.k === jk; });
          if (!ids.length) continue;
          const ss = ids.map(id => sides[id]![ek]!);
          const common = ss.every(x => Math.abs(x.in - ss[0].in) < T0) ? ss[0].in : null;
          const m0 = members.find(mm => mm.leafId === ids[0]);
          const pcx = m0 ? (sx(m0.u0) + sx(m0.u1)) / 2 : b.x, pcy = m0 ? (sy(m0.v0) + sy(m0.v1)) / 2 : b.y;
          const dir = b.vertical ? Math.sign(pcx - (b.x + b.w / 2)) || 1 : Math.sign(pcy - (b.y + b.h / 2)) || 1;
          const lbl = `${rel === 'nail' ? 'On' : 'In'} ${common == null ? '…' : fmt(common)}`;
          const { ph: cph } = pillSize(lbl, cfs0);
          const off = (b.vertical ? b.w : b.h) / 2 + cph / 2 + 2;
          const jkey = `bc-jin-${b.np.vfId}-${splitId}-${jk}-${which}`;
          const t = ss[0].t;
          placeChip({ key: jkey, vfId: b.np.vfId, label: lbl, rot: b.vertical ? -90 : 0, warm: rel === 'nail',
            title: `${b.np.name} (${what}) — ${rel === 'nail' ? 'how far the piece runs onto the ' + what + "'s end" : 'how far the piece enters the ' + what} on this side (${scopeTxt(ids)}): ${common == null ? 'pieces differ' : `${fmt(common)} mm`} of ${fmt(t)} (0 = ends at its face, ${fmt(t)} = covers it fully; default: to its middle). Click to type.`,
            item: valItem(jkey, common, v => onEditJointIn(ek, v, ids), v => onEditJointIn(ek, v, ids, true)) },
            b.x + b.w / 2 + (b.vertical ? dir * off : 0), b.y + b.h / 2 + (b.vertical ? 0 : dir * off), b.vertical ? 0 : 1, b.vertical ? 1 : 0, (b.vertical ? b.h : b.w) / 2);
        }
        if (rel === 'groove') clearChip(b);
      }
      if (!k) continue;
      const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2, ux = b.vertical ? 0 : 1, uy = b.vertical ? 1 : 0, half = (b.vertical ? b.h : b.w) / 2;
      // KENAR İLİŞKİSİ rozeti (grup başına): kenarda iç (kanallı tip) parça varsa Groove ↔ Nail.
      if (b.rel && (b.gr.length || b.nl.length) && b.t > 0) {
        const key = `bc-rel-${b.np.vfId}`;
        placeChip({ key, vfId: b.np.vfId, label: BACK_REL_LABEL[b.rel], rot: b.vertical ? -90 : 0, warm: b.rel === 'nail', toggle: () => onToggleEdgeRel(k),
          title: `${edgeName(b)} — ${b.np.name}: ${b.rel === 'nail'
            ? 'NAILED edge — the panel is shortened to the back panel\'s front face and the piece covers its end by the overlap. Click to switch to Groove (the panel keeps its full depth, the piece enters its groove).'
            : 'GROOVED edge — the panel keeps its full depth and the piece enters its groove by the groove depth. Click to switch to Nail (the panel is shortened to the back panel\'s front face automatically; the piece covers its end).'}`,
          item: valItem(key, null, () => {}, () => {}) }, bcx, bcy, ux, uy, half);
      }
      if (b.na.length) {
        const ids = b.na, key = `bc-on-${b.np.vfId}`;
        placeChip({ key, vfId: b.np.vfId, label: `On ${b.cov == null ? '…' : fmt(b.cov)}`, rot: b.vertical ? -90 : 0, warm: b.half,
          title: `${edgeName(b)} — ${b.np.name}: nailed piece overlap ${b.cov == null ? '(pieces differ)' : `${fmt(b.cov)} mm`} of ${fmt(b.t)} (${scopeTxt(ids)}). Click to type the overlap (0 = ends at the panel's inner face, ${fmt(b.t)} = covers it fully).`,
          item: valItem(key, b.cov, v => onEditCover(k, v, ids), v => onEditCover(k, v, ids, true)) }, bcx, bcy, ux, uy, half);
      }
      if (b.gr.length) {
        const ids = b.gr, key = `bc-in-${b.np.vfId}`;
        placeChip({ key, vfId: b.np.vfId, label: `In ${b.ins == null ? '…' : fmt(b.ins)}`, rot: b.vertical ? -90 : 0, warm: false,
          title: `${edgeName(b)} — ${b.np.name}: groove depth ${b.ins == null ? '(pieces differ)' : `${fmt(b.ins)} mm`} (${scopeTxt(ids)}). Click to type how far the grooved piece enters the panel (0 = ends at its inner face).`,
          item: valItem(key, b.ins, v => onEditInset(k, v, ids), v => onEditInset(k, v, ids, true)) }, bcx, bcy, ux, uy, half);
        clearChip(b);
      }
    }
    for (const cb of cutBands) {
      if (!cb.edge || !cb.na.length) continue;
      const k = cb.edge, ids = cb.na, key = `bc-on-${cb.cut.vfId}`;
      const rad = cb.deg * Math.PI / 180;
      const ext = Math.max(...cb.pts.map(q => Math.abs((q.x - cb.cx) * Math.cos(rad) + (q.y - cb.cy) * Math.sin(rad))));
      placeChip({ key, vfId: cb.cut.vfId, label: `On ${cb.cov == null ? '…' : fmt(cb.cov)}`, rot: cb.deg, warm: cb.half,
        title: `${cb.cut.name} — angled panel: nailed piece overlap ${cb.cov == null ? '(pieces differ)' : `${fmt(cb.cov)} mm`} of ${fmt(cb.t)} (${scopeTxt(ids)}), measured across the panel. Click to type the overlap.`,
        item: valItem(key, cb.cov, v => onEditCover(k, v, ids), v => onEditCover(k, v, ids, true)) }, cb.cx, cb.cy, Math.cos(rad), Math.sin(rad), ext);
    }
  }
  const editables = new Map<string, { cx: number; cy: number; pw: number; ph: number; f: number; item: ChainItem }>([
    ...pills.map(p => [p.key, p] as const), ...bandChips.filter(c => !c.toggle).map(c => [c.key, c] as const)]);
  // GİRİŞ BÖLGELERİ (Goker, Eki 2026 — "arkalığın panelin içine girdiğini daha belirgin göster"): parça ∩ sınır levhası şeridi.
  // groove = parça panelin kanalına giriyor (turuncu, kanal dibi koyu çizgi); nail = parça panelin ucunu örtüyor (taş rengi).
  // Her zaman çizilir (seçim gerekmez); çok ince bölge en az 3 px gösterilir (panelin iç yüzünden dışa doğru).
  type Zone = { key: string; x: number; y: number; w: number; h: number; kind: 'groove' | 'nail'; vertical: boolean; deepX: number; deepY: number;
    /** Kanal (bollaştırılmış) kutusu: parça bölgesi + kanal dibi payı (D), panelin iç yüzü sabit. */
    groove?: { x: number; y: number; w: number; h: number };
    /** Kanal payı bu kenar için düzenleniyor (kart satırı): belirgin çerçeve. */
    active?: boolean; vfId: string };
  const zones: Zone[] = [];
  const pxU = SW / duR, pxV = SH / dvR;   // mm → px
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
      const deepX = isU ? (Math.abs(sx(deep) - x0) < Math.abs(sx(deep) - x1) ? x0 : x1) : 0, deepY = isU ? 0 : (Math.abs(sy(deep) - y0) < Math.abs(sy(deep) - y1) ? y0 : y1);
      // Kanal kutusu: dip payı (D) kanal dibi yönünde eklenir; kanal genişliği (F/B) derinlik ekseninde olduğundan ön görünüşte yok.
      let grooveBox: Zone['groove'];
      if (kind === 'groove') {
        const dpx = backGrooveClearOf(group, np.vfId).depth * (isU ? pxU : pxV);
        grooveBox = isU
          ? (deepX === x0 ? { x: x0 - dpx, y: y0, w: x1 - x0 + dpx, h: y1 - y0 } : { x: x0, y: y0, w: x1 - x0 + dpx, h: y1 - y0 })
          : (deepY === y0 ? { x: x0, y: y0 - dpx, w: x1 - x0, h: y1 - y0 + dpx } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 + dpx });
      }
      zones.push({ key: `z-${np.vfId}-${m.leafId}`, x: x0, y: y0, w: x1 - x0, h: y1 - y0, kind, vertical: isU, deepX, deepY, groove: grooveBox, active: clearVfId === np.vfId, vfId: np.vfId });
    }
  }
  const editPos = editing ? editables.get(editing.key) : undefined;
  const captionOf = (m: typeof members[number]) => BACK_TYPE_LABEL[m.piece.placement];

  return (
    <div ref={wrapRef} className={PREVIEW_FRAME} style={{ background: PREVIEW_BG, height }}>
      <style>{SCHEMATIC_CSS}</style>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', fontFamily: UI_FONT }}>
        <defs>
          <linearGradient id={`${gid}-part`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SOFT.part0} /><stop offset="1" stopColor={SOFT.part1} /></linearGradient>
          <linearGradient id={`${gid}-part-on`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SOFT.on0} /><stop offset="1" stopColor={SOFT.on1} /></linearGradient>
          <linearGradient id={`${gid}-part-sel`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SOFT.sel0} /><stop offset="1" stopColor={SOFT.sel1} /></linearGradient>
          <pattern id={`${gid}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#bfb5a6" strokeWidth="0.7" /></pattern>
          <pattern id={`${gid}-hatch-on`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#e8925a" strokeWidth="0.9" /></pattern>
        </defs>
        <rect x={ox} y={oy} width={SW} height={SH} rx={3} fill={SOFT.area} stroke={SOFT.areaStroke} strokeWidth={0.8} />
        {bands.map(b => {
          const warm = b.half || b.aligned;
          return (
            <g key={`band-${b.np.vfId}`} style={{ pointerEvents: 'none' }}>
              <path d={ptsPath(b.pts)} fill={warm ? '#f9dcc4' : '#ddd4c6'} />
              <path d={ptsPath(b.pts)} fill={warm ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} />
              <path d={ptsPath(b.pts)} fill="none" stroke={warm ? '#e07b3c' : '#a39a8d'} strokeWidth={1} strokeLinejoin="round" />
            </g>
          );
        })}
        {cutBands.map(cb => {
          const d = ptsPath(cb.pts);
          return (
            <g key={`cut-${cb.cut.vfId}`} style={{ pointerEvents: 'none' }}>
              <path d={d} fill={cb.half ? '#f9dcc4' : '#ddd4c6'} />
              <path d={d} fill={cb.half ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} />
              <path d={d} fill="none" stroke={cb.half ? '#e07b3c' : '#a39a8d'} strokeWidth={1} strokeLinejoin="round" />
            </g>
          );
        })}
        {members.map((m, i) => {
          const on = i === selectedIndex || selectedNodes.includes(m.leafId);   // seçili parça (satır ya da şema) belirgin vurgulanır
          const inSel = selLeafIds.has(m.leafId);
          const x0 = Math.min(sx(m.u0), sx(m.u1)) + I, x1 = Math.max(sx(m.u0), sx(m.u1)) - I, y0 = Math.min(sy(m.v1), sy(m.v0)) + I, y1 = Math.max(sy(m.v1), sy(m.v0)) - I;
          const lbl = memberLabels[i] ?? String(i + 1);
          const fill = on ? `url(#${gid}-part-on)` : inSel ? `url(#${gid}-part-sel)` : `url(#${gid}-part)`;
          const stroke = on ? SOFT.onStroke : inSel ? SOFT.selStroke : SOFT.partStroke;
          const path = pathToLeaf(m.leafId);
          const wMm = Math.round(m.u1 - m.u0), hMm = Math.round(m.v1 - m.v0);
          const lhGuard = fsT * 1.18;
          const caption = captionOf(m);
          const tip = `Back ${lbl} · ${caption}${m.piece.placement === 'inner' ? ` · setback ${fmt(m.piece.setback)}` : ''} · ${wMm} × ${hMm} mm${m.poly ? ' · angled (cut by rotated reference)' : ''}`
            + ` — click: select the area, click again to go one level deeper (${path.length} level${path.length === 1 ? '' : 's'}) · Shift/Ctrl+click: add another region · with a piece selected, Type / Setback / edge values apply to that piece only`;
          const pts = m.poly ? m.poly.map(q => ({ x: sx(q.x), y: sy(q.y) })) : null;
          const cx = pts ? pts.reduce((a, q) => a + q.x, 0) / pts.length : (x0 + x1) / 2;
          const cy = pts ? pts.reduce((a, q) => a + q.y, 0) / pts.length : (y0 + y1) / 2;
          const w = x1 - x0, h = y1 - y0;
          const fsz = fsT * 0.86;
          const capW = `${wMm} × ${hMm}`.length * fsz * 0.6 + 6, capH = fsz * 1.2;
          const capHit = pills.some(pp => Math.abs(pp.cx - cx) < (pp.pw + capW) / 2 && Math.abs(pp.cy - cy) < (pp.ph + capH) / 2 + lhGuard);
          const showSize = w > 58 && h > 34 && !capHit;
          const showCap = showSize && h > 50;
          const lines = 1 + (showSize ? 1 : 0) + (showCap ? 1 : 0);
          const lh = fsT * 1.18;
          const ty0 = capHit ? cy - lhGuard : cy - ((lines - 1) * lh) / 2;
          return (
            <g key={`part-${i}`} style={{ cursor: 'pointer' }} onClick={e => { stop(e); onPathClick(path, e.shiftKey || e.ctrlKey || e.metaKey); }}>
              {pts ? (
                <polygon points={pts.map(q => `${q.x},${q.y}`).join(' ')} fill={fill} stroke={stroke} strokeWidth={on ? 1.2 : 0.9} strokeLinejoin="round"><title>{tip}</title></polygon>
              ) : (
                <rect x={x0} y={y0} width={Math.max(1, w)} height={Math.max(1, h)} rx={2.5} fill={fill} stroke={stroke} strokeWidth={on ? 1.2 : 0.8} style={{ filter: SOFT.shadow }}><title>{tip}</title></rect>
              )}
              {!pts && w > 6 && h > 6 && <rect x={x0 + 1} y={y0 + 1} width={Math.max(0, w - 2)} height={Math.max(0, h - 2)} rx={1.5} fill="none" stroke="#ffffff" strokeOpacity={0.55} strokeWidth={0.8} style={{ pointerEvents: 'none' }} />}
              <text x={cx} y={ty0 + fsT * 0.36} textAnchor="middle" fontSize={fsT} fontWeight={on ? 700 : 650} fill={on ? '#ea580c' : '#8f877c'}
                fontFamily={UI_FONT} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', userSelect: 'none' }}>{lbl}</text>
              {showSize && (
                <text x={cx} y={ty0 + lh + fsz * 0.36} textAnchor="middle" fontSize={fsz} fontWeight={500} fill={on ? '#c2410c' : '#a39b90'}
                  fontFamily={UI_FONT} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', userSelect: 'none' }}>{wMm} × {hMm}</text>
              )}
              {showCap && (
                <text x={cx} y={ty0 + 2 * lh + fsz * 0.36} textAnchor="middle" fontSize={fsz * 0.92} fontWeight={600} fill="#b5ada3" letterSpacing="0.06em"
                  fontFamily={UI_FONT} style={{ textTransform: 'uppercase', pointerEvents: 'none', userSelect: 'none' }}>{caption.toUpperCase()}</text>
              )}
            </g>
          );
        })}
        {cutBands.flatMap(cb => members.flatMap((m, mi) => {
          const dx0 = Math.min(sx(m.u0), sx(m.u1)) + I, dx1 = Math.max(sx(m.u0), sx(m.u1)) - I, dy0 = Math.min(sy(m.v1), sy(m.v0)) + I, dy1 = Math.max(sy(m.v1), sy(m.v0)) - I;
          if (dx1 - dx0 < 0.5 || dy1 - dy0 < 0.5) return [];
          const part = clipPolyToConvex(cb.pts, [{ x: dx0, y: dy0 }, { x: dx1, y: dy0 }, { x: dx1, y: dy1 }, { x: dx0, y: dy1 }]);
          if (part.length < 3 || Math.abs(polyArea(part)) < 0.5) return [];
          return [(
            <g key={`cuthid-${cb.cut.vfId}-${mi}`} style={{ pointerEvents: 'none' }}>
              <path d={ptsPath(part)} fill={cb.half ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} opacity={0.4} />
              <path d={ptsPath(part)} fill="none" stroke={cb.half ? '#e8925a' : '#9a9185'} strokeWidth={0.8} strokeDasharray="3 2" opacity={0.9} strokeLinejoin="round" />
            </g>
          )];
        }))}
        {bands.flatMap(b => hiddenParts(b).map((hp, k) => (
          <g key={`hid-${b.np.vfId}-${k}`} style={{ pointerEvents: 'none' }}>
            <path d={ptsPath(hp)} fill={b.half || b.aligned ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} opacity={0.4} />
            <path d={ptsPath(hp)} fill="none" stroke={b.half || b.aligned ? '#e8925a' : '#9a9185'} strokeWidth={0.8} strokeDasharray="3 2" opacity={0.9} strokeLinejoin="round" />
          </g>
        )))}
        {zones.map(z => {
          const groove = z.kind === 'groove';
          const fill = groove ? '#fb923c' : '#78716c', line = groove ? '#c2410c' : '#44403c';
          const gb = z.groove;
          // Kanal dibi çizgisi: kanal kutusunun (parça + D payı) dip kenarı.
          const bx = gb ? (z.vertical ? (z.deepX === z.x ? gb.x : gb.x + gb.w) : 0) : z.deepX;
          const by = gb ? (z.vertical ? 0 : (z.deepY === z.y ? gb.y : gb.y + gb.h)) : z.deepY;
          return (
            <g key={z.key} style={{ pointerEvents: 'none' }}>
              {gb && <rect x={gb.x} y={gb.y} width={Math.max(0.5, gb.w)} height={Math.max(0.5, gb.h)} fill="#fff7ed" fillOpacity={0.95} stroke={line} strokeOpacity={0.5} strokeWidth={0.6} strokeDasharray="2 1.5" />}
              {z.active && gb && <rect x={gb.x - 2} y={gb.y - 2} width={gb.w + 4} height={gb.h + 4} rx={2} fill="none" stroke="#ea580c" strokeWidth={1.4} />}
              {/* Görsel ipucu: kartta kanal payının üzerindeyken kapsamdaki kanallar yanıp söner gibi belirginleşir. */}
              {grooveHint && gb && (!clearVfId || clearVfId === z.vfId) && (
                <rect x={gb.x - 3} y={gb.y - 3} width={gb.w + 6} height={gb.h + 6} rx={3} fill="#f97316" fillOpacity={0.18} stroke="#ea580c" strokeWidth={1.6} className="yago-hint-pulse" />
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
        {focusStrips.map((r, i) => {
          const sp = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
          const cl = stripClip ? clipPolyToConvex(sp, stripClip) : sp;
          return cl.length >= 3 ? <path key={`fs-${i}`} d={ptsPath(cl)} fill="#f97316" fillOpacity={0.28} stroke="#ea580c" strokeOpacity={0.55} strokeWidth={0.6} style={{ pointerEvents: 'none' }} /> : null;
        })}
        {selRegions.map(n => {
          const b = nodeBox(n);
          const pad = n.kind === 'split' ? 2.5 : 0.5;
          const shape = cuts.length ? backCutOutline(group, rect, n, cuts) : null;
          if (shape && Math.abs(polyArea(shape)) < (n.u1 - n.u0) * (n.v1 - n.v0) - 1) {
            return (
              <g key={`sel-${n.id}`} style={{ pointerEvents: 'none' }}>
                <path d={ptsPath(shape.map(q => ({ x: sx(q.x), y: sy(q.y) })))} fill="#ea580c" fillOpacity={n.kind === 'split' ? 0.05 : 0.0} stroke="#ea580c" strokeWidth={1.2} strokeLinejoin="round" strokeDasharray={n.kind === 'split' ? '5 3' : undefined} />
              </g>
            );
          }
          return (
            <g key={`sel-${n.id}`} style={{ pointerEvents: 'none' }}>
              <rect x={b.x0 - pad} y={b.y0 - pad} width={b.x1 - b.x0 + 2 * pad} height={b.y1 - b.y0 + 2 * pad} rx={3} fill="#ea580c" fillOpacity={n.kind === 'split' ? 0.05 : 0.0} stroke="#ea580c" strokeWidth={1.2} strokeDasharray={n.kind === 'split' ? '5 3' : undefined} />
            </g>
          );
        })}
        {/* Bant tık alanları bilinçli olarak seçim çerçevesi/şeritlerin ÜSTÜNDE, pill'lerin ALTINDA çizilir. */}
        {bands.map(b => {
          const np = b.np;
          const pickable = !!refPick && !np.edge;
          const splitOn = !pickable && splittable(np);
          const rj = !pickable && !np.edge ? refJoint(np) : null;
          const interactive = pickable || splitOn || !!rj || (!!np.edge && (b.na.length > 0 || b.gr.length > 0));
          // Kenar bandının değer rozetleri ayrı çizilir (bandChips); burada yalnız bölme / derz binme rozeti.
          const chipTxt = pickable || splitOn ? 'Split here' : null;   // bağlı derzin binme değerleri ayrı rozetlerde (bandChips)
          const on = false;
          const cfs = chipFs(fsT);
          const { pw: cw, ph: chh } = chipTxt ? pillSize(chipTxt, cfs) : { pw: 0, ph: 0 };
          const overlayChip = !!np.edge && !pickable;
          const spot = chipTxt ? chipSpot(b.x + b.w / 2, b.y + b.h / 2, b.vertical ? 0 : 1, b.vertical ? 1 : 0, (b.vertical ? b.h : b.w) / 2, cw) : null;
          const bx = spot?.x ?? b.x + b.w / 2, by = spot?.y ?? b.y + b.h / 2;
          const warm = b.half || b.aligned;
          return (
            <g key={`hit-${np.vfId}`} className={`yago-band pnl${chipTxt && !overlayChip ? ' on' : ''}`} style={{ cursor: interactive ? 'pointer' : 'default' }}
              onClick={interactive ? e => { stop(e); onBandClick(b); } : undefined}>
              {b.np.poly
                ? <path d={ptsPath(b.pts)} fill="transparent" stroke="transparent" strokeWidth={4} strokeLinejoin="round" className="hit" />
                : <rect x={b.x - 2} y={b.y - 2} width={b.w + 4} height={b.h + 4} fill="transparent" className="hit" />}
              <g className="hov">
                <path d={ptsPath(b.pts)} fill={warm ? '#f6c39c' : '#cbbca6'} fillOpacity={0.92} />
                <path d={ptsPath(b.pts)} fill={warm ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} />
                <path d={ptsPath(b.pts)} fill="none" stroke={warm ? '#c2410c' : '#6f6457'} strokeWidth={1.3} strokeLinejoin="round" />
              </g>
              {chipTxt && (
                <g className="chip" transform={b.vertical ? `rotate(-90 ${bx} ${by})` : undefined}>
                  {(() => { const tone = on ? CHIP.on : pickable || splitOn ? CHIP.accent : CHIP.base; return (<>
                    <rect x={bx - cw / 2} y={by - chh / 2} width={cw} height={chh} rx={chh / 2} fill={tone.fill} stroke={tone.stroke} strokeWidth={0.9} style={{ filter: CHIP_SHADOW }} />
                    <text x={bx} y={by + cfs * 0.36} textAnchor="middle" fontSize={cfs} fontWeight={700} letterSpacing="0.02em" fill={tone.text} fontFamily={UI_FONT}>{chipTxt}</text>
                  </>); })()}
                </g>
              )}
              <title>{bandTip(b)}</title>
            </g>
          );
        })}
        {/* Açılı levhanın Full/Half rozeti: kesilen kenara değen ÇAKMA parçaların binisi (kanallı parçada eğik kenar pill'i var). */}
        {cutBands.map(cb => {
          const chip = bandChips.find(c => c.vfId === cb.cut.vfId);
          const interactive = !!chip;
          const d = ptsPath(cb.pts);
          const tip = `${cb.cut.name} — angled back-reference panel: the back panel is cut along it (it keeps the side you clicked when placing).` +
            (interactive ? ` Nailed overlap ${cb.cov == null ? '(pieces differ)' : `${fmt(cb.cov)} mm`} of ${fmt(cb.t)} (${scopeTxt(cb.na)}) — click to edit.` : cb.covered ? ' Grooved pieces: edit the inset pill on the slanted edge of a selected piece.' : ' It stands outside the back panel plane, so there is no overlay to set.');
          return (
            <g key={`cuthit-${cb.cut.vfId}`} className="yago-band pnl" style={{ cursor: interactive ? 'pointer' : 'default' }}
              onClick={chip ? e => { stop(e); beginEdit({ key: chip.key, v: chip.item.txt }); } : undefined}>
              <path d={d} fill="transparent" stroke="transparent" strokeWidth={4} strokeLinejoin="round" className="hit" />
              <g className="hov">
                <path d={d} fill={cb.half ? '#f6c39c' : '#cbbca6'} fillOpacity={0.92} />
                <path d={d} fill={cb.half ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} />
                <path d={d} fill="none" stroke={cb.half ? '#c2410c' : '#6f6457'} strokeWidth={1.3} strokeLinejoin="round" />
              </g>
              <title>{tip}</title>
            </g>
          );
        })}
        {/* Kenar değer rozetleri: "On <mm>" (çakma binme) / "In <mm>" (kanal derinliği) — tık yerinde düzenler. */}
        {bandChips.map(c => {
          const hide = editing?.key === c.key;
          // İlişki rozeti (Groove / Nail): dolu koyu taş = Nail (panel kısaltılır), açık = Groove; tık çevirir.
          const relOn = !!c.toggle && c.warm;
          const acc = !relOn && (c.warm || !!c.accent);
          return (
            <g key={c.key} className="yago-band pnl on" style={{ cursor: 'pointer' }} onClick={e => { stop(e); if (c.toggle) c.toggle(); else beginEdit({ key: c.key, v: c.item.txt }); }}>
              <g className="chip" transform={c.rot ? `rotate(${c.rot.toFixed(1)} ${c.cx} ${c.cy})` : undefined}>
                <rect x={c.cx - c.pw / 2} y={c.cy - c.ph / 2} width={c.pw} height={c.ph} rx={c.ph / 2} fill={(relOn ? CHIP.on : acc ? CHIP.accent : CHIP.base).fill} stroke={(relOn ? CHIP.on : acc ? CHIP.accent : CHIP.base).stroke} strokeWidth={0.9}
                  style={{ filter: CHIP_SHADOW }} />
                {!hide && <text x={c.cx} y={c.cy + c.f * 0.36} textAnchor="middle" fontSize={c.f} fontWeight={700} letterSpacing="0.02em" fill={(relOn ? CHIP.on : acc ? CHIP.accent : CHIP.base).text} fontFamily={UI_FONT}
                  style={{ fontVariantNumeric: 'tabular-nums' }}>{c.label}</text>}
              </g>
              <title>{c.title}</title>
            </g>
          );
        })}
        {pills.map(p => {
          const { item: it, f } = p;
          const hide = editing?.key === p.key;
          if (it.kind === 'gap') {
            const gp = <DimPill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} fill="#fff7ed" stroke="#f97316" strokeWidth={1} color="#c2410c" hideText={hide} title={it.title}
              onClick={e => { stop(e); beginEdit({ key: p.key, v: it.txt }); }} />;
            return p.deg ? <g key={p.key} transform={`rotate(${p.deg.toFixed(1)} ${p.cx} ${p.cy})`}>{gp}</g> : <g key={p.key}>{gp}</g>;
          }
          if (it.passive) {
            return (
              <g key={p.key} className="yago-gap passive" style={{ cursor: 'not-allowed' }}>
                <DimPill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} fill="#f5f3ef" stroke="#d6cfc3" strokeWidth={0.9} color="#a8a29e" hideText={false} title={it.title} />
              </g>
            );
          }
          const locked = !!it.locked, edited = !locked && !!it.edited, editable = !!it.onLock;
          return (
            <g key={p.key} className={`yago-gap${locked ? ' locked' : ''}`}>
              <DimPill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} fill={locked || edited ? '#fff7ed' : '#ffffff'} stroke={edited ? '#fbbf24' : '#f97316'} strokeWidth={locked ? 1.2 : 1}
                color={locked ? '#c2410c' : edited ? '#9a3412' : '#1c1917'} hideText={hide} title={editable ? (edited ? `${it.title} (${it.lockTitle ? 'held' : 'entered'} value)` : it.title) : `${it.title} — set by the back panel bounds`}
                onClick={editable ? e => { stop(e); beginEdit({ key: p.key, v: it.txt }); } : undefined} />
              {it.onLock && p.lock && <LockBadge cx={p.lock.x} cy={p.lock.y} locked={locked} edited={edited} onClick={it.onLock} title={it.lockTitle} holdIcon={!!it.lockTitle} />}
            </g>
          );
        })}
      </svg>
      {editing && editPos && (
        <input autoFocus type="text" inputMode="decimal" value={editing.v}
          onChange={e => { setEditing({ ...editing, v: e.target.value }); previewEdit(editing.key, e.target.value); }}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancelEdit(); }}
          onClick={stop}
          style={{
            position: 'absolute', left: editPos.cx - editPos.pw / 2 - 4, top: editPos.cy - editPos.ph / 2 - 2, width: editPos.pw + 8, height: editPos.ph + 4, textAlign: 'center',
            fontFamily: UI_FONT, fontSize: editPos.f, fontWeight: 600, color: '#1c1917', fontVariantNumeric: 'tabular-nums',
            background: '#fff', border: '1px solid #f97316', borderRadius: 99, outline: 'none', boxShadow: '0 0 0 2px rgba(249,115,22,0.12)', padding: 0,
          }} />
      )}
    </div>
  );
}

/* Satır hizalama: tüm satır türleri aynı sabit sütunları kullanır; üye satırı kartta 8px içeride → sağ alan 8px dar. */
const ROW_NUM_W = 28;              // "12" ve üye "3.12" rahat sığar (Goker: numaralar dar görünüyordu)
const ROW_BTN = 'w-[22px] h-[22px] shrink-0 rounded-md flex items-center justify-center transition-colors duration-150';
const ROW_SPACER = 'w-[22px] h-[22px] shrink-0';
const ROW_ICON = 13;
const ROW_TRAIL_W = 137;          // 6 × 22px düğme (5 araç: şekil · kapak sınırı · arkalık sınırı · ok · sil + aç/kapa oku) + 5 × 1px aralık (Goker: grup sıkı dursun)
/* Seçili satır (Goker: "çok renkli, daha soft"): sıcak kemik zemin + tek ince yumuşak turuncu çizgi; numara/rozet/ok nötr koyu taş. */
const ROW_SEL_HEAD = 'bg-[#faf8f5]';
const ROW_SEL_BAR = 'pointer-events-none absolute left-0 top-[7px] bottom-[7px] w-[2px] rounded-r-full bg-orange-300/70';
const MEMBER_INSET = 8;           // grup kartı gövdesinin yatay dolgusu (px-2)
type RowKind = 'body' | 'shelf' | 'divider' | 'door' | 'back' | 'legs';
const ROW_KIND_ICON: Record<RowKind, LucideIcon> = { body: LayoutPanelTop, shelf: Rows3, divider: Columns3, door: DoorClosed, back: SendToBack, legs: Footprints };
const ROW_KIND_TITLE: Record<RowKind, string> = { body: 'Body panel', shelf: 'Shelf', divider: 'Divider', door: 'Door', back: 'Back panel', legs: 'Legs' };
const rowCardClass = (open: boolean, dragging: boolean, armed: boolean) =>
  `group/row relative flex flex-col rounded-[10px] overflow-hidden transition-[background-color,box-shadow,opacity,transform] duration-150 ease-out
   ${open ? 'bg-white ring-1 ring-[#e2dbd1] shadow-[0_1px_2px_rgba(68,64,60,0.04),0_8px_20px_-16px_rgba(68,64,60,0.25)] my-1'
     : 'bg-[#fdfcfa] ring-1 ring-[#ece7df] shadow-[0_1px_0_rgba(68,64,60,0.025)] hover:bg-white hover:ring-[#e2dbd0] hover:shadow-[0_1px_2px_rgba(68,64,60,0.04),0_4px_10px_-8px_rgba(68,64,60,0.18)]'}
   ${dragging ? 'opacity-40 scale-[0.99]' : ''}
   ${armed && !dragging ? '!ring-orange-300 !bg-white shadow-[0_6px_16px_-8px_rgba(234,88,12,0.35)] scale-[1.006]' : ''}`;
const ROW_INPUT_CLASS = 'yago-row-note flex-1 min-w-0 h-[22px] px-[5px] text-[11.5px] text-stone-700 bg-transparent border border-transparent rounded-[5px] outline-none placeholder:text-stone-300 hover:border-[#ebe5dc] focus:bg-white focus:border-orange-400/50 transition-colors';
const ROW_DEL_CLASS = `${ROW_BTN} text-stone-400 hover:bg-red-50 hover:text-red-500`;
const DROP_BAND = 'pointer-events-none h-[7px] mx-1 rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.65),0_1px_2px_rgba(180,83,9,0.3)]';

function RowTypeBadge({ kind, active, count }: { kind: RowKind; active: boolean; count?: number }) {
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
function RowDims({ w, h, t, tLetter = 'T', title }: { w?: number | null; h?: number | null; t?: number | null; tLetter?: string; title?: string }) {
  const cell = (letter: string, v: number | null | undefined, muted = false) => (
    <span className="inline-flex items-baseline w-[59px] whitespace-nowrap overflow-hidden">
      <span className="text-[11px] font-semibold text-stone-400">{letter}</span>
      <span className={`ml-[3px] text-[12px] font-medium ${muted ? 'text-stone-500' : 'text-stone-700'}`}>{fmtDim(v)}</span>
    </span>
  );
  const sep = <span className="w-px h-3 bg-[#e6e0d6] mx-[4px] self-center" />;
  return (
    <span onClick={stop} title={title} className="shrink-0 inline-flex items-baseline leading-none tabular-nums cursor-default">
      {cell('W', w)}{sep}{cell('H', h)}{sep}{cell(tLetter, t, true)}
    </span>
  );
}
const RowNum = ({ label, active, small }: { label: string; active: boolean; small?: boolean }) => (
  <span style={{ width: ROW_NUM_W }} className={`shrink-0 ${small ? 'text-[11px] tracking-[-0.02em]' : 'text-[13px]'} text-center whitespace-nowrap font-semibold tabular-nums leading-none transition-colors duration-150
    ${active ? 'text-stone-800' : 'text-stone-400 group-hover/row:text-stone-600'}`}>{label}</span>
);
/* Satır aç/kapa TEK mantık: tüm satır türlerinde başlık ya da ok tıkı aynı işi yapar (kapalı → aç + seç; açık → kapat + seçim düşer). */
const RowChevron = ({ open, onClick, title }: { open: boolean; onClick?: (e: React.MouseEvent) => void; title?: string }) => (
  <button type="button" onClick={onClick} title={title ?? (open ? 'Collapse' : 'Expand')}
    className={`${ROW_BTN} ${open ? 'text-stone-700 bg-[#f1ece4] hover:bg-[#ebe5dc]' : 'text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700'}`}>
    <ChevronRight size={ROW_ICON} strokeWidth={2.1} className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
  </button>
);
const cardActionCls = (on: boolean, tone: 'stone' | 'amber' = 'stone') =>
  `h-[26px] min-w-0 flex items-center justify-center gap-1.5 rounded-[7px] text-[11px] font-semibold tracking-[0.01em] transition-[background-color,color,box-shadow] duration-150
   ${on ? (tone === 'amber' ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-300 shadow-[0_1px_2px_rgba(217,119,6,0.18)]' : 'bg-[#44403c] text-white ring-1 ring-[#44403c] shadow-[0_1px_3px_rgba(40,30,20,0.22)]')
     : 'bg-white ring-1 ring-[#e6e0d6] text-stone-600 shadow-[0_1px_0_rgba(40,30,20,0.03)] hover:bg-[#faf7f2] hover:ring-[#dcd4c8] hover:text-stone-800'}`;
function CardAction({ icon: Icon, label, active = false, tone, title, onClick, compact }: { icon: LucideIcon; label: string; active?: boolean; tone?: 'stone' | 'amber'; title: string; onClick: () => void; compact?: boolean }) {
  return (
    <button type="button" title={title} onClick={e => { stop(e); onClick(); }} className={`${cardActionCls(active, tone)}${compact ? ' shrink-0 !h-[28px] px-2.5' : ''}`}>
      <Icon size={12} strokeWidth={2} className="shrink-0" /><span className="truncate">{label}</span>
    </button>
  );
}
function FieldBox({ label, title, accent, fixed, children }: { label: string; title?: string; accent?: boolean; fixed?: boolean; children: React.ReactNode }) {
  return (
    <div title={title} onClick={stop}
      className={`${fixed ? 'shrink-0' : 'flex-1 min-w-0'} h-[28px] pl-2 pr-1 flex items-center gap-1 rounded-[7px] bg-white transition-shadow duration-150
        ${accent ? 'ring-1 ring-orange-400/70 shadow-[0_0_0_2px_rgba(249,115,22,0.08)]' : 'ring-1 ring-[#e6e0d6] shadow-[0_1px_0_rgba(40,30,20,0.03)]'}`}>
      {label && <span className="shrink-0 text-[10px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]">{label}</span>}
      <div className="flex-1 min-w-0 flex items-center justify-end gap-0.5">{children}</div>
    </div>
  );
}
const FIELD_INPUT: React.CSSProperties = {
  width: 40, minWidth: 0, height: 22, textAlign: 'center', border: 'none', outline: 'none', background: 'transparent', padding: 0,
  fontFamily: UI_FONT, fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: '#1c1917',
};
const StepBtn = ({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button type="button" title={title} disabled={disabled} onClick={e => { stop(e); if (!disabled) onClick(); }}
    className={`w-[20px] h-[20px] shrink-0 rounded-[5px] flex items-center justify-center transition-colors duration-150
      ${disabled ? 'text-stone-300 cursor-not-allowed' : 'text-stone-500 hover:bg-[#f3efe8] hover:text-stone-800'}`}>{children}</button>
);
const IconSquareBtn = ({ icon: Icon, title, onClick }: { icon: LucideIcon; title: string; onClick: () => void }) => (
  <button type="button" title={title} onClick={e => { stop(e); onClick(); }}
    className="shrink-0 w-[28px] h-[28px] rounded-[7px] flex items-center justify-center bg-white ring-1 ring-[#e6e0d6] text-stone-500 shadow-[0_1px_0_rgba(40,30,20,0.03)] hover:bg-[#faf7f2] hover:ring-[#dcd4c8] hover:text-stone-800 transition-colors duration-150">
    <Icon size={12.5} strokeWidth={2.2} />
  </button>
);
const fmt1 = (v: number) => String(round1(v));
const unitTxt = (u: string) => <span className="shrink-0 pr-1 text-[10.5px] font-medium text-stone-400">{u}</span>;
function CountBox({ icon: Icon, label, value, title, onChange, max = 12 }: { icon: LucideIcon; label: string; value: number; title: string; onChange: (n: number) => void; max?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); }, [value]);
  const commit = () => {
    if (draft == null) return;
    const n = parseInt(draft, 10);
    setDraft(null);
    if (Number.isFinite(n) && n >= 1 && n <= max && n !== value) onChange(n);
  };
  return (
    <FieldBox label="" title={title}>
      <span className="flex items-center gap-[3px] pr-0.5 mr-auto text-[10px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]"><Icon size={11} strokeWidth={2} />{label}</span>
      <StepBtn title="Fewer pieces" disabled={value <= 1} onClick={() => onChange(value - 1)}><Minus size={10} strokeWidth={2.2} /></StepBtn>
      <input type="text" inputMode="numeric" value={draft ?? String(value)} onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); if (e.key === 'ArrowUp') { e.preventDefault(); if (value < max) onChange(value + 1); } if (e.key === 'ArrowDown') { e.preventDefault(); if (value > 1) onChange(value - 1); } }} onClick={stop}
        className="yago-field" style={{ ...FIELD_INPUT, width: 24, flexShrink: 0 }} aria-label={`${label} pieces`} />
      <StepBtn title="More pieces" disabled={value >= max} onClick={() => onChange(value + 1)}><Plus size={10} strokeWidth={2.2} /></StepBtn>
    </FieldBox>
  );
}
/** Arkalık kartı için KOMPAKT sayı kutusu: [ikon][−][n][+] — etiket yerine bölme ikonu (V / H), dar satıra sığar. */
function CountMini({ icon: Icon, value, title, onChange, max = 12 }: { icon: LucideIcon; value: number; title: string; onChange: (n: number) => void; max?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); }, [value]);
  const commit = () => {
    if (draft == null) return;
    const n = parseInt(draft, 10);
    setDraft(null);
    if (Number.isFinite(n) && n >= 1 && n <= max && n !== value) onChange(n);
  };
  const step = (d: number, dis: boolean) => (
    <button type="button" disabled={dis} title={d < 0 ? 'Fewer pieces' : 'More pieces'} onClick={e => { stop(e); if (!dis) onChange(value + d); }}
      className={`w-[14px] h-[18px] shrink-0 rounded-[4px] flex items-center justify-center ${dis ? 'text-stone-300 cursor-not-allowed' : 'text-stone-500 hover:bg-[#f3efe8] hover:text-stone-800'}`}>
      {d < 0 ? <Minus size={9} strokeWidth={2.4} /> : <Plus size={9} strokeWidth={2.4} />}
    </button>
  );
  return (
    <div title={title} onClick={stop} className="min-w-0 h-full min-h-[26px] px-[2px] flex items-center justify-between gap-0 overflow-hidden rounded-[7px] bg-white ring-1 ring-[#e6e0d6] shadow-[0_1px_0_rgba(40,30,20,0.03)]">
      <Icon size={12} strokeWidth={2} className="shrink-0 text-[#a8a29e] ml-[1px]" />
      {step(-1, value <= 1)}
      <input type="text" inputMode="numeric" value={draft ?? String(value)} onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); if (e.key === 'ArrowUp') { e.preventDefault(); if (value < max) onChange(value + 1); } if (e.key === 'ArrowDown') { e.preventDefault(); if (value > 1) onChange(value - 1); } }} onClick={stop}
        className="yago-field" style={{ ...FIELD_INPUT, width: 18, flexShrink: 0 }} />
      {step(1, value >= max)}
    </div>
  );
}
/** Spacing kutusu: hedef parça ölçüsü (mm); boş girilirse hedef kalkar (parçalar olduğu gibi kalır). */
function SizeBox({ icon: Icon, label, value, title, onChange }: { icon: LucideIcon; label: string; value: number | null; title: string; onChange: (mm: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); }, [value]);
  const commit = () => {
    if (draft == null) return;
    const t = draft.trim();
    setDraft(null);
    if (t === '') { if (value != null) onChange(null); return; }
    const v = parseFloat(t.replace(',', '.'));
    if (Number.isFinite(v) && v > 0 && v !== value) onChange(v);
  };
  return (
    <FieldBox label="" title={title} accent={value != null}>
      <span className="flex items-center gap-[3px] pr-0.5 mr-auto text-[10px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]"><Icon size={11} strokeWidth={2} />{label}</span>
      <input type="text" inputMode="decimal" value={draft ?? (value != null ? String(value) : '')} placeholder="mm" onChange={e => setDraft(e.target.value)}
        onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }} onClick={stop}
        className="yago-field" style={{ ...FIELD_INPUT, width: 44, textAlign: 'right', ...(value != null ? { color: '#9a3412' } : {}) }} aria-label={`${label} target size`} />
      {value != null && (
        <button type="button" title="Clear the spacing target (the current pieces stay; change them with Count)" aria-label={`Clear ${label} target size`}
          onClick={e => { stop(e); setDraft(null); onChange(null); }}
          className="shrink-0 w-[18px] h-[18px] rounded-md flex items-center justify-center text-stone-400 hover:bg-[#f5f2ec] hover:text-stone-700 transition-colors"><X size={11} strokeWidth={2.4} /></button>
      )}
    </FieldBox>
  );
}
function SplitModeSelect({ value, onChange }: { value: 'count' | 'ref' | 'spacing'; onChange: (v: 'count' | 'ref' | 'spacing') => void }) {
  const titles = {
    count: 'Count — split the selected region by number of pieces (V side by side · H stacked)',
    ref: 'Panel ref — click a door-reference divider / shelf (3D view or schematic): the door splits through its middle; door sizes stay, afterwards Left / Center / Right moves the panel',
    spacing: 'Spacing — split by target piece size (mm); the number of pieces follows the region length and body resizes',
  };
  return (
    <div className="relative shrink-0" onClick={stop} title={titles[value]}>
      <select value={value} onChange={e => onChange(e.target.value as 'count' | 'ref' | 'spacing')}
        className="h-[28px] pl-2.5 pr-7 rounded-[7px] bg-white ring-1 ring-[#e6e0d6] shadow-[0_1px_0_rgba(40,30,20,0.03)] text-[11.5px] font-semibold text-stone-700 appearance-none outline-none cursor-pointer hover:ring-[#dcd4c8] focus:ring-orange-400/60 transition-shadow duration-150"
        style={{ fontFamily: UI_FONT }}>
        <option value="count">Count</option>
        <option value="ref">Panel ref</option>
        <option value="spacing">Spacing</option>
      </select>
      <ChevronDown size={12} strokeWidth={2.2} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-stone-400" />
    </div>
  );
}
/** Arkalık seçme şeridinde tip. */
function BackTypeSelect({ value, onChange }: { value: BackPlacement; onChange: (v: BackPlacement) => void }) {
  return (
    <div className="relative shrink-0" onClick={stop} title={BACK_TYPE_TITLE[value]}>
      <select value={value} onChange={e => onChange(e.target.value as BackPlacement)}
        className="h-[28px] pl-2.5 pr-7 rounded-[7px] bg-white ring-1 ring-[#e6e0d6] shadow-[0_1px_0_rgba(40,30,20,0.03)] text-[11.5px] font-semibold text-stone-700 appearance-none outline-none cursor-pointer hover:ring-[#dcd4c8] focus:ring-orange-400/60 transition-shadow duration-150"
        style={{ fontFamily: UI_FONT }}>
        <option value="outer">{BACK_TYPE_LABEL.outer}</option>
        <option value="inner">{BACK_TYPE_LABEL.inner}</option>
      </select>
      <ChevronDown size={12} strokeWidth={2.2} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-stone-400" />
    </div>
  );
}
function PlacementSelect({ value, onChange }: { value: 'outer' | 'inner'; onChange: (v: 'outer' | 'inner') => void }) {
  return (
    <div className="relative shrink-0" onClick={stop}
      title={value === 'outer' ? 'Outer door — over the reference panels, in front of them' : 'Inner (inset) door — between the reference panels, flush with their front'}>
      <select value={value} onChange={e => onChange(e.target.value as 'outer' | 'inner')}
        className="h-[28px] pl-2.5 pr-7 rounded-[7px] bg-white ring-1 ring-[#e6e0d6] shadow-[0_1px_0_rgba(40,30,20,0.03)] text-[11.5px] font-semibold text-stone-700 appearance-none outline-none cursor-pointer hover:ring-[#dcd4c8] focus:ring-orange-400/60 transition-shadow duration-150"
        style={{ fontFamily: UI_FONT }}>
        <option value="outer">Outer</option>
        <option value="inner">Inner</option>
      </select>
      <ChevronDown size={12} strokeWidth={2.2} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-stone-400" />
    </div>
  );
}

const SectionHead = ({ label, count, rule = true, className = 'px-1 pt-2 pb-1' }: { label: string; count?: number; rule?: boolean; className?: string }) => (
  <div className={`${className} flex items-center gap-2`}>
    <span style={SECTION_LABEL}>{label}</span>
    {count != null && <span className="text-[10.5px] font-medium tabular-nums text-stone-300">{count}</span>}
    {rule && <div className="flex-1 h-px bg-[#efeae2]" />}
  </div>
);

const LIST_CSS = `@keyframes yagoExpand{from{opacity:0;clip-path:inset(0 0 100% 0);transform:translateY(-4px)}to{opacity:1;clip-path:inset(0 0 0 0);transform:none}}.yago-expand{animation:yagoExpand 260ms cubic-bezier(.2,.7,.2,1) both}`;

type StepEdit = { id: string; v: string } | null;

/* ───────────────────────────── HIZLI GÖVDE (Body) ─────────────────────────────
   Tek seferlik yapılandırma: taban (Plain / Legs / Plinth), dört köşenin birleşimi (yalnız büyütülmüş köşe detayları — hangi panel üstten biniyor),
   baza / ayak ölçüleri (yan görünüş + plan), arkalık (arkalık kartıyla aynı kesit diyagramı). Onay → QuickBodyService.applyQuickBody.
   Görsel dil arkalık kartıyla ortak: HintCell + diyagram vurgusu, FIELD_INPUT, BackTypeButtons, BackGrooveDiagram. */
const QB_BASE_ITEMS: SegItem[] = [
  { key: 'plain', label: 'Plain', title: 'Sits on the floor: bottom panel at the base, any corner joints' },
  { key: 'legs', label: 'Legs', title: 'On legs: the cube is the total height — panels sit leg-height above the floor, legs underneath' },
  { key: 'plinth', label: 'Plinth', title: 'Plinth: sides reach the floor, bottom panel raised by the plinth height, kick panels front / rear' },
];
const QB_CORNER_TITLE: Record<CornerKey, string> = { tl: 'Top-left', tr: 'Top-right', bl: 'Bottom-left', br: 'Bottom-right' };

/** Taslaklı sayı girişi (arkalık kartının numInput'u gibi): Enter / blur onaylar, Esc geri alır. */
function QbNum({ value, onCommit, passive, w = 34, min = 0, max }: { value: number; onCommit: (v: number) => void; passive?: boolean; w?: number; min?: number; max?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); }, [value]);
  const commit = () => {
    if (draft == null) return;
    const v = parseFloat(draft.replace(',', '.')); setDraft(null);
    if (!Number.isFinite(v)) return;
    const c = Math.min(max ?? Infinity, Math.max(min, v));
    if (Math.abs(c - value) > 1e-6) onCommit(round1(c));
  };
  return (
    <input type="text" inputMode="decimal" value={passive ? '—' : draft ?? fmt1(value)} disabled={passive}
      onChange={e => setDraft(e.target.value)} onBlur={commit} onFocus={e => e.target.select()}
      onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }} onClick={stop}
      className="yago-field" style={{ ...FIELD_INPUT, width: w, flexShrink: 0, textAlign: 'right', ...(passive ? { color: '#c7beb1', cursor: 'default' } : {}) }} />
  );
}
/** Küçük anahtar (koyu = açık). */
function QbSwitch({ on, onToggle, title, disabled }: { on: boolean; onToggle: () => void; title?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} title={title} disabled={disabled} onClick={e => { stop(e); if (!disabled) onToggle(); }}
      className={`relative shrink-0 w-[28px] h-[16px] rounded-full transition-colors duration-150 ${disabled ? 'bg-[#ebe5dc] cursor-not-allowed' : on ? 'bg-[#44403c]' : 'bg-[#d6cfc3] hover:bg-[#c9c1b4]'}`}>
      <span className={`absolute top-[2px] w-[12px] h-[12px] rounded-full bg-white shadow-[0_1px_2px_rgba(40,30,20,0.3)] transition-[left] duration-150 ${on ? 'left-[14px]' : 'left-[2px]'}`} />
    </button>
  );
}
/** Küçük seçim kutusu (adet gibi). */
function QbSelect<T extends string>({ value, options, onChange, passive, w = 44 }: { value: T; options: Array<{ v: T; label: string }>; onChange: (v: T) => void; passive?: boolean; w?: number }) {
  return (
    <select value={value} disabled={passive} onChange={e => onChange(e.target.value as T)} onClick={stop}
      className="yago-field appearance-none cursor-pointer"
      style={{ ...FIELD_INPUT, width: w, flexShrink: 0, textAlign: 'right', paddingRight: 2, ...(passive ? { color: '#c7beb1', cursor: 'default' } : {}) }}>
      {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
    </select>
  );
}

/* DÖRT KÖŞE: her köşe büyütülmüş birleşim detayı — hangi panelin üstten bindiği (köşeden geçtiği) görünür; tık değiştirir. */
const QB_TILE_W = 448, QB_TILE_H = 104;
function CornerJointTiles({ joins, lockBottom, active, onCorner, onHover }: {
  joins: Record<CornerKey, JoinPass>; lockBottom: boolean; active: string | null; onCorner: (c: CornerKey) => void; onHover: (c: CornerKey | null) => void;
}) {
  const O = '#ea580c', PANEL = '#ebe4d9', PANEL_S = '#a39a8d', PASS = '#d6c9b4', PASS_S = '#6b6460', TXT = '#8f877c';
  const corners: CornerKey[] = ['tl', 'tr', 'bl', 'br'];
  const TW = 104, TH = QB_TILE_H, GAP = (QB_TILE_W - 4 * TW) / 5;
  const BOX_W = 74, BOX_H = 54, T = 16;
  return (
    <svg viewBox={`0 0 ${QB_TILE_W} ${QB_TILE_H}`} preserveAspectRatio="xMidYMid meet" className="block w-full" aria-hidden>
      {corners.map((c, i) => {
        const x = GAP + i * (TW + GAP), locked = lockBottom && (c === 'bl' || c === 'br');
        const side = joins[c] === 'side', hi = active === `c-${c}`;
        const left = c === 'tl' || c === 'bl', top = c === 'tl' || c === 'tr';
        const bx = x + (TW - BOX_W) / 2, by = 8;
        // Köşe kutusu: dış köşe kutunun o köşesinde; yan şerit dikey, üst/alt şerit yatay.
        const vx = left ? bx : bx + BOX_W - T;              // yan şeridin x'i
        const hy = top ? by : by + BOX_H - T;               // yatay şeridin y'si
        const vRect = { x: vx, y: side ? by : (top ? by + T : by), w: T, h: side ? BOX_H : BOX_H - T };
        const hRect = { x: side ? (left ? bx + T : bx) : bx, y: hy, w: side ? BOX_W - T : BOX_W, h: T };
        const passRect = side ? vRect : hRect, buttRect = side ? hRect : vRect;
        const fillP = locked ? '#ddd6cb' : hi ? '#fdba74' : PASS, strokeP = locked ? '#b8aea0' : hi ? O : PASS_S;
        const label = side ? 'Side passes' : (top ? 'Top passes' : 'Bottom passes');
        // Eğik çizgi: geçen panelin ucu, binen köşeyi ok ile işaret
        return (
          <g key={c} onClick={e => { stop(e); if (!locked) onCorner(c); }} onMouseEnter={() => onHover(c)} onMouseLeave={() => onHover(null)} style={{ cursor: locked ? 'default' : 'pointer' }}>
            <title>{`${QB_CORNER_TITLE[c]}: ${side ? 'side panel passes the corner — top/bottom sits between the sides' : 'top/bottom panel passes the corner — side sits between'}${locked ? ' · fixed in plinth mode (sides reach the floor)' : ' · click to swap'}`}</title>
            <rect x={x} y={1} width={TW} height={TH - 2} rx={8} fill={hi && !locked ? '#fff7f0' : '#ffffff'} stroke={hi && !locked ? O : '#e6e0d6'} strokeWidth={hi && !locked ? 1.3 : 1} />
            {/* iç boşluk */}
            <rect x={bx} y={by} width={BOX_W} height={BOX_H} fill="#f6f2ec" stroke="none" />
            <rect x={buttRect.x} y={buttRect.y} width={buttRect.w} height={buttRect.h} fill={locked ? '#efe9df' : PANEL} stroke={locked ? '#cfc7bb' : PANEL_S} strokeWidth={1} />
            <rect x={passRect.x} y={passRect.y} width={passRect.w} height={passRect.h} fill={fillP} stroke={strokeP} strokeWidth={1.2} />
            {/* kalınlık kenar çizgisi: geçen panelin görünen ucu */}
            <line x1={side ? vx + (left ? T : 0) : (left ? bx : bx + BOX_W)} y1={side ? (top ? by : by + BOX_H) : hy + (top ? T : 0)}
              x2={side ? vx + (left ? T : 0) : (left ? bx + T : bx + BOX_W - T)} y2={side ? (top ? by + T : by + BOX_H - T) : hy + (top ? T : 0)}
              stroke={strokeP} strokeWidth={1.2} />
            <text x={x + TW / 2} y={TH - 24} fontSize={10} fontWeight={700} fill={locked ? '#b8aea0' : hi ? O : '#57534e'} textAnchor="middle" fontFamily={UI_FONT}>{QB_CORNER_TITLE[c]}</text>
            <text x={x + TW / 2} y={TH - 11} fontSize={9.4} fontWeight={600} fill={locked ? '#c7beb1' : TXT} textAnchor="middle" fontFamily={UI_FONT}>{locked ? `${label} · fixed` : label}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* Plan görünüşü (üstten; ön altta): ayak yerleri, Ø, yan / ön / arka mesafeleri. Tam genişlik. */
const QB_PLAN_W = 448, QB_PLAN_H = 176;
function LegsPlanDiagram({ legs, W, D, active, className }: {
  legs: { count: number; diameter: number; side: number; front: number; rear: number }; W: number; D: number; active: string | null; className?: string;
}) {
  const VW = QB_PLAN_W, VH = QB_PLAN_H;
  const O = '#ea580c', OF = '#fdba74', MUTE = '#b8aea0', TXT = '#8f877c', DARK = '#57534e';
  const on = (k: string) => active === k;
  const PX0 = 64, PW = VW - PX0 - 70, PY0 = 22, PH = VH - PY0 - 26;
  const s = Math.max(1e-6, Math.min(PW / W, PH / D));
  const w = W * s, d = D * s, x0 = PX0 + (PW - w) / 2, y0 = PY0 + (PH - d) / 2, x1 = x0 + w, y1 = y0 + d;
  const r = Math.max(3, (legs.diameter / 2) * s);
  const spots = legSpots({ count: (legs.count || 4) as 4 | 5 | 6, side: legs.side, front: legs.front, rear: legs.rear }, W, D).map(p => ({ x: x0 + p.x * s, y: y0 + p.z * s }));   // ön (+Z) altta
  const hi = on('ld') || on('lc');
  const dim = (xa: number, ya: number, xb: number, yb: number, k: string) => {
    const h = on(k); const vert = Math.abs(xb - xa) < 0.01;
    return (
      <g stroke={h ? O : MUTE} strokeWidth={h ? 1.4 : 0.9}>
        <line x1={xa} y1={ya} x2={xb} y2={yb} />
        {vert ? <><line x1={xa - 3.5} y1={ya} x2={xa + 3.5} y2={ya} /><line x1={xb - 3.5} y1={yb} x2={xb + 3.5} y2={yb} /></>
          : <><line x1={xa} y1={ya - 3.5} x2={xa} y2={ya + 3.5} /><line x1={xb} y1={yb - 3.5} x2={xb} y2={yb + 3.5} /></>}
      </g>
    );
  };
  const txt = (x: number, y: number, str: string, k: string, anchor: 'start' | 'middle' | 'end' = 'middle') => (
    <text x={x} y={y} fontSize={10.5} fontWeight={700} fill={on(k) ? O : DARK} textAnchor={anchor} fontFamily={UI_FONT} style={{ fontVariantNumeric: 'tabular-nums' }}>{str}</text>
  );
  const first = spots[0], rearLeg = spots[3] ?? spots[2];
  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet" className={`block rounded-[8px] bg-[#faf7f2] ring-1 ring-[#ebe5dc] ${className ?? ''}`} aria-hidden>
      <text x={10} y={13} fontSize={9.4} fill={TXT} fontFamily={UI_FONT}>plan view · rear at top</text>
      <text x={10} y={VH - 8} fontSize={9.4} fill={TXT} fontFamily={UI_FONT}>front ↓</text>
      <rect x={x0} y={y0} width={w} height={d} fill="#f3ede4" stroke="#a39a8d" strokeWidth={1} />
      <text x={(x0 + x1) / 2} y={y0 - 7} fontSize={9.4} fill={TXT} fontFamily={UI_FONT} textAnchor="middle">{`W ${fmt1(W)}`}</text>
      <text x={x1 + 44} y={(y0 + y1) / 2 + 3} fontSize={9.4} fill={TXT} fontFamily={UI_FONT}>{`D ${fmt1(D)}`}</text>
      {spots.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={r + 3} fill="none" stroke={hi ? O : '#cfc7bb'} strokeWidth={0.7} strokeDasharray="1.8 1.8" />
          <circle cx={p.x} cy={p.y} r={r} fill={hi ? OF : '#d9d2c6'} stroke={hi ? O : '#78716c'} strokeWidth={1} />
          <line x1={p.x - r * 0.45} y1={p.y} x2={p.x + r * 0.45} y2={p.y} stroke={hi ? O : '#78716c'} strokeWidth={0.7} />
          <line x1={p.x} y1={p.y - r * 0.45} x2={p.x} y2={p.y + r * 0.45} stroke={hi ? O : '#78716c'} strokeWidth={0.7} />
        </g>
      ))}
      {/* Ölçüler dışarıda: yan = altta (x0 → ön-sol ayak), ön = solda (ön-sol ayak → ön kenar), arka = sağda (arka kenar → arka-sağ ayak) */}
      {first && <>{dim(x0, y1 + 11, first.x, y1 + 11, 'ls')}<line x1={first.x} y1={first.y} x2={first.x} y2={y1 + 14} stroke={MUTE} strokeWidth={0.6} strokeDasharray="1.5 1.5" />{txt((x0 + first.x) / 2, y1 + 23, fmt1(legs.side), 'ls')}</>}
      {first && <>{dim(x0 - 11, first.y, x0 - 11, y1, 'lf')}<line x1={x0 - 14} y1={first.y} x2={first.x} y2={first.y} stroke={MUTE} strokeWidth={0.6} strokeDasharray="1.5 1.5" />{txt(x0 - 15, (first.y + y1) / 2 + 4, fmt1(legs.front), 'lf', 'end')}</>}
      {rearLeg && <>{dim(x1 + 11, y0, x1 + 11, rearLeg.y, 'lr')}<line x1={rearLeg.x} y1={rearLeg.y} x2={x1 + 14} y2={rearLeg.y} stroke={MUTE} strokeWidth={0.6} strokeDasharray="1.5 1.5" />{txt(x1 + 15, (y0 + rearLeg.y) / 2 + 4, fmt1(legs.rear), 'lr', 'start')}</>}
      {spots[2] && txt(spots[2].x + r + 5, spots[2].y + 4, `Ø ${fmt1(legs.diameter)}`, 'ld', 'start')}
      {txt(x1 - 4, y1 - 6 - r * 2 - 4, `${legs.count || 4} legs`, 'lc', 'end')}
    </svg>
  );
}

/* Ayak bloğu: plan diyagramı (tam genişlik) + 3 sütun hücre. Hızlı gövde ve kalıcı Legs satırı ortak kullanır. */
const QB_CELL_ROW = { gridAutoRows: `${BACK_ROW_H}px`, rowGap: BACK_ROW_GAP } as const;
function LegsBlock({ legs, W, D, heightReadout, heightEditable, countOptions, onChange, hint, onHint }: {
  legs: { count: number; height: number; diameter: number; side: number; front: number; rear: number }; W: number; D: number;
  heightReadout?: number; heightEditable?: boolean; /** boş = adet hücresi yok (adet gövde bloğunda seçilir) */ countOptions: number[]; onChange: (p: Partial<{ count: number; height: number; diameter: number; side: number; front: number; rear: number }>) => void;
  hint: string | null; onHint: (k: string | null) => void;
}) {
  const h = heightReadout ?? legs.height;
  return (
    <div className="flex flex-col gap-1.5" onMouseLeave={() => onHint(null)}>
      <LegsPlanDiagram legs={legs} W={W} D={D} active={hint} className="w-full" />
      <div className="grid grid-cols-3 gap-x-1" style={QB_CELL_ROW}>
        {countOptions.length > 0 ? (
          <HintCell label="Legs" hintKey="lc" active={hint === 'lc'} onHint={onHint}>
            <QbSelect value={String(legs.count)} options={countOptions.map(n => ({ v: String(n), label: n === 0 ? 'None' : String(n) }))} onChange={v => onChange({ count: parseInt(v, 10) })} />
          </HintCell>
        ) : (
          <div className="min-w-0 h-full pl-2 pr-1.5 flex items-center gap-1 rounded-[7px] bg-[#f6f2ec]" title="Leg layout">
            <span className="flex-1 min-w-0 truncate text-[10px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]">Layout</span>
            <span className="whitespace-nowrap text-[11px] font-semibold text-stone-500">{legs.count === 5 ? '4 + centre' : legs.count === 6 ? '4 + front/rear' : 'corners'}</span>
          </div>
        )}
        <HintCell label="Ø" hintKey="ld" active={hint === 'ld'} onHint={onHint}><QbNum value={legs.diameter} min={5} onCommit={v => onChange({ diameter: v })} /></HintCell>
        <HintCell label="Height" hintKey="lh" active={hint === 'lh'} onHint={onHint} passive={!heightEditable}>
          {heightEditable ? <QbNum value={legs.height} min={1} onCommit={v => onChange({ height: v })} />
            : <span className="whitespace-nowrap pr-1" style={{ ...FIELD_INPUT, width: 'auto', color: countOptions.length ? '#57534e' : '#c7beb1' }} title={countOptions.length ? "Read from the bottom panel's underside" : '= plinth height'}>{fmt1(h)}</span>}
        </HintCell>
        <HintCell label="Side" hintKey="ls" active={hint === 'ls'} onHint={onHint}><QbNum value={legs.side} onCommit={v => onChange({ side: v })} /></HintCell>
        <HintCell label="Front" hintKey="lf" active={hint === 'lf'} onHint={onHint}><QbNum value={legs.front} onCommit={v => onChange({ front: v })} /></HintCell>
        <HintCell label="Rear" hintKey="lr" active={hint === 'lr'} onHint={onHint}><QbNum value={legs.rear} onCommit={v => onChange({ rear: v })} /></HintCell>
      </div>
    </div>
  );
}

/* HIZLI GÖVDE PANELİ — liste alanının üstünde (kaydırılan alanda; üst şerit yapışık). Diyagramlar tam genişlik, hücreler altında 3 sütun. */
function QuickBodyPanel({ shape, cfg, setCfg, busy, existingCount, onApply, onExit }: {
  shape: Shape; cfg: QuickBodyConfig; setCfg: (p: Partial<QuickBodyConfig>) => void; busy: boolean; existingCount: number; onApply: () => void; onExit: () => void;
}) {
  const [hint, setHint] = useState<string | null>(null);
  const onHint = (k: string | null) => setHint(k);
  const bb = localBboxOf(effectiveBodyGeometry(shape));
  const W = bb ? bb.max.x - bb.min.x : 600, H = bb ? bb.max.y - bb.min.y : 720, D = bb ? bb.max.z - bb.min.z : 560;
  const joins = effectiveJoins(cfg);
  const isPlinth = cfg.base === 'plinth', isLegs = cfg.base === 'legs';
  const legCount = isLegs ? (cfg.legs.count || 4) : isPlinth ? cfg.legs.count : 0;
  const panelCount = 4 + (isPlinth ? 1 + (cfg.plinth.rearPlinth ? 1 : 0) : 0);
  const { cyclic } = panelOrderFor(joins);
  // Taban değişince ayak: Legs → en az 4; Plinth → otomatik None (Goker); Plain → yok.
  const setBase = (b: QuickBodyBase) => setCfg({ base: b, legs: { ...cfg.legs, count: b === 'legs' ? (cfg.legs.count || 4) : 0 } });
  const toggleCorner = (c: CornerKey) => setCfg({ joins: { ...cfg.joins, [c]: cfg.joins[c] === 'side' ? 'horiz' : 'side' } });
  const b = cfg.back; const grooved = b.placement === 'inner';
  const status = busy ? 'Building panels…' : cyclic ? 'Corner joints form a cycle — sides will pass first' : `${existingCount ? `${existingCount} panel${existingCount === 1 ? '' : 's'} already on the body · ` : ''}${panelCount} panels${b.enabled ? ' + back' : ''}${legCount ? ` + ${legCount} legs` : ''}`;
  return (
    <div style={{ fontFamily: UI_FONT }}>
      <div className="sticky top-0 z-[3]" style={{ ...DOCK_SHELL, marginTop: 0, borderRadius: 0, border: 'none', borderBottom: '1px solid #ebe5dc', boxShadow: 'none', background: 'linear-gradient(180deg,#fefdfb 0%,#faf8f4 100%)' }}>
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
          <HintCell label="Thick" hintKey="t" active={hint === 't'} onHint={onHint}><QbNum value={cfg.thickness} min={1} onCommit={v => setCfg({ thickness: v })} /></HintCell>
          <HintCell label="Plinth" hintKey="ph" active={hint === 'ph'} onHint={onHint} passive={!isPlinth}><QbNum value={cfg.plinth.height} min={1} passive={!isPlinth} onCommit={v => setCfg({ plinth: { ...cfg.plinth, height: v } })} /></HintCell>
          <HintCell label="Front" hintKey="pf" active={hint === 'pf'} onHint={onHint} passive={!isPlinth}><QbNum value={cfg.plinth.front} passive={!isPlinth} onCommit={v => setCfg({ plinth: { ...cfg.plinth, front: v } })} /></HintCell>
          <HintCell label="Rear" hintKey="pr" active={hint === 'pr'} onHint={onHint} passive={!isPlinth}>
            <QbSwitch on={cfg.plinth.rearPlinth} disabled={!isPlinth} title="Rear plinth on / off" onToggle={() => setCfg({ plinth: { ...cfg.plinth, rearPlinth: !cfg.plinth.rearPlinth } })} />
            <QbNum value={cfg.plinth.rear} passive={!isPlinth || !cfg.plinth.rearPlinth} w={30} onCommit={v => setCfg({ plinth: { ...cfg.plinth, rear: v } })} />
          </HintCell>
          <HintCell label="Legs" hintKey="lc" active={hint === 'lc'} onHint={onHint} passive={cfg.base === 'plain'}>
            <QbSelect value={String(legCount)} passive={cfg.base === 'plain'} options={(isLegs ? [4, 5, 6] : [0, 4, 5, 6]).map(n => ({ v: String(n), label: n === 0 ? 'None' : String(n) }))}
              onChange={v => setCfg({ legs: { ...cfg.legs, count: parseInt(v, 10) as 0 | 4 | 5 | 6 } })} />
          </HintCell>
          <HintCell label="Leg H" hintKey="lh" active={hint === 'lh'} onHint={onHint} passive={!isLegs}>
            {isLegs ? <QbNum value={cfg.legs.height} min={1} onCommit={v => setCfg({ legs: { ...cfg.legs, height: v } })} />
              : <span className="whitespace-nowrap pr-1" style={{ ...FIELD_INPUT, width: 'auto', color: '#c7beb1' }}>{isPlinth && legCount ? fmt1(cfg.plinth.height) : '—'}</span>}
          </HintCell>
          <HintCell label="Back" hintKey="bt" active={hint === 'bt'} onHint={onHint}>
            <QbSelect value={b.enabled ? b.placement : 'none'} w={70} options={[{ v: 'outer', label: BACK_TYPE_LABEL.outer }, { v: 'inner', label: BACK_TYPE_LABEL.inner }, { v: 'none', label: 'None' }]}
              onChange={v => setCfg({ back: v === 'none' ? { ...b, enabled: false } : { ...b, enabled: true, placement: v } })} />
          </HintCell>
          <div className="col-span-2 min-w-0 h-full pl-2 pr-1.5 flex items-center gap-1 rounded-[7px] bg-[#f6f2ec]" title="Body size W × H × D">
            <span className="flex-1 min-w-0 truncate text-[10px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]">Size</span>
            <span className="whitespace-nowrap text-[11px] font-semibold text-stone-500 tabular-nums">{fmt1(W)} × {fmt1(H)} × {fmt1(D)}</span>
          </div>
        </div>
        {/* AYAKLAR */}
        {legCount > 0 && (
          <>
            <SectionHead label="Legs" className="px-0.5 pt-2.5 pb-1" />
            <LegsBlock legs={{ ...cfg.legs, count: legCount, height: isPlinth ? cfg.plinth.height : cfg.legs.height }} W={W} D={D} heightEditable={isLegs} heightReadout={isPlinth ? cfg.plinth.height : undefined}
              countOptions={[]} hint={hint} onHint={onHint}
              onChange={p => setCfg({ legs: { ...cfg.legs, ...(p as Partial<QuickBodyConfig['legs']>) } })} />
          </>
        )}
        {/* ARKALIK: arkalık kartıyla aynı kesit diyagramı, büyük */}
        {b.enabled && (
          <>
            <SectionHead label="Back panel" className="px-0.5 pt-2.5 pb-1" />
            <div className="flex flex-col gap-1.5">
              <div className="w-full flex" style={{ height: 200 }}>
                <BackGrooveDiagram active={hint === 'bi' ? 'in' : hint && hint.startsWith('b') ? hint.slice(1) : null} grooved={grooved} t={b.thickness} setback={grooved ? b.setback : 0} front={b.clear.front} rear={b.clear.back} depth={b.clear.depth} inset={b.inset} className="w-full h-full" />
              </div>
              <div className="grid grid-cols-3 gap-x-1" style={QB_CELL_ROW}>
                <HintCell label="Thick" hintKey="bt" active={hint === 'bt'} onHint={onHint}><QbNum value={b.thickness} min={1} onCommit={v => setCfg({ back: { ...b, thickness: v } })} /></HintCell>
                <HintCell label="In" hintKey="bi" active={hint === 'bi'} onHint={onHint} passive={!grooved}><QbNum value={b.inset} passive={!grooved} onCommit={v => setCfg({ back: { ...b, inset: v } })} /></HintCell>
                <HintCell label="Setback" hintKey="bsetback" active={hint === 'bsetback'} onHint={onHint} passive={!grooved}><QbNum value={b.setback} passive={!grooved} onCommit={v => setCfg({ back: { ...b, setback: v } })} /></HintCell>
                <HintCell label="Front" hintKey="bgf" active={hint === 'bgf'} onHint={onHint} passive={!grooved}><QbNum value={b.clear.front} passive={!grooved} onCommit={v => setCfg({ back: { ...b, clear: { ...b.clear, front: v } } })} /></HintCell>
                <HintCell label="Rear" hintKey="bgb" active={hint === 'bgb'} onHint={onHint} passive={!grooved}><QbNum value={b.clear.back} passive={!grooved} onCommit={v => setCfg({ back: { ...b, clear: { ...b.clear, back: v } } })} /></HintCell>
                <HintCell label="Bottom" hintKey="bgd" active={hint === 'bgd'} onHint={onHint} passive={!grooved}><QbNum value={b.clear.depth} passive={!grooved} onCommit={v => setCfg({ back: { ...b, clear: { ...b.clear, depth: v } } })} /></HintCell>
                <div className={`col-span-2 min-w-0 h-full pl-2 pr-1.5 flex items-center gap-1 rounded-[7px] bg-[#f6f2ec] ${grooved ? '' : 'opacity-60'}`}>
                  <span className="flex-1 min-w-0 truncate text-[10px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]">Groove</span>
                  <span className="whitespace-nowrap" style={{ ...FIELD_INPUT, width: 'auto', color: '#57534e' }}>{grooved ? <>{fmt1(b.thickness + b.clear.front + b.clear.back)}<span className="text-[10px] font-medium text-stone-400" style={{ fontFamily: UI_FONT }}> × </span>{fmt1(b.inset + b.clear.depth)}<span className="text-[10px] font-medium text-stone-400" style={{ fontFamily: UI_FONT }}> (In {fmt1(b.inset)} + {fmt1(b.clear.depth)})</span></> : '—'}</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function PanelEditor() {
  const { selectedShapeId, shapes, updateShape,
    selectedPanelRow, setSelectedPanelRow, raycastMode, setRaycastMode,
    virtualFaces, updateVirtualFace, deleteVirtualFace, reorderVirtualFaceGroup,
    faceExtrudeMode, setFaceExtrudeMode, faceExtrudeTargetPanelId, setFaceExtrudeTargetPanelId,
    faceExtrudeSelectedFace, setFaceExtrudeSelectedFace, faceExtrudeThickness, setFaceExtrudeThickness,
    faceExtrudeClickPoint, faceExtrudeValueMode, setFaceExtrudeValueMode, faceExtrudeRefCandidate, setFaceExtrudeRefCandidate,
    faceExtrudeCavityGroupId, faceExtrudeCavityFaceNormal,
    panelMoveMode, setPanelMoveMode, panelMoveTargetPanelId, setPanelMoveTargetPanelId,
    panelMoveAxis, setPanelMoveAxis, panelMoveValue, setPanelMoveValue, panelMoveValueMode, setPanelMoveValueMode,
    panelMoveRefSourceVertex, setPanelMoveRefSourceVertex, panelMoveRefTargetPanelId, setPanelMoveRefTargetPanelId,
    panelMoveRefTargetVertex, setPanelMoveRefTargetVertex,
    panelRotateMode, setPanelRotateMode, panelRotateTargetPanelId, setPanelRotateTargetPanelId,
    panelRotatePivot, setPanelRotatePivot, panelRotateAxis, setPanelRotateAxis, panelRotateValue, setPanelRotateValue,
    panelRotateValueMode, setPanelRotateValueMode, panelRotateRefArmVertex, panelRotateRefFace,
    panelGroups, selectedPanelGroupId, setSelectedPanelGroupId,
    volumePickMode, setVolumePickMode, volumePickGroupId, volumePickCandidates, volumePickIndex,
    doorGroups, selectedDoorGroupId, setSelectedDoorGroupId, doorPickMode, setDoorPickMode, doorPickCandidates, doorPickIndex, doorPickPlacement, setDoorPickPlacement,
    doorRefPickGroupId, setDoorRefPickGroupId,
    backGroups, selectedBackGroupId, setSelectedBackGroupId, backPickMode, setBackPickMode, backPickCandidates, backPickIndex, backPickPlacement, setBackPickPlacement,
    quickBodyMode, setQuickBodyMode, quickBodyConfig, setQuickBodyConfig, quickBodyBusy, setQuickBodyBusy,
    backRefPickGroupId, setBackRefPickGroupId,
    raycastPendingVf, placementName, setPlacementName,
  } = useStoreFields('selectedShapeId', 'shapes', 'updateShape',
    'selectedPanelRow', 'setSelectedPanelRow', 'raycastMode', 'setRaycastMode',
    'virtualFaces', 'updateVirtualFace', 'deleteVirtualFace', 'reorderVirtualFaceGroup',
    'faceExtrudeMode', 'setFaceExtrudeMode', 'faceExtrudeTargetPanelId', 'setFaceExtrudeTargetPanelId',
    'faceExtrudeSelectedFace', 'setFaceExtrudeSelectedFace', 'faceExtrudeThickness', 'setFaceExtrudeThickness',
    'faceExtrudeClickPoint', 'faceExtrudeValueMode', 'setFaceExtrudeValueMode', 'faceExtrudeRefCandidate', 'setFaceExtrudeRefCandidate',
    'faceExtrudeCavityGroupId', 'faceExtrudeCavityFaceNormal',
    'panelMoveMode', 'setPanelMoveMode', 'panelMoveTargetPanelId', 'setPanelMoveTargetPanelId',
    'panelMoveAxis', 'setPanelMoveAxis', 'panelMoveValue', 'setPanelMoveValue', 'panelMoveValueMode', 'setPanelMoveValueMode',
    'panelMoveRefSourceVertex', 'setPanelMoveRefSourceVertex', 'panelMoveRefTargetPanelId', 'setPanelMoveRefTargetPanelId',
    'panelMoveRefTargetVertex', 'setPanelMoveRefTargetVertex',
    'panelRotateMode', 'setPanelRotateMode', 'panelRotateTargetPanelId', 'setPanelRotateTargetPanelId',
    'panelRotatePivot', 'setPanelRotatePivot', 'panelRotateAxis', 'setPanelRotateAxis', 'panelRotateValue', 'setPanelRotateValue',
    'panelRotateValueMode', 'setPanelRotateValueMode', 'panelRotateRefArmVertex', 'panelRotateRefFace',
    'panelGroups', 'selectedPanelGroupId', 'setSelectedPanelGroupId',
    'volumePickMode', 'setVolumePickMode', 'volumePickGroupId', 'volumePickCandidates', 'volumePickIndex',
    'doorGroups', 'selectedDoorGroupId', 'setSelectedDoorGroupId', 'doorPickMode', 'setDoorPickMode', 'doorPickCandidates', 'doorPickIndex', 'doorPickPlacement', 'setDoorPickPlacement',
    'doorRefPickGroupId', 'setDoorRefPickGroupId',
    'backGroups', 'selectedBackGroupId', 'setSelectedBackGroupId', 'backPickMode', 'setBackPickMode', 'backPickCandidates', 'backPickIndex', 'backPickPlacement', 'setBackPickPlacement',
    'backRefPickGroupId', 'setBackRefPickGroupId',
    'raycastPendingVf', 'placementName', 'setPlacementName', 'quickBodyMode', 'setQuickBodyMode', 'quickBodyConfig', 'setQuickBodyConfig', 'quickBodyBusy', 'setQuickBodyBusy');
  const [doorDraft, setDoorDraft] = useState<{ id: string; field: 't' | 'gap'; v: string } | null>(null);
  // Şema bölge seçimi (düğüm id'leri): her tık bir seviye iner; üye/3B seçimiyle bağı YOK.
  const [doorNodeSel, setDoorNodeSel] = useState<{ id: string; nodes: string[] } | null>(null);
  const [doorSplitMode, setDoorSplitMode] = useState<{ id: string; mode: 'count' | 'spacing' } | null>(null);
  const [doorAddPick, setDoorAddPick] = useState<{ id: string; axis: 'u' | 'v' } | null>(null);
  // Arkalık kartı: kalınlık/setback taslağı, şema bölge seçimi ve bölme modu (Panel ref store'da: backRefPickGroupId).
  const [backDraft, setBackDraft] = useState<{ id: string; field: 't' | 'setback' | 'gf' | 'gb' | 'gd'; v: string; scope?: string } | null>(null);
  const [backNodeSel, setBackNodeSel] = useState<{ id: string; nodes: string[] } | null>(null);
  /** Kenar bollaştırma kapsamı: seçili kenarın (sınır / derz paneli VF'si) kendi kanal payı düzenlenir; null → grup değeri. */
  const [backClearEdge, setBackClearEdge] = useState<{ id: string; vfId: string } | null>(null);
  /** Görsel ipucu: arkalık kartında üzerine gelinen / odaklanan değer (kesit diyagramı + şema vurgusu). */
  const [backHint, setBackHint] = useState<{ id: string; key: string } | null>(null);
  /** Kalıcı Legs satırının plan diyagramı ipucu. */
  const [legsHint, setLegsHint] = useState<string | null>(null);
  // Şemada seçili parçalar 3B'de vurgulanır (store.backFocusVfIds); tüm alan seçiliyse ya da seçim yoksa boş → grup vurgusu.
  useEffect(() => {
    const st = useAppStore.getState();
    const g = backNodeSel ? backGroups.find(x => x.id === backNodeSel.id) : undefined;
    if (!g || !backNodeSel || selectedBackGroupId !== g.id) { st.setBackFocusVfIds([]); return; }
    const leaves = backLeaves(g.tree).map(l => l.id);
    const want = new Set(backNodeSel.nodes.flatMap(id => { const n = findBackNode(g.tree, id); return n ? backLeaves(n).map(l => l.id) : []; }));
    const ids = leaves.flatMap((id, i) => (want.has(id) && g.memberVfIds[i] ? [g.memberVfIds[i]] : []));
    st.setBackFocusVfIds(ids.length === leaves.length ? [] : ids);
  }, [backNodeSel, backGroups, selectedBackGroupId]);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [armedRowKey, setArmedRowKey] = useState<string | null>(null);
  const [countDraft, setCountDraft] = useState<{ id: string; v: string } | null>(null);
  const [gapDraft, setGapDraft] = useState<{ id: string; v: string } | null>(null);
  // Kart açıklığı seçimden AYRI yerel durum: üye seçilince açılır ve üye editörü kapanınca da açık KALIR; yalnız chevron kapatır.
  const [openCards, setOpenCards] = useState<Set<string>>(() => new Set());
  const openCard = (id: string) => setOpenCards(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  const closeCard = (id: string, memberIds: string[]) => {
    setOpenCards(prev => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
    const st = useAppStore.getState();
    if (st.selectedPanelGroupId === id) setSelectedPanelGroupId(null);
    if (st.selectedDoorGroupId === id) setSelectedDoorGroupId(null);
    if (st.selectedBackGroupId === id) setSelectedBackGroupId(null);
    if (typeof st.selectedPanelRow === 'string' && memberIds.some(m => st.selectedPanelRow === `vf-${m}`)) setSelectedPanelRow(null);
    setDoorNodeSel(prev => (prev?.id === id ? null : prev));
    if (useAppStore.getState().doorRefPickGroupId === id) setDoorRefPickGroupId(null);
    if (useAppStore.getState().backRefPickGroupId === id) setBackRefPickGroupId(null);
    setDoorAddPick(prev => (prev?.id === id ? null : prev));
    setBackNodeSel(prev => (prev?.id === id ? null : prev));
  };
  const [stepEdit, setStepEdit] = useState<StepEdit>(null);
  const [extrudeThicknessStr, setExtrudeThicknessStr] = useState(String(faceExtrudeThickness));
  const [moveValueStr, setMoveValueStr] = useState('0');
  const [rotateValueStr, setRotateValueStr] = useState('0');
  const prevMoveAxisRef = useRef(panelMoveAxis);
  const prevRotateAxisRef = useRef(panelRotateAxis);
  const rowRefs = useRef<Map<number | string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (prevMoveAxisRef.current !== panelMoveAxis) { prevMoveAxisRef.current = panelMoveAxis; setMoveValueStr('0'); setPanelMoveValue(0); }
  }, [panelMoveAxis]);
  useEffect(() => {
    if (prevRotateAxisRef.current !== panelRotateAxis) { prevRotateAxisRef.current = panelRotateAxis; setRotateValueStr('0'); setPanelRotateValue(0); }
  }, [panelRotateAxis]);

  const selectedShape = shapeById(selectedShapeId, shapes);
  const activePanelId = useMemo(() => {
    if (!selectedShape || selectedPanelRow === null) return null;
    if (typeof selectedPanelRow === 'string' && selectedPanelRow.startsWith('vf-')) return panelOfVf(selectedPanelRow.slice(3), shapes)?.id || null;
    if (typeof selectedPanelRow === 'number') return childPanelsOf(selectedShape.id, shapes).find(s => s.parameters?.faceIndex === selectedPanelRow)?.id || null;
    return null;
  }, [selectedShape, selectedPanelRow, shapes]);
  const activePanel = shapeById(activePanelId, shapes);
  const activeDims = panelDims(activePanel);
  const activeSteps: any[] = activePanel?.parameters?.extrudeSteps || [];
  const activeTransformSteps: any[] = activePanel?.parameters?.transformSteps || [];

  useEffect(() => {
    if (typeof selectedPanelRow === 'string' && selectedPanelRow.startsWith('vf-')) {
      const vf = virtualFaces.find(f => f.id === selectedPanelRow.slice(3));
      const gid = vf?.groupId || vf?.doorGroupId || vf?.backGroupId;
      if (gid) openCard(gid);
    }
    if (selectedPanelGroupId) openCard(selectedPanelGroupId);
    if (selectedDoorGroupId) openCard(selectedDoorGroupId);
    if (selectedBackGroupId) openCard(selectedBackGroupId);
  }, [selectedPanelRow, selectedPanelGroupId, selectedDoorGroupId, selectedBackGroupId, virtualFaces]);

  // Yeni panel/grup yerleşince (Goker) öteki satırların önizlemeleri kapanır. Satır anahtarı = grup id ya da VF id; grup içi
  // bölme/adet değişimi yeni ÜYE VF üretir ama anahtar aynı kalır → tetiklemez. Yeni kapak/arkalık seçili gelir, açık kalır.
  const rowKeysRef = useRef<{ sid: string | null; keys: Set<string> } | null>(null);
  useEffect(() => {
    const keyOf = (vf: VirtualFace) => vf.groupId || vf.doorGroupId || vf.backGroupId || vf.id;
    const keys = new Set(virtualFaces.filter(vf => vf.shapeId === selectedShapeId).map(keyOf));
    const prev = rowKeysRef.current;
    rowKeysRef.current = { sid: selectedShapeId, keys };
    if (!prev || prev.sid !== selectedShapeId) return;
    const fresh = new Set([...keys].filter(k => !prev.keys.has(k)));
    if (!fresh.size) return;
    const st = useAppStore.getState();
    setOpenCards(cur => { const n = new Set([...cur].filter(id => fresh.has(id))); return n.size === cur.size ? cur : n; });
    const row = st.selectedPanelRow;
    if (row !== null) {
      const vf = typeof row === 'string' && row.startsWith('vf-') ? st.virtualFaces.find(f => f.id === row.slice(3)) : undefined;
      if (!vf || !fresh.has(keyOf(vf))) setSelectedPanelRow(null);
    }
    if (st.selectedPanelGroupId && !fresh.has(st.selectedPanelGroupId)) setSelectedPanelGroupId(null);
    if (st.selectedDoorGroupId && !fresh.has(st.selectedDoorGroupId)) setSelectedDoorGroupId(null);
    if (st.selectedBackGroupId && !fresh.has(st.selectedBackGroupId)) setSelectedBackGroupId(null);
    if (st.doorRefPickGroupId && !fresh.has(st.doorRefPickGroupId)) setDoorRefPickGroupId(null);
    if (st.backRefPickGroupId && !fresh.has(st.backRefPickGroupId)) setBackRefPickGroupId(null);
    const keep = <T extends { id: string } | null>(p: T) => (p && !fresh.has(p.id) ? null : p);
    setDoorNodeSel(keep); setDoorAddPick(keep); setBackNodeSel(keep); setBackClearEdge(keep);
  }, [virtualFaces, selectedShapeId]);

  useEffect(() => {
    if (selectedShapeId !== useAppStore.getState().selectedPanelRowParentId) setSelectedPanelRow(null);
    const st = useAppStore.getState();
    if (st.selectedPanelGroupId && !st.panelGroups.some(g => g.id === st.selectedPanelGroupId && g.shapeId === selectedShapeId)) setSelectedPanelGroupId(null);
    if (st.selectedDoorGroupId && !st.doorGroups.some(g => g.id === st.selectedDoorGroupId && g.shapeId === selectedShapeId)) setSelectedDoorGroupId(null);
    if (st.selectedBackGroupId && !st.backGroups.some(g => g.id === st.selectedBackGroupId && g.shapeId === selectedShapeId)) setSelectedBackGroupId(null);
    if (st.volumePickMode) setVolumePickMode(null);
    if (st.doorPickMode) setDoorPickMode(false);
    if (st.backPickMode) setBackPickMode(false);
    if (st.quickBodyMode) setQuickBodyMode(false);
    setOpenCards(new Set());
  }, [selectedShapeId]);
  useEffect(() => {
    if (selectedDoorGroupId && !doorGroups.some(g => g.id === selectedDoorGroupId)) setSelectedDoorGroupId(null);
    if (doorRefPickGroupId && !doorGroups.some(g => g.id === doorRefPickGroupId)) setDoorRefPickGroupId(null);
  }, [doorGroups, selectedDoorGroupId, doorRefPickGroupId]);
  useEffect(() => {
    if (selectedBackGroupId && !backGroups.some(g => g.id === selectedBackGroupId)) setSelectedBackGroupId(null);
    if (backRefPickGroupId && !backGroups.some(g => g.id === backRefPickGroupId)) setBackRefPickGroupId(null);
  }, [backGroups, selectedBackGroupId, backRefPickGroupId]);
  useEffect(() => {
    if (!doorRefPickGroupId && !doorAddPick && !backRefPickGroupId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDoorRefPickGroupId(null); setDoorAddPick(null); setBackRefPickGroupId(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doorRefPickGroupId, doorAddPick, backRefPickGroupId]);

  useEffect(() => {
    const currentShapes = useAppStore.getState().shapes;
    // YARIŞ KORUMASI: ilk VF'nin hasPanel yazımı efekti yeniden tetikler; üretimi süren VF'ler modül düzeyinde
    // işaretlenmezse aynı VF için İKİNCİ panel yaratılır (üst üste iki raf).
    const pending = virtualFaces.filter(vf => !vf.hasPanel && !_creatingPanelForVf.has(vf.id) && !panelOfVf(vf.id, currentShapes));
    if (!pending.length) return;
    for (const vf of pending) _creatingPanelForVf.add(vf.id);
    (async () => {
      for (const vf of pending) {
        const parentShape = shapeById(vf.shapeId);
        if (!parentShape || !useAppStore.getState().virtualFaces.some(f => f.id === vf.id)) { _creatingPanelForVf.delete(vf.id); continue; }
        try {
          const grp = vf.groupId ? useAppStore.getState().panelGroups.find(pg => pg.id === vf.groupId) : undefined;
          const dgrp = vf.doorGroupId ? useAppStore.getState().doorGroups.find(dg => dg.id === vf.doorGroupId) : undefined;
          const bgrp = vf.backGroupId ? useAppStore.getState().backGroups.find(bg => bg.id === vf.backGroupId) : undefined;
          const th = grp ? memberThicknessesOf(grp)[vf.groupIndex ?? grp.memberVfIds.indexOf(vf.id)] || grp.thickness : dgrp ? dgrp.thickness : bgrp ? bgrp.thickness : PANEL_THICKNESS;
          const rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, th);
          if (!rp) continue;
          const g = convertReplicadToThreeGeometry(rp);
          const r = geoAxes(g); if (!r) continue;
          const [def, alt] = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
          const s = [r.size.x, r.size.y, r.size.z];
          const vi = virtualFaces.filter(f => f.shapeId === vf.shapeId).findIndex(f => f.id === vf.id);
          useAppStore.getState().addShape({
            id: genId('panel-vf'), type: 'panel', position: [...parentShape.position], rotation: parentShape.rotation, scale: [...parentShape.scale], color: '#ffffff',
            geometry: g, replicadShape: rp,
            parameters: { width: s[def], height: s[alt], depth: th, parentShapeId: parentShape.id, faceIndex: -(vi + 1), virtualFaceId: vf.id, arrowRotated: false,
              // Grup kimliği + kalınlık panele de yazılır: motor (damga/engel/kesim sınıfı) bunu okur.
              ...(vf.groupId ? { panelGroupId: vf.groupId, panelThickness: th } : {}),
              ...(vf.doorGroupId ? { doorGroupId: vf.doorGroupId, panelThickness: th } : {}),
              ...(vf.backGroupId ? { backGroupId: vf.backGroupId, panelThickness: th } : {}) },
          } as Shape);
          updateVirtualFace(vf.id, { hasPanel: true });
        } catch (e) { console.error('Auto panel creation failed:', e); }
        finally { _creatingPanelForVf.delete(vf.id); }
      }
      // Rebuild'i App'teki panel-kümesi izleyicisi (addShape) tetikler — burada ikinci kez çağrılmaz.
    })();
  }, [virtualFaces]);

  useEffect(() => {
    if (faceExtrudeMode && !faceExtrudeCavityGroupId && activePanelId && activePanelId !== faceExtrudeTargetPanelId) { setFaceExtrudeTargetPanelId(activePanelId); setFaceExtrudeSelectedFace(null); }
  }, [faceExtrudeMode, faceExtrudeCavityGroupId, activePanelId, faceExtrudeTargetPanelId]);
  useEffect(() => {
    if (panelMoveMode && activePanelId && activePanelId !== panelMoveTargetPanelId) { setPanelMoveTargetPanelId(activePanelId); setPanelMoveAxis(null); setPanelMoveValue(0); }
  }, [panelMoveMode, activePanelId, panelMoveTargetPanelId]);

  useEffect(() => {
    if (faceExtrudeSelectedFace === null || !activePanelId || faceExtrudeCavityGroupId) return;
    const ps = shapeById(activePanelId, shapes); if (!ps?.geometry) return;
    const steps = ps.parameters?.extrudeSteps || []; if (!steps.length) return;
    const { groups } = getFacesAndGroups(ps.geometry);
    let g = groups[faceExtrudeSelectedFace]; if (!g) return;
    const gn = g.normal.clone().normalize();
    if (!isFlatNormal(gn, 0.9)) {
      const flat = groups.filter(f => { const fn = f.normal.clone().normalize(); return isFlatNormal(fn, 0.9) && dominantAxisLabel(fn) === dominantAxisLabel(gn); })
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
  // Hacim düzenlemenin geçerlilik koşulu: grup kartı AÇIK (tümü seçili ya da bir üye satırı açık).
  const groupCardOpen = (gid: string) => selectedPanelGroupId === gid || virtualFaces.some(f => f.groupId === gid && selectedPanelRow === `vf-${f.id}`);
  useEffect(() => {
    if (!volumePickMode || !volumePickGroupId) return;
    if (!panelGroups.some(g => g.id === volumePickGroupId && g.shapeId === selectedShapeId) || !groupCardOpen(volumePickGroupId)) {
      setVolumePickMode(null);
    }
  }, [volumePickMode, volumePickGroupId, panelGroups, selectedShapeId, selectedPanelGroupId, selectedPanelRow, virtualFaces]);
  useEffect(() => {
    if (faceExtrudeMode && faceExtrudeCavityGroupId) {
      if (!panelGroups.some(g => g.id === faceExtrudeCavityGroupId && g.shapeId === selectedShapeId) || !groupCardOpen(faceExtrudeCavityGroupId)) {
        setFaceExtrudeSelectedFace(null); setFaceExtrudeRefCandidate(null); setFaceExtrudeMode(false);
      }
      return;
    }
    if (faceExtrudeMode && uiLeftPanel(faceExtrudeTargetPanelId)) {
      setFaceExtrudeSelectedFace(null); setFaceExtrudeRefCandidate(null); setFaceExtrudeMode(false);
    }
    if (panelMoveMode && uiLeftPanel(panelMoveTargetPanelId)) {
      setPanelMoveAxis(null); setPanelMoveMode(false);
    }
    if (panelRotateMode && uiLeftPanel(panelRotateTargetPanelId)) {
      setPanelRotateAxis(null); setPanelRotateMode(false);
    }
  }, [activePanelId, selectedPanelRow, selectedShapeId, selectedPanelGroupId, panelGroups, faceExtrudeMode, faceExtrudeTargetPanelId, faceExtrudeCavityGroupId, panelMoveMode, panelMoveTargetPanelId, panelRotateMode, panelRotateTargetPanelId]);

  useEffect(() => {
    if (!faceExtrudeCavityGroupId || !faceExtrudeCavityFaceNormal) return;
    const g = panelGroups.find(x => x.id === faceExtrudeCavityGroupId); if (!g?.cavitySteps?.length) return;
    const n = faceExtrudeCavityFaceNormal;
    const ax = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])].indexOf(Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])));
    // Aynı eksen+yönde birden çok adım (L'nin iki kolu) → çıpası tıklama noktasına en yakın olan.
    const body = selectedShape ? localBboxOf(selectedShape.geometry) : null;
    const cp = faceExtrudeClickPoint;
    const fr = body && cp ? [0, 1, 2].map(a => { const sp = (body.max.getComponent(a) - body.min.getComponent(a)) || 1; return (cp[a] - body.min.getComponent(a)) / sp; }) : null;
    const same = g.cavitySteps.filter(st => { const m = st.faceNormal; const a2 = [Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2])].indexOf(Math.max(Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]))); return a2 === ax && Math.sign(m[a2]) === Math.sign(n[ax]); });
    const existing = same.length <= 1 || !fr ? same[0] : same.reduce((b, st) => { const d = (q: any) => (q.anchorFrac ? Math.hypot(q.anchorFrac[0] - fr[0], q.anchorFrac[1] - fr[1], q.anchorFrac[2] - fr[2]) : 9); return d(st) < d(b) ? st : b; });
    if (!existing) return;
    setFaceExtrudeThickness(existing.value); setExtrudeThicknessStr(String(existing.value));
    if (faceExtrudeValueMode !== 'ref') setFaceExtrudeValueMode(existing.refShapeId ? 'ref' : existing.isFixed ? 'fixed' : 'dyn');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceExtrudeCavityGroupId, faceExtrudeCavityFaceNormal, faceExtrudeClickPoint]);

  useEffect(() => {
    if (selectedPanelRow === null) return;
    const t = window.setTimeout(() => rowRefs.current.get(selectedPanelRow)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
    return () => window.clearTimeout(t);
  }, [selectedPanelRow]);
  useEffect(() => {
    if (!selectedPanelGroupId) return;
    const t = window.setTimeout(() => rowRefs.current.get(`grp-${selectedPanelGroupId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
    return () => window.clearTimeout(t);
  }, [selectedPanelGroupId]);

  // showOutlines yalnız KULLANICI TERCİHİDİR — burada yazılmaz; yerleştirmedeki geçici görünürlük ShapeWithTransform'da.

  const withActivePanel = (fn: (ps: Shape) => Promise<unknown> | unknown) => { const ps = shapeById(activePanelId, shapes); if (ps) return fn(ps); };
  const toggleArrow = (p: Shape | undefined) => { if (p) updateShape(p.id, { parameters: { ...p.parameters, arrowRotated: !p.parameters?.arrowRotated } }); };
  // fitFaceShape'i computeFreeRegionLocal yalnız regen'de okur → tam rebuild gerekir.
  const toggleFitShape = async (vf: VirtualFace) => {
    const next = !vf.fitFaceShape;
    updateVirtualFace(vf.id, { fitFaceShape: next });
    try { await requestRebuild(vf.shapeId); } catch (e) { console.error('[YAGO][YÜZ-ŞEKLİ] rebuild hatası:', e); }
  };

  // Panel türü araçları kenar çubuğu kabuğundaki dikey rayda (Ui.tsx SidebarRail).

  const extrudeDock = (() => {
    if (!activePanelId || !activePanel || !faceExtrudeMode) return null;
    const hf = faceExtrudeSelectedFace !== null;
    const isRefMode = faceExtrudeValueMode === 'ref';
    const hasRefPanel = isRefMode && !!faceExtrudeRefCandidate?.panelId;
    const hasRefFace = hasRefPanel && faceExtrudeRefCandidate!.faceGroupIndex !== undefined && faceExtrudeRefCandidate!.faceGroupIndex >= 0;
    const exit = () => { setFaceExtrudeSelectedFace(null); setFaceExtrudeMode(false); setFaceExtrudeRefCandidate(null); };
    const onApply = async () => {
      if (!hf) return;
      await withActivePanel(async ps => {
        if (isRefMode) { if (!hasRefFace) return; await confirmRefFaceExtrude(); }
        else await executeFaceExtrude({ panelShape: ps, faceGroupIndex: faceExtrudeSelectedFace!, value: faceExtrudeThickness, isFixed: faceExtrudeValueMode === 'fixed', updateShape, clickPoint: faceExtrudeClickPoint ?? undefined });
        exit();
      });
    };
    return (
      <div style={DOCK_SHELL}>
        {hf && (
          <DockModeBar
            modes={dockModes(['fixed', 'dyn', 'ref'], { fixed: { sub: 'Constant', title: 'Fixed — constant thickness' }, ref: { sub: 'To face', title: 'Ref — up to a reference face' } })}
            active={faceExtrudeValueMode}
            onPick={k => { setFaceExtrudeValueMode(k as 'fixed' | 'dyn' | 'ref'); if (k !== 'ref') setFaceExtrudeRefCandidate(null); }}
          />
        )}
        <div style={DOCK_ROW}>
          {!hf ? <DockStatus text="Pick a face in the 3D view" />
            : isRefMode ? <DockStatus ready={hasRefFace} text={hasRefFace ? 'Reference face selected' : hasRefPanel ? 'Pick the reference face' : 'Pick the reference panel'} />
            : <NumInput draft={extrudeThicknessStr} setDraft={setExtrudeThicknessStr} setValue={setFaceExtrudeThickness} fallback={faceExtrudeThickness} />}
          {hf && <ApplyBtn enabled={!(isRefMode && !hasRefFace)} onClick={onApply} />}
          <ExitBtn onClick={exit} />
        </div>
      </div>
    );
  })();

  const cavityDock = (g: PanelGroup) => {
    if (!faceExtrudeMode || faceExtrudeCavityGroupId !== g.id) return null;
    const hf = faceExtrudeSelectedFace !== null && !!faceExtrudeCavityFaceNormal;
    const isRefMode = faceExtrudeValueMode === 'ref';
    const hasRefPanel = isRefMode && !!faceExtrudeRefCandidate?.panelId;
    const hasRefFace = hasRefPanel && faceExtrudeRefCandidate!.faceGroupIndex !== undefined && faceExtrudeRefCandidate!.faceGroupIndex >= 0;
    const exit = () => { setFaceExtrudeSelectedFace(null); setFaceExtrudeMode(false); setFaceExtrudeRefCandidate(null); };
    const onApply = async () => {
      if (!hf) return;
      if (isRefMode) { if (!hasRefFace) return; await confirmRefCavityExtrude(); }
      else { await executeCavityExtrude(g.id, faceExtrudeCavityFaceNormal!, faceExtrudeThickness, faceExtrudeValueMode === 'fixed', faceExtrudeClickPoint); exit(); }
    };
    return (
      <div style={DOCK_SHELL}>
        {hf && (
          <DockModeBar
            modes={dockModes(['fixed', 'dyn', 'ref'], { fixed: { sub: 'Constant', title: 'Fixed — cavity size along this axis' }, ref: { sub: 'To face', title: 'Ref — up to a reference face' } })}
            active={faceExtrudeValueMode}
            onPick={k => { setFaceExtrudeValueMode(k as 'fixed' | 'dyn' | 'ref'); if (k !== 'ref') setFaceExtrudeRefCandidate(null); }}
          />
        )}
        <div style={DOCK_ROW}>
          <span style={dockAxisTag('#44403c')}>VOL</span>
          {!hf ? <DockStatus text="Pick a face of the volume in the 3D view" />
            : isRefMode ? <DockStatus ready={hasRefFace} text={hasRefFace ? 'Reference face selected' : hasRefPanel ? 'Pick the reference face' : 'Pick the reference panel'} />
            : <NumInput draft={extrudeThicknessStr} setDraft={setExtrudeThicknessStr} setValue={setFaceExtrudeThickness} fallback={faceExtrudeThickness} onEnter={onApply} onEscape={exit} />}
          {hf && <ApplyBtn enabled={!(isRefMode && !hasRefFace)} onClick={onApply} />}
          <ExitBtn onClick={exit} />
        </div>
      </div>
    );
  };

  const cavityStepsPanel = (g: PanelGroup) => {
    const steps = g.cavitySteps || [];
    if (!steps.length) return null;
    const tag = (txt: string) => <span className="shrink-0 text-[10px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px] bg-[#f3efe8] text-stone-500">{txt}</span>;
    const save = (id: string) => { const v = parseFloat(stepEdit?.v ?? ''); if (isNaN(v)) return; void updateCavityStep(g.id, id, v); setStepEdit(null); };
    return (
      <div className="shrink-0 mt-2" style={{ fontFamily: UI_FONT }}>
        <SectionHead label="Volume steps" count={steps.length} className="px-1 pb-1.5" />
        <div className="overflow-y-auto" style={{ maxHeight: 160 }}>
          <div className="flex flex-col gap-[2px] p-px">
            {[...steps].sort((a, b) => a.timestamp - b.timestamp).map((st, idx) => {
              const isRef = !!st.refShapeId;
              const shown = isRef && st.resolvedValue != null ? st.resolvedValue : st.value;
              const editing = stepEdit?.id === st.id;
              const axisKey = st.axisLabel.toLowerCase();
              return (
                <div key={st.id} className="group/step flex items-center gap-1.5 pl-1.5 pr-1 h-[30px] rounded-[9px] bg-[#fdfcfa] ring-1 ring-[#ece7df] shadow-[0_1px_0_rgba(68,64,60,0.025)] hover:bg-white hover:ring-[#e2dbd0] transition-colors duration-150">
                  <span className="shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#f3efe8] text-[10.5px] font-semibold text-stone-500 tabular-nums leading-none">{idx + 1}</span>
                  <span className="shrink-0 text-[10.5px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px]" style={{ background: 'rgba(14,116,144,0.09)', color: '#0e7490' }}>Vol</span>
                  <span className="shrink-0 min-w-[24px] text-center text-[10.5px] font-bold px-1 h-[18px] leading-[18px] rounded-[5px] bg-[#f5f2ec]" style={{ color: AXIS_COLORS[axisKey] || AXIS_COLORS[axisKey[0]] || '#57534e' }}>{st.axisLabel.toUpperCase()}</span>
                  {editing ? (
                    <>
                      <input type="text" inputMode="numeric" autoFocus value={stepEdit!.v}
                        onChange={e => setStepEdit({ id: st.id, v: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Escape') setStepEdit(null); else if (e.key === 'Enter') save(st.id); }}
                        className="flex-1 min-w-0 h-[22px] text-center font-mono text-[12px] font-medium tabular-nums text-stone-800 bg-white border border-[#e6e0d6] rounded-[6px] outline-none focus:border-orange-400/60 focus:shadow-[0_0_0_2px_rgba(249,115,22,0.10)]" />
                      <button onClick={() => save(st.id)} style={iconBtn('#5b5346')}><Check size={11} /></button>
                      <button onClick={() => setStepEdit(null)} style={iconBtn('#a8a29e')}><X size={11} /></button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 pl-1 font-mono text-[12px] font-medium text-stone-700 tabular-nums">{shown}</span>
                      {tag(isRef ? 'R' : st.isFixed ? 'F' : 'D')}
                      {!isRef && <button onClick={() => setStepEdit({ id: st.id, v: String(st.value) })} style={iconBtn('#a8a29e')} className="hover:!bg-[#f3efe8] hover:!text-stone-700"><Pencil size={10.5} strokeWidth={1.9} /></button>}
                      <button onClick={() => { void deleteCavityStep(g.id, st.id); }} style={iconBtn('#a8a29e')} className="hover:!bg-red-50 hover:!text-red-500"><Trash2 size={10.5} strokeWidth={1.9} /></button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const moveDock = (() => {
    if (!activePanelId || !panelMoveMode) return null;
    const isRefMode = panelMoveValueMode === 'ref';
    const hasAxis = panelMoveAxis !== null;
    const hasRefReady = isRefMode && !!panelMoveRefSourceVertex && !!panelMoveRefTargetPanelId && !!panelMoveRefTargetVertex;
    const exit = () => { setPanelMoveAxis(null); setPanelMoveMode(false); if (isRefMode) setSelectedPanelRow(null); };
    const onApply = () => withActivePanel(async ps => {
      if (isRefMode) {
        if (!hasRefReady) return;
        await confirmPanelMoveRef();
        setSelectedPanelRow(null);
      } else {
        if (!hasAxis) return;
        await (panelMoveValueMode === 'fixed' ? executePanelMoveFixed : executePanelMove)({ panelShape: ps, axis: panelMoveAxis!, value: panelMoveValue, updateShape });
      }
      setPanelMoveAxis(null); setPanelMoveValue(0); setMoveValueStr('0'); setPanelMoveMode(false);
    });
    const refStep = !panelMoveRefSourceVertex ? 1 : !panelMoveRefTargetPanelId ? 2 : !panelMoveRefTargetVertex ? 3 : 4;
    const refLabel = ['Pick the source point', 'Pick the target panel', 'Pick the target point', 'Ready — right-click to confirm'][refStep - 1];
    return (
      <div style={DOCK_SHELL}>
        <DockModeBar
          modes={dockModes(['dyn', 'fixed', 'ref'], { dyn: { sub: 'Relative' }, fixed: { sub: 'Absolute', title: 'Fixed — absolute position' }, ref: { sub: 'To point' } })}
          active={panelMoveValueMode}
          onPick={k => { setPanelMoveValueMode(k as 'dyn' | 'fixed' | 'ref'); if (k !== 'ref') { setPanelMoveRefSourceVertex(null); setPanelMoveRefTargetPanelId(null); setPanelMoveRefTargetVertex(null); } else setPanelMoveAxis(null); }}
        />
        <div style={DOCK_ROW}>
          {isRefMode ? <DockStatus ready={refStep === 4} text={refLabel} />
            : !hasAxis ? <DockStatus text="Pick a direction arrow in the 3D view" />
            : (
              <>
                <span style={dockAxisTag(AXIS_COLORS[panelMoveAxis!] || '#44403c')}>{panelMoveAxis!.toUpperCase()}</span>
                <NumInput autoFocus draft={moveValueStr} setDraft={setMoveValueStr} setValue={setPanelMoveValue} fallback={0}
                  onEnter={onApply} onEscape={() => { setPanelMoveAxis(null); setPanelMoveMode(false); }} />
              </>
            )}
          <ApplyBtn enabled={isRefMode ? hasRefReady : hasAxis} onClick={onApply} />
          <ExitBtn onClick={exit} />
        </div>
      </div>
    );
  })();

  /* Döndürme ref modu: onaydan sonra bağ KALICIDIR — referans taşındıkça panel nişan noktasıyla yeniden döner. */
  const rotateDock = (() => {
    if (!activePanelId || !panelRotateMode) return null;
    const isRotRefMode = panelRotateValueMode === 'ref';
    const hasPivot = panelRotatePivot !== null, hasAxis = panelRotateAxis !== null, hasArm = panelRotateRefArmVertex !== null;
    const rotRefReady = isRotRefMode && hasPivot && hasArm && hasAxis && !!panelRotateRefFace;
    const modeBar = (trailing?: React.ReactNode) => (
      <DockModeBar trailing={trailing} active={panelRotateValueMode}
        modes={dockModes(['dyn', 'ref'], { dyn: { sub: 'Angle', title: 'Enter an angle: pivot → axis → degrees' }, ref: { sub: 'Aim at face', title: 'Rotate to a reference: pivot → aim point → axis → reference face → right-click' } })}
        onPick={k => { setPanelRotateValueMode(k as 'dyn' | 'ref'); setRotateValueStr('0'); }} />
    );
    const exit = () => { setPanelRotateAxis(null); setPanelRotatePivot(null); setPanelRotateMode(false); if (isRotRefMode) setSelectedPanelRow(null); };
    const onApply = () => withActivePanel(async ps => {
      if (isRotRefMode) {
        if (!rotRefReady) return;
        await confirmPanelRotateRef();
        setPanelRotateMode(false); setSelectedPanelRow(null);
        return;
      }
      if (!hasAxis || !hasPivot) return;
      await executePanelRotate({ panelShape: ps, axis: panelRotateAxis!, value: panelRotateValue, pivot: panelRotatePivot!, updateShape });
      setPanelRotateAxis(null); setPanelRotateValue(0); setRotateValueStr('0');
    });

    // Mod seçilene kadar gizmo null döner (sahnede nokta/halka yok).
    if (panelRotateValueMode === null) return (
      <div style={DOCK_SHELL}>
        {modeBar(<div style={{ display: 'flex', alignItems: 'center' }}><ExitBtn onClick={exit} /></div>)}
        <div style={{ padding: '5px 10px 7px', fontSize: 10.5, fontWeight: 500, color: '#a8a29e', fontFamily: UI_FONT }}>Choose a rotation mode</div>
      </div>
    );
    if (isRotRefMode) {
      const step = !hasPivot ? 1 : !hasArm ? 2 : !hasAxis ? 3 : !panelRotateRefFace ? 4 : 5;
      const label = ['1/4 · Pivot point', '2/4 · Aim point', '3/4 · Axis ring', '4/4 · Reference face', 'Ready — right-click to confirm'][step - 1];
      const hint = [
        'The point the panel rotates around (its own corners or center)',
        'The point that will TOUCH the reference face — another point on the SAME panel',
        'Rotation axis: pick the X / Y / Z ring in the scene',
        'Click a face on another panel (click the same spot again for the face behind). The panel rotates until the aim point touches it.',
        'Right-click anywhere in the scene — the link is kept and the reference panel edge is beveled to the slope',
      ][step - 1];
      return (
        <div style={DOCK_SHELL}>
          {modeBar()}
          <div style={DOCK_ROW}>
            <DockStatus ready={rotRefReady} text={label} title={hint}
              trailing={hasAxis && <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: AXIS_COLORS[panelRotateAxis!] || '#44403c' }}>{panelRotateAxis!.toUpperCase()}</span>} />
            <ApplyBtn enabled={rotRefReady} onClick={onApply} />
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
              <span style={dockAxisTag(AXIS_COLORS[panelRotateAxis!] || '#44403c')}>{panelRotateAxis!.toUpperCase()}</span>
              <NumInput autoFocus draft={rotateValueStr} setDraft={setRotateValueStr} setValue={setPanelRotateValue} fallback={0}
                onEnter={onApply} onEscape={() => { setPanelRotateAxis(null); setPanelRotateMode(false); }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: '#a8a29e', marginLeft: -2 }}>°</span>
              <ApplyBtn enabled onClick={onApply} />
            </>
          ) : hasPivot ? <DockStatus dot="#f59e0b" text="Pick an axis (X/Y/Z ring)" />
            : <DockStatus dot="#06b6d4" text="Pick a pivot point (corners/center)" />}
          <ExitBtn onClick={exit} />
        </div>
      </div>
    );
  })();

  const stepsPanel = (() => {
    if (!activePanelId || !activePanel || (!activeSteps.length && !activeTransformSteps.length)) return null;
    const typeBadge: Record<string, { label: string; bg: string; color: string }> = {
      move: { label: 'Move', bg: 'rgba(22,163,74,0.08)', color: '#15803d' },
      rotate: { label: 'Rotate', bg: 'rgba(37,99,235,0.08)', color: '#1d4ed8' },
      extrude: { label: 'Ext', bg: 'rgba(217,119,6,0.09)', color: '#b45309' },
    };
    // Ref adımlarında donmuş value değil, çözülen gerçek miktar (resolvedValue) gösterilir.
    const allSteps = [
      ...activeSteps.map(s => ({ id: s.id as string, stepType: 'extrude', axis: s.axisLabel as string, value: s.resolvedValue != null ? s.resolvedValue : s.value, timestamp: s.timestamp as number, isFixed: s.isFixed as boolean | undefined, isRef: !!s.refShapeId })),
      ...activeTransformSteps.map(s => ({ id: s.id as string, stepType: s.type as string, axis: s.axis as string, value: (s.type === 'rotate' && typeof s.resolvedValue === 'number') ? s.resolvedValue : s.value, timestamp: s.timestamp as number, isFixed: undefined as boolean | undefined, isRef: !!s.refTargetPanelId })),
    ].sort((a, b) => a.timestamp - b.timestamp);
    const saveStep = (s: typeof allSteps[number]) => {
      const parsed = parseFloat(stepEdit?.v ?? ''); if (isNaN(parsed)) return;
      void withActivePanel(async ps => {
        await (s.stepType === 'extrude' ? updateExtrudeStep : updateTransformStep)(ps, s.id, parsed, updateShape);
        setStepEdit(null);
      });
    };
    const removeStep = (s: typeof allSteps[number]) => withActivePanel(ps => (s.stepType === 'extrude' ? deleteExtrudeStep : deleteTransformStep)(ps, s.id, updateShape));
    const tag = (txt: string) => <span className="shrink-0 text-[10px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px] bg-[#f3efe8] text-stone-500">{txt}</span>;
    return (
      <div className="shrink-0 mt-2" style={{ fontFamily: UI_FONT }}>
        <SectionHead label="Steps" count={allSteps.length} className="px-1 pb-1.5" />
        <div className="overflow-y-auto" style={{ maxHeight: 200 }}>
          <div className="flex flex-col gap-[2px] p-px">
            {allSteps.map((s, idx) => {
              const badge = typeBadge[s.stepType] || typeBadge.move;
              const editing = stepEdit?.id === s.id;
              const editable = !(s.stepType === 'extrude' && s.isRef) && !(s.stepType === 'rotate' && s.isRef);
              return (
                <div key={s.id} className="group/step flex items-center gap-1.5 pl-1.5 pr-1 h-[30px] rounded-[9px] bg-[#fdfcfa] ring-1 ring-[#ece7df] shadow-[0_1px_0_rgba(68,64,60,0.025)] hover:bg-white hover:ring-[#e2dbd0] transition-colors duration-150">
                  <span className="shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#f3efe8] text-[10.5px] font-semibold text-stone-500 tabular-nums leading-none">{idx + 1}</span>
                  <span className="shrink-0 text-[10.5px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px]" style={{ background: badge.bg, color: badge.color }}>{badge.label}</span>
                  <span className="shrink-0 min-w-[24px] text-center text-[10.5px] font-bold px-1 h-[18px] leading-[18px] rounded-[5px] bg-[#f5f2ec]" style={{ color: AXIS_COLORS[s.axis] || '#57534e' }}>{s.axis.toUpperCase()}</span>
                  {editing ? (
                    <>
                      <input type="text" inputMode="numeric" autoFocus value={stepEdit!.v}
                        onChange={e => setStepEdit({ id: s.id, v: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Escape') setStepEdit(null); else if (e.key === 'Enter') saveStep(s); }}
                        className="flex-1 min-w-0 h-[22px] text-center font-mono text-[12px] font-medium tabular-nums text-stone-800 bg-white border border-[#e6e0d6] rounded-[6px] outline-none focus:border-orange-400/60 focus:shadow-[0_0_0_2px_rgba(249,115,22,0.10)]" />
                      <button onClick={() => saveStep(s)} style={iconBtn('#5b5346')}><Check size={11} /></button>
                      <button onClick={() => setStepEdit(null)} style={iconBtn('#a8a29e')}><X size={11} /></button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 pl-1 font-mono text-[12px] font-medium text-stone-700 tabular-nums">{s.value}{s.stepType === 'rotate' ? '°' : ''}</span>
                      {s.stepType === 'extrude' && s.isFixed !== undefined && tag(s.isRef ? 'R' : s.isFixed ? 'F' : 'D')}
                      {s.stepType !== 'extrude' && s.isRef && tag('R')}
                      {editable && (
                        <button onClick={() => setStepEdit({ id: s.id, v: String(s.value) })} style={iconBtn('#a8a29e')} className="hover:!bg-[#f3efe8] hover:!text-stone-700"><Pencil size={10.5} strokeWidth={1.9} /></button>
                      )}
                      <button onClick={() => { void removeStep(s); }} style={iconBtn('#a8a29e')} className="hover:!bg-red-50 hover:!text-red-500"><Trash2 size={10.5} strokeWidth={1.9} /></button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  })();

  /* Şerit önizlemenin ÜSTÜNDE olmalı (altındayken 500px önizlemenin altında kalıp görünmüyordu). */
  const renderExpandedBody = (vf: VirtualFace, vp: Shape | undefined) => {
    const isExtrudingThis = faceExtrudeMode && faceExtrudeTargetPanelId === vp?.id;
    const isMovingThis = panelMoveMode && panelMoveTargetPanelId === vp?.id;
    const isRotatingThis = panelRotateMode && panelRotateTargetPanelId === vp?.id;
    const tool = isExtrudingThis ? 'extrude' : isMovingThis ? 'move' : isRotatingThis ? 'rotate' : null;
    const pickTool = (k: string) => {
      if (!vp) return;
      if (k === tool) {
        if (k === 'extrude') setFaceExtrudeMode(false); else if (k === 'move') setPanelMoveMode(false); else setPanelRotateMode(false);
        return;
      }
      if (faceExtrudeMode) setFaceExtrudeMode(false);
      if (panelMoveMode) setPanelMoveMode(false);
      if (panelRotateMode) setPanelRotateMode(false);
      if (k === 'extrude') { setFaceExtrudeTargetPanelId(vp.id); setFaceExtrudeMode(true); }
      else if (k === 'move') { setPanelMoveTargetPanelId(vp.id); setPanelMoveMode(true); }
      else { setPanelRotateTargetPanelId(vp.id); setPanelRotateMode(true); }
    };
    const dis = !vf.hasPanel;
    return (
      <div className="yago-expand px-2 pt-2 pb-2" style={{ borderTop: '1px solid #efebe5' }} onClick={stop}>
        <Segmented active={tool} onPick={pickTool} items={[
          { key: 'extrude', label: 'Extrude', Icon: MoveVertical, title: 'Face extrude — pick a face in the 3D view, then Fixed / Dyn / Ref', disabled: dis },
          { key: 'move', label: 'Move', Icon: Move, title: 'Move the panel — Relative / Absolute / To point', disabled: dis },
          { key: 'rotate', label: 'Rotate', Icon: RotateCw, title: 'Rotate the panel — Angle / Aim at face', disabled: dis },
        ]} />
        {extrudeDock}
        {moveDock}
        {rotateDock}
        <div className={`${PREVIEW_FRAME} mt-1.5`} style={{ height: PREVIEW_HEIGHT, background: PREVIEW_BG }}>
          {activeDims && activePanel
            ? <PanelPreview2D key={activePanel.id} shape={activePanel} arrowRotated={!!activePanel.parameters?.arrowRotated} />
            : <div className="absolute inset-0 flex items-center justify-center"><span className="text-xs text-stone-400">No panel</span></div>}
        </div>
        {stepsPanel}
      </div>
    );
  };

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
    /* AYAKLAR SATIRI: VF değil, gövde parametresi; sırası her zaman en başta ("L"). Yükseklik alt panelden canlı okunur. */
    const legsRow = (legs: NonNullable<typeof bodyLegs>) => {
      const key = `legs-${sid}`, sel = selectedPanelRow === key;
      const bb = localBboxOf(effectiveBodyGeometry(selectedShape));
      const W = bb ? bb.max.x - bb.min.x : 600, D = bb ? bb.max.z - bb.min.z : 560;
      const h = legHeightOf(selectedShape, legs, shapes);
      const toggle = (e: React.MouseEvent) => { stop(e); if (sel) setSelectedPanelRow(null); else setSelectedPanelRow(key, sid); };
      const cell = (letter: string, v: string) => (
        <span className="inline-flex items-baseline w-[59px] whitespace-nowrap overflow-hidden">
          <span className="text-[11px] font-semibold text-stone-400">{letter}</span><span className="ml-[3px] text-[12px] font-medium text-stone-700">{v}</span>
        </span>
      );
      const sep = <span className="w-px h-3 bg-[#e6e0d6] mx-[4px] self-center" />;
      return (
        <div key={key} className={rowCardClass(sel, false, false)}>
          <div className={`relative flex items-stretch ${sel ? ROW_SEL_HEAD : ''}`}>
            {sel && <span className={ROW_SEL_BAR} />}
            <span className="shrink-0 w-[14px] ml-[2px] self-stretch" />
            <div onClick={toggle} className="flex-1 min-w-0 relative flex items-center gap-1 pl-0 pr-0.5 py-[4px] cursor-pointer">
              <RowNum label="L" active={sel} />
              <RowTypeBadge kind="legs" active={sel} count={legs.count} />
              <span className="flex-1 min-w-0 h-[22px] px-[5px] flex items-center text-[11.5px] font-medium text-stone-700 truncate select-none" title="Cabinet legs — always first; height follows the bottom panel">Legs</span>
              <span onClick={stop} className="shrink-0 inline-flex items-baseline leading-none tabular-nums cursor-default" title={`${legs.count} legs · Ø ${fmt1(legs.diameter)} · height ${fmt1(h)} (from the bottom panel)`}>
                {cell('N', String(legs.count))}{sep}{cell('Ø', fmt1(legs.diameter))}{sep}{cell('H', fmt1(h))}
              </span>
              <div className="flex items-center justify-end gap-[1px] shrink-0" style={{ width: ROW_TRAIL_W }} onClick={stop}>
                <button onClick={e => { stop(e); if (sel) setSelectedPanelRow(null); setBodyLegs(sid, null); }} title="Remove legs" className={ROW_DEL_CLASS}><Trash2 size={ROW_ICON - 1} strokeWidth={1.9} /></button>
                <RowChevron open={sel} onClick={toggle} />
              </div>
            </div>
          </div>
          {sel && (
            <div className="yago-expand px-2 pt-2 pb-2" style={{ borderTop: '1px solid #efebe5', fontFamily: UI_FONT }} onClick={stop}>
              <LegsBlock legs={legs} W={W} D={D} heightReadout={h} heightEditable={false} countOptions={[4, 5, 6]} hint={legsHint} onHint={setLegsHint}
                onChange={p => setBodyLegs(sid, p as Partial<NonNullable<typeof bodyLegs>>)} />
            </div>
          )}
        </div>
      );
    };

    // Düz liste: her VF store sırasıyla kendi satırıdır; listedeki numara = VF sırası = basan/basılan önceliği.
    // İstisna: raf/dikme, kapak ve arkalık grubunun üyeleri store'da bitişik durur ve TEK kart olarak (ilk üyenin sırasında) gösterilir.
    type Row = { kind: 'vf'; vf: VirtualFace } | { kind: 'group'; group: PanelGroup; members: VirtualFace[] } | { kind: 'door'; group: DoorGroup; members: VirtualFace[] } | { kind: 'back'; group: BackGroup; members: VirtualFace[] };
    const rows: Row[] = [];
    const seenGroups = new Set<string>();
    for (const vf of svf) {
      const g = vf.groupId ? panelGroups.find(x => x.id === vf.groupId) : undefined;
      const dg = vf.doorGroupId ? doorGroups.find(x => x.id === vf.doorGroupId) : undefined;
      const bg = vf.backGroupId ? backGroups.find(x => x.id === vf.backGroupId) : undefined;
      if (g) { if (!seenGroups.has(g.id)) { seenGroups.add(g.id); rows.push({ kind: 'group', group: g, members: svf.filter(m => m.groupId === g.id) }); } }
      else if (dg) { if (!seenGroups.has(dg.id)) { seenGroups.add(dg.id); rows.push({ kind: 'door', group: dg, members: svf.filter(m => m.doorGroupId === dg.id) }); } }
      else if (bg) { if (!seenGroups.has(bg.id)) { seenGroups.add(bg.id); rows.push({ kind: 'back', group: bg, members: svf.filter(m => m.backGroupId === bg.id) }); } }
      else rows.push({ kind: 'vf', vf });
    }
    const idsOf = (r: Row) => (r.kind === 'vf' ? [r.vf.id] : r.members.map(m => m.id));
    const rowKeyOf = (r: Row) => (r.kind === 'vf' ? r.vf.id : `grp-${r.group.id}`);
    const clearDrag = () => { setDragIndex(null); setDropIndex(null); };

    const deletePanelAndFace = async (vfId: string) => {
      const p = panelOfVf(vfId, shapes);
      if (p) useAppStore.getState().deleteShape(p.id);
      deleteVirtualFace(vfId);
      if (selectedPanelRow === `vf-${vfId}`) setSelectedPanelRow(null);
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

    const vfRow = (vf: VirtualFace, rowIdx: number, label: string, opts: { member?: boolean; group?: PanelGroup; door?: DoorGroup; back?: BackGroup }) => {
      const rowKey = vf.id;
      const dragging = !opts.member && dragIndex === rowIdx;
      const vp = panelOfVf(vf.id, shapes), ar = vp?.parameters?.arrowRotated || false, sel = selectedPanelRow === `vf-${vf.id}`;
      const dims = panelDims(vp);
      const doorMemberType = opts.door ? doorMembersOf(opts.door)[opts.door.memberVfIds.indexOf(vf.id)] : undefined;
      const backPiece = opts.back ? backPieceOf(opts.back, backLeafOfMember(opts.back, opts.back.memberVfIds.indexOf(vf.id))) : undefined;   // parça başına tip
      return (
        <div key={rowKey} ref={el => { const k = `vf-${vf.id}`; if (el) rowRefs.current.set(k, el); else rowRefs.current.delete(k); }}
          className={rowCardClass(sel, dragging, armedRowKey === rowKey)}>
          <div className={`relative flex items-stretch ${sel ? ROW_SEL_HEAD : ''}`}>
            {sel && <span className={ROW_SEL_BAR} />}
            {opts.member
              ? <span className="shrink-0 w-[6px] ml-[2px] self-stretch" />
              : grip(rowKey, rowIdx, 'Drag to reorder')}
            <div onClick={e => { stop(e); if (sel) setSelectedPanelRow(null); else setSelectedPanelRow(`vf-${vf.id}`, sid); }}
              className="flex-1 min-w-0 relative flex items-center gap-1 pl-0 pr-0.5 py-[4px] cursor-pointer">
              <RowNum label={label} active={sel} small={opts.member} />
              <RowTypeBadge kind={opts.group ? opts.group.kind : opts.door ? 'door' : opts.back ? 'back' : 'body'} active={sel} />
              {opts.member && (opts.group || opts.door || opts.back) ? (
                <span title={backPiece ? `${BACK_TYPE_TITLE[backPiece.placement]}${backPiece.placement === 'inner' ? ` · setback ${backPiece.setback} mm` : ''} — name comes from the group (edit it on the group row); select this row to change only this piece's type / setback` : opts.door && doorMemberType ? `${DOOR_TYPE_TITLE[doorMemberType.type]}${doorMemberType.leafCount === 2 ? ` · leaf ${doorMemberType.leaf + 1}/2` : ''} — name comes from the group (edit it on the group row)` : 'Name comes from the group (edit it on the group row)'}
                  className="flex-1 min-w-0 h-[22px] px-[5px] flex items-center gap-1.5 text-[11.5px] font-medium text-stone-500 truncate cursor-default select-none">
                  {backPiece && <span className="shrink-0 text-stone-400"><BackTypeIcon type={backPiece.placement} size={11} strokeWidth={1.4} /></span>}
                  {opts.door && doorMemberType && <span className="shrink-0 text-stone-400"><DoorTypeIcon type={doorMemberType.type} size={11} strokeWidth={1.4} /></span>}
                  <span className="truncate">{opts.group ? groupName(opts.group) : opts.door ? doorGroupName(opts.door) : backGroupName(opts.back!)}</span>
                  {opts.door && doorMemberType?.leafCount === 2 && <span className="shrink-0 text-[10px] font-semibold text-stone-400 tabular-nums">{doorMemberType.leaf + 1}/2</span>}
                </span>
              ) : (
                <input type="text" value={vf.description || ''} onClick={stop} onChange={e => updateVirtualFace(vf.id, { description: e.target.value })}
                  placeholder="Panel" title="Panel name" className={`${ROW_INPUT_CLASS} font-medium`} />
              )}
              <RowDims w={dims?.primary} h={dims?.secondary} t={dims?.thickness} tLetter="T" />
              <div className="flex items-center justify-end gap-[1px] shrink-0" style={{ width: opts.member ? ROW_TRAIL_W - MEMBER_INSET : ROW_TRAIL_W }} onClick={stop}>
                {/* İç panelde (raf/dikme) serbest bölge yok → fit-shape gösterilmez. */}
                {!opts.member && <FitShapeToggle checked={!!vf.fitFaceShape} disabled={!vf.hasPanel} onToggle={() => { void toggleFitShape(vf); }} />}
                {opts.door || opts.back ? <span className={ROW_SPACER} /> : <DoorRefToggle checked={!!vf.doorBound} disabled={!vf.hasPanel} onToggle={() => setVfDoorBound(vf.id, !vf.doorBound)} />}
                {opts.door || opts.back ? <span className={ROW_SPACER} /> : <BackRefToggle checked={vfBackBound(vf)} disabled={!vf.hasPanel} onToggle={() => setVfBackBound(vf.id, !vfBackBound(vf))} />}
                <button disabled={!vf.hasPanel} onClick={e => { stop(e); toggleArrow(vp); }} title="Toggle arrow direction"
                  className={`${ROW_BTN} ${!vf.hasPanel ? 'text-stone-200 cursor-not-allowed' : ar ? 'text-stone-700 bg-[#f1ece4]' : 'text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700'}`}>
                  <ArrowUp size={ROW_ICON} strokeWidth={1.9} className={`transition-transform duration-200 ${ar ? '' : 'rotate-90'}`} />
                </button>
                {!opts.member
                  ? <button onClick={e => { stop(e); void deletePanelAndFace(vf.id); }} title="Delete panel" className={ROW_DEL_CLASS}><Trash2 size={ROW_ICON - 1} strokeWidth={1.9} /></button>
                  : <span className={ROW_SPACER} />}
                <RowChevron open={sel} onClick={e => { stop(e); if (sel) setSelectedPanelRow(null); else setSelectedPanelRow(`vf-${vf.id}`, sid); }} />
              </div>
            </div>
          </div>
          {sel && renderExpandedBody(vf, vp)}
        </div>
      );
    };

    const groupCard = (g: PanelGroup, members: VirtualFace[], rowIdx: number, label: string) => {
      const rowKey = `grp-${g.id}`;
      const selAll = selectedPanelGroupId === g.id;
      const dimsWHD = [0, 1, 2].map(a => round1(boxSpan(g.cavity, a)));
      const countVal = countDraft?.id === g.id ? countDraft.v : String(g.count);
      const applyCount = (n: number) => { setCountDraft(null); if (!isNaN(n) && n >= 1 && n !== g.count) void setGroupCount(g.id, n); };
      const autoGap = g.targetGap != null && g.targetGap > 0;
      const gapVal = gapDraft?.id === g.id ? gapDraft.v : (autoGap ? String(g.targetGap) : '');
      const applyGap = (raw: string) => {
        setGapDraft(null);
        const v = parseFloat(raw.replace(',', '.'));
        const next = Number.isFinite(v) && v > 0 ? round1(v) : null;
        if (next === (autoGap ? g.targetGap : null)) return;
        void setGroupTargetGap(g.id, next);
      };
      const open = openCards.has(g.id) || selAll || members.some(m => selectedPanelRow === `vf-${m.id}`);
      const mIds = members.map(m => m.id);
      const toggleRow = (e: React.MouseEvent) => { stop(e); if (open) closeCard(g.id, mIds); else { setSelectedPanelGroupId(g.id); openCard(g.id); } };
      return (
        <div key={rowKey} ref={el => { if (el) rowRefs.current.set(rowKey, el); else rowRefs.current.delete(rowKey); }}
          className={rowCardClass(open, dragIndex === rowIdx, armedRowKey === rowKey)}>
          <div className={`relative flex items-stretch ${selAll ? ROW_SEL_HEAD : ''}`}>
            {selAll && <span className={ROW_SEL_BAR} />}
            {grip(rowKey, rowIdx, 'Drag to reorder (whole group)')}
            <div onClick={toggleRow} className="flex-1 min-w-0 relative flex items-center gap-1 pl-0 pr-0.5 py-[4px] cursor-pointer" title={open ? 'Collapse' : 'Expand — selects all panels in this group'}>
              <RowNum label={label} active={selAll} />
              <RowTypeBadge kind={g.kind} active={open} count={g.count} />
              <input type="text" value={groupName(g)} onClick={stop} onChange={e => renamePanelGroup(g.id, e.target.value)} placeholder={groupKindLabel(g.kind)}
                title="Group name (applies to all its panels)" className={`${ROW_INPUT_CLASS} font-semibold`} />
              <RowDims w={dimsWHD[0]} h={dimsWHD[1]} t={dimsWHD[2]} tLetter="D" title="Cavity width · height · depth" />
              <div className="flex items-center justify-end gap-[1px] shrink-0" style={{ width: ROW_TRAIL_W }} onClick={stop}>
                <button onClick={e => { stop(e); deletePanelGroupWithMembers(g.id); }} title="Delete group (all panels)" className={ROW_DEL_CLASS}><Trash2 size={ROW_ICON - 1} strokeWidth={1.9} /></button>
                <RowChevron open={open} onClick={toggleRow} />
              </div>
            </div>
          </div>
          {open && (
            <div className="yago-expand px-2 pt-2 pb-2" style={{ borderTop: '1px solid #efebe5', fontFamily: UI_FONT }} onClick={stop}>
              {(() => {
                const editingVol = faceExtrudeMode && faceExtrudeCavityGroupId === g.id;
                const relocating = !!volumePickMode && volumePickGroupId === g.id;
                return (
                  <div className="flex items-center gap-1 mb-1.5">
                    <CardAction compact icon={Box} label="Volume" active={editingVol}
                      title="Edit the volume: pick a face in the 3D view, then extrude it (fixed / dyn / ref)"
                      onClick={() => { if (editingVol) setFaceExtrudeMode(false); else startCavityEdit(g.id); }} />
                    <CardAction compact icon={Move3d} label="Relocate" active={relocating}
                      title="Pick a new volume for this group in the 3D view (count, thicknesses and list order are kept)"
                      onClick={() => { if (relocating) setVolumePickMode(null); else startGroupRepick(g.id); }} />
                    {g.doorBond && (
                      <span className="shrink-0 h-[28px] pl-2 pr-1 inline-flex items-center gap-1 rounded-[7px] bg-orange-50 ring-1 ring-orange-200/70 text-[10.5px] font-semibold text-orange-700"
                        title={`Bound to a door joint (${g.doorBond.align === 'center' ? 'Half overlay — centered on the joint' : g.doorBond.align === 'min' ? 'Full overlay of the lower / left door' : 'Full overlay of the upper / right door'}): this ${g.kind} follows the doors — when the door sizes change it moves with the joint. Editing its gap here moves the door joint instead. Unbind to free it (it stays where it is).`}>
                        <DoorClosed size={12} strokeWidth={2} /><span>Door joint</span>
                        <button type="button" title="Unbind from the door joint — the panel stays where it is (to delete the panel use the trash button in the row header, or Remove in the door card)" onClick={e => { stop(e); useAppStore.getState().updatePanelGroup(g.id, { doorBond: undefined }); }}
                          className="w-[18px] h-[18px] rounded-md flex items-center justify-center text-orange-500 hover:bg-orange-100 hover:text-orange-800 transition-colors"><Unlink size={11} strokeWidth={2.2} /></button>
                      </span>
                    )}
                    <span className="flex-1 min-w-0" />
                    <FieldBox fixed label="Qty" title="Number of panels">
                      <StepBtn title="Fewer" disabled={g.count <= 1} onClick={() => applyCount(g.count - 1)}><Minus size={11} strokeWidth={2.2} /></StepBtn>
                      <input type="text" inputMode="numeric" value={countVal}
                        onChange={e => setCountDraft({ id: g.id, v: e.target.value })}
                        onBlur={() => applyCount(parseInt(countVal, 10))}
                        onKeyDown={e => { if (e.key === 'Enter') applyCount(parseInt(countVal, 10)); if (e.key === 'Escape') setCountDraft(null); }}
                        onClick={stop} className="yago-field" style={{ ...FIELD_INPUT, width: 26 }} />
                      <StepBtn title="More" onClick={() => applyCount(g.count + 1)}><Plus size={11} strokeWidth={2.2} /></StepBtn>
                    </FieldBox>
                    <FieldBox fixed label="Spacing" accent={autoGap}
                      title={autoGap ? `Target spacing ${g.targetGap} mm — the count follows the volume size. Clear to stop.` : 'Target spacing (mm): the count is set to match it and follows the volume size'}>
                      <input type="text" inputMode="decimal" value={gapVal} placeholder="auto"
                        onChange={e => setGapDraft({ id: g.id, v: e.target.value })}
                        onBlur={() => applyGap(gapVal)}
                        onKeyDown={e => { if (e.key === 'Enter') applyGap(gapVal); if (e.key === 'Escape') setGapDraft(null); }}
                        onClick={stop} className="yago-field" style={{ ...FIELD_INPUT, width: 44, textAlign: 'right', ...(autoGap ? { color: '#9a3412' } : {}) }} />
                      {autoGap ? (
                        <button type="button" title="Clear the target spacing (the current count stays)" aria-label="Clear target spacing"
                          onClick={e => { stop(e); setGapDraft(null); void setGroupTargetGap(g.id, null); }}
                          className="shrink-0 w-[18px] h-[18px] rounded-md flex items-center justify-center text-stone-400 hover:bg-[#f5f2ec] hover:text-stone-700 transition-colors"><X size={11} strokeWidth={2.4} /></button>
                      ) : unitTxt('mm')}
                    </FieldBox>
                    <IconSquareBtn icon={Equal} title="Equalize gaps (unlock all)" onClick={() => { void equalizeGroupGaps(g.id); }} />
                  </div>
                );
              })()}
              {/* Şema sırası = geometrik sıra (memberVfIds); numara = listedeki sıra (members) — ikisi farklı olabilir. */}
              <GroupSchematic group={g} selectedIndex={g.memberVfIds.findIndex(id => selectedPanelRow === `vf-${id}`)}
                memberLabels={g.memberVfIds.map((id, i) => { const mi = members.findIndex(m => m.id === id); return `${label}.${(mi >= 0 ? mi : i) + 1}`; })}
                onEditGap={(k, v, pv) => { if (pv) previewGroupGap(g.id, k, v); else void editGroupGap(g.id, k, v); }} onToggleLock={k => toggleGroupGapLock(g.id, k)}
                onEditBegin={() => groupLayoutSnapshot(g.id)} onEditCancel={snap => restoreGroupLayout(g.id, snap as GroupLayoutSnap | null)}
                doorRefs={g.memberVfIds.map(id => !!virtualFaces.find(f => f.id === id)?.doorBound)}
                backRefs={g.memberVfIds.map(id => vfBackBound(virtualFaces.find(f => f.id === id)))}
                onToggleBackRef={i => { const id = g.memberVfIds[i]; const f = virtualFaces.find(x => x.id === id); if (f) setVfBackBound(id, !vfBackBound(f)); }}
                onEditThickness={(i, v, pv) => { if (pv) previewGroupMemberThickness(g.id, i, v); else void setGroupMemberThickness(g.id, i, v); }}
                onSelectMember={i => { const id = g.memberVfIds[i]; if (id) setSelectedPanelRow(`vf-${id}`, sid); }}
                onToggleDoorRef={i => { const id = g.memberVfIds[i]; const f = virtualFaces.find(x => x.id === id); if (f) setVfDoorBound(id, !f.doorBound); }} />
              {cavityDock(g)}
              {cavityStepsPanel(g)}
              <SectionHead label="Panels" count={members.length} />
              <div className="flex flex-col gap-[2px]">
                {members.map((m, mi) => vfRow(m, rowIdx, `${label}.${mi + 1}`, { member: true, group: g }))}
              </div>
            </div>
          )}
        </div>
      );
    };

    const doorCard = (g: DoorGroup, members: VirtualFace[], rowIdx: number, label: string) => {
      const rowKey = `grp-${g.id}`;
      const selAll = selectedDoorGroupId === g.id;
      const open = openCards.has(g.id) || selAll || members.some(m => selectedPanelRow === `vf-${m.id}`);
      const dimsW = round1(g.rect.u1 - g.rect.u0), dimsH = round1(g.rect.v1 - g.rect.v0);
      const doorParent = open ? shapeById(g.shapeId, shapes) : undefined;   // pahalı: kesimler yalnız kart açıkken çözülür
      const doorCuts = doorParent ? collectDoorCuts(doorParent, shapes, virtualFaces) : [];
      const mIds = members.map(m => m.id);
      const toggleRow = (e: React.MouseEvent) => { stop(e); if (open) closeCard(g.id, mIds); else { setSelectedDoorGroupId(g.id); openCard(g.id); } };
      const noun = 'door', Noun = 'Door';
      type DraftField = 't' | 'gap';
      const draft = (field: DraftField, fallback: number) => (doorDraft?.id === g.id && doorDraft.field === field ? doorDraft.v : String(fallback));
      const applyDraft = (field: DraftField) => {
        const v = parseFloat(draft(field, field === 't' ? g.thickness : g.gap).replace(',', '.'));
        setDoorDraft(null);
        if (!Number.isFinite(v)) return;
        if (field === 't') void setDoorThickness(g.id, v); else void setDoorGap(g.id, v);
      };
      const numInput = (field: DraftField, fallback: number) => (
        <input type="text" inputMode="decimal" value={draft(field, fallback)}
          onChange={e => setDoorDraft({ id: g.id, field, v: e.target.value })}
          onBlur={() => applyDraft(field)}
          onKeyDown={e => { if (e.key === 'Enter') applyDraft(field); if (e.key === 'Escape') setDoorDraft(null); }}
          onClick={stop} className="yago-field" style={{ ...FIELD_INPUT, width: 34, textAlign: 'right' }} />
      );
      const solvedTree = solveDoorTree(g);
      const leaves = doorLeaves(g.tree);
      const allLeafIds = leaves.map(l => l.id);
      const selMemberIdx = g.memberVfIds.findIndex(id => selectedPanelRow === `vf-${id}`);
      const picked = doorNodeSel?.id === g.id ? doorNodeSel.nodes.filter(id => !!findDoorNode(g.tree, id)) : [];
      const primaryId = picked[picked.length - 1] as string | undefined;
      const primary = primaryId ? findDoorNode(g.tree, primaryId) : null;
      const leavesUnder = (id: string) => { const n = findDoorNode(g.tree, id); return n ? doorLeaves(n).map(l => l.id) : []; };
      const typeTargets = picked.length ? [...new Set(picked.flatMap(leavesUnder))] : allLeafIds;
      const typeOf = (id: string) => leaves.find(l => l.id === id)?.type ?? 'left';
      const commonType = typeTargets.length && typeTargets.every(id => typeOf(id) === typeOf(typeTargets[0])) ? typeOf(typeTargets[0]) : null;
      const typeHint = !picked.length ? (allLeafIds.length === 1 ? '1 door' : `All · ${allLeafIds.length}`) : `${typeTargets.length} / ${allLeafIds.length}`;
      // Seçili düğüm yoldaysa bir seviye iner; yaprak tekrar tıklanırsa seçim kalkar; yolda değilse kök.
      const onPathClick = (path: string[], additive: boolean) => {
        if (!path.length) return;
        if (!additive) {
          const i = primaryId ? path.indexOf(primaryId) : -1;
          if (i < 0) setDoorNodeSel({ id: g.id, nodes: [path[0]] });
          else if (i >= path.length - 1) setDoorNodeSel(null);
          else setDoorNodeSel({ id: g.id, nodes: [path[i + 1]] });
          return;
        }
        const depth = primaryId ? (findSolvedNode(solvedTree, primaryId)?.depth ?? path.length - 1) : path.length - 1;
        const node = path[Math.min(depth, path.length - 1)];
        const next = picked.includes(node) ? picked.filter(x => x !== node) : [...picked, node];
        setDoorNodeSel(next.length ? { id: g.id, nodes: next } : null);
      };
      const applyType = (t: DoorType) => { void setDoorLeafTypes(g.id, typeTargets, t); setDoorNodeSel(null); };
      const splitNode = primary ?? g.tree;
      const countOf = (ax: 'u' | 'v') => (splitNode.kind === 'split' && splitNode.axis === ax ? splitNode.children.length : 1);
      const setCount = (ax: 'u' | 'v', n: number) => {
        const targets = picked.length ? picked : [g.tree.id];
        const ids = targets.map(id => setDoorNodeSplit(g.id, id, ax, n)).filter((x): x is string => !!x);
        setDoorNodeSel(ids.length ? { id: g.id, nodes: ids } : null);   // sonuç bölge seçili kalır (ardışık ayar)
      };
      const refMode = doorRefPickGroupId === g.id;
      const splitMode: 'count' | 'ref' | 'spacing' = refMode ? 'ref' : doorSplitMode?.id === g.id ? doorSplitMode.mode : 'count';
      const pickSplitMode = (m: 'count' | 'ref' | 'spacing') => {
        if (m === 'ref') { setDoorAddPick(null); setDoorRefPickGroupId(g.id); return; }
        if (refMode) setDoorRefPickGroupId(null);
        setDoorSplitMode({ id: g.id, mode: m });
      };
      const addPick = doorAddPick?.id === g.id ? doorAddPick.axis : null;
      const toggleAddPick = (axis: 'u' | 'v') => { if (addPick === axis) setDoorAddPick(null); else { if (refMode) setDoorRefPickGroupId(null); setDoorAddPick({ id: g.id, axis }); } };
      // Her parça kendi grubu (listede kendi kartı); yeni kart bilinçli olarak otomatik AÇILMAZ/seçilmez — kapak kartı açık kalır.
      const onAddPick = (splitId: string, k: number, ats: number[]) => {
        const made = ats.map(at => addPanelAtDoorJoint(g.id, splitId, k, at)).filter((pg): pg is PanelGroup => !!pg);
        if (!made.length) return;
        setDoorAddPick(null);
        setSelectedDoorGroupId(g.id);
        openCard(g.id);
      };
      const onRemovePick = (pgId: string) => { deletePanelGroupWithMembers(pgId); };
      const addedCount = (axis: 'u' | 'v') => panelGroups.filter(pg => pg.doorBond?.doorGroupId === g.id && pg.axis === (axis === 'u' ? doorPlaneAxes(g.axis).u : doorPlaneAxes(g.axis).v)).length;
      const addJointCount = (axis: 'u' | 'v') => doorJoints(solvedTree).filter(j => j.axis === axis).length;
      // addObstacles yalnız araya ekleme modunda: işaretsiz dikme/raflar da derzi keser.
      const nearPanels = doorParent ? doorNearPanels(g, doorParent, shapes, virtualFaces, panelGroups) : [];
      const addObstacles = doorParent && addPick ? doorNearPanels(g, doorParent, shapes, virtualFaces, panelGroups, undefined, true) : undefined;
      const freePartCount = addPick ? doorJointParts(doorJoints(solvedTree), addObstacles ?? nearPanels, addPick).reduce((a, p) => a + p.free.length, 0) : 0;
      // Spacing: yoksa kapsamdaki ilk hedef gösterilir (iptal edilebilsin); iptal kapsamdaki o eksenli TÜM hedefleri kaldırır.
      const scopeIds = picked.length ? picked : [g.tree.id];
      const sizeOf = (ax: 'u' | 'v') => {
        if (splitNode.kind === 'split' && splitNode.axis === ax && splitNode.targetSize) return splitNode.targetSize;
        return doorSpacingTargetsInScope(g.tree, scopeIds, ax)[0]?.targetSize ?? null;
      };
      const setSize = (ax: 'u' | 'v', mm: number | null) => {
        if (mm == null) { clearDoorSpacing(g.id, scopeIds, ax); return; }
        const ids = scopeIds.map(id => setDoorNodeSpacing(g.id, id, ax, mm)).filter((x): x is string => !!x);
        setDoorNodeSel(ids.length ? { id: g.id, nodes: ids } : null);
      };
      const onRefPick = (vfId: string) => { const ids = splitDoorAtPanel(g.id, vfId); if (ids.length) { setDoorRefPickGroupId(null); setDoorNodeSel({ id: g.id, nodes: ids }); } };
      // Sonradan konan sınır levhası: kapak levhanın ortasından bölünür (Half) ve sol/üst kapak seçilir → aynı rozet Full/Half/None döner.
      const onSplitAtPanel = (vfId: string) => {
        const ids = splitDoorAtPanel(g.id, vfId);
        if (!ids.length) return;
        const tree = useAppStore.getState().doorGroups.find(x => x.id === g.id)?.tree;
        const sp = tree ? findDoorNode(tree, ids[0]) : null;
        const leafId = sp && sp.kind === 'split' ? sp.children[0]?.id : undefined;
        setSelectedPanelRow(null);
        setDoorNodeSel({ id: g.id, nodes: leafId ? [leafId] : ids });
      };
      const regionName = !primary ? 'whole door area' : primary.kind === 'leaf' ? 'the selected door' : `the selected region (${primary.axis === 'u' ? 'V' : 'H'} ×${primary.children.length})`;
      const sizeTitle = (ax: 'u' | 'v') => `Spacing ${ax === 'u' ? 'V — target door width' : 'H — target door height'} (mm) for ${regionName}: the number of pieces is derived from the region length (nearest fit, equal pieces) and re-derived when the body resizes. Clear it (× or empty + Enter) to cancel the target — the current pieces stay.`;
      const countTitle = (ax: 'u' | 'v') => `${ax === 'u' ? 'Split V — pieces side by side' : 'Split H — pieces stacked'} in ${regionName}. ` +
        `Type or step the number of pieces (1 = not split on this axis). ${splitNode.kind === 'split' && splitNode.axis !== ax ? 'This region is already split the other way: splitting here keeps that split in every new piece (e.g. V ×2 then H ×2 = 2 rows × 2 columns).' : ''}` +
        (picked.length > 1 ? ` Applies to ${picked.length} selected regions.` : '');
      return (
        <div key={rowKey} className={rowCardClass(open, dragIndex === rowIdx, armedRowKey === rowKey)}>
          <div className={`relative flex items-stretch ${selAll ? ROW_SEL_HEAD : ''}`}>
            {selAll && <span className={ROW_SEL_BAR} />}
            {grip(rowKey, rowIdx, 'Drag to reorder (whole group)')}
            <div onClick={toggleRow} className="flex-1 min-w-0 relative flex items-center gap-1 pl-0 pr-0.5 py-[4px] cursor-pointer" title={open ? 'Collapse' : `Expand — selects all ${noun}s in this group`}>
              <RowNum label={label} active={selAll} />
              <RowTypeBadge kind="door" active={open} count={doorMemberCount(g)} />
              <input type="text" value={doorGroupName(g)} onClick={stop} onChange={e => renameDoorGroup(g.id, e.target.value)} placeholder={Noun}
                title={`Group name (applies to all its ${noun}s)`} className={`${ROW_INPUT_CLASS} font-semibold`} />
              <RowDims w={dimsW} h={dimsH} t={g.thickness} tLetter="T" title={`${Noun} area width · height · thickness (${doorPlacementLabel(g.placement).toLowerCase()} ${noun})`} />
              <div className="flex items-center justify-end gap-[1px] shrink-0" style={{ width: ROW_TRAIL_W }} onClick={stop}>
                <button onClick={e => { stop(e); deleteDoorGroupWithMembers(g.id); }} title={`Delete group (all ${noun}s)`} className={ROW_DEL_CLASS}><Trash2 size={ROW_ICON - 1} strokeWidth={1.9} /></button>
                <RowChevron open={open} onClick={toggleRow} />
              </div>
            </div>
          </div>
          {open && (
            <div className="yago-expand px-2 pt-2 pb-2" style={{ borderTop: '1px solid #efebe5', fontFamily: UI_FONT }} onClick={stop}>
              <div className="flex items-center gap-1 mb-1.5">
                <PlacementSelect value={g.placement} onChange={v => { void setDoorPlacement(g.id, v); }} />
                <FieldBox fixed label="T" title={`${Noun} thickness (mm)`}>{numInput('t', g.thickness)}{unitTxt('mm')}</FieldBox>
                <SplitModeSelect value={splitMode} onChange={pickSplitMode} />
                {splitMode === 'count' && <>
                  <CountBox icon={SplitSquareVertical} label="V" value={countOf('u')} title={countTitle('u')} onChange={n => setCount('u', n)} />
                  <CountBox icon={SplitSquareHorizontal} label="H" value={countOf('v')} title={countTitle('v')} onChange={n => setCount('v', n)} />
                </>}
                {splitMode === 'spacing' && <>
                  <SizeBox icon={SplitSquareVertical} label="V" value={sizeOf('u')} title={sizeTitle('u')} onChange={mm => setSize('u', mm)} />
                  <SizeBox icon={SplitSquareHorizontal} label="H" value={sizeOf('v')} title={sizeTitle('v')} onChange={mm => setSize('v', mm)} />
                </>}
                {splitMode === 'ref' && (
                  <div className="flex-1 min-w-0"><DockStatus ready text="Pick a divider / shelf" title={`${Noun}-reference dividers and shelves glow amber in the 3D view (${noun}s go transparent); click one in the 3D view or its band in the schematic. The ${noun} splits through the panel's middle and the joint is bound to the panel: when the panel moves, the ${noun}s follow. Esc / another mode cancels.`} /></div>
                )}
                <IconSquareBtn icon={Equal} title="Equalize sizes (unlock all)" onClick={() => { void equalizeDoorGroup(g.id); }} />
              </div>
              <div className="flex items-center gap-1 mb-1.5">
                <span className="shrink-0 pl-0.5 pr-1 text-[10px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]">Between doors</span>
                <CardAction compact icon={Columns3} label="Divider" active={addPick === 'u'} tone="amber"
                  title={g.placement !== 'outer' ? 'Add a divider between two doors — outer doors only (inner doors sit between the panels).' : addJointCount('u') ? `Add a divider between two side-by-side doors: pick a vertical joint in the schematic (${addJointCount('u')}). The divider is created behind that joint, listed after this door row, and follows the joint when the doors change.` : 'No vertical door joint yet — split the door with Split V first.'}
                  onClick={() => toggleAddPick('u')} />
                <CardAction compact icon={Rows3} label="Shelf" active={addPick === 'v'} tone="amber"
                  title={g.placement !== 'outer' ? 'Add a shelf between two doors — outer doors only (inner doors sit between the panels).' : addJointCount('v') ? `Add a shelf between two stacked doors: pick a horizontal joint in the schematic (${addJointCount('v')}). The shelf is created behind that joint, listed after this door row, and follows the joint when the doors change.` : 'No horizontal door joint yet — split the door with Split H first.'}
                  onClick={() => toggleAddPick('v')} />
                {addPick && (
                  <DockStatus ready={g.placement === 'outer' && freePartCount > 0}
                    text={g.placement !== 'outer' ? 'Outer doors only'
                      : !addJointCount(addPick) ? `No ${addPick === 'u' ? 'vertical' : 'horizontal'} joint — split the door first`
                      : freePartCount ? `Click a ${addPick === 'u' ? 'vertical' : 'horizontal'} joint to add (Shift: all parts)${addedCount(addPick) ? ' · ✕ Remove to delete' : ''}`
                      : `Every part of the ${addPick === 'u' ? 'vertical' : 'horizontal'} joint${addJointCount(addPick) > 1 ? 's' : ''} already has a ${addPick === 'u' ? 'divider' : 'shelf'}${addedCount(addPick) ? ' · ✕ Remove to delete' : ''}`}
                    title="The highlighted gaps between doors are the joints you can place the panel at — a joint crossed by a divider / shelf is split into parts, each part takes its own panel (its own row in the list). A panel already added between doors shows ✕ Remove. Esc cancels." />
                )}
              </div>
              <DoorTypeBar value={commonType} hint={typeHint} onPick={applyType} />
              <DoorSchematic group={g} selectedIndex={selMemberIdx} selectedNodes={picked}
                memberLabels={g.memberVfIds.map((id, i) => { const mi = members.findIndex(m => m.id === id); return `${label}.${(mi >= 0 ? mi : i) + 1}`; })}
                cuts={doorCuts}
                nearPanels={nearPanels} addObstacles={addObstacles}
                refPick={refMode} onRefPick={onRefPick} onSplitAtPanel={onSplitAtPanel}
                addPick={addPick} onAddPick={onAddPick} onRemovePick={onRemovePick}
                onEditSize={(sid, k, v, pv) => { void editDoorSize(g.id, sid, k, v, { preview: pv }); }} onToggleLock={(sid, k) => toggleDoorSizeLock(g.id, sid, k)}
                onEditSplitGap={(sid, k, v, pv) => { void setDoorSplitGap(g.id, sid, k, v, { preview: pv }); }}
                onEditEdgeGap={(edge, v, pv) => { void setDoorEdgeGap(g.id, edge, v, { preview: pv }); }}
                onEditLeaf={(lid, k, v, pv) => { void editDoorLeafSize(g.id, lid, k, v, { preview: pv }); }} onEditLeafGap={(lid, v, pv) => { void setDoorLeafGap(g.id, lid, v, { preview: pv }); }}
                onEditBegin={() => doorLayoutSnapshot(g.id)} onEditCancel={snap => restoreDoorLayout(g.id, snap as DoorLayoutSnap | null)}
                onToggleHalfOverlay={(edge, on) => { void setDoorHalfOverlay(g.id, edge, on); }}
                onEdgeOverlay={(edge, mode) => { void setDoorEdgeOverlay(g.id, edge, mode); }}
                onAlignJoint={(sid, k, vfId, a) => { void setDoorJointRef(g.id, sid, k, vfId, a); }}
                onJointOverlay={(sid, k, vfId, a) => { void setDoorJointOverlay(g.id, sid, k, vfId, a); }}
                onPathClick={onPathClick} />
              <SectionHead label="Doors" count={members.length} />
              <div className="flex flex-col gap-[2px]">
                {members.map((m, mi) => vfRow(m, rowIdx, `${label}.${mi + 1}`, { member: true, door: g }))}
              </div>
            </div>
          )}
        </div>
      );
    };

    // ARKALIK kartı (BackService): kapak kartından AYRI — kontrol satırı (T · Setback · bölme modu · V/H · eşitle), tip barı,
    // şema ve üyeler. Bölge seçimi/bölme modu bu kartın durumudur; Panel ref modu store'da (3B'de levha tıkı).
    const backCard = (g: BackGroup, members: VirtualFace[], rowIdx: number, label: string) => {
      const rowKey = `grp-${g.id}`;
      const selAll = selectedBackGroupId === g.id;
      const open = openCards.has(g.id) || selAll || members.some(m => selectedPanelRow === `vf-${m.id}`);
      const mIds = members.map(m => m.id);
      const toggleRow = (e: React.MouseEvent) => { stop(e); if (open) closeCard(g.id, mIds); else { setSelectedBackGroupId(g.id); openCard(g.id); } };
      // Satır W/H = arkalık parçalarının GERÇEK dış ölçüsü (kanala giriş dahil — Goker: "In değeri etki etmiyor" sanılıyordu); üretilmemişse açıklık dikdörtgeni.
      const memberBoxes = members.map(m => localBboxOf(panelOfVf(m.id, shapes)?.geometry)).filter((b): b is THREE.Box3 => !!b);
      const ext = memberBoxes.length ? memberBoxes.reduce((acc, b) => acc.union(b), memberBoxes[0].clone()) : null;
      const dimsW = ext ? round1(ext.max.x - ext.min.x) : round1(g.rect.u1 - g.rect.u0), dimsH = ext ? round1(ext.max.y - ext.min.y) : round1(g.rect.v1 - g.rect.v0);
      const backParent = open ? shapeById(g.shapeId, shapes) : undefined;   // pahalı: kesimler/çözüm yalnız kart açıkken
      const backCuts = backParent ? collectBackCuts(backParent, shapes, virtualFaces) : [];
      // Çözüm: iç dikdörtgen + parça dikdörtgenleri (her parça kendi tip / setback / inset / bini değerleriyle). Gövde yoksa kenar bilgisiz.
      const sol = (backParent && solveBackGroup(g, backParent, shapes)) || backFallbackSolution(g);
      const solvedTree = sol.solved;
      const selMemberIdx = g.memberVfIds.findIndex(id => selectedPanelRow === `vf-${id}`);
      const picked = backNodeSel?.id === g.id ? backNodeSel.nodes.filter(id => !!findBackNode(g.tree, id)) : [];
      const primaryId = picked[picked.length - 1] as string | undefined;
      const primary = primaryId ? findBackNode(g.tree, primaryId) : null;
      // HEDEF PARÇALAR (tip / setback): seçili bölgelerin yaprakları, yoksa seçili üye satırının parçası, yoksa tüm parçalar (grup varsayılanı yazılır).
      const leafOf = (id: string) => { const n = findBackNode(g.tree, id); return n && n.kind === 'leaf' ? n : null; };
      const memberLeaf = selMemberIdx >= 0 ? backLeafOfMember(g, selMemberIdx) : undefined;
      const scoped = picked.length > 0 || !!memberLeaf;
      const targetLeafIds = picked.length ? picked.flatMap(id => { const n = findBackNode(g.tree, id); return n ? backLeaves(n).map(l => l.id) : []; }) : memberLeaf ? [memberLeaf.id] : backLeaves(g.tree).map(l => l.id);
      const targetPieces = targetLeafIds.map(id => backPieceOf(g, leafOf(id)));
      const commonPlacement: BackPlacement | null = targetPieces.length && targetPieces.every(p => p.placement === targetPieces[0].placement) ? targetPieces[0].placement : null;
      const groovedTargets = targetPieces.filter(p => p.placement === 'inner');
      const isGrooved = groovedTargets.length > 0;   // hedef parçalarda kanallı var → kanal bloğu etkin; yoksa çakma görünümü, paylar pasif
      const setbackVal = groovedTargets.length ? groovedTargets[0].setback : backSetbackOf(g);
      const setbackMixed = groovedTargets.some(p => Math.abs(p.setback - setbackVal) > 0.05);
      const memberLabelOf = (leafId: string) => { const li = backLeaves(g.tree).findIndex(l => l.id === leafId); const vfId = g.memberVfIds[li]; const mi = members.findIndex(m => m.id === vfId); return `${label}.${(mi >= 0 ? mi : li) + 1}`; };
      const typeHint = !scoped ? 'All pieces' : targetLeafIds.length === 1 ? `Piece ${memberLabelOf(targetLeafIds[0])}` : `${targetLeafIds.length} pieces`;
      const allKinds = new Set(backLeaves(g.tree).map(l => backPieceOf(g, l).placement));
      const typeTxt = allKinds.size > 1 ? 'mixed nailed / grooved pieces' : `${BACK_TYPE_LABEL[[...allKinds][0] ?? g.placement].toLowerCase()} back panel`;
      type DraftField = 't' | 'setback' | 'gf' | 'gb' | 'gd';
      // KANAL PAYI kapsamı: şemada bir kenarın "±" rozeti seçiliyse yalnız o kenar, değilse grup değeri (aynı satırda).
      const clearVf = backClearEdge?.id === g.id && virtualFaces.some(f => f.id === backClearEdge.vfId) ? backClearEdge.vfId : undefined;
      const clearName = clearVf ? (virtualFaces.find(f => f.id === clearVf)?.description || 'Edge') : '';
      const clearOwn = !!clearVf && backGrooveClearOverridden(g, clearVf);
      const gc = backGrooveClearOf(g, clearVf);
      const draft = (field: DraftField, fallback: number) => (backDraft?.id === g.id && backDraft.field === field && (backDraft.scope ?? '') === (clearVf ?? '') ? backDraft.v : String(fallback));
      const applyDraft = (field: DraftField) => {
        const v = parseFloat(draft(field, field === 't' ? g.thickness : field === 'setback' ? setbackVal : field === 'gf' ? gc.front : field === 'gb' ? gc.back : gc.depth).replace(',', '.'));
        setBackDraft(null);
        if (!Number.isFinite(v)) return;
        if (field === 't') void setBackThickness(g.id, v);
        else if (field === 'setback') void setBackSetback(g.id, v, scoped ? targetLeafIds : []);
        else void setBackGrooveClear(g.id, { [field === 'gf' ? 'front' : field === 'gb' ? 'back' : 'depth']: v }, clearVf);
      };
      const numInput = (field: DraftField, fallback: number, mixed = false, w = 30, title?: string, passive = false) => (
        <input type="text" inputMode="decimal" value={passive ? '0' : draft(field, fallback)} placeholder={mixed ? '…' : undefined} title={title} disabled={passive}
          onChange={e => setBackDraft({ id: g.id, field, v: e.target.value, scope: clearVf })}
          onBlur={() => applyDraft(field)}
          onKeyDown={e => { if (e.key === 'Enter') applyDraft(field); if (e.key === 'Escape') setBackDraft(null); }}
          onClick={stop} className="yago-field" style={{ ...FIELD_INPUT, width: w, flexShrink: 0, textAlign: 'right', ...(mixed ? { color: '#9a3412' } : {}), ...(passive ? { color: '#c7beb1', cursor: 'default' } : {}) }} />
      );
      // Görsel ipucu: üzerine gelinen değerin anahtarı → diyagram + şema vurgusu + açıklama satırı.
      const hintKey = backHint?.id === g.id ? backHint.key : null;
      const onHint = (k: string | null) => setBackHint(k ? { id: g.id, key: k } : null);
      // Seçili düğüm yoldaysa bir seviye iner; yaprak tekrar tıklanırsa seçim kalkar; yolda değilse kök.
      const onPathClick = (path: string[], additive: boolean) => {
        if (!path.length) return;
        if (!additive) {
          const i = primaryId ? path.indexOf(primaryId) : -1;
          if (i < 0) setBackNodeSel({ id: g.id, nodes: [path[0]] });
          else if (i >= path.length - 1) setBackNodeSel(null);
          else setBackNodeSel({ id: g.id, nodes: [path[i + 1]] });
          return;
        }
        const depth = primaryId ? (findSolvedBackNode(solvedTree, primaryId)?.depth ?? path.length - 1) : path.length - 1;
        const node = path[Math.min(depth, path.length - 1)];
        const next = picked.includes(node) ? picked.filter(x => x !== node) : [...picked, node];
        setBackNodeSel(next.length ? { id: g.id, nodes: next } : null);
      };
      const splitNode = primary ?? g.tree;
      const countOf = (ax: 'u' | 'v') => (splitNode.kind === 'split' && splitNode.axis === ax ? splitNode.children.length : 1);
      const setCount = (ax: 'u' | 'v', n: number) => {
        const targets = picked.length ? picked : [g.tree.id];
        const ids = targets.map(id => setBackNodeSplit(g.id, id, ax, n)).filter((x): x is string => !!x);
        setBackNodeSel(ids.length ? { id: g.id, nodes: ids } : null);   // sonuç bölge seçili kalır (ardışık ayar)
      };
      const refMode = backRefPickGroupId === g.id;
      const nearPanels = backParent ? backNearPanels(g, backParent, shapes, virtualFaces, panelGroups) : [];
      const onRefPick = (vfId: string) => { const ids = splitBackAtPanel(g.id, vfId); if (ids.length) { setBackRefPickGroupId(null); setBackNodeSel({ id: g.id, nodes: ids }); } };
      // Sonradan konan sınır levhası: arkalık levhanın ortasından bölünür (Half) ve sol/üst parça seçilir → aynı rozet Full/Half/None döner.
      const onSplitAtPanel = (vfId: string) => {
        const ids = splitBackAtPanel(g.id, vfId);
        if (!ids.length) return;
        const tree = useAppStore.getState().backGroups.find(x => x.id === g.id)?.tree;
        const sp = tree ? findBackNode(tree, ids[0]) : null;
        const leafId = sp && sp.kind === 'split' ? sp.children[0]?.id : undefined;
        setSelectedPanelRow(null);
        setBackNodeSel({ id: g.id, nodes: leafId ? [leafId] : ids });
      };
      const regionName = !primary ? 'whole back area' : primary.kind === 'leaf' ? 'the selected piece' : `the selected region (${primary.axis === 'u' ? 'V' : 'H'} ×${primary.children.length})`;
      const countTitle = (ax: 'u' | 'v') => `${ax === 'u' ? 'Split V — pieces side by side' : 'Split H — pieces stacked'} in ${regionName}. ` +
        `Type or step the number of pieces (1 = not split on this axis). ${splitNode.kind === 'split' && splitNode.axis !== ax ? 'This region is already split the other way: splitting here keeps that split in every new piece (e.g. V ×2 then H ×2 = 2 rows × 2 columns).' : ''}` +
        (picked.length > 1 ? ` Applies to ${picked.length} selected regions.` : '');
      return (
        <div key={rowKey} className={rowCardClass(open, dragIndex === rowIdx, armedRowKey === rowKey)}>
          <div className={`relative flex items-stretch ${selAll ? ROW_SEL_HEAD : ''}`}>
            {selAll && <span className={ROW_SEL_BAR} />}
            {grip(rowKey, rowIdx, 'Drag to reorder (whole group)')}
            <div onClick={toggleRow} className="flex-1 min-w-0 relative flex items-center gap-1 pl-0 pr-0.5 py-[4px] cursor-pointer" title={open ? 'Collapse' : 'Expand — selects all back panels in this group'}>
              <RowNum label={label} active={selAll} />
              <RowTypeBadge kind="back" active={open} count={backMemberCount(g)} />
              <input type="text" value={backGroupName(g)} onClick={stop} onChange={e => renameBackGroup(g.id, e.target.value)} placeholder="Back"
                title="Group name (applies to all its back panels)" className={`${ROW_INPUT_CLASS} font-semibold`} />
              <RowDims w={dimsW} h={dimsH} t={g.thickness} tLetter="T" title={`Back panel overall width · height (groove entry included) · thickness (${typeTxt})`} />
              <div className="flex items-center justify-end gap-[1px] shrink-0" style={{ width: ROW_TRAIL_W }} onClick={stop}>
                <button onClick={e => { stop(e); deleteBackGroupWithMembers(g.id); }} title="Delete group (all back panels)" className={ROW_DEL_CLASS}><Trash2 size={ROW_ICON - 1} strokeWidth={1.9} /></button>
                <RowChevron open={open} onClick={toggleRow} />
              </div>
            </div>
          </div>
          {open && (
            <div className="yago-expand px-2 pt-2 pb-2" style={{ borderTop: '1px solid #efebe5', fontFamily: UI_FONT }} onClick={stop}>
              {/* KANAL BLOĞU — her tipte: solda büyük kesit diyagramı (kanallı: kanal + paylar; çakma: panelin arkasına çakılmış),
                  sağda üstte tip (Nailed / Grooved) ve bölme V / H / =, altta değer hücreleri. Çakmada setback ve paylar 0 ve pasif.
                  Başlık / açıklama / metin ipucu yok; geri bildirim görsel (hücre → diyagram + şema vurgusu). */}
              {/* KANAL BLOĞU: solda kesit diyagramı (yükseklik = 4 eşit satır), sağda 4 satır × 2 sütun — satır 1: tip combobox'ı + bölme
                  V / H; satır 2–4: Thick · Setback / Front + · Rear + / Bottom + · Groove. Çakmada setback ve paylar 0 ve pasif. */}
              <div className="mb-1.5 flex gap-1.5" style={{ height: BACK_BLOCK_H }} onMouseLeave={() => setBackHint(null)}>
                <div className="relative shrink-0 h-full" style={{ width: `min(${BACK_DIAGRAM_W}px, 40%)` }}>
                  <BackGrooveDiagram active={hintKey} grooved={isGrooved} t={g.thickness} setback={isGrooved ? setbackVal : 0} front={gc.front} rear={gc.back} depth={gc.depth} className="w-full h-full" />
                  {/* Kenar kapsamı (şemadaki ± rozeti): yalnız bir kenar seçiliyken. */}
                  {clearVf && (
                    <div className="absolute bottom-1 right-1 flex items-center gap-[2px]">
                      <button type="button" onClick={e => { stop(e); setBackClearEdge(null); }}
                        className="h-[17px] pl-1.5 pr-1 rounded-full flex items-center gap-[2px] bg-orange-50 ring-1 ring-orange-300 text-orange-700 text-[9.5px] font-semibold hover:bg-orange-100 max-w-[110px]">
                        <span className="truncate">{clearName}</span><X size={9} strokeWidth={2.6} className="shrink-0" /></button>
                      {clearOwn && <button type="button" onClick={e => { stop(e); void resetBackGrooveClear(g.id, clearVf); }}
                        className="w-[17px] h-[17px] rounded-full flex items-center justify-center bg-orange-50 ring-1 ring-orange-300 text-orange-600 hover:bg-orange-100"><RotateCcw size={9} strokeWidth={2.4} /></button>}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0 grid grid-cols-2 gap-x-1" style={{ gridTemplateRows: 'repeat(4, minmax(0, 1fr))', rowGap: BACK_ROW_GAP }}>
                  <BackTypeButtons value={commonPlacement} hint={typeHint} onPick={t => { void setBackPlacement(g.id, t, scoped ? targetLeafIds : []); }} />
                  <div className="min-w-0 h-full grid grid-cols-2 gap-1">
                    <CountMini icon={SplitSquareVertical} value={countOf('u')} title={countTitle('u')} onChange={n => setCount('u', n)} />
                    <CountMini icon={SplitSquareHorizontal} value={countOf('v')} title={countTitle('v')} onChange={n => setCount('v', n)} />
                  </div>
                  <HintCell label="Thick" hintKey="t" active={hintKey === 't'} onHint={onHint}>{numInput('t', g.thickness, false, 34)}</HintCell>
                  <HintCell label="Setback" hintKey="setback" active={hintKey === 'setback'} onHint={onHint} accent={scoped && isGrooved} passive={!isGrooved}>{numInput('setback', setbackVal, setbackMixed, 34, undefined, !isGrooved)}</HintCell>
                  <HintCell label="Front" hintKey="gf" active={hintKey === 'gf'} onHint={onHint} accent={!!clearVf} passive={!isGrooved}>{numInput('gf', gc.front, false, 34, undefined, !isGrooved)}</HintCell>
                  <HintCell label="Rear" hintKey="gb" active={hintKey === 'gb'} onHint={onHint} accent={!!clearVf} passive={!isGrooved}>{numInput('gb', gc.back, false, 34, undefined, !isGrooved)}</HintCell>
                  <HintCell label="Bottom" hintKey="gd" active={hintKey === 'gd'} onHint={onHint} accent={!!clearVf} passive={!isGrooved}>{numInput('gd', gc.depth, false, 34, undefined, !isGrooved)}</HintCell>
                  <div className={`min-w-0 h-full pl-2 pr-1.5 flex items-center gap-1 rounded-[7px] bg-[#f6f2ec] ${isGrooved ? '' : 'opacity-60'}`}>
                    <span className="flex-1 min-w-0 truncate text-[10px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]">Groove</span>
                    <span className="whitespace-nowrap" style={{ ...FIELD_INPUT, width: 'auto', color: '#57534e' }}>{isGrooved ? <>{fmt1(g.thickness + gc.front + gc.back)}<span className="text-[10px] font-medium text-stone-400" style={{ fontFamily: UI_FONT }}> ×In+{fmt1(gc.depth)}</span></> : '—'}</span>
                  </div>
                </div>
              </div>
              <BackSchematic group={g} solution={sol} selectedIndex={selMemberIdx} selectedNodes={picked}
                memberLabels={g.memberVfIds.map((id, i) => { const mi = members.findIndex(m => m.id === id); return `${label}.${(mi >= 0 ? mi : i) + 1}`; })}
                cuts={backCuts} nearPanels={nearPanels}
                refPick={refMode} onRefPick={onRefPick} onSplitAtPanel={onSplitAtPanel}
                onEditSize={(sid, k, v, pv) => { void editBackSize(g.id, sid, k, v, { preview: pv }); }} onToggleLock={(sid, k) => toggleBackSizeLock(g.id, sid, k)}
                onEditSplitGap={(sid, k, v, pv) => { void setBackSplitGap(g.id, sid, k, v, { preview: pv }); }}
                onEditInset={(edge, mm, ids, pv) => { void setBackEdgeInset(g.id, edge, mm, ids, { preview: pv }); }}
                onEditJointIn={(edge, mm, ids, pv) => { void setBackJointIn(g.id, edge, mm, ids, { preview: pv }); }}
                onEditBegin={() => backLayoutSnapshot(g.id)} onEditCancel={snap => restoreBackLayout(g.id, snap as BackLayoutSnap | null)}
                onEditCover={(edge, mm, ids, pv) => { void setBackEdgeCover(g.id, edge, mm, ids, { preview: pv }); }}
                onToggleEdgeRel={edge => { void setBackEdgeRel(g.id, edge, edgeRelOf(g, edge) === 'nail' ? 'groove' : 'nail'); }}
                onToggleJointRel={(sid, k) => { void setBackJointRel(g.id, sid, k, backJointRelOf(g.tree, sid, k) === 'nail' ? 'groove' : 'nail'); }}
                clearVfId={clearVf} onPickClearEdge={vfId => setBackClearEdge(clearVf === vfId ? null : { id: g.id, vfId })}
                grooveHint={hintKey === 'gf' || hintKey === 'gb' || hintKey === 'gd' ? hintKey : null}
                onPathClick={onPathClick} />
              <SectionHead label="Back panels" count={members.length} />
              <div className="flex flex-col gap-[2px]">
                {members.map((m, mi) => vfRow(m, rowIdx, `${label}.${mi + 1}`, { member: true, back: g }))}
              </div>
            </div>
          )}
        </div>
      );
    };

    const elements: React.ReactNode[] = [];
    rows.forEach((row, rowIdx) => {
      const draggingThis = dragIndex === rowIdx, dropHere = dropIndex === rowIdx;
      const label = String(rowIdx + 1);
      elements.push(
        <div key={`wrap-${rowKeyOf(row)}`} className={dropHere ? 'rounded-[10px] ring-1 ring-amber-300 bg-[#fffbf0]' : ''}
          onDragOver={e => { if (dragIndex !== null && !draggingThis) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropIndex !== rowIdx) setDropIndex(rowIdx); } }}
          onDrop={e => { e.preventDefault(); if (dragIndex !== null) void onRowDropBelow(dragIndex, rowIdx); }}>
          {row.kind === 'vf' ? vfRow(row.vf, rowIdx, label, {}) : row.kind === 'door' ? doorCard(row.group, row.members, rowIdx, label) : row.kind === 'back' ? backCard(row.group, row.members, rowIdx, label) : groupCard(row.group, row.members, rowIdx, label)}
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

  /* Ortak yerleştirme şeridi: ad ve (kapakta) outer/inner yerleştirme ÖNCESİ seçilir; Enter = sahnede sağ tık. */
  const placementDock = ({ tag, defaultName, showName = true, ready, status, onConfirm, onExit, confirmTitle, lead }: {
    tag: string; defaultName: string; showName?: boolean; ready: boolean; status: string;
    onConfirm: () => void; onExit: () => void; confirmTitle: string; lead?: React.ReactNode;
  }) => (
    <div style={{ ...DOCK_SHELL, marginTop: 0, borderRadius: 0, border: 'none', borderBottom: '1px solid #ebe5dc', boxShadow: 'none', background: 'linear-gradient(180deg,#fefdfb 0%,#faf8f4 100%)' }}>
      <div style={DOCK_ROW}>
        <span style={dockAxisTag('#44403c')}>{tag}</span>
        {lead}
        {showName ? (
          <FieldBox label="" title={`Name of the new ${defaultName.toLowerCase()} (empty = ${defaultName})`}>
            <input type="text" autoFocus value={placementName} placeholder={defaultName} spellCheck={false}
              onChange={e => setPlacementName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && ready) onConfirm(); if (e.key === 'Escape') onExit(); }}
              onClick={stop} className="yago-field yago-field-text" style={{ ...FIELD_INPUT, flex: 1, width: 'auto', textAlign: 'left', fontFamily: UI_FONT }} />
          </FieldBox>
        ) : <DockStatus ready={ready} text={status} />}
        <ApplyBtn enabled={ready} onClick={onConfirm} title={confirmTitle} />
        <ExitBtn onClick={onExit} />
      </div>
      {showName && <div style={{ ...DOCK_ROW, paddingTop: 0 }}><DockStatus ready={ready} text={status} /></div>}
    </div>
  );

  const raycastDock = (() => {
    if (!raycastMode) return null;
    const ready = !!selectedShape && !!raycastPendingVf;
    const stackBase = raycastPendingVf?.stackBaseVfId ? virtualFaces.find(f => f.id === raycastPendingVf.stackBaseVfId) : undefined;
    return placementDock({
      tag: 'PANEL', defaultName: 'Panel', ready,
      status: !selectedShape ? 'Select a body first' : ready ? `${stackBase ? `In front of ${stackBase.description || 'panel'} (on its inner face)` : 'Face selected'} — click again for the next region · right-click: place` : 'Click a body face in the 3D view',
      onConfirm: () => confirmBodyPanelPlacement(useAppStore.getState().raycastPendingVf),
      onExit: () => setRaycastMode(false), confirmTitle: 'Place panel',
    });
  })();

  const volumePickDock = (() => {
    if (!volumePickMode) return null;
    const n = volumePickCandidates.length;
    const ready = !!selectedShape && n > 0;
    const cur = volumePickCandidates[volumePickIndex];
    const relocGroup = volumePickGroupId ? panelGroups.find(g => g.id === volumePickGroupId) : undefined;
    const kindLabel = volumePickMode === 'shelf' ? 'Shelf' : 'Divider';
    const status = !selectedShape ? 'Select a body first'
      : n === 0 ? (relocGroup ? 'Click the new volume (only panels before this group bound it)' : 'Click inside a volume in the 3D view')
      : `Volume ${volumePickIndex + 1}/${n} · ${cur?.shape === 'box' ? 'Box' : 'Shaped'} — click: next · right-click: ${relocGroup ? 'relocate' : 'place'}`;
    return placementDock({
      tag: relocGroup ? `RELOCATE · ${groupName(relocGroup).toUpperCase()}` : kindLabel.toUpperCase(), defaultName: kindLabel, showName: !relocGroup, ready, status,
      onConfirm: () => { if (ready && selectedShape) confirmVolumePick(selectedShape.id, volumePickMode, volumePickCandidates[volumePickIndex]); },
      onExit: () => setVolumePickMode(null), confirmTitle: relocGroup ? 'Relocate group to this volume' : `Place ${kindLabel.toLowerCase()}`,
    });
  })();

  const doorPickDock = (() => {
    if (!doorPickMode) return null;
    const n = doorPickCandidates.length;
    const ready = !!selectedShape && n > 0;
    const cur = doorPickCandidates[doorPickIndex];
    const boundN = selectedShape ? virtualFaces.filter(f => f.shapeId === selectedShape.id && f.doorBound && !isDoorVf(f)).length : 0;
    const status = !selectedShape ? 'Select a body first'
      : n === 0 ? (boundN ? `Click a body face · ${boundN} door ref${boundN === 1 ? '' : 's'}` : 'No door refs — body edges bound the door · click a body face')
      : (() => { const r = doorPickPlacement === 'inner' ? cur.inner : cur.outer; return `Door ${doorPickIndex + 1}/${n} · ${Math.round(r.u1 - r.u0)}×${Math.round(r.v1 - r.v0)}${cur.rot ? ' · angled (follows reference)' : ''} — click: next · right-click: place`; })();
    return placementDock({
      tag: 'DOOR', defaultName: 'Door', ready, status,
      lead: <PlacementSelect value={doorPickPlacement} onChange={setDoorPickPlacement} />,
      onConfirm: () => { if (ready && selectedShape) confirmDoorPick(selectedShape.id, doorPickCandidates[doorPickIndex]); },
      onExit: () => setDoorPickMode(false), confirmTitle: 'Place door',
    });
  })();

  // ARKALIK şeridi (BackService): tıklama hangi yüzden gelse arka yüze taşınır; tip = Nailed / Grooved.
  const backPickDock = (() => {
    if (!backPickMode) return null;
    const n = backPickCandidates.length;
    const ready = !!selectedShape && n > 0;
    const cur = backPickCandidates[backPickIndex];
    const boundN = selectedShape ? virtualFaces.filter(f => f.shapeId === selectedShape.id && vfBackBound(f) && !isBackVf(f)).length : 0;
    const status = !selectedShape ? 'Select a body first'
      : n === 0 ? (boundN ? `Click the body (taken on its back face) · ${boundN} back ref${boundN === 1 ? '' : 's'}` : 'No back refs — body edges bound the back · click the body (taken on its back face)')
      : (() => { const r = backPickPlacement === 'inner' ? cur.inner : cur.outer; return `Back ${backPickIndex + 1}/${n} · ${Math.round(r.u1 - r.u0)}×${Math.round(r.v1 - r.v0)} — click: next · right-click: place`; })();
    return placementDock({
      tag: 'BACK', defaultName: 'Back', ready, status,
      lead: <BackTypeSelect value={backPickPlacement} onChange={setBackPickPlacement} />,
      onConfirm: () => { if (ready && selectedShape) confirmBackPick(selectedShape.id, backPickCandidates[backPickIndex]); },
      onExit: () => setBackPickMode(false), confirmTitle: 'Place back panel',
    });
  })();

  /* HIZLI GÖVDE: yapılandırma listenin üstünde, kaydırılan alanda (üst şerit yapışık); onay → servis, bitince mod kapanır. */
  const onQuickBodyApply = async () => {
    if (!selectedShape || quickBodyBusy) return;
    setQuickBodyBusy(true);
    try {
      const res = await applyQuickBody(selectedShape.id, useAppStore.getState().quickBodyConfig);
      if (res?.warnings.length) console.warn('[YAGO][HIZLI-GÖVDE] uyarılar:', res.warnings);
      useAppStore.getState().setQuickBodyMode(false);
    } catch (e) { console.error('[YAGO][HIZLI-GÖVDE] hata:', e); }
    finally { setQuickBodyBusy(false); }
  };
  const quickBodyPanel = quickBodyMode && selectedShape ? (
    <QuickBodyPanel shape={selectedShape} cfg={quickBodyConfig} setCfg={setQuickBodyConfig} busy={quickBodyBusy}
      existingCount={virtualFaces.filter(vf => vf.shapeId === selectedShape.id && !vf.interior).length}
      onApply={() => { void onQuickBodyApply(); }} onExit={() => setQuickBodyMode(false)} />
  ) : null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <style>{LIST_CSS}</style>
      {raycastDock}
      {volumePickDock}
      {doorPickDock}
      {backPickDock}
      {selectedShape ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {quickBodyPanel}
          <div className="px-0.5 pb-2 space-y-[2px]">{renderFaceList()}</div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center"><div className="text-center text-stone-400 text-xs py-4">No shape selected</div></div>
      )}
    </div>
  );
}
