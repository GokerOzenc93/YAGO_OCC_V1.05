import * as THREE from 'three';
import { type CavityBox, type PanelGroup, type Shape, type VirtualFace, childPanelsOf, panelOfVf, shapeById, useAppStore, vfOfPanel } from '../store';
import { type ExtrudeStep, type TransformStep, applyExtrudeSteps, applyTransformSteps, getUnifiedSteps, matchReferenceFace, resolveReferenceFacePlane, stepRefTargets } from './PanelOps';
import { computeFaceComponentContour, computeFreeRegionLocal, convexHull2D, panelHasRotation, panelIsTiltedSlab } from './FaceRegion';
import {
  type CoplanarFaceGroup, type FaceData, type Vec3, angleToTouchPlane, axisDirToVec, axisIndexOf, boundsOverlapBox, convertReplicadToThreeGeometry,
  createPanelFromVirtualFace, createReplicadBox, effectiveBodyGeometry, errMsg, findFaceByDescriptor, fmtBounds, getFacePlaneAxes,
  getFacesAndGroups, getShapeMatrix, isFlatNormal, localBboxOf, normDeg, panelThickness, pointFromFracBox, projRange, resolveVfFracPoint,
  rotateAboutAxis, round1, uniqueMeshPoints, vertexModsKey, vfRawMinAlong, worldBboxOf,
} from './Geometry';
import { isInteriorPanel, isInteriorVf, recalculateInteriorVfs, syncPanelGroups } from './PanelGroupService';
import { isDoorPanel, isDoorVf, recalculateDoorVfs, syncDoorGroups } from './DoorService';
import { backGrooveCuttersFor, backNailStampFor, isBackPanel, isBackVf, recalculateBackVfs, syncBackGroups } from './BackService';

// Kapak ve arkalık panelleri (LEVHA): köşe birleşimine girmez, gövdeyle sığdırılmaz/kesilmez, hiçbir paneli kesmez; damgalamaz —
// istisna arkalığın iç parçası: ÇAKMA kenarındaki gövde panelini ve sırada kendinden SONRA gelen gövde panelini basar (BackService.backNailStampFor).
const isSheetPanel = (p: any): boolean => isDoorPanel(p) || isBackPanel(p);
const isSheetVf = (vf: any): boolean => isDoorVf(vf) || isBackVf(vf);

// PANEL MOTORU: (A) rebuildPanelsForParent — panelleri SPEC'ten (VF bağı + transform/extrude adımları) her rebuild'de
// sıfırdan üretir; (B) VF bölge yeniden hesabı. BASAN/BASILAN = store'daki virtualFaces sırası (önce gelen basar).
// Hat: VF çokgeni (+iç köşe uzaması) → adımlar → dönmüş/eğik: büyüt & sığdır → extrude → basan kesimi → ref-dönüş pahı.

type UpdateShape = (id: string, u: Partial<Shape>) => void;
type CreatePanelFn = (v: Vec3[], n: Vec3, t: number, e?: number) => Promise<any>;
type ToGeometryFn = (s: any) => THREE.BufferGeometry;
export type RefContact = 'arm' | 'rest';

const vfNormal = (vf: VirtualFace) => new THREE.Vector3(...(vf.normal as Vec3)).normalize();

function resolvePivot(step: any, vf: VirtualFace): THREE.Vector3 {
  if (step.pivotVfFrac && vf) return resolveVfFracPoint(step.pivotVfFrac as Vec3, vf);
  return new THREE.Vector3(...(step.pivot || [0, 0, 0]));
}

/** DYN taşıma, yüz açıklığı oranında ölçeklenir; FIXED asla ölçeklenmez (mm sabit). */
function resolveScaledMoveValue(step: any, vf: VirtualFace): number {
  const original = step.value as number;
  if (step.isFixed) return original;
  const span0 = step.anchor?.faceSpanAlongAxis;
  if (!span0 || span0 < 1 || !vf?.vertices || vf.vertices.length < 3) return original;
  const idx = axisIndexOf(step.axis);
  let min = Infinity, max = -Infinity;
  for (const v of vf.vertices) { if (v[idx] < min) min = v[idx]; if (v[idx] > max) max = v[idx]; }
  const currentSpan = Math.abs(max - min);
  if (currentSpan < 1) return original;
  const ratio = currentSpan / span0;
  if (Math.abs(ratio - 1) < 0.001) return original;
  const scaled = original * ratio;
  return scaled;
}

function resolveReferenceFacePolygon(
  targetId: string, faceGroupIndex: number, normalWorld?: Vec3, pointWorld?: Vec3
): { normal: THREE.Vector3; center: THREE.Vector3; vertices: THREE.Vector3[] } | null {
  const m = matchReferenceFace(shapeById(targetId), faceGroupIndex, normalWorld, pointWorld);
  if (!m) return null;
  const verts: THREE.Vector3[] = [];
  const seen = new Set<string>();
  for (const fi of m.group.faceIndices) {
    const f = m.faces[fi]; if (!f) continue;
    for (const v of f.vertices) {
      const w = v.clone().applyMatrix4(m.matrix);
      const k = `${Math.round(w.x * 10)},${Math.round(w.y * 10)},${Math.round(w.z * 10)}`;
      if (seen.has(k)) continue;
      seen.add(k); verts.push(w);
    }
  }
  return {
    normal: m.group.normal.clone().normalize().transformDirection(m.matrix).normalize(),
    center: m.group.center.clone().applyMatrix4(m.matrix),
    vertices: verts,
  };
}

function pointInFacePolygon(pt: THREE.Vector3, normal: THREE.Vector3, verts: THREE.Vector3[], tol = 0.5): boolean {
  const { u, v } = getFacePlaneAxes(normal);
  const hull = convexHull2D(verts.map(q => ({ x: q.dot(u), y: q.dot(v) })));
  if (hull.length < 3) return false;
  const p = { x: pt.dot(u), y: pt.dot(v) };
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const d = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / (Math.hypot(b.x - a.x, b.y - a.y) || 1);
    if (Math.abs(d) <= tol) continue;
    const sg = d > 0 ? 1 : -1;
    if (sign === 0) sign = sg; else if (sg !== sign) return false;
  }
  return true;
}

// YÜZE OTURMA: dönen panel yüzeyinin ref çokgen köşesine değdiği açı; PİVOTA EN YAKIN köşe (eşitlikte en küçük |θ|).
function angleToRestOnPolygon(
  pivot: THREE.Vector3, axis: THREE.Vector3, n1: THREE.Vector3, k: number, verts: THREE.Vector3[], sign: number
): { deg: number; vertex: THREE.Vector3 } | null {
  const u = axis.clone().normalize();
  const nPar = u.clone().multiplyScalar(u.dot(n1));
  const nPerp = n1.clone().sub(nPar);
  if (nPerp.length() < 1e-6) return null;
  const w = new THREE.Vector3().crossVectors(u, nPerp);
  let best: { deg: number; vertex: THREE.Vector3; dist: number } | null = null;
  for (const V of verts) {
    const r = V.clone().sub(pivot);
    const A = nPerp.dot(r), B = w.dot(r), c = k - nPar.dot(r);
    const R = Math.hypot(A, B);
    if (R < 1e-9 || Math.abs(c) > R) continue;
    const phi = Math.atan2(B, A), delta = Math.acos(Math.max(-1, Math.min(1, c / R)));
    let vBest: number | null = null;
    for (const rad of [phi - delta, phi + delta]) {
      const d = normDeg(rad);
      if (Math.abs(d) < 1e-6) continue;
      if (sign !== 0 && Math.sign(d) !== sign) continue;
      if (vBest === null || Math.abs(d) < Math.abs(vBest)) vBest = d;
    }
    if (vBest === null) continue;
    const dist = r.length();
    if (!best || dist < best.dist - 0.5 || (Math.abs(dist - best.dist) <= 0.5 && Math.abs(vBest) < Math.abs(best.deg))) {
      best = { deg: vBest, vertex: V, dist };
    }
  }
  return best ? { deg: best.deg, vertex: best.vertex } : null;
}

const round3 = (d: number) => Math.round(d * 1000) / 1000;

// REF dönüş açısı: nişan ref yüz ÇOKGENİNE değiyorsa 'arm'; değilse büyük yüzey çokgen köşesine OTURUR ('rest'). Hata → donmuş açı.
function resolveRefRotateDeg(
  st: any, vf: VirtualFace, pivot: THREE.Vector3, axisWorld: THREE.Vector3, frame: THREE.Quaternion
): { deg: number; contact?: RefContact } {
  const frozen = typeof st.resolvedValue === 'number' ? st.resolvedValue : (st.value || 0);
  try {
    const armPoint = st.refArmVfFrac
      ? resolveVfFracPoint(st.refArmVfFrac as Vec3, vf)
      : (st.refArmVertex ? new THREE.Vector3(...(st.refArmVertex as Vec3)) : null);
    const target = shapeById(st.refTargetPanelId);
    if (!armPoint || !st.refTargetFaceNormal || !target) return { deg: frozen };
    {
      const plane = resolveReferenceFacePlane(st.refTargetPanelId, st.refTargetFaceGroupIndex ?? -1,
        useAppStore.getState().shapes, st.refTargetFaceNormal, st.refTargetFacePoint);
      if (!plane) {
        console.warn('[YAGO][REF-DÖN] referans yüz bulunamadı, donmuş açı kullanılıyor:', st.refTargetPanelId);
        return { deg: frozen };
      }
      const tp = target.position;
      const planePointWorld = plane.center.clone().add(new THREE.Vector3(tp[0], tp[1], tp[2]));
      const armWorld = armPoint.clone().sub(pivot).applyQuaternion(frame).add(pivot);
      const sol = angleToTouchPlane(pivot, armWorld, axisWorld, plane.normal, planePointWorld, frozen);
      if (!sol) return { deg: frozen };

      const poly = resolveReferenceFacePolygon(st.refTargetPanelId, st.refTargetFaceGroupIndex ?? -1, st.refTargetFaceNormal, st.refTargetFacePoint);
      const armAt = rotateAboutAxis(armWorld, pivot, axisWorld, sol.deg);
      const armInside = !!poly && sol.touched && pointInFacePolygon(armAt, poly.normal, poly.vertices, 0.5);
      if (armInside || !poly) {
        if (!sol.touched) console.warn('[YAGO][REF-DÖN] nişan noktası referans yüze ULAŞAMIYOR — en yakın yaklaşma açısı:', sol.deg.toFixed(2));
        return { deg: round3(sol.deg), contact: 'arm' };
      }

      // (b) Dış ya da iç (−kalınlık) yüzeyden (a) açısında ref normaline ZIT bakan seçilir; ofset pivotun VF konumuyla düzeltilir.
      const n0 = vfNormal(vf);
      const n1 = n0.clone().applyQuaternion(frame).normalize();
      const nOff = vf.vertices.length ? new THREE.Vector3(...vf.vertices[0]).dot(n0) : 0;
      const dP = n0.dot(pivot) - nOff;
      const thick = panelThickness(panelOfVf(vf.id));
      const mOuterAtA = rotateAboutAxis(n1.clone().add(pivot), pivot, axisWorld, sol.deg).sub(pivot).normalize();
      const useInner = mOuterAtA.dot(poly.normal) > 0;
      const k = (useInner ? -thick : 0) - dP;
      const sign = Math.sign(sol.deg) || (frozen ? Math.sign(frozen) : 0);
      const rest = angleToRestOnPolygon(pivot, axisWorld, n1, k, poly.vertices, sign);
      if (!rest) {
        console.warn('[YAGO][REF-DÖN] yüze oturma çözülemedi, düzlem açısı kullanılıyor:', sol.deg.toFixed(2));
        return { deg: round3(sol.deg) };
      }
      return { deg: round3(rest.deg), contact: 'rest' };
    }
  } catch (err) {
    console.warn('[YAGO][REF-DÖN] açı çözümü hatası, donmuş açı:', errMsg(err));
    return { deg: frozen };
  }
}

