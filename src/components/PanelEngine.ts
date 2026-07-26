import * as THREE from 'three';
import { useAppStore, type Shape, type VirtualFace } from '../store';
import { vfPlaneBasis, type RotateStep } from './PanelRotateService';
import type { TransformStep } from './PanelTransformService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PANEL MOTORU — tek temiz çekirdek.
 *
 * TASARIM SÖZLEŞMESİ
 *  • Tek gerçek kaynak SPEC'tir: panelin bağı (hangi yüz) + sıralı adım
 *    listesi. Geometri her rebuild'de spec'ten SIFIRDAN türetilir; önceki
 *    geometriden asla beslenilmez (geri-besleme döngüsü yasak — oran-drift
 *    ve bölge-zıplama hatalarının kök dersi).
 *  • BAĞ KAYDI ("hangi panel hangi yüze bakıyor"): panel.parameters
 *    .virtualFaceId ↔ VF. VF kimliği, VirtualFaceUpdateService'in descriptor
 *    tabanlı eşleştirmesiyle geometri değişse de aynı yüzü izler; VF üzerinde
 *    rawFaceBBox (mutlak oran çıpası) ve sideRelations (kardeş-taraf
 *    sözleşmesi) taşınır. Motor bu kaydı getPanelAttachment ile tek yerden
 *    okur.
 *  • ADIMLAR sıralı ve birbirine göredir: her adım, önceki adımların ürettiği
 *    ÇERÇEVEDE yorumlanır (dönüşten sonraki taşıma dönmüş eksenleri izler).
 *    Pivotlar mutlak değil çıpadır (pivotVfFrac): rebuild pivotu her seferinde
 *    GÜNCEL yüzeyden türetir — parametrik.
 *
 * BİRLEŞİM KURALLARI (damıtılmış öğrenimler, isimli):
 *  K1 SIRA ÖNCELİĞİ  — yerleşim sırası önceliktir; sonra gelen panel önce
 *     gelene yol verir (yalnız ÖNCEKİ kardeşler kesici olur).
 *  K2 GÖNYE          — düz panel ↔ dönmüş kardeş teması: kesim, kardeşin
 *     kalınlık bandının PANELE BAKAN yüzünden geçen yarım-uzayla yapılır.
 *     Taraf, panel MERKEZİNİN banda göre konumundan seçilir (kenar/aşım
 *     kriterleri panel bandı delince yanılıyordu — log kanıtlı). Taşma yoksa
 *     gövde kesimine düşülür; kesim etkisizse aynalı slabla yeniden denenir
 *     (oryantasyon sigortası).
 *  K3 EŞ-DÜZLEM      — ince eksenleri paralel düz kardeşler birebir çakışık
 *     yüzey üretir; OCC sessiz no-op riskine karşı ±EPS kaydırmalı ÇİFT
 *     gövde kesimi uygulanır.
 *  K4 GÖVDE          — diğer tüm temaslar AABB ön-eleme + düz gövde kesimi.
 *  K5 BÖLGE=VURGU    — panelin taban katısı DOĞRUDAN güncel VF çokgeninden
 *     ekstrüde edilir ("highlight = panel"); tam-yüz + bölge-seçim zinciri
 *     tamamen kaldırıldı (kırılgan katmanların kökü oydu).
 *  K6 EBEVEYN SINIRI — dönmemiş panel ebeveyn katısıyla kesişimlenir (içeride
 *     kalır); DÖNMÜŞ panel kesişimlenmez (kasten dışarı taşabilir — görsel
 *     davranış korunur).
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

