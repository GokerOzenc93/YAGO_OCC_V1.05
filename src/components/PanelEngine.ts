import * as THREE from 'three';
import {
  type CavityBox, type PanelGroup, type PanelHole, type RailExt, type RailExtTarget, type Shape, type VirtualFace, childPanelsOf, panelOfVf,
  engineLoad, entryGate, shapeById, useAppStore, vfOfPanel,
} from '../store';
import {
  type AxisLetter, type ExtrudeStep, type RotateTransformStep, type TransformStep, applyExtrudeSteps, mapAxisToVfLocal, applyTransformSteps, getUnifiedSteps, matchReferenceFace, resolveReferenceFacePlane, stepRefTargets,
  applySketchFeatures, liveSketchFeatures, postExtrudeStepsOf, sketchFeaturesKey, sketchVarsOf,
} from './Geometry';
import {
  type RotOp, applyRailExt, clipRegionToRailStrip, railLandingOnBody, computeFaceComponentContour, computeFreeRegionLocal, convexHull2D,
  footprintGeometry, panelBehindStackPlane, largestFaceNormal, panelHasRotation, panelInnerBigFace, panelIsTiltedSlab, toUV,
} from './Geometry';
import {
  type BrepTriInfo, type CoplanarFaceGroup, type FaceData, type Vec3, initReplicad, isShapedBody, matchCurvedFaceGroup, overlapVolumeByCut, surfaceKeyOf,
  angleToTouchPlane, assertBounds, axisDirToVec, axisIndexOf, boundsOverlapBox, convertReplicadToThreeGeometry,
  createPanelFromVirtualFace, createReplicadBox, createReplicadBoxAt, cutWithTools, deepCopyShape, dot3, errMsg, findFaceByDescriptor,
  fromPlaneUV, getFacePlaneAxes, getFacesAndGroups, getShapeMatrix, halfSpaceSlab, isFlatNormal, localBboxOf, normDeg, panelThickness,
  pointFromFracBox, projRange, resolveVfFracPoint, rotateAboutAxis, round1, round3, spanAlong, toVector3, uniqueMeshPoints, uniquePoints, vec3,
  vfRawMinAlong, worldBboxOf,
} from './Geometry';
import { isInteriorPanel, isInteriorVf, makeInsideMeshTest, recalculateInteriorVfs, syncPanelGroups } from './PanelGroupService';
import { edgeGapsOf, isDoorPanel, isDoorVf, recalculateDoorVfs, syncDoorGroups } from './DoorService';
import { backGrooveCuttersFor, backNailStampFor, backStackAt, isBackPanel, isBackVf, recalculateBackVfs, syncBackGroups } from './BackService';
import { isPlinthVf, plinthBoxOf, plinthHoleCuttersFor, plinthLegBoxes, plinthSetsOf } from './PlinthService';
import { type HoleCutter, holeCutterBox, panelHoleRecord } from './AccessoryService';
import { type ConnSolidCut, type ConnUnitCut, connectorCutSig, connectorCutsFor, holeSpec, panelNameOf, unitSpec } from './ConnectorService';
import {
  type CutBox, type OccShape, type ToolSpec, type UnitCache, cutBySpecs, cutInWorker, cutWorkerReady, geometryFromMeshData, shapeFromBytes, shapeToBytes,
} from './CutWorker';

// Kapak / arkalık levhaları köşe birleşimine girmez, gövdeyle kesilmez, damgalamaz — istisna: arkalığın iç parçası çakma kenarındaki
// ve sırada sonra gelen gövde panelini basar (backNailStampFor).
const isSheetPanel = (p: any): boolean => isDoorPanel(p) || isBackPanel(p);
const isSheetVf = (vf: any): boolean => isDoorVf(vf) || isBackVf(vf) || isPlinthVf(vf);

// PANEL MOTORU: (A) rebuildPanelsForParent — paneller her rebuild'de spec'ten (VF + adımlar) sıfırdan; (B) VF bölge yeniden hesabı.
// Basan / basılan = virtualFaces sırası. Hat: VF çokgeni → adımlar → dönmüş: büyüt & sığdır → extrude → basan kesimi → ref-dönüş pahı.

type UpdateShape = (id: string, u: Partial<Shape>) => void;
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
  const currentSpan = spanAlong(vf.vertices, axisIndexOf(step.axis));
  if (currentSpan < 1) return original;
  const ratio = currentSpan / span0;
  return Math.abs(ratio - 1) < 0.001 ? original : original * ratio;
}

function resolveReferenceFacePolygon(
  targetId: string, faceGroupIndex: number, normalWorld?: Vec3, pointWorld?: Vec3
): { normal: THREE.Vector3; center: THREE.Vector3; vertices: THREE.Vector3[] } | null {
  const m = matchReferenceFace(shapeById(targetId), faceGroupIndex, normalWorld, pointWorld);
  if (!m) return null;
  const world = m.group.faceIndices.flatMap(fi => m.faces[fi]?.vertices.map(v => v.clone().applyMatrix4(m.matrix)) ?? []);
  return {
    normal: m.group.normal.clone().normalize().transformDirection(m.matrix).normalize(),
    center: m.group.center.clone().applyMatrix4(m.matrix),
    vertices: uniquePoints(world),
  };
}

function pointInFacePolygon(pt: THREE.Vector3, normal: THREE.Vector3, verts: THREE.Vector3[], tol = 0.5): boolean {
  const { u, v } = getFacePlaneAxes(normal);
  const hull = convexHull2D(verts.map(q => toUV(q, u, v)));
  if (hull.length < 3) return false;
  const p = toUV(pt, u, v);
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
    const faceGi = st.refTargetFaceGroupIndex ?? -1;
    const plane = resolveReferenceFacePlane(st.refTargetPanelId, faceGi, useAppStore.getState().shapes, st.refTargetFaceNormal, st.refTargetFacePoint);
    if (!plane) return { deg: frozen };
    const planePointWorld = plane.center.clone().add(toVector3(target.position));
    const armWorld = armPoint.clone().sub(pivot).applyQuaternion(frame).add(pivot);
    const sol = angleToTouchPlane(pivot, armWorld, axisWorld, plane.normal, planePointWorld, frozen);
    if (!sol) return { deg: frozen };

    // (a) Nişan ref çokgeninde → 'arm'; çokgen yoksa düzlem açısı (ulaşılamıyorsa en yakın yaklaşma).
    const poly = resolveReferenceFacePolygon(st.refTargetPanelId, faceGi, st.refTargetFaceNormal, st.refTargetFacePoint);
    const armAt = rotateAboutAxis(armWorld, pivot, axisWorld, sol.deg);
    const armInside = !!poly && sol.touched && pointInFacePolygon(armAt, poly.normal, poly.vertices, 0.5);
    if (armInside || !poly) return { deg: round3(sol.deg), contact: 'arm' };

    // (b) Dış ya da iç (−kalınlık) yüzeyden (a) açısında ref normaline ZIT bakan seçilir; ofset pivotun VF konumuyla düzeltilir.
    const n0 = vfNormal(vf);
    const n1 = n0.clone().applyQuaternion(frame).normalize();
    const nOff = vf.vertices.length ? dot3(vf.vertices[0], n0) : 0;
    const dP = n0.dot(pivot) - nOff;
    const thick = panelThickness(panelOfVf(vf.id));
    const mOuterAtA = rotateAboutAxis(n1.clone().add(pivot), pivot, axisWorld, sol.deg).sub(pivot).normalize();
    const useInner = mOuterAtA.dot(poly.normal) > 0;
    const k = (useInner ? -thick : 0) - dP;
    const sign = Math.sign(sol.deg) || (frozen ? Math.sign(frozen) : 0);
    const rest = angleToRestOnPolygon(pivot, axisWorld, n1, k, poly.vertices, sign);
    // Oturma çözülemezse düzlem açısı.
    return rest ? { deg: round3(rest.deg), contact: 'rest' } : { deg: round3(sol.deg) };
  } catch { return { deg: frozen }; }
}

export type StepOp =
  | { kind: 'translate'; d: THREE.Vector3 }
  | { kind: 'refTranslate'; targetPanelId: string; sourceFrac?: Vec3; targetFrac?: Vec3; fallback: THREE.Vector3; stepId?: string; sourcePoint?: Vec3 }
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
      const frozenD = () => toVector3(st._refAxisVec).multiplyScalar(st._refDist);
      if (st.refTargetPanelId && (st.refSourceFrac || st.refTargetFrac || hasFrozen)) {
        ops.push({ kind: 'refTranslate', targetPanelId: st.refTargetPanelId, sourceFrac: st.refSourceFrac, targetFrac: st.refTargetFrac,
          fallback: hasFrozen ? frozenD() : new THREE.Vector3(0, 0, 0), stepId: st.id, sourcePoint: st.refSourcePoint });
      } else if (hasFrozen) {
        ops.push({ kind: 'translate', d: frozenD() });
      } else {
        const base = axisDirToVec(st.axis);
        const value = resolveScaledMoveValue(st, vf);
        const d = base.clone().applyQuaternion(frame).multiplyScalar(value);
        // FIXED MUTLAK KONUM: yalnız dönüşsüz çerçevede yüz kayması telafi edilir.
        if (st.isFixed && typeof st.fixedRef === 'number' && Math.abs(frame.w) > 0.999999) {
          const cur = vfRawMinAlong(vf, st.axis);
          const shift = cur !== null ? st.fixedRef - cur : 0;
          if (Math.abs(shift) > 0.01) d.addScaledVector(new THREE.Vector3(Math.abs(base.x), Math.abs(base.y), Math.abs(base.z)), shift);
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

/** Panelin döndürme adımlarının bileşik dönüşü — çizim adımının yüz yönleri bu dönüş GERİ ALINARAK saklanır (Geometry.sketchFrameOf q). */
export function panelStepRotation(panel: Shape, vfs: VirtualFace[] = useAppStore.getState().virtualFaces): THREE.Quaternion {
  const vf = vfOfPanel(panel, vfs);
  if (!vf) return new THREE.Quaternion();
  try { return composeSteps(getUnifiedSteps(panel), vf).quat.clone(); } catch { return new THREE.Quaternion(); }
}

export function resolveRefTranslateDelta(op: any, rpWorldBox: THREE.Box3): THREE.Vector3 {
  if (!op.sourceFrac || !op.targetFrac) return op.fallback.clone();
  const target = shapeById(op.targetPanelId);
  const tgtBox = target?.geometry ? worldBboxOf(target, target.geometry) : null;
  if (!tgtBox) return op.fallback.clone();   // hedef geometri yok → donmuş delta
  return pointFromFracBox(tgtBox, op.targetFrac).sub(pointFromFracBox(rpWorldBox, op.sourceFrac));
}

// İÇ KÖŞE: dik iki adımsız panelin köşesindeki t1×t2 boşluğu, SIRADA ÖNCE olan sonrakinin kalınlığı kadar uzayıp kapatır.
const CORNER_TOL = 1.0;

const hasExtrudeSteps = (p: any) => Array.isArray(p?.parameters?.extrudeSteps) && p.parameters.extrudeSteps.length > 0;
const hasMoveSteps = (p: any) => Array.isArray(p?.parameters?.transformSteps) && p.parameters.transformSteps.some((st: any) => st?.type === 'move');
const hasAnySteps = (p: any) => (Array.isArray(p?.parameters?.transformSteps) && p.parameters.transformSteps.length > 0) || hasExtrudeSteps(p);

const vRange = (verts: Vec3[], dir: THREE.Vector3) => projRange(verts.map(toVector3), dir);

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
  const pEdge = vfP.vertices.filter(c => Math.abs(dot3(c, nQ) - dQ) <= CORNER_TOL);
  const qEdge = vfQ.vertices.filter(c => Math.abs(dot3(c, nP) - dP) <= CORNER_TOL);
  if (pEdge.length < 2 || qEdge.length < 2) return null;
  const pe = vRange(pEdge, e), qe = vRange(qEdge, e);
  if (pe.max - pe.min < 1) return null;
  if (qe.min > pe.min + 2 || qe.max < pe.max - 2) return null;
  return { nQ, dQ, tQ };
}

function cornerJoinedVertices(panel: Shape, vf: VirtualFace, vfs: VirtualFace[], siblings: Shape[], orderOf: (s: Shape) => number): Vec3[] {
  let verts = vf.vertices.map(c => [c[0], c[1], c[2]] as Vec3);
  // İç panel (raf/dikme) ve kapak/arkalık köşe birleşimine girmez.
  if (hasAnySteps(panel) || isInteriorPanel(panel) || isSheetPanel(panel) || vf.curved) return verts;
  const myOrder = orderOf(panel);
  for (const q of siblings) {
    if (q.id === panel.id || orderOf(q) <= myOrder || hasAnySteps(q) || isInteriorPanel(q) || isSheetPanel(q)) continue;
    const vfQ = vfOfPanel(q, vfs);
    if (!vfQ || vfQ.curved) continue;
    const j = concaveCornerJoin(vf, vfQ, panelThickness(q));
    if (!j) continue;
    verts = verts.map(c => (Math.abs(dot3(c, j.nQ) - j.dQ) > CORNER_TOL ? c
      : [c[0] - j.nQ.x * j.tQ, c[1] - j.nQ.y * j.tQ, c[2] - j.nQ.z * j.tQ] as Vec3));
  }
  return verts;
}

// Geometrik iç içe geçme koruması: son katı sırada önce üretilen kardeşlerle gerçekten çakışıyorsa (> 1 mm³) çıkarılır.
// Yalnız düz, adımsız gövde / iç panellerde; kesim paneli yok ederse özgün katı kalır.
const _overlapBox = (shape: any): { min: number[]; max: number[] } | null => {
  try { const b = shape.boundingBox.bounds; return { min: [b[0][0], b[0][1], b[0][2]], max: [b[1][0], b[1][1], b[1][2]] }; } catch { return null; }
};
// Sağlam boolean: OCC eş-yüzeyli çiftte Cut / Common'u sessizce boş çevirebiliyor (hata yok, katı aynen). Biçimlenmiş gövdede sıra
// yalnız katı kesimine dayandığından bu iç içe / dışarı taşan panel demek → sonuç mesh'ten sınanır, bulanık Cut ve Common ile yeniden denenir.
const _insideTests = new WeakMap<THREE.BufferGeometry, (p: Vec3) => boolean>();
const insideTestOf = (geo: THREE.BufferGeometry) => {
  let t = _insideTests.get(geo);
  if (!t) { t = makeInsideMeshTest(geo); _insideTests.set(geo, t); }
  return t;
};
/** Katının İÇ örnekleri: her üçgenin merkezinden `depth` mm içeride (yüzeyde paylaşılan / faset payındaki nokta örnek olmaz). */
function interiorProbes(geo: THREE.BufferGeometry, depth = 1): Vec3[] {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute, idx = geo.getIndex();
  const n = idx ? idx.count : pos.count, self = insideTestOf(geo), out: Vec3[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nn = new THREE.Vector3(), cen = new THREE.Vector3();
  for (let t = 0; t + 2 < n; t += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(t) : t); b.fromBufferAttribute(pos, idx ? idx.getX(t + 1) : t + 1); c.fromBufferAttribute(pos, idx ? idx.getX(t + 2) : t + 2);
    nn.crossVectors(b.clone().sub(a), c.clone().sub(a));
    const area2 = nn.length();
    if (area2 < 8) continue;
    nn.divideScalar(area2); cen.copy(a).add(b).add(c).divideScalar(3);
    for (const sgn of [-1, 1]) {
      const q: Vec3 = [cen.x + nn.x * depth * sgn, cen.y + nn.y * depth * sgn, cen.z + nn.z * depth * sgn];
      if (self(q)) { out.push(q); break; }
    }
  }
  return out;
}
/** `a` katısının iç örneklerinden kaçı `bGeo` katısının içinde (mesh; boolean'sız). */
function probesInside(aGeo: THREE.BufferGeometry, bGeo: THREE.BufferGeometry): { inside: number; total: number } {
  const bb = localBboxOf(bGeo), test = insideTestOf(bGeo), probes = interiorProbes(aGeo);
  let inside = 0;
  if (bb) for (const q of probes) if (q[0] > bb.min.x && q[0] < bb.max.x && q[1] > bb.min.y && q[1] < bb.max.y && q[2] > bb.min.z && q[2] < bb.max.z && test(q)) inside++;
  return { inside, total: probes.length };
}
const volOf = (measureVolume: (s: any) => number, x: any): number => { try { return measureVolume(x); } catch { return NaN; } };
/** Katının "kiri": en büyük köşe / kenar / yüz toleransı (mm); sıfır alanlı (dejenere) yüzü varsa 1000 eklenir. ≤ CLEAN_TOL → temiz. */
const CLEAN_TOL = 0.05;
function shapeDirt(x: any, measureArea: (f: any) => number): number {
  const oc = (window as any).__ocInstance;
  let a: any = null, tol = 0;
  try { a = new oc.ShapeAnalysis_ShapeTolerance(); tol = a.Tolerance(x.wrapped, 1, oc.TopAbs_ShapeEnum.TopAbs_SHAPE) as number; }
  catch { tol = 0; }
  finally { try { a?.delete(); } catch { /* bırakılmış */ } }
  let degenerate = false;
  try { for (const f of x.faces as any[]) if (!(measureArea(f) > 0.01)) { degenerate = true; break; } } catch { degenerate = true; }
  return tol + (degenerate ? 1000 : 0);
}
/** out − tool, doğrulamalı: hacim azaldıysa kabul; azalmadıysa ve katılar mesh'ten örtüşüyorsa bulanık Cut (1e-3, 1e-2) ve
 *  out − (out ∩ tool) denenir. */
async function robustCut(out: any, tool: any, toolGeo: THREE.BufferGeometry | null, label: string): Promise<{ rp: any; removed: number }> {
  const { measureVolume } = await import('replicad');
  const v0 = volOf(measureVolume, out);
  // Kabul: hacim azalmış VE sonuç `out`un kutusunu aşmıyor (bozuk girdide Cut, aracın yüzlerini sonuca çöp olarak katabiliyor).
  // Pay 10 mm: OCC kutusu eğri yüzde sıkı değildir (kesilmiş silindirde ~1 mm taşar); çöp sonuç aracın tüm kutusu kadar taşar.
  const b0 = _overlapBox(out);
  const accept = (x: any): number => {
    try { assertBounds(x); } catch { return NaN; }
    const b = _overlapBox(x);
    if (b0 && b && [0, 1, 2].some(k => b.min[k] < b0.min[k] - 10 || b.max[k] > b0.max[k] + 10)) return NaN;
    const v = volOf(measureVolume, x);
    return v > 1 && v < v0 - 1 ? v : NaN;
  };
  // Her deneme derin kopyalarla (başarısız boolean girdilerin toleransını kirletir; saklanan kardeş katısı da bozulmasın).
  const O = () => deepCopyShape(out), T = () => deepCopyShape(tool);
  let cut: any = null, v = NaN;
  try { cut = O().cut(T()); v = accept(cut); } catch { cut = null; }
  if (Number.isFinite(v)) return { rp: cut, removed: v0 - v };
  // Değişmedi: gerçekten örtüşmüyorsa yapılacak iş yok.
  let overlap = false;
  try { const og = convertReplicadToThreeGeometry(out); overlap = probesInside(og, toolGeo ?? convertReplicadToThreeGeometry(tool)).inside >= 2; og.dispose(); } catch { overlap = false; }
  if (!overlap) return { rp: out, removed: 0 };
  for (const fuzzy of [1e-3, 1e-2]) {
    try { cut = await cutWithTools(O(), [T()], false, fuzzy); v = accept(cut); } catch { v = NaN; }
    if (Number.isFinite(v)) return { rp: cut, removed: v0 - v };
  }
  try { const o = O(), common = o.clone().intersect(T()); assertBounds(common); cut = o.clone().cut(common); v = accept(cut); } catch { v = NaN; }
  if (Number.isFinite(v)) return { rp: cut, removed: v0 - v };
  // Ters yönden: örtüşme ARACIN tarafından kurulur (tool − (tool − out)). Gövde kesişimi `out`ta sıfır alanlı yüz bırakmışsa (kenarı
  // gövdenin eğri yüzeyine değen panel) out − tool ve out ∩ tool sessizce boş kalır; aynı örtüşme aracın tarafından doğru çıkar.
  try { const t = T(), ov = t.clone().cut(t.clone().cut(O())); assertBounds(ov); cut = O().cut(ov); v = accept(cut); } catch { v = NaN; }
  if (Number.isFinite(v)) return { rp: cut, removed: v0 - v };
  console.warn('[YAGO][MOTOR] kesim kurulamadı (paneller iç içe kalabilir):', label);
  return { rp: out, removed: 0 };
}
const _curvedCutCache = new Map<string, any>();
const _bodyClipCache = new WeakMap<THREE.BufferGeometry, Map<string, any>>();
export async function cutByEarlierOverlaps(rp: any, panel: Shape, earlier: Shape[]): Promise<any> {
  if (!earlier.length) return rp;
  const mine = _overlapBox(rp);
  if (!mine) return rp;
  let measureVolume: ((s: any) => number) | null = null;
  let out = rp;
  for (const e of earlier) {
    const es0 = (e as any).replicadShape;
    if (!es0) continue;
    const es = deepCopyShape(es0);   // saklanan kardeş katısı kesimde kirlenmesin
    const eb = _overlapBox(es);
    if (!eb) continue;
    // Kutu kesişimi her eksende > 0.5 mm değilse çakışma yok (temas / kenar paylaşımı)
    if ([0, 1, 2].some(k => Math.min(mine.max[k], eb.max[k]) - Math.max(mine.min[k], eb.min[k]) < 0.5)) continue;
    try {
      if (!measureVolume) measureVolume = (await import('replicad')).measureVolume;
      const { measureShapeVolumeProperties } = await import('replicad');
      if (isCurvedPanel(e)) {
        // Eğri panelle tek kesim, hacim azaldıysa kabul. Sonuç iki katının imzasıyla saklanır (elips panelde kesim ≈ 2,5 s).
        const v0 = measureVolume(out);
        // İmza: hacim + kutu + AĞIRLIK MERKEZİ (ayna simetriği katıların hacmi ve kutusu aynıdır — merkezsiz imza yanlış katıyı döndürüyordu).
        const sig = (x: any) => {
          const pr = measureShapeVolumeProperties(x), c = pr.centerOfMass;
          return `${pr.volume.toFixed(2)}|${c.map((n: number) => n.toFixed(3)).join(',')}|${(x.boundingBox.bounds as number[][]).flat().map(n => n.toFixed(2)).join(',')}`;
        };
        const key = `${sig(out)}#${sig(es)}`;
        let cut: any = null;
        const hit = _curvedCutCache.get(key);
        if (hit) { try { cut = deepCopyShape(hit); } catch { _curvedCutCache.delete(key); } }
        if (!cut) {
          cut = (await robustCut(out, es, (e as any).geometry ?? null, `${panel.id} − ${e.id}`)).rp;
          if (_curvedCutCache.size > 24) _curvedCutCache.delete(_curvedCutCache.keys().next().value as string);
          _curvedCutCache.set(key, deepCopyShape(cut));
        }
        const cv = measureVolume(cut);
        if (cv < 1) console.warn('[YAGO][MOTOR] panel tamamen önceki panelin içinde — kesilmedi:', panel.id, '⊂', e.id);
        else if (v0 - cv >= 1) out = cut;
        continue;
      }
      let vol = 0; try { vol = measureVolume(out.intersect(es)); } catch { vol = 0; }
      // Kutular gerçekten örtüşüyorken "kesişim boş" sonucu Common'un yanılgısı olabilir → kesmeyle doğrulanır (Geometry.overlapVolumeByCut).
      if (vol < 1) vol = await overlapVolumeByCut(out, es);
      if (vol < 1) continue;
      const cut = out.cut(es);
      const cv = measureVolume(cut);
      if (cv < 1) { console.warn('[YAGO][MOTOR] panel tamamen önceki panelin içinde — kesilmedi:', panel.id, '⊂', e.id); continue; }
      out = cut;
    } catch (err) {
      console.warn('[YAGO][MOTOR] iç içe geçme kesimi başarısız:', panel.id, e.id, errMsg(err));
    }
  }
  return out;
}

// DÖNÜŞ-KESİMİ: dönmüş/eğik BASAN, basılanı kendine bakan yüzünün yarım-uzayıyla keser (siluet prizmasıyla sınırlı).

/** Eğri gövde yüzüne oturan panel (VF.curved; motor panele `parameters.curved` yazar — damga / ayak izi tarafı onu okur). */
const isCurvedPanel = (p: any): boolean => !!p?.parameters?.curved;

function vfIsTilted(vf: VirtualFace | undefined | null): boolean {
  if (!vf?.normal) return false;
  return !isFlatNormal(vfNormal(vf));
}

/** Gövde yüzünü izleyen panel komşunun bölgesini damgalar mı? Eğri panel ve biçimlenmiş gövdenin eğik yüzündeki taşınmamış panel
 *  damgalamaz: sonsuz yarım-düzlem komşuyu izin ötesinde de kırpıyordu. Komşu yüz kenarına kadar çözülür, ikisi katı düzeyinde kesişir. */
export function panelStampsRegions(p: any, parent: Shape | undefined | null, vfs: VirtualFace[] = useAppStore.getState().virtualFaces): boolean {
  if (isCurvedPanel(p)) return false;
  if (!parent || !bodyIsShaped(parent) || hasAnySteps(p) || isInteriorPanel(p) || isSheetPanel(p)) return true;
  return !vfIsTilted(vfs.find(f => f.id === p?.parameters?.virtualFaceId));
}

function rotatedNormalOf(panel: Shape, vf: VirtualFace): THREE.Vector3 | null {
  try {
    return vfNormal(vf).applyQuaternion(composeSteps(getUnifiedSteps(panel), vf).quat).normalize();
  } catch { return null; }
}

async function cutByRotatedPressers(
  rp: any, panel: Shape, vfS: VirtualFace, siblings: Shape[], vfs: VirtualFace[], orderOf: (s: Shape) => number,
): Promise<any> {
  const myOrder = orderOf(panel);
  const nS = vfNormal(vfS);
  const dS = vfS.vertices.length ? dot3(vfS.vertices[0], nS) : 0;
  // TARAF: bölge çapası (serbest hücre) — dik açılarda merkez/seed yanlış tarafa düşebilir.
  const anchor = (vfS as any).regionAnchor as Vec3 | undefined;
  const ref = anchor ? new THREE.Vector3(...anchor) : (() => {
    const c = new THREE.Vector3();
    for (const q of vfS.vertices) c.add(toVector3(q));
    return c.divideScalar(Math.max(vfS.vertices.length, 1));
  })();
  const thS = panelThickness(panel);
  // Basılan katının kendi normali boyunca kapladığı aralık: basan bu aralığa hiç girmiyorsa (rafın çok altında biten eğik yan) kesemez —
  // yoksa basanın SONSUZ yüz düzlemi, siluetinin hizasındaki her paneli (panelin bittiği yerin ötesinde de) kırpıyordu.
  let sMin = -Infinity, sMax = Infinity;
  try {
    const bb = rp.boundingBox.bounds as number[][];
    const r = projRange([0, 1, 2, 3, 4, 5, 6, 7].map(i => new THREE.Vector3(bb[i & 1][0], bb[(i >> 1) & 1][1], bb[(i >> 2) & 1][2])), nS);
    sMin = r.min; sMax = r.max;
  } catch { /* kutu okunamadı → aralık sınanmaz */ }
  let out = rp;
  for (const r of siblings) {
    // Sıra tek yetkidir — dönmüş raf/dikme de sırada sonraki gövde panelini biçer.
    if (r.id === panel.id || orderOf(r) >= myOrder) continue;
    // Kapak/arkalık hiçbir gövde panelini kesmez; eğik VF'li levha dönmüş basan sayılmaz.
    if (isSheetPanel(r)) continue;
    if (!panelHasRotation(r) && !vfIsTilted(vfOfPanel(r, vfs))) continue;
    // Eğri yüz paneli düzlemsel basan değildir: yarım-uzayı yoktur, sırada sonraki panel onun KATISIYLA kesilir.
    if (isCurvedPanel(r)) continue;
    if (stepRefTargets(r).rotate.has(panel.id)) continue;
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
    if (!slabPts.some(c => (dot3(c, nR) - dNear) * (keepPlus ? 1 : -1) < -0.5)) continue;
    try {
      const cR = new THREE.Vector3(); for (const q of pts) cR.add(q); cR.divideScalar(pts.length);
      const onPlane = cR.clone().addScaledVector(nR, dNear - cR.dot(nR));
      const H = 100000;
      const half = await halfSpaceSlab(onPlane, nR, toward, H);
      const { u: us, v: vs } = getFacePlaneAxes(nS);
      // Üst üste panel basan: siluet yığının (taban dahil) siluetidir (basılan tabanın düzleminde diş çıkmasın); kesim düzlemi basanın yüzü.
      const silPts = [...pts];
      if (vfR.stackBaseVfId) {
        const baseGeo = shapeById(siblings.find(b => b.parameters?.virtualFaceId === vfR.stackBaseVfId)?.id ?? '')?.geometry;
        if (baseGeo?.getAttribute('position')) {
          // Taban silueti basanın düzlem seviyesine kaydırılır (yoksa hull'un çapraz kenarı yanda burulmuş kesim bırakır).
          const basePts = uniqueMeshPoints(baseGeo);
          const delta = projRange(basePts, nR).min - dMin;
          silPts.push(...basePts.map(q => q.clone().addScaledVector(nR, -delta)));
        }
      }
      const reach = projRange(silPts, nS);
      if (reach.max < sMin + 0.5 || reach.min > sMax - 0.5) continue;   // basan (yığınıyla), basılanın düzlem aralığına ulaşmıyor
      const hull = convexHull2D(silPts.map(q => toUV(q, us, vs)));
      if (hull.length < 3) continue;
      const silVerts = hull.map(q => vec3(fromPlaneUV(us, vs, nS, q.x, q.y, dS + 1000)));
      const sil = await createPanelFromVirtualFace(silVerts, vec3(nS), H, 0);
      if (!half || !sil) continue;
      out = out.cut(sil.intersect(half));
    } catch { /* kesilemezse basılan olduğu gibi kalır */ }
  }
  return out;
}

// Ref-dönüş pahı: R'nin yüz çokgeni nişan yönünde uzatılıp prizma yapılır, T'den çıkarılır. T basan → R'nin dış yüzeyi, değilse iç.
async function shapeRefRotateTargets(
  rp: any, panel: Shape, vf: VirtualFace, children: Shape[], orderOf: (s: Shape) => number,
  refContacts: Map<string, RefContact>, updateShape: UpdateShape,
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
    outerHull = convexHull2D(pts.filter(p => p.dot(nR) > dOuter - 0.5).map(p => toUV(p, ur, vr)));
    innerHull = convexHull2D(pts.filter(p => p.dot(nR) < dInner + 0.5).map(p => toUV(p, ur, vr)));
  } catch { return; }   // yüz çokgeni çıkarılamadı
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
          const d2 = toUV(d, ur, vr);
          hull = convexHull2D([...baseHull, ...baseHull.map(q => ({ x: q.x + d2.x * ext, y: q.y + d2.y * ext }))]);
        }
      }
      if (hull.length < 3) continue;
      const poly = hull.map(q => vec3(fromPlaneUV(ur, vr, nR, q.x, q.y, dPlane)));
      // Normal −nR: slab +nR yönünde uzar → seçilen yüzeyin ÖTESİ.
      const cutter = await createPanelFromVirtualFace(poly, [-nR.x, -nR.y, -nR.z], 100000, 0);
      if (!cutter || !boundsOverlapBox(cutter.boundingBox.bounds, localBboxOf(t.geometry)!)) continue;
      assertBounds(t.replicadShape);
      const shaped = t.replicadShape.clone().cut(cutter);
      assertBounds(shaped);   // bozuk sonuç yazılmaz → referans korunur
      updateShape(tid, { geometry: convertReplicadToThreeGeometry(shaped), replicadShape: shaped } as any);
    } catch { /* pah atlanır */ }
  }
}

