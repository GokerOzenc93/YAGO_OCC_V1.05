import * as THREE from 'three';
import { type PanelGroup, type Shape, type VirtualFace, childPanelsOf, panelOfVf, shapeById, useAppStore, vfOfPanel } from '../store';
import { type ExtrudeStep, type TransformStep, applyExtrudeSteps, applyTransformSteps, getUnifiedSteps, matchReferenceFace, resolveReferenceFacePlane, stepRefTargets } from './PanelOps';
import { computeFaceComponentContour, computeFreeRegionLocal, convexHull2D, panelHasRotation, panelIsTiltedSlab } from './FaceRegion';
import {
  type CoplanarFaceGroup, type FaceData, type Vec3, angleToTouchPlane, axisDirToVec, axisIndexOf, boundsOverlapBox, convertReplicadToThreeGeometry,
  createPanelFromVirtualFace, createReplicadBox, effectiveBodyGeometry, errMsg, findFaceByDescriptor, fmtBounds, fmtBox3, fmtVec, getFacePlaneAxes,
  getFacesAndGroups, getShapeMatrix, isFlatNormal, localBboxOf, normDeg, panelThickness, pointFromFracBox, projRange, resolveVfFracPoint,
  rotateAboutAxis, round1, uniqueMeshPoints, vertexModsKey, vfRawMinAlong, worldBboxOf,
} from './Geometry';
import { isInteriorPanel, isInteriorVf, recalculateInteriorVfs, syncPanelGroups } from './PanelGroupService';
import { isDoorPanel, isDoorVf, recalculateDoorVfs, syncDoorGroups } from './DoorService';

/* ═══════════════════════════════════════════════════════════════════════════
   PANEL MOTORU — (A) rebuildPanelsForParent: bir gövdenin panellerini VF sırası
   (basan/basılan), adımlar, bölge ve kesimlerle yeniden üretir; (B) VF bölge
   yeniden hesabı (gövde değişince sanal yüzlerin yeniden türetilmesi).
   ═══════════════════════════════════════════════════════════════════════════ */
// ═══════════════════════════════════════════════════════════════════════════
// PANEL MOTORU — rebuild çekirdeği.
//
// SÖZLEŞME
//  • Tek gerçek kaynak SPEC'tir: panelin VF bağı + sıralı adımları
//    (transformSteps, extrudeSteps). Geometri her rebuild'de SIFIRDAN üretilir.
//  • BASAN/BASILAN = VF SIRASI (store'daki virtualFaces sırası). Önce gelen
//    panel basandır; bölge (VirtualFaceUpdateService) ve kesimler bu tek
//    yönlü sözleşmeye uyar.
//  • Üretim hattı (buildPanel): VF çokgeni (+ iç köşe uzaması) → katı →
//    adımlar (move/rotate, çerçeve-duyarlı) → dönmüş/eğik panel: büyüt &
//    gövdeye/basan kardeşlere sığdır → extrude adımları → dönmüş basanların
//    eğik düzlem kesimi → ref-dönüş hedeflerinin pahı → store.
//  • Sıra-duyarlı üretim: her panelden sonra VF'ler yeniden hesaplanır, sonra
//    ikinci geçiş yapılır; bir sonraki panel güncel kardeş ayak izini görür.
// ═══════════════════════════════════════════════════════════════════════════

type UpdateShape = (id: string, u: Partial<Shape>) => void;
type CreatePanelFn = (v: Vec3[], n: Vec3, t: number, e?: number) => Promise<any>;
type ToGeometryFn = (s: any) => THREE.BufferGeometry;
export type RefContact = 'arm' | 'rest';

const vfNormal = (vf: VirtualFace) => new THREE.Vector3(...(vf.normal as Vec3)).normalize();

/** Pivot: VF'ye oransal çıpadan (asıl) ya da mutlak pivottan (yedek). */
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
  console.log('[YAGO][ANCHOR-SCALE]', 'eksen=', step.axis, 'orijinal=', original.toFixed(1),
    'eskiSpan=', span0.toFixed(1), 'yeniSpan=', currentSpan.toFixed(1), 'oran=', ratio.toFixed(3), 'ölçekli=', scaled.toFixed(1));
  return scaled;
}

// ── REF DÖNÜŞ: açıyı GÜNCEL geometriden çöz ──────────────────────────────────

/** Referans yüz çokgeni (dünya): normal + merkez + tekil köşeler. */
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

/** Nokta, düzlemdeki konveks çokgenin içinde mi (tol mm; kenar üstü sayılmaz)? */
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

/**
 * YÜZE OTURMA: dönen panelin büyük yüzeyi (m(θ)·(X−P) = k) pivot etrafında
 * dönerken referans yüz çokgeninin köşesine hangi açıda değer? `sign`
 * yönündeki çözümler arasından PİVOTA EN YAKIN köşe (eşitlikte en küçük |θ|):
 * referans o köşede ölçüsünü korur, dış köşe eğime göre pahlanır.
 */
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

/**
 * REF dönüş açısı (Goker sözleşmesi, her rebuild'de yeniden çözülür):
 *  (a) nişan noktasının referans yüz DÜZLEMİNE değdiği nokta yüz çokgeninin
 *      İÇİNDEyse panel nişan yüze değene kadar döner ('arm');
 *  (b) değilse panelin referansa bakan büyük yüzeyi çokgenin ilk köşesine
 *      OTURUR ('rest') — referansın ölçüsü değişmez.
 * Çözülemezse adımın donmuş açısı (resolvedValue ?? value) döner.
 */
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

      // (a) Nişan yüze mi değiyor, yoksa yalnız sonsuz düzlemine mi?
      const poly = resolveReferenceFacePolygon(st.refTargetPanelId, st.refTargetFaceGroupIndex ?? -1, st.refTargetFaceNormal, st.refTargetFacePoint);
      const armAt = rotateAboutAxis(armWorld, pivot, axisWorld, sol.deg);
      const armInside = !!poly && sol.touched && pointInFacePolygon(armAt, poly.normal, poly.vertices, 0.5);
      if (armInside || !poly) {
        if (!sol.touched) console.warn('[YAGO][REF-DÖN] nişan noktası referans yüze ULAŞAMIYOR — en yakın yaklaşma açısı:', sol.deg.toFixed(2));
        console.log('[YAGO][REF-DÖN] çözülen açı=', sol.deg.toFixed(2), '(nişan yüze değiyor)',
          'hedef=', st.refTargetPanelId, 'yüzN=', fmtVec(plane.normal, 2), 'yüzNokta=', fmtVec(planePointWorld), 'nişan=', fmtVec(armAt));
        return { deg: round3(sol.deg), contact: 'arm' };
      }

      // (b) YÜZE OTURMA: dış (VF düzlemi) ya da iç (−kalınlık) yüzey; (a) açısında
      //     referans normaline ZIT bakan seçilir; ofset pivotun VF'ye konumuyla düzeltilir.
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
      console.log('[YAGO][REF-DÖN] çözülen açı=', rest.deg.toFixed(2), '(YÜZE OTURMA —', useInner ? 'iç' : 'dış', 'yüzey pivota en yakın köşeye değdi)',
        'hedef=', st.refTargetPanelId, 'düzlemAçısı=', sol.deg.toFixed(2), 'nişanDüzlemde=', fmtVec(armAt), 'temasKöşesi=', fmtVec(rest.vertex));
      return { deg: round3(rest.deg), contact: 'rest' };
    }
  } catch (err) {
    console.warn('[YAGO][REF-DÖN] açı çözümü hatası, donmuş açı:', errMsg(err));
    return { deg: frozen };
  }
}

// ── ADIM ZİNCİRİ (çerçeve matematiği) ────────────────────────────────────────

export type StepOp =
  | { kind: 'translate'; d: THREE.Vector3 }
  | { kind: 'refTranslate'; targetPanelId: string; sourceFrac?: Vec3; targetFrac?: Vec3; fallback: THREE.Vector3 }
  | { kind: 'rotate'; deg: number; pivot: THREE.Vector3; axis: THREE.Vector3 };

