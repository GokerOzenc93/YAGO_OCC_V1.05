import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, GripVertical, RotateCw, Trash2, MoveVertical, Check, Pencil, Shapes, ChevronRight } from 'lucide-react';
import { useAppStore } from '../store';
import { extractFacesFromGeometry, groupCoplanarFaces, CoplanarFaceGroup } from './FaceEditor';
import { findExistingStepForFace } from './FaceExtrudeService';
import type { FilletData } from './Fillet';
import * as THREE from 'three';

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

/* ── Edge dimension label types ──────────────────────────────────────── */
interface EdgeDimLabel {
  sx: number; sy: number; // screen midpoint
  ex1: number; ey1: number; ex2: number; ey2: number; // screen endpoints
  length: number; // real-world length
  isThickness: boolean;
  nx: number; ny: number; // outward perpendicular (screen space, unit vector)
}

// Project a 3D point to canvas pixel coordinates via orthographic camera
function project3D(p: THREE.Vector3, camera: THREE.OrthographicCamera, w: number, h: number): { x: number; y: number } {
  const ndc = p.clone().project(camera);
  return { x: (ndc.x + 1) / 2 * w, y: (1 - ndc.y) / 2 * h };
}

// Collect the two principal dimension labels (longest H + longest V edge on top face)
// All top-face edge dimension labels — every planar edge segment on the top
// face gets its own annotation. Offset direction is always away from the
// panel material (outward from the panel centroid in screen space).
function computeAllEdgeDimLabels(
  geometry: THREE.BufferGeometry,
  camera: THREE.OrthographicCamera,
  w: number,
  h: number,
  thicknessAxis: number,
): EdgeDimLabel[] {
  const edgesGeo = new THREE.EdgesGeometry(geometry, 15);
  const pos = edgesGeo.getAttribute('position');
  if (!pos) { edgesGeo.dispose(); return []; }

  const keys = ['x', 'y', 'z'] as const;
  const thinKey = keys[thicknessAxis];
  const planarKeys = keys.filter((_, i) => i !== thicknessAxis) as Array<'x' | 'y' | 'z'>;

  const bbox = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const topZ = bbox.max[thinKey];
  const tol = (bbox.max[thinKey] - bbox.min[thinKey]) * 0.05 + 0.5;
  const center = new THREE.Vector3(); bbox.getCenter(center);
  center.setComponent(thicknessAxis, topZ);
  const screenCenter = project3D(center, camera, w, h);

  const labels: EdgeDimLabel[] = [];

  for (let i = 0; i < pos.count; i += 2) {
    const a = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const b = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const len3D = a.distanceTo(b);
    if (len3D < 1) continue;
    // Top face only
    if (Math.abs(mid[thinKey] - topZ) > tol) continue;
    // Not a thickness edge
    if (Math.abs(a[thinKey] - b[thinKey]) > len3D * 0.5) continue;

    // Must run primarily along one planar axis
    let axisMatch = false;
    for (const ak of planarKeys) {
      if (Math.abs(a[ak] - b[ak]) > len3D * 0.6) { axisMatch = true; break; }
    }
    if (!axisMatch) continue;

    const sa = project3D(a, camera, w, h);
    const sb = project3D(b, camera, w, h);
    const dx = sb.x - sa.x, dy = sb.y - sa.y;
    const slen = Math.hypot(dx, dy);
    if (slen < 4) continue;

    const midX = (sa.x + sb.x) / 2, midY = (sa.y + sb.y) / 2;
    let nx = -dy / slen, ny = dx / slen;
    if ((midX - screenCenter.x) * nx + (midY - screenCenter.y) * ny < 0) { nx = -nx; ny = -ny; }

    labels.push({
      sx: midX, sy: midY,
      ex1: sa.x, ey1: sa.y, ex2: sb.x, ey2: sb.y,
      length: Math.round(len3D),
      isThickness: false,
      nx, ny,
    });
  }

  edgesGeo.dispose();
  return labels;
}