// Gövde katısı (panel kesişimleri için): gövdenin kendi katısının kopyası (kutu + çizim adımları).
const bodySolidOf = (parent: Shape): any | null => (parent.replicadShape ? deepCopyShape(parent.replicadShape) : null);

// ── BİÇİMLENMİŞ GÖVDE (çizimle Shape / Cut) — panel gövde yüzüne oturur ──
// Komşuluk mesh'in kıvrım kenarlarından okunur: VF kenarının öbür yanındaki yüz normali (m) → kenar gerektiği kadar dışarı alınır,
// katı gövdeyle kesişir; içbükey eğik kenarda komşunun panel katmanına (m·p ≥ d − t) uzar. 
interface Crease { a: THREE.Vector3; b: THREE.Vector3; n: [THREE.Vector3, THREE.Vector3]; curved: [boolean, boolean]; /** iki yanın yüzey kimliği (BrepTriInfo.tri) */ s: [number, number]; /** iki yandaki üçgenin merkezi */ c: [THREE.Vector3, THREE.Vector3] }
const _creaseCache = new WeakMap<THREE.BufferGeometry, Crease[]>();
/** Gövde mesh'inin kıvrım kenarları: iki yanı FARKLI gerçek yüzeye (B-Rep) ait üçgen kenarları. B-Rep bilgisi yoksa boş. */
function bodyCreases(geo: THREE.BufferGeometry): Crease[] {
  const hit = _creaseCache.get(geo);
  if (hit) return hit;
  const out: Crease[] = [];
  const { faces } = getFacesAndGroups(geo);
  const brep = geo.userData?.brep as BrepTriInfo | undefined;
  if (brep && brep.tri.length === faces.length) {
    const key = (v: THREE.Vector3) => `${Math.round(v.x * 100)},${Math.round(v.y * 100)},${Math.round(v.z * 100)}`;
    const idx = geo.getIndex()?.array, vn = brep.normals;
    const vi = (f: number, k: number) => (idx ? idx[f * 3 + k] : f * 3 + k);
    const edges = new Map<string, { a: THREE.Vector3; b: THREE.Vector3; f: number[]; k: number[] }>();
    for (const f of faces) for (let i = 0; i < 3; i++) {
      const a = f.vertices[i], b = f.vertices[(i + 1) % 3], ka = key(a), kb = key(b);
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = edges.get(k);
      if (e) { e.f.push(f.faceIndex); e.k.push(i); } else edges.set(k, { a, b, f: [f.faceIndex], k: [i] });
    }
    /** Kenarın o yanındaki yüzey normali: düzde üçgen normali, eğride kenar uçlarındaki gerçek normallerin ortalaması (faset sapmasın). */
    const sideNormal = (f: number, k: number, isCurved: boolean): THREE.Vector3 => {
      const tn = faces[f].normal;
      if (!isCurved || !vn) return tn;
      const i0 = vi(f, k) * 3, i1 = vi(f, (k + 1) % 3) * 3;
      const n = new THREE.Vector3(vn[i0] + vn[i1], vn[i0 + 1] + vn[i1 + 1], vn[i0 + 2] + vn[i1 + 2]);
      if (n.lengthSq() < 1e-9) return tn;
      n.normalize();
      return n.dot(tn) < 0 ? n.negate() : n;
    };
    for (const e of edges.values()) {
      if (e.f.length !== 2) continue;
      const s0 = brep.tri[e.f[0]], s1 = brep.tri[e.f[1]];
      if (s0 === s1) continue;
      const c0 = !!brep.curved[s0], c1 = !!brep.curved[s1];
      out.push({ a: e.a, b: e.b, n: [sideNormal(e.f[0], e.k[0], c0), sideNormal(e.f[1], e.k[1], c1)], curved: [c0, c1], s: [s0, s1], c: [faces[e.f[0]].center, faces[e.f[1]].center] });
    }
  }
  _creaseCache.set(geo, out);
  return out;
}
/** Gövdede eksen-dışı (eğik) ya da eğri yüz var mı — düz kutu / L gövdede hiçbir ek işlem yapılmaz. */
const bodyIsShaped = (parent: Shape): boolean => isShapedBody(parent);

/** İÇBÜKEY kıvrımda EĞRİ komşunun iç yüzeyi (yüzey − t) düzlem değildir. Sınır teğet düzlemde (m·p ≥ d − t) kalırsa, dışbükey yayda
 *  teğet ile iç yüzey arasında incecik bir hilal kalır: önce gelen panel onu örtmez, sonra gelen eğri panel o kıymıkla kalırdı.
 *  Çözüm: sınır, iç yüzey çizgisinden (Q) panelin dış yüzünün iç yüzeyi kestiği yere (T′) giden KİRİŞ düzlemine eğilir (b ≥ 0 yanında);
 *  panelin ucu iç yüzeyin en çok s²/8R ötesinde kalır. Koordinat: b = teğet boyunca (uzama yönü), a = komşu normali boyunca, Q'ya göre. */
interface CurvedDip { sid: number; q: THREE.Vector3; d3: THREE.Vector3; m: THREE.Vector3; w: THREE.Vector3; tan: number; reach: number }
interface EdgeLimit { m: THREE.Vector3; d: number; dip?: CurvedDip | null }
function curvedLimitDip(
  geo: THREE.BufferGeometry, sid: number, a3: THREE.Vector3, d3: THREE.Vector3, m: THREE.Vector3, o3: THREE.Vector3, t: number,
): CurvedDip | null {
  const brep = geo.userData?.brep as BrepTriInfo | undefined;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined, vn = brep?.normals;
  if (!brep || !pos || !vn) return null;
  const mo = o3.dot(m);
  const w = o3.clone().addScaledVector(m, -mo);
  const k = w.length();
  if (!(mo < -0.02) || k < 0.05) return null;
  w.divideScalar(k);
  const q = a3.clone().addScaledVector(m, -t);
  const idx = geo.getIndex()?.array;
  const bScan = (t / -mo) * k * 3 + t * 3;
  // İç yüzeyin örnekleri: yüzey köşesi − t · gerçek normal (tam yüzey üstünde). En sıkı eğrilik: ρ = (b² + a²) / (−2a) (Q'da teğet daire).
  let rho = Infinity;
  const v = new THREE.Vector3(), nv = new THREE.Vector3(), tn = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const at = (f: number, c: number, out: THREE.Vector3) => out.fromBufferAttribute(pos, idx ? idx[f * 3 + c] : f * 3 + c);
  for (let f = 0; f < brep.tri.length; f++) {
    if (brep.tri[f] !== sid) continue;
    at(f, 0, v); tn.crossVectors(at(f, 1, e1).sub(v), at(f, 2, e2).sub(v));
    for (let c = 0; c < 3; c++) {
      const vi = idx ? idx[f * 3 + c] : f * 3 + c;
      nv.set(vn[vi * 3], vn[vi * 3 + 1], vn[vi * 3 + 2]);
      if (nv.lengthSq() < 1e-9) continue;
      nv.normalize();
      if (nv.dot(tn) < 0) nv.negate();   // gerçek normal üçgenin (dışa bakan) normaline göre yönlendirilir
      v.fromBufferAttribute(pos, vi).addScaledVector(nv, -t).sub(q);
      const b = v.dot(w), a = v.dot(m);
      if (b < 0.5 || b > bScan || a > -1e-3) continue;
      rho = Math.min(rho, (b * b + a * a) / (-2 * a));
    }
  }
  if (!Number.isFinite(rho) || rho < t * 0.5) return null;   // iç yüzey teğetin kavite yanına düşmüyor (içbükey yay / düz) ya da aşırı sıkı
  // Panelin dış yüzü kesitte a = t − b·s (s = |m·o| / k) doğrusudur; iç daireyle (merkez (0, −ρ)) ilk kesişim T′.
  const sl = -mo / k, A = 1 + sl * sl, B = sl * (rho + t), C = 2 * rho * t + t * t;
  const disc = B * B - A * C;
  if (disc < 0) return null;
  const bT = (B - Math.sqrt(disc)) / A, aT = t - sl * bT;
  if (!(bT > 0.5) || aT > -1e-3) return null;
  return { sid, q, d3: d3.clone().normalize(), m: m.clone(), w, tan: (-aT + 0.05) / bT, reach: bT / k };
}
/** Eğilmiş sınırın kesicisi: teğet düzlemin altı ∧ kiriş düzleminin altı (iki yarım-uzayın kesişimi; d3 boyunca sonsuz prizma).
 *  Pivot Q'nun 0,2 mm gerisinde: kiriş düzlemi komşunun uç kenarıyla tam çakışmasın. */
async function dipLimitTool(l: EdgeLimit): Promise<any | null> {
  const dp = l.dip!;
  const H = 100000, ca = 1 / Math.hypot(1, dp.tan), sa = dp.tan * ca;
  const q0 = dp.q.clone().addScaledVector(dp.w, -0.2).addScaledVector(dp.d3, H);
  const dir = dp.w.clone().multiplyScalar(ca).addScaledVector(dp.m, -sa);
  const v1 = q0.clone().addScaledVector(dp.w, -H), v4 = q0.clone().addScaledVector(dir, H);
  const poly = [q0, v1, v1.clone().addScaledVector(dp.m, -H), v4.clone().addScaledVector(dp.m, -H), v4];
  return createPanelFromVirtualFace(poly.map(vec3), vec3(dp.d3), 2 * H, 0);
}
/** Sınır kesimi: düz komşuda (ya da eğri komşu panel sırada önceyse) teğet yarım-uzay, yoksa eğilmiş sınır. */
async function applyEdgeLimit(rp: any, l: EdgeLimit, dip: boolean): Promise<any> {
  const tool = dip && l.dip ? await dipLimitTool(l) : await halfSpaceSlab(l.m.clone().multiplyScalar(l.d), l.m, l.m, 100000);
  if (!tool) return rp;
  const cut = rp.cut(tool);
  assertBounds(cut);
  return cut;
}
/** GÖNYE birleşim (Goker, Kas 2026 — "panel diğerinin içine girmiş", "ucu hatalı"): iki gövde yüzü arasındaki kırık 75°'den azsa
 *  (normaller arası açı; m·n > cos 75°) iki panel de kırık çizgisinden geçen AÇIORTAY düzleminde biter — sıradan bağımsız, iç ve dış
 *  yüzeyler tek çizgide buluşur. "Önce gelen geçer" kuralı bu açılarda geçen panele kırık açısı kadar sivri bir uç veriyor (dışbükeyde
 *  ucu öbür panelin yüzeyinde şerit olarak görünüyor, içbükeyde öbür panelin katmanına giriyor), öbürünü de onun altına pahlıyordu.
 *  75° ve üstü (dik köşe ve dike yakın eğik yan) eski kuralda kalır: önce gelen geçer, sonra gelen dayanır.
 *  Yarım-uzay: nb·(p − a) ≥ 0 tutulur. İçbükeyde uç önce t·tan(açı/2) + 1 uzar (katmanlar ayrışır); dışbükeyde uzamaz (katmanlar örtüşür). */
const MITER_COS = Math.cos((75 * Math.PI) / 180);
function miterOf(a: THREE.Vector3, n: THREE.Vector3, m: THREE.Vector3, mo: number, c: number, t: number): { ext: number; limit: EdgeLimit } {
  const nb = (mo < 0 ? m.clone().sub(n) : n.clone().sub(m)).normalize();
  return { ext: mo < 0 ? (t * (1 - c)) / -mo + 1 : 0, limit: { m: nb, d: nb.dot(a) } };
}
/** Panelin oturduğu gövde yüzeylerinin kimlikleri (eğri yüz: tek yüzey; düz yüz: VF düzlemindeki grup(lar)ın yüzeyleri). */
function panelSurfaceIds(parent: Shape, vf: VirtualFace | undefined): Set<number> {
  const out = new Set<number>(), geo = parent.geometry, brep = geo?.userData?.brep as BrepTriInfo | undefined;
  if (!vf || !geo || !brep || !vf.vertices?.length) return out;
  if (vf.curved) { const sid = curvedSurfaceIdOf(parent, vf); if (sid !== null) out.add(sid); return out; }
  const n = vfNormal(vf), d = dot3(vf.vertices[0], n);
  const { faces, groups } = getFacesAndGroups(geo);
  for (const g of groups) {
    if (g.isCurved || g.normal.clone().normalize().dot(n) < 0.9995 || Math.abs(g.center.dot(n) - d) > 0.6) continue;
    for (const fi of g.faceIndices) if (faces[fi]) out.add(brep.tri[fi]);
  }
  return out;
}
/** Gövde yüzünü izleyen (taşınmamış / dönmemiş, üst üste olmayan) gövde paneli — gönye yalnız bunlara uygulanır. */
const followsBodyFace = (p: Shape, vf: VirtualFace | undefined): boolean =>
  !!vf && !isInteriorPanel(p) && !isSheetPanel(p) && !vf.stackBaseVfId && !(vf.stackDepth && vf.stackDepth > 0)
  && !(((p.parameters as any)?.transformSteps ?? []) as Array<{ type?: string }>).some(st => st?.type === 'move' || st?.type === 'rotate');
/** İki panel GÖNYEYLE birleşen komşu yüzlerde mi? Öyleyse ikisi de açıortayda biter ve birbirine yalnız değer: sıraya göre kesimler
 *  (kardeşin kutusu / yüz düzlemi / siluet prizması) atlanır — yoksa sonra gelen panelin gönye ucunu geri kesip üçgen boşluk bırakırlar. */
function miterJoined(parent: Shape, a: Shape, b: Shape, vfs?: VirtualFace[]): boolean {
  if (!bodyIsShaped(parent) || !parent.geometry) return false;
  const va = vfOfPanel(a, vfs), vb = vfOfPanel(b, vfs);
  if (!followsBodyFace(a, va) || !followsBodyFace(b, vb)) return false;
  const sa = panelSurfaceIds(parent, va), sb = panelSurfaceIds(parent, vb);
  if (!sa.size || !sb.size) return false;
  for (const c of bodyCreases(parent.geometry)) {
    const ab = sa.has(c.s[0]) && sb.has(c.s[1]), ba = sa.has(c.s[1]) && sb.has(c.s[0]);
    if (!ab && !ba) continue;
    const i: 0 | 1 = ab ? 0 : 1, n = c.n[i], m = c.n[i === 0 ? 1 : 0];
    const o = new THREE.Vector3().crossVectors(c.b.clone().sub(c.a), n);
    if (o.lengthSq() < 1e-9) continue;
    if (m.dot(n) > MITER_COS && Math.abs(m.dot(o.normalize())) >= 0.05) return true;
  }
  return false;
}
/** Kırık çizgisi (a → b) çevresinde YEREL yarım-uzay kesicisi: düzlemin atılan yanında, kırıktan `r` uzağa kadar bir kutu.
 *  Eğri panelde sonsuz yarım-uzay kullanılamaz — yay dönüp düzlemin öte yanına geçebilir. */
async function localLimitTool(a: THREE.Vector3, b: THREE.Vector3, nb: THREE.Vector3, r: number): Promise<any | null> {
  const d3 = b.clone().sub(a), len = d3.length();
  if (len < 1e-6) return null;
  d3.divideScalar(len);
  const q = new THREE.Vector3().crossVectors(d3, nb).normalize();
  const o = a.clone().addScaledVector(d3, -1);
  const poly = [o.clone().addScaledVector(q, -r), o.clone().addScaledVector(q, r), o.clone().addScaledVector(q, r).addScaledVector(nb, -r), o.clone().addScaledVector(q, -r).addScaledVector(nb, -r)];
  return createPanelFromVirtualFace(poly.map(vec3), vec3(d3.clone().negate()), len + 2, 0);
}
/** Eğri yüz panelinin oturduğu gövde yüzeyinin kimliği (BrepTriInfo.tri). */
function curvedSurfaceIdOf(parent: Shape, vf: VirtualFace | undefined): number | null {
  const geo = parent.geometry, brep = geo?.userData?.brep as BrepTriInfo | undefined;
  if (!vf?.curved || !geo || !brep) return null;
  const { faces, groups } = getFacesAndGroups(geo);
  const hit = matchCurvedFaceGroup(toVector3(vf.center), vfNormal(vf), faces, groups);
  return hit ? brep.tri[hit.group.faceIndices[0]] : null;
}

/** Dik dışbükey köşede eğri komşu yüzey, panelin kalınlığı boyunca uç düzleminden ne kadar DIŞARI taşıyor (dışbükey yay: ρ − √(ρ² − t²)).
 *  Panelin ucu en az bu kadar büyütülüp gövdeyle kesilmeli; yoksa uç düzlemi ile yüzey arasında, sonra gelen eğri panelde hilal kalır. */
function curvedExcursion(geo: THREE.BufferGeometry, sid: number, a3: THREE.Vector3, n: THREE.Vector3, o3: THREE.Vector3, t: number): number {
  const brep = geo.userData?.brep as BrepTriInfo | undefined, pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!brep || !pos) return 0;
  const idx = geo.getIndex()?.array, v = new THREE.Vector3();
  let rho = Infinity;
  for (let f = 0; f < brep.tri.length; f++) {
    if (brep.tri[f] !== sid) continue;
    for (let c = 0; c < 3; c++) {
      v.fromBufferAttribute(pos, idx ? idx[f * 3 + c] : f * 3 + c).sub(a3);
      const b = -v.dot(n), a = v.dot(o3);            // b: yüzün altına derinlik, a: uç düzleminden dışarı
      if (b < 0.5 || b > t * 6 || a < 1e-3) continue;
      rho = Math.min(rho, (b * b + a * a) / (2 * a));
    }
  }
  if (!Number.isFinite(rho)) return 0;
  return rho > t ? rho - Math.sqrt(rho * rho - t * t) : rho;
}

interface BodyEdgeFit { verts: Vec3[]; clip: boolean; limits: EdgeLimit[] }
/** VF çokgenini gövde yüzünün kenarlarına oturtur (m = komşu yüz normali, o = kenarın dış yönü, n = yüz normali):
 *   - dışbükey (m·o > 0): dışa yatıksa t·(m·n)/(m·o) uzar ve gövdeyle kesilir; içe yatıksa yalnız kesilir; dik komşuda bir şey yapılmaz.
 *   - içbükey eğik: komşunun panel katmanının dibine uzar (köşede boşluk kalmaz). Teğet eğri komşuya dokunulmaz.
 *   - `tilted`: kardeşle sınırlı kenarlar 3t + 2 uzar. İşlem yoksa null. */
