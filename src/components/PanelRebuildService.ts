import * as THREE from 'three';
import { useAppStore } from '../store';
import { applyRotateSteps, vfPlaneBasis, type RotateStep } from './PanelRotateService';
import { applyTransformSteps, type TransformStep } from './PanelTransformService';

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
    const axis: [number, number, number] = (step as any).axisVec
      ? (step as any).axisVec
      : (step.axis === 'x' ? [1, 0, 0] : step.axis === 'y' ? [0, 1, 0] : [0, 0, 1]);
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
    const axis: [number, number, number] = (step as any).axisVec
      ? (step as any).axisVec
      : (step.axis === 'x' ? [1, 0, 0] : step.axis === 'y' ? [0, 1, 0] : [0, 0, 1]);
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
  parentPos: [number, number, number],
  panelPos?: [number, number, number]
): any | null {
  let cutter = sib?.replicadShape;
  if (!cutter) return null;
  // Klon şart: aşağıdaki translate/rotate zinciri replicad'de orijinal OCC
  // nesnesini kalıcı siler — kardeşin saklanan katısı bozulmamalı.
  cutter = typeof cutter.clone === 'function' ? cutter.clone() : cutter;
  const sibSteps: RotateStep[] = sib.parameters?.rotateSteps || [];
  if (sibSteps.length > 0) {
    cutter = forwardRotateReplicadByLocalSteps(cutter, sibSteps, parentPos);
  }
  // TAŞIMA FARKINDALIĞI: dönüş adımları pozun DÖNÜŞ kaynaklı kısmını üretir;
  // kalan fark saf ötelemedir (move adımları / elle taşıma). Kesici, kardeşin
  // GERÇEK konumuna ötelenir ve panelin kendi ötelemesi düşülür — aksi halde
  // taşınmış dominant kardeş, sonrakileri ESKİ yerinde "keser" ve yeni yerinde
  // kısaltma hiç görünmezdi (kök neden buydu).
  const poseFromRot = (steps: RotateStep[]): [number, number, number] => {
    if (!steps.length) return parentPos;
    const r = applyRotateSteps(parentPos, [0, 0, 0], steps);
    return r.position;
  };
  const sibExp = poseFromRot(sibSteps);
  const panExp = poseFromRot(panelSteps);
  const pPos = panelPos ?? parentPos;
  const dx = (sib.position[0] - sibExp[0]) - (pPos[0] - panExp[0]);
  const dy = (sib.position[1] - sibExp[1]) - (pPos[1] - panExp[1]);
  const dz = (sib.position[2] - sibExp[2]) - (pPos[2] - panExp[2]);
  if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-6) {
    cutter = cutter.translate(dx, dy, dz);
  }
  if (panelSteps.length > 0) {
    cutter = inverseRotateReplicadByLocalSteps(cutter, panelSteps, parentPos);
  }
  return cutter;
}

// ─── GÖNYE (AÇILI) BİRLEŞİM YARDIMCILARI ─────────────────────────────────
// Dönmüş bir panele değen düz panellerin kalınlık ucu kare kalırsa eğimli
// yüzeyle arasında kama boşluğu oluşur. Çözüm: düz panel dönmüş paneli sanal
// yüzey engeli olarak GÖRMEZ (içinden/ötesine uzar), sonra dönmüş panelin
// temas yüzü düzleminden geçen dev bir YARIM-UZAY slabı ile kesilir → ucu
// eğimle birebir örtüşen tek parça panel. Gövde kesimi yerine yarım-uzay
// kullanılır çünkü düz panel dönmüş panelin arkasına taşarsa gövde kesimi
// paneli İKİ parçaya bölerdi.

function box3Corners(b: THREE.Box3): THREE.Vector3[] {
  return [
    new THREE.Vector3(b.min.x, b.min.y, b.min.z),
    new THREE.Vector3(b.max.x, b.min.y, b.min.z),
    new THREE.Vector3(b.min.x, b.max.y, b.min.z),
    new THREE.Vector3(b.max.x, b.max.y, b.min.z),
    new THREE.Vector3(b.min.x, b.min.y, b.max.z),
    new THREE.Vector3(b.max.x, b.min.y, b.max.z),
    new THREE.Vector3(b.min.x, b.max.y, b.max.z),
    new THREE.Vector3(b.max.x, b.max.y, b.max.z),
  ];
}

function compositeQuatFromSteps(steps: RotateStep[]): THREE.Quaternion {
  const q = new THREE.Quaternion();
  for (const step of steps) {
    const axisVec = new THREE.Vector3(
      step.axis === 'x' ? 1 : 0,
      step.axis === 'y' ? 1 : 0,
      step.axis === 'z' ? 1 : 0
    );
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(axisVec, (step.value * Math.PI) / 180));
  }
  return q;
}

// Dönmüş panelin dünya uzayındaki slab bandı: normal = VF normalinin bileşik
// rotasyonla döndürülmüşü; bant sınırları panelin GERÇEK geometrisinin bu
// normale izdüşümünden AMPİRİK olarak ölçülür — ekstrüzyon yönü varsayımı yok.
function rotatedPanelWorldBand(
  R: any,
  vfR: any,
  stepsR: RotateStep[]
): { nW: THREE.Vector3; dMin: number; dMax: number } | null {
  if (!R?.geometry || !vfR?.normal) return null;
  const pos = R.geometry.getAttribute('position');
  if (!pos) return null;
  const nW = new THREE.Vector3(vfR.normal[0], vfR.normal[1], vfR.normal[2])
    .normalize()
    .applyQuaternion(compositeQuatFromSteps(stepsR));
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...(R.position as [number, number, number])),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(R.rotation[0], R.rotation[1], R.rotation[2], 'XYZ')),
    new THREE.Vector3(...((R.scale || [1, 1, 1]) as [number, number, number]))
  );
  let dMin = Infinity, dMax = -Infinity;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
    const d = nW.dot(tmp);
    if (d < dMin) dMin = d;
    if (d > dMax) dMax = d;
  }
  if (!isFinite(dMin) || !isFinite(dMax)) return null;
  return { nW, dMin, dMax };
}

