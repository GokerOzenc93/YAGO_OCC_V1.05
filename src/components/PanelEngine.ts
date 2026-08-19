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

  // PARENT (küp) yerel bbox'u — panel-yerel çerçevede (dünya = yerel + parentPos,
  // panel rotation=0). Referans uzatması bu hacme kırpılır → dışarı taşma olmaz.
  // Küpün kendi rotation/scale'i uygulanır (öteleme parentPos ile sadeleşir).
  let parentLocalBox: { min: [number, number, number]; max: [number, number, number] } | undefined;
  try {
    const pg: any = (parentFresh as any).geometry;
    if (pg) {
      pg.computeBoundingBox?.();
      const pbb = pg.boundingBox;
      if (pbb) {
        const pquat = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(parentFresh.rotation[0], parentFresh.rotation[1], parentFresh.rotation[2], 'XYZ')
        );
        const pscl = new THREE.Vector3(parentFresh.scale[0], parentFresh.scale[1], parentFresh.scale[2]);
        const pmtx = new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 0), pquat, pscl);
        const mn = new THREE.Vector3(Infinity, Infinity, Infinity);
        const mx = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        for (const cx of [pbb.min.x, pbb.max.x])
          for (const cy of [pbb.min.y, pbb.max.y])
            for (const cz of [pbb.min.z, pbb.max.z]) {
              const v = new THREE.Vector3(cx, cy, cz).applyMatrix4(pmtx);
              mn.min(v); mx.max(v);
            }
        parentLocalBox = { min: [mn.x, mn.y, mn.z], max: [mx.x, mx.y, mx.z] };
      }
    }
  } catch { /* kırpma bilgisi yoksa referans yine çalışır, sadece kırpma atlanır */ }

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

        // YÜZ EXTRUDE: panel artık DOĞRU ÇERÇEVEDE (VF'den üretildi + transform
        // işlendi). Saklı extrudeSteps varsa aynı çerçevede uygulanır — panel
        // tıklanan yüzden büyür/küçülür ve her rebuild'de KORUNUR. Adımın yüz
        // verisi (normal/merkez/samplePoint) tıklama anında bu çerçevede
        // yakalandığı için eşleşme birebir tutar; taban ARTIK origin kutusu
        // DEĞİL → panel "alakasız yere" ışınlanmaz.
        let dimsUpdate: { width: number; height: number; depth: number } | null = null;
        const extrudeSteps = (panel.parameters as any)?.extrudeSteps;
        if (Array.isArray(extrudeSteps) && extrudeSteps.length > 0) {
          try {
            const { applyExtrudeSteps } = await import('./FaceExtrudeService');
            // CANLI REFERANS bağlamı: panelin dünya offset'i (=parentPos, çünkü
            // aşağıda position:parentPos, rotation:0 yazılır) + referans şeklin
            // GÜNCEL geometrisi için taze shapes anlık görüntüsü.
            const ext = await applyExtrudeSteps(rp, extrudeSteps, {
              panelWorldOffset: parentPos,
              shapes: useAppStore.getState().shapes,
              parentLocalBox,
            });
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
            }
          } catch (err) {
            console.error('[YAGO][MOTOR] extrude adımı hatası:', panel.id,
              (err as any)?.message || String(err));
          }
        }

        const geometry = convertReplicadToThreeGeometry(rp);
        updateShape(panel.id, {
          geometry,
          position: parentPos,
          rotation: [0, 0, 0],
          replicadShape: rp,
          // Boyutlar yalnız extrude uygulandıysa güncellenir (editör W/H/T doğru
          // göstersin); aksi halde parameters'a dokunulmaz.
          ...(dimsUpdate ? { parameters: { ...panel.parameters, ...dimsUpdate } } : {}),
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

  // ═══════════════════════════════════════════════════════════════════════
  // AŞAMA 4: REFERANS-KARDEŞ BİRLEŞİM KESİMİ (butt/gönye) — SON KATILAR ÜZERİNDE.
  //
  // KÖK NEDEN ("referans verince paneller iç içe geçiyor"): Referans düzlem
  // kesimi (FaceExtrudeService) hedef paneli referans YÜZEYE getirir, ama iki
  // panelin ÖRTÜŞEN hacmini (köşe bandı) kaldırmaz. Bu çıkarmayı extrude adımının
  // İÇİNDE yapmak GÜVENİLMEZDİR: buildAndWrite panelleri ÖNCELİK sırasında üretir;
  // hedef (öncelik-önce) referanstan ÖNCE üretildiği için referans panelin katısı
  // o an ESKİ/KISA olabiliyor. Üstteki panel referansa kırpılınca ayak izi kalkar
  // ve referans panel SONRADAN tam boya BÜYÜR → adım içindeki çıkarma boşa gider,
  // paneller iç içe kalır ("panel yokmuş gibi davranıyor").
  //
  // Çözüm: TÜM paneller (AŞAMA 3) üretildikten SONRA, referans-kardeş çakışmasını
  // burada SON katılar üzerinde temizle. Referans panel artık son (tam) halinde
  // olduğundan çıkarma DOĞRU hacmi kaldırır → temiz birleşim, iç içe geçme yok.
  // Semantik: hedef, açıkça referansladığı panele DAYANIR (öncelikten bağımsız).
  //
  //   • Bu GLOBAL otomatik kardeş kesimi DEĞİLDİR; yalnız kullanıcının kurduğu
  //     referans bağı olan panellerde çalışır.
  //   • Referans KÜP ise (type!=='panel') atlanır → küp referansı davranışı
  //     (düzlem kesimi + parent kırpma) aynen korunur, regresyon yok.
  //   • Çakışma yoksa (dokunma / açılı temas) boolean cut NO-OP'tur (değişim=0)
  //     → döndürme senaryosunu bozmaz.
  //   • Çerçeve: tüm paneller parent-yerel (position=parentPos, rotation=0) →
  //     katılar aynı koordinatta; doğrudan cut geçerli.
  //
  // KESİM YÖNÜ = ÖNCELİK (dominant yüze göre): Örtüşmeyi HER ZAMAN DÜŞÜK öncelikli
  // panelden kaldırırız; YÜKSEK öncelikli panel dokunulmadan tam boyunda kalır.
  //   • Neden: kullanıcı önce tepe panelini (sıra 1) attı → o baskındır. Tepe,
  //     referansladığı dominant yüze (ör. x=478) kadar TAM uzanmalı; komşunun
  //     kalınlığı (18mm) kadar KISALMAMALI. Kısalan taraf, düşük öncelikli komşu
  //     olmalı (onun köşesi budanır → dominant yüzde temiz butt birleşimi).
  //   • Önceki hata: her zaman HEDEFTEN referans katısını çıkarıyordu; hedef
  //     yüksek öncelikli olduğunda onu 18mm kısaltıyordu. Artık öncelik belirler.
  //   • Öncelik = VF'nin store.virtualFaces indeksidir (küçük indeks = önce =
  //     yüksek öncelik) → orderOf().
  try {
    const afterShapes = useAppStore.getState().shapes;
    const builtSolid = new Map<string, any>();      // SON (değişmez) üretilmiş katılar
    const bboxOf = new Map<string, { min: THREE.Vector3; max: THREE.Vector3 }>();
    for (const s of afterShapes) {
      if (s.type === 'panel' && (s as any).replicadShape) {
        builtSolid.set(s.id, (s as any).replicadShape);
        // Kaba örtüşme ön-filtresi için bbox (tüm paneller parent-yerel, aynı çerçeve).
        const g: any = (s as any).geometry;
        if (g) {
          g.computeBoundingBox?.();
          if (g.boundingBox) bboxOf.set(s.id, { min: g.boundingBox.min.clone(), max: g.boundingBox.max.clone() });
        }
      }
    }

    // GENEL KARDEŞ BİRLEŞİM (dominant YÜZEY DÜZLEMİ): referans olsun olmasın,
    // temas eden her panel çiftinde öncelik uygulanır. Yüksek öncelikli (küçük
    // orderOf = önce yerleştirilen = dominant) panel dokunulmaz; düşük öncelikli
    // komşu, dominantın TEMAS YÜZÜNÜN düzlemine kadar DÜZ KISALTILIR — çentik/L
    // OLUŞMAZ ("paneller şekil almasın").
    //   • Gövde kesimi (lo.cut(hi)) dominant KISA olduğunda L bırakır. Onun
    //     yerine dominantın yüzünü SONSUZ DÜZLEM alıp yarı-uzay kutusuyla düz
    //     keseriz → lo, o düzlemde biter (temiz butt, rektangüler kalır).
    //   • DİKLİK KAPISI: yalnız kalınlık ekseni FARKLI (birbirine dik) panellerde
    //     uygulanır; paralel/koplanar (yan yana / üst üste) komşular kesilmez.
    //   • bbox örtüşmesi yoksa çift atlanır (hız). Tümü parent-yerel çerçevede.
    const { draw } = await import('replicad');
    const boxSolid = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): any =>
      draw().movePointerTo([x0, y0]).lineTo([x1, y0]).lineTo([x1, y1]).lineTo([x0, y1]).close()
        .sketchOnPlane().extrude(z1 - z0).translate(0, 0, z0);

    const eps = 0.5;
    const bboxOverlap = (a: string, b: string): boolean => {
      const ba = bboxOf.get(a), bb = bboxOf.get(b);
      if (!ba || !bb) return true;
      return ba.min.x <= bb.max.x + eps && ba.max.x + eps >= bb.min.x
          && ba.min.y <= bb.max.y + eps && ba.max.y + eps >= bb.min.y
          && ba.min.z <= bb.max.z + eps && ba.max.z + eps >= bb.min.z;
    };

    // Öncelik sırasına diz (yüksek öncelik önce).
    const ordered = children
      .filter(p => builtSolid.has(p.id))
      .sort((a, b) => orderOf(a) - orderOf(b));

    const notched = new Map<string, any>();           // düşük panel id → güncel katı
    const AX = ['x', 'y', 'z'] as const;

    for (let i = 0; i < ordered.length; i++) {
      const hi = ordered[i];
      const hiB = bboxOf.get(hi.id);
      if (!hiB) continue;
      const hiExt = [hiB.max.x - hiB.min.x, hiB.max.y - hiB.min.y, hiB.max.z - hiB.min.z];
      const tHi = hiExt.indexOf(Math.min(...hiExt));  // dominantın kalınlık ekseni
      const A = AX[tHi];
      const hiMin = hiB.min[A], hiMax = hiB.max[A], cHi = (hiMin + hiMax) / 2;

      for (let j = i + 1; j < ordered.length; j++) {
        const lo = ordered[j];
        if (!bboxOverlap(hi.id, lo.id)) continue;
        const loB = bboxOf.get(lo.id);
        if (!loB) continue;
        const loExt = [loB.max.x - loB.min.x, loB.max.y - loB.min.y, loB.max.z - loB.min.z];
        const tLo = loExt.indexOf(Math.min(...loExt));
        if (tLo === tHi) continue;                     // DİKLİK KAPISI: paralel → kesme
        const loSolid = notched.get(lo.id) ?? builtSolid.get(lo.id);
        if (!loSolid) continue;

        const cLo = (loB.min[A] + loB.max[A]) / 2;
        const BIG = 100000, m = 10;
        // Kesilecek yarı-uzay: dominantın temas yüzünün ÖTE tarafını kaldır.
        let a0: number, a1: number, faceVal: number;
        if (cLo <= cHi) { a0 = hiMin; a1 = hiMin + BIG; faceVal = hiMin; } // lo, hi'nin −'inde → hiMin ötesi
        else            { a0 = hiMax - BIG; a1 = hiMax; faceVal = hiMax; } // lo, hi'nin +'ında → hiMax berisi
        // Diğer iki eksende lo'nun TÜM kesitini kapsa → uç düz kesilir (çentik yok).
        const rx: [number, number] = [loB.min.x - m, loB.max.x + m];
        const ry: [number, number] = [loB.min.y - m, loB.max.y + m];
        const rz: [number, number] = [loB.min.z - m, loB.max.z + m];
        if (A === 'x') { rx[0] = a0; rx[1] = a1; }
        else if (A === 'y') { ry[0] = a0; ry[1] = a1; }
        else { rz[0] = a0; rz[1] = a1; }

        try {
          const box = boxSolid(rx[0], rx[1], ry[0], ry[1], rz[0], rz[1]);
          const cut = loSolid.cut(box);                // dominant yüzey düzleminde DÜZ kes
          notched.set(lo.id, cut);
          console.log('[YAGO][MOTOR] kardeş kısaltma (dominant yüzey düzlemi): kesilen(düşük)=', lo.id,
            'dominant(yüksek)=', hi.id, 'eksen=', A, 'yüz=', faceVal.toFixed(1));
        } catch (err) {
          console.warn('[YAGO][MOTOR] kardeş kısaltma başarısız, atlandı:', lo.id, hi.id,
            (err as any)?.message || String(err));
        }
      }
    }
    // Kısaltılan (düşük öncelikli) panelleri tek seferde yaz.
    for (const [id, solid] of notched) {
      const geometry = convertReplicadToThreeGeometry(solid);
      updateShape(id, { geometry, replicadShape: solid } as any);
    }
  } catch (err) {
    console.error('[YAGO][MOTOR] AŞAMA 4 kardeş birleşim kesimi hatası:',
      (err as any)?.message || String(err));
  }
}


// ── küçük yardımcılar ─────────────────────────────────────────────────────
function panelTs(s: Shape): number {
  const m = /(\d{10,})/.exec(s.id);
  return m ? parseInt(m[1], 10) : 0;
}