/** Eğri yüz ↔ düz yüz birleşiminde uzatma üst oranı (m·n / m·o = tan açı ≈ 50°); ötesi "dik birleşim". */
const STEEP_JOIN = 1.2;
function fitVertsToBodyEdges(
  geo: THREE.BufferGeometry, normal: Vec3, verts: Vec3[], t: number, tilted: boolean,
  /** Eğri komşuya DİK kenarlar (ön / arka yüzün yay kenarı) bu kadar dışa taşırılıp gövdeyle kesilir. */ curvedGrow = 0,
): BodyEdgeFit | null {
  const creases = bodyCreases(geo);
  if (!creases.length) return null;
  const n = new THREE.Vector3(...normal).normalize();
  // Ardışık çakışık köşeler ayıklanır (kenar yönü tanımsız kalmasın).
  const P: THREE.Vector3[] = [];
  for (const c of verts) { const q = toVector3(c); if (!P.length || P[P.length - 1].distanceTo(q) > 0.05) P.push(q); }
  if (P.length > 1 && P[0].distanceTo(P[P.length - 1]) <= 0.05) P.pop();
  const N = P.length;
  if (N < 3) return null;
  const planeD = P[0].dot(n);
  const mine: Array<{ a: THREE.Vector3; b: THREE.Vector3; m: THREE.Vector3; curved: boolean; s: number }> = [];
  for (const c of creases) {
    if (Math.abs(c.a.dot(n) - planeD) > 0.5 || Math.abs(c.b.dot(n) - planeD) > 0.5) continue;
    const s0 = !c.curved[0] && c.n[0].dot(n) > 0.9995, s1 = !c.curved[1] && c.n[1].dot(n) > 0.9995;
    if (s0 === s1) continue;   // iki yanı da bu düzlem (eş-düzlem ek) ya da bu yüzün kenarı değil
    mine.push({ a: c.a, b: c.b, m: s0 ? c.n[1] : c.n[0], curved: s0 ? c.curved[1] : c.curved[0], s: s0 ? c.s[1] : c.s[0] });
  }
  if (!mine.length && !tilted) return null;
  const { u, v } = getFacePlaneAxes(n);
  const p2 = P.map(p => toUV(p, u, v));
  let area = 0;
  for (let i = 0; i < N; i++) { const a = p2[i], b = p2[(i + 1) % N]; area += a.x * b.y - b.x * a.y; }
  const ccw = area > 0;
  const off = new Array<number>(N).fill(0);
  const growEdge = new Array<boolean>(N).fill(false);
  let growBy = curvedGrow;
  const dir2: Array<{ x: number; y: number }> = [], out2: Array<{ x: number; y: number }> = [];
  const limits: BodyEdgeFit['limits'] = [];
  // Yüzün içindeki kıvrım (delik / cep ağzı): panel gövdeyle kesilir, delik panele de açılır.
  let clip = mine.some(c => {
    const q = toUV(c.a.clone().add(c.b).multiplyScalar(0.5), u, v);
    let inside = false;
    for (let i = 0, j = N - 1; i < N; j = i++) {
      const a = p2[i], b = p2[j];
      const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey || 1;
      const tt = Math.max(0, Math.min(1, ((q.x - a.x) * ex + (q.y - a.y) * ey) / L2));
      if (Math.hypot(q.x - (a.x + ex * tt), q.y - (a.y + ey * tt)) < 1) return false;   // çokgenin kenarında (dış kontur)
      if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  });
  const MAX = t * 6 + 2;
  for (let i = 0; i < N; i++) {
    const a3 = P[i], b3 = P[(i + 1) % N];
    const d3 = b3.clone().sub(a3), len = d3.length();
    d3.divideScalar(len || 1);
    const a2 = p2[i], b2 = p2[(i + 1) % N], l2 = Math.hypot(b2.x - a2.x, b2.y - a2.y) || 1;
    const dx = (b2.x - a2.x) / l2, dy = (b2.y - a2.y) / l2;
    dir2.push({ x: dx, y: dy });
    out2.push(ccw ? { x: dy, y: -dx } : { x: -dy, y: dx });
    const o3 = new THREE.Vector3().addScaledVector(u, out2[i].x).addScaledVector(v, out2[i].y);
    let found: (typeof mine)[number] | null = null;
    for (const s of [0.5, 0.25, 0.75]) {
      const q = a3.clone().addScaledVector(d3, len * s);
      for (const c of mine) {
        const ab = c.b.clone().sub(c.a), L = ab.length();
        if (L < 1e-6 || Math.abs(ab.dot(d3)) / L < 0.9995) continue;
        const tt = Math.max(0, Math.min(1, q.clone().sub(c.a).dot(ab) / (L * L)));
        if (c.a.clone().addScaledVector(ab, tt).distanceTo(q) < 0.6) { found = c; break; }
      }
      if (found) break;
    }
    if (!found) { if (tilted) off[i] = t * 3 + 2; continue; }
    const m = found.m, mo = m.dot(o3), c = m.dot(n);
    // Gönye: kırık 75°'den azsa (teğet değilse) panel açıortayda biter; içbükeyde önce oraya kadar uzar. Gövde kesimi gerekmez.
    if (c > MITER_COS && Math.abs(mo) >= 0.05) {
      const mt = miterOf(a3, n, m, mo, c, t);
      if (mt.ext > 0) off[i] = Math.min(mt.ext, MAX);
      limits.push(mt.limit);
      continue;
    }
    if (found.curved && c > 0.94) continue;   // eğri komşuya teğet geçiş
    // Yayvan birleşim (m·n > STEEP_JOIN·m·o, kırık ≈ 40°'den az): t·(m·n)/(m·o) patlar, panel komşu yüzün altına kama olarak taşıyordu.
    // (Gönye kuralından önce yayvan dışbükey kırığın kuralıydı; 75° altı artık gönyede, bu satır yalnız güvenlik.)
    if (mo > 0 && c > mo * STEEP_JOIN) continue;
    // Önce gelen eğri panelin katısı aynı yayın gerçek yüzeyidir; neredeyse çakışan faset / eğri yüzeylerle Cut yavaş ve kırılgan →
    // kenar dışa taşırılıp gövdeyle kesilir (kenar gerçek yay olur, temiz boolean).
    if (found.curved && curvedGrow > 0 && Math.abs(c) < 0.02 && mo > 0.05) {
      growEdge[i] = true;
      growBy = Math.max(growBy, curvedExcursion(geo, found.s, a3, n, o3, t) + 1);
      continue;
    }
    if (Math.abs(mo) < 0.05 || Math.abs(c) < 0.02) continue;   // (neredeyse) eş-düzlem ya da dik komşu
    clip = true;
    if (mo > 0) { if (c > 0) off[i] = Math.min((t * c) / mo + 1, MAX); }
    else {
      // Eğri komşu: sınır iç yüzeyin kavite yanına eğilebilsin diye kenar T′'ye kadar uzar (curvedLimitDip).
      const dip = found.curved ? curvedLimitDip(geo, found.s, a3, d3, m, o3, t) : null;
      off[i] = Math.min(Math.max((t * (1 + Math.max(0, -c))) / -mo, dip ? dip.reach : 0) + 1, MAX);
      limits.push({ m: m.clone(), d: m.dot(a3) - t, dip });
    }
  }
  // Yay kenarı (curvedGrow): yay kirişleri yayı dıştan saran kaba kırık çizgiyle (≤ 8 parça) değiştirilir; gövde kesimi gerçek yayı bırakır
  // (her kirişi ötelemek 60+ yüzlü prizma: elipste 5 s → 0,5 s).
  if (growEdge.some(Boolean) && !growEdge.every(Boolean)) {
    let s0 = 0;
    while (growEdge[s0]) s0++;
    const outV: Array<{ x: number; y: number }> = [];
    for (let k = 0; k < N;) {
      const i = (s0 + k) % N;
      if (!growEdge[i]) { outV.push(p2[i]); k++; continue; }
      let n = 0;
      while (n < N && growEdge[(i + n) % N]) n++;
      const run = Array.from({ length: n + 1 }, (_, q) => (i + q) % N);        // köşe indisleri (n kenar)
      const step = Math.max(1, Math.ceil(n / 8));
      const kept = run.filter((_, q) => q % step === 0 || q === n);
      let dev = 0;
      for (let q = 0; q + 1 < kept.length; q++) {
        const A = p2[kept[q]], B = p2[kept[q + 1]], ex = B.x - A.x, ey = B.y - A.y, L = Math.hypot(ex, ey) || 1;
        for (let r = run.indexOf(kept[q]) + 1; r < run.indexOf(kept[q + 1]); r++) dev = Math.max(dev, Math.abs((p2[run[r]].x - A.x) * ey - (p2[run[r]].y - A.y) * ex) / L);
      }
      const Dg = dev * 1.05 + growBy;
      kept.forEach((vi, q) => {
        const eIn = run[Math.max(0, run.indexOf(vi) - 1)], eOut = run[Math.min(n - 1, run.indexOf(vi))];   // köşenin iki yanındaki yay kirişi
        let ox = out2[eIn].x + out2[eOut].x, oy = out2[eIn].y + out2[eOut].y; const ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol;
        if (q === 0) outV.push(p2[vi]);
        outV.push({ x: p2[vi].x + ox * Dg, y: p2[vi].y + oy * Dg });
      });
      k += n;   // yayın son köşesi sıradaki (yay olmayan) kenarın başıdır → döngü onu ekler
    }
    const grown = fitVertsToBodyEdges(geo, normal, outV.map(q => vec3(fromPlaneUV(u, v, n, q.x, q.y, planeD))), t, tilted, 0);
    return grown ? { ...grown, clip: true } : { verts: outV.map(q => vec3(fromPlaneUV(u, v, n, q.x, q.y, planeD))), clip: true, limits: [] };
  }
  if (!off.some(x => x > 0)) return clip || limits.length ? { verts, clip, limits } : null;
  // Kenar doğruları dışa ötelenir, komşu doğrular yeniden kesiştirilir (paralel komşuda / aşırı sivri köşede basamak).
  const line = (i: number) => ({ x: p2[i].x + out2[i].x * off[i], y: p2[i].y + out2[i].y * off[i] });
  const res: Array<{ x: number; y: number }> = [];
  for (let k = 0; k < N; k++) {
    const j = (k - 1 + N) % N;
    const A = { x: p2[k].x + out2[j].x * off[j], y: p2[k].y + out2[j].y * off[j] }, B = { x: p2[k].x + out2[k].x * off[k], y: p2[k].y + out2[k].y * off[k] };
    const cr = dir2[j].x * dir2[k].y - dir2[j].y * dir2[k].x;
    let pt: { x: number; y: number } | null = null;
    if (Math.abs(cr) > 1e-6) {
      const pj = line(j), pk = line(k);
      const sj = ((pk.x - pj.x) * dir2[k].y - (pk.y - pj.y) * dir2[k].x) / cr;
      pt = { x: pj.x + dir2[j].x * sj, y: pj.y + dir2[j].y * sj };
      if (Math.hypot(pt.x - p2[k].x, pt.y - p2[k].y) > 4 * Math.max(off[j], off[k]) + 1) pt = null;
    }
    if (pt) res.push(pt);
    else { res.push(A); if (Math.hypot(A.x - B.x, A.y - B.y) > 1e-4) res.push(B); }
  }
  return { verts: res.map(q => vec3(fromPlaneUV(u, v, n, q.x, q.y, planeD))), clip: true, limits };
}

/** Eğri yüz paneli katısı: VF'nin oturduğu eğri gövde yüzü içe `t` kalınlaştırılır; yüz, yüzey kimliğiyle gövde katısında bulunur. */
const _curvedSolidCache = new WeakMap<THREE.BufferGeometry, Map<string, any>>();
async function curvedPanelSolid(
  parent: Shape, vf: VirtualFace, t: number,
  /** Sırada ÖNCE gelen eğri panellerin yüzeyleri: verilirse içbükey eğri komşuda sınır iç yüzeye eğilir (o komşu önce değilse). */ earlierSids?: Set<number>,
): Promise<any | null> {
  const solid = parent.replicadShape, geo = parent.geometry;
  const brep = geo?.userData?.brep as BrepTriInfo | undefined;
  if (!solid || !geo || !brep?.keys) return null;
  const { faces, groups } = getFacesAndGroups(geo);
  const hit = matchCurvedFaceGroup(toVector3(vf.center), vfNormal(vf), faces, groups);
  if (!hit) return null;
  // Kalınlaştırma + gövde kesişimi yalnız gövdeye bağlı → gövde mesh'i başına saklanır (elipste ≈ 3 s).
  const cacheKey = `${groups.indexOf(hit.group)}|${t}|${earlierSids ? [...earlierSids].sort().join(',') : '-'}`;
  let bucket = _curvedSolidCache.get(geo);
  if (!bucket) { bucket = new Map(); _curvedSolidCache.set(geo, bucket); }
  const cached = bucket.get(cacheKey);
  if (cached) { try { return deepCopyShape(cached); } catch { bucket.delete(cacheKey); } }
  // Teğet sürekli serbest eğri yüzler tek gruptur: anahtar "fA+fB" (Geometry.brepTriInfo).
  const keySet = new Set((brep.keys[brep.tri[hit.group.faceIndices[0]]] ?? '').split('+'));
  const gb = new THREE.Box3();
  for (const fi of hit.group.faceIndices) for (const p of faces[fi]?.vertices ?? []) gb.expandByPoint(p);
  gb.expandByScalar(1);
  const oc = await initReplicad();
  const { cast, measureVolume } = await import('replicad');
  // Uçlar: kalınlaştırılmış yüzün ucu yüzeye diktir; teğet olmayan komşuyla kama boşluk kalır → komşu normali okunur
  // (fitVertsToBodyEdges ile aynı kural): dışbükey + dışa yatıkta uç t·(m·n)/(m·o) uzar, içbükey eğikte komşu katmanın dibine.
  const sid = brep.tri[hit.group.faceIndices[0]];
  // Sınır yalnız o ucun UZANTISINA uygulanır (prizma eklenmeden önce). Eskiden bütün katıya sonsuz yarım-uzay olarak uygulanıyordu:
  // büyük yayda (yarım daire) panelin uzaktaki kısmı da "komşu katmanın dibinin altında" kalıp kesiliyor, panel yarım çıkıyordu.
  const ends: Array<{ mid: THREE.Vector3; o: THREE.Vector3; ext: number; limit?: EdgeLimit }> = [];
  const trims = new Map<string, { a: THREE.Vector3; b: THREE.Vector3; nb: THREE.Vector3 }>();
  for (const c of bodyCreases(geo)) {
    if ((c.s[0] === sid) === (c.s[1] === sid)) continue;   // bu yüzün sınırı değil
    const i: 0 | 1 = c.s[0] === sid ? 0 : 1, j: 0 | 1 = i === 0 ? 1 : 0;
    const n = c.n[i], m = c.n[j];
    const mid = c.a.clone().add(c.b).multiplyScalar(0.5);
    const o = new THREE.Vector3().crossVectors(c.b.clone().sub(c.a), n);
    if (o.lengthSq() < 1e-9) continue;
    o.normalize();
    if (o.dot(mid.clone().sub(c.c[i])) < 0) o.negate();   // yüzün dışına doğru
    const mo = m.dot(o), cn = m.dot(n);
    if (Math.abs(mo) < 0.05) continue;   // teğet / eş-düzlem komşu
    // Dışbükey dik komşuda uç zaten komşu yüzde; içbükey dik komşuda uç t uzar. Dik birleşimde (m·n > STEEP_JOIN·m·o) uzatma
    // incecik kama verirdi → uzatılmaz, iki panel sıraya göre birleşir.
    if (cn > MITER_COS) {
      // Gönye: içbükeyde uç açıortaya kadar uzar (sınır yalnız uzantıya); dışbükeyde ucun açıortayın ötesindeki kısmı YEREL kesilir.
      const mt = miterOf(c.a, n, m, mo, cn, t);
      if (mo < 0) ends.push({ mid, o, ext: mt.ext, limit: mt.limit });
      else {
        const d3 = c.b.clone().sub(c.a).normalize(), k = `${mt.limit.m.x.toFixed(4)},${mt.limit.m.y.toFixed(4)},${mt.limit.m.z.toFixed(4)}|${mt.limit.d.toFixed(2)}|${d3.x.toFixed(3)},${d3.y.toFixed(3)},${d3.z.toFixed(3)}`;
        const tr = trims.get(k);
        if (!tr) trims.set(k, { a: c.a.clone(), b: c.b.clone(), nb: mt.limit.m });
        else for (const p of [c.a, c.b]) {   // aynı kırığın mesh parçaları tek kesicide toplanır
          const ab = tr.b.clone().sub(tr.a), L2 = ab.lengthSq() || 1, s = p.clone().sub(tr.a).dot(ab) / L2;
          if (s < 0) tr.a.copy(p); else if (s > 1) tr.b.copy(p);
        }
      }
    } else if (mo > 0) { if (cn > 0.02 && cn <= mo * STEEP_JOIN) ends.push({ mid, o, ext: Math.min((t * cn) / mo + 1, t * 6 + 2) }); }
    else {
      const dip = earlierSids && c.curved[j] && !earlierSids.has(c.s[j]) ? curvedLimitDip(geo, c.s[j], c.a, c.b.clone().sub(c.a).normalize(), m, o, t) : null;
      ends.push({ mid, o, ext: Math.min(Math.max((t * (1 + Math.max(0, -cn))) / -mo, dip ? dip.reach : 0) + 1, t * 6 + 2), limit: { m: m.clone(), d: m.dot(c.a) - t, dip } });
    }
  }
  /** Parçanın düz uç yüzlerinden, uzatılması gereken sınır kenarına oturanlar teğet yönde prizmalanıp parçaya eklenir. */
  const extendEnds = async (piece: any): Promise<any> => {
    if (!ends.length) return piece;
    let res = piece;
    for (const face of piece.faces as any[]) {
      try {
        if (String(face.geomType) !== 'PLANE') continue;
        const nv = face.normalAt(), fn = new THREE.Vector3(nv.x, nv.y, nv.z).normalize();
        const cv = face.center, fc = new THREE.Vector3(cv.x, cv.y, cv.z);
        const bb = face.boundingBox.bounds as number[][];
        const box = new THREE.Box3(new THREE.Vector3(...bb[0]), new THREE.Vector3(...bb[1])).expandByScalar(1);
        let best: (typeof ends)[number] | null = null;
        for (const e of ends) {
          if (Math.abs(fn.dot(e.o)) < 0.99 || Math.abs(e.mid.clone().sub(fc).dot(e.o)) > 0.5 || !box.containsPoint(e.mid)) continue;
          if (!best || e.ext > best.ext) best = e;
        }
        if (!best) continue;
        const pb = new oc.BRepPrimAPI_MakePrism_1(face.wrapped, new oc.gp_Vec_4(best.o.x * best.ext, best.o.y * best.ext, best.o.z * best.ext), false, true);
        pb.Build(new oc.Message_ProgressRange_1());
        let prism: any = cast(pb.Shape());
        if (best.limit) { try { prism = await applyEdgeLimit(prism, best.limit, !!best.limit.dip); } catch { /* sınır kesilemedi → uzantı gövdeyle kesilir */ } }
        const grown = res.fuse(prism);
        if (measureVolume(grown) > measureVolume(res)) res = grown;
      } catch { /* bu uç uzatılamadı */ }
    }
    return res;
  };
  let out: any = null, fi = 0;
  for (const face of solid.faces as any[]) {
    fi++;
    const type = String(face.geomType);
    if (type === 'PLANE' || !keySet.has(surfaceKeyOf(oc, face, type, fi))) continue;
    try {
      const b = face.boundingBox.bounds as number[][];
      if (!gb.intersectsBox(new THREE.Box3(new THREE.Vector3(...b[0]), new THREE.Vector3(...b[1])))) continue;   // aynı silindirin başka yaması
      for (const off of [-t, t]) {   // içe doğru = yüz normalinin tersi; ters dönen yüzde hacim negatif çıkar → öbür işaret
        const mk = new oc.BRepOffsetAPI_MakeThickSolid();
        try {
          mk.MakeThickSolidBySimple(face.wrapped, off);
          const piece: any = deepCopyShape(cast(mk.Shape()));   // gövde yüzünün TShape'ini paylaşmasın (panelin kesimleri gövdeyi kirletirdi)
          if (!(measureVolume(piece) > 1)) continue;
          const grown = await extendEnds(piece);
          out = out ? out.fuse(grown) : grown;
          break;
        } catch { /* bu işaretle kalınlaşmadı */ } finally { mk.delete(); }
      }
    } catch { /* yüz okunamadı */ }
  }
  if (!out) return null;
  for (const tr of trims.values()) {
    try {
      const tool = await localLimitTool(tr.a, tr.b, tr.nb, t * 2 + 4);
      if (tool) { const cut = out.cut(tool); assertBounds(cut); out = cut; }
    } catch { /* gönye kesilemedi → uç sıraya göre kesilir */ }
  }
  out = await intersectWithBody(out, parent, false);
  bucket.set(cacheKey, out);
  return deepCopyShape(out);
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
    const box = await createReplicadBoxAt(c.min, c.max);
    assertBounds(rp);
    return rp.intersect(box);
  } catch { return rp; }
}

async function intersectWithBody(rp: any, parent: Shape, fallbackBox: boolean, /** Doğrulama sonucu (yalnız biçimlenmiş gövde). */ status?: { ok: boolean }): Promise<any> {
  try {
    let body = bodySolidOf(parent);
    if (!body && fallbackBox) {
      const pp: any = parent.parameters || {};
      body = await createReplicadBox({ width: parseFloat(pp.width) || 1, height: parseFloat(pp.height) || 1, depth: parseFloat(pp.depth) || 1 });
    }
    if (!body) return rp;
    assertBounds(rp);
    // Biçimlenmiş gövde: sonuç boolean'dan bağımsız doğrulanır (hacim artmamış, iç örnekler gövdede); Common paneli aynen döndürebilir.
    if (parent.geometry && bodyIsShaped(parent)) {
      const { measureVolume } = await import('replicad');
      const v0 = volOf(measureVolume, rp), bodyGeo = parent.geometry;
      const valid = (x: any): boolean => {
        try {
          assertBounds(x);
          const v = volOf(measureVolume, x);
          if (!(v > 1) || v > v0 + 0.5) return false;
          const g = convertReplicadToThreeGeometry(x), r = probesInside(g, bodyGeo);
          g.dispose();
          return r.total - r.inside < 2;
        } catch { return false; }
      };
      const tries: Array<() => Promise<any> | any> = [
        // Her deneme kendi derin kopyalarıyla: boolean girdilerinin toleransını yerinde büyütebilir, kirlenen girdi sonraki denemeyi de bozar.
        // A − (A − B) kuruluşunda iki adım AYNI kopyayı paylaşır (ortak alt şekiller kesimi sağlam kılar).
        () => deepCopyShape(rp).intersect(deepCopyShape(body)),
        () => { const r = deepCopyShape(rp), outside = r.clone().cut(deepCopyShape(body)); return volOf(measureVolume, outside) > 0.5 ? r.clone().cut(outside) : rp; },
        async () => { const r = deepCopyShape(rp), outside = await cutWithTools(r.clone(), [deepCopyShape(body)], false, 1e-3); return cutWithTools(r.clone(), [outside], false, 1e-3); },
        () => deepCopyShape(body).intersect(deepCopyShape(rp)),
      ];
      // Geçerli sonuçlardan TEMİZ olan seçilir. Common, kenarı gövdenin eğri yüzeyine değen panelde sıfır alanlı yüz bırakabiliyor, teğete
      // yakın kesişimde de köşe toleransını mm'lere çıkarabiliyor (7,4 mm ölçüldü): katı geometrik olarak doğru ama sonraki kesimler onunla
      // sessizce boş dönüyor / çöp yüz üretiyor (sonra gelen panel iç içe kalıyordu). Öbür kuruluşlar aynı katıyı temiz üretir.
      const { measureArea } = await import('replicad');
      let best: any = null, bestDirt = Infinity;
      for (let i = 0; i < tries.length; i++) {
        let x: any = null;
        try { x = await tries[i](); } catch { x = null; }
        if (!x || !valid(x)) continue;
        const dirt = shapeDirt(x, measureArea);
        if (dirt <= CLEAN_TOL) { if (status) status.ok = true; return x; }
        if (dirt < bestDirt) { best = x; bestDirt = dirt; }
      }
      if (best) { if (status) status.ok = true; return best; }
      console.warn('[YAGO][MOTOR] gövde kesişimi doğrulanamadı (panel gövdeye sığdırılamadı)');
      if (status) status.ok = false;
      return rp;
    }
    try {
      const out = rp.intersect(body);
      assertBounds(out);   // boş kesişim = panel sessizce yok olur (ölçü 0) → kırpma atlanır
      return out;
    } catch {
      // Common boş / fırlattı: kesişim kesmeyle kurulur (rp − (rp − gövde)); tümüyle içerideyse aynen, tümüyle dışarıdaysa kırpma atlanır.
      const { measureVolume } = await import('replicad');
      const outside = rp.clone().cut(body.clone());
      let vo = 0; try { vo = measureVolume(outside); } catch { vo = 0; }
      if (!(vo > 1)) return rp;
      const inside = rp.clone().cut(outside);
      assertBounds(inside);
      return measureVolume(inside) > 1 ? inside : rp;
    }
  } catch { return rp; }
}

/** rp ∩ araç, kesmeyle (rp − (rp − araç)); dışarıda parça yoksa rp, kesişim boşsa null.
 *  Doğrulamalı: eş-yüzeyli çiftte (eğik sınır paneliyle 2B kırpılmış kapak ↔ gövde maskesi) Cut, "dışarıda kalan"ı yanlış kurabiliyor
 *  (neredeyse bütün levha ya da hiç) → kapak maskeyle kırpılmadan kalıyordu. Sonuç boolean'dan bağımsız sınanır: iç örnekleri aracın
 *  içinde olmalı; olmuyorsa bulanık toleransla (1e-3, 1e-2) yeniden kurulur. Hiçbiri doğrulanamazsa ilk kuruluş (eski davranış). */
