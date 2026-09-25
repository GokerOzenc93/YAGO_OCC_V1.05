import React, { useEffect, useState } from 'react';
import * as THREE from 'three';
import { getBoxVertices, getReplicadVertices, composeVertexTargets } from './VertexEditorService';

interface VertexEditorProps {
  shape: any;
  isActive: boolean;
  onVertexSelect: (index: number | null) => void;
  onDirectionChange: (direction: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-') => void;
}

const VertexPoint: React.FC<{
  position: THREE.Vector3;
  index: number;
  isHovered: boolean;
  isSelected: boolean;
  onClick: (e: any) => void;
  onPointerOver: () => void;
  onPointerOut: () => void;
}> = ({ position, isHovered, isSelected, onClick, onPointerOver, onPointerOut }) => {
  return (
    <mesh
      position={position}
      onClick={onClick}
      onPointerOver={(e) => {
        e.stopPropagation();
        onPointerOver();
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        onPointerOut();
      }}
    >
      <sphereGeometry args={[isSelected ? 8 : 6, 16, 16]} />
      <meshBasicMaterial color={isHovered ? '#ef4444' : isSelected ? '#f97316' : '#1f2937'} />
    </mesh>
  );
};

const DirectionArrow: React.FC<{
  position: THREE.Vector3;
  direction: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
}> = ({ position, direction }) => {
  const getDirectionVector = (): THREE.Vector3 => {
    switch (direction) {
      case 'x+': return new THREE.Vector3(1, 0, 0);
      case 'x-': return new THREE.Vector3(-1, 0, 0);
      case 'y+': return new THREE.Vector3(0, 1, 0);
      case 'y-': return new THREE.Vector3(0, -1, 0);
      case 'z+': return new THREE.Vector3(0, 0, 1);
      case 'z-': return new THREE.Vector3(0, 0, -1);
    }
  };

  const dirVector = getDirectionVector();
  const arrowLength = 50;
  const endPosition = position.clone().add(dirVector.clone().multiplyScalar(arrowLength));

  const getRotation = (): [number, number, number] => {
    switch (direction) {
      case 'x+': return [0, 0, -Math.PI / 2];
      case 'x-': return [0, 0, Math.PI / 2];
      case 'y+': return [0, 0, 0];
      case 'y-': return [Math.PI, 0, 0];
      case 'z+': return [Math.PI / 2, 0, 0];
      case 'z-': return [-Math.PI / 2, 0, 0];
    }
  };

  const lineGeometry = React.useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array([
      position.x, position.y, position.z,
      endPosition.x, endPosition.y, endPosition.z
    ]);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, [position.x, position.y, position.z, endPosition.x, endPosition.y, endPosition.z]);

  return (
    <group>
      <lineSegments geometry={lineGeometry}>
        <lineBasicMaterial color="#ef4444" linewidth={3} />
      </lineSegments>
      <mesh position={endPosition} rotation={getRotation()}>
        <coneGeometry args={[4, 10, 8]} />
        <meshBasicMaterial color="#ef4444" />
      </mesh>
    </group>
  );
};

