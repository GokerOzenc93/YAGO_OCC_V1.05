import React, { useMemo, useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../store';
import type { VirtualFace, EdgeAnchor } from '../store';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  createFaceHighlightGeometry,
  createFaceDescriptor,
  FaceData,
  CoplanarFaceGroup,
} from './FaceEditor';

interface RayLine { start: THREE.Vector3; end: THREE.Vector3; }
interface FaceRaycastOverlayProps { shape: any; allShapes?: any[]; }

export function getFacePlaneAxes(normal: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const n = normal.clone().normalize();
  const absX = Math.abs(n.x), absY = Math.abs(n.y), absZ = Math.abs(n.z);
  const up = absY > absX && absY > absZ ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(n, up).normalize();
  const v = new THREE.Vector3().crossVectors(u, n).normalize();
  return { u, v };
}

export function getShapeMatrix(shape: any): THREE.Matrix4 {
  const pos = new THREE.Vector3(shape.position[0], shape.position[1], shape.position[2]);
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2], 'XYZ'));
  const scale = new THREE.Vector3(shape.scale[0], shape.scale[1], shape.scale[2]);
  return new THREE.Matrix4().compose(pos, quat, scale);
}

export function collectBoundaryEdgesWorld(faces: FaceData[], faceIndices: number[], localToWorld: THREE.Matrix4): Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> {
  const edgeMap = new Map<string, { v1: THREE.Vector3; v2: THREE.Vector3; count: number }>();
  faceIndices.forEach(fi => {
    const face = faces[fi];
    if (!face) return;
    for (let i = 0; i < 3; i++) {
      const va = face.vertices[i].clone().applyMatrix4(localToWorld);
      const vb = face.vertices[(i + 1) % 3].clone().applyMatrix4(localToWorld);
      const ka = `${va.x.toFixed(2)},${va.y.toFixed(2)},${va.z.toFixed(2)}`;
      const kb = `${vb.x.toFixed(2)},${vb.y.toFixed(2)},${vb.z.toFixed(2)}`;
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (!edgeMap.has(key)) edgeMap.set(key, { v1: va, v2: vb, count: 0 });
      edgeMap.get(key)!.count++;
    }
  });
  const boundary: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> = [];
  edgeMap.forEach(e => { if (e.count === 1) boundary.push({ v1: e.v1, v2: e.v2 }); });
  return boundary;
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

export function collectPanelObstacleEdgesWorld(panelShapes: any[], facePlaneNormal: THREE.Vector3, facePlaneOrigin: THREE.Vector3, planeTolerance: number = 15): Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> {
  const obstacleEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> = [];
  for (const panel of panelShapes) {
    if (!panel.geometry) continue;
    const panelMatrix = getShapeMatrix(panel);
    const edgesGeo = new THREE.EdgesGeometry(panel.geometry);
    const edgePos = edgesGeo.getAttribute('position');
    for (let i = 0; i < edgePos.count; i += 2) {
      const va = new THREE.Vector3(edgePos.getX(i), edgePos.getY(i), edgePos.getZ(i)).applyMatrix4(panelMatrix);
      const vb = new THREE.Vector3(edgePos.getX(i + 1), edgePos.getY(i + 1), edgePos.getZ(i + 1)).applyMatrix4(panelMatrix);
      const distA = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(va, facePlaneOrigin)));
      const distB = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(vb, facePlaneOrigin)));
      if (distA < planeTolerance && distB < planeTolerance) obstacleEdges.push({ v1: va, v2: vb });
    }
    edgesGeo.dispose();
  }
  return obstacleEdges;
}

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

export function collectSubtractionObstacleEdgesWorld(subtractions: any[], parentLocalToWorld: THREE.Matrix4, facePlaneNormal: THREE.Vector3, facePlaneOrigin: THREE.Vector3, planeTolerance: number = 20): Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> {
  const edges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> = [];
  for (const sub of subtractions) {
    if (!sub || !sub.geometry) continue;
    const subWorldMatrix = getSubtractionWorldMatrix(parentLocalToWorld, sub);
    const edgesGeo = new THREE.EdgesGeometry(sub.geometry);
    const edgePos = edgesGeo.getAttribute('position');
    for (let i = 0; i < edgePos.count; i += 2) {
      const va = new THREE.Vector3(edgePos.getX(i), edgePos.getY(i), edgePos.getZ(i)).applyMatrix4(subWorldMatrix);
      const vb = new THREE.Vector3(edgePos.getX(i + 1), edgePos.getY(i + 1), edgePos.getZ(i + 1)).applyMatrix4(subWorldMatrix);
      const distA = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(va, facePlaneOrigin)));
      const distB = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(vb, facePlaneOrigin)));
      if (distA < planeTolerance && distB < planeTolerance) edges.push({ v1: va, v2: vb });
    }
    edgesGeo.dispose();
  }
  return edges;
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

