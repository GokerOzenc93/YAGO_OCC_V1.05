import * as THREE from 'three';
import type { VirtualFace } from '../store';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';
import { createFaceDescriptor } from './GeometryUtils';

type P2 = { x: number; y: number };

const keyOf = (p: THREE.Vector3) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;

function extractBoundaryLoopLocal(
  faces: ReturnType<typeof extractFacesFromGeometry>,
  faceIndices: number[]
): THREE.Vector3[] | null {
  type Edge = { a: THREE.Vector3; b: THREE.Vector3; ak: string; bk: string };
  const map = new Map<string, { e: Edge; count: number }>();
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
  const loop: THREE.Vector3[] = [boundary[0].a];
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
    if (loop.length > boundary.length + 2) break;
  }
  return loop.length >= 3 ? loop : null;
}

function findMatchingGroup(
  vf: VirtualFace,
  faces: ReturnType<typeof extractFacesFromGeometry>,
  groups: ReturnType<typeof groupCoplanarFaces>
) {
  const vfN = new THREE.Vector3(...vf.normal).normalize();
  const vfC = new THREE.Vector3(...vf.center);
  const cand = groups.filter(g => g.normal.clone().normalize().dot(vfN) > 0.95);
  if (cand.length === 0) return null;
  if (cand.length === 1) return cand[0];
  let best = cand[0], bestD = Infinity;
  for (const g of cand) {
    const d = vfC.distanceTo(g.center);
    if (d < bestD) { bestD = d; best = g; }
  }
  return best;
}

function signedArea(poly: P2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s * 0.5;
}

function forceWinding(poly: P2[], wantPositive: boolean): P2[] {
  const a = signedArea(poly);
  const pos = a > 0;
  return pos === wantPositive ? poly : [...poly].reverse();
}

function clipSH(subject: P2[], clip: P2[]): P2[] {
  let output = [...subject];
  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const input = [...output]; output = [];
    const eS = clip[i], eE = clip[(i + 1) % clip.length];
    const side = (p: P2) => (eE.x - eS.x) * (p.y - eS.y) - (eE.y - eS.y) * (p.x - eS.x);
    for (let j = 0; j < input.length; j++) {
      const curr = input[j], prev = input[(j + input.length - 1) % input.length];
      const cIn = side(curr) >= -1e-6;
      const pIn = side(prev) >= -1e-6;
      if (cIn) {
        if (!pIn) {
          const it = segInter(prev, curr, eS, eE); if (it) output.push(it);
        }
        output.push(curr);
      } else if (pIn) {
        const it = segInter(prev, curr, eS, eE); if (it) output.push(it);
      }
    }
  }
  return output;
}

function segInter(p1: P2, p2: P2, p3: P2, p4: P2): P2 | null {
  const denom = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / denom;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
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

  // Everything below runs in PARENT-LOCAL space and projects using the
  // SAME sketch basis that createPanelFromVirtualFace uses with vf.normal.
  const n = new THREE.Vector3(...vf.normal).normalize();
  const up = Math.abs(n.y) > Math.abs(n.x) && Math.abs(n.y) > Math.abs(n.z)
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  const uAxis = new THREE.Vector3().crossVectors(n, up).normalize();
  const vAxis = new THREE.Vector3().crossVectors(uAxis, n).normalize();

  const origin = new THREE.Vector3(...vf.center);
  const to2D = (p: THREE.Vector3): P2 => {
    const d = new THREE.Vector3().subVectors(p, origin);
    return { x: d.dot(uAxis), y: d.dot(vAxis) };
  };
  const to3D = (p: P2): THREE.Vector3 =>
    origin.clone().addScaledVector(uAxis, p.x).addScaledVector(vAxis, p.y);

  const vfOrig2D = vf.vertices.map(v => to2D(new THREE.Vector3(v[0], v[1], v[2])));
  const origWindingPositive = signedArea(vfOrig2D) > 0;

  const boundary2D = forceWinding(boundaryLocal.map(to2D), true);
  const vfClip2D = forceWinding(vfOrig2D, true);

  let clipped = clipSH(boundary2D, vfClip2D);
  if (clipped.length < 3) clipped = boundary2D;

  // Deduplicate close points.
  const EPS = 0.2;
  const dedup: P2[] = [];
  for (const p of clipped) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > EPS) dedup.push(p);
  }
  if (dedup.length >= 2) {
    const f = dedup[0], l = dedup[dedup.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) < EPS) dedup.pop();
  }
  if (dedup.length < 3) return;

  // Restore original winding of vf so replicad extrudes correctly.
  const finalOrdered = forceWinding(dedup, origWindingPositive);

  const newVerticesLocal = finalOrdered.map(to3D);
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
            parentFaceShape: true,
            faceGroupDescriptor: group.faceIndices[0] !== undefined && faces[group.faceIndices[0]]
              ? createFaceDescriptor(faces[group.faceIndices[0]], parent.geometry)
              : undefined,
          }
        : f
    ),
  }));

  const { rebuildPanelsForParent } = await import('./PanelRebuildService');
  await rebuildPanelsForParent(parentId);
}
