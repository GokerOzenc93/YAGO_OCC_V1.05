import * as THREE from 'three';
import { useAppStore } from '../store';
import { applyRotateSteps, type RotateStep } from './PanelRotateService';

const rebuildInFlight = new Set<string>();
// Rebuild sürerken gelen istekler SESSİZCE DÜŞÜRÜLMEMELİ: aksi halde açı
// editi/silmesi hiç işlenmez ve panel "ölçüsünü güncellememeye başlar".
// Bunun yerine bekleyen istek işaretlenir ve mevcut tur biter bitmez EN GÜNCEL
// store durumuyla bir tur daha koşulur.
const rebuildPending = new Set<string>();
// Kuyruk, kademeli tetiklemelerde (state değişimi → yeni istek → tekrar tur)
// kendi kendini besleyip UI'ı kilitleyebilecek sonsuz rebuild döngüsüne
// dönüşmesin diye ardışık tekrar sayısı sınırlanır. Sınır aşılırsa uyarı
// loglanır ve kuyruk boşaltılır; bir sonraki DIŞ istek sayacı sıfırlar.
const rebuildRerunCount = new Map<string, number>();
const MAX_QUEUED_RERUNS = 2;

function geoAxesSize(geo: THREE.BufferGeometry) {
  const pos = geo.getAttribute('position');
  if (!pos) return null;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const axes = [{ i: 0, v: size.x }, { i: 1, v: size.y }, { i: 2, v: size.z }].sort((a, b) => a.v - b.v);
  return { axes, size };
}

// Referans küpü, panelin YEREL (döndürülmemiş) çerçevesine taşır: paneli
// döndürmek yerine küpü TERS döndürüp kesişiriz. Böylece panel geometrisi düz
// kalır (önizleme ve ölçü stabil), ama kırpma panelin gerçek açısına göre
// doğru olur. Adımlar TERS sırada ve negatif açıyla, parent-yerel pivotlar
// etrafında uygulanır — bu, ileri rotasyon transform'unun tam tersidir.
// (Matematiksel olarak: clip_local = S ∩ R⁻¹·C, her parentPos için geçerli.)
//
// !!! KRİTİK — REPLICAD TRANSFORM TÜKETİMİ !!!
// replicad'de Shape.rotate/translate/scale/mirror, YENİ şekli döndürürken
// ORİJİNALİN OCC nesnesini SİLER (kaynakta `this.delete()`). Yani buraya
// parent.replicadShape doğrudan verilirse İLK döndürmede parent küpün şekli
// kalıcı olarak yok edilir; store'daki sarmalayıcı ölü nesneye işaret eder ve
// sonraki HER işlem (açı editi, silme, hatta yeni panel döndürme) bozulur.
// Bu yüzden zincire girmeden önce MUTLAKA clone alınır — zincirin ara
// sonuçları bizim malımızdır, onların tüketilmesi sorun değildir.
function inverseRotateReplicadByLocalSteps(
  shape: any,
  steps: RotateStep[],
  parentPos: [number, number, number]
): any {
  let r = typeof shape?.clone === 'function' ? shape.clone() : shape;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (Math.abs(step.value) < 1e-6) continue;
    const pivotLocal: [number, number, number] = [
      step.pivot[0] - parentPos[0],
      step.pivot[1] - parentPos[1],
      step.pivot[2] - parentPos[2],
    ];
    const axis: [number, number, number] =
      step.axis === 'x' ? [1, 0, 0] : step.axis === 'y' ? [0, 1, 0] : [0, 0, 1];
    r = r.rotate(-step.value, pivotLocal, axis);
  }
  return r;
}

