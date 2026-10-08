import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, Box, Check, ChevronDown, ChevronRight, Columns3, Crosshair, DoorClosed, Equal, GripVertical, LayoutPanelTop, Lock, type LucideIcon, Minus, Move, Move3d,
  MoveVertical, Pencil, Plus, RotateCw, Rows3, Shapes, SlidersHorizontal, SplitSquareHorizontal, SplitSquareVertical, Trash2, Unlink, Unlock, X,
} from 'lucide-react';
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  type CavityBox, type DoorAlign, type DoorGroup, type DoorType, type PanelGroup, type Shape, type VirtualFace, childPanelsOf, panelOfVf, requestRebuild, shapeById, useAppStore, useStoreFields,
} from '../store';
import { ToolChip, ToolChipBar, UI_FONT } from './Ui';
import { confirmBodyPanelPlacement } from './SceneObjects';
import { axisDirToVec, convertReplicadToThreeGeometry, createPanelFromVirtualFace, dominantAxisLabel, genId, getFacesAndGroups, isFlatNormal, localBboxOf, round1 } from './Geometry';
import {
  confirmPanelMoveRef, confirmPanelRotateRef, confirmRefFaceExtrude, deleteExtrudeStep, deleteTransformStep, executeFaceExtrude, executePanelMove,
  executePanelMoveFixed, executePanelRotate, findExistingStepForFace, updateExtrudeStep, updateTransformStep,
} from './PanelOps';
import {
  type GroupLayoutSnap, boxSpan, confirmRefCavityExtrude, confirmVolumePick, deleteCavityStep, deletePanelGroupWithMembers, editGroupGap, equalizeGroupGaps, executeCavityExtrude,
  groupFacing, groupKindLabel, groupLayoutSnapshot, groupName, memberThicknessesOf, panelStarts, previewGroupGap, previewGroupMemberThickness, renamePanelGroup, restoreGroupLayout, setGroupCount, setGroupMemberThickness, setGroupTargetGap,
  startCavityEdit, startGroupRepick, toggleGroupGapLock, traceMaskLoops, updateCavityStep,
} from './PanelGroupService';
import {
  type DoorCut, type DoorEdgeKey, type DoorLayoutSnap, type DoorNearPanel, type DoorNodeSolved, DOOR_TYPES, DOOR_TYPE_LABEL, DOOR_TYPE_TITLE, addPanelAtDoorJoint, applyDoorCuts, clearDoorSpacing, collectDoorCuts, doorJointParts, doorJoints, doorLayoutSnapshot, doorLeafAxis, doorPlaneAxes, doorSpacingTargetsInScope, doorLeaves, doorMemberCount, doorNearPanels, restoreDoorLayout,
  confirmDoorPick, deleteDoorGroupWithMembers, doorGroupName, doorMemberRects, doorMembersOf, doorPlacementLabel, edgeGapsOf, editDoorLeafSize, editDoorSize, equalizeDoorGroup, findDoorNode, findSolvedNode,
  isDoorVf, renameDoorGroup, setDoorEdgeGap, setDoorGap, setDoorHalfOverlay, setDoorLeafGap, setDoorLeafTypes, setDoorNodeSpacing, setDoorJointRef, setDoorNodeSplit, setDoorPlacement, setDoorSplitGap, splitDoorAtPanel, setDoorThickness, setVfDoorBound,
  solveDoorTree, toggleDoorSizeLock,
} from './DoorService';

/* ═══════════════════════════════════════════════════════════════════════════
   PANEL EDİTÖRÜ — sol kenar çubuğundaki panel listesi (akordeon satırlar),
   panel önizlemesi, Taşı / Döndür / Extrude şeritleri, işlem adımları ve
   raf/dikme grup kartları. Tüm mantık motora (PanelOps / PanelEngine /
   PanelGroupService) delege edilir; burada yalnız arayüz durumu tutulur.
   ═══════════════════════════════════════════════════════════════════════════ */

const PANEL_THICKNESS = 18;
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const AXIS_COLORS: Record<string, string> = { 'x+': '#dc2626', 'x-': '#b91c1c', 'y+': '#16a34a', 'y-': '#15803d', 'z+': '#2563eb', 'z-': '#1d4ed8', x: '#dc2626', y: '#16a34a', z: '#2563eb' };
const SECTION_LABEL: React.CSSProperties = { fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#b5ada3' };

/** Geometrinin eksen-hizalı kutusu: küçükten büyüğe sıralı eksenler + boyut. */
function geoAxes(geo: THREE.BufferGeometry) {
  const bbox = localBboxOf(geo); if (!bbox) return null;
  const size = new THREE.Vector3(); bbox.getSize(size);
  const axes = [{ i: 0, v: size.x }, { i: 1, v: size.y }, { i: 2, v: size.z }].sort((a, b) => a.v - b.v);
  return { axes, size, bbox };
}

/** Şu anda paneli üretilmekte olan VF id'leri (otomatik panel üretimi yarış koruması). */
const _creatingPanelForVf = new Set<string>();

/* ── PANEL ÇERÇEVESİ: dönüşten arındırılmış geometri ─────────────────────
   KÖK NEDEN (Goker: "panel döndürüldüğünde preview görünümünü de döndürüyor…
   gereksiz 2 kere ölçü okları"): önizleme ve satır ölçüleri panelin GÖVDE-YEREL
   geometrisinden okunuyordu; dönmüş panelde eksen-hizalı kutu eğik olduğundan
   görünüm dönüyor, kutu ölçüleri (683/542) gerçek ölçü yerine geçiyor ve dönmüş
   üst yüzün kenarları "kesim" sanılıp aynı ölçü ikinci kez çiziliyordu. Burada
   panel KENDİ çerçevesine geri alınır: dönüş adımlarının birleşik dönüşü
   (PanelEngine.composeSteps ile aynı sıra — pivot gereksiz) tersine uygulanır;
   adımsız eğik levhada (eğik gövde yüzü) en büyük yüzün normali en yakın eksene
   çevrilir. Pahlı uçlar, çentikler kendi düzleminde olduğu gibi kalır. */
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
/** En büyük toplam alanlı yüz normali (işaret: ilk sıfırdan farklı bileşen pozitif). */
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
  // Adımsız eğim (eğik gövde yüzüne oturan levha): en büyük yüz normali en yakın eksene.
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
  // KALINLIK: panelThickness parametresinden alınır — geometrinin eksen-hizalı
  // bbox'ından DEĞİL. Dönmüş panelde bbox eğik olduğundan en küçük boyut bile
  // gerçek kalınlıktan (18) çok büyük çıkıyordu (ör. 145.9). Parametre her zaman
  // doğru kalınlığı tutar; yoksa (eski panel) bbox'a düşülür.
  const thickness = (panelThickness != null && panelThickness > 0) ? round1(panelThickness) : round1(s[r.axes[0].i]);
  return { primary: round1(s[target]), secondary: round1(s[secondary]), thickness };
}
/** Satır ölçüleri (W/H/T): panelin KENDİ çerçevesinden — dönmüş panelde de gerçek en/boy. */
const panelDims = (p: Shape | undefined | null) => {
  const geo = panelFrameGeometry(p);
  return geo ? getDimsFromGeo(geo, p!.parameters?.arrowRotated, parseFloat(p!.parameters?.panelThickness) || 18) : null;
};

type Pt = { x: number; y: number };
const project3D = (p: THREE.Vector3, camera: THREE.Camera, w: number, h: number): Pt => {
  const ndc = p.clone().project(camera);
  return { x: (ndc.x + 1) / 2 * w, y: (1 - ndc.y) / 2 * h };
};

/* ── Kesim (çıkarma) ölçü geometrisi ─────────────────────────────────────
   Her kesim iki ölçü verir (en + boy). Her biri kesim kenarının hemen
   dışına, en yakın panel kenarına doğru itilir; iki çizgi hiç kesişmez. */
interface GroundDimWorld { fa: THREE.Vector3; fb: THREE.Vector3; da: THREE.Vector3; db: THREE.Vector3; length: number; along?: number; }
/* GEREKSİZ KESİM ÖLÇÜSÜ ELEME (Goker: "bazen çok gereksiz 2 kere ölçü okları
   görüyorum"): panelin tam enini/boyunu kaplayan bir "kesim" (pahlı ucun üst
   yüz kenarı, dönmüş yüz kenarı, tam boy kanal) dış ölçünün kopyasıdır → dış
   ölçü zaten çizildiğinden atılır. Hem gömülü kesimler hem çıkarma araçları. */
const CUT_FULL_SPAN = 0.9;
function dropFullSpanCuts(dims: GroundDimWorld[], span0: number, span1: number, p0: number): GroundDimWorld[] {
  return dims.filter(d => d.length < CUT_FULL_SPAN * (d.along === p0 ? span0 : span1));
}
const KEYS = ['x', 'y', 'z'] as const;
/** Kalınlık ekseni dışındaki iki düzlem ekseni + anahtarları. */
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

/** Çıkarma araçlarından kesim ölçüleri (panelin üst yüzüne yerleşir). */
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
      if (frame) v.applyMatrix4(frame);   // panel çerçevesine (dönmüş panelde araç da birlikte döner)
      const c0 = v.getComponent(p0), c1 = v.getComponent(p1);
      mn0 = Math.min(mn0, c0); mx0 = Math.max(mx0, c0); mn1 = Math.min(mn1, c1); mx1 = Math.max(mx1, c1);
    }
    mn0 = Math.max(mn0, panelBbox.min[k0]); mx0 = Math.min(mx0, panelBbox.max[k0]);
    mn1 = Math.max(mn1, panelBbox.min[k1]); mx1 = Math.min(mx1, panelBbox.max[k1]);
    out.push(...dropFullSpanCuts(cutBoxToDims(mn0, mx0, mn1, mx1, topVal, p0, p1, thinAxis, panelBbox.min[k0], panelBbox.max[k0], panelBbox.min[k1], panelBbox.max[k1], gap), span0, span1, p0));
  });
  return out;
}

/** Mesh'e gömülü kesimler: üst yüzdeki iç kenarlardan kesim kutuları. */
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

  // Uç noktaları paylaşan kenarlar birleşik-bul ile kümelenir; her küme bir kesim.
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

/* ── Zemin ölçü çizgileri ──────────────────────────────────────────────────
   En (en ekseni boyunca) +yükseklik zemin kenarına (arka); derinlik
   (yükseklik ekseni boyunca) +en zemin kenarına (sağ) oturur. İkisi de panelin
   kendi çerçevesine bağlıdır → kamera dönerken titremez. Kalınlık ölçü değil,
   bilgi çipi olarak gösterilir. */
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

/* ── ORTAK ÖLÇÜ ÇİZİMİ (SVG) — önizleme ve raf şeması aynı dili konuşur ──
   ince uzatma çizgileri (isteğe bağlı), oklu ölçü çizgisi, beyaz yuvarlak
   pill, tabular sayı. */
const pillSize = (txt: string, fs: number) => ({ pw: Math.max(txt.length * fs * 0.6 + 10, 26), ph: fs + 6 });
/* ÖLÇÜ DİLİ (Goker: "daha şık ve minimal"): kıl-çizgi ölçü hattı, dolu üçgen
   yerine ince AÇIK ok ucu (teknik resim), kenarsız beyaz etiket. Önizleme ve
   raf/dikme şeması aynı bileşenleri kullanır → tek dil. */
const DIM_LINE = '#b8b0a4';
const DIM_EXT = '#ddd6ca';
function DimArrows({ a, b, asz, color }: { a: Pt; b: Pt; asz: number; color: string }) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, px = -uy, py = ux;
  const k = 0.42;   // ok kolu açıklığı
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
/* KİLİT ROZETİ (Goker, Eki 2026: "değer girdikten sonra kilitleme düğmesi daha net olmalı; kilit her zaman çıkmıyor, sanki gizli
   gibi"): ölçü / boşluk pill'inin ucundaki kilit HER ZAMAN görünür (eskiden yalnız hover'da ya da kilitliyken — hover olmayınca
   yok sanılıyordu). Üç durum: serbest (gri, açık kilit) · GİRİLMİŞ değer (kehribar çerçeve, koyu açık kilit — "kilitle?") ·
   KİLİTLİ (turuncu dolgu, kapalı kilit). Yarıçap LOCK_R; yerleşim payı LOCK_EXT (pill'in ucundan rozetin dışına). */
const LOCK_R = 9;
const LOCK_EXT = 12 + LOCK_R + 2;
function LockBadge({ cx, cy, locked, edited, onClick, title }: { cx: number; cy: number; locked: boolean; edited?: boolean; onClick: () => void; title?: string }) {
  const fill = locked ? '#ea580c' : edited ? '#fff7ed' : '#ffffff';
  const stroke = locked ? '#c2410c' : edited ? '#f59e0b' : '#d6cfc3';
  const ico = locked ? '#ffffff' : edited ? '#9a3412' : '#8c8378';
  const sz = 10;
  return (
    <g className="lockbtn" style={{ cursor: 'pointer' }} onClick={e => { e.stopPropagation(); onClick(); }}>
      <circle cx={cx} cy={cy} r={LOCK_R} fill={fill} stroke={stroke} strokeWidth={locked ? 1 : 0.9} style={{ filter: SOFT.pillShadow }} />
      {locked ? <Lock x={cx - sz / 2} y={cy - sz / 2} size={sz} strokeWidth={2.4} color={ico} /> : <Unlock x={cx - sz / 2} y={cy - sz / 2} size={sz} strokeWidth={2.1} color={ico} />}
      <title>{title ?? (locked ? 'Locked — stays fixed on resize. Click to unlock (follows resize)' : edited ? 'Entered value — click to lock it (stays fixed on resize)' : 'Click to lock (stays fixed on resize)')}</title>
    </g>
  );
}

/* ── DOCK / İÇ PANEL TASARIM DİLİ (soft, minimal — liste satırlarıyla aynı) ──
   Taşı / Döndür / Extrude şeritleri ve işlem adımları bu ortak tokenları
   kullanır: sıcak kemik zemin, kıl-çizgi kenar, düz yüzeyler, gradyan yok.
   Etkin segment KOYU TAŞ dolgudur (fildişi-üstüne-fildişi okunmuyordu —
   aktif mod net seçilsin kuralı korunur). */
/* SIRALAMA TUTAMACI İMLECİ (Goker: "sıra düğmesine tıklayınca fare beyaz
   oluyor, belli olmuyor"): tarayıcının grab/grabbing eli BEYAZ dolgulu ince
   çerçevelidir; kemik-beyaz satır zemininde kayboluyordu. Koyu taş dolgulu,
   beyaz dış hatlı 4 yönlü taşıma imleci her zeminde okunur. Yedek: 'move'. */
const GRIP_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
  "<path d='M12 1.8 L15.8 5.6 H13.3 V10.7 H18.4 V8.2 L22.2 12 L18.4 15.8 V13.3 H13.3 V18.4 H15.8 L12 22.2 L8.2 18.4 H10.7 V13.3 H5.6 V15.8 L1.8 12 L5.6 8.2 V10.7 H10.7 V5.6 H8.2 Z' " +
  "fill='#292524' stroke='#ffffff' stroke-width='1.4' stroke-linejoin='round'/></svg>"
)}") 12 12, move`;
/* ── ÖNİZLEME GÖRÜNÜMÜ (sade, profesyonel) ─────────────────────────────────
   Zemin: neredeyse beyaz, çok hafif sıcak dikey geçiş (desen/vinyet yok).
   Panel: açık huş/beyaz laminat tonu. three r155+ fiziksel ışık ölçeğinde eski
   düşük şiddetler paneli kirli griye çekiyordu; şiddetler yüzü açık, kalınlık
   kenarını bir ton koyu verecek şekilde yeniden ayarlandı. */
/* ── ÖNİZLEME YUMUŞAK DİLİ (Goker, Eki 2026: "kapak preview'a daha soft bir dokunuş; aynısını panel editörüne, dikme/raf
   atmaya ve panel yerleştirmeye de uygula") — panel önizlemesi, raf/dikme şeması ve kapak şeması TEK dil: üstten hafif ışık
   alan kemik zemin, kıl-çizgi çerçeve + iç parlama, parçalar yumuşak gradyan + kısık kenar + çok hafif gölge, pill'ler kıl
   çerçeveli. Tek kaynak: PREVIEW_BG / PREVIEW_FRAME / SOFT. */
const PREVIEW_BG = 'radial-gradient(130% 95% at 50% 0%, #fefdfb 0%, #f8f5f0 62%, #f3efe8 100%)';
const PREVIEW_FRAME = 'relative rounded-[12px] ring-1 ring-[#ebe5dc] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_1px_2px_rgba(60,40,20,0.04)]';
/* ŞEMA CSS (raf/dikme + kapak şeması ortak): kilit rozeti HER ZAMAN görünür (Goker: "kilit her zaman çıkmıyor, sanki gizli");
   yalnız hover'da hafifçe büyür. Bant rozetleri (chip) eskisi gibi hover'da / açıkken. */
const SCHEMATIC_CSS = `.yago-gap .lockbtn{transition:transform .12s;transform-box:fill-box;transform-origin:center}.yago-gap .lockbtn:hover{transform:scale(1.12)}.yago-band .chip{opacity:0;transition:opacity .15s}.yago-band.on .chip,.yago-band:hover .chip{opacity:1}.yago-band .hit{transition:fill .12s}.yago-band:hover .hit{fill:rgba(234,88,12,0.10)}`;
const SOFT = {
  area: '#fdfcfa', areaStroke: '#e4ded4',
  part0: '#f5f0e8', part1: '#eae3d7', partStroke: '#b8afa2',
  sel0: '#f8f0e6', sel1: '#f0e3d1', selStroke: '#dcae84',
  on0: '#fdeee1', on1: '#f9dcc4', onStroke: '#ea580c',
  label: '#a39b90', shadow: 'drop-shadow(0 1px 1.5px rgba(70,50,30,0.09))',
  pillStroke: '#ece6dc', pillShadow: 'drop-shadow(0 1px 1px rgba(60,40,20,0.06))',
};
/** Parça (panel / levha / kapak) gradyanları — her SVG kendi kimliğiyle bir kez tanımlar. */
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
const PREVIEW_HEIGHT = 500;   // kenar çubuğu 560px ile orantılı (önceki 475px / 410)
// ŞERİT ÖNİZLEMENİN ÜSTÜNE BİNMEZ (Goker: "mod düğmeleri panel görünümünün
// içine geçiyordu"): akış içinde ayrı bir karttır — araç segmentinin hemen
// altında, önizlemenin ÜSTÜNDE (Eki 2026: altındayken görünmüyordu).
const DOCK_SHELL: React.CSSProperties = {
  position: 'relative', marginTop: 5, borderRadius: 12, background: 'linear-gradient(180deg,#fefdfb 0%,#faf8f4 100%)', border: '1px solid #ebe5dc',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 2px rgba(60,40,20,0.04)', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: UI_FONT,
};
const DOCK_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 5px 5px' };
const DOCK_INPUT: React.CSSProperties = {
  flex: 1, minWidth: 0, height: 24, textAlign: 'center',
  fontFamily: "'SF Mono',ui-monospace,Menlo,monospace", fontSize: 12, fontWeight: 500, fontVariantNumeric: 'tabular-nums',
  color: '#1c1917', background: '#ffffff', border: '1px solid #e6e0d6', borderRadius: 7, outline: 'none', boxShadow: '0 1px 0 rgba(40,30,20,0.02)',
};
const dockAxisTag = (color: string): React.CSSProperties => ({
  flexShrink: 0, fontSize: 10, fontWeight: 700, fontFamily: UI_FONT, color, height: 20, lineHeight: '20px', padding: '0 6px', borderRadius: 5, background: '#f5f2ec',
});
/** Durum kutusu: nokta + metin (+ sağda isteğe bağlı içerik). */
function DockStatus({ ready = false, dot, text, title, trailing }: { ready?: boolean; dot?: string; text: string; title?: string; trailing?: React.ReactNode }) {
  return (
    <div title={title} style={{
      flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, height: 24, padding: '0 8px', borderRadius: 6,
      background: ready ? 'rgba(22,163,74,0.07)' : '#f5f2ec', border: ready ? '1px solid rgba(22,163,74,0.22)' : '1px solid transparent',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: dot ?? (ready ? '#16a34a' : '#a8a29e'), flexShrink: 0 }} />
      <span style={{ fontSize: 10.5, fontWeight: 500, color: ready ? '#15803d' : '#78716c', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
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
/** Adım listesi / kesme düğmesi: küçük şeffaf ikon düğmesi. */
const iconBtn = (color: string): React.CSSProperties => ({
  width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, border: 'none',
  background: 'transparent', cursor: 'pointer', color, outline: 'none', padding: 0, transition: 'background 0.12s',
});
/** Sayısal giriş: yerel metin taslağı (başta -/+ yazılabilsin) + store değeri.
 *  Geçerli sayı yazıldıkça store güncellenir; blur'da normalize edilir. */
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

/* ── SEGMENTLİ KONTROL (Goker, Eki 2026: "face extrude / rotate / move'a basınca dönüş tipi, ref modu gibi
   modlar çok aşağıda kalıyor, görünmüyor; daha göz önünde, daha profesyonel, düğmeler daha küçük olsun") ──
   Araçlar (Extrude / Move / Rotate) ve modlar (Fixed / Dyn / Ref) aynı dil: tek çerçeveli, eşit bölmeli,
   24px yüksekliğinde segment çubuğu; aktif bölme koyu taş dolgu (okunurluk kuralı), açıklama title'da.
   Şerit artık önizlemenin ÜSTÜNDE durur (renderExpandedBody) — mod seçimi hep göz önünde. */
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
              boxShadow: on ? '0 1px 2px rgba(40,30,20,0.25)' : 'none', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.01em', transition: 'background 0.12s,color 0.12s',
            }}>
            {Icon && <Icon size={11} strokeWidth={2.1} style={{ flexShrink: 0 }} />}
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
/* ── MOD ÇUBUĞU (Fixed / Dyn / Ref): segment çubuğu; alt açıklama (sub) title'a taşındı. */
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

/* ── "Yüzeyin şeklini al" — satır ikon düğmesi (Goker, Eki 2026: "aç/kapat var ama ne olduğu anlaşılmıyor,
   bir ikona bağlansın"): kapak sınırı düğmesiyle aynı ROW_BTN kutu; AÇIK = petrol (teal) dolgu + çerçeve.
   AÇIK: panel, yerleştiği serbest bölgenin tam şeklini alır (L/U/çentik). KAPALI (varsayılan): kardeş kenarında düz kesilir. */
function FitShapeToggle({ checked, disabled, onToggle }: { checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} onClick={e => { stop(e); if (!disabled) onToggle(); }}
      title={checked ? 'Fit to face shape: ON — the panel takes the full shape of its free region (L / U / notch). Click to cut straight at siblings.' : 'Fit to face shape: OFF — the panel is cut straight at the sibling edge. Click to follow the free region\'s full shape.'}
      className={`${ROW_BTN} ${disabled ? 'text-stone-200 cursor-not-allowed' : checked ? 'text-teal-700 bg-teal-50 ring-1 ring-teal-300/80' : 'text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700'}`}>
      <Shapes size={ROW_ICON} strokeWidth={checked ? 2.1 : 1.8} />
    </button>
  );
}

/* ── KAPAK SINIRI — satır düğmesi (Goker: "kapak sınırı işareti her satırda, panel yönü gibi") ─
   Panel yönü okuyla aynı ROW_BTN kutu; AÇIK = kehribar (3B'deki kehribar kenar ve satır rozetiyle aynı dil). */
function DoorRefToggle({ checked, disabled, onToggle }: { checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} onClick={e => { stop(e); if (!disabled) onToggle(); }}
      title={checked ? 'Door reference: ON — doors are built from this panel\'s edges' : 'Mark as door reference'}
      className={`${ROW_BTN} ${disabled ? 'text-stone-200 cursor-not-allowed' : checked ? 'text-amber-700 bg-amber-50 ring-1 ring-amber-300/80' : 'text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700'}`}>
      <DoorClosed size={ROW_ICON} strokeWidth={checked ? 2.1 : 1.8} />
    </button>
  );
}