async function intersectByCut(rp: any, tool: any): Promise<any | null> {
  const { measureVolume } = await import('replicad');
  const v0 = volOf(measureVolume, rp);
  let toolGeo: THREE.BufferGeometry | null = null;
  /** Katının iç örneklerinden kaçı aracın içinde. */
  const probe = (x: any): { inside: number; total: number } => {
    try {
      toolGeo ??= convertReplicadToThreeGeometry(tool);
      const g = convertReplicadToThreeGeometry(x), r = probesInside(g, toolGeo);
      g.dispose();
      return r;
    } catch { return { inside: 0, total: 0 }; }
  };
  /** İçeride kalan aracın içinde, dışarıda kalan aracın dışında (en çok bir aykırı örnek) ve ikisi levhayı tamamlıyor. */
  const verified = (inside: any | null, outside: any | null, vi: number, vo: number): boolean => {
    if (Math.abs(vi + vo - v0) > Math.max(1, v0 * 0.002)) return false;
    if (inside) { const r = probe(inside); if (!(r.total > 0) || r.total - r.inside >= 2) return false; }
    if (outside) { const r = probe(outside); if (r.inside >= 2) return false; }
    return true;
  };
  let first: { res: any | null } | null = null;
  try {
    for (const fuzzy of [0, 1e-3, 1e-2]) {
      let res: any | null = null, ok = false;
      try {
        const r = deepCopyShape(rp);
        const outside = fuzzy ? await cutWithTools(r.clone(), [deepCopyShape(tool)], false, fuzzy) : r.clone().cut(deepCopyShape(tool));
        const vo = volOf(measureVolume, outside);
        if (!(vo > 0.5)) { res = rp; ok = verified(rp, null, v0, 0); }
        else {
          const inside = fuzzy ? await cutWithTools(r.clone(), [outside], false, fuzzy) : r.clone().cut(outside);
          const vi = volOf(measureVolume, inside);
          res = vi > 1 ? inside : null;
          ok = res ? verified(inside, outside, vi, vo) : verified(null, outside, 0, vo);
        }
      } catch { if (!first) throw new Error('intersectByCut'); continue; }
      if (!first) first = { res };
      if (ok) return res;
    }
    return first ? first.res : null;
  } finally { (toolGeo as THREE.BufferGeometry | null)?.dispose(); }
}

// Kapak ↔ biçimlenmiş gövde: kapak, ön yüz dış çevresinin boşluk kadar içe ötelenmiş prizmasıyla kesişir (MakeOffset: yay yay kalır).
// İç kapak ayrıca eğri / eğimli panellerin (kalınlık + boşluk) katısından çıkarılır.
const _faceMaskCache = new WeakMap<THREE.BufferGeometry, Map<string, any>>();
async function bodyFaceMask(parent: Shape, axis: 0 | 1 | 2, side: 1 | -1, box: THREE.Box3, inset: number, from: number, to: number): Promise<any | null> {
  const geo = parent.geometry, solid = parent.replicadShape;
  if (!geo || !solid) return null;
  const [ua, va] = [0, 1, 2].filter(a => a !== axis);
  const lo = box.min.toArray(), hi = box.max.toArray();
  const key = `${axis}|${side}|${inset.toFixed(2)}|${from.toFixed(1)}|${to.toFixed(1)}|${[lo[ua], hi[ua], lo[va], hi[va]].map(x => Math.round(x)).join(',')}`;
  let bucket = _faceMaskCache.get(geo);
  if (!bucket) { bucket = new Map(); _faceMaskCache.set(geo, bucket); }
  const cached = bucket.get(key);
  if (cached) { try { return deepCopyShape(cached); } catch { bucket.delete(key); } }
  const { makeFace, basicFaceExtrusion, measureArea, Vector } = await import('replicad');
  // Kapağın baktığı düzlemsel gövde yüzleri (normal = eksen·yön, izdüşümü kapakla örtüşen); birden çok derinlik varsa kapağa en yakını.
  const front = side > 0 ? lo[axis] : hi[axis];
  const cands: Array<{ f: any; at: number }> = [];
  for (const f of solid.faces as any[]) {
    try {
      if (f.geomType !== 'PLANE') continue;
      const n = f.normalAt();
      if ([n.x, n.y, n.z][axis] * side < 0.999) continue;
      const b = f.boundingBox.bounds as [number[], number[]];
      if (Math.min(b[1][ua], hi[ua]) - Math.max(b[0][ua], lo[ua]) < 1 || Math.min(b[1][va], hi[va]) - Math.max(b[0][va], lo[va]) < 1) continue;
      cands.push({ f, at: (b[0][axis] + b[1][axis]) / 2 });
    } catch { /* okunamayan yüz atlanır */ }
  }
  if (!cands.length) return null;
  const near = cands.reduce((m, c) => Math.min(m, Math.abs(c.at - front)), Infinity);
  let mask: any = null;
  for (const c of cands) {
    if (Math.abs(c.at - front) > near + 1) continue;
    try {
      // replicad: outerWire() ve offset2D() üzerinde çağrıldığı nesneyi SİLER → her seferinde yüzün kopyasından alınır.
      let face = makeFace(c.f.clone().outerWire());
      if (Math.abs(inset) > 1e-3) {
        // Öteleme yönü tel yönüne bağlıdır: alanı küçülten (inset > 0) / büyüten işaret seçilir.
        const a0 = measureArea(face);
        for (const sgn of [-1, 1]) {
          try {
            const f2 = makeFace(c.f.clone().outerWire().offset2D(sgn * inset, 'arc'));
            const a2 = measureArea(f2);
            if (inset > 0 ? a2 < a0 - 1e-3 : a2 > a0 + 1e-3) { face = f2; break; }
          } catch { /* bu işaretle öteleme kurulamadı */ }
        }
        if (Math.abs(measureArea(face) - a0) < 1e-3) console.warn('[YAGO][MOTOR] kapak maskesi ötelenemedi (boşluksuz çevre kullanıldı)');
      }
      const d: [number, number, number] = [0, 0, 0]; d[axis] = from - c.at;
      const ev: [number, number, number] = [0, 0, 0]; ev[axis] = to - from;
      const prism = basicFaceExtrusion(face.translate(d[0], d[1], d[2]), new Vector(ev));
      mask = mask ? mask.fuse(prism) : prism;
    } catch (e) { console.warn('[YAGO][MOTOR] kapak maskesi kurulamadı:', errMsg(e)); }
  }
  // Saklanan maske derin kopyadır: kesimler paylaşılan TShape'in toleransını büyütüp sonraki rebuild'e taşımasın.
  if (mask) { if (bucket.size > 16) bucket.delete(bucket.keys().next().value as string); bucket.set(key, deepCopyShape(mask)); }
  return mask;
}

async function fitDoorToBody(rp: any, panel: Shape, parent: Shape, children: Shape[], vfs: VirtualFace[]): Promise<any> {
  const group = useAppStore.getState().doorGroups.find(g => g.id === (panel.parameters as any)?.doorGroupId);
  if (!group) return rp;
  const eg = edgeGapsOf(group);
  return fitSlabToBodyFace(rp, panel.id, parent, children, vfs, group.axis, group.side, Math.min(eg.uMin, eg.uMax, eg.vMin, eg.vMax),
    sheetPointsOf(vfOfPanel(panel, vfs), panelThickness(panel)));
}
/** Gövdenin DUVAR paneli: gövde yüzünün kendi düzleminde duran düz panel (iç üye / üst üste / taşınmış / dönmüş değil).
 *  İç kapak ve arkalık duvarın içinden geçemez. */
const isWallPanel = (p: Shape, vf: VirtualFace | undefined): boolean =>
  !!vf && !isInteriorPanel(p) && !isSheetPanel(p) && !panelHasRotation(p) && !vf.stackBaseVfId && !(vf.stackDepth && vf.stackDepth > 0) && !hasMoveSteps(p);
/** Levha gövde kutusunun DIŞINDA mı (çakma arkalık gövdenin arkasında durur → gövdeyle kesişimi boştur)? */
function slabOutsideBody(rp: any, parent: Shape, axis: 0 | 1 | 2): boolean {
  const bb = parent.geometry ? localBboxOf(parent.geometry) : null;
  if (!bb) return false;
  const b = rp.boundingBox.bounds as [number[], number[]], mid = (b[0][axis] + b[1][axis]) / 2;
  return mid < bb.min.getComponent(axis) || mid > bb.max.getComponent(axis);
}
/** Levhanın (kapak / arkalık) köşe noktaları: VF çokgeni + kalınlık. */
const sheetPointsOf = (vf: VirtualFace | undefined, t: number): THREE.Vector3[] | null => {
  if (!vf?.vertices?.length) return null;
  const n = vfNormal(vf);
  return vf.vertices.flatMap(v => { const p = toVector3(v); return [p, p.clone().addScaledVector(n, -t)]; });
};
/** Levha düz (eğik) panelin katmanına gerçekten giriyor mu? Girmiyorsa — kenarı panelin yüzüne tam oturuyorsa (2B kesici oraya kesmiştir) —
 *  kesim eş-düzlemli bir boolean olur: hiçbir şey çıkarmaz ama o kenarın yüzünü bozabilir (alanı 0 yüz, eksik mesh, yanlış hacim). */
function sheetMissesSlab(pts: THREE.Vector3[] | null | undefined, slab: Shape, pad: number): boolean {
  if (!pts?.length || !slab.geometry) return false;
  const n = largestFaceNormal(slab.geometry);
  if (!n) return false;
  const r = projRange(uniqueMeshPoints(slab.geometry), n), s = projRange(pts, n);
  return s.max <= r.min - pad + 0.3 || s.min >= r.max + pad - 0.3;
}
async function fitSlabToBodyFace(
  rp: any, selfId: string | null, parent: Shape, children: Shape[], vfs: VirtualFace[], axis: 0 | 1 | 2, side: 1 | -1, gap: number,
  /** Levhanın köşe noktaları (verilirse eğik panelle eş-düzlemli boş kesim atlanır). */ sheetPts?: THREE.Vector3[] | null,
): Promise<any> {
  const panel = { id: selfId }, group = { axis, side };
  try {
    const bb = rp.boundingBox.bounds as [number[], number[]];
    const box = new THREE.Box3(new THREE.Vector3(...bb[0]), new THREE.Vector3(...bb[1]));
    const a = group.axis;
    const mask = await bodyFaceMask(parent, a, group.side, box, gap, bb[0][a] - 20, bb[1][a] + 20);
    if (mask) { const cut = await intersectByCut(rp, mask); if (cut) { assertBounds(cut); rp = cut; } }
    // İç kapak: eğri / eğimli gövde panellerinin iç yüzünde (boşlukla) biter.
    for (const c of children) {
      if (c.id === panel.id || isSheetPanel(c) || isInteriorPanel(c)) continue;
      const fresh = shapeById(c.id);
      const vfc = vfs.find(f => f.id === (c.parameters as any)?.virtualFaceId);
      if (!fresh?.replicadShape || !fresh.geometry || !vfc) continue;
      const curved = isCurvedPanel(fresh), tilted = !curved && vfIsTilted(vfc);
      const cb = localBboxOf(fresh.geometry);
      if (!curved && !tilted) {
        // DÜZ gövde paneli, levhanın dikdörtgeninin İÇİNDE kaldıysa (sınır seçilmemiş: bombeli / basamaklı üstte dikdörtgen gövde
        // kenarına kadar uzanır): iç kapak onun içinden geçmesin → panelin kutusu, levha düzleminde boşluk kadar büyütülüp çıkarılır.
        // Sınır paneli kapağa zaten boşluk kadar uzaktır (kutular örtüşmez) → dokunulmaz. Dış kapak panelin önündedir → örtüşmez.
        if (!cb || !isWallPanel(fresh, vfc)) continue;
        const g = Math.max(gap, 0), sb = rp.boundingBox.bounds as number[][];
        const lo = cb.min.toArray(), hi = cb.max.toArray();
        for (const k of [0, 1, 2]) if (k !== a) { lo[k] -= g; hi[k] += g; }
        if ([0, 1, 2].some(k => Math.min(hi[k], sb[1][k]) - Math.max(lo[k], sb[0][k]) < 0.5)) continue;
        try { const cut = rp.cut(await createReplicadBoxAt(lo, hi)); assertBounds(cut); rp = cut; } catch { /* kesilemeyen panel atlanır */ }
        continue;
      }
      if (!cb || !boundsOverlapBox(rp.boundingBox.bounds, cb.clone().expandByScalar(Math.max(gap, 0) + 0.5))) continue;
      if (tilted && sheetMissesSlab(sheetPts, fresh, Math.max(gap, 0))) continue;
      try {
        const tools: any[] = [];
        if (curved && !hasAnySteps(fresh)) { const big = await curvedPanelSolid(parent, vfc, panelThickness(fresh) + Math.max(gap, 0)); if (big) tools.push(big); }
        if (!tools.length) {
          tools.push(deepCopyShape(fresh.replicadShape));
          if (tilted && gap > 0) tools.push(deepCopyShape(fresh.replicadShape).translate(-vfc.normal[0] * gap, -vfc.normal[1] * gap, -vfc.normal[2] * gap));
        }
        for (const t of tools) { const cut = rp.cut(t); assertBounds(cut); rp = cut; }
      } catch { /* kesilemeyen panel atlanır */ }
    }
  } catch (e) { console.warn('[YAGO][MOTOR] kapak gövde şekline sığdırılamadı:', errMsg(e)); }
  return rp;
}

// Önizlemenin gerçek şekli (Scene): kutu önizleme hemen çizilir, OCC ile kesilmişi hazır olunca yerini alır. Düz kutu gövdede null.
const soupOf = (rp: any): Float32Array => {
  const g = convertReplicadToThreeGeometry(rp), pos = g.getAttribute('position') as THREE.BufferAttribute, idx = g.getIndex();
  const n = idx ? idx.count : pos.count, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const v = idx ? idx.getX(i) : i; out[i * 3] = pos.getX(v); out[i * 3 + 1] = pos.getY(v); out[i * 3 + 2] = pos.getZ(v); }
  g.dispose();
  return out;
};
/** Birden çok parçaya bölünmüş üçgen çorbasından tohuma en yakın bağlı parça (eğik panelin öte yanındaki artık atılır). */
function soupComponentAt(soup: Float32Array, seed: Vec3): Float32Array {
  const nt = soup.length / 9, parent = new Int32Array(nt * 3), ids = new Map<string, number>();
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < nt * 3; i++) {
    const k = `${Math.round(soup[i * 3] * 20)},${Math.round(soup[i * 3 + 1] * 20)},${Math.round(soup[i * 3 + 2] * 20)}`;
    const j = ids.get(k);
    if (j == null) { ids.set(k, i); parent[i] = i; } else parent[i] = j;
  }
  for (let t = 0; t < nt; t++) { const a = find(t * 3), b = find(t * 3 + 1), c = find(t * 3 + 2); parent[b] = a; parent[c] = a; }
  const boxes = new Map<number, { min: number[]; max: number[]; tris: number[] }>();
  for (let t = 0; t < nt; t++) {
    const r = find(t * 3);
    let b = boxes.get(r);
    if (!b) { b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], tris: [] }; boxes.set(r, b); }
    b.tris.push(t);
    for (let i = t * 9; i < t * 9 + 9; i++) { const a = i % 3; if (soup[i] < b.min[a]) b.min[a] = soup[i]; if (soup[i] > b.max[a]) b.max[a] = soup[i]; }
  }
  if (boxes.size <= 1) return soup;
  let best: { tris: number[] } | null = null, bestD = Infinity;
  for (const b of boxes.values()) {
    let d = 0;
    for (let a = 0; a < 3; a++) { const q = Math.max(b.min[a] - seed[a], 0, seed[a] - b.max[a]); d += q * q; }
    if (d < bestD) { bestD = d; best = b; }
  }
  const out = new Float32Array(best!.tris.length * 9);
  best!.tris.forEach((t, i) => out.set(soup.subarray(t * 9, t * 9 + 9), i * 9));
  return out;
}
const previewNeedsRefine = (parent: Shape, cutters: Shape[]) => bodyIsShaped(parent) || cutters.some(isCurvedPanel);
const shapingPanels = (parent: Shape, ids?: string[]): Shape[] => {
  const st = useAppStore.getState();
  return childPanelsOf(parent.id, st.shapes).filter(p => !!p.replicadShape && !!p.geometry && !isSheetPanel(p) && (!ids || ids.includes(p.id))
    && (isCurvedPanel(p) || panelHasRotation(p) || vfIsTilted(vfOfPanel(p, st.virtualFaces))));
};
/** Önizleme katısını panellerin katısıyla keser; kutusu değmeyen / kesilemeyen panel atlanır. */
function cutByPanels(rp: any, panels: Shape[]): any {
  for (const p of panels) {
    try {
      if (!boundsOverlapBox(rp.boundingBox.bounds, localBboxOf(p.geometry)!)) continue;
      const cut = rp.cut(deepCopyShape(p.replicadShape)); assertBounds(cut); rp = cut;
    } catch { /* kesilemeyen panel atlanır */ }
  }
  return rp;
}
/** Hacim adayı: bölge kutuları ∩ gövde − (eğri / eğik sınır panelleri). `cutPanelIds` = ızgaradaki katı + eğik panel kimlikleri. */
export async function refinedVolumeSurface(parent: Shape, boxes: CavityBox[], seed: Vec3, cutPanelIds: string[]): Promise<Float32Array | null> {
  const cutters = shapingPanels(parent, cutPanelIds);
  if (!boxes.length || !parent.replicadShape || !previewNeedsRefine(parent, cutters)) return null;
  try {
    let rp: any = null;
    for (const b of boxes) { const x = await createReplicadBoxAt(b.min, b.max); rp = rp ? rp.fuse(x) : x; }
    if (bodyIsShaped(parent)) { const c = await intersectByCut(rp, deepCopyShape(parent.replicadShape)); if (!c) return null; rp = c; }
    return soupComponentAt(soupOf(cutByPanels(rp, cutters)), seed);
  } catch (e) { console.warn('[YAGO][MOTOR] hacim önizlemesi inceltilemedi:', errMsg(e)); return null; }
}
/** Kapak / arkalık adayı: motorun o levhaya uyguladığı şekillendirmeyle (kapak: ön yüz çevresi − boşluk; arkalık: gövde ∩, panel iç yüzü). */
export async function refinedSlabSurface(
  parent: Shape, kind: 'door' | 'back', poly: { normal: Vec3; vertices: Vec3[] }, thickness: number, axis: 0 | 1 | 2, side: 1 | -1, gap: number,
): Promise<Float32Array | null> {
  const st = useAppStore.getState();
  const kids = childPanelsOf(parent.id, st.shapes);
  if (!parent.replicadShape || !bodyIsShaped(parent)) return null;
  try {
    let rp = await createPanelFromVirtualFace(poly.vertices, poly.normal, thickness);
    if (!rp) return null;
    if (kind === 'door' || slabOutsideBody(rp, parent, axis)) rp = await fitSlabToBodyFace(rp, null, parent, kids, st.virtualFaces, axis, side, gap);
    else {
      rp = cutByPanels(await intersectWithBody(rp, parent, false), shapingPanels(parent).filter(p => !panelHasRotation(p)));
    }
    return soupOf(rp);
  } catch (e) { console.warn('[YAGO][MOTOR] levha önizlemesi inceltilemedi:', errMsg(e)); return null; }
}

// BÜYÜT & SIĞDIR: gövdeyle kesişim + SIRADA ÖNCE gelen kardeşlerle kesim; referansa OTURAN ('rest') panel onu kesmez.
async function fitRotatedPanel(
  rp: any, panel: Shape, parent: Shape, siblings: Shape[], orderOf: (s: Shape) => number, refContacts: Map<string, RefContact>,
  /** Katı zaten gövdeyle kesişmiş (taşınmamış eğri yüz paneli — curvedPanelSolid). */ bodyFitted = false,
): Promise<any> {
  let out = bodyFitted ? rp : await intersectWithBody(rp, parent, true);
  const myOrder = orderOf(panel);
  const myRefTargets = stepRefTargets(panel).rotate;
  const solidCut = !panelStampsRegions(panel, parent);
  for (const b of siblings) {
    if (b.id === panel.id || orderOf(b) >= myOrder) continue;
    if (isSheetPanel(b)) continue;   // kapak/arkalık gövde panelini kesmez
    if (myRefTargets.has(b.id) && refContacts.get(b.id) === 'rest') continue;
    const fresh = shapeById(b.id);
    if (!fresh?.replicadShape || !fresh.geometry) continue;
    if (miterJoined(parent, panel, fresh)) continue;   // gönye: iki panel açıortayda değer, kesilecek bir şey yok
    try {
      if (!boundsOverlapBox(out.boundingBox.bounds, localBboxOf(fresh.geometry)!)) continue;
      if (isCurvedPanel(panel) && !isCurvedPanel(fresh)) {
        // Eğri panel: yarım-uzay yok (bombe kardeşin düzlemlerinin iki yanında da durur) — kardeşin kutusuyla, doğrulamalı kesim.
        const tool = await curvedSiblingTool(parent, panel, fresh);
        out = (await robustCut(out, tool ?? fresh.replicadShape, tool ? null : fresh.geometry, `${panel.id} − ${fresh.id}`)).rp;
        continue;
      }
      // Düz basan kardeş: dönmüş basılan, kardeşin büyük yüz düzlemiyle (yarım-uzay) kesilir — katı çıkarması kıymık bırakıyordu.
      // Gövde yüzünü izleyen panelde yarım-uzay kardeşin kapsamıyla sınırlanır (yoksa ulaşmadığı yerden de malzeme alırdı).
      const half = !panelHasRotation(fresh) && !isCurvedPanel(fresh) ? await flatSiblingHalfSpace(out, fresh, panel, solidCut) : null;
      if (half === 'skip') continue;
      if (half && solidCut) {
        // Kapsamla sınırlı araç gerçek kesişimi almalı; Cut eş-düzlemde sessizce boş kalırsa sonsuz yarım-uzaya dönülür.
        const { measureVolume } = await import('replicad');
        const v0 = measureVolume(out);
        let cut: any = null;
        try { cut = out.clone().cut(half); assertBounds(cut); if (!(measureVolume(cut) < v0 - 1)) cut = null; } catch { cut = null; }
        if (!cut) {
          const inf = await flatSiblingHalfSpace(out, fresh, panel);
          if (inf === 'skip') continue;
          cut = inf ? out.cut(inf) : (await robustCut(out, fresh.replicadShape, fresh.geometry, `${panel.id} − ${fresh.id}`)).rp;
        }
        out = cut;
        continue;
      }
      out = half ? out.cut(half) : solidCut || isCurvedPanel(fresh) ? (await robustCut(out, fresh.replicadShape, fresh.geometry, `${panel.id} − ${fresh.id}`)).rp : out.cut(deepCopyShape(fresh.replicadShape));
    } catch { /* kardeş kesimi atlanır */ }
  }
  return out;
}

/** Hızlı kesişim sınaması (boolean'sız): `out`un bir mesh kenarı kardeşin levhasının içinden geçiyor mu? Evet kesin, hayır değil.
 *  Common sınaması 0,5–15 s sürüyordu. Adımlı kardeşte kullanılmaz. */
