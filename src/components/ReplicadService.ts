import { setOC } from 'replicad';
import initOpenCascade from 'opencascade.js';
import * as THREE from 'three';
import type { SubtractedGeometry } from '../store';

let ocInstance: any = null;
let isInitializing = false;

export const initReplicad = async () => {
  if (ocInstance) return ocInstance;
  if (isInitializing) {
    await new Promise(resolve => setTimeout(resolve, 100));
    return initReplicad();
  }

  isInitializing = true;
  try {
    console.log('🔄 Initializing OpenCascade...');
    const oc = await initOpenCascade();
    console.log('✅ OpenCascade loaded');

    console.log('🔄 Setting OpenCascade for Replicad...');
    setOC(oc);
    ocInstance = oc;
    console.log('✅ Replicad initialized with OpenCascade');
    return ocInstance;
  } catch (error) {
    console.error('❌ Failed to initialize Replicad:', error);
    throw error;
  } finally {
    isInitializing = false;
  }
};

export interface ReplicadBoxParams {
  width: number;
  height: number;
  depth: number;
}

export interface ReplicadCylinderParams {
  radius: number;
  height: number;
}

export interface ReplicadSphereParams {
  radius: number;
}

export const createReplicadBox = async (params: ReplicadBoxParams): Promise<any> => {
  const oc = await initReplicad();
  const { width, height, depth } = params;

  console.log('🔨 Creating box with replicad API...', {
    width: `${width} (X axis)`,
    height: `${height} (Y axis)`,
    depth: `${depth} (Z axis)`
  });

  const { draw } = await import('replicad');

  const boxSketch = draw()
    .movePointerTo([0, 0])
    .lineTo([width, 0])
    .lineTo([width, height])
    .lineTo([0, height])
    .close()
    .sketchOnPlane()
    .extrude(depth);

  console.log('✅ Replicad box created with origin at bottom-left-back corner');
  return boxSketch;
};

export const createReplicadCylinder = async (params: ReplicadCylinderParams): Promise<any> => {
  const oc = await initReplicad();
  const { radius, height } = params;

  console.log('🔨 Creating cylinder with replicad API...');

  const { drawCircle } = await import('replicad');
  const cylinder = drawCircle(radius)
    .sketchOnPlane()
    .extrude(height)
    .translate(radius, radius, 0);

  console.log('✅ Replicad cylinder created with origin at bottom-left-back corner:', { radius, height });
  return cylinder;
};

export const createReplicadSphere = async (params: ReplicadSphereParams): Promise<any> => {
  const oc = await initReplicad();
  const { radius } = params;

  console.log('🔨 Creating sphere with replicad API...');

  const { drawCircle } = await import('replicad');
  const sphere = drawCircle(radius)
    .sketchOnPlane()
    .revolve()
    .translate(radius, radius, radius);

  console.log('✅ Replicad sphere created with origin at bottom-left-back corner:', { radius });
  return sphere;
};

