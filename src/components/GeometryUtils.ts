import * as THREE from 'three';

export interface FaceData {
  faceIndex: number;
  normal: THREE.Vector3;
  center: THREE.Vector3;
  vertices: THREE.Vector3[];
  area: number;
  isCurved?: boolean;
}

export interface CoplanarFaceGroup {
  normal: THREE.Vector3;
  faceIndices: number[];
  center: THREE.Vector3;
  totalArea: number;
}

export function extractFacesFromGeometry(geometry: THREE.BufferGeometry): FaceData[] {
  const faces: FaceData[] = [];
  const positionAttribute = geometry.getAttribute('position');
  const indexAttribute = geometry.getIndex();

  if (!positionAttribute) {
    console.warn('No position attribute found in geometry');
    return faces;
  }

  const positions = positionAttribute.array as Float32Array;
  const indices = indexAttribute ? (indexAttribute.array as Uint16Array | Uint32Array) : null;

  const vertexCount = indices ? indices.length : positions.length / 3;
  const faceCount = Math.floor(vertexCount / 3);

  for (let i = 0; i < faceCount; i++) {
    const i0 = indices ? indices[i * 3] : i * 3;
    const i1 = indices ? indices[i * 3 + 1] : i * 3 + 1;
    const i2 = indices ? indices[i * 3 + 2] : i * 3 + 2;

    const v0 = new THREE.Vector3(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
    const v1 = new THREE.Vector3(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    const v2 = new THREE.Vector3(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);

    const edge1 = new THREE.Vector3().subVectors(v1, v0);
    const edge2 = new THREE.Vector3().subVectors(v2, v0);
    const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();

    const center = new THREE.Vector3().add(v0).add(v1).add(v2).divideScalar(3);
    const area = edge1.cross(edge2).length() / 2;

    faces.push({ faceIndex: i, normal, center, vertices: [v0, v1, v2], area });
  }

  return faces;
}

function areVerticesShared(face1: FaceData, face2: FaceData, tolerance: number = 0.001): boolean {
  for (const v1 of face1.vertices) {
    for (const v2 of face2.vertices) {
      if (v1.distanceTo(v2) < tolerance) return true;
    }
  }
  return false;
}

function isAxisAligned(normal: THREE.Vector3, tolerance: number = 0.98): boolean {
  const absX = Math.abs(normal.x);
  const absY = Math.abs(normal.y);
  const absZ = Math.abs(normal.z);
  return absX > tolerance || absY > tolerance || absZ > tolerance;
}

function calculateSurfaceType(
  face: FaceData,
  faces: FaceData[],
  adjacencyMap: Map<number, Set<number>>
): 'flat' | 'curved' {
  if (isAxisAligned(face.normal, 0.95)) return 'flat';

  const neighbors = adjacencyMap.get(face.faceIndex);
  if (!neighbors || neighbors.size === 0) return 'curved';

  let hasAxisAlignedNeighbor = false;
  let hasCurvedNeighbor = false;

  for (const neighborIdx of neighbors) {
    const neighbor = faces[neighborIdx];
    if (isAxisAligned(neighbor.normal, 0.95)) hasAxisAlignedNeighbor = true;

    const dot = face.normal.dot(neighbor.normal);
    const angle = Math.acos(Math.min(1, Math.max(-1, dot))) * (180 / Math.PI);
    if (angle > 2 && angle < 50) hasCurvedNeighbor = true;
  }

  if (hasCurvedNeighbor && !isAxisAligned(face.normal, 0.9)) return 'curved';
  if (hasAxisAlignedNeighbor && isAxisAligned(face.normal, 0.9)) return 'flat';
  return 'curved';
}

function buildAdjacencyMap(faces: FaceData[]): Map<number, Set<number>> {
  const adjacencyMap = new Map<number, Set<number>>();

  for (let i = 0; i < faces.length; i++) {
    adjacencyMap.set(i, new Set<number>());
  }

  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      if (areVerticesShared(faces[i], faces[j])) {
        adjacencyMap.get(i)!.add(j);
        adjacencyMap.get(j)!.add(i);
      }
    }
  }

  return adjacencyMap;
}