function slabPenetratedBy(out: any, sib: Shape, vfB: VirtualFace | undefined): boolean {
  if (!vfB?.vertices || vfB.vertices.length < 3 || vfB.curved || hasAnySteps(sib) || !sib.geometry) return false;
  try {
    const n = vfNormal(vfB);
    const { min: dMin, max: dMax } = projRange(uniqueMeshPoints(sib.geometry), n);
    const lo = dMin + 0.3, hi = dMax - 0.3;
    if (!(hi - lo > 0.5)) return false;
    const { u, v } = getFacePlaneAxes(n);
    const poly = vfB.vertices.map(c => toUV(toVector3(c), u, v)), N = poly.length;
    const insideBy = (q: { x: number; y: number }, margin: number): boolean => {
      let inside = false;
      for (let i = 0, j = N - 1; i < N; j = i++) {
        const a = poly[i], b = poly[j];
        const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey || 1;
        const tt = Math.max(0, Math.min(1, ((q.x - a.x) * ex + (q.y - a.y) * ey) / L2));
        if (Math.hypot(q.x - (a.x + ex * tt), q.y - (a.y + ey * tt)) < margin) return false;
        if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    };
    const m = out.mesh({ tolerance: 0.5, angularTolerance: 30 });
    const V = m.vertices as ArrayLike<number>, T = m.triangles as ArrayLike<number>;
    const d = new Float64Array(V.length / 3);
    for (let i = 0; i < d.length; i++) d[i] = V[i * 3] * n.x + V[i * 3 + 1] * n.y + V[i * 3 + 2] * n.z;
    const p = new THREE.Vector3();
    for (let t = 0; t + 2 < T.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = T[t + e], b = T[t + (e + 1) % 3];
      if (a > b) continue;   // her kenar bir kez (üçgen çiftinde ters yönlü ikizi atlanır; sınır kenarında fark etmez)
      const da = d[a], db = d[b];
      if ((da < lo && db < lo) || (da > hi && db > hi)) continue;
      const den = db - da;
      const t0 = Math.abs(den) < 1e-9 ? 0 : Math.max(0, Math.min(1, ((da < db ? lo : hi) - da) / den));
      const t1 = Math.abs(den) < 1e-9 ? 1 : Math.max(0, Math.min(1, ((da < db ? hi : lo) - da) / den));
      const tm = (t0 + t1) / 2;
      p.set(V[a * 3] + (V[b * 3] - V[a * 3]) * tm, V[a * 3 + 1] + (V[b * 3 + 1] - V[a * 3 + 1]) * tm, V[a * 3 + 2] + (V[b * 3 + 2] - V[a * 3 + 2]) * tm);
      const dp = p.dot(n);
      if (dp < lo || dp > hi) continue;
      if (insideBy(toUV(p, u, v), 0.5)) return true;
    }
  } catch { /* mesh alınamadı → boolean sınaması */ }
  return false;
}

/** Eğri yüz paneli, düz kardeşin yüzüne hangi yandan dayanıyor (ortak kıvrımdan): +1 dışbükey (panel kardeşin kavite yanında),
 *  −1 içbükey (panel kardeşin yüz düzleminin dış yanında — bombe yüzün ötesine sarkar), 0 komşu değil / teğet. */
function curvedJointSide(parent: Shape, vfCurved: VirtualFace, vfFlat: VirtualFace | undefined): number {
  const geo = parent.geometry, sid = curvedSurfaceIdOf(parent, vfCurved);
  if (!geo || sid === null || !vfFlat) return 0;
  const sf = panelSurfaceIds(parent, vfFlat);
  let sum = 0;
  for (const c of bodyCreases(geo)) {
    const i: 0 | 1 | null = sf.has(c.s[0]) && c.s[1] === sid ? 0 : sf.has(c.s[1]) && c.s[0] === sid ? 1 : null;
    if (i === null) continue;
    const ab = c.b.clone().sub(c.a), o = new THREE.Vector3().crossVectors(ab, c.n[i]);
    if (o.lengthSq() < 1e-9) continue;
    o.normalize();
    if (o.dot(c.a.clone().add(c.b).multiplyScalar(0.5).sub(c.c[i])) < 0) o.negate();   // düz yüzün dışına doğru
    const mo = c.n[i === 0 ? 1 : 0].dot(o);
    if (Math.abs(mo) >= 0.05) sum += Math.sign(mo) * ab.length();
  }
  return Math.sign(sum);
}
/** EĞRİ panel ↔ sırada önce gelen DÜZ kardeş: kesici kardeşin kendi çerçevesindeki KUTUSUDUR (eğik kardeşte de).
 *  Eskiden taraf panelin tık noktasından okunup kutu o yana sonsuza açılıyordu; bombe kardeşin düzlemlerinin iki yanında da durduğundan
 *  tık kardeşin öbür yanına düşünce bombenin uzaktaki kısmı da kesiliyordu. Kutu kalınlık ekseninde yalnız panelin BULUNMADIĞI yana
 *  (birleşim kıvrımından: dışbükey → gövdenin dışı, içbükey → kavite) sınırlı kadar taşar: araç yüzü panelin uç yüzüyle eş-düzlem
 *  kalmaz. Dönmüş kardeşte (çerçevesi VF'den okunamaz) null → gerçek katı. */
async function curvedSiblingTool(parent: Shape, panel: Shape, sib: Shape): Promise<any | null> {
  const vfP = vfOfPanel(panel), vfB = vfOfPanel(sib);
  if (!vfP?.curved || !vfB || !sib.geometry?.getAttribute('position')) return null;
  if ((((sib.parameters as any)?.transformSteps ?? []) as Array<{ type?: string }>).some(st => st?.type === 'rotate')) return null;
  const n = vfNormal(vfB), { u, v } = getFacePlaneAxes(n), pts = uniqueMeshPoints(sib.geometry);
  const rn = projRange(pts, n), ru = projRange(pts, u), rv = projRange(pts, v);
  if (!(rn.max - rn.min > 0.5) || !(ru.max - ru.min > 0.5) || !(rv.max - rv.min > 0.5)) return null;
  const side = curvedJointSide(parent, vfP, vfB), E = panelThickness(panel) * 3;
  if (side > 0) rn.max += E; else if (side < 0) rn.min -= E;
  // Kardeş gövde sınırına dayanıyorsa kutunun o yanı açılır (eş-düzlem yüzde Cut sessizce başarısız oluyordu) — yalnız eksene hizalı yönde.
  const bb = localBboxOf(parent.geometry);
  if (bb) for (const [w, r] of [[u, ru], [v, rv]] as const) {
    const a = Math.abs(w.x) > 0.999 ? 0 : Math.abs(w.y) > 0.999 ? 1 : Math.abs(w.z) > 0.999 ? 2 : -1;
    if (a < 0) continue;
    const pos = w.getComponent(a) > 0, lo = bb.min.getComponent(a), hi = bb.max.getComponent(a);
    if (Math.abs((pos ? r.min : -r.max) - lo) < 0.5) { if (pos) r.min = -100000; else r.max = 100000; }
    if (Math.abs((pos ? r.max : -r.min) - hi) < 0.5) { if (pos) r.max = 100000; else r.min = -100000; }
  }
  const at = (a: number, b: number) => vec3(new THREE.Vector3().addScaledVector(u, a).addScaledVector(v, b).addScaledVector(n, rn.max));
  return createPanelFromVirtualFace([at(ru.min, rv.min), at(ru.max, rv.min), at(ru.max, rv.max), at(ru.min, rv.max)], vec3(n), rn.max - rn.min, 0);
}
/** Düz kardeşin dönmüş paneli kesecek yarım-uzayı. 'skip' = kesişim yok; null = çapa kalınlık içinde (katı kesimine dön). */
async function flatSiblingHalfSpace(out: any, sib: Shape, panel: Shape, /** Yarım-uzay kardeşin düzlem-içi kutusuyla sınırlanır. */ limitToSibling = false): Promise<any | 'skip' | null> {
  /** Kesişim gerçek mi (en ince ekseni ≥ 0.2 mm)? null = Common boş döndü / fırlattı. */
  const probe = (): boolean | null => {
    try {
      const inter = out.clone().intersect(deepCopyShape(sib.replicadShape));
      assertBounds(inter);
      const bb = inter.boundingBox.bounds as number[][];
      return !!bb && Math.min(bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2]) >= 0.2;
    } catch { return null; }
  };
  let real = slabPenetratedBy(out, sib, vfOfPanel(sib)) ? true : probe();
  if (!real) {
    // "Kesişmiyor" kararı kesmeyle doğrulanır (Common boş dönebiliyor); Cut'tan sonra incelik sınaması yinelenir.
    const dv = await overlapVolumeByCut(out, deepCopyShape(sib.replicadShape));
    if (!(dv > 1)) return 'skip';
    real = probe() ?? dv >= 500;
    if (!real) return 'skip';
  }
  const vfB = vfOfPanel(sib);
  const n = vfB ? vfNormal(vfB) : largestFaceNormal(sib.geometry);
  if (!n) return null;
  const pts = uniqueMeshPoints(sib.geometry);
  const { min: dMin, max: dMax } = projRange(pts, n);
  const vfP = vfOfPanel(panel);
  const anchorArr = (vfP as any)?.regionAnchor as Vec3 | undefined;
  const anchor = anchorArr ? new THREE.Vector3(...anchorArr) : vfP ? new THREE.Vector3(...vfP.center) : null;
  if (!anchor) return null;
  const aD = anchor.dot(n);
  if (aD > dMin - 0.5 && aD < dMax + 0.5) return null;
  // Çapa dMax tarafındaysa d < dMax kesilir (yarım-uzay dMax düzleminden −n yönüne); dMin tarafındaysa d > dMin kesilir.
  const keepPlus = aD >= dMax;
  const toward = keepPlus ? n.clone() : n.clone().negate();   // kalan taraf
  // Kapsamla sınırlı araç: kardeşin kutusu, kesilen yana sonsuza uzatılmış (gerçek çok köşeli katıyla kesmek bozuk katı üretiyordu).
  const sb = limitToSibling && isFlatNormal(n) ? localBboxOf(sib.geometry) : null;
  if (sb) {
    const ax = Math.abs(n.x) > 0.9 ? 0 : Math.abs(n.y) > 0.9 ? 1 : 2, sgn = [n.x, n.y, n.z][ax] > 0 ? 1 : -1;
    const lo = sb.min.toArray(), hi = sb.max.toArray();
    // d = sgn·koordinat: keepPlus → d < dMax kesilir.
    if ((keepPlus ? 1 : -1) * sgn > 0) lo[ax] = -100000; else hi[ax] = 100000;
    // Kardeş gövde sınırına dayanıyorsa o yan da sonsuza açılır (eş-düzlem yüzde Cut sessizce başarısız oluyordu).
    const bb = localBboxOf(shapeById((panel.parameters as any)?.parentShapeId)?.geometry as THREE.BufferGeometry);
    if (bb) for (let a = 0; a < 3; a++) {
      if (a === ax) continue;
      if (Math.abs(lo[a] - bb.min.getComponent(a)) < 0.5) lo[a] = -100000;
      if (Math.abs(hi[a] - bb.max.getComponent(a)) < 0.5) hi[a] = 100000;
    }
    return createReplicadBoxAt(lo, hi);
  }
  return halfSpaceSlab(n.clone().multiplyScalar(keepPlus ? dMax : dMin), n, toward, 100000);
}

export interface RebuildOpts {
  /** Yalnız bu panel işlem gördü ve sıralama DEĞİŞMEDİ → mümkünse tek-panel modu. */
  changedPanelId?: string;
  orderChanged?: boolean;
  /** Yalnız bağlayıcı kesicisi değişen paneller yeniden üretilir (kural / bağlayıcı / tip değişimi); geri kalan hiçbir şeye dokunulmaz. */
  connectorsOnly?: boolean;
}
const inFlight = new Set<string>();
const pending = new Map<string, RebuildOpts | undefined>();

/* ───────── İŞ TAKİBİ: durum çubuğundaki ilerleme + animasyonla iç içe üretim ─────────
   Motor ana iş parçacığında çalışır (OCC eşzamanlı). İki şey yapılır:
   1) KARE PAYI — panel giriş animasyonu oynuyorsa (ya da başlamayı bekliyorsa) motor adım aralarında tarayıcıya bir kare çizdirir: üretim
      sürerken animasyon akar. Kare payı varken giriş kilitlenir (adım aralarında tıklama sahneyi değiştirmesin; bırakma olayları geçer).
   2) İLERLEME — iş 280 ms'yi geçer ya da kalan tahmin 450 ms'den uzunsa durum çubuğu ilerleme çubuğuna döner (store.engineBusy).
      Süreye göre: her adımın (panel × geçiş) ve işçideki her delik işinin süresi önceki üretimden hatırlanır.
   Motor oturumu (`engineLoad.active`) zincirleme üretimleri kapsar (160 ms ara); ilerleme işçideki delik işleri de bitince kapanır. */
const BUSY = { SHOW_AFTER: 280, SHOW_IF_LEFT: 450, PAINT_ANIM: 12, PAINT_BAR: 100, GRACE: 160, MIN_VISIBLE: 450 } as const;
interface BusyJob {
  t0: number; shown: boolean; shownAt: number; lastPaint: number; title: string; label: string; tick: number;
  /** Tahmini toplam / biten süre (ms) ve adım sayacı (motor adımları + işçideki delik işleri). */
  totalMs: number; doneMs: number; n: number; i: number;
  /** Gösterilen oran GERİ GİTMEZ: iş büyüyünce (zincirleme üretim) o anki oran taban olur, kalan yol yeni toplama göre dolar. */
  shownFrac: number; floor: number; floorDone: number; seenTotal: number;
  /** Açık tutulan oturumda (hızlı gövde) zincirdeki sonraki üretimler baştan bilinmez: ilerleme DUVAR SAATİYLE, aynı türden önceki
   *  oturumun gerçek süresine (`wallExpect`) göre. Öğrenilmiş süre yoksa (ilk kez) beklenen iş = ilk planın 5 katı (`expect`). */
  expect: number; wallExpect: number; kind: string;
  /** Planlanan adımların tahminleri (sırayla): biten işe adımın PLANDAKİ tahmini eklenir — o arada öğrenilen yeni tahmin değil (aynı panel
   *  bir üretimde iki kez işlenince biten iş toplamı aşıp çubuğu %99'a fırlatıyordu). */
  planQ: number[];
  cur: { key: string; pred: number; t: number } | null;
  /** İşçide bekleyen delik işleri: panel → tahmin. */
  decor: Map<string, number>;
  engineEnd: ReturnType<typeof setTimeout> | null; endTimer: ReturnType<typeof setTimeout> | null;
}
let _job: BusyJob | null = null;
/** Açık tutulan oturum sayısı (`withEngineSession`): zincirleme üretimden oluşan bir işlem (hızlı gövde) boyunca motor oturumu ve
 *  ilerleme kapanmaz. */
let _holds = 0;
/** Adımın son ölçülen süresi (panel id + geçiş; işçi işi `id|decor`): sonraki üretimin tahmini. */
const _stepMs = new Map<string, number>();
const stepKey = (panel: Shape, final: boolean) => `${panel.id}|${final ? 1 : 0}`;
/** Tür başına ölçülen ortalama süre (ara geçiş / son geçiş / işçideki kesim): ilk kez üretilen panelin tahmini — sabit varsayılan değil
 *  (yeni panel varsayılanla, aynı panelin sonraki adımı ölçümle sayılınca tahminler farklı birimde kalıyordu). */
const _avgMs = { pass: 18, final: 45, decor: 180 };
const avgKey = (key: string): keyof typeof _avgMs => (key.endsWith('|decor') ? 'decor' : key.endsWith('|1') ? 'final' : 'pass');
/** Tahmin: panelin son ölçümü; yoksa türün ortalaması (bombeli panel ağırdır). */
const stepPred = (panel: Shape, final: boolean) =>
  _stepMs.get(stepKey(panel, final)) ?? (isCurvedPanel(panel) || vfOfPanel(panel)?.curved ? Math.max(500, _avgMs.final * 4) : final ? _avgMs.final : _avgMs.pass);
const remember = (key: string, ms: number) => {
  if (_stepMs.size > 4000) _stepMs.clear();
  const old = _stepMs.get(key);
  _stepMs.set(key, old == null ? ms : old * 0.35 + ms * 0.65);
  const k = avgKey(key);
  _avgMs[k] = _avgMs[k] * 0.85 + ms * 0.15;
};
/** Bir kare çizilene kadar bekler (çizimden hemen sonra sürer). Sekme gizliyse / kare gelmezse beklemez. */
const nextPaint = (): Promise<void> => new Promise(res => {
  let done = false;
  const fin = () => { if (!done) { done = true; res(); } };
  if (typeof document === 'undefined' || document.hidden || typeof requestAnimationFrame !== 'function') { setTimeout(fin, 0); return; }
  requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = fin; ch.port2.postMessage(0); });
  setTimeout(fin, 200);
});
/** GİRİŞ KİLİDİ: kare payı verilirken basma / tıklama / tekerlek / tuş olayları yutulur (bırakma olayları geçer — süren sürükleme
 *  takılmasın). Dinleyiciler pencerede, yakalama aşamasında. İmleç "progress". */
let _locked = false, _lockInstalled = false;
const LOCK_EVENTS = ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keypress', 'touchstart', 'pointermove', 'mousemove', 'dragstart'];
function lockInput(on: boolean): void {
  if (_locked === on) return;
  _locked = on;
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('yago-busy-lock', on);
  if (!on || _lockInstalled || typeof window === 'undefined') return;
  _lockInstalled = true;
  for (const type of LOCK_EVENTS) window.addEventListener(type, e => {
    if (!_locked) return;
    e.stopImmediatePropagation();
    if (e.cancelable && type !== 'pointermove' && type !== 'mousemove') e.preventDefault();
  }, { capture: true, passive: false });
}
function publishBusy(): void {
  const j = _job; if (!j || !j.shown) return;
  const now = performance.now(), total = Math.max(1, j.totalMs, j.expect), elapsed = now - j.t0;
  // İş büyüdüyse yeniden tabanla: gösterilen oran olduğu yerden devam eder, geri düşmez; kalan yol yeni toplamla ölçülür.
  if (total > j.seenTotal) { j.floor = j.shownFrac; j.floorDone = j.doneMs; j.seenTotal = total; }
  const span = Math.max(1, total - j.floorDone);
  const toFrac = (done: number) => Math.min(1, j.floor + (1 - j.floor) * Math.max(0, done - j.floorDone) / span);
  // Açık oturumda öğrenilmiş süre varsa: geçen süre / beklenen süre (bitene dek en çok %97).
  const byWall = _holds && j.wallExpect > 0 ? Math.min(0.97, elapsed / j.wallExpect) : 0;
  const frac = Math.max(j.shownFrac, byWall || toFrac(j.doneMs));
  j.shownFrac = frac;
  const rate = j.doneMs > 60 ? Math.min(6, Math.max(0.3, elapsed / j.doneMs)) : 1;
  // Çubuğun bir sonraki durağı: süren motor adımı ya da (motor boştaysa) işçideki sıradaki delik işi.
  const pred = j.cur?.pred ?? (j.decor.size ? j.decor.values().next().value as number : 0);
  useAppStore.setState({ engineBusy: {
    title: j.title, detail: j.label, frac,
    fracTo: byWall ? Math.min(0.97, (elapsed + Math.max(120, pred * rate)) / j.wallExpect) : Math.max(frac, toFrac(j.doneMs + pred)), stepMs: Math.max(120, pred * rate),
    step: Math.min(j.i, j.n), steps: j.n, startedAt: Date.now() - elapsed,
    etaMs: byWall ? Math.max(0, j.wallExpect - elapsed) : j.doneMs > 60 ? Math.max(0, (total - j.doneMs) * rate) : null,
  } });
}
function closeStep(): void {
  const j = _job; if (!j?.cur) return;
  remember(j.cur.key, performance.now() - j.cur.t);
  j.doneMs += j.cur.pred; j.cur = null;
}
function maybeShow(j: BusyJob, now: number): void {
  if (!j.shown && (now - j.t0 > BUSY.SHOW_AFTER || j.totalMs - j.doneMs > BUSY.SHOW_IF_LEFT)) { j.shown = true; j.shownAt = now; publishBusy(); }
}
function jobEnter(): void {
  engineLoad.active = true;
  if (_job) {
    if (_job.engineEnd) { clearTimeout(_job.engineEnd); _job.engineEnd = null; }
    if (_job.endTimer) { clearTimeout(_job.endTimer); _job.endTimer = null; }
    return;
  }
  _job = { t0: performance.now(), shown: false, shownAt: 0, lastPaint: 0, title: 'Building panels', label: '', tick: entryGate.readyTick, totalMs: 0, doneMs: 0, n: 0, i: 0,
    shownFrac: 0, floor: 0, floorDone: 0, seenTotal: 0, expect: 0, wallExpect: 0, kind: '', planQ: [],
    cur: null, decor: new Map(), engineEnd: null, endTimer: null };
}
/** Oturum türü başına öğrenilmiş GERÇEK süre (ms) — tarayıcıda saklanır (bir sonraki hızlı gövdenin çubuğu toplam süreye göre dolar). */
const SESSION_WALL_KEY = 'yago.engine.sessionMs';
const _sessionWall = new Map<string, number>((() => {
  try { return Object.entries(JSON.parse(localStorage.getItem(SESSION_WALL_KEY) ?? '{}') as Record<string, number>).filter(([, v]) => v > 50 && v < 600000); }
  catch { return []; }
})());
/** Üretilecek adımlar işe eklenir (toplam süre tahmini büyür). */
function jobPlan(steps: Array<{ panel: Shape; final: boolean }>, title?: string): void {
  const j = _job; if (!j) return;
  let ms = 0;
  for (const s of steps) { const p = stepPred(s.panel, s.final); j.planQ.push(p); ms += p; }
  j.totalMs += ms;
  j.n += steps.length;
  if (_holds && j.kind && !j.expect && !j.wallExpect && ms > 0) j.expect = ms * 5;   // ilk kez: öğrenilmiş süre yok
  if (title && !j.shown) j.title = title;
}
/** Adım başı: önceki adım kapanır; animasyon oynuyorsa ya da çubuk açıksa tarayıcıya bir kare çizdirilir. */
async function jobStep(panel: Shape, final: boolean, name: string): Promise<void> {
  const j = _job; if (!j) return;
  closeStep();
  const now = performance.now();
  // Plansız adım (kuyruk boş) toplama da eklenir: biten iş toplamı aşmasın.
  let pred = j.planQ.shift();
  if (pred == null) { pred = stepPred(panel, final); j.totalMs += pred; j.n++; }
  j.cur = { key: stepKey(panel, final), pred, t: now }; j.i++;
  j.label = `${name} · ${Math.min(j.i, j.n)} of ${j.n}`;
  maybeShow(j, now);
  // Animasyon oynuyor ya da bekleyen panel az önce hazır oldu → kısa aralıkla kare; yalnız çubuk açıksa seyrek.
  const fresh = entryGate.waiting > 0 && entryGate.readyTick !== j.tick, anim = entryGate.playing > 0 || fresh;
  if ((anim || j.shown) && (fresh || !j.lastPaint || now - j.lastPaint > (anim ? BUSY.PAINT_ANIM : BUSY.PAINT_BAR))) {
    j.tick = entryGate.readyTick;
    lockInput(true);
    publishBusy();
    await nextPaint();
    j.lastPaint = performance.now();
    if (j.cur) j.cur.t = j.lastPaint;   // çizim beklemesi adımın süresine sayılmaz
  }
}
/** Birden çok üretimden oluşan işlemi (hızlı gövde) TEK oturum sayar: aradaki boşluklarda durum çubuğu kapanıp %0'dan yeniden başlamaz,
 *  giriş kilidi ve animasyon kapısı işlem boyunca sürer. */
export async function withEngineSession<T>(title: string, fn: () => Promise<T>): Promise<T> {
  jobEnter();
  const j = _job!, t0 = performance.now();
  if (!j.shown) j.title = title;
  if (!j.kind) { j.kind = title; j.wallExpect = _sessionWall.get(title) ?? 0; }
  _holds++;
  try { return await fn(); }
  finally {
    _holds--;
    // Öğren: bu tür oturumun gerçek süresi (sonraki oturumun çubuğu toplam süreye göre dolsun).
    if (!_holds && _job === j && j.kind === title) {
      const ms = performance.now() - t0, old = _sessionWall.get(title);
      _sessionWall.set(title, old == null ? ms : old * 0.4 + ms * 0.6);
      try { localStorage.setItem(SESSION_WALL_KEY, JSON.stringify(Object.fromEntries(_sessionWall))); } catch { /* depolama kapalı */ }
      j.expect = 0; j.wallExpect = 0;
    }
    jobLeave();
  }
}
/** Adım içi nefes: animasyon oynuyorsa ve son kareden beri 12 ms'den uzun çalışıldıysa bir kare çizdirilir (panel üretimiyle VF yeniden
 *  hesabı arasında — ikisi birlikte tek dilimde animasyonu takıyordu). */
async function jobBreath(): Promise<void> {
  const j = _job; if (!j || !(entryGate.playing > 0)) return;
  const now = performance.now();
  if (j.lastPaint && now - j.lastPaint <= BUSY.PAINT_ANIM) return;
  lockInput(true);
  const t = performance.now();
  await nextPaint();
  j.lastPaint = performance.now();
  if (j.cur) j.cur.t += j.lastPaint - t;   // çizim beklemesi adımın süresine sayılmaz
}
/** Delik işi işçiye gitti: ilerlemeye eklenir. */
function jobDecorAdd(panelId: string): void {
  if (!_job) jobEnter();
  const j = _job!, pred = _stepMs.get(`${panelId}|decor`) ?? _avgMs.decor;
  if (j.decor.has(panelId)) return;
  j.decor.set(panelId, pred); j.totalMs += pred; j.n++;
}
/** Delik işi bitti (`ms` null = başarısız / düşürüldü). */
function jobDecorDone(panelId: string, ms: number | null): void {
  if (ms != null) remember(`${panelId}|decor`, ms);
  const j = _job; if (!j) return;
  const pred = j.decor.get(panelId);
  if (pred != null) { j.decor.delete(panelId); j.doneMs += pred; j.i++; }
  if (!j.cur) j.label = j.decor.size ? `Cutting grooves and holes · ${j.decor.size} left` : 'Finishing';
  maybeShow(j, performance.now());
  publishBusy();
  jobLeave();
}
/** Kuyruk boşaldı: motor oturumu kısa bir aradan sonra kapanır (zincirleme üretim aynı oturuma eklenir); ilerleme, işçideki delik işleri
 *  de bitince kapanır. */
function jobLeave(): void {
  const j = _job; if (!j || inFlight.size || pending.size) return;
  closeStep();
  // Motor adımı yok, işçide kesim sürüyor: etiket onu söylesin.
  if (j.decor.size) { j.label = `Cutting grooves and holes · ${j.decor.size} left`; publishBusy(); }
  if (_holds) return;
  if (engineLoad.active && !j.engineEnd) {
    j.engineEnd = setTimeout(() => {
      j.engineEnd = null;
      if (_job !== j || inFlight.size || pending.size || _holds) return;
      engineLoad.active = false;
      lockInput(false);
      if (j.decor.size) { j.label = `Cutting grooves and holes · ${j.decor.size} left`; publishBusy(); }
      jobLeave();
    }, BUSY.GRACE);
    return;
  }
  if (engineLoad.active || j.decor.size) return;
  if (j.shown) { j.label = 'Finishing'; publishBusy(); }
  if (j.endTimer) clearTimeout(j.endTimer);
  j.endTimer = setTimeout(() => {
    if (_job !== j || inFlight.size || pending.size || _holds || j.decor.size) return;
    _job = null;
    if (j.shown) useAppStore.setState({ engineBusy: null });
  }, j.shown ? Math.max(120, BUSY.MIN_VISIBLE - (performance.now() - j.shownAt)) : 0);
}

export async function rebuildPanelsForParent(parentShapeId: string, opts?: RebuildOpts): Promise<void> {
  if (inFlight.has(parentShapeId)) {
    const prevFull = pending.has(parentShapeId) && pending.get(parentShapeId) === undefined;
    if (opts === undefined || !prevFull) pending.set(parentShapeId, opts);
    return;
  }
  inFlight.add(parentShapeId);
  jobEnter();
  try {
    await rebuildOnce(parentShapeId, opts);
  } finally {
    inFlight.delete(parentShapeId);
    if (pending.has(parentShapeId)) {
      const nextOpts = pending.get(parentShapeId);
      pending.delete(parentShapeId);
      await rebuildPanelsForParent(parentShapeId, nextOpts);
    }
    jobLeave();
  }
}

