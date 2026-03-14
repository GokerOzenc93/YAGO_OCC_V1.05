import * as THREE from 'three';
import { evaluateExpression } from './Expression';
import type { FilletInfo } from '../store';

export const getOriginalSize = (geometry: THREE.BufferGeometry) => {
  const box = new THREE.Box3().setFromBufferAttribute(
    geometry.attributes.position as THREE.BufferAttribute
  );
  const size = new THREE.Vector3();
  box.getSize(size);
  return size;
};

export async function updateFilletCentersForNewGeometry(
  fillets: FilletInfo[],
  newGeometry: THREE.BufferGeometry,
  newSize: { width: number; height: number; depth: number }
): Promise<FilletInfo[]> {
  if (!fillets || fillets.length === 0) return fillets;

  console.log('🔄 Updating fillet centers for new geometry using descriptors...');

  const { extractFacesFromGeometry, findFaceByDescriptor } = await import('./FaceEditor');

  const faces = extractFacesFromGeometry(newGeometry);

  const updatedFillets = fillets.map((fillet, idx) => {
    console.log(`🔄 Updating fillet #${idx + 1} using descriptors...`);
    console.log(`   Current radius: ${fillet.radius}`);

    if (!fillet.face1Descriptor || !fillet.face2Descriptor) {
      console.warn(`⚠️ Fillet #${idx + 1} missing descriptors, skipping update`);
      return fillet;
    }

    console.log(`   Face1 descriptor - Normal: [${fillet.face1Descriptor.normal.map(n => n.toFixed(2)).join(', ')}]`);
    console.log(`   Face2 descriptor - Normal: [${fillet.face2Descriptor.normal.map(n => n.toFixed(2)).join(', ')}]`);

    const newFace1 = findFaceByDescriptor(fillet.face1Descriptor, faces, newGeometry);
    const newFace2 = findFaceByDescriptor(fillet.face2Descriptor, faces, newGeometry);

    if (!newFace1) {
      console.error(`❌ Could not find matching face1 for fillet #${idx + 1}`);
      console.error(`   Target normal: [${fillet.face1Descriptor.normal.map(n => n.toFixed(2)).join(', ')}]`);
      return fillet;
    }

    if (!newFace2) {
      console.error(`❌ Could not find matching face2 for fillet #${idx + 1}`);
      console.error(`   Target normal: [${fillet.face2Descriptor.normal.map(n => n.toFixed(2)).join(', ')}]`);
      return fillet;
    }

    console.log(`✅ Fillet #${idx + 1} updated - Found matching faces by descriptor`);

    return {
      ...fillet,
      face1Data: {
        normal: [newFace1.normal.x, newFace1.normal.y, newFace1.normal.z] as [number, number, number],
        center: [newFace1.center.x, newFace1.center.y, newFace1.center.z] as [number, number, number]
      },
      face2Data: {
        normal: [newFace2.normal.x, newFace2.normal.y, newFace2.normal.z] as [number, number, number],
        center: [newFace2.center.x, newFace2.center.y, newFace2.center.z] as [number, number, number]
      },
      originalSize: newSize
    };
  });

  console.log(`✅ Updated ${updatedFillets.length} fillet center(s) using descriptors`);
  return updatedFillets;
}