/**
 * Adımları sırayla işlem listesine çevirir. move o ANKİ dönüş çerçevesinin
 * ekseninde ilerler; rotate pivotu GÜNCEL VF'den çözer. REF taşıma motorda
 * (katı mevcutken) çözülsün diye 'refTranslate' olarak döner. REF dönüşlerin
 * bu geçişte çözülen açıları + temas türleri resolvedRotations'ta.
 */
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
              console.log('[YAGO][FIXED-TAŞI] yüz kaydı', shift.toFixed(1), 'mm telafi edildi → panel mutlak konumda',
                'eksen=', st.axis, 'değer=', value.toFixed(1), 'ref=', st.fixedRef.toFixed(1), 'güncel=', cur.toFixed(1));
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

/**
 * REF taşıma deltası GÜNCEL geometriden: kaynak köşe taşınan panelin o anki
 * dünya kutusundan (sourceFrac), hedef köşe referansın güncel kutusundan
 * (targetFrac). Eksikse donmuş fallback.
 */
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
  console.log('[YAGO][REF-BAĞ] çözülen delta=', fmtVec(d), 'hedef=', op.targetPanelId, 'hedefKöşe=', fmtVec(targetWorld));
  return d;
}

// ── İÇ KÖŞE (KONKAV) BİRLEŞİMİ ───────────────────────────────────────────────
// Gövdenin iç köşesinde dik iki panel buluşunca köşede t1×t2 boşluk kalır.
// Kural: SIRADA ÖNCE olan panel, sonrakinin kalınlığı kadar uzayıp ucunu kapatır.
// Kapsam dar: iki panel de adımsız, yüzler dik, Q'nun köşe kenarı P'ninkini kapsıyor.
const CORNER_TOL = 1.0;

function hasAnySteps(p: Shape): boolean {
  const q: any = p.parameters || {};
  return (Array.isArray(q.transformSteps) && q.transformSteps.length > 0) || (Array.isArray(q.extrudeSteps) && q.extrudeSteps.length > 0);
}

/** Köşe dizisinin yön boyunca izdüşüm aralığı. */
const vRange = (verts: Vec3[], dir: THREE.Vector3) => projRange(verts.map(c => new THREE.Vector3(c[0], c[1], c[2])), dir);

/** P (önce) ile Q (sonra) konkav iç köşede buluşuyorsa P'nin uzama bilgisi; yoksa null. */
function concaveCornerJoin(vfP: VirtualFace, vfQ: VirtualFace, tQ: number): { nQ: THREE.Vector3; dQ: number; tQ: number } | null {
  if (!vfP?.vertices || vfP.vertices.length < 3 || !vfQ?.vertices || vfQ.vertices.length < 3) return null;
  const nP = vfNormal(vfP), nQ = vfNormal(vfQ);
  if (Math.abs(nP.dot(nQ)) > 0.02) return null;                                   // dik değil
  const pP = vRange(vfP.vertices, nP), pQ = vRange(vfQ.vertices, nQ);
  if (pP.max - pP.min > CORNER_TOL || pQ.max - pQ.min > CORNER_TOL) return null;  // düzlemsel değil
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

/** Panelin üretim köşeleri: VF köşeleri + (varsa) konkav köşe uzaması. VF değişmez. */
function cornerJoinedVertices(panel: Shape, vf: VirtualFace, vfs: VirtualFace[], siblings: Shape[], orderOf: (s: Shape) => number): Vec3[] {
  let verts = vf.vertices.map(c => [c[0], c[1], c[2]] as Vec3);
  if (hasAnySteps(panel)) return verts;
  const myOrder = orderOf(panel);
  for (const q of siblings) {
    // İç panel (raf/dikme) köşe birleşimine girmez: gövde panelini uzatmaz, ucunu kapattırmaz.
    // Kapak da köşe birleşimine girmez (gövdenin önünde/arasında durur, gövde panelini uzatmaz).
    if (q.id === panel.id || orderOf(q) <= myOrder || hasAnySteps(q) || isInteriorPanel(q) || isInteriorPanel(panel) || isDoorPanel(q) || isDoorPanel(panel)) continue;
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
    console.log('[YAGO][İÇ-KÖŞE]', panel.id, 'uzadı', j.tQ.toFixed(1), 'mm →', q.id,
      'ucunu kapatıyor (sıra', myOrder, '<', orderOf(q), ') taşınanKöşeN=', moved);
  }
  return verts;
}

// ── DÖNÜŞ-KESİMİ: dönmüş/eğik BASAN kardeş, basılan paneli eğik düzlemiyle biçer ──
// Basılan panel, dönmüş basanın kendisine BAKAN büyük yüzünün yarım-uzayıyla
// kesilir; kesici o yüzün siluet prizmasıyla sınırlanır (yalnız basanın
// altında/üstünde kalan kısım gider). Yetki VF sırasıdır; bu paneli REF-dönüş
// hedefi alan basan kesmez (onu motor pahla şekillendirir).

/** VF normali dünya eksenlerinden birine paralel değilse yüz eğiktir (vertex düzenlemesi). */
function vfIsTilted(vf: VirtualFace | undefined | null): boolean {
  if (!vf?.normal) return false;
  return !isFlatNormal(vfNormal(vf));
}

/** Düzlem üzerinde ±H "sonsuz" dikdörtgen (yarım-uzay kesicisi tabanı). */
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
    // Sıra tek yetkidir — dönmüş bir raf/dikme de sırada SONRA gelen gövde panelini biçer.
    if (r.id === panel.id || orderOf(r) >= myOrder) continue;
    // KAPAK hiçbir gövde panelini kesmez — açılı referansı izleyen (eğik VF'li) kapak dönmüş basan sayılmaz.
    if (isDoorPanel(r)) continue;
    if (!panelHasRotation(r) && !vfIsTilted(vfOfPanel(r, vfs))) continue;
    if (stepRefTargets(r).rotate.has(panel.id)) {
      console.log('[YAGO][DÖNÜŞ-KESİM] MUAF', panel.id, '<-', r.id, '— r bu paneli REF DÖNÜŞ hedefi alıyor, düzlem kesimi yok');
      continue;
    }
    const rGeo = shapeById(r.id)?.geometry;
    const vfR = vfOfPanel(r, vfs);
    if (!rGeo || !vfR) continue;
    const nR = rotatedNormalOf(r, vfR);
    if (!nR || Math.abs(nR.dot(nS)) > 0.98) continue; // paralel yüz: kesim anlamsız
    if (!rGeo.getAttribute('position')) continue;
    const pts = uniqueMeshPoints(rGeo);
    const { min: dMin, max: dMax } = projRange(pts, nR);
    if (!(dMax - dMin > 1)) continue;
    const refD = ref.dot(nR);
    const keepPlus = refD > (dMin + dMax) / 2;           // panel çapanın tarafında kalır
    const dNear = keepPlus ? dMax : dMin;
    const toward = keepPlus ? nR.clone() : nR.clone().negate();
    // S bu düzlemi gerçekten geçiyor mu? Yüz köşeleri + kalınlık kadar içerisi sınanır.
    const slabPts: Vec3[] = [
      ...vfS.vertices,
      ...vfS.vertices.map(c => [c[0] - nS.x * thS, c[1] - nS.y * thS, c[2] - nS.z * thS] as Vec3),
    ];
    if (!slabPts.some(c => (c[0] * nR.x + c[1] * nR.y + c[2] * nR.z - dNear) * (keepPlus ? 1 : -1) < -0.5)) continue;
    try {
      // 1) Yarım-uzay: yakın yüz düzleminde dev dikdörtgen, R gövdesine doğru.
      const cR = new THREE.Vector3(); for (const q of pts) cR.add(q); cR.divideScalar(pts.length);
      const onPlane = cR.clone().addScaledVector(nR, dNear - cR.dot(nR));
      const H = 100000;
      const half = await createPanelFromVirtualFace(hugeRectOnPlane(onPlane, nR, H), [toward.x, toward.y, toward.z], H, 0);
      // 2) Siluet prizması: R'nin S yüzüne izdüşümü, S gövdesinin içinden geçirilir.
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
      console.log('[YAGO][DÖNÜŞ-KESİM]', panel.id, '<-', r.id, 'düzlemN=', fmtVec(nR, 2),
        'yakınYüz=', dNear.toFixed(1), 'çapa=', refD.toFixed(1), keepPlus ? '(+ taraf kalır)' : '(− taraf kalır)', 'siluetKöşeN=', hull.length);
    } catch (err) {
      console.warn('[YAGO][DÖNÜŞ-KESİM] kesim hatası:', panel.id, '<-', r.id, errMsg(err));
    }
  }
  return out;
}

