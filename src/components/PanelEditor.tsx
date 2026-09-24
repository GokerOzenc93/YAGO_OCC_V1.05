import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, GripVertical, ArrowUp, RotateCw, Move, Trash2, MoveVertical, Check, Pencil, ChevronRight, Lock, SlidersHorizontal, Crosshair } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '../store';
import { extractFacesFromGeometry, groupCoplanarFaces, CoplanarFaceGroup } from './FaceEditor';
import { findExistingStepForFace } from './FaceExtrudeService';
import type { FilletData } from './Fillet';
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

const AXIS_ORDER: Record<string, number> = { 'x+': 0, 'x-': 1, 'y+': 2, 'y-': 3, 'z+': 4, 'z-': 5 };
const PANEL_THICKNESS = 18;
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
const r1 = (v: number) => Math.round(v * 10) / 10;

function getAxisDir(n: THREE.Vector3): string | null {
  const t = 0.95;
  if (n.x > t) return 'x+'; if (n.x < -t) return 'x-';
  if (n.y > t) return 'y+'; if (n.y < -t) return 'y-';
  if (n.z > t) return 'z+'; if (n.z < -t) return 'z-';
  return null;
}

function geoAxes(geo: THREE.BufferGeometry) {
  const pos = geo.getAttribute('position');
  if (!pos) return null;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const size = new THREE.Vector3(); bbox.getSize(size);
  const axes = [{ i: 0, v: size.x }, { i: 1, v: size.y }, { i: 2, v: size.z }].sort((a, b) => a.v - b.v);
  return { axes, size, bbox };
}

function computeCuttingPlanes(mainBbox: THREE.Box3, subs: any[]) {
  const planes: Array<{ normal: THREE.Vector3; constant: number; si: number }> = [];
  subs.forEach((sub, si) => {
    if (!sub?.geometry) return;
    const sb = new THREE.Box3().setFromBufferAttribute(sub.geometry.getAttribute('position'));
    const off = new THREE.Vector3(...sub.relativeOffset);
    const rot = sub.relativeRotation;
    const rm = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
    const corners = [
      [sb.min.x,sb.min.y,sb.min.z],[sb.max.x,sb.min.y,sb.min.z],[sb.min.x,sb.max.y,sb.min.z],[sb.max.x,sb.max.y,sb.min.z],
      [sb.min.x,sb.min.y,sb.max.z],[sb.max.x,sb.min.y,sb.max.z],[sb.min.x,sb.max.y,sb.max.z],[sb.max.x,sb.max.y,sb.max.z],
    ].map(([x,y,z]) => new THREE.Vector3(x,y,z).applyMatrix4(rm).add(off));
    const wb = new THREE.Box3().setFromPoints(corners);
    const normals = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].map(([x,y,z]) => new THREE.Vector3(x,y,z));
    const consts = [-wb.max.x, wb.min.x, -wb.max.y, wb.min.y, -wb.max.z, wb.min.z];
    const positions = [wb.max.x, wb.min.x, wb.max.y, wb.min.y, wb.max.z, wb.min.z];
    for (let pi = 0; pi < 6; pi++) {
      const ax = Math.floor(pi / 2);
      const mn = ax === 0 ? mainBbox.min.x : ax === 1 ? mainBbox.min.y : mainBbox.min.z;
      const mx = ax === 0 ? mainBbox.max.x : ax === 1 ? mainBbox.max.y : mainBbox.max.z;
      if (positions[pi] > mn + 1.0 && positions[pi] < mx - 1.0)
        planes.push({ normal: normals[pi], constant: consts[pi], si });
    }
  });
  return planes;
}

function isFilletFace(group: CoplanarFaceGroup, fillet: FilletData): boolean {
  const tol = Math.max(fillet.radius * 2.0, 10);
  const n1 = new THREE.Vector3(...fillet.face1Data.normal), n2 = new THREE.Vector3(...fillet.face2Data.normal);
  const d1 = fillet.face1Data.planeD ?? n1.dot(new THREE.Vector3(...fillet.face1Data.center));
  const d2 = fillet.face2Data.planeD ?? n2.dot(new THREE.Vector3(...fillet.face2Data.center));
  return Math.abs(n1.dot(group.center) - d1) < tol && Math.abs(n2.dot(group.center) - d2) < tol;
}

function classifyFaceGroups(groups: CoplanarFaceGroup[], fillets: FilletData[], planes: ReturnType<typeof computeCuttingPlanes>) {
  const axis = new Map<string, number[]>(), subs = new Map<number, number[]>(), fills = new Map<number, number[]>();
  groups.forEach((g, gi) => {
    const dir = getAxisDir(g.normal);
    if (!dir) {
      for (let fi = 0; fi < fillets.length; fi++)
        if (isFilletFace(g, fillets[fi])) { if (!fills.has(fi)) fills.set(fi, []); fills.get(fi)!.push(gi); return; }
      return;
    }
    for (const p of planes)
      if (Math.abs(g.normal.dot(p.normal)) >= 0.95 && Math.abs(g.center.dot(p.normal) + p.constant) < 1.0) {
        if (!subs.has(p.si)) subs.set(p.si, []); subs.get(p.si)!.push(gi); return;
      }
    if (!axis.has(dir)) axis.set(dir, []); axis.get(dir)!.push(gi);
  });
  return { axis, subs, fills };
}

const findVPanel = (shapes: any[], pid: string, vfId: string) => shapes.find(s => s.type === 'panel' && s.parameters?.parentShapeId === pid && s.parameters?.virtualFaceId === vfId);

function makePanelBase(shape: any, extra: Record<string, any>) {
  return { id: genId(extra.parameters?.virtualFaceId ? 'panel-vf' : 'panel'), type: 'panel' as const,
    position: [...shape.position] as [number,number,number], rotation: shape.rotation, scale: [...shape.scale] as [number,number,number], color: '#ffffff', ...extra };
}

/** BÖLGE KİMLİĞİ: tıklama noktasının (vf.center) yüz konturu bbox'ındaki
 *  u/v ORANI. Panele yazılır ve rebuild her seferinde güncel konturdan
 *  mutlaklaştırır — kimlik hiçbir VF regen/eşleşme katmanından geçmez,
 *  resize'da oransal (parametrik) taşınır. */
function computeRegionUV(vf: any): [number, number] | undefined {
  try {
    const n = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    const u = az >= ax && az >= ay ? new THREE.Vector3(1, 0, 0)
      : ax >= ay ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const v = new THREE.Vector3().crossVectors(n, u).normalize();
    u.crossVectors(v, n).normalize();
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const [x, y, z] of vf.vertices) {
      const p3 = new THREE.Vector3(x, y, z);
      const pu = p3.dot(u), pv = p3.dot(v);
      uMin = Math.min(uMin, pu); uMax = Math.max(uMax, pu);
      vMin = Math.min(vMin, pv); vMax = Math.max(vMax, pv);
    }
    const c = new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]);
    const uSpan = Math.max(uMax - uMin, 1e-6), vSpan = Math.max(vMax - vMin, 1e-6);
    return [
      Math.max(0, Math.min(1, (c.dot(u) - uMin) / uSpan)),
      Math.max(0, Math.min(1, (c.dot(v) - vMin) / vSpan)),
    ];
  } catch { return undefined; }
}

function getDimsFromGeo(geo: THREE.BufferGeometry, arrowRotated?: boolean, panelThickness?: number) {
  const r = geoAxes(geo); if (!r) return null;
  const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
  const [def, alt] = [pa[0], pa[1]];
  const target = arrowRotated ? alt : def, secondary = pa.find(a => a !== target) ?? pa[0], s = [r.size.x, r.size.y, r.size.z];
  // KALINLIK: panelThickness parametresinden alınır — geometrinin eksen-hizalı
  // bbox'ından DEĞİL. Dönmüş panelde bbox eğik olduğundan en küçük boyut bile
  // gerçek kalınlıktan (18) çok büyük çıkıyordu (ör. 145.9). Parametre her zaman
  // doğru kalınlığı tutar; yoksa (eski panel) bbox'a düşülür.
  const thickness = (panelThickness != null && panelThickness > 0)
    ? r1(panelThickness)
    : r1(s[r.axes[0].i]);
  return { primary: r1(s[target]), secondary: r1(s[secondary]), thickness, w: r1(r.size.x), h: r1(r.size.y), d: r1(r.size.z) };
}

type Dims = NonNullable<ReturnType<typeof getDimsFromGeo>>;
interface PanelEditorProps { isOpen: boolean; onClose: () => void; embedded?: boolean; }
type Pt = { x: number; y: number };

// Project a 3D point to canvas pixel coordinates via the preview camera
function project3D(p: THREE.Vector3, camera: THREE.OrthographicCamera, w: number, h: number): Pt {
  const ndc = p.clone().project(camera);
  return { x: (ndc.x + 1) / 2 * w, y: (1 - ndc.y) / 2 * h };
}

/* ── Cut (subtraction) dimension geometry ────────────────────────────── */
// Each cut yields two dimensions (width + height). Each is offset just outside
// one cut edge toward the nearer panel edge, so the two lines never cross.
function cutBoxToDims(
  mn0: number, mx0: number, mn1: number, mx1: number, topVal: number,
  p0: number, p1: number, thinAxis: number,
  pMin0: number, pMax0: number, pMin1: number, pMax1: number, gap: number,
): GroundDimWorld[] {
  const mk = (v0: number, v1: number) => { const p = new THREE.Vector3(); p.setComponent(p0, v0); p.setComponent(p1, v1); p.setComponent(thinAxis, topVal); return p; };
  const w0 = mx0 - mn0, w1 = mx1 - mn1;
  const dims: GroundDimWorld[] = [];
  if (w0 > 0.5) {
    const nearMin1 = (mn1 - pMin1) <= (pMax1 - mx1);
    const hEdge = nearMin1 ? mn1 : mx1, hOff = nearMin1 ? hEdge - gap : hEdge + gap;
    dims.push({ fa: mk(mn0, hEdge), fb: mk(mx0, hEdge), da: mk(mn0, hOff), db: mk(mx0, hOff), length: Math.round(w0) });
  }
  if (w1 > 0.5) {
    const nearMin0 = (mn0 - pMin0) <= (pMax0 - mx0);
    const wEdge = nearMin0 ? mn0 : mx0, wOff = nearMin0 ? wEdge - gap : wEdge + gap;
    dims.push({ fa: mk(wEdge, mn1), fb: mk(wEdge, mx1), da: mk(wOff, mn1), db: mk(wOff, mx1), length: Math.round(w1) });
  }
  return dims;
}

// Cut dims from explicit subtraction tools, placed on the panel top face.
function cutDimsFromSubGeos(
  subGeos: any[], panelBbox: THREE.Box3, panelSize: THREE.Vector3, thinAxis: number, nDir: THREE.Vector3,
): GroundDimWorld[] {
  const keys = ['x', 'y', 'z'] as const;
  const thinKey = keys[thinAxis];
  const planar = [0, 1, 2].filter(i => i !== thinAxis);
  const p0 = planar[0], p1 = planar[1], k0 = keys[p0], k1 = keys[p1];
  const topVal = nDir.getComponent(thinAxis) > 0 ? panelBbox.max[thinKey] : panelBbox.min[thinKey];
  const span0 = panelSize.getComponent(p0), span1 = panelSize.getComponent(p1);
  const gap = Math.min(span0, span1) * 0.045;
  const out: GroundDimWorld[] = [];
  const v = new THREE.Vector3();
  subGeos.forEach(sg => {
    if (!sg?.geometry) return;
    const pos = sg.geometry.getAttribute('position'); if (!pos) return;
    const rot = sg.relativeRotation || [0, 0, 0];
    const rotM = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
    const off = new THREE.Vector3(...((sg.relativeOffset || [0, 0, 0]) as number[]));
    let mn0 = Infinity, mx0 = -Infinity, mn1 = Infinity, mx1 = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(rotM).add(off);
      const c0 = v.getComponent(p0), c1 = v.getComponent(p1);
      mn0 = Math.min(mn0, c0); mx0 = Math.max(mx0, c0); mn1 = Math.min(mn1, c1); mx1 = Math.max(mx1, c1);
    }
    mn0 = Math.max(mn0, panelBbox.min[k0]); mx0 = Math.min(mx0, panelBbox.max[k0]);
    mn1 = Math.max(mn1, panelBbox.min[k1]); mx1 = Math.min(mx1, panelBbox.max[k1]);
    out.push(...cutBoxToDims(mn0, mx0, mn1, mx1, topVal, p0, p1, thinAxis, panelBbox.min[k0], panelBbox.max[k0], panelBbox.min[k1], panelBbox.max[k1], gap));
  });
  return out;
}

