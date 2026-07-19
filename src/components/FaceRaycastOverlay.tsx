import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../store';
import type { VirtualFace } from '../store';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  createFaceHighlightGeometry,
  createFaceDescriptor,
  FaceData,
  CoplanarFaceGroup,
} from './FaceEditor';
import { convertReplicadToThreeGeometry } from './ReplicadService';

interface FaceRaycastOverlayProps { shape: any; allShapes?: any[]; }

export function getFacePlaneAxes(normal: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const n = normal.clone().normalize();
  const absX = Math.abs(n.x), absY = Math.abs(n.y), absZ = Math.abs(n.z);
  const up = absY > absX && absY > absZ ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(n, up).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v };
}

export function getShapeMatrix(shape: any): THREE.Matrix4 {
  const pos = new THREE.Vector3(shape.position[0], shape.position[1], shape.position[2]);
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2], 'XYZ'));
  const scale = new THREE.Vector3(shape.scale[0], shape.scale[1], shape.scale[2]);
  return new THREE.Matrix4().compose(pos, quat, scale);
}

export function projectTo2D(p: THREE.Vector3, origin: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): { x: number; y: number } {
  const d = new THREE.Vector3().subVectors(p, origin);
  return { x: d.dot(u), y: d.dot(v) };
}

function raySegmentIntersect2D(ox: number, oy: number, dx: number, dy: number, ax: number, ay: number, bx: number, by: number): number | null {
  const ex = bx - ax, ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((ax - ox) * ey - (ay - oy) * ex) / denom;
  const s = ((ax - ox) * dy - (ay - oy) * dx) / denom;
  if (t > 1e-4 && s >= -1e-4 && s <= 1.0 + 1e-4) return t;
  return null;
}

// ── SERİ IŞIN: görünürlük çokgeni ────────────────────────────────────────────
// Tıklanan noktadan, düzlemdeki TÜM sınır+engel kenarlarına doğru ışın demeti
// atılır: her kenar ucuna (±epsilon açıyla) hedefli ışınlar + düzgün dağılımlı
// yelpaze. Sonuç, tıklanan noktadan "görünen" serbest bölgenin TAM çokgenidir:
// eğik (döndürülmüş) bir panel yüzeyi kestiğinde bölge o eğik çizgiyi birebir
// izler — dik durumlarda ise sonuç mevcut davranışla aynı dikdörtgendir.
// NOT: Bu, yüzeyi "ana yüze eşitle" gibi birebir kopyalamaz; yalnızca tıklanan
// noktanın etrafındaki erişilebilir alanın şeklini üretir.
export interface ObstacleEdge { v1: THREE.Vector3; v2: THREE.Vector3; ownerId?: string; }

/**
 * Bu yüz düzleminde "ana yüzeye eşitlenmiş" (alignToParentFace) kardeş VF'lerin
 * kimlikleri. Eşitlenmiş panel TANIM GEREĞİ parent yüzünün TAMAMINI doldurur
 * (PanelReshapeService: "HER ZAMAN tüm parent yüzünü doldur") ve yüz düzleminde
 * FLUSH durur. Dolayısıyla aynı yüze atılan başka bir paneli in-plane olarak
 * SINIRLAYAMAZ — onun ÜZERİNE istiflenir (lamine olur).
 *
 * Buna rağmen ışın atma onu bir engel sayıyordu: gövde konturu (yüz poligonu,
 * çentikli/açılı olabilir) ışınları durdurup görünürlük çokgenini o şekle
 * sokuyordu. Sonuç: ilk panel 4 kenarlı çıkarken, ondan SONRAKİ her panel
 * sorgusuz yüzün şeklini alıyordu. Bu VF'leri engel kümesinden çıkarıyoruz;
 * böylece her panel varsayılan olarak normal DİKDÖRTGEN yerleşir ve yüz şekli
 * yalnızca kullanıcı "ana yüzeye eşitle"ye bastığında verilir.
 *
 * DİKKAT: yalnızca AYNI DÜZLEMDEKİ eşitlenmiş VF'ler elenir. Başka bir yüze
 * (ör. sol yüze) eşitlenmiş panel, bu yüzü dik olarak kesiyorsa GERÇEK bir
 * engeldir ve korunur.
 */
/**
 * BÖLGEYİ DİKDÖRTGENE İNDİRGE — tıklamayı (köken) içeren EN BÜYÜK ALANLI eksen
 * hizalı dikdörtgen.
 *
 * SÖZLEŞME ("ana yüzeye eşitle" anahtarı): bayrak KAPALIYKEN panel her koşulda
 * 4 kenarlıdır; yüzün şekli (L/U, çentik) yalnızca bayrak AÇIKKEN verilir.
 * Bu fonksiyon bayraksız yoldaki dörtgeni üretir.
 *
 * Aday v sınırları kısıt segmenti uçlarından türetilir; her (vMin, vMax) çifti
 * için u yönleri bağımsız ikili aramayla büyütülür (v aralığı sabitken u'da
 * büyümek monotondur) ve alanı en büyük geçerli aday seçilir — deterministik,
 * sıradan bağımsız. Kısıt testi SEGMENT KESİŞİMİ ile yapılır (görünürlük
 * çokgeninin köşe yongalarına bağışık). Kısıtlar dikdörtgense sonuç tohumla
 * birebir aynıdır (hızlı yol) — düz yüzlerde davranış değişmez.
 */
export function getSubtractionWorldMatrix(parentLocalToWorld: THREE.Matrix4, subtraction: any): THREE.Matrix4 {
  const box = new THREE.Box3().setFromBufferAttribute(subtraction.geometry.attributes.position as THREE.BufferAttribute);
  const size = new THREE.Vector3(), center = new THREE.Vector3();
  box.getSize(size); box.getCenter(center);
  const isCentered = Math.abs(center.x) < 0.01 && Math.abs(center.y) < 0.01 && Math.abs(center.z) < 0.01;
  const meshOffset = isCentered ? new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2) : new THREE.Vector3();
  const groupMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...subtraction.relativeOffset),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(subtraction.relativeRotation?.[0] || 0, subtraction.relativeRotation?.[1] || 0, subtraction.relativeRotation?.[2] || 0, 'XYZ')),
    new THREE.Vector3(subtraction.scale?.[0] || 1, subtraction.scale?.[1] || 1, subtraction.scale?.[2] || 1)
  );
  const meshMatrix = new THREE.Matrix4().makeTranslation(meshOffset.x, meshOffset.y, meshOffset.z);
  return new THREE.Matrix4().multiplyMatrices(parentLocalToWorld, groupMatrix).multiply(meshMatrix);
}

export type Point2D = { x: number; y: number };

