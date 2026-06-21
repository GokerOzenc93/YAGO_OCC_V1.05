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

export async function rebuildPanelsForParent(parentShapeId: string): Promise<void> {
  if (rebuildInFlight.has(parentShapeId)) {
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

    // VF IDs belonging to moved panels. Their VFs must never be reset by
    // recalculation — we protect them throughout the rebuild loop.
    const movedVfIds = new Set<string>(
      siblingsOrdered
        .filter(p => (p.parameters?.moveSteps?.length || 0) > 0)
        .map(p => p.parameters.virtualFaceId as string)
    );

    let workingShapes: any[] = store.shapes.filter(
      s => !(s.type === 'panel' && s.parameters?.parentShapeId === parentShapeId)
    );
    let workingVirtualFaces = store.virtualFaces;

    const builtVfIds = new Set<string>();

    for (const panel of siblingsOrdered) {
      const currentVfId = panel.parameters.virtualFaceId;
      const hasMoved = movedVfIds.has(currentVfId);

      if (hasMoved) {
        // Moved panels are rebuilt from their STORED VF vertices (never
        // recalculated, so their displaced center is preserved). They receive
        // Boolean cuts from non-moved siblings that precede them in VF order,
        // matching the ordering the user configured. Their position (the
        // displacement applied by the user) is always kept unchanged.
        builtVfIds.add(currentVfId);

        // Use VF from the initial store state — never from workingVirtualFaces
        // which may have been updated by a prior iteration.
        const movedVf = store.virtualFaces.find(f => f.id === currentVfId);

        if (!movedVf || movedVf.vertices.length < 3 || !movedVf.parentFaceShape) {
          // Non-parentFaceShape moved panels have no inter-panel Boolean cuts;
          // carry them forward unchanged.
          workingShapes = [...workingShapes, panel];
          continue;
        }

        try {
          const thickness = panel.parameters?.depth || 18;
          let rp = await createPanelFromVirtualFace(movedVf.vertices, movedVf.normal, thickness);
          if (!rp) {
            workingShapes = [...workingShapes, panel];
            continue;
          }

          if (parent.replicadShape) {
            try {
              rp = await performBooleanIntersection(rp, parent.replicadShape);
            } catch (err) {
              console.error('Failed to intersect moved panel with parent:', err);
            }
          }

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
                rp = await performBooleanCut(rp, cuttingBox, undefined, sub.relativeOffset, undefined, sub.relativeRotation || [0, 0, 0], undefined, sub.scale || [1, 1, 1]);
              } catch (err) {
                console.error('Failed to apply sub cut to moved panel:', err);
              }
            }
          }

          // Cut by non-moved siblings already in workingShapes (they come
          // before this moved panel in VF order).
          const nonMovedSiblings = workingShapes.filter(
            s => s.type === 'panel' &&
              s.parameters?.parentShapeId === parentShapeId &&
              s.id !== panel.id &&
              s.replicadShape &&
              !(s.parameters?.moveSteps?.length > 0)
          );
          for (const sib of nonMovedSiblings) {
            try {
              rp = await performBooleanCut(rp, sib.replicadShape);
            } catch (err) {
              console.error('Failed to subtract non-moved sibling from moved panel:', err);
            }
          }

          const geometry = convertReplicadToThreeGeometry(rp);
          const r = geoAxesSize(geometry);
          const paramUpdates: Record<string, any> = { ...panel.parameters, baseReplicadShape: rp };
          if (r) {
            const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
            const [def, alt] = [pa[0], pa[1]];
            const s = [r.size.x, r.size.y, r.size.z];
            paramUpdates.width = s[def];
            paramUpdates.height = s[alt];
          }

          // position / rotation / scale are ALWAYS preserved for moved panels.
          const rebuiltMovedPanel = {
            ...panel,
            geometry,
            replicadShape: rp,
            parameters: paramUpdates,
          };

          workingShapes = [...workingShapes, rebuiltMovedPanel];
        } catch (err) {
          console.error('Failed to rebuild moved panel', panel.id, err);
          workingShapes = [...workingShapes, panel];
        }
        continue;
      }

      // ── Non-moved panel: standard VF recalculation + Boolean cuts ──────────

      const otherShapeVfs = workingVirtualFaces.filter(f => f.shapeId !== parentShapeId);
      const activeSiblingVfs = workingVirtualFaces.filter(f =>
        f.shapeId === parentShapeId &&
        // Never feed moved VFs into recalculation — they would be reset to the
        // parent face boundary and lose their displaced state.
        !movedVfIds.has(f.id) &&
        (f.id === currentVfId || builtVfIds.has(f.id) || !siblingsOrdered.some(s => s.parameters?.virtualFaceId === f.id))
      );
      const filteredForRecalc = [...otherShapeVfs, ...activeSiblingVfs];

      const freshFaces = recalculateVirtualFacesForShape(parent, filteredForRecalc, workingShapes);
      const freshById = new Map(freshFaces.map(f => [f.id, f]));
      // Only update VFs that are NOT from moved panels.
      workingVirtualFaces = workingVirtualFaces.map(f =>
        movedVfIds.has(f.id) ? f : (freshById.get(f.id) || f)
      );
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
                rp = await performBooleanCut(rp, cuttingBox, undefined, sub.relativeOffset, undefined, sub.relativeRotation || [0, 0, 0], undefined, sub.scale || [1, 1, 1]);
              } catch (err) {
                console.error('Failed to apply subtractor cut to panel:', err);
              }
            }
          }

          // Non-moved siblings only. Moved panels never cut non-moved panels
          // because their displaced shape (replicadShape at original face +
          // position offset) would incorrectly carve distant faces.
          const siblingPanelShapes = workingShapes.filter(
            s => s.type === 'panel' &&
              s.parameters?.parentShapeId === parentShapeId &&
              s.id !== panel.id &&
              s.replicadShape &&
              !(s.parameters?.moveSteps?.length > 0)
          );
          for (const sib of siblingPanelShapes) {
            try {
              rp = await performBooleanCut(rp, sib.replicadShape);
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
      setTimeout(() => rebuildPanelsForParent(parentShapeId), 0);
    }
  }
}