// İLERİ rotasyon: bir replicad katısını, panelin rotate adımlarını SIRAYLA ve
// POZİTİF açıyla uygulayarak dünya (parent-yerel) çerçevesine taşır. Döndürülmüş
// bir KARDEŞ panelin replicadShape'i kendi döndürülmemiş çerçevesinde durduğu
// için, kesici olarak kullanılmadan önce bu fonksiyonla gerçek (dönmüş) dünya
// konumuna getirilmelidir — aksi halde kesim panelin ESKİ (dönmemiş) yerinde
// yapılır ve komşu panelden saçma büyüklükte parça koparır.
function forwardRotateReplicadByLocalSteps(
  shape: any,
  steps: RotateStep[],
  parentPos: [number, number, number]
): any {
  // KRİTİK: replicad transformları orijinali SİLER — kardeşin store'daki
  // replicadShape'ini yok etmemek için önce clone (bkz. yukarıdaki not).
  let r = typeof shape?.clone === 'function' ? shape.clone() : shape;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (Math.abs(step.value) < 1e-6) continue;
    const pivotLocal: [number, number, number] = [
      step.pivot[0] - parentPos[0],
      step.pivot[1] - parentPos[1],
      step.pivot[2] - parentPos[2],
    ];
    const axis: [number, number, number] =
      step.axis === 'x' ? [1, 0, 0] : step.axis === 'y' ? [0, 1, 0] : [0, 0, 1];
    r = r.rotate(step.value, pivotLocal, axis);
  }
  return r;
}

// Kardeş paneli, kesilecek panelin ÇERÇEVESİNE taşır:
// 1) Kardeş dönmüşse: kendi adımlarıyla İLERİ döndür → gerçek dünya konumu.
// 2) Kesilecek panel dönmüşse: onun adımlarıyla TERS döndür → panelin yerel
//    (döndürülmemiş) çerçevesi. Böylece boolean kesim her iki panelin de gerçek
//    açısına göre doğru yerde yapılır (parent küp kesişimindeki desenle aynı).
function siblingCutterInPanelFrame(
  sib: any,
  panelSteps: RotateStep[],
  parentPos: [number, number, number]
): any | null {
  let cutter = sib?.replicadShape;
  if (!cutter) return null;
  const sibSteps: RotateStep[] = sib.parameters?.rotateSteps || [];
  if (sibSteps.length > 0) {
    cutter = forwardRotateReplicadByLocalSteps(cutter, sibSteps, parentPos);
  }
  if (panelSteps.length > 0) {
    cutter = inverseRotateReplicadByLocalSteps(cutter, panelSteps, parentPos);
  }
  return cutter;
}

// ─── BROAD-PHASE ÖN ELEME ────────────────────────────────────────────────
// OCC boolean'ları ana thread'de çalışır ve teğet/çakışık yüzeylerde patolojik
// derecede yavaşlayabilir (UI donar, fare kasar). Bu yüzden her kardeş kesimi
// öncesi UCUZ bir geometrik test yapılır; hacimsel çakışma imkânsızsa boolean
// hiç çağrılmaz. Yalnızca DEĞEN (penetrasyonsuz) paneller de elenir — temas,
// kesim gerektirmez ve tam çakışık yüzey boolean'ı en yavaş/kırılgan durumdur.

function worldAABBOfPanel(p: any): THREE.Box3 | null {
  if (!p?.geometry) return null;
  const pos = p.geometry.getAttribute('position');
  if (!pos) return null;
  const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...(p.position as [number, number, number])),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rotation[0], p.rotation[1], p.rotation[2], 'XYZ')),
    new THREE.Vector3(...((p.scale || [1, 1, 1]) as [number, number, number]))
  );
  return box.applyMatrix4(m);
}

// İki dünya-AABB'si en az minPen kadar İÇ İÇE geçiyor mu? (sadece değme → false)
function aabbsPenetrate(a: THREE.Box3, b: THREE.Box3, minPen = 0.01): boolean {
  return (
    a.min.x < b.max.x - minPen && a.max.x > b.min.x + minPen &&
    a.min.y < b.max.y - minPen && a.max.y > b.min.y + minPen &&
    a.min.z < b.max.z - minPen && a.max.z > b.min.z + minPen
  );
}