export function getSubtractorFootprints2D(subtractions: any[], parentLocalToWorld: THREE.Matrix4, facePlaneNormal: THREE.Vector3, facePlaneOrigin: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, planeTolerance: number = 50): Point2D[][] {
  const footprints: Point2D[][] = [];
  for (const sub of subtractions) {
    if (!sub || !sub.geometry) continue;
    const subWorldMatrix = getSubtractionWorldMatrix(parentLocalToWorld, sub);
    const posAttr = sub.geometry.getAttribute('position');
    const onPlaneVerts: THREE.Vector3[] = [];
    for (let i = 0; i < posAttr.count; i++) {
      const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(subWorldMatrix);
      if (Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(wp, facePlaneOrigin))) < planeTolerance) onPlaneVerts.push(wp);
    }
    if (onPlaneVerts.length < 3) continue;
    const hull = convexHull2D(onPlaneVerts.map(wp => projectTo2D(wp, facePlaneOrigin, u, v)));
    if (hull.length >= 3) footprints.push(hull);
  }
  return footprints;
}

export function convexHull2D(points: Point2D[]): Point2D[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point2D, a: Point2D, b: Point2D) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point2D[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

export function pickDominantEdgeDirection(
  boundaryEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>,
  normal: THREE.Vector3
): THREE.Vector3 | null {
  const bins = new Map<string, { dir: THREE.Vector3; length: number }>();
  for (const e of boundaryEdges) {
    const d = new THREE.Vector3().subVectors(e.v2, e.v1);
    const len = d.length();
    if (len < 1e-3) continue;
    d.divideScalar(len);
    d.addScaledVector(normal, -d.dot(normal)).normalize();
    let dir = d.clone();
    if (dir.x < 0 || (Math.abs(dir.x) < 1e-6 && dir.y < 0) ||
        (Math.abs(dir.x) < 1e-6 && Math.abs(dir.y) < 1e-6 && dir.z < 0)) {
      dir.negate();
    }
    const key = `${dir.x.toFixed(3)},${dir.y.toFixed(3)},${dir.z.toFixed(3)}`;
    const existing = bins.get(key);
    if (existing) existing.length += len;
    else bins.set(key, { dir, length: len });
  }
  let best: { dir: THREE.Vector3; length: number } | null = null;
  bins.forEach(b => { if (!best || b.length > best.length) best = b; });
  return best ? best.dir.clone() : null;
}

function buildBoundaryLoop2D(
  boundaryEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>,
  origin: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3
): Point2D[] | null {
  if (boundaryEdges.length < 3) return null;
  const keyOf = (p: Point2D) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  type Edge2D = { a: Point2D; b: Point2D; ak: string; bk: string };
  const edges: Edge2D[] = boundaryEdges.map(e => {
    const a = projectTo2D(e.v1, origin, u, v);
    const b = projectTo2D(e.v2, origin, u, v);
    return { a, b, ak: keyOf(a), bk: keyOf(b) };
  });
  const adj = new Map<string, { other: string; point: Point2D }[]>();
  for (const e of edges) {
    if (e.ak === e.bk) continue;
    if (!adj.has(e.ak)) adj.set(e.ak, []);
    if (!adj.has(e.bk)) adj.set(e.bk, []);
    adj.get(e.ak)!.push({ other: e.bk, point: e.b });
    adj.get(e.bk)!.push({ other: e.ak, point: e.a });
  }
  if (edges.length === 0) return null;
  const startKey = edges[0].ak;
  const startPt = edges[0].a;
  const loop: Point2D[] = [startPt];
  const visited = new Set<string>();
  let cur = startKey, prev = '';
  while (true) {
    visited.add(cur);
    const neigh = adj.get(cur) || [];
    const next = neigh.find(n => n.other !== prev && !visited.has(n.other));
    if (!next) break;
    loop.push(next.point);
    prev = cur; cur = next.other;
    if (cur === startKey) break;
    if (loop.length > edges.length + 2) break;
  }
  return loop.length >= 3 ? loop : null;
}

function sutherlandHodgmanClip(subject: Point2D[], clip: Point2D[]): Point2D[] {
  let output = [...subject];
  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const input = [...output]; output = [];
    const edgeStart = clip[i], edgeEnd = clip[(i + 1) % clip.length];
    for (let j = 0; j < input.length; j++) {
      const current = input[j], prev = input[(j + input.length - 1) % input.length];
      const currInside = isInsideEdge(current, edgeStart, edgeEnd);
      const prevInside = isInsideEdge(prev, edgeStart, edgeEnd);
      if (currInside) {
        if (!prevInside) { const inter = lineIntersect2D(prev, current, edgeStart, edgeEnd); if (inter) output.push(inter); }
        output.push(current);
      } else if (prevInside) {
        const inter = lineIntersect2D(prev, current, edgeStart, edgeEnd);
        if (inter) output.push(inter);
      }
    }
  }
  return output;
}

function isInsideEdge(p: Point2D, edgeStart: Point2D, edgeEnd: Point2D): boolean {
  return (edgeEnd.x - edgeStart.x) * (p.y - edgeStart.y) - (edgeEnd.y - edgeStart.y) * (p.x - edgeStart.x) >= 0;
}

// Returns true only when all cross-products have the same sign (convex polygon).
// Sutherland-Hodgman clip requires a convex clip polygon; skip it for non-convex faces.
export function isConvexPolygon2D(poly: Point2D[]): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], c = poly[(i + 2) % poly.length];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

