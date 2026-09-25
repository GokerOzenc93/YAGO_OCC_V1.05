import * as THREE from 'three';
import { useAppStore, type Shape, type VirtualFace } from '../store';
import { matchReferenceFace, resolveReferenceFacePlane, type ExtrudeStep } from './FaceExtrudeService';
import { getFacesAndGroups } from './GeometryUtils';
import { convexHull2D, panelHasRotation } from './FaceRegion';
import { effectiveBodyGeometry, vertexModsKey } from './VertexEditorService';
import { getUnifiedSteps, stepRefTargets, type TransformStep } from './PanelSteps';
import {
  axisDirToVec, getFacePlaneAxes, resolveVfFracPoint, vfRawMinAlong, rotateAboutAxis, signedAngleAboutAxis,
  angleToTouchPlane, normDeg, worldBboxOf, pointFromFracBox, boundsOverlapBox, fmtBounds, fmtVec,
  uniqueMeshPoints, panelThickness, type Vec3,
} from './PanelMath';

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

const shapeById = (id: string | undefined) => useAppStore.getState().shapes.find(s => s.id === id);
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
  const idx = step.axis[0] === 'x' ? 0 : step.axis[0] === 'y' ? 1 : 2;
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
 * Eski (nokta tabanlı) bağ: hedef kutusundaki orana nişan alınır.
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
    if (!armPoint) return { deg: frozen };
    const target = shapeById(st.refTargetPanelId);

    if (st.refTargetFaceNormal && target) {
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
      const owner = useAppStore.getState().shapes.find(s => s.type === 'panel' && (s.parameters as any)?.virtualFaceId === vf.id);
      const thick = panelThickness(owner);
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

    // Eski nokta tabanlı bağ.
    const tgtBox = target ? worldBboxOf(target, effectiveBodyGeometry(target)) : null;
    const targetPoint = (tgtBox && st.refTargetFrac)
      ? pointFromFracBox(tgtBox, st.refTargetFrac as Vec3)
      : (st.refTargetVertex ? new THREE.Vector3(...(st.refTargetVertex as Vec3)) : null);
    if (!targetPoint) {
      console.warn('[YAGO][REF-DÖN] hedef geometri yok, donmuş açı kullanılıyor:', st.refTargetPanelId);
      return { deg: frozen };
    }
    const deg = signedAngleAboutAxis(armPoint.clone().sub(pivot).applyQuaternion(frame), targetPoint.clone().sub(pivot), axisWorld);
    if (deg === null) return { deg: frozen };
    console.log('[YAGO][REF-DÖN] çözülen açı=', deg.toFixed(2), 'hedef=', st.refTargetPanelId, 'hedefNokta=', fmtVec(targetPoint), 'nişan=', fmtVec(armPoint));
    return { deg: round3(deg) };
  } catch (err) {
    console.warn('[YAGO][REF-DÖN] açı çözümü hatası, donmuş açı:', (err as any)?.message || String(err));
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
  return (Array.isArray(q.transformSteps) && q.transformSteps.length > 0)
    || (Array.isArray(q.rotateSteps) && q.rotateSteps.length > 0)
    || (Array.isArray(q.extrudeSteps) && q.extrudeSteps.length > 0);
}

function projRange(verts: Vec3[], dir: THREE.Vector3): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const c of verts) {
    const d = c[0] * dir.x + c[1] * dir.y + c[2] * dir.z;
    if (d < min) min = d; if (d > max) max = d;
  }
  return { min, max };
}

