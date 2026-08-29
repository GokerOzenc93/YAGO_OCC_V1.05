import * as THREE from 'three';
import type { VirtualFace, Shape } from '../store';
import {
  computeFaceComponentContour,
  convexHull2D,
  ensureCCW,
  getFacePlaneAxes,
  getShapeMatrix,
  getSubtractorFootprints2D,
  isPointInsidePolygon,
  computeFreeRegionLocal,
  meshOnPlaneBoundary2D,
  panelFootprintInParentLocal,
  projectTo2D,
  subtractPolygon,
  type Point2D,
} from './FaceRegion';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  findFaceByDescriptor,
  type FaceData,
  type CoplanarFaceGroup,
} from './FaceEditor';
import { composeSteps, getUnifiedSteps } from './PanelEngine';

// ── TABAN DAMGALAMA GEOMETRİSİ ──────────────────────────────────────────────
// Bir kardeş panelin KUTUYA OTURAN taban dilimini (transform/extrude UYGULANMADAN)
// döndürür: VF bölge dörtgeni (ön halka) + normal yönünde -kalınlık ötelenmiş
// arka halka = 8 köşe. Ayak izi fonksiyonları (getPanelFootprints2D /
// panelFootprintInParentLocal) bu köşeleri hedef düzleme izdüşürüp konveks
// gövdesini alır — dikdörtgen bölge için birebir doğru ayak izi. Index/normal
// verilmez; footprint yolları köşe-projeksiyon + konveks gövde ile çalışır.
// vf.vertices parent-YEREL uzaydadır (panel de bu köşelerden üretilip
// position=parentPos ile yerleşir); taban panel de p'nin position/rotation/scale'ini
// aynen taşıdığından footprint doğru dünya çerçevesinde çıkar.
function baseStampGeometryFromVf(
  vf: VirtualFace,
  thickness: number
): THREE.BufferGeometry | null {
  if (!vf.vertices || vf.vertices.length < 3) return null;
  return buildPrismFromVertices(vf.vertices, vf.normal, thickness);
}

function trimmedStampGeometryFromVf(
  vf: VirtualFace,
  thickness: number,
  extrudeSteps: any[],
  targetFaceNormal: THREE.Vector3
): THREE.BufferGeometry | null {
  if (!vf.vertices || vf.vertices.length < 3) return null;
  const trimmed: [number, number, number][] = vf.vertices.map(v => [...v] as [number, number, number]);
  for (const step of extrudeSteps) {
    if (!step.faceNormal) continue;
    const eN = new THREE.Vector3(...step.faceNormal).normalize();
    if (eN.dot(targetFaceNormal) > 0.7) continue;
    const amount = step.resolvedValue ?? step.value ?? 0;
    if (Math.abs(amount) < 0.01) continue;
    const projs = trimmed.map(p => p[0] * eN.x + p[1] * eN.y + p[2] * eN.z);
    if (amount < 0) {
      const maxProj = Math.max(...projs);
      const threshold = maxProj + amount;
      for (let i = 0; i < trimmed.length; i++) {
        if (projs[i] > threshold) {
          const delta = threshold - projs[i];
          trimmed[i][0] += delta * eN.x;
          trimmed[i][1] += delta * eN.y;
          trimmed[i][2] += delta * eN.z;
        }
      }
    } else {
      const minProj = Math.min(...projs);
      const threshold = minProj + amount;
      for (let i = 0; i < trimmed.length; i++) {
        if (projs[i] < threshold) {
          const delta = threshold - projs[i];
          trimmed[i][0] += delta * eN.x;
          trimmed[i][1] += delta * eN.y;
          trimmed[i][2] += delta * eN.z;
        }
      }
    }
  }
  return buildPrismFromVertices(trimmed, vf.normal, thickness);
}

function buildPrismFromVertices(
  vertices: [number, number, number][],
  normal: [number, number, number],
  thickness: number
): THREE.BufferGeometry | null {
  const N = vertices.length;
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const front = vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const back = front.map(p => p.clone().addScaledVector(n, -thickness)); // extrude(-th) ile aynı yön
  const all = [...front, ...back];               // 0..N-1 ön, N..2N-1 arka
  const arr = new Float32Array(all.length * 3);
  all.forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; });

  // DÜZGÜN İNDEKSLİ PRİZMA: kapaklar fan (basit çokgen → dış kenarlar tek
  // kullanımlı kalır, kenar-halkası çıkarımı içbükey bölgede bile doğru),
  // yanlar quad. Kalınlık şeridinin hedef düzlemdeki kenar-halkası bu yan
  // üçgenlerden çıkar; footprint fonksiyonları gerçek panel mesh'i gibi çalışır.
  const idx: number[] = [];
  for (let i = 1; i < N - 1; i++) idx.push(0, i, i + 1);            // ön kapak
  for (let i = 1; i < N - 1; i++) idx.push(N, N + i + 1, N + i);    // arka kapak (ters sarım)
  for (let i = 0; i < N; i++) {                                     // yan duvarlar
    const j = (i + 1) % N;
    idx.push(i, j, N + j);
    idx.push(i, N + j, N + i);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.setIndex(idx);
  return g;
}

// ── YEREL YARDIMCILAR (kendi kendine yeterlilik) ────────────────────────────
// Bu iki fonksiyon eskiden './FaceEditor'den import ediliyordu; ancak
// FaceEditor/GeometryUtils'in bazı sürümleri bunları export etmez ve eksik
// export TÜM modülün yüklenmesini çökertir → rebuildPanelsForParent'ın dynamic
// import'u patlar, try/catch yutar ve PANELLER HİÇ GÜNCELLENMEZ (küp resize'da
// panellerin sabit kalması hatasının kök nedeni). Modül artık dış dosya
// sürümünden bağımsız çalışsın diye yerel tanımlandılar.

/**
 * Ölçekten bağımsız düzlem kimliği, 1. aşama: aynı YÖNLÜ (işaretli normal)
 * yüzlerin eksen boyunca ayrık düzlem konumlarını kümeleyip sıralar ve
 * axisRank sırasındaki düzlemin konumunu döndürür. Yeniden boyutlandırma
 * konumları taşır ama SIRAYI değiştirmez. Rank aralık dışıysa null.
 */
function resolveAxisPlaneByRank(
  faces: FaceData[],
  axisDirection: string,
  axisRank: number,
  _axisRankCount: number
): number | null {
  const axis = axisDirection[0] as 'x' | 'y' | 'z';
  const sign = axisDirection.includes('-') ? -1 : 1;
  const axisVec = new THREE.Vector3(
    axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0
  );
  const positions: number[] = [];
  for (const f of faces) {
    if (f.normal.dot(axisVec) > 0.9) {
      positions.push(axis === 'x' ? f.center.x : axis === 'y' ? f.center.y : f.center.z);
    }
  }
  if (positions.length === 0) return null;
  positions.sort((a, b) => a - b);
  const clusters: number[] = [];
  for (const p of positions) {
    if (clusters.length === 0 || Math.abs(p - clusters[clusters.length - 1]) > 1.0) clusters.push(p);
    else clusters[clusters.length - 1] = (clusters[clusters.length - 1] + p) / 2;
  }
  if (axisRank < 0 || axisRank >= clusters.length) return null;
  return clusters[axisRank];
}