// Düz paneli (rp) dönmüş kardeşe DOĞRU yönlü bir şeritle uzatır ve dönmüş
// kardeşin temas yüzü düzleminde açılı keser. Sanal yüzey en yakın temas
// çizgisinde durduğu için (bölge seçimi korunur), aradaki kama hacmi bu
// şeritle kazanılır; yarım-uzay kesimi şeridi tam gönye düzlemine biçer.
// Dönüş: kesilmiş (veya temas yoksa DEĞİŞMEMİŞ) rp; null → belirsiz durum,
// çağıran gövde kesimine düşmeli.
async function cutByRotatedSiblingMiter(
  rp: any,
  panelS: any,
  rotatedSib: any,
  vfS: any,
  thicknessS: number,
  parentPos: [number, number, number],
  parentMax: number,
  workingVirtualFaces: any[],
  createPanelFromVirtualFace: (verts: any, normal: any, t: number, e: number) => Promise<any>,
  performBooleanCut: (a: any, b: any, ...rest: any[]) => Promise<any>,
  parentReplicad: any,
  performBooleanIntersection: (a: any, b: any) => Promise<any>
): Promise<any | null> {
  const vfR = workingVirtualFaces.find(f => f.id === rotatedSib.parameters?.virtualFaceId);
  if (!vfR) return null;
  const stepsR: RotateStep[] = rotatedSib.parameters?.rotateSteps || [];
  const band = rotatedPanelWorldBand(rotatedSib, vfR, stepsR);
  if (!band) return null;
  const { nW, dMin, dMax } = band;

  // TAŞIMA FARKINDALIĞI: Panelin geometri çerçevesi, GÜNCEL panel.position
  // üzerinden dünyaya taşınır (taşınmamış panelde parentPos ile aynıdır).
  // Böylece taşınmış panellerde gönye/şerit doğru yerde hesaplanır.
  const posS: [number, number, number] = [panelS.position[0], panelS.position[1], panelS.position[2]];

  // İLİŞKİ TESTİ: Panel bu dönmüş kardeşle "ilişkili" mi? Taşınmamış (VF'nin
  // asıl yerindeki) VEYA taşınmış konumdaki kutusu banda değiyorsa ilişkilidir.
  // Böylece dönmüş panele teğet bir panel TAŞINDIĞINDA da ilişki korunur ve
  // aşağıdaki şerit, açılan boşluğu kapatacak şekilde paneli yeniden uzatır —
  // panel her konumda teğetliğini ve ölçüsünü günceller.
  const touchesBand = (basePos: [number, number, number]): boolean => {
    const box = worldAABBFromVF(vfS, thicknessS, basePos);
    if (!box) return true;
    let allBelow = true, allAbove = true;
    for (const c of box3Corners(box)) {
      const d = nW.dot(c);
      if (d > dMin - 0.5) allBelow = false;
      if (d < dMax + 0.5) allAbove = false;
    }
    return !(allBelow || allAbove);
  };
  if (!touchesBand(posS) && !touchesBand(parentPos)) return rp;

  // Düz panelin referans merkezi bandın hangi tarafında?
  const c = new THREE.Vector3();
  for (const v of vfS.vertices) {
    c.add(new THREE.Vector3(v[0] + posS[0], v[1] + posS[1], v[2] + posS[2]));
  }
  c.divideScalar(vfS.vertices.length);
  const dS = nW.dot(c);
  const dC = (dMin + dMax) / 2;
  // Merkez bandın içindeyse hangi yüze gönye yapılacağı belirsiz → gövde kesimi.
  if (Math.abs(dS - dC) <= (dMax - dMin) / 2) return null;

  const near = dS < dC ? dMin : dMax;                       // S'nin değdiği yüzün ofseti
  const away = dS < dC ? nW.clone() : nW.clone().negate();  // S'den uzağa bakan yön

  // ── YÖNLÜ ŞERİT UZATMASI ──
  // S'nin düzlemi içinde, R'nin düzlemine DOĞRU birim yön: nW'nin düzlem-içi
  // bileşeni, d'yi dS'den near'a taşıyan işaretle.
  const nS = new THREE.Vector3(vfS.normal[0], vfS.normal[1], vfS.normal[2]).normalize();
  const e = nW.clone().sub(nS.clone().multiplyScalar(nW.dot(nS)));
  if (e.length() < 0.05) return rp; // düzlemler ~paralel: yüz-yüze temas, gönye anlamsız
  e.normalize();
  // e boyunca hareket d'yi dS'den near'a taşımalı: işaretler uyuşmuyorsa çevir
  if (Math.sign(nW.dot(e)) !== Math.sign(near - dS)) e.negate();
  const u2 = e; // R'ye doğru
  const v2 = new THREE.Vector3().crossVectors(nS, u2).normalize();

  // VF köşelerini (u2, v2) tabanında kutula
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const v of vfS.vertices) {
    const w = new THREE.Vector3(v[0] + posS[0], v[1] + posS[1], v[2] + posS[2]).sub(c);
    const pu = w.dot(u2), pv = w.dot(v2);
    if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
    if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
  }

  // Aşma payı: panelin R'ye bakan kenarından bandın UZAK yüzüne kadar olan
  // GERÇEK mesafe ölçülür (panel taşınıp boşluk açıldıysa boşluk da dahil) +
  // kalınlığın eğime katkısı; u2 boyunca d-değişim hızına bölünür. Böylece
  // şerit her konumda temas düzlemini garanti aşar, yarım-uzay fazlasını biçer.
  const slopeRate = Math.max(0.15, Math.abs(nW.dot(u2)));
  const far = near === dMin ? dMax : dMin;
  const dEdgeFar = nW.dot(c.clone().addScaledVector(u2, maxU));
  const overshoot = Math.min(
    parentMax,
    (Math.abs(far - dEdgeFar) + thicknessS * Math.abs(nW.dot(nS))) / slopeRate + 5
  );
  // Şerit, VF'nin R'ye bakan (çapraz kırpılmış olabilecek) kenarını da örtsün
  const backlap = Math.min(maxU - minU, overshoot);

  const mkStrip = (su: number, sv: number): [number, number, number] => {
    const w = c.clone().addScaledVector(u2, su).addScaledVector(v2, sv);
    return [w.x - posS[0], w.y - posS[1], w.z - posS[2]];
  };
  const stripVerts: [number, number, number][] = [
    mkStrip(maxU - backlap, minV),
    mkStrip(maxU + overshoot, minV),
    mkStrip(maxU + overshoot, maxV),
    mkStrip(maxU - backlap, maxV),
  ];
  try {
    let strip = await createPanelFromVirtualFace(stripVerts, vfS.normal, thicknessS, 0);
    if (strip) {
      // Şerit küp duvarını aşmasın (özellikle R duvara yakınsa). Küp
      // parent çerçevesinde durur; panel taşınmışsa küpün KOPYASI panel
      // çerçevesine kaydırılır (clone şart: translate orijinali siler).
      if (parentReplicad) {
        try {
          const dx = parentPos[0] - posS[0], dy = parentPos[1] - posS[1], dz = parentPos[2] - posS[2];
          const cubeInPanelFrame = (Math.abs(dx) + Math.abs(dy) + Math.abs(dz)) > 1e-6
            ? parentReplicad.clone().translate(dx, dy, dz)
            : parentReplicad;
          strip = await performBooleanIntersection(strip, cubeInPanelFrame);
        } catch { /* opsiyonel */ }
      }
      rp = rp.fuse(strip);
    }
  } catch (err) {
    console.warn('[Miter] strip extension failed, proceeding with plain half-space cut:', err);
  }

  // ── YARIM-UZAY GÖNYE KESİMİ ──
  const p0 = c.clone().add(nW.clone().multiplyScalar(near - dS)); // merkezi yakın düzleme izdüşür
  const up = (Math.abs(away.y) > Math.abs(away.x) && Math.abs(away.y) > Math.abs(away.z))
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(away, up).normalize();
  const vv = new THREE.Vector3().crossVectors(away, u).normalize();
  const L = 3 * parentMax;
  const mk = (su: number, sv: number): [number, number, number] => {
    const w = p0.clone().addScaledVector(u, su * L).addScaledVector(vv, sv * L);
    return [w.x - posS[0], w.y - posS[1], w.z - posS[2]];
  };
  const verts: [number, number, number][] = [mk(-1, -1), mk(1, -1), mk(1, 1), mk(-1, 1)];

  // createPanelFromVirtualFace, verilen normalin EKSİ yönünde ekstrüde eder
  // (ReplicadService: extrude(-thickness)). Dolgunun +away tarafını (S'nin
  // ötesini) kaplaması için normal = -away verilir.
  const halfSpace = await createPanelFromVirtualFace(
    verts,
    [-away.x, -away.y, -away.z] as [number, number, number],
    3 * parentMax,
    0
  );
  if (!halfSpace) return null;
  return await performBooleanCut(rp, halfSpace);
}

