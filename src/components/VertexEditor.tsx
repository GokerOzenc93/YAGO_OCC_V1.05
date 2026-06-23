import React, { useEffect, useState } from 'react';
import * as THREE from 'three';
import { getBoxVertices, getReplicadVertices } from './VertexEditorService';

interface VertexEditorProps {
  shape: any;
  isActive: boolean;
  onVertexSelect: (index: number | null) => void;
  onDirectionChange: (direction: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-') => void;
  onOffsetConfirm: (vertexIndex: number, direction: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-', offset: number) => void;
}

const VertexPoint: React.FC<{
  position: THREE.Vector3;
  index: number;
  isHovered: boolean;
  isSelected: boolean;
  onClick: (e: any) => void;
  onPointerOver: () => void;
  onPointerOut: () => void;
}> = ({ position, index, isHovered, isSelected, onClick, onPointerOver, onPointerOut }) => {
  const size = isSelected ? 12 : isHovered ? 10 : 8;
  const color = isSelected ? '#f97316' : isHovered ? '#ef4444' : '#dc2626';
  const outlineSize = size + 2.5;

  return (
    <group position={position}>
      {/* Outline ring for contrast */}
      <mesh
        renderOrder={998}
      >
        <sphereGeometry args={[outlineSize, 16, 16]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.9} depthTest={false} />
      </mesh>
      {/* Main point */}
      <mesh
        renderOrder={999}
        onClick={onClick}
        onPointerOver={(e) => {
          e.stopPropagation();
          onPointerOver();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          onPointerOut();
          document.body.style.cursor = 'default';
        }}
      >
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial color={color} depthTest={false} />
      </mesh>
    </group>
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
      <line geometry={lineGeometry}>
        <lineBasicMaterial color="#ef4444" linewidth={3} />
      </line>
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
            <line geometry={lineGeometry}>
              <lineBasicMaterial color={color} linewidth={3} transparent opacity={0.8} />
            </line>
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
  onOffsetConfirm
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
      console.log('🔍 VertexEditor loadVertices called:', {
        isActive,
        hasShape: !!shape,
        hasParameters: !!shape?.parameters,
        shapeType: shape?.type,
        hasReplicadShape: !!shape?.replicadShape,
        dimensions: shape?.parameters ? {
          w: shape.parameters.width,
          h: shape.parameters.height,
          d: shape.parameters.depth
        } : null
      });

      if (!isActive || !shape.parameters) {
        console.log('⚠️ VertexEditor: inactive or no parameters');
        return;
      }

      let baseVerts: THREE.Vector3[] = [];

      if (shape.parameters.scaledBaseVertices && shape.parameters.scaledBaseVertices.length > 0) {
        console.log('📍 Using pre-computed scaled base vertices...');
        baseVerts = shape.parameters.scaledBaseVertices.map((v: number[]) =>
          new THREE.Vector3(v[0], v[1], v[2])
        );
        console.log(`✅ Loaded ${baseVerts.length} scaled base vertices`);
      } else if (shape.replicadShape) {
        console.log('📍 Loading vertices from Replicad shape...');
        baseVerts = await getReplicadVertices(shape.replicadShape);
        console.log(`✅ Loaded ${baseVerts.length} base vertices from Replicad`);
      } else if (shape.type === 'box') {
        console.log('📦 Loading vertices from box parameters...');
        baseVerts = getBoxVertices(
          shape.parameters.width,
          shape.parameters.height,
          shape.parameters.depth
        );
        console.log(`✅ Loaded ${baseVerts.length} base vertices from box`);
      }

      console.log('📍 Setting base vertices:', baseVerts);
      setVertices(baseVerts);

      const modified = baseVerts.map((vertex, index) => {
        if (shape.vertexModifications) {
          const mod = shape.vertexModifications.find((m: any) => m.vertexIndex === index);
          if (mod && mod.newPosition) {
            console.log(`✓ Applying vertex ${index} modification:`, {
              base: [vertex.x.toFixed(1), vertex.y.toFixed(1), vertex.z.toFixed(1)],
              modified: [mod.newPosition[0].toFixed(1), mod.newPosition[1].toFixed(1), mod.newPosition[2].toFixed(1)]
            });
            return new THREE.Vector3(
              mod.newPosition[0],
              mod.newPosition[1],
              mod.newPosition[2]
            );
          }
        }
        return vertex.clone();
      });

      console.log(`✅ Computed ${modified.length} modified vertex positions`);
      setModifiedVertices(modified);
    };

    loadVertices();
  }, [isActive, shape, shape.parameters?.width, shape.parameters?.height, shape.parameters?.depth, shape.replicadShape, shape.vertexModifications]);

  console.log('🎨 VertexEditor render:', {
    isActive,
    hasParameters: !!shape?.parameters,
    verticesLength: vertices.length,
    willRender: isActive && shape?.parameters && vertices.length > 0
  });

  if (!isActive || !shape.parameters || vertices.length === 0) {
    console.log('❌ VertexEditor not rendering - conditions not met');
    return null;
  }

  const handleVertexClick = (index: number, e: any) => {
    e.stopPropagation();

    if (selectedIndex === index && currentDirection) {
      setShowDirectionSelector(true);
      console.log(`🔄 Change direction for vertex ${index}`);
    } else {
      setSelectedIndex(index);
      setCurrentDirection(null);
      setShowDirectionSelector(true);
      onVertexSelect(index);
      console.log(`✓ Vertex ${index} selected - Choose direction`);
    }
  };

  const handleDirectionSelect = (direction: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-') => {
    setCurrentDirection(direction);
    setShowDirectionSelector(false);
    onDirectionChange(direction);
    console.log(`✓ Direction ${direction} selected - Right-click to confirm`);
  };

  const handleVertexRightClick = (index: number, e: any) => {
    e.stopPropagation();
    if (selectedIndex === index && currentDirection) {
      console.log(`✓ Confirmed - Waiting for terminal input for vertex ${index} (${currentDirection})`);
      (window as any).pendingVertexEdit = true;
    }
  };

  const handleVertexDoubleClick = (index: number, e: any) => {
    e.stopPropagation();
    if (selectedIndex === index && currentDirection) {
      setShowDirectionSelector(true);
      setCurrentDirection(null);
      console.log(`🔄 Change direction for vertex ${index}`);
    }
  };

  console.log('✨ VertexEditor rendering with:', {
    modifiedVerticesCount: modifiedVertices.length,
    shapePosition: shape.position,
    firstVertex: modifiedVertices[0]
  });

  return (
    <group
      position={[shape.position[0], shape.position[1], shape.position[2]]}
      rotation={[shape.rotation[0], shape.rotation[1], shape.rotation[2]]}
      scale={[shape.scale[0], shape.scale[1], shape.scale[2]]}
    >
      {modifiedVertices.map((vertex, index) => {
        console.log(`🔴 Rendering vertex ${index}:`, vertex);
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