/**
 * 2. aşama: normalize merkezlerin DÜZLEM-İÇİ farkı — eksen bileşeni hariç
 * tutulur; aynı düzlemdeki kopuk yüzlerden doğrusunu ayırt eder.
 */
function inPlaneCenterDiff(
  a: [number, number, number],
  b: [number, number, number] | undefined,
  axisDirection: string
): number {
  const axis = axisDirection[0];
  const skip = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  let d = 0;
  for (let i = 0; i < 3; i++) {
    if (i === skip) continue;
    d += Math.abs(a[i] - (b?.[i] ?? 0.5));
  }
  return d;
}

function findMatchingFaceGroup(
  vf: VirtualFace,
  faces: FaceData[],
  faceGroups: CoplanarFaceGroup[],
  geometry: THREE.BufferGeometry
): CoplanarFaceGroup | null {
  const vfNormal = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
  const vfCenter = new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]);

  const candidateGroups: CoplanarFaceGroup[] = [];
  for (const group of faceGroups) {
    const groupNormal = group.normal.clone().normalize();
    if (vfNormal.dot(groupNormal) > 0.95) {
      candidateGroups.push(group);
    }
  }

  if (candidateGroups.length === 0) return null;

  // ─── ÖLÇEKTEN BAĞIMSIZ YÜZ KİMLİĞİ (iki aşamalı) ──────────────────────────
  // Aynı normale sahip birden çok yüz olduğunda eşleme şimdiye dek MUTLAK
  // düzlem konumuna göre yapılıyordu. İki ayrı bozulma üretiyordu:
  //   (a) PARALEL düzlemler (L profil: dış duvar + çentik duvarı) — küp
  //       büyüyünce düzlemler taşınır; büyüme aradaki boşluğu aşınca eski
  //       konuma "en yakın" düzlem ÖBÜR yüz olur ve panel oraya atlar.
  //   (b) AYNI DÜZLEMDE kopuk yüzler (U profil, çift çentik) — düzlem farkı
  //       ikisinde de sıfırdır; eski kod ilk adayı seçip yüzeyler arasında
  //       rastgele zıplar. "Aynı düzlemdeki başka yüzeye yerleşiyor" tam bu.
  //
  // Çözüm, ölçekten bağımsız iki aşamalı kimlik:
  //   1) RANK  → hangi DÜZLEM (aynı yönlü ayrık düzlemler içindeki sıra;
  //              yeniden boyutlandırma sırayı değiştirmez).
  //   2) DÜZLEM-İÇİ NORMALİZE MERKEZ → o düzlemdeki hangi KOPUK YÜZ.
  const desc: any = vf.raycastRecipe?.faceGroupDescriptor ?? (vf as any).faceGroupDescriptor;
  if (desc?.axisDirection && desc.axisRank !== undefined && desc.axisRankCount !== undefined) {
    const wantPos = resolveAxisPlaneByRank(faces, desc.axisDirection, desc.axisRank, desc.axisRankCount);
    if (wantPos !== null) {
      const axis = (desc.axisDirection as string)[0] as 'x' | 'y' | 'z';
      const onPlane = candidateGroups.filter(g => {
        const c = axis === 'x' ? g.center.x : axis === 'y' ? g.center.y : g.center.z;
        return Math.abs(c - wantPos) <= 1.0;
      });
      if (onPlane.length === 1) return onPlane[0];
      if (onPlane.length > 1) {
        const bb = new THREE.Box3().setFromBufferAttribute(
          geometry.getAttribute('position') as THREE.BufferAttribute
        );
        const size = new THREE.Vector3();
        bb.getSize(size);
        const norm = (p: THREE.Vector3): [number, number, number] => [
          size.x > 1e-6 ? (p.x - bb.min.x) / size.x : 0.5,
          size.y > 1e-6 ? (p.y - bb.min.y) / size.y : 0.5,
          size.z > 1e-6 ? (p.z - bb.min.z) / size.z : 0.5,
        ];
        let best: CoplanarFaceGroup | null = null;
        let bestD = Infinity;
        for (const g of onPlane) {
          const d = inPlaneCenterDiff(norm(g.center), desc.normalizedCenter, desc.axisDirection);
          if (d < bestD) { bestD = d; best = g; }
        }
        if (best) return best;
      }
      // Bu rank'te hiç aday yoksa (topoloji beklenmedik) eski yollara düşülür.
    }
  }

  // Grup AABB'sine clamp mesafesi: merkez grubun içindeyse 0.
  const clampDistToGroup = (g: CoplanarFaceGroup): number => {
    const bb = new THREE.Box3();
    g.faceIndices.forEach(fi => {
      const face = faces[fi];
      if (face) face.vertices.forEach(vv => bb.expandByPoint(vv));
    });
    const cl = vfCenter.clone().clamp(bb.min, bb.max);
    return cl.distanceTo(vfCenter);
  };

  if (vf.faceGroupDescriptor) {
    const matchedFace = findFaceByDescriptor(vf.faceGroupDescriptor, faces, geometry);
    if (matchedFace) {
      const matchedGroup = candidateGroups.find(g =>
        g.faceIndices.includes(matchedFace.faceIndex)
      );
      // MERKEZ-TUTARLILIK SÜZGECİ: descriptor tek-üçgen eşleşmesidir ve
      // resize sonrası yanlış bileşene kayabilir; grup, VF merkezini
      // (±5mm) gerçekten kapsıyorsa kabul edilir, aksi halde merkez
      // tabanlı seçime düşülür.
      if (matchedGroup && clampDistToGroup(matchedGroup) <= 5) return matchedGroup;
    }
  }

  if (candidateGroups.length === 1) return candidateGroups[0];

  // ─── AYNI DÜZLEMDEKİ KOPUK YÜZLER İÇİN BERABERLİK KIRICI ───
  // Aynı normalde birden çok grup varsa (U/çift-kule: sol yüz + sağ yüz
  // AYNI düzlemde) düzlem-offset farkı ikisinde de sıfırdır; eski kod
  // `<` karşılaştırmasıyla İLK adayı tutuyordu → panel hep SOL bileşene
  // savruluyordu ("sağa tıkladım sola yerleşti" hatasının kök nedeni,
  // loglarla kanıtlandı: eskiMerkez=993 → yeniMerkez=84, kontur 0..282).
  // Doğrusu: en iyi offset'e ±0.5mm yakın TÜM adaylar içinden VF
  // merkezine (grup AABB clamp mesafesi; içindeyse 0) EN YAKIN grup.
  const vfPlaneOffset = vfCenter.dot(vfNormal);
  const planeDiffOf = (g: CoplanarFaceGroup): number => {
    const gn = g.normal.clone().normalize();
    return Math.abs(g.center.dot(gn) - vfPlaneOffset);
  };
  let minPlaneDiff = Infinity;
  for (const g of candidateGroups) minPlaneDiff = Math.min(minPlaneDiff, planeDiffOf(g));
  if (minPlaneDiff < 5) {
    const samePlane = candidateGroups.filter(g => planeDiffOf(g) <= minPlaneDiff + 0.5);
    let best: CoplanarFaceGroup | null = null;
    let bestD = Infinity;
    for (const g of samePlane) {
      const d = clampDistToGroup(g);
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best) return best;
  }

  let bestGroup: CoplanarFaceGroup | null = null;
  let bestDist = Infinity;
  for (const group of candidateGroups) {
    const groupBBox = new THREE.Box3();
    group.faceIndices.forEach(fi => {
      const face = faces[fi];
      if (!face) return;
      face.vertices.forEach(v => groupBBox.expandByPoint(v));
    });

    const expanded = groupBBox.clone().expandByScalar(5);
    if (expanded.containsPoint(vfCenter)) {
      const dist = vfCenter.distanceTo(group.center);
      if (dist < bestDist) {
        bestDist = dist;
        bestGroup = group;
      }
    }
  }

  if (bestGroup) return bestGroup;

  if (vf.raycastRecipe) {
    const matchedFace = findFaceByDescriptor(
      vf.raycastRecipe.faceGroupDescriptor,
      faces,
      geometry
    );
    if (matchedFace) {
      const matchedGroup = candidateGroups.find(g =>
        g.faceIndices.includes(matchedFace.faceIndex)
      );
      if (matchedGroup) return matchedGroup;
    }
  }

  bestDist = Infinity;
  for (const group of candidateGroups) {
    const dist = vfCenter.distanceTo(group.center);
    if (dist < bestDist) {
      bestDist = dist;
      bestGroup = group;
    }
  }

  return bestGroup;
}

