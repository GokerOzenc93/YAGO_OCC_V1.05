import * as THREE from 'three';
import { useAppStore } from '../store';

const rebuildInFlight = new Set<string>();
const rebuildPending = new Set<string>();

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
 * Returns the position-based world offset for a panel's replicad shape.
 * The replicadShape is built in parent-local space at the VF origin.
 * The panel's `position` field stores the cumulative displacement from that origin.
 */
function getWorldSpaceReplicadShape(panel: any): any {
  const shape = panel.replicadShape;
  if (!shape) return null;
  const pos: [number, number, number] = panel.position || [0, 0, 0];
  const dx = pos[0], dy = pos[1], dz = pos[2];
  if (dx === 0 && dy === 0 && dz === 0) return shape;
  try {
    return shape.translate(dx, dy, dz);
  } catch {
    return shape;
  }
}

/**
 * Checks whether a sibling panel's world-space geometry (geometry + position)
 * has any vertex close enough to the given face plane to be a relevant cutter.
 * Panels that have been moved off the face plane should not cut it.
 */
function panelIntersectsFacePlane(
  sib: any,
  faceNormal: THREE.Vector3,
  facePlaneOrigin: THREE.Vector3,
  tolerance: number
): boolean {
  if (!sib.geometry) return false;
  const pos = sib.position as [number, number, number] | undefined;
  const rot = sib.rotation as [number, number, number] | undefined;
  const scl = sib.scale as [number, number, number] | undefined;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...(pos || [0, 0, 0])),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...(rot || [0, 0, 0]), 'XYZ')
    ),
    new THREE.Vector3(...(scl || [1, 1, 1]))
  );
  const posAttr = sib.geometry.getAttribute('position');
  if (!posAttr) return false;
  for (let i = 0; i < posAttr.count; i++) {
    const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(m);
    const d = faceNormal.dot(new THREE.Vector3().subVectors(wp, facePlaneOrigin));
    if (Math.abs(d) < tolerance) return true;
  }
  return false;
}

/**
 * Checks whether two panels' world-space bounding boxes overlap.
 * Used as a fast pre-filter before boolean cut.
 */
function panelBboxesOverlap(a: any, b: any, margin = 1): boolean {
  if (!a.geometry || !b.geometry) return false;

  const bboxForPanel = (p: any) => {
    const pos = p.position as [number, number, number] | undefined;
    const bbox = new THREE.Box3().setFromBufferAttribute(
      p.geometry.getAttribute('position') as THREE.BufferAttribute
    );
    if (pos) bbox.translate(new THREE.Vector3(...pos));
    return bbox.expandByScalar(margin);
  };

  return bboxForPanel(a).intersectsBox(bboxForPanel(b));
}


export async function rebuildPanelsForParent(parentShapeId: string): Promise<void> {
  if (rebuildInFlight.has(parentShapeId)) {
    // Queue one pending rebuild so the latest state is always applied after the current one finishes.
    rebuildPending.add(parentShapeId);
    return;
  }
  rebuildInFlight.add(parentShapeId);
  try {
    const store = useAppStore.getState();
    const parent = store.shapes.find(s => s.id === parentShapeId);
    if (!parent) return;

    const { recalculateVirtualFacesForShape } = await import('./VirtualFaceUpdateService');
    const { createPanelFromVirtualFace, convertReplicadToThreeGeometry, performBooleanCut, createReplicadBox, performBooleanIntersection } = await import('./ReplicadService');
    const { rebuildFromSteps } = await import('./FaceExtrudeService');

    // Build VF order map using the CURRENT store order (respects reordering).
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
      const hasMoved = (panel.parameters?.moveSteps?.length || 0) > 0;

      // If this panel has been displaced via moveSteps, skip VF-based geometry
      // regeneration and carry it forward with its existing geometry & position.
      // Its world-space position already encodes all movement; we only need to
      // ensure downstream panels account for it as an obstacle.
      if (hasMoved) {
        builtVfIds.add(currentVfId);
        workingShapes = [...workingShapes, panel];
        continue;
      }

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

          // Compute the face plane for this panel so we can filter siblings
          // that are geometrically on this plane before cutting.
          const faceNormalLocal = new THREE.Vector3(...vf.normal).normalize();
          const faceCenterLocal = new THREE.Vector3(...vf.center);

          const siblingPanelShapes = workingShapes.filter(
            s => s.type === 'panel' &&
              s.parameters?.parentShapeId === parentShapeId &&
              s.id !== panel.id &&
              s.replicadShape
          );

          for (const sib of siblingPanelShapes) {
            // Only cut with siblings that are geometrically on this face plane.
            // Panels that have been moved off the face (via moveSteps) should
            // not carve into this panel just because of their origin geometry.
            const sibMoved = (sib.parameters?.moveSteps?.length || 0) > 0;

            if (sibMoved) {
              // For moved panels: check if the panel's ACTUAL world-space geometry
              // (geometry transformed by position) intersects this face plane.
              if (!panelIntersectsFacePlane(sib, faceNormalLocal, faceCenterLocal, 20)) continue;
              // Also require bounding box overlap.
              if (!panelBboxesOverlap(panel, sib, 5)) continue;
              // Use world-space representation: translate base shape by panel position.
              const sibShape = getWorldSpaceReplicadShape(sib);
              if (sibShape) {
                try {
                  rp = await performBooleanCut(rp, sibShape);
                } catch (err) {
                  console.error('Failed to subtract moved sibling panel:', err);
                }
              }
            } else {
              // Non-moved sibling: the replicadShape is already in the correct
              // local space (position = [0,0,0]), so use it directly.
              const sibShape = sib.replicadShape;
              if (sibShape) {
                try {
                  rp = await performBooleanCut(rp, sibShape);
                } catch (err) {
                  console.error('Failed to subtract sibling panel from parent-face-shape panel:', err);
                }
              }
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
    if (rebuildPending.has(parentShapeId)) {
      rebuildPending.delete(parentShapeId);
      // Re-run with the latest state after the current rebuild finishes.
      setTimeout(() => rebuildPanelsForParent(parentShapeId), 0);
    }
  }
}