// Per-subtraction dimension labels shown over the cut area.
function computeSubDimLabels(
  subGeos: any[],
  camera: THREE.OrthographicCamera,
  w: number,
  h: number,
  thicknessAxis: number,
): EdgeDimLabel[][] {
  const keys = ['x', 'y', 'z'] as const;
  const thinKey = keys[thicknessAxis];
  const planarKeys = keys.filter((_, i) => i !== thicknessAxis) as Array<'x' | 'y' | 'z'>;

  return subGeos.map(sg => {
    if (!sg?.geometry) return [];
    const pos = sg.geometry.getAttribute('position');
    if (!pos) return [];

    const rot = sg.relativeRotation || [0, 0, 0];
    const rotM = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
    const off = new THREE.Vector3(...((sg.relativeOffset || [0, 0, 0]) as number[]));

    const points: THREE.Vector3[] = [];
    for (let i = 0; i < pos.count; i++) {
      points.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(rotM).add(off));
    }
    const bbox = new THREE.Box3().setFromPoints(points);
    const topVal = bbox.max[thinKey];
    const boxCenter = new THREE.Vector3(); bbox.getCenter(boxCenter);

    const labels: EdgeDimLabel[] = [];
    for (let pi = 0; pi < planarKeys.length; pi++) {
      const ak = planarKeys[pi];
      const ok = planarKeys[1 - pi];

      const a = new THREE.Vector3(); const b = new THREE.Vector3();
      a[thinKey] = topVal; b[thinKey] = topVal;
      a[ak] = bbox.min[ak]; b[ak] = bbox.max[ak];
      a[ok] = boxCenter[ok]; b[ok] = boxCenter[ok];

      const sa = project3D(a, camera, w, h);
      const sb = project3D(b, camera, w, h);
      const dx = sb.x - sa.x, dy = sb.y - sa.y;
      const slen = Math.hypot(dx, dy);
      const nx = slen > 0 ? -dy / slen : 0;
      const ny = slen > 0 ? dx / slen : 0;
      labels.push({
        sx: (sa.x + sb.x) / 2, sy: (sa.y + sb.y) / 2,
        ex1: sa.x, ey1: sa.y, ex2: sb.x, ey2: sb.y,
        length: Math.round(bbox.max[ak] - bbox.min[ak]),
        isThickness: false, nx, ny,
      });
    }
    return labels;
  });
}