// DÖNMÜŞ panelin (rp, kendi döndürülmemiş yerel çerçevesinde) bir kardeşin
// temas yüzü düzleminde kesilmesi. Gövde kesimi, dönmüş panel kardeşin
// İÇİNDEN geçtiğinde onu İKİ parçaya böler (uzak parça "hayalet panel" olarak
// görünür). Yarım-uzay kesimi tek parça bırakır ve iki dönmüş panel arasında
// da doğru gönye üretir. Düzlem, panelin GÜNCEL position/rotation değerleri
// üzerinden yerel çerçeveye taşınır — panel taşınmış olsa bile doğru çalışır.
// Dönüş: kesilmiş rp; null → belirsiz durum (merkez bandın içinde), çağıran
// gövde kesimine düşmeli.
async function cutRotatedPanelBySiblingHalfSpace(
  rp: any,
  panelS: any,
  sib: any,
  vfS: any,
  parentPos: [number, number, number],
  parentMax: number,
  workingVirtualFaces: any[],
  createPanelFromVirtualFace: (verts: any, normal: any, t: number, e: number) => Promise<any>,
  performBooleanCut: (a: any, b: any, ...rest: any[]) => Promise<any>
): Promise<any | null> {
  const vfSib = workingVirtualFaces.find(f => f.id === sib.parameters?.virtualFaceId);
  if (!vfSib) return null;
  const sibSteps: RotateStep[] = sib.parameters?.rotateSteps || [];
  const band = rotatedPanelWorldBand(sib, vfSib, sibSteps);
  if (!band) return null;
  const { nW, dMin, dMax } = band;

  // Panelin dünya merkezi: yerel VF merkezi, panelin GÜNCEL transformuyla
  // dünyaya taşınır (taşıma + dönme dahil, varsayım yok).
  const posS = new THREE.Vector3(panelS.position[0], panelS.position[1], panelS.position[2]);
  const qS = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(panelS.rotation[0], panelS.rotation[1], panelS.rotation[2], 'XYZ')
  );
  const cLocal = new THREE.Vector3();
  for (const v of vfS.vertices) cLocal.add(new THREE.Vector3(v[0], v[1], v[2]));
  cLocal.divideScalar(vfS.vertices.length);
  const cWorld = cLocal.clone().applyQuaternion(qS).add(posS);

  const dS = nW.dot(cWorld);
  const dC = (dMin + dMax) / 2;
  if (Math.abs(dS - dC) <= (dMax - dMin) / 2) return null; // belirsiz → gövde kesimi

  const near = dS < dC ? dMin : dMax;
  const awayW = dS < dC ? nW.clone() : nW.clone().negate();
  const p0w = cWorld.clone().add(nW.clone().multiplyScalar(near - dS));

  // Düzlemi panelin YEREL (döndürülmemiş geometri) çerçevesine taşı:
  // g = qS⁻¹ · (w − posS)
  const qInv = qS.clone().invert();
  const awayL = awayW.clone().applyQuaternion(qInv).normalize();
  const p0l = p0w.clone().sub(posS).applyQuaternion(qInv);

  const up = (Math.abs(awayL.y) > Math.abs(awayL.x) && Math.abs(awayL.y) > Math.abs(awayL.z))
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(awayL, up).normalize();
  const vv = new THREE.Vector3().crossVectors(awayL, u).normalize();
  const L = 3 * parentMax;
  const mk = (su: number, sv: number): [number, number, number] => {
    const w = p0l.clone().addScaledVector(u, su * L).addScaledVector(vv, sv * L);
    return [w.x, w.y, w.z];
  };
  const verts: [number, number, number][] = [mk(-1, -1), mk(1, -1), mk(1, 1), mk(-1, 1)];

  const halfSpace = await createPanelFromVirtualFace(
    verts,
    [-awayL.x, -awayL.y, -awayL.z] as [number, number, number],
    3 * parentMax,
    0
  );
  if (!halfSpace) return null;
  return await performBooleanCut(rp, halfSpace);
}

// Düz (dönmemiş) dominant kardeşin, düz bir paneli KENDİ TEMAS DÜZLEMİNDE
// yarım-uzayla kesmesi. KÖK NEDEN: kardeş katısı panelin TAM İÇİNE gömülüyse
// (hiçbir dış sınıra değmiyorsa) OCC gövde-kesimi "iç boşluk" üretemeyip kesimi
// SESSİZCE ATLAR — panel kısalmaz, iç içe geçme kalır. Yarım-uzay dolgusu
// panelin bir dış sınırına kadar uzandığından bu asla olmaz: kesim her konumda
// (kardeş üstte/altta/ortada) tek boolean'la temiz çalışır. Düzlem = kardeşin
// bu panele bakan yüzü; panel o düzlemin kardeş tarafında kalan kısmı silinir.
// Dönüş: kesilmiş rp | null (belirsiz: tek düzlemle ayrılamıyorsa → çağıran
// gövde kesimine düşer).
async function cutFlatPanelBySiblingHalfSpace(
  rp: any,
  panel: any,
  sib: any,
  vf: any,
  parentMax: number
): Promise<any | null> {
  try {
    const posP: [number, number, number] = [panel.position[0], panel.position[1], panel.position[2]];

    const sibBox = worldAABBOfPanel(sib);
    if (!sibBox) return null;
    const sc = new THREE.Vector3(); sibBox.getCenter(sc);
    const ss = new THREE.Vector3(); sibBox.getSize(ss);
    const sd = [ss.x, ss.y, ss.z];
    let ta = 0; for (let i = 1; i < 3; i++) if (sd[i] < sd[ta]) ta = i;
    const nAxis = new THREE.Vector3(ta === 0 ? 1 : 0, ta === 1 ? 1 : 0, ta === 2 ? 1 : 0);

    const pc = new THREE.Vector3();
    for (const v of vf.vertices) pc.add(new THREE.Vector3(v[0] + posP[0], v[1] + posP[1], v[2] + posP[2]));
    pc.divideScalar(vf.vertices.length);

    const sign = pc.clone().sub(sc).dot(nAxis) >= 0 ? 1 : -1;
    const away = nAxis.clone().multiplyScalar(-sign);
    const faceOffset = (ta === 0 ? ss.x : ta === 1 ? ss.y : ss.z) / 2;
    const p0 = sc.clone().addScaledVector(nAxis, sign * faceOffset);

    const up = (Math.abs(away.y) > Math.abs(away.x) && Math.abs(away.y) > Math.abs(away.z))
      ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(away, up).normalize();
    const vv = new THREE.Vector3().crossVectors(away, u).normalize();
    const L = 3 * parentMax;
    const mk = (su: number, sv: number): [number, number, number] => {
      const w = p0.clone().addScaledVector(u, su * L).addScaledVector(vv, sv * L);
      return [w.x - posP[0], w.y - posP[1], w.z - posP[2]];
    };
    const verts: [number, number, number][] = [mk(-1, -1), mk(1, -1), mk(1, 1), mk(-1, 1)];
    const { createPanelFromVirtualFace, performBooleanCut } = await import('./ReplicadService');
    const halfSpace = await createPanelFromVirtualFace(
      verts, [-away.x, -away.y, -away.z] as [number, number, number], 3 * parentMax, 0
    );
    if (!halfSpace) return null;
    return await performBooleanCut(rp, halfSpace);
  } catch (err) {
    console.warn('[FlatHalfSpace] cut failed, falling back to body cut:', err);
    return null;
  }
}