export type StepOp =
  | { kind: 'translate'; d: THREE.Vector3 }
  | { kind: 'refTranslate'; targetPanelId: string; sourceFrac?: Vec3; targetFrac?: Vec3; fallback: THREE.Vector3 }
  | { kind: 'rotate'; deg: number; pivot: THREE.Vector3; axis: THREE.Vector3 };

// move o ANKİ dönüş çerçevesinde ilerler; REF taşıma katı mevcutken çözülsün diye 'refTranslate' döner.
export function composeSteps(steps: TransformStep[], vf: VirtualFace): {
  quat: THREE.Quaternion;
  ops: StepOp[];
  resolvedRotations: Array<{ id: string; value: number; contact?: RefContact; targetId?: string }>;
} {
  const ops: StepOp[] = [];
  const resolvedRotations: Array<{ id: string; value: number; contact?: RefContact; targetId?: string }> = [];
  const frame = new THREE.Quaternion();
  for (const s of steps) {
    const st: any = s;
    if (s.type === 'move') {
      const hasFrozen = !!(st._refAxisVec && st._refDist);
      const frozenD = () => new THREE.Vector3(st._refAxisVec[0], st._refAxisVec[1], st._refAxisVec[2]).multiplyScalar(st._refDist);
      if (st.refTargetPanelId && (st.refSourceFrac || st.refTargetFrac || hasFrozen)) {
        ops.push({ kind: 'refTranslate', targetPanelId: st.refTargetPanelId, sourceFrac: st.refSourceFrac, targetFrac: st.refTargetFrac,
          fallback: hasFrozen ? frozenD() : new THREE.Vector3(0, 0, 0) });
      } else if (hasFrozen) {
        ops.push({ kind: 'translate', d: frozenD() });
      } else {
        const base = axisDirToVec(st.axis);
        const value = resolveScaledMoveValue(st, vf);
        const d = base.clone().applyQuaternion(frame).multiplyScalar(value);
        // FIXED MUTLAK KONUM: yalnız dönüşsüz çerçevede yüz kayması telafi edilir.
        if (st.isFixed && typeof st.fixedRef === 'number' && Math.abs(frame.w) > 0.999999) {
          const cur = vfRawMinAlong(vf, st.axis);
          if (cur !== null) {
            const shift = st.fixedRef - cur;
            if (Math.abs(shift) > 0.01) {
              d.addScaledVector(new THREE.Vector3(Math.abs(base.x), Math.abs(base.y), Math.abs(base.z)), shift);
            }
          }
        }
        ops.push({ kind: 'translate', d });
      }
    } else if (s.type === 'rotate') {
      const axis = st.axisVec ? new THREE.Vector3(...st.axisVec).normalize() : axisDirToVec(st.axis + '+');
      const worldAxis = axis.clone().applyQuaternion(frame).normalize();
      const pivot = resolvePivot(st, vf);
      let deg = st.value;
      if (st.refTargetPanelId) {
        const r = resolveRefRotateDeg(st, vf, pivot, worldAxis, frame);
        deg = r.deg;
        resolvedRotations.push({ id: st.id, value: deg, contact: r.contact, targetId: st.refTargetPanelId });
      }
      ops.push({ kind: 'rotate', deg, pivot, axis: worldAxis });
      frame.premultiply(new THREE.Quaternion().setFromAxisAngle(worldAxis, (deg * Math.PI) / 180));
    }
  }
  return { quat: frame, ops, resolvedRotations };
}

export function resolveRefTranslateDelta(op: any, rpWorldBox: THREE.Box3): THREE.Vector3 {
  if (!op.sourceFrac || !op.targetFrac) return op.fallback.clone();
  const target = shapeById(op.targetPanelId);
  const tgtBox = target?.geometry ? worldBboxOf(target, effectiveBodyGeometry(target)) : null;
  if (!tgtBox) {
    console.warn('[YAGO][REF-BAĞ] hedef geometri yok, donmuş delta kullanılıyor:', op.targetPanelId);
    return op.fallback.clone();
  }
  const targetWorld = pointFromFracBox(tgtBox, op.targetFrac);
  const d = targetWorld.clone().sub(pointFromFracBox(rpWorldBox, op.sourceFrac));
  return d;
}

// İÇ KÖŞE: dik iki adımsız panelin köşesindeki t1×t2 boşluğu, SIRADA ÖNCE olan sonrakinin kalınlığı kadar uzayıp kapatır.
const CORNER_TOL = 1.0;

function hasAnySteps(p: Shape): boolean {
  const q: any = p.parameters || {};
  return (Array.isArray(q.transformSteps) && q.transformSteps.length > 0) || (Array.isArray(q.extrudeSteps) && q.extrudeSteps.length > 0);
}

const vRange = (verts: Vec3[], dir: THREE.Vector3) => projRange(verts.map(c => new THREE.Vector3(c[0], c[1], c[2])), dir);

function concaveCornerJoin(vfP: VirtualFace, vfQ: VirtualFace, tQ: number): { nQ: THREE.Vector3; dQ: number; tQ: number } | null {
  if (!vfP?.vertices || vfP.vertices.length < 3 || !vfQ?.vertices || vfQ.vertices.length < 3) return null;
  const nP = vfNormal(vfP), nQ = vfNormal(vfQ);
  if (Math.abs(nP.dot(nQ)) > 0.02) return null;
  const pP = vRange(vfP.vertices, nP), pQ = vRange(vfQ.vertices, nQ);
  if (pP.max - pP.min > CORNER_TOL || pQ.max - pQ.min > CORNER_TOL) return null;
  const dP = (pP.min + pP.max) / 2, dQ = (pQ.min + pQ.max) / 2;
  if (Math.abs(vRange(vfP.vertices, nQ).min - dQ) > CORNER_TOL) return null;   // P, Q düzleminde başlamıyor
  if (Math.abs(vRange(vfQ.vertices, nP).min - dP) > CORNER_TOL) return null;   // Q, P düzleminde başlamıyor
  const e = new THREE.Vector3().crossVectors(nP, nQ).normalize();
  const pEdge = vfP.vertices.filter(c => Math.abs(c[0] * nQ.x + c[1] * nQ.y + c[2] * nQ.z - dQ) <= CORNER_TOL);
  const qEdge = vfQ.vertices.filter(c => Math.abs(c[0] * nP.x + c[1] * nP.y + c[2] * nP.z - dP) <= CORNER_TOL);
  if (pEdge.length < 2 || qEdge.length < 2) return null;
  const pe = vRange(pEdge, e), qe = vRange(qEdge, e);
  if (pe.max - pe.min < 1) return null;
  if (qe.min > pe.min + 2 || qe.max < pe.max - 2) return null;
  return { nQ, dQ, tQ };
}

function cornerJoinedVertices(panel: Shape, vf: VirtualFace, vfs: VirtualFace[], siblings: Shape[], orderOf: (s: Shape) => number): Vec3[] {
  let verts = vf.vertices.map(c => [c[0], c[1], c[2]] as Vec3);
  if (hasAnySteps(panel)) return verts;
  const myOrder = orderOf(panel);
  for (const q of siblings) {
    // İç panel (raf/dikme) ve kapak köşe birleşimine girmez.
    if (q.id === panel.id || orderOf(q) <= myOrder || hasAnySteps(q) || isInteriorPanel(q) || isInteriorPanel(panel) || isSheetPanel(q) || isSheetPanel(panel)) continue;
    const vfQ = vfOfPanel(q, vfs);
    if (!vfQ) continue;
    const j = concaveCornerJoin(vf, vfQ, panelThickness(q));
    if (!j) continue;
    let moved = 0;
    verts = verts.map(c => {
      if (Math.abs(c[0] * j.nQ.x + c[1] * j.nQ.y + c[2] * j.nQ.z - j.dQ) > CORNER_TOL) return c;
      moved++;
      return [c[0] - j.nQ.x * j.tQ, c[1] - j.nQ.y * j.tQ, c[2] - j.nQ.z * j.tQ] as Vec3;
    });
  }
  return verts;
}

// DÖNÜŞ-KESİMİ: dönmüş/eğik BASAN, basılanı kendine bakan yüzünün yarım-uzayıyla keser (siluet prizmasıyla sınırlı).

function vfIsTilted(vf: VirtualFace | undefined | null): boolean {
  if (!vf?.normal) return false;
  return !isFlatNormal(vfNormal(vf));
}

function hugeRectOnPlane(center: THREE.Vector3, n: THREE.Vector3, H: number): Vec3[] {
  const { u, v } = getFacePlaneAxes(n);
  return [[-H, -H], [H, -H], [H, H], [-H, H]].map(([a, b]) => {
    const w = center.clone().addScaledVector(u, a).addScaledVector(v, b);
    return [w.x, w.y, w.z] as Vec3;
  });
}

function rotatedNormalOf(panel: Shape, vf: VirtualFace): THREE.Vector3 | null {
  try {
    return vfNormal(vf).applyQuaternion(composeSteps(getUnifiedSteps(panel), vf).quat).normalize();
  } catch { return null; }
}