/** Gövdenin rebuild kuyruğu boşalana kadar bekler (rebuildPanelsForParent kuyruğa alınınca erken döner). */
export async function whenRebuildIdle(parentShapeId: string, timeoutMs = 60000): Promise<void> {
  const t0 = Date.now();
  while ((inFlight.has(parentShapeId) || pending.has(parentShapeId)) && Date.now() - t0 < timeoutMs) await new Promise(r => setTimeout(r, 40));
}

/** Gövde "oturdu" mu: motor `quietMs` boyunca hiç üretim yapmadı VE gövdede paneli henüz üretilmemiş VF yok. Başka bir işin SONRADAN
 *  tetiklediği üretimleri de yakalar (ör. arkalık VF'sinin paneli Assembly'de React efektiyle, addShape → tam üretim). Panelsiz VF
 *  ilerlemeden 3 sn kalırsa (onu üretecek arayüz açık değil) beklemez. En çok `timeoutMs`. */
export async function whenBodySettled(parentShapeId: string, quietMs = 450, timeoutMs = 30000): Promise<void> {
  const t0 = Date.now();
  // Sessizlik hem SÜREYLE hem ART ARDA GÖZLEMLE ölçülür: ana iş parçacığı uzun bir görevle (yeni panelin yerleşmesi) bloke kalınca gecikmiş
  // zamanlayıcı, kuyruktaki üretim isteğinden önce çalışıp "sessiz" diyordu; blok tek gözlem sayılır, bekleyen işlere sıra gelir.
  let quietSince = Date.now(), quietPolls = 0, lastMissing = -1, missingSince = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (inFlight.has(parentShapeId) || pending.has(parentShapeId)) { await whenRebuildIdle(parentShapeId, timeoutMs); quietSince = Date.now(); quietPolls = 0; continue; }
    const missing = useAppStore.getState().virtualFaces.filter(f => f.shapeId === parentShapeId && !f.hasPanel && !f.plinthId).length;
    if (missing !== lastMissing) { lastMissing = missing; missingSince = Date.now(); }
    if (missing && Date.now() - missingSince < 3000) { quietSince = Date.now(); quietPolls = 0; await new Promise(r => setTimeout(r, 60)); continue; }
    if (++quietPolls >= 8 && Date.now() - quietSince >= quietMs) return;
    await new Promise(r => setTimeout(r, 40));
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
    refIds.set(s.id, new Set([...r.extrude, ...r.move, ...r.rotate, ...r.post]));
  }
  const children = unsorted.sort((a, b) => {
    const aRefsB = refIds.get(a.id)!.has(b.id), bRefsA = refIds.get(b.id)!.has(a.id);
    if (aRefsB && !bRefsA) return 1;
    if (bRefsA && !aRefsB) return -1;
    return orderOf(a) - orderOf(b);
  });
  if (children.length === 0) return;

  // Tek-panel modu: yalnız değişen panel üretilir, VF'ler yeniden hesaplanmaz. Tam rebuild şart: basılan kardeş, iç köşe ortağı,
  // referans bağımlısı / pahı ya da gövdede raf / dikme / kapak / arkalık grubu varsa.
  const changedChild = opts?.changedPanelId ? children.find(c => c.id === opts.changedPanelId) : undefined;
  let singleMode = false;
  if (changedChild && !opts?.orderChanged) {
    const changedOrder = orderOf(changedChild);
    const pressesSibling = children.some(c => c.id !== changedChild.id && orderOf(c) > changedOrder);
    const vq = vfOfPanel(changedChild, fresh.virtualFaces);
    const cornerPartner = !!vq && children.some(c => {
      if (c.id === changedChild.id || orderOf(c) >= changedOrder) return false;
      const vp = vfOfPanel(c, fresh.virtualFaces);
      return !!vp && !!concaveCornerJoin(vp, vq, panelThickness(changedChild));
    });
    const hasRefDependents = children.some(c => c.id !== changedChild.id && refIds.get(c.id)!.has(changedChild.id));
    const onBody = (g: { shapeId: string }) => g.shapeId === parentShapeId;
    const boundsGroups = !isInteriorPanel(changedChild) && !isSheetPanel(changedChild)
      && (fresh.panelGroups.some(onBody) || fresh.doorGroups.some(onBody) || fresh.backGroups.some(onBody));
    singleMode = !(pressesSibling || cornerPartner || hasRefDependents || stepRefTargets(changedChild).rotate.size > 0 || boundsGroups);
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
      /** Sırada bu panelden ÖNCE gelen eğri yüz panellerinin oturduğu gövde yüzeyleri. */
      let _earlierSids: Set<number> | null = null;
      const earlierCurvedSids = (): Set<number> => {
        if (!_earlierSids) {
          _earlierSids = new Set();
          for (const c of children) {
            if (c.id === panel.id || orderOf(c) >= orderOf(panel)) continue;
            const sid = curvedSurfaceIdOf(parentFresh, vfOfPanel(c, vfsIn));
            if (sid !== null) _earlierSids.add(sid);
          }
        }
        return _earlierSids;
      };
      // Eğri yüz paneli: dönmüş panel gibi gövdeye sığdırılır ve önce gelen kardeşlerle kesilir; `curved` yazılır.
      const isCurved = !!vf.curved && !isSheetPanel(panel);
      // Kapak/arkalık gövdeyle sığdırılmaz/kesilmez (gövdenin önünde/arkasında durur); adımları yine uygulanır.
      const isRotated = !isSheetPanel(panel) && (panelHasRotation(panel) || vfTilted || isCurved);
      let genVerts = buildVerts;
      const hasXform = steps.some((st: any) => st?.type === 'move' || st?.type === 'rotate');
      // BİÇİMLENMİŞ GÖVDE (çizimle eğim / radüs): iç panel ve taşınmış düz panel de gövde katısıyla kesilir (eğik yüzden taşmasın).
      const shaped = !isSheetPanel(panel) && bodyIsShaped(parentFresh);
      let needsBodyClip = !isRotated && (isInteriorPanel(panel) ? shaped : shaped && hasXform);
      // Arkalık parçası biçimlenmiş gövdede eğimli / radüslü köşeden taşmasın diye gövdeyle kesilir (kapak kesilmez).
      if (isBackPanel(panel) && bodyIsShaped(parentFresh)) needsBodyClip = true;
      // Gövde yüzüne oturma (fitVertsToBodyEdges): taşınmamış / dönmemiş gövde paneli, gövde yüzünün kendi düzleminde.
      const edgeFit = shaped && !isCurved && !hasXform && !isInteriorPanel(panel) && !vf.stackBaseVfId && !(vf.stackDepth && vf.stackDepth > 0)
        // Eğri komşuya dik kenar HER ZAMAN büyütülüp gövdeyle kesilir (kenar gerçek yüzey olur): eğri panel sonra gelse de önce gelse de
        // düz panelin ucu ile eğri yüzey arasında hilal kalmaz.
        ? fitVertsToBodyEdges(parentFresh.geometry, vf.normal, buildVerts, thickness, vfTilted, 2) : null;
      if (edgeFit) { genVerts = edgeFit.verts; if (!isRotated && edgeFit.clip) needsBodyClip = true; }
      // Üst üste panel ve gövde yüzüne oturan eğik panel büyütülmez (içbükeyde levha gövdenin öbür ucuna uzanıyordu).
      // Kendi düzleminde dönen panel de büyütülmez: büyütülüp gövdeyle kesilen döndürülmüş dikdörtgen yine aynı levhayı veriyor, dönüş
      // görünmüyordu (üst / alt panel, raf Y'de dönmüyordu). Levha kendi ölçüsünde döner; taşan köşeleri gövde ve önceki kardeşler keser.
      const grow = isRotated && !isCurved && !vf.stackBaseVfId && !edgeFit && !rotatesInPlaneOnly(steps, vf) ? growForRotated : 0;
      let rp = isCurved ? await curvedPanelSolid(parentFresh, vf, thickness, earlierCurvedSids()) : null;
      const curvedFitted = !!rp && !hasXform;
      if (!rp) {
        try { rp = await createPanelFromVirtualFace(genVerts, vf.normal, thickness, grow); } catch { rp = null; }
        // Uzatılmış çokgen kurulamadıysa (kendini kesen dar çentik) özgün köşeler.
        if (!rp && edgeFit) rp = await createPanelFromVirtualFace(buildVerts, vf.normal, thickness, 0);
      }
      if (!rp) return;
      // İçbükey eğik kenar: panel komşu yüzün panel katmanının dibinde biter.
      // Eğri komşuda sınır iç yüzeye eğilir — o yüzün paneli sırada ÖNCEYSE teğet kalır (uzatma zaten onun içinde, kesilip gider).
      for (const l of edgeFit?.limits ?? []) {
        try { rp = await applyEdgeLimit(rp, l, !!l.dip && !earlierCurvedSids().has(l.dip.sid)); }
        catch { /* sınır kesilemedi → panel uzatılmış haliyle gövdeyle kesilir */ }
      }

      const { ops, resolvedRotations, quat: stepRot } = composeSteps(steps, vf);
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
          // KAYNAK NOKTA İLK ÇÖZÜMDE burada orana çevrilir: çözümün kullandığı kutunun (bu adımdan önceki levha) kendisine. Nokta levhanın
          // içinde de olabilir (çizimle kısalmış köşe) → oran kırpılmaz. Adıma yazılır; sonraki üretimler oranı okur.
          if (!op.sourceFrac && op.sourcePoint && op.targetFrac && !rpWorldBox.isEmpty()) {
            const sp = op.sourcePoint, lo = rpWorldBox.min.toArray(), hi = rpWorldBox.max.toArray();
            const fr = [0, 1, 2].map(k => (hi[k] - lo[k] < 1e-6 ? 0 : (sp[k] - lo[k]) / (hi[k] - lo[k]))) as Vec3;
            op.sourceFrac = fr;
            steps = steps.map((s: any) => { if (s.id !== op.stepId) return s; const { refSourcePoint: _drop, ...rest } = s; return { ...rest, refSourceFrac: fr }; }) as TransformStep[];
            stepsChanged = true;
          }
          const d = resolveRefTranslateDelta(op, rpWorldBox);
          // TEK KAYNAK: uygulanan delta panele yazılır; damgalama bunu okur (yeniden çözmez).
          refDeltaApplied = vec3(d);
          rp = rp.translate(d.x, d.y, d.z);
        } else {
          rp = rp.rotate(op.deg, vec3(op.pivot), vec3(op.axis));
        }
      }
      const refContacts = new Map<string, RefContact>();
      for (const r of resolvedRotations) if (r.targetId && r.contact) refContacts.set(r.targetId, r.contact);
      if (isRotated) {
        rp = await fitRotatedPanel(rp, panel, parentFresh, children, orderOf, refContacts, curvedFitted);
        if (isInteriorPanel(panel)) rp = await clipToGroupCavity(rp, panel);
      }
      else if (needsBodyClip) {
        // Oturtulmuş taşınmamış levhanın gövde kesişimi yalnız çokgene + gövdeye bağlı → gövde mesh'i başına saklanır.
        const clipKey = edgeFit && !hasXform && genVerts !== buildVerts && parentFresh.geometry
          ? `${thickness}|${vf.normal.join(',')}|${genVerts.map(q => q.map(x => x.toFixed(2)).join(',')).join(';')}` : null;
        const bucket = clipKey ? (_bodyClipCache.get(parentFresh.geometry) ?? _bodyClipCache.set(parentFresh.geometry, new Map()).get(parentFresh.geometry)!) : null;
        const hit = bucket?.get(clipKey!);
        let done = false;
        if (hit && edgeFit && !(edgeFit.limits.length)) { try { rp = deepCopyShape(hit); done = true; } catch { bucket!.delete(clipKey!); } }
        if (!done) {
          const status = { ok: true };
          rp = await intersectWithBody(rp, parentFresh, false, status);
          if (!status.ok && edgeFit && genVerts !== buildVerts) {
            // Uzatılmış levha gövdeye sığdırılamadı: uzatılmamış köşelerle (gövde yüzünün kendi bölgesi) yeniden — dışarı taşmaz.
            const plain = await createPanelFromVirtualFace(buildVerts, vf.normal, thickness, 0).catch(() => null);
            if (plain) rp = await intersectWithBody(plain, parentFresh, false, status);
          }
          if (status.ok && bucket && !(edgeFit!.limits.length)) { if (bucket.size > 16) bucket.delete(bucket.keys().next().value as string); bucket.set(clipKey!, deepCopyShape(rp)); }
        }
      }
      // Biçimlenmiş gövdede arkalık eğimli / eğri panellerin iç yüzünde biter (içlerinden geçip görünmesin).
      if (needsBodyClip && isBackPanel(panel)) {
        for (const c of children) {
          const fresh = c.id === panel.id || isSheetPanel(c) ? undefined : shapeById(c.id);
          if (!fresh?.replicadShape || !fresh.geometry) continue;
          const vfc = vfOfPanel(c, vfsIn);
          if (!(isCurvedPanel(fresh) || vfIsTilted(vfc))) {
            // DÜZ gövde paneli: arkalık onu KALINLIĞI BOYUNCA boydan boya geçiyorsa (sınırı değil — sınıra yalnız kanal payı kadar girer;
            // bombeli / basamaklı üstte dikdörtgen gövde kenarına kadar uzanır) panelin iç yüzünde biter.
            if (!isWallPanel(fresh, vfc)) continue;
            const cb = localBboxOf(fresh.geometry), sb = rp.boundingBox.bounds as number[][];
            if (!cb) continue;
            const lo = cb.min.toArray(), hi = cb.max.toArray();
            if ([0, 1, 2].some(k => Math.min(hi[k], sb[1][k]) - Math.max(lo[k], sb[0][k]) < 0.5)) continue;
            const tk = [0, 1, 2].reduce((m, k) => (hi[k] - lo[k] < hi[m] - lo[m] ? k : m), 0);
            if (!(sb[0][tk] < lo[tk] - 0.5 && sb[1][tk] > hi[tk] + 0.5)) continue;
          }
          try {
            if (!boundsOverlapBox(rp.boundingBox.bounds, localBboxOf(fresh.geometry)!)) continue;
            if (!isCurvedPanel(fresh) && sheetMissesSlab(sheetPointsOf(vf, thickness), fresh, 0)) continue;
            // Doğrulamalı kesim: Cut sessizce boş dönebiliyor (bombede arkalık eğri panelin içinden gövde yüzeyine kadar geçiyordu).
            rp = (await robustCut(rp, fresh.replicadShape, fresh.geometry, `${panel.id} − ${fresh.id}`)).rp;
          } catch { /* kesilemeyen panel atlanır */ }
        }
      }

      if (isDoorPanel(panel) && bodyIsShaped(parentFresh)) rp = await fitDoorToBody(rp, panel, parentFresh, children, vfsIn);
      // Çakma (dış) arkalık gövdenin arkasındadır: gövdeyle kesişemez → baktığı arka yüzün çevresiyle (boşluksuz) kesişir, kemeri izler.
      if (isBackPanel(panel) && bodyIsShaped(parentFresh)) {
        const bg = useAppStore.getState().backGroups.find(g => g.id === (panel.parameters as any)?.backGroupId);
        if (bg && slabOutsideBody(rp, parentFresh, bg.axis)) rp = await fitSlabToBodyFace(rp, panel.id, parentFresh, children, vfsIn, bg.axis, bg.side, 0);
      }

      let meshed: { shape: any; geometry: THREE.BufferGeometry } | null = null;
      let dimsUpdate: { width: number; height: number; depth: number } | null = null;
      let resolvedStepsUpdate: ExtrudeStep[] | null = null;
      const extrudeSteps: ExtrudeStep[] | undefined = (panel.parameters as any)?.extrudeSteps;
      if (Array.isArray(extrudeSteps) && extrudeSteps.length > 0) {
        try {
          const ext = await applyExtrudeSteps(rp, extrudeSteps, useAppStore.getState().shapes);
          if (ext) {
            // Katı değişmediyse (yalnız 0 mm'e çözülen ref adımı) mesh/ölçü dokunulmaz; çözülen değer yine yazılır.
            if (ext.shape !== rp) {
              rp = ext.shape;
              meshed = { shape: ext.shape, geometry: ext.geometry };
              const es = localBboxOf(ext.geometry)!.getSize(new THREE.Vector3());
              const dsz = [es.x, es.y, es.z].sort((a, b) => b - a);
              dimsUpdate = { width: round1(dsz[0]), height: round1(dsz[1]), depth: round1(dsz[2]) };
            }
            resolvedStepsUpdate = mergeResolved(extrudeSteps, ext.resolved) as ExtrudeStep[] | null;
          }
        } catch (err) {
          console.error('[YAGO][MOTOR] extrude adımı hatası:', panel.id, errMsg(err));
        }
      }

      if (!panelHasRotation(panel) && !isSheetPanel(panel) && !isCurved) rp = await cutByRotatedPressers(rp, panel, vf, children.filter(c => !miterJoined(parentFresh, panel, c, vfsIn)), vfsIn, orderOf);
      await shapeRefRotateTargets(rp, panel, vf, children, orderOf, refContacts, updateShape);
      // İÇ İÇE GEÇME KORUMASI: son geçişte, sırada önce üretilen kardeşlerin katısı bu katıdan çıkarılır (gerçek çakışma varsa).
      if (groove && !isRotated && !isSheetPanel(panel) && !vf.stackBaseVfId) {
        const myIdx = children.findIndex(c => c.id === panel.id);
        const now = useAppStore.getState().shapes;
        // Adımlı panel kendi kurallarıyla; yalnız önce gelen eğri panelle kesilir (eğri panel damgalamadığından tek kesişim yeri).
        const stepped = hasAnySteps(panel);
        const earlier = children.slice(0, Math.max(0, myIdx)).map(c => shapeById(c.id, now))
          .filter((c): c is Shape => !!c && !isSheetPanel(c) && (!stepped || isCurvedPanel(c)) && !miterJoined(parentFresh, panel, c, vfsIn));
        rp = await cutByEarlierOverlaps(rp, panel, earlier);
      }

      // Son geçiş kesicileri — arkalık kanalı + aksesuar delikleri: yalnız görünüm / katı (kesilmemiş mesh `ungroovedGeometry`).
      // Tek boolean (cutWithTools); aynı mesh + kesiciler için sonuç yeniden kullanılır (_grooveCache). Delik kaydı (Shape.holes) yazılır.
      let ungrooved: THREE.BufferGeometry | null = null;
      let grooved: { rp: any; geometry: THREE.BufferGeometry; holes: PanelHole[] } | null = null;
      // Delikleri işçiye verilecekse: plan + kesilecek katının baytları (yazımdan sonra kuyruğa girer).
      let decor: { plan: DecorPlan; bytes: Uint8Array } | null = null;
      const feats = groove ? liveSketchFeatures(panel) : [];
      const postSteps = groove ? postExtrudeStepsOf(panel) : [];
      if (groove && !isSheetPanel(panel)) {
        const boxes = isRotated ? [] : mergeGrooveCutters(backGrooveCuttersFor(panel));
        // Bağlayıcılar: bu panelin B (uç + yüz) ya da A (temas yüzü) olduğu birleşimlerin delikleri + pocket / line katıları.
        const conn = connectorCutsFor(panel);
        _connSig.set(panel.id, conn.holes.length || conn.solids.length ? `${conn.holes.map(h => h.key).join(';')}~${conn.solids.map(c => c.key).join(';')}` : '');
        const plinthHoles = plinthHoleCuttersFor(panel), holes = [...plinthHoles, ...conn.holes];
        if (boxes.length || holes.length || conn.solids.length) {
          const base = meshed && meshed.shape === rp ? meshed.geometry : convertReplicadToThreeGeometry(rp);
          const pb = localBboxOf(base);
          const liveBoxes = pb ? boxes.filter(c => boxTouches(c, pb)) : [];
          const liveHoles = pb ? holes.filter(c => boxTouches(holeCutterBox(c), pb)) : [];
          const liveSolids = pb ? conn.solids.filter(c => boxTouches(c.box, pb)) : [];
          // Kesim ARAÇLARI: bağlayıcı noktaları birim araç olarak (araç–araç kesişimi önceden çözülmüş), kalanlar tek tek.
          const tool = pb ? {
            holes: [...plinthHoles, ...conn.loose.holes].filter(c => boxTouches(holeCutterBox(c), pb)),
            solids: conn.loose.solids.filter(c => boxTouches(c.box, pb)), units: conn.units.filter(u => boxTouches(u.box, pb)),
          } : { holes: [], solids: [], units: [] };
          if (pb && (liveBoxes.length || liveHoles.length || liveSolids.length)) {
            const pbox = { min: [pb.min.x, pb.min.y, pb.min.z] as Vec3, max: [pb.max.x, pb.max.y, pb.max.z] as Vec3 };
            const sig = `${meshSignature(base)}|${liveBoxes.map(c => c.min.map(round1).join(',') + '/' + c.max.map(round1).join(',')).join(';')}|${liveHoles.map(c => c.key).join(';')}|${liveSolids.map(c => c.key).join(';')}`;
            const holeRecords = liveHoles.map(c => panelHoleRecord(c, pbox));
            const hit = _grooveCache.get(panel.id);
            if (hit && hit.sig === sig) { ungrooved = base; grooved = { rp: hit.rp, geometry: hit.geometry, holes: hit.holes }; }
            else {
              // KESİM İŞÇİSİ: aynı tek boolean (kanal + delikler + bağlayıcı katıları) işçide; panel şimdilik kesilmemiş yazılır. Kesimden
              // sonra katıya bir şey uygulanmıyorsa (çizim adımı / çizim sonrası extrude yok) ve işçi hazırsa; aksi halde burada, eski yol.
              if (!feats.length && !postSteps.length && cutWorkerReady()) {
                try {
                  decor = {
                    plan: { sig, base: rp, specs: specsOf(liveBoxes, tool.holes, tool.solids, tool.units), pb: pbox, holes: holeRecords, simplify: liveBoxes.length > 0 },
                    bytes: shapeToBytes(window.__ocInstance, rp),
                  };
                  ungrooved = base; grooved = { rp, geometry: base, holes: [] };
                } catch (err) { console.warn('[YAGO][KESİM] katı işçiye aktarılamadı, burada kesiliyor:', errMsg(err)); decor = null; }
              }
              if (!decor) {
                const cut = await cutByTools(rp, liveBoxes, tool.holes, pbox, tool.solids, tool.units);
                if (cut) {
                  ungrooved = base; grooved = { rp: cut, geometry: convertReplicadToThreeGeometry(cut), holes: holeRecords };
                  if (_grooveCache.size > 200) _grooveCache.clear();
                  _grooveCache.set(panel.id, { sig, rp: cut, geometry: grooved.geometry, holes: holeRecords });
                }
              }
            }
          }
        }
      }
      const rpBare = rp;   // kanal / delik kesilmeden önceki katı (biçim ağı için)
      if (grooved) rp = grooved.rp;

      // Çizim adımları: yalnız son geçişte katının üstüne; ayak izi / damga / sıralama çizimden etkilenmez. Sonuç _sketchCache'te.
      let preGeo: THREE.BufferGeometry | null = null;
      let sketched: { rp: any; geometry: THREE.BufferGeometry } | null = null;
      let sketchErrors: Record<string, string> = {};
      let sketchArgs: { baseGeo: THREE.BufferGeometry; vars: Record<string, number> } | null = null;
      if (feats.length) {
        preGeo = grooved ? grooved.geometry : meshed && meshed.shape === rp ? meshed.geometry : convertReplicadToThreeGeometry(rp);
        const baseGeo = ungrooved ?? preGeo;
        // Parametric adımların formül değişkenleri üst gövdeden okunur (ölçüler + özel parametreler); değerleri önbellek anahtarına girer.
        const vars = feats.some(f => f.mode === 'points') ? sketchVarsOf((shapeById(parentShapeId) ?? parentFresh)?.parameters) : {};
        sketchArgs = { baseGeo, vars };
        const sig = `${meshSignature(preGeo)}|${meshSignature(baseGeo)}|${stepRot.toArray().map(x => x.toFixed(5)).join(',')}|${sketchFeaturesKey(feats)}|${JSON.stringify(vars)}`;
        const hit = _sketchCache.get(panel.id);
        if (hit && hit.sig === sig) { sketched = hit.rp ? { rp: hit.rp, geometry: hit.geometry! } : null; sketchErrors = hit.errors; }
        else {
          const res = await applySketchFeatures(rp, baseGeo, feats, stepRot, vars);
          sketched = res.applied ? { rp: res.shape, geometry: convertReplicadToThreeGeometry(res.shape) } : null;
          sketchErrors = res.errors;
          if (_sketchCache.size > 200) _sketchCache.clear();
          _sketchCache.set(panel.id, { sig, rp: sketched?.rp ?? null, geometry: sketched?.geometry ?? null, errors: sketchErrors });
        }
        if (sketched) { ungrooved = baseGeo; rp = sketched.rp; }
      }

      // Çizim sonrası extrude (`postExtrudeSteps`): çizim uygulanmış son katının yüzlerine; yalnız son geçişte, katı düzeyinde.
      let posted: THREE.BufferGeometry | null = null;
      let resolvedPostUpdate: ExtrudeStep[] | null = null;
      if (postSteps.length) {
        try {
          const before = sketched ? sketched.geometry : preGeo ?? (grooved ? grooved.geometry : meshed && meshed.shape === rp ? meshed.geometry : convertReplicadToThreeGeometry(rp));
          const ext = await applyExtrudeSteps(rp, postSteps, useAppStore.getState().shapes);
          if (ext) {
            if (ext.shape !== rp) { if (!ungrooved) ungrooved = before; rp = ext.shape; posted = ext.geometry; }
            resolvedPostUpdate = mergeResolved(postSteps, ext.resolved) as ExtrudeStep[] | null;
          }
        } catch (err) {
          console.error('[YAGO][MOTOR] çizim sonrası extrude hatası:', panel.id, errMsg(err));
        }
      }

      // Katı extrude'dan sonra değişmediyse mevcut mesh yeniden kullanılır (aynı tessellation).
      const geometry = posted ?? (sketched ? sketched.geometry : preGeo ?? (grooved ? grooved.geometry : meshed && meshed.shape === rp ? meshed.geometry : convertReplicadToThreeGeometry(rp)));
      if (ungrooved) ungrooved.userData.groovedUuid = geometry.uuid;
      // BİÇİM AĞI (`shapedGeometry`, bkz. Geometry.outlineGeometry): çizim / çizim sonrası extrude uygulanmış, kanal / delik / bağlayıcı
      // kesilmemiş ağ. Kesici yoksa son ağın kendisi; varsa aynı adımlar kesilmemiş katıya bir kez daha uygulanır (sonuç saklanır).
      let shapedGeo: THREE.BufferGeometry | null = null;
      if (sketched || posted) {
        if (!grooved) shapedGeo = geometry;
        else {
          const cacheable = !postSteps.some((s: any) => s?.refShapeId);
          const sig = `${meshSignature(sketchArgs?.baseGeo ?? ungrooved ?? geometry)}|${stepRot.toArray().map(x => x.toFixed(5)).join(',')}|${sketchFeaturesKey(feats)}|${JSON.stringify(sketchArgs?.vars ?? {})}|${JSON.stringify(postSteps)}`;
          const hit = cacheable ? _shapedCache.get(panel.id) : undefined;
          if (hit && hit.sig === sig) shapedGeo = hit.geometry;
          else {
            try {
              let bare = rpBare, g: THREE.BufferGeometry | null = null;
              if (sketched && sketchArgs) { const res = await applySketchFeatures(bare, sketchArgs.baseGeo, feats, stepRot, sketchArgs.vars); if (res.applied) bare = res.shape; }
              if (posted) { const ext = await applyExtrudeSteps(bare, postSteps, useAppStore.getState().shapes); if (ext && ext.shape !== bare) { bare = ext.shape; g = ext.geometry; } }
              shapedGeo = g ?? convertReplicadToThreeGeometry(bare);
              if (_shapedCache.size > 200) _shapedCache.clear();
              if (cacheable) _shapedCache.set(panel.id, { sig, geometry: shapedGeo });
            } catch (err) { console.warn('[YAGO][MOTOR] biçim ağı kurulamadı:', panel.id, errMsg(err)); }
          }
        }
        if (shapedGeo && shapedGeo !== geometry) shapedGeo.userData.shapedFor = geometry.uuid;
      }
      const paramPatch: any = {};
      // Uygulanamayan çizim adımları (boş profil, yüz dışında kalan şekil…) panelde işaretlenir → adım listesinde uyarı.
      if (groove) {
        const errs = Object.keys(sketchErrors).length ? sketchErrors : undefined;
        if (JSON.stringify((panel.parameters as any)?.sketchErrors ?? null) !== JSON.stringify(errs ?? null)) paramPatch.sketchErrors = errs;
      }
      if (dimsUpdate) Object.assign(paramPatch, dimsUpdate);
      if (!!(panel.parameters as any)?.curved !== isCurved) paramPatch.curved = isCurved || undefined;
      if (resolvedStepsUpdate) paramPatch.extrudeSteps = resolvedStepsUpdate;
      if (resolvedPostUpdate) paramPatch.postExtrudeSteps = resolvedPostUpdate;
      if (refDeltaApplied) paramPatch._refDeltaApplied = refDeltaApplied;
      if (stepsChanged) paramPatch.transformSteps = steps;
      // ANINDA YAZ: sonraki panel ve VF yeniden hesabı güncel ayak izini görsün.
      updateShape(panel.id, {
        // Panel geometrisi gövde-yerel → dönüşümü gövdeninkiyle aynı olmalı.
        geometry, position: parentPos, rotation: [...(parentFresh.rotation || [0, 0, 0])] as Vec3, scale: [...(parentFresh.scale || [1, 1, 1])] as Vec3,
        replicadShape: rp, ungroovedGeometry: ungrooved ?? undefined, shapedGeometry: shapedGeo ?? undefined, holes: grooved?.holes.length ? grooved.holes : undefined,
        ...(Object.keys(paramPatch).length ? { parameters: { ...panel.parameters, ...paramPatch } } : {}),
      } as any);
      if (groove) {
        // Delikler işçide → beklenen sonuç kaydedilir; yoksa eski bekleyen iş geçersizdir (sonucu yazılmaz).
        if (decor) scheduleDecor(panel.id, decor.plan, decor.bytes, geometry.uuid);
        else { _decorWant.delete(panel.id); entryGate.decor.delete(panel.id); }
        // Giriş animasyonu bu panelin son geçiş geometrisini bekliyordu.
        entryGate.ready.add(panel.id); entryGate.readyTick++;
      }
    } catch (err) {
      console.error('[YAGO][MOTOR] panel üretim hatası:', panel.id, errMsg(err));
    }
  };

  // BAĞLAYICI DÜZELTMESİ: birleşim, komşunun SON geometrisinden okunur. Panel üretilirken komşusu henüz eski / hiç üretilmemiş olabilir
  // (tek-panel modu, geçiş içi sıra) → üretim bitince kesici imzası değişen paneller bir kez daha üretilir (ayak izi değişmez, VF'ye dokunulmaz).
  /** İş takibiyle üretim: adım bekleme penceresine yazılır (ad = VF adı), gerekiyorsa önce bir kare çizdirilir. */
  const buildStep = async (panel: Shape, vfs: VirtualFace[], final: boolean) => {
    await jobStep(panel, final, panelNameOf(vfOfPanel(panel, vfs)));
    await buildPanel(panel, vfs, final);
  };
  const connectorFixup = async (vfs: VirtualFace[], title?: string) => {
    for (let round = 0; round < 2; round++) {
      const st = useAppStore.getState();
      const stale = children.filter(c => { const p = shapeById(c.id, st.shapes); return !!p && !isSheetPanel(p) && connectorCutSig(p, st) !== (_connSig.get(c.id) ?? ''); });
      if (!stale.length) return;
      jobPlan(stale.map(panel => ({ panel, final: true })), title);
      for (const c of stale) await buildStep(c, vfs, true);
    }
  };
  // Yalnız bağlayıcı: kesicisi değişen paneller son geçişle yeniden üretilir (ayak izi değişmez, VF'ye dokunulmaz).
  if (opts?.connectorsOnly) {
    await connectorFixup(useAppStore.getState().virtualFaces.filter(f => f.shapeId === parentShapeId), 'Cutting connector holes');
    return;
  }
  if (singleMode) {
    const vfs = useAppStore.getState().virtualFaces.filter(f => (f as any).shapeId === parentShapeId);
    jobPlan([{ panel: changedChild!, final: true }]);
    await buildStep(changedChild!, vfs, true);
    await connectorFixup(vfs);
    return;
  }

  // İKİ GEÇİŞ: her panelden sonra VF'ler currentVfs üzerinden yeniden hesaplanır; 2. geçiş bayat komşu bölgelerini düzeltir.
  const recalc = (vfs: VirtualFace[]) => {
    const st = useAppStore.getState();
    const parentNow = shapeById(parentShapeId, st.shapes) || parentFresh;
    return recalculateVirtualFacesForShape(parentNow, vfs, st.shapes, st.panelGroups);
  };
  let currentVfs = recalc(useAppStore.getState().virtualFaces);
  jobPlan([0, 1].flatMap(pass => children.map(panel => ({ panel, final: pass === 1 }))));
  for (let pass = 0; pass < 2; pass++) {
    for (const panel of children) {
      await buildStep(panel, currentVfs, pass === 1);
      await jobBreath();
      currentVfs = recalc(currentVfs);
    }
  }
  await connectorFixup(currentVfs);
  // Yalnız regen alanları yazılır — rebuild sürerken kullanıcının değiştirdiği alanlar ezilmez.
  const patches = new Map<string, Partial<VirtualFace>>();
  for (const f of currentVfs) {
    if (f.shapeId !== parentShapeId) continue;
    const p: any = {};
    for (const k of VF_REGEN_FIELDS) if (k in f) p[k] = (f as any)[k];
    patches.set(f.id, p);
  }
  useAppStore.setState(st => ({ virtualFaces: st.virtualFaces.map(f => (patches.has(f.id) ? { ...f, ...patches.get(f.id) } : f)) }));
  for (const sync of [syncPanelGroups, syncDoorGroups, syncBackGroups]) {
    try { sync(parentShapeId); } catch { /* grup senkron hatası rebuild sonucunu bozmaz */ }
  }
}

