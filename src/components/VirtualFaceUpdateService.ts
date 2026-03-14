import * as THREE from 'three';
import type { VirtualFace, Shape, EdgeAnchor } from '../store';
import {
  getFacePlaneAxes,
  getShapeMatrix,
  getSubtractorFootprints2D,
  getSubtractionWorldMatrix,
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
  if (vf.raycastRecipe) {
    const matchedFace = findFaceByDescriptor(
      vf.raycastRecipe.faceGroupDescriptor,
      faces,
      geometry
    );
    if (matchedFace) {
      const matchedGroup = faceGroups.find(g =>
        g.faceIndices.includes(matchedFace.faceIndex)
      );
      if (matchedGroup) return matchedGroup;
    }
  }

  const vfNormal = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
  let bestGroup: CoplanarFaceGroup | null = null;
  let bestDot = -Infinity;

  for (const group of faceGroups) {
    const groupNormal = group.normal.clone().normalize();
    const dot = vfNormal.dot(groupNormal);
    if (dot > 0.95 && dot > bestDot) {
      bestDot = dot;
      bestGroup = group;
    }
  }

  return bestGroup;
}

function findMatchingBoundaryEdge(
  anchor: EdgeAnchor,
  boundaryEdgesLocal: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>,
  faceNormalLocal: THREE.Vector3
): { edge: { v1: THREE.Vector3; v2: THREE.Vector3 }; t: number } | null {
  const aV1 = new THREE.Vector3(...anchor.edgeV1Local);
  const aV2 = new THREE.Vector3(...anchor.edgeV2Local);
  const aDir = aV2.clone().sub(aV1).normalize();
  const aMid = aV1.clone().add(aV2).multiplyScalar(0.5);
  const aLen = aV1.distanceTo(aV2);

  const aNormalComp = aMid.dot(faceNormalLocal);

  const crossA = new THREE.Vector3().crossVectors(aDir, faceNormalLocal).normalize();

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
    const eNormalComp = eMid.dot(faceNormalLocal);

    const sameNormalPlane = Math.abs(eNormalComp - aNormalComp) < aLen * 0.5 + 50;
    if (!sameNormalPlane) continue;

    const eSidePos = eMid.dot(crossA);
    const aSidePos = aMid.dot(crossA);
    const sideDist = Math.abs(eSidePos - aSidePos);

    const score = sideDist * (2 - dirDot);

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
  _boundaryEdgesWorld: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>,
  boundaryEdgesLocal: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>,
  localToWorld: THREE.Matrix4,
  faceNormalLocal?: THREE.Vector3
): Map<string, THREE.Vector3> {
  const result = new Map<string, THREE.Vector3>();
  const normal = faceNormalLocal || new THREE.Vector3(0, 0, 1);

  for (const anchor of anchors) {
    const matched = findMatchingBoundaryEdge(anchor, boundaryEdgesLocal, normal);
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

  const edgeAnchors = vf.raycastRecipe.edgeAnchors;

  if (edgeAnchors && edgeAnchors.length === 4) {
    const anchorHitPoints = reconstructHitPointsFromAnchors(
      edgeAnchors, [], uniqueBoundaryEdgesLocal, localToWorld, localNormal
    );

    if (anchorHitPoints.size === 4) {
      const uPosHitW = anchorHitPoints.get('u+')!;
      const uNegHitW = anchorHitPoints.get('u-')!;
      const vPosHitW = anchorHitPoints.get('v+')!;
      const vNegHitW = anchorHitPoints.get('v-')!;

      const cornersWorld = [
        new THREE.Vector3(uPosHitW.dot(u), vPosHitW.dot(v), 0),
        new THREE.Vector3(uNegHitW.dot(u), vPosHitW.dot(v), 0),
        new THREE.Vector3(uNegHitW.dot(u), vNegHitW.dot(v), 0),
        new THREE.Vector3(uPosHitW.dot(u), vNegHitW.dot(v), 0),
      ];

      const refPoint = groupVerticesWorld[0];
      const nComp = refPoint.dot(worldNormal);

      const realCornersWorld = cornersWorld.map(c => {
        const w = new THREE.Vector3()
          .addScaledVector(u, c.x)
          .addScaledVector(v, c.y)
          .addScaledVector(worldNormal, nComp);
        return w;
      });

      const subtractions = shape.subtractionGeometries || [];
      if (subtractions.length > 0) {
        const planeOriginForClip = new THREE.Vector3();
        realCornersWorld.forEach(c => planeOriginForClip.add(c));
        planeOriginForClip.divideScalar(realCornersWorld.length);

        const poly2D = realCornersWorld.map(c => projectTo2D(c, planeOriginForClip, u, v));
        let clippedPoly = ensureCCW(poly2D);

        const footprints = getSubtractorFootprints2D(
          subtractions, localToWorld, worldNormal, planeOriginForClip, u, v, 50
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

        if (clippedPoly.length < 3) return null;

        const finalCornersWorld = clippedPoly.map(p =>
          planeOriginForClip.clone().addScaledVector(u, p.x).addScaledVector(v, p.y)
        );
        const cornersLocal = finalCornersWorld.map(c => c.clone().applyMatrix4(worldToLocal));

        const centerLocal = new THREE.Vector3();
        cornersLocal.forEach(c => centerLocal.add(c));
        centerLocal.divideScalar(cornersLocal.length);

        const newAnchors = rebuildAnchorsFromHitPoints(anchorHitPoints, uniqueBoundaryEdgesLocal, worldToLocal);

        return {
          ...vf,
          normal: [localNormal.x, localNormal.y, localNormal.z],
          center: [centerLocal.x, centerLocal.y, centerLocal.z],
          vertices: cornersLocal.map(c => [c.x, c.y, c.z] as [number, number, number]),
          raycastRecipe: {
            ...vf.raycastRecipe,
            edgeAnchors: newAnchors.length === 4 ? newAnchors : vf.raycastRecipe.edgeAnchors,
          },
        };
      }

      const cornersLocal = realCornersWorld.map(c => c.clone().applyMatrix4(worldToLocal));

      const centerLocal = new THREE.Vector3();
      cornersLocal.forEach(c => centerLocal.add(c));
      centerLocal.divideScalar(cornersLocal.length);

      const newAnchors = rebuildAnchorsFromHitPoints(anchorHitPoints, uniqueBoundaryEdgesLocal, worldToLocal);

      return {
        ...vf,
        normal: [localNormal.x, localNormal.y, localNormal.z],
        center: [centerLocal.x, centerLocal.y, centerLocal.z],
        vertices: cornersLocal.map(c => [c.x, c.y, c.z] as [number, number, number]),
        raycastRecipe: {
          ...vf.raycastRecipe,
          edgeAnchors: newAnchors.length === 4 ? newAnchors : vf.raycastRecipe.edgeAnchors,
        },
      };
    }
  }

  return reraycastVirtualFaceFallback(
    vf, shape, faces, matchedGroup, localToWorld, worldToLocal,
    childPanels, shapeFaces, groupVerticesWorld, worldNormal, u, v
  );
}

function rebuildAnchorsFromHitPoints(
  anchorHitPoints: Map<string, THREE.Vector3>,
  boundaryEdgesLocal: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>,
  worldToLocal: THREE.Matrix4
): EdgeAnchor[] {
  const newAnchors: EdgeAnchor[] = [];
  const dirLabels: Array<'u+' | 'u-' | 'v+' | 'v-'> = ['u+', 'u-', 'v+', 'v-'];

  for (const dirLabel of dirLabels) {
    const hitW = anchorHitPoints.get(dirLabel);
    if (!hitW) continue;
    const hitL = hitW.clone().applyMatrix4(worldToLocal);

    let bestEdge: { v1: THREE.Vector3; v2: THREE.Vector3 } | null = null;
    let bestDist = Infinity;
    let bestEdgeT = 0;

    for (const edge of boundaryEdgesLocal) {
      const closest = new THREE.Vector3();
      const line = new THREE.Line3(edge.v1, edge.v2);
      line.closestPointToPoint(hitL, true, closest);
      const dist = closest.distanceTo(hitL);
      if (dist < bestDist) {
        bestDist = dist;
        bestEdge = edge;
        const eLen = edge.v1.distanceTo(edge.v2);
        bestEdgeT = eLen > 1e-8 ? edge.v1.distanceTo(closest) / eLen : 0;
      }
    }

    if (bestEdge) {
      newAnchors.push({
        edgeV1Local: [bestEdge.v1.x, bestEdge.v1.y, bestEdge.v1.z],
        edgeV2Local: [bestEdge.v2.x, bestEdge.v2.y, bestEdge.v2.z],
        t: Math.max(0, Math.min(1, bestEdgeT)),
        direction: dirLabel,
      });
    }
  }

  return newAnchors;
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
    const faceVertsU = groupVerticesWorld.map(vw => vw.dot(u));
    const faceVertsV = groupVerticesWorld.map(vw => vw.dot(v));
    const uMin = Math.min(...faceVertsU);
    const uMax = Math.max(...faceVertsU);
    const vMin = Math.min(...faceVertsV);
    const vMax = Math.max(...faceVertsV);

    const worldU = uMin + normalizedUV[0] * (uMax - uMin);
    const worldV = vMin + normalizedUV[1] * (vMax - vMin);

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
