import * as THREE from 'three';
import type { Shape } from '../store';

// ═══════════════════════════════════════════════════════════════════════════
// PanelRotateService — İNCE ADAPTÖR.
// Görsel katmanın (PanelEditor) ve VF regen'in beklediği imzaları korur;
// dönüş artık BİRLEŞİK adım listesine yazılır ve PanelEngine yeniden üretir.
// Korunan kurallar:
//  • PANEL-YEREL EKSEN: kullanıcının dünya ekseni, panelin VF düzlem tabanına
//    (u/v/n) en yakın yerel eksene eşlenir → dönüş her yüzde "yerinde eğer".
//  • PİVOT ÇIPALARI: pivotVfFrac (VF'ye oransal, ASIL) + pivotFrac (parent
//    kutusuna oransal, yedek) + mutlak pivot (son çare). Rebuild pivotu her
//    seferinde güncel yüzeyden türetir — parametrik.
// ═══════════════════════════════════════════════════════════════════════════

/** Deterministik VF düzlem tabanı — yakalama ve rebuild aynı kuralı kullanır. */
export function vfPlaneBasis(normal: [number, number, number]): {
  n: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3;
} {
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(up, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { n, u, v };
}

export interface RotateStep {
  id: string;
  axis: 'x' | 'y' | 'z';
  axisVec?: [number, number, number];
  value: number;
  pivot: [number, number, number];
  pivotFrac?: [number, number, number];
  pivotVfFrac?: [number, number, number];
  timestamp: number;
}

export interface PanelRotateParams {
  panelShape: Shape;
  axis: 'x' | 'y' | 'z';
  value: number;
  pivot: [number, number, number];
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
}

/** Saf önizleme: adımları position/rotation üzerinde sırayla uygular. */
export function applyRotateSteps(
  basePosition: [number, number, number],
  baseRotation: [number, number, number],
  steps: RotateStep[]
): { position: [number, number, number]; rotation: [number, number, number] } {
  let pos = new THREE.Vector3(...basePosition);
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...baseRotation, 'XYZ'));
  for (const step of steps) {
    const pivot = new THREE.Vector3(...step.pivot);
    const angleRad = (step.value * Math.PI) / 180;
    const axisVec = step.axisVec
      ? new THREE.Vector3(...step.axisVec).normalize()
      : new THREE.Vector3(step.axis === 'x' ? 1 : 0, step.axis === 'y' ? 1 : 0, step.axis === 'z' ? 1 : 0);
    const stepQuat = new THREE.Quaternion().setFromAxisAngle(axisVec, angleRad);
    quat.premultiply(stepQuat);
    pos = pivot.clone().add(pos.sub(pivot).applyQuaternion(stepQuat));
  }
  const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  return { position: [pos.x, pos.y, pos.z], rotation: [e.x, e.y, e.z] };
}