export const convertReplicadToThreeGeometry = (shape: any): THREE.BufferGeometry => {
  try {
    console.log('🔄 Converting Replicad shape to Three.js geometry...');
    console.log('Shape object:', shape);

    const mesh = shape.mesh({ tolerance: 0.1, angularTolerance: 30 });
    console.log('Mesh data:', mesh);

    const vertices: number[] = [];
    const indices: number[] = [];

    if (mesh.vertices && mesh.triangles) {
      console.log('Raw mesh data:', {
        verticesLength: mesh.vertices.length,
        trianglesLength: mesh.triangles.length
      });

      for (let i = 0; i < mesh.vertices.length; i++) {
        vertices.push(mesh.vertices[i]);
      }

      for (let i = 0; i < mesh.triangles.length; i++) {
        indices.push(mesh.triangles[i]);
      }
    } else {
      console.error('❌ Mesh vertices or triangles missing');
      throw new Error('Invalid mesh data');
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    console.log('✅ Converted Replicad shape to Three.js geometry:', {
      vertices: vertices.length / 3,
      triangles: indices.length / 3,
      boundingBox: geometry.boundingBox
    });

    return geometry;
  } catch (error) {
    console.error('❌ Failed to convert Replicad shape to Three.js geometry:', error);
    console.error('Error details:', error);
    throw error;
  }
};

export const createBoxGeometry = async (
  width: number,
  height: number,
  depth: number
): Promise<THREE.BufferGeometry> => {
  const shape = await createReplicadBox({ width, height, depth });
  return convertReplicadToThreeGeometry(shape);
};

export const createCylinderGeometry = async (
  radius: number,
  height: number
): Promise<THREE.BufferGeometry> => {
  const shape = await createReplicadCylinder({ radius, height });
  return convertReplicadToThreeGeometry(shape);
};

export const createSphereGeometry = async (
  radius: number
): Promise<THREE.BufferGeometry> => {
  const shape = await createReplicadSphere({ radius });
  return convertReplicadToThreeGeometry(shape);
};

export const performBooleanCut = async (
  baseShape: any,
  cuttingShape: any,
  basePosition?: [number, number, number],
  cuttingPosition?: [number, number, number],
  baseRotation?: [number, number, number],
  cuttingRotation?: [number, number, number],
  baseScale?: [number, number, number],
  cuttingScale?: [number, number, number],
  baseSize?: [number, number, number],
  cuttingSize?: [number, number, number]
): Promise<any> => {
  await initReplicad();

  console.log('🔪 Performing boolean cut operation...');
  console.log('Base shape (stays in local space):', baseShape);
  console.log('Cutting shape transforms:', { position: cuttingPosition, rotation: cuttingRotation, scale: cuttingScale });

  try {
    let transformedCutting = cuttingShape;

    if (cuttingScale && (cuttingScale[0] !== 1 || cuttingScale[1] !== 1 || cuttingScale[2] !== 1)) {
      console.log('📏 Scaling cutting shape by:', cuttingScale);
      transformedCutting = transformedCutting.scale(cuttingScale[0], cuttingScale[1], cuttingScale[2]);
    }

    if (cuttingRotation && (cuttingRotation[0] !== 0 || cuttingRotation[1] !== 0 || cuttingRotation[2] !== 0)) {
      console.log('🔄 Rotating cutting shape by:', cuttingRotation);
      if (cuttingRotation[0] !== 0) transformedCutting = transformedCutting.rotate(cuttingRotation[0] * (180 / Math.PI), [0, 0, 0], [1, 0, 0]);
      if (cuttingRotation[1] !== 0) transformedCutting = transformedCutting.rotate(cuttingRotation[1] * (180 / Math.PI), [0, 0, 0], [0, 1, 0]);
      if (cuttingRotation[2] !== 0) transformedCutting = transformedCutting.rotate(cuttingRotation[2] * (180 / Math.PI), [0, 0, 0], [0, 0, 1]);
    }

    if (cuttingPosition && (cuttingPosition[0] !== 0 || cuttingPosition[1] !== 0 || cuttingPosition[2] !== 0)) {
      console.log('📍 Translating cutting shape by relative offset:', cuttingPosition);
      transformedCutting = transformedCutting.translate(cuttingPosition[0], cuttingPosition[1], cuttingPosition[2]);
    }

    const result = baseShape.cut(transformedCutting);
    console.log('✅ Boolean cut completed:', result);

    return result;
  } catch (error) {
    console.error('❌ Boolean cut failed:', error);
    throw error;
  }
};

export const performBooleanUnion = async (
  shape1: any,
  shape2: any
): Promise<any> => {
  await initReplicad();

  console.log('🔗 Performing boolean union operation...');

  try {
    const result = shape1.fuse(shape2);
    console.log('✅ Boolean union completed:', result);
    return result;
  } catch (error) {
    console.error('❌ Boolean union failed:', error);
    throw error;
  }
};

export const performBooleanIntersection = async (
  shape1: any,
  shape2: any
): Promise<any> => {
  await initReplicad();

  console.log('🔀 Performing boolean intersection operation...');

  try {
    const result = shape1.intersect(shape2);
    console.log('✅ Boolean intersection completed:', result);
    return result;
  } catch (error) {
    console.error('❌ Boolean intersection failed:', error);
    throw error;
  }
};

export const createPanelFromFace = async (
  replicadShape: any,
  faceNormal: [number, number, number],
  faceCenter: [number, number, number],
  panelThickness: number,
  constraintGeometry?: any
): Promise<any> => {
  await initReplicad();

  console.log('🎨 Creating panel from face...', {
    faceNormal,
    faceCenter,
    panelThickness,
    hasConstraint: !!constraintGeometry
  });

  try {
    const faces = replicadShape.faces;
    console.log(`📋 Found ${faces.length} faces in shape`);

    interface FaceCandidate {
      face: any;
      dot: number;
      center: [number, number, number] | null;
    }

    const candidates: FaceCandidate[] = [];

    for (let i = 0; i < faces.length; i++) {
      const face = faces[i];

      try {
        const normalVec = face.normalAt(0.5, 0.5);
        const normal = [normalVec.x, normalVec.y, normalVec.z];
        const dot =
          normal[0] * faceNormal[0] +
          normal[1] * faceNormal[1] +
          normal[2] * faceNormal[2];

        if (dot > 0.7) {
          let center: [number, number, number] | null = null;
          try {
            const faceMesh = face.mesh({ tolerance: 0.5, angularTolerance: 30 });
            if (faceMesh.vertices && faceMesh.vertices.length >= 3) {
              let sx = 0, sy = 0, sz = 0;
              const nv = faceMesh.vertices.length / 3;
              for (let j = 0; j < faceMesh.vertices.length; j += 3) {
                sx += faceMesh.vertices[j];
                sy += faceMesh.vertices[j + 1];
                sz += faceMesh.vertices[j + 2];
              }
              center = [sx / nv, sy / nv, sz / nv];
            }
          } catch (meshErr) {
            console.warn(`Could not mesh face ${i} for center:`, meshErr);
          }
          candidates.push({ face, dot, center });
          console.log(`Face ${i} candidate: dot=${dot.toFixed(4)}, center=`, center);
        }
      } catch (err) {
        console.warn(`⚠️ Could not get normal for face ${i}:`, err);
      }
    }

    let matchingFace = null;

    if (candidates.length === 0) {
      console.warn('⚠️ No matching face found');
      return null;
    } else if (candidates.length === 1) {
      matchingFace = candidates[0].face;
    } else {
      let bestDist = Infinity;
      for (const candidate of candidates) {
        if (candidate.center) {
          const dist = Math.sqrt(
            (candidate.center[0] - faceCenter[0]) ** 2 +
            (candidate.center[1] - faceCenter[1]) ** 2 +
            (candidate.center[2] - faceCenter[2]) ** 2
          );
          if (dist < bestDist) {
            bestDist = dist;
            matchingFace = candidate.face;
          }
        }
      }
      if (!matchingFace) {
        matchingFace = candidates[0].face;
      }
    }

    console.log('✅ Found matching face from', candidates.length, 'candidates');

    const normalVec = matchingFace.normalAt(0.5, 0.5);
    const extrusionDirection = [
      -normalVec.x,
      -normalVec.y,
      -normalVec.z
    ];

    const oc = await initReplicad();
    const vec = new oc.gp_Vec_4(
      extrusionDirection[0] * panelThickness,
      extrusionDirection[1] * panelThickness,
      extrusionDirection[2] * panelThickness
    );

    const prismBuilder = new oc.BRepPrimAPI_MakePrism_1(matchingFace.wrapped, vec, false, true);
    prismBuilder.Build(new oc.Message_ProgressRange_1());
    const solid = prismBuilder.Shape();

    const { cast } = await import('replicad');
    let panel = cast(solid);

    if (constraintGeometry) {
      console.log('🔀 Applying constraint intersection...');
      try {
        panel = await performBooleanIntersection(panel, constraintGeometry);
        console.log('✅ Constraint intersection applied successfully');
      } catch (error) {
        console.error('❌ Failed to apply constraint intersection:', error);
      }
    }

    console.log('✅ Panel created from face successfully');
    return panel;
  } catch (error) {
    console.error('❌ Failed to create panel from face:', error);
    throw error;
  }
};

export const createPanelFromVirtualFace = async (
  vertices: [number, number, number][],
  normal: [number, number, number],
  panelThickness: number
): Promise<any> => {
  await initReplicad();

  const { draw, Plane } = await import('replicad');

  const n = new THREE.Vector3(...normal).normalize();

  let up: THREE.Vector3;
  if (Math.abs(n.y) > Math.abs(n.x) && Math.abs(n.y) > Math.abs(n.z)) {
    up = new THREE.Vector3(1, 0, 0);
  } else {
    up = new THREE.Vector3(0, 1, 0);
  }
  const uAxis = new THREE.Vector3().crossVectors(n, up).normalize();
  const vAxis = new THREE.Vector3().crossVectors(uAxis, n).normalize();

  const v3s = vertices.map(v => new THREE.Vector3(v[0], v[1], v[2]));
  const center = new THREE.Vector3();
  v3s.forEach(v => center.add(v));
  center.divideScalar(v3s.length);

  const projected: [number, number][] = v3s.map(v => {
    const d = new THREE.Vector3().subVectors(v, center);
    return [d.dot(uAxis), d.dot(vAxis)] as [number, number];
  });

  let sketch = draw().movePointerTo(projected[0]);
  for (let i = 1; i < projected.length; i++) {
    sketch = sketch.lineTo(projected[i]);
  }
  const closed = sketch.close();

  const plane = new Plane(
    [center.x, center.y, center.z],
    [uAxis.x, uAxis.y, uAxis.z],
    [n.x, n.y, n.z]
  );

  const sketched = closed.sketchOnPlane(plane);
  const panel = sketched.extrude(-panelThickness);

  return panel;
};

export const applyParentSubtractors = async (
  panelShape: any,
  subtractionGeometries: SubtractedGeometry[]
): Promise<any> => {
  if (!subtractionGeometries || subtractionGeometries.length === 0) return panelShape;

  await initReplicad();

  let result = panelShape;

  for (const sub of subtractionGeometries) {
    if (!sub.parameters) continue;

    const w = parseFloat(sub.parameters.width);
    const h = parseFloat(sub.parameters.height);
    const d = parseFloat(sub.parameters.depth);
    if (isNaN(w) || isNaN(h) || isNaN(d) || w <= 0 || h <= 0 || d <= 0) continue;

    try {
      const margin = 0.5;
      const cuttingBox = await createReplicadBox({ width: w + margin, height: h + margin, depth: d + margin });
      result = await performBooleanCut(
        result,
        cuttingBox,
        undefined,
        sub.relativeOffset,
        undefined,
        sub.relativeRotation,
        undefined,
        sub.scale
      );
    } catch (err) {
      console.error('Failed to apply subtractor to panel:', err);
    }
  }

  return result;
};
