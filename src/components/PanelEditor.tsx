import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, GripVertical, RotateCw, Trash2, MoveVertical, Check, Pencil, Shapes, ChevronRight } from 'lucide-react';
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

function getDimsFromGeo(geo: THREE.BufferGeometry, arrowRotated?: boolean) {
  const r = geoAxes(geo); if (!r) return null;
  const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
  const [def, alt] = [pa[0], pa[1]];
  const target = arrowRotated ? alt : def, secondary = pa.find(a => a !== target) ?? pa[0], s = [r.size.x, r.size.y, r.size.z];
  return { primary: r1(s[target]), secondary: r1(s[secondary]), thickness: r1(s[r.axes[0].i]), w: r1(r.size.x), h: r1(r.size.y), d: r1(r.size.z) };
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

/* ── Panel Preview — consistent dimetric view, orbit L/R, ground dims ── */
function PanelPreview2D({ shape, arrowRotated }: { dims: Dims; shape?: any; arrowRotated?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
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
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    r.setPixelRatio(window.devicePixelRatio);
    r.setClearColor(0x000000, 0);
    rendererRef.current = r;

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
    return () => { cancelAnimationFrame(raf); ro.disconnect(); r.dispose(); rendererRef.current = null; };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current, canvas = canvasRef.current;
    const shape = shapeRef.current, arrowRotated = arrowRotatedRef.current;
    const { w, h } = canvasSize;
    if (!renderer || !canvas || !shape?.geometry || w <= 0 || h <= 0) return;

    const dpr = window.devicePixelRatio;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    renderer.setSize(w, h, false);

    const disposables: Array<{ dispose: () => void }> = [];
    const scene = new THREE.Scene();

    const material = new THREE.MeshStandardMaterial({ color: 0xece5d8, roughness: 0.72, metalness: 0.0, side: THREE.DoubleSide });
    disposables.push(material);
    scene.add(new THREE.Mesh(shape.geometry, material));

    const edgesGeo = new THREE.EdgesGeometry(shape.geometry, 18);
    const lineGeo = new LineSegmentsGeometry().fromEdgesGeometry(edgesGeo);
    const lineMat = new LineMaterial({ color: 0x44403c, linewidth: 1.5, worldUnits: false, alphaToCoverage: true });
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

    // Consistent frame: width = larger planar extent, height = smaller, n = w×h.
    const planar = [0, 1, 2].filter(i => i !== minIdx);
    const e0 = sz.getComponent(planar[0]), e1 = sz.getComponent(planar[1]);
    let wIdx = e0 >= e1 ? planar[0] : planar[1];
    let hIdx = e0 >= e1 ? planar[1] : planar[0];
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

    scene.add(new THREE.HemisphereLight(0xfff7ec, 0x8c8170, 0.62));
    scene.add(new THREE.AmbientLight(0xffffff, 0.16));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.copy(nDir).multiplyScalar(3).addScaledVector(hDir, 2).addScaledVector(wDir, 1.4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xeaf0ff, 0.20);
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

    const padH = 1.12, padV = 1.12;
    const halfV = maxV * padV;
    const dockRoom = halfV * 0.42;
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
          filter: 'drop-shadow(0 12px 18px rgba(60,45,30,0.22)) drop-shadow(0 2px 3px rgba(60,45,30,0.14))',
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
              <line x1={d.fa.x} y1={d.fa.y} x2={d.da.x} y2={d.da.y} stroke="#b3a89a" strokeWidth="0.9"/>
              <line x1={d.fb.x} y1={d.fb.y} x2={d.db.x} y2={d.db.y} stroke="#b3a89a" strokeWidth="0.9"/>
              <line x1={d.da.x} y1={d.da.y} x2={d.db.x} y2={d.db.y} stroke="#8c857e" strokeWidth="1.2"/>
              <polygon points={`${d.da.x},${d.da.y} ${d.da.x+ux*asz+px*asz*0.45},${d.da.y+uy*asz+py*asz*0.45} ${d.da.x+ux*asz-px*asz*0.45},${d.da.y+uy*asz-py*asz*0.45}`} fill="#8c857e"/>
              <polygon points={`${d.db.x},${d.db.y} ${d.db.x-ux*asz+px*asz*0.45},${d.db.y-uy*asz+py*asz*0.45} ${d.db.x-ux*asz-px*asz*0.45},${d.db.y-uy*asz-py*asz*0.45}`} fill="#8c857e"/>
              <rect x={d.cx - lw / 2} y={d.cy - lh / 2} width={lw} height={lh} rx={4} fill="rgba(248,245,240,0.97)" stroke="#cfc8bd" strokeWidth="0.7"/>
              <text x={d.cx} y={d.cy + fsG * 0.36} textAnchor="middle" fontSize={fsG} fill="#1c1917" fontFamily="monospace" fontWeight="700">{txt}</text>
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
    showVirtualFaces, setShowVirtualFaces, virtualFaces, updateVirtualFace, deleteVirtualFace, reorderVirtualFaces, reorderVirtualFaceGroup, pendingPanelCreation,
    faceExtrudeMode, setFaceExtrudeMode, faceExtrudeTargetPanelId,
    setFaceExtrudeTargetPanelId, faceExtrudeSelectedFace, setFaceExtrudeSelectedFace, setFaceExtrudeHoveredFace,
    faceExtrudeThickness, setFaceExtrudeThickness, faceExtrudeFixedMode, setFaceExtrudeFixedMode,
    faceExtrudeClickPoint } = useAppStore();

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [isDraggingWindow, setIsDraggingWindow] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editingStepValue, setEditingStepValue] = useState(0);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
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
    ? getDimsFromGeo(activePanel.geometry, activePanel.parameters?.arrowRotated)
    : null;
  const activeSteps = activePanel?.parameters?.extrudeSteps || [];

  const { selectedPanelRowParentId } = useAppStore();
  useEffect(() => {
    if (selectedShapeId !== useAppStore.getState().selectedPanelRowParentId)
      setSelectedPanelRow(null);
  }, [selectedShapeId]);

  useEffect(() => {
    const currentShapes = useAppStore.getState().shapes;
    const pending = virtualFaces.filter(vf =>
      !vf.hasPanel &&
      !vf.panelRemovedByUser &&
      !currentShapes.some(s => s.type === 'panel' && s.parameters?.virtualFaceId === vf.id)
    );
    if (!pending.length) return;
    (async () => {
      const { createPanelFromVirtualFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');
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
            parameters: { width: s[def], height: s[alt], depth: PANEL_THICKNESS, parentShapeId: parentShape.id, faceIndex: -(vi + 1), virtualFaceId: vf.id, arrowRotated: false },
          }));
          updateVirtualFace(vf.id, { hasPanel: true });
        } catch (e) { console.error('Auto panel creation failed:', e); }
      }
    })();
  }, [virtualFaces]);

  useEffect(() => {
    if (faceExtrudeMode && activePanelId && activePanelId !== faceExtrudeTargetPanelId)
      { setFaceExtrudeTargetPanelId(activePanelId); setFaceExtrudeSelectedFace(null); setFaceExtrudeHoveredFace(null); }
  }, [faceExtrudeMode, activePanelId, faceExtrudeTargetPanelId]);

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

  useEffect(() => { if (!(isOpen || embedded)) { setSelectedPanelRow(null); setPanelSelectMode(false); if (faceExtrudeMode) setFaceExtrudeMode(false); } }, [isOpen, embedded]);
  useEffect(() => { if (selectedPanelRow !== null) rowRefs.current.get(selectedPanelRow)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [selectedPanelRow]);

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
          parameters: { width: 0, height: 0, depth: PANEL_THICKNESS, parentShapeId: cs.id, faceIndex: -(vi+1), virtualFaceId: vf.id } }));
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
  const faceListSection = selectedShape ? (() => {
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

    const normalKey = (vf: typeof svf[0]) => {
      const nStr = vf.normal.map(n => (Math.round(n * 10) / 10).toFixed(1)).join(',');
      const [nx, ny, nz] = vf.normal;
      const [cx, cy, cz] = vf.center;
      const planeOffset = (Math.round((nx * cx + ny * cy + nz * cz) * 2) / 2).toFixed(1);
      return `${nStr}@${planeOffset}`;
    };
    const groupOrder: string[] = [];
    const groupMap = new Map<string, typeof svf>();
    for (const vf of svf) {
      const k = normalKey(vf);
      if (!groupMap.has(k)) { groupMap.set(k, []); groupOrder.push(k); }
      groupMap.get(k)!.push(vf);
    }
    const faceGroupsList = groupOrder.map(k => groupMap.get(k)!);
    const orderedVfs = faceGroupsList.flat();

    const createVP = async (_: string, vi: number) => {
      const vf = svf[vi]; if (!vf) return;
      try {
        const { createPanelFromVirtualFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');
        const rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, PANEL_THICKNESS); if (!rp) return;
        const g = convertReplicadToThreeGeometry(rp), r = geoAxes(g); if (!r) return;
        const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b), [def, alt] = [pa[0], pa[1]], s = [r.size.x, r.size.y, r.size.z];
        addShape(makePanelBase(selectedShape, { geometry: g, replicadShape: rp,
          parameters: { width: s[def], height: s[alt], depth: PANEL_THICKNESS, parentShapeId: sid, faceIndex: -(vi+1), virtualFaceId: vf.id, arrowRotated: false } }));
        updateVirtualFace(vf.id, { hasPanel: true, panelRemovedByUser: false });
      } catch (e) { console.error('Failed to create virtual panel:', e); }
    };
    const removeVP = (vfId: string) => {
      const p = findVPanel(shapes, sid, vfId);
      if (p) useAppStore.getState().deleteShape(p.id);
      updateVirtualFace(vfId, { hasPanel: false, panelRemovedByUser: true });
      if (selectedPanelRow === `vf-${vfId}`) setSelectedPanelRow(null);
    };

    const onGroupDrop = async (draggedGroupKey: string, targetGroupKey: string) => {
      setDragIndex(null); setDropIndex(null);
      if (draggedGroupKey === targetGroupKey) return;
      const draggedGroup = groupMap.get(draggedGroupKey)!;
      const targetGroup = groupMap.get(targetGroupKey)!;
      reorderVirtualFaceGroup(sid, draggedGroup.map(v => v.id), targetGroup[0].id);
      const { rebuildPanelsForParent } = await import('./PanelRebuildService');
      await rebuildPanelsForParent(sid);
    };
    const onGroupDropAtEnd = async (draggedGroupKey: string) => {
      setDragIndex(null); setDropIndex(null);
      const draggedGroup = groupMap.get(draggedGroupKey)!;
      reorderVirtualFaceGroup(sid, draggedGroup.map(v => v.id), null);
      const { rebuildPanelsForParent } = await import('./PanelRebuildService');
      await rebuildPanelsForParent(sid);
    };

    const elements: React.ReactNode[] = [];
    let globalIdx = 0;

    faceGroupsList.forEach((group, gi) => {
      const groupKey = normalKey(group[0]);
      const isGroupMulti = group.length > 1;
      const isDraggingThisGroup = dragIndex !== null && group.some(vf => {
        const idx = orderedVfs.findIndex(v => v.id === vf.id);
        return idx === dragIndex;
      });
      const isDropTargetGroup = dropIndex !== null && (() => {
        const firstIdx = orderedVfs.findIndex(v => v.id === group[0].id);
        return dropIndex === firstIdx;
      })();

      group.forEach((vf, subIdx) => {
        const vi = svf.findIndex(v => v.id === vf.id);
        const displayIdx = globalIdx + 1;
        globalIdx++;
        const orderedIdx = orderedVfs.findIndex(v => v.id === vf.id);
        const vp = findVPanel(shapes, sid, vf.id), ar = vp?.parameters?.arrowRotated||false, sel = selectedPanelRow === `vf-${vf.id}`;
        const dims = vp?.geometry ? getDimsFromGeo(vp.geometry, ar) : null;
        const isFirst = subIdx === 0;
        const isLast = subIdx === group.length - 1;

        elements.push(
          <div
            key={vf.id}
            onDragOver={e => {
              if (dragIndex !== null) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const firstIdx = orderedVfs.findIndex(v => v.id === group[0].id);
                if (dropIndex !== firstIdx) setDropIndex(firstIdx);
              }
            }}
            onDragLeave={e => {
              const firstIdx = orderedVfs.findIndex(v => v.id === group[0].id);
              if (dropIndex === firstIdx) setDropIndex(null);
            }}
            onDrop={e => {
              e.preventDefault();
              if (dragIndex === null) return;
              const draggingVf = orderedVfs[dragIndex];
              const draggingKey = normalKey(draggingVf);
              if (isFirst) onGroupDrop(draggingKey, groupKey);
            }}
            onClick={e => { stop(e); setSelectedPanelRow(`vf-${vf.id}`, null, sid); }}
            className={`
              group relative flex items-center gap-1 pl-2 pr-1 py-1 cursor-pointer
              transition-all duration-150 select-none
              ${isGroupMulti && isFirst ? 'rounded-t-lg' : ''}
              ${isGroupMulti && isLast ? 'rounded-b-lg' : ''}
              ${!isGroupMulti ? 'rounded-lg' : ''}
              ${sel
                ? 'bg-orange-50 ring-1 ring-orange-300 shadow-sm'
                : isGroupMulti
                  ? 'hover:bg-sky-50/60 ring-1 ring-transparent hover:ring-sky-200/70'
                  : 'hover:bg-stone-50 ring-1 ring-transparent hover:ring-stone-200'}
              ${isDraggingThisGroup ? 'opacity-40' : ''}
              ${isDropTargetGroup && isFirst ? 'ring-1 ring-blue-400 bg-blue-50' : ''}
              ${isGroupMulti && !isFirst ? 'border-t border-sky-100/80' : ''}
            `}
          >
            {isGroupMulti && (
              <div className={`absolute left-[18px] w-px bg-sky-200
                ${isFirst ? 'top-1/2 bottom-0' : isLast ? 'top-0 bottom-1/2' : 'top-0 bottom-0'}
              `} style={{ zIndex: 0 }} />
            )}

            <span
              draggable
              onDragStart={e => {
                stop(e);
                setDragIndex(orderedIdx);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', groupKey);
              }}
              onDragEnd={() => { setDragIndex(null); setDropIndex(null); }}
              onClick={stop}
              className="cursor-grab active:cursor-grabbing text-stone-300 hover:text-stone-500 shrink-0 relative z-10 flex items-center justify-center w-4"
              title={isGroupMulti ? 'Drag to move entire face group' : 'Drag to reorder'}
            ><GripVertical size={14}/></span>

            {isGroupMulti && !isFirst ? (
              <span className="shrink-0 w-5 h-5 flex items-center justify-center relative z-10">
                <span className="w-1.5 h-1.5 rounded-full bg-sky-300" />
              </span>
            ) : (
              <span className={`shrink-0 inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full text-[11px] font-semibold font-mono tabular-nums relative z-10 transition-colors
                ${sel ? 'bg-orange-500 text-white shadow-sm' : 'bg-stone-100 text-stone-500 ring-1 ring-stone-200/70'}`}>
                {displayIdx}
              </span>
            )}

            <input
              type="text"
              value={vf.description||''}
              onClick={stop}
              onChange={e => updateVirtualFace(vf.id, { description: e.target.value })}
              placeholder="not…"
              className="flex-1 min-w-0 px-1.5 py-1 text-xs bg-transparent border-b border-transparent hover:border-stone-300 focus:border-orange-400 rounded-none outline-none text-stone-700 placeholder:text-stone-300 transition-colors"
            />

            {dims && (
              <span onClick={stop}
                className="shrink-0 inline-flex items-center text-xs leading-none tabular-nums px-0.5">
                <span className="text-stone-400 font-medium">W</span><span className="text-stone-700 font-semibold ml-1">{dims.primary}</span>
                <span className="text-stone-300 mx-1.5">·</span>
                <span className="text-stone-400 font-medium">H</span><span className="text-stone-700 font-semibold ml-1">{dims.secondary}</span>
                <span className="text-stone-300 mx-1.5">·</span>
                <span className="text-stone-400 font-medium">T</span><span className="text-stone-700 font-semibold ml-1">{dims.thickness}</span>
              </span>
            )}

            <div className="flex items-center gap-0.5 shrink-0" onClick={stop}>
              <button onClick={async () => { if (vf.hasPanel) removeVP(vf.id); else await createVP(vf.id, vi); }}
                className="w-[22px] h-[22px] rounded-md flex items-center justify-center text-stone-400 hover:bg-stone-100 transition-colors"
                title={vf.hasPanel ? 'Paneli kaldır' : 'Panel oluştur'}>
                <span className={`w-3.5 h-3.5 rounded-[3px] border flex items-center justify-center transition-colors ${vf.hasPanel ? 'bg-orange-500 border-orange-500' : 'border-stone-300'}`}>
                  {vf.hasPanel && <Check size={10} strokeWidth={3} className="text-white"/>}
                </span>
              </button>

              <button disabled={!vf.hasPanel} onClick={e => { stop(e); toggleArrow(vp); }}
                className={`w-[22px] h-[22px] rounded-md flex items-center justify-center transition-colors ${!vf.hasPanel ? 'text-stone-200 cursor-not-allowed' : ar ? 'text-orange-500 hover:bg-stone-100' : 'text-stone-400 hover:bg-stone-100 hover:text-stone-600'}`}
                title="Oku döndür"><RotateCw size={13}/></button>

              <button disabled={!vf.hasPanel||!vp} onClick={async e => {
                stop(e); if (!vp) return;
                const { reshapePanelToParentFace } = await import('./PanelReshapeService');
                await reshapePanelToParentFace(vp.id);
              }}
                className={`w-[22px] h-[22px] rounded-md flex items-center justify-center transition-colors ${!vf.hasPanel||!vp ? 'text-stone-200 cursor-not-allowed' : 'text-stone-400 hover:bg-stone-100 hover:text-stone-600'}`}
                title="Ana yüze eşitle"><Shapes size={13}/></button>

              <button onClick={e => { stop(e); if (vf.hasPanel) removeVP(vf.id); deleteVirtualFace(vf.id); }}
                className="w-[22px] h-[22px] rounded-md flex items-center justify-center text-stone-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                title="Yüzü sil"><Trash2 size={13}/></button>
            </div>
          </div>
        );
      });

      if (gi < faceGroupsList.length - 1) {
        elements.push(<div key={`gap-${gi}`} className="h-px" />);
      }
    });

    elements.push(
      <div
        key="drop-end"
        className={`h-2 rounded transition-all ${dropIndex === -1 ? 'bg-blue-100 ring-1 ring-blue-300' : ''}`}
        onDragOver={e => { if (dragIndex !== null) { e.preventDefault(); setDropIndex(-1); } }}
        onDragLeave={() => { if (dropIndex === -1) setDropIndex(null); }}
        onDrop={e => {
          e.preventDefault();
          if (dragIndex === null) return;
          const draggingVf = orderedVfs[dragIndex];
          const draggingKey = normalKey(draggingVf);
          onGroupDropAtEnd(draggingKey);
        }}
      />
    );

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
    const ar = !!activePanel.parameters?.arrowRotated;

    const seg = (f: boolean): React.CSSProperties => ({
      flex: 1, minWidth: 44, height: 24, fontSize: 10, fontWeight: 700, letterSpacing: '0.02em',
      border: 'none', outline: 'none', cursor: hf ? 'pointer' : 'not-allowed',
      borderLeft: !f ? '1px solid rgba(60,50,40,0.10)' : 'none',
      background: faceExtrudeFixedMode === f ? 'linear-gradient(180deg,#f97316,#ea580c)' : 'rgba(255,255,255,0.65)',
      color: faceExtrudeFixedMode === f ? '#fff' : '#78716c', transition: 'all 0.12s',
    });

    const onApply = async () => {
      if (!hf || !activePanelId) return;
      const ps = shapes.find(s => s.id === activePanelId); if (!ps) return;
      const { executeFaceExtrude } = await import('./FaceExtrudeService');
      const vfId = ps.parameters?.virtualFaceId as string | undefined;
      const vf = vfId ? virtualFaces.find(f => f.id === vfId) : undefined;
      await executeFaceExtrude({
        panelShape: ps, faceGroupIndex: faceExtrudeSelectedFace!,
        value: faceExtrudeThickness, isFixed: faceExtrudeFixedMode,
        shapes, updateShape, clickPoint: faceExtrudeClickPoint ?? undefined,
        virtualFaceId: vfId,
        vfNormal: vf?.normal as [number, number, number] | undefined,
        vfVertex0: vf?.vertices?.[0] as [number, number, number] | undefined,
        updateVirtualFace,
      });
      setFaceExtrudeSelectedFace(null);
      setFaceExtrudeMode(false);
    };

    return (
      <div style={{
        position: 'absolute', left: 8, right: 8, bottom: 8, zIndex: 5, borderRadius: 11,
        background: 'linear-gradient(180deg,rgba(250,248,244,0.82),rgba(240,236,228,0.88))',
        backdropFilter: 'blur(16px) saturate(160%)', WebkitBackdropFilter: 'blur(16px) saturate(160%)',
        border: '1px solid rgba(60,50,40,0.12)',
        boxShadow: '0 8px 22px -10px rgba(40,30,20,0.28),0 0 0 0.5px rgba(60,50,40,0.05),inset 0 1px 0 rgba(255,255,255,0.92)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
      }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, rowGap: 6, padding: '7px 9px' }}>
          <svg width="22" height="22" viewBox="0 0 28 28" style={{ flexShrink: 0, transform: ar ? 'none' : 'rotate(90deg)', transition: 'transform 0.25s ease' }}>
            <circle cx="14" cy="14" r="13" fill="rgba(68,64,60,0.9)" />
            <circle cx="14" cy="14" r="13" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.75" />
            <line x1="14" y1="20" x2="14" y2="9" stroke="#f5f1ea" strokeWidth="2" strokeLinecap="round" />
            <polygon points="14,5 10,11 18,11" fill="#f5f1ea" />
          </svg>

          <div style={{ width: 1, height: 18, flexShrink: 0, background: 'linear-gradient(to bottom,transparent,rgba(60,50,40,0.18),transparent)' }} />

          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#8c857e', flexShrink: 0 }}>Extrude</span>
          <button
            onClick={e => { stop(e); faceExtrudeMode ? setFaceExtrudeMode(false) : (setFaceExtrudeTargetPanelId(activePanelId), setFaceExtrudeMode(true)); }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 10px', borderRadius: 6,
              fontSize: 10.5, fontWeight: 700, cursor: 'pointer', border: 'none', outline: 'none', flexShrink: 0,
              background: isExt ? 'linear-gradient(180deg,#f97316,#ea580c)' : 'linear-gradient(180deg,#fff,#f1ede6)',
              color: isExt ? '#fff' : '#57534e',
              boxShadow: isExt
                ? '0 1px 2px rgba(234,88,12,0.4),inset 0 1px 0 rgba(255,255,255,0.25)'
                : '0 1px 2px rgba(40,30,20,0.08),0 0 0 0.5px rgba(60,50,40,0.12),inset 0 1px 0 rgba(255,255,255,0.9)',
              transition: 'all 0.15s',
            }}
          >
            <MoveVertical size={10} />{isExt ? 'Active' : 'Enable'}
          </button>

          {isExt && (hf ? (
            <>
              <input
                type="text" inputMode="numeric" value={faceExtrudeThickness}
                onChange={e => setFaceExtrudeThickness(Number(e.target.value) || 0)}
                style={{
                  width: 52, height: 26, textAlign: 'center', fontFamily: 'monospace', fontSize: 12, fontWeight: 600,
                  color: '#1c1917', background: 'linear-gradient(180deg,#fff,#fbfaf6)', border: '1px solid rgba(60,50,40,0.16)',
                  borderRadius: 6, outline: 'none', boxShadow: 'inset 0 1px 2px rgba(40,30,20,0.05)', flexShrink: 0,
                }}
              />
              <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(60,50,40,0.16)', flexShrink: 0 }}>
                {[true, false].map(f => (
                  <button key={String(f)} onClick={() => setFaceExtrudeFixedMode(f)} style={seg(f)}>{f ? 'Fixed' : 'Dyn'}</button>
                ))}
              </div>
              <button onClick={onApply} style={{
                height: 26, padding: '0 12px', borderRadius: 6, border: 'none', cursor: 'pointer', outline: 'none', flexShrink: 0,
                display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, letterSpacing: '0.01em',
                background: 'linear-gradient(180deg,#f97316,#ea580c)', color: '#fff',
                boxShadow: '0 2px 6px -1px rgba(234,88,12,0.42),inset 0 1px 0 rgba(255,255,255,0.28)',
              }}>
                <Check size={12} /> Uygula
              </button>
            </>
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 7, flexShrink: 0,
              background: 'rgba(234,88,12,0.07)', border: '1px solid rgba(234,88,12,0.16)',
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#ea580c' }} />
              <span style={{ fontSize: 10.5, fontWeight: 500, color: '#9a3412' }}>3D görünümde yüzey seç</span>
            </div>
          ))}
        </div>

        {activeSteps.length > 0 && (
          <div style={{ borderTop: '1px solid rgba(60,50,40,0.08)', padding: '6px 9px', display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto' }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#a8a29e', flexShrink: 0 }}>Adımlar</span>
            {activeSteps.map((s: any) => (
              editingStepId === s.id ? (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 6px', borderRadius: 6, background: 'rgba(234,88,12,0.08)', border: '1px solid rgba(234,88,12,0.22)', flexShrink: 0 }}>
                  <span style={{ fontSize: 9, fontWeight: 800, fontFamily: 'monospace', color: '#ea580c' }}>{s.axisLabel}</span>
                  <input type="text" inputMode="numeric" autoFocus value={editingStepValue}
                    onChange={e => setEditingStepValue(Number(e.target.value) || 0)}
                    onKeyDown={e => { if (e.key === 'Enter') saveStep(activePanelId, s.id, editingStepValue); else if (e.key === 'Escape') setEditingStepId(null); }}
                    style={{ width: 46, height: 20, textAlign: 'center', fontFamily: 'monospace', fontSize: 10.5, fontWeight: 600, color: '#1c1917', background: '#fff', border: '1px solid rgba(234,88,12,0.4)', borderRadius: 4, outline: 'none' }} />
                  <button onClick={() => saveStep(activePanelId, s.id, editingStepValue)} style={iconBtn('#ea580c')}><Check size={11} /></button>
                  <button onClick={() => setEditingStepId(null)} style={iconBtn('#a8a29e')}><X size={11} /></button>
                </div>
              ) : (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 7px', borderRadius: 6, background: 'linear-gradient(180deg,rgba(255,255,255,0.7),rgba(244,241,234,0.55))', border: '1px solid rgba(60,50,40,0.10)', flexShrink: 0 }}>
                  <span style={{ fontSize: 9, fontWeight: 800, fontFamily: 'monospace', color: '#ea580c' }}>{s.axisLabel}</span>
                  <span style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: '#1c1917' }}>{s.value}</span>
                  <span style={{ fontSize: 7.5, fontWeight: 700, padding: '1px 4px', borderRadius: 3, background: s.isFixed ? 'rgba(234,88,12,0.12)' : 'rgba(120,113,108,0.12)', color: s.isFixed ? '#c2410c' : '#78716c' }}>{s.isFixed ? 'F' : 'D'}</span>
                  <button onClick={() => { setEditingStepId(s.id); setEditingStepValue(s.value); }} style={iconBtn('#ea580c')}><Pencil size={10} /></button>
                  <button onClick={async () => {
                    const ps = shapes.find(x => x.id === activePanelId); if (!ps) return;
                    const { deleteExtrudeStep } = await import('./FaceExtrudeService');
                    await deleteExtrudeStep(ps, s.id, updateShape);
                  }} style={iconBtn('#ef4444')}><Trash2 size={10} /></button>
                </div>
              )
            ))}
          </div>
        )}
      </div>
    );
  })();

  // Thickness shown as a minimal "T" chip in the bottom-left — stays put while orbiting.
  const chipBottom = activeSteps.length > 0 ? 84 : 52;
  const thicknessChip = activeDims ? (
    <div style={{
      position: 'absolute', left: 10, bottom: chipBottom, zIndex: 6, display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '4px 9px', borderRadius: 8,
      background: 'rgba(250,248,244,0.9)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      border: '1px solid rgba(60,50,40,0.12)',
      boxShadow: '0 2px 8px -3px rgba(40,30,20,0.2),inset 0 1px 0 rgba(255,255,255,0.9)',
      fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
    }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', color: '#8c857e' }}>T</span>
      <span style={{ fontFamily: 'monospace', fontSize: 12.5, fontWeight: 700, color: '#1c1917' }}>{activeDims.thickness}</span>
    </div>
  ) : null;

  const isPreviewMode = selectedPanelRow !== null;

  const selectedFaceRow = (() => {
    if (!selectedShape || selectedPanelRow === null) return null;
    const sid = selectedShape.id;
    const svf = virtualFaces.filter(vf => vf.shapeId === sid);
    const vfId = typeof selectedPanelRow === 'string' && selectedPanelRow.startsWith('vf-')
      ? selectedPanelRow.replace('vf-', '') : null;
    if (!vfId) return null;
    const vi = svf.findIndex(f => f.id === vfId);
    const vf = svf[vi];
    if (!vf) return null;
    const vp = findVPanel(shapes, sid, vf.id);
    const ar = vp?.parameters?.arrowRotated || false;
    const dims = vp?.geometry ? getDimsFromGeo(vp.geometry, ar) : null;
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-orange-50 ring-1 ring-orange-300 shadow-sm select-none">
        <span className="shrink-0 inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full text-[11px] font-semibold font-mono tabular-nums bg-orange-500 text-white shadow-sm">
          {vi + 1}
        </span>
        <input
          type="text"
          value={vf.description || ''}
          onClick={stop}
          onChange={e => updateVirtualFace(vf.id, { description: e.target.value })}
          placeholder="not…"
          className="flex-1 min-w-0 px-1.5 py-1 text-xs bg-transparent border-b border-transparent hover:border-stone-300 focus:border-orange-400 rounded-none outline-none text-stone-700 placeholder:text-stone-300 transition-colors"
        />
        {dims && (
          <span className="shrink-0 inline-flex items-center text-xs leading-none tabular-nums px-0.5">
            <span className="text-stone-400 font-medium">W</span><span className="text-stone-700 font-semibold ml-1">{dims.primary}</span>
            <span className="text-stone-300 mx-1.5">·</span>
            <span className="text-stone-400 font-medium">H</span><span className="text-stone-700 font-semibold ml-1">{dims.secondary}</span>
            <span className="text-stone-300 mx-1.5">·</span>
            <span className="text-stone-400 font-medium">T</span><span className="text-stone-700 font-semibold ml-1">{dims.thickness}</span>
          </span>
        )}
        <div className="flex items-center gap-0.5 shrink-0" onClick={stop}>
          <button disabled={!vf.hasPanel} onClick={e => { stop(e); toggleArrow(vp); }}
            className={`w-[22px] h-[22px] rounded-md flex items-center justify-center transition-colors ${!vf.hasPanel ? 'text-stone-200 cursor-not-allowed' : ar ? 'text-orange-500 hover:bg-orange-100' : 'text-stone-400 hover:bg-orange-100/60 hover:text-stone-600'}`}
            title="Oku döndür"><RotateCw size={13}/></button>
          <button disabled={!vf.hasPanel || !vp} onClick={async e => {
            stop(e); if (!vp) return;
            const { reshapePanelToParentFace } = await import('./PanelReshapeService');
            await reshapePanelToParentFace(vp.id);
          }}
            className={`w-[22px] h-[22px] rounded-md flex items-center justify-center transition-colors ${!vf.hasPanel || !vp ? 'text-stone-200 cursor-not-allowed' : 'text-stone-400 hover:bg-orange-100/60 hover:text-stone-600'}`}
            title="Ana yüze eşitle"><Shapes size={13}/></button>
        </div>
      </div>
    );
  })();

  // ── Shared preview pane ────────────────────────────────────────────────
  const previewPane = isPreviewMode ? (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-stone-100 flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-1.5">{panelToolbar}</div>
        <button
          onClick={() => setSelectedPanelRow(null)}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold text-stone-500 hover:text-stone-800 hover:bg-stone-100 transition-all"
        >
          Liste <ChevronRight size={12}/>
        </button>
      </div>

      {selectedFaceRow && (
        <div className="px-2 pt-2 pb-1 shrink-0">
          {selectedFaceRow}
        </div>
      )}

      <div className="flex-1 mx-2 mb-2 rounded-xl bg-gradient-to-b from-[#f6f2ec] to-[#e7e1d6] border border-stone-200/80 overflow-hidden relative" style={{ minHeight: 380 }}>
        {activeDims && activePanel
          ? <PanelPreview2D key={activePanel.id} dims={activeDims} shape={activePanel} arrowRotated={!!activePanel.parameters?.arrowRotated}/>
          : (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xs text-stone-400">Panel yok</span>
            </div>
          )
        }
        {thicknessChip}
        {extrudeDock}
      </div>
    </div>
  ) : null;

  // ── List pane ──────────────────────────────────────────────────────────
  const listPane = (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-stone-100 flex items-center justify-between shrink-0">
        {panelToolbar}
      </div>
      {selectedShape ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-1.5 pt-1.5 pb-1.5 space-y-px">
            {faceListSection}
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
      {isPreviewMode ? previewPane : listPane}
    </div>
  );

  return (
    <div className="fixed bg-white rounded-xl shadow-xl border border-stone-200 z-50 overflow-hidden" style={{ left: `${position.x}px`, top: `${position.y}px`, width: isPreviewMode ? '540px' : '400px', transition: 'width 0.2s ease' }}>
      <div className="flex items-center justify-between px-3 py-2 bg-stone-50 border-b border-stone-200 select-none" style={{ cursor: isDraggingWindow ? 'grabbing' : 'grab' }} onMouseDown={handleMouseDown}>
        <div className="flex items-center gap-2"><GripVertical size={13} className="text-stone-300"/><span className="text-xs font-semibold text-stone-600 tracking-wide uppercase">Panel Editor</span></div>
        <div className="flex items-center gap-1.5">{panelToolbar}<button onClick={onClose} className="p-1 hover:bg-stone-200 rounded-md transition-colors"><X size={13} className="text-stone-400"/></button></div>
      </div>
      {isPreviewMode ? (
        <div style={{ height: 'min(86vh, 760px)', display: 'flex', flexDirection: 'column' }}>
          {previewPane}
        </div>
      ) : (
        <div style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
          <div className="p-2 space-y-0.5">{faceListSection}</div>
        </div>
      )}
    </div>
  );
}
