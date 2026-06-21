import * as THREE from 'three';
import { useAppStore } from '../store';

const rebuildInFlight = new Set<string>();

function geoAxesSize(geo: THREE.BufferGeometry) {
  const pos = geo.getAttribute('position');
  if (!pos) return null;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const axes = [{ i: 0, v: size.x }, { i: 1, v: size.y }, { i: 2, v: size.z }].sort((a, b) => a.v - b.v);
  return { axes, size };
}

/**
 * Returns the world-space offset accumulated from a panel's moveSteps.
 * The panel's geometry lives in virtual-face-space; the position field and
 * moveSteps together describe how far the panel has been displaced from that
 * base position. We need this offset to translate the replicadShape (which
 * is stored in virtual-face-space) before using it as a boolean cutter.
 */
function getAccumulatedMoveOffset(panel: any): [number, number, number] {
  const steps: any[] = panel.parameters?.moveSteps || [];
  let dx = 0, dy = 0, dz = 0;
  for (const step of steps) {
    const v: number = step.value || 0;
    if (step.axis === 'X') dx += v;
    else if (step.axis === 'Y') dy += v;
    else if (step.axis === 'Z') dz += v;
  }
  return [dx, dy, dz];
}

/**
 * Returns the replicadShape of a panel, translated by its cumulative
 * moveSteps offset so it occupies the correct world position for boolean ops.
 */
function getOffsetReplicadShape(panel: any): any {
  const shape = panel.replicadShape;
  if (!shape) return null;
  const [dx, dy, dz] = getAccumulatedMoveOffset(panel);
  if (dx === 0 && dy === 0 && dz === 0) return shape;
  try {
    return shape.translate(dx, dy, dz);
  } catch {
    return shape;
  }
}