export function ensureCCW(poly: Point2D[]): Point2D[] {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area < 0 ? [...poly].reverse() : poly;
}

interface RayHitResult {
  hitPoint: THREE.Vector3;
  hitEdge: { v1: THREE.Vector3; v2: THREE.Vector3 } | null;
  edgeT: number;
  isBoundaryEdge: boolean;
}

function castRayOnFaceWorldDetailed(originWorld: THREE.Vector3, dirWorld: THREE.Vector3, boundaryEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>, obstacleEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>, u: THREE.Vector3, v: THREE.Vector3, planeOrigin: THREE.Vector3, maxDist: number): RayHitResult {
  const o2d = projectTo2D(originWorld, planeOrigin, u, v);
  const dir2d = { x: dirWorld.dot(u), y: dirWorld.dot(v) };
  let tMin = maxDist, hitEdge: { v1: THREE.Vector3; v2: THREE.Vector3 } | null = null, hitEdgeT = 0, isBoundary = false;
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
    if (t !== null && t < tMin) { tMin = t; hitEdge = edge; isBoundary = false; hitEdgeT = 0; }
  }
  return { hitPoint: originWorld.clone().addScaledVector(dirWorld, tMin), hitEdge, edgeT: Math.max(0, Math.min(1, hitEdgeT)), isBoundaryEdge: isBoundary };
}

export function castRayOnFaceWorld(originWorld: THREE.Vector3, dirWorld: THREE.Vector3, boundaryEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>, obstacleEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>, u: THREE.Vector3, v: THREE.Vector3, planeOrigin: THREE.Vector3, maxDist: number): THREE.Vector3 {
  return castRayOnFaceWorldDetailed(originWorld, dirWorld, boundaryEdges, obstacleEdges, u, v, planeOrigin, maxDist).hitPoint;
}

interface PendingPreview {
  rayLines: RayLine[];
  originLocal: THREE.Vector3;
  geo: THREE.BufferGeometry;
  edgeGeo: THREE.BufferGeometry;
  virtualFace: VirtualFace;
}

export function collectVirtualFaceObstacleEdgesWorld(virtualFaces: VirtualFace[], excludeId: string | null, shapeLocalToWorld: THREE.Matrix4, facePlaneNormal: THREE.Vector3, facePlaneOrigin: THREE.Vector3, planeTolerance: number = 20): Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> {
  const edges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> = [];
  for (const vf of virtualFaces) {
    if (vf.id === excludeId || vf.vertices.length < 3) continue;
    const worldVerts = vf.vertices.map(vtx => new THREE.Vector3(vtx[0], vtx[1], vtx[2]).applyMatrix4(shapeLocalToWorld));
    for (let i = 0; i < worldVerts.length; i++) {
      const va = worldVerts[i], vb = worldVerts[(i + 1) % worldVerts.length];
      const distA = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(va, facePlaneOrigin)));
      const distB = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(vb, facePlaneOrigin)));
      if (distA < planeTolerance && distB < planeTolerance) edges.push({ v1: va, v2: vb });
    }
  }
  return edges;
}