/* ── PAYLAŞILAN ÖNİZLEME RENDERER'I — TEK WebGL BAĞLAMI ──────────────────
   KÖK NEDEN ("çok panel seçtim, referans küp ve paneller kayboldu"):
   PanelPreview2D her mount'ta yeni bir WebGL bağlamı açıyordu ve her panel
   seçiminde yeniden mount oluyordu. Tarayıcı ~16 aktif WebGL bağlamına izin
   verir; sınır aşılınca EN ESKİ bağlamı (ana sahnenin Canvas'ı) öldürür.
   ÇÖZÜM: tüm önizlemeler TEK, modül düzeyinde, ekran-dışı bir renderer'ı
   paylaşır; görüntü görünür canvas'a 2D `drawImage` ile kopyalanır. */
let _sharedPreviewRenderer: THREE.WebGLRenderer | null = null;
function getSharedPreviewRenderer(): THREE.WebGLRenderer | null {
  const cur = _sharedPreviewRenderer;
  if (cur && !cur.getContext().isContextLost()) return cur;
  if (cur) { try { cur.dispose(); } catch { /* yok say */ } _sharedPreviewRenderer = null; }
  try {
    const r = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setClearColor(0x000000, 0);
    _sharedPreviewRenderer = r;
    console.log('[YAGO][ÖNİZLEME] paylaşılan önizleme renderer oluşturuldu (tek WebGL bağlamı)');
    return r;
  } catch (e) {
    console.error('[YAGO][ÖNİZLEME] önizleme renderer oluşturulamadı:', e);
    return null;
  }
}
/** Kalın çizgi seti (LineSegments2) — panel kenarları ve kesim dış hatları. */
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
/** Çıkarma aracının gövdeye göre yerleşimi (dönme + kayma). */
const subXform = (sg: any) => {
  const rot = sg.relativeRotation || [0, 0, 0];
  return { rotM: new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ')), off: new THREE.Vector3(...((sg.relativeOffset || [0, 0, 0]) as number[])) };
};

/* ── Panel önizlemesi — sabit dimetrik görünüm, sağ/sol yörünge, zemin ölçüleri ── */
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
    // Bu bileşen KENDİ WebGL bağlamını AÇMAZ (bkz. getSharedPreviewRenderer).
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
    // PANELİN KENDİ ÇERÇEVESİ: dönüş adımları / eğim geri alınır — görünüm ve ölçüler
    // her zaman levhanın düz halidir (pah/çentik kendi düzleminde kalır).
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
    // KLON: paylaşılan renderer, çizdiği geometrinin GPU tamponlarını kendi
    // bağlamında tutar. Klon çizimden sonra dispose edilir → önizleme
    // bağlamında kalıcı tampon kalmaz; ana sahnenin geometrisine dokunulmaz.
    const previewGeo = frameGeo.clone();
    disposables.push(material, previewGeo);
    scene.add(new THREE.Mesh(previewGeo, material));
    scene.add(fatLines(frameGeo, PREVIEW_EDGE_COLOR, 0.9, w, h, disposables));

    const bbox = new THREE.Box3().setFromObject(scene);
    const sz = new THREE.Vector3(), center = new THREE.Vector3();
    bbox.getSize(sz); bbox.getCenter(center);
    const dims3 = [sz.x, sz.y, sz.z];
    const minIdx = dims3.indexOf(Math.min(...dims3)); // kalınlık ekseni

    // Sabit çerçeve: en/yükseklik düzlem EKSENLERİNE bağlıdır (küçük indeks =
    // en), getDimsFromGeo ile aynı — extrude hangi kenarı büyütürse büyütsün
    // önizleme kendiliğinden dönmez. Yön yalnız ok düğmesiyle değişir.
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

    // Fiziksel ışık ölçeği (r155+): yüz açık laminat, kalınlık kenarı bir ton koyu.
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
    if (!unrotated) console.log('[YAGO][ÖNİZLEME] panel kendi çerçevesinde çizildi', shape.id, 'boyut=', [sz.x, sz.y, sz.z].map(v => v.toFixed(0)).join('x'), 'ölçüN=', allDimsW.length);

    // Kamera sığdırma: kutu köşeleri + tüm ölçü uçları görünür alana sığar.
    const allW: THREE.Vector3[] = [];
    for (const X of [bbox.min.x, bbox.max.x]) for (const Y of [bbox.min.y, bbox.max.y]) for (const Z of [bbox.min.z, bbox.max.z]) allW.push(new THREE.Vector3(X, Y, Z));
    allDimsW.forEach(d => allW.push(d.fa, d.fb, d.da, d.db));
    let maxU = 0, maxV = 0;
    allW.forEach(p => { const d = p.clone().sub(center); maxU = Math.max(maxU, Math.abs(d.dot(right))); maxV = Math.max(maxV, Math.abs(d.dot(upW))); });
    const halfV = maxV * 1.06;
    // Şerit önizlemenin altında (üstüne binmez) → alt pay yalnız ölçü etiketleri için.
    const ratioTop = halfV, ratioBot = halfV + halfV * 0.06;
    let vSpan = ratioTop + ratioBot, halfH = (vSpan / 2) * aspect;
    const needH = maxU * 1.06;
    if (halfH < needH) { vSpan *= needH / halfH; halfH = needH; }
    camera.left = -halfH; camera.right = halfH;
    camera.top = vSpan * ratioTop / (ratioTop + ratioBot); camera.bottom = -vSpan * ratioBot / (ratioTop + ratioBot);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    // Kesim dış hatları (amber) — açık çıkarma araçlarından.
    subGeos.forEach((sg: any) => {
      if (!sg?.geometry) return;
      const { rotM, off } = subXform(sg);
      const sgLines = fatLines(sg.geometry, 0xd97706, 1.2, w, h, disposables);
      sgLines.matrix.copy(rotM); sgLines.matrix.setPosition(off);
      if (!unrotated) sgLines.matrix.premultiply(frameM);   // araç da panel çerçevesine
      sgLines.matrixAutoUpdate = false;
      scene.add(sgLines);
    });

    renderer.render(scene, camera);
    // Ekran-dışı paylaşılan renderer'ın görüntüsünü görünür canvas'a kopyala
    // (2D bağlam — WebGL bağlam sınırına sayılmaz).
    const ctx2d = canvas.getContext('2d');
    if (ctx2d) { ctx2d.clearRect(0, 0, canvas.width, canvas.height); ctx2d.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height); }
    renderer.renderLists.dispose();

    // ── Ölçüleri izdüşür (dış + kesim aynı stil) ve çakışmaları çöz ──
    const fsG = Math.max(10, Math.min(12.5, w * 0.025));
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
  const fsG = Math.max(10, Math.min(12.5, canvasSize.w * 0.025));
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

/* ── RAF / DİKME ŞEMASI (temsili görünüm) ─────────────────────────────────
   Seçilen hacmin görünüşü: levhalar taş renkli çubuk, her boşluk ortasında
   ölçü pill'i. Pill'e tıkla → değer girişi (Enter/blur onaylar); pill'in
   kilit ucu → kilit aç/kapa. Kilitli pill turuncu çerçeve. Şema, panel
   önizlemesiyle aynı yükseklikte (410) sabit bir kare alana sığdırılır.
   ÜYE KALINLIĞI (Goker): her levhanın ucunda kalınlık kutucuğu; tıkla → YALNIZ
   değer girişi (seçim yok). Üye seçimi (altta panel önizlemesi) yalnız LEVHAYA
   tıklayınca. Levhanın öbür ucunda liste numarası (6.1, 6.2 …). Kalınlık
   değişince boşluklar Σkalınlığa göre yeniden eşitlenir (girilen korunur). */
