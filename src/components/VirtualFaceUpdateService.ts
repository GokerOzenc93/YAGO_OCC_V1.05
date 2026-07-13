import * as THREE from 'three';
import type { VirtualFace, Shape, EdgeAnchor, NormalizedHitDistances, RaycastAnchorOwners } from '../store';
import {
  getFacePlaneAxes,
  getShapeMatrix,
  getSubtractorFootprints2D,
  projectTo2D,
  subtractPolygon,
  ensureCCW,
  isPointInsidePolygon,
  collectBoundaryEdgesWorld,
  collectPanelObstacleEdgesWorld,
  collectSubtractionObstacleEdgesWorld,
  collectVirtualFaceObstacleEdgesWorld,
  collectCoplanarAlignedVfIds,
  reduceRegionToRectangle2D,
  collectCoplanarAlignedVfIds,
  castRayOnFaceWorld,
  castRayOnFaceWorldDetailed,
  clipPolygonByLine2D,
  computeVisibilityPolygon2D,
  simplifyCollinear2D,
  convexHull2D,
  pickDominantEdgeDirection,
  getSubtractionWorldMatrix,
  type Point2D,
} from './FaceRaycastOverlay';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  findFaceByDescriptor,
  type FaceData,
  type CoplanarFaceGroup,
} from './FaceEditor';

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

  // Step 1: Find groups on the same plane (matching plane offset along normal).
  // Among all coplanar candidates, pick the one whose center is closest to the
  // VF center. This correctly disambiguates multiple coplanar face groups (e.g.
  // inner vs outer faces of an L-shape) even when both have identical plane
  // offsets — the VF center lies within (or nearest to) the correct group.
  const vfPlaneOffset = vfCenter.dot(vfNormal);
  const PLANE_TOL = 5;
  const coplanarCandidates: CoplanarFaceGroup[] = [];
  let minPlaneDiff = Infinity;
  for (const group of candidateGroups) {
    const groupNormal = group.normal.clone().normalize();
    const planeDiff = Math.abs(group.center.dot(groupNormal) - vfPlaneOffset);
    if (planeDiff < minPlaneDiff) minPlaneDiff = planeDiff;
    if (planeDiff < PLANE_TOL) coplanarCandidates.push(group);
  }

  // Also accept the single best-plane-match if none fall within tolerance
  if (coplanarCandidates.length === 0) {
    for (const group of candidateGroups) {
      const groupNormal = group.normal.clone().normalize();
      const planeDiff = Math.abs(group.center.dot(groupNormal) - vfPlaneOffset);
      if (planeDiff === minPlaneDiff) { coplanarCandidates.push(group); break; }
    }
  }

  if (coplanarCandidates.length === 1) return coplanarCandidates[0];
  if (coplanarCandidates.length > 1) {
    // Multiple groups on the same plane — pick the one whose center is closest
    // to the VF center (both are in the plane so this is the in-plane distance).
    let bestDist = Infinity;
    for (const group of coplanarCandidates) {
      const dist = vfCenter.distanceTo(group.center);
      if (dist < bestDist) { bestDist = dist; bestGroup = group; }
    }
    if (bestGroup) return bestGroup;
  }



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

function reconstructFromNormalizedDistances(
  vf: VirtualFace,
  nhd: NormalizedHitDistances,
  groupVerticesWorld: THREE.Vector3[],
  worldNormal: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  localToWorld: THREE.Matrix4,
  worldToLocal: THREE.Matrix4,
  localNormal: THREE.Vector3,
  shape: Shape,
  uniqueBoundaryEdgesLocal: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>
): VirtualFace | null {
  const extent = computeFaceGroupExtent(groupVerticesWorld, u, v);
  if (extent.uSpan <= 0 || extent.vSpan <= 0) return null;

  const hitUPos = extent.uMax - nhd.uPosFromEdge;
  const hitUNeg = extent.uMin + nhd.uNegFromEdge;
  const hitVPos = extent.vMax - nhd.vPosFromEdge;
  const hitVNeg = extent.vMin + nhd.vNegFromEdge;

  const refPoint = groupVerticesWorld[0];
  const nComp = refPoint.dot(worldNormal);

  const cornersWorld = [
    buildWorldPoint(hitUPos, hitVPos, nComp, u, v, worldNormal),
    buildWorldPoint(hitUNeg, hitVPos, nComp, u, v, worldNormal),
    buildWorldPoint(hitUNeg, hitVNeg, nComp, u, v, worldNormal),
    buildWorldPoint(hitUPos, hitVNeg, nComp, u, v, worldNormal),
  ];

  const subtractions = shape.subtractionGeometries || [];
  const result = clipAndFinalize(
    cornersWorld, subtractions, localToWorld, worldToLocal, worldNormal, u, v
  );
  if (!result) return null;

  const newAnchors = rebuildAnchorsFromWorldCorners(
    result.cornersLocal, uniqueBoundaryEdgesLocal
  );

  const newNhd: NormalizedHitDistances = {
    uPosFromEdge: nhd.uPosFromEdge,
    uNegFromEdge: nhd.uNegFromEdge,
    vPosFromEdge: nhd.vPosFromEdge,
    vNegFromEdge: nhd.vNegFromEdge,
    uPosIsBoundary: nhd.uPosIsBoundary,
    uNegIsBoundary: nhd.uNegIsBoundary,
    vPosIsBoundary: nhd.vPosIsBoundary,
    vNegIsBoundary: nhd.vNegIsBoundary,
    uPosAbsDist: nhd.uPosAbsDist,
    uNegAbsDist: nhd.uNegAbsDist,
    vPosAbsDist: nhd.vPosAbsDist,
    vNegAbsDist: nhd.vNegAbsDist,
  };

  return {
    ...vf,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    center: [result.centerLocal.x, result.centerLocal.y, result.centerLocal.z],
    vertices: result.cornersLocal.map(c => [c.x, c.y, c.z] as [number, number, number]),
    raycastRecipe: {
      ...vf.raycastRecipe!,
      edgeAnchors: newAnchors.length === 4 ? newAnchors : vf.raycastRecipe!.edgeAnchors,
      normalizedHitDistances: newNhd,
    },
  };
}

function buildWorldPoint(
  uCoord: number, vCoord: number, nComp: number,
  u: THREE.Vector3, v: THREE.Vector3, worldNormal: THREE.Vector3
): THREE.Vector3 {
  return new THREE.Vector3()
    .addScaledVector(u, uCoord)
    .addScaledVector(v, vCoord)
    .addScaledVector(worldNormal, nComp);
}