export function composeSteps(
  steps: TransformStep[],
  vf: VirtualFace
): { quat: THREE.Quaternion; ops: Array<{ kind: 'translate'; d: THREE.Vector3 } | { kind: 'rotate'; deg: number; pivot: THREE.Vector3; axis: THREE.Vector3 }> } {
  const ops: any[] = [];
  const frame = new THREE.Quaternion(); // o ana kadarki birleşik dönüş
  for (const s of steps) {
    if (s.type === 'move') {
      const base = axisLetterToVec((s as any).axis);
      const d = base.clone().applyQuaternion(frame).multiplyScalar((s as any).value);
      ops.push({ kind: 'translate', d });
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

// ── Dönmüş panelin kalınlık bandı (saf, geometri problamadan) ────────────
// nW = VF normalinin adım kuaterniyonuyla dönmüşü. Düzlem noktası = VF
// merkezinin adımlarla taşınmışı. Panel -normal yönüne ekstrüde olduğundan
// band = [dDüzlem - kalınlık, dDüzlem].
export function rotatedBand(
  panel: Shape,
  vf: VirtualFace,
  thickness: number
): { nW: THREE.Vector3; dMin: number; dMax: number } | null {
  const steps = getUnifiedSteps(panel);
  const { quat, ops } = composeSteps(steps, vf);
  const n0 = new THREE.Vector3(...(vf.normal as [number, number, number])).normalize();
  const nW = n0.clone().applyQuaternion(quat).normalize();
  // VF merkezini adımların konumsal etkisiyle taşı
  let c = new THREE.Vector3();
  for (const v of vf.vertices) c.add(new THREE.Vector3(v[0], v[1], v[2]));
  c.divideScalar(vf.vertices.length);
  for (const op of ops) {
    if (op.kind === 'translate') c.add(op.d);
    else {
      const q = new THREE.Quaternion().setFromAxisAngle(op.axis, (op.deg * Math.PI) / 180);
      c.sub(op.pivot).applyQuaternion(q).add(op.pivot);
    }
  }
  const dMax = nW.dot(c);
  return { nW, dMin: dMax - thickness, dMax };
}

// ── Rebuild orkestrasyonu ─────────────────────────────────────────────────
const inFlight = new Set<string>();
const pending = new Set<string>();
const dominanceRelations = new Map<string, string>();

export async function rebuildPanelsForParent(parentShapeId: string): Promise<void> {
  if (inFlight.has(parentShapeId)) {
    pending.add(parentShapeId);
    console.info('[PanelRebuild] rebuild already in flight for', parentShapeId, '— queued a re-run');
    return;
  }
  inFlight.add(parentShapeId);
  try {
    await rebuildOnce(parentShapeId);
  } finally {
    inFlight.delete(parentShapeId);
    if (pending.has(parentShapeId)) {
      pending.delete(parentShapeId);
      await rebuildPanelsForParent(parentShapeId);
    }
  }
}

async function rebuildOnce(parentShapeId: string): Promise<void> {
  const store = useAppStore.getState();
  const parent = store.shapes.find(s => s.id === parentShapeId);
  if (!parent) return;

  const { recalculateVirtualFacesForShape } = await import('./VirtualFaceUpdateService');
  const {
    createPanelFromVirtualFace, convertReplicadToThreeGeometry,
    performBooleanCut, performBooleanIntersection,
  } = await import('./ReplicadService');

  // TAZE STATE: yukarıdaki await import'lar sırasında store güncellenebilir;
  // tüm okumalar bu taze snapshot'tan yapılır (bayat sıra/şekil önlenir).
  const fresh = useAppStore.getState();
  const shapes = fresh.shapes;
  const parentFresh = shapes.find(s => s.id === parentShapeId) || parent;
  const updateShape = fresh.updateShape;
  const updateVirtualFace = (fresh as any).updateVirtualFace as ((id: string, u: any) => void) | undefined;

  // K1 SIRA KAYNAĞI: Kullanıcı panel sırasını UI'da VF listesini yeniden
  // sıralayarak değiştirir (reorderVirtualFaces / reorderVirtualFaceGroup →
  // store.virtualFaces dizisinin SIRASI). Sıra, panelin VF'sinin bu dizideki
  // İNDEKSİNDEN okunur. ÖNEMLİ: dizinin TAZE hali kullanılır — üstteki await
  // import'lar sırasında store güncellenmiş olabilir; fonksiyon başındaki
  // snapshot bayatlayabilir (vf#? teşhisinin olası kökü).
  const freshVirtualFaces = useAppStore.getState().virtualFaces;
  const vfOrder = new Map<string, number>();
  freshVirtualFaces.forEach((f, i) => vfOrder.set(f.id, i));
  const orderOf = (s: Shape): number => {
    const vfId = (s.parameters as any)?.virtualFaceId;
    const idx = vfId != null ? vfOrder.get(vfId) : undefined;
    if (idx == null && vfId != null) {
      console.warn('[YAGO][SIRA] vf bulunamadı! panel=', s.id.slice(-6),
        'aranan vfId=', vfId,
        'store vfIds(ilk3)=', freshVirtualFaces.slice(0, 3).map(f => f.id));
    }
    return idx != null ? idx : 1e9 + panelTs(s) / 1e13;
  };
  const children = shapes
    .filter(s => s.type === 'panel' && (s.parameters as any)?.parentShapeId === parentShapeId)
    .sort((a, b) => orderOf(a) - orderOf(b));
  if (children.length === 0) return;
  console.log('[YAGO][SIRA]', parentShapeId, 'panel sırası=',
    children.map(c => `${c.id.slice(-6)}(vf#${orderOf(c) < 1e9 ? orderOf(c) : '?'})`).join(' → '));

  const parentPos: [number, number, number] = [...(parentFresh.position as any)] as any;
  const parentMax = Math.max(
    parseFloat((parentFresh.parameters as any)?.width) || 0,
    parseFloat((parentFresh.parameters as any)?.height) || 0,
    parseFloat((parentFresh.parameters as any)?.depth) || 0
  ) || 2000;

  const builtSolid = new Map<string, any>();
  const builtGrown = new Map<string, any>();
  const builtBand = new Map<string, { nW: THREE.Vector3; dMin: number; dMax: number } | null>();
  const meta = new Map<string, { att: PanelAttachment; thickness: number; isRotated: boolean; steps: TransformStep[] }>();

  // ── ÖN-GEÇİŞ: taşıma/dönme UYGULANMIŞ ham geometrileri ERKEN yaz ──────────
  // KRİTİK SIRA: VF regen (aşağıda) komşu VF'leri panellerin GÜNCEL
  // geometrisinden kırpar. Ama move/rotate yalnız ADIM parametresi yazar,
  // geometriyi değil — bu yüzden regen taşınan panelin ESKİ ayak izini görüp
  // komşuları eski konuma göre kırpıyordu ("panel taşınınca komşular
  // küçülüp büyümüyor"). Çözüm: adım-uygulanmış ham geometriyi regen'den ÖNCE
  // store'a yaz. Böylece regen taze ayak izlerini görür; kesimler Faz B'de.
  const vfsPre: VirtualFace[] = recalculateVirtualFacesForShape(
    parentFresh, freshVirtualFaces, shapes, 'all'
  );
  for (const panel of children) {
    try {
      const att = getPanelAttachment(panel, vfsPre);
      if (!att) continue;
      const thickness = parseFloat((panel.parameters as any)?.panelThickness) || 18;
      const steps = getUnifiedSteps(panel);
      const isRotated = steps.some(s => s.type === 'rotate');
      const expand = isRotated ? parentMax : 0;
      let rp = await createPanelFromVirtualFace(att.vf.vertices, att.vf.normal, thickness, expand);
      if (!rp) continue;
      const { ops } = composeSteps(steps, att.vf);
      const applyOps = (solid: any) => {
        let s = solid;
        for (const op of ops) {
          if (op.kind === 'translate') s = s.translate(op.d.x, op.d.y, op.d.z);
          else s = s.rotate(op.deg, [op.pivot.x, op.pivot.y, op.pivot.z], [op.axis.x, op.axis.y, op.axis.z]);
        }
        return s;
      };
      rp = applyOps(rp);
      let cutterSolid = rp;
      if (isRotated) {
        const trueBase = await createPanelFromVirtualFace(att.vf.vertices, att.vf.normal, thickness, 0);
        if (trueBase) cutterSolid = applyOps(trueBase);
      }
      builtSolid.set(panel.id, cutterSolid);
      builtGrown.set(panel.id, rp);
      builtBand.set(panel.id, isRotated ? rotatedBand(panel, att.vf, thickness) : null);
      meta.set(panel.id, { att, thickness, isRotated, steps });
      // Adım-uygulanmış HAM geometriyi erken yaz → regen taze ayak izini görsün.
      const gPre = convertReplicadToThreeGeometry(cutterSolid);
      updateShape(panel.id, { geometry: gPre, position: parentPos, rotation: [0, 0, 0] } as any);
    } catch (err) {
      console.error('[YAGO][MOTOR] ön-geçiş hatası:', panel.id, err);
    }
  }

  // 1) BÖLGE OTORİTESİ: artık paneller GÜNCEL (taşınmış) geometride — komşu
  //    VF'ler doğru ayak izleriyle kırpılır ("küçülüp büyüme" düzelir).
  const freshShapes = useAppStore.getState().shapes;
  let vfs: VirtualFace[] = recalculateVirtualFacesForShape(
    parentFresh, useAppStore.getState().virtualFaces, freshShapes, 'all'
  );
  if (updateVirtualFace) {
    for (const f of vfs) updateVirtualFace(f.id, f);
  }

  // ── TAZE-GEÇİŞ: katıları GÜNCEL VF'lerden yeniden üret ────────────────────
  // Ön-geçiş vfsPre'yi ÖNCEKI rebuild'in kırpılmış VF'lerinden üretti. A paneli
  // B'nin içine taşındığında B'nin katısı eski (kırpılmamış) VF'den üretiliyor
  // → Faz B kesimi bir-adım-gecikmeli oluyor. A geri alınınca B'nin katısı hâlâ
  // eski kırpılmış VF'den üretiliyor → B kısa kalıyor. Çözüm: taze VF'lerden
  // katıları yeniden üret, böylece Faz B her zaman güncel kardeş konumlarına
  // göre keser.
  for (const panel of children) {
    try {
      const att = getPanelAttachment(panel, vfs);
      if (!att) continue;
      const thickness = parseFloat((panel.parameters as any)?.panelThickness) || 18;
      const steps = getUnifiedSteps(panel);
      const isRotated = steps.some(s => s.type === 'rotate');
      const expand = isRotated ? parentMax : 0;
      let rp = await createPanelFromVirtualFace(att.vf.vertices, att.vf.normal, thickness, expand);
      if (!rp) continue;
      const { ops } = composeSteps(steps, att.vf);
      const applyOps = (solid: any) => {
        let s = solid;
        for (const op of ops) {
          if (op.kind === 'translate') s = s.translate(op.d.x, op.d.y, op.d.z);
          else s = s.rotate(op.deg, [op.pivot.x, op.pivot.y, op.pivot.z], [op.axis.x, op.axis.y, op.axis.z]);
        }
        return s;
      };
      rp = applyOps(rp);
      let cutterSolid = rp;
      if (isRotated) {
        const trueBase = await createPanelFromVirtualFace(att.vf.vertices, att.vf.normal, thickness, 0);
        if (trueBase) cutterSolid = applyOps(trueBase);
      }
      builtSolid.set(panel.id, cutterSolid);
      builtGrown.set(panel.id, rp);
      builtBand.set(panel.id, isRotated ? rotatedBand(panel, att.vf, thickness) : null);
      meta.set(panel.id, { att, thickness, isRotated, steps });
    } catch (err) {
      console.error('[YAGO][MOTOR] taze-geçiş hatası:', panel.id, err);
    }
  }

  // ── FAZ B: KURAL TABLOSU ile birleşim kesimleri ──────────────────────────
  //   Kesilen \ Kesici │ önceki DÜZ │ sonraki DÜZ │ DÖNMÜŞ (herhangi sıra)
  //   ─────────────────┼────────────┼─────────────┼───────────────────────
  //   DÜZ panel        │  K1 (evet) │   hayır     │  K2 GÖNYE (evet)
  //   DÖNMÜŞ panel     │   hayır    │   hayır     │  önceki dönmüşse K4
  const finalSolids = new Map<string, any>();
  for (let pi = 0; pi < children.length; pi++) {
    const panel = children[pi];
    const m = meta.get(panel.id);
    let rp = builtGrown.get(panel.id) ?? builtSolid.get(panel.id);
    if (!m || !rp) continue;
    const { att, thickness, isRotated } = m;
    try {
      for (let si = 0; si < children.length; si++) {
        if (si === pi) continue;
        const sib = children[si];
        const sm = meta.get(sib.id);
        const sibSolid = builtSolid.get(sib.id);
        if (!sm || !sibSolid) continue;
        const sibRotated = sm.isRotated;

        // ── GEOMETRİK DOMINANS (açıdan bağımsız) ──────────────────────────
        // Bir panelin kalınlık KENARI komşunun geniş YÜZEYİNE değiyorsa,
        // YÜZEY sahibi dominanttır: tam boy korunur, kenarı değen panel KISALIR.
        // Eski `perp` eşiği (dot<0.3) büyük açılarda (ör. -30°) geometric
        // kontrolü tamamen atlıyor ve yanlış sıraya düşüyordu. Artık her
        // açıda edgeWithinFace çalışır; sonuç kalıcı dominanceRelations'da
        // saklanır ki açı değişse bile ilişki kararlı kalır.
        //
        //   dominant = yüzeyi alınan panel (kesen, tam boy)
        //   submissive = kenarı değen panel (kesilen, kısalır)
        const pairKey = panel.id < sib.id ? `${panel.id}|${sib.id}` : `${sib.id}|${panel.id}`;
        const storedDominant = dominanceRelations.get(pairKey) ?? null;
        const panelThin = panelThinAxisWorld(m.att, m.steps);
        const sibThin = panelThinAxisWorld(sm.att, sm.steps);
        const panelEdgeMeetsSib = edgeWithinFace(rp, sibSolid, sibThin);
        const sibEdgeMeetsPanel = edgeWithinFace(sibSolid, rp, panelThin);
        let sibDominant: boolean;
        if (panelEdgeMeetsSib && !sibEdgeMeetsPanel) {
          sibDominant = true;
        } else if (sibEdgeMeetsPanel && !panelEdgeMeetsSib) {
          sibDominant = false;
        } else if (storedDominant) {
          sibDominant = storedDominant === sib.id;
        } else {
          sibDominant = si < pi;
        }
        if (aabbTouch(rp, sibSolid)) {
          dominanceRelations.set(pairKey, sibDominant ? sib.id : panel.id);
        }

        // Yalnızca submissive (kesilen) panel işlenir. Dominant panel tam
        // boy korunur — onu sibling döngüsünde kendi sırası geldiğinde keser.
        let mode: 'none' | 'miter' | 'flat' | 'body' = 'none';
        if (sibDominant) {
          if (!isRotated && sibRotated) mode = 'miter';   // düz submissive ← dönmüş dominant: gönye
          else if (!isRotated && !sibRotated) mode = 'flat'; // düz ← düz: K1 flat
          else mode = 'body';                              // dönmüş submissive: gövde kesimi
        }
        if (mode === 'none') continue;

        if (!aabbTouch(rp, sibSolid)) continue;

        if (mode === 'miter') {
          const band = builtBand.get(sib.id) ?? rotatedBand(sib, sm.att.vf, sm.thickness);
          const cutter = await miterHalfSpace(
            rp, band, att.vf, panel, parentMax, createPanelFromVirtualFace
          );
          if (cutter) {
            const before = bb6(rp);
            let attempt = await performBooleanCut(safeClone(rp), cutter);
            let d = bbDelta(before, bb6(attempt));
            if (d < 0.5) {
              const mirrored = await miterHalfSpace(
                rp, band, att.vf, panel, parentMax, createPanelFromVirtualFace, true
              );
              if (mirrored) {
                const a2 = await performBooleanCut(safeClone(rp), mirrored);
                const d2 = bbDelta(before, bb6(a2));
                if (d2 > 0.5) { attempt = a2; d = d2; }
              }
            }
            console.log('[YAGO][GÖNYE]', panel.id, '<-', sib.id, 'değişim=', d.toFixed(1));
            if (d > 0.001) rp = attempt;
          }
          // Gönye kesiminden SONRA (veya gönye kurulamadıysa) dönmüş kardeşin
          // GERÇEK GÖVDESİYLE boolean çıkarma yap. Gönye yalnızca düzlemsel bir
          // yarım-uzay kesimidir ve büyük açılarda (ör. -30°) eğimli panelin
          // gerçek geometrisi o düzlemin ötesine taşar. Gövde kesimi kalan
          // iç-içe geçmeyi temizler. Kardeşi 2mm şişirerek (her yöne ölçekle)
          // ince temas kenarlarında boolean motoru hassasiyet sorunu yaşamasın.
          try {
            const sibBody = builtSolid.get(sib.id) ?? sibSolid;
            const bodyResult = await performBooleanCut(safeClone(rp), safeClone(sibBody));
            const bodyB = bb6(bodyResult);
            const rpB = bb6(rp);
            if (bodyB && rpB &&
                (bodyB[3] - bodyB[0]) > 1e-3 &&
                (bodyB[4] - bodyB[1]) > 1e-3 &&
                (bodyB[5] - bodyB[2]) > 1e-3 &&
                bbDelta(rpB, bodyB) > 0.5) {
              rp = bodyResult;
            }
          } catch (e) { /* gönye sonrası gövde kesim başarısız — sorun değil */ }
          continue;
        }

        if (mode === 'flat' && coplanarThin(rp, sibSolid)) {
          // K3 EŞ-DÜZLEM: ±EPS çift kesim
          const n = thinAxis(sibSolid);
          for (const sgn of [2, -2]) {
            try {
              const shifted = safeClone(sibSolid).translate(n.x * sgn, n.y * sgn, n.z * sgn);
              rp = await performBooleanCut(rp, shifted);
            } catch (e) { console.warn('[YAGO][MOTOR] K3 kesim hatası:', e); }
          }
          continue;
        }

        // K4 GÖVDE (flat-earlier veya rotated-rotated)
        try {
          rp = await performBooleanCut(rp, safeClone(sibSolid));
        } catch (e) { console.warn('[YAGO][MOTOR] K4 kesim hatası:', panel.id, '<-', sib.id, e); }
      }

      // K6: EBEVEYN SINIRI — artık DÖNMÜŞ panel de kesişimlenir. Dönen panel
      // küpün referans sınırına çarpınca açısına göre KISALIR ve kalınlık ucu
      // sınır yüzeyinde biçilir (istenen: "kübün referans sınırlarına çarpıp
      // durmalı, ölçüsünü açıya göre güncellemeli"). Kesişim panel katısını
      // yok ederse (tam dışarıda) uygulanmaz — güvenlik.
      if ((parentFresh as any).replicadShape) {
        try {
          const clipped = await performBooleanIntersection(rp, safeClone((parentFresh as any).replicadShape));
          const cb = bb6(clipped);
          if (cb && isFinite(cb[0]) && (cb[3] - cb[0]) > 1e-3 && (cb[4] - cb[1]) > 1e-3 && (cb[5] - cb[2]) > 1e-3) {
            rp = clipped;
          } else if (isRotated) {
            console.log('[YAGO][MOTOR] dönmüş panel sınır kesişimi boş/ince, kesimsiz bırakıldı:', panel.id);
          }
        } catch (e) { console.warn('[YAGO][MOTOR] K6 kesişim hatası:', e); }
      }

      // ÖNEMLİ: kesici havuzu (builtSolid) HAM kalır — nihai katıyı havuza
      // yazmak sıraya bağımlılığı arka kapıdan geri sokar. Nihai katı yalnız
      // şekle gider.
      finalSolids.set(panel.id, rp);
      const geometry = convertReplicadToThreeGeometry(rp);
      updateShape(panel.id, {
        geometry,
        position: parentPos,
        rotation: [0, 0, 0],
        replicadShape: rp,
      } as any);
      console.log('[YAGO][MOTOR] panel yeniden üretildi:', panel.id,
        'adımN=', m.steps.length, isRotated ? 'DÖNMÜŞ' : 'düz');
    } catch (err) {
      console.error('[YAGO][MOTOR] panel rebuild hatası, önceki geometri korunuyor:', panel.id, err);
    }
  }

  // ── KÜRPMA GEÇİŞİ ──────────────────────────────────────────────────────
  // Dönmüş (genişletilmiş) paneller kutu sınırına kadar uzanır (K6), ama
  // kardeş panellerin İÇİNE de girmiş olabilirler. Burada her dönmüş panelin
  // görsel mesh'ini tüm kardeşlerin gerçek gövdesiyle (builtSolid) keserek
  // iç-içe geçmeyi önleriz. Tüm paneller zaten build edilmiş olduğundan
  // builtSolid haritası tam doludur.
  for (let pi = 0; pi < children.length; pi++) {
    const panel = children[pi];
    const m = meta.get(panel.id);
    if (!m) continue;
    const isRotated = m.steps.some((st: any) => st.type === 'rotate');
    if (!isRotated) continue;

    let rp: any = finalSolids.get(panel.id);
    if (!rp) continue;
    let changed = false;

    for (let si = 0; si < children.length; si++) {
      if (si === pi) continue;
      const sib = children[si];
      const sibSolid = builtSolid.get(sib.id);
      if (!sibSolid) continue;
      if (!aabbTouch(rp, sibSolid)) continue;
      try {
        const result = await performBooleanCut(safeClone(rp), safeClone(sibSolid));
        const rb = bb6(result);
        if (rb && (rb[3] - rb[0]) > 1e-3 && (rb[4] - rb[1]) > 1e-3 && (rb[5] - rb[2]) > 1e-3) {
          rp = result;
          changed = true;
        }
      } catch { /* kırpma başarısız — atla */ }
    }

    if (changed) {
      const geometry = convertReplicadToThreeGeometry(rp);
      updateShape(panel.id, {
        geometry,
        position: parentPos,
        rotation: [0, 0, 0],
        replicadShape: rp,
      } as any);
    }
  }
}

// ── K2 yarım-uzay kurucusu ────────────────────────────────────────────────
async function miterHalfSpace(
  rp: any,
  band: { nW: THREE.Vector3; dMin: number; dMax: number } | null,
  vf: VirtualFace,
  panel: Shape,
  parentMax: number,
  createPanelFromVirtualFace: (v: any, n: any, t: number, e: number) => Promise<any>,
  mirrored = false
): Promise<any | null> {
  if (!band) return null;
  const { nW, dMin, dMax } = band;
  const c = new THREE.Vector3();
  for (const v of vf.vertices) c.add(new THREE.Vector3(v[0], v[1], v[2]));
  c.divideScalar(vf.vertices.length);
  const dS = nW.dot(c);
  const dC = (dMin + dMax) / 2;
  const belowBand = dS < dC;                       // K2: MERKEZ-taraf kuralı
  const near = belowBand ? dMin : dMax;
  const away = belowBand ? nW.clone() : nW.clone().negate();
  // Taşma kontrolü: panel near'ı aşmıyorsa gönyeye gerek yok.
  const box = bb6(rp);
  if (!box) return null;
  let dEdgeMax = -Infinity, dEdgeMin = Infinity;
  for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]]) {
    const d = nW.x * x + nW.y * y + nW.z * z;
    dEdgeMax = Math.max(dEdgeMax, d); dEdgeMin = Math.min(dEdgeMin, d);
  }
  const overhang = belowBand ? (dEdgeMax - near) : (near - dEdgeMin);
  if (overhang < 0.5) return null;

  const p0 = c.clone().add(nW.clone().multiplyScalar(near - dS));
  const up = (Math.abs(away.y) > Math.abs(away.x) && Math.abs(away.y) > Math.abs(away.z))
    ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(away, up).normalize();
  const vv = new THREE.Vector3().crossVectors(away, u).normalize();
  const L = 3 * parentMax;
  const base = mirrored ? p0.clone().addScaledVector(away, L) : p0.clone();
  const nrm: [number, number, number] = mirrored
    ? [away.x, away.y, away.z]
    : [-away.x, -away.y, -away.z];
  const mk = (su: number, sv: number): [number, number, number] => {
    const w = base.clone().addScaledVector(u, su * L).addScaledVector(vv, sv * L);
    return [w.x, w.y, w.z];
  };
  return await createPanelFromVirtualFace([mk(-1, -1), mk(1, -1), mk(1, 1), mk(-1, 1)], nrm, L, 0);
}