// ─── PİVOT YENİDEN BAĞLAMA ───────────────────────────────────────────────
// Döndürme adımlarının pivotları, adım anında parent kutusuna ORANSAL olarak
// kaydedilir (pivotFrac). Parent yeniden boyutlandığında mutlak dünya pivotu
// bayatlar: slab yeni yüz konumuna taşınırken ters döndürülmüş küp eski pivot
// etrafında döner ve kesişim kayar → panelde boşluk. Bu fonksiyon pivotları
// GÜNCEL parent kutusundan yeniden türetir; pivotFrac'sız eski adımlar mutlak
// pivotla aynen kullanılır (geriye uyumlu).
function effectiveRotateSteps(
  steps: RotateStep[],
  parent: any,
  parentPos: [number, number, number],
  vf: any
): RotateStep[] {
  if (!steps.length) return steps;

  // ASIL ÇIPA: panelin GÜNCEL sanal yüzeyi. Yakalamadaki kuralın birebir
  // aynısıyla (vfPlaneBasis + dikdörtgen oranları) pivot yeniden türetilir.
  let vfCtx: { c: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; n: THREE.Vector3; minU: number; su: number; minV: number; sv: number } | null = null;
  if (vf?.vertices?.length >= 3 && vf.normal) {
    const { n, u, v } = vfPlaneBasis(vf.normal);
    const c = new THREE.Vector3();
    for (const vv of vf.vertices) {
      c.add(new THREE.Vector3(vv[0] + parentPos[0], vv[1] + parentPos[1], vv[2] + parentPos[2]));
    }
    c.divideScalar(vf.vertices.length);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const vv of vf.vertices) {
      const w = new THREE.Vector3(vv[0] + parentPos[0], vv[1] + parentPos[1], vv[2] + parentPos[2]).sub(c);
      const pu = w.dot(u), pv = w.dot(v);
      if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
    }
    const su = maxU - minU, sv = maxV - minV;
    if (su > 1e-6 && sv > 1e-6) vfCtx = { c, u, v, n, minU, su, minV, sv };
  }

  // YEDEK: parent kutusu oranları
  let bbCtx: { min: THREE.Vector3; size: THREE.Vector3 } | null = null;
  if (parent?.geometry) {
    const posAttr = parent.geometry.getAttribute('position');
    if (posAttr) {
      const bb = new THREE.Box3().setFromBufferAttribute(posAttr as THREE.BufferAttribute);
      const size = new THREE.Vector3();
      bb.getSize(size);
      bbCtx = { min: bb.min.clone(), size };
    }
  }

  return steps.map(s => {
    const vfF = (s as any).pivotVfFrac as [number, number, number] | undefined;
    if (vfF && vfCtx) {
      const p = vfCtx.c.clone()
        .addScaledVector(vfCtx.u, vfCtx.minU + vfF[0] * vfCtx.su)
        .addScaledVector(vfCtx.v, vfCtx.minV + vfF[1] * vfCtx.sv)
        .addScaledVector(vfCtx.n, vfF[2]);
      return { ...s, pivot: [p.x, p.y, p.z] as [number, number, number] };
    }
    const f = (s as any).pivotFrac as [number, number, number] | undefined;
    if (f && bbCtx) {
      return {
        ...s,
        pivot: [
          parentPos[0] + bbCtx.min.x + f[0] * bbCtx.size.x,
          parentPos[1] + bbCtx.min.y + f[1] * bbCtx.size.y,
          parentPos[2] + bbCtx.min.z + f[2] * bbCtx.size.z,
        ] as [number, number, number],
      };
    }
    return s;
  });
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

