import * as THREE from 'three';
import { useAppStore, type Shape, type VirtualFace } from '../store';
import { vfPlaneBasis, type RotateStep } from './PanelRotateService';
import type { TransformStep } from './PanelTransformService';
import { getFacePlaneAxes, convexHull2D, panelHasRotation } from './FaceRegion';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PANEL MOTORU — SADE ÜRETİM ÇEKİRDEĞİ (kesimsiz).
 *
 * NOT: Dönme kesim/kural mekanizması (dominant düzlem, komşu kesimi, grow,
 * K6 küp kesişimi, gönye) kullanıcı isteğiyle TAMAMEN KALDIRILDI. Yeni bir
 * dönme-kesim yaklaşımı sonra bağlanacak. Şu anki davranış:
 *
 *  • Her panel, bağlı olduğu VF'nin (yüzey) güncel çokgeninden GERÇEK boyutta
 *    üretilir (expand=0, doğru 18mm kalınlık) — "highlight = panel".
 *  • Sıralı adımlar (move VE rotate, birleşik transformSteps) çerçeve-duyarlı
 *    uygulanır: çember döndürünce panel döner, taşıyınca taşınır.
 *  • Komşular arası KESİM YOK. Paneller birbirini kısaltmaz/sınırlamaz.
 *  • VF/bölge katmanı (ayak izi, serbest bölge) KORUNUR — döndürme arayüzü ve
 *    sahnedeki çemberler bu VF'ler üzerinden çalışmaya devam eder.
 *
 * TASARIM SÖZLEŞMESİ (korunan çekirdek)
 *  • Tek gerçek kaynak SPEC'tir: panelin bağı (virtualFaceId ↔ VF) + sıralı
 *    adım listesi. Geometri her rebuild'de SIFIRDAN türetilir; önceki
 *    geometriden beslenilmez.
 *  • ADIMLAR sıralı ve birbirine göredir (composeSteps); pivotlar parametrik
 *    çıpadır (pivotVfFrac), rebuild güncel yüzeyden türetir.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Birleşik adım görünümü ────────────────────────────────────────────────
// Depolama: panel.parameters.transformSteps (sıralı, move|rotate birleşik).
// Eski parameters.rotateSteps yalnız OKUNUR-göç edilir (timestamp sırasına
// eklenir); yeni yazımlar tek listeye gider.

export function getUnifiedSteps(panel: Shape): TransformStep[] {
  const p: any = panel.parameters || {};
  const t: TransformStep[] = Array.isArray(p.transformSteps) ? [...p.transformSteps] : [];
  const legacy: RotateStep[] = Array.isArray(p.rotateSteps) ? p.rotateSteps : [];
  // Göç: transformSteps'te bulunmayan eski rotate adımları listeye alınır.
  const have = new Set(t.map(s => s.id));
  for (const r of legacy) {
    if (have.has(r.id)) continue;
    t.push({
      id: r.id, type: 'rotate', axis: r.axis, axisVec: r.axisVec,
      value: r.value, pivot: r.pivot, pivotFrac: r.pivotFrac,
      pivotVfFrac: r.pivotVfFrac, timestamp: r.timestamp,
    } as TransformStep);
  }
  t.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return t;
}

export function setUnifiedSteps(
  panel: Shape,
  steps: TransformStep[],
  updateShape: (id: string, u: Partial<Shape>) => void
): void {
  const rotateMirror = steps.filter(s => s.type === 'rotate') as any[];
  updateShape(panel.id, {
    parameters: {
      ...panel.parameters,
      transformSteps: steps,
      // Eski okuyucular (VF regen'in DÖNMÜŞ tespiti vb.) için ayna.
      rotateSteps: rotateMirror,
    },
  } as any);
}

// ── Bağ kaydı ─────────────────────────────────────────────────────────────
export interface PanelAttachment {
  parentShapeId: string;
  vf: VirtualFace;              // güncel sanal yüzey (bölge otoritesi)
  normal: [number, number, number];
}

export function getPanelAttachment(
  panel: Shape,
  virtualFaces: VirtualFace[]
): PanelAttachment | null {
  const vfId = (panel.parameters as any)?.virtualFaceId;
  const parentShapeId = (panel.parameters as any)?.parentShapeId;
  if (!vfId || !parentShapeId) return null;
  const vf = virtualFaces.find(f => f.id === vfId);
  if (!vf || !vf.vertices || vf.vertices.length < 3) return null;
  return { parentShapeId, vf, normal: vf.normal as [number, number, number] };
}

// ── Adım tekrarı (çerçeve matematiği — saf) ───────────────────────────────
// Katı, parent-yerel çerçevede üretilir; adımlar sırayla katıya işlenir.
// move: o ANKİ çerçevenin eksenlerinde delta (dönüşten sonra dönmüş ekseni
// izler). rotate: pivot GÜNCEL VF'den (pivotVfFrac) çözülür; eksen adımda
// saklanan panel-yerel vektördür (yoksa dünya harfi).

function resolvePivot(step: any, vf: VirtualFace): THREE.Vector3 {
  if (step.pivotVfFrac && vf) {
    const { n, u, v } = vfPlaneBasis(vf.normal as [number, number, number]);
    // VF dikdörtgen kutusu (u/v tabanında)
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, nOff = 0;
    for (const c of vf.vertices) {
      const w = new THREE.Vector3(c[0], c[1], c[2]);
      const pu = w.dot(u), pv = w.dot(v);
      uMin = Math.min(uMin, pu); uMax = Math.max(uMax, pu);
      vMin = Math.min(vMin, pv); vMax = Math.max(vMax, pv);
      nOff = w.dot(n);
    }
    const [fu, fv, dn] = step.pivotVfFrac as [number, number, number];
    return new THREE.Vector3()
      .addScaledVector(u, uMin + fu * (uMax - uMin))
      .addScaledVector(v, vMin + fv * (vMax - vMin))
      .addScaledVector(n, nOff + dn);
  }
  return new THREE.Vector3(...(step.pivot || [0, 0, 0]));
}

function computeCurrentVfSpan(vf: VirtualFace, axis: string): number {
  if (!vf?.vertices || vf.vertices.length < 3) return 0;
  const axisBase = axis[0] as 'x' | 'y' | 'z';
  const idx = axisBase === 'x' ? 0 : axisBase === 'y' ? 1 : 2;
  let min = Infinity, max = -Infinity;
  for (const v of vf.vertices) {
    const c = v[idx];
    if (c < min) min = c;
    if (c > max) max = c;
  }
  return Math.abs(max - min);
}

function resolveScaledMoveValue(step: any, vf: VirtualFace): number {
  const original = (step as any).value as number;
  // İLAVE ÖNLEM — FIXED adım ASLA ölçeklenmez: her rebuild'de birebir mm kalır.
  // buildMoveAnchor fixed dahil tüm move adımlarına anchor yazdığından, fixed bir
  // taşıma da span oranıyla ölçekleniyordu; span değişince (kardeş serbest-bölge
  // yeniden hesabı orta paneli kısaltınca) miktar kayıp panel "başka yere kaçıyor"
  // ve kayan ayak izi komşu paneli daha da kısaltıyordu. Parametrik (oransal)
  // ölçekleme yalnız DYN adımlar içindir; fixed sabit ofsettir.
  if ((step as any).isFixed) return original;
  const anchor = (step as any).anchor;
  if (!anchor || !anchor.faceSpanAlongAxis || anchor.faceSpanAlongAxis < 1) return original;
  const currentSpan = computeCurrentVfSpan(vf, (step as any).axis);
  if (currentSpan < 1) return original;
  const ratio = currentSpan / anchor.faceSpanAlongAxis;
  if (Math.abs(ratio - 1) < 0.001) return original;
  const scaled = original * ratio;
  console.log('[YAGO][ANCHOR-SCALE]',
    'eksen=', (step as any).axis,
    'orijinal=', original.toFixed(1),
    'eskiSpan=', anchor.faceSpanAlongAxis.toFixed(1),
    'yeniSpan=', currentSpan.toFixed(1),
    'oran=', ratio.toFixed(3),
    'ölçekli=', scaled.toFixed(1),
    'temas=', anchor.contactPanelId || 'YOK');
  return scaled;
}