async function cutByRotatedPressers(
  rp: any, panel: Shape, vfS: VirtualFace, siblings: Shape[], vfs: VirtualFace[],
  orderOf: (s: Shape) => number, createPanelFromVirtualFace: CreatePanelFn,
): Promise<any> {
  const myOrder = orderOf(panel);
  const nS = vfNormal(vfS);
  const dS = vfS.vertices.length ? new THREE.Vector3(...vfS.vertices[0]).dot(nS) : 0;
  // TARAF: bölge çapası (serbest hücre) — dik açılarda merkez/seed yanlış tarafa düşebilir.
  const anchor = (vfS as any).regionAnchor as Vec3 | undefined;
  const ref = anchor ? new THREE.Vector3(...anchor) : (() => {
    const c = new THREE.Vector3();
    for (const q of vfS.vertices) c.add(new THREE.Vector3(q[0], q[1], q[2]));
    return c.divideScalar(Math.max(vfS.vertices.length, 1));
  })();
  const thS = panelThickness(panel);
  let out = rp;
  for (const r of siblings) {
    // Sıra tek yetkidir — dönmüş raf/dikme de sırada sonraki gövde panelini biçer.
    if (r.id === panel.id || orderOf(r) >= myOrder) continue;
    // Kapak/arkalık hiçbir gövde panelini kesmez; eğik VF'li levha dönmüş basan sayılmaz.
    if (isSheetPanel(r)) continue;
    if (!panelHasRotation(r) && !vfIsTilted(vfOfPanel(r, vfs))) continue;
    if (stepRefTargets(r).rotate.has(panel.id)) {
      continue;
    }
    const rGeo = shapeById(r.id)?.geometry;
    const vfR = vfOfPanel(r, vfs);
    if (!rGeo || !vfR) continue;
    const nR = rotatedNormalOf(r, vfR);
    if (!nR || Math.abs(nR.dot(nS)) > 0.98) continue;
    if (!rGeo.getAttribute('position')) continue;
    const pts = uniqueMeshPoints(rGeo);
    const { min: dMin, max: dMax } = projRange(pts, nR);
    if (!(dMax - dMin > 1)) continue;
    const refD = ref.dot(nR);
    const keepPlus = refD > (dMin + dMax) / 2;           // panel çapanın tarafında kalır
    const dNear = keepPlus ? dMax : dMin;
    const toward = keepPlus ? nR.clone() : nR.clone().negate();
    const slabPts: Vec3[] = [
      ...vfS.vertices,
      ...vfS.vertices.map(c => [c[0] - nS.x * thS, c[1] - nS.y * thS, c[2] - nS.z * thS] as Vec3),
    ];
    if (!slabPts.some(c => (c[0] * nR.x + c[1] * nR.y + c[2] * nR.z - dNear) * (keepPlus ? 1 : -1) < -0.5)) continue;
    try {
      const cR = new THREE.Vector3(); for (const q of pts) cR.add(q); cR.divideScalar(pts.length);
      const onPlane = cR.clone().addScaledVector(nR, dNear - cR.dot(nR));
      const H = 100000;
      const half = await createPanelFromVirtualFace(hugeRectOnPlane(onPlane, nR, H), [toward.x, toward.y, toward.z], H, 0);
      const { u: us, v: vs } = getFacePlaneAxes(nS);
      const hull = convexHull2D(pts.map(q => ({ x: q.dot(us), y: q.dot(vs) })));
      if (hull.length < 3) continue;
      const silVerts = hull.map(q => {
        const w = new THREE.Vector3().addScaledVector(us, q.x).addScaledVector(vs, q.y).addScaledVector(nS, dS + 1000);
        return [w.x, w.y, w.z] as Vec3;
      });
      const sil = await createPanelFromVirtualFace(silVerts, [nS.x, nS.y, nS.z], H, 0);
      if (!half || !sil) continue;
      out = out.cut(sil.intersect(half));
    } catch (err) {
      console.warn('[YAGO][DÖNÜŞ-KESİM] kesim hatası:', panel.id, '<-', r.id, errMsg(err));
    }
  }
  return out;
}

// REF-DÖNÜŞ PAHI: R'nin seçilen yüz çokgeni nişan yönünde uzatılıp +nR'ye prizma yapılır, T'den çıkarılır (T'nin VF'si değişmez).
// T basan → R'nin DIŞ yüzeyi (R, T'de biter); T basılan/rest → İÇ yüzey (R, T'nin üstünden geçer).
async function shapeRefRotateTargets(
  rp: any, panel: Shape, vf: VirtualFace, children: Shape[], orderOf: (s: Shape) => number,
  refContacts: Map<string, RefContact>, updateShape: UpdateShape,
  convertReplicadToThreeGeometry: ToGeometryFn, createPanelFromVirtualFace: CreatePanelFn,
): Promise<void> {
  const targets = stepRefTargets(panel).rotate;
  if (targets.size === 0) return;
  const steps = getUnifiedSteps(panel);
  const { quat } = composeSteps(steps, vf);
  const nR = vfNormal(vf).applyQuaternion(quat).normalize();
  const myOrder = orderOf(panel);

  let outerHull: { x: number; y: number }[] = [];
  let innerHull: { x: number; y: number }[] = [];
  let dOuter = -Infinity, dInner = Infinity;
  const { u: ur, v: vr } = getFacePlaneAxes(nR);
  try {
    const pts = uniqueMeshPoints(convertReplicadToThreeGeometry(rp));
    ({ max: dOuter, min: dInner } = projRange(pts, nR));
    outerHull = convexHull2D(pts.filter(p => p.dot(nR) > dOuter - 0.5).map(p => ({ x: p.dot(ur), y: p.dot(vr) })));
    innerHull = convexHull2D(pts.filter(p => p.dot(nR) < dInner + 0.5).map(p => ({ x: p.dot(ur), y: p.dot(vr) })));
  } catch (err) {
    console.warn('[YAGO][REF-DÖN-PAH] yüz çokgeni çıkarılamadı:', panel.id, errMsg(err));
    return;
  }
  if (!Number.isFinite(dOuter) || !Number.isFinite(dInner)) return;

  for (const tid of targets) {
    const t = shapeById(tid);
    if (!t?.replicadShape || !t.geometry) continue;
    const st: any = steps.find((x: any) => x.type === 'rotate' && x.refTargetPanelId === tid);
    const tChild = children.find(c => c.id === tid);
    const tIsBasan = !!tChild && orderOf(tChild) < myOrder;
    const isRest = refContacts.get(tid) === 'rest';
    const useOuterPlane = tIsBasan && !isRest;
    const baseHull = useOuterPlane ? outerHull : innerHull;
    const dPlane = useOuterPlane ? dOuter : dInner;
    if (baseHull.length < 3) continue;
    try {
      const ext = 3 * panelThickness(t) + 2;
      let hull = baseHull;
      if (st?.refArmVfFrac) {
        const d = resolveVfFracPoint(st.refArmVfFrac as Vec3, vf).sub(resolvePivot(st, vf)).applyQuaternion(quat);
        d.addScaledVector(nR, -d.dot(nR));
        if (st.axisVec) {
          const axisW = new THREE.Vector3(...(st.axisVec as Vec3)).applyQuaternion(quat).normalize();
          d.addScaledVector(axisW, -d.dot(axisW));
        }
        if (d.length() > 1e-6) {
          d.normalize();
          const d2 = { x: d.dot(ur), y: d.dot(vr) };
          hull = convexHull2D([...baseHull, ...baseHull.map(q => ({ x: q.x + d2.x * ext, y: q.y + d2.y * ext }))]);
        }
      }
      if (hull.length < 3) continue;
      const poly = hull.map(q => {
        const w = new THREE.Vector3().addScaledVector(ur, q.x).addScaledVector(vr, q.y).addScaledVector(nR, dPlane);
        return [w.x, w.y, w.z] as Vec3;
      });
      // Normal −nR: slab +nR yönünde uzar → seçilen yüzeyin ÖTESİ.
      const cutter = await createPanelFromVirtualFace(poly, [-nR.x, -nR.y, -nR.z], 100000, 0);
      if (!cutter) continue;
      if (!boundsOverlapBox(cutter.boundingBox.bounds, localBboxOf(t.geometry)!)) {
        continue;
      }
      fmtBounds(t.replicadShape);   // boş/bozuk şekilde fırlatır → catch
      const shaped = t.replicadShape.clone().cut(cutter);
      fmtBounds(shaped);   // boş/bozuk sonuçta fırlatır → yazılmadan catch (referans korunur)
      updateShape(tid, { geometry: convertReplicadToThreeGeometry(shaped), replicadShape: shaped } as any);
    } catch (err) {
      console.warn('[YAGO][REF-DÖN-PAH] pah hatası:', tid, '<-', panel.id, errMsg(err));
    }
  }
}

// Vertex düzenlemeli gövde katısı: düzenlenmiş mesh yüzlerinden YARIM-UZAY kesişimi (içbükeyde dışbükey örtü).
const _bodySolidCache = new WeakMap<object, { key: string; solid: any }>();

interface BodyPlane { n: THREE.Vector3; d: number; center: THREE.Vector3 }

/** Gövdeyi DESTEKLEYEN düzlemler: tüm köşeler düzlemin iç tarafında kalan yüz grupları (n dışa bakar, n·p ≤ d).
 * Çıkarma çentiğinin iç yüzleri gövdeyi iki yana böler; onların yarım-uzayı gövdeyi oyar (sol/ön yüz paneli
 * kesişimde boş kalır, ölçüsü 0 olur) → atlanır. Dışbükey gövdede sonuç birebir, içbükeyde dışbükey örtü. */
const _bodyPlaneCache = new WeakMap<THREE.BufferGeometry, BodyPlane[]>();
function supportingBodyPlanes(geo: THREE.BufferGeometry): BodyPlane[] {
  const hit = _bodyPlaneCache.get(geo);
  if (hit) return hit;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return [];
  const { groups } = getFacesAndGroups(geo);
  geo.computeBoundingBox();
  const size = geo.boundingBox!.getSize(new THREE.Vector3());
  const tol = Math.max(0.5, Math.max(size.x, size.y, size.z) * 1e-4);
  const out: BodyPlane[] = [];
  const p = new THREE.Vector3();
  for (const g of groups) {
    const n = g.normal.clone().normalize();
    if (!(n.lengthSq() > 0.5)) continue;
    const d = g.center.dot(n);
    let maxS = -Infinity, minS = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const s = p.fromBufferAttribute(pos, i).dot(n) - d;
      if (s > maxS) maxS = s;
      if (s < minS) minS = s;
    }
    if (maxS <= tol) out.push({ n, d, center: g.center });
    else if (minS >= -tol) out.push({ n: n.negate(), d: -d, center: g.center });
  }
  _bodyPlaneCache.set(geo, out);
  return out;
}

async function effectiveBodySolid(parent: Shape): Promise<any | null> {
  const mods = parent.vertexModifications;
  if (!Array.isArray(mods) || mods.length === 0) return parent.replicadShape ? parent.replicadShape.clone() : null;
  const key = vertexModsKey(mods);
  const cached = parent.geometry ? _bodySolidCache.get(parent.geometry) : undefined;
  if (cached && cached.key === key) return cached.solid.clone();
  const geo = effectiveBodyGeometry(parent);
  const planes = supportingBodyPlanes(geo);
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const center = new THREE.Vector3(); bb.getCenter(center);
  const size = new THREE.Vector3(); bb.getSize(size);
  const M = Math.max(size.x, size.y, size.z) * 2 + 200;
  const big = await createPanelFromVirtualFace(
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [center.x + a * M / 2, center.y + M / 2, center.z + b * M / 2] as Vec3),
    [0, 1, 0], M, 0);
  if (!big) return null;
  let solid = big;
  for (const pl of planes) {
    const n = pl.n;
    const H = M * 2;
    // createPanel −normal yönüne uzar → dış yarım-uzay için normal = −n.
    const outside = await createPanelFromVirtualFace(hugeRectOnPlane(pl.center, n, H), [-n.x, -n.y, -n.z], H, 0);
    if (!outside) continue;
    try { solid = solid.cut(outside); } catch (e) { console.warn('[YAGO][GÖVDE-KATI] yarım-uzay kesimi hatası:', errMsg(e)); }
  }
  if (parent.geometry) _bodySolidCache.set(parent.geometry, { key, solid });
  return solid.clone();
}

function tiltedBodyPlanes(parent: Shape): Array<{ n: THREE.Vector3; d: number }> {
  const mods = parent.vertexModifications;
  if (!Array.isArray(mods) || mods.length === 0 || !parent.geometry) return [];
  return supportingBodyPlanes(effectiveBodyGeometry(parent))
    .filter(pl => !isFlatNormal(pl.n, 0.999 - Number.EPSILON))
    .map(pl => ({ n: pl.n, d: pl.d }));
}