function computeFaceGroupExtent(
  groupVerticesWorld: THREE.Vector3[],
  u: THREE.Vector3,
  v: THREE.Vector3
): { uMin: number; uMax: number; vMin: number; vMax: number; uSpan: number; vSpan: number } {
  const faceVertsU = groupVerticesWorld.map(vw => vw.dot(u));
  const faceVertsV = groupVerticesWorld.map(vw => vw.dot(v));
  const uMin = Math.min(...faceVertsU);
  const uMax = Math.max(...faceVertsU);
  const vMin = Math.min(...faceVertsV);
  const vMax = Math.max(...faceVertsV);
  return { uMin, uMax, vMin, vMax, uSpan: uMax - uMin, vSpan: vMax - vMin };
}

function regenerateCurvedFaceVF(
  vf: VirtualFace,
  shape: Shape,
  faces: FaceData[],
  faceGroups: CoplanarFaceGroup[],
  localToWorld: THREE.Matrix4,
  worldToLocal: THREE.Matrix4
): VirtualFace | null {
  const matchedGroup = findMatchingFaceGroup(vf, faces, faceGroups, shape.geometry);
  if (!matchedGroup) return null;

  const normalMatrix = new THREE.Matrix3().getNormalMatrix(localToWorld);
  const localNormal = matchedGroup.normal.clone().normalize();
  const worldNormal = localNormal.clone().applyMatrix3(normalMatrix).normalize();
  const { u, v } = getFacePlaneAxes(worldNormal);

  const allVertsWorld: THREE.Vector3[] = [];
  matchedGroup.faceIndices.forEach(fi => {
    const face = faces[fi];
    if (!face) return;
    face.vertices.forEach(vtx => allVertsWorld.push(vtx.clone().applyMatrix4(localToWorld)));
  });
  if (allVertsWorld.length < 3) return null;

  // Use the stored VF center's normal component so the panel stays at the same
  // depth after parent shape changes.
  const storedCenter = new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2])
    .applyMatrix4(localToWorld);
  const nComp = storedCenter.dot(worldNormal);

  const uCoords = allVertsWorld.map(vtx => vtx.dot(u));
  const vCoords = allVertsWorld.map(vtx => vtx.dot(v));
  const uMin = Math.min(...uCoords), uMax = Math.max(...uCoords);
  const vMin = Math.min(...vCoords), vMax = Math.max(...vCoords);
  if (uMax - uMin < 1 || vMax - vMin < 1) return null;

  const buildWP = (uc: number, vc: number) =>
    new THREE.Vector3().addScaledVector(u, uc).addScaledVector(v, vc).addScaledVector(worldNormal, nComp);

  const cornersWorld = [
    buildWP(uMax, vMax), buildWP(uMin, vMax),
    buildWP(uMin, vMin), buildWP(uMax, vMin),
  ];
  const cornersLocal = cornersWorld.map(c => c.clone().applyMatrix4(worldToLocal));
  const centerLocal = new THREE.Vector3();
  cornersLocal.forEach(c => centerLocal.add(c));
  centerLocal.divideScalar(cornersLocal.length);

  return {
    ...vf,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    center: [centerLocal.x, centerLocal.y, centerLocal.z],
    vertices: cornersLocal.map(c => [c.x, c.y, c.z] as [number, number, number]),
  };
}

// Sıralanmamış sınır kenarlarını (v1→v2 çiftleri) 2B sıralı bir köşe halkasına
// dizer. Uç noktaları anahtarlayıp komşuları zincirler; kopuk/çoklu halka
// durumunda en uzun zinciri döndürür (nokta-içinde testi için yeterli).
function orderEdgesToRing2D(
  edges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>,
  u: THREE.Vector3,
  v: THREE.Vector3
): Array<{ x: number; y: number }> {
  if (edges.length < 3) return [];
  const key = (p: THREE.Vector3) => `${Math.round(p.dot(u) * 100)},${Math.round(p.dot(v) * 100)}`;
  const adj = new Map<string, { k: string; p: THREE.Vector3 }[]>();
  const ptByKey = new Map<string, THREE.Vector3>();
  for (const e of edges) {
    const ka = key(e.v1), kb = key(e.v2);
    ptByKey.set(ka, e.v1); ptByKey.set(kb, e.v2);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push({ k: kb, p: e.v2 });
    adj.get(kb)!.push({ k: ka, p: e.v1 });
  }
  const startK = adj.keys().next().value as string;
  const ring: Array<{ x: number; y: number }> = [];
  const visited = new Set<string>();
  let cur = startK, prev = '';
  for (let guard = 0; guard < edges.length + 2; guard++) {
    visited.add(cur);
    const p = ptByKey.get(cur)!;
    ring.push({ x: p.dot(u), y: p.dot(v) });
    const neigh = adj.get(cur) || [];
    const nxt = neigh.find(n => n.k !== prev && !visited.has(n.k));
    if (!nxt) break;
    prev = cur; cur = nxt.k;
    if (cur === startK) break;
  }
  return ring.length >= 3 ? ring : [];
}