export async function applyFillets(replicadShape: any, fillets: FilletInfo[], shapeSize: { width: number; height: number; depth: number }) {
  if (!fillets || fillets.length === 0) return replicadShape;

  console.log(`🔵 Applying ${fillets.length} fillet(s) to shape...`);

  let currentShape = replicadShape;

  for (const fillet of fillets) {
    console.log(`🔵 Applying fillet with radius ${fillet.radius}...`);

    const scaleX = shapeSize.width / fillet.originalSize.width;
    const scaleY = shapeSize.height / fillet.originalSize.height;
    const scaleZ = shapeSize.depth / fillet.originalSize.depth;

    const face1Center = new THREE.Vector3(...fillet.face1Data.center);
    face1Center.multiply(new THREE.Vector3(scaleX, scaleY, scaleZ));

    const face2Center = new THREE.Vector3(...fillet.face2Data.center);
    face2Center.multiply(new THREE.Vector3(scaleX, scaleY, scaleZ));

    const face1Normal = new THREE.Vector3(...fillet.face1Data.normal);
    const face2Normal = new THREE.Vector3(...fillet.face2Data.normal);

    console.log(`📐 Scaled face centers for new dimensions (${shapeSize.width}x${shapeSize.height}x${shapeSize.depth})`);
    console.log(`   Face1 center: (${face1Center.x.toFixed(2)}, ${face1Center.y.toFixed(2)}, ${face1Center.z.toFixed(2)})`);
    console.log(`   Face2 center: (${face2Center.x.toFixed(2)}, ${face2Center.y.toFixed(2)}, ${face2Center.z.toFixed(2)})`);

    let edgeCount = 0;
    let foundEdgeCount = 0;

    currentShape = currentShape.fillet((edge: any) => {
      edgeCount++;
      try {
        const start = edge.startPoint;
        const end = edge.endPoint;

        if (!start || !end) return null;

        const startVec = new THREE.Vector3(start.x, start.y, start.z);
        const endVec = new THREE.Vector3(end.x, end.y, end.z);
        const centerVec = new THREE.Vector3(
          (start.x + end.x) / 2,
          (start.y + end.y) / 2,
          (start.z + end.z) / 2
        );

        const maxDimension = Math.max(shapeSize.width || 1, shapeSize.height || 1, shapeSize.depth || 1);
        const tolerance = maxDimension * 0.05;

        const startDistFace1 = Math.abs(startVec.clone().sub(face1Center).dot(face1Normal));
        const startDistFace2 = Math.abs(startVec.clone().sub(face2Center).dot(face2Normal));
        const endDistFace1 = Math.abs(endVec.clone().sub(face1Center).dot(face1Normal));
        const endDistFace2 = Math.abs(endVec.clone().sub(face2Center).dot(face2Normal));
        const centerDistFace1 = Math.abs(centerVec.clone().sub(face1Center).dot(face1Normal));
        const centerDistFace2 = Math.abs(centerVec.clone().sub(face2Center).dot(face2Normal));

        const allPointsOnFace1 = startDistFace1 < tolerance && endDistFace1 < tolerance && centerDistFace1 < tolerance;
        const allPointsOnFace2 = startDistFace2 < tolerance && endDistFace2 < tolerance && centerDistFace2 < tolerance;

        if (allPointsOnFace1 && allPointsOnFace2) {
          foundEdgeCount++;
          console.log(`Found shared edge #${foundEdgeCount} - applying fillet radius: ${fillet.radius}`);
          return fillet.radius;
        }

        return null;
      } catch (e) {
        console.error('Error checking edge:', e);
        return null;
      }
    });

    console.log(`Total edges checked: ${edgeCount}, Edges filleted: ${foundEdgeCount}`);
  }

  console.log('✅ All fillets applied successfully!');
  return currentShape;
}

function copyPosition(shape: any): [number, number, number] {
  return [shape.position[0], shape.position[1], shape.position[2]];
}

async function applyAllSubtractions(
  baseReplicadShape: any,
  subtractions: any[],
  createReplicadBox: any,
  performBooleanCut: any
) {
  let result = baseReplicadShape;
  for (const subtraction of subtractions) {
    if (!subtraction) continue;
    const subSize = getOriginalSize(subtraction.geometry);
    const subBox = await createReplicadBox({ width: subSize.x, height: subSize.y, depth: subSize.z });
    result = await performBooleanCut(
      result, subBox, undefined,
      subtraction.relativeOffset, undefined,
      subtraction.relativeRotation || [0, 0, 0], undefined,
      subtraction.scale || [1, 1, 1] as [number, number, number]
    );
  }
  return result;
}