// ── küçük yardımcılar ─────────────────────────────────────────────────────
function panelTs(s: Shape): number {
  const m = /(\d{10,})/.exec(s.id);
  return m ? parseInt(m[1], 10) : 0;
}
function safeClone(s: any): any { try { return s.clone(); } catch { return s; } }
function bb6(s: any): number[] | null {
  try { const b = s?.boundingBox?.bounds; return b ? [b[0][0], b[0][1], b[0][2], b[1][0], b[1][1], b[1][2]] : null; } catch { return null; }
}
function bbDelta(a: number[] | null, b: number[] | null): number {
  if (!a || !b) return Infinity;
  return a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
}
function aabbTouch(a: any, b: any): boolean {
  const A = bb6(a), B = bb6(b);
  if (!A || !B) return true;
  return A[0] <= B[3] + 0.5 && B[0] <= A[3] + 0.5 &&
         A[1] <= B[4] + 0.5 && B[1] <= A[4] + 0.5 &&
         A[2] <= B[5] + 0.5 && B[2] <= A[5] + 0.5;
}
function thinAxis(s: any): THREE.Vector3 {
  const b = bb6(s);
  if (!b) return new THREE.Vector3(0, 0, 1);
  const sx = b[3] - b[0], sy = b[4] - b[1], sz = b[5] - b[2];
  if (sx <= sy && sx <= sz) return new THREE.Vector3(1, 0, 0);
  if (sy <= sx && sy <= sz) return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}
