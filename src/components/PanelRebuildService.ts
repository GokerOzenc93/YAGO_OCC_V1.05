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

    const freshFaces = recalculateVirtualFacesForShape(parent, store.virtualFaces, store.shapes);
    useAppStore.setState({ virtualFaces: freshFaces });

    const siblings = useAppStore.getState().shapes.filter(
      s => s.type === 'panel' &&
        s.parameters?.parentShapeId === parentShapeId &&
        s.parameters?.virtualFaceId
    );

    for (const panel of siblings) {
      const vf = freshFaces.find(f => f.id === panel.parameters.virtualFaceId);
      if (!vf || vf.vertices.length < 3) continue;
      try {
        const thickness = panel.parameters?.depth || 18;
        const rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, thickness);
        if (!rp) continue;
        const geometry = convertReplicadToThreeGeometry(rp);
        const r = geoAxesSize(geometry);
        const paramUpdates: Record<string, any> = { ...panel.parameters };
        if (r) {
          const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
          const { def, alt } = roleBasedAxes(pa, panel.parameters?.faceRole);
          const s = [r.size.x, r.size.y, r.size.z];
          paramUpdates.width = s[def];
          paramUpdates.height = s[alt];
        }
        useAppStore.getState().updateShape(panel.id, { geometry, replicadShape: rp, parameters: paramUpdates });
      } catch (err) {
        console.error('Failed to rebuild sibling panel', panel.id, err);
      }
    }
  } finally {
    rebuildInFlight.delete(parentShapeId);
  }
}