/** P (önce) ile Q (sonra) konkav iç köşede buluşuyorsa P'nin uzama bilgisi; yoksa null. */
function concaveCornerJoin(vfP: VirtualFace, vfQ: VirtualFace, tQ: number): { nQ: THREE.Vector3; dQ: number; tQ: number } | null {
  if (!vfP?.vertices || vfP.vertices.length < 3 || !vfQ?.vertices || vfQ.vertices.length < 3) return null;
  const nP = vfNormal(vfP), nQ = vfNormal(vfQ);
  if (Math.abs(nP.dot(nQ)) > 0.02) return null;                                   // dik değil
  const pP = projRange(vfP.vertices, nP), pQ = projRange(vfQ.vertices, nQ);
  if (pP.max - pP.min > CORNER_TOL || pQ.max - pQ.min > CORNER_TOL) return null;  // düzlemsel değil
  const dP = (pP.min + pP.max) / 2, dQ = (pQ.min + pQ.max) / 2;
  if (Math.abs(projRange(vfP.vertices, nQ).min - dQ) > CORNER_TOL) return null;   // P, Q düzleminde başlamıyor
  if (Math.abs(projRange(vfQ.vertices, nP).min - dP) > CORNER_TOL) return null;   // Q, P düzleminde başlamıyor
  const e = new THREE.Vector3().crossVectors(nP, nQ).normalize();
  const pEdge = vfP.vertices.filter(c => Math.abs(c[0] * nQ.x + c[1] * nQ.y + c[2] * nQ.z - dQ) <= CORNER_TOL);
  const qEdge = vfQ.vertices.filter(c => Math.abs(c[0] * nP.x + c[1] * nP.y + c[2] * nP.z - dP) <= CORNER_TOL);
  if (pEdge.length < 2 || qEdge.length < 2) return null;
  const pe = projRange(pEdge, e), qe = projRange(qEdge, e);
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
    if (q.id === panel.id || orderOf(q) <= myOrder || hasAnySteps(q)) continue;
    const vfQ = vfs.find(f => f.id === (q.parameters as any)?.virtualFaceId);
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
  const n = vfNormal(vf);
  return Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)) < 0.999;
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
    if (r.id === panel.id || orderOf(r) >= myOrder) continue;
    if (!panelHasRotation(r) && !vfIsTilted(vfs.find(f => f.id === (r.parameters as any)?.virtualFaceId))) continue;
    if (stepRefTargets(r).rotate.has(panel.id)) {
      console.log('[YAGO][DÖNÜŞ-KESİM] MUAF', panel.id, '<-', r.id, '— r bu paneli REF DÖNÜŞ hedefi alıyor, düzlem kesimi yok');
      continue;
    }
    const rGeo = shapeById(r.id)?.geometry;
    const vfR = vfs.find(f => f.id === (r.parameters as any)?.virtualFaceId);
    if (!rGeo || !vfR) continue;
    const nR = rotatedNormalOf(r, vfR);
    if (!nR || Math.abs(nR.dot(nS)) > 0.98) continue; // paralel yüz: kesim anlamsız
    if (!rGeo.getAttribute('position')) continue;
    const pts = uniqueMeshPoints(rGeo);
    let dMin = Infinity, dMax = -Infinity;
    for (const v of pts) { const d = v.dot(nR); if (d < dMin) dMin = d; if (d > dMax) dMax = d; }
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
      const { u: ur, v: vr } = getFacePlaneAxes(nR);
      const cR = new THREE.Vector3(); for (const q of pts) cR.add(q); cR.divideScalar(pts.length);
      const onPlane = cR.clone().addScaledVector(nR, dNear - cR.dot(nR));
      const H = 100000;
      const rect = [[-H, -H], [H, -H], [H, H], [-H, H]].map(([a, b]) => {
        const w = onPlane.clone().addScaledVector(ur, a).addScaledVector(vr, b);
        return [w.x, w.y, w.z] as Vec3;
      });
      const half = await createPanelFromVirtualFace(rect, [toward.x, toward.y, toward.z], H, 0);
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
      console.warn('[YAGO][DÖNÜŞ-KESİM] kesim hatası:', panel.id, '<-', r.id, (err as any)?.message || String(err));
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
    for (const p of pts) { const d = p.dot(nR); dOuter = Math.max(dOuter, d); dInner = Math.min(dInner, d); }
    outerHull = convexHull2D(pts.filter(p => p.dot(nR) > dOuter - 0.5).map(p => ({ x: p.dot(ur), y: p.dot(vr) })));
    innerHull = convexHull2D(pts.filter(p => p.dot(nR) < dInner + 0.5).map(p => ({ x: p.dot(ur), y: p.dot(vr) })));
  } catch (err) {
    console.warn('[YAGO][REF-DÖN-PAH] yüz çokgeni çıkarılamadı:', panel.id, (err as any)?.message || String(err));
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
      const tb = new THREE.Box3().setFromBufferAttribute(t.geometry.getAttribute('position') as THREE.BufferAttribute);
      if (!boundsOverlapBox(cutter.boundingBox.bounds, tb)) {
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
      console.warn('[YAGO][REF-DÖN-PAH] pah hatası:', tid, '<-', panel.id, (err as any)?.message || String(err));
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
  const { createPanelFromVirtualFace } = await import('./ReplicadService');
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
    const { u, v } = getFacePlaneAxes(n);
    const H = M * 2;
    const rect = [[-H, -H], [H, -H], [H, H], [-H, H]].map(([a, b]) => {
      const w = g.center.clone().addScaledVector(u, a).addScaledVector(v, b);
      return [w.x, w.y, w.z] as Vec3;
    });
    // Dış yarım-uzay (createPanel −normal yönüne uzar → normal = −n).
    const outside = await createPanelFromVirtualFace(rect, [-n.x, -n.y, -n.z], H, 0);
    if (!outside) continue;
    try { solid = solid.cut(outside); cutN++; } catch (e) { console.warn('[YAGO][GÖVDE-KATI] yarım-uzay kesimi hatası:', (e as any)?.message || e); }
  }
  console.log('[YAGO][GÖVDE-KATI]', parent.id, 'düzenlenmiş gövde katısı kuruldu: yüzN=', groups.length, 'kesimN=', cutN,
    'kutu=', fmtBounds(solid), 'mesh=', [bb.min, bb.max].map(q => fmtVec(q, 0)).join('..'), '(içbükey gövdede dışbükey örtü)');
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
    const n0 = g.normal.clone().normalize();
    if (Math.max(Math.abs(n0.x), Math.abs(n0.y), Math.abs(n0.z)) >= 0.999) continue;
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

/** Düz panel, düzenlenmiş gövde katısıyla kesiştirilir (eğik uç pahı); hata → olduğu gibi. */
async function clipToBodyIfNeeded(rp: any, panel: Shape, parent: Shape): Promise<any> {
  try {
    const body = await effectiveBodySolid(parent);
    if (!body) return rp;
    const before = fmtBounds(rp);
    const out = rp.intersect(body);
    console.log('[YAGO][EĞİK-UÇ]', panel.id, 'gövde kesişimi (eğik yüz pahı)', before, '→', fmtBounds(out));
    return out;
  } catch (err) {
    console.warn('[YAGO][EĞİK-UÇ] gövde kesişimi hatası:', panel.id, (err as any)?.message || String(err));
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
  let out = rp;
  try {
    let body = await effectiveBodySolid(parent);
    if (!body) {
      const { createReplicadBox } = await import('./ReplicadService');
      const pp: any = parent.parameters || {};
      body = await createReplicadBox({ width: parseFloat(pp.width) || 1, height: parseFloat(pp.height) || 1, depth: parseFloat(pp.depth) || 1 });
    }
    if (body) {
      const before = fmtBounds(out);
      out = out.intersect(body);
      console.log('[YAGO][DÖNÜŞ-SIĞDIR]', panel.id, 'gövde kesişimi', before, '→', fmtBounds(out));
    }
  } catch (err) {
    console.warn('[YAGO][DÖNÜŞ-SIĞDIR] gövde kesişimi hatası:', panel.id, (err as any)?.message || String(err));
  }
  const myOrder = orderOf(panel);
  const myRefTargets = stepRefTargets(panel).rotate;
  for (const b of siblings) {
    if (b.id === panel.id || orderOf(b) >= myOrder) continue;
    const isRefTarget = myRefTargets.has(b.id);
    if (isRefTarget && refContacts.get(b.id) === 'rest') {
      console.log('[YAGO][DÖNÜŞ-SIĞDIR]', panel.id, 'referansa OTURUYOR, referansla kesilmedi <-', b.id, '(referans kenarı pahlanacak)');
      continue;
    }
    const fresh = shapeById(b.id);
    if (!fresh?.replicadShape || !fresh.geometry) continue;
    try {
      const bb = new THREE.Box3().setFromBufferAttribute(fresh.geometry.getAttribute('position') as THREE.BufferAttribute);
      if (!boundsOverlapBox(out.boundingBox.bounds, bb)) continue;
      out = out.cut(fresh.replicadShape.clone());
      console.log('[YAGO][DÖNÜŞ-SIĞDIR]', panel.id, isRefTarget ? 'REFERANS panelle kesildi <-' : 'basan kardeşle kesildi <-', b.id);
    } catch (err) {
      console.warn('[YAGO][DÖNÜŞ-SIĞDIR] kardeş kesimi hatası:', panel.id, '<-', b.id, (err as any)?.message || String(err));
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

/** Panel kimliğindeki zaman damgası (VF'siz panellerin sıra yedeği). */
function panelTs(s: Shape): number {
  const m = /(\d{10,})/.exec(s.id);
  return m ? parseInt(m[1], 10) : 0;
}

async function rebuildOnce(parentShapeId: string, opts?: RebuildOpts): Promise<void> {
  const parent = useAppStore.getState().shapes.find(s => s.id === parentShapeId);
  if (!parent) return;
  const { recalculateVirtualFacesForShape } = await import('./VirtualFaceUpdateService');
  const { createPanelFromVirtualFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');

  // TAZE STATE: dinamik import'lar sırasında store güncellenmiş olabilir.
  const fresh = useAppStore.getState();
  const parentFresh = fresh.shapes.find(s => s.id === parentShapeId) || parent;
  const updateShape = fresh.updateShape;
  const vfOrder = new Map<string, number>();
  fresh.virtualFaces.forEach((f, i) => vfOrder.set(f.id, i));
  const orderOf = (s: Shape): number => {
    const idx = vfOrder.get((s.parameters as any)?.virtualFaceId);
    return idx != null ? idx : 1e9 + panelTs(s) / 1e13;
  };

  // SIRA: referans verilen panel ÖNCE üretilir (bağ güncel geometriden çözülsün);
  // aralarında bağ olmayan çiftlerde VF sırası (basan/basılan) geçerlidir.
  const unsorted = fresh.shapes.filter(s => s.type === 'panel' && (s.parameters as any)?.parentShapeId === parentShapeId);
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
    const vfOf = (s: Shape) => fresh.virtualFaces.find(f => f.id === (s.parameters as any)?.virtualFaceId);
    const vq = vfOf(changedChild);
    const cornerPartner = !!vq && children.some(c => {
      if (c.id === changedChild.id || orderOf(c) >= changedOrder) return false;
      const vp = vfOf(c);
      return !!vp && !!concaveCornerJoin(vp, vq, panelThickness(changedChild));
    });
    const refDependents = children.filter(c => c.id !== changedChild.id && refIds.get(c.id)!.has(changedChild.id));
    const notchesTargets = stepRefTargets(changedChild).rotate.size > 0;
    if (pressed.length) console.log('[YAGO][REBUILD] TEK-PANEL MODU İPTAL', changedChild.id, 'sıra=', changedOrder,
      'basılanKardeşN=', pressed.length, '→ basan panel taşındı/değişti, basılan kardeşlerin VF bölgeleri yeniden çözülecek');
    if (cornerPartner) console.log('[YAGO][REBUILD] TEK-PANEL MODU İPTAL', changedChild.id, '→ önceki panelle iç köşe ortağı, köşe uzaması yeniden çözülecek');
    if (refDependents.length) console.log('[YAGO][REBUILD] TEK-PANEL MODU İPTAL', changedChild.id,
      '→ referans bağımlıları var:', refDependents.map(c => c.id).join(','), '(referans köşe/düzlem güncel geometriden yeniden çözülecek)');
    if (notchesTargets) console.log('[YAGO][REBUILD] TEK-PANEL MODU İPTAL', changedChild.id,
      '→ referans panel(ler)in kenarını pahlıyor, referans sıfırdan üretilip yeniden pahlanacak');
    singleMode = !pressed.length && !cornerPartner && !refDependents.length && !notchesTargets;
  }

  const parentPos = [...parentFresh.position] as Vec3;
  const pp: any = parentFresh.parameters || {};
  const growForRotated = Math.max(parseFloat(pp.width) || 0, parseFloat(pp.height) || 0, parseFloat(pp.depth) || 0, 600) * 1.5;

  const buildPanel = async (panel: Shape, vfsIn: VirtualFace[]): Promise<void> => {
    try {
      const vfId = (panel.parameters as any)?.virtualFaceId;
      const vf = vfId ? vfsIn.find(f => f.id === vfId) : undefined;
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
      const isRotated = panelHasRotation(panel) || vfTilted;
      if (vfTilted && !panelHasRotation(panel)) {
        console.log('[YAGO][EĞİK-VF]', panel.id, 'VF eğik (vertex düzenlemesi) → dönmüş gibi sığdırılacak. n=', vf.normal.map(n => n.toFixed(2)).join(','));
      }
      // Düz panel + eğik gövde yüzü: VF köşeleri uzatılır, sonra gövdeyle kesilir.
      let genVerts = buildVerts;
      let needsBodyClip = false;
      if (!isRotated) {
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
      if (resolvedRotations.length) {
        const byId = new Map(resolvedRotations.map(r => [r.id, r.value]));
        steps = steps.map((st: any) => {
          const rv = byId.get(st.id);
          if (rv != null && st.resolvedValue !== rv) { stepsChanged = true; return { ...st, resolvedValue: rv }; }
          return st;
        });
      }
      let refDeltaApplied: Vec3 | null = null;
      for (const op of ops) {
        if (op.kind === 'translate') {
          rp = rp.translate(op.d.x, op.d.y, op.d.z);
        } else if (op.kind === 'refTranslate') {
          // rp'nin o anki DÜNYA kutusu (mesh kutusu + parentPos) → hedef köşeye kilitli delta.
          let rpWorldBox: THREE.Box3;
          try {
            const g = convertReplicadToThreeGeometry(rp);
            rpWorldBox = new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute)
              .translate(new THREE.Vector3(parentPos[0], parentPos[1], parentPos[2]));
          } catch {
            rpWorldBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
          }
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
      if (isRotated) rp = await fitRotatedPanel(rp, panel, parentFresh, children, orderOf, refContacts);
      else if (needsBodyClip) rp = await clipToBodyIfNeeded(rp, panel, parentFresh);

      // YÜZ EXTRUDE: panel artık doğru çerçevede; saklı adımlar aynı çerçevede uygulanır.
      let meshed: { shape: any; geometry: THREE.BufferGeometry } | null = null;
      let dimsUpdate: { width: number; height: number; depth: number } | null = null;
      let resolvedStepsUpdate: ExtrudeStep[] | null = null;
      const extrudeSteps: ExtrudeStep[] | undefined = (panel.parameters as any)?.extrudeSteps;
      if (Array.isArray(extrudeSteps) && extrudeSteps.length > 0) {
        try {
          const { applyExtrudeSteps } = await import('./FaceExtrudeService');
          const ext = await applyExtrudeSteps(rp, extrudeSteps, useAppStore.getState().shapes);
          if (ext) {
            rp = ext.shape;
            meshed = { shape: ext.shape, geometry: ext.geometry };
            const es = new THREE.Vector3();
            new THREE.Box3().setFromBufferAttribute(ext.geometry.getAttribute('position') as THREE.BufferAttribute).getSize(es);
            const dsz = [es.x, es.y, es.z].sort((a, b) => b - a);
            dimsUpdate = { width: Math.round(dsz[0] * 10) / 10, height: Math.round(dsz[1] * 10) / 10, depth: Math.round(dsz[2] * 10) / 10 };
            if (ext.resolved.length) {
              const byId = new Map(ext.resolved.map(r => [r.id, r.value]));
              let changed = false;
              const merged = extrudeSteps.map(s => {
                const rv = byId.get(s.id);
                if (rv != null && s.resolvedValue !== rv) { changed = true; return { ...s, resolvedValue: rv }; }
                return s;
              });
              if (changed) resolvedStepsUpdate = merged;
            }
          }
        } catch (err) {
          console.error('[YAGO][MOTOR] extrude adımı hatası:', panel.id, (err as any)?.message || String(err));
        }
      }

      // Dönmüş basanların eğik düzlem kesimi, sonra ref-dönüş hedeflerinin pahı.
      if (!panelHasRotation(panel)) {
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
      console.error('[YAGO][MOTOR] panel üretim hatası:', panel.id, (err as any)?.message || String(err));
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
    const parentNow = st.shapes.find(s => s.id === parentShapeId) || parentFresh;
    return recalculateVirtualFacesForShape(parentNow, vfs, st.shapes);
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
}

/** VF yeniden hesabının sahip olduğu alanlar (geri kalanı kullanıcı verisidir). */
const VF_REGEN_FIELDS = ['normal', 'center', 'vertices', 'rawFaceBBox', 'sideRelations', 'regionAnchor', 'contactRelations'] as const;
