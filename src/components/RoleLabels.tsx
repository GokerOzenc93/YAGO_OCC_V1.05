import React, { useMemo } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';
import type { FilletData } from './Fillet';

interface RoleLabelsProps {
  shape: any;
  isActive: boolean;
}

const AXIS_DIRECTION_ORDER: Record<string, number> = {
  'x+': 0, 'x-': 1, 'y+': 2, 'y-': 3, 'z+': 4, 'z-': 5,
};

function getAxisDirection(normal: THREE.Vector3): string | null {
  const tol = 0.95;
  if (normal.x > tol) return 'x+';
  if (normal.x < -tol) return 'x-';
  if (normal.y > tol) return 'y+';
  if (normal.y < -tol) return 'y-';
  if (normal.z > tol) return 'z+';
  if (normal.z < -tol) return 'z-';
  return null;
}

interface CuttingPlane {
  normal: THREE.Vector3;
  constant: number;
  subtractorIndex: number;
}

function buildSubtractorCuttingPlanes(
  subtractionGeometries: Array<{ geometry: THREE.BufferGeometry; relativeOffset: [number, number, number]; relativeRotation: [number, number, number]; scale: [number, number, number] }>,
  mainBbox: THREE.Box3
): CuttingPlane[] {
  const planes: CuttingPlane[] = [];

  subtractionGeometries.forEach((sub, subtractorIndex) => {
    const subGeo = sub.geometry;
    if (!subGeo) return;

    const subBbox = new THREE.Box3().setFromBufferAttribute(subGeo.getAttribute('position'));
    const subMin = subBbox.min.clone();
    const subMax = subBbox.max.clone();

    const offset = new THREE.Vector3(...sub.relativeOffset);
    const rot = sub.relativeRotation;
    const euler = new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ');
    const rotMatrix = new THREE.Matrix4().makeRotationFromEuler(euler);

    const corners = [
      new THREE.Vector3(subMin.x, subMin.y, subMin.z),
      new THREE.Vector3(subMax.x, subMin.y, subMin.z),
      new THREE.Vector3(subMin.x, subMax.y, subMin.z),
      new THREE.Vector3(subMax.x, subMax.y, subMin.z),
      new THREE.Vector3(subMin.x, subMin.y, subMax.z),
      new THREE.Vector3(subMax.x, subMin.y, subMax.z),
      new THREE.Vector3(subMin.x, subMax.y, subMax.z),
      new THREE.Vector3(subMax.x, subMax.y, subMax.z),
    ].map(c => c.applyMatrix4(rotMatrix).add(offset));

    const worldBbox = new THREE.Box3().setFromPoints(corners);

    const facePlanePositions = [
      worldBbox.max.x, worldBbox.min.x,
      worldBbox.max.y, worldBbox.min.y,
      worldBbox.max.z, worldBbox.min.z,
    ];
    const faceNormals = [
      new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
    ];
    const faceConstants = [
      -worldBbox.max.x, worldBbox.min.x,
      -worldBbox.max.y, worldBbox.min.y,
      -worldBbox.max.z, worldBbox.min.z,
    ];

    const mainMin = mainBbox.min;
    const mainMax = mainBbox.max;

    for (let i = 0; i < 6; i++) {
      const pos = facePlanePositions[i];
      const axisIdx = Math.floor(i / 2);
      const minVal = axisIdx === 0 ? mainMin.x : axisIdx === 1 ? mainMin.y : mainMin.z;
      const maxVal = axisIdx === 0 ? mainMax.x : axisIdx === 1 ? mainMax.y : mainMax.z;
      const insetMin = minVal + 1.0;
      const insetMax = maxVal - 1.0;
      if (pos > insetMin && pos < insetMax) {
        planes.push({ normal: faceNormals[i], constant: faceConstants[i], subtractorIndex });
      }
    }
  });

  return planes;
}

function getSubtractorPlaneForFace(
  groupCenter: THREE.Vector3,
  groupNormal: THREE.Vector3,
  cuttingPlanes: CuttingPlane[],
  tolerance: number = 1.0
): number | null {
  for (const plane of cuttingPlanes) {
    const normalDot = Math.abs(groupNormal.dot(plane.normal));
    if (normalDot < 0.95) continue;
    const dist = groupCenter.dot(plane.normal) + plane.constant;
    if (Math.abs(dist) < tolerance) return plane.subtractorIndex;
  }
  return null;
}