// ── REF DÖNÜŞ: REFERANS PANELİN KENARI DÖNEN PANELE GÖRE PAHLANIR ────────────
// Dönen panel (R) nihai katısını alınca, R'nin seçilen yüzeyindeki çokgen
// nişan yönünde referansın (T) kalınlığını geçecek kadar uzatılıp +nR yönünde
// "sonsuz" prizma yapılır ve T'den çıkarılır. T'nin VF'si/ölçüsü dokunulmaz.
//   T basan (önce)  → R'nin DIŞ yüzeyi  (R, T'de biter)
//   T basılan/rest  → R'nin İÇ yüzeyi   (R, T'nin üstünden geçer)
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

  // R'nin DIŞ (nR yönünde en dış) ve İÇ (en iç) yüz çokgenleri — konveks gövde.
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
      // Çokgen nişan yönünde (eksen bileşeni atılmış) T'nin kalınlığını geçecek kadar uzatılır.
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
        console.log('[YAGO][REF-DÖN-PAH]', tid, '<-', panel.id, 'dış yüzey prizması referansa değmiyor, pah yok');
        continue;
      }
      const before = fmtBounds(t.replicadShape);
      const shaped = t.replicadShape.clone().cut(cutter);
      // Kutu okuması boş/bozuk sonuçta hata fırlatır → yazılmadan catch'e düşer (referans korunur).
      const after = fmtBounds(shaped);
      updateShape(tid, { geometry: convertReplicadToThreeGeometry(shaped), replicadShape: shaped } as any);
      console.log('[YAGO][REF-DÖN-PAH]', tid, '<-', panel.id,
        isRest ? `referans ${tIsBasan ? 'BASAN' : 'BASILAN'} + OTURMA: kenar dönen panelin İÇ (alt) yüzeyine göre pahlandı, temas köşesi korundu`
          : tIsBasan ? 'referans BASAN: kenar dönen panelin DIŞ yüzeyine göre pahlandı' : 'referans BASILAN: dönen panelin İÇ (alt) yüzeyine göre kısaltıldı',
        'N=', fmtVec(nR, 2), 'D=', dPlane.toFixed(1), 'kutu', before, '→', after, '(ölçü/VF dokunulmadı)');
    } catch (err) {
      console.warn('[YAGO][REF-DÖN-PAH] pah hatası:', tid, '<-', panel.id, errMsg(err));
    }
  }
}

// ── ETKİN GÖVDE KATISI (vertex düzenlemeli gövde) ────────────────────────────
// Store'daki replicadShape TABAN kutudur. Düzenleme varsa katı, düzenlenmiş
// mesh'in düzlemsel yüz gruplarından YARIM-UZAY kesişimiyle kurulur (dışbükey
// gövdede birebir, içbükeyde dışbükey örtü). Taban geometri × düzenleme başına önbellek.
const _bodySolidCache = new WeakMap<object, { key: string; solid: any }>();

/** Grup normali gövde merkezinden DIŞA bakacak şekilde çevrilir. */
function outwardNormal(g: { normal: THREE.Vector3; center: THREE.Vector3 }, center: THREE.Vector3): THREE.Vector3 {
  const n = g.normal.clone().normalize();
  if (n.dot(new THREE.Vector3().subVectors(g.center, center)) < 0) n.negate();
  return n;
}

async function effectiveBodySolid(parent: Shape): Promise<any | null> {
  const mods = parent.vertexModifications;
  if (!Array.isArray(mods) || mods.length === 0) return parent.replicadShape ? parent.replicadShape.clone() : null;
  const key = vertexModsKey(mods);
  const cached = parent.geometry ? _bodySolidCache.get(parent.geometry) : undefined;
  if (cached && cached.key === key) return cached.solid.clone();
  const geo = effectiveBodyGeometry(parent);
  const { groups } = getFacesAndGroups(geo);
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
  let cutN = 0;
  for (const g of groups) {
    const n = outwardNormal(g, center);
    const H = M * 2;
    // Dış yarım-uzay (createPanel −normal yönüne uzar → normal = −n).
    const outside = await createPanelFromVirtualFace(hugeRectOnPlane(g.center, n, H), [-n.x, -n.y, -n.z], H, 0);
    if (!outside) continue;
    try { solid = solid.cut(outside); cutN++; } catch (e) { console.warn('[YAGO][GÖVDE-KATI] yarım-uzay kesimi hatası:', errMsg(e)); }
  }
  console.log('[YAGO][GÖVDE-KATI]', parent.id, 'düzenlenmiş gövde katısı kuruldu: yüzN=', groups.length, 'kesimN=', cutN,
    'kutu=', fmtBounds(solid), 'mesh=', fmtBox3(bb), '(içbükey gövdede dışbükey örtü)');
  if (parent.geometry) _bodySolidCache.set(parent.geometry, { key, solid });
  return solid.clone();
}

/** Düzenlenmiş gövdenin EĞİK (eksen-hizasız) yüz düzlemleri — dışa normal + d. */
function tiltedBodyPlanes(parent: Shape): Array<{ n: THREE.Vector3; d: number }> {
  const mods = parent.vertexModifications;
  if (!Array.isArray(mods) || mods.length === 0 || !parent.geometry) return [];
  const geo = effectiveBodyGeometry(parent);
  const { groups } = getFacesAndGroups(geo);
  geo.computeBoundingBox();
  const center = new THREE.Vector3(); geo.boundingBox!.getCenter(center);
  const out: Array<{ n: THREE.Vector3; d: number }> = [];
  for (const g of groups) {
    if (isFlatNormal(g.normal.clone().normalize(), 0.999 - Number.EPSILON)) continue;
    const n = outwardNormal(g, center);
    out.push({ n, d: g.center.dot(n) });
  }
  return out;
}

/**
 * EĞİK YÜZE DAYANAN DÜZ PANEL: eğik gövde düzlemi üzerindeki VF köşeleri o
 * düzlemin VF-düzlemi içindeki dışa yönünde uzatılır; ardından gövde katısıyla
 * kesişim (clipToBody) ucu tam eğime göre pahlar.
 */
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

/**
 * Paneli gövde katısıyla kesiştirir; hata → olduğu gibi. Düz panelde (tag EĞİK-UÇ)
 * yalnız düzenlenmiş gövde; dönmüş panelde (DÖNÜŞ-SIĞDIR) gövde yoksa parametre kutusu.
 */
/**
 * DÖNMÜŞ RAF/DİKME ÜYESİ KENDİ HACMİNDE KALIR (Goker: "rotate edince dikme volümünün
 * dışına çıktı, çıkmamalı"): büyütülüp sığdırılan üye, grubunun çözülmüş hacim KUTUSUYLA
 * (eksen-hizalı düzlemler) kesişir → uçlar hacim sınırında açıya göre düz pahlanır;
 * şekilli (L) hacmin şekli panelin kalınlığına geçmez (yalnız düzlem kesimi).
 */
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
    const before = fmtBounds(rp);
    const out = rp.intersect(box);
    console.log('[YAGO][DÖNÜŞ-HACİM]', panel.id, 'grup hacmine kırpıldı', gid, 'hacim=', c.min.map(n => n.toFixed(0)).join(',') + '..' + c.max.map(n => n.toFixed(0)).join(','), before, '→', fmtBounds(out));
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
    const before = fmtBounds(rp);
    const out = rp.intersect(body);
    console.log(`[YAGO][${tag}]`, panel.id, 'gövde kesişimi', before, '→', fmtBounds(out));
    return out;
  } catch (err) {
    console.warn(`[YAGO][${tag}] gövde kesişimi hatası:`, panel.id, errMsg(err));
    return rp;
  }
}