export async function executePanelRotate(params: PanelRotateParams): Promise<boolean> {
  const { panelShape, axis, value, pivot, shapes, updateShape } = params;
  if (Math.abs(value) < 0.001) return false;

  const { useAppStore } = await import('../store');
  const state = useAppStore.getState();
  const fresh = state.shapes.find(s => s.id === panelShape.id) || panelShape;

  // PANEL-YEREL EKSEN EŞLEME + PİVOT ÇIPALARI (VF'den).
  let axisVec: [number, number, number] | undefined;
  let pivotVfFrac: [number, number, number] | undefined;
  let pivotFrac: [number, number, number] | undefined;

  const vf = state.virtualFaces?.find((f: any) => f.id === (fresh.parameters as any)?.virtualFaceId);
  if (vf?.normal) {
    const { n, u, v } = vfPlaneBasis(vf.normal as [number, number, number]);
    const wa = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const du = Math.abs(wa.dot(u)), dv = Math.abs(wa.dot(v)), dn = Math.abs(wa.dot(n));
    const chosen = dn >= du && dn >= dv ? n : du >= dv ? u : v;
    axisVec = [chosen.x, chosen.y, chosen.z];

    // pivotVfFrac: pivotun VF dikdörtgenindeki oranı + normal ofseti.
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, nOff = 0;
    for (const c of vf.vertices) {
      const w = new THREE.Vector3(c[0], c[1], c[2]);
      uMin = Math.min(uMin, w.dot(u)); uMax = Math.max(uMax, w.dot(u));
      vMin = Math.min(vMin, w.dot(v)); vMax = Math.max(vMax, w.dot(v));
      nOff = w.dot(n);
    }
    const pw = new THREE.Vector3(...pivot);
    const pu = pw.dot(u), pv = pw.dot(v), pn = pw.dot(n);
    const su = Math.max(uMax - uMin, 1e-6), sv = Math.max(vMax - vMin, 1e-6);
    pivotVfFrac = [
      Math.max(0, Math.min(1, (pu - uMin) / su)),
      Math.max(0, Math.min(1, (pv - vMin) / sv)),
      pn - nOff,
    ];
  }

  // pivotFrac: parent kutusuna oransal yedek çıpa.
  const parent = state.shapes.find(s => s.id === (fresh.parameters as any)?.parentShapeId);
  if (parent) {
    const w = parseFloat((parent.parameters as any)?.width) || 1;
    const h = parseFloat((parent.parameters as any)?.height) || 1;
    const d = parseFloat((parent.parameters as any)?.depth) || 1;
    const pp = parent.position as any;
    pivotFrac = [
      (pivot[0] - pp[0]) / w,
      (pivot[1] - pp[1]) / h,
      (pivot[2] - pp[2]) / d,
    ];
  }

  const { executeTransformStep } = await import('./PanelTransformService');
  return executeTransformStep(
    fresh,
    { type: 'rotate', axis, value, pivot, axisVec, pivotFrac, pivotVfFrac },
    shapes,
    updateShape
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// REFERANS İLE DÖNDÜRME (rotate-ref) — "face extrude gibi".
// Kullanıcı: pivot + eksen seçer (mevcut gizmo), Ref moduna geçer, başka bir
// şekilde referans yüzü tıklar. Onayda panel, seçtiği pivot/eksen çevresinde
// referans DÜZLEME İLK DEĞENE kadar döner. Extrude-ref MESAFE hesaplar; burada
// AÇI hesaplanır — eksen/pivot kullanıcıdan, değer (açı) referanstan.
//
// Matematik: dönüş dünya ekseni a (pivot P'den geçer), referans düzlem (nR·x=d).
// Her köşe V için w=V−P; w_par=(w·a)a, w_perp=w−w_par. θ dönüşü sonrası
//   nR·Rot(w) = nR·w_par + cosθ·(nR·w_perp) + sinθ·(nR·(a×w_perp))
// Düzleme değme: nR·Rot(w)+nR·P = d  →  A cosθ + B sinθ = C
//   A=nR·w_perp, B=nR·(a×w_perp), C=d−nR·P−nR·w_par.
// Çözüm: R=hypot(A,B); |C|≤R ise θ=atan2(B,A)±acos(C/R). Tüm köşelerin tüm
// çözümleri arasından EN KÜÇÜK |θ| = ilk temas (panel yüzeye ilk değdiği an).
// ═══════════════════════════════════════════════════════════════════════════

function uniqueWorldVertices(panelShape: Shape): THREE.Vector3[] {
  if (!panelShape.geometry) return [];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [];
  const seen = new Set<string>();
  const out: THREE.Vector3[] = [];
  const [ox, oy, oz] = panelShape.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // Panel-yerel geometri + position (rotation=0, scale=1 baked) → dünya köşesi.
    out.push(new THREE.Vector3(x + ox, y + oy, z + oz));
  }
  return out;
}

// Nokta bulutunun BASKIN ekseni (uzunluk yönü) — kovaryans matrisine güç
// iterasyonu. Panel bir kutu olduğundan en büyük özvektör = uzun kenar yönü.
// (Çentikli/L geometri olsa da baskın yön uzunluğu verir.)
function principalAxis(verts: THREE.Vector3[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const v of verts) c.add(v);
  c.divideScalar(verts.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const v of verts) {
    const dx = v.x - c.x, dy = v.y - c.y, dz = v.z - c.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  let e = new THREE.Vector3(1, 0.37, 0.11).normalize(); // eksen-hizalı dejenerasyonu kır
  for (let i = 0; i < 48; i++) {
    const x = xx * e.x + xy * e.y + xz * e.z;
    const y = xy * e.x + yy * e.y + yz * e.z;
    const z = xz * e.x + yz * e.y + zz * e.z;
    const nv = new THREE.Vector3(x, y, z);
    if (nv.lengthSq() < 1e-20) break;
    nv.normalize();
    if (nv.dot(e) < 0) nv.negate();
    if (nv.distanceToSquared(e) < 1e-18) { e = nv; break; }
    e = nv;
  }
  return e;
}

// Uzunluk yönüne (+Lu) en çok bakan yüz grubunun index'i — executeFaceExtrude
// ile AYNI gruplama (GeometryUtils) kullanılır ki index birebir eşleşsin.
// Not: panel rotation=[0,0,0] olduğundan geometri-yerel normal = dünya normali.
async function farEndFaceGroupIndex(panelShape: Shape, Lu: THREE.Vector3): Promise<number> {
  if (!panelShape.geometry) return -1;
  const { extractFacesFromGeometry, groupCoplanarFaces } = await import('./GeometryUtils');
  const groups = groupCoplanarFaces(extractFacesFromGeometry(panelShape.geometry));
  let idx = -1, best = -Infinity;
  for (let i = 0; i < groups.length; i++) {
    const d = groups[i].normal.clone().normalize().dot(Lu);
    if (d > best) { best = d; idx = i; }
  }
  return idx;
}

export interface RotateToReferenceParams {
  panelShape: Shape;
  axis: 'x' | 'y' | 'z';
  pivot: [number, number, number];                 // dünya, kullanıcı seçimli
  referencePointWorld: [number, number, number];    // dünya
  referenceNormalWorld: [number, number, number];    // dünya
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
}

export async function executeRotateToReference(params: RotateToReferenceParams): Promise<boolean> {
  const { panelShape, axis, pivot, referencePointWorld, shapes, updateShape } = params;

  const { useAppStore } = await import('../store');
  const state = useAppStore.getState();
  const fresh = state.shapes.find(s => s.id === panelShape.id) || panelShape;

  // 1) Dönüş DÜNYA ekseni — motorun (composeSteps) kullanacağıyla AYNI kural:
  //    eksen harfi → VF tabanının (u/v/n) en yakınına eşlenir → birleşik
  //    çerçeveyle (önceki adımların dönüşü) döndürülür.
  const vf = state.virtualFaces?.find((f: any) => f.id === (fresh.parameters as any)?.virtualFaceId);
  if (!vf?.normal) { console.warn('[YAGO][ROT-REF] VF bulunamadı, iptal.'); return false; }
  const { n, u, v } = vfPlaneBasis(vf.normal as [number, number, number]);
  const wa = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  const du = Math.abs(wa.dot(u)), dv = Math.abs(wa.dot(v)), dn = Math.abs(wa.dot(n));
  const axisLocal = dn >= du && dn >= dv ? n : du >= dv ? u : v;

  const { getUnifiedSteps, composeSteps } = await import('./PanelEngine');
  const steps = getUnifiedSteps(fresh);
  const frame = composeSteps(steps, vf as any).quat;
  const a = axisLocal.clone().applyQuaternion(frame).normalize();

  // 2) Panelin GÜNCEL dünya köşeleri + uzunluk ekseni (pivottan UZAK yöne).
  const verts = uniqueWorldVertices(fresh);
  if (verts.length < 2) { console.warn('[YAGO][ROT-REF] köşe yok, iptal.'); return false; }

  const P = new THREE.Vector3(...pivot);
  const R = new THREE.Vector3(...referencePointWorld);

  let Lu = principalAxis(verts);                 // uzunluk ekseni (birim)
  const centroid = new THREE.Vector3();
  for (const v of verts) centroid.add(v);
  centroid.divideScalar(verts.length);
  if (centroid.clone().sub(P).dot(Lu) < 0) Lu.negate(); // +Lu = pivottan uzak (uç) yön

  // 3) NİŞAN: uzunluk eksenini, seçilen dönüş ekseni etrafında pivot→R yönüne
  //    hizala. Dönüş yalnız a'ya dik düzlemde olabildiğinden her iki vektör de
  //    o düzleme izdüşürülür (önden bakışta a=Z → izdüşüm zaten aynısı).
  const projPerp = (w: THREE.Vector3) => w.clone().sub(a.clone().multiplyScalar(w.dot(a)));
  const RmP = R.clone().sub(P);
  const aim = projPerp(RmP);
  if (aim.lengthSq() < 1e-9) { console.warn('[YAGO][ROT-REF] referans, dönüş ekseni üzerinde; nişan alınamıyor.'); return false; }
  aim.normalize();
  const Lp = projPerp(Lu);
  if (Lp.lengthSq() < 1e-9) { console.warn('[YAGO][ROT-REF] uzunluk ekseni dönüş eksenine paralel; bu eksende dönemez.'); return false; }
  Lp.normalize();

  const cross = new THREE.Vector3().crossVectors(Lp, aim);
  const theta = Math.atan2(a.dot(cross), Lp.dot(aim)); // işaretli açı (a etrafında)
  const deg = (theta * 180) / Math.PI;

  // 4) UZAMA: pivot→R mesafesine ulaşacak yeni uzunluk. Uç yüz, referans
  //    izdüşümündeki hedef-ulaşıma kadar uzatılır (near/pivot ucu sabit kalır).
  let minPrj = Infinity, maxPrj = -Infinity;
  for (const v of verts) { const p = v.dot(Lu); if (p < minPrj) minPrj = p; if (p > maxPrj) maxPrj = p; }
  const pivotPrj = P.dot(Lu);
  const currentReach = maxPrj - pivotPrj;    // pivot → uç (uzunluk boyunca)
  const currentDim = maxPrj - minPrj;        // panel uzunluğu
  const targetReach = RmP.dot(aim);          // pivot → R (nişan yönünde bileşen)
  const newDim = currentDim + (targetReach - currentReach);
  const grow = targetReach - currentReach;

  console.log('[YAGO][ROT-REF] açı=', deg.toFixed(2), '° | uzunluk:', currentDim.toFixed(1), '→', newDim.toFixed(1),
    '| hedefUlaşım=', targetReach.toFixed(1), 'mevcut=', currentReach.toFixed(1),
    '| Lu=', [Lu.x, Lu.y, Lu.z].map(x => x.toFixed(2)).join(','));

  // 4a) Önce UZAT (uç yüz) — extrude adımı boru hattında rotate'ten ÖNCE gelir,
  //     yani base panel uzar, sonra rotate onu eğer → uç tam R'ye ulaşır.
  if (Math.abs(grow) > 0.5 && newDim > 1) {
    const fgi = await farEndFaceGroupIndex(fresh, Lu);
    if (fgi >= 0) {
      const { executeFaceExtrude } = await import('./FaceExtrudeService');
      await executeFaceExtrude({
        panelShape: fresh, faceGroupIndex: fgi, value: newDim, isFixed: true, mode: 'fixed',
        shapes: [], updateShape,
      });
    } else {
      console.warn('[YAGO][ROT-REF] uç yüz bulunamadı; yalnız döndürülüyor (uzatma atlandı).');
    }
  }

  // 4b) Sonra DÖNDÜR — uzamış paneli (güncel store'dan) al, nişan açısını uygula.
  const st2 = useAppStore.getState();
  const fresh2 = st2.shapes.find(s => s.id === panelShape.id) || fresh;
  return executePanelRotate({ panelShape: fresh2, axis, value: deg, pivot, shapes: st2.shapes, updateShape });
}

export async function updateRotateStep(
  panelShape: Shape,
  stepId: string,
  newValue: number,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const { updateTransformStep } = await import('./PanelTransformService');
  return updateTransformStep(panelShape, stepId, newValue, shapes, updateShape);
}

export async function deleteRotateStep(
  panelShape: Shape,
  stepId: string,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const { deleteTransformStep } = await import('./PanelTransformService');
  return deleteTransformStep(panelShape, stepId, shapes, updateShape);
}

/** Görsel yardımcılar (gizmo/step listesi) — davranış korunuyor. */
export function getPanelVertices(panelShape: Shape): [number, number, number][] {
  if (!panelShape.geometry) return [];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [];
  const out: [number, number, number][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([x + panelShape.position[0], y + panelShape.position[1], z + panelShape.position[2]]);
  }
  return out;
}

export function getPanelCenter(panelShape: Shape): [number, number, number] {
  const verts = getPanelVertices(panelShape);
  if (verts.length === 0) return [...panelShape.position] as [number, number, number];
  const c: [number, number, number] = [0, 0, 0];
  for (const v of verts) { c[0] += v[0]; c[1] += v[1]; c[2] += v[2]; }
  return [c[0] / verts.length, c[1] / verts.length, c[2] / verts.length];
}