// ── FIXED TAŞIMA = MUTLAK KONUM ───────────────────────────────────────────
// KULLANICI SÖZLEŞMESİ (Goker): taşımada DYN, panelin yüzüne göre ofsettir —
// yüz kayınca/kutu büyüyünce panel onu izler. FIXED ise "o pozisyonda KALIR":
// kutu ya da komşular değişse de panel parent-yerel çerçevede aynı yerdedir,
// diğer paneller ona göre büyüyüp küçülür.
// ESKİ DURUM: fixed yalnız "oransal ölçekleme yok" demekti. Yüz normali
// yönündeki taşımada (ör. sağ yan paneli X− 122) yüz açıklığı 0 olduğundan dyn
// de hiç ölçeklenmiyordu → iki mod birebir aynı çalışıyordu.
// ÇÖZÜM: fixed adım oluşturulurken VF'nin HAM yüz konumu taşıma ekseni boyunca
// (fixedRef) kaydedilir. Tekrarda yüz ne kadar kaydıysa o kadar ters öteleme
// eklenir → panelin mutlak yeri sabit. Ham yüz tabanı kullanılır (kardeş
// damgası bölgeyi daraltınca referans oynamasın); motor rawFaceBBox'tan, damga
// taze ham konturdan okur — ikisi aynı ham yüzü görür.
export function vfRawMinAlong(vf: VirtualFace, axisLetter: string): number | null {
  if (!vf?.vertices || vf.vertices.length < 3) return null;
  const a = axisLetterToVec(axisLetter);
  const p = new THREE.Vector3(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z));
  if (p.lengthSq() < 0.5) return null;
  const n = new THREE.Vector3(...(vf.normal as [number, number, number])).normalize();
  const c0 = vf.vertices[0];
  const planeD = c0[0] * n.x + c0[1] * n.y + c0[2] * n.z;
  const rb = (vf as any).rawFaceBBox as { xMin: number; xMax: number; yMin: number; yMax: number } | undefined;
  let min = Infinity;
  if (rb) {
    const { u, v } = getFacePlaneAxes(n);
    for (const x of [rb.xMin, rb.xMax]) for (const y of [rb.yMin, rb.yMax]) {
      const w = new THREE.Vector3().addScaledVector(u, x).addScaledVector(v, y).addScaledVector(n, planeD);
      min = Math.min(min, w.dot(p));
    }
  } else {
    for (const c of vf.vertices) min = Math.min(min, c[0] * p.x + c[1] * p.y + c[2] * p.z);
  }
  return Number.isFinite(min) ? min : null;
}

export function composeSteps(
  steps: TransformStep[],
  vf: VirtualFace
): { quat: THREE.Quaternion; ops: Array<{ kind: 'translate'; d: THREE.Vector3 } | { kind: 'refTranslate'; targetPanelId: string; sourceFrac?: [number, number, number]; targetFrac?: [number, number, number]; fallback: THREE.Vector3 } | { kind: 'rotate'; deg: number; pivot: THREE.Vector3; axis: THREE.Vector3 }> } {
  const ops: any[] = [];
  const frame = new THREE.Quaternion();
  for (const s of steps) {
    if (s.type === 'move') {
      const ms = s as any;
      // REFERANS BAĞI: hedef panele/gövdeye kilitli taşıma. Donmuş delta
      // yerine, köşeler GÜNCEL geometriden çözülsün diye adımı buildPanel'e
      // 'refTranslate' olarak ilet (orada rp + store geometrisi mevcut).
      // Referans büyüyüp küçüldükçe hedef köşe kayar → panel takip eder.
      if (ms.refTargetPanelId && (ms.refSourceFrac || ms.refTargetFrac || (ms._refAxisVec && ms._refDist))) {
        const fallback = (ms._refAxisVec && ms._refDist)
          ? new THREE.Vector3(ms._refAxisVec[0], ms._refAxisVec[1], ms._refAxisVec[2]).multiplyScalar(ms._refDist)
          : new THREE.Vector3(0, 0, 0);
        ops.push({
          kind: 'refTranslate',
          targetPanelId: ms.refTargetPanelId,
          sourceFrac: ms.refSourceFrac,
          targetFrac: ms.refTargetFrac,
          fallback,
        });
      } else if (ms._refAxisVec && ms._refDist) {
        const d = new THREE.Vector3(ms._refAxisVec[0], ms._refAxisVec[1], ms._refAxisVec[2]).multiplyScalar(ms._refDist);
        ops.push({ kind: 'translate', d });
      } else {
        const base = axisLetterToVec(ms.axis);
        const value = resolveScaledMoveValue(s, vf);
        const d = base.clone().applyQuaternion(frame).multiplyScalar(value);
        // FIXED MUTLAK KONUM: yalnız dönüşsüz çerçevede (eksen dünya ekseniyle
        // aynıyken) — dönmüş çerçevede yüz kayması eksene izdüşmez, dokunulmaz.
        const isIdentityFrame = Math.abs(frame.w) > 0.999999;
        if (ms.isFixed && typeof ms.fixedRef === 'number' && isIdentityFrame) {
          const cur = vfRawMinAlong(vf, ms.axis);
          if (cur !== null) {
            const shift = ms.fixedRef - cur;
            if (Math.abs(shift) > 0.01) {
              const p = new THREE.Vector3(Math.abs(base.x), Math.abs(base.y), Math.abs(base.z));
              d.addScaledVector(p, shift);
              console.log('[YAGO][FIXED-TAŞI] yüz kaydı', shift.toFixed(1), 'mm telafi edildi → panel mutlak konumda',
                'eksen=', ms.axis, 'değer=', value.toFixed(1), 'ref=', ms.fixedRef.toFixed(1), 'güncel=', cur.toFixed(1));
            }
          }
        }
        ops.push({ kind: 'translate', d });
      }
    } else if (s.type === 'rotate') {
      const st: any = s;
      const axis = st.axisVec
        ? new THREE.Vector3(...st.axisVec).normalize()
        : axisLetterToVec(st.axis + '+');
      const worldAxis = axis.clone().applyQuaternion(frame).normalize();
      const pivot = resolvePivot(st, vf);
      ops.push({ kind: 'rotate', deg: st.value, pivot, axis: worldAxis });
      frame.premultiply(new THREE.Quaternion().setFromAxisAngle(worldAxis, (st.value * Math.PI) / 180));
    }
  }
  return { quat: frame, ops };
}

