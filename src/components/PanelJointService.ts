import { globalSettingsService } from './GlobalSettingsDatabase';
import { useAppStore, FaceRole } from '../store';
import * as THREE from 'three';

export interface PanelJointConfig {
  topLeftExpanded: boolean;
  topRightExpanded: boolean;
  bottomLeftExpanded: boolean;
  bottomRightExpanded: boolean;
}

const DEFAULT_CONFIG: PanelJointConfig = {
  topLeftExpanded: false,
  topRightExpanded: false,
  bottomLeftExpanded: false,
  bottomRightExpanded: false,
};

function getDominantRole(
  roleA: FaceRole,
  roleB: FaceRole,
  config: PanelJointConfig
): FaceRole | null {
  if (!roleA || !roleB) return null;
  if (roleA === 'Door' || roleB === 'Door') return null;
  if (roleA === roleB) return null;

  const pair = [roleA, roleB].sort().join('-');

  switch (pair) {
    case 'Left-Top':
      return config.topLeftExpanded ? 'Top' : 'Left';
    case 'Right-Top':
      return config.topRightExpanded ? 'Top' : 'Right';
    case 'Bottom-Left':
      return config.bottomLeftExpanded ? 'Bottom' : 'Left';
    case 'Bottom-Right':
      return config.bottomRightExpanded ? 'Bottom' : 'Right';
    case 'Back-Left':
      return 'Left';
    case 'Back-Right':
      return 'Right';
    case 'Back-Top':
      return 'Top';
    case 'Back-Bottom':
      return 'Bottom';
    default:
      return null;
  }
}

async function toGeometry(replicadShape: any) {
  const { convertReplicadToThreeGeometry } = await import('./ReplicadService');
  return convertReplicadToThreeGeometry(replicadShape);
}

function getReplicadBoundingBox(shape: any): { min: [number, number, number]; max: [number, number, number] } {
  const bb = shape.boundingBox;
  const [[xMin, yMin, zMin], [xMax, yMax, zMax]] = bb.bounds;
  return {
    min: [xMin, yMin, zMin],
    max: [xMax, yMax, zMax]
  };
}

async function createExtendedPanel(
  dominantOriginal: any,
  subordinateOriginals: Array<{ shape: any; role: FaceRole }>
): Promise<any | null> {
  const { createReplicadBox } = await import('./ReplicadService');

  const domBB = getReplicadBoundingBox(dominantOriginal);
  const newMin = [...domBB.min] as [number, number, number];
  const newMax = [...domBB.max] as [number, number, number];
  const domSize = [
    domBB.max[0] - domBB.min[0],
    domBB.max[1] - domBB.min[1],
    domBB.max[2] - domBB.min[2]
  ];
  const domThicknessAxis = domSize[0] <= domSize[1] && domSize[0] <= domSize[2] ? 0
    : domSize[1] <= domSize[0] && domSize[1] <= domSize[2] ? 1 : 2;

  let hasExtension = false;
  const tolerance = 0.5;

  for (const sub of subordinateOriginals) {
    const subBB = getReplicadBoundingBox(sub.shape);
    const subSize = [
      subBB.max[0] - subBB.min[0],
      subBB.max[1] - subBB.min[1],
      subBB.max[2] - subBB.min[2]
    ];
    const subThickness = Math.min(subSize[0], subSize[1], subSize[2]);
    const subThicknessAxis = subSize[0] <= subSize[1] && subSize[0] <= subSize[2] ? 0
      : subSize[1] <= subSize[0] && subSize[1] <= subSize[2] ? 1 : 2;

    if (subThicknessAxis === domThicknessAxis) continue;

    const extAxis = subThicknessAxis;
    const subCenter = (subBB.min[extAxis] + subBB.max[extAxis]) / 2;
    const domCenter = (domBB.min[extAxis] + domBB.max[extAxis]) / 2;

    if (subCenter > domCenter) {
      const targetMax = subBB.max[extAxis];
      if (domBB.max[extAxis] < targetMax - tolerance) {
        const needed = targetMax - domBB.max[extAxis];
        newMax[extAxis] = Math.max(newMax[extAxis], domBB.max[extAxis] + needed);
        hasExtension = true;
      }
    } else {
      const targetMin = subBB.min[extAxis];
      if (domBB.min[extAxis] > targetMin + tolerance) {
        const needed = domBB.min[extAxis] - targetMin;
        newMin[extAxis] = Math.min(newMin[extAxis], domBB.min[extAxis] - needed);
        hasExtension = true;
      }
    }
  }

  if (!hasExtension) return null;

  const w = newMax[0] - newMin[0];
  const h = newMax[1] - newMin[1];
  const d = newMax[2] - newMin[2];

  if (w < 0.1 || h < 0.1 || d < 0.1) return null;

  const box = await createReplicadBox({ width: w, height: h, depth: d });
  return box.translate(newMin[0], newMin[1], newMin[2]);
}