// Eğik gövde düzlemindeki VF köşeleri dışa uzatılır; sonraki gövde kesişimi ucu eğime göre pahlar.
function extendVertsOnTiltedPlanes(
  verts: Vec3[], normal: Vec3, planes: Array<{ n: THREE.Vector3; d: number }>, amount: number,
): { verts: Vec3[]; moved: number } {
  if (!planes.length) return { verts, moved: 0 };
  const nv = new THREE.Vector3(...normal).normalize();
  let moved = 0;
  const out = verts.map(c => {
    const p = new THREE.Vector3(c[0], c[1], c[2]);
    for (const pl of planes) {
      if (Math.abs(p.dot(pl.n) - pl.d) > 1.0) continue;
      const dir = pl.n.clone().addScaledVector(nv, -pl.n.dot(nv));
      if (dir.lengthSq() < 1e-6) continue;   // eğik yüz VF'ye paralel
      p.addScaledVector(dir.normalize(), amount);
      moved++;
      break;
    }
    return [p.x, p.y, p.z] as Vec3;
  });
  return { verts: out, moved };
}

// Dönmüş raf/dikme grubunun hacim KUTUSUYLA kesişir (L hacmin şekli kalınlığa geçmez).
async function clipToGroupCavity(rp: any, panel: Shape): Promise<any> {
  const gid = (panel.parameters as any)?.panelGroupId as string | undefined;
  if (!gid) return rp;
  const group = useAppStore.getState().panelGroups.find(g => g.id === gid);
  const c = group?.cavity;
  if (!c) return rp;
  const size = [0, 1, 2].map(a => c.max[a] - c.min[a]);
  if (size.some(v => !(v > 0.5))) return rp;
  try {
    const box = (await createReplicadBox({ width: size[0], height: size[1], depth: size[2] })).translate(c.min[0], c.min[1], c.min[2]);
    fmtBounds(rp);   // boş/bozuk şekilde fırlatır → catch
    const out = rp.intersect(box);
    return out;
  } catch (err) {
    console.warn('[YAGO][DÖNÜŞ-HACİM] hacim kesişimi hatası:', panel.id, errMsg(err));
    return rp;
  }
}

async function intersectWithBody(rp: any, panel: Shape, parent: Shape, tag: string, fallbackBox: boolean): Promise<any> {
  try {
    let body = await effectiveBodySolid(parent);
    if (!body && fallbackBox) {
      const pp: any = parent.parameters || {};
      body = await createReplicadBox({ width: parseFloat(pp.width) || 1, height: parseFloat(pp.height) || 1, depth: parseFloat(pp.depth) || 1 });
    }
    if (!body) return rp;
    fmtBounds(rp);   // boş/bozuk şekilde fırlatır → catch
    const out = rp.intersect(body);
    // Boş kesişim panelin sessizce yok olması (ölçü 0) demektir → kırpma atlanır, uyarı bırakılır.
    try { fmtBounds(out); } catch {
      console.warn(`[YAGO][${tag}] gövde kesişimi BOŞ, kırpma atlandı:`, panel.id, 'gövde=', fmtBounds(body));
      return rp;
    }
    return out;
  } catch (err) {
    console.warn(`[YAGO][${tag}] gövde kesişimi hatası:`, panel.id, errMsg(err));
    return rp;
  }
}

// BÜYÜT & SIĞDIR: gövdeyle kesişim + SIRADA ÖNCE gelen kardeşlerle kesim; referansa OTURAN ('rest') panel onu kesmez.
async function fitRotatedPanel(
  rp: any, panel: Shape, parent: Shape, siblings: Shape[], orderOf: (s: Shape) => number, refContacts: Map<string, RefContact>,
): Promise<any> {
  let out = await intersectWithBody(rp, panel, parent, 'DÖNÜŞ-SIĞDIR', true);
  const myOrder = orderOf(panel);
  const myRefTargets = stepRefTargets(panel).rotate;
  for (const b of siblings) {
    if (b.id === panel.id || orderOf(b) >= myOrder) continue;
    if (isSheetPanel(b)) continue;   // kapak/arkalık gövde panelini kesmez
    const isRefTarget = myRefTargets.has(b.id);
    if (isRefTarget && refContacts.get(b.id) === 'rest') {
      continue;
    }
    const fresh = shapeById(b.id);
    if (!fresh?.replicadShape || !fresh.geometry) continue;
    try {
      if (!boundsOverlapBox(out.boundingBox.bounds, localBboxOf(fresh.geometry)!)) continue;
      out = out.cut(fresh.replicadShape.clone());
    } catch (err) {
      console.warn('[YAGO][DÖNÜŞ-SIĞDIR] kardeş kesimi hatası:', panel.id, '<-', b.id, errMsg(err));
    }
  }
  return out;
}

export interface RebuildOpts {
  /** Yalnız bu panel işlem gördü ve sıralama DEĞİŞMEDİ → mümkünse tek-panel modu. */
  changedPanelId?: string;
  orderChanged?: boolean;
}
const inFlight = new Set<string>();
const pending = new Map<string, RebuildOpts | undefined>();

/** Aynı parent için rebuild sürüyorsa kuyruğa alınır; TAM rebuild isteği her zaman korunur. */
export async function rebuildPanelsForParent(parentShapeId: string, opts?: RebuildOpts): Promise<void> {
  if (inFlight.has(parentShapeId)) {
    const prevFull = pending.has(parentShapeId) && pending.get(parentShapeId) === undefined;
    if (opts === undefined || !prevFull) pending.set(parentShapeId, opts);
    console.info('[PanelRebuild] rebuild already in flight for', parentShapeId, '— queued a re-run');
    return;
  }
  inFlight.add(parentShapeId);
  try {
    await rebuildOnce(parentShapeId, opts);
  } finally {
    inFlight.delete(parentShapeId);
    if (pending.has(parentShapeId)) {
      const nextOpts = pending.get(parentShapeId);
      pending.delete(parentShapeId);
      await rebuildPanelsForParent(parentShapeId, nextOpts);
    }
  }
}

function mergeResolved<T extends { id: string; resolvedValue?: number }>(steps: T[], resolved: Array<{ id: string; value: number }>): T[] | null {
  if (!resolved.length) return null;
  const byId = new Map(resolved.map(r => [r.id, r.value]));
  let changed = false;
  const merged = steps.map(s => {
    const rv = byId.get(s.id);
    if (rv != null && s.resolvedValue !== rv) { changed = true; return { ...s, resolvedValue: rv }; }
    return s;
  });
  return changed ? merged : null;
}

function panelTs(s: Shape): number {
  const m = /(\d{10,})/.exec(s.id);
  return m ? parseInt(m[1], 10) : 0;
}