export function groupCoplanarFaces(
  faces: FaceData[],
  thresholdAngleDegrees: number = 10
): CoplanarFaceGroup[] {
  const groups: CoplanarFaceGroup[] = [];
  const visited = new Set<number>();
  const adjacencyMap = buildAdjacencyMap(faces);

  const surfaceTypes = new Map<number, 'flat' | 'curved'>();
  faces.forEach((face) => {
    const surfaceType = calculateSurfaceType(face, faces, adjacencyMap);
    surfaceTypes.set(face.faceIndex, surfaceType);
    face.isCurved = surfaceType === 'curved';
  });

  for (let startIdx = 0; startIdx < faces.length; startIdx++) {
    if (visited.has(startIdx)) continue;

    const currentGroup: number[] = [startIdx];
    visited.add(startIdx);

    const stack: number[] = [startIdx];
    const startSurfaceType = surfaceTypes.get(startIdx) || 'curved';

    while (stack.length > 0) {
      const currIdx = stack.pop()!;
      const currFace = faces[currIdx];

      const neighbors = adjacencyMap.get(currIdx);
      if (!neighbors) continue;

      for (const neighborIdx of neighbors) {
        if (visited.has(neighborIdx)) continue;

        const neighborFace = faces[neighborIdx];
        const neighborSurfaceType = surfaceTypes.get(neighborIdx) || 'curved';

        if (startSurfaceType !== neighborSurfaceType) continue;

        const dot = currFace.normal.dot(neighborFace.normal);
        const angle = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;

        const effectiveThreshold = startSurfaceType === 'curved' ? 45 : thresholdAngleDegrees;

        if (angle < effectiveThreshold) {
          visited.add(neighborIdx);
          currentGroup.push(neighborIdx);
          stack.push(neighborIdx);
        }
      }
    }

    const avgCenter = new THREE.Vector3();
    const avgNormal = new THREE.Vector3();
    let totalArea = 0;

    currentGroup.forEach(idx => {
      const face = faces[idx];
      avgCenter.add(face.center);
      avgNormal.add(face.normal);
      totalArea += face.area;
    });

    avgCenter.divideScalar(currentGroup.length);
    avgNormal.divideScalar(currentGroup.length).normalize();

    groups.push({
      normal: avgNormal,
      faceIndices: currentGroup,
      center: avgCenter,
      totalArea
    });
  }

  return groups;
}

