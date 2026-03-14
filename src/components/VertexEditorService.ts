import * as THREE from 'three';

export interface VertexModification {
  vertexIndex: number;
  originalPosition: [number, number, number];
  newPosition: [number, number, number];
  direction: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
  expression: string;
  description?: string;
  offset: [number, number, number];
}

export interface ShapeVertexData {
  shapeId: string;
  modifications: VertexModification[];
}

export type VertexEditMode = 'select' | 'direction' | 'input';

export interface VertexState {
  selectedVertexIndex: number | null;
  hoveredVertexIndex: number | null;
  currentDirection: 'x' | 'y' | 'z';
  editMode: VertexEditMode;
  pendingOffset: number;
}

export function getBoxVertices(width: number, height: number, depth: number): THREE.Vector3[] {
  const w2 = width / 2;
  const h2 = height / 2;
  const d2 = depth / 2;

  return [
    new THREE.Vector3(-w2, -h2, -d2),
    new THREE.Vector3(w2, -h2, -d2),
    new THREE.Vector3(w2, h2, -d2),
    new THREE.Vector3(-w2, h2, -d2),
    new THREE.Vector3(-w2, -h2, d2),
    new THREE.Vector3(w2, -h2, d2),
    new THREE.Vector3(w2, h2, d2),
    new THREE.Vector3(-w2, h2, d2),
  ];
}

export async function getReplicadVertices(replicadShape: any): Promise<THREE.Vector3[]> {
  try {
    console.log('📍 Getting vertices from Replicad shape...');
    console.log('Shape object:', replicadShape);
    console.log('Shape keys:', Object.keys(replicadShape));

    let vertices: any[] = [];

    if (typeof replicadShape.vertices === 'function') {
      console.log('🔍 Calling vertices() method...');
      vertices = replicadShape.vertices();
    } else if (Array.isArray(replicadShape.vertices)) {
      console.log('🔍 Using vertices property...');
      vertices = replicadShape.vertices;
    } else {
      console.log('🔍 Trying to extract unique vertices from mesh...');
      const mesh = replicadShape.mesh({ tolerance: 0.1, angularTolerance: 30 });

      if (mesh && mesh.vertices) {
        console.log(`Found ${mesh.vertices.length / 3} mesh vertices`);

        const uniqueVertices = new Map<string, THREE.Vector3>();

        for (let i = 0; i < mesh.vertices.length; i += 3) {
          const x = Math.round(mesh.vertices[i] * 100) / 100;
          const y = Math.round(mesh.vertices[i + 1] * 100) / 100;
          const z = Math.round(mesh.vertices[i + 2] * 100) / 100;
          const key = `${x},${y},${z}`;

          if (!uniqueVertices.has(key)) {
            uniqueVertices.set(key, new THREE.Vector3(x, y, z));
          }
        }

        const vertexArray = Array.from(uniqueVertices.values());
        console.log(`✅ Extracted ${vertexArray.length} unique vertices from mesh`);
        return vertexArray;
      }
    }

    if (!vertices || !Array.isArray(vertices) || vertices.length === 0) {
      console.warn('⚠️ No vertices found in Replicad shape');
      return [];
    }

    console.log(`Found ${vertices.length} vertices`);

    const vertexPositions = vertices.map((v: any, idx: number) => {
      console.log(`Vertex ${idx}:`, v);

      if (v && typeof v.point === 'function') {
        const point = v.point();
        console.log(`  Point from function:`, point);
        return new THREE.Vector3(point[0], point[1], point[2]);
      } else if (Array.isArray(v)) {
        console.log(`  Point from array:`, v);
        return new THREE.Vector3(v[0], v[1], v[2]);
      } else if (v && typeof v.x === 'number') {
        console.log(`  Point from x,y,z:`, v);
        return new THREE.Vector3(v.x, v.y, v.z);
      }
      return null;
    }).filter((v: THREE.Vector3 | null): v is THREE.Vector3 => v !== null);

    console.log(`✅ Extracted ${vertexPositions.length} vertices from Replicad shape`);
    return vertexPositions;
  } catch (error) {
    console.error('❌ Failed to get Replicad vertices:', error);
    console.error('Error details:', error);
    return [];
  }
}

export function applyVertexModifications(
  geometry: THREE.BufferGeometry,
  modifications: VertexModification[]
): THREE.BufferGeometry {
  const positionAttribute = geometry.getAttribute('position');
  const positions = positionAttribute.array as Float32Array;

  const vertexMap = new Map<number, THREE.Vector3>();

  modifications.forEach(mod => {
    const idx = mod.vertexIndex;

    if (!vertexMap.has(idx)) {
      vertexMap.set(idx, new THREE.Vector3(
        positions[idx * 3],
        positions[idx * 3 + 1],
        positions[idx * 3 + 2]
      ));
    }

    const currentPos = vertexMap.get(idx)!;
    currentPos.x += mod.offset[0];
    currentPos.y += mod.offset[1];
    currentPos.z += mod.offset[2];
  });

  vertexMap.forEach((pos, idx) => {
    positions[idx * 3] = pos.x;
    positions[idx * 3 + 1] = pos.y;
    positions[idx * 3 + 2] = pos.z;
  });

  positionAttribute.needsUpdate = true;
  geometry.computeVertexNormals();

  return geometry;
}

export function getVertexWorldPosition(
  vertex: THREE.Vector3,
  objectMatrix: THREE.Matrix4
): THREE.Vector3 {
  return vertex.clone().applyMatrix4(objectMatrix);
}

export function getDirectionVector(direction: 'x' | 'y' | 'z'): THREE.Vector3 {
  switch (direction) {
    case 'x':
      return new THREE.Vector3(1, 0, 0);
    case 'y':
      return new THREE.Vector3(0, 1, 0);
    case 'z':
      return new THREE.Vector3(0, 0, 1);
  }
}

export function cycleDirection(current: 'x' | 'y' | 'z'): 'x' | 'y' | 'z' {
  switch (current) {
    case 'x':
      return 'y';
    case 'y':
      return 'z';
    case 'z':
      return 'x';
  }
}