// ─────────────────────────────────────────────────────────────────────────────
// PARAMETRİK BAĞ ÇÖZÜMÜ (anchor resolution)
//
// SORUN: Işın kökeni şimdiye kadar `normalizedClickUV` ile, yani YÜZÜN TAMAMINA
// oranlanarak yeniden kuruluyordu. Bölge bir KOMŞU PANELE yaslandığında bu yanlış:
// komşu panel, parent kutu büyüyünce kendi mutlak konumunda kalır (ör. tabandan
// 80 mm), ama oranlı köken yüzle birlikte ölçeklenip panelin ÖTE tarafına atlar.
// Sonuç: kübün yüksekliği artınca panel, referans panelin ALTINDA değil ÜSTÜNDE
// oluşur — bildirilen hata tam olarak budur.
//
// ÇÖZÜM: Yakalama anında her yönün neye yaslandığı (`anchorOwners`) kaydedilir.
// Yeniden türetmede her eksen için ALT ve ÜST bağ ayrı ayrı çözülür:
//   • sınır (null)  → yüzün güncel u/v uç değeri (parent ile birlikte taşınır)
//   • komşu (owner) → komşunun YÜZ ÜZERİNDEKİ güncel ayak izinin YAKIN kenarı
// Köken, bu iki bağ arasında YAKALAMADAKİ ORANI koruyacak şekilde kurulur.
// Işın atma / görünürlük çokgeni algoritması hiç değişmez — sadece köken artık
// doğru bantta doğuyor.
// ─────────────────────────────────────────────────────────────────────────────

type UVPoint = { u: number; v: number };

