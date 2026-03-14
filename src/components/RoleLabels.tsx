import React, { useMemo } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';

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

function buildSubtractorCuttingPlanes(
  subtractionGeometries: Array<{ geometry: THREE.BufferGeometry; relativeOffset: [number, number, number]; relativeRotation: [number, number, number]; scale: [number, number, number] }>,
  mainBbox: THREE.Box3
): Array<{ normal: THREE.Vector3; constant: number }> {
  const planes: Array<{ normal: THREE.Vector3; constant: number }> = [];

  for (const sub of subtractionGeometries) {
    const subGeo = sub.geometry;
    if (!subGeo) continue;

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
        planes.push({ normal: faceNormals[i], constant: faceConstants[i] });
      }
    }
  }
  return planes;
}

function isFaceOnSubtractorCuttingPlane(
  groupCenter: THREE.Vector3,
  groupNormal: THREE.Vector3,
  cuttingPlanes: Array<{ normal: THREE.Vector3; constant: number }>,
  tolerance: number = 1.0
): boolean {
  for (const plane of cuttingPlanes) {
    const normalDot = Math.abs(groupNormal.dot(plane.normal));
    if (normalDot < 0.95) continue;
    const dist = groupCenter.dot(plane.normal) + plane.constant;
    if (Math.abs(dist) < tolerance) return true;
  }
  return false;
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
    const maxDim = Math.max(size.x, size.y, size.z);
    const offsetAmount = Math.max(maxDim * 0.02, 2);

    const subtractionGeometries: Array<any> = shape.subtractionGeometries || [];
    const cuttingPlanes = buildSubtractorCuttingPlanes(subtractionGeometries, bbox);

    const axisCandidates = new Map<string, Array<{ group: typeof faceGroups[0]; originalIndex: number }>>();
    faceGroups.forEach((group, index) => {
      const axisDir = getAxisDirection(group.normal);
      if (axisDir === null) return;
      if (cuttingPlanes.length > 0 && isFaceOnSubtractorCuttingPlane(group.center, group.normal, cuttingPlanes)) return;
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
    }> = [];

    axisSorted.forEach(({ axisDir, candidates }, roleIdx) => {
      const roleNumber = roleIdx + 1;
      const isSplit = candidates.length > 1;

      if (isSplit) {
        const avgCenter = candidates.reduce((acc, c) => acc.add(c.group.center), new THREE.Vector3()).divideScalar(candidates.length);
        const normal = candidates[0].group.normal;
        const offsetPosition = avgCenter.clone().add(normal.clone().multiplyScalar(offsetAmount));
        const labels = candidates.map((candidate, subIdx) => ({
          text: `${roleNumber}-${subIdx + 1}`,
          index: candidate.originalIndex,
          hasRole: !!faceRoles[candidate.originalIndex],
        }));
        result.push({ position: offsetPosition, labels, groupKey: `${axisDir}-${roleIdx}` });
      } else {
        const candidate = candidates[0];
        const offsetPosition = new THREE.Vector3()
          .copy(candidate.group.center)
          .add(candidate.group.normal.clone().multiplyScalar(offsetAmount));
        result.push({
          position: offsetPosition,
          labels: [{ text: `${roleNumber}`, index: candidate.originalIndex, hasRole: !!faceRoles[candidate.originalIndex] }],
          groupKey: `${axisDir}-${roleIdx}`,
        });
      }
    });

    return result;
  }, [shape.geometry?.uuid, JSON.stringify(shape.faceRoles), isActive]);

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
                  color: lbl.hasRole ? 'rgb(52, 211, 153)' : 'white',
                  fontSize: '12px',
                  fontWeight: '800',
                  fontFamily: 'system-ui, sans-serif',
                  textShadow: '0 0 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.7), 1px 1px 0 rgba(0,0,0,0.8)',
                  letterSpacing: '0.02em',
                  lineHeight: 1,
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