function lineIntersect2D(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): Point2D | null {
  const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
  const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

export function subtractPolygon(subject: Point2D[], hole: Point2D[]): Point2D[] {
  const invertedHole = [...hole].reverse();
  const clipped = sutherlandHodgmanClip(subject, invertedHole);
  if (clipped.length < 3) return subject;
  const subjectEdges: [Point2D, Point2D][] = subject.map((p, i) => [p, subject[(i + 1) % subject.length]]);
  const holeEdges: [Point2D, Point2D][] = hole.map((p, i) => [p, hole[(i + 1) % hole.length]]);
  const result: Point2D[] = [];
  const EPS = 0.5;
  for (let i = 0; i < subject.length; i++) {
    const pt = subject[i];
    if (!isPointInsidePolygon(pt, hole)) result.push(pt);
    const intersections = findEdgeIntersections(pt, subject[(i + 1) % subject.length], holeEdges);
    intersections.sort((a, b) => (a.x - pt.x) ** 2 + (a.y - pt.y) ** 2 - ((b.x - pt.x) ** 2 + (b.y - pt.y) ** 2));
    for (const inter of intersections) {
      result.push(inter);
      for (const hp of traceHoleEdge(inter, hole, subject)) result.push(hp);
    }
  }
  if (result.length < 3) return subject;
  const deduplicated: Point2D[] = [result[0]];
  for (let i = 1; i < result.length; i++) {
    const prev = deduplicated[deduplicated.length - 1];
    if (Math.abs(result[i].x - prev.x) > EPS || Math.abs(result[i].y - prev.y) > EPS) deduplicated.push(result[i]);
  }
  if (deduplicated.length >= 2) {
    const first = deduplicated[0], last = deduplicated[deduplicated.length - 1];
    if (Math.abs(first.x - last.x) < EPS && Math.abs(first.y - last.y) < EPS) deduplicated.pop();
  }
  return deduplicated.length >= 3 ? deduplicated : subject;
}

export function isPointInsidePolygon(p: Point2D, poly: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function findEdgeIntersections(a: Point2D, b: Point2D, edges: [Point2D, Point2D][]): Point2D[] {
  const results: Point2D[] = [];
  for (const [e1, e2] of edges) { const inter = segmentIntersect2D(a, b, e1, e2); if (inter) results.push(inter); }
  return results;
}

function segmentIntersect2D(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): Point2D | null {
  const dx1 = p2.x - p1.x, dy1 = p2.y - p1.y, dx2 = p4.x - p3.x, dy2 = p4.y - p3.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((p3.x - p1.x) * dy2 - (p3.y - p1.y) * dx2) / denom;
  const s = ((p3.x - p1.x) * dy1 - (p3.y - p1.y) * dx1) / denom;
  if (t > 1e-6 && t < 1 - 1e-6 && s > 1e-6 && s < 1 - 1e-6) return { x: p1.x + t * dx1, y: p1.y + t * dy1 };
  return null;
}

function traceHoleEdge(entryPoint: Point2D, hole: Point2D[], subject: Point2D[]): Point2D[] {
  const subjectEdges: [Point2D, Point2D][] = subject.map((p, i) => [p, subject[(i + 1) % subject.length]]);
  let closestEdgeIdx = 0, minDist = Infinity;
  for (let i = 0; i < hole.length; i++) {
    const mid = { x: (hole[i].x + hole[(i + 1) % hole.length].x) / 2, y: (hole[i].y + hole[(i + 1) % hole.length].y) / 2 };
    const d = (mid.x - entryPoint.x) ** 2 + (mid.y - entryPoint.y) ** 2;
    if (d < minDist) { minDist = d; closestEdgeIdx = i; }
  }
  const trace: Point2D[] = [];
  const startIdx = (closestEdgeIdx + 1) % hole.length;
  for (let step = 0; step < hole.length; step++) {
    const idx = (startIdx + step) % hole.length;
    const pt = hole[idx];
    if (!isPointInsidePolygon(pt, subject)) continue;
    trace.push(pt);
    const intersections = findEdgeIntersections(pt, hole[(idx + 1) % hole.length], subjectEdges);
    if (intersections.length > 0) { trace.push(intersections[0]); break; }
  }
  return trace;
}

export function earClipTriangulate(vertices: Point2D[]): number[] {
  if (vertices.length < 3) return [];
  if (vertices.length === 3) return [0, 1, 2];
  const indices: number[] = [];
  const remaining = vertices.map((_, i) => i);
  let safety = remaining.length * remaining.length;
  while (remaining.length > 3 && safety > 0) {
    safety--;
    let earFound = false;
    for (let i = 0; i < remaining.length; i++) {
      const prevIdx = (i + remaining.length - 1) % remaining.length;
      const nextIdx = (i + 1) % remaining.length;
      const a = vertices[remaining[prevIdx]], b = vertices[remaining[i]], c = vertices[remaining[nextIdx]];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross < 1e-10) continue;
      let isEar = true;
      for (let j = 0; j < remaining.length; j++) {
        if (j === prevIdx || j === i || j === nextIdx) continue;
        if (pointInTriangle(vertices[remaining[j]], a, b, c)) { isEar = false; break; }
      }
      if (isEar) { indices.push(remaining[prevIdx], remaining[i], remaining[nextIdx]); remaining.splice(i, 1); earFound = true; break; }
    }
    if (!earFound) remaining.reverse();
  }
  if (remaining.length === 3) indices.push(remaining[0], remaining[1], remaining[2]);
  return indices;
}

function pointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
  const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function sign(p1: Point2D, p2: Point2D, p3: Point2D): number {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}

function pointInTriangle3D(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean {
  const v0 = c.clone().sub(a);
  const v1 = b.clone().sub(a);
  const v2 = p.clone().sub(a);
  const dot00 = v0.dot(v0), dot01 = v0.dot(v1), dot02 = v0.dot(v2);
  const dot11 = v1.dot(v1), dot12 = v1.dot(v2);
  const inv = 1 / (dot00 * dot11 - dot01 * dot01);
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= -0.01 && v >= -0.01 && (u + v) <= 1.02;
}

export function ensureCCW(poly: Point2D[]): Point2D[] {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area < 0 ? [...poly].reverse() : poly;
}

export interface RayHitResult {
  hitPoint: THREE.Vector3;
  hitEdge: ObstacleEdge | null;
  edgeT: number;
  isBoundaryEdge: boolean;
  /** Işını durduran komşunun kimliği ('panel:<id>' | 'vf:<id>' | 'sub:<i>'); sınıra çarptıysa null. */
  hitOwnerId: string | null;
}

export function castRayOnFaceWorldDetailed(originWorld: THREE.Vector3, dirWorld: THREE.Vector3, boundaryEdges: ObstacleEdge[], obstacleEdges: ObstacleEdge[], u: THREE.Vector3, v: THREE.Vector3, planeOrigin: THREE.Vector3, maxDist: number): RayHitResult {
  const o2d = projectTo2D(originWorld, planeOrigin, u, v);
  const dir2d = { x: dirWorld.dot(u), y: dirWorld.dot(v) };
  let tMin = maxDist, hitEdge: ObstacleEdge | null = null, hitEdgeT = 0, isBoundary = false;
  for (const edge of boundaryEdges) {
    const a2d = projectTo2D(edge.v1, planeOrigin, u, v), b2d = projectTo2D(edge.v2, planeOrigin, u, v);
    const t = raySegmentIntersect2D(o2d.x, o2d.y, dir2d.x, dir2d.y, a2d.x, a2d.y, b2d.x, b2d.y);
    if (t !== null && t < tMin) {
      tMin = t; hitEdge = edge; isBoundary = true;
      const hitX = o2d.x + dir2d.x * t, hitY = o2d.y + dir2d.y * t;
      const ex = b2d.x - a2d.x, ey = b2d.y - a2d.y, eLen = Math.sqrt(ex * ex + ey * ey);
      hitEdgeT = eLen > 1e-8 ? ((hitX - a2d.x) * ex + (hitY - a2d.y) * ey) / (eLen * eLen) : 0;
    }
  }
  for (const edge of obstacleEdges) {
    const a2d = projectTo2D(edge.v1, planeOrigin, u, v), b2d = projectTo2D(edge.v2, planeOrigin, u, v);
    const t = raySegmentIntersect2D(o2d.x, o2d.y, dir2d.x, dir2d.y, a2d.x, a2d.y, b2d.x, b2d.y);
    if (t !== null && t < tMin) {
      tMin = t; hitEdge = edge; isBoundary = false;
      const hitX = o2d.x + dir2d.x * t, hitY = o2d.y + dir2d.y * t;
      const ex = b2d.x - a2d.x, ey = b2d.y - a2d.y, eLen = Math.sqrt(ex * ex + ey * ey);
      hitEdgeT = eLen > 1e-8 ? ((hitX - a2d.x) * ex + (hitY - a2d.y) * ey) / (eLen * eLen) : 0;
    }
  }
  return {
    hitPoint: originWorld.clone().addScaledVector(dirWorld, tMin),
    hitEdge,
    edgeT: Math.max(0, Math.min(1, hitEdgeT)),
    isBoundaryEdge: isBoundary,
    hitOwnerId: isBoundary ? null : (hitEdge?.ownerId ?? null),
  };
}

export function castRayOnFaceWorld(originWorld: THREE.Vector3, dirWorld: THREE.Vector3, boundaryEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>, obstacleEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>, u: THREE.Vector3, v: THREE.Vector3, planeOrigin: THREE.Vector3, maxDist: number): THREE.Vector3 {
  return castRayOnFaceWorldDetailed(originWorld, dirWorld, boundaryEdges, obstacleEdges, u, v, planeOrigin, maxDist).hitPoint;
}

interface PendingPreview {
  geo: THREE.BufferGeometry;
  edgeGeo: THREE.BufferGeometry;
  virtualFace: VirtualFace;
}

/**
 * Returns true if the given world-space point falls inside the panel's CURRENT geometry
 * footprint projected onto the face plane. Used to detect void areas left by shortened
 * panels, without relying on VF polygons (which stay as original full-face for rebuild).
 */
/** Panelin, verilen yüz DÜZLEMİNE değen 2D ayak izi (u/v hull). Panel düzleme
 *  değmiyorsa (on-plane köşe < 3) null döner — o yüzeyde engel değildir. */
export function panelFootprintOnPlane(
  panel: any,
  facePlaneNormal: THREE.Vector3,
  facePlaneOrigin: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  planeTolerance: number = 5.0
): Point2D[] | null {
  if (!panel.geometry) return null;
  const panelMatrix = getShapeMatrix(panel);
  const posAttr = panel.geometry.getAttribute('position') as THREE.BufferAttribute;
  const pts2D: Point2D[] = [];
  for (let i = 0; i < posAttr.count; i++) {
    const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(panelMatrix);
    const dist = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(wp, facePlaneOrigin)));
    if (dist < planeTolerance) pts2D.push(projectTo2D(wp, facePlaneOrigin, u, v));
  }
  if (pts2D.length < 3) return null;
  const hull = convexHull2D(pts2D);
  return hull.length >= 3 ? hull : null;
}