// ─── REFERANS HACİM ──────────────────────────────────────────────────────
// Parent'ın SUBTRACTOR'SUZ taban hacmi (parent-yerel çerçevede keskin kutu).
// Kaynak öncelik: parameters.scaledBaseVertices (subtraction öncesi taban
// köşeleri) → geometri sınır kutusu. Dönmüş panel bu hacimle kesişir: duvara
// kadar uzar/açılı biçilir ama yüzeydeki subtractor oyuklarını devralmaz.
// NOT: Kutu keskindir — parent'ta fillet varsa panel fillet yarıçapı kadar
// köşeye taşabilir; bu bilinçli bir sadelik tercihi (fillet yeniden uygulamak
// pahalı ve kırılgan).
async function buildParentReferenceVolume(
  parent: any,
  createPanelFromVirtualFace: (verts: any, normal: any, t: number, e: number) => Promise<any>
): Promise<any | null> {
  try {
    let min: THREE.Vector3 | null = null, max: THREE.Vector3 | null = null;
    const sbv = parent?.parameters?.scaledBaseVertices;
    if (Array.isArray(sbv) && sbv.length >= 4) {
      min = new THREE.Vector3(Infinity, Infinity, Infinity);
      max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (const v of sbv) {
        min.min(new THREE.Vector3(v[0], v[1], v[2]));
        max.max(new THREE.Vector3(v[0], v[1], v[2]));
      }
    } else if (parent?.geometry) {
      const posAttr = parent.geometry.getAttribute('position');
      if (!posAttr) return null;
      const bb = new THREE.Box3().setFromBufferAttribute(posAttr as THREE.BufferAttribute);
      min = bb.min.clone(); max = bb.max.clone();
    }
    if (!min || !max) return null;
    const h = max.y - min.y;
    if (h <= 1e-3 || max.x - min.x <= 1e-3 || max.z - min.z <= 1e-3) return null;
    // Üst yüz köşelerinden -Y yönüne ekstrüzyon → tam taban kutusu
    const topVerts: [number, number, number][] = [
      [min.x, max.y, min.z], [max.x, max.y, min.z], [max.x, max.y, max.z], [min.x, max.y, max.z],
    ];
    return await createPanelFromVirtualFace(topVerts, [0, 1, 0], h, 0);
  } catch (err) {
    console.warn('[RotateRebuild] reference volume build failed, falling back to parent solid:', err);
    return null;
  }
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

      // NOT: Dönmüş kardeşler sanal yüzey ENGELİ olarak KORUNUR — kullanıcının
      // tıkladığı bölge (dönen panelin altı/üstü) sanal yüzeyi belirler ve bu
      // bölge seçimi kaybolmamalıdır. (Önceki sürümde buradan dışlanmaları,
      // yüzeyin karşı bölgeye kaymasına yol açıyordu.) Gönye için gereken uzama,
      // aşağıda dönen panele DOĞRU yönlü bir şeritle sağlanır.
      // YETKİ: Bu iterasyonda bağlam yalnızca SIRASI GELEN panelin VF'si için
      // tamdır — workingShapes tam olarak ÖNCEKİ kardeşleri içerir ki bu,
      // baskınlık (dominance) semantiğinin kendisidir: önce gelen panel yüz
      // alanını kazanır, sonra gelenler ona göre kısalır. Yetkili VF'de
      // çözülemeyen panel bağı "o panel artık benden sonra" demektir ve bölge
      // sınıra kadar yayılır (sıra değişince kısa kalma hatasının düzeltmesi).
      // Diğer VF'ler eksik bağlamla korunur; kendi iterasyonlarında güncellenir.
      const freshFaces = recalculateVirtualFacesForShape(parent, filteredForRecalc, workingShapes, new Set([currentVfId]));
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
        // DİKKAT: parentPos, aşağıdaki göç/pivot bloklarından ÖNCE tanımlanmalı
        // (TDZ hatası tüm rebuild'i sessizce boşa çıkarıyordu).
        const parentPos: [number, number, number] = [...parent.position] as [number, number, number];

        // Döndürülmüş panelde slab'ı düzleminde büyüt; aşağıda (ters döndürülmüş)
        // parent kesişimi paneli açıya göre tam duvara kadar büyütüp küçültür.
        // Yalnızca parent kesişimi yapılacaksa uygula, yoksa dev panel oluşurdu.
        let rotateStepsRaw: RotateStep[] = panel.parameters?.rotateSteps || [];
        // LEGACY GÖÇ: pivotFrac'sız eski adımlar ilk karşılaşmada güncel parent
        // kutusundan oransal pivota geçirilir ve parametrelere kalıcı yazılır.
        // Parent, göçten ÖNCE boyutlanmadıysa göç birebir doğrudur; sonrasında
        // tüm yeniden boyutlandırmalara karşı korumalı hale gelir. (Parent zaten
        // boyutlanmış BOZUK bir adım ancak yeniden döndürülerek düzelir.)
        if (
          rotateStepsRaw.length > 0 &&
          rotateStepsRaw.some(s => !(s as any).pivotFrac) &&
          parent?.geometry
        ) {
          const posAttr = parent.geometry.getAttribute('position');
          if (posAttr) {
            const bb = new THREE.Box3().setFromBufferAttribute(posAttr as THREE.BufferAttribute);
            const size = new THREE.Vector3();
            bb.getSize(size);
            rotateStepsRaw = rotateStepsRaw.map(s => {
              if ((s as any).pivotFrac) return s;
              const pl: [number, number, number] = [
                s.pivot[0] - parentPos[0],
                s.pivot[1] - parentPos[1],
                s.pivot[2] - parentPos[2],
              ];
              return {
                ...s,
                pivotFrac: [
                  size.x > 1e-6 ? (pl[0] - bb.min.x) / size.x : 0,
                  size.y > 1e-6 ? (pl[1] - bb.min.y) / size.y : 0,
                  size.z > 1e-6 ? (pl[2] - bb.min.z) / size.z : 0,
                ] as [number, number, number],
              };
            });
            // Ek olarak sanal yüzey çıpası da türet (asıl mekanizma)
            if (vf?.vertices?.length >= 3 && vf.normal) {
              const { n, u, v } = vfPlaneBasis(vf.normal);
              const c = new THREE.Vector3();
              for (const vv of vf.vertices) c.add(new THREE.Vector3(vv[0] + parentPos[0], vv[1] + parentPos[1], vv[2] + parentPos[2]));
              c.divideScalar(vf.vertices.length);
              let mnU = Infinity, mxU = -Infinity, mnV = Infinity, mxV = -Infinity;
              for (const vv of vf.vertices) {
                const w = new THREE.Vector3(vv[0] + parentPos[0], vv[1] + parentPos[1], vv[2] + parentPos[2]).sub(c);
                const pu = w.dot(u), pv = w.dot(v);
                if (pu < mnU) mnU = pu; if (pu > mxU) mxU = pu;
                if (pv < mnV) mnV = pv; if (pv > mxV) mxV = pv;
              }
              const su = mxU - mnU, sv = mxV - mnV;
              if (su > 1e-6 && sv > 1e-6) {
                rotateStepsRaw = rotateStepsRaw.map(s => {
                  if ((s as any).pivotVfFrac) return s;
                  const pw = new THREE.Vector3(s.pivot[0], s.pivot[1], s.pivot[2]).sub(c);
                  return { ...s, pivotVfFrac: [
                    (pw.dot(u) - mnU) / su,
                    (pw.dot(v) - mnV) / sv,
                    pw.dot(n),
                  ] as [number, number, number] };
                });
              }
            }
            console.info('[RotateRebuild] migrated legacy rotate step pivots to fractional anchors for panel', panel.id);
          }
        }
        // Pivotları GÜNCEL sanal yüzeyden (yedek: parent kutusu) yeniden türet.
        // Parametrelere HAM adımlar yazılır.
        const rotateSteps: RotateStep[] = effectiveRotateSteps(rotateStepsRaw, parent, parentPos, vf);
        if (rotateSteps.length > 0) {
          const s0: any = rotateSteps[0];
          const raw0: any = rotateStepsRaw[0];
          console.info('[RotateRebuild] pivot resolve', panel.id, {
            source: raw0?.pivotVfFrac ? 'vfFrac' : (raw0?.pivotFrac ? 'parentFrac' : 'absolute'),
            rawPivot: raw0?.pivot,
            effectivePivot: s0?.pivot,
          });
        }
        const isRotated = rotateSteps.length > 0;
        // Dönmüş panelde büyüme + kırpma (grow & shrink to fit) HER ZAMAN
        // çalışır: panel açıya göre referans hacmin duvarlarına kadar uzar ve
        // kenarları açılı biçilir. FARK, kesişilen katının SEÇİMİNDE:
        //  - parentFaceShape AÇIK ("ana yüze eşitle") → subtractor'lı GERÇEK
        //    parent katısı; panel yüzeyin oyuklu şeklini birebir alır.
        //  - bayrak KAPALI → subtractor'SUZ REFERANS HACİM (taban kutu);
        //    panel duvarlara göre uzar/kesilir ama yüzeydeki subtractor
        //    oyuklarının şeklini ALMAZ. (Kullanıcı kuralı: dönüş yüzeyin
        //    şeklini vermesin, referans hacme göre uzasın.)
        const willIntersectParent = !!(parent.replicadShape && (vf.parentFaceShape || isRotated));
        const planeExpand = (isRotated && willIntersectParent) ? parentMaxDim(parent) : 0;

        let rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, thickness, planeExpand);
        if (!rp) {
          workingShapes = [...workingShapes, panel];
          continue;
        }

        let faceExtrudedOk = false;
        // BÖLGE KİMLİĞİ: panelin yaratılışında kilitlenen regionUV (tıklama
        // noktasının yüz konturundaki oranı), GÜNCEL VF konturundan
        // mutlaklaştırılır. Kimlik VF regen/eşleşme katmanlarından geçmez —
        // "kırmızıya tıkladım sarıya yerleşti" sınıfı kaymalar imkansızlaşır;
        // resize'da oran korunarak parametrik taşınır. regionUV yoksa (eski
        // panel) vf.center kullanılır.
        const regionPoint: [number, number, number] = (() => {
          const rUV = panel.parameters?.regionUV as [number, number] | undefined;
          if (!rUV || vf.vertices.length < 3) return vf.center;
          const nV = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
          const ax = Math.abs(nV.x), ay = Math.abs(nV.y), az = Math.abs(nV.z);
          const uV = az >= ax && az >= ay ? new THREE.Vector3(1, 0, 0)
            : ax >= ay ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
          const vV = new THREE.Vector3().crossVectors(nV, uV).normalize();
          uV.crossVectors(vV, nV).normalize();
          let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, planeN = 0;
          vf.vertices.forEach(([x, y, z], i) => {
            const p3 = new THREE.Vector3(x, y, z);
            const pu = p3.dot(uV), pv = p3.dot(vV);
            uMin = Math.min(uMin, pu); uMax = Math.max(uMax, pu);
            vMin = Math.min(vMin, pv); vMax = Math.max(vMax, pv);
            if (i === 0) planeN = p3.dot(nV);
          });
          const pt = new THREE.Vector3()
            .addScaledVector(uV, uMin + rUV[0] * Math.max(uMax - uMin, 1e-6))
            .addScaledVector(vV, vMin + rUV[1] * Math.max(vMax - vMin, 1e-6))
            .addScaledVector(nV, planeN);
          return [pt.x, pt.y, pt.z] as [number, number, number];
        })();
        // TAM YUZ MODELI: her duz panel, tiklanan yuzun OCC yuz-extrusion'u
        // olarak uretilir (parentFaceShape bayragi kosul olmaktan cikti - tum
        // paneller tam yuz kaplar; kardes kesimleri ve bolge secimi asagida).
        if (!isRotated && parent.replicadShape) {
          try {
            const { createPanelFromParentFaces } = await import('./ReplicadService');
            const faceRp = await createPanelFromParentFaces(
              parent.replicadShape, vf.normal, vf.center, thickness, regionPoint
            );
            if (faceRp) { rp = faceRp; faceExtrudedOk = true; }
          } catch (err) {
            console.error('Yüz-extrusion panel üretimi başarısız, intersection fallback:', err);
          }
        }

        // EŞ-DÜZLEMLİ KARDEŞ ÖN-KESİMİ (yalnız yüz-extrusion panelinde):
        // Panel artık TÜM yüzü kapladığından, aynı yüzeydeki eş-düzlemli
        // kardeş panel panelin içinde TAM ÇAKIŞIK kalır; OCC gövde kesimi
        // yüzeyler birebir çakışınca toleransa bağlı sessizce no-op yapabilir
        // → panel kardeşin içine geçer ("kimi zaman içine geçiyor" hatası).
        // Çare: kesiciyi panel normali yönünde ±pay kaydırıp İKİ kez kesmek —
        // kaydırılan kesici panel yüzeyinden taşar, kesim asla no-op olmaz ve
        // iki kesim birlikte tam kalınlığı temizler. Dik kardeşler aşağıdaki
        // mevcut yarım-uzay/gövde kesim bloğuna bırakılır.
        if (faceExtrudedOk) {
          const EPS = 2; // mm — yüzey çakışıklığını kıran kaydırma payı
          const pn = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
          const coplanarSibs = workingShapes.filter(
            s => s.type === 'panel' &&
              s.parameters?.parentShapeId === parentShapeId &&
              s.id !== panel.id &&
              s.replicadShape &&
              ((s.parameters?.rotateSteps?.length ?? 0) === 0)
          );
          for (const sib of coplanarSibs) {
            try {
              // Eş-düzlemlilik: kardeşin en ince (kalınlık) ekseni panel
              // normaline ~paralel ise kardeş aynı yüzeyde yatıyor demektir.
              const sBox = worldAABBOfPanel(sib);
              if (!sBox) continue;
              const ss = new THREE.Vector3(); sBox.getSize(ss);
              const dims = [ss.x, ss.y, ss.z];
              let thin = 0; for (let i = 1; i < 3; i++) if (dims[i] < dims[thin]) thin = i;
              const sibNormal = new THREE.Vector3(thin === 0 ? 1 : 0, thin === 1 ? 1 : 0, thin === 2 ? 1 : 0);
              if (Math.abs(sibNormal.dot(pn)) < 0.9) continue; // eş-düzlemli değil → mevcut bloğa
              for (const shift of [EPS, -EPS]) {
                const cutter = siblingCutterInPanelFrame(sib, rotateSteps, parentPos,
                  [panel.position[0], panel.position[1], panel.position[2]]);
                if (!cutter) break;
                const shifted = cutter.translate(pn.x * shift, pn.y * shift, pn.z * shift);
                rp = await performBooleanCut(rp, shifted);
              }
            } catch (err) {
              console.error('Eş-düzlem kardeş ön-kesimi başarısız:', err);
            }
          }
        }

        const parentHasFillets = !!(parent.fillets && parent.fillets.length > 0 && parent.replicadShape);

        // NET TAŞIMA OFSETİ: Panel taşındıysa, kırpma sınırlarını taşıma
        // miktarı kadar geri kaydır. Yoksa applyTransformSteps pozisyona taşıma
        // eklediğinde geometri parent hacmin dışına taşar.
        const netMoveOffset: [number, number, number] = [0, 0, 0];
        const tStepsForMove: TransformStep[] = panel.parameters?.transformSteps || [];
        for (const ts of tStepsForMove) {
          if (ts.type === 'move') {
            const ax = ts.axis;
            const sign = ax.endsWith('+') ? 1 : -1;
            const dim = ax[0] as 'x' | 'y' | 'z';
            const idx = dim === 'x' ? 0 : dim === 'y' ? 1 : 2;
            netMoveOffset[idx] += sign * ts.value;
          }
        }

        if (willIntersectParent && !faceExtrudedOk) {
          // Kesişim katısı: bayrak açıksa gerçek (subtractor'lı) parent;
          // değilse subtractor'suz referans hacim. Referans hacim kurulamazsa
          // güvenli geri dönüş gerçek parent katısıdır.
          const intersectSolid = vf.parentFaceShape
            ? parent.replicadShape
            : ((await buildParentReferenceVolume(parent, createPanelFromVirtualFace)) ?? parent.replicadShape);
          // Küpü panelin yerel (döndürülmemiş) çerçevesine taşı: paneli
          // döndürmek yerine küpü ters döndürüp kesişiriz → geometri düz kalır
          // (önizleme/ölçü stabil), kırpma açıya göre doğru olur.
          let cube = rotateSteps.length > 0
            ? inverseRotateReplicadByLocalSteps(intersectSolid, rotateSteps, parentPos)
            : intersectSolid;
          // Taşıma ofseti varsa kesişim katısını ters yöne kaydır: kırpma
          // sınırları, panelin son konumuna göre doğru yerde kalır.
          const hasMoveOffset = Math.abs(netMoveOffset[0]) > 0.001 ||
            Math.abs(netMoveOffset[1]) > 0.001 || Math.abs(netMoveOffset[2]) > 0.001;
          if (hasMoveOffset) {
            cube = (typeof cube?.clone === 'function' ? cube.clone() : cube)
              .translate([-netMoveOffset[0], -netMoveOffset[1], -netMoveOffset[2]]);
          }
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

        // DÖNMÜŞ PANEL KARDEŞ KESİMİ: Dönme hareketi (ve bayrak açıksa küpe
        // uzatma) paneli kardeş panellerin İÇİNDEN geçirebilir. Küpteki desenle
        // aynı: kardeş geometrisi panelin yerel çerçevesine taşınıp kesilir.
        // SIRALAMA KURALI: Dönmüş panel yalnızca kendinden ÖNCE gelen (yüksek
        // öncelikli, workingShapes'te zaten kurulu) kardeşlere yol verir.
        // SONRAKİ (düşük öncelikli) paneller ise dönmüş panele yol verir —
        // onlar kendi turlarında yarım-uzay gönye kesimiyle açılı biçilir.
        // İkisinin birden kesilmesi karşılıklı geri çekilme = boşluk üretirdi.
        if (isRotated) {
          const rotCutters = workingShapes.filter(
            s => s.type === 'panel' &&
              s.parameters?.parentShapeId === parentShapeId &&
              s.id !== panel.id &&
              s.replicadShape
          );
          for (const sib of rotCutters) {
            // BROAD-PHASE: kardeş, dönmüş slab bandına girmiyorsa (yalnızca
            // değiyorsa/uzağındaysa) boolean HİÇ çağrılmaz — hem hız hem de
            // teğet-yüzey boolean donmalarından kaçınma.
            if (!siblingIntersectsRotatedSlab(sib, vf, thickness, rotateSteps, parentPos)) continue;
            try {
              // ÖNCE yarım-uzay: gövde kesimi, dönmüş panel kardeşin içinden
              // geçtiğinde onu İKİYE bölerdi (uzak parça "hayalet panel").
              // Yarım-uzay tek parça bırakır ve dönmüş-dönmüş temasında da
              // doğru gönye üretir. Belirsiz durumda gövde kesimine düşülür.
              const res = await cutRotatedPanelBySiblingHalfSpace(
                rp, panel, sib, vf, parentPos, parentMaxDim(parent),
                workingVirtualFaces, createPanelFromVirtualFace, performBooleanCut
              );
              if (res) {
                rp = res;
              } else {
                const cutter = siblingCutterInPanelFrame(sib, rotateSteps, parentPos,
                  [panel.position[0], panel.position[1], panel.position[2]]);
                if (cutter) rp = await performBooleanCut(rp, cutter);
              }
            } catch (err) {
              console.error('Failed to subtract sibling from rotated panel:', err);
            }
          }
        }

        // GÖNYE (AÇILI) BİRLEŞİM: Bu düz panel, kendinden ÖNCE gelen dönmüş
        // kardeşlerin üstüne/ötesine uzamış olabilir (VF hesabında onlar engel
        // sayılmadı). Her biri için temas yüzü düzleminden geçen yarım-uzay ile
        // kesilir → kalınlık ucu eğimle tam örtüşür, tek parça kalır. Belirsiz
        // durumda (panel merkezi bandın içinde) gövde kesimine düşülür.
        if (!isRotated) {
          const rotatedEarlierSibs = workingShapes.filter(
            s => s.type === 'panel' &&
              s.parameters?.parentShapeId === parentShapeId &&
              s.id !== panel.id &&
              s.replicadShape &&
              ((s.parameters?.rotateSteps?.length ?? 0) > 0)
          );
          for (const rsib of rotatedEarlierSibs) {
            try {
              const res = await cutByRotatedSiblingMiter(
                rp, panel, rsib, vf, thickness, parentPos, parentMaxDim(parent),
                workingVirtualFaces, createPanelFromVirtualFace, performBooleanCut,
                parent.replicadShape, performBooleanIntersection
              );
              if (res) {
                rp = res;
              } else {
                // Belirsiz durum: frame-düzeltmeli gövde kesimi
                const cutter = siblingCutterInPanelFrame(rsib, rotateSteps, parentPos,
                  [panel.position[0], panel.position[1], panel.position[2]]);
                if (cutter) rp = await performBooleanCut(rp, cutter);
              }
            } catch (err) {
              console.error('Miter cut against rotated sibling failed:', err);
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
        }

        // DÜZ KARDEŞ GÖVDE KESİMİ — HER düz panelde çalışır (parentFaceShape
        // bayrağından BAĞIMSIZ). Bu blok eskiden yanlışlıkla parentFaceShape
        // kapısının içindeydi: bayrak kapalı bölge panellerinde düz-düz
        // çakışmalar hiç kesilmiyordu. VF komşu-filtre düzeltmesiyle paneller
        // yüz sınırına kadar uzandığından, komşu yüz paneliyle eğik kenardaki
        // kama çakışması ancak bu gövde kesimiyle temizlenir. Broad-phase AABB
        // testi teğet/uzak çiftlerde boolean'ı zaten atlar. isRotated ise
        // kardeşler yukarıda (frame-düzeltmeli) kesildi; dönmüş kardeşler de
        // GÖNYE bloğunda yarım-uzayla kesildi — burada yalnızca DÜZ kardeşler.
        if (!isRotated) {
            // BROAD-PHASE kutusu VF'den DEĞİL, gönye uzantısı dahil GERÇEK
            // katıdan alınır: VF kutusu miter şeridini bilmediğinden uzatılmış
            // uç komşuya girse bile kutular "sadece değiyor" görünüp kesim
            // atlanıyordu (ölçülen 18x30 kalıcı iç içe geçmenin kök nedeni).
            let panelBox: THREE.Box3 | null = null;
            try {
              const bb = rp?.boundingBox?.bounds;
              if (bb) panelBox = new THREE.Box3(
                new THREE.Vector3(bb[0][0] + panel.position[0], bb[0][1] + panel.position[1], bb[0][2] + panel.position[2]),
                new THREE.Vector3(bb[1][0] + panel.position[0], bb[1][1] + panel.position[1], bb[1][2] + panel.position[2])
              );
            } catch { /* boundingBox erişilemezse VF kutusuna düş */ }
            if (!panelBox) panelBox = worldAABBFromVF(vf, thickness, [panel.position[0], panel.position[1], panel.position[2]]);
            const siblingPanelShapes = workingShapes.filter(
              s => s.type === 'panel' &&
                s.parameters?.parentShapeId === parentShapeId &&
                s.id !== panel.id &&
                s.replicadShape &&
                ((s.parameters?.rotateSteps?.length ?? 0) === 0)
            );
            for (const sib of siblingPanelShapes) {
              // BROAD-PHASE: hacimsel iç içe geçme yoksa (sadece değme dahil)
              // boolean atlanır — teğet yüzey kesimleri hem gereksiz hem OCC
              // için en yavaş/kırılgan durumdur.
              const sibBox = worldAABBOfPanel(sib);
              if (panelBox && sibBox && !aabbsPenetrate(panelBox, sibBox)) continue;
              try {
                // ÖNCE YARIM-UZAY: kardeşin temas düzleminden kes. Kardeş
                // panelin tam içine gömülü olsa bile (taşınmış dominant panel)
                // dolgu bir dış sınıra uzandığından OCC kesimi atlamaz — düz
                // gövde-kesiminin "iç boşluk" no-op'u böylece aşılır. Yarım-uzay
                // yalnızca panel-kardeş çifti TEK DÜZLEMLE ayrılabildiğinde
                // (dik/teğet konum) doğru sonucu verir; belirsizse (null) veya
                // hacmi hiç azaltmazsa GÖVDE KESİMİNE düşülür (eş düzlemli /
                // çakışan L-köşe gibi durumlar için).
                let cutDone = false;
                // YARIM-UZAY yalnızca DİK/YIĞILI çiftlerde geçerli: kardeşin
                // temas düzlemi normali panelin düzlemi İÇİNDE olmalı (kardeş
                // panele dik oturuyor). EŞ DÜZLEMLİ kardeşlerde (ikisi de aynı
                // yüzün komşusu; kalınlık eksenleri paralel) yarım-uzay yanlış
                // tarafı silip paneli yok eder → onlarda GÖVDE KESİMİ kullanılır.
                const perpendicular = (() => {
                  const sBox = worldAABBOfPanel(sib);
                  if (!sBox || !vf?.normal) return false;
                  const ss2 = new THREE.Vector3(); sBox.getSize(ss2);
                  const sdA = [ss2.x, ss2.y, ss2.z];
                  let sta = 0; for (let i = 1; i < 3; i++) if (sdA[i] < sdA[sta]) sta = i;
                  const sibNormal = new THREE.Vector3(sta === 0 ? 1 : 0, sta === 1 ? 1 : 0, sta === 2 ? 1 : 0);
                  const pn = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
                  // Kardeş normali panel normaline ~DİK ise kardeş panele diktir
                  // (temas düzlemi panelin içinde). |dot| küçük → dik/yığılı.
                  return Math.abs(sibNormal.dot(pn)) < 0.35;
                })();
                // ORTA-AÇIKLIK KORUMASI: yarım-uzay yalnızca kardeş panelin
                // UCUNDA/KENARINDA otururken geçerlidir. Kardeş (ör. dikey
                // bölme) panelin ORTASINDAN geçiyorsa — kardeşin normal ekseni
                // boyunca panelin HER İKİ yanında da malzeme varsa — çift tek
                // düzlemle ayrılamaz; yarım-uzay panelin bir yarısını komple
                // siler. İki bölmeli L kurulumunda iki kesim panelin iki
                // yarısını da silip paneli YOK EDİYORDU ("panel yerleşiyor,
                // saniyesinde kayboluyor, ölçüler 0" hatasının kök nedeni).
                // Orta-açıklıkta gövde kesimine düşülür: panel bölme yuvasını
                // çentikler ve iki tarafıyla yaşar.
                const sibMidSpan = (() => {
                  if (!panelBox || !sibBox) return false;
                  const ss3 = new THREE.Vector3(); sibBox.getSize(ss3);
                  const dims = [ss3.x, ss3.y, ss3.z];
                  let ax = 0; for (let i = 1; i < 3; i++) if (dims[i] < dims[ax]) ax = i;
                  const pMin = [panelBox.min.x, panelBox.min.y, panelBox.min.z][ax];
                  const pMax = [panelBox.max.x, panelBox.max.y, panelBox.max.z][ax];
                  const sMin = [sibBox.min.x, sibBox.min.y, sibBox.min.z][ax];
                  const sMax = [sibBox.max.x, sibBox.max.y, sibBox.max.z][ax];
                  const eps = 5; // mm — kenar payı: bundan fazlası "iki yanda da malzeme"
                  return sMin > pMin + eps && sMax < pMax - eps;
                })();
                const hs = (perpendicular && !sibMidSpan)
                  ? await cutFlatPanelBySiblingHalfSpace(rp, panel, sib, vf, parentMaxDim(parent))
                  : null;
                if (hs) {
                  let shrank = true;
                  try {
                    const before = rp?.boundingBox?.bounds, after = hs?.boundingBox?.bounds;
                    if (before && after) {
                      const vol = (b: any) => (b[1][0]-b[0][0])*(b[1][1]-b[0][1])*(b[1][2]-b[0][2]);
                      shrank = vol(after) < vol(before) - 1; // en az 1mm³ küçüldü
                    }
                  } catch { /* ölçülemezse kabul et */ }
                  if (shrank) { rp = hs; cutDone = true; }
                }
                if (!cutDone) {
                  const cutter = siblingCutterInPanelFrame(sib, rotateSteps, parentPos,
                    [panel.position[0], panel.position[1], panel.position[2]]);
                  if (cutter) rp = await performBooleanCut(rp, cutter);
                }
              } catch (err) {
                console.error('Failed to subtract sibling panel from straight sibling cut:', err);
              }
            }
          }

        // BÖLGE SEÇİMİ (yalnız yüz-extrusion panelinde): Kardeş kesimleri
        // paneli birden çok AYRIK parçaya böldüyse (ör. dikey bölme ortadan
        // geçti), yalnızca kullanıcının tıkladığı bölgedeki parça tutulur.
        // Kardeşin öte tarafındaki artık parça ("bir yerlerde ince panel
        // kalıyor") burada atılır. Tek parçaysa katı aynen kalır.
        if (faceExtrudedOk) {
          try {
            const { keepSolidNearestPoint } = await import('./ReplicadService');
            rp = await keepSolidNearestPoint(rp, regionPoint);
          } catch (err) {
            console.error('Bölge seçimi başarısız, panel çok parçalı kalabilir:', err);
          }
          // DEJENERE KORUMASI: kardeşler tıklanan bölgeyi tamamen kapladıysa
          // kesimler paneli yutar ve "ölçüsü 0 panel" doğar. Böyle bir sonuç
          // ASLA yazılmaz: panelin önceki geometrisi korunur ve durum loglanır
          // (kullanıcı kardeşi kısaltınca sonraki rebuild paneli yeniden
          // büyütür).
          try {
            const bb = rp?.boundingBox?.bounds;
            const spans = bb ? [bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2]] : [0, 0, 0];
            const degenerate = !bb || !isFinite(spans[0]) || spans.filter(s => s > 0.5).length < 2;
            if (degenerate) {
              console.error('Panel bölgesi kardeşlerce tamamen kaplandı; önceki geometri korunuyor:', panel.id);
              if (panel.replicadShape) {
                rp = panel.replicadShape.clone();
              } else {
                workingShapes = [...workingShapes, panel];
                continue;
              }
            }
          } catch { /* bbox okunamadıysa akışa devam */ }
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
        const tStepsRaw: TransformStep[] = panel.parameters?.transformSteps || [];
        if (tStepsRaw.length > 0) {
          // BİRLEŞİK YOL: taşıma+döndürme adımları tek listede, uygulama
          // sırası korunur. Döndürme adımlarının pivotları, yukarıda güncel
          // sanal yüzeyden türetilen (effective) değerlerle id bazında eşlenir;
          // parametrelere HAM (göçmüş çıpalı) adımlar yazılır.
          const effById = new Map(rotateSteps.map(s => [s.id, s]));
          const rawById = new Map(rotateStepsRaw.map(s => [s.id, s]));
          const tEff = tStepsRaw.map(s =>
            s.type === 'rotate' && effById.has(s.id) ? { ...s, ...effById.get(s.id)!, type: 'rotate' as const } : s);
          const tRaw = tStepsRaw.map(s =>
            s.type === 'rotate' && rawById.has(s.id) ? { ...s, ...rawById.get(s.id)!, type: 'rotate' as const } : s);
          const basePos: [number, number, number] =
            panel.parameters?.baseTransformPosition ?? panel.parameters?.baseRotatePosition ?? [...panel.position];
          const baseRot: [number, number, number] =
            panel.parameters?.baseTransformRotation ?? panel.parameters?.baseRotateRotation ?? [...panel.rotation];
          const { position: newPos, rotation: newRot } = applyTransformSteps(basePos, baseRot, tEff);
          rebuiltPanel = {
            ...rebuiltPanel,
            position: newPos,
            rotation: newRot,
            parameters: {
              ...rebuiltPanel.parameters,
              baseTransformPosition: basePos, baseTransformRotation: baseRot,
              baseRotatePosition: basePos, baseRotateRotation: baseRot,
              transformSteps: tRaw,
              rotateSteps: tRaw.filter(s => s.type === 'rotate'),
            },
          };
        } else if (rotateSteps.length > 0) {
          // ESKİ YOL: yalnızca rotateSteps olan (henüz göçmemiş) paneller.
          const basePos: [number, number, number] = panel.parameters?.baseRotatePosition ?? [...panel.position];
          const baseRot: [number, number, number] = panel.parameters?.baseRotateRotation ?? [...panel.rotation];
          const { position: newPos, rotation: newRot } = applyRotateSteps(basePos, baseRot, rotateSteps);
          rebuiltPanel = {
            ...rebuiltPanel,
            position: newPos,
            rotation: newRot,
            parameters: { ...rebuiltPanel.parameters, baseRotatePosition: basePos, baseRotateRotation: baseRot, rotateSteps: rotateStepsRaw },
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
      // ── KAYIP GÜNCELLEME KORUMASI (sıra değişiminin yutulması) ────────────
      // ESKİ HALİ: `virtualFaces: workingVirtualFaces` — rebuild BAŞINDA alınan
      // anlık görüntü, sonunda dizinin TAMAMI olarak geri yazılıyordu. Rebuild
      // uzun sürer (replicad boolean'ları) ve bu sırada kullanıcı panel SIRASINI
      // değiştirirse akış şuydu: süren tur bitince eski-sıralı anlık görüntü
      // store'a yazılır → SIRA GERİ ALINIR → kuyruktaki tekrar-koşum geri
      // alınmış (eski) sırayla çalışır → "sırayı değiştirdim ama birleşimler
      // değişmedi". Aynı yutulma bu aralıkta yapılan updateVirtualFace /
      // addVirtualFace için de geçerliydi.
      //
      // DOĞRUSU: bu turun ürettiği TAZE VF İÇERİKLERİ kimlikle eşlenir; dizinin
      // SIRASI ve ÜYELİĞİ ise store'un GÜNCEL halinden alınır. Böylece tur
      // sürerken yapılan sıra değişikliği/eklemeler korunur; kuyruktaki
      // tekrar-koşum da en güncel sırayla, doğru birleşimleri üretir.
      const freshVfById = new Map(workingVirtualFaces.map(f => [f.id, f]));
      return {
        shapes: state.shapes.map(s => rebuiltById.get(s.id) || s),
        virtualFaces: state.virtualFaces.map(f => freshVfById.get(f.id) || f),
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