// ── Referans bağı: köşe frac çözümü (geometrik) ───────────────────────────
// Bir şeklin GÜNCEL geometrisinin DÜNYA sınır kutusu.
function worldBboxOfShape(shape: Shape): THREE.Box3 | null {
  if (!shape?.geometry) return null;
  const pos = shape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return null;
  const box = new THREE.Box3().setFromBufferAttribute(pos);
  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(...(shape.position as any)),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(shape.rotation as [number, number, number]), 'XYZ')),
    new THREE.Vector3(...((shape.scale as any) || [1, 1, 1]))
  );
  box.applyMatrix4(mat);
  return box;
}

function pointFromFracBox(box: THREE.Box3, f: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(
    box.min.x + f[0] * (box.max.x - box.min.x),
    box.min.y + f[1] * (box.max.y - box.min.y),
    box.min.z + f[2] * (box.max.z - box.min.z),
  );
}

/**
 * Referans bağı taşıma deltasını GÜNCEL geometriden çözer.
 *   • kaynak köşe: taşınan panelin (rp) o anki dünya kutusundan sourceFrac ile
 *   • hedef köşe : referans şeklin (store) güncel dünya kutusundan targetFrac ile
 *   • delta = hedef − kaynak (saf öteleme; rp uzayı ile dünya yalnız parentPos
 *     kadar ötelenmiş olduğundan dünya-delta doğrudan rp'ye uygulanabilir).
 * Frac/hedef geometri eksikse donmuş fallback döner (eski adımlarla uyum).
 */
export function resolveRefTranslateDelta(
  op: any,
  rpWorldBox: THREE.Box3,
): THREE.Vector3 {
  if (!op.sourceFrac || !op.targetFrac) return op.fallback.clone();
  const target = useAppStore.getState().shapes.find(s => s.id === op.targetPanelId);
  const tgtBox = target ? worldBboxOfShape(target) : null;
  if (!tgtBox) {
    console.warn('[YAGO][REF-BAĞ] hedef geometri yok, donmuş delta kullanılıyor:', op.targetPanelId);
    return op.fallback.clone();
  }
  const sourceWorld = pointFromFracBox(rpWorldBox, op.sourceFrac);
  const targetWorld = pointFromFracBox(tgtBox, op.targetFrac);
  const d = targetWorld.clone().sub(sourceWorld);
  console.log('[YAGO][REF-BAĞ] çözülen delta=',
    [d.x.toFixed(1), d.y.toFixed(1), d.z.toFixed(1)].join(','),
    'hedef=', op.targetPanelId,
    'hedefKöşe=', [targetWorld.x.toFixed(1), targetWorld.y.toFixed(1), targetWorld.z.toFixed(1)].join(','));
  return d;
}

function axisLetterToVec(a: string): THREE.Vector3 {
  switch (a) {
    case 'x+': return new THREE.Vector3(1, 0, 0);
    case 'x-': return new THREE.Vector3(-1, 0, 0);
    case 'y+': return new THREE.Vector3(0, 1, 0);
    case 'y-': return new THREE.Vector3(0, -1, 0);
    case 'z+': return new THREE.Vector3(0, 0, 1);
    case 'z-': return new THREE.Vector3(0, 0, -1);
    default: return new THREE.Vector3(0, 0, 0);
  }
}

// ── İÇ KÖŞE (KONKAV) BİRLEŞİMİ ────────────────────────────────────────────
// SENARYO (Goker, L gövde): gövdenin İÇ köşesinde birbirine dik iki yüze iki
// panel atılınca her ikisi de kendi yüzünün sınırında biter; paneller hacmin
// içine (−n yönünde) kalınlık aldığı için köşede t1×t2 kare BOŞLUK kalır
// (üstten bakınca görülen çentik). Kural: iki panel bir araya geldiğinde
// SIRALAMADA ÖNCE olan panel, köşe kenarından sonraki panelin kalınlığı kadar
// UZAR ve onun ucunu kapatır. Tek başına kalan panel hacmin içinde, yüz
// sınırında biter (değişiklik yok).
//
// Tespit tamamen VF'lerden yapılır (üretim sırasından bağımsız, deterministik):
//   P slab'ı = [dP−tP, dP] (nP boyunca),  Q slab'ı = [dQ−tQ, dQ] (nQ boyunca)
//   KONKAV ⇔ P bölgesi nQ boyunca dQ'da BAŞLIYOR (min≈dQ) VE Q bölgesi nP
//   boyunca dP'de BAŞLIYOR (min≈dP). Dış (konveks) köşede bölge max≈d olur →
//   tetiklenmez; oradaki birleşim mevcut damga sözleşmesine aittir.
// Kapsam bilerek dar: iki panel de adımsız (taşıma/dönme/extrude yok), yüzler
// dik, köşe kenarında Q'nun boyu P'nin kenarını kapsıyor. Aksi hâlde dokunulmaz.
const CORNER_TOL = 1.0;

function hasAnySteps(p: Shape): boolean {
  const q: any = p.parameters || {};
  return (Array.isArray(q.transformSteps) && q.transformSteps.length > 0)
    || (Array.isArray(q.rotateSteps) && q.rotateSteps.length > 0)
    || (Array.isArray(q.extrudeSteps) && q.extrudeSteps.length > 0);
}

function projRange(verts: [number, number, number][], dir: THREE.Vector3): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const c of verts) {
    const d = c[0] * dir.x + c[1] * dir.y + c[2] * dir.z;
    if (d < min) min = d; if (d > max) max = d;
  }
  return { min, max };
}

/** P (önce) ile Q (sonra) konkav iç köşede buluşuyorsa P'nin uzayacağı bilgi; yoksa null. */
function concaveCornerJoin(
  vfP: VirtualFace, tP: number, vfQ: VirtualFace, tQ: number
): { nQ: THREE.Vector3; dQ: number; tQ: number } | null {
  if (!vfP?.vertices || vfP.vertices.length < 3 || !vfQ?.vertices || vfQ.vertices.length < 3) return null;
  const nP = new THREE.Vector3(...(vfP.normal as [number, number, number])).normalize();
  const nQ = new THREE.Vector3(...(vfQ.normal as [number, number, number])).normalize();
  if (Math.abs(nP.dot(nQ)) > 0.02) return null;                  // dik değil
  const pP = projRange(vfP.vertices, nP), pQ = projRange(vfQ.vertices, nQ);
  if (pP.max - pP.min > CORNER_TOL || pQ.max - pQ.min > CORNER_TOL) return null; // düzlemsel değil
  const dP = (pP.min + pP.max) / 2, dQ = (pQ.min + pQ.max) / 2;
  const pAlongQ = projRange(vfP.vertices, nQ);
  const qAlongP = projRange(vfQ.vertices, nP);
  if (Math.abs(pAlongQ.min - dQ) > CORNER_TOL) return null;       // P, Q düzleminde başlamıyor
  if (Math.abs(qAlongP.min - dP) > CORNER_TOL) return null;       // Q, P düzleminde başlamıyor
  // Ortak kenar ekseni boyunca: Q'nun köşe kenarı P'nin köşe kenarını kapsamalı
  const e = new THREE.Vector3().crossVectors(nP, nQ).normalize();
  const pEdge = vfP.vertices.filter(c => Math.abs(c[0] * nQ.x + c[1] * nQ.y + c[2] * nQ.z - dQ) <= CORNER_TOL);
  const qEdge = vfQ.vertices.filter(c => Math.abs(c[0] * nP.x + c[1] * nP.y + c[2] * nP.z - dP) <= CORNER_TOL);
  if (pEdge.length < 2 || qEdge.length < 2) return null;
  const pe = projRange(pEdge, e), qe = projRange(qEdge, e);
  if (pe.max - pe.min < 1) return null;
  if (qe.min > pe.min + 2 || qe.max < pe.max - 2) return null;
  void tP;
  return { nQ, dQ, tQ };
}