/** Tıklanan düzlem noktası, bu yüzeye değen HERHANGİ bir panelin ayak izi
 *  içinde mi? İçindeyse o paneli döndürür (taşınmış paneller dahil — VF
 *  konumundan bağımsız, panelin GÜNCEL geometrisiyle test edilir). */
export function findPanelCoveringPoint(
  worldPt: THREE.Vector3,
  childPanels: any[],
  facePlaneNormal: THREE.Vector3,
  facePlaneOrigin: THREE.Vector3
): any | null {
  const { u, v } = getFacePlaneAxes(facePlaneNormal);
  const p2 = projectTo2D(worldPt, facePlaneOrigin, u, v);
  for (const panel of childPanels) {
    const fp = panelFootprintOnPlane(panel, facePlaneNormal, facePlaneOrigin, u, v);
    if (fp && isPointInsidePolygon(p2, fp)) return panel;
  }
  return null;
}

export function isWorldPointInsidePanelFootprint(
  worldPt: THREE.Vector3,
  panel: any,
  facePlaneNormal: THREE.Vector3,
  facePlaneOrigin: THREE.Vector3,
  planeTolerance: number = 5.0
): boolean {
  if (!panel.geometry) return false;
  const panelMatrix = getShapeMatrix(panel);
  const posAttr = panel.geometry.getAttribute('position') as THREE.BufferAttribute;
  const { u, v } = getFacePlaneAxes(facePlaneNormal);
  const pts2D: Point2D[] = [];
  for (let i = 0; i < posAttr.count; i++) {
    const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(panelMatrix);
    const dist = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(wp, facePlaneOrigin)));
    if (dist < planeTolerance) pts2D.push(projectTo2D(wp, facePlaneOrigin, u, v));
  }
  // Fallback: project ALL vertices when on-plane count is too low
  if (pts2D.length < 3) {
    pts2D.length = 0;
    for (let i = 0; i < posAttr.count; i++) {
      const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(panelMatrix);
      pts2D.push(projectTo2D(wp, facePlaneOrigin, u, v));
    }
  }
  if (pts2D.length < 3) return false;
  const hull = convexHull2D(pts2D);
  if (hull.length < 3) return false;
  return isPointInsidePolygon(projectTo2D(worldPt, facePlaneOrigin, u, v), hull);
}

export function collectVirtualFaceObstacleEdgesWorld(virtualFaces: VirtualFace[], excludeId: string | null, shapeLocalToWorld: THREE.Matrix4, facePlaneNormal: THREE.Vector3, facePlaneOrigin: THREE.Vector3, planeTolerance: number = 20, excludeVfIds?: Set<string>): ObstacleEdge[] {
  const edges: ObstacleEdge[] = [];
  for (const vf of virtualFaces) {
    if (vf.id === excludeId || vf.vertices.length < 3) continue;
    // Aynı düzlemde eşitlenmiş kardeş VF de engel sayılmaz (yukarıdaki gerekçe).
    if (excludeVfIds && excludeVfIds.has(vf.id)) continue;
    const ownerId = `vf:${vf.id}`;
    const worldVerts = vf.vertices.map(vtx => new THREE.Vector3(vtx[0], vtx[1], vtx[2]).applyMatrix4(shapeLocalToWorld));
    for (let i = 0; i < worldVerts.length; i++) {
      const va = worldVerts[i], vb = worldVerts[(i + 1) % worldVerts.length];
      const distA = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(va, facePlaneOrigin)));
      const distB = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(vb, facePlaneOrigin)));
      if (distA < planeTolerance && distB < planeTolerance) edges.push({ v1: va, v2: vb, ownerId });
    }
  }
  return edges;
}

/**
 * TAM YÜZ SEÇİMİ: Tıklanan noktadan, o noktayı içeren yüz ÜÇGENİNİN
 * kenar/köşe paylaşan BAĞLANTILI BİLEŞENİ toplanır; VF bu bileşenin sınır
 * konturudur. Panel her zaman tıklanan yüzün TAMAMINA yayılır (üretim
 * PanelRebuildService'te OCC yüz-extrusion ile yapılır; kısaltılmış kardeş
 * paneller kesilir, tıklanan taraf tutulur). Işın/görünürlük çokgeni ve
 * reçete mekanizması kaldırıldı — VF parentFaceShape olarak işaretlenir ve
 * resize'da yüz eşlemesiyle (regenerateParentFaceShapeVF) güncellenir.
 */
/**
 * Bir yüz grubundan, seed noktasına en yakın/onu içeren üçgenin kenar-köşe
 * paylaşan BAĞLANTILI BİLEŞENİNİ toplar; bileşenin sınır konturunu (sıralı
 * köşeler), sınır kenarlarını, üçgen indekslerini ve alan-ağırlıklı merkezini
 * döndürür. Hem yakalama önizlemesi (buildFacePreview) hem resize regen'i
 * (regenerateParentFaceShapeVF) aynı mantığı kullanır — VF her zaman tıklanan
 * bileşenin GERÇEK konturudur; ayrık eş-düzlem parçalar asla birleşmez.
 */