async function rebuildOnce(parentShapeId: string, opts?: RebuildOpts): Promise<void> {
  const parent = shapeById(parentShapeId);
  if (!parent) return;

  // TAZE STATE: dinamik import'lar sırasında store güncellenmiş olabilir.
  const fresh = useAppStore.getState();
  const parentFresh = shapeById(parentShapeId, fresh.shapes) || parent;
  const updateShape = fresh.updateShape;
  const vfOrder = new Map<string, number>();
  fresh.virtualFaces.forEach((f, i) => vfOrder.set(f.id, i));
  const orderOf = (s: Shape): number => {
    const idx = vfOrder.get((s.parameters as any)?.virtualFaceId);
    return idx != null ? idx : 1e9 + panelTs(s) / 1e13;
  };

  // SIRA: referans verilen panel ÖNCE üretilir; bağsız çiftlerde VF sırası (basan/basılan) geçerlidir.
  const unsorted = childPanelsOf(parentShapeId, fresh.shapes);
  const refIds = new Map<string, Set<string>>();
  for (const s of unsorted) {
    const r = stepRefTargets(s);
    refIds.set(s.id, new Set([...r.extrude, ...r.move, ...r.rotate]));
  }
  const children = unsorted.sort((a, b) => {
    const aRefsB = refIds.get(a.id)!.has(b.id), bRefsA = refIds.get(b.id)!.has(a.id);
    if (aRefsB && !bRefsA) return 1;
    if (bRefsA && !aRefsB) return -1;
    return orderOf(a) - orderOf(b);
  });
  if (children.length === 0) return;

  // TEK-PANEL MODU: yalnız değişen panel üretilir, VF'ler yeniden hesaplanmaz (komşu ayak izi sabit → salınım yok).
  // Aşağıdaki cancel koşullarından biri tutarsa TAM rebuild şarttır.
  const changedChild = opts?.changedPanelId ? children.find(c => c.id === opts.changedPanelId) : undefined;
  let singleMode = false;
  if (changedChild && !opts?.orderChanged) {
    const changedOrder = orderOf(changedChild);
    const pressed = children.filter(c => c.id !== changedChild.id && orderOf(c) > changedOrder);
    const vq = vfOfPanel(changedChild, fresh.virtualFaces);
    const cornerPartner = !!vq && children.some(c => {
      if (c.id === changedChild.id || orderOf(c) >= changedOrder) return false;
      const vp = vfOfPanel(c, fresh.virtualFaces);
      return !!vp && !!concaveCornerJoin(vp, vq, panelThickness(changedChild));
    });
    const refDependents = children.filter(c => c.id !== changedChild.id && refIds.get(c.id)!.has(changedChild.id));
    const boundsGroups = !isInteriorPanel(changedChild) && !isSheetPanel(changedChild) && (fresh.panelGroups.some(g => g.shapeId === parentShapeId) || fresh.doorGroups.some(g => g.shapeId === parentShapeId) || fresh.backGroups.some(g => g.shapeId === parentShapeId));
    const cancel: Array<[boolean, string]> = [
      [pressed.length > 0, `sıra= ${changedOrder} basılanKardeşN= ${pressed.length} → basan panel taşındı/değişti, basılan kardeşlerin VF bölgeleri yeniden çözülecek`],
      [cornerPartner, '→ önceki panelle iç köşe ortağı, köşe uzaması yeniden çözülecek'],
      [refDependents.length > 0, `→ referans bağımlıları var: ${refDependents.map(c => c.id).join(',')} (referans köşe/düzlem güncel geometriden yeniden çözülecek)`],
      [stepRefTargets(changedChild).rotate.size > 0, '→ referans panel(ler)in kenarını pahlıyor, referans sıfırdan üretilip yeniden pahlanacak'],
      [boundsGroups, '→ gövdede raf/dikme grubu var, hacimler yeniden çözülecek'],
    ];
    singleMode = !cancel.some(([hit]) => hit);
  }

  const parentPos = [...parentFresh.position] as Vec3;
  const pp: any = parentFresh.parameters || {};
  const growForRotated = Math.max(parseFloat(pp.width) || 0, parseFloat(pp.height) || 0, parseFloat(pp.depth) || 0, 600) * 1.5;

  const buildPanel = async (panel: Shape, vfsIn: VirtualFace[], groove = true): Promise<void> => {
    try {
      const vf = vfOfPanel(panel, vfsIn);
      if (!vf || !vf.vertices || vf.vertices.length < 3 || !(panel.parameters as any)?.parentShapeId) return;
      const thickness = panelThickness(panel);
      let steps = getUnifiedSteps(panel);
      let stepsChanged = false;
      // fixedRef'siz FIXED move: bu rebuild'deki ham yüz konumu fixedRef olarak kaydedilir.
      {
        let sawRotate = false;
        steps = steps.map((st: any) => {
          if (st.type === 'rotate') { sawRotate = true; return st; }
          if (st.type === 'move' && st.isFixed && typeof st.fixedRef !== 'number' && !sawRotate && !st.refTargetPanelId && !st._refAxisVec) {
            const ref = vfRawMinAlong(vf, st.axis);
            if (ref !== null) { stepsChanged = true; return { ...st, fixedRef: ref }; }
          }
          return st;
        });
      }
      const buildVerts = cornerJoinedVertices(panel, vf, vfsIn, children, orderOf);
      const vfTilted = vfIsTilted(vf);
      // Kapak/arkalık gövdeyle sığdırılmaz/kesilmez (gövdenin önünde/arkasında durur); adımları yine uygulanır.
      const isRotated = !isSheetPanel(panel) && (panelHasRotation(panel) || vfTilted);
      let genVerts = buildVerts;
      let needsBodyClip = false;
      // İç panel + vertex düzenlemeli gövde: levha eğik yüzden taşmasın diye gövde katısıyla kesilir.
      if (!isRotated && isInteriorPanel(panel) && Array.isArray(parentFresh.vertexModifications) && parentFresh.vertexModifications.length > 0) needsBodyClip = true;
      // Düz panel + eğik gövde yüzü: VF köşeleri uzatılıp gövdeyle kesilir (kapak/arkalık hariç).
      if (!isRotated && !isSheetPanel(panel)) {
        const planes = tiltedBodyPlanes(parentFresh);
        if (planes.length) {
          const ext = extendVertsOnTiltedPlanes(buildVerts, vf.normal, planes, thickness * 3 + 2);
          if (ext.moved > 0) {
            genVerts = ext.verts; needsBodyClip = true;
          }
        }
      }
      let rp = await createPanelFromVirtualFace(genVerts, vf.normal, thickness, isRotated ? growForRotated : 0);
      if (!rp) return;

      const { ops, resolvedRotations } = composeSteps(steps, vf);
      const mergedRot = mergeResolved(steps, resolvedRotations);
      if (mergedRot) { steps = mergedRot as TransformStep[]; stepsChanged = true; }
      let refDeltaApplied: Vec3 | null = null;
      for (const op of ops) {
        if (op.kind === 'translate') {
          rp = rp.translate(op.d.x, op.d.y, op.d.z);
        } else if (op.kind === 'refTranslate') {
          let rpWorldBox: THREE.Box3;
          try { rpWorldBox = localBboxOf(convertReplicadToThreeGeometry(rp))!.translate(new THREE.Vector3(...parentPos)); }
          catch { rpWorldBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()); }
          const d = resolveRefTranslateDelta(op, rpWorldBox);
          // TEK KAYNAK: uygulanan delta panele yazılır; damgalama bunu okur (yeniden çözmez).
          refDeltaApplied = [d.x, d.y, d.z];
          rp = rp.translate(d.x, d.y, d.z);
        } else {
          rp = rp.rotate(op.deg, [op.pivot.x, op.pivot.y, op.pivot.z], [op.axis.x, op.axis.y, op.axis.z]);
        }
      }
      const refContacts = new Map<string, RefContact>();
      for (const r of resolvedRotations) if (r.targetId && r.contact) refContacts.set(r.targetId, r.contact);
      if (isRotated) {
        rp = await fitRotatedPanel(rp, panel, parentFresh, children, orderOf, refContacts);
        if (isInteriorPanel(panel)) rp = await clipToGroupCavity(rp, panel);
      }
      else if (needsBodyClip) rp = await intersectWithBody(rp, panel, parentFresh, 'EĞİK-UÇ', false);

      let meshed: { shape: any; geometry: THREE.BufferGeometry } | null = null;
      let dimsUpdate: { width: number; height: number; depth: number } | null = null;
      let resolvedStepsUpdate: ExtrudeStep[] | null = null;
      const extrudeSteps: ExtrudeStep[] | undefined = (panel.parameters as any)?.extrudeSteps;
      if (Array.isArray(extrudeSteps) && extrudeSteps.length > 0) {
        try {
          const ext = await applyExtrudeSteps(rp, extrudeSteps, useAppStore.getState().shapes);
          if (ext) {
            rp = ext.shape;
            meshed = { shape: ext.shape, geometry: ext.geometry };
            const es = localBboxOf(ext.geometry)!.getSize(new THREE.Vector3());
            const dsz = [es.x, es.y, es.z].sort((a, b) => b - a);
            dimsUpdate = { width: round1(dsz[0]), height: round1(dsz[1]), depth: round1(dsz[2]) };
            resolvedStepsUpdate = mergeResolved(extrudeSteps, ext.resolved) as ExtrudeStep[] | null;
          }
        } catch (err) {
          console.error('[YAGO][MOTOR] extrude adımı hatası:', panel.id, errMsg(err));
        }
      }

      if (!panelHasRotation(panel) && !isSheetPanel(panel)) {
        rp = await cutByRotatedPressers(rp, panel, vf, children, vfsIn, orderOf, createPanelFromVirtualFace);
      }
      await shapeRefRotateTargets(rp, panel, vf, children, orderOf, refContacts, updateShape, convertReplicadToThreeGeometry, createPanelFromVirtualFace);

      // ARKALIK KANALI (Goker, Eki 2026 — "arkalığın üzerinde bir çıkartıcı olsun … bollaştırılmış kanal"): kanallı ilişkideki sınır /
      // derz paneline parçanın bollaştırılmış kutusu katıdan çıkarılır. Yalnız görünüm/katı: kanalsız mesh `ungroovedGeometry`
      // olarak saklanır ve ayak izi / damga / hacim onu okur → kanal boşluğuna panel sızmaz. Kutu panelin kutusuna değmiyorsa atlanır.
      // Performans: yalnız SON geçişte kesilir (ilk geçiş ara sonuçtur; VF hesabı kanalsız mesh'i okur), aynı kanalsız mesh +
      // aynı kesiciler için önceki sonuç yeniden kullanılır (_grooveCache), bitişik kesiciler tek kutuda birleşir.
      let ungrooved: THREE.BufferGeometry | null = null;
      let grooved: { rp: any; geometry: THREE.BufferGeometry } | null = null;
      if (groove && !isSheetPanel(panel) && !isRotated) {
        const cutters = mergeGrooveCutters(backGrooveCuttersFor(panel));
        if (cutters.length) {
          const base = meshed && meshed.shape === rp ? meshed.geometry : convertReplicadToThreeGeometry(rp);
          const pb = localBboxOf(base);
          const live = cutters.filter(c => pb && !(c.max[0] <= pb.min.x + 0.01 || c.min[0] >= pb.max.x - 0.01 || c.max[1] <= pb.min.y + 0.01 || c.min[1] >= pb.max.y - 0.01 || c.max[2] <= pb.min.z + 0.01 || c.min[2] >= pb.max.z - 0.01));
          if (live.length) {
            const sig = `${meshSignature(base)}|${live.map(c => c.min.map(round1).join(',') + '/' + c.max.map(round1).join(',')).join(';')}`;
            const hit = _grooveCache.get(panel.id);
            if (hit && hit.sig === sig) { ungrooved = base; grooved = { rp: hit.rp, geometry: hit.geometry }; }
            else {
              const t0 = performance.now();
              let cut = rp, cutN = 0;
              for (const c of live) {
                try {
                  const box = (await createReplicadBox({ width: c.max[0] - c.min[0], height: c.max[1] - c.min[1], depth: c.max[2] - c.min[2] })).translate(c.min[0], c.min[1], c.min[2]);
                  cut = cut.cut(box); cutN++;
                } catch (err) { console.warn('[YAGO][ARKALIK-KANAL] kanal kesimi hatası:', panel.id, errMsg(err)); }
              }
              if (cutN) {
                ungrooved = base; grooved = { rp: cut, geometry: convertReplicadToThreeGeometry(cut) };
                if (_grooveCache.size > 200) _grooveCache.clear();
                _grooveCache.set(panel.id, { sig, rp: cut, geometry: grooved.geometry });
                const dt = performance.now() - t0; if (dt > 250) console.warn('[YAGO][ARKALIK-KANAL] yavaş kesim:', panel.id, cutN, 'kanal', dt.toFixed(0), 'ms');
              }
            }
          }
        }
      }
      if (grooved) rp = grooved.rp;

      // Katı extrude'dan sonra değişmediyse mevcut mesh yeniden kullanılır (aynı tessellation).
      const geometry = grooved ? grooved.geometry : meshed && meshed.shape === rp ? meshed.geometry : convertReplicadToThreeGeometry(rp);
      if (ungrooved) ungrooved.userData.groovedUuid = geometry.uuid;
      const paramPatch: any = {};
      if (dimsUpdate) Object.assign(paramPatch, dimsUpdate);
      if (resolvedStepsUpdate) paramPatch.extrudeSteps = resolvedStepsUpdate;
      if (refDeltaApplied) paramPatch._refDeltaApplied = refDeltaApplied;
      if (stepsChanged) paramPatch.transformSteps = steps;
      // ANINDA YAZ: sonraki panel ve VF yeniden hesabı güncel ayak izini görsün.
      updateShape(panel.id, {
        geometry, position: parentPos, rotation: [0, 0, 0], replicadShape: rp, ungroovedGeometry: ungrooved ?? undefined,
        ...(Object.keys(paramPatch).length ? { parameters: { ...panel.parameters, ...paramPatch } } : {}),
      } as any);
    } catch (err) {
      console.error('[YAGO][MOTOR] panel üretim hatası:', panel.id, errMsg(err));
    }
  };

  if (singleMode) {
    const vfs = useAppStore.getState().virtualFaces.filter(f => (f as any).shapeId === parentShapeId);
    await buildPanel(changedChild!, vfs);
    return;
  }

  // İKİ GEÇİŞ: her panelden sonra VF'ler currentVfs üzerinden yeniden hesaplanır; 2. geçiş bayat komşu bölgelerini düzeltir.
  const recalc = (vfs: VirtualFace[]) => {
    const st = useAppStore.getState();
    const parentNow = shapeById(parentShapeId, st.shapes) || parentFresh;
    return recalculateVirtualFacesForShape(parentNow, vfs, st.shapes, st.panelGroups);
  };
  let currentVfs = recalc(useAppStore.getState().virtualFaces);
  for (let pass = 0; pass < 2; pass++) {
    for (const panel of children) {
      await buildPanel(panel, currentVfs, pass === 1);
      currentVfs = recalc(currentVfs);
    }
  }
  // Yalnız regen alanları yazılır — rebuild sürerken kullanıcının değiştirdiği alanlar ezilmez.
  const patches = new Map<string, Partial<VirtualFace>>();
  for (const f of currentVfs) {
    if (f.shapeId !== parentShapeId) continue;
    const p: any = {};
    for (const k of VF_REGEN_FIELDS) if (k in f) p[k] = (f as any)[k];
    patches.set(f.id, p);
  }
  useAppStore.setState(st => ({ virtualFaces: st.virtualFaces.map(f => (patches.has(f.id) ? { ...f, ...patches.get(f.id) } : f)) }));
  try { syncPanelGroups(parentShapeId); } catch (err) { console.warn('[YAGO][GRUP-SENKRON] hata:', errMsg(err)); }
  try { syncDoorGroups(parentShapeId); } catch (err) { console.warn('[YAGO][KAPAK-SENKRON] hata:', errMsg(err)); }
  try { syncBackGroups(parentShapeId); } catch (err) { console.warn('[YAGO][ARKALIK-SENKRON] hata:', errMsg(err)); }
}