/** Bir komşunun (panel / kardeş VF / çıkarma kutusu) yüz düzlemindeki ayak izi. */
export function recalculateVirtualFacesForShape(
  shape: Shape,
  virtualFaces: VirtualFace[],
  allShapes?: any[],
  /**
   * Bağlamı TAM olan VF kimlikleri. 'all' → tüm VF'ler için bağlam tam
   * (store üzerinden tam sahne ile çağrı). Küme → yalnızca o VF'ler yetkili;
   * kalanlar eksik-bağlam korumasıyla işlenir (rebuild ara geçişleri).
   * Varsayılan 'all' — tek bilinen ikinci çağıran store'dur ve tam sahne verir.
   */
  authoritativeVfIds: Set<string> | 'all' = 'all'
): VirtualFace[] {
  const shapeFaces = virtualFaces.filter(vf => vf.shapeId === shape.id);
  if (shapeFaces.length === 0) return virtualFaces;

  if (!shape.geometry) return virtualFaces;

  const faces = extractFacesFromGeometry(shape.geometry);
  const faceGroups = groupCoplanarFaces(faces);
  const localToWorld = getShapeMatrix(shape);
  const worldToLocal = localToWorld.clone().invert();

  const childPanels = (allShapes || []).filter(
    s => s.type === 'panel' && s.parameters?.parentShapeId === shape.id
  );

  // ── SIRA ÖNCELİĞİ (bölge katmanı) ────────────────────────────────────────
  // Köşe/bindirme önceliğini asıl belirleyen AYAK İZİ kırpmasıdır: hangi
  // panelin ayak izi hangi VF'ye damgalanırsa o panel köşede TAM boy kalır,
  // öteki kısalır. Bu yüzden öncelik BURADA uygulanır: bir VF'ye yalnız
  // kendisinden daha ÖNCELİKLİ (virtualFaces dizisinde daha ÖNCE gelen)
  // kardeşlerin ayak izleri damgalanır. Kullanıcı sırayı değiştirince
  // (reorderVirtualFaceGroup) damga yönü döner → basan↔basılan güncellenir.
  // BAĞ KARARLILIĞI (yüz-ID bağı): VF bölgesi, panelin YÜZE BAĞLI olduğunu
  // temsil eder. Dönmüş panel artık o yüzde düz bir panel değildir — ayak izi
  // açıyla büyüdükçe yüzeyi süpürür ve komşu VF'nin seed'ini örter; bölge
  // hesabı komşuyu yanlış bölgeye taşır ("dönen panelin üstüne fırladı").
  // Dönmüş panelin yüzeyle geometrik etkileşimi Phase B'de (gönye/gövde kesimi)
  // yapılır — VF bölgesine HİÇBİR ZAMAN damgalanmaz. Yalnızca DÜZ ve önceliği
  // yüksek (VF dizisinde daha önce gelen) kardeşler damgalar.
  const vfIndexOf = new Map<string, number>();
  virtualFaces.forEach((f, i) => vfIndexOf.set(f.id, i));
  const panelPriority = (p: any): number => {
    const idx = vfIndexOf.get(p?.parameters?.virtualFaceId);
    return idx != null ? idx : Number.MAX_SAFE_INTEGER;
  };
  const isRotatedPanel = (p: any): boolean => {
    const t = p?.parameters?.transformSteps;
    if (Array.isArray(t) && t.some((st: any) => st?.type === 'rotate')) return true;
    const rs = p?.parameters?.rotateSteps;
    return Array.isArray(rs) && rs.length > 0;
  };
  const hasExtrudeSteps = (p: any): boolean => {
    const es = p?.parameters?.extrudeSteps;
    return Array.isArray(es) && es.length > 0;
  };
  const hasExtrudeTowardFace = (p: any, targetFaceNormal: THREE.Vector3): boolean => {
    const es = p?.parameters?.extrudeSteps;
    if (!Array.isArray(es) || es.length === 0) return false;
    for (const step of es) {
      if (!step.faceNormal) continue;
      const eN = new THREE.Vector3(...step.faceNormal).normalize();
      if (eN.dot(targetFaceNormal) > 0.7) return true;
    }
    return false;
  };
  const hasMoveSteps = (p: any): boolean => {
    const t = p?.parameters?.transformSteps;
    return Array.isArray(t) && t.some((st: any) => st?.type === 'move');
  };
  const extrudeRefsOf = (panel: any): Set<string> => {
    const ids = new Set<string>();
    const es = panel?.parameters?.extrudeSteps;
    if (Array.isArray(es)) {
      for (const step of es) {
        if (step.refShapeId) ids.add(step.refShapeId);
      }
    }
    return ids;
  };
  // ── ÖN-GEÇİŞ: Damga geometrisi için VF köşelerini güncel geometriden tazele ──
  // stampingPanelsFor() giriş virtualFaces dizisinden okur; bu dizi BİR ÖNCEKİ
  // döngünün sonucudur. Kutu boyutlandığında köşeler eskidir → damga ayak izi
  // taşar → "yüz yok oldu" tetiklenir. Ön-geçiş TÜM VF'lerin köşelerini güncel
  // geometriden çıkarır; stampingPanelsFor bu haritaya başvurur.
  const freshVfVertices = new Map<string, [number,number,number][]>();
  for (const vf of shapeFaces) {
    const mg = findMatchingFaceGroup(vf, faces, faceGroups, shape.geometry);
    if (mg) {
      const ln = mg.normal.clone().normalize();
      const sd = new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]);
      const ct = computeFaceComponentContour(faces, mg.faceIndices, sd, ln);
      if (ct && ct.corners.length >= 3) {
        freshVfVertices.set(vf.id, ct.corners.map((c: THREE.Vector3) => [c.x, c.y, c.z] as [number,number,number]));
        continue;
      }
    }
    if (vf.vertices && vf.vertices.length >= 3) {
      freshVfVertices.set(vf.id, vf.vertices);
    }
  }

  const stampingPanelsFor = (vfId: string): any[] => {
    const myIdx = vfIndexOf.get(vfId);
    const myPanel = childPanels.find(p => p.parameters?.virtualFaceId === vfId);
    const myVf = virtualFaces.find(f => f.id === vfId);
    const myFaceNormal = myVf ? new THREE.Vector3(...myVf.normal).normalize() : null;
    return childPanels
      .filter(p => {
        if (p.parameters?.virtualFaceId === vfId) return false;
        if (myPanel && extrudeRefsOf(myPanel).has(p.id)) return false;
        if (myPanel && extrudeRefsOf(p).has(myPanel.id)) return true;
        // FARKLI YÜZDEKİ TAŞINMIŞ/EXTRUDE'LU PANEL: Bu panel move veya
        // extrude adımı taşıyorsa ve myPanel'den FARKLI bir yüzdeyse (dik
        // komşu), VF sırasından BAĞIMSIZ olarak damgalar. Taşınan/extrude'lu
        // panel fiziksel olarak myPanel'in yüzüne girmiş olabilir; eski
        // salt-index kuralı bunu yakalayamıyordu (üst panele kardeşN=0).
        const pVfId = p.parameters?.virtualFaceId;
        if (pVfId && myFaceNormal) {
          const pVf = virtualFaces.find(f => f.id === pVfId);
          if (pVf) {
            const pNormal = new THREE.Vector3(...pVf.normal).normalize();
            const sameFace = Math.abs(myFaceNormal.dot(pNormal)) > 0.95;
            if (!sameFace && (hasMoveSteps(p) || hasExtrudeTowardFace(p, myFaceNormal))) return true;
          }
        }
        return myIdx != null && panelPriority(p) < myIdx;
      })
      .map(p => {
        // composeSteps (move/rotate) → footprint fonksiyonlarının dünya
        // çerçevesinde uygulayacağı ops (extrude HARİÇ). Hem dönmüş hem
        // extrude'lu panelde kullanılır.
        const ownVfRaw = virtualFaces.find(f => f.id === (p.parameters as any)?.virtualFaceId);
        const ownVfFreshVerts = freshVfVertices.get((p.parameters as any)?.virtualFaceId);
        const ownVf = ownVfRaw && ownVfFreshVerts ? { ...ownVfRaw, vertices: ownVfFreshVerts } : ownVfRaw;
        const composedFromSteps = (): RotOp[] | undefined => {
          if (!ownVf) return undefined;
          try {
            const { ops } = composeSteps(getUnifiedSteps(p), ownVf);
            return ops.map((o: any) =>
              o.kind === 'rotate'
                ? { kind: 'rotate', pivot: o.pivot, axis: o.axis, angleRad: (o.deg * Math.PI) / 180 }
                : { kind: 'translate', d: o.d }
            );
          } catch { return undefined; }
        };

        // ── EXTRUDE'LU PANEL: KENAR-DUYARLI DAMGA SEÇİMİ ──
        // Extrude yönü bu VF'nin yüz normaline bakıyorsa (dot > 0.7): taban
        // (VF) geometrisini kullan — extrude büyümesi komşuya YANSIMAZ.
        // Extrude yönü bu VF ile İLGİSİZ ise (farklı eksen): VF-tabanlı
        // geometriyi extrude miktarı kadar BUDAYARAK kullan. Böylece:
        //   1) Ayak izi extrude kısalmasını doğru yansıtır (tam VF değil).
        //   2) VF köşeleri her zaman günceldir → kutu boyut değişimlerinde
        //      ESKİ (stale) baked geometri kullanılmaz, "yüz yok oldu"
        //      hatasına düşülmez.
        if (hasExtrudeSteps(p) && ownVf) {
          const th = parseFloat((p.parameters as any)?.panelThickness) || 18;
          const es = (p.parameters as any)?.extrudeSteps;
          if (myFaceNormal && hasExtrudeTowardFace(p, myFaceNormal)) {
            const baseGeo = baseStampGeometryFromVf(ownVf, th);
            if (baseGeo) {
              return { ...p, geometry: baseGeo, __isRotatedPanel: true, __composedOps: composedFromSteps() || [] };
            }
          } else if (Array.isArray(es) && es.length > 0 && myFaceNormal) {
            const trimGeo = trimmedStampGeometryFromVf(ownVf, th, es, myFaceNormal);
            if (trimGeo) {
              return { ...p, geometry: trimGeo, __isRotatedPanel: true, __composedOps: composedFromSteps() || [] };
            }
          }
        }

        if (!isRotatedPanel(p)) return p;

        // ── DÖNMÜŞ (extrude'suz) PANEL: eski davranış (canlı mesh + composeSteps). ──
        return { ...p, __isRotatedPanel: true, __composedOps: composedFromSteps() };
      });
  };

  const updatedMap = new Map<string, VirtualFace>();

  for (const vf of shapeFaces) {
    if (vf.parentFaceShape) {
      // TAM YÜZ MODELİ: yalnız yeni (parentFaceShape) VF'ler kontur regen'ine
      // girer. ESKİ ışın-reçeteli VF'ler BİLEREK regen dışıdır: onları yüz
      // konturuna yönlendirmek, VF'yi merkezlerine yakın YANLIŞ bir parent
      // yüzüne (ör. bölmenin 10mm yanındaki çentik yanağına) savuruyor ve
      // ikinci rebuild dalgasında tüm panelleri kaydırıyordu ("ilk yarım
      // saniye doğru, sonra bozuluyor"). Eski VF'ler else dalında yalnızca
      // kırpılır; yüzleri ve merkezleri değişmez.
      const regen = regenerateParentFaceShapeVF(
        vf, shape, faces, faceGroups, localToWorld, worldToLocal,
        stampingPanelsFor(vf.id)
      );
      updatedMap.set(vf.id, regen || vf);
    } else {
      const subtractions = shape.subtractionGeometries || [];
      const panelsExcludingSelf = stampingPanelsFor(vf.id);
      const clipped = clipVirtualFaceAgainstSubtractionsAndPanels(
        vf, subtractions, panelsExcludingSelf, localToWorld, worldToLocal
      );
      updatedMap.set(vf.id, clipped || vf);
    }
  }

  return virtualFaces.map(vf => updatedMap.get(vf.id) || vf);
}