function clipAndFinalize(
  cornersWorld: THREE.Vector3[],
  subtractions: any[],
  localToWorld: THREE.Matrix4,
  worldToLocal: THREE.Matrix4,
  worldNormal: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3
): { cornersLocal: THREE.Vector3[]; centerLocal: THREE.Vector3 } | null {
  const planeOrigin = new THREE.Vector3();
  cornersWorld.forEach(c => planeOrigin.add(c));
  planeOrigin.divideScalar(cornersWorld.length);

  let poly2D = cornersWorld.map(c => projectTo2D(c, planeOrigin, u, v));
  let clippedPoly = ensureCCW(poly2D);

  if (subtractions.length > 0) {
    const footprints = getSubtractorFootprints2D(
      subtractions, localToWorld, worldNormal, planeOrigin, u, v, 50
    );
    for (const footprint of footprints) {
      const ccwFootprint = ensureCCW(footprint);
      const hasOverlap =
        ccwFootprint.some(p => isPointInsidePolygon(p, clippedPoly)) ||
        clippedPoly.some(p => isPointInsidePolygon(p, ccwFootprint));
      if (hasOverlap) {
        clippedPoly = subtractPolygon(clippedPoly, ccwFootprint);
      }
    }
  }

  if (clippedPoly.length < 3) return null;

  const finalCornersWorld = clippedPoly.map(p =>
    planeOrigin.clone().addScaledVector(u, p.x).addScaledVector(v, p.y)
  );
  const cornersLocal = finalCornersWorld.map(c => c.clone().applyMatrix4(worldToLocal));

  const centerLocal = new THREE.Vector3();
  cornersLocal.forEach(c => centerLocal.add(c));
  centerLocal.divideScalar(cornersLocal.length);

  return { cornersLocal, centerLocal };
}

function rebuildAnchorsFromWorldCorners(
  cornersLocal: THREE.Vector3[],
  boundaryEdgesLocal: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>
): EdgeAnchor[] {
  if (cornersLocal.length < 4 || boundaryEdgesLocal.length === 0) return [];

  const midpoints: { dir: 'u+' | 'u-' | 'v+' | 'v-'; point: THREE.Vector3 }[] = [
    { dir: 'u+', point: cornersLocal[0].clone().add(cornersLocal[3]).multiplyScalar(0.5) },
    { dir: 'u-', point: cornersLocal[1].clone().add(cornersLocal[2]).multiplyScalar(0.5) },
    { dir: 'v+', point: cornersLocal[0].clone().add(cornersLocal[1]).multiplyScalar(0.5) },
    { dir: 'v-', point: cornersLocal[2].clone().add(cornersLocal[3]).multiplyScalar(0.5) },
  ];

  const anchors: EdgeAnchor[] = [];
  for (const { dir, point } of midpoints) {
    let bestEdge: { v1: THREE.Vector3; v2: THREE.Vector3 } | null = null;
    let bestDist = Infinity;
    let bestT = 0;

    for (const edge of boundaryEdgesLocal) {
      const closest = new THREE.Vector3();
      const line = new THREE.Line3(edge.v1, edge.v2);
      line.closestPointToPoint(point, true, closest);
      const dist = closest.distanceTo(point);
      if (dist < bestDist) {
        bestDist = dist;
        bestEdge = edge;
        const eLen = edge.v1.distanceTo(edge.v2);
        bestT = eLen > 1e-8 ? edge.v1.distanceTo(closest) / eLen : 0;
      }
    }

    if (bestEdge) {
      anchors.push({
        edgeV1Local: [bestEdge.v1.x, bestEdge.v1.y, bestEdge.v1.z],
        edgeV2Local: [bestEdge.v2.x, bestEdge.v2.y, bestEdge.v2.z],
        t: Math.max(0, Math.min(1, bestT)),
        direction: dir,
      });
    }
  }

  return anchors;
}

function findMatchingBoundaryEdge(
  anchor: EdgeAnchor,
  boundaryEdgesLocal: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>,
  faceNormalLocal: THREE.Vector3,
  faceGroupCenter: THREE.Vector3
): { edge: { v1: THREE.Vector3; v2: THREE.Vector3 }; t: number } | null {
  const aV1 = new THREE.Vector3(...anchor.edgeV1Local);
  const aV2 = new THREE.Vector3(...anchor.edgeV2Local);
  const aDir = aV2.clone().sub(aV1).normalize();
  const aMid = aV1.clone().add(aV2).multiplyScalar(0.5);

  const crossA = new THREE.Vector3().crossVectors(aDir, faceNormalLocal).normalize();

  const aOffsetFromCenter = aMid.clone().sub(faceGroupCenter);
  const aSideSign = Math.sign(aOffsetFromCenter.dot(crossA));

  let bestEdge: { v1: THREE.Vector3; v2: THREE.Vector3 } | null = null;
  let bestScore = Infinity;
  let bestFlipped = false;

  for (const edge of boundaryEdgesLocal) {
    const eDir = edge.v2.clone().sub(edge.v1).normalize();

    const dirDot = Math.abs(aDir.dot(eDir));
    if (dirDot < 0.7) continue;

    const crossE = new THREE.Vector3().crossVectors(eDir, faceNormalLocal).normalize();
    const sideDot = crossA.dot(crossE);
    if (Math.abs(sideDot) < 0.5) continue;

    const eMid = edge.v1.clone().add(edge.v2).multiplyScalar(0.5);
    const eOffsetFromCenter = eMid.clone().sub(faceGroupCenter);
    const eSideSign = Math.sign(eOffsetFromCenter.dot(crossA));

    if (aSideSign !== 0 && eSideSign !== 0 && aSideSign !== eSideSign) continue;

    const perpDist = Math.abs(eOffsetFromCenter.dot(crossA) - aOffsetFromCenter.dot(crossA));

    const score = perpDist * (2 - dirDot);

    if (score < bestScore) {
      bestScore = score;
      bestEdge = edge;
      bestFlipped = aDir.dot(eDir) < 0;
    }
  }

  if (!bestEdge) return null;

  const newT = bestFlipped ? (1 - anchor.t) : anchor.t;
  return { edge: bestEdge, t: Math.max(0, Math.min(1, newT)) };
}

function reconstructHitPointsFromAnchors(
  anchors: EdgeAnchor[],
  boundaryEdgesLocal: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>,
  localToWorld: THREE.Matrix4,
  faceNormalLocal: THREE.Vector3,
  faceGroupCenter: THREE.Vector3
): Map<string, THREE.Vector3> {
  const result = new Map<string, THREE.Vector3>();

  for (const anchor of anchors) {
    const matched = findMatchingBoundaryEdge(anchor, boundaryEdgesLocal, faceNormalLocal, faceGroupCenter);
    if (!matched) continue;

    const hitLocal = matched.edge.v1.clone().lerp(matched.edge.v2, matched.t);
    const hitWorld = hitLocal.clone().applyMatrix4(localToWorld);
    result.set(anchor.direction, hitWorld);
  }

  return result;
}