// ARKALIK KANALI yardımcıları: kanallı sonuç önbelleği (panel id → kanalsız mesh imzası + kesiciler), mesh imzası, kesici birleştirme.
const _grooveCache = new Map<string, { sig: string; rp: any; geometry: THREE.BufferGeometry }>();
function meshSignature(g: THREE.BufferGeometry): string {
  const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return '0';
  let h = 7;
  for (let i = 0; i < pos.count * 3; i++) h = (Math.imul(h, 31) + Math.round(pos.array[i] * 100)) | 0;
  return `${pos.count}:${h}`;
}
/** Aynı eksen aralıklarına sahip, çapraz eksende bitişik/örtüşen kanal kutuları tek kutuda birleşir (daha az boolean). */
function mergeGrooveCutters(boxes: CavityBox[]): CavityBox[] {
  const out: CavityBox[] = boxes.map(b => ({ min: [...b.min] as Vec3, max: [...b.max] as Vec3 }));
  const same = (x: number, y: number) => Math.abs(x - y) < 0.05;
  for (let i = 0; i < out.length; i++) for (let j = out.length - 1; j > i; j--) {
    const a = out[i], b = out[j];
    const axes = [0, 1, 2].filter(k => same(a.min[k], b.min[k]) && same(a.max[k], b.max[k]));
    if (axes.length !== 2) continue;
    const c = [0, 1, 2].find(k => !axes.includes(k))!;
    if (b.min[c] > a.max[c] + 0.05 || b.max[c] < a.min[c] - 0.05) continue;
    a.min[c] = Math.min(a.min[c], b.min[c]); a.max[c] = Math.max(a.max[c], b.max[c]);
    out.splice(j, 1);
  }
  return out;
}

/** VF yeniden hesabının sahip olduğu alanlar (geri kalanı kullanıcı verisidir). */
const VF_REGEN_FIELDS = ['normal', 'center', 'vertices', 'rawFaceBBox', 'sideRelations', 'regionAnchor'] as const;

// VF BÖLGE YENİDEN HESABI: VF = eşleşen gövde yüz konturu ∩ serbest bölge (FaceRegion.computeFreeRegionLocal —
// yakalama ile aynı → highlight = panel). Damga TEK YÖNLÜ: yalnız sırada ÖNCE gelen (basan) kardeşler damgalar;
// istisna bu yüze fiziksel İLERLETEN adımlar; datum (ref hedefi) onu referans alan panelce kırpılmaz.

type RawBBox = { xMin: number; xMax: number; yMin: number; yMax: number; xSpan: number; ySpan: number };

function uvBox(pts: Iterable<{ x: number; y: number }>): RawBBox {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const q of pts) { if (q.x < xMin) xMin = q.x; if (q.x > xMax) xMax = q.x; if (q.y < yMin) yMin = q.y; if (q.y > yMax) yMax = q.y; }
  return { xMin, xMax, yMin, yMax, xSpan: Math.max(xMax - xMin, 1e-6), ySpan: Math.max(yMax - yMin, 1e-6) };
}
function planeFrame(n3: THREE.Vector3) {
  const { u, v } = getFacePlaneAxes(n3);
  const dU = (a: Vec3) => a[0] * u.x + a[1] * u.y + a[2] * u.z;
  const dV = (a: Vec3) => a[0] * v.x + a[1] * v.y + a[2] * v.z;
  const dN = (a: Vec3) => a[0] * n3.x + a[1] * n3.y + a[2] * n3.z;
  const at = (pu: number, pv: number, pn: number): Vec3 => [u.x * pu + v.x * pv + n3.x * pn, u.y * pu + v.y * pv + n3.y * pn, u.z * pu + v.z * pv + n3.z * pn];
  return { u, v, dU, dV, dN, at };
}

function buildPrismFromVertices(vertices: Vec3[], normal: Vec3, thickness: number): THREE.BufferGeometry | null {
  const N = vertices.length;
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const front = vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const back = front.map(p => p.clone().addScaledVector(n, -thickness)); // extrude(-th) ile aynı yön
  const arr = new Float32Array(N * 2 * 3);
  [...front, ...back].forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; });
  // Kapaklar fan (dış kenarlar tek kullanımlı kalır → kenar-halkası doğru), yanlar quad.
  const idx: number[] = [];
  for (let i = 1; i < N - 1; i++) idx.push(0, i, i + 1);
  for (let i = 1; i < N - 1; i++) idx.push(N, N + i + 1, N + i);    // arka kapak (ters sarım)
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    idx.push(i, j, N + j, i, N + j, N + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.setIndex(idx);
  return g;
}

function freshRawBox(freshRawVerts: Vec3[], f: ReturnType<typeof planeFrame>) {
  return { ...uvBox(freshRawVerts.map(p => ({ x: f.dU(p), y: f.dV(p) }))), planeD: f.dN(freshRawVerts[0]) };
}
function remapUV(pu: number, pv: number, oldRaw: RawBBox, nb: RawBBox): { x: number; y: number } {
  if (Math.abs(oldRaw.xSpan - nb.xSpan) < 1 && Math.abs(oldRaw.ySpan - nb.ySpan) < 1) {
    return { x: pu + (nb.xMin + nb.xMax) / 2 - (oldRaw.xMin + oldRaw.xMax) / 2, y: pv + (nb.yMin + nb.yMax) / 2 - (oldRaw.yMin + oldRaw.yMax) / 2 };
  }
  return { x: nb.xMin + ((pu - oldRaw.xMin) / oldRaw.xSpan) * nb.xSpan, y: nb.yMin + ((pv - oldRaw.yMin) / oldRaw.ySpan) * nb.ySpan };
}

// DAMGA TABANI = panelin KENDİ VF bölgesi; kayıtlı rawFaceBBox'tan güncel ham kutuya taşınır (yoksa izdüşer / ham kontur).
function stampBaseVertsFromVf(vf: VirtualFace | undefined, freshRawVerts: Vec3[] | undefined): Vec3[] | undefined {
  if (!vf) return freshRawVerts;
  const region = vf.vertices as Vec3[] | undefined;
  if (!region || region.length < 3) return freshRawVerts;
  if (!freshRawVerts || freshRawVerts.length < 3) return region;
  const f = planeFrame(new THREE.Vector3(...vf.normal).normalize());
  const nb = freshRawBox(freshRawVerts, f);
  const oldRaw = (vf as any).rawFaceBBox as RawBBox | undefined;
  if (!oldRaw) {
    for (const q of region) {
      const pu = f.dU(q), pv = f.dV(q);
      if (pu < nb.xMin - 1 || pu > nb.xMax + 1 || pv < nb.yMin - 1 || pv > nb.yMax + 1) return freshRawVerts;
    }
    return region.map(q => f.at(f.dU(q), f.dV(q), nb.planeD));
  }
  return region.map(q => { const m = remapUV(f.dU(q), f.dV(q), oldRaw, nb); return f.at(m.x, m.y, nb.planeD); });
}

// Extrude'lu DAMGA: VF tabanı adımların İŞARETLİ miktarıyla budanır (gerçek extrude ile birebir); hedef yüze BAKAN büyüme yansıtılmaz.
// Kalınlık extrude'u (adım normali ≈ VF normali) damgayı ötelemez, [tMin,tMax] (başlangıç [−th,0]) aralığını değiştirir.
function trimmedStampGeometryFromVf(vf: VirtualFace, thickness: number, extrudeSteps: any[], targetFaceNormal: THREE.Vector3): THREE.BufferGeometry | null {
  if (!vf.vertices || vf.vertices.length < 3) return null;
  const trimmed: Vec3[] = vf.vertices.map(v => [...v] as Vec3);
  const vfN = new THREE.Vector3(...vf.normal).normalize();
  let tMin = -thickness, tMax = 0;
  for (const step of extrudeSteps) {
    if (!step.faceNormal) continue;
    const eN = new THREE.Vector3(...step.faceNormal).normalize();
    const alignN = eN.dot(vfN);
    if (Math.abs(alignN) > 0.7) {
      const cur = tMax - tMin;
      const resolvedN = step.resolvedValue !== undefined && step.resolvedValue !== null;
      const amountN = resolvedN ? step.resolvedValue : step.isFixed ? (step.value ?? 0) - cur : (step.value ?? 0);
      if (Math.abs(amountN) < 0.01) continue;
      if (alignN > 0) tMax += amountN; else tMin -= amountN;
      if (tMax - tMin < 0.5) tMin = tMax - 0.5;   // dejenere kalınlık koruması
      continue;
    }
    const alignT = eN.dot(targetFaceNormal);
    if (alignT < -0.3) continue;   // hedef yüzden uzaklaşan extrude: yakın kenar yerinde
    const projs = trimmed.map(p => p[0] * eN.x + p[1] * eN.y + p[2] * eN.z);
    const resolved = step.resolvedValue !== undefined && step.resolvedValue !== null;
    const amount = resolved ? step.resolvedValue
      : step.isFixed ? (step.value ?? 0) - (Math.max(...projs) - Math.min(...projs))
      : (step.value ?? 0);
    if (Math.abs(amount) < 0.01) continue;
    if (alignT > 0.7 && amount > 0) continue;
    const threshold = amount < 0 ? Math.max(...projs) + amount : Math.min(...projs) + amount;
    for (let i = 0; i < trimmed.length; i++) {
      if (amount < 0 ? projs[i] > threshold : projs[i] < threshold) {
        const delta = threshold - projs[i];
        trimmed[i][0] += delta * eN.x; trimmed[i][1] += delta * eN.y; trimmed[i][2] += delta * eN.z;
      }
    }
  }
  const front: Vec3[] = Math.abs(tMax) < 1e-9 ? trimmed
    : trimmed.map(([x, y, z]) => [x + vfN.x * tMax, y + vfN.y * tMax, z + vfN.z * tMax] as Vec3);
  return buildPrismFromVertices(front, vf.normal, tMax - tMin);
}

// ORANSAL DAMGA: baked mesh henüz eski boyutta → eski VF bölgesi yeni ham kutuya taşınır; değişiklik yoksa null.
function scaledFlatPanelStamp(oldVf: VirtualFace, freshRawVerts: Vec3[], thickness: number): THREE.BufferGeometry | null {
  if (!oldVf.vertices || oldVf.vertices.length < 3 || freshRawVerts.length < 3) return null;
  const oldRaw = (oldVf as any).rawFaceBBox as RawBBox | undefined;
  if (!oldRaw) return null;
  const n3 = new THREE.Vector3(...oldVf.normal).normalize();
  const f = planeFrame(n3);
  const nb = freshRawBox(freshRawVerts, f);
  const nrm: Vec3 = [n3.x, n3.y, n3.z];
  if (Math.abs(oldRaw.xSpan - nb.xSpan) < 1 && Math.abs(oldRaw.ySpan - nb.ySpan) < 1) {
    const dN = nb.planeD - f.dN(oldVf.vertices[0]);
    const dU = (nb.xMin + nb.xMax) / 2 - (oldRaw.xMin + oldRaw.xMax) / 2;
    const dV = (nb.yMin + nb.yMax) / 2 - (oldRaw.yMin + oldRaw.yMax) / 2;
    if (Math.abs(dN) < 0.5 && Math.abs(dU) < 0.5 && Math.abs(dV) < 0.5) return null;
    const d = f.at(dU, dV, dN);
    return buildPrismFromVertices(oldVf.vertices.map(([x, y, z]) => [x + d[0], y + d[1], z + d[2]] as Vec3), nrm, thickness);
  }
  return buildPrismFromVertices(oldVf.vertices.map(q => { const m = remapUV(f.dU(q), f.dV(q), oldRaw, nb); return f.at(m.x, m.y, nb.planeD); }), nrm, thickness);
}

