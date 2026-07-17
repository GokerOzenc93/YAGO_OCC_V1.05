import * as THREE from 'three';
import type { VirtualFace } from '../store';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';
import { createFaceDescriptor } from './GeometryUtils';

// ─────────────────────────────────────────────────────────────────────────────
// "ANA YÜZE EŞİTLE" servisi
//
// Yaklaşım: VF poligonu, yüz grubunun u/v düzlemindeki BOUNDING RECT'ine
// (4 köşe + küçük pay) set edilir. Gerçek yüz şekli (girintiler, delikler,
// karmaşık konturlar) PanelRebuildService'teki parent solid ile OCC
// intersection tarafından kusursuz kesilir. Böylece eski boundary-loop
// takibi (delikli yüzde yanlış loop seçimi, konkav köşede erken kapanma,
// kısmi loop kabulü) tamamen devre dışı kalır — ışınların "aralara
// girememesi" sorunu bu yolla kökten çözülür.
//
// Geri alma: Eşitleme AÇILMADAN önce vf.vertices/center 'preAlign*'
// alanlarına snapshot'lanır; kapatınca birebir geri yüklenir.
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Yüz grubunun VF düzlemi (u/v) üzerindeki bounding-rect köşelerini üretir.
 * Düzleme yakın olmayan (eğik komşu üçgen) vertexler filtrelenir.
 * MARGIN kadar dışa taşırılır — fazlalık OCC intersection ile kesilir.
 */
export function computeFaceBoundingRectLocal(
  faces: ReturnType<typeof extractFacesFromGeometry>,
  faceIndices: number[],
  n: THREE.Vector3,
  origin: THREE.Vector3,
  margin = 0.5
): THREE.Vector3[] | null {
  const up = Math.abs(n.y) > Math.abs(n.x) && Math.abs(n.y) > Math.abs(n.z)
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  const uAxis = new THREE.Vector3().crossVectors(n, up).normalize();
  const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();

  const PLANE_TOL = 0.5; // mm — düzlem dışı vertexleri ele
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  let found = false;

  for (const fi of faceIndices) {
    const f = faces[fi];
    if (!f) continue;
    for (const p of f.vertices) {
      const d = new THREE.Vector3().subVectors(p, origin);
      if (Math.abs(d.dot(n)) > PLANE_TOL) continue;
      const pu = d.dot(uAxis), pv = d.dot(vAxis);
      if (pu < uMin) uMin = pu;
      if (pu > uMax) uMax = pu;
      if (pv < vMin) vMin = pv;
      if (pv > vMax) vMax = pv;
      found = true;
    }
  }
  if (!found || uMax - uMin < 0.1 || vMax - vMin < 0.1) return null;

  uMin -= margin; uMax += margin; vMin -= margin; vMax += margin;

  const at = (pu: number, pv: number) =>
    origin.clone().addScaledVector(uAxis, pu).addScaledVector(vAxis, pv);

  // CCW sıralı 4 köşe (replicad sketch için tutarlı yön)
  return [at(uMin, vMin), at(uMax, vMin), at(uMax, vMax), at(uMin, vMax)];
}

/** "Ana yüze eşitle" AÇ: paneli parent yüzün tam şekline büyütür. */
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

  const n = new THREE.Vector3(...vf.normal).normalize();
  // Origin: yüz grubunun merkezini VF düzlemine izdüşür (düzlem sapmasını sıfırla)
  const vfCenter = new THREE.Vector3(...vf.center);
  const gC = group.center.clone();
  const origin = gC.sub(n.clone().multiplyScalar(new THREE.Vector3().subVectors(gC, vfCenter).dot(n)));

  const rect = computeFaceBoundingRectLocal(faces, group.faceIndices, n, origin);
  if (!rect) return;

  const center = new THREE.Vector3();
  rect.forEach(p => center.add(p));
  center.divideScalar(rect.length);

  useAppStore.setState(s => ({
    virtualFaces: s.virtualFaces.map(f =>
      f.id === vfId
        ? {
            ...f,
            // Snapshot yalnızca ilk açılışta alınır (toggle spam'inde ezilmesin)
            preAlignVertices: f.preAlignVertices ?? f.vertices.map(v => [...v] as [number, number, number]),
            preAlignCenter: f.preAlignCenter ?? ([...f.center] as [number, number, number]),
            vertices: rect.map(p => [p.x, p.y, p.z] as [number, number, number]),
            center: [center.x, center.y, center.z],
            parentFaceShape: true,
            alignToParentFace: true,
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

/** "Ana yüze eşitle" KAPAT: paneli eşitleme öncesi haline birebir döndürür. */
export async function restorePanelFromParentFace(panelId: string): Promise<void> {
  const { useAppStore } = await import('../store');
  const state = useAppStore.getState();
  const panel = state.shapes.find(s => s.id === panelId);
  if (!panel || panel.type !== 'panel') return;
  const parentId = panel.parameters?.parentShapeId;
  const vfId = panel.parameters?.virtualFaceId;
  if (!parentId || !vfId) return;

  useAppStore.setState(s => ({
    virtualFaces: s.virtualFaces.map(f => {
      if (f.id !== vfId) return f;
      const restored: any = {
        ...f,
        parentFaceShape: false,
        alignToParentFace: false,
      };
      // Snapshot varsa vertices/center birebir geri yüklenir; snapshot'ı temizle
      if (f.preAlignVertices && f.preAlignVertices.length >= 3) {
        restored.vertices = f.preAlignVertices.map(v => [...v] as [number, number, number]);
        restored.center = f.preAlignCenter
          ? ([...f.preAlignCenter] as [number, number, number])
          : f.center;
      }
      delete restored.preAlignVertices;
      delete restored.preAlignCenter;
      return restored;
    }),
  }));

  const { rebuildPanelsForParent } = await import('./PanelRebuildService');
  await rebuildPanelsForParent(parentId);
}