function extractUniqueBoundaryEdgesLocal(
  faces: FaceData[],
  faceIndices: number[]
): Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> {
  const edgeMap = new Map<string, { v1: THREE.Vector3; v2: THREE.Vector3; count: number }>();
  faceIndices.forEach(fi => {
    const face = faces[fi];
    if (!face) return;
    const verts = face.vertices;
    for (let i = 0; i < 3; i++) {
      const va = verts[i];
      const vb = verts[(i + 1) % 3];
      const ka = `${va.x.toFixed(2)},${va.y.toFixed(2)},${va.z.toFixed(2)}`;
      const kb = `${vb.x.toFixed(2)},${vb.y.toFixed(2)},${vb.z.toFixed(2)}`;
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, { v1: va.clone(), v2: vb.clone(), count: 0 });
      }
      edgeMap.get(key)!.count++;
    }
  });
  const result: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> = [];
  edgeMap.forEach(e => {
    if (e.count === 1) result.push({ v1: e.v1, v2: e.v2 });
  });
  return result;
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
function collectOwnerFootprintUV(
  ownerId: string,
  panels: any[],
  shapeFaces: VirtualFace[],
  subtractions: any[],
  localToWorld: THREE.Matrix4,
  worldNormal: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  faceNComp: number,
  planeTol: number
): UVPoint[] | null {
  const pts: UVPoint[] = [];
  const push = (wp: THREE.Vector3) => {
    const signed = wp.dot(worldNormal) - faceNComp;
    if (Math.abs(signed) < planeTol) pts.push({ u: wp.dot(u), v: wp.dot(v) });
  };

  if (ownerId.startsWith('panel:')) {
    const id = ownerId.slice(6);
    const panel = panels.find(p => p.id === id);
    if (!panel || !panel.geometry) return null;
    const m = getShapeMatrix(panel);
    const pos = panel.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) return null;
    const tmp = new THREE.Vector3();
    // Panel yüzü DELİP geçiyorsa (kesişim) sadece düzleme yakın köşeler değil,
    // düzlemin iki yanındaki köşeler de dikkate alınmalı: bu durumda ayak izi
    // tüm köşelerin izdüşümüdür.
    let minS = Infinity, maxS = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
      const s = tmp.dot(worldNormal) - faceNComp;
      if (s < minS) minS = s;
      if (s > maxS) maxS = s;
    }
    const crosses = minS < -planeTol && maxS > planeTol;
    for (let i = 0; i < pos.count; i++) {
      tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
      if (crosses) pts.push({ u: tmp.dot(u), v: tmp.dot(v) });
      else push(tmp.clone());
    }
  } else if (ownerId.startsWith('vf:')) {
    const id = ownerId.slice(3);
    const sib = shapeFaces.find(f => f.id === id);
    if (!sib || sib.vertices.length < 3) return null;
    sib.vertices.forEach(([x, y, z]) =>
      push(new THREE.Vector3(x, y, z).applyMatrix4(localToWorld))
    );
  } else if (ownerId.startsWith('sub:')) {
    const idx = parseInt(ownerId.slice(4), 10);
    const sub = subtractions[idx];
    if (!sub || !sub.geometry) return null;
    const m = getSubtractionWorldMatrix(localToWorld, sub);
    const pos = sub.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) return null;
    for (let i = 0; i < pos.count; i++) {
      push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m));
    }
  } else {
    return null;
  }

  return pts.length >= 3 ? pts : null;
}

interface AnchoredOriginResult {
  originU: number;
  originV: number;
  anchoredU: boolean;
  anchoredV: boolean;
}

/**
 * Kökeni, yakalamadaki bağlara (sınır ve/veya komşu panel) göre yeniden kurar.
 * Herhangi bir eksende bağ çözülemezse o eksen `anchored=false` döner ve
 * çağıran taraf eski (oransal) davranışa düşer — geriye dönük uyumlu.
 */
function resolveAnchoredOrigin(
  anchors: RaycastAnchorOwners,
  nhd: NormalizedHitDistances,
  panels: any[],
  shapeFaces: VirtualFace[],
  subtractions: any[],
  localToWorld: THREE.Matrix4,
  worldNormal: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  faceNComp: number,
  extent: { uMin: number; uMax: number; vMin: number; vMax: number },
  fallbackU: number,
  fallbackV: number
): AnchoredOriginResult {
  const PLANE_TOL = 20;
  const MIN_SPAN = 1.0;

  // Ayak izlerini bir kez çöz, iki geçişte de yeniden kullan.
  const cache = new Map<string, UVPoint[] | null>();
  const footprintOf = (ownerId: string | null): UVPoint[] | null => {
    if (!ownerId) return null;
    if (!cache.has(ownerId)) {
      cache.set(ownerId, collectOwnerFootprintUV(
        ownerId, panels, shapeFaces, subtractions,
        localToWorld, worldNormal, u, v, faceNComp, PLANE_TOL
      ));
    }
    return cache.get(ownerId) ?? null;
  };

  // Yön için bağ koordinatını çöz. `crossCoord` verilirse, komşunun DİK
  // eksendeki ayak izi bandı bu koordinatı kapsamıyorsa o komşu gerçekte
  // yolda değildir → sınıra düşülür.
  const resolve = (
    dir: 'u+' | 'u-' | 'v+' | 'v-',
    ownerId: string | null,
    crossCoord: number | null
  ): { coord: number; fromOwner: boolean } => {
    const boundaryCoord =
      dir === 'u+' ? extent.uMax :
      dir === 'u-' ? extent.uMin :
      dir === 'v+' ? extent.vMax : extent.vMin;

    const fp = footprintOf(ownerId);
    if (!fp) return { coord: boundaryCoord, fromOwner: false };

    const alongU = dir === 'u+' || dir === 'u-';
    const along = fp.map(p => (alongU ? p.u : p.v));
    const cross = fp.map(p => (alongU ? p.v : p.u));

    if (crossCoord !== null) {
      const cMin = Math.min(...cross), cMax = Math.max(...cross);
      const PAD = 0.5;
      if (crossCoord < cMin - PAD || crossCoord > cMax + PAD) {
        // Komşu bu şeritte değil → o yönde artık sınır var.
        return { coord: boundaryCoord, fromOwner: false };
      }
    }

    // Işının çarptığı YAKIN kenar: +yön için minimum, −yön için maksimum.
    const near = (dir === 'u+' || dir === 'v+') ? Math.min(...along) : Math.max(...along);
    if (!isFinite(near)) return { coord: boundaryCoord, fromOwner: false };
    return { coord: near, fromOwner: true };
  };

  // Yakalamadaki oran: köken, [neg bağ, pos bağ] aralığının neresindeydi?
  const uSpanCap = nhd.uNegAbsDist + nhd.uPosAbsDist;
  const vSpanCap = nhd.vNegAbsDist + nhd.vPosAbsDist;
  const uFrac = uSpanCap > 1e-6 ? nhd.uNegAbsDist / uSpanCap : 0.5;
  const vFrac = vSpanCap > 1e-6 ? nhd.vNegAbsDist / vSpanCap : 0.5;

  let originU = fallbackU;
  let originV = fallbackV;
  let anchoredU = false;
  let anchoredV = false;

  // İki geçiş: 1) çapraz filtre olmadan kaba köken, 2) kaba kökenle şerit
  // filtresi uygulanarak kesin köken. Dik/eksen hizalı panellerde ilk geçiş
  // zaten kesindir; eğik veya kısmi panellerde ikinci geçiş düzeltir.
  for (let pass = 0; pass < 2; pass++) {
    const crossV = pass === 0 ? null : originV;
    const crossU = pass === 0 ? null : originU;

    const uNeg = resolve('u-', anchors.uNeg, crossV);
    const uPos = resolve('u+', anchors.uPos, crossV);
    const vNeg = resolve('v-', anchors.vNeg, crossU);
    const vPos = resolve('v+', anchors.vPos, crossU);

    if (uPos.coord - uNeg.coord > MIN_SPAN) {
      originU = uNeg.coord + uFrac * (uPos.coord - uNeg.coord);
      anchoredU = uNeg.fromOwner || uPos.fromOwner;
    }
    if (vPos.coord - vNeg.coord > MIN_SPAN) {
      originV = vNeg.coord + vFrac * (vPos.coord - vNeg.coord);
      anchoredV = vNeg.fromOwner || vPos.fromOwner;
    }
  }

  originU = Math.max(extent.uMin + 0.5, Math.min(extent.uMax - 0.5, originU));
  originV = Math.max(extent.vMin + 0.5, Math.min(extent.vMax - 0.5, originV));

  return { originU, originV, anchoredU, anchoredV };
}