function regenerateParentFaceShapeVF(
  vf: VirtualFace,
  shape: Shape,
  faces: FaceData[],
  faceGroups: CoplanarFaceGroup[],
  localToWorld: THREE.Matrix4,
  worldToLocal: THREE.Matrix4,
  siblingPanels: any[] = []
): VirtualFace | null {
  // TAM YÜZ MODELİ: VF, eşleşen yüz grubunda VF merkezine en yakın üçgenin
  // BAĞLANTILI BİLEŞENİNİN gerçek konturu olarak yeniden üretilir (yakalama
  // ile — buildFacePreview — birebir aynı mantık). Küp/subtractor değişince
  // kontur güncel kesilmiş geometriden gelir; ayrık eş-düzlem parçalar asla
  // birleşmez, merkez bileşenle birlikte taşınır.
  const matchedGroup = findMatchingFaceGroup(vf, faces, faceGroups, shape.geometry);
  if (!matchedGroup) return null;

  // YAKALAMA İLE TAM SİMETRİ: yakalama (buildFacePreview) grubu OLDUĞU GİBİ
  // kullanır ve kontur doğru çıkar. Regen'in eski strict-coplanar filtresi
  // EKSENEL OLMAYAN (eğik kesilmiş) yüzlerde üçgenlerin çoğunu eleyip grubu
  // kopuk adacıklara bölüyordu; seed'in adası 18mm'lik mini parça kalıyor,
  // VF normal/merkez bozulup panel YAN yüze savruluyordu (log kanıtı:
  // köşeN 42→4, konturBBoxU 0..18, seedYüzMerkez x=0). Filtre kaldırıldı;
  // normal de yakalamadaki gibi GRUP normalidir.
  const localNormal = matchedGroup.normal.clone().normalize();
  const seed = new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]);
  const contour = computeFaceComponentContour(faces, matchedGroup.faceIndices, seed, localNormal);
  if (!contour) return null;

  // BÖLGE KİMLİĞİ PARAMETRİK TAŞINIR: merkez, kullanıcının tıklama noktasıdır
  // ve bileşen merkezine ÇÖKERTİLMEZ (aynı yüzdeki iki panelin kimliklerini
  // özdeşleştirip üst üste bindiriyordu / ölçüyü 0 yapıyordu). Eski konturun
  // u/v bbox'ındaki ORANI korunarak yeni kontur bbox'ına taşınır — küp
  // büyüyünce merkez oransal hareket eder, farklı panellerin merkezleri
  // farklı kalır.
  const { u, v } = getFacePlaneAxes(localNormal);
  const uvOf = (p3: THREE.Vector3) => ({ x: p3.dot(u), y: p3.dot(v) });
  const bboxOf = (pts: { x: number; y: number }[]) => {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const q of pts) { xMin = Math.min(xMin, q.x); xMax = Math.max(xMax, q.x); yMin = Math.min(yMin, q.y); yMax = Math.max(yMax, q.y); }
    return { xMin, xMax, yMin, yMax, xSpan: Math.max(xMax - xMin, 1e-6), ySpan: Math.max(yMax - yMin, 1e-6) };
  };
  const cUV = uvOf(seed);
  const newB = bboxOf(contour.corners.map(c => uvOf(c)));
  // ORAN TABANI SİMETRİSİ: Oran, bir önceki regen'in kaydettiği HAM kontur
  // bbox'ına (rawFaceBBox) göre hesaplanır ve yeni HAM kontur bbox'ına
  // haritalanır — İKİ UÇTA AYNI TABAN. Eski hata: oran, ayak izi ÇIKARILMIŞ
  // vf.vertices bbox'ından (kardeşe bağımlı, ör. v[320..600]) hesaplanıp HAM
  // yüz bbox'ına (v[0..600]) haritalanıyordu; her rebuild dalgasında merkez
  // sistematik kayıp clamp ile yüz kenarına yapışıyordu (log kanıtı:
  // 443.1 → (443.1-320)/280×600 = 263.8 → clamp(263.5-320)/280=0 → 0.0).
  // rawFaceBBox yoksa (ilk regen / eski VF) merkez MUTLAK korunur (anchorB =
  // newB → birim dönüşüm): yüz değişmediyse zaten doğru; değiştiyse bir
  // sonraki turdan itibaren kayıtlı ham taban devrededir. Kardeş hareketi VF
  // oran tabanını artık asla oynatamaz.
  const anchorB = (vf as any).rawFaceBBox as ReturnType<typeof bboxOf> | undefined ?? newB;
  const ru = Math.max(0, Math.min(1, (cUV.x - anchorB.xMin) / anchorB.xSpan));
  const rv = Math.max(0, Math.min(1, (cUV.y - anchorB.yMin) / anchorB.ySpan));
  const planeN = contour.corners[0].dot(localNormal);
  const newCenter = new THREE.Vector3()
    .addScaledVector(u, newB.xMin + ru * newB.xSpan)
    .addScaledVector(v, newB.yMin + rv * newB.ySpan)
    .addScaledVector(localNormal, planeN);

  // KIRPMA: yakalama ile AYNI fonksiyon. Eskiden burada ham kontur yazılıyordu
  // ve tık anında doğru kırpılmış VF, ilk REGEN'de tam yüzle geri eziliyordu.
  // Artık iki yol tek kaynaktan beslendiği için ayrışamazlar.
  let cornersOut = contour.corners;

  // TEŞHİS: Her kardeşin BU yüz düzlemindeki ayak izinin gerçek u×v boyutu ve
  // modu (yatık/kesit). "Sağ panel v%58 çöktü" hatasında ayak izini büyüten
  // kardeşi ve ayak izinin gerçekten büyük mü yoksa footprint'e YANLIŞ geometri
  // mi girdiğini gösterir. planeN = yüz düzleminin normal-ofseti.
  try {
    for (const sp of siblingPanels) {
      const fp = panelFootprintInParentLocal(sp, worldToLocal, localNormal, planeN, u, v);
      if (!fp) { continue; }
      let fuMin = Infinity, fuMax = -Infinity, fvMin = Infinity, fvMax = -Infinity;
      for (const q of fp) { fuMin = Math.min(fuMin, q.x); fuMax = Math.max(fuMax, q.x); fvMin = Math.min(fvMin, q.y); fvMax = Math.max(fvMax, q.y); }
      const rot = (sp.parameters?.rotateSteps?.length ?? 0) > 0;
      console.log('[YAGO][AYAKİZİ]', vf.id, '<-', sp.id,
        'boyut=', `${(fuMax - fuMin).toFixed(0)}x${(fvMax - fvMin).toFixed(0)}`,
        'u=', `${fuMin.toFixed(0)}..${fuMax.toFixed(0)}`,
        'v=', `${fvMin.toFixed(0)}..${fvMax.toFixed(0)}`,
        'köşeN=', fp.length, rot ? 'DÖNMÜŞ' : 'düz');
    }
  } catch { /* teşhis opsiyonel */ }

  // BÖLGE SÜREKLİLİĞİ: vf.vertices önceki bölge çokgenidir. Dönmüş kardeşin
  // şeridi yüzü ikiye bölüp statik seed'in üstünden süpürüldüğünde (-32°→-33°
  // taraf zıplaması) bileşen seçimi önceki bölgeyle örtüşmeye göre yapılır.
  const prevRegion = (vf.vertices && vf.vertices.length >= 3)
    ? vf.vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z))
    : undefined;
  // KALICI BAĞ İLİŞKİSİ: önceki regen'lerin kaydettiği kardeş→taraf işaretleri
  // kısıt olarak geçilir; taraf seçimi deterministikleşir (öneri: Goker).
  const storedRel = (vf as any).sideRelations as Record<string, number> | undefined;
  const region = computeFreeRegionLocal(
    contour.corners, localNormal, seed, siblingPanels, worldToLocal, shape.id, prevRegion, storedRel
  );
  if (region && region.polygon.length >= 3) {
    cornersOut = region.polygon.map(p2 => new THREE.Vector3()
      .addScaledVector(u, p2.x).addScaledVector(v, p2.y)
      .addScaledVector(localNormal, planeN));
  }

  // TEŞHİS: Regen'in ÜRETTİĞİ VF çokgeninin gerçek u/v boyutu. Kıymık
  // (sliver) ise iki boyuttan biri çok küçük olur — böylece "sağ panel kıymık"
  // hatasının regen'de mi (VF gerçekten ince üretiliyor) yoksa rebuild
  // kesiminde mi (VF dolu ama panel yanlış biçiliyor) doğduğu log'dan KESİN
  // ayrılır. outSpan çıkarma öncesi HAM kontura oranlanır: ayak izi bölgeyi
  // ne kadar çökertti?
  let outUMin = Infinity, outUMax = -Infinity, outVMin = Infinity, outVMax = -Infinity;
  for (const c of cornersOut) {
    const pu = c.dot(u), pv = c.dot(v);
    outUMin = Math.min(outUMin, pu); outUMax = Math.max(outUMax, pu);
    outVMin = Math.min(outVMin, pv); outVMax = Math.max(outVMax, pv);
  }
  const outUSpan = outUMax - outUMin, outVSpan = outVMax - outVMin;
  const rawUSpan = newB.xSpan, rawVSpan = newB.ySpan;
  const uShrink = (1 - outUSpan / Math.max(rawUSpan, 1e-6));
  const vShrink = (1 - outVSpan / Math.max(rawVSpan, 1e-6));
  const isSliver = outUSpan < 30 || outVSpan < 30;

  console.log('[YAGO][REGEN]', vf.id,
    'yeniMerkez=', [newCenter.x, newCenter.y, newCenter.z].map(n => n.toFixed(1)).join(','),
    'hamKöşeN=', contour.corners.length, 'VFköşeN=', cornersOut.length,
    'ayakİziN=', region ? region.footprints.length : -1,
    'kardeşN=', siblingPanels.length,
    'oranTabanı=', (vf as any).rawFaceBBox ? 'kayıtlıHam' : 'mutlak(ilk)',
    'VFboyut=', `${outUSpan.toFixed(0)}x${outVSpan.toFixed(0)}`,
    'küçülme=', `u%${(uShrink * 100).toFixed(0)} v%${(vShrink * 100).toFixed(0)}`,
    isSliver ? '⚠️KIYMIK(regen)' : 'dolu');
  const out: VirtualFace = {
    ...vf,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    vertices: cornersOut.map(c => [c.x, c.y, c.z] as [number, number, number]),
    center: [newCenter.x, newCenter.y, newCenter.z],
  };
  // HAM kontur bbox'ı bir SONRAKİ regen'in oran tabanı olarak VF'de taşınır
  // (tip dışı alan; spread kopyalarında korunur). vf.vertices ayak izi
  // çıkarılmış bölge olduğundan oran tabanı olarak ASLA kullanılamaz.
  (out as any).rawFaceBBox = {
    xMin: newB.xMin, xMax: newB.xMax, yMin: newB.yMin, yMax: newB.yMax,
    xSpan: newB.xSpan, ySpan: newB.ySpan,
  };
  // BAĞ İLİŞKİLERİ KALICILAŞTIRMA: yeni hesaplanan taraf işaretleri, eski
  // kayıtların ÜZERİNE birleştirilir. Birleştirme sayesinde bir kardeşin ayak
  // izi geçici bir dalgada kaybolsa bile (rebuild transienti) eski kaydı
  // korunur; kardeş geri geldiğinde aynı tarafa bağlanır. Silinmiş panellerin
  // bayat kayıtları zararsızdır (id bir daha eşleşmez).
  (out as any).sideRelations = { ...(storedRel || {}), ...(region?.sideRelations || {}) };
  return out;
}