// Cut dims from interior top-face edges (cuts baked into the mesh).
function computeCutDimsWorld(
  geometry: THREE.BufferGeometry, thinAxis: number, nDir: THREE.Vector3,
): GroundDimWorld[] {
  const eg = new THREE.EdgesGeometry(geometry, 15);
  const pos = eg.getAttribute('position');
  if (!pos) { eg.dispose(); return []; }
  const keys = ['x', 'y', 'z'] as const;
  const thinKey = keys[thinAxis];
  const planar = [0, 1, 2].filter(i => i !== thinAxis);
  const p0 = planar[0], p1 = planar[1], k0 = keys[p0], k1 = keys[p1];
  const bbox = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const topVal = nDir.getComponent(thinAxis) > 0 ? bbox.max[thinKey] : bbox.min[thinKey];
  const thinExt = bbox.max[thinKey] - bbox.min[thinKey];
  const tolT = Math.max(thinExt * 0.15, 0.6);
  const span0 = bbox.max[k0] - bbox.min[k0], span1 = bbox.max[k1] - bbox.min[k1];
  const tolE = Math.max(Math.min(span0, span1) * 0.01, 0.4);
  const minLen = Math.max(Math.min(span0, span1) * 0.03, 4);
  const gap = Math.min(span0, span1) * 0.045;
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
    if (onLine(a0, b0, bbox.min[k0]) || onLine(a0, b0, bbox.max[k0]) ||
        onLine(a1, b1, bbox.min[k1]) || onLine(a1, b1, bbox.max[k1])) continue;
    if (Math.hypot(b0 - a0, b1 - a1) < minLen) continue;
    segs.push({ a0, a1, b0, b1 });
  }
  eg.dispose();
  if (!segs.length) return [];

  const qstep = Math.max(tolE * 2, 0.8);
  const q = (val: number) => Math.round(val / qstep);
  const parent = segs.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const ptMap = new Map<string, number>();
  segs.forEach((s, i) => {
    [[s.a0, s.a1], [s.b0, s.b1]].forEach(([x, y]) => {
      const kk = q(x) + ',' + q(y);
      if (ptMap.has(kk)) union(i, ptMap.get(kk)!); else ptMap.set(kk, i);
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
    const dd = cutBoxToDims(mn0, mx0, mn1, mx1, topVal, p0, p1, thinAxis, bbox.min[k0], bbox.max[k0], bbox.min[k1], bbox.max[k1], gap);
    out.push(...dd); count += dd.length;
  });
  return out;
}

/* ── Ground-plane dimension lines ─────────────────────────────────────
   Width (along the width axis) sits on the +height ground edge (back); depth
   (along the height axis) sits on the +width ground edge (right). Both are
   anchored to the panel's own frame, so they don't flicker as the camera
   orbits. Thickness is shown separately as an info chip, not a dimension. */
interface GroundDimWorld { fa: THREE.Vector3; fb: THREE.Vector3; da: THREE.Vector3; db: THREE.Vector3; length: number; }

function computeGroundDimWorld(
  geometry: THREE.BufferGeometry,
  wIdx: number, hIdx: number, thinAxis: number, up: THREE.Vector3,
): GroundDimWorld[] {
  const pos = geometry.getAttribute('position');
  if (!pos) return [];
  const bbox = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const size = new THREE.Vector3(); bbox.getSize(size);
  const cen = new THREE.Vector3(); bbox.getCenter(cen);
  const keys = ['x', 'y', 'z'] as const;
  const wKey = keys[wIdx], hKey = keys[hIdx], thinKey = keys[thinAxis];

  const vOf = (v: THREE.Vector3) => v.dot(up);
  const cMax = cen.clone(); cMax.setComponent(thinAxis, bbox.max[thinKey]);
  const cMin = cen.clone(); cMin.setComponent(thinAxis, bbox.min[thinKey]);
  const groundVal = vOf(cMin) <= vOf(cMax) ? bbox.min[thinKey] : bbox.max[thinKey];

  const wExt = size.getComponent(wIdx), hExt = size.getComponent(hIdx);
  const gOff = Math.max(wExt, hExt) * 0.16;
  const mk = (wv: number, hv: number) => {
    const p = new THREE.Vector3();
    p.setComponent(wIdx, wv); p.setComponent(hIdx, hv); p.setComponent(thinAxis, groundVal);
    return p;
  };

  const dims: GroundDimWorld[] = [];
  // width (wAxis extent) on +height ground edge
  {
    const he = bbox.max[hKey], off = he + gOff;
    dims.push({ fa: mk(bbox.min[wKey], he), fb: mk(bbox.max[wKey], he), da: mk(bbox.min[wKey], off), db: mk(bbox.max[wKey], off), length: Math.round(wExt) });
  }
  // depth (hAxis extent) on +width ground edge
  {
    const we = bbox.max[wKey], off = we + gOff;
    dims.push({ fa: mk(we, bbox.min[hKey]), fb: mk(we, bbox.max[hKey]), da: mk(off, bbox.min[hKey]), db: mk(off, bbox.max[hKey]), length: Math.round(hExt) });
  }
  return dims;
}

interface GroundRender { fa: Pt; fb: Pt; da: Pt; db: Pt; cx: number; cy: number; value: number; }

/* ── DOCK / İÇ PANEL TASARIM DİLİ (soft, minimal — liste satırlarıyla aynı) ──
   Taşı / Döndür / Extrude şeritleri ve işlem adımları bu ortak tokenları
   kullanır: sıcak kemik zemin, kıl-çizgi kenar, düz yüzeyler, gradyan yok.
   Etkin segment KOYU TAŞ dolgudur (fildişi-üstüne-fildişi okunmuyordu —
   aktif mod net seçilsin kuralı korunur). */
const DOCK_FONT = "'Inter','SF Pro Text',system-ui,sans-serif";
/* ── ÖNİZLEME GÖRÜNÜMÜ (sade, profesyonel) ─────────────────────────────────
   Zemin: neredeyse beyaz, çok hafif sıcak dikey geçiş (desen/vinyet yok).
   Panel: açık huş/beyaz laminat tonu. three r155+ fiziksel ışık ölçeğinde eski
   düşük şiddetler paneli kirli griye çekiyordu; şiddetler yüzü açık, kalınlık
   kenarını bir ton koyu verecek şekilde yeniden ayarlandı. */
const PREVIEW_BG = 'linear-gradient(180deg,#fcfbf9 0%,#f5f3ef 100%)';
const PREVIEW_PANEL_COLOR = 0xe9e1d3;
const PREVIEW_EDGE_COLOR = 0x8a8278;
const PREVIEW_LIGHT = { hemi: 1.0, ambient: 0.3, key: 1.9, fill: 0.55 };
// ŞERİT ARTIK ÖNİZLEMENİN ÜSTÜNE BİNMEZ (Goker: "mod düğmeleri panel
// görünümünün içine geçiyordu"): eskiden önizleme kutusunun içinde absolute
// konumlanıp çizimin alt kısmını örtüyordu; şimdi önizlemenin hemen ALTINDA,
// akış içinde duran ayrı bir karttır.
const DOCK_SHELL: React.CSSProperties = {
  position: 'relative', marginTop: 6, borderRadius: 10,
  background: '#fdfcfa',
  border: '1px solid #ebe5dc',
  boxShadow: '0 1px 2px rgba(40,30,20,0.04)',
  display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: DOCK_FONT,
};
const DOCK_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, padding: '5px 6px 6px' };
const dockStatus = (ready = false): React.CSSProperties => ({
  flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7, height: 26, padding: '0 9px', borderRadius: 7,
  background: ready ? 'rgba(22,163,74,0.07)' : '#f5f2ec',
  border: ready ? '1px solid rgba(22,163,74,0.22)' : '1px solid transparent',
});
const dockDot = (color: string): React.CSSProperties => ({ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0 });
const dockStatusText = (ready = false): React.CSSProperties => ({
  fontSize: 11, fontWeight: 500, color: ready ? '#15803d' : '#78716c', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
});
const DOCK_INPUT: React.CSSProperties = {
  flex: 1, minWidth: 0, height: 26, textAlign: 'center',
  fontFamily: "'SF Mono',ui-monospace,Menlo,monospace", fontSize: 12.5, fontWeight: 500, fontVariantNumeric: 'tabular-nums',
  color: '#1c1917', background: '#ffffff', border: '1px solid #e6e0d6', borderRadius: 7, outline: 'none',
  boxShadow: '0 1px 0 rgba(40,30,20,0.02)',
};
const dockApplyBtn = (enabled: boolean): React.CSSProperties => ({
  flexShrink: 0, width: 30, height: 26, borderRadius: 7, border: 'none', outline: 'none',
  cursor: enabled ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: enabled ? '#44403c' : '#ebe6de', color: enabled ? '#ffffff' : '#b5ada3',
  boxShadow: enabled ? '0 1px 2px rgba(40,30,20,0.22)' : 'none', transition: 'background 0.12s',
});
const DOCK_EXIT_BTN: React.CSSProperties = {
  flexShrink: 0, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 7, border: 'none', cursor: 'pointer', outline: 'none', background: 'transparent', color: '#a8a29e',
  transition: 'color 0.12s,background 0.12s',
};
const dockAxisTag = (color: string): React.CSSProperties => ({
  flexShrink: 0, fontSize: 10.5, fontWeight: 700, fontFamily: DOCK_FONT, color,
  height: 22, lineHeight: '22px', padding: '0 7px', borderRadius: 6, background: '#f5f2ec',
});

/* ── MOD ÇUBUĞU (Fixed / Dyn / Ref) ─────────────────────────────────────
   Goker: "ref / dyn / fixed düğmeleri daha anlaşılır, geniş, şık olsun."
   Mod seçimi artık şeridin ÜST satırında tam genişlikte: her düğmede ikon +
   ad + kısa Türkçe açıklama. Aktif mod koyu taş dolgu (okunurluk kuralı).
   Girdi / durum / onay ikinci satırdadır; dar tek satırda sıkışma biter. */