async function finalizeWithFillets(
  replicadShape: any,
  fillets: FilletInfo[],
  shapeSize: { width: number; height: number; depth: number },
  convertReplicadToThreeGeometry: any,
  getReplicadVertices: any
): Promise<{ shape: any; geometry: THREE.BufferGeometry; vertices: THREE.Vector3[]; fillets: FilletInfo[] }> {
  if (fillets.length === 0) {
    return {
      shape: replicadShape,
      geometry: convertReplicadToThreeGeometry(replicadShape),
      vertices: await getReplicadVertices(replicadShape),
      fillets: []
    };
  }
  const preFilletGeometry = convertReplicadToThreeGeometry(replicadShape);
  const updatedFillets = await updateFilletCentersForNewGeometry(fillets, preFilletGeometry, shapeSize);
  const filletedShape = await applyFillets(replicadShape, updatedFillets, shapeSize);
  return {
    shape: filletedShape,
    geometry: convertReplicadToThreeGeometry(filletedShape),
    vertices: await getReplicadVertices(filletedShape),
    fillets: updatedFillets
  };
}

interface ApplyShapeChangesParams {
  selectedShape: any;
  width: number;
  height: number;
  depth: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  customParameters: any[];
  vertexModifications: any[];
  filletRadii?: number[];
  selectedSubtractionIndex: number | null;
  subWidth: number;
  subHeight: number;
  subDepth: number;
  subPosX: number;
  subPosY: number;
  subPosZ: number;
  subRotX: number;
  subRotY: number;
  subRotZ: number;
  subParams?: {
    width: { expression: string; result: number };
    height: { expression: string; result: number };
    depth: { expression: string; result: number };
    posX: { expression: string; result: number };
    posY: { expression: string; result: number };
    posZ: { expression: string; result: number };
    rotX: { expression: string; result: number };
    rotY: { expression: string; result: number };
    rotZ: { expression: string; result: number };
  };
  updateShape: (id: string, updates: any) => void;
}