export async function loadJointConfig(profileId: string): Promise<PanelJointConfig> {
  try {
    const settings = await globalSettingsService.getProfileSettings(profileId, 'panel_joint');
    if (settings?.settings) {
      const s = settings.settings as Record<string, unknown>;
      return {
        topLeftExpanded: Boolean(s.topLeftExpanded),
        topRightExpanded: Boolean(s.topRightExpanded),
        bottomLeftExpanded: Boolean(s.bottomLeftExpanded),
        bottomRightExpanded: Boolean(s.bottomRightExpanded),
      };
    }
  } catch (err) {
    console.error('Failed to load joint config:', err);
  }
  return DEFAULT_CONFIG;
}

interface FullProfileSettings {
  jointConfig: PanelJointConfig;
  selectedBodyType: string | null;
  bazaHeight: number;
  frontBaseDistance: number;
}

async function loadFullProfileSettings(profileId: string): Promise<FullProfileSettings> {
  try {
    const settings = await globalSettingsService.getProfileSettings(profileId, 'panel_joint');
    if (settings?.settings) {
      const s = settings.settings as Record<string, unknown>;
      return {
        jointConfig: {
          topLeftExpanded: Boolean(s.topLeftExpanded),
          topRightExpanded: Boolean(s.topRightExpanded),
          bottomLeftExpanded: Boolean(s.bottomLeftExpanded),
          bottomRightExpanded: Boolean(s.bottomRightExpanded),
        },
        selectedBodyType: (s.selectedBodyType as string) || null,
        bazaHeight: typeof s.bazaHeight === 'number' ? s.bazaHeight : 100,
        frontBaseDistance: typeof s.frontBaseDistance === 'number' ? s.frontBaseDistance : 10,
      };
    }
  } catch (err) {
    console.error('Failed to load full profile settings:', err);
  }
  return {
    jointConfig: DEFAULT_CONFIG,
    selectedBodyType: null,
    bazaHeight: 100,
    frontBaseDistance: 10,
  };
}

function applyBazaOffset(parentShapeId: string, selectedBodyType: string | null, bazaHeight: number) {
  const state = useAppStore.getState();
  const parentShape = state.shapes.find(s => s.id === parentShapeId);
  if (!parentShape) return;

  const hasBottomPanels = state.shapes.some(
    s => s.type === 'panel' &&
    s.parameters?.parentShapeId === parentShapeId &&
    s.parameters?.faceRole === 'Bottom'
  );
  if (!hasBottomPanels) return;

  const yOffset = selectedBodyType === 'bazali' ? bazaHeight : 0;

  useAppStore.setState((st) => ({
    shapes: st.shapes.map(s => {
      if (s.type === 'panel' &&
          s.parameters?.parentShapeId === parentShapeId &&
          s.parameters?.faceRole === 'Bottom') {
        const parent = st.shapes.find(p => p.id === parentShapeId);
        if (!parent) return s;
        return {
          ...s,
          position: [
            parent.position[0],
            parent.position[1] + yOffset,
            parent.position[2]
          ] as [number, number, number],
          parameters: {
            ...s.parameters,
            bazaOffset: yOffset
          }
        };
      }
      return s;
    })
  }));
}