/** Panelin üretim köşeleri: VF köşeleri + (varsa) konkav köşe uzaması. VF'nin kendisi değişmez. */
function cornerJoinedVertices(
  panel: Shape, vf: VirtualFace, vfs: VirtualFace[],
  siblings: Shape[], orderOf: (s: Shape) => number
): [number, number, number][] {
  let verts = vf.vertices.map(c => [c[0], c[1], c[2]] as [number, number, number]);
  if (hasAnySteps(panel)) return verts;
  const tP = parseFloat((panel.parameters as any)?.panelThickness) || 18;
  const myOrder = orderOf(panel);
  for (const q of siblings) {
    if (q.id === panel.id || orderOf(q) <= myOrder || hasAnySteps(q)) continue;
    const qVfId = (q.parameters as any)?.virtualFaceId;
    const vfQ = qVfId ? vfs.find(f => f.id === qVfId) : undefined;
    if (!vfQ) continue;
    const tQ = parseFloat((q.parameters as any)?.panelThickness) || 18;
    const j = concaveCornerJoin(vf, tP, vfQ, tQ);
    if (!j) continue;
    let moved = 0;
    verts = verts.map(c => {
      const d = c[0] * j.nQ.x + c[1] * j.nQ.y + c[2] * j.nQ.z;
      if (Math.abs(d - j.dQ) > CORNER_TOL) return c;
      moved++;
      return [c[0] - j.nQ.x * j.tQ, c[1] - j.nQ.y * j.tQ, c[2] - j.nQ.z * j.tQ] as [number, number, number];
    });
    console.log('[YAGO][İÇ-KÖŞE]', panel.id, 'uzadı', j.tQ.toFixed(1), 'mm →', q.id,
      'ucunu kapatıyor (sıra', myOrder, '<', orderOf(q), ') taşınanKöşeN=', moved);
  }
  return verts;
}

// ── DÖNÜŞ-KESİMİ: dönmüş BASAN kardeş, basılan paneli eğik düzlemiyle biçer ──
// SÖZLEŞME (Goker): "üst paneli döndürdüm → ona bağlı paneller dönüş açısına
// göre kısalsın, kalınlıkları açı alsın; taşıma gibi stabil çalışsın."
// Taşımada basılan panel VF bölgesiyle kısalır (prizma). Dönüşte prizma
// yetmez: kalınlık kenarı eğik kardeşin ALT yüzeyine paralel olmalı. Bu
// yüzden bölge dönmüş şeridin içinden geçirilir (FaceRegion uzak-teğet) ve
// burada panel, dönmüş kardeşin S'ye BAKAN büyük yüzünün yarım-uzayıyla
// kesilir — kesici, o yüzün konturu boyunca R'nin gövdesine doğru "sonsuz"
// uzatılmış bir prizmadır (yalnız R'nin altında/üstünde kalan kısım gider,
// R'nin dışında kalan panel parçası dokunulmaz). Basan/basılan yetkisi VF
// sırasıdır: yalnız S'den ÖNCE gelen dönmüş kardeşler keser.
function rotatedNormalOf(panel: Shape, vf: VirtualFace): THREE.Vector3 | null {
  try {
    const { quat } = composeSteps(getUnifiedSteps(panel), vf);
    return new THREE.Vector3(...(vf.normal as [number, number, number])).normalize().applyQuaternion(quat).normalize();
  } catch { return null; }
}

