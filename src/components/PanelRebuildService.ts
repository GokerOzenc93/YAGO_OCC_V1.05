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

function roleBasedAxes(planeAxes: number[], role?: string | null) {
  let [def, alt] = [planeAxes[0], planeAxes[1]];
  const r = role?.toLowerCase();
  if ((r === 'left' || r === 'right') && planeAxes.includes(1)) { def = 1; alt = planeAxes.find(a => a !== 1) ?? planeAxes[1]; }
  else if ((r === 'top' || r === 'bottom') && planeAxes.includes(0)) { def = 0; alt = planeAxes.find(a => a !== 0) ?? planeAxes[1]; }
  return { def, alt };
}

export async function rebuildPanelsForParent(parentShapeId: string): Promise<void> {
  if (rebuildInFlight.has(parentShapeId)) return;
  rebuildInFlight.add(parentShapeId);
  try {
    const store = useAppStore.getState();
    const parent = store.shapes.find(s => s.id === parentShapeId);
    if (!parent) return;

    const { recalculateVirtualFacesForShape } = await import('./VirtualFaceUpdateService');
    const { createPanelFromVirtualFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');
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
        const rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, thickness);
        if (!rp) {
          workingShapes = [...workingShapes, panel];
          continue;
        }
        const geometry = convertReplicadToThreeGeometry(rp);
        const r = geoAxesSize(geometry);
        const paramUpdates: Record<string, any> = { ...panel.parameters, baseReplicadShape: rp };
        if (r) {
          const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
          const { def, alt } = roleBasedAxes(pa, panel.parameters?.faceRole);
          const s = [r.size.x, r.size.y, r.size.z];
          paramUpdates.width = s[def];
          paramUpdates.height = s[alt];
        }
        const rebuiltPanel = { ...panel, geometry, replicadShape: rp, parameters: paramUpdates };
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

    for (const panel of siblingsOrdered) {
      const idx = workingShapes.findIndex(s => s.id === panel.id);
      if (idx < 0) continue;
      const current = workingShapes[idx];
      const steps = current.parameters?.extrudeSteps || [];
      if (steps.length === 0) continue;

      const captured: Partial<typeof current> = {};
      const captureUpdate = (id: string, updates: any) => {
        if (id === panel.id) Object.assign(captured, updates);
      };
      try {
        await rebuildFromSteps(current, steps, captureUpdate as any);
        if (captured.geometry || captured.replicadShape || captured.parameters) {
          const merged = {
            ...current,
            ...captured,
            parameters: { ...current.parameters, ...(captured.parameters || {}) },
          };
          workingShapes[idx] = merged;
        }
      } catch (err) {
        console.error('Failed to apply extrude steps for panel', panel.id, err);
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