export async function applyShapeChanges(params: ApplyShapeChangesParams) {
  const {
    selectedShape,
    width,
    height,
    depth,
    rotX,
    rotY,
    rotZ,
    customParameters,
    vertexModifications,
    filletRadii,
    selectedSubtractionIndex,
    subWidth,
    subHeight,
    subDepth,
    subPosX,
    subPosY,
    subPosZ,
    subRotX,
    subRotY,
    subRotZ,
    subParams,
    updateShape
  } = params;

  if (!selectedShape) return;

  console.log('📐 Applying parameter changes:', { width, height, depth });

  try {
    const { getBoxVertices, getReplicadVertices } = await import('./VertexEditorService');
    const { createReplicadBox, performBooleanCut, convertReplicadToThreeGeometry } = await import('./ReplicadService');

    let newBaseVertices: THREE.Vector3[] = [];
    let currentBaseVertices: THREE.Vector3[] = [];

    const currentWidth = selectedShape.parameters.width;
    const currentHeight = selectedShape.parameters.height;
    const currentDepth = selectedShape.parameters.depth;

    const scaleX = width / currentWidth;
    const scaleY = height / currentHeight;
    const scaleZ = depth / currentDepth;

    const dimensionsChanged = width !== currentWidth || height !== currentHeight || depth !== currentDepth;

    if (selectedShape.parameters.scaledBaseVertices?.length > 0) {
      currentBaseVertices = selectedShape.parameters.scaledBaseVertices.map((v: number[]) => new THREE.Vector3(v[0], v[1], v[2]));
      newBaseVertices = dimensionsChanged ? currentBaseVertices.map(v => new THREE.Vector3(v.x * scaleX, v.y * scaleY, v.z * scaleZ)) : currentBaseVertices;
    } else if (selectedShape.replicadShape) {
      currentBaseVertices = await getReplicadVertices(selectedShape.replicadShape);
      newBaseVertices = dimensionsChanged ? currentBaseVertices.map(v => new THREE.Vector3(v.x * scaleX, v.y * scaleY, v.z * scaleZ)) : currentBaseVertices;
    } else if (selectedShape.type === 'box') {
      newBaseVertices = getBoxVertices(width, height, depth);
      currentBaseVertices = getBoxVertices(currentWidth, currentHeight, currentDepth);
    }

    const vertexFinalPositions = new Map<number, [number, number, number]>();

    const evalContext = {
      W: width,
      H: height,
      D: depth,
      ...customParameters.reduce((acc, param) => ({ ...acc, [param.name]: param.result }), {})
    };

    vertexModifications.forEach((mod: any) => {
      const newOriginalPos = newBaseVertices[mod.vertexIndex]
        ? [newBaseVertices[mod.vertexIndex].x, newBaseVertices[mod.vertexIndex].y, newBaseVertices[mod.vertexIndex].z] as [number, number, number]
        : mod.originalPosition;

      if (!vertexFinalPositions.has(mod.vertexIndex)) {
        vertexFinalPositions.set(mod.vertexIndex, [...newOriginalPos] as [number, number, number]);
      }

      const offsetValue = evaluateExpression(mod.expression, evalContext);
      const axisIndex = mod.direction.startsWith('x') ? 0 : mod.direction.startsWith('y') ? 1 : 2;
      vertexFinalPositions.get(mod.vertexIndex)![axisIndex] = offsetValue;
    });

    const updatedVertexMods = vertexModifications.map((mod: any) => {
      const newOriginalPos = newBaseVertices[mod.vertexIndex]
        ? [newBaseVertices[mod.vertexIndex].x, newBaseVertices[mod.vertexIndex].y, newBaseVertices[mod.vertexIndex].z] as [number, number, number]
        : mod.originalPosition;

      const axisIndex = mod.direction.startsWith('x') ? 0 : mod.direction.startsWith('y') ? 1 : 2;
      const finalPos = vertexFinalPositions.get(mod.vertexIndex)!;
      const newOffset = [0, 0, 0] as [number, number, number];
      newOffset[axisIndex] = finalPos[axisIndex] - newOriginalPos[axisIndex];

      return {
        ...mod,
        originalPosition: newOriginalPos,
        newPosition: finalPos,
        offset: newOffset,
        expression: mod.expression
      };
    });

    let scaledGeometry = selectedShape.geometry;
    const hasFillets = selectedShape.fillets && selectedShape.fillets.length > 0;

    if (dimensionsChanged && selectedShape.geometry) {
      if (hasFillets) {
        console.log('🔵 Dimensions changed with fillets - will recreate shape with fillets (not scale)');
      } else {
        console.log('📏 Scaling geometry by:', { scaleX, scaleY, scaleZ });
        scaledGeometry = selectedShape.geometry.clone();
        scaledGeometry.scale(scaleX, scaleY, scaleZ);
        scaledGeometry.computeVertexNormals();
        scaledGeometry.computeBoundingBox();
        scaledGeometry.computeBoundingSphere();

        const box = new THREE.Box3().setFromBufferAttribute(
          scaledGeometry.getAttribute('position')
        );
        const center = new THREE.Vector3();
        box.getCenter(center);
        console.log('✓ Scaled geometry center:', { x: center.x.toFixed(2), y: center.y.toFixed(2), z: center.z.toFixed(2) });
      }
    }

    const hasSubtractionChanges = selectedSubtractionIndex !== null && selectedShape.subtractionGeometries?.length > 0;

    const newRotation: [number, number, number] = [
      rotX * (Math.PI / 180),
      rotY * (Math.PI / 180),
      rotZ * (Math.PI / 180)
    ];

    const baseUpdate = {
      parameters: {
        ...selectedShape.parameters,
        width,
        height,
        depth,
        customParameters,
        scaledBaseVertices: newBaseVertices.length > 0 ? newBaseVertices.map(v => [v.x, v.y, v.z]) : selectedShape.parameters.scaledBaseVertices
      },
      vertexModifications: updatedVertexMods,
      rotation: newRotation,
      scale: selectedShape.scale
    };

    if (hasSubtractionChanges) {
      const subReplicadGeometry = convertReplicadToThreeGeometry(
        await createReplicadBox({ width: subWidth, height: subHeight, depth: subDepth })
      );

      const updatedSubtraction = {
        ...selectedShape.subtractionGeometries![selectedSubtractionIndex],
        geometry: subReplicadGeometry,
        relativeOffset: [subPosX, subPosY, subPosZ] as [number, number, number],
        relativeRotation: [subRotX * (Math.PI / 180), subRotY * (Math.PI / 180), subRotZ * (Math.PI / 180)] as [number, number, number],
        parameters: subParams ? {
          width: subParams.width.expression, height: subParams.height.expression, depth: subParams.depth.expression,
          posX: subParams.posX.expression, posY: subParams.posY.expression, posZ: subParams.posZ.expression,
          rotX: subParams.rotX.expression, rotY: subParams.rotY.expression, rotZ: subParams.rotZ.expression
        } : undefined
      };

      const allSubtractions = selectedShape.subtractionGeometries!.map((sub: any, idx: number) =>
        idx === selectedSubtractionIndex ? updatedSubtraction : sub
      );

      const baseShape = await createReplicadBox({ width, height, depth });
      const resultShape = await applyAllSubtractions(baseShape, allSubtractions, createReplicadBox, performBooleanCut);
      const preservedPosition = copyPosition(selectedShape);
      const shapeSize = { width, height, depth };
      const final = await finalizeWithFillets(resultShape, selectedShape.fillets || [], shapeSize, convertReplicadToThreeGeometry, getReplicadVertices);

      updateShape(selectedShape.id, {
        geometry: final.geometry,
        replicadShape: final.shape,
        subtractionGeometries: allSubtractions,
        fillets: final.fillets,
        position: preservedPosition,
        rotation: baseUpdate.rotation,
        scale: baseUpdate.scale,
        vertexModifications: baseUpdate.vertexModifications,
        parameters: { ...baseUpdate.parameters, scaledBaseVertices: final.vertices.map(v => [v.x, v.y, v.z]) }
      });
    } else if (dimensionsChanged) {
      let newReplicadShape = await createReplicadBox({ width, height, depth });

      if (selectedShape.subtractionGeometries?.length > 0) {
        newReplicadShape = await applyAllSubtractions(newReplicadShape, selectedShape.subtractionGeometries, createReplicadBox, performBooleanCut);
      }

      let updatedFillets = selectedShape.fillets || [];
      if (filletRadii && filletRadii.length > 0) {
        updatedFillets = updatedFillets.map((fillet: FilletInfo, idx: number) => ({
          ...fillet,
          radius: filletRadii[idx] !== undefined ? filletRadii[idx] : fillet.radius
        }));
      }

      const preservedPosition = copyPosition(selectedShape);
      const shapeSize = { width, height, depth };
      const final = await finalizeWithFillets(newReplicadShape, updatedFillets, shapeSize, convertReplicadToThreeGeometry, getReplicadVertices);

      updateShape(selectedShape.id, {
        geometry: final.geometry,
        replicadShape: final.shape,
        fillets: final.fillets,
        position: preservedPosition,
        rotation: baseUpdate.rotation,
        scale: baseUpdate.scale,
        vertexModifications: baseUpdate.vertexModifications,
        parameters: { ...baseUpdate.parameters, scaledBaseVertices: final.vertices.map(v => [v.x, v.y, v.z]) }
      });
    } else {
      const filletsChanged = filletRadii && filletRadii.length > 0 &&
        filletRadii.some((r, idx) => (selectedShape.fillets?.[idx]?.radius || 0) !== r);

      if (filletsChanged && selectedShape.replicadShape) {
        let updatedFillets = (selectedShape.fillets || []).map((fillet: FilletInfo, idx: number) => ({
          ...fillet,
          radius: filletRadii![idx] !== undefined ? filletRadii![idx] : fillet.radius
        }));

        let newReplicadShape = await createReplicadBox({ width, height, depth });
        if (selectedShape.subtractionGeometries?.length > 0) {
          newReplicadShape = await applyAllSubtractions(newReplicadShape, selectedShape.subtractionGeometries, createReplicadBox, performBooleanCut);
        }

        const preservedPosition = copyPosition(selectedShape);
        const shapeSize = { width, height, depth };
        const final = await finalizeWithFillets(newReplicadShape, updatedFillets, shapeSize, convertReplicadToThreeGeometry, getReplicadVertices);

        updateShape(selectedShape.id, {
          geometry: final.geometry,
          replicadShape: final.shape,
          fillets: final.fillets,
          position: preservedPosition,
          rotation: baseUpdate.rotation,
          scale: baseUpdate.scale,
          vertexModifications: baseUpdate.vertexModifications,
          parameters: { ...baseUpdate.parameters, scaledBaseVertices: final.vertices.map(v => [v.x, v.y, v.z]) }
        });
      } else {
        updateShape(selectedShape.id, {
          rotation: baseUpdate.rotation,
          scale: baseUpdate.scale,
          vertexModifications: baseUpdate.vertexModifications,
          parameters: baseUpdate.parameters
        });
      }
    }

    console.log('✅ Parameters applied');
  } catch (error) {
    console.error('❌ Failed to update parameters:', error);
    updateShape(selectedShape.id, {
      parameters: { ...selectedShape.parameters, width, height, depth, customParameters },
      vertexModifications: []
    });
  }
}

