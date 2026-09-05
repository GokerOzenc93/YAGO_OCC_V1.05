import * as THREE from 'three';
import { useAppStore, type Shape, type VirtualFace } from '../store';
import { vfPlaneBasis, type RotateStep } from './PanelRotateService';
import type { TransformStep } from './PanelTransformService';

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
function resolveRefTranslateDelta(
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

// ── Rebuild orkestrasyonu ─────────────────────────────────────────────────
const inFlight = new Set<string>();
const pending = new Set<string>();

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
  const hasTransform = (s: Shape): boolean => {
    const t = (s.parameters as any)?.transformSteps;
    if (Array.isArray(t) && t.length > 0) return true;
    const rs = (s.parameters as any)?.rotateSteps;
    return Array.isArray(rs) && rs.length > 0;
  };
  const hasExtrude = (s: Shape): boolean => {
    const es = (s.parameters as any)?.extrudeSteps;
    return Array.isArray(es) && es.length > 0;
  };
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
      // Sabit paneller önce (0), taşınan/büyütülen paneller sonra (1).
      const aMoved = hasTransform(a) || hasExtrude(a);
      const bMoved = hasTransform(b) || hasExtrude(b);
      if (aMoved !== bMoved) return aMoved ? 1 : -1;
      return orderOf(a) - orderOf(b);
    });
  if (children.length === 0) return;

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
  let currentVfs: VirtualFace[] = recalculateVirtualFacesForShape(
    parentFresh, useAppStore.getState().virtualFaces, useAppStore.getState().shapes, 'all'
  );

  const buildPanel = async (panel: Shape, vfsIn: VirtualFace[]): Promise<void> => {
    try {
      const att = getPanelAttachment(panel, vfsIn);
      if (!att) return;
      const thickness = parseFloat((panel.parameters as any)?.panelThickness) || 18;
      const steps = getUnifiedSteps(panel);
      // Panel VF'sinden gerçek boyutta üretilir (expand=0, doğru 18mm kalınlık).
      let rp = await createPanelFromVirtualFace(att.vf.vertices, att.vf.normal, thickness, 0);
      if (!rp) return;
      // Adımlar (move/rotate) sırayla uygulanır — çember döndürünce panel döner.
      const { ops } = composeSteps(steps, att.vf);
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
          rp = rp.translate(d.x, d.y, d.z);
        } else {
          rp = rp.rotate(op.deg, [op.pivot.x, op.pivot.y, op.pivot.z], [op.axis.x, op.axis.y, op.axis.z]);
        }
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

      const geometry = convertReplicadToThreeGeometry(rp);
      const paramPatch: any = {};
      if (dimsUpdate) Object.assign(paramPatch, dimsUpdate);
      if (resolvedStepsUpdate) paramPatch.extrudeSteps = resolvedStepsUpdate;
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