function reraycastVirtualFace(
  vf: VirtualFace,
  shape: Shape,
  faces: FaceData[],
  faceGroups: CoplanarFaceGroup[],
  localToWorld: THREE.Matrix4,
  worldToLocal: THREE.Matrix4,
  childPanels: any[],
  shapeFaces: VirtualFace[],
  authoritative: boolean
): VirtualFace | null {
  if (!vf.raycastRecipe) return null;

  // Curved faces use bounding-box projection, not ray-casting.
  if (vf.raycastRecipe.isCurvedFace) {
    return regenerateCurvedFaceVF(vf, shape, faces, faceGroups, localToWorld, worldToLocal);
  }

  const matchedGroup = findMatchingFaceGroup(vf, faces, faceGroups, shape.geometry);
  if (!matchedGroup) return null;

  const normalMatrix = new THREE.Matrix3().getNormalMatrix(localToWorld);
  const strictIndices = filterStrictCoplanarIndices(
    faces, matchedGroup.faceIndices, localToWorld, normalMatrix
  );

  const refFace = faces[strictIndices[0]];
  const localNormal = refFace ? refFace.normal.clone().normalize() : matchedGroup.normal.clone().normalize();
  const worldNormal = localNormal.clone().applyMatrix3(normalMatrix).normalize();

  let { u, v } = getFacePlaneAxes(worldNormal);

  const groupVerticesWorld: THREE.Vector3[] = [];
  strictIndices.forEach(fi => {
    const face = faces[fi];
    if (!face) return;
    face.vertices.forEach(vertex => groupVerticesWorld.push(vertex.clone().applyMatrix4(localToWorld)));
  });

  if (groupVerticesWorld.length === 0) return null;

  const uniqueBoundaryEdgesLocal = extractUniqueBoundaryEdgesLocal(faces, strictIndices);
  // ── EKSEN SABİTLEME ──────────────────────────────────────────────────────
  // Yakalama anında kaydedilen u ekseni (parent-yerel) varsa taban ONDAN
  // kurulur. Baskın kenar yönü (pickDominantEdgeDirection) yüzün en-boy
  // oranına bağlıdır: küp 600×720'den 900×720'ye büyüyünce baskın yön
  // düşeyden yataya DÖNER, reçetedeki tüm u/v verisi (clickUV, mesafeler,
  // bağlar) ters eksende okunur ve panel bambaşka yere yerleşir. Sabit eksen
  // bu sınıf hatayı kökten kapatır. Eski kayıtlar (alan yoksa) baskın kenar
  // davranışına düşer — geriye dönük uyumlu.
  const pinnedULocal = vf.raycastRecipe.planeAxisULocal;
  let axisPinned = false;
  if (pinnedULocal) {
    const uW = new THREE.Vector3(pinnedULocal[0], pinnedULocal[1], pinnedULocal[2])
      .applyMatrix3(normalMatrix);
    // normale dik bileşeni al (ölçek/çarpıklık payı) ve normalize et
    uW.addScaledVector(worldNormal, -uW.dot(worldNormal));
    if (uW.lengthSq() > 1e-8) {
      u = uW.normalize();
      v = new THREE.Vector3().crossVectors(worldNormal, u).normalize();
      axisPinned = true;
    }
  }
  if (!axisPinned) {
    const boundaryEdgesWorldForDominant = collectBoundaryEdgesWorld(faces, strictIndices, localToWorld);
    const dominant = pickDominantEdgeDirection(boundaryEdgesWorldForDominant, worldNormal);
    if (dominant) {
      u = dominant.clone();
      v = new THREE.Vector3().crossVectors(worldNormal, u).normalize();
    }
  }

  const nhd = vf.raycastRecipe.normalizedHitDistances;
  const allBoundary = !!nhd && !!nhd.uPosIsBoundary && !!nhd.uNegIsBoundary && !!nhd.vPosIsBoundary && !!nhd.vNegIsBoundary;
  const siblingPanelsExist = childPanels.some(p => p.parameters?.virtualFaceId !== vf.id);
  if (nhd && allBoundary && !siblingPanelsExist) {
    const result = reconstructFromNormalizedDistances(
      vf, nhd, groupVerticesWorld, worldNormal, u, v,
      localToWorld, worldToLocal, localNormal, shape, uniqueBoundaryEdgesLocal
    );
    if (result) return result;
  }

  const edgeAnchors = vf.raycastRecipe.edgeAnchors;

  if (edgeAnchors && edgeAnchors.length === 4 && allBoundary && !siblingPanelsExist) {
    const faceGroupCenterLocal = matchedGroup.center.clone();
    const anchorHitPoints = reconstructHitPointsFromAnchors(
      edgeAnchors, uniqueBoundaryEdgesLocal, localToWorld, localNormal, faceGroupCenterLocal
    );

    if (anchorHitPoints.size === 4) {
      const uPosHitW = anchorHitPoints.get('u+')!;
      const uNegHitW = anchorHitPoints.get('u-')!;
      const vPosHitW = anchorHitPoints.get('v+')!;
      const vNegHitW = anchorHitPoints.get('v-')!;

      const refPoint = groupVerticesWorld[0];
      const nComp = refPoint.dot(worldNormal);

      const realCornersWorld = [
        buildWorldPoint(uPosHitW.dot(u), vPosHitW.dot(v), nComp, u, v, worldNormal),
        buildWorldPoint(uNegHitW.dot(u), vPosHitW.dot(v), nComp, u, v, worldNormal),
        buildWorldPoint(uNegHitW.dot(u), vNegHitW.dot(v), nComp, u, v, worldNormal),
        buildWorldPoint(uPosHitW.dot(u), vNegHitW.dot(v), nComp, u, v, worldNormal),
      ];

      const subtractions = shape.subtractionGeometries || [];
      const clipResult = clipAndFinalize(
        realCornersWorld, subtractions, localToWorld, worldToLocal, worldNormal, u, v
      );

      if (clipResult) {
        const newAnchors = rebuildAnchorsFromWorldCorners(
          clipResult.cornersLocal, uniqueBoundaryEdgesLocal
        );

        return {
          ...vf,
          normal: [localNormal.x, localNormal.y, localNormal.z],
          center: [clipResult.centerLocal.x, clipResult.centerLocal.y, clipResult.centerLocal.z],
          vertices: clipResult.cornersLocal.map(c => [c.x, c.y, c.z] as [number, number, number]),
          raycastRecipe: {
            ...vf.raycastRecipe,
            edgeAnchors: newAnchors.length === 4 ? newAnchors : vf.raycastRecipe.edgeAnchors,
          },
        };
      }
    }
  }

  return reraycastVirtualFaceFallback(
    vf, shape, faces, matchedGroup, localToWorld, worldToLocal,
    childPanels, shapeFaces, groupVerticesWorld, worldNormal, u, v, authoritative, strictIndices
  );
}