/* ── 2D Panel Preview — Three.js orthographic canvas render ─────────── */
function PanelPreview2D({ dims, shape, arrowRotated }: { dims: Dims; shape?: any; arrowRotated?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [edgeLabels, setEdgeLabels] = useState<EdgeDimLabel[]>([]);
  const [subLabelSets, setSubLabelSets] = useState<EdgeDimLabel[][]>([]);
  const [canvasSize, setCanvasSize] = useState({ w: 320, h: 300 });

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas || !shape?.geometry) return;

    let disposed = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let material: THREE.MeshLambertMaterial | null = null;
    let edgesGeo: THREE.EdgesGeometry | null = null;
    let edgesMat: THREE.LineBasicMaterial | null = null;

    const render = (w: number, h: number) => {
      if (disposed) return;
      renderer?.dispose();
      material?.dispose();
      edgesGeo?.dispose();
      edgesMat?.dispose();

      canvas.width = w * window.devicePixelRatio;
      canvas.height = h * window.devicePixelRatio;
      setCanvasSize({ w, h });

      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w, h, false);
      renderer.setClearColor(0x00000000, 0);

      const scene = new THREE.Scene();
      material = new THREE.MeshLambertMaterial({ color: 0xf5f0e8, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(shape.geometry, material);
      scene.add(mesh);

      edgesGeo = new THREE.EdgesGeometry(shape.geometry, 15);
      edgesMat = new THREE.LineBasicMaterial({ color: 0x78716c });
      scene.add(new THREE.LineSegments(edgesGeo, edgesMat));

      scene.add(new THREE.AmbientLight(0xffffff, 0.75));
      const dir = new THREE.DirectionalLight(0xffffff, 0.7);
      dir.position.set(0, 1, 0);
      scene.add(dir);

      const bbox = new THREE.Box3().setFromObject(mesh);
      const sz = new THREE.Vector3(), center = new THREE.Vector3();
      bbox.getSize(sz); bbox.getCenter(center);

      const dims3 = [sz.x, sz.y, sz.z];
      const minIdx = dims3.indexOf(Math.min(...dims3));
      const lookDirs = [new THREE.Vector3(1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,1)];

      const aspect = w / h;
      const pad = 1.42;

      // Find the two face axes (non-thickness). def = smaller index, alt = larger.
      // arrowRotated=false → W is on def axis (screen horizontal)
      // arrowRotated=true  → W is on alt axis (screen horizontal)
      // Camera up is chosen so that the W axis always maps to screen-right.
      const faceAxes = [0, 1, 2].filter(i => i !== minIdx).sort((a, b) => a - b);
      const [defIdx, altIdx] = faceAxes;
      const wAxisIdx = arrowRotated ? altIdx : defIdx;
      const hAxisIdx = arrowRotated ? defIdx : altIdx;
      const screenW = dims3[wAxisIdx];
      const screenH = dims3[hAxisIdx];

      // Camera up: solve cross(up, z_cam) = wDir for up, where z_cam = lookDirs[minIdx].
      // Solution: up = cross(z_cam, wDir).
      const wDir = new THREE.Vector3(); wDir.setComponent(wAxisIdx, 1);
      const upVec = new THREE.Vector3().crossVectors(lookDirs[minIdx], wDir).normalize();
      if (upVec.lengthSq() < 0.01) upVec.set(0, 1, 0);

      const halfWFromW = (screenW / 2) * pad;
      const halfWFromH = (screenH / 2) * pad * aspect;
      const halfW = Math.max(halfWFromW, halfWFromH);
      const halfH = halfW / aspect;

      const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, -10000, 10000);
      camera.position.copy(center).addScaledVector(lookDirs[minIdx], 1000);
      camera.up.copy(upVec);
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      // Render subtraction outlines in amber on the canvas
      const subGeos = Array.isArray(shape.subtractionGeometries) ? shape.subtractionGeometries : [];
      const subOutlineMaterials: THREE.LineBasicMaterial[] = [];
      subGeos.forEach((sg: any) => {
        if (!sg?.geometry) return;
        const rot = sg.relativeRotation || [0, 0, 0];
        const rotM = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
        const off = new THREE.Vector3(...((sg.relativeOffset || [0, 0, 0]) as number[]));
        const sgMesh = new THREE.Mesh(sg.geometry);
        sgMesh.matrix.copy(rotM); sgMesh.matrix.setPosition(off);
        sgMesh.matrixAutoUpdate = false;
        const sgEdgesGeo = new THREE.EdgesGeometry(sg.geometry, 15);
        const sgMat = new THREE.LineBasicMaterial({ color: 0xd97706 });
        subOutlineMaterials.push(sgMat);
        const sgLines = new THREE.LineSegments(sgEdgesGeo, sgMat);
        sgLines.matrix.copy(rotM); sgLines.matrix.setPosition(off);
        sgLines.matrixAutoUpdate = false;
        scene.add(sgLines);
      });

      renderer.render(scene, camera);

      setEdgeLabels(computeAllEdgeDimLabels(shape.geometry, camera, w, h, minIdx));
      setSubLabelSets(computeSubDimLabels(subGeos, camera, w, h, minIdx));
    };

    // Try up to ~600ms (20 frames) to get a non-zero size before giving up
    let rafId = 0;
    let attempts = 0;
    const tryRender = () => {
      if (disposed) return;
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (w > 0 && h > 0) { render(w, h); return; }
      if (++attempts < 20) rafId = requestAnimationFrame(tryRender);
    };
    rafId = requestAnimationFrame(tryRender);

    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) render(width, height);
    });
    ro.observe(wrap);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      renderer?.dispose();
      material?.dispose();
      edgesGeo?.dispose();
      edgesMat?.dispose();
    };
  }, [shape, arrowRotated]);

  const hasSub = Array.isArray(shape?.subtractionGeometries) && shape.subtractionGeometries.length > 0;

  // Collect subtract dimension strings from parameters
  const subDims = useMemo(() => {
    if (!hasSub) return [];
    return (shape.subtractionGeometries as any[]).flatMap((sg: any) => {
      const p = sg.parameters;
      if (!p) return [];
      const out: { label: string; value: string }[] = [];
      if (p.width) out.push({ label: 'W', value: p.width });
      if (p.height) out.push({ label: 'H', value: p.height });
      if (p.depth) out.push({ label: 'D', value: p.depth });
      return out;
    });
  }, [shape?.subtractionGeometries, hasSub]);

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0, userSelect: 'none' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
      <svg
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
        viewBox={`0 0 ${canvasSize.w} ${canvasSize.h}`}
      >
        {/* ── All edge segment dimensions ── */}
        {edgeLabels.map((lbl, i) => {
          const dx = lbl.ex2 - lbl.ex1, dy = lbl.ey2 - lbl.ey1;
          const len = Math.hypot(dx, dy);
          if (len < 4) return null;
          const off = Math.min(canvasSize.w, canvasSize.h) * 0.085;
          const arrowSz = Math.max(3, off * 0.28);
          const fontSize = Math.max(9, Math.min(13, canvasSize.w * 0.026));
          const px = lbl.nx, py = lbl.ny;
          const ax = lbl.ex1 + px * off, ay = lbl.ey1 + py * off;
          const bx = lbl.ex2 + px * off, by = lbl.ey2 + py * off;
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          const txt = String(lbl.length);
          const labelW = Math.max(txt.length * fontSize * 0.65 + 12, 32);
          const labelH = fontSize + 7;
          return (
            <g key={`outer-${i}`}>
              <line x1={lbl.ex1 + px * 2} y1={lbl.ey1 + py * 2} x2={ax} y2={ay} stroke="#a8a29e" strokeWidth="0.9"/>
              <line x1={lbl.ex2 + px * 2} y1={lbl.ey2 + py * 2} x2={bx} y2={by} stroke="#a8a29e" strokeWidth="0.9"/>
              <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#a8a29e" strokeWidth="1.2"/>
              <polygon points={`${ax},${ay} ${ax+(dx/len)*arrowSz+py*arrowSz*0.5},${ay+(dy/len)*arrowSz-px*arrowSz*0.5} ${ax+(dx/len)*arrowSz-py*arrowSz*0.5},${ay+(dy/len)*arrowSz+px*arrowSz*0.5}`} fill="#a8a29e"/>
              <polygon points={`${bx},${by} ${bx-(dx/len)*arrowSz+py*arrowSz*0.5},${by-(dy/len)*arrowSz-px*arrowSz*0.5} ${bx-(dx/len)*arrowSz-py*arrowSz*0.5},${by-(dy/len)*arrowSz+px*arrowSz*0.5}`} fill="#a8a29e"/>
              <rect x={mx - labelW / 2} y={my - labelH / 2} width={labelW} height={labelH} rx={3} fill="rgba(245,242,237,0.97)" stroke="#d6d3d1" strokeWidth="0.7"/>
              <text x={mx} y={my + fontSize * 0.36} textAnchor="middle" fontSize={fontSize} fill="#1c1917" fontFamily="monospace" fontWeight="700">{txt}</text>
            </g>
          );
        })}

        {/* ── Subtraction cut dimensions (amber) ── */}
        {subLabelSets.map((lbls, si) =>
          lbls.map((lbl, i) => {
            const dx = lbl.ex2 - lbl.ex1, dy = lbl.ey2 - lbl.ey1;
            const len = Math.hypot(dx, dy);
            if (len < 4) return null;
            const off = Math.min(canvasSize.w, canvasSize.h) * 0.05;
            const arrowSz = Math.max(2, off * 0.35);
            const fontSize = Math.max(8, Math.min(11, canvasSize.w * 0.022));
            // Dimension line runs through the cut centre — no outward offset
            const ax = lbl.ex1, ay = lbl.ey1;
            const bx = lbl.ex2, by = lbl.ey2;
            const mx = lbl.sx, my = lbl.sy;
            const txt = String(lbl.length);
            const labelW = Math.max(txt.length * fontSize * 0.65 + 10, 28);
            const labelH = fontSize + 6;
            return (
              <g key={`sub-${si}-${i}`}>
                <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#d97706" strokeWidth="1.1" strokeDasharray="3,2"/>
                <polygon points={`${ax},${ay} ${ax+(dx/len)*arrowSz},${ay+(dy/len)*arrowSz}`} fill="#d97706"/>
                <polygon points={`${bx},${by} ${bx-(dx/len)*arrowSz},${by-(dy/len)*arrowSz}`} fill="#d97706"/>
                <rect x={mx - labelW / 2} y={my - labelH / 2} width={labelW} height={labelH} rx={3} fill="rgba(255,247,220,0.97)" stroke="#f59e0b" strokeWidth="0.8"/>
                <text x={mx} y={my + fontSize * 0.36} textAnchor="middle" fontSize={fontSize} fill="#92400e" fontFamily="monospace" fontWeight="700">{txt}</text>
              </g>
            );
          })
        )}
      </svg>

      {/* Direction arrow — rotates 90° when arrowRotated is true */}
      <div style={{
        position: 'absolute', bottom: 10, left: 12, display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'none',
      }}>
        <div style={{
          background: 'rgba(41,37,36,0.82)', borderRadius: 5,
          padding: '3px 10px', fontSize: 12, fontFamily: 'monospace', fontWeight: 700, color: 'rgba(255,255,255,0.97)',
        }}>
          T {dims.thickness}
        </div>
        <svg width="28" height="28" viewBox="0 0 28 28"
          style={{ transform: arrowRotated ? 'none' : 'rotate(90deg)', transition: 'transform 0.25s ease' }}>
          {/* circle background */}
          <circle cx="14" cy="14" r="13" fill="rgba(41,37,36,0.82)" />
          {/* arrow shaft */}
          <line x1="14" y1="20" x2="14" y2="9" stroke="white" strokeWidth="2" strokeLinecap="round"/>
          {/* arrowhead */}
          <polygon points="14,5 10,11 18,11" fill="white"/>
        </svg>
      </div>
    </div>
  );
}