// Yüz grubu önceliği: descriptor (±5 mm) → aynı düzlemde merkeze en yakın → merkez-kutusu → en yakın; eğik yüzde dot>0.5.
function findMatchingFaceGroup(vf: VirtualFace, faces: FaceData[], faceGroups: CoplanarFaceGroup[], geometry: THREE.BufferGeometry): CoplanarFaceGroup | null {
  const vfN = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
  const vfCenter = new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]);
  const groupBox = (g: CoplanarFaceGroup) => {
    const bb = new THREE.Box3();
    g.faceIndices.forEach(fi => { const f = faces[fi]; if (f) f.vertices.forEach(vv => bb.expandByPoint(vv)); });
    return bb;
  };
  const clampDistToGroup = (g: CoplanarFaceGroup) => { const bb = groupBox(g); return vfCenter.clone().clamp(bb.min, bb.max).distanceTo(vfCenter); };
  const candidateGroups = faceGroups.filter(g => vfN.dot(g.normal.clone().normalize()) > 0.95);

  if (candidateGroups.length === 0) {
    let best: CoplanarFaceGroup | null = null, bestD = Infinity, bestDot = 0;
    for (const g of faceGroups) {
      const dot = vfN.dot(g.normal.clone().normalize());
      if (dot <= 0.5) continue;
      const d = clampDistToGroup(g);
      if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && dot > bestDot)) { bestD = d; best = g; bestDot = dot; }
    }
    return best;
  }

  if (vf.faceGroupDescriptor) {
    const matchedFace = findFaceByDescriptor(vf.faceGroupDescriptor, faces, geometry);
    const matchedGroup = matchedFace ? candidateGroups.find(g => g.faceIndices.includes(matchedFace.faceIndex)) : undefined;
    if (matchedGroup && clampDistToGroup(matchedGroup) <= 5) return matchedGroup;
  }
  if (candidateGroups.length === 1) return candidateGroups[0];

  // Aynı düzlemdeki kopuk yüzler: en iyi düzlem-ofsetine ±0.5 mm yakınlar içinden merkeze en yakın.
  const vfPlaneOffset = vfCenter.dot(vfN);
  const planeDiffOf = (g: CoplanarFaceGroup) => Math.abs(g.center.dot(g.normal.clone().normalize()) - vfPlaneOffset);
  let minPlaneDiff = Infinity;
  for (const g of candidateGroups) minPlaneDiff = Math.min(minPlaneDiff, planeDiffOf(g));
  if (minPlaneDiff < 5) {
    let best: CoplanarFaceGroup | null = null, bestD = Infinity;
    for (const g of candidateGroups.filter(g => planeDiffOf(g) <= minPlaneDiff + 0.5)) {
      const d = clampDistToGroup(g);
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best) return best;
  }

  let bestGroup: CoplanarFaceGroup | null = null, bestDist = Infinity;
  for (const g of candidateGroups) {
    if (!groupBox(g).expandByScalar(5).containsPoint(vfCenter)) continue;
    const dist = vfCenter.distanceTo(g.center);
    if (dist < bestDist) { bestDist = dist; bestGroup = g; }
  }
  if (bestGroup) return bestGroup;
  bestDist = Infinity;
  for (const g of candidateGroups) {
    const dist = vfCenter.distanceTo(g.center);
    if (dist < bestDist) { bestDist = dist; bestGroup = g; }
  }
  return bestGroup;
}

/** Panel dönmüş sayılır: rotate adımı (açıdan bağımsız) ya da VF-eğimli levha. */
function isRotatedPanel(p: any): boolean {
  const t = p?.parameters?.transformSteps;
  if (Array.isArray(t) && t.some((st: any) => st?.type === 'rotate')) return true;
  return panelIsTiltedSlab(p);
}
const hasExtrudeSteps = (p: any) => Array.isArray(p?.parameters?.extrudeSteps) && p.parameters.extrudeSteps.length > 0;
const hasMoveSteps = (p: any) => Array.isArray(p?.parameters?.transformSteps) && p.parameters.transformSteps.some((st: any) => st?.type === 'move');
const hasExtrudeTowardFace = (p: any, n: THREE.Vector3) =>
  hasExtrudeSteps(p) && p.parameters.extrudeSteps.some((st: any) => st.faceNormal && new THREE.Vector3(...st.faceNormal).normalize().dot(n) > 0.7);

type RotOp = { kind: 'rotate' | 'translate'; pivot?: THREE.Vector3; axis?: THREE.Vector3; angleRad?: number; d?: THREE.Vector3 };