/**
 * BÜYÜT & SIĞDIR (dönmüş / eğik panel): büyütülmüş katı (1) gövdeyle kesişir
 * (açıya göre tam duvara kadar), (2) SIRADA ÖNCE gelen (basan) kardeşlerle
 * kesilir. REF çiftinde de sıra geçerli: basan referans keser; ama panel
 * referansa OTURUYORSA ('rest') kesmez — referansın kaması pahla gider.
 */
async function fitRotatedPanel(
  rp: any, panel: Shape, parent: Shape, siblings: Shape[], orderOf: (s: Shape) => number, refContacts: Map<string, RefContact>,
): Promise<any> {
  let out = await intersectWithBody(rp, panel, parent, 'DÖNÜŞ-SIĞDIR', true);
  const myOrder = orderOf(panel);
  const myRefTargets = stepRefTargets(panel).rotate;
  for (const b of siblings) {
    // Sıra tek yetkidir — sırada ÖNCE gelen raf/dikme de dönmüş gövde panelini keser.
    if (b.id === panel.id || orderOf(b) >= myOrder) continue;
    if (isDoorPanel(b)) continue;   // kapak gövde panelini kesmez (gövdenin önünde durur)
    const isRefTarget = myRefTargets.has(b.id);
    if (isRefTarget && refContacts.get(b.id) === 'rest') {
      console.log('[YAGO][DÖNÜŞ-SIĞDIR]', panel.id, 'referansa OTURUYOR, referansla kesilmedi <-', b.id, '(referans kenarı pahlanacak)');
      continue;
    }
    const fresh = shapeById(b.id);
    if (!fresh?.replicadShape || !fresh.geometry) continue;
    try {
      if (!boundsOverlapBox(out.boundingBox.bounds, localBboxOf(fresh.geometry)!)) continue;
      out = out.cut(fresh.replicadShape.clone());
      console.log('[YAGO][DÖNÜŞ-SIĞDIR]', panel.id, isRefTarget ? 'REFERANS panelle kesildi <-' : 'basan kardeşle kesildi <-', b.id);
    } catch (err) {
      console.warn('[YAGO][DÖNÜŞ-SIĞDIR] kardeş kesimi hatası:', panel.id, '<-', b.id, errMsg(err));
    }
  }
  return out;
}

// ── REBUILD ORKESTRASYONU ────────────────────────────────────────────────────

export interface RebuildOpts {
  /** Yalnız bu panel işlem gördü ve sıralama DEĞİŞMEDİ → mümkünse tek-panel modu. */
  changedPanelId?: string;
  orderChanged?: boolean;
}
const inFlight = new Set<string>();
const pending = new Map<string, RebuildOpts | undefined>();

/**
 * Parent'ın tüm panellerini yeniden üretir. Aynı parent için çalışan bir
 * rebuild varsa çağrı kuyruğa alınır (TAM rebuild isteği her zaman korunur).
 */
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

/** Çözülen değerleri adımlara `resolvedValue` olarak geri yazar; hiçbiri değişmediyse null. */
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