const DirectionSelector: React.FC<{
  position: THREE.Vector3;
  onDirectionSelect: (direction: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-') => void;
}> = ({ position, onDirectionSelect }) => {
  const directions: Array<'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-'> = ['x+', 'x-', 'y+', 'y-', 'z+', 'z-'];

  const getDirectionVector = (dir: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-'): THREE.Vector3 => {
    switch (dir) {
      case 'x+': return new THREE.Vector3(1, 0, 0);
      case 'x-': return new THREE.Vector3(-1, 0, 0);
      case 'y+': return new THREE.Vector3(0, 1, 0);
      case 'y-': return new THREE.Vector3(0, -1, 0);
      case 'z+': return new THREE.Vector3(0, 0, 1);
      case 'z-': return new THREE.Vector3(0, 0, -1);
    }
  };

  const getColor = (dir: string): string => {
    if (dir.startsWith('x')) return '#ef4444';
    if (dir.startsWith('y')) return '#22c55e';
    return '#3b82f6';
  };

  const getRotation = (dir: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-'): [number, number, number] => {
    switch (dir) {
      case 'x+': return [0, 0, -Math.PI / 2];
      case 'x-': return [0, 0, Math.PI / 2];
      case 'y+': return [0, 0, 0];
      case 'y-': return [Math.PI, 0, 0];
      case 'z+': return [Math.PI / 2, 0, 0];
      case 'z-': return [-Math.PI / 2, 0, 0];
    }
  };

  return (
    <group>
      {directions.map((dir) => {
        const dirVector = getDirectionVector(dir);
        const arrowLength = 60;
        const endPosition = position.clone().add(dirVector.clone().multiplyScalar(arrowLength));
        const color = getColor(dir);

        const lineGeometry = React.useMemo(() => {
          const geometry = new THREE.BufferGeometry();
          const positions = new Float32Array([
            position.x, position.y, position.z,
            endPosition.x, endPosition.y, endPosition.z
          ]);
          geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          return geometry;
        }, [position.x, position.y, position.z, endPosition.x, endPosition.y, endPosition.z]);

        return (
          <group key={dir}>
            <lineSegments geometry={lineGeometry}>
              <lineBasicMaterial color={color} linewidth={3} transparent opacity={0.8} />
            </lineSegments>
            <mesh
              position={endPosition}
              rotation={getRotation(dir)}
              onClick={(e) => {
                e.stopPropagation();
                onDirectionSelect(dir);
              }}
            >
              <coneGeometry args={[8, 16, 8]} />
              <meshBasicMaterial color={color} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
};

export const VertexEditor: React.FC<VertexEditorProps> = ({
  shape,
  isActive,
  onVertexSelect,
  onDirectionChange,
}) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [currentDirection, setCurrentDirection] = useState<'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-' | null>(null);
  const [showDirectionSelector, setShowDirectionSelector] = useState(false);

  useEffect(() => {
    if (!isActive) {
      setHoveredIndex(null);
      setSelectedIndex(null);
      setCurrentDirection(null);
      setShowDirectionSelector(false);
    }
  }, [isActive]);

  const [vertices, setVertices] = useState<THREE.Vector3[]>([]);
  const [modifiedVertices, setModifiedVertices] = useState<THREE.Vector3[]>([]);

  useEffect(() => {
    const loadVertices = async () => {
      if (!isActive || !shape.parameters) return;

      let baseVerts: THREE.Vector3[] = [];

      if (shape.parameters.scaledBaseVertices && shape.parameters.scaledBaseVertices.length > 0) {
        baseVerts = shape.parameters.scaledBaseVertices.map((v: number[]) =>
          new THREE.Vector3(v[0], v[1], v[2])
        );
      } else if (shape.replicadShape) {
        baseVerts = await getReplicadVertices(shape.replicadShape);
      } else if (shape.type === 'box') {
        baseVerts = getBoxVertices(
          shape.parameters.width,
          shape.parameters.height,
          shape.parameters.depth
        );
      }

      setVertices(baseVerts);

      // Mesh ile AYNI bileşim (eksen bazlı) — nokta, kübün köşesiyle birlikte hareket eder.
      const targets = composeVertexTargets(baseVerts, shape.vertexModifications);
      const modified = baseVerts.map((vertex, index) => (targets.get(index) || vertex).clone());
      setModifiedVertices(modified);
    };

    loadVertices();
  }, [isActive, shape, shape.parameters?.width, shape.parameters?.height, shape.parameters?.depth, shape.replicadShape, shape.vertexModifications]);

  if (!isActive || !shape.parameters || vertices.length === 0) {
    return null;
  }

  const handleVertexClick = (index: number, e: any) => {
    e.stopPropagation();

    if (selectedIndex === index && currentDirection) {
      setShowDirectionSelector(true);
    } else {
      setSelectedIndex(index);
      setCurrentDirection(null);
      setShowDirectionSelector(true);
      onVertexSelect(index);
    }
  };

  const handleDirectionSelect = (direction: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-') => {
    setCurrentDirection(direction);
    setShowDirectionSelector(false);
    onDirectionChange(direction);
  };

  return (
    <group
      position={[shape.position[0], shape.position[1], shape.position[2]]}
      rotation={[shape.rotation[0], shape.rotation[1], shape.rotation[2]]}
      scale={[shape.scale[0], shape.scale[1], shape.scale[2]]}
    >
      {modifiedVertices.map((vertex, index) => {
        return (
          <VertexPoint
            key={index}
            position={vertex}
            index={index}
            isHovered={hoveredIndex === index}
            isSelected={selectedIndex === index}
            onClick={(e) => handleVertexClick(index, e)}
            onPointerOver={() => setHoveredIndex(index)}
            onPointerOut={() => setHoveredIndex(null)}
          />
        );
      })}
      {showDirectionSelector && selectedIndex !== null && (
        <DirectionSelector
          position={modifiedVertices[selectedIndex]}
          onDirectionSelect={handleDirectionSelect}
        />
      )}
      {currentDirection && selectedIndex !== null && !showDirectionSelector && (
        <DirectionArrow
          position={modifiedVertices[selectedIndex]}
          direction={currentDirection}
        />
      )}
    </group>
  );
};