export function createGroupBoundaryEdges(
  faces: FaceData[],
  groups: CoplanarFaceGroup[]
): THREE.BufferGeometry {
  const edgeVertices: number[] = [];
  const faceToGroup = new Map<number, number>();

  groups.forEach((group, groupIdx) => {
    group.faceIndices.forEach(faceIdx => {
      faceToGroup.set(faceIdx, groupIdx);
    });
  });

  const edgeMap = new Map<string, { v1: THREE.Vector3; v2: THREE.Vector3; faces: number[] }>();

  faces.forEach((face) => {
    const verts = face.vertices;
    for (let i = 0; i < 3; i++) {
      const v1 = verts[i];
      const v2 = verts[(i + 1) % 3];

      const key1 = `${v1.x.toFixed(4)},${v1.y.toFixed(4)},${v1.z.toFixed(4)}`;
      const key2 = `${v2.x.toFixed(4)},${v2.y.toFixed(4)},${v2.z.toFixed(4)}`;
      const edgeKey = key1 < key2 ? `${key1}-${key2}` : `${key2}-${key1}`;

      if (!edgeMap.has(edgeKey)) {
        edgeMap.set(edgeKey, { v1: v1.clone(), v2: v2.clone(), faces: [] });
      }
      edgeMap.get(edgeKey)!.faces.push(face.faceIndex);
    }
  });

  edgeMap.forEach((edge) => {
    if (edge.faces.length === 2) {
      const group1 = faceToGroup.get(edge.faces[0]);
      const group2 = faceToGroup.get(edge.faces[1]);

      if (group1 !== undefined && group2 !== undefined && group1 !== group2) {
        edgeVertices.push(edge.v1.x, edge.v1.y, edge.v1.z);
        edgeVertices.push(edge.v2.x, edge.v2.y, edge.v2.z);
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(edgeVertices, 3));
  return geometry;
}

export function findClosestFaceToRay(
  raycaster: THREE.Raycaster,
  mesh: THREE.Mesh,
  _worldMatrix: THREE.Matrix4
): number | null {
  const intersects = raycaster.intersectObject(mesh, false);
  if (intersects.length === 0) return null;
  const closest = intersects[0];
  return closest.faceIndex !== undefined ? closest.faceIndex : null;
}

export function createFaceHighlightGeometry(
  faces: FaceData[],
  faceIndices: number[]
): THREE.BufferGeometry {
  const positions: number[] = [];

  faceIndices.forEach(faceIndex => {
    const face = faces[faceIndex];
    if (face) {
      face.vertices.forEach(vertex => {
        positions.push(vertex.x, vertex.y, vertex.z);
      });
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function getFaceWorldPosition(
  face: FaceData,
  worldMatrix: THREE.Matrix4
): THREE.Vector3 {
  return face.center.clone().applyMatrix4(worldMatrix);
}

export function getFaceWorldNormal(
  face: FaceData,
  worldMatrix: THREE.Matrix4
): THREE.Vector3 {
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);
  return face.normal.clone().applyMatrix3(normalMatrix).normalize();
}

function getAxisDirection(normal: THREE.Vector3): 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-' | null {
  const tolerance = 0.95;
  if (normal.x > tolerance) return 'x+';
  if (normal.x < -tolerance) return 'x-';
  if (normal.y > tolerance) return 'y+';
  if (normal.y < -tolerance) return 'y-';
  if (normal.z > tolerance) return 'z+';
  if (normal.z < -tolerance) return 'z-';
  return null;
}

export function createFaceDescriptor(
  face: FaceData,
  geometry: THREE.BufferGeometry
): { normal: [number, number, number]; normalizedCenter: [number, number, number]; area: number; isCurved?: boolean; axisDirection?: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-' | null } {
  const boundingBox = new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute('position')
  );
  const size = new THREE.Vector3();
  const min = new THREE.Vector3();
  boundingBox.getSize(size);
  min.copy(boundingBox.min);

  const normalizedCenter: [number, number, number] = [
    size.x > 0 ? (face.center.x - min.x) / size.x : 0.5,
    size.y > 0 ? (face.center.y - min.y) / size.y : 0.5,
    size.z > 0 ? (face.center.z - min.z) / size.z : 0.5
  ];

  const axisDirection = getAxisDirection(face.normal);
  const isCurved = face.isCurved || axisDirection === null;

  return {
    normal: [face.normal.x, face.normal.y, face.normal.z],
    normalizedCenter,
    area: face.area,
    isCurved,
    axisDirection
  };
}

export function findFaceByDescriptor(
  descriptor: { normal: [number, number, number]; normalizedCenter: [number, number, number]; area: number; isCurved?: boolean; axisDirection?: string | null },
  faces: FaceData[],
  geometry: THREE.BufferGeometry
): FaceData | null {
  let bestMatch: FaceData | null = null;
  let bestScore = Infinity;

  const targetNormal = new THREE.Vector3(...descriptor.normal);
  const targetAxisDir = descriptor.axisDirection || getAxisDirection(targetNormal);
  const isFlatSurface = targetAxisDir !== null && !descriptor.isCurved;

  for (const face of faces) {
    const faceDescriptor = createFaceDescriptor(face, geometry);
    const faceAxisDir = faceDescriptor.axisDirection;

    if (isFlatSurface) {
      if (faceAxisDir !== targetAxisDir) continue;

      let relevantCenterDiff = 0;
      if (targetAxisDir === 'x+' || targetAxisDir === 'x-') {
        relevantCenterDiff = Math.sqrt(
          Math.pow(faceDescriptor.normalizedCenter[1] - descriptor.normalizedCenter[1], 2) +
          Math.pow(faceDescriptor.normalizedCenter[2] - descriptor.normalizedCenter[2], 2)
        );
      } else if (targetAxisDir === 'y+' || targetAxisDir === 'y-') {
        relevantCenterDiff = Math.sqrt(
          Math.pow(faceDescriptor.normalizedCenter[0] - descriptor.normalizedCenter[0], 2) +
          Math.pow(faceDescriptor.normalizedCenter[2] - descriptor.normalizedCenter[2], 2)
        );
      } else if (targetAxisDir === 'z+' || targetAxisDir === 'z-') {
        relevantCenterDiff = Math.sqrt(
          Math.pow(faceDescriptor.normalizedCenter[0] - descriptor.normalizedCenter[0], 2) +
          Math.pow(faceDescriptor.normalizedCenter[1] - descriptor.normalizedCenter[1], 2)
        );
      }

      const score = relevantCenterDiff * 10;
      if (score < bestScore) {
        bestScore = score;
        bestMatch = face;
      }
    } else {
      const dotProduct = targetNormal.dot(face.normal);
      const normalAngle = Math.acos(Math.min(1, Math.max(-1, dotProduct))) * (180 / Math.PI);
      if (normalAngle > 15) continue;

      const centerDiff = Math.sqrt(
        Math.pow(faceDescriptor.normalizedCenter[0] - descriptor.normalizedCenter[0], 2) +
        Math.pow(faceDescriptor.normalizedCenter[1] - descriptor.normalizedCenter[1], 2) +
        Math.pow(faceDescriptor.normalizedCenter[2] - descriptor.normalizedCenter[2], 2)
      );

      const score = normalAngle * 2 + centerDiff * 10;
      if (score < bestScore) {
        bestScore = score;
        bestMatch = face;
      }
    }
  }

  if (!bestMatch) {
    console.warn(`No face match found for normal: [${descriptor.normal.map(n => n.toFixed(2)).join(', ')}], AxisDir: ${targetAxisDir}`);
  }

  return bestMatch;
}