function removeExistingBazaPanels(parentShapeId: string) {
  const state = useAppStore.getState();
  const bazaIds = state.shapes
    .filter(s => s.type === 'panel' && s.parameters?.parentShapeId === parentShapeId && s.parameters?.isBaza)
    .map(s => s.id);

  if (bazaIds.length > 0) {
    useAppStore.setState(st => ({
      shapes: st.shapes.filter(s => !bazaIds.includes(s.id))
    }));
  }
}

async function generateFrontBazaPanels(
  parentShapeId: string,
  selectedBodyType: string | null,
  bazaHeight: number,
  frontBaseDistance: number
) {
  removeExistingBazaPanels(parentShapeId);

  if (selectedBodyType !== 'bazali') return;

  return;

  const { extractFacesFromGeometry, groupCoplanarFaces } = await import('./FaceEditor');
  const { createReplicadBox, convertReplicadToThreeGeometry } = await import('./ReplicadService');

  const parentFaces = extractFacesFromGeometry(parentShape.geometry);
  const parentGroups = groupCoplanarFaces(parentFaces);

  const panelThickness = 18;

  const hasLeftPanel = state.shapes.some(
    s => s.type === 'panel' &&
    s.parameters?.parentShapeId === parentShapeId &&
    s.parameters?.faceRole === 'Left'
  );
  const hasRightPanel = state.shapes.some(
    s => s.type === 'panel' &&
    s.parameters?.parentShapeId === parentShapeId &&
    s.parameters?.faceRole === 'Right'
  );

  const bottomBox = new THREE.Box3().setFromBufferAttribute(
    bottomPanel.geometry.getAttribute('position')
  );
  bottomBox.translate(new THREE.Vector3(...bottomPanel.position));
  const bazaY = bottomBox.min.y - bazaHeight;

  const newShapes: any[] = [];
  const processedDirs: string[] = [];

  for (const [indexStr, role] of Object.entries(parentShape.faceRoles)) {
    if (role !== 'Door') continue;
    const idx = parseInt(indexStr);
    if (idx >= parentGroups.length) continue;

    const doorGroup = parentGroups[idx];
    const doorNormal = doorGroup.normal.clone().normalize();

    const dirKey = `${Math.round(doorNormal.x)}_${Math.round(doorNormal.y)}_${Math.round(doorNormal.z)}`;
    if (processedDirs.includes(dirKey)) continue;
    processedDirs.push(dirKey);

    const doorVertices: THREE.Vector3[] = [];
    doorGroup.faceIndices.forEach(fi => {
      parentFaces[fi].vertices.forEach(v => doorVertices.push(v.clone()));
    });
    const doorBbox = new THREE.Box3().setFromPoints(doorVertices);

    const absNx = Math.abs(doorNormal.x);
    const absNz = Math.abs(doorNormal.z);

    let bazaWidth: number;
    let bazaDepth: number;
    let translateX: number;
    let translateZ: number;

    if (absNz >= absNx && absNz > 0.5) {
      let startX = doorBbox.min.x;
      let endX = doorBbox.max.x;

      if (hasLeftPanel) {
        startX += panelThickness;
      } else {
        startX -= frontBaseDistance;
      }

      if (hasRightPanel) {
        endX -= panelThickness;
      } else {
        endX += frontBaseDistance;
      }

      translateX = startX;
      bazaWidth = endX - startX;
      bazaDepth = panelThickness;

      if (doorNormal.z > 0) {
        translateZ = doorBbox.min.z - frontBaseDistance - panelThickness;
      } else {
        translateZ = doorBbox.max.z + frontBaseDistance;
      }
    } else if (absNx > 0.5) {
      let startZ = doorBbox.min.z;
      let endZ = doorBbox.max.z;

      if (hasLeftPanel) {
        startZ += panelThickness;
      } else {
        startZ -= frontBaseDistance;
      }

      if (hasRightPanel) {
        endZ -= panelThickness;
      } else {
        endZ += frontBaseDistance;
      }

      translateZ = startZ;
      bazaDepth = endZ - startZ;
      bazaWidth = panelThickness;

      if (doorNormal.x > 0) {
        translateX = doorBbox.min.x - frontBaseDistance - panelThickness;
      } else {
        translateX = doorBbox.max.x + frontBaseDistance;
      }
    } else {
      continue;
    }

    if (bazaWidth < 1 || bazaDepth < 1) continue;

    try {
      const bazaBox = await createReplicadBox({
        width: bazaWidth,
        height: bazaHeight,
        depth: bazaDepth
      });

      const positioned = bazaBox.translate(translateX, bazaY, translateZ);
      const geometry = convertReplicadToThreeGeometry(positioned);

      newShapes.push({
        id: `baza-front-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'panel',
        geometry,
        replicadShape: positioned,
        position: [parentShape.position[0], parentShape.position[1], parentShape.position[2]] as [number, number, number],
        rotation: parentShape.rotation,
        scale: [...parentShape.scale] as [number, number, number],
        color: '#ffffff',
        parameters: {
          parentShapeId,
          isBaza: true,
          bazaType: 'front',
          width: bazaWidth,
          height: bazaHeight,
          depth: bazaDepth
        }
      });
    } catch (err) {
      console.error('BAZA: failed to create:', err);
    }
  }

  if (newShapes.length > 0) {
    useAppStore.setState(st => ({
      shapes: [...st.shapes, ...newShapes]
    }));
  }
}

export async function rebuildAllPanels(parentShapeId: string): Promise<void> {
  const state = useAppStore.getState();
  const parentShape = state.shapes.find(s => s.id === parentShapeId);
  if (!parentShape || !parentShape.replicadShape || !parentShape.geometry) return;

  const facePanels = state.shapes.filter(
    s => s.type === 'panel' &&
    s.parameters?.parentShapeId === parentShapeId &&
    !s.parameters?.isBaza &&
    !s.parameters?.virtualFaceId
  );
  if (facePanels.length === 0) return;

  console.log(`Rebuilding ${facePanels.length} face-based panels for parent ${parentShapeId}...`);

  const { extractFacesFromGeometry, groupCoplanarFaces } = await import('./FaceEditor');
  const { createPanelFromFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');

  const faces = extractFacesFromGeometry(parentShape.geometry);
  const faceGroups = groupCoplanarFaces(faces);

  const updates: Array<{ id: string; geometry: any; replicadShape: any; parameters: any }> = [];

  for (const panel of facePanels) {
    const faceIndex = panel.parameters?.faceIndex;
    if (faceIndex === undefined) continue;

    if (faceIndex < 0 || faceIndex >= faceGroups.length) continue;

    const faceGroup = faceGroups[faceIndex];

    const localVertices: THREE.Vector3[] = [];
    faceGroup.faceIndices.forEach((idx: number) => {
      const face = faces[idx];
      face.vertices.forEach((v: THREE.Vector3) => localVertices.push(v.clone()));
    });

    const localNormal = faceGroup.normal.clone().normalize();
    const localBox = new THREE.Box3().setFromPoints(localVertices);
    const localCenter = new THREE.Vector3();
    localBox.getCenter(localCenter);

    const panelThickness = panel.parameters?.depth || 18;

    try {
      const replicadPanel = await createPanelFromFace(
        parentShape.replicadShape,
        [localNormal.x, localNormal.y, localNormal.z],
        [localCenter.x, localCenter.y, localCenter.z],
        panelThickness
      );

      if (!replicadPanel) continue;

      const geometry = convertReplicadToThreeGeometry(replicadPanel);

      updates.push({
        id: panel.id,
        geometry,
        replicadShape: replicadPanel,
        parameters: {
          ...panel.parameters,
          originalReplicadShape: null,
          jointTrimmed: false,
        }
      });
    } catch (error) {
      console.error(`Failed to rebuild panel ${panel.id}:`, error);
    }
  }

  if (updates.length > 0) {
    useAppStore.setState((st) => ({
      shapes: st.shapes.map(s => {
        const update = updates.find(u => u.id === s.id);
        if (update) {
          const parent = st.shapes.find(p => p.id === parentShapeId);
          return {
            ...s,
            geometry: update.geometry,
            replicadShape: update.replicadShape,
            position: parent ? [...parent.position] as [number, number, number] : s.position,
            rotation: parent ? parent.rotation : s.rotation,
            scale: parent ? [...parent.scale] as [number, number, number] : s.scale,
            parameters: update.parameters,
          };
        }
        return s;
      })
    }));
    console.log(`Rebuilt ${updates.length} face-based panels successfully`);
  }
}

export async function resolveAllPanelJoints(
  parentShapeId: string,
  profileId: string,
  config?: PanelJointConfig,
  skipVirtualFaceUpdate?: boolean
): Promise<void> {
  const state = useAppStore.getState();
  const fullSettings = await loadFullProfileSettings(profileId);
  const jointConfig = config || fullSettings.jointConfig;

  const panels = state.shapes.filter(
    (s) =>
      s.type === 'panel' &&
      s.parameters?.parentShapeId === parentShapeId &&
      s.parameters?.faceRole &&
      s.parameters.faceRole !== 'Door' &&
      (s.parameters?.originalReplicadShape || s.replicadShape)
  );

  if (panels.length < 2) {
    await restoreSinglePanels(panels);
    applyBazaOffset(parentShapeId, fullSettings.selectedBodyType, fullSettings.bazaHeight);
    await generateFrontBazaPanels(parentShapeId, fullSettings.selectedBodyType, fullSettings.bazaHeight, fullSettings.frontBaseDistance);
    return;
  }

  console.log(`🔗 Resolving panel joints for ${panels.length} panels...`);

  const originalShapes = new Map<string, any>();
  for (const panel of panels) {
    originalShapes.set(
      panel.id,
      panel.parameters?.originalReplicadShape || panel.replicadShape
    );
  }

  const cutsMap = new Map<string, string[]>();
  const extensionsMap = new Map<string, Array<{ subordinateId: string; subordinateRole: FaceRole }>>();

  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const pA = panels[i];
      const pB = panels[j];
      const roleA = pA.parameters?.faceRole as FaceRole;
      const roleB = pB.parameters?.faceRole as FaceRole;

      const dominant = getDominantRole(roleA, roleB, jointConfig);
      if (!dominant) continue;

      const isADominant = dominant === roleA;
      const subordinateId = isADominant ? pB.id : pA.id;
      const dominantId = isADominant ? pA.id : pB.id;
      const subordinateRole = isADominant ? roleB : roleA;

      const existing = cutsMap.get(subordinateId) || [];
      existing.push(dominantId);
      cutsMap.set(subordinateId, existing);

      const extEntries = extensionsMap.get(dominantId) || [];
      extEntries.push({ subordinateId, subordinateRole });
      extensionsMap.set(dominantId, extEntries);

      console.log(
        `  Joint: ${roleA}-${roleB} → ${dominant} dominant, ${isADominant ? roleB : roleA} trimmed`
      );
    }
  }

  const extendedShapes = new Map<string, any>();
  for (const panel of panels) {
    if (!extensionsMap.has(panel.id)) continue;
    const original = originalShapes.get(panel.id);
    if (!original) continue;

    const entries = extensionsMap.get(panel.id)!;
    const subData: Array<{ shape: any; role: FaceRole }> = [];
    for (const entry of entries) {
      const subOriginal = originalShapes.get(entry.subordinateId);
      if (subOriginal) {
        subData.push({ shape: subOriginal, role: entry.subordinateRole });
      }
    }

    if (subData.length === 0) continue;

    try {
      const extended = await createExtendedPanel(original, subData);
      if (extended) {
        console.log(`  Extended ${panel.parameters?.faceRole} toward ${subData.map(s => s.role).join(', ')}`);
        extendedShapes.set(panel.id, extended);
      }
    } catch (err) {
      console.error(`Extension failed for panel ${panel.id}:`, err);
    }
  }

  const shapeUpdates = new Map<
    string,
    { geometry: any; replicadShape: any; jointTrimmed: boolean }
  >();

  for (const panel of panels) {
    const original = originalShapes.get(panel.id);
    if (!original) continue;

    const isExtended = extendedShapes.has(panel.id);
    const isCut = cutsMap.has(panel.id);

    if (isCut || isExtended) {
      let currentShape = isExtended ? extendedShapes.get(panel.id)! : original;

      if (isCut) {
        const dominantIds = cutsMap.get(panel.id)!;
        for (const dominantId of dominantIds) {
          const cuttingShape = originalShapes.get(dominantId);
          if (!cuttingShape) continue;
          try {
            currentShape = currentShape.cut(cuttingShape);
          } catch (err) {
            console.error(`Joint cut failed for panel ${panel.id}:`, err);
          }
        }
      }

      try {
        const geo = await toGeometry(currentShape);
        shapeUpdates.set(panel.id, {
          geometry: geo,
          replicadShape: currentShape,
          jointTrimmed: true,
        });
      } catch (err) {
        console.error(`Failed to convert trimmed/extended panel:`, err);
      }
    } else if (panel.parameters?.jointTrimmed) {
      try {
        const geo = await toGeometry(original);
        shapeUpdates.set(panel.id, {
          geometry: geo,
          replicadShape: original,
          jointTrimmed: false,
        });
      } catch (err) {
        console.error(`Failed to restore panel:`, err);
      }
    }
  }

  if (shapeUpdates.size > 0) {
    batchApplyUpdates(shapeUpdates, originalShapes, parentShapeId);
    console.log(`✅ Panel joints resolved: ${shapeUpdates.size} panels updated`);
  } else {
    saveOriginalShapes(panels, parentShapeId);
  }

  applyBazaOffset(parentShapeId, fullSettings.selectedBodyType, fullSettings.bazaHeight);
  await generateFrontBazaPanels(parentShapeId, fullSettings.selectedBodyType, fullSettings.bazaHeight, fullSettings.frontBaseDistance);

  if (!skipVirtualFaceUpdate) {
    const shapeFaces = useAppStore.getState().virtualFaces.filter(vf => vf.shapeId === parentShapeId);
    if (shapeFaces.length > 0) {
      const { recalculateVirtualFacesForShape } = await import('./VirtualFaceUpdateService');
      const currentState = useAppStore.getState();
      const currentShape = currentState.shapes.find(s => s.id === parentShapeId);
      if (currentShape) {
        const updatedFaces = recalculateVirtualFacesForShape(
          currentShape,
          currentState.virtualFaces,
          currentState.shapes
        );
        useAppStore.setState({ virtualFaces: updatedFaces });

        const hasVirtualPanels = updatedFaces.some(
          vf => vf.shapeId === parentShapeId && vf.hasPanel
        );
        if (hasVirtualPanels) {
          await rebuildVirtualFacePanels(parentShapeId, updatedFaces);
        }
      }
    }
  }
}

export async function restoreAllPanels(parentShapeId: string): Promise<void> {
  const state = useAppStore.getState();
  const panels = state.shapes.filter(
    (s) =>
      s.type === 'panel' &&
      s.parameters?.parentShapeId === parentShapeId &&
      s.parameters?.jointTrimmed &&
      s.parameters?.originalReplicadShape
  );
  await restoreSinglePanels(panels);
  applyBazaOffset(parentShapeId, null, 0);
  removeExistingBazaPanels(parentShapeId);
}

async function restoreSinglePanels(panels: any[]) {
  for (const panel of panels) {
    if (panel.parameters?.jointTrimmed && panel.parameters?.originalReplicadShape) {
      try {
        const geo = await toGeometry(panel.parameters.originalReplicadShape);
        useAppStore.getState().updateShape(panel.id, {
          geometry: geo,
          replicadShape: panel.parameters.originalReplicadShape,
          parameters: {
            ...panel.parameters,
            jointTrimmed: false,
          },
        });
      } catch {}
    }
  }
}

function batchApplyUpdates(
  updates: Map<string, { geometry: any; replicadShape: any; jointTrimmed: boolean }>,
  originalShapes: Map<string, any>,
  parentShapeId: string
) {
  useAppStore.setState((state) => ({
    shapes: state.shapes.map((s) => {
      const update = updates.get(s.id);
      if (update) {
        return {
          ...s,
          geometry: update.geometry,
          replicadShape: update.replicadShape,
          parameters: {
            ...s.parameters,
            originalReplicadShape:
              originalShapes.get(s.id) ||
              s.parameters?.originalReplicadShape ||
              s.replicadShape,
            jointTrimmed: update.jointTrimmed,
          },
        };
      }
      if (
        s.type === 'panel' &&
        s.parameters?.parentShapeId === parentShapeId &&
        !s.parameters?.originalReplicadShape &&
        s.replicadShape
      ) {
        return {
          ...s,
          parameters: {
            ...s.parameters,
            originalReplicadShape: s.replicadShape,
          },
        };
      }
      return s;
    }),
  }));
}

async function recalculateAndRebuildVirtualFaces(parentShapeId: string): Promise<void> {
  const shapeFaces = useAppStore.getState().virtualFaces.filter(vf => vf.shapeId === parentShapeId);
  if (shapeFaces.length === 0) return;

  const { recalculateVirtualFacesForShape } = await import('./VirtualFaceUpdateService');
  const currentState = useAppStore.getState();
  const currentShape = currentState.shapes.find(s => s.id === parentShapeId);
  if (!currentShape) return;

  const updatedFaces = recalculateVirtualFacesForShape(
    currentShape,
    currentState.virtualFaces,
    currentState.shapes
  );
  useAppStore.setState({ virtualFaces: updatedFaces });

  const hasVirtualPanels = updatedFaces.some(
    vf => vf.shapeId === parentShapeId && vf.hasPanel
  );
  if (hasVirtualPanels) {
    await rebuildVirtualFacePanels(parentShapeId, updatedFaces);
  }
}

export async function rebuildAndRecalculatePipeline(
  parentShapeId: string,
  profileId: string | null
): Promise<void> {
  await rebuildAllPanels(parentShapeId);

  if (profileId && profileId !== 'none') {
    await resolveAllPanelJoints(parentShapeId, profileId, undefined, true);
  }

  await recalculateAndRebuildVirtualFaces(parentShapeId);
}

async function rebuildVirtualFacePanels(
  parentShapeId: string,
  updatedVirtualFaces: import('../store').VirtualFace[]
): Promise<void> {
  const state = useAppStore.getState();
  const parentShape = state.shapes.find(s => s.id === parentShapeId);
  if (!parentShape) return;

  const virtualPanels = state.shapes.filter(
    s => s.type === 'panel' &&
    s.parameters?.parentShapeId === parentShapeId &&
    s.parameters?.virtualFaceId
  );
  if (virtualPanels.length === 0) return;

  const { createPanelFromVirtualFace, convertReplicadToThreeGeometry, applyParentSubtractors } = await import('./ReplicadService');

  const parentSubtractions = parentShape.subtractionGeometries || [];
  const updates: Array<{ id: string; geometry: any; replicadShape: any; parameters: any }> = [];

  for (const panel of virtualPanels) {
    const vfId = panel.parameters.virtualFaceId;
    const vf = updatedVirtualFaces.find(f => f.id === vfId);
    if (!vf || vf.vertices.length < 3) continue;

    const panelThickness = panel.parameters?.depth || 18;
    try {
      let replicadPanel = await createPanelFromVirtualFace(
        vf.vertices,
        vf.normal,
        panelThickness
      );
      if (!replicadPanel) continue;

      if (parentSubtractions.length > 0) {
        try {
          replicadPanel = await applyParentSubtractors(replicadPanel, parentSubtractions);
        } catch (subErr) {
          console.error(`Failed to apply subtractors to virtual face panel ${panel.id}:`, subErr);
        }
      }

      const geometry = convertReplicadToThreeGeometry(replicadPanel);

      const geoSize = new THREE.Vector3();
      new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute).getSize(geoSize);
      const axesBySize = [
        { index: 0, value: geoSize.x },
        { index: 1, value: geoSize.y },
        { index: 2, value: geoSize.z }
      ].sort((a, b) => a.value - b.value);
      const planeAxes = axesBySize.slice(1).map(a => a.index).sort((a, b) => a - b);
      const roleStr = vf.role?.toLowerCase();
      let defaultAxis = planeAxes[0];
      let altAxis = planeAxes[1];
      if (roleStr === 'left' || roleStr === 'right') {
        if (planeAxes.includes(1)) { defaultAxis = 1; altAxis = planeAxes.find(a => a !== 1) ?? planeAxes[1]; }
      } else if (roleStr === 'top' || roleStr === 'bottom') {
        if (planeAxes.includes(0)) { defaultAxis = 0; altAxis = planeAxes.find(a => a !== 0) ?? planeAxes[1]; }
      }
      const sizeArr = [geoSize.x, geoSize.y, geoSize.z];
      const newWidth = sizeArr[defaultAxis];
      const newHeight = sizeArr[altAxis];

      updates.push({
        id: panel.id,
        geometry,
        replicadShape: replicadPanel,
        parameters: {
          ...panel.parameters,
          faceRole: vf.role,
          width: newWidth,
          height: newHeight,
          originalReplicadShape: null,
          jointTrimmed: false,
        }
      });
    } catch (err) {
      console.error(`Failed to rebuild virtual face panel ${panel.id}:`, err);
    }
  }

  if (updates.length > 0) {
    useAppStore.setState((st) => ({
      shapes: st.shapes.map(s => {
        const update = updates.find(u => u.id === s.id);
        if (update) {
          const parent = st.shapes.find(p => p.id === parentShapeId);
          return {
            ...s,
            geometry: update.geometry,
            replicadShape: update.replicadShape,
            position: parent ? [...parent.position] as [number, number, number] : s.position,
            rotation: parent ? parent.rotation : s.rotation,
            scale: parent ? [...parent.scale] as [number, number, number] : s.scale,
            parameters: update.parameters,
          };
        }
        return s;
      })
    }));
  }
}

function saveOriginalShapes(panels: any[], parentShapeId: string) {
  const needsSave = panels.some((p) => !p.parameters?.originalReplicadShape);
  if (!needsSave) return;

  useAppStore.setState((state) => ({
    shapes: state.shapes.map((s) => {
      if (
        s.type === 'panel' &&
        s.parameters?.parentShapeId === parentShapeId &&
        !s.parameters?.originalReplicadShape &&
        s.replicadShape
      ) {
        return {
          ...s,
          parameters: {
            ...s.parameters,
            originalReplicadShape: s.replicadShape,
          },
        };
      }
      return s;
    }),
  }));
}
