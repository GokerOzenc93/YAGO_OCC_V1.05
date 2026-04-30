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

function getVirtualFaceOrder(panelShape: any, virtualFaces: any[]): number {
  const vfId = panelShape.parameters?.virtualFaceId;
  if (!vfId) return -1;
  const shapeId = panelShape.parameters?.parentShapeId;
  const shapeFaces = virtualFaces.filter((vf: any) => vf.shapeId === shapeId);
  return shapeFaces.findIndex((vf: any) => vf.id === vfId);
}

function panelsOverlap(shapeA: any, shapeB: any): boolean {
  try {
    if (!shapeA || !shapeB) return true;
    const bbA = getReplicadBoundingBox(shapeA);
    const bbB = getReplicadBoundingBox(shapeB);
    const tol = 0.5;
    return (
      bbA.min[0] < bbB.max[0] + tol && bbA.max[0] > bbB.min[0] - tol &&
      bbA.min[1] < bbB.max[1] + tol && bbA.max[1] > bbB.min[1] - tol &&
      bbA.min[2] < bbB.max[2] + tol && bbA.max[2] > bbB.min[2] - tol
    );
  } catch {
    return true;
  }
}

function getPanelPlaneInfo(panel: any, virtualFaces: any[]): { normal: THREE.Vector3; planeD: number } | null {
  const shape = panel.parameters?.baseReplicadShape
    || panel.parameters?.originalReplicadShape
    || panel.replicadShape;
  if (shape) {
    try {
      const bb = shape.boundingBox;
      const [[xMin, yMin, zMin], [xMax, yMax, zMax]] = bb.bounds;
      const sizes = [xMax - xMin, yMax - yMin, zMax - zMin];
      const minIdx = sizes.indexOf(Math.min(...sizes));
      const n = new THREE.Vector3(0, 0, 0);
      n.setComponent(minIdx, 1);
      const center = new THREE.Vector3((xMin + xMax) / 2, (yMin + yMax) / 2, (zMin + zMax) / 2);
      return { normal: n, planeD: n.dot(center) };
    } catch { /* fall through */ }
  }

  const vfId = panel.parameters?.virtualFaceId;
  if (vfId) {
    const vf = virtualFaces.find((f: any) => f.id === vfId);
    if (vf) {
      const n = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
      const c = new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]);
      return { normal: n, planeD: n.dot(c) };
    }
  }

  return null;
}

function arePanelsCoplanar(panelA: any, panelB: any, virtualFaces: any[]): boolean {
  const roleA = panelA.parameters?.faceRole as FaceRole;
  const roleB = panelB.parameters?.faceRole as FaceRole;
  if (roleA && roleB && roleA === roleB) return true;

  const infoA = getPanelPlaneInfo(panelA, virtualFaces);
  const infoB = getPanelPlaneInfo(panelB, virtualFaces);
  if (!infoA || !infoB) return false;

  const normalDot = infoA.normal.dot(infoB.normal);
  if (Math.abs(normalDot) < 0.9) return false;

  const adjustedPlaneD_B = normalDot < 0 ? -infoB.planeD : infoB.planeD;
  const planeDist = Math.abs(infoA.planeD - adjustedPlaneD_B);
  return planeDist < 2;
}