function recalculateVirtualFacesForShape(shape: Shape, virtualFaces: VirtualFace[], allShapes?: any[], panelGroups?: PanelGroup[]): VirtualFace[] {
  const allShapeFaces = virtualFaces.filter(vf => vf.shapeId === shape.id);
  if (allShapeFaces.length === 0 || !shape.geometry) return virtualFaces;
  // İÇ VF'LER (raf/dikme): yüz eşlemesine girmez, grup çözücüsü yazar (aşağıda).
  const shapeFaces = allShapeFaces.filter(vf => !isInteriorVf(vf));
  const interiorMap = panelGroups
    ? recalculateInteriorVfs(shape, allShapeFaces.filter(vf => isInteriorVf(vf) && !isSheetVf(vf)), (allShapes || []) as Shape[], panelGroups)
    : new Map<string, VirtualFace>();
  for (const [id, vf] of recalculateDoorVfs(shape, allShapeFaces.filter(isDoorVf), (allShapes || []) as Shape[], useAppStore.getState().doorGroups)) interiorMap.set(id, vf);
  for (const [id, vf] of recalculateBackVfs(shape, allShapeFaces.filter(isBackVf), (allShapes || []) as Shape[], useAppStore.getState().backGroups)) interiorMap.set(id, vf);
  if (shapeFaces.length === 0) return virtualFaces.map(vf => interiorMap.get(vf.id) || vf);

  const eff = effectiveBodyGeometry(shape);
  if (eff !== shape.geometry) {
    shape = { ...shape, geometry: eff };
  }
  const { faces, groups: faceGroups } = getFacesAndGroups(shape.geometry);
  const worldToLocal = getShapeMatrix(shape).invert();
  // İç paneller (raf/dikme) de kardeştir: sırada önce geldikleri gövde panelini damgalar (yetki yalnız sıra).
  const childPanels = childPanelsOf(shape.id, (allShapes || []) as Shape[]);
  const vfById = new Map(virtualFaces.map(f => [f.id, f] as const));
  const vfIndexOf = new Map<string, number>();
  virtualFaces.forEach((f, i) => vfIndexOf.set(f.id, i));
  const panelPriority = (p: any) => vfIndexOf.get(p?.parameters?.virtualFaceId) ?? Number.MAX_SAFE_INTEGER;
  const refsCache = new Map<string, ReturnType<typeof stepRefTargets>>();
  const refsOf = (p: any) => { let r = refsCache.get(p.id); if (!r) { r = stepRefTargets(p); refsCache.set(p.id, r); } return r; };

  const matchOf = new Map<string, { group: CoplanarFaceGroup; contour: ReturnType<typeof computeFaceComponentContour> } | null>();
  const freshVfVertices = new Map<string, Vec3[]>();
  for (const vf of shapeFaces) {
    const group = findMatchingFaceGroup(vf, faces, faceGroups, shape.geometry);
    const contour = group ? computeFaceComponentContour(faces, group.faceIndices,
      new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]), group.normal.clone().normalize()) : null;
    matchOf.set(vf.id, group ? { group, contour } : null);
    if (contour && contour.corners.length >= 3) freshVfVertices.set(vf.id, contour.corners.map(c => [c.x, c.y, c.z] as Vec3));
    else if (vf.vertices && vf.vertices.length >= 3) freshVfVertices.set(vf.id, vf.vertices);
  }
  const stampBaseVertices = new Map<string, Vec3[]>();
  for (const vf of shapeFaces) {
    const base = stampBaseVertsFromVf(vf, freshVfVertices.get(vf.id));
    if (base && base.length >= 3) stampBaseVertices.set(vf.id, base);
  }

  // İŞARETLİ EXTRUDE MİKTARI (damga-trim ile birebir): + uzuyor, − kısalıyor.
  const signedExtrudeAmountOf = (p: any, step: any, eN: THREE.Vector3): number => {
    if (step.resolvedValue !== undefined && step.resolvedValue !== null) return step.resolvedValue;
    if (!step.isFixed) return step.value ?? 0;
    const vfId = p?.parameters?.virtualFaceId;
    const verts = (vfId ? stampBaseVertices.get(vfId) : undefined) || (vfId ? freshVfVertices.get(vfId) : undefined) || (vfId ? vfById.get(vfId)?.vertices : undefined);
    if (!verts || verts.length < 3) return 0;
    let mn = Infinity, mx = -Infinity;
    for (const q of verts) { const pr = q[0] * eN.x + q[1] * eN.y + q[2] * eN.z; if (pr < mn) mn = pr; if (pr > mx) mx = pr; }
    // KALINLIK YÖNÜ: VF köşeleri normal boyunca 0 açıklık verir; gerçek açıklık kalınlıktır.
    const pvf = vfId ? vfById.get(vfId) : undefined;
    const alongNormal = !!pvf && Math.abs(eN.dot(new THREE.Vector3(...pvf.normal).normalize())) > 0.7;
    return (step.value ?? 0) - (alongNormal ? panelThickness(p) : mx - mn);
  };
  const extrudeAdvancesTowardFace = (p: any, n: THREE.Vector3 | null): boolean => {
    if (!n || !hasExtrudeSteps(p)) return false;
    for (const step of p.parameters.extrudeSteps) {
      if (!step.faceNormal) continue;
      const eN = new THREE.Vector3(...step.faceNormal).normalize();
      const align = eN.dot(n);
      if (Math.abs(align) < 0.7) continue;
      if (signedExtrudeAmountOf(p, step, eN) * align > 0.01) return true;
    }
    return false;
  };

  // Taşınmış panel sırayı ancak taşıması onu bu yüze DOĞRU itiyorsa devirebilir (Δ·n > 0); paralel taşıma yetki vermez.
  const moveAdvancesTowardFace = (p: any, n: THREE.Vector3 | null): boolean => {
    if (!n || !hasMoveSteps(p)) return false;
    const rda = p.parameters?._refDeltaApplied;
    let d: THREE.Vector3;
    if (Array.isArray(rda) && rda.length === 3) d = new THREE.Vector3(rda[0], rda[1], rda[2]);
    else { try { const r = applyTransformSteps([0, 0, 0], [0, 0, 0], getUnifiedSteps(p)); d = new THREE.Vector3(...r.position); } catch { return true; } }
    return d.dot(n) > 0.01;
  };

  // ARKALIK ÇAKMA KENARI: iç arkalık parçası, çakma ilişkili kenarındaki gövde panelini sırası ne olursa olsun basar (panel
  // arkalığın ön yüzünde biter — BackService.backNailStampFor); başka hiçbir durumda kapak/arkalık damgalamaz.
  const backNailBox = new Map<string, CavityBox | null>();
  const backNailFor = (p: any, vfId: string): CavityBox | null => {
    const key = `${p.id}|${vfId}`;
    // Sıra: arkalık hedef VF'den önceyse (basan) hedef panel arkalığa kadar yerleşir.
    const myIdx = vfIndexOf.get(vfId);
    if (!backNailBox.has(key)) backNailBox.set(key, backNailStampFor(p, vfId, myIdx != null && panelPriority(p) < myIdx));
    return backNailBox.get(key) ?? null;
  };
  const stamps = (p: any, vfId: string, myPanel: any, myFaceNormal: THREE.Vector3 | null): boolean => {
    if (p.parameters?.virtualFaceId === vfId) return false;
    if (isBackPanel(p)) return !!backNailFor(p, vfId);
    if (isSheetPanel(p)) return false;
    // Raf/dikme yalnız VF sırasıyla basar (istisna yok) — PanelGroupService.groupObstacles da aynı sırayı okur.
    if (isInteriorPanel(p)) {
      const myIdx = vfIndexOf.get(vfId);
      const byOrder = myIdx != null && panelPriority(p) < myIdx;
      return byOrder;
    }
    if (myPanel && refsOf(myPanel).extrude.has(p.id)) return false;
    if (myPanel && refsOf(p).rotate.has(myPanel.id)) {
      return false;
    }
    const pIsRefBoundToMe = !!myPanel && refsOf(p).move.has(myPanel.id);
    if (myPanel && refsOf(p).extrude.has(myPanel.id) && extrudeAdvancesTowardFace(p, myFaceNormal)) return true;
    // Farklı yüzdeki taşınmış / yüze doğru extrude'lu panel sırayı devirebilir (datum hariç).
    const pVf = vfById.get(p.parameters?.virtualFaceId);
    if (pVf && myFaceNormal) {
      const sameFace = Math.abs(myFaceNormal.dot(new THREE.Vector3(...pVf.normal).normalize())) > 0.95;
      if (!sameFace && ((hasMoveSteps(p) && !pIsRefBoundToMe && moveAdvancesTowardFace(p, myFaceNormal)) || extrudeAdvancesTowardFace(p, myFaceNormal))) return true;
    }
    const myIdx = vfIndexOf.get(vfId);
    const byOrder = myIdx != null && panelPriority(p) < myIdx;
    return byOrder;
  };

  // DAMGA: extrude'lu → VF tabanı ya da budanmış taban + adım ops'u; düz → oransal damga ya da gerçek mesh;
  // dönmüş → motorun NİHAİ geometrisi (ops'suz). Extrude'suz panelde hedef yüzden bağımsız → panel başına önbellek.
  const stampCache = new Map<string, any>();
  const stampOf = (p: any, myFaceNormal: THREE.Vector3 | null, vfId?: string): any => {
    // Arkalık damgası = baskı kutusu (parça levhası, çakma kenarda panelin dış yüzünün ötesine uzatılmış), hedef VF'ye göre.
    if (isBackPanel(p) && vfId) {
      const box = backNailFor(p, vfId);
      if (!box) return p;
      const key = `${p.id}|back|${vfId}`;
      if (!stampCache.has(key)) {
        const sz = [0, 1, 2].map(a => Math.max(0.01, box.max[a] - box.min[a]));
        const geo = new THREE.BoxGeometry(sz[0], sz[1], sz[2]).translate((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
        stampCache.set(key, { ...p, geometry: geo });
      }
      return stampCache.get(key);
    }
    const key = hasExtrudeSteps(p) ? `${p.id}|${myFaceNormal ? `${myFaceNormal.x},${myFaceNormal.y},${myFaceNormal.z}` : '-'}` : p.id;
    if (stampCache.has(key)) return stampCache.get(key);
    const r = buildStamp(p, myFaceNormal);
    stampCache.set(key, r);
    return r;
  };
  const buildStamp = (p: any, myFaceNormal: THREE.Vector3 | null): any => {
    // İç panel (düz): damga bu geçişte çözülen grup VF'sinden — store mesh'i bir rebuild geride olabilir.
    if (isInteriorPanel(p) && !isRotatedPanel(p)) {
      const ivf = interiorMap.get(p.parameters?.virtualFaceId) || vfById.get(p.parameters?.virtualFaceId);
      let geo: THREE.BufferGeometry | null = null;
      if (ivf?.vertices && ivf.vertices.length >= 3) {
        // Extrude'lu üye: damga gerçek kalınlık/uzunlukla (100 mm'ye extrude'lu raf gövdede 18 mm görünmesin).
        if (hasExtrudeSteps(p) && myFaceNormal) geo = trimmedStampGeometryFromVf(ivf, panelThickness(p), p.parameters.extrudeSteps, myFaceNormal);
        if (!geo) geo = buildPrismFromVertices(ivf.vertices, ivf.normal, panelThickness(p));
      }
      return geo ? { ...p, geometry: geo } : p;
    }
    const ownVfRaw = vfById.get(p.parameters?.virtualFaceId);
    const ownVfFreshVerts = freshVfVertices.get(p.parameters?.virtualFaceId);
    const ownVf = ownVfRaw && ownVfFreshVerts ? { ...ownVfRaw, vertices: ownVfFreshVerts } : ownVfRaw;
    const ownVfStampVerts = ownVfRaw ? (stampBaseVertices.get(ownVfRaw.id) || ownVfFreshVerts) : undefined;
    const ownVfStamp = ownVfRaw && ownVfStampVerts ? { ...ownVfRaw, vertices: ownVfStampVerts } : ownVfRaw;
    // REF taşıma deltası motorun GERÇEKTEN uyguladığı _refDeltaApplied'dan okunur — tek kaynak.
    const composedFromSteps = (stampGeo?: THREE.BufferGeometry | null): RotOp[] | undefined => {
      if (!ownVf) return undefined;
      try {
        // Taze ham kontur; bayat rawFaceBBox fixed telafisine karışmasın.
        const { ops } = composeSteps(getUnifiedSteps(p), { ...(ownVf as any), rawFaceBBox: undefined });
        const rda = p.parameters?._refDeltaApplied;
        const refDeltaApplied = Array.isArray(rda) && rda.length === 3 ? new THREE.Vector3(rda[0], rda[1], rda[2]) : null;
        const rpBox = worldBboxOf(p, stampGeo || undefined);
        return ops.map((o: any) =>
          o.kind === 'rotate' ? { kind: 'rotate', pivot: o.pivot, axis: o.axis, angleRad: (o.deg * Math.PI) / 180 }
            : o.kind === 'refTranslate' ? { kind: 'translate', d: refDeltaApplied || (rpBox ? resolveRefTranslateDelta(o, rpBox) : o.fallback) }
              : { kind: 'translate', d: o.d });
      } catch { return undefined; }
    };

    if (hasExtrudeSteps(p) && ownVfStamp) {
      const th = panelThickness(p);
      if (myFaceNormal && hasExtrudeTowardFace(p, myFaceNormal) && extrudeAdvancesTowardFace(p, myFaceNormal)) {
        const baseGeo = ownVfStamp.vertices?.length >= 3 ? buildPrismFromVertices(ownVfStamp.vertices, ownVfStamp.normal, th) : null;
        if (baseGeo) return { ...p, geometry: baseGeo, __isRotatedPanel: true, __composedOps: composedFromSteps(baseGeo) || [] };
      } else if (myFaceNormal) {
        const trimGeo = trimmedStampGeometryFromVf(ownVfStamp, th, p.parameters.extrudeSteps, myFaceNormal);
        if (trimGeo) return { ...p, geometry: trimGeo, __isRotatedPanel: true, __composedOps: composedFromSteps(trimGeo) || [] };
      }
    }
    if (!isRotatedPanel(p)) {
      if (ownVfRaw && ownVfFreshVerts) {
        const scaled = scaledFlatPanelStamp(ownVfRaw, ownVfFreshVerts, panelThickness(p));
        if (scaled) {
          // Taşınmış düz panel: damga çözülmüş ÖTELEME kadar kaydırılır (dönmüş yola sokulmaz).
          if (hasMoveSteps(p)) {
            const ops = composedFromSteps(scaled);
            if (Array.isArray(ops) && ops.length > 0) {
              const d = new THREE.Vector3();
              for (const op of ops) if (op?.kind === 'translate' && op.d) d.add(op.d);
              if (d.lengthSq() > 1e-12) scaled.translate(d.x, d.y, d.z);
            }
          }
          return { ...p, geometry: scaled };
        }
      }
      return p;
    }
    // Dönmüş panel: store geometrisi ZATEN dönmüş/sığdırılmış → ops'suz gerçek geometri.
    return { ...p, __isRotatedPanel: true, __rotatedRealGeom: true, __composedOps: [] };
  };

  const stampingPanelsFor = (vfId: string): any[] => {
    const myPanel = childPanels.find(p => p.parameters?.virtualFaceId === vfId);
    const myVf = vfById.get(vfId);
    const myFaceNormal = myVf ? new THREE.Vector3(...myVf.normal).normalize() : null;
    return childPanels.filter(p => stamps(p, vfId, myPanel, myFaceNormal)).map(p => stampOf(p, myFaceNormal, vfId));
  };

  const updatedMap = new Map<string, VirtualFace>();
  for (const vf of shapeFaces) {
    const m = matchOf.get(vf.id);
    const regen = m && m.contour ? regenerateParentFaceShapeVF(vf, shape.id, m.group, m.contour, worldToLocal, stampingPanelsFor(vf.id)) : null;
    updatedMap.set(vf.id, regen || vf);
  }
  return virtualFaces.map(vf => updatedMap.get(vf.id) || interiorMap.get(vf.id) || vf);
}

// VF = yüz konturu ∩ serbest bölge; seed MUTLAK (güncel düzleme izdüşer); sideRelations STORED-WINS → panel ilk tarafında kalır.
function regenerateParentFaceShapeVF(
  vf: VirtualFace, shapeId: string, matchedGroup: CoplanarFaceGroup,
  contour: NonNullable<ReturnType<typeof computeFaceComponentContour>>,
  worldToLocal: THREE.Matrix4, siblingPanels: any[],
): VirtualFace {
  const localNormal = matchedGroup.normal.clone().normalize();
  const seed = new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]);
  const { u, v } = getFacePlaneAxes(localNormal);
  const uvOf = (p3: THREE.Vector3) => ({ x: p3.dot(u), y: p3.dot(v) });
  const to3D = (q: { x: number; y: number }) => new THREE.Vector3().addScaledVector(u, q.x).addScaledVector(v, q.y).addScaledVector(localNormal, planeN);
  const newB = uvBox(contour.corners.map(uvOf));
  const cUV = uvOf(seed);
  const planeN = contour.corners[0].dot(localNormal);
  const newCenter = to3D({ x: Math.max(newB.xMin, Math.min(newB.xMax, cUV.x)), y: Math.max(newB.yMin, Math.min(newB.yMax, cUV.y)) });

  const storedRel = (vf as any).sideRelations as Record<string, number> | undefined;
  const prevRegion = vf.vertices && vf.vertices.length >= 3 ? vf.vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z)) : undefined;
  const region = computeFreeRegionLocal(contour.corners, localNormal, seed, siblingPanels, worldToLocal, shapeId, prevRegion, storedRel, !!vf.fitFaceShape);

  const cornersOut = region && region.polygon.length >= 3 ? region.polygon.map(to3D) : contour.corners;

  const out: any = {
    ...vf,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    vertices: cornersOut.map(c => [c.x, c.y, c.z] as Vec3),
    center: [newCenter.x, newCenter.y, newCenter.z],
  };
  out.rawFaceBBox = { ...newB };
  out.sideRelations = { ...(region?.sideRelations || {}), ...(storedRel || {}) };
  if (region?.anchor) { const a = to3D(region.anchor); out.regionAnchor = [a.x, a.y, a.z]; }
  return out;
}