export function computeFaceComponentContour(
  faces: FaceData[],
  faceIndices: number[],
  seedLocal: THREE.Vector3,
  groupNormal: THREE.Vector3
): { comp: number[]; seedFi: number; corners: THREE.Vector3[]; center: THREE.Vector3; boundary: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> } | null {
  let seedFi = -1, bestD = Infinity;
  for (const fi of faceIndices) {
    const f = faces[fi];
    if (!f) continue;
    if (pointInTriangle3D(seedLocal, f.vertices[0], f.vertices[1], f.vertices[2])) { seedFi = fi; break; }
    const c = f.vertices[0].clone().add(f.vertices[1]).add(f.vertices[2]).multiplyScalar(1 / 3);
    const d = c.distanceTo(seedLocal);
    if (d < bestD) { bestD = d; seedFi = fi; }
  }
  if (seedFi === -1) return null;

  const vKey = (v3: THREE.Vector3) => `${v3.x.toFixed(1)},${v3.y.toFixed(1)},${v3.z.toFixed(1)}`;
  const triKeys = new Map<number, string[]>();
  for (const fi of faceIndices) {
    const f = faces[fi];
    if (f) triKeys.set(fi, f.vertices.map(vKey));
  }
  const comp = new Set<number>([seedFi]);
  const stack = [seedFi];
  while (stack.length) {
    const cur = stack.pop()!;
    const ck = new Set(triKeys.get(cur) || []);
    for (const [fi, ks] of triKeys) {
      if (comp.has(fi)) continue;
      if (ks.some(k => ck.has(k))) { comp.add(fi); stack.push(fi); }
    }
  }

  const edgeMap = new Map<string, { a: THREE.Vector3; b: THREE.Vector3; n: number }>();
  for (const fi of comp) {
    const f = faces[fi]!;
    for (let i = 0; i < 3; i++) {
      const a = f.vertices[i], b = f.vertices[(i + 1) % 3];
      const k = [vKey(a), vKey(b)].sort().join('|');
      const e = edgeMap.get(k);
      if (e) e.n++; else edgeMap.set(k, { a: a.clone(), b: b.clone(), n: 1 });
    }
  }
  const boundary = [...edgeMap.values()].filter(e => e.n === 1);
  if (boundary.length < 3) return null;

  const remaining = boundary.map(e => ({ a: e.a, b: e.b }));
  const ring: THREE.Vector3[] = [remaining[0].a, remaining[0].b];
  remaining.splice(0, 1);
  let guard = boundary.length * 2;
  while (remaining.length > 0 && guard-- > 0) {
    const tk = vKey(ring[ring.length - 1]);
    const idx = remaining.findIndex(e => vKey(e.a) === tk || vKey(e.b) === tk);
    if (idx === -1) break;
    const e = remaining[idx];
    ring.push(vKey(e.a) === tk ? e.b : e.a);
    remaining.splice(idx, 1);
  }
  if (ring.length >= 2 && vKey(ring[0]) === vKey(ring[ring.length - 1])) ring.pop();
  if (ring.length < 3) return null;

  const { u, v } = getFacePlaneAxes(groupNormal.clone().normalize());
  const ring2D = ring.map(p3 => ({ x: p3.dot(u), y: p3.dot(v) }));
  const keep: number[] = [];
  for (let i = 0; i < ring2D.length; i++) {
    const a = ring2D[(i - 1 + ring2D.length) % ring2D.length], b = ring2D[i], c = ring2D[(i + 1) % ring2D.length];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 0.05) keep.push(i);
  }
  const corners = keep.length >= 3 ? keep.map(i => ring[i]) : ring;

  const center = new THREE.Vector3();
  let areaSum = 0;
  for (const fi of comp) {
    const f = faces[fi]!;
    const ar = new THREE.Vector3().subVectors(f.vertices[1], f.vertices[0])
      .cross(new THREE.Vector3().subVectors(f.vertices[2], f.vertices[0])).length() / 2;
    const c = f.vertices[0].clone().add(f.vertices[1]).add(f.vertices[2]).multiplyScalar(1 / 3);
    center.addScaledVector(c, ar);
    areaSum += ar;
  }
  if (areaSum > 0) center.multiplyScalar(1 / areaSum);

  return { comp: [...comp], seedFi, corners, center, boundary };
}