function getThicknessFaceTouch(panelA: any, panelB: any): 'A' | 'B' | null {
  try {
    const bbA = getReplicadBoundingBox(panelA.parameters?.originalReplicadShape || panelA.replicadShape);
    const bbB = getReplicadBoundingBox(panelB.parameters?.originalReplicadShape || panelB.replicadShape);
    const sizeA = [bbA.max[0]-bbA.min[0], bbA.max[1]-bbA.min[1], bbA.max[2]-bbA.min[2]];
    const sizeB = [bbB.max[0]-bbB.min[0], bbB.max[1]-bbB.min[1], bbB.max[2]-bbB.min[2]];
    const tA = sizeA.indexOf(Math.min(...sizeA));
    const tB = sizeB.indexOf(Math.min(...sizeB));
    if (tA === tB) return null;
    const tol = 0.5;
    const overlapsOn = (ax: number) =>
      bbA.min[ax] < bbB.max[ax] - tol && bbA.max[ax] > bbB.min[ax] + tol;
    const touchesOn = (ax: number) =>
      Math.abs(bbA.max[ax] - bbB.min[ax]) < tol || Math.abs(bbB.max[ax] - bbA.min[ax]) < tol;
    const aTouchesB = touchesOn(tA) && [0,1,2].filter(a => a !== tA).every(a => overlapsOn(a));
    const bTouchesA = touchesOn(tB) && [0,1,2].filter(a => a !== tB).every(a => overlapsOn(a));
    if (aTouchesB && !bTouchesA) return 'B';
    if (bTouchesA && !aTouchesB) return 'A';
    return null;
  } catch {
    return null;
  }
}

function determineDominantPanel(
  panelA: any,
  panelB: any,
  config: PanelJointConfig,
  virtualFaces: any[]
): 'A' | 'B' | null {
  const roleA = panelA.parameters?.faceRole as FaceRole;
  const roleB = panelB.parameters?.faceRole as FaceRole;
  const isAVirtual = !!panelA.parameters?.virtualFaceId;
  const isBVirtual = !!panelB.parameters?.virtualFaceId;
  const isARoleless = !!panelA.parameters?.roleless;
  const isBRoleless = !!panelB.parameters?.roleless;

  if (isARoleless || isBRoleless) return null;

  if (arePanelsCoplanar(panelA, panelB, virtualFaces)) {
    return null;
  }

  if (roleA && roleB && roleA !== 'Door' && roleB !== 'Door' && roleA !== roleB) {
    const roleDominant = getDominantRole(roleA, roleB, config);
    if (roleDominant) {
      return roleDominant === roleA ? 'A' : 'B';
    }
  }

  if (!isAVirtual && isBVirtual) return 'A';
  if (isAVirtual && !isBVirtual) return 'B';

  const thicknessWinner = getThicknessFaceTouch(panelA, panelB);
  if (thicknessWinner) return thicknessWinner;

  if (isAVirtual && isBVirtual) {
    const orderA = getVirtualFaceOrder(panelA, virtualFaces);
    const orderB = getVirtualFaceOrder(panelB, virtualFaces);
    if (orderA !== -1 && orderB !== -1 && orderA !== orderB) {
      return orderA < orderB ? 'A' : 'B';
    }
  }

  return null;
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
  backPanelThickness: number;
  grooveOffset: number;
  grooveDepth: number;
}

async function loadFullProfileSettings(profileId: string): Promise<FullProfileSettings> {
  let jointConfig = DEFAULT_CONFIG;
  let selectedBodyType: string | null = null;
  let bazaHeight = 100;
  let frontBaseDistance = 10;
  let backPanelThickness = 8;
  let grooveOffset = 12;
  let grooveDepth = 8;

  try {
    const settings = await globalSettingsService.getProfileSettings(profileId, 'panel_joint');
    if (settings?.settings) {
      const s = settings.settings as Record<string, unknown>;
      jointConfig = {
        topLeftExpanded: Boolean(s.topLeftExpanded),
        topRightExpanded: Boolean(s.topRightExpanded),
        bottomLeftExpanded: Boolean(s.bottomLeftExpanded),
        bottomRightExpanded: Boolean(s.bottomRightExpanded),
      };
      selectedBodyType = (s.selectedBodyType as string) || null;
      bazaHeight = typeof s.bazaHeight === 'number' ? s.bazaHeight : 100;
      frontBaseDistance = typeof s.frontBaseDistance === 'number' ? s.frontBaseDistance : 10;
    }
  } catch (err) {
    console.error('Failed to load panel_joint settings:', err);
  }

  try {
    const backSettings = await globalSettingsService.getProfileSettings(profileId, 'back_panel');
    if (backSettings?.settings) {
      const bs = backSettings.settings as Record<string, unknown>;
      if (typeof bs.backPanelThickness === 'number') backPanelThickness = bs.backPanelThickness;
      if (typeof bs.grooveOffset === 'number') grooveOffset = bs.grooveOffset;
      if (typeof bs.grooveDepth === 'number') grooveDepth = bs.grooveDepth;
    }
  } catch (err) {
    console.error('Failed to load back_panel settings:', err);
  }

  return { jointConfig, selectedBodyType, bazaHeight, frontBaseDistance, backPanelThickness, grooveOffset, grooveDepth };
}

