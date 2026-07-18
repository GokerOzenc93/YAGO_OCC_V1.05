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
  projectTo2D,
  subtractPolygon,
  type Point2D,
} from './FaceRaycastOverlay';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  findFaceByDescriptor,
  type FaceData,
  type CoplanarFaceGroup,
} from './FaceEditor';

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

  if (vf.faceGroupDescriptor) {
    const matchedFace = findFaceByDescriptor(vf.faceGroupDescriptor, faces, geometry);
    if (matchedFace) {
      const matchedGroup = candidateGroups.find(g =>
        g.faceIndices.includes(matchedFace.faceIndex)
      );
      if (matchedGroup) return matchedGroup;
    }
  }

  if (candidateGroups.length === 1) return candidateGroups[0];

  let bestGroup: CoplanarFaceGroup | null = null;

  const vfPlaneOffset = vfCenter.dot(vfNormal);
  let bestPlaneDiff = Infinity;
  for (const group of candidateGroups) {
    const groupNormal = group.normal.clone().normalize();
    const groupPlaneOffset = group.center.dot(groupNormal);
    const planeDiff = Math.abs(groupPlaneOffset - vfPlaneOffset);
    if (planeDiff < bestPlaneDiff) {
      bestPlaneDiff = planeDiff;
      bestGroup = group;
    }
  }

  if (bestGroup && bestPlaneDiff < 5) return bestGroup;

  let bestDist = Infinity;
  bestGroup = null;
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

function filterStrictCoplanarIndices(
  faces: FaceData[],
  groupIndices: number[],
  localToWorld: THREE.Matrix4,
  normalMatrix: THREE.Matrix3,
  normalDotTol: number = 0.99999,
  planeDistTol: number = 0.05
): number[] {
  if (groupIndices.length === 0) return [];
  let bestIdx = groupIndices[0];
  let bestArea = 0;
  for (const fi of groupIndices) {
    const face = faces[fi];
    if (!face) continue;
    const a = face.vertices[0], b = face.vertices[1], c = face.vertices[2];
    const area = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(b, a),
      new THREE.Vector3().subVectors(c, a)
    ).length();
    if (area > bestArea) { bestArea = area; bestIdx = fi; }
  }
  const refFace = faces[bestIdx];
  const refNormalW = refFace.normal.clone().applyMatrix3(normalMatrix).normalize();
  const refPointW = refFace.center.clone().applyMatrix4(localToWorld);
  const result: number[] = [];
  for (const fi of groupIndices) {
    const face = faces[fi];
    if (!face) continue;
    const nW = face.normal.clone().applyMatrix3(normalMatrix).normalize();
    if (nW.dot(refNormalW) < normalDotTol) continue;
    let maxPlaneDist = 0;
    for (const vLocal of face.vertices) {
      const vW = vLocal.clone().applyMatrix4(localToWorld);
      const d = Math.abs(refNormalW.dot(new THREE.Vector3().subVectors(vW, refPointW)));
      if (d > maxPlaneDist) maxPlaneDist = d;
    }
    if (maxPlaneDist > planeDistTol) continue;
    result.push(fi);
  }
  return result.length > 0 ? result : groupIndices;
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

  const updatedMap = new Map<string, VirtualFace>();

  for (const vf of shapeFaces) {
    if (vf.parentFaceShape || (vf as any).raycastRecipe) {
      // TAM YÜZ MODELİ: tüm paneller yüz konturu VF'sidir. Eski ışın-reçeteli
      // (raycastRecipe) kayıtlar da aynı yola yönlendirilir — merkezlerine en
      // yakın yüz bileşeninin konturuna zarifçe göç ederler.
      const regen = regenerateParentFaceShapeVF(vf, shape, faces, faceGroups, localToWorld);
      updatedMap.set(vf.id, regen || vf);
    } else {
      const subtractions = shape.subtractionGeometries || [];
      const panelsExcludingSelf = childPanels.filter(
        p => p.parameters?.virtualFaceId !== vf.id
      );
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
  localToWorld: THREE.Matrix4
): VirtualFace | null {
  // TAM YÜZ MODELİ: VF, eşleşen yüz grubunda VF merkezine en yakın üçgenin
  // BAĞLANTILI BİLEŞENİNİN gerçek konturu olarak yeniden üretilir (yakalama
  // ile — buildFacePreview — birebir aynı mantık). Küp/subtractor değişince
  // kontur güncel kesilmiş geometriden gelir; ayrık eş-düzlem parçalar asla
  // birleşmez, merkez bileşenle birlikte taşınır.
  const matchedGroup = findMatchingFaceGroup(vf, faces, faceGroups, shape.geometry);
  if (!matchedGroup) return null;

  const normalMatrix = new THREE.Matrix3().getNormalMatrix(localToWorld);
  const strictIndices = filterStrictCoplanarIndices(
    faces, matchedGroup.faceIndices, localToWorld, normalMatrix
  );
  if (strictIndices.length === 0) return null;

  const refFace = faces[strictIndices[0]];
  const localNormal = refFace ? refFace.normal.clone().normalize() : matchedGroup.normal.clone().normalize();
  const seed = new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]);
  const contour = computeFaceComponentContour(faces, strictIndices, seed, localNormal);
  if (!contour) return null;

  return {
    ...vf,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    vertices: contour.corners.map(c => [c.x, c.y, c.z] as [number, number, number]),
    center: [contour.center.x, contour.center.y, contour.center.z],
  };
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
    const posAttr = panel.geometry.getAttribute('position');
    if (!posAttr) continue;
    const onPlane: Point2D[] = [];
    for (let i = 0; i < posAttr.count; i++) {
      const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(m);
      const d = facePlaneNormal.dot(new THREE.Vector3().subVectors(wp, facePlaneOrigin));
      if (Math.abs(d) < planeTolerance) {
        onPlane.push(projectTo2D(wp, facePlaneOrigin, u, v));
      }
    }
    // Fallback: project ALL vertices when on-plane count is too low
    if (onPlane.length < 3) {
      onPlane.length = 0;
      for (let i = 0; i < posAttr.count; i++) {
        const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(m);
        onPlane.push(projectTo2D(wp, facePlaneOrigin, u, v));
      }
    }
    if (onPlane.length < 3) continue;
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
