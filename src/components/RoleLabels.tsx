import React, { useMemo } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';

interface RoleLabelsProps {
  shape: any;
  isActive: boolean;
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

    return faceGroups.map((group, index) => {
      const role = faceRoles[index];
      const label = `${index + 1}`;

      const offsetPosition = new THREE.Vector3()
        .copy(group.center)
        .add(group.normal.clone().multiplyScalar(offsetAmount));

      return {
        position: offsetPosition,
        label,
        index,
        hasRole: !!role
      };
    });
  }, [shape.geometry?.uuid, JSON.stringify(shape.faceRoles), isActive]);

  if (!isActive || faceLabels.length === 0) return null;

  return (
    <>
      {faceLabels.map((item) => (
        <Html
          key={`label-${item.index}`}
          position={[item.position.x, item.position.y, item.position.z]}
          center
          occlude={false}
          zIndexRange={[10, 0]}
          style={{
            pointerEvents: 'none',
            userSelect: 'none'
          }}
        >
          <div
            style={{
              background: item.hasRole ? 'rgba(5, 150, 105, 0.95)' : 'rgba(30, 41, 59, 0.9)',
              color: 'white',
              minWidth: '22px',
              height: '22px',
              borderRadius: '50%',
              fontSize: '11px',
              fontWeight: '700',
              fontFamily: 'system-ui, sans-serif',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: item.hasRole ? '2px solid rgba(255,255,255,0.7)' : '2px solid rgba(255,255,255,0.4)',
              boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
              padding: '0 2px'
            }}
          >
            {item.label}
          </div>
        </Html>
      ))}
    </>
  );
});

RoleLabels.displayName = 'RoleLabels';