// ── Back panel thickness, groove offset & groove depth uygulama ──────────────
async function applyBackPanelSettings(
  parentShapeId: string,
  panels: any[],
  backPanelThickness: number,
  grooveOffset: number,
  grooveDepth: number
): Promise<void> {
  const backPanels = panels.filter(p => p.parameters?.faceRole === 'Back');
  if (backPanels.length === 0) return;

  const state = useAppStore.getState();
  const parentShape = state.shapes.find(s => s.id === parentShapeId);
  if (!parentShape || !parentShape.replicadShape || !parentShape.geometry) return;

  const {
    backPanelLeftExtend,
    backPanelRightExtend,
    backPanelTopExtend,
    backPanelBottomExtend,
  } = state;

  const { createPanelFromFace, convertReplicadToThreeGeometry, createReplicadBox } = await import('./ReplicadService');
  const { extractFacesFromGeometry, groupCoplanarFaces } = await import('./FaceEditor');

  const faces = extractFacesFromGeometry(parentShape.geometry);
  const faceGroups = groupCoplanarFaces(faces);

  const updates: Array<{ id: string; geometry: any; replicadShape: any; parameters: any }> = [];

  const hasDominantPanels = panels.some(p => {
    const role = p.parameters?.faceRole as FaceRole;
    return role === 'Left' || role === 'Right' || role === 'Top' || role === 'Bottom';
  });

  const effectiveGrooveOffset = hasDominantPanels ? grooveOffset : 0;
  const effectiveGrooveDepth = grooveDepth;

  for (const panel of backPanels) {
    const faceIndex = panel.parameters?.faceIndex;
    if (faceIndex === undefined || faceIndex === null || faceIndex < 0) continue;
    if (faceIndex >= faceGroups.length) continue;

    try {
      const faceGroup = faceGroups[faceIndex];
      if (!faceGroup) continue;

      const localVertices: THREE.Vector3[] = [];
      faceGroup.faceIndices.forEach((idx: number) => {
        faces[idx].vertices.forEach((v: THREE.Vector3) => localVertices.push(v.clone()));
      });

      const localNormal = faceGroup.normal.clone().normalize();
      const localBox = new THREE.Box3().setFromPoints(localVertices);
      const localCenter = new THREE.Vector3();
      localBox.getCenter(localCenter);

      const replicadPanel = await createPanelFromFace(
        parentShape.replicadShape,
        [localNormal.x, localNormal.y, localNormal.z],
        [localCenter.x, localCenter.y, localCenter.z],
        backPanelThickness,
        null
      );
      if (!replicadPanel) continue;

      const offsetX = localNormal.x * (-effectiveGrooveOffset);
      const offsetY = localNormal.y * (-effectiveGrooveOffset);
      const offsetZ = localNormal.z * (-effectiveGrooveOffset);
      let finalPanel = replicadPanel.translate(offsetX, offsetY, offsetZ);

      const needsGrooveExpand = hasDominantPanels && (effectiveGrooveDepth > 0 || backPanelLeftExtend > 0 || backPanelRightExtend > 0 || backPanelTopExtend > 0 || backPanelBottomExtend > 0);

      if (needsGrooveExpand) {
        const baseBB = getReplicadBoundingBox(finalPanel);
        const baseSize = [
          baseBB.max[0] - baseBB.min[0],
          baseBB.max[1] - baseBB.min[1],
          baseBB.max[2] - baseBB.min[2],
        ];

        const sortedAxes = [0, 1, 2]
          .map(a => ({ axis: a, size: baseSize[a] }))
          .sort((a, b) => a.size - b.size);

        const thicknessAxis = sortedAxes[0].axis;
        const verticalAxis = 1;
        const horizontalAxis = [0, 1, 2].find(a => a !== thicknessAxis && a !== verticalAxis) ?? 0;

        const leftPanel = panels.find(p => p.parameters?.faceRole === 'Left');
        const rightPanel = panels.find(p => p.parameters?.faceRole === 'Right');
        const topPanel = panels.find(p => p.parameters?.faceRole === 'Top');
        const bottomPanel = panels.find(p => p.parameters?.faceRole === 'Bottom');

        const leftThickness = leftPanel ? (leftPanel.parameters?.depth ?? 18) : 0;
        const rightThickness = rightPanel ? (rightPanel.parameters?.depth ?? 18) : 0;
        const topThickness = topPanel ? (topPanel.parameters?.depth ?? 18) : 0;
        const bottomThickness = bottomPanel ? (bottomPanel.parameters?.depth ?? 18) : 0;

        const leftGroove = leftPanel ? effectiveGrooveDepth : 0;
        const rightGroove = rightPanel ? effectiveGrooveDepth : 0;
        const topGroove = topPanel ? effectiveGrooveDepth : 0;
        const bottomGroove = bottomPanel ? effectiveGrooveDepth : 0;

        const newMin: [number, number, number] = [baseBB.min[0], baseBB.min[1], baseBB.min[2]];
        const newMax: [number, number, number] = [baseBB.max[0], baseBB.max[1], baseBB.max[2]];

        newMin[horizontalAxis] += leftThickness - leftGroove - backPanelLeftExtend;
        newMax[horizontalAxis] -= rightThickness - rightGroove - backPanelRightExtend;
        newMax[verticalAxis] -= topThickness - topGroove - backPanelTopExtend;
        newMin[verticalAxis] += bottomThickness - bottomGroove - backPanelBottomExtend;

        const dims: [number, number, number] = [
          newMax[0] - newMin[0],
          newMax[1] - newMin[1],
          newMax[2] - newMin[2],
        ];

        console.log(`Back panel groove expand: thicknessAxis=${thicknessAxis}, horizontalAxis=${horizontalAxis}, baseSize=${JSON.stringify(baseSize)}, dims=${JSON.stringify(dims)}, effectiveGrooveDepth=${effectiveGrooveDepth}`);

        if (dims[0] > 0.1 && dims[1] > 0.1 && dims[2] > 0.1) {
          try {
            const expandedBox = await createReplicadBox({ width: dims[0], height: dims[1], depth: dims[2] });
            finalPanel = expandedBox.translate(newMin[0], newMin[1], newMin[2]);
          } catch (expandErr) {
            console.error('Failed to expand back panel with grooveDepth:', expandErr);
          }
        }
      }

      const geometry = convertReplicadToThreeGeometry(finalPanel);

      updates.push({
        id: panel.id,
        geometry,
        replicadShape: finalPanel,
        parameters: {
          ...panel.parameters,
          depth: backPanelThickness,
          grooveOffset,
          grooveDepth,
          originalReplicadShape: panel.parameters?.originalReplicadShape || panel.replicadShape,
        }
      });

      panel.replicadShape = finalPanel;
      panel.geometry = geometry;
      panel.parameters = { ...panel.parameters, depth: backPanelThickness, grooveOffset, grooveDepth };

    } catch (err) {
      console.error(`Failed to apply back panel settings for panel ${panel.id}:`, err);
    }
  }

  if (updates.length > 0) {
    useAppStore.setState((st) => ({
      shapes: st.shapes.map(s => {
        const update = updates.find(u => u.id === s.id);
        if (!update) return s;
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
      })
    }));
    console.log(`✅ Back panel settings applied: thickness=${backPanelThickness}mm, grooveOffset=${grooveOffset}mm, grooveDepth=${grooveDepth}mm`);
  }
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
      s.parameters?.faceRole !== 'Door' &&
      (s.parameters?.originalReplicadShape || s.replicadShape)
  );

  const rolePanels = panels.filter(p => p.parameters?.faceRole);

  await applyBackPanelSettings(
    parentShapeId,
    rolePanels,
    fullSettings.backPanelThickness,
    fullSettings.grooveOffset,
    fullSettings.grooveDepth
  );

  if (panels.length < 2) {
    await restoreSinglePanels(panels);
    applyBazaOffset(parentShapeId, fullSettings.selectedBodyType, fullSettings.bazaHeight);
    await generateFrontBazaPanels(parentShapeId, fullSettings.selectedBodyType, fullSettings.bazaHeight, fullSettings.frontBaseDistance);
    return;
  }

  console.log(`Resolving panel joints for ${panels.length} panels...`);
  panels.forEach((p, i) => {
    const isVf = !!p.parameters?.virtualFaceId;
    console.log(`  Panel[${i}]: role=${p.parameters?.faceRole || 'none'} virtual=${isVf} vfId=${p.parameters?.virtualFaceId || '-'} id=${p.id}`);
  });

  const virtualFaces = state.virtualFaces;

  const originalShapes = new Map<string, any>();
  for (const panel of panels) {
    originalShapes.set(
      panel.id,
      panel.parameters?.originalReplicadShape
        || panel.parameters?.baseReplicadShape
        || panel.replicadShape
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

      const origA = originalShapes.get(pA.id);
      const origB = originalShapes.get(pB.id);

      const winner = determineDominantPanel(pA, pB, jointConfig, virtualFaces);
      if (!winner) {
        console.log(`  Skip: ${roleA || 'none'}-${roleB || 'none'} no dominant (vfA=${!!pA.parameters?.virtualFaceId} vfB=${!!pB.parameters?.virtualFaceId})`);
        continue;
      }

      const overlap = panelsOverlap(origA, origB);
      if (origA && origB && !overlap) {
        console.log(`  Skip: ${roleA || 'none'}-${roleB || 'none'} no overlap`);
        continue;
      }

      const isADominant = winner === 'A';
      const subordinateId = isADominant ? pB.id : pA.id;
      const dominantId = isADominant ? pA.id : pB.id;
      const subordinateRole = isADominant ? roleB : roleA;

      const isBackSubordinate = subordinateRole === 'Back';
      const grooveDepthActive = fullSettings.grooveDepth > 0
        || state.backPanelLeftExtend > 0
        || state.backPanelRightExtend > 0
        || state.backPanelTopExtend > 0
        || state.backPanelBottomExtend > 0;

      if (!isBackSubordinate || !grooveDepthActive) {
        const existing = cutsMap.get(subordinateId) || [];
        existing.push(dominantId);
        cutsMap.set(subordinateId, existing);
      }

      if (!isBackSubordinate && roleA && roleB && roleA !== roleB) {
        const extEntries = extensionsMap.get(dominantId) || [];
        extEntries.push({ subordinateId, subordinateRole });
        extensionsMap.set(dominantId, extEntries);
      }

      const domRole = isADominant ? roleA : roleB;
      const subRole = isADominant ? roleB : roleA;
      console.log(
        `  Joint: ${roleA || 'none'}-${roleB || 'none'} -> ${domRole || 'none'} dominant, ${subRole || 'none'} trimmed`
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
          const cuttingShape = extendedShapes.get(dominantId) || originalShapes.get(dominantId);
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
          await resolveAllPanelJoints(parentShapeId, profileId, config, true);
          updateBaseShapesAfterJoints(parentShapeId, 'raycast');
          await reapplyExtrudeStepsForSubset(parentShapeId, 'raycast');
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


function clearStaleOriginalShapes(parentShapeId: string) {
  useAppStore.setState((st) => ({
    shapes: st.shapes.map(s => {
      if (
        s.type === 'panel' &&
        s.parameters?.parentShapeId === parentShapeId &&
        s.parameters?.originalReplicadShape
      ) {
        return {
          ...s,
          parameters: {
            ...s.parameters,
            originalReplicadShape: null,
            jointTrimmed: false,
          }
        };
      }
      return s;
    })
  }));
}

async function recalculateAndRebuildVirtualFaces(parentShapeId: string, profileId?: string | null): Promise<void> {
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
    if (profileId && profileId !== 'none') {
      await resolveAllPanelJoints(parentShapeId, profileId, undefined, true);
    }
  }
}

async function reapplyExtrudeStepsForSubset(
  parentShapeId: string,
  filter: 'role' | 'raycast'
): Promise<void> {
  const state = useAppStore.getState();
  const allPanels = state.shapes.filter(
    s => s.type === 'panel' && s.parameters?.parentShapeId === parentShapeId
  );

  const extrudePanels = allPanels.filter(s => {
    if (!(s.parameters?.extrudeSteps?.length > 0 && s.parameters?.baseReplicadShape)) return false;
    const isVirtual = !!s.parameters?.virtualFaceId;
    return filter === 'raycast' ? isVirtual : !isVirtual;
  });

  if (extrudePanels.length === 0) return;

  console.log(`[reapplyExtrudeSteps:${filter}] Reapplying extrude steps for ${extrudePanels.length} panel(s)`);

  const { rebuildFromSteps } = await import('./FaceExtrudeService');
  const { updateShape } = useAppStore.getState();

  for (const panel of extrudePanels) {
    try {
      const result = await rebuildFromSteps(panel, panel.parameters.extrudeSteps, updateShape);
      console.log(`[reapplyExtrudeSteps:${filter}] Panel ${panel.id}: rebuildFromSteps returned ${result}`);
    } catch (err) {
      console.error(`Failed to reapply extrude steps for panel ${panel.id}:`, err);
    }
  }
}

function updateBaseShapesAfterJoints(parentShapeId: string, filter?: 'role' | 'raycast') {
  useAppStore.setState((st) => ({
    shapes: st.shapes.map(s => {
      if (
        s.type === 'panel' &&
        s.parameters?.parentShapeId === parentShapeId &&
        s.parameters?.extrudeSteps?.length > 0 &&
        s.replicadShape
      ) {
        if (filter) {
          const isVirtual = !!s.parameters?.virtualFaceId;
          if (filter === 'raycast' && !isVirtual) return s;
          if (filter === 'role' && isVirtual) return s;
        }
        return {
          ...s,
          parameters: {
            ...s.parameters,
            baseReplicadShape: s.replicadShape,
          },
        };
      }
      return s;
    }),
  }));
}

export async function rebuildAndRecalculatePipeline(
  parentShapeId: string,
  profileId: string | null
): Promise<void> {
  clearStaleOriginalShapes(parentShapeId);

  await recalculateAndRebuildVirtualFaces(parentShapeId, profileId);

  if (profileId && profileId !== 'none') {
    await resolveAllPanelJoints(parentShapeId, profileId, undefined, true);
  }

  updateBaseShapesAfterJoints(parentShapeId, 'raycast');
  await reapplyExtrudeStepsForSubset(parentShapeId, 'raycast');
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

      const hasExtrude = panel.parameters?.extrudeSteps?.length > 0;

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
          baseReplicadShape: hasExtrude ? replicadPanel : panel.parameters?.baseReplicadShape,
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