export async function rebuildPanelsForParent(parentShapeId: string): Promise<void> {
  if (rebuildInFlight.has(parentShapeId)) return;
  rebuildInFlight.add(parentShapeId);
  try {
    const store = useAppStore.getState();
    const parent = store.shapes.find(s => s.id === parentShapeId);
    if (!parent) return;

    const { recalculateVirtualFacesForShape } = await import('./VirtualFaceUpdateService');
    const { createPanelFromVirtualFace, convertReplicadToThreeGeometry, performBooleanCut, createReplicadBox, performBooleanIntersection } = await import('./ReplicadService');
    const { rebuildFromSteps } = await import('./FaceExtrudeService');

    const vfOrder = new Map<string, number>();
    store.virtualFaces.forEach((vf, idx) => vfOrder.set(vf.id, idx));

    const siblingsOrdered = store.shapes
      .filter(s => s.type === 'panel' &&
        s.parameters?.parentShapeId === parentShapeId &&
        s.parameters?.virtualFaceId)
      .sort((a, b) => {
        const ai = vfOrder.get(a.parameters.virtualFaceId) ?? Infinity;
        const bi = vfOrder.get(b.parameters.virtualFaceId) ?? Infinity;
        return ai - bi;
      });

    let workingShapes: any[] = store.shapes.filter(
      s => !(s.type === 'panel' && s.parameters?.parentShapeId === parentShapeId)
    );
    let workingVirtualFaces = store.virtualFaces;

    const builtVfIds = new Set<string>();

    for (const panel of siblingsOrdered) {
      const currentVfId = panel.parameters.virtualFaceId;
      const otherShapeVfs = workingVirtualFaces.filter(f => f.shapeId !== parentShapeId);
      const activeSiblingVfs = workingVirtualFaces.filter(f =>
        f.shapeId === parentShapeId &&
        (f.id === currentVfId || builtVfIds.has(f.id) || !siblingsOrdered.some(s => s.parameters?.virtualFaceId === f.id))
      );
      const filteredForRecalc = [...otherShapeVfs, ...activeSiblingVfs];

      const freshFaces = recalculateVirtualFacesForShape(parent, filteredForRecalc, workingShapes);
      const freshById = new Map(freshFaces.map(f => [f.id, f]));
      workingVirtualFaces = workingVirtualFaces.map(f => freshById.get(f.id) || f);
      builtVfIds.add(currentVfId);

      const vf = freshFaces.find(f => f.id === currentVfId);
      if (!vf || vf.vertices.length < 3) {
        workingShapes = [...workingShapes, panel];
        continue;
      }

      try {
        const thickness = panel.parameters?.depth || 18;
        let rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, thickness);
        if (!rp) {
          workingShapes = [...workingShapes, panel];
          continue;
        }

        const parentHasFillets = !!(parent.fillets && parent.fillets.length > 0 && parent.replicadShape);

        if (vf.parentFaceShape && parent.replicadShape) {
          try {
            rp = await performBooleanIntersection(rp, parent.replicadShape);
          } catch (err) {
            console.error('Failed to intersect panel with parent:', err);
          }
        }

        if (vf.parentFaceShape) {
          if (!parent.replicadShape) {
            const subs = parent.subtractionGeometries || [];
            for (const sub of subs) {
              if (!sub || !sub.parameters) continue;
              const w = parseFloat(sub.parameters.width);
              const h = parseFloat(sub.parameters.height);
              const d = parseFloat(sub.parameters.depth);
              if (isNaN(w) || isNaN(h) || isNaN(d) || w <= 0 || h <= 0 || d <= 0) continue;
              try {
                const margin = 0.5;
                const cuttingBox = await createReplicadBox({ width: w + margin, height: h + margin, depth: d + margin });
                rp = await performBooleanCut(
                  rp, cuttingBox,
                  undefined, sub.relativeOffset,
                  undefined, sub.relativeRotation || [0, 0, 0],
                  undefined, sub.scale || [1, 1, 1]
                );
              } catch (err) {
                console.error('Failed to apply subtractor cut to parent-face-shape panel:', err);
              }
            }
          }

          const siblingPanelShapes = workingShapes.filter(
            s => s.type === 'panel' &&
              s.parameters?.parentShapeId === parentShapeId &&
              s.id !== panel.id &&
              s.replicadShape
          );
          for (const sib of siblingPanelShapes) {
            try {
              const sibShape = getOffsetReplicadShape(sib);
              if (sibShape) rp = await performBooleanCut(rp, sibShape);
            } catch (err) {
              console.error('Failed to subtract sibling panel from parent-face-shape panel:', err);
            }
          }
        }

        let geometry = convertReplicadToThreeGeometry(rp);
        const r = geoAxesSize(geometry);
        const paramUpdates: Record<string, any> = { ...panel.parameters, baseReplicadShape: rp };
        if (r) {
          const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
          const [def, alt] = [pa[0], pa[1]];
          const s = [r.size.x, r.size.y, r.size.z];
          paramUpdates.width = s[def];
          paramUpdates.height = s[alt];
        }
        let rebuiltPanel: any = { ...panel, geometry, replicadShape: rp, parameters: paramUpdates };

        // Apply extrude steps immediately so subsequent panels see the correct
        // (shortened) geometry as an obstacle during their VF recalculation.
        const steps = panel.parameters?.extrudeSteps || [];
        if (steps.length > 0) {
          const captured: Partial<typeof rebuiltPanel> = {};
          const captureUpdate = (id: string, updates: any) => {
            if (id === panel.id) Object.assign(captured, updates);
          };
          try {
            await rebuildFromSteps(rebuiltPanel, steps, captureUpdate as any);
            if (captured.geometry || captured.replicadShape || captured.parameters) {
              rebuiltPanel = {
                ...rebuiltPanel,
                ...captured,
                parameters: { ...rebuiltPanel.parameters, ...(captured.parameters || {}) },
              };
            }
          } catch (err) {
            console.error('Failed to apply extrude steps during rebuild for panel', panel.id, err);
          }
        }

        workingShapes = [...workingShapes, rebuiltPanel];
      } catch (err) {
        console.error('Failed to rebuild panel', panel.id, err);
        workingShapes = [...workingShapes, panel];
      }
    }

    useAppStore.setState(state => {
      const rebuiltById = new Map<string, any>();
      for (const s of workingShapes) {
        if (s.type === 'panel' && s.parameters?.parentShapeId === parentShapeId) rebuiltById.set(s.id, s);
      }
      return {
        shapes: state.shapes.map(s => rebuiltById.get(s.id) || s),
        virtualFaces: workingVirtualFaces,
      };
    });
  } finally {
    rebuildInFlight.delete(parentShapeId);
  }
}