/** Panel kimliğindeki zaman damgası (VF'siz panellerin sıra yedeği). */
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

  // SIRA: referans verilen panel ÖNCE üretilir (bağ güncel geometriden çözülsün);
  // aralarında bağ olmayan çiftlerde VF sırası (basan/basılan) geçerlidir.
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

  // ── TEK-PANEL MODU: yalnız işlem gören panel yeniden üretilir, VF'ler
  //    yeniden hesaplanmaz (değişmeyen komşuların ayak izi sabit → salınım
  //    olmaz). Şu durumlarda TAM rebuild şarttır:
  //    • panel BASAN (sonrasında kardeş var) → basılanlar yeni konuma göre çözülmeli
  //    • önceki bir panelle iç köşe ortağı → onun uzaması değişebilir
  //    • paneli referans alan kardeş var → bağ yeniden çözülmeli
  //    • panel ref-dönüş hedeflerini pahlıyor → hedef sıfırdan üretilmeli
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
    // RAF/DİKME GRUBU VARSA: gövde paneli değişince iç gruplar hacmi yeniden
    // çözmeli (gövde panelleri iç grupları HER sırada sınırlar) → tam rebuild.
    const boundsGroups = !isInteriorPanel(changedChild) && !isDoorPanel(changedChild) && (fresh.panelGroups.some(g => g.shapeId === parentShapeId) || fresh.doorGroups.some(g => g.shapeId === parentShapeId));
    const cancel: Array<[boolean, string]> = [
      [pressed.length > 0, `sıra= ${changedOrder} basılanKardeşN= ${pressed.length} → basan panel taşındı/değişti, basılan kardeşlerin VF bölgeleri yeniden çözülecek`],
      [cornerPartner, '→ önceki panelle iç köşe ortağı, köşe uzaması yeniden çözülecek'],
      [refDependents.length > 0, `→ referans bağımlıları var: ${refDependents.map(c => c.id).join(',')} (referans köşe/düzlem güncel geometriden yeniden çözülecek)`],
      [stepRefTargets(changedChild).rotate.size > 0, '→ referans panel(ler)in kenarını pahlıyor, referans sıfırdan üretilip yeniden pahlanacak'],
      [boundsGroups, '→ gövdede raf/dikme grubu var, hacimler yeniden çözülecek'],
    ];
    for (const [hit, why] of cancel) if (hit) console.log('[YAGO][REBUILD] TEK-PANEL MODU İPTAL', changedChild.id, why);
    singleMode = !cancel.some(([hit]) => hit);
  }

  const parentPos = [...parentFresh.position] as Vec3;
  const pp: any = parentFresh.parameters || {};
  const growForRotated = Math.max(parseFloat(pp.width) || 0, parseFloat(pp.height) || 0, parseFloat(pp.depth) || 0, 600) * 1.5;

  const buildPanel = async (panel: Shape, vfsIn: VirtualFace[]): Promise<void> => {
    try {
      const vf = vfOfPanel(panel, vfsIn);
      if (!vf || !vf.vertices || vf.vertices.length < 3 || !(panel.parameters as any)?.parentShapeId) return;
      const thickness = panelThickness(panel);
      let steps = getUnifiedSteps(panel);
      let stepsChanged = false;
      // ESKİ FIXED ADIMLAR: fixedRef yoksa bu rebuild'deki ham yüz konumu kaydedilir.
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
      // Üretim köşeleri: VF + iç köşe uzaması (VF'nin kendisi değişmez).
      const buildVerts = cornerJoinedVertices(panel, vf, vfsIn, children, orderOf);
      // DÖNMÜŞ veya VF-EĞİK panel = BÜYÜT & SIĞDIR; düz panel gerçek boyutta.
      const vfTilted = vfIsTilted(vf);
      // KAPAK: VF'si açılı referans paneli izleyebilir (DoorService AÇILI REFERANS) ya da kendisi döndürülmüş olabilir —
      // gövdenin önünde durur; gövdeyle SIĞDIRILMAZ, kardeşlerle kesilmez (fitRotatedPanel yok). Adımlar yine uygulanır.
      const isRotated = !isDoorPanel(panel) && (panelHasRotation(panel) || vfTilted);
      if (vfTilted && !panelHasRotation(panel) && !isDoorPanel(panel)) {
        console.log('[YAGO][EĞİK-VF]', panel.id, 'VF eğik (vertex düzenlemesi) → dönmüş gibi sığdırılacak. n=', vf.normal.map(n => n.toFixed(2)).join(','));
      }
      // Düz panel + eğik gövde yüzü: VF köşeleri uzatılır, sonra gövdeyle kesilir.
      let genVerts = buildVerts;
      let needsBodyClip = false;
      // İÇ PANEL (raf/dikme): hacim eksen-hizalı kutudur; gövde vertex düzenlemeli
      // (eğik yüzlü) ise levha gövde katısıyla kesilir ki eğik yüzden taşmasın.
      if (!isRotated && isInteriorPanel(panel) && Array.isArray(parentFresh.vertexModifications) && parentFresh.vertexModifications.length > 0) needsBodyClip = true;
      // KAPAK: gövdenin dışında/önünde durur — eğik gövde yüzüne uzatılmaz, gövdeyle kesilmez.
      if (!isRotated && !isDoorPanel(panel)) {
        const planes = tiltedBodyPlanes(parentFresh);
        if (planes.length) {
          const ext = extendVertsOnTiltedPlanes(buildVerts, vf.normal, planes, thickness * 3 + 2);
          if (ext.moved > 0) {
            genVerts = ext.verts; needsBodyClip = true;
            console.log('[YAGO][EĞİK-UÇ]', panel.id, 'VF köşeleri eğik gövde yüzünde: uzatılanKöşeN=', ext.moved, 'eğikDüzlemN=', planes.length, '→ gövdeyle kesilecek');
          }
        }
      }
      let rp = await createPanelFromVirtualFace(genVerts, vf.normal, thickness, isRotated ? growForRotated : 0);
      if (!rp) return;

      // Adımlar (move/rotate) sırayla; REF dönüş açıları adıma geri yazılır (değiştiyse).
      const { ops, resolvedRotations } = composeSteps(steps, vf);
      const mergedRot = mergeResolved(steps, resolvedRotations);
      if (mergedRot) { steps = mergedRot as TransformStep[]; stepsChanged = true; }
      let refDeltaApplied: Vec3 | null = null;
      for (const op of ops) {
        if (op.kind === 'translate') {
          rp = rp.translate(op.d.x, op.d.y, op.d.z);
        } else if (op.kind === 'refTranslate') {
          // rp'nin o anki DÜNYA kutusu (mesh kutusu + parentPos) → hedef köşeye kilitli delta.
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

      // YÜZ EXTRUDE: panel artık doğru çerçevede; saklı adımlar aynı çerçevede uygulanır.
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

      // Dönmüş basanların eğik düzlem kesimi, sonra ref-dönüş hedeflerinin pahı.
      if (!panelHasRotation(panel) && !isDoorPanel(panel)) {
        rp = await cutByRotatedPressers(rp, panel, vf, children, vfsIn, orderOf, createPanelFromVirtualFace);
      }
      await shapeRefRotateTargets(rp, panel, vf, children, orderOf, refContacts, updateShape, convertReplicadToThreeGeometry, createPanelFromVirtualFace);

      // Katı extrude'dan sonra değişmediyse mevcut mesh yeniden kullanılır (aynı tessellation).
      const geometry = meshed && meshed.shape === rp ? meshed.geometry : convertReplicadToThreeGeometry(rp);
      const paramPatch: any = {};
      if (dimsUpdate) Object.assign(paramPatch, dimsUpdate);
      if (resolvedStepsUpdate) paramPatch.extrudeSteps = resolvedStepsUpdate;
      if (refDeltaApplied) paramPatch._refDeltaApplied = refDeltaApplied;
      if (stepsChanged) paramPatch.transformSteps = steps;
      // ANINDA YAZ: sonraki panel ve VF yeniden hesabı güncel ayak izini görsün.
      updateShape(panel.id, {
        geometry, position: parentPos, rotation: [0, 0, 0], replicadShape: rp,
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

  // İKİ SIRA-DUYARLI GEÇİŞ: her panelden sonra VF'ler (store değil, currentVfs
  // üzerinden) yeniden hesaplanır; ikinci geçiş ilk geçişin bayat komşu
  // geometrisiyle çözülen bölgeleri düzeltir. Sonunda VF'ler store'a yazılır.
  const recalc = (vfs: VirtualFace[]) => {
    const st = useAppStore.getState();
    const parentNow = shapeById(parentShapeId, st.shapes) || parentFresh;
    return recalculateVirtualFacesForShape(parentNow, vfs, st.shapes, st.panelGroups);
  };
  let currentVfs = recalc(useAppStore.getState().virtualFaces);
  for (let pass = 0; pass < 2; pass++) {
    for (const panel of children) {
      await buildPanel(panel, currentVfs);
      currentVfs = recalc(currentVfs);
    }
  }
  // Yalnız bu parent'ın VF'lerinin regen'e ait (geometrik) alanları TEK store
  // güncellemesiyle yazılır. Rebuild sürerken kullanıcının değiştirdiği alanlar
  // (not, hasPanel, yüzeyin şeklini al) eski anlık görüntüyle ezilmez.
  const patches = new Map<string, Partial<VirtualFace>>();
  for (const f of currentVfs) {
    if (f.shapeId !== parentShapeId) continue;
    const p: any = {};
    for (const k of VF_REGEN_FIELDS) if (k in f) p[k] = (f as any)[k];
    patches.set(f.id, p);
  }
  useAppStore.setState(st => ({ virtualFaces: st.virtualFaces.map(f => (patches.has(f.id) ? { ...f, ...patches.get(f.id) } : f)) }));
  // Raf/dikme gruplarının store'daki hacim/boşluk değerleri son çözümle eşitlenir.
  try { syncPanelGroups(parentShapeId); } catch (err) { console.warn('[YAGO][GRUP-SENKRON] hata:', errMsg(err)); }
  try { syncDoorGroups(parentShapeId); } catch (err) { console.warn('[YAGO][KAPAK-SENKRON] hata:', errMsg(err)); }
}

/** VF yeniden hesabının sahip olduğu alanlar (geri kalanı kullanıcı verisidir). */
const VF_REGEN_FIELDS = ['normal', 'center', 'vertices', 'rawFaceBBox', 'sideRelations', 'regionAnchor'] as const;

// ═══════════════════════════════════════════════════════════════════════════
// VirtualFaceUpdateService — VF (sanal yüz) BÖLGE YENİDEN HESABI.
//
// Her VF, eşleşen gövde yüzünün konturundan yeniden üretilir ve kardeş
// panellerin AYAK İZLERİ (damga) ile kırpılır. Damga yetkisi TEK YÖNLÜ: bir
// VF'yi yalnız VF sırasında kendinden ÖNCE gelen (basan) kardeşler damgalar;
// istisna yalnız paneli fiziksel olarak bu yüze doğru İLERLETEN adımlardır
// (farklı yüzdeki taşıma; işaretli miktarı yüze doğru olan extrude).
// Datum'unu damgalayamazsın: ref-taşıma/ref-dönüş/extrude-ref hedefi olan
// panelin bölgesi, onu referans alan panel tarafından kırpılmaz.
// Her VF parentFaceShape modelindedir: VF = eşleşen yüz bileşeninin konturu ∩ serbest bölge.
// Serbest bölgenin kendisi FaceRegion.computeFreeRegionLocal'dadır (yakalama
// ile aynı fonksiyon → highlight = panel).
// ═══════════════════════════════════════════════════════════════════════════

type RawBBox = { xMin: number; xMax: number; yMin: number; yMax: number; xSpan: number; ySpan: number };

/** Noktaların (u,v) kutusu; span'ler 1e-6 ile alttan sınırlı. */
function uvBox(pts: Iterable<{ x: number; y: number }>): RawBBox {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const q of pts) { if (q.x < xMin) xMin = q.x; if (q.x > xMax) xMax = q.x; if (q.y < yMin) yMin = q.y; if (q.y > yMax) yMax = q.y; }
  return { xMin, xMax, yMin, yMax, xSpan: Math.max(xMax - xMin, 1e-6), ySpan: Math.max(yMax - yMin, 1e-6) };
}
/** Bir düzlem tabanı (n,u,v) için 3B↔2B dönüşümleri. */
function planeFrame(n3: THREE.Vector3) {
  const { u, v } = getFacePlaneAxes(n3);
  const dU = (a: Vec3) => a[0] * u.x + a[1] * u.y + a[2] * u.z;
  const dV = (a: Vec3) => a[0] * v.x + a[1] * v.y + a[2] * v.z;
  const dN = (a: Vec3) => a[0] * n3.x + a[1] * n3.y + a[2] * n3.z;
  const at = (pu: number, pv: number, pn: number): Vec3 => [u.x * pu + v.x * pv + n3.x * pn, u.y * pu + v.y * pv + n3.y * pn, u.z * pu + v.z * pv + n3.z * pn];
  return { u, v, dU, dV, dN, at };
}

/** VF bölge çokgeninden (ön halka) + kalınlık kadar geri (arka halka) indeksli prizma. */
function buildPrismFromVertices(vertices: Vec3[], normal: Vec3, thickness: number): THREE.BufferGeometry | null {
  const N = vertices.length;
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const front = vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const back = front.map(p => p.clone().addScaledVector(n, -thickness)); // extrude(-th) ile aynı yön
  const arr = new Float32Array(N * 2 * 3);
  [...front, ...back].forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; });
  // Kapaklar fan (dış kenarlar tek kullanımlı kalır → kenar-halkası doğru), yanlar quad.
  const idx: number[] = [];
  for (let i = 1; i < N - 1; i++) idx.push(0, i, i + 1);            // ön kapak
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

/** Taze ham kontur köşelerinin (u/v) kutusu + düzlem ofseti. */
function freshRawBox(freshRawVerts: Vec3[], f: ReturnType<typeof planeFrame>) {
  return { ...uvBox(freshRawVerts.map(p => ({ x: f.dU(p), y: f.dV(p) }))), planeD: f.dN(freshRawVerts[0]) };
}
/** Eski ham kutudan yeni ham kutuya taşıma: boyut aynı (±1 mm) → yalnız öteleme, değişti → oransal. */
function remapUV(pu: number, pv: number, oldRaw: RawBBox, nb: RawBBox): { x: number; y: number } {
  if (Math.abs(oldRaw.xSpan - nb.xSpan) < 1 && Math.abs(oldRaw.ySpan - nb.ySpan) < 1) {
    return { x: pu + (nb.xMin + nb.xMax) / 2 - (oldRaw.xMin + oldRaw.xMax) / 2, y: pv + (nb.yMin + nb.yMax) / 2 - (oldRaw.yMin + oldRaw.yMax) / 2 };
  }
  return { x: nb.xMin + ((pu - oldRaw.xMin) / oldRaw.xSpan) * nb.xSpan, y: nb.yMin + ((pv - oldRaw.yMin) / oldRaw.ySpan) * nb.ySpan };
}

/**
 * DAMGA TABANI = panelin KENDİ VF bölgesi (ham yüz konturu değil). Kutu
 * boyutu değiştiyse bölge kayıtlı rawFaceBBox'tan güncel ham kutuya taşınır:
 * boyut aynı → yalnız öteleme, değişti → oransal. Kayıtlı taban yoksa bölge
 * güncel düzleme izdüşürülür; ham yüzün dışına taşıyorsa ham kontura düşülür.
 */
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

/**
 * Extrude'lu panelin DAMGASI: VF tabanı, adımların İŞARETLİ miktarı kadar
 * budanır (gerçek extrude ile birebir: ref → resolvedValue, fixed → value −
 * açıklık, dyn → value). Hedef yüze BAKAN adımın büyümesi yansıtılmaz
 * (komşu gereksiz kısalmasın); yalnız kısalma yansır.
 *
 * KALINLIK EXTRUDE'U (adım normali ≈ VF normali): panelin BÜYÜK yüzü itilmiştir →
 * damga ÖTELENMEZ, KALINLAŞIR/İNCELİR. Kalınlık aralığı VF düzlemine göre
 * [tMin, tMax] tutulur (başlangıç [−th, 0]); dış yüz adımı tMax'ı, iç yüz adımı
 * tMin'i oynatır; fixed açıklık = o anki kalınlık (applyOneExtrudeStep'teki
 * faceDist ile birebir). Eskiden bölge adım miktarı kadar kaydırılıp 18 mm'lik
 * prizma kuruluyordu: 100 mm'ye extrude edilmiş raf/üst panel basılan yan panele
 * hâlâ 18 mm'lik (fixed'de üstelik 18 mm yanlış yerde) iz bırakıyordu.
 */
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
      console.log('[YAGO][DAMGA-KALINLIK]', 'eN=', fmtVec(eN, 0), resolvedN ? 'ref-çözülü' : step.isFixed ? 'fixed' : 'dyn',
        'value=', (step.value ?? 0).toFixed(1), 'mevcut=', cur.toFixed(1), 'amount=', amountN.toFixed(1), alignN > 0 ? '(dış yüz)' : '(iç yüz)');
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
    console.log('[YAGO][DAMGA-TRIM]', 'eN=', fmtVec(eN, 0),
      resolved ? 'ref-çözülü' : step.isFixed ? 'fixed' : 'ref-ÇÖZÜLMEMİŞ/dyn',
      'value=', (step.value ?? 0).toFixed(1), 'amount=', amount.toFixed(1), Math.abs(amount) < 0.01 ? '→ TRIM YOK (tam boy)' : '→ trim');
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
  // Ön halka = VF düzlemi + tMax (dış yüz itildiyse ileride), kalınlık = tMax − tMin.
  const front: Vec3[] = Math.abs(tMax) < 1e-9 ? trimmed
    : trimmed.map(([x, y, z]) => [x + vfN.x * tMax, y + vfN.y * tMax, z + vfN.z * tMax] as Vec3);
  return buildPrismFromVertices(front, vf.normal, tMax - tMin);
}

/**
 * ORANSAL DAMGA (düz panel, kutu boyutlanınca): panelin baked mesh'i henüz
 * eski boyuttadır; eski VF bölgesi eski ham kutudan yeni ham kutuya taşınarak
 * geçici damga üretilir. Boyut/konum değişmemişse null (baked mesh kullanılır).
 */
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

// ── YÜZ EŞLEME (VF → güncel gövde yüz grubu) ────────────────────────────────

/**
 * VF'nin güncel geometrideki yüz grubu. Öncelik: (1) descriptor (VF merkezini
 * ±5 mm kapsıyorsa), (2) aynı düzlemdeki adaylardan VF merkezine en yakın grup,
 * (3) merkez-kutusu, (4) en yakın merkez.
 * Eğilmiş yüz (vertex düzenlemesi): normal süzgeci boşsa dot>0.5 olan en yakın grup.
 */
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
    if (best) {
      console.log('[YAGO][VF-EĞİM]', vf.id, 'eğik yüz eşlendi: dot=', bestDot.toFixed(2), 'mesafe=', bestD.toFixed(1),
        'eskiN=', vf.normal.map(n => n.toFixed(2)).join(','), 'yeniN=', [best.normal.x, best.normal.y, best.normal.z].map(n => n.toFixed(2)).join(','));
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

// ── ANA GİRİŞ ────────────────────────────────────────────────────────────────

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

/** Ayak izi hesabına giden damga işlemleri (FaceRegion.RotOp ile aynı biçim). */
type RotOp = { kind: 'rotate' | 'translate'; pivot?: THREE.Vector3; axis?: THREE.Vector3; angleRad?: number; d?: THREE.Vector3 };

/**
 * Bir parent'ın tüm VF'lerini güncel gövde geometrisi + kardeş ayak izleriyle
 * yeniden hesaplar (saf: yeni VF dizisi döner, store'a yazmaz).
 */
function recalculateVirtualFacesForShape(shape: Shape, virtualFaces: VirtualFace[], allShapes?: any[], panelGroups?: PanelGroup[]): VirtualFace[] {
  const allShapeFaces = virtualFaces.filter(vf => vf.shapeId === shape.id);
  if (allShapeFaces.length === 0 || !shape.geometry) return virtualFaces;
  // İÇ VF'LER (raf/dikme): yüz eşlemesine girmez, grup çözücüsü yazar (aşağıda).
  const shapeFaces = allShapeFaces.filter(vf => !isInteriorVf(vf));
  const interiorMap = panelGroups
    ? recalculateInteriorVfs(shape, allShapeFaces.filter(vf => isInteriorVf(vf) && !isDoorVf(vf)), (allShapes || []) as Shape[], panelGroups)
    : new Map<string, VirtualFace>();
  // KAPAK VF'LERİ: sınır panellerinin güncel kutularından çözülür (DoorService).
  for (const [id, vf] of recalculateDoorVfs(shape, allShapeFaces.filter(isDoorVf), (allShapes || []) as Shape[], useAppStore.getState().doorGroups)) interiorMap.set(id, vf);
  if (shapeFaces.length === 0) return virtualFaces.map(vf => interiorMap.get(vf.id) || vf);

  // VERTEX DÜZENLEMELİ GÖVDE: VF'ler düzenlenmiş (etkin) yüzlere göre hesaplanır.
  const eff = effectiveBodyGeometry(shape);
  if (eff !== shape.geometry) {
    console.log('[YAGO][VERTEX] VF regen düzenlenmiş gövde geometrisiyle:', shape.id, 'düzenlemeN=', shape.vertexModifications?.length ?? 0);
    shape = { ...shape, geometry: eff };
  }
  const { faces, groups: faceGroups } = getFacesAndGroups(shape.geometry);
  const worldToLocal = getShapeMatrix(shape).invert();
  // İÇ PANELLER (raf/dikme) de kardeş listesindedir: VF sırasında ÖNCE geldikleri gövde
  // panelini damgalarlar (Goker: "6. sırada dikme, 7. sırada dikmeye değen gövde paneli →
  // gövde paneli dikme ile rafın arasında kalmalı"); yetki yalnız sıradır (bkz. stamps).
  const childPanels = childPanelsOf(shape.id, (allShapes || []) as Shape[]);
  const vfById = new Map(virtualFaces.map(f => [f.id, f] as const));
  const vfIndexOf = new Map<string, number>();
  virtualFaces.forEach((f, i) => vfIndexOf.set(f.id, i));
  const panelPriority = (p: any) => vfIndexOf.get(p?.parameters?.virtualFaceId) ?? Number.MAX_SAFE_INTEGER;
  const refsCache = new Map<string, ReturnType<typeof stepRefTargets>>();
  const refsOf = (p: any) => { let r = refsCache.get(p.id); if (!r) { r = stepRefTargets(p); refsCache.set(p.id, r); } return r; };

  // ÖN-GEÇİŞ: her VF'nin eşleşen yüz grubu + konturu (regen de aynısını kullanır)
  // ve güncel HAM kontur köşeleri (damga tabanları için).
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
  // DAMGA TABANI: her VF için panelin KENDİ bölgesi (güncel ham kutuya taşınmış).
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
  // YÖN TESTİ: extrude adımı paneli bu yüze DOĞRU ilerletiyor mu ((miktar × eN)·n > 0)?
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

  // TAŞIMA YÖN TESTİ (extrude ile aynı kural): taşınmış panel sırayı ancak taşıması onu bu
  // yüze DOĞRU itiyorsa devirebilir (Δ·n > 0). Yüze paralel taşıma (alt panelin altındaki ön
  // şeridi arkaya kaydırmak) yetki vermez — eskiden her taşınmış panel farklı yüzdeki
  // önceki paneli basıyor, alt panel alttan geçen şeritle kısalıyor, yeni panelin bölgesi
  // de alt panelin izini kaybedip tam yüksekliğe çıkıyordu.
  const moveRedLogged = new Set<string>();
  const moveAdvancesTowardFace = (p: any, n: THREE.Vector3 | null): boolean => {
    if (!n || !hasMoveSteps(p)) return false;
    const rda = p.parameters?._refDeltaApplied;
    let d: THREE.Vector3;
    if (Array.isArray(rda) && rda.length === 3) d = new THREE.Vector3(rda[0], rda[1], rda[2]);
    else { try { const r = applyTransformSteps([0, 0, 0], [0, 0, 0], getUnifiedSteps(p)); d = new THREE.Vector3(...r.position); } catch { return true; } }
    return d.dot(n) > 0.01;
  };

  /** p, VF'yi damgalama yetkisine sahip mi? (sıra önceliği + fiziksel ilerleme istisnası) */
  const stamps = (p: any, vfId: string, myPanel: any, myFaceNormal: THREE.Vector3 | null): boolean => {
    if (p.parameters?.virtualFaceId === vfId) return false;
    // KAPAK hiçbir gövde panelini damgalamaz (gövdenin önünde/arasında durur, bölge kesmez).
    if (isDoorPanel(p)) return false;
    // RAF/DİKME: yalnız VF sırasıyla basar — taşıma/extrude istisnası yok. Sırada ÖNCE ise
    // sonra gelen gövde panelinin bölgesini keser; SONRA ise gövde paneli onun hacmini sınırlar
    // (PanelGroupService.groupObstacles aynı sırayı okur → tek yönlü sözleşme).
    if (isInteriorPanel(p)) {
      const myIdx = vfIndexOf.get(vfId);
      const byOrder = myIdx != null && panelPriority(p) < myIdx;
      if (byOrder) console.log('[YAGO][DAMGA-YETKI] İÇ PANEL BASAN', vfId, '<-', p.id, '(sıra', panelPriority(p), '<', myIdx, ')');
      return byOrder;
    }
    if (myPanel && refsOf(myPanel).extrude.has(p.id)) return false;
    if (myPanel && refsOf(p).rotate.has(myPanel.id)) {
      console.log('[YAGO][DAMGA-YETKI] RED', vfId, '<-', p.id, '— p bu paneli REF DÖNÜŞ HEDEFİ alıyor → bölge kırpılmaz, motor kenarı pahlar');
      return false;
    }
    const pIsRefBoundToMe = !!myPanel && refsOf(p).move.has(myPanel.id);
    if (myPanel && refsOf(p).extrude.has(myPanel.id) && extrudeAdvancesTowardFace(p, myFaceNormal)) return true;
    // Farklı yüzdeki taşınmış / yüze doğru extrude'lu panel sırayı devirebilir (datum hariç).
    const pVf = vfById.get(p.parameters?.virtualFaceId);
    if (pVf && myFaceNormal) {
      const sameFace = Math.abs(myFaceNormal.dot(new THREE.Vector3(...pVf.normal).normalize())) > 0.95;
      if (!sameFace && pIsRefBoundToMe && hasMoveSteps(p) && !extrudeAdvancesTowardFace(p, myFaceNormal)) {
        console.log('[YAGO][DAMGA-YETKI] RED', vfId, '<-', p.id, '— p bu paneli REF TAŞIMA HEDEFİ (datum) alıyor', '→ taşıma istisnası iptal, karar sıra önceliğine bırakıldı');
      }
      if (!sameFace && hasMoveSteps(p) && !pIsRefBoundToMe && !moveAdvancesTowardFace(p, myFaceNormal)) {
        const myIdxT = vfIndexOf.get(vfId);
        if (myIdxT != null && panelPriority(p) >= myIdxT && !moveRedLogged.has(`${vfId}|${p.id}`)) {
          moveRedLogged.add(`${vfId}|${p.id}`);
          console.log('[YAGO][DAMGA-YETKI] RED', vfId, '<-', p.id, '— taşıma bu yüze doğru İLERLEMİYOR (paralel/uzaklaşıyor)', '→ taşıma istisnası yok, sıra önceliği korundu');
        }
      }
      if (!sameFace && ((hasMoveSteps(p) && !pIsRefBoundToMe && moveAdvancesTowardFace(p, myFaceNormal)) || extrudeAdvancesTowardFace(p, myFaceNormal))) return true;
    }
    const myIdx = vfIndexOf.get(vfId);
    const byOrder = myIdx != null && panelPriority(p) < myIdx;
    if (!byOrder && myPanel && myFaceNormal && (refsOf(p).extrude.has(myPanel.id) || hasExtrudeTowardFace(p, myFaceNormal)) && !extrudeAdvancesTowardFace(p, myFaceNormal)) {
      console.log('[YAGO][DAMGA-YETKI] RED', vfId, '<-', p.id, '— extrude bu yüze doğru İLERLEMİYOR (kısalıyor/ilgisiz eksen)', '→ sıra önceliği korundu, gereksiz kısaltma engellendi');
    }
    return byOrder;
  };

  /**
   * p'nin DAMGA temsili (ayak izi hesabına giren nesne):
   *  • extrude'lu: VF tabanı (yüze doğru ilerliyorsa) ya da budanmış taban + adım ops'u
   *  • düz: kutu boyutlandıysa oransal damga (taşınmışsa ötelemesiyle), yoksa gerçek mesh
   *  • dönmüş: motorun yazdığı NİHAİ geometri (ops'suz, kesit yolu)
   * Extrude'suz panelde sonuç hedef yüzden bağımsızdır → panel başına bir kez.
   */
  const stampCache = new Map<string, any>();
  const stampOf = (p: any, myFaceNormal: THREE.Vector3 | null): any => {
    const key = hasExtrudeSteps(p) ? `${p.id}|${myFaceNormal ? `${myFaceNormal.x},${myFaceNormal.y},${myFaceNormal.z}` : '-'}` : p.id;
    if (stampCache.has(key)) return stampCache.get(key);
    const r = buildStamp(p, myFaceNormal);
    stampCache.set(key, r);
    return r;
  };
  const buildStamp = (p: any, myFaceNormal: THREE.Vector3 | null): any => {
    // İÇ PANEL (düz): damga bu geçişte ÇÖZÜLMÜŞ grup VF'sinden (interiorMap) üretilir —
    // store mesh'i bir rebuild geride kalabilir (hacim yeni çözüldü). Dönmüş üye gerçek geometri yolunda.
    if (isInteriorPanel(p) && !isRotatedPanel(p)) {
      const ivf = interiorMap.get(p.parameters?.virtualFaceId) || vfById.get(p.parameters?.virtualFaceId);
      let geo: THREE.BufferGeometry | null = null;
      if (ivf?.vertices && ivf.vertices.length >= 3) {
        // EXTRUDE'LU ÜYE: damga GERÇEK kalınlık/uzunlukla kurulur (adımlar grup VF tabanına
        // uygulanır) — 100 mm'ye extrude edilmiş raf basılan gövde panelinde 18 mm görünmesin.
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
    // composeSteps (move/rotate) → ayak izine uygulanacak ops. REF taşıma deltası motorun
    // bu rebuild'de GERÇEKTEN uyguladığı değerden (_refDeltaApplied) okunur — tek kaynak.
    const composedFromSteps = (stampGeo?: THREE.BufferGeometry | null): RotOp[] | undefined => {
      if (!ownVf) return undefined;
      try {
        // Taze ham kontur köşeleri; bayat rawFaceBBox fixed telafisine karışmasın.
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
          // Taşınmış düz panel: damga panelin çözülmüş ÖTELEMESİ kadar kaydırılır (dönmüş yola sokulmaz).
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
    // Dönmüş panel: store'daki geometri ZATEN dönmüş/sığdırılmış → ops'suz gerçek geometri.
    return { ...p, __isRotatedPanel: true, __rotatedRealGeom: true, __composedOps: [] };
  };

  const stampingPanelsFor = (vfId: string): any[] => {
    const myPanel = childPanels.find(p => p.parameters?.virtualFaceId === vfId);
    const myVf = vfById.get(vfId);
    const myFaceNormal = myVf ? new THREE.Vector3(...myVf.normal).normalize() : null;
    return childPanels.filter(p => stamps(p, vfId, myPanel, myFaceNormal)).map(p => stampOf(p, myFaceNormal));
  };

  // TAM YÜZ MODELİ: her gövde VF'si eşleşen yüz konturundan yeniden üretilir.
  const updatedMap = new Map<string, VirtualFace>();
  for (const vf of shapeFaces) {
    const m = matchOf.get(vf.id);
    const regen = m && m.contour ? regenerateParentFaceShapeVF(vf, shape.id, m.group, m.contour, worldToLocal, stampingPanelsFor(vf.id)) : null;
    updatedMap.set(vf.id, regen || vf);
  }
  return virtualFaces.map(vf => updatedMap.get(vf.id) || interiorMap.get(vf.id) || vf);
}

/**
 * VF = eşleşen yüz bileşeninin konturu ∩ serbest bölge (yakalama ile aynı
 * computeFreeRegionLocal). Seed (tıklama noktası) MUTLAK kalır, yalnız güncel
 * yüz düzlemine izdüşer ve yüz kutusuna kırpılır. Taraf sözleşmesi
 * (sideRelations) STORED-WINS birleşir → panel ilk yerleştiği tarafta kalır.
 */
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

  const anchorB = ((vf as any).rawFaceBBox as RawBBox | undefined) ?? newB;
  if (anchorB !== newB && (Math.abs(anchorB.xSpan - newB.xSpan) > 1 || Math.abs(anchorB.ySpan - newB.ySpan) > 1)) {
    console.log('[YAGO][BOYUT-DEĞİŞİM]', vf.id, 'eskiBBox=', `${anchorB.xSpan.toFixed(0)}x${anchorB.ySpan.toFixed(0)}`,
      'yeniBBox=', `${newB.xSpan.toFixed(0)}x${newB.ySpan.toFixed(0)}`, '→ taraf sözleşmesi KORUNUYOR (kalıcı), seed mutlak');
  }
  const storedRel = (vf as any).sideRelations as Record<string, number> | undefined;
  const prevRegion = vf.vertices && vf.vertices.length >= 3 ? vf.vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z)) : undefined;
  const region = computeFreeRegionLocal(contour.corners, localNormal, seed, siblingPanels, worldToLocal, shapeId, prevRegion, storedRel, !!vf.fitFaceShape);

  // TEŞHİS: her kardeşin bu yüzdeki ayak izi (çok parçalıysa parça parça).
  if (region) {
    const pieceCount = new Map<string, number>();
    for (const id of region.footprintIds) if (id) { const base = id.split('#')[0]; pieceCount.set(base, (pieceCount.get(base) || 0) + 1); }
    region.footprints.forEach((fp, f) => {
      const id = region.footprintIds[f];
      if (!id) return;
      const [base, k] = id.split('#');
      const sp = siblingPanels.find(s => s.id === base);
      const b = uvBox(fp);
      const n = pieceCount.get(base) || 1;
      console.log('[YAGO][AYAKİZİ]', vf.id, '<-', base, 'boyut=', `${(b.xMax - b.xMin).toFixed(0)}x${(b.yMax - b.yMin).toFixed(0)}`,
        'u=', `${b.xMin.toFixed(0)}..${b.xMax.toFixed(0)}`, 'v=', `${b.yMin.toFixed(0)}..${b.yMax.toFixed(0)}`, 'köşeN=', fp.length,
        isRotatedPanel(sp) ? 'DÖNMÜŞ' : 'düz', n > 1 ? `parça ${(k ? Number(k) : 0) + 1}/${n}` : '');
    });
  }

  const cornersOut = region && region.polygon.length >= 3 ? region.polygon.map(to3D) : contour.corners;
  const ob = uvBox(cornersOut.map(uvOf));
  const outUSpan = ob.xMax - ob.xMin, outVSpan = ob.yMax - ob.yMin;
  console.log('[YAGO][REGEN]', vf.id, 'yeniMerkez=', fmtVec(newCenter),
    'hamKöşeN=', contour.corners.length, 'VFköşeN=', cornersOut.length,
    'ayakİziN=', region ? region.footprints.length : -1, 'kardeşN=', siblingPanels.length,
    'oranTabanı=', (vf as any).rawFaceBBox ? 'kayıtlıHam' : 'mutlak(ilk)',
    'VFboyut=', `${outUSpan.toFixed(0)}x${outVSpan.toFixed(0)}`,
    'küçülme=', `u%${((1 - outUSpan / Math.max(newB.xSpan, 1e-6)) * 100).toFixed(0)} v%${((1 - outVSpan / Math.max(newB.ySpan, 1e-6)) * 100).toFixed(0)}`,
    outUSpan < 30 || outVSpan < 30 ? '⚠️KIYMIK(regen)' : 'dolu');

  const out: any = {
    ...vf,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    vertices: cornersOut.map(c => [c.x, c.y, c.z] as Vec3),
    center: [newCenter.x, newCenter.y, newCenter.z],
  };
  // HAM kontur kutusu → bir sonraki regen'in taşıma/oran tabanı.
  out.rawFaceBBox = { ...newB };
  // TARAF SÖZLEŞMESİ: kayıtlı işaretler kazanır; region yalnız YENİ kardeşleri ekler.
  out.sideRelations = { ...(region?.sideRelations || {}), ...(storedRel || {}) };
  if (region?.anchor) { const a = to3D(region.anchor); out.regionAnchor = [a.x, a.y, a.z]; }
  if (region?.touchingSiblingIds?.length) console.log('[YAGO][TEMAS]', vf.id, 'temaslar=', region.touchingSiblingIds.join(', '));
  return out;
}