function getFilletIndexForCurvedGroup(
  groupCenter: THREE.Vector3,
  fillets: FilletData[]
): number | null {
  for (let i = 0; i < fillets.length; i++) {
    const fillet = fillets[i];
    const radius = fillet.radius;
    const tolerance = Math.max(radius * 2.0, 10);

    const n1 = new THREE.Vector3(...fillet.face1Data.normal);
    const n2 = new THREE.Vector3(...fillet.face2Data.normal);
    const d1 = fillet.face1Data.planeD ?? n1.dot(new THREE.Vector3(...fillet.face1Data.center));
    const d2 = fillet.face2Data.planeD ?? n2.dot(new THREE.Vector3(...fillet.face2Data.center));

    const dist1 = Math.abs(n1.dot(groupCenter) - d1);
    const dist2 = Math.abs(n2.dot(groupCenter) - d2);

    if (dist1 < tolerance && dist2 < tolerance) return i;
  }
  return null;
}

export const RoleLabels: React.FC<RoleLabelsProps> = React.memo(({ shape, isActive }) => {
  const faceLabels = useMemo(() => {
    if (!isActive || !shape.geometry) return [];

    const faces = extractFacesFromGeometry(shape.geometry);
    const faceGroups = groupCoplanarFaces(faces);
    const faceRoles = shape.faceRoles || {};

    const bbox = new THREE.Box3().setFromBufferAttribute(
      shape.geometry.getAttribute('position')
    );
    const size = new THREE.Vector3();
    bbox.getSize(size);

    const subtractionGeometries: Array<any> = shape.subtractionGeometries || [];
    const cuttingPlanes = buildSubtractorCuttingPlanes(subtractionGeometries, bbox);

    const axisCandidates = new Map<string, Array<{ group: typeof faceGroups[0]; originalIndex: number }>>();
    const subtractorFaces = new Map<number, Array<{ group: typeof faceGroups[0]; originalIndex: number }>>();
    const filletFaces = new Map<number, Array<{ group: typeof faceGroups[0]; originalIndex: number }>>();

    const fillets: FilletData[] = shape.fillets || [];

    faceGroups.forEach((group, index) => {
      const axisDir = getAxisDirection(group.normal);

      if (axisDir === null) {
        if (fillets.length > 0) {
          const filletIdx = getFilletIndexForCurvedGroup(group.center, fillets);
          if (filletIdx !== null) {
            if (!filletFaces.has(filletIdx)) filletFaces.set(filletIdx, []);
            filletFaces.get(filletIdx)!.push({ group, originalIndex: index });
          }
        }
        return;
      }

      if (cuttingPlanes.length > 0) {
        const subtractorIdx = getSubtractorPlaneForFace(group.center, group.normal, cuttingPlanes);
        if (subtractorIdx !== null) {
          if (!subtractorFaces.has(subtractorIdx)) subtractorFaces.set(subtractorIdx, []);
          subtractorFaces.get(subtractorIdx)!.push({ group, originalIndex: index });
          return;
        }
      }

      if (!axisCandidates.has(axisDir)) axisCandidates.set(axisDir, []);
      axisCandidates.get(axisDir)!.push({ group, originalIndex: index });
    });

    const axisSorted: Array<{ axisDir: string; candidates: Array<{ group: typeof faceGroups[0]; originalIndex: number }> }> = [];
    axisCandidates.forEach((candidates, axisDir) => {
      axisSorted.push({ axisDir, candidates });
    });

    axisSorted.sort((a, b) => {
      const orderA = AXIS_DIRECTION_ORDER[a.axisDir] ?? 99;
      const orderB = AXIS_DIRECTION_ORDER[b.axisDir] ?? 99;
      return orderA - orderB;
    });

    const result: Array<{
      position: THREE.Vector3;
      labels: Array<{ text: string; index: number; hasRole: boolean }>;
      groupKey: string;
      isSubtractor?: boolean;
      isFillet?: boolean;
    }> = [];

    const computeOffset = (normal: THREE.Vector3): number => {
      const absX = Math.abs(normal.x);
      const absY = Math.abs(normal.y);
      const absZ = Math.abs(normal.z);
      if (absX > 0.9) return Math.max(size.x * 0.06, 3);
      if (absY > 0.9) return Math.max(size.y * 0.06, 3);
      if (absZ > 0.9) return Math.max(size.z * 0.06, 3);
      return 3;
    };

    axisSorted.forEach(({ axisDir, candidates }, roleIdx) => {
      const roleNumber = roleIdx + 1;
      const isSplit = candidates.length > 1;

      if (isSplit) {
        candidates.forEach((candidate, subIdx) => {
          const offset = computeOffset(candidate.group.normal);
          const offsetPosition = candidate.group.center.clone().add(candidate.group.normal.clone().multiplyScalar(offset));
          result.push({
            position: offsetPosition,
            labels: [{ text: `${roleNumber}-${subIdx + 1}`, index: candidate.originalIndex, hasRole: !!faceRoles[candidate.originalIndex] }],
            groupKey: `${axisDir}-${roleIdx}-${subIdx}`,
          });
        });
      } else {
        const candidate = candidates[0];
        const offset = computeOffset(candidate.group.normal);
        const offsetPosition = candidate.group.center.clone().add(candidate.group.normal.clone().multiplyScalar(offset));
        result.push({
          position: offsetPosition,
          labels: [{ text: `${roleNumber}`, index: candidate.originalIndex, hasRole: !!faceRoles[candidate.originalIndex] }],
          groupKey: `${axisDir}-${roleIdx}`,
        });
      }
    });

    subtractorFaces.forEach((faces, subtractorIdx) => {
      const sNumber = subtractorIdx + 1;
      faces.forEach((candidate, faceIdx) => {
        const offset = computeOffset(candidate.group.normal);
        const offsetPosition = candidate.group.center.clone().add(candidate.group.normal.clone().multiplyScalar(offset));
        result.push({
          position: offsetPosition,
          labels: [{ text: `S${sNumber}.${faceIdx + 1}`, index: candidate.originalIndex, hasRole: !!faceRoles[candidate.originalIndex] }],
          groupKey: `sub-${subtractorIdx}-${faceIdx}`,
          isSubtractor: true,
        });
      });
    });

    filletFaces.forEach((faces, filletIdx) => {
      const fNumber = filletIdx + 1;
      faces.forEach((candidate, faceIdx) => {
        const normal = candidate.group.normal;
        const offset = Math.max(fillets[filletIdx].radius * 0.3, 3);
        const offsetPosition = candidate.group.center.clone().add(normal.clone().multiplyScalar(offset));
        result.push({
          position: offsetPosition,
          labels: [{ text: `F${fNumber}`, index: candidate.originalIndex, hasRole: !!faceRoles[candidate.originalIndex] }],
          groupKey: `fillet-${filletIdx}-${faceIdx}`,
          isFillet: true,
        });
      });
    });

    return result;
  }, [shape.geometry?.uuid, JSON.stringify(shape.faceRoles), isActive, JSON.stringify(shape.subtractionGeometries?.map((s: any) => s.relativeOffset)), JSON.stringify(shape.fillets?.map((f: FilletData) => ({ r: f.radius, f1: f.face1Data.planeD, f2: f.face2Data.planeD })))]);

  if (!isActive || faceLabels.length === 0) return null;

  return (
    <>
      {faceLabels.map((item) => (
        <Html
          key={`label-${item.groupKey}`}
          position={[item.position.x, item.position.y, item.position.z]}
          center
          occlude={false}
          zIndexRange={[10, 0]}
          style={{
            pointerEvents: 'none',
            userSelect: 'none'
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'row', gap: '3px', alignItems: 'center' }}>
            {item.labels.map((lbl) => (
              <span
                key={`lbl-${lbl.index}`}
                style={{
                  color: item.isSubtractor ? 'rgb(180, 80, 0)' : item.isFillet ? 'rgb(0, 110, 180)' : 'rgb(10, 10, 10)',
                  fontSize: '13px',
                  fontWeight: '800',
                  fontFamily: 'system-ui, sans-serif',
                  textShadow: '0 0 2px rgba(255,255,255,0.9), 0 0 4px rgba(255,255,255,0.7), 1px 1px 0 rgba(255,255,255,0.6)',
                  letterSpacing: '0.02em',
                  lineHeight: 1,
                  whiteSpace: 'nowrap',
                }}
              >
                {lbl.text}
              </span>
            ))}
          </div>
        </Html>
      ))}
    </>
  );
});

RoleLabels.displayName = 'RoleLabels';
