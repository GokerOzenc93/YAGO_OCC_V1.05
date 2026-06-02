import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, GripVertical, RotateCw, Trash2, MoveVertical, Check, Pencil, Shapes, ChevronRight } from 'lucide-react';
import { useAppStore } from '../store';
import { extractFacesFromGeometry, groupCoplanarFaces, CoplanarFaceGroup } from './FaceEditor';
import { findExistingStepForFace } from './FaceExtrudeService';
import {
  getFacePlaneAxes, getShapeMatrix, projectTo2D, ensureCCW, collectBoundaryEdgesWorld,
  type Point2D,
} from './FaceRaycastOverlay';
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

/* ── helpers ─────────────────────────────────────────────────────────── */

// Chain unordered boundary edges into ordered rings (returns possibly multiple rings: outer + holes)
function chainEdgesIntoRings(edges: Array<{ a: Point2D; b: Point2D }>, tol = 1.0): Point2D[][] {
  const remaining = [...edges];
  const rings: Point2D[][] = [];

  while (remaining.length > 0) {
    const ring: Point2D[] = [remaining[0].a, remaining[0].b];
    remaining.splice(0, 1);

    for (let iter = 0; iter < remaining.length * 2 + 10; iter++) {
      const last = ring[ring.length - 1];
      let found = false;
      for (let i = 0; i < remaining.length; i++) {
        const { a, b } = remaining[i];
        const dA = Math.hypot(a.x - last.x, a.y - last.y);
        const dB = Math.hypot(b.x - last.x, b.y - last.y);
        if (dA < tol) { ring.push(b); remaining.splice(i, 1); found = true; break; }
        if (dB < tol) { ring.push(a); remaining.splice(i, 1); found = true; break; }
      }
      if (!found) break;
      // Check if ring closed back to start
      const first = ring[0], last2 = ring[ring.length - 1];
      if (ring.length > 3 && Math.hypot(first.x - last2.x, first.y - last2.y) < tol) {
        ring.pop();
        break;
      }
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

// Remove collinear intermediate points (keeps concave corners, removes straight-line clutter)
function simplifyRing(ring: Point2D[], dot_tol = 0.9998): Point2D[] {
  if (ring.length <= 3) return ring;
  const out: Point2D[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const curr = ring[i];
    const next = ring[(i + 1) % n];
    const dx1 = curr.x - prev.x, dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
    const d1 = Math.hypot(dx1, dy1), d2 = Math.hypot(dx2, dy2);
    if (d1 < 1e-6 || d2 < 1e-6) continue; // duplicate — skip
    const dot = (dx1 * dx2 + dy1 * dy2) / (d1 * d2);
    if (dot < dot_tol) out.push(curr); // keep if non-collinear
  }
  return out.length >= 3 ? out : ring;
}

// Largest ring by bounding area = outer contour
function largestRing(rings: Point2D[][]): Point2D[] | null {
  if (!rings.length) return null;
  let best = rings[0];
  let bestArea = 0;
  for (const r of rings) {
    const xs = r.map(p => p.x), ys = r.map(p => p.y);
    const a = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (a > bestArea) { bestArea = a; best = r; }
  }
  return best;
}

function extractTopFaceOutline(shape: any): Point2D[] | null {
  if (!shape?.geometry) return null;

  const faces = extractFacesFromGeometry(shape.geometry);
  const groups = groupCoplanarFaces(faces);

  // Pick the largest flat (axis-aligned) face group — the top/bottom face
  let best: CoplanarFaceGroup | null = null;
  for (const g of groups) {
    const mx = Math.abs(g.normal.x), my = Math.abs(g.normal.y), mz = Math.abs(g.normal.z);
    if (Math.max(mx, my, mz) < 0.9) continue;
    if (!best || g.totalArea > best.totalArea) best = g;
  }
  if (!best) return null;

  const localToWorld = getShapeMatrix(shape);
  const worldNormal = best.normal.clone().transformDirection(localToWorld).normalize();
  const { u, v } = getFacePlaneAxes(worldNormal);

  const boundaryEdges = collectBoundaryEdgesWorld(faces, best.faceIndices, localToWorld);
  if (boundaryEdges.length < 3) return null;

  // Stable centroid origin
  const origin = new THREE.Vector3();
  for (const e of boundaryEdges) origin.add(e.v1).add(e.v2);
  origin.divideScalar(boundaryEdges.length * 2);

  // Project and filter micro-edges
  const edges2D = boundaryEdges
    .map(e => ({ a: projectTo2D(e.v1, origin, u, v), b: projectTo2D(e.v2, origin, u, v) }))
    .filter(e => Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) > 0.2);

  const rings = chainEdgesIntoRings(edges2D, 1.5);
  const outer = largestRing(rings);
  if (!outer || outer.length < 3) return null;

  const simplified = simplifyRing(outer);
  return ensureCCW(simplified);
}

// Compute the 2D bounding rect of a subtraction on the panel's top face
// Returns { x, y, w, h } in the same 2D coordinate system as outline
function getSubtractionRect2D(
  sub: any,
  parentShape: any,
  u: THREE.Vector3,
  v: THREE.Vector3,
  origin: THREE.Vector3,
): { x: number; y: number; w: number; h: number } | null {
  if (!sub?.geometry) return null;
  const localToWorld = getShapeMatrix(parentShape);
  const pos = sub.geometry.getAttribute('position');
  if (!pos) return null;
  const pts2D: Point2D[] = [];
  for (let i = 0; i < pos.count; i++) {
    const local = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const world = local.applyMatrix4(localToWorld);
    pts2D.push(projectTo2D(world, origin, u, v));
  }
  if (!pts2D.length) return null;
  const xs = pts2D.map(p => p.x), ys = pts2D.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Get the 2D origin+axes used for the outline (reused for subtraction rects)
function getTopFaceProjectionAxes(shape: any): { u: THREE.Vector3; v: THREE.Vector3; origin: THREE.Vector3 } | null {
  if (!shape?.geometry) return null;
  const faces = extractFacesFromGeometry(shape.geometry);
  const groups = groupCoplanarFaces(faces);
  let best: CoplanarFaceGroup | null = null;
  for (const g of groups) {
    const mx = Math.abs(g.normal.x), my = Math.abs(g.normal.y), mz = Math.abs(g.normal.z);
    if (Math.max(mx, my, mz) < 0.9) continue;
    if (!best || g.totalArea > best.totalArea) best = g;
  }
  if (!best) return null;
  const localToWorld = getShapeMatrix(shape);
  const worldNormal = best.normal.clone().transformDirection(localToWorld).normalize();
  const { u, v } = getFacePlaneAxes(worldNormal);
  const boundaryEdges = collectBoundaryEdgesWorld(faces, best.faceIndices, localToWorld);
  if (!boundaryEdges.length) return null;
  const origin = new THREE.Vector3();
  for (const e of boundaryEdges) origin.add(e.v1).add(e.v2);
  origin.divideScalar(boundaryEdges.length * 2);
  return { u, v, origin };
}

function pts2svgPath(pts: Point2D[], scaleF: number, tx: number, ty: number): string {
  if (!pts.length) return '';
  const [first, ...rest] = pts;
  const toSvg = (p: Point2D) => `${(p.x * scaleF + tx).toFixed(2)},${(p.y * scaleF + ty).toFixed(2)}`;
  return `M ${toSvg(first)} L ${rest.map(toSvg).join(' L ')} Z`;
}

/* ── Dimension line helper ───────────────────────────────────────────── */
function DimLine({ x1, y1, x2, y2, label, offset = 10, tickLen = 6, color = '#a8a29e', labelBg = 'rgba(245,242,237,0.97)', textColor = '#1c1917', fontSize = 10 }:
  { x1: number; y1: number; x2: number; y2: number; label: string; offset?: number; tickLen?: number; color?: string; labelBg?: string; textColor?: string; fontSize?: number }) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  // perpendicular unit
  const px = -dy / len, py = dx / len;
  // offset both endpoints
  const ax = x1 + px * offset, ay = y1 + py * offset;
  const bx = x2 + px * offset, by = y2 + py * offset;
  const arrowLen = 4;
  // midpoint for label
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const lw = Math.max(label.length * fontSize * 0.62, 28);
  return (
    <g>
      {/* extension lines */}
      <line x1={x1 + px * 2} y1={y1 + py * 2} x2={ax + px * (tickLen / 2)} y2={ay + py * (tickLen / 2)} stroke={color} strokeWidth="0.7"/>
      <line x1={x2 + px * 2} y1={y2 + py * 2} x2={bx + px * (tickLen / 2)} y2={by + py * (tickLen / 2)} stroke={color} strokeWidth="0.7"/>
      {/* dim line */}
      <line x1={ax} y1={ay} x2={bx} y2={by} stroke={color} strokeWidth="0.8"/>
      {/* arrowheads */}
      <polygon points={`${ax},${ay} ${ax + (dx / len) * arrowLen + py * 2},${ay + (dy / len) * arrowLen - px * 2} ${ax + (dx / len) * arrowLen - py * 2},${ay + (dy / len) * arrowLen + px * 2}`} fill={color}/>
      <polygon points={`${bx},${by} ${bx - (dx / len) * arrowLen + py * 2},${by - (dy / len) * arrowLen - px * 2} ${bx - (dx / len) * arrowLen - py * 2},${by - (dy / len) * arrowLen + px * 2}`} fill={color}/>
      {/* label */}
      <rect x={mx - lw / 2} y={my - fontSize - 1} width={lw} height={fontSize + 4} rx={2.5} fill={labelBg}/>
      <text x={mx} y={my + 0.5} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize} fill={textColor} fontFamily="monospace" fontWeight="700">{label}</text>
    </g>
  );
}

/* ── 2D Panel Preview ────────────────────────────────────────────────── */
function PanelPreview2D({ dims, steps, shape }: { dims: Dims; steps: any[]; shape?: any }) {
  const PAD_LEFT = 14, PAD_TOP = 20, PAD_RIGHT = 50, PAD_BOT = 14;
  const svgW = 360, svgH = 170;
  const maxW = svgW - PAD_LEFT - PAD_RIGHT;
  const maxH = svgH - PAD_TOP - PAD_BOT;

  // Extract real concave outline from geometry boundary edges
  const ring = useMemo(() => shape ? extractTopFaceOutline(shape) : null, [shape]);

  // Projection axes (shared between outline and subtraction rects)
  const projAxes = useMemo(() => shape ? getTopFaceProjectionAxes(shape) : null, [shape]);

  // Fit ring into canvas
  const { svgPath, tx, ty, scaleF, fitW, fitH, fitOx, fitOy } = useMemo(() => {
    const fallbackSf = Math.min(maxW / Math.max(dims.primary, 1), maxH / Math.max(dims.secondary, 1));
    const rw = dims.primary * fallbackSf, rh = dims.secondary * fallbackSf;
    const fallback = {
      svgPath: null as string | null, tx: 0, ty: 0, scaleF: fallbackSf,
      fitW: rw, fitH: rh, fitOx: PAD_LEFT + (maxW - rw) / 2, fitOy: PAD_TOP + (maxH - rh) / 2,
    };
    if (!ring || ring.length < 3) return fallback;

    const xs = ring.map(p => p.x), ys = ring.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const bW = maxX - minX || 1, bH = maxY - minY || 1;
    const sf = Math.min(maxW / bW, maxH / bH);
    const scaledW = bW * sf, scaledH = bH * sf;
    const tx = PAD_LEFT + (maxW - scaledW) / 2 - minX * sf;
    const ty = PAD_TOP + (maxH - scaledH) / 2 - minY * sf;
    return {
      svgPath: pts2svgPath(ring, sf, tx, ty),
      tx, ty, scaleF: sf,
      fitW: scaledW, fitH: scaledH,
      fitOx: PAD_LEFT + (maxW - scaledW) / 2,
      fitOy: PAD_TOP + (maxH - scaledH) / 2,
    };
  }, [ring, dims, maxW, maxH]);

  // Subtraction rects in SVG space
  const subRects = useMemo(() => {
    if (!shape?.subtractionGeometries?.length || !projAxes) return [];
    return (shape.subtractionGeometries as any[]).map(sub => {
      const r = getSubtractionRect2D(sub, shape, projAxes.u, projAxes.v, projAxes.origin);
      if (!r) return null;
      return {
        svgX: r.x * scaleF + tx,
        svgY: r.y * scaleF + ty,
        svgW: r.w * scaleF,
        svgH: r.h * scaleF,
        rawW: Math.round(r.w),
        rawH: Math.round(r.h),
      };
    }).filter(Boolean) as Array<{ svgX: number; svgY: number; svgW: number; svgH: number; rawW: number; rawH: number }>;
  }, [shape, projAxes, scaleF, tx, ty]);

  const dimOx = fitOx, dimOy = fitOy, dimW = fitW, dimH = fitH;
  const arrowLen = 5;

  const stepLines = steps.map((s: any) => {
    const label: string = s.axisLabel || '';
    const isHoriz = label.startsWith('X') || label.startsWith('x');
    return { isHoriz, value: s.value };
  });

  return (
    <svg width="100%" viewBox={`0 0 ${svgW} ${svgH}`} style={{ display: 'block' }}>
      <defs>
        <pattern id="hatch2d" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(234,88,12,0.09)" strokeWidth="2"/>
        </pattern>
        <filter id="shadow2d" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="1.5" dy="2" stdDeviation="2.5" floodOpacity="0.12"/>
        </filter>
        {svgPath && <clipPath id="shapeClip"><path d={svgPath}/></clipPath>}
      </defs>

      {svgPath ? (
        <>
          <path d={svgPath} fill="url(#hatch2d)" filter="url(#shadow2d)"/>
          <path d={svgPath} fill="rgba(255,252,247,0.88)"/>
          <g clipPath="url(#shapeClip)">
            {stepLines.map((sl, i) => {
              if (sl.isHoriz) {
                const x = dimOx + dimW * Math.min(sl.value / Math.max(dims.primary, 1), 0.97);
                return <line key={i} x1={x} y1={dimOy} x2={x} y2={dimOy + dimH} stroke="rgba(234,88,12,0.5)" strokeWidth="1" strokeDasharray="4 2.5"/>;
              } else {
                const y = dimOy + dimH * Math.min(sl.value / Math.max(dims.secondary, 1), 0.97);
                return <line key={i} x1={dimOx} y1={y} x2={dimOx + dimW} y2={y} stroke="rgba(234,88,12,0.5)" strokeWidth="1" strokeDasharray="4 2.5"/>;
              }
            })}
          </g>
          <path d={svgPath} fill="none" stroke="#78716c" strokeWidth="1.3"/>
        </>
      ) : (
        <>
          <rect x={dimOx} y={dimOy} width={dimW} height={dimH} rx={3} fill="url(#hatch2d)" filter="url(#shadow2d)"/>
          <rect x={dimOx} y={dimOy} width={dimW} height={dimH} rx={3} fill="rgba(255,252,247,0.88)"/>
          {stepLines.map((sl, i) => {
            if (sl.isHoriz) {
              const x = dimOx + dimW * Math.min(sl.value / Math.max(dims.primary, 1), 0.97);
              return <line key={i} x1={x} y1={dimOy} x2={x} y2={dimOy + dimH} stroke="rgba(234,88,12,0.5)" strokeWidth="1" strokeDasharray="4 2.5"/>;
            } else {
              const y = dimOy + dimH * Math.min(sl.value / Math.max(dims.secondary, 1), 0.97);
              return <line key={i} x1={dimOx} y1={y} x2={dimOx + dimW} y2={y} stroke="rgba(234,88,12,0.5)" strokeWidth="1" strokeDasharray="4 2.5"/>;
            }
          })}
          <rect x={dimOx} y={dimOy} width={dimW} height={dimH} rx={3} fill="none" stroke="#78716c" strokeWidth="1.3"/>
        </>
      )}

      {/* Subtraction dimension annotations */}
      {subRects.map((r, i) => (
        <g key={i}>
          {/* Width dim inside notch */}
          {r.rawW > 1 && (
            <DimLine
              x1={r.svgX} y1={r.svgY + r.svgH / 2}
              x2={r.svgX + r.svgW} y2={r.svgY + r.svgH / 2}
              label={`${r.rawW}`}
              offset={-r.svgH * 0.28}
              color="#6366f1"
              labelBg="rgba(238,242,255,0.95)"
              textColor="#4338ca"
              fontSize={9}
            />
          )}
          {/* Height dim inside notch */}
          {r.rawH > 1 && (
            <DimLine
              x1={r.svgX + r.svgW / 2} y1={r.svgY}
              x2={r.svgX + r.svgW / 2} y2={r.svgY + r.svgH}
              label={`${r.rawH}`}
              offset={r.svgW * 0.28}
              color="#6366f1"
              labelBg="rgba(238,242,255,0.95)"
              textColor="#4338ca"
              fontSize={9}
            />
          )}
        </g>
      ))}

      {/* W dimension — above */}
      <line x1={dimOx} y1={dimOy - 10} x2={dimOx + dimW} y2={dimOy - 10} stroke="#a8a29e" strokeWidth="0.8"/>
      <line x1={dimOx} y1={dimOy - 4} x2={dimOx} y2={dimOy - 17} stroke="#a8a29e" strokeWidth="0.8"/>
      <line x1={dimOx + dimW} y1={dimOy - 4} x2={dimOx + dimW} y2={dimOy - 17} stroke="#a8a29e" strokeWidth="0.8"/>
      <polygon points={`${dimOx},${dimOy-10} ${dimOx+arrowLen},${dimOy-12.5} ${dimOx+arrowLen},${dimOy-7.5}`} fill="#a8a29e"/>
      <polygon points={`${dimOx+dimW},${dimOy-10} ${dimOx+dimW-arrowLen},${dimOy-12.5} ${dimOx+dimW-arrowLen},${dimOy-7.5}`} fill="#a8a29e"/>
      <rect x={dimOx + dimW/2 - 24} y={dimOy - 18} width={48} height={14} rx={3} fill="rgba(245,242,237,0.97)"/>
      <text x={dimOx + dimW/2} y={dimOy - 7} textAnchor="middle" fontSize="11" fill="#1c1917" fontFamily="monospace" fontWeight="700">{dims.primary}</text>

      {/* H dimension — right */}
      <line x1={dimOx + dimW + 10} y1={dimOy} x2={dimOx + dimW + 10} y2={dimOy + dimH} stroke="#a8a29e" strokeWidth="0.8"/>
      <line x1={dimOx + dimW + 4} y1={dimOy} x2={dimOx + dimW + 16} y2={dimOy} stroke="#a8a29e" strokeWidth="0.8"/>
      <line x1={dimOx + dimW + 4} y1={dimOy + dimH} x2={dimOx + dimW + 16} y2={dimOy + dimH} stroke="#a8a29e" strokeWidth="0.8"/>
      <polygon points={`${dimOx+dimW+10},${dimOy} ${dimOx+dimW+7.5},${dimOy+arrowLen} ${dimOx+dimW+12.5},${dimOy+arrowLen}`} fill="#a8a29e"/>
      <polygon points={`${dimOx+dimW+10},${dimOy+dimH} ${dimOx+dimW+7.5},${dimOy+dimH-arrowLen} ${dimOx+dimW+12.5},${dimOy+dimH-arrowLen}`} fill="#a8a29e"/>
      <rect x={dimOx + dimW + 18} y={dimOy + dimH/2 - 8} width={40} height={14} rx={3} fill="rgba(245,242,237,0.97)"/>
      <text x={dimOx + dimW + 38} y={dimOy + dimH/2 + 3} textAnchor="middle" fontSize="11" fill="#1c1917" fontFamily="monospace" fontWeight="700">{dims.secondary}</text>

      {/* Thickness pill */}
      <rect x={dimOx + 4} y={dimOy + dimH - 17} width={46} height={14} rx={4} fill="rgba(41,37,36,0.78)"/>
      <text x={dimOx + 27} y={dimOy + dimH - 7} textAnchor="middle" fontSize="10" fill="rgba(255,255,255,0.95)" fontFamily="monospace" fontWeight="700">T {dims.thickness}</text>
    </svg>
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
    if (typeof selectedPanelRow === 'string' && selectedPanelRow.startsWith('vf-'))
      return findVPanel(shapes, selectedShape.id, selectedPanelRow.replace('vf-', ''))?.id || null;
    return null;
  }, [selectedShape, selectedPanelRow, shapes]);

  const activePanel = activePanelId ? shapes.find(s => s.id === activePanelId) : null;
  const activeDims = activePanel?.geometry
    ? getDimsFromGeo(activePanel.geometry, activePanel.parameters?.arrowRotated)
    : null;
  const activeSteps = activePanel?.parameters?.extrudeSteps || [];

  useEffect(() => { setSelectedPanelRow(null); }, [selectedShapeId]);

  useEffect(() => {
    const pending = virtualFaces.filter(vf => !vf.hasPanel);
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
          setSelectedPanelRow(`vf-${vf.id}`, null, parentShape.id);
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
        updateVirtualFace(vf.id, { hasPanel: true });
      } catch (e) { console.error('Failed to create virtual panel:', e); }
    };
    const removeVP = (vfId: string) => {
      const p = findVPanel(shapes, sid, vfId);
      if (p) useAppStore.getState().deleteShape(p.id);
      updateVirtualFace(vfId, { hasPanel: false });
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
        {/* 2D Preview */}
        {activeDims && (
          <div className="rounded-xl bg-gradient-to-b from-[#f8f5f0] to-[#f0ece4] border border-stone-200/80 overflow-hidden px-2 pt-3 pb-2">
            <PanelPreview2D dims={activeDims} steps={activeSteps} shape={activePanel}/>
          </div>
        )}

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

  if (embedded) return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="px-3 py-2 border-b border-stone-100 flex items-center justify-between shrink-0">
        {panelToolbar}
      </div>

      {selectedShape ? (
        <>
          {/* Face list — max 50% height, scrollable */}
          <div className="shrink-0" style={{ maxHeight: '50%', overflowY: 'auto' }}>
            <div className="px-2 pt-2 pb-1">
              <div className="space-y-px">
                {faceListSection}
              </div>
            </div>
          </div>

          {/* Detail section — remaining space, scrollable */}
          <div className="flex-1 min-h-0 overflow-y-auto border-t border-stone-100">
            <div className="px-2 py-2.5">
              {panelDetailSection || (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <div className="w-8 h-8 rounded-lg bg-stone-100 flex items-center justify-center mb-2">
                    <ChevronRight size={14} className="text-stone-300"/>
                  </div>
                  <span className="text-xs text-stone-400">Select a face above</span>
                  <span className="text-[10px] text-stone-300 mt-0.5">to see preview and controls</span>
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-stone-400 text-xs py-4">No shape selected</div>
        </div>
      )}
    </div>
  );

  return (
    <div className="fixed bg-white rounded-xl shadow-xl border border-stone-200 z-50 overflow-hidden" style={{ left: `${position.x}px`, top: `${position.y}px`, width: '390px' }}>
      <div className="flex items-center justify-between px-3 py-2 bg-stone-50 border-b border-stone-200 select-none" style={{ cursor: isDraggingWindow ? 'grabbing' : 'grab' }} onMouseDown={handleMouseDown}>
        <div className="flex items-center gap-2"><GripVertical size={13} className="text-stone-300"/><span className="text-xs font-semibold text-stone-600 tracking-wide uppercase">Panel Editor</span></div>
        <div className="flex items-center gap-1.5">{panelToolbar}<button onClick={onClose} className="p-1 hover:bg-stone-200 rounded-md transition-colors"><X size={13} className="text-stone-400"/></button></div>
      </div>
      <div className="max-h-[calc(100vh-200px)] overflow-y-auto">
        <div className="p-2 space-y-0.5">{faceListSection}</div>
        {panelDetailSection && <div className="px-2 pb-3 pt-1 border-t border-stone-100 space-y-3">{panelDetailSection}</div>}
      </div>
    </div>
  );
}