// Sanal yüzeyden kurulan (dönmemiş) slab'ın konservatif dünya kutusu:
// VF köşe kutusu + kalınlık payı. Broad-phase için yeterli.
function worldAABBFromVF(
  vf: any,
  thickness: number,
  parentPos: [number, number, number]
): THREE.Box3 | null {
  if (!vf?.vertices || vf.vertices.length < 3) return null;
  const box = new THREE.Box3();
  for (const v of vf.vertices) {
    box.expandByPoint(new THREE.Vector3(v[0] + parentPos[0], v[1] + parentPos[1], v[2] + parentPos[2]));
  }
  box.expandByScalar(thickness + 0.5);
  return box;
}

// DÖNMÜŞ panel için kesin slab-bandı testi: dönmüş panel, VF düzleminin
// döndürülmüş kopyası boyunca [düzlem - kalınlık, düzlem] bandında yaşar.
// Kardeşin dünya kutusunun 8 köşesi tamamen bandın dışındaysa kesişim
// imkânsızdır → boolean atlanır. 8 nokta çarpımı — bedava.
function siblingIntersectsRotatedSlab(
  sib: any,
  vf: any,
  thickness: number,
  steps: RotateStep[],
  parentPos: [number, number, number]
): boolean {
  const sibBox = worldAABBOfPanel(sib);
  if (!sibBox || !vf?.vertices || vf.vertices.length < 1) return true; // test edilemiyorsa güvenli taraf: kes

  // Bileşik rotasyon kuaterniyonu (adımlar sırayla, premultiply)
  const q = new THREE.Quaternion();
  for (const step of steps) {
    const axisVec = new THREE.Vector3(
      step.axis === 'x' ? 1 : 0,
      step.axis === 'y' ? 1 : 0,
      step.axis === 'z' ? 1 : 0
    );
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(axisVec, (step.value * Math.PI) / 180));
  }
  const nWorld = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize().applyQuaternion(q);

  // VF'nin ilk köşesini dünyaya taşı ve adımları pivotlar etrafında ileri uygula
  let p = new THREE.Vector3(
    vf.vertices[0][0] + parentPos[0],
    vf.vertices[0][1] + parentPos[1],
    vf.vertices[0][2] + parentPos[2]
  );
  for (const step of steps) {
    const pivot = new THREE.Vector3(...step.pivot);
    const axisVec = new THREE.Vector3(
      step.axis === 'x' ? 1 : 0,
      step.axis === 'y' ? 1 : 0,
      step.axis === 'z' ? 1 : 0
    );
    const sq = new THREE.Quaternion().setFromAxisAngle(axisVec, (step.value * Math.PI) / 180);
    p = pivot.clone().add(p.sub(pivot).applyQuaternion(sq));
  }
  const d0 = nWorld.dot(p);
  const bandMin = d0 - thickness - 0.5;
  const bandMax = d0 + 0.5;

  const cs = [
    new THREE.Vector3(sibBox.min.x, sibBox.min.y, sibBox.min.z),
    new THREE.Vector3(sibBox.max.x, sibBox.min.y, sibBox.min.z),
    new THREE.Vector3(sibBox.min.x, sibBox.max.y, sibBox.min.z),
    new THREE.Vector3(sibBox.max.x, sibBox.max.y, sibBox.min.z),
    new THREE.Vector3(sibBox.min.x, sibBox.min.y, sibBox.max.z),
    new THREE.Vector3(sibBox.max.x, sibBox.min.y, sibBox.max.z),
    new THREE.Vector3(sibBox.min.x, sibBox.max.y, sibBox.max.z),
    new THREE.Vector3(sibBox.max.x, sibBox.max.y, sibBox.max.z),
  ];
  let allBelow = true, allAbove = true;
  for (const c of cs) {
    const d = nWorld.dot(c);
    if (d > bandMin) allBelow = false;
    if (d < bandMax) allAbove = false;
  }
  return !(allBelow || allAbove);
}

