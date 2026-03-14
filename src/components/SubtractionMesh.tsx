import React, { useMemo } from 'react';
import * as THREE from 'three';

interface SubtractionMeshProps {
  subtraction: any;
  index: number;
  isHovered: boolean;
  isSubtractionSelected: boolean;
  isSelected: boolean;
  setHoveredSubtractionIndex: (index: number | null) => void;
  setSelectedSubtractionIndex: (index: number | null) => void;
}

export const SubtractionMesh: React.FC<SubtractionMeshProps> = React.memo(({
  subtraction,
  index,
  isHovered,
  isSubtractionSelected,
  isSelected,
  setHoveredSubtractionIndex,
  setSelectedSubtractionIndex
}) => {
  const geometryInfo = useMemo(() => {
    const box = new THREE.Box3().setFromBufferAttribute(
      subtraction.geometry.attributes.position as THREE.BufferAttribute
    );
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const isCentered = Math.abs(center.x) < 0.01 && Math.abs(center.y) < 0.01 && Math.abs(center.z) < 0.01;
    const meshOffset: [number, number, number] = isCentered
      ? [size.x / 2, size.y / 2, size.z / 2]
      : [0, 0, 0];

    return { meshOffset };
  }, [subtraction.geometry]);

  return (
    <group
      position={subtraction.relativeOffset}
      rotation={subtraction.relativeRotation}
    >
      <mesh
        geometry={subtraction.geometry}
        position={geometryInfo.meshOffset}
        onPointerOver={(e) => {
          e.stopPropagation();
          if (isSelected) {
            setHoveredSubtractionIndex(index);
          }
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          setHoveredSubtractionIndex(null);
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (isSelected) {
            setSelectedSubtractionIndex(isSubtractionSelected ? null : index);
          }
        }}
      >
        <meshStandardMaterial
          color={(isHovered || isSubtractionSelected) ? 0xff0000 : 0xffff00}
          transparent
          opacity={0.35}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
});

SubtractionMesh.displayName = 'SubtractionMesh';