function buildPreview(clickWorld: THREE.Vector3, group: CoplanarFaceGroup, faces: FaceData[], localToWorld: THREE.Matrix4, worldToLocal: THREE.Matrix4, childPanels: any[], shapeId: string, subtractions: any[] = [], geometry?: THREE.BufferGeometry, shapeVirtualFaces: VirtualFace[] = []): PendingPreview | null {
  const localNormal = group.normal.clone().normalize();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(localToWorld);
  const worldNormal = localNormal.clone().applyMatrix3(normalMatrix).normalize();
  const { u, v } = getFacePlaneAxes(worldNormal);
  const planeOrigin = clickWorld.clone();
  const boundaryEdges = collectBoundaryEdgesWorld(faces, group.faceIndices, localToWorld);
  const panelEdges = collectPanelObstacleEdgesWorld(childPanels, worldNormal, planeOrigin, 20);
  const subEdges = collectSubtractionObstacleEdgesWorld(subtractions, localToWorld, worldNormal, planeOrigin, 20);
  const vfEdges = collectVirtualFaceObstacleEdgesWorld(shapeVirtualFaces, null, localToWorld, worldNormal, planeOrigin, 20);
  const obstacleEdges = [...panelEdges, ...subEdges, ...vfEdges];
  const maxDist = 5000;
  const offset = worldNormal.clone().multiplyScalar(0.5);
  const startWorld = clickWorld.clone().add(offset);
  const dirLabels: Array<'u+' | 'u-' | 'v+' | 'v-'> = ['u+', 'u-', 'v+', 'v-'];
  const directions = [u, u.clone().negate(), v, v.clone().negate()];
  const lines: RayLine[] = [];
  const hitPointsWorld: THREE.Vector3[] = [];
  const edgeAnchors: EdgeAnchor[] = [];
  const parentPos = new THREE.Vector3();
  localToWorld.decompose(parentPos, new THREE.Quaternion(), new THREE.Vector3());
  for (let di = 0; di < directions.length; di++) {
    const dir = directions[di];
    const result = castRayOnFaceWorldDetailed(startWorld, dir, boundaryEdges, obstacleEdges, u, v, planeOrigin, maxDist);
    lines.push({ start: startWorld.clone().sub(parentPos), end: result.hitPoint.clone().sub(parentPos) });
    hitPointsWorld.push(result.hitPoint);
    if (result.hitEdge && result.isBoundaryEdge) {
      const v1Local = result.hitEdge.v1.clone().applyMatrix4(worldToLocal);
      const v2Local = result.hitEdge.v2.clone().applyMatrix4(worldToLocal);
      edgeAnchors.push({ edgeV1Local: [v1Local.x, v1Local.y, v1Local.z], edgeV2Local: [v2Local.x, v2Local.y, v2Local.z], t: result.edgeT, direction: dirLabels[di] });
    }
  }
  if (hitPointsWorld.length < 4) return null;
  const [uPosHit, uNegHit, vPosHit, vNegHit] = hitPointsWorld;
  const uPosT = uPosHit.distanceTo(startWorld), uNegT = uNegHit.distanceTo(startWorld);
  const vPosT = vPosHit.distanceTo(startWorld), vNegT = vNegHit.distanceTo(startWorld);
  let rect2D: Point2D[] = ensureCCW([{ x: uPosT, y: vPosT }, { x: -uNegT, y: vPosT }, { x: -uNegT, y: -vNegT }, { x: uPosT, y: -vNegT }]);
  const footprints = getSubtractorFootprints2D(subtractions, localToWorld, worldNormal, planeOrigin, u, v, 50);
  let clippedPoly = rect2D;
  for (const footprint of footprints) {
    const ccwFootprint = ensureCCW(footprint);
    const hasOverlap = ccwFootprint.some(p => isPointInsidePolygon(p, clippedPoly)) || clippedPoly.some(p => isPointInsidePolygon(p, ccwFootprint));
    if (hasOverlap) clippedPoly = subtractPolygon(clippedPoly, ccwFootprint);
  }
  if (clippedPoly.length < 3) return null;
  const finalCornersWorld = clippedPoly.map(p => startWorld.clone().addScaledVector(u, p.x).addScaledVector(v, p.y));
  const centerW = new THREE.Vector3();
  finalCornersWorld.forEach(c => centerW.add(c));
  centerW.divideScalar(finalCornersWorld.length);
  const cornersLocal = finalCornersWorld.map(c => c.clone().applyMatrix4(worldToLocal));
  const centerLocal = centerW.clone().applyMatrix4(worldToLocal);
  const triIndices = earClipTriangulate(clippedPoly);
  const localPositions = new Float32Array(triIndices.length * 3);
  for (let i = 0; i < triIndices.length; i++) {
    const cl = cornersLocal[triIndices[i]];
    localPositions[i * 3] = cl.x; localPositions[i * 3 + 1] = cl.y; localPositions[i * 3 + 2] = cl.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(localPositions, 3));
  geo.computeVertexNormals();
  const edgeVerts: number[] = [];
  for (let i = 0; i < cornersLocal.length; i++) {
    const a = cornersLocal[i], b = cornersLocal[(i + 1) % cornersLocal.length];
    edgeVerts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgeVerts), 3));
  const clickLocal = clickWorld.clone().applyMatrix4(worldToLocal);
  let faceGroupDescriptor: import('../store').FaceDescriptor | undefined;
  if (geometry && group.faceIndices.length > 0) {
    const representativeFace = faces[group.faceIndices[0]];
    if (representativeFace) faceGroupDescriptor = createFaceDescriptor(representativeFace, geometry);
  }
  let normalizedClickUV: [number, number] | undefined;
  {
    const faceWorldVerts: THREE.Vector3[] = [];
    group.faceIndices.forEach(fi => { const face = faces[fi]; if (!face) return; face.vertices.forEach(v3 => faceWorldVerts.push(v3.clone().applyMatrix4(localToWorld))); });
    if (faceWorldVerts.length > 0) {
      const faceVertsU = faceWorldVerts.map(vw => vw.dot(u)), faceVertsV = faceWorldVerts.map(vw => vw.dot(v));
      const uMin = Math.min(...faceVertsU), uMax = Math.max(...faceVertsU);
      const vMin = Math.min(...faceVertsV), vMax = Math.max(...faceVertsV);
      const uSpan = uMax - uMin, vSpan = vMax - vMin;
      if (uSpan > 0 && vSpan > 0) {
        const clickU = clickWorld.dot(u), clickV = clickWorld.dot(v);
        normalizedClickUV = [Math.max(0, Math.min(1, (clickU - uMin) / uSpan)), Math.max(0, Math.min(1, (clickV - vMin) / vSpan))];
      }
    }
  }
  const newId = `vf-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  const virtualFace: VirtualFace = {
    id: newId, shapeId,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    center: [centerLocal.x, centerLocal.y, centerLocal.z],
    vertices: cornersLocal.map(c => [c.x, c.y, c.z] as [number, number, number]),
    role: null, description: '', hasPanel: false,
    raycastRecipe: faceGroupDescriptor ? {
      clickLocalPoint: [clickLocal.x, clickLocal.y, clickLocal.z],
      faceGroupNormal: [localNormal.x, localNormal.y, localNormal.z],
      faceGroupDescriptor, normalizedClickUV,
      edgeAnchors: edgeAnchors.length === 4 ? edgeAnchors : undefined,
    } : undefined,
  };
  return { rayLines: lines, originLocal: clickWorld.clone().sub(parentPos), geo, edgeGeo, virtualFace };
}

const RayLine3D: React.FC<{ start: THREE.Vector3; end: THREE.Vector3 }> = React.memo(({ start, end }) => {
  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints([start, end]), [start.x, start.y, start.z, end.x, end.y, end.z]);
  return <lineSegments geometry={geometry}><lineBasicMaterial color={0xf97316} linewidth={2} depthTest={false} transparent opacity={0.9} /></lineSegments>;
});
RayLine3D.displayName = 'RayLine3D';

const HitDot: React.FC<{ position: THREE.Vector3 }> = React.memo(({ position }) => (
  <mesh position={[position.x, position.y, position.z]}>
    <sphereGeometry args={[2.5, 8, 8]} />
    <meshBasicMaterial color={0xef4444} depthTest={false} transparent opacity={0.9} />
  </mesh>
));
HitDot.displayName = 'HitDot';

const OriginDot: React.FC<{ position: THREE.Vector3 }> = React.memo(({ position }) => (
  <mesh position={[position.x, position.y, position.z]}>
    <sphereGeometry args={[3.5, 8, 8]} />
    <meshBasicMaterial color={0xfbbf24} depthTest={false} transparent opacity={0.95} />
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
              <meshBasicMaterial color={isHovered && panelSurfaceSelectMode ? 0x00cc44 : 0x22c55e} transparent opacity={isHovered ? 0.65 : 0.38} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} depthTest={false} />
            </mesh>
            <lineSegments geometry={surface.edgeGeo}>
              <lineBasicMaterial color={0x16a34a} linewidth={2} depthTest={false} transparent opacity={0.9} />
            </lineSegments>
          </React.Fragment>
        );
      })}
    </>
  );
};

export const FaceRaycastOverlay: React.FC<FaceRaycastOverlayProps> = ({ shape, allShapes = [] }) => {
  const { raycastMode, addVirtualFace, virtualFaces } = useAppStore();
  const [faces, setFaces] = useState<FaceData[]>([]);
  const [faceGroups, setFaceGroups] = useState<CoplanarFaceGroup[]>([]);
  const [hoveredGroupIndex, setHoveredGroupIndex] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingPreview | null>(null);
  const shapeVirtualFaces = useMemo(() => virtualFaces.filter(vf => vf.shapeId === shape.id), [virtualFaces, shape.id]);
  const geometryUuid = shape.geometry?.uuid || '';
  const localToWorld = useMemo(() => getShapeMatrix(shape), [shape.position[0], shape.position[1], shape.position[2], shape.rotation[0], shape.rotation[1], shape.rotation[2], shape.scale[0], shape.scale[1], shape.scale[2]]);
  const worldToLocal = useMemo(() => localToWorld.clone().invert(), [localToWorld]);
  useEffect(() => {
    if (!shape.geometry) return;
    setFaces(extractFacesFromGeometry(shape.geometry));
    setFaceGroups(groupCoplanarFaces(extractFacesFromGeometry(shape.geometry)));
    setPending(null);
  }, [shape.geometry, shape.id, geometryUuid]);
  useEffect(() => { if (!raycastMode) { setHoveredGroupIndex(null); setPending(null); } }, [raycastMode]);
  const childPanels = useMemo(() => allShapes.filter(s => s.type === 'panel' && s.parameters?.parentShapeId === shape.id), [allShapes, shape.id]);
  const hoveredGroupHasPanel = useMemo(() => {
    if (hoveredGroupIndex === null || !faceGroups[hoveredGroupIndex]) return false;
    if (childPanels.some(p => p.parameters?.faceIndex === hoveredGroupIndex)) return true;
    const groupNormal = faceGroups[hoveredGroupIndex].normal.clone().normalize();
    const groupCenter = faceGroups[hoveredGroupIndex].center;
    return shapeVirtualFaces.some(vf => {
      if (!vf.hasPanel) return false;
      const vfNormal = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
      if (Math.abs(groupNormal.dot(vfNormal)) < 0.9) return false;
      return new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]).distanceTo(groupCenter) < 50;
    });
  }, [hoveredGroupIndex, faceGroups, shapeVirtualFaces, childPanels]);
  const hoverHighlightGeometry = useMemo(() => {
    if (hoveredGroupIndex === null || !faceGroups[hoveredGroupIndex] || hoveredGroupHasPanel) return null;
    return createFaceHighlightGeometry(faces, faceGroups[hoveredGroupIndex].faceIndices);
  }, [hoveredGroupIndex, faceGroups, faces, hoveredGroupHasPanel]);
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
      e.stopPropagation(); e.nativeEvent?.preventDefault?.();
      if (pending) { addVirtualFace(pending.virtualFace); setPending(null); }
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    if (hoveredGroupIndex === null || !faceGroups[hoveredGroupIndex] || hoveredGroupHasPanel) return;
    setPending(buildPreview(e.point.clone(), faceGroups[hoveredGroupIndex], faces, localToWorld, worldToLocal, childPanels, shape.id, shape.subtractionGeometries || [], shape.geometry, shapeVirtualFaces));
  };
  const handleContextMenu = (e: any) => {
    e.stopPropagation(); e.nativeEvent?.preventDefault?.();
    if (pending) { addVirtualFace(pending.virtualFace); setPending(null); }
  };
  if (!raycastMode) return null;
  return (
    <>
      <mesh geometry={shape.geometry} visible={false} onPointerMove={handlePointerMove} onPointerOut={handlePointerOut} onPointerDown={handlePointerDown} onContextMenu={handleContextMenu} />
      {hoverHighlightGeometry && !pending && (
        <mesh geometry={hoverHighlightGeometry}>
          <meshBasicMaterial color={0xfbbf24} transparent opacity={0.35} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
        </mesh>
      )}
      {pending && (
        <>
          <OriginDot position={pending.originLocal} />
          {pending.rayLines.map((line, i) => (
            <React.Fragment key={i}>
              <RayLine3D start={line.start} end={line.end} />
              <HitDot position={line.end} />
            </React.Fragment>
          ))}
          <mesh geometry={pending.geo}>
            <meshBasicMaterial color={0x22c55e} transparent opacity={0.5} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} depthTest={false} />
          </mesh>
          <lineSegments geometry={pending.edgeGeo}>
            <lineBasicMaterial color={0x16a34a} linewidth={2} depthTest={false} transparent opacity={0.9} />
          </lineSegments>
        </>
      )}
    </>
  );
};