interface ApplySubtractionChangesParams {
  selectedShapeId: string | null;
  selectedSubtractionIndex: number | null;
  shapes: any[];
  subWidth: number;
  subHeight: number;
  subDepth: number;
  subPosX: number;
  subPosY: number;
  subPosZ: number;
  subRotX: number;
  subRotY: number;
  subRotZ: number;
  updateShape: (id: string, updates: any) => void;
  shapeOverride?: any;
}

export async function applySubtractionChanges(params: ApplySubtractionChangesParams) {
  const {
    selectedShapeId,
    selectedSubtractionIndex,
    shapes,
    subWidth,
    subHeight,
    subDepth,
    subPosX,
    subPosY,
    subPosZ,
    subRotX,
    subRotY,
    subRotZ,
    updateShape,
    shapeOverride
  } = params;

  const currentShape = shapeOverride || shapes.find(s => s.id === selectedShapeId);
  if (!currentShape || selectedSubtractionIndex === null || !currentShape.subtractionGeometries) return;

  console.log('🔧 Applying subtraction changes:', {
    subIndex: selectedSubtractionIndex,
    newSize: { w: subWidth, h: subHeight, d: subDepth },
    newPos: { x: subPosX, y: subPosY, z: subPosZ }
  });

  const { getReplicadVertices } = await import('./VertexEditorService');
  const { createReplicadBox, performBooleanCut, convertReplicadToThreeGeometry } = await import('./ReplicadService');

  const subReplicadShape = await createReplicadBox({
    width: subWidth,
    height: subHeight,
    depth: subDepth
  });
  const newSubGeometry = convertReplicadToThreeGeometry(subReplicadShape);
  const currentSubtraction = currentShape.subtractionGeometries[selectedSubtractionIndex];

  const updatedSubtraction = {
    ...currentSubtraction,
    geometry: newSubGeometry,
    relativeOffset: [subPosX, subPosY, subPosZ] as [number, number, number],
    relativeRotation: [
      subRotX * (Math.PI / 180),
      subRotY * (Math.PI / 180),
      subRotZ * (Math.PI / 180)
    ] as [number, number, number],
    scale: currentSubtraction.scale || [1, 1, 1] as [number, number, number],
    parameters: {
      width: String(subWidth),
      height: String(subHeight),
      depth: String(subDepth),
      posX: String(subPosX),
      posY: String(subPosY),
      posZ: String(subPosZ),
      rotX: String(subRotX),
      rotY: String(subRotY),
      rotZ: String(subRotZ)
    }
  };

  const allSubtractions = currentShape.subtractionGeometries.map((sub: any, idx: number) =>
    idx === selectedSubtractionIndex ? updatedSubtraction : sub
  );

  const shapeSize = {
    width: currentShape.parameters.width || 1,
    height: currentShape.parameters.height || 1,
    depth: currentShape.parameters.depth || 1
  };

  const baseShape = await createReplicadBox(shapeSize);
  const resultShape = await applyAllSubtractions(baseShape, allSubtractions, createReplicadBox, performBooleanCut);
  const preservedPosition = copyPosition(currentShape);
  const final = await finalizeWithFillets(resultShape, currentShape.fillets || [], shapeSize, convertReplicadToThreeGeometry, getReplicadVertices);

  updateShape(currentShape.id, {
    geometry: final.geometry,
    replicadShape: final.shape,
    subtractionGeometries: allSubtractions,
    fillets: final.fillets,
    position: preservedPosition,
    parameters: {
      ...currentShape.parameters,
      scaledBaseVertices: final.vertices.map(v => [v.x, v.y, v.z])
    }
  });
}