// ARKALIK KANALI yardımcıları: kanallı sonuç önbelleği (panel id → kanalsız mesh imzası + kesiciler), mesh imzası, kesici birleştirme.
/** Kesici kutu panel kutusuna (0.01 pay) değiyor mu? */
const boxTouches = (c: CavityBox, b: THREE.Box3) => !(c.max[0] <= b.min.x + 0.01 || c.min[0] >= b.max.x - 0.01
  || c.max[1] <= b.min.y + 0.01 || c.min[1] >= b.max.y - 0.01 || c.max[2] <= b.min.z + 0.01 || c.min[2] >= b.max.z - 0.01);
const _grooveCache = new Map<string, { sig: string; rp: any; geometry: THREE.BufferGeometry; holes: PanelHole[] }>();
/** Çizim adımı sonucu önbelleği: panel id → (adım öncesi katı + adımlar) imzası. rp null = hiçbir adım uygulanamadı. */
/** Panelin son üretimde kullandığı bağlayıcı kesici imzası ('' = yok): üretim sonunda güncel imzayla karşılaştırılır (connectorFixup). */
const _connSig = new Map<string, string>();
const _sketchCache = new Map<string, { sig: string; rp: any | null; geometry: THREE.BufferGeometry | null; errors: Record<string, string> }>();
/** Biçim ağı (çizim uygulanmış, kesicisiz) — panel başına son sonuç. */
const _shapedCache = new Map<string, { sig: string; geometry: THREE.BufferGeometry }>();
/** BİRİM ARAÇ önbelleği (ConnectorService.ConnUnitCut): kanonik çerçevede birleştirilmiş bağlayıcı aracı (ana iş parçacığı; işçinin kendi
 *  önbelleği var). */
const _unitTools: UnitCache = new Map();
/** Kesiciler → taşınabilir tarifler (CutWorker.ToolSpec). */
const specsOf = (boxes: CavityBox[], holes: HoleCutter[], solids: ConnSolidCut[] = [], units: ConnUnitCut[] = []): ToolSpec[] => [
  ...boxes.map((c): ToolSpec => ({ k: 'box', min: c.min, max: c.max })), ...holes.map(holeSpec), ...solids.map(c => c.spec), ...units.map(unitSpec),
];
/** Kutu + delik + bağlayıcı kesicileri ana iş parçacığında, tek boolean (CutWorker.cutBySpecs). Hiçbiri kesilemezse null. */
async function cutByTools(rp: any, boxes: CavityBox[], holes: HoleCutter[], pb: CavityBox, solids: ConnSolidCut[] = [], units: ConnUnitCut[] = []): Promise<any | null> {
  return cutBySpecs(await initReplicad(), rp, specsOf(boxes, holes, solids, units), pb, boxes.length > 0, _unitTools);
}

/* ───────── SON GEÇİŞ KESİMİ İŞÇİDE: arkalık kanalı + ayak / bağlayıcı delikleri ─────────
   Panelin son geçişi KESİLMEMİŞ katıyla biter ve hemen yazılır; aynı tek boolean (eski yolla birebir: araçlar, sıra, `simplify`) kesim
   işçisinde yapılır, sonuç gelince aynı panele yazılır. Ana iş parçacığı kesimi beklemez → panel giriş animasyonu akar, kanal ve delikler
   animasyon sırasında belirir (animasyon iş bitene dek sonunda yavaşlar).
   Neden güvenli: ayak izi / damga zaten kesilmemiş ağdan okunur (`ungroovedGeometry`); kardeş kesiminde (`cutByEarlierOverlaps`) kanalın
   hacmine giren tek parça arkalıktır ve arkalık / kapak bu kesime hiç girmez; delikler panelin kendi hacminde.
   Yalnız kesimden SONRA katıya bir şey uygulanmayan panelde (çizim adımı / çizim sonrası extrude yok) ve işçi hazırken; aksi halde eski yol. */
interface DecorPlan { sig: string; base: OccShape; specs: ToolSpec[]; pb: CutBox; holes: PanelHole[]; simplify: boolean }
/** Panel başına beklenen süsleme: imza + yazıldığında GÖSTERİLEN geometri. Sonuç ancak ikisi hâlâ tutuyorsa yazılır (o arada yeniden
 *  üretilen panelde yeni iş yoldadır; eski sonuç atılır). */
const _decorWant = new Map<string, { sig: string; geoUuid: string }>();
/** Yoldaki işler: `panelId|imza`. */
const _decorInFlight = new Set<string>();
/** Panel kesilmemiş yazıldı, kesim işçide: işi kuyruğa koyar (aynı imzalı iş yoldaysa yalnız beklenen geometri güncellenir). */
function scheduleDecor(panelId: string, plan: DecorPlan, bytes: Uint8Array, shownUuid: string): void {
  _decorWant.set(panelId, { sig: plan.sig, geoUuid: shownUuid });
  entryGate.decor.add(panelId);
  const key = `${panelId}|${plan.sig}`;
  if (_decorInFlight.has(key)) return;
  _decorInFlight.add(key);
  jobDecorAdd(panelId);
  void cutInWorker(panelId, bytes, plan.specs, plan.pb, plan.simplify).then(r => {
    _decorInFlight.delete(key);
    if (r.type === 'done' && r.ok) jobDecorDone(panelId, r.ms); else jobDecorDone(panelId, null);
    if (r.type !== 'done') return;
    if (!r.ok) {
      if (r.msg !== 'superseded' && _decorWant.get(panelId)?.sig === plan.sig) void decorOnMain(panelId, plan);
      return;
    }
    let rp: OccShape, geometry: THREE.BufferGeometry;
    try { rp = shapeFromBytes(window.__ocInstance, r.bytes); geometry = geometryFromMeshData(r.mesh); }
    catch (err) { console.warn('[YAGO][KESİM] işçi sonucu okunamadı, delikler ana iş parçacığında kesilecek:', errMsg(err)); void decorOnMain(panelId, plan); return; }
    if (_grooveCache.size > 200) _grooveCache.clear();
    _grooveCache.set(panelId, { sig: plan.sig, rp, geometry, holes: plan.holes });
    writeDecor(panelId, plan.sig, rp, geometry, plan.holes);
  });
}
/** İşçi kesemedi / sonucu okunamadı: eski yol (ana iş parçacığı). */
async function decorOnMain(panelId: string, plan: DecorPlan): Promise<void> {
  try {
    const cut = await cutBySpecs(await initReplicad(), plan.base, plan.specs, plan.pb, plan.simplify, _unitTools);
    if (!cut) return;
    const geometry = convertReplicadToThreeGeometry(cut);
    _grooveCache.set(panelId, { sig: plan.sig, rp: cut, geometry, holes: plan.holes });
    writeDecor(panelId, plan.sig, cut, geometry, plan.holes);
  } catch (err) { console.warn('[YAGO][KESİM] delikler kesilemedi:', panelId, errMsg(err)); }
}
function writeDecor(panelId: string, sig: string, rp: OccShape, geometry: THREE.BufferGeometry, holes: PanelHole[]): void {
  const want = _decorWant.get(panelId);
  if (!want || want.sig !== sig) return;
  const st = useAppStore.getState(), cur = shapeById(panelId, st.shapes);
  if (!cur || cur.geometry?.uuid !== want.geoUuid) return;
  // Ayak izi kesilmemiş mesh'ten okunmaya devam eder: etiket yeni (delikli) geometriye taşınır.
  const ug = (cur as any).ungroovedGeometry as THREE.BufferGeometry | undefined;
  if (ug) ug.userData.groovedUuid = geometry.uuid;
  _decorWant.delete(panelId);
  entryGate.decor.delete(panelId);
  st.updateShape(panelId, { geometry, replicadShape: rp, holes: holes.length ? holes : undefined } as any);
}
/** Testler / dışa aktarma için: işçideki bütün delik işleri bitene (ve yazılana) kadar bekler. */
export async function whenDecorIdle(): Promise<void> {
  for (let i = 0; i < 2400 && (_decorInFlight.size || inFlight.size || pending.size); i++) await new Promise(r => setTimeout(r, 25));
}
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
const VF_REGEN_FIELDS = ['normal', 'center', 'vertices', 'rawFaceBBox', 'sideRelations', 'regionAnchor', 'stackDepth'] as const;

// VF bölge yeniden hesabı: VF = gövde yüz konturu ∩ serbest bölge (yakalama ile aynı). Damga tek yönlü: yalnız önce gelen kardeşler;
// istisna bu yüze ilerleten adımlar; datum onu referans alan panelce kırpılmaz.

type RawBBox = { xMin: number; xMax: number; yMin: number; yMax: number; xSpan: number; ySpan: number };

function uvBox(pts: Iterable<{ x: number; y: number }>): RawBBox {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const q of pts) { if (q.x < xMin) xMin = q.x; if (q.x > xMax) xMax = q.x; if (q.y < yMin) yMin = q.y; if (q.y > yMax) yMax = q.y; }
  return { xMin, xMax, yMin, yMax, xSpan: Math.max(xMax - xMin, 1e-6), ySpan: Math.max(yMax - yMin, 1e-6) };
}
function planeFrame(n3: THREE.Vector3) {
  const { u, v } = getFacePlaneAxes(n3);
  const at = (pu: number, pv: number, pn: number): Vec3 => [u.x * pu + v.x * pv + n3.x * pn, u.y * pu + v.y * pv + n3.y * pn, u.z * pu + v.z * pv + n3.z * pn];
  return { u, v, dU: (a: Vec3) => dot3(a, u), dV: (a: Vec3) => dot3(a, v), dN: (a: Vec3) => dot3(a, n3), at };
}