interface RotOp {
  kind?: 'rotate' | 'translate';
  pivot?: THREE.Vector3;
  axis?: THREE.Vector3;
  angleRad?: number;
  d?: THREE.Vector3;
}

function buildRotationOps(panel: any): RotOp[] {
  // composeSteps ile önceden çözülmüş (doğru pivot + zincirlenmiş eksen) ops
  // varsa onu kullan — gerçek panel dönüşüyle bire bir.
  if (Array.isArray(panel?.__composedOps)) return panel.__composedOps;
  const params = panel?.parameters;
  if (!params) return [];
  const steps: any[] = [];
  if (Array.isArray(params.transformSteps)) {
    for (const s of params.transformSteps) {
      if (s?.type === 'rotate') steps.push(s);
    }
  } else if (Array.isArray(params.rotateSteps)) {
    for (const s of params.rotateSteps) steps.push(s);
  }
  if (steps.length === 0) return [];
  const ops: RotOp[] = [];
  for (const s of steps) {
    const deg = s.value || 0;
    if (Math.abs(deg) < 1e-6) continue;
    const angleRad = (deg * Math.PI) / 180;
    const axis = s.axisVec
      ? new THREE.Vector3(...s.axisVec).normalize()
      : axisToVec(s.axis);
    const pivot = s.pivot
      ? new THREE.Vector3(...s.pivot)
      : new THREE.Vector3();
    ops.push({ pivot, axis, angleRad });
  }
  return ops;
}