type DockMode = { key: string; label: string; sub: string; Icon: LucideIcon ; title?: string };
const DOCK_MODE_DEFS: Record<string, Omit<DockMode, 'key'>> = {
  fixed: { label: 'Fixed', sub: 'Sabit ölçü', Icon: Lock },
  dyn:   { label: 'Dyn',   sub: 'Dinamik',    Icon: SlidersHorizontal },
  ref:   { label: 'Ref',   sub: 'Referansa',  Icon: Crosshair },
};
function DockModeBar({ modes, active, onPick, disabled, trailing }: {
  modes: DockMode[]; active: string | null; onPick: (k: string) => void; disabled?: boolean; trailing?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 5, padding: '6px 6px 0' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: `repeat(${modes.length}, minmax(0,1fr))`, gap: 4 }}>
        {modes.map(({ key, label, sub, Icon, title }) => {
          const on = active === key;
          return (
            <button key={key} type="button" title={title || `${label} — ${sub}`} disabled={disabled}
              onClick={e => { e.stopPropagation(); if (!disabled) onPick(key); }}
              className={on ? '' : 'hover:!bg-[#faf7f2] hover:!border-[#dcd4c8]'}
              style={{
                height: 28, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: '0 8px', borderRadius: 7, outline: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
                border: on ? '1px solid #44403c' : '1px solid #e6e0d6',
                background: on ? '#44403c' : '#ffffff',
                color: on ? '#ffffff' : '#57534e',
                boxShadow: on ? '0 1px 3px rgba(40,30,20,0.22)' : '0 1px 0 rgba(40,30,20,0.03)',
                opacity: disabled ? 0.5 : 1, transition: 'background 0.14s,border-color 0.14s,color 0.14s',
                fontFamily: DOCK_FONT,
              }}>
              <Icon size={12} strokeWidth={2} style={{ flexShrink: 0 }} />
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0, lineHeight: 1 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.01em', flexShrink: 0 }}>{label}</span>
                <span style={{ fontSize: 10, fontWeight: 500, opacity: on ? 0.7 : 0.58, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{sub}</span>
              </span>
            </button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}
const dockModes = (keys: string[], overrides: Record<string, Partial<DockMode>> = {}): DockMode[] =>
  keys.map(k => ({ key: k, ...DOCK_MODE_DEFS[k], ...(overrides[k] || {}) } as DockMode));

/* ── "Yüzeyin şeklini al" — panel satırı checkbox'ı (bone/ivory) ─────────
   AÇIK: panel, yerleştiği serbest bölgenin tam şeklini alır (L/U/çentik).
   KAPALI (varsayılan): mevcut davranış — kardeş kenarında düz kesilir.      */
function FitShapeToggle({ checked, disabled, onToggle }: { checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={e => { e.stopPropagation(); if (!disabled) onToggle(); }}
      title={checked ? 'Yüzeyin şeklini al: AÇIK' : 'Yüzeyin şeklini al'}
      className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center transition-colors duration-150
        ${disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-[#f3efe8]'}`}
    >
      <span className={`w-[13px] h-[13px] rounded-[4px] flex items-center justify-center transition-all duration-150
        ${checked
          ? 'bg-orange-500 ring-1 ring-orange-500/60 shadow-[0_1px_2px_rgba(234,88,12,0.28)]'
          : 'bg-white ring-1 ring-[#dcd5ca] shadow-[inset_0_1px_1px_rgba(68,64,60,0.05)]'}`}>
        {checked && <Check size={9} strokeWidth={3.2} className="text-white" />}
      </span>
    </button>
  );
}

/* ── PAYLAŞILAN ÖNİZLEME RENDERER'I — TEK WebGL BAĞLAMI ──────────────────
   KÖK NEDEN ("çok panel seçtim, referans küp ve paneller kayboldu"):
   PanelPreview2D her mount'ta `new THREE.WebGLRenderer` ile YENİ bir WebGL
   bağlamı açıyordu ve `key={activePanel.id}` yüzünden HER PANEL SEÇİMİNDE
   yeniden mount oluyordu. Unmount'taki `renderer.dispose()` bağlamı SERBEST
   BIRAKMAZ (yalnız three kaynaklarını siler; bağlam GC'ye kadar yaşar).
   Tarayıcı aynı anda ~16 aktif WebGL bağlamına izin verir; sınır aşılınca
   EN ESKİ bağlamı öldürür — o da ana sahnenin Canvas'ıdır ("THREE.
   WebGLRenderer: Context Lost" → küp/paneller çizilmez, ama raycast CPU'da
   olduğu için tıklamalar hâlâ "çalışıyor" gibi görünür).
   ÇÖZÜM: tüm önizlemeler TEK, modül düzeyinde, ekran-dışı bir renderer'ı
   paylaşır; görüntü görünür canvas'a 2D `drawImage` ile kopyalanır. 2D
   bağlamlar WebGL sınırına sayılmaz → kaç panel seçilirse seçilsin ek WebGL
   bağlamı sayısı en fazla 1'dir. */
let _sharedPreviewRenderer: THREE.WebGLRenderer | null = null;
function getSharedPreviewRenderer(): THREE.WebGLRenderer | null {
  const cur = _sharedPreviewRenderer;
  if (cur && !cur.getContext().isContextLost()) return cur;
  if (cur) { try { cur.dispose(); } catch { /* yok say */ } _sharedPreviewRenderer = null; }
  try {
    const r = new THREE.WebGLRenderer({
      canvas: document.createElement('canvas'),
      antialias: true, alpha: true, preserveDrawingBuffer: true,
    });
    r.setClearColor(0x000000, 0);
    _sharedPreviewRenderer = r;
    console.log('[YAGO][ÖNİZLEME] paylaşılan önizleme renderer oluşturuldu (tek WebGL bağlamı)');
    return r;
  } catch (e) {
    console.error('[YAGO][ÖNİZLEME] önizleme renderer oluşturulamadı:', e);
    return null;
  }
}

/* ── Panel Preview — consistent dimetric view, orbit L/R, ground dims ── */
function PanelPreview2D({ shape, arrowRotated }: { dims: Dims; shape?: any; arrowRotated?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dimDraw, setDimDraw] = useState<{ ground: GroundRender[] }>({ ground: [] });
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const [az, setAz] = useState(22);

  const shapeRef = useRef<any>(null); shapeRef.current = shape;
  const arrowRotatedRef = useRef(arrowRotated); arrowRotatedRef.current = arrowRotated;
  const azRef = useRef(az); azRef.current = az;
  const dragRef = useRef<{ x: number; az: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    // Bu bileşen artık KENDİ WebGL bağlamını AÇMAZ (bkz. getSharedPreviewRenderer).
    let raf = 0, tries = 0;
    const measure = () => {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (w > 0 && h > 0) setCanvasSize({ w: Math.round(w), h: Math.round(h) });
      else if (++tries < 20) raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(es => {
      const { width, height } = es[0].contentRect;
      if (width > 0 && height > 0) setCanvasSize({ w: Math.round(width), h: Math.round(height) });
    });
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

    const dpr = window.devicePixelRatio;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);

    const disposables: Array<{ dispose: () => void }> = [];
    const scene = new THREE.Scene();

    const material = new THREE.MeshStandardMaterial({ color: PREVIEW_PANEL_COLOR, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide });
    disposables.push(material);
    // KLON: paylaşılan renderer, çizdiği geometrinin GPU tamponlarını kendi
    // bağlamında tutar. Sahnedeki (ana renderer'ın da kullandığı) geometri
    // doğrudan verilirse, rebuild'de değişen her panel geometrisi önizleme
    // bağlamında birikirdi. Klon çizimden sonra dispose edilir → önizleme
    // bağlamında kalıcı tampon kalmaz; ana sahnenin geometrisine dokunulmaz.
    const previewGeo = (shape.geometry as THREE.BufferGeometry).clone();
    disposables.push(previewGeo);
    scene.add(new THREE.Mesh(previewGeo, material));

    const edgesGeo = new THREE.EdgesGeometry(shape.geometry, 18);
    const lineGeo = new LineSegmentsGeometry().fromEdgesGeometry(edgesGeo);
    const lineMat = new LineMaterial({ color: PREVIEW_EDGE_COLOR, linewidth: 1.0, worldUnits: false, alphaToCoverage: true });
    lineMat.resolution.set(w, h);
    disposables.push(edgesGeo, lineGeo, lineMat);
    const panelLines = new LineSegments2(lineGeo, lineMat);
    panelLines.computeLineDistances();
    scene.add(panelLines);

    const bbox = new THREE.Box3().setFromObject(scene);
    const sz = new THREE.Vector3(), center = new THREE.Vector3();
    bbox.getSize(sz); bbox.getCenter(center);

    const dims3 = [sz.x, sz.y, sz.z];
    const minIdx = dims3.indexOf(Math.min(...dims3)); // thickness axis

    // Stable frame: width/height are tied to the planar AXES (low index = width),
    // matching getDimsFromGeo — so an extrude that changes which side is larger
    // never auto-rotates the preview. Orientation flips only via the arrow toggle.
    const planar = [0, 1, 2].filter(i => i !== minIdx).sort((a, b) => a - b);
    let wIdx = planar[0];
    let hIdx = planar[1];
    if (arrowRotated) { const t = wIdx; wIdx = hIdx; hIdx = t; }
    const wDir = new THREE.Vector3(); wDir.setComponent(wIdx, 1);
    const hDir = new THREE.Vector3(); hDir.setComponent(hIdx, 1);
    const nDir = new THREE.Vector3().crossVectors(wDir, hDir).normalize();

    const elev = THREE.MathUtils.degToRad(15);
    const azim = THREE.MathUtils.degToRad(azRef.current);
    const camOffset = new THREE.Vector3()
      .addScaledVector(nDir, Math.cos(elev) * Math.cos(azim))
      .addScaledVector(wDir, Math.cos(elev) * Math.sin(azim))
      .addScaledVector(hDir, Math.sin(elev))
      .normalize();
    const camDist = 4000;

    // Fiziksel ışık ölçeği (r155+): yüz açık laminat, kalınlık kenarı bir ton koyu.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d1c4, PREVIEW_LIGHT.hemi));
    scene.add(new THREE.AmbientLight(0xffffff, PREVIEW_LIGHT.ambient));
    const key = new THREE.DirectionalLight(0xffffff, PREVIEW_LIGHT.key);
    key.position.copy(nDir).multiplyScalar(3).addScaledVector(hDir, 2).addScaledVector(wDir, 1.4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xf4f1ec, PREVIEW_LIGHT.fill);
    fill.position.copy(nDir).addScaledVector(hDir, -1.6).addScaledVector(wDir, -2.2);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.15);
    rim.position.copy(nDir).multiplyScalar(-1).addScaledVector(hDir, 1).addScaledVector(wDir, 0.6);
    scene.add(rim);

    const aspect = w / h;
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -40000, 40000);
    camera.position.copy(center).addScaledVector(camOffset, camDist);
    camera.up.copy(hDir);
    camera.lookAt(center);
    camera.updateMatrixWorld();

    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const upW   = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);

    const dimsW = computeGroundDimWorld(shape.geometry, wIdx, hIdx, minIdx, upW);

    const subGeos = Array.isArray(shape.subtractionGeometries) ? shape.subtractionGeometries : [];
    const cutsW = subGeos.length
      ? cutDimsFromSubGeos(subGeos, bbox, sz, minIdx, nDir)
      : computeCutDimsWorld(shape.geometry, minIdx, nDir);
    const allDimsW = [...dimsW, ...cutsW];

    const allW: THREE.Vector3[] = [];
    for (const X of [bbox.min.x, bbox.max.x])
      for (const Y of [bbox.min.y, bbox.max.y])
        for (const Z of [bbox.min.z, bbox.max.z]) allW.push(new THREE.Vector3(X, Y, Z));
    allDimsW.forEach(d => { allW.push(d.fa, d.fb, d.da, d.db); });

    let maxU = 0, maxV = 0;
    allW.forEach(p => {
      const d = p.clone().sub(center);
      maxU = Math.max(maxU, Math.abs(d.dot(right)));
      maxV = Math.max(maxV, Math.abs(d.dot(upW)));
    });

    const padH = 1.06, padV = 1.06;
    const halfV = maxV * padV;
    // Şerit artık önizlemenin altında (üstüne binmez) → alt pay yalnız ölçü etiketleri için.
    const dockRoom = halfV * 0.06;
    const ratioTop = halfV, ratioBot = halfV + dockRoom;
    let vSpan = ratioTop + ratioBot;
    let halfH = (vSpan / 2) * aspect;
    const needH = maxU * padH;
    if (halfH < needH) { vSpan *= needH / halfH; halfH = needH; }
    const topB = vSpan * ratioTop / (ratioTop + ratioBot);
    const botB = vSpan * ratioBot / (ratioTop + ratioBot);
    camera.left = -halfH; camera.right = halfH; camera.top = topB; camera.bottom = -botB;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    // Cut outlines (amber) from explicit subtraction tools, if any
    subGeos.forEach((sg: any) => {
      if (!sg?.geometry) return;
      const rot = sg.relativeRotation || [0, 0, 0];
      const rotM = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
      const off = new THREE.Vector3(...((sg.relativeOffset || [0, 0, 0]) as number[]));
      const sgEdgesGeo = new THREE.EdgesGeometry(sg.geometry, 18);
      const sgLineGeo = new LineSegmentsGeometry().fromEdgesGeometry(sgEdgesGeo);
      const sgMat = new LineMaterial({ color: 0xd97706, linewidth: 1.4, worldUnits: false, alphaToCoverage: true });
      sgMat.resolution.set(w, h);
      disposables.push(sgEdgesGeo, sgLineGeo, sgMat);
      const sgLines = new LineSegments2(sgLineGeo, sgMat);
      sgLines.matrix.copy(rotM); sgLines.matrix.setPosition(off);
      sgLines.matrixAutoUpdate = false;
      scene.add(sgLines);
    });

    renderer.render(scene, camera);
    // Ekran-dışı paylaşılan renderer'ın görüntüsünü bu bileşenin görünür
    // canvas'ına kopyala (2D bağlam — WebGL bağlam sınırına sayılmaz).
    const ctx2d = canvas.getContext('2d');
    if (ctx2d) {
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      ctx2d.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height);
    }
    renderer.renderLists.dispose();

    // ── Project dimensions (outer + cuts share one style) and resolve collisions ──
    const fsG = Math.max(10, Math.min(13.5, w * 0.027));
    const boxHalf = (val: number, fs: number) => ({ hw: Math.max(String(val).length * fs * 0.62 + 12, 30) / 2, hh: (fs + 8) / 2 });
    const norm = (x: number, y: number) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };

    const screen = allDimsW.map(d => ({
      fa: project3D(d.fa, camera, w, h), fb: project3D(d.fb, camera, w, h),
      da: project3D(d.da, camera, w, h), db: project3D(d.db, camera, w, h), length: d.length,
    }));
    const items = screen.map(d => {
      const out = norm(d.da.x - d.fa.x, d.da.y - d.fa.y);
      const b = boxHalf(d.length, fsG);
      return { d, out, cx: (d.da.x + d.db.x) / 2, cy: (d.da.y + d.db.y) / 2, hw: b.hw, hh: b.hh };
    });

    const placed: Array<{ cx: number; cy: number; hw: number; hh: number }> = [];
    const pad = 4;
    const hits = (cx: number, cy: number, hw: number, hh: number) =>
      placed.some(pp => Math.abs(pp.cx - cx) < pp.hw + hw + pad && Math.abs(pp.cy - cy) < pp.hh + hh + pad);

    const ground: GroundRender[] = items.map(it => {
      let push = 0; const step = Math.max(it.hh * 2, 16); let cx = it.cx, cy = it.cy, guard = 0;
      while (hits(cx, cy, it.hw, it.hh) && guard < 12) { push += step; cx = it.cx + it.out.x * push; cy = it.cy + it.out.y * push; guard++; }
      placed.push({ cx, cy, hw: it.hw, hh: it.hh });
      return {
        fa: it.d.fa, fb: it.d.fb,
        da: { x: it.d.da.x + it.out.x * push, y: it.d.da.y + it.out.y * push },
        db: { x: it.d.db.x + it.out.x * push, y: it.d.db.y + it.out.y * push },
        cx, cy, value: it.d.length,
      };
    });

    setDimDraw({ ground });
    disposables.forEach(d => d.dispose());
  }, [shape?.geometry?.uuid, arrowRotated, az, canvasSize.w, canvasSize.h]);

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, az: azRef.current };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {}
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    setAz(Math.max(-55, Math.min(55, d.az + (e.clientX - d.x) * 0.35)));
  };
  const onPointerUp = () => { dragRef.current = null; };

  const fsG = Math.max(10, Math.min(13.5, canvasSize.w * 0.027));

  return (
    <div
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      style={{ position: 'absolute', inset: 0, userSelect: 'none', cursor: 'ew-resize', touchAction: 'none' }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block', position: 'absolute', inset: 0, width: '100%', height: '100%',
          filter: 'drop-shadow(0 18px 22px rgba(50,40,30,0.12)) drop-shadow(0 2px 3px rgba(50,40,30,0.08))',
        }}
      />
      <svg
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
        viewBox={`0 0 ${canvasSize.w} ${canvasSize.h}`}
      >
        {dimDraw.ground.map((d, i) => {
          const dx = d.db.x - d.da.x, dy = d.db.y - d.da.y, L = Math.hypot(dx, dy) || 1;
          const ux = dx / L, uy = dy / L, px = -uy, py = ux;
          const asz = Math.max(5, Math.min(9, canvasSize.w * 0.017));
          const txt = String(d.value);
          const lw = Math.max(txt.length * fsG * 0.62 + 12, 30), lh = fsG + 8;
          return (
            <g key={`gd-${i}`}>
              <line x1={d.fa.x} y1={d.fa.y} x2={d.da.x} y2={d.da.y} stroke="#cfc6b9" strokeWidth="0.8"/>
              <line x1={d.fb.x} y1={d.fb.y} x2={d.db.x} y2={d.db.y} stroke="#cfc6b9" strokeWidth="0.8"/>
              <line x1={d.da.x} y1={d.da.y} x2={d.db.x} y2={d.db.y} stroke="#a39a8f" strokeWidth="1"/>
              <polygon points={`${d.da.x},${d.da.y} ${d.da.x+ux*asz+px*asz*0.38},${d.da.y+uy*asz+py*asz*0.38} ${d.da.x+ux*asz-px*asz*0.38},${d.da.y+uy*asz-py*asz*0.38}`} fill="#a39a8f"/>
              <polygon points={`${d.db.x},${d.db.y} ${d.db.x-ux*asz+px*asz*0.38},${d.db.y-uy*asz+py*asz*0.38} ${d.db.x-ux*asz-px*asz*0.38},${d.db.y-uy*asz-py*asz*0.38}`} fill="#a39a8f"/>
              <rect x={d.cx - lw / 2} y={d.cy - lh / 2} width={lw} height={lh} rx={lh / 2} fill="#ffffff" stroke="#e6e0d6" strokeWidth="0.8"/>
              <text x={d.cx} y={d.cy + fsG * 0.36} textAnchor="middle" fontSize={fsG} fill="#44403c" fontFamily="'Inter','SF Pro Text',system-ui,sans-serif" fontWeight="600" style={{ fontVariantNumeric: 'tabular-nums' }}>{txt}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function PanelEditor({ isOpen, onClose, embedded = false }: PanelEditorProps) {
  const { selectedShapeId, shapes, updateShape, addShape, showOutlines, setShowOutlines,
    selectedPanelRow, setSelectedPanelRow, panelSelectMode, setPanelSelectMode, raycastMode, setRaycastMode,
    showVirtualFaces, setShowVirtualFaces, virtualFaces, updateVirtualFace, deleteVirtualFace, reorderVirtualFaces, reorderVirtualFaceGroup, pendingPanelCreation, hoveredPanelVfId,
    faceExtrudeMode, setFaceExtrudeMode, faceExtrudeTargetPanelId,
    setFaceExtrudeTargetPanelId, faceExtrudeSelectedFace, setFaceExtrudeSelectedFace, setFaceExtrudeHoveredFace,
    faceExtrudeThickness, setFaceExtrudeThickness, faceExtrudeFixedMode, setFaceExtrudeFixedMode,
    faceExtrudeClickPoint, faceExtrudeValueMode, setFaceExtrudeValueMode,
    faceExtrudeRefCandidate, setFaceExtrudeRefCandidate,
    panelMoveMode, setPanelMoveMode, panelMoveTargetPanelId, setPanelMoveTargetPanelId,
    panelMoveAxis, setPanelMoveAxis, panelMoveValue, setPanelMoveValue,
    panelMoveValueMode, setPanelMoveValueMode,
    panelMoveRefSourceVertex, setPanelMoveRefSourceVertex,
    panelMoveRefTargetPanelId, setPanelMoveRefTargetPanelId,
    panelMoveRefTargetVertex, setPanelMoveRefTargetVertex,
    panelRotateMode, setPanelRotateMode, panelRotateTargetPanelId, setPanelRotateTargetPanelId,
    panelRotatePivot, setPanelRotatePivot, setPanelRotatePivotType,
    panelRotateAxis, setPanelRotateAxis, panelRotateValue, setPanelRotateValue,
    panelRotateValueMode, setPanelRotateValueMode,
    panelRotateRefArmVertex, panelRotateRefFace } = useAppStore();

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Tutamaç KAVRAMA geri bildirimi: mousedown anında satır "kalkmış" görünür,
  // böylece sürüklemeye başlamadan önce satırın gerçekten tutulduğu bellidir.
  const [armedRowKey, setArmedRowKey] = useState<string | null>(null);

  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [isDraggingWindow, setIsDraggingWindow] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editingStepValue, setEditingStepValue] = useState('0');
  const [editingMoveStepId, setEditingMoveStepId] = useState<string | null>(null);
  const [editingMoveStepValue, setEditingMoveStepValue] = useState('0');
  const [editingRotateStepId, setEditingRotateStepId] = useState<string | null>(null);
  const [editingRotateStepValue, setEditingRotateStepValue] = useState('0');
  // Local string state for dock inputs to allow typing leading - / + signs
  const [extrudeThicknessStr, setExtrudeThicknessStr] = useState(String(faceExtrudeThickness));
  const [moveValueStr, setMoveValueStr] = useState('0');
  const [rotateValueStr, setRotateValueStr] = useState('0');
  const prevMoveAxisRef = useRef(panelMoveAxis);
  const prevRotateAxisRef = useRef(panelRotateAxis);
  const rowRefs = useRef<Map<number | string, HTMLDivElement>>(new Map());

  // Reset local string state when axis selection changes (new input session)
  useEffect(() => {
    if (prevMoveAxisRef.current !== panelMoveAxis) {
      prevMoveAxisRef.current = panelMoveAxis;
      setMoveValueStr('0');
      setPanelMoveValue(0);
    }
  }, [panelMoveAxis]);

  useEffect(() => {
    if (prevRotateAxisRef.current !== panelRotateAxis) {
      prevRotateAxisRef.current = panelRotateAxis;
      setRotateValueStr('0');
      setPanelRotateValue(0);
    }
  }, [panelRotateAxis]);

  const selectedShape = shapes.find(s => s.id === selectedShapeId);

  const activePanelId = useMemo(() => {
    if (!selectedShape || selectedPanelRow === null) return null;
    if (typeof selectedPanelRow === 'string' && selectedPanelRow.startsWith('vf-'))
      return findVPanel(shapes, selectedShape.id, selectedPanelRow.replace('vf-', ''))?.id || null;
    if (typeof selectedPanelRow === 'number')
      return shapes.find(s => s.type === 'panel' && s.parameters?.parentShapeId === selectedShape.id && s.parameters?.faceIndex === selectedPanelRow)?.id || null;
    return null;
  }, [selectedShape, selectedPanelRow, shapes]);

  const activePanel = activePanelId ? shapes.find(s => s.id === activePanelId) : null;
  const activeDims = activePanel?.geometry
    ? getDimsFromGeo(activePanel.geometry, activePanel.parameters?.arrowRotated, parseFloat((activePanel.parameters as any)?.panelThickness) || 18)
    : null;
  const activeSteps = activePanel?.parameters?.extrudeSteps || [];
  // Birleşik liste asıl kaynaktır; henüz göçmemiş eski panellerde moveSteps/
  // rotateSteps zaman damgasına göre birleştirilip gösterilir (id'ler korunur,
  // düzenle/sil PanelTransformService üzerinden otomatik göçü tetikler).
  const activeTransformSteps = (() => {
    const t = activePanel?.parameters?.transformSteps;
    if (t?.length) return t;
    return [
      ...(activePanel?.parameters?.moveSteps || []).map((s: any) => ({ ...s, type: 'move' })),
      ...(activePanel?.parameters?.rotateSteps || []).map((s: any) => ({ ...s, type: 'rotate' })),
    ].sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));
  })();

  const { selectedPanelRowParentId } = useAppStore();
  useEffect(() => {
    if (selectedShapeId !== useAppStore.getState().selectedPanelRowParentId)
      setSelectedPanelRow(null);
  }, [selectedShapeId]);

  useEffect(() => {
    const currentShapes = useAppStore.getState().shapes;
    // ESKİ "PANELİ KAPAT/GİZLE" KALINTISI: o özellik kaldırıldı. Eski kayıtlarda
    // paneli kapatılmış (panelRemovedByUser) yüzler kalmış olabilir; bunlar
    // otomatik oluşturmaya düşüp paneli geri getirmesin diye bir kez silinir.
    const legacyHidden = virtualFaces.filter(vf => !vf.hasPanel && (vf as any).panelRemovedByUser);
    if (legacyHidden.length) {
      for (const vf of legacyHidden) deleteVirtualFace(vf.id);
      return;
    }
    const pending = virtualFaces.filter(vf =>
      !vf.hasPanel &&
      !currentShapes.some(s => s.type === 'panel' && s.parameters?.virtualFaceId === vf.id)
    );
    if (!pending.length) return;
    (async () => {
      const { createPanelFromVirtualFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');
      const parentIdsToRebuild = new Set<string>();
      for (const vf of pending) {
        const parentShape = useAppStore.getState().shapes.find(s => s.id === vf.shapeId);
        if (!parentShape) continue;
        try {
          const rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, PANEL_THICKNESS);
          if (!rp) continue;
          const g = convertReplicadToThreeGeometry(rp);
          const r = geoAxes(g); if (!r) continue;
          const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
          const [def, alt] = [pa[0], pa[1]];
          const s = [r.size.x, r.size.y, r.size.z];
          const vi = virtualFaces.filter(f => f.shapeId === vf.shapeId).findIndex(f => f.id === vf.id);
          useAppStore.getState().addShape(makePanelBase(parentShape, {
            geometry: g, replicadShape: rp,
            parameters: { width: s[def], height: s[alt], depth: PANEL_THICKNESS, parentShapeId: parentShape.id, faceIndex: -(vi + 1), virtualFaceId: vf.id, arrowRotated: false, regionUV: computeRegionUV(vf) },
          }));
          updateVirtualFace(vf.id, { hasPanel: true });
          parentIdsToRebuild.add(parentShape.id);
        } catch (e) { console.error('Auto panel creation failed:', e); }
      }
      // İLK OLUŞTURMA REBUILD'E BAĞLANIR: yukarıdaki geometri yalnızca
      // geçici VF prizmasıdır (tam yüz kaplar, kardeş kesimi yok). Aynı yüzde
      // başka paneller varken bu hali bırakmak paneli yanlış bölgeye/üst üste
      // koyar. Rebuild, yüz-extrusion + kardeş kesimleri + bölge seçimiyle
      // paneli tıklanan bölgeye oturtur — atılan panel her zaman doğru yerde
      // doğar.
      for (const pid of parentIdsToRebuild) {
        try {
          const { rebuildPanelsForParent } = await import('./PanelRebuildService');
          await rebuildPanelsForParent(pid);
        } catch (e) { console.error('İlk oluşturma rebuild tetikleme hatası:', e); }
      }
    })();
  }, [virtualFaces]);

  useEffect(() => {
    if (faceExtrudeMode && activePanelId && activePanelId !== faceExtrudeTargetPanelId)
      { setFaceExtrudeTargetPanelId(activePanelId); setFaceExtrudeSelectedFace(null); setFaceExtrudeHoveredFace(null); }
  }, [faceExtrudeMode, activePanelId, faceExtrudeTargetPanelId]);

  useEffect(() => {
    if (panelMoveMode && activePanelId && activePanelId !== panelMoveTargetPanelId)
      { setPanelMoveTargetPanelId(activePanelId); setPanelMoveAxis(null); setPanelMoveValue(0); }
  }, [panelMoveMode, activePanelId, panelMoveTargetPanelId]);

  useEffect(() => {
    if (faceExtrudeSelectedFace === null || !activePanelId) return;
    const ps = shapes.find(s => s.id === activePanelId); if (!ps?.geometry) return;
    const steps = ps.parameters?.extrudeSteps || []; if (!steps.length) return;
    const groups = groupCoplanarFaces(extractFacesFromGeometry(ps.geometry));
    let g = groups[faceExtrudeSelectedFace]; if (!g) return;
    const gn = g.normal.clone().normalize();
    const isFlatGroup = Math.abs(gn.x) > 0.9 || Math.abs(gn.y) > 0.9 || Math.abs(gn.z) > 0.9;
    if (!isFlatGroup) {
      const axLbl = (n: THREE.Vector3) => { const a=[Math.abs(n.x),Math.abs(n.y),Math.abs(n.z)]; const i=a.indexOf(Math.max(...a)); return (i===0?(n.x>0?'X+':'X-'):i===1?(n.y>0?'Y+':'Y-'):(n.z>0?'Z+':'Z-')); };
      const flat = groups.filter(f => { const fn=f.normal.clone().normalize(); return (Math.abs(fn.x)>0.9||Math.abs(fn.y)>0.9||Math.abs(fn.z)>0.9) && axLbl(fn)===axLbl(gn); }).sort((a,b)=>a.center.distanceTo(g!.center)-b.center.distanceTo(g!.center))[0];
      if (flat) g = flat;
    }
    const existing = findExistingStepForFace(steps, g.normal.clone().normalize(), g.center.clone());
    if (existing) { setFaceExtrudeThickness(existing.value); setFaceExtrudeFixedMode(existing.isFixed); }
  }, [faceExtrudeSelectedFace, activePanelId, shapes]);

  useEffect(() => { if (!(isOpen || embedded)) { setSelectedPanelRow(null); setPanelSelectMode(false); if (faceExtrudeMode) setFaceExtrudeMode(false); if (panelMoveMode) setPanelMoveMode(false); if (panelRotateMode) setPanelRotateMode(false); } }, [isOpen, embedded]);

  // ── KOMUT–ARAYÜZ SENKRONU: GARANTİ ÇIKIŞ ─────────────────────────────────
  // İSTEK (Goker): "extrude/taşıma modu arayüzden geriye doğru çıkıldığı HER
  // durumda komuttan da çıksın, her zaman."
  // Taşı / Döndür / Extrude düğmeleri SEÇİLİ PANEL SATIRI şeridinin içinde
  // yaşar (o şerit selectedPanelRow === null iken hiç render edilmez). Dolayısıyla
  // komutun tek geçerlilik koşulu: açık satırın paneli === komutun hedef paneli.
  // Bu tek kural, geriye çıkışın BÜTÜN yollarını kapsar — ayrı ayrı çıkış
  // noktalarına iliştirilmiş temizliklere bağlı kalmaz (biri unutulursa komut
  // arayüzsüz açık kalıyordu):
  //   • satır kapatıldı (× / boşluğa tıklama / setSelectedPanelRow(null))
  //   • başka bir panel satırına geçildi
  //   • blok seçimi değişti veya seçim kalktı
  //   • panel silindi / VF kaldırıldı (silme akışı satırı null'a çeker)
  //   • editör kapandı (yukarıdaki efekt)
  // Hedef panel id'si açılışta satırla birlikte yazıldığı için mod açma anında
  // yanlış tetiklenmez (aynı render'da ikisi de set edilir).
  // GEÇİCİ BOŞLUK KORUMASI: yeniden üretim dalgalarında satır AÇIK kalırken
  // activePanelId bir an null'a düşebilir. O anı "geriye çıkış" saymayız —
  // çıkış ya satırın gerçekten kapanmasıyla (selectedPanelRow === null) ya da
  // BAŞKA bir panelin satırına geçilmesiyle belirlenir. Panel gerçekten
  // silindiğinde satır zaten yukarıdaki silme akışında null'a çekiliyor.
  const uiLeftPanel = (targetId: string | null) =>
    selectedPanelRow === null || (!!activePanelId && targetId !== activePanelId);
  useEffect(() => {
    if (faceExtrudeMode && uiLeftPanel(faceExtrudeTargetPanelId)) {
      console.log('[YAGO][KOMUT-ÇIKIŞ] extrude modu kapatıldı — panel satırı arayüzde açık değil',
        'hedef=', faceExtrudeTargetPanelId, 'açıkSatırPaneli=', activePanelId);
      setFaceExtrudeSelectedFace(null);
      setFaceExtrudeRefCandidate(null);
      setFaceExtrudeMode(false);
    }
    if (panelMoveMode && uiLeftPanel(panelMoveTargetPanelId)) {
      console.log('[YAGO][KOMUT-ÇIKIŞ] taşıma modu kapatıldı — panel satırı arayüzde açık değil',
        'hedef=', panelMoveTargetPanelId, 'açıkSatırPaneli=', activePanelId);
      setPanelMoveAxis(null);
      setPanelMoveMode(false);
    }
    if (panelRotateMode && uiLeftPanel(panelRotateTargetPanelId)) {
      console.log('[YAGO][KOMUT-ÇIKIŞ] döndürme modu kapatıldı — panel satırı arayüzde açık değil',
        'hedef=', panelRotateTargetPanelId, 'açıkSatırPaneli=', activePanelId);
      setPanelRotateAxis(null);
      setPanelRotateMode(false);
    }
  }, [activePanelId, selectedPanelRow, selectedShapeId,
      faceExtrudeMode, faceExtrudeTargetPanelId,
      panelMoveMode, panelMoveTargetPanelId,
      panelRotateMode, panelRotateTargetPanelId]);
  // AKORDEON: açılan satır (listeden ya da 3B'den seçilince) görünür alana
  // kaydırılır; açılma animasyonu başladıktan sonra, kartın ÜSTÜ hizalanır.
  useEffect(() => {
    if (selectedPanelRow === null) return;
    const t = window.setTimeout(() => rowRefs.current.get(selectedPanelRow)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
    return () => window.clearTimeout(t);
  }, [selectedPanelRow]);

  useEffect(() => {
    if (!pendingPanelCreation || (!isOpen && !embedded)) return;
    const cid = pendingPanelCreation.surfaceConstraint?.constraintPanelId; if (!cid) return;
    const vf = virtualFaces.find(f => f.id === cid); if (!vf || vf.hasPanel) return;
    const cs = useAppStore.getState().shapes.find(s => s.id === vf.shapeId); if (!cs) return;
    const vi = virtualFaces.filter(f => f.shapeId === vf.shapeId).findIndex(f => f.id === vf.id); if (vi === -1) return;
    (async () => {
      try {
        const { createPanelFromVirtualFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');
        const rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, PANEL_THICKNESS); if (!rp) return;
        addShape(makePanelBase(cs, { geometry: convertReplicadToThreeGeometry(rp), replicadShape: rp,
          parameters: { width: 0, height: 0, depth: PANEL_THICKNESS, parentShapeId: cs.id, faceIndex: -(vi+1), virtualFaceId: vf.id, regionUV: computeRegionUV(vf) } }));
        updateVirtualFace(vf.id, { hasPanel: true });
      } catch (err) { console.error('Failed to create panel for virtual face via click:', err); }
    })();
  }, [pendingPanelCreation]);

  useEffect(() => {
    if (raycastMode) { setShowOutlines(true); }
  }, [raycastMode]);

  useEffect(() => {
    if (!selectedShape) return;
    const hasPanels = shapes.some(s => s.type === 'panel' && s.parameters?.parentShapeId === selectedShape.id);
    if (!hasPanels) { setShowOutlines(true); return; }
    if (!raycastMode) { setShowOutlines(false); }
  }, [selectedShape?.id, shapes.length, raycastMode]);

  const handleMouseDown = (e: React.MouseEvent) => { e.preventDefault(); setIsDraggingWindow(true); setDragOffset({ x: e.clientX - position.x, y: e.clientY - position.y }); };
  useEffect(() => {
    if (!isDraggingWindow) return;
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'grabbing';
    const onMove = (e: MouseEvent) => { e.preventDefault(); setPosition({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y }); };
    const onUp = () => setIsDraggingWindow(false);
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    return () => { document.body.style.userSelect = ''; document.body.style.cursor = ''; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [isDraggingWindow, dragOffset]);

  const saveStep = async (pid: string | null, stepId: string, val: number) => {
    if (!pid) return; const ps = shapes.find(s => s.id === pid); if (!ps) return;
    const { updateExtrudeStep } = await import('./FaceExtrudeService'); await updateExtrudeStep(ps, stepId, val, updateShape); setEditingStepId(null);
  };
  const toggleArrow = (p: any) => { if (p) updateShape(p.id, { parameters: { ...p.parameters, arrowRotated: !p.parameters?.arrowRotated } }); };
  // YÜZEYİN ŞEKLİNİ AL: bayrak VF'de saklanır; bölge hesabı (computeFreeRegionLocal)
  // yalnız regen'de okur → tam rebuild ile panel yeni bölgesine göre üretilir.
  const toggleFitShape = async (vf: any) => {
    const next = !vf.fitFaceShape;
    updateVirtualFace(vf.id, { fitFaceShape: next });
    console.log('[YAGO][YÜZ-ŞEKLİ]', vf.id, next ? 'AÇIK' : 'KAPALI', '→ tam rebuild');
    try {
      const { rebuildPanelsForParent } = await import('./PanelRebuildService');
      await rebuildPanelsForParent(vf.shapeId);
    } catch (e) { console.error('[YAGO][YÜZ-ŞEKLİ] rebuild hatası:', e); }
  };

  if (!isOpen && !embedded) return null;

  const tb = (active: boolean, onClick: () => void, label: string, cls: [string, string]) => (
    <button onClick={onClick} className={`px-2 py-1 rounded text-xs font-semibold transition-all duration-150 ${active ? cls[0] : cls[1]}`}>{label}</button>
  );

  const panelToolbar = (
    <div className="flex items-center gap-1.5 flex-wrap">
      {tb(showOutlines, () => setShowOutlines(!showOutlines), 'Outline', ['text-blue-700 bg-blue-100 ring-1 ring-blue-400 shadow-sm', 'text-stone-500 hover:bg-stone-200'])}
      {tb(raycastMode, () => setRaycastMode(!raycastMode), 'Add Face', ['text-amber-700 bg-amber-100 ring-1 ring-amber-400 shadow-sm', 'text-stone-500 hover:bg-stone-200'])}
      {tb(panelSelectMode, () => setPanelSelectMode(!panelSelectMode), panelSelectMode ? 'Panel' : 'Body', ['text-violet-700 bg-violet-100 ring-1 ring-violet-400 shadow-sm', 'text-stone-500 hover:bg-stone-200'])}
    </div>
  );

  /* ── Face list ──────────────────────────────────────────────────────── */
  // AKORDEON LİSTE: seçili satırın altına açılan gövde (araçlar + önizleme +
  // adımlar) şeritlere (extrudeDock/moveDock/rotateDock) ve stepsPanel'e
  // başvurur; onlar aşağıda tanımlı olduğundan liste artık TEMBEL üretilir.
  const renderFaceList = () => selectedShape ? (() => {
    const geo = selectedShape.geometry; if (!geo) return null;
    const sid = selectedShape.id;
    const svf = virtualFaces.filter(vf => vf.shapeId === sid);
    if (!svf.length) return (
      <div className="flex flex-col items-center justify-center py-6 text-center">
        <div className="w-8 h-8 rounded-lg bg-stone-100 flex items-center justify-center mb-2">
          <MoveVertical size={14} className="text-stone-400"/>
        </div>
        <span className="text-xs text-stone-400">No faces added yet</span>
        <span className="text-[10px] text-stone-300 mt-0.5">Use Add Face mode to create panels</span>
      </div>
    );

    // DÜZ LİSTE — SATIR BİRLEŞTİRME YOK (Goker): eskiden aynı düzlemdeki
    // VF'ler tek kart altında birleştiriliyordu. Bu, sonradan yerleşen panelin
    // listede öne alınmasına ve basan/basılan sözleşmesinin (VF store sırası)
    // görünenle çelişmesine yol açıyordu. Artık her VF, store sırasıyla kendi
    // satırıdır; listedeki numara = VF sırası = basan/basılan önceliği.
    const orderedVfs = svf;

    // PANEL SİL: panel + yüzeyi (VF) birlikte kalıcı olarak silinir. Silinen
    // panel kardeşlerini damgalamış olabilir; kalanlar yeni duruma göre yeniden
    // üretilir (boşalan alanı doldursunlar).
    const deletePanelAndFace = async (vfId: string) => {
      const p = findVPanel(shapes, sid, vfId);
      if (p) useAppStore.getState().deleteShape(p.id);
      deleteVirtualFace(vfId);
      if (selectedPanelRow === `vf-${vfId}`) setSelectedPanelRow(null);
      console.log('[YAGO][SİL] panel + yüzey silindi', vfId, p?.id || '(panel yok)');
      try {
        const { rebuildPanelsForParent } = await import('./PanelRebuildService');
        await rebuildPanelsForParent(sid);
      } catch (e) { console.error('Silme sonrası rebuild hatası:', e); }
    };

    // Sürüklenen satır, hedefin ÖNCESİNE (targetId) yerleşir; null = en son.
    const doReorder = async (draggedId: string, targetId: string | null) => {
      setDragIndex(null); setDropIndex(null);
      reorderVirtualFaceGroup(sid, [draggedId], targetId);
      const { rebuildPanelsForParent } = await import('./PanelRebuildService');
      await rebuildPanelsForParent(sid);
    };
    // KULLANICI KURALI: bırakma HER ZAMAN üzerine gelinen satırın ALTINA yerleşir
    // (satırın üstünde/altında olmak fark etmez). Store insert-BEFORE çalıştığı
    // için hedef = üzerine gelinen satırın BİR SONRAKİ satırının id'si.
    const onRowDropBelow = async (draggedId: string, hoveredId: string) => {
      if (draggedId === hoveredId) { setDragIndex(null); setDropIndex(null); return; }
      const idx = orderedVfs.findIndex(v => v.id === hoveredId);
      const next = idx >= 0 ? orderedVfs[idx + 1] : undefined;
      if (next && next.id === draggedId) { setDragIndex(null); setDropIndex(null); return; } // zaten hemen altında
      await doReorder(draggedId, next ? next.id : null);
    };

    const elements: React.ReactNode[] = [];

    orderedVfs.forEach((vf, rowIdx) => {
      const rowKey = vf.id;
      const displayIdx = rowIdx + 1;
      const isDraggingThisRow = dragIndex === rowIdx;
      const isDropTargetRow = dropIndex !== null && dropIndex === rowIdx;
      const vp = findVPanel(shapes, sid, vf.id), ar = vp?.parameters?.arrowRotated || false, sel = selectedPanelRow === `vf-${vf.id}`;
      const dims = vp?.geometry ? getDimsFromGeo(vp.geometry, ar, parseFloat((vp.parameters as any)?.panelThickness) || 18) : null;

      const isExtrudingThis = sel && faceExtrudeMode && faceExtrudeTargetPanelId === vp?.id;
      const isMovingThis = sel && panelMoveMode && panelMoveTargetPanelId === vp?.id;
      const isRotatingThis = sel && panelRotateMode && panelRotateTargetPanelId === vp?.id;

      elements.push(
        <div
          key={rowKey}
          ref={el => { const k = `vf-${vf.id}`; if (el) rowRefs.current.set(k, el); else rowRefs.current.delete(k); }}
          onDragOver={e => {
            if (dragIndex !== null && !isDraggingThisRow) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (dropIndex !== rowIdx) setDropIndex(rowIdx);
            }
          }}
          onDrop={e => {
            e.preventDefault();
            if (dragIndex === null) return;
            onRowDropBelow(orderedVfs[dragIndex].id, rowKey);
          }}
          // SOFT SATIR + AKORDEON (Goker): satır sade kart; seçilince AYNI kart
          // aşağı doğru açılır ve altında araçlar, önizleme ve adımlar görünür.
          className={`group/row relative flex flex-col rounded-[10px] overflow-hidden transition-[background-color,box-shadow,opacity,transform] duration-150 ease-out
            ${sel
              ? 'bg-[#fffdf9] ring-1 ring-[#efd9c0] shadow-[0_1px_2px_rgba(234,88,12,0.05),0_8px_20px_-14px_rgba(120,70,20,0.35)] my-1'
              : hoveredPanelVfId === vf.id
                ? 'bg-[#fdf6e3] ring-1 ring-[#eedfb9]'
                : 'bg-[#fdfcfa] ring-1 ring-[#ece7df] shadow-[0_1px_0_rgba(68,64,60,0.025)] hover:bg-white hover:ring-[#e2dbd0] hover:shadow-[0_1px_2px_rgba(68,64,60,0.04),0_4px_10px_-8px_rgba(68,64,60,0.18)]'}
            ${isDraggingThisRow ? 'opacity-40 scale-[0.99]' : ''}
            ${armedRowKey === rowKey && !isDraggingThisRow ? '!ring-orange-300 !bg-white shadow-[0_6px_16px_-8px_rgba(234,88,12,0.35)] scale-[1.006]' : ''}
            ${isDropTargetRow ? '!ring-amber-300 !bg-[#fffbf0]' : ''}`}
        >
          {/* ── SATIR BAŞLIĞI ── */}
          <div className={`relative flex items-stretch ${sel ? 'bg-[#fff8ef]' : ''}`}>
            {sel && <span className="pointer-events-none absolute left-0 top-[6px] bottom-[6px] w-[2px] rounded-r-full bg-orange-500/90" />}

            <span
              draggable
              onMouseDown={() => setArmedRowKey(rowKey)}
              onMouseUp={() => setArmedRowKey(null)}
              onMouseLeave={() => { if (dragIndex === null) setArmedRowKey(null); }}
              onDragStart={e => {
                stop(e);
                setDragIndex(rowIdx);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', rowKey);
              }}
              onDragEnd={() => { setDragIndex(null); setDropIndex(null); setArmedRowKey(null); }}
              onClick={stop}
              className={`cursor-grab active:cursor-grabbing shrink-0 w-[18px] ml-[3px] self-stretch flex items-center justify-center transition-colors duration-150
                ${armedRowKey === rowKey
                  ? 'text-orange-500'
                  : 'text-stone-300/70 group-hover/row:text-stone-400 hover:!text-orange-500'}`}
              title="Sürükleyerek sırala"
            ><GripVertical size={13} strokeWidth={1.75}/></span>

            <div
              onClick={e => { stop(e); if (sel) setSelectedPanelRow(null); else setSelectedPanelRow(`vf-${vf.id}`, null, sid); }}
              className="flex-1 min-w-0 relative flex items-center gap-1.5 pl-0.5 pr-1 py-[4px] cursor-pointer"
            >
              {/* Sıra numarası: yuvarlaksız, sade ve bir tık büyük. */}
              <span className={`shrink-0 w-[20px] text-center text-[13px] font-semibold tabular-nums leading-none transition-colors duration-150
                ${sel ? 'text-orange-600' : 'text-stone-400 group-hover/row:text-stone-600'}`}>
                {displayIdx}
              </span>

              <input
                type="text"
                value={vf.description || ''}
                onClick={stop}
                onChange={e => updateVirtualFace(vf.id, { description: e.target.value })}
                placeholder="not…"
                className="yago-row-note flex-1 min-w-0 h-[22px] px-[5px] text-[11.5px] text-stone-600 bg-transparent border border-transparent rounded-[5px] outline-none placeholder:text-stone-300 hover:border-[#ebe5dc] focus:bg-white focus:border-orange-400/50 transition-colors"
              />

              {dims && (
                <span onClick={stop} className="shrink-0 inline-flex items-baseline leading-none tabular-nums px-0.5 cursor-default">
                  <span className="text-[11px] font-semibold text-stone-400">W</span><span className="text-[12.5px] font-medium text-stone-700 ml-1">{dims.primary}</span>
                  <span className="w-px h-3 bg-[#e6e0d6] mx-2 self-center" />
                  <span className="text-[11px] font-semibold text-stone-400">H</span><span className="text-[12.5px] font-medium text-stone-700 ml-1">{dims.secondary}</span>
                  <span className="w-px h-3 bg-[#e6e0d6] mx-2 self-center" />
                  <span className="text-[11px] font-semibold text-stone-400">T</span><span className="text-[12.5px] font-medium text-stone-500 ml-1">{dims.thickness}</span>
                </span>
              )}

              <div className="flex items-center gap-px shrink-0 ml-0.5" onClick={stop}>
                <FitShapeToggle checked={!!vf.fitFaceShape} disabled={!vf.hasPanel} onToggle={() => { void toggleFitShape(vf); }} />

                <button disabled={!vf.hasPanel} onClick={e => { stop(e); toggleArrow(vp); }}
                  className={`w-5 h-5 rounded-md flex items-center justify-center transition-colors duration-150 ${!vf.hasPanel ? 'text-stone-200 cursor-not-allowed' : ar ? 'text-stone-700 bg-[#f1ece4]' : 'text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700'}`}
                  title="Ok yönünü değiştir"><ArrowUp size={13} strokeWidth={1.9} className={`transition-transform duration-200 ${ar ? '' : 'rotate-90'}`}/></button>

                {/* Sil: sade görünüm için yalnız satır üzerine gelince / seçiliyken görünür. */}
                <button onClick={e => { stop(e); void deletePanelAndFace(vf.id); }}
                  className={`w-5 h-5 rounded-md flex items-center justify-center text-stone-400 hover:bg-red-50 hover:text-red-500 focus-visible:opacity-100 transition-[opacity,color,background-color] duration-150
                    ${sel ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'}`}
                  title="Paneli sil"><Trash2 size={12} strokeWidth={1.9}/></button>

                {/* Aç / kapa göstergesi */}
                <span className={`w-4 h-5 flex items-center justify-center transition-[transform,color] duration-200 ${sel ? 'rotate-90 text-orange-500' : 'text-stone-300 group-hover/row:text-stone-400'}`}>
                  <ChevronRight size={13} strokeWidth={2}/>
                </span>
              </div>
            </div>
          </div>

          {/* ── AÇILAN GÖVDE (akordeon) ── */}
          {sel && renderExpandedBody(vf, vp, { isExtrudingThis, isMovingThis, isRotatingThis })}
        </div>
      );

      // YERLEŞİM GÖSTERGESİ: sürüklenen öğe TAM BURAYA (bu satırın altına)
      // yerleşecek — ince çizgi yerine kalın, parlak amber bant.
      if (isDropTargetRow && !isDraggingThisRow) {
        elements.push(
          <div key={`${rowKey}-drop-ind`} className="pointer-events-none h-[7px] mx-1 -my-0.5 rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.65),0_1px_2px_rgba(180,83,9,0.3)]" />
        );
      }
    });

    // "Altına yerleş" kuralıyla en alta taşımak için son satırın üzerine
    // bırakmak yeterli. En ÜSTE taşıma: listenin başında, sürükleme sırasında
    // aktifleşen ince bir tutma alanı; üzerine gelinince DİĞER yerleşim
    // çizgileriyle aynı stilde turuncu bant görünür ve oraya bırakılır.
    if (dragIndex !== null && orderedVfs.length > 0) {
      const first = orderedVfs[0];
      if (dragIndex !== 0) {
        elements.unshift(
          <div
            key="drop-top"
            onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropIndex !== -2) setDropIndex(-2); }}
            onDrop={e => {
              e.preventDefault();
              if (dragIndex === null) return;
              doReorder(orderedVfs[dragIndex].id, first.id);
            }}
            className="h-4 -mb-1 flex items-center"
          >
            {dropIndex === -2 && (
              <div className="pointer-events-none w-full h-[7px] mx-1 rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.65),0_1px_2px_rgba(180,83,9,0.3)]" />
            )}
          </div>
        );
      }
    }
    return elements;
  })() : null;

  /* ── Integrated bottom dock (foot of the preview canvas) ─────────────── */
  const iconBtn = (color: string): React.CSSProperties => ({
    width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 5, border: 'none', background: 'transparent', cursor: 'pointer',
    color, outline: 'none', padding: 0, transition: 'background 0.12s',
  });

  const extrudeDock = (() => {
    if (!activePanelId || !activePanel) return null;
    const isExt = faceExtrudeMode && !!activePanelId;
    const hf = faceExtrudeSelectedFace !== null;
    if (!isExt) return null;

    const isRefMode = faceExtrudeValueMode === 'ref';
    const hasRefPanel = isRefMode && faceExtrudeRefCandidate?.panelId;
    const hasRefFace = isRefMode && hasRefPanel && faceExtrudeRefCandidate?.faceGroupIndex !== undefined && faceExtrudeRefCandidate.faceGroupIndex >= 0;


    const exitBtn = (
      <button onClick={e => { stop(e); setFaceExtrudeSelectedFace(null); setFaceExtrudeMode(false); setFaceExtrudeRefCandidate(null); }}
        title="Çıkış" style={DOCK_EXIT_BTN} className="hover:!bg-[#f3efe8] hover:!text-stone-600"><X size={13} strokeWidth={2} /></button>
    );

    const onApply = async () => {
      if (!hf || !activePanelId) return;
      const ps = shapes.find(s => s.id === activePanelId); if (!ps) return;
      const vfId = ps.parameters?.virtualFaceId as string | undefined;
      const vf = vfId ? virtualFaces.find(f => f.id === vfId) : undefined;

      if (isRefMode) {
        if (!hasRefFace) return;
        const { executeFaceExtrudeToReference } = await import('./FaceExtrudeService');
        await executeFaceExtrudeToReference({
          panelShape: ps, faceGroupIndex: faceExtrudeSelectedFace!,
          refShapeId: faceExtrudeRefCandidate!.panelId,
          refFaceGroupIndex: faceExtrudeRefCandidate!.faceGroupIndex,
          refNormalWorld: faceExtrudeRefCandidate!.normalWorld,
          clickPoint: faceExtrudeClickPoint ?? undefined,
          shapes, updateShape,
          virtualFaceId: vfId,
          vfNormal: vf?.normal as [number, number, number] | undefined,
          vfVertex0: vf?.vertices?.[0] as [number, number, number] | undefined,
          updateVirtualFace,
        });
      } else {
        const { executeFaceExtrude } = await import('./FaceExtrudeService');
        await executeFaceExtrude({
          panelShape: ps, faceGroupIndex: faceExtrudeSelectedFace!,
          value: faceExtrudeThickness, isFixed: faceExtrudeFixedMode,
          shapes, updateShape, clickPoint: faceExtrudeClickPoint ?? undefined,
          virtualFaceId: vfId,
          vfNormal: vf?.normal as [number, number, number] | undefined,
          vfVertex0: vf?.vertices?.[0] as [number, number, number] | undefined,
          updateVirtualFace,
        });
      }
      setFaceExtrudeSelectedFace(null);
      setFaceExtrudeMode(false);
      setFaceExtrudeRefCandidate(null);
    };

    return (
      <div style={DOCK_SHELL}>
        {hf && (
          <DockModeBar
            modes={dockModes(['fixed','dyn','ref'], { fixed: { sub: 'Sabit', title: 'Fixed — sabit kalınlık' }, ref: { sub: 'Yüze', title: 'Ref — referans yüze kadar' } })}
            active={faceExtrudeValueMode}
            onPick={k => { const m = k as 'fixed'|'dyn'|'ref'; setFaceExtrudeValueMode(m); if (m === 'fixed') setFaceExtrudeFixedMode(true); if (m === 'dyn') setFaceExtrudeFixedMode(false); if (m !== 'ref') setFaceExtrudeRefCandidate(null); }}
          />
        )}
        <div style={DOCK_ROW}>
          {hf ? (
            <>
              {!isRefMode && (
                <input
                  type="text" inputMode="numeric" value={extrudeThicknessStr}
                  onChange={e => {
                    const v = e.target.value;
                    setExtrudeThicknessStr(v);
                    const p = parseFloat(v);
                    if (!isNaN(p)) setFaceExtrudeThickness(p);
                  }}
                  onBlur={() => {
                    const p = parseFloat(extrudeThicknessStr);
                    if (isNaN(p)) { setExtrudeThicknessStr(String(faceExtrudeThickness)); }
                    else { setFaceExtrudeThickness(p); setExtrudeThicknessStr(String(p)); }
                  }}
                  style={DOCK_INPUT}
                />
              )}
              {isRefMode && (
                <div style={dockStatus(!!hasRefFace)}>
                  <span style={dockDot(hasRefFace ? '#16a34a' : '#a8a29e')} />
                  <span style={dockStatusText(!!hasRefFace)}>
                    {hasRefFace ? 'Referans yüzey seçildi' : hasRefPanel ? 'Referans yüzeyi seç' : 'Referans paneli seç'}
                  </span>
                </div>
              )}
              <button onClick={onApply} title="Uygula" style={dockApplyBtn(!(isRefMode && !hasRefFace))}><Check size={14} strokeWidth={2.4} /></button>
              {exitBtn}
            </>
          ) : (
            <>
              <div style={dockStatus()}>
                <span style={dockDot('#a8a29e')} />
                <span style={dockStatusText()}>3B görünümde yüzey seç</span>
              </div>
              {exitBtn}
            </>
          )}
        </div>
      </div>
    );
  })();

  const isPreviewMode = selectedPanelRow !== null;

  // ── Move dock — only the active-command input row (no steps list here) ──
  const moveDock = (() => {
    if (!activePanelId || !panelMoveMode) return null;
    const isRefMode = panelMoveValueMode === 'ref';
    const hasAxis = panelMoveAxis !== null;
    const hasRefReady = isRefMode && panelMoveRefSourceVertex && panelMoveRefTargetPanelId && panelMoveRefTargetVertex;
    const axisColors: Record<string, string> = { 'x+': '#dc2626', 'x-': '#b91c1c', 'y+': '#16a34a', 'y-': '#15803d', 'z+': '#2563eb', 'z-': '#1d4ed8' };


    const exitBtn = (
      <button onClick={e => { stop(e); setPanelMoveAxis(null); setPanelMoveMode(false); if (isRefMode) setSelectedPanelRow(null); }}
        title="Çıkış" style={DOCK_EXIT_BTN} className="hover:!bg-[#f3efe8] hover:!text-stone-600"><X size={13} strokeWidth={2} /></button>
    );

    const onApply = async () => {
      if (!activePanelId) return;
      const ps = shapes.find(s => s.id === activePanelId); if (!ps) return;

      if (isRefMode) {
        if (!hasRefReady) return;
        const { executePanelMoveRef } = await import('./PanelMoveService');
        await executePanelMoveRef({
          panelShape: ps,
          sourceVertex: panelMoveRefSourceVertex!,
          targetPanelId: panelMoveRefTargetPanelId!,
          targetVertex: panelMoveRefTargetVertex!,
          shapes, updateShape,
        });
        // Ref onaylandı → panel seçili kalmasın.
        setSelectedPanelRow(null);
      } else if (panelMoveValueMode === 'fixed') {
        if (!hasAxis) return;
        const { executePanelMoveFixed } = await import('./PanelMoveService');
        await executePanelMoveFixed({ panelShape: ps, axis: panelMoveAxis!, value: panelMoveValue, shapes, updateShape });
      } else {
        if (!hasAxis) return;
        const { executePanelMove } = await import('./PanelMoveService');
        await executePanelMove({ panelShape: ps, axis: panelMoveAxis!, value: panelMoveValue, shapes, updateShape });
      }
      setPanelMoveAxis(null);
      setPanelMoveValue(0);
      setMoveValueStr('0');
      setPanelMoveMode(false);
    };

    const canApply = isRefMode ? !!hasRefReady : hasAxis;

    const mainContent = (() => {
      if (isRefMode) {
        const step = !panelMoveRefSourceVertex ? 1 : !panelMoveRefTargetPanelId ? 2 : !panelMoveRefTargetVertex ? 3 : 4;
        const label = step === 1 ? 'Kaynak noktayı seç' : step === 2 ? 'Hedef paneli seç' : step === 3 ? 'Hedef noktayı seç' : 'Hazır — sağ tık ile onayla';
        const ready = step === 4;
        return (
          <div style={dockStatus(ready)}>
            <span style={dockDot(ready ? '#16a34a' : '#a8a29e')} />
            <span style={dockStatusText(ready)}>{label}</span>
          </div>
        );
      }
      if (!hasAxis) {
        return (
          <div style={dockStatus()}>
                <span style={dockDot('#a8a29e')} />
                <span style={dockStatusText()}>3B görünümde yön oku seç</span>
          </div>
        );
      }
      return (
        <>
          <span style={dockAxisTag(axisColors[panelMoveAxis!] || '#44403c')}>
            {panelMoveAxis!.toUpperCase()}
          </span>
          <input
            type="text" inputMode="numeric" autoFocus value={moveValueStr}
            onChange={e => {
              const v = e.target.value;
              setMoveValueStr(v);
              const p = parseFloat(v);
              if (!isNaN(p)) setPanelMoveValue(p);
            }}
            onBlur={() => {
              const p = parseFloat(moveValueStr);
              if (isNaN(p)) { setMoveValueStr('0'); setPanelMoveValue(0); }
              else { setPanelMoveValue(p); setMoveValueStr(String(p)); }
            }}
            onKeyDown={e => { if (e.key === 'Enter') onApply(); if (e.key === 'Escape') { setPanelMoveAxis(null); setPanelMoveMode(false); } }}
            style={DOCK_INPUT}
          />
        </>
      );
    })();

    return (
      <div style={DOCK_SHELL}>
        <DockModeBar
          modes={dockModes(['dyn','fixed','ref'], { dyn: { sub: 'Göreli' }, fixed: { sub: 'Sabit', title: 'Fixed — sabit konum' }, ref: { sub: 'Noktaya' } })}
          active={panelMoveValueMode}
          onPick={k => { const m = k as 'dyn'|'fixed'|'ref'; setPanelMoveValueMode(m); if (m !== 'ref') { setPanelMoveRefSourceVertex(null); setPanelMoveRefTargetPanelId(null); setPanelMoveRefTargetVertex(null); } if (m === 'ref') { setPanelMoveAxis(null); } }}
        />
        <div style={DOCK_ROW}>
          {mainContent}
          <button onClick={onApply} title="Uygula" style={dockApplyBtn(!!canApply)}><Check size={14} strokeWidth={2.4} /></button>
          {exitBtn}
        </div>
      </div>
    );
  })();

  // ── Rotate dock — pivot + axis selection then value input ──
  // REF MODU AKIŞI (Goker): 1) pivot  2) nişan noktası (panelin kendi noktası)
  // 3) mod  4) eksen (X/Y/Z halkası)  5) referans panel + referans nokta
  // 6) sağ tık onay. Onaydan sonra bağ KALICIDIR: referans nokta taşındıkça
  // panel o noktaya nişan alacak şekilde yeniden döner.
  const rotateDock = (() => {
    if (!activePanelId || !panelRotateMode) return null;
    const isRotRefMode = panelRotateValueMode === 'ref';
    const hasPivot = panelRotatePivot !== null;
    const hasAxis = panelRotateAxis !== null;
    const hasArm = panelRotateRefArmVertex !== null;
    const rotRefReady = isRotRefMode && hasPivot && hasArm && hasAxis && !!panelRotateRefFace;
    const axisColors: Record<string, string> = { x: '#dc2626', y: '#16a34a', z: '#2563eb' };

    // AKTİF MOD OKUNAKLI OLSUN: fildişi üstüne fildişi (taşıma segmentinin soluk
    // tonu) burada "hiç seçilmemiş" gibi okunuyordu — ref moduna geçildiği
    // anlaşılmıyordu. Aktif düğme, uygulamanın kendi "açık araç" dili olan koyu
    // taş dolguya çekildi (panel satırındaki etkin Taşı/Döndür düğmeleriyle aynı).

    const pickMode = (m: 'dyn' | 'ref') => {
      console.log('[YAGO][DÖN-MOD] mod seçildi:', m);
      setPanelRotateValueMode(m);
      setRotateValueStr('0');
    };

    const rotModes = dockModes(['dyn','ref'], {
      dyn: { sub: 'Açı gir', title: 'Açı gir: dönme noktası → eksen → derece' },
      ref: { sub: 'Referansa dön', title: 'Referansa göre dön: pivot → nişan → eksen → referans yüz → sağ tık' },
    });
    const modeBar = (trailing?: React.ReactNode) => (
      <DockModeBar modes={rotModes} active={panelRotateValueMode} onPick={k => pickMode(k as 'dyn' | 'ref')} trailing={trailing} />
    );

    const exitBtn = (
      <button onClick={e => { stop(e); setPanelRotateAxis(null); setPanelRotatePivot(null); setPanelRotatePivotType(null); setPanelRotateMode(false); if (isRotRefMode) setSelectedPanelRow(null); }}
        title="Çıkış" style={DOCK_EXIT_BTN} className="hover:!bg-[#f3efe8] hover:!text-stone-600"><X size={13} strokeWidth={2} /></button>
    );

    const onApply = async () => {
      if (!activePanelId) return;
      const ps = shapes.find(s => s.id === activePanelId); if (!ps) return;
      if (isRotRefMode) {
        if (!rotRefReady) return;
        const { executePanelRotateRef } = await import('./PanelRotateService');
        await executePanelRotateRef({
          panelShape: ps,
          pivot: panelRotatePivot!,
          armVertex: panelRotateRefArmVertex!,
          axis: panelRotateAxis!,
          targetPanelId: panelRotateRefFace!.panelId,
          targetFace: {
            faceGroupIndex: panelRotateRefFace!.faceGroupIndex,
            normalWorld: panelRotateRefFace!.normalWorld,
            pointWorld: panelRotateRefFace!.pointWorld,
          },
          shapes, updateShape,
        });
        setPanelRotateMode(false);
        setSelectedPanelRow(null);
        return;
      }
      if (!hasAxis || !hasPivot) return;
      const { executePanelRotate } = await import('./PanelRotateService');
      await executePanelRotate({ panelShape: ps, axis: panelRotateAxis!, value: panelRotateValue, pivot: panelRotatePivot!, shapes, updateShape });
      setPanelRotateAxis(null);
      setPanelRotateValue(0);
      setRotateValueStr('0');
    };

    // ── 1. ADIM: MOD SEÇİMİ ─────────────────────────────────────────────────
    // Sahnede henüz HİÇBİR nokta/halka yok (PanelRotateGizmo mod seçilene kadar
    // null döner). Şeritte yalnız iki geniş düğme vardır; biri seçilene kadar
    // akış başlamaz. (Goker: "önce hiç nokta çıkmadan mod seçimi olsun, ona
    // göre adımları takip edeyim.")
    if (panelRotateValueMode === null) {
      return (
        <div style={DOCK_SHELL}>
          {modeBar(<div style={{ display: 'flex', alignItems: 'center' }}>{exitBtn}</div>)}
          <div style={{ padding: '5px 10px 7px', fontSize: 10.5, fontWeight: 500, color: '#a8a29e', fontFamily: DOCK_FONT }}>Döndürme modunu seç</div>
        </div>
      );
    }

    // ── REF MODU: tek satır, adım durum etiketi + mod segmenti + onay ──────
    if (isRotRefMode) {
      // ADIM SAYACI: dyn modunun 1. adım etiketiyle ("Donme noktasi sec")
      // neredeyse aynı bir metin, ref moduna geçilip geçilmediğini
      // belirsizleştiriyordu. Ref akışı artık kaçıncı adımda olduğunu söyler.
      const step = !hasPivot ? 1 : !hasArm ? 2 : !hasAxis ? 3 : !panelRotateRefFace ? 4 : 5;
      // Şerit dar: etiket kısa tutulur, tam açıklama title'da (hover) verilir.
      const label = step === 1 ? '1/4 · Pivot noktası'
        : step === 2 ? '2/4 · Nişan noktası'
        : step === 3 ? '3/4 · Eksen halkası'
        : step === 4 ? '4/4 · Referans yüz'
        : 'Hazır — sağ tık onay';
      const hint = step === 1 ? 'Panelin döneceği nokta (kendi köşe/merkez noktalarından)'
        : step === 2 ? 'Referans yüze DEĞECEK nokta — AYNI panelin başka bir noktası'
        : step === 3 ? 'Dönme ekseni: sahnedeki X / Y / Z halkasından seç'
        : step === 4 ? 'Başka bir panelin yüzünü tıkla (aynı yere tekrar tıkla → arkadaki yüz). Nişan noktası bu yüze değene kadar dönülür.'
        : 'Sahnede herhangi bir yere sağ tıkla — bağ kalıcı kurulur, referans panelin kenarı eğime göre pahlanır';
      return (
        <div style={DOCK_SHELL}>
          {modeBar()}
          <div style={DOCK_ROW}>
            <div title={hint} style={dockStatus(rotRefReady)}>
              <span style={dockDot(rotRefReady ? '#16a34a' : '#a8a29e')} />
              <span style={dockStatusText(rotRefReady)}>{label}</span>
              {hasAxis && (
                <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: axisColors[panelRotateAxis!] || '#44403c' }}>
                  {panelRotateAxis!.toUpperCase()}
                </span>
              )}
            </div>
            <button onClick={onApply} title="Uygula" style={dockApplyBtn(!!rotRefReady)}><Check size={14} strokeWidth={2.4} /></button>
            {exitBtn}
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
              <span style={dockAxisTag(axisColors[panelRotateAxis!] || '#44403c')}>
                {panelRotateAxis!.toUpperCase()}
              </span>
              <input
                type="text" inputMode="numeric" autoFocus value={rotateValueStr}
                onChange={e => {
                  const v = e.target.value;
                  setRotateValueStr(v);
                  const p = parseFloat(v);
                  if (!isNaN(p)) setPanelRotateValue(p);
                }}
                onBlur={() => {
                  const p = parseFloat(rotateValueStr);
                  if (isNaN(p)) { setRotateValueStr('0'); setPanelRotateValue(0); }
                  else { setPanelRotateValue(p); setRotateValueStr(String(p)); }
                }}
                onKeyDown={e => { if (e.key === 'Enter') onApply(); if (e.key === 'Escape') { setPanelRotateAxis(null); setPanelRotateMode(false); } }}
                style={DOCK_INPUT}
              />
              <span style={{ fontSize: 12, fontWeight: 500, color: '#a8a29e', marginLeft: -2 }}>°</span>
              <button onClick={onApply} title="Uygula" style={dockApplyBtn(true)}><Check size={14} strokeWidth={2.4} /></button>
              {exitBtn}
            </>
          ) : hasPivot ? (
            <>
              <div style={dockStatus()}>
                <span style={dockDot('#f59e0b')} />
                <span style={dockStatusText()}>Ekseni seç (X/Y/Z halkası)</span>
              </div>
              {exitBtn}
            </>
          ) : (
            <>
              <div style={dockStatus()}>
                <span style={dockDot('#06b6d4')} />
                <span style={dockStatusText()}>Dönme noktası seç (köşeler/merkez)</span>
              </div>
              {exitBtn}
            </>
          )}
        </div>
      </div>
    );
  })();

  // ── Unified steps panel (below preview, scrollable) ──────────────────────
  const stepsPanel = (() => {
    if (!activePanelId || !activePanel) return null;
    const hasExtrudeSteps = activeSteps.length > 0;
    const hasTransformSteps = activeTransformSteps.length > 0;
    if (!hasExtrudeSteps && !hasTransformSteps) return null;

    const axisColors: Record<string, string> = { 'x+': '#dc2626', 'x-': '#b91c1c', 'y+': '#16a34a', 'y-': '#15803d', 'z+': '#2563eb', 'z-': '#1d4ed8', x: '#dc2626', y: '#16a34a', z: '#2563eb' };
    const typeBadge: Record<string, { label: string; bg: string; color: string }> = {
      move: { label: 'Taşı', bg: 'rgba(22,163,74,0.08)', color: '#15803d' },
      rotate: { label: 'Dön', bg: 'rgba(37,99,235,0.08)', color: '#1d4ed8' },
      extrude: { label: 'Ext', bg: 'rgba(217,119,6,0.09)', color: '#b45309' },
    };

    const saveTransformStep = async (pid: string | null, stepId: string, val: number) => {
      if (!pid) return; const ps = shapes.find(s => s.id === pid); if (!ps) return;
      const { updateTransformStep } = await import('./PanelTransformService');
      await updateTransformStep(ps, stepId, val, shapes, updateShape);
      setEditingMoveStepId(null);
      setEditingRotateStepId(null);
    };

    // Build unified ordered list: extrude steps + transform steps sorted by timestamp
    const allSteps: Array<{ id: string; stepType: string; axis: string; value: number; timestamp: number; isFixed?: boolean; original: any }> = [];

    for (const s of activeSteps) {
      // Ref adımı: value=0 ref işaretçisidir; UI'da çözülen gerçek miktarı göster.
      const dispVal = (s as any).resolvedValue != null ? (s as any).resolvedValue : s.value;
      allSteps.push({ id: s.id, stepType: 'extrude', axis: s.axisLabel, value: dispVal, timestamp: s.timestamp, isFixed: s.isFixed, original: s });
    }
    for (const s of activeTransformSteps) {
      const ax = s.type === 'move' ? s.axis : s.axis;
      // REF DÖNÜŞ: listede son ÇÖZÜLEN açı gösterilir (donmuş value değil) —
      // referans nokta taşındıkça buradaki değer de güncellenir.
      const dispVal = (s.type === 'rotate' && typeof (s as any).resolvedValue === 'number')
        ? (s as any).resolvedValue : s.value;
      allSteps.push({ id: s.id, stepType: s.type, axis: ax, value: dispVal, timestamp: s.timestamp, original: s });
    }
    allSteps.sort((a, b) => a.timestamp - b.timestamp);

    return (
      <div className="shrink-0 mt-2" style={{ fontFamily: DOCK_FONT }}>
        <div className="px-1 pb-1.5 flex items-center gap-2">
          <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#b5ada3' }}>İşlem adımları</span>
          <span className="text-[10px] font-medium tabular-nums text-stone-300">{allSteps.length}</span>
          <div className="flex-1 h-px bg-[#efeae2]" />
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: 200 }}>
          <div className="flex flex-col gap-[2px] p-px">
            {allSteps.map((s, idx) => {
              const badge = typeBadge[s.stepType] || typeBadge.move;
              const isEditingThis = (s.stepType === 'extrude' && editingStepId === s.id)
                || (s.stepType === 'move' && editingMoveStepId === s.id)
                || (s.stepType === 'rotate' && editingRotateStepId === s.id);
              const editValue = s.stepType === 'extrude' ? editingStepValue
                : s.stepType === 'move' ? editingMoveStepValue
                : editingRotateStepValue;

              return (
                <div key={s.id} className="group/step flex items-center gap-1.5 pl-1.5 pr-1 h-[30px] rounded-[9px] bg-[#fdfcfa] ring-1 ring-[#ece7df] shadow-[0_1px_0_rgba(68,64,60,0.025)] hover:bg-white hover:ring-[#e2dbd0] transition-colors duration-150">
                  <span className="shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#f3efe8] text-[10px] font-semibold text-stone-500 tabular-nums leading-none">{idx + 1}</span>
                  <span className="shrink-0 text-[10px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px]" style={{ background: badge.bg, color: badge.color }}>{badge.label}</span>
                  <span className="shrink-0 min-w-[24px] text-center text-[10.5px] font-bold px-1 h-[18px] leading-[18px] rounded-[5px] bg-[#f5f2ec]" style={{ color: axisColors[s.axis] || '#57534e' }}>{s.axis.toUpperCase()}</span>

                  {isEditingThis ? (
                    <>
                      <input type="text" inputMode="numeric" autoFocus value={editValue}
                        onChange={e => {
                          const v = e.target.value;
                          if (s.stepType === 'extrude') setEditingStepValue(v);
                          else if (s.stepType === 'move') setEditingMoveStepValue(v);
                          else setEditingRotateStepValue(v);
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Escape') { setEditingStepId(null); setEditingMoveStepId(null); setEditingRotateStepId(null); return; }
                          if (e.key !== 'Enter') return;
                          const parsed = parseFloat(editValue as string);
                          if (isNaN(parsed)) return;
                          if (s.stepType === 'extrude') saveStep(activePanelId, s.id, parsed);
                          else saveTransformStep(activePanelId, s.id, parsed);
                        }}
                        className="flex-1 min-w-0 h-[22px] text-center font-mono text-[12px] font-medium tabular-nums text-stone-800 bg-white border border-[#e6e0d6] rounded-[6px] outline-none focus:border-orange-400/60 focus:shadow-[0_0_0_2px_rgba(249,115,22,0.10)]" />
                      <button onClick={() => {
                        const parsed = parseFloat(editValue as string);
                        if (isNaN(parsed)) return;
                        if (s.stepType === 'extrude') saveStep(activePanelId, s.id, parsed);
                        else saveTransformStep(activePanelId, s.id, parsed);
                      }} style={iconBtn('#5b5346')}><Check size={11} /></button>
                      <button onClick={() => { setEditingStepId(null); setEditingMoveStepId(null); setEditingRotateStepId(null); }} style={iconBtn('#a8a29e')}><X size={11} /></button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 pl-1 font-mono text-[12px] font-medium text-stone-700 tabular-nums">{s.value}{s.stepType === 'rotate' ? '\u00B0' : ''}</span>
                      {s.stepType === 'extrude' && s.isFixed !== undefined && (
                        <span className="shrink-0 text-[9.5px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px] bg-[#f3efe8] text-stone-500">{(s.original as any)?.refShapeId ? 'R' : s.isFixed ? 'F' : 'D'}</span>
                      )}
                      {/* Referans bağlı adım (taşıma/dönüş) — açı/mesafe referanstan
                          çözülür, elle düzenlenemez: R olarak işaretlenir. */}
                      {s.stepType !== 'extrude' && (s.original as any)?.refTargetPanelId && (
                        <span className="shrink-0 text-[9.5px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px] bg-[#f3efe8] text-stone-500">R</span>
                      )}
                      {!(s.stepType === 'extrude' && (s.original as any)?.refShapeId)
                        && !(s.stepType === 'rotate' && (s.original as any)?.refTargetPanelId) && (
                        <button onClick={() => {
                          if (s.stepType === 'extrude') { setEditingStepId(s.id); setEditingStepValue(String(s.value)); }
                          else if (s.stepType === 'move') { setEditingMoveStepId(s.id); setEditingMoveStepValue(String(s.value)); }
                          else { setEditingRotateStepId(s.id); setEditingRotateStepValue(String(s.value)); }
                        }} style={iconBtn('#a8a29e')} className="hover:!bg-[#f3efe8] hover:!text-stone-700"><Pencil size={10.5} strokeWidth={1.9} /></button>
                      )}
                      <button onClick={async () => {
                        const ps = shapes.find(x => x.id === activePanelId); if (!ps) return;
                        if (s.stepType === 'extrude') {
                          const { deleteExtrudeStep } = await import('./FaceExtrudeService');
                          await deleteExtrudeStep(ps, s.id, updateShape);
                        } else {
                          const { deleteTransformStep } = await import('./PanelTransformService');
                          await deleteTransformStep(ps, s.id, shapes, updateShape);
                        }
                      }} style={iconBtn('#a8a29e')} className="opacity-0 group-hover/step:opacity-100 hover:!bg-red-50 hover:!text-red-500 transition-opacity"><Trash2 size={10.5} strokeWidth={1.9} /></button>
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

  // ── AÇILAN SATIR GÖVDESİ (eski ayrı "önizleme ekranı"nın yerine) ────────
  // Satırın hemen altında, aynı kartın içinde aşağı doğru açılır: araç
  // düğmeleri (Extrude / Taşı / Döndür) → panel önizlemesi (+ aktif şerit) →
  // işlem adımları. Tüm mantık öncekiyle aynı; yalnız yerleşim değişti.
  const renderExpandedBody = (
    vf: any, vp: any,
    st: { isExtrudingThis: boolean; isMovingThis: boolean; isRotatingThis: boolean },
  ) => {
    const toolBtn = (label: string, Icon: LucideIcon, active: boolean, onClick: () => void, title: string) => (
      <button type="button" disabled={!vf.hasPanel} title={title}
        onClick={e => { stop(e); if (vp) onClick(); }}
        className={`h-[26px] min-w-0 flex items-center justify-center gap-1.5 rounded-[7px] text-[11px] font-semibold tracking-[0.01em] transition-[background-color,color,box-shadow] duration-150
          ${!vf.hasPanel ? 'bg-white ring-1 ring-[#efeae2] text-stone-300 cursor-not-allowed'
            : active ? 'bg-[#44403c] text-white ring-1 ring-[#44403c] shadow-[0_1px_3px_rgba(40,30,20,0.22)]'
            : 'bg-white ring-1 ring-[#e6e0d6] text-stone-600 shadow-[0_1px_0_rgba(40,30,20,0.03)] hover:bg-[#faf7f2] hover:ring-[#dcd4c8] hover:text-stone-800'}`}>
        <Icon size={12} strokeWidth={2} />{label}
      </button>
    );
    return (
      <div className="yago-expand px-2 pt-2 pb-2" style={{ borderTop: '1px solid #f3e6d6' }} onClick={stop}>
        {/* Ayraç inline: bone-skin'in genel .border-t "bölüm ayracı" kuralı (margin + soluk çizgi) burada istenmiyor. */}
        <div className="grid grid-cols-3 gap-1 mb-1.5">
          {toolBtn('Extrude', MoveVertical, st.isExtrudingThis, () => {
            if (st.isExtrudingThis) setFaceExtrudeMode(false);
            else { setFaceExtrudeTargetPanelId(vp.id); setFaceExtrudeMode(true); if (panelMoveMode) setPanelMoveMode(false); }
          }, 'Yüz çıkıntısı (extrude)')}
          {toolBtn('Taşı', Move, st.isMovingThis, () => {
            if (st.isMovingThis) setPanelMoveMode(false);
            else { setPanelMoveTargetPanelId(vp.id); setPanelMoveMode(true); if (faceExtrudeMode) setFaceExtrudeMode(false); }
          }, 'Taşı (move)')}
          {toolBtn('Döndür', RotateCw, st.isRotatingThis, () => {
            if (st.isRotatingThis) setPanelRotateMode(false);
            else { setPanelRotateTargetPanelId(vp.id); setPanelRotateMode(true); if (faceExtrudeMode) setFaceExtrudeMode(false); if (panelMoveMode) setPanelMoveMode(false); }
          }, 'Döndür (rotation)')}
        </div>

        <div className="rounded-[10px] ring-1 ring-[#e9e4dc] overflow-hidden relative" style={{ height: 410, background: PREVIEW_BG }}>
          {activeDims && activePanel
            ? <PanelPreview2D key={activePanel.id} dims={activeDims} shape={activePanel} arrowRotated={!!activePanel.parameters?.arrowRotated}/>
            : (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xs text-stone-400">Panel yok</span>
              </div>
            )
          }
        </div>
        {extrudeDock}
        {moveDock}
        {rotateDock}

        {stepsPanel}
      </div>
    );
  };

  // ── List pane ──────────────────────────────────────────────────────────
  const listPane = (
    <div className="flex flex-col h-full min-h-0">
      <style>{`@keyframes yagoExpand{from{opacity:0;clip-path:inset(0 0 100% 0);transform:translateY(-4px)}to{opacity:1;clip-path:inset(0 0 0 0);transform:none}}.yago-expand{animation:yagoExpand 260ms cubic-bezier(.2,.7,.2,1) both}`}</style>
      <div className="px-3 py-2 border-b border-stone-100 flex items-center justify-between shrink-0">
        {panelToolbar}
      </div>
      {selectedShape ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-1.5 pt-1.5 pb-2 space-y-[2px]">
            {renderFaceList()}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-stone-400 text-xs py-4">No shape selected</div>
        </div>
      )}
    </div>
  );

  if (embedded) return (
    <div className="flex flex-col h-full min-h-0">
      {listPane}
    </div>
  );

  return (
    <div className="fixed bg-white rounded-xl shadow-xl border border-stone-200 z-50 overflow-hidden" style={{ left: `${position.x}px`, top: `${position.y}px`, width: isPreviewMode ? '540px' : '400px', transition: 'width 0.2s ease' }}>
      <div className="flex items-center justify-between px-3 py-2 bg-stone-50 border-b border-stone-200 select-none" style={{ cursor: isDraggingWindow ? 'grabbing' : 'grab' }} onMouseDown={handleMouseDown}>
        <div className="flex items-center gap-2"><GripVertical size={13} className="text-stone-300"/><span className="text-xs font-semibold text-stone-600 tracking-wide uppercase">Panel Editor</span></div>
        <div className="flex items-center gap-1.5">{panelToolbar}<button onClick={onClose} className="p-1 hover:bg-stone-200 rounded-md transition-colors"><X size={13} className="text-stone-400"/></button></div>
      </div>
      <div style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
        <div className="p-1.5 space-y-[2px]">{renderFaceList()}</div>
      </div>
    </div>
  );
}