const SCHEMA_PAD = 34;
/** Bölge kutularının (h,v) eksenlerine izdüşüm maskesi: düzlemler + dolu hücre sorgusu. */
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
export function GroupSchematic({ group, selectedIndex, memberLabels, doorRefs, splitBacks, onEditGap, onToggleLock, onEditThickness, onSelectMember, onToggleDoorRef, onToggleSplitBack, onEditBegin, onEditCancel }: {
  group: PanelGroup; selectedIndex: number;
  /** Şema sırasındaki (geometrik) üye i'nin liste numarası — "6.1" gibi. */
  memberLabels: string[];
  /** Şema sırasındaki üye i kapak sınırı mı (VF.doorBound) / arkalığı böl mü (VF.splitBack) — levhanın üstündeki rozetler. */
  doorRefs: boolean[]; splitBacks: boolean[];
  /** preview=true → CANLI ÖNİZLEME (her tuş basışı: yalnız store dağılımı, rebuild yok); preview yok → onay (gerçek yazım + rebuild). */
  onEditGap: (k: number, v: number, preview?: boolean) => void; onToggleLock: (k: number) => void;
  onEditThickness: (i: number, v: number, preview?: boolean) => void; onSelectMember: (i: number) => void;
  onToggleDoorRef: (i: number) => void; onToggleSplitBack: (i: number) => void;
  /** Düzenleme başında kayıt (Esc ile geri yükleme için) / Esc → kayıt geri yüklenir. */
  onEditBegin?: () => unknown; onEditCancel?: (snap: unknown) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  const [editing, setEditing] = useState<SchemaEdit | null>(null);
  // CANLI ÖNİZLEME (Goker, Eki 2026: "kutucuğa değeri yazar yazmaz kalan ölçüyü diğer taraflara dağıt"): düzenleme başında
  // kayıt alınır; her tuşta geçerli değer önizleme olarak yazılır; Esc kaydı geri yükler ve onayı (blur) iptal eder.
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
  const gsid = `gs-${group.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const ts = memberThicknessesOf(group);
  const barsHorizontal = axis === 1;
  // ÜYE MODU KALDIRILDI (Goker, Eki 2026: "bir panele tıklayınca arayüz başka bir hale geçiyor, iptal et"):
  // eskiden üye seçiliyken şema 230px'lik bir seçiciye küçülüp pill'leri gizliyordu; artık üye seçiliyken de
  // şema tam boy — boşluk ölçüleri, kilitler, kalınlık kutucukları ve rozetler yerinde kalır.
  const memberMode = false;
  const height = PREVIEW_HEIGHT;
  // YÖN (tık yönü): boşluk/üye sayımı facing>0 ise hacmin MİN, facing<0 ise MAX tarafından başlar.
  const facing = groupFacing(group);
  const stackOrigin = facing > 0 ? cavity.min[axis] : cavity.max[axis];
  const starts = panelStarts(cavity, axis, facing, gaps, ts);

  // ŞEKİLLİ BÖLGE SİLUETİ: bölge kutularının izdüşümü (eski gruplarda hacim
  // kutusu). Dizilim ekseni rafta düşey (Y), dikmede yatay (okun ekseni: X ya da Z) kalır; diğer
  // eksen için iki görünüşten ŞEKLİ GÖSTEREN seçilir — ikisi de dikdörtgense
  // ön görünüş. Levhalar ve pill'ler maskeye kırpılır.
  const region = group.region && group.region.length ? group.region : [cavity];
  const view = useMemo(() => {
    // Dikey levhalar: yatay eksen = dizilim ekseni (X dikmesi → ön görünüş / üst görünüş; Z dikmesi → yan görünüş / üst görünüş).
    const views: Array<[number, number]> = barsHorizontal ? [[0, 1], [2, 1]] : [[axis, 1], [axis, axis === 0 ? 2 : 0]];
    const cands = views.map(([h, v]) => { const m = regionMask(region, h, v); const loops = traceMaskLoops(m.hs, m.vs, m.filled); return { h, v, m, loops, shaped: loops.length > 1 || loops.some(l => l.length > 4) }; });
    return cands[0].shaped || !cands[1].shaped ? cands[0] : cands[1];
  }, [region, barsHorizontal]);
  const { h: hAxis, v: vAxis, m: mask, loops } = view;
  // TEMSİLİ KARE ÇİZİM (Goker): hacim ne olursa olsun şema HER ZAMAN aynı
  // ölçüde, eni boyu eşit bir kare alanda çizilir — ölçekli değil, TEMSİLİ.
  // Çapraz eksen kareye doğrusal yayılır; dizilim ekseninde levhalar sabit
  // piksel kalınlıkta, boşluklar kendi ORANLARIYLA bölüşülür. Dünya → piksel
  // dönüşümü parça-doğrusal olduğundan L/U siluet de aynı haritayla çizilir.
  const innerW = width - 2 * SCHEMA_PAD, innerH = height - 2 * SCHEMA_PAD;
  const S = Math.max(40, Math.min(innerW, innerH));
  const ox = SCHEMA_PAD + (innerW - S) / 2, oy = SCHEMA_PAD + (innerH - S) / 2;
  const crossAxisW = barsHorizontal ? hAxis : vAxis;
  const nBars = starts.length;
  const barPx = Math.max(3, Math.min(7, S / Math.max(1, (nBars + 1) * 4)));
  // Levha piksel kalınlığı TEMSİLİ: en incesi barPx, kalınlar oranla (en çok 3×) — 18'e karşı 100 görünsün.
  const tMin = ts.length ? Math.max(1, Math.min(...ts)) : 1;
  const barPxOf = (i: number) => Math.min(barPx * 3, barPx * ((ts[i] ?? tMin) / tMin));
  const barPxSum = starts.reduce((a, _, i) => a + barPxOf(i), 0);
  // Dizilim ekseni kırılma noktaları: dünya [başlangıç, +g0, +g0+t0, …, son] ↔ piksel.
  // Sayım tıklanan taraftan (stackOrigin) yürür; facing<0 ise dizi dünya artan sıraya çevrilir.
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
    return Math.min(S, pb[pb.length - 1]); // hacim sonu → karenin kenarı
  };
  const crossSpan = Math.max(boxSpan(cavity, crossAxisW), 1);
  const mapCross = (w: number) => ((w - cavity.min[crossAxisW]) / crossSpan) * S;
  const sx = (wh: number) => ox + (hAxis === axis ? mapStack(wh) : mapCross(wh));
  const sy = (wv: number) => oy + S - (vAxis === axis ? mapStack(wv) : mapCross(wv));   // dünya v yukarı → SVG y aşağı
  const silhouettePath = loops.map(l => l.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ') + ' Z').join(' ');
  /** Dizilim eksenindeki [a0,a1] diliminde, çapraz eksende dolu aralıklar (dünya). */
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

  // Boşluk aralıkları (dizilim ekseni, dünya) → ölçü pill'leri.
  const fs = Math.max(10, Math.min(13.5, width * 0.027));
  const crossAxis = barsHorizontal ? hAxis : vAxis;
  let cursor = stackOrigin;
  const pills = gaps.map((g, k) => {
    const a = cursor, b = cursor + facing * g.value; cursor = b + facing * (ts[k] ?? 0);
    const mid = (a + b) / 2;
    const txt = String(round1(g.value));
    const { pw, ph } = pillSize(txt, fs);
    // Pill, boşluğun ortasındaki DOLU aralığın ortasına oturur (L bölgede boş kısma düşmesin).
    const runs = runsAt(mid - 0.5, mid + 0.5);
    const widest = runs.length ? runs.reduce((bst, r) => (r[1] - r[0] > bst[1] - bst[0] ? r : bst)) : null;
    const crossMid = widest ? (widest[0] + widest[1]) / 2 : (cavity.min[crossAxis] + cavity.max[crossAxis]) / 2;
    let cx = barsHorizontal ? sx(crossMid) : sx(mid);
    let cy = barsHorizontal ? sy(mid) : sy(crossMid);
    // Dar boşlukta pill'ler çakışmasın: iki sıraya dağıt.
    const gapPx = Math.abs(mapStack(b) - mapStack(a));
    if (!barsHorizontal && gapPx < pw + 6) cy += (k % 2 === 0 ? -1 : 1) * (ph * 0.75);
    if (barsHorizontal && gapPx < ph + 6) cx += (k % 2 === 0 ? -1 : 1) * (pw * 0.6);
    return { k, cx, cy, pw, ph, txt, a, b, crossMid };
  });
  const asz = Math.max(4, Math.min(6.5, width * 0.014));
  // KALINLIK KUTUCUKLARI: levhanın ucunda, kare alanın dışındaki kenar boşluğunda (raf → sağ, dikme → üst).
  const fsT = Math.max(9, fs * 0.86);
  const tPills = starts.map((st, i) => {
    const txt = String(round1(ts[i]));
    const { pw, ph } = pillSize(txt, fsT);
    const mid = st + ts[i] / 2;
    // Kenar boşluğu dar kalırsa kutucuk şema alanının içinde (kırpılmadan) tutulur.
    const cx = barsHorizontal ? Math.min(ox + S + 6 + pw / 2, width - pw / 2 - 2) : sx(mid);
    const cy = barsHorizontal ? sy(mid) : Math.max(oy - 6 - ph / 2, ph / 2 + 2);
    return { i, cx, cy, pw, ph, txt };
  });
  // NUMARA ETİKETLERİ: kalınlık kutucuğunun KARŞI ucunda (raf → sol, dikme → alt); salt-okunur.
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
  // LEVHA = SEÇİM: ince levhayı yakalamak kolay olsun diye çevresinde görünmez ±5 px tıklama alanı.
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
  /* ── LEVHA ROZETLERİ (Goker, Eki 2026: "dikme/raf şemasında işaret panel kalınlığının ÜSTÜNDE olsun —
     kalınlık kutucuğunun yanında adet artınca görünmez oluyor; başka seçenekler de gelecek: arkalığı böl"):
     her levhanın bir ucunda, levhanın üstüne oturan küçük yuvarlak rozetler — kapak sınırı (kehribar) ve
     arkalığı böl (petrol). Rozetler levhanın UZUNLUĞU boyunca dizildiğinden üye sayısı artsa da birbirine girmez. */
  const BADGE_R = 8, BADGE_STEP = 20;
  const badge = (key: string, cx: number, cy: number, on: boolean, Icon: LucideIcon, onColor: string, onFill: string, tip: string, onClick: () => void) => (
    <g key={key} style={{ cursor: 'pointer' }} onClick={e => { stop(e); onClick(); }}>
      <circle cx={cx} cy={cy} r={BADGE_R} fill={on ? onFill : '#ffffff'} stroke={on ? onColor : '#d6cfc4'} strokeWidth={on ? 1.1 : 0.8} />
      <Icon x={cx - 4.5} y={cy - 4.5} size={9} strokeWidth={on ? 2.4 : 2} color={on ? onColor : '#a8a29e'} />
      <title>{tip}</title>
    </g>
  );
  const barBadges = (i: number, x0: number, y0: number, x1: number, y1: number) => {
    const lbl = memberLabels[i] ?? String(i + 1);
    // Raf: sağ uçtan içeri doğru; dikme: üst uçtan aşağı doğru (levha ekseni boyunca dizilim).
    const at = (k: number): [number, number] => barsHorizontal
      ? [x1 - BADGE_R - 4 - k * BADGE_STEP, (y0 + y1) / 2]
      : [(x0 + x1) / 2, y0 + BADGE_R + 4 + k * BADGE_STEP];
    const [dx, dy] = at(0), [bx, by] = at(1);
    return (
      <g key={`badges-${i}`}>
        {badge(`door-${i}`, dx, dy, !!doorRefs[i], DoorClosed, '#b45309', '#fffbeb',
          doorRefs[i] ? `Panel ${lbl}: door reference ON — click to remove` : `Panel ${lbl}: mark as door reference`, () => onToggleDoorRef(i))}
        {badge(`back-${i}`, bx, by, !!splitBacks[i], SplitSquareHorizontal, '#0e7490', '#ecfeff',
          splitBacks[i] ? `Panel ${lbl}: split back ON — click to remove` : `Panel ${lbl}: split the back panel here`, () => onToggleSplitBack(i))}
      </g>
    );
  };

  return (
    <div ref={wrapRef} className={PREVIEW_FRAME} style={{ background: PREVIEW_BG, height }}>
      <style>{SCHEMATIC_CSS}</style>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', fontFamily: UI_FONT }}>
        <SoftDefs id={gsid} />
        {/* şekilli bölge silueti */}
        <path d={silhouettePath} fill={SOFT.area} stroke={SOFT.areaStroke} strokeWidth={1} strokeLinejoin="round" fillRule="evenodd" />
        {/* SAYIM İMİ: boşluk 0 / üye 1'in sayıldığı taraftan içeri bakan küçük ok (dizilim ekseninde; 3B ok ise tıklanan yüzü gösterir) — kırmızı, 3B okla aynı */}
        {(() => {
          const len = 18, m = 9;
          const horiz = hAxis === axis;
          const x0 = horiz ? (facing > 0 ? ox + m : ox + S - m) : ox + m;
          const y0 = horiz ? oy + m : (facing > 0 ? oy + S - m : oy + m);
          const x1 = horiz ? x0 + facing * len : x0;
          const y1 = horiz ? y0 : y0 - facing * len;   // dünya + yukarı → SVG y aşağı
          // Chevron (3B okla aynı biçim): düz köklü gövde + ucu 45° iki kollu açık V.
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
        {/* levhalar: dilimdeki dolu aralıklara kırpılmış */}
        {starts.map((st, i) => runsAt(st, st + ts[i]).map((r, ri) => barsHorizontal
          ? bar(`bar-${i}-${ri}`, i, sx(r[0]), sy(st + ts[i]), sx(r[1]), sy(st))
          : bar(`bar-${i}-${ri}`, i, sx(st), sy(r[1]), sx(st + ts[i]), sy(r[0]))))}
        {/* levha rozetleri: kapak sınırı · arkalığı böl — levhanın en uzun parçasının ucunda, levhanın üstünde */}
        {!memberMode && starts.map((st, i) => {
          const runs = runsAt(st, st + ts[i]);
          if (!runs.length) return null;
          const r = runs.reduce((b, x) => (x[1] - x[0] > b[1] - b[0] ? x : b));
          return barsHorizontal
            ? barBadges(i, sx(r[0]), sy(st + ts[i]), sx(r[1]), sy(st))
            : barBadges(i, sx(st), sy(r[1]), sx(st + ts[i]), sy(r[0]));
        })}
        {/* üye kalınlık kutucukları: tıkla → YALNIZ değer girişi (seçim levhadan) */}
        {!memberMode && tPills.map(p => {
          const on = p.i === selectedIndex;
          return (
            <DimPill key={`t-${p.i}`} cx={p.cx} cy={p.cy} txt={p.txt} fs={fsT} fill={on ? '#fff7ed' : '#f5f2ec'} stroke={on ? '#f97316' : SOFT.pillStroke} strokeWidth={on ? 1 : 0.7}
              color={on ? '#c2410c' : '#57534e'} hideText={editing?.kind === 't' && editing.i === p.i} title={`Panel ${memberLabels[p.i] ?? p.i + 1} thickness — click to edit`}
              onClick={e => { stop(e); beginEdit({ kind: 't', i: p.i, v: p.txt }); }} />
          );
        })}
        {/* üye numaraları (liste ile aynı: 6.1, 6.2 …) — salt-okunur */}
        {nLabels.map(n => {
          const on = n.i === selectedIndex;
          return (
            <text key={`n-${n.i}`} x={n.cx} y={n.cy + fsT * 0.36} textAnchor="middle" fontSize={fsT} fontWeight={on ? 700 : 600} fill={on ? '#ea580c' : SOFT.label}
              fontFamily={UI_FONT} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', userSelect: 'none' }}>{n.txt}</text>
          );
        })}
        {/* boşluk ölçüleri: oklu ölçü çizgisi + pill + kilit (her zaman görünür; girilmiş değer kehribar, kilitli turuncu) */}
        {!memberMode && pills.map(p => {
          const locked = gaps[p.k].locked, edited = !locked && !!gaps[p.k].edited;
          const a = barsHorizontal ? { x: sx(p.crossMid), y: sy(p.a) } : { x: sx(p.a), y: sy(p.crossMid) };
          const b = barsHorizontal ? { x: sx(p.crossMid), y: sy(p.b) } : { x: sx(p.b), y: sy(p.crossMid) };
          const lockCx = p.cx + p.pw / 2 + 12 + LOCK_R, lockCy = p.cy;
          return (
            <g key={`gap-${p.k}`} className={`yago-gap${locked ? ' locked' : ''}`}>
              <DimArrows a={a} b={b} asz={asz} color={locked ? '#f59e0b' : DIM_LINE} />
              <DimPill cx={p.cx} cy={p.cy} txt={p.txt} fs={fs} fill={locked || edited ? '#fff7ed' : '#ffffff'} stroke={locked ? '#f97316' : edited ? '#fbbf24' : SOFT.pillStroke} strokeWidth={locked || edited ? 1 : 0.7}
                color={locked ? '#c2410c' : edited ? '#9a3412' : '#44403c'} hideText={editing?.kind === 'gap' && editing.k === p.k} title={edited ? 'Entered gap — click to edit' : 'Edit gap'} onClick={e => { stop(e); beginEdit({ kind: 'gap', k: p.k, v: p.txt }); }} />
              <LockBadge cx={lockCx} cy={lockCy} locked={locked} edited={edited} onClick={() => onToggleLock(p.k)}
                title={locked ? 'Locked gap — stays fixed on resize. Click to unlock' : edited ? 'Entered gap — click to lock it (stays fixed on resize)' : 'Lock gap (stays fixed on resize)'} />
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


/* ── KAPAK ŞEMASI (Goker, Eki 2026) ───────────────────────────────────────
   Kapak düzleminin ÖN GÖRÜNÜŞÜ temsili bir karede (mm → px doğrusal, eksenler kareye ayrı ölçeklenir). Kapaklar taş
   renkli dikdörtgen; tık = yalnız TİP/BÖLME hedefi seçimi (üye editörü AÇILMAZ — Goker). ÖLÇÜLER YALNIZ TIKLANAN YERDE
   (Goker, Eki 2026: "en dışında ölçü yazmasın, o alanı kazanmak istiyorum; kapağa tıkladığımda kapağın üzerinde ölçüler
   belirsin"): dış ölçü zinciri yok, kutu kapak alanını doldurur. Seçili bölgenin ölçü zinciri bölgenin ÜZERİNDE çizilir —
   bölmenin kendi ekseni (çocuk ölçüleri + aralar, uçlarda kenar boşlukları) alt kenara yakın yatay / sağ kenara yakın düşey,
   çapraz ölçüsü (üst bölmedeki yeri: önceki ara · ölçü · sonraki ara) öbür yönde; seçili kapakta genişlik ve yükseklik
   zincirleri, double/fold'da kanat zinciri. Aynı yöndeki ikinci zincir 16 px içeri. Her pill tıkla → değer gir; ölçü
   pill'inin ucundaki kilit → kilitle. Boşluklar kapak alanında turuncu şeritle de işaretlenir. ÖLÇÜ OKU YOK (Goker: "ölçü
   okları kapak boşluklarının içine giriyor") — yalnız pill'ler. Kapaklar 1,5 px içeri çizilir ki 3 mm boşluklar görünür
   kalsın. Sınır levhaları (yan / üst / alt / dikme / raf) yalnız DIŞ kapakta ve kapağa boşluk + 3 mm içinde değiyorsa,
   GERÇEK konum ve kalınlıkla (en az 6 px) çizilir — iç kapakta ya da sınır paneli yoksa hiç çizilmez (Goker). Çakışan
   pill'ler ikinci şeride kayar (PILL_LANE_GAP). */
const DOOR_INSET_PX = 1.5;        // kapak çiziminin kenarlardan içeri payı (boşluklar görünsün)
const CHAIN_OFF_H = 27;           // YATAY ölçü zincirinin bölgenin alt kenarından uzaklığı (px) — alt bant ve ortadaki rozetle çakışmasın
const CHAIN_OFF_V = 38;           // DÜŞEY ölçü zincirinin bölgenin sağ kenarından uzaklığı (px) — pill'ler yatay geniş, sağ bant rozetini aşsın
const CHAIN_STEP = 16;            // aynı yöndeki zincirler arası (px)
// ŞEMA PAYLARI (Goker, Eki 2026: "kenarlardan minimum boşluk kalacak şekilde alanı maksimum oranda kullan; en dışında ölçü
// yazmasın"): dört kenar da dar pay (kenar levhası / rozet taşması için). Kapak alanı kutuyu DOLDURUR (eksenler ayrı ölçeklenir);
// kutunun yüksekliği kapağın gerçek oranına yaklaşır (geniş-alçak kapakta kart kısalır), en çok PREVIEW_HEIGHT.
const DOOR_PAD_L = 12, DOOR_PAD_T = 12, DOOR_PAD_R = 12, DOOR_PAD_B = 12;
const DOOR_MIN_ASPECT = 0.6;      // kutu yüksekliği / genişliği en az bu oran (çok geniş kapakta ölçüler sıkışmasın)
const PILL_LANE_GAP = 3;          // iç içe geçen ölçü pill'leri ikinci şeride kayarken aradaki pay (px)

/* ── KAPAK AÇILIŞ İŞARETİ (Goker, Eki 2026: "her kapak tipine mobilya sektörüne uygun kapak açılış simgesi") ──
   Mobilya/mutfak görünüş çizimi standardı: kapağın karşı (kulp) kenarının iki köşesinden menteşe kenarının ORTASINA
   kesikli çizgiler — üçgenin SİVRİ UCU menteşe tarafını gösterir (DIN / AWI görünüş sözleşmesi). Kalkar kapakta uç
   üstte, düşer kapakta altta; iki kanatlıda sol kanat sol, sağ kanat sağ menteşe; katlanır kalkarda her iki kanadın
   ucu üstte (alt kanat üst kanada katlanır). Şemadaki kapaklar ve tip çubuğundaki ikonlar aynı çizimi kullanır. */
type Hinge = 'L' | 'R' | 'T' | 'B';
const swingPath = (x0: number, y0: number, x1: number, y1: number, h: Hinge) => {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, f = (n: number) => n.toFixed(1);
  if (h === 'L') return `M${f(x1)},${f(y0)} L${f(x0)},${f(cy)} L${f(x1)},${f(y1)}`;
  if (h === 'R') return `M${f(x0)},${f(y0)} L${f(x1)},${f(cy)} L${f(x0)},${f(y1)}`;
  if (h === 'T') return `M${f(x0)},${f(y1)} L${f(cx)},${f(y0)} L${f(x1)},${f(y1)}`;
  return `M${f(x0)},${f(y0)} L${f(cx)},${f(y1)} L${f(x1)},${f(y0)}`;
};
/** Tipin kanat menteşeleri — kanat sırası: double sol→sağ (bakan kişiye göre), fold üst→alt. */
const leafHinges = (t: DoorType): Hinge[] => (t === 'left' ? ['L'] : t === 'right' ? ['R'] : t === 'up' ? ['T'] : t === 'down' ? ['B'] : t === 'double' ? ['L', 'R'] : t === 'fold' ? ['T', 'T'] : []);
/**
 * Tip ikonu (20×16 kutu, size = yükseklik): kapak dış hattı + açılış işareti. Menteşesizlerde işaret yok:
 * Drawer = üstte ince çekmece kutusu çizgisi + ortada kısa tutamak; Fixed = dört köşede vida noktası (sabit panel).
 */
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
/**
 * KAPAK TİPİ ÇUBUĞU (Goker: "kapak tiplerini birden fazla kapağı seçip bir kapak tipi verebileyim"; "çekmece ve
 * menteşesiz de olsun, bir sıraya sığsın"): sekiz tip TEK sırada — ikon üstte, kısa etiket altta (dar sütuna sığar).
 * Etkin = hedef kapakların ortak tipi (karışıksa hiçbiri). Sağda hedef açıklaması.
 */
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
                boxShadow: on ? '0 1px 2px rgba(40,30,20,0.25)' : 'none', fontSize: 9.5, fontWeight: 600, letterSpacing: '0.01em', lineHeight: 1, transition: 'background 0.12s,color 0.12s',
              }}>
              <DoorTypeIcon type={t} size={13} />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{DOOR_TYPE_LABEL[t]}</span>
            </button>
          );
        })}
      </div>
      <div className="shrink-0 flex flex-col items-end justify-center" style={{ minWidth: 46 }}>
        <span className="text-[8.5px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]">Type</span>
        <span className="text-[10px] font-medium text-stone-500 tabular-nums">{hint}</span>
      </div>
    </div>
  );
}

type DoorEdit = { key: string; v: string };
/** Ölçü zinciri öğesi: ölçü (ok + pill + kilit) ya da boşluk (yalnız pill). a..b = eksen boyunca mm. */
type ChainItem = { key: string; kind: 'size' | 'gap'; a: number; b: number; txt: string; title: string; locked?: boolean; edited?: boolean; onLock?: () => void; commit: (v: number) => void; preview?: (v: number) => void; min: number };
type Chain = { horiz: boolean; pos: number; items: ChainItem[]; small?: boolean };
export function DoorSchematic({ group, selectedIndex, selectedNodes, memberLabels, cuts, nearPanels, refPick, onEditSize, onToggleLock, onEditSplitGap, onEditEdgeGap, onEditLeaf, onEditLeafGap, onPathClick, onToggleHalfOverlay, onAlignJoint, onRefPick, addPick, onAddPick, onRemovePick, addObstacles, onEditBegin, onEditCancel }: {
  group: DoorGroup; selectedIndex: number; memberLabels: string[];
  /** BÖLGE SEÇİMİ: seçili düğümler (kök alan / bölme / kapak) — turuncu çerçeve + seviye etiketi (ör. "L1 · V ×2"). */
  selectedNodes: string[];
  /** AÇILI REFERANS: dönmüş sınır panelleri — üyeler bunlarla kırpılmış çokgen olarak çizilir (3B ile aynı şekil). */
  cuts: DoorCut[];
  /** ŞEMADAKİ SINIR LEVHALARI (dış kapak; iç kapakta boş): gerçek konum/kalınlık; kenar levhasında yarım binme, iç levhada derz hizalaması. */
  nearPanels: DoorNearPanel[];
  /** preview=true → CANLI ÖNİZLEME (her tuş basışı: yalnız ağaç/boşluk dağılımı store'a, rebuild yok); yoksa onay (gerçek yazım + rebuild). */
  onEditSize: (splitId: string, k: number, v: number, preview?: boolean) => void; onToggleLock: (splitId: string, k: number) => void;
  onEditSplitGap: (splitId: string, k: number, v: number, preview?: boolean) => void; onEditEdgeGap: (edge: DoorEdgeKey, v: number, preview?: boolean) => void;
  onEditLeaf: (leafId: string, k: number, v: number, preview?: boolean) => void; onEditLeafGap: (leafId: string, v: number, preview?: boolean) => void;
  /** Düzenleme başında kayıt (Esc ile geri yükleme için) / Esc → kayıt geri yüklenir. */
  onEditBegin?: () => unknown; onEditCancel?: (snap: unknown) => void;
  /** Kapak tıklandı: tıklanan noktanın kök → yaprak düğüm yolu (yalnız seçim — üye seçilmez); additive = Shift/Ctrl/⌘. */
  onPathClick: (path: string[], additive: boolean) => void;
  onToggleHalfOverlay: (edge: DoorEdgeKey, on: boolean) => void;
  /**
   * DERZ BAĞI: iç levha (vfId) `splitId` bölmesinin k. derzine `align` ile bağlanır — LEVHA bir kez taşınır (kapak yerinde),
   * sonrasında kapak derzi levhayı izler. null = bağ çözülür (kapak ölçüleri donar).
   */
  onAlignJoint: (splitId: string, k: number, vfId: string, align: DoorAlign | null) => void;
  /** PANEL REF modu: iç levhaya tık → kapak o levhanın ortasından bölünür, derz levhaya bağlanır. */
  refPick?: boolean;
  onRefPick?: (vfId: string) => void;
  /**
   * ARAYA RAF / DİKME modu (Goker: "düğmeye basınca 2 kapak arası belirginleşsin"): 'u' = V derzleri (dikme), 'v' = H derzleri
   * (raf) vurgulanır ve tıklanır → onAddPick(splitId, k). Zaten bağlı derzler gösterilmez.
   */
  addPick?: 'u' | 'v' | null;
  /** ats = derz boyunca seçilen yer(ler) (çapraz koordinat, mm): tık → tıklanan parça; Shift/Ctrl+tık → derzin BOŞ parçalarının hepsi (her bölmeye ayrı raf). */
  onAddPick?: (splitId: string, k: number, ats: number[]) => void;
  /** Aynı modda, kapak arayüzünden eklenmiş (derzi izleyen) levhanın bandı "✕ Remove" olur → grup silinir (Goker: "sonradan silebileyim"). */
  onRemovePick?: (groupId: string) => void;
  /**
   * DERZ PARÇALAMA kaynağı (araya raf/dikme modu): derzi kesen / derze değen levhalar — kapak sınırı İŞARETSİZ ince düz
   * levhalar dahil (doorNearPanels allPanels), çünkü işaretsiz bir dikme de ışının yolunu keser. Verilmezse `nearPanels`.
   */
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
  // Giriş kutusu ağaç değişince KAPANMAZ (canlı önizleme ağacı her tuşta yazar); yalnız grup / seçim değişince kapanır.
  const treeKey = JSON.stringify(group.tree);
  const selKey = selectedNodes.join('|');
  useEffect(() => { setEditing(null); }, [group.id, selectedIndex >= 0, selKey]);
  // CANLI ÖNİZLEME (Goker, Eki 2026: "kutucuğa değeri yazar yazmaz kalan ölçüyü diğer taraflara dağıt"): düzenleme başında kayıt
  // alınır; her tuşta geçerli değer önizleme olarak yazılır (dağılım şemada anında); Esc kaydı geri yükler ve onayı iptal eder.
  const snapRef = useRef<unknown>(undefined);
  const cancelledRef = useRef(false);
  const beginEdit = (e: DoorEdit) => { snapRef.current = onEditBegin?.(); cancelledRef.current = false; setEditing(e); };
  const cancelEdit = () => { cancelledRef.current = true; onEditCancel?.(snapRef.current); setEditing(null); };

  const { rect, axis, side } = group;
  // KUTU: genişlik tamamen kullanılır; yükseklik kapağın gerçek oranından (en az DOOR_MIN_ASPECT·genişlik, en çok PREVIEW_HEIGHT'a sığan).
  const SW = Math.max(40, width - DOOR_PAD_L - DOOR_PAD_R);
  const duR = Math.max(1e-6, rect.u1 - rect.u0), dvR = Math.max(1e-6, rect.v1 - rect.v0);
  const SH = Math.round(Math.max(DOOR_MIN_ASPECT * SW, Math.min(PREVIEW_HEIGHT - DOOR_PAD_T - DOOR_PAD_B, SW * dvR / duR)));
  const height = SH + DOOR_PAD_T + DOOR_PAD_B;
  const ox = DOOR_PAD_L, oy = DOOR_PAD_T;
  // GÖRÜNÜŞ YÖNÜ: ön yüz (Z+) → X sağa; arka (Z−) ve sağ yan (X+) → aynalı; üst (Y+) → Z aşağı.
  const mirrorU = (axis === 2 && side < 0) || (axis === 0 && side > 0);
  const mirrorV = axis === 1 && side > 0;
  const eg = edgeGapsOf(group);
  // AĞAÇ ÇÖZÜMÜ (kayıtlı dikdörtgenle) + AÇILI REFERANS kesimi (3B ile aynı çokgen).
  const cutsKey = cuts.map(c => `${c.vfId}:${c.n.map(x => x.toFixed(3)).join(',')}:${c.dMin.toFixed(1)}:${c.dMax.toFixed(1)}`).join('|');
  const solved = useMemo(() => solveDoorTree(group), // eslint-disable-next-line react-hooks/exhaustive-deps
    [rect, treeKey, group.gap, eg.uMin, eg.uMax, eg.vMin, eg.vMax]);
  const members = useMemo(() => applyDoorCuts(group, rect, doorMemberRects(solved), cuts, true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [solved, cutsKey, group.placement, group.thickness, group.gap]);
  // mm → px: doğrusal; u soldan sağa (aynalıysa ters), v ÜSTTEN aşağı (v1 → oy).
  const sx = (u: number) => (mirrorU ? ox + SW - ((u - rect.u0) / duR) * SW : ox + ((u - rect.u0) / duR) * SW);
  const sy = (v: number) => (mirrorV ? oy + ((v - rect.v0) / dvR) * SH : oy + ((rect.v1 - v) / dvR) * SH);
  const fs = Math.max(10, Math.min(13.5, width * 0.027));
  const fsT = Math.max(9, fs * 0.86);
  const gid = `ds-${group.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;


  // ── SINIR LEVHALARI (Goker, Eki 2026: "iç kapakta ya da sınır panel yoksa kalınlığı hiç gösterme; dikme/rafa 2-3 mm
  // yaklaşan kapakta göster; dikmeyi kapağın sağına/soluna/ortalı, rafı yukarı/aşağı/ortada yerleştireyim") ──
  // nearPanels (DoorService.doorNearPanels) gerçek (u,v) konum + kalınlıkla gelir; burada yalnız ekrana çevrilir. Çok ince
  // levha en az BAND_MIN px çizilir (merkez sabit). Kapak arkasında kalan kısım kesikli (gizli çizgi). Kenar levhası →
  // Full/Half rozeti (yarım binme); derze yakın iç raf/dikme üyesi → Free / Left/Center/Right (Up/Center/Down) rozeti: tık
  // derzi levhaya BAĞLAR ve levhayı o hizaya taşır (kapak yerinde; sonra kapak derzi levhayı izler), Shift/Ctrl+tık bağı çözer.
  const I = DOOR_INSET_PX;
  const BAND_MIN = 6;
  // Şemada levha çizim sınırı: kapak alanı dışına taşan kısım kenar payına kadar görünür.
  const clampX = (x: number) => Math.max(ox - DOOR_PAD_L + 2, Math.min(ox + SW + DOOR_PAD_R - 2, x));
  const clampY = (y: number) => Math.max(oy - DOOR_PAD_T + 2, Math.min(oy + SH + DOOR_PAD_B - 2, y));
  const isOuter = group.placement === 'outer';
  type Band = { np: DoorNearPanel; x: number; y: number; w: number; h: number; vertical: boolean; half: boolean; aligned: boolean };
  const bands: Band[] = nearPanels.map(np => {
    const vertical = np.kind === 'u';
    let a0 = vertical ? Math.min(sx(np.a0), sx(np.a1)) : Math.min(sy(np.a0), sy(np.a1)), a1 = vertical ? Math.max(sx(np.a0), sx(np.a1)) : Math.max(sy(np.a0), sy(np.a1));
    if (a1 - a0 < BAND_MIN) { const c = (a0 + a1) / 2; a0 = c - BAND_MIN / 2; a1 = c + BAND_MIN / 2; }
    const c0 = vertical ? clampY(Math.min(sy(np.c0), sy(np.c1))) : clampX(Math.min(sx(np.c0), sx(np.c1)));
    const c1 = vertical ? clampY(Math.max(sy(np.c0), sy(np.c1))) : clampX(Math.max(sx(np.c0), sx(np.c1)));
    const half = !!np.edge && np.behind && !!group.halfOverlay?.[np.edge];
    return { np, vertical, half, aligned: !!np.ref && !!np.joint, x: vertical ? a0 : c0, y: vertical ? c0 : a0, w: vertical ? a1 - a0 : c1 - c0, h: vertical ? c1 - c0 : a1 - a0 };
  });
  // Kapak arkasında kalan kısımlar (gizli çizgi): levha ∩ her kapak dikdörtgeni.
  const hiddenParts = (b: Band) => members.flatMap(m => {
    const dx0 = Math.min(sx(m.u0), sx(m.u1)) + I, dx1 = Math.max(sx(m.u0), sx(m.u1)) - I, dy0 = Math.min(sy(m.v1), sy(m.v0)) + I, dy1 = Math.max(sy(m.v1), sy(m.v0)) - I;
    const x0 = Math.max(b.x, dx0), x1 = Math.min(b.x + b.w, dx1), y0 = Math.max(b.y, dy0), y1 = Math.min(b.y + b.h, dy1);
    return x1 - x0 > 0.5 && y1 - y0 > 0.5 ? [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }] : [];
  });
  // Hizalama etiketleri EKRANA göre (aynalı görünüşte min/max yer değiştirir).
  const alignLabel = (b: Band, a: DoorAlign) => (a === 'center' ? 'Center' : b.vertical ? ((a === 'min') !== mirrorU ? 'Left' : 'Right') : ((a === 'max') !== mirrorV ? 'Up' : 'Down'));
  const alignCycle = (b: Band): DoorAlign[] => (b.vertical ? (mirrorU ? ['max', 'center', 'min'] : ['min', 'center', 'max']) : (mirrorV ? ['min', 'center', 'max'] : ['max', 'center', 'min']));
  const edgeName = (b: Band) => (b.vertical ? ((b.np.edge === 'uMin') !== mirrorU ? 'Left' : 'Right') : ((b.np.edge === 'vMax') !== mirrorV ? 'Top' : 'Bottom'));
  const bandTip = (b: Band) => {
    const np = b.np;
    if (np.edge) {
      if (!np.behind) return `${edgeName(b)} — ${np.name}: stands in front of the door plane; the door ends beside it (no overlay possible).`;
      const on = !!group.halfOverlay?.[np.edge];
      return `${edgeName(b)} — ${np.name}: ${on ? 'HALF overlay — the door covers half of this panel\'s thickness (the other half is left for the neighbouring door). Click for full overlay.' : 'FULL overlay — the door covers this panel\'s whole thickness. Click for half overlay (share the panel with the neighbouring door).'}`;
    }
    const what = b.vertical ? 'divider' : 'shelf';
    const opts = alignCycle(b).map(a => alignLabel(b, a)).join(' / ');
    if (removable(np)) return `${np.name} (${what}) — added between the doors. Click ✕ Remove to delete it (its row and panel are removed; the doors stay).`;
    if (refPick) return `${np.name} (${what}) — PANEL REF: click to split the door through this ${what}'s middle. The joint is then bound to the ${what}: when it moves, the doors follow; Left / Center / Right moves the ${what} under the joint.`;
    if (!np.joint) return `${np.name} (${what}) — behind the door, no door joint nearby to bind to. Use Panel ref mode to split the door at it.`;
    if (!np.groupId && !np.ref) return `${np.name} (${what}) — body panel at a door joint; it cannot be moved from here (only shelf / divider members can).`;
    const cur = np.ref ? alignLabel(b, np.ref.align) : 'Free';
    if (np.ref?.master === 'door') return `${np.name} (${what}) — added between the doors, FOLLOWS the door joint (${cur}): when the doors change, the ${what} moves with the joint. Click: ${opts} (moves the ${what}, doors stay) · Shift/Ctrl+click: unbind (the ${what} stays where it is).`;
    if (np.ref) return `${np.name} (${what}) — BOUND to this door joint (${cur}): when the ${what} moves (gap edit, body resize) the doors follow it. Click: ${opts} (moves the ${what}, doors stay) · Shift/Ctrl+click: unbind (door sizes freeze).`;
    return `${np.name} (${what}) at the door joint — Free. Click: ${opts} (binds the joint to the ${what} and moves the ${what}; doors stay, then follow it) · Shift/Ctrl+click: unbind.`;
  };
  const removable = (np: DoorNearPanel) => !!addPick && !np.edge && np.kind === addPick && np.ref?.master === 'door' && !!np.groupId;
  const onBandClick = (b: Band, additive: boolean) => {
    const np = b.np;
    if (removable(np)) { onRemovePick?.(np.groupId!); return; }
    if (refPick) { if (!np.edge && onRefPick) onRefPick(np.vfId); return; }
    if (np.edge) { if (np.behind) onToggleHalfOverlay(np.edge, !group.halfOverlay?.[np.edge]); return; }
    const cyc = alignCycle(b);
    const j = np.joint;
    if (!j || !(np.groupId || np.ref)) return;
    if (additive) { if (np.ref) onAlignJoint(j.splitId, j.k, np.vfId, null); return; }
    const i = np.ref ? cyc.indexOf(np.ref.align) : -1;
    onAlignJoint(j.splitId, j.k, np.vfId, cyc[(i + 1) % cyc.length]);
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
  // Düğüm yolu (kök → yaprak) ve seçili düğümlerin ekran kutuları (çözülmüş alanlarından).
  const pathToLeaf = (leafId: string): string[] => {
    const out: string[] = [];
    const dfs = (n: DoorNodeSolved): boolean => { out.push(n.id); if (n.id === leafId) return true; if (n.kind === 'split') for (const c of n.children) if (dfs(c)) return true; out.pop(); return false; };
    dfs(solved);
    return out;
  };
  const nodeBox = (n: DoorNodeSolved) => ({ x0: Math.min(sx(n.u0), sx(n.u1)), x1: Math.max(sx(n.u0), sx(n.u1)), y0: Math.min(sy(n.v1), sy(n.v0)), y1: Math.max(sy(n.v1), sy(n.v0)) });
  const selRegions = selectedNodes.map(id => findSolvedNode(solved, id)).filter((n): n is DoorNodeSolved => !!n);
  const leafIdsUnder = (n: DoorNodeSolved): string[] => (n.kind === 'leaf' ? [n.id] : n.children.flatMap(leafIdsUnder));
  const selLeafIds = new Set(selRegions.flatMap(leafIdsUnder));
  // ── ODAK ÖLÇÜ ZİNCİRLERİ + BOŞLUK ŞERİTLERİ (Goker, Eki 2026: "en dışında ölçü yazmasın; kapağa tıkladığımda kapağın
  // üzerinde ölçüler belirsin; oradaki kapak boşluklarını daha net anlaşılır yap") ──
  // Ölçüler YALNIZ seçili bölgeler için, bölgenin üzerinde: bölme → kendi zinciri (çocuk ölçüleri + aralar, uçlarda kenar
  // boşlukları) + çapraz ölçüsü (üst bölmedeki yeri); kapak → genişlik ve yükseklik zincirleri (önceki ara · ölçü · sonraki ara;
  // uçta kenar boşluğu); double/fold → kanat zinciri. Boşluklar kapak alanında turuncu şerit.
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
  const strip = (axis: 'u' | 'v', a: number, b: number, c0: number, c1: number) => {
    // axis = boşluğun İNCE olduğu eksen: u → düşey şerit [a,b]×[c0,c1](v); v → yatay şerit [c0,c1](u)×[a,b](v). En az 3 px.
    const MINW = 3;
    let x0 = axis === 'u' ? Math.min(sx(a), sx(b)) : Math.min(sx(c0), sx(c1)), x1 = axis === 'u' ? Math.max(sx(a), sx(b)) : Math.max(sx(c0), sx(c1));
    let y0 = axis === 'u' ? Math.min(sy(c0), sy(c1)) : Math.min(sy(a), sy(b)), y1 = axis === 'u' ? Math.max(sy(c0), sy(c1)) : Math.max(sy(a), sy(b));
    if (axis === 'u' && x1 - x0 < MINW) { const c = (x0 + x1) / 2; x0 = c - MINW / 2; x1 = c + MINW / 2; }
    if (axis === 'v' && y1 - y0 < MINW) { const c = (y0 + y1) / 2; y0 = c - MINW / 2; y1 = c + MINW / 2; }
    focusStrips.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  };
  const T0 = 0.05;
  // Bölgenin kapak alanı kenarına dayanan yanları (o kenar boşluğu zincirin ucunda + şerit).
  const touch = { u0: (n: DoorNodeSolved) => Math.abs(n.u0 - (rect.u0 + eg.uMin)) < T0, u1: (n: DoorNodeSolved) => Math.abs(n.u1 - (rect.u1 - eg.uMax)) < T0,
    v1: (n: DoorNodeSolved) => Math.abs(n.v1 - (rect.v1 - eg.vMax)) < T0, v0: (n: DoorNodeSolved) => Math.abs(n.v0 - (rect.v0 + eg.vMin)) < T0 };
  const edgeKeyName = (k: DoorEdgeKey) => (k === 'uMin' ? (mirrorU ? 'Right' : 'Left') : k === 'uMax' ? (mirrorU ? 'Left' : 'Right') : k === 'vMax' ? (mirrorV ? 'Bottom' : 'Top') : (mirrorV ? 'Top' : 'Bottom'));
  const edgeItem = (k: DoorEdgeKey, a: number, b: number): ChainItem => ({ key: `edge-${k}`, kind: 'gap', a, b, txt: fmt(eg[k]), title: `${edgeKeyName(k)} edge gap — click to edit`, commit: v => onEditEdgeGap(k, v), preview: v => onEditEdgeGap(k, v, true), min: 0 });
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
  // Bölmenin kendi zinciri: [kenar] ölçü · ara · ölçü … [kenar]; araları şeritle.
  const splitItems = (n: SplitS, withStrips: boolean): ChainItem[] => {
    const horiz = n.axis === 'u', dir = horiz ? 1 : -1;
    const items: ChainItem[] = [];
    let p = horiz ? n.u0 : n.v1;
    if (horiz ? touch.u0(n) : touch.v1(n)) { const k: DoorEdgeKey = horiz ? 'uMin' : 'vMax'; items.push(edgeItem(k, p - dir * eg[k], p)); if (withStrips) edgeStrip(n, k); }
    n.children.forEach((_c, i) => {
      const w = n.sizes[i]?.value ?? 0;
      items.push({ key: `size-${n.id}-${i}`, kind: 'size', a: p, b: p + dir * w, txt: fmt(w), title: horiz ? 'Door width — click to edit (siblings take the rest)' : 'Door height — click to edit (siblings take the rest)',
        locked: !!n.sizes[i]?.locked, edited: !!n.sizes[i]?.edited, onLock: () => onToggleLock(n.id, i), commit: v => onEditSize(n.id, i, v), preview: v => onEditSize(n.id, i, v, true), min: 1 });
      p += dir * w;
      if (i < n.children.length - 1) {
        const g = n.gaps[i] ?? 0;
        items.push({ key: `sgap-${n.id}-${i}`, kind: 'gap', a: p, b: p + dir * g, txt: fmt(g), title: 'Gap between doors — click to edit', commit: v => onEditSplitGap(n.id, i, v), preview: v => onEditSplitGap(n.id, i, v, true), min: 0 });
        if (withStrips) strip(n.axis, p, p + dir * g, horiz ? n.v0 : n.u0, horiz ? n.v1 : n.u1);
        p += dir * g;
      }
    });
    if (horiz ? touch.u1(n) : touch.v0(n)) { const k: DoorEdgeKey = horiz ? 'uMax' : 'vMin'; items.push(edgeItem(k, p, p + dir * eg[k])); if (withStrips) edgeStrip(n, k); }
    return items;
  };
  // Düğümün üst bölmedeki yeri: [önceki ara / kenar] ölçü [sonraki ara / kenar] (P.axis boyunca); şeritler `on` bölgesinin çapraz aralığında.
  const placeItems = (n: DoorNodeSolved, P: SplitS, on: DoorNodeSolved): ChainItem[] => {
    const horiz = P.axis === 'u', dir = horiz ? 1 : -1;
    const idx = P.children.findIndex(c => c.id === n.id);
    if (idx < 0) return [];
    const items: ChainItem[] = [];
    const start = horiz ? n.u0 : n.v1;
    const c0 = horiz ? on.v0 : on.u0, c1 = horiz ? on.v1 : on.u1;
    if (idx > 0) { const g = P.gaps[idx - 1] ?? 0; items.push({ key: `sgap-${P.id}-${idx - 1}`, kind: 'gap', a: start - dir * g, b: start, txt: fmt(g), title: 'Gap between doors — click to edit', commit: v => onEditSplitGap(P.id, idx - 1, v), preview: v => onEditSplitGap(P.id, idx - 1, v, true), min: 0 }); strip(P.axis, start - dir * g, start, c0, c1); }
    else if (horiz ? touch.u0(n) : touch.v1(n)) { const k: DoorEdgeKey = horiz ? 'uMin' : 'vMax'; items.push(edgeItem(k, start - dir * eg[k], start)); edgeStrip(on, k); }
    const w = P.sizes[idx]?.value ?? 0;
    items.push({ key: `size-${P.id}-${idx}`, kind: 'size', a: start, b: start + dir * w, txt: fmt(w), title: horiz ? 'Door width — click to edit (siblings take the rest)' : 'Door height — click to edit (siblings take the rest)',
      locked: !!P.sizes[idx]?.locked, edited: !!P.sizes[idx]?.edited, onLock: () => onToggleLock(P.id, idx), commit: v => onEditSize(P.id, idx, v), preview: v => onEditSize(P.id, idx, v, true), min: 1 });
    const end = start + dir * w;
    if (idx < P.children.length - 1) { const g = P.gaps[idx] ?? 0; items.push({ key: `sgap-${P.id}-${idx}`, kind: 'gap', a: end, b: end + dir * g, txt: fmt(g), title: 'Gap between doors — click to edit', commit: v => onEditSplitGap(P.id, idx, v), preview: v => onEditSplitGap(P.id, idx, v, true), min: 0 }); strip(P.axis, end, end + dir * g, c0, c1); }
    else if (horiz ? touch.u1(n) : touch.v0(n)) { const k: DoorEdgeKey = horiz ? 'uMax' : 'vMin'; items.push(edgeItem(k, end, end + dir * eg[k])); edgeStrip(on, k); }
    return items;
  };
  // Kök boyutu (bir eksende): [kenar] tam ölçü [kenar] — düzenlenemez (kapak alanı sınırlardan gelir).
  const fullItems = (ax: 'u' | 'v', on: DoorNodeSolved): ChainItem[] => {
    const horiz = ax === 'u', dir = horiz ? 1 : -1;
    const lo = horiz ? rect.u0 : rect.v1, k0: DoorEdgeKey = horiz ? 'uMin' : 'vMax', k1: DoorEdgeKey = horiz ? 'uMax' : 'vMin';
    const span = (horiz ? rect.u1 - rect.u0 : rect.v1 - rect.v0) - eg[k0] - eg[k1];
    edgeStrip(on, k0); edgeStrip(on, k1);
    return [edgeItem(k0, lo, lo + dir * eg[k0]),
      { key: `full-${ax}`, kind: 'size', a: lo + dir * eg[k0], b: lo + dir * (eg[k0] + span), txt: fmt(span), title: horiz ? 'Door width (whole area)' : 'Door height (whole area)', commit: () => {}, min: 1 },
      edgeItem(k1, lo + dir * (eg[k0] + span), lo + dir * (eg[k0] + span + eg[k1]))];
  };
  // Çapraz ölçü: `n`in, kendisiyle AYNI eksenli olmayan en yakın üst bölmedeki yeri; yoksa kök boyutu.
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
    // double / fold: kanat zinciri (kanat ölçüleri + kanat arası) — yaprağın ekseninde, bir kademe içeride
    const lax = doorLeafAxis(n.type);
    if (lax && n.leafSplit?.leaves.length === 2) {
      const horiz = lax === 'u', dir = horiz ? 1 : -1;
      const [a, b] = n.leafSplit.leaves.map(l => Math.max(0, l.value)), g = n.leafSplit.gap;
      const p0 = horiz ? n.u0 : n.v1;
      strip(lax, p0 + dir * a, p0 + dir * (a + g), horiz ? n.v0 : n.u0, horiz ? n.v1 : n.u1);
      pushChain(n, horiz, [
        { key: `leaf-${n.id}-0`, kind: 'size', a: p0, b: p0 + dir * a, txt: fmt(a), title: 'Leaf size — click to edit (the other leaf takes the rest)', commit: v => onEditLeaf(n.id, 0, v), preview: v => onEditLeaf(n.id, 0, v, true), min: 1 },
        { key: `lgap-${n.id}`, kind: 'gap', a: p0 + dir * a, b: p0 + dir * (a + g), txt: fmt(g), title: 'Gap between the two leaves — click to edit', commit: v => onEditLeafGap(n.id, v), preview: v => onEditLeafGap(n.id, v, true), min: 0 },
        { key: `leaf-${n.id}-1`, kind: 'size', a: p0 + dir * (a + g), b: p0 + dir * (a + g + b), txt: fmt(b), title: 'Leaf size — click to edit (the other leaf takes the rest)', commit: v => onEditLeaf(n.id, 1, v), preview: v => onEditLeaf(n.id, 1, v, true), min: 1 },
      ]);
    }
  }
  // BÖLGE ETİKETİ KALDIRILDI (Goker, Eki 2026: "L0 L1 L2 gibi şeylere gerek yok, gözü karıştırıyor; kapağın içinde ölçüsü zaten
  // yazıyor"): seçili bölge yalnız çerçeveyle gösterilir; bölme sayısı V/H kutularında, spacing hedefi Spacing kutusunda okunur.

  // Pill konumları (giriş kutusu için): ekran koordinatı + boyut. Tüm pill'ler büyük yazı (fs) — yalnız seçili bölgede görünürler.
  type Pill = { key: string; cx: number; cy: number; pw: number; ph: number; f: number; item: ChainItem; chain: Chain; x0: number; x1: number; hidden: boolean; lane: number };
  // İÇ İÇE GEÇME ÖNLEMİ (Goker: "kapak miktarı arttığında ölçüler iç içe geçiyor"): zincir başına ŞERİTLER (teknik çizimdeki
  // kademeli ölçü). Önce ÖLÇÜ pill'leri yerleşir: bir öncekine çarpan ölçü ikinci şeride kayar (dönüşümlü). Sonra BOŞLUK pill'leri
  // boş bulduğu ilk şeride (0 → 1 → 2) girer; hiçbirine sığmazsa son şeride (odakta hiçbir boşluk gizlenmez). Şerit yönü bölgenin
  // içine doğru (yatay zincir yukarı, düşey zincir sola).
  type Placed = { start: number; end: number };
  const pills: Pill[] = chains.flatMap(ch => {
    const base = ch.items.map(it => {
      const f = fs;
      const { pw, ph } = pillSize(it.txt, f);
      const m0 = ch.horiz ? sx(it.a) : sy(it.a), m1 = ch.horiz ? sx(it.b) : sy(it.b);
      const mid = (m0 + m1) / 2;
      return { key: it.key, cx: ch.horiz ? mid : ch.pos, cy: ch.horiz ? ch.pos : mid, pw, ph, f, item: it, chain: ch, x0: Math.min(m0, m1), x1: Math.max(m0, m1), hidden: false, lane: 0 };
    }).sort((a, b) => (ch.horiz ? a.cx - b.cx : a.cy - b.cy));
    const maxLanes = 3;
    const lanes: Placed[][] = Array.from({ length: maxLanes }, () => []);
    const posOf = (p: typeof base[number]) => (ch.horiz ? p.cx : p.cy);
    // Pill'in şerit üzerindeki kapladığı aralık: pill + (kilitli ölçüde) ucundaki kilit rozeti (yatay zincirde sağında, düşeyde altında).
    const spanOf = (p: typeof base[number]): Placed => {
      const half = (ch.horiz ? p.pw : p.ph) / 2 + 1;
      return { start: posOf(p) - half, end: posOf(p) + half + (p.item.onLock ? LOCK_EXT : 0) };
    };
    const fits = (lane: number, start: number, end: number) => lanes[lane].every(q => end <= q.start || start >= q.end);
    const laneStep = Math.max(...base.map(p => (ch.horiz ? p.ph : p.pw)), 0) + PILL_LANE_GAP;
    const place = (p: typeof base[number], lane: number) => {
      p.lane = lane; lanes[lane].push(spanOf(p));
      if (lane > 0) { if (ch.horiz) p.cy -= lane * laneStep; else p.cx -= lane * laneStep; }
    };
    for (const p of base.filter(x => x.item.kind === 'size')) {
      const { start: st0, end: en0 } = spanOf(p);
      place(p, fits(0, st0, en0) ? 0 : fits(1, st0, en0) ? 1 : 0);   // ikisine de sığmazsa 0. şerit (ölçü hep çizilir)
    }
    for (const p of base.filter(x => x.item.kind === 'gap')) {
      const { start: st0, end: en0 } = spanOf(p);
      let lane = maxLanes - 1;
      for (let l = 0; l < maxLanes; l++) if (fits(l, st0, en0)) { lane = l; break; }
      place(p, lane);
    }
    return base;
  });
  const pillByKey = new Map(pills.map(p => [p.key, p]));
  const editPos = editing ? pillByKey.get(editing.key) : undefined;

  return (
    <div ref={wrapRef} className={PREVIEW_FRAME} style={{ background: PREVIEW_BG, height }}>
      <style>{SCHEMATIC_CSS}</style>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', fontFamily: UI_FONT }}>
        <defs>
          {/* kapak yüzeyi: sıcak kemik gradyanı (hafif ışık üstten); seçili üye turuncuya kayar */}
          <linearGradient id={`${gid}-door`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SOFT.part0} /><stop offset="1" stopColor={SOFT.part1} /></linearGradient>
          <linearGradient id={`${gid}-door-on`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SOFT.on0} /><stop offset="1" stopColor={SOFT.on1} /></linearGradient>
          <linearGradient id={`${gid}-door-sel`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SOFT.sel0} /><stop offset="1" stopColor={SOFT.sel1} /></linearGradient>
          <pattern id={`${gid}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#bfb5a6" strokeWidth="0.7" /></pattern>
          <pattern id={`${gid}-hatch-on`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#e8925a" strokeWidth="0.9" /></pattern>
        </defs>
        {/* kapak alanı (yumuşak zemin; aralarda görünür) */}
        <rect x={ox} y={oy} width={SW} height={SH} rx={3} fill={SOFT.area} stroke={SOFT.areaStroke} strokeWidth={0.8} />
        {/* SINIR LEVHALARI (görünen kısım): dolu + taralı; yarım binmede / derze hizalıyken turuncu tonlu */}
        {bands.map(b => {
          const warm = b.half || b.aligned;
          return (
            <g key={`band-${b.np.vfId}`} style={{ pointerEvents: 'none' }}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={warm ? '#f9dcc4' : '#ddd4c6'} />
              <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={warm ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} />
              <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke={warm ? '#e07b3c' : '#a39a8d'} strokeWidth={1} />
            </g>
          );
        })}
        {/* kapaklar (kanatlar): yüzey + YUMUŞAK açılış işareti + numara + ölçü (Goker: "açılış çizgisi daha soft olsun, ölçüleri
            göster; menteşe ve kulp yerlerini şimdilik kaldır") */}
        {members.map((m, i) => {
          const on = i === selectedIndex;
          const inSel = selLeafIds.has(m.leafId);
          const x0 = Math.min(sx(m.u0), sx(m.u1)) + I, x1 = Math.max(sx(m.u0), sx(m.u1)) - I, y0 = Math.min(sy(m.v1), sy(m.v0)) + I, y1 = Math.max(sy(m.v1), sy(m.v0)) - I;
          const lbl = memberLabels[i] ?? String(i + 1);
          const fill = on ? `url(#${gid}-door-on)` : inSel ? `url(#${gid}-door-sel)` : `url(#${gid}-door)`;
          const stroke = on ? SOFT.onStroke : inSel ? SOFT.selStroke : SOFT.partStroke;
          // MENTEŞE (ekrana göre): tek kanat tipten; double'da ekranda solda duran kanat sol menteşe (aynalı görünüşte de doğru).
          let hinge: Hinge | undefined = leafHinges(m.type)[0];
          if (m.leafCount === 2 && doorLeafAxis(m.type) === 'u') { const sib = members[m.leaf === 0 ? i + 1 : i - 1]; hinge = sib && Math.min(sx(sib.u0), sx(sib.u1)) < x0 ? 'R' : 'L'; }
          else if (m.leafCount === 2) hinge = 'T';
          const typeTxt = DOOR_TYPE_LABEL[m.type] + (m.leafCount === 2 ? ` · leaf ${m.leaf + 1}/2` : '');
          const path = pathToLeaf(m.leafId);
          const wMm = Math.round(m.u1 - m.u0), hMm = Math.round(m.v1 - m.v0);
          const lhGuard = fsT * 1.18;   // numara + ölçü satırları merkez çevresinde ±1 satır
          const tip = `Door ${lbl} · ${typeTxt} · ${wMm} × ${hMm} mm${m.poly ? ' · angled (cut by rotated reference)' : ''}`
            + ` — click: select the area, click again to go one level deeper (${path.length} level${path.length === 1 ? '' : 's'}) · Shift/Ctrl+click: add another region · open the door's row below to edit it`;
          // AÇILI: kırpılmış çokgen; her köşe aynı kapak hücresinde kaldığından eğik kenar şemada da düz çizgidir.
          const pts = m.poly ? m.poly.map(q => ({ x: sx(q.x), y: sy(q.y) })) : null;
          const cx = pts ? pts.reduce((a, q) => a + q.x, 0) / pts.length : (x0 + x1) / 2;
          const cy = pts ? pts.reduce((a, q) => a + q.y, 0) / pts.length : (y0 + y1) / 2;
          const w = x1 - x0, h = y1 - y0;
          const ins = 5, sw = !!hinge && w > 2 * ins + 6 && h > 2 * ins + 6;
          // Numara + ölçü (W × H) + menteşesizlerde tip adı; kapak küçükse yalnız numara.
          const fsz = fsT * 0.86;
          // Ölçü zinciri pill'i kapağın yazı alanına biniyorsa (seçili bölgenin çapraz ölçüsü vb.) W×H alt yazısı gizlenir — zincir zaten söyler.
          const capW = `${wMm} × ${hMm}`.length * fsz * 0.6 + 6, capH = fsz * 1.2;
          const capHit = pills.some(pp => Math.abs(pp.cx - cx) < (pp.pw + capW) / 2 && Math.abs(pp.cy - cy) < (pp.ph + capH) / 2 + lhGuard);
          const showSize = w > 58 && h > 34 && !capHit;
          const caption = m.type === 'drawer' || m.type === 'fixed' ? DOOR_TYPE_LABEL[m.type] : null;
          const showCap = !!caption && showSize && h > 50;
          const lines = 1 + (showSize ? 1 : 0) + (showCap ? 1 : 0);
          const lh = fsT * 1.18;
          const ty0 = capHit ? cy - lhGuard : cy - ((lines - 1) * lh) / 2;   // pill merkeze bindiyse numara bir satır yukarı
          // ŞEMA TIKI = yalnız SEÇİM (Goker: "kapağın üzerine tıklandığında altındaki paneli otomatik açmasın"); yol üstten alta.
          return (
            <g key={`door-${i}`} style={{ cursor: 'pointer' }} onClick={e => { stop(e); onPathClick(path, e.shiftKey || e.ctrlKey || e.metaKey); }}>
              {pts ? (
                <polygon points={pts.map(q => `${q.x},${q.y}`).join(' ')} fill={fill} stroke={stroke} strokeWidth={on ? 1.2 : 0.9} strokeLinejoin="round"><title>{tip}</title></polygon>
              ) : (
                <rect x={x0} y={y0} width={Math.max(1, w)} height={Math.max(1, h)} rx={2.5} fill={fill} stroke={stroke} strokeWidth={on ? 1.2 : 0.8} style={{ filter: SOFT.shadow }}><title>{tip}</title></rect>
              )}
              {!pts && w > 6 && h > 6 && <rect x={x0 + 1} y={y0 + 1} width={Math.max(0, w - 2)} height={Math.max(0, h - 2)} rx={1.5} fill="none" stroke="#ffffff" strokeOpacity={0.55} strokeWidth={0.8} style={{ pointerEvents: 'none' }} />}
              {sw && <path d={swingPath(x0 + ins, y0 + ins, x1 - ins, y1 - ins, hinge!)} fill="none" stroke={on ? '#f3b98e' : '#d6cfc4'} strokeWidth={0.7} strokeDasharray="3 3" strokeLinejoin="round" strokeLinecap="round" style={{ pointerEvents: 'none' }} />}
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
        {/* KAPAK ARKASINDAKİ LEVHA KISMI: gizli çizgi (kesikli) + soluk tarama — tam / yarım binme ve derz hizası burada okunur */}
        {bands.flatMap(b => hiddenParts(b).map((hp, k) => (
          <g key={`hid-${b.np.vfId}-${k}`} style={{ pointerEvents: 'none' }}>
            <rect x={hp.x} y={hp.y} width={hp.w} height={hp.h} fill={b.half || b.aligned ? `url(#${gid}-hatch-on)` : `url(#${gid}-hatch)`} opacity={0.4} />
            <rect x={hp.x} y={hp.y} width={hp.w} height={hp.h} fill="none" stroke={b.half || b.aligned ? '#e8925a' : '#9a9185'} strokeWidth={0.8} strokeDasharray="3 2" opacity={0.9} />
          </g>
        )))}
        {/* LEVHA TIKLAMA ALANI + ROZET (bandın ortasında, düşey levhada dikey yazı): kenar levhası → Full / Half; derzdeki
            raf/dikme üyesi → Free / Left / Center / Right (Up / Center / Down): tık derzi levhaya bağlar + levhayı taşır (döngü);
            Shift/Ctrl bağı çözer. Bağlı levha turuncu rozet. */}
        {bands.map(b => {
          const np = b.np;
          const pickable = !!refPick && !np.edge;
          const rem = removable(np);
          const bindable = !np.edge && !!np.joint && (!!np.groupId || !!np.ref);
          const interactive = isOuter && (rem || pickable || (!!np.edge && np.behind) || bindable);
          const chipTxt = rem ? '✕ Remove' : pickable ? 'Split here' : np.edge ? (np.behind ? (b.half ? 'Half' : 'Full') : null) : bindable ? (np.ref ? alignLabel(b, np.ref.align) : 'Free') : null;
          const on = b.half || b.aligned;
          const bx = b.x + b.w / 2, by = b.y + b.h / 2;
          const cfs = fsT * 0.8;
          const { pw: cw, ph: chh } = chipTxt ? pillSize(chipTxt, cfs) : { pw: 0, ph: 0 };
          return (
            <g key={`hit-${np.vfId}`} className={`yago-band${chipTxt ? ' on' : ''}`} style={{ cursor: interactive ? 'pointer' : 'default' }}
              onClick={interactive ? e => { stop(e); onBandClick(b, e.shiftKey || e.ctrlKey || e.metaKey); } : undefined}>
              <rect x={b.x - 2} y={b.y - 2} width={b.w + 4} height={b.h + 4} fill="transparent" className="hit" />
              {chipTxt && (
                <g className="chip" transform={b.vertical ? `rotate(-90 ${bx} ${by})` : undefined}>
                  <rect x={bx - cw / 2} y={by - chh / 2} width={cw} height={chh} rx={chh / 2} fill={rem ? '#fef2f2' : pickable ? '#fff7ed' : on ? '#ea580c' : '#ffffff'} stroke={rem ? '#ef4444' : pickable ? '#f97316' : on ? '#c2410c' : '#cfc6b9'} strokeWidth={0.8}
                    style={{ filter: 'drop-shadow(0 1px 1px rgba(40,30,20,0.12))' }} />
                  <text x={bx} y={by + cfs * 0.36} textAnchor="middle" fontSize={cfs} fontWeight={700} letterSpacing="0.02em" fill={rem ? '#b91c1c' : on ? '#ffffff' : pickable ? '#c2410c' : '#78716c'} fontFamily={UI_FONT}>{chipTxt}</text>
                </g>
              )}
              <title>{bandTip(b)}</title>
            </g>
          );
        })}
        {/* ODAK BOŞLUKLARI (Goker: "tıkladığım yerdeki kapak boşluklarını daha net anlaşılır yap"): seçili bölmenin araları / seçili
            kapağın çevresindeki boşluklar kapak alanında turuncu şerit. */}
        {focusStrips.map((r, i) => (
          <rect key={`fs-${i}`} x={r.x} y={r.y} width={r.w} height={r.h} fill="#f97316" fillOpacity={0.28} stroke="#ea580c" strokeOpacity={0.55} strokeWidth={0.6} style={{ pointerEvents: 'none' }} />
        ))}
        {/* ARAYA RAF / DİKME (Goker, Eki 2026: "2 kapak arasına raf veya dikme … düğmeye basınca 2 kapak arası belirginleşsin;
            dikmenin sağına ve soluna da raf yerleştirebileyim"): seçilen eksendeki her derz, onu kesen çapraz levhalarla (yatay derzi
            dikmeler, dikey derzi raflar; kaynak addObstacles — kapak sınırı işaretsiz levhalar dahil) PARÇALARA bölünür; aynı türde
            levhası olmayan her parça kehribar bant + "+ Divider" / "+ Shelf" rozeti; tık → o parçanın ortasından hacim ışını
            (addPanelAtDoorJoint at) → her parça AYRI grup = listede ayrı satır. */}
        {addPick && isOuter && doorJointParts(doorJoints(solved), addObstacles ?? nearPanels, addPick).flatMap(({ joint: j, all: segs, free }) => {
          const vertical = j.axis === 'u';
          // Dolu parçada (derze değen aynı türde levha — bağlı ya da değil, işaretli ya da değil) rozet yok; işaretliyse bandı ✕ Remove / hiza rozeti gösterir.
          const allMids = free.map(([c0, c1]) => (c0 + c1) / 2);
          return free.map(([c0, c1]) => {
            const mid = (c0 + c1) / 2;
            const MINW = 14;
            let a0 = vertical ? Math.min(sx(j.p0), sx(j.p1)) : Math.min(sy(j.p0), sy(j.p1)), a1 = vertical ? Math.max(sx(j.p0), sx(j.p1)) : Math.max(sy(j.p0), sy(j.p1));
            if (a1 - a0 < MINW) { const c = (a0 + a1) / 2; a0 = c - MINW / 2; a1 = c + MINW / 2; }
            const q0 = vertical ? Math.min(sy(c0), sy(c1)) : Math.min(sx(c0), sx(c1)), q1 = vertical ? Math.max(sy(c0), sy(c1)) : Math.max(sx(c0), sx(c1));
            const x = vertical ? a0 : q0, y = vertical ? q0 : a0, w = vertical ? a1 - a0 : q1 - q0, h = vertical ? q1 - q0 : a1 - a0;
            const txt = vertical ? '+ Divider' : '+ Shelf';
            const cfs = fsT * 0.8, { pw: cw, ph: chh } = pillSize(txt, cfs);
            const bx = x + w / 2, by = y + h / 2;
            const what = vertical ? 'divider' : 'shelf';
            return (
              <g key={`add-${j.splitId}-${j.k}-${Math.round(c0)}`} className="yago-band on" style={{ cursor: 'pointer' }} onClick={e => { stop(e); onAddPick?.(j.splitId, j.k, e.shiftKey || e.ctrlKey || e.metaKey ? allMids : [mid]); }}>
                <rect x={x} y={y} width={w} height={h} rx={3} fill="#fb923c" fillOpacity={0.16} stroke="#f97316" strokeWidth={1} strokeDasharray="4 2.5" className="hit" />
                <g className="chip" transform={vertical ? `rotate(-90 ${bx} ${by})` : undefined}>
                  <rect x={bx - cw / 2} y={by - chh / 2} width={cw} height={chh} rx={chh / 2} fill="#fff7ed" stroke="#f97316" strokeWidth={0.8} style={{ filter: 'drop-shadow(0 1px 1px rgba(40,30,20,0.12))' }} />
                  <text x={bx} y={by + cfs * 0.36} textAnchor="middle" fontSize={cfs} fontWeight={700} letterSpacing="0.02em" fill="#c2410c" fontFamily={UI_FONT}>{txt}</text>
                </g>
                <title>{`Add a ${what} between these two doors${segs.length > 1 ? ` (this part of the joint, ${round1(c1 - c0)} mm)` : ''}: it is created in the free volume behind this spot (listed after the door row) and stays bound to the joint — when the doors change, the ${what} follows.${allMids.length > 1 ? ` Shift+click: a ${what} in every free part of this joint (${allMids.length}).` : ''} Its Left / Center / Right badge then sets the alignment; Shift+click on the badge unbinds.`}</title>
              </g>
            );
          });
        })}
        {/* SEÇİLİ BÖLGELER: yalnız çerçeve (bölme kesikli, kapak düz) — köşe etiketi kaldırıldı (Goker: "L0 L1 L2 gereksiz"). */}
        {selRegions.map(n => {
          const b = nodeBox(n);
          const pad = n.kind === 'split' ? 2.5 : 0.5;
          return (
            <g key={`sel-${n.id}`} style={{ pointerEvents: 'none' }}>
              <rect x={b.x0 - pad} y={b.y0 - pad} width={b.x1 - b.x0 + 2 * pad} height={b.y1 - b.y0 + 2 * pad} rx={3} fill="#ea580c" fillOpacity={n.kind === 'split' ? 0.05 : 0.0} stroke="#ea580c" strokeWidth={1.2} strokeDasharray={n.kind === 'split' ? '5 3' : undefined} />
            </g>
          );
        })}
        {/* ÖLÇÜ ZİNCİRLERİ: dış (kök) + iç (iç içe bölmeler, kanatlar) */}
        {/* ÖLÇÜ ZİNCİRLERİ: yalnız seçili bölgelerin, bölgenin üzerinde (boşluk pill'i turuncu zeminli, ölçü pill'i turuncu çerçeveli) */}
        {pills.map(p => {
          const { item: it, chain: ch, f } = p;
          const hide = editing?.key === p.key;
          if (it.kind === 'gap') {
            return <DimPill key={p.key} cx={p.cx} cy={p.cy} txt={it.txt} fs={f} fill="#fff7ed" stroke="#f97316" strokeWidth={1} color="#c2410c" hideText={hide} title={it.title}
              onClick={e => { stop(e); beginEdit({ key: p.key, v: it.txt }); }} />;
          }
          const locked = !!it.locked, edited = !locked && !!it.edited, editable = !!it.onLock || it.key.startsWith('leaf-');
          // Kilit rozeti pill'in ucunda HER ZAMAN (yatay zincirde sağında, düşeyde altında); girilmiş ölçü kehribar, kilitli turuncu.
          return (
            <g key={p.key} className={`yago-gap${locked ? ' locked' : ''}`}>
              <DimPill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} fill={locked || edited ? '#fff7ed' : '#ffffff'} stroke={edited ? '#fbbf24' : '#f97316'} strokeWidth={locked ? 1.2 : 1}
                color={locked ? '#c2410c' : edited ? '#9a3412' : '#1c1917'} hideText={hide} title={editable ? (edited ? `${it.title} (entered value)` : it.title) : `${it.title} — set by the door bounds`}
                onClick={editable ? e => { stop(e); beginEdit({ key: p.key, v: it.txt }); } : undefined} />
              {it.onLock && (ch.horiz
                ? <LockBadge cx={p.cx + p.pw / 2 + 12 + LOCK_R} cy={p.cy} locked={locked} edited={edited} onClick={it.onLock} />
                : <LockBadge cx={p.cx} cy={p.cy + p.ph / 2 + 12 + LOCK_R} locked={locked} edited={edited} onClick={it.onLock} />)}
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

/* ── SATIR YAPI TAŞLARI (hizalama sözleşmesi) ──────────────────────────────
   Goker: "W H D satırları tipi ne olursa olsun aynı hizada olmalı." Her satır
   türü (gövde paneli, raf/dikme grubu, grup üyesi) aynı sütunları kullanır:
   [numara 30px] [tip işareti 20px] [ad — esnek] [ölçüler sabit genişlik]
   [kontroller sabit genişlik]. Üye satırları kartın içinde 8px içeride
   durduğu için sağ kontrol alanı 8px dar tutulur → ölçü sütunları hizalanır. */
const ROW_NUM_W = 30;
/* SATIR DÜĞMELERİ (Goker, Eki 2026: "yüzeyin şeklini al · kapak sınırı · yön · sil düğmelerini biraz büyüt, araları eşit
   kalsın"): dördü de 24×24 kutu, 14px ikon, aralarında 3px; aç/kapa oku da aynı 24×24 düğme. Genişlik = 5×24 + 4×3 = 132. */
const ROW_BTN = 'w-6 h-6 shrink-0 rounded-md flex items-center justify-center transition-colors duration-150';
const ROW_ICON = 14;
const ROW_TRAIL_W = 132;          // 5 × 24px düğme (4 araç + aç/kapa oku) + 4 × 3px aralık
const MEMBER_INSET = 8;           // grup kartı gövdesinin yatay dolgusu (px-2)
type RowKind = 'body' | 'shelf' | 'divider' | 'door';
const ROW_KIND_ICON: Record<RowKind, LucideIcon> = { body: LayoutPanelTop, shelf: Rows3, divider: Columns3, door: DoorClosed };
const ROW_KIND_TITLE: Record<RowKind, string> = { body: 'Body panel', shelf: 'Shelf', divider: 'Divider', door: 'Door' };
/** SOFT SATIR + AKORDEON: satır sade kart; seçilince AYNI kart aşağı açılır. */
const rowCardClass = (open: boolean, dragging: boolean, armed: boolean) =>
  `group/row relative flex flex-col rounded-[10px] overflow-hidden transition-[background-color,box-shadow,opacity,transform] duration-150 ease-out
   ${open ? 'bg-[#fffdf9] ring-1 ring-[#efd9c0] shadow-[0_1px_2px_rgba(234,88,12,0.05),0_8px_20px_-14px_rgba(120,70,20,0.35)] my-1'
     : 'bg-[#fdfcfa] ring-1 ring-[#ece7df] shadow-[0_1px_0_rgba(68,64,60,0.025)] hover:bg-white hover:ring-[#e2dbd0] hover:shadow-[0_1px_2px_rgba(68,64,60,0.04),0_4px_10px_-8px_rgba(68,64,60,0.18)]'}
   ${dragging ? 'opacity-40 scale-[0.99]' : ''}
   ${armed && !dragging ? '!ring-orange-300 !bg-white shadow-[0_6px_16px_-8px_rgba(234,88,12,0.35)] scale-[1.006]' : ''}`;
const ROW_INPUT_CLASS = 'yago-row-note flex-1 min-w-0 h-[22px] px-[5px] text-[11.5px] text-stone-700 bg-transparent border border-transparent rounded-[5px] outline-none placeholder:text-stone-300 hover:border-[#ebe5dc] focus:bg-white focus:border-orange-400/50 transition-colors';
/* SİL düğmesi HER ZAMAN görünür (Goker, Eki 2026: "her satırda silme düğmesi fix olsun, fareyi üzerine götürünce değil"). */
const ROW_DEL_CLASS = `${ROW_BTN} text-stone-400 hover:bg-red-50 hover:text-red-500`;
const DROP_BAND = 'pointer-events-none h-[7px] mx-1 rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.65),0_1px_2px_rgba(180,83,9,0.3)]';

/** Panel tipi işareti — tüm satırlarda aynı boyut (20×20 kutu, 13px ikon).
 *  Grup satırında adet, işaretin sağ üst köşesinde küçük rozet olarak durur. */
function RowTypeBadge({ kind, active, count, doorBound }: { kind: RowKind; active: boolean; count?: number; doorBound?: boolean }) {
  const Icon = ROW_KIND_ICON[kind];
  return (
    <span title={(count != null ? `${ROW_KIND_TITLE[kind]} · ${count} panel${count === 1 ? '' : 's'}` : ROW_KIND_TITLE[kind]) + (doorBound ? ' · door reference' : '')}
      className={`relative shrink-0 w-5 h-5 rounded-[6px] flex items-center justify-center transition-colors duration-150
        ${active ? 'bg-orange-50 text-orange-500 ring-1 ring-orange-200/70' : 'bg-[#f5f2ec] text-stone-400 group-hover/row:text-stone-500'}`}>
      <Icon size={13} strokeWidth={2} />
      {/* KAPAK SINIRI işareti: küçük kehribar nokta (3B'deki kehribar kenarla aynı dil). */}
      {doorBound && count == null && <span className="absolute -bottom-[3px] -right-[3px] w-[7px] h-[7px] rounded-full bg-amber-500 ring-2 ring-[#fdfcfa]" />}
      {count != null && (
        <span className={`absolute -top-[5px] -right-[6px] min-w-[13px] h-[13px] px-[3px] rounded-full text-[8.5px] font-bold tabular-nums leading-[13px] text-center ring-2 ring-[#fdfcfa]
          ${active ? 'bg-orange-500 text-white' : 'bg-stone-500 text-white'}`}>{count}</span>
      )}
    </span>
  );
}
/** Ölçü sütunları — sabit genişlik; harf + değer her satırda aynı x'te. */
function RowDims({ w, h, t, tLetter = 'T', title }: { w?: number | null; h?: number | null; t?: number | null; tLetter?: string; title?: string }) {
  const cell = (letter: string, v: number | null | undefined, muted = false) => (
    <span className="inline-flex items-baseline w-[54px]">
      <span className="w-[11px] text-[11px] font-semibold text-stone-400">{letter}</span>
      <span className={`ml-[5px] text-[12.5px] font-medium ${muted ? 'text-stone-500' : 'text-stone-700'}`}>{v == null ? '—' : v}</span>
    </span>
  );
  const sep = <span className="w-px h-3 bg-[#e6e0d6] mx-[6px] self-center" />;
  return (
    <span onClick={stop} title={title} className="shrink-0 inline-flex items-baseline leading-none tabular-nums cursor-default">
      {cell('W', w)}{sep}{cell('H', h)}{sep}{cell(tLetter, t, true)}
    </span>
  );
}
/** Satır numarası (sabit sütun) — seçiliyken turuncu. */
const RowNum = ({ label, active, small }: { label: string; active: boolean; small?: boolean }) => (
  <span style={{ width: ROW_NUM_W }} className={`shrink-0 ${small ? 'text-[11.5px]' : 'text-[13px]'} text-center font-semibold tabular-nums leading-none transition-colors duration-150
    ${active ? 'text-orange-600' : 'text-stone-400 group-hover/row:text-stone-600'}`}>{label}</span>
);
/** Aç / kapa göstergesi (chevron). */
/* SATIR AÇ / KAPA — TEK MANTIK (Goker, Eki 2026: "panelin, dikmenin ve kapağın satır kapanışı tek mantıkta olsun"): her
   satırda (gövde paneli, raf/dikme üyesi, raf/dikme grubu, kapak grubu) BAŞLIĞA ya da sağdaki OK düğmesine tıklamak aynı işi
   yapar — kapalıysa açar (panel: seçer; grup: tümünü seçer), açıksa kapatır (seçimler düşer). Ok her satırda aynı yerde,
   aynı boyda (24 px) ve her zaman tıklanabilir. */
const RowChevron = ({ open, onClick, title }: { open: boolean; onClick?: (e: React.MouseEvent) => void; title?: string }) => (
  <button type="button" onClick={onClick} title={title ?? (open ? 'Collapse' : 'Expand')}
    className={`${ROW_BTN} ${open ? 'text-orange-500 bg-orange-50/70 hover:bg-orange-100/70' : 'text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700'}`}>
    <ChevronRight size={ROW_ICON} strokeWidth={2.1} className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
  </button>
);
/* ── GRUP KARTI DÜZENİ (Goker, Eki 2026: "raf/dikme arayüzü çok iç içe; ifadeleri kısalt, rahatlat;
   adet ve spacing sırası çok karışık") ───────────────────────────────────────────────────────────
   Kart iki sakin satıra ayrıldı: (1) EYLEMLER — eşit genişlikte düğme ızgarası (panel satırındaki
   Extrude/Move/Rotate ile aynı dil); (2) DEĞERLER — her değer kendi kutusunda: solda kısa etiket,
   sağda kontrol (adet stepper'ı / mm girişi); en sağda tek ikonlu "eşitle". */
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
/** Değer kutusu: solda kısa etiket, sağda kontrol. accent = otomatik/etkin değer (turuncu ince çerçeve). */
function FieldBox({ label, title, accent, fixed, children }: { label: string; title?: string; accent?: boolean; fixed?: boolean; children: React.ReactNode }) {
  return (
    <div title={title} onClick={stop}
      className={`${fixed ? 'shrink-0' : 'flex-1 min-w-0'} h-[28px] pl-2 pr-1 flex items-center gap-1 rounded-[7px] bg-white transition-shadow duration-150
        ${accent ? 'ring-1 ring-orange-400/70 shadow-[0_0_0_2px_rgba(249,115,22,0.08)]' : 'ring-1 ring-[#e6e0d6] shadow-[0_1px_0_rgba(40,30,20,0.03)]'}`}>
      {label && <span className="shrink-0 text-[9.5px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]">{label}</span>}
      <div className="flex-1 min-w-0 flex items-center justify-end gap-0.5">{children}</div>
    </div>
  );
}
/** Kutu içi çıplak giriş (çerçevesiz; kutunun kendisi çerçeve). */
const FIELD_INPUT: React.CSSProperties = {
  width: 40, minWidth: 0, height: 22, textAlign: 'center', border: 'none', outline: 'none', background: 'transparent', padding: 0,
  fontFamily: "'SF Mono',ui-monospace,Menlo,monospace", fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: '#1c1917',
};
/** Kutu içi −/+ düğmesi. */
const StepBtn = ({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button type="button" title={title} disabled={disabled} onClick={e => { stop(e); if (!disabled) onClick(); }}
    className={`w-[20px] h-[20px] shrink-0 rounded-[5px] flex items-center justify-center transition-colors duration-150
      ${disabled ? 'text-stone-300 cursor-not-allowed' : 'text-stone-500 hover:bg-[#f3efe8] hover:text-stone-800'}`}>{children}</button>
);
/** Yalnız ikonlu kare düğme (eşitle). */
const IconSquareBtn = ({ icon: Icon, title, onClick }: { icon: LucideIcon; title: string; onClick: () => void }) => (
  <button type="button" title={title} onClick={e => { stop(e); onClick(); }}
    className="shrink-0 w-[28px] h-[28px] rounded-[7px] flex items-center justify-center bg-white ring-1 ring-[#e6e0d6] text-stone-500 shadow-[0_1px_0_rgba(40,30,20,0.03)] hover:bg-[#faf7f2] hover:ring-[#dcd4c8] hover:text-stone-800 transition-colors duration-150">
    <Icon size={12.5} strokeWidth={2.2} />
  </button>
);
const unitTxt = (u: string) => <span className="shrink-0 pr-1 text-[10px] font-medium text-stone-400">{u}</span>;
/**
 * PARÇA SAYISI KUTUSU (Goker, Eki 2026: "kaça bölüneceğini seçmeliyim … miktar girerek"): ikon + etiket, −/+ ve
 * doğrudan yazılabilen sayı (Enter / odak kaybı uygular). 1 = bu eksende bölünmemiş.
 */
function CountBox({ icon: Icon, label, value, title, onChange, max = 12 }: { icon: LucideIcon; label: string; value: number; title: string; onChange: (n: number) => void; max?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); }, [value]);
  const commit = () => {
    if (draft == null) return;
    const n = parseInt(draft, 10);
    setDraft(null);
    if (Number.isFinite(n) && n >= 1 && n <= max && n !== value) onChange(n);
  };
  // −/+ GERİ (Goker: "v ve h modunda + − düğmelerini geri koy, alanı biraz genişlet"): ikon + harf · − · sayı (yazılır, ↑↓) · +.
  return (
    <FieldBox label="" title={title}>
      <span className="flex items-center gap-[3px] pr-0.5 mr-auto text-[9.5px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]"><Icon size={11} strokeWidth={2} />{label}</span>
      <StepBtn title="Fewer pieces" disabled={value <= 1} onClick={() => onChange(value - 1)}><Minus size={10} strokeWidth={2.2} /></StepBtn>
      <input type="text" inputMode="numeric" value={draft ?? String(value)} onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); if (e.key === 'ArrowUp') { e.preventDefault(); if (value < max) onChange(value + 1); } if (e.key === 'ArrowDown') { e.preventDefault(); if (value > 1) onChange(value - 1); } }} onClick={stop}
        className="yago-field" style={{ ...FIELD_INPUT, width: 24 }} aria-label={`${label} pieces`} />
      <StepBtn title="More pieces" disabled={value >= max} onClick={() => onChange(value + 1)}><Plus size={10} strokeWidth={2.2} /></StepBtn>
    </FieldBox>
  );
}
/** SPACING kutusu: hedef parça ölçüsü (mm); boş = hedef yok. Enter / odak kaybı uygular; boş girilirse hedef kalkar. */
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
  // İPTAL (Goker: "spacing değeri girdiğimde yazılan değeri iptal edemiyorum"): değer varken × düğmesi hedefi kaldırır (kutuyu
  // boşaltıp Enter / odak kaybı da aynı); parçalar olduğu gibi durur.
  return (
    <FieldBox label="" title={title} accent={value != null}>
      <span className="flex items-center gap-[3px] pr-0.5 mr-auto text-[9.5px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]"><Icon size={11} strokeWidth={2} />{label}</span>
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
/**
 * BÖLME MODU açılır listesi (Goker: "count, spacing ve ref modunu combobox yap, alan kazanalım"): PlacementSelect ile aynı dil.
 */
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
/**
 * DIŞ / İÇ KAPAK açılır listesi (Goker, Eki 2026: "inner ve outer seçeneklerini combobox yap, açılır listeden
 * değiştireyim"): yerleştirme şeridinde ve kapak kartında aynı bileşen. Yerel <select> — klavye/erişilebilirlik hazır.
 */
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

/** Bölüm başlığı: "COUNT", "PANELS 3 ———", "STEPS 2 ———". */
const SectionHead = ({ label, count, rule = true, className = 'px-1 pt-2 pb-1' }: { label: string; count?: number; rule?: boolean; className?: string }) => (
  <div className={`${className} flex items-center gap-2`}>
    <span style={SECTION_LABEL}>{label}</span>
    {count != null && <span className="text-[10px] font-medium tabular-nums text-stone-300">{count}</span>}
    {rule && <div className="flex-1 h-px bg-[#efeae2]" />}
  </div>
);

/** Liste animasyonu: akordeon açılışı. (Odak modu ve "yerleşme" animasyonu kaldırıldı — bkz. ODAK MODU notu.) */
const LIST_CSS = `@keyframes yagoExpand{from{opacity:0;clip-path:inset(0 0 100% 0);transform:translateY(-4px)}to{opacity:1;clip-path:inset(0 0 0 0);transform:none}}.yago-expand{animation:yagoExpand 260ms cubic-bezier(.2,.7,.2,1) both}`;

type StepEdit = { id: string; v: string } | null;

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
    'raycastPendingVf', 'placementName', 'setPlacementName');
  // Kapak grubu kartı: kalınlık / boşluk giriş taslakları.
  const [doorDraft, setDoorDraft] = useState<{ id: string; field: 't' | 'gap'; v: string } | null>(null);
  // BÖLGE SEÇİMİ (Goker, Eki 2026: "tıkladığım yerde önce büyük alanı, 2. tıklamada tek seçilen yeri; üst seviyeden alt
  // seviyeye doğru"): şemada tıklanan noktanın kök → yaprak yolu üzerinde her tık bir seviye iner (kök alan → bölme →
  // kapak → seçim kalkar); Shift/Ctrl aynı seviyeden başka bölge ekler. Düğüm id'si tutulur (yaprak ya da split); üye/3B
  // seçimiyle bağı YOK. Tip: seçili bölgelerin altındaki kapaklar (boşsa hepsi), uygulanınca seçim kalkar. Bölme
  // sayıları: seçili bölge (boşsa kök alan) — sayı değişince bölge seçili kalır ki ardışık ayar yapılabilsin.
  const [doorNodeSel, setDoorNodeSel] = useState<{ id: string; nodes: string[] } | null>(null);
  // BÖLME MODU (Goker, Eki 2026): Count (parça sayısı) · Panel ref (store bayrağı doorRefPickGroupId — dikme/rafın ortasından
  // böl) · Spacing (hedef parça ölçüsü). Count/Spacing yerel; Panel ref kart kapanınca ya da seçim yapılınca kapanır.
  const [doorSplitMode, setDoorSplitMode] = useState<{ id: string; mode: 'count' | 'spacing' } | null>(null);
  // ARAYA RAF / DİKME modu (Goker, Eki 2026: "kapak arayüzünden kapakların arasına tıklayarak raf ve dikme atamak"): kapak
  // kartındaki Divider / Shelf düğmesi → şemada o eksendeki derzler vurgulanır; derze tık → addPanelAtDoorJoint; mod kapanır.
  const [doorAddPick, setDoorAddPick] = useState<{ id: string; axis: 'u' | 'v' } | null>(null);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Tutamaç KAVRAMA geri bildirimi: mousedown anında satır "kalkmış" görünür.
  const [armedRowKey, setArmedRowKey] = useState<string | null>(null);
  // Raf/dikme grup kartı: adet girişi taslağı (Enter/blur ile uygulanır).
  const [countDraft, setCountDraft] = useState<{ id: string; v: string } | null>(null);
  // HEDEF ARALIK taslağı (grup kartı "Spacing" girişi): boş = kapalı.
  const [gapDraft, setGapDraft] = useState<{ id: string; v: string } | null>(null);
  // ODAK MODU KALDIRILDI (Goker, Eki 2026: "bir panele tıklayınca dikme/raf/kapakta arayüz başka bir hale geçiyor,
  // bunu iptal et"): liste hiçbir seçimde daralmaz, üye satırları gizlenmez, şema küçülmez.
  // AÇIK KARTLAR (Goker: "altında açılan paneli kapatabileyim ama dikme görünümü kapanmasın; liste görünümüne
  // dönen ayrı bir düğme olsun"): grup/kapak kartının açıklığı seçimden AYRI yerel durumdur. Üye seçilince kart
  // açılır ve açık KALIR; üyenin editörü kapanınca kart durur. Kart yalnız başlıktaki ok (chevron) ile kapanır.
  const [openCards, setOpenCards] = useState<Set<string>>(() => new Set());
  const openCard = (id: string) => setOpenCards(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  const closeCard = (id: string, memberIds: string[]) => {
    setOpenCards(prev => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
    const st = useAppStore.getState();
    if (st.selectedPanelGroupId === id) setSelectedPanelGroupId(null);
    if (st.selectedDoorGroupId === id) setSelectedDoorGroupId(null);
    if (typeof st.selectedPanelRow === 'string' && memberIds.some(m => st.selectedPanelRow === `vf-${m}`)) setSelectedPanelRow(null);
    setDoorNodeSel(prev => (prev?.id === id ? null : prev));   // kapak kartı kapanınca şemadaki bölge seçimi de kalkar
    if (useAppStore.getState().doorRefPickGroupId === id) setDoorRefPickGroupId(null);   // panel ref modu da kapanır
    setDoorAddPick(prev => (prev?.id === id ? null : prev));   // araya raf/dikme modu da kapanır
  };
  // Adım düzenleme: aynı anda tek adım düzenlenir (extrude / move / rotate ayrımı adım tipinden gelir).
  const [stepEdit, setStepEdit] = useState<StepEdit>(null);
  // Şerit girişlerinin yerel metin taslakları (başta -/+ yazılabilsin).
  const [extrudeThicknessStr, setExtrudeThicknessStr] = useState(String(faceExtrudeThickness));
  const [moveValueStr, setMoveValueStr] = useState('0');
  const [rotateValueStr, setRotateValueStr] = useState('0');
  const prevMoveAxisRef = useRef(panelMoveAxis);
  const prevRotateAxisRef = useRef(panelRotateAxis);
  const rowRefs = useRef<Map<number | string, HTMLDivElement>>(new Map());

  // Eksen seçimi değişince giriş sıfırlanır (yeni giriş oturumu).
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

  // Üye (raf/dikme/kapak) seçilince — listeden ya da 3B'den — kartı açık tut; grup "tümünü seç" de kartı açar.
  useEffect(() => {
    if (typeof selectedPanelRow === 'string' && selectedPanelRow.startsWith('vf-')) {
      const vf = virtualFaces.find(f => f.id === selectedPanelRow.slice(3));
      const gid = vf?.groupId || vf?.doorGroupId;
      if (gid) openCard(gid);
    }
    if (selectedPanelGroupId) openCard(selectedPanelGroupId);
    if (selectedDoorGroupId) openCard(selectedDoorGroupId);
  }, [selectedPanelRow, selectedPanelGroupId, selectedDoorGroupId, virtualFaces]);

  useEffect(() => {
    if (selectedShapeId !== useAppStore.getState().selectedPanelRowParentId) setSelectedPanelRow(null);
    // Gövde değişince grup seçimi ve hacim seçme modu da düşer.
    const st = useAppStore.getState();
    if (st.selectedPanelGroupId && !st.panelGroups.some(g => g.id === st.selectedPanelGroupId && g.shapeId === selectedShapeId)) setSelectedPanelGroupId(null);
    if (st.selectedDoorGroupId && !st.doorGroups.some(g => g.id === st.selectedDoorGroupId && g.shapeId === selectedShapeId)) setSelectedDoorGroupId(null);
    if (st.volumePickMode) setVolumePickMode(null);
    if (st.doorPickMode) setDoorPickMode(false);
    setOpenCards(new Set());
  }, [selectedShapeId]);
  // Kapak grubu silinince seçimi düşür.
  useEffect(() => {
    if (selectedDoorGroupId && !doorGroups.some(g => g.id === selectedDoorGroupId)) setSelectedDoorGroupId(null);
    if (doorRefPickGroupId && !doorGroups.some(g => g.id === doorRefPickGroupId)) setDoorRefPickGroupId(null);
  }, [doorGroups, selectedDoorGroupId, doorRefPickGroupId]);
  // PANEL REF / ARAYA RAF-DİKME modu: Esc iptal eder.
  useEffect(() => {
    if (!doorRefPickGroupId && !doorAddPick) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDoorRefPickGroupId(null); setDoorAddPick(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doorRefPickGroupId, doorAddPick]);

  // OTOMATİK PANEL ÜRETİMİ: paneli olmayan her VF için panel yaratılır.
  useEffect(() => {
    const currentShapes = useAppStore.getState().shapes;
    // YARIŞ KORUMASI: birden çok VF aynı anda beklerken (raf/dikme adedi
    // artınca) ilk VF'nin hasPanel=true yazımı bu efekti yeniden tetikler;
    // ikinci çalışma hâlâ üretilmekte olan VF için İKİNCİ bir panel yaratıyordu
    // (üst üste iki raf). Üretimi süren VF'ler modül düzeyinde işaretlenir.
    const pending = virtualFaces.filter(vf => !vf.hasPanel && !_creatingPanelForVf.has(vf.id) && !panelOfVf(vf.id, currentShapes));
    if (!pending.length) return;
    for (const vf of pending) _creatingPanelForVf.add(vf.id);
    (async () => {
      for (const vf of pending) {
        const parentShape = shapeById(vf.shapeId);
        if (!parentShape || !useAppStore.getState().virtualFaces.some(f => f.id === vf.id)) { _creatingPanelForVf.delete(vf.id); continue; }
        try {
          // İÇ PANEL (raf/dikme): kalınlık grubun ÜYE kalınlığı (şemadaki kutucuk); gövde paneli varsayılan.
          const grp = vf.groupId ? useAppStore.getState().panelGroups.find(pg => pg.id === vf.groupId) : undefined;
          // KAPAK ÜYESİ: kalınlık kapak grubundan.
          const dgrp = vf.doorGroupId ? useAppStore.getState().doorGroups.find(dg => dg.id === vf.doorGroupId) : undefined;
          const th = grp ? memberThicknessesOf(grp)[vf.groupIndex ?? grp.memberVfIds.indexOf(vf.id)] || grp.thickness : dgrp ? dgrp.thickness : PANEL_THICKNESS;
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
              // İÇ PANEL (raf/dikme): grup kimliği + üye kalınlığı panele de yazılır — motor/damga/şerit sınıfı bunu okur.
              ...(vf.groupId ? { panelGroupId: vf.groupId, panelThickness: th } : {}),
              // KAPAK: grup kimliği + kalınlık panele yazılır (motor kapağı damga/engel/kesim dışında tutar).
              ...(vf.doorGroupId ? { doorGroupId: vf.doorGroupId, panelThickness: th } : {}) },
          } as Shape);
          updateVirtualFace(vf.id, { hasPanel: true });
        } catch (e) { console.error('Auto panel creation failed:', e); }
        finally { _creatingPanelForVf.delete(vf.id); }
      }
      // Geometri geçici VF prizmasıdır; paneli bölgesine oturtan rebuild'i App'teki
      // panel-kümesi izleyicisi (addShape) tetikler — burada ikinci kez çağrılmaz.
    })();
  }, [virtualFaces]);

  useEffect(() => {
    // HACİM DÜZENLEME sürerken açık üye satırı hedefi ele geçirmez.
    if (faceExtrudeMode && !faceExtrudeCavityGroupId && activePanelId && activePanelId !== faceExtrudeTargetPanelId) { setFaceExtrudeTargetPanelId(activePanelId); setFaceExtrudeSelectedFace(null); }
  }, [faceExtrudeMode, faceExtrudeCavityGroupId, activePanelId, faceExtrudeTargetPanelId]);
  useEffect(() => {
    if (panelMoveMode && activePanelId && activePanelId !== panelMoveTargetPanelId) { setPanelMoveTargetPanelId(activePanelId); setPanelMoveAxis(null); setPanelMoveValue(0); }
  }, [panelMoveMode, activePanelId, panelMoveTargetPanelId]);

  // Seçilen yüzde zaten bir extrude adımı varsa değeri ve modu şeride yükle.
  useEffect(() => {
    if (faceExtrudeSelectedFace === null || !activePanelId || faceExtrudeCavityGroupId) return;
    const ps = shapeById(activePanelId, shapes); if (!ps?.geometry) return;
    const steps = ps.parameters?.extrudeSteps || []; if (!steps.length) return;
    const { groups } = getFacesAndGroups(ps.geometry);
    let g = groups[faceExtrudeSelectedFace]; if (!g) return;
    const gn = g.normal.clone().normalize();
    if (!isFlatNormal(gn, 0.9)) {
      // Eğik yüz: aynı baskın yöndeki en yakın DÜZ yüz grubu esas alınır.
      const flat = groups.filter(f => { const fn = f.normal.clone().normalize(); return isFlatNormal(fn, 0.9) && dominantAxisLabel(fn) === dominantAxisLabel(gn); })
        .sort((a, b) => a.center.distanceTo(g!.center) - b.center.distanceTo(g!.center))[0];
      if (flat) g = flat;
    }
    const existing = findExistingStepForFace(steps, g.normal.clone().normalize(), g.center.clone());
    // Mevcut adımın sabit/dinamik modu şeride yansır (ref akışı bozulmaz).
    if (existing) { setFaceExtrudeThickness(existing.value); if (faceExtrudeValueMode !== 'ref') setFaceExtrudeValueMode(existing.isFixed ? 'fixed' : 'dyn'); }
  }, [faceExtrudeSelectedFace, activePanelId, shapes]);

  // ── KOMUT–ARAYÜZ SENKRONU: GARANTİ ÇIKIŞ ─────────────────────────────────
  // İSTEK (Goker): "extrude/taşıma modu arayüzden geriye doğru çıkıldığı HER
  // durumda komuttan da çıksın, her zaman." Taşı / Döndür / Extrude düğmeleri
  // SEÇİLİ PANEL SATIRI şeridinin içinde yaşar; komutun tek geçerlilik koşulu:
  // açık satırın paneli === komutun hedef paneli. Bu tek kural geriye çıkışın
  // BÜTÜN yollarını kapsar (satır kapatıldı, başka satıra geçildi, blok seçimi
  // değişti, panel silindi, editör kapandı).
  // GEÇİCİ BOŞLUK KORUMASI: yeniden üretim dalgalarında satır AÇIK kalırken
  // activePanelId bir an null'a düşebilir. O anı "geriye çıkış" saymayız —
  // çıkış ya satırın gerçekten kapanmasıyla ya da BAŞKA bir panelin satırına
  // geçilmesiyle belirlenir.
  const uiLeftPanel = (targetId: string | null) => selectedPanelRow === null || (!!activePanelId && targetId !== activePanelId);
  // HACİM DÜZENLEME: geçerlilik koşulu grup kartının AÇIK olması (tümü seçili ya da bir üye satırı açık).
  const groupCardOpen = (gid: string) => selectedPanelGroupId === gid || virtualFaces.some(f => f.groupId === gid && selectedPanelRow === `vf-${f.id}`);
  // YENİDEN HACİM SEÇİMİ: grup kartı kapanır / grup silinir / başka gövde seçilirse mod düşer.
  useEffect(() => {
    if (!volumePickMode || !volumePickGroupId) return;
    if (!panelGroups.some(g => g.id === volumePickGroupId && g.shapeId === selectedShapeId) || !groupCardOpen(volumePickGroupId)) {
      console.log('[YAGO][KOMUT-ÇIKIŞ] yeniden hacim seçimi kapatıldı — grup kartı arayüzde açık değil', 'grup=', volumePickGroupId);
      setVolumePickMode(null);
    }
  }, [volumePickMode, volumePickGroupId, panelGroups, selectedShapeId, selectedPanelGroupId, selectedPanelRow, virtualFaces]);
  useEffect(() => {
    if (faceExtrudeMode && faceExtrudeCavityGroupId) {
      if (!panelGroups.some(g => g.id === faceExtrudeCavityGroupId && g.shapeId === selectedShapeId) || !groupCardOpen(faceExtrudeCavityGroupId)) {
        console.log('[YAGO][KOMUT-ÇIKIŞ] hacim düzenleme kapatıldı — grup kartı arayüzde açık değil', 'grup=', faceExtrudeCavityGroupId);
        setFaceExtrudeSelectedFace(null); setFaceExtrudeRefCandidate(null); setFaceExtrudeMode(false);
      }
      return;
    }
    if (faceExtrudeMode && uiLeftPanel(faceExtrudeTargetPanelId)) {
      console.log('[YAGO][KOMUT-ÇIKIŞ] extrude modu kapatıldı — panel satırı arayüzde açık değil', 'hedef=', faceExtrudeTargetPanelId, 'açıkSatırPaneli=', activePanelId);
      setFaceExtrudeSelectedFace(null); setFaceExtrudeRefCandidate(null); setFaceExtrudeMode(false);
    }
    if (panelMoveMode && uiLeftPanel(panelMoveTargetPanelId)) {
      console.log('[YAGO][KOMUT-ÇIKIŞ] taşıma modu kapatıldı — panel satırı arayüzde açık değil', 'hedef=', panelMoveTargetPanelId, 'açıkSatırPaneli=', activePanelId);
      setPanelMoveAxis(null); setPanelMoveMode(false);
    }
    if (panelRotateMode && uiLeftPanel(panelRotateTargetPanelId)) {
      console.log('[YAGO][KOMUT-ÇIKIŞ] döndürme modu kapatıldı — panel satırı arayüzde açık değil', 'hedef=', panelRotateTargetPanelId, 'açıkSatırPaneli=', activePanelId);
      setPanelRotateAxis(null); setPanelRotateMode(false);
    }
  }, [activePanelId, selectedPanelRow, selectedShapeId, selectedPanelGroupId, panelGroups, faceExtrudeMode, faceExtrudeTargetPanelId, faceExtrudeCavityGroupId, panelMoveMode, panelMoveTargetPanelId, panelRotateMode, panelRotateTargetPanelId]);

  // HACİM YÜZÜ seçilince o yüzde adım varsa değeri/modu şeride yükle (panel akışıyla aynı).
  useEffect(() => {
    if (!faceExtrudeCavityGroupId || !faceExtrudeCavityFaceNormal) return;
    const g = panelGroups.find(x => x.id === faceExtrudeCavityGroupId); if (!g?.cavitySteps?.length) return;
    const n = faceExtrudeCavityFaceNormal;
    const ax = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])].indexOf(Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])));
    // Aynı eksen+yön; birden çoksa (L'nin iki kolu) çıpası tıklama noktasına en yakın adım.
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

  // AKORDEON: açılan satır (listeden ya da 3B'den seçilince) görünür alana kaydırılır.
  useEffect(() => {
    if (selectedPanelRow === null) return;
    const t = window.setTimeout(() => rowRefs.current.get(selectedPanelRow)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
    return () => window.clearTimeout(t);
  }, [selectedPanelRow]);
  // GRUP KARTI da aynı kural: grup seçilince ("tümünü seç" — listeden, 3B'den ya da kapak kartından yeni eklenen raf/dikme) kartı
  // görünür alana kaydır (Goker: "her dikme ve raf yeni bir satır olsun, otomatik olarak o satırı açsın").
  useEffect(() => {
    if (!selectedPanelGroupId) return;
    const t = window.setTimeout(() => rowRefs.current.get(`grp-${selectedPanelGroupId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
    return () => window.clearTimeout(t);
  }, [selectedPanelGroupId]);

  // OUTLINE: showOutlines yalnız KULLANICI TERCİHİDİR (store'da kalıcı). Eskiden burada
  // yerleştirmeye girince zorla açılıp panel yerleşince zorla kapatılıyordu → son seçim
  // kayboluyordu. Yerleştirme sırasındaki geçici görünürlük çizimde (ShapeWithTransform).

  const withActivePanel = (fn: (ps: Shape) => Promise<unknown> | unknown) => { const ps = shapeById(activePanelId, shapes); if (ps) return fn(ps); };
  const toggleArrow = (p: Shape | undefined) => { if (p) updateShape(p.id, { parameters: { ...p.parameters, arrowRotated: !p.parameters?.arrowRotated } }); };
  // YÜZEYİN ŞEKLİNİ AL: bayrak VF'de saklanır; bölge hesabı (computeFreeRegionLocal)
  // yalnız regen'de okur → tam rebuild ile panel yeni bölgesine göre üretilir.
  const toggleFitShape = async (vf: VirtualFace) => {
    const next = !vf.fitFaceShape;
    updateVirtualFace(vf.id, { fitFaceShape: next });
    console.log('[YAGO][YÜZ-ŞEKLİ]', vf.id, next ? 'AÇIK' : 'KAPALI', '→ tam rebuild');
    try { await requestRebuild(vf.shapeId); } catch (e) { console.error('[YAGO][YÜZ-ŞEKLİ] rebuild hatası:', e); }
  };

  // ÜST ARAÇ ÇUBUĞU — Parameters paneliyle ORTAK bileşen (ToolChip). Yalnız ekleme araçları;
  // Outline ve Body/Panel seçim modu tüm menüleri kapsadığı için kenar çubuğu başlığında (Ui.Sidebar).
  const panelToolbar = (
    <ToolChipBar>
      <ToolChip label="Body Panel" icon={LayoutPanelTop} active={raycastMode} onClick={() => setRaycastMode(!raycastMode)} title="Add a panel on a body face" />
      {/* Yeniden seçim (Relocate) sürerken bu çipler pasif görünür; tıklanınca yeni grup seçimine geçer (groupId düşer). */}
      <ToolChip label="Shelf" icon={Rows3} active={volumePickMode === 'shelf' && !volumePickGroupId} onClick={() => setVolumePickMode(volumePickMode === 'shelf' && !volumePickGroupId ? null : 'shelf')} title="Add shelves: pick a cavity in the 3D view" />
      <ToolChip label="Divider" icon={Columns3} active={volumePickMode === 'divider' && !volumePickGroupId} onClick={() => setVolumePickMode(volumePickMode === 'divider' && !volumePickGroupId ? null : 'divider')} title="Add vertical dividers: pick a cavity in the 3D view" />
      {/* KAPAK (Goker): kapak sınırı işaretli panellerden adaylar — tıkla, döndür, sağ tık onayla. */}
      <ToolChip label="Door" icon={DoorClosed} active={doorPickMode} onClick={() => setDoorPickMode(!doorPickMode)} title="Add doors: mark door references on panels (Door ref), then click a body face in the 3D view" />
    </ToolChipBar>
  );

  /* ── EXTRUDE ŞERİDİ ───────────────────────────────────────────────────── */
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

  /* ── HACİM ŞERİDİ (raf/dikme grubu) — panel extrude şeridiyle birebir aynı bileşenler ── */
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

  /* ── HACİM ADIMLARI LİSTESİ (grup kartında; panel adım listesiyle aynı satır dili) ── */
  const cavityStepsPanel = (g: PanelGroup) => {
    const steps = g.cavitySteps || [];
    if (!steps.length) return null;
    const tag = (txt: string) => <span className="shrink-0 text-[9.5px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px] bg-[#f3efe8] text-stone-500">{txt}</span>;
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
                  <span className="shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#f3efe8] text-[10px] font-semibold text-stone-500 tabular-nums leading-none">{idx + 1}</span>
                  <span className="shrink-0 text-[10px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px]" style={{ background: 'rgba(14,116,144,0.09)', color: '#0e7490' }}>Vol</span>
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

  /* ── TAŞIMA ŞERİDİ — yalnız etkin komutun giriş satırı (adım listesi ayrı) ── */
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
        setSelectedPanelRow(null); // Ref onaylandı → panel seçili kalmasın.
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

  /* ── DÖNDÜRME ŞERİDİ — pivot + eksen seçimi, sonra değer girişi ──────────
     REF MODU AKIŞI (Goker): 1) pivot  2) nişan noktası (panelin kendi noktası)
     3) mod  4) eksen (X/Y/Z halkası)  5) referans panel + referans nokta
     6) sağ tık onay. Onaydan sonra bağ KALICIDIR: referans nokta taşındıkça
     panel o noktaya nişan alacak şekilde yeniden döner. */
  const rotateDock = (() => {
    if (!activePanelId || !panelRotateMode) return null;
    const isRotRefMode = panelRotateValueMode === 'ref';
    const hasPivot = panelRotatePivot !== null, hasAxis = panelRotateAxis !== null, hasArm = panelRotateRefArmVertex !== null;
    const rotRefReady = isRotRefMode && hasPivot && hasArm && hasAxis && !!panelRotateRefFace;
    const modeBar = (trailing?: React.ReactNode) => (
      <DockModeBar trailing={trailing} active={panelRotateValueMode}
        modes={dockModes(['dyn', 'ref'], { dyn: { sub: 'Angle', title: 'Enter an angle: pivot → axis → degrees' }, ref: { sub: 'Aim at face', title: 'Rotate to a reference: pivot → aim point → axis → reference face → right-click' } })}
        onPick={k => { console.log('[YAGO][DÖN-MOD] mod seçildi:', k); setPanelRotateValueMode(k as 'dyn' | 'ref'); setRotateValueStr('0'); }} />
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

    // 1. ADIM: MOD SEÇİMİ — sahnede henüz hiçbir nokta/halka yok (gizmo mod
    // seçilene kadar null döner). (Goker: "önce hiç nokta çıkmadan mod seçimi olsun.")
    if (panelRotateValueMode === null) return (
      <div style={DOCK_SHELL}>
        {modeBar(<div style={{ display: 'flex', alignItems: 'center' }}><ExitBtn onClick={exit} /></div>)}
        <div style={{ padding: '5px 10px 7px', fontSize: 10.5, fontWeight: 500, color: '#a8a29e', fontFamily: UI_FONT }}>Choose a rotation mode</div>
      </div>
    );
    // REF MODU: tek satır, adım sayaçlı durum etiketi + onay. Şerit dar: etiket
    // kısa tutulur, tam açıklama title'da (hover) verilir.
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

  /* ── BİRLEŞİK ADIM LİSTESİ (önizlemenin altında, kaydırılabilir) ─────── */
  const stepsPanel = (() => {
    if (!activePanelId || !activePanel || (!activeSteps.length && !activeTransformSteps.length)) return null;
    const typeBadge: Record<string, { label: string; bg: string; color: string }> = {
      move: { label: 'Move', bg: 'rgba(22,163,74,0.08)', color: '#15803d' },
      rotate: { label: 'Rotate', bg: 'rgba(37,99,235,0.08)', color: '#1d4ed8' },
      extrude: { label: 'Ext', bg: 'rgba(217,119,6,0.09)', color: '#b45309' },
    };
    // Birleşik sıralı liste: extrude + dönüşüm adımları zaman damgasına göre.
    // Ref adımlarında UI çözülen gerçek miktarı gösterir (donmuş value değil) —
    // referans nokta taşındıkça buradaki değer de güncellenir.
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
    const tag = (txt: string) => <span className="shrink-0 text-[9.5px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px] bg-[#f3efe8] text-stone-500">{txt}</span>;
    return (
      <div className="shrink-0 mt-2" style={{ fontFamily: UI_FONT }}>
        <SectionHead label="Steps" count={allSteps.length} className="px-1 pb-1.5" />
        <div className="overflow-y-auto" style={{ maxHeight: 200 }}>
          <div className="flex flex-col gap-[2px] p-px">
            {allSteps.map((s, idx) => {
              const badge = typeBadge[s.stepType] || typeBadge.move;
              const editing = stepEdit?.id === s.id;
              // Referans bağlı adım — açı/mesafe referanstan çözülür, elle düzenlenemez (R).
              const editable = !(s.stepType === 'extrude' && s.isRef) && !(s.stepType === 'rotate' && s.isRef);
              return (
                <div key={s.id} className="group/step flex items-center gap-1.5 pl-1.5 pr-1 h-[30px] rounded-[9px] bg-[#fdfcfa] ring-1 ring-[#ece7df] shadow-[0_1px_0_rgba(68,64,60,0.025)] hover:bg-white hover:ring-[#e2dbd0] transition-colors duration-150">
                  <span className="shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#f3efe8] text-[10px] font-semibold text-stone-500 tabular-nums leading-none">{idx + 1}</span>
                  <span className="shrink-0 text-[10px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px]" style={{ background: badge.bg, color: badge.color }}>{badge.label}</span>
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

  /* ── AÇILAN SATIR GÖVDESİ ─────────────────────────────────────────────────
     Satırın hemen altında, aynı kartın içinde: araç segmenti (Extrude / Move /
     Rotate) → aktif ŞERİT (mod segmenti + giriş/durum) → panel önizlemesi →
     işlem adımları. (Goker, Eki 2026: şerit önizlemenin ALTINDAYKEN mod/ref
     düğmeleri 500px'lik önizlemenin altında kalıp görünmüyordu — şerit artık
     araçların hemen altında, önizlemenin ÜSTÜNDE; araç ve mod düğmeleri 24px.) */
  const renderExpandedBody = (vf: VirtualFace, vp: Shape | undefined) => {
    const isExtrudingThis = faceExtrudeMode && faceExtrudeTargetPanelId === vp?.id;
    const isMovingThis = panelMoveMode && panelMoveTargetPanelId === vp?.id;
    const isRotatingThis = panelRotateMode && panelRotateTargetPanelId === vp?.id;
    const tool = isExtrudingThis ? 'extrude' : isMovingThis ? 'move' : isRotatingThis ? 'rotate' : null;
    const pickTool = (k: string) => {
      if (!vp) return;
      if (k === tool) {   // aynı araca ikinci tık = kapat
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
      <div className="yago-expand px-2 pt-2 pb-2" style={{ borderTop: '1px solid #f3e6d6' }} onClick={stop}>
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

  /* ── YÜZ LİSTESİ (akordeon satırlar + grup kartları) ────────────────────── */
  const renderFaceList = () => {
    if (!selectedShape?.geometry) return null;
    const sid = selectedShape.id;
    const svf = virtualFaces.filter(vf => vf.shapeId === sid);
    if (!svf.length) return (
      <div className="flex flex-col items-center justify-center py-6 text-center">
        <div className="w-8 h-8 rounded-lg bg-stone-100 flex items-center justify-center mb-2"><MoveVertical size={14} className="text-stone-400" /></div>
        <span className="text-xs text-stone-400">No faces added yet</span>
        <span className="text-[10px] text-stone-300 mt-0.5">Use Body Panel, Shelf or Divider to create panels</span>
      </div>
    );

    // DÜZ LİSTE — SATIR BİRLEŞTİRME YOK (Goker): her VF, store sırasıyla kendi
    // satırıdır; listedeki numara = VF sırası = basan/basılan önceliği.
    // TEK İSTİSNA — RAF/DİKME GRUBU: bir grubun üyeleri store'da bitişik durur
    // ve TEK kart olarak (ilk üyenin sırasında) gösterilir. Grup kartı = "tümünü
    // seç", üye satırı = tek panel seçimi. Grup sürüklenince tüm üyeler taşınır.
    // KAPAK GRUBU da aynı kuralla TEK kart (ilk üyenin sırasında).
    type Row = { kind: 'vf'; vf: VirtualFace } | { kind: 'group'; group: PanelGroup; members: VirtualFace[] } | { kind: 'door'; group: DoorGroup; members: VirtualFace[] };
    const rows: Row[] = [];
    const seenGroups = new Set<string>();
    for (const vf of svf) {
      const g = vf.groupId ? panelGroups.find(x => x.id === vf.groupId) : undefined;
      const dg = vf.doorGroupId ? doorGroups.find(x => x.id === vf.doorGroupId) : undefined;
      if (g) { if (!seenGroups.has(g.id)) { seenGroups.add(g.id); rows.push({ kind: 'group', group: g, members: svf.filter(m => m.groupId === g.id) }); } }
      else if (dg) { if (!seenGroups.has(dg.id)) { seenGroups.add(dg.id); rows.push({ kind: 'door', group: dg, members: svf.filter(m => m.doorGroupId === dg.id) }); } }
      else rows.push({ kind: 'vf', vf });
    }
    const idsOf = (r: Row) => (r.kind === 'vf' ? [r.vf.id] : r.members.map(m => m.id));
    const rowKeyOf = (r: Row) => (r.kind === 'vf' ? r.vf.id : `grp-${r.group.id}`);
    const clearDrag = () => { setDragIndex(null); setDropIndex(null); };

    // PANEL SİL: panel + yüzeyi (VF) birlikte kalıcı olarak silinir. Kalanlar
    // yeni duruma göre yeniden üretilir (boşalan alanı doldursunlar).
    const deletePanelAndFace = async (vfId: string) => {
      const p = panelOfVf(vfId, shapes);
      if (p) useAppStore.getState().deleteShape(p.id);
      deleteVirtualFace(vfId);
      if (selectedPanelRow === `vf-${vfId}`) setSelectedPanelRow(null);
      console.log('[YAGO][SİL] panel + yüzey silindi', vfId, p?.id || '(panel yok)');
      // Panel silindiyse rebuild'i App izleyicisi tetikler; yalnız paneli olmayan VF için burada.
      if (!p) { try { await requestRebuild(sid); } catch (e) { console.error('Silme sonrası rebuild hatası:', e); } }
    };
    // Sürüklenen satır (VF ya da grup üyeleri), hedefin ÖNCESİNE (targetId) yerleşir; null = en son.
    // NOT: store.reorderVirtualFaceGroup zaten bir rebuild tetikler; buradaki
    // ikinci rebuild bilinçli korunur — ref-dönüş açıları geçişler arasında
    // yakınsadığından tek geçiş farklı sonuç verir (harness ile doğrulandı).
    const doReorder = async (draggedIds: string[], targetId: string | null) => {
      clearDrag();
      reorderVirtualFaceGroup(sid, draggedIds, targetId);
      await requestRebuild(sid);
    };
    // KULLANICI KURALI: bırakma HER ZAMAN üzerine gelinen satırın ALTINA yerleşir.
    // Store insert-BEFORE çalıştığı için hedef = bir sonraki satırın ilk VF id'si.
    const onRowDropBelow = async (draggedRowIdx: number, hoveredRowIdx: number) => {
      if (draggedRowIdx === hoveredRowIdx) return clearDrag();
      const next = rows[hoveredRowIdx + 1];
      if (next && rowKeyOf(next) === rowKeyOf(rows[draggedRowIdx])) return clearDrag(); // zaten hemen altında
      await doReorder(idsOf(rows[draggedRowIdx]), next ? idsOf(next)[0] : null);
    };
    /** Sıralama tutamacı (gövde satırı / grup kartı). */
    const grip = (rowKey: string, rowIdx: number, title: string) => (
      <span draggable
        onMouseDown={() => setArmedRowKey(rowKey)} onMouseUp={() => setArmedRowKey(null)}
        onMouseLeave={() => { if (dragIndex === null) setArmedRowKey(null); }}
        onDragStart={e => { stop(e); setDragIndex(rowIdx); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', rowKey); }}
        onDragEnd={() => { clearDrag(); setArmedRowKey(null); }}
        onClick={stop} style={{ cursor: GRIP_CURSOR }} title={title}
        className={`shrink-0 w-[18px] ml-[3px] self-stretch flex items-center justify-center transition-colors duration-150
          ${armedRowKey === rowKey ? 'text-orange-500' : 'text-stone-300/70 group-hover/row:text-stone-400 hover:!text-orange-500'}`}>
        <GripVertical size={13} strokeWidth={1.75} />
      </span>
    );

    /* ── TEK VF SATIRI (gövde paneli ya da grup üyesi) ─────────────────── */
    const vfRow = (vf: VirtualFace, rowIdx: number, label: string, opts: { member?: boolean; group?: PanelGroup; door?: DoorGroup }) => {
      const rowKey = vf.id;
      const dragging = !opts.member && dragIndex === rowIdx;
      const vp = panelOfVf(vf.id, shapes), ar = vp?.parameters?.arrowRotated || false, sel = selectedPanelRow === `vf-${vf.id}`;
      const dims = panelDims(vp);
      // KAPAK ÜYESİ: tipi ve kanat bilgisi (satırda ikon + kanat numarası).
      const doorMemberType = opts.door ? doorMembersOf(opts.door)[opts.door.memberVfIds.indexOf(vf.id)] : undefined;
      return (
        <div key={rowKey} ref={el => { const k = `vf-${vf.id}`; if (el) rowRefs.current.set(k, el); else rowRefs.current.delete(k); }}
          className={rowCardClass(sel, dragging, armedRowKey === rowKey)}>
          {/* ── SATIR BAŞLIĞI ── */}
          <div className={`relative flex items-stretch ${sel ? 'bg-[#fff8ef]' : ''}`}>
            {sel && <span className="pointer-events-none absolute left-0 top-[6px] bottom-[6px] w-[2px] rounded-r-full bg-orange-500/90" />}
            {opts.member
              ? <span className="shrink-0 w-[10px] ml-[3px] self-stretch" /> // Üye satırı: sürükleme yok (grup birlikte taşınır).
              : grip(rowKey, rowIdx, 'Drag to reorder')}
            <div onClick={e => { stop(e); if (sel) setSelectedPanelRow(null); else setSelectedPanelRow(`vf-${vf.id}`, sid); }}
              className="flex-1 min-w-0 relative flex items-center gap-1.5 pl-0.5 pr-1 py-[4px] cursor-pointer">
              <RowNum label={label} active={sel} small={opts.member} />
              <RowTypeBadge kind={opts.group ? opts.group.kind : opts.door ? 'door' : 'body'} active={sel} doorBound={!!vf.doorBound} />
              {opts.member && (opts.group || opts.door) ? (
                // ÜYE ADI: grup adından gelir, burada DEĞİŞTİRİLEMEZ (grup satırından düzenlenir).
                <span title={opts.door && doorMemberType ? `${DOOR_TYPE_TITLE[doorMemberType.type]}${doorMemberType.leafCount === 2 ? ` · leaf ${doorMemberType.leaf + 1}/2` : ''} — name comes from the group (edit it on the group row)` : 'Name comes from the group (edit it on the group row)'}
                  className="flex-1 min-w-0 h-[22px] px-[5px] flex items-center gap-1.5 text-[11.5px] font-medium text-stone-500 truncate cursor-default select-none">
                  {/* KAPAK ÜYESİ: tip ikonu (açılış işareti) + kanat numarası — tip çubuğuyla aynı çizim. */}
                  {opts.door && doorMemberType && <span className="shrink-0 text-stone-400"><DoorTypeIcon type={doorMemberType.type} size={11} strokeWidth={1.4} /></span>}
                  <span className="truncate">{opts.group ? groupName(opts.group) : doorGroupName(opts.door!)}</span>
                  {opts.door && doorMemberType?.leafCount === 2 && <span className="shrink-0 text-[9.5px] font-semibold text-stone-400 tabular-nums">{doorMemberType.leaf + 1}/2</span>}
                </span>
              ) : (
                <input type="text" value={vf.description || ''} onClick={stop} onChange={e => updateVirtualFace(vf.id, { description: e.target.value })}
                  placeholder="Panel" title="Panel name" className={`${ROW_INPUT_CLASS} font-medium`} />
              )}
              <RowDims w={dims?.primary} h={dims?.secondary} t={dims?.thickness} tLetter="T" />
              {/* Kontrol alanı sabit genişlik (üyede kart dolgusu kadar dar) → ölçüler hizalı kalır. */}
              <div className="flex items-center justify-end gap-[3px] shrink-0 ml-0.5" style={{ width: opts.member ? ROW_TRAIL_W - MEMBER_INSET : ROW_TRAIL_W }} onClick={stop}>
                {/* Yüzeyin şeklini al: iç panelde (raf/dikme) serbest bölge yok → gösterilmez. */}
                {!opts.member && <FitShapeToggle checked={!!vf.fitFaceShape} disabled={!vf.hasPanel} onToggle={() => { void toggleFitShape(vf); }} />}
                {/* KAPAK SINIRI: her satırda (gövde paneli, raf/dikme üyesi) — kapak üyesinde yok. Şemadaki işaretle aynı bayrak (VF.doorBound). */}
                {opts.door ? <span className="w-6 h-6 shrink-0" /> : <DoorRefToggle checked={!!vf.doorBound} disabled={!vf.hasPanel} onToggle={() => setVfDoorBound(vf.id, !vf.doorBound)} />}
                <button disabled={!vf.hasPanel} onClick={e => { stop(e); toggleArrow(vp); }} title="Toggle arrow direction"
                  className={`${ROW_BTN} ${!vf.hasPanel ? 'text-stone-200 cursor-not-allowed' : ar ? 'text-stone-700 bg-[#f1ece4]' : 'text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700'}`}>
                  <ArrowUp size={ROW_ICON} strokeWidth={1.9} className={`transition-transform duration-200 ${ar ? '' : 'rotate-90'}`} />
                </button>
                {/* Sil: her zaman görünür. Üye paneller adet ile yönetilir. */}
                {!opts.member
                  ? <button onClick={e => { stop(e); void deletePanelAndFace(vf.id); }} title="Delete panel" className={ROW_DEL_CLASS}><Trash2 size={ROW_ICON - 1} strokeWidth={1.9} /></button>
                  : <span className="w-6 h-6 shrink-0" />}
                <RowChevron open={sel} onClick={e => { stop(e); if (sel) setSelectedPanelRow(null); else setSelectedPanelRow(`vf-${vf.id}`, sid); }} />
              </div>
            </div>
          </div>
          {/* ── AÇILAN GÖVDE (akordeon) ── */}
          {sel && renderExpandedBody(vf, vp)}
        </div>
      );
    };

    /* ── RAF / DİKME GRUP KARTI ────────────────────────────────────────── */
    const groupCard = (g: PanelGroup, members: VirtualFace[], rowIdx: number, label: string) => {
      const rowKey = `grp-${g.id}`;
      const selAll = selectedPanelGroupId === g.id;
      const dimsWHD = [0, 1, 2].map(a => round1(boxSpan(g.cavity, a)));
      const countVal = countDraft?.id === g.id ? countDraft.v : String(g.count);
      const applyCount = (n: number) => { setCountDraft(null); if (!isNaN(n) && n >= 1 && n !== g.count) void setGroupCount(g.id, n); };
      // HEDEF ARALIK (Goker): değer girilince adet hacimden türetilir ve gövde boyutlandıkça kendini günceller; boş = kapalı.
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
      // TEK MANTIK: başlık ya da ok — kapalıysa aç + tümünü seç; açıksa kapat (grup / üye seçimi düşer).
      const toggleRow = (e: React.MouseEvent) => { stop(e); if (open) closeCard(g.id, mIds); else { setSelectedPanelGroupId(g.id); openCard(g.id); } };
      return (
        <div key={rowKey} ref={el => { if (el) rowRefs.current.set(rowKey, el); else rowRefs.current.delete(rowKey); }}
          className={rowCardClass(open, dragIndex === rowIdx, armedRowKey === rowKey)}>
          {/* ── GRUP BAŞLIĞI: tıkla = aç (tümünü seç) / kapat ── */}
          <div className={`relative flex items-stretch ${selAll ? 'bg-[#fff8ef]' : ''}`}>
            {selAll && <span className="pointer-events-none absolute left-0 top-[6px] bottom-[6px] w-[2px] rounded-r-full bg-orange-500/90" />}
            {grip(rowKey, rowIdx, 'Drag to reorder (whole group)')}
            <div onClick={toggleRow} className="flex-1 min-w-0 relative flex items-center gap-1.5 pl-0.5 pr-1 py-[4px] cursor-pointer" title={open ? 'Collapse' : 'Expand — selects all panels in this group'}>
              <RowNum label={label} active={selAll} />
              <RowTypeBadge kind={g.kind} active={open} count={g.count} />
              {/* GRUP ADI: değiştirilebilir; üye panellerin adı bu addır. */}
              <input type="text" value={groupName(g)} onClick={stop} onChange={e => renamePanelGroup(g.id, e.target.value)} placeholder={groupKindLabel(g.kind)}
                title="Group name (applies to all its panels)" className={`${ROW_INPUT_CLASS} font-semibold`} />
              {/* Hacmin en · boy · derinliği — panel satırlarıyla aynı sütunlar. */}
              <RowDims w={dimsWHD[0]} h={dimsWHD[1]} t={dimsWHD[2]} tLetter="D" title="Cavity width · height · depth" />
              <div className="flex items-center justify-end gap-[3px] shrink-0 ml-0.5" style={{ width: ROW_TRAIL_W }} onClick={stop}>
                <button onClick={e => { stop(e); deletePanelGroupWithMembers(g.id); }} title="Delete group (all panels)" className={ROW_DEL_CLASS}><Trash2 size={ROW_ICON - 1} strokeWidth={1.9} /></button>
                <RowChevron open={open} onClick={toggleRow} />
              </div>
            </div>
          </div>
          {/* ── AÇILAN GÖVDE: adet + şema + üye satırları ── */}
          {open && (
            <div className="yago-expand px-2 pt-2 pb-2" style={{ borderTop: '1px solid #f3e6d6', fontFamily: UI_FONT }} onClick={stop}>
              {/* TEK SATIR (Goker, Eki 2026: "işaretlenen alan tek sırada olsun; volume/relocate kısa, qty/spacing gereksiz uzun"):
                  solda kısa eylem düğmeleri, sağda dar değer kutuları + eşitle. */}
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
                    {/* KAPAK DERZİNE BAĞ (Goker: kapak arayüzünden eklenen raf/dikme "hep o kapak aralarının arasında çalışsın"): rozet + çöz. */}
                    {g.doorBond && (
                      <span className="shrink-0 h-[28px] pl-2 pr-1 inline-flex items-center gap-1 rounded-[7px] bg-orange-50 ring-1 ring-orange-200/70 text-[10.5px] font-semibold text-orange-700"
                        title={`Bound to a door joint (${g.doorBond.align === 'center' ? 'centered on the joint' : g.doorBond.align === 'min' ? 'behind the lower / left door' : 'behind the upper / right door'}): this ${g.kind} follows the doors — when the door sizes change it moves with the joint. Editing its gap here moves the door joint instead. Unbind to free it (it stays where it is).`}>
                        <DoorClosed size={12} strokeWidth={2} /><span>Door joint</span>
                        <button type="button" title="Unbind from the door joint — the panel stays where it is (to delete the panel use the trash button in the row header, or Remove in the door card)" onClick={e => { stop(e); useAppStore.getState().updatePanelGroup(g.id, { doorBond: undefined }); console.log('[YAGO][GRUP-KAPAK-BAĞ] bağ çözüldü (grup kartı):', g.id); }}
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
              {/* Şema sırası = geometrik sıra (memberVfIds / groupIndex); numara = listedeki sıra (members). */}
              <GroupSchematic group={g} selectedIndex={g.memberVfIds.findIndex(id => selectedPanelRow === `vf-${id}`)}
                memberLabels={g.memberVfIds.map((id, i) => { const mi = members.findIndex(m => m.id === id); return `${label}.${(mi >= 0 ? mi : i) + 1}`; })}
                onEditGap={(k, v, pv) => { if (pv) previewGroupGap(g.id, k, v); else void editGroupGap(g.id, k, v); }} onToggleLock={k => toggleGroupGapLock(g.id, k)}
                onEditBegin={() => groupLayoutSnapshot(g.id)} onEditCancel={snap => restoreGroupLayout(g.id, snap as GroupLayoutSnap | null)}
                doorRefs={g.memberVfIds.map(id => !!virtualFaces.find(f => f.id === id)?.doorBound)}
                splitBacks={g.memberVfIds.map(id => !!virtualFaces.find(f => f.id === id)?.splitBack)}
                onToggleSplitBack={i => { const id = g.memberVfIds[i]; const f = virtualFaces.find(x => x.id === id); if (f) { updateVirtualFace(id, { splitBack: !f.splitBack }); console.log('[YAGO][ARKALIK-BÖL]', id, !f.splitBack ? 'İŞARETLENDİ' : 'kaldırıldı', '(davranış henüz tanımlı değil)'); } }}
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


    /* ── KAPAK GRUP KARTI (Goker, Eki 2026) — raf/dikme kartıyla aynı dil ─────
       Üst satır: Dikeyde böl (sütun) · Yatayda böl (satır) · Eşitle; ikinci satır:
       Dış/İç kapak · kalınlık · kapaklar arası boşluk; sonra kapak şeması ve üye satırları. */
    const doorCard = (g: DoorGroup, members: VirtualFace[], rowIdx: number, label: string) => {
      const rowKey = `grp-${g.id}`;
      const selAll = selectedDoorGroupId === g.id;
      const open = openCards.has(g.id) || selAll || members.some(m => selectedPanelRow === `vf-${m.id}`);
      const dimsW = round1(g.rect.u1 - g.rect.u0), dimsH = round1(g.rect.v1 - g.rect.v0);
      const doorParent = open ? shapeById(g.shapeId, shapes) : undefined;   // şema yalnız açıkken çözülür (açılı kesimler + yarım binme uygunluğu)
      const doorCuts = doorParent ? collectDoorCuts(doorParent, shapes, virtualFaces) : [];
      const mIds = members.map(m => m.id);
      // TEK MANTIK: başlık ya da ok — kapalıysa aç + tümünü seç; açıksa kapat (grup / üye seçimi, şema seçimi, panel ref modu düşer).
      const toggleRow = (e: React.MouseEvent) => { stop(e); if (open) closeCard(g.id, mIds); else { setSelectedDoorGroupId(g.id); openCard(g.id); } };
      const draft = (field: 't' | 'gap', fallback: number) => (doorDraft?.id === g.id && doorDraft.field === field ? doorDraft.v : String(fallback));
      const applyDraft = (field: 't' | 'gap') => {
        const v = parseFloat(draft(field, field === 't' ? g.thickness : g.gap).replace(',', '.'));
        setDoorDraft(null);
        if (!Number.isFinite(v)) return;
        if (field === 't') void setDoorThickness(g.id, v); else void setDoorGap(g.id, v);
      };
      const numInput = (field: 't' | 'gap', fallback: number) => (
        <input type="text" inputMode="decimal" value={draft(field, fallback)}
          onChange={e => setDoorDraft({ id: g.id, field, v: e.target.value })}
          onBlur={() => applyDraft(field)}
          onKeyDown={e => { if (e.key === 'Enter') applyDraft(field); if (e.key === 'Escape') setDoorDraft(null); }}
          onClick={stop} className="yago-field" style={{ ...FIELD_INPUT, width: 34, textAlign: 'right' }} />
      );
      // HEDEF BÖLGELER: şemadaki seçim (düğüm id'leri; kök → yaprak tık döngüsü). Tip: altındaki kapaklar, boşsa hepsi.
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
      // Tık yolu (kök → yaprak): seçili düğüm yoldaysa bir seviye iner; yaprak tekrar tıklanırsa seçim kalkar; değilse kök.
      const onPathClick = (path: string[], additive: boolean) => {
        if (!path.length) return;
        if (!additive) {
          const i = primaryId ? path.indexOf(primaryId) : -1;
          if (i < 0) setDoorNodeSel({ id: g.id, nodes: [path[0]] });
          else if (i >= path.length - 1) setDoorNodeSel(null);
          else setDoorNodeSel({ id: g.id, nodes: [path[i + 1]] });
          return;
        }
        // Shift/Ctrl: seçili düğümle AYNI seviyedeki bölge eklenir / çıkarılır (seçim yoksa kapak).
        const depth = primaryId ? (findSolvedNode(solvedTree, primaryId)?.depth ?? path.length - 1) : path.length - 1;
        const node = path[Math.min(depth, path.length - 1)];
        const next = picked.includes(node) ? picked.filter(x => x !== node) : [...picked, node];
        setDoorNodeSel(next.length ? { id: g.id, nodes: next } : null);
      };
      // Tip uygulandı → seçim kalkar (Goker: "tip girdikten sonra kapak seçimlerini kaldır").
      const applyType = (t: DoorType) => { void setDoorLeafTypes(g.id, typeTargets, t); setDoorNodeSel(null); };
      // BÖLME SAYILARI: seçili bölge (boşsa kök alan); eksen başına parça sayısı — 1 = o eksende bölünmemiş.
      const splitNode = primary ?? g.tree;
      const countOf = (ax: 'u' | 'v') => (splitNode.kind === 'split' && splitNode.axis === ax ? splitNode.children.length : 1);
      const setCount = (ax: 'u' | 'v', n: number) => {
        const targets = picked.length ? picked : [g.tree.id];
        const ids = targets.map(id => setDoorNodeSplit(g.id, id, ax, n)).filter((x): x is string => !!x);
        setDoorNodeSel(ids.length ? { id: g.id, nodes: ids } : null);   // sonuç bölge seçili kalır (ardışık ayar)
      };
      // BÖLME MODU: Count · Panel ref (store bayrağı) · Spacing.
      const refMode = doorRefPickGroupId === g.id;
      const splitMode: 'count' | 'ref' | 'spacing' = refMode ? 'ref' : doorSplitMode?.id === g.id ? doorSplitMode.mode : 'count';
      const pickSplitMode = (m: 'count' | 'ref' | 'spacing') => {
        if (m === 'ref') { setDoorAddPick(null); setDoorRefPickGroupId(g.id); return; }
        if (refMode) setDoorRefPickGroupId(null);
        setDoorSplitMode({ id: g.id, mode: m });
      };
      // ARAYA RAF / DİKME: düğme modu açar (panel ref kapanır); derze tık → grup oluşur (listede kapaktan sonra), mod kapanır.
      const addPick = doorAddPick?.id === g.id ? doorAddPick.axis : null;
      const toggleAddPick = (axis: 'u' | 'v') => { if (addPick === axis) setDoorAddPick(null); else { if (refMode) setDoorRefPickGroupId(null); setDoorAddPick({ id: g.id, axis }); } };
      // Tık → tıklanan parça; Shift/Ctrl+tık → derzin boş parçalarının hepsine (Goker: "2 dikme arasındaki 3 bölüme de ayrı ayrı raf").
      // YENİ SATIR: her parça kendi grubu (= listede kendi kartı, KAPALI). Kart otomatik AÇILMAZ, grup seçilmez (Goker, Eki 2026:
      // "dikme ve raf atınca otomatik onun panelini açıyor; düzenlemek istediğimde kendim açayım, otomatik açmasın") — önceki
      // "yeni satırı aç ve seç" davranışı geri alındı. Kapak kartı seçili ve açık kalır, mod kapanır.
      const onAddPick = (splitId: string, k: number, ats: number[]) => {
        const made = ats.map(at => addPanelAtDoorJoint(g.id, splitId, k, at)).filter((pg): pg is PanelGroup => !!pg);
        if (!made.length) return;
        setDoorAddPick(null);
        setSelectedDoorGroupId(g.id);
        openCard(g.id);
        console.log('[YAGO][KAPAK-ARA] yeni satır(lar) eklendi (kapalı):', made.map(pg => `${pg.kind}:${pg.id}`).join(', '));
      };
      // SİL (Goker: "tıklayıp dikme veya raf atarsam sonradan silebileyim"): aynı modda mevcut levhanın bandı ✕ Remove → grup + panel silinir.
      const onRemovePick = (pgId: string) => { deletePanelGroupWithMembers(pgId); console.log('[YAGO][KAPAK-ARA] levha kaldırıldı (kapak kartı):', pgId); };
      const addedCount = (axis: 'u' | 'v') => panelGroups.filter(pg => pg.doorBond?.doorGroupId === g.id && pg.axis === (axis === 'u' ? doorPlaneAxes(g.axis).u : doorPlaneAxes(g.axis).v)).length;
      const addJointCount = (axis: 'u' | 'v') => doorJoints(solvedTree).filter(j => j.axis === axis).length;
      // Şema levhaları (kapak sınırı işaretli) ve — yalnız araya ekleme modunda — derz parçalama engelleri (işaretsiz dikme/raflar da derzi keser).
      const nearPanels = doorParent ? doorNearPanels(g, doorParent, shapes, virtualFaces, panelGroups) : [];
      const addObstacles = doorParent && addPick ? doorNearPanels(g, doorParent, shapes, virtualFaces, panelGroups, undefined, true) : undefined;
      const freePartCount = addPick ? doorJointParts(doorJoints(solvedTree), addObstacles ?? nearPanels, addPick).reduce((a, p) => a + p.free.length, 0) : 0;
      // SPACING değeri: seçili bölgenin hedefi; yoksa kapsamdaki (seçili bölgeler / kök) ilk hedef — seçim değişse de değer görünür ve
      // iptal edilebilir (Goker: "yazılan değeri iptal edemiyorum"). İptal (null) kapsamdaki o eksenli TÜM hedefleri kaldırır.
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
      const regionName = !primary ? 'whole door area' : primary.kind === 'leaf' ? 'the selected door' : `the selected region (${primary.axis === 'u' ? 'V' : 'H'} ×${primary.children.length})`;
      const sizeTitle = (ax: 'u' | 'v') => `Spacing ${ax === 'u' ? 'V — target door width' : 'H — target door height'} (mm) for ${regionName}: the number of pieces is derived from the region length (nearest fit, equal pieces) and re-derived when the body resizes. Clear it (× or empty + Enter) to cancel the target — the current pieces stay.`;
      const countTitle = (ax: 'u' | 'v') => `${ax === 'u' ? 'Split V — pieces side by side' : 'Split H — pieces stacked'} in ${regionName}. ` +
        `Type or step the number of pieces (1 = not split on this axis). ${splitNode.kind === 'split' && splitNode.axis !== ax ? 'This region is already split the other way: splitting here keeps that split in every new piece (e.g. V ×2 then H ×2 = 2 rows × 2 columns).' : ''}` +
        (picked.length > 1 ? ` Applies to ${picked.length} selected regions.` : '');
      return (
        <div key={rowKey} className={rowCardClass(open, dragIndex === rowIdx, armedRowKey === rowKey)}>
          <div className={`relative flex items-stretch ${selAll ? 'bg-[#fff8ef]' : ''}`}>
            {selAll && <span className="pointer-events-none absolute left-0 top-[6px] bottom-[6px] w-[2px] rounded-r-full bg-orange-500/90" />}
            {grip(rowKey, rowIdx, 'Drag to reorder (whole group)')}
            <div onClick={toggleRow} className="flex-1 min-w-0 relative flex items-center gap-1.5 pl-0.5 pr-1 py-[4px] cursor-pointer" title={open ? 'Collapse' : 'Expand — selects all doors in this group'}>
              <RowNum label={label} active={selAll} />
              <RowTypeBadge kind="door" active={open} count={doorMemberCount(g)} />
              <input type="text" value={doorGroupName(g)} onClick={stop} onChange={e => renameDoorGroup(g.id, e.target.value)} placeholder="Door"
                title="Group name (applies to all its doors)" className={`${ROW_INPUT_CLASS} font-semibold`} />
              <RowDims w={dimsW} h={dimsH} t={g.thickness} tLetter="T" title={`Door area width · height · thickness (${doorPlacementLabel(g.placement)} door)`} />
              <div className="flex items-center justify-end gap-[3px] shrink-0 ml-0.5" style={{ width: ROW_TRAIL_W }} onClick={stop}>
                <button onClick={e => { stop(e); deleteDoorGroupWithMembers(g.id); }} title="Delete group (all doors)" className={ROW_DEL_CLASS}><Trash2 size={ROW_ICON - 1} strokeWidth={1.9} /></button>
                <RowChevron open={open} onClick={toggleRow} />
              </div>
            </div>
          </div>
          {open && (
            <div className="yago-expand px-2 pt-2 pb-2" style={{ borderTop: '1px solid #f3e6d6', fontFamily: UI_FONT }} onClick={stop}>
              {/* TEK SATIR (Goker, Eki 2026: "gereksiz yükseklikten alan kaybedilmiş, alanı iyi kullanalım"): dış/iç · kalınlık ·
                  BÖLME MODU (açılır liste: Count / Panel ref / Spacing) · seçili bölgenin V / H alanı · eşitle.
                  Count: parça sayısı (yazılır; ↑↓ ile adım). Panel ref: 3B'de ya da şemada bir kapak-sınırı dikme/rafa tıkla → kapak
                  onun ortasından bölünür, DERZ LEVHAYA BAĞLANIR (levha taşınınca kapak izler — Goker: "dikmenin arası değişince kapak
                  kendini ona göre güncellesin"; rozetle Left/Center/Right LEVHAYI taşır, kapak yerinde). Spacing: hedef parça ölçüsü (mm). */}
              <div className="flex items-center gap-1 mb-1.5">
                <PlacementSelect value={g.placement} onChange={v => { void setDoorPlacement(g.id, v); }} />
                <FieldBox fixed label="T" title="Door thickness (mm)">{numInput('t', g.thickness)}{unitTxt('mm')}</FieldBox>
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
                  <div className="flex-1 min-w-0"><DockStatus ready text="Pick a divider / shelf" title="Door-reference dividers and shelves glow amber in the 3D view (doors go transparent); click one in the 3D view or its band in the schematic. The door splits through the panel's middle and the joint is bound to the panel: when the panel moves, the doors follow (Left / Center / Right moves the panel under the joint). Esc / another mode cancels." /></div>
                )}
                <IconSquareBtn icon={Equal} title="Equalize sizes (unlock all)" onClick={() => { void equalizeDoorGroup(g.id); }} />
              </div>
              {/* KAPAKLARIN ARASINA RAF / DİKME (Goker, Eki 2026: "2 düğme daha koy: raf ekle ve dikme ekle; basınca 2 kapak arası
                  belirginleşsin; genel listeye door satırından sonra eklensin; eklenen raf ve dikme hep o kapak aralarının arasında
                  çalışsın"): Divider = V derzleri, Shelf = H derzleri; şemadaki derze tık → derze bağlı yeni grup (levha kapağı izler). */}
              <div className="flex items-center gap-1 mb-1.5">
                <span className="shrink-0 pl-0.5 pr-1 text-[9.5px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]">Between doors</span>
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
              {/* KAPAK TİPİ (Goker, Eki 2026): Left · Right · Up · Down · Double · Fold — hedef: şemada seçilen kapaklar. */}
              <DoorTypeBar value={commonType} hint={typeHint} onPick={applyType} />
              <DoorSchematic group={g} selectedIndex={selMemberIdx} selectedNodes={picked}
                memberLabels={g.memberVfIds.map((id, i) => { const mi = members.findIndex(m => m.id === id); return `${label}.${(mi >= 0 ? mi : i) + 1}`; })}
                cuts={doorCuts}
                nearPanels={nearPanels} addObstacles={addObstacles}
                refPick={refMode} onRefPick={onRefPick}
                addPick={addPick} onAddPick={onAddPick} onRemovePick={onRemovePick}
                onEditSize={(sid, k, v, pv) => { void editDoorSize(g.id, sid, k, v, { preview: pv }); }} onToggleLock={(sid, k) => toggleDoorSizeLock(g.id, sid, k)}
                onEditSplitGap={(sid, k, v, pv) => { void setDoorSplitGap(g.id, sid, k, v, { preview: pv }); }} onEditEdgeGap={(edge, v, pv) => { void setDoorEdgeGap(g.id, edge, v, { preview: pv }); }}
                onEditLeaf={(lid, k, v, pv) => { void editDoorLeafSize(g.id, lid, k, v, { preview: pv }); }} onEditLeafGap={(lid, v, pv) => { void setDoorLeafGap(g.id, lid, v, { preview: pv }); }}
                onEditBegin={() => doorLayoutSnapshot(g.id)} onEditCancel={snap => restoreDoorLayout(g.id, snap as DoorLayoutSnap | null)}
                onToggleHalfOverlay={(edge, on) => { void setDoorHalfOverlay(g.id, edge, on); }}
                onAlignJoint={(sid, k, vfId, a) => { void setDoorJointRef(g.id, sid, k, vfId, a); }}
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

    // Liste her zaman TAM çizilir (odak modu kaldırıldı).
    const elements: React.ReactNode[] = [];
    rows.forEach((row, rowIdx) => {
      const draggingThis = dragIndex === rowIdx, dropHere = dropIndex === rowIdx;
      const label = String(rowIdx + 1);
      elements.push(
        <div key={`wrap-${rowKeyOf(row)}`} className={dropHere ? 'rounded-[10px] ring-1 ring-amber-300 bg-[#fffbf0]' : ''}
          onDragOver={e => { if (dragIndex !== null && !draggingThis) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropIndex !== rowIdx) setDropIndex(rowIdx); } }}
          onDrop={e => { e.preventDefault(); if (dragIndex !== null) void onRowDropBelow(dragIndex, rowIdx); }}>
          {row.kind === 'vf' ? vfRow(row.vf, rowIdx, label, {}) : row.kind === 'door' ? doorCard(row.group, row.members, rowIdx, label) : groupCard(row.group, row.members, rowIdx, label)}
        </div>
      );
      // YERLEŞİM GÖSTERGESİ: sürüklenen öğe TAM BURAYA (bu satırın altına) yerleşecek.
      if (dropHere && !draggingThis) elements.push(<div key={`${rowKeyOf(row)}-drop-ind`} className={`${DROP_BAND} -my-0.5`} />);
    });
    // En ÜSTE taşıma: listenin başında, sürükleme sırasında aktifleşen ince bir
    // tutma alanı; üzerine gelinince diğerleriyle aynı stilde turuncu bant görünür.
    if (dragIndex !== null && dragIndex !== 0 && rows.length > 0) {
      elements.unshift(
        <div key="drop-top" className="h-4 -mb-1 flex items-center"
          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropIndex !== -2) setDropIndex(-2); }}
          onDrop={e => { e.preventDefault(); if (dragIndex !== null) void doReorder(idsOf(rows[dragIndex]), idsOf(rows[0])[0]); }}>
          {dropIndex === -2 && <div className={`${DROP_BAND} w-full`} />}
        </div>
      );
    }
    return elements;
  };

  /* ── YERLEŞTİRME ŞERİDİ (ortak): Body Panel / Shelf / Divider / Door ─────────────────
     Goker (Eki 2026): "paneli yüzey seçerken isim yazabileyim; kapakta inner/outer panel atmadan
     önce seçilsin — divider yerleştirirken de aynısını yapıyordum". Şerit, yerleştirme ÖNCESİ
     kararları toplar: (üstte) seçenekler — kapakta Outer/Inner; (1. satır) tür etiketi + AD girişi
     + ✓ / ✕; (2. satır) durum. Ad boşsa varsayılan ad (Panel / Shelf / Divider / Door). Ad girişinde
     Enter = onay (sahnede sağ tıkla aynı), Esc = moddan çık. Yeniden seçimde (Relocate) ad yok. */
  const placementDock = ({ tag, defaultName, showName = true, ready, status, onConfirm, onExit, confirmTitle, lead }: {
    tag: string; defaultName: string; showName?: boolean; ready: boolean; status: string;
    onConfirm: () => void; onExit: () => void; confirmTitle: string; lead?: React.ReactNode;
  }) => (
    <div style={{ ...DOCK_SHELL, marginTop: 0, borderRadius: 0, border: 'none', borderBottom: '1px solid #ebe5dc', boxShadow: 'none', background: 'linear-gradient(180deg,#fefdfb 0%,#faf8f4 100%)' }}>
      <div style={DOCK_ROW}>
        <span style={dockAxisTag('#44403c')}>{tag}</span>
        {lead}
        {/* Ad kutusu etiketsiz (Goker: "name yazmasın, isim girme alanı olduğu zaten belli"); varsayılan ad placeholder'da. */}
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

  /* Body Panel: yüz yakalama — önizlenen VF şeritte ✓ ile de onaylanır. */
  const raycastDock = (() => {
    if (!raycastMode) return null;
    const ready = !!selectedShape && !!raycastPendingVf;
    return placementDock({
      tag: 'PANEL', defaultName: 'Panel', ready,
      status: !selectedShape ? 'Select a body first' : ready ? 'Face selected — click again for the next region · right-click: place' : 'Click a body face in the 3D view',
      onConfirm: () => confirmBodyPanelPlacement(useAppStore.getState().raycastPendingVf),
      onExit: () => setRaycastMode(false), confirmTitle: 'Place panel',
    });
  })();

  /* Raf / dikme: hacim seçimi (Relocate'te ad girişi yok). */
  const volumePickDock = (() => {
    if (!volumePickMode) return null;
    const n = volumePickCandidates.length;
    const ready = !!selectedShape && n > 0;
    // Adaylar: en kapsayıcı (şekilli bölge) → içeri doğru düz kutular; etiket türü söyler.
    const cur = volumePickCandidates[volumePickIndex];
    // YENİDEN SEÇİM: taşınan grup (kartındaki Relocate) — etiket ve onay buna göre.
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

  /* Kapak: dış / iç seçimi YERLEŞTİRMEDEN ÖNCE (aynı satırda açılır liste) + ad. */
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
      // TEK SATIR (Goker: "kapak yerleştirmedeki düğmeler tek satır; inner/outer açılır liste"): DOOR · Outer▾ · ad · ✓ · ✕
      lead: <PlacementSelect value={doorPickPlacement} onChange={setDoorPickPlacement} />,
      onConfirm: () => { if (ready && selectedShape) confirmDoorPick(selectedShape.id, doorPickCandidates[doorPickIndex]); },
      onExit: () => setDoorPickMode(false), confirmTitle: 'Place door',
    });
  })();

  return (
    <div className="flex flex-col h-full min-h-0">
      <style>{LIST_CSS}</style>
      <div className="px-3 py-2 border-b border-stone-100 flex items-center justify-between shrink-0">{panelToolbar}</div>
      {raycastDock}
      {volumePickDock}
      {doorPickDock}
      {selectedShape ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-1.5 pt-1.5 pb-2 space-y-[2px]">{renderFaceList()}</div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center"><div className="text-center text-stone-400 text-xs py-4">No shape selected</div></div>
      )}
    </div>
  );
}
