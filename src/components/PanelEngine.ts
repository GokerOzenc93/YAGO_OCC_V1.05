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
  // TEŞHİS: sahnedeki TÜM paneller ve parent bağları — neden tek panel toplanıyor?
  const allPanels = shapes.filter(s => s.type === 'panel');
  console.log('[YAGO][CHILDREN] parent=', parentShapeId.slice(-6),
    'toplananN=', children.length, '/ sahnedekiN=', allPanels.length,
    '| tümPaneller=', allPanels.map(p => `${p.id.slice(-6)}[parent=${String((p.parameters as any)?.parentShapeId || '?').slice(-6)}]`).join(' '));
  if (children.length === 0) return;
  console.log('[YAGO][SIRA]', parentShapeId, 'panel sırası=',
    children.map(c => `${c.id.slice(-6)}(vf#${orderOf(c) < 1e9 ? orderOf(c) : '?'})`).join(' → '));

  const parentPos: [number, number, number] = [...(parentFresh.position as any)] as any;
  // Grow için ebeveyn en büyük boyutu (dönmüş panel bu kadar genişletilip
  // döndürülür ki açılı boşluğa erişsin; fazlalık K6 küp kesişimiyle kırpılır).
  const parentMax = Math.max(
    parseFloat((parentFresh.parameters as any)?.width) || 0,
    parseFloat((parentFresh.parameters as any)?.height) || 0,
    parseFloat((parentFresh.parameters as any)?.depth) || 0
  ) || 2000;

  const builtSolid = new Map<string, any>();
  const builtGrown = new Map<string, any>();
  const meta = new Map<string, { att: PanelAttachment; thickness: number; isRotated: boolean; steps: TransformStep[] }>();

  // Katı üretimi (taban + adımlar). writeEarly=true ise adım-uygulanmış
  // geometri store'a hemen yazılır (VF regen taşınmış ayak izlerini görsün).
  // KRİTİK SADELEŞTİRME: move ve rotate AYNI yoldan geçer. Panel hangi adımı
  // (move/rotate) taşırsa taşısın, GERÇEK katısından (expand=0, doğru kalınlık)
  // üretilir, adımlar uygulanır. Dönmüş panele ÖZEL grow/band/expand YOK —
  // bunlar iç içe geçme ve fazla kalınlık hatalarının kaynağıydı. Move zaten
  // böyle çalışıp doğru sonuç veriyordu; rotate de aynısını yapar.
  const buildSolids = async (vfsIn: VirtualFace[], writeEarly: boolean) => {
    builtSolid.clear(); builtGrown.clear(); meta.clear();
    for (const panel of children) {
      try {
        const att = getPanelAttachment(panel, vfsIn);
        if (!att) { if (!writeEarly) console.warn('[YAGO][MOTOR] bağ kaydı yok, panel atlandı:', panel.id); continue; }
        const thickness = parseFloat((panel.parameters as any)?.panelThickness) || 18;
        const steps = getUnifiedSteps(panel);
        const isRotated = steps.some(s => s.type === 'rotate');
        const { ops } = composeSteps(steps, att.vf);
        const applyOps = (solid: any) => {
          let s = solid;
          for (const op of ops) {
            if (op.kind === 'translate') s = s.translate(op.d.x, op.d.y, op.d.z);
            else s = s.rotate(op.deg, [op.pivot.x, op.pivot.y, op.pivot.z], [op.axis.x, op.axis.y, op.axis.z]);
          }
          return s;
        };

        // GROW & SHRINK (dönmüş panel): Panel VF'nin düz izdüşümü kadar
        // üretilip döndürülürse, eğik hipotenüs düz projeksiyondan uzun
        // olduğundan panel açılı boşluğu DOLDURAMAZ ("ölçüsü büyümüyor"). Bu
        // yüzden dönmüş panelin tabanı planeExpand ile BÜYÜK üretilir (SINIR
        // DİKDÖRTGENİ — her zaman düzlemsel, extrude doğru 18mm kalınlık verir);
        // döndürülür; sonra K6 küp kesişimi + komşu kesimleri onu açıya göre
        // ilk engele kadar KIRPAR. Düz panel expand almaz (highlight=panel).
        const expand = isRotated ? parentMax : 0;
        let rp = await createPanelFromVirtualFace(att.vf.vertices, att.vf.normal, thickness, expand);
        if (!rp) continue;
        rp = applyOps(rp);

        // Kesici havuzu: dönmüş panelde grow'lu katı komşuları fazla keser;
        // gerçek boyut (expand=0) ayrı üretilir. İkinci üretim başarısız olursa
        // (dejenere VF vb.) grow'lu katıya düşülür — üretim HİÇ patlamasın.
        let cutterSolid = rp;
        if (isRotated) {
          try {
            const real = await createPanelFromVirtualFace(att.vf.vertices, att.vf.normal, thickness, 0);
            if (real) cutterSolid = applyOps(real);
          } catch (e2) {
            console.warn('[YAGO][MOTOR] gerçek kesici üretilemedi, grow kullanılıyor:', panel.id);
            cutterSolid = rp;
          }
        }

        builtSolid.set(panel.id, cutterSolid);
        builtGrown.set(panel.id, rp);
        meta.set(panel.id, { att, thickness, isRotated, steps });
        if (writeEarly) {
          const gPre = convertReplicadToThreeGeometry(cutterSolid);
          updateShape(panel.id, { geometry: gPre, position: parentPos, rotation: [0, 0, 0] } as any);
        }
      } catch (err) {
        console.error('[YAGO][MOTOR] katı üretim hatası:', panel.id,
          'mesaj=', (err as any)?.message || String(err),
          'isRotated=', (getUnifiedSteps(panel) || []).some(s => s.type === 'rotate'));
      }
    }
  };

  // ── AŞAMA 1 (ön-tur): ESKİ VF'lerle katıları üret, HAM geometrileri erken
  // yaz. Amaç: VF regen'in taşınmış/dönmüş ayak izlerini görmesi (move/rotate
  // yalnız adım yazar, geometri yazmaz — "taşınca komşular güncellenmiyor").
  const vfsPre: VirtualFace[] = recalculateVirtualFacesForShape(
    parentFresh, freshVirtualFaces, shapes, 'all'
  );
  await buildSolids(vfsPre, true);

  // ── AŞAMA 2: BÖLGE OTORİTESİ — paneller artık güncel konumda; VF'ler doğru
  // ayak izleriyle kırpılır ve store'a yazılır.
  const freshShapes = useAppStore.getState().shapes;
  let vfs: VirtualFace[] = recalculateVirtualFacesForShape(
    parentFresh, useAppStore.getState().virtualFaces, freshShapes, 'all'
  );
  if (updateVirtualFace) {
    for (const f of vfs) updateVirtualFace(f.id, f);
  }

  // ── AŞAMA 3: katıları YENİ VF'lerden YENİDEN üret. KRİTİK (off-by-one
  // fix'i): önceki yapı katıları eski-VF turundan bırakıyordu; recalc'ın
  // ürettiği yeni bölgeler ancak BİR SONRAKİ dalgada katıya dönüşüyordu —
  // "taşıyınca iç içe, geri alınca kısalıyor" tam bu bir-dalga gecikmesiydi.
  // Aynı dalga içinde yeni bölgelerle yeniden üretim döngüyü kapatır.
  await buildSolids(vfs, false);

  // ── FAZ B: ÖNCELİK KESİMİ + EBEVEYN SINIRI ───────────────────────────────
  // Öncelik = yerleşme sırası (children zaten UI sırasına göre). Her panel,
  // kendinden ÖNCE gelen (üst sıra) kardeşlerin GERÇEK katısıyla kesilir →
  // dönmüş bir üst-sıra panel, alt sıradaki panelleri kendisiyle SINIRLAR
  // (dominant panel dönük olsa bile alttakini keser). Kesici havuzu (builtSolid)
  // GERÇEK katıdır (grow değil) — grow'lu kesici alttakini fazla keserdi.
  // Kesilen panel ise grow'lu (builtGrown) başlar ki dönünce uzayıp komşuya
  // dayanabilsin. Sonra K6 küple sınırlanır.
  for (let pi = 0; pi < children.length; pi++) {
    const panel = children[pi];
    const m = meta.get(panel.id);
    let rp = builtGrown.get(panel.id) ?? builtSolid.get(panel.id);
    if (!m || !rp) continue;
    const { isRotated } = m;
    try {
      // ÖNCELİK KESİMİ: kendinden önce gelen kardeşlerle kesilir. Kesici olarak
      // dönmüş komşunun GROW'lu katısı kullanılır — dönmüş panel ince (18mm)
      // olduğundan gerçek katısı kesilen paneli yalnız ince bir dilimde keser
      // (yetersiz, iç içe kalır). Grow'lu katı eğik hat boyunca TAM keser;
      // fazlalık sonra K6 küp kesişimiyle temizlenir. Düz komşu gerçek katısıyla
      // keser (grow'a gerek yok, zaten çakışır).
      for (let si = 0; si < pi; si++) {
        const sib = children[si];
        const sm = meta.get(sib.id);
        if (!sm) continue;
        const cutter = sm.isRotated
          ? (builtGrown.get(sib.id) ?? builtSolid.get(sib.id))  // dönmüş: grow (tam keser)
          : builtSolid.get(sib.id);                              // düz: gerçek
        if (!cutter) continue;
        if (!aabbTouch(rp, cutter)) continue;
        const before = bb6(rp);
        console.log('[YAGO][KESİM-GEO]', panel.id.slice(-6), 'kesilen=[', (before || []).map(x => x.toFixed(0)).join(','),
          '] <-', sib.id.slice(-6), sm.isRotated ? '(dönmüş-grow)' : '(düz)',
          'kesici=[', (bb6(cutter) || []).map(x => x.toFixed(0)).join(','), ']');
        try {
          const cut = await performBooleanCut(safeClone(rp), safeClone(cutter));
          const ab = bb6(cut);
          const alive = ab && (ab[3] - ab[0]) > 1 && (ab[4] - ab[1]) > 1 && (ab[5] - ab[2]) > 1;
          const d = bbDelta(before, ab);
          if (d > 0.001 && alive) rp = cut;
          console.log('[YAGO][KESİM]', panel.id.slice(-6), '<-', sib.id.slice(-6),
            sm.isRotated ? '(dönmüş)' : '(düz)', 'değişim=', d.toFixed(1), alive ? '' : '(BOŞ)');
        } catch (e) { console.warn('[YAGO][MOTOR] kesim hatası:', panel.id.slice(-6), '<-', sib.id.slice(-6), e); }
      }

      // K6: EBEVEYN SINIRI — panel küple kesişimlenir (grow fazlalığı + küp
      // dışına taşan kısım kırpılır). Kesişim paneli yok ederse uygulanmaz.
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

      const geometry = convertReplicadToThreeGeometry(rp);
      updateShape(panel.id, {
        geometry,
        position: parentPos,
        rotation: [0, 0, 0],
        replicadShape: rp,
      } as any);
      const fb = bb6(rp);
      const minDim = fb ? Math.min(fb[3] - fb[0], fb[4] - fb[1], fb[5] - fb[2]) : -1;
      console.log('[YAGO][MOTOR] panel yeniden üretildi:', panel.id,
        'adımN=', m.steps.length, isRotated ? 'DÖNMÜŞ' : 'düz',
        'kalınlık(min boyut)=', minDim.toFixed(1), '(beklenen', m.thickness, ')');
    } catch (err) {
      console.error('[YAGO][MOTOR] panel rebuild hatası, önceki geometri korunuyor:', panel.id, err);
    }
  }
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
  let d = 0;
  for (let i = 0; i < 6; i++) d += Math.abs(a[i] - b[i]);
  return d;
}
function aabbTouch(a: any, b: any): boolean {
  const ba = bb6(a), bb = bb6(b);
  if (!ba || !bb) return false;
  const eps = 1;
  return ba[0] <= bb[3] + eps && ba[3] >= bb[0] - eps &&
         ba[1] <= bb[4] + eps && ba[4] >= bb[1] - eps &&
         ba[2] <= bb[5] + eps && ba[5] >= bb[2] - eps;
}