export function buildFacePreview(
  clickWorld: THREE.Vector3,
  group: CoplanarFaceGroup,
  faces: FaceData[],
  worldToLocal: THREE.Matrix4,
  shapeId: string,
  geometry?: THREE.BufferGeometry,
  childPanels: any[] = []
): PendingPreview | null {
  const clickLocal = clickWorld.clone().applyMatrix4(worldToLocal);
  const contour = computeFaceComponentContour(faces, group.faceIndices, clickLocal, group.normal);
  if (!contour) return null;

  // ─── AKIŞLA ERİŞİLEBİLİR BÖLGE HIGHLIGHT'I ───
  // Highlight = tıklanan noktadan, bu yüzeye DEĞEN panellerin ayak izleri
  // (footprint) etrafında dolaşarak erişilebilen serbest alan. Panel yüzü
  // TAM bölüyorsa yalnız tıklanan taraf; panel kısaysa etrafından "sızılır"
  // ve yüzün tamamı seçilir — OCC üretim zinciri (kardeş kesimi + bağlantılı
  // parça seçimi) ile birebir aynı semantik. Grid + flood-fill ile hesaplanır;
  // VF kimliği (kontur/merkez) değişmez, yalnız görsel bölge daralır.
  const nrm = group.normal.clone().normalize();
  const { u, v } = getFacePlaneAxes(nrm);
  const ring2D: Point2D[] = contour.corners.map(c => ({ x: c.dot(u), y: c.dot(v) }));
  const planeN = contour.corners[0].dot(nrm);
  const planeOriginLocal = new THREE.Vector3().addScaledVector(nrm, planeN);
  const footprints: Point2D[][] = [];
  for (const panel of childPanels) {
    if (panel.parameters?.parentShapeId && panel.parameters.parentShapeId !== shapeId) continue;
    const fp = panelFootprintOnPlane(panel, nrm, planeOriginLocal, u, v);
    if (fp) footprints.push(fp);
  }

  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const q of ring2D) { uMin = Math.min(uMin, q.x); uMax = Math.max(uMax, q.x); vMin = Math.min(vMin, q.y); vMax = Math.max(vMax, q.y); }
  const uSpan = Math.max(uMax - uMin, 1e-6), vSpan = Math.max(vMax - vMin, 1e-6);
  const cell = Math.min(20, Math.max(2, Math.max(uSpan, vSpan) / 140));
  const nx = Math.min(240, Math.max(1, Math.ceil(uSpan / cell)));
  const ny = Math.min(240, Math.max(1, Math.ceil(vSpan / cell)));
  const cw = uSpan / nx, ch = vSpan / ny;
  const inFree = (cx: number, cy: number): boolean => {
    const pt = { x: uMin + (cx + 0.5) * cw, y: vMin + (cy + 0.5) * ch };
    if (!isPointInsidePolygon(pt, ring2D)) return false;
    for (const fp of footprints) if (isPointInsidePolygon(pt, fp)) return false;
    return true;
  };
  const free = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) free[j * nx + i] = inFree(i, j) ? 1 : 0;

  const cu = clickLocal.dot(u), cv = clickLocal.dot(v);
  let ci = Math.max(0, Math.min(nx - 1, Math.floor((cu - uMin) / cw)));
  let cj = Math.max(0, Math.min(ny - 1, Math.floor((cv - vMin) / ch)));
  if (!free[cj * nx + ci]) {
    // Tıklama hücresi dolu/dışarıda (kenar durumu): en yakın serbest hücre
    let bd = Infinity, bi = ci, bj = cj;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!free[j * nx + i]) continue;
      const d = (i - ci) * (i - ci) + (j - cj) * (j - cj);
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
    ci = bi; cj = bj;
  }
  const reach = new Uint8Array(nx * ny);
  if (free[cj * nx + ci]) {
    const q: number[] = [cj * nx + ci];
    reach[cj * nx + ci] = 1;
    while (q.length) {
      const idx = q.pop()!;
      const i = idx % nx, j = (idx / nx) | 0;
      const nb = [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]];
      for (const [a, b] of nb) {
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const k = b * nx + a;
        if (free[k] && !reach[k]) { reach[k] = 1; q.push(k); }
      }
    }
  }

  const to3D = (px: number, py: number) => new THREE.Vector3()
    .addScaledVector(u, px).addScaledVector(v, py).addScaledVector(nrm, planeN);
  const pos: number[] = [];
  const epos: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!reach[j * nx + i]) continue;
    const x0 = uMin + i * cw, x1 = x0 + cw, y0 = vMin + j * ch, y1 = y0 + ch;
    const p00 = to3D(x0, y0), p10 = to3D(x1, y0), p11 = to3D(x1, y1), p01 = to3D(x0, y1);
    pos.push(p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z,
             p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z);
    // Sınır kenarı: komşusu erişilemezse çiz
    const bnd: Array<[THREE.Vector3, THREE.Vector3]> = [];
    if (i === 0 || !reach[j * nx + i - 1]) bnd.push([p00, p01]);
    if (i === nx - 1 || !reach[j * nx + i + 1]) bnd.push([p10, p11]);
    if (j === 0 || !reach[(j - 1) * nx + i]) bnd.push([p00, p10]);
    if (j === ny - 1 || !reach[(j + 1) * nx + i]) bnd.push([p01, p11]);
    for (const [a, b] of bnd) epos.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  // Güvence: hiç hücre yoksa tam bileşen dolgusuna düş
  if (pos.length === 0) {
    for (const fi of contour.comp) {
      const f = faces[fi]!;
      for (const vv of f.vertices) pos.push(vv.x, vv.y, vv.z);
    }
    for (const e of contour.boundary) epos.push(e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(epos), 3));

  console.log('[YAGO][TIK]', 'clickLocal=',
    `${clickLocal.x.toFixed(1)},${clickLocal.y.toFixed(1)},${clickLocal.z.toFixed(1)}`,
    'konturKöşeN=', contour.corners.length,
    'konturBBox=', (() => { let a=[Infinity,Infinity,Infinity],b=[-Infinity,-Infinity,-Infinity];
      for (const c of contour.corners){a[0]=Math.min(a[0],c.x);a[1]=Math.min(a[1],c.y);a[2]=Math.min(a[2],c.z);
        b[0]=Math.max(b[0],c.x);b[1]=Math.max(b[1],c.y);b[2]=Math.max(b[2],c.z);}
      return a.map(n=>n.toFixed(0)).join(',')+' .. '+b.map(n=>n.toFixed(0)).join(','); })());
  const localNormal = group.normal.clone().normalize();
  // BÖLGE KİMLİĞİ: merkez, bileşen merkezi DEĞİL kullanıcının TIKLADIĞI
  // noktadır. Aynı yüzdeki iki panelin VF'leri aynı konturu taşısa da
  // merkezleri farklı kalır; rebuild'deki bölge seçimi ve kardeş kesimi bu
  // kimliğe göre doğru tarafı tutar. (Bileşen merkezine çökertmek, iki
  // paneli özdeşleştirip üst üste bindiriyordu.)
  const virtualFace: VirtualFace = {
    id: `vf-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    shapeId,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    center: [clickLocal.x, clickLocal.y, clickLocal.z],
    vertices: contour.corners.map(c => [c.x, c.y, c.z] as [number, number, number]),
    description: '',
    hasPanel: false,
    parentFaceShape: true,
    // ÖLÇEK-BAĞIMSIZ YÜZ KİMLİĞİ: resize'da regen, yüzü bu descriptor ile
    // bulur (normalize merkez + eksen) — "en yakın düzlem" tahmini yerine
    // kesin eşleşme; VF asla komşu bir yüze (ör. çentik yanağına) savrulmaz.
    faceGroupDescriptor: geometry ? createFaceDescriptor(faces[contour.seedFi], geometry) : undefined,
  };
  return { geo, edgeGeo, virtualFace };
}

// Refined neutral palette — slate/zinc tones, subtle and professional
const RAYCAST_COLORS = {
  rayLine:        0x94a3b8, // slate-400 — muted line
  hitDot:         0x64748b, // slate-500 — subtle endpoint
  originDot:      0xe2e8f0, // slate-200 — bright origin
  previewFill:    0x38bdf8, // sky-400 — clean ice blue fill
  previewEdge:    0x0ea5e9, // sky-500 — crisper boundary
  hoverEmpty:     0xfcd34d, // amber-300 — warm highlight for empty face
  hoverHasVF:     0x7dd3fc, // sky-300 — cool highlight for placed face
  vfFill:         0x38bdf8, // sky-400 — consistent with preview
  vfFillHovered:  0x0ea5e9, // sky-500
  vfEdge:         0x0369a1, // sky-700 — visible edge
};

const RayLine3D: React.FC<{ start: THREE.Vector3; end: THREE.Vector3 }> = React.memo(({ start, end }) => {
  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints([start, end]), [start.x, start.y, start.z, end.x, end.y, end.z]);
  return (
    <lineSegments geometry={geometry} raycast={() => null}>
      <lineBasicMaterial color={RAYCAST_COLORS.rayLine} linewidth={1.5} depthTest={false} transparent opacity={0.7} />
    </lineSegments>
  );
});
RayLine3D.displayName = 'RayLine3D';

const HitDot: React.FC<{ position: THREE.Vector3 }> = React.memo(({ position }) => (
  <mesh position={[position.x, position.y, position.z]} raycast={() => null}>
    <sphereGeometry args={[2, 8, 8]} />
    <meshBasicMaterial color={RAYCAST_COLORS.hitDot} depthTest={false} transparent opacity={0.8} />
  </mesh>
));
HitDot.displayName = 'HitDot';

const OriginDot: React.FC<{ position: THREE.Vector3 }> = React.memo(({ position }) => (
  <mesh position={[position.x, position.y, position.z]} raycast={() => null}>
    <sphereGeometry args={[3, 8, 8]} />
    <meshBasicMaterial color={RAYCAST_COLORS.originDot} depthTest={false} transparent opacity={0.9} />
  </mesh>
));
OriginDot.displayName = 'OriginDot';

function buildSurfaceMeshes(vf: VirtualFace): { geo: THREE.BufferGeometry; edgeGeo: THREE.BufferGeometry } | null {
  if (vf.vertices.length < 3) return null;
  const corners = vf.vertices.map(v => new THREE.Vector3(v[0], v[1], v[2]));
  const normal = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
  const { u: uAxis, v: vAxis } = getFacePlaneAxes(normal);
  const origin = corners[0];
  const projected2D = corners.map(c => { const d = new THREE.Vector3().subVectors(c, origin); return { x: d.dot(uAxis), y: d.dot(vAxis) }; });
  let area = 0;
  for (let i = 0; i < projected2D.length; i++) {
    const j = (i + 1) % projected2D.length;
    area += projected2D[i].x * projected2D[j].y - projected2D[j].x * projected2D[i].y;
  }
  if (area < 0) { projected2D.reverse(); corners.reverse(); }
  const triIndices = earClipTriangulate(projected2D);
  const positions = new Float32Array(triIndices.length * 3);
  for (let i = 0; i < triIndices.length; i++) {
    const c = corners[triIndices[i]];
    positions[i * 3] = c.x; positions[i * 3 + 1] = c.y; positions[i * 3 + 2] = c.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const edgeVerts: number[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    edgeVerts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgeVerts), 3));
  return { geo, edgeGeo };
}

interface VirtualFaceOverlayProps { shape: any; }

export const VirtualFaceOverlay: React.FC<VirtualFaceOverlayProps> = ({ shape }) => {
  const { virtualFaces, showVirtualFaces, panelSurfaceSelectMode, waitingForSurfaceSelection, triggerPanelCreationForFace, setSelectedPanelRow, panelSelectMode } = useAppStore();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const shapeFaces = useMemo(() => virtualFaces.filter(f => f.shapeId === shape.id && !f.hasPanel), [virtualFaces, shape.id]);
  const meshes = useMemo(() => {
    return shapeFaces.map(vf => { const result = buildSurfaceMeshes(vf); return result ? { id: vf.id, vf, ...result } : null; }).filter(Boolean) as Array<{ id: string; vf: VirtualFace; geo: THREE.BufferGeometry; edgeGeo: THREE.BufferGeometry }>;
  }, [shapeFaces]);
  if (!showVirtualFaces || meshes.length === 0) return null;
  return (
    <>
      {meshes.map((surface, idx) => {
        const isHovered = hoveredId === surface.id;
        return (
          <React.Fragment key={surface.id}>
            <mesh
              geometry={surface.geo}
              onClick={(e) => {
                e.stopPropagation();
                if (panelSurfaceSelectMode) {
                  triggerPanelCreationForFace(-(idx + 1), shape.id, { center: surface.vf.center, normal: surface.vf.normal, constraintPanelId: surface.vf.id });
                  setSelectedPanelRow(`vf-${surface.vf.id}`);
                } else if (panelSelectMode) {
                  setSelectedPanelRow(`vf-${surface.vf.id}`);
                }
              }}
              onPointerOver={(e) => { e.stopPropagation(); setHoveredId(surface.id); }}
              onPointerOut={(e) => { e.stopPropagation(); setHoveredId(null); }}
            >
              <meshBasicMaterial color={isHovered && panelSurfaceSelectMode ? RAYCAST_COLORS.vfFillHovered : RAYCAST_COLORS.vfFill} transparent opacity={isHovered ? 0.55 : 0.30} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} depthTest={false} />
            </mesh>
            <lineSegments geometry={surface.edgeGeo}>
              <lineBasicMaterial color={RAYCAST_COLORS.vfEdge} linewidth={2} depthTest={false} transparent opacity={0.85} />
            </lineSegments>
          </React.Fragment>
        );
      })}
    </>
  );
};

export const FaceRaycastOverlay: React.FC<FaceRaycastOverlayProps> = ({ shape, allShapes = [] }) => {
  const { raycastMode, setRaycastMode, addVirtualFace, virtualFaces, setSelectedPanelRow } = useAppStore();
  const [faces, setFaces] = useState<FaceData[]>([]);
  const [faceGroups, setFaceGroups] = useState<CoplanarFaceGroup[]>([]);
  const [hoveredGroupIndex, setHoveredGroupIndex] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingPreview | null>(null);
  const lastClickRef = useRef<{ point: THREE.Vector3; groupIndex: number; cycleIndex: number } | null>(null);
  const shapeVirtualFaces = useMemo(() => virtualFaces.filter(vf => vf.shapeId === shape.id), [virtualFaces, shape.id]);
  const geometryUuid = shape.geometry?.uuid || '';
  const localToWorld = useMemo(() => getShapeMatrix(shape), [shape.position[0], shape.position[1], shape.position[2], shape.rotation[0], shape.rotation[1], shape.rotation[2], shape.scale[0], shape.scale[1], shape.scale[2]]);
  const worldToLocal = useMemo(() => localToWorld.clone().invert(), [localToWorld]);
  useEffect(() => {
    if (!shape.geometry) return;
    setFaces(extractFacesFromGeometry(shape.geometry));
    setFaceGroups(groupCoplanarFaces(extractFacesFromGeometry(shape.geometry)));
    setPending(null);
    lastClickRef.current = null;
  }, [shape.geometry, shape.id, geometryUuid]);
  useEffect(() => { if (!raycastMode) { setHoveredGroupIndex(null); setPending(null); lastClickRef.current = null; } }, [raycastMode]);
  // Use current (post-extrude) geometry so that shortened panels produce correct
  // obstacle edges — the void area left by a shortened panel must be visitable.
  const childPanels = useMemo(
    () => allShapes.filter(s => s.type === 'panel' && s.parameters?.parentShapeId === shape.id),
    [allShapes, shape.id]
  );
  // Aynı DÜZLEMDEKİ tüm VF'ler (merkez artık tıklama noktası olduğundan
  // grup merkeziyle nokta eşleşmesi yerine düzlem eşleşmesi kullanılır;
  // bir yüzde birden çok panel olabilir → liste döner).
  const findVirtualFacesForGroup = useCallback((gi: number): VirtualFace[] => {
    if (gi < 0 || gi >= faceGroups.length || shapeVirtualFaces.length === 0) return [];
    const gn = faceGroups[gi].normal.clone().normalize();
    const gc = faceGroups[gi].center.clone();
    return shapeVirtualFaces.filter(vf => {
      const vn = new THREE.Vector3(...vf.normal).normalize();
      if (Math.abs(gn.dot(vn)) < 0.98) return false;
      const vc = new THREE.Vector3(...vf.center);
      return Math.abs(vc.clone().sub(gc).dot(gn)) < 2; // düzleme mesafe
    });
  }, [faceGroups, shapeVirtualFaces]);
  const groupHasVirtualFace = useCallback((gi: number) => findVirtualFacesForGroup(gi).length > 0, [findVirtualFacesForGroup]);
  const hoverHighlightGeometry = useMemo(() => {
    if (hoveredGroupIndex === null || !faceGroups[hoveredGroupIndex]) return null;
    return createFaceHighlightGeometry(faces, faceGroups[hoveredGroupIndex].faceIndices);
  }, [hoveredGroupIndex, faceGroups, faces]);
  const handlePointerMove = (e: any) => {
    if (!raycastMode || faces.length === 0) return;
    e.stopPropagation();
    if (e.faceIndex !== undefined) {
      const gi = faceGroups.findIndex(g => g.faceIndices.includes(e.faceIndex));
      if (gi !== -1) setHoveredGroupIndex(gi);
    }
  };
  const handlePointerOut = (e: any) => { e.stopPropagation(); setHoveredGroupIndex(null); };
  const handlePointerDown = (e: any) => {
    if (!raycastMode) return;
    if (e.button === 2) {
      e.stopPropagation();
      if (pending) { addVirtualFace(pending.virtualFace); setPending(null); lastClickRef.current = null; setRaycastMode(false); }
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    if (hoveredGroupIndex === null || !faceGroups[hoveredGroupIndex]) return;

    const clickPoint: THREE.Vector3 = e.point.clone();
    const clickLocal = clickPoint.clone().applyMatrix4(worldToLocal);

    const isSameSpot = lastClickRef.current && lastClickRef.current.point.distanceTo(clickLocal) < 5;
    // A face is considered "defined" (has an active panel under the cursor) only when
    // the click point falls inside the panel's CURRENT GEOMETRY footprint on the face
    // plane — not the VF polygon (which stays as original full-face for correct rebuild).
    // This lets users click in the void left by a shortened panel.
    const _normalMatrix = new THREE.Matrix3().getNormalMatrix(localToWorld);
    // PANEL-İÇİ TIKLAMA: tıklanan düzlem noktası, bu yüzeye DEĞEN herhangi
    // bir panelin ayak izi içindeyse yüz o noktada "tanımlıdır" — panel
    // TAŞINMIŞ olsa bile (test VF konumuna değil panelin GÜNCEL geometrisine
    // dayanır). Panellerin arasındaki/dışındaki boşluk serbesttir ve
    // highlight yalnız oradan akar.
    const hoveredNormalW = faceGroups[hoveredGroupIndex].normal.clone()
      .applyMatrix3(_normalMatrix).normalize();
    const coveringPanel = findPanelCoveringPoint(clickPoint, childPanels, hoveredNormalW, clickPoint);
    const hoveredIsDefined = coveringPanel !== null;

    let targetGroupIndex = hoveredGroupIndex;
    let previewClickPoint = clickPoint;
    let cycleCandidates: Array<{ index: number; depth: number; hitPoint: THREE.Vector3 }> | null = null;

    const cameraPos = e.camera?.position?.clone();
    if (cameraPos && (isSameSpot || hoveredIsDefined)) {
      const rayOrigin = cameraPos;
      const rayDir = clickPoint.clone().sub(rayOrigin).normalize();
      const candidateGroups: Array<{ index: number; depth: number; hitPoint: THREE.Vector3 }> = [];

      for (let gi = 0; gi < faceGroups.length; gi++) {
        // Skip this face group only when the ray's hit point on its plane is actually
        // INSIDE an existing panel VF — void areas on the same group are allowed.

        const group = faceGroups[gi];
        const groupNormalWorld = group.normal.clone().normalize().applyMatrix3(
          new THREE.Matrix3().getNormalMatrix(localToWorld)
        ).normalize();
        const planePoint = group.center.clone().applyMatrix4(localToWorld);
        const denom = groupNormalWorld.dot(rayDir);
        if (Math.abs(denom) < 1e-6) continue;
        const t = planePoint.clone().sub(rayOrigin).dot(groupNormalWorld) / denom;
        if (t < 0) continue;
        const hitOnPlane = rayOrigin.clone().addScaledVector(rayDir, t);

        // Skip if the hit point on this plane falls inside the panel's current geometry
        // footprint. Do NOT skip void areas — those are valid raycast targets.
        {
          const giNormalW = group.normal.clone().normalize().applyMatrix3(
            new THREE.Matrix3().getNormalMatrix(localToWorld)
          ).normalize();
          if (findPanelCoveringPoint(hitOnPlane, childPanels, giNormalW, hitOnPlane)) continue;
        }

        let inside = false;
        for (const fi of group.faceIndices) {
          const face = faces[fi];
          if (!face) continue;
          const vA = face.vertices[0].clone().applyMatrix4(localToWorld);
          const vB = face.vertices[1].clone().applyMatrix4(localToWorld);
          const vC = face.vertices[2].clone().applyMatrix4(localToWorld);
          if (pointInTriangle3D(hitOnPlane, vA, vB, vC)) { inside = true; break; }
        }
        if (inside) {
          candidateGroups.push({ index: gi, depth: t, hitPoint: hitOnPlane });
        }
      }
      candidateGroups.sort((a, b) => a.depth - b.depth);
      cycleCandidates = candidateGroups;
    }

    if (cycleCandidates && cycleCandidates.length > 0) {
      let nextCycleIndex = 0;
      if (isSameSpot && !hoveredIsDefined) {
        const prevCycleIndex = lastClickRef.current!.cycleIndex;
        nextCycleIndex = (prevCycleIndex + 1) % cycleCandidates.length;
      }
      targetGroupIndex = cycleCandidates[nextCycleIndex].index;
      previewClickPoint = cycleCandidates[nextCycleIndex].hitPoint;
      lastClickRef.current = { point: clickLocal, groupIndex: targetGroupIndex, cycleIndex: nextCycleIndex };
    } else if (hoveredIsDefined) {
      const vfId = coveringPanel?.parameters?.virtualFaceId;
      if (vfId) setSelectedPanelRow(`vf-${vfId}`, null, shape.id);
      return;
    } else {
      lastClickRef.current = { point: clickLocal, groupIndex: targetGroupIndex, cycleIndex: 0 };
    }

    setHoveredGroupIndex(targetGroupIndex);
    // TAM YÜZ SEÇİMİ: tıklanan yüzün bağlantılı bileşeni komple seçilir.
    // Derinlik döngüsü (aynı noktaya tekrar tıklayınca arkadaki yüz) korunur.
    setPending(buildFacePreview(previewClickPoint, faceGroups[targetGroupIndex], faces, worldToLocal, shape.id, shape.geometry, childPanels));
  };
  if (!raycastMode) return null;
  return (
    <>
      <mesh geometry={shape.geometry} visible={false} onPointerMove={handlePointerMove} onPointerOut={handlePointerOut} onPointerDown={handlePointerDown} />
      {hoverHighlightGeometry && (
        <mesh geometry={hoverHighlightGeometry} raycast={() => null}>
          <meshBasicMaterial color={hoveredGroupIndex !== null && groupHasVirtualFace(hoveredGroupIndex) ? RAYCAST_COLORS.hoverHasVF : RAYCAST_COLORS.hoverEmpty} transparent opacity={0.28} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
        </mesh>
      )}
      {pending && (
        <>
          <mesh geometry={pending.geo} raycast={() => null}>
            <meshBasicMaterial color={RAYCAST_COLORS.previewFill} transparent opacity={0.38} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} depthTest={false} />
          </mesh>
          <lineSegments geometry={pending.edgeGeo} raycast={() => null}>
            <lineBasicMaterial color={RAYCAST_COLORS.previewEdge} linewidth={2} depthTest={false} transparent opacity={1.0} />
          </lineSegments>
        </>
      )}
    </>
  );
};
