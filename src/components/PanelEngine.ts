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

  // SIRA: panel önceliği, VF'sinin store.virtualFaces içindeki indeksinden.
  const freshVirtualFaces = useAppStore.getState().virtualFaces;
  const vfOrder = new Map<string, number>();
  freshVirtualFaces.forEach((f, i) => vfOrder.set(f.id, i));
  const orderOf = (s: Shape): number => {
    const vfId = (s.parameters as any)?.virtualFaceId;
    const idx = vfId != null ? vfOrder.get(vfId) : undefined;
    return idx != null ? idx : 1e9 + panelTs(s) / 1e13;
  };
  const children = shapes
    .filter(s => s.type === 'panel' && (s.parameters as any)?.parentShapeId === parentShapeId)
    .sort((a, b) => orderOf(a) - orderOf(b));
  if (children.length === 0) return;

  const parentPos: [number, number, number] = [...(parentFresh.position as any)] as any;

  // ═══════════════════════════════════════════════════════════════════════
  // YENİ TEMİZ MOTOR — SADECE ÜRETİM, KESİM YOK
  // Kullanıcı isteği: dönme kesim/kural mekanizması tamamen kaldırıldı. Yeni
  // yaklaşım sonra bağlanacak. Şimdilik: her panel VF'sinden üretilir, adımlar
  // (move VEYA rotate) uygulanır, geometri yazılır. Çember döndürünce panel
  // döner — komşu kesimi, grow, dominant düzlem, K6 küp kesişimi YOK.
  // ═══════════════════════════════════════════════════════════════════════

  // AŞAMA 1: VF'leri güncel geometri + kardeşlerle yenile (bölge otoritesi).
  //          (Ayak izi/serbest bölge katmanı korunur — döndürme arayüzü ve
  //           çemberler bu VF'ler üzerinden çalışır.)
  const vfsPre: VirtualFace[] = recalculateVirtualFacesForShape(
    parentFresh, freshVirtualFaces, shapes, 'all'
  );

  // Ön-üretim: adım-uygulanmış geometriyi yaz ki VF regen taşınmış ayak izini
  // görsün (move'da komşu bölgesi güncellensin). Kesim yok.
  const buildAndWrite = async (vfsIn: VirtualFace[]) => {
    for (const panel of children) {
      try {
        const att = getPanelAttachment(panel, vfsIn);
        if (!att) continue;
        const thickness = parseFloat((panel.parameters as any)?.panelThickness) || 18;
        const steps = getUnifiedSteps(panel);
        // Panel VF'sinden gerçek boyutta üretilir (expand=0, doğru 18mm kalınlık).
        let rp = await createPanelFromVirtualFace(att.vf.vertices, att.vf.normal, thickness, 0);
        if (!rp) continue;
        // Adımlar (move/rotate) sırayla uygulanır — çember döndürünce panel döner.
        const { ops } = composeSteps(steps, att.vf);
        for (const op of ops) {
          if (op.kind === 'translate') rp = rp.translate(op.d.x, op.d.y, op.d.z);
          else rp = rp.rotate(op.deg, [op.pivot.x, op.pivot.y, op.pivot.z], [op.axis.x, op.axis.y, op.axis.z]);
        }
        const geometry = convertReplicadToThreeGeometry(rp);
        updateShape(panel.id, {
          geometry,
          position: parentPos,
          rotation: [0, 0, 0],
          replicadShape: rp,
        } as any);
      } catch (err) {
        console.error('[YAGO][MOTOR] panel üretim hatası:', panel.id,
          (err as any)?.message || String(err));
      }
    }
  };

  await buildAndWrite(vfsPre);

  // AŞAMA 2: paneller güncel konumda → VF'ler doğru ayak izleriyle yenilenir.
  const freshShapes = useAppStore.getState().shapes;
  const vfs: VirtualFace[] = recalculateVirtualFacesForShape(
    parentFresh, useAppStore.getState().virtualFaces, freshShapes, 'all'
  );
  if (updateVirtualFace) {
    for (const f of vfs) updateVirtualFace(f.id, f);
  }

  // AŞAMA 3: yeni VF'lerle son üretim (bölge güncellemesi geometriye yansısın).
  await buildAndWrite(vfs);
}


// ── küçük yardımcılar ─────────────────────────────────────────────────────
function panelTs(s: Shape): number {
  const m = /(\d{10,})/.exec(s.id);
  return m ? parseInt(m[1], 10) : 0;
}