export function PanelEditor({ isOpen, onClose, embedded = false }: PanelEditorProps) {
  const { selectedShapeId, shapes, updateShape, addShape, showOutlines, setShowOutlines,
    selectedPanelRow, setSelectedPanelRow, panelSelectMode, setPanelSelectMode, raycastMode, setRaycastMode,
    showVirtualFaces, setShowVirtualFaces, virtualFaces, updateVirtualFace, deleteVirtualFace, reorderVirtualFaces, pendingPanelCreation,
    faceExtrudeMode, setFaceExtrudeMode, faceExtrudeTargetPanelId,
    setFaceExtrudeTargetPanelId, faceExtrudeSelectedFace, setFaceExtrudeSelectedFace, setFaceExtrudeHoveredFace,
    faceExtrudeThickness, setFaceExtrudeThickness, faceExtrudeFixedMode, setFaceExtrudeFixedMode } = useAppStore();

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
    // Virtual face panel: row key is "vf-{id}"
    if (typeof selectedPanelRow === 'string' && selectedPanelRow.startsWith('vf-'))
      return findVPanel(shapes, selectedShape.id, selectedPanelRow.replace('vf-', ''))?.id || null;
    // Legacy panel: row key is faceIndex (number)
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
    // Only auto-create panels for faces that have no panel shape yet in the store.
    // Faces where the user explicitly removed the panel (hasPanel: false, but shape was deleted)
    // must NOT be recreated — we detect them by checking if a matching panel shape exists.
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
    const g = groupCoplanarFaces(extractFacesFromGeometry(ps.geometry))[faceExtrudeSelectedFace]; if (!g) return;
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
    const onDrop = async (toIndex: number) => {
      const from = dragIndex;
      setDragIndex(null); setDropIndex(null);
      if (from === null || from === toIndex) return;
      reorderVirtualFaces(sid, from, toIndex);
      const { rebuildPanelsForParent } = await import('./PanelRebuildService');
      await rebuildPanelsForParent(sid);
    };

    return svf.map((vf, vi) => {
      const vp = findVPanel(shapes, sid, vf.id), ar = vp?.parameters?.arrowRotated||false, sel = selectedPanelRow === `vf-${vf.id}`;
      const dims = vp?.geometry ? getDimsFromGeo(vp.geometry, ar) : null;
      const rc = () => { setSelectedPanelRow(`vf-${vf.id}`, null, sid); };
      const isRowDragging = dragIndex === vi;
      const isDropTarget = dropIndex === vi && dragIndex !== null && dragIndex !== vi;

      return (
        <div
          key={vf.id}
          onDragOver={e => { if (dragIndex !== null) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropIndex !== vi) setDropIndex(vi); } }}
          onDragLeave={() => { if (dropIndex === vi) setDropIndex(null); }}
          onDrop={e => { e.preventDefault(); onDrop(vi); }}
          onClick={e => { stop(e); rc(); }}
          className={`
            group relative flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer
            transition-all duration-150 select-none
            ${sel
              ? 'bg-orange-50 ring-1 ring-orange-300 shadow-sm'
              : 'hover:bg-stone-50 ring-1 ring-transparent hover:ring-stone-200'}
            ${isRowDragging ? 'opacity-40' : ''}
            ${isDropTarget ? 'ring-1 ring-blue-400 bg-blue-50' : ''}
          `}
        >
          {/* Drag handle */}
          <span
            draggable
            onDragStart={e => { stop(e); setDragIndex(vi); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(vi)); }}
            onDragEnd={() => { setDragIndex(null); setDropIndex(null); }}
            onClick={stop}
            className="cursor-grab active:cursor-grabbing text-stone-300 hover:text-stone-400 shrink-0"
          ><GripVertical size={15}/></span>

          {/* Index badge */}
          <span className="shrink-0 w-7 h-6 flex items-center justify-center rounded-md text-sm font-bold font-mono bg-stone-100 text-stone-500">
            {vi+1}
          </span>

          {/* Note input */}
          <input
            type="text"
            value={vf.description||''}
            onClick={stop}
            onChange={e => updateVirtualFace(vf.id, { description: e.target.value })}
            placeholder="note…"
            style={{ width: '27mm' }}
            className="px-2 py-1 text-sm bg-transparent border-b border-transparent hover:border-stone-300 focus:border-orange-400 rounded-none outline-none text-stone-700 placeholder:text-stone-300 transition-colors"
          />

          {/* Dims inline */}
          {dims && (
            <span className="flex items-center gap-1 text-xs font-mono shrink-0 leading-none" onClick={stop}>
              <span className="text-stone-400">W</span><span className="text-stone-700 font-bold">{dims.primary}</span>
              <span className="text-stone-300">·</span>
              <span className="text-stone-400">H</span><span className="text-stone-700 font-bold">{dims.secondary}</span>
              <span className="text-stone-300">·</span>
              <span className="text-stone-400">T</span><span className="text-stone-700 font-bold">{dims.thickness}</span>
            </span>
          )}

          {/* Action buttons — always visible */}
          <div className="ml-auto flex items-center gap-1 shrink-0" onClick={stop}>
            <input type="checkbox" checked={vf.hasPanel} onClick={stop}
              onChange={async () => { if (vf.hasPanel) removeVP(vf.id); else await createVP(vf.id, vi); }}
              className="w-4 h-4 rounded text-green-500 focus:ring-green-400 cursor-pointer accent-green-500"
              title={`Toggle panel ${vi+1}`}/>
            <button disabled={!vf.hasPanel} onClick={e => { stop(e); toggleArrow(vp); }}
              className={`p-1 rounded transition-colors ${!vf.hasPanel ? 'text-stone-200 cursor-not-allowed' : ar ? 'text-blue-500' : 'text-stone-300 hover:text-stone-500'}`}
              title="Rotate arrow"><RotateCw size={13}/></button>
            <button disabled={!vf.hasPanel||!vp} onClick={async e => {
              stop(e); if (!vp) return;
              const { reshapePanelToParentFace } = await import('./PanelReshapeService');
              await reshapePanelToParentFace(vp.id);
            }}
              className={`p-1 rounded transition-colors ${!vf.hasPanel||!vp ? 'text-stone-200 cursor-not-allowed' : 'text-stone-300 hover:text-teal-600'}`}
              title="Match parent face"><Shapes size={13}/></button>
            <button onClick={e => { stop(e); if (vf.hasPanel) removeVP(vf.id); deleteVirtualFace(vf.id); }}
              className="p-1 rounded text-stone-300 hover:text-red-400 transition-colors"
              title="Delete face"><Trash2 size={13}/></button>
          </div>
        </div>
      );
    });
  })() : null;

  /* ── Panel detail section (preview + extrude controls + steps) ─────── */
  const panelDetailSection = (() => {
    if (!activePanelId || !activePanel) return null;
    const isExt = faceExtrudeMode && !!activePanelId;
    const hf = faceExtrudeSelectedFace !== null;

    return (
      <div className="flex flex-col gap-3">
        {/* Face Extrude Controls */}
        <div className="rounded-xl bg-gradient-to-b from-white to-stone-50/80 border border-stone-200 overflow-hidden">
          <div className="px-3 py-2 flex items-center gap-2 border-b border-stone-100">
            <span className="text-[10px] font-semibold text-stone-400 uppercase tracking-widest flex-1">Face Extrude</span>
            <button
              onClick={e => { stop(e); faceExtrudeMode ? setFaceExtrudeMode(false) : (setFaceExtrudeTargetPanelId(activePanelId), setFaceExtrudeMode(true)); }}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-all duration-150
                ${isExt
                  ? 'bg-orange-500 text-white shadow-sm ring-1 ring-orange-400'
                  : 'bg-white text-stone-600 border border-stone-300 hover:border-orange-300 hover:text-orange-600'}`}
            >
              <MoveVertical size={11}/>
              {isExt ? 'Active' : 'Enable'}
            </button>
          </div>

          {isExt && (
            <div className="px-3 py-2.5 flex items-center gap-2">
              <div className="flex-1">
                <label className="text-[10px] text-stone-400 mb-1 block">Thickness</label>
                <input
                  type="text" inputMode="numeric"
                  value={faceExtrudeThickness}
                  onChange={e => setFaceExtrudeThickness(Number(e.target.value)||0)}
                  disabled={!hf}
                  className={`w-full h-7 px-2 text-xs font-mono text-center border rounded-md focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all
                    ${hf ? 'bg-white border-stone-300' : 'bg-stone-50 border-stone-200 text-stone-300 cursor-not-allowed'}`}
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-stone-400 mb-1 block">Mode</label>
                <div className={`flex rounded-md overflow-hidden border ${hf ? 'border-stone-300' : 'border-stone-200 opacity-50'}`}>
                  {[true, false].map(f => (
                    <button key={String(f)} disabled={!hf} onClick={() => setFaceExtrudeFixedMode(f)}
                      className={`flex-1 h-7 text-xs font-semibold transition-colors ${!f ? 'border-l border-stone-200' : ''}
                        ${faceExtrudeFixedMode === f
                          ? 'bg-orange-500 text-white'
                          : 'bg-white text-stone-500 hover:bg-stone-50'}`}
                    >{f ? 'Fixed' : 'Dynamic'}</button>
                  ))}
                </div>
              </div>
              <button
                disabled={!hf}
                onClick={async () => {
                  if (!hf || !activePanelId) return;
                  const ps = shapes.find(s => s.id === activePanelId); if (!ps) return;
                  const { executeFaceExtrude } = await import('./FaceExtrudeService');
                  await executeFaceExtrude({ panelShape: ps, faceGroupIndex: faceExtrudeSelectedFace!, value: faceExtrudeThickness, isFixed: faceExtrudeFixedMode, shapes, updateShape });
                  setFaceExtrudeSelectedFace(null);
                  setFaceExtrudeMode(false);
                }}
                className={`self-end mb-0.5 flex items-center justify-center w-7 h-7 rounded-md border transition-all
                  ${hf
                    ? 'border-green-400 bg-green-500 text-white hover:bg-green-600 shadow-sm'
                    : 'border-stone-200 bg-stone-50 text-stone-300 cursor-not-allowed'}`}
                title="Apply"
              ><Check size={13}/></button>
            </div>
          )}

          {!isExt && (
            <div className="px-3 py-2.5">
              <p className="text-[10px] text-stone-400 leading-relaxed">
                Select a face in 3D view to offset it along its normal axis.
              </p>
            </div>
          )}
        </div>

        {/* Extrude Steps — compact inline chips */}
        {activeSteps.length > 0 && (
          <div className="rounded-lg border border-stone-200 bg-white overflow-hidden">
            <div className="px-2.5 py-1.5 flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] font-bold text-stone-300 uppercase tracking-widest mr-0.5 shrink-0">Steps</span>
              {activeSteps.map((s: any) => (
                editingStepId === s.id ? (
                  <div key={s.id} className="flex items-center gap-1 bg-orange-50 border border-orange-200 rounded-md px-1.5 py-0.5">
                    <span className="text-[9px] font-bold text-orange-500 font-mono shrink-0">{s.axisLabel}</span>
                    <input
                      type="text" inputMode="numeric" autoFocus
                      value={editingStepValue}
                      onChange={e => setEditingStepValue(Number(e.target.value)||0)}
                      onKeyDown={e => { if (e.key==='Enter') saveStep(activePanelId,s.id,editingStepValue); else if (e.key==='Escape') setEditingStepId(null); }}
                      className="w-12 h-4 px-1 text-[10px] font-mono text-center border border-orange-300 rounded bg-white focus:outline-none"
                    />
                    <button onClick={() => saveStep(activePanelId,s.id,editingStepValue)}
                      className="text-green-500 hover:text-green-600 shrink-0"><Check size={9}/></button>
                    <button onClick={() => setEditingStepId(null)}
                      className="text-stone-400 hover:text-stone-600 shrink-0"><X size={9}/></button>
                  </div>
                ) : (
                  <div key={s.id} className="group flex items-center gap-1 bg-stone-50 border border-stone-200 rounded-md px-1.5 py-0.5 hover:border-orange-200 hover:bg-orange-50 transition-all cursor-default">
                    <span className="text-[9px] font-bold text-orange-500 font-mono shrink-0">{s.axisLabel}</span>
                    <span className="text-[10px] font-mono text-stone-700 font-semibold">{s.value}</span>
                    <span className={`text-[8px] font-semibold shrink-0 ${s.isFixed ? 'text-blue-400' : 'text-stone-300'}`}>{s.isFixed ? 'F' : 'D'}</span>
                    <div className="hidden group-hover:flex items-center gap-0.5 ml-0.5">
                      <button onClick={() => { setEditingStepId(s.id); setEditingStepValue(s.value); }}
                        className="text-orange-400 hover:text-orange-600 transition-colors"><Pencil size={8}/></button>
                      <button onClick={async () => {
                        const ps = shapes.find(x => x.id === activePanelId); if (!ps) return;
                        const { deleteExtrudeStep } = await import('./FaceExtrudeService');
                        await deleteExtrudeStep(ps, s.id, updateShape);
                      }} className="text-red-300 hover:text-red-500 transition-colors"><Trash2 size={8}/></button>
                    </div>
                  </div>
                )
              ))}
            </div>
          </div>
        )}
      </div>
    );
  })();

  const isPreviewMode = selectedPanelRow !== null;

  // Selected face row (rendered in preview header)
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
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-orange-50 ring-1 ring-orange-300 shadow-sm select-none">
        <span className="shrink-0 w-7 h-6 flex items-center justify-center rounded-md text-sm font-bold font-mono bg-orange-100 text-orange-600">
          {vi + 1}
        </span>
        <input
          type="text"
          value={vf.description || ''}
          onClick={stop}
          onChange={e => updateVirtualFace(vf.id, { description: e.target.value })}
          placeholder="note…"
          style={{ width: '27mm' }}
          className="px-2 py-1 text-sm bg-transparent border-b border-transparent hover:border-stone-300 focus:border-orange-400 rounded-none outline-none text-stone-700 placeholder:text-stone-300 transition-colors"
        />
        {dims && (
          <span className="flex items-center gap-1 text-xs font-mono shrink-0 leading-none">
            <span className="text-stone-400">W</span><span className="text-stone-700 font-bold">{dims.primary}</span>
            <span className="text-stone-300">·</span>
            <span className="text-stone-400">H</span><span className="text-stone-700 font-bold">{dims.secondary}</span>
            <span className="text-stone-300">·</span>
            <span className="text-stone-400">T</span><span className="text-stone-700 font-bold">{dims.thickness}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0" onClick={stop}>
          <button disabled={!vf.hasPanel} onClick={e => { stop(e); toggleArrow(vp); }}
            className={`p-1 rounded transition-colors ${!vf.hasPanel ? 'text-stone-200 cursor-not-allowed' : ar ? 'text-blue-500' : 'text-stone-300 hover:text-stone-500'}`}
            title="Rotate arrow"><RotateCw size={13}/></button>
          <button disabled={!vf.hasPanel || !vp} onClick={async e => {
            stop(e); if (!vp) return;
            const { reshapePanelToParentFace } = await import('./PanelReshapeService');
            await reshapePanelToParentFace(vp.id);
          }}
            className={`p-1 rounded transition-colors ${!vf.hasPanel || !vp ? 'text-stone-200 cursor-not-allowed' : 'text-stone-300 hover:text-teal-600'}`}
            title="Match parent face"><Shapes size={13}/></button>
        </div>
      </div>
    );
  })();

  // ── Shared preview pane (full panel detail, big canvas) ────────────────
  const previewPane = isPreviewMode ? (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar: tools left, back button right */}
      <div className="px-3 py-2 border-b border-stone-100 flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-1.5">{panelToolbar}</div>
        <button
          onClick={() => setSelectedPanelRow(null)}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold text-stone-500 hover:text-stone-800 hover:bg-stone-100 transition-all"
        >
          Liste <ChevronRight size={12}/>
        </button>
      </div>

      {/* Selected row card — always visible at top */}
      {selectedFaceRow && (
        <div className="px-2 pt-2 pb-1 shrink-0">
          {selectedFaceRow}
        </div>
      )}

      {/* Canvas — flex-1, fills remaining space */}
      <div className="flex-1 mx-2 mb-1 rounded-xl bg-gradient-to-b from-[#f8f5f0] to-[#ede8df] border border-stone-200/80 overflow-hidden relative" style={{ minHeight: 320 }}>
        {activeDims && activePanel
          ? <PanelPreview2D key={activePanel.id} dims={activeDims} shape={activePanel} arrowRotated={!!activePanel.parameters?.arrowRotated}/>
          : (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xs text-stone-400">Panel yok</span>
            </div>
          )
        }
      </div>

      {/* Extrude controls + steps — scrollable footer */}
      {panelDetailSection && (
        <div className="shrink-0 overflow-y-auto border-t border-stone-100 px-2 py-2 space-y-3" style={{ maxHeight: '35%' }}>
          {panelDetailSection}
        </div>
      )}
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
          <div className="px-2 pt-2 pb-2 space-y-px">
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
    <div className="fixed bg-white rounded-xl shadow-xl border border-stone-200 z-50 overflow-hidden" style={{ left: `${position.x}px`, top: `${position.y}px`, width: isPreviewMode ? '500px' : '390px', transition: 'width 0.2s ease' }}>
      <div className="flex items-center justify-between px-3 py-2 bg-stone-50 border-b border-stone-200 select-none" style={{ cursor: isDraggingWindow ? 'grabbing' : 'grab' }} onMouseDown={handleMouseDown}>
        <div className="flex items-center gap-2"><GripVertical size={13} className="text-stone-300"/><span className="text-xs font-semibold text-stone-600 tracking-wide uppercase">Panel Editor</span></div>
        <div className="flex items-center gap-1.5">{panelToolbar}<button onClick={onClose} className="p-1 hover:bg-stone-200 rounded-md transition-colors"><X size={13} className="text-stone-400"/></button></div>
      </div>
      {isPreviewMode ? (
        <div style={{ height: 'min(80vh, 640px)', display: 'flex', flexDirection: 'column' }}>
          {previewPane}
        </div>
      ) : (
        <div style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
          <div className="p-2 space-y-0.5">{faceListSection}</div>
          {panelDetailSection && <div className="px-2 pb-3 pt-1 border-t border-stone-100 space-y-3">{panelDetailSection}</div>}
        </div>
      )}
    </div>
  );
}
