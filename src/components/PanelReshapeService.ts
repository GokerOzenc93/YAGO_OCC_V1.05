import * as THREE from 'three';
import type { VirtualFace, Shape } from '../store';
import {
  getFacePlaneAxes,
  getShapeMatrix,
  projectTo2D,
  ensureCCW,
  type Point2D,
} from './FaceRaycastOverlay';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';

type EdgeKey = string;
const keyOf = (p: THREE.Vector3) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;

function extractBoundaryLoopLocal(
  faces: ReturnType<typeof extractFacesFromGeometry>,
  faceIndices: number[]
): THREE.Vector3[] | null {
  type Edge = { a: THREE.Vector3; b: THREE.Vector3; ak: string; bk: string };
  const map = new Map<EdgeKey, { e: Edge; count: number }>();
  for (const fi of faceIndices) {
    const f = faces[fi];
    if (!f) continue;
    for (let i = 0; i < 3; i++) {
      const a = f.vertices[i], b = f.vertices[(i + 1) % 3];
      const ak = keyOf(a), bk = keyOf(b);
      const k = ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
      if (!map.has(k)) map.set(k, { e: { a: a.clone(), b: b.clone(), ak, bk }, count: 0 });
      map.get(k)!.count++;
    }
  }
  const boundary: Edge[] = [];
  map.forEach(v => { if (v.count === 1) boundary.push(v.e); });
  if (boundary.length < 3) return null;

  const adj = new Map<string, { other: string; point: THREE.Vector3 }[]>();
  for (const e of boundary) {
    if (!adj.has(e.ak)) adj.set(e.ak, []);
    if (!adj.has(e.bk)) adj.set(e.bk, []);
    adj.get(e.ak)!.push({ other: e.bk, point: e.b });
    adj.get(e.bk)!.push({ other: e.ak, point: e.a });
  }

  const startKey = boundary[0].ak;
  const startPt = boundary[0].a;
  const loop: THREE.Vector3[] = [startPt];
  const visited = new Set<string>();
  let currentKey = startKey;
  let prevKey = '';
  while (true) {
    visited.add(currentKey);
    const neighbors = adj.get(currentKey) || [];
    const next = neighbors.find(n => n.other !== prevKey && !visited.has(n.other));
    if (!next) {
      const closing = neighbors.find(n => n.other === startKey && n.other !== prevKey);
      if (closing) break;
      break;
    }
    loop.push(next.point);
    prevKey = currentKey;
    currentKey = next.other;
    if (currentKey === startKey) break;
    if (loop.length > boundary.length + 2) break;
  }
  if (loop.length < 3) return null;
  return loop;
}

function findMatchingGroup(
  vf: VirtualFace,
  faces: ReturnType<typeof extractFacesFromGeometry>,
  groups: ReturnType<typeof groupCoplanarFaces>
) {
  const vfN = new THREE.Vector3(...vf.normal).normalize();
  const vfC = new THREE.Vector3(...vf.center);
  const candidates = groups.filter(g => g.normal.clone().normalize().dot(vfN) > 0.95);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  let best = candidates[0], bestDist = Infinity;
  for (const g of candidates) {
    const bbox = new THREE.Box3();
    g.faceIndices.forEach(fi => { const f = faces[fi]; if (f) f.vertices.forEach(v => bbox.expandByPoint(v)); });
    const expanded = bbox.clone().expandByScalar(5);
    if (expanded.containsPoint(vfC)) {
      const d = vfC.distanceTo(g.center);
      if (d < bestDist) { best = g; bestDist = d; }
    }
  }
  return best;
}

function polygonIntersect(a: Point2D[], b: Point2D[]): Point2D[] {
  let output = [...a];
  for (let i = 0; i < b.length && output.length > 0; i++) {
    const input = [...output];
    output = [];
    const eS = b[i], eE = b[(i + 1) % b.length];
    for (let j = 0; j < input.length; j++) {
      const curr = input[j], prev = input[(j + input.length - 1) % input.length];
      const currIn = (eE.x - eS.x) * (curr.y - eS.y) - (eE.y - eS.y) * (curr.x - eS.x) >= -1e-6;
      const prevIn = (eE.x - eS.x) * (prev.y - eS.y) - (eE.y - eS.y) * (prev.x - eS.x) >= -1e-6;
      if (currIn) {
        if (!prevIn) {
          const inter = segInter(prev, curr, eS, eE);
          if (inter) output.push(inter);
        }
        output.push(curr);
      } else if (prevIn) {
        const inter = segInter(prev, curr, eS, eE);
        if (inter) output.push(inter);
      }
    }
  }
  return output;
}

function segInter(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): Point2D | null {
  const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
  const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

export async function reshapePanelToParentFace(panelId: string): Promise<void> {
  const { useAppStore } = await import('../store');
  const state = useAppStore.getState();
  const panel = state.shapes.find(s => s.id === panelId);
  if (!panel || panel.type !== 'panel') return;
  const parentId = panel.parameters?.parentShapeId;
  const vfId = panel.parameters?.virtualFaceId;
  if (!parentId || !vfId) return;
  const parent = state.shapes.find(s => s.id === parentId);
  const vf = state.virtualFaces.find(f => f.id === vfId);
  if (!parent?.geometry || !vf) return;

  const faces = extractFacesFromGeometry(parent.geometry);
  const groups = groupCoplanarFaces(faces);
  const group = findMatchingGroup(vf, faces, groups);
  if (!group) return;

  const boundaryLocal = extractBoundaryLoopLocal(faces, group.faceIndices);
  if (!boundaryLocal || boundaryLocal.length < 3) return;

  const localToWorld = getShapeMatrix(parent);
  const worldToLocal = localToWorld.clone().invert();

  const localNormal = group.normal.clone().normalize();
  const normalMat = new THREE.Matrix3().getNormalMatrix(localToWorld);
  const worldNormal = localNormal.clone().applyMatrix3(normalMat).normalize();
  const { u, v } = getFacePlaneAxes(worldNormal);

  const boundaryWorld = boundaryLocal.map(p => p.clone().applyMatrix4(localToWorld));
  const origin = boundaryWorld[0].clone();
  const boundary2D = ensureCCW(boundaryWorld.map(p => projectTo2D(p, origin, u, v)));

  const vfWorld = vf.vertices.map(vt =>
    new THREE.Vector3(vt[0], vt[1], vt[2]).applyMatrix4(localToWorld)
  );
  const vf2D = ensureCCW(vfWorld.map(p => projectTo2D(p, origin, u, v)));

  let clipped = polygonIntersect(boundary2D, vf2D);
  if (clipped.length < 3) clipped = boundary2D;

  const newVerticesWorld = clipped.map(p =>
    origin.clone().addScaledVector(u, p.x).addScaledVector(v, p.y)
  );
  const newVerticesLocal = newVerticesWorld.map(p => p.clone().applyMatrix4(worldToLocal));
  const center = new THREE.Vector3();
  newVerticesLocal.forEach(p => center.add(p));
  center.divideScalar(newVerticesLocal.length);

  useAppStore.setState(s => ({
    virtualFaces: s.virtualFaces.map(f =>
      f.id === vfId
        ? {
            ...f,
            vertices: newVerticesLocal.map(p => [p.x, p.y, p.z] as [number, number, number]),
            center: [center.x, center.y, center.z],
            raycastRecipe: undefined,
          }
        : f
    ),
  }));

  const { rebuildPanelsForParent } = await import('./PanelRebuildService');
  await rebuildPanelsForParent(parentId);
}