// OCC boolean kesişimi, TAM ÇAKIŞIK/teğet yüzeylerde sayısal olarak kırılgandır.
// Dönmüş panelde slab'ın dış yüzü küp duvar düzlemiyle çakışıktır ve pivot da
// genelde tam bu düzlem üzerindedir (köşe/merkez seçimi) — bazı açı değerlerinde
// kesişim fırlatır. Fırlatınca panel uzatılamaz ve "ölçü güncellenmiyor" olarak
// görünür. Merdiven: (1) doğrudan dene, (2) küpü 1 mikron kaydırıp dene (tam
// çakışıklığı kırar, mobilya ölçeğinde görünmez), (3) slab'ı hafif farklı
// genişletmeyle yeniden kurup dene (kenar çakışıklıklarını kırar).
async function intersectWithRetries(
  slab: any,
  cube: any,
  rebuildSlab: (expand: number) => Promise<any>,
  planeExpand: number,
  performBooleanIntersection: (a: any, b: any) => Promise<any>
): Promise<any | null> {
  try {
    return await performBooleanIntersection(slab, cube);
  } catch (e1) {
    console.warn('[RotateRebuild] intersection attempt 1 failed, retrying with nudged cube:', e1);
  }
  try {
    // KRİTİK: translate orijinali SİLER — cube, rotateSteps boşken doğrudan
    // parent.replicadShape olabilir ve 3. deneme de cube'u tekrar kullanır.
    // Bu yüzden kaydırılmış kopya clone üzerinden üretilir.
    const nudged = (typeof cube?.clone === 'function' ? cube.clone() : cube).translate(0.001, 0.001, 0.001);
    return await performBooleanIntersection(slab, nudged);
  } catch (e2) {
    console.warn('[RotateRebuild] intersection attempt 2 (nudged cube) failed, retrying with re-expanded slab:', e2);
  }
  try {
    const slab2 = await rebuildSlab(Math.max(0, planeExpand - 0.37));
    if (slab2) return await performBooleanIntersection(slab2, cube);
  } catch (e3) {
    console.error('[RotateRebuild] intersection attempt 3 (re-expanded slab) failed:', e3);
  }
  return null;
}

// Parent (referans küp) en büyük kenarı — döndürülmüş paneli kübü aşacak kadar
// büyütmek için güvenli marj.
function parentMaxDim(parent: any): number {
  const geo = parent?.geometry;
  if (geo) {
    const s = geoAxesSize(geo);
    if (s) return Math.max(s.size.x, s.size.y, s.size.z);
  }
  const p = parent?.parameters || {};
  const m = Math.max(parseFloat(p.width) || 0, parseFloat(p.height) || 0, parseFloat(p.depth) || 0);
  return m > 0 ? m : 2000;
}