function coplanarThin(a: any, b: any): boolean {
  const ta = thinAxis(a), tb = thinAxis(b);
  return Math.abs(ta.dot(tb)) > 0.9;
}
function edgeWithinFace(aSolid: any, bSolid: any, bThinAxis?: THREE.Vector3): boolean {
  const tB = bThinAxis ?? thinAxis(bSolid);
  const bB = bb6(bSolid), bA = bb6(aSolid);
  if (!bB || !bA) return false;
  // A'nın tB eksenindeki TAM aralığı (yalnızca merkez değil): dönmüş panelin
  // merkezi açı büyüdükçe kayar ve B'nin kalınlık slab'ından çıkar — ama kenarı
  // hâlâ yüzeye değer. Merkez yerine AABB köşelerinin tB üzerindeki izdüşüm
  // aralığını kullan: A'nın herhangi bir parçası B'nin slab'ına giriyorsa,
  // A'nın kenarı B'nin yüzeyine değiyor demektir.
  const aCorners = [
    [bA[0], bA[1], bA[2]], [bA[3], bA[1], bA[2]],
    [bA[0], bA[4], bA[2]], [bA[3], bA[4], bA[2]],
    [bA[0], bA[1], bA[5]], [bA[3], bA[1], bA[5]],
    [bA[0], bA[4], bA[5]], [bA[3], bA[4], bA[5]],
  ];
  let aMin = Infinity, aMax = -Infinity;
  for (const c of aCorners) {
    const p = tB.x * c[0] + tB.y * c[1] + tB.z * c[2];
    if (p < aMin) aMin = p;
    if (p > aMax) aMax = p;
  }
  const d0 = tB.x * bB[0] + tB.y * bB[1] + tB.z * bB[2];
  const d1 = tB.x * bB[3] + tB.y * bB[4] + tB.z * bB[5];
  const bMin = Math.min(d0, d1), bMax = Math.max(d0, d1);
  // A'nın aralığı B'nin slab'ıyla örtüşüyorsa kenar-yüzey teması var.
  return aMax >= bMin - 2 && aMin <= bMax + 2;
}
function panelThinAxisWorld(att: PanelAttachment, steps: TransformStep[]): THREE.Vector3 {
  const n0 = new THREE.Vector3(...(att.vf.normal as [number, number, number])).normalize();
  if (!steps.length) return n0;
  const { quat } = composeSteps(steps, att.vf);
  return n0.clone().applyQuaternion(quat).normalize();
}
