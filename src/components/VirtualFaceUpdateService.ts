import * as THREE from 'three';
import type { VirtualFace, Shape, EdgeAnchor, NormalizedHitDistances } from '../store';
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
  castRayOnFaceWorld,
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
  if (candidateGroups.length === 1) return candidateGroups[0];

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

function reraycastVirtualFace(
  vf: VirtualFace,
  shape: Shape,
  faces: FaceData[],
  faceGroups: CoplanarFaceGroup[],
  localToWorld: THREE.Matrix4,
  worldToLocal: THREE.Matrix4,
  childPanels: any[],
  shapeFaces: VirtualFace[]
): VirtualFace | null {
  if (!vf.raycastRecipe) return null;

  const matchedGroup = findMatchingFaceGroup(vf, faces, faceGroups, shape.geometry);
  if (!matchedGroup) return null;

  const localNormal = matchedGroup.normal.clone().normalize();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(localToWorld);
  const worldNormal = localNormal.clone().applyMatrix3(normalMatrix).normalize();

  const { u, v } = getFacePlaneAxes(worldNormal);

  const groupVerticesWorld: THREE.Vector3[] = [];
  matchedGroup.faceIndices.forEach(fi => {
    const face = faces[fi];
    if (!face) return;
    face.vertices.forEach(vertex => groupVerticesWorld.push(vertex.clone().applyMatrix4(localToWorld)));
  });

  if (groupVerticesWorld.length === 0) return null;

  const uniqueBoundaryEdgesLocal = extractUniqueBoundaryEdgesLocal(faces, matchedGroup.faceIndices);

  const nhd = vf.raycastRecipe.normalizedHitDistances;
  const allBoundary = !!nhd && !!nhd.uPosIsBoundary && !!nhd.uNegIsBoundary && !!nhd.vPosIsBoundary && !!nhd.vNegIsBoundary;
  if (nhd && allBoundary) {
    const result = reconstructFromNormalizedDistances(
      vf, nhd, groupVerticesWorld, worldNormal, u, v,
      localToWorld, worldToLocal, localNormal, shape, uniqueBoundaryEdgesLocal
    );
    if (result) return result;
  }

  const edgeAnchors = vf.raycastRecipe.edgeAnchors;

  if (edgeAnchors && edgeAnchors.length === 4 && allBoundary) {
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
    childPanels, shapeFaces, groupVerticesWorld, worldNormal, u, v
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
  v: THREE.Vector3
): VirtualFace | null {
  let clampedClickWorld: THREE.Vector3;

  const normalizedUV = vf.raycastRecipe!.normalizedClickUV;
  if (normalizedUV) {
    const extent = computeFaceGroupExtent(groupVerticesWorld, u, v);

    const worldU = extent.uMin + normalizedUV[0] * extent.uSpan;
    const worldV = extent.vMin + normalizedUV[1] * extent.vSpan;

    const groupCenter = new THREE.Vector3();
    groupVerticesWorld.forEach(vw => groupCenter.add(vw));
    groupCenter.divideScalar(groupVerticesWorld.length);

    clampedClickWorld = groupCenter.clone()
      .addScaledVector(u, worldU - groupCenter.dot(u))
      .addScaledVector(v, worldV - groupCenter.dot(v));
  } else {
    const clickLocal = new THREE.Vector3(
      vf.raycastRecipe!.clickLocalPoint[0],
      vf.raycastRecipe!.clickLocalPoint[1],
      vf.raycastRecipe!.clickLocalPoint[2]
    );
    const clickWorld = clickLocal.clone().applyMatrix4(localToWorld);
    const groupBboxWorld = new THREE.Box3().setFromPoints(groupVerticesWorld);
    clampedClickWorld = clickWorld.clone().clamp(groupBboxWorld.min, groupBboxWorld.max);
  }

  const startWorld = clampedClickWorld.clone().addScaledVector(worldNormal, 0.5);
  const planeOrigin = startWorld.clone();

  const boundaryEdgesWorld = collectBoundaryEdgesWorld(faces, matchedGroup.faceIndices, localToWorld);
  const subtractions = shape.subtractionGeometries || [];

  const panelsExcludingSelf = childPanels.filter(
    p => p.parameters?.virtualFaceId !== vf.id
  );
  const panelObstacleEdges = collectPanelObstacleEdgesWorld(
    panelsExcludingSelf, worldNormal, planeOrigin, 20
  );
  const subObstacleEdges = collectSubtractionObstacleEdgesWorld(
    subtractions, localToWorld, worldNormal, planeOrigin, 20
  );
  const vfObstacleEdges = collectVirtualFaceObstacleEdgesWorld(
    shapeFaces, vf.id, localToWorld, worldNormal, planeOrigin, 20
  );
  const obstacleEdges = [...panelObstacleEdges, ...subObstacleEdges, ...vfObstacleEdges];

  const maxDist = 5000;
  const directions = [u, u.clone().negate(), v, v.clone().negate()];

  const hitPointsWorld: THREE.Vector3[] = [];
  for (const dir of directions) {
    const hit = castRayOnFaceWorld(startWorld, dir, boundaryEdgesWorld, obstacleEdges, u, v, planeOrigin, maxDist);
    hitPointsWorld.push(hit);
  }

  if (hitPointsWorld.length < 4) return null;

  const uPosT = hitPointsWorld[0].distanceTo(startWorld);
  const uNegT = hitPointsWorld[1].distanceTo(startWorld);
  const vPosT = hitPointsWorld[2].distanceTo(startWorld);
  const vNegT = hitPointsWorld[3].distanceTo(startWorld);

  let rect2D: Point2D[] = ensureCCW([
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

  const cornersWorld = clippedPoly.map(p =>
    planeOrigin.clone().addScaledVector(u, p.x).addScaledVector(v, p.y)
  );
  const cornersLocal = cornersWorld.map(c => c.clone().applyMatrix4(worldToLocal));

  const centerLocal = new THREE.Vector3();
  cornersLocal.forEach(c => centerLocal.add(c));
  centerLocal.divideScalar(cornersLocal.length);

  const localNormal = matchedGroup.normal.clone().normalize();

  return {
    ...vf,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    center: [centerLocal.x, centerLocal.y, centerLocal.z],
    vertices: cornersLocal.map(c => [c.x, c.y, c.z] as [number, number, number]),
  };
}

export function recalculateVirtualFacesForShape(
  shape: Shape,
  virtualFaces: VirtualFace[],
  allShapes?: any[]
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
    if (vf.raycastRecipe) {
      const reraycast = reraycastVirtualFace(
        vf, shape, faces, faceGroups, localToWorld, worldToLocal, childPanels, shapeFaces
      );
      updatedMap.set(vf.id, reraycast || vf);
    } else {
      const subtractions = shape.subtractionGeometries || [];
      if (subtractions.length > 0) {
        const clipped = clipVirtualFaceAgainstSubtractions(vf, subtractions, localToWorld, worldToLocal);
        updatedMap.set(vf.id, clipped || vf);
      } else {
        updatedMap.set(vf.id, vf);
      }
    }
  }

  return virtualFaces.map(vf => updatedMap.get(vf.id) || vf);
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