export async function rebuildPanelsForParent(parentShapeId: string): Promise<void> {
  if (rebuildInFlight.has(parentShapeId)) {
    rebuildPending.add(parentShapeId);
    console.info('[PanelRebuild] rebuild already in flight for', parentShapeId, '— queued a re-run');
    return;
  }
  rebuildInFlight.add(parentShapeId);
  try {
    const store = useAppStore.getState();
    const parent = store.shapes.find(s => s.id === parentShapeId);
    if (!parent) return;

    const { recalculateVirtualFacesForShape } = await import('./VirtualFaceUpdateService');
    const { createPanelFromVirtualFace, convertReplicadToThreeGeometry, performBooleanCut, createReplicadBox, performBooleanIntersection } = await import('./ReplicadService');
    const { rebuildFromSteps } = await import('./FaceExtrudeService');

    const vfOrder = new Map<string, number>();
    store.virtualFaces.forEach((vf, idx) => vfOrder.set(vf.id, idx));

    const siblingsOrdered = store.shapes
      .filter(s => s.type === 'panel' &&
        s.parameters?.parentShapeId === parentShapeId &&
        s.parameters?.virtualFaceId)
      .sort((a, b) => {
        const ai = vfOrder.get(a.parameters.virtualFaceId) ?? Infinity;
        const bi = vfOrder.get(b.parameters.virtualFaceId) ?? Infinity;
        return ai - bi;
      });

    let workingShapes: any[] = store.shapes.filter(
      s => !(s.type === 'panel' && s.parameters?.parentShapeId === parentShapeId)
    );
    let workingVirtualFaces = store.virtualFaces;

    const builtVfIds = new Set<string>();

    for (const panel of siblingsOrdered) {
      const currentVfId = panel.parameters.virtualFaceId;
      const otherShapeVfs = workingVirtualFaces.filter(f => f.shapeId !== parentShapeId);
      const activeSiblingVfs = workingVirtualFaces.filter(f =>
        f.shapeId === parentShapeId &&
        (f.id === currentVfId || builtVfIds.has(f.id) || !siblingsOrdered.some(s => s.parameters?.virtualFaceId === f.id))
      );
      const filteredForRecalc = [...otherShapeVfs, ...activeSiblingVfs];

      const freshFaces = recalculateVirtualFacesForShape(parent, filteredForRecalc, workingShapes);
      const freshById = new Map(freshFaces.map(f => [f.id, f]));
      workingVirtualFaces = workingVirtualFaces.map(f => freshById.get(f.id) || f);
      builtVfIds.add(currentVfId);

      const vf = freshFaces.find(f => f.id === currentVfId);
      if (!vf || vf.vertices.length < 3) {
        workingShapes = [...workingShapes, panel];
        continue;
      }

      try {
        const thickness = panel.parameters?.depth || 18;

        // Döndürülmüş panelde slab'ı düzleminde büyüt; aşağıda (ters döndürülmüş)
        // parent kesişimi paneli açıya göre tam duvara kadar büyütüp küçültür.
        // Yalnızca parent kesişimi yapılacaksa uygula, yoksa dev panel oluşurdu.
        const rotateSteps: RotateStep[] = panel.parameters?.rotateSteps || [];
        const isRotated = rotateSteps.length > 0;
        const parentPos: [number, number, number] = [...parent.position] as [number, number, number];
        // Panel döndürülmüşse büyüme/kırpma "Ana yüze eşitle" düğmesine BAĞLI
        // OLMAMALI: dönünce otomatik olarak kübe göre uzayıp kırpılsın. Bu yüzden
        // parent kesişimi, döndürülmüş panelde parentFaceShape bayrağı kapalı olsa
        // da (parent.replicadShape varsa) devreye girer.
        const willIntersectParent = !!(parent.replicadShape && (vf.parentFaceShape || isRotated));
        const planeExpand = (isRotated && willIntersectParent) ? parentMaxDim(parent) : 0;

        let rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, thickness, planeExpand);
        if (!rp) {
          workingShapes = [...workingShapes, panel];
          continue;
        }

        const parentHasFillets = !!(parent.fillets && parent.fillets.length > 0 && parent.replicadShape);

        if (willIntersectParent) {
          // Küpü panelin yerel (döndürülmemiş) çerçevesine taşı: paneli
          // döndürmek yerine küpü ters döndürüp kesişiriz → geometri düz kalır
          // (önizleme/ölçü stabil), kırpma açıya göre doğru olur.
          const cube = rotateSteps.length > 0
            ? inverseRotateReplicadByLocalSteps(parent.replicadShape, rotateSteps, parentPos)
            : parent.replicadShape;
          console.info('[RotateRebuild] intersecting panel', panel.id, {
            steps: rotateSteps.length, planeExpand,
          });
          const intersected = await intersectWithRetries(
            rp, cube,
            (expand: number) => createPanelFromVirtualFace(vf.vertices, vf.normal, thickness, expand),
            planeExpand,
            performBooleanIntersection
          );
          if (intersected) {
            rp = intersected;
          } else {
            console.error('[RotateRebuild] ALL intersection attempts failed for panel', panel.id,
              '— falling back to unexpanded slab (panel will NOT auto-extend this round)');
            // GÜVENLİK: büyütülmüş slab kırpılamadıysa dev panel olarak kalmasın —
            // normal (büyütmesiz) sanal yüzeyle yeniden kur.
            if (planeExpand > 0) {
              try {
                rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, thickness, 0);
              } catch (err2) {
                console.error('Fallback panel rebuild (no expand) also failed:', err2);
              }
            }
          }
        }

        // DÖNMÜŞ PANEL KARDEŞ KESİMİ: Dönmüş panel yukarıda kübe kadar
        // uzatıldığı için kardeş panellerin İÇİNDEN geçebilir; bu hem görsel
        // çakışma yaratır hem de kardeşlerin sanal yüzeylerini taşan kısma göre
        // saçma şekilde kırptırırdı. Küpteki desenle aynı: kardeş geometrisi
        // panelin yerel çerçevesine taşınıp (ileri + ters rotasyon) kesilir.
        // Dönmüş panel otomatik uzayan taraf olduğu için TÜM kardeşlere yol
        // verir — henüz rebuild edilmemiş (sırada sonra gelen) kardeşler dahil.
        if (isRotated) {
          const rebuiltIds = new Set(
            workingShapes
              .filter(s => s.type === 'panel' && s.parameters?.parentShapeId === parentShapeId)
              .map(s => s.id)
          );
          const rotCutters = [
            ...workingShapes.filter(
              s => s.type === 'panel' &&
                s.parameters?.parentShapeId === parentShapeId &&
                s.id !== panel.id &&
                s.replicadShape
            ),
            ...siblingsOrdered.filter(
              s => s.id !== panel.id && !rebuiltIds.has(s.id) && s.replicadShape
            ),
          ];
          for (const sib of rotCutters) {
            // BROAD-PHASE: kardeş, dönmüş slab bandına girmiyorsa (yalnızca
            // değiyorsa/uzağındaysa) boolean HİÇ çağrılmaz — hem hız hem de
            // teğet-yüzey boolean donmalarından kaçınma.
            if (!siblingIntersectsRotatedSlab(sib, vf, thickness, rotateSteps, parentPos)) continue;
            try {
              const cutter = siblingCutterInPanelFrame(sib, rotateSteps, parentPos);
              if (cutter) rp = await performBooleanCut(rp, cutter);
            } catch (err) {
              console.error('Failed to subtract sibling from rotated panel:', err);
            }
          }
        }

        if (vf.parentFaceShape) {
          if (!parent.replicadShape) {
            const subs = parent.subtractionGeometries || [];
            for (const sub of subs) {
              if (!sub || !sub.parameters) continue;
              const w = parseFloat(sub.parameters.width);
              const h = parseFloat(sub.parameters.height);
              const d = parseFloat(sub.parameters.depth);
              if (isNaN(w) || isNaN(h) || isNaN(d) || w <= 0 || h <= 0 || d <= 0) continue;
              try {
                const margin = 0.5;
                const cuttingBox = await createReplicadBox({ width: w + margin, height: h + margin, depth: d + margin });
                rp = await performBooleanCut(
                  rp, cuttingBox,
                  undefined, sub.relativeOffset,
                  undefined, sub.relativeRotation || [0, 0, 0],
                  undefined, sub.scale || [1, 1, 1]
                );
              } catch (err) {
                console.error('Failed to apply subtractor cut to parent-face-shape panel:', err);
              }
            }
          }

          // isRotated ise kardeşler yukarıda zaten (frame-düzeltmeli) kesildi;
          // burada tekrar kesme. Değilse: kardeş DÖNMÜŞ olabilir — ham
          // replicadShape'i dönmemiş çerçevede durduğundan doğrudan kesici
          // olarak kullanmak kesimi yanlış yerde yapar (panelin eski konumunda
          // koca dilim koparırdı). siblingCutterInPanelFrame bunu düzeltir.
          if (!isRotated) {
            const panelBox = worldAABBFromVF(vf, thickness, parentPos);
            const siblingPanelShapes = workingShapes.filter(
              s => s.type === 'panel' &&
                s.parameters?.parentShapeId === parentShapeId &&
                s.id !== panel.id &&
                s.replicadShape
            );
            for (const sib of siblingPanelShapes) {
              // BROAD-PHASE: hacimsel iç içe geçme yoksa (sadece değme dahil)
              // boolean atlanır — teğet yüzey kesimleri hem gereksiz hem OCC
              // için en yavaş/kırılgan durumdur.
              const sibBox = worldAABBOfPanel(sib);
              if (panelBox && sibBox && !aabbsPenetrate(panelBox, sibBox)) continue;
              try {
                const cutter = siblingCutterInPanelFrame(sib, rotateSteps, parentPos);
                if (cutter) rp = await performBooleanCut(rp, cutter);
              } catch (err) {
                console.error('Failed to subtract sibling panel from parent-face-shape panel:', err);
              }
            }
          }
        }

        let geometry = convertReplicadToThreeGeometry(rp);
        const r = geoAxesSize(geometry);
        const paramUpdates: Record<string, any> = { ...panel.parameters, baseReplicadShape: rp };
        if (r) {
          const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
          const [def, alt] = [pa[0], pa[1]];
          const s = [r.size.x, r.size.y, r.size.z];
          paramUpdates.width = s[def];
          paramUpdates.height = s[alt];
        }
        let rebuiltPanel: any = { ...panel, geometry, replicadShape: rp, parameters: paramUpdates };

        // Apply extrude steps immediately so subsequent panels see the correct
        // (shortened) geometry as an obstacle during their VF recalculation.
        const steps = panel.parameters?.extrudeSteps || [];
        if (steps.length > 0) {
          const captured: Partial<typeof rebuiltPanel> = {};
          const captureUpdate = (id: string, updates: any) => {
            if (id === panel.id) Object.assign(captured, updates);
          };
          try {
            await rebuildFromSteps(rebuiltPanel, steps, captureUpdate as any);
            if (captured.geometry || captured.replicadShape || captured.parameters) {
              rebuiltPanel = {
                ...rebuiltPanel,
                ...captured,
                parameters: { ...rebuiltPanel.parameters, ...(captured.parameters || {}) },
              };
            }
          } catch (err) {
            console.error('Failed to apply extrude steps during rebuild for panel', panel.id, err);
          }
        }

        // Rotasyonu transform olarak uygula (geometri düz kalır; kırpma yukarıda
        // küpü ters döndürerek açıya göre yapıldı). Sonraki kardeşler bu paneli
        // engel olarak görür.
        if (rotateSteps.length > 0) {
          const basePos: [number, number, number] = panel.parameters?.baseRotatePosition ?? [...panel.position];
          const baseRot: [number, number, number] = panel.parameters?.baseRotateRotation ?? [...panel.rotation];
          const { position: newPos, rotation: newRot } = applyRotateSteps(basePos, baseRot, rotateSteps);
          rebuiltPanel = {
            ...rebuiltPanel,
            position: newPos,
            rotation: newRot,
            parameters: { ...rebuiltPanel.parameters, baseRotatePosition: basePos, baseRotateRotation: baseRot, rotateSteps },
          };
        }

        workingShapes = [...workingShapes, rebuiltPanel];
      } catch (err) {
        console.error('Failed to rebuild panel', panel.id, err);
        workingShapes = [...workingShapes, panel];
      }
    }

    useAppStore.setState(state => {
      const rebuiltById = new Map<string, any>();
      for (const s of workingShapes) {
        if (s.type === 'panel' && s.parameters?.parentShapeId === parentShapeId) rebuiltById.set(s.id, s);
      }
      return {
        shapes: state.shapes.map(s => rebuiltById.get(s.id) || s),
        virtualFaces: workingVirtualFaces,
      };
    });
  } finally {
    rebuildInFlight.delete(parentShapeId);
    if (rebuildPending.has(parentShapeId)) {
      rebuildPending.delete(parentShapeId);
      const n = (rebuildRerunCount.get(parentShapeId) || 0) + 1;
      rebuildRerunCount.set(parentShapeId, n);
      if (n <= MAX_QUEUED_RERUNS) {
        // Mevcut tur sürerken gelen istek(ler) için en güncel durumla bir tur daha.
        await rebuildPanelsForParent(parentShapeId);
      } else {
        console.warn('[PanelRebuild] queued re-run cap reached for', parentShapeId,
          '— possible rebuild cascade, skipping further automatic re-runs');
        rebuildRerunCount.delete(parentShapeId);
      }
    } else {
      rebuildRerunCount.delete(parentShapeId);
    }
  }
}