function axisToVec(a: string): THREE.Vector3 {
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

function getPanelFootprints2D(
  panels: any[],
  facePlaneNormal: THREE.Vector3,
  facePlaneOrigin: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  planeTolerance = 2.0
): Point2D[][] {
  const footprints: Point2D[][] = [];
  for (const panel of panels) {
    if (!panel.geometry) continue;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...panel.position),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(panel.rotation[0], panel.rotation[1], panel.rotation[2], 'XYZ')
      ),
      new THREE.Vector3(...panel.scale)
    );

    // DÖNMÜŞ PANEL: composeSteps'ten çözülmüş DOĞRU dönüşüm düz köşelere
    // uygulanır, ardından TÜM köşeler hedef düzleme izdüşürülür (tam siluet).
    if (panel.__isRotatedPanel) {
      const posAttr = panel.geometry.getAttribute('position');
      if (!posAttr) continue;
      const rotOps = buildRotationOps(panel);
      const rOut: Point2D[] = [];
      let minD = Infinity, maxD = -Infinity;
      for (let i = 0; i < posAttr.count; i++) {
        const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(m);
        for (const op of rotOps) {
          if (op.kind === 'translate') { if (op.d) wp.add(op.d); }
          else if (op.pivot && op.axis) { wp.sub(op.pivot); wp.applyAxisAngle(op.axis, op.angleRad || 0); wp.add(op.pivot); }
        }
        const d = facePlaneNormal.dot(new THREE.Vector3().subVectors(wp, facePlaneOrigin));
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
        rOut.push(projectTo2D(wp, facePlaneOrigin, u, v));
      }
      // DÜZLEME-DEĞME KONTROLÜ: panel bu VF düzlemine hiç değmiyorsa (tüm köşeler
      // düzlemin AYNI tarafında ve tolerans dışında) footprint ÜRETME. Yoksa PARALEL
      // uzak paneller (üst↔alt) tüm siluetleriyle hedefi tümden kaplayıp "yüz yok
      // oldu → tam kontur" ile paneli büyütüyordu (alt panelin taşması buydu).
      if (minD > planeTolerance || maxD < -planeTolerance) continue;
      if (rOut.length < 3) continue;
      const hull = convexHull2D(rOut);
      if (hull.length >= 3) footprints.push(hull);
      continue;
    }

    const posAttr = panel.geometry.getAttribute('position');
    if (!posAttr) continue;
    const onPlane: Point2D[] = [];
    let minD = Infinity, maxD = -Infinity;
    for (let i = 0; i < posAttr.count; i++) {
      const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(m);
      const d = facePlaneNormal.dot(new THREE.Vector3().subVectors(wp, facePlaneOrigin));
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
      if (Math.abs(d) < planeTolerance) {
        onPlane.push(projectTo2D(wp, facePlaneOrigin, u, v));
      }
    }
    // DÜZLEME-DEĞME KONTROLÜ (yukarıdaki rotated yolla aynı gerekçe): panel bu VF
    // düzlemine değmiyorsa footprint üretme — paralel uzak panel tam kaplayamaz.
    if (minD > planeTolerance || maxD < -planeTolerance) continue;
    if (onPlane.length < 3) {
      onPlane.length = 0;
      for (let i = 0; i < posAttr.count; i++) {
        const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(m);
        onPlane.push(projectTo2D(wp, facePlaneOrigin, u, v));
      }
    }
    if (onPlane.length < 3) continue;
    const boundary = meshOnPlaneBoundary2D(panel.geometry, m, facePlaneNormal, facePlaneOrigin, u, v, planeTolerance);
    if (boundary && boundary.length >= 3) { footprints.push(boundary); continue; }
    const hull = convexHull2D(onPlane);
    if (hull.length >= 3) footprints.push(hull);
  }
  return footprints;
}

function clipVirtualFaceAgainstSubtractionsAndPanels(
  vf: VirtualFace,
  subtractions: any[],
  siblingPanels: any[],
  localToWorld: THREE.Matrix4,
  worldToLocal: THREE.Matrix4
): VirtualFace | null {
  if (vf.vertices.length < 3) return null;

  const localNormal = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(localToWorld);
  const worldNormal = localNormal.clone().applyMatrix3(normalMatrix).normalize();
  const { u, v } = getFacePlaneAxes(worldNormal);

  const cornersWorld = vf.vertices.map(vtx =>
    new THREE.Vector3(vtx[0], vtx[1], vtx[2]).applyMatrix4(localToWorld)
  );
  const centerWorld = new THREE.Vector3();
  cornersWorld.forEach(c => centerWorld.add(c));
  centerWorld.divideScalar(cornersWorld.length);
  const planeOrigin = centerWorld.clone();

  let poly: Point2D[] = ensureCCW(
    cornersWorld.map(c => projectTo2D(c, planeOrigin, u, v))
  );

  const subFootprints = getSubtractorFootprints2D(
    subtractions, localToWorld, worldNormal, planeOrigin, u, v, 50
  );
  const panelFootprints = getPanelFootprints2D(
    siblingPanels, worldNormal, planeOrigin, u, v, 3.0
  );
  const allFootprints = [...subFootprints, ...panelFootprints];

  let changed = false;
  for (const fp of allFootprints) {
    const ccwFp = ensureCCW(fp);
    const hasOverlap =
      ccwFp.some(p => isPointInsidePolygon(p, poly)) ||
      poly.some(p => isPointInsidePolygon(p, ccwFp));
    if (hasOverlap) {
      poly = subtractPolygon(poly, ccwFp);
      changed = true;
    }
  }

  if (!changed) return null;
  if (poly.length < 3) return null;

  const newCornersLocal = poly.map(p =>
    planeOrigin.clone().addScaledVector(u, p.x).addScaledVector(v, p.y).applyMatrix4(worldToLocal)
  );
  const newCenter = new THREE.Vector3();
  newCornersLocal.forEach(c => newCenter.add(c));
  newCenter.divideScalar(newCornersLocal.length);

  return {
    ...vf,
    vertices: newCornersLocal.map(c => [c.x, c.y, c.z] as [number, number, number]),
    center: [newCenter.x, newCenter.y, newCenter.z],
  };
}

function clipVirtualFaceAgainstSubtractions(
  vf: VirtualFace,
  subtractions: any[],
  localToWorld: THREE.Matrix4,
  worldToLocal: THREE.Matrix4
): VirtualFace | null {
  if (vf.vertices.length < 3) return null;

  const localNormal = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(localToWorld);
  const worldNormal = localNormal.clone().applyMatrix3(normalMatrix).normalize();

  const { u, v } = getFacePlaneAxes(worldNormal);

  const cornersWorld = vf.vertices.map(vtx =>
    new THREE.Vector3(vtx[0], vtx[1], vtx[2]).applyMatrix4(localToWorld)
  );

  const centerWorld = new THREE.Vector3();
  cornersWorld.forEach(c => centerWorld.add(c));
  centerWorld.divideScalar(cornersWorld.length);
  const planeOrigin = centerWorld.clone();

  const poly2D: Point2D[] = cornersWorld.map(c => projectTo2D(c, planeOrigin, u, v));
  let clippedPoly = ensureCCW(poly2D);

  const footprints = getSubtractorFootprints2D(
    subtractions, localToWorld, worldNormal, planeOrigin, u, v, 50
  );

  if (footprints.length === 0) return null;

  let changed = false;
  for (const footprint of footprints) {
    const ccwFootprint = ensureCCW(footprint);
    const hasOverlap =
      ccwFootprint.some(p => isPointInsidePolygon(p, clippedPoly)) ||
      clippedPoly.some(p => isPointInsidePolygon(p, ccwFootprint));
    if (hasOverlap) {
      clippedPoly = subtractPolygon(clippedPoly, ccwFootprint);
      changed = true;
    }
  }

  if (!changed) return null;
  if (clippedPoly.length < 3) return null;

  const newCornersLocal = clippedPoly.map(p =>
    planeOrigin.clone().addScaledVector(u, p.x).addScaledVector(v, p.y).applyMatrix4(worldToLocal)
  );

  const newCenter = new THREE.Vector3();
  newCornersLocal.forEach(c => newCenter.add(c));
  newCenter.divideScalar(newCornersLocal.length);

  return {
    ...vf,
    vertices: newCornersLocal.map(c => [c.x, c.y, c.z] as [number, number, number]),
    center: [newCenter.x, newCenter.y, newCenter.z],
  };
}