function reraycastVirtualFaceFallback(
  vf: VirtualFace,
  shape: Shape,
  faces: FaceData[],
  matchedGroup: CoplanarFaceGroup,
  localToWorld: THREE.Matrix4,
  worldToLocal: THREE.Matrix4,
  childPanels: any[],
  shapeFaces: VirtualFace[],
  groupVerticesWorld: THREE.Vector3[],
  worldNormal: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  authoritative: boolean,
  strictFaceIndices?: number[]
): VirtualFace | null {
  const groupCenterWorld = new THREE.Vector3();
  groupVerticesWorld.forEach(vw => groupCenterWorld.add(vw));
  groupCenterWorld.divideScalar(groupVerticesWorld.length);
  const faceNComp = groupCenterWorld.dot(worldNormal);

  const faceIndicesForBoundary = strictFaceIndices && strictFaceIndices.length > 0
    ? strictFaceIndices : matchedGroup.faceIndices;
  const boundaryEdgesWorld = collectBoundaryEdgesWorld(faces, faceIndicesForBoundary, localToWorld);
  const subtractions = shape.subtractionGeometries || [];

  const panelsExcludingSelf = childPanels.filter(
    p => p.parameters?.virtualFaceId !== vf.id
  );

  // EŞİTLENMİŞ KARDEŞLER ENGEL DEĞİL: aynı düzlemde "ana yüzeye eşitle" almış
  // panel parent yüzünü tümüyle doldurur ve flush durur; bu panelin ÜZERİNE
  // istiflenir, onu in-plane sınırlamaz. Konturu (yüz poligonu) engel sayılırsa
  // bölge sorgusuz yüz şeklini alır — her panelin varsayılan olarak DİKDÖRTGEN
  // yerleşmesi gerekirken. Yakalama (buildPreview) ile birebir aynı eleme.
  const alignedVfIds = collectCoplanarAlignedVfIds(
    shapeFaces.filter(f => f.id !== vf.id),
    new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]),
    new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2])
  );

  // Compute the old VF extent in face u/v coordinates
  const vfVerticesWorld = vf.vertices.map(([x, y, z]) =>
    new THREE.Vector3(x, y, z).applyMatrix4(localToWorld)
  );
  const vfVertsU = vfVerticesWorld.map(vw => vw.dot(u));
  const vfVertsV = vfVerticesWorld.map(vw => vw.dot(v));
  const oldUMin = Math.min(...vfVertsU), oldUMax = Math.max(...vfVertsU);
  const oldVMin = Math.min(...vfVertsV), oldVMax = Math.max(...vfVertsV);
  const oldUCenter = (oldUMin + oldUMax) / 2;
  const oldVCenter = (oldVMin + oldVMax) / 2;

  let rayOriginU = oldUCenter;
  let rayOriginV = oldVCenter;
  // TIKLAMA ÇIPASI: yeniden türetme, VF merkezinden değil kullanıcının
  // KAYITLI tıklama noktasından yapılır (yakalama ile birebir aynı köken).
  // Merkez her recalc'ta kaydığı için küçük ama birikimli sapmalar üretiyordu;
  // tıklama noktası kullanıcının gerçek niyetidir ve parent boyutlanınca
  // oransal (normalizedClickUV) taşınır.
  const clickUV = vf.raycastRecipe?.normalizedClickUV;

  // Helper: build a world point on the face plane from u/v coords
  const buildOrigin = (uCoord: number, vCoord: number) =>
    new THREE.Vector3()
      .addScaledVector(u, uCoord)
      .addScaledVector(v, vCoord)
      .addScaledVector(worldNormal, faceNComp);

  // Helper: cast 4 rays from a given u/v origin
  const castFromOrigin = (originU: number, originV: number) => {
    const origin = buildOrigin(originU, originV);
    const start = origin.clone().addScaledVector(worldNormal, 0.5);
    const panelObs = collectPanelObstacleEdgesWorld(panelsExcludingSelf, worldNormal, origin, 20, boundaryEdgesWorld, alignedVfIds);
    const subObs = collectSubtractionObstacleEdgesWorld(subtractions, localToWorld, worldNormal, origin, 20);
    const vfObs = collectVirtualFaceObstacleEdgesWorld(shapeFaces, vf.id, localToWorld, worldNormal, origin, 20, alignedVfIds);
    const obstacles = [...panelObs, ...subObs, ...vfObs];
    const dirs = [u, u.clone().negate(), v, v.clone().negate()];
    const dists: number[] = [];
    for (const dir of dirs) {
      const hit = castRayOnFaceWorld(start, dir, boundaryEdgesWorld, obstacles, u, v, origin, 5000);
      dists.push(hit.distanceTo(start));
    }
    return dists; // [uPos, uNeg, vPos, vNeg]
  };

  // Clamp to face extent
  const extent = computeFaceGroupExtent(groupVerticesWorld, u, v);
  if (clickUV) {
    rayOriginU = extent.uMin + clickUV[0] * extent.uSpan;
    rayOriginV = extent.vMin + clickUV[1] * extent.vSpan;
  }
  rayOriginU = Math.max(extent.uMin + 1, Math.min(extent.uMax - 1, rayOriginU));
  rayOriginV = Math.max(extent.vMin + 1, Math.min(extent.vMax - 1, rayOriginV));

  // ── PARAMETRİK BAĞ (anchor) İLE KÖKEN KURULUMU ───────────────────────────
  // clickUV yüzün TAMAMINA oranlıdır; bölge bir komşu panele yaslanıyorsa
  // parent büyüyünce köken o panelin öte tarafına atlar. Bağlar kayıtlıysa
  // köken, [alt bağ, üst bağ] aralığında YAKALAMADAKİ ORAN korunarak kurulur:
  // sınır bağları parent ile taşınır, panel bağları panelin güncel yerinde kalır.
  const nhd = vf.raycastRecipe?.normalizedHitDistances;
  const anchors = vf.raycastRecipe?.anchorOwners;
  let anchoredU = false, anchoredV = false;
  if (anchors && nhd) {
    const siblingFaces = shapeFaces.filter(f => f.id !== vf.id);

    // ── YETKİ AYRIMI (dominance / eksik bağlam) ──────────────────────────
    // Bir bağ sahibi bağlamda YOKSA iki olasılık vardır ve ikisi zıt davranış
    // ister: (a) rebuild ara geçişi — kardeş panel henüz workingShapes'e
    // eklenmedi → VF'ye DOKUNMA; (b) panel sırası değişti — o kardeş artık
    // bu panelden SONRA geliyor, bu paneli sınırlayamaz → bölge sınıra kadar
    // YAYILMALI (baskınlık). Recalc bunu tek başına ayırt edemez; ayrımı
    // çağıran yapar: authoritative=true ise bu VF için bağlam TAMDIR
    // (boru hattı, sırası gelen panelin recalc'ında yalnızca ÖNCEKİ
    // kardeşleri verir — baskınlık semantiğinin ta kendisi), çözülemeyen
    // sahip sınıra düşer ve bölge yayılır. authoritative=false ise bağlam
    // eksik demektir; VF olduğu gibi korunur.
    if (!authoritative) {
      const ownerMissing = (o: string | null): boolean => {
        if (!o) return false;
        if (o.startsWith('panel:')) return !panelsExcludingSelf.some(pp => pp.id === o.slice(6));
        if (o.startsWith('vf:')) return !siblingFaces.some(f => f.id === o.slice(3));
        if (o.startsWith('sub:')) return !subtractions[parseInt(o.slice(4), 10)];
        return false;
      };
      if ([anchors.uPos, anchors.uNeg, anchors.vPos, anchors.vNeg].some(ownerMissing)) {
        return { ...vf };
      }
    }

    const res = resolveAnchoredOrigin(
      anchors, nhd, panelsExcludingSelf, siblingFaces, subtractions,
      localToWorld, worldNormal, u, v, faceNComp, extent,
      rayOriginU, rayOriginV
    );
    rayOriginU = res.originU;
    rayOriginV = res.originV;
    anchoredU = res.anchoredU;
    anchoredV = res.anchoredV;
  }

  // İÇBÜKEY (L/U) YÜZ GÜVENLİĞİ: clickUV, yüz SINIR KUTUSUNA oranlıdır.
  // Tüm ışınlar sınıra çarptığında yakalama tarafı bunu [0.5,0.5] (kutu
  // merkezi) olarak kaydeder — dışbükey yüzde stabildir. Ama L/U gibi içbükey
  // yüzde kutu merkezi ÇENTİK BOŞLUĞUNA düşebilir; origin boşlukta olunca
  // ışınlar reflex köşeden kaçıp bölge patlar (panel sıra değişince yerinden
  // oynamasının kök nedeni buydu). Çözüm: reconstruct edilen origin gerçek yüz
  // poligonunun DIŞINDAysa, kullanıcının GERÇEK tıklama noktasına (clickLocal)
  // düşülür — o her zaman yüzün içindedir.
  {
    // Sınır kenarlarını sıralı bir halkaya diz (isPointInsidePolygon sıralı
    // köşe ister). Kenarlar rastgele sırada gelir; uçları eşleştirerek zincirle.
    const ring2D = orderEdgesToRing2D(boundaryEdgesWorld, u, v);
    const originInside = ring2D.length >= 3
      && isPointInsidePolygon({ x: rayOriginU, y: rayOriginV }, ring2D);
    if (!originInside && vf.raycastRecipe?.clickLocalPoint) {
      const clw = new THREE.Vector3(...vf.raycastRecipe.clickLocalPoint).applyMatrix4(localToWorld);
      const cu = clw.dot(u), cv = clw.dot(v);
      if (ring2D.length < 3 || isPointInsidePolygon({ x: cu, y: cv }, ring2D)) {
        // BAĞLI EKSENE DOKUNMA: clickLocal MUTLAK bir noktadır; bağ (anchor) ile
        // çözülmüş eksende onu geri yazmak parametrikliği bozar. Sadece bağsız
        // eksenler tıklama noktasına düşürülür.
        if (!anchoredU) rayOriginU = Math.max(extent.uMin + 1, Math.min(extent.uMax - 1, cu));
        if (!anchoredV) rayOriginV = Math.max(extent.vMin + 1, Math.min(extent.vMax - 1, cv));
      }
    }
  }
  let [uPosT, uNegT, vPosT, vNegT] = castFromOrigin(rayOriginU, rayOriginV);

  // Crossover detection: if an obstacle moved past the VF center, the resulting VF
  // will NOT contain the old VF's boundary edges. This ONLY applies when the panel
  // was originally bounded by an obstacle on one side — meaning the obstacle could
  // have moved past the center. If all sides were boundaries at placement time,
  // shrinkage from a new obstacle is legitimate and should NOT trigger relocation.
  if (nhd && !(anchoredU && anchoredV)) {
    // Compute the new VF extent in absolute u/v coords
    const newUMin = rayOriginU - uNegT;
    const newUMax = rayOriginU + uPosT;
    const newVMin = rayOriginV - vNegT;
    const newVMax = rayOriginV + vPosT;

    let needsRelocation = false;
    let targetU = rayOriginU;
    let targetV = rayOriginV;
    const MARGIN = 5;

    // Crossover in v: an obstacle that was in v+ direction moved past center to v- side.
    // Detection: v- was a boundary AND v+ was an obstacle (the obstacle that could cross).
    // Result: the old vMin boundary is no longer reachable (newVMin > oldVMin).
    // Bağ (anchor) ile çözülen eksende crossover sezgiseline gerek yoktur —
    // köken zaten komşunun güncel yerine göre kuruldu; sezgisel burada sadece
    // gürültü üretir. Yalnızca bağsız (eski kayıt / çözülemeyen) eksende çalışır.
    if (!anchoredV) {
      if (nhd.vNegIsBoundary && !nhd.vPosIsBoundary && newVMin > oldVMin + MARGIN) {
        targetV = oldVMin + MARGIN;
        needsRelocation = true;
      }
      // Crossover in v: an obstacle that was in v- direction moved past center to v+ side.
      else if (nhd.vPosIsBoundary && !nhd.vNegIsBoundary && newVMax < oldVMax - MARGIN) {
        targetV = oldVMax - MARGIN;
        needsRelocation = true;
      }
    }

    if (!anchoredU) {
      // Crossover in u: obstacle from u+ moved past center to u- side.
      if (nhd.uNegIsBoundary && !nhd.uPosIsBoundary && newUMin > oldUMin + MARGIN) {
        targetU = oldUMin + MARGIN;
        needsRelocation = true;
      }
      // Crossover in u: obstacle from u- moved past center to u+ side.
      else if (nhd.uPosIsBoundary && !nhd.uNegIsBoundary && newUMax < oldUMax - MARGIN) {
        targetU = oldUMax - MARGIN;
        needsRelocation = true;
      }
    }

    if (needsRelocation) {
      targetU = Math.max(extent.uMin + 1, Math.min(extent.uMax - 1, targetU));
      targetV = Math.max(extent.vMin + 1, Math.min(extent.vMax - 1, targetV));
      rayOriginU = targetU;
      rayOriginV = targetV;
      [uPosT, uNegT, vPosT, vNegT] = castFromOrigin(rayOriginU, rayOriginV);
    }
  }

  const planeOrigin = buildOrigin(rayOriginU, rayOriginV);

  // SERİ IŞIN: yakalama tarafıyla (buildPreview) BİREBİR aynı görünürlük
  // çokgeni algoritması kullanılır — aksi halde ilk rebuild'de bölge tekrar
  // dikdörtgene çökerdi. Işın demeti açık uca kaçarsa (kapanmayan sınır)
  // eski dikdörtgen davranışına düşülür.
  const panelObsF = collectPanelObstacleEdgesWorld(panelsExcludingSelf, worldNormal, planeOrigin, 20, boundaryEdgesWorld, alignedVfIds);
  const subObsF = collectSubtractionObstacleEdgesWorld(subtractions, localToWorld, worldNormal, planeOrigin, 20);
  const vfObsF = collectVirtualFaceObstacleEdgesWorld(shapeFaces, vf.id, localToWorld, worldNormal, planeOrigin, 20, alignedVfIds);
  const obstaclesF = [...panelObsF, ...subObsF, ...vfObsF];
  const startF = planeOrigin.clone().addScaledVector(worldNormal, 0.5);
  const dirsF = [u, u.clone().negate(), v, v.clone().negate()];
  const axisHits = dirsF.map(dir =>
    castRayOnFaceWorldDetailed(startF, dir, boundaryEdgesWorld, obstaclesF, u, v, planeOrigin, 5000)
  ); // [u+, u-, v+, v-]

  // ── BÖLGE KİLİDİ ─────────────────────────────────────────────────────
  // Kullanıcı "ana yüze eşitle" DEMEDİKÇE, tıklamayla seçilen bölge yüze
  // eşitlenmemelidir. Yakalama anında bir yön ENGELLE sınırlandıysa
  // (IsBoundary=false) ama şu an o yönde engel BULUNAMIYORSA — ya rebuild
  // sırasındaki eksik bağlam (kardeş panel henüz workingShapes'e eklenmedi;
  // kanıtlanmış "yüze otomatik eşitleme" kök nedeni) ya da engel silinmiştir —
  // VF'ye dokunulmaz, kullanıcının bölgesi aynen korunur. Engel yalnızca
  // TAŞINDIYSA ışın onu yeni yerinde bulur ve bölge normal şekilde ona kadar
  // güncellenir (teğet takibi bozulmaz).
  // Yetkili (bağlamı tam) recalc'ta kilit YOKTUR: yakalamada engel olan yön
  // artık sınıra çıkıyorsa bu, engelin gerçekten kalktığı/sonraya alındığı
  // anlamına gelir ve bölge sınıra kadar yayılır (baskınlık). Kilit yalnızca
  // eksik bağlamlı ara recalc'ları korur.
  if (nhd && !authoritative && !vf.parentFaceShape && !vf.alignToParentFace) {
    const captureObstacleBounded = [
      !nhd.uPosIsBoundary, !nhd.uNegIsBoundary, !nhd.vPosIsBoundary, !nhd.vNegIsBoundary,
    ];
    for (let di = 0; di < 4; di++) {
      if (captureObstacleBounded[di] && axisHits[di].isBoundaryEdge) {
        return { ...vf };
      }
    }
  }

  const segs2D = [...boundaryEdgesWorld, ...obstaclesF].map(e => {
    const a = projectTo2D(e.v1, planeOrigin, u, v);
    const b = projectTo2D(e.v2, planeOrigin, u, v);
    return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
  });
  const vis = computeVisibilityPolygon2D(segs2D, 5000);
  let visPoly = vis.poly;
  // STABİLİZASYON (yakalama tarafıyla birebir): 4 ana eksen ışınının çarptığı
  // kenar doğrularıyla kırpılır — L/U yüzeylerde reflex köşe kaması kesilir,
  // bölge tıklama/merkez konumundan bağımsız stabil kalır.
  if (visPoly.length >= 3) {
    for (const res of axisHits) {
      if (!res.hitEdge) continue;
      const a2 = projectTo2D(res.hitEdge.v1, planeOrigin, u, v);
      const b2 = projectTo2D(res.hitEdge.v2, planeOrigin, u, v);
      const clipped = clipPolygonByLine2D(visPoly, a2, b2);
      if (clipped.length >= 3) visPoly = clipped;
    }
    visPoly = simplifyCollinear2D(visPoly, 0.05);
  }
  const visValid = visPoly.length >= 3 && !visPoly.some(p => Math.hypot(p.x, p.y) >= 5000 - 1);

  let rect2D: Point2D[] = visValid
    ? ensureCCW(visPoly)
    : ensureCCW([
        { x: uPosT, y: vPosT },
        { x: -uNegT, y: vPosT },
        { x: -uNegT, y: -vNegT },
        { x: uPosT, y: -vNegT },
      ]);

  const footprints = getSubtractorFootprints2D(
    subtractions, localToWorld, worldNormal, planeOrigin, u, v, 50
  );

  let clippedPoly = rect2D;
  for (const footprint of footprints) {
    const ccwFootprint = ensureCCW(footprint);
    const hasOverlap =
      ccwFootprint.some(p => isPointInsidePolygon(p, clippedPoly)) ||
      clippedPoly.some(p => isPointInsidePolygon(p, ccwFootprint));
    if (hasOverlap) {
      clippedPoly = subtractPolygon(clippedPoly, ccwFootprint);
    }
  }

  if (clippedPoly.length < 3) return null;

  // VARSAYILAN BİÇİM: DİKDÖRTGEN (yakalama tarafıyla birebir aynı indirgeme).
  // Eşitlenmiş VF'ler bu yola hiç girmez (regenerateParentFaceShapeVF ile
  // yüz poligonunu alırlar), dolayısıyla "ana yüzeye eşitle" davranışı korunur.
  const rectSegsF = [...segs2D];
  for (const fp of footprints) {
    for (let i = 0; i < fp.length; i++) {
      const a = fp[i], b = fp[(i + 1) % fp.length];
      rectSegsF.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
  }
  const rectReducedF = reduceRegionToRectangle2D(rectSegsF, {
    uMin: -uNegT, uMax: uPosT, vMin: -vNegT, vMax: vPosT,
  });
  if (rectReducedF) clippedPoly = rectReducedF;

  const cornersWorld = clippedPoly.map(p =>
    planeOrigin.clone().addScaledVector(u, p.x).addScaledVector(v, p.y)
  );
  const cornersLocal = cornersWorld.map(c => c.clone().applyMatrix4(worldToLocal));

  const centerLocal = new THREE.Vector3();
  cornersLocal.forEach(c => centerLocal.add(c));
  centerLocal.divideScalar(cornersLocal.length);

  const localNormal = matchedGroup.normal.clone().normalize();

  // ── BAĞLARI TAZELE ───────────────────────────────────────────────────────
  // Bölge artık hangi komşulara yaslanıyorsa reçete onu yansıtmalı: aksi halde
  // yakalamadan SONRA eklenen bir panel bağ olarak kaydedilmez ve bir sonraki
  // boyut değişiminde köken yine yanlış banda düşer. Köken zaten bu bağlardan
  // ve oranlardan türetildiği için geri yazım sabit noktadır — sürüklenme olmaz.
  let refreshedRecipe = vf.raycastRecipe;
  if (refreshedRecipe && nhd) {
    // SINIF KORUMASI: geri-yazım yalnızca her dört yönün SINIFI yakalamayla
    // örtüşüyorsa yapılır (sınır↔sınır, engel↔engel). Rebuild ara geçişleri
    // eksik bağlamla çalışır (kardeş paneller henüz workingShapes'te değil);
    // sınıfı değişen tek bir yön bile bağlamın eksik olduğunun kanıtıdır ve
    // reçeteye yazmak bağları kalıcı bozar. Sınıflar örtüşünce yazmak
    // güvenlidir: köken bu bağlardan türediği için işlem sabit noktadır,
    // yeni eklenen bir panel yakın bağ olduysa sahibi güncellenir.
    const capBoundary = [
      nhd.uPosIsBoundary, nhd.uNegIsBoundary, nhd.vPosIsBoundary, nhd.vNegIsBoundary,
    ];
    const classesMatch = axisHits.every((h, i) => h.isBoundaryEdge === capBoundary[i]);
    if (classesMatch || authoritative) {
      const dU = axisHits.map(h => h.hitPoint.distanceTo(startF));
      refreshedRecipe = {
        ...refreshedRecipe,
        anchorOwners: {
          uPos: axisHits[0].hitOwnerId,
          uNeg: axisHits[1].hitOwnerId,
          vPos: axisHits[2].hitOwnerId,
          vNeg: axisHits[3].hitOwnerId,
        },
        normalizedHitDistances: {
          ...nhd,
          uPosAbsDist: dU[0],
          uNegAbsDist: dU[1],
          vPosAbsDist: dU[2],
          vNegAbsDist: dU[3],
        },
      };
    }
  }

  return {
    ...vf,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    center: [centerLocal.x, centerLocal.y, centerLocal.z],
    vertices: cornersLocal.map(c => [c.x, c.y, c.z] as [number, number, number]),
    raycastRecipe: refreshedRecipe,
  };
}

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
    if (vf.parentFaceShape) {
      const regen = regenerateParentFaceShapeVF(vf, shape, faces, faceGroups, localToWorld);
      updatedMap.set(vf.id, regen || vf);
    } else if (vf.raycastRecipe) {
      const authoritative = authoritativeVfIds === 'all' || authoritativeVfIds.has(vf.id);
      const reraycast = reraycastVirtualFace(
        vf, shape, faces, faceGroups, localToWorld, worldToLocal, childPanels, shapeFaces, authoritative
      );
      updatedMap.set(vf.id, reraycast || vf);
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

function extractParentBoundaryLoopLocal(
  faces: FaceData[],
  faceIndices: number[]
): THREE.Vector3[] | null {
  type Edge = { a: THREE.Vector3; b: THREE.Vector3; ak: string; bk: string };
  const keyOf = (p: THREE.Vector3) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
  const map = new Map<string, { e: Edge; count: number }>();
  for (const fi of faceIndices) {
    const f = faces[fi]; if (!f) continue;
    for (let i = 0; i < 3; i++) {
      const a = f.vertices[i], b = f.vertices[(i + 1) % 3];
      const ak = keyOf(a), bk = keyOf(b);
      const k = ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
      if (!map.has(k)) map.set(k, { e: { a: a.clone(), b: b.clone(), ak, bk }, count: 0 });
      map.get(k)!.count++;
    }
  }
  const boundary: Edge[] = [];
  map.forEach(v => { if (v.count === 1) boundary.push(v.e); });
  if (boundary.length < 3) return null;
  const adj = new Map<string, { other: string; point: THREE.Vector3 }[]>();
  for (const e of boundary) {
    if (!adj.has(e.ak)) adj.set(e.ak, []);
    if (!adj.has(e.bk)) adj.set(e.bk, []);
    adj.get(e.ak)!.push({ other: e.bk, point: e.b });
    adj.get(e.bk)!.push({ other: e.ak, point: e.a });
  }
  const startKey = boundary[0].ak;
  const loop: THREE.Vector3[] = [boundary[0].a];
  const visited = new Set<string>();
  let cur = startKey, prev = '';
  while (true) {
    visited.add(cur);
    const neigh = adj.get(cur) || [];
    const next = neigh.find(n => n.other !== prev && !visited.has(n.other));
    if (!next) break;
    loop.push(next.point);
    prev = cur; cur = next.other;
    if (cur === startKey) break;
    if (loop.length > boundary.length + 2) break;
  }
  return loop.length >= 3 ? loop : null;
}

function regenerateParentFaceShapeVF(
  vf: VirtualFace,
  shape: Shape,
  faces: FaceData[],
  faceGroups: CoplanarFaceGroup[],
  localToWorld: THREE.Matrix4
): VirtualFace | null {
  const matchedGroup = findMatchingFaceGroup(vf, faces, faceGroups, shape.geometry);
  if (!matchedGroup) return null;

  const normalMatrix = new THREE.Matrix3().getNormalMatrix(localToWorld);
  const strictIndicesForPFS = filterStrictCoplanarIndices(
    faces, matchedGroup.faceIndices, localToWorld, normalMatrix
  );

  const boundaryLocal = extractParentBoundaryLoopLocal(faces, strictIndicesForPFS);
  if (!boundaryLocal || boundaryLocal.length < 3) return null;

  const refFacePFS = faces[strictIndicesForPFS[0]];
  const localNormal = refFacePFS ? refFacePFS.normal.clone().normalize() : matchedGroup.normal.clone().normalize();
  const worldNormal = localNormal.clone().applyMatrix3(normalMatrix).normalize();
  const { u, v } = getFacePlaneAxes(worldNormal);

  const boundaryWorld = boundaryLocal.map(p => p.clone().applyMatrix4(localToWorld));
  const centerWorld = new THREE.Vector3();
  boundaryWorld.forEach(c => centerWorld.add(c));
  centerWorld.divideScalar(boundaryWorld.length);
  const planeOrigin = centerWorld.clone();

  const poly: Point2D[] = ensureCCW(
    boundaryWorld.map(c => projectTo2D(c, planeOrigin, u, v))
  );
  if (poly.length < 3) return null;

  const newCornersLocal = poly.map(p =>
    planeOrigin.clone().addScaledVector(u, p.x).addScaledVector(v, p.y)
  ).map(cw => cw.clone().applyMatrix4(new THREE.Matrix4().copy(localToWorld).invert()));

  const newCenter = new THREE.Vector3();
  newCornersLocal.forEach(c => newCenter.add(c));
  newCenter.divideScalar(newCornersLocal.length);

  return {
    ...vf,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    vertices: newCornersLocal.map(c => [c.x, c.y, c.z] as [number, number, number]),
    center: [newCenter.x, newCenter.y, newCenter.z],
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