function buildPrismFromVertices(vertices: Vec3[], normal: Vec3, thickness: number): THREE.BufferGeometry | null {
  const N = vertices.length;
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const front = vertices.map(toVector3);
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
  const f = planeFrame(vfNormal(vf));
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

/** Adımın işaretli miktarı: çözülmüş değer; FIXED'da hedef − mevcut açıklık; DYN'de değer. */
// Ref adımı yalnız çözülen değeriyle sayılır: çözülmemiş ref katıyı değiştirmez → damga da 0.
const stepAmount = (step: any, span: number): number => (step.resolvedValue !== undefined && step.resolvedValue !== null ? step.resolvedValue
  : step.refShapeId ? 0 : step.isFixed ? (step.value ?? 0) - span : (step.value ?? 0));

// Extrude'lu damga: VF tabanı adımların işaretli miktarıyla budanır; kalınlık extrude'u [tMin, tMax] aralığını değiştirir.
function trimmedStampGeometryFromVf(vf: VirtualFace, thickness: number, extrudeSteps: any[], targetFaceNormal: THREE.Vector3): THREE.BufferGeometry | null {
  if (!vf.vertices || vf.vertices.length < 3) return null;
  const trimmed: Vec3[] = vf.vertices.map(v => [...v] as Vec3);
  const vfN = vfNormal(vf);
  let tMin = -thickness, tMax = 0;
  for (const step of extrudeSteps) {
    if (!step.faceNormal) continue;
    const eN = new THREE.Vector3(...step.faceNormal).normalize();
    const alignN = eN.dot(vfN);
    if (Math.abs(alignN) > 0.7) {
      const amountN = stepAmount(step, tMax - tMin);
      if (Math.abs(amountN) < 0.01) continue;
      if (alignN > 0) tMax += amountN; else tMin -= amountN;
      if (tMax - tMin < 0.5) tMin = tMax - 0.5;   // dejenere kalınlık koruması
      continue;
    }
    const alignT = eN.dot(targetFaceNormal);
    if (alignT < -0.3) continue;   // hedef yüzden uzaklaşan extrude: yakın kenar yerinde
    const projs = trimmed.map(p => dot3(p, eN));
    const amount = stepAmount(step, Math.max(...projs) - Math.min(...projs));
    if (Math.abs(amount) < 0.01) continue;
    if (alignT > 0.7 && amount > 0) continue;
    const mx = Math.max(...projs);
    if (amount > 0) {
      // Büyüme: adımın yüzündeki köşeler amount kadar dışarı (eskiden min taraf içeri çekiliyordu).
      for (let i = 0; i < trimmed.length; i++) {
        if (projs[i] < mx - 0.01) continue;
        trimmed[i][0] += amount * eN.x; trimmed[i][1] += amount * eN.y; trimmed[i][2] += amount * eN.z;
      }
      continue;
    }
    const threshold = mx + amount;
    for (let i = 0; i < trimmed.length; i++) {
      if (projs[i] > threshold) {
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
  const n3 = vfNormal(oldVf);
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
  const remapped = oldVf.vertices.map(q => { const m = remapUV(f.dU(q), f.dV(q), oldRaw, nb); return f.at(m.x, m.y, nb.planeD); });
  return buildPrismFromVertices(remapped, nrm, thickness);
}

// Yüz grubu önceliği: descriptor (±5 mm) → aynı düzlemde merkeze en yakın → merkez-kutusu → en yakın; eğik yüzde dot>0.5.
function findMatchingFaceGroup(vf: VirtualFace, faces: FaceData[], faceGroups: CoplanarFaceGroup[], geometry: THREE.BufferGeometry): CoplanarFaceGroup | null {
  const vfN = vfNormal(vf);
  const vfCenter = toVector3(vf.center);
  const groupBox = (g: CoplanarFaceGroup) => {
    const bb = new THREE.Box3();
    g.faceIndices.forEach(fi => { const f = faces[fi]; if (f) f.vertices.forEach(vv => bb.expandByPoint(vv)); });
    return bb;
  };
  const clampDistToGroup = (g: CoplanarFaceGroup) => { const bb = groupBox(g); return vfCenter.clone().clamp(bb.min, bb.max).distanceTo(vfCenter); };
  // Eğri grup (radüslü yüz) düz VF'nin yüzü olamaz: ortalama normali komşu düz yüzle aynı yöne bakabilir.
  const candidateGroups = faceGroups.filter(g => !g.isCurved && vfN.dot(g.normal.clone().normalize()) > 0.95);

  if (candidateGroups.length === 0) {
    let best: CoplanarFaceGroup | null = null, bestD = Infinity, bestDot = 0;
    for (const g of faceGroups) {
      if (g.isCurved) continue;
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
    // Dış yüz dış yüz kalır: tanımlayıcı gövde kutusunun sınırındaysa ve gövde büyüdüyse güncel kutunun aynı sınırı alınır
    // (yoksa panel cebin tabanına sıçrıyordu).
    const d = vf.faceGroupDescriptor;
    if (candidateGroups.length > 1 && d.axisDirection && !d.isCurved) {
      const ax = axisIndexOf(d.axisDirection), nc = d.normalizedCenter[ax];
      const bb = nc < 0.002 || nc > 0.998 ? localBboxOf(geometry) : null;
      if (bb) {
        const lim = (nc > 0.5 ? bb.max : bb.min).getComponent(ax);
        const outer = candidateGroups.filter(g => Math.abs(g.center.getComponent(ax) - lim) < 0.5);
        if (outer.length === 1) return outer[0];
      }
    }
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
const hasExtrudeTowardFace = (p: any, n: THREE.Vector3) =>
  hasExtrudeSteps(p) && p.parameters.extrudeSteps.some((st: any) => st.faceNormal && new THREE.Vector3(...st.faceNormal).normalize().dot(n) > 0.7);

/** Taze ham kontur: bayat rawFaceBBox fixed telafisine karışmasın. */
const composeFresh = (p: any, vf: VirtualFace) => composeSteps(getUnifiedSteps(p), { ...(vf as any), rawFaceBBox: undefined });
/** Motorun GERÇEKTEN uyguladığı REF taşıma deltası (_refDeltaApplied) — tek kaynak, yeniden çözülmez. */
function refDeltaOf(p: any): THREE.Vector3 | null {
  const rda = p?.parameters?._refDeltaApplied;
  return Array.isArray(rda) && rda.length === 3 ? new THREE.Vector3(rda[0], rda[1], rda[2]) : null;
}
/** Panelin tüm dönüş adımları kendi normali etrafında mı (levha kendi düzleminde döner, eğilmez). Eğik VF'de (adımsız eğim) false. */
function rotatesInPlaneOnly(steps: TransformStep[], vf: VirtualFace): boolean {
  const rots = steps.filter(st => st.type === 'rotate') as RotateTransformStep[];
  if (!rots.length || !vf.normal) return false;
  const n = new THREE.Vector3(...(vf.normal as Vec3)).normalize();
  return rots.every(st => {
    const a = st.axisVec ?? mapAxisToVfLocal(vf, st.axis as AxisLetter);
    return !!a && Math.abs(new THREE.Vector3(...(a as Vec3)).normalize().dot(n)) > 0.9999;
  });
}
/** Panelin taşıma / döndürme adımlarının bileşik RİJİT dönüşümü, panel geometrisinin koordinatında: adımsız levha → şimdiki levha.
 *  Damgalamadaki çözümün aynısı (composeFresh + uygulanan REF deltası). Ölçü çapaları (Dim) noktayı panelin adımsız çerçevesinde tutar
 *  ki panel taşınıp döndürülünce ölçü tıklanan yerde kalsın. Taşıma / döndürme adımı yoksa null. */
export function panelStepMatrix(p: Shape, vfs: VirtualFace[] = useAppStore.getState().virtualFaces): THREE.Matrix4 | null {
  const steps = getUnifiedSteps(p);
  if (!steps.some(s => s.type === 'move' || s.type === 'rotate')) return null;
  const vf = vfOfPanel(p, vfs);
  if (!vf) return null;
  try {
    const m = new THREE.Matrix4(), t = new THREE.Matrix4(), r = new THREE.Matrix4();
    for (const o of composeFresh(p, vf).ops) {
      if (o.kind === 'rotate') {
        r.makeRotationAxis(o.axis.clone().normalize(), (o.deg * Math.PI) / 180);
        t.makeTranslation(o.pivot.x, o.pivot.y, o.pivot.z).multiply(r).multiply(new THREE.Matrix4().makeTranslation(-o.pivot.x, -o.pivot.y, -o.pivot.z));
      } else {
        const d = o.kind === 'translate' ? o.d : refDeltaOf(p) ?? o.fallback;
        t.makeTranslation(d.x, d.y, d.z);
      }
      m.premultiply(t);
    }
    return m;
  } catch { return null; }
}

function recalculateVirtualFacesForShape(shape: Shape, virtualFaces: VirtualFace[], allShapes?: any[], panelGroups?: PanelGroup[]): VirtualFace[] {
  const allShapeFaces = virtualFaces.filter(vf => vf.shapeId === shape.id);
  if (allShapeFaces.length === 0 || !shape.geometry) return virtualFaces;
  // İÇ VF'LER (raf/dikme): yüz eşlemesine girmez, grup çözücüsü yazar (aşağıda).
  const shapeFaces = allShapeFaces.filter(vf => !isInteriorVf(vf));
  const shapesArr = (allShapes || []) as Shape[];
  const interiorMap = panelGroups
    ? recalculateInteriorVfs(shape, allShapeFaces.filter(vf => isInteriorVf(vf) && !isSheetVf(vf)), shapesArr, panelGroups)
    : new Map<string, VirtualFace>();
  const doorVfs = recalculateDoorVfs(shape, allShapeFaces.filter(isDoorVf), shapesArr, useAppStore.getState().doorGroups);
  for (const [id, vf] of doorVfs) interiorMap.set(id, vf);
  const backVfs = recalculateBackVfs(shape, allShapeFaces.filter(isBackVf), shapesArr, useAppStore.getState().backGroups);
  for (const [id, vf] of backVfs) interiorMap.set(id, vf);
  if (shapeFaces.length === 0) return virtualFaces.map(vf => interiorMap.get(vf.id) || vf);

  const { faces, groups: faceGroups } = getFacesAndGroups(shape.geometry);
  const worldToLocal = getShapeMatrix(shape).invert();
  // İç paneller (raf/dikme) de kardeştir: sırada önce geldikleri gövde panelini damgalar (yetki yalnız sıra).
  const childPanels = childPanelsOf(shape.id, shapesArr);
  const vfById = new Map(virtualFaces.map(f => [f.id, f] as const));
  const vfIndexOf = new Map<string, number>();
  virtualFaces.forEach((f, i) => vfIndexOf.set(f.id, i));
  const panelPriority = (p: any) => vfIndexOf.get(p?.parameters?.virtualFaceId) ?? Number.MAX_SAFE_INTEGER;
  const refsCache = new Map<string, ReturnType<typeof stepRefTargets>>();
  const refsOf = (p: any) => { let r = refsCache.get(p.id); if (!r) { r = stepRefTargets(p); refsCache.set(p.id, r); } return r; };

  const matchOf = new Map<string, { group: CoplanarFaceGroup; contour: ReturnType<typeof computeFaceComponentContour> } | null>();
  const freshVfVertices = new Map<string, Vec3[]>();
  const freshStackDepth = new Map<string, number>();
  /** Taze ham kontur köşeleri; kontur yoksa mevcut VF köşeleri. */
  const setFresh = (vf: VirtualFace, corners: THREE.Vector3[] | undefined) => {
    if (corners && corners.length >= 3) freshVfVertices.set(vf.id, corners.map(vec3));
    else if (vf.vertices && vf.vertices.length >= 3) freshVfVertices.set(vf.id, vf.vertices);
  };
  // Eğri yüz VF'leri: güncel mesh'te aynı eğri yüz bulunur, köşe / normal / merkez tazelenir; bölge çözülmez.
  const curvedRegen = new Map<string, VirtualFace>();
  for (const vf of shapeFaces) {
    if (vf.curved) {
      const hit = matchCurvedFaceGroup(toVector3(vf.center), vfNormal(vf), faces, faceGroups);
      const gN = hit ? hit.group.normal.clone().normalize() : null;
      const c = hit && gN ? computeFaceComponentContour(faces, hit.group.faceIndices, hit.nearest, gN) : null;
      matchOf.set(vf.id, null);
      setFresh(vf, c?.corners);
      if (hit && gN && c) curvedRegen.set(vf.id, { ...vf, normal: vec3(gN), center: vec3(hit.nearest), vertices: c.corners.map(vec3) });
      continue;
    }
    // Üst üste panel — eğimli taban: düzlem tabanın güncel iç büyük yüzü, VF normali tabana doğru.
    if (vf.stackOnPanel && vf.stackBaseVfId) {
      const basePanel = childPanels.find(p => p.parameters?.virtualFaceId === vf.stackBaseVfId);
      // "İç" yüz = boşluğa bakan: merkezden VF normalinin tersine (boşluğa doğru) uzak bir nokta hedef alınır.
      const inner = basePanel ? panelInnerBigFace(basePanel, toVector3(vf.center).addScaledVector(vfNormal(vf), -200)) : null;
      if (inner) {
        const nIn = inner.group.normal.clone().normalize();
        const c = computeFaceComponentContour(inner.faces, inner.group.faceIndices, toVector3(vf.center), nIn);
        matchOf.set(vf.id, c ? { group: { ...inner.group, normal: nIn.clone().multiplyScalar(-1) }, contour: c } : null);
        setFresh(vf, c?.corners);
      } else matchOf.set(vf.id, null);
      continue;
    }
    // ÜST ÜSTE PANEL: yüz eşlemesi merkez yüze geri izdüşürülerek yapılır; kontur ve tohum yüzün stackDepth içindeki düzlemine taşınır.
    const sd0 = vf.stackDepth && vf.stackDepth > 0 ? vf.stackDepth : 0;
    const probe = sd0 ? { ...vf, center: [0, 1, 2].map(i => vf.center[i] + vf.normal[i] * sd0) as Vec3 } : vf;
    const group = findMatchingFaceGroup(probe, faces, faceGroups, shape.geometry);
    const gN = group ? group.normal.clone().normalize() : null;
    let contour = group && gN ? computeFaceComponentContour(faces, group.faceIndices, toVector3(probe.center), gN) : null;
    let sd = sd0;
    // AYAĞIN ÜSTÜ: derinlik = zeminden setin üst yüzüne (set yükselince / alt panele bağlı set değişince panel onunla gider).
    if (vf.stackOnPlinthId && contour && gN) {
      const ps = plinthSetsOf(shape.id).find(x => x.id === vf.stackOnPlinthId);
      if (ps) {
        const pb = plinthBoxOf(ps, shapesArr);
        const faceD = contour.corners[0].dot(gN);                      // yüz düzlemi (alt yüzde −y0)
        const topD = new THREE.Vector3(0, pb.max[1], 0).dot(gN);         // setin üst düzlemi, yüz normali yönünde
        const d = faceD - topD;
        if (d > 0.5 && Math.abs(d - sd0) > 1e-3) { sd = d; freshStackDepth.set(vf.id, d); }
      }
    }
    if (vf.stackOnBack && contour && gN) {
      // ARKALIĞIN ÖNÜ: derinlik arkalık parçası + önüne yığılmış (sırada önce gelen) bitişik katmanlardan her regen'de yeniden okunur.
      const c = toVector3(probe.center);
      const onFace = c.addScaledVector(gN, contour.corners[0].dot(gN) - c.dot(gN));
      const myIdx = vfIndexOf.get(vf.id) ?? Number.MAX_SAFE_INTEGER;
      const layers = childPanels.filter(p => !isBackPanel(p) && !isDoorPanel(p) && !isInteriorPanel(p) && !panelHasRotation(p)
        && p.parameters?.virtualFaceId !== vf.id && panelPriority(p) < myIdx);
      const hit = backStackAt(gN, onFace, childPanels.filter(isBackPanel), layers, virtualFaces);
      if (hit) { sd = hit.depth; if (Math.abs(sd - sd0) > 1e-3) freshStackDepth.set(vf.id, sd); }
    }
    if (contour && gN && sd) {
      const sh = gN.clone().multiplyScalar(-sd);
      const mv = (p: THREE.Vector3) => p.clone().add(sh);
      contour = { ...contour, corners: contour.corners.map(mv), center: mv(contour.center), boundary: contour.boundary.map(e => ({ a: mv(e.a), b: mv(e.b) })) };
    }
    matchOf.set(vf.id, group ? { group, contour } : null);
    setFresh(vf, contour?.corners);
  }
  const stampBaseVertices = new Map<string, Vec3[]>();
  for (const vf of shapeFaces) {
    const base = stampBaseVertsFromVf(vf, freshVfVertices.get(vf.id));
    if (base && base.length >= 3) stampBaseVertices.set(vf.id, base);
  }

  // İŞARETLİ EXTRUDE MİKTARI (damga-trim ile birebir): + uzuyor, − kısalıyor.
  const signedExtrudeAmountOf = (p: any, step: any, eN: THREE.Vector3): number => {
    if (step.resolvedValue !== undefined && step.resolvedValue !== null) return step.resolvedValue;
    if (step.refShapeId) return 0;   // çözülmemiş ref adımı katıyı değiştirmez (stepAmount ile aynı)
    if (!step.isFixed) return step.value ?? 0;
    const vfId = p?.parameters?.virtualFaceId;
    const verts = vfId ? stampBaseVertices.get(vfId) || freshVfVertices.get(vfId) || vfById.get(vfId)?.vertices : undefined;
    if (!verts || verts.length < 3) return 0;
    const r = vRange(verts, eN);
    // KALINLIK YÖNÜ: VF köşeleri normal boyunca 0 açıklık verir; gerçek açıklık kalınlıktır.
    const pvf = vfId ? vfById.get(vfId) : undefined;
    const alongNormal = !!pvf && Math.abs(eN.dot(vfNormal(pvf))) > 0.7;
    return (step.value ?? 0) - (alongNormal ? panelThickness(p) : r.max - r.min);
  };
  const extrudeAdvancesTowardFace = (p: any, n: THREE.Vector3 | null): boolean => {
    if (!n || !hasExtrudeSteps(p)) return false;
    for (const step of p.parameters.extrudeSteps) {
      if (!step.faceNormal) continue;
      const eN = new THREE.Vector3(...step.faceNormal).normalize();
      const align = eN.dot(n);
      if (Math.abs(align) < 0.7) continue;
      // Yalnız uzayan adım (amount > 0) yetki verir; kısalan uç yeni alan kaplamaz.
      const amt = signedExtrudeAmountOf(p, step, eN);
      if (amt > 0.01 && amt * align > 0.01) return true;
    }
    return false;
  };

  // Taşınmış panel sırayı ancak taşıması onu bu yüze DOĞRU itiyorsa devirebilir (Δ·n > 0); paralel taşıma yetki vermez.
  const moveAdvancesTowardFace = (p: any, n: THREE.Vector3 | null): boolean => {
    if (!n || !hasMoveSteps(p)) return false;
    let d = refDeltaOf(p);
    if (!d) { try { d = toVector3(applyTransformSteps([0, 0, 0], [0, 0, 0], getUnifiedSteps(p)).position); } catch { return true; } }
    return d.dot(n) > 0.01;
  };

  // Arkalık çakma kenarı: iç parça çakma kenarındaki gövde panelini sırası ne olursa olsun basar; başka hiçbir durumda damgalamaz.
  /** p, VF sırasında vfId'den ÖNCE mi (basan)? */
  const precedes = (p: any, vfId: string) => { const myIdx = vfIndexOf.get(vfId); return myIdx != null && panelPriority(p) < myIdx; };
  const backNailBox = new Map<string, CavityBox | null>();
  const backNailFor = (p: any, vfId: string): CavityBox | null => {
    const key = `${p.id}|${vfId}`;
    // Sıra: arkalık hedef VF'den önceyse (basan) hedef panel arkalığa kadar yerleşir.
    if (!backNailBox.has(key)) backNailBox.set(key, backNailStampFor(p, vfId, precedes(p, vfId)));
    return backNailBox.get(key) ?? null;
  };
  const stamps = (p: any, vfId: string, myPanel: any, myFaceNormal: THREE.Vector3 | null): boolean => {
    if (p.parameters?.virtualFaceId === vfId) return false;
    // Eğri yüz paneli bölge damgalamaz: komşu yüz kenarına kadar çözülür, katı düzeyinde kesişir (ayak izi kama boşluk bırakıyordu).
    if (!panelStampsRegions(p, shape, virtualFaces)) return false;
    if (isBackPanel(p)) return !!backNailFor(p, vfId);
    if (isSheetPanel(p)) return false;
    // Raf/dikme yalnız VF sırasıyla basar (istisna yok) — PanelGroupService.groupObstacles da aynı sırayı okur.
    if (isInteriorPanel(p)) return precedes(p, vfId);
    // Extrude datumu bu paneli damgalamaz — ama "yüzeyin şeklini al" açıksa damgalar (bölgenin şekli o izden doğar).
    const myFit = !!vfById.get(vfId)?.fitFaceShape;
    if (myPanel && ((refsOf(myPanel).extrude.has(p.id) && !myFit) || refsOf(p).rotate.has(myPanel.id))) return false;
    const pIsRefBoundToMe = !!myPanel && refsOf(p).move.has(myPanel.id);
    if (myPanel && refsOf(p).extrude.has(myPanel.id) && extrudeAdvancesTowardFace(p, myFaceNormal)) return true;
    // Farklı yüzdeki taşınmış / yüze doğru extrude'lu panel sırayı devirebilir (datum hariç).
    const pVf = vfById.get(p.parameters?.virtualFaceId);
    if (pVf && myFaceNormal && !(Math.abs(myFaceNormal.dot(vfNormal(pVf))) > 0.95)) {
      if ((hasMoveSteps(p) && !pIsRefBoundToMe && moveAdvancesTowardFace(p, myFaceNormal)) || extrudeAdvancesTowardFace(p, myFaceNormal)) return true;
    }
    return precedes(p, vfId);
  };

  // Damga: extrude'lu → budanmış taban + ops; düz → oransal damga ya da mesh; dönmüş → nihai geometri. Extrude'suzda panel başına önbellek.
  const stampCache = new Map<string, any>();
  const stampOf = (p: any, myFaceNormal: THREE.Vector3 | null, vfId?: string): any => {
    // Arkalık damgası = baskı kutusu (parça levhası, çakma kenarda panelin dış yüzünün ötesine uzatılmış), hedef VF'ye göre.
    if (isBackPanel(p) && vfId) {
      const box = backNailFor(p, vfId);
      if (!box) return p;
      const key = `${p.id}|back|${vfId}`;
      if (!stampCache.has(key)) {
        const sz = [0, 1, 2].map(a => Math.max(0.01, box.max[a] - box.min[a]));
        const mid = [0, 1, 2].map(a => (box.min[a] + box.max[a]) / 2);
        stampCache.set(key, { ...p, geometry: new THREE.BoxGeometry(sz[0], sz[1], sz[2]).translate(mid[0], mid[1], mid[2]) });
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
    // Eğri yüz paneli: damga = gerçek katının mesh'i (VF köşe dörtgeninden prizma kirişi basardı).
    if (isCurvedPanel(p)) return p;
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
        const { ops } = composeFresh(p, ownVf);
        const refDeltaApplied = refDeltaOf(p);
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

  // Hedefin kendi ötelemesi: damgalar hedefin ötelemesinin tersi kadar kaydırılır → bölge panelin gerçek konumunda çözülür.
  const ownShiftOf = (p: any, vf: VirtualFace | undefined): THREE.Vector3 | null => {
    if (!p || !vf || !hasMoveSteps(p) || isRotatedPanel(p)) return null;
    try {
      const { ops } = composeFresh(p, vf);
      const rd = refDeltaOf(p);
      const d = new THREE.Vector3();
      for (const o of ops as any[]) {
        if (o.kind === 'translate' && o.d) d.add(o.d);
        else if (o.kind === 'refTranslate') { const x = rd ?? o.fallback; if (x) d.add(x); }
      }
      return d.lengthSq() > 1e-6 ? d : null;
    } catch { return null; }
  };
  // Kaydırılmış damga yüz düzlemini gövdesiyle keser → __pierceObstacle (gerçek engel). Ops'lu damgada pivotlar da kayar.
  const shiftStamp = (s: any, d: THREE.Vector3): any => {
    if (!s || typeof s !== 'object' || !s.geometry) return s;
    const base = footprintGeometry(s) ?? s.geometry;
    const ops = Array.isArray(s.__composedOps)
      ? s.__composedOps.map((o: any) => (o && o.kind === 'rotate' && o.pivot ? { ...o, pivot: o.pivot.clone().add(d) } : o)) : undefined;
    return {
      ...s, geometry: base.clone().translate(d.x, d.y, d.z), ungroovedGeometry: undefined, __pierceObstacle: true,
      ...(ops ? { __composedOps: ops } : {}),
    };
  };
  /** Ayak damgaları: her ayak ayrı kutu (set hacmi değil) — değmeyen panel tam yerleşir, değen yalnız o ayak kadar çentiklenir. */
  const plinthStampCache = new Map<string, any[]>();
  // Ayak kutusunun üstü set üstünden biraz aşağı (> 3 mm değme toleransı): set önce gelince üstüne oturan alt panel çentiklenmez.
  const PLINTH_STAMP_TOP_CLEAR = 4;
  const plinthStampsOf = (ps: { id: string; vfId: string }, body: Shape): any[] => {
    const hit = plinthStampCache.get(ps.id); if (hit) return hit;
    const full = plinthSetsOf(body.id).find(x => x.id === ps.id); if (!full) return [];
    const list = plinthLegBoxes(full, shapesArr, virtualFaces).map((b0, i) => {
      const b = { min: b0.min, max: [b0.max[0], Math.max(b0.min[1] + 0.01, b0.max[1] - PLINTH_STAMP_TOP_CLEAR), b0.max[2]] as Vec3 };
      const sz = [0, 1, 2].map(a => Math.max(0.01, b.max[a] - b.min[a]));
      const mid = [0, 1, 2].map(a => (b.min[a] + b.max[a]) / 2);
      return {
        id: `plinth-stamp-${ps.id}-${i}`, type: 'panel', position: body.position, rotation: body.rotation, scale: body.scale,
        geometry: new THREE.BoxGeometry(sz[0], sz[1], sz[2]).translate(mid[0], mid[1], mid[2]),
        parameters: { parentShapeId: body.id, virtualFaceId: ps.vfId, panelThickness: sz[1] }, __pierceObstacle: true,
      };
    });
    plinthStampCache.set(ps.id, list);
    return list;
  };
  const stampingPanelsFor = (vfId: string): any[] => {
    const myPanel = childPanels.find(p => p.parameters?.virtualFaceId === vfId);
    const myVf = vfById.get(vfId);
    const myFaceNormal = myVf ? vfNormal(myVf) : null;
    // Üst üste panelde düzlemin gerisindeki paneller (taban + yığın) kardeş değildir; düzlemi aşanlar kalır.
    const sd = myVf && myFaceNormal && ((myVf.stackDepth && myVf.stackDepth > 0) || myVf.stackOnPanel) ? 1 : 0;
    // Düz yığında düzlem bu geçişin konturundan (derinlik yeni okunmuş olabilir); eğimli tabanda VF merkezinden.
    const fresh = sd && !myVf!.stackOnPanel ? matchOf.get(vfId)?.contour?.corners[0] : undefined;
    const planeIn = sd && myFaceNormal ? (fresh ?? new THREE.Vector3(...myVf!.center)).dot(myFaceNormal.clone().multiplyScalar(-1)) : 0;
    const behind = (p: any) => !!sd && !!myFaceNormal && panelBehindStackPlane(p, myFaceNormal, planeIn);
    let list = childPanels.filter(p => !behind(p) && stamps(p, vfId, myPanel, myFaceNormal)).map(p => stampOf(p, myFaceNormal, vfId));
    // Baza setleri: sırada önce gelen set kutusuyla damgalar; sonra gelen set panelin arasında kalır. Gerideki set `behind` ile elenir.
    const myIdx = vfIndexOf.get(vfId) ?? Number.MAX_SAFE_INTEGER;
    for (const ps of plinthSetsOf(shape.id)) {
      const pi = vfIndexOf.get(ps.vfId);
      if (pi == null || pi >= myIdx || myVf?.stackOnPlinthId === ps.id) continue;
      for (const st of plinthStampsOf(ps, shape)) if (!behind(st)) list.push(st);
    }
    // Üst üste panel düzlemi gövdenin içindedir: o düzlemi DELEN levhalar (üst/alt/arkalık) gerçek engel sayılır.
    if (sd) list = list.map(s => (s && typeof s === 'object' ? { ...s, __pierceObstacle: true } : s));
    const own = ownShiftOf(myPanel, myVf);
    return own ? list.map(s => shiftStamp(s, own.clone().negate())) : list;
  };

  // KAYIT UZATMASI hedefe (gövde yüzü) her regen'de yeniden ölçülür (RailExtTarget; gövde ölçüsü değişince kayıt hedefe değer).
  const land = (from: THREE.Vector3, dir: THREE.Vector3, to: RailExtTarget) => railLandingOnBody(faces, faceGroups, from, dir, to);
  const updatedMap = new Map<string, VirtualFace>();
  for (const vf of shapeFaces) {
    const m = matchOf.get(vf.id);
    const regen = m && m.contour ? regenerateParentFaceShapeVF(vf, shape.id, m.group, m.contour, worldToLocal, stampingPanelsFor(vf.id), land) : null;
    const sdNew = regen ? freshStackDepth.get(vf.id) : undefined;
    updatedMap.set(vf.id, regen ? (sdNew !== undefined ? { ...regen, stackDepth: sdNew } : regen) : curvedRegen.get(vf.id) ?? vf);
  }
  return virtualFaces.map(vf => updatedMap.get(vf.id) || interiorMap.get(vf.id) || vf);
}

// VF = yüz konturu ∩ serbest bölge; seed MUTLAK (güncel düzleme izdüşer); sideRelations STORED-WINS → panel ilk tarafında kalır.
function regenerateParentFaceShapeVF(
  vf: VirtualFace, shapeId: string, matchedGroup: CoplanarFaceGroup,
  contour: NonNullable<ReturnType<typeof computeFaceComponentContour>>,
  worldToLocal: THREE.Matrix4, siblingPanels: any[],
  land?: (from: THREE.Vector3, dir: THREE.Vector3, to: RailExtTarget) => number | null,
): VirtualFace {
  const localNormal = matchedGroup.normal.clone().normalize();
  const seed = toVector3(vf.center);
  const { u, v } = getFacePlaneAxes(localNormal);
  const planeN = contour.corners[0].dot(localNormal);
  const uvOf = (p3: THREE.Vector3) => toUV(p3, u, v);
  const to3D = (q: { x: number; y: number }) => fromPlaneUV(u, v, localNormal, q.x, q.y, planeN);
  const newB = uvBox(contour.corners.map(uvOf));
  const cUV = uvOf(seed);
  const newCenter = to3D({ x: Math.max(newB.xMin, Math.min(newB.xMax, cUV.x)), y: Math.max(newB.yMin, Math.min(newB.yMax, cUV.y)) });

  const storedRel = (vf as any).sideRelations as Record<string, number> | undefined;
  const prevRegion = vf.vertices && vf.vertices.length >= 3 ? vf.vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z)) : undefined;
  // Kayıt şeridi bölgenin TAM şeklinden kırpılır (L konturda yanlar / önceki kayıtlar kesin düşsün).
  const region = computeFreeRegionLocal(contour.corners, localNormal, seed, siblingPanels, worldToLocal, shapeId, prevRegion, storedRel, !!vf.fitFaceShape || !!vf.railStrip);

  let cornersOut = region && region.polygon.length >= 3 ? region.polygon.map(to3D) : contour.corners;
  let centerOut = newCenter;
  if (vf.railStrip) {
    // Kayıt şeridi: serbest bölge bağlı kenardan şeride kırpılır (boşsa kontur şeridi); merkez şeridin ağırlık merkezine alınır.
    const base = region && region.polygon.length >= 3 ? region.polygon : contour.corners.map(uvOf);
    const resolve = land ? (e: RailExt, fromUV: { x: number; y: number }) => (e.to ? land(to3D(fromUV), new THREE.Vector3(...e.dir), e.to) : null) : undefined;
    const clip = clipRegionToRailStrip(base, contour.corners.map(uvOf), vf.railStrip, u, v, cUV, resolve)
      ?? clipRegionToRailStrip(contour.corners.map(uvOf), contour.corners.map(uvOf), vf.railStrip, u, v, cUV, resolve);
    if (clip) { cornersOut = clip.polygon.map(to3D); centerOut = to3D(clip.center); }
  }
  // DİKEY KAYIT UÇ AYARI: iç köşede hedefe kadar uzar (yüzün dışına, gövdenin içinde), dış köşede komşunun gerisinde kalır.
  if (vf.railExt?.length) cornersOut = applyRailExt(cornersOut, contour.corners, localNormal, vf.railExt, land);

  const out: any = { ...vf, normal: vec3(localNormal), vertices: cornersOut.map(vec3), center: vec3(centerOut) };
  out.rawFaceBBox = { ...newB };
  out.sideRelations = { ...(region?.sideRelations || {}), ...(storedRel || {}) };
  if (region?.anchor) out.regionAnchor = vec3(to3D(region.anchor));
  return out;
}