async function cutByRotatedPressers(
  rp: any,
  panel: Shape,
  vfS: VirtualFace,
  siblings: Shape[],
  vfs: VirtualFace[],
  orderOf: (s: Shape) => number,
  createPanelFromVirtualFace: (v: [number, number, number][], n: [number, number, number], t: number, e?: number) => Promise<any>,
): Promise<any> {
  const myOrder = orderOf(panel);
  const nS = new THREE.Vector3(...(vfS.normal as [number, number, number])).normalize();
  const dS = vfS.vertices.length ? new THREE.Vector3(...vfS.vertices[0]).dot(nS) : 0;
  // TARAF TAYİNİ: bölge ÇAPASI (serbest hücre) — merkez/seed DEĞİL. Dik açılarda
  // (ör. 33°) yan panelin merkezi ve tıklama noktası dönmüş üst panelin ÜST
  // yüzünün ötesine düşüyor, yakın yüz olarak üst yüz seçilip yalnız şerit
  // oyuluyordu ("panel sağ paneli sınırlamak yerine böldü"). Çapa her zaman
  // panelin kalması gereken tarafta.
  const anchor = (vfS as any).regionAnchor as [number, number, number] | undefined;
  const ref = anchor ? new THREE.Vector3(...anchor) : (() => {
    const c = new THREE.Vector3();
    for (const q of vfS.vertices) c.add(new THREE.Vector3(q[0], q[1], q[2]));
    return c.divideScalar(Math.max(vfS.vertices.length, 1));
  })();
  let out = rp;
  for (const r of siblings) {
    if (r.id === panel.id || orderOf(r) >= myOrder || !panelHasRotation(r)) continue;
    const rGeo = useAppStore.getState().shapes.find(s => s.id === r.id)?.geometry;
    const rVfId = (r.parameters as any)?.virtualFaceId;
    const vfR = rVfId ? vfs.find(f => f.id === rVfId) : undefined;
    if (!rGeo || !vfR) continue;
    const nR = rotatedNormalOf(r, vfR);
    if (!nR || Math.abs(nR.dot(nS)) > 0.98) continue; // paralel yüz: bu kesim anlamsız
    const pos = rGeo.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) continue;
    const pts: THREE.Vector3[] = [];
    let dMin = Infinity, dMax = -Infinity;
    const seen = new Set<string>();
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      const key = `${Math.round(v.x * 10)},${Math.round(v.y * 10)},${Math.round(v.z * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key); pts.push(v);
      const d = v.dot(nR);
      if (d < dMin) dMin = d; if (d > dMax) dMax = d;
    }
    if (!(dMax - dMin > 1)) continue;
    const refD = ref.dot(nR);
    const mid = (dMin + dMax) / 2;
    // Panel çapanın olduğu tarafta kalır; karşı taraf + şerit gider.
    const keepPlus = refD > mid;
    const dNear = keepPlus ? dMax : dMin;
    const toward = keepPlus ? nR.clone() : nR.clone().negate();
    // S bu düzlemi gerçekten geçiyor mu? VF köşeleri YÜZDEDİR; panelin
    // kalınlığı yüzden içeri (−nS) gider. Yalnız yüz köşelerine bakınca üst
    // yüze atılan düz panel, dönmüş üst panelin pivot ucundaki şeridin ÜSTÜNDE
    // görünüp kesilmiyordu (log: 3 numaralı panel için DÖNÜŞ-KESİM satırı yok;
    // köşe açı almadı). Kalınlık kadar içerideki köşeler de sınanır.
    const thS = parseFloat((panel.parameters as any)?.panelThickness) || 18;
    const slabPts: [number, number, number][] = [
      ...vfS.vertices,
      ...vfS.vertices.map(c => [c[0] - nS.x * thS, c[1] - nS.y * thS, c[2] - nS.z * thS] as [number, number, number]),
    ];
    const crosses = slabPts.some(c => (c[0] * nR.x + c[1] * nR.y + c[2] * nR.z - dNear) * (keepPlus ? 1 : -1) < -0.5);
    if (!crosses) continue;
    try {
      // 1) Yarım-uzay: yakın yüz düzleminde dev dikdörtgen, R gövdesine doğru uzatılır.
      const { u: ur, v: vr } = getFacePlaneAxes(nR);
      const cR = new THREE.Vector3(); for (const q of pts) cR.add(q); cR.divideScalar(pts.length);
      const onPlane = cR.clone().addScaledVector(nR, dNear - cR.dot(nR));
      const H = 100000;
      const rect = [[-H, -H], [H, -H], [H, H], [-H, H]].map(([a, b]) => {
        const w = onPlane.clone().addScaledVector(ur, a).addScaledVector(vr, b);
        return [w.x, w.y, w.z] as [number, number, number];
      });
      const half = await createPanelFromVirtualFace(rect, [toward.x, toward.y, toward.z], H, 0);
      // 2) Siluet prizması: R'nin S yüzüne izdüşümü (konveks gövde), yüz normali
      //    boyunca S gövdesinin içinden geçirilir → kesim yalnız R'nin
      //    "altında/üstünde" kalan kısma değer; R'nin yanındaki panel parçası kalır.
      const { u: us, v: vs } = getFacePlaneAxes(nS);
      const hull = convexHull2D(pts.map(q => ({ x: q.dot(us), y: q.dot(vs) })));
      if (hull.length < 3) continue;
      const silVerts = hull.map(q => {
        const w = new THREE.Vector3().addScaledVector(us, q.x).addScaledVector(vs, q.y).addScaledVector(nS, dS + 1000);
        return [w.x, w.y, w.z] as [number, number, number];
      });
      const sil = await createPanelFromVirtualFace(silVerts, [nS.x, nS.y, nS.z], H, 0);
      if (!half || !sil) continue;
      const cutter = sil.intersect(half);
      out = out.cut(cutter);
      console.log('[YAGO][DÖNÜŞ-KESİM]', panel.id, '<-', r.id,
        'düzlemN=', [nR.x, nR.y, nR.z].map(n => n.toFixed(2)).join(','),
        'yakınYüz=', dNear.toFixed(1), 'çapa=', refD.toFixed(1), keepPlus ? '(+ taraf kalır)' : '(− taraf kalır)',
        'siluetKöşeN=', hull.length);
    } catch (err) {
      console.warn('[YAGO][DÖNÜŞ-KESİM] kesim hatası:', panel.id, '<-', r.id, (err as any)?.message || String(err));
    }
  }
  return out;
}

// ── BÜYÜT & SIĞDIR: dönmüş paneli gövdeye ve basan kardeşlere göre biç ─────
async function fitRotatedPanel(
  rp: any, panel: Shape, parent: Shape, siblings: Shape[], orderOf: (s: Shape) => number,
): Promise<any> {
  let out = rp;
  // 1) Gövde ile kesişim: panel açıya göre duvara kadar uzar, dışarı taşmaz.
  try {
    let body = parent.replicadShape ? parent.replicadShape.clone() : null;
    if (!body) {
      const { createReplicadBox } = await import('./ReplicadService');
      const pp: any = parent.parameters || {};
      body = await createReplicadBox({
        width: parseFloat(pp.width) || 1, height: parseFloat(pp.height) || 1, depth: parseFloat(pp.depth) || 1,
      });
    }
    if (body) {
      const before = out.boundingBox.bounds.map((v: number[]) => v.map(n => n.toFixed(0)).join(',')).join('..');
      out = out.intersect(body);
      console.log('[YAGO][DÖNÜŞ-SIĞDIR]', panel.id, 'gövde kesişimi', before, '→',
        out.boundingBox.bounds.map((v: number[]) => v.map(n => n.toFixed(0)).join(',')).join('..'));
    }
  } catch (err) {
    console.warn('[YAGO][DÖNÜŞ-SIĞDIR] gövde kesişimi hatası:', panel.id, (err as any)?.message || String(err));
  }
  // 2) Basan (önce gelen) kardeşlerin gövdeleriyle kesim — kutu içinde örtüşen
  //    kısımlar gider, panel onların iç yüzüne açıyla dayanır.
  const myOrder = orderOf(panel);
  for (const b of siblings) {
    if (b.id === panel.id || orderOf(b) >= myOrder) continue;
    const fresh = useAppStore.getState().shapes.find(s => s.id === b.id);
    if (!fresh?.replicadShape || !fresh.geometry) continue;
    try {
      const bb = new THREE.Box3().setFromBufferAttribute(fresh.geometry.getAttribute('position') as THREE.BufferAttribute);
      const rb = out.boundingBox.bounds;
      const overlaps = rb[0][0] < bb.max.x - 0.5 && rb[1][0] > bb.min.x + 0.5
        && rb[0][1] < bb.max.y - 0.5 && rb[1][1] > bb.min.y + 0.5
        && rb[0][2] < bb.max.z - 0.5 && rb[1][2] > bb.min.z + 0.5;
      if (!overlaps) continue;
      out = out.cut(fresh.replicadShape.clone());
      console.log('[YAGO][DÖNÜŞ-SIĞDIR]', panel.id, 'basan kardeşle kesildi <-', b.id);
    } catch (err) {
      console.warn('[YAGO][DÖNÜŞ-SIĞDIR] kardeş kesimi hatası:', panel.id, '<-', b.id, (err as any)?.message || String(err));
    }
  }
  return out;
}

// ── Rebuild orkestrasyonu ─────────────────────────────────────────────────
export interface RebuildOpts {
  // Yalnız bu panel işlem gördü (fixed/dyn/ref taşıma veya extrude) VE sıralama
  // DEĞİŞMEDİ → sadece bu paneli yeniden üret; diğer paneller/VF'ler DOKUNULMAZ.
  // Böylece değişmeyen panellerin ayak izleri sabit kalır, çok-fazlı rebuild'in
  // tetiklediği damga-trim salınımı (komşu panel kısalması) oluşmaz.
  changedPanelId?: string;
  orderChanged?: boolean;
}
const inFlight = new Set<string>();
const pending = new Map<string, RebuildOpts | undefined>();

export async function rebuildPanelsForParent(parentShapeId: string, opts?: RebuildOpts): Promise<void> {
  if (inFlight.has(parentShapeId)) {
    // Kuyrukta TAM rebuild (opts=undefined) varsa onu KORU — en geniş kapsam
    // kazanır; yoksa son çağrının kapsamını al.
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

async function rebuildOnce(parentShapeId: string, opts?: RebuildOpts): Promise<void> {
  const store = useAppStore.getState();
  const parent = store.shapes.find(s => s.id === parentShapeId);
  if (!parent) return;

  const { recalculateVirtualFacesForShape } = await import('./VirtualFaceUpdateService');
  const {
    createPanelFromVirtualFace, convertReplicadToThreeGeometry,
  } = await import('./ReplicadService');

  // TAZE STATE: await import'lar sırasında store güncellenmiş olabilir.
  const fresh = useAppStore.getState();
  const shapes = fresh.shapes;
  const parentFresh = shapes.find(s => s.id === parentShapeId) || parent;
  const updateShape = fresh.updateShape;
  const updateVirtualFace = (fresh as any).updateVirtualFace as ((id: string, u: any) => void) | undefined;

  // SIRA: önce VF indeksi (öncelik), sonra taşınma durumu. Taşınmış/büyütülmüş
  // paneller SONDAN üretilir ki sabit panellerin ayak izleri önce yerleşsin ve
  // VF bölgeleri güncel konumları yansıtsın. Aksi halde taşınan panel eski bölgeyle
  // üretilip komşunun içine geçer.
  const freshVirtualFaces = useAppStore.getState().virtualFaces;
  const vfOrder = new Map<string, number>();
  freshVirtualFaces.forEach((f, i) => vfOrder.set(f.id, i));
  // BAĞIMLILIK: bir panelin extrude adımı başka bir panele referans veriyorsa,
  // referans verilen panel ÖNCE üretilmeli (yoksa extrude bayat geometriye
  // referans düzlemi çözer → iç içe geçme).
  const refIdsOf = (s: Shape): Set<string> => {
    const ids = new Set<string>();
    const es = (s.parameters as any)?.extrudeSteps;
    if (Array.isArray(es)) {
      for (const step of es) {
        if (step.refShapeId) ids.add(step.refShapeId);
      }
    }
    // REFERANS BAĞI TAŞIMA: hedef panel, taşınan panelden ÖNCE üretilmeli ki
    // güncel geometrisinden hedef köşe doğru çözülsün (bayat geometri → köşe
    // eski konumda kalıp bağ kayardı). Hedef parent gövde ise çocuk değildir,
    // zaten günceldir; eşleşmez, zararsız.
    const ts = (s.parameters as any)?.transformSteps;
    if (Array.isArray(ts)) {
      for (const step of ts) {
        if (step?.type === 'move' && step.refTargetPanelId) ids.add(step.refTargetPanelId);
      }
    }
    return ids;
  };
  const orderOf = (s: Shape): number => {
    const vfId = (s.parameters as any)?.virtualFaceId;
    const idx = vfId != null ? vfOrder.get(vfId) : undefined;
    return idx != null ? idx : 1e9 + panelTs(s) / 1e13;
  };
  const children = shapes
    .filter(s => s.type === 'panel' && (s.parameters as any)?.parentShapeId === parentShapeId)
    .sort((a, b) => {
      // BAĞIMLILIK ÖNCE: a, b'ye referans veriyorsa a sonra; b, a'ya referans
      // veriyorsa b sonra.
      const aRefsB = refIdsOf(a).has(b.id);
      const bRefsA = refIdsOf(b).has(a.id);
      if (aRefsB && !bRefsA) return 1;
      if (bRefsA && !aRefsB) return -1;
      // BU İKİ PANEL ARASINDA İŞLEM YOKSA → SIRALAMA (VF sırası) ÇALIŞIR.
      // ESKİ HATA: "işlem görmüş panel her zaman sona" kuralı, aralarında hiç
      // bağ olmayan çiftlerde de uygulanıp VF sıralamasını eziyordu. Kutu
      // genişleyince bölücü, kendisine oturan panelden SONRA üretiliyor; panel
      // bölücünün BAYAT (eski genişlikteki) ayak izini görüp arkadan kısalıyor,
      // komşusu da boşluğu doldurup uzuyordu. Aralarında extrude/ref işlemi
      // olan çiftler yukarıdaki bağımlılık dalında zaten ayrılır (sıra dışı).
      return orderOf(a) - orderOf(b);
    });
  if (children.length === 0) return;

  // TEK-PANEL MODU: yalnız işlem gören panel değiştiyse ve sıralama aynıysa,
  // sadece o paneli yeniden üret; diğer paneller/VF'ler dokunulmaz.
  //
  // ── BASAN PANEL TEK-PANEL MODUNA GİREMEZ ────────────────────────────────
  // KÖK NEDEN (bildirilen hata): üst panel ÖNCE yerleştirilip (VF idx 0 →
  // BASAN) sonra aşağı taşınınca, taşıma `changedPanelId` ile çağrıldığı için
  // tek-panel moduna düşülüyordu. Tek-panel modunda VF'ler HİÇ yeniden
  // hesaplanmaz (aşağıdaki erken `return`) → basılan kardeşler (yan/ön
  // paneller) taşınan panelin YENİ ayak izini hiç görmez, eski bölgelerinde
  // kalır. Sonuç: "diğer paneller taşınan panele göre taşınmadı" ve taşınan
  // panel onların gövdesine girer.
  // Yan panelleri önce yerleştirince hata görülmez: orada üst panel BASILAN'dır,
  // taşındığında kimsenin bölgesinin değişmesi gerekmez → tek-panel modu zararsız.
  //
  // KURAL: tek-panel modu yalnız işlem gören panelin BASILAN kardeşi YOKSA
  // (kendisinden sonra gelen, yani damgaladığı hiçbir kardeş yoksa) geçerlidir.
  // Aksi hâlde tam rebuild şart — damga sözleşmesi gereği onların bölgeleri
  // panelin yeni konumuna göre yeniden çözülmelidir. Salınım koruması,
  // en sondaki (hiç kimseyi damgalamayan) paneller için aynen korunur.
  const changedChild = opts?.changedPanelId
    ? children.find(c => c.id === opts.changedPanelId)
    : undefined;
  const changedOrder = changedChild ? orderOf(changedChild) : Infinity;
  const pressesSiblings = !!changedChild && children.some(
    c => c.id !== changedChild.id && orderOf(c) > changedOrder
  );
  if (changedChild && pressesSiblings) {
    console.log('[YAGO][REBUILD] TEK-PANEL MODU İPTAL', changedChild.id,
      'sıra=', changedOrder,
      'basılanKardeşN=', children.filter(c => c.id !== changedChild.id && orderOf(c) > changedOrder).length,
      '→ basan panel taşındı/değişti, basılan kardeşlerin VF bölgeleri yeniden çözülecek');
  }
  // İÇ KÖŞE ORTAĞI: işlem gören panel, kendisinden ÖNCE gelen bir panelle konkav
  // köşede buluşuyor(du)sa o panelin uzaması değişebilir (ör. taşındı → artık
  // uzamamalı). Tek-panel modu önceki paneli yeniden üretmeyeceği için iptal.
  const cornerPartnerOfEarlier = !!changedChild && (() => {
    const vfsNow = useAppStore.getState().virtualFaces;
    const vfOf = (s: Shape) => vfsNow.find(f => f.id === (s.parameters as any)?.virtualFaceId);
    const vq = vfOf(changedChild);
    if (!vq) return false;
    const tQ = parseFloat((changedChild.parameters as any)?.panelThickness) || 18;
    return children.some(c => {
      if (c.id === changedChild.id || orderOf(c) >= changedOrder) return false;
      const vp = vfOf(c);
      return !!vp && !!concaveCornerJoin(vp, 18, vq, tQ);
    });
  })();
  if (cornerPartnerOfEarlier) {
    console.log('[YAGO][REBUILD] TEK-PANEL MODU İPTAL', changedChild!.id,
      '→ önceki panelle iç köşe ortağı, köşe uzaması yeniden çözülecek');
  }
  // ── REFERANS BAĞIMLILARI TEK-PANEL MODUNU İPTAL EDER ─────────────────────
  // KÖK NEDEN (bildirilen hata: "paneli bir noktaya referans göstererek
  // taşıdığımda o referans nokta değiştiğinde panel güncellenmiyor; ancak
  // sonradan panel yerleştirince güncelleniyor"):
  // Referans bağı (taşıma → transformSteps.refTargetPanelId, yüz extrude →
  // extrudeSteps.refShapeId) tek yönlü bir BAĞIMLILIK grafiğidir. Bu graf
  // yalnız ÜRETİM SIRASI için kullanılıyordu (refIdsOf → children.sort);
  // GEÇERSİZ KILMA (invalidation) için HİÇ kullanılmıyordu.
  // Referans panelin ölçüsü değişince (extrude onayı/düzenlemesi, taşıma
  // adımı güncellemesi) rebuild `changedPanelId = referansPanel` ile çağrılır.
  // Referans panel VF sırasında SONDAYSA kimseyi damgalamaz → pressesSiblings
  // false → TEK-PANEL MODU. Tek-panel modu yalnız o paneli üretir; ona bağlı
  // panel hiç yeniden üretilmez, dolayısıyla refTranslate deltası güncel
  // köşeden YENİDEN ÇÖZÜLMEZ ve panel eski yerinde kalır. Yeni bir panel
  // yerleştirilince rebuild opts'suz (TAM) çağrıldığı için bağ o an çözülür —
  // kullanıcının gördüğü "sonradan yerleşince güncelleniyor" davranışı.
  // KURAL: değişen paneli referans alan bir kardeş varsa tam rebuild şart.
  const refDependents = changedChild
    ? children.filter(c => c.id !== changedChild.id && refIdsOf(c).has(changedChild.id))
    : [];
  if (refDependents.length > 0) {
    console.log('[YAGO][REBUILD] TEK-PANEL MODU İPTAL', changedChild!.id,
      '→ referans bağımlıları var:', refDependents.map(c => c.id).join(','),
      '(referans köşe/düzlem güncel geometriden yeniden çözülecek)');
  }
  const singleMode = !!opts?.changedPanelId && !opts?.orderChanged
    && !!changedChild && !pressesSiblings && !cornerPartnerOfEarlier
    && refDependents.length === 0;

  const parentPos: [number, number, number] = [...(parentFresh.position as any)] as any;

  // ═══════════════════════════════════════════════════════════════════════
  // YENİ TEMİZ MOTOR — SADECE ÜRETİM, KESİM YOK
  // Kullanıcı isteği: dönme kesim/kural mekanizması tamamen kaldırıldı. Yeni
  // yaklaşım sonra bağlanacak. Şimdilik: her panel VF'sinden üretilir, adımlar
  // (move VEYA rotate) uygulanır, geometri yazılır. Çember döndürünce panel
  // döner — komşu kesimi, grow, dominant düzlem, K6 küp kesişimi YOK.
  //
  // SIRA-DUYARLI ÜRETİM: Her panel üretildikten sonra geometrisi ANINDA store'a
  // yazılır ve VF'ler yeniden hesaplanır. Böylece bir sonraki panel, önceki
  // panelin güncel ayak izini görür — taşınan panel komşunun bölgesini doğru
  // kırpar, paneller iç içe geçmez. (Eski akış: tüm paneller snapshot VF'lerle
  // üretiliyordu → taşınan panel eski bölgeyle inşa edilip komşunun içine girer.)
  // ═══════════════════════════════════════════════════════════════════════

  // AŞAMA 1: VF'leri güncel geometri + kardeşlerle yenile (bölge otoritesi).
  //          (Ayak izi/serbest bölge katmanı korunur — döndürme arayüzü ve
  //           çemberler bu VF'ler üzerinden çalışır.)
  //          TEK-PANEL MODU'nda yeniden hesaplama YAPILMAZ (komşuları restamp
  //          edip salınıma yol açıyordu); store'daki mevcut VF'ler kullanılır.
  let currentVfs: VirtualFace[] = singleMode
    ? useAppStore.getState().virtualFaces.filter(f => (f as any).shapeId === parentShapeId)
    : recalculateVirtualFacesForShape(
        parentFresh, useAppStore.getState().virtualFaces, useAppStore.getState().shapes, 'all'
      );

  const buildPanel = async (panel: Shape, vfsIn: VirtualFace[]): Promise<void> => {
    try {
      const att = getPanelAttachment(panel, vfsIn);
      if (!att) return;
      const thickness = parseFloat((panel.parameters as any)?.panelThickness) || 18;
      let steps = getUnifiedSteps(panel);
      // ESKİ FIXED ADIMLAR: fixedRef yoksa bu rebuild'deki ham yüz konumu kaydedilir;
      // bundan sonra panel bu mutlak konumda kalır.
      let stepsMigrated = false;
      {
        let sawRotate = false;
        steps = steps.map((st: any) => {
          if (st.type === 'rotate') { sawRotate = true; return st; }
          if (st.type === 'move' && st.isFixed && typeof st.fixedRef !== 'number' && !sawRotate
              && !st.refTargetPanelId && !st._refAxisVec) {
            const ref = vfRawMinAlong(att.vf, st.axis);
            if (ref !== null) { stepsMigrated = true; return { ...st, fixedRef: ref }; }
          }
          return st;
        });
      }
      // Panel VF'sinden gerçek boyutta üretilir (expand=0, doğru 18mm kalınlık).
      // İÇ KÖŞE: sıralamada önce olan panel, konkav köşede buluştuğu sonraki
      // panelin ucunu kapatacak kadar uzar (VF değişmez, yalnız üretim köşeleri).
      const buildVerts = cornerJoinedVertices(panel, att.vf, vfsIn, children, orderOf);
      // DÖNMÜŞ PANEL = BÜYÜT & SIĞDIR (Goker: "döndüğünde yeni açısına göre
      // otomatik uzamalı"). Dönmüş panel önce düzlem içinde gövdeyi aşacak kadar
      // büyütülür, adımlar uygulanır, sonra gövdeyle KESİŞTİRİLİR (açıya göre
      // tam duvara kadar uzar, hacmin dışına taşmaz) ve kendisinden ÖNCE gelen
      // (basan) kardeşlerin gövdeleriyle KESİLİR (onların iç yüzüne açıyla
      // dayanır). Düz panellerde büyütme yok — davranış aynen korunur.
      const isRotated = panelHasRotation(panel);
      const pp: any = parentFresh.parameters || {};
      const growAmount = isRotated
        ? Math.max(parseFloat(pp.width) || 0, parseFloat(pp.height) || 0, parseFloat(pp.depth) || 0, 600) * 1.5
        : 0;
      let rp = await createPanelFromVirtualFace(buildVerts, att.vf.normal, thickness, growAmount);
      if (!rp) return;
      // Adımlar (move/rotate) sırayla uygulanır — çember döndürünce panel döner.
      const { ops } = composeSteps(steps, att.vf);
      let refDeltaApplied: [number, number, number] | null = null;
      for (const op of ops) {
        if (op.kind === 'translate') {
          rp = rp.translate(op.d.x, op.d.y, op.d.z);
        } else if (op.kind === 'refTranslate') {
          // rp'nin o anki DÜNYA kutusu: mesh (yıkıcı değil) → uzay-S kutusu +
          // parentPos. Referans şeklin güncel köşesine kilitli delta çözülür.
          let rpWorldBox: THREE.Box3;
          try {
            const g = convertReplicadToThreeGeometry(rp);
            const b = new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);
            b.translate(new THREE.Vector3(parentPos[0], parentPos[1], parentPos[2]));
            rpWorldBox = b;
          } catch {
            rpWorldBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
          }
          const d = resolveRefTranslateDelta(op, rpWorldBox);
          // TEK KAYNAK: bu rebuild'de GERÇEKTEN uygulanan ref deltası panele
          // yazılır. Damgalama (VirtualFaceUpdateService) deltayı yeniden
          // ÇÖZMEZ, bunu okur — aksi halde iki taraf farklı anlarda store'a
          // bakıp ayrışıyor ve damga panelin gerçek yerini göstermiyordu.
          refDeltaApplied = [d.x, d.y, d.z];
          rp = rp.translate(d.x, d.y, d.z);
        } else {
          rp = rp.rotate(op.deg, [op.pivot.x, op.pivot.y, op.pivot.z], [op.axis.x, op.axis.y, op.axis.z]);
        }
      }

      if (isRotated) {
        rp = await fitRotatedPanel(rp, panel, parentFresh, children, orderOf);
      }

      // YÜZ EXTRUDE: panel artık DOĞRU ÇERÇEVEDE (VF'den üretildi + transform
      // işlendi). Saklı extrudeSteps varsa aynı çerçevede uygulanır — panel
      // tıklanan yüzden büyür/küçülür ve her rebuild'de KORUNUR. Adımın yüz
      // verisi (normal/merkez/samplePoint) tıklama anında bu çerçevede
      // yakalandığı için eşleşme birebir tutar; taban ARTIK origin kutusu
      // DEĞİL → panel "alakasız yere" ışınlanmaz.
      let dimsUpdate: { width: number; height: number; depth: number } | null = null;
      let resolvedStepsUpdate: any[] | null = null;
      const extrudeSteps = (panel.parameters as any)?.extrudeSteps;
      if (Array.isArray(extrudeSteps) && extrudeSteps.length > 0) {
        try {
          const { applyExtrudeSteps } = await import('./FaceExtrudeService');
          const ext = await applyExtrudeSteps(rp, extrudeSteps, useAppStore.getState().shapes);
          if (ext) {
            rp = ext.shape;
            const eb = new THREE.Box3().setFromBufferAttribute(
              ext.geometry.getAttribute('position') as THREE.BufferAttribute
            );
            const es = new THREE.Vector3(); eb.getSize(es);
            const dsz = [es.x, es.y, es.z].sort((a, b) => b - a);
            dimsUpdate = {
              width: Math.round(dsz[0] * 10) / 10,
              height: Math.round(dsz[1] * 10) / 10,
              depth: Math.round(dsz[2] * 10) / 10,
            };
            // Ref adımlarının çözülen değerini adıma yaz — editör "İşlem
            // adımları" listesi 0 yerine gerçek miktarı (ör. -122) göstersin.
            // Değer değişmediyse yazma (gereksiz store dalgalanmasını önle).
            if (ext.resolved && ext.resolved.length) {
              const byId = new Map(ext.resolved.map(r => [r.id, r.value]));
              let changed = false;
              const merged = extrudeSteps.map((s: any) => {
                const rv = byId.get(s.id);
                if (rv != null && s.resolvedValue !== rv) { changed = true; return { ...s, resolvedValue: rv }; }
                return s;
              });
              if (changed) resolvedStepsUpdate = merged;
            }
          }
        } catch (err) {
          console.error('[YAGO][MOTOR] extrude adımı hatası:', panel.id,
            (err as any)?.message || String(err));
        }
      }

      // DÖNÜŞ-KESİMİ: kendisinden önce gelen dönmüş kardeşlerin eğik düzlemi.
      if (!panelHasRotation(panel)) {
        rp = await cutByRotatedPressers(rp, panel, att.vf, children, vfsIn, orderOf, createPanelFromVirtualFace);
      }

      const geometry = convertReplicadToThreeGeometry(rp);
      const paramPatch: any = {};
      if (dimsUpdate) Object.assign(paramPatch, dimsUpdate);
      if (resolvedStepsUpdate) paramPatch.extrudeSteps = resolvedStepsUpdate;
      if (refDeltaApplied) paramPatch._refDeltaApplied = refDeltaApplied;
      if (stepsMigrated) paramPatch.transformSteps = steps;
      // ANINDA YAZ: panel geometrisi store'a yazılır ki bir sonraki panel
      // güncel ayak izini görsün ve VF yeniden hesaplamasında bu geometri
      // kullanılsın (iç içe geçmeyi önler).
      updateShape(panel.id, {
        geometry,
        position: parentPos,
        rotation: [0, 0, 0],
        replicadShape: rp,
        ...(Object.keys(paramPatch).length ? { parameters: { ...panel.parameters, ...paramPatch } } : {}),
      } as any);
    } catch (err) {
      console.error('[YAGO][MOTOR] panel üretim hatası:', panel.id,
        (err as any)?.message || String(err));
    }
  };

  // TEK-PANEL MODU: yalnız işlem gören paneli üret, diğerlerine ve VF'lere
  // DOKUNMA. Değişmeyen panellerin geometrisi/ayak izi sabit kaldığından
  // damga-trim salınımı (komşu panel kısalması) oluşmaz.
  if (singleMode) {
    const panel = children.find(c => c.id === opts!.changedPanelId)!;
    await buildPanel(panel, currentVfs);
    return;
  }

  // SIRA-DUYARLI DÖNGÜ: her panel üretildikten sonra VF'leri yeniden hesapla
  // ki bir sonraki panel güncel kardeş ayak izlerini görsün. currentVfs
  // (store DEĞİL) girdi olarak geçilir — böylece her iterasyon bir öncekinin
  // güncel VF merkezlerini/rawFaceBBox'ını kullanır; bayat store VF'leri ile
  // damga geometrisi eski konumda kalıp yan panelleri kısaltmaz.
  for (const panel of children) {
    await buildPanel(panel, currentVfs);
    const updatedShapes = useAppStore.getState().shapes;
    const updatedParent = updatedShapes.find(s => s.id === parentShapeId) || parentFresh;
    currentVfs = recalculateVirtualFacesForShape(
      updatedParent, currentVfs, updatedShapes, 'all'
    );
  }

  // AŞAMA 3: son VF'lerle bir kez daha üret — ilk geçişte build sırası
  // yüzünden bayat geometriyle hesaplanan VF'ler düzeltilir. Her panel
  // arasında VF'ler currentVfs üzerinden (store DEĞİL) yeniden hesaplanır.
  for (const panel of children) {
    await buildPanel(panel, currentVfs);
    const updatedShapes2 = useAppStore.getState().shapes;
    const updatedParent2 = updatedShapes2.find(s => s.id === parentShapeId) || parentFresh;
    currentVfs = recalculateVirtualFacesForShape(
      updatedParent2, currentVfs, updatedShapes2, 'all'
    );
  }

  // AŞAMA 4: tüm paneller güncel konumda → VF'leri kesin ayak izleriyle yaz.
  if (updateVirtualFace) {
    for (const f of currentVfs) updateVirtualFace(f.id, f);
  }
}


// ── küçük yardımcılar ─────────────────────────────────────────────────────
function panelTs(s: Shape): number {
  const m = /(\d{10,})/.exec(s.id);
  return m ? parseInt(m[1], 10) : 0;
}